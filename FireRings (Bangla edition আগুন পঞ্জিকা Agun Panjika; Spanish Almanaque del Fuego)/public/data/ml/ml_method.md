# FireRings Intelligence: method (one page)

> **The numbers on this page come from the demo build.** Real models ran on **synthetic** inputs. They show how the method behaves, not what happened. Rerun `make ml` on pipeline data and replace this table before presenting.

**Story.** An AI trained on raw satellite fire records learns a fake trend: the jump when the sharper VIIRS sensor arrived. We first repair the record with an explainable, uncertainty-aware model, and only then forecast from the repaired record.

## 1. ML harmonization

- **Unit.** One 5.5 km cell × one month.
- **Target.** Cell-days seen by the reference VIIRS satellite. The model is XGBoost (Poisson, CPU hist) with a fixed offset of log(MODIS cell-days + 0.5), so the trees model the **VIIRS/MODIS ratio**.
- **Features** (all observable in the same month):
  - MODIS Terra and Aqua counts
  - FRP and viewing angle of the MODIS detections
  - day share, land cover, NDVI
  - NASA POWER weather
  - season
  - MODIS activity across the region and in neighbouring cells
- **Two heads.** One for Terra + Aqua, and a Terra-only head for the months before July 2002.
- **Baseline B0.** The VIIRS/MODIS ratio per land cover × calendar month.
- **Split.**
  - Train: 2012–2019.
  - Calibration: 2020. It is used to choose the model and to calibrate conformal.
  - Test: 2021–2026-10. It was **never used for any choice**. The prompt says to choose by test MAE; we choose on the calibration year instead, so the no-tuning-on-test rule holds.

| Test years, 161,980 cell-months | MAE | RMSE (log1p) | Bias | Spearman | r per cell (log) | r area totals |
|---|---|---|---|---|---|---|
| Raw MODIS | — | — | — | — | 0.46 | 0.995 |
| Ratio method B0 | 0.865 | 0.622 | +0.009 | 0.36 | 0.44 | 0.994 |
| **XGBoost M1 (chosen)** | **0.596** | **0.399** | −0.030 | **0.58** | **0.69** | 0.989 |
| Random forest M2 (report only) | 0.582 | 0.392 | −0.192 | 0.58 | 0.69 | 0.989 |

- **Spatial check.** Holding out whole 2° tiles (5 folds, 12 tiles), MAE is 0.58 ± 0.08 for M1 vs 0.82 ± 0.11 for B0.
- **Terra-only head.** MAE 0.60 vs 0.82.
- **Honest reading.** M1 cuts the per-cell error by 31%. For area totals, raw MODIS already tracks VIIRS (r ≈ 0.99), so every method ties there. The gain is in *where* and *why* the sensors disagree.

## 2. Conformal uncertainty

- **Method.** Split conformal with normalized scores |y − ŷ| / σ̂(x). σ̂ is a small XGBoost model trained on out-of-fold residuals.
- **Mondrian calibration** by land cover, by country and by predicted activity. A row uses its largest group quantile, which keeps the guarantee for every partition.
- **Area intervals.** A second conformal step on the calibration year's area-months scales the combined cell widths √Σhw². It uses only 48 calibration points, so area intervals are labelled **approximate**.

| Target 90% | Test coverage |
|---|---|
| All cell-months | **91.4%** (mean width 1.96 cell-days) |
| Per land cover (8 groups) | 90.9–92.8% |
| Per country | Argentina 90.8%, Bangladesh 92.5% |
| Per activity level | 91.1–95.2% |
| Area totals (approximate) | 96.4% |
| Terra-only head | 91.3% |

No group falls below 85%.

## 3. Explainability

- **TreeSHAP.** Exact, computed by XGBoost itself (`pred_contribs`).
- **Global drivers.** Mean |SHAP| (top 10), plus binned dependence tables: FRP, viewing angle and land cover.
- **Local explanations.** For each area-month, cell SHAP values are weighted by each cell's predicted count. The month drawer turns them into a waterfall: typical-ratio start → top ± contributions → other factors → ML estimate.

## 4. FireCast

- **Target.** The tercile class (below / near / above normal) of next months' **harmonized** activity, relative to that unit's own calendar-month climatology.
- **Hindcast.** Leave-one-year-out, with the climatology of each fold excluding the held-out year.
- **Calibration.** Temperature scaling and the 90% LAC prediction sets are fitted on 2001–2010. Skill is evaluated on 2011–2026.
- **Skilful** only when RPSS > 0 **and** the lower end of its year-block bootstrap 90% interval is > 0.

| Evaluation 2011–2026 | Result |
|---|---|
| RPSS vs climatology (all areas, leads 2–4) | +0.004 |
| RPSS of persistence | −0.11 |
| Brier score (climatology) | 0.666 (0.671) |
| Areas with proven skill | none |
| Cells with proven skill (map) | 0% |

**Honest reading.** The synthetic demo record has no forecastable weather signal, so FireCast correctly shows **"No reliable outlook"** everywhere and the alert strip stays silent. On real data the same tests decide.

## 5. "Fake trend" evidence

The same simple model (XGBoost Poisson on time and season) was trained on two records:

- **Raw combined record** (VIIRS where it exists, else MODIS): its fitted yearly totals jump **×4.3–4.6** when VIIRS starts (Mann–Kendall p < 0.001).
- **Harmonized record:** they change by **×1.08–1.15**. That is the demo's real slow increase plus a few big fire years.

## Limitations

- Clouds, smoke, and short fires between overpasses hide fires from both sensors.
- Area intervals are approximate.
- Before 2002-07 only Terra flew.
- Forecast skill varies by area and month.
- New VIIRS satellites need their own calibration.
- **This build's numbers are synthetic.**
- Not for life-safety decisions without local verification.
- Future work: U-Net / ConvLSTM spatial models. They are not used here: the layer is CPU-only and explainability comes first.
- **Engineering note.** On Windows, fitting the scikit-learn forest and running XGBoost TreeSHAP in one process crashed natively. The report-only forest therefore runs in its own process, and SHAP runs in 100k-row chunks.

**Reproduce:** `make ml` (or `npm run ml`), then `python -m pytest tests/ml`.
