import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { bboxOfPolygon, bboxPolygon, polygonAreaKm2 } from "@/compute/derive";
import { resolveSrc, type ProviderOptions } from "@/data/provider";
import { indexQuery, regionQuery } from "@/data/queries";
import type { IndexMeta, Polygon, RegionData, RegionRequest } from "@/data/types";
import { inRange, regionView, type RegionView, type ViewPoint } from "@/data/view";
import { digits, isLangLoaded, loadLang, tf, type Lang } from "@/i18n";
import { useSettings } from "./settings";
import { useUrlState, type SetUrl, type UrlState } from "./url";

/*
 * App context: resolves URL state + preferences into the selected area, the
 * region data, the date range and the mode views — once, for every component.
 */

export interface Area {
  id: string;
  name: string;
  bbox: [number, number, number, number];
  polygon: Polygon;
  km2: number;
  custom: boolean;
  country: string | null;
}

export interface App {
  url: UrlState;
  setUrl: SetUrl;
  lang: Lang;
  provOpts: ProviderOptions;
  isDemo: boolean;
  indexQ: UseQueryResult<IndexMeta, unknown>;
  index: IndexMeta | undefined;
  area: Area | null;
  req: RegionRequest | null;
  regionQ: UseQueryResult<RegionData, unknown>;
  region: RegionData | undefined;
  /** Resolved, clamped inclusive range. */
  from: string;
  to: string;
  /** Views over the whole record. */
  view: RegionView | null;
  hview: RegionView | null;
  /** Points of the current mode inside the range. */
  points: ViewPoint[];
  /** Harmonized points inside the range. */
  hpoints: ViewPoint[];
  /** Column start month for calendar/rings rows. */
  rowStart: number;
}

const Ctx = createContext<App | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [url, setUrl] = useUrlState();
  const settings = useSettings();
  const isDemo = resolveSrc(url.src) === "demo";
  const provOpts = useMemo<ProviderOptions>(() => (isDemo ? { viirsStart: settings.viirsStart } : {}), [isDemo, settings.viirsStart]);
  const indexQ = useQuery(indexQuery(url.src, provOpts));
  const index = indexQ.data;
  const lang = url.lang;
  // Back/forward can land on a language that is not loaded yet: load it, then re-render.
  const [, setLangTick] = useState(0);
  useEffect(() => {
    if (!isLangLoaded(lang)) void loadLang(lang).then(() => setLangTick((n) => n + 1));
  }, [lang]);

  const area = useMemo<Area | null>(() => {
    if (url.poly) {
      const b = bboxOfPolygon(url.poly);
      const cx = (b[0] + b[2]) / 2;
      const cy = (b[1] + b[3]) / 2;
      return {
        id: "custom",
        name: tf(lang, "area.custom_name", { lat: digits(lang, cy.toFixed(2)), lon: digits(lang, cx.toFixed(2)) }),
        bbox: b,
        polygon: url.poly,
        km2: polygonAreaKm2(url.poly),
        custom: true,
        country: null,
      };
    }
    const p = index?.presets.find((x) => x.id === url.area);
    if (!p) return null;
    const poly = bboxPolygon(p.bbox);
    return { id: p.id, name: p.name[lang], bbox: p.bbox, polygon: poly, km2: polygonAreaKm2(poly), custom: false, country: p.country };
  }, [url.poly, url.area, index, lang]);

  const req = useMemo<RegionRequest | null>(
    () => (!area ? null : area.custom ? { polygon: area.polygon } : { presetId: area.id }),
    [area],
  );
  const regionQ = useQuery(regionQuery(url.src, provOpts, req));
  const region = req ? regionQ.data : undefined;

  const first = index?.first_month ?? "2000-11";
  const last = index?.last_month ?? first;
  let from = url.from && url.from >= first && url.from <= last ? url.from : first;
  let to = url.to && url.to <= last && url.to >= first ? url.to : last;
  if (from > to) [from, to] = [to, from];

  const view = useMemo(() => (region ? regionView(region, url.mode) : null), [region, url.mode]);
  const hview = useMemo(() => (region ? regionView(region, "harmonized") : null), [region]);
  const points = useMemo(() => (view ? inRange(view.points, from, to) : []), [view, from, to]);
  const hpoints = useMemo(() => (hview ? inRange(hview.points, from, to) : []), [hview, from, to]);
  const rowStart = url.rows === "fire" && region ? region.fire_year_start_month : 1;

  const value: App = {
    url,
    setUrl,
    lang,
    provOpts,
    isDemo,
    indexQ,
    index,
    area,
    req,
    regionQ,
    region,
    from,
    to,
    view,
    hview,
    points,
    hpoints,
    rowStart,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): App {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside AppProvider");
  return v;
}
