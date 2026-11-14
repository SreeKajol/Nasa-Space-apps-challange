import { DEFAULT_VIIRS_START, MockAdapter } from "./mock";
import { StaticJsonAdapter } from "./staticJson";
import { DataError, type CellsResult, type DataProvider, type HotspotResult, type IndexMeta, type RegionData, type RegionRequest } from "./types";

export type DataSrc = "demo" | "static";

/** Base URL of the pipeline's static files, if configured at build time. */
export const STATIC_BASE: string | undefined = import.meta.env.VITE_DATA_BASE_URL || undefined;

/** The app's root URL, also from the /almanac/ page, so relative data URLs resolve the same everywhere. */
export function appRoot(): string {
  const href = window.location.href.split("#")[0]!.split("?")[0]!;
  return href.replace(/almanac\/(index\.html)?$/, "").replace(/index\.html$/, "");
}

/** Real data whenever the pipeline URL is configured; otherwise the synthetic demo. */
export const DEFAULT_SRC: DataSrc = STATIC_BASE ? "static" : "demo";

export function availableSources(): DataSrc[] {
  return STATIC_BASE ? ["static", "demo"] : ["demo"];
}

export interface ProviderOptions {
  /** Demo only: test the app with VIIRS starting in 2018 (NOAA-20/21 only). */
  viirsStart?: string;
}

/**
 * Real-data snapshot with a per-area fallback: a preset the real run has no
 * data for (index.regions_status "missing", or its file is absent) is served by
 * the demo adapter and labelled "demo". The saved snapshot itself is already
 * the first fallback (StaticJsonAdapter answers from its saved copy offline).
 * Pipelines without data_mode "real" behave exactly as before.
 */
export class RealWithDemoFallback implements DataProvider {
  readonly kind = "static" as const;
  constructor(
    readonly real: StaticJsonAdapter,
    private readonly demo: () => DataProvider,
  ) {}

  getIndex(): Promise<IndexMeta> {
    return this.real.getIndex();
  }

  private async realStatus(presetId: string): Promise<"real" | "missing" | null> {
    const ix = await this.real.getIndex();
    if (ix.data_mode !== "real") return null;
    return ix.regions_status?.[presetId] ?? null;
  }

  async getRegion(req: RegionRequest): Promise<RegionData> {
    if (!("presetId" in req)) return this.real.getRegion(req);
    if ((await this.realStatus(req.presetId)) === "missing") return this.demo().getRegion(req);
    try {
      return await this.real.getRegion(req);
    } catch (e) {
      if (e instanceof DataError && e.code === "missing" && (await this.real.getIndex()).data_mode === "real") return this.demo().getRegion(req);
      throw e;
    }
  }

  async getHotspots(req: RegionRequest, year: number): Promise<HotspotResult> {
    if (!("presetId" in req)) return this.real.getHotspots(req, year);
    const status = await this.realStatus(req.presetId);
    if (status === "missing") return this.demo().getHotspots(req, year);
    try {
      return await this.real.getHotspots(req, year);
    } catch (e) {
      // A real area with no file for a year had no detections that year: empty, never demo rows.
      if (e instanceof DataError && e.code === "missing" && status === "real") return { rows: [], source: "cache" };
      throw e;
    }
  }

  getCells(bbox: [number, number, number, number]): Promise<CellsResult> {
    return this.real.getCells(bbox);
  }
}

/** Additive file of the static data (e.g. validation/eonet_{id}.json); null in demo mode or when absent. */
export async function getStaticExtra<T>(src: DataSrc, rel: string): Promise<T | null> {
  if (resolveSrc(src) !== "static") return null;
  const p = getProvider(src);
  return p instanceof RealWithDemoFallback ? p.real.getExtra<T>(rel) : null;
}

const providers = new Map<string, DataProvider>();

export function resolveSrc(src: DataSrc): DataSrc {
  return src === "static" && STATIC_BASE ? "static" : "demo";
}

/**
 * One DataProvider interface, two adapters. Components only ever call this;
 * switching adapters changes no component.
 */
export function getProvider(src: DataSrc, opts: ProviderOptions = {}): DataProvider {
  const resolved = resolveSrc(src);
  const vs = opts.viirsStart ?? DEFAULT_VIIRS_START;
  const key = resolved === "static" ? "static" : `demo:${vs}`;
  let p = providers.get(key);
  if (!p) {
    p =
      resolved === "static"
        ? new RealWithDemoFallback(new StaticJsonAdapter(new URL(STATIC_BASE!, appRoot()).href), () => getProvider("demo"))
        : new MockAdapter({ viirsStart: vs });
    providers.set(key, p);
  }
  return p;
}
