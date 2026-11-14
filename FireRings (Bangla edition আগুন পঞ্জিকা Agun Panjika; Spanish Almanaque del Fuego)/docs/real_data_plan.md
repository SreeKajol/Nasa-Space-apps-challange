# Real NASA data: plan

Goal: switch FireRings from demo data to real NASA data without breaking anything. Every existing file, component, route and JSON field stays. The changes are **additive**:

- an ingest package;
- a pipeline package;
- new make/npm targets;
- a config file;
- optional JSON fields.

## What the repo has today (read before planning)

| Piece | State | Consequence |
|---|---|---|
| App | At the repo root (`src/`, `public/`), not in `web/` | `make snapshot` writes to `public/data/`. |
| Contract v1 | `src/data/types.ts`. `StaticJsonAdapter` reads `VITE_DATA_BASE_URL` (build time). | Real data reuses the same adapter. |
| Statistics | `src/compute/derive.ts` (tested): percentiles, climatology, current, onset. | The real pipeline calls `deriveRegion` through a Node script instead of re-implementing it. |
| Harmonization | `src/compute/ml/baseline.py` holds the stratified ratio method; its docstring calls it the pipeline's rule. ML layer: `src/compute/ml`. | The contract series reuse `StratifiedRatio`. |
| Clean → grid → contract export (Python) | **Did not exist.** The brief assumed it; only the synthetic generator (`scripts/generate-demo-data.ts`) did. | A small `src/compute/pipeline/` is added. It covers clean, grid and contract staging only, and reuses the two pieces above for everything statistical. |
| `make` | Not installed on the dev machine | Every make target has an `npm run` twin, as `make ml` / `npm run ml` already do. |
| FIRMS key | Not present | All code runs and is tested without one. `make real` skips FIRMS with a clear log line and never overwrites the snapshot when FIRMS data is missing. |

## Data flow

```
config/real_data.yaml
   │
   ├─ src/ingest/firms.py   availability → plan (archive ▸ SP ▸ NRT) → cached area-API CSVs
   │                        → normalized hotspots (SP over NRT)   data/clean/hotspots_{region}.parquet
   ├─ src/ingest/power.py   monthly T2M / PRECTOTCORR / RH2M per region centroid → data/raw/power/
   └─ src/ingest/eonet.py   wildfire events per region bbox → data/raw/eonet/
   │
src/compute/pipeline/       clean (confidence ≥ nominal, type 0) → 5.5 km grid, cell-days
   │                        → StratifiedRatio harmonization (train years) + interval from
   │                          leave-one-year-out residuals → stage files
scripts/export-contract.ts  deriveRegion (tested TS) → data-products/{index.json, region/, grid/, hotspots/}
src/compute/ml (existing)   reads data-products/ + ml_inputs/cell_month.parquet → data-products/ml/
src/compute/seam.py         Pettitt test, raw vs harmonized → region JSON "seam_test" (additive)
src/ingest/eonet.py         validate → data-products/validation/eonet_{region}.json
src/compute/data_report.py  docs/data_report.md + docs/figures/*.png (+ ML tables in ml_method.md)
scripts/snapshot.mjs        data-products → public/data/ ("source": "cache", generated_at)
```

## Decisions

1. **Reference VIIRS satellite.**
   - Rule: the satellite whose record covers the whole run.
   - Suomi-NPP stopped delivering on 1 Nov 2026. If `VIIRS_SNPP_*` is missing, or ends more than 7 days before the run date, the reference becomes NOAA-20 and `viirs_start` becomes the first NOAA-20 month. Both are logged and written to `index.json`.
   - Only MODIS and the reference satellite are downloaded. This halves the API calls; extra satellites can be switched on in the config.
2. **Fetch plan per region and source family.** For every date from the family's first available day to today:
   - archive CSV (`data/raw/archive/`), if one covers the region and date;
   - else `*_SP` if the availability endpoint lists the date;
   - else `*_NRT`.
   Chunks are aligned to a fixed epoch, so cache file names stay stable between runs. NRT chunks that end within the last 3 days are re-downloaded; everything else is cached forever.
3. **Day range.** Probe once: try 10, then step down on error. The result is stored in `data-products/meta/firms_probe.json`.
4. **Client.**
   - One `requests.Session`, 60 s timeout, exponential backoff on 429/5xx.
   - A sliding-window rate limiter (default 1,000 calls per 10 min, against FIRMS's 5,000 limit).
   - The key comes from `.env` and never appears in logs, cache paths or files. `source_url_hash` hashes the URL with the key redacted.
5. **Unit.** Fire cell-days on the existing 5.5 km grid (`m.p_rule_v`: one cell-day counts once). MODIS raw = distinct MODIS cell-days; VIIRS raw = reference-satellite cell-days.
6. **Contract harmonization.**
   - Method: `StratifiedRatio`, with region × calendar-month strata and a Terra-only head before 2002-07, fitted on the training years of `make_splits`, the ML layer's split rule.
   - 90% band: from leave-one-year-out log residuals.
   - Validation: computed on the held-out test years only (r raw, r harmonized, MAE, bias, coverage).
7. **Land cover.** MCD12Q1 is not ingested (it needs an Earthdata login). Each region gets one documented class in the config, and the gap is recorded in `index.notes`. NDVI is left missing; the ML layer already handles NaN.
8. **EONET.**
   - Events are matched to months the calendar flags as above or extreme (percentile ≥ 75).
   - Fewer than 3 events gives `"insufficient events"`, with no hit rate.
   - It is never inflated.
9. **Seam test.** Pettitt test on deseasonalized log1p series: raw (MODIS + VIIRS, as the "Before" chart shows) and harmonized. `ruptures` is optional and not required.
10. **Frontend.**
    - Build-time detection: if `public/data/index.json` has `data_mode: "real"`, the app defaults to it (`VITE_DATA_BASE_URL=./data`), and the "Demo data" badge disappears because `isDemo` turns false.
    - The badge reads `cache` with the `generated_at` date.
    - A region file missing from the snapshot falls back to demo, badge `demo`.
    - The Method tab gains a "Real data" card: sources and dates, `viirs_start`, EONET result, seam test, citation.
11. **Fallbacks.** No FIRMS data for a region → that region is omitted, the app shows demo for it, labelled. No FIRMS data at all → the pipeline stops before writing, so the previous snapshot stays.

## Steps (tests after each)

1. Config, `.env` handling, ingest client (rate limiter, retries, cache) + tests.
2. FIRMS: availability, plan, archive, normalize, dedup + tests.
3. POWER, EONET fetch + tests.
4. Pipeline: clean, grid, harmonize, stage; `export-contract.ts`; ML hookup.
5. Seam detector + EONET validation + tests.
6. Orchestration: Makefile, `scripts/real.mjs`, `scripts/snapshot.mjs`.
7. Frontend: real-mode detection, provenance, fallback, Method-tab card, i18n (EN/BN/ES).
8. Data report, placeholder audit, README, citation. Then the full test suite and the commit.
