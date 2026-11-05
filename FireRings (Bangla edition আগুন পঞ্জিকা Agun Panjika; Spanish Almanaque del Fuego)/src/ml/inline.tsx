import { AlertTriangle, X } from "lucide-react";
import { lazy, Suspense, useId, useState, type ReactNode } from "react";
import { ErrorBoundary, ProvenanceBadge, Skeleton } from "@/components/common";
import { t } from "@/i18n";
import { useApp } from "@/state/app";
import { alertForecast, futureForecasts, useMl } from "./hooks";
import { mt } from "./i18n";

/*
 * The always-loaded part of the Intelligence layer: tiny insertion-point
 * components that render nothing until ML data exist, and lazy wrappers for
 * the heavier pieces.
 */

const OutlookDetails = lazy(() => import("./OutlookDetails"));
const WhyThisMonth = lazy(() => import("./WhyThisMonth"));
export const IntelligenceTab = lazy(() => import("./IntelligenceTab"));

function Quiet({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary fallback={null}>
      <Suspense fallback={<Skeleton className="h-24 w-full" />}>{children}</Suspense>
    </ErrorBoundary>
  );
}

const ALERT_KEY = "fr-ml-alerts-dismissed";

function readDismissed(): string[] {
  try {
    return JSON.parse(sessionStorage.getItem(ALERT_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

/** Calm alert above the dashboard: only when FireCast is skilful, P(above) >= 0.5 and "below" is ruled out. */
export function AlertStrip() {
  const ml = useMl();
  const { index, area } = useApp();
  const [dismissed, setDismissed] = useState(readDismissed);
  if (!ml.ready || !area) return null;
  const f = alertForecast(futureForecasts(ml.region, index?.last_month));
  if (!f) return null;
  const key = `${area.id}:${f.ym}`;
  if (dismissed.includes(key)) return null;
  const dismiss = () => {
    const next = [...dismissed, key];
    setDismissed(next);
    try {
      sessionStorage.setItem(ALERT_KEY, JSON.stringify(next));
    } catch {
      /* private mode: remembered for this view only */
    }
  };
  return (
    <div
      role="status"
      className="card flex items-start gap-3 border-l-4 border-l-[var(--status-above)] p-3 sm:p-4"
    >
      <AlertTriangle
        className="mt-0.5 size-5 shrink-0 text-[var(--status-above)]"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
          <span>
            <span aria-hidden="true">▲ </span>
            {mt(ml.lang, "alert.label")}
          </span>
          <ProvenanceBadge source={ml.prov} lang={ml.lang} />
        </p>
        <p className="text-sm">{f.narrative[ml.lang]}</p>
      </div>
      <button
        type="button"
        onClick={dismiss}
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-accent"
        aria-label={mt(ml.lang, "alert.dismiss")}
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}

/** "Details" behind the existing outlook card: FireCast probabilities, sets, drivers, calibration. */
export function MlOutlookToggle() {
  const ml = useMl();
  const { index } = useApp();
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!ml.ready || !ml.region) return null;
  const fs = futureForecasts(ml.region, index?.last_month);
  if (fs.length === 0) return null;
  return (
    <div className="mt-3 border-t pt-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex min-h-11 items-center rounded-md border border-input px-3 text-xs font-medium hover:bg-accent"
      >
        {open
          ? mt(ml.lang, "out.hide")
          : `${mt(ml.lang, "out.title")} · ${mt(ml.lang, "out.details")}`}
      </button>
      <div id={id}>
        {open && (
          <Quiet>
            <OutlookDetails forecasts={fs} />
          </Quiet>
        )}
      </div>
    </div>
  );
}

/** Outlook card for areas whose v1 region file has no `outlook` but FireCast exists. */
export function MlOutlookStandalone() {
  const ml = useMl();
  const { lang, index } = useApp();
  if (!ml.ready || futureForecasts(ml.region, index?.last_month).length === 0) return null;
  return (
    <section className="card p-4" aria-label={t(lang, "out.title")}>
      <h3 className="text-sm font-semibold">{t(lang, "out.title")}</h3>
      <MlOutlookToggle />
    </section>
  );
}

/** "Why this month?" section in the month drawer. */
export function WhyThisMonthSlot({ ym }: { ym: string }) {
  const ml = useMl();
  if (!ml.ready) return null;
  return (
    <Quiet>
      <WhyThisMonth ym={ym} />
    </Quiet>
  );
}
