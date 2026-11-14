"""Real-data pipeline: normalized FIRMS rows -> clean -> 5.5 km grid -> harmonization -> contract files.

    python -m src.compute.pipeline [--config config/real_data.yaml] [--now YYYY-MM-DD]

Writes (data contract v1, plus additive fields):
    data-products/index.json                 (data_mode "real", sources, availability, notes)
    data-products/grid/{tile}.json           cells: m[ym] = [harmonized, low, high, modis_raw, viirs_raw]
    data-products/hotspots/{region}/{year}.csv
    data-products/ml_inputs/cell_month.parquet   (schema: docs/ml_features.md)
    data/stage/base/{region}.json            monthly base rows + validation + context
`scripts/export-contract.ts` then turns the stage files into region/{id}.json with the
tested statistics of src/compute/derive.ts (percentiles, climatology, onset), so no
statistic is implemented twice.

Harmonization reuses the stratified ratio method of src/compute/ml/baseline.py
(strata: region x calendar month; a Terra-only head before Aqua, 2002-07), fitted on
the training years of the ML layer's split rule. The 90 % band comes from
leave-one-year-out log residuals on the training + calibration years; validation
numbers are computed on the held-out test years only.
"""

from __future__ import annotations

import json
import logging
import math
import shutil
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from ..ml.baseline import StratifiedRatio
from ..ml.features import make_splits
from ..ml.io import months_between, tile_id
from src.ingest.common import atomic_write, enabled_regions, path_of, utc_now_iso

log = logging.getLogger("firerings.pipeline")

AQUA_START = "2002-07"  # Aqua MODIS record starts 4 July 2002 (Terra-only before)
ALPHA = 0.10
MIN_GROUP = 15  # residuals per activity group for its own band quantiles (else the pooled band)
FAMILY_SENSOR_NAME = {"Terra": "MODIS_Terra", "Aqua": "MODIS_Aqua", "S-NPP": "VIIRS_SNPP", "NOAA-20": "VIIRS_NOAA20", "NOAA-21": "VIIRS_NOAA21"}


class PipelineError(RuntimeError):
    pass


# ---------------------------------------------------------------- clean


def clean(df: pd.DataFrame, bbox: list[float], ccfg: dict[str, Any]) -> tuple[pd.DataFrame, dict[str, int]]:
    """Keep presumed vegetation fires inside the bbox that pass the confidence filter."""
    n0 = len(df)
    w, s, e, n = bbox
    inside = (df["lon"] >= w) & (df["lon"] <= e) & (df["lat"] >= s) & (df["lat"] <= n)
    types = set(ccfg.get("types_kept", [0]))
    t = pd.to_numeric(df["type"], errors="coerce")
    type_ok = t.isna() | t.isin(types)  # NRT files carry no type: kept, recorded in the notes
    is_modis = df["sensor"] == "MODIS"
    mconf = pd.to_numeric(df["confidence"].where(is_modis), errors="coerce")
    vconf = df["confidence"].astype(str).str.strip().str.lower().str[:1]
    conf_ok = np.where(is_modis, mconf >= float(ccfg.get("modis_min_confidence", 30)), vconf.isin([str(c)[:1].lower() for c in ccfg.get("viirs_confidence", ["n", "h"])]))
    keep = inside & type_ok & conf_ok
    stats = {"rows": n0, "outside_bbox": int((~inside).sum()), "type_dropped": int((inside & ~type_ok).sum()), "confidence_dropped": int((inside & type_ok & ~conf_ok).sum()), "kept": int(keep.sum()), "type_missing_kept": int((keep & t.isna()).sum())}
    return df.loc[keep].reset_index(drop=True), stats


# ---------------------------------------------------------------- grid


def cell_deg(cell_km: float) -> float:
    return cell_km / 111


def grid_cells(df: pd.DataFrame, cell_km: float) -> pd.DataFrame:
    """Adds i, j (cell index), cell_id, clat, clon (cell centre) and ym. Same lattice as the demo grid."""
    cd = cell_deg(cell_km)
    out = df.copy()
    out["i"] = np.floor(out["lat"].to_numpy(float) / cd).astype(np.int64)
    out["j"] = np.floor(out["lon"].to_numpy(float) / cd).astype(np.int64)
    out["clat"] = np.round((out["i"] + 0.5) * cd, 4)
    out["clon"] = np.round((out["j"] + 0.5) * cd, 4)
    out["cell_id"] = "c_" + out["clat"].astype(str) + "_" + out["clon"].astype(str)
    out["ym"] = out["acq_date"].str.slice(0, 7)
    return out


def cell_days(g: pd.DataFrame, mask: pd.Series, name: str) -> pd.Series:
    """Fire cell-days: one (cell, day) counts once, however many detections."""
    sub = g.loc[mask, ["cell_id", "ym", "acq_date"]].drop_duplicates()
    return sub.groupby(["cell_id", "ym"]).size().rename(name)


def cell_month_table(g: pd.DataFrame, ref_satellite: str) -> pd.DataFrame:
    """Sparse cell-month aggregates (only cell-months with at least one detection)."""
    modis = g["sensor"] == "MODIS"
    parts = [
        cell_days(g, modis, "modis"),
        cell_days(g, g["satellite"] == "Terra", "modis_terra"),
        cell_days(g, g["satellite"] == "Aqua", "modis_aqua"),
        cell_days(g, g["satellite"] == ref_satellite, "viirs"),
    ]
    m = g.loc[modis].assign(pix=lambda d: d["scan"] * d["track"], day=lambda d: (d["daynight"] == "D").astype(float))
    feats = m.groupby(["cell_id", "ym"]).agg(frp_mean=("frp", "mean"), frp_max=("frp", "max"), scan_mean=("scan", "mean"), pix_km2=("pix", "mean"), day_share=("day", "mean"))
    t = pd.concat(parts + [feats], axis=1)
    for c in ("modis", "modis_terra", "modis_aqua", "viirs"):
        t[c] = t[c].fillna(0)
    pos = g.drop_duplicates("cell_id").set_index("cell_id")[["clat", "clon"]]
    return t.reset_index().join(pos, on="cell_id")


# ---------------------------------------------------------------- harmonization


def _q(e: np.ndarray, level: float) -> float:
    """Finite-sample conformal quantile of residuals."""
    n = len(e)
    if n == 0:
        return 0.0
    k = min(n, max(1, math.ceil((n + 1) * level)))
    return float(np.sort(e)[k - 1])


def harmonize_region(reg: pd.DataFrame, region_code: int, train: tuple[int, int], cal: int, test: tuple[int, int], partial_month: str | None) -> tuple[pd.DataFrame, dict[str, Any]]:
    """Region-month series -> harmonized, low, high (+ validation on the test years).

    reg: index ym; columns modis (MODIS cell-days), modis_terra, viirs (reference
    cell-days, NaN outside the VIIRS record), modis_on (bool: MODIS observing).
    """
    d = reg.copy()
    d["year"] = d.index.str.slice(0, 4).astype(int)
    d["month"] = d.index.str.slice(5, 7).astype(int)
    d["lc_code"] = float(region_code)
    d["modis_n"] = d["modis"]
    d["y_h"] = d["viirs"]
    d["head"] = np.where(d.index < AQUA_START, "t", "ta")
    usable = d["y_h"].notna() & d["modis_on"] & (d.index != partial_month) & (d.index >= AQUA_START)
    fit_rows = usable & d["year"].between(*train)
    if fit_rows.sum() < 12:
        raise PipelineError(f"only {int(fit_rows.sum())} overlap months to calibrate on (need >= 12)")
    models = {h: StratifiedRatio(head=h).fit(d[fit_rows]) for h in ("ta", "t")}
    pred = np.where(d["head"] == "t", models["t"].predict(d), models["ta"].predict(d))
    d["harmonized"] = np.where(d["modis_on"], pred, d["viirs"])  # after MODIS: VIIRS itself (already in harmonized units)

    # Leave-one-year-out log residuals on train + calibration years -> 90 % band per head,
    # Mondrian by activity tercile: quiet months (where +1 offsets make log residuals
    # large) must not widen the band of busy months, and vice versa.
    cal_years = list(range(train[0], cal + 1))
    res: dict[str, list[tuple[float, float]]] = {"ta": [], "t": []}  # (prediction, residual)
    for y in cal_years:
        tr = usable & d["year"].between(train[0], cal) & (d["year"] != y)
        ho = usable & (d["year"] == y)
        if tr.sum() < 12 or ho.sum() == 0:
            continue
        for h in ("ta", "t"):
            p = StratifiedRatio(head=h).fit(d[tr]).predict(d[ho])
            res[h] += list(zip(p, np.log((d.loc[ho, "y_h"].to_numpy() + 1) / (p + 1))))
    bands: dict[str, dict[str, Any]] = {}
    for h, pr in res.items():
        p = np.array([a for a, _ in pr])
        e = np.array([b for _, b in pr])
        edges = list(np.quantile(p, [1 / 3, 2 / 3])) if len(p) >= 3 * MIN_GROUP else []
        grp = np.searchsorted(edges, p, side="right") if edges else np.zeros(len(p), int)
        pooled = (_q(e, ALPHA / 2), _q(e, 1 - ALPHA / 2)) if len(e) else (-0.5, 0.5)
        qs = [(_q(e[grp == g], ALPHA / 2), _q(e[grp == g], 1 - ALPHA / 2)) if (grp == g).sum() >= MIN_GROUP else pooled for g in range(len(edges) + 1)]
        bands[h] = {"edges": [round(float(x), 3) for x in edges], "q": [[round(a, 4), round(b, 4)] for a, b in qs], "n": len(e)}
    h_all = d["harmonized"].to_numpy(float)
    lo_q, hi_q = np.zeros(len(d)), np.zeros(len(d))
    for i, (hv, head) in enumerate(zip(h_all, d["head"])):
        b = bands[head]
        g = int(np.searchsorted(b["edges"], hv, side="right")) if b["edges"] else 0
        lo_q[i], hi_q[i] = b["q"][g]
        if head == "t":  # Terra-only months: never a narrower band than Terra + Aqua at the same level
            bt = bands["ta"]
            gt = int(np.searchsorted(bt["edges"], hv, side="right")) if bt["edges"] else 0
            lo_q[i], hi_q[i] = min(lo_q[i], bt["q"][gt][0]), max(hi_q[i], bt["q"][gt][1])
    d["low"] = np.minimum(np.maximum(0, (h_all + 1) * np.exp(lo_q) - 1), h_all)
    d["high"] = np.maximum((h_all + 1) * np.exp(hi_q) - 1, h_all)

    # Validation: held-out test years only.
    te = usable & d["year"].between(*test)
    val: dict[str, Any] | None = None
    if te.sum() >= 6:
        v, hh, mm = d.loc[te, "y_h"].to_numpy(float), d.loc[te, "harmonized"].to_numpy(float), d.loc[te, "modis"].to_numpy(float)

        def r(a: np.ndarray, b: np.ndarray) -> float:
            return float(np.corrcoef(a, b)[0, 1]) if np.std(a) > 0 and np.std(b) > 0 else float("nan")

        val = {
            "corr_raw": round(r(mm, v), 2),
            "corr_harmonized": round(r(hh, v), 2),
            "mae": round(float(np.mean(np.abs(hh - v))), 1),
            "bias": round(float(np.mean(hh - v)), 1),
            "coverage_90": round(float(np.mean((d.loc[te, "low"] <= v) & (v <= d.loc[te, "high"]))), 2),
            "n_test_months": int(te.sum()),
        }
    info = {
        "bands": bands,
        "ratio_global": round(models["ta"].global_ratio, 4),
        "ratio_by_month": {int(k[1]): round(v, 4) for k, v in models["ta"].by_stratum.items()},
        "ratio_by_month_terra": {int(k[1]): round(v, 4) for k, v in models["t"].by_stratum.items()},
        "validation": val,
    }
    return d, info


# ---------------------------------------------------------------- build


def _month_of(d: str) -> str:
    return d[:7]


def build(cfg: dict[str, Any], now: date | None = None) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc).date()
    meta_dir = path_of(cfg, "meta")
    products = path_of(cfg, "products")
    clean_dir = path_of(cfg, "clean")
    stage = path_of(cfg, "stage")
    run_f = meta_dir / "firms_run.json"
    if not run_f.exists():
        raise PipelineError("no FIRMS run found (data-products/meta/firms_run.json): run `make fetch` with FIRMS_MAP_KEY in .env first. Nothing was changed.")
    run = json.loads(run_f.read_text(encoding="utf-8"))
    avail_f = meta_dir / "availability.json"
    availability = json.loads(avail_f.read_text(encoding="utf-8")) if avail_f.exists() else {}
    regions = enabled_regions(cfg)
    ref_family = run["reference"]["family"]
    ref_sat = {"VIIRS_SNPP": "S-NPP", "VIIRS_NOAA20": "NOAA-20", "VIIRS_NOAA21": "NOAA-21"}[ref_family]
    viirs_start = run["viirs_start"]
    cell_km = float(cfg["grid"]["cell_km"])
    tile_deg = float(cfg["grid"]["tile_deg"])
    end = date.fromisoformat(run["end"])
    first_month = max(_month_of(run["start"]), "2000-11")
    last_month = _month_of(end.isoformat())
    partial_month = last_month if last_month == f"{now.year:04d}-{now.month:02d}" else None
    months = months_between(first_month, last_month)
    su = run.get("sources_used", {})
    modis_last = max([v["last"] for k, v in su.items() if k.startswith("MODIS_")], default=end.isoformat())
    ref_last = max([v["last"] for k, v in su.items() if k.startswith(ref_family + "_")], default=end.isoformat())
    splits = make_splits({"viirs_start": viirs_start, "last_month": last_month}, partial_month is not None)
    log.info("record %s..%s (partial %s) · reference %s from %s · split %s", first_month, last_month, partial_month, ref_sat, viirs_start, splits.label())

    notes = [
        f"Reference VIIRS satellite: {ref_sat} (viirs_start {viirs_start})" + (f"; skipped: {'; '.join(run['reference'].get('skipped', []))}" if run["reference"].get("skipped") else ""),
        "Unit: fire cell-days on the 5.5 km grid (one cell-day counts once, however many detections).",
        "Land cover: one documented class per region (config/real_data.yaml); MCD12Q1 is not ingested.",
        "NDVI: not ingested (missing in the ML inputs; XGBoost handles NaN).",
    ]
    if run.get("gaps"):
        notes.append("Dates no FIRMS source covered: " + "; ".join(f"{k} {v['days']} d ({v['first']}..{v['last']})" for k, v in run["gaps"].items()))

    region_status: dict[str, str] = {}
    filter_stats: dict[str, Any] = {}
    tiles: dict[str, dict[str, dict[str, Any]]] = {}
    ml_parts: list[pd.DataFrame] = []
    stage_out: dict[str, dict[str, Any]] = {}
    hotspot_rows: dict[str, pd.DataFrame] = {}
    sat_seen: set[str] = set()
    harm_info: dict[str, Any] = {}

    for code, r in enumerate(regions):
        rid = r["id"]
        f = clean_dir / f"firms_{rid}.parquet"
        if not f.exists():
            region_status[rid] = "missing"
            log.warning("%s: no FIRMS data (data/clean/firms_%s.parquet): the app shows demo data for it", rid, rid)
            continue
        raw = pd.read_parquet(f)
        df, st = clean(raw, r["bbox"], cfg.get("clean", {}))
        st["by_family_year"] = {f"{fam}:{y}": int(n) for (fam, y), n in raw.groupby([raw["family"], raw["acq_date"].str.slice(0, 4)]).size().items()}
        st["kept_by_family_year"] = {f"{fam}:{y}": int(n) for (fam, y), n in df.groupby([df["family"], df["acq_date"].str.slice(0, 4)]).size().items()}
        filter_stats[rid] = st
        if df.empty or (df["sensor"] == "MODIS").sum() == 0:
            region_status[rid] = "missing"
            log.warning("%s: no MODIS detections after cleaning", rid)
            continue
        sat_seen.update(df["satellite"].unique())
        hotspot_rows[rid] = df
        g = grid_cells(df[df["acq_date"].str.slice(0, 7).isin(set(months))], cell_km)
        cm = cell_month_table(g, ref_sat)

        # Region-month series. NaN where a sensor was not observing.
        reg = cm.groupby("ym")[["modis", "modis_terra", "modis_aqua", "viirs"]].sum().reindex(months, fill_value=0)
        modis_on = (reg.index >= first_month) & (reg.index <= _month_of(modis_last))
        viirs_on = (reg.index >= viirs_start) & (reg.index <= _month_of(ref_last))
        reg["modis_on"] = modis_on
        reg.loc[~viirs_on, "viirs"] = np.nan
        try:
            hd, info = harmonize_region(reg, code, splits.train, splits.cal, splits.test, partial_month)
        except PipelineError as e:
            region_status[rid] = "missing"
            log.warning("%s: %s", rid, e)
            continue
        harm_info[rid] = info
        region_status[rid] = "real"
        rows = [
            {
                "ym": ym,
                "harmonized": round(float(x.harmonized), 1),
                "low": round(float(x.low), 1),
                "high": round(float(x.high), 1),
                "modis_raw": int(x.modis) if x.modis_on else None,
                "viirs_raw": None if pd.isna(x.viirs) else int(x.viirs),
            }
            for ym, x in hd.iterrows()
        ]
        ctx_f = clean_dir / f"power_{rid}.json"
        ctx = json.loads(ctx_f.read_text(encoding="utf-8")) if ctx_f.exists() else None
        if ctx is not None:
            ctx = [c for c in ctx if first_month <= c["ym"] <= last_month]
        val = info["validation"]
        stage_out[rid] = {
            "id": rid,
            "fire_year_start_month": int(r.get("fire_year_start_month", 1)),
            "partial_last": partial_month is not None,
            "rows": rows,
            **({"validation": {"overlap": f"{viirs_start}/{splits.last_complete}", "train": f"{splits.train[0]}-{splits.train[1]}", "test": f"{splits.test[0]}-{splits.test[1]}", **{k: val[k] for k in ("corr_raw", "corr_harmonized", "mae", "bias", "coverage_90")}}} if val and not any(isinstance(val[k], float) and math.isnan(val[k]) for k in ("corr_raw", "corr_harmonized")) else {}),
            **({"context": ctx} if ctx else {}),
        }
        if not ctx:
            notes.append(f"NASA POWER context unavailable for {rid}: the strip is hidden.")

        # Grid cells: the region's ratio; the region-month band shared in proportion to each
        # cell's value, so a custom area equal to the region gets the region band back
        # (custom areas are labelled approximate).
        cm["month"] = cm["ym"].str.slice(5, 7).astype(int)
        head_t = cm["ym"] < AQUA_START
        rmap_ta = {m: info["ratio_by_month"].get(m, info["ratio_global"]) for m in range(1, 13)}
        rmap_t = {m: info["ratio_by_month_terra"].get(m, info["ratio_global"]) for m in range(1, 13)}
        ratio = np.where(head_t, cm["month"].map(rmap_t), cm["month"].map(rmap_ta))
        mod_on_c = (cm["ym"] <= _month_of(modis_last)).to_numpy()
        vi_on_c = ((cm["ym"] >= viirs_start) & (cm["ym"] <= _month_of(ref_last))).to_numpy()
        base = np.where(head_t, cm["modis_terra"], cm["modis"])
        hc = np.where(mod_on_c, ratio * base, cm["viirs"])
        cm["h"] = hc
        rh = hd["harmonized"].reindex(cm["ym"]).to_numpy(float)
        rlo = hd["low"].reindex(cm["ym"]).to_numpy(float)
        rhi = hd["high"].reindex(cm["ym"]).to_numpy(float)
        n_act = cm.groupby("ym")["cell_id"].transform("size").to_numpy(float)
        with np.errstate(divide="ignore", invalid="ignore"):
            cm["lo"] = np.where(rh > 0, hc * rlo / rh, 0.0)
            cm["hi"] = np.where(rh > 0, hc * rhi / rh, rhi / n_act)
        cm["v_out"] = np.where(vi_on_c, cm["viirs"], np.nan)
        for c in cm.itertuples(index=False):
            t = tiles.setdefault(tile_id(c.clat, c.clon, tile_deg), {})
            cell = t.setdefault(c.cell_id, {"id": c.cell_id, "lat": c.clat, "lon": c.clon, "m": {}})
            cell["m"][c.ym] = [round(float(c.h), 2), round(float(c.lo), 2), round(float(c.hi), 2), int(c.modis), None if math.isnan(c.v_out) else int(c.v_out)]

        # ML inputs: dense cell x month for the cells that carry most of the activity.
        mlc = cfg.get("ml_inputs", {})
        tot = cm.groupby("cell_id")["modis"].sum() + cm.groupby("cell_id")["viirs"].sum()
        tot = tot.sort_values(ascending=False)
        keep = tot.index[: max(1, min(int(mlc.get("max_cells_per_region", 700)), int((tot.cumsum() < mlc.get("keep_share", 0.97) * tot.sum()).sum()) + 1))]
        pos = cm.drop_duplicates("cell_id").set_index("cell_id").loc[keep, ["clat", "clon"]]
        dense = pd.MultiIndex.from_product([keep, months], names=["cell_id", "ym"]).to_frame(index=False)
        dense = dense.merge(cm.drop(columns=["clat", "clon", "month", "h", "lo", "hi", "v_out"]), on=["cell_id", "ym"], how="left")
        for c in ("modis_terra", "modis_aqua", "viirs", "modis"):
            dense[c] = dense[c].fillna(0.0)
        mon = dense["ym"].isin(set(reg.index[modis_on]))
        dense.loc[~mon, ["modis_terra", "modis_aqua"]] = np.nan
        dense.loc[dense["ym"] < AQUA_START, "modis_aqua"] = np.nan
        dense.loc[~dense["ym"].isin(set(reg.index[viirs_on])), "viirs"] = np.nan
        dense = dense.join(pos, on="cell_id").rename(columns={"clat": "lat", "clon": "lon"})
        dense["region"], dense["country"], dense["landcover"], dense["ndvi"] = rid, r["country"], r.get("landcover", "grassland"), np.nan
        ml_parts.append(dense.drop(columns=["modis"]))
        log.info("%s: %s clean detections, %d cells, %d ML cells · test r raw %s -> harmonized %s, coverage %s", rid, f"{len(df):,}", cm["cell_id"].nunique(), len(keep), val and val["corr_raw"], val and val["corr_harmonized"], val and val["coverage_90"])

    real = [k for k, v in region_status.items() if v == "real"]
    if not real:
        raise PipelineError("no region has usable FIRMS data: nothing written, the previous snapshot (or the demo data) stays in place.")

    # ---- write: replace only what this run produces.
    for d in ("grid", "hotspots", "region", "ml_inputs"):
        shutil.rmtree(products / d, ignore_errors=True)
    shutil.rmtree(stage / "base", ignore_errors=True)
    for rid, s in stage_out.items():
        atomic_write(stage / "base" / f"{rid}.json", json.dumps(s, separators=(",", ":")))
    for tid, cells in tiles.items():
        atomic_write(products / "grid" / f"{tid}.json", json.dumps({"cells": list(cells.values())}, separators=(",", ":")))
    head = ["latitude", "longitude", "acq_datetime_utc", "sensor", "satellite", "confidence", "frp_mw", "type"]
    for rid, df in hotspot_rows.items():
        out = pd.DataFrame({"latitude": df["lat"].round(4), "longitude": df["lon"].round(4), "acq_datetime_utc": df["acq_datetime_utc"], "sensor": df["sensor"], "satellite": df["satellite"], "confidence": df["confidence"], "frp_mw": df["frp"].round(1), "type": df["type"].astype("Int64").astype(str).replace("<NA>", "")})
        out = out.sort_values("acq_datetime_utc", kind="stable")
        for y, part in out.groupby(out["acq_datetime_utc"].str.slice(0, 4)):
            p = products / "hotspots" / rid / f"{y}.csv"
            p.parent.mkdir(parents=True, exist_ok=True)
            part[head].to_csv(p, index=False, lineterminator="\n")
    (products / "ml_inputs").mkdir(parents=True, exist_ok=True)
    pd.concat(ml_parts, ignore_index=True).to_parquet(products / "ml_inputs" / "cell_month.parquet", index=False)

    sensors = [FAMILY_SENSOR_NAME[s] for s in ("Terra", "Aqua", "S-NPP", "NOAA-20", "NOAA-21") if s in sat_seen]
    pw = meta_dir / "power_run.json"
    ev = meta_dir / "eonet_run.json"
    index = {
        "version": "1",
        "generated_at": utc_now_iso(),
        "first_month": first_month,
        "last_month": last_month,
        "presets": [{"id": r["id"], "name": r["name"], "country": r["country"], "bbox": r["bbox"]} for r in regions],
        "viirs_start": viirs_start,
        "sensors": sensors,
        "grid": {"cell_km": cell_km, "tile_deg": int(tile_deg) if tile_deg.is_integer() else tile_deg},
        "source": "live",
        # ---- additive (contract v1 readers ignore these) ----
        "data_mode": "real",
        "partial_month": partial_month,
        "viirs_reference": ref_family,
        "sources_used": sorted(su),
        "source_dates": su,
        "availability": availability.get("sources", {}),
        "availability_fetched_at": availability.get("fetched_at"),
        "access": {
            "firms": run.get("fetched_at"),
            "power": json.loads(pw.read_text(encoding="utf-8")).get("fetched_at") if pw.exists() else None,
            "eonet": json.loads(ev.read_text(encoding="utf-8")).get("fetched_at") if ev.exists() else None,
        },
        "regions_status": region_status,
        "splits": splits.label(),
        "filters": {"modis_min_confidence": cfg["clean"]["modis_min_confidence"], "viirs_confidence": cfg["clean"]["viirs_confidence"], "types_kept": cfg["clean"]["types_kept"]},
        "notes": notes,
    }
    atomic_write(products / "index.json", json.dumps(index, ensure_ascii=False, indent=1))
    atomic_write(meta_dir / "pipeline_run.json", json.dumps({"generated_at": index["generated_at"], "regions_status": region_status, "filters": filter_stats, "harmonization": harm_info}, indent=1, default=str))
    log.info("wrote %s: %d regions real (%s), %d grid tiles", products, len(real), ", ".join(real), len(tiles))
    return index
