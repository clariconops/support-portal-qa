import { defineFeature } from "../../src/orchestrator/suite.js";
import { ApiClient } from "../../src/api/http.js";
import { assert, type RunContext } from "../../src/orchestrator/context.js";
import { uniqueRulePriority, ensureTag } from "../automation/automationHarness.js";
import { resolveWebchatIds } from "../../src/fixtures/platform.js";

/**
 * WebChat → Automation loop (API layer).
 *
 * Reproduces the anonymous web-chat entry point exactly as the product records
 * it — tickets.requester_id = "webchat_<timestamp>_<random>" for anonymous
 * widget users (see the requester_id column comment in the schema) — and
 * verifies the full loop the user described:
 *
 *   webchat issue is created → automation filters are evaluated → actions taken
 *
 * When QA_WEBCHAT_DOMAIN_ID is configured, the REAL `POST /api/webchat/sessions`
 * endpoint is additionally exercised (session boot: session_id + session_token).
 */

const TAG = "qa-webchat-tag";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function webchatRequesterId(): string {
  return `webchat_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

/** Create a ticket the way the webchat widget does (anonymous requester, webchat channel). */
async function createWebchatTicket(ctx: RunContext, subject: string): Promise<string> {
  const { platformId, appId } = await resolveWebchatIds(ctx);
  const api = ctx.api("TICKET");
  const res = await api.post("/api/tickets", {
    subject,
    description: "created by qa-framework webchat automation flow",
    channel: "webchat",
    requester_id: webchatRequesterId(),
    platform_id: platformId,
    app_id: appId,
    // NOTE: the ticket service has no channel column; the dashboard derives
    // the channel from metadata.source/channel — persist it explicitly so the
    // ticket record is self-describing the way the widget backend does it.
    metadata: { source: "webchat", channel: "webchat" },
  });
  assert(
    res.status < 400,
    `webchat ticket creation failed (${res.status}): ${JSON.stringify(res.data).slice(0, 300)}`
  );
  const created = ApiClient.unwrap<{ id: string }>(res);
  assert(created?.id, "webchat ticket creation returned no id");
  ctx.trackResource({ kind: "ticket", service: "TICKET", id: created.id });
  return created.id;
}

async function createRule(ctx: RunContext, opts: { subjectContains: string }): Promise<string> {
  await ctx.session.loginAs("admin");
  const api = ctx.api("AUTOMATION");
  const res = await api.post("/api/automation/rules", {
    name: `qa-webchat-${Date.now()}`,
    description: "qa-framework webchat automation rule",
    priority: uniqueRulePriority(),
    trigger: {
      trigger_type: "ticket_created",
      is_active: true,
      conditions: [{ field: "subject", operator: "contains", value: opts.subjectContains }],
    },
    actions: [{ action_type: "add_tags", action_target: { tags: [TAG] }, execution_order: 1 }],
  });
  assert(res.status < 400, `rule creation failed (${res.status}): ${JSON.stringify(res.data).slice(0, 300)}`);
  const created = ApiClient.unwrap<{ id?: string; rule_id?: string }>(res);
  const id = created.id ?? created.rule_id;
  assert(id, `rule response missing id: ${JSON.stringify(created)}`);
  ctx.trackResource({ kind: "rule", service: "AUTOMATION", id });
  return id;
}

const suite = defineFeature("webchat-automation", (s) => {
  // "webchat.ticket.created_anonymous"
  s.behaviour("webchat.ticket.created_anonymous", async (ctx) => {
    // Optional: exercise the REAL anonymous webchat session boot (no auth)
    // when a domain is configured for this environment.
    const domainId = process.env.QA_WEBCHAT_DOMAIN_ID;
    if (domainId) {
      const res = await ctx.api("TICKET").post("/api/webchat/sessions", {
        domain_id: domainId,
        platform_id: process.env.QA_WEBCHAT_PLATFORM_ID,
        app_id: process.env.QA_WEBCHAT_APP_ID,
      });
      assert(res.status < 500, `webchat session endpoint crashed (${res.status})`);
      if (res.status < 400) {
        const data = ApiClient.unwrap<Record<string, unknown>>(res);
        assert(data.session_id, "expected session_id from webchat session creation");
        assert(data.session_token, "expected session_token from webchat session creation");
      }
    }

    // The ticket API requires JWT: an operator creates the ticket on behalf of
    // the anonymous webchat requester (channel=webchat, requester=webchat_*),
    // mirroring what the widget backend records in production.
    await ctx.session.loginAs("admin");
    const { platformId } = await resolveWebchatIds(ctx);
    const ticketId = await createWebchatTicket(ctx, `qa-webchat-entry-${Date.now()}`);

    const detail = ApiClient.unwrap<Record<string, unknown>>(
      await ctx.api("TICKET").get(`/api/tickets/${ticketId}`)
    );
    assert(detail && typeof detail === "object", "expected the webchat ticket detail");
    // The tickets table has no channel column; channel is expressed via the
    // webchat platform linkage + metadata.source (what the dashboard displays).
    assert(
      detail.platform_id === platformId,
      `expected ticket platform_id to be the webchat platform (${detail.platform_id})`
    );
    const metadata = (detail.metadata ?? {}) as Record<string, unknown>;
    // The service normalizes the source label ("webchat" → "Web Chat"), and
    // language resolution may enrich metadata — compare case-insensitively.
    const source = String(metadata.source ?? metadata.channel ?? "");
    assert(
      source.toLowerCase().replace(/[\s_-]/g, "") === "webchat" ||
        String(metadata.channel ?? "").toLowerCase() === "webchat",
      `expected metadata source/channel to indicate webchat (${JSON.stringify(metadata).slice(0, 200)})`
    );
    assert(String(detail.requester_id ?? "").startsWith("webchat_"), "expected an anonymous webchat_* requester id on the ticket");
  });

  // "webchat.automation.matching_ticket_actions_applied"
  s.behaviour("webchat.automation.matching_ticket_actions_applied", async (ctx) => {
    await ensureTag(ctx, TAG);
    await createRule(ctx, { subjectContains: "qa-webchat-hit" });
    const ticketId = await createWebchatTicket(ctx, `qa-webchat-hit: widget issue ${Date.now()}`);
    await ctx.waitFor(
      async () => {
        const detail = ApiClient.unwrap<Record<string, unknown>>(
          await ctx.api("TICKET").get(`/api/tickets/${ticketId}`)
        );
        return JSON.stringify(detail).includes(TAG) || undefined;
      },
      { label: "automation actions applied to webchat ticket", timeoutMs: 30_000, intervalMs: 1_000 }
    );
  });

  // "webchat.automation.no_match_untouched"
  s.behaviour("webchat.automation.no_match_untouched", async (ctx) => {
    await ctx.session.loginAs("admin");
    await createRule(ctx, { subjectContains: "qa-webchat-nomatch-xyz" });
    const ticketId = await createWebchatTicket(ctx, `unrelated webchat issue ${Date.now()}`);
    await sleep(5_000);
    const detail = ApiClient.unwrap<Record<string, unknown>>(
      await ctx.api("TICKET").get(`/api/tickets/${ticketId}`)
    );
    assert(!JSON.stringify(detail).includes(TAG), "no-match webchat ticket was modified (false positive)");
  });
});

export default suite;
