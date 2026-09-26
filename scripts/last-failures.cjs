/* Prints failures from the most recent run report (CommonJS so it runs in plain node). */
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
const latest = dirs[dirs.length - 1];
console.log("LATEST RUN:", latest);
const summaryPath = path.join(reports, latest, "summary.json");
if (!fs.existsSync(summaryPath)) {
  console.log("no summary.json");
  process.exit(0);
}
const s = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
console.log("env:", s.env, "verdict:", s.verdict, "totals:", JSON.stringify(s.totals));
for (const f of s.byFeature || []) {
  console.log(`\n== ${f.id} [${f.status}] pass=${f.passed} fail=${f.failed} skip=${f.skipped}`);
  for (const r of f.results || []) {
    if (r.status === "failed") {
      console.log(`  FAIL ${r.behaviourId}`);
      console.log(`       ${String(r.error || "").split("\n")[0].slice(0, 400)}`);
    }
  }
}

