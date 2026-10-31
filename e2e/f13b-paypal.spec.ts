import { readFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const SHOTS = "e2e/screenshots";
const DESKTOP = { width: 1440, height: 1000 };
const MOBILE = { width: 375, height: 812 };

test.use({ viewport: DESKTOP });

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

// the browser logs every refused request itself; only the statuses a test provokes on purpose are allowed
const unexpected = (errors: string[], allowed: number[]) =>
  errors.filter((e) => !allowed.some((s) => e.includes(`Failed to load resource: the server responded with a status of ${s}`)));

let seq = 0;

/** A simulated CUSTOMER.DISPUTE.CREATED webhook (demo mode accepts it unsigned), plus an optional sample PDF. */
async function webhookDispute(request: APIRequestContext, reason: string, doc?: string): Promise<string> {
  seq += 1;
  const id = `PP-D-E2E${Date.now().toString(36).toUpperCase()}${seq}`;
  const due = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString();
  const res = await request.post("/api/webhooks/paypal", {
    data: {
      id: `WH-${id}`,
      event_type: "CUSTOMER.DISPUTE.CREATED",
      resource: {
        dispute_id: id,
        reason,
        status: "WAITING_FOR_SELLER_RESPONSE",
        dispute_amount: { currency_code: "USD", value: "49.90" },
        seller_response_due_date: due,
      },
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  if (doc) {
    const up = await request.post(`/api/disputes/${id}/documents?name=${doc}`, {
      data: readFileSync(`samples/${doc}`),
      headers: { "content-type": "application/pdf" },
    });
    expect(up.ok(), await up.text()).toBeTruthy();
  }
  return id;
}

async function openDispute(page: Page, id: string) {
  await page.goto("/#token=e2e-token");
  const row = page.locator(`.ag-row[row-id="${id}"]`);
  await row.locator('[col-id="reason"]').click();
  const detail = page.getByRole("dialog", { name: `Dispute ${id}` });
  await expect(detail).toBeVisible();
  await expect(detail.getByRole("heading", { name: "Win probability" })).toBeVisible();
  return { row, detail };
}

test("sync from PayPal without keys says plainly that the keys are not set", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/#token=e2e-token");
  await expect(page.locator("#status")).toHaveText("API online");
  const sync = page.getByRole("button", { name: "Sync from PayPal" });
  await sync.click();
  const toast = page.getByRole("status").filter({ hasText: "PayPal keys are not set" });
  await expect(toast).toContainText("PayPal keys are not set: add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to .env");
  await expect(sync).toBeEnabled();
  await page.screenshot({ path: `${SHOTS}/f13b-sync-no-keys.png` });
  await page.setViewportSize(MOBILE);
  await expect(toast).toBeInViewport();
  await expect(sync).toBeInViewport();
  await page.screenshot({ path: `${SHOTS}/f13b-sync-no-keys-mobile.png` });
  await page.setViewportSize(DESKTOP);

  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(toast).toBeHidden();
  expect(unexpected(errors, [409])).toEqual([]);
});

test("sync shows the live result, waits with the button disabled and refreshes the grid", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/#token=e2e-token");
  await expect(page.locator("#status")).toHaveText("API online");

  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/paypal/sync", async (route) => {
    await held;
    await route.fulfill({
      json: {
        count: 2,
        fetched_at: "2026-10-31T09:15:30+00:00",
        debug_id: "f00dcafe1234",
        mode: "sandbox",
        disputes: [
          { dispute_id: "PP-D-1", result: "inserted" },
          { dispute_id: "PP-D-2", result: "updated" },
        ],
      },
    });
  });
  const sync = page.getByRole("button", { name: /Sync/ });
  await sync.click();
  await expect(sync).toBeDisabled();
  await expect(sync).toHaveText("Syncing...");
  const refreshed = page.waitForRequest((r) => r.url().endsWith("/api/disputes") && r.method() === "GET");
  release();
  const toast = page.getByRole("status").filter({ hasText: "Synced 2 disputes" });
  await expect(toast).toContainText("Synced 2 disputes from PayPal sandbox");
  await expect(toast).toContainText("debug id f00dcafe1234");
  await expect(toast).toContainText(/Fetched at \d{1,2}:\d{2}/);
  await refreshed;
  await expect(page.getByRole("button", { name: "Sync from PayPal" })).toBeEnabled();
  await page.screenshot({ path: `${SHOTS}/f13b-sync-ok.png` });

  // a PayPal failure shows PayPal's own message and debug id
  await page.unroute("**/api/paypal/sync");
  await page.route("**/api/paypal/sync", (route) =>
    route.fulfill({
      status: 502,
      json: { detail: { message: "Client Authentication failed", paypal_name: "invalid_client", debug_id: "bad0debug99" } },
    }),
  );
  await page.getByRole("button", { name: "Sync from PayPal" }).click();
  const failed = page.getByRole("status").filter({ hasText: "Client Authentication failed" });
  await expect(failed).toContainText("PayPal turned the request down: Client Authentication failed (debug id bad0debug99)");
  expect(unexpected(errors, [502])).toEqual([]);
});

test("a weak case recommends accepting, and accepting needs a confirm step", async ({ page, request }) => {
  const errors = watchErrors(page);
  const id = await webhookDispute(request, "MERCHANDISE_OR_SERVICE_NOT_RECEIVED"); // no documents: 9%
  const { row, detail } = await openDispute(page, id);

  await expect(detail.getByLabel("Win probability 9 percent")).toBeVisible();
  const pill = detail.locator(".rec-pill");
  await expect(pill).toHaveText("Accept");
  await expect(pill).toHaveClass(/badge-red/);
  await expect(detail.getByText("A 9% chance of winning is below 30%, so accepting the claim costs less than fighting.")).toBeVisible();

  const accept = detail.getByRole("button", { name: "Accept claim" });
  const offer = detail.getByRole("button", { name: "Offer refund" });
  await expect(accept).toBeEnabled();
  await expect(offer).toBeEnabled();
  await expect(accept).toHaveClass(/btn-primary/); // the recommended action is the dark pill
  await expect(detail.getByRole("button", { name: "Submit evidence" })).not.toHaveClass(/btn-primary/);
  await page.screenshot({ path: `${SHOTS}/f13b-recommend-desktop.png` });
  await page.setViewportSize(MOBILE);
  await expect(accept).toBeInViewport();
  await page.screenshot({ path: `${SHOTS}/f13b-recommend-mobile.png` });
  await page.setViewportSize(DESKTOP);

  // the first click only asks; Cancel backs out and gives focus back
  await accept.click();
  const confirmYes = detail.getByRole("button", { name: "Yes, accept and refund $49.90" });
  await expect(confirmYes).toBeVisible();
  await expect(detail.getByText("The buyer gets $49.90 back and the dispute closes.")).toBeVisible();
  await detail.getByRole("button", { name: "Cancel" }).click();
  await expect(confirmYes).toBeHidden();
  await expect(accept).toBeFocused();

  await accept.click();
  await page.screenshot({ path: `${SHOTS}/f13b-accept-confirm.png` });
  await confirmYes.click();
  await expect(detail.getByText("Demo mode: nothing was sent to PayPal")).toBeVisible();
  await expect(detail.getByText(/Status: Resolved/)).toBeVisible();
  await expect(detail.getByRole("button", { name: "Accept claim" })).toBeDisabled();
  await expect(detail.getByRole("button", { name: "Offer refund" })).toBeDisabled();
  await expect(detail.getByRole("button", { name: "Claim accepted" })).toBeDisabled();
  await expect(detail.getByText("Claim accepted (demo mode, not sent to PayPal)")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/f13b-accepted.png` });

  // the grid follows
  await expect(row.locator('[col-id="status"]')).toHaveText("Resolved");
  await expect(row).toHaveClass(/row-submitted/);
  expect(errors).toEqual([]);
});

test("an offer above the disputed amount is refused, a valid offer goes through", async ({ page, request }) => {
  const errors = watchErrors(page);
  const id = await webhookDispute(request, "CREDIT_NOT_PROCESSED", "crm_order.pdf"); // order id, amount, buyer messages: 50%
  const { row, detail } = await openDispute(page, id);

  await expect(detail.getByLabel("Win probability 50 percent")).toBeVisible();
  const pill = detail.locator(".rec-pill");
  await expect(pill).toHaveText("Offer refund");
  await expect(pill).toHaveClass(/badge-amber/);
  await expect(detail.getByText(/between 30% and 60%, so a partial refund offer is the safer move/)).toBeVisible();
  const offer = detail.getByRole("button", { name: "Offer refund" });
  await expect(offer).toHaveClass(/btn-primary/);

  await offer.click();
  const amount = detail.getByLabel("Refund amount");
  await expect(amount).toBeFocused();
  await expect(amount).toHaveValue("49.90");
  await expect(amount).toHaveAttribute("max", "49.90");
  await expect(detail.getByText("USD", { exact: true })).toBeVisible();
  await expect(detail.getByText("Up to $49.90, the disputed amount")).toBeVisible();
  await expect(detail.getByLabel("Note to the buyer")).not.toHaveValue("");
  await page.screenshot({ path: `${SHOTS}/f13b-offer-desktop.png` });
  await page.setViewportSize(MOBILE);
  await expect(detail.getByRole("button", { name: "Send offer" })).toBeInViewport();
  await page.screenshot({ path: `${SHOTS}/f13b-offer-mobile.png` });
  await page.setViewportSize(DESKTOP);

  await amount.fill("60");
  await detail.getByRole("button", { name: "Send offer" }).click();
  await expect(detail.getByText("The offer was not sent: offer can't be more than the disputed 49.90 USD.")).toBeVisible();

  await amount.fill("20");
  await detail.getByRole("button", { name: "Send offer" }).click();
  await expect(detail.getByText("Demo mode: nothing was sent to PayPal")).toBeVisible();
  await expect(detail.getByText(/Status: Waiting for buyer response/)).toBeVisible();
  await expect(detail.getByText("Refund offer of $20.00 made (demo mode, not sent to PayPal)")).toBeVisible();
  await expect(detail.getByRole("button", { name: "Offer refund" })).toBeDisabled();
  await expect(detail.getByRole("button", { name: "Accept claim" })).toBeEnabled(); // the buyer may still refuse
  await page.screenshot({ path: `${SHOTS}/f13b-offered.png` });

  await expect(row.locator('[col-id="status"]')).toHaveText("Waiting for buyer response");
  expect(unexpected(errors, [422])).toEqual([]);
});
