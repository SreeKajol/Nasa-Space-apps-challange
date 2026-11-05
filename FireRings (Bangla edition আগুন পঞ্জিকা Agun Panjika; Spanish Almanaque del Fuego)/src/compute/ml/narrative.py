"""Grounded narrative: plain-language sentences in EN / BN / ES built ONLY from
computed fields. No model writes any number.

Optional LLM polishing is OFF by default. If a caller passes an `llm`
function, its text is accepted only when `numbers_grounded` confirms that
every number in it appears in the source facts; otherwise the template text
is kept.
"""

from __future__ import annotations

import re
from typing import Any, Callable, Iterable

from .config import FEATURE_UNITS, feature_label, group_label

LANGS = ("en", "bn", "es")
BN_DIGITS = "০১২৩৪৫৬৭৮৯"
MONTHS = {
    "en": ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
    "bn": ["জানুয়ারি", "ফেব্রুয়ারি", "মার্চ", "এপ্রিল", "মে", "জুন", "জুলাই", "আগস্ট", "সেপ্টেম্বর", "অক্টোবর", "নভেম্বর", "ডিসেম্বর"],
    "es": ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
}
CAT = {
    "en": {"below": "below-normal", "near": "near-normal", "above": "above-normal"},
    "bn": {"below": "স্বাভাবিকের চেয়ে কম", "near": "স্বাভাবিকের কাছাকাছি", "above": "স্বাভাবিকের চেয়ে বেশি"},
    "es": {"below": "por debajo de lo normal", "near": "cerca de lo normal", "above": "por encima de lo normal"},
}
SET_WORD = {"en": {"below": "below", "near": "near", "above": "above"}, "bn": {"below": "কম", "near": "কাছাকাছি", "above": "বেশি"}, "es": {"below": "por debajo", "near": "normal", "above": "por encima"}}
OR = {"en": " or ", "bn": " বা ", "es": " o "}
AND = {"en": " and ", "bn": " এবং ", "es": " y "}

T = {
    "skilful": {
        "en": "{month}: {cat} fire activity is most likely ({p}; likely: {set}). Main drivers: {drivers}. Forecast skill here: better than climatology (RPSS {rpss}).",
        "bn": "{month}: {cat} আগুনের সম্ভাবনাই সবচেয়ে বেশি ({p}; সম্ভাব্য: {set})। প্রধান কারণ: {drivers}। এখানে পূর্বাভাসের দক্ষতা: সাধারণ ধারার চেয়ে ভালো (RPSS {rpss})।",
        "es": "{month}: lo más probable es una actividad de fuego {cat} ({p}; probable: {set}). Factores principales: {drivers}. Habilidad del pronóstico aquí: mejor que la climatología (RPSS {rpss}).",
    },
    "unskilful": {
        "en": "{month}: no reliable outlook. In past years this forecast did not beat the usual pattern here (RPSS {rpss}).",
        "bn": "{month}: নির্ভরযোগ্য পূর্বাভাস নেই। আগের বছরগুলোতে এই পূর্বাভাস এখানে সাধারণ ধারার চেয়ে ভালো করেনি (RPSS {rpss})।",
        "es": "{month}: no hay un pronóstico fiable. En años anteriores este pronóstico no superó el patrón habitual aquí (RPSS {rpss}).",
    },
    "frp": {
        "en": "Small, cool fires are the ones MODIS misses most: below {hi} MW, VIIRS sees {pct} more fires per MODIS detection than average.",
        "bn": "ছোট, কম তাপের আগুনই MODIS সবচেয়ে বেশি মিস করে: {hi} মেগাওয়াটের নিচে প্রতিটি MODIS শনাক্তকরণের বিপরীতে VIIRS গড়ের চেয়ে {pct} বেশি আগুন দেখে।",
        "es": "Los fuegos pequeños y poco intensos son los que MODIS más pasa por alto: por debajo de {hi} MW, VIIRS ve {pct} más fuegos por cada detección de MODIS que el promedio.",
    },
    "frp_other": {
        "en": "Fire intensity changes how many fires VIIRS sees per MODIS detection by up to {pct} (strongest at {bin}).",
        "bn": "আগুনের তীব্রতা প্রতিটি MODIS শনাক্তকরণের বিপরীতে VIIRS কতগুলো আগুন দেখে তা সর্বোচ্চ {pct} পর্যন্ত বদলায় ({bin}-এ সবচেয়ে বেশি)।",
        "es": "La intensidad del fuego cambia hasta en {pct} cuántos fuegos ve VIIRS por cada detección de MODIS (sobre todo en {bin}).",
    },
    "scan": {
        "en": "At wide MODIS viewing angles ({bin}) its pixels grow, so VIIRS sees {pct} more fires per MODIS detection than average.",
        "bn": "MODIS-এর দেখার কোণ বড় হলে ({bin}) পিক্সেল বড় হয়, তাই প্রতিটি MODIS শনাক্তকরণের বিপরীতে VIIRS গড়ের চেয়ে {pct} বেশি আগুন দেখে।",
        "es": "Con ángulos de visión amplios de MODIS ({bin}) sus píxeles crecen, así que VIIRS ve {pct} más fuegos por cada detección de MODIS que el promedio.",
    },
    "landcover": {
        "en": "Land cover matters too: in {lc} VIIRS sees {pct} more fires per MODIS detection than average.",
        "bn": "ভূমির আচ্ছাদনও গুরুত্বপূর্ণ: {lc}-এ প্রতিটি MODIS শনাক্তকরণের বিপরীতে VIIRS গড়ের চেয়ে {pct} বেশি আগুন দেখে।",
        "es": "La cobertura del suelo también importa: en {lc} VIIRS ve {pct} más fuegos por cada detección de MODIS que el promedio.",
    },
}


def digits(lang: str, s: str) -> str:
    return re.sub(r"\d", lambda m: BN_DIGITS[int(m.group())], s) if lang == "bn" else s


def fmt_num(lang: str, x: float, nd: int = 0, signed: bool = False) -> str:
    s = f"{abs(x):,.{nd}f}"
    if lang == "es":
        s = s.replace(",", "§").replace(".", ",").replace("§", ".")
    sign = ("+" if x > 0 else "−" if x < 0 else "") if signed else ("−" if x < 0 else "")
    return digits(lang, sign + s)


def pct(lang: str, share: float, signed: bool = False) -> str:
    v = round(share * 100)
    s = fmt_num(lang, v, 0, signed)
    return f"{s} %" if lang == "es" else f"{s}%"


def month_year(lang: str, ym: str) -> str:
    y, m = int(ym[:4]), int(ym[5:7])
    name = MONTHS[lang][m - 1]
    if lang == "es":
        return f"{name} de {y}"
    return f"{name} {digits(lang, str(y))}"


def value_text(lang: str, feature: str, value: Any) -> str:
    unit = FEATURE_UNITS.get(feature, "")
    if value is None:
        return ""
    if feature == "lc_code":
        return group_label("landcover", str(value))[lang]
    if feature == "season":
        return MONTHS[lang][int(value) - 1]
    if isinstance(value, str):
        return value
    if unit == "x":
        return "×" + fmt_num(lang, value, 1)
    if unit == "mm":
        return f"{fmt_num(lang, value, 0, signed=feature.endswith('anom'))} mm"
    if unit == "C":
        return f"{fmt_num(lang, value, 1, signed=feature.endswith('anom'))} °C"
    if unit == "%":
        return f"{fmt_num(lang, value, 0, signed=feature.endswith('anom'))} %"
    if unit == "MW":
        return f"{fmt_num(lang, value, 1)} MW"
    if feature == "ndvi_anom":
        return fmt_num(lang, value, 2, signed=True)
    return fmt_num(lang, value, 1)


def driver_text(lang: str, d: dict[str, Any]) -> str:
    label = feature_label(d["feature"])[lang]
    v = value_text(lang, d["feature"], d.get("value"))
    arrow = "↑" if d["contrib"] > 0 else "↓"
    return f"{arrow} {label}" + (f" ({v})" if v else "")


def forecast_sentence(lang: str, f: dict[str, Any]) -> str:
    month = month_year(lang, f["ym"])
    month = month[0].upper() + month[1:]
    r = f["rpss"] if f.get("rpss") is not None else 0.0
    rpss = fmt_num(lang, r, 2 if abs(r) >= 0.01 else 3)
    if not f.get("skilful"):
        return T["unskilful"][lang].format(month=month, rpss=rpss)
    k = int(max(range(3), key=lambda i: f["p"][i]))
    cat_key = ("below", "near", "above")[k]
    sets = OR[lang].join(SET_WORD[lang][s] for s in f["set"])
    drivers = AND[lang].join(driver_text(lang, d) for d in f["drivers"][:2])
    return T["skilful"][lang].format(month=month, cat=CAT[lang][cat_key], p=pct(lang, f["p"][k]), set=sets, drivers=drivers, rpss=rpss)


def dependence_takeaways(dep: dict[str, list[dict[str, Any]]]) -> dict[str, dict[str, str]]:
    """One sentence per dependence chart, computed from the binned SHAP tables."""
    import math

    out: dict[str, dict[str, str]] = {}
    frp = dep.get("frp_mean") or []
    if frp:
        top = max(frp, key=lambda r: r["shap"])
        share = math.exp(top["shap"]) - 1
        if top["shap"] > 0 and frp.index(top) <= 1 and top.get("hi") is not None:
            out["frp_mean"] = {L: T["frp"][L].format(hi=fmt_num(L, top["hi"]), pct=pct(L, share)) for L in LANGS}
        else:
            out["frp_mean"] = {L: T["frp_other"][L].format(bin=digits(L, top["bin"]), pct=pct(L, abs(share))) for L in LANGS}
    scan = dep.get("scan_mean") or []
    if scan:
        top = max(scan, key=lambda r: r["shap"])
        if top["shap"] > 0:
            out["scan_mean"] = {L: T["scan"][L].format(bin=digits(L, top["bin"].replace("deg", "°")), pct=pct(L, math.exp(top["shap"]) - 1)) for L in LANGS}
    lc = dep.get("landcover") or []
    if lc:
        top = max(lc, key=lambda r: r["shap"])
        if top["shap"] > 0:
            out["landcover"] = {L: T["landcover"][L].format(lc=group_label("landcover", top["bin"])[L], pct=pct(L, math.exp(top["shap"]) - 1)) for L in LANGS}
    return out


# ---------------------------------------------------------------- grounding guard

_NUM = re.compile(r"\d+(?:[.,]\d+)*")


def _ascii(s: str) -> str:
    return "".join(str(BN_DIGITS.index(c)) if c in BN_DIGITS else c for c in s)


def _norm(token: str) -> str:
    """'1,234.5' / '1.234,5' / '১২৩' -> canonical float string."""
    t = _ascii(token)
    if "," in t and "." in t:
        t = t.replace(",", "") if t.rfind(".") > t.rfind(",") else t.replace(".", "").replace(",", ".")
    elif "," in t:
        t = t.replace(",", "") if re.fullmatch(r"\d{1,3}(,\d{3})+", t) else t.replace(",", ".")
    elif re.fullmatch(r"\d{1,3}(\.\d{3})+", t):
        t = t.replace(".", "")
    try:
        return repr(float(t))
    except ValueError:
        return t


def numbers_in(text: str) -> list[str]:
    return [_norm(m.group()) for m in _NUM.finditer(_ascii(text))]


def numbers_grounded(text: str, facts: Iterable[str]) -> bool:
    allowed = set()
    for f in facts:
        allowed.update(numbers_in(str(f)))
    return all(n in allowed for n in numbers_in(text))


def polish(text: str, facts: Iterable[str], llm: Callable[[str], str] | None = None) -> str:
    """OFF by default (llm=None). With an llm, keep its text only if every number is grounded."""
    if llm is None:
        return text
    facts = list(facts) + [text]
    candidate = llm(text)
    return candidate if numbers_grounded(candidate, facts) else text
