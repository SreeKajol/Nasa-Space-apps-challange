/*
 * `npm run ml`: the same steps as `make ml`, for machines without make.
 *   PYTHON=/path/to/python npm run ml            (default: "python")
 *   ML_DATA=data-products npm run ml             (default: data-products if it has index.json, else demo)
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const py = process.env.PYTHON || "python";
const data =
  process.env.ML_DATA ||
  (existsSync("data-products/index.json") ? "data-products" : "data-products/demo");
const out = process.env.ML_OUT || "data-products/ml";
const run = (cmd, args) => {
  console.log(`> ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env, PYTHONUTF8: "1" } });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
if (!existsSync(`${data}/index.json`)) {
  run(process.execPath, ["scripts/generate-demo-data.ts", data]);
  run(process.execPath, ["scripts/export-ml-demo-inputs.ts", data]);
}
run(py, ["-m", "src.compute.ml.run", "--data", data, "--out", out]);
run(process.execPath, ["scripts/copy-ml.mjs", out, "public/data/ml"]);
