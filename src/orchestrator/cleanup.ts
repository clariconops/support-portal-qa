import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunContext, TrackedResource } from "./context.js";

export interface CleanupReport {
  attempted: number;
  removed: number;
  failed: Array<{ resource: TrackedResource; error: string }>;
}

/**
 * Best-effort removal of resources tracked during the run (rules created via
 * the automation API, tickets created via the ticket API). Individual failures
 * are recorded in meta/cleanup.json and never affect the run verdict.
 */
export async function cleanupTrackedResources(
  ctx: RunContext,
  runDir: string
): Promise<CleanupReport> {
  const resources = [...ctx.__resources()];
  const report: CleanupReport = { attempted: resources.length, removed: 0, failed: [] };
  if (resources.length === 0) return report;

  // Deletion endpoints require an authenticated admin session.
  try {
    await ctx.session.loginAs("admin");
  } catch (e) {
    report.failed.push(
      ...resources.map((resource) => ({ resource, error: `login failed: ${(e as Error).message}` }))
    );
    persist(runDir, report);
    return report;
  }

  for (const resource of resources) {
    try {
      let status: number;
      if (resource.kind === "rule") {
        status = (await ctx.api("AUTOMATION").delete(`/api/automation/rules/${resource.id}`)).status;
      } else if (resource.kind === "ticket") {
        status = (await ctx.api("TICKET").delete(`/api/tickets/${resource.id}`)).status;
      } else if (resource.kind === "queue") {
        status = (await ctx.api("QUEUE").delete(`/api/queues/${resource.id}`, {
          params: { domain_id: process.env.QA_WEBCHAT_DOMAIN_ID },
        })).status;
      } else {
        status = (await ctx.api("BOT").delete(`/api/bots/${resource.id}`)).status;
      }
      // 404 counts as removed (already gone); 2xx as removed; anything else is a failure.
      if (status < 300 || status === 404) {
        report.removed++;
      } else {
        report.failed.push({ resource, error: `unexpected status ${status}` });
      }
    } catch (e) {
      report.failed.push({ resource, error: (e as Error).message });
    }
  }

  persist(runDir, report);
  return report;
}

function persist(runDir: string, report: CleanupReport): void {
  try {
    const metaDir = join(runDir, "meta");
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(join(metaDir, "cleanup.json"), JSON.stringify(report, null, 2));
  } catch {
    /* non-blocking */
  }
}
