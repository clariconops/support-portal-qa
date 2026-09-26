import { ApiClient } from "../../src/api/http.js";
import { assert, type RunContext } from "../../src/orchestrator/context.js";
import type { ConditionCase, LogicShape } from "../../src/domain/automationCatalog.js";

/**
 * Shared harness for the automation matrix suites.
 *
 * Uses POST /api/automation/rules/:ruleId/test with `test_mode: "dry_run"` and
 * `rule_draft` so every case evaluates a condition against a crafted ticket
 * WITHOUT side effects. Product contract for a dry-run action result:
 *   - conditions matched + action valid  → `would_execute: true`
 *   - conditions not matched             → `would_execute: false`,
 *     `error_message: "Rule conditions did not match the test ticket"`
 *   - action invalid                     → `would_execute: false`,
 *     `validation_status: "invalid"`
 * NOTE: in dry-run the product always reports `execution_status: "skipped"`
 * (nothing is executed), so "skipped" must NOT be read as "conditions failed".
 */

/** Automation rules require a unique priority in [1, 1000] per tenant. */
let prioritySeq = 200 + (Date.now() % 600);
export function uniqueRulePriority(): number {
  prioritySeq = 200 + ((prioritySeq - 200 + 7) % 700);
  return prioritySeq;
}

const ensuredTags = new Set<string>();
/**
 * The automation service only allows `add_tags` with tags that exist in the
 * domain's tag catalog ("Only tags created in the dashboard can be used").
 * Idempotently register the tag via the tag service; a 400 "already exists"
 * is treated as success.
 */
export async function ensureTag(ctx: RunContext, tag: string): Promise<void> {
  if (ensuredTags.has(tag)) return;
  await ctx.session.loginAs("admin");
  const res = await ctx.api("TAG").post("/api/tags", {
    tag_name: tag,
    tag_description: "qa-framework automation test tag",
  });
  const error = String((res.data as { error?: string } | undefined)?.error ?? "");
  const ok =
    (res.status >= 200 && res.status < 300) ||
    (res.status === 400 && error.includes("already exists"));
  assert(ok, `failed to ensure tag "${tag}" (${res.status}): ${JSON.stringify(res.data).slice(0, 200)}`);
  ensuredTags.add(tag);
}


export async function ensureProbeRule(ctx: RunContext): Promise<string> {
  const existing = ctx.getState<string>("automation.probeRuleId");
  if (existing) return existing;

  await ctx.session.loginAs("admin");
  const api = ctx.api("AUTOMATION");
  const res = await api.post("/api/automation/rules", {
    name: `qa-probe-${Date.now()}`,
    description: "qa-framework probe rule (matrix harness)",
    priority: uniqueRulePriority(),
    trigger: {
      trigger_type: "ticket_created",
      is_active: true,
      conditions: [{ field: "subject", operator: "is_set" }],
    },
    actions: [{ action_type: "add_note", action_target: { content: "qa probe" }, execution_order: 1 }],
  });
  assert(res.status < 400, `failed to create probe rule (${res.status}): ${JSON.stringify(res.data)}`);
  const created = ApiClient.unwrap<{ id?: string; rule_id?: string }>(res);
  const id = created.id ?? created.rule_id;
  assert(id, `probe rule response missing id: ${JSON.stringify(created)}`);
  ctx.setState("automation.probeRuleId", id);
  ctx.trackResource({ kind: "rule", service: "AUTOMATION", id });
  return id;
}

export function conditionFromCase(c: ConditionCase): Record<string, unknown> {
  const cond: Record<string, unknown> = { field: c.field, operator: c.operator };
  if (c.conditionValue !== undefined) cond.value = c.conditionValue;
  if (c.caseSensitive !== undefined) cond.case_sensitive = c.caseSensitive;
  return cond;
}

/** Build a rule payload in the requested logic shape (single guaranteed-match condition). */
export function buildRulePayload(opts: {
  name: string;
  triggerType: string;
  logicShape: LogicShape;
  condition: Record<string, unknown>;
  actionType: string;
  actionTarget: Record<string, unknown>;
}): Record<string, unknown> {
  const { name, triggerType, logicShape, condition, actionType, actionTarget } = opts;
  const trigger: Record<string, unknown> = { trigger_type: triggerType };
  if (logicShape === "flat_and") {
    trigger.conditions = [condition];
  } else {
    trigger.conditions = {
      operator: logicShape === "groups_and" ? "AND" : "OR",
      groups: [{ operator: logicShape === "groups_and" ? "AND" : "OR", conditions: [condition] }],
    };
  }
  return {
    name,
    description: "qa-framework pairwise matrix case",
    priority: uniqueRulePriority(),
    trigger,
    actions: [{ action_type: actionType, action_target: actionTarget, execution_order: 1 }],
  };
}

/** Tolerantly locate the per-action results array in a testRule response. */
export function extractActionResults(data: unknown): Array<Record<string, unknown>> {
  const seen: unknown[] = [data];
  while (seen.length) {
    const cur = seen.pop();
    if (Array.isArray(cur)) {
      if (cur.length > 0 && cur.every((x) => typeof x === "object" && x !== null)) {
        return cur as Array<Record<string, unknown>>;
      }
      continue;
    }
    if (cur && typeof cur === "object") {
      for (const v of Object.values(cur as Record<string, unknown>)) seen.push(v);
    }
  }
  throw new Error(
    `could not locate action results in testRule response: ${JSON.stringify(data).slice(0, 500)}`
  );
}

/** conditions did NOT match ⇔ no action would execute. */
export function deriveConditionsMet(results: Array<Record<string, unknown>>): boolean {
  if (results.length === 0) return false;
  return results.every((r) => r.would_execute === true);
}


/** Run one matrix case end-to-end and return the derived verdict + raw response body. */
export async function runConditionCase(
  ctx: RunContext,
  c: ConditionCase
): Promise<{ met: boolean; raw: unknown; rejected?: boolean }> {
  const ruleId = await ensureProbeRule(ctx);
  const api = ctx.api("AUTOMATION");
  const testTicket: Record<string, unknown> = {};
  if (c.ticketValue !== undefined) testTicket[c.field] = c.ticketValue;

  // Validation requires ≥1 condition even for valueless operators (is_set, ...).
  const draftConditions: unknown[] = [conditionFromCase(c)];

  const res = await api.post(`/api/automation/rules/${ruleId}/test`, {
    test_ticket: testTicket,
    test_mode: "dry_run",
    rule_draft: {
      name: `qa-matrix-${c.id}`,
      description: "qa-framework operator matrix case",
      priority: uniqueRulePriority(),
      trigger: { trigger_type: "ticket_created", conditions: draftConditions },
      actions: [{ action_type: "add_note", action_target: { content: "qa" }, execution_order: 1 }],
    },
  });
  assert(res.status < 500, `testRule crashed (${res.status}): ${JSON.stringify(res.data).slice(0, 300)}`);
  if (res.status >= 400) {
    // The backend rejected the draft (e.g. an operator it does not implement —
    // conditions are validated and dropped). Surface as data, not a crash.
    return { met: false, raw: res.data, rejected: true };
  }
  const data = ApiClient.unwrap<Record<string, unknown>>(res);
  const results = extractActionResults(data);
  return { met: deriveConditionsMet(results), raw: data };
}

/**
 * All 12 UI-supported action types (SUPPORTED_ACTION_TYPES) with presence-valid
 * targets, ordered by execution_order 1..12 (assignments first so they run
 * before any status change can put the ticket in a terminal state).
 *
 * Backend validateAction only checks presence (ids/strings non-empty), so dry
 * runs pass with placeholder ids; pass real ids for live rules. Failures of
 * individual actions never block the rest (executeAction fail-continues).
 */
export interface AllActionsOptions {
  addTag: string;
  removeTag: string;
  replyMessage: string;
  noteContent: string;
  /** target status definition name (must be a valid transition) */
  status: string;
  customFieldKey: string;
  customFieldValue: string;
  agentId?: string;
  queueId?: string;
  botId?: string;
  aiAgentId?: string;
  /** default "high" (valid for both automation + ticket update enums) */
  priority?: string;
}

export function buildAllActions(o: AllActionsOptions): Array<Record<string, unknown>> {
  return [
    { action_type: "assign_to_agent",
      action_target: { agentId: o.agentId || "qa-unresolved-agent", allowOffline: true },
      execution_order: 1 },
    { action_type: "assign_to_queue",
      action_target: { queueId: o.queueId || "qa-unresolved-queue" }, execution_order: 2 },
    { action_type: "assign_to_bot",
      action_target: { botId: o.botId || "qa-unresolved-bot" }, execution_order: 3 },
    { action_type: "assign_to_ai_agent",
      action_target: { aiAgentId: o.aiAgentId || "qa-unresolved-ai-agent" }, execution_order: 4 },
    { action_type: "add_tags", action_target: { tags: [o.addTag] }, execution_order: 5 },
    { action_type: "remove_tags", action_target: { tags: [o.removeTag] }, execution_order: 6 },
    { action_type: "update_custom_fields",
      action_target: { fields: { [o.customFieldKey]: o.customFieldValue } }, execution_order: 7 },
    { action_type: "send_reply",
      action_target: { message: o.replyMessage, channel: "public" }, execution_order: 8 },
    { action_type: "change_status", action_target: { status: o.status }, execution_order: 9 },
    { action_type: "escalate_priority",
      action_target: { priority: o.priority || "high" }, execution_order: 10 },
    { action_type: "add_note",
      action_target: { note_content: o.noteContent, visibility: "internal" }, execution_order: 11 },
    { action_type: "send_csat_survey",
      action_target: { channel: "in_app", delayMinutes: 0 }, execution_order: 12 },
  ];
}
/** Presence-valid all-actions set for dry-run drafts (placeholder ids are fine:
 *  dry-run only validates action shape + condition evaluation). */
export function dryRunAllActions(): Array<Record<string, unknown>> {
  return buildAllActions({
    addTag: "qa-flow-tag",
    removeTag: "qa-webchat-tag",
    replyMessage: "qa dry-run reply",
    noteContent: "qa dry-run note",
    status: "In Progress",
    customFieldKey: "qa_dryrun_field",
    customFieldValue: "1",
  });
}

export interface DryRunOutcome {
  /** backend rejected the draft (>=400) — surfaced as data, not a crash */
  rejected: boolean;
  status: number;
  /** derived conditions-met verdict (every action would_execute) */
  met: boolean;
  results: Array<Record<string, unknown>>;
  body?: unknown;
}

/**
 * Evaluate a draft rule (conditions + all 12 actions) against a synthetic
 * ticket via the dry-run test endpoint. Flat arrays = implicit AND; pass a
 * {operator, groups} object for AND/OR group semantics. Uses the shared probe
 * rule as the anchor (rule id is only an anchor in draft mode).
 */
export async function runDryRunRule(
  ctx: RunContext,
  opts: {
    name: string;
    conditions: unknown;
    testTicket: Record<string, unknown>;
    triggerType?: string;
    actions?: Array<Record<string, unknown>>;
  }
): Promise<DryRunOutcome> {
  const ruleId = await ensureProbeRule(ctx);
  const api = ctx.api("AUTOMATION");
  const res = await api.post(`/api/automation/rules/${ruleId}/test`, {
    test_ticket: opts.testTicket,
    test_mode: "dry_run",
    rule_draft: {
      name: opts.name,
      description: "qa-framework webchat filter case",
      priority: uniqueRulePriority(),
      trigger: {
        trigger_type: opts.triggerType ?? "ticket_created",
        conditions: opts.conditions,
      },
      actions: opts.actions ?? dryRunAllActions(),
    },
  });
  if (res.status >= 400) {
    return { rejected: true, status: res.status, met: false, results: [], body: res.data };
  }
  const data = ApiClient.unwrap<Record<string, unknown>>(res);
  const results = extractActionResults(data);
  return { rejected: false, status: res.status, met: deriveConditionsMet(results), results, body: data };
}


