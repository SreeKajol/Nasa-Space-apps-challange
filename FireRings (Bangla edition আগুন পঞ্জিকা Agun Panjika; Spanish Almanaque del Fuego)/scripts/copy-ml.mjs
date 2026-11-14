/*
 * Copies the ML layer's JSON outputs into the app's static data folder:
 *   node scripts/copy-ml.mjs [from=data-products/ml] [to=public/data/ml]
 * features.parquet (training table, ~20 MB) is not copied; docs/ml_method.md is,
 * so the model card can link to it from any static host.
 */
import { cpSync, existsSync, rmSync } from "node:fs";
import path from "node:path";

const from = path.resolve(process.argv[2] ?? "data-products/ml");
const to = path.resolve(process.argv[3] ?? "public/data/ml");
if (!existsSync(path.join(from, "index.json"))) {
  console.error(`No ${path.join(from, "index.json")}: run \`npm run ml\` (or \`make ml\`) first.`);
  process.exit(1);
}
rmSync(to, { recursive: true, force: true });
for (const item of ["index.json", "model_card.json", "region", "grid"]) {
  if (existsSync(path.join(from, item)))
    cpSync(path.join(from, item), path.join(to, item), { recursive: true });
}
const method = path.resolve("docs/ml_method.md");
if (existsSync(method)) cpSync(method, path.join(to, "ml_method.md"));
console.log(`Copied ML outputs ${from} -> ${to}`);
