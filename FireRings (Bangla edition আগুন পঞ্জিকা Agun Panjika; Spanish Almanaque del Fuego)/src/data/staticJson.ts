import { bboxOfPolygon, deriveRegion, pointInPolygon, tileIdsForBbox, type BaseRow } from "../compute/derive.ts";
import {
  DataError,
  hashString,
  isPartialMonth,
  monthsBetween,
  polygonKey,
  type CellsResult,
  type DataProvider,
  type GridTile,
  type Hotspot,
  type HotspotResult,
  type IndexMeta,
  type Polygon,
  type Provenance,
  type RegionData,
  type RegionRequest,
} from "./types.ts";

/**
 * StaticJsonAdapter — reads the files the real pipeline writes, from
 * VITE_DATA_BASE_URL (any static host, or a folder served next to the app).
 *
 * Caching, in three layers:
 *  1. in memory (promises per file, for the session);
 *  2. Cache Storage, written here after every successful fetch, with the
 *     save time — so data survives offline even without a service worker;
 *  3. the service worker (public/sw.js) also caches data network-first and
 *     marks cached answers with `x-fr-cache: 1`.
 * Every answer reports whether it came from the network ("live") or a saved
 * copy ("cache"), so the UI can label it honestly.
 */

const CACHE_NAME = "firerings-data-v1";
const MAX_TILES = 16;

interface Fetched {
  res: Response;
  cached: boolean;
  savedAt?: string;
}

async function fetchWithFallback(url: string): Promise<Fetched> {
  const store = typeof caches !== "undefined" ? await caches.open(CACHE_NAME).catch(() => null) : null;
  let missing = false;
  try {
    const res = await fetch(url, { cache: "no-cache" });
    // Static hosts with an SPA fallback answer missing files with index.html (200).
    const isHtml = (res.headers.get("content-type") ?? "").includes("text/html");
    if (res.ok && !isHtml) {
      const fromSw = res.headers.get("x-fr-cache") === "1";
      if (!fromSw && store) {
        const body = await res.clone().blob();
        const headers = new Headers(res.headers);
        headers.set("x-fr-saved-at", new Date().toISOString());
        store.put(url, new Response(body, { headers })).catch(() => {});
      }
      return { res, cached: fromSw, savedAt: res.headers.get("x-fr-saved-at") ?? undefined };
    }
    missing = res.status === 404 || (res.ok && isHtml);
  } catch {
    /* network down — fall through to the saved copy */
  }
  const hit = await store?.match(url);
  if (hit) return { res: hit, cached: true, savedAt: hit.headers.get("x-fr-saved-at") ?? undefined };
  throw new DataError(missing ? "missing" : "load", url);
}

export function parseHotspotCsv(text: string): Hotspot[] {
  const lines = text.trim().split(/\r?\n/);
  const header = (lines[0] ?? "").split(",").map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const c = {
    lat: col("latitude"),
    lon: col("longitude"),
    acq: col("acq_datetime_utc"),
    sensor: col("sensor"),
    sat: col("satellite"),
    conf: col("confidence"),
    frp: col("frp_mw"),
    type: col("type"),
  };
  const out: Hotspot[] = [];
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i]!.split(",");
    if (f.length < header.length) continue;
    out.push({
      latitude: Number(f[c.lat]),
      longitude: Number(f[c.lon]),
      acq_datetime_utc: f[c.acq] ?? "",
      sensor: f[c.sensor] ?? "",
      satellite: f[c.sat] ?? "",
      confidence: f[c.conf] ?? "",
      frp_mw: Number(f[c.frp]),
      type: Number(f[c.type]),
    });
  }
  return out;
}

export class StaticJsonAdapter implements DataProvider {
  readonly kind = "static" as const;
  private base: string;
  private index: Promise<IndexMeta> | null = null;
  private indexCached = false;
  private files = new Map<string, Promise<{ data: unknown; cached: boolean; savedAt?: string }>>();
  private regions = new Map<string, Promise<RegionData>>();

  constructor(base: string) {
    this.base = base.replace(/\/+$/, "");
  }

  private url(path: string): string {
    return `${this.base}/${path}`;
  }

  /** Memoized JSON fetch (layer 1 of the cache). */
  private json<T>(path: string): Promise<{ data: T; cached: boolean; savedAt?: string }> {
    let p = this.files.get(path);
    if (!p) {
      p = fetchWithFallback(this.url(path)).then(async ({ res, cached, savedAt }) => ({ data: (await res.json()) as unknown, cached, savedAt }));
      this.files.set(path, p);
      p.catch(() => this.files.delete(path));
    }
    return p as Promise<{ data: T; cached: boolean; savedAt?: string }>;
  }

  private provenance(cached: boolean, index: IndexMeta): Provenance {
    return cached ? "cache" : index.source === "cache" ? "live" : index.source;
  }

  getIndex(): Promise<IndexMeta> {
    if (!this.index) {
      this.index = this.json<IndexMeta>("index.json").then(({ data, cached }) => {
        this.indexCached = cached;
        return data;
      });
      this.index.catch(() => (this.index = null));
    }
    return this.index;
  }

  getRegion(req: RegionRequest): Promise<RegionData> {
    const key = "presetId" in req ? `p:${req.presetId}` : `c:${polygonKey(req.polygon)}`;
    let p = this.regions.get(key);
    if (!p) {
      p = "presetId" in req ? this.presetRegion(req.presetId) : this.customRegion(req.polygon);
      this.regions.set(key, p);
      p.catch(() => this.regions.delete(key));
    }
    return p;
  }

  private async presetRegion(id: string): Promise<RegionData> {
    const index = await this.getIndex();
    const { data, cached, savedAt } = await this.json<RegionData>(`region/${encodeURIComponent(id)}.json`);
    const out: RegionData = { ...data, source: this.provenance(cached || this.indexCached, index) };
    if (cached && savedAt) out.saved_at = savedAt;
    return out;
  }

  private async tiles(bbox: [number, number, number, number], index: IndexMeta) {
    const ids = tileIdsForBbox(bbox, index.grid.tile_deg);
    if (ids.length > MAX_TILES) throw new DataError("area_too_large");
    const got = await Promise.all(
      ids.map((id) =>
        this.json<GridTile>(`grid/${id}.json`).catch((e: unknown) => {
          // A missing tile means the pipeline recorded no fire cells there.
          if (e instanceof DataError && e.code === "missing") return null;
          throw e;
        }),
      ),
    );
    return got.filter((t): t is NonNullable<typeof t> => t != null);
  }

  /** Custom area = sum of grid cells whose centres fall inside the polygon. */
  private async customRegion(poly: Polygon): Promise<RegionData> {
    const index = await this.getIndex();
    const bbox = bboxOfPolygon(poly);
    const tiles = await this.tiles(bbox, index);
    if (tiles.length === 0) throw new DataError("no_tiles");

    const months = monthsBetween(index.first_month, index.last_month);
    const pos = new Map(months.map((ym, i) => [ym, i]));
    const n = months.length;
    const H = new Float64Array(n);
    const L = new Float64Array(n);
    const U = new Float64Array(n);
    const M = new Float64Array(n);
    const V = new Float64Array(n);
    const hasViirs = new Uint8Array(n);
    let cells = 0;
    let anyCached = this.indexCached;
    for (const t of tiles) {
      anyCached ||= t.cached;
      for (const cell of t.data.cells) {
        if (!pointInPolygon(cell.lon, cell.lat, poly)) continue;
        cells++;
        for (const [ym, v] of Object.entries(cell.m)) {
          const k = pos.get(ym);
          if (k == null) continue;
          H[k] = H[k]! + v[0];
          L[k] = L[k]! + v[1];
          U[k] = U[k]! + v[2];
          M[k] = M[k]! + (v[3] ?? 0);
          if (v[4] != null) {
            V[k] = V[k]! + v[4];
            hasViirs[k] = 1;
          }
        }
      }
    }
    if (cells === 0) throw new DataError("area_empty");

    const rows: BaseRow[] = months.map((ym, k) => ({
      ym,
      harmonized: H[k]!,
      low: L[k]!,
      high: U[k]!,
      modis_raw: Math.round(M[k]!),
      viirs_raw: hasViirs[k] || ym >= index.viirs_start ? Math.round(V[k]!) : null,
    }));
    // Fire-year convention of the nearest preset in the same hemisphere.
    const cx = (bbox[0] + bbox[2]) / 2;
    const cy = (bbox[1] + bbox[3]) / 2;
    const same = index.presets.filter((p) => p.bbox[1] < 0 === cy < 0);
    let start = cy < 0 ? 7 : 11;
    if (same.length) {
      const near = same.reduce((a, b) =>
        Math.hypot((a.bbox[0] + a.bbox[2]) / 2 - cx, (a.bbox[1] + a.bbox[3]) / 2 - cy) <=
        Math.hypot((b.bbox[0] + b.bbox[2]) / 2 - cx, (b.bbox[1] + b.bbox[3]) / 2 - cy)
          ? a
          : b,
      );
      const file = await this.json<RegionData>(`region/${encodeURIComponent(near.id)}.json`).catch(() => null);
      if (file) start = file.data.fire_year_start_month;
    }
    return {
      id: `custom-${hashString(polygonKey(poly)).toString(36)}`,
      fire_year_start_month: start,
      ...deriveRegion(rows, start, isPartialMonth(index.last_month)),
      approximate: true,
      cell_count: cells,
      source: this.provenance(anyCached, index),
    };
  }

  async getHotspots(req: RegionRequest, year: number): Promise<HotspotResult> {
    if (!("presetId" in req)) throw new DataError("custom_hotspots");
    const index = await this.getIndex();
    const { res, cached } = await fetchWithFallback(this.url(`hotspots/${encodeURIComponent(req.presetId)}/${year}.csv`));
    return { rows: parseHotspotCsv(await res.text()), source: this.provenance(cached, index) };
  }

  async getCells(bbox: [number, number, number, number]): Promise<CellsResult> {
    const index = await this.getIndex();
    const tiles = await this.tiles(bbox, index);
    const months = monthsBetween(index.first_month, index.last_month);
    const pos = new Map(months.map((ym, i) => [ym, i]));
    const cells: CellsResult["cells"] = [];
    let cached = this.indexCached;
    for (const t of tiles) {
      cached ||= t.cached;
      for (const c of t.data.cells) {
        if (c.lon < bbox[0] || c.lon > bbox[2] || c.lat < bbox[1] || c.lat > bbox[3]) continue;
        const v = new Float32Array(months.length);
        for (const [ym, m] of Object.entries(c.m)) {
          const k = pos.get(ym);
          if (k != null) v[k] = m[0];
        }
        cells.push({ lat: c.lat, lon: c.lon, v });
      }
    }
    return { months, cell_deg: index.grid.cell_km / 111, cells, source: this.provenance(cached, index) };
  }
}
