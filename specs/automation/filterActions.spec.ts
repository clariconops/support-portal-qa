import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineFeature } from "../../src/orchestrator/suite.js";
import { ApiClient } from "../../src/api/http.js";
import { assert, type RunContext } from "../../src/orchestrator/context.js";
import {
  buildAllActions,
  ensureTag,
  runDryRunRule,
  uniqueRulePriority,
} from "./automationHarness.js";
import {
  WEBCHAT_FILTER_CASES,
  WEBCHAT_COMBINATION_CASES,
  conditionOf,
} from "../../src/domain/webchatFilterCatalog.js";
import { resolveWebchatIds } from "../../src/fixtures/platform.js";

/**
 * Webchat filter combinations × all actions, for both trigger families:
 *
 * 1. Issue CREATION (ticket_created):
 *    - dry-run matrix: every (field × operator) the dashboard offers for
 *      webchat tickets (app/platform/language/tags/subject/status/priority/
 *      is_urgent), each evaluated against a matching AND a mismatching ticket,
 *      with ALL 12 supported actions attached to every evaluation.
 *    - dry-run combinations: flat AND + nested AND/OR groups across
 *      app × platform × language × tags × subject.
 *    - live e2e: a real webchat ticket that satisfies the core combo
 *      (app is + platform is one of + language is) fires a real rule carrying
 *      all 12 actions; a ticket failing one dimension is left untouched.
 *
 * 2. Issue UPDATE (derived triggers — the product intentionally disables the
 *    generic "ticket_updated" rule type and derives specific triggers from
 *    ticket_updated events, see services/automation-service/src/index.ts):
 *    - ticket_status_changed: PUT status on an eligible webchat ticket fires
 *      the rule (and creation alone must NOT fire it).
 *    - tag_added: PUT tags on an eligible webchat ticket fires the rule.
 *
 * Every real rule's conditions include a unique subject token so rules can
 * never cross-fire on tickets created by other features/behaviours.
 * Strict assertions cover observable effects (tags, custom fields, reply,
 * note, status); infra-dependent effects (assignments, priority escalation,
 * CSAT survey) are validity-checked in dry-run and recorded best-effort here
 * because they depend on agents/queues/bots existing in the environment.
 */

const REPLY_TOKEN_PREFIX = "qa-filter-reply";
const NOTE_TOKEN_PREFIX = "qa-filter-note";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Write a JSON artifact under runDir and register it for the report. */
function writeArtifact(ctx: RunContext, relPath: string, data: unknown): void {
  const abs = join(ctx.runDir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(data, null, 2));
  ctx.addArtifact(relPath);
}

function webchatRequesterId(): string {
  return `webchat_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

/** Create a ticket the way the webchat widget does (anonymous requester). */
async function createWebchatTicket(
  ctx: RunContext,
  opts: { subject: string; tags?: string[]; description?: string }
): Promise<string> {
  const { platformId, appId } = await resolveWebchatIds(ctx);
  const res = await ctx.api("TICKET").post("/api/tickets", {
    subject: opts.subject,
    description: opts.description ?? "created by qa-framework filter-actions suite",
    channel: "webchat",
    requester_id: webchatRequesterId(),
    platform_id: platformId,
    app_id: appId,
    // tickets.language has DEFAULT 'english'; metadata mirrors the widget.
    metadata: { source: "webchat", channel: "webchat", language: "english" },
    tags: opts.tags ?? [],
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

/** Create a real automation rule (validated by the product on create). */
async function createRule(
  ctx: RunContext,
  opts: {
    triggerType: string;
    conditions: unknown;
    actions: Array<Record<string, unknown>>;
    name?: string;
  }
): Promise<string> {
  await ctx.session.loginAs("admin");
  const res = await ctx.api("AUTOMATION").post("/api/automation/rules", {
    name: opts.name ?? `qa-filter-${Date.now()}`,
    description: "qa-framework webchat filter-actions rule",
    priority: uniqueRulePriority(),
    trigger: { trigger_type: opts.triggerType, is_active: true, conditions: opts.conditions },
    actions: opts.actions,
  });
  assert(
    res.status < 400,
    `rule creation failed (${res.status}): ${JSON.stringify(res.data).slice(0, 300)}`
  );
  const created = ApiClient.unwrap<{ id?: string; rule_id?: string }>(res);
  const id = created.id ?? created.rule_id;
  assert(id, `rule response missing id: ${JSON.stringify(created)}`);
  ctx.trackResource({ kind: "rule", service: "AUTOMATION", id });
  return id;
}
/** Deep-find the first array whose elements look like defs ({name|slug|...}). */
function extractDefList(payload: unknown): Array<Record<string, unknown>> {
  const queue: unknown[] = [payload];
  while (queue.length) {
    const cur = queue.shift();
    if (Array.isArray(cur)) {
      const objs = cur.filter(
        (x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)
      );
      if (
        objs.length > 0 &&
        objs.every((o) => "name" in o || "slug" in o || "status" in o)
      ) {
        return objs;
      }
      queue.push(...cur);
      continue;
    }
    if (cur && typeof cur === "object") queue.push(...Object.values(cur as Record<string, unknown>));
  }
  return [];
}

/** Deep-find arrays of strings (e.g. valid-transition name lists). */
function extractStringList(payload: unknown): string[] {
  const queue: unknown[] = [payload];
  while (queue.length) {
    const cur = queue.shift();
    if (Array.isArray(cur)) {
      if (cur.length > 0 && cur.every((x) => typeof x === "string")) return cur as string[];
      queue.push(...cur);
      continue;
    }
    if (cur && typeof cur === "object") queue.push(...Object.values(cur as Record<string, unknown>));
  }
  return [];
}

function defName(o: Record<string, unknown>): string {
  return String(o.name ?? o.status ?? o.slug ?? o.title ?? "").trim();
}

const TERMINAL = /resolved|closed/i;

async function fetchStatusDefs(ctx: RunContext): Promise<Array<Record<string, unknown>>> {
  await ctx.session.loginAs("admin");
  const res = await ctx.api("TICKET").get("/api/definitions/statuses");
  if (res.status >= 400) return [];
  return extractDefList(res.data);
}

async function fetchValidTransitions(ctx: RunContext, fromStatus: string): Promise<string[]> {
  await ctx.session.loginAs("admin");
  const res = await ctx.api("TICKET").get(
    `/api/definitions/statuses/valid-transitions?fromStatus=${encodeURIComponent(fromStatus)}`
  );
  if (res.status >= 400) return [];
  const named = extractDefList(res.data).map(defName).filter(Boolean);
  return named.length ? named : extractStringList(res.data);
}
/**
 * Pick the change_status target for a rule BEFORE any ticket exists:
 * prefer a real transition out of the default status; fall back to any
 * non-default non-terminal status. `resolved` is true only when the product's
 * valid-transitions endpoint confirmed the pick (strict assertions then apply).
 */
async function resolveChangeStatusTarget(
  ctx: RunContext
): Promise<{ target: string; resolved: boolean }> {
  const defs = await fetchStatusDefs(ctx);
  if (!defs.length) return { target: "In Progress", resolved: false };
  const defaultDef =
    defs.find((d) => d.is_default === true || d.isDefault === true) ?? defs[0];
  const from = defName(defaultDef) || "Open";
  const transitions = (await fetchValidTransitions(ctx, from)).filter(
    (n) => n.toLowerCase() !== from.toLowerCase() && !TERMINAL.test(n)
  );
  if (transitions.length) return { target: transitions[0], resolved: true };
  const alt = defs
    .map(defName)
    .filter((n) => n && n.toLowerCase() !== from.toLowerCase() && !TERMINAL.test(n));
  if (alt.length) return { target: alt[0], resolved: false };
  return { target: "In Progress", resolved: false };
}

/** Pick a valid transition target FROM a live ticket's current status. */
async function pickTransitionTarget(ctx: RunContext, currentStatus: string): Promise<string> {
  const transitions = await fetchValidTransitions(ctx, currentStatus);
  const pick =
    transitions.find((n) => n.toLowerCase() !== currentStatus.toLowerCase() && !TERMINAL.test(n)) ??
    transitions.find((n) => n.toLowerCase() !== currentStatus.toLowerCase());
  if (pick) return pick;
  const defs = await fetchStatusDefs(ctx);
  const alt = defs
    .map(defName)
    .filter((n) => n && n.toLowerCase() !== currentStatus.toLowerCase() && !TERMINAL.test(n));
  assert(
    alt.length > 0,
    `no valid transition target from status "${currentStatus}" ` +
      `(transitions=${JSON.stringify(transitions)}, defs=${JSON.stringify(defs.map(defName))})`
  );
  return alt[0];
}

async function getTicketDetail(
  ctx: RunContext,
  ticketId: string
): Promise<Record<string, unknown>> {
  const res = await ctx.api("TICKET").get(`/api/tickets/${ticketId}`);
  assert(res.status < 400, `ticket detail failed (${res.status})`);
  return ApiClient.unwrap<Record<string, unknown>>(res);
}

/** JSON text of all ticket messages (reply / note / csat evidence). */
async function getMessagesText(ctx: RunContext, ticketId: string): Promise<string> {
  const res = await ctx.api("TICKET").get(`/api/tickets/${ticketId}/messages?limit=100`);
  return JSON.stringify(res.data ?? "");
}

/** Best-effort admin user id (for assign_to_agent); "" when unavailable. */
async function resolveAgentId(ctx: RunContext): Promise<string> {
  try {
    await ctx.session.loginAs("admin");
    const me = (await ctx.session.me()) as Record<string, unknown> | undefined;
    const id = me ? String(me.id ?? me.user_id ?? "") : "";
    return id && id !== "undefined" ? id : "";
  } catch {
    return "";
  }
}

/** Best-effort queue id from the queue service ("" when none found). */
async function resolveQueueId(ctx: RunContext): Promise<string> {
  try {
    await ctx.session.loginAs("admin");
    const res = await ctx.api("QUEUE").get("/api/queues");
    if (res.status >= 400) return "";
    const list = extractDefList(res.data);
    const withId = list.find((q) => q.id ?? q.queue_id);
    return String(withId?.id ?? withId?.queue_id ?? "");
  } catch {
    return "";
  }
}

/** Best-effort bot id from the bot service ("" when none found). */
async function resolveBotId(ctx: RunContext): Promise<string> {
  try {
    await ctx.session.loginAs("admin");
    const res = await ctx.api("BOT").get("/api/bots");
    if (res.status >= 400) return "";
    const list = extractDefList(res.data);
    const withId = list.find((b) => b.id ?? b.bot_id);
    return String(withId?.id ?? withId?.bot_id ?? "");
  } catch {
    return "";
  }
}
const suite = defineFeature("automation-filter-actions", (s) => {
  // "filteractions.dryrun.field_operator_matrix"
  s.behaviour("filteractions.dryrun.field_operator_matrix", async (ctx) => {
    const caseResults: unknown[] = [];
    const failures: string[] = [];

    for (const c of WEBCHAT_FILTER_CASES) {
      const variants = [
        { kind: "match", ticket: c.matchTicket, expected: true },
        { kind: "mismatch", ticket: c.mismatchTicket, expected: false },
      ] as const;

      for (const v of variants) {
        const out = await runDryRunRule(ctx, {
          name: `qa-fm-${c.id}-${v.kind}`,
          conditions: [conditionOf(c)],
          testTicket: v.ticket,
        });
        const row = {
          case: c.id,
          kind: v.kind,
          expected: v.expected,
          rejected: out.rejected,
          status: out.status,
          met: out.met,
          actionTypes: out.results.map((r) => r.action_type),
          wouldExecute: out.results.map((r) => r.would_execute),
          errors: out.results
            .map((r) => r.error_message)
            .filter((e) => typeof e === "string" && e),
        };
        caseResults.push(row);

        if (out.rejected) {
          failures.push(`${c.id}/${v.kind}: draft rejected (${out.status})`);
          continue;
        }
        // every one of the 12 actions must be present and agree on the verdict
        if (out.results.length !== 12) {
          failures.push(
            `${c.id}/${v.kind}: expected 12 action results, got ${out.results.length}`
          );
        }
        if (out.met !== v.expected) {
          failures.push(
            `${c.id}/${v.kind}: expected conditions ${v.expected ? "met" : "not met"}, ` +
              `got met=${out.met} (would_execute=${JSON.stringify(row.wouldExecute)})`
          );
        }
      }
    }

    writeArtifact(ctx, "artifacts/filter-actions/field-operator-matrix.json", caseResults);
    assert(
      failures.length === 0,
      `${failures.length} field/operator matrix failure(s):\n${failures.join("\n")}`
    );
  });

  // "filteractions.dryrun.condition_combinations"
  s.behaviour("filteractions.dryrun.condition_combinations", async (ctx) => {
    const caseResults: unknown[] = [];
    const failures: string[] = [];

    for (const combo of WEBCHAT_COMBINATION_CASES) {
      const out = await runDryRunRule(ctx, {
        name: `qa-combo-${combo.id}`,
        conditions: combo.conditions,
        testTicket: combo.testTicket,
      });
      caseResults.push({
        case: combo.id,
        description: combo.description,
        expected: combo.expected,
        rejected: out.rejected,
        status: out.status,
        met: out.met,
        actionTypes: out.results.map((r) => r.action_type),
        wouldExecute: out.results.map((r) => r.would_execute),
      });

      if (out.rejected) {
        failures.push(`${combo.id}: draft rejected (${out.status})`);
        continue;
      }
      if (out.results.length !== 12) {
        failures.push(`${combo.id}: expected 12 action results, got ${out.results.length}`);
      }
      if (out.met !== combo.expected) {
        failures.push(
          `${combo.id} (${combo.description}): expected ${combo.expected}, got ${out.met}`
        );
      }
    }

    writeArtifact(ctx, "artifacts/filter-actions/condition-combinations.json", caseResults);
    assert(
      failures.length === 0,
      `${failures.length} combination failure(s):\n${failures.join("\n")}`
    );
  });
  // "filteractions.real.match_webchat_all_actions"
  s.behaviour("filteractions.real.match_webchat_all_actions", async (ctx) => {
    const tok = Date.now().toString(36);
    const ADD_TAG = "qa-filter-added";
    const PRE_TAG = "qa-filter-pre";
    const CF_KEY = "qa_automation_filter";
    const CF_VAL = "applied";
    const replyTok = `${REPLY_TOKEN_PREFIX}-${tok}`;
    const noteTok = `${NOTE_TOKEN_PREFIX}-${tok}`;
    await ensureTag(ctx, ADD_TAG);

    const { platformId, appId } = await resolveWebchatIds(ctx);
    const statusTarget = await resolveChangeStatusTarget(ctx);
    const [agentId, queueId, botId] = [
      await resolveAgentId(ctx),
      await resolveQueueId(ctx),
      await resolveBotId(ctx),
    ];

    const conditions = [
      { field: "app", operator: "equals", value: appId },
      { field: "platform", operator: "has_one_of", value: [platformId] },
      { field: "language", operator: "equals", value: "english" },
      { field: "subject", operator: "contains", value: tok },
    ];
    const actions = buildAllActions({
      addTag: ADD_TAG,
      removeTag: PRE_TAG,
      replyMessage: replyTok,
      noteContent: noteTok,
      status: statusTarget.target,
      customFieldKey: CF_KEY,
      customFieldValue: CF_VAL,
      agentId,
      queueId,
      botId,
      // no AI-agent service is configured for this environment → placeholder;
      // the action validates on create (presence-only) and fails soft at
      // execution (fail-continue) — dry-run coverage pins would_execute.
      //
      // remove_tags is EXCLUDED from this live rule on purpose: actions run in
      // PARALLEL by default and add_tags/remove_tags both PUT the whole tags
      // array computed from the same event snapshot (last-writer-wins → lost
      // update). Its real effect is strictly verified by
      // filteractions.update.tag_added_fires (single-action rule) instead;
      // dry-run validation still covers it with all 12 actions.
    }).filter((a) => a.action_type !== "remove_tags");
    await createRule(ctx, {
      triggerType: "ticket_created",
      conditions,
      actions,
      name: `qa-filter-match-${tok}`,
    });

    const ticketId = await createWebchatTicket(ctx, {
      subject: `qa-filter-match ${tok} refund request`,
      // NOTE: passing `tags` at create is currently impossible — the create
      // validator reads req.user?.tenant_id (snake_case) while the auth
      // middleware sets tenantId (camelCase) → always 400
      // "Authentication required for tag validation" (product bug).
    });
    const originalDetail = await getTicketDetail(ctx, ticketId);
    const originalStatus = String(originalDetail.status ?? "");

    const collectMissing = async (): Promise<string[]> => {
      const detail = await getTicketDetail(ctx, ticketId);
      const messages = await getMessagesText(ctx, ticketId);
      const haystack = JSON.stringify(detail) + messages;
      const tags = Array.isArray(detail.tags)
        ? detail.tags.map(String)
        : String(detail.tags ?? "")
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean);
      const missing: string[] = [];
      if (!tags.includes(ADD_TAG)) missing.push(`add_tags(${ADD_TAG})`);
      const cf = (detail.custom_fields ?? {}) as Record<string, unknown>;
      if (String(cf[CF_KEY] ?? "") !== CF_VAL) {
        missing.push(`update_custom_fields(${CF_KEY})`);
      }
      if (!haystack.includes(replyTok)) missing.push("send_reply(message)");
      if (!haystack.includes(noteTok)) missing.push("add_note(message)");
      if (
        statusTarget.resolved &&
        String(detail.status ?? "").toLowerCase() !== statusTarget.target.toLowerCase()
      ) {
        missing.push(`change_status(${statusTarget.target}, current=${detail.status})`);
      }
      return missing;
    };

    let missing: string[] = ["(startup)"];
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      try {
        missing = await collectMissing();
        if (missing.length === 0) break;
      } catch (e) {
        missing = [`(poll error: ${(e as Error).message})`];
      }
      await sleep(1_500);
    }
    assert(
      missing.length === 0,
      `all-actions rule did not fully apply within 90s; still missing: ${missing.join(", ")}`
    );

    // Final state evidence + best-effort record for infra-dependent actions
    // (assignments / priority escalation / CSAT survey need agents, queues,
    // bots or survey config that may not exist in every environment — their
    // validity is strictly covered by the dry-run matrix above).
    const finalDetail = await getTicketDetail(ctx, ticketId);
    const finalHaystack =
      JSON.stringify(finalDetail) + (await getMessagesText(ctx, ticketId));
    writeArtifact(ctx, `artifacts/filter-actions/live-match-${tok}.json`, {
      ticketId,
      statusTarget,
      resolved: { agentId, queueId, botId },
      final: {
        status: finalDetail.status,
        originalStatus,
        tags: finalDetail.tags,
        custom_fields: finalDetail.custom_fields,
        assignee_id: finalDetail.assignee_id ?? null,
        queue_id: finalDetail.queue_id ?? null,
        priority: finalDetail.priority,
        csatMessagePresent:
          finalHaystack.includes("rate your experience") ||
          finalHaystack.includes("survey_url"),
      },
      strictChecks: [
        "add_tags present",
        "update_custom_fields applied",
        "send_reply message present",
        "add_note message present",
        ...(statusTarget.resolved ? [`change_status → ${statusTarget.target}`] : []),
      ],
      notes: [
        "remove_tags excluded from this parallel rule (same-snapshot whole-array PUT race with add_tags); " +
          "its live effect is asserted by filteractions.update.tag_added_fires",
        "all 12 action types are validated would_execute=true by filteractions.dryrun.field_operator_matrix",
      ],
    });
  });
  // "filteractions.real.no_match_webchat_untouched"
  s.behaviour("filteractions.real.no_match_webchat_untouched", async (ctx) => {
    const tok = Date.now().toString(36);
    const ADD_TAG = "qa-filter-added";
    const CF_KEY = "qa_automation_filter";
    const replyTok = `${REPLY_TOKEN_PREFIX}-${tok}`;
    const noteTok = `${NOTE_TOKEN_PREFIX}-${tok}`;
    const { appId } = await resolveWebchatIds(ctx);
    const statusTarget = await resolveChangeStatusTarget(ctx);

    // Same shape as the matching rule, but platform is-one-of lists a fake id:
    // exactly one dimension (platform) disqualifies the real webchat ticket.
    const conditions = [
      { field: "app", operator: "equals", value: appId },
      { field: "platform", operator: "has_one_of", value: ["qa_nonexistent_platform"] },
      { field: "language", operator: "equals", value: "english" },
      { field: "subject", operator: "contains", value: tok },
    ];
    await createRule(ctx, {
      triggerType: "ticket_created",
      conditions,
      actions: buildAllActions({
        addTag: ADD_TAG,
        removeTag: "qa-filter-pre",
        replyMessage: replyTok,
        noteContent: noteTok,
        status: statusTarget.target,
        customFieldKey: CF_KEY,
        customFieldValue: "applied",
      }),
      name: `qa-filter-nomatch-${tok}`,
    });

    const ticketId = await createWebchatTicket(ctx, {
      subject: `qa-filter-nomatch ${tok} shipping delay`,
    });
    await sleep(6_000);

    const detail = await getTicketDetail(ctx, ticketId);
    const haystack = JSON.stringify(detail) + (await getMessagesText(ctx, ticketId));
    const tags = Array.isArray(detail.tags) ? detail.tags.map(String) : [];
    const cf = (detail.custom_fields ?? {}) as Record<string, unknown>;
    const problems: string[] = [];
    if (tags.includes(ADD_TAG)) problems.push(`add_tags fired (${ADD_TAG} present)`);
    if (String(cf[CF_KEY] ?? "") === "applied") problems.push("update_custom_fields fired");
    if (haystack.includes(replyTok)) problems.push("send_reply fired");
    if (haystack.includes(noteTok)) problems.push("add_note fired");
    if (
      statusTarget.resolved &&
      String(detail.status ?? "").toLowerCase() === statusTarget.target.toLowerCase()
    ) {
      problems.push(`change_status fired (status=${detail.status})`);
    }
    assert(
      problems.length === 0,
      `non-matching webchat ticket was modified (platform is-one-of miss): ${problems.join("; ")}`
    );
    writeArtifact(ctx, `artifacts/filter-actions/live-nomatch-${tok}.json`, {
      ticketId,
      conditions,
      observed: { tags: detail.tags, custom_fields: detail.custom_fields, status: detail.status },
    });
  });
  // "filteractions.update.status_changed_fires"
  s.behaviour("filteractions.update.status_changed_fires", async (ctx) => {
    const tok = Date.now().toString(36);
    const STATUS_TAG = "qa-filter-status-tag";
    await ensureTag(ctx, STATUS_TAG);
    const { appId } = await resolveWebchatIds(ctx);

    // Issue-UPDATE trigger: the product derives ticket_status_changed from
    // ticket_updated events (generic ticket_updated rules are disabled —
    // see services/automation-service/src/index.ts).
    await createRule(ctx, {
      triggerType: "ticket_status_changed",
      conditions: [
        { field: "app", operator: "equals", value: appId },
        { field: "language", operator: "equals", value: "english" },
        { field: "subject", operator: "contains", value: tok },
      ],
      actions: [
        { action_type: "add_tags", action_target: { tags: [STATUS_TAG] }, execution_order: 1 },
      ],
      name: `qa-filter-status-changed-${tok}`,
    });

    const ticketId = await createWebchatTicket(ctx, {
      subject: `qa-filter-update-status ${tok} refund request`,
    });

    // Creation must NOT fire an update trigger.
    await sleep(6_000);
    const beforeTags = await getTicketDetail(ctx, ticketId).then(
      (d) => (Array.isArray(d.tags) ? d.tags.map(String) : [])
    );
    assert(
      !beforeTags.includes(STATUS_TAG),
      `ticket_status_changed rule fired on ticket CREATION (tag ${STATUS_TAG} present)`
    );

    // Perform the update → derived ticket_status_changed → rule fires.
    const detail = await getTicketDetail(ctx, ticketId);
    const target = await pickTransitionTarget(ctx, String(detail.status ?? ""));
    await ctx.session.loginAs("admin");
    const put = await ctx.api("TICKET").put(`/api/tickets/${ticketId}`, {
      status: target,
      update_reason: "qa filter-actions status-change trigger test",
    });
    assert(
      put.status < 400,
      `status update failed (${put.status}): ${JSON.stringify(put.data).slice(0, 300)}`
    );

    await ctx.waitFor(
      async () => {
        const d = await getTicketDetail(ctx, ticketId);
        const t = Array.isArray(d.tags) ? d.tags.map(String) : [];
        return t.includes(STATUS_TAG) || undefined;
      },
      { label: `ticket_status_changed rule applied ${STATUS_TAG}`, timeoutMs: 60_000, intervalMs: 1_500 }
    );

    const afterUpdate = await getTicketDetail(ctx, ticketId);
    const afterTags = Array.isArray(afterUpdate.tags) ? afterUpdate.tags.map(String) : [];
    writeArtifact(ctx, `artifacts/filter-actions/update-status-changed-${tok}.json`, {
      ticketId,
      triggerType: "ticket_status_changed",
      conditions: { app: appId, language: "english", subjectContains: tok },
      action: { add_tags: [STATUS_TAG] },
      evidence: {
        tagsAfterCreation: beforeTags,
        statusBeforeUpdate: detail.status,
        requestedStatus: target,
        statusAfterRule: afterUpdate.status,
        tagsAfterRule: afterTags,
      },
      strictChecks: [
        `creation alone did NOT add ${STATUS_TAG}`,
        `status-change update added ${STATUS_TAG}`,
      ],
    });
  });
  // "filteractions.update.tag_added_fires"
  s.behaviour("filteractions.update.tag_added_fires", async (ctx) => {
    const tok = Date.now().toString(36);
    const FIRE_TAG = "qa-filter-fire";
    const PRE_TAG = "qa-filter-pre";
    const CANARY_KEY = "qa_tag_added_canary";
    await ensureTag(ctx, FIRE_TAG);
    await ensureTag(ctx, PRE_TAG);
    const { appId } = await resolveWebchatIds(ctx);

    // Issue-UPDATE derived trigger: tag_added. Actions: remove_tags (the
    // effect we strictly verify — single tag writer, no parallel RMW race)
    // plus a custom_fields canary (different column ⇒ race-free) that lets us
    // prove the rule did NOT fire on creation and DID fire on the update.
    await createRule(ctx, {
      triggerType: "tag_added",
      conditions: [
        { field: "app", operator: "equals", value: appId },
        { field: "subject", operator: "contains", value: tok },
      ],
      actions: [
        { action_type: "remove_tags", action_target: { tags: [PRE_TAG] }, execution_order: 1 },
        { action_type: "update_custom_fields",
          action_target: { fields: { [CANARY_KEY]: tok } }, execution_order: 2 },
      ],
      name: `qa-filter-tag-added-${tok}`,
    });

    const ticketId = await createWebchatTicket(ctx, {
      subject: `qa-filter-update-tag ${tok} refund request`,
    });

    // Creation must NOT fire the update trigger: canary stays unset.
    await sleep(6_000);
    const before = await getTicketDetail(ctx, ticketId);
    const beforeCf = (before.custom_fields ?? {}) as Record<string, unknown>;
    assert(
      String(beforeCf[CANARY_KEY] ?? "") !== tok,
      `tag_added rule fired on ticket CREATION (canary ${CANARY_KEY} set)`
    );
    const beforeTags = Array.isArray(before.tags) ? before.tags.map(String) : [];
    assert(
      !beforeTags.includes(PRE_TAG),
      `unexpected PRE tag on freshly created ticket: ${JSON.stringify(beforeTags)}`
    );

    // Perform the update: add FIRE + PRE tags → derived tag_added fires.
    await ctx.session.loginAs("admin");
    const put = await ctx.api("TICKET").put(`/api/tickets/${ticketId}`, {
      tags: [...beforeTags, FIRE_TAG, PRE_TAG],
      update_reason: "qa filter-actions tag-added trigger test",
    });
    assert(
      put.status < 400,
      `tags update failed (${put.status}): ${JSON.stringify(put.data).slice(0, 300)}`
    );
    // The PUT response proves PRE landed (otherwise removal below proves nothing).
    const updated = ApiClient.unwrap<Record<string, unknown>>(put);
    const putTags = Array.isArray(updated.tags) ? updated.tags.map(String) : [];
    assert(
      putTags.includes(PRE_TAG),
      `PUT response missing ${PRE_TAG}: ${JSON.stringify(putTags)}`
    );

    // Rule must fire: canary set AND PRE removed (FIRE survives).
    const deadline = Date.now() + 60_000;
    let missing = ["(startup)"];
    while (Date.now() < deadline) {
      const d = await getTicketDetail(ctx, ticketId);
      const t = Array.isArray(d.tags) ? d.tags.map(String) : [];
      const cf = (d.custom_fields ?? {}) as Record<string, unknown>;
      missing = [];
      if (String(cf[CANARY_KEY] ?? "") !== tok) missing.push(`canary ${CANARY_KEY}`);
      if (t.includes(PRE_TAG)) missing.push(`remove_tags(${PRE_TAG} still present)`);
      if (!t.includes(FIRE_TAG)) missing.push(`trigger tag ${FIRE_TAG} lost`);
      if (missing.length === 0) break;
      await sleep(1_500);
    }
    assert(
      missing.length === 0,
      `tag_added rule did not fully apply within 60s; still missing: ${missing.join(", ")}`
    );

    const final = await getTicketDetail(ctx, ticketId);
    writeArtifact(ctx, `artifacts/filter-actions/update-tag-added-${tok}.json`, {
      ticketId,
      triggerType: "tag_added",
      conditions: { app: appId, subjectContains: tok },
      actions: { remove_tags: [PRE_TAG], update_custom_fields: { [CANARY_KEY]: tok } },
      evidence: {
        tagsAfterCreation: beforeTags,
        tagsInPutResponse: putTags,
        tagsAfterRule: final.tags,
        customFieldsAfterRule: final.custom_fields,
      },
      strictChecks: [
        `creation alone did NOT set canary ${CANARY_KEY}`,
        `tag-added update set canary ${CANARY_KEY}=${tok}`,
        `remove_tags effect: ${PRE_TAG} gone`,
        `trigger tag ${FIRE_TAG} preserved`,
      ],
    });
  });
});

export default suite;







