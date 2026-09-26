import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunSummary } from "./types.js";

const LT = "\u003c";
const GT = "\u003e";
const AMP = "\u0026";

function escapeXml(s: string): string {
  return s
    .replace(/&/g, AMP + "amp;")
    .replace(/</g, AMP + "lt;")
    .replace(/>/g, AMP + "gt;")
    .replace(/"/g, AMP + "quot;")
    .replace(/'/g, AMP + "apos;");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, AMP + "amp;")
    .replace(/</g, AMP + "lt;")
    .replace(/>/g, AMP + "gt;");
}

/** Write summary.json + junit.xml + summary.html (+ per-feature files). */
export function writeReports(runDir: string, summary: RunSummary): void {
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(runDir, "features"), { recursive: true });

  writeFileSync(join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(runDir, "junit.xml"), toJUnit(summary));
  writeFileSync(join(runDir, "summary.html"), toHtml(summary));

  for (const f of summary.byFeature) {
    writeFileSync(
      join(runDir, "features", `${f.id}.json`),
      JSON.stringify(f, null, 2)
    );
  }
}

export function toJUnit(s: RunSummary): string {
  const suites = s.byFeature
    .map((f) => {
      const cases = f.results
        .map((r) => {
          const time = (r.durationMs / 1000).toFixed(3);
          if (r.status === "failed") {
            const msg = escapeXml(r.error ?? "failed");
            return `    ${LT}testcase classname="${escapeXml(
              f.id
            )}" name="${escapeXml(
              r.behaviourId
            )}" time="${time}"${GT}${LT}failure message="${msg}"/${GT}${LT}/testcase${GT}`;
          }
          if (r.status === "skipped" || r.status === "quarantined") {
            return `    ${LT}testcase classname="${escapeXml(
              f.id
            )}" name="${escapeXml(
              r.behaviourId
            )}" time="${time}"${GT}${LT}skipped/${GT}${LT}/testcase${GT}`;
          }
          return `    ${LT}testcase classname="${escapeXml(
            f.id
          )}" name="${escapeXml(r.behaviourId)}" time="${time}"/${GT}`;
        })
        .join("\n");
      return `  ${LT}testsuite name="${escapeXml(f.title)}" tests="${
        f.results.length
      }" failures="${f.failed}" skipped="${f.skipped + f.quarantined}"${GT}\n${cases}\n  ${LT}/testsuite${GT}`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n${LT}testsuites name="support-portal-qa" tests="${s.totals.behaviours}" failures="${s.totals.failed}" skipped="${s.totals.skipped}"${GT}\n${suites}\n${LT}/testsuites${GT}\n`;
}

export function toHtml(s: RunSummary): string {
  const rows = s.byFeature
    .map((f) => {
      const color =
        f.status === "FAILED"
          ? "#b91c1c"
          : f.status === "PARTIAL"
            ? "#b45309"
            : "#15803d";
      const fails = f.failures.length
        ? `${LT}ul${GT}${f.failures
            .map((x) => `${LT}li${GT}${escapeHtml(x)}${LT}/li${GT}`)
            .join("")}${LT}/ul${GT}`
        : "—";
      return `${LT}tr${GT}
        ${LT}td${GT}${LT}a href="#feature-${escapeHtml(f.id)}"${GT}${escapeHtml(f.id)}${LT}/a${GT}${LT}/td${GT}
        ${LT}td${GT}${escapeHtml(f.severity)}${LT}/td${GT}
        ${LT}td${GT}${escapeHtml(f.group)}${LT}/td${GT}
        ${LT}td${GT}${f.passed}${LT}/td${GT}
        ${LT}td${GT}${f.failed}${LT}/td${GT}
        ${LT}td${GT}${f.skipped + f.quarantined}${LT}/td${GT}
        ${LT}td style="color:${color};font-weight:600"${GT}${f.status}${LT}/td${GT}
        ${LT}td${GT}${fails}${LT}/td${GT}
      ${LT}/tr${GT}`;
    })
    .join("\n");

  // Per-behaviour detail: what ran, what was expected, and what happened.
  const details = s.byFeature
    .map((f) => {
      const fColor =
        f.status === "FAILED" ? "#b91c1c" : f.status === "PARTIAL" ? "#b45309" : "#15803d";
      const detailRows = f.results
        .map((r) => {
          const stColor =
            r.status === "failed" ? "#b91c1c" : r.status === "passed" ? "#15803d" : "#b45309";
          const err = r.error ? escapeHtml(r.error) : "—";
          const arts = r.artifacts.length
            ? r.artifacts
                .map(
                  (a) =>
                    `${LT}a href="${escapeXml(a)}"${GT}${escapeHtml(a)}${LT}/a${GT}`
                )
                .join(`${LT}br/${GT}`)
            : "—";
          return `${LT}tr${GT}
            ${LT}td${GT}${LT}code${GT}${escapeHtml(r.behaviourId)}${LT}/code${GT}${LT}/td${GT}
            ${LT}td${GT}${escapeHtml(r.description)}${LT}/td${GT}
            ${LT}td${GT}${escapeHtml(r.severity)}${LT}/td${GT}
            ${LT}td${GT}${escapeHtml(r.layer)}${LT}/td${GT}
            ${LT}td style="color:${stColor};font-weight:600"${GT}${escapeHtml(
              r.status.toUpperCase()
            )}${LT}/td${GT}
            ${LT}td${GT}${r.durationMs}ms${LT}/td${GT}
            ${LT}td${GT}${r.retries ?? 0}${LT}/td${GT}
            ${LT}td${GT}${err}${LT}/td${GT}
            ${LT}td${GT}${arts}${LT}/td${GT}
          ${LT}/tr${GT}`;
        })
        .join("\n");

      return `${LT}section id="feature-${escapeHtml(f.id)}"${GT}
        ${LT}h2${GT}${escapeHtml(f.title)} ${LT}small${GT}(${escapeHtml(
          f.id
        )})${LT}/small${GT}${LT}/h2${GT}
        ${LT}div class="feature-meta"${GT}
          group ${LT}b${GT}${escapeHtml(f.group)}${LT}/b${GT} · owner ${LT}b${GT}${escapeHtml(
            f.owner
          )}${LT}/b${GT} · severity ${LT}b${GT}${escapeHtml(f.severity)}${LT}/b${GT} ·
          status ${LT}b style="color:${fColor}"${GT}${f.status}${LT}/b${GT} · duration ${f.durationMs}ms
        ${LT}/div${GT}
        ${LT}table${GT}
          ${LT}thead${GT}${LT}tr${GT}
            ${LT}th${GT}Behaviour (test id)${LT}/th${GT}
            ${LT}th${GT}Expected behaviour${LT}/th${GT}
            ${LT}th${GT}Severity${LT}/th${GT}
            ${LT}th${GT}Layer${LT}/th${GT}
            ${LT}th${GT}Result${LT}/th${GT}
            ${LT}th${GT}Duration${LT}/th${GT}
            ${LT}th${GT}Retries${LT}/th${GT}
            ${LT}th${GT}Error / notes${LT}/th${GT}
            ${LT}th${GT}Artifacts${LT}/th${GT}
          ${LT}/tr${GT}${LT}/thead${GT}
          ${LT}tbody${GT}${detailRows}${LT}/tbody${GT}
        ${LT}/table${GT}
      ${LT}/section${GT}`;
    })
    .join("\n");

  const verdictColor = s.verdict === "FAILED" ? "#b91c1c" : "#15803d";
  const style = `
  body{font-family:system-ui,Segoe UI,Arial,sans-serif;margin:24px;color:#111}
  h1{margin:0 0 4px}
  .meta{color:#555;margin-bottom:16px}
  .verdict{font-weight:700;color:${verdictColor}}
  table{border-collapse:collapse;width:100%;margin-top:12px}
  th,td{border:1px solid #ddd;padding:8px;text-align:left;vertical-align:top;font-size:14px}
  th{background:#f3f4f6}
  ul{margin:0;padding-left:18px}
  h2{margin:28px 0 4px;font-size:18px}
  h2 small{color:#555;font-weight:400}
  .feature-meta{color:#555;margin-bottom:6px;font-size:13px}
  code{background:#f3f4f6;padding:1px 4px;border-radius:3px;font-size:12px}
  a{color:#1d4ed8;text-decoration:none}
  a:hover{text-decoration:underline}`;

  return `<!doctype html>
${LT}html${GT}${LT}head${GT}${LT}meta charset="utf-8"${GT}${LT}title${GT}QA Report ${escapeHtml(
    s.runId
  )}${LT}/title${GT}
${LT}style${GT}${style}
${LT}/style${GT}${LT}/head${GT}
${LT}body${GT}
  ${LT}h1${GT}QA Run Report${LT}/h1${GT}
  ${LT}div class="meta"${GT}
    run ${LT}b${GT}${escapeHtml(s.runId)}${LT}/b${GT} · env ${LT}b${GT}${escapeHtml(
      s.env
    )}${LT}/b${GT} · git ${LT}b${GT}${escapeHtml(s.gitSha)}${LT}/b${GT}${LT}br/${GT}
    started ${escapeHtml(s.startedAt)} · finished ${escapeHtml(s.finishedAt)}${LT}br/${GT}
    verdict ${LT}span class="verdict"${GT}${escapeHtml(s.verdict)}${LT}/span${GT} · blocking failures ${s.blockingFailures}${LT}br/${GT}
    totals: features ${s.totals.features} · behaviours ${s.totals.behaviours} · passed ${s.totals.passed} · failed ${s.totals.failed} · skipped ${s.totals.skipped} · quarantined ${s.totals.quarantined}
  ${LT}/div${GT}
  ${LT}table${GT}
    ${LT}thead${GT}${LT}tr${GT}${LT}th${GT}Feature${LT}/th${GT}${LT}th${GT}Severity${LT}/th${GT}${LT}th${GT}Group${LT}/th${GT}${LT}th${GT}Passed${LT}/th${GT}${LT}th${GT}Failed${LT}/th${GT}${LT}th${GT}Skipped/Q${LT}/th${GT}${LT}th${GT}Status${LT}/th${GT}${LT}th${GT}Failures${LT}/th${GT}${LT}/tr${GT}${LT}/thead${GT}
    ${LT}tbody${GT}${rows}${LT}/tbody${GT}
  ${LT}/table${GT}

  ${LT}h2 id="details"${GT}Test details${LT}/h2${GT}
  ${LT}p class="meta"${GT}Every behaviour executed in this run: test id, expected behaviour, severity, layer, actual result, duration, retries, error/notes, and captured evidence.${LT}/p${GT}
  ${details}
${LT}/body${GT}${LT}/html${GT}
`;
}