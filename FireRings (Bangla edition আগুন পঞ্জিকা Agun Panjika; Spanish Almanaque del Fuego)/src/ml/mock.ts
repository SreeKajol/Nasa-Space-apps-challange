import {
  addMonths,
  hashString,
  mulberry32,
  type DataProvider,
  type RegionData,
  type Tri,
} from "@/data/types";
import { capFirst, monthYear, num } from "@/i18n";
import bn from "./i18n/bn.json";
import en from "./i18n/en.json";
import es from "./i18n/es.json";
import type {
  Cls,
  MlContribution,
  MlExplain,
  MlForecast,
  MlGrid,
  MlIndex,
  MlProvider,
  MlRegion,
  MlTrend,
} from "./types";

/*
 * DEMO ONLY: illustrative ML outputs generated in the browser, used when the
 * computed demo files (public/data/ml, from `npm run ml`) are absent. Shapes
 * match contract v1.1 exactly. Where possible values are derived from the
 * demo region data (yearly trends, outlook probabilities, cell activity);
 * model metrics are illustrative. Everything is labelled "demo".
 */

const T = (en: string, bn: string, es: string): Tri => ({ en, bn, es });
const FEATURES: Record<string, Tri> = {
  modis_n: T("MODIS detections", "MODIS শনাক্তকরণ", "Detecciones MODIS"),
  frp_mean: T(
    "Average fire intensity (FRP)",
    "গড় আগুনের তীব্রতা (FRP)",
    "Intensidad media del fuego (FRP)",
  ),
  frp_max: T(
    "Strongest fire (max FRP)",
    "সবচেয়ে তীব্র আগুন (সর্বোচ্চ FRP)",
    "Fuego más intenso (FRP máx.)",
  ),
  scan_mean: T("MODIS viewing angle", "MODIS-এর দেখার কোণ", "Ángulo de visión de MODIS"),
  pix_km2: T("MODIS pixel size", "MODIS পিক্সেলের আকার", "Tamaño de píxel de MODIS"),
  day_share: T("Share seen in daytime", "দিনে দেখা অংশ", "Proporción vista de día"),
  lc_code: T("Land cover", "ভূমির আচ্ছাদন", "Cobertura del suelo"),
  ndvi_anom: T("Greenness vs normal", "স্বাভাবিকের তুলনায় সবুজতা", "Verdor respecto de lo normal"),
  reg_modis: T(
    "MODIS activity across the region this month",
    "এই মাসে পুরো অঞ্চলে MODIS-এর কার্যকলাপ",
    "Actividad de MODIS en toda la región este mes",
  ),
  nbr_modis: T(
    "MODIS activity in nearby cells",
    "আশপাশের সেলে MODIS-এর কার্যকলাপ",
    "Actividad de MODIS en celdas cercanas",
  ),
  season: T("Time of year", "বছরের সময়", "Época del año"),
  precip3_anom: T(
    "Rainfall, last 3 months vs normal",
    "গত ৩ মাসের বৃষ্টি, স্বাভাবিকের তুলনায়",
    "Lluvia de los últimos 3 meses respecto de lo normal",
  ),
  lag0_anom: T(
    "Latest month's fire activity vs normal",
    "সর্বশেষ মাসের আগুন, স্বাভাবিকের তুলনায়",
    "Actividad del último mes respecto de lo normal",
  ),
  lag1_anom: T(
    "Fire activity a month earlier vs normal",
    "এক মাস আগের আগুন, স্বাভাবিকের তুলনায়",
    "Actividad de un mes antes respecto de lo normal",
  ),
  t2m_anom: T(
    "Temperature vs normal",
    "স্বাভাবিকের তুলনায় তাপমাত্রা",
    "Temperatura respecto de lo normal",
  ),
  rh_anom: T("Humidity vs normal", "স্বাভাবিকের তুলনায় আর্দ্রতা", "Humedad respecto de lo normal"),
  clim_log: T(
    "Typical activity for this month",
    "এই মাসের স্বাভাবিক মাত্রা",
    "Actividad típica del mes",
  ),
};
const UNITS: Record<string, string> = {
  modis_n: "cell-days",
  frp_mean: "MW",
  frp_max: "MW",
  scan_mean: "deg",
  pix_km2: "km2",
  day_share: "%",
  lc_code: "class",
  ndvi_anom: "",
  reg_modis: "cell-days",
  nbr_modis: "cell-days per cell",
  season: "month",
  precip3_anom: "mm",
  lag0_anom: "x",
  lag1_anom: "x",
  t2m_anom: "C",
  rh_anom: "%",
  clim_log: "hotspots",
};
const LANDCOVER: Record<string, Tri> = {
  cropland: T("Cropland", "ফসলি জমি", "Cultivos"),
  crop_mosaic: T(
    "Shifting-cultivation mosaic",
    "জুম চাষের মিশ্র এলাকা",
    "Mosaico de cultivo itinerante",
  ),
  grassland: T("Grassland", "তৃণভূমি", "Pastizal"),
  wetland: T("Wetland", "জলাভূমি", "Humedal"),
  savanna: T("Savanna", "সাভানা", "Sabana"),
  forest: T("Forest", "বন", "Bosque"),
  mangrove: T("Mangrove forest", "ম্যানগ্রোভ বন", "Manglar"),
};
const LC_OF: Record<string, string> = {
  sundarbans: "mangrove",
  "chittagong-hill-tracts": "crop_mosaic",
  "parana-delta": "wetland",
  corrientes: "grassland",
};
const DICT = { en, bn, es };
const CLS: Cls[] = ["below", "near", "above"];

const r3 = (x: number) => Math.round(x * 1000) / 1000;

function trendOf(years: number[], values: number[], vs: number): MlTrend {
  const slopes: number[] = [];
  let s = 0;
  for (let i = 0; i < years.length; i++)
    for (let j = i + 1; j < years.length; j++) {
      slopes.push((values[j]! - values[i]!) / (years[j]! - years[i]!));
      s += Math.sign(values[j]! - values[i]!);
    }
  slopes.sort((a, b) => a - b);
  const n = years.length;
  const varS = (n * (n - 1) * (2 * n + 5)) / 18;
  const z = s === 0 ? 0 : (s - Math.sign(s)) / Math.sqrt(varS);
  const p = 2 * (1 - normCdf(Math.abs(z)));
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const before = values.filter((_, i) => years[i]! < vs);
  const after = values.filter((_, i) => years[i]! >= vs);
  return {
    years,
    values: values.map((v) => Math.round(v)),
    slope: r3(slopes[Math.floor(slopes.length / 2)] ?? 0),
    p: r3(p),
    jump_ratio: r3(mean(after) / Math.max(1e-9, mean(before))),
  };
}

function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * x);
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  return (
    1 - d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
  );
}

function yearly(
  r: RegionData,
  pick: (p: RegionData["monthly"][number]) => number,
): { years: number[]; values: number[] } {
  const by = new Map<number, { s: number; n: number }>();
  for (const p of r.monthly) {
    const y = Number(p.ym.slice(0, 4));
    const e = by.get(y) ?? { s: 0, n: 0 };
    e.s += pick(p);
    e.n += 1;
    by.set(y, e);
  }
  const years = [...by.keys()].filter((y) => by.get(y)!.n === 12).sort((a, b) => a - b);
  return { years, values: years.map((y) => by.get(y)!.s) };
}

export class MlMockAdapter implements MlProvider {
  readonly kind = "demo-mock" as const;
  constructor(private readonly data: DataProvider) {}

  provenance() {
    return "demo" as const;
  }
  methodUrl() {
    return null;
  }

  async getIndex(): Promise<MlIndex> {
    const ix = await this.data.getIndex();
    const regions = await Promise.all(
      ix.presets.map((p) => this.data.getRegion({ presetId: p.id })),
    );
    const vs = Number(ix.viirs_start.slice(0, 4));
    const ly = Number(addMonths(ix.last_month, -1).slice(0, 4));
    const raw: Record<string, MlTrend> = {};
    const harm: Record<string, MlTrend> = {};
    regions.forEach((r) => {
      const a = yearly(r, (p) => p.viirs_raw ?? p.modis_raw ?? 0);
      const b = yearly(r, (p) => p.harmonized);
      raw[r.id] = trendOf(a.years, a.values, vs);
      harm[r.id] = trendOf(b.years, b.values, vs);
    });
    const grp = (kind: string, group: string, label: Tri, coverage: number, n: number) => ({
      kind,
      group,
      label,
      coverage,
      n,
      mean_width: 2.1,
      flag: coverage < 0.85,
    });
    const m = (mae: number, rmse: number, bias: number, sp: number) => ({
      mae,
      rmse_log1p: rmse,
      bias,
      spearman: sp,
      n: 160000,
    });
    const drivers = [
      "frp_mean",
      "modis_n",
      "reg_modis",
      "scan_mean",
      "lc_code",
      "nbr_modis",
      "frp_max",
      "season",
      "day_share",
      "ndvi_anom",
    ].map((f, i) => ({
      feature: f,
      label: FEATURES[f]!,
      mean_abs_shap: r3(0.42 * Math.exp(-0.32 * i)),
    }));
    const fdrivers = [
      "lag0_anom",
      "precip3_anom",
      "clim_log",
      "lag1_anom",
      "t2m_anom",
      "rh_anom",
      "ndvi_anom",
      "season",
    ].map((f, i) => ({
      feature: f,
      label: FEATURES[f]!,
      mean_abs_shap: r3(0.3 * Math.exp(-0.35 * i)),
    }));
    const takeaway = (k: "frp" | "scan"): Tri =>
      k === "frp"
        ? T(
            "Small, cool fires are the ones MODIS misses most: below 5 MW, VIIRS sees +54% more fires per MODIS detection than average.",
            "ছোট, কম তাপের আগুনই MODIS সবচেয়ে বেশি মিস করে: ৫ মেগাওয়াটের নিচে প্রতিটি MODIS শনাক্তকরণের বিপরীতে VIIRS গড়ের চেয়ে +৫৪% বেশি আগুন দেখে।",
            "Los fuegos pequeños y poco intensos son los que MODIS más pasa por alto: por debajo de 5 MW, VIIRS ve +54 % más fuegos por cada detección de MODIS que el promedio.",
          )
        : T(
            "At wide MODIS viewing angles (45-90°) its pixels grow, so VIIRS sees +22% more fires per MODIS detection than average.",
            "MODIS-এর দেখার কোণ বড় হলে (৪৫-৯০°) পিক্সেল বড় হয়, তাই প্রতিটি MODIS শনাক্তকরণের বিপরীতে VIIRS গড়ের চেয়ে +২২% বেশি আগুন দেখে।",
            "Con ángulos de visión amplios de MODIS (45-90°) sus píxeles crecen, así que VIIRS ve +22 % más fuegos por cada detección de MODIS que el promedio.",
          );
    return {
      version: "1.1-ml",
      generated_at: ix.generated_at,
      source: "demo",
      inputs: {
        first_month: ix.first_month,
        last_month: ix.last_month,
        viirs_start: ix.viirs_start,
        partial_month: ix.last_month,
        origin: addMonths(ix.last_month, -1),
      },
      notes: ["DEMO mock: illustrative values generated in the browser."],
      splits: { train: `${vs}-${vs + 7}`, cal: String(vs + 8), test: `${vs + 9}-${ly}` },
      models: {
        harmonization: {
          chosen: "xgboost",
          version: "h-demo",
          metrics: {
            baseline: { cal: m(1.21, 0.69, 0.07, 0.46), test: m(0.86, 0.62, 0.01, 0.36) },
            xgboost: { cal: m(0.83, 0.44, -0.15, 0.68), test: m(0.6, 0.4, -0.03, 0.58) },
          },
          corr: { raw: 0.61, baseline: 0.88, xgboost: 0.93 },
          corr_cell: { raw: 0.46, baseline: 0.44, xgboost: 0.69 },
          spatial_cv: {
            folds: 5,
            tiles: 12,
            baseline: { mae: { mean: 0.82, sd: 0.11 } },
            xgboost: { mae: { mean: 0.58, sd: 0.08 } },
          },
          conformal: {
            target: 0.9,
            coverage_test: 0.91,
            mean_width: 1.96,
            region_coverage_test: 0.94,
            region_n_cal: 48,
            by_group: [
              ...Object.entries(LANDCOVER).map(([k, l], i) =>
                grp(
                  "landcover",
                  k,
                  l,
                  k === "savanna" ? 0.84 : r3(0.9 + 0.007 * ((i * 5) % 4)),
                  12000 + 3000 * i,
                ),
              ),
              grp("country", "BD", T("Bangladesh", "বাংলাদেশ", "Bangladés"), 0.92, 64000),
              grp("country", "AR", T("Argentina", "আর্জেন্টিনা", "Argentina"), 0.9, 98000),
            ],
          },
        },
        firecast: {
          version: "f-demo",
          brier: 0.58,
          brier_clim: 0.67,
          rpss: 0.08,
          reliability: [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75].map((b, i) => ({
            bin: b,
            predicted: b,
            observed: r3(Math.min(1, Math.max(0, b + 0.04 * Math.sin(i * 1.7)))),
            n: 60 + 20 * (4 - Math.abs(4 - i)),
          })),
          calibration_years: "2001-2010",
          evaluation_years: `2011-${ly}`,
        },
      },
      global_drivers: { harmonization: drivers, firecast: fdrivers },
      dependence: {
        frp_mean: ["0-5 MW", "5-10 MW", "10-20 MW", "20-50 MW", "50-100 MW", "100+ MW"].map(
          (bin, i) => ({ bin, shap: r3(0.43 - 0.17 * i), n: 4000 - 500 * i }),
        ),
        scan_mean: ["0-15 deg", "15-25 deg", "25-35 deg", "35-45 deg", "45-90 deg"].map(
          (bin, i) => ({ bin, shap: r3(-0.1 + 0.075 * i), n: 3000 }),
        ),
        landcover: Object.entries(LANDCOVER).map(([k, l], i) => ({
          bin: k,
          label: l,
          shap: r3(0.12 - 0.04 * i),
          n: 2000,
        })),
      },
      takeaways: { frp_mean: takeaway("frp"), scan_mean: takeaway("scan") },
      raw_trained_trend: raw,
      harmonized_trained_trend: harm,
      labels: { features: FEATURES, units: UNITS, landcover: LANDCOVER },
      regions: ix.presets.map((p) => p.id),
      grid: { tile_deg: ix.grid.tile_deg, target: addMonths(ix.last_month, 1), tiles: [] },
    };
  }

  async getRegion(id: string): Promise<MlRegion | null> {
    let r: RegionData;
    try {
      r = await this.data.getRegion({ presetId: id });
    } catch {
      return null;
    }
    const rng = mulberry32(hashString(`ml:${id}`));
    const g = () => Math.sqrt(-2 * Math.log(Math.max(rng(), 1e-9))) * Math.cos(2 * Math.PI * rng());
    const ix = await this.data.getIndex();
    const monthly_ml = r.monthly.map((p) => {
      const v = Math.max(0, p.harmonized * (1 + 0.04 * g()));
      const w = p.ym < ix.viirs_start ? 0.24 : 0.14;
      return {
        ym: p.ym,
        ml_harmonized: r3(v),
        lo90: r3(v * (1 - w)),
        hi90: r3(v * (1 + w) + 2),
        baseline: r3(p.harmonized),
        xgboost: r3(v),
      };
    });
    const explain: Record<string, MlExplain> = {};
    for (const p of monthly_ml) {
      const mo = Number(p.ym.slice(5, 7));
      const c = (feature: string, value: number | string, contrib: number): MlContribution => ({
        feature,
        value,
        contrib: r3(contrib),
      });
      const frp = 6 + 18 * rng();
      const pos = [
        c("frp_mean", r3(frp), 0.35 - frp / 80),
        c("reg_modis", Math.round(p.ml_harmonized * 0.3), 0.12 + 0.1 * rng()),
        c("season", mo, 0.03 + 0.06 * rng()),
      ]
        .filter((x) => x.contrib > 0)
        .sort((a, b) => b.contrib - a.contrib);
      const neg = [
        c("lc_code", LC_OF[id] ?? "cropland", -0.04 - 0.05 * rng()),
        c("scan_mean", r3(20 + 10 * rng()), -0.02 - 0.04 * rng()),
        c("ndvi_anom", r3(0.05 * g()), -0.01 - 0.02 * rng()),
      ].sort((a, b) => a.contrib - b.contrib);
      const sum = [...pos, ...neg].reduce((a, x) => a + x.contrib, 0) + 0.02;
      explain[p.ym] = {
        base: -0.1,
        start: r3(p.ml_harmonized / Math.exp(sum)),
        end: p.ml_harmonized,
        other: 0.02,
        pos,
        neg,
      };
    }
    const firecast: MlForecast[] = (r.outlook ?? []).map((o, i) => {
      const p: [number, number, number] = [o.p_below, o.p_near, o.p_above];
      const set = CLS.filter((_, k) => p[k]! >= 0.28);
      const skilful = o.rpss > 0;
      const drivers = [
        { feature: "precip3_anom", value: -42 + 10 * i, contrib: 0.31 - 0.05 * i },
        { feature: "lag0_anom", value: 1.6, contrib: 0.2 },
        {
          feature: "clim_log",
          value: Math.round(r.climatology[(Number(o.ym.slice(5, 7)) + 11) % 12]?.median ?? 0),
          contrib: -0.08,
        },
      ];
      return {
        ym: o.ym,
        lead: i + 1,
        p,
        set: set.length ? set : [CLS[p.indexOf(Math.max(...p))]!],
        skilful,
        rpss: o.rpss,
        rpss_ci90: [r3(o.rpss - 0.06), r3(o.rpss + 0.06)],
        drivers,
        narrative: narrative(o.ym, p, set, skilful, o.rpss),
      };
    });
    return { id, monthly_ml, explain, firecast };
  }

  async getGrid(tileId: string): Promise<MlGrid | null> {
    const ix = await this.data.getIndex();
    const [la, lo] = tileId.split("_").map(Number) as [number, number];
    const d = ix.grid.tile_deg;
    const res = await this.data.getCells([lo, la, lo + d, la + d]);
    const cells = res.cells
      .filter((c) => {
        let s = 0;
        for (let k = 0; k < c.v.length; k += 7) s += c.v[k]!;
        return s > 0.6;
      })
      .map((c) => {
        const h = (hashString(`${c.lat},${c.lon}:risk`) % 1000) / 1000;
        const p = r3(0.12 + 0.6 * h);
        const corrientes = c.lat < -27 && c.lat > -30.3 && c.lon > -59.1;
        return {
          id: `c_${c.lat}_${c.lon}`,
          lat: c.lat,
          lon: c.lon,
          p_above: p,
          set_size: p > 0.3 && p < 0.38 ? 3 : 2,
          skilful: !corrientes,
        };
      });
    return { target: addMonths(ix.last_month, 1), cells };
  }
}

function narrative(ym: string, p: number[], set: Cls[], skilful: boolean, rpss: number): Tri {
  const out = {} as Tri;
  for (const lang of ["en", "bn", "es"] as const) {
    const d = DICT[lang];
    const month = capFirst(monthYear(lang, ym));
    const sets = set.map((s) => d[`out.set.${s}` as const]).join(d.or);
    out[lang] = skilful
      ? `${month}: ${d["out.likely"].replace("{set}", sets)} (${num(lang, Math.round(Math.max(...p) * 100))}%). ${d["out.skilful"].replace("{v}", num(lang, rpss, 2))}.`
      : `${month}: ${d["out.none"]}`;
  }
  return out;
}
