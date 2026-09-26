import { expect, test } from "@playwright/test";

const email = process.env.QA_ADMIN_EMAIL ?? "admin@e2e.test";
const password = process.env.QA_ADMIN_PASSWORD ?? "Password123!";

test("UI queue CRUD exposes filters and removes a QA-created queue", async ({ page }) => {
  const name = `qa-ui-queue-${Date.now()}`;

  await page.goto("http://mydomain.clariconops.test/login");
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill(password);
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await expect(page).toHaveURL(/\/dashboard/);

  await page.goto("http://mydomain.clariconops.test/dashboard/settings/queues");
  await expect(page.getByRole("heading", { name: "Queues" })).toBeVisible();
  await expect(page.getByText("All statuses", { exact: true })).toBeVisible();
  await expect(page.getByText("All algorithms", { exact: true })).toBeVisible();
  await expect(page.getByText("Priority order", { exact: true })).toBeVisible();

  await page.locator('[data-qa="queue.create"]').click();
  await page.locator('[data-qa="queue.name"]').fill(name);
  await page.locator('[data-qa="queue.description"]').fill("Created by the browser regression suite");
  await page.getByRole("button", { name: "Create queue", exact: true }).last().click();

  await expect(page.getByText(name, { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Search queues" }).fill(name);
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  await page.getByText("All statuses", { exact: true }).click();
  await page.getByText("Active", { exact: true }).last().click();
  await expect(page.getByText(name, { exact: true })).toBeVisible();

  const card = page.locator('[data-qa="queue.card"]').filter({ hasText: name });
  await card.getByRole("button", { name: "Queue actions" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText(name, { exact: true })).toHaveCount(0);
});
