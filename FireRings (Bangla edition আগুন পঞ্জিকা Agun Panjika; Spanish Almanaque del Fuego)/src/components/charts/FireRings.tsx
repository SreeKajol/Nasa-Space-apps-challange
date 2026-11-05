import { arc as d3arc } from "d3-shape";
import { Pause, Play, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { statusOf } from "@/compute/derive";
import { rampGradient } from "@/data/ramp";
import { baseMode, monthOrder, yearRows, yearTotals } from "@/data/view";
import { capFirst, digits, monthName, num, t, tf } from "@/i18n";
import { ringsSummary, tooltipText, unitFor } from "@/i18n/summaries";
import { useApp } from "@/state/app";
import { useSettings } from "@/state/settings";
import { ChartCard } from "../common";
import { HearSeason } from "../HearSeason";
import { useMeasure } from "../hooks";
import { ChartTooltip, countColor, maxValue, useGridNav } from "./shared";

const PLAY_MS = 6000;

/*
 * Fire Rings — the signature chart. Each year is a ring (oldest at the centre,
 * newest outside); months run clockwise from the top like a clock. It reads
 * like tree rings recording fire scars.
 */
export function FireRings() {
  const { lang, url, setUrl, view, points, rowStart } = useApp();
  const { ramp, dark, reducedMotion } = useSettings();
  const [ref, width] = useMeasure<HTMLDivElement>();
  const gid = useId();
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const mode = baseMode(url.mode);

  const rows = useMemo(() => yearRows(points, rowStart), [points, rowStart]);
  const order = useMemo(() => monthOrder(rowStart), [rowStart]);
  const max = useMemo(() => maxValue(points), [points]);
  const totals = useMemo(() => yearTotals(rows), [rows]);

  // Play animation: rings appear year by year.
  const [shown, setShown] = useState(rows.length);
  const [playing, setPlaying] = useState(false);
  const raf = useRef<number | null>(null);
  useEffect(() => setShown(rows.length), [rows.length]);
  useEffect(() => {
    if (!playing) return;
    if (reducedMotion) {
      setShown(rows.length);
      setPlaying(false);
      return;
    }
    const startShown = shown >= rows.length ? 0 : shown;
    const t0 = performance.now() - (startShown / rows.length) * PLAY_MS;
    const step = (now: number) => {
      const n = Math.min(rows.length, Math.floor(((now - t0) / PLAY_MS) * rows.length) + 1);
      setShown(n);
      if (n < rows.length) raf.current = requestAnimationFrame(step);
      else setPlaying(false);
    };
    raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current != null) cancelAnimationFrame(raf.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, reducedMotion, rows.length]);

  const open = useCallback(
    (r: number, c: number) => {
      const p = rows[r]?.cells[c];
      if (p) setUrl({ m: p.ym });
    },
    [rows, setUrl],
  );
  const nav = useGridNav(rows.length, 12, open);

  if (!view) return null;
  const size = Math.max(300, Math.min(600, width || 480));
  const cx = size / 2;
  const cy = size / 2;
  const outer = size / 2 - 30;
  const inner = Math.max(28, size * 0.09);
  const ringW = (outer - inner) / Math.max(1, rows.length);
  const gap = Math.min(0.012, 0.5 / Math.max(1, rows.length));
  const arc = d3arc<{ innerRadius: number; outerRadius: number; startAngle: number; endAngle: number }>();

  const summary = ringsSummary(lang, totals, mode);
  const active = nav.pos ? rows[nav.pos.r]?.cells[nav.pos.c] : null;
  const activeText = nav.pos ? (active ? tooltipText(lang, active, mode) : `${digits(lang, rows[nav.pos.r]?.label ?? "")} · ${t(lang, "cal.no_data")}`) : "";
  const showTipAt = (x: number, y: number, text: string) => setTip({ x, y, text });

  const table = {
    head: [t(lang, "cal.years"), ...order.map((m) => monthName(lang, m, true)), t(lang, "cal.total_col")],
    rows: [...rows].reverse().map((r) => [digits(lang, r.label), ...r.cells.map((c) => (c?.value == null ? null : num(lang, c.value))), num(lang, totals[rows.indexOf(r)]?.total)]),
  };

  return (
    <ChartCard
      title={t(lang, "tab.rings")}
      summary={summary}
      lang={lang}
      table={table}
      actions={
        <button
          type="button"
          onClick={() => {
            if (playing) setPlaying(false);
            else {
              if (shown >= rows.length) setShown(0);
              setPlaying(true);
            }
          }}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {playing ? <Pause className="size-4" aria-hidden="true" /> : shown >= rows.length ? <RotateCcw className="size-4" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
          {playing ? t(lang, "rings.pause") : shown >= rows.length ? t(lang, "rings.replay") : t(lang, "rings.play")}
        </button>
      }
      footer={
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span className="h-2.5 w-48 rounded-full" style={{ background: rampGradient(ramp, dark) }} aria-hidden="true" />
            <span className="tabular">
              {num(lang, 0)} – {num(lang, max)} {unitFor(lang, mode)} · {t(lang, "cal.extreme_note")}
            </span>
          </div>
          <p className="text-xs text-muted-foreground italic">{t(lang, "rings.note")}</p>
          <HearSeason />
        </div>
      }
    >
      <div ref={ref} className="relative flex justify-center" onMouseLeave={() => setTip(null)}>
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          role="application"
          aria-roledescription={t(lang, "tab.rings")}
          aria-label={t(lang, "rings.label")}
          aria-describedby={`${gid}-live`}
          tabIndex={0}
          className="max-w-full rounded-full focus-visible:outline-2 focus-visible:outline-offset-4"
          onKeyDown={(e) => {
            nav.onKeyDown(e, { upIsPrev: false });
            if (!nav.pos) nav.setPos({ r: rows.length - 1, c: 0 });
          }}
          onFocus={() => !nav.pos && nav.setPos({ r: rows.length - 1, c: 0 })}
        >
          <g transform={`translate(${cx},${cy})`}>
            {rows.slice(0, shown).map((r, ri) =>
              r.cells.map((p, ci) => {
                const r0 = inner + ri * ringW;
                const r1 = r0 + Math.max(0.6, ringW - 0.8);
                const a0 = (ci / 12) * 2 * Math.PI + gap;
                const a1 = ((ci + 1) / 12) * 2 * Math.PI - gap;
                const d = arc({ innerRadius: r0, outerRadius: r1, startAngle: a0, endAngle: a1 }) ?? "";
                const isActive = nav.pos?.r === ri && nav.pos?.c === ci;
                const extreme = p?.pct != null && !p.partial && statusOf(p.pct) === "extreme";
                const fill = !p || p.value == null ? "var(--muted)" : countColor(p.value, max, ramp, dark);
                const label = p ? tooltipText(lang, p, mode) : "";
                const mid = (a0 + a1) / 2;
                const rm = (r0 + r1) / 2;
                return (
                  <path
                    key={`${r.label}-${ci}`}
                    d={d}
                    fill={fill}
                    stroke={isActive ? "var(--foreground)" : extreme ? "var(--foreground)" : "none"}
                    strokeWidth={isActive ? 2 : extreme ? 0.8 : 0}
                    opacity={p?.partial ? 0.6 : 1}
                    className="cursor-pointer"
                    onMouseEnter={() => p && showTipAt(cx + rm * Math.sin(mid) + (width - size) / 2, cy - rm * Math.cos(mid), label)}
                    onClick={() => {
                      nav.setPos({ r: ri, c: ci });
                      open(ri, ci);
                    }}
                  />
                );
              }),
            )}
            {/* month labels around the outside */}
            {order.map((m, ci) => {
              const a = ((ci + 0.5) / 12) * 2 * Math.PI;
              const rr = outer + 16;
              return (
                <text key={m} x={rr * Math.sin(a)} y={-rr * Math.cos(a)} textAnchor="middle" dominantBaseline="central" fontSize={11} fill="var(--muted-foreground)" aria-hidden="true">
                  {monthName(lang, m, true)}
                </text>
              );
            })}
            {/* year labels at the top */}
            {rows.slice(0, shown).map((r, ri) =>
              ri === 0 || ri === rows.length - 1 || (rows.length > 10 && ri % 5 === 0) ? (
                <text key={r.label} x={3} y={-(inner + ri * ringW + ringW / 2)} fontSize={Math.min(10, Math.max(7, ringW * 0.9))} fill="var(--foreground)" dominantBaseline="central" aria-hidden="true" className="tabular" style={{ paintOrder: "stroke", stroke: "var(--card)", strokeWidth: 3 }}>
                  {digits(lang, r.label.slice(0, 4))}
                </text>
              ) : null,
            )}
            <text textAnchor="middle" dominantBaseline="central" fontSize={12} fontWeight={600} fill="var(--ember-text)" aria-hidden="true">
              {digits(lang, rows[Math.max(0, shown - 1)]?.label.slice(0, 4) ?? "")}
            </text>
          </g>
        </svg>
        <ChartTooltip tip={tip} />
      </div>
      <p id={`${gid}-live`} aria-live="polite" className="sr-only">
        {activeText || tf(lang, "cal.legend_counts", { unit: capFirst(unitFor(lang, mode)) })}
      </p>
    </ChartCard>
  );
}
