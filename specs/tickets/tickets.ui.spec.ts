import { test, expect } from "@playwright/test";

const ADMIN_EMAIL = process.env.QA_ADMIN_EMAIL ?? "admin@e2e.test";
const ADMIN_PASSWORD = process.env.QA_ADMIN_PASSWORD ?? "Password123!";

/**
 * UI behaviour for the `tickets` feature (layer: ui). Title must match
 * `tickets.ui.list.testName` in features/tickets.feature.yaml.
 */
test("UI ticket list renders", async ({ page }) => {
  await page.goto("/login");
  await page.locator("#login-email").fill(ADMIN_EMAIL);
  await page.locator("#login-password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
  await page.goto("/dashboard/tickets");
  await expect(page.getByText("All Tickets", { exact: true }).first()).toBeVisible({
    timeout: 15_000,
  });
});
