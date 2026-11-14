/*
 * DEMO ONLY. Writes the synthetic per-cell activity field of the MockAdapter
 * for every preset, so the Python ML layer (src/compute/ml) can be run end to
 * end before the real pipeline exists:
 *
 *   node scripts/export-ml-demo-inputs.ts [outDir]   (default: data-products/demo)
 *
 * Output: {outDir}/ml_inputs/demo_cells.json — the same cells and values the
 * browser demo shows, so ML outputs computed from it line up with the app.
 * The ML layer then simulates MODIS and VIIRS observations on top of this
 * field (src/compute/ml/demo_inputs.py). With real data, the pipeline writes
 * ml_inputs/cell_month.parquet instead (schema: docs/ml_features.md).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MockAdapter, PRESETS } from "../src/data/mock.ts";

const out = path.resolve(process.argv[2] ?? "data-products/demo");
const mock = new MockAdapter();
const idx = mock.index();

/** Keep the cells that carry most of the activity (the rest is faint background). */
const KEEP_SHARE = 0.97;
const MAX_CELLS = 700;

const regions: Record<string, unknown> = {};
let months: string[] = [];
let cellDeg = 0;
for (const p of PRESETS) {
  const res = await mock.getCells(p.bbox);
  months = res.months;
  cellDeg = res.cell_deg;
  const scored = res.cells
    .map((c) => ({ c, total: c.v.reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.total - a.total);
  const all = scored.reduce((a, s) => a + s.total, 0);
  const kept: typeof scored = [];
  let acc = 0;
  for (const s of scored) {
    if (acc >= KEEP_SHARE * all || kept.length >= MAX_CELLS) break;
    kept.push(s);
    acc += s.total;
  }
  regions[p.id] = {
    country: p.country,
    bbox: p.bbox,
    kept_share: Math.round((acc / all) * 1e4) / 1e4,
    cells: kept.map(({ c }) => ({
      id: `c_${c.lat}_${c.lon}`,
      lat: c.lat,
      lon: c.lon,
      v: Array.from(c.v, (x) => Math.round(x * 1000) / 1000),
    })),
  };
}

const file = path.join(out, "ml_inputs", "demo_cells.json");
mkdirSync(path.dirname(file), { recursive: true });
const body = JSON.stringify({
  source: "demo",
  generated_at: idx.generated_at,
  first_month: idx.first_month,
  last_month: idx.last_month,
  viirs_start: idx.viirs_start,
  partial_fraction: mock.partialFraction,
  cell_deg: cellDeg,
  months,
  regions,
});
writeFileSync(file, body);
console.log(`Wrote ${file} (${(body.length / 1e6).toFixed(1)} MB).`);
