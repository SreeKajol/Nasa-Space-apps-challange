"""NASA POWER monthly climate context per region centroid.

    GET https://power.larc.nasa.gov/api/temporal/monthly/point
        ?parameters=T2M,PRECTOTCORR,RH2M&community=AG&longitude=..&latitude=..
        &start=YYYY&end=YYYY&format=JSON

-> contract v1 `context` [{ym, t2m_c, precip_mm, rh_pct}] (and the ML layer's t2m/precip/rh).

Checked against the live API at runtime, not assumed:
  * parameter names come back in `parameters` with their units. PRECTOTCORR is
    "mm/day" in the monthly API, so precip_mm = mm/day x days in month. Any other
    unit is logged and the context is dropped rather than guessed;
  * month "13" is the annual value and is dropped;
  * the fill value (header.fill_value, -999) becomes NaN.
If the call fails, the error is logged and the region simply has no context
(the field is omitted and the UI hides the strip).
"""

from __future__ import annotations

import calendar
import json
import logging
import math
from datetime import date
from pathlib import Path
from typing import Any

from .common import Http, atomic_write, path_of, utc_now_iso

log = logging.getLogger("firerings.ingest.power")

URL = "https://power.larc.nasa.gov/api/temporal/monthly/point"
FILL = -999.0


def power_params(lat: float, lon: float, y0: int, y1: int, parameters: list[str], community: str = "AG") -> dict[str, Any]:
    return {"parameters": ",".join(parameters), "community": community, "longitude": round(lon, 4), "latitude": round(lat, 4), "start": y0, "end": y1, "format": "JSON"}


def centroid(bbox: list[float]) -> tuple[float, float]:
    """(lat, lon) of a [W, S, E, N] box."""
    return (bbox[1] + bbox[3]) / 2, (bbox[0] + bbox[2]) / 2


def parse_monthly(doc: dict[str, Any]) -> list[dict[str, Any]]:
    """POWER monthly JSON -> [{ym, t2m_c, precip_mm, rh_pct}] with NaN for missing values."""
    fill = float((doc.get("header") or {}).get("fill_value", FILL))
    units = {k: (v or {}).get("units") for k, v in (doc.get("parameters") or {}).items()}
    p = doc["properties"]["parameter"]
    for name in ("T2M", "PRECTOTCORR", "RH2M"):
        if name not in p:
            raise ValueError(f"POWER response has no {name} (got {sorted(p)})")
    pu = units.get("PRECTOTCORR", "mm/day")
    if pu not in ("mm/day", "mm day-1", "mm"):
        raise ValueError(f"unexpected PRECTOTCORR unit {pu!r}")

    def val(name: str, k: str) -> float:
        v = p[name].get(k)
        if v is None:
            return math.nan
        v = float(v)
        return math.nan if v == fill or v <= -998 else v

    rows = []
    for k in sorted(p["T2M"]):
        if len(k) != 6 or not k.isdigit():
            continue
        y, m = int(k[:4]), int(k[4:])
        if not 1 <= m <= 12:  # month 13 = annual mean/total
            continue
        pr = val("PRECTOTCORR", k)
        if pu != "mm":
            pr = pr * calendar.monthrange(y, m)[1]
        rows.append({"ym": f"{y:04d}-{m:02d}", "t2m_c": val("T2M", k), "precip_mm": pr, "rh_pct": val("RH2M", k)})
    return rows


def to_context(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Contract `context` points: complete months only (all three values present), rounded like the demo."""
    out = []
    for r in rows:
        if any(math.isnan(r[k]) for k in ("t2m_c", "precip_mm", "rh_pct")):
            continue
        out.append({"ym": r["ym"], "t2m_c": round(r["t2m_c"], 1), "precip_mm": round(r["precip_mm"], 1), "rh_pct": round(r["rh_pct"])})
    return out


def fetch_region(http: Http | None, region: dict[str, Any], y0: int, y1: int, cache_dir: Path, parameters: list[str], community: str, refresh_current: bool = True) -> list[dict[str, Any]] | None:
    """Cached POWER call for one region centroid. The current year's file is refreshed each run."""
    lat, lon = centroid(region["bbox"])
    f = cache_dir / f"{region['id']}_{y0}_{y1}.json"
    stale = refresh_current and y1 >= date.today().year and f.exists() and f.stat().st_mtime < _today_ts()
    if f.exists() and not stale:
        return parse_monthly(json.loads(f.read_text(encoding="utf-8")))
    if http is None:
        return None
    for end in (y1, y1 - 1):  # POWER may not serve the current year yet
        status, body = http.get_text(URL, power_params(lat, lon, y0, end, parameters, community))
        if status == 200:
            doc = json.loads(body)
            rows = parse_monthly(doc)  # validates names and units before caching
            atomic_write(cache_dir / f"{region['id']}_{y0}_{y1}.json", body)
            return rows
        log.warning("POWER %s %d-%d: HTTP %s %s", region["id"], y0, end, status, body[:160].replace("\n", " "))
    return None


def _today_ts() -> float:
    import time

    t = time.localtime()
    return time.mktime((t.tm_year, t.tm_mon, t.tm_mday, 0, 0, 0, 0, 0, -1))


def run(cfg: dict[str, Any], regions: list[dict[str, Any]], http: Http | None, first_year: int, last_year: int) -> dict[str, Any]:
    cache = path_of(cfg, "power")
    pc = cfg.get("power", {})
    params = pc.get("parameters", ["T2M", "PRECTOTCORR", "RH2M"])
    out: dict[str, Any] = {"fetched_at": utc_now_iso(), "regions": {}}
    for r in regions:
        try:
            rows = fetch_region(http, r, first_year, last_year, cache, params, pc.get("community", "AG"))
        except Exception as e:  # never fatal: the region just has no context
            log.error("POWER %s failed: %s (continuing without context)", r["id"], e)
            rows = None
        if not rows:
            out["regions"][r["id"]] = {"status": "unavailable"}
            continue
        ctx = to_context(rows)
        atomic_write(path_of(cfg, "clean") / f"power_{r['id']}.json", json.dumps(ctx))
        out["regions"][r["id"]] = {"status": "ok", "months": len(ctx), "first": ctx[0]["ym"] if ctx else None, "last": ctx[-1]["ym"] if ctx else None, "lat": round(centroid(r["bbox"])[0], 4), "lon": round(centroid(r["bbox"])[1], 4)}
        log.info("POWER %s: %d months (%s..%s)", r["id"], len(ctx), ctx[0]["ym"] if ctx else "-", ctx[-1]["ym"] if ctx else "-")
    atomic_write(path_of(cfg, "meta") / "power_run.json", json.dumps(out, indent=1))
    return out
