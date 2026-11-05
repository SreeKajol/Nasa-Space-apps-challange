import { scaleBand, scaleLinear } from "d3-scale";
import { line } from "d3-shape";
import { useMemo, useState } from "react";
import { baseMode, monthOrder, yearRows } from "@/data/view";
import { digits, monthName, num, numCompact, t } from "@/i18n";
import { profileSummary, tooltipText, unitFor } from "@/i18n/summaries";
import { useApp } from "@/state/app";
import { ChartCard } from "../common";
import { useMeasure } from "../hooks";
import { ChartTooltip } from "./shared";

/** Each calendar month: median bar + p10–p90 whisker; the selected year as a line with dots. */
export function MonthlyProfile() {
  const { lang, url, setUrl, view, points, rowStart } = useApp();
  const [ref, width] = useMeasure<HTMLDivElement>();
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const bm = baseMode(url.mode);
  const rows = useMemo(() => yearRows(points, rowStart).filter((r) => r.cells.some((c) => c?.value != null)), [points, rowStart]);
  const order = useMemo(() => monthOrder(rowStart), [rowStart]);
  if (!view || rows.length === 0) return null;

  const selected = rows.find((r) => r.label === url.py) ?? rows[rows.length - 1]!;
  const clim = order.map((mm) => view.climatology[mm - 1]!);
  const W = Math.max(320, width || 720);
  const H = 300;
  const mg = { top: 16, right: 12, bottom: 28, left: 46 };
  const iw = W - mg.left - mg.right;
  const ih = H - mg.top - mg.bottom;
  const x = scaleBand<number>().domain(order).range([0, iw]).padding(0.28);
  const yMax = Math.max(1, ...clim.map((c) => c.p90), ...selected.cells.map((c) => c?.value ?? 0));
  const y = scaleLinear().domain([0, yMax * 1.08]).nice().range([ih, 0]);
  const cx = (mm: number) => (x(mm) ?? 0) + x.bandwidth() / 2;
  const yearPath =
    line<number>()
      .defined((i) => selected.cells[i]?.value != null)
      .x((i) => cx(order[i]!))
      .y((i) => y(selected.cells[i]?.value ?? 0))(order.map((_, i) => i)) ?? "";

  const summary = profileSummary(lang, selected.label, selected.cells, view.climatology, rowStart);
  const table = {
    head: [t(lang, "col.month"), t(lang, "col.median"), t(lang, "col.p10"), t(lang, "col.p90"), digits(lang, selected.label)],
    rows: order.map((mm, i) => [monthName(lang, mm), num(lang, clim[i]!.median), num(lang, clim[i]!.p10), num(lang, clim[i]!.p90), num(lang, selected.cells[i]?.value)]),
  };

  return (
    <ChartCard
      title={t(lang, "tab.profile")}
      summary={summary}
      lang={lang}
      table={table}
      actions={
        <label className="inline-flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">{t(lang, "prof.year")}</span>
          <select className="field min-h-11 text-sm" value={selected.label} onChange={(e) => setUrl({ py: e.target.value })}>
            {[...rows].reverse().map((r) => (
              <option key={r.label} value={r.label}>
                {digits(lang, r.label)}
              </option>
            ))}
          </select>
        </label>
      }
      footer={
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-sm bg-muted-foreground/40" aria-hidden="true" />
            {t(lang, "prof.median_year")}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-0.5 bg-foreground" aria-hidden="true" />
            {t(lang, "prof.range")}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block size-2.5 rounded-full bg-ember" aria-hidden="true" />
            {digits(lang, selected.label)} · {unitFor(lang, bm)}
          </span>
        </div>
      }
    >
      <div ref={ref} className="relative" onMouseLeave={() => setTip(null)}>
        <svg width={W} height={H} role="img" aria-label={summary} className="block max-w-full">
          <g transform={`translate(${mg.left},${mg.top})`}>
            {y.ticks(5).map((v) => (
              <g key={v}>
                <line x2={iw} y1={y(v)} y2={y(v)} stroke="var(--grid-line)" />
                <text x={-8} y={y(v)} textAnchor="end" dominantBaseline="central" fontSize={10} fill="var(--muted-foreground)" className="tabular">
                  {numCompact(lang, v)}
                </text>
              </g>
            ))}
            {order.map((mm, i) => {
              const c = clim[i]!;
              return (
                <g key={mm}>
                  <rect x={x(mm)} y={y(c.median)} width={x.bandwidth()} height={ih - y(c.median)} rx={3} fill="var(--muted-foreground)" opacity={0.3} />
                  <line x1={cx(mm)} x2={cx(mm)} y1={y(c.p10)} y2={y(c.p90)} stroke="var(--foreground)" strokeWidth={1.3} />
                  <line x1={cx(mm) - 5} x2={cx(mm) + 5} y1={y(c.p90)} y2={y(c.p90)} stroke="var(--foreground)" strokeWidth={1.3} />
                  <line x1={cx(mm) - 5} x2={cx(mm) + 5} y1={y(c.p10)} y2={y(c.p10)} stroke="var(--foreground)" strokeWidth={1.3} />
                  <text x={cx(mm)} y={ih + 17} textAnchor="middle" fontSize={10} fill="var(--muted-foreground)">
                    {monthName(lang, mm, true)}
                  </text>
                </g>
              );
            })}
            <path d={yearPath} fill="none" stroke="var(--ember)" strokeWidth={2.2} />
            {selected.cells.map((p, i) =>
              p?.value == null ? null : (
                <circle
                  key={p.ym}
                  cx={cx(order[i]!)}
                  cy={y(p.value)}
                  r={p.partial ? 3.5 : 4.5}
                  fill={p.partial ? "var(--card)" : "var(--ember)"}
                  stroke="var(--ember)"
                  strokeWidth={1.5}
                  className="cursor-pointer"
                  onMouseEnter={() => setTip({ x: mg.left + cx(order[i]!), y: mg.top + y(p.value!), text: tooltipText(lang, p, bm) })}
                  onClick={() => setUrl({ m: p.ym })}
                />
              ),
            )}
          </g>
        </svg>
        <ChartTooltip tip={tip} />
      </div>
    </ChartCard>
  );
}
