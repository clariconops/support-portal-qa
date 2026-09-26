import type { FrameworkEnv } from "../config/env.js";
import { SessionClient } from "../api/sessionClient.js";
import { ApiClient, serviceClient, type RecordedCall } from "../api/http.js";

/** Assertion error raised by framework assertions (distinguishes test failures). */
export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}

export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new AssertionError(message);
}

export function assertEquals<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new AssertionError(
      message ?? `expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`
    );
  }
}

/** Poll helper used for async/eventual-consistency and WebSocket assertions. */
export async function waitFor<T>(
  fn: () => Promise<T | false | undefined>,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {}
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const intervalMs = opts.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result as T;
      last = result;
    } catch (e) {
      last = (e as Error).message;
    }
    await sleep(intervalMs);
  }
  throw new AssertionError(
    `waitFor timed out after ${timeoutMs}ms${opts.label ? ` (${opts.label})` : ""}; last=${JSON.stringify(last)}`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A resource created by specs during a run, eligible for end-of-run cleanup. */
export interface TrackedResource {
  kind: "rule" | "ticket" | "queue" | "bot";
  service: string;
  id: string;
  label?: string;
}

export interface RunContext {
  env: FrameworkEnv;
  runDir: string;
  session: SessionClient;
  /** Get an authenticated API client for a named service. */
  api: (service: string) => ApiClient;
  /** Record artifact paths (relative to runDir) for the active behaviour. */
  addArtifact: (relPath: string) => void;
  /** Recorded API calls for the active behaviour. */
  recordedCalls: () => RecordedCall[];
  waitFor: typeof waitFor;
  /** Shared key/value state for the whole run (e.g. seeded rule ids). */
  state: Record<string, unknown>;
  setState: (key: string, value: unknown) => void;
  getState: <T = unknown>(key: string) => T | undefined;
  /** Track a created resource (rule/ticket) for end-of-run cleanup. */
  trackResource: (resource: TrackedResource) => void;
  /** Internal: all resources tracked this run (for cleanup). */
  __resources: () => TrackedResource[];
  /** Internal: begin a behaviour scope (called by the runner). */
  __beginBehaviour: (featureId: string, behaviourId: string) => void;
  /** Internal: end a behaviour scope, returning artifacts + recorded calls. */
  __endBehaviour: () => { artifacts: string[]; calls: RecordedCall[] };
}

/** Build a RunContext bound to a run directory. */
export function createContext(env: FrameworkEnv, runDir: string): RunContext {
  const session = new SessionClient(env);
  const tokenProvider = () => session.getToken();

  const state: Record<string, unknown> = {};
  const resources: TrackedResource[] = [];
  let artifacts: string[] = [];
  let calls: RecordedCall[] = [];
  let stopRecording: (() => RecordedCall[]) | undefined;

  const api = (service: string): ApiClient => {
    const client = serviceClient(env, service, tokenProvider);
    const started = client.record("_", "_");
    const prior = stopRecording;
    stopRecording = () => {
      const own = started();
      if (prior) prior();
      return own;
    };
    return client;
  };

  return {
    env,
    runDir,
    session,
    api,
    addArtifact: (rel) => artifacts.push(rel),
    recordedCalls: () => calls,
    waitFor,
    state,
    setState: (key, value) => {
      state[key] = value;
    },
    getState: <T = unknown,>(key: string) => state[key] as T | undefined,
    trackResource: (resource) => {
      resources.push(resource);
    },
    __resources: () => resources,
    __beginBehaviour: () => {
      artifacts = [];
      calls = [];
      stopRecording = undefined;
    },
    __endBehaviour: () => {
      if (stopRecording) calls = stopRecording();
      return { artifacts, calls };
    },
  };
}
