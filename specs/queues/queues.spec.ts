import { ApiClient } from "../../src/api/http.js";
import { assert } from "../../src/orchestrator/context.js";
import { defineFeature } from "../../src/orchestrator/suite.js";

function domainId(): string {
  const value = process.env.QA_WEBCHAT_DOMAIN_ID;
  if (!value) throw new Error("QA_WEBCHAT_DOMAIN_ID is required for queue tests");
  return value;
}

const suite = defineFeature("queues", (s) => {
  s.behaviour("queues.list.loads", async (ctx) => {
    await ctx.session.loginAs("admin");
    const response = await ctx.api("QUEUE").get("/api/queues", { params: { domain_id: domainId(), page: 1, limit: 25 } });
    assert(response.status === 200, `queue list returned ${response.status}`);
    assert(ApiClient.unwrap(response) !== undefined, "expected a queue list payload");
  });

  s.behaviour("queues.create.retrieve.delete", async (ctx) => {
    await ctx.session.loginAs("admin");
    const api = ctx.api("QUEUE");
    const response = await api.post("/api/queues", {
      domain_id: domainId(), name: `qa-queue-${Date.now()}`, description: "isolated QA queue", settings: {}, metadata: { managed_by: "qa-framework" },
    });
    assert(response.status === 201, `queue creation returned ${response.status}`);
    const queue = ApiClient.unwrap<{ id?: string; queue_id?: string }>(response);
    const id = queue.queue_id ?? queue.id;
    assert(id, "queue creation returned no identifier");
    ctx.trackResource({ kind: "queue", service: "QUEUE", id });
    const read = await api.get(`/api/queues/${id}`, { params: { domain_id: domainId() } });
    assert(read.status === 200, `created queue was not retrievable (${read.status})`);
  });
});

export default suite;
