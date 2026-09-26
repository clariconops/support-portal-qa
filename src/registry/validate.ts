import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative as pathRelative, resolve, sep } from "node:path";
import type { FeatureRegistry } from "./types.js";

export interface ValidateIssue {
  severity: "error" | "warning";
  featureId?: string;
  behaviourId?: string;
  message: string;
}

export interface ValidateResult {
  issues: ValidateIssue[];
  ok: boolean;
  stats: {
    features: number;
    behaviours: number;
    specs: number;
  };
}

/**
 * Drift validation between manifests and specs.
 *
 * Guarantees:
 *  - every behaviour references an existing spec file
 *  - every behaviour's `testName` actually appears in that spec (as a string/title)
 *  - every spec under `specs/` is referenced by at least one behaviour
 *
 * This is what makes "add a feature => it is wired into the suite" enforceable:
 * you cannot add a spec without registering it, and you cannot register a
 * behaviour without implementing it.
 */
export function validateRegistry(
  registry: FeatureRegistry,
  rootDir: string,
  specRoot = "specs"
): ValidateResult {
  const issues: ValidateIssue[] = [];
  const referencedSpecs = new Set<string>();
  let behaviourCount = 0;

  for (const [featureId, manifest] of registry) {
    for (const b of manifest.behaviours) {
      behaviourCount++;
      const specAbs = resolve(rootDir, b.spec);
      referencedSpecs.add(specAbs);

      if (!existsSync(specAbs)) {
        issues.push({
          severity: "error",
          featureId,
          behaviourId: b.id,
          message: `spec file not found: ${b.spec}`,
        });
        continue;
      }

      const content = readFileSync(specAbs, "utf8");
      if (!content.includes(b.testName)) {
        issues.push({
          severity: "error",
          featureId,
          behaviourId: b.id,
          message: `testName "${b.testName}" not found in ${b.spec}`,
        });
      }
    }
  }

  // detect untracked specs
  const allSpecs = findSpecFiles(resolve(rootDir, specRoot));
  for (const spec of allSpecs) {
    if (!referencedSpecs.has(resolve(spec))) {
      issues.push({
        severity: "error",
        message: `untracked spec (no behaviour references it): ${pathRelative(rootDir, spec).split(sep).join("/")}`,
      });
    }
  }

  return {
    issues,
    ok: issues.every((i) => i.severity !== "error"),
    stats: {
      features: registry.size,
      behaviours: behaviourCount,
      specs: allSpecs.length,
    },
  };
}

function findSpecFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const full = resolve(d, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (/\.(spec|test)\.(ts|tsx|js)$/.test(entry)) out.push(full);
    }
  };
  walk(dir);
  return out;
}
