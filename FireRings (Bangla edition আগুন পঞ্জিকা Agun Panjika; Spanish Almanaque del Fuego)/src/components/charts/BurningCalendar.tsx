import { useCallback, useId, useMemo, useRef, useState } from "react";
import { statusOf } from "@/compute/derive";
import { divergingGradient, rampGradient } from "@/data/ramp";
import { baseMode, monthOrder, yearRows, yearTotals, type ViewPoint, type YearRow, type YearTotal } from "@/data/view";
import { capFirst, digits, monthName, monthYear, num, t, tf } from "@/i18n";
import { calendarSummary, tooltipText, unitFor } from "@/i18n/summaries";
import { useApp } from "@/state/app";
import { useSettings } from "@/state/settings";
import { ChartCard, Segmented } from "../common";
import { HearSeason } from "../HearSeason";
import { anomalyColor, ChartTooltip, COUNT_GAMMA, countColor, maxValue, useGridNav } from "./shared";

export interface CalendarModel {
  rows: YearRow[]; // newest first
  totals: YearTotal[]; // aligned with rows
  order: number[];
  medians: number[]; // aligned with order
  max: number;
  maxTotal: number;
  maxMedian: number;
}

export function useCalendarModel(): CalendarModel | null {
  const { view, points, rowStart } = useApp();
  return useMemo(() => {
    if (!view || points.length === 0) return null;
    const asc = yearRows(points, rowStart);
    const rows = [...asc].reverse();
    const totals = yearTotals(rows);
    const order = monthOrder(rowStart);
    const medians = order.map((m) => view.climatology[m - 1]?.median ?? 0);
    return {
      rows,
      totals,
      order,
      medians,
      max: maxValue(points),
      maxTotal: Math.max(1, ...totals.map((x) => x.total ?? 0)),
      maxMedian: Math.max(1, ...medians),
    };
  }, [view, points, rowStart]);
}

/** The burning calendar: years × months, with marginal medians and yearly totals. */
export function BurningCalendar() {
  const app = useApp();
  const { lang, url, setUrl, region, index, view } = app;
  const { ramp, dark } = useSettings();
  const model = useCalendarModel();
  const gid = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const mode = baseMode(url.mode);
  const unit = unitFor(lang, mode);
  const anomaly = url.view === "anomaly";

  const open = useCallback(
    (r: number, c: number) => {
      const p = model?.rows[r]?.cells[c];
      if (p) setUrl({ m: p.ym });
    },
    [model, setUrl],
  );
  const nav = useGridNav(model?.rows.length ?? 0, 12, open);

  if (!model || !region || !index || !view) return null;
  const { rows, totals, order, medians, max, maxTotal, maxMedian } = model;
  // "since <first complete year>": the record starts mid-year, which would read oddly.
  const firstYear = [...totals].reverse().find((x) => x.complete)?.label ?? rows[rows.length - 1]?.label ?? "";
  const summary = calendarSummary(lang, view.climatology, region.fire_year_start_month, [...totals].reverse(), firstYear.slice(0, 4));
  const active = nav.pos ? rows[nav.pos.r]?.cells[nav.pos.c] : null;
  const activeText = nav.pos
    ? active
      ? tooltipText(lang, active, mode)
      : `${digits(lang, rows[nav.pos.r]?.label ?? "")} · ${monthName(lang, order[nav.pos.c]!)} · ${t(lang, "cal.no_data")}`
    : "";

  const cellColor = (p: ViewPoint, col: number) =>
    p.value == null ? "transparent" : anomaly ? anomalyColor(p.value, medians[col] ?? 0, dark) : countColor(p.value, max, ramp, dark);

  const showTip = (el: HTMLElement, text: string) => {
    const box = wrap.current?.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (!box) return;
    setTip({ x: r.left - box.left + r.width / 2 + (wrap.current?.scrollLeft ?? 0), y: r.top - box.top, text });
  };

  const cols = "grid-cols-[4.75rem_repeat(12,minmax(2rem,1fr))_5.5rem]";
  const legendTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => max * Math.pow(f, 1 / COUNT_GAMMA));

  const table = {
    head: [t(lang, "cal.years"), ...order.map((m) => monthName(lang, m, true)), t(lang, "cal.total_col")],
    rows: [
      [t(lang, "cal.median_row"), ...medians.map((v) => num(lang, v)), null],
      ...rows.map((r, i) => [digits(lang, r.label), ...r.cells.map((c) => (c?.value == null ? null : num(lang, c.value))), num(lang, totals[i]?.total)]),
    ],
  };

  return (
    <ChartCard
      id="calendar"
      title={t(lang, "cal.title")}
      summary={summary}
      lang={lang}
      table={table}
      actions={
        <>
          <Segmented
            label={t(lang, "cal.view")}
            value={url.view}
            onChange={(v) => setUrl({ view: v })}
            options={[
              { id: "counts", label: t(lang, "cal.counts") },
              { id: "anomaly", label: t(lang, "cal.anomaly") },
            ]}
          />
          {region.fire_year_start_month !== 1 && (
            <Segmented
              label={t(lang, "cal.years")}
              value={url.rows}
              onChange={(v) => setUrl({ rows: v })}
              options={[
                { id: "calendar", label: t(lang, "cal.calendar_year") },
                { id: "fire", label: t(lang, "cal.fire_year") },
              ]}
            />
          )}
        </>
      }
      footer={
        <div className="mt-4 space-y-3">
          <Legend anomaly={anomaly} ticks={legendTicks} unit={unit} />
          <HearSeason />
        </div>
      }
    >
      <div ref={wrap} className="scroll-x relative -mx-1 px-1 pb-1" onMouseLeave={() => setTip(null)}>
        <div className="min-w-[38rem]">
          {/* Marginal: monthly median (the climatology) */}
          <div className={`grid ${cols} items-end gap-[3px]`} aria-hidden="true">
            <div className="sticky left-0 z-10 bg-card pr-2 text-right text-[11px] text-muted-foreground">{t(lang, "cal.median_row")}</div>
            {medians.map((v, i) => (
              <div key={i} className="flex h-10 items-end" title={`${monthName(lang, order[i]!)}: ${num(lang, v)}`}>
                <div className="w-full rounded-t-sm bg-muted-foreground/45" style={{ height: `${Math.max(2, (v / maxMedian) * 100)}%` }} />
              </div>
            ))}
            <div />
          </div>

          <div
            role="grid"
            aria-label={t(lang, "cal.grid_label")}
            aria-describedby={`${gid}-live`}
            aria-activedescendant={nav.pos ? `${gid}-${nav.pos.r}-${nav.pos.c}` : undefined}
            tabIndex={0}
            onKeyDown={(e) => {
              nav.onKeyDown(e);
              if (!nav.pos) nav.setPos({ r: 0, c: 0 });
            }}
            onFocus={() => !nav.pos && nav.setPos({ r: 0, c: 0 })}
            onBlur={() => setTip(null)}
            className="mt-1 rounded-md focus-visible:outline-2 focus-visible:outline-offset-4"
          >
            <div role="row" className={`grid ${cols} gap-[3px]`}>
              <div role="columnheader" className="sticky left-0 z-10 bg-card" />
              {order.map((m) => (
                <div key={m} role="columnheader" className="pb-1 text-center text-[11px] font-medium text-muted-foreground">
                  <abbr title={monthName(lang, m)} className="no-underline">
                    {monthName(lang, m, true)}
                  </abbr>
                </div>
              ))}
              <div role="columnheader" className="pb-1 pl-1 text-[11px] font-medium text-muted-foreground">
                {t(lang, "cal.total_col")}
              </div>
            </div>
            {rows.map((r, ri) => {
              const tot = totals[ri]!;
              return (
                <div role="row" key={r.label} className={`grid ${cols} mt-[3px] gap-[3px]`}>
                  <div role="rowheader" className="tabular sticky left-0 z-10 flex items-center justify-end bg-card pr-2 text-xs text-muted-foreground">
                    {digits(lang, r.label)}
                  </div>
                  {r.cells.map((p, ci) => {
                    const isActive = nav.pos?.r === ri && nav.pos?.c === ci;
                    const extreme = p?.pct != null && !p.partial && statusOf(p.pct) === "extreme";
                    const label = p ? tooltipText(lang, p, mode) : t(lang, "cal.no_data");
                    return (
                      <div
                        key={ci}
                        id={`${gid}-${ri}-${ci}`}
                        role="gridcell"
                        aria-label={label}
                        aria-selected={isActive}
                        data-active={isActive}
                        data-extreme={extreme}
                        data-nodata={!p || p.value == null}
                        data-partial={p?.partial ?? false}
                        data-uncertain={!!p && mode === "harmonized" && p.ym < index.viirs_start}
                        className="cal-cell flex h-7 items-center justify-center text-[11px] sm:h-[1.875rem]"
                        style={{ background: p ? cellColor(p, ci) : undefined }}
                        onMouseEnter={(e) => p && showTip(e.currentTarget, label)}
                        onClick={() => {
                          nav.setPos({ r: ri, c: ci });
                          open(ri, ci);
                        }}
                      >
                        {extreme && (
                          <span aria-hidden="true" className="rounded-sm bg-black/55 px-0.5 leading-none text-white">
                            ⚠
                          </span>
                        )}
                      </div>
                    );
                  })}
                  <div className="flex items-center gap-1.5 pl-1" aria-hidden="true">
                    <div className="h-3 rounded-r-sm bg-ember/80" style={{ width: `${Math.max(2, ((tot.total ?? 0) / maxTotal) * 100) * 0.55}%` }} />
                    <span className="tabular text-[11px] text-muted-foreground">{tot.total == null ? "—" : num(lang, tot.total)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <ChartTooltip tip={tip} />
      </div>
      <p id={`${gid}-live`} aria-live="polite" className="sr-only">
        {activeText}
      </p>
    </ChartCard>
  );
}

function Legend({ anomaly, ticks, unit }: { anomaly: boolean; ticks: number[]; unit: string }) {
  const { lang, index, url } = useApp();
  const { ramp, dark } = useSettings();
  return (
    <div className="flex flex-wrap items-start gap-x-6 gap-y-2 text-xs text-muted-foreground">
      <div className="w-56">
        <div className="h-2.5 rounded-full" style={{ background: anomaly ? divergingGradient(dark) : rampGradient(ramp, dark) }} aria-hidden="true" />
        <div className="tabular mt-1 flex justify-between">
          {anomaly ? (
            <>
              <span>{t(lang, "cal.anom_low")}</span>
              <span>{t(lang, "cal.anom_mid")}</span>
              <span>{t(lang, "cal.anom_high")}</span>
            </>
          ) : (
            ticks.map((v, i) => <span key={i}>{num(lang, v)}</span>)
          )}
        </div>
        {!anomaly && <div className="mt-0.5">{tf(lang, "cal.legend_counts", { unit: capFirst(unit) })}</div>}
      </div>
      <ul className="space-y-1">
        <li>{t(lang, "cal.extreme_note")}</li>
        {baseMode(url.mode) === "harmonized" && index && <li>{tf(lang, "cal.uncertain_note", { viirs: monthYear(lang, index.viirs_start) })}</li>}
        <li className="flex items-center gap-2">
          <span className="cal-cell inline-block size-3.5 border" data-nodata="true" aria-hidden="true" />
          {t(lang, "cal.no_data")}
          <span className="cal-cell ml-3 inline-block size-3.5 border" data-partial="true" aria-hidden="true" />
          {t(lang, "cal.partial")}
        </li>
      </ul>
    </div>
  );
}
