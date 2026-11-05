"""Conformal uncertainty: distribution-free 90 % intervals, checked per group.

Method (split conformal, normalized, Mondrian):
  1. sigma(x): a small XGBoost model of |residual|, trained on OUT-OF-FOLD
     residuals of the training years (3 spatial folds), so it is not fooled by
     in-sample fit. Intervals widen where the model is less sure.
  2. Scores s = |y - yhat| / sigma on the calibration year (a held-out year
     block, never the test years).
  3. Mondrian calibration: a separate (1 - alpha) score quantile per land-cover
     class, per country and per predicted-activity band (quiet / low / moderate
     / high; zero-heavy quiet cells would otherwise mask under-coverage of busy
     ones). A row's half-width uses the LARGEST of its group quantiles;
     containing every group interval keeps the per-group guarantee for each
     partition.
  4. Empirical coverage is reported on the TEST years, overall and per group;
     groups under 85 % are flagged.

Region intervals: a second, region-level split-conformal step. For each
region-month of the calibration year the score is |Y - Yhat| / sqrt(sum hw^2)
(cell half-widths combined as if independent); its conformal quantile c then
scales that combined width. Summing the cell bounds instead would be valid
but uselessly wide in quiet months (hundreds of cells each add a minimum
width). The calibration sample is small (regions x 12 months), so region
intervals are labelled "approximate" and their test coverage is reported.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.model_selection import GroupKFold

from .config import ALPHA, COVERAGE_FLAG, N_JOBS, SEED, XGB_SIGMA
from .features import Splits
from .harmonize_ml import head_features

MIN_GROUP = 30
SIGMA_FLOOR = 0.25


def conformal_quantile(scores: np.ndarray, alpha: float = ALPHA) -> float:
    """The ceil((n+1)(1-alpha))-th smallest score: finite-sample valid split-conformal quantile."""
    s = np.sort(np.asarray(scores, float))
    n = len(s)
    if n == 0:
        return float("inf")
    k = int(np.ceil((n + 1) * (1 - alpha)))
    return float(s[min(k, n) - 1]) if k <= n else float("inf")


@dataclass
class MondrianConformal:
    alpha: float = ALPHA
    q_global: float = float("inf")
    q_groups: dict[str, dict[str, float]] = field(default_factory=dict)

    def fit(self, scores: np.ndarray, groups: dict[str, np.ndarray]) -> "MondrianConformal":
        self.q_global = conformal_quantile(scores, self.alpha)
        for gname, g in groups.items():
            self.q_groups[gname] = {}
            for key in pd.unique(g):
                sel = g == key
                if sel.sum() >= MIN_GROUP:
                    self.q_groups[gname][str(key)] = conformal_quantile(scores[sel], self.alpha)
        return self

    def q(self, groups: dict[str, np.ndarray]) -> np.ndarray:
        n = len(next(iter(groups.values())))
        out = np.full(n, 0.0)
        for gname, g in groups.items():
            table = self.q_groups.get(gname, {})
            qg = np.array([table.get(str(k), self.q_global) for k in g])
            out = np.maximum(out, qg)
        return out


@dataclass
class SigmaModel:
    head: str
    model: Any = None

    def _X(self, df: pd.DataFrame, yhat: np.ndarray) -> np.ndarray:
        X = df[head_features(self.head)].to_numpy(dtype=np.float32)
        return np.column_stack([X, np.log1p(np.maximum(yhat, 0))]).astype(np.float32)

    def fit(self, df: pd.DataFrame, yhat_oof: np.ndarray) -> "SigmaModel":
        r = np.abs(df["y_h"].to_numpy(float) - yhat_oof)
        self.model = xgb.XGBRegressor(**XGB_SIGMA, random_state=SEED, n_jobs=N_JOBS).fit(self._X(df, yhat_oof), r)
        return self

    def predict(self, df: pd.DataFrame, yhat: np.ndarray) -> np.ndarray:
        return np.maximum(self.model.predict(self._X(df, yhat)), SIGMA_FLOOR)


def oof_predictions(df: pd.DataFrame, make_model: Callable[[], Any], k: int = 3) -> np.ndarray:
    oof = np.zeros(len(df))
    groups = df["tile"].to_numpy()
    k = max(2, min(k, len(np.unique(groups))))
    for a, b in GroupKFold(n_splits=k).split(df, groups=groups):
        oof[b] = make_model().fit(df.iloc[a]).predict(df.iloc[b])
    return oof


ACTIVITY_BINS = [0.5, 2.0, 8.0]
ACTIVITY_NAMES = ["quiet", "low", "moderate", "high"]


def group_arrays(df: pd.DataFrame, yhat: np.ndarray) -> dict[str, np.ndarray]:
    """Mondrian partitions: land cover, country, and predicted activity (a function of x only)."""
    act = np.array(ACTIVITY_NAMES)[np.digitize(yhat, ACTIVITY_BINS)]
    return {"landcover": df["landcover"].astype(str).to_numpy(), "country": df["country"].astype(str).to_numpy(), "activity": act}


@dataclass
class ConformalResult:
    by_head: dict[str, tuple[SigmaModel, MondrianConformal]]
    report: dict[str, Any]
    intervals: pd.DataFrame  # per cell-month lo90 / hi90 / hw / c_region for the chosen model


def _region_frame(df: pd.DataFrame, y: np.ndarray, p: np.ndarray, hw: np.ndarray) -> pd.DataFrame:
    d = pd.DataFrame({"region": df["region"].to_numpy(), "ym": df["ym"].to_numpy(), "y": y, "p": p, "h2": hw**2})
    g = d.groupby(["region", "ym"]).sum()
    g["s"] = np.sqrt(np.maximum(g["h2"], 1e-9))
    return g


def coverage_table(y: np.ndarray, lo: np.ndarray, hi: np.ndarray, groups: dict[str, np.ndarray]) -> list[dict[str, Any]]:
    inside = (y >= lo) & (y <= hi)
    rows = []
    for gname, g in groups.items():
        for key in sorted(pd.unique(g)):
            sel = g == key
            cov = float(inside[sel].mean())
            rows.append({"kind": gname, "group": str(key), "coverage": round(cov, 4), "n": int(sel.sum()), "mean_width": round(float((hi - lo)[sel].mean()), 3), "flag": bool(cov < COVERAGE_FLAG)})
    return rows


def run(hf: pd.DataFrame, harm, splits: Splits, log=print) -> ConformalResult:
    chosen = harm.chosen
    pred = harm.pred
    by_head: dict[str, tuple[SigmaModel, MondrianConformal]] = {}
    tr_mask = hf["y_h"].notna() & ~hf["partial"] & hf["year"].between(*splits.train)
    cal_mask = hf["y_h"].notna() & ~hf["partial"] & (hf["year"] == splits.cal)
    test_mask = hf["y_h"].notna() & ~hf["partial"] & hf["year"].between(*splits.test)
    lo = np.full(len(hf), np.nan)
    hi = np.full(len(hf), np.nan)
    hw_all = np.full(len(hf), np.nan)
    c_all = np.full(len(hf), np.nan)
    report: dict[str, Any] = {"target": 1 - ALPHA}

    for head in ("ta", "t"):
        model_cls = type(harm.models[chosen][head])
        hide = (lambda d: d.assign(modis_aqua=np.nan)) if head == "t" else (lambda d: d)
        tr = hide(hf[tr_mask])
        oof = oof_predictions(tr, lambda: model_cls(head))
        sig = SigmaModel(head).fit(tr, oof)
        cal = hide(hf[cal_mask])
        yc = cal["y_h"].to_numpy(float)
        pc = harm.models[chosen][head].predict(cal)
        sc = np.abs(yc - pc) / sig.predict(cal, pc)
        mc = MondrianConformal().fit(sc, group_arrays(cal, pc))
        by_head[head] = (sig, mc)
        hw_c = sig.predict(cal, pc) * mc.q(group_arrays(cal, pc))
        rc = _region_frame(cal, yc, pc, hw_c)
        c_reg = conformal_quantile(np.abs(rc["y"] - rc["p"]) / rc["s"])

        # Evaluate on the TEST years
        te = hide(hf[test_mask])
        yt = te["y_h"].to_numpy(float)
        pt = harm.models[chosen][head].predict(te)
        gt = group_arrays(te, pt)
        hw = sig.predict(te, pt) * mc.q(gt)
        tlo, thi = np.maximum(0, pt - hw), pt + hw
        inside = (yt >= tlo) & (yt <= thi)
        rep = {
            "coverage_test": round(float(inside.mean()), 4),
            "mean_width": round(float((thi - tlo).mean()), 3),
            "n_cal": int(len(yc)),
            "n_test": int(len(yt)),
            "q_global": round(mc.q_global, 4),
            "by_group": coverage_table(yt, tlo, thi, gt),
        }
        # Region-level intervals, checked on the test years
        rt = _region_frame(te, yt, pt, hw)
        rlo, rhi = np.maximum(0, rt["p"] - c_reg * rt["s"]), rt["p"] + c_reg * rt["s"]
        rep["region_coverage_test"] = round(float(((rt["y"] >= rlo) & (rt["y"] <= rhi)).mean()), 4)
        rep["region_n_cal"] = int(len(rc))
        rep["region_c"] = round(float(c_reg), 4)
        rep["region_mean_rel_width"] = round(float(((rhi - rlo) / np.maximum(rt["p"], 1)).median()), 3)
        report[head] = rep
        log(f"  conformal [{head}]: test coverage {rep['coverage_test']:.3f}, region-month {rep['region_coverage_test']:.3f}")

        # Intervals for every cell-month of this head
        mask = (hf["head"] == head).to_numpy()
        part = hf[mask]
        p = pred.loc[mask, "ml"].to_numpy(float)
        w = sig.predict(part, p) * mc.q(group_arrays(part, p))
        lo[mask] = np.maximum(0, p - w)
        hi[mask] = p + w
        hw_all[mask] = w
        c_all[mask] = c_reg

    head_rep = report["ta"]
    report.update({"coverage_test": head_rep["coverage_test"], "mean_width": head_rep["mean_width"], "by_group": head_rep["by_group"], "region_coverage_test": head_rep["region_coverage_test"]})
    intervals = pd.DataFrame({"lo90": lo, "hi90": hi, "hw": hw_all, "c_region": c_all}, index=hf.index)
    return ConformalResult(by_head, report, intervals)
