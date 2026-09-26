import type {
  Behaviour,
  FeatureManifest,
  FeatureRegistry,
  Layer,
  RunPlanEntry,
  Selection,
} from "./types.js";

export interface SelectionResult {
  plan: RunPlanEntry[];
  warnings: string[];
}

/**
 * Resolve a `Selection` into an ordered run plan.
 *
 * Selection precedence: explicit features > groups > tags > suite > all.
 * Dependencies (`dependsOn`) are expanded so prerequisites run first, and the
 * final plan is topologically ordered but keeps a stable feature order.
 */
export function selectFeatures(
  registry: FeatureRegistry,
  selection: Selection
): SelectionResult {
  const warnings: string[] = [];
  const chosen = new Set<string>();

  const addById = (id: string) => {
    if (!registry.has(id)) {
      warnings.push(`selected feature "${id}" not found in registry`);
      return;
    }
    chosen.add(id);
  };

  if (selection.features?.length) {
    selection.features.forEach(addById);
  } else if (selection.groups?.length) {
    const groups = new Set(selection.groups);
    for (const [id, m] of registry) if (groups.has(m.group)) chosen.add(id);
  } else if (selection.tags?.length) {
    const tags = new Set(selection.tags);
    for (const [id, m] of registry)
      if (m.tags.some((t) => tags.has(t))) chosen.add(id);
  } else if (selection.suite) {
    // `integration` => everything; `smoke` => tag smoke; `regression` => tag regression
    if (selection.suite === "integration") {
      for (const id of registry.keys()) chosen.add(id);
    } else {
      const tag = selection.suite; // "smoke" | "regression"
      for (const [id, m] of registry)
        if (m.tags.includes(tag)) chosen.add(id);
    }
  } else if (selection.all) {
    for (const id of registry.keys()) chosen.add(id);
  }

  if (chosen.size === 0) {
    return { plan: [], warnings: [...warnings, "selection matched no features"] };
  }

  // expand dependencies (transitively) unless disabled
  if (!selection.noDeps) {
    const stack = [...chosen];
    while (stack.length) {
      const id = stack.pop()!;
      const m = registry.get(id);
      if (!m) continue;
      for (const dep of m.dependsOn) {
        if (!chosen.has(dep)) {
          chosen.add(dep);
          stack.push(dep);
        }
      }
    }
  }

  const ordered = topoSort(chosen, registry, warnings);
  const plan: RunPlanEntry[] = [];

  for (const id of ordered) {
    const feature = registry.get(id)!;
    const behaviours = filterBehaviours(feature, selection.layers);
    if (behaviours.length === 0) continue;
    plan.push({ featureId: id, feature, behaviours });
  }

  return { plan, warnings };
}

/** Filter a feature's behaviours by requested layers (feature-level or behaviour-level). */
function filterBehaviours(feature: FeatureManifest, layers?: Layer[]): Behaviour[] {
  if (!layers?.length) return feature.behaviours;
  const wanted = new Set(layers);
  return feature.behaviours.filter((b) => {
    const effective = b.layers?.length ? b.layers : feature.layers;
    return effective.some((l) => wanted.has(l));
  });
}

/** Kubernetes-style deterministic topological sort with cycle detection. */
function topoSort(
  ids: Set<string>,
  registry: FeatureRegistry,
  warnings: string[]
): string[] {
  // stable base order: registry insertion order, filtered to selected ids
  const base = [...registry.keys()].filter((id) => ids.has(id));

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const out: string[] = [];

  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      warnings.push(`dependency cycle detected involving "${id}"`);
      return;
    }
    visiting.add(id);
    const m = registry.get(id);
    if (m) for (const dep of m.dependsOn) if (ids.has(dep)) visit(dep);
    visiting.delete(id);
    visited.add(id);
    out.push(id);
  };

  for (const id of base) visit(id);
  return out;
}

/** Human-readable catalogue of the registry (used by `qa list`). */
export function catalog(registry: FeatureRegistry): {
  id: string;
  title: string;
  group: string;
  severity: string;
  tags: string[];
  behaviours: number;
  layers: string[];
}[] {
  return [...registry.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((m) => ({
      id: m.id,
      title: m.title,
      group: m.group,
      severity: m.severity,
      tags: m.tags,
      behaviours: m.behaviours.length,
      layers: m.layers,
    }));
}