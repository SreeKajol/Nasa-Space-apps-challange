# FireRings Intelligence: frontend plan (Part 2)

Rule: reuse the design system, i18n, theme, provenance badges, "View as table" and aria-live summaries. If `ml/index.json` is missing, every new element stays hidden and the app behaves exactly as before.

## New files (all in `src/ml/`)

| File | Purpose | Loaded |
|---|---|---|
| `types.ts` | Contract v1.1 types | — |
| `provider.ts` | MLProvider: `MlStaticAdapter` (`{base}/ml/`) and a demo adapter (computed demo files if they match, else the mock) | main |
| `mock.ts` | `MlMockAdapter`: synthetic v1.1 data, labelled demo | lazy |
| `hooks.ts` | `useMl()`; FireCast rules (`futureForecasts`, `alertForecast`) | main |
| `i18n.ts`, `i18n/{en,bn,es}.json` | Strings of the layer; number and unit formatting with Bangla digits | lazy JSON |
| `inline.tsx` | Insertion-point components (`AlertStrip`, `MlOutlookToggle`, `MlOutlookStandalone`, `WhyThisMonthSlot`) and lazy wrappers | main (tiny) |
| `IntelligenceTab.tsx` | Tab: How sure are we? · demo moment · Why the sensors disagree · Model vs baseline · Model card | lazy |
| `WhyThisMonth.tsx` | Drawer section: interval line, SHAP waterfall, grounded sentence | lazy |
| `OutlookDetails.tsx` | FireCast details: stacked probabilities, set chips, skill badge, drivers, reliability | lazy |
| `RiskLayer.tsx` | Map layer, toggle and legend | map chunk |
| `parts.tsx`, `ml.css` | Shared card / chart parts; line-draw animation (off with reduced motion) | lazy |
| `ml.test.tsx` | Component and adapter tests | test |

Scripts:

- `scripts/copy-ml.mjs` copies `data-products/ml/` to `public/data/ml/`.
- `scripts/ml.mjs` runs the whole layer (`npm run ml`).
- `scripts/export-ml-demo-inputs.ts` writes the demo inputs.

## Minimal insertion points in existing files

| File | Insertion |
|---|---|
| `src/state/url.ts` | `"intel"` added to `TABS`; one boolean `risk` (`risk=1`) for the map layer |
| `src/components/Shell.tsx` | One tab entry (shown only when ML data exist), its lazy content, and `<AlertStrip/>` above the KPIs |
| `src/components/MonthDrawer.tsx` | `<WhyThisMonthSlot ym/>` after the numbers |
| `src/components/Kpis.tsx` | `<MlOutlookToggle/>` at the end of the outlook card; `<MlOutlookStandalone/>` when v1 has no outlook |
| `src/components/map/MapPanel.tsx` | `<RiskToggle/>` in the layer controls, `<RiskLayer/>` inside the map, `<RiskLegend/>` below it |
| `package.json` | Scripts `ml`, `ml:copy`, `ml:demo-inputs` |

## Budget and checks

- Extra JS is about 20 KB gzip, almost all lazy (the limit is 60 KB).
- Typecheck, lint (new files), build, and `npm test` (existing and new tests) all pass.
