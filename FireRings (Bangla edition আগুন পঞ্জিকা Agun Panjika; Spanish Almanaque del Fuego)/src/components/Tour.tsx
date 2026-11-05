import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { digits, t, tf } from "@/i18n";
import { useApp } from "@/state/app";
import { useSettings } from "@/state/settings";

const STEPS = [
  { anchor: "#area-search", title: "tour.1_t", body: "tour.1_b" },
  { anchor: "#calendar", title: "tour.2_t", body: "tour.2_b" },
  { anchor: "#kpis", title: "tour.3_t", body: "tour.3_b" },
] as const;

/** First-visit guided tour: 3 steps, skippable, remembered on this device. */
export function Tour() {
  const { lang, index } = useApp();
  const { tourDone, set, reducedMotion } = useSettings();
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const open = !tourDone && !!index;

  useEffect(() => {
    if (open) setStep(0);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const el = document.querySelector(STEPS[step]!.anchor);
    if (el) {
      el.scrollIntoView({ block: "center", behavior: reducedMotion ? "auto" : "smooth" });
      const update = () => setRect(el.getBoundingClientRect());
      update();
      const id = window.setTimeout(update, 350);
      window.addEventListener("resize", update);
      window.addEventListener("scroll", update, true);
      return () => {
        window.clearTimeout(id);
        window.removeEventListener("resize", update);
        window.removeEventListener("scroll", update, true);
      };
    }
    setRect(null);
    return undefined;
  }, [open, step, reducedMotion]);

  useEffect(() => {
    if (open) first.current?.focus();
  }, [open, step]);

  if (!open) return null;
  const s = STEPS[step]!;
  const finish = () => set({ tourDone: true });
  const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
  const vh = typeof window !== "undefined" ? window.innerHeight : 768;
  const w = Math.min(340, vw - 24);
  let style: React.CSSProperties = { left: (vw - w) / 2, top: vh / 2 - 90, width: w };
  if (rect) {
    const below = rect.bottom + 12 + 180 < vh;
    style = {
      width: w,
      left: Math.max(12, Math.min(vw - w - 12, rect.left + rect.width / 2 - w / 2)),
      top: below ? rect.bottom + 12 : Math.max(12, rect.top - 192),
    };
  }

  return (
    <>
      {rect && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed z-[1500] rounded-lg ring-4 ring-[var(--ember)] ring-offset-2 ring-offset-background"
          style={{ left: rect.left - 4, top: rect.top - 4, width: rect.width + 8, height: rect.height + 8 }}
        />
      )}
      <div
        ref={card}
        role="dialog"
        aria-modal="false"
        aria-labelledby="tour-t"
        aria-describedby="tour-b"
        className="fixed z-[1600] rounded-xl border bg-popover p-4 text-popover-foreground shadow-2xl"
        style={style}
        onKeyDown={(e) => e.key === "Escape" && finish()}
      >
        <p className="text-xs text-muted-foreground">{tf(lang, "tour.step", { n: digits(lang, step + 1), total: digits(lang, STEPS.length) })}</p>
        <h2 id="tour-t" className="mt-1 text-base font-semibold">
          {t(lang, s.title)}
        </h2>
        <p id="tour-b" className="mt-1 text-sm">
          {t(lang, s.body)}
        </p>
        <div className="mt-3 flex items-center justify-between gap-2">
          <button type="button" onClick={finish} className="min-h-11 rounded-md px-2 text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground">
            {t(lang, "tour.skip")}
          </button>
          <div className="flex gap-2">
            {step > 0 && (
              <button type="button" onClick={() => setStep(step - 1)} className="min-h-11 rounded-md border border-input px-3 text-sm hover:bg-accent">
                {t(lang, "tour.back")}
              </button>
            )}
            <button
              ref={first}
              type="button"
              onClick={() => (step === STEPS.length - 1 ? finish() : setStep(step + 1))}
              className="min-h-11 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              {step === STEPS.length - 1 ? t(lang, "tour.done") : t(lang, "tour.next")}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
