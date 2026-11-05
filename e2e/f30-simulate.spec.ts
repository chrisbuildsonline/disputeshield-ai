import { expect, test, type Page } from "@playwright/test";

const SHOTS = "e2e/screenshots";
const AUTH = { Authorization: "Bearer e2e-token" };

// no X-Demo-Scenario pin here (the config adds it for every other spec): Simulate chargeback rotates
test.use({ viewport: { width: 1440, height: 1500 }, extraHTTPHeaders: AUTH }); // tall: the grid draws only the rows in view

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

interface Made {
  id: string;
  currency: string;
  amount_value: string;
}

test("five clicks on Simulate chargeback give five different cases, strong and weak", async ({ page, request }) => {
  const errors = watchErrors(page);
  const all = (await (await request.get("/api/disputes")).json()) as { id: string; status: string | null; outcome: string | null }[];
  for (const d of all) {
    if (!d.outcome && (d.status === "OPEN" || d.status === "WAITING_FOR_SELLER_RESPONSE")) await request.post(`/api/disputes/${d.id}/accept`);
  }
  await page.goto("/#token=e2e-token");
  await expect(page.locator("#status")).toHaveText("API online");

  const made: Made[] = [];
  for (let i = 0; i < 5; i++) {
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/demo/chargeback")),
      page.getByRole("button", { name: "Simulate chargeback" }).click(),
    ]);
    made.push((await res.json()) as Made);
    await expect(page.locator(`.ag-row[row-id="${made[i].id}"]`)).toBeVisible();
  }
  expect(new Set(made.map((d) => `${d.currency} ${d.amount_value}`)).size).toBe(5);

  // the grid shows five different amounts and scores
  const amounts: string[] = [];
  const bands: string[] = [];
  for (const d of made) {
    const row = page.locator(`.ag-row[row-id="${d.id}"]`);
    amounts.push((await row.locator('[col-id="amount"]').innerText()).trim());
    await expect(row.locator('[col-id="win"] .win')).toHaveAttribute("data-band", /^(fight|offer|accept)$/);
    bands.push((await row.locator('[col-id="win"] .win').getAttribute("data-band")) ?? "");
  }
  expect(new Set(amounts).size).toBe(5);
  expect(bands).toContain("fight");
  expect(bands.some((b) => b !== "fight")).toBe(true);

  // a weak case wears the amber or red pill and the matching recommendation copy
  const weakIdx = bands.findIndex((b) => b === "accept") >= 0 ? bands.findIndex((b) => b === "accept") : bands.findIndex((b) => b !== "fight");
  const weak = made[weakIdx];
  const tone = bands[weakIdx] === "accept" ? "red" : "amber";
  await expect(page.locator(`.ag-row[row-id="${weak.id}"] [col-id="win"] .badge`)).toHaveClass(new RegExp(`badge-${tone}`));
  await page.locator(`.ag-row[row-id="${weak.id}"] [col-id="reason"]`).click();
  const sheet = page.getByRole("dialog", { name: `Dispute ${weak.id}` });
  await expect(sheet.locator(".rec-reason")).toContainText(bands[weakIdx] === "accept" ? "below 30%, so accepting the claim costs less than fighting" : "so a partial refund offer is the safer move");
  await page.screenshot({ path: `${SHOTS}/f30-weak-case-1440.png` });
  await sheet.getByRole("button", { name: "Close" }).first().click();

  await page.locator(`.ag-row[row-id="${made[0].id}"]`).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/f30-rotation-1440.png` });
  expect(errors).toEqual([]);

  for (const d of made) await request.post(`/api/disputes/${d.id}/accept`, { headers: AUTH });
});
