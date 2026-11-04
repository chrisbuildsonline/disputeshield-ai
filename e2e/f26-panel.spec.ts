import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const SHOTS = "e2e/screenshots";

test.use({ viewport: { width: 1440, height: 900 } });

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

// the e2e server holds the rebuttal note back for a couple of seconds, like a busy model: the score must not wait for it
const QUICK = { timeout: 1000 };

test("one click on a scored row shows the factor ledger and Submit while the note is still being written", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/#token=e2e-token");
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/demo/chargeback")),
    page.getByRole("button", { name: "Simulate chargeback" }).click(),
  ]);
  const id = ((await res.json()) as { id: string }).id;
  const row = page.locator(`.ag-row[row-id="${id}"]`);
  await expect(row.locator('[col-id="win"]')).toContainText("100%");
  await row.locator('[col-id="reason"]').click();

  const sheet = page.getByRole("dialog", { name: `Dispute ${id}` });
  await expect(sheet.locator(".factors .factor.met").first()).toBeVisible(QUICK);
  await expect(sheet.locator(".score-num")).toHaveText("100%", QUICK);
  await expect(sheet.getByRole("button", { name: "Submit evidence" })).toBeEnabled(QUICK);
  await expect(sheet.locator("#audit-list")).toContainText(/\S/, QUICK);
  const pending = sheet.locator("#h-dossier ~ .loading");
  await expect(pending).toHaveText(/Writing the rebuttal note/, QUICK);
  await page.screenshot({ path: `${SHOTS}/f26-score-note-pending.png` }); // top of the panel: the score is there
  await sheet.locator("#h-dossier").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/f26-note-pending.png` });

  await expect(sheet.locator("#h-dossier ~ .card .note")).toContainText("USD 49.90", { timeout: 10_000 });
  await expect(pending).toHaveCount(0);
  await expect(sheet.locator("#h-dossier ~ .files li")).toHaveText("ups_receipt.pdf");
  await page.screenshot({ path: `${SHOTS}/f26-note-filled.png` });

  await sheet.getByRole("button", { name: "Submit evidence" }).click();
  await expect(sheet.locator("#submit-result .banner")).toContainText(/Demo mode/);
  expect(errors).toEqual([]);
});

test("a panel opened before the case is scored fills in by itself when the receipt is read", async ({ page, request }) => {
  const errors = watchErrors(page);
  const id = `PP-D-F26${Date.now().toString(36).toUpperCase()}`;
  const hook = await request.post("/api/webhooks/paypal", {
    data: {
      id: `WH-${id}`,
      event_type: "CUSTOMER.DISPUTE.CREATED",
      resource: {
        dispute_id: id,
        reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
        status: "WAITING_FOR_SELLER_RESPONSE",
        dispute_amount: { currency_code: "USD", value: "31.00" },
        seller_response_due_date: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
    },
  });
  expect(hook.ok(), await hook.text()).toBeTruthy();
  await page.goto("/#token=e2e-token");
  const row = page.locator(`.ag-row[row-id="${id}"]`);
  await expect(row).toBeVisible();
  await row.locator('[col-id="reason"]').click();
  const sheet = page.getByRole("dialog", { name: `Dispute ${id}` });
  await expect(sheet.locator(".score-none")).toBeVisible();

  // the PDF finishes being read while the panel is open
  const up = await request.post(`/api/disputes/${id}/documents?name=ups_receipt.pdf`, {
    data: readFileSync("samples/ups_receipt.pdf"),
    headers: { "Content-Type": "application/pdf" },
  });
  expect(up.ok(), await up.text()).toBeTruthy();

  await expect(sheet.locator(".score-num")).not.toHaveText("—", { timeout: 10_000 });
  await expect(sheet.locator(".factors .factor.met").first()).toBeVisible();
  await expect(sheet.locator("#evidence-box .card").first()).toContainText("ups_receipt.pdf");
  await expect(sheet.locator("#h-dossier ~ .card .note")).toBeVisible({ timeout: 10_000 });
  expect(errors).toEqual([]);

  await request.post(`/api/disputes/${id}/accept`); // out of the way of the specs that follow
});
