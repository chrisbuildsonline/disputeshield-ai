import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

// Record the disputed order as a PayPal invoice from the case panel. The e2e server has no PayPal keys and only
// simulated cases, so a real click gives the labelled demo record; the live answer and the failures are routed in.
const SHOTS = "e2e/screenshots";
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 375, height: 812 };
const ACTION = "Record as PayPal invoice";
const FACTOR = "Order recorded as a PayPal invoice";
const DEMO = "Demo mode: nothing was sent to PayPal";
const HONEST = /draft invoice in the PayPal sandbox \(nothing is sent to the buyer\).*simulated cases get a labelled demo record/i;

test.use({ viewport: DESKTOP }); // each test seeds its own cases, so they don't depend on each other

interface Row {
  id: string;
  currency: string | null;
  amount_value: string | null;
}

interface InvoiceJson {
  demo: boolean;
  label: string;
  invoice_id: string;
  invoice_number: string;
  debug_id: string | null;
  fields: { total: { currency_code: string; value: string } };
  already_recorded: boolean;
}

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

const money = (t: { currency_code: string; value: string }) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: t.currency_code }).format(Number(t.value));

async function seed(request: APIRequestContext): Promise<Row[]> {
  const res = await request.post("/api/demo/seed");
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { disputes: Row[] }).disputes;
}

const probability = async (request: APIRequestContext, id: string) =>
  ((await (await request.get(`/api/disputes/${id}/score`)).json()) as { probability: number }).probability;

/** A fresh seeded case with room under 100%, where a score bump would show if the invoice caused one. */
async function caseWithRoom(request: APIRequestContext): Promise<{ id: string; before: number }> {
  for (const d of await seed(request)) {
    const p = await probability(request, d.id);
    if (p <= 96) return { id: d.id, before: p };
  }
  throw new Error("no seeded case scores under 97%");
}

async function openCase(page: Page, id: string): Promise<Locator> {
  const panel = page.getByRole("dialog", { name: `Dispute ${id}` });
  if (page.viewportSize()!.width <= 700) {
    // a phone lists the cases as cards: tap the case's card
    const card = page.locator(`#cards .case-card[data-id="${id}"]`);
    await card.scrollIntoViewIfNeeded();
    await card.tap();
    await expect(panel.getByRole("heading", { name: "Extracted evidence" })).toBeVisible();
    return panel;
  }
  // the grid only draws the rows near its scroll position: page down until this one is on screen
  await expect
    .poll(() =>
      page.locator("#grid").evaluate((grid, id) => {
        const rows = Array.from(grid.querySelectorAll(".ag-row[row-id]"));
        let v = rows[0]?.parentElement ?? null;
        while (v && v !== grid && !(v.scrollHeight > v.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(v).overflowY)))
          v = v.parentElement;
        const box = (v ?? grid).getBoundingClientRect();
        const shown = rows.filter((r) => {
          const b = r.getBoundingClientRect();
          return b.bottom > box.top && b.top < box.bottom;
        });
        if (shown.some((r) => r.getAttribute("row-id") === id)) return true;
        if (shown.length && v && v !== grid) v.scrollBy(0, v.clientHeight - 56);
        return false;
      }, id),
    )
    .toBe(true);
  const cell = page.locator(`.ag-row[row-id="${id}"] [col-id="reason"]`);
  await cell.scrollIntoViewIfNeeded();
  await cell.click();
  await expect(panel.getByRole("heading", { name: "Extracted evidence" })).toBeVisible();
  return panel;
}

const invoiceBanner = (panel: Locator) => panel.locator("#invoice-box .banner");

test("record a seeded case as a PayPal invoice: demo banner, score unchanged, no factor, audit row, grid, reload", async ({ page, request }) => {
  const errors = watchErrors(page);
  const { id, before } = await caseWithRoom(request);
  await page.goto("/#token=e2e-token");
  const panel = await openCase(page, id);

  const btn = panel.getByRole("button", { name: ACTION });
  await expect(btn).toBeVisible();
  // a secondary pill: the one dark pill in the panel stays the recommended action
  await expect(btn).not.toHaveClass(/btn-primary/);
  await expect(panel.locator(".btn-primary:visible")).toHaveCount(1);
  await expect(panel.getByText(HONEST)).toBeVisible();
  await expect(panel.locator(".factor", { hasText: FACTOR })).toHaveCount(0);
  await expect(panel.locator(".score-num")).toHaveText(`${before}%`);
  await expect(page.locator(`.ag-row[row-id="${id}"] [col-id="win"]`)).toHaveText(`${before}%`);
  await btn.evaluate((b) => b.scrollIntoView({ block: "center" }));
  await page.screenshot({ path: `${SHOTS}/f18-desktop-action.png` });

  // slow the answer a little so the busy label can be seen; count the POSTs to prove a double click sends one
  let posts = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/paypal-invoice") && r.method() === "POST") posts++;
  });
  await page.route("**/api/disputes/*/paypal-invoice", async (route) => {
    await new Promise((r) => setTimeout(r, 700));
    await route.continue();
  });
  const answered = page.waitForResponse((r) => r.url().endsWith("/paypal-invoice") && r.request().method() === "POST");
  await btn.dblclick();
  await expect(panel.getByRole("button", { name: /Recording/ })).toBeDisabled();
  const r = (await (await answered).json()) as InvoiceJson;
  expect([r.demo, r.label, r.already_recorded]).toEqual([true, DEMO, false]);

  const banner = invoiceBanner(panel);
  await expect(banner).toContainText(DEMO);
  await expect(banner).toContainText(r.invoice_number);
  await expect(banner).toContainText(r.invoice_id);
  await expect(banner).toContainText(money(r.fields.total));
  await expect(banner).not.toContainText("→");
  await expect(banner).not.toContainText("Win probability");
  await expect(banner).toBeFocused();
  await expect(panel.getByRole("button", { name: ACTION })).toHaveCount(0);
  expect(posts).toBe(1);

  // a draft we made ourselves is not evidence: the score, its factors and the grid row stay as they were
  await expect(panel.locator(".score-num")).toHaveText(`${before}%`);
  await expect(panel.locator(".factor", { hasText: FACTOR })).toHaveCount(0);
  await expect(page.locator(`.ag-row[row-id="${id}"] [col-id="win"]`)).toHaveText(`${before}%`);
  expect(await probability(request, id)).toBe(before);
  const row = panel.locator(".audit li", { hasText: `Demo: invoice fixture ${r.invoice_number} recorded, nothing sent to PayPal` });
  await expect(row).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/f18-desktop-recorded.png` });

  // asking again returns the stored record, and the audit trail still has one
  const again = (await (await request.post(`/api/disputes/${id}/paypal-invoice`)).json()) as InvoiceJson;
  expect([again.already_recorded, again.invoice_id]).toEqual([true, r.invoice_id]);
  const audit = (await (await request.get(`/api/disputes/${id}/audit`)).json()) as { action: string }[];
  expect(audit.filter((a) => a.action === "invoice_recorded")).toHaveLength(1);

  // a reload opens straight into the recorded state
  await page.unrouteAll({ behavior: "wait" });
  await page.reload();
  const reopened = await openCase(page, id);
  await expect(invoiceBanner(reopened)).toContainText(DEMO);
  await expect(invoiceBanner(reopened)).toContainText(r.invoice_number);
  await expect(reopened.getByRole("button", { name: ACTION })).toHaveCount(0);
  await expect(reopened.locator(".factor", { hasText: FACTOR })).toHaveCount(0);
  await expect(reopened.locator(".score-num")).toHaveText(`${before}%`);
  await expect(reopened.locator(".audit li", { hasText: "Demo: invoice fixture" })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("a refused invoice shows the message and the PayPal debug id in the banner, and the button stays", async ({ page, request }) => {
  const errors = watchErrors(page);
  const [c] = await seed(request);
  let answer: { status: number; json: unknown } = {
    status: 502,
    json: { detail: { message: "INTERNAL_SERVICE_ERROR: An internal service error has occurred.", paypal_name: "INTERNAL_SERVICE_ERROR", debug_id: "f00dcafe12345" } },
  };
  await page.route("**/api/disputes/*/paypal-invoice", (route) => route.fulfill(answer));
  // the failure is written to the audit trail by the server; route one in to check how it reads
  await page.route(`**/api/disputes/${c.id}/audit`, async (route) => {
    const res = await route.fetch();
    const rows = (await res.json()) as unknown[];
    rows.push({ id: 9_999_999, action: "invoice_failed", detail: { error: "PayPal said no", debug_id: "abc123dbg" }, at: new Date().toISOString() });
    await route.fulfill({ response: res, json: rows });
  });
  await page.goto("/#token=e2e-token");
  const panel = await openCase(page, c.id);
  await expect(panel.locator(".audit li", { hasText: "Invoice not recorded: PayPal said no · debug id abc123dbg" })).toBeVisible();

  const btn = panel.getByRole("button", { name: ACTION });
  await btn.click();
  const banner = invoiceBanner(panel);
  await expect(banner).toHaveClass(/banner-bad/);
  await expect(banner).toContainText("Invoice not recorded");
  await expect(banner).toContainText("INTERNAL_SERVICE_ERROR: An internal service error has occurred.");
  await expect(banner).toContainText("debug id f00dcafe12345");
  await expect(banner).not.toContainText("{");
  await expect(banner).toBeFocused();
  await expect(btn).toBeEnabled(); // nothing was recorded, so it can be tried again
  await btn.evaluate((b) => b.scrollIntoView({ block: "center" }));
  await page.screenshot({ path: `${SHOTS}/f18-desktop-error.png` });

  answer = { status: 422, json: { detail: "can't invoice this dispute: amount must be above 0 with at most two decimals" } };
  await btn.click();
  await expect(banner).toContainText("The invoice was not recorded: amount must be above 0 with at most two decimals.");

  answer = { status: 409, json: { detail: "PayPal keys are not set: add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to .env" } };
  await btn.click();
  await expect(banner).toContainText("PayPal keys are not set: add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to .env");
  await expect(btn).toBeEnabled();
  expect(unexpected(errors, [409, 422, 502])).toEqual([]);
  await page.unrouteAll({ behavior: "ignoreErrors" }); // an audit poll can still be in flight when the page closes
});

test("a live sandbox record reads as recorded on PayPal, with its debug id, in the banner and the audit trail", async ({ page, request }) => {
  const errors = watchErrors(page);
  const [c] = await seed(request);
  const total = { currency_code: c.currency ?? "USD", value: c.amount_value ?? "10.00" };
  const live = {
    mode: "paypal", demo: false, source: "live sandbox", label: "Recorded on PayPal sandbox", simulated_case: true, status: "DRAFT",
    invoice_id: "INV2-ABCD-EFGH-IJKL-MNOP", invoice_number: "0042", debug_id: "f1e2d3c4b5a69", lookup_debug_id: "a1b2c3d4e5f60",
    fields: { invoice_id: "INV2-ABCD-EFGH-IJKL-MNOP", invoice_number: "0042", status: "DRAFT", total, item: "Order 1001", recipient: null, verified: true },
    already_recorded: false,
  };
  await page.route("**/api/disputes/*/paypal-invoice", (route) => route.fulfill({ json: live }));
  await page.goto("/#token=e2e-token");
  const panel = await openCase(page, c.id);
  await panel.getByRole("button", { name: ACTION }).click();
  const banner = invoiceBanner(panel);
  await expect(banner).toHaveClass(/banner-good/);
  await expect(banner).toContainText("Recorded on PayPal sandbox");
  await expect(banner).not.toContainText("Demo");
  await expect(banner).toContainText("Draft invoice 0042");
  await expect(banner).toContainText("INV2-ABCD-EFGH-IJKL-MNOP");
  await expect(banner).toContainText(money(total));
  await expect(banner).toContainText("debug id f1e2d3c4b5a69");
  await expect(banner).not.toContainText("→");
  await expect(banner).toContainText("Simulated case · invoice call live on sandbox");
  await banner.evaluate((b) => b.scrollIntoView({ block: "center" }));
  await page.screenshot({ path: `${SHOTS}/f18-desktop-live.png` });

  // the same record as an audit row, from a reload
  await page.route(`**/api/disputes/${c.id}/audit`, async (route) => {
    const res = await route.fetch();
    const rows = (await res.json()) as unknown[];
    rows.push({ id: 9_999_998, action: "invoice_recorded", detail: { ...live.fields, mode: "paypal", source: "live sandbox", debug_id: live.debug_id }, at: new Date().toISOString() });
    await route.fulfill({ response: res, json: rows });
  });
  await page.reload();
  const reopened = await openCase(page, c.id);
  await expect(reopened.locator(".audit li", { hasText: "Recorded on PayPal as draft invoice 0042 · debug id f1e2d3c4b5a69" })).toBeVisible();
  await expect(invoiceBanner(reopened)).toContainText("Recorded on PayPal sandbox");
  await expect(invoiceBanner(reopened)).toContainText("debug id f1e2d3c4b5a69");
  await expect(reopened.getByRole("button", { name: ACTION })).toHaveCount(0);
  expect(errors).toEqual([]);
  await page.unrouteAll({ behavior: "ignoreErrors" }); // an audit poll can still be in flight when the page closes
});

test.describe("phone", () => {
  test.use({ viewport: MOBILE, isMobile: true, hasTouch: true });

  test("the action and its result fit a 375px panel and stay in thumb reach", async ({ page, request }) => {
    const errors = watchErrors(page);
    const { id, before } = await caseWithRoom(request);
    await page.goto("/#token=e2e-token");
    const panel = await openCase(page, id);
    const body = panel.locator(".detail-body");
    const btn = panel.getByRole("button", { name: ACTION });
    await btn.evaluate((b) => b.scrollIntoView({ block: "center" }));
    const box = (await btn.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(MOBILE.width);
    expect(box.height).toBeGreaterThanOrEqual(40); // a thumb-sized target
    expect(await body.evaluate((b) => b.scrollWidth - b.clientWidth)).toBeLessThanOrEqual(0);
    // the panel foot keeps the main action at the bottom of the screen
    const foot = (await panel.locator(".detail-foot").boundingBox())!;
    expect(foot.y + foot.height).toBeLessThanOrEqual(MOBILE.height + 0.5);
    await page.screenshot({ path: `${SHOTS}/f18-phone-action.png` });

    await btn.tap();
    const banner = invoiceBanner(panel);
    await expect(banner).toContainText(DEMO);
    await expect(banner).toBeFocused();
    // focusing the result scrolls the panel body only: the sheet itself never slides up under the phone's top edge
    expect(await panel.evaluate((p) => p.scrollTop)).toBe(0);
    await expect(banner).toBeInViewport();
    await expect(banner).not.toContainText("→");
    await expect(panel.locator(".score-num")).toHaveText(`${before}%`);
    const b = (await banner.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(MOBILE.width);
    expect(await body.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${SHOTS}/f18-phone-recorded.png` });
    expect(errors).toEqual([]);
  });
});
