"""Explainable AI: exact TreeSHAP for the XGBoost models.

TreeSHAP values come from XGBoost's own implementation (`pred_contribs=True`,
the algorithm of Lundberg et al. 2018/2020 that the `shap` package also uses
for tree models), so no extra dependency is needed.

For M1 the model output is the log VIIRS/MODIS ratio (the MODIS offset is
fixed), so a feature's SHAP value says how much it raises (+) or lowers (-)
the number of fires VIIRS sees for each one MODIS sees: "why the sensors
disagree". exp(SHAP) - 1 is the same effect as a percentage.

Region-month explanations average cell SHAP values weighted by each cell's
predicted count, so busy cells dominate as they do in the region total.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd
import xgboost as xgb

from .config import FEATURE_UNITS, GROUPS, LANDCOVER, feature_label, group_label
from .harmonize_ml import XgbHarmonizer, head_features, offset

FRP_BINS = [0, 5, 10, 20, 50, 100, np.inf]
SCAN_BINS = [0, 15, 25, 35, 45, 90]


def grouped(contribs: np.ndarray, names: list[str]) -> tuple[np.ndarray, list[str]]:
    """Sum SHAP columns that belong to one human-readable feature (e.g. month sin + cos = season)."""
    keys: list[str] = []
    for n in names:
        g = GROUPS.get(n, n)
        if g not in keys:
            keys.append(g)
    out = np.zeros((contribs.shape[0], len(keys)))
    for j, n in enumerate(names):
        out[:, keys.index(GROUPS.get(n, n))] += contribs[:, j]
    return out, keys


CHUNK = 100_000  # TreeSHAP in chunks: one huge call can exhaust native memory on 16 GB laptops


def shap_harmonizer(m: XgbHarmonizer, df: pd.DataFrame) -> tuple[np.ndarray, np.ndarray, list[str]]:
    """(feature SHAP n x F, learned bias n, feature names). The bias excludes the MODIS offset."""
    booster = m.model.get_booster()
    c = np.vstack([booster.predict(m.dmatrix(df.iloc[i : i + CHUNK]), pred_contribs=True) for i in range(0, len(df), CHUNK)])
    bias = c[:, -1] - offset(df, m.head)
    return c[:, :-1], bias, head_features(m.head)


def global_drivers(values: np.ndarray, names: list[str], top: int = 10) -> list[dict[str, Any]]:
    g, keys = grouped(values, names)
    imp = np.abs(g).mean(axis=0)
    order = np.argsort(-imp)[:top]
    return [{"feature": keys[i], "label": feature_label(keys[i]), "mean_abs_shap": round(float(imp[i]), 4)} for i in order]


def _bin_label(lo: float, hi: float, unit: str) -> str:
    return f"{lo:g}+ {unit}" if not np.isfinite(hi) else f"{lo:g}-{hi:g} {unit}"


def dependence(m: XgbHarmonizer, df: pd.DataFrame) -> dict[str, list[dict[str, Any]]]:
    """Binned dependence summaries: mean SHAP of a feature within bins of its value, relative to
    the average over months where the feature exists (FRP and scan angle are missing when MODIS
    saw nothing, and those months would otherwise shift every bin)."""
    vals, _, names = shap_harmonizer(m, df)
    out: dict[str, list[dict[str, Any]]] = {}
    for feat, bins, unit in (("frp_mean", FRP_BINS, "MW"), ("scan_mean", SCAN_BINS, "deg")):
        j = names.index(feat)
        x = df[feat].to_numpy(float)
        ref = float(vals[np.isfinite(x), j].mean()) if np.isfinite(x).any() else 0.0
        rows = []
        for lo, hi in zip(bins[:-1], bins[1:]):
            sel = (x >= lo) & (x < hi)
            if sel.sum() >= 30:
                rows.append({"bin": _bin_label(lo, hi, unit), "lo": lo, "hi": None if not np.isfinite(hi) else hi, "shap": round(float(vals[sel, j].mean() - ref), 4), "n": int(sel.sum())})
        out[feat] = rows
    j = names.index("lc_code")
    codes = df["lc_code"].to_numpy(float)
    ref = float(vals[:, j].mean())
    lc_rows = []
    for i, name in enumerate(LANDCOVER):
        sel = codes == i
        if sel.sum() >= 30:
            lc_rows.append({"bin": name, "label": group_label("landcover", name), "shap": round(float(vals[sel, j].mean() - ref), 4), "n": int(sel.sum())})
    out["landcover"] = lc_rows
    return out


def _display_value(feature: str, part: pd.DataFrame, w: np.ndarray) -> Any:
    """Region-level value of a feature for one month, as shown next to its bar."""
    if feature == "modis_n":
        return round(float(part["modis_n"].sum()), 1)
    if feature == "clim_modis":
        return round(float(part["clim_modis"].sum()), 1)
    if feature == "reg_modis":
        return round(float(part["modis_n"].sum()), 1)  # the region's MODIS total this month
    if feature == "nbr_modis":
        return round(float(np.average(np.expm1(part["nbr_modis"].to_numpy(float)), weights=w if w.sum() > 0 else None)), 2)
    if feature == "season":
        return int(part["month"].iloc[0])
    if feature == "lc_code":
        s = pd.Series(w, index=part["landcover"].astype(str).to_numpy()).groupby(level=0).sum()
        return str(s.idxmax())
    if feature == "region_code":
        return str(part["region"].iloc[0])
    col = part[feature].to_numpy(float)
    ok = np.isfinite(col)
    if not ok.any():
        return None
    v = float(np.average(col[ok], weights=w[ok] if w[ok].sum() > 0 else None))
    if FEATURE_UNITS.get(feature) == "%" and feature == "day_share":
        v *= 100
    return round(v, 2)


def local_region_month(g: np.ndarray, keys: list[str], bias: np.ndarray, part: pd.DataFrame, yhat: np.ndarray, kappa: float, top: int = 3) -> dict[str, Any]:
    """Explain one region-month from precomputed, grouped cell SHAP values `g`.

    start = the estimate with every feature at its average effect; each shown
    contribution multiplies it by exp(contrib); "other" folds the remaining
    features, so start * exp(sum of all) = end (harmonized units)."""
    w = yhat / yhat.sum() if yhat.sum() > 0 else np.full(len(yhat), 1 / max(1, len(yhat)))
    phi = w @ g
    end = float(kappa * yhat.sum())
    start = end / float(np.exp(phi.sum())) if end > 0 else 0.0
    order = np.argsort(-phi)
    pos = [i for i in order if phi[i] > 0][:top]
    neg = [i for i in order[::-1] if phi[i] < 0][:top]

    def item(i: int) -> dict[str, Any]:
        return {"feature": keys[i], "value": _display_value(keys[i], part, w), "contrib": round(float(phi[i]), 4)}

    return {
        "base": round(float(w @ bias), 4),
        "start": round(start, 2),
        "end": round(end, 2),
        "other": round(float(phi.sum() - sum(phi[i] for i in pos + neg)), 4),
        "pos": [item(i) for i in pos],
        "neg": [item(i) for i in neg],
    }


def multiclass_shap(model: xgb.XGBClassifier, X: np.ndarray, names: list[str], cls: int = 2) -> np.ndarray:
    """SHAP values for one class of a softprob model (n x F), on that class's margin."""
    b = model.get_booster()
    parts = [b.predict(xgb.DMatrix(X[i : i + CHUNK].astype(np.float32), feature_names=names), pred_contribs=True)[:, cls, :-1] for i in range(0, len(X), CHUNK)]
    return np.vstack(parts)
