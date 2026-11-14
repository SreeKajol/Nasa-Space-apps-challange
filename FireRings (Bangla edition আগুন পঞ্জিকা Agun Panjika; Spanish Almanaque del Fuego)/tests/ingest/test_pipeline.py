"""Real-data pipeline end to end on SYNTHETIC normalized FIRMS rows (no network):
clean -> grid -> harmonize -> contract stage -> (node) region files -> seam test."""

from __future__ import annotations

import json
import shutil
import subprocess
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from src.compute import seam
from src.compute.ml.io import REQUIRED_OBS_COLUMNS, months_between
from src.compute.pipeline.build import PipelineError, build, clean, grid_cells
from src.ingest.firms import NORMALIZED_COLUMNS

ROOT = Path(__file__).resolve().parents[2]
BBOX = [89.0, 22.0, 89.3, 22.2]
VIIRS_START = "2018-04"


def synth_rows(seed: int = 3) -> pd.DataFrame:
    """Fires on a small box; MODIS sees ~half the fire cell-days, NOAA-20 ~85 % (from 2018-04)."""
    rng = np.random.default_rng(seed)
    cd = 5.5 / 111
    cells = [((i + 0.5) * cd, (j + 0.5) * cd) for i in range(int(22.0 / cd) + 1, int(22.2 / cd)) for j in range(int(89.0 / cd) + 1, int(89.3 / cd))]
    rows = []
    season = np.array([0.6, 1.2, 2.5, 2.4, 0.9, 0.2, 0.1, 0.1, 0.1, 0.2, 0.3, 0.4])
    for ym in months_between("2000-11", "2026-11"):
        y, m = int(ym[:4]), int(ym[5:7])
        last_day = 14 if ym == "2026-11" else (date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1)).day
        for k, (la, lo) in enumerate(cells):
            n = rng.poisson(season[m - 1] * (0.5 + (k % 5) / 4) * (1.4 if y in (2010, 2021) else 1.0))
            for day in rng.choice(np.arange(1, last_day + 1), size=min(n, last_day), replace=False):
                d = f"{ym}-{day:02d}"
                lat, lon = la + rng.uniform(-0.02, 0.02), lo + rng.uniform(-0.02, 0.02)
                if rng.random() < 0.5:
                    sat = "Terra" if ym < "2002-07" or rng.random() < 0.5 else "Aqua"
                    rows.append(("MODIS", sat, "MODIS", f"{d}T05:30:00Z", d, lat, lon, str(rng.integers(20, 100)), None, rng.gamma(2, 15), 1.0 + rng.random(), 1.0 + rng.random() / 2, "D" if rng.random() < 0.8 else "N", 0, "6.1", "SP", "x"))
                if ym >= VIIRS_START and rng.random() < 0.85:
                    for _ in range(rng.integers(1, 4)):
                        rows.append(("VIIRS", "NOAA-20", "VIIRS_NOAA20", f"{d}T07:00:00Z", d, lat + rng.uniform(-0.003, 0.003), lon, "n" if rng.random() < 0.9 else "l", None, rng.gamma(1.5, 4), 0.4, 0.4, "D", pd.NA, "2.0", "SP", "y"))
    df = pd.DataFrame(rows, columns=NORMALIZED_COLUMNS)
    df["type"] = df["type"].astype("Int64")
    # A static industrial source and an out-of-box point that cleaning must drop.
    extra = df.iloc[:2].copy()
    extra["type"] = pd.array([2, 0], dtype="Int64")
    extra.iloc[1, extra.columns.get_loc("lat")] = 30.0
    return pd.concat([df, extra], ignore_index=True)


def make_cfg(tmp: Path) -> dict:
    paths = {k: str(tmp / v) for k, v in {"firms_cache": "raw/firms", "archive": "raw/archive", "power": "raw/power", "eonet": "raw/eonet", "clean": "clean", "stage": "stage", "products": "products", "meta": "products/meta"}.items()}
    return {
        "regions": [
            {"id": "box", "name": {"en": "Box", "bn": "বাক্স", "es": "Caja"}, "country": "BD", "bbox": BBOX, "fire_year_start_month": 11, "landcover": "mangrove"},
            {"id": "empty", "name": {"en": "Empty", "bn": "খালি", "es": "Vacío"}, "country": "AR", "bbox": [-59.4, -33.3, -59.0, -33.0], "fire_year_start_month": 7, "landcover": "wetland"},
        ],
        "paths": paths,
        "clean": {"modis_min_confidence": 30, "viirs_confidence": ["n", "h"], "types_kept": [0]},
        "grid": {"cell_km": 5.5, "tile_deg": 2},
        "ml_inputs": {"keep_share": 0.97, "max_cells_per_region": 700},
    }


def write_run(cfg: dict) -> None:
    meta = Path(cfg["paths"]["meta"])
    meta.mkdir(parents=True, exist_ok=True)
    (meta / "firms_run.json").write_text(json.dumps({
        "reference": {"family": "VIIRS_NOAA20", "viirs_start": VIIRS_START, "skipped": ["VIIRS_SNPP: record ends 2026-10-31: partial"]},
        "viirs_start": VIIRS_START, "start": "2000-11-01", "end": "2026-11-14", "gaps": {},
        "sources_used": {"MODIS_SP": {"first": "2000-11-01", "last": "2026-07-31"}, "MODIS_NRT": {"first": "2026-08-01", "last": "2026-11-14"}, "VIIRS_NOAA20_SP": {"first": "2018-04-01", "last": "2026-04-30"}, "VIIRS_NOAA20_NRT": {"first": "2026-05-01", "last": "2026-11-14"}},
        "fetched_at": "2026-11-14T00:00:00Z",
    }))


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("real")
    cfg = make_cfg(tmp)
    clean_dir = Path(cfg["paths"]["clean"])
    clean_dir.mkdir(parents=True)
    synth_rows().to_parquet(clean_dir / "firms_box.parquet", index=False)
    (clean_dir / "power_box.json").write_text(json.dumps([{"ym": "2020-01", "t2m_c": 20.1, "precip_mm": 10.0, "rh_pct": 70}]))
    write_run(cfg)
    index = build(cfg, now=date(2026, 11, 14))
    return cfg, index


def test_clean_filters_confidence_type_and_bbox():
    df = synth_rows()
    out, st = clean(df, BBOX, {"modis_min_confidence": 30, "viirs_confidence": ["n", "h"], "types_kept": [0]})
    assert st["outside_bbox"] == 1 and st["type_dropped"] == 1
    assert st["confidence_dropped"] > 0 and st["kept"] == len(out)
    assert (pd.to_numeric(out.loc[out["sensor"] == "MODIS", "confidence"]) >= 30).all()
    assert set(out.loc[out["sensor"] == "VIIRS", "confidence"]) <= {"n", "h"}


def test_grid_lattice_matches_demo_grid():
    g = grid_cells(pd.DataFrame({"lat": [22.01], "lon": [89.01], "acq_date": ["2020-01-01"]}), 5.5)
    cd = 5.5 / 111
    assert g["clat"][0] == round((np.floor(22.01 / cd) + 0.5) * cd, 4)
    assert g["cell_id"][0] == f"c_{g['clat'][0]}_{g['clon'][0]}" and g["ym"][0] == "2020-01"


def test_index_is_real_and_additive(built):
    cfg, ix = built
    for k in ("version", "generated_at", "first_month", "last_month", "presets", "viirs_start", "sensors", "grid", "source"):
        assert k in ix  # contract v1 fields all present
    assert ix["data_mode"] == "real" and ix["viirs_start"] == VIIRS_START and ix["viirs_reference"] == "VIIRS_NOAA20"
    assert ix["first_month"] == "2000-11" and ix["last_month"] == "2026-11" and ix["partial_month"] == "2026-11"
    assert ix["regions_status"] == {"box": "real", "empty": "missing"}
    assert [p["id"] for p in ix["presets"]] == ["box", "empty"]  # missing regions stay listed: the app falls back to demo
    assert ix["sensors"] == ["MODIS_Terra", "MODIS_Aqua", "VIIRS_NOAA20"]


def test_stage_rows_grid_and_validation(built):
    cfg, ix = built
    st = json.loads((Path(cfg["paths"]["stage"]) / "base" / "box.json").read_text())
    rows = st["rows"]
    assert rows[0]["ym"] == "2000-11" and rows[-1]["ym"] == "2026-11" and st["partial_last"]
    assert all(r["viirs_raw"] is None for r in rows if r["ym"] < VIIRS_START)
    assert all(r["low"] <= r["harmonized"] <= r["high"] for r in rows)
    v = st["validation"]
    assert v["overlap"].startswith(VIIRS_START) and v["train"] == "2018-2023" and v["test"] == "2025-2026"
    assert v["corr_harmonized"] >= v["corr_raw"] - 0.05
    assert 0.6 <= v["coverage_90"] <= 1.0
    assert st["context"][0]["ym"] == "2020-01"
    # Grid cells sum to the region's raw counts.
    tiles = list((Path(cfg["paths"]["products"]) / "grid").glob("*.json"))
    assert tiles
    tot = {}
    for t in tiles:
        for c in json.loads(t.read_text())["cells"]:
            for ym, m in c["m"].items():
                tot[ym] = tot.get(ym, 0) + m[3]
    by = {r["ym"]: r["modis_raw"] for r in rows}
    assert all(tot.get(ym, 0) == by[ym] for ym in by)


def test_ml_inputs_and_hotspots(built):
    cfg, _ = built
    prod = Path(cfg["paths"]["products"])
    ml = pd.read_parquet(prod / "ml_inputs" / "cell_month.parquet")
    assert set(REQUIRED_OBS_COLUMNS) <= set(ml.columns)
    assert ml.loc[ml["ym"] < "2002-07", "modis_aqua"].isna().all()
    assert ml.loc[ml["ym"] < VIIRS_START, "viirs"].isna().all() and ml.loc[ml["ym"] >= VIIRS_START, "viirs"].notna().all()
    csv = pd.read_csv(prod / "hotspots" / "box" / "2020.csv")
    assert list(csv.columns) == ["latitude", "longitude", "acq_datetime_utc", "sensor", "satellite", "confidence", "frp_mw", "type"]
    assert not (prod / "hotspots" / "empty").exists()


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_contract_export_and_seam(built):
    cfg, ix = built
    prod = Path(cfg["paths"]["products"])
    subprocess.run(["node", str(ROOT / "scripts" / "export-contract.ts"), str(Path(cfg["paths"]["stage"]) / "base"), str(prod)], check=True, cwd=ROOT, capture_output=True)
    reg = json.loads((prod / "region" / "box.json").read_text(encoding="utf-8"))
    for k in ("id", "fire_year_start_month", "monthly", "climatology", "current", "validation", "context"):
        assert k in reg
    assert len(reg["climatology"]) == 12 and reg["current"]["ym"] == "2026-10"  # partial month is not "current"
    s = seam.run(prod)["box"]
    assert s["raw"]["significant"] and s["raw"]["near_viirs_start"], s  # the synthetic MODIS->VIIRS step is found
    assert not (s["harmonized"]["significant"] and s["harmonized"]["near_viirs_start"]), s  # and gone after harmonization
    assert "seam_test" in json.loads((prod / "region" / "box.json").read_text(encoding="utf-8"))


def test_pettitt_finds_a_step_and_not_noise():
    rng = np.random.default_rng(0)
    i, p, _ = seam.pettitt(np.r_[rng.normal(0, 1, 100), rng.normal(1.5, 1, 100)])
    assert 95 <= i <= 105 and p < 1e-6
    _, p2, _ = seam.pettitt(rng.normal(0, 1, 200))
    assert p2 > 0.05


def test_no_firms_data_writes_nothing(tmp_path):
    cfg = make_cfg(tmp_path)
    with pytest.raises(PipelineError, match="make fetch"):
        build(cfg)
    write_run(cfg)
    with pytest.raises(PipelineError, match="no region"):
        build(cfg, now=date(2026, 11, 14))
    assert not (Path(cfg["paths"]["products"]) / "index.json").exists()
