import nodemailer from "nodemailer";
import type { FrameworkEnv } from "../config/env.js";
import type { RunSummary } from "./types.js";

export interface NotifyOptions {
  /** Force sending even when the verdict passed. */
  force?: boolean;
  /** Public URL of the published HTML report (optional). */
  reportUrl?: string;
}

/**
 * Send notifications for a run. By default only fires on failure unless
 * `env.report.notify === "always"` or `force` is set.
 */
export async function notify(
  env: FrameworkEnv,
  summary: RunSummary,
  options: NotifyOptions = {}
): Promise<void> {
  const shouldSend =
    options.force ||
    env.report.notify === "always" ||
    summary.verdict === "FAILED";

  if (!shouldSend) return;

  const tasks: Promise<void>[] = [];
  if (env.report.email.enabled) {
    tasks.push(sendEmail(env, summary, options).catch(logErr("email")));
  }
  if (env.report.slack?.webhook) {
    tasks.push(sendSlack(env, summary, options).catch(logErr("slack")));
  }
  await Promise.all(tasks);
}

function logErr(channel: string) {
  return (e: unknown) =>
    console.error(`[qa] ${channel} notification failed:`, (e as Error).message);
}

export function renderSubject(summary: RunSummary): string {
  return `[QA][${summary.env}] ${summary.verdict} — ${summary.totals.failed} failure(s) / ${summary.totals.behaviours} checks (run ${summary.runId})`;
}

export function renderText(summary: RunSummary, reportUrl?: string): string {
  const lines: string[] = [];
  lines.push(`QA run ${summary.runId}`);
  lines.push(`Env: ${summary.env}   Git: ${summary.gitSha}`);
  lines.push(`Verdict: ${summary.verdict} (blocking failures: ${summary.blockingFailures})`);
  lines.push("");
  lines.push("Feature-wise results:");
  for (const f of summary.byFeature) {
    lines.push(
      `  - ${f.id} [${f.severity}] ${f.status}  passed=${f.passed} failed=${f.failed} skipped=${f.skipped} owner=${f.owner}`
    );
    for (const b of f.failures) lines.push(`      x ${b}`);
  }
  if (reportUrl) {
    lines.push("");
    lines.push(`Report: ${reportUrl}`);
  }
  return lines.join("\n");
}

export function renderHtml(summary: RunSummary, reportUrl?: string): string {
  const LT = "\u003c";
  const GT = "\u003e";
  const rows = summary.byFeature
    .map((f) => {
      const color =
        f.status === "FAILED"
          ? "#b91c1c"
          : f.status === "PARTIAL"
            ? "#b45309"
            : "#15803d";
      const fails = f.failures.length
        ? f.failures.map((x) => `&bull; ${x}`).join(`${LT}br/${GT}`)
        : "—";
      return `${LT}tr${GT}${LT}td${GT}${f.id}${LT}/td${GT}${LT}td${GT}${f.severity}${LT}/td${GT}${LT}td${GT}${f.passed}${LT}/td${GT}${LT}td${GT}${f.failed}${LT}/td${GT}${LT}td style="color:${color};font-weight:600"${GT}${f.status}${LT}/td${GT}${LT}td${GT}${fails}${LT}/td${GT}${LT}tr${GT}`;
    })
    .join("");

  const link = reportUrl
    ? `${LT}p${GT}${LT}a href="${reportUrl}"${GT}Open full HTML report${LT}/a${GT}${LT}/p${GT}`
    : "";

  return `${LT}div${GT}
${LT}h2 style="margin:0 0 6px"${GT}QA ${summary.verdict} — ${summary.env}${LT}/h2${GT}
${LT}p style="color:#555;margin:0 0 12px"${GT}run ${summary.runId} · git ${summary.gitSha} · blocking failures ${summary.blockingFailures}${LT}/p${GT}
${LT}table cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse;font-family:system-ui,Arial"${GT}
${LT}thead${GT}${LT}tr${GT}${LT}th${GT}Feature${LT}/th${GT}${LT}th${GT}Sev${LT}/th${GT}${LT}th${GT}Pass${LT}/th${GT}${LT}th${GT}Fail${LT}/th${GT}${LT}th${GT}Status${LT}/th${GT}${LT}th${GT}Failures${LT}/th${GT}${LT}/tr${GT}${LT}/thead${GT}
${LT}tbody${GT}${rows}${LT}/tbody${GT}
${LT}/table${GT}
${link}
${LT}/div${GT}`;
}

async function sendEmail(
  env: FrameworkEnv,
  summary: RunSummary,
  options: NotifyOptions
): Promise<void> {
  const cfg = env.report.email;
  if (!cfg.smtp) {
    console.warn("[qa] email enabled but no SMTP config present; skipping");
    return;
  }
  const transport = nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: cfg.smtp.secure,
    auth: cfg.smtp.user
      ? { user: cfg.smtp.user, pass: cfg.smtp.pass }
      : undefined,
  });

  // Route to the union of configured recipients + per-feature owners that failed.
  const owners = summary.byFeature
    .filter((f) => f.status === "FAILED")
    .map((f) => f.owner)
    .filter(Boolean);
  const to = [...new Set([...cfg.to, ...owners])];

  await transport.sendMail({
    from: cfg.from,
    to,
    subject: renderSubject(summary),
    text: renderText(summary, options.reportUrl),
    html: renderHtml(summary, options.reportUrl),
  });
}

async function sendSlack(
  env: FrameworkEnv,
  summary: RunSummary,
  options: NotifyOptions
): Promise<void> {
  const webhook = env.report.slack!.webhook;
  const text = renderText(summary, options.reportUrl);
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: `\`\`\`${text}\`\`\`` }),
  });
  if (!res.ok) throw new Error(`Slack webhook returned ${res.status}`);
}