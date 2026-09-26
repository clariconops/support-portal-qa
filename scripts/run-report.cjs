/* Prints the full per-test report of the most recent run (CommonJS, plain node).
 * Usage: node scripts/run-report.cjs [runDirName]
 *   with no argument, uses the newest report in reports/. */
const fs = require("fs");
const path = require("path");

const reports = path.join(__dirname, "..", "reports");
const dirs = fs
  .readdirSync(reports, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
if (!dirs.length) {
  console.log("no reports");
  process.exit(0);
}
const latest = process.argv[2] ?? dirs[dirs.length - 1];
const summaryPath = path.join(reports, latest, "summary.json");
if (!fs.existsSync(summaryPath)) {
  console.log("no summary.json in", latest);
  process.exit(1);
}
const s = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
const mark = {
  passed: "PASS",
  failed: "FAIL",
  skipped: "SKIP",
  quarantined: "QUAR",
};
console.log(`RUN: ${latest}`);
console.log(`env=${s.env} verdict=${s.verdict} totals=${JSON.stringify(s.totals)}`);
console.log("");
for (const f of s.byFeature || []) {
  console.log(`== ${f.id} [${f.status}] pass=${f.passed} fail=${f.failed} skip=${f.skipped}`);
  for (const r of f.results || []) {
    console.log(`  ${mark[r.status] ?? String(r.status).toUpperCase()}  ${r.behaviourId} (${r.durationMs}ms)`);
    if (r.status === "failed") {
      console.log(`         ${String(r.error || "").split("\n")[0].slice(0, 300)}`);
    }
  }
  console.log("");
}

