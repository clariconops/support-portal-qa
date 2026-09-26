// Compact human-readable dump of a qa-framework run summary.
// Usage: node scripts/print-run.js reports/<runId>
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/print-run.js <report-dir>");
  process.exit(1);
}
const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
console.log(`run      : ${summary.runId}`);
console.log(`env      : ${summary.env}   verdict: ${summary.verdict}`);
console.log(`totals   : ${JSON.stringify(summary.totals)}`);
console.log("");
for (const f of summary.byFeature) {
  const total = f.passed + f.failed + f.skipped;
  console.log(`== ${f.id} [${f.status}] ${f.passed}/${total} passed (${f.durationMs}ms)`);
  for (const r of f.results) {
    const mark = r.status === "passed" ? "PASS" : r.status === "failed" ? "FAIL" : "SKIP";
    console.log(`   ${mark}  ${r.behaviourId}  (${r.durationMs}ms)`);
    if (r.error) console.log(`         -> ${String(r.error).slice(0, 300)}`);
  }
}

