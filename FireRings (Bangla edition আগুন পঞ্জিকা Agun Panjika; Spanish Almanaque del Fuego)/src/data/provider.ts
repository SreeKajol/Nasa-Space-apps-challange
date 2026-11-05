import { DEFAULT_VIIRS_START, MockAdapter } from "./mock";
import { StaticJsonAdapter } from "./staticJson";
import type { DataProvider } from "./types";

export type DataSrc = "demo" | "static";

/** Base URL of the pipeline's static files, if configured at build time. */
export const STATIC_BASE: string | undefined = import.meta.env.VITE_DATA_BASE_URL || undefined;

/** The app's root URL, also from the /almanac/ page, so relative data URLs resolve the same everywhere. */
export function appRoot(): string {
  const href = window.location.href.split("#")[0]!.split("?")[0]!;
  return href.replace(/almanac\/(index\.html)?$/, "").replace(/index\.html$/, "");
}

/** Real data whenever the pipeline URL is configured; otherwise the synthetic demo. */
export const DEFAULT_SRC: DataSrc = STATIC_BASE ? "static" : "demo";

export function availableSources(): DataSrc[] {
  return STATIC_BASE ? ["static", "demo"] : ["demo"];
}

export interface ProviderOptions {
  /** Demo only: test the app with VIIRS starting in 2018 (NOAA-20/21 only). */
  viirsStart?: string;
}

const providers = new Map<string, DataProvider>();

export function resolveSrc(src: DataSrc): DataSrc {
  return src === "static" && STATIC_BASE ? "static" : "demo";
}

/**
 * One DataProvider interface, two adapters. Components only ever call this;
 * switching adapters changes no component.
 */
export function getProvider(src: DataSrc, opts: ProviderOptions = {}): DataProvider {
  const resolved = resolveSrc(src);
  const vs = opts.viirsStart ?? DEFAULT_VIIRS_START;
  const key = resolved === "static" ? "static" : `demo:${vs}`;
  let p = providers.get(key);
  if (!p) {
    p = resolved === "static" ? new StaticJsonAdapter(new URL(STATIC_BASE!, appRoot()).href) : new MockAdapter({ viirsStart: vs });
    providers.set(key, p);
  }
  return p;
}
