import { getProvider, type DataSrc, type ProviderOptions } from "@/data/provider";
import { intensityColor, type RampName } from "@/data/ramp";
import { parseYm, type Hotspot, type RegionData, type RegionRequest } from "@/data/types";
import { inRange, toCsv } from "@/data/view";
import { digits, monthName, num, t, type Lang } from "@/i18n";
import type { CalendarModel } from "@/components/charts/BurningCalendar";
import { statusOf } from "@/compute/derive";


const ATTRIBUTION =
  "Data: NASA FIRMS (MODIS Collection 6.1; VIIRS 375 m on Suomi-NPP, NOAA-20, NOAA-21) · Imagery: NASA GIBS · Climate context: NASA POWER. Built for NASA Space Apps 2026 by Team HalluciNation. Open source, Apache-2.0. Not an official NASA product.";

export function monthlyCsv(region: RegionData, from: string, to: string): string {
  const head = ["ym", "harmonized", "low", "high", "modis_raw", "viirs_raw", "raw_total", "percentile", "z", "status", "approximate", "source"];
  const rows = inRange(region.monthly, from, to).map((p) => [
    p.ym,
    p.harmonized,
    p.low,
    p.high,
    p.modis_raw,
    p.viirs_raw,
    p.modis_raw == null && p.viirs_raw == null ? null : (p.modis_raw ?? 0) + (p.viirs_raw ?? 0),
    p.percentile,
    p.z,
    statusOf(p.percentile),
    region.approximate ? "yes" : "no",
    region.source ?? "",
  ]);
  return toCsv([head, ...rows]);
}

/**
 * Effective harmonized ÷ raw ratios per calendar month over the overlap
 * (derived from the published series; the pipeline's own fitted
 * coefficients are not part of the data contract).
 */
export function coefficientsCsv(region: RegionData, viirsStart: string): string {
  const head = ["month", "n_months", "harmonized_per_modis_raw", "harmonized_per_viirs_raw", "modis_raw_per_viirs_raw"];
  const rows: (string | number)[][] = [];
  for (let m = 1; m <= 12; m++) {
    const pts = region.monthly.filter((p) => p.ym >= viirsStart && parseYm(p.ym).m === m && (p.modis_raw ?? 0) > 0 && (p.viirs_raw ?? 0) > 0);
    const sum = (f: (p: (typeof pts)[number]) => number) => pts.reduce((a, p) => a + f(p), 0);
    const h = sum((p) => p.harmonized);
    const mo = sum((p) => p.modis_raw ?? 0);
    const vi = sum((p) => p.viirs_raw ?? 0);
    const r = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : "");
    rows.push([m, pts.length, r(h, mo), r(h, vi), r(mo, vi)]);
  }
  return toCsv([head, ...rows]);
}

/** Hotspots for the area across every year in the range, filtered to the range. */
export async function hotspotsRangeCsv(src: DataSrc, opts: ProviderOptions, req: RegionRequest, from: string, to: string): Promise<string> {
  const p = getProvider(src, opts);
  const out: Hotspot[] = [];
  for (let y = parseYm(from).y; y <= parseYm(to).y; y++) {
    try {
      const { rows } = await p.getHotspots(req, y);
      for (const r of rows) {
        const ym = r.acq_datetime_utc.slice(0, 7);
        if (ym >= from && ym <= to) out.push(r);
      }
    } catch (e) {
      if (y === parseYm(to).y && out.length === 0) throw e;
    }
  }
  const head = ["latitude", "longitude", "acq_datetime_utc", "sensor", "satellite", "confidence", "frp_mw", "type"] as const;
  return toCsv([[...head], ...out.map((r) => head.map((h) => r[h]))]);
}

/** High-resolution calendar PNG with legend and attribution, drawn directly to canvas. */
export async function calendarPng(opts: {
  model: CalendarModel;
  lang: Lang;
  title: string;
  subtitle: string;
  ramp: RampName;
  unit: string;
  scale?: number;
}): Promise<Blob> {
  const { model, lang, title, subtitle, ramp, unit } = opts;
  const S = opts.scale ?? 3;
  const cell = 26;
  const gap = 3;
  const labelW = 74;
  const totalW = 110;
  const top = 120;
  const W = labelW + 12 * (cell + gap) + totalW + 40;
  const H = top + model.rows.length * (cell + gap) + 150;
  const c = document.createElement("canvas");
  c.width = W * S;
  c.height = H * S;
  const g = c.getContext("2d")!;
  g.scale(S, S);
  const font = lang === "bn" ? '"Noto Sans Bengali", sans-serif' : '"Inter Variable", Inter, system-ui, sans-serif';
  await document.fonts?.ready;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, W, H);
  g.fillStyle = "#1f2430";
  g.font = `600 20px ${font}`;
  g.fillText(title, 20, 34);
  g.font = `400 12px ${font}`;
  g.fillStyle = "#5b6170";
  g.fillText(subtitle, 20, 54);

  // median marginal row
  const x0 = 20 + labelW;
  model.medians.forEach((v, i) => {
    const h = (v / model.maxMedian) * 30;
    g.fillStyle = "#9aa0ab";
    g.fillRect(x0 + i * (cell + gap), top - 22 - h, cell, h);
    g.fillStyle = "#5b6170";
    g.font = `500 10px ${font}`;
    g.textAlign = "center";
    g.fillText(monthName(lang, model.order[i]!, true), x0 + i * (cell + gap) + cell / 2, top - 6);
  });
  g.textAlign = "right";
  g.fillText(t(lang, "cal.median_row"), x0 - 8, top - 26);

  model.rows.forEach((r, ri) => {
    const y = top + ri * (cell + gap);
    g.fillStyle = "#5b6170";
    g.font = `500 11px ${font}`;
    g.textAlign = "right";
    g.fillText(digits(lang, r.label), x0 - 8, y + cell / 2 + 4);
    r.cells.forEach((p, ci) => {
      const x = x0 + ci * (cell + gap);
      if (!p || p.value == null) {
        g.strokeStyle = "#c9ccd2";
        g.strokeRect(x + 0.5, y + 0.5, cell - 1, cell - 1);
        return;
      }
      g.fillStyle = intensityColor(model.max > 0 ? Math.pow(p.value / model.max, 0.7) : 0, ramp, false);
      g.fillRect(x, y, cell, cell);
      if (p.pct != null && !p.partial && statusOf(p.pct) === "extreme") {
        g.strokeStyle = "#111";
        g.lineWidth = 1.5;
        g.strokeRect(x + 0.75, y + 0.75, cell - 1.5, cell - 1.5);
        g.fillStyle = "#fff";
        g.font = `700 11px ${font}`;
        g.textAlign = "center";
        g.fillText("⚠", x + cell / 2, y + cell / 2 + 4);
      }
    });
    const tot = model.totals[ri]?.total ?? 0;
    const bw = (tot / model.maxTotal) * (totalW - 50);
    g.fillStyle = "#e0773a";
    g.fillRect(x0 + 12 * (cell + gap) + 4, y + 8, bw, cell - 16);
    g.fillStyle = "#5b6170";
    g.textAlign = "left";
    g.font = `400 10px ${font}`;
    g.fillText(num(lang, tot), x0 + 12 * (cell + gap) + 8 + bw, y + cell / 2 + 4);
  });

  // legend
  const ly = top + model.rows.length * (cell + gap) + 24;
  for (let i = 0; i <= 100; i++) {
    g.fillStyle = intensityColor(i / 100, ramp, false);
    g.fillRect(20 + i * 2, ly, 2, 10);
  }
  g.fillStyle = "#5b6170";
  g.font = `400 10px ${font}`;
  g.textAlign = "left";
  g.fillText(`0 → ${num(lang, model.max)} ${unit} · ${t(lang, "cal.extreme_note")}`, 236, ly + 9);
  // attribution (wrapped)
  g.font = `400 9.5px ${font}`;
  const words = ATTRIBUTION.split(" ");
  let line = "";
  let yy = ly + 34;
  for (const w of words) {
    if (g.measureText(line + w).width > W - 40) {
      g.fillText(line, 20, yy);
      line = "";
      yy += 13;
    }
    line += w + " ";
  }
  g.fillText(line, 20, yy);
  g.fillText(`FireRings · ${new Date().toISOString().slice(0, 10)}`, 20, yy + 16);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("png"))), "image/png"));
}
