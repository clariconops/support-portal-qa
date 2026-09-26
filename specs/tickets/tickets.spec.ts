import { defineFeature } from "../../src/orchestrator/suite.js";
import { ApiClient } from "../../src/api/http.js";
import { assert } from "../../src/orchestrator/context.js";
import { resolveWebchatIds } from "../../src/fixtures/platform.js";

/**
 * API behaviours for the `tickets` feature. Uses the shared authenticated API
 * client (tickets inherit the session created by the `auth` dependency).
 */
const suite = defineFeature("tickets", (s) => {
  // "lists tickets with pagination"
  s.behaviour("tickets.list.loads", async (ctx) => {
    await ctx.session.loginAs("admin");
    const api = ctx.api("TICKET");
    const res = await api.get("/api/tickets", { params: { page: 1, limit: 10 } });
    assert(res.status < 500, `ticket list returned ${res.status}`);
    const data = ApiClient.unwrap<unknown>(res);
    assert(data !== undefined, "expected a ticket list payload");
  });

  // "creates a ticket"
  s.behaviour("tickets.create", async (ctx) => {
    await ctx.session.loginAs("admin");
    const { platformId, appId } = await resolveWebchatIds(ctx);
    const api = ctx.api("TICKET");
    const subject = `e2e-ticket-${Date.now()}`;
    const create = await api.post("/api/tickets", {
      subject,
      description: "created by qa-framework",
      channel: "api",
      platform_id: platformId,
      app_id: appId,
    });
    assert(create.status < 400, `create failed with ${create.status}`);
    const created = ApiClient.unwrap<{ id: string }>(create);
    assert(created?.id, "expected created ticket id");
    ctx.trackResource({ kind: "ticket", service: "TICKET", id: created.id });

    const get = await api.get(`/api/tickets/${created.id}`);
    assert(get.status === 200, `expected to fetch created ticket, got ${get.status}`);
    ctx.addArtifact(`artifacts/tickets/tickets.create/${created.id}.json`);
  });

  // "adds a public reply"
  s.behaviour("tickets.reply.public", async (ctx) => {
    await ctx.session.loginAs("admin");
    const { platformId: replyPlatformId, appId: replyAppId } = await resolveWebchatIds(ctx);
    const api = ctx.api("TICKET");
    const create = await api.post("/api/tickets", {
      subject: `e2e-reply-${Date.now()}`,
      description: "reply flow",
      channel: "api",
      platform_id: replyPlatformId,
      app_id: replyAppId,
    });
    const created = ApiClient.unwrap<{ id: string }>(create);
    assert(created?.id, "expected created ticket id");
    ctx.trackResource({ kind: "ticket", service: "TICKET", id: created.id });

    const reply = await api.post(`/api/tickets/${created.id}/messages`, {
      content: "public reply from qa-framework",
      isPublic: true,
      isInternal: false,
    });
    assert(reply.status < 400, `reply failed with ${reply.status}`);

    const detail = ApiClient.unwrap<{ messages?: unknown[] }>(
      await api.get(`/api/tickets/${created.id}/messages`)
    );
    assert(
      Array.isArray(detail.messages) && detail.messages.length >= 1,
      "expected the public reply to be persisted on the ticket"
    );
  });

  // "changes ticket status"
  s.behaviour("tickets.status.change", async (ctx) => {
    await ctx.session.loginAs("admin");
    const { platformId: statusPlatformId, appId: statusAppId } = await resolveWebchatIds(ctx);
    const api = ctx.api("TICKET");
    const created = ApiClient.unwrap<{ id: string }>(
      await api.post("/api/tickets", {
        subject: `e2e-status-${Date.now()}`,
        description: "status flow",
        channel: "api",
        platform_id: statusPlatformId,
        app_id: statusAppId,
      })
    );
    assert(created?.id, "expected created ticket id");
    ctx.trackResource({ kind: "ticket", service: "TICKET", id: created.id });

    const update = await api.put(`/api/tickets/${created.id}`, { status: "open" });
    assert(update.status < 400, `status change failed with ${update.status}`);

    await ctx.waitFor(
      async () => {
        const detail = ApiClient.unwrap<{ status?: string }>(
          await api.get(`/api/tickets/${created.id}`)
        );
        return detail.status === "open";
      },
      { label: "ticket status persisted", timeoutMs: 10_000 }
    );
  });
});

export default suite;
