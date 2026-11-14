"""Seam detector: is there a sensor break in the record?

    python -m src.compute.seam [--data data-products]

For each region file, a Pettitt changepoint test runs on the monthly RAW series
(MODIS + VIIRS counts, what the "Before" chart shows) and on the HARMONIZED
series. Both are deseasonalized first (log1p minus the calendar-month median),
so the annual fire season is not mistaken for a break. The result is written
into region/{id}.json as the additive field "seam_test":

    {"raw": {"break_ym", "p", "k"}, "harmonized": {...}, "alpha": 0.05, ...}

A real climate shift can also produce a break; the test only says where the
series changes level, and "near_viirs_start" says whether that lines up with
the sensor change. (ruptures/PELT would add multiple breaks; not required.)
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any

import numpy as np
from scipy.stats import rankdata

ALPHA = 0.05


def pettitt(x: np.ndarray) -> tuple[int, float, float]:
    """(index of the first point after the break, approximate p-value, K statistic).

    U_t = 2 * sum_{i<=t} rank_i - t (n + 1); K = max |U_t|; p ~ 2 exp(-6 K^2 / (n^3 + n^2)).
    """
    x = np.asarray(x, dtype=float)
    n = len(x)
    if n < 8:
        return 0, 1.0, 0.0
    r = rankdata(x)
    t = np.arange(1, n)
    u = 2 * np.cumsum(r)[:-1] - t * (n + 1)
    k_idx = int(np.argmax(np.abs(u)))
    K = float(abs(u[k_idx]))
    p = min(1.0, 2 * math.exp(-6 * K**2 / (n**3 + n**2)))
    return k_idx + 1, p, K


def deseasonalize(yms: list[str], v: np.ndarray) -> np.ndarray:
    lv = np.log1p(np.maximum(0, v))
    month = np.array([int(m[5:7]) for m in yms])
    out = lv.copy()
    for m in range(1, 13):
        sel = month == m
        if sel.any():
            out[sel] = lv[sel] - np.median(lv[sel])
    return out


def _months_apart(a: str, b: str) -> int:
    return abs((int(a[:4]) * 12 + int(a[5:7])) - (int(b[:4]) * 12 + int(b[5:7])))


def seam_test(monthly: list[dict[str, Any]], viirs_start: str, partial_month: str | None = None) -> dict[str, Any]:
    pts = [p for p in monthly if p["ym"] != partial_month]
    yms = [p["ym"] for p in pts]

    def raw_of(p: dict[str, Any]) -> float:
        m, v = p.get("modis_raw"), p.get("viirs_raw")
        return float((m or 0) + (v or 0))

    out: dict[str, Any] = {"method": "Pettitt test on deseasonalized log1p monthly series", "alpha": ALPHA, "n": len(pts), "viirs_start": viirs_start}
    for name, vals in (("raw", np.array([raw_of(p) for p in pts])), ("harmonized", np.array([float(p["harmonized"]) for p in pts]))):
        i, p, k = pettitt(deseasonalize(yms, vals))
        b = yms[i] if 0 < i < len(yms) else None
        out[name] = {"break_ym": b, "p": float(f"{p:.3g}"), "k": round(k, 1), "significant": bool(p < ALPHA), "near_viirs_start": bool(b is not None and _months_apart(b, viirs_start) <= 12)}
    return out


def run(data: Path) -> dict[str, Any]:
    index = json.loads((data / "index.json").read_text(encoding="utf-8"))
    partial = index.get("partial_month")
    summary = {}
    for f in sorted((data / "region").glob("*.json")):
        reg = json.loads(f.read_text(encoding="utf-8"))
        st = seam_test(reg["monthly"], index["viirs_start"], partial)
        reg["seam_test"] = st
        f.write_text(json.dumps(reg, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        summary[reg["id"]] = {k: st[k] for k in ("raw", "harmonized")}
        print(f"seam {reg['id']:<24} raw: break {st['raw']['break_ym']} p={st['raw']['p']}  ·  harmonized: break {st['harmonized']['break_ym']} p={st['harmonized']['p']}")
    return summary


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m src.compute.seam")
    ap.add_argument("--data", default="data-products")
    a = ap.parse_args(argv)
    run(Path(a.data))
    return 0


if __name__ == "__main__":
    sys.exit(main())
