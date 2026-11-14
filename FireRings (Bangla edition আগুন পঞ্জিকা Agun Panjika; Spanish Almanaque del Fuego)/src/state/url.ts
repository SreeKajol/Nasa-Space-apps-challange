import { useCallback, useMemo, useSyncExternalStore } from "react";
import { DEFAULT_SRC, type DataSrc } from "@/data/provider";
import { isYm, type Polygon } from "@/data/types";
import { MODES, type Mode } from "@/data/view";
import { detectLang, LANG_IDS, type Lang } from "@/i18n";

/*
 * All shareable view state lives in the URL query string, so a link
 * reproduces the exact screen:
 *   ?lang=bn&area=sundarbans&from=2015-01&to=2026-10&mode=viirs&tab=rings&view=anomaly&m=2022-03
 * Defaults are omitted to keep links short.
 */

export const TABS = ["calendar", "rings", "series", "profile", "method", "intel"] as const;
export type Tab = (typeof TABS)[number];
export type Basemap = "sat" | "street";
export type CalView = "counts" | "anomaly";
export type RowMode = "calendar" | "fire";

export interface UrlState {
  lang: Lang;
  tab: Tab;
  /** Preset id, "custom" when `poly` is set, or null (empty state). */
  area: string | null;
  poly: Polygon | null;
  /** Inclusive month range; null = record start / end. */
  from: string | null;
  to: string | null;
  mode: Mode;
  src: DataSrc;
  /** Calendar colouring. */
  view: CalView;
  /** Rows as calendar years or fire years. */
  rows: RowMode;
  /** Month open in the drawer. */
  m: string | null;
  /** Hotspot table year. */
  hy: number | null;
  /** Profile tab: selected year label ("2024" / "2024-25"); null = median year. */
  py: string | null;
  /** Time series: 12-month rolling mean. */
  roll: boolean;
  base: Basemap;
  /** NASA GIBS imagery date (YYYY-MM-DD). */
  gdate: string | null;
  /** Map: FireCast "next-month risk" layer (Intelligence layer). */
  risk: boolean;
}

/** Polygon codec: "lon_lat~lon_lat~…" — URL-safe without escaping. */
export function encodePoly(p: Polygon): string {
  return p.map(([lon, lat]) => `${lon.toFixed(3)}_${lat.toFixed(3)}`).join("~");
}

export function decodePoly(s: string | null): Polygon | null {
  if (!s) return null;
  const pts = s.split("~").map((pair) => pair.split("_").map(Number));
  const ok = pts.length >= 3 && pts.every((p) => p.length === 2 && p.every(Number.isFinite) && Math.abs(p[1]!) <= 90 && Math.abs(p[0]!) <= 180);
  return ok ? (pts as Polygon) : null;
}

let storedLang: Lang | null = null;
function fallbackLang(): Lang {
  if (storedLang) return storedLang;
  try {
    const s = localStorage.getItem("fr-lang");
    if (s === "bn" || s === "en" || s === "es") return (storedLang = s);
  } catch {
    /* private mode */
  }
  return (storedLang = detectLang());
}

const ymOrNull = (s: string | null) => (isYm(s) ? s : null);

export function parseState(search: string): UrlState {
  const q = new URLSearchParams(search);
  const lang = q.get("lang");
  const tab = q.get("tab");
  const mode = q.get("mode");
  const poly = decodePoly(q.get("poly"));
  const hy = Number(q.get("hy"));
  const gdate = q.get("gdate");
  const py = q.get("py");
  return {
    lang: LANG_IDS.includes(lang as Lang) ? (lang as Lang) : fallbackLang(),
    tab: TABS.includes(tab as Tab) ? (tab as Tab) : "calendar",
    area: poly ? "custom" : q.get("area") || null,
    poly,
    from: ymOrNull(q.get("from")),
    to: ymOrNull(q.get("to")),
    mode: MODES.includes(mode as Mode) ? (mode as Mode) : "harmonized",
    src: q.get("src") === "static" ? "static" : q.get("src") === "demo" ? "demo" : DEFAULT_SRC,
    view: q.get("view") === "anomaly" ? "anomaly" : "counts",
    rows: q.get("rows") === "fire" ? "fire" : "calendar",
    m: ymOrNull(q.get("m")),
    hy: Number.isInteger(hy) && hy > 1999 && hy < 2100 ? hy : null,
    py: py && /^\d{4}(-\d{2})?$/.test(py) ? py : null,
    roll: q.get("roll") === "1",
    base: q.get("base") === "street" ? "street" : "sat",
    gdate: gdate && /^\d{4}-\d{2}-\d{2}$/.test(gdate) ? gdate : null,
    risk: q.get("risk") === "1",
  };
}

export function serializeState(s: UrlState): string {
  const q = new URLSearchParams();
  q.set("lang", s.lang);
  if (s.poly) q.set("poly", encodePoly(s.poly));
  else if (s.area) q.set("area", s.area);
  if (s.from) q.set("from", s.from);
  if (s.to) q.set("to", s.to);
  if (s.mode !== "harmonized") q.set("mode", s.mode);
  if (s.tab !== "calendar") q.set("tab", s.tab);
  if (s.view !== "counts") q.set("view", s.view);
  if (s.rows !== "calendar") q.set("rows", s.rows);
  if (s.m) q.set("m", s.m);
  if (s.src !== DEFAULT_SRC) q.set("src", s.src);
  if (s.hy) q.set("hy", String(s.hy));
  if (s.py) q.set("py", s.py);
  if (s.roll) q.set("roll", "1");
  if (s.base !== "sat") q.set("base", s.base);
  if (s.gdate) q.set("gdate", s.gdate);
  if (s.risk) q.set("risk", "1");
  return `?${q.toString()}`;
}

const EVT = "fr:urlchange";
function subscribe(cb: () => void): () => void {
  window.addEventListener("popstate", cb);
  window.addEventListener(EVT, cb);
  return () => {
    window.removeEventListener("popstate", cb);
    window.removeEventListener(EVT, cb);
  };
}
const getSearch = () => window.location.search;

/** Keys whose change gets a browser-history entry, so Back works for them. */
const PUSH_KEYS: (keyof UrlState)[] = ["tab", "area", "poly"];

export type SetUrl = (patch: Partial<UrlState>) => void;

export function setUrlState(patch: Partial<UrlState>): void {
  const cur = parseState(window.location.search);
  const next = { ...cur, ...patch };
  if (patch.lang) {
    storedLang = patch.lang;
    try {
      localStorage.setItem("fr-lang", patch.lang);
    } catch {
      /* private mode */
    }
  }
  const url = serializeState(next) + window.location.hash;
  if (url === window.location.search + window.location.hash) return;
  const push = PUSH_KEYS.some((k) => k in patch && JSON.stringify(patch[k]) !== JSON.stringify(cur[k]));
  if (push) window.history.pushState(null, "", url);
  else window.history.replaceState(null, "", url);
  window.dispatchEvent(new Event(EVT));
}

export function useUrlState(): [UrlState, SetUrl] {
  const search = useSyncExternalStore(subscribe, getSearch, () => "");
  const state = useMemo(() => parseState(search), [search]);
  const set = useCallback((patch: Partial<UrlState>) => setUrlState(patch), []);
  return [state, set];
}

/** Absolute link to the live view for the current state (used by QR + share). */
export function liveViewUrl(s: UrlState, page = ""): string {
  const base = new URL(page || ".", window.location.href.replace(/almanac\/?(\?.*)?$/, ""));
  return base.href.split("?")[0] + serializeState({ ...s, m: null });
}
