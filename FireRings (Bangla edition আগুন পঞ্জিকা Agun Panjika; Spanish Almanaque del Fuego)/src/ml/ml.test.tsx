import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { MockAdapter } from "@/data/mock";
import bn from "./i18n/bn.json";
import en from "./i18n/en.json";
import es from "./i18n/es.json";
import { alertForecast, futureForecasts, type MlState } from "./hooks";
import { featureValue, loadMlStrings } from "./i18n";
import { MlMockAdapter } from "./mock";
import { MlStaticAdapter } from "./provider";
import type { MlForecast, MlIndex, MlRegion } from "./types";
import { waterfallSteps } from "./WhyThisMonth";

// jsdom has no ResizeObserver (the charts measure their width with it).
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const NOW = new Date("2026-11-05T12:00:00Z");
const data = new MockAdapter({ now: NOW });
const mock = new MlMockAdapter(data);
let index: MlIndex;
let region: MlRegion;

beforeAll(async () => {
  await Promise.all([loadMlStrings("bn"), loadMlStrings("es")]);
  index = await mock.getIndex();
  region = (await mock.getRegion("sundarbans"))!;
});

const f = (over: Partial<MlForecast>): MlForecast => ({
  ym: "2026-12",
  p: [0.2, 0.25, 0.55],
  set: ["near", "above"],
  skilful: true,
  rpss: 0.12,
  drivers: [],
  narrative: { en: "x", bn: "x", es: "x" },
  ...over,
});

describe("ML strings", () => {
  it("has the same keys and placeholders in en, bn and es", () => {
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
    expect(Object.keys(bn).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    for (const k of Object.keys(en) as (keyof typeof en)[]) {
      expect(ph(bn[k]), `bn ${k}`).toBe(ph(en[k]));
      expect(ph(es[k]), `es ${k}`).toBe(ph(en[k]));
    }
  });
  it("formats feature values with units and Bangla digits", () => {
    expect(featureValue("en", index, "precip3_anom", -42)).toBe("−42 mm");
    expect(featureValue("bn", index, "precip3_anom", -42)).toBe("−৪২ মিমি");
    expect(featureValue("en", index, "lc_code", "mangrove")).toBe("Mangrove forest");
  });
});

describe("ML mock adapter (contract v1.1 shapes)", () => {
  it("serves an index with every section the UI reads", () => {
    expect(index.version).toBe("1.1-ml");
    expect(index.source).toBe("demo");
    expect(index.models.harmonization.conformal.by_group.length).toBeGreaterThan(3);
    expect(index.global_drivers.harmonization).toHaveLength(10);
    expect(Object.keys(index.raw_trained_trend!)).toEqual(index.regions);
  });
  it("derives the fake-trend evidence from the demo record: raw jumps at VIIRS, harmonized does not", () => {
    const raw = index.raw_trained_trend!.sundarbans!;
    const harm = index.harmonized_trained_trend!.sundarbans!;
    expect(raw.jump_ratio!).toBeGreaterThan(2.5);
    expect(harm.jump_ratio!).toBeLessThan(1.6);
  });
  it("serves region files whose explanations end at the ML estimate", () => {
    const m = region.monthly_ml.find((x) => x.ym === "2022-03")!;
    const e = region.explain["2022-03"]!;
    expect(e.end).toBeCloseTo(m.ml_harmonized, 1);
    expect(m.lo90).toBeLessThanOrEqual(m.ml_harmonized);
    expect(m.hi90).toBeGreaterThanOrEqual(m.ml_harmonized);
    const steps = waterfallSteps("en", index, e);
    expect(steps[0]!.to).toBeCloseTo(e.start, 3);
    expect(steps.at(-1)!.to).toBeCloseTo(e.end, 3);
    expect(steps.at(-2)!.to).toBeCloseTo(e.end, 0);
  });
});

describe("FireCast rules", () => {
  it("never shows past months as forecasts", () => {
    const r = { ...region, firecast: [f({ ym: "2026-10" }), f({ ym: "2026-12" })] };
    expect(futureForecasts(r, "2026-11").map((x) => x.ym)).toEqual(["2026-12"]);
  });
  it("alerts only when skilful, P(above) >= 0.5 and 'below' is ruled out", () => {
    expect(alertForecast([f({})])).not.toBeNull();
    expect(alertForecast([f({ skilful: false })])).toBeNull();
    expect(alertForecast([f({ p: [0.3, 0.3, 0.4] })])).toBeNull();
    expect(alertForecast([f({ set: ["below", "near", "above"] })])).toBeNull();
  });
});

describe("static ML adapter", () => {
  it("treats a missing file or an SPA index.html fallback as 'no ML data'", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith("index.json")
        ? new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } })
        : new Response("", { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const a = new MlStaticAdapter("https://example.org/data/ml/");
    expect(await a.getIndex()).toBeNull();
    expect(await a.getRegion("x")).toBeNull();
    vi.unstubAllGlobals();
  });
  it("labels files from the pipeline live, demo files demo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ...index, source: "live" }), {
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const a = new MlStaticAdapter("https://example.org/data/ml/");
    expect(await a.getIndex()).not.toBeNull();
    expect(a.provenance()).toBe("live");
    vi.unstubAllGlobals();
  });
});

/* ---------- components, with the data hooks stubbed ---------- */

let mlState: MlState;
vi.mock("./hooks", async (orig) => ({
  ...(await orig<typeof import("./hooks")>()),
  useMl: () => mlState,
}));
vi.mock("@/state/app", () => ({
  useApp: () => ({
    lang: "en",
    area: { id: "sundarbans", custom: false },
    index: { last_month: "2026-11", presets: [] },
  }),
}));

function state(over: Partial<MlState> = {}): MlState {
  return {
    ready: true,
    missing: false,
    lang: "en",
    index,
    region,
    regionPending: false,
    provider: mock,
    prov: "demo",
    flavour: "mock",
    ...over,
  };
}

describe("Intelligence components", () => {
  it("shows the coverage headline, the benchmark and the safety note", async () => {
    mlState = state();
    const { default: IntelligenceTab } = await import("./IntelligenceTab");
    render(<IntelligenceTab />);
    expect(screen.getByText("How sure are we?")).toBeInTheDocument();
    expect(screen.getByText(/verified coverage 91% on unseen years/)).toBeInTheDocument();
    expect(screen.getByText("Model vs baseline")).toBeInTheDocument();
    expect(screen.getByText(/Not for life-safety decisions/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Train on raw vs harmonized" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getAllByRole("button", { name: "View as table" }).length).toBeGreaterThan(2);
  });
  it("never shows probabilities without the skill badge", async () => {
    mlState = state();
    const { default: OutlookDetails } = await import("./OutlookDetails");
    render(
      <OutlookDetails
        forecasts={[
          f({ skilful: false, narrative: { en: "No reliable outlook.", bn: "", es: "" } }),
          f({ ym: "2027-01" }),
        ]}
      />,
    );
    const items = screen.getAllByRole("listitem").filter((li) => li.querySelector("h4"));
    expect(items[0]!.querySelector('[role="img"]')).toBeNull();
    expect(items[0]!.textContent).toContain("No reliable outlook");
    expect(items[1]!.querySelector('[role="img"]')).not.toBeNull();
    expect(items[1]!.textContent).toContain("Better than climatology");
  });
  it("renders nothing when the ML files are missing", async () => {
    mlState = state({ ready: false, missing: true, index: null, region: null });
    const { default: IntelligenceTab } = await import("./IntelligenceTab");
    const { container } = render(<IntelligenceTab />);
    expect(container).toBeEmptyDOMElement();
  });
});
