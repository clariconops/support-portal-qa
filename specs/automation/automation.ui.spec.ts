import { expect, test } from "@playwright/test";

const email = process.env.QA_ADMIN_EMAIL ?? "admin@e2e.test";
const password = process.env.QA_ADMIN_PASSWORD ?? "Password123!";

const triggerLabels = [
  "When a ticket is created", "When an agent sends a message", "When a user sends a message",
  "When a ticket is assigned", "When ticket status changes", "When a tag is added",
  "First response SLA approaching", "Ticket untouched", "User wait timeout", "Queue overflow", "Time-based trigger",
];

const actionLabels = [
  "Assign to agent", "Assign to queue", "Assign to bot", "Assign to AI Agent", "Add tags", "Remove tags",
  "Update custom fields", "Send reply", "Change status", "Escalate priority", "Add internal note", "Send CSAT survey",
];

test("UI automation builder exposes every supported trigger and action", async ({ page }) => {
  await page.goto("http://mydomain.clariconops.test/login");
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill(password);
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await expect(page).toHaveURL(/\/dashboard/);

  await page.goto("http://mydomain.clariconops.test/dashboard/settings/automation");
  await page.locator('[data-qa="automation.create"]').click();
  await expect(page.getByRole("heading", { name: "Create automation rule" })).toBeVisible();
  await page.locator('[data-qa="automation.rule-name"]').fill(`qa-ui-automation-${Date.now()}`);

  await page.getByLabel("Automation trigger").click();
  for (const label of triggerLabels) {
    await page.getByPlaceholder("Search options...").fill(label);
    await expect(page.locator(".sp-select__option-label").filter({ hasText: label })).toBeVisible();
  }
  await page.keyboard.press("Escape");

  await page.locator('[data-qa="automation.action.add"]').click();
  await page.getByLabel("Action 1 type").click();
  for (const label of actionLabels) {
    await page.getByPlaceholder("Search options...").fill(label);
    await expect(page.locator(".sp-select__option-label").filter({ hasText: label })).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
});
