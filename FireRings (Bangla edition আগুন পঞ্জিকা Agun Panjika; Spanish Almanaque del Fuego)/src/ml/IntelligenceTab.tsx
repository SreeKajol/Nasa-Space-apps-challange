import { AlertTriangle, ShieldAlert } from "lucide-react";
import { useId, useState } from "react";
import { useMeasure } from "@/components/hooks";
import { capFirst, digits, monthYear, num, type Lang } from "@/i18n";
import { cn } from "@/lib/utils";
import { useApp } from "@/state/app";
import { useSettings } from "@/state/settings";
import { useMl, type MlState } from "./hooks";
import { effectPct, mt, mtf, pct, signed } from "./i18n";
import { MlCard } from "./parts";
import "./ml.css";
import type { MlDependenceRow, MlGroupCoverage, MlIndex, MlTrend } from "./types";

/** The "Intelligence" tab: uncertainty, drivers, benchmark, model card and the raw-vs-harmonized demo. */
export default function IntelligenceTab() {
  const ml = useMl();
  if (!ml.ready || !ml.index) return null;
  const { lang, index } = ml;
  return (
    <div className="space-y-4" id="intelligence">
      <p className="max-w-prose text-sm text-muted-foreground">{mt(lang, "intro")}</p>
      {ml.flavour !== "live" && (
        <p className="rounded-md border border-dashed px-3 py-2 text-sm" role="note">
          {mt(lang, ml.flavour === "mock" ? "demo_mock" : "demo_computed")}
        </p>
      )}
      <HowSure ml={ml} index={index} />
      <DemoMoment ml={ml} index={index} />
      <WhyDisagree ml={ml} index={index} />
      <Benchmark ml={ml} index={index} />
      <ModelCard ml={ml} index={index} />
    </div>
  );
}

type P = { ml: MlState; index: MlIndex };

/* ---------------------------------------------------------------- a) How sure are we? */

const KIND_ORDER = ["landcover", "country", "activity"];

function HowSure({ ml, index }: P) {
  const { lang } = ml;
  const c = index.models.harmonization.conformal;
  const groups = [...c.by_group].sort(
    (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
  );
  const flagged = groups.filter((g) => g.flag);
  const min = Math.min(...groups.map((g) => g.coverage));
  const test = digits(lang, index.splits?.test ?? "");
  const summary = flagged.length
    ? mtf(lang, "sure.summary_flag", {
        n: num(lang, flagged.length),
        total: num(lang, groups.length),
        groups: flagged.map((g) => g.label[lang]).join(", "),
      })
    : mtf(lang, "sure.summary_ok", { min: pct(lang, min), target: pct(lang, c.target) });
  return (
    <MlCard
      title={mt(lang, "sure.title")}
      summary={summary}
      lang={lang}
      prov={ml.prov}
      accent
      table={{
        head: [
          mt(lang, "col.group"),
          mt(lang, "col.coverage"),
          mt(lang, "col.n"),
          mt(lang, "col.width"),
        ],
        rows: groups.map((g) => [
          `${mt(lang, `sure.kind.${g.kind}` as "sure.kind.landcover")}: ${g.label[lang]}${g.flag ? ` ⚠ ${mt(lang, "sure.flag")}` : ""}`,
          pct(lang, g.coverage),
          num(lang, g.n),
          num(lang, g.mean_width, 2),
        ]),
      }}
    >
      <div className="mb-4 space-y-1">
        <p className="text-2xl font-semibold sm:text-3xl">
          <span className="text-ember-text">{pct(lang, c.coverage_test)}</span>
        </p>
        <p className="text-base font-medium">
          {mtf(lang, "sure.big", { cov: pct(lang, c.coverage_test) })}
        </p>
        <p className="text-sm">
          {mtf(lang, "sure.explain", { n: num(lang, Math.round(c.coverage_test * 10)) })}
        </p>
        <p className="text-xs text-muted-foreground">{mtf(lang, "sure.years", { years: test })}</p>
      </div>
      <h3 className="mb-1 text-sm font-semibold">{mt(lang, "sure.chart")}</h3>
      <CoverageDots groups={groups} lang={lang} target={c.target} />
      {c.region_coverage_test != null && (
        <p className="mt-3 text-xs text-muted-foreground">
          {mtf(lang, "sure.region", {
            cov: pct(lang, c.region_coverage_test),
            n: num(lang, c.region_n_cal ?? 0),
          })}
        </p>
      )}
    </MlCard>
  );
}

function CoverageDots({
  groups,
  lang,
  target,
}: {
  groups: MlGroupCoverage[];
  lang: Lang;
  target: number;
}) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const w = Math.max(280, width);
  const labelW = Math.min(210, w * 0.42);
  const lo = Math.min(
    0.75,
    Math.floor((Math.min(...groups.map((g) => g.coverage)) - 0.03) * 20) / 20,
  );
  const x = (v: number) => labelW + ((v - lo) / (1 - lo)) * (w - labelW - 16);
  const rowH = 30;
  let kind = "";
  const rows: ({ head: string } | { g: MlGroupCoverage })[] = [];
  for (const g of groups) {
    if (g.kind !== kind) {
      kind = g.kind;
      rows.push({ head: mt(lang, `sure.kind.${g.kind}` as "sure.kind.landcover") });
    }
    rows.push({ g });
  }
  const h = rows.length * rowH + 26;
  const ticks = [lo, (lo + 1) / 2, 1].map((v) => Math.round(v * 100) / 100);
  return (
    <div ref={ref} className="w-full">
      <svg
        width={w}
        height={h}
        role="img"
        aria-label={groups
          .map(
            (g) =>
              `${g.label[lang]} ${pct(lang, g.coverage)}${g.flag ? ` ⚠ ${mt(lang, "sure.flag")}` : ""}`,
          )
          .join("; ")}
      >
        <line
          x1={x(target)}
          x2={x(target)}
          y1={0}
          y2={h - 22}
          stroke="var(--ember)"
          strokeWidth={2}
        />
        <text x={x(target)} y={h - 8} textAnchor="middle" fontSize="10" fill="var(--ember-text)">
          {mt(lang, "sure.target")}
        </text>
        <line
          x1={x(0.85)}
          x2={x(0.85)}
          y1={0}
          y2={h - 22}
          stroke="currentColor"
          strokeDasharray="3 3"
          opacity={0.5}
        />
        <text
          x={x(0.85)}
          y={h - 8}
          textAnchor="end"
          fontSize="10"
          fill="currentColor"
          opacity={0.75}
        >
          {mt(lang, "sure.floor")}
        </text>
        {ticks.map((v) => (
          <text
            key={v}
            x={x(v)}
            y={10}
            textAnchor="middle"
            fontSize="10"
            fill="currentColor"
            opacity={0.6}
          >
            {pct(lang, v)}
          </text>
        ))}
        {rows.map((r, i) => {
          const y = 18 + i * rowH;
          if ("head" in r)
            return (
              <text
                key={`h${i}`}
                x={0}
                y={y + 18}
                fontSize="11"
                fontWeight={600}
                fill="currentColor"
                opacity={0.8}
              >
                {r.head}
              </text>
            );
          const g = r.g;
          return (
            <g key={`${g.kind}:${g.group}`}>
              <line x1={labelW} x2={w - 16} y1={y + 14} y2={y + 14} stroke="var(--border)" />
              <text x={8} y={y + 18} fontSize="12" fill="currentColor">
                {g.flag ? "⚠ " : ""}
                {g.label[lang].length > 28 ? `${g.label[lang].slice(0, 27)}…` : g.label[lang]}
              </text>
              <line
                x1={x(Math.min(g.coverage, target))}
                x2={x(Math.max(g.coverage, target))}
                y1={y + 14}
                y2={y + 14}
                stroke={g.flag ? "var(--status-extreme)" : "var(--status-near)"}
                strokeWidth={2}
              />
              <circle
                cx={x(g.coverage)}
                cy={y + 14}
                r={6}
                fill={g.flag ? "var(--status-extreme)" : "var(--status-below)"}
                stroke="var(--card)"
                strokeWidth={1.5}
              />
              <text
                x={Math.min(x(g.coverage) + 10, w - 2)}
                y={y + 9}
                fontSize="10"
                fill="currentColor"
                textAnchor={x(g.coverage) + 40 > w ? "end" : "start"}
                className="tabular"
              >
                {pct(lang, g.coverage)}
              </text>
            </g>
          );
        })}
      </svg>
      {groups.some((g) => g.flag) && (
        <p className="mt-1 flex items-center gap-1.5 text-xs">
          <AlertTriangle className="size-3.5 text-[var(--status-extreme)]" aria-hidden="true" />⚠ ={" "}
          {mt(lang, "sure.flag")}
        </p>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- demo moment */

function DemoMoment({ ml, index }: P) {
  const { lang } = ml;
  const { area } = useApp();
  const raw = index.raw_trained_trend;
  const harm = index.harmonized_trained_trend;
  const ids = raw && harm ? Object.keys(raw).filter((k) => harm[k]) : [];
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState<string | null>(null);
  const pid = useId();
  const { index: dataIndex } = useApp();
  if (ids.length === 0) return null;
  const id = pick ?? (area && ids.includes(area.id) ? area.id : ids[0]!);
  const vs = index.inputs.viirs_start;
  const vy = Number(vs.slice(0, 4));
  const r = raw![id]!;
  const h = harm![id]!;
  const name = (rid: string) => dataIndex?.presets.find((p) => p.id === rid)?.name[lang] ?? rid;
  const jr = r.jump_ratio ?? ratio(r, vy);
  const jh = h.jump_ratio ?? ratio(h, vy);
  return (
    <section className="card card-accent p-4 sm:p-5" aria-labelledby={`${pid}-h`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${pid}-h`} className="text-base font-semibold">
          {mt(lang, "demo.title")}
        </h2>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={pid}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {open ? mt(lang, "demo.hide") : mt(lang, "demo.button")}
        </button>
      </div>
      <div id={pid}>
        {open && (
          <div className="mt-3 space-y-3 fade-in">
            <p className="text-xl leading-snug font-semibold">{mt(lang, "demo.caption")}</p>
            {ids.length > 1 && (
              <label className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">{mt(lang, "demo.area")}</span>
                <select
                  className="field min-h-11"
                  value={id}
                  onChange={(e) => setPick(e.target.value)}
                >
                  {ids.map((k) => (
                    <option key={k} value={k}>
                      {name(k)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <TrendCard ml={ml} raw={r} harm={h} vy={vy} vs={vs} jr={jr} jh={jh} />
          </div>
        )}
      </div>
    </section>
  );
}

function ratio(tr: MlTrend, vy: number): number {
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const b = tr.values.filter((_, i) => tr.years[i]! < vy);
  const a = tr.values.filter((_, i) => tr.years[i]! >= vy);
  return mean(a) / Math.max(1e-9, mean(b));
}

function normalised(tr: MlTrend, vy: number): number[] {
  const before = tr.values.filter((_, i) => tr.years[i]! < vy);
  const base = before.length
    ? before.reduce((a, b) => a + b, 0) / before.length
    : tr.values[0] || 1;
  return tr.values.map((v) => v / (base || 1));
}

function TrendCard({
  ml,
  raw,
  harm,
  vy,
  vs,
  jr,
  jh,
}: {
  ml: MlState;
  raw: MlTrend;
  harm: MlTrend;
  vy: number;
  vs: string;
  jr: number;
  jh: number;
}) {
  const { lang } = ml;
  const { reducedMotion } = useSettings();
  const [ref, width] = useMeasure<HTMLDivElement>();
  const w = Math.max(280, width);
  const hgt = 220;
  const m = { l: 36, r: 12, t: 14, b: 28 };
  const nr = normalised(raw, vy);
  const nh = normalised(harm, vy);
  const years = raw.years;
  const y0 = Math.min(...years);
  const y1 = Math.max(...years);
  const top = Math.max(1.2, ...nr, ...nh) * 1.08;
  const x = (yr: number) => m.l + ((yr - y0) / Math.max(1, y1 - y0)) * (w - m.l - m.r);
  const y = (v: number) => hgt - m.b - (v / top) * (hgt - m.t - m.b);
  const path = (vals: number[], ys: number[]) =>
    vals.map((v, i) => `${i ? "L" : "M"}${x(ys[i]!)},${y(v)}`).join("");
  const summary = mtf(lang, "demo.summary", {
    raw: num(lang, jr, 1),
    harm: num(lang, jh, 2),
    vs: capFirst(monthYear(lang, vs)),
  });
  const ticks = [0, 1, Math.round(top)].filter((v, i, a) => a.indexOf(v) === i);
  return (
    <MlCard
      title={mt(lang, "demo.axis")}
      summary={summary}
      lang={lang}
      prov={ml.prov}
      table={{
        head: [mt(lang, "col.year"), mt(lang, "demo.raw"), mt(lang, "demo.harm")],
        rows: years.map((yr, i) => [
          digits(lang, yr),
          num(lang, nr[i]!, 2),
          num(lang, nh[i] ?? NaN, 2),
        ]),
      }}
    >
      <div ref={ref} className="w-full">
        <svg width={w} height={hgt} role="img" aria-label={summary}>
          {ticks.map((v) => (
            <g key={v}>
              <line x1={m.l} x2={w - m.r} y1={y(v)} y2={y(v)} stroke="var(--border)" />
              <text
                x={m.l - 6}
                y={y(v) + 4}
                textAnchor="end"
                fontSize="10"
                fill="currentColor"
                opacity={0.7}
              >
                ×{num(lang, v)}
              </text>
            </g>
          ))}
          {[y0, vy, y1].map((yr) => (
            <text
              key={yr}
              x={x(yr)}
              y={hgt - 8}
              textAnchor="middle"
              fontSize="10"
              fill="currentColor"
              opacity={0.7}
            >
              {digits(lang, yr)}
            </text>
          ))}
          <line
            x1={x(vy - 0.5)}
            x2={x(vy - 0.5)}
            y1={m.t}
            y2={hgt - m.b}
            stroke="currentColor"
            strokeDasharray="4 3"
            opacity={0.6}
          />
          <text x={x(vy - 0.5) + 4} y={m.t + 10} fontSize="10" fill="currentColor">
            {mtf(lang, "demo.marker", { date: capFirst(monthYear(lang, vs, true)) })}
          </text>
          <path
            d={path(nr, years)}
            fill="none"
            stroke="var(--status-extreme)"
            strokeWidth={2.5}
            className={cn(!reducedMotion && "fr-draw")}
            pathLength={1}
          />
          <path
            d={path(nh, harm.years)}
            fill="none"
            stroke="var(--line-modis)"
            strokeWidth={2.5}
            className={cn(!reducedMotion && "fr-draw")}
            pathLength={1}
          />
        </svg>
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm">
        <li className="flex items-center gap-2">
          <span className="h-1 w-6 rounded bg-[var(--status-extreme)]" aria-hidden="true" />
          {mt(lang, "demo.raw")} ·{" "}
          <strong className="tabular">{mtf(lang, "demo.jump", { x: num(lang, jr, 1) })}</strong>
        </li>
        <li className="flex items-center gap-2">
          <span className="h-1 w-6 rounded bg-[var(--line-modis)]" aria-hidden="true" />
          {mt(lang, "demo.harm")} ·{" "}
          <strong className="tabular">{mtf(lang, "demo.jump", { x: num(lang, jh, 2) })}</strong>
        </li>
      </ul>
    </MlCard>
  );
}

/* ---------------------------------------------------------------- b) Why the sensors disagree */

function WhyDisagree({ ml, index }: P) {
  const { lang } = ml;
  const drivers = index.global_drivers.harmonization.slice(0, 10);
  if (drivers.length === 0) return null;
  const top = drivers[0]!;
  const summary = mtf(lang, "why.summary", {
    top: top.label[lang],
    pct: pct(lang, Math.exp(top.mean_abs_shap) - 1),
  });
  const deps = (["frp_mean", "scan_mean", "landcover"] as const)
    .filter((k) => (index.dependence[k] ?? []).length > 1)
    .slice(0, 2);
  return (
    <>
      <MlCard
        title={mt(lang, "why.title")}
        summary={summary}
        lang={lang}
        prov={ml.prov}
        table={{
          head: [mt(lang, "col.feature"), mt(lang, "col.effect")],
          rows: drivers.map((d) => [d.label[lang], `±${pct(lang, Math.exp(d.mean_abs_shap) - 1)}`]),
        }}
      >
        <DriverBars
          drivers={drivers.map((d) => ({ label: d.label[lang], v: Math.exp(d.mean_abs_shap) - 1 }))}
          lang={lang}
        />
        <p className="mt-1 text-xs text-muted-foreground">{mt(lang, "why.axis")}</p>
      </MlCard>
      {deps.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2">
          {deps.map((k) => (
            <DependenceCard key={k} ml={ml} index={index} feature={k} rows={index.dependence[k]!} />
          ))}
        </div>
      )}
    </>
  );
}

function DriverBars({ drivers, lang }: { drivers: { label: string; v: number }[]; lang: Lang }) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const w = Math.max(280, width);
  const max = Math.max(...drivers.map((d) => d.v), 1e-9);
  const rowH = 38;
  return (
    <div ref={ref} className="w-full">
      <svg
        width={w}
        height={drivers.length * rowH}
        role="img"
        aria-label={drivers.map((d) => `${d.label} ±${pct(lang, d.v)}`).join("; ")}
      >
        {drivers.map((d, i) => {
          const bw = (d.v / max) * (w - 60);
          return (
            <g key={d.label}>
              <text x={0} y={i * rowH + 12} fontSize="12" fill="currentColor">
                {d.label}
              </text>
              <rect
                x={0}
                y={i * rowH + 17}
                width={Math.max(2, bw)}
                height={12}
                rx={3}
                fill={i === 0 ? "var(--ember)" : "var(--status-near)"}
                opacity={i === 0 ? 1 : 0.75}
              />
              <text
                x={bw + 6}
                y={i * rowH + 27}
                fontSize="11"
                fill="currentColor"
                className="tabular"
              >
                ±{pct(lang, d.v)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function DependenceCard({
  ml,
  index,
  feature,
  rows,
}: {
  ml: MlState;
  index: MlIndex;
  feature: "frp_mean" | "scan_mean" | "landcover";
  rows: MlDependenceRow[];
}) {
  const { lang } = ml;
  const name = mt(lang, `why.dep_${feature}`);
  const label = (r: MlDependenceRow) =>
    r.label ? r.label[lang] : digits(lang, r.bin.replace(" deg", "°").replace("-", "–"));
  const lo = Math.min(...rows.map((r) => r.shap));
  const hi = Math.max(...rows.map((r) => r.shap));
  const take =
    index.takeaways?.[feature]?.[lang] ??
    mtf(lang, "why.dep_summary", {
      feature: name,
      lo: effectPct(lang, lo),
      hi: effectPct(lang, hi),
    });
  return (
    <MlCard
      title={name}
      summary={take}
      lang={lang}
      prov={ml.prov}
      table={{
        head: [mt(lang, "col.range"), mt(lang, "col.effect"), mt(lang, "col.n")],
        rows: rows.map((r) => [label(r), effectPct(lang, r.shap), num(lang, r.n)]),
      }}
    >
      <DependenceBars rows={rows.map((r) => ({ label: label(r), v: r.shap }))} lang={lang} />
      <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-[var(--ember)]" aria-hidden="true" />▲{" "}
          {mt(lang, "why.more")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-[var(--status-below)]" aria-hidden="true" />▼{" "}
          {mt(lang, "why.less")}
        </span>
      </p>
    </MlCard>
  );
}

function DependenceBars({ rows, lang }: { rows: { label: string; v: number }[]; lang: Lang }) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const w = Math.max(240, width);
  const labelW = Math.min(150, w * 0.4);
  const ext = Math.max(...rows.map((r) => Math.abs(Math.exp(r.v) - 1)), 0.01);
  const mid = labelW + (w - labelW) / 2;
  const half = (w - labelW) / 2 - 44;
  const rowH = 26;
  return (
    <div ref={ref} className="w-full">
      <svg
        width={w}
        height={rows.length * rowH + 6}
        role="img"
        aria-label={rows.map((r) => `${r.label} ${effectPct(lang, r.v)}`).join("; ")}
      >
        <line
          x1={mid}
          x2={mid}
          y1={0}
          y2={rows.length * rowH}
          stroke="currentColor"
          opacity={0.4}
        />
        {rows.map((r, i) => {
          const e = Math.exp(r.v) - 1;
          const bw = (Math.abs(e) / ext) * half;
          const y = i * rowH + 4;
          return (
            <g key={r.label}>
              <text x={0} y={y + 14} fontSize="12" fill="currentColor">
                {r.label}
              </text>
              <rect
                x={e >= 0 ? mid : mid - bw}
                y={y + 4}
                width={Math.max(1.5, bw)}
                height={14}
                rx={2}
                fill={e >= 0 ? "var(--ember)" : "var(--status-below)"}
              />
              <text
                x={e >= 0 ? mid + bw + 4 : mid - bw - 4}
                y={y + 15}
                fontSize="11"
                textAnchor={e >= 0 ? "start" : "end"}
                fill="currentColor"
                className="tabular"
              >
                {signed(lang, Math.round(e * 100), 0)}%
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ---------------------------------------------------------------- c) Model vs baseline */

function Benchmark({ ml, index }: P) {
  const { lang } = ml;
  const h = index.models.harmonization;
  const names = ["raw", "baseline", "xgboost", ...(h.metrics.rf ? ["rf"] : [])] as const;
  const cell = h.corr_cell ?? {};
  const mb = h.metrics.baseline?.test.mae ?? NaN;
  const mx = h.metrics.xgboost?.test.mae ?? NaN;
  const r2 = (v: number | undefined) => (v == null || !Number.isFinite(v) ? "—" : num(lang, v, 2));
  const rows = names.map((n) => {
    const m = n === "raw" ? null : h.metrics[n]?.test;
    return {
      n,
      label: mt(lang, `bench.${n}` as "bench.raw"),
      corr: r2(h.corr[n]),
      cell: r2(cell[n]),
      mae: m ? num(lang, m.mae, 2) : "—",
      bias: m ? signed(lang, m.bias, 2) : "—",
    };
  });
  const summary = mtf(lang, "bench.summary", {
    raw: r2(cell.raw),
    base: r2(cell.baseline),
    ml: r2(cell.xgboost),
    raw_a: r2(h.corr.raw),
    base_a: r2(h.corr.baseline),
    ml_a: r2(h.corr.xgboost),
  });
  const sp = h.spatial_cv;
  return (
    <MlCard title={mt(lang, "bench.title")} summary={summary} lang={lang} prov={ml.prov}>
      <div className="overflow-x-auto rounded-md border">
        <table className="tabular w-full text-sm">
          <caption className="sr-only">{`${mt(lang, "bench.title")}. ${summary}`}</caption>
          <thead>
            <tr className="border-b text-muted-foreground">
              <th scope="col" className="px-3 py-2 text-left font-medium">
                {mt(lang, "col.model")}
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                {mt(lang, "bench.corr_cell")}
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                {mt(lang, "bench.corr")}
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                {mt(lang, "bench.mae")}
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                {mt(lang, "bench.bias")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const chosen = r.n === h.chosen;
              return (
                <tr
                  key={r.n}
                  className={cn("border-b last:border-0", chosen && "bg-ember-soft font-semibold")}
                >
                  <th scope="row" className="px-3 py-2 text-left font-[inherit]">
                    {r.label}
                    {chosen && (
                      <span className="chip chip-below ml-2 align-middle text-[11px]">
                        ✓ {mt(lang, "bench.chosen")}
                      </span>
                    )}
                  </th>
                  <td className="px-3 py-2 text-right">{r.cell}</td>
                  <td className="px-3 py-2 text-right">{r.corr}</td>
                  <td className="px-3 py-2 text-right">{r.mae}</td>
                  <td className="px-3 py-2 text-right">{r.bias}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-sm">
        {h.chosen === "baseline"
          ? mt(lang, "bench.simple_won")
          : mtf(lang, "bench.ml_won", {
              mae_x: num(lang, mx, 2),
              mae_b: num(lang, mb, 2),
              pct: pct(lang, 1 - mx / mb),
            })}
      </p>
      {sp?.xgboost?.mae && sp.baseline?.mae && (
        <p className="mt-1 text-xs text-muted-foreground">
          {mtf(lang, "bench.spatial", {
            mae_x: num(lang, sp.xgboost.mae.mean, 2),
            mae_b: num(lang, sp.baseline.mae.mean, 2),
          })}
        </p>
      )}
      <p className="mt-1 text-xs text-muted-foreground">
        {mtf(lang, "bench.note", {
          years: digits(lang, index.splits?.test ?? ""),
          cal: digits(lang, index.splits?.cal ?? ""),
        })}
      </p>
    </MlCard>
  );
}

/* ---------------------------------------------------------------- d) Model card */

function ModelCard({ ml, index }: P) {
  const { lang } = ml;
  const h = index.models.harmonization;
  const f = index.models.firecast;
  const url = ml.provider.methodUrl();
  const list = (keys: Parameters<typeof mt>[1][]) => (
    <ul className="list-disc space-y-1 pl-5 text-sm">
      {keys.map((k) => (
        <li key={k}>{mt(lang, k)}</li>
      ))}
    </ul>
  );
  return (
    <MlCard
      title={mt(lang, "card.title")}
      summary={mtf(lang, "card.version", { h: h.version, f: f.version })}
      lang={lang}
      prov={ml.prov}
    >
      <p
        className="mb-4 flex items-start gap-2 rounded-md border-l-4 border-l-[var(--status-extreme)] bg-muted px-3 py-2 text-sm font-semibold"
        role="note"
      >
        <ShieldAlert
          className="mt-0.5 size-4 shrink-0 text-[var(--status-extreme)]"
          aria-hidden="true"
        />
        {mt(lang, "card.safety")}
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <h3 className="mb-1 text-sm font-semibold">{mt(lang, "card.use")}</h3>
          {list(["card.use1", "card.use2", "card.use3"])}
        </div>
        <div>
          <h3 className="mb-1 text-sm font-semibold">{mt(lang, "card.not")}</h3>
          {list(["card.not1", "card.not2", "card.not3", "card.not4"])}
        </div>
        <div>
          <h3 className="mb-1 text-sm font-semibold">{mt(lang, "card.data")}</h3>
          <p className="text-sm">{mt(lang, "card.data_in")}</p>
          {index.source === "demo" && (
            <p className="mt-1 text-sm text-muted-foreground">{mt(lang, "card.data_demo")}</p>
          )}
        </div>
        <div>
          <h3 className="mb-1 text-sm font-semibold">{mt(lang, "card.metrics")}</h3>
          <ul className="tabular space-y-1 text-sm">
            <li>{mtf(lang, "card.m_cov", { v: pct(lang, h.conformal.coverage_test) })}</li>
            <li>
              {mtf(lang, "card.m_mae", {
                x: num(lang, h.metrics.xgboost?.test.mae ?? NaN, 2),
                b: num(lang, h.metrics.baseline?.test.mae ?? NaN, 2),
              })}
            </li>
            <li>{mtf(lang, "card.m_rpss", { v: signed(lang, f.rpss, 3) })}</li>
          </ul>
        </div>
        <div className="md:col-span-2">
          <h3 className="mb-1 text-sm font-semibold">{mt(lang, "card.limits")}</h3>
          {list(["card.l1", "card.l2", "card.l3", "card.l4", "card.l5"])}
        </div>
      </div>
      {url && (
        <p className="mt-4 text-sm">
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="font-medium underline underline-offset-2"
          >
            {mt(lang, "card.method")}
          </a>
        </p>
      )}
    </MlCard>
  );
}
