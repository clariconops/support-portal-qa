/**
 * Webchat-eligible ticket filter catalog.
 *
 * Covers the filter fields/operators the dashboard offers for webchat-driven
 * tickets (AutomationRuleBuilder OPERATOR_DEFINITIONS / FIELD_DEFINITIONS) and
 * which the backend `evaluateCondition` switch implements:
 *
 *  - app      → app_id        (database_select:      is / is not / is set / is not set)
 *  - platform → platform_id   (database_multiselect: is one of / is none of / has all of / set)
 *  - language → language      (database_select; tickets.language DEFAULT 'english')
 *  - tags     → tags[]        (database_multiselect)
 *  - subject  → subject       (text operators)
 *  - status   → status        (database_select; real value = status definition name)
 *  - priority → priority      (select; real value = integer level — dry-run only)
 *  - is_urgent                (boolean)
 *
 * Every single-condition case carries TWO synthetic test tickets for the
 * dry-run endpoint (POST /api/automation/rules/:id/test with `rule_draft` +
 * `test_mode:"dry_run"`):
 *   - `matchTicket`    satisfies the condition → every action would_execute:true
 *   - `mismatchTicket` fails the condition     → every action would_execute:false
 *
 * Combination cases exercise flat AND/OR arrays and the nested
 * {operator, groups:[{operator, conditions}]} payload across
 * app × platform × language × tags × subject.
 */

export interface WebchatFilterCase {
  /** unique slug (used in dry-run draft names + failure messages) */
  id: string;
  /** condition field (definition key — what the dashboard sends) */
  field: string;
  operator: string;
  /** omit for valueless operators (is_set / is_not_set) */
  conditionValue?: unknown;
  /** synthetic ticket that MUST satisfy the condition */
  matchTicket: Record<string, unknown>;
  /** synthetic ticket that must NOT satisfy the condition */
  mismatchTicket: Record<string, unknown>;
}

/** Single-condition cases: (field × operator) with crafted match/mismatch tickets. */
export const WEBCHAT_FILTER_CASES: WebchatFilterCase[] = [
  // ── app (select → app_id) ────────────────────────────────────────────────
  { id: "app.equals", field: "app", operator: "equals", conditionValue: "app_alpha",
    matchTicket: { app_id: "app_alpha" }, mismatchTicket: { app_id: "app_beta" } },
  { id: "app.not_equals", field: "app", operator: "not_equals", conditionValue: "app_alpha",
    matchTicket: { app_id: "app_beta" }, mismatchTicket: { app_id: "app_alpha" } },
  { id: "app.is_set", field: "app", operator: "is_set",
    matchTicket: { app_id: "app_alpha" }, mismatchTicket: {} },
  { id: "app.is_not_set", field: "app", operator: "is_not_set",
    matchTicket: {}, mismatchTicket: { app_id: "app_alpha" } },

  // ── platform (multiselect → platform_id) ────────────────────────────────
  { id: "platform.has_one_of", field: "platform", operator: "has_one_of",
    conditionValue: ["plat_one", "plat_two"],
    matchTicket: { platform_id: "plat_one" }, mismatchTicket: { platform_id: "plat_three" } },
  { id: "platform.has_none_of", field: "platform", operator: "has_none_of",
    conditionValue: ["plat_one"],
    matchTicket: { platform_id: "plat_three" }, mismatchTicket: { platform_id: "plat_one" } },
  { id: "platform.has_all_of", field: "platform", operator: "has_all_of",
    conditionValue: ["plat_one"],
    matchTicket: { platform_id: "plat_one" }, mismatchTicket: { platform_id: "plat_three" } },
  { id: "platform.is_set", field: "platform", operator: "is_set",
    matchTicket: { platform_id: "plat_one" }, mismatchTicket: {} },
  { id: "platform.is_not_set", field: "platform", operator: "is_not_set",
    matchTicket: {}, mismatchTicket: { platform_id: "plat_one" } },

  // ── language (select → language, column default 'english') ──────────────
  { id: "language.equals", field: "language", operator: "equals", conditionValue: "english",
    matchTicket: { language: "english" }, mismatchTicket: { language: "german" } },
  { id: "language.not_equals", field: "language", operator: "not_equals", conditionValue: "english",
    matchTicket: { language: "german" }, mismatchTicket: { language: "english" } },
  { id: "language.is_set", field: "language", operator: "is_set",
    matchTicket: { language: "english" }, mismatchTicket: {} },
  { id: "language.is_not_set", field: "language", operator: "is_not_set",
    matchTicket: {}, mismatchTicket: { language: "english" } },

  // ── tags (multiselect → tags[]) ─────────────────────────────────────────
  { id: "tags.has_one_of", field: "tags", operator: "has_one_of", conditionValue: ["vip"],
    matchTicket: { tags: ["vip", "billing"] }, mismatchTicket: { tags: ["general"] } },
  { id: "tags.has_none_of", field: "tags", operator: "has_none_of", conditionValue: ["vip"],
    matchTicket: { tags: ["general"] }, mismatchTicket: { tags: ["vip", "billing"] } },
  { id: "tags.has_all_of", field: "tags", operator: "has_all_of",
    conditionValue: ["vip", "billing"],
    matchTicket: { tags: ["vip", "billing", "extra"] }, mismatchTicket: { tags: ["vip"] } },
  { id: "tags.is_set", field: "tags", operator: "is_set",
    matchTicket: { tags: ["vip"] }, mismatchTicket: {} },
  { id: "tags.is_not_set", field: "tags", operator: "is_not_set",
    matchTicket: {}, mismatchTicket: { tags: ["vip"] } },

  // ── subject (text) ──────────────────────────────────────────────────────
  { id: "subject.contains", field: "subject", operator: "contains", conditionValue: "refund",
    matchTicket: { subject: "Refund requested" }, mismatchTicket: { subject: "shipping delay" } },
  { id: "subject.not_contains", field: "subject", operator: "not_contains", conditionValue: "refund",
    matchTicket: { subject: "shipping delay" }, mismatchTicket: { subject: "Refund requested" } },
  { id: "subject.starts_with", field: "subject", operator: "starts_with", conditionValue: "Ref",
    matchTicket: { subject: "Refund requested" }, mismatchTicket: { subject: "Shipping delay" } },
  { id: "subject.ends_with", field: "subject", operator: "ends_with", conditionValue: "delay",
    matchTicket: { subject: "shipping delay" }, mismatchTicket: { subject: "Refund request" } },
  { id: "subject.equals", field: "subject", operator: "equals", conditionValue: "Refund requested",
    matchTicket: { subject: "Refund requested" }, mismatchTicket: { subject: "Shipping delay" } },
  { id: "subject.not_equals", field: "subject", operator: "not_equals", conditionValue: "Refund requested",
    matchTicket: { subject: "Shipping delay" }, mismatchTicket: { subject: "Refund requested" } },
  { id: "subject.regex", field: "subject", operator: "regex", conditionValue: "^Ref",
    matchTicket: { subject: "Refund request" }, mismatchTicket: { subject: "Gift request" } },
  { id: "subject.is_set", field: "subject", operator: "is_set",
    matchTicket: { subject: "Refund request" }, mismatchTicket: {} },
  { id: "subject.is_not_set", field: "subject", operator: "is_not_set",
    matchTicket: {}, mismatchTicket: { subject: "Refund request" } },

  // ── status (select → status definition name) ────────────────────────────
  { id: "status.equals", field: "status", operator: "equals", conditionValue: "Open",
    matchTicket: { status: "Open" }, mismatchTicket: { status: "Closed" } },
  { id: "status.not_equals", field: "status", operator: "not_equals", conditionValue: "Open",
    matchTicket: { status: "Closed" }, mismatchTicket: { status: "Open" } },
  { id: "status.is_set", field: "status", operator: "is_set",
    matchTicket: { status: "Open" }, mismatchTicket: {} },
  { id: "status.is_not_set", field: "status", operator: "is_not_set",
    matchTicket: {}, mismatchTicket: { status: "Open" } },

  // ── priority (select; synthetic string compare in dry-run) ──────────────
  { id: "priority.equals", field: "priority", operator: "equals", conditionValue: "high",
    matchTicket: { priority: "high" }, mismatchTicket: { priority: "low" } },
  { id: "priority.not_equals", field: "priority", operator: "not_equals", conditionValue: "high",
    matchTicket: { priority: "low" }, mismatchTicket: { priority: "high" } },
  { id: "priority.is_set", field: "priority", operator: "is_set",
    matchTicket: { priority: "high" }, mismatchTicket: {} },
  { id: "priority.is_not_set", field: "priority", operator: "is_not_set",
    matchTicket: {}, mismatchTicket: { priority: "high" } },

  // ── is_urgent (boolean) ─────────────────────────────────────────────────
  { id: "is_urgent.equals_true", field: "is_urgent", operator: "equals", conditionValue: true,
    matchTicket: { is_urgent: true }, mismatchTicket: { is_urgent: false } },
  { id: "is_urgent.not_equals_true", field: "is_urgent", operator: "not_equals", conditionValue: true,
    matchTicket: { is_urgent: false }, mismatchTicket: { is_urgent: true } },
  { id: "is_urgent.is_set", field: "is_urgent", operator: "is_set",
    matchTicket: { is_urgent: true }, mismatchTicket: {} },
  { id: "is_urgent.is_not_set", field: "is_urgent", operator: "is_not_set",
    matchTicket: {}, mismatchTicket: { is_urgent: true } },
];

/** Build the flat condition payload for a single-condition case. */
export function conditionOf(c: WebchatFilterCase): Record<string, unknown> {
  const cond: Record<string, unknown> = { field: c.field, operator: c.operator };
  if (c.conditionValue !== undefined) cond.value = c.conditionValue;
  return cond;
}
export interface WebchatCombinationCase {
  id: string;
  /** flat condition array (implicit AND) OR nested groups payload (AND/OR) */
  conditions: unknown;
  /** doc-only: logic a flat array expresses (backend: flat ⇒ always AND) */
  logic?: "AND" | "OR";
  testTicket: Record<string, unknown>;
  expected: boolean;
  description: string;
}

const ALL_MATCH: Record<string, unknown> = {
  app_id: "app_alpha",
  platform_id: "plat_one",
  language: "english",
  tags: ["vip", "billing"],
  subject: "vip customer refund request",
};

/** Multi-field combination cases (app × platform × language × tags × subject). */
export const WEBCHAT_COMBINATION_CASES: WebchatCombinationCase[] = [
  { id: "combo.flat_and.all_match", logic: "AND",
    conditions: [
      { field: "app", operator: "equals", value: "app_alpha" },
      { field: "platform", operator: "has_one_of", value: ["plat_one", "plat_two"] },
      { field: "language", operator: "equals", value: "english" },
    ],
    testTicket: { ...ALL_MATCH }, expected: true,
    description: "app is + platform is one of + language is — all satisfied" },
  { id: "combo.flat_and.platform_miss", logic: "AND",
    conditions: [
      { field: "app", operator: "equals", value: "app_alpha" },
      { field: "platform", operator: "has_one_of", value: ["plat_one", "plat_two"] },
      { field: "language", operator: "equals", value: "english" },
    ],
    testTicket: { ...ALL_MATCH, platform_id: "plat_three" }, expected: false,
    description: "AND combo where only platform is-one-of fails" },
  { id: "combo.flat_and.language_miss", logic: "AND",
    conditions: [
      { field: "app", operator: "equals", value: "app_alpha" },
      { field: "platform", operator: "has_one_of", value: ["plat_one"] },
      { field: "language", operator: "equals", value: "english" },
    ],
    testTicket: { ...ALL_MATCH, language: "german" }, expected: false,
    description: "AND combo where only language is fails" },
  { id: "combo.flat_and.app_miss", logic: "AND",
    conditions: [
      { field: "app", operator: "equals", value: "app_alpha" },
      { field: "language", operator: "equals", value: "english" },
    ],
    testTicket: { ...ALL_MATCH, app_id: "app_beta" }, expected: false,
    description: "AND combo where only app is fails" },
  // NOTE: flat arrays are implicit AND in the backend (evaluateConditions).
  // OR semantics are only expressible via the groups payload — see below.
  { id: "combo.groups.or_flat_one_matches",
    conditions: {
      operator: "OR",
      groups: [
        { operator: "OR", conditions: [
          { field: "app", operator: "equals", value: "app_alpha" },
          { field: "platform", operator: "has_one_of", value: ["plat_one"] },
        ] },
      ],
    },
    testTicket: { ...ALL_MATCH, app_id: "app_beta" }, expected: true,
    description: "OR conditions (groups form): app misses but platform matches" },
  { id: "combo.groups.or_flat_none_match",
    conditions: {
      operator: "OR",
      groups: [
        { operator: "OR", conditions: [
          { field: "app", operator: "equals", value: "app_alpha" },
          { field: "platform", operator: "has_one_of", value: ["plat_nine"] },
        ] },
      ],
    },
    testTicket: { ...ALL_MATCH, app_id: "app_beta" }, expected: false,
    description: "OR conditions (groups form): neither app nor platform matches" },
  { id: "combo.groups.and_or_hit",
    conditions: {
      operator: "AND",
      groups: [
        { operator: "AND", conditions: [
          { field: "app", operator: "equals", value: "app_alpha" },
          { field: "language", operator: "equals", value: "english" },
        ] },
        { operator: "OR", conditions: [
          { field: "subject", operator: "contains", value: "vip" },
          { field: "subject", operator: "contains", value: "gold" },
        ] },
      ],
    },
    testTicket: { ...ALL_MATCH }, expected: true,
    description: "nested groups: AND(app, language) + OR(subject vip/gold) all true" },
  { id: "combo.groups.or_root_hit",
    conditions: {
      operator: "OR",
      groups: [
        { operator: "AND", conditions: [
          { field: "app", operator: "equals", value: "app_alpha" },
          { field: "language", operator: "equals", value: "german" },
        ] },
        { operator: "AND", conditions: [
          { field: "tags", operator: "has_one_of", value: ["vip"] },
          { field: "subject", operator: "contains", value: "refund" },
        ] },
      ],
    },
    testTicket: { ...ALL_MATCH }, expected: true,
    description: "root OR: first group fails, second group (tags+subject) succeeds" },
  { id: "combo.groups.and_root_miss",
    conditions: {
      operator: "AND",
      groups: [
        { operator: "AND", conditions: [
          { field: "app", operator: "equals", value: "app_alpha" },
        ] },
        { operator: "AND", conditions: [
          { field: "language", operator: "equals", value: "german" },
          { field: "subject", operator: "contains", value: "gold" },
        ] },
      ],
    },
    testTicket: { ...ALL_MATCH }, expected: false,
    description: "root AND: second group fails entirely" },
];


