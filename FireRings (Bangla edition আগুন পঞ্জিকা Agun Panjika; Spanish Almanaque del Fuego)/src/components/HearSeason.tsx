import { Pause, Play, Volume2 } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { audioAvailable, pitchFor, playTone } from "@/lib/audio";
import { baseMode, monthOrder, yearRows } from "@/data/view";
import { digits, monthName, num, t, tf } from "@/i18n";
import { unitFor } from "@/i18n/summaries";
import { useApp } from "@/state/app";
import { cn } from "@/lib/utils";

const SPEEDS = { slow: 0.6, normal: 0.4, fast: 0.25 } as const;
type Speed = keyof typeof SPEEDS;

/**
 * "Hear the season": the selected year (or the median year) as 12 notes, one
 * per month, pitch = activity. Each month is announced via aria-live as it plays.
 */
export function HearSeason({ compact = false }: { compact?: boolean }) {
  const { view, rowStart, lang, url } = useApp();
  const id = useId();
  const rows = useMemo(() => (view ? yearRows(view.points, rowStart) : []), [view, rowStart]);
  const order = useMemo(() => monthOrder(rowStart), [rowStart]);
  const [year, setYear] = useState<string>("median");
  const [speed, setSpeed] = useState<Speed>("normal");
  const [playing, setPlaying] = useState(false);
  const [idx, setIdx] = useState(0);
  const [announce, setAnnounce] = useState("");
  const timer = useRef<number | null>(null);

  const values = useMemo<(number | null)[]>(() => {
    if (!view) return [];
    if (year === "median") return order.map((m) => view.climatology[m - 1]?.median ?? 0);
    const row = rows.find((r) => r.label === year);
    return row ? row.cells.map((c) => (c && !c.partial ? c.value : null)) : [];
  }, [view, year, rows, order]);

  // One pitch scale for the whole record, so years can be compared by ear.
  const max = useMemo(() => {
    let m = 1;
    for (const r of rows) for (const c of r.cells) if (c?.value != null && !c.partial && c.value > m) m = c.value;
    return m;
  }, [rows]);

  useEffect(() => () => void (timer.current != null && window.clearTimeout(timer.current)), []);
  useEffect(() => {
    // Stop when the data changes underneath.
    setPlaying(false);
    setIdx(0);
  }, [values]);

  useEffect(() => {
    if (!playing) return;
    if (idx >= 12) {
      setPlaying(false);
      setIdx(0);
      return;
    }
    const v = values[idx];
    const m = order[idx]!;
    const unit = unitFor(lang, baseMode(url.mode));
    setAnnounce(tf(lang, "hear.note", { month: monthName(lang, m), value: v == null ? t(lang, "cal.no_data") : `${num(lang, v)} ${unit}` }));
    if (v != null) playTone(pitchFor(Math.sqrt(v / max)), SPEEDS[speed], v === 0);
    timer.current = window.setTimeout(() => setIdx((i) => i + 1), SPEEDS[speed] * 1000);
    return () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    };
  }, [playing, idx, values, order, speed, max, lang, url.mode]);

  if (!view) return null;
  if (!audioAvailable()) return <p className="text-xs text-muted-foreground">{t(lang, "hear.unavailable")}</p>;

  const options = [...rows].reverse().filter((r) => r.cells.some((c) => c && !c.partial && c.value != null));

  return (
    <div className={cn("flex flex-wrap items-center gap-2", compact ? "" : "rounded-md border p-2")} role="group" aria-labelledby={`${id}-t`}>
      <span id={`${id}-t`} className={cn("inline-flex items-center gap-1.5 text-sm font-medium", compact && "sr-only")}>
        <Volume2 className="size-4" aria-hidden="true" />
        {t(lang, "hear.title")}
      </span>
      <p id={`${id}-x`} className="sr-only">
        {t(lang, "hear.explain")}
      </p>
      <button
        type="button"
        onClick={() => setPlaying((p) => !p)}
        aria-describedby={`${id}-x`}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90"
      >
        {playing ? <Pause className="size-4" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
        {playing ? t(lang, "hear.pause") : t(lang, "hear.play")}
      </button>
      <label className="inline-flex items-center gap-1.5 text-xs">
        <span className="text-muted-foreground">{t(lang, "hear.year")}</span>
        <select className="field min-h-11 text-sm" value={year} onChange={(e) => setYear(e.target.value)}>
          <option value="median">{t(lang, "hear.median")}</option>
          {options.map((r) => (
            <option key={r.label} value={r.label}>
              {digits(lang, r.label)}
            </option>
          ))}
        </select>
      </label>
      <label className="inline-flex items-center gap-1.5 text-xs">
        <span className="text-muted-foreground">{t(lang, "hear.speed")}</span>
        <select className="field min-h-11 text-sm" value={speed} onChange={(e) => setSpeed(e.target.value as Speed)}>
          {(Object.keys(SPEEDS) as Speed[]).map((s) => (
            <option key={s} value={s}>
              {t(lang, `hear.${s}`)}
            </option>
          ))}
        </select>
      </label>
      <span aria-live="polite" className={cn("min-w-[8rem] text-xs text-muted-foreground tabular", !playing && "sr-only")}>
        {playing ? announce : ""}
      </span>
      {!compact && <p className="basis-full text-xs text-muted-foreground">{t(lang, "hear.explain")}</p>}
    </div>
  );
}
