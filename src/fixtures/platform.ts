import type { RunContext } from "../orchestrator/context.js";

/**
 * Resolve the tenant's webchat platform + app ids (cached per run in ctx.state).
 *
 * The ticket create API validates both ids (apps + domain_app_platforms), but
 * the GET /api/platforms endpoints return only {type, name} — no ids — so they
 * cannot be discovered via API and are configured per environment instead:
 *   QA_WEBCHAT_PLATFORM_ID, QA_WEBCHAT_APP_ID
 */
export async function resolveWebchatPlatformId(ctx: RunContext): Promise<string> {
  return (await resolveWebchatIds(ctx)).platformId;
}

export async function resolveWebchatAppId(ctx: RunContext): Promise<string> {
  return (await resolveWebchatIds(ctx)).appId;
}

export async function resolveWebchatIds(ctx: RunContext): Promise<{
  platformId: string;
  appId: string;
}> {
  const cachedPlatform = ctx.getState<string>("platform.webchatId");
  const cachedApp = ctx.getState<string>("platform.webchatAppId");
  if (cachedPlatform && cachedApp) return { platformId: cachedPlatform, appId: cachedApp };

  // Preferred: per-environment config (see .env.example).
  const fromEnvPlatform = process.env.QA_WEBCHAT_PLATFORM_ID;
  const fromEnvApp = process.env.QA_WEBCHAT_APP_ID;
  if (fromEnvPlatform && fromEnvApp) {
    ctx.setState("platform.webchatId", fromEnvPlatform);
    ctx.setState("platform.webchatAppId", fromEnvApp);
    return { platformId: fromEnvPlatform, appId: fromEnvApp };
  }

  await ctx.session.loginAs("admin");
  const app = ctx.api("APP");
  let res = await app.get("/api/platforms");
  if (res.status >= 400) res = await app.get("/api/apps/platforms");
  if (res.status >= 400) {
    throw new Error(
      `platform list failed (${res.status}): ${JSON.stringify(res.data).slice(0, 200)}`
    );
  }

  const payload = res.data as { data?: unknown; platforms?: unknown };
  const list: unknown[] = Array.isArray(res.data)
    ? (res.data as unknown[])
    : Array.isArray(payload?.platforms)
      ? (payload.platforms as unknown[])
      : Array.isArray(payload?.data)
        ? (payload.data as unknown[])
        : [];

  const match = list.find((p) => JSON.stringify(p).includes('"webchat"'));
  const id = match
    ? ((match as { id?: string }).id ?? (match as { platform_id?: string }).platform_id)
    : undefined;
  if (!id || !fromEnvApp) {
    throw new Error(
      "no webchat platform found — set QA_WEBCHAT_PLATFORM_ID + QA_WEBCHAT_APP_ID for this environment"
    );
  }

  ctx.setState("platform.webchatId", id);
  ctx.setState("platform.webchatAppId", fromEnvApp);
  return { platformId: id, appId: fromEnvApp };
}
