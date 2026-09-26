import { expect, test } from "@playwright/test";

const email = process.env.QA_ADMIN_EMAIL ?? "admin@e2e.test";
const password = process.env.QA_ADMIN_PASSWORD ?? "Password123!";

const settingsRoutes = [
  "/dashboard/settings/queues", "/dashboard/settings/routing", "/dashboard/settings/automation",
  "/dashboard/bots", "/dashboard/settings/ai-agent", "/dashboard/settings/tags",
  "/dashboard/settings/custom-fields", "/dashboard/settings/statuses", "/dashboard/settings/quick-replies",
  "/dashboard/team", "/dashboard/roles", "/dashboard/settings/advanced", "/dashboard/settings/sso",
  "/dashboard/settings/announcements", "/dashboard/settings/helpcenter-announcements", "/dashboard/settings/helpcenter",
];

test("all configured settings routes render for an administrator", async ({ page }) => {
  await page.goto("http://mydomain.clariconops.test/login");
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill(password);
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await expect(page).toHaveURL(/\/dashboard/);

  for (const route of settingsRoutes) {
    await page.goto(`http://mydomain.clariconops.test${route}`);
    await expect(page).toHaveURL(new RegExp(route.replaceAll("/", "\\/")));
    await expect(page.locator("#root")).not.toContainText(/something went wrong|application error/i);
  }
});
