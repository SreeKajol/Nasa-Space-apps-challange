import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ArrowUpDown, Download } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { hotspotsQuery } from "@/data/queries";
import { parseYm, type Hotspot } from "@/data/types";
import { toCsv } from "@/data/view";
import { capFirst, digits, monthYear, num, t, tf } from "@/i18n";
import { useApp } from "@/state/app";
import { cn } from "@/lib/utils";
import { ErrorState, ProvenanceBadge, Skeleton } from "./common";
import { downloadFile } from "./hooks";

type Col = "acq_datetime_utc" | "sensor" | "satellite" | "confidence" | "frp_mw" | "latitude";
const ROW_H = 40;
const VIEW_H = 400;
const HEADERS = ["latitude", "longitude", "acq_datetime_utc", "sensor", "satellite", "confidence", "frp_mw", "type"] as const;

export function hotspotsCsv(rows: Hotspot[]): string {
  return toCsv([[...HEADERS], ...rows.map((r) => HEADERS.map((h) => r[h]))]);
}

/** Virtualized, sortable list of the area's hotspot detections for one year. */
export function HotspotTable() {
  const { lang, url, setUrl, req, from, to, provOpts, area } = useApp();
  const years = useMemo(() => {
    const out: number[] = [];
    for (let y = parseYm(to).y; y >= parseYm(from).y; y--) out.push(y);
    return out;
  }, [from, to]);
  const year = url.hy && years.includes(url.hy) ? url.hy : (years[0] ?? null);
  const q = useQuery(hotspotsQuery(url.src, provOpts, req, year));
  const [sort, setSort] = useState<{ col: Col; dir: 1 | -1 }>({ col: "acq_datetime_utc", dir: -1 });
  const [onlyMonth, setOnlyMonth] = useState(true);
  const [scroll, setScroll] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const monthFilter = url.m && year === parseYm(url.m).y && onlyMonth ? url.m : null;

  const rows = useMemo(() => {
    const src = (q.data?.rows ?? []).filter((r) => !monthFilter || r.acq_datetime_utc.startsWith(monthFilter));
    const k = sort.col;
    return [...src].sort((a, b) => {
      const va = a[k];
      const vb = b[k];
      const c = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb), undefined, { numeric: true });
      return c * sort.dir;
    });
  }, [q.data, sort, monthFilter]);

  const first = Math.max(0, Math.floor(scroll / ROW_H) - 6);
  const last = Math.min(rows.length, Math.ceil((scroll + VIEW_H) / ROW_H) + 6);
  const cols: { id: Col; label: string; num?: boolean }[] = [
    { id: "acq_datetime_utc", label: t(lang, "col.time") },
    { id: "sensor", label: t(lang, "col.sensor") },
    { id: "satellite", label: t(lang, "col.sat") },
    { id: "confidence", label: t(lang, "col.conf") },
    { id: "frp_mw", label: t(lang, "col.frp"), num: true },
    { id: "latitude", label: `${t(lang, "col.lat")} / ${t(lang, "col.lon")}`, num: true },
  ];
  const grid = "grid grid-cols-[10.5rem_4.5rem_6rem_6rem_5rem_9rem] gap-x-2 px-3";

  return (
    <section className="card p-4 sm:p-5" aria-labelledby="hs-h">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 id="hs-h" className="text-base font-semibold">
            {t(lang, "hs.title")}
          </h2>
          <ProvenanceBadge source={q.data?.source} lang={lang} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {url.m && year === parseYm(url.m).y && (
            <label className="inline-flex min-h-11 items-center gap-2 text-xs">
              <input type="checkbox" className="size-4 accent-[var(--ember)]" checked={onlyMonth} onChange={(e) => setOnlyMonth(e.target.checked)} />
              {tf(lang, "hs.only_month", { month: monthYear(lang, url.m) })}
            </label>
          )}
          <label className="inline-flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">{t(lang, "prof.year")}</span>
            <select className="field text-sm" value={year ?? ""} onChange={(e) => setUrl({ hy: Number(e.target.value) })}>
              {years.map((y) => (
                <option key={y} value={y}>
                  {digits(lang, y)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={rows.length === 0}
            onClick={() => downloadFile(`firerings_${area?.id ?? "area"}_hotspots_${monthFilter ?? year}.csv`, "text/csv", hotspotsCsv(rows))}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-input px-3 text-sm hover:bg-accent disabled:opacity-40"
          >
            <Download className="size-4" aria-hidden="true" />
            {t(lang, "hs.download")}
          </button>
        </div>
      </header>

      {q.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : q.isError ? (
        <ErrorState lang={lang} error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <>
          <p className="mb-2 text-xs text-muted-foreground" aria-live="polite">
            {rows.length === 0
              ? tf(lang, "hs.empty", { year: monthFilter ? capFirst(monthYear(lang, monthFilter)) : digits(lang, year ?? "") })
              : tf(lang, "hs.count", { n: num(lang, rows.length), year: monthFilter ? capFirst(monthYear(lang, monthFilter)) : digits(lang, year ?? "") })}
          </p>
          <div className="scroll-x rounded-md border">
            <div role="table" aria-label={t(lang, "hs.title")} aria-rowcount={rows.length + 1} className="min-w-[46rem] text-sm">
              <div role="rowgroup" className="border-b bg-muted/50">
                <div role="row" aria-rowindex={1} className={grid}>
                  {cols.map((c) => {
                    const active = sort.col === c.id;
                    return (
                      <div key={c.id} role="columnheader" aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : "none"} className={cn(c.num && "text-right")}>
                        <button
                          type="button"
                          onClick={() => setSort((s) => ({ col: c.id, dir: s.col === c.id ? ((-s.dir) as 1 | -1) : 1 }))}
                          className={cn("inline-flex min-h-10 items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground", c.num && "flex-row-reverse")}
                        >
                          {c.label}
                          {active ? sort.dir === 1 ? <ArrowUp className="size-3" aria-hidden="true" /> : <ArrowDown className="size-3" aria-hidden="true" /> : <ArrowUpDown className="size-3 opacity-50" aria-hidden="true" />}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div
                ref={box}
                role="rowgroup"
                tabIndex={0}
                aria-label={t(lang, "hs.title")}
                className="tabular relative overflow-y-auto"
                style={{ height: Math.min(VIEW_H, Math.max(ROW_H, rows.length * ROW_H)) }}
                onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
              >
                <div style={{ height: rows.length * ROW_H, position: "relative" }}>
                  {rows.slice(first, last).map((r, i) => {
                    const idx = first + i;
                    return (
                      <div
                        key={`${r.acq_datetime_utc}-${r.latitude}-${r.longitude}-${idx}`}
                        role="row"
                        aria-rowindex={idx + 2}
                        className={cn(grid, "absolute inset-x-0 items-center border-b border-border/50", idx % 2 && "bg-muted/25")}
                        style={{ top: idx * ROW_H, height: ROW_H }}
                      >
                        <div role="cell">{digits(lang, r.acq_datetime_utc.slice(0, 16).replace("T", " "))}</div>
                        <div role="cell">{r.sensor}</div>
                        <div role="cell">{r.satellite}</div>
                        <div role="cell">{r.confidence}</div>
                        <div role="cell" className="text-right">
                          {num(lang, r.frp_mw, 1)}
                        </div>
                        <div role="cell" className="text-right">
                          {num(lang, r.latitude, 3)}, {num(lang, r.longitude, 3)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
