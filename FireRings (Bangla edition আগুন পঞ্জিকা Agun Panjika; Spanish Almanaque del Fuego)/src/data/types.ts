/**
 * FireRings data contract — the real pipeline produces exactly this shape and
 * the MockAdapter matches it. Field names and nesting are part of the contract;
 * see README.md → "Data contract".
 *
 * This module (and everything else in src/data that the demo-data script
 * imports) uses explicit `.ts` import extensions so Node can run it directly.
 */

export type Provenance = "live" | "cache" | "demo";

export type Status = "below" | "near" | "above" | "extreme";

export type Tri = { en: string; bn: string; es: string };

export interface PresetArea {
  id: string;
  name: Tri;
  country: string;
  /** [minLon, minLat, maxLon, maxLat] */
  bbox: [number, number, number, number];
}

export interface IndexMeta {
  version: string;
  generated_at: string;
  first_month: string; // "2000-11"
  last_month: string; // "YYYY-MM"
  presets: PresetArea[];
  /** Comes from the data — never hard-code the VIIRS start year in UI code. */
  viirs_start: string; // "2012-01" (or "2018-01" if only NOAA-20/21 is used)
  sensors: string[];
  grid: { cell_km: number; tile_deg: number };
  source: Provenance;

  /* ---- additive, real-data runs only (make real / make snapshot) ---- */
  /** "real" when the files come from real NASA data; absent for demo/older pipelines. */
  data_mode?: "real" | "demo";
  /** Month still in progress when the run was made. */
  partial_month?: string | null;
  /** FIRMS family used as the VIIRS calibration target, e.g. "VIIRS_NOAA20". */
  viirs_reference?: string;
  /** FIRMS source ids actually requested, e.g. ["MODIS_NRT", "MODIS_SP", ...]. */
  sources_used?: string[];
  /** First/last date actually used per FIRMS source. */
  source_dates?: Record<string, { first: string; last: string }>;
  /** What the FIRMS data_availability endpoint listed at fetch time. */
  availability?: Record<string, { first: string; last: string }>;
  /** Access dates (ISO) per service, for the data citation. */
  access?: { firms?: string | null; power?: string | null; eonet?: string | null };
  /** Per preset: "real" or "missing" (missing presets fall back to demo data). */
  regions_status?: Record<string, "real" | "missing">;
  notes?: string[];
  /** When `make snapshot` copied the run into the app. */
  snapshot_at?: string;
}

export interface MonthlyPoint {
  ym: string; // "2001-01"
  harmonized: number;
  low: number;
  high: number;
  modis_raw: number | null;
  viirs_raw: number | null;
  percentile: number;
  z: number;
}

export interface ClimatologyPoint {
  month: number; // 1..12
  median: number;
  p10: number;
  p90: number;
}

export interface CurrentStatus {
  ym: string;
  value: number;
  low: number;
  high: number;
  median: number;
  percentile: number;
  status: Status;
}

export interface Onset {
  season: string; // "2025-26"
  onset_date: string; // "YYYY-MM-DD"
  typical_onset_date: string;
  /** negative = earlier than usual */
  days_diff: number;
}

export interface Validation {
  overlap: string; // "2012-01/2026-10"
  train: string; // "2012-2019"
  test: string; // "2020-2025"
  corr_raw: number; // MODIS vs VIIRS raw, monthly, overlap
  corr_harmonized: number;
  mae: number;
  bias: number;
  coverage_90: number;
}

export interface ContextPoint {
  ym: string;
  t2m_c: number;
  precip_mm: number;
  rh_pct: number;
}

export interface SeamTestResult {
  break_ym: string | null;
  p: number;
  k: number;
  significant: boolean;
  near_viirs_start: boolean;
}

export interface SeamTest {
  method: string;
  alpha: number;
  n: number;
  viirs_start: string;
  raw: SeamTestResult;
  harmonized: SeamTestResult;
}

/** validation/eonet_{id}.json (real-data runs): independent check against NASA EONET events. */
export interface EonetValidation {
  status: "ok" | "insufficient events" | "unavailable";
  matched: number;
  total: number;
  hit_rate: number | null;
  base_rate?: number;
  min_events?: number;
  months_flagged: string[];
  events: { id: string; title: string; date: string; ym: string; flagged?: boolean; link?: string }[];
}

export interface OutlookPoint {
  ym: string;
  p_below: number;
  p_near: number;
  p_above: number;
  rpss: number;
}

export interface RegionData {
  id: string;
  fire_year_start_month: number;
  monthly: MonthlyPoint[];
  climatology: ClimatologyPoint[];
  current: CurrentStatus;
  /** null when the current season has not reached its onset threshold yet. */
  onset: Onset | null;
  /** Present for presets. Custom drawn areas have no per-area validation. */
  validation?: Validation;
  context?: ContextPoint[];
  outlook?: OutlookPoint[];
  /** Additive (real-data runs): changepoint test on the raw and harmonized series. */
  seam_test?: SeamTest;

  /* ---- set by the adapter at load time, not part of the files ---- */
  /** True when the area is a custom drawn polygon (summed grid cells). */
  approximate?: boolean;
  /** Number of grid cells summed for a custom area. */
  cell_count?: number;
  /** Provenance of this particular response. */
  source?: Provenance;
  /** When a cached copy was saved (ISO), if served from cache. */
  saved_at?: string;
}

/** One row of hotspots/{presetId}/{year}.csv */
export interface Hotspot {
  latitude: number;
  longitude: number;
  acq_datetime_utc: string;
  sensor: string;
  satellite: string;
  confidence: string;
  frp_mw: number;
  type: number;
}

/** grid/{tileId}.json → m: { "2001-01": [harmonized, low, high, modis_raw, viirs_raw] } */
export type CellMonth = [number, number, number, number | null, number | null];

export interface GridCell {
  id: string;
  lat: number;
  lon: number;
  m: Record<string, CellMonth>;
}

export interface GridTile {
  cells: GridCell[];
}

/** [lon, lat] pairs, open ring (first point not repeated). */
export type Polygon = [number, number][];

/** Either a named preset or a custom drawn polygon. */
export type RegionRequest = { presetId: string } | { polygon: Polygon };

export interface HotspotResult {
  rows: Hotspot[];
  source: Provenance;
}

/** Harmonized monthly values per grid cell, aligned to `months` — for the density layer. */
export interface CellsResult {
  months: string[];
  cell_deg: number;
  cells: { lat: number; lon: number; v: Float32Array }[];
  source: Provenance;
}

/**
 * The one data-access interface. Components never know which adapter is
 * behind it; switching adapters must not change any component.
 */
export interface DataProvider {
  readonly kind: "demo" | "static";
  getIndex(): Promise<IndexMeta>;
  getRegion(req: RegionRequest): Promise<RegionData>;
  getHotspots(req: RegionRequest, year: number): Promise<HotspotResult>;
  /** Grid cells inside a bbox (for the map's density layer). */
  getCells(bbox: [number, number, number, number]): Promise<CellsResult>;
}

/** Errors components know how to explain (i18n keys `err.<code>`). */
export class DataError extends Error {
  readonly code: "custom_hotspots" | "area_too_large" | "area_empty" | "no_tiles" | "missing" | "load";
  constructor(code: DataError["code"], detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

/* ---------- small shared helpers ---------- */

export function regionRequestKey(req: RegionRequest): string {
  if ("presetId" in req) return `preset:${req.presetId}`;
  return `custom:${polygonKey(req.polygon)}`;
}

export function polygonKey(poly: Polygon): string {
  return poly.map(([lon, lat]) => `${lon.toFixed(3)},${lat.toFixed(3)}`).join(";");
}

export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — deterministic seeded PRNG, so demo data is stable across reloads. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function parseYm(ym: string): { y: number; m: number } {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  return { y, m };
}

export function ymOf(y: number, m: number): string {
  return `${y}-${String(m).padStart(2, "0")}`;
}

export function addMonths(ym: string, n: number): string {
  const { y, m } = parseYm(ym);
  const total = y * 12 + (m - 1) + n;
  return ymOf(Math.floor(total / 12), (total % 12) + 1);
}

export function monthsBetween(first: string, last: string): string[] {
  const out: string[] = [];
  let cur = first;
  while (cur <= last) {
    out.push(cur);
    cur = addMonths(cur, 1);
  }
  return out;
}

export function isYm(s: string | null | undefined): s is string {
  return !!s && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

/** The record's last month is partial when it is the current UTC month. */
export function isPartialMonth(ym: string, now: Date = new Date()): boolean {
  return ym === ymOf(now.getUTCFullYear(), now.getUTCMonth() + 1);
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
