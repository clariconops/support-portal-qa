import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export type EnvName = "local" | "ci" | "staging" | "prod-like" | string;

export interface FrameworkEnv {
  env: EnvName;
  gitSha: string;
  /** UI base URL (Playwright). */
  baseUrl: string;
  /** Per-service API base URLs. */
  services: Record<string, string>;
  /** WebSocket gateway URL. */
  wsUrl: string;
  auth: {
    adminEmail: string;
    adminPassword: string;
    agentEmail: string;
    agentPassword: string;
    limitedEmail: string;
    limitedPassword: string;
  };
  db?: {
    host: string;
    port: number;
    user: string;
    password: string;
    name: string;
  };
  report: {
    dir: string;
    notify: "on-failure" | "always";
    email: {
      enabled: boolean;
      transport: "smtp" | "graph";
      from: string;
      to: string[];
      smtp?: { host: string; port: number; user?: string; pass?: string; secure: boolean };
    };
    slack?: { webhook: string };
  };
  ui: {
    headless: boolean;
    workers: number;
  };
  /** Explicit acknowledgement required before tests that create product data. */
  allowDestructive: boolean;
}

const DEFAULT_SERVICE_PORTS: Record<string, number> = {
  TENANT: 4005,
  TICKET: 4006,
  APP: 4007,
  CUSTOM_FIELDS: 4008,
  AUTOMATION: 4010,
  FILE_STORAGE: 4011,
  QUEUE: 4013,
  ROUTING: 4014,
  SESSION: 4015,
  TAG: 4016,
  WEBSOCKET_GATEWAY: 4017,
  FAQ: 4018,
  AUDIT_LOGS: 4019,
  BOT: 4020,
  SDK_GATEWAY: 5003,
  REALTIME_MESSAGING: 5004,
  SDK_ANALYTICS: 5005,
};

/** Load `.env.<env>` then `.env`, without overriding already-set process env. */
export function loadEnv(envName: EnvName, rootDir: string): FrameworkEnv {
  const candidates = [
    resolve(rootDir, `.env.${envName}`),
    resolve(rootDir, ".env"),
  ];
  for (const file of candidates) {
    if (existsSync(file)) loadDotenv({ path: file, override: false });
  }

  const p = process.env;
  const get = (k: string, fallback = "") => p[k] ?? fallback;
  const num = (k: string, fallback: number) => (p[k] ? Number(p[k]) : fallback);
  const bool = (k: string, fallback: boolean) =>
    p[k] ? p[k].toLowerCase() === "true" : fallback;

  const services: Record<string, string> = {};
  for (const [key, port] of Object.entries(DEFAULT_SERVICE_PORTS)) {
    services[key] = get(
      `QA_${key}_SERVICE_URL`,
      get(`VITE_${key}_SERVICE_URL`, `http://localhost:${port}`)
    );
  }

  return {
    env: envName,
    gitSha: get("QA_GIT_SHA", "unknown"),
    baseUrl: get("QA_BASE_URL", "http://localhost:3000"),
    services,
    wsUrl: get("QA_WS_URL", services.WEBSOCKET_GATEWAY),
    auth: {
      adminEmail: get("QA_ADMIN_EMAIL", "admin@e2e.test"),
      adminPassword: get("QA_ADMIN_PASSWORD", "Password123!"),
      agentEmail: get("QA_AGENT_EMAIL", "agent@e2e.test"),
      agentPassword: get("QA_AGENT_PASSWORD", "Password123!"),
      limitedEmail: get("QA_LIMITED_EMAIL", "limited@e2e.test"),
      limitedPassword: get("QA_LIMITED_PASSWORD", "Password123!"),
    },
    db: p.QA_DB_HOST
      ? {
          host: get("QA_DB_HOST"),
          port: num("QA_DB_PORT", 15432),
          user: get("QA_DB_USER", "support"),
          password: get("QA_DB_PASSWORD", "support"),
          name: get("QA_DB_NAME", "supportdb"),
        }
      : undefined,
    report: {
      dir: get("QA_REPORT_DIR", "reports"),
      notify: (get("QA_NOTIFY", "on-failure") as "on-failure" | "always"),
      email: {
        enabled: bool("QA_EMAIL_ENABLED", false),
        transport: (get("QA_EMAIL_TRANSPORT", "smtp") as "smtp" | "graph"),
        from: get("QA_EMAIL_FROM", "qa-bot@company.com"),
        to: splitList(get("QA_EMAIL_TO", "")),
        smtp: p.QA_SMTP_HOST
          ? {
              host: get("QA_SMTP_HOST"),
              port: num("QA_SMTP_PORT", 587),
              user: p.QA_SMTP_USER,
              pass: p.QA_SMTP_PASS,
              secure: bool("QA_SMTP_SECURE", false),
            }
          : undefined,
      },
      slack: p.QA_SLACK_WEBHOOK ? { webhook: get("QA_SLACK_WEBHOOK") } : undefined,
    },
    ui: {
      headless: bool("QA_HEADLESS", true),
      workers: num("QA_WORKERS", 1),
    },
    allowDestructive: bool("QA_ALLOW_DESTRUCTIVE", envName === "local" || envName === "ci"),
  };
}

function splitList(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}
