"""Read the EXISTING pipeline outputs (data contract v1) and the ML inputs.

Inputs (all under one data directory, e.g. data-products/ or a demo copy):
  index.json, region/{presetId}.json        contract v1, unchanged
  ml_inputs/cell_month.parquet              real per-cell-month sensor aggregates (schema: docs/ml_features.md)
  ml_inputs/demo_cells.json                 DEMO ONLY: synthetic cell field, observations simulated here
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

REQUIRED_OBS_COLUMNS = {
    "cell_id": "string",
    "lat": "float",
    "lon": "float",
    "region": "string (preset id)",
    "country": "string (ISO-2)",
    "landcover": "string (MCD12Q1-derived class)",
    "ym": "YYYY-MM",
    "modis_terra": "cell-days (NaN when not observing)",
    "modis_aqua": "cell-days (NaN before 2002-07)",
    "viirs": "reference-satellite VIIRS cell-days (NaN outside the overlap)",
    "frp_mean": "MW, mean FRP of the month's MODIS detections (NaN if none; never from VIIRS: that would leak the target)",
    "frp_max": "MW, max FRP of the month's MODIS detections",
    "scan_mean": "deg, mean MODIS scan angle",
    "pix_km2": "km2, mean MODIS pixel area",
    "day_share": "0..1, share of daytime detections",
    "ndvi": "monthly NDVI (MOD13A3/VNP13A3), NaN if unavailable",
}


def ym_add(ym: str, n: int) -> str:
    y, m = int(ym[:4]), int(ym[5:7])
    k = y * 12 + (m - 1) + n
    return f"{k // 12:04d}-{k % 12 + 1:02d}"


def months_between(first: str, last: str) -> list[str]:
    out, cur = [], first
    while cur <= last:
        out.append(cur)
        cur = ym_add(cur, 1)
    return out


def tile_id(lat: float, lon: float, deg: float) -> str:
    """Contract grid tile id: south-west corner floored to the tile size, e.g. "22_88"."""
    return f"{int(math.floor(lat / deg) * deg)}_{int(math.floor(lon / deg) * deg)}"


def load_contract(data_dir: Path) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    idx_path = data_dir / "index.json"
    if not idx_path.exists():
        raise FileNotFoundError(f"{idx_path} not found. Run the pipeline, or `make ml-demo-inputs` for demo inputs.")
    index = json.loads(idx_path.read_text(encoding="utf-8"))
    regions = {}
    for p in index["presets"]:
        f = data_dir / "region" / f"{p['id']}.json"
        if f.exists():
            regions[p["id"]] = json.loads(f.read_text(encoding="utf-8"))
    return index, regions


def context_frame(regions: dict[str, dict[str, Any]]) -> pd.DataFrame:
    """NASA POWER context per region-month (t2m, precip, rh). Missing regions simply have no rows."""
    rows = []
    for rid, r in regions.items():
        for c in r.get("context") or []:
            rows.append({"region": rid, "ym": c["ym"], "t2m": c["t2m_c"], "precip": c["precip_mm"], "rh": c["rh_pct"]})
    return pd.DataFrame(rows, columns=["region", "ym", "t2m", "precip", "rh"])


def load_observations(data_dir: Path, index: dict[str, Any], regions: dict[str, dict[str, Any]], seed: int) -> tuple[pd.DataFrame, str, list[str]]:
    """Cell x month observation table, its provenance ("live"/"demo") and notes on missing inputs."""
    notes: list[str] = []
    real = data_dir / "ml_inputs" / "cell_month.parquet"
    demo = data_dir / "ml_inputs" / "demo_cells.json"
    if real.exists():
        obs = pd.read_parquet(real)
        missing = [c for c in REQUIRED_OBS_COLUMNS if c not in obs.columns]
        if missing:
            raise ValueError(f"{real} is missing columns {missing}; see docs/ml_features.md")
        source = "live"
    elif demo.exists():
        from .demo_inputs import simulate

        obs = simulate(json.loads(demo.read_text(encoding="utf-8")), regions, seed)
        source = "demo"
        notes.append("DEMO: sensor observations are simulated on the synthetic demo field (src/compute/ml/demo_inputs.py).")
    else:
        raise FileNotFoundError(f"No ML inputs in {data_dir / 'ml_inputs'} (cell_month.parquet or demo_cells.json).")

    if "tile" not in obs.columns:  # spatial CV blocks; the demo simulator adds it, real inputs derive it here
        from .config import TILE_DEG

        obs["tile"] = [tile_id(a, b, TILE_DEG) for a, b in zip(obs["lat"], obs["lon"])]
    if "ndvi" not in obs.columns or obs["ndvi"].isna().all():
        obs["ndvi"] = np.nan
        notes.append("NDVI unavailable: filled as missing (XGBoost handles NaN).")
    ctx = context_frame(regions)
    for rid in sorted(obs["region"].unique()):
        if ctx.empty or rid not in set(ctx["region"]):
            notes.append(f"NASA POWER context unavailable for {rid}: filled as missing.")
    obs = obs.drop(columns=[c for c in ("t2m", "precip", "rh") if c in obs.columns]).merge(ctx, on=["region", "ym"], how="left")
    return obs, source, notes
