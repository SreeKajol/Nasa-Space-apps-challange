"""FireRings Intelligence layer: leakage, conformal coverage, scores, schema, determinism, grounding."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from src.compute.ml.conformal import MondrianConformal, conformal_quantile
from src.compute.ml.features import UnitSeries, build_harmonization_features, firecast_frame, make_splits
from src.compute.ml.firecast import lac_threshold, pred_sets, rpss
from src.compute.ml.io import load_contract, load_observations, months_between
from src.compute.ml.narrative import forecast_sentence, numbers_grounded, numbers_in, polish
from src.compute.ml.schema import SchemaError, validate_grid, validate_index, validate_model_card, validate_region

# ---------------------------------------------------------------- no leakage


def test_firecast_features_never_use_the_future():
    rng = np.random.default_rng(0)
    months = months_between("2001-01", "2010-12")
    U, K = 5, len(months)

    def series(h: np.ndarray) -> UnitSeries:
        r = np.random.default_rng(1)
        return UnitSeries([f"u{i}" for i in range(U)], months, h, r.random((U, K)) * 100, r.random((U, K)) * 30, r.random((U, K)) * 90, r.random((U, K)), np.zeros(U), np.zeros(U))

    h = rng.gamma(2, 3, (U, K))
    clim = list(range(2001, 2006))
    cut = months.index("2006-06")
    a = firecast_frame(series(h), 1, clim, "2010-12")
    h2 = h.copy()
    h2[:, cut + 1 :] = rng.gamma(2, 30, (U, K - cut - 1))  # rewrite everything after the cut
    b = firecast_frame(series(h2), 1, clim, "2010-12")
    feats = ["lag0_anom", "lag1_anom", "lag2_anom", "precip3_anom", "t2m_anom", "rh_anom", "ndvi_anom", "clim_log"]
    sel_a = a[a["origin"] <= months[cut]]
    sel_b = b[b["origin"] <= months[cut]]
    pd.testing.assert_frame_equal(sel_a[feats].reset_index(drop=True), sel_b[feats].reset_index(drop=True))
    # ...while targets after the cut do change (the test would be vacuous otherwise)
    assert not np.array_equal(a.loc[a["target"] > months[cut], "obs"].to_numpy(), b.loc[b["target"] > months[cut], "obs"].to_numpy())


def test_harmonization_features_are_same_month_or_past(fixture_dir: Path):
    index, regions = load_contract(fixture_dir)
    obs, _, _ = load_observations(fixture_dir, index, regions, 3)
    splits = make_splits(index, partial=True)
    a = build_harmonization_features(obs, index, splits, index["last_month"])
    cut = f"{splits.test[0]}-06"  # after the training years, so climatologies are untouched
    obs2 = obs.copy()
    future = obs2["ym"] > cut
    for c in ("modis_terra", "modis_aqua", "viirs", "frp_mean", "ndvi"):
        obs2.loc[future, c] = obs2.loc[future, c] * 7 + 3
    b = build_harmonization_features(obs2, index, splits, index["last_month"])
    cols = ["log_modis", "frp_mean", "clim_modis", "ndvi_anom", "precip3_anom", "reg_modis", "nbr_modis"]
    ka = a[a["ym"] <= cut].sort_values(["cell_id", "ym"])[cols].reset_index(drop=True)
    kb = b[b["ym"] <= cut].sort_values(["cell_id", "ym"])[cols].reset_index(drop=True)
    pd.testing.assert_frame_equal(ka, kb)


def test_splits_keep_test_years_out_of_training(fixture_dir: Path):
    index, _ = load_contract(fixture_dir)
    s = make_splits(index, partial=True)
    assert s.train[1] < s.cal < s.test[0]
    assert s.last_complete == "2026-10"


# ---------------------------------------------------------------- conformal


def test_mondrian_conformal_covers_each_group():
    rng = np.random.default_rng(42)
    n = 40_000
    g = rng.choice(["a", "b", "c"], n, p=[0.6, 0.3, 0.1])
    scale = np.where(g == "a", 1.0, np.where(g == "b", 3.0, 0.5))  # heteroscedastic by group
    sigma_hat = np.ones(n)  # deliberately poor scale model: Mondrian must fix it per group
    y = rng.normal(0, scale)
    cal, test = slice(0, n // 2), slice(n // 2, n)
    mc = MondrianConformal(alpha=0.1).fit(np.abs(y[cal]) / sigma_hat[cal], {"grp": g[cal]})
    hw = sigma_hat[test] * mc.q({"grp": g[test]})
    inside = np.abs(y[test]) <= hw
    assert abs(inside.mean() - 0.9) < 0.02
    for k in "abc":
        assert abs(inside[g[test] == k].mean() - 0.9) < 0.03, k


def test_conformal_quantile_is_finite_sample_valid():
    s = np.arange(1, 10, dtype=float)  # n = 9 -> ceil(10 * 0.9) = 9th smallest
    assert conformal_quantile(s, 0.1) == 9.0
    assert conformal_quantile(np.arange(1, 5, dtype=float), 0.1) == float("inf")


# ---------------------------------------------------------------- scores and sets


def test_rpss_reference_points():
    y = np.array([0, 1, 2, 2, 1, 0])
    clim = np.full((6, 3), 1 / 3)
    assert rpss(clim, y, clim) == pytest.approx(0.0)
    assert rpss(np.eye(3)[y], y, clim) == pytest.approx(1.0)
    assert rpss(np.eye(3)[2 - y], y, clim) < 0


def test_lac_sets_reach_target_coverage():
    rng = np.random.default_rng(5)
    logits = rng.normal(0, 1.2, (6000, 3))
    p = np.exp(logits) / np.exp(logits).sum(1, keepdims=True)
    y = np.array([rng.choice(3, p=pi) for pi in p])
    q = lac_threshold(p[:3000], y[:3000], 0.1)
    s = pred_sets(p[3000:], q)
    assert s[np.arange(3000), y[3000:]].mean() >= 0.88
    assert s.sum(1).min() >= 1


# ---------------------------------------------------------------- narrative grounding


def test_numbers_guard():
    facts = ["58%", "0.14", "December 2026", "−42 mm"]
    assert numbers_grounded("December 2026: above-normal (58%), RPSS 0.14, rain −42 mm.", facts)
    assert not numbers_grounded("December 2026: above-normal (61%).", facts)
    assert numbers_in("১২৩ and 1,234.5") == [repr(123.0), repr(1234.5)]


def test_polish_rejects_invented_numbers():
    text = "Next month: 58% chance."
    assert polish(text, ["58%"], llm=lambda s: "Next month: a 75% chance!") == text
    assert polish(text, ["58%"], llm=lambda s: "Next month, a 58% chance.") == "Next month, a 58% chance."
    assert polish(text, ["58%"]) == text  # off by default


def test_forecast_sentences_use_only_given_numbers():
    f = {"ym": "2026-12", "p": [0.18, 0.27, 0.55], "set": ["near", "above"], "skilful": True, "rpss": 0.14, "drivers": [{"feature": "precip3_anom", "contrib": 0.3, "value": -42.0}, {"feature": "lag0_anom", "contrib": 0.2, "value": 1.8}]}
    for lang in ("en", "bn", "es"):
        s = forecast_sentence(lang, f)
        assert numbers_grounded(s, ["2026", "55%", "0.14", "0,14", "42 mm", "1.8", "1,8", "3"]), (lang, s)
    assert "no reliable" in forecast_sentence("en", {**f, "skilful": False}).lower()


# ---------------------------------------------------------------- end to end: schema + determinism


def test_outputs_match_schema(ml_out: Path):
    ix = json.loads((ml_out / "index.json").read_text(encoding="utf-8"))
    validate_index(ix)
    assert ix["source"] == "demo"
    assert set(ix["raw_trained_trend"]) == {"north", "south"}
    for rid in ix["regions"]:
        r = json.loads((ml_out / "region" / f"{rid}.json").read_text(encoding="utf-8"))
        validate_region(r)
        assert len(r["firecast"]) == 3
        assert r["monthly_ml"][0]["ym"] == "2000-11"
    for f in (ml_out / "grid").glob("*.json"):
        validate_grid(json.loads(f.read_text(encoding="utf-8")), f.stem)
    validate_model_card(json.loads((ml_out / "model_card.json").read_text(encoding="utf-8")))


def test_schema_rejects_bad_probabilities(ml_out: Path):
    rid = json.loads((ml_out / "index.json").read_text(encoding="utf-8"))["regions"][0]
    r = json.loads((ml_out / "region" / f"{rid}.json").read_text(encoding="utf-8"))
    r["firecast"][0]["p"] = [0.5, 0.5, 0.5]
    with pytest.raises(SchemaError):
        validate_region(r)


def test_runs_are_deterministic(fixture_dir: Path, ml_out: Path, tmp_path: Path):
    from src.compute.ml.run import main

    assert main(["--data", str(fixture_dir), "--out", str(tmp_path), "--quick", "--now", "2026-11-05"]) == 0
    for rel in ["index.json", *[f"region/{p.name}" for p in (ml_out / "region").iterdir()]]:
        a = json.loads((ml_out / rel).read_text(encoding="utf-8"))
        b = json.loads((tmp_path / rel).read_text(encoding="utf-8"))
        a.pop("generated_at", None)
        b.pop("generated_at", None)
        assert a == b, rel
