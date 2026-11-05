"""Tiny, deterministic contract-v1 + demo-cell fixture, so the ML tests run in
seconds without Node or the full demo data."""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pytest

from src.compute.ml.io import months_between

FIRST, LAST, VIIRS = "2000-11", "2026-11", "2012-01"
PRESETS = [
    {"id": "north", "name": {"en": "North", "bn": "উত্তর", "es": "Norte"}, "country": "BD", "bbox": [89.0, 22.0, 89.4, 22.3]},
    {"id": "south", "name": {"en": "South", "bn": "দক্ষিণ", "es": "Sur"}, "country": "AR", "bbox": [-59.4, -33.3, -59.0, -33.0]},
]


def write_fixture(root: Path, n_cells: int = 24, seed: int = 7) -> Path:
    rng = np.random.default_rng(seed)
    months = months_between(FIRST, LAST)
    K = len(months)
    mo = np.array([int(m[5:7]) for m in months])
    yr = np.array([int(m[:4]) for m in months])
    index = {"version": "1", "generated_at": "2026-11-05T00:00:00Z", "first_month": FIRST, "last_month": LAST, "presets": PRESETS, "viirs_start": VIIRS, "sensors": [], "grid": {"cell_km": 5.5, "tile_deg": 2}, "source": "demo"}
    (root / "region").mkdir(parents=True, exist_ok=True)
    (root / "ml_inputs").mkdir(parents=True, exist_ok=True)
    (root / "index.json").write_text(json.dumps(index), encoding="utf-8")
    demo = {"source": "demo", "first_month": FIRST, "last_month": LAST, "viirs_start": VIIRS, "partial_fraction": 0.2, "cell_deg": 0.05, "months": months, "regions": {}}
    for p, peak in zip(PRESETS, (3, 8)):
        season = 0.15 + np.exp(-((((mo - peak) + 6) % 12 - 6) ** 2) / 3.0)
        year_mult = np.exp(rng.normal(0, 0.3, 30))[yr - 2000]
        regional = season * year_mult * np.exp(rng.normal(0, 0.25, K))
        cells = []
        for i in range(n_cells):
            lat = p["bbox"][1] + 0.05 * (i // 6) + 0.025
            lon = p["bbox"][0] + 0.05 * (i % 6) + 0.025
            w = 0.5 + 3 * rng.random() ** 2
            v = w * regional * np.exp(rng.normal(0, 0.3, K))
            cells.append({"id": f"c_{lat:.4f}_{lon:.4f}", "lat": round(lat, 4), "lon": round(lon, 4), "v": [round(float(x), 3) for x in v]})
        demo["regions"][p["id"]] = {"country": p["country"], "bbox": p["bbox"], "kept_share": 1.0, "cells": cells}
        H = np.sum([c["v"] for c in cells], axis=0)
        monthly = []
        for k, m in enumerate(months):
            h = float(H[k])
            monthly.append({"ym": m, "harmonized": h, "low": h * 0.9, "high": h * 1.1, "modis_raw": round(h * 0.9), "viirs_raw": round(h * 3.3) if m >= VIIRS else None, "percentile": 50, "z": 0})
        south = p["bbox"][1] < 0
        context = [
            {"ym": m, "t2m_c": round(20 + 5 * math.cos(2 * math.pi * (int(m[5:7]) - (1 if south else 5)) / 12) + rng.normal(0, 0.8), 1), "precip_mm": round(max(0, 80 + 60 * math.cos(2 * math.pi * (int(m[5:7]) - 7) / 12) + rng.normal(0, 20)), 1), "rh_pct": int(60 + rng.normal(0, 5))}
            for m in months
        ]
        region = {"id": p["id"], "fire_year_start_month": 1, "monthly": monthly, "climatology": [], "current": {}, "onset": None, "context": context}
        (root / "region" / f"{p['id']}.json").write_text(json.dumps(region), encoding="utf-8")
    (root / "ml_inputs" / "demo_cells.json").write_text(json.dumps(demo), encoding="utf-8")
    return root


@pytest.fixture(scope="session")
def fixture_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return write_fixture(tmp_path_factory.mktemp("contract"))


@pytest.fixture(scope="session")
def ml_out(fixture_dir: Path, tmp_path_factory: pytest.TempPathFactory) -> Path:
    from src.compute.ml.run import main

    out = tmp_path_factory.mktemp("ml")
    assert main(["--data", str(fixture_dir), "--out", str(out), "--quick", "--now", "2026-11-05"]) == 0
    return out
