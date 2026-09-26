import type { RunContext } from "./context.js";

/** A single executable behaviour implementation. */
export type BehaviourFn = (ctx: RunContext) => Promise<void>;

export interface RegisteredBehaviour {
  id: string;
  fn: BehaviourFn;
}

/**
 * Suite collected from a spec module. Specs call `defineFeature(id, register)`,
 * where `register` receives this suite and registers each behaviour by the same
 * id declared in the feature manifest.
 */
export class Suite {
  readonly behaviours: RegisteredBehaviour[] = [];
  constructor(readonly featureId: string) {}

  /** Register an API-layer behaviour. */
  behaviour(id: string, fn: BehaviourFn): void {
    if (this.behaviours.some((b) => b.id === id)) {
      throw new Error(`duplicate behaviour "${id}" in suite "${this.featureId}"`);
    }
    this.behaviours.push({ id, fn });
  }
}

/** Entry point used by API specs. */
export function defineFeature(
  featureId: string,
  register: (suite: Suite) => void
): Suite {
  const suite = new Suite(featureId);
  register(suite);
  return suite;
}