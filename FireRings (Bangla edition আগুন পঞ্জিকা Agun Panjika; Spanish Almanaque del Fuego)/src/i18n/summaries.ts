import { statusOf } from "@/compute/derive";
import { addMonths, parseYm, type ClimatologyPoint, type RegionData } from "@/data/types";
import { criticalMonths, peakMonth, rankOfMonth, worstYear, type Mode, type ViewPoint, type YearTotal } from "@/data/view";
import {
  capFirst,
  dateLong,
  digits,
  monthList,
  monthName,
  monthYear,
  num,
  ordinal,
  pctStr,
  signedPct,
  t,
  tf,
  valueWithRange,
  type Lang,
} from "./index";

/*
 * Plain-language one-line summaries, filled into translated templates.
 * They sit above each chart, are announced via aria-live, and are what
 * sound/speech features read.
 */

export function unitFor(lang: Lang, mode: Mode): string {
  return mode === "modis" || mode === "viirs" ? t(lang, "unit.detections") : t(lang, "unit.hotspots");
}

export function sensorName(lang: Lang, mode: Mode): string {
  return t(lang, `mode.${mode}`);
}

/** Current (latest complete) month — always the harmonized series. */
export function nowSummary(lang: Lang, r: RegionData, harmonized: ViewPoint[]): string {
  const c = r.current;
  const { m } = parseYm(c.ym);
  const first = parseYm(r.monthly[0]?.ym ?? c.ym).y + 1;
  const { rank } = rankOfMonth(harmonized, c.ym);
  return tf(lang, "sum.now", {
    month: capFirst(monthYear(lang, c.ym)),
    value: valueWithRange(lang, c.value, c.low, c.high, t(lang, "unit.hotspots")),
    status: t(lang, `status.${c.status}`).toLowerCase(),
    vs: c.median > 0 ? signedPct(lang, c.value / c.median - 1) : "—",
    rank: ordinal(lang, rank),
    monthName: monthName(lang, m),
    first: digits(lang, first),
  });
}

export function onsetSummary(lang: Lang, r: RegionData): string {
  const o = r.onset;
  if (!o) return t(lang, "simple.notyet");
  const vars = {
    season: digits(lang, o.season),
    n: digits(lang, Math.abs(o.days_diff)),
    date: dateLong(lang, o.onset_date),
    typical: dateLong(lang, o.typical_onset_date),
  };
  if (o.days_diff < 0) return tf(lang, "sum.onset_early", vars);
  if (o.days_diff > 0) return tf(lang, "sum.onset_late", vars);
  return tf(lang, "sum.onset_ontime", vars);
}

export function criticalLabel(lang: Lang, clim: ClimatologyPoint[], start: number): string {
  return monthList(lang, criticalMonths(clim, start).months);
}

export function calendarSummary(lang: Lang, clim: ClimatologyPoint[], start: number, totals: YearTotal[], firstYear: string): string {
  if (clim.every((c) => c.median === 0) && totals.every((x) => !x.total)) return t(lang, "sum.nofire");
  const months = criticalLabel(lang, clim, start);
  const worst = worstYear(totals);
  if (!worst) return tf(lang, "sum.calendar_short", { months });
  return tf(lang, "sum.calendar", { months, worst: digits(lang, worst.label), first: digits(lang, firstYear) });
}

export function ringsSummary(lang: Lang, totals: YearTotal[], mode: Mode): string {
  const worst = worstYear(totals);
  if (!worst || !worst.total) return t(lang, "sum.nofire");
  return tf(lang, "sum.rings", {
    year: digits(lang, worst.label),
    total: `${num(lang, worst.total)} ${unitFor(lang, mode)}`,
    first: digits(lang, totals[0]!.label),
    last: digits(lang, totals[totals.length - 1]!.label),
  });
}

/** Ratio of mean values in the 2 years after vs. before VIIRS starts. */
export function viirsJump(pts: ViewPoint[], viirsStart: string): { raw: number; harmonized: number } | null {
  const before = pts.filter((p) => p.ym < viirsStart && p.ym >= addMonths(viirsStart, -24));
  const after = pts.filter((p) => p.ym >= viirsStart && p.ym < addMonths(viirsStart, 24));
  if (before.length < 12 || after.length < 12) return null;
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const raw = (p: ViewPoint) => (p.modis ?? 0) + (p.viirs ?? 0);
  const rb = mean(before.map(raw));
  const hb = mean(before.map((p) => p.harmonized));
  if (rb <= 0 || hb <= 0) return null;
  return { raw: mean(after.map(raw)) / rb, harmonized: mean(after.map((p) => p.harmonized)) / hb };
}

export function seriesSummary(lang: Lang, pts: ViewPoint[], allPts: ViewPoint[], viirsStart: string, mode: Mode): string {
  const date = monthYear(lang, viirsStart);
  const jump = viirsJump(allPts, viirsStart);
  if (jump && mode !== "harmonized") {
    return tf(lang, "sum.series_seam", { date, raw: num(lang, jump.raw, 1), harm: num(lang, jump.harmonized, 1) });
  }
  const valid = pts.filter((p) => p.value != null && !p.partial);
  if (valid.length === 0) return t(lang, "sum.nofire");
  const max = valid.reduce((a, b) => (b.value! > a.value! ? b : a));
  if (!max.value) return t(lang, "sum.nofire");
  return tf(lang, "sum.series", {
    month: monthYear(lang, max.ym),
    value: valueWithRange(lang, max.value, max.low, max.high, unitFor(lang, mode)),
    date,
  });
}

export function seamMiniSummary(lang: Lang, allPts: ViewPoint[], viirsStart: string): string {
  const jump = viirsJump(allPts, viirsStart);
  if (!jump) return "";
  return tf(lang, "sum.seam_mini", { date: monthYear(lang, viirsStart), raw: num(lang, jump.raw, 1), harm: num(lang, jump.harmonized, 1) });
}

export function profileSummary(lang: Lang, yearLabel: string | null, row: (ViewPoint | null)[], clim: ClimatologyPoint[], start: number): string {
  if (!yearLabel) return tf(lang, "sum.profile_median", { months: capFirst(criticalLabel(lang, clim, start)) });
  const pts = row.filter((p): p is ViewPoint => p != null && p.value != null && !p.partial).slice(-6);
  if (pts.length === 0) return t(lang, "sum.nofire");
  const above = pts.filter((p) => p.value! > (clim[parseYm(p.ym).m - 1]?.median ?? 0)).length;
  return tf(lang, "sum.profile", { year: digits(lang, yearLabel), n: digits(lang, above), m: digits(lang, pts.length) });
}

export function monthSummary(lang: Lang, p: ViewPoint, clim: ClimatologyPoint[], mode: Mode): string {
  const { m } = parseYm(p.ym);
  if (p.value == null || p.pct == null) {
    return tf(lang, "sum.month_nodata", { month: capFirst(monthYear(lang, p.ym)), sensor: sensorName(lang, mode) });
  }
  return tf(lang, "sum.month", {
    month: capFirst(monthYear(lang, p.ym)),
    value: valueWithRange(lang, p.value, p.low, p.high, unitFor(lang, mode)),
    status: t(lang, `status.${statusOf(p.pct)}`).toLowerCase(),
    pct: lang === "en" ? ordinal("en", p.pct) : digits(lang, p.pct),
    monthName: monthName(lang, m),
    median: num(lang, clim[m - 1]?.median ?? 0),
  });
}

export function tooltipText(lang: Lang, p: ViewPoint, mode: Mode): string {
  return tf(lang, "tip.cell", {
    month: capFirst(monthYear(lang, p.ym)),
    value: valueWithRange(lang, p.value, p.low, p.high, unitFor(lang, mode)) + (p.partial ? ` (${t(lang, "cal.partial")})` : ""),
    pct: p.pct == null ? "—" : lang === "en" ? ordinal("en", p.pct) : digits(lang, p.pct),
    modis: num(lang, p.modis),
    viirs: num(lang, p.viirs),
  });
}

export function contextSummary(lang: Lang, ctx: { ym: string; t2m_c: number; precip_mm: number }[]): string {
  const last = ctx[ctx.length - 1];
  if (!last) return "";
  return tf(lang, "sum.context", { month: capFirst(monthYear(lang, last.ym)), temp: num(lang, last.t2m_c, 1), rain: num(lang, last.precip_mm) });
}

export { pctStr, peakMonth };
