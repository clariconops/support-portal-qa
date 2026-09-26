import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

interface QuarantineFile {
  behaviours?: string[];
}

/**
 * Load the list of quarantined behaviour ids (`quarantine.yaml` at the repo
 * root). Quarantined behaviours still run but never block the verdict; they are
 * reported separately so there is an explicit burndown list of known flakes.
 */
export function loadQuarantine(rootDir: string): Set<string> {
  const file = join(rootDir, "quarantine.yaml");
  if (!existsSync(file)) return new Set();
  try {
    const parsed = (yaml.load(readFileSync(file, "utf8")) ?? {}) as QuarantineFile;
    return new Set(parsed.behaviours ?? []);
  } catch {
    return new Set();
  }
}