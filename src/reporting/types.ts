import type { Severity } from "../registry/types.js";

/** Result of one behaviour execution. */
export interface BehaviourResult {
  featureId: string;
  behaviourId: string;
  description: string;
  severity: Severity;
  layer: string;
  status: "passed" | "failed" | "skipped" | "quarantined";
  durationMs: number;
  error?: string;
  /** Relative paths (from run dir) to evidence files. */
  artifacts: string[];
  retries?: number;
}

/** Aggregated per-feature summary. */
export interface FeatureSummary {
  id: string;
  title: string;
  group: string;
  owner: string;
  severity: Severity;
  passed: number;
  failed: number;
  skipped: number;
  quarantined: number;
  status: "PASSED" | "FAILED" | "PARTIAL";
  failures: string[];
  durationMs: number;
  results: BehaviourResult[];
}

/** The whole run summary. */
export interface RunSummary {
  runId: string;
  env: string;
  gitSha: string;
  selection: Record<string, unknown>;
  startedAt: string;
  finishedAt: string;
  totals: {
    features: number;
    behaviours: number;
    passed: number;
    failed: number;
    skipped: number;
    quarantined: number;
  };
  byFeature: FeatureSummary[];
  verdict: "PASSED" | "FAILED";
  blockingFailures: number;
}

export function emptyTotals(): RunSummary["totals"] {
  return {
    features: 0,
    behaviours: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    quarantined: 0,
  };
}