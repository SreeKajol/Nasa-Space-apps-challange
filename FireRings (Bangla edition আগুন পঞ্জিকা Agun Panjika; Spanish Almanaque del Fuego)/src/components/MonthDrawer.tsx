import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { statusOf } from "@/compute/derive";
import { hotspotsQuery } from "@/data/queries";
import { addMonths, parseYm } from "@/data/types";
import { baseMode } from "@/data/view";
import { capFirst, monthYear, num, t, valueWithRange } from "@/i18n";
import { monthSummary, unitFor } from "@/i18n/summaries";
import { useApp } from "@/state/app";
import { errorText, ProvenanceBadge, Skeleton, StatusChip } from "./common";
import { Drawer } from "./Drawer";
import { DailyBars } from "./charts/SmallCharts";
import { WhyThisMonthSlot } from "@/ml/inline";

/** Click a calendar cell → this drawer: the month's numbers, daily bars and summary. */
export function MonthDrawer() {
  const { lang, url, setUrl, view, hview, req, index, provOpts } = useApp();
  const ym = url.m;
  const year = ym ? parseYm(ym).y : null;
  const hq = useQuery(hotspotsQuery(url.src, provOpts, ym ? req : null, year));
  const p = ym ? view?.points.find((x) => x.ym === ym) : undefined;
  const hp = ym ? hview?.points.find((x) => x.ym === ym) : undefined;
  const open = !!ym && !!p;
  const bm = baseMode(url.mode);
  const monthRows = hq.data?.rows.filter((r) => r.acq_datetime_utc.startsWith(ym ?? "")) ?? [];
  const first = index?.first_month ?? "";
  const last = index?.last_month ?? "";

  return (
    <Drawer
      open={open}
      onOpenChange={(o) => !o && setUrl({ m: null })}
      title={ym ? capFirst(monthYear(lang, ym)) : ""}
      closeLabel={t(lang, "dr.close")}
    >
      {p && hp && view && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {hp.pct != null && !hp.partial && <StatusChip status={statusOf(hp.pct)} lang={lang} />}
            {hp.partial && <span className="prov">{t(lang, "cal.partial")}</span>}
            <ProvenanceBadge source={hq.data?.source} lang={lang} />
          </div>
          <p className="text-sm" aria-live="polite">
            {monthSummary(lang, p, view.climatology, bm)}
          </p>
          <dl className="tabular grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">{t(lang, "mode.harmonized")}</dt>
            <dd className="text-right font-semibold">{valueWithRange(lang, hp.harmonized, hp.hlow, hp.hhigh, t(lang, "unit.hotspots"))}</dd>
            <dt className="text-muted-foreground">{t(lang, "col.pct")}</dt>
            <dd className="text-right">{num(lang, hp.pct)}</dd>
            <dt className="text-muted-foreground">{t(lang, "col.z")}</dt>
            <dd className="text-right">{num(lang, hp.z, 2)}</dd>
            <dt className="text-muted-foreground">{t(lang, "col.modis")}</dt>
            <dd className="text-right">{num(lang, hp.modis)}</dd>
            <dt className="text-muted-foreground">{t(lang, "col.viirs")}</dt>
            <dd className="text-right">{num(lang, hp.viirs)}</dd>
          </dl>
          <WhyThisMonthSlot ym={ym!} />
          <section aria-labelledby="dr-daily">
            <h3 id="dr-daily" className="mb-1 text-sm font-semibold">
              {t(lang, "dr.daily")}
            </h3>
            {hq.isPending ? (
              <Skeleton className="h-36 w-full" />
            ) : hq.isError ? (
              <p className="text-sm text-muted-foreground">{errorText(lang, hq.error)}</p>
            ) : monthRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t(lang, "dr.no_hotspots")}</p>
            ) : (
              <>
                <DailyBars lang={lang} ym={ym!} rows={monthRows} />
                <p className="mt-1 flex flex-wrap gap-x-4 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2.5 rounded-sm bg-[var(--line-modis)]" aria-hidden="true" />
                    MODIS
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2.5 rounded-sm bg-[var(--line-viirs)]" aria-hidden="true" />
                    VIIRS
                  </span>
                  <span>
                    {num(lang, monthRows.length)} {unitFor(lang, "viirs")}
                  </span>
                </p>
                <p className="mt-1 text-xs text-muted-foreground">{t(lang, "dr.on_map")}</p>
              </>
            )}
          </section>
          <div className="mt-auto flex justify-between gap-2">
            <button
              type="button"
              disabled={!ym || addMonths(ym, -1) < first}
              onClick={() => ym && setUrl({ m: addMonths(ym, -1) })}
              className="inline-flex min-h-11 items-center gap-1 rounded-md border border-input px-3 text-sm hover:bg-accent disabled:opacity-40"
            >
              <ChevronLeft className="size-4" aria-hidden="true" />
              {t(lang, "dr.prev")}
            </button>
            <button
              type="button"
              disabled={!ym || addMonths(ym, 1) > last}
              onClick={() => ym && setUrl({ m: addMonths(ym, 1) })}
              className="inline-flex min-h-11 items-center gap-1 rounded-md border border-input px-3 text-sm hover:bg-accent disabled:opacity-40"
            >
              {t(lang, "dr.next")}
              <ChevronRight className="size-4" aria-hidden="true" />
            </button>
          </div>
        </>
      )}
    </Drawer>
  );
}
