# FireRings — build checklist against the prompt pack

Every requirement from the prompt pack `lovable-prompt-firerings.md` (Block 0 + Prompts 1–5; keep a copy in `docs/` for the Space Apps AI-use disclosure), where it lives in the
code, and how it was checked. Status: ✅ done and verified · 🔧 fixed in the audit pass · ⚠ open.

Verification legend: **T** = unit test (`npm test`), **B** = checked in a real browser, **C** = code review.

## Block 0 — project rules

| # | Requirement | Where | Status |
|---|---|---|---|
| 0.1 | React + Vite + TypeScript + Tailwind + shadcn/ui; no backend/auth/Supabase/paid APIs | `vite.config.ts`, `src/components/ui/` | ✅ C |
| 0.2 | react-leaflet + draw tools (Geoman) | `src/components/map/MapPanel.tsx` | ✅ B |
| 0.3 | NASA GIBS true colour with explicit date; free no-key street basemap; layer switcher; "Imagery: NASA GIBS" credit | MapPanel (Esri canvas — CARTO now needs a key) | ✅ B |
| 0.4 | Provenance badge (live / cache / demo) on every number block | `ProvenanceBadge` on every KPI card, every chart card, drawer, table | 🔧✅ B |
| 0.5 | Offline-first, works from local files with network off | `public/sw.js`, demo data built in | ✅ B |
| 0.6 | D3 for calendar, rings, series | `src/components/charts/` | ✅ C |
| 0.7 | State in URL (area, dates, mode, language, tab) | `src/state/url.ts` | ✅ T B |
| 0.8 | One DataProvider, MockAdapter (default) + StaticJsonAdapter (VITE_DATA_BASE_URL) | `src/data/` | ✅ T |
| 0.9 | First load < 300 KB gzipped JS, lazy heavy views, virtualized tables, memoized aggregations | build output, `Shell.tsx`, `HotspotTable.tsx`, `view.ts` | ✅ C |
| 0.10 | No NASA logo; footer text verbatim | `Shell.tsx` Footer, `en.json footer.text` | ✅ C |
| 0.11 | Data contract implemented exactly; mock matches it | `src/data/types.ts`, `adapters.test.ts` | ✅ T |
| 0.12 | Never hard-code the VIIRS start; read `viirs_start` | grep: UI only uses `index.viirs_start` | ✅ T C |
| 0.13 | Design: slate surfaces, one ember accent, inferno/cividis, diverging anomalies, icon+word status, Inter + Noto Sans Bengali, 12/14/16/20/28/40, 12 px cards, motion 150–250 ms, reduced motion | `src/styles.css`, `ramp.ts` | ✅ B |
| 0.14 | Numbers with units and uncertainty; one-line plain summary above every chart | `valueWithRange`, `summaries.ts`, `ChartCard` | ✅ B |
| 0.15 | WCAG 2.2 AA contrast, focus rings, 44 px targets, keyboard, "View as table" + aria-live per chart | styles tokens, `ChartCard` | ✅ B, Lighthouse a11y 100 |

## Prompt 1 — foundation and dashboard

| # | Requirement | Status |
|---|---|---|
| 1.1 | "Demo data" badge in header while MockAdapter is active | ✅ B |
| 1.2 | Seeded mock, 2000-11 → current month, 4 presets with the requested peaks/extremes | ✅ T |
| 1.3 | modis_raw from 2000-11, viirs_raw from viirs_start, ratio 3–5×, settings switch 2012-01 / 2018-01 | ✅ T |
| 1.4 | corr_raw ≈ 0.6, corr_harmonized ≈ 0.9, context, wider intervals before VIIRS, all objects present | ✅ T |
| 1.5 | Top bar: logo, search (names or "lat, lon"), month range, sensor control, language, theme, Export, **Help** | 🔧✅ Help and About are direct buttons |
| 1.6 | Map ≈40%: density layer for range, rectangle/polygon/pin+radius, preset chips, accent outline, **area name + km²** | 🔧✅ name + km² above the map, plus "Clear drawn area" |
| 1.7 | Six KPI cards with captions; harmonization-evidence card in accent | ✅ B |
| 1.8 | Tabs Calendar / Fire Rings / Time series / Monthly profile / Method & data | ✅ B |
| 1.9 | Virtualized, sortable hotspot table with CSV | ✅ B |
| 1.10 | Calendar: newest year on top, calendar/fire-year toggle, inferno counts, ⚠ + outline for extremes, marginal medians + totals, counts/anomaly, tooltip, click → drawer (daily bars, hotspots on map, summary), arrow keys + Enter + aria-live, legend + "uncertain before VIIRS", table, summary | ✅ B |
| 1.11 | Skeletons, empty state, error + retry, offline banner | ✅ B |
| 1.12 | Mobile: collapsible map, KPI scroll, calendar scroll with sticky years, filters bottom sheet | ✅ B |
| 1.13 | Calendar summary says "since <first full year>" | 🔧✅ |

## Prompt 2 — analysis tabs

| # | Requirement | Status |
|---|---|---|
| 2.1 | Fire Rings: oldest centre, clockwise from top, inferno, tooltip, click → drawer, 6 s play, reduced-motion, side note, table + aria-live | ✅ B |
| 2.2 | Time series: band, sensor control drives it, Compare overlay | ✅ B |
| 2.3 | "Show the sensor break": raw MODIS+VIIRS, marker "VIIRS starts, <viirs_start>", morph to harmonized, caption, agreement numbers, < 2 s | ✅ B (1.9 s) |
| 2.4 | NASA POWER context strip, brush/zoom, 12-month mean | ✅ B |
| 2.5 | Monthly profile: median bars, p10–p90 whiskers, selected-year line, year selector, summary | ✅ B |
| 2.6 | Onset explainer drawer with cumulative chart | ✅ B |

## Prompt 3 — inclusion

| # | Requirement | Status |
|---|---|---|
| 3.1 | en/bn/es JSON, localized numbers/months, Bangla digits, Noto Sans Bengali, templated summaries, language in URL | ✅ T B |
| 3.2 | Hear the season: top bar + Calendar + Rings, 12 notes, 0.4 s, aria-live per month, play/pause, year, speed, SR explanation | ✅ C |
| 3.3 | Accessibility pass + "Skip to calendar" | 🔧✅ heading order, draw-tool names, skip-link target fixed; Lighthouse a11y 100 |
| 3.4 | Printable almanac (`almanac/`), B/W-safe, QR, editable "What to do", Export → Print almanac | ✅ B |
| 3.5 | PWA: shell + last area's data cached; "Offline: showing saved data from <date>" | ✅ B |
| 3.6 | Low-literacy mode: three big icon cards | ✅ B |

## Prompt 4 — method, exports, outlook

| # | Requirement | Status |
|---|---|---|
| 4.1 | 4 illustrated steps; validation (two big numbers + explained metrics); parameters; seam mini-chart; Why now; sources; "src/compute" note; limitations; downloads | ✅ B |
| 4.2 | Export: Hotspots CSV (area+dates), Monthly CSV, Calendar PNG (legend + attribution), Share link, Print almanac | ✅ C |
| 4.3 | Outlook only with skill badge; rpss ≤ 0 → "No reliable outlook for this area." | ✅ B |

## Prompt 5 — real data and polish

| # | Requirement | Status |
|---|---|---|
| 5.1 | VITE_DATA_BASE_URL → StaticJsonAdapter, badge hidden, custom areas from grid tiles ("approximate"), memory + SW cache, clear missing-file error | ✅ T (adapter run against served files) |
| 5.2 | 3-step first-visit tour, skippable, remembered | ✅ B |
| 5.3 | Edge cases (zero fires, partial month, pre-VIIRS); code-split tabs; Lighthouse ≥ 90 perf + a11y on mobile | 🔧✅ see "Lighthouse" below |
| 5.4 | About dialog | ✅ C |

## Audit pass — cleanup and optimization

| Item | Status |
|---|---|
| Remove unused shadcn components (badge, button, dialog, label, select, separator, switch, tooltip) and their 7 packages | ✅ |
| Prune i18n keys no code uses (11 removed; 353 per language) | ✅ |
| Service worker precaches only the font files browsers actually use (no .woff fallbacks, no Cyrillic/Greek/Vietnamese Inter) | ✅ |
| Generated demo fixtures not kept in `public/` (regenerate with `npm run demo-data`) | ✅ |
| Reference documents moved to `docs/` | ✅ |

## Performance work in the audit pass

| Change | Why |
|---|---|
| Bangla and Spanish dictionaries load on demand (English is built in and is the fallback) | −16 KB gzip on first load |
| On phones the map starts folded; Leaflet + tiles load only when opened | −123 KB gzip and all tile requests on mobile first load |
| Noto Sans Bengali only on Bangla pages | its 45 KB font no longer downloads for English/Spanish |
| Static, inline-styled loading shell in `index.html`; app stylesheet loads without blocking paint; app mounts once CSS is ready | first paint / LCP ≈ 0.7 s on slow 4G instead of 3.2 s |
| First render and the calendar render run as React transitions (time-sliced) | total blocking time down from ~740 ms to 150–310 ms |
| Hotspot table renders only when scrolled near | below-the-fold work off the critical path |
| Plain-language "now" sentence shown under the area name | the line a busy officer needs, visible first |
| Reserved space for late rows, full-height main | layout shift 0.67 → < 0.1 |

## Lighthouse (production build, gzip static server, Edge, mobile preset)

| Page | Perf (real throttling) | Perf (simulated) | Accessibility | Best practices |
|---|---|---|---|---|
| EN · Sundarbans · calendar | 93 | 99 | 100 | 100 |
| BN · Chittagong Hill Tracts · calendar | 97 | 98 | 100 | 100 |
| ES · Paraná Delta · time series | 96 | 93 | 100 | 100 |
| EN · Corrientes · method | 96 | 93 | 100 | 100 |
| EN · Chittagong · desktop preset | 91 | — | 100 | 100 |

Scores move a few points between runs. Measure the deployed site too: real hosts add HTTP/2 and brotli.

## Still open (needs the team)

- ⚠ Team member names, repository URL, method PDF URL (placeholders — see README).
- ⚠ `m.p_conf_v` must state the pipeline's real confidence filter.
- ⚠ Replace the synthetic data with the pipeline's `region/*.json` as soon as it exists.
