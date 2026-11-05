import { bboxOfPolygon, deriveRegion, pointInPolygon, round1, round2, type BaseRow } from "../compute/derive.ts";
import {
  addMonths,
  DataError,
  daysInMonth,
  hashString,
  monthsBetween,
  mulberry32,
  parseYm,
  polygonKey,
  ymOf,
  type CellsResult,
  type ContextPoint,
  type DataProvider,
  type Hotspot,
  type HotspotResult,
  type IndexMeta,
  type OutlookPoint,
  type Polygon,
  type PresetArea,
  type RegionData,
  type RegionRequest,
  type Validation,
} from "./types.ts";

/*
 * MockAdapter — SYNTHETIC demo data that matches the data contract exactly.
 * Deterministic (seeded PRNG), fully offline, computed lazily on request.
 *
 * One synthetic 5.5 km cell field covers the planet. Presets, custom polygons,
 * the map's density layer and the hotspot lists are all sums or samples of
 * that same field, so every view agrees with every other.
 *
 * Raw counts reproduce the real artefact the pipeline removes: VIIRS raw is
 * ≈3–5× MODIS raw from `viirs_start`, stepping up again as NOAA-20 (2018) and
 * NOAA-21 (2023) add overpasses; the harmonized series stays continuous.
 */

export const FIRST_MONTH = "2000-11";
export const DEFAULT_VIIRS_START = "2012-01";
const CELL_KM = 5.5;
const CELL_DEG = CELL_KM / 111;
const TILE_DEG = 2;
const MAX_CELLS = 25_000;

type Kind = "bd_forest" | "bd_jhum" | "ar_delta" | "ar_corrientes";

/** Relative monthly activity; index 0 = January. */
const SEASON: Record<Kind, number[]> = {
  bd_forest: [0.45, 0.9, 1.9, 1.95, 0.7, 0.12, 0.05, 0.04, 0.05, 0.12, 0.25, 0.35],
  bd_jhum: [0.35, 0.95, 2.6, 2.4, 0.65, 0.08, 0.03, 0.03, 0.04, 0.08, 0.15, 0.25],
  ar_delta: [0.35, 0.3, 0.3, 0.35, 0.5, 0.9, 1.9, 2.6, 2.3, 1.2, 0.6, 0.45],
  ar_corrientes: [2.2, 1.8, 0.8, 0.35, 0.25, 0.3, 0.45, 0.7, 0.8, 0.7, 0.9, 1.7],
};

/** Calendar-year multipliers. */
const SPIKES: Record<Kind, Record<number, number>> = {
  bd_forest: { 2009: 1.35, 2016: 1.55, 2021: 1.8 },
  bd_jhum: { 2007: 1.4, 2016: 1.5, 2021: 1.9, 2024: 1.35 },
  ar_delta: { 2008: 2.0, 2020: 3.1, 2022: 2.4 },
  ar_corrientes: { 2020: 1.4 },
};

/** Month-level boosts: early 2025-26 season in Bangladesh, extreme early 2022 in Corrientes. */
const BOOST: Record<Kind, Record<string, number>> = {
  bd_forest: { "2025-11": 2.4, "2025-12": 2.0, "2026-01": 1.5 },
  bd_jhum: { "2025-11": 2.2, "2025-12": 2.1, "2026-01": 1.6 },
  ar_delta: { "2026-08": 1.4 },
  ar_corrientes: { "2021-12": 2.3, "2022-01": 3.6, "2022-02": 3.2, "2022-03": 1.8 },
};

/** Variability of the regional signal (jhum burning is the most erratic). */
const SIGMA: Record<Kind, number> = { bd_forest: 0.24, bd_jhum: 0.42, ar_delta: 0.3, ar_corrientes: 0.28 };

export const PRESETS: PresetArea[] = [
  { id: "sundarbans", name: { en: "Sundarbans", bn: "সুন্দরবন", es: "Sundarbans" }, country: "BD", bbox: [88.95, 21.6, 89.95, 22.5] },
  { id: "chittagong-hill-tracts", name: { en: "Chittagong Hill Tracts", bn: "পার্বত্য চট্টগ্রাম", es: "Colinas de Chittagong" }, country: "BD", bbox: [91.6, 21.6, 92.7, 23.7] },
  { id: "parana-delta", name: { en: "Paraná Delta", bn: "পারানা ব-দ্বীপ", es: "Delta del Paraná" }, country: "AR", bbox: [-60.9, -34.3, -58.4, -32.0] },
  { id: "corrientes", name: { en: "Corrientes", bn: "কোরিয়েন্তেস", es: "Corrientes" }, country: "AR", bbox: [-59.0, -30.2, -56.0, -27.3] },
];

const SPECS: Record<string, { kind: Kind; base: number; start: number }> = {
  sundarbans: { kind: "bd_forest", base: 46, start: 11 },
  "chittagong-hill-tracts": { kind: "bd_jhum", base: 230, start: 11 },
  "parana-delta": { kind: "ar_delta", base: 240, start: 1 },
  corrientes: { kind: "ar_corrientes", base: 280, start: 7 },
};

function gaussian(rng: () => number): number {
  const u = Math.max(rng(), 1e-9);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface MockOptions {
  viirsStart?: string;
  /** Injected clock (tests). The record runs to the current month. */
  now?: Date;
}

interface Blob {
  lon: number;
  lat: number;
  s: number;
  a: number;
}

export class MockAdapter implements DataProvider {
  readonly kind = "demo" as const;
  readonly viirsStart: string;
  readonly lastMonth: string;
  /** Fraction of the last (current) month elapsed; 1 when complete. */
  readonly partialFraction: number;
  private readonly now: Date;
  private readonly months: string[];
  private readonly blobs = new Map<string, { blobs: Blob[]; scale: number }>();
  private readonly regional = new Map<Kind, Float64Array>();
  private readonly regions = new Map<string, RegionData>();
  private readonly cellCache = new Map<string, CellsResult["cells"]>();

  constructor(opts: MockOptions = {}) {
    this.viirsStart = opts.viirsStart ?? DEFAULT_VIIRS_START;
    this.now = opts.now ?? new Date();
    const y = this.now.getUTCFullYear();
    const m = this.now.getUTCMonth() + 1;
    this.lastMonth = ymOf(y, m);
    this.partialFraction = Math.max(0.03, Math.min(1, this.now.getUTCDate() / daysInMonth(y, m)));
    this.months = monthsBetween(FIRST_MONTH, this.lastMonth);
    for (const p of PRESETS) this.initBlobs(p);
  }

  /* ---------- the synthetic cell field ---------- */

  private initBlobs(p: PresetArea) {
    const rng = mulberry32(hashString(`${p.id}:blobs`));
    const [x0, y0, x1, y1] = p.bbox;
    const span = Math.min(x1 - x0, y1 - y0);
    const blobs: Blob[] = Array.from({ length: 9 }, () => ({
      lon: x0 + (0.1 + 0.8 * rng()) * (x1 - x0),
      lat: y0 + (0.1 + 0.8 * rng()) * (y1 - y0),
      s: span * (0.05 + 0.16 * rng()),
      a: 0.25 + rng() ** 2,
    }));
    let sum = 0;
    for (const [lon, lat] of this.cellCentres(p.bbox)) sum += blobValue(blobs, lon, lat);
    this.blobs.set(p.id, { blobs, scale: sum > 0 ? SPECS[p.id]!.base / sum : 0 });
  }

  /** Cell weight W(c): expected monthly hotspots at seasonal factor 1. */
  private weight(lon: number, lat: number): number {
    let w = 0;
    for (const [id, b] of this.blobs) {
      const bb = PRESETS.find((p) => p.id === id)!.bbox;
      if (lon < bb[0] - 1 || lon > bb[2] + 1 || lat < bb[1] - 1 || lat > bb[3] + 1) continue;
      w += b.scale * blobValue(b.blobs, lon, lat);
    }
    const h = (hashString(`${lon.toFixed(3)},${lat.toFixed(3)}:bg`) % 10000) / 10000;
    return w + 0.012 * h ** 3;
  }

  private kindAt(lon: number, lat: number): { kind: Kind; start: number } {
    let best: { d: number; id: string } | null = null;
    for (const p of PRESETS) {
      const dx = Math.max(p.bbox[0] - lon, 0, lon - p.bbox[2]);
      const dy = Math.max(p.bbox[1] - lat, 0, lat - p.bbox[3]);
      const d = Math.hypot(dx, dy);
      if (!best || d < best.d) best = { d, id: p.id };
    }
    if (best && best.d < 10) return { kind: SPECS[best.id]!.kind, start: SPECS[best.id]!.start };
    return lat >= 0 ? { kind: "bd_forest", start: 11 } : { kind: "ar_delta", start: 1 };
  }

  /** Regional monthly factor F(kind, k) = season × spikes × trend × shared noise. */
  private factor(kind: Kind): Float64Array {
    let f = this.regional.get(kind);
    if (f) return f;
    const rng = mulberry32(hashString(`${kind}:regional`));
    f = new Float64Array(this.months.length);
    this.months.forEach((ym, k) => {
      const { y, m } = parseYm(ym);
      const base = SEASON[kind][m - 1]! * (SPIKES[kind][y] ?? 1) * (BOOST[kind][ym] ?? 1) * (1 + 0.004 * (y - 2000));
      f![k] = base * Math.exp(SIGMA[kind] * gaussian(rng) - SIGMA[kind] ** 2 / 2);
    });
    // The current month is only partly observed.
    f[f.length - 1] =f[f.length - 1]! * this.partialFraction;
    this.regional.set(kind, f);
    return f;
  }

  private *cellCentres(bbox: [number, number, number, number]): Generator<[number, number]> {
    const i0 = Math.floor(bbox[1] / CELL_DEG);
    const i1 = Math.floor(bbox[3] / CELL_DEG);
    const j0 = Math.floor(bbox[0] / CELL_DEG);
    const j1 = Math.floor(bbox[2] / CELL_DEG);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) yield [(j + 0.5) * CELL_DEG, (i + 0.5) * CELL_DEG];
    }
  }

  private cells(bbox: [number, number, number, number], poly: Polygon | null): CellsResult["cells"] {
    const key = poly ? `p:${polygonKey(poly)}` : `b:${bbox.join(",")}`;
    const hit = this.cellCache.get(key);
    if (hit) return hit;
    const nI = Math.floor(bbox[3] / CELL_DEG) - Math.floor(bbox[1] / CELL_DEG) + 1;
    const nJ = Math.floor(bbox[2] / CELL_DEG) - Math.floor(bbox[0] / CELL_DEG) + 1;
    if (nI * nJ > MAX_CELLS * 4) throw new DataError("area_too_large");
    const n = this.months.length;
    const out: CellsResult["cells"] = [];
    for (const [lon, lat] of this.cellCentres(bbox)) {
      if (poly && !pointInPolygon(lon, lat, poly)) continue;
      if (out.length >= MAX_CELLS) throw new DataError("area_too_large");
      const w = this.weight(lon, lat);
      const f = this.factor(this.kindAt(lon, lat).kind);
      const rng = mulberry32(hashString(`${lon.toFixed(4)},${lat.toFixed(4)}`));
      const v = new Float32Array(n);
      for (let k = 0; k < n; k++) v[k] = w * f[k]! * Math.exp(0.35 * gaussian(rng) - 0.06125);
      out.push({ lat: round4(lat), lon: round4(lon), v });
    }
    this.cellCache.set(key, out);
    return out;
  }

  /* ---------- sensors ---------- */

  /** Raw-count multipliers relative to "true" activity — the sensor artefact. */
  private rawFactors(ym: string): { modis: number; viirs: number | null } {
    if (ym < this.viirsStart) return { modis: 0.9, viirs: null };
    const snpp = this.viirsStart <= "2012-01";
    let viirs = snpp ? 3.0 : 0; // Suomi-NPP alone ≈ 3.3× MODIS
    if (ym >= "2018-01") viirs = snpp ? viirs * 1.25 : 3.05; // + NOAA-20
    if (ym >= "2023-01") viirs *= 1.17; // + NOAA-21
    if (viirs === 0) return { modis: 0.9, viirs: null };
    return { modis: 0.9, viirs };
  }

  private rowsFromCells(cells: CellsResult["cells"], seedKey: string, widen: number): BaseRow[] {
    const n = this.months.length;
    const H = new Float64Array(n);
    for (const c of cells) for (let k = 0; k < n; k++) H[k] = H[k]! + c.v[k]!;
    const rng = mulberry32(hashString(`${seedKey}:raw`));
    return this.months.map((ym, k) => {
      const h = H[k]!;
      const unc = (ym < this.viirsStart ? 0.15 : 0.07) * widen;
      const f = this.rawFactors(ym);
      return {
        ym,
        harmonized: h,
        low: h * (1 - unc),
        high: h * (1 + unc),
        modis_raw: Math.max(0, Math.round(h * f.modis * Math.exp(0.08 * gaussian(rng)))),
        viirs_raw: f.viirs == null ? null : Math.max(0, Math.round(h * f.viirs * Math.exp(0.1 * gaussian(rng)))),
      };
    });
  }

  /* ---------- contract objects ---------- */

  index(): IndexMeta {
    return {
      version: "1",
      generated_at: this.now.toISOString().slice(0, 19) + "Z",
      first_month: FIRST_MONTH,
      last_month: this.lastMonth,
      presets: PRESETS,
      viirs_start: this.viirsStart,
      sensors:
        this.viirsStart <= "2012-01"
          ? ["MODIS_Terra", "MODIS_Aqua", "VIIRS_SNPP", "VIIRS_NOAA20", "VIIRS_NOAA21"]
          : ["MODIS_Terra", "MODIS_Aqua", "VIIRS_NOAA20", "VIIRS_NOAA21"],
      grid: { cell_km: CELL_KM, tile_deg: TILE_DEG },
      source: "demo",
    };
  }

  private validation(seedKey: string, meanMonthly: number): Validation {
    const rng = mulberry32(hashString(`${seedKey}:val`));
    const vy = parseYm(this.viirsStart).y;
    const lastComplete = addMonths(this.lastMonth, -1);
    const ly = parseYm(lastComplete).y;
    const trainEnd = Math.min(ly - 2, vy + 7);
    return {
      overlap: `${this.viirsStart}/${lastComplete}`,
      train: `${vy}-${trainEnd}`,
      test: `${trainEnd + 1}-${ly - 1}`,
      corr_raw: round2(0.6 + 0.04 * gaussian(rng)),
      corr_harmonized: round2(Math.min(0.97, 0.91 + 0.015 * gaussian(rng))),
      mae: round1(meanMonthly * (0.1 + 0.02 * Math.abs(gaussian(rng)))),
      bias: round1(meanMonthly * 0.02 * gaussian(rng)),
      coverage_90: round2(Math.min(0.96, 0.89 + 0.015 * gaussian(rng))),
    };
  }

  private context(seedKey: string, south: boolean): ContextPoint[] {
    const rng = mulberry32(hashString(`${seedKey}:ctx`));
    return this.months.map((ym) => {
      const { m } = parseYm(ym);
      const phase = south ? m - 1 : m - 5;
      const t2m = (south ? 19 : 26) + (south ? 6.5 : 3.8) * Math.cos((2 * Math.PI * phase) / 12) + 0.9 * gaussian(rng);
      const wetPeak = south ? 2 : 7.5;
      const amp = south ? 120 : 340;
      const dist = Math.min(Math.abs(m - wetPeak), 12 - Math.abs(m - wetPeak));
      const precip = Math.max(0, (south ? 45 : 6) + amp * Math.exp(-(dist ** 2) / (2 * 1.7 ** 2)) * Math.exp(0.3 * gaussian(rng)));
      const rh = Math.min(97, Math.max(35, (south ? 64 : 58) + 24 * (precip / (amp + 40)) + 3 * gaussian(rng)));
      return { ym, t2m_c: round1(t2m), precip_mm: round1(precip), rh_pct: Math.round(rh) };
    });
  }

  private outlook(seedKey: string, skilful: boolean): OutlookPoint[] {
    const rng = mulberry32(hashString(`${seedKey}:out`));
    return [1, 2, 3].map((i) => {
      const a = 0.18 + 0.08 * Math.abs(gaussian(rng));
      const c = Math.max(0.12, 0.38 + 0.1 * gaussian(rng));
      const b = Math.max(0.12, 1 - a - c);
      const s = a + b + c;
      const p_below = round2(a / s);
      const p_above = round2(c / s);
      return {
        ym: addMonths(this.lastMonth, i),
        p_below,
        p_near: round2(1 - p_below - p_above),
        p_above,
        rpss: skilful ? round2(0.16 - 0.05 * i + 0.02 * gaussian(rng)) : round2(-0.03 - 0.02 * Math.abs(gaussian(rng))),
      };
    });
  }

  /** A region file exactly as the pipeline would write it (no adapter-only fields). */
  regionFile(presetId: string): RegionData {
    const spec = SPECS[presetId];
    const preset = PRESETS.find((p) => p.id === presetId);
    if (!spec || !preset) throw new DataError("load", `region/${presetId}.json`);
    const rows = this.rowsFromCells(this.cells(preset.bbox, null), presetId, 1);
    const d = deriveRegion(rows, spec.start, this.partialFraction < 1);
    const mean = rows.reduce((a, r) => a + r.harmonized, 0) / rows.length;
    return {
      id: presetId,
      fire_year_start_month: spec.start,
      ...d,
      validation: this.validation(presetId, mean),
      context: this.context(presetId, preset.bbox[1] < 0),
      outlook: this.outlook(presetId, presetId !== "corrientes"),
    };
  }

  private hotspots(seedKey: string, cells: CellsResult["cells"], year: number): Hotspot[] {
    const ks: number[] = [];
    this.months.forEach((ym, k) => {
      if (parseYm(ym).y === year) ks.push(k);
    });
    if (ks.length === 0) return [];
    let total = 0;
    const cum = new Float64Array(cells.length * ks.length);
    let idx = 0;
    for (const c of cells) {
      for (const k of ks) {
        total += c.v[k]!;
        cum[idx++] = total;
      }
    }
    if (total <= 0) return [];
    const count = Math.min(4000, Math.round(total * 0.55));
    const rng = mulberry32(hashString(`${seedKey}:hot:${year}:${this.viirsStart}`));
    const sats = [
      { sensor: "MODIS", satellite: "Terra", from: "2000-02", to: "9999-12" },
      { sensor: "MODIS", satellite: "Aqua", from: "2002-07", to: "9999-12" },
      { sensor: "VIIRS", satellite: "Suomi-NPP", from: this.viirsStart <= "2012-01" ? this.viirsStart : "9999-12", to: "2026-10" },
      { sensor: "VIIRS", satellite: "NOAA-20", from: this.viirsStart > "2018-01" ? this.viirsStart : "2018-01", to: "9999-12" },
      { sensor: "VIIRS", satellite: "NOAA-21", from: "2023-01", to: "9999-12" },
    ];
    const rows: Hotspot[] = [];
    for (let i = 0; i < count; i++) {
      const r = rng() * total;
      let lo = 0;
      let hi = cum.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid]! < r) lo = mid + 1;
        else hi = mid;
      }
      const cell = cells[Math.floor(lo / ks.length)]!;
      const ym = this.months[ks[lo % ks.length]!]!;
      const lat = cell.lat + (rng() - 0.5) * CELL_DEG;
      const lon = cell.lon + (rng() - 0.5) * CELL_DEG;
      const avail = sats.filter((s) => ym >= s.from && ym <= s.to);
      const viirs = avail.filter((s) => s.sensor === "VIIRS");
      const modis = avail.filter((s) => s.sensor === "MODIS");
      const pool = viirs.length && rng() < 0.78 ? viirs : modis;
      const sat = pool[Math.floor(rng() * pool.length)] ?? avail[0]!;
      const { y, m } = parseYm(ym);
      const maxDay = ym === this.lastMonth ? Math.max(1, this.now.getUTCDate()) : daysInMonth(y, m);
      const day = 1 + Math.floor(rng() * maxDay);
      const night = rng() < 0.3;
      const localH = (sat.satellite === "Terra" ? 10.5 : 13.5) + (night ? 12 : 0) + 0.7 * gaussian(rng);
      const utcH = (((localH - lon / 15) % 24) + 24) % 24;
      const hh = Math.floor(utcH);
      const mm = Math.floor((utcH - hh) * 60);
      const cr = rng();
      rows.push({
        latitude: round4(lat),
        longitude: round4(lon),
        acq_datetime_utc: `${ym}-${pad(day)}T${pad(hh)}:${pad(mm)}:00Z`,
        sensor: sat.sensor,
        satellite: sat.satellite,
        confidence: sat.sensor === "MODIS" ? String(Math.round(30 + 70 * Math.sqrt(cr))) : cr < 0.12 ? "h" : cr < 0.85 ? "n" : "l",
        frp_mw: round1(Math.min(1500, Math.exp((sat.sensor === "VIIRS" ? 1.6 : 2.6) + gaussian(rng)))),
        type: rng() < 0.02 ? 2 : 0,
      });
    }
    rows.sort((a, b) => a.acq_datetime_utc.localeCompare(b.acq_datetime_utc));
    return rows;
  }

  /**
   * A grid tile file exactly as the pipeline would write it
   * (grid/{lat0}_{lon0}.json), limited to `within` to keep fixtures small.
   * Months with negligible activity are omitted (= zero).
   */
  gridTile(tileId: string, within: [number, number, number, number]): { cells: { id: string; lat: number; lon: number; m: Record<string, [number, number, number, number | null, number | null]> }[] } {
    const [la0, lo0] = tileId.split("_").map(Number) as [number, number];
    const bbox: [number, number, number, number] = [
      Math.max(lo0, within[0]),
      Math.max(la0, within[1]),
      Math.min(lo0 + TILE_DEG, within[2]),
      Math.min(la0 + TILE_DEG, within[3]),
    ];
    if (bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) return { cells: [] };
    const r1 = (x: number) => Math.round(x * 10) / 10;
    const cells = this.cells(bbox, null).map((c) => {
      const m: Record<string, [number, number, number, number | null, number | null]> = {};
      this.months.forEach((ym, k) => {
        const v = c.v[k]!;
        if (v < 0.05) return;
        const unc = ym < this.viirsStart ? 0.15 : 0.07;
        const f = this.rawFactors(ym);
        m[ym] = [r1(v), r1(v * (1 - unc)), r1(v * (1 + unc)), r1(v * f.modis), f.viirs == null ? null : r1(v * f.viirs)];
      });
      return { id: `c_${c.lat}_${c.lon}`, lat: c.lat, lon: c.lon, m };
    });
    return { cells: cells.filter((c) => Object.keys(c.m).length > 0) };
  }

  /* ---------- DataProvider ---------- */

  async getIndex(): Promise<IndexMeta> {
    return this.index();
  }

  async getRegion(req: RegionRequest): Promise<RegionData> {
    const key = "presetId" in req ? `p:${req.presetId}` : `c:${polygonKey(req.polygon)}`;
    const hit = this.regions.get(key);
    if (hit) return hit;
    let data: RegionData;
    if ("presetId" in req) {
      data = { ...this.regionFile(req.presetId), source: "demo" };
    } else {
      const bbox = bboxOfPolygon(req.polygon);
      const cells = this.cells(bbox, req.polygon);
      if (cells.length === 0) throw new DataError("area_empty");
      const cx = (bbox[0] + bbox[2]) / 2;
      const cy = (bbox[1] + bbox[3]) / 2;
      const { start } = this.kindAt(cx, cy);
      const id = `custom-${hashString(polygonKey(req.polygon)).toString(36)}`;
      const rows = this.rowsFromCells(cells, id, 1.25);
      data = {
        id,
        fire_year_start_month: start,
        ...deriveRegion(rows, start, this.partialFraction < 1),
        context: this.context(id, cy < 0),
        approximate: true,
        cell_count: cells.length,
        source: "demo",
      };
    }
    this.regions.set(key, data);
    return data;
  }

  async getHotspots(req: RegionRequest, year: number): Promise<HotspotResult> {
    if ("presetId" in req) {
      const p = PRESETS.find((x) => x.id === req.presetId);
      if (!p) throw new DataError("load", `hotspots/${req.presetId}/${year}.csv`);
      return { rows: this.hotspots(p.id, this.cells(p.bbox, null), year), source: "demo" };
    }
    const cells = this.cells(bboxOfPolygon(req.polygon), req.polygon);
    return { rows: this.hotspots(polygonKey(req.polygon), cells, year), source: "demo" };
  }

  async getCells(bbox: [number, number, number, number]): Promise<CellsResult> {
    return { months: this.months, cell_deg: CELL_DEG, cells: this.cells(bbox, null), source: "demo" };
  }
}

function blobValue(blobs: Blob[], lon: number, lat: number): number {
  let v = 0;
  for (const b of blobs) {
    const d2 = (lon - b.lon) ** 2 + (lat - b.lat) ** 2;
    v += b.a * Math.exp(-d2 / (2 * b.s * b.s));
  }
  return v;
}

const pad = (n: number) => String(n).padStart(2, "0");
const round4 = (n: number) => Math.round(n * 10000) / 10000;
