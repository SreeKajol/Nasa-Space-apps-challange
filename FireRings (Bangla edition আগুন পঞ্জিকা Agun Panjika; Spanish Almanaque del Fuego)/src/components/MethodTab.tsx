import { scaleLinear } from "d3-scale";
import { line } from "d3-shape";
import { Download, FileText, Filter, Grid3x3, History, Scale, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { addMonths } from "@/data/types";
import { inRange, type ViewPoint } from "@/data/view";
import { capFirst, dateLong, digits, monthName, monthYear, num, pctStr, t, tf } from "@/i18n";
import { seamMiniSummary } from "@/i18n/summaries";
import { coefficientsCsv, monthlyCsv } from "@/lib/exports";
import { useApp } from "@/state/app";
import { Card } from "./common";
import { downloadFile } from "./hooks";

const METHOD_PDF = "https://example.org/firerings/method.pdf"; // placeholder until the paper is published

export function MethodTab() {
  const { lang, region, index, hview, area, from, to, isDemo } = useApp();
  if (!region || !index || !hview) return null;
  const v = region.validation;
  const km = digits(lang, String(index.grid.cell_km).replace(".", lang === "es" ? "," : "."));
  const overlap = v ? v.overlap.split("/").map((ym) => monthYear(lang, ym, true)).join(" – ") : `${monthYear(lang, index.viirs_start, true)} – …`;
  const steps: { icon: ReactNode; title: string; body: string }[] = [
    { icon: <Filter className="size-6" aria-hidden="true" />, title: t(lang, "m.s1_t"), body: t(lang, "m.s1_b") },
    { icon: <Grid3x3 className="size-6" aria-hidden="true" />, title: t(lang, "m.s2_t"), body: tf(lang, "m.s2_b", { km }) },
    { icon: <Scale className="size-6" aria-hidden="true" />, title: t(lang, "m.s3_t"), body: tf(lang, "m.s3_b", { overlap }) },
    { icon: <History className="size-6" aria-hidden="true" />, title: t(lang, "m.s4_t"), body: t(lang, "m.s4_b") },
  ];
  const sources: [string, string][] = [
    ["m.src_modis", "m.src_modis_u"],
    ["m.src_viirs", "m.src_viirs_u"],
    ["m.src_lc", "m.src_lc_u"],
    ["m.src_gibs", "m.src_gibs_u"],
    ["m.src_power", "m.src_power_u"],
    ["m.src_wc", "m.src_wc_u"],
  ];
  const base = `firerings_${area?.id ?? "area"}`;

  return (
    <div className="space-y-4">
      <Card title={t(lang, "m.steps_title")}>
        <ol className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {steps.map((s, i) => (
            <li key={i} className="flex gap-3 rounded-md border p-3">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-ember-soft text-ember-text">{s.icon}</div>
              <div>
                <h3 className="text-sm font-semibold">
                  <span className="text-muted-foreground">{digits(lang, i + 1)}. </span>
                  {s.title}
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title={t(lang, "m.val_title")} accent>
          {v ? (
            <>
              <p className="text-sm text-muted-foreground">{t(lang, "m.val_headline")}</p>
              <div className="my-3 flex items-end gap-6">
                <BigNum label={t(lang, "m.raw")} value={num(lang, v.corr_raw, 2)} />
                <span aria-hidden="true" className="pb-3 text-2xl text-muted-foreground">
                  →
                </span>
                <BigNum label={t(lang, "m.harm")} value={num(lang, v.corr_harmonized, 2)} accent />
              </div>
              <dl className="space-y-2 text-sm">
                <Row term={t(lang, "m.train")} value={digits(lang, v.train)} note={t(lang, "m.train_x")} />
                <Row term={t(lang, "m.test")} value={digits(lang, v.test)} note={t(lang, "m.test_x")} />
                <Row term={t(lang, "m.mae")} value={`${num(lang, v.mae, 1)} ${t(lang, "unit.hotspots")}`} note={t(lang, "m.mae_x")} />
                <Row term={t(lang, "m.bias")} value={(v.bias > 0 ? "+" : "") + num(lang, v.bias, 1)} note={t(lang, "m.bias_x")} />
                <Row term={t(lang, "m.cov")} value={pctStr(lang, v.coverage_90)} note={t(lang, "m.cov_x")} />
              </dl>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{t(lang, "cap.evidence_none")}</p>
          )}
        </Card>

        <Card title={t(lang, "m.seam")}>
          <p className="mb-2 text-sm text-muted-foreground" aria-live="polite">
            {seamMiniSummary(lang, hview.points, index.viirs_start)}
          </p>
          <SeamMini points={hview.points} viirsStart={index.viirs_start} />
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title={t(lang, "m.params")}>
          <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">{t(lang, "m.p_cell")}</dt>
            <dd>{km} km</dd>
            <dt className="text-muted-foreground">{t(lang, "m.p_conf")}</dt>
            <dd>{t(lang, "m.p_conf_v")}</dd>
            <dt className="text-muted-foreground">{t(lang, "m.p_rule")}</dt>
            <dd>{t(lang, "m.p_rule_v")}</dd>
            <dt className="text-muted-foreground">{t(lang, "m.p_overlap")}</dt>
            <dd className="tabular">{overlap}</dd>
            <dt className="text-muted-foreground">{t(lang, "m.p_year")}</dt>
            <dd>{capFirst(monthName(lang, region.fire_year_start_month))}</dd>
            <dt className="text-muted-foreground">{t(lang, "m.p_onset")}</dt>
            <dd>{t(lang, "m.p_onset_v")}</dd>
            <dt className="text-muted-foreground">{t(lang, "m.p_status")}</dt>
            <dd>{t(lang, "m.p_status_v")}</dd>
          </dl>
          <p className="mt-4 flex items-start gap-2 rounded-md bg-muted p-3 text-xs">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {t(lang, "m.ai_note")}
          </p>
        </Card>

        <Card title={t(lang, "m.why_title")}>
          <p className="text-sm">{t(lang, "m.why")}</p>
          <h3 className="mt-4 mb-2 text-sm font-semibold">{t(lang, "data.about")}</h3>
          <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">{t(lang, "data.generated")}</dt>
            <dd>{dateLong(lang, index.generated_at)}</dd>
            <dt className="text-muted-foreground">{t(lang, "data.record")}</dt>
            <dd className="tabular">
              {monthYear(lang, index.first_month, true)} – {monthYear(lang, index.last_month, true)}
            </dd>
            <dt className="text-muted-foreground">{t(lang, "data.grid")}</dt>
            <dd>
              {km} km · {digits(lang, index.grid.tile_deg)}° tiles
            </dd>
            <dt className="text-muted-foreground">{t(lang, "data.adapter")}</dt>
            <dd>{isDemo ? "MockAdapter (synthetic)" : "StaticJsonAdapter"} · {index.sensors.join(", ")}</dd>
          </dl>
        </Card>
      </div>

      <Card title={t(lang, "m.sources")}>
        <ul className="grid gap-2 sm:grid-cols-2">
          {sources.map(([n, u]) => (
            <li key={n} className="rounded-md border p-3 text-sm">
              <span className="font-medium">{t(lang, n as never)}</span>
              <span className="block text-xs text-muted-foreground">{t(lang, u as never)}</span>
            </li>
          ))}
        </ul>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title={t(lang, "m.limits")}>
          <ul className="list-disc space-y-1.5 pl-5 text-sm">
            <li>{t(lang, "m.l1")}</li>
            <li>{t(lang, "m.l2")}</li>
            <li>{tf(lang, "m.l3", { viirs: monthYear(lang, index.viirs_start) })}</li>
            <li>{tf(lang, "m.l4", { km })}</li>
            <li>{t(lang, "m.l5")}</li>
            {isDemo && <li className="font-medium">{t(lang, "m.l6")}</li>}
          </ul>
        </Card>
        <Card title={t(lang, "m.dl")}>
          <div className="flex flex-col gap-2">
            <DlButton onClick={() => downloadFile(`${base}_coefficients.csv`, "text/csv", coefficientsCsv(region, index.viirs_start))} label={t(lang, "m.dl_coef")} note={t(lang, "m.dl_coef_x")} />
            <DlButton onClick={() => downloadFile(`${base}_monthly_${from}_${to}.csv`, "text/csv", monthlyCsv(region, from, to))} label={t(lang, "m.dl_monthly")} />
            <a href={METHOD_PDF} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-2 rounded-md border border-input px-3 text-sm hover:bg-accent">
              <FileText className="size-4" aria-hidden="true" /> {t(lang, "m.dl_pdf")}
            </a>
          </div>
        </Card>
      </div>
    </div>
  );
}

function BigNum({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div className={accent ? "tabular text-5xl font-semibold text-ember-text" : "tabular text-5xl font-semibold text-muted-foreground"}>{value}</div>
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
    </div>
  );
}

function Row({ term, value, note }: { term: string; value: string; note: string }) {
  return (
    <div className="grid grid-cols-[1fr_auto] gap-x-3 border-b border-border/60 pb-2 last:border-0">
      <dt className="font-medium">{term}</dt>
      <dd className="tabular text-right font-semibold">{value}</dd>
      <dd className="col-span-2 text-xs text-muted-foreground">{note}</dd>
    </div>
  );
}

function DlButton({ onClick, label, note }: { onClick(): void; label: string; note?: string }) {
  return (
    <button type="button" onClick={onClick} className="flex min-h-11 flex-col items-start rounded-md border border-input px-3 py-2 text-left text-sm hover:bg-accent">
      <span className="inline-flex items-center gap-2 font-medium">
        <Download className="size-4" aria-hidden="true" /> {label}
      </span>
      {note && <span className="text-xs text-muted-foreground">{note}</span>}
    </button>
  );
}

/** Before/after mini-charts of the sensor seam (raw total vs harmonized). */
function SeamMini({ points, viirsStart }: { points: ViewPoint[]; viirsStart: string }) {
  const { lang } = useApp();
  const pts = inRange(points, addMonths(viirsStart, -60), addMonths(viirsStart, 59));
  if (pts.length < 24) return null;
  const raw = pts.map((p) => (p.modis ?? 0) + (p.viirs ?? 0));
  const harm = pts.map((p) => p.harmonized);
  const vi = pts.findIndex((p) => p.ym >= viirsStart);
  const chart = (vals: number[], color: string, title: string) => {
    const W = 260;
    const H = 110;
    const x = scaleLinear().domain([0, vals.length - 1]).range([4, W - 4]);
    const y = scaleLinear().domain([0, Math.max(1, ...vals)]).range([H - 14, 6]);
    const d = line<number>().x((_, i) => x(i)).y((v) => y(v))(vals) ?? "";
    return (
      <figure className="min-w-0 flex-1">
        <figcaption className="mb-1 text-xs font-medium">{title}</figcaption>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" aria-hidden="true">
          <line x1={x(vi)} x2={x(vi)} y1={0} y2={H - 14} stroke="var(--muted-foreground)" strokeDasharray="3 3" />
          <path d={d} fill="none" stroke={color} strokeWidth={1.6} />
          <text x={x(vi) + 3} y={H - 2} fontSize={9} fill="var(--muted-foreground)">
            {monthYear(lang, viirsStart, true)}
          </text>
        </svg>
      </figure>
    );
  };
  return (
    <div className="flex flex-col gap-3 sm:flex-row">
      {chart(raw, "var(--line-viirs)", t(lang, "m.before"))}
      {chart(harm, "var(--ember)", t(lang, "m.after"))}
    </div>
  );
}
