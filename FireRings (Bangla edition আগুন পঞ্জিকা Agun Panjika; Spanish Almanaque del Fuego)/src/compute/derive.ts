import {
  addMonths,
  daysInMonth,
  parseYm,
  ymOf,
  type ClimatologyPoint,
  type CurrentStatus,
  type MonthlyPoint,
  type Onset,
  type Status,
} from "../data/types.ts";

/*
 * Shared derivations from a raw monthly series to the contract fields
 * (percentile, z, climatology, current, onset). Used by the MockAdapter and
 * by the StaticJsonAdapter for custom drawn areas (summed grid cells), so both
 * paths compute statistics in exactly one way. Pure functions; no DOM, no d3.
 */

export interface BaseRow {
  ym: string;
  harmonized: number;
  low: number;
  high: number;
  modis_raw: number | null;
  viirs_raw: number | null;
}

export const round1 = (n: number): number => Math.round(n * 10) / 10;
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Linear-interpolated quantile of a sorted array (same as d3.quantileSorted). */
export function quantileSorted(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const i = (n - 1) * p;
  const i0 = Math.floor(i);
  const v0 = sorted[i0] ?? 0;
  const v1 = sorted[Math.min(n - 1, i0 + 1)] ?? v0;
  return v0 + (v1 - v0) * (i - i0);
}

/** Empirical percentile (mid-rank) of v within a sample. 0–100. */
export function percentileOf(v: number, sample: number[]): number {
  if (sample.length === 0) return 50;
  let less = 0;
  let equal = 0;
  for (const s of sample) {
    if (s < v) less++;
    else if (s === v) equal++;
  }
  return ((less + 0.5 * equal) / sample.length) * 100;
}

/** Status thresholds, applied to the month's percentile against its own history. */
export function statusOf(percentile: number): Status {
  if (percentile >= 90) return "extreme";
  if (percentile >= 75) return "above";
  if (percentile > 25) return "near";
  return "below";
}

export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return NaN;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : NaN;
}

/** Values grouped by calendar month (index 0 = January). */
export function byCalendarMonth<T>(rows: T[], ymOfRow: (r: T) => string, value: (r: T) => number | null): number[][] {
  const out: number[][] = Array.from({ length: 12 }, () => []);
  for (const r of rows) {
    const v = value(r);
    if (v == null || !Number.isFinite(v)) continue;
    out[parseYm(ymOfRow(r)).m - 1]!.push(v);
  }
  return out;
}

export function climatologyOf(groups: number[][]): ClimatologyPoint[] {
  return groups.map((vals, i) => {
    const s = [...vals].sort((a, b) => a - b);
    return {
      month: i + 1,
      median: round1(quantileSorted(s, 0.5)),
      p10: round1(quantileSorted(s, 0.1)),
      p90: round1(quantileSorted(s, 0.9)),
    };
  });
}

/** Adds percentile + z (vs the same calendar month across the whole record). */
export function withPercentiles(rows: BaseRow[], partialLast = false): MonthlyPoint[] {
  const history = partialLast ? rows.slice(0, -1) : rows;
  const groups = byCalendarMonth(history, (r) => r.ym, (r) => r.harmonized);
  const stats = groups.map((g) => {
    const mean = g.reduce((a, b) => a + b, 0) / (g.length || 1);
    const sd = Math.sqrt(g.reduce((a, b) => a + (b - mean) ** 2, 0) / (g.length || 1));
    return { mean, sd };
  });
  return rows.map((r) => {
    const i = parseYm(r.ym).m - 1;
    const g = groups[i]!;
    const { mean, sd } = stats[i]!;
    return {
      ym: r.ym,
      harmonized: round1(r.harmonized),
      low: round1(r.low),
      high: round1(r.high),
      modis_raw: r.modis_raw,
      viirs_raw: r.viirs_raw,
      percentile: Math.round(percentileOf(r.harmonized, g)),
      z: sd > 0 ? round2((r.harmonized - mean) / sd) : 0,
    };
  });
}

/** Latest complete month vs. its history. A partial current month is skipped. */
export function currentOf(monthly: MonthlyPoint[], climatology: ClimatologyPoint[], partialLast = false): CurrentStatus {
  const last = monthly[monthly.length - (partialLast && monthly.length > 1 ? 2 : 1)]!;
  return {
    ym: last.ym,
    value: last.harmonized,
    low: last.low,
    high: last.high,
    median: climatology[parseYm(last.ym).m - 1]?.median ?? 0,
    percentile: last.percentile,
    status: statusOf(last.percentile),
  };
}

/** Fire-year label: "2025-26" for a Nov→Oct year, "2026" when the year starts in January. */
export function seasonLabel(startYear: number, startMonth: number): string {
  if (startMonth === 1) return String(startYear);
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

export function seasonStartYear(ym: string, startMonth: number): number {
  const { y, m } = parseYm(ym);
  return m >= startMonth ? y : y - 1;
}

export function seasonOf(ym: string, startMonth: number): string {
  return seasonLabel(seasonStartYear(ym, startMonth), startMonth);
}

/** Share of the season's activity used to define onset. Documented in Method. */
export const ONSET_FRACTION = 0.1;

/**
 * Onset = the day cumulative harmonized activity since the season start
 * crosses ONSET_FRACTION of the median complete-season total (linear within
 * the month). Typical onset = the same crossing for the climatological median
 * curve. Returns null if the current season has not crossed it yet.
 */
export function onsetOf(monthly: MonthlyPoint[], climatology: ClimatologyPoint[], startMonth: number): Onset | null {
  const last = monthly[monthly.length - 1];
  if (!last) return null;
  const sy = seasonStartYear(last.ym, startMonth);
  const byYm = new Map(monthly.map((p) => [p.ym, p]));

  // Median total of complete past seasons.
  const firstSy = seasonStartYear(monthly[0]!.ym, startMonth);
  const totals: number[] = [];
  for (let y = firstSy; y < sy; y++) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < 12; i++) {
      const p = byYm.get(addMonths(ymOf(y, startMonth), i));
      if (p) {
        sum += p.harmonized;
        n++;
      }
    }
    if (n === 12) totals.push(sum);
  }
  totals.sort((a, b) => a - b);
  const threshold = ONSET_FRACTION * quantileSorted(totals, 0.5);
  if (!(threshold > 0)) return null;

  const crossing = (values: number[]): { i: number; f: number } | null => {
    let cum = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i]!;
      if (cum + v >= threshold && v > 0) return { i, f: (threshold - cum) / v };
      cum += v;
    }
    return null;
  };
  const toDate = (i: number, f: number): string => {
    const ym = addMonths(ymOf(sy, startMonth), i);
    const { y, m } = parseYm(ym);
    const dim = daysInMonth(y, m);
    const d = Math.min(dim, Math.max(1, 1 + Math.round(f * (dim - 1))));
    return `${ym}-${String(d).padStart(2, "0")}`;
  };

  const seasonVals: number[] = [];
  for (let i = 0; i < 12; i++) {
    const p = byYm.get(addMonths(ymOf(sy, startMonth), i));
    if (!p) break;
    seasonVals.push(p.harmonized);
  }
  const climVals = Array.from({ length: 12 }, (_, i) => climatology[((startMonth - 1 + i) % 12)]?.median ?? 0);
  // Scale the climatological curve to the median season so both use one threshold.
  const climSum = climVals.reduce((a, b) => a + b, 0);
  const scale = climSum > 0 ? quantileSorted(totals, 0.5) / climSum : 1;
  const cur = crossing(seasonVals);
  const typ = crossing(climVals.map((v) => v * scale));
  if (!cur || !typ) return null;
  const onset_date = toDate(cur.i, cur.f);
  const typical_onset_date = toDate(typ.i, typ.f);
  const days_diff = Math.round((Date.parse(onset_date) - Date.parse(typical_onset_date)) / 86_400_000);
  return { season: seasonLabel(sy, startMonth), onset_date, typical_onset_date, days_diff };
}

/**
 * Cumulative curves behind the onset rule, for the explainer chart:
 * this season vs. the median season, plus the threshold. Index 0 = season start.
 */
export function onsetCurves(
  monthly: MonthlyPoint[],
  climatology: ClimatologyPoint[],
  startMonth: number,
): { months: number[]; season: (number | null)[]; typical: number[]; threshold: number; seasonLabel: string } | null {
  const last = monthly[monthly.length - 1];
  if (!last) return null;
  const sy = seasonStartYear(last.ym, startMonth);
  const byYm = new Map(monthly.map((p) => [p.ym, p]));
  const firstSy = seasonStartYear(monthly[0]!.ym, startMonth);
  const totals: number[] = [];
  for (let y = firstSy; y < sy; y++) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < 12; i++) {
      const p = byYm.get(addMonths(ymOf(y, startMonth), i));
      if (p) {
        sum += p.harmonized;
        n++;
      }
    }
    if (n === 12) totals.push(sum);
  }
  totals.sort((a, b) => a - b);
  const medTotal = quantileSorted(totals, 0.5);
  const climVals = Array.from({ length: 12 }, (_, i) => climatology[(startMonth - 1 + i) % 12]?.median ?? 0);
  const climSum = climVals.reduce((a, b) => a + b, 0) || 1;
  let ct = 0;
  let cs = 0;
  const typical: number[] = [];
  const season: (number | null)[] = [];
  for (let i = 0; i < 12; i++) {
    ct += (climVals[i]! * medTotal) / climSum;
    typical.push(ct);
    const p = byYm.get(addMonths(ymOf(sy, startMonth), i));
    if (p) {
      cs += p.harmonized;
      season.push(cs);
    } else season.push(null);
  }
  return {
    months: Array.from({ length: 12 }, (_, i) => ((startMonth - 1 + i) % 12) + 1),
    season,
    typical,
    threshold: ONSET_FRACTION * medTotal,
    seasonLabel: seasonLabel(sy, startMonth),
  };
}

/** Approximate polygon area in km² (equirectangular, fine for areas this size). */
export function polygonAreaKm2(poly: [number, number][]): number {
  if (poly.length < 3) return 0;
  const lat0 = (poly.reduce((a, p) => a + p[1], 0) / poly.length) * (Math.PI / 180);
  const kx = 111.32 * Math.cos(lat0);
  const ky = 110.57;
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [x1, y1] = poly[j]!;
    const [x2, y2] = poly[i]!;
    s += x1 * kx * (y2 * ky) - x2 * kx * (y1 * ky);
  }
  return Math.abs(s) / 2;
}

export function bboxPolygon(b: [number, number, number, number]): [number, number][] {
  return [
    [b[0], b[1]],
    [b[2], b[1]],
    [b[2], b[3]],
    [b[0], b[3]],
  ];
}

/** Circle (pin + radius) as a 48-gon polygon. */
export function circlePolygon(lon: number, lat: number, radiusKm: number, n = 48): [number, number][] {
  const dLat = radiusKm / 110.57;
  const dLon = radiusKm / (111.32 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI;
    return [Math.round((lon + dLon * Math.cos(a)) * 1000) / 1000, Math.round((lat + dLat * Math.sin(a)) * 1000) / 1000];
  });
}

/** Full derivation used for presets (mock) and custom areas (both adapters). */
export function deriveRegion(rows: BaseRow[], startMonth: number, partialLast = false) {
  const monthly = withPercentiles(rows, partialLast);
  const complete = partialLast ? monthly.slice(0, -1) : monthly;
  const climatology = climatologyOf(byCalendarMonth(complete, (p) => p.ym, (p) => p.harmonized));
  const current = currentOf(monthly, climatology, partialLast);
  const onset = onsetOf(complete, climatology, startMonth);
  return { monthly, climatology, current, onset };
}

/* ---------- custom areas: sum grid cells ---------- */

export function pointInPolygon(lon: number, lat: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function bboxOfPolygon(poly: [number, number][]): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of poly) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

/** Tile ids covering a bbox: "{lat0}_{lon0}" of the tile's south-west corner. */
export function tileIdsForBbox(bbox: [number, number, number, number], tileDeg: number): string[] {
  const out: string[] = [];
  const la0 = Math.floor(bbox[1] / tileDeg) * tileDeg;
  const lo0 = Math.floor(bbox[0] / tileDeg) * tileDeg;
  for (let la = la0; la < bbox[3]; la += tileDeg) {
    for (let lo = lo0; lo < bbox[2]; lo += tileDeg) out.push(`${la}_${lo}`);
  }
  return out;
}
