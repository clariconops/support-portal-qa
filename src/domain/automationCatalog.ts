/**
 * Automation engine catalog, extracted from the product source:
 *  - Operators per field type: frontends/admin-dashboard .../AutomationRuleBuilder/constants.ts (OPERATOR_DEFINITIONS)
 *  - Backend semantics: services/automation-service .../automationService.ts `evaluateCondition`
 *  - Action types: SUPPORTED_ACTION_TYPES (13)
 *  - Trigger types: automationRoutes.ts validation (33)
 *
 * `backendVerified` = the operator was seen implemented in the backend
 * evaluateCondition switch. Non-verified operators run in "probe" mode: the
 * matrix asserts a boolean verdict is returned (and records the actual value)
 * instead of pinning pass/fail — so configuring an operator the backend does
 * not implement is surfaced as data, not noise.
 */

export type FieldType = "text" | "select" | "multiselect" | "number" | "date" | "boolean";

/** One representative ticket field per type (real keys from FIELD_DEFINITIONS). */
export const FIELD_KEYS: Record<FieldType, string> = {
  text: "subject",
  select: "priority",
  multiselect: "tags",
  number: "response_time",
  date: "created_at",
  boolean: "is_urgent",
};

export type ValueClass = "match" | "no_match" | "null_value" | "boundary" | "case_variant";

export interface OperatorSpec {
  operator: string;
  fieldTypes: FieldType[];
  /** Operator takes no value (is_set, is_today, ...). */
  valueless?: boolean;
  /** Implemented in automationService.evaluateCondition (verified by source read). */
  backendVerified?: boolean;
}

export const OPERATORS: OperatorSpec[] = [
  { operator: "equals", fieldTypes: ["text", "select", "number", "date", "boolean"], backendVerified: true },
  { operator: "not_equals", fieldTypes: ["text", "select", "number", "date", "boolean"], backendVerified: true },
  { operator: "is_set", fieldTypes: ["text", "select", "multiselect", "number", "date", "boolean"], valueless: true, backendVerified: true },
  { operator: "is_not_set", fieldTypes: ["text", "select", "multiselect", "number", "date", "boolean"], valueless: true, backendVerified: true },
  { operator: "contains", fieldTypes: ["text"], backendVerified: true },
  { operator: "not_contains", fieldTypes: ["text"], backendVerified: true },
  { operator: "starts_with", fieldTypes: ["text"], backendVerified: true },
  { operator: "ends_with", fieldTypes: ["text"], backendVerified: true },
  { operator: "regex", fieldTypes: ["text"], backendVerified: true },
  { operator: "has_one_of", fieldTypes: ["multiselect"] },
  { operator: "has_none_of", fieldTypes: ["multiselect"] },
  { operator: "has_all_of", fieldTypes: ["multiselect"] },
  { operator: "greater_than", fieldTypes: ["number", "date"], backendVerified: true },
  { operator: "less_than", fieldTypes: ["number", "date"], backendVerified: true },
  { operator: "greater_than_or_equal", fieldTypes: ["number", "date"] },
  { operator: "less_than_or_equal", fieldTypes: ["number", "date"] },
  { operator: "between", fieldTypes: ["number", "date"] },
  { operator: "is_within_last", fieldTypes: ["date"], backendVerified: true },
  { operator: "is_today", fieldTypes: ["date"], valueless: true },
  { operator: "is_yesterday", fieldTypes: ["date"], valueless: true },
  { operator: "is_this_week", fieldTypes: ["date"], valueless: true },
  { operator: "is_this_month", fieldTypes: ["date"], valueless: true },
  { operator: "is_true", fieldTypes: ["boolean"], valueless: true },
  { operator: "is_false", fieldTypes: ["boolean"], valueless: true },
];

/** The 13 action types (SUPPORTED_ACTION_TYPES). */
export const ACTION_TYPES = [
  "assign_to_agent",
  "assign_to_queue",
  "assign_to_bot",
  "assign_to_ai_agent",
  "add_tags",
  "remove_tags",
  "update_custom_fields",
  "send_reply",
  "change_status",
  "escalate_priority",
  "add_note",
  "send_csat_survey",
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

/** Minimal, structurally-valid target per action type (dry_run only validates shape). */
export const ACTION_TARGETS: Record<ActionType, Record<string, unknown>> = {
  assign_to_agent: { agent_id: "qa-agent-id" },
  assign_to_queue: { queue_id: "qa-queue-id" },
  assign_to_bot: { bot_id: "qa-bot-id" },
  assign_to_ai_agent: {},
  add_tags: { tags: ["qa-matrix-tag"] },
  remove_tags: { tags: ["qa-matrix-tag"] },
  update_custom_fields: { fields: { qa_matrix_field: "qa" } },
  send_reply: { body: "qa matrix reply" },
  change_status: { status: "open" },
  escalate_priority: { to: "urgent" },
  add_note: { content: "qa matrix note" },
  send_csat_survey: {},
};

/** Representative event triggers for the pairwise layer. */
export const REPRESENTATIVE_TRIGGERS = [
  "ticket_created",
  "agent_message_sent",
  "user_message_sent",
  "ticket_status_changed",
  "tag_added",
  "custom_field_changed",
  "first_response_sla_breach",
  "low_priority_aging",
  "time_based",
] as const;

export type LogicShape = "flat_and" | "groups_and" | "groups_or";
export const LOGIC_SHAPES: LogicShape[] = ["flat_and", "groups_and", "groups_or"];

export interface ConditionCase {
  id: string;
  field: string;
  fieldType: FieldType;
  operator: string;
  valueClass: ValueClass;
  /** Value configured on the condition (undefined for valueless operators). */
  conditionValue?: unknown;
  /** `case_sensitive` flag on the condition. */
  caseSensitive?: boolean;
  /** Value present on the test ticket for the same field. */
  ticketValue?: unknown;
  /** Deterministic expectation, or "probe" (assert a boolean verdict exists). */
  expected: boolean | "probe";
}

function iso(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString();
}

/** All applicable (operator, fieldType) pairs from the catalog. */
export function operatorFieldPairs(): Array<{ operator: string; fieldType: FieldType }> {
  const pairs: Array<{ operator: string; fieldType: FieldType }> = [];
  for (const op of OPERATORS) {
    for (const ft of op.fieldTypes) pairs.push({ operator: op.operator, fieldType: ft });
  }
  return pairs;
}

/** Value classes that make sense for a given operator spec. */
export function valueClassesFor(op: OperatorSpec): ValueClass[] {
  if (op.valueless) {
    if (op.operator === "is_set" || op.operator === "is_not_set") return ["match", "null_value"];
    return ["match"];
  }
  const primary = op.fieldTypes[0];
  if (primary === "text") return ["match", "no_match", "null_value", "boundary", "case_variant"];
  if (primary === "select" || primary === "multiselect") return ["match", "no_match", "null_value"];
  return ["match", "no_match", "null_value", "boundary"];
}

/**
 * Build one concrete (condition + test ticket + expectation) case for a given
 * operator/field/value-class. Pure: used by the generator and at runtime.
 */
export function buildConditionCase(
  operator: string,
  fieldType: FieldType,
  valueClass: ValueClass
): ConditionCase {
  const field = FIELD_KEYS[fieldType];
  const id = `automation.matrix.${operator}.${fieldType}.${valueClass}`;
  const spec = OPERATORS.find((o) => o.operator === operator);
  if (!spec || !spec.fieldTypes.includes(fieldType)) {
    throw new Error(`operator "${operator}" is not applicable to field type "${fieldType}"`);
  }

  const c: ConditionCase = { id, field, fieldType, operator, valueClass, expected: "probe" };

  if (spec.valueless) {
    if (operator === "is_set" || operator === "is_not_set") {
      if (valueClass === "null_value") {
        c.ticketValue = undefined;
        c.expected = operator === "is_set" ? false : true;
      } else {
        c.ticketValue = samplePresent(fieldType);
        c.expected = operator === "is_set" ? true : false;
      }
    } else if (operator === "is_true" || operator === "is_false") {
      c.ticketValue = operator === "is_true";
      c.expected = true;
    } else {
      c.ticketValue = iso(0); // relative date ops run in probe mode
    }
    return c;
  }

  const missText = "Password reset instructions";
  const base = "Refund";

  switch (fieldType) {
    case "text": {
      if (valueClass === "case_variant") {
        c.conditionValue = "REFUND";
        c.caseSensitive = true;
        c.ticketValue = "Refund requested for order 123";
        c.expected = false;
        break;
      }
      switch (operator) {
        case "equals":
        case "not_equals": {
          if (valueClass === "boundary") {
            c.conditionValue = ` ${base} `;
            c.ticketValue = base;
            c.expected = operator === "equals" ? false : true;
          } else {
            c.conditionValue = base;
            c.ticketValue = valueClass === "match" ? base : missText;
            c.expected = operator === "equals"
              ? valueClass === "match"
              : valueClass === "no_match" || valueClass === "null_value";
          }
          break;
        }
        case "contains":
        case "not_contains": {
          c.conditionValue = base;
          c.ticketValue = valueClass === "boundary"
            ? `${base} at the very start`
            : valueClass === "match"
              ? `Order 123: ${base} requested`
              : missText;
          c.expected = operator === "contains"
            ? valueClass === "match" || valueClass === "boundary"
            : !(valueClass === "match" || valueClass === "boundary");
          break;
        }
        case "starts_with":
        case "ends_with": {
          const anchor = operator === "starts_with" ? `${base} order` : `order ${base}`;
          c.conditionValue = base;
          c.ticketValue = valueClass === "match" || valueClass === "boundary" ? anchor : missText;
          c.expected = valueClass === "null_value"
            ? false
            : valueClass === "match" || valueClass === "boundary";
          break;
        }
        case "regex": {
          c.conditionValue = `^${base}`;
          c.ticketValue = valueClass === "match" || valueClass === "boundary"
            ? `${base} requested`
            : missText;
          c.expected = valueClass === "null_value"
            ? false
            : valueClass === "match" || valueClass === "boundary";
          break;
        }
      }
      break;
    }
    case "select": {
      c.conditionValue = valueClass === "no_match" ? "urgent" : "high";
      c.ticketValue = valueClass === "match" || valueClass === "boundary"
        ? "high"
        : valueClass === "no_match" ? "low" : undefined;
      c.expected = operator === "equals"
        ? valueClass === "match" || valueClass === "boundary"
        : valueClass === "no_match" || valueClass === "null_value";
      break;
    }
    case "multiselect": {
      c.conditionValue = valueClass === "boundary" ? ["vip", "billing"] : ["vip"];
      c.ticketValue = valueClass === "match" || valueClass === "boundary"
        ? ["vip", "billing", "priority-support"]
        : valueClass === "no_match" ? ["general"] : undefined;
      c.expected = operator === "has_one_of" || operator === "has_all_of"
        ? valueClass === "match" || valueClass === "boundary"
        : !(valueClass === "match" || valueClass === "boundary");
      break;
    }
    case "number": {
      c.conditionValue = operator === "between"
        ? [10, 50]
        : valueClass === "boundary" ? 30 : valueClass === "no_match" ? 999 : 25;
      c.ticketValue = valueClass === "null_value" ? undefined : 30;
      if (valueClass === "null_value") c.expected = false;
      else if (operator === "equals") c.expected = valueClass !== "no_match";
      else if (operator === "not_equals") c.expected = valueClass === "no_match";
      else if (operator === "greater_than") c.expected = valueClass === "no_match";
      else if (operator === "less_than") c.expected = valueClass === "no_match";
      else if (operator === "greater_than_or_equal" || operator === "less_than_or_equal")
        c.expected = valueClass === "match" || valueClass === "boundary";
      else c.expected = "probe";
      break;
    }
    case "date": {
      if (operator === "is_within_last") {
        c.conditionValue = valueClass === "no_match" ? "1 hours" : "7 days";
        c.ticketValue = valueClass === "null_value" ? undefined : iso(0);
        c.expected = valueClass === "no_match" || valueClass === "null_value" ? false : true;
        break;
      }
      c.conditionValue = operator === "between"
        ? [iso(10), iso(1)]
        : valueClass === "boundary" ? iso(5) : iso(30);
      c.ticketValue = valueClass === "null_value" ? undefined : iso(5);
      if (valueClass === "null_value") c.expected = false;
      else if (operator === "equals") c.expected = valueClass === "boundary" || valueClass === "match";
      else if (operator === "not_equals") c.expected = !(valueClass === "boundary" || valueClass === "match");
      else if (operator === "greater_than") c.expected = valueClass === "match";
      else if (operator === "less_than") c.expected = valueClass === "boundary";
      else if (operator === "greater_than_or_equal" || operator === "less_than_or_equal")
        c.expected = valueClass === "match" || valueClass === "boundary";
      else c.expected = "probe";
      break;
    }
    case "boolean": {
      c.conditionValue = valueClass === "no_match" ? false : true;
      c.ticketValue = valueClass === "null_value" ? undefined : valueClass === "no_match" ? false : true;
      c.expected = operator === "equals"
        ? valueClass === "match" || valueClass === "boundary"
        : valueClass === "no_match" || valueClass === "null_value";
      break;
    }
  }
  return c;
}

function samplePresent(fieldType: FieldType): unknown {
  switch (fieldType) {
    case "text": return "Refund requested";
    case "select": return "high";
    case "multiselect": return ["vip"];
    case "number": return 30;
    case "date": return iso(0);
    case "boolean": return true;
  }
}

