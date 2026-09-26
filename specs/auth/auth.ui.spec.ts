import { test, expect } from "@playwright/test";

/**
 * UI behaviour for the `auth` feature (layer: ui). The test title must match
 * `auth.ui.login.dashboard.testName` in features/auth.feature.yaml.
 *
 * These specs are executed by Playwright (npx playwright test), not the API
 * runner. The API runner skips ui-layer behaviours with status "skipped".
 */
const ADMIN_EMAIL = process.env.QA_ADMIN_EMAIL ?? "admin@e2e.test";
const ADMIN_PASSWORD = process.env.QA_ADMIN_PASSWORD ?? "Password123!";

test("UI login reaches the dashboard", async ({ page }) => {
  await page.goto("/login");
  await page.locator("#login-email").fill(ADMIN_EMAIL);
  await page.locator("#login-password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
});
