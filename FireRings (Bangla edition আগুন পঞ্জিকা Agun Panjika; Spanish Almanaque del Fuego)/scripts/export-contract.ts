/*
 * Real data: stage files -> contract region files, with the SAME tested
 * statistics the app uses (src/compute/derive.ts: percentiles, climatology,
 * current status, onset). Python never re-implements them.
 *
 *   node scripts/export-contract.ts [stageDir=data/stage/base] [outDir=data-products]
 *
 * Input  {stage}/{id}.json : { id, fire_year_start_month, partial_last, rows: BaseRow[], validation?, context?, ... }
 * Output {out}/region/{id}.json : RegionData (contract v1); unknown stage fields pass through (additive).
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deriveRegion, type BaseRow } from "../src/compute/derive.ts";

const stage = path.resolve(process.argv[2] ?? "data/stage/base");
const out = path.resolve(process.argv[3] ?? "data-products");
const files = readdirSync(stage).filter((f) => f.endsWith(".json"));
if (files.length === 0) {
  console.error(`No stage files in ${stage}: run the pipeline first (make real).`);
  process.exit(1);
}
mkdirSync(path.join(out, "region"), { recursive: true });
for (const f of files) {
  const s = JSON.parse(readFileSync(path.join(stage, f), "utf8")) as {
    id: string;
    fire_year_start_month: number;
    partial_last: boolean;
    rows: BaseRow[];
    [k: string]: unknown;
  };
  const { id, fire_year_start_month, partial_last, rows, ...rest } = s;
  const region = {
    id,
    fire_year_start_month,
    ...deriveRegion(rows, fire_year_start_month, partial_last),
    ...rest,
  };
  writeFileSync(path.join(out, "region", `${id}.json`), JSON.stringify(region));
  console.log(
    `region/${id}.json: ${rows.length} months, current ${region.current.ym} ${region.current.status}, onset ${region.onset?.onset_date ?? "—"}`,
  );
}
