"""DEMO ONLY: simulate per-cell-month MODIS and VIIRS observations.

The real pipeline aggregates FIRMS detections into ml_inputs/cell_month.parquet.
Until it exists, this module turns the app's synthetic activity field (the
same one the browser demo shows) into sensor observations with a known,
physically motivated sensor difference:

  * fire activity T (cell-days in harmonized units) comes from the demo field;
  * fire size (FRP) depends on land cover and season;
  * MODIS (1 km) misses small, cool fires and loses more at large scan angles
    (pixels grow towards the swath edge); VIIRS (375 m) sees small fires well;
  * clouds hide fires from both sensors (a shared, unobserved nuisance);
  * Terra flies from 2000, Aqua from 2002-07, the reference VIIRS satellite
    from `viirs_start`.

Every quantity is synthetic. Outputs computed from it are labelled "demo".
"""

from __future__ import annotations

import hashlib
from typing import Any

import numpy as np
import pandas as pd

from .config import LANDCOVER, TILE_DEG
from .io import tile_id

LC_MIX: dict[str, dict[str, float]] = {
    "sundarbans": {"mangrove": 0.55, "wetland": 0.15, "cropland": 0.30},
    "chittagong-hill-tracts": {"crop_mosaic": 0.45, "forest": 0.35, "shrubland": 0.20},
    "parana-delta": {"wetland": 0.60, "grassland": 0.25, "cropland": 0.15},
    "corrientes": {"grassland": 0.45, "savanna": 0.30, "cropland": 0.25},
}
DEFAULT_MIX = {"cropland": 0.4, "grassland": 0.3, "forest": 0.3}

# log(FRP, MW) of a typical fire, by land cover
LOG_FRP = {"cropland": 1.45, "crop_mosaic": 1.9, "grassland": 2.0, "wetland": 2.1, "shrubland": 2.2, "savanna": 2.35, "forest": 2.8, "mangrove": 2.5}
NDVI_BASE = {"cropland": 0.55, "crop_mosaic": 0.6, "grassland": 0.5, "wetland": 0.55, "shrubland": 0.5, "savanna": 0.45, "forest": 0.78, "mangrove": 0.72}


def _seed(*parts: object) -> int:
    return int.from_bytes(hashlib.sha256(":".join(map(str, parts)).encode()).digest()[:8], "little")


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-x))


def simulate(demo: dict[str, Any], regions: dict[str, dict[str, Any]], seed: int) -> pd.DataFrame:
    months: list[str] = demo["months"]
    K = len(months)
    month_no = np.array([int(m[5:7]) for m in months])
    viirs_start: str = demo["viirs_start"]
    ref_end = "2026-10" if viirs_start <= "2012-01" else "9999-12"  # Suomi-NPP delivery ended Oct 2026
    has_aqua = np.array([m >= "2002-07" for m in months])
    has_viirs = np.array([viirs_start <= m <= ref_end for m in months])
    frames = []
    for rid, reg in demo["regions"].items():
        cells = reg["cells"]
        C = len(cells)
        if C == 0:
            continue
        rng = np.random.default_rng(_seed(seed, rid, "obs"))
        T = np.asarray([c["v"] for c in cells], dtype=np.float64)  # C x K truth (harmonized units)
        lat = np.array([c["lat"] for c in cells])
        lon = np.array([c["lon"] for c in cells])

        # Land cover: spatially coherent 0.25-degree patches
        mix = LC_MIX.get(rid, DEFAULT_MIX)
        names, probs = list(mix), np.array(list(mix.values()))
        lc = []
        for la, lo in zip(lat, lon):
            r = np.random.default_rng(_seed(seed, rid, "lc", int(np.floor(la / 0.25)), int(np.floor(lo / 0.25))))
            lc.append(names[int(r.choice(len(names), p=probs / probs.sum()))])
        lc = np.array(lc)

        # Region weather (NASA POWER context from the region file) drives clouds and greenness.
        ctx = {c["ym"]: c for c in (regions.get(rid, {}).get("context") or [])}
        precip = np.array([ctx[m]["precip_mm"] if m in ctx else np.nan for m in months])
        p_clim = np.array([np.nanmean(precip[month_no == mm]) if np.isfinite(precip[month_no == mm]).any() else 0.0 for mm in month_no])
        p_anom = np.nan_to_num(precip - p_clim)
        p3 = np.convolve(p_anom, np.ones(3), mode="full")[:K]
        wet = np.nan_to_num(precip, nan=float(np.nanmean(precip)) if np.isfinite(precip).any() else 50.0)

        # Seasonal activity level of each cell (relative), for fire size
        cell_mean = T.mean(axis=1, keepdims=True) + 1e-6
        season = np.log((T + 0.05 * cell_mean) / cell_mean)

        mu = np.array([LOG_FRP[x] for x in lc])[:, None]
        log_frp = mu + 0.22 * np.clip(season, -2, 2) + rng.normal(0, 0.35, (C, K))
        frp_mean = np.exp(log_frp + 0.5 * 0.8**2)
        frp_max = frp_mean * np.exp(0.9 + 0.35 * np.abs(rng.normal(0, 1, (C, K)))) * (1 + np.log1p(T) / 3)
        scan = np.clip(30 + 8 * rng.normal(0, 1, (C, K)), 3, 55)
        pix = (1 / np.cos(np.radians(scan))) ** 3
        day_share = np.clip(0.76 + 0.08 * rng.normal(0, 1, (C, K)), 0.4, 0.98)
        cloud = np.clip(0.12 + wet[None, :] / 700 + 0.08 * rng.normal(0, 1, (C, K)), 0, 0.85)
        vis = 1 - cloud

        e_modis = _sigmoid(1.3 * (log_frp - 2.0) - 0.45 * (pix - 1.6) + 0.8 * (day_share - 0.76))
        e_viirs = _sigmoid(1.3 * (log_frp - 0.4) - 0.05 * (pix - 1.6) + 0.3 * (day_share - 0.76))
        lam_terra = T * 0.95 * e_modis * vis
        lam_aqua = T * 1.05 * e_modis * vis
        lam_viirs = T * 3.9 * e_viirs * vis
        terra = rng.poisson(lam_terra).astype(float)
        aqua = rng.poisson(lam_aqua).astype(float)
        viirs = rng.poisson(lam_viirs).astype(float)
        aqua[:, ~has_aqua] = np.nan
        viirs[:, ~has_viirs] = np.nan

        green_peak = 8 if np.mean(lat) >= 0 else 2
        ndvi_base = np.array([NDVI_BASE[x] for x in lc])[:, None]
        ndvi = (
            ndvi_base
            + 0.10 * np.cos(2 * np.pi * (month_no[None, :] - green_peak) / 12)
            + 0.00035 * p3[None, :]
            - 0.03 * np.log1p(np.concatenate([np.zeros((C, 1)), T[:, :-1]], axis=1))
            + rng.normal(0, 0.025, (C, K))
        )
        ndvi = np.clip(ndvi, -0.1, 0.95)

        frames.append(
            pd.DataFrame(
                {
                    "cell_id": np.repeat([c["id"] for c in cells], K),
                    "lat": np.repeat(lat, K),
                    "lon": np.repeat(lon, K),
                    "region": rid,
                    "country": reg.get("country", ""),
                    "landcover": np.repeat(lc, K),
                    "ym": np.tile(months, C),
                    "modis_terra": terra.ravel(),
                    "modis_aqua": aqua.ravel(),
                    "viirs": viirs.ravel(),
                    "frp_mean": frp_mean.ravel(),
                    "frp_max": frp_max.ravel(),
                    "scan_mean": scan.ravel(),
                    "pix_km2": pix.ravel(),
                    "day_share": day_share.ravel(),
                    "ndvi": ndvi.ravel(),
                    "_truth": T.ravel(),  # demo diagnostics only; never a feature
                }
            )
        )
    obs = pd.concat(frames, ignore_index=True)
    # FRP / scan angle / day share describe the month's MODIS detections, so they exist only
    # when MODIS saw something. (Using VIIRS detections here would leak the target.)
    none = (obs["modis_terra"].fillna(0) + obs["modis_aqua"].fillna(0)) == 0
    obs.loc[none, ["frp_mean", "frp_max", "scan_mean", "pix_km2", "day_share"]] = np.nan
    obs["landcover"] = pd.Categorical(obs["landcover"], categories=LANDCOVER)
    obs["tile"] = [tile_id(a, b, TILE_DEG) for a, b in zip(obs["lat"], obs["lon"])]
    return obs
