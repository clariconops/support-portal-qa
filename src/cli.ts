#!/usr/bin/env node
import { resolve } from "node:path";
import { readdirSync } from "node:fs";
import { Command } from "commander";
import { loadEnv } from "./config/env.js";
import { loadRegistry } from "./registry/load.js";
import { catalog, selectFeatures } from "./registry/select.js";
import { validateRegistry } from "./registry/validate.js";
import { runPlan } from "./orchestrator/run.js";
import type { Group, Layer } from "./registry/types.js";

const rootDir = resolve(process.cwd());
const program = new Command();

program
  .name("qa")
  .description("Enterprise test framework for the Support Portal")
  .version("0.1.0");

/** ---------- list ---------- */
program
  .command("list")
  .description("List discovered features and their behaviour counts")
  .option("--format <format>", "table|json", "table")
  .action((opts) => {
    const { registry, errors } = loadRegistry(resolve(rootDir, "features"));
    if (errors.length) {
      errors.forEach((e) => console.error(`error: ${e}`));
      process.exit(2);
    }
    const rows = catalog(registry);
    if (opts.format === "json") {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    console.log(`\nDiscovered ${rows.length} feature(s):\n`);
    console.log(
      ["ID", "SEVERITY", "GROUP", "BEHAVIOURS", "LAYERS", "TAGS"].join("\t")
    );
    for (const r of rows) {
      console.log(
        [r.id, r.severity, r.group, String(r.behaviours), r.layers.join(","), r.tags.join(",")].join("\t")
      );
    }
    console.log("");
  });

/** ---------- validate ---------- */
program
  .command("validate")
  .description("Validate manifests and detect drift between behaviours and specs")
  .action(() => {
    const { registry, errors } = loadRegistry(resolve(rootDir, "features"));
    if (errors.length) {
      errors.forEach((e) => console.error(`error: ${e}`));
    }
    const result = validateRegistry(registry, rootDir);
    for (const issue of result.issues) {
      const where = issue.featureId
        ? `[${issue.featureId}${issue.behaviourId ? `/${issue.behaviourId}` : ""}] `
        : "";
      console.log(`${issue.severity}: ${where}${issue.message}`);
    }
    console.log(
      `\nfeatures=${result.stats.features} behaviours=${result.stats.behaviours} specs=${result.stats.specs}`
    );
    if (errors.length || !result.ok) {
      console.error("\nValidation FAILED");
      process.exit(2);
    }
    console.log("Validation OK");
  });

/** ---------- run ---------- */
program
  .command("run")
  .description("Run selected features/layers and produce a feature-wise report")
  .option("--feature <ids...>", "feature ids")
  .option("--group <groups...>", "feature groups")
  .option("--tag <tags...>", "tags (smoke, regression, ...)")
  .option("--suite <suite>", "integration|smoke|regression")
  .option("--layer <layers...>", "api|ui|contract|perf")
  .option("--all", "select every feature")
  .option("--no-deps", "do not expand dependencies")
  .option("--env <env>", "environment", "local")
  .option("--report <channels>", "email|slack|both|html", "html")
  .option("--report-url <url>", "public URL of the published report")
  .option("--no-cleanup", "skip cleanup of tracked test data")
  .option("--dry-run", "print the plan without executing")
  .action(async (opts) => {
    const env = loadEnv(opts.env, rootDir);
    const { registry, errors } = loadRegistry(resolve(rootDir, "features"));
    if (errors.length) {
      errors.forEach((e) => console.error(`error: ${e}`));
      process.exit(2);
    }

    const selection = {
      features: opts.feature as string[] | undefined,
      groups: opts.group as Group[] | undefined,
      tags: opts.tag as string[] | undefined,
      suite: opts.suite as "integration" | "smoke" | "regression" | undefined,
      layers: opts.layer as Layer[] | undefined,
      all: Boolean(opts.all),
      noDeps: opts.deps === false,
    };

    const { plan, warnings } = selectFeatures(registry, selection);
    warnings.forEach((w) => console.warn(`warning: ${w}`));

    if (plan.length === 0) {
      console.error("No features matched the selection.");
      process.exit(2);
    }

    const unavailable = plan.filter((entry) => !entry.feature.environments.includes(String(env.env)));
    if (unavailable.length) {
      console.error(`Selected feature(s) are not approved for ${env.env}: ${unavailable.map((x) => x.featureId).join(", ")}`);
      process.exit(2);
    }
    if (["prod", "production", "prod-like"].includes(String(env.env))) {
      console.error("QA execution against production/prod-like targets is prohibited by policy.");
      process.exit(2);
    }
    if (!opts.dryRun && !env.allowDestructive) {
      console.error("QA_ALLOW_DESTRUCTIVE=true is required outside local/CI because selected tests create and modify test data.");
      process.exit(2);
    }

    const behaviours = plan.reduce((n, e) => n + e.behaviours.length, 0);
    console.log(
      `\nPlan: ${plan.length} feature(s), ${behaviours} behaviour(s) → env=${env.env}\n` +
        plan.map((e) => `  - ${e.featureId} (${e.behaviours.length})`).join("\n")
    );

    if (opts.dryRun) return;

    const runId = makeRunId();
    const reportChannels = String(opts.report);
    env.report.email.enabled =
      reportChannels === "email" || reportChannels === "both" || env.report.email.enabled;
    if (reportChannels === "html") env.report.email.enabled = false;

    const result = await runPlan(registry, {
      env,
      rootDir,
      plan,
      runId,
      selection: selection as unknown as Record<string, unknown>,
      sendReport: reportChannels !== "html" ? true : env.report.email.enabled || Boolean(env.report.slack),
      reportUrl: opts.reportUrl,
      cleanup: opts.cleanup !== false,
    });

    console.log(`\nReport: ${result.summaryPath}`);
    if (!result.passed) {
      console.error(`Verdict: FAILED`);
      process.exit(1);
    }
    console.log("Verdict: PASSED");
  });

/** ---------- report ---------- */
program
  .command("report")
  .description("Show the latest report location, or open it")
  .option("--latest", "use the most recent run")
  .option("--run-id <id>", "specific run id")
  .option("--open", "open in the default browser")
  .action((opts) => {
    const base = resolve(rootDir, loadEnv("local", rootDir).report.dir);
    let id = opts.runId as string | undefined;
    if (!id && opts.latest) {
      const dirs = readdirSync(base).sort();
      id = dirs[dirs.length - 1];
    }
    if (!id) {
      console.error("Provide --run-id or --latest");
      process.exit(2);
    }
    const html = resolve(base, id, "summary.html");
    console.log(html);
  });

/** ---------- clean ---------- */
program
  .command("clean")
  .description("Remove old report runs, keeping the most recent N")
  .option("--keep <n>", "number of runs to keep", "10")
  .action(() => {
    console.log("clean: see framework docs (retention is enforced in CI).");
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});

function makeRunId(): string {
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 6);
  return `${iso}_run-${rand}`;
}
