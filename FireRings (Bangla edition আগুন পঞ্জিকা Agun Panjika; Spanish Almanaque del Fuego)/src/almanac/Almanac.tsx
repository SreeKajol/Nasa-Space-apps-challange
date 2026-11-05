import qrcode from "qrcode-generator";
import { useEffect, useMemo } from "react";
import { seasonStartYear } from "@/compute/derive";
import { criticalMonths, monthOrder, yearRows } from "@/data/view";
import { capFirst, dateLong, digits, monthList, monthName, monthYear, num, t, tf } from "@/i18n";
import { nowSummary } from "@/i18n/summaries";
import { useApp } from "@/state/app";
import { serializeState } from "@/state/url";
import { StatusChip } from "@/components/common";
import { Logo } from "@/components/Logo";

/** QR code as plain SVG rects (no innerHTML). */
function QrCode({ text, size = 116 }: { text: string; size?: number }) {
  const qr = useMemo(() => {
    const q = qrcode(0, "M");
    q.addData(text);
    q.make();
    return q;
  }, [text]);
  const n = qr.getModuleCount();
  const cells: string[] = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) cells.push(`M${c} ${r}h1v1h-1z`);
  return (
    <svg viewBox={`-2 -2 ${n + 4} ${n + 4}`} width={size} height={size} role="img" aria-label="QR code" shapeRendering="crispEdges">
      <rect x={-2} y={-2} width={n + 4} height={n + 4} fill="#fff" />
      <path d={cells.join("")} fill="#000" />
    </svg>
  );
}

/**
 * A single A4 page for the selected area and language: the median year with
 * this fire year overlaid, status, critical months, an editable "What to do"
 * box, attribution and a QR code back to the live view. Black-and-white safe.
 */
export function Almanac() {
  const { lang, url, area, region, hview, index } = useApp();

  useEffect(() => {
    document.documentElement.classList.remove("dark");
    document.documentElement.lang = lang;
    if (area) document.title = tf(lang, "alm.title", { area: area.name });
  }, [lang, area]);

  const liveUrl = useMemo(() => {
    const base = new URL("../", window.location.href);
    return base.href.split("?")[0] + serializeState({ ...url, m: null });
  }, [url]);

  if (!area || !region || !hview || !index) {
    return (
      <main className="alm-page">
        <p>{!area && index ? t(lang, "alm.choose") : t(lang, "loading")}</p>
        <a className="alm-noprint underline" href={liveUrl}>
          {t(lang, "alm.back")}
        </a>
      </main>
    );
  }

  const start = region.fire_year_start_month;
  const order = monthOrder(start);
  const rows = yearRows(hview.points, start);
  const sy = seasonStartYear(region.current.ym, start);
  const current = rows.find((r) => r.startYear === sy);
  const medians = order.map((m) => region.climatology[m - 1]!);
  const crit = criticalMonths(region.climatology, start);
  const max = Math.max(1, ...medians.map((c) => c.p90), ...(current?.cells.map((c) => c?.value ?? 0) ?? []));
  const W = 640;
  const H = 230;
  const pad = { l: 40, r: 10, t: 10, b: 30 };
  const bw = (W - pad.l - pad.r) / 12;
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);

  return (
    <main className="alm-page">
      <div className="alm-noprint mb-4 flex gap-3">
        <button type="button" onClick={() => window.print()} className="min-h-11 rounded-md bg-primary px-4 font-medium text-primary-foreground">
          {t(lang, "alm.print")}
        </button>
        <a href={liveUrl} className="inline-flex min-h-11 items-center rounded-md border px-4">
          {t(lang, "alm.back")}
        </a>
      </div>

      <header className="flex items-start justify-between gap-4 border-b-2 border-black pb-3">
        <div className="flex items-center gap-3">
          <Logo className="size-12 text-black" />
          <div>
            <h1 className="text-3xl font-bold">{tf(lang, "alm.title", { area: area.name })}</h1>
            <p className="text-sm">
              {t(lang, "app.title")} · {t(lang, "app.tagline")}
            </p>
          </div>
        </div>
        <div className="text-right text-xs">
          <p>{tf(lang, "alm.printed", { date: dateLong(lang, new Date().toISOString()), last: monthYear(lang, index.last_month) })}</p>
          {region.source === "demo" && <p className="mt-1 font-semibold">⚠ {t(lang, "badge.demo")}: {t(lang, "badge.demo_tip")}</p>}
        </div>
      </header>

      <section className="mt-4 grid grid-cols-[1fr_auto] items-start gap-6">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide">{tf(lang, "alm.now", { month: capFirst(monthYear(lang, region.current.ym)) })}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <StatusChip status={region.current.status} lang={lang} className="alm-chip px-3 py-1 text-base" />
            <span className="tabular text-xl font-semibold">
              {num(lang, region.current.value)} {t(lang, "unit.hotspots")}
            </span>
          </div>
          <p className="mt-2 text-sm">{nowSummary(lang, region, hview.points)}</p>
        </div>
        <div className="text-center">
          <QrCode text={liveUrl} />
          <p className="mt-1 w-32 text-[10px] leading-tight">{t(lang, "alm.scan")}</p>
        </div>
      </section>

      <section className="mt-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide">{t(lang, "alm.critical")}</h2>
        <p className="mt-1 text-5xl leading-tight font-bold">{capFirst(monthList(lang, crit.months))}</p>
      </section>

      <section className="mt-5">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`${t(lang, "alm.median")} / ${tf(lang, "alm.current", { year: digits(lang, current?.label ?? "") })}`}>
          <defs>
            <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" fill="#fff" />
              <line x1="0" y1="0" x2="0" y2="6" stroke="#000" strokeWidth="1.6" />
            </pattern>
          </defs>
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={pad.l} x2={W - pad.r} y1={y(max * f)} y2={y(max * f)} stroke="#000" strokeOpacity={0.15} />
              <text x={pad.l - 6} y={y(max * f)} fontSize={10} textAnchor="end" dominantBaseline="central">
                {num(lang, max * f)}
              </text>
            </g>
          ))}
          {order.map((m, i) => {
            const x = pad.l + i * bw;
            const med = medians[i]!.median;
            const isCrit = crit.months.includes(m);
            return (
              <g key={m}>
                <rect x={x + bw * 0.15} y={y(med)} width={bw * 0.7} height={H - pad.b - y(med)} fill="url(#hatch)" stroke="#000" strokeWidth={isCrit ? 2.4 : 0.8} />
                <text x={x + bw / 2} y={H - pad.b + 14} fontSize={11} textAnchor="middle" fontWeight={isCrit ? 700 : 400}>
                  {monthName(lang, m, true)}
                </text>
                {isCrit && (
                  <text x={x + bw / 2} y={H - 2} fontSize={10} textAnchor="middle">
                    ⚠
                  </text>
                )}
              </g>
            );
          })}
          {current?.cells.map((p, i) =>
            p?.value == null ? null : (
              <rect key={p.ym} x={pad.l + i * bw + bw / 2 - 5} y={y(p.value) - 5} width={10} height={10} fill={p.partial ? "#fff" : "#000"} stroke="#000" strokeWidth={1.5} />
            ),
          )}
        </svg>
        <div className="mt-1 flex flex-wrap gap-6 text-xs">
          <span className="inline-flex items-center gap-2">
            <svg width="16" height="12" aria-hidden="true">
              <rect width="16" height="12" fill="url(#hatch)" stroke="#000" />
            </svg>
            {t(lang, "alm.median")}
          </span>
          <span className="inline-flex items-center gap-2">
            <svg width="12" height="12" aria-hidden="true">
              <rect x="1" y="1" width="10" height="10" fill="#000" />
            </svg>
            {tf(lang, "alm.current", { year: digits(lang, current?.label ?? "") })}
          </span>
          <span>⚠ / ▭ {t(lang, "alm.critical")}</span>
        </div>
      </section>

      <section className="mt-5 rounded-md border-2 border-black p-4">
        <h2 className="text-lg font-bold">{t(lang, "alm.todo_title")}</h2>
        <p className="alm-noprint mb-1 text-xs text-muted-foreground">{t(lang, "alm.todo_hint")}</p>
        <div contentEditable suppressContentEditableWarning className="min-h-24 text-base leading-relaxed outline-none focus-visible:ring-2" role="textbox" aria-multiline="true" aria-label={t(lang, "alm.todo_title")}>
          {t(lang, "alm.todo")}
        </div>
      </section>

      <footer className="mt-5 border-t pt-2 text-[10px] leading-snug" lang="en">
        {t("en", "footer.text")}
      </footer>
    </main>
  );
}
