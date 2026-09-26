import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import yaml from "js-yaml";
import {
  FeatureManifestSchema,
  type FeatureManifest,
  type FeatureRegistry,
} from "./types.js";

/** Recursively find all `*.feature.yaml` files under a directory. */
export function findManifestFiles(dir: string): string[] {
  const out: string[] = [];
  if (!exists(dir)) return out;
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (entry.endsWith(".feature.yaml") || entry.endsWith(".feature.yml"))
        out.push(resolve(full));
    }
  };
  walk(dir);
  return out.sort();
}

function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

export interface LoadResult {
  registry: FeatureRegistry;
  errors: string[];
}

/**
 * Discover and validate every feature manifest. Invalid manifests are reported
 * in `errors` (so the CLI can fail loudly) rather than silently dropped.
 */
export function loadRegistry(featuresDir: string): LoadResult {
  const registry: FeatureRegistry = new Map();
  const errors: string[] = [];
  const files = findManifestFiles(featuresDir);

  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = yaml.load(readFileSync(file, "utf8"));
    } catch (e) {
      errors.push(`${file}: YAML parse error: ${(e as Error).message}`);
      continue;
    }

    const result = FeatureManifestSchema.safeParse(parsed);
    if (!result.success) {
      errors.push(
        `${file}: schema error: ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`
      );
      continue;
    }

    const manifest: FeatureManifest = result.data;
    if (registry.has(manifest.id)) {
      errors.push(`${file}: duplicate feature id "${manifest.id}"`);
      continue;
    }

    // duplicate behaviour ids within the same manifest are never allowed
    const seen = new Set<string>();
    for (const b of manifest.behaviours) {
      if (seen.has(b.id)) {
        errors.push(`${file}: duplicate behaviour id "${b.id}"`);
      }
      seen.add(b.id);
    }

    registry.set(manifest.id, manifest);
  }

  // validate dependency references resolve
  for (const [id, m] of registry) {
    for (const dep of m.dependsOn) {
      if (!registry.has(dep)) {
        errors.push(
          `feature "${id}": dependsOn "${dep}" which does not exist`
        );
      }
    }
  }

  return { registry, errors };
}