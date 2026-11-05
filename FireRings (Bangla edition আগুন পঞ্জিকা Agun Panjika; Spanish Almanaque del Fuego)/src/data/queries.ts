import { queryOptions } from "@tanstack/react-query";
import { getProvider, resolveSrc, type DataSrc, type ProviderOptions } from "./provider";
import { DataError, regionRequestKey, type RegionRequest } from "./types";

const retry = (n: number, e: unknown) => !(e instanceof DataError && e.code !== "load") && n < 2;

/** Cache key part identifying the adapter instance. */
function pk(src: DataSrc, opts: ProviderOptions): string {
  return resolveSrc(src) === "static" ? "static" : `demo:${opts.viirsStart ?? ""}`;
}

export function indexQuery(src: DataSrc, opts: ProviderOptions) {
  return queryOptions({
    queryKey: ["index", pk(src, opts)],
    queryFn: () => getProvider(src, opts).getIndex(),
    staleTime: Infinity,
    retry,
  });
}

export function regionQuery(src: DataSrc, opts: ProviderOptions, req: RegionRequest | null) {
  return queryOptions({
    queryKey: ["region", pk(src, opts), req ? regionRequestKey(req) : "none"],
    queryFn: () => getProvider(src, opts).getRegion(req!),
    enabled: !!req,
    staleTime: Infinity,
    retry,
  });
}

export function hotspotsQuery(src: DataSrc, opts: ProviderOptions, req: RegionRequest | null, year: number | null) {
  return queryOptions({
    queryKey: ["hotspots", pk(src, opts), req ? regionRequestKey(req) : "none", year],
    queryFn: () => getProvider(src, opts).getHotspots(req!, year!),
    enabled: !!req && year != null,
    staleTime: Infinity,
    retry,
  });
}

export function cellsQuery(src: DataSrc, opts: ProviderOptions, bbox: [number, number, number, number] | null) {
  return queryOptions({
    queryKey: ["cells", pk(src, opts), bbox?.map((x) => x.toFixed(3)).join(",") ?? "none"],
    queryFn: () => getProvider(src, opts).getCells(bbox!),
    enabled: !!bbox,
    staleTime: Infinity,
    retry,
  });
}
