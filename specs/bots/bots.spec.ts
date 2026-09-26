import { ApiClient } from "../../src/api/http.js";
import { assert } from "../../src/orchestrator/context.js";
import { defineFeature } from "../../src/orchestrator/suite.js";
import { resolveWebchatIds } from "../../src/fixtures/platform.js";

type IdResponse = { id?: string; bot_id?: string; step_id?: string; execution_id?: string };

function idOf(value: IdResponse, label: string): string {
  const id = value.id ?? value.bot_id ?? value.step_id ?? value.execution_id;
  assert(id, `${label} returned no identifier`);
  return id;
}

function stepIdOf(value: IdResponse): string {
  assert(value.step_id, "step creation returned no step_id");
  return value.step_id;
}

function executionIdOf(value: IdResponse): string {
  assert(value.execution_id, "bot execution returned no execution_id");
  return value.execution_id;
}

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

  s.behaviour("bots.workflow.send_collect_end.real_ticket", async (ctx) => {
    await ctx.session.loginAs("admin");
    const botApi = ctx.api("BOT");
    const ticketApi = ctx.api("TICKET");
    const suffix = Date.now();
    const bot = ApiClient.unwrap<IdResponse>(await botApi.post("/api/bots", {
      name: `qa-workflow-${suffix}`, description: "real-ticket bot workflow QA",
    }));
    const botId = idOf(bot, "bot creation");
    ctx.trackResource({ kind: "bot", service: "BOT", id: botId });

    const addStep = async (step: Record<string, unknown>) => {
      const response = await botApi.post(`/api/bots/${botId}/steps`, step);
      assert(response.status === 201, `adding ${String(step.step_type)} failed (${response.status}): ${JSON.stringify(response.data)}`);
      return stepIdOf(ApiClient.unwrap<IdResponse>(response));
    };
    const welcomeStepId = await addStep({ step_type: "send_message", step_name: "welcome", step_order: 1,
      config: { message: `qa-workflow-welcome-${suffix}` } });
    const collectStepId = await addStep({ step_type: "get_information", step_name: "collect email", step_order: 2,
      config: { message: `qa-workflow-question-${suffix}`, data_type: "email", field_name: "qa_email", validation: { required: true } } });
    const endStepId = await addStep({ step_type: "end_conversation", step_name: "finish", step_order: 3,
      config: { message: `qa-workflow-goodbye-${suffix}`, actions: [] } });
    for (const [stepId, nextStepId] of [[welcomeStepId, collectStepId], [collectStepId, endStepId]]) {
      const linked = await botApi.put(`/api/bots/${botId}/steps/${stepId}`, { next_step_id: nextStepId });
      assert(linked.status < 400, `linking workflow steps failed (${linked.status}): ${JSON.stringify(linked.data)}`);
    }
    const published = await botApi.post(`/api/bots/${botId}/publish`);
    assert(published.status < 400, `publishing workflow bot failed (${published.status}): ${JSON.stringify(published.data)}`);

    const { platformId, appId } = await resolveWebchatIds(ctx);
    const ticket = ApiClient.unwrap<IdResponse>(await ticketApi.post("/api/tickets", {
      subject: `qa bot workflow ${suffix}`, description: "real ticket for bot execution", channel: "webchat", platform_id: platformId, app_id: appId,
    }));
    const ticketId = idOf(ticket, "ticket creation");
    ctx.trackResource({ kind: "ticket", service: "TICKET", id: ticketId });
    const execution = ApiClient.unwrap<IdResponse>(await botApi.post("/api/bots/execute", { bot_id: botId, ticket_id: ticketId }));
    const executionId = executionIdOf(execution);

    await ctx.waitFor(async () => {
      const active = ApiClient.unwrap<{ current_step_id?: string }>(await botApi.get(`/api/bots/executions/ticket/${ticketId}`));
      return active?.current_step_id === collectStepId;
    }, { label: "bot reaching information collection step", timeoutMs: 15_000 });
    const messages = ApiClient.unwrap<{ messages?: Array<{ content?: string }> }>(await ticketApi.get(`/api/tickets/${ticketId}/messages`));
    const contents = JSON.stringify(messages);
    assert(contents.includes(`qa-workflow-welcome-${suffix}`) && contents.includes(`qa-workflow-question-${suffix}`), "bot messages were not persisted to the real ticket");
    const response = await botApi.post(`/api/bots/executions/${executionId}/respond`, { execution_id: executionId, step_id: collectStepId, response_value: "qa@example.test", response_type: "email" });
    assert(response.status < 400, `bot response failed (${response.status}): ${JSON.stringify(response.data)}`);
    await ctx.waitFor(async () => {
      const active = ApiClient.unwrap<unknown>(await botApi.get(`/api/bots/executions/ticket/${ticketId}`));
      return active === null;
    }, { label: "bot workflow completion", timeoutMs: 15_000 });
  });
});

export default suite;
