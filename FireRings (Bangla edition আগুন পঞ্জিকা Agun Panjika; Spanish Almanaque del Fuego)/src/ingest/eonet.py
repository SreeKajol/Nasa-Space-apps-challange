"""NASA EONET wildfire events: an INDEPENDENT check of the calendar.

    GET https://eonet.gsfc.nasa.gov/api/v3/events?category=wildfires&status=all
        &start=YYYY-MM-DD&end=YYYY-MM-DD&bbox={minLon},{maxLat},{maxLon},{minLat}

EONET's bbox order is upper-left then lower-right: minLon, maxLat, maxLon, minLat
(not the W,S,E,N used everywhere else). `bbox_param` does the conversion.

Validation: each event is dated by its first observation inside the region; it is
a hit when the calendar flags that month as above-normal or extreme (percentile
>= 75, the app's status bands). Fewer than `min_events` events -> "insufficient
events" and NO hit rate. The number is never padded or smoothed.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from .common import Http, atomic_write, path_of, utc_now_iso

log = logging.getLogger("firerings.ingest.eonet")

URL = "https://eonet.gsfc.nasa.gov/api/v3/events"
FLAG_PERCENTILE = 75  # "above" starts at the 75th percentile (src/compute/derive.ts statusOf)


def bbox_param(bbox: list[float]) -> str:
    """[W, S, E, N] -> EONET's 'minLon,maxLat,maxLon,minLat'."""
    w, s, e, n = bbox
    return f"{w},{n},{e},{s}"


def eonet_params(bbox: list[float], start: str, end: str) -> dict[str, Any]:
    return {"category": "wildfires", "status": "all", "start": start, "end": end, "bbox": bbox_param(bbox)}


def _points(geom: dict[str, Any]) -> list[tuple[float, float]]:
    c = geom.get("coordinates")
    if geom.get("type") == "Point" and c:
        return [(float(c[0]), float(c[1]))]
    if geom.get("type") == "Polygon" and c:
        return [(float(x), float(y)) for x, y in c[0]]
    return []


def events_in(doc: dict[str, Any], bbox: list[float]) -> list[dict[str, Any]]:
    """Events with at least one observation inside the bbox, dated by the first such observation."""
    w, s, e, n = bbox
    out = []
    for ev in doc.get("events", []):
        dates = []
        for g in ev.get("geometry", []):
            pts = _points(g)
            if any(w <= x <= e and s <= y <= n for x, y in pts) and g.get("date"):
                dates.append(g["date"][:10])
        if not dates:
            continue
        d = min(dates)
        out.append({"id": ev.get("id"), "title": ev.get("title"), "date": d, "ym": d[:7], "sources": [x.get("id") for x in ev.get("sources", [])], "link": ev.get("link")})
    return sorted(out, key=lambda x: (x["date"], x["id"] or ""))


def fetch_region(http: Http | None, region: dict[str, Any], start: str, end: str, cache_dir: Path) -> dict[str, Any] | None:
    """Cached per (region, start, end). The cache is refreshed when `end` moves."""
    f = cache_dir / f"{region['id']}_{start}_{end}.json"
    if f.exists():
        return json.loads(f.read_text(encoding="utf-8"))
    if http is None:
        return None
    status, body = http.get_text(URL, eonet_params(region["bbox"], start, end))
    if status != 200:
        log.warning("EONET %s: HTTP %s %s", region["id"], status, body[:160])
        return None
    atomic_write(f, body)
    return json.loads(body)


def validate(events: list[dict[str, Any]], monthly: list[dict[str, Any]], min_events: int = 3, partial_month: str | None = None) -> dict[str, Any]:
    """Compare EONET events with the months the calendar flags (percentile >= 75)."""
    flagged = sorted(p["ym"] for p in monthly if p.get("percentile", 0) >= FLAG_PERCENTILE and p["ym"] != partial_month)
    known = {p["ym"] for p in monthly}
    ev = [e for e in events if e["ym"] in known and e["ym"] != partial_month]
    fl = set(flagged)
    for e in ev:
        e["flagged"] = e["ym"] in fl
    matched = sum(e["flagged"] for e in ev)
    total = len(ev)
    res: dict[str, Any] = {"events": ev, "matched": matched, "total": total, "months_flagged": flagged, "flag_rule": "percentile >= 75 (above or extreme)", "min_events": min_events}
    if total < min_events:
        res.update(status="insufficient events", hit_rate=None)
    else:
        n_months = max(1, len(known - ({partial_month} if partial_month else set())))
        res.update(status="ok", hit_rate=round(matched / total, 3), base_rate=round(len(flagged) / n_months, 3))
    return res


def run_fetch(cfg: dict[str, Any], regions: list[dict[str, Any]], http: Http | None, start: str, end: str) -> dict[str, Any]:
    cache = path_of(cfg, "eonet")
    out: dict[str, Any] = {"fetched_at": utc_now_iso(), "start": start, "end": end, "regions": {}}
    for r in regions:
        try:
            doc = fetch_region(http, r, start, end, cache)
        except Exception as e:
            log.error("EONET %s failed: %s", r["id"], e)
            doc = None
        if doc is None:
            out["regions"][r["id"]] = {"status": "unavailable"}
            continue
        ev = events_in(doc, r["bbox"])
        atomic_write(path_of(cfg, "clean") / f"eonet_{r['id']}.json", json.dumps(ev, ensure_ascii=False))
        out["regions"][r["id"]] = {"status": "ok", "events": len(ev)}
        log.info("EONET %s: %d wildfire events in the bbox", r["id"], len(ev))
    atomic_write(path_of(cfg, "meta") / "eonet_run.json", json.dumps(out, indent=1))
    return out


def run_validate(cfg: dict[str, Any], regions: list[dict[str, Any]], products: Path) -> dict[str, Any]:
    """data-products/validation/eonet_{region}.json for every region with a region file."""
    idx_f = products / "index.json"
    index = json.loads(idx_f.read_text(encoding="utf-8")) if idx_f.exists() else {}
    partial = index.get("partial_month")
    minimum = int(cfg.get("eonet", {}).get("min_events", 3))
    summary = {}
    for r in regions:
        rf = products / "region" / f"{r['id']}.json"
        ef = path_of(cfg, "clean") / f"eonet_{r['id']}.json"
        if not rf.exists():
            continue
        region = json.loads(rf.read_text(encoding="utf-8"))
        if not ef.exists():
            res = {"status": "unavailable", "events": [], "matched": 0, "total": 0, "hit_rate": None, "months_flagged": []}
        else:
            res = validate(json.loads(ef.read_text(encoding="utf-8")), region["monthly"], minimum, partial)
        res.update(region=r["id"], source="NASA EONET v3 (category wildfires)", generated_at=utc_now_iso())
        atomic_write(products / "validation" / f"eonet_{r['id']}.json", json.dumps(res, ensure_ascii=False, indent=1))
        summary[r["id"]] = {k: res.get(k) for k in ("status", "matched", "total", "hit_rate")}
        log.info("EONET validation %s: %s", r["id"], summary[r["id"]])
    return summary
