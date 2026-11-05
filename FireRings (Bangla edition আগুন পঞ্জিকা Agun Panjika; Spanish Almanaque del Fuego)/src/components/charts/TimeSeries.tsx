import { scaleLinear } from "d3-scale";
import { area, line } from "d3-shape";
import { Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { addMonths, parseYm } from "@/data/types";
import { baseMode, inRange, rollingMean, type ViewPoint } from "@/data/view";
import { digits, monthYear, num, numCompact, t, tf } from "@/i18n";
import { contextSummary, seriesSummary, tooltipText, unitFor } from "@/i18n/summaries";
import { useApp } from "@/state/app";
import { useSettings } from "@/state/settings";
import { ChartCard } from "../common";
import { useMeasure } from "../hooks";
import { ChartTooltip } from "./shared";

type Seam = "off" | "raw" | "morph" | "done";
const SEAM_HOLD_MS = 900;
const SEAM_MORPH_MS = 850;
const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

export function TimeSeries() {
  const { lang, url, setUrl, region, index, view, hview, from, to } = useApp();
  const { reducedMotion } = useSettings();
  const [ref, width] = useMeasure<HTMLDivElement>();
  const mode = url.mode;
  const bm = baseMode(mode);

  /* ---- seam moment ---- */
  const [seam, setSeam] = useState<Seam>("off");
  const [morph, setMorph] = useState(0);
  const timers = useRef<number[]>([]);
  const raf = useRef<number | null>(null);
  const clearSeam = () => {
    timers.current.forEach((x) => window.clearTimeout(x));
    timers.current = [];
    if (raf.current != null) cancelAnimationFrame(raf.current);
  };
  useEffect(() => clearSeam, []);
  useEffect(() => {
    clearSeam();
    setSeam("off");
  }, [mode, from, to]);
  const runSeam = () => {
    clearSeam();
    if (reducedMotion) {
      setMorph(1);
      setSeam("done");
      return;
    }
    setMorph(0);
    setSeam("raw");
    timers.current.push(
      window.setTimeout(() => {
        setSeam("morph");
        const t0 = performance.now();
        const step = (now: number) => {
          const k = Math.min(1, (now - t0) / SEAM_MORPH_MS);
          setMorph(ease(k));
          if (k < 1) raf.current = requestAnimationFrame(step);
          else setSeam("done");
        };
        raf.current = requestAnimationFrame(step);
      }, SEAM_HOLD_MS),
    );
  };

  /* ---- data window ---- */
  const viirsStart = index?.viirs_start ?? "2012-01";
  const seamOn = seam !== "off";
  const window_ = useMemo(() => {
    if (!hview || !view) return { pts: [] as ViewPoint[], hpts: [] as ViewPoint[] };
    let f = from;
    let tt = to;
    if (seamOn) {
      const first = hview.points[0]!.ym;
      const last = hview.points[hview.points.length - 1]!.ym;
      f = addMonths(viirsStart, -72) < first ? first : addMonths(viirsStart, -72);
      tt = addMonths(viirsStart, 72) > last ? last : addMonths(viirsStart, 72);
    }
    return { pts: inRange(view.points, f, tt), hpts: inRange(hview.points, f, tt) };
  }, [view, hview, from, to, seamOn, viirsStart]);

  const [zoom, setZoom] = useState<[number, number] | null>(null);
  useEffect(() => setZoom(null), [from, to, seamOn]);
  const n = window_.hpts.length;
  const [z0, z1] = zoom ?? [0, Math.max(0, n - 1)];
  const hpts = window_.hpts.slice(z0, z1 + 1);
  const pts = window_.pts.slice(z0, z1 + 1);

  const [hover, setHover] = useState<number | null>(null);
  const [brush, setBrush] = useState<{ a: number; b: number } | null>(null);

  if (!region || !index || !view || !hview || n === 0) return null;

  const W = Math.max(320, width || 720);
  const H = W < 560 ? 240 : 300;
  const m = { top: 22, right: 14, bottom: 26, left: 46 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const x = scaleLinear().domain([0, Math.max(1, hpts.length - 1)]).range([0, iw]);

  const showModis = seamOn ? seam !== "done" : bm === "modis" || mode === "compare";
  const showViirs = seamOn ? seam !== "done" : bm === "viirs" || mode === "compare";
  const showHarm = seamOn ? seam === "done" : bm === "harmonized";
  const rawMax = Math.max(1, ...hpts.map((p) => Math.max(p.modis ?? 0, p.viirs ?? 0)));
  const harmMax = Math.max(1, ...hpts.map((p) => p.hhigh));
  let yMax: number;
  if (seamOn) yMax = seam === "raw" ? rawMax : rawMax + (harmMax - rawMax) * morph;
  else if (mode === "compare") yMax = Math.max(rawMax, harmMax);
  else if (bm === "harmonized") yMax = harmMax;
  else yMax = Math.max(1, ...pts.map((p) => p.value ?? 0));
  const y = scaleLinear().domain([0, yMax * 1.06]).nice().range([ih, 0]);

  const lerp = (a: number | null, b: number) => (a == null ? null : a + (b - a) * (seam === "morph" || seam === "done" ? morph : 0));
  const modisVals = hpts.map((p) => (seamOn ? lerp(p.modis, p.harmonized) : p.modis));
  const viirsVals = hpts.map((p) => (seamOn ? lerp(p.viirs, p.harmonized) : p.viirs));
  const primary = bm === "harmonized" ? hpts.map((p) => p.harmonized) : pts.map((p) => p.value);
  const roll = url.roll && !seamOn ? rollingMean(window_.hpts.map((p, i) => (bm === "harmonized" ? p.harmonized : window_.pts[i]!.value))).slice(z0, z1 + 1) : null;

  const pathOf = (vals: (number | null)[]) =>
    line<number | null>()
      .defined((v) => v != null)
      .x((_, i) => x(i))
      .y((v) => y(v ?? 0))(vals) ?? "";
  const band =
    area<ViewPoint>()
      .x((_, i) => x(i))
      .y0((p) => y(p.hlow))
      .y1((p) => y(p.hhigh))(hpts) ?? "";

  const vi = hpts.findIndex((p) => p.ym >= viirsStart);
  const viirsX = vi > 0 ? x(vi) : null;
  const years = hpts.map((p, i) => ({ i, ...parseYm(p.ym) })).filter((d) => d.m === 1);
  const yearStep = Math.ceil(years.length / Math.max(2, Math.floor(iw / 56)));
  const val = region.validation;

  const summary = seamOn
    ? seriesSummary(lang, hpts, hview.points, viirsStart, "compare")
    : seriesSummary(lang, pts, hview.points, viirsStart, mode);
  const live = seam === "done" ? `${t(lang, "ser.seam_caption")} ${summary}` : summary;

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const r = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const i = Math.round(x.invert(e.clientX - r.left));
    setHover(Math.max(0, Math.min(hpts.length - 1, i)));
  };
  const hp = hover != null ? pts[hover] : null;
  const tip = hp && hover != null ? { x: m.left + x(hover) + (width > W ? 0 : 0), y: m.top + y(Math.min(yMax, hp.value ?? hp.harmonized)), text: tooltipText(lang, hp, bm) } : null;

  const table = {
    head: [t(lang, "col.month"), t(lang, "mode.harmonized"), t(lang, "col.low"), t(lang, "col.high"), t(lang, "col.modis"), t(lang, "col.viirs")],
    rows: [...hpts].reverse().map((p) => [monthYear(lang, p.ym, true), num(lang, p.harmonized), num(lang, p.hlow), num(lang, p.hhigh), num(lang, p.modis), num(lang, p.viirs)]),
  };

  /* ---- overview / brush ---- */
  const OH = 44;
  const ox = scaleLinear().domain([0, Math.max(1, n - 1)]).range([0, iw]);
  const oy = scaleLinear().domain([0, Math.max(1, ...window_.hpts.map((p) => p.harmonized))]).range([OH, 2]);
  const overviewPath =
    area<ViewPoint>()
      .x((_, i) => ox(i))
      .y0(OH)
      .y1((p) => oy(p.harmonized))(window_.hpts) ?? "";
  const brushIdx = (e: PointerEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(n - 1, Math.round(ox.invert(e.clientX - r.left))));
  };

  const ctx = region.context ? inRange(region.context, hpts[0]!.ym, hpts[hpts.length - 1]!.ym) : [];
  const ctxByYm = new Map(ctx.map((c) => [c.ym, c]));
  const CH = 64;
  const pMax = Math.max(1, ...ctx.map((c) => c.precip_mm));
  const tMin = Math.min(...ctx.map((c) => c.t2m_c));
  const tMax = Math.max(...ctx.map((c) => c.t2m_c));
  const cyT = scaleLinear().domain([tMin - 1, tMax + 1]).range([CH - 4, 4]);

  return (
    <ChartCard
      title={t(lang, "ser.title")}
      summary={live}
      lang={lang}
      table={table}
      actions={
        <>
          <label className="inline-flex min-h-11 items-center gap-2 text-xs">
            <input type="checkbox" className="size-4 accent-[var(--ember)]" checked={url.roll} onChange={(e) => setUrl({ roll: e.target.checked })} />
            {t(lang, "ser.rolling")}
          </label>
          {zoom && (
            <button type="button" className="inline-flex min-h-11 items-center rounded-md border border-input px-3 text-xs font-medium hover:bg-accent" onClick={() => setZoom(null)}>
              {t(lang, "ser.reset_zoom")}
            </button>
          )}
          <button type="button" onClick={runSeam} className="inline-flex min-h-11 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90">
            <Sparkles className="size-4" aria-hidden="true" />
            {t(lang, "ser.seam")}
          </button>
        </>
      }
      footer={
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {(showHarm || mode === "compare") && <LegendLine color="var(--ember)" label={t(lang, "mode.harmonized")} />}
          {(showHarm || mode === "compare") && <LegendLine color="var(--band)" label={t(lang, "ser.band")} wide />}
          {showModis && <LegendLine color="var(--line-modis)" label={t(lang, "mode.modis")} />}
          {showViirs && <LegendLine color="var(--line-viirs)" label={t(lang, "mode.viirs")} />}
          {roll && <LegendLine color="var(--foreground)" label={t(lang, "ser.rolling")} dashed />}
          <span>{t(lang, "ser.brush_help")}</span>
        </div>
      }
    >
      {seamOn && (
        <div className="mb-2 flex flex-wrap items-center gap-3 rounded-md border border-dashed p-2 text-sm" role="status">
          <strong className={seam === "done" ? "text-ember-text" : ""}>{seam === "done" ? t(lang, "ser.seam_caption") : tf(lang, "ser.viirs_starts", { date: monthYear(lang, viirsStart) })}</strong>
          {val && (
            <span className="tabular text-muted-foreground">
              {tf(lang, "ser.agreement", { raw: num(lang, val.corr_raw, 2), harm: num(lang, val.corr_harmonized, 2) })}
            </span>
          )}
        </div>
      )}
      <div ref={ref} className="relative w-full" onMouseLeave={() => setHover(null)}>
        <svg width={W} height={H} role="img" aria-label={live} className="block max-w-full">
          <g transform={`translate(${m.left},${m.top})`}>
            {y.ticks(5).map((v) => (
              <g key={v}>
                <line x2={iw} y1={y(v)} y2={y(v)} stroke="var(--grid-line)" />
                <text x={-8} y={y(v)} textAnchor="end" dominantBaseline="central" fontSize={10} fill="var(--muted-foreground)" className="tabular">
                  {numCompact(lang, v)}
                </text>
              </g>
            ))}
            {years
              .filter((_, k) => k % yearStep === 0)
              .map((d) => (
                <text key={d.i} x={x(d.i)} y={ih + 17} textAnchor="middle" fontSize={10} fill="var(--muted-foreground)" className="tabular">
                  {digits(lang, d.y)}
                </text>
              ))}
            {(showHarm || mode === "compare") && <path d={band} fill="var(--band)" style={{ transition: "opacity 200ms" }} />}
            {viirsX != null && (
              <g>
                {seam === "raw" && <rect x={viirsX - 14} y={0} width={28} height={ih} fill="var(--ember-soft)" />}
                <line x1={viirsX} x2={viirsX} y1={-8} y2={ih} stroke={seamOn ? "var(--ember)" : "var(--muted-foreground)"} strokeWidth={seamOn ? 2 : 1} strokeDasharray="4 3" />
                <text x={viirsX + 6} y={-8} fontSize={11} fontWeight={seamOn ? 650 : 500} fill={seamOn ? "var(--ember-text)" : "var(--muted-foreground)"}>
                  {tf(lang, "ser.viirs_starts", { date: monthYear(lang, viirsStart, true) })}
                </text>
              </g>
            )}
            {showModis && <path d={pathOf(modisVals)} fill="none" stroke="var(--line-modis)" strokeWidth={1.6} />}
            {showViirs && <path d={pathOf(viirsVals)} fill="none" stroke="var(--line-viirs)" strokeWidth={1.6} />}
            {(showHarm || mode === "compare") && <path d={pathOf(hpts.map((p) => p.harmonized))} fill="none" stroke="var(--ember)" strokeWidth={2.2} strokeLinejoin="round" />}
            {!seamOn && bm !== "harmonized" && mode !== "compare" && <path d={pathOf(primary)} fill="none" stroke={bm === "modis" ? "var(--line-modis)" : "var(--line-viirs)"} strokeWidth={1.8} />}
            {roll && <path d={pathOf(roll)} fill="none" stroke="var(--foreground)" strokeWidth={1.6} strokeDasharray="5 3" />}
            {hover != null && <line x1={x(hover)} x2={x(hover)} y1={0} y2={ih} stroke="var(--foreground)" strokeOpacity={0.35} />}
            <rect
              width={iw}
              height={ih}
              fill="transparent"
              onPointerMove={onMove}
              onPointerLeave={() => setHover(null)}
              onClick={() => hover != null && pts[hover] && setUrl({ m: pts[hover]!.ym })}
              style={{ cursor: "crosshair" }}
            />
          </g>
        </svg>
        {tip && <ChartTooltip tip={tip} />}

        {ctx.length > 0 && !seamOn && (
          <figure className="mt-2" aria-label={contextSummary(lang, ctx)}>
            <figcaption className="mb-1 flex flex-wrap gap-x-4 text-[11px] text-muted-foreground">
              <span>{t(lang, "m.src_power")}</span>
              <LegendLine color="var(--line-modis)" label={t(lang, "ser.precip")} wide />
              <LegendLine color="var(--ember)" label={t(lang, "ser.temp")} />
            </figcaption>
            <svg width={W} height={CH} aria-hidden="true" className="block max-w-full">
              <g transform={`translate(${m.left},0)`}>
                {hpts.map((p, i) => {
                  const c = ctxByYm.get(p.ym);
                  if (!c) return null;
                  const h = (c.precip_mm / pMax) * (CH - 6);
                  return <rect key={p.ym} x={x(i) - Math.max(0.5, iw / hpts.length / 2 - 0.5)} y={CH - h} width={Math.max(1, iw / hpts.length - 1)} height={h} fill="var(--line-modis)" opacity={0.45} />;
                })}
                <path
                  d={
                    line<ViewPoint>()
                      .defined((p) => ctxByYm.has(p.ym))
                      .x((_, i) => x(i))
                      .y((p) => cyT(ctxByYm.get(p.ym)?.t2m_c ?? 0))(hpts) ?? ""
                  }
                  fill="none"
                  stroke="var(--ember)"
                  strokeWidth={1.4}
                />
              </g>
            </svg>
          </figure>
        )}

        {/* Overview strip with brush */}
        <svg width={W} height={OH + 6} className="mt-2 block max-w-full" role="img" aria-label={t(lang, "ser.zoom_label")}>
          <g transform={`translate(${m.left},2)`}>
            <path d={overviewPath} fill="var(--muted-foreground)" opacity={0.25} />
            <rect x={ox(z0)} width={Math.max(2, ox(z1) - ox(z0))} height={OH} fill="var(--ember-soft)" stroke="var(--ember)" strokeWidth={1} rx={2} />
            {brush && <rect x={ox(Math.min(brush.a, brush.b))} width={Math.abs(ox(brush.b) - ox(brush.a))} height={OH} fill="var(--ember)" opacity={0.2} />}
            <rect
              width={iw}
              height={OH}
              fill="transparent"
              style={{ cursor: "ew-resize", touchAction: "none" }}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                const i = brushIdx(e);
                setBrush({ a: i, b: i });
              }}
              onPointerMove={(e) => brush && setBrush({ ...brush, b: brushIdx(e) })}
              onPointerUp={() => {
                if (brush && Math.abs(brush.b - brush.a) >= 3) setZoom([Math.min(brush.a, brush.b), Math.max(brush.a, brush.b)]);
                setBrush(null);
              }}
              onDoubleClick={() => setZoom(null)}
            />
          </g>
        </svg>
      </div>
      <span className="sr-only">{unitFor(lang, bm)}</span>
    </ChartCard>
  );
}

function LegendLine({ color, label, dashed, wide }: { color: string; label: string; dashed?: boolean; wide?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg width={18} height={10} aria-hidden="true">
        {wide ? <rect y={1} width={18} height={8} rx={2} fill={color} /> : <line x1={0} x2={18} y1={5} y2={5} stroke={color} strokeWidth={2.4} strokeDasharray={dashed ? "4 2" : undefined} />}
      </svg>
      {label}
    </span>
  );
}
