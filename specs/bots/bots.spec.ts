import { ApiClient } from "../../src/api/http.js";
import { assert } from "../../src/orchestrator/context.js";
import { defineFeature } from "../../src/orchestrator/suite.js";

const suite = defineFeature("bots", (s) => {
  s.behaviour("bots.list.loads", async (ctx) => {
    await ctx.session.loginAs("admin");
    const response = await ctx.api("BOT").get("/api/bots");
    assert(response.status === 200, `bot list returned ${response.status}`);
    assert(Array.isArray(ApiClient.unwrap(response)), "expected a bot collection");
  });

  s.behaviour("bots.create.retrieve.delete", async (ctx) => {
    await ctx.session.loginAs("admin");
    const api = ctx.api("BOT");
    const response = await api.post("/api/bots", { name: `qa-bot-${Date.now()}`, description: "isolated QA bot" });
    assert(response.status === 201, `bot creation returned ${response.status}`);
    const bot = ApiClient.unwrap<{ bot_id?: string; id?: string }>(response);
    const id = bot.bot_id ?? bot.id;
    assert(id, "bot creation returned no identifier");
    ctx.trackResource({ kind: "bot", service: "BOT", id });
    const read = await api.get(`/api/bots/${id}`);
    assert(read.status === 200, `created bot was not retrievable (${read.status})`);
  });
});

export default suite;
