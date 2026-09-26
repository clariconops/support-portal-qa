import { test, expect } from "@playwright/test";

/**
 * UI behaviour for the `tickets` feature (layer: ui). Title must match
 * `tickets.ui.list.testName` in features/tickets.feature.yaml.
 */
test("UI ticket list renders", async ({ page }) => {
  await page.goto("/dashboard/tickets");
  await expect(page.getByRole("heading", { name: /tickets/i })).toBeVisible({
    timeout: 15_000,
  });
});