"""`make ml`: features -> harmonize_ml -> conformal -> explain -> firecast -> narrative -> export.

    python -m src.compute.ml.run --data data-products/demo --out data-products/ml [--quick]

Reads the existing contract v1 files plus ml_inputs/ and writes ONLY new files
under --out (contract v1.1, additive). Prints a summary table at the end.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from . import conformal, firecast, harmonize_ml
from .config import ALPHA, COUNTRY_LABELS, FEATURE_LABELS, FEATURE_UNITS, LANDCOVER_LABELS, SEED, TILE_DEG, group_label
from .explain import dependence, global_drivers, grouped, local_region_month, shap_harmonizer
from .features import build_harmonization_features, is_partial_last, make_splits
from .io import load_contract, load_observations
from .narrative import dependence_takeaways, forecast_sentence
from .schema import validate_grid, validate_index, validate_model_card, validate_region


def clean(x: Any) -> Any:
    """JSON-safe: NaN/inf -> null, numpy -> python."""
    if isinstance(x, dict):
        return {str(k): clean(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [clean(v) for v in x]
    if isinstance(x, (np.integer,)):
        return int(x)
    if isinstance(x, (np.floating, float)):
        f = float(x)
        return None if math.isnan(f) or math.isinf(f) else f
    if isinstance(x, np.bool_):
        return bool(x)
    return x


def write_json(path: Path, obj: Any) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps(clean(obj), ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    path.write_text(body, encoding="utf-8")
    return len(body.encode())


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="FireRings Intelligence layer")
    ap.add_argument("--data", default="data-products", help="directory with contract v1 files + ml_inputs/")
    ap.add_argument("--out", default="data-products/ml")
    ap.add_argument("--quick", action="store_true", help="smaller models and fewer folds (tests / smoke runs)")
    ap.add_argument("--now", default=None, help="UTC 'YYYY-MM-DD' used for the partial-month rule (default: today)")
    a = ap.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except Exception:
            pass
    t0 = time.time()
    log = lambda s: print(s, flush=True)  # noqa: E731
    data, out = Path(a.data), Path(a.out)

    log(f"[1/7] reading {data}")
    index, regions = load_contract(data)
    obs, source, notes = load_observations(data, index, regions, SEED)
    now = pd.Timestamp(a.now, tz="UTC") if a.now else None
    partial = is_partial_last(index, now)
    partial_month = index["last_month"] if partial else None
    splits = make_splits(index, partial)
    log(f"  {len(obs):,} cell-months · {obs['cell_id'].nunique():,} cells · source {source} · split {splits.label()}")

    log("[2/7] features")
    hf = build_harmonization_features(obs, index, splits, partial_month)
    out.mkdir(parents=True, exist_ok=True)
    hf.drop(columns=[c for c in hf.columns if c.startswith("_")]).to_parquet(out / "features.parquet", index=False)

    log("[3/7] ML harmonization (baseline B0 vs XGBoost M1 vs RF M2)")
    harm = harmonize_ml.run(hf, splits, quick=a.quick, log=log)

    log("[4/7] conformal uncertainty")
    conf = conformal.run(hf, harm, splits, log=log)

    # Harmonized units: one constant per region maps VIIRS-equivalent cell-days to the
    # published harmonized series (fitted on the training years only).
    pred = harm.pred.join(conf.intervals)
    kappa: dict[str, float] = {}
    region_ml: dict[str, pd.DataFrame] = {}
    for rid, reg in regions.items():
        pub = pd.Series({p["ym"]: p["harmonized"] for p in reg["monthly"]})
        g = pred[pred["region"] == rid].assign(h2=lambda d: d["hw"] ** 2).groupby("ym").agg(ml=("ml", "sum"), h2=("h2", "sum"), c=("c_region", "first"), b0=("b0", "sum"), xgb=("xgb", "sum"))
        half = g["c"] * np.sqrt(g["h2"])
        g = g.assign(lo=np.maximum(0, g["ml"] - half), hi=g["ml"] + half)[["ml", "lo", "hi", "b0", "xgb"]]
        tr = [m for m in g.index if splits.train[0] <= int(m[:4]) <= splits.train[1] and m != partial_month]
        k = float(pub.reindex(tr).sum() / max(g.loc[tr, "ml"].sum(), 1e-9)) if tr else 1.0
        kappa[rid] = k
        region_ml[rid] = (g * k).assign(partial=lambda d: d.index == partial_month)

    log("[5/7] explainability (TreeSHAP)")
    xgbm = harm.models["xgboost"]
    sample = hf[hf["y_h"].notna() & ~hf["partial"] & (hf["head"] == "ta")]
    sample = sample.sample(min(len(sample), 60_000), random_state=SEED)
    sv, _, names = shap_harmonizer(xgbm["ta"], sample)
    drivers_h = global_drivers(sv, names)
    dep = dependence(xgbm["ta"], sample)
    takeaways = dependence_takeaways(dep)
    explain: dict[str, dict[str, Any]] = {rid: {} for rid in regions}
    for head in ("ta", "t"):
        part_all = hf[hf["head"] == head]
        if part_all.empty:
            continue
        vals, bias, nm = shap_harmonizer(xgbm[head], part_all)
        g, keys = grouped(vals, nm)
        yhat = xgbm[head].predict(part_all)
        pos = part_all.groupby(["region", "ym"], observed=True).indices
        for (rid, ym), ix in pos.items():
            if rid in explain:
                explain[rid][ym] = local_region_month(g[ix], keys, bias[ix], part_all.iloc[ix], yhat[ix], kappa.get(rid, 1.0))

    log("[6/7] FireCast (hindcast, calibration, skill, conformal sets)")
    region_h = {rid: region_ml[rid]["ml"] for rid in regions}
    rf, region_us = firecast.run_region(index, region_h, hf, splits.last_complete, log=log)
    cell_h = pred[["cell_id", "region", "ym", "ml"]].assign(h=lambda d: d["ml"] * d["region"].map(kappa))[["cell_id", "ym", "h"]]
    cells, cell_rep = firecast.run_cells(index, cell_h, hf, region_us, rf.targets[0], splits.last_complete, quick=a.quick, log=log)
    fc_drivers = global_drivers(rf.shap_global, rf.shap_names)

    raw_tr, harm_tr = {}, {}
    for rid, reg in regions.items():
        raw_tr[rid], harm_tr[rid] = firecast.trend_evidence(reg, region_ml[rid]["ml"], index["viirs_start"], splits.last_complete)

    log("[7/7] narrative + export")
    for rid, fl in rf.forecasts.items():
        for f in fl:
            f["narrative"] = {lang: forecast_sentence(lang, f) for lang in ("en", "bn", "es")}

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d")
    for row in conf.report["by_group"]:
        row["label"] = group_label(row["kind"], row["group"])
    h_metrics = {k: v for k, v in harm.metrics.items()}
    index_out = {
        "version": "1.1-ml",
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": source,
        "inputs": {
            "data_version": index.get("version"),
            "first_month": index["first_month"],
            "last_month": index["last_month"],
            "viirs_start": index["viirs_start"],
            "partial_month": partial_month,
            "origin": splits.last_complete,
        },
        "notes": notes + harm.notes,
        "splits": splits.label(),
        "models": {
            "harmonization": {
                "chosen": harm.chosen,
                "version": f"h-{stamp}",
                "target": "reference-satellite VIIRS cell-days per 5.5 km cell-month (offset: log MODIS cell-days)",
                "selection": "lowest MAE on the calibration year (test years never used for choices); ties within 1% go to the baseline",
                "metrics": h_metrics,
                "corr": harm.corr,
                "corr_level": "mean over regions of Pearson r between region-month series and VIIRS, test years",
                "corr_cell": harm.corr_cell,
                "spatial_cv": harm.spatial_cv,
                "kappa": kappa,
                "conformal": {
                    "target": 1 - ALPHA,
                    "coverage_test": conf.report["coverage_test"],
                    "region_coverage_test": conf.report["region_coverage_test"],
                    "mean_width": conf.report["mean_width"],
                    "by_group": conf.report["by_group"],
                    "terra_only": {k: conf.report["t"][k] for k in ("coverage_test", "region_coverage_test", "mean_width")},
                    "region_c": conf.report["ta"]["region_c"],
                    "region_n_cal": conf.report["ta"]["region_n_cal"],
                    "method": "split conformal, normalized scores |y-yhat|/sigma(x), Mondrian by land cover, country and predicted activity; region intervals from a second region-level conformal step (approximate: small calibration sample)",
                },
            },
            "firecast": {
                "version": f"f-{stamp}",
                "brier": rf.summary["brier"],
                "brier_clim": rf.summary["brier_clim"],
                "rpss": rf.summary["rpss"],
                "reliability": rf.summary["reliability"],
                "hindcast": rf.summary["hindcast"],
                "calibration_years": rf.summary["calibration_years"],
                "evaluation_years": rf.summary["evaluation_years"],
                "targets": rf.targets,
                "leads": [{k: v for k, v in rf.per_lead[L].items()} for L in rf.leads],
                "cells": cell_rep,
            },
        },
        "global_drivers": {"harmonization": drivers_h, "firecast": fc_drivers},
        "dependence": dep,
        "takeaways": takeaways,
        "raw_trained_trend": raw_tr,
        "harmonized_trained_trend": harm_tr,
        "labels": {"features": FEATURE_LABELS, "units": FEATURE_UNITS, "landcover": LANDCOVER_LABELS, "country": COUNTRY_LABELS},
        "regions": sorted(regions),
    }

    tiles: dict[str, list[dict[str, Any]]] = {}
    for c in cells.itertuples(index=False):
        tiles.setdefault(c.tile, []).append({"id": c.id, "lat": c.lat, "lon": c.lon, "p_above": c.p_above, "set_size": c.set_size, "skilful": bool(c.skilful)})
    index_out["grid"] = {"tile_deg": TILE_DEG, "target": rf.targets[0], "tiles": sorted(tiles)}

    # Validate everything before anything replaces the previous outputs.
    validate_index(clean(index_out))
    region_files = {}
    for rid in regions:
        g = region_ml[rid]
        r = {
            "id": rid,
            "source": source,
            "monthly_ml": [
                {"ym": ym, "ml_harmonized": round(row.ml, 2), "lo90": round(min(row.lo, row.ml), 2), "hi90": round(max(row.hi, row.ml), 2), "baseline": round(row.b0, 2), "xgboost": round(row.xgb, 2), **({"partial": True} if row.partial else {})}
                for ym, row in g.iterrows()
            ],
            "explain": explain.get(rid, {}),
            "firecast": rf.forecasts.get(rid, []),
        }
        validate_region(clean(r))
        region_files[rid] = r
    for tid, cl in tiles.items():
        validate_grid({"cells": cl}, tid)
    card = model_card(index_out, source)
    validate_model_card(card)

    for d in ("region", "grid"):
        shutil.rmtree(out / d, ignore_errors=True)
    size = write_json(out / "index.json", index_out)
    for rid, r in region_files.items():
        size += write_json(out / "region" / f"{rid}.json", r)
    for tid, cl in tiles.items():
        size += write_json(out / "grid" / f"{tid}.json", {"target": rf.targets[0], "source": source, "cells": cl})
    size += write_json(out / "model_card.json", card)
    log(f"  wrote {out} ({size / 1e6:.2f} MB JSON, {len(tiles)} grid tiles) in {time.time() - t0:.0f} s")
    print_summary(index_out, rf)
    return 0


def model_card(ix: dict[str, Any], source: str) -> dict[str, Any]:
    h = ix["models"]["harmonization"]
    f = ix["models"]["firecast"]
    return {
        "name": "FireRings Intelligence (ML harmonization + FireCast)",
        "version": f"{h['version']} / {f['version']}",
        "license": "Apache-2.0",
        "source": source,
        "intended_use": [
            "Continuous, sensor-agnostic monthly fire-activity records from MODIS and VIIRS hotspots, with honest 90 % intervals.",
            "Explaining where and why MODIS and VIIRS counts differ (fire size, viewing angle, land cover).",
            "Seasonal planning: next 1-3 months' fire activity as below / near / above normal, shown only where hindcasts beat climatology.",
        ],
        "not_for": [
            "Life-safety or evacuation decisions without local verification.",
            "Detecting or locating individual fires (use NASA FIRMS near-real-time alerts).",
            "Burned area, emissions or damage estimates.",
            "Areas or periods outside the training regions without re-validation.",
        ],
        "data": {
            "inputs": "NASA FIRMS MODIS C6.1 (Terra, Aqua) and VIIRS 375 m hotspots on a 5.5 km grid; MCD12Q1 land cover; MOD13A3/VNP13A3 NDVI; NASA POWER monthly weather.",
            "this_build": "SYNTHETIC demo inputs; numbers show how the method behaves, not what happened." if source == "demo" else "Pipeline outputs (live).",
            "splits": ix["splits"],
        },
        "metrics": {
            "harmonization_test": {k: h["metrics"][k]["test"] for k in ("baseline", "xgboost")},
            "corr": h["corr"],
            "conformal_coverage_test": h["conformal"]["coverage_test"],
            "firecast_rpss": f["rpss"],
            "firecast_brier": f["brier"],
        },
        "limitations": [
            "Satellites miss fires under cloud and smoke, and short fires between overpasses; both sensors share this blind spot.",
            "Before 2002-07 only Terra flew; a Terra-only model covers those months with wider intervals.",
            "Region intervals add cell bounds: approximate, without the formal per-cell guarantee.",
            "Forecast skill is modest and varies by region and month; months without skill show no probabilities.",
            "VIIRS on NOAA-21 and future sensors need their own calibration as they join.",
            "Future work: U-Net / ConvLSTM spatial models (not used: CPU-only, explainability first).",
        ],
        "method_doc": "docs/ml_method.md",
    }


def print_summary(ix: dict[str, Any], rf: firecast.RegionForecast) -> None:
    h = ix["models"]["harmonization"]
    print("\n================ FireRings Intelligence: summary ================")
    print(f"source: {ix['source']} · split {ix['splits']} · chosen harmonizer: {h['chosen']}")
    print(f"{'model':<10}{'MAE':>9}{'RMSE log1p':>12}{'bias':>9}{'Spearman':>10}   (test years, cell-months)")
    for name, m in h["metrics"].items():
        t = m["test"]
        print(f"{name:<10}{t['mae']:>9.3f}{t['rmse_log1p']:>12.3f}{t['bias']:>9.3f}{t['spearman']:>10.3f}")
    print("corr with VIIRS, region-month series (test): " + " · ".join(f"{k} {v:.3f}" for k, v in h["corr"].items()))
    print("corr with VIIRS, cell-month log1p (test):   " + " · ".join(f"{k} {v:.3f}" for k, v in h["corr_cell"].items()))
    c = h["conformal"]
    print(f"conformal 90%: test coverage {c['coverage_test']:.3f} (region-month {c['region_coverage_test']:.3f}), mean width {c['mean_width']:.2f}")
    for g in c["by_group"]:
        print(f"   {g['kind']:<10}{g['group']:<14}{g['coverage']:.3f}  n={g['n']:<7}{'⚠ below 85%' if g['flag'] else ''}")
    print(f"FireCast RPSS overall {ix['models']['firecast']['rpss']:+.3f} · Brier {ix['models']['firecast']['brier']:.3f} (clim {ix['models']['firecast']['brier_clim']:.3f})")
    for L in rf.leads:
        for rid, r in rf.per_lead[L]["regions"].items():
            print(f"   lead {L} {rid:<24} RPSS {r['rpss']:+.3f}  90% CI [{r['ci90'][0]:+.3f}, {r['ci90'][1]:+.3f}]  {'skilful' if r['skilful'] else '-'}")
    for rid in ix["raw_trained_trend"]:
        a, b = ix["raw_trained_trend"][rid], ix["harmonized_trained_trend"][rid]
        print(f"   trend {rid:<24} raw-trained x{a['jump_ratio']} at VIIRS start (p={a['p']}) · harmonized-trained x{b['jump_ratio']} (p={b['p']})")
    print("=================================================================\n")


if __name__ == "__main__":
    sys.exit(main())
