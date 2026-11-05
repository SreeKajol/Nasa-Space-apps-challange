import { describe, expect, it } from "vitest";
import {
  circlePolygon,
  climatologyOf,
  deriveRegion,
  onsetOf,
  pearson,
  percentileOf,
  pointInPolygon,
  polygonAreaKm2,
  quantileSorted,
  seasonLabel,
  seasonOf,
  statusOf,
  tileIdsForBbox,
  withPercentiles,
  type BaseRow,
} from "./derive";
import { monthsBetween, parseYm } from "../data/types";

const row = (ym: string, h: number): BaseRow => ({ ym, harmonized: h, low: h * 0.9, high: h * 1.1, modis_raw: Math.round(h), viirs_raw: null });

describe("quantiles and percentiles", () => {
  it("matches linear interpolation (d3.quantileSorted)", () => {
    expect(quantileSorted([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantileSorted([10], 0.9)).toBe(10);
    expect(quantileSorted([], 0.5)).toBe(0);
  });
  it("uses mid-rank for ties", () => {
    expect(percentileOf(5, [1, 5, 9])).toBeCloseTo(50);
    expect(percentileOf(10, [1, 2, 3])).toBe(100);
    expect(percentileOf(0, [1, 2, 3])).toBe(0);
  });
  it("maps percentiles to status bands", () => {
    expect(statusOf(10)).toBe("below");
    expect(statusOf(25)).toBe("below");
    expect(statusOf(50)).toBe("near");
    expect(statusOf(80)).toBe("above");
    expect(statusOf(90)).toBe("extreme");
  });
  it("computes Pearson correlation", () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1);
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1);
  });
});

describe("seasons", () => {
  it("labels fire years", () => {
    expect(seasonOf("2025-11", 11)).toBe("2025-26");
    expect(seasonOf("2026-03", 11)).toBe("2025-26");
    expect(seasonOf("2026-03", 1)).toBe("2026");
    expect(seasonLabel(1999, 7)).toBe("1999-00");
  });
});

describe("withPercentiles / climatology", () => {
  const months = monthsBetween("2001-01", "2010-12");
  const rows = months.map((ym, i) => row(ym, parseYm(ym).m === 3 ? 100 + i : 10));
  it("ranks each month against the same calendar month", () => {
    const pts = withPercentiles(rows);
    const lastMarch = pts.filter((p) => p.ym.endsWith("-03")).at(-1)!;
    expect(lastMarch.percentile).toBe(95); // highest of 10 → (9 + 0.5) / 10
    expect(lastMarch.z).toBeGreaterThan(1);
  });
  it("excludes a partial last month from the history sample", () => {
    const withPartial = [...rows, row("2011-01", 0)];
    const pts = withPercentiles(withPartial, true);
    expect(pts.at(-1)!.percentile).toBe(0);
    const d = deriveRegion(withPartial, 1, true);
    expect(d.current.ym).toBe("2010-12");
  });
  it("builds a 12-month climatology", () => {
    const c = climatologyOf([[1, 2, 3], [], [10, 20, 30, 40], [], [], [], [], [], [], [], [], []]);
    expect(c).toHaveLength(12);
    expect(c[0]!.median).toBe(2);
    expect(c[2]!.p90).toBe(37);
  });
});

describe("onset", () => {
  it("detects an early season against the typical crossing date", () => {
    const months = monthsBetween("2000-11", "2010-10");
    // Typical season: activity mostly in Feb–Apr. Last season starts in December instead.
    const shape = [0, 0, 1, 5, 10, 6, 1, 0, 0, 0, 0, 0]; // Jan..Dec
    const rows = months.map((ym) => {
      const { m } = parseYm(ym);
      let v = shape[m - 1]!;
      if (ym === "2009-12") v = 6;
      return row(ym, v);
    });
    const d = deriveRegion(rows, 11);
    const o = onsetOf(d.monthly, d.climatology, 11)!;
    expect(o.season).toBe("2009-10");
    expect(o.days_diff).toBeLessThan(0);
  });
  it("returns null when there is no activity at all", () => {
    const rows = monthsBetween("2000-01", "2004-12").map((ym) => row(ym, 0));
    const d = deriveRegion(rows, 1);
    expect(d.onset).toBeNull();
  });
});

describe("geometry", () => {
  const square: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  it("tests points in polygons", () => {
    expect(pointInPolygon(0.5, 0.5, square)).toBe(true);
    expect(pointInPolygon(1.5, 0.5, square)).toBe(false);
  });
  it("approximates areas in km²", () => {
    expect(polygonAreaKm2(square)).toBeGreaterThan(12000);
    expect(polygonAreaKm2(square)).toBeLessThan(12600);
    const circle = circlePolygon(90, 23, 10);
    expect(polygonAreaKm2(circle)).toBeGreaterThan(300); // π·10² ≈ 314
    expect(polygonAreaKm2(circle)).toBeLessThan(320);
  });
  it("lists grid tiles covering a bbox", () => {
    expect(tileIdsForBbox([88.5, 21.5, 90.5, 22.5], 2)).toEqual(["20_88", "20_90", "22_88", "22_90"]);
    expect(tileIdsForBbox([88.5, 20.5, 89.5, 21.5], 2)).toEqual(["20_88"]);
  });
});
