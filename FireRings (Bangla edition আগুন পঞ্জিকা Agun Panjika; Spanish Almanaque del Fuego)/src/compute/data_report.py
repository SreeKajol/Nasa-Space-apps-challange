"""Auto-generated sanity report of a real-data run.

    python -m src.compute.data_report [--data data-products] [--docs docs]

Writes docs/data_report.md and docs/figures/{region}_series.png:
  * sources actually used, with first/last dates and access dates;
  * rows per source family per year (before and after cleaning), share filtered;
  * regions with gaps or missing data;
  * per region: validation (test years), seam test, EONET result;
  * the ML layer's numbers from this run (if data-products/ml/ exists).
When the ML outputs come from real data, the same tables are written into
docs/ml_method.md between the "real-results" markers, and its demo banner is
replaced. Every number here is read from the run's own files.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
START, END = "<!-- real-results:start -->", "<!-- real-results:end -->"
BANNER_RE = re.compile(r"^> \*\*The numbers on this page come from the demo build\.\*\*.*$", re.M)


def _j(p: Path) -> Any:
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def _pct(x: float | None) -> str:
    return "—" if x is None else f"{100 * x:.1f}%"


def _f(x: Any, nd: int = 3) -> str:
    if x is None:
        return "—"
    try:
        return f"{float(x):.{nd}f}"
    except (TypeError, ValueError):
        return str(x)


def figure(region: dict[str, Any], viirs_start: str, out: Path) -> bool:
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        return False
    m = region["monthly"]
    x = list(range(len(m)))
    fig, ax = plt.subplots(figsize=(10, 3.4), dpi=110)
    ax.fill_between(x, [p["low"] for p in m], [p["high"] for p in m], color="#f59e0b", alpha=0.18, lw=0, label="harmonized 90% band")
    ax.plot(x, [p["modis_raw"] if p["modis_raw"] is not None else float("nan") for p in m], color="#64748b", lw=0.9, label="MODIS raw")
    ax.plot(x, [p["viirs_raw"] if p["viirs_raw"] is not None else float("nan") for p in m], color="#2563eb", lw=0.9, label="VIIRS raw (reference satellite)")
    ax.plot(x, [p["harmonized"] for p in m], color="#c2410c", lw=1.5, label="harmonized")
    vi = next((i for i, p in enumerate(m) if p["ym"] >= viirs_start), None)
    if vi is not None:
        ax.axvline(vi, color="#111827", ls="--", lw=0.8)
        ax.text(vi + 2, ax.get_ylim()[1] * 0.92, f"VIIRS {viirs_start}", fontsize=8)
    ticks = [i for i, p in enumerate(m) if p["ym"].endswith("-01") and int(p["ym"][:4]) % 5 == 0]
    ax.set_xticks(ticks, [m[i]["ym"][:4] for i in ticks])
    ax.set_ylabel("fire cell-days / month")
    ax.set_title(f"{region['id']}: raw MODIS vs raw VIIRS vs harmonized", fontsize=10)
    ax.legend(fontsize=7, ncol=4, loc="upper left", frameon=False)
    ax.spines[["top", "right"]].set_visible(False)
    fig.tight_layout()
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out)
    plt.close(fig)
    return True


def ml_tables(ml: dict[str, Any]) -> list[str]:
    h = ml["models"]["harmonization"]
    f = ml["models"]["firecast"]
    c = h["conformal"]
    L = [f"Split {ml['splits']['train']} train · {ml['splits']['cal']} calibration · {ml['splits']['test']} test. Source: `{ml['source']}`, generated {ml['generated_at'][:10]}.", ""]
    L += ["| Test years | MAE | RMSE (log1p) | Bias | Spearman | r per cell (log) | r area totals |", "|---|---|---|---|---|---|---|"]
    L.append(f"| Raw MODIS | — | — | — | — | {_f(h['corr_cell'].get('raw'), 2)} | {_f(h['corr'].get('raw'), 3)} |")
    for name, m in h["metrics"].items():
        t = m["test"]
        label = f"**{name} (chosen)**" if name == h["chosen"] else name
        L.append(f"| {label} | {_f(t['mae'])} | {_f(t['rmse_log1p'])} | {_f(t['bias'])} | {_f(t['spearman'], 2)} | {_f(h['corr_cell'].get(name), 2)} | {_f(h['corr'].get(name), 3)} |")
    L += ["", "| Target 90% | Test coverage |", "|---|---|", f"| All cell-months | **{_pct(c['coverage_test'])}** (mean width {_f(c['mean_width'], 2)} cell-days) |"]
    for kind in ("landcover", "country", "activity"):
        g = [x for x in c["by_group"] if x["kind"] == kind]
        if g:
            L.append(f"| Per {kind} ({len(g)} groups) | {_pct(min(x['coverage'] for x in g))}–{_pct(max(x['coverage'] for x in g))}{' ⚠ some below 85%' if any(x['flag'] for x in g) else ''} |")
    L += [f"| Area totals (approximate) | {_pct(c['region_coverage_test'])} |", f"| Terra-only head | {_pct(c['terra_only']['coverage_test'])} |", ""]
    L += ["| FireCast | Result |", "|---|---|", f"| RPSS vs climatology | {_f(f['rpss'], 3)} |", f"| Brier (climatology) | {_f(f['brier'], 3)} ({_f(f['brier_clim'], 3)}) |"]
    sk = [f"{rid} lead {lead['lead']}" for lead in f["leads"] for rid, r in lead.get("regions", {}).items() if r.get("skilful")]
    L.append(f"| Areas with proven skill | {', '.join(sk) if sk else 'none'} |")
    L += ["", "| Fake-trend evidence | Raw-trained jump at VIIRS start | Harmonized-trained |", "|---|---|---|"]
    for rid, a in ml.get("raw_trained_trend", {}).items():
        b = ml["harmonized_trained_trend"][rid]
        L.append(f"| {rid} | ×{a['jump_ratio']} (p={a['p']}) | ×{b['jump_ratio']} (p={b['p']}) |")
    return L


def build_report(data: Path, docs: Path) -> str:
    ix = _j(data / "index.json")
    if not ix:
        raise SystemExit(f"{data / 'index.json'} not found: run `make real` first.")
    meta = data / "meta"
    run = _j(meta / "firms_run.json") or {}
    pipe = _j(meta / "pipeline_run.json") or {}
    ml = _j(data / "ml" / "index.json")
    L = [
        "# FireRings real-data report (auto-generated)",
        "",
        f"> Generated by `python -m src.compute.data_report` from the files of the run of **{ix['generated_at'][:10]}** (`data_mode: {ix.get('data_mode', 'n/a')}`). Do not edit by hand: re-run `make real`.",
        "",
        "## Record",
        "",
        f"- Months: **{ix['first_month']} – {ix['last_month']}**" + (f" ({ix['partial_month']} partial)" if ix.get("partial_month") else ""),
        f"- Reference VIIRS satellite: **{ix.get('viirs_reference', '—')}**, `viirs_start` **{ix['viirs_start']}**",
        f"- Sensors in the data: {', '.join(ix['sensors'])}",
        f"- Grid: {ix['grid']['cell_km']} km cells, {ix['grid']['tile_deg']}° tiles; unit: fire cell-days",
        f"- Access dates: FIRMS {(ix.get('access') or {}).get('firms') or '—'} · POWER {(ix.get('access') or {}).get('power') or '—'} · EONET {(ix.get('access') or {}).get('eonet') or '—'}",
        "",
    ]
    for n in ix.get("notes", []):
        L.append(f"- Note: {n}")
    L += ["", "## FIRMS sources used", "", "| Source | First date used | Last date used | Available (data_availability) |", "|---|---|---|---|"]
    av = ix.get("availability", {})
    for s, d in sorted((ix.get("source_dates") or {}).items()):
        a = av.get(s)
        L.append(f"| {s} | {d['first']} | {d['last']} | {a['first'] + ' – ' + a['last'] if a else '—'} |")
    filt = pipe.get("filters", {})
    if filt:
        fams = sorted({k.split(":")[0] for st in filt.values() for k in st.get("by_family_year", {})})
        years = sorted({k.split(":")[1] for st in filt.values() for k in st.get("by_family_year", {})})
        L += ["", "## Detections per source family per year (all regions; raw → kept after cleaning)", "", "| Year | " + " | ".join(fams) + " |", "|---|" + "---|" * len(fams)]
        for y in years:
            cells = []
            for fam in fams:
                raw = sum(st.get("by_family_year", {}).get(f"{fam}:{y}", 0) for st in filt.values())
                kept = sum(st.get("kept_by_family_year", {}).get(f"{fam}:{y}", 0) for st in filt.values())
                cells.append(f"{raw:,} → {kept:,}" if raw else "—")
            L.append(f"| {y} | " + " | ".join(cells) + " |")
        L += ["", "## Cleaning", "", "| Region | Rows | Outside bbox | Static/volcano/offshore | Low confidence | Kept | Share filtered | Type missing (NRT, kept) |", "|---|---|---|---|---|---|---|---|"]
        for rid, st in filt.items():
            share = 1 - st["kept"] / st["rows"] if st["rows"] else 0
            L.append(f"| {rid} | {st['rows']:,} | {st['outside_bbox']:,} | {st['type_dropped']:,} | {st['confidence_dropped']:,} | {st['kept']:,} | {_pct(share)} | {st['type_missing_kept']:,} |")
    L += ["", "## Regions with gaps or missing data", ""]
    gaps = run.get("gaps") or {}
    missing = [k for k, v in (ix.get("regions_status") or {}).items() if v != "real"]
    if not gaps and not missing:
        L.append("None: every enabled region has data for every date of the record.")
    for k, v in gaps.items():
        L.append(f"- {k}: {v['days']} days not covered by any FIRMS source ({v['first']} – {v['last']})")
    for k in missing:
        L.append(f"- {k}: **no FIRMS data** → the app shows demo data for this area, labelled `demo`.")
    L += ["", "## Per region", ""]
    for p in ix["presets"]:
        rid = p["id"]
        reg = _j(data / "region" / f"{rid}.json")
        if not reg:
            continue
        v = reg.get("validation")
        s = reg.get("seam_test")
        e = _j(data / "validation" / f"eonet_{rid}.json")
        L.append(f"### {p['name']['en']}")
        L.append("")
        if v:
            L.append(f"- Validation (test {v['test']}, trained {v['train']}): r raw **{v['corr_raw']}** → harmonized **{v['corr_harmonized']}**, MAE {v['mae']}, bias {v['bias']}, 90% coverage {_pct(v['coverage_90'])}")
        else:
            L.append("- Validation: not enough overlap months.")
        if s:
            L.append(f"- Seam test (Pettitt, deseasonalized): raw break {s['raw']['break_ym']} p={s['raw']['p']} · harmonized break {s['harmonized']['break_ym']} p={s['harmonized']['p']}")
        if e:
            L.append(f"- EONET: {e['matched']}/{e['total']} events in flagged months" + (f" (hit rate {_pct(e['hit_rate'])}, base rate of flagged months {_pct(e.get('base_rate'))})" if e.get("hit_rate") is not None else f" — **{e['status']}** (fewer than {e.get('min_events', 3)} events: no hit rate)"))
        png = docs / "figures" / f"{rid}_series.png"
        if figure(reg, ix["viirs_start"], png):
            L += ["", f"![{rid}: raw MODIS vs raw VIIRS vs harmonized](figures/{png.name})"]
        L.append("")
    if ml:
        L += ["## ML layer (this run)", ""] + ml_tables(ml) + [""]
    return "\n".join(L) + "\n"


def update_method_doc(path: Path, ml: dict[str, Any], date: str) -> None:
    """Real ML outputs -> generated block in docs/ml_method.md and the demo banner replaced."""
    text = path.read_text(encoding="utf-8")
    banner = f"> **Real-data run of {date}.** The tables in the block below are generated from this run (`make real`). Numbers in the prose further down are from the earlier demo build unless they match the block."
    text = BANNER_RE.sub(banner, text, count=1)
    block = "\n".join([START, "", "## Results from the real run", "", *ml_tables(ml), "", END])
    if START in text and END in text:
        text = re.sub(re.escape(START) + r".*?" + re.escape(END), lambda _m: block, text, flags=re.S)
    else:
        text = text.replace("\n## 1. ML harmonization", "\n" + block + "\n\n## 1. ML harmonization", 1)
    path.write_text(text, encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m src.compute.data_report")
    ap.add_argument("--data", default="data-products")
    ap.add_argument("--docs", default=str(ROOT / "docs"))
    a = ap.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except Exception:
            pass
    data, docs = Path(a.data), Path(a.docs)
    (docs / "data_report.md").write_text(build_report(data, docs), encoding="utf-8")
    print(f"wrote {docs / 'data_report.md'}")
    ml = _j(data / "ml" / "index.json")
    ix = _j(data / "index.json")
    if ml and ml.get("source") != "demo" and ix and ix.get("data_mode") == "real":
        update_method_doc(docs / "ml_method.md", ml, ix["generated_at"][:10])
        print(f"updated {docs / 'ml_method.md'} with the real-run tables")
    return 0


if __name__ == "__main__":
    sys.exit(main())
