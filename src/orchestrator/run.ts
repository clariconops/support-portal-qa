import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FrameworkEnv } from "../config/env.js";
import { Collector } from "../reporting/collector.js";
import type { BehaviourResult } from "../reporting/types.js";
import { writeReports } from "../reporting/writers.js";
import { notify } from "../reporting/notifier.js";
import { loadQuarantine } from "./quarantine.js";
import { cleanupTrackedResources } from "./cleanup.js";
import { runUiBehaviours } from "./ui.js";
import { type RunContext, createContext } from "./context.js";
import type { Suite } from "./suite.js";
import type { FeatureRegistry, RunPlanEntry } from "../registry/types.js";

export interface RunOptions {
  env: FrameworkEnv;
  rootDir: string;
  plan: RunPlanEntry[];
  runId: string;
  selection: Record<string, unknown>;
  /** Notify (email/slack) after the run. */
  sendReport?: boolean;
  /** Public report URL (optional). */
  reportUrl?: string;
  /** Best-effort cleanup of tracked test data after the run (default true). */
  cleanup?: boolean;
}

export interface RunResult {
  runDir: string;
  summaryPath: string;
  passed: boolean;
}

/** Load the Suite exported by an API spec file (dynamic ESM import). */
async function loadSuite(specPath: string): Promise<Suite | undefined> {
  const url = pathToFileURL(specPath).href;
  const mod = (await import(url)) as { default?: Suite; suite?: Suite };
  return mod.default ?? mod.suite;
}

/** Execute the resolved plan and produce reports. */
export async function runPlan(
  registry: FeatureRegistry,
  opts: RunOptions
): Promise<RunResult> {
  const { env, rootDir, plan, runId } = opts;
  const runDir = join(rootDir, env.report.dir, runId);
  mkdirSync(runDir, { recursive: true });

  const quarantine = loadQuarantine(rootDir);
  const collector = new Collector(registry, {
    runId,
    env: String(env.env),
    gitSha: env.gitSha,
    selection: opts.selection,
    startedAt: new Date(),
    quarantine,
  });

  const ctx: RunContext = createContext(env, runDir);

  // Deduplicate spec modules so each is imported once.
  const suiteCache = new Map<string, Suite | undefined>();

  for (const entry of plan) {
    for (const behaviour of entry.behaviours) {
      const started = Date.now();
      const specAbs = join(rootDir, behaviour.spec);

      // API and UI executions are deliberately separate. UI behaviours are
      // executed by Playwright after the API pass and are never silently skipped.
      const effectiveLayers = behaviour.layers?.length
        ? behaviour.layers
        : entry.feature.layers;
      if (!effectiveLayers.includes("api")) continue;

      let suite = suiteCache.get(specAbs);
      if (suite === undefined && !suiteCache.has(specAbs)) {
        try {
          suite = await loadSuite(specAbs);
        } catch (e) {
          suite = undefined;
          collector.add(errorResult(entry, behaviour, started, `failed to load spec: ${(e as Error).message}`));
          suiteCache.set(specAbs, undefined);
          continue;
        }
        suiteCache.set(specAbs, suite);
      }

      const impl = suite?.behaviours.find((b) => b.id === behaviour.id);
      if (!impl) {
        collector.add(
          errorResult(entry, behaviour, started, `no implementation registered for behaviour "${behaviour.id}"`)
        );
        continue;
      }

      const result = await runWithRetries(ctx, entry, behaviour, impl.fn, started);
      collector.add(result);
    }
  }

  for (const result of await runUiBehaviours(rootDir, runDir, plan)) collector.add(result);

  const summary = collector.build();
  writeReports(runDir, summary);

  // meta/run.json
  const metaDir = join(runDir, "meta");
  mkdirSync(metaDir, { recursive: true });
  writeFileSync(
    join(metaDir, "run.json"),
    JSON.stringify(
      { runId, env: env.env, gitSha: env.gitSha, selection: opts.selection, startedAt: summary.startedAt },
      null,
      2
    )
  );

  // Best-effort cleanup of tracked test data for features that request it.
  if (opts.cleanup !== false && plan.some((e) => e.feature.data.cleanup !== false)) {
    try {
      const report = await cleanupTrackedResources(ctx, runDir);
      console.log(
        `cleanup: removed ${report.removed}/${report.attempted} tracked resource(s)` +
          (report.failed.length ? `, ${report.failed.length} failed (see meta/cleanup.json)` : "")
      );
    } catch (e) {
      console.warn(`cleanup skipped (non-blocking): ${(e as Error).message}`);
    }
  }

  if (opts.sendReport !== false) {
    await notify(env, summary, { reportUrl: opts.reportUrl });
  }

  return {
    runDir,
    summaryPath: join(runDir, "summary.html"),
    passed: summary.verdict === "PASSED",
  };
}

async function runWithRetries(
  ctx: RunContext,
  entry: RunPlanEntry,
  behaviour: RunPlanEntry["behaviours"][number],
  fn: (c: RunContext) => Promise<void>,
  started: number
): Promise<BehaviourResult> {
  const maxRetries = retriesFor(behaviour.severity);
  const timeoutMs = behaviour.timeoutMs ?? entry.feature.timeoutMs ?? 60_000;

  let lastError: string | undefined;
  // Artifacts recorded via ctx.addArtifact() during any attempt (including
  // failed ones) — accumulated so evidence survives retries, then deduped.
  const artifacts: string[] = [];
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    ctx.__beginBehaviour(entry.featureId, behaviour.id);
    try {
      await withTimeout(fn(ctx), timeoutMs, behaviour.id);
      const completed = ctx.__endBehaviour();
      artifacts.push(...completed.artifacts, ...writeApiEvidence(ctx.runDir, behaviour.id, attempt, completed.calls));
      return {
        featureId: entry.featureId,
        behaviourId: behaviour.id,
        description: behaviour.description,
        severity: behaviour.severity,
        layer: "api",
        status: "passed",
        durationMs: Date.now() - started,
        artifacts: [...new Set(artifacts)],
        retries: attempt,
      };
    } catch (e) {
      lastError = (e as Error).message;
      const completed = ctx.__endBehaviour();
      artifacts.push(...completed.artifacts, ...writeApiEvidence(ctx.runDir, behaviour.id, attempt, completed.calls));
    }
  }

  return errorResult(
    entry,
    behaviour,
    started,
    lastError ?? "unknown error",
    maxRetries,
    [...new Set(artifacts)]
  );
}

function retriesFor(severity: string): number {
  switch (severity) {
    case "P0":
      return 0; // surface flakiness immediately on critical paths
    case "P1":
      return 1;
    default:
      return 2;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms (${label})`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

function errorResult(
  entry: RunPlanEntry,
  behaviour: RunPlanEntry["behaviours"][number],
  started: number,
  error: string,
  retries = 0,
  artifacts: string[] = []
): BehaviourResult {
  return {
    featureId: entry.featureId,
    behaviourId: behaviour.id,
    description: behaviour.description,
    severity: behaviour.severity,
    layer: "api",
    status: "failed",
    durationMs: Date.now() - started,
    error,
    artifacts,
    retries,
  };
}

function writeApiEvidence(
  runDir: string,
  behaviourId: string,
  attempt: number,
  calls: unknown[]
): string[] {
  if (!calls.length) return [];
  const relPath = `artifacts/api/${behaviourId}/attempt-${attempt + 1}.json`;
  const path = join(runDir, relPath);
  mkdirSync(join(runDir, "artifacts", "api", behaviourId), { recursive: true });
  writeFileSync(path, JSON.stringify(calls, null, 2));
  return [relPath];
}
