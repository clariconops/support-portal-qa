import { ApiClient, serviceClient } from "../../src/api/http.js";
import { SessionClient } from "../../src/api/sessionClient.js";
import { assert } from "../../src/orchestrator/context.js";
import { defineFeature } from "../../src/orchestrator/suite.js";
import { resolveWebchatIds } from "../../src/fixtures/platform.js";

const password = "QaRoutingPassword123!";

type Agent = { id: string; email: string; displayName: string; session: SessionClient };

function domainId(): string {
  const value = process.env.QA_WEBCHAT_DOMAIN_ID;
  if (!value) throw new Error("QA_WEBCHAT_DOMAIN_ID is required for routing tests");
  return value;
}

async function provisionQueue(ctx: any, algorithm: "load_balanced" | "skill_based", skills?: Array<{ applications: string[]; languages: string[]; technical: string[]; categories: string[] }>) {
  await ctx.session.loginAs("admin");
  const admin = ctx.api("TENANT");
  const queueApi = ctx.api("QUEUE");
  const routing = ctx.api("ROUTING");
  const suffix = Date.now();
  const agents: Agent[] = [];
  let queueId: string | undefined;

  try {
    for (let index = 1; index <= 3; index += 1) {
      const email = `qa-${algorithm}-${suffix}-${index}@e2e.test`;
      const created = ApiClient.unwrap<{ id: string }>(await admin.post("/api/team/members", {
        email, username: `qa-${algorithm}-${suffix}-${index}`, firstName: "QA", lastName: `Agent ${index}`,
        displayName: `QA ${algorithm} Agent ${index}`, role: "agent", password,
      }));
      const session = new SessionClient(ctx.env);
      await session.login(email, password);
      agents.push({ id: created.id, email, displayName: `QA ${algorithm} Agent ${index}`, session });
    }

    for (const [index, agent] of agents.entries()) {
      if (skills) {
        const tenant = serviceClient(ctx.env, "TENANT", () => agent.session.getToken());
        const result = await tenant.put("/api/auth/me/skills", skills[index]);
        assert(result.status < 300, `could not set skills for ${agent.email} (${result.status})`);
      }
      const agentRouting = serviceClient(ctx.env, "ROUTING", () => agent.session.getToken());
      const status = await agentRouting.post("/api/routing/agent/login", { status: "available" });
      assert(status.status < 300, `agent ${agent.email} could not become available (${status.status})`);
    }

    const queue = ApiClient.unwrap<{ id?: string; queue_id?: string }>(await queueApi.post("/api/queues", {
      domain_id: domainId(), name: `qa-${algorithm}-${suffix}`, description: "isolated routing regression", settings: {}, metadata: { managed_by: "qa-framework" },
    }));
    queueId = queue.queue_id ?? queue.id;
    assert(queueId, "queue creation returned no identifier");
    ctx.trackResource({ kind: "queue", service: "QUEUE", id: queueId });
    const membership = await queueApi.put(`/api/queues/${queueId}/members`, {
      member_ids: agents.map((agent) => agent.id), group_ids: [], team_ids: [], assignment_scope: "available_members", routing_algorithm: algorithm,
    }, { params: { domain_id: domainId() } });
    assert(membership.status < 300, `queue membership setup failed (${membership.status})`);
    return { agents, queueId, routing };
  } catch (error) {
    for (const agent of agents) await admin.delete(`/api/team/members/${agent.id}`).catch(() => undefined);
    throw error;
  }
}

async function assignTicket(ctx: any, routing: ApiClient, queueId: string, subject: string, tags?: string[]): Promise<string> {
  const tickets = ctx.api("TICKET");
  const { platformId, appId } = await resolveWebchatIds(ctx);
  const created = ApiClient.unwrap<{ id: string }>(await tickets.post("/api/tickets", {
    subject, description: "routing regression", channel: "api", platform_id: platformId, app_id: appId, tags,
  }));
  ctx.trackResource({ kind: "ticket", service: "TICKET", id: created.id });
  const assigned = await routing.post("/api/routing/reassign-ticket", {
    ticket_id: created.id, assignment_type: "assign_to_queue", assignment_target: { queue_id: queueId }, reason: "QA assignment algorithm regression",
  });
  assert(assigned.status < 300, `queue assignment failed (${assigned.status})`);
  return ctx.waitFor(async () => {
    const ticket = ApiClient.unwrap<{ assignee_id?: string }>(await tickets.get(`/api/tickets/${created.id}`));
    return ticket.assignee_id || false;
  }, { label: `assignment for ${created.id}`, timeoutMs: 20_000 });
}

const suite = defineFeature("auto-assignment", (s) => {
  s.behaviour("auto-assignment.load_balanced.least_loaded_agent", async (ctx) => {
    const { agents, queueId, routing } = await provisionQueue(ctx, "load_balanced");
    try {
      const assigned = [] as string[];
      for (let index = 0; index < 4; index += 1) assigned.push(await assignTicket(ctx, routing, queueId, `qa-load-balanced-${Date.now()}-${index}`));
      assert(assigned.every((id, index) => id === agents[index % agents.length].id), `expected least-load order ${agents.map((a) => a.id).join(",")}, got ${assigned.join(",")}`);
    } finally {
      const admin = ctx.api("TENANT");
      for (const agent of agents) await admin.delete(`/api/team/members/${agent.id}`).catch(() => undefined);
    }
  });

  s.behaviour("auto-assignment.skill_based.best_matching_agent", async (ctx) => {
    const { agents, queueId, routing } = await provisionQueue(ctx, "skill_based", [
      { applications: ["clash-royale"], languages: ["english"], technical: ["api"], categories: ["question"] },
      { applications: ["clash-royale"], languages: ["spanish"], technical: ["database"], categories: ["question"] },
      { applications: ["clash-royale"], languages: ["english"], technical: ["database"], categories: ["question"] },
    ]);
    let createdTagId: string | undefined;
    try {
      const tagApi = ctx.api("TICKET");
      const existing = ApiClient.unwrap<Array<{ tag_id: string; tag_name: string }>>(
        await tagApi.get("/api/tags", { params: { search: "database" } })
      );
      const databaseTag = existing.find((tag) => tag.tag_name === "database");
      if (!databaseTag) {
        const created = ApiClient.unwrap<{ tag_id: string }>(await tagApi.post("/api/tags", {
          tag_name: "database", tag_description: "QA routing technical skill", tag_color: "#2563EB",
        }));
        createdTagId = created.tag_id;
      }
      const assigned = await assignTicket(ctx, routing, queueId, `qa-skill-based-${Date.now()}`, ["database"]);
      assert(assigned === agents[2].id, `expected the English database-skilled agent ${agents[2].id}, got ${assigned}`);
    } finally {
      if (createdTagId) await ctx.api("TICKET").delete(`/api/tags/${createdTagId}`).catch(() => undefined);
      const admin = ctx.api("TENANT");
      for (const agent of agents) await admin.delete(`/api/team/members/${agent.id}`).catch(() => undefined);
    }
  });
});

export default suite;
