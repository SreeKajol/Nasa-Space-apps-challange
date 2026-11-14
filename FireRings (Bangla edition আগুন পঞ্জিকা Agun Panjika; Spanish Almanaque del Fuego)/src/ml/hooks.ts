import { useQuery } from "@tanstack/react-query";
import type { Provenance } from "@/data/types";
import type { Lang } from "@/i18n";
import { useApp } from "@/state/app";
import { loadMlStrings } from "./i18n";
import { getMlProvider, mlKey } from "./provider";
import type { MlForecast, MlIndex, MlProvider, MlRegion } from "./types";

export interface MlState {
  /** True once the ML index and this language's strings are loaded. When false, render nothing. */
  ready: boolean;
  /** True when the ML files are known to be absent (every ML element stays hidden). */
  missing: boolean;
  lang: Lang;
  index: MlIndex | null;
  /** ML file of the selected preset area (null for custom areas or when absent). */
  region: MlRegion | null;
  regionPending: boolean;
  provider: MlProvider;
  prov: Provenance;
  /** "computed" = real models on demo inputs; "mock" = in-browser illustration; "live" = pipeline. */
  flavour: "live" | "computed" | "mock";
}

/** The Intelligence layer's data for the current app state. Hidden (ready=false) when ml/index.json is missing. */
export function useMl(): MlState {
  const { url, provOpts, lang, area } = useApp();
  const key = mlKey(url.src, provOpts);
  const provider = getMlProvider(url.src, provOpts);
  const idxQ = useQuery({
    queryKey: ["ml-index", key],
    queryFn: () => provider.getIndex(),
    staleTime: Infinity,
    retry: false,
  });
  const index = idxQ.data ?? null;
  const strQ = useQuery({
    queryKey: ["ml-strings", lang],
    queryFn: () => loadMlStrings(lang),
    staleTime: Infinity,
    enabled: !!index,
  });
  const presetId = area && !area.custom ? area.id : null;
  const hasRegion = !!index && !!presetId && (index.regions ?? []).includes(presetId);
  const regQ = useQuery({
    queryKey: ["ml-region", key, presetId],
    queryFn: () => provider.getRegion(presetId!),
    staleTime: Infinity,
    retry: false,
    enabled: hasRegion,
  });
  const prov = provider.provenance();
  return {
    ready: !!index && strQ.data === lang,
    missing: idxQ.isError || (idxQ.isSuccess && !index),
    lang,
    index,
    region: hasRegion ? (regQ.data ?? null) : null,
    regionPending: hasRegion && regQ.isPending,
    provider,
    prov,
    flavour: provider.kind === "demo-mock" ? "mock" : prov === "demo" ? "computed" : "live",
  };
}

/** FireCast months still in the future for the loaded record (stale files never show past "forecasts"). */
export function futureForecasts(
  region: MlRegion | null,
  lastMonth: string | undefined,
): MlForecast[] {
  if (!region || !lastMonth) return [];
  return region.firecast.filter((f) => f.ym > lastMonth);
}

/** The alert rule: skilful AND P(above) >= 0.5 AND the 90% set excludes "below". */
export function alertForecast(fs: MlForecast[]): MlForecast | null {
  return fs.find((f) => f.skilful && f.p[2] >= 0.5 && !f.set.includes("below")) ?? null;
}
