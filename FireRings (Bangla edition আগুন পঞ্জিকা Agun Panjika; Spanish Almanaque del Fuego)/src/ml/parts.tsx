import { useId, useState, type ReactNode } from "react";
import { DataTable, ProvenanceBadge } from "@/components/common";
import { useMeasure } from "@/components/hooks";
import type { Provenance } from "@/data/types";
import { num, t, type Lang } from "@/i18n";
import { cn } from "@/lib/utils";
import { mt, mtf, pct, signed } from "./i18n";
import type { Cls, MlForecast, MlReliability } from "./types";

/*
 * Shared building blocks of the Intelligence layer (lazy chunks only).
 * Same pattern as ChartCard: one-line aria-live summary, the chart, and a
 * "View as table" toggle; the provenance badge is the ML layer's own.
 */

export function MlCard({
  title,
  summary,
  lang,
  prov,
  table,
  children,
  actions,
  footer,
  accent,
  className,
}: {
  title: string;
  summary: string;
  lang: Lang;
  prov: Provenance;
  table?: { head: string[]; rows: (string | number | null)[][] };
  children: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  accent?: boolean;
  className?: string;
}) {
  const [asTable, setAsTable] = useState(false);
  const hid = useId();
  return (
    <section
      className={cn("card p-4 sm:p-5", accent && "card-accent", className)}
      aria-labelledby={hid}
    >
      <header className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 id={hid} className="text-base font-semibold">
            {title}
          </h2>
          <ProvenanceBadge source={prov} lang={lang} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          {table && (
            <button
              type="button"
              className="inline-flex min-h-11 items-center rounded-md border border-input px-3 text-xs font-medium hover:bg-accent"
              aria-pressed={asTable}
              onClick={() => setAsTable((v) => !v)}
            >
              {asTable ? t(lang, "view.chart") : t(lang, "view.table")}
            </button>
          )}
        </div>
      </header>
      <p aria-live="polite" className="mb-3 max-w-prose text-sm text-muted-foreground">
        {summary}
      </p>
      {asTable && table ? (
        <DataTable head={table.head} rows={table.rows} caption={`${title}. ${summary}`} />
      ) : (
        <div className="fade-in">{children}</div>
      )}
      {footer}
    </section>
  );
}

const CLS: Cls[] = ["below", "near", "above"];
const CLS_ICON: Record<Cls, string> = { below: "▼", near: "●", above: "▲" };
const CLS_VAR: Record<Cls, string> = {
  below: "var(--status-below)",
  near: "var(--status-near)",
  above: "var(--status-extreme)",
};

export function setText(lang: Lang, set: Cls[]): string {
  return set.map((s) => mt(lang, `out.set.${s}`)).join(mt(lang, "or"));
}

/** Stacked below / near / above bar; icon + word on each segment, never colour alone. */
export function StackedProb({
  p,
  lang,
  label,
}: {
  p: [number, number, number];
  lang: Lang;
  label: string;
}) {
  return (
    <div className="flex h-7 overflow-hidden rounded-md" role="img" aria-label={label}>
      {CLS.map((c, k) => (
        <div
          key={c}
          className="flex min-w-0 items-center justify-center text-[11px] font-semibold text-[var(--background)]"
          style={{ width: `${p[k]! * 100}%`, background: CLS_VAR[c] }}
        >
          {p[k]! >= 0.16
            ? `${CLS_ICON[c]} ${mt(lang, `out.cat.${c}`)} ${pct(lang, p[k]!)}`
            : p[k]! >= 0.08
              ? CLS_ICON[c]
              : ""}
        </div>
      ))}
    </div>
  );
}

export function SetChips({ set, lang }: { set: Cls[]; lang: Lang }) {
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">
        {mtf(lang, "out.likely", { set: "" }).replace(/[:：]\s*$/, ":")}
      </span>
      {set.map((s) => (
        <span key={s} className={cn("chip", s === "above" ? "chip-extreme" : `chip-${s}`)}>
          <span aria-hidden="true">{CLS_ICON[s]}</span>
          {mt(lang, `out.set.${s}`)}
        </span>
      ))}
    </p>
  );
}

export function SkillBadge({ f, lang }: { f: MlForecast; lang: Lang }) {
  if (!f.skilful)
    return <span className="chip chip-near whitespace-normal">● {mt(lang, "out.none")}</span>;
  return (
    <span className="chip chip-below whitespace-normal">
      <span aria-hidden="true">✓</span> {mtf(lang, "out.skilful", { v: num(lang, f.rpss ?? 0, 2) })}
    </span>
  );
}

/** Predicted vs observed frequency of "above normal", with the perfect-calibration diagonal. */
export function ReliabilityChart({ rows: all, lang }: { rows: MlReliability[]; lang: Lang }) {
  // Bins with very few hindcasts are noise; draw only those with at least 20.
  const rows = all.filter((r) => r.n >= 20);
  const [ref, width] = useMeasure<HTMLDivElement>();
  const w = Math.min(360, Math.max(220, width));
  const h = 200;
  const m = { l: 40, r: 10, t: 10, b: 34 };
  const x = (v: number) => m.l + v * (w - m.l - m.r);
  const y = (v: number) => h - m.b - v * (h - m.t - m.b);
  const maxN = Math.max(1, ...rows.map((r) => r.n));
  const label = rows
    .map((r) => `${pct(lang, r.predicted ?? r.bin)} → ${pct(lang, r.observed)}`)
    .join("; ");
  return (
    <div ref={ref} className="w-full">
      <svg
        width={w}
        height={h}
        role="img"
        aria-label={`${mt(lang, "out.calib")} ${label}`}
        className="overflow-visible"
      >
        {[0, 0.5, 1].map((v) => (
          <g key={v}>
            <line x1={x(0)} x2={x(1)} y1={y(v)} y2={y(v)} stroke="var(--border)" />
            <text
              x={m.l - 6}
              y={y(v) + 4}
              textAnchor="end"
              fontSize="10"
              fill="currentColor"
              opacity={0.7}
            >
              {pct(lang, v)}
            </text>
            <text
              x={x(v)}
              y={h - m.b + 14}
              textAnchor="middle"
              fontSize="10"
              fill="currentColor"
              opacity={0.7}
            >
              {pct(lang, v)}
            </text>
          </g>
        ))}
        <line
          x1={x(0)}
          y1={y(0)}
          x2={x(1)}
          y2={y(1)}
          stroke="currentColor"
          strokeDasharray="4 4"
          opacity={0.5}
        />
        <polyline
          fill="none"
          stroke="var(--ember)"
          strokeWidth={2}
          points={rows.map((r) => `${x(r.predicted ?? r.bin)},${y(r.observed)}`).join(" ")}
        />
        {rows.map((r) => (
          <circle
            key={r.bin}
            cx={x(r.predicted ?? r.bin)}
            cy={y(r.observed)}
            r={3 + 4 * Math.sqrt(r.n / maxN)}
            fill="var(--ember)"
            stroke="var(--card)"
          />
        ))}
        <text x={(x(0) + x(1)) / 2} y={h - 4} textAnchor="middle" fontSize="11" fill="currentColor">
          {mt(lang, "out.rel_x")}
        </text>
      </svg>
      <p className="text-xs text-muted-foreground">↑ {mt(lang, "out.rel_y")}</p>
    </div>
  );
}

export { signed };
