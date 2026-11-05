# ML feature tables: schema

The unit is one 5.5 km grid cell × one month, using the existing cell ids (`c_{lat}_{lon}`, cell centre). All tables are written by `src/compute/ml/features.py`.

## Input the pipeline must export: `ml_inputs/cell_month.parquet`

| Column | Meaning | Missing |
|---|---|---|
| `cell_id`, `lat`, `lon` | Grid cell (centre) | — |
| `region`, `country` | Preset id, ISO-2 | — |
| `landcover` | MCD12Q1-derived class: cropland, crop_mosaic, grassland, wetland, shrubland, savanna, forest, mangrove | — |
| `ym` | `YYYY-MM` | — |
| `modis_terra`, `modis_aqua` | MODIS cell-days (one cell-day counts once) | Aqua NaN before 2002-07 |
| `viirs` | Cell-days from the **reference VIIRS satellite** (Suomi-NPP; NOAA-20 if `viirs_start` = 2018-01) | NaN outside the overlap |
| `frp_mean`, `frp_max` | MW, over the month's **MODIS** detections | NaN if MODIS saw nothing |
| `scan_mean`, `pix_km2` | Mean MODIS scan angle (°) and pixel area | as above |
| `day_share` | Share of the month's MODIS detections made in daytime | as above |
| `ndvi` | Monthly NDVI (MOD13A3 or VNP13A3) | NaN if unavailable (recorded in `index.notes`) |

FRP, scan angle and day share must come from **MODIS detections only**. Taken from VIIRS, they would tell the model whether VIIRS saw anything, and that leaks the target. A test guards this.

NASA POWER `t2m`, `precip` and `rh` come from the region files' `context` (contract v1). They are joined by region and month.

## Harmonization table: `data-products/ml/features.parquet`

Every feature of month *t* is an observation **of month *t*** or a climatology from the **training years only**.

| Feature | Definition |
|---|---|
| `log_modis`, `modis_terra`, `modis_aqua` | log(1 + Terra + Aqua), and the two counts |
| `frp_mean`, `frp_max`, `scan_mean`, `pix_km2`, `day_share` | As in the input |
| `lc_code` | Land-cover class code |
| `ndvi`, `ndvi_anom` | NDVI, and NDVI minus the cell's training-year mean for that calendar month |
| `t2m`, `precip`, `rh` | NASA POWER, region-month |
| `precip3_anom` | Rain of months t, t−1, t−2 minus the training-year normal |
| `month_sin`, `month_cos` | Season |
| `region_code` | Preset index |
| `clim_modis` | The cell's training-year median MODIS count for this calendar month |
| `reg_modis`, `nbr_modis` | log(1 + mean MODIS count) over the region / over the 0.25° neighbourhood, same month |
| `reg_terra`, `nbr_terra` | The same, from Terra only (Terra-only head) |
| `y_h` (target) | `viirs` |
| `head` | `ta` (Terra + Aqua) or `t` (Terra only, before 2002-07) |

## FireCast table (built in memory by `firecast_frame`)

The forecast origin is month *t*; the target is month *t + lead*. Every feature uses data up to and including *t*.

| Feature | Definition |
|---|---|
| `lag0_anom`, `lag1_anom`, `lag2_anom` | log((h + 1) / (normal + 1)) at months t, t−1, t−2 |
| `reg_lag0_anom` | Region-level `lag0_anom` (cell model only) |
| `precip3_anom`, `t2m_anom`, `rh_anom`, `ndvi_anom` | Anomalies at t vs climatology-year normals |
| `month_sin`, `month_cos` | Season of the **target** month |
| `clim_log` | log(1 + the unit's normal for the target month) |
| `region_code`, `lc_code` | Identity of the unit |
| `y_f` (target) | 0 below / 1 near / 2 above: month t + lead vs the unit's terciles for that calendar month, from the climatology years only. In leave-one-year-out folds, the held-out year is excluded. |
| `pc0..pc2` | Climatological class frequencies: the C0 reference forecast |
