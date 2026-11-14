import { useQuery } from "@tanstack/react-query";
import { CITATIONS } from "@/data/citation";
import { getStaticExtra } from "@/data/provider";
import type { EonetValidation, SeamTest } from "@/data/types";
import { dateLong, digits, monthYear, num, pctStr, t, tf, type Lang } from "@/i18n";
import { useApp } from "@/state/app";
import { Card } from "./common";

/*
 * Method & data tab, real-data builds only (index.data_mode === "real"):
 * the FIRMS sources and dates actually used, the VIIRS reference actually
 * used, the independent EONET check and the seam test, plus the citation.
 * Every value is read from the run's own files; nothing is computed here.
 */

const SAT: Record<string, string> = {
  VIIRS_SNPP: "Suomi-NPP",
  VIIRS_NOAA20: "NOAA-20",
  VIIRS_NOAA21: "NOAA-21",
};

/** "= 0.219" or "< 0.001": the comparison is part of the value (templates read "p {p}"). */
function pText(lang: Lang, p: number): string {
  return p < 0.001 ? `< ${num(lang, 0.001, 3)}` : `= ${num(lang, p, 3)}`;
}

/** "✓ No sensor break detected (p = …)" or "⚠ Possible break at …". */
export function SeamBadge({ seam, lang }: { seam: SeamTest | undefined; lang: Lang }) {
  if (!seam) return null;
  const h = seam.harmonized;
  const warn = h.significant && h.break_ym;
  return (
    <div className="space-y-1">
      <p
        className={warn ? "chip chip-above whitespace-normal" : "chip chip-below whitespace-normal"}
      >
        {warn
          ? tf(lang, "rd.seam_warn", { month: monthYear(lang, h.break_ym!), p: pText(lang, h.p) })
          : tf(lang, "rd.seam_ok", { p: pText(lang, h.p) })}
      </p>
      {seam.raw.break_ym && (
        <p className="text-xs text-muted-foreground">
          {tf(lang, "rd.seam_raw", {
            month: monthYear(lang, seam.raw.break_ym),
            p: pText(lang, seam.raw.p),
          })}
        </p>
      )}
    </div>
  );
}

export function RealDataCard() {
  const { lang, index, region, area, url } = useApp();
  const real = index?.data_mode === "real";
  const presetId = area && !area.custom ? area.id : null;
  const eq = useQuery({
    queryKey: ["eonet-validation", presetId],
    queryFn: () => getStaticExtra<EonetValidation>(url.src, `validation/eonet_${presetId}.json`),
    enabled: real && !!presetId && region?.source !== "demo",
    staleTime: Infinity,
  });
  if (!real || !index) return null;
  const e = eq.data;
  const d = (iso: string | null | undefined) => (iso ? dateLong(lang, iso) : "—");
  const ref = index.viirs_reference ?? "";
  const eonetText = !presetId
    ? t(lang, "rd.eonet_custom")
    : region?.source === "demo" || !e || e.status === "unavailable"
      ? t(lang, "rd.eonet_none")
      : e.status === "ok" && e.hit_rate != null
        ? tf(lang, "rd.eonet_hit", {
            m: num(lang, e.matched),
            n: num(lang, e.total),
            rate: pctStr(lang, e.hit_rate),
            base: pctStr(lang, e.base_rate ?? 0),
          })
        : tf(lang, "rd.eonet_few", { n: num(lang, e.total), min: num(lang, e.min_events ?? 3) });

  return (
    <Card title={t(lang, "rd.title")} accent>
      <p className="text-sm text-muted-foreground">
        {tf(lang, "rd.generated", { date: d(index.generated_at) })}
      </p>
      {region?.source === "demo" && (
        <p className="mt-2 rounded-md bg-muted p-2 text-sm font-medium">{t(lang, "rd.fallback")}</p>
      )}
      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <section>
          <h3 className="mb-1 text-sm font-semibold">{t(lang, "rd.sources")}</h3>
          <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-3 gap-y-1 text-sm">
            {Object.entries(index.source_dates ?? {}).map(([s, r]) => (
              <div key={s} className="contents">
                <dt className="font-mono text-xs">{s}</dt>
                <dd className="tabular">
                  {digits(lang, r.first)} – {digits(lang, r.last)}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-sm">
            {tf(lang, "rd.viirs", {
              sat: SAT[ref] ?? ref,
              month: monthYear(lang, index.viirs_start),
            })}
          </p>
          {ref !== "VIIRS_SNPP" && (
            <p className="text-xs text-muted-foreground">{t(lang, "rd.viirs_note")}</p>
          )}
        </section>
        <section className="space-y-3">
          <div>
            <h3 className="mb-1 text-sm font-semibold">{t(lang, "rd.eonet")}</h3>
            <p className="text-sm" aria-live="polite">
              {eonetText}
            </p>
          </div>
          <div>
            <h3 className="mb-1 text-sm font-semibold">{t(lang, "rd.seam")}</h3>
            {region?.seam_test ? (
              <SeamBadge seam={region.seam_test} lang={lang} />
            ) : (
              <p className="text-sm text-muted-foreground">—</p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">{t(lang, "rd.seam_x")}</p>
          </div>
        </section>
      </div>
      {!!index.notes?.length && (
        <details className="mt-3 text-xs">
          <summary className="min-h-11 cursor-pointer content-center font-medium">
            {t(lang, "rd.notes")}
          </summary>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            {index.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </details>
      )}
      <details className="mt-1 text-xs">
        <summary className="min-h-11 cursor-pointer content-center font-medium">
          {t(lang, "rd.cite")}
        </summary>
        <ul className="space-y-2">
          {CITATIONS.map((c) => {
            const acc = c.id === "gibs" ? null : index.access?.[c.id];
            return (
              <li key={c.id} lang="en">
                <span className="font-semibold">{c.name}.</span> {c.text}
                {c.products && (
                  <ul className="list-disc pl-5">
                    {c.products.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                )}
                <span className="block text-muted-foreground">
                  {c.url}
                  {acc ? ` · ${tf(lang, "rd.access", { date: d(acc) })}` : ""}
                </span>
              </li>
            );
          })}
        </ul>
      </details>
    </Card>
  );
}
