"""CLI: python -m src.ingest {fetch,validate-eonet} [options]

    fetch            FIRMS + POWER + EONET into the on-disk caches (re-runs download nothing new)
      --only firms,power,eonet
      --dry-run      print the planned number of FIRMS calls and exit
      --regions a,b  subset of config regions (also enables a disabled one)
    validate-eonet   compare cached EONET events with data-products/region/*.json
"""

from __future__ import annotations

import argparse
import json
import sys

from . import eonet, firms, power
from .common import enabled_regions, firms_key, http_from_config, load_config, path_of, run_dates, setup_logging


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m src.ingest")
    ap.add_argument("cmd", choices=["fetch", "validate-eonet"])
    ap.add_argument("--config", default=None)
    ap.add_argument("--only", default="firms,power,eonet")
    ap.add_argument("--regions", default=None)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args(argv)
    setup_logging(a.verbose)
    cfg = load_config(a.config)
    regions = enabled_regions(cfg, a.regions.split(",") if a.regions else None)
    if a.cmd == "validate-eonet":
        print(json.dumps(eonet.run_validate(cfg, regions, path_of(cfg, "products")), indent=1))
        return 0

    only = set(a.only.split(","))
    start_spec, end = run_dates(cfg)
    http = http_from_config(cfg)
    status = {}
    first_year = int(start_spec[:4]) if start_spec != "auto" else 2000
    if "firms" in only:
        key = firms_key()
        try:
            res = firms.run(cfg, regions, key, http if key else None, end, start_spec, dry_run=a.dry_run)
        except firms.FetchError as e:
            print(f"FIRMS failed: {e}", file=sys.stderr)
            res = {"status": "failed", "reason": str(e)}
        status["firms"] = {k: res.get(k) for k in ("status", "reason", "to_download", "downloaded", "failed") if k in res}
        if res.get("start"):
            first_year = int(res["start"][:4])
    if a.dry_run:
        return 0
    if "power" in only:
        status["power"] = {k: v["status"] for k, v in power.run(cfg, regions, http, first_year, end.year)["regions"].items()}
    if "eonet" in only:
        status["eonet"] = eonet.run_fetch(cfg, regions, http, f"{first_year}-01-01", end.isoformat())["regions"]
    print(json.dumps(status, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
