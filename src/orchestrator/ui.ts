import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Behaviour, RunPlanEntry } from "../registry/types.js";
import type { BehaviourResult } from "../reporting/types.js";

interface PlaywrightCase {
  title?: string;
  results?: Array<{ status?: string; duration?: number; error?: { message?: string } }>;
  tests?: Array<{ results?: Array<{ status?: string; duration?: number; error?: { message?: string } }> }>;
}

/** Runs selected Playwright behaviours and maps their native result to the feature report. */
export async function runUiBehaviours(
  rootDir: string,
  runDir: string,
  entries: RunPlanEntry[]
): Promise<BehaviourResult[]> {
  const selected = entries.flatMap((entry) =>
    entry.behaviours
      .filter((b) => effectiveLayers(entry, b).includes("ui"))
      .map((behaviour) => ({ entry, behaviour }))
  );
  if (!selected.length) return [];

  const names = selected.map(({ behaviour }) => behaviour.testName);
  // Playwright matches the full hierarchical title (file/project + test), so
  // use title fragments instead of anchoring to the bare manifest title.
  const grep = `(?:${names.map(escapeRegex).join("|")})`;
  const cli = join(rootDir, "node_modules", "@playwright", "test", "cli.js");
  // `--grep` selects behaviours by their manifest title. Passing Windows paths
  // as Playwright positional regexes is not portable, so do not pass spec paths.
  const args = [cli, "test", "--grep", grep, "--reporter=json"];
  const output = await run(process.execPath, args, rootDir);
  const artifactDir = join(runDir, "artifacts", "playwright");
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, "raw-results.json"), output.stdout || output.stderr);

  let cases: PlaywrightCase[] = [];
  try {
    cases = flattenCases(JSON.parse(output.stdout));
  } catch {
    // All selected behaviours become failures below with the runner diagnostic.
  }

  return selected.map(({ entry, behaviour }) => {
    const found = cases.find((c) => c.title === behaviour.testName);
    const latest = found?.results?.at(-1);
    const status = latest?.status === "passed" ? "passed" : "failed";
    return {
      featureId: entry.featureId,
      behaviourId: behaviour.id,
      description: behaviour.description,
      severity: behaviour.severity,
      layer: "ui",
      status,
      durationMs: latest?.duration ?? 0,
      error: status === "failed" ? latest?.error?.message ?? uiFailure(output, behaviour.testName) : undefined,
      artifacts: ["artifacts/playwright/raw-results.json"],
    };
  });
}

function effectiveLayers(entry: RunPlanEntry, behaviour: Behaviour) {
  return behaviour.layers?.length ? behaviour.layers : entry.feature.layers;
}

function flattenCases(node: unknown): PlaywrightCase[] {
  if (!node || typeof node !== "object") return [];
  const record = node as Record<string, unknown>;
  const own = Array.isArray(record.specs)
    ? (record.specs as PlaywrightCase[]).flatMap((spec) =>
        (spec.tests ?? []).map((test) => ({ title: spec.title, results: test.results }))
      )
    : [];
  return [
    ...own,
    ...(Array.isArray(record.suites) ? record.suites.flatMap(flattenCases) : []),
  ];
}

function run(command: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uiFailure(output: { code: number; stdout: string; stderr: string }, title: string): string {
  return `Playwright did not report a passing result for "${title}" (exit ${output.code}). ${output.stderr || output.stdout}`.slice(0, 4_000);
}
