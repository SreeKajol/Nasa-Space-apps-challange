import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { RampName } from "@/data/ramp";

/* Device-level preferences (not part of shareable links), kept in localStorage. */

export type ThemeMode = "system" | "light" | "dark";

interface Prefs {
  theme: ThemeMode;
  ramp: RampName;
  /** Demo-only test switch for index.viirs_start. */
  viirsStart: "2012-01" | "2018-01";
  /** Low-literacy mode: three big icon cards. */
  simple: boolean;
  tourDone: boolean;
}

interface Settings extends Prefs {
  dark: boolean;
  reducedMotion: boolean;
  set(patch: Partial<Prefs>): void;
}

const DEFAULTS: Prefs = { theme: "system", ramp: "inferno", viirsStart: "2012-01", simple: false, tourDone: false };
const KEY = "fr-prefs";

function load(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>;
    const legacyTheme = localStorage.getItem("fr-theme");
    return {
      theme: raw.theme === "light" || raw.theme === "dark" ? raw.theme : legacyTheme === "light" || legacyTheme === "dark" ? legacyTheme : "system",
      ramp: raw.ramp === "cividis" ? "cividis" : "inferno",
      viirsStart: raw.viirsStart === "2018-01" ? "2018-01" : "2012-01",
      simple: raw.simple === true,
      tourDone: raw.tourDone === true,
    };
  } catch {
    return DEFAULTS;
  }
}

const Ctx = createContext<Settings>({ ...DEFAULTS, dark: false, reducedMotion: false, set() {} });

export function useMedia(query: string): boolean {
  const [m, setM] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = (e: MediaQueryListEvent) => setM(e.matches);
    setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return m;
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Prefs>(load);
  const systemDark = useMedia("(prefers-color-scheme: dark)");
  const reducedMotion = useMedia("(prefers-reduced-motion: reduce)");
  const dark = prefs.theme === "dark" || (prefs.theme === "system" && systemDark);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
    try {
      localStorage.setItem("fr-theme", prefs.theme);
    } catch {
      /* private mode */
    }
  }, [dark, prefs.theme]);

  const value = useMemo<Settings>(
    () => ({
      ...prefs,
      dark,
      reducedMotion,
      set(patch) {
        setPrefs((p) => {
          const next = { ...p, ...patch };
          try {
            localStorage.setItem(KEY, JSON.stringify(next));
          } catch {
            /* private mode */
          }
          return next;
        });
      },
    }),
    [prefs, dark, reducedMotion],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSettings(): Settings {
  return useContext(Ctx);
}
