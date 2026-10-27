import { expect, test } from "@playwright/test";

test("home loads and shows API online", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/#token=e2e-token");
  await expect(page).toHaveTitle("DisputeShield AI");
  await expect(page.getByRole("heading", { name: "DisputeShield AI" })).toBeVisible();
  await expect(page.locator("#status")).toHaveText("API online");

  await page.screenshot({ path: "e2e/screenshots/f1-home.png" });
  expect(errors).toEqual([]);
});
