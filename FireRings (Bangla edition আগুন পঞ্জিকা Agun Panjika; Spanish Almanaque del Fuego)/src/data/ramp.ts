/*
 * Perceptually uniform, colour-blind-safe ramps.
 * - "inferno": dark → yellow; the default fire-intensity ramp.
 * - "cividis": alternative in settings for maximum colour-blind safety.
 * Light theme reverses lightness, so extremes are the darkest ink on paper.
 * Anomalies use a diverging ramp: blue = below, neutral = normal, ember = above.
 */

const INFERNO = ["#000004", "#1b0c41", "#4a0c6b", "#781c6d", "#a52c60", "#cf4446", "#ed6925", "#fb9b06", "#f7d03c", "#fcffa4"];
const CIVIDIS = ["#00224e", "#123570", "#3b496c", "#575d6d", "#707173", "#8a8779", "#a69d75", "#c4b56c", "#e4cf5b", "#ffea46"];

export type RampName = "inferno" | "cividis";

const STOPS: Record<RampName, string[]> = { inferno: INFERNO, cividis: CIVIDIS };

function hexToRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

function sample(stops: string[], t: number): string {
  const x = Math.min(0.9999, Math.max(0, t)) * (stops.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = hexToRgb(stops[i]!);
  const b = hexToRgb(stops[i + 1] ?? stops[i]!);
  const c = a.map((v, k) => Math.round(v + (b[k]! - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/**
 * Dark theme skips the near-black stop so low values stay visible on slate;
 * light theme runs the full ramp reversed, so quiet months stay pale on paper
 * and extremes are the darkest ink.
 */
function ordered(ramp: RampName, dark: boolean): string[] {
  const s = STOPS[ramp];
  return dark ? s.slice(1) : [...s].reverse();
}

/** Colour for a 0..1 intensity (usually percentile / 100). */
export function intensityColor(t01: number, ramp: RampName, dark: boolean): string {
  return sample(ordered(ramp, dark), t01);
}

/** CSS gradient for legends, matching intensityColor. */
export function rampGradient(ramp: RampName, dark: boolean): string {
  const o = ordered(ramp, dark);
  return `linear-gradient(90deg, ${o.map((c, i) => `${c} ${Math.round((i / (o.length - 1)) * 100)}%`).join(", ")})`;
}

const DIV_LIGHT = ["#2166ac", "#6a9fcf", "#c9d6e3", "#e8e4dc", "#f2c9a8", "#e0773a", "#b2400e"];
const DIV_DARK = ["#5a9be0", "#3f6d9e", "#33445a", "#3a3d45", "#6b4630", "#c4652a", "#f39a4c"];

/** Diverging colour for a z-score (clamped to ±2.5). */
export function divergingColor(z: number, dark: boolean): string {
  const t = (Math.max(-2.5, Math.min(2.5, z)) + 2.5) / 5;
  return sample(dark ? DIV_DARK : DIV_LIGHT, t);
}

export function divergingGradient(dark: boolean): string {
  const s = dark ? DIV_DARK : DIV_LIGHT;
  return `linear-gradient(90deg, ${s.map((c, i) => `${c} ${Math.round((i / (s.length - 1)) * 100)}%`).join(", ")})`;
}
