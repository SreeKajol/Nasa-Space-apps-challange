import { describe, expect, it } from "vitest";
import bn from "@/i18n/bn.json";
import en from "@/i18n/en.json";
import es from "@/i18n/es.json";
import { digits, loadLang, monthList, num, t, tf, valueWithRange } from "@/i18n";
import { decodePoly, encodePoly, parseState, serializeState } from "@/state/url";
import { MockAdapter } from "@/data/mock";
import { regionView } from "@/data/view";
import { calendarSummary, nowSummary, onsetSummary } from "@/i18n/summaries";

describe("i18n", () => {
  it("has the same keys in en, bn and es", () => {
    expect(Object.keys(bn).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
  });
  it("keeps the same placeholders in every language", () => {
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
    for (const k of Object.keys(en) as (keyof typeof en)[]) {
      expect(ph(bn[k]), `bn ${k}`).toBe(ph(en[k]));
      expect(ph(es[k]), `es ${k}`).toBe(ph(en[k]));
    }
  });
  it("formats numbers per language, with Bangla digits", async () => {
    await loadLang("bn");
    expect(num("en", 1234)).toBe("1,234");
    expect(num("bn", 1234)).toBe("১,২৩৪");
    expect(num("es", 1234.5, 1)).toBe("1.234,5");
    expect(digits("bn", "2025-26")).toBe("২০২৫-২৬");
    expect(valueWithRange("en", 412, 380, 450, "hotspots")).toBe("412 hotspots (380–450)");
    expect(monthList("en", [3, 4])).toBe("March–April");
    expect(tf("en", "cap.onset_early", { n: 18 })).toBe("18 days earlier than usual");
    expect(t("bn", "status.extreme")).toBe("চরম");
  });
  it("fills summary templates completely in every language", async () => {
    await Promise.all([loadLang("bn"), loadLang("es")]);
    const r = new MockAdapter({ now: new Date("2026-11-05T12:00:00Z") }).regionFile("chittagong-hill-tracts");
    const v = regionView(r, "harmonized");
    for (const lang of ["en", "bn", "es"] as const) {
      for (const s of [nowSummary(lang, r, v.points), onsetSummary(lang, r), calendarSummary(lang, r.climatology, 11, [], "2001")]) {
        expect(s).not.toMatch(/\{\w+\}/);
        expect(s.length).toBeGreaterThan(10);
      }
    }
    expect(nowSummary("bn", r, v.points)).not.toMatch(/[0-9]/);
  });
});

describe("URL state", () => {
  it("round-trips the shareable view", () => {
    const s = parseState("?lang=bn&area=sundarbans&from=2015-01&to=2026-10&mode=viirs&tab=rings&view=anomaly&rows=fire&m=2022-03");
    expect(s).toMatchObject({ lang: "bn", area: "sundarbans", from: "2015-01", mode: "viirs", tab: "rings", view: "anomaly", rows: "fire", m: "2022-03" });
    expect(parseState(serializeState(s))).toEqual(s);
  });
  it("encodes polygons compactly and rejects junk", () => {
    const poly: [number, number][] = [
      [89.1, 22.2],
      [89.5, 22.2],
      [89.5, 22.6],
    ];
    expect(decodePoly(encodePoly(poly))).toEqual(poly);
    expect(decodePoly("1_2~3")).toBeNull();
    expect(parseState("?mode=nonsense&tab=x").mode).toBe("harmonized");
  });
});
