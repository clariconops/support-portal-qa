import { ApiClient, serviceClient } from "../../src/api/http.js";
import { SessionClient } from "../../src/api/sessionClient.js";
import { assert } from "../../src/orchestrator/context.js";
import { defineFeature } from "../../src/orchestrator/suite.js";
import { resolveWebchatIds } from "../../src/fixtures/platform.js";

const password = "QaRoutingPassword123!";
const domainId = () => {
  const value = process.env.QA_WEBCHAT_DOMAIN_ID;
  if (!value) throw new Error("QA_WEBCHAT_DOMAIN_ID is required for routing tests");
  return value;
};

const suite = defineFeature("auto-assignment", (s) => {
  s.behaviour("auto-assignment.round_robin.available_members", async (ctx) => {
    await ctx.session.loginAs("admin");
    const admin = ctx.api("TENANT");
    const queueApi = ctx.api("QUEUE");
    const routing = ctx.api("ROUTING");
    const tickets = ctx.api("TICKET");
    const suffix = Date.now();
    const agents: Array<{ id: string; email: string; displayName: string }> = [];
    const ticketIds: string[] = [];
    let queueId: string | undefined;

    try {
      for (let index = 1; index <= 3; index += 1) {
        const email = `qa-routing-${suffix}-${index}@e2e.test`;
        const created = ApiClient.unwrap<{ id: string }>(await admin.post("/api/team/members", {
          email, username: `qa-routing-${suffix}-${index}`, firstName: "QA", lastName: `Agent ${index}`,
          displayName: `QA Routing Agent ${index}`, role: "agent", password,
        }));
        agents.push({ id: created.id, email, displayName: `QA Routing Agent ${index}` });
      }

      for (const agent of agents) {
        const session = new SessionClient(ctx.env);
        await session.login(agent.email, password);
        const agentRouting = serviceClient(ctx.env, "ROUTING", () => session.getToken());
        const status = await agentRouting.post("/api/routing/agent/login", { status: "available" });
        assert(status.status < 300, `agent ${agent.email} could not become available (${status.status})`);
      }

      const queue = ApiClient.unwrap<{ id?: string; queue_id?: string }>(await queueApi.post("/api/queues", {
        domain_id: domainId(), name: `qa-round-robin-${suffix}`, description: "isolated routing regression", settings: {}, metadata: { managed_by: "qa-framework" },
      }));
      queueId = queue.queue_id ?? queue.id;
      assert(queueId, "queue creation returned no identifier");
      ctx.trackResource({ kind: "queue", service: "QUEUE", id: queueId });
      const membership = await queueApi.put(`/api/queues/${queueId}/members`, {
        member_ids: agents.map((agent) => agent.id), group_ids: [], team_ids: [], assignment_scope: "available_members", routing_algorithm: "round_robin",
      }, { params: { domain_id: domainId() } });
      assert(membership.status < 300, `queue membership setup failed (${membership.status})`);

      const available = ApiClient.unwrap<{ agents: Array<{ agent_id?: string; id?: string; is_available?: boolean }> }>(await routing.get("/api/routing/available-agents", { params: { queue_id: queueId } }));
      for (const agent of agents) assert(available.agents.some((row) => (row.agent_id ?? row.id) === agent.id && row.is_available), `${agent.email} was not eligible`);

      const { platformId, appId } = await resolveWebchatIds(ctx);
      const assignedIds: string[] = [];
      for (let index = 0; index < 6; index += 1) {
        const created = ApiClient.unwrap<{ id: string }>(await tickets.post("/api/tickets", { subject: `qa-round-robin-${suffix}-${index}`, description: "routing regression", channel: "api", platform_id: platformId, app_id: appId }));
        ticketIds.push(created.id);
        ctx.trackResource({ kind: "ticket", service: "TICKET", id: created.id });
        const assigned = await routing.post("/api/routing/reassign-ticket", { ticket_id: created.id, assignment_type: "assign_to_queue", assignment_target: { queue_id: queueId }, reason: "QA round-robin regression" });
        assert(assigned.status < 300, `queue assignment failed (${assigned.status})`);
        const assignee = await ctx.waitFor(async () => {
          const ticket = ApiClient.unwrap<{ assignee_id?: string }>(await tickets.get(`/api/tickets/${created.id}`));
          return ticket.assignee_id || false;
        }, { label: `round-robin assignment for ${created.id}`, timeoutMs: 20_000 });
        assignedIds.push(assignee);
      }
      assert(assignedIds.every((id, index) => id === agents[index % agents.length].id), `expected round-robin ${agents.map((a) => a.id).join(",")}, got ${assignedIds.join(",")}`);
    } finally {
      for (const agent of agents) await admin.delete(`/api/team/members/${agent.id}`).catch(() => undefined);
    }
  });
});

export default suite;
