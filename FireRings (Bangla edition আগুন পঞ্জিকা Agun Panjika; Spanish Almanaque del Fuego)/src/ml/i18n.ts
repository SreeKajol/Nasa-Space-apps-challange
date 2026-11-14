import { digits, monthName, num, type Lang } from "@/i18n";
import type { Tri } from "@/data/types";
import type { MlIndex } from "./types";

/*
 * Strings of the Intelligence layer: their own en/bn/es dictionaries, loaded
 * on demand together with the ML data (the main bundle does not grow).
 */
export type MlDict = typeof import("./i18n/en.json");
export type MlKey = keyof MlDict;

const LOADERS: Record<Lang, () => Promise<{ default: MlDict }>> = {
  en: () => import("./i18n/en.json"),
  bn: () => import("./i18n/bn.json"),
  es: () => import("./i18n/es.json"),
};
const dicts: Partial<Record<Lang, MlDict>> = {};

export async function loadMlStrings(lang: Lang): Promise<Lang> {
  const need: Lang[] = lang === "en" ? ["en"] : ["en", lang];
  await Promise.all(
    need.filter((l) => !dicts[l]).map(async (l) => (dicts[l] = (await LOADERS[l]()).default)),
  );
  return lang;
}

export function mlStringsLoaded(lang: Lang): boolean {
  return !!dicts.en && !!dicts[lang];
}

export function mt(lang: Lang, key: MlKey): string {
  return dicts[lang]?.[key] ?? dicts.en?.[key] ?? key;
}

export function mtf(lang: Lang, key: MlKey, vars: Record<string, string | number>): string {
  let s = mt(lang, key);
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

/** "91%" / "৯১%" / "91 %". */
export function pct(lang: Lang, share: number, signed = false): string {
  const v = Math.round(share * 100);
  const s = (signed && v > 0 ? "+" : "") + (v < 0 ? "−" : "") + num(lang, Math.abs(v));
  return lang === "es" ? `${s} %` : `${s}%`;
}

/** Signed number with a real minus sign. */
export function signed(lang: Lang, x: number, fd = 2): string {
  const s = num(lang, Math.abs(x), fd);
  return x > 0 ? `+${s}` : x < 0 ? `−${s}` : s;
}

/** exp(shap) - 1 as a signed percentage: the multiplicative effect of a log-scale contribution. */
export function effectPct(lang: Lang, logEffect: number): string {
  return pct(lang, Math.exp(logEffect) - 1, true);
}

export function featureLabel(
  lang: Lang,
  index: MlIndex | null,
  key: string,
  fallback?: Tri,
): string {
  return fallback?.[lang] ?? index?.labels?.features?.[key]?.[lang] ?? key;
}

/** A feature's value with its unit, ready to show next to its bar ("−42 mm", "×1.8 normal"). */
export function featureValue(
  lang: Lang,
  index: MlIndex | null,
  feature: string,
  value: number | string | null | undefined,
): string {
  if (value == null) return "";
  const unit = index?.labels?.units?.[feature] ?? "";
  if (feature === "lc_code")
    return index?.labels?.landcover?.[String(value)]?.[lang] ?? String(value);
  if (feature === "region_code") return String(value);
  if (feature === "season" && typeof value === "number") return monthName(lang, value);
  if (typeof value === "string") return value;
  const anom = feature.endsWith("_anom");
  const u = unit && (`unit.${unit}` as MlKey);
  const uText = u ? mt(lang, u as MlKey) : "";
  if (unit === "x") return `×${num(lang, value, 1)} ${mt(lang, "unit.x").replace("× ", "")}`.trim();
  const fd =
    Math.abs(value) >= 10 || unit === "mm" || unit === "%" ? 0 : Math.abs(value) >= 1 ? 1 : 2;
  const n = anom ? signed(lang, value, fd) : num(lang, value, fd);
  if (unit === "deg") return `${n}°`;
  if (!uText || uText === u) return n;
  return `${n} ${uText}`;
}

export function monthShort(lang: Lang, ym: string): string {
  return `${monthName(lang, Number(ym.slice(5, 7)), true)} ${digits(lang, ym.slice(0, 4))}`;
}
