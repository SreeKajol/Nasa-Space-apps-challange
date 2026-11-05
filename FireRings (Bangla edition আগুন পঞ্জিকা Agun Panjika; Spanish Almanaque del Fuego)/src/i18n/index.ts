import { parseYm } from "@/data/types";
import en from "./en.json";

/*
 * i18n: all UI strings live in en.json / bn.json / es.json. Sentences that
 * contain data are templates with {placeholders}, filled with values already
 * formatted for the language (Bangla digits when bn is active).
 */

export type Lang = "bn" | "en" | "es";
export const LANG_IDS: Lang[] = ["en", "bn", "es"];

export const LANGS: { id: Lang; label: string; short: string; bcp47: string }[] = [
  { id: "en", label: "English", short: "EN", bcp47: "en" },
  { id: "bn", label: "বাংলা", short: "বাংলা", bcp47: "bn-BD" },
  { id: "es", label: "Español", short: "ES", bcp47: "es-AR" },
];

export type StrKey = keyof typeof en;

/*
 * English ships in the main bundle (it is also the fallback); Bangla and
 * Spanish are separate chunks loaded on demand, and before first render
 * when the page opens in that language.
 */
const DICT: Record<Lang, Partial<Record<StrKey, string>>> = { en, bn: {}, es: {} };
const LOADERS: Record<Exclude<Lang, "en">, () => Promise<{ default: Partial<Record<StrKey, string>> }>> = {
  bn: () => import("./bn.json"),
  es: () => import("./es.json"),
};
const loaded = new Set<Lang>(["en"]);

export function isLangLoaded(lang: Lang): boolean {
  return loaded.has(lang);
}

export async function loadLang(lang: Lang): Promise<void> {
  if (loaded.has(lang)) return;
  const mod = await LOADERS[lang as Exclude<Lang, "en">]();
  DICT[lang] = mod.default;
  loaded.add(lang);
}

const LOCALE: Record<Lang, string> = { bn: "bn-BD", en: "en-US", es: "es-AR" };

export function t(lang: Lang, key: StrKey): string {
  return DICT[lang][key] ?? en[key];
}

/** Translate with {var} substitution. */
export function tf(lang: Lang, key: StrKey, vars: Record<string, string | number>): string {
  let out = t(lang, key);
  for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
  return out;
}

export const MONTHS_SHORT: Record<Lang, string[]> = {
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  bn: ["জানু", "ফেব্রু", "মার্চ", "এপ্রি", "মে", "জুন", "জুলা", "আগ", "সেপ্টে", "অক্টো", "নভে", "ডিসে"],
  es: ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"],
};

export const MONTHS_LONG: Record<Lang, string[]> = {
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  bn: ["জানুয়ারি", "ফেব্রুয়ারি", "মার্চ", "এপ্রিল", "মে", "জুন", "জুলাই", "আগস্ট", "সেপ্টেম্বর", "অক্টোবর", "নভেম্বর", "ডিসেম্বর"],
  es: ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
};

/* ---------- formatting ---------- */

const nfCache = new Map<string, Intl.NumberFormat>();
function nf(lang: Lang, digits: number, extra: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  const k = `${lang}:${digits}:${JSON.stringify(extra)}`;
  let f = nfCache.get(k);
  if (!f) {
    f = new Intl.NumberFormat(LOCALE[lang], { minimumFractionDigits: digits, maximumFractionDigits: digits, ...extra });
    nfCache.set(k, f);
  }
  return f;
}

const BN_DIGITS = "০১২৩৪৫৬৭৮৯";
/** Localize ASCII digits in an already-built label (years, seasons, dates). */
export function digits(lang: Lang, s: string | number): string {
  const str = String(s);
  return lang === "bn" ? str.replace(/\d/g, (d) => BN_DIGITS[Number(d)]!) : str;
}

/** Locale number: "1,234" / "১,২৩৪" / "1.234". */
export function num(lang: Lang, n: number | null | undefined, fractionDigits = 0): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return digits(lang, nf(lang, fractionDigits).format(n));
}

/** Compact number for axes: "1.2k". */
export function numCompact(lang: Lang, n: number): string {
  return digits(lang, new Intl.NumberFormat(LOCALE[lang], { notation: "compact", maximumFractionDigits: 1 }).format(n));
}

export function pctStr(lang: Lang, share01: number): string {
  return digits(lang, nf(lang, 0, { style: "percent" }).format(share01));
}

export function signedPct(lang: Lang, ratio: number): string {
  if (!Number.isFinite(ratio)) return "—";
  return digits(lang, nf(lang, 0, { style: "percent", signDisplay: "exceptZero" }).format(ratio));
}

export function monthName(lang: Lang, m: number, short = false): string {
  return (short ? MONTHS_SHORT : MONTHS_LONG)[lang][m - 1] ?? "";
}

/** "March 2026" / "মার্চ ২০২৬" / "marzo de 2026" */
export function monthYear(lang: Lang, ym: string, short = false): string {
  const { y, m } = parseYm(ym);
  const name = monthName(lang, m, short);
  if (lang === "es" && !short) return `${name} de ${y}`;
  return `${name} ${digits(lang, y)}`;
}

/** "15 February 2026" style. */
export function dateLong(lang: Lang, iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const name = monthName(lang, m ?? 1);
  if (lang === "es") return `${d} de ${name} de ${y}`;
  return `${digits(lang, d ?? 0)} ${name} ${digits(lang, y ?? 0)}`;
}

export function capFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function ordinal(lang: Lang, n: number): string {
  if (lang === "bn") {
    const special: Record<number, string> = { 1: "১ম", 2: "২য়", 3: "৩য়", 4: "৪র্থ", 5: "৫ম", 6: "৬ষ্ঠ" };
    return special[n] ?? `${digits("bn", n)}তম`;
  }
  if (lang === "es") return `${n}.º`;
  const m100 = n % 100;
  const m10 = n % 10;
  const suf = m100 >= 11 && m100 <= 13 ? "th" : m10 === 1 ? "st" : m10 === 2 ? "nd" : m10 === 3 ? "rd" : "th";
  return `${n}${suf}`;
}

/** "412 hotspots (380–450)". The interval is omitted when there is none. */
export function valueWithRange(lang: Lang, value: number | null, low: number | null, high: number | null, unit: string): string {
  if (value == null) return "—";
  const v = `${num(lang, value)} ${unit}`;
  if (low == null || high == null || (Math.round(low) === Math.round(value) && Math.round(high) === Math.round(value))) return v;
  return `${v} (${num(lang, low)}–${num(lang, high)})`;
}

/** "March–April" for consecutive months, "March and May" otherwise. */
export function monthList(lang: Lang, months: number[]): string {
  if (months.length === 0) return "—";
  if (months.length === 1) return monthName(lang, months[0]!);
  const consecutive = months.every((m, i) => i === 0 || m === (months[i - 1]! % 12) + 1);
  if (consecutive) return `${monthName(lang, months[0]!)}–${monthName(lang, months[months.length - 1]!)}`;
  return months.slice(0, -1).map((m) => monthName(lang, m)).join(", ") + t(lang, "list.and") + monthName(lang, months[months.length - 1]!);
}

export function detectLang(): Lang {
  if (typeof navigator === "undefined") return "en";
  for (const l of navigator.languages ?? [navigator.language]) {
    const p = l.slice(0, 2).toLowerCase();
    if (p === "bn" || p === "es" || p === "en") return p;
  }
  return "en";
}
