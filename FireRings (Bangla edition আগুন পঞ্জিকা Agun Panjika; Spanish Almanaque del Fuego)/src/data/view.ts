import { byCalendarMonth, climatologyOf, percentileOf, seasonOf, seasonStartYear } from "@/compute/derive";
import { isPartialMonth, parseYm, type ClimatologyPoint, type RegionData } from "./types";

/*
 * View layer over a region. The single sensor control in the top bar
 * (Harmonized | MODIS raw | VIIRS raw | Compare) is applied here, so every
 * chart switches together. Memoized per region object and mode.
 */

export type Mode = "harmonized" | "modis" | "viirs" | "compare";
export const MODES: Mode[] = ["harmonized", "modis", "viirs", "compare"];

export interface ViewPoint {
  ym: string;
  /** Value charted in this mode; null where the sensor has no data (VIIRS before viirs_start). */
  value: number | null;
  low: number | null;
  high: number | null;
  /** Percentile vs. the same calendar month, in this mode's units. */
  pct: number | null;
  z: number | null;
  harmonized: number;
  hlow: number;
  hhigh: number;
  modis: number | null;
  viirs: number | null;
  /** The current, still-incomplete month. */
  partial: boolean;
}

export interface RegionView {
  mode: Mode;
  points: ViewPoint[];
  climatology: ClimatologyPoint[];
  /** Only the harmonized series has an uncertainty interval. */
  hasInterval: boolean;
}

const memo = new WeakMap<RegionData, Map<Mode, RegionView>>();

/** "compare" charts the harmonized series as the primary value. */
export const baseMode = (m: Mode): "harmonized" | "modis" | "viirs" => (m === "compare" ? "harmonized" : m);

export function regionView(region: RegionData, mode: Mode): RegionView {
  let entry = memo.get(region);
  if (!entry) {
    entry = new Map();
    memo.set(region, entry);
  }
  const hit = entry.get(mode);
  if (hit) return hit;

  const bm = baseMode(mode);
  const lastYm = region.monthly[region.monthly.length - 1]?.ym ?? "";
  const partialYm = isPartialMonth(lastYm) ? lastYm : null;
  const valueOf = (p: RegionData["monthly"][number]): number | null =>
    bm === "harmonized" ? p.harmonized : bm === "modis" ? p.modis_raw : p.viirs_raw;
  const complete = region.monthly.filter((p) => p.ym !== partialYm);
  const groups = byCalendarMonth(complete, (p) => p.ym, valueOf);
  const stats = groups.map((g) => {
    const mean = g.reduce((a, b) => a + b, 0) / (g.length || 1);
    const sd = Math.sqrt(g.reduce((a, b) => a + (b - mean) ** 2, 0) / (g.length || 1));
    return { mean, sd };
  });

  const points: ViewPoint[] = region.monthly.map((p) => {
    const v = valueOf(p);
    const i = parseYm(p.ym).m - 1;
    const s = stats[i]!;
    const harmonized = bm === "harmonized";
    return {
      ym: p.ym,
      value: v,
      low: v == null ? null : harmonized ? p.low : v,
      high: v == null ? null : harmonized ? p.high : v,
      pct: v == null ? null : harmonized ? p.percentile : Math.round(percentileOf(v, groups[i]!)),
      z: v == null ? null : harmonized ? p.z : s.sd > 0 ? Math.round(((v - s.mean) / s.sd) * 100) / 100 : 0,
      harmonized: p.harmonized,
      hlow: p.low,
      hhigh: p.high,
      modis: p.modis_raw,
      viirs: p.viirs_raw,
      partial: p.ym === partialYm,
    };
  });
  const view: RegionView = {
    mode,
    points,
    climatology: bm === "harmonized" ? region.climatology : climatologyOf(groups),
    hasInterval: bm === "harmonized",
  };
  entry.set(mode, view);
  return view;
}

export function inRange<T extends { ym: string }>(points: T[], from: string, to: string): T[] {
  return points.filter((p) => p.ym >= from && p.ym <= to);
}

export interface YearRow {
  /** "2021" or "2021-22" */
  label: string;
  startYear: number;
  /** 12 slots in column order; null where the month is outside the record/range. */
  cells: (ViewPoint | null)[];
}

/** Rows of 12 months: calendar years (startMonth = 1) or fire years. Oldest first. */
export function yearRows(points: ViewPoint[], startMonth: number): YearRow[] {
  const map = new Map<number, (ViewPoint | null)[]>();
  for (const p of points) {
    const sy = seasonStartYear(p.ym, startMonth);
    let row = map.get(sy);
    if (!row) {
      row = Array.from({ length: 12 }, () => null);
      map.set(sy, row);
    }
    row[(parseYm(p.ym).m - startMonth + 12) % 12] = p;
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([sy, cells]) => ({ label: seasonOf(`${sy}-${String(startMonth).padStart(2, "0")}`, startMonth), startYear: sy, cells }));
}

export interface YearTotal {
  label: string;
  total: number | null;
  low: number | null;
  high: number | null;
  months: number;
  complete: boolean;
}

export function yearTotals(rows: YearRow[]): YearTotal[] {
  return rows.map((r) => {
    const pts = r.cells.filter((c): c is ViewPoint => c != null && c.value != null);
    const months = r.cells.filter((c) => c != null).length;
    const sum = (f: (p: ViewPoint) => number | null) => (pts.length ? Math.round(pts.reduce((a, p) => a + (f(p) ?? 0), 0)) : null);
    return {
      label: r.label,
      total: sum((p) => p.value),
      low: sum((p) => p.low),
      high: sum((p) => p.high),
      months,
      complete: months === 12 && !r.cells.some((c) => c?.partial),
    };
  });
}

/** Worst complete year (partial years at the edges are not ranked). */
export function worstYear(totals: YearTotal[]): YearTotal | null {
  const c = totals.filter((t) => t.complete && t.total != null);
  if (c.length === 0) return null;
  return c.reduce((a, b) => ((b.total ?? 0) > (a.total ?? 0) ? b : a));
}

/** Rank (1 = highest) of a month among the same calendar month in the record. */
export function rankOfMonth(points: ViewPoint[], ym: string): { rank: number; count: number } {
  const m = parseYm(ym).m;
  const target = points.find((p) => p.ym === ym);
  if (!target || target.value == null) return { rank: 0, count: 0 };
  const same = points.filter((p) => !p.partial && p.value != null && parseYm(p.ym).m === m);
  return { rank: same.filter((p) => p.value! > target.value!).length + 1, count: same.length };
}

export function peakMonth(clim: ClimatologyPoint[]): number {
  return clim.reduce((a, b) => (b.median > a.median ? b : a)).month;
}

/**
 * Critical months: median ≥ half the peak month's, in season order, plus their
 * share of a typical year's activity.
 */
export function criticalMonths(clim: ClimatologyPoint[], startMonth: number): { months: number[]; share: number } {
  const peak = Math.max(...clim.map((c) => c.median));
  const total = clim.reduce((a, c) => a + c.median, 0);
  const months = clim
    .filter((c) => peak > 0 && c.median >= 0.5 * peak)
    .map((c) => c.month)
    .sort((a, b) => ((a - startMonth + 12) % 12) - ((b - startMonth + 12) % 12));
  const share = total > 0 ? clim.filter((c) => months.includes(c.month)).reduce((a, c) => a + c.median, 0) / total : 0;
  return { months, share };
}

/** Months of the year in column order, e.g. [11, 12, 1, …, 10]. */
export function monthOrder(startMonth: number): number[] {
  return Array.from({ length: 12 }, (_, i) => ((startMonth - 1 + i) % 12) + 1);
}

export function rollingMean(values: (number | null)[], window = 12): (number | null)[] {
  return values.map((_, i) => {
    if (i < window - 1) return null;
    let s = 0;
    for (let k = i - window + 1; k <= i; k++) {
      const v = values[k];
      if (v == null) return null;
      s += v;
    }
    return s / window;
  });
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows
    .map((r) =>
      r
        .map((cell) => {
          const s = cell == null ? "" : String(cell);
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(","),
    )
    .join("\n");
}
