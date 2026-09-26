import { test, expect } from "@playwright/test";

const email = process.env.QA_ADMIN_EMAIL ?? "admin@e2e.test";
const password = process.env.QA_ADMIN_PASSWORD ?? "Password123!";

async function login(page: import("@playwright/test").Page) {
  await page.goto("http://mydomain.clariconops.test/login");
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill(password);
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

async function authenticatedFetch(
  page: import("@playwright/test").Page,
  url: string,
  method: string,
  data?: Record<string, unknown>,
) {
  const accessToken = await page.evaluate(
    () =>
      (
        globalThis as unknown as {
          sessionStorage: { getItem(key: string): string | null };
        }
      ).sessionStorage.getItem("accessToken"),
  );
  return page.evaluate(async ({ url, method, data, accessToken }) => {
    const response = await fetch(url, {
      method,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    return { status: response.status, body: await response.text() };
  }, { url, method, data, accessToken });
}

test("UI bot create opens the visual builder with every step option", async ({ page }) => {
  const name = `qa-ui-bot-${Date.now()}`;
  await login(page);
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

test("UI bot builder renders a complete persisted conversation flow", async ({ page }) => {
  await login(page);
  await page.goto("http://mydomain.clariconops.test/dashboard/bots");
  await page.locator('[data-qa="bot.create"]').click();
  await page.getByPlaceholder("e.g., Order Inquiry Bot").fill(`qa-ui-flow-${Date.now()}`);
  await page.getByRole("button", { name: /^create$/i }).click();
  await expect(page).toHaveURL(/\/dashboard\/bots\//);
  const botId = page.url().split("/").pop();
  expect(botId).toBeTruthy();
  const apiBase = new URL(page.url()).origin;
  const addStep = async (step: Record<string, unknown>) => {
    const result = await authenticatedFetch(page, `${apiBase}/api/bots/${botId}/steps`, "POST", step);
    expect(result.status, `creating ${String(step.step_type)} via the authenticated UI session: ${result.body}`).toBe(201);
  };

  // The browser creates the bot; API setup supplies the complete valid graph.
  // This gives UI regression coverage for every supported node without relying
  // on a tenant-specific external API configuration.
  await addStep({ step_type: "send_message", step_name: "UI flow · Bot says", step_order: 1, config: { message: "Welcome" } });
  await addStep({ step_type: "get_information", step_name: "UI flow · Collect", step_order: 2, config: { message: "Order number?", data_type: "text", field_name: "order_number", validation: { required: true } } });
  await addStep({ step_type: "branched_based_filters", step_name: "UI flow · Branch", step_order: 3, config: { rules: [], option_branches: {} } });
  await addStep({ step_type: "external_api_call", step_name: "UI flow · External API", step_order: 4, config: { api_config_id: "", input_variables: {}, response_variable_name: "qa_response", response_status_variable_name: "qa_status", option_branches: {} } });
  await addStep({ step_type: "end_conversation", step_name: "UI flow · End", step_order: 5, config: { message: "Goodbye", actions: [] } });

  await page.reload();
  for (const stepName of ["UI flow · Bot says", "UI flow · Collect", "UI flow · Branch", "UI flow · External API", "UI flow · End"]) {
    await expect(page.getByText(new RegExp(`^${stepName.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}$`, "i"))).toBeVisible();
  }
});
