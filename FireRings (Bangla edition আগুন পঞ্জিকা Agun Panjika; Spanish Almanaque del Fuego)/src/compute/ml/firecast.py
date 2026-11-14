"""FireCast: next-months fire-activity terciles from the HARMONIZED record.

Target: tercile class (0 below / 1 near / 2 above) of month t+lead relative to
the unit's own climatology for that calendar month (thresholds from the
climatology years only). Baselines: C0 climatology (the climatological class
frequencies, 1/3 each without ties) and persistence.

Region model (one per lead): leave-one-year-out hindcast over every year;
the climatology of each fold excludes the held-out year. Out-of-fold
probabilities of the first 40 % of years calibrate (temperature scaling) and
set the 90 % LAC prediction-set threshold; the remaining years evaluate
(RPSS with a year-block bootstrap 90 % interval, Brier, reliability).

Cell model (map layer, first lead only): train / calibration / evaluation
year blocks; per-cell RPSS with a year-block bootstrap.

"skilful" = RPSS > 0 AND the lower end of its bootstrap 90 % interval > 0.

Demo evidence ("fake trend"): the same simple model is trained on the RAW
combined record (VIIRS where it exists, else MODIS) and on the HARMONIZED
record; Theil-Sen slopes and Mann-Kendall p-values of their fitted yearly
totals show the jump a raw-trained model learns at viirs_start.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd
import xgboost as xgb
from scipy.optimize import minimize_scalar
from scipy.stats import kendalltau, theilslopes

from .config import ALPHA, CLASSES, F_FEATURES, F_FEATURES_CELL, N_BOOT, N_JOBS, SEED, XGB_F_CELL, XGB_F_REGION
from .explain import grouped, multiclass_shap
from .features import UnitSeries, cell_unit_series, firecast_frame, region_unit_series
from .io import months_between, ym_add

# ---------------------------------------------------------------- scores


def rps(p: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Ranked probability score per row (3 ordered categories)."""
    o = np.eye(3)[y]
    return ((np.cumsum(p, 1)[:, :2] - np.cumsum(o, 1)[:, :2]) ** 2).sum(1)


def rpss(p: np.ndarray, y: np.ndarray, pc: np.ndarray) -> float:
    ref = rps(pc, y).mean()
    return float(1 - rps(p, y).mean() / ref) if ref > 0 else float("nan")


def brier(p: np.ndarray, y: np.ndarray) -> float:
    return float(((p - np.eye(3)[y]) ** 2).sum(1).mean())


def bootstrap_rpss(p: np.ndarray, y: np.ndarray, pc: np.ndarray, blocks: np.ndarray, n_boot: int = N_BOOT, seed: int = SEED) -> tuple[float, float]:
    """90 % interval of RPSS, resampling whole blocks (years) with replacement."""
    ub = np.unique(blocks)
    if len(ub) < 3:
        return float("nan"), float("nan")
    rm, rc = rps(p, y), rps(pc, y)
    sm = np.array([rm[blocks == b].sum() for b in ub])
    sc = np.array([rc[blocks == b].sum() for b in ub])
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, len(ub), size=(n_boot, len(ub)))
    with np.errstate(all="ignore"):
        vals = 1 - sm[idx].sum(1) / sc[idx].sum(1)
    vals = vals[np.isfinite(vals)]
    return float(np.quantile(vals, 0.05)), float(np.quantile(vals, 0.95))


def temperature(p: np.ndarray, T: float) -> np.ndarray:
    z = np.log(np.clip(p, 1e-6, 1)) / T
    z = np.exp(z - z.max(1, keepdims=True))
    return z / z.sum(1, keepdims=True)


def fit_temperature(p: np.ndarray, y: np.ndarray) -> float:
    if len(y) < 20:
        return 1.0
    nll = lambda T: -np.log(temperature(p, T)[np.arange(len(y)), y] + 1e-9).mean()  # noqa: E731
    return float(minimize_scalar(nll, bounds=(0.4, 4.0), method="bounded").x)


def lac_threshold(p: np.ndarray, y: np.ndarray, alpha: float = ALPHA) -> float:
    """LAC conformal sets: include class k when p_k >= 1 - q."""
    s = np.sort(1 - p[np.arange(len(y)), y])
    n = len(s)
    k = int(np.ceil((n + 1) * (1 - alpha)))
    return float(s[min(k, n) - 1]) if n else 1.0


def pred_sets(p: np.ndarray, q: float) -> np.ndarray:
    s = p >= 1 - q
    s[np.arange(len(p)), p.argmax(1)] = True  # never empty
    return s


def reliability(p_above: np.ndarray, hit: np.ndarray, bins: int = 10) -> list[dict[str, Any]]:
    out = []
    edges = np.linspace(0, 1, bins + 1)
    for i in range(bins):
        sel = (p_above >= edges[i]) & ((p_above < edges[i + 1]) if i < bins - 1 else (p_above <= 1))
        if sel.sum() > 0:
            out.append({"bin": round(float(edges[i] + 0.5 / bins), 2), "predicted": round(float(p_above[sel].mean()), 3), "observed": round(float(hit[sel].mean()), 3), "n": int(sel.sum())})
    return out


def persistence_probs(lag0: np.ndarray, pc: np.ndarray) -> np.ndarray:
    """Persistence: 60 % on the class the latest month is in (vs its normal), 20 % on each other class."""
    cls = np.where(lag0 < -0.15, 0, np.where(lag0 > 0.15, 2, 1))
    p = np.full((len(lag0), 3), 0.2)
    p[np.arange(len(lag0)), cls] = 0.6
    return p


def _fit(X: np.ndarray, y: np.ndarray, params: dict[str, Any], seed: int) -> xgb.XGBClassifier:
    present = np.unique(y)
    if len(present) < 3:  # guarantee all classes exist for softprob
        X = np.vstack([X, np.zeros((3, X.shape[1]))])
        y = np.concatenate([y, [0, 1, 2]])
    return xgb.XGBClassifier(**params, random_state=seed, n_jobs=N_JOBS).fit(X.astype(np.float32), y)


# ---------------------------------------------------------------- region model


@dataclass
class RegionForecast:
    leads: list[int]
    targets: list[str]
    origin: str
    per_lead: dict[int, dict[str, Any]]
    forecasts: dict[str, list[dict[str, Any]]]  # region -> list per target month
    summary: dict[str, Any]
    shap_global: np.ndarray
    shap_names: list[str]


def run_region(index: dict[str, Any], region_h: dict[str, pd.Series], hf: pd.DataFrame, complete_until: str, log=print) -> tuple[RegionForecast, UnitSeries]:
    us = region_unit_series(index, region_h, hf)
    origin = complete_until
    targets = [ym_add(index["last_month"], i) for i in (1, 2, 3)]
    leads = [len(months_between(origin, t)) - 1 for t in targets]
    years = sorted({int(m[:4]) for m in us.months if m <= complete_until})
    hind_years = [y for y in years if y >= years[0] + 1]
    n_cal = max(3, int(round(0.4 * len(hind_years))))
    cal_years, eval_years = hind_years[:n_cal], hind_years[n_cal:]

    per_lead: dict[int, dict[str, Any]] = {}
    forecasts: dict[str, list[dict[str, Any]]] = {u: [] for u in us.units}
    all_eval: list[pd.DataFrame] = []
    shap_rows = []
    for L, tgt in zip(leads, targets):
        oof = []
        for Y in hind_years:
            clim = [y for y in years if y != Y]
            fr = firecast_frame(us, L, clim, complete_until)
            tr, te = fr[fr["year_target"] != Y], fr[fr["year_target"] == Y]
            if te.empty or tr.empty:
                continue
            m = _fit(tr[F_FEATURES].to_numpy(float), tr["y_f"].to_numpy(int), XGB_F_REGION, SEED + L)
            te = te.copy()
            te[["p0", "p1", "p2"]] = m.predict_proba(te[F_FEATURES].to_numpy(np.float32))
            oof.append(te)
        o = pd.concat(oof, ignore_index=True)
        P = o[["p0", "p1", "p2"]].to_numpy()
        y = o["y_f"].to_numpy(int)
        PC = o[["pc0", "pc1", "pc2"]].to_numpy()
        is_cal = o["year_target"].isin(cal_years).to_numpy()
        T = fit_temperature(P[is_cal], y[is_cal])
        Pt = temperature(P, T)
        q = lac_threshold(Pt[is_cal], y[is_cal])
        ev = ~is_cal
        o[["c0", "c1", "c2"]] = Pt
        o["L"] = L
        all_eval.append(o[ev])
        sets = pred_sets(Pt[ev], q)
        lead_rep: dict[str, Any] = {
            "lead": L,
            "temperature": round(T, 3),
            "lac_q": round(q, 4),
            "rpss": round(rpss(Pt[ev], y[ev], PC[ev]), 4),
            "rpss_persistence": round(rpss(persistence_probs(o["lag0_anom"].to_numpy()[ev], PC[ev]), y[ev], PC[ev]), 4),
            "brier": round(brier(Pt[ev], y[ev]), 4),
            "brier_clim": round(brier(PC[ev], y[ev]), 4),
            "set_coverage": round(float(sets[np.arange(ev.sum()), y[ev]].mean()), 4),
            "mean_set_size": round(float(sets.sum(1).mean()), 3),
            "n_eval": int(ev.sum()),
            "regions": {},
        }
        for u in us.units:
            sel = ev & (o["unit"] == u).to_numpy()
            if sel.sum() < 12:
                continue
            r = rpss(Pt[sel], y[sel], PC[sel])
            lo, hi = bootstrap_rpss(Pt[sel], y[sel], PC[sel], o["year_target"].to_numpy()[sel])
            by_m = {}
            for mm in range(1, 13):
                s2 = sel & (o["target"].str.slice(5, 7).astype(int) == mm).to_numpy()
                if s2.sum() >= 4:
                    by_m[mm] = round(rpss(Pt[s2], y[s2], PC[s2]), 3)
            lead_rep["regions"][u] = {"rpss": round(r, 4), "ci90": [round(lo, 4), round(hi, 4)], "skilful": bool(r > 0 and lo > 0), "by_month": by_m, "n": int(sel.sum())}
        per_lead[L] = lead_rep
        log(f"  FireCast lead {L} ({tgt}): RPSS {lead_rep['rpss']:+.3f} (persistence {lead_rep['rpss_persistence']:+.3f}), Brier {lead_rep['brier']:.3f} vs clim {lead_rep['brier_clim']:.3f}, set coverage {lead_rep['set_coverage']:.2f}")

        # Final model on every year, forecast from the origin
        fr_all = firecast_frame(us, L, years, complete_until)
        m = _fit(fr_all[F_FEATURES].to_numpy(float), fr_all["y_f"].to_numpy(int), XGB_F_REGION, SEED + L)
        live = firecast_frame(us, L, years, complete_until, origins=[origin])
        X = live[F_FEATURES].to_numpy(np.float32)
        p_live = temperature(m.predict_proba(X), T)
        sv = multiclass_shap(m, X, F_FEATURES)
        g, keys = grouped(sv, F_FEATURES)
        shap_rows.append(grouped(multiclass_shap(m, fr_all[F_FEATURES].to_numpy(np.float32), F_FEATURES), F_FEATURES)[0])
        live_sets = pred_sets(p_live, q)
        for i, u in enumerate(live["unit"]):
            reg = lead_rep["regions"].get(u, {})
            tm = int(tgt[5:7])
            month_ok = reg.get("by_month", {}).get(tm, 0) > 0
            order = np.argsort(-np.abs(g[i]))[:3]
            forecasts[u].append(
                {
                    "ym": tgt,
                    "lead": L,
                    "p": [round(float(x), 3) for x in p_live[i]],
                    "set": [CLASSES[k] for k in range(3) if live_sets[i, k]],
                    "skilful": bool(reg.get("skilful", False) and month_ok),
                    "rpss": reg.get("rpss"),
                    "rpss_ci90": reg.get("ci90"),
                    "rpss_month": reg.get("by_month", {}).get(tm),
                    "drivers": [{"feature": keys[k], "contrib": round(float(g[i, k]), 4), "value": _driver_value(keys[k], live.iloc[i])} for k in order],
                }
            )

    ev = pd.concat(all_eval, ignore_index=True)
    Pe = ev[["c0", "c1", "c2"]].to_numpy()
    ye = ev["y_f"].to_numpy(int)
    summary = {
        "origin": origin,
        "hindcast": "leave-one-year-out",
        "calibration_years": f"{cal_years[0]}-{cal_years[-1]}",
        "evaluation_years": f"{eval_years[0]}-{eval_years[-1]}" if eval_years else "",
        "rpss": round(rpss(Pe, ye, ev[["pc0", "pc1", "pc2"]].to_numpy()), 4),
        "brier": round(brier(Pe, ye), 4),
        "brier_clim": round(brier(ev[["pc0", "pc1", "pc2"]].to_numpy(), ye), 4),
        "reliability": reliability(Pe[:, 2], (ye == 2).astype(float)),
        "n_eval": int(len(ye)),
    }
    shap_all = np.vstack(shap_rows)
    return RegionForecast(leads, targets, origin, per_lead, forecasts, summary, shap_all, keys), us


def _driver_value(feature: str, row: pd.Series) -> Any:
    if feature in ("lag0_anom", "lag1_anom", "lag2_anom", "reg_lag0_anom"):
        return round(float(np.exp(row[feature])), 2)  # ratio to normal
    if feature == "season":
        return int(row["target"][5:7])
    if feature == "clim_log":
        return round(float(np.expm1(row["clim_log"])), 1)
    if feature == "region_code":
        return str(row["unit"])
    v = row.get(feature)
    return None if v is None or not np.isfinite(v) else round(float(v), 2)


# ---------------------------------------------------------------- cell model (risk map)


def run_cells(index: dict[str, Any], cell_h: pd.DataFrame, hf: pd.DataFrame, region_us: UnitSeries, target: str, complete_until: str, quick: bool = False, log=print) -> tuple[pd.DataFrame, dict[str, Any]]:
    years = sorted({int(m[:4]) for m in region_us.months if m <= complete_until})
    ys = years[1:]
    n_tr = int(round(0.65 * len(ys)))
    n_cal = max(2, int(round(0.15 * len(ys))))
    tr_y, cal_y, ev_y = ys[:n_tr], ys[n_tr : n_tr + n_cal], ys[n_tr + n_cal :]
    L = len(months_between(complete_until, target)) - 1

    def reg_lag0(clim: list[int]) -> np.ndarray:
        fr = firecast_frame(region_us, 0, clim, complete_until)  # lead 0: lag0 anomaly at each month
        piv = fr.pivot(index="unit", columns="origin", values="lag0_anom").reindex(index=region_us.units, columns=region_us.months)
        return piv.to_numpy(float)

    us = cell_unit_series(index, cell_h, hf, region_us, reg_lag0(tr_y))
    fr = firecast_frame(us, L, tr_y, complete_until)
    tr = fr[fr["year_target"].isin(tr_y)]
    if quick:
        tr = tr.sample(min(len(tr), 60_000), random_state=SEED)
    m = _fit(tr[F_FEATURES_CELL].to_numpy(float), tr["y_f"].to_numpy(int), XGB_F_CELL, SEED)
    cal = fr[fr["year_target"].isin(cal_y)]
    ev = fr[fr["year_target"].isin(ev_y)]
    pcal = m.predict_proba(cal[F_FEATURES_CELL].to_numpy(np.float32))
    T = fit_temperature(pcal, cal["y_f"].to_numpy(int))
    q = lac_threshold(temperature(pcal, T), cal["y_f"].to_numpy(int))
    pev = temperature(m.predict_proba(ev[F_FEATURES_CELL].to_numpy(np.float32)), T)
    yev = ev["y_f"].to_numpy(int)
    pc_ev = ev[["pc0", "pc1", "pc2"]].to_numpy()

    # Per-cell RPSS with a year-block bootstrap (vectorized over cells)
    units = us.units
    upos = {u: i for i, u in enumerate(units)}
    ui = ev["unit"].map(upos).to_numpy()
    yi = ev["year_target"].map({y: i for i, y in enumerate(ev_y)}).to_numpy()
    sm = np.zeros((len(units), len(ev_y)))
    sc = np.zeros((len(units), len(ev_y)))
    np.add.at(sm, (ui, yi), rps(pev, yev))
    np.add.at(sc, (ui, yi), rps(pc_ev, yev))
    with np.errstate(all="ignore"):
        cell_rpss = 1 - sm.sum(1) / sc.sum(1)
        rng = np.random.default_rng(SEED)
        draws = rng.multinomial(len(ev_y), np.full(len(ev_y), 1 / len(ev_y)), size=400).T  # years x B
        boot = 1 - (sm @ draws) / (sc @ draws)
    lo = np.nanquantile(boot, 0.05, axis=1) if len(ev_y) >= 3 else np.full(len(units), np.nan)
    skil = (cell_rpss > 0) & (lo > 0)

    # Live forecast: refit on every complete year (T and q from the calibration block)
    clim_all = years
    us_all = cell_unit_series(index, cell_h, hf, region_us, reg_lag0(clim_all))
    fr_all = firecast_frame(us_all, L, clim_all, complete_until)
    if quick:
        fr_all = fr_all.sample(min(len(fr_all), 60_000), random_state=SEED)
    m_all = _fit(fr_all[F_FEATURES_CELL].to_numpy(float), fr_all["y_f"].to_numpy(int), XGB_F_CELL, SEED)
    live = firecast_frame(us_all, L, clim_all, complete_until, origins=[complete_until])
    p_live = temperature(m_all.predict_proba(live[F_FEATURES_CELL].to_numpy(np.float32)), T)
    sets = pred_sets(p_live, q)
    meta = hf.drop_duplicates("cell_id").set_index("cell_id")
    out = pd.DataFrame(
        {
            "id": live["unit"].to_numpy(),
            "p_above": np.round(p_live[:, 2], 3),
            "set_size": sets.sum(1).astype(int),
            "skilful": skil[[upos[u] for u in live["unit"]]],
            "rpss": np.round(cell_rpss[[upos[u] for u in live["unit"]]], 3),
        }
    )
    out["lat"] = meta.loc[out["id"], "lat"].to_numpy()
    out["lon"] = meta.loc[out["id"], "lon"].to_numpy()
    out["tile"] = meta.loc[out["id"], "tile"].to_numpy()
    rep = {
        "target": target,
        "lead": L,
        "train_years": f"{tr_y[0]}-{tr_y[-1]}",
        "calibration_years": f"{cal_y[0]}-{cal_y[-1]}",
        "evaluation_years": f"{ev_y[0]}-{ev_y[-1]}" if ev_y else "",
        "rpss": round(rpss(pev, yev, pc_ev), 4),
        "brier": round(brier(pev, yev), 4),
        "share_skilful": round(float(np.nanmean(skil)), 4),
        "set_coverage": round(float(pred_sets(pev, q)[np.arange(len(yev)), yev].mean()), 4),
        "cells": int(len(units)),
    }
    log(f"  FireCast cells ({rep['cells']} cells, {target}): RPSS {rep['rpss']:+.3f}, skilful cells {rep['share_skilful']:.0%}")
    return out, rep


# ---------------------------------------------------------------- fake-trend evidence


def _trend_model_fit(months: list[str], y: np.ndarray) -> np.ndarray:
    t = np.array([int(m[:4]) + (int(m[5:7]) - 0.5) / 12 for m in months])
    mo = np.array([int(m[5:7]) for m in months])
    X = np.column_stack([t, np.sin(2 * np.pi * mo / 12), np.cos(2 * np.pi * mo / 12)]).astype(np.float32)
    m = xgb.XGBRegressor(objective="count:poisson", n_estimators=200, max_depth=3, learning_rate=0.08, random_state=SEED, n_jobs=N_JOBS).fit(X, y)
    return m.predict(X)


def trend_evidence(region: dict[str, Any], ml_series: pd.Series, viirs_start: str, complete_until: str) -> tuple[dict[str, Any], dict[str, Any]]:
    """Yearly totals fitted by the same model trained on raw vs harmonized records."""
    mon = [p for p in region["monthly"] if p["ym"] <= complete_until]
    months = [p["ym"] for p in mon]
    raw = np.array([p["viirs_raw"] if p["viirs_raw"] is not None else (p["modis_raw"] or 0) for p in mon], float)
    harm = ml_series.reindex(months).to_numpy(float)
    out = []
    for series in (raw, harm):
        fitted = _trend_model_fit(months, np.nan_to_num(series))
        df = pd.DataFrame({"y": [int(m[:4]) for m in months], "v": fitted})
        g = df.groupby("y")["v"].agg(["sum", "count"])
        g = g[g["count"] == 12]
        yrs = g.index.to_numpy()
        vals = g["sum"].to_numpy()
        slope = theilslopes(vals, yrs)[0] if len(yrs) > 2 else float("nan")
        p = kendalltau(yrs, vals).pvalue if len(yrs) > 2 else float("nan")
        vy = int(viirs_start[:4])
        before = vals[yrs < vy]
        after = vals[yrs >= vy]
        jump = float(after.mean() / before.mean()) if len(before) and len(after) and before.mean() > 0 else float("nan")
        out.append({"years": [int(x) for x in yrs], "values": [round(float(v), 1) for v in vals], "slope": round(float(slope), 3), "p": round(float(p), 4), "jump_ratio": round(jump, 3)})
    return out[0], out[1]
