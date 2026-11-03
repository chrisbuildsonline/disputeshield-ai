import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const SHOTS = "e2e/screenshots";
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 375, height: 812 };
// the phone header before F15: title, tagline and three wrapped rows of controls
const PHONE_HEADER_BEFORE = 283;

test.use({ viewport: DESKTOP }); // each test makes its own cases, so they don't depend on each other

interface Row {
  id: string;
  review_reasons: string[] | null;
}

type Box = { x: number; y: number; width: number; height: number };

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

const intersects = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

// the setting lives in the shared database, so leave it off for the other specs whatever happens here
test.afterEach(async ({ request }) => {
  await request.put("/api/autopilot", { data: { enabled: false, threshold: 85 } });
});

/** A simulated chargeback (100%) that the off autopilot has scored and left for the operator: an Open row, not flagged. */
async function waitingCase(request: APIRequestContext): Promise<string> {
  const res = await request.post("/api/demo/chargeback");
  expect(res.ok()).toBeTruthy();
  const id = ((await res.json()) as Row).id;
  await expect
    .poll(async () => ((await (await request.get(`/api/disputes/${id}/audit`)).json()) as { action: string }[]).map((a) => a.action))
    .toContain("autopilot_awaiting");
  return id;
}

/** An Open dispute with no evidence that the autopilot flagged for a real reason: an Open row with a Needs review pill. */
async function flaggedCase(request: APIRequestContext): Promise<string> {
  await request.put("/api/autopilot", { data: { enabled: true, threshold: 85 } }); // so the webhook runs it (afterEach turns it off)
  const id = `PP-D-F15O${Date.now().toString(36).toUpperCase()}`;
  const res = await request.post("/api/webhooks/paypal", {
    data: {
      id: `WH-${id}`,
      event_type: "CUSTOMER.DISPUTE.CREATED",
      resource: {
        dispute_id: id,
        reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
        status: "OPEN",
        dispute_amount: { currency_code: "USD", value: "49.90" },
        seller_response_due_date: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
      },
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  await expect
    .poll(async () => ((await (await request.get("/api/disputes")).json()) as Row[]).find((d) => d.id === id)?.review_reasons ?? null)
    .toEqual(["No evidence documents"]);
  return id;
}

/** A webhook dispute with no documents: it scores 9%, so the panel recommends accepting. */
async function weakCase(request: APIRequestContext): Promise<string> {
  const id = `PP-D-F15${Date.now().toString(36).toUpperCase()}`;
  const res = await request.post("/api/webhooks/paypal", {
    data: {
      id: `WH-${id}`,
      event_type: "CUSTOMER.DISPUTE.CREATED",
      resource: {
        dispute_id: id,
        reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
        status: "WAITING_FOR_SELLER_RESPONSE",
        dispute_amount: { currency_code: "USD", value: "49.90" },
        seller_response_due_date: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
      },
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return id;
}

async function openCase(page: Page, id: string) {
  // the grid only draws the rows near its scroll position: page down until this one is on screen
  await expect
    .poll(() =>
      page.locator("#grid").evaluate((grid, id) => {
        const rows = Array.from(grid.querySelectorAll(".ag-row[row-id]"));
        // the element that scrolls the rows: the first ancestor of a row with vertical overflow
        let v = rows[0]?.parentElement ?? null;
        while (v && v !== grid && !(v.scrollHeight > v.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(v).overflowY)))
          v = v.parentElement;
        const box = (v ?? grid).getBoundingClientRect();
        const shown = rows.filter((r) => {
          const b = r.getBoundingClientRect();
          return b.bottom > box.top && b.top < box.bottom;
        });
        if (shown.some((r) => r.getAttribute("row-id") === id)) return true;
        if (shown.length && v && v !== grid) v.scrollBy(0, v.clientHeight - 56); // one row of overlap, so none is skipped
        return false;
      }, id),
    )
    .toBe(true);
  await page.locator(`.ag-row[row-id="${id}"] [col-id="reason"]`).click();
  const detail = page.getByRole("dialog", { name: `Dispute ${id}` });
  await expect(detail.getByRole("heading", { name: "Win probability" })).toBeVisible();
  return detail;
}

const headerControls = (page: Page) => [
  page.getByRole("switch", { name: "Autopilot" }),
  page.getByLabel("Threshold"),
  page.getByRole("button", { name: "Sync from PayPal" }),
  page.locator("#simulate-btn"),
];

test("the status column fits Open and Needs review side by side", async ({ page, request }) => {
  const errors = watchErrors(page);
  const id = await flaggedCase(request);
  await page.goto("/#token=e2e-token");
  const cell = page.locator(`.ag-row[row-id="${id}"] [col-id="status"]`);
  await expect(cell.locator(".badge")).toHaveText(["Open", "Needs review"]);

  const clipped = await page.locator('.ag-row [col-id="status"]').evaluateAll((cells) =>
    cells.flatMap((c) => {
      const r = c.getBoundingClientRect();
      return Array.from(c.querySelectorAll(".badge"))
        .filter((b) => {
          const x = b.getBoundingClientRect();
          return x.left < r.left || x.right > r.right || x.top < r.top || x.bottom > r.bottom;
        })
        .map((b) => b.textContent);
    }),
  );
  expect(clipped).toEqual([]);
  const tops = await cell.locator(".badge").evaluateAll((bs) => bs.map((b) => Math.round(b.getBoundingClientRect().top)));
  expect(tops[0]).toBe(tops[1]); // one line, side by side

  await page.screenshot({ path: `${SHOTS}/f15-grid-desktop.png` });
  await page.setViewportSize(MOBILE);
  await page.screenshot({ path: `${SHOTS}/f15-grid-mobile.png` });
  expect(errors).toEqual([]);
});

test("the open panel leaves the header controls visible and clickable", async ({ page, request }) => {
  const errors = watchErrors(page);
  const id = await waitingCase(request);
  await page.goto("/#token=e2e-token");
  const detail = await openCase(page, id);
  const panel = (await detail.boundingBox())!;
  for (const control of headerControls(page)) {
    await expect(control).toBeVisible();
    expect(intersects((await control.boundingBox())!, panel)).toBe(false);
    await control.click({ trial: true }); // actionability: nothing on top of it takes the click
  }
  await page.screenshot({ path: `${SHOTS}/f15-panel-desktop.png` });
  await page.setViewportSize(MOBILE); // a phone gives the panel the whole screen: one job per screen
  await expect(detail.getByRole("button", { name: "Submit evidence" })).toBeInViewport();
  await page.screenshot({ path: `${SHOTS}/f15-panel-mobile.png` });
  expect(errors).toEqual([]);
});

test("on a phone the panel title never splits the dispute id", async ({ page, request }) => {
  const errors = watchErrors(page);
  const id = await waitingCase(request);
  await page.goto("/#token=e2e-token");
  const detail = await openCase(page, id);
  await page.setViewportSize(MOBILE);
  const title = detail.locator("#detail-title");
  await expect(title).toHaveText(`Dispute ${id}`);

  const fit = await title.evaluate((h, id) => {
    // the id's characters, wherever they sit in the heading: every one on the same line
    const walk = document.createTreeWalker(h, NodeFilter.SHOW_TEXT);
    let node: Text | null = null;
    while (walk.nextNode()) if ((walk.currentNode as Text).data.includes(id)) node = walk.currentNode as Text;
    if (!node) return null;
    const r = document.createRange();
    const at = node.data.indexOf(id);
    r.setStart(node, at);
    r.setEnd(node, at + id.length);
    const lines = new Set(Array.from(r.getClientRects()).map((x) => Math.round(x.top))).size;
    const panel = h.closest(".detail")!.getBoundingClientRect();
    const box = h.getBoundingClientRect();
    return { lines, overflow: h.scrollWidth - h.clientWidth, inside: box.left >= panel.left && box.right <= panel.right };
  }, id);
  expect(fit).toEqual({ lines: 1, overflow: 0, inside: true });

  // Close stays in thumb reach and keeps its tap target, beside the title
  const close = detail.getByRole("button", { name: "Close" });
  await expect(close).toBeInViewport();
  const c = (await close.boundingBox())!;
  expect(c.height).toBeGreaterThanOrEqual(40);
  expect(c.x + c.width).toBeLessThanOrEqual(MOBILE.width);
  expect(intersects(c, (await title.boundingBox())!)).toBe(false);
  expect(errors).toEqual([]);
});

test("a long status and Needs review both show in the status column", async ({ page, request }) => {
  const errors = watchErrors(page);
  await request.put("/api/autopilot", { data: { enabled: true, threshold: 85 } }); // a 9% case gets flagged
  const id = await weakCase(request);
  await expect
    .poll(async () => ((await (await request.get("/api/disputes")).json()) as Row[]).find((d) => d.id === id)?.review_reasons ?? null)
    .not.toBeNull();
  await page.goto("/#token=e2e-token");
  const cell = page.locator(`.ag-row[row-id="${id}"] [col-id="status"]`);
  await expect(cell.locator(".badge")).toHaveText(["Waiting for seller response", "Needs review"]);
  const clipped = await cell.evaluate((c) => {
    const r = c.getBoundingClientRect();
    return Array.from(c.querySelectorAll(".badge"))
      .filter((b) => {
        const x = b.getBoundingClientRect();
        return x.left < r.left || x.right > r.right || x.top < r.top || x.bottom > r.bottom || b.scrollWidth > b.clientWidth;
      })
      .map((b) => b.textContent);
  });
  expect(clipped).toEqual([]);
  await page.locator(".grid-wrap").screenshot({ path: `${SHOTS}/f15-grid-long-status.png` });
  expect(errors).toEqual([]);
});

test("autopilot is a switch and the threshold a pill input, both reachable by keyboard", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/#token=e2e-token");
  await expect(page.locator("#status")).toHaveText("API online");
  const sw = page.getByRole("switch", { name: "Autopilot" });
  const th = page.getByLabel("Threshold");

  await expect(sw).toHaveCSS("appearance", "none"); // not the browser's checkbox
  const track = (await sw.boundingBox())!;
  expect(track.width).toBeGreaterThan(track.height * 1.5);
  await expect(th).toHaveCSS("border-top-left-radius", "999px");
  await expect(th).toHaveCSS("appearance", "textfield"); // no spinner arrows

  // the switch is the first stop in the page; Space flips it and the setting is saved
  await page.keyboard.press("Tab");
  await expect(sw).toBeFocused();
  await expect(sw).toHaveCSS("outline-color", "rgb(245, 158, 11)");
  await expect(sw).toHaveCSS("outline-width", "3px");
  await page.keyboard.press("Space");
  await expect(sw).toBeChecked();
  await expect.poll(async () => (await page.request.get("/api/autopilot")).json()).toEqual({ enabled: true, threshold: 85 });
  await expect(sw).toHaveCSS("background-color", "rgb(67, 56, 202)"); // on: the indigo accent
  await page.keyboard.press("Space");
  await expect(sw).not.toBeChecked();
  await expect(sw).toHaveCSS("background-color", "rgb(213, 217, 226)"); // off: a quiet grey track

  await page.keyboard.press("Tab");
  await expect(th).toBeFocused();
  await expect(th).toHaveCSS("outline-color", "rgb(245, 158, 11)");
  expect(errors).toEqual([]);
});

test("Escape closes the panel after Submit evidence, and focus lands on the result", async ({ page, request }) => {
  const errors = watchErrors(page);
  const id = await waitingCase(request);
  await page.goto("/#token=e2e-token");
  const detail = await openCase(page, id);
  await detail.getByRole("button", { name: "Submit evidence" }).click();
  await expect(detail.getByText("Demo mode: nothing was sent to PayPal")).toBeVisible();
  await expect(detail.locator("#submit-result .banner")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();
  expect(errors).toEqual([]);
});

test("the phone header is short, never runs off the side, and its main button is full width", async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize(MOBILE);
  await page.goto("/#token=e2e-token");
  await expect(page.locator("#status")).toHaveText("API online");
  const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(scroll).toBe(client);

  const header = page.locator("header.top");
  const box = (await header.boundingBox())!;
  expect(box.height).toBeLessThan(PHONE_HEADER_BEFORE);
  const inner = await header.evaluate((el) => {
    const s = getComputedStyle(el);
    return el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
  });
  const cta = (await page.locator("#simulate-btn").boundingBox())!;
  expect(cta.width).toBeGreaterThanOrEqual(inner - 1);
  for (const control of headerControls(page)) await expect(control).toBeInViewport();
  await page.screenshot({ path: `${SHOTS}/f15-header-mobile.png` });
  expect(errors).toEqual([]);
});

test("a bad threshold is marked invalid with a hint, and cleared when fixed", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/#token=e2e-token");
  await expect(page.locator("#status")).toHaveText("API online");
  const th = page.getByLabel("Threshold");
  const hint = page.locator("#autopilot-error");
  await expect(th).toHaveAttribute("aria-describedby", "autopilot-error");

  for (const bad of ["150", "-3", "", "7.5"]) {
    await th.fill(bad);
    await expect(th).toHaveAttribute("aria-invalid", "true");
    await expect(hint).toBeVisible();
    await expect(hint).toContainText("0 to 100");
  }
  await page.screenshot({ path: `${SHOTS}/f15-threshold-invalid.png`, clip: { x: 0, y: 0, width: DESKTOP.width, height: 140 } });
  await th.fill("70");
  await expect(th).not.toHaveAttribute("aria-invalid", "true");
  await expect(hint).toBeHidden();
  await th.blur();
  await expect.poll(async () => (await page.request.get("/api/autopilot")).json()).toEqual({ enabled: false, threshold: 70 });
  expect(unexpected(errors, [422])).toEqual([]);
});

test.describe("without a stored token", () => {
  test.use({ extraHTTPHeaders: {} }); // act like a stranger: only the page's own token is sent

  test("a new #token in the address bar is used without a reload", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/#token=not-the-token");
    const gate = page.getByRole("heading", { name: "Operator token needed" });
    await expect(gate).toBeVisible();
    await page.evaluate(() => ((window as unknown as { marker: number }).marker = 1));

    const sent = page.waitForRequest((r) => r.url().endsWith("/api/disputes") && r.headers()["authorization"] === "Bearer e2e-token");
    await page.evaluate(() => (location.hash = "token=e2e-token"));
    await sent;
    await expect(gate).toBeHidden();
    await expect(page.locator("#status")).toHaveText("API online");
    expect(await page.evaluate(() => location.hash)).toBe("");
    expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(1); // same page, no reload
    expect(unexpected(errors, [401])).toEqual([]);
  });
});

test("a toast says what the autopilot did with a new chargeback", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/#token=e2e-token");
  await expect(page.locator("#status")).toHaveText("API online");
  const sw = page.getByRole("switch", { name: "Autopilot" });
  const toast = page.locator("#toast");
  const simulate = async () => {
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/demo/chargeback")),
      page.locator("#simulate-btn").click(),
    ]);
    return ((await res.json()) as Row).id;
  };

  await sw.check();
  await expect.poll(async () => (await page.request.get("/api/autopilot")).json()).toEqual({ enabled: true, threshold: 85 });
  const sent = await simulate();
  await expect(toast).toContainText(`Autopilot submitted evidence for ${sent}`);
  await page.screenshot({ path: `${SHOTS}/f15-toast-submitted.png` });
  await toast.getByRole("button", { name: "Dismiss" }).click();

  // off: a 100% case has nothing wrong with it, so it is not flagged and no flag toast cries wolf
  await sw.uncheck();
  await expect.poll(async () => (await page.request.get("/api/autopilot")).json()).toEqual({ enabled: false, threshold: 85 });
  const waiting = await simulate();
  await expect
    .poll(async () => ((await (await page.request.get(`/api/disputes/${waiting}/audit`)).json()) as { action: string }[]).map((a) => a.action))
    .toContain("autopilot_awaiting");
  await page.waitForResponse((r) => r.url().endsWith("/api/disputes")); // a poll after the autopilot finished
  const row = page.locator(`.ag-row[row-id="${waiting}"]`);
  await expect(row.locator('[col-id="status"] .badge')).toHaveText(["Open"]);
  await expect(toast).not.toContainText("flagged");
  expect(errors).toEqual([]);
});

test("Simulate chargeback shows progress while the receipt is read, and comes back after", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/#token=e2e-token");
  await expect(page.locator("#status")).toHaveText("API online");
  const btn = page.locator("#simulate-btn");

  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/demo/chargeback", async (r) => {
    await held;
    await r.continue();
  });
  await btn.click();
  await expect(btn).toBeDisabled();
  await expect(btn).toHaveText("Reading the receipt…");
  await expect(btn).toHaveAttribute("aria-busy", "true");
  await expect(btn.locator(".spinner")).toBeVisible();
  await page.locator("header.top").screenshot({ path: `${SHOTS}/f15-simulate-busy.png` });
  release();
  await expect(btn).toHaveText("Simulate chargeback");
  await expect(btn).toBeEnabled();
  await expect(btn).not.toHaveAttribute("aria-busy", "true");

  // a failure brings the button back too, and says so
  await page.unroute("**/api/demo/chargeback");
  await page.route("**/api/demo/chargeback", (r) => r.fulfill({ status: 500, json: { detail: "boom" } }));
  await btn.click();
  await expect(page.locator("#toast")).toContainText("Could not create the demo chargeback");
  await expect(btn).toHaveText("Simulate chargeback");
  await expect(btn).toBeEnabled();
  expect(unexpected(errors, [500])).toEqual([]);
});

test("the accept confirm button stays on one line", async ({ page, request }) => {
  const errors = watchErrors(page);
  const id = await weakCase(request);
  await page.goto("/#token=e2e-token");
  const detail = await openCase(page, id);
  await detail.getByRole("button", { name: "Accept claim" }).click();
  const yes = detail.locator("#accept-yes");
  const cancel = detail.getByRole("button", { name: "Cancel" });
  await expect(yes).toBeVisible();
  await expect(yes).toContainText("$49.90");
  // the row stretches both buttons to the taller one, so count the label's lines as well as compare heights
  const lines = () =>
    yes.evaluate((el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      return new Set(Array.from(r.getClientRects()).map((x) => Math.round(x.bottom))).size;
    });
  for (const size of [DESKTOP, MOBILE]) {
    await page.setViewportSize(size);
    expect(await lines()).toBe(1);
    const [y, c] = [(await yes.boundingBox())!, (await cancel.boundingBox())!];
    expect(y.height).toBe(c.height);
    expect(y.height).toBeLessThan(52); // a single-line .btn-row button is 12 + 22 + 12 + borders
  }
  await page.setViewportSize(DESKTOP);
  await page.screenshot({ path: `${SHOTS}/f15-accept-confirm.png` });
  expect(errors).toEqual([]);
});
