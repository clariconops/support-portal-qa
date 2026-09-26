import { test, expect } from "@playwright/test";

const email = process.env.QA_ADMIN_EMAIL ?? "admin@e2e.test";
const password = process.env.QA_ADMIN_PASSWORD ?? "Password123!";

test("UI bot create opens the visual builder with every step option", async ({ page }) => {
  const name = `qa-ui-bot-${Date.now()}`;
  await page.goto("http://mydomain.clariconops.test/login");
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill(password);
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await page.goto("http://mydomain.clariconops.test/dashboard/bots");
  await page.locator('[data-qa="bot.create"]').click();
  await page.getByPlaceholder("e.g., Order Inquiry Bot").fill(name);
  await page.getByRole("button", { name: /^create$/i }).click();
  await expect(page).toHaveURL(/\/dashboard\/bots\//);
  await page.getByRole("button", { name: /add step/i }).click();
  await expect(page.locator('[data-qa="bot.step.send-message"]')).toBeVisible();
  await expect(page.locator('[data-qa="bot.step.get-information"]')).toBeVisible();
  await expect(page.locator('[data-qa="bot.step.branch"]')).toBeVisible();
  await expect(page.locator('[data-qa="bot.step.external-api"]')).toBeVisible();
  await expect(page.locator('[data-qa="bot.step.end-conversation"]')).toBeVisible();
});
