import { useState } from "react";
import { DataTable, ProvenanceBadge } from "@/components/common";
import { useMeasure } from "@/components/hooks";
import { capFirst, monthYear, num, t, type Lang } from "@/i18n";
import { useApp } from "@/state/app";
import { useMl } from "./hooks";
import { featureLabel, featureValue, mt, mtf } from "./i18n";
import type { MlExplain, MlIndex } from "./types";

interface Step {
  key: string;
  label: string;
  value: string;
  from: number;
  to: number;
  kind: "start" | "pos" | "neg" | "other" | "end";
}

/** start -> each shown contribution (multiplicative on the model's log scale) -> other factors -> end. */
export function waterfallSteps(lang: Lang, index: MlIndex | null, e: MlExplain): Step[] {
  const steps: Step[] = [
    { key: "start", label: mt(lang, "wm.start"), value: "", from: 0, to: e.start, kind: "start" },
  ];
  let cur = e.start;
  for (const c of [...e.pos, ...e.neg]) {
    const next = cur * Math.exp(c.contrib);
    steps.push({
      key: c.feature,
      label: featureLabel(lang, index, c.feature),
      value: featureValue(lang, index, c.feature, c.value),
      from: cur,
      to: next,
      kind: c.contrib >= 0 ? "pos" : "neg",
    });
    cur = next;
  }
  if (Math.abs(e.end - cur) > 0.005 * Math.max(1, e.end))
    steps.push({
      key: "other",
      label: mt(lang, "wm.other"),
      value: "",
      from: cur,
      to: e.end,
      kind: "other",
    });
  steps.push({ key: "end", label: mt(lang, "wm.end"), value: "", from: 0, to: e.end, kind: "end" });
  return steps;
}

const COLOR: Record<Step["kind"], string> = {
  start: "var(--status-near)",
  pos: "var(--ember)",
  neg: "var(--status-below)",
  other: "var(--status-near)",
  end: "var(--ember-text)",
};

function Waterfall({ steps, lang, label }: { steps: Step[]; lang: Lang; label: string }) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const w = Math.max(260, width);
  const max = Math.max(1, ...steps.map((s) => Math.max(s.from, s.to))) * 1.08;
  const x = (v: number) => (v / max) * (w - 8);
  const rowH = 40;
  return (
    <div ref={ref} className="w-full">
      <svg width={w} height={steps.length * rowH} role="img" aria-label={label}>
        {steps.map((s, i) => {
          const a = x(Math.min(s.from, s.to));
          const b = x(Math.max(s.from, s.to));
          const y = i * rowH;
          const delta = s.to - s.from;
          const tag =
            s.kind === "start" || s.kind === "end"
              ? num(lang, s.to)
              : `${delta >= 0 ? "+" : "−"}${num(lang, Math.abs(delta), Math.abs(delta) < 10 ? 1 : 0)}`;
          return (
            <g key={s.key + i}>
              <text x={0} y={y + 13} fontSize="12" fill="currentColor">
                {s.kind === "pos" ? "↑ " : s.kind === "neg" ? "↓ " : ""}
                {s.label}
                {s.value && <tspan opacity={0.7}>{`: ${s.value}`}</tspan>}
              </text>
              <rect
                x={a}
                y={y + 18}
                width={Math.max(2, b - a)}
                height={14}
                rx={3}
                fill={COLOR[s.kind]}
                opacity={s.kind === "other" ? 0.5 : 1}
                stroke={s.kind === "end" ? "currentColor" : "none"}
              />
              <text
                x={
                  b + 44 > w
                    ? Math.max(4, (s.kind === "end" || s.kind === "start" ? b - 2 : a) - 4)
                    : b + 4
                }
                y={y + 30}
                fontSize="11"
                fontWeight={
                  b + 44 > w && (s.kind === "end" || s.kind === "start") ? 600 : undefined
                }
                fill={
                  b + 44 > w && (s.kind === "end" || s.kind === "start")
                    ? "var(--background)"
                    : "currentColor"
                }
                textAnchor={b + 44 > w ? "end" : "start"}
                className="tabular"
              >
                {tag}
              </text>
              {i > 0 && i < steps.length - 1 && (
                <line
                  x1={x(s.from)}
                  x2={x(s.from)}
                  y1={y + 4}
                  y2={y + 32}
                  stroke="currentColor"
                  strokeDasharray="2 2"
                  opacity={0.35}
                />
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export default function WhyThisMonth({ ym }: { ym: string }) {
  const ml = useMl();
  const { area, index: dataIndex } = useApp();
  const [asTable, setAsTable] = useState(false);
  const { lang, index, region } = ml;
  if (!ml.ready) return null;
  if (area?.custom) return <p className="text-xs text-muted-foreground">{mt(lang, "wm.custom")}</p>;
  if (!region) return null;
  const e = region.explain[ym];
  const m = region.monthly_ml.find((x) => x.ym === ym);
  if (!e || !m) return <p className="text-xs text-muted-foreground">{mt(lang, "wm.none")}</p>;
  const presetName = (id: unknown) => dataIndex?.presets.find((p) => p.id === id)?.name[lang];
  const named: MlExplain = {
    ...e,
    pos: e.pos.map((c) =>
      c.feature === "region_code" ? { ...c, value: presetName(c.value) ?? c.value } : c,
    ),
    neg: e.neg.map((c) =>
      c.feature === "region_code" ? { ...c, value: presetName(c.value) ?? c.value } : c,
    ),
  };
  const steps = waterfallSteps(lang, index, named);
  const month = capFirst(monthYear(lang, ym));
  const top = (arr: typeof e.pos) =>
    arr[0]
      ? `${featureLabel(lang, index, arr[0].feature)}${arr[0].value != null ? ` (${featureValue(lang, index, arr[0].feature, arr[0].value)})` : ""}`
      : mt(lang, "wm.nothing");
  const sentence = mtf(lang, "wm.sentence", {
    month,
    end: num(lang, e.end),
    up: top(e.pos),
    down: top(e.neg),
  });
  const chartLabel = `${mt(lang, "wm.chart")}. ${steps.map((s) => `${s.label}${s.value ? ` ${s.value}` : ""}: ${num(lang, s.to)}`).join("; ")}`;

  return (
    <details className="rounded-md border p-3" open>
      <summary className="min-h-11 cursor-pointer content-center text-sm font-semibold">
        {mt(lang, "wm.title")}
      </summary>
      <div className="mt-2 space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="tabular font-semibold">
            {mtf(lang, "wm.interval", {
              v: num(lang, m.ml_harmonized),
              lo: num(lang, m.lo90),
              hi: num(lang, m.hi90),
            })}
          </span>
          <span className="prov">≈ {mt(lang, "wm.approx")}</span>
          <ProvenanceBadge source={ml.prov} lang={lang} />
        </div>
        {m.baseline != null && (
          <p className="tabular text-xs text-muted-foreground">
            {mtf(lang, "wm.baseline", { v: num(lang, m.baseline) })}
          </p>
        )}
        <p className="text-sm" aria-live="polite">
          {sentence}
        </p>
        <div className="flex justify-end">
          <button
            type="button"
            className="inline-flex min-h-11 items-center rounded-md border border-input px-3 text-xs font-medium hover:bg-accent"
            aria-pressed={asTable}
            onClick={() => setAsTable((v) => !v)}
          >
            {asTable ? t(lang, "view.chart") : t(lang, "view.table")}
          </button>
        </div>
        {asTable ? (
          <DataTable
            head={[mt(lang, "wm.table_step"), mt(lang, "col.effect"), mt(lang, "wm.table_value")]}
            rows={steps.map((s) => [
              `${s.label}${s.value ? ` (${s.value})` : ""}`,
              s.kind === "start" || s.kind === "end"
                ? ""
                : `${s.to - s.from >= 0 ? "+" : "−"}${num(lang, Math.abs(s.to - s.from), 1)}`,
              num(lang, s.to, 1),
            ])}
            caption={mt(lang, "wm.chart")}
          />
        ) : (
          <Waterfall steps={steps} lang={lang} label={chartLabel} />
        )}
      </div>
    </details>
  );
}
