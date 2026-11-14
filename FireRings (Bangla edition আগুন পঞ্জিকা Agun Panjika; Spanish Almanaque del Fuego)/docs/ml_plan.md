# FireRings Intelligence: backend plan (Part 1)

This plan comes from reading the repo before the layer was built. Everything is additive: no existing file, component, JSON field or behaviour changes.

## What the repo actually contains

The ML prompt assumes a Python FIRMS pipeline in the repo. This repo holds only the **frontend** and the **data contract v1**:

- The deterministic science is TypeScript: `src/compute/derive.ts`.
- `src/data/types.ts` holds the contract.
- `scripts/generate-demo-data.ts` writes contract files from the synthetic demo.

So the ML layer reads the **contract v1 files**, plus one new input table that the pipeline team must export.

| Prompt path | Here | Note |
|---|---|---|
| `src/compute/ml/` | `src/compute/ml/` (Python package `src.compute.ml`) | Lives next to the TS science; Vite and tsc ignore `.py` files |
| `tests/ml/` | `tests/ml/` | `python -m pytest tests/ml` |
| `data-products/ml/` | `data-products/ml/` | git-ignored (regenerable) |
| `web/public/data/ml/` | `public/data/ml/` | The frontend is at the repo root, not `web/`; committed, so the app works without Python |
| Makefile `ml` target | `Makefile` (new) + `npm run ml` | `make` is often missing on Windows, so `scripts/ml.mjs` runs the same steps |
| requirements / lockfile | `requirements-ml.txt` (new) | `shap` is optional: TreeSHAP comes from XGBoost's `pred_contribs` |

## Inputs

1. **Contract v1, unchanged:** `index.json` and `region/{preset}.json`.
   - The published harmonized series sets the units.
   - The NASA POWER `context` supplies the weather features.
2. **`ml_inputs/cell_month.parquet`**, a **new export the pipeline team must add**. Schema: `docs/ml_features.md`. It holds per-cell-month MODIS Terra and Aqua cell-days, reference-VIIRS cell-days, and FRP, scan angle and day share of the MODIS detections, plus land cover and NDVI.
3. **Demo fallback:** `ml_inputs/demo_cells.json`, written by `scripts/export-ml-demo-inputs.ts`.
   - It holds the browser demo's own per-cell field.
   - `demo_inputs.py` simulates MODIS and VIIRS observations on that field, with a physically motivated sensor difference: small fires, scan angle, land cover, clouds.
   - The outputs are labelled `demo`.

## Steps (`make ml` / `npm run ml`)

1. `features.py`: the cell × month table and the temporal splits.
   - Train: overlap years up to 2019 (or `viirs_start` + 5).
   - Calibration: the following year.
   - Test: the remaining years.
2. `baseline.py`: B0, the stratified VIIRS/MODIS ratio (land cover × calendar month), fitted on the train years.
3. `harmonize_ml.py`:
   - M1: XGBoost Poisson with a log-MODIS offset, so the trees model the VIIRS/MODIS ratio.
   - M2: Random Forest, for the report only.
   - Two heads: Terra + Aqua, and Terra-only (before 2002-07).
   - Temporal validation and a 2° spatial block CV.
   - The model is chosen on the **calibration year**, not the test years. This is a deliberate deviation from the prompt's "by test MAE", which would break the no-tuning-on-test rule.
4. `conformal.py`: normalized split conformal.
   - σ̂ comes from out-of-fold residuals.
   - Mondrian calibration by land cover, country and predicted activity.
   - A second, region-level conformal step produces area intervals.
5. `explain.py`: TreeSHAP global drivers, binned dependence tables, and local region-month explanations.
6. `firecast.py`:
   - Tercile classes from the harmonized record.
   - Leave-one-year-out hindcast, temperature scaling, RPSS with a year-block bootstrap, Brier score, reliability.
   - LAC 90% prediction sets.
   - A cell model for the map.
   - The raw-vs-harmonized trend test.
7. `narrative.py`: EN/BN/ES templates that use computed fields only, plus a number-grounding guard (LLM polishing is off).
8. `schema.py` validates every output before anything is written. `run.py` orchestrates and prints the summary.

## Quality gates

- `tests/ml`:
  - no leakage (both feature tables)
  - Mondrian coverage on synthetic data
  - RPSS reference points and LAC set coverage
  - grounding guard
  - schema and determinism (end-to-end on a tiny fixture)
- CPU only. The full demo run takes about 5 minutes on a laptop, within the 20-minute budget.
