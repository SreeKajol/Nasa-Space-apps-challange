/*
 * Real NASA data, end to end (the npm twin of `make fetch` / `make real`):
 *
 *   npm run fetch                 FIRMS + POWER + EONET into the caches (re-runs download nothing new)
 *   npm run fetch -- --dry-run    print the planned number of FIRMS calls
 *   npm run real                  fetch -> pipeline -> contract -> ML -> seam -> EONET -> report
 *   npm run real -- --skip-fetch  rebuild from the caches only (no network)
 *   npm run snapshot              copy data-products/ into public/data/ for the app (scripts/snapshot.mjs)
 *
 * PYTHON=/path/to/python selects the interpreter (default "python"; the venv lives
 * outside this folder because its name contains ';'). FIRMS_MAP_KEY comes from .env.
 */
import { spawnSync } from "node:child_process";

const py = process.env.PYTHON || "python";
const args = process.argv.slice(2);
const mode = args[0] === "fetch" ? "fetch" : "real";
const rest = args.slice(1);
const env = { ...process.env, PYTHONUTF8: "1" };

function run(cmd, a, { allowFail = false } = {}) {
  console.log(`\n> ${cmd} ${a.join(" ")}`);
  const r = spawnSync(cmd, a, { stdio: "inherit", env });
  if (r.status !== 0 && !allowFail) {
    console.error(
      `\nStopped: \`${a.slice(0, 3).join(" ")}\` exited with ${r.status}. Nothing after it ran; the app keeps its current data.`,
    );
    process.exit(r.status ?? 1);
  }
  return r.status ?? 1;
}

if (mode === "fetch") {
  run(py, ["-m", "src.ingest", "fetch", ...rest]);
  process.exit(0);
}

if (!rest.includes("--skip-fetch")) run(py, ["-m", "src.ingest", "fetch"]);
run(py, ["-m", "src.compute.pipeline"]);
run(process.execPath, ["scripts/export-contract.ts", "data/stage/base", "data-products"]);
const ml = run(
  py,
  ["-m", "src.compute.ml.run", "--data", "data-products", "--out", "data-products/ml"],
  { allowFail: true },
);
if (ml !== 0)
  console.warn(
    "\nML layer failed: continuing without it (the app hides ML views when its files are missing).",
  );
run(py, ["-m", "src.compute.seam", "--data", "data-products"]);
run(py, ["-m", "src.ingest", "validate-eonet"]);
run(py, ["-m", "src.compute.data_report", "--data", "data-products"]);
console.log(
  "\nReal data ready in data-products/. Next: `npm run snapshot` (or `make snapshot`) to publish it to the app.",
);
