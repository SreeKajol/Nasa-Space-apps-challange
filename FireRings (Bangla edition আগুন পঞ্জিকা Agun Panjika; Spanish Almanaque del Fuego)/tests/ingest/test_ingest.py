"""Real-data ingest: URLs, chunking, normalization, dedup, cache, POWER, EONET.

No test touches the network: every HTTP call goes through a fake session.
"""

from __future__ import annotations

import json
import math
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import pytest

from src.ingest import eonet, firms, power
from src.ingest.common import FetchError, Http, RateLimiter, redact, register_secret, url_hash

KEY = "abcdef0123456789abcdef0123456789"


class FakeResp:
    def __init__(self, status: int, text: str):
        self.status_code = status
        self.text = text


class FakeSession:
    """Answers from a queue; records every URL; fails the test if called unexpectedly."""

    def __init__(self, answers: list[tuple[int, str]] | None = None, forbid: bool = False):
        self.answers = list(answers or [])
        self.urls: list[str] = []
        self.forbid = forbid

    def get(self, url, params=None, timeout=None):
        if self.forbid:
            raise AssertionError(f"unexpected network call: {url}")
        self.urls.append(url if not params else f"{url}?{params}")
        return FakeResp(*self.answers.pop(0))


def http(session) -> Http:
    return Http(timeout=1, retries=3, backoff=0.0, session=session, sleep=lambda s: None)


# ---------------------------------------------------------------- URLs and secrets


def test_area_url_matches_firms_layout():
    u = firms.area_url(KEY, "MODIS_SP", [88.95, 21.6, 89.95, 22.5], 10, date(2020, 3, 1))
    assert u == f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{KEY}/MODIS_SP/88.95,21.6,89.95,22.5/10/2020-03-01"
    assert firms.area_url(KEY, "VIIRS_NOAA20_NRT", [-60.9, -34.3, -58.4, -32.0], 1, date(2026, 11, 1)).endswith("/VIIRS_NOAA20_NRT/-60.9,-34.3,-58.4,-32/1/2026-11-01")
    with pytest.raises(ValueError):
        firms.area_url(KEY, "MODIS_SP", [89.95, 21.6, 88.95, 22.5], 10, date(2020, 3, 1))  # W > E
    assert firms.availability_url(KEY).endswith(f"/api/data_availability/csv/{KEY}/all")


def test_key_is_redacted_everywhere():
    register_secret(KEY)
    u = firms.area_url(KEY, "MODIS_SP", [1, 2, 3, 4], 5, date(2020, 1, 1))
    assert KEY not in redact(u) and "{MAP_KEY}" in redact(u)
    assert url_hash(u) == url_hash(redact(u))  # the hash is of the redacted URL: it never depends on the key


# ---------------------------------------------------------------- availability and reference satellite

AVAIL_CSV = """data_id,min_date,max_date
MODIS_NRT,2026-08-01,2026-11-13
MODIS_SP,2000-11-01,2026-07-31
VIIRS_NOAA20_NRT,2026-05-01,2026-11-13
VIIRS_NOAA20_SP,2018-04-01,2026-04-30
VIIRS_NOAA21_NRT,2024-01-17,2026-11-13
VIIRS_SNPP_NRT,2026-05-01,2026-10-31
VIIRS_SNPP_SP,2012-01-20,2026-04-30
"""
CFG = {
    "sources": {
        "MODIS": {"sp": "MODIS_SP", "nrt": "MODIS_NRT"},
        "VIIRS_SNPP": {"sp": "VIIRS_SNPP_SP", "nrt": "VIIRS_SNPP_NRT"},
        "VIIRS_NOAA20": {"sp": "VIIRS_NOAA20_SP", "nrt": "VIIRS_NOAA20_NRT"},
        "VIIRS_NOAA21": {"sp": "VIIRS_NOAA21_SP", "nrt": "VIIRS_NOAA21_NRT"},
    },
    "viirs_reference": ["VIIRS_SNPP", "VIIRS_NOAA20"],
    "reference_tolerance_days": 7,
}


def test_parse_availability_and_snpp_end_switches_to_noaa20():
    av = firms.parse_availability(AVAIL_CSV)
    assert av["MODIS_SP"] == {"first": "2000-11-01", "last": "2026-07-31"}
    ref = firms.choose_reference(av, CFG, date(2026, 11, 14))
    assert ref["family"] == "VIIRS_NOAA20"
    assert ref["viirs_start"] == "2018-04"  # first full NOAA-20 month in this availability
    assert "partial" in ref["skipped"][0]
    # Before Suomi-NPP stopped, it stays the reference with its own start month.
    ref2 = firms.choose_reference(av, CFG, date(2026, 10, 30))
    assert ref2["family"] == "VIIRS_SNPP" and ref2["viirs_start"] == "2012-02"
    # Missing entirely -> NOAA-20; 2018-01-01 start -> "2018-01".
    av3 = {k: v for k, v in av.items() if not k.startswith("VIIRS_SNPP")}
    av3["VIIRS_NOAA20_SP"] = {"first": "2018-01-01", "last": "2026-04-30"}
    assert firms.choose_reference(av3, CFG, date(2026, 11, 14))["viirs_start"] == "2018-01"


# ---------------------------------------------------------------- chunking


@pytest.mark.parametrize("day_range", [1, 3, 7, 10])
def test_chunking_covers_every_date_exactly_once(day_range):
    av = firms.parse_availability(AVAIL_CSV)
    start, end = date(2026, 6, 20), date(2026, 11, 14)
    archive = {date(2026, 7, 1) + timedelta(days=i) for i in range(5)}
    chunks, gaps = firms.plan_family("r", "MODIS", CFG["sources"]["MODIS"], av, start, end, day_range, archive)
    seen: list[date] = [d for c in chunks for d in c.dates()]
    assert len(seen) == len(set(seen)), "a date is requested twice"
    expected = {start + timedelta(days=i) for i in range((end - start).days + 1)} - archive - set(gaps)
    assert set(seen) == expected
    assert gaps == [date(2026, 11, 14)]  # MODIS_NRT ends on 11-13 here
    assert all(1 <= c.days <= day_range for c in chunks)
    # SP until its last date, NRT after; never mixed inside one chunk.
    for c in chunks:
        want = "MODIS_SP" if c.end <= date(2026, 7, 31) else "MODIS_NRT"
        assert c.source == want
    # Boundaries are epoch-aligned: a later end date reuses every earlier chunk but the last.
    later, _ = firms.plan_family("r", "MODIS", CFG["sources"]["MODIS"], av, start, end + timedelta(days=20), day_range, archive)
    assert set(chunks[:-1]) <= set(later)


def test_open_nrt_chunks_are_refetched_sp_never():
    today = date(2026, 11, 14)
    assert firms.is_open(firms.Chunk("MODIS_NRT", "MODIS", "NRT", "r", date(2026, 11, 10), 5), today, 3)
    assert not firms.is_open(firms.Chunk("MODIS_NRT", "MODIS", "NRT", "r", date(2026, 10, 1), 5), today, 3)
    assert not firms.is_open(firms.Chunk("MODIS_SP", "MODIS", "SP", "r", date(2026, 11, 10), 5), today, 3)


# ---------------------------------------------------------------- normalization

MODIS_CSV = """latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_t31,frp,daynight,type
22.1,89.4,320.1,1.2,1.1,2020-03-05,435,T,MODIS,72,6.03,295.2,12.5,D,0
22.2,89.5,330.0,2.4,1.5,2020-03-05,1720,Aqua,MODIS,15,6.03,290.0,30.1,N,2
"""
VIIRS_CSV = """latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight
-33.1,-59.2,330.5,0.4,0.36,2026-11-02,1754,N20,VIIRS,n,2.0NRT,290.1,3.2,D
-33.2,-59.3,340.5,0.5,0.40,2026-11-02,0517,N21,VIIRS,h,2.0NRT,280.1,8.0,N
-33.3,-59.4,300.0,0.5,0.40,2026-11-03,0517,N,VIIRS,l,2.0NRT,280.1,1.0,N
"""


def test_normalize_modis_and_viirs():
    import io

    m = firms.normalize(pd.read_csv(io.StringIO(MODIS_CSV), dtype={"acq_time": str, "confidence": str}), source="MODIS_SP", src_hash="h")
    assert list(m["satellite"]) == ["Terra", "Aqua"]
    assert list(m["acq_datetime_utc"]) == ["2020-03-05T04:35:00Z", "2020-03-05T17:20:00Z"]
    assert list(m["confidence"]) == ["72", "15"] and list(m["confidence_level"]) == ["nominal", "low"]
    assert list(m["source_product"]) == ["SP", "SP"] and list(m["type"]) == [0, 2]
    assert set(firms.NORMALIZED_COLUMNS) == set(m.columns)
    v = firms.normalize(pd.read_csv(io.StringIO(VIIRS_CSV), dtype={"acq_time": str, "confidence": str}), name="fire_nrt_J1V-C2_1.csv")
    assert list(v["satellite"]) == ["NOAA-20", "NOAA-21", "S-NPP"]
    assert list(v["sensor"]) == ["VIIRS"] * 3 and list(v["source_product"]) == ["NRT"] * 3
    assert v["type"].isna().all()  # NRT VIIRS has no type column


@pytest.mark.parametrize("raw,level", [("l", "low"), ("n", "nominal"), ("h", "high"), ("N", "nominal"), ("x", None)])
def test_viirs_confidence_mapping(raw, level):
    assert firms.confidence_level("VIIRS", raw) == level


@pytest.mark.parametrize("raw,level", [("0", "low"), ("29", "low"), ("30", "nominal"), ("79", "nominal"), ("80", "high"), ("100", "high")])
def test_modis_confidence_bands(raw, level):
    assert firms.confidence_level("MODIS", raw) == level


def test_detect_family_from_names_and_columns():
    assert firms.detect_family([], "fire_archive_M-C61_123.csv") == "MODIS"
    assert firms.detect_family([], "fire_archive_SV-C2_123.csv") == "VIIRS_SNPP"
    assert firms.detect_family([], "fire_archive_J1V-C2_123.csv") == "VIIRS_NOAA20"
    assert firms.detect_family([], "fire_nrt_J2V-C2_9.csv") == "VIIRS_NOAA21"
    assert firms.detect_family(["latitude", "bright_ti4"], "x.csv") == "VIIRS"
    assert firms.detect_family(["brightness"], "x.csv") == "MODIS"


# ---------------------------------------------------------------- SP over NRT


def _row(sat, day, hhmm, lat, lon, prod):
    fam = firms.SATELLITE_FAMILY[sat]
    return {"sensor": "MODIS" if fam == "MODIS" else "VIIRS", "satellite": sat, "family": fam, "acq_datetime_utc": f"{day}T{hhmm[:2]}:{hhmm[2:]}:00Z", "acq_date": day, "lat": lat, "lon": lon, "confidence": "n", "confidence_level": "nominal", "frp": 1.0, "scan": 1, "track": 1, "daynight": "D", "type": pd.NA, "version": "", "source_product": prod, "source_url_hash": ""}


def test_sp_replaces_nrt():
    rows = [
        _row("NOAA-20", "2026-05-01", "1754", -33.1, -59.2, "SP"),
        _row("NOAA-20", "2026-05-01", "1754", -33.1, -59.2, "NRT"),  # exact duplicate of the SP row
        _row("NOAA-20", "2026-05-01", "1755", -33.10004, -59.2, "NRT"),  # NRT geolocation differs slightly: same day covered by SP
        _row("NOAA-20", "2026-05-02", "0517", -33.2, -59.3, "NRT"),  # SP covers the day but saw nothing -> dropped
        _row("NOAA-20", "2026-11-02", "0517", -33.2, -59.3, "NRT"),  # recent, SP not available -> kept
        _row("Terra", "2026-05-01", "0435", 22.1, 89.4, "NRT"),  # other family: SP coverage does not apply
    ]
    df = pd.DataFrame(rows)
    cov = {("VIIRS_NOAA20", "2026-05-01"), ("VIIRS_NOAA20", "2026-05-02")}
    out = firms.dedup_sp_over_nrt(df, cov)
    assert len(out) == 3
    assert list(out["source_product"]) == ["NRT", "SP", "NRT"]
    assert set(out["acq_date"]) == {"2026-05-01", "2026-11-02"}
    # Without explicit coverage, SP rows define it (exact duplicate and same-day NRT go).
    out2 = firms.dedup_sp_over_nrt(df)
    assert len(out2) == 4


# ---------------------------------------------------------------- cache


def test_cache_hit_makes_no_network_call(tmp_path):
    c = firms.Chunk("MODIS_SP", "MODIS", "SP", "sundarbans", date(2020, 3, 1), 10)
    sess = FakeSession([(200, MODIS_CSV)])
    df, new = firms.fetch_chunk(http(sess), KEY, c, [88.95, 21.6, 89.95, 22.5], tmp_path, date(2026, 11, 14), 3)
    assert new and len(df) == 2 and len(sess.urls) == 1
    assert c.cache_path(tmp_path).exists()
    assert KEY not in c.cache_path(tmp_path).read_text() + c.cache_path(tmp_path).with_suffix(".hash").read_text()
    df2, new2 = firms.fetch_chunk(http(FakeSession(forbid=True)), KEY, c, [88.95, 21.6, 89.95, 22.5], tmp_path, date(2026, 11, 14), 3)
    assert not new2 and df2.equals(df)
    # Even with no key at all, a cached chunk is served.
    df3, _ = firms.fetch_chunk(None, None, c, [88.95, 21.6, 89.95, 22.5], tmp_path, date(2026, 11, 14), 3)
    assert len(df3) == 2


def test_error_bodies_are_never_cached(tmp_path):
    c = firms.Chunk("MODIS_SP", "MODIS", "SP", "r", date(2020, 3, 1), 10)
    with pytest.raises(FetchError):
        firms.fetch_chunk(http(FakeSession([(400, "Invalid day range")])), KEY, c, [1, 2, 3, 4], tmp_path, date(2026, 11, 14), 3)
    assert not c.cache_path(tmp_path).exists()


def test_retries_with_backoff_on_429_and_5xx():
    sleeps = []
    h = Http(timeout=1, retries=3, backoff=2.0, session=FakeSession([(429, ""), (503, ""), (200, "latitude,longitude\n")]), sleep=sleeps.append)
    assert h.get_text("https://x/y") == (200, "latitude,longitude\n")
    assert sleeps == [2.0, 4.0]


def test_rate_limiter_window():
    t = [0.0]
    slept = []

    def sleep(s):
        slept.append(s)
        t[0] += s

    rl = RateLimiter(3, 10.0, clock=lambda: t[0], sleep=sleep)
    for _ in range(3):
        rl.wait()
    assert slept == []
    rl.wait()  # 4th call inside the window must wait ~10 s
    assert len(slept) == 1 and 9.9 < slept[0] < 10.1


# ---------------------------------------------------------------- POWER


def _power_doc():
    return {
        "header": {"fill_value": -999.0},
        "parameters": {"T2M": {"units": "C"}, "PRECTOTCORR": {"units": "mm/day"}, "RH2M": {"units": "%"}},
        "properties": {"parameter": {
            "T2M": {"202401": 20.0, "202402": -999.0, "202413": 25.0},
            "PRECTOTCORR": {"202401": 2.0, "202402": 1.0, "202413": 3.0},
            "RH2M": {"202401": 70.0, "202402": 71.0, "202413": 72.0},
        }},
    }


def test_power_fill_value_is_nan_and_annual_dropped():
    rows = power.parse_monthly(_power_doc())
    assert [r["ym"] for r in rows] == ["2024-01", "2024-02"]  # month 13 dropped
    assert math.isnan(rows[1]["t2m_c"])  # -999 -> NaN
    assert rows[0]["precip_mm"] == pytest.approx(62.0)  # 2 mm/day x 31 days
    ctx = power.to_context(rows)
    assert ctx == [{"ym": "2024-01", "t2m_c": 20.0, "precip_mm": 62.0, "rh_pct": 70}]  # incomplete month omitted


def test_power_rejects_unknown_units():
    d = _power_doc()
    d["parameters"]["PRECTOTCORR"]["units"] = "kg m-2 s-1"
    with pytest.raises(ValueError):
        power.parse_monthly(d)


def test_power_params():
    p = power.power_params(22.05, 89.45, 2000, 2026, ["T2M", "PRECTOTCORR", "RH2M"])
    assert p["parameters"] == "T2M,PRECTOTCORR,RH2M" and p["community"] == "AG" and p["format"] == "JSON"
    assert (p["latitude"], p["longitude"], p["start"], p["end"]) == (22.05, 89.45, 2000, 2026)


# ---------------------------------------------------------------- EONET


def test_eonet_bbox_order_is_minlon_maxlat_maxlon_minlat():
    assert eonet.bbox_param([-60.9, -34.3, -58.4, -32.0]) == "-60.9,-32.0,-58.4,-34.3"
    assert eonet.eonet_params([88.95, 21.6, 89.95, 22.5], "2001-01-01", "2026-11-14")["bbox"] == "88.95,22.5,89.95,21.6"


def _doc():
    return {"events": [
        {"id": "E1", "title": "Fire A", "geometry": [{"date": "2020-08-03T00:00:00Z", "type": "Point", "coordinates": [-59.5, -33.0]}], "sources": [{"id": "IRWIN"}]},
        {"id": "E2", "title": "Fire B", "geometry": [{"date": "2020-09-10T00:00:00Z", "type": "Point", "coordinates": [-59.0, -32.5]}]},
        {"id": "E3", "title": "Outside", "geometry": [{"date": "2020-08-03T00:00:00Z", "type": "Point", "coordinates": [10.0, 10.0]}]},
        {"id": "E4", "title": "Fire C", "geometry": [{"date": "2021-01-03T00:00:00Z", "type": "Point", "coordinates": [-59.0, -32.5]}]},
    ]}


def test_eonet_events_and_hit_rate():
    bbox = [-60.9, -34.3, -58.4, -32.0]
    ev = eonet.events_in(_doc(), bbox)
    assert [e["id"] for e in ev] == ["E1", "E2", "E4"]
    monthly = [{"ym": "2020-08", "percentile": 95}, {"ym": "2020-09", "percentile": 80}, {"ym": "2021-01", "percentile": 40}, {"ym": "2021-02", "percentile": 10}]
    res = eonet.validate(ev, monthly, 3)
    assert (res["matched"], res["total"], res["hit_rate"], res["status"]) == (2, 3, 0.667, "ok")
    assert res["months_flagged"] == ["2020-08", "2020-09"]


def test_eonet_too_few_events_gives_no_hit_rate():
    ev = eonet.events_in(_doc(), [-60.9, -34.3, -58.4, -32.0])[:2]
    res = eonet.validate(ev, [{"ym": "2020-08", "percentile": 95}, {"ym": "2020-09", "percentile": 95}], 3)
    assert res["status"] == "insufficient events" and res["hit_rate"] is None and res["matched"] == 2


# ---------------------------------------------------------------- full FIRMS run against a fake server


class FirmsRouter:
    """Fake FIRMS: availability, key status, and area requests (rejects DAY_RANGE > 5)."""

    def __init__(self):
        self.area_calls: list[str] = []

    def get(self, url, params=None, timeout=None):
        if "/data_availability/" in url:
            return FakeResp(200, AVAIL_CSV)
        if "mapkey_status" in url:
            return FakeResp(200, json.dumps({"transaction_limit": 5000, "current_transactions": 10, "transaction_interval": "10 minutes"}))
        parts = url.split("/")
        source, day_range, day = parts[-4], int(parts[-2]), parts[-1]
        if day_range > 5:
            return FakeResp(400, "Invalid day range. Expects [1..5].")
        self.area_calls.append(url)
        if source.startswith("MODIS"):
            body = "latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_t31,frp,daynight\n"
            body += f"22.1,89.4,320,1.2,1.1,{day},0435,T,MODIS,72,{'6.1NRT' if source.endswith('NRT') else '6.1'},295,12.5,D\n"
        else:
            body = "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight\n"
            body += f"22.1,89.4,330,0.4,0.4,{day},1754,N20,VIIRS,n,2.0,290,3.2,D\n"
        return FakeResp(200, body)


def test_firms_run_end_to_end_with_fake_server(tmp_path):
    paths = {k: str(tmp_path / k) for k in ("firms_cache", "archive", "power", "eonet", "clean", "stage", "products", "meta")}
    cfg = {**CFG, "paths": paths, "day_range": {"start": 10, "min": 1}, "open_chunk_days": 3, "rate_limit": {"max_calls": 1000, "per_seconds": 600}, "extra_families": []}
    regions = [{"id": "sb", "bbox": [88.95, 21.6, 89.95, 22.5]}]
    router = FirmsRouter()
    res = firms.run(cfg, regions, KEY, http(router), date(2026, 11, 14), "2026-07-20", today=date(2026, 11, 14))
    assert res["status"] == "ok" and res["day_range"] == 5  # probed: 10..6 rejected
    assert res["reference"]["family"] == "VIIRS_NOAA20"
    df = pd.read_parquet(tmp_path / "clean" / "firms_sb.parquet")
    assert set(df["family"]) == {"MODIS", "VIIRS_NOAA20"}
    m = df[df["family"] == "MODIS"]
    assert set(m.loc[m["acq_date"] <= "2026-07-31", "source_product"]) == {"SP"}  # MODIS_SP while it is listed
    assert set(m.loc[m["acq_date"] >= "2026-08-01", "source_product"]) == {"NRT"}
    assert set(df.loc[df["family"] == "VIIRS_NOAA20", "source_product"]) == {"NRT"}  # NOAA-20 SP ends 2026-04-30 here
    assert res["sources_used"]["MODIS_SP"]["first"] == "2026-07-20"
    # The key is nowhere on disk.
    for f in tmp_path.rglob("*"):
        if f.is_file() and f.suffix in (".json", ".csv", ".hash"):
            assert KEY not in f.read_text(encoding="utf-8", errors="ignore"), f
    # Second run: only still-open NRT chunks are downloaded again.
    n1 = len(router.area_calls)
    firms.run(cfg, regions, KEY, http(router), date(2026, 11, 14), "2026-07-20", today=date(2026, 11, 14))
    again = router.area_calls[n1:]
    assert again and all("_NRT/" in u for u in again)
    assert len(again) <= 4  # MODIS + NOAA-20 open chunks only


def test_no_key_skips_firms_without_error(tmp_path):
    cfg = {**CFG, "paths": {k: str(tmp_path / k) for k in ("firms_cache", "archive", "clean", "meta")}}
    assert firms.run(cfg, [{"id": "x", "bbox": [0, 0, 1, 1]}], None, None, date(2026, 11, 14))["status"] == "skipped"


def test_respect_key_limit_pauses_until_below_share():
    answers = [(200, json.dumps({"transaction_limit": 100, "current_transactions": n})) for n in (95, 90, 10)]
    sleeps = []
    h = Http(timeout=1, retries=0, backoff=0, session=FakeSession(answers), sleep=sleeps.append)
    assert firms.respect_key_limit(h, KEY) == 120 and sleeps == [60, 60]
