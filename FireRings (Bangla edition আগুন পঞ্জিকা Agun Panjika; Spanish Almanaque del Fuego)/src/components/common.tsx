import { AlertTriangle, RotateCcw } from "lucide-react";
import { Component, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { DataError, type Provenance, type Status } from "@/data/types";
import { t, tf, type Lang, type StrKey } from "@/i18n";
import { cn } from "@/lib/utils";
import { useApp } from "@/state/app";

export const STATUS_ICON: Record<Status, string> = { below: "▼", near: "●", above: "▲", extreme: "⚠" };

/** Status is never by colour alone: icon + word, colour only reinforces. */
export function StatusChip({ status, lang, className }: { status: Status; lang: Lang; className?: string }) {
  return (
    <span className={cn("chip", `chip-${status}`, className)}>
      <span aria-hidden="true">{STATUS_ICON[status]}</span>
      {t(lang, `status.${status}`)}
    </span>
  );
}

const PROV_ICON: Record<Provenance, string> = { live: "◉", cache: "◍", demo: "○" };

export function ProvenanceBadge({ source, lang, savedAt }: { source: Provenance | undefined; lang: Lang; savedAt?: string | undefined }) {
  if (!source) return null;
  const tip = t(lang, `prov.tip.${source}`) + (savedAt ? ` (${savedAt.slice(0, 10)})` : "");
  return (
    <span className={cn("prov", source === "demo" && "prov-demo")} title={tip}>
      <span aria-hidden="true">{PROV_ICON[source]}</span>
      <span className="sr-only">{t(lang, "ctrl.src")}: </span>
      {t(lang, `prov.${source}`)}
    </span>
  );
}

export interface SegOption<T extends string> {
  id: T;
  label: ReactNode;
  title?: string;
}

/** Accessible segmented control (toggle buttons in a labelled group). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: SegOption<T>[];
  value: T;
  onChange(v: T): void;
  label: string;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn("seg", className)}>
      {options.map((o) => (
        <button key={o.id} type="button" aria-pressed={value === o.id} title={o.title} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Card({
  title,
  right,
  children,
  className,
  accent,
  id,
  as: As = "section",
}: {
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  accent?: boolean;
  id?: string;
  as?: "section" | "div";
}) {
  const hid = useId();
  return (
    <As className={cn("card p-4 sm:p-5", accent && "card-accent", className)} aria-labelledby={title ? hid : undefined} id={id}>
      {(title || right) && (
        <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && (
            <h2 id={hid} className="text-base font-semibold">
              {title}
            </h2>
          )}
          {right}
        </header>
      )}
      {children}
    </As>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton", className)} aria-hidden="true" />;
}

export function errorText(lang: Lang, e: unknown): string {
  if (e instanceof DataError) {
    if (e.code === "missing") return tf(lang, "err.missing", { file: e.message.replace(/^missing: /, "") });
    const key = `err.${e.code}` as StrKey;
    return t(lang, key);
  }
  return t(lang, "err.load");
}

export function ErrorState({ lang, error, onRetry }: { lang: Lang; error: unknown; onRetry?: () => void }) {
  return (
    <div role="alert" className="card flex flex-col items-start gap-3 border-destructive/40 p-5">
      <p className="flex items-start gap-2 text-sm">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
        <span>{errorText(lang, error)}</span>
      </p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="inline-flex min-h-11 items-center gap-2 rounded-md border border-input px-4 text-sm font-medium hover:bg-accent">
          <RotateCcw className="size-4" aria-hidden="true" />
          {t(lang, "err.retry")}
        </button>
      )}
    </div>
  );
}

/** "View as table" content: a plain, fully readable table. */
export function DataTable({ head, rows, caption }: { head: string[]; rows: (string | number | null)[][]; caption: string }) {
  return (
    <div className="max-h-[28rem] overflow-auto rounded-md border" tabIndex={0} role="region" aria-label={caption}>
      <table className="tabular w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 z-10 bg-card">
          <tr>
            {head.map((h, i) => (
              <th key={i} scope="col" className={cn("border-b px-3 py-2 font-medium whitespace-nowrap text-muted-foreground", i === 0 ? "text-left" : "text-right")}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="border-b border-border/60 last:border-0">
              {r.map((c, ci) =>
                ci === 0 ? (
                  <th key={ci} scope="row" className="px-3 py-1.5 text-left font-normal whitespace-nowrap">
                    {c ?? "—"}
                  </th>
                ) : (
                  <td key={ci} className="px-3 py-1.5 text-right whitespace-nowrap">
                    {c ?? "—"}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Every chart lives in a ChartCard: one-line plain-language summary on top
 * (also an aria-live region), the chart, and a "View as table" toggle.
 */
export function ChartCard({
  title,
  summary,
  lang,
  table,
  actions,
  footer,
  children,
  id,
  className,
}: {
  title: string;
  summary: string;
  lang: Lang;
  table: { head: string[]; rows: (string | number | null)[][] };
  actions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  id?: string;
  className?: string;
}) {
  const [asTable, setAsTable] = useState(false);
  const hid = useId();
  const { region } = useApp();
  return (
    <section className={cn("card p-4 sm:p-5", className)} aria-labelledby={hid} id={id}>
      <header className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 id={hid} className="text-base font-semibold">
            {title}
          </h2>
          <ProvenanceBadge source={region?.source} lang={lang} savedAt={region?.saved_at} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          <button
            type="button"
            className="inline-flex min-h-11 items-center rounded-md border border-input px-3 text-xs font-medium hover:bg-accent"
            aria-pressed={asTable}
            onClick={() => setAsTable((v) => !v)}
          >
            {asTable ? t(lang, "view.chart") : t(lang, "view.table")}
          </button>
        </div>
      </header>
      <p aria-live="polite" className="mb-3 max-w-prose text-sm text-muted-foreground">
        {summary}
      </p>
      {asTable ? <DataTable head={table.head} rows={table.rows} caption={`${title}. ${summary}`} /> : <div className="fade-in">{children}</div>}
      {footer}
    </section>
  );
}

/** Keeps one failing panel (e.g. the map) from blanking the whole app. */
export class ErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { error: unknown }> {
  override state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  override componentDidCatch(error: unknown) {
    console.error(error);
  }
  override render() {
    return this.state.error ? this.props.fallback : this.props.children;
  }
}

/**
 * Renders children only once the placeholder nears the viewport, so heavy
 * below-the-fold panels (the hotspot table) don't delay the first paint.
 * The placeholder keeps the final height to avoid layout shift.
 */
export function WhenVisible({ children, minHeight }: { children: ReactNode; minHeight: string }) {
  const [shown, setShown] = useState(typeof IntersectionObserver === "undefined");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (shown || !ref.current) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setShown(true), { rootMargin: "300px" });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [shown]);
  return shown ? <>{children}</> : <div ref={ref} style={{ minHeight }} aria-hidden="true" />;
}
