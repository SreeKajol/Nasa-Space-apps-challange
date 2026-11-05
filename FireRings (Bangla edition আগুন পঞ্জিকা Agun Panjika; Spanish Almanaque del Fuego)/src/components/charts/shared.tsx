import { useCallback, useState, type KeyboardEvent } from "react";
import { intensityColor, divergingColor, type RampName } from "@/data/ramp";
import type { ViewPoint } from "@/data/view";

/** Roving "active cell" for keyboard navigation over a rows × cols grid. */
export function useGridNav(rows: number, cols: number, onEnter: (r: number, c: number) => void) {
  const [pos, setPos] = useState<{ r: number; c: number } | null>(null);
  const onKeyDown = useCallback(
    (e: KeyboardEvent, opts: { upIsPrev?: boolean } = {}) => {
      if (rows === 0) return;
      const cur = pos ?? { r: 0, c: 0 };
      let { r, c } = cur;
      const up = opts.upIsPrev === false ? 1 : -1;
      switch (e.key) {
        case "ArrowLeft":
          c = (c + cols - 1) % cols;
          break;
        case "ArrowRight":
          c = (c + 1) % cols;
          break;
        case "ArrowUp":
          r = Math.min(rows - 1, Math.max(0, r + up));
          break;
        case "ArrowDown":
          r = Math.min(rows - 1, Math.max(0, r - up));
          break;
        case "Home":
          c = 0;
          break;
        case "End":
          c = cols - 1;
          break;
        case "PageUp":
          r = 0;
          break;
        case "PageDown":
          r = rows - 1;
          break;
        case "Enter":
        case " ":
          e.preventDefault();
          onEnter(cur.r, cur.c);
          return;
        default:
          return;
      }
      e.preventDefault();
      setPos({ r, c });
    },
    [pos, rows, cols, onEnter],
  );
  return { pos, setPos, onKeyDown };
}

/** Gamma for the count scale: between sqrt and linear, so small months stay visible but quiet. */
export const COUNT_GAMMA = 0.7;

/** Count → colour on the sequential ramp. */
export function countColor(v: number, max: number, ramp: RampName, dark: boolean): string {
  return intensityColor(max > 0 ? Math.pow(Math.max(0, v) / max, COUNT_GAMMA) : 0, ramp, dark);
}

/** Anomaly vs median: log2 ratio, ±2 (¼×…4×) → diverging ramp. */
export function anomalyT(v: number, median: number): number {
  const r = (v + 0.5) / (median + 0.5);
  return Math.max(-1, Math.min(1, Math.log2(r) / 2));
}

export function anomalyColor(v: number, median: number, dark: boolean): string {
  return divergingColor(anomalyT(v, median) * 2.5, dark);
}

export function maxValue(points: (ViewPoint | null)[]): number {
  let m = 0;
  for (const p of points) if (p && p.value != null && !p.partial && p.value > m) m = p.value;
  return m;
}

export function ChartTooltip({ tip }: { tip: { x: number; y: number; text: string } | null }) {
  if (!tip) return null;
  return (
    <div className="chart-tip" style={{ left: tip.x, top: tip.y, transform: "translate(-50%, calc(-100% - 10px))" }} aria-hidden="true">
      {tip.text}
    </div>
  );
}
