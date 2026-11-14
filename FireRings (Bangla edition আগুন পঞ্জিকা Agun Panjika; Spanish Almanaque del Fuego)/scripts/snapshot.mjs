/*
 * `make snapshot` / `npm run snapshot`: publish a real-data run to the app.
 *
 *   node scripts/snapshot.mjs [from=data-products] [to=public/data]
 *
 * Copies index.json, region/, grid/, hotspots/, validation/ and the ML outputs
 * (ml/, when they come from real data) into public/data/, and marks the copy
 * as a saved snapshot: index.json "source": "cache" plus "snapshot_at". At the
 * next `npm run dev` / `npm run build` the app detects data_mode "real" and
 * uses it (vite.config.ts); the badge then reads "cache" with the run's date,
 * and everything works with the network off. Refuses anything that is not a
 * real-data run, so demo data can never be published as real.
 */
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const from = path.resolve(process.argv[2] ?? "data-products");
const to = path.resolve(process.argv[3] ?? "public/data");
const ixFile = path.join(from, "index.json");
if (!existsSync(ixFile)) {
  console.error(`No ${ixFile}: run \`npm run real\` (or \`make real\`) first.`);
  process.exit(1);
}
const index = JSON.parse(readFileSync(ixFile, "utf8"));
if (index.data_mode !== "real") {
  console.error(
    `${ixFile} is not a real-data run (data_mode: ${index.data_mode ?? "missing"}). Nothing copied.`,
  );
  process.exit(1);
}

const snapshotAt = new Date().toISOString().slice(0, 19) + "Z";
for (const d of ["region", "grid", "hotspots", "validation"]) {
  rmSync(path.join(to, d), { recursive: true, force: true });
  if (existsSync(path.join(from, d)))
    cpSync(path.join(from, d), path.join(to, d), { recursive: true });
}
writeFileSync(
  path.join(to, "index.json"),
  JSON.stringify({ ...index, source: "cache", snapshot_at: snapshotAt }, null, 1),
);

// ML layer: only outputs computed from this real run (never the demo build).
const mlIx = path.join(from, "ml", "index.json");
const ml = existsSync(mlIx) ? JSON.parse(readFileSync(mlIx, "utf8")) : null;
if (ml && ml.source !== "demo" && ml.inputs?.last_month === index.last_month) {
  const mlTo = path.join(to, "ml");
  rmSync(mlTo, { recursive: true, force: true });
  for (const item of ["index.json", "model_card.json", "region", "grid"]) {
    if (existsSync(path.join(from, "ml", item)))
      cpSync(path.join(from, "ml", item), path.join(mlTo, item), { recursive: true });
  }
  if (existsSync("docs/ml_method.md")) cpSync("docs/ml_method.md", path.join(mlTo, "ml_method.md"));
  writeFileSync(path.join(mlTo, "index.json"), JSON.stringify({ ...ml, source: "cache" }));
  console.log("ML outputs of this run copied (source: cache).");
} else {
  console.warn(
    "No ML outputs from this real run: public/data/ml keeps its current files (labelled by their own source).",
  );
}
console.log(
  `Snapshot of the run of ${index.generated_at} -> ${to} (source: cache, snapshot_at ${snapshotAt}).`,
);
console.log("Restart `npm run dev` or rebuild: the app now opens on the real data.");
