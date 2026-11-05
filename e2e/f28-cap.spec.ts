import { expect, test, type Page } from "@playwright/test";

const SHOTS = "e2e/screenshots";

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

// the simulated chargeback scores a raw 100: every place a person reads a win chance must say 95% instead
for (const [name, size] of [["1440", { width: 1440, height: 900 }], ["375", { width: 375, height: 812 }]] as const) {
  test(`${name}: a raw 100 case shows 95% in the list, the panel, the recommendation and the KPI, never 100%`, async ({ page }) => {
    await page.setViewportSize(size);
    const errors = watchErrors(page);
    await page.goto("/#token=e2e-token");
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/demo/chargeback")),
      page.getByRole("button", { name: "Simulate chargeback" }).click(),
    ]);
    const id = ((await res.json()) as { id: string }).id;
    const phone = size.width <= 700;

    const cell = phone ? page.locator(`#cards .case-card[data-id="${id}"] .win`) : page.locator(`.ag-row[row-id="${id}"] [col-id="win"]`);
    await expect(cell).toContainText("95%");
    await expect(page.locator("#kpi-win")).toHaveText(/^\d+%$/);
    expect(Number((await page.locator("#kpi-win").innerText()).replace("%", ""))).toBeLessThanOrEqual(95);
    await expect(page.locator("body")).not.toContainText("100%");
    if (phone) await page.locator(`#cards .case-card[data-id="${id}"]`).click();
    else await page.locator(`.ag-row[row-id="${id}"] [col-id="reason"]`).click();

    const sheet = page.getByRole("dialog", { name: `Dispute ${id}` });
    await expect(sheet.locator(".score-num")).toHaveText("95%");
    await expect(sheet.locator(".rec-reason")).toContainText("Strong case: about a 95% chance of winning");
    await expect(sheet.locator(".audit li", { hasText: /scored 95%/ }).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("body")).not.toContainText("100%");
    await page.screenshot({ path: `${SHOTS}/f28-cap-${name}.png` });
    expect(errors).toEqual([]);
  });
}
