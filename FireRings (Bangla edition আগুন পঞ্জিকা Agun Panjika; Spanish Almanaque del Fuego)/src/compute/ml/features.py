"""Feature tables (unit: grid cell x month). Schema: docs/ml_features.md.

Leakage rules, enforced here and tested in tests/ml/test_leakage.py:
  * harmonization features for month t are observations OF month t (what
    MODIS saw that month) plus climatologies computed on training years only;
  * FireCast features for an origin month t use data up to and including t;
    the target is month t + lead; climatologies and tercile thresholds come
    from the years passed in `clim_years` (training years only).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

import numpy as np
import pandas as pd

from .config import LANDCOVER
from .io import months_between, ym_add


@dataclass(frozen=True)
class Splits:
    """Temporal split of the overlap: train / calibration block / test (never used for tuning)."""

    train: tuple[int, int]
    cal: int
    test: tuple[int, int]
    last_complete: str

    def label(self) -> dict[str, str]:
        return {"train": f"{self.train[0]}-{self.train[1]}", "cal": str(self.cal), "test": f"{self.test[0]}-{self.test[1]}"}


def make_splits(index: dict[str, Any], partial: bool) -> Splits:
    vs = int(index["viirs_start"][:4])
    last_complete = ym_add(index["last_month"], -1) if partial else index["last_month"]
    ly = int(last_complete[:4])
    train_end = 2019 if vs <= 2012 else vs + 5
    train_end = min(train_end, ly - 2)
    return Splits(train=(vs, train_end), cal=train_end + 1, test=(train_end + 2, ly), last_complete=last_complete)


def is_partial_last(index: dict[str, Any], now: pd.Timestamp | None = None) -> bool:
    """Contract rule: the last month is partial when it is the current UTC month."""
    now = now or pd.Timestamp.now(tz="UTC")
    return index["last_month"] == f"{now.year:04d}-{now.month:02d}"


def region_codes(index: dict[str, Any]) -> dict[str, int]:
    return {p["id"]: i for i, p in enumerate(index["presets"])}


def _clim(df: pd.DataFrame, by: list[str], col: str, train_mask: pd.Series, how: str) -> pd.Series:
    agg = df.loc[train_mask].groupby(by, observed=True)[col].agg(how)
    return df[by].merge(agg.rename("_c").reset_index(), on=by, how="left")["_c"].to_numpy()


def build_harmonization_features(obs: pd.DataFrame, index: dict[str, Any], splits: Splits, partial_month: str | None) -> pd.DataFrame:
    df = obs.copy()
    df["year"] = df["ym"].str.slice(0, 4).astype(int)
    df["month"] = df["ym"].str.slice(5, 7).astype(int)
    df["partial"] = df["ym"] == partial_month if partial_month else False
    df["modis_terra"] = df["modis_terra"].astype(float)
    df["modis_n"] = df["modis_terra"].fillna(0) + df["modis_aqua"].fillna(0)
    df["log_modis"] = np.log1p(df["modis_n"])
    df["head"] = np.where(df["modis_aqua"].isna(), "t", "ta")
    if not isinstance(df["landcover"].dtype, pd.CategoricalDtype):
        df["landcover"] = pd.Categorical(df["landcover"], categories=LANDCOVER)
    df["lc_code"] = df["landcover"].cat.codes.astype(float)
    df["region_code"] = df["region"].map(region_codes(index)).astype(float)
    df["month_sin"] = np.sin(2 * np.pi * df["month"] / 12)
    df["month_cos"] = np.cos(2 * np.pi * df["month"] / 12)

    train = (df["year"] >= splits.train[0]) & (df["year"] <= splits.train[1]) & ~df["partial"]
    df["clim_modis"] = _clim(df, ["cell_id", "month"], "modis_n", train, "median")
    df["ndvi_anom"] = df["ndvi"] - _clim(df, ["cell_id", "month"], "ndvi", train, "mean")

    # 3-month rainfall anomaly (t, t-1, t-2) per region vs training-year climatology
    reg = df.drop_duplicates(["region", "ym"])[["region", "ym", "year", "month", "precip"]].sort_values(["region", "ym"]).copy()
    rtrain = (reg["year"] >= splits.train[0]) & (reg["year"] <= splits.train[1])
    reg["p_anom"] = reg["precip"] - _clim(reg, ["region", "month"], "precip", rtrain, "mean")
    reg["precip3_anom"] = reg.groupby("region")["p_anom"].transform(lambda s: s.rolling(3, min_periods=3).sum())
    df = df.merge(reg[["region", "ym", "precip3_anom"]], on=["region", "ym"], how="left")
    # Observable spatial context of the same month: busy regions / neighbourhoods have more
    # small fires per MODIS detection, which a single cell cannot see on its own.
    df["_q_lat"] = np.floor(df["lat"] / 0.25)
    df["_q_lon"] = np.floor(df["lon"] / 0.25)
    for col, src in (("modis", "modis_n"), ("terra", "modis_terra")):
        df[f"reg_{col}"] = np.log1p(df.groupby(["region", "ym"], observed=True)[src].transform("mean"))
        df[f"nbr_{col}"] = np.log1p(df.groupby(["region", "ym", "_q_lat", "_q_lon"], observed=True)[src].transform("mean"))
    df = df.drop(columns=["_q_lat", "_q_lon"])
    df["y_h"] = df["viirs"]
    return df


# ---------------------------------------------------------------- FireCast


@dataclass
class UnitSeries:
    """Monthly harmonized activity per unit (region or cell) plus its weather, as U x K matrices."""

    units: list[str]
    months: list[str]
    h: np.ndarray  # U x K harmonized activity
    precip: np.ndarray  # U x K
    t2m: np.ndarray
    rh: np.ndarray
    ndvi: np.ndarray
    region_code: np.ndarray  # U
    lc_code: np.ndarray  # U (NaN for regions)
    reg_lag0: np.ndarray | None = None  # U x K regional lag0 anomaly (cells only)


def _month_clim(x: np.ndarray, month_no: np.ndarray, use: np.ndarray, fn) -> np.ndarray:
    """U x 12 climatology of x over the columns in `use`."""
    out = np.full((x.shape[0], 12), np.nan)
    for m in range(1, 13):
        cols = use & (month_no == m)
        if cols.any():
            with np.errstate(all="ignore"):
                out[:, m - 1] = fn(x[:, cols], axis=1)
    return out


def firecast_frame(us: UnitSeries, lead: int, clim_years: Iterable[int], complete_until: str, origins: Iterable[str] | None = None) -> pd.DataFrame:
    """One row per (unit, origin month t) with features observable at t and the
    tercile class of month t + lead (y_f = -1 when the target is not observed yet)."""
    months = us.months
    K = len(months)
    month_no = np.array([int(m[5:7]) for m in months])
    years = np.array([int(m[:4]) for m in months])
    complete = np.array([m <= complete_until for m in months])
    cy = np.isin(years, list(clim_years)) & complete

    med = _month_clim(us.h, month_no, cy, np.nanmedian)
    q33 = _month_clim(us.h, month_no, cy, lambda a, axis: np.nanquantile(a, 1 / 3, axis=axis))
    q67 = _month_clim(us.h, month_no, cy, lambda a, axis: np.nanquantile(a, 2 / 3, axis=axis))
    p_clim = _month_clim(us.precip, month_no, cy, np.nanmean)
    t_clim = _month_clim(us.t2m, month_no, cy, np.nanmean)
    rh_clim = _month_clim(us.rh, month_no, cy, np.nanmean)
    nd_clim = _month_clim(us.ndvi, month_no, cy, np.nanmean)

    def classes(v: np.ndarray, mi: np.ndarray) -> np.ndarray:
        lo = np.take_along_axis(q33, mi, axis=1)
        hi = np.take_along_axis(q67, mi, axis=1)
        return np.where(v < lo, 0, np.where(v > hi, 2, 1))

    # climatological class frequencies per unit x calendar month (the C0 reference forecast)
    cls_all = classes(us.h, np.broadcast_to(month_no - 1, us.h.shape).copy())
    pc = np.zeros((us.h.shape[0], 12, 3))
    for m in range(1, 13):
        cols = cy & (month_no == m)
        n = max(1, cols.sum())
        for k in range(3):
            pc[:, m - 1, k] = (cls_all[:, cols] == k).sum(axis=1) / n
    pc = np.where(pc.sum(axis=2, keepdims=True) > 0, pc, 1 / 3)
    pc = (pc + 0.01) / (pc + 0.01).sum(axis=2, keepdims=True)  # never exactly 0 (RPSS / log-loss safe)

    p_anom = us.precip - p_clim[:, month_no - 1]
    p3 = p_anom.copy()
    p3[:, 1:] += p_anom[:, :-1]
    p3[:, 2:] += p_anom[:, :-2]
    p3[:, :2] = np.nan

    origin_set = set(origins) if origins is not None else None
    rows = []
    pos = {m: i for i, m in enumerate(months)}
    for t in range(2, K):
        if not complete[t]:
            continue
        if origin_set is not None and months[t] not in origin_set:
            continue
        tgt = ym_add(months[t], lead)
        k = pos.get(tgt)
        tm = int(tgt[5:7])
        lag = [np.log((us.h[:, t - j] + 1) / (med[:, month_no[t - j] - 1] + 1)) for j in range(3)]
        if k is not None and complete[k]:
            y = classes(us.h[:, [k]], np.full((us.h.shape[0], 1), tm - 1))[:, 0]
            obs_v = us.h[:, k]
        else:
            if origin_set is None:
                continue
            y = np.full(us.h.shape[0], -1)
            obs_v = np.full(us.h.shape[0], np.nan)
        frame = {
            "unit": us.units,
            "origin": months[t],
            "target": tgt,
            "lead": lead,
            "year_target": int(tgt[:4]),
            "lag0_anom": lag[0],
            "lag1_anom": lag[1],
            "lag2_anom": lag[2],
            "precip3_anom": p3[:, t],
            "t2m_anom": us.t2m[:, t] - t_clim[:, month_no[t] - 1],
            "rh_anom": us.rh[:, t] - rh_clim[:, month_no[t] - 1],
            "ndvi_anom": us.ndvi[:, t] - nd_clim[:, month_no[t] - 1],
            "month_sin": np.sin(2 * np.pi * tm / 12),
            "month_cos": np.cos(2 * np.pi * tm / 12),
            "clim_log": np.log1p(med[:, tm - 1]),
            "region_code": us.region_code,
            "lc_code": us.lc_code,
            "pc0": pc[:, tm - 1, 0],
            "pc1": pc[:, tm - 1, 1],
            "pc2": pc[:, tm - 1, 2],
            "y_f": y,
            "obs": obs_v,
        }
        if us.reg_lag0 is not None:
            frame["reg_lag0_anom"] = us.reg_lag0[:, t]
        rows.append(pd.DataFrame(frame))
    if not rows:
        return pd.DataFrame()
    return pd.concat(rows, ignore_index=True)


def region_unit_series(index: dict[str, Any], region_h: dict[str, pd.Series], hf: pd.DataFrame) -> UnitSeries:
    """Region-level series: harmonized activity per preset + NASA POWER context + mean cell NDVI."""
    units = [p["id"] for p in index["presets"] if p["id"] in region_h]
    months = months_between(index["first_month"], index["last_month"])
    codes = region_codes(index)
    wx = hf.groupby(["region", "ym"], observed=True).agg(precip=("precip", "first"), t2m=("t2m", "first"), rh=("rh", "first"), ndvi=("ndvi", "mean")).reset_index()

    def mat(col: str) -> np.ndarray:
        p = wx.pivot(index="region", columns="ym", values=col).reindex(index=units, columns=months)
        return p.to_numpy(dtype=float)

    h = np.vstack([region_h[u].reindex(months).to_numpy(dtype=float) for u in units])
    return UnitSeries(units, months, h, mat("precip"), mat("t2m"), mat("rh"), mat("ndvi"), np.array([codes[u] for u in units], float), np.full(len(units), np.nan))


def cell_unit_series(index: dict[str, Any], cell_h: pd.DataFrame, hf: pd.DataFrame, region_us: UnitSeries, region_lag0: np.ndarray) -> UnitSeries:
    """Cell-level series for the risk map. `cell_h` has columns cell_id, ym, h."""
    months = region_us.months
    h = cell_h.pivot(index="cell_id", columns="ym", values="h").reindex(columns=months)
    units = list(h.index)
    meta = hf.drop_duplicates("cell_id").set_index("cell_id").loc[units]

    def mat(col: str) -> np.ndarray:
        return hf.pivot(index="cell_id", columns="ym", values=col).reindex(index=units, columns=months).to_numpy(dtype=float)

    rpos = {u: i for i, u in enumerate(region_us.units)}
    ri = np.array([rpos[r] for r in meta["region"]])
    return UnitSeries(
        units,
        months,
        h.to_numpy(dtype=float),
        region_us.precip[ri],
        region_us.t2m[ri],
        region_us.rh[ri],
        mat("ndvi"),
        meta["region_code"].to_numpy(float),
        meta["lc_code"].to_numpy(float),
        region_lag0[ri],
    )
