/**
 * Data contract v1.1 (additive): the FireRings Intelligence layer's files
 * under {base}/ml/, written by src/compute/ml (Python). Contract v1 is
 * unchanged; every field here is optional for the rest of the app.
 */
import type { Provenance, Tri } from "@/data/types";

export type Cls = "below" | "near" | "above";

export interface MlMetrics {
  mae: number;
  rmse_log1p: number;
  bias: number;
  spearman: number | null;
  n: number;
}

export interface MlGroupCoverage {
  kind: "landcover" | "country" | "activity" | string;
  group: string;
  label: Tri;
  coverage: number;
  n: number;
  mean_width: number;
  flag: boolean;
}

export interface MlDriver {
  feature: string;
  label: Tri;
  mean_abs_shap: number;
}

export interface MlDependenceRow {
  bin: string;
  lo?: number;
  hi?: number | null;
  label?: Tri;
  shap: number;
  n: number;
}

export interface MlTrend {
  years: number[];
  values: number[];
  slope: number | null;
  p: number | null;
  jump_ratio?: number | null;
}

export interface MlReliability {
  bin: number;
  predicted?: number;
  observed: number;
  n: number;
}

export interface MlLeadRegion {
  rpss: number;
  ci90: [number, number];
  skilful: boolean;
  by_month: Record<string, number>;
  n: number;
}

export interface MlIndex {
  version: "1.1-ml";
  generated_at: string;
  source: "live" | "demo";
  inputs: {
    first_month: string;
    last_month: string;
    viirs_start: string;
    partial_month?: string | null;
    origin: string;
  };
  notes?: string[];
  splits?: { train: string; cal: string; test: string };
  models: {
    harmonization: {
      chosen: "xgboost" | "baseline";
      version: string;
      metrics: Record<string, { cal: MlMetrics; test: MlMetrics }>;
      corr: Record<string, number>;
      corr_cell?: Record<string, number>;
      spatial_cv?: {
        folds: number;
        tiles?: number;
        baseline?: Record<string, { mean: number; sd: number }>;
        xgboost?: Record<string, { mean: number; sd: number }>;
      };
      conformal: {
        target: number;
        coverage_test: number;
        mean_width: number;
        region_coverage_test?: number;
        region_n_cal?: number;
        by_group: MlGroupCoverage[];
      };
    };
    firecast: {
      version: string;
      brier: number;
      brier_clim?: number;
      rpss: number;
      reliability: MlReliability[];
      calibration_years?: string;
      evaluation_years?: string;
      leads?: { lead: number; rpss: number; regions: Record<string, MlLeadRegion> }[];
    };
  };
  global_drivers: { harmonization: MlDriver[]; firecast: MlDriver[] };
  dependence: Record<string, MlDependenceRow[]>;
  takeaways?: Record<string, Tri>;
  raw_trained_trend?: Record<string, MlTrend>;
  harmonized_trained_trend?: Record<string, MlTrend>;
  labels?: {
    features?: Record<string, Tri>;
    units?: Record<string, string>;
    landcover?: Record<string, Tri>;
    country?: Record<string, Tri>;
  };
  regions?: string[];
  grid?: { tile_deg: number; target: string; tiles: string[] };
}

export interface MlMonth {
  ym: string;
  ml_harmonized: number;
  lo90: number;
  hi90: number;
  baseline?: number;
  xgboost?: number;
  partial?: boolean;
}

export interface MlContribution {
  feature: string;
  value: number | string | null;
  contrib: number;
}

export interface MlExplain {
  base: number;
  start: number;
  end: number;
  other?: number;
  pos: MlContribution[];
  neg: MlContribution[];
}

export interface MlForecast {
  ym: string;
  lead?: number;
  p: [number, number, number];
  set: Cls[];
  skilful: boolean;
  rpss: number | null;
  rpss_ci90?: [number, number] | null;
  drivers: MlContribution[];
  narrative: Tri;
}

export interface MlRegion {
  id: string;
  monthly_ml: MlMonth[];
  explain: Record<string, MlExplain>;
  firecast: MlForecast[];
}

export interface MlGridCell {
  id: string;
  lat?: number;
  lon?: number;
  p_above: number;
  set_size: number;
  skilful: boolean;
}

export interface MlGrid {
  target?: string;
  cells: MlGridCell[];
}

/** What every ML adapter answers. `null` = this file does not exist (feature hidden). */
export interface MlProvider {
  readonly kind: "demo-mock" | "demo-static" | "static";
  getIndex(): Promise<MlIndex | null>;
  getRegion(id: string): Promise<MlRegion | null>;
  getGrid(tileId: string): Promise<MlGrid | null>;
  /** Provenance of the numbers this adapter serves (cache when answered offline). */
  provenance(): Provenance;
  /** Link to the 1-page method, when published next to the files. */
  methodUrl(): string | null;
}
