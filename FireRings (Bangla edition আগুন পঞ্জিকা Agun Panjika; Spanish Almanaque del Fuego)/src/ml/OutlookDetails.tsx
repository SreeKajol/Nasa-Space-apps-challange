import { useId, useState } from "react";
import { ProvenanceBadge } from "@/components/common";
import { capFirst, digits, monthYear, num } from "@/i18n";
import { useMl } from "./hooks";
import { featureLabel, featureValue, mt, mtf, pct } from "./i18n";
import { ReliabilityChart, SetChips, setText, SkillBadge, StackedProb } from "./parts";
import type { MlForecast } from "./types";

/** FireCast details: probabilities ONLY next to a skill badge; otherwise the no-skill message alone. */
export default function OutlookDetails({ forecasts }: { forecasts: MlForecast[] }) {
  const ml = useMl();
  const { lang, index } = ml;
  const [calib, setCalib] = useState(false);
  const cid = useId();
  if (!index) return null;
  const fc = index.models.firecast;
  const rel = fc.reliability;
  const mid = rel.reduce(
    (best, r) => (r.n > best.n ? r : best),
    rel[0] ?? { bin: 0.5, observed: 0.5, n: 0 },
  );

  return (
    <div className="mt-3 space-y-4">
      <ul className="space-y-4">
        {forecasts.map((f) => {
          const month = capFirst(monthYear(lang, f.ym));
          return (
            <li key={f.ym} className="space-y-2 rounded-md border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-sm font-semibold">{month}</h4>
                <div className="flex flex-wrap items-center gap-2">
                  <SkillBadge f={f} lang={lang} />
                  <ProvenanceBadge source={ml.prov} lang={lang} />
                </div>
              </div>
              {f.skilful ? (
                <>
                  <StackedProb
                    p={f.p}
                    lang={lang}
                    label={`${month}: ${f.p.map((x, k) => `${mt(lang, (["out.cat.below", "out.cat.near", "out.cat.above"] as const)[k]!)} ${pct(lang, x)}`).join(", ")}. ${mtf(lang, "out.likely", { set: setText(lang, f.set) })}`}
                  />
                  <SetChips set={f.set} lang={lang} />
                  {f.drivers.length > 0 && (
                    <div>
                      <h5 className="mb-1 text-xs font-medium text-muted-foreground">
                        {mt(lang, "out.drivers")}
                      </h5>
                      <ul className="space-y-1 text-sm">
                        {f.drivers.slice(0, 3).map((d) => (
                          <li key={d.feature} className="flex items-start gap-2">
                            <span
                              aria-hidden="true"
                              className={
                                d.contrib > 0
                                  ? "text-[var(--status-extreme)]"
                                  : "text-[var(--status-below)]"
                              }
                            >
                              {d.contrib > 0 ? "↑" : "↓"}
                            </span>
                            <span>
                              {featureLabel(lang, index, d.feature)}
                              {d.value != null && (
                                <span className="text-muted-foreground">
                                  {" "}
                                  ({featureValue(lang, index, d.feature, d.value)})
                                </span>
                              )}
                              <span className="sr-only">
                                {d.contrib > 0
                                  ? ` ${mt(lang, "out.cat.above")}`
                                  : ` ${mt(lang, "out.cat.below")}`}
                              </span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              ) : null}
              <p className="text-sm text-muted-foreground">{f.narrative[lang]}</p>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground">{mt(lang, "out.hindcast")}</p>
      <div>
        <button
          type="button"
          aria-expanded={calib}
          aria-controls={cid}
          onClick={() => setCalib((v) => !v)}
          className="inline-flex min-h-11 items-center rounded-md border border-input px-3 text-xs font-medium hover:bg-accent"
        >
          {mt(lang, "out.calib")}
        </button>
        <div id={cid}>
          {calib && rel.length > 0 && (
            <div className="mt-3 space-y-2">
              <p className="text-sm" aria-live="polite">
                {mtf(lang, "out.calib_summary", {
                  p: pct(lang, mid.predicted ?? mid.bin),
                  o: pct(lang, mid.observed),
                  years: digits(lang, fc.evaluation_years ?? ""),
                })}
              </p>
              <ReliabilityChart rows={rel} lang={lang} />
              <p className="text-xs text-muted-foreground">
                {mtf(lang, "out.brier", {
                  b: num(lang, fc.brier, 3),
                  c: num(lang, fc.brier_clim ?? 0.667, 3),
                })}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
