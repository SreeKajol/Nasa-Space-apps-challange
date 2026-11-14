"""Shared constants for the FireRings Intelligence layer.

Everything that is a choice (seeds, splits, hyper-parameters, labels) lives
here, so a reviewer can audit the method in one place. Hyper-parameters are
fixed a priori; they are never tuned on the test period.
"""

from __future__ import annotations

SEED = 20261105
N_JOBS = 4

TILE_DEG = 2.0  # spatial blocks for cross-validation and ml/grid tiles (= contract grid.tile_deg)
ALPHA = 0.10  # conformal miscoverage -> 90 % intervals / sets
COVERAGE_FLAG = 0.85  # groups below this empirical coverage are flagged

# ---------- harmonization model (M1) ----------
XGB_H = dict(
    objective="count:poisson",
    tree_method="hist",
    n_estimators=350,
    max_depth=6,
    learning_rate=0.06,
    subsample=0.8,
    colsample_bytree=0.8,
    min_child_weight=5.0,
    max_delta_step=0.7,
    reg_lambda=1.0,
)

# Residual-scale model for normalized conformal scores.
XGB_SIGMA = dict(objective="reg:squarederror", tree_method="hist", n_estimators=150, max_depth=4, learning_rate=0.08, subsample=0.8, min_child_weight=20.0)

RF_H = dict(n_estimators=120, max_depth=14, min_samples_leaf=5, max_samples=0.25, max_features=0.5)

# ---------- FireCast ----------
XGB_F_REGION = dict(objective="multi:softprob", num_class=3, tree_method="hist", n_estimators=150, max_depth=3, learning_rate=0.05, subsample=0.9, colsample_bytree=0.9, min_child_weight=3.0, reg_lambda=2.0)
XGB_F_CELL = dict(objective="multi:softprob", num_class=3, tree_method="hist", n_estimators=200, max_depth=5, learning_rate=0.08, subsample=0.8, colsample_bytree=0.8, min_child_weight=20.0, reg_lambda=2.0)
CLASSES = ("below", "near", "above")
N_BOOT = 1000

# ---------- harmonization features ----------
# head "ta": Terra + Aqua available (from 2002-07); head "t": Terra only (2000-11 .. 2002-06).
H_FEATURES_TA = [
    "log_modis",
    "modis_terra",
    "modis_aqua",
    "frp_mean",
    "frp_max",
    "scan_mean",
    "pix_km2",
    "day_share",
    "lc_code",
    "ndvi",
    "ndvi_anom",
    "t2m",
    "precip",
    "rh",
    "precip3_anom",
    "month_sin",
    "month_cos",
    "region_code",
    "clim_modis",
    "reg_modis",
    "nbr_modis",
]
# Terra-only head: no Aqua, and the regional / neighbourhood context from Terra alone.
H_FEATURES_T = [{"reg_modis": "reg_terra", "nbr_modis": "nbr_terra"}.get(f, f) for f in H_FEATURES_TA if f != "modis_aqua"]

# ---------- FireCast features (all observable at the forecast origin) ----------
F_FEATURES = [
    "lag0_anom",
    "lag1_anom",
    "lag2_anom",
    "precip3_anom",
    "t2m_anom",
    "rh_anom",
    "ndvi_anom",
    "month_sin",
    "month_cos",
    "clim_log",
    "region_code",
]
F_FEATURES_CELL = F_FEATURES + ["lc_code", "reg_lag0_anom"]

# Display groups: SHAP of several encoded columns is summed into one human feature.
GROUPS = {"month_sin": "season", "month_cos": "season", "log_modis": "modis_n", "modis_terra": "modis_n", "modis_aqua": "modis_n", "reg_terra": "reg_modis", "nbr_terra": "nbr_modis"}

LANDCOVER = ["cropland", "crop_mosaic", "grassland", "wetland", "shrubland", "savanna", "forest", "mangrove"]

L = lambda en, bn, es: {"en": en, "bn": bn, "es": es}  # noqa: E731

FEATURE_LABELS: dict[str, dict[str, str]] = {
    "modis_n": L("MODIS detections", "MODIS শনাক্তকরণ", "Detecciones MODIS"),
    "modis_terra": L("MODIS Terra detections", "MODIS টেরা শনাক্তকরণ", "Detecciones de MODIS Terra"),
    "modis_aqua": L("MODIS Aqua detections", "MODIS অ্যাকুয়া শনাক্তকরণ", "Detecciones de MODIS Aqua"),
    "frp_mean": L("Average fire intensity (FRP)", "গড় আগুনের তীব্রতা (FRP)", "Intensidad media del fuego (FRP)"),
    "frp_max": L("Strongest fire (max FRP)", "সবচেয়ে তীব্র আগুন (সর্বোচ্চ FRP)", "Fuego más intenso (FRP máx.)"),
    "scan_mean": L("MODIS viewing angle", "MODIS-এর দেখার কোণ", "Ángulo de visión de MODIS"),
    "pix_km2": L("MODIS pixel size", "MODIS পিক্সেলের আকার", "Tamaño de píxel de MODIS"),
    "day_share": L("Share seen in daytime", "দিনে দেখা অংশ", "Proporción vista de día"),
    "lc_code": L("Land cover", "ভূমির আচ্ছাদন", "Cobertura del suelo"),
    "ndvi": L("Vegetation greenness (NDVI)", "গাছপালার সবুজতা (NDVI)", "Verdor de la vegetación (NDVI)"),
    "ndvi_anom": L("Greenness vs normal", "স্বাভাবিকের তুলনায় সবুজতা", "Verdor respecto de lo normal"),
    "t2m": L("Air temperature", "বাতাসের তাপমাত্রা", "Temperatura del aire"),
    "precip": L("Rainfall this month", "এই মাসের বৃষ্টি", "Lluvia del mes"),
    "rh": L("Humidity", "আর্দ্রতা", "Humedad"),
    "precip3_anom": L("Rainfall, last 3 months vs normal", "গত ৩ মাসের বৃষ্টি, স্বাভাবিকের তুলনায়", "Lluvia de los últimos 3 meses respecto de lo normal"),
    "season": L("Time of year", "বছরের সময়", "Época del año"),
    "region_code": L("Region", "অঞ্চল", "Región"),
    "clim_modis": L("Typical MODIS count for this month", "এই মাসে MODIS-এর সাধারণ সংখ্যা", "Recuento típico de MODIS para el mes"),
    "clim_log": L("Typical activity for this month", "এই মাসের স্বাভাবিক মাত্রা", "Actividad típica del mes"),
    "lag0_anom": L("Latest month's fire activity vs normal", "সর্বশেষ মাসের আগুন, স্বাভাবিকের তুলনায়", "Actividad del último mes respecto de lo normal"),
    "lag1_anom": L("Fire activity a month earlier vs normal", "এক মাস আগের আগুন, স্বাভাবিকের তুলনায়", "Actividad de un mes antes respecto de lo normal"),
    "lag2_anom": L("Fire activity two months earlier vs normal", "দুই মাস আগের আগুন, স্বাভাবিকের তুলনায়", "Actividad de dos meses antes respecto de lo normal"),
    "reg_modis": L("MODIS activity across the region this month", "এই মাসে পুরো অঞ্চলে MODIS-এর কার্যকলাপ", "Actividad de MODIS en toda la región este mes"),
    "nbr_modis": L("MODIS activity in nearby cells", "আশপাশের সেলে MODIS-এর কার্যকলাপ", "Actividad de MODIS en celdas cercanas"),
    "reg_lag0_anom": L("Regional fire activity vs normal", "অঞ্চলের আগুন, স্বাভাবিকের তুলনায়", "Actividad regional respecto de lo normal"),
    "t2m_anom": L("Temperature vs normal", "স্বাভাবিকের তুলনায় তাপমাত্রা", "Temperatura respecto de lo normal"),
    "rh_anom": L("Humidity vs normal", "স্বাভাবিকের তুলনায় আর্দ্রতা", "Humedad respecto de lo normal"),
}

# Unit of each feature's displayed value ("x" = ratio to normal, "" = unitless).
FEATURE_UNITS = {
    "modis_n": "cell-days",
    "modis_terra": "cell-days",
    "modis_aqua": "cell-days",
    "frp_mean": "MW",
    "frp_max": "MW",
    "scan_mean": "deg",
    "pix_km2": "km2",
    "day_share": "%",
    "lc_code": "class",
    "ndvi": "",
    "ndvi_anom": "",
    "t2m": "C",
    "precip": "mm",
    "rh": "%",
    "precip3_anom": "mm",
    "season": "month",
    "region_code": "region",
    "clim_modis": "cell-days",
    "reg_modis": "cell-days",
    "nbr_modis": "cell-days per cell",
    "clim_log": "hotspots",
    "lag0_anom": "x",
    "lag1_anom": "x",
    "lag2_anom": "x",
    "reg_lag0_anom": "x",
    "t2m_anom": "C",
    "rh_anom": "%",
}

LANDCOVER_LABELS = {
    "cropland": L("Cropland", "ফসলি জমি", "Cultivos"),
    "crop_mosaic": L("Shifting-cultivation mosaic", "জুম চাষের মিশ্র এলাকা", "Mosaico de cultivo itinerante"),
    "grassland": L("Grassland", "তৃণভূমি", "Pastizal"),
    "wetland": L("Wetland", "জলাভূমি", "Humedal"),
    "shrubland": L("Shrubland", "ঝোপঝাড়", "Matorral"),
    "savanna": L("Savanna", "সাভানা", "Sabana"),
    "forest": L("Forest", "বন", "Bosque"),
    "mangrove": L("Mangrove forest", "ম্যানগ্রোভ বন", "Manglar"),
}
COUNTRY_LABELS = {"BD": L("Bangladesh", "বাংলাদেশ", "Bangladés"), "AR": L("Argentina", "আর্জেন্টিনা", "Argentina")}


def feature_label(key: str) -> dict[str, str]:
    return FEATURE_LABELS.get(key, L(key, key, key))


ACTIVITY_LABELS = {
    "quiet": L("Quiet cell-months (under 0.5)", "শান্ত সেল-মাস (০.৫-এর কম)", "Celdas-mes tranquilas (menos de 0,5)"),
    "low": L("Low activity (0.5–2)", "কম কার্যকলাপ (০.৫–২)", "Actividad baja (0,5–2)"),
    "moderate": L("Moderate activity (2–8)", "মাঝারি কার্যকলাপ (২–৮)", "Actividad moderada (2–8)"),
    "high": L("High activity (over 8)", "উচ্চ কার্যকলাপ (৮-এর বেশি)", "Actividad alta (más de 8)"),
}


def group_label(kind: str, key: str) -> dict[str, str]:
    if kind == "activity":
        return ACTIVITY_LABELS.get(key, L(key, key, key))
    if kind == "landcover":
        return LANDCOVER_LABELS.get(key, L(key, key, key))
    if kind == "country":
        return COUNTRY_LABELS.get(key, L(key, key, key))
    return L(key, key, key)
