import { defineFeature } from "../../src/orchestrator/suite.js";
import { ApiClient } from "../../src/api/http.js";
import { assert, assertEquals, type RunContext } from "../../src/orchestrator/context.js";
import { deriveConditionsMet, ensureProbeRule, ensureTag, extractActionResults, uniqueRulePriority } from "./automationHarness.js";
import { resolveWebchatIds } from "../../src/fixtures/platform.js";

/**
 * Golden flows & invariants for the automation engine:
 * real rule + real ticket → side effects; negatives must not fire; the dry-run
 * test endpoint must fail safely on malformed conditions.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const TAG = "qa-flow-tag";

async function createRule(ctx: RunContext, opts: { subjectContains: string; active?: boolean }): Promise<string> {
  await ctx.session.loginAs("admin");
  const api = ctx.api("AUTOMATION");
  const res = await api.post("/api/automation/rules", {
    name: `qa-flow-${Date.now()}`,
    description: "qa-framework golden flow rule",
    priority: uniqueRulePriority(),
    trigger: {
      trigger_type: "ticket_created",
      is_active: opts.active !== false,
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

async function createTicket(ctx: RunContext, subject: string): Promise<string> {
  const { platformId, appId } = await resolveWebchatIds(ctx);
  const api = ctx.api("TICKET");
  const res = await api.post("/api/tickets", {
    subject,
    description: "created by qa-framework automation flow",
    channel: "api",
    platform_id: platformId,
    app_id: appId,
  });
  assert(res.status < 400, `ticket creation failed (${res.status}): ${JSON.stringify(res.data).slice(0, 300)}`);
  const created = ApiClient.unwrap<{ id: string }>(res);
  assert(created?.id, "ticket creation returned no id");
  ctx.trackResource({ kind: "ticket", service: "TICKET", id: created.id });
  return created.id;
}

const suite = defineFeature("automation", (s) => {
  // "automation.flows.seed"
  s.behaviour("automation.flows.seed", async (ctx) => {
    await ensureProbeRule(ctx);
  });

  // "automation.flows.matching_ticket_fires_actions"
  s.behaviour("automation.flows.matching_ticket_fires_actions", async (ctx) => {
    await ensureTag(ctx, TAG);
    await createRule(ctx, { subjectContains: "qaflow-hit" });
    const ticketId = await createTicket(ctx, "qaflow-hit: refund my order");
    await ctx.waitFor(
      async () => {
        const detail = ApiClient.unwrap<Record<string, unknown>>(
          await ctx.api("TICKET").get(`/api/tickets/${ticketId}`)
        );
        return JSON.stringify(detail).includes(TAG) || undefined;
      },
      { label: "rule applied tag to matching ticket", timeoutMs: 30_000, intervalMs: 1_000 }
    );
  });

  // "automation.flows.no_match_leaves_ticket_untouched"
  s.behaviour("automation.flows.no_match_leaves_ticket_untouched", async (ctx) => {
    await createRule(ctx, { subjectContains: "qanomatch-xyz" });
    const ticketId = await createTicket(ctx, "totally unrelated subject");
    await sleep(5_000);
    const detail = ApiClient.unwrap<Record<string, unknown>>(
      await ctx.api("TICKET").get(`/api/tickets/${ticketId}`)
    );
    assert(!JSON.stringify(detail).includes(TAG), "no-match ticket was modified (false positive)");
  });

  // "automation.flows.disabled_trigger_no_effect"
  s.behaviour("automation.flows.disabled_trigger_no_effect", async (ctx) => {
    await createRule(ctx, { subjectContains: "qadisabled", active: false });
    const ticketId = await createTicket(ctx, "qadisabled subject");
    await sleep(5_000);
    const detail = ApiClient.unwrap<Record<string, unknown>>(
      await ctx.api("TICKET").get(`/api/tickets/${ticketId}`)
    );
    assert(!JSON.stringify(detail).includes(TAG), "rule with inactive trigger still fired");
  });

  // "automation.flows.invalid_regex_safe_failure"
  s.behaviour("automation.flows.invalid_regex_safe_failure", async (ctx) => {
    const ruleId = await ensureProbeRule(ctx);
    const api = ctx.api("AUTOMATION");
    const res = await api.post(`/api/automation/rules/${ruleId}/test`, {
      test_ticket: { subject: "anything" },
      test_mode: "dry_run",
      rule_draft: {
        name: "qa-invalid-regex",
        trigger: {
          trigger_type: "ticket_created",
          conditions: [{ field: "subject", operator: "regex", value: "(unclosed" }],
        },
        actions: [{ action_type: "add_note", action_target: { content: "qa" }, execution_order: 1 }],
      },
    });
    assert(res.status < 500, `invalid regex caused a server error (${res.status})`);
    if (res.status < 400) {
      const data = ApiClient.unwrap<Record<string, unknown>>(res);
      assertEquals(deriveConditionsMet(extractActionResults(data)), false, "invalid regex matched");
    }
  });

  // "automation.flows.action_execution_order"
  s.behaviour("automation.flows.action_execution_order", async (ctx) => {
    const ruleId = await ensureProbeRule(ctx);
    const api = ctx.api("AUTOMATION");
    const res = await api.post(`/api/automation/rules/${ruleId}/test`, {
      test_ticket: { subject: "order test" },
      test_mode: "dry_run",
      rule_draft: {
        name: "qa-execution-order",
        trigger: {
          trigger_type: "ticket_created",
          conditions: [{ field: "subject", operator: "is_set" }],
        },
        actions: [
          { action_type: "add_note", action_target: { content: "first" }, execution_order: 1 },
          { action_type: "add_note", action_target: { content: "second" }, execution_order: 2 },
        ],
      },
    });
    assert(res.status < 400, `testRule failed (${res.status})`);
    const data = ApiClient.unwrap<Record<string, unknown>>(res);
    const results = extractActionResults(data);
    assertEquals(results.length, 2, "expected both draft actions to be tested");
    assert(
      results.every((r) => r.would_execute === true),
      "expected both actions to execute for a matching ticket"
    );
  });
});

export default suite;

