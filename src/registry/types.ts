import { z } from "zod";

/** Severity of a feature or behaviour. P0 is the most critical. */
export const Severity = z.enum(["P0", "P1", "P2", "P3"]);
export type Severity = z.infer<typeof Severity>;

/** Logical grouping used by `--group` selection. */
export const Group = z.enum([
  "core",
  "workflows",
  "data",
  "people",
  "integrations",
  "platform",
  /** Automation engine surface (rules, filters, actions) — its own domain. */
  "automation",
]);
export type Group = z.infer<typeof Group>;

/** Execution layer. */
export const Layer = z.enum(["api", "ui", "contract", "perf"]);
export type Layer = z.infer<typeof Layer>;

/** A single expected behaviour of a feature. */
export const BehaviourSchema = z.object({
  id: z.string().min(3),
  description: z.string().min(3),
  /** Path (relative to the framework root) to the spec file implementing it. */
  spec: z.string().min(1),
  /** The exact test title inside the spec file (for drift validation + mapping). */
  testName: z.string().min(1),
  severity: Severity,
  /** Which layer(s) this behaviour runs at; defaults to the feature layers. */
  layers: z.array(Layer).optional(),
  timeoutMs: z.number().int().positive().optional(),
});
export type Behaviour = z.infer<typeof BehaviourSchema>;

/** Data requirements for a feature's tests. */
export const DataSchema = z
  .object({
    seeds: z.array(z.string()).default([]),
    cleanup: z.boolean().default(true),
  })
  .default({ seeds: [], cleanup: true });

/** The feature manifest contract. */
export const FeatureManifestSchema = z.object({
  id: z.string().min(2).regex(/^[a-z0-9-]+$/, "id must be kebab-case"),
  title: z.string().min(2),
  group: Group,
  owner: z.string().min(3),
  severity: Severity,
  tags: z.array(z.string()).default([]),
  dependsOn: z.array(z.string()).default([]),
  layers: z.array(Layer).min(1),
  environments: z.array(z.string()).default(["local", "ci", "staging"]),
  behaviours: z.array(BehaviourSchema).min(1),
  data: DataSchema,
  timeoutMs: z.number().int().positive().optional(),
});
export type FeatureManifest = z.infer<typeof FeatureManifestSchema>;

/** Registry: all discovered features keyed by id. */
export type FeatureRegistry = Map<string, FeatureManifest>;

/** Resolved run plan. */
export interface RunPlanEntry {
  featureId: string;
  feature: FeatureManifest;
  behaviours: Behaviour[];
}

export interface Selection {
  features?: string[];
  groups?: Group[];
  tags?: string[];
  suite?: "integration" | "smoke" | "regression";
  layers?: Layer[];
  all?: boolean;
  noDeps?: boolean;
}