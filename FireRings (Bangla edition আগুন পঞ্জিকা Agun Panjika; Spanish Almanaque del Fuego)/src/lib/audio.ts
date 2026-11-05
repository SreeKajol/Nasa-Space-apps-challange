/*
 * Web Audio helpers for "Hear the season": one soft tone per month, pitch
 * mapped to fire activity (higher = more fire). Works offline.
 */

let ctx: AudioContext | null = null;

export function audioAvailable(): boolean {
  return typeof window !== "undefined" && ("AudioContext" in window || "webkitAudioContext" in window);
}

function context(): AudioContext | null {
  if (!audioAvailable()) return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new AC();
  }
  void ctx.resume();
  return ctx;
}

/** Activity share 0..1 → frequency on a two-octave pentatonic-ish log scale (220–880 Hz). */
export function pitchFor(share01: number): number {
  const s = Math.max(0, Math.min(1, share01));
  return 220 * Math.pow(4, s);
}

/** Play one soft tone. Zero activity plays a very quiet low "tick" so the beat stays audible. */
export function playTone(freq: number, seconds: number, quiet = false): void {
  const ac = context();
  if (!ac) return;
  const t0 = ac.currentTime + 0.01;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, t0);
  const peak = quiet ? 0.03 : 0.16;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.03);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + seconds * 0.92);
  osc.connect(g).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + seconds);
}
