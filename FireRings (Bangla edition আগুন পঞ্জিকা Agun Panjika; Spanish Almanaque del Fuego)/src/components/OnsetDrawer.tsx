import { onsetCurves } from "@/compute/derive";
import { dateLong, digits, t } from "@/i18n";
import { onsetSummary } from "@/i18n/summaries";
import { useApp } from "@/state/app";
import { Drawer } from "./Drawer";
import { CumulativeChart } from "./charts/SmallCharts";

/** Explainer for the "Season onset" KPI: what onset means, the dates and a cumulative chart. */
export function OnsetDrawer({ open, onOpenChange }: { open: boolean; onOpenChange(o: boolean): void }) {
  const { lang, region } = useApp();
  if (!region) return null;
  const complete = region.monthly.filter((p) => p.ym <= region.current.ym);
  const curves = onsetCurves(complete, region.climatology, region.fire_year_start_month);
  const o = region.onset;
  return (
    <Drawer open={open} onOpenChange={onOpenChange} title={t(lang, "on.title")} closeLabel={t(lang, "dr.close")} modal>
      <p className="text-sm">{t(lang, "on.body")}</p>
      <p className="text-sm font-medium" aria-live="polite">
        {onsetSummary(lang, region)}
      </p>
      {o && (
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt className="text-muted-foreground">
            {t(lang, "on.this")} ({digits(lang, o.season)})
          </dt>
          <dd className="text-right font-semibold">{dateLong(lang, o.onset_date)}</dd>
          <dt className="text-muted-foreground">{t(lang, "on.typical")}</dt>
          <dd className="text-right">{dateLong(lang, o.typical_onset_date)}</dd>
        </dl>
      )}
      {curves && (
        <figure>
          <figcaption className="mb-1 text-sm font-semibold">{t(lang, "on.chart")}</figcaption>
          <CumulativeChart lang={lang} months={curves.months} season={curves.season} typical={curves.typical} threshold={curves.threshold} />
          <div className="mt-1 flex flex-wrap gap-x-4 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-4 bg-ember" aria-hidden="true" />
              {t(lang, "on.this")} ({digits(lang, curves.seasonLabel)})
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-4 border-t-2 border-dashed border-muted-foreground" aria-hidden="true" />
              {t(lang, "on.typical")}
            </span>
          </div>
        </figure>
      )}
    </Drawer>
  );
}
