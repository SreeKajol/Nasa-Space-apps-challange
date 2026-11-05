/*
 * Writes the synthetic demo data as STATIC FILES in the exact data contract
 * (index.json, region/*.json, grid/*.json, hotspots/{id}/{year}.csv), so the
 * StaticJsonAdapter can be exercised end to end before the real pipeline runs.
 *
 *   node scripts/generate-demo-data.ts [outDir]      (default: public/demo-data)
 *   VITE_DATA_BASE_URL=./demo-data npm run dev
 *
 * The files say "source": "demo" — they are synthetic, not observations.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tileIdsForBbox } from "../src/compute/derive.ts";
import { MockAdapter, PRESETS } from "../src/data/mock.ts";

const out = path.resolve(process.argv[2] ?? "public/demo-data");
const mock = new MockAdapter();
const idx = mock.index();
const write = (rel: string, data: string) => {
  const file = path.join(out, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
  return data.length;
};

let bytes = write("index.json", JSON.stringify(idx, null, 1));
const lastYear = Number(idx.last_month.slice(0, 4));
const HEAD = ["latitude", "longitude", "acq_datetime_utc", "sensor", "satellite", "confidence", "frp_mw", "type"] as const;

for (const p of PRESETS) {
  bytes += write(`region/${p.id}.json`, JSON.stringify(mock.regionFile(p.id)));
  for (const y of [lastYear - 1, lastYear]) {
    const { rows } = await mock.getHotspots({ presetId: p.id }, y);
    bytes += write(`hotspots/${p.id}/${y}.csv`, [HEAD.join(","), ...rows.map((r) => HEAD.map((h) => r[h]).join(","))].join("\n") + "\n");
  }
}

// Grid tiles for one preset only (keeps the fixture small): custom areas drawn
// inside the Sundarbans box work in static mode; elsewhere you get "no grid files".
const sb = PRESETS.find((p) => p.id === "sundarbans")!;
for (const id of tileIdsForBbox(sb.bbox, idx.grid.tile_deg)) {
  bytes += write(`grid/${id}.json`, JSON.stringify(mock.gridTile(id, sb.bbox)));
}

console.log(`Wrote demo data contract files to ${out} (${(bytes / 1e6).toFixed(1)} MB).`);
