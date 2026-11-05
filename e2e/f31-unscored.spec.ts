import { readFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const SHOTS = "e2e/screenshots";
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 375, height: 812 };

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

const made: string[] = [];

// close the cases made here so they leave the top of the grid for the specs that run after this one
test.afterEach(async ({ request }) => {
  await request.put("/api/autopilot", { data: { enabled: false, threshold: 85 } });
  for (const id of made.splice(0)) await request.post(`/api/disputes/${id}/accept`);
});

/** An open webhook dispute with no documents, due first so it sits at the top of the grid. */
async function bareCase(request: APIRequestContext, tag: string): Promise<string> {
  await request.put("/api/autopilot", { data: { enabled: false, threshold: 85 } });
  const id = `PP-D-F31${tag}${Date.now().toString(36).toUpperCase()}`;
  const res = await request.post("/api/webhooks/paypal", {
    data: {
      id: `WH-${id}`,
      event_type: "CUSTOMER.DISPUTE.CREATED",
      resource: {
        dispute_id: id,
        reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
        status: "WAITING_FOR_SELLER_RESPONSE",
        dispute_amount: { currency_code: "USD", value: "31.00" },
        seller_response_due_date: new Date(Date.now() + 6 * 60 * 1000).toISOString(),
      },
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  made.push(id);
  return id;
}

for (const [name, size] of [["desktop", DESKTOP], ["phone", MOBILE]] as const) {
  test(`${name}: a case with no documents asks for evidence everywhere, and scores once one is added`, async ({ page, request }) => {
    const errors = watchErrors(page);
    await page.setViewportSize(size);
    const id = await bareCase(request, name === "phone" ? "P" : "D");
    await page.goto("/#token=e2e-token");
    await page.evaluate(() => ((window as unknown as { f31Mark: number }).f31Mark = 1)); // gone if the page reloads
    if (name === "phone") {
      const card = page.locator(`#cards .case-card[data-id="${id}"]`);
      await card.scrollIntoViewIfNeeded();
      await card.click();
    } else {
      const row = page.locator(`.ag-row[row-id="${id}"]`);
      await expect(row).toBeVisible();
      await row.locator('[col-id="reason"]').click();
    }
    const sheet = page.getByRole("dialog", { name: `Dispute ${id}` });
    await expect(sheet.getByRole("heading", { name: "Win probability" })).toBeVisible();

    // one state: dash, "Add evidence" as the recommendation, no ledger, no baseline
    await expect(sheet.locator(".score-num")).toHaveText("—");
    await expect(sheet.locator(".score")).toContainText("Upload evidence to score");
    await expect(sheet.locator(".rec-pill")).toHaveText("Add evidence");
    await expect(sheet.locator(".rec")).not.toContainText(/Fight|Offer refund|Accept/);
    await expect(sheet.locator(".factors")).toHaveCount(0);
    await expect(sheet.locator(".factor")).toHaveCount(0);
    await expect(sheet.getByText("Starting point")).toHaveCount(0);

    // Submit is disabled and says why; the settle actions are not offered; Add evidence is the next step
    const submit = page.locator("#submit-btn");
    await expect(submit).toBeVisible();
    await expect(submit).toBeDisabled();
    await expect(page.locator("#submit-why")).toBeVisible();
    await expect(page.locator("#submit-why")).toHaveText("Upload a document first");
    await expect(page.getByRole("button", { name: "Accept claim" })).not.toHaveClass(/btn-primary/); // no verdict, so no recommended action
    const add = sheet.getByRole("button", { name: "Add evidence" });
    await expect(add).toBeVisible();
    await expect(add).toBeEnabled();
    await expect(add).toHaveClass(/btn-primary/);
    await page.screenshot({ path: `${SHOTS}/f31-nodoc-${size.width}.png` });

    // one document in, no reload: score, ledger, recommendation and Submit come back
    await sheet.locator('input[type="file"]').setInputFiles({ name: "ups_receipt.pdf", mimeType: "application/pdf", buffer: readFileSync("samples/ups_receipt.pdf") });
    await expect(sheet.locator(".score-num")).toHaveText(/^\d+%$/, { timeout: 15000 });
    await expect(sheet.locator(".factors")).toBeVisible();
    await expect(sheet.getByText("Starting point")).toBeVisible();
    await expect(sheet.locator(".rec-pill")).toHaveText(/^(Fight|Offer refund|Accept)$/);
    await expect(page.locator("#submit-why")).toBeHidden();
    await expect(submit).toBeEnabled();
    await expect(add).not.toHaveClass(/btn-primary/);
    expect(await page.evaluate(() => (window as unknown as { f31Mark?: number }).f31Mark)).toBe(1);
    await page.screenshot({ path: `${SHOTS}/f31-added-${size.width}.png` });
    expect(errors).toEqual([]);
  });
}
