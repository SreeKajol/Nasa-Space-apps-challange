import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveRegion } from "../compute/derive";
import { MockAdapter } from "./mock";
import { RealWithDemoFallback } from "./provider";
import { parseHotspotCsv, StaticJsonAdapter } from "./staticJson";
import { DataError, type DataProvider, type GridTile, type IndexMeta, type RegionData } from "./types";
import { regionView } from "./view";

const NOW = new Date("2026-11-05T12:00:00Z");

describe("MockAdapter — data contract", () => {
  const a = new MockAdapter({ now: NOW });

  it("has an index matching the contract", async () => {
    const idx = await a.getIndex();
    expect(Object.keys(idx).sort()).toEqual(["first_month", "generated_at", "grid", "last_month", "presets", "sensors", "source", "version", "viirs_start"]);
    expect(idx.first_month).toBe("2000-11");
    expect(idx.last_month).toBe("2026-11");
    expect(idx.source).toBe("demo");
    expect(idx.presets.map((p) => p.id)).toEqual(["sundarbans", "chittagong-hill-tracts", "parana-delta", "corrientes"]);
  });

  it("produces region files with every contract field", () => {
    const r = a.regionFile("sundarbans");
    expect(Object.keys(r).sort()).toEqual(["climatology", "context", "current", "fire_year_start_month", "id", "monthly", "onset", "outlook", "validation"]);
    expect(Object.keys(r.monthly[0]!).sort()).toEqual(["harmonized", "high", "low", "modis_raw", "percentile", "viirs_raw", "ym", "z"]);
    expect(r.climatology).toHaveLength(12);
    expect(r.current.ym).toBe("2026-10"); // latest complete month
    expect(r.validation!.corr_raw).toBeGreaterThan(0.45);
    expect(r.validation!.corr_raw).toBeLessThan(0.75);
    expect(r.validation!.corr_harmonized).toBeGreaterThan(0.85);
  });

  it("has no VIIRS before viirs_start and wider intervals before it", () => {
    const r = a.regionFile("parana-delta");
    const before = r.monthly.filter((p) => p.ym < "2012-01");
    const after = r.monthly.filter((p) => p.ym >= "2012-01" && p.harmonized > 0);
    expect(before.every((p) => p.viirs_raw === null)).toBe(true);
    expect(after.every((p) => p.viirs_raw !== null)).toBe(true);
    const width = (ps: typeof before) => ps.reduce((s, p) => s + (p.high - p.low) / Math.max(1e-9, p.harmonized), 0) / ps.length;
    expect(width(before.filter((p) => p.harmonized > 0))).toBeGreaterThan(width(after));
  });

  it("makes raw VIIRS ≈ 3–5× raw MODIS, so raw jumps while harmonized does not", () => {
    const r = a.regionFile("chittagong-hill-tracts");
    const post = r.monthly.filter((p) => p.ym >= "2012-01" && (p.modis_raw ?? 0) > 20);
    const ratio = post.reduce((s, p) => s + p.viirs_raw! / p.modis_raw!, 0) / post.length;
    expect(ratio).toBeGreaterThan(3);
    expect(ratio).toBeLessThan(5);
  });

  it("puts the extreme years where the brief says", () => {
    const year = (r: RegionData, y: string) => r.monthly.filter((p) => p.ym.startsWith(y)).reduce((s, p) => s + p.harmonized, 0);
    const delta = a.regionFile("parana-delta");
    const years = Array.from({ length: 25 }, (_, i) => String(2001 + i));
    const top2 = [...years].sort((x, y) => year(delta, y) - year(delta, x)).slice(0, 2);
    expect(top2.sort()).toEqual(["2020", "2022"]);
    const corr = a.regionFile("corrientes");
    const jan = (y: number) => corr.monthly.find((p) => p.ym === `${y}-01`)!.harmonized;
    expect(jan(2022)).toBeGreaterThan(Math.max(...[2015, 2016, 2017, 2018, 2019, 2021, 2023].map(jan)));
  });

  it("respects the viirs_start test switch", async () => {
    const b = new MockAdapter({ viirsStart: "2018-01", now: NOW });
    const r = b.regionFile("sundarbans");
    expect(r.monthly.find((p) => p.viirs_raw != null)!.ym).toBe("2018-01");
    expect((await b.getIndex()).sensors).not.toContain("VIIRS_SNPP");
  });

  it("sums cells for custom polygons and flags them approximate", async () => {
    const r = await a.getRegion({ polygon: [[89, 22], [89.5, 22], [89.5, 22.4], [89, 22.4]] });
    expect(r.approximate).toBe(true);
    expect(r.cell_count).toBeGreaterThan(50);
    expect(r.validation).toBeUndefined();
    await expect(a.getRegion({ polygon: [[0, 0], [60, 0], [60, 60], [0, 60]] })).rejects.toBeInstanceOf(DataError);
  });

  it("only assigns satellites that were flying", async () => {
    const { rows } = await a.getHotspots({ presetId: "corrientes" }, 2015);
    expect(rows.length).toBeGreaterThan(100);
    expect(rows.some((r) => r.satellite === "NOAA-20" || r.satellite === "NOAA-21")).toBe(false);
  });

  it("is deterministic", () => {
    const x = new MockAdapter({ now: NOW }).regionFile("sundarbans");
    const y = new MockAdapter({ now: NOW }).regionFile("sundarbans");
    expect(x).toEqual(y);
  });
});

describe("view modes", () => {
  it("returns raw values and null where a sensor has no data", () => {
    const r = new MockAdapter({ now: NOW }).regionFile("sundarbans");
    const v = regionView(r, "viirs");
    expect(v.points.find((p) => p.ym === "2005-03")!.value).toBeNull();
    expect(v.hasInterval).toBe(false);
    expect(regionView(r, "harmonized").points[0]!.value).toBe(r.monthly[0]!.harmonized);
  });
});

describe("StaticJsonAdapter", () => {
  const index: IndexMeta = {
    version: "1",
    generated_at: "2026-11-01T00:00:00Z",
    first_month: "2020-01",
    last_month: "2020-03",
    presets: [{ id: "p1", name: { en: "P", bn: "P", es: "P" }, country: "BD", bbox: [90, 22, 91, 23] }],
    viirs_start: "2020-02",
    sensors: ["MODIS_Terra"],
    grid: { cell_km: 5.5, tile_deg: 2 },
    source: "live",
  };
  const tile: GridTile = {
    cells: [
      { id: "a", lat: 22.5, lon: 90.5, m: { "2020-01": [1, 0.8, 1.2, 1, null], "2020-02": [2, 1.5, 2.5, 2, 6], "2020-03": [3, 2, 4, 3, 9] } },
      { id: "b", lat: 22.6, lon: 90.6, m: { "2020-01": [10, 8, 12, 10, null], "2020-02": [20, 15, 25, 20, 60], "2020-03": [30, 20, 40, 30, 90] } },
      { id: "out", lat: 23.5, lon: 90.5, m: { "2020-01": [100, 80, 120, 100, null] } },
    ],
  };
  const files: Record<string, unknown> = { "index.json": index, "grid/22_90.json": tile };

  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(map: Record<string, unknown>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const key = url.replace("https://data.test/", "");
        if (!(key in map)) return new Response("nope", { status: 404 });
        const v = map[key];
        return new Response(typeof v === "string" ? v : JSON.stringify(v), { status: 200 });
      }),
    );
  }

  it("sums cells whose centres fall inside a custom polygon", async () => {
    stubFetch(files);
    const s = new StaticJsonAdapter("https://data.test/");
    const r = await s.getRegion({ polygon: [[90.4, 22.4], [90.7, 22.4], [90.7, 22.7], [90.4, 22.7]] });
    expect(r.cell_count).toBe(2);
    expect(r.approximate).toBe(true);
    expect(r.monthly.map((p) => p.harmonized)).toEqual([11, 22, 33]);
    expect(r.monthly[0]!.viirs_raw).toBeNull();
    expect(r.monthly[2]!.viirs_raw).toBe(99);
    expect(r.monthly[2]!.low).toBe(22);
    expect(r.source).toBe("live");
  });

  it("reports a clear error for a missing file", async () => {
    stubFetch({ "index.json": index });
    const s = new StaticJsonAdapter("https://data.test");
    await expect(s.getRegion({ presetId: "p1" })).rejects.toMatchObject({ code: "missing" });
  });

  it("parses hotspot CSVs", () => {
    const rows = parseHotspotCsv("latitude,longitude,acq_datetime_utc,sensor,satellite,confidence,frp_mw,type\n22.1,90.2,2024-03-01T07:30:00Z,VIIRS,NOAA-20,n,12.5,0\n");
    expect(rows).toEqual([{ latitude: 22.1, longitude: 90.2, acq_datetime_utc: "2024-03-01T07:30:00Z", sensor: "VIIRS", satellite: "NOAA-20", confidence: "n", frp_mw: 12.5, type: 0 }]);
  });
});

describe("Real-data snapshot (make snapshot)", () => {
  const base: IndexMeta = {
    version: "1",
    generated_at: "2026-11-14T06:00:00Z",
    first_month: "2020-01",
    last_month: "2020-03",
    presets: [
      { id: "p1", name: { en: "P1", bn: "P1", es: "P1" }, country: "BD", bbox: [90, 22, 91, 23] },
      { id: "p2", name: { en: "P2", bn: "P2", es: "P2" }, country: "AR", bbox: [-60, -34, -59, -33] },
    ],
    viirs_start: "2018-04",
    sensors: ["MODIS_Terra", "MODIS_Aqua", "VIIRS_NOAA20"],
    grid: { cell_km: 5.5, tile_deg: 2 },
    source: "cache",
    data_mode: "real",
    regions_status: { p1: "real", p2: "missing" },
  };
  const rows = [{ ym: "2020-01", harmonized: 1, low: 0.5, high: 2, modis_raw: 1, viirs_raw: null }];
  const regionFile = { id: "p1", fire_year_start_month: 11, ...deriveRegion(rows, 11) };
  const demoRegion = { ...regionFile, id: "p2", source: "demo" } as RegionData;
  const demo: DataProvider = {
    kind: "demo",
    getIndex: async () => base,
    getRegion: async () => demoRegion,
    getHotspots: async () => ({ rows: [], source: "demo" }),
    getCells: async () => ({ months: [], cell_deg: 0.05, cells: [], source: "demo" }),
  };

  afterEach(() => vi.unstubAllGlobals());

  function stub(map: Record<string, unknown>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const key = url.replace("https://real.test/", "");
        return key in map ? new Response(JSON.stringify(map[key]), { status: 200 }) : new Response("nope", { status: 404 });
      }),
    );
  }

  it("labels the snapshot cache, with the run date", async () => {
    stub({ "index.json": base, "region/p1.json": regionFile });
    const r = await new StaticJsonAdapter("https://real.test").getRegion({ presetId: "p1" });
    expect(r.source).toBe("cache");
    expect(r.saved_at).toBe("2026-11-14T06:00:00Z");
  });

  it("falls back to demo only for areas the real run has no data for", async () => {
    stub({ "index.json": base, "region/p1.json": regionFile });
    const p = new RealWithDemoFallback(new StaticJsonAdapter("https://real.test"), () => demo);
    expect((await p.getRegion({ presetId: "p1" })).source).toBe("cache");
    expect((await p.getRegion({ presetId: "p2" })).source).toBe("demo");
    // A real area without a CSV for a year had no detections: empty, never demo rows.
    expect(await p.getHotspots({ presetId: "p1" }, 2003)).toEqual({ rows: [], source: "cache" });
    expect((await p.getHotspots({ presetId: "p2" }, 2003)).source).toBe("demo");
  });

  it("keeps the old behaviour for pipelines without data_mode real", async () => {
    stub({ "index.json": { ...base, data_mode: undefined, regions_status: undefined, source: "live" } });
    const p = new RealWithDemoFallback(new StaticJsonAdapter("https://real.test"), () => demo);
    await expect(p.getRegion({ presetId: "p1" })).rejects.toMatchObject({ code: "missing" });
  });
});
