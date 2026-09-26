import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";
import { resolve } from "node:path";

// Load .env.local if present, else .env
dotenv.config({ path: resolve(process.cwd(), ".env.local") });
dotenv.config({ path: resolve(process.cwd(), ".env") });

/**
 * Playwright config for the UI layer. The API layer is driven by the `qa` CLI;
 * this config runs the `*.ui.spec.ts` files referenced by feature manifests.
 * Point at any environment with QA_BASE_URL (local | ci | staging).
 */
const BASE_URL = process.env.QA_BASE_URL ?? "http://localhost:3000";
const HEADLESS = (process.env.QA_HEADLESS ?? "true") !== "false";
const WORKERS = Number(process.env.QA_WORKERS ?? "1");
const HOST_RESOLVER_RULES = process.env.QA_BROWSER_HOST_RESOLVER_RULES;

export default defineConfig({
  testDir: "./specs",
  testMatch: /.*\.ui\.spec\.ts$/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: WORKERS,
  reporter: [
    ["list"],
    ["html", { outputFolder: "reports/playwright", open: "never" }],
    ["junit", { outputFile: "reports/playwright/junit.xml" }],
  ],
  use: {
    baseURL: BASE_URL,
    headless: HEADLESS,
    launchOptions: HOST_RESOLVER_RULES ? { args: [`--host-resolver-rules=${HOST_RESOLVER_RULES}`] } : undefined,
    trace: "on-first-retry",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
