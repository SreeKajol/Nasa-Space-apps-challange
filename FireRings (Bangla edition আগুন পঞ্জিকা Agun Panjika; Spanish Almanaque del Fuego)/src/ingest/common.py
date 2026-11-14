"""Shared pieces of the real-data ingest: config, secrets, HTTP client, cache.

Rules every downloader follows:
  * one shared `requests.Session`, a timeout on every call, exponential backoff
    on 429 / 5xx (and on FIRMS's "transaction limit" answer);
  * a sliding-window rate limiter (FIRMS allows 5,000 transactions / 10 min;
    the default here is far below);
  * a resumable on-disk cache: a cached file is never downloaded again;
  * the FIRMS MAP_KEY is read from .env and never logged, written or hashed
    in clear: every URL that leaves this module goes through `redact`.
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
import sys
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = ROOT / "config" / "real_data.yaml"

log = logging.getLogger("firerings.ingest")


def setup_logging(verbose: bool = False) -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except Exception:
            pass
    logging.basicConfig(level=logging.DEBUG if verbose else logging.INFO, format="%(asctime)s %(levelname)-7s %(message)s", datefmt="%H:%M:%S")
    # requests/urllib3 log full URLs (with the key) at DEBUG: keep them quiet.
    logging.getLogger("urllib3").setLevel(logging.WARNING)


# ---------------------------------------------------------------- config


def load_config(path: Path | str | None = None) -> dict[str, Any]:
    import yaml

    p = Path(path) if path else DEFAULT_CONFIG
    cfg = yaml.safe_load(p.read_text(encoding="utf-8"))
    cfg["_path"] = str(p)
    return cfg


def enabled_regions(cfg: dict[str, Any], only: list[str] | None = None) -> list[dict[str, Any]]:
    regs = [r for r in cfg["regions"] if r.get("enabled", True) or (only and r["id"] in only)]
    return [r for r in regs if not only or r["id"] in only]


def path_of(cfg: dict[str, Any], key: str) -> Path:
    p = Path(cfg["paths"][key])
    return p if p.is_absolute() else ROOT / p


def run_dates(cfg: dict[str, Any], today: date | None = None) -> tuple[str, date]:
    """(start spec, end date). start may be 'auto' (resolved from availability)."""
    dr = cfg.get("date_range", {})
    end_s = str(dr.get("end", "today"))
    today = today or datetime.now(timezone.utc).date()
    end = today if end_s == "today" else date.fromisoformat(end_s)
    return str(dr.get("start", "auto")), min(end, today)


# ---------------------------------------------------------------- secrets


def firms_key() -> str | None:
    """FIRMS_MAP_KEY from the environment or .env (python-dotenv). None when absent."""
    try:
        from dotenv import load_dotenv

        load_dotenv(ROOT / ".env", override=False)
    except ImportError:  # pragma: no cover - dotenv is in requirements-ingest.txt
        pass
    k = (os.environ.get("FIRMS_MAP_KEY") or "").strip()
    return k or None


_SECRETS: set[str] = set()


def register_secret(s: str | None) -> None:
    if s:
        _SECRETS.add(s)


def redact(text: str) -> str:
    """Remove every registered secret (the MAP_KEY) from a string."""
    for s in _SECRETS:
        text = text.replace(s, "{MAP_KEY}")
    return text


def url_hash(url: str) -> str:
    """Stable short hash of a request URL, computed on the REDACTED url."""
    return hashlib.sha256(redact(url).encode()).hexdigest()[:16]


# ---------------------------------------------------------------- rate limiter


@dataclass
class RateLimiter:
    """Sliding window: at most `max_calls` calls in any `per_seconds` window."""

    max_calls: int
    per_seconds: float
    clock: Callable[[], float] = time.monotonic
    sleep: Callable[[float], None] = time.sleep
    _calls: deque = field(default_factory=deque)

    def wait(self) -> float:
        now = self.clock()
        while self._calls and now - self._calls[0] >= self.per_seconds:
            self._calls.popleft()
        waited = 0.0
        if len(self._calls) >= self.max_calls:
            waited = self.per_seconds - (now - self._calls[0]) + 0.01
            log.info("rate limit: %d calls in the last %.0f s, waiting %.0f s", len(self._calls), self.per_seconds, waited)
            self.sleep(waited)
            now = self.clock()
            while self._calls and now - self._calls[0] >= self.per_seconds:
                self._calls.popleft()
        self._calls.append(now)
        return waited


# ---------------------------------------------------------------- HTTP client


class FetchError(RuntimeError):
    pass


RETRY_STATUS = {429, 500, 502, 503, 504}
_LIMIT_TEXT = re.compile(r"transaction limit|too many requests", re.I)


class Http:
    """requests.Session wrapper: timeout, retries with exponential backoff, rate limiter, redaction."""

    def __init__(self, timeout: float = 60, retries: int = 6, backoff: float = 2.0, limiter: RateLimiter | None = None, session: Any = None, sleep: Callable[[float], None] = time.sleep):
        if session is None:
            import requests

            session = requests.Session()
            session.headers["User-Agent"] = "FireRings/1.0 (NASA Space Apps 2026; open source)"
        self.session = session
        self.timeout = timeout
        self.retries = retries
        self.backoff = backoff
        self.limiter = limiter
        self.sleep = sleep
        self.calls = 0

    def get_text(self, url: str, params: dict[str, Any] | None = None) -> tuple[int, str]:
        """GET with retries. Returns (status, body) for any final status; raises FetchError on network failure."""
        last: Exception | None = None
        for attempt in range(self.retries + 1):
            if self.limiter:
                self.limiter.wait()
            self.calls += 1
            try:
                r = self.session.get(url, params=params, timeout=self.timeout)
                status, body = r.status_code, r.text
            except Exception as e:  # network error, timeout
                last = e
                status, body = -1, ""
            retry = status in RETRY_STATUS or status == -1 or (status in (200, 403) and bool(_LIMIT_TEXT.search(body[:300])))
            if not retry:
                return status, body
            if attempt < self.retries:
                delay = self.backoff * (2**attempt)
                log.warning("HTTP %s from %s (attempt %d/%d), retrying in %.0f s", status if status > 0 else type(last).__name__, redact(url), attempt + 1, self.retries + 1, delay)
                self.sleep(delay)
        if status > 0:
            return status, body
        raise FetchError(f"network error for {redact(url)}: {redact(str(last))}")


def http_from_config(cfg: dict[str, Any]) -> Http:
    h, rl = cfg.get("http", {}), cfg.get("rate_limit", {})
    return Http(timeout=h.get("timeout_s", 60), retries=h.get("retries", 6), backoff=h.get("backoff_s", 2.0), limiter=RateLimiter(rl.get("max_calls", 1000), rl.get("per_seconds", 600)))


# ---------------------------------------------------------------- small helpers


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".part")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def progress(iterable: Any, total: int | None = None, desc: str = "") -> Any:
    try:
        from tqdm import tqdm

        return tqdm(iterable, total=total, desc=desc, unit="call", dynamic_ncols=True)
    except ImportError:  # pragma: no cover
        return iterable
