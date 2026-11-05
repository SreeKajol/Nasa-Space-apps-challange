import {
  appRoot,
  getProvider,
  resolveSrc,
  STATIC_BASE,
  type DataSrc,
  type ProviderOptions,
} from "@/data/provider";
import type { Provenance } from "@/data/types";
import type { MlGrid, MlIndex, MlProvider, MlRegion } from "./types";

/*
 * MLProvider: same pattern as the DataProvider. Components never know which
 * adapter answers.
 *
 *  - static (VITE_DATA_BASE_URL set): {base}/ml/*.json from the pipeline.
 *    A missing ml/index.json hides every ML element; nothing else changes.
 *  - demo: the ML outputs computed by `npm run ml` on the demo inputs
 *    (public/data/ml/, source "demo") when they match the demo settings,
 *    otherwise synthetic in-browser mock data (lazy chunk), labelled demo.
 */

/** A static .json answered with the app's index.html (SPA fallback) counts as missing. */
async function fetchJson<T>(url: string): Promise<{ data: T; cached: boolean } | null> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    return null;
  }
  if (!res.ok || (res.headers.get("content-type") ?? "").includes("text/html")) return null;
  try {
    return { data: (await res.json()) as T, cached: res.headers.get("x-fr-cache") === "1" };
  } catch {
    return null;
  }
}

export class MlStaticAdapter implements MlProvider {
  private cached = false;
  private source: "live" | "demo" = "live";
  constructor(
    private readonly base: string,
    readonly kind: "static" | "demo-static" = "static",
  ) {}

  private async get<T>(rel: string): Promise<T | null> {
    const r = await fetchJson<T>(new URL(rel, this.base).href);
    if (r?.cached) this.cached = true;
    return r?.data ?? null;
  }

  async getIndex(): Promise<MlIndex | null> {
    const ix = await this.get<MlIndex>("index.json");
    if (!ix || ix.version !== "1.1-ml" || !ix.models?.harmonization) return null;
    this.source = ix.source === "demo" ? "demo" : "live";
    return ix;
  }

  getRegion(id: string): Promise<MlRegion | null> {
    return this.get<MlRegion>(`region/${encodeURIComponent(id)}.json`);
  }

  getGrid(tileId: string): Promise<MlGrid | null> {
    return this.get<MlGrid>(`grid/${tileId}.json`);
  }

  provenance(): Provenance {
    if (this.source === "demo") return "demo";
    return this.cached ? "cache" : "live";
  }

  methodUrl(): string | null {
    return new URL("ml_method.md", this.base).href;
  }
}

/** Demo mode: computed demo outputs when present and matching, else the in-browser mock. */
class MlDemoAdapter implements MlProvider {
  private inner: Promise<MlProvider> | null = null;
  private resolved: MlProvider | null = null;
  constructor(private readonly opts: ProviderOptions) {}

  get kind(): MlProvider["kind"] {
    return this.resolved?.kind ?? "demo-mock";
  }

  private pick(): Promise<MlProvider> {
    this.inner ??= (async () => {
      const computed = new MlStaticAdapter(new URL("data/ml/", appRoot()).href, "demo-static");
      const ix = await computed.getIndex();
      const vs = this.opts.viirsStart ?? "2012-01";
      if (ix && ix.source === "demo" && ix.inputs.viirs_start === vs) return computed;
      const { MlMockAdapter } = await import("./mock");
      return new MlMockAdapter(getProvider("demo", this.opts));
    })().then((p) => (this.resolved = p));
    return this.inner;
  }

  async getIndex() {
    return (await this.pick()).getIndex();
  }
  async getRegion(id: string) {
    return (await this.pick()).getRegion(id);
  }
  async getGrid(tileId: string) {
    return (await this.pick()).getGrid(tileId);
  }
  provenance(): Provenance {
    return "demo";
  }
  methodUrl(): string | null {
    return this.resolved?.methodUrl() ?? null;
  }
}

const providers = new Map<string, MlProvider>();

export function mlKey(src: DataSrc, opts: ProviderOptions): string {
  return resolveSrc(src) === "static" ? "ml-static" : `ml-demo:${opts.viirsStart ?? ""}`;
}

export function getMlProvider(src: DataSrc, opts: ProviderOptions): MlProvider {
  const key = mlKey(src, opts);
  let p = providers.get(key);
  if (!p) {
    p =
      resolveSrc(src) === "static"
        ? new MlStaticAdapter(new URL(`${STATIC_BASE!.replace(/\/?$/, "/")}ml/`, appRoot()).href)
        : new MlDemoAdapter(opts);
    providers.set(key, p);
  }
  return p;
}
