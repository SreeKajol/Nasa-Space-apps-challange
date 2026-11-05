import { scaleBand, scaleLinear } from "d3-scale";
import { line } from "d3-shape";
import type { Hotspot } from "@/data/types";
import { daysInMonth, parseYm } from "@/data/types";
import { digits, monthName, num, numCompact, t, type Lang } from "@/i18n";

/** Cumulative activity: this season vs the median season, with the 10% threshold. */
export function CumulativeChart({
  lang,
  months,
  season,
  typical,
  threshold,
}: {
  lang: Lang;
  months: number[];
  season: (number | null)[];
  typical: number[];
  threshold: number;
}) {
  const W = 340;
  const H = 180;
  const m = { top: 10, right: 10, bottom: 22, left: 40 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const x = scaleLinear().domain([0, 11]).range([0, iw]);
  const y = scaleLinear()
    .domain([0, Math.max(1, ...typical, ...season.map((v) => v ?? 0)) * 1.05])
    .nice()
    .range([ih, 0]);
  const path = (vals: (number | null)[]) =>
    line<number | null>()
      .defined((v) => v != null)
      .x((_, i) => x(i))
      .y((v) => y(v ?? 0))(vals) ?? "";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={t(lang, "on.chart")}>
      <g transform={`translate(${m.left},${m.top})`}>
        {y.ticks(4).map((v) => (
          <g key={v}>
            <line x2={iw} y1={y(v)} y2={y(v)} stroke="var(--grid-line)" />
            <text x={-6} y={y(v)} textAnchor="end" dominantBaseline="central" fontSize={9} fill="var(--muted-foreground)">
              {numCompact(lang, v)}
            </text>
          </g>
        ))}
        <line x2={iw} y1={y(threshold)} y2={y(threshold)} stroke="var(--status-extreme)" strokeDasharray="4 3" />
        <text x={iw} y={y(threshold) - 4} textAnchor="end" fontSize={9} fill="var(--status-extreme)">
          {t(lang, "on.threshold")}
        </text>
        <path d={path(typical)} fill="none" stroke="var(--muted-foreground)" strokeWidth={1.8} strokeDasharray="5 3" />
        <path d={path(season)} fill="none" stroke="var(--ember)" strokeWidth={2.4} />
        {months.map((mm, i) =>
          i % 2 === 0 ? (
            <text key={i} x={x(i)} y={ih + 15} textAnchor="middle" fontSize={9} fill="var(--muted-foreground)">
              {monthName(lang, mm, true)}
            </text>
          ) : null,
        )}
      </g>
    </svg>
  );
}

/** Raw detections per day in one month, stacked MODIS / VIIRS. */
export function DailyBars({ lang, ym, rows }: { lang: Lang; ym: string; rows: Hotspot[] }) {
  const { y: yr, m: mo } = parseYm(ym);
  const dim = daysInMonth(yr, mo);
  const days = Array.from({ length: dim }, (_, i) => ({ d: i + 1, modis: 0, viirs: 0 }));
  for (const r of rows) {
    const d = Number(r.acq_datetime_utc.slice(8, 10));
    const slot = days[d - 1];
    if (!slot) continue;
    if (r.sensor === "MODIS") slot.modis++;
    else slot.viirs++;
  }
  const W = 360;
  const H = 150;
  const m = { top: 8, right: 6, bottom: 20, left: 30 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const x = scaleBand<number>().domain(days.map((d) => d.d)).range([0, iw]).padding(0.15);
  const y = scaleLinear()
    .domain([0, Math.max(1, ...days.map((d) => d.modis + d.viirs))])
    .nice()
    .range([ih, 0]);
  const peak = days.reduce((a, b) => (b.modis + b.viirs > a.modis + a.viirs ? b : a));
  const label = `${t(lang, "dr.daily")}: ${monthName(lang, mo)} ${digits(lang, peak.d)} · ${num(lang, peak.modis + peak.viirs)}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={label}>
      <g transform={`translate(${m.left},${m.top})`}>
        {y.ticks(3).map((v) => (
          <g key={v}>
            <line x2={iw} y1={y(v)} y2={y(v)} stroke="var(--grid-line)" />
            <text x={-5} y={y(v)} textAnchor="end" dominantBaseline="central" fontSize={9} fill="var(--muted-foreground)">
              {num(lang, v)}
            </text>
          </g>
        ))}
        {days.map((d) => (
          <g key={d.d}>
            <rect x={x(d.d)} width={x.bandwidth()} y={y(d.modis)} height={ih - y(d.modis)} fill="var(--line-modis)" />
            <rect x={x(d.d)} width={x.bandwidth()} y={y(d.modis + d.viirs)} height={y(d.modis) - y(d.modis + d.viirs)} fill="var(--line-viirs)" />
            {(d.d === 1 || d.d % 5 === 0) && (
              <text x={(x(d.d) ?? 0) + x.bandwidth() / 2} y={ih + 13} textAnchor="middle" fontSize={9} fill="var(--muted-foreground)">
                {digits(lang, d.d)}
              </text>
            )}
          </g>
        ))}
      </g>
    </svg>
  );
}
