import type { FeatureRegistry, Severity } from "../registry/types.js";
import {
  emptyTotals,
  type BehaviourResult,
  type FeatureSummary,
  type RunSummary,
} from "./types.js";

export interface CollectorOptions {
  runId: string;
  env: string;
  gitSha: string;
  selection: Record<string, unknown>;
  startedAt: Date;
  /** Behaviour ids that are quarantined (run but never block). */
  quarantine?: Set<string>;
  /** Severity levels that block the verdict. Defaults to P0+P1. */
  blockingSeverities?: Severity[];
}

/**
 * Collects behaviour results and produces a feature-wise RunSummary with a
 * severity-weighted verdict.
 */
export class Collector {
  private results: BehaviourResult[] = [];
  private readonly blocking: Set<Severity>;

  constructor(
    private readonly registry: FeatureRegistry,
    private readonly opts: CollectorOptions
  ) {
    this.blocking = new Set(opts.blockingSeverities ?? ["P0", "P1"]);
  }

  add(result: BehaviourResult): void {
    const quarantined = this.opts.quarantine?.has(result.behaviourId);
    if (quarantined && result.status !== "passed") {
      result.status = "quarantined";
    }
    this.results.push(result);
  }

  build(): RunSummary {
    const byFeatureMap = new Map<string, FeatureSummary>();

    for (const featureId of new Set(this.results.map((r) => r.featureId))) {
      const m = this.registry.get(featureId);
      if (!m) continue;
      byFeatureMap.set(featureId, {
        id: featureId,
        title: m.title,
        group: m.group,
        owner: m.owner,
        severity: m.severity,
        passed: 0,
        failed: 0,
        skipped: 0,
        quarantined: 0,
        status: "PASSED",
        failures: [],
        durationMs: 0,
        results: [],
      });
    }

    for (const r of this.results) {
      const f = byFeatureMap.get(r.featureId);
      if (!f) continue;
      f.results.push(r);
      f.durationMs += r.durationMs;
      switch (r.status) {
        case "passed":
          f.passed++;
          break;
        case "failed":
          f.failed++;
          f.failures.push(r.behaviourId);
          break;
        case "skipped":
          f.skipped++;
          break;
        case "quarantined":
          f.quarantined++;
          break;
      }
    }

    for (const f of byFeatureMap.values()) {
      if (f.failed > 0) f.status = "FAILED";
      else if (f.skipped > 0 || f.quarantined > 0) f.status = "PARTIAL";
      else f.status = "PASSED";
    }

    const totals = emptyTotals();
    totals.features = byFeatureMap.size;
    for (const r of this.results) {
      totals.behaviours++;
      if (r.status === "passed") totals.passed++;
      else if (r.status === "failed") totals.failed++;
      else if (r.status === "skipped") totals.skipped++;
      else if (r.status === "quarantined") totals.quarantined++;
    }

    let blockingFailures = 0;
    for (const r of this.results) {
      if (r.status === "failed" && this.blocking.has(r.severity)) blockingFailures++;
    }

    return {
      runId: this.opts.runId,
      env: this.opts.env,
      gitSha: this.opts.gitSha,
      selection: this.opts.selection,
      startedAt: this.opts.startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      totals,
      byFeature: [...byFeatureMap.values()].sort((a, b) =>
        a.id.localeCompare(b.id)
      ),
      verdict: blockingFailures > 0 ? "FAILED" : "PASSED",
      blockingFailures,
    };
  }
}