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

const AUTH = { Authorization: "Bearer e2e-token" };

// the ledger must add up to the headline: above 95 a last row takes the difference, at or below it there is none
for (const [name, size] of [["1440", { width: 1440, height: 900 }], ["375", { width: 375, height: 812 }]] as const) {
  test(`${name}: the ledger ends with a Capped at 95% row only when the raw score is above 95`, async ({ page, request }) => {
    await page.setViewportSize(size);
    const phone = size.width <= 700;
    await page.goto("/#token=e2e-token");
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/demo/chargeback")),
      page.getByRole("button", { name: "Simulate chargeback" }).click(),
    ]);
    const perfect = ((await res.json()) as { id: string }).id;

    const seeded = ((await (await request.post("/api/demo/seed", { headers: AUTH })).json()) as { disputes: { id: string }[] }).disputes.map((d) => d.id);
    const rows = (await (await request.get("/api/disputes", { headers: AUTH })).json()) as { id: string; win_probability: number | null }[];
    const lower = rows.find((r) => seeded.includes(r.id) && r.win_probability === 79)!.id;
    await page.reload();

    const open = async (id: string) => {
      if (phone) {
        const card = page.locator(`#cards .case-card[data-id="${id}"]`);
        await card.scrollIntoViewIfNeeded();
        await card.click();
      } else await page.locator(`.ag-row[row-id="${id}"] [col-id="reason"]`).click();
      return page.getByRole("dialog", { name: `Dispute ${id}` });
    };

    let sheet = await open(perfect);
    const cap = sheet.locator(".factor.cap");
    await expect(cap).toHaveCount(1);
    await expect(cap).toContainText("Capped at 95%");
    await expect(cap).toContainText("No chargeback is a sure win");
    await expect(cap.locator(".points")).toHaveText("−5"); // 95 - raw 100
    await expect(sheet.locator(".factors .factor").last()).toHaveClass(/cap/);
    await sheet.locator(".factors").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/f28-ledger-${name}.png` });
    await sheet.getByRole("button", { name: "Close" }).first().click();

    sheet = await open(lower);
    await expect(sheet.locator(".score-num")).toHaveText("79%");
    await expect(sheet.locator(".factor.cap")).toHaveCount(0);
    for (const id of [perfect, ...seeded]) await request.post(`/api/disputes/${id}/accept`, { headers: AUTH });
  });
}
