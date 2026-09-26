/**
 * Reproduces the execution-order testRule call against the live stack and
 * prints the RAW response so the harness parsing can be validated.
 * Run from inside a node container:
 *   node scripts/probe-testrule.mjs
 */
const S = process.env.QA_SESSION_URL || "http://host.docker.internal:4015";
const A = process.env.QA_AUTOMATION_URL || "http://host.docker.internal:4010";
const email = process.env.QA_ADMIN_EMAIL || "admin@mycompany.com";
const password = process.env.QA_ADMIN_PASSWORD || "Admin123!";

const j = (r) => r.json();
const H = (token) => ({ "content-type": "application/json", authorization: `Bearer ${token}` });

const login = await fetch(`${S}/api/sessions/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password, deviceId: "qa-probe" }),
});
const loginBody = await j(login);
const token = loginBody?.data?.tokens?.accessToken ?? loginBody?.data?.accessToken ?? loginBody?.data?.token;
if (!token) {
  console.log("LOGIN FAILED:", login.status, JSON.stringify(loginBody).slice(0, 400));
  process.exit(1);
}
console.log("login ok");

const create = await fetch(`${A}/api/automation/rules`, {
  method: "POST",
  headers: H(token),
  body: JSON.stringify({
    name: `qa-order-probe-${Date.now()}`,
    description: "probe for testRule raw response",
    priority: 900 + Math.floor(Math.random() * 40),
    trigger: {
      trigger_type: "ticket_created",
      conditions: [{ field: "subject", operator: "is_set" }],
    },
    actions: [{ action_type: "add_note", action_target: { content: "qa probe" }, execution_order: 1 }],
  }),
});
const createBody = await j(create);
const ruleId = createBody?.data?.id ?? createBody?.data?.rule_id;
console.log("create rule:", create.status, "id:", ruleId, JSON.stringify(createBody).slice(0, 300));
if (!ruleId) process.exit(1);

const test = await fetch(`${A}/api/automation/rules/${ruleId}/test`, {
  method: "POST",
  headers: H(token),
  body: JSON.stringify({
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
  }),
});
console.log("testRule status:", test.status);
console.log(JSON.stringify(await j(test), null, 2));

const del = await fetch(`${A}/api/automation/rules/${ruleId}`, { method: "DELETE", headers: H(token) });
console.log("cleanup delete:", del.status);
