"""python -m src.compute.pipeline [--config FILE] [--now YYYY-MM-DD]"""

from __future__ import annotations

import argparse
import sys
from datetime import date

from src.ingest.common import load_config, setup_logging

from .build import PipelineError, build


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m src.compute.pipeline")
    ap.add_argument("--config", default=None)
    ap.add_argument("--now", default=None, help="UTC date for the partial-month rule (default: today)")
    a = ap.parse_args(argv)
    setup_logging()
    try:
        build(load_config(a.config), date.fromisoformat(a.now) if a.now else None)
    except PipelineError as e:
        print(f"pipeline stopped: {e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
