import { readFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";

// F27: the slow model steps say what they are doing. The e2e server holds an upload read for DISPUTESHIELD_READ_DELAY
// seconds and the rebuttal note for DISPUTESHIELD_NOTE_DELAY (both 2), and runs with DISPUTESHIELD_LLM=off, so /api/config
// is answered here (as a live qwen3:8b server would) wherever a test needs to see a model named.
const SHOTS = "e2e/screenshots";
const DESKTOP = { width: 1440, height: 900 };
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

async function config(page: Page, llm_model: string | null, paypal = false): Promise<void> {
  await page.route("**/api/config", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), llm_model, paypal } });
  });
}

/** The e2e server has no PayPal webhook id, so every case is "simulated": show the list as a sandbox account's would. */
async function asPayPalCases(page: Page): Promise<void> {
  await page.route("**/api/disputes", async (route) => {
    try {
      const res = await route.fetch();
      const rows = (await res.json()) as object[];
      await route.fulfill({ response: res, json: rows.map((r) => ({ ...r, source: "paypal" })) });
    } catch {
      // a poll that was still in flight when the test ended and the page went away
    }
  });
}

const stamp = () => Date.now().toString(36).toUpperCase();

async function bareCase(page: Page): Promise<string> {
  const id = `PP-D-F27${stamp()}`;
  const res = await page.request.post("/api/webhooks/paypal", {
    data: {
      id: `WH-${id}`,
      event_type: "CUSTOMER.DISPUTE.CREATED",
      resource: {
        dispute_id: id,
        reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
        status: "WAITING_FOR_SELLER_RESPONSE",
        dispute_amount: { currency_code: "USD", value: "64.00" },
        seller_response_due_date: new Date(Date.now() + 120 * 3600 * 1000).toISOString(),
      },
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  made.push(id);
  return id;
}

// closed afterwards so the cases do not crowd the open rows of later specs
const made: string[] = [];
test.afterEach(async ({ request }) => {
  for (const id of made.splice(0)) {
    await request.post("/api/webhooks/paypal", {
      data: {
        id: `WH-${id}-closed`,
        event_type: "CUSTOMER.DISPUTE.RESOLVED",
        resource: {
          dispute_id: id,
          reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
          status: "RESOLVED",
          dispute_outcome: { outcome_code: "RESOLVED_SELLER_FAVOUR" },
          dispute_amount: { currency_code: "USD", value: "64.00" },
        },
      },
    });
  }
});

test.beforeEach(async ({ request }) => {
  await request.put("/api/autopilot", { data: { enabled: false, threshold: 85 } });
});

async function openCase(page: Page, id: string): Promise<Locator> {
  const cell = page.locator(`.ag-row[row-id="${id}"] [col-id="reason"]`);
  await cell.scrollIntoViewIfNeeded();
  await cell.click();
  const panel = page.getByRole("dialog", { name: `Dispute ${id}` });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Extracted evidence" })).toBeVisible();
  return panel;
}

const live = (page: Page) => page.locator("#progress-live");

async function upload(panel: Locator): Promise<void> {
  await panel.locator("#evidence-file").setInputFiles("samples/ups_receipt.pdf");
}

test("an upload names the file and the model, ticks, then moves on to scoring and clears", async ({ page }) => {
  const errors = watchErrors(page);
  await config(page, "qwen3:8b");
  // hold the score back so the second step stays on screen long enough to see
  await page.route("**/api/disputes/*/score", async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  const id = await bareCase(page);
  await page.goto("/#token=e2e-token");
  const panel = await openCase(page, id);
  const step = panel.locator("#evidence-box .step");

  await upload(panel);
  await expect(step).toContainText("Reading ups_receipt.pdf with qwen3:8b");
  await expect(step.locator(".elapsed")).toHaveText(/· \d+ s/);
  await expect(step.locator(".elapsed")).toHaveAttribute("aria-hidden", "true"); // the seconds are never announced
  await expect(panel.getByRole("button", { name: /Reading/ })).toBeDisabled();
  await expect(step.locator(".elapsed")).toHaveText("· 1 s"); // it ticks
  await step.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/f27-upload-desktop.png` });
  await expect(live(page)).toHaveText("Reading ups_receipt.pdf with qwen3:8b"); // a step change, no seconds
  await expect(step).toContainText("Scoring the case");
  await expect(live(page)).toHaveText("Scoring the case");
  await expect(panel.locator("#evidence-box .card").first()).toBeVisible();
  await expect(step).toHaveCount(0); // cleared
  await expect(live(page)).not.toHaveText(/Reading|Scoring/); // the next thing it may say is the new note
  expect(errors).toEqual([]);
});

test("an upload does not name a model when none is called", async ({ page }) => {
  await config(page, null);
  const id = await bareCase(page);
  await page.goto("/#token=e2e-token");
  const panel = await openCase(page, id);
  await upload(panel);
  const step = panel.locator("#evidence-box .step");
  await expect(step).toContainText("Reading ups_receipt.pdf");
  await expect(step).not.toContainText(" with ");
  await expect(panel.locator("#evidence-box .card").first()).toBeVisible();
});

test("a drop shows the same step, and closing the panel leaves no stale step behind", async ({ page }) => {
  await config(page, "qwen3:8b");
  const id = await bareCase(page);
  await page.goto("/#token=e2e-token");
  const panel = await openCase(page, id);
  const bytes = Array.from(readFileSync("samples/ups_receipt.pdf"));
  const dt = await page.evaluateHandle((b) => {
    const t = new DataTransfer();
    t.items.add(new File([new Uint8Array(b)], "ups_receipt.pdf", { type: "application/pdf" }));
    return t;
  }, bytes);
  const zone = panel.locator("[data-drop]");
  await zone.dispatchEvent("dragenter", { dataTransfer: dt });
  await zone.dispatchEvent("drop", { dataTransfer: dt });
  await expect(panel.locator("#evidence-box .step")).toContainText("Reading ups_receipt.pdf with qwen3:8b");
  await panel.getByRole("button", { name: "Close" }).click();
  await expect(panel).toBeHidden();
  await expect(live(page)).toHaveText("");
  // another case opens with no stale step
  const other = await bareCase(page);
  await page.reload();
  const p2 = await openCase(page, other);
  await expect(p2.locator(".step")).toHaveCount(0);
  await expect(p2.locator(".elapsed")).toHaveCount(0);
});

test("the note says which model writes it and counts the seconds", async ({ page }) => {
  await config(page, "qwen3:8b");
  await page.goto("/#token=e2e-token");
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/demo/chargeback")),
    page.getByRole("button", { name: "Simulate chargeback" }).click(),
  ]);
  const id = ((await res.json()) as { id: string }).id;
  const panel = await openCase(page, id);
  const pending = panel.locator("#h-dossier ~ .loading");
  await expect(pending).toContainText("Writing the rebuttal note with qwen3:8b");
  await expect(pending.locator(".elapsed")).toHaveText(/· \d+ s/);
  await expect(pending.locator(".elapsed")).toHaveAttribute("aria-hidden", "true");
  await expect(pending).toHaveCount(0, { timeout: 10_000 });
});

test("submit shows the note step, then the PayPal step, then clears", async ({ page }) => {
  const errors = watchErrors(page);
  await config(page, "qwen3:8b", true);
  await asPayPalCases(page);
  // hold the submit back so the PayPal step stays on screen
  await page.route("**/api/disputes/*/submit", async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.goto("/#token=e2e-token");
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/demo/chargeback")),
    page.getByRole("button", { name: "Simulate chargeback" }).click(),
  ]);
  const id = ((await res.json()) as { id: string }).id;
  const panel = await openCase(page, id);
  const button = panel.locator("#submit-btn");
  await expect(button).toBeEnabled();
  await button.click(); // the note is still being written (2 s hold)
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute("aria-busy", "true");
  await expect(button).toHaveText("Writing note…"); // the full step lives only in the pill above
  await expect(button.locator(".elapsed")).toHaveCount(0);
  await expect(panel.locator("#submit-result")).toContainText("Writing the rebuttal note with qwen3:8b");
  await expect(panel.locator("#submit-result .elapsed")).toHaveText(/· \d+ s/);
  await expect(panel.locator("#submit-result .elapsed")).toHaveAttribute("aria-hidden", "true");
  await page.screenshot({ path: `${SHOTS}/f27-submit-note-desktop.png` });
  await expect(panel.locator("#submit-result")).toContainText("Sending evidence to PayPal", { timeout: 10_000 });
  await expect(button).toHaveText("Sending…");
  await expect(button).toBeDisabled();
  await page.screenshot({ path: `${SHOTS}/f27-submit-paypal-desktop.png` });
  await expect(panel.locator("#submit-result .banner")).toContainText(/Demo mode/, { timeout: 10_000 });
  await expect(panel.locator(".elapsed")).toHaveCount(0); // nothing left ticking
  await expect(button).toHaveText("Evidence submitted");
  await expect(button).not.toHaveAttribute("aria-busy", "true");
  expect(errors).toEqual([]);
});

test("submit in demo mode does not claim to talk to PayPal", async ({ page }) => {
  await config(page, null, false);
  await page.route("**/api/disputes/*/submit", async (route) => {
    await new Promise((r) => setTimeout(r, 1200));
    await route.continue();
  });
  await page.goto("/#token=e2e-token");
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/demo/chargeback")),
    page.getByRole("button", { name: "Simulate chargeback" }).click(),
  ]);
  const id = ((await res.json()) as { id: string }).id;
  const panel = await openCase(page, id);
  const button = panel.locator("#submit-btn");
  await expect(panel.locator("#h-dossier ~ .card .note")).toBeVisible({ timeout: 10_000 }); // the note is cached now
  await button.click();
  await expect(panel.locator("#submit-result")).toContainText("Recording the evidence (demo, not sent to PayPal)");
  await expect(button).toHaveText("Sending…");
  await expect(button).not.toContainText("PayPal");
  await expect(panel.locator("#submit-result .banner")).toContainText(/Demo mode/, { timeout: 10_000 });
});

test("phone: upload and submit steps fit at 375 wide", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await config(page, "qwen3:8b", true);
  await asPayPalCases(page);
  await page.route("**/api/disputes/*/submit", async (route) => {
    await new Promise((r) => setTimeout(r, 2500));
    await route.continue();
  });
  const id = await bareCase(page);
  await page.goto("/#token=e2e-token");
  await page.locator(`button[aria-label^="Dispute ${id}"]`).click();
  const panel = page.getByRole("dialog", { name: `Dispute ${id}` });
  await expect(panel.getByRole("heading", { name: "Extracted evidence" })).toBeVisible();
  await upload(panel);
  await expect(panel.locator("#evidence-box .step")).toContainText("Reading ups_receipt.pdf with qwen3:8b");
  await panel.locator("#evidence-box .step").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/f27-upload-mobile.png` });
  await expect(panel.locator("#evidence-box .card").first()).toBeVisible({ timeout: 15_000 });
  const button = panel.locator("#submit-btn");
  await expect(button).toBeEnabled();
  const idleHeight = (await button.boundingBox())!.height;
  await button.click();
  await expect(button).toHaveText(/^(Writing note…|Sending…)$/); // short: one line, the pill above has the full step
  await expect(panel.locator("#submit-result")).toContainText(/Writing the rebuttal note|Sending evidence to PayPal/);
  await page.screenshot({ path: `${SHOTS}/f27-submit-mobile.png` });
  const box = await button.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(MOBILE.width);
  expect(box!.height).toBeCloseTo(idleHeight, 0);
  await expect(panel.locator("#submit-result .banner")).toBeVisible({ timeout: 15_000 });
});
