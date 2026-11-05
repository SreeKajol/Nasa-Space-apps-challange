# FireRings — আগুন পঞ্জিকা (Agun Panjika) — Almanaque del Fuego

**25 years of Earth's fire memory, unbroken.**

A harmonized burning-activity calendar built from satellite fire hotspots. MODIS (2000→, ~1 km) and VIIRS (375 m; Suomi-NPP 2012–Oct 2026, NOAA-20 2018→, NOAA-21 2023→) count fires differently, so raw records jump when VIIRS starts. The data pipeline harmonizes them into one sensor-agnostic series with uncertainty intervals. This app lets anyone pick an area and a period and see which months are critical, which years were worst, how this month compares with the historical median, and whether the season started early. They can also hear it, print it, and download it.

Built for NASA Space Apps 2026 (challenge: *Harmonization of MODIS and VIIRS Hot Spots*) by Team HalluciNation. Open source, Apache-2.0. **Not an official NASA product.**

## Run it

```sh
npm install
npm run dev        # http://localhost:5173
npm test           # 44 unit tests (statistics, adapters, data contract, i18n, URL state, ML layer)
npm run build      # typecheck + static build into dist/
npm run preview    # serve dist/ locally (service worker + offline mode active here)
```

The npm scripts call each tool through `node node_modules/...` instead of the bare `vite` / `tsc` commands. This is because the project folder name contains a `;`, which npm treats as a PATH separator. If you rename the folder, either form works.

`dist/` is a plain static site (no server, no keys) with relative paths. Put it on any static host, or serve it from a local folder.

## Data modes

| Mode | When | Badge |
| --- | --- | --- |
| **MockAdapter** (synthetic, generated in the browser) | default; no configuration | "Demo data" in the header, `demo` on every number block |
| **StaticJsonAdapter** (the pipeline's files) | `VITE_DATA_BASE_URL` is set at build time | `live`, or `cache` when served from a saved copy; the file's own `source` otherwise |

All data access goes through the single `DataProvider` interface (`src/data/types.ts`). Components never know which adapter is active. When `VITE_DATA_BASE_URL` is set, Settings also lets you switch back to the demo data.

To exercise the static path before the real pipeline exists, write the synthetic data as contract files:

```sh
npm run demo-data                              # → public/demo-data/ (git-ignored, ~2 MB)
VITE_DATA_BASE_URL=./demo-data npm run dev
```

The demo files keep `"source": "demo"`, so the app labels them honestly. Grid tiles are generated only around the Sundarbans preset, so custom areas drawn there work in static mode. Elsewhere you get the "no grid files" message.

## Data contract — what the app assumes beyond the brief

The contract in the brief is implemented exactly (`src/data/types.ts`). Where it was silent, the app assumes the following. Please confirm these against the pipeline:

- **Grid tile ids** are `{lat0}_{lon0}`: the south-west corner, floored to `grid.tile_deg`, e.g. `grid/22_88.json`. A missing tile (404) means no fire cells were recorded there.
- **Months missing from a cell's `m`** count as zero.
- **The current month is partial** when `last_month` equals the current UTC month. It is drawn hatched, is excluded from history statistics, and `current` refers to the latest complete month.
- **`onset` may be `null`** when the current season has not crossed its threshold yet.
- **`validation` is absent for custom areas.** The app says so instead of borrowing a preset's numbers.
- **Custom areas** take their fire-year start month from the nearest preset in the same hemisphere.
- **SPA fallbacks** (a static host answering a missing `.json`/`.csv` with `index.html`) are treated as "file missing".
- **Coefficients CSV:** the contract has no fitted coefficients, so the CSV holds *effective* harmonized ÷ raw ratios per calendar month over the overlap, derived from the published series, and it says so.

## What's in the app

- **Top bar:** area search (preset names or `lat, lon` → 10 km pin), month-precision date range, sensor control **Harmonized | MODIS raw | VIIRS raw | Compare**, language (EN / বাংলা / ES), theme, simple view, Hear the season, Export, Settings, Help/About.
- **Map (left, lazy-loaded):**
  - NASA GIBS MODIS Terra true colour with an explicit date (it follows the open month), or the keyless Esri light/dark canvas.
  - Hotspot-density layer from grid cells for the selected range.
  - Draw rectangle / polygon / pin + radius (Geoman), plus a coordinates form for keyboard users.
- **KPI cards:** this month vs median, season onset (click → explainer with a cumulative chart), peak month, worst year, total in range, and the harmonization evidence (raw r → harmonized r).
  - **Simple view** swaps these for three big icon cards.
  - The **3-month outlook** card shows only months with RPSS > 0, each with its skill badge; otherwise it shows "No reliable outlook for this area."
- **Tabs:**
  - **Calendar:** years × months with marginal medians and yearly totals, counts / anomaly view, calendar or fire years, ⚠ extremes, keyboard grid, month drawer.
  - **Fire Rings:** radial tree-ring chart with a 6 s play animation.
  - **Time series:** uncertainty band, brush zoom, 12-month mean, NASA POWER context strip, and **Show the sensor break** (raw lines morph into the harmonized line in under 2 s).
  - **Monthly profile**
  - **Method & data:** steps, validation, parameters, before/after seam, why now, sources, limitations, downloads.
- **Hotspot table:** virtualized and sortable, with CSV download.
- **Printable almanac** at `almanac/`: one black-and-white-safe A4 page with a QR code back to the live view.
- **Offline / PWA:** the service worker precaches the app shell. Data files are cached network-first and labelled `cache` when offline, with the offline banner showing the save date. Map tiles are cached up to 800.
- **Accessibility:**
  - Every chart has a one-line `aria-live` summary and "View as table".
  - Status always shows icon + word (▼ ● ▲ ⚠).
  - 44 px targets, visible focus rings, "Skip to calendar", reduced-motion support, AA contrast tokens in both themes, cividis option.
  - Sonification ("Hear the season") with per-note announcements, and a first-visit 3-step tour.

Every shareable setting lives in the URL, for example:
`?lang=bn&area=parana-delta&from=2015-01&mode=viirs&tab=rings&view=anomaly&rows=fire&m=2020-08`.

## FireRings Intelligence (ML layer)

An additive layer on top of the app. If its files are missing, the app behaves exactly as before.

- **ML harmonization.** XGBoost learns *why* MODIS and VIIRS disagree, benchmarked against the stratified ratio method.
- **Conformal 90% intervals.** Coverage is checked per land cover, country and activity level.
- **TreeSHAP explanations.** Global drivers, plus a "Why this month?" waterfall in the month drawer.
- **FireCast.** Below / near / above-normal outlooks, shown only where hindcasts beat climatology.
- **Grounded narratives.** Templates in EN/BN/ES; no model writes a number.
- **Demo moment.** "Train on raw vs harmonized" shows the fake jump that raw-trained AI learns when VIIRS arrives.

```sh
pip install -r requirements-ml.txt   # CPU only; use a venv OUTSIDE this folder (its name contains ';')
npm run ml                           # = make ml: demo inputs if no pipeline files, then train,
                                     #   validate, explain, forecast, export -> public/data/ml/
python -m pytest tests/ml -q         # leakage, conformal coverage, scores, schema, determinism
```

- **Real data.** The pipeline writes `data-products/index.json`, `region/*.json` and `ml_inputs/cell_month.parquet` (schema in [docs/ml_features.md](docs/ml_features.md)).
- **Demo data.** The demo exporter dumps the browser demo's cell field. The ML layer simulates sensor observations on it, and every output is labelled `demo`.
- **Further reading.**
  - Method and validation table: [docs/ml_method.md](docs/ml_method.md)
  - Plans: [docs/ml_plan.md](docs/ml_plan.md), [docs/ml_frontend_plan.md](docs/ml_frontend_plan.md)
  - AI-use log: [docs/AI_USE.md](docs/AI_USE.md)

## Code map

```
src/compute/derive.ts      statistics: percentiles, climatology, onset, geometry (tested)
src/data/types.ts          data contract + DataProvider interface
src/data/mock.ts           MockAdapter — deterministic synthetic cell field
src/data/staticJson.ts     StaticJsonAdapter — pipeline files, cache fallback
src/data/view.ts           sensor modes, year rows, totals (all charts read through this)
src/i18n/{en,bn,es}.json   every UI string; summaries are templates with {placeholders}
src/state/                 URL state, device preferences, app context
src/components/            shell, top bar, KPIs, drawers, map, charts (D3), method tab
src/almanac/               printable A4 page (second Vite entry: almanac/index.html)
src/compute/ml/            Python ML layer: features, harmonize_ml, conformal, explain, firecast, narrative, run
src/ml/                    ML frontend: MLProvider (static + mock), Intelligence tab, drawer section, risk layer
tests/ml/                  Python tests for the ML layer
public/sw.js               service worker
scripts/generate-demo-data.ts
```

## Before submission — placeholders to fill

- Team member names: `AboutDialog` in `src/components/TopBar.tsx`
- Repository URL: same dialog
- Method PDF URL: `METHOD_PDF` in `src/components/MethodTab.tsx`
- `m.p_conf_v` ("MODIS ≥ 30%; VIIRS nominal or high") in `src/i18n/*.json`: set it to the pipeline's real confidence filter

## Performance

On a mobile Lighthouse run (production build, Edge), every page tested scores performance ≥ 91, accessibility 100 and best practices 100. Details are in [docs/CHECKLIST.md](docs/CHECKLIST.md). What makes that possible:

- A static loading shell in `index.html` paints immediately, and the stylesheet doesn't block it.
- First-load JS is about 161 KB gzipped. Bangla/Spanish, the four secondary tabs, and (on phones) the map load on demand.
- The first render and the calendar are time-sliced with React transitions.

## Known limits

- **Demo data is synthetic.** Its validation numbers are generated to the brief's targets (r ≈ 0.6 → 0.9) and are not measured.
- **NASA GIBS MODIS Terra imagery** has daily swath gaps. Pick another imagery date if a day looks patchy.
- **Inter font file names are hashed by the build**, so they can't be preloaded from `index.html`. The loading shell uses system fonts on purpose.
