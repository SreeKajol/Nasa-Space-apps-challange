import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { Pane, Rectangle, Tooltip } from "react-leaflet";
import { tileIdsForBbox } from "@/compute/derive";
import { intensityColor, rampGradient } from "@/data/ramp";
import { capFirst, monthYear, num } from "@/i18n";
import { useApp } from "@/state/app";
import { useSettings } from "@/state/settings";
import { useMl } from "./hooks";
import { mlKey } from "./provider";
import { mt, mtf, pct } from "./i18n";
import type { MlGridCell } from "./types";

/*
 * "Next-month above-normal chance" map layer (off by default; URL `risk=1`).
 * Colour = P(above normal) on the sequential ramp. Cells without proven skill
 * are greyed; cells whose 90% set holds all three outcomes get a dotted
 * outline ("too uncertain"). Hover: probability, set, skill. Click: opens the
 * month drawer for that cell's area.
 */

function useRiskCells(): {
  cells: (MlGridCell & { lat: number; lon: number })[];
  target: string | null;
} {
  const { url, provOpts, area } = useApp();
  const ml = useMl();
  const deg = ml.index?.grid?.tile_deg ?? 2;
  const known = ml.index?.grid?.tiles;
  const ids = useMemo(() => {
    if (!area || !ml.ready) return [];
    const all = tileIdsForBbox(area.bbox, deg);
    return known && known.length ? all.filter((t) => known.includes(t)) : all;
  }, [area, deg, known, ml.ready]);
  const key = mlKey(url.src, provOpts);
  const qs = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["ml-grid", key, id],
      queryFn: () => ml.provider.getGrid(id),
      staleTime: Infinity,
      retry: false,
      enabled: url.risk,
    })),
  });
  const data = qs.map((q) => q.data);
  return useMemo(() => {
    const cells: (MlGridCell & { lat: number; lon: number })[] = [];
    let target: string | null = ml.index?.grid?.target ?? null;
    for (const g of data) {
      if (!g) continue;
      target = g.target ?? target;
      for (const c of g.cells) {
        const [, la, lo] = c.id.split("_");
        const lat = c.lat ?? Number(la);
        const lon = c.lon ?? Number(lo);
        if (
          area &&
          lat >= area.bbox[1] - 0.05 &&
          lat <= area.bbox[3] + 0.05 &&
          lon >= area.bbox[0] - 0.05 &&
          lon <= area.bbox[2] + 0.05
        )
          cells.push({ ...c, lat, lon });
      }
    }
    return { cells, target };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(data.map((d) => d?.cells.length ?? -1)), area?.id, ml.index]);
}

export function RiskLayer() {
  const { url, setUrl, index } = useApp();
  const { ramp, dark } = useSettings();
  const ml = useMl();
  const { cells, target } = useRiskCells();
  if (!url.risk || !ml.ready || cells.length === 0) return null;
  const half = (index?.grid.cell_km ?? 5.5) / 111 / 2;
  const { lang } = ml;
  return (
    <Pane name="risk" style={{ zIndex: 430 }}>
      {cells.map((c) => {
        const tip = mtf(lang, "risk.tip", {
          p: pct(lang, c.p_above),
          k: num(lang, c.set_size),
          skill: mt(lang, c.skilful ? "risk.skill_yes" : "risk.skill_no"),
        });
        return (
          <Rectangle
            key={c.id}
            bounds={[
              [c.lat - half, c.lon - half],
              [c.lat + half, c.lon + half],
            ]}
            pathOptions={{
              stroke: c.set_size >= 3,
              color: dark ? "#e2e8f0" : "#1e293b",
              weight: 1,
              dashArray: "2 3",
              fillColor: c.skilful
                ? intensityColor(c.p_above, ramp, dark)
                : dark
                  ? "#64748b"
                  : "#94a3b8",
              fillOpacity: c.skilful ? 0.75 : 0.55,
            }}
            eventHandlers={{
              click: () =>
                setUrl({
                  poly: [
                    [c.lon - half, c.lat - half],
                    [c.lon + half, c.lat - half],
                    [c.lon + half, c.lat + half],
                    [c.lon - half, c.lat + half],
                  ],
                  area: "custom",
                  m: index?.last_month ?? null,
                }),
            }}
          >
            <Tooltip sticky>{tip}</Tooltip>
          </Rectangle>
        );
      })}
      {target && <span hidden>{target}</span>}
    </Pane>
  );
}

/** Toggle for the map's layer controls; renders nothing when FireCast cells are unavailable. */
export function RiskToggle() {
  const { url, setUrl } = useApp();
  const ml = useMl();
  if (!ml.ready || !ml.index?.grid) return null;
  return (
    <button
      type="button"
      aria-pressed={url.risk}
      onClick={() => setUrl({ risk: !url.risk })}
      className="inline-flex min-h-11 items-center rounded-md border border-input px-3 text-xs font-medium hover:bg-accent aria-pressed:border-[var(--ember)] aria-pressed:bg-ember-soft"
    >
      {mt(ml.lang, "risk.toggle")}
    </button>
  );
}

export function RiskLegend() {
  const { url } = useApp();
  const { ramp, dark } = useSettings();
  const ml = useMl();
  const { cells, target } = useRiskCells();
  if (!url.risk || !ml.ready) return null;
  const { lang } = ml;
  if (cells.length === 0)
    return <p className="text-xs text-muted-foreground">{mt(lang, "risk.none")}</p>;
  const skil = cells.filter((c) => c.skilful).length;
  return (
    <div className="space-y-1 text-xs text-muted-foreground" aria-live="polite">
      <p className="flex flex-wrap items-center gap-2">
        <span>{pct(lang, 0)}</span>
        <span
          className="h-2 w-28 rounded-full"
          style={{ background: rampGradient(ramp, dark) }}
          aria-hidden="true"
        />
        <span>{pct(lang, 1)}</span>
        <span>
          {target ? mtf(lang, "risk.legend", { month: capFirst(monthYear(lang, target)) }) : null}
        </span>
      </p>
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-3 rounded-sm bg-slate-400/50" aria-hidden="true" />
          {mt(lang, "risk.grey")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="size-3 rounded-sm border border-dotted border-current"
            aria-hidden="true"
          />
          {mt(lang, "risk.dotted")}
        </span>
      </p>
      <p>{mtf(lang, "risk.summary", { n: num(lang, cells.length), s: num(lang, skil) })}</p>
    </div>
  );
}
