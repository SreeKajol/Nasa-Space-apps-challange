"""Schema checks for every ML output file (data contract v1.1, additive).

Small, dependency-free validators: they raise SchemaError with the path of
the first problem. Run by export and by tests/ml/test_schema.py.
"""

from __future__ import annotations

import math
import re
from typing import Any

YM = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
CLASSES = {"below", "near", "above"}


class SchemaError(ValueError):
    pass


def _req(obj: Any, key: str, typ: type | tuple[type, ...], path: str) -> Any:
    if not isinstance(obj, dict) or key not in obj:
        raise SchemaError(f"{path}.{key}: missing")
    v = obj[key]
    if not isinstance(v, typ) or (isinstance(v, bool) and typ in (int, float, (int, float))):
        raise SchemaError(f"{path}.{key}: expected {typ}, got {type(v).__name__}")
    return v


def _num(obj: Any, key: str, path: str, lo: float = -math.inf, hi: float = math.inf, nullable: bool = False) -> None:
    if nullable and isinstance(obj, dict) and obj.get(key) is None:
        return
    v = _req(obj, key, (int, float), path)
    if not (lo <= v <= hi) or (isinstance(v, float) and math.isnan(v)):
        raise SchemaError(f"{path}.{key}: {v} outside [{lo}, {hi}]")


def _tri(obj: Any, path: str) -> None:
    for lang in ("en", "bn", "es"):
        _req(obj, lang, str, path)


def validate_index(ix: dict[str, Any]) -> None:
    p = "index"
    if _req(ix, "version", str, p) != "1.1-ml":
        raise SchemaError("index.version must be '1.1-ml'")
    _req(ix, "generated_at", str, p)
    if _req(ix, "source", str, p) not in ("live", "demo"):
        raise SchemaError("index.source must be live|demo")
    inputs = _req(ix, "inputs", dict, p)
    for k in ("first_month", "last_month", "viirs_start", "origin"):
        if not YM.match(_req(inputs, k, str, f"{p}.inputs")):
            raise SchemaError(f"{p}.inputs.{k}: not YYYY-MM")
    models = _req(ix, "models", dict, p)
    h = _req(models, "harmonization", dict, f"{p}.models")
    if _req(h, "chosen", str, "harmonization") not in ("xgboost", "baseline"):
        raise SchemaError("harmonization.chosen must be xgboost|baseline")
    _req(h, "version", str, "harmonization")
    met = _req(h, "metrics", dict, "harmonization")
    for name in ("baseline", "xgboost"):
        m = _req(met, name, dict, "harmonization.metrics")
        for split in ("cal", "test"):
            s = _req(m, split, dict, f"metrics.{name}")
            for k in ("mae", "rmse_log1p", "bias", "spearman"):
                _num(s, k, f"metrics.{name}.{split}", nullable=True)
    corr = _req(h, "corr", dict, "harmonization")
    for k in ("raw", "baseline", "xgboost"):
        _num(corr, k, "harmonization.corr", -1, 1)
    c = _req(h, "conformal", dict, "harmonization")
    _num(c, "target", "conformal", 0, 1)
    _num(c, "coverage_test", "conformal", 0, 1)
    _num(c, "mean_width", "conformal", 0)
    for i, g in enumerate(_req(c, "by_group", list, "conformal")):
        _req(g, "group", str, f"conformal.by_group[{i}]")
        _req(g, "kind", str, f"conformal.by_group[{i}]")
        _num(g, "coverage", f"conformal.by_group[{i}]", 0, 1)
        _req(g, "flag", bool, f"conformal.by_group[{i}]")
        _tri(_req(g, "label", dict, f"conformal.by_group[{i}]"), f"conformal.by_group[{i}].label")
    f = _req(models, "firecast", dict, f"{p}.models")
    _req(f, "version", str, "firecast")
    _num(f, "brier", "firecast", 0, 2)
    _num(f, "rpss", "firecast", -10, 1)
    for i, r in enumerate(_req(f, "reliability", list, "firecast")):
        _num(r, "bin", f"reliability[{i}]", 0, 1)
        _num(r, "observed", f"reliability[{i}]", 0, 1)
        _num(r, "n", f"reliability[{i}]", 1)
    gd = _req(ix, "global_drivers", dict, p)
    for k in ("harmonization", "firecast"):
        for i, d in enumerate(_req(gd, k, list, "global_drivers")):
            _req(d, "feature", str, f"global_drivers.{k}[{i}]")
            _tri(_req(d, "label", dict, f"global_drivers.{k}[{i}]"), f"global_drivers.{k}[{i}].label")
            _num(d, "mean_abs_shap", f"global_drivers.{k}[{i}]", 0)
    dep = _req(ix, "dependence", dict, p)
    for k, rows in dep.items():
        for i, r in enumerate(rows):
            _req(r, "bin", str, f"dependence.{k}[{i}]")
            _num(r, "shap", f"dependence.{k}[{i}]")
    for key in ("raw_trained_trend", "harmonized_trained_trend"):
        for rid, tr in _req(ix, key, dict, p).items():
            yrs = _req(tr, "years", list, f"{key}.{rid}")
            vals = _req(tr, "values", list, f"{key}.{rid}")
            if len(yrs) != len(vals):
                raise SchemaError(f"{key}.{rid}: years/values length differ")
            _num(tr, "slope", f"{key}.{rid}", nullable=True)
            _num(tr, "p", f"{key}.{rid}", 0, 1, nullable=True)


def validate_region(r: dict[str, Any]) -> None:
    p = f"region[{r.get('id')}]"
    _req(r, "id", str, p)
    prev = ""
    for i, m in enumerate(_req(r, "monthly_ml", list, p)):
        q = f"{p}.monthly_ml[{i}]"
        ym = _req(m, "ym", str, q)
        if not YM.match(ym) or ym <= prev:
            raise SchemaError(f"{q}.ym: invalid or not increasing")
        prev = ym
        _num(m, "ml_harmonized", q, 0)
        _num(m, "lo90", q, 0)
        _num(m, "hi90", q, 0)
        if not m["lo90"] <= m["ml_harmonized"] + 1e-6 <= m["hi90"] + 2e-6:
            raise SchemaError(f"{q}: expected lo90 <= ml_harmonized <= hi90")
    for ym, e in _req(r, "explain", dict, p).items():
        q = f"{p}.explain[{ym}]"
        if not YM.match(ym):
            raise SchemaError(f"{q}: bad key")
        _num(e, "base", q)
        _num(e, "start", q, 0)
        _num(e, "end", q, 0)
        for side, sign in (("pos", 1), ("neg", -1)):
            for j, c in enumerate(_req(e, side, list, q)):
                _req(c, "feature", str, f"{q}.{side}[{j}]")
                v = _req(c, "contrib", (int, float), f"{q}.{side}[{j}]")
                if v * sign < 0:
                    raise SchemaError(f"{q}.{side}[{j}].contrib has the wrong sign")
    for i, f in enumerate(_req(r, "firecast", list, p)):
        q = f"{p}.firecast[{i}]"
        if not YM.match(_req(f, "ym", str, q)):
            raise SchemaError(f"{q}.ym")
        probs = _req(f, "p", list, q)
        if len(probs) != 3 or any(not 0 <= x <= 1 for x in probs) or abs(sum(probs) - 1) > 0.01:
            raise SchemaError(f"{q}.p: must be 3 probabilities summing to 1")
        s = _req(f, "set", list, q)
        if not s or not set(s) <= CLASSES:
            raise SchemaError(f"{q}.set: non-empty subset of below/near/above")
        _req(f, "skilful", bool, q)
        _num(f, "rpss", q, -10, 1, nullable=True)
        for j, d in enumerate(_req(f, "drivers", list, q)):
            _req(d, "feature", str, f"{q}.drivers[{j}]")
            _num(d, "contrib", f"{q}.drivers[{j}]")
        _tri(_req(f, "narrative", dict, q), f"{q}.narrative")


def validate_grid(g: dict[str, Any], tile: str) -> None:
    for i, c in enumerate(_req(g, "cells", list, f"grid[{tile}]")):
        q = f"grid[{tile}].cells[{i}]"
        _req(c, "id", str, q)
        _num(c, "p_above", q, 0, 1)
        _num(c, "set_size", q, 1, 3)
        _req(c, "skilful", bool, q)


def validate_model_card(mc: dict[str, Any]) -> None:
    for k in ("name", "version", "intended_use", "not_for", "data", "metrics", "limitations", "license"):
        if k not in mc:
            raise SchemaError(f"model_card.{k}: missing")
