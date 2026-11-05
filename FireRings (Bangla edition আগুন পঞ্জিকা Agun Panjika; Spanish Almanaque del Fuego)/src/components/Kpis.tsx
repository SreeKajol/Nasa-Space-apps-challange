import { CalendarDays, Flame, Info, Timer } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { isPartialMonth, parseYm, type OutlookPoint } from "@/data/types";
import { criticalMonths, peakMonth, worstYear, yearRows, yearTotals } from "@/data/view";
import { capFirst, dateLong, digits, monthList, monthName, monthYear, num, pctStr, t, tf, valueWithRange } from "@/i18n";
import { onsetSummary } from "@/i18n/summaries";
import { useApp } from "@/state/app";
import { useSettings } from "@/state/settings";
import { cn } from "@/lib/utils";
import { ProvenanceBadge, STATUS_ICON, StatusChip } from "./common";
import { OnsetDrawer } from "./OnsetDrawer";

function Kpi({ label, children, caption, accent, className }: { label: string; children: ReactNode; caption: ReactNode; accent?: boolean; className?: string }) {
  const { lang, region } = useApp();
  const badge = <ProvenanceBadge source={region?.source} lang={lang} savedAt={region?.saved_at} />;
  return (
    <div className={cn("card flex min-w-[15rem] snap-start flex-col gap-1.5 p-4 md:min-w-0", accent && "card-accent", className)}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">{label}</h3>
        {badge}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">{children}</div>
      <p className="text-xs text-muted-foreground">{caption}</p>
    </div>
  );
}

export function KpiRow() {
  const { lang, region, hview, hpoints, index, from, to } = useApp();
  const { simple } = useSettings();
  const [onsetOpen, setOnsetOpen] = useState(false);

  const totals = useMemo(() => yearTotals(yearRows(hpoints, region?.fire_year_start_month ?? 1)), [hpoints, region]);
  if (!region || !hview || !index) return null;

  const c = region.current;
  const { m } = parseYm(c.ym);
  const lastPt = region.monthly[region.monthly.length - 1]!;
  const partial = isPartialMonth(lastPt.ym);
  const crit = criticalMonths(region.climatology, region.fire_year_start_month);
  const worst = worstYear(totals);
  const sum = (f: (p: (typeof hpoints)[number]) => number) => hpoints.filter((p) => !p.partial).reduce((a, p) => a + f(p), 0);
  const total = sum((p) => p.harmonized);
  const o = region.onset;
  const v = region.validation;
  const hot = t(lang, "unit.hotspots");

  if (simple) {
    return (
      <section aria-labelledby="kpi-h" className="grid gap-3 sm:grid-cols-3" id="kpis">
        <h2 id="kpi-h" className="sr-only">
          {t(lang, "kpi.region")}
        </h2>
        <BigCard icon={<Flame className="size-10 text-ember" aria-hidden="true" />} emoji="🔥" title={t(lang, "simple.level")}>
          <StatusChip status={c.status} lang={lang} className="px-3 py-1 text-base" />
          <p className="mt-2 text-sm text-muted-foreground">{capFirst(monthYear(lang, c.ym))}</p>
        </BigCard>
        <BigCard icon={<CalendarDays className="size-10 text-ember" aria-hidden="true" />} emoji="📅" title={t(lang, "simple.months")}>
          <p className="text-3xl font-semibold">{capFirst(monthList(lang, crit.months))}</p>
        </BigCard>
        <BigCard icon={<Timer className="size-10 text-ember" aria-hidden="true" />} emoji="⏱" title={t(lang, "simple.season")}>
          <p className="text-3xl font-semibold">
            {!o
              ? t(lang, "simple.notyet")
              : o.days_diff < 0
                ? tf(lang, "simple.early", { n: digits(lang, -o.days_diff) })
                : o.days_diff > 0
                  ? tf(lang, "simple.late", { n: digits(lang, o.days_diff) })
                  : t(lang, "simple.ontime")}
          </p>
        </BigCard>
      </section>
    );
  }

  return (
    <section aria-labelledby="kpi-h" id="kpis">
      <h2 id="kpi-h" className="sr-only">
        {t(lang, "kpi.region")}
      </h2>
      <div className="-mx-3 flex snap-x gap-3 overflow-x-auto px-3 pb-1 sm:-mx-4 sm:px-4 md:mx-0 md:grid md:grid-cols-2 md:overflow-visible md:px-0 xl:grid-cols-3">
        <Kpi
          label={t(lang, "kpi.month")}
          caption={
            <>
              {tf(lang, "cap.month", { month: capFirst(monthYear(lang, c.ym)), pct: num(lang, c.percentile), median: num(lang, c.median) })}
              {partial && <> {tf(lang, "cap.month_partial", { month: monthName(lang, parseYm(lastPt.ym).m), value: num(lang, lastPt.harmonized) })}</>}
            </>
          }
        >
          <span className="tabular text-3xl font-semibold">{num(lang, c.value)}</span>
          <span className="tabular text-sm text-muted-foreground">
            {hot} ({num(lang, c.low)}–{num(lang, c.high)})
          </span>
          <StatusChip status={c.status} lang={lang} />
        </Kpi>

        <Kpi
          label={t(lang, "kpi.onset")}
          caption={
            <button type="button" onClick={() => setOnsetOpen(true)} className="inline-flex min-h-11 items-center gap-1 text-left font-medium text-foreground underline underline-offset-2">
              <Info className="size-3.5 shrink-0" aria-hidden="true" />
              {o ? tf(lang, "cap.onset_dates", { season: digits(lang, o.season), date: dateLong(lang, o.onset_date), typical: dateLong(lang, o.typical_onset_date) }) : t(lang, "kpi.onset_more")}
            </button>
          }
        >
          <span className="text-xl font-semibold">
            {!o
              ? t(lang, "simple.notyet")
              : o.days_diff < 0
                ? tf(lang, "cap.onset_early", { n: digits(lang, -o.days_diff) })
                : o.days_diff > 0
                  ? tf(lang, "cap.onset_late", { n: digits(lang, o.days_diff) })
                  : t(lang, "cap.onset_ontime")}
          </span>
          <span className="sr-only">{onsetSummary(lang, region)}</span>
        </Kpi>

        <Kpi label={t(lang, "kpi.peak")} caption={tf(lang, "cap.peak", { months: monthList(lang, crit.months), share: pctStr(lang, crit.share) })}>
          <span className="text-3xl font-semibold">{capFirst(monthName(lang, peakMonth(region.climatology)))}</span>
        </Kpi>

        <Kpi label={t(lang, "kpi.worst")} caption={worst?.total ? tf(lang, "cap.worst", { total: num(lang, worst.total) }) : t(lang, "cap.none")}>
          <span className="tabular text-3xl font-semibold">{worst ? digits(lang, worst.label) : "—"}</span>
        </Kpi>

        <Kpi label={t(lang, "kpi.total")} caption={tf(lang, "cap.total", { n: digits(lang, hpoints.filter((p) => !p.partial).length), from: monthYear(lang, from, true), to: monthYear(lang, to, true) })}>
          <span className="tabular text-3xl font-semibold">{num(lang, total)}</span>
          <span className="tabular text-sm text-muted-foreground">
            ({num(lang, sum((p) => p.hlow))}–{num(lang, sum((p) => p.hhigh))}){region.approximate ? ` · ${t(lang, "area.approx")}` : ""}
          </span>
        </Kpi>

        <Kpi accent label={t(lang, "kpi.evidence")} caption={v ? tf(lang, "cap.evidence_expl", { overlap: v.overlap.replace("/", "–") }) : t(lang, "cap.evidence_none")}>
          {v ? (
            <p className="tabular text-xl font-semibold" aria-label={tf(lang, "cap.evidence", { raw: num(lang, v.corr_raw, 2), harm: num(lang, v.corr_harmonized, 2) })}>
              <span className="text-muted-foreground">{num(lang, v.corr_raw, 2)}</span>
              <span aria-hidden="true" className="mx-1.5 text-ember-text">
                →
              </span>
              <span className="text-3xl text-ember-text">{num(lang, v.corr_harmonized, 2)}</span>
              <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                {t(lang, "m.raw")} → {t(lang, "m.harm")} (r)
              </span>
            </p>
          ) : (
            <span className="text-xl font-semibold">—</span>
          )}
        </Kpi>
      </div>
      <OnsetDrawer open={onsetOpen} onOpenChange={setOnsetOpen} />
    </section>
  );
}

function BigCard({ icon, emoji, title, children }: { icon: ReactNode; emoji: string; title: string; children: ReactNode }) {
  return (
    <div className="card flex flex-col items-start gap-3 p-5">
      <div className="flex items-center gap-3">
        {icon}
        <span className="sr-only">{emoji}</span>
        <h3 className="text-xl font-semibold">{title}</h3>
      </div>
      {children}
    </div>
  );
}

/** "Next 3 months" — only months whose skill beats climatology, each with its badge. */
export function OutlookCard() {
  const { lang, region } = useApp();
  const out = region?.outlook;
  if (!region || !out || out.length === 0) return null;
  const skilful = out.filter((o) => o.rpss > 0);
  return (
    <section className="card p-4" aria-labelledby="outlook-h">
      <h3 id="outlook-h" className="mb-2 text-sm font-semibold">
        {t(lang, "out.title")}
      </h3>
      {skilful.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t(lang, "out.none")}</p>
      ) : (
        <ul className="space-y-2.5">
          {skilful.map((o) => (
            <OutlookRow key={o.ym} o={o} />
          ))}
        </ul>
      )}
    </section>
  );
}

function OutlookRow({ o }: { o: OutlookPoint }) {
  const { lang } = useApp();
  const seg = [
    { k: "below" as const, v: o.p_below, cls: "bg-[var(--status-below)]" },
    { k: "near" as const, v: o.p_near, cls: "bg-[var(--status-near)]" },
    { k: "above" as const, v: o.p_above, cls: "bg-[var(--status-extreme)]" },
  ];
  const text = tf(lang, "out.bar", { month: capFirst(monthYear(lang, o.ym)), b: pctStr(lang, o.p_below), n: pctStr(lang, o.p_near), a: pctStr(lang, o.p_above) });
  return (
    <li>
      <div className="mb-1 flex min-w-0 flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-medium">{capFirst(monthYear(lang, o.ym))}</span>
        <span className="chip chip-below whitespace-normal" title={tf(lang, "out.rpss", { v: num(lang, o.rpss, 2) })}>
          ✓ {t(lang, "out.skill")} · RPSS {num(lang, o.rpss, 2)}
        </span>
      </div>
      <div className="flex h-5 overflow-hidden rounded-sm" role="img" aria-label={text}>
        {seg.map((s) => (
          <div key={s.k} className={cn("flex items-center justify-center text-[10px] font-semibold text-[var(--background)]", s.cls)} style={{ width: `${s.v * 100}%` }}>
            {s.v >= 0.15 ? `${STATUS_ICON[s.k]} ${pctStr(lang, s.v)}` : ""}
          </div>
        ))}
      </div>
    </li>
  );
}
