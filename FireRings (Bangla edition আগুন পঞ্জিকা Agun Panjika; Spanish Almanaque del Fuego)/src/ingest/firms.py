"""NASA FIRMS hotspots: availability -> plan -> cached area-API downloads -> normalized rows.

    python -m src.ingest fetch --only firms [--dry-run]

API (FIRMS area API, CSV):
    /api/area/csv/{MAP_KEY}/{SOURCE}/{W,S,E,N}/{DAY_RANGE}/{YYYY-MM-DD}
    -> detections for DATE .. DATE + DAY_RANGE - 1
    /api/data_availability/csv/{MAP_KEY}/all
    -> data_id,min_date,max_date per source

Strategy per region bbox and sensor family (MODIS + the reference VIIRS satellite):
  a) archive CSVs in data/raw/archive/ are ingested first; dates they cover are not requested;
  b) other dates come from *_SP while the availability endpoint lists them;
  c) the rest (normally the most recent ~60 days) come from *_NRT, and are replaced by
     *_SP on a later run once SP covers them (SP-over-NRT dedup).
Every request is cached in data/raw/firms_cache/{source}/{region}/{date}_{range}.csv,
so a re-run never downloads the same chunk twice (except NRT chunks still filling up).
"""

from __future__ import annotations

import io
import json
import logging
import re
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import pandas as pd

from .common import FetchError, Http, atomic_write, path_of, progress, redact, register_secret, url_hash, utc_now_iso

log = logging.getLogger("firerings.ingest.firms")

BASE = "https://firms.modaps.eosdis.nasa.gov"
EPOCH = date(2000, 1, 1)  # chunk boundaries are aligned to this day, so cache names are stable

FAMILY_SATELLITES = {
    "MODIS": ("Terra", "Aqua"),
    "VIIRS_SNPP": ("S-NPP",),
    "VIIRS_NOAA20": ("NOAA-20",),
    "VIIRS_NOAA21": ("NOAA-21",),
}
SATELLITE_FAMILY = {s: f for f, sats in FAMILY_SATELLITES.items() for s in sats}

# What the "satellite" column says, in FIRMS area-API and archive files.
_SAT_MAP = {
    "t": "Terra", "terra": "Terra",
    "a": "Aqua", "aqua": "Aqua",
    "n": "S-NPP", "npp": "S-NPP", "snpp": "S-NPP", "s-npp": "S-NPP", "suomi-npp": "S-NPP", "suomi npp": "S-NPP",
    "n20": "NOAA-20", "noaa-20": "NOAA-20", "noaa20": "NOAA-20", "j1": "NOAA-20", "1": "NOAA-20",
    "n21": "NOAA-21", "noaa-21": "NOAA-21", "noaa21": "NOAA-21", "j2": "NOAA-21", "2": "NOAA-21",
}
_VIIRS_CONF = {"l": "low", "low": "low", "n": "nominal", "nominal": "nominal", "h": "high", "high": "high"}

NORMALIZED_COLUMNS = [
    "sensor", "satellite", "family", "acq_datetime_utc", "acq_date", "lat", "lon",
    "confidence", "confidence_level", "frp", "scan", "track", "daynight", "type",
    "version", "source_product", "source_url_hash",
]


# ---------------------------------------------------------------- URLs


def fmt_coord(x: float) -> str:
    s = f"{x:.4f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def area_url(key: str, source: str, bbox: Iterable[float], day_range: int, day: date) -> str:
    w, s, e, n = bbox
    if not (w < e and s < n):
        raise ValueError(f"bbox must be [W, S, E, N] with W<E and S<N, got {list(bbox)}")
    if not 1 <= day_range <= 31:
        raise ValueError(f"day_range out of range: {day_range}")
    coords = ",".join(fmt_coord(v) for v in (w, s, e, n))
    return f"{BASE}/api/area/csv/{key}/{source}/{coords}/{day_range}/{day.isoformat()}"


def availability_url(key: str) -> str:
    return f"{BASE}/api/data_availability/csv/{key}/all"


def mapkey_status_url(key: str) -> str:
    return f"{BASE}/mapserver/mapkey_status/?MAP_KEY={key}"


# ---------------------------------------------------------------- availability


def parse_availability(text: str) -> dict[str, dict[str, str]]:
    """'data_id,min_date,max_date' CSV -> {source: {first, last}}."""
    df = pd.read_csv(io.StringIO(text))
    cols = {c.lower().strip(): c for c in df.columns}
    if not {"data_id", "min_date", "max_date"} <= set(cols):
        raise FetchError(f"unexpected data_availability header: {list(df.columns)[:6]}")
    out = {}
    for r in df.itertuples(index=False):
        d = dict(zip(df.columns, r))
        sid = str(d[cols["data_id"]]).strip()
        out[sid] = {"first": str(d[cols["min_date"]])[:10], "last": str(d[cols["max_date"]])[:10]}
    return out


def fetch_availability(http: Http, key: str, meta_dir: Path) -> dict[str, dict[str, str]]:
    status, body = http.get_text(availability_url(key))
    if status != 200 or "data_id" not in body[:200]:
        raise FetchError(f"data_availability failed (HTTP {status}): {redact(body[:200]).strip()}")
    avail = parse_availability(body)
    atomic_write(meta_dir / "availability.json", json.dumps({"fetched_at": utc_now_iso(), "sources": avail}, indent=1))
    return avail


# Used ONLY by --dry-run without a key (no availability call possible). Labelled as assumed.
def assumed_availability(today: date) -> dict[str, dict[str, str]]:
    sp_end = (today - timedelta(days=95)).isoformat()
    nrt_start = (today - timedelta(days=94)).isoformat()
    t = today.isoformat()
    return {
        "MODIS_SP": {"first": "2000-11-01", "last": sp_end}, "MODIS_NRT": {"first": nrt_start, "last": t},
        "VIIRS_SNPP_SP": {"first": "2012-01-20", "last": sp_end}, "VIIRS_SNPP_NRT": {"first": nrt_start, "last": "2026-10-31"},
        "VIIRS_NOAA20_SP": {"first": "2018-04-01", "last": sp_end}, "VIIRS_NOAA20_NRT": {"first": nrt_start, "last": t},
        "VIIRS_NOAA21_NRT": {"first": "2024-01-17", "last": t},
    }


def family_span(avail: dict[str, dict[str, str]], fam_sources: dict[str, str]) -> tuple[date, date] | None:
    ds = [avail[s] for s in fam_sources.values() if s in avail]
    if not ds:
        return None
    return date.fromisoformat(min(d["first"] for d in ds)), date.fromisoformat(max(d["last"] for d in ds))


def first_full_month(d: date) -> str:
    """The first calendar month fully inside a record starting on day d."""
    if d.day == 1:
        return f"{d.year:04d}-{d.month:02d}"
    y, m = (d.year + 1, 1) if d.month == 12 else (d.year, d.month + 1)
    return f"{y:04d}-{m:02d}"


def choose_reference(avail: dict[str, dict[str, str]], cfg: dict[str, Any], end: date) -> dict[str, Any]:
    """Reference VIIRS satellite: the first preferred family whose record reaches the run date.

    Suomi-NPP stopped delivering on 1 Nov 2026: when VIIRS_SNPP_* is missing or ends more
    than `reference_tolerance_days` before `end`, NOAA-20 becomes the reference and
    viirs_start moves to the first full NOAA-20 month. The reason is returned and logged.
    """
    tol = int(cfg.get("reference_tolerance_days", 7))
    reasons = []
    for fam in cfg.get("viirs_reference", ["VIIRS_SNPP", "VIIRS_NOAA20"]):
        span = family_span(avail, cfg["sources"][fam])
        if span is None:
            reasons.append(f"{fam}: not listed by data_availability")
            continue
        if span[1] < end - timedelta(days=tol):
            reasons.append(f"{fam}: record ends {span[1]} (before {end} - {tol} d): partial")
            continue
        vs = first_full_month(span[0])
        res = {"family": fam, "viirs_start": vs, "first": span[0].isoformat(), "last": span[1].isoformat(), "skipped": reasons}
        if reasons:
            log.warning("reference VIIRS satellite: %s (viirs_start %s), because %s", fam, vs, "; ".join(reasons))
        else:
            log.info("reference VIIRS satellite: %s (viirs_start %s)", fam, vs)
        return res
    raise FetchError("no VIIRS reference satellite available: " + "; ".join(reasons))


# ---------------------------------------------------------------- plan


@dataclass(frozen=True)
class Chunk:
    source: str
    family: str
    product: str  # "SP" | "NRT"
    region: str
    start: date
    days: int

    @property
    def end(self) -> date:
        return self.start + timedelta(days=self.days - 1)

    def cache_path(self, root: Path) -> Path:
        return root / self.source / self.region / f"{self.start.isoformat()}_{self.days}.csv"

    def dates(self) -> list[date]:
        return [self.start + timedelta(days=i) for i in range(self.days)]


def product_for(d: date, fam_sources: dict[str, str], avail: dict[str, dict[str, str]]) -> str | None:
    """SP when the availability endpoint lists the date, else NRT, else None (gap)."""
    for prod in ("sp", "nrt"):
        sid = fam_sources.get(prod)
        a = avail.get(sid) if sid else None
        if a and a["first"] <= d.isoformat() <= a["last"]:
            return sid
    return None


def plan_family(region: str, family: str, fam_sources: dict[str, str], avail: dict[str, dict[str, str]], start: date, end: date, day_range: int, archive_dates: set[date] | None = None) -> tuple[list[Chunk], list[date]]:
    """Chunks covering every date in [start, end] exactly once (minus archive dates), and the gaps.

    Runs of consecutive dates with the same source are split at epoch-aligned
    boundaries of `day_range` days, so a later run with a later `end` reuses
    every earlier cache file except the last, still-open chunk.
    """
    archive_dates = archive_dates or set()
    chunks: list[Chunk] = []
    gaps: list[date] = []
    cur: list[date] = []
    cur_src: str | None = None
    cur_block = -1

    def flush() -> None:
        if cur and cur_src:
            prod = "SP" if cur_src.endswith("_SP") else "NRT"
            chunks.append(Chunk(cur_src, family, prod, region, cur[0], len(cur)))

    d = start
    while d <= end:
        src = None if d in archive_dates else product_for(d, fam_sources, avail)
        if src is None and d not in archive_dates:
            gaps.append(d)
        block = (d - EPOCH).days // day_range
        contiguous = bool(cur) and cur[-1] + timedelta(days=1) == d
        if src is None or src != cur_src or block != cur_block or not contiguous:
            flush()
            cur = []
        if src is not None:
            cur.append(d)
        cur_src, cur_block = src, block
        d += timedelta(days=1)
    flush()
    return chunks, gaps


def is_open(chunk: Chunk, today: date, open_days: int) -> bool:
    """An NRT chunk that ends within `open_days` of today is still filling up: re-download it."""
    return chunk.product == "NRT" and chunk.end >= today - timedelta(days=open_days)


# ---------------------------------------------------------------- normalize


def map_satellite(value: Any, hint: str | None = None) -> str | None:
    v = str(value).strip().lower() if value is not None and not (isinstance(value, float) and np.isnan(value)) else ""
    if v in _SAT_MAP:
        return _SAT_MAP[v]
    if hint:
        sats = FAMILY_SATELLITES.get(hint)
        if sats and len(sats) == 1:
            return sats[0]
    return None


def confidence_level(sensor: str, raw: Any) -> str | None:
    """MODIS 0-100 -> low (<30) / nominal (30-79) / high (>=80); VIIRS l/n/h -> low/nominal/high."""
    if raw is None or (isinstance(raw, float) and np.isnan(raw)):
        return None
    s = str(raw).strip().lower()
    if sensor == "VIIRS":
        return _VIIRS_CONF.get(s)
    try:
        c = float(s)
    except ValueError:
        return _VIIRS_CONF.get(s)
    return "low" if c < 30 else "nominal" if c < 80 else "high"


def detect_family(columns: Iterable[str], name: str = "", source: str | None = None) -> str | None:
    """MODIS vs VIIRS from the source id, the file name or the columns."""
    if source:
        for fam in FAMILY_SATELLITES:
            if source.startswith(fam + "_") or source == fam:
                return fam
    n = name.lower()
    if re.search(r"(^|[_-])m-?c6", n) or "modis" in n:
        return "MODIS"
    if "j2v" in n or "noaa21" in n or "noaa-21" in n:
        return "VIIRS_NOAA21"
    if "j1v" in n or "noaa20" in n or "noaa-20" in n:
        return "VIIRS_NOAA20"
    if "sv-c2" in n or "snpp" in n or "suomi" in n:
        return "VIIRS_SNPP"
    cols = {c.lower() for c in columns}
    if "brightness" in cols or "bright_t31" in cols:
        return "MODIS"
    if "bright_ti4" in cols:
        return "VIIRS"  # satellite decided per row
    return None


def product_of(name: str = "", source: str | None = None, version: Any = None) -> str:
    if source:
        return "NRT" if source.endswith("_NRT") else "SP"
    n = name.lower()
    if "fire_nrt" in n or "_nrt" in n:
        return "NRT"
    if "fire_archive" in n or "_sp" in n:
        return "SP"
    return "NRT" if "nrt" in str(version).lower() else "SP"


def normalize(raw: pd.DataFrame, *, source: str | None = None, name: str = "", src_hash: str = "") -> pd.DataFrame:
    """FIRMS CSV (area API or archive, MODIS or VIIRS) -> the cleaned schema (NORMALIZED_COLUMNS)."""
    if raw is None or raw.empty:
        return pd.DataFrame(columns=NORMALIZED_COLUMNS)
    df = raw.rename(columns={c: c.strip().lower() for c in raw.columns})
    fam = detect_family(df.columns, name, source)
    if fam is None:
        raise ValueError(f"cannot tell MODIS from VIIRS for {name or source}: columns {list(df.columns)[:8]}")
    sensor = "MODIS" if fam == "MODIS" else "VIIRS"
    hint = fam if fam != "VIIRS" else None
    sat_col = df["satellite"] if "satellite" in df.columns else pd.Series([None] * len(df), index=df.index)
    sats = sat_col.map(lambda v: map_satellite(v, hint))
    if sensor == "MODIS":
        sats = sats.where(sats.isin(["Terra", "Aqua"]))
    else:
        sats = sats.where(sats.isin(["S-NPP", "NOAA-20", "NOAA-21"]))
    t = df["acq_time"].astype(str).str.replace(r"\D", "", regex=True).str.zfill(4).str[-4:]
    d = pd.to_datetime(df["acq_date"].astype(str).str[:10], errors="coerce").dt.strftime("%Y-%m-%d")
    conf_raw = df["confidence"].astype(str).str.strip() if "confidence" in df.columns else pd.Series([None] * len(df), index=df.index)
    version = df["version"].astype(str) if "version" in df.columns else pd.Series([""] * len(df), index=df.index)
    prod = [product_of(name, source, v) for v in version] if source is None else [product_of(name, source)] * len(df)
    out = pd.DataFrame(
        {
            "sensor": sensor,
            "satellite": sats,
            "acq_datetime_utc": d + "T" + t.str[:2] + ":" + t.str[2:] + ":00Z",
            "acq_date": d,
            "lat": pd.to_numeric(df["latitude"], errors="coerce"),
            "lon": pd.to_numeric(df["longitude"], errors="coerce"),
            "confidence": conf_raw,
            "confidence_level": [confidence_level(sensor, c) for c in conf_raw],
            "frp": pd.to_numeric(df.get("frp"), errors="coerce") if "frp" in df.columns else np.nan,
            "scan": pd.to_numeric(df.get("scan"), errors="coerce") if "scan" in df.columns else np.nan,
            "track": pd.to_numeric(df.get("track"), errors="coerce") if "track" in df.columns else np.nan,
            "daynight": df["daynight"].astype(str).str.upper().str[:1] if "daynight" in df.columns else None,
            "type": pd.to_numeric(df["type"], errors="coerce").astype("Int64") if "type" in df.columns else pd.array([pd.NA] * len(df), dtype="Int64"),
            "version": version,
            "source_product": prod,
            "source_url_hash": src_hash,
        }
    )
    out["family"] = out["satellite"].map(SATELLITE_FAMILY)
    bad = out["satellite"].isna() | out["acq_date"].isna() | out["lat"].isna() | out["lon"].isna()
    if bad.any():
        log.debug("dropped %d rows without satellite/date/position in %s", int(bad.sum()), name or source)
    return out.loc[~bad, NORMALIZED_COLUMNS].reset_index(drop=True)


def dedup_sp_over_nrt(df: pd.DataFrame, sp_coverage: set[tuple[str, str]] | None = None) -> pd.DataFrame:
    """Science-quality (SP) rows replace near-real-time (NRT) rows.

    1. Drop every NRT row whose (family, date) is covered by SP: by the SP files
       requested (`sp_coverage`, which includes days SP saw no fire) or, if not
       given, by the SP rows present.
    2. Drop exact duplicates (same satellite, time and position to ~10 m), keeping SP.
    """
    if df.empty:
        return df
    cov = sp_coverage if sp_coverage is not None else set()
    if sp_coverage is None:
        sp = df[df["source_product"] == "SP"]
        cov = set(zip(sp["family"], sp["acq_date"]))
    nrt = df["source_product"] == "NRT"
    covered = pd.Series([(f, d) in cov for f, d in zip(df["family"], df["acq_date"])], index=df.index)
    out = df[~(nrt & covered)].copy()
    out["_rank"] = (out["source_product"] != "SP").astype(int)
    out["_lat"] = out["lat"].round(4)
    out["_lon"] = out["lon"].round(4)
    out = out.sort_values(["_rank", "acq_datetime_utc"], kind="stable").drop_duplicates(["satellite", "acq_datetime_utc", "_lat", "_lon"], keep="first")
    return out.drop(columns=["_rank", "_lat", "_lon"]).sort_values(["acq_datetime_utc", "satellite"], kind="stable").reset_index(drop=True)


def in_bbox(df: pd.DataFrame, bbox: Iterable[float]) -> pd.Series:
    w, s, e, n = bbox
    return (df["lon"] >= w) & (df["lon"] <= e) & (df["lat"] >= s) & (df["lat"] <= n)


# ---------------------------------------------------------------- archive


def scan_archive(archive_dir: Path, regions: list[dict[str, Any]], tol_deg: float = 0.25) -> tuple[dict[str, pd.DataFrame], dict[tuple[str, str], set[date]], list[dict[str, Any]]]:
    """Ingest FIRMS archive CSVs (data/raw/archive/**.csv).

    Returns rows per region, the covered (region, family) -> dates, and a file log.
    A file covers a region when its detections' extent contains the region bbox
    (within `tol_deg`); it covers the dates from its first to its last detection.
    A sidecar `{file}.json` with {"bbox": [W,S,E,N], "start": "...", "end": "..."}
    overrides both (for a download with known extent and dates).
    """
    rows: dict[str, list[pd.DataFrame]] = {r["id"]: [] for r in regions}
    cov: dict[tuple[str, str], set[date]] = {}
    files: list[dict[str, Any]] = []
    if not archive_dir.exists():
        return {}, cov, files
    for f in sorted(archive_dir.rglob("*.csv")):
        raw = pd.read_csv(f, dtype={"acq_time": str, "confidence": str, "satellite": str, "version": str}, low_memory=False)
        df = normalize(raw, name=f.name, src_hash="archive:" + f.name)
        if df.empty:
            continue
        side = f.with_suffix(f.suffix + ".json")
        meta = json.loads(side.read_text(encoding="utf-8")) if side.exists() else {}
        ext = meta.get("bbox") or [df["lon"].min(), df["lat"].min(), df["lon"].max(), df["lat"].max()]
        d0 = date.fromisoformat(meta.get("start") or df["acq_date"].min())
        d1 = date.fromisoformat(meta.get("end") or df["acq_date"].max())
        fams = sorted(df["family"].dropna().unique())
        used = []
        for r in regions:
            w, s, e, n = r["bbox"]
            sub = df[in_bbox(df, r["bbox"])]
            if not sub.empty:
                rows[r["id"]].append(sub)
            contains = ext[0] <= w + tol_deg and ext[1] <= s + tol_deg and ext[2] >= e - tol_deg and ext[3] >= n - tol_deg
            if contains:
                used.append(r["id"])
                for fam in fams:
                    s_ = cov.setdefault((r["id"], fam), set())
                    d = d0
                    while d <= d1:
                        s_.add(d)
                        d += timedelta(days=1)
        files.append({"file": f.name, "families": fams, "rows": int(len(df)), "first": d0.isoformat(), "last": d1.isoformat(), "covers": used})
        log.info("archive %s: %s rows, %s, %s..%s, covers %s", f.name, f"{len(df):,}", "/".join(fams), d0, d1, used or "no region fully")
    return {k: pd.concat(v, ignore_index=True) for k, v in rows.items() if v}, cov, files


# ---------------------------------------------------------------- download


def looks_like_csv(body: str) -> bool:
    head = body.lstrip()[:200].lower()
    return head == "" or head.startswith("latitude")


def probe_day_range(http: Http, key: str, avail: dict[str, dict[str, str]], bbox: list[float], start: int, minimum: int, meta_dir: Path) -> int:
    """Largest DAY_RANGE the area API accepts: start at `start`, step down on error. Probed once."""
    f = meta_dir / "firms_probe.json"
    if f.exists():
        try:
            return int(json.loads(f.read_text(encoding="utf-8"))["day_range"])
        except Exception:
            pass
    sid = next((s for s in ("MODIS_NRT", "VIIRS_NOAA20_NRT", "MODIS_SP") if s in avail), None)
    if sid is None:
        return minimum
    day = date.fromisoformat(avail[sid]["first"])
    for r in range(start, minimum - 1, -1):
        status, body = http.get_text(area_url(key, sid, bbox, r, day))
        if status == 200 and looks_like_csv(body):
            atomic_write(f, json.dumps({"day_range": r, "probed_at": utc_now_iso(), "source": sid}))
            log.info("FIRMS area API accepts DAY_RANGE=%d", r)
            return r
        if status in (401, 403) and "invalid" in body.lower():
            raise FetchError(f"FIRMS rejected the MAP_KEY: {redact(body[:120]).strip()}")
        log.info("DAY_RANGE=%d rejected (HTTP %s: %s)", r, status, redact(body[:80]).strip())
    return minimum


def read_chunk(path: Path, chunk: Chunk) -> pd.DataFrame:
    text = path.read_text(encoding="utf-8")
    if not text.strip():
        return pd.DataFrame(columns=NORMALIZED_COLUMNS)
    raw = pd.read_csv(io.StringIO(text), dtype={"acq_time": str, "confidence": str, "satellite": str, "version": str})
    h = path.with_suffix(".hash")
    return normalize(raw, source=chunk.source, src_hash=h.read_text().strip() if h.exists() else "")


def fetch_chunk(http: Http | None, key: str | None, chunk: Chunk, bbox: list[float], cache_root: Path, today: date, open_days: int) -> tuple[pd.DataFrame, bool]:
    """(normalized rows, downloaded?). A cached chunk never touches the network."""
    path = chunk.cache_path(cache_root)
    if path.exists() and not is_open(chunk, today, open_days):
        return read_chunk(path, chunk), False
    if http is None or key is None:
        raise FetchError(f"{path.name} is not cached and no MAP_KEY is available")
    url = area_url(key, chunk.source, bbox, chunk.days, chunk.start)
    status, body = http.get_text(url)
    if status != 200 or not looks_like_csv(body):
        raise FetchError(f"{chunk.source} {chunk.region} {chunk.start}+{chunk.days}: HTTP {status}: {redact(body[:160]).strip()}")
    atomic_write(path, body)
    atomic_write(path.with_suffix(".hash"), url_hash(url))
    return read_chunk(path, chunk), True


def respect_key_limit(http: Http, key: str, share: float = 0.8, max_wait_s: float = 1200) -> float:
    """Ask FIRMS how many transactions the key used in the current window; pause while above `share`.

    FIRMS may count a multi-day request as several transactions, so the local
    call limiter alone cannot guarantee staying under the key's limit.
    """
    waited = 0.0
    while waited < max_wait_s:
        try:
            st, body = http.get_text(mapkey_status_url(key))
            s = json.loads(body) if st == 200 else {}
            used, limit = float(s.get("current_transactions", 0)), float(s.get("transaction_limit", 0))
        except Exception:
            return waited
        if not limit or used < share * limit:
            return waited
        log.info("MAP_KEY at %.0f/%.0f transactions: pausing 60 s", used, limit)
        http.sleep(60)
        waited += 60
    return waited


# ---------------------------------------------------------------- orchestration


def run(cfg: dict[str, Any], regions: list[dict[str, Any]], key: str | None, http: Http | None, end: date, start_spec: str = "auto", dry_run: bool = False, today: date | None = None) -> dict[str, Any]:
    today = today or datetime.now(timezone.utc).date()
    register_secret(key)
    meta_dir = path_of(cfg, "meta")
    cache_root = path_of(cfg, "firms_cache")
    clean_dir = path_of(cfg, "clean")
    meta_dir.mkdir(parents=True, exist_ok=True)

    if key is None and not dry_run:
        log.warning("FIRMS_MAP_KEY not set (.env): skipping FIRMS. Copy .env.example to .env and add a key from https://firms.modaps.eosdis.nasa.gov/api/map_key/")
        return {"status": "skipped", "reason": "no FIRMS_MAP_KEY"}

    assumed = False
    if key is not None and http is not None:
        avail = fetch_availability(http, key, meta_dir)
        try:
            st, body = http.get_text(mapkey_status_url(key))
            if st == 200:
                s = json.loads(body)
                log.info("MAP_KEY status: %s of %s transactions used in the current %s window", s.get("current_transactions"), s.get("transaction_limit"), s.get("transaction_interval"))
        except Exception:
            pass
    else:
        cached = meta_dir / "availability.json"
        if cached.exists():
            avail = json.loads(cached.read_text(encoding="utf-8"))["sources"]
            log.info("dry run without key: using the cached availability from %s", cached)
        else:
            avail = assumed_availability(today)
            assumed = True
            log.warning("dry run without key: no cached availability, using ASSUMED source dates (estimate only)")

    log.info("data_availability lists: %s", ", ".join(f"{k} {v['first']}..{v['last']}" for k, v in sorted(avail.items())))
    ref = choose_reference(avail, cfg, end)
    families = ["MODIS", ref["family"], *[f for f in cfg.get("extra_families", []) if f not in ("MODIS", ref["family"])]]
    modis = family_span(avail, cfg["sources"]["MODIS"])
    if modis is None:
        raise FetchError("data_availability lists no MODIS source")
    start = modis[0] if start_spec == "auto" else date.fromisoformat(start_spec)

    arch_rows, arch_cov, arch_files = scan_archive(path_of(cfg, "archive"), regions)
    dr = cfg.get("day_range", {})
    if key is not None and http is not None and not dry_run:
        day_range = probe_day_range(http, key, avail, regions[0]["bbox"], int(dr.get("start", 10)), int(dr.get("min", 1)), meta_dir)
    else:
        probe = meta_dir / "firms_probe.json"
        day_range = int(json.loads(probe.read_text())["day_range"]) if probe.exists() else int(dr.get("start", 10))

    plan: list[tuple[Chunk, list[float]]] = []
    gaps: dict[str, dict[str, Any]] = {}
    for r in regions:
        for fam in families:
            fs = cfg["sources"][fam]
            span = family_span(avail, fs)
            if span is None:
                continue
            f0 = max(start, span[0])
            chunks, g = plan_family(r["id"], fam, fs, avail, f0, end, day_range, arch_cov.get((r["id"], fam)))
            plan += [(c, r["bbox"]) for c in chunks]
            if g:
                gaps[f"{r['id']}:{fam}"] = {"days": len(g), "first": g[0].isoformat(), "last": g[-1].isoformat()}

    todo = [(c, b) for c, b in plan if not c.cache_path(cache_root).exists() or is_open(c, today, int(cfg.get("open_chunk_days", 3)))]
    by_src: dict[str, int] = {}
    for c, _ in todo:
        by_src[c.source] = by_src.get(c.source, 0) + 1
    rl = cfg.get("rate_limit", {})
    minutes = len(todo) / max(1, rl.get("max_calls", 1000)) * rl.get("per_seconds", 600) / 60
    log.info("plan: %d chunks (DAY_RANGE %d) for %d regions x %s; %d cached, %d to download (%s); >= %.0f min at the rate limit", len(plan), day_range, len(regions), "+".join(families), len(plan) - len(todo), len(todo), ", ".join(f"{k} {v}" for k, v in sorted(by_src.items())) or "none", minutes)
    if gaps:
        log.warning("dates no source covers: %s", "; ".join(f"{k} {v['days']} d ({v['first']}..{v['last']})" for k, v in gaps.items()))
    summary: dict[str, Any] = {
        "status": "dry-run" if dry_run else "ok",
        "assumed_availability": assumed,
        "reference": ref,
        "viirs_start": ref["viirs_start"],
        "families": families,
        "day_range": day_range,
        "start": start.isoformat(),
        "end": end.isoformat(),
        "planned_chunks": len(plan),
        "to_download": len(todo),
        "to_download_by_source": by_src,
        "gaps": gaps,
        "archive_files": arch_files,
    }
    if dry_run:
        print(json.dumps({k: v for k, v in summary.items() if k != "archive_files"}, indent=1))
        return summary

    per_region: dict[str, list[pd.DataFrame]] = {r["id"]: [] for r in regions}
    sp_cov: dict[str, set[tuple[str, str]]] = {r["id"]: set() for r in regions}
    used: dict[str, list[str]] = {}
    downloaded = failed = 0
    errors: list[str] = []
    for c, bbox in progress(plan, total=len(plan), desc="FIRMS"):
        try:
            df, new = fetch_chunk(http, key, c, bbox, cache_root, today, int(cfg.get("open_chunk_days", 3)))
        except FetchError as e:
            failed += 1
            errors.append(str(e))
            log.error("%s", e)
            continue
        downloaded += int(new)
        if new and downloaded % 200 == 0 and http is not None and key is not None:
            respect_key_limit(http, key)
        if not df.empty:
            per_region[c.region].append(df[in_bbox(df, bbox)])
        if c.product == "SP":
            sp_cov[c.region].update((c.family, d.isoformat()) for d in c.dates())
        u = used.setdefault(c.source, [c.start.isoformat(), c.end.isoformat()])
        u[0], u[1] = min(u[0], c.start.isoformat()), max(u[1], c.end.isoformat())

    clean_dir.mkdir(parents=True, exist_ok=True)
    rows_out = {}
    for r in regions:
        parts = per_region[r["id"]]
        if r["id"] in arch_rows:
            parts.append(arch_rows[r["id"]])
            for (rid, fam), ds in arch_cov.items():
                if rid == r["id"]:
                    sp_cov[rid].update((fam, d.isoformat()) for d in ds)
        df = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame(columns=NORMALIZED_COLUMNS)
        if not df.empty:
            sp_rows = df[df["source_product"] == "SP"]
            df = dedup_sp_over_nrt(df, sp_cov[r["id"]] | set(zip(sp_rows["family"], sp_rows["acq_date"])))
        df.to_parquet(clean_dir / f"firms_{r['id']}.parquet", index=False)
        rows_out[r["id"]] = int(len(df))
        log.info("%s: %s normalized detections", r["id"], f"{len(df):,}")

    summary.update({"downloaded": downloaded, "failed": failed, "errors": errors[:20], "rows": rows_out, "sources_used": {k: {"first": v[0], "last": v[1]} for k, v in sorted(used.items())}, "fetched_at": utc_now_iso()})
    if failed:
        summary["status"] = "partial"
        log.warning("%d chunks failed; re-run `make fetch` to retry them (everything else is cached)", failed)
    atomic_write(meta_dir / "firms_run.json", json.dumps(summary, indent=1, default=str))
    return summary


def chunk_dict(c: Chunk) -> dict[str, Any]:
    d = asdict(c)
    d["start"] = c.start.isoformat()
    return d
