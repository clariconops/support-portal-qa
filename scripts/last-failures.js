// Prints the newest run's failures compactly (no deps).
const fs = require("fs");
const path = require("path");

const reports = path.join(__dirname, "..", "reports");
const runs = fs
  .readdirSync(reports, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()
  .reverse();

if (!runs.length) {
  console.log("no reports found");
  process.exit(0);
}

const newest = runs[0];
console.log("NEWEST RUN:", newest);
const summary = JSON.parse(
  fs.readFileSync(path.join(reports, newest, "summary.json"), "utf8")
);
console.log("verdict =", summary.verdict, "| totals =", JSON.stringify(summary.totals));

for (const f of summary.byFeature || []) {
  console.log(`\nFEATURE ${f.id} [${f.status}] pass=${f.passed} fail=${f.failed} skip=${f.skipped}`);
  for (const r of f.results || []) {
    const mark = r.status === "passed" ? "PASS" : r.status.toUpperCase();
    console.log(`  ${mark} ${r.behaviourId} (${r.durationMs}ms)`);
    if (r.status !== "passed" && r.error) {
      console.log(`       ${String(r.error).replace(/\s+/g, " ").slice(0, 400)}`);
    }
  }
}
