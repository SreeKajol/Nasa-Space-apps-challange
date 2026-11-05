"""ML harmonization: learn WHY MODIS and VIIRS disagree, benchmarked against B0.

Model M1: XGBoost Poisson regression of the reference-VIIRS cell-day count
with offset log(MODIS + 0.5). The trees therefore model the log VIIRS/MODIS
ratio, which is exactly what TreeSHAP explains later ("why the sensors
disagree"). Two heads: "ta" (Terra + Aqua, from 2002-07) and "t" (Terra only,
for 2000-11 .. 2002-06, so Aqua's absence is never extrapolated).

M2: Random Forest on log1p(count), report only.

Validation
  * temporal: train on overlap years <= splits.train[1], choose the model on
    the calibration year (never on the test years), report on the test years;
  * spatial: 5-fold block CV, whole 2x2-degree tiles held out.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd
import xgboost as xgb
from scipy.stats import spearmanr
from sklearn.ensemble import RandomForestRegressor
from sklearn.model_selection import GroupKFold

from .baseline import StratifiedRatio, modis_for
from .config import H_FEATURES_T, H_FEATURES_TA, N_JOBS, RF_H, SEED, XGB_H
from .features import Splits


def head_features(head: str) -> list[str]:
    return H_FEATURES_TA if head == "ta" else H_FEATURES_T


def offset(df: pd.DataFrame, head: str) -> np.ndarray:
    return np.log(modis_for(df, head) + 0.5)


@dataclass
class XgbHarmonizer:
    head: str
    model: Any = None

    def fit(self, df: pd.DataFrame, seed: int = SEED) -> "XgbHarmonizer":
        X = df[head_features(self.head)].to_numpy(dtype=np.float32)
        self.model = xgb.XGBRegressor(**XGB_H, random_state=seed, n_jobs=N_JOBS)
        self.model.fit(X, df["y_h"].to_numpy(dtype=float), base_margin=offset(df, self.head))
        return self

    def dmatrix(self, df: pd.DataFrame) -> xgb.DMatrix:
        return xgb.DMatrix(df[head_features(self.head)].to_numpy(dtype=np.float32), base_margin=offset(df, self.head), feature_names=head_features(self.head))

    def predict(self, df: pd.DataFrame) -> np.ndarray:
        if len(df) == 0:
            return np.zeros(0)
        return self.model.predict(df[head_features(self.head)].to_numpy(dtype=np.float32), base_margin=offset(df, self.head))


@dataclass
class RfHarmonizer:
    head: str
    model: Any = None

    def fit(self, df: pd.DataFrame, seed: int = SEED) -> "RfHarmonizer":
        X = np.nan_to_num(df[head_features(self.head)].to_numpy(dtype=np.float32), nan=-1.0)
        self.model = RandomForestRegressor(**RF_H, random_state=seed, n_jobs=N_JOBS).fit(X, np.log1p(df["y_h"].to_numpy(dtype=float)))
        return self

    def predict(self, df: pd.DataFrame) -> np.ndarray:
        X = np.nan_to_num(df[head_features(self.head)].to_numpy(dtype=np.float32), nan=-1.0)
        return np.expm1(self.model.predict(X))


def _rf_job(train: pd.DataFrame, cal: pd.DataFrame, test: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    m = RfHarmonizer("ta").fit(train)
    return m.predict(cal), m.predict(test)


def rf_in_subprocess(train: pd.DataFrame, cal: pd.DataFrame, test: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    import multiprocessing as mp
    from concurrent.futures import ProcessPoolExecutor

    cols = [*head_features("ta"), "y_h"]
    with ProcessPoolExecutor(max_workers=1, mp_context=mp.get_context("spawn")) as ex:
        return ex.submit(_rf_job, train[cols], cal[cols], test[cols]).result()


def metrics(y: np.ndarray, p: np.ndarray) -> dict[str, float]:
    y = np.asarray(y, float)
    p = np.asarray(p, float)
    rho = spearmanr(y, p).statistic if len(y) > 2 and np.std(y) > 0 and np.std(p) > 0 else float("nan")
    return {
        "mae": float(np.mean(np.abs(p - y))),
        "rmse_log1p": float(np.sqrt(np.mean((np.log1p(np.maximum(p, 0)) - np.log1p(y)) ** 2))),
        "bias": float(np.mean(p - y)),
        "spearman": float(rho),
        "n": int(len(y)),
    }


def series_corr(df: pd.DataFrame, col: str) -> float:
    """Pearson r between the region-month series and the VIIRS region-month series, averaged over regions."""
    rs = []
    for _, d in df.groupby("region", observed=True):
        g = d.groupby("ym").agg(v=("y_h", "sum"), p=(col, "sum"))
        if len(g) > 2 and g["v"].std() > 0 and g["p"].std() > 0:
            rs.append(np.corrcoef(g["v"], g["p"])[0, 1])
    return float(np.mean(rs)) if rs else float("nan")


def cell_corr(df: pd.DataFrame, col: str) -> float:
    """Pearson r of log1p counts at cell-month level (where MODIS and VIIRS disagree most)."""
    return float(np.corrcoef(np.log1p(df["y_h"]), np.log1p(np.maximum(df[col], 0)))[0, 1])


@dataclass
class HarmonizationResult:
    chosen: str
    models: dict[str, dict[str, Any]]  # name -> head -> fitted model
    metrics: dict[str, dict[str, Any]]
    corr: dict[str, float]
    corr_cell: dict[str, float]
    spatial_cv: dict[str, Any]
    pred: pd.DataFrame  # per cell-month: b0, xgb, ml (chosen), head
    notes: list[str] = field(default_factory=list)


def _overlap(df: pd.DataFrame, years: tuple[int, int]) -> pd.DataFrame:
    return df[df["y_h"].notna() & ~df["partial"] & (df["year"] >= years[0]) & (df["year"] <= years[1])]


def run(hf: pd.DataFrame, splits: Splits, quick: bool = False, log=print) -> HarmonizationResult:
    train = _overlap(hf, splits.train)
    cal = _overlap(hf, (splits.cal, splits.cal))
    test = _overlap(hf, splits.test)
    log(f"  overlap rows: train {len(train):,} · cal {len(cal):,} · test {len(test):,}")

    models: dict[str, dict[str, Any]] = {"baseline": {}, "xgboost": {}}
    for head in ("ta", "t"):
        tr = train if head == "ta" else train.assign(modis_aqua=np.nan)
        models["baseline"][head] = StratifiedRatio(head).fit(tr)
        models["xgboost"][head] = XgbHarmonizer(head).fit(tr)

    out: dict[str, dict[str, Any]] = {}
    pred_cols = {}
    if not quick:
        # M2 (report only) runs in a separate process: scikit-learn's forest and XGBoost's
        # TreeSHAP in one process crashed natively on Windows (see docs/ml_method.md).
        pred_cols["rf"] = rf_in_subprocess(train, cal, test)
        out["rf"] = {"cal": metrics(cal["y_h"], pred_cols["rf"][0]), "test": metrics(test["y_h"], pred_cols["rf"][1])}
    for name, heads in models.items():
        m = heads["ta"]
        pc, pt = m.predict(cal), m.predict(test)
        pred_cols[name] = (pc, pt)
        out[name] = {"cal": metrics(cal["y_h"], pc), "test": metrics(test["y_h"], pt)}
    # Terra-only head, checked on the same test rows with Aqua hidden
    t_test = test.assign(modis_aqua=np.nan)
    for name in ("baseline", "xgboost"):
        out[name]["test_terra_only"] = metrics(test["y_h"], models[name]["t"].predict(t_test))

    tc = test.assign(raw=test["modis_n"], baseline=pred_cols["baseline"][1], xgboost=pred_cols["xgboost"][1])
    corr = {"raw": series_corr(tc, "raw"), "baseline": series_corr(tc, "baseline"), "xgboost": series_corr(tc, "xgboost")}
    corr_cell = {k: cell_corr(tc, k) for k in ("raw", "baseline", "xgboost")}
    if "rf" in pred_cols:
        tc = tc.assign(rf=pred_cols["rf"][1])
        corr["rf"] = series_corr(tc, "rf")
        corr_cell["rf"] = cell_corr(tc, "rf")

    # Choice on the calibration year only. Tie (within 1 %) -> the simpler baseline.
    mae_b, mae_x = out["baseline"]["cal"]["mae"], out["xgboost"]["cal"]["mae"]
    chosen = "xgboost" if mae_x < 0.99 * mae_b else "baseline"
    log(f"  calibration-year MAE: baseline {mae_b:.3f} · xgboost {mae_x:.3f} -> chosen: {chosen}")

    spatial = spatial_block_cv(pd.concat([train, cal]), quick=quick, log=log)

    # Apply to every cell-month (MODIS-only years included). B0 kept alongside.
    pred = hf[["cell_id", "region", "ym", "year", "head", "partial"]].copy()
    pred["b0"] = np.nan
    pred["xgb"] = np.nan
    for head in ("ta", "t"):
        mask = (hf["head"] == head).to_numpy()
        part = hf[mask]
        pred.loc[mask, "b0"] = models["baseline"][head].predict(part)
        pred.loc[mask, "xgb"] = models["xgboost"][head].predict(part)
    pred["ml"] = pred["xgb"] if chosen == "xgboost" else pred["b0"]
    return HarmonizationResult(chosen, models, out, corr, corr_cell, spatial, pred)


def spatial_block_cv(df: pd.DataFrame, k: int = 5, quick: bool = False, log=print) -> dict[str, Any]:
    tiles = df["tile"].to_numpy()
    n_tiles = len(np.unique(tiles))
    k = min(k, n_tiles)
    if k < 2:
        return {"folds": 0, "note": "fewer than two 2-degree tiles; spatial CV skipped"}
    res: dict[str, list[dict[str, float]]] = {"baseline": [], "xgboost": []}
    for i, (a, b) in enumerate(GroupKFold(n_splits=k).split(df, groups=tiles)):
        tr, te = df.iloc[a], df.iloc[b]
        res["baseline"].append(metrics(te["y_h"], StratifiedRatio("ta").fit(tr).predict(te)))
        res["xgboost"].append(metrics(te["y_h"], XgbHarmonizer("ta").fit(tr, seed=SEED + i).predict(te)))
        if quick and i >= 1:
            break
    summary: dict[str, Any] = {"folds": len(res["xgboost"]), "tiles": int(n_tiles), "block_deg": 2}
    for name, folds in res.items():
        summary[name] = {m: {"mean": float(np.nanmean([f[m] for f in folds])), "sd": float(np.nanstd([f[m] for f in folds]))} for m in ("mae", "rmse_log1p", "bias", "spearman")}
    log(f"  spatial block CV ({summary['folds']} folds, {n_tiles} tiles): MAE baseline {summary['baseline']['mae']['mean']:.3f} · xgboost {summary['xgboost']['mae']['mean']:.3f}")
    return summary
