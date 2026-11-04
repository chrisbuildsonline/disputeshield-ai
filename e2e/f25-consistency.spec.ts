import { readFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const SHOTS = "e2e/screenshots";
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 375, height: 812 };
const DEMO = { demo_mode: true, demo_token: "e2e-token" };

test.use({ viewport: DESKTOP });

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
  const id = `PP-D-F25${tag}${Date.now().toString(36).toUpperCase()}`;
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

async function openCase(page: Page, id: string) {
  if (page.viewportSize()!.width <= 700) {
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
  return sheet;
}

/** What the grid row (desktop) or the card (phone) shows for this case's win chance. */
async function listWin(page: Page, id: string): Promise<string> {
  const where =
    page.viewportSize()!.width <= 700
      ? page.locator(`#cards .case-card[data-id="${id}"] .cc-win`)
      : page.locator(`.ag-row[row-id="${id}"] [col-id="win"]`);
  return (await where.innerText()).replace(/Win chance/i, "").replace(/\s+/g, "").trim();
}

for (const [name, size] of [["desktop", DESKTOP], ["phone", MOBILE]] as const) {
  test(`${name}: the sheet shows the same win chance as the list, a dash with no documents`, async ({ page, request }) => {
    const errors = watchErrors(page);
    await page.setViewportSize(size);
    const id = await bareCase(request, name === "phone" ? "P" : "D");
    await page.goto("/#token=e2e-token");
    await expect(page.locator(name === "phone" ? "#cards .case-card" : ".ag-row").first()).toBeVisible();
    expect(await listWin(page, id)).toBe("—");

    const sheet = await openCase(page, id);
    const score = sheet.locator(".score");
    await expect(score.locator(".score-num")).toHaveText("—");
    await expect(score).toContainText("Upload evidence to score");
    await expect(sheet.locator(".score-bar")).toHaveCount(0);
    await expect(sheet.locator(".score-num", { hasText: "%" })).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/f25-sheet-dash-${size.width}.png` });
    await sheet.getByRole("button", { name: /Close/ }).click();

    // once evidence is in, one number everywhere
    const pdf = readFileSync("samples/ups_receipt.pdf");
    const up = await request.post(`/api/disputes/${id}/documents?name=ups_receipt.pdf`, { data: pdf, headers: { "content-type": "application/pdf" } });
    expect(up.ok(), await up.text()).toBeTruthy();
    await page.reload();
    await expect(page.locator(name === "phone" ? "#cards .case-card" : ".ag-row").first()).toBeVisible();
    await expect.poll(() => listWin(page, id)).toMatch(/^\d+%$/); // the cell fills in just after the row appears
    const listed = await listWin(page, id);
    const sheet2 = await openCase(page, id);
    await expect(sheet2.locator(".score-num")).toHaveText(listed);
    await page.screenshot({ path: `${SHOTS}/f25-sheet-scored-${size.width}.png` });
    expect(errors).toEqual([]);
  });

  test(`${name}: the gate is titled "Open the operator console", with the token path below`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.context().setExtraHTTPHeaders({});
    await page.route("**/api/config", (r) => r.fulfill({ json: DEMO }));
    await page.goto("/");
    const gate = page.locator("#token-gate");
    await expect(gate.getByRole("heading", { name: "Open the operator console", level: 2 })).toBeVisible();
    await expect(gate.getByText("No operator token needed")).toHaveCount(0);
    await expect(gate.locator(".gate-lede")).toHaveText("The operator console for PayPal chargebacks: each case scored from its evidence, ready to send.");
    await expect(gate.getByText("every case scored", { exact: false })).toHaveCount(0);
    const demo = gate.getByRole("button", { name: "Open demo console" });
    await expect(demo).toBeVisible();
    await expect(demo).toHaveClass(/btn-primary/);
    const have = gate.getByRole("heading", { name: "Have an operator token?" });
    await expect(have).toBeVisible();
    const [a, b] = [await demo.boundingBox(), await have.boundingBox()];
    expect(b!.y).toBeGreaterThan(a!.y);
    await page.screenshot({ path: `${SHOTS}/f25-gate-${size.width}.png` });
  });
}

test("phone: money at risk is one total plus +N currencies, and the deadline reason wraps", async ({ page, request }) => {
  const errors = watchErrors(page);
  await page.setViewportSize(MOBILE);
  await request.put("/api/autopilot", { data: { enabled: false, threshold: 85 } });
  const summary = (await (await request.get("/api/summary")).json()) as { at_risk: unknown[] };
  while (summary.at_risk.length < 2) {
    expect((await request.post("/api/demo/seed")).ok()).toBeTruthy();
    summary.at_risk = ((await (await request.get("/api/summary")).json()) as { at_risk: unknown[] }).at_risk;
  }
  await page.goto("/#token=e2e-token");
  const risk = page.locator('[data-kpi="risk"]');
  await expect(page.locator("#kpi-risk li:visible")).toHaveCount(1);
  const more = page.locator("#kpi-more");
  await expect(more).toBeVisible();
  await expect(more.locator("summary")).toHaveText(new RegExp(`^\\+${summary.at_risk.length - 1} currenc(y|ies)$`));
  await expect(more.locator("li")).toHaveCount(summary.at_risk.length - 1);
  await expect(more.locator("li").first()).toBeHidden();
  const main = await page.locator("#kpi-risk li:visible").evaluate((n) => parseFloat(getComputedStyle(n).fontSize));
  expect(main).toBeGreaterThanOrEqual(24);
  await more.locator("summary").click();
  await expect(more.locator("li").first()).toBeVisible();
  await more.locator("summary").click();
  await expect(more.locator("li").first()).toBeHidden();

  const reason = page.locator("#kpi-link-reason");
  await expect(reason).toBeVisible();
  const foot = reason.locator("..");
  expect(await foot.evaluate((n) => getComputedStyle(n).whiteSpace)).not.toBe("nowrap");
  expect(await foot.evaluate((n) => n.scrollWidth <= n.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await risk.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/f25-kpis-375.png` });
  expect(errors).toEqual([]);
});

test("desktop: the KPI strip still lists every currency, with no fold", async ({ page, request }) => {
  await request.put("/api/autopilot", { data: { enabled: false, threshold: 85 } });
  const s = (await (await request.get("/api/summary")).json()) as { at_risk: unknown[] };
  if (s.at_risk.length < 2) expect((await request.post("/api/demo/seed")).ok()).toBeTruthy();
  const n = ((await (await request.get("/api/summary")).json()) as { at_risk: unknown[] }).at_risk.length;
  await page.goto("/#token=e2e-token");
  await expect(page.locator("#kpi-risk li:visible")).toHaveCount(n);
  await expect(page.locator("#kpi-more")).toBeHidden();
  await page.screenshot({ path: `${SHOTS}/f25-kpis-1440.png` });
});

// ---- review round 2 ----

test("the KPI deadline pill counts down in the same words as the grid and the phone card", async ({ page, request }) => {
  await bareCase(request, "T");
  const id = ((await (await request.get("/api/summary")).json()) as { next_deadline: { dispute_id: string } }).next_deadline.dispute_id;
  await page.goto("/#token=e2e-token");
  const pill = page.locator("#kpi-due-pill .badge");
  const gridText = async () => (await page.locator(`.ag-row[row-id="${id}"] [col-id="due"] .two-line > :first-child`).innerText()).trim();
  await expect(pill).toHaveText(/left$/);
  expect((await pill.innerText()).trim()).toBe(await gridText());
  await page.setViewportSize(MOBILE);
  const card = page.locator(`#cards .case-card[data-id="${id}"] .cc-due .two-line > :first-child`);
  await expect(card).toBeVisible();
  expect((await pill.innerText()).trim()).toBe((await card.innerText()).trim());
  await expect(pill).not.toContainText("Due in");
});

test("phone: the dispute id in the deadline card never breaks, and the money foot does not repeat itself", async ({ page, request }) => {
  await page.setViewportSize(MOBILE);
  await bareCase(request, "W");
  let s = (await (await request.get("/api/summary")).json()) as { at_risk: unknown[]; next_deadline: { dispute_id: string } };
  if (s.at_risk.length < 2) {
    expect((await request.post("/api/demo/seed")).ok()).toBeTruthy();
    s = (await (await request.get("/api/summary")).json()) as typeof s;
  }
  const id = s.next_deadline.dispute_id;
  await page.goto("/#token=e2e-token");
  const idEl = page.locator("#kpi-link-id");
  await expect(idEl).toHaveText(id);
  expect(await idEl.evaluate((n) => n.getClientRects().length)).toBe(1);
  expect(await idEl.evaluate((n) => getComputedStyle(n).whiteSpace)).toBe("nowrap");
  await expect(page.locator("#kpi-risk-foot")).toHaveText("open cases only", { useInnerText: true });
  await page.setViewportSize(DESKTOP);
  await expect(page.locator("#kpi-risk-foot")).toHaveText(/^in \d+ currenc(y|ies), open cases only$/);
});

test("the unscored sheet reads as one block: a big muted dash with the hint under it", async ({ page, request }) => {
  const id = await bareCase(request, "B");
  await page.goto("/#token=e2e-token");
  const sheet = await openCase(page, id);
  const num = sheet.locator(".score-num");
  const hint = sheet.locator(".score-hint");
  await expect(num).toHaveText("—");
  const style = await num.evaluate((n) => ({ size: getComputedStyle(n).fontSize, weight: getComputedStyle(n).fontWeight }));
  expect(style).toEqual({ size: "40px", weight: "800" });
  const [a, b] = [await num.boundingBox(), await hint.boundingBox()];
  expect(b!.y).toBeGreaterThanOrEqual(a!.y + a!.height - 4);
  expect(b!.x - a!.x).toBeLessThan(24);
  expect(a!.width).toBeLessThan(200);
  await page.screenshot({ path: `${SHOTS}/f25-sheet-dash-1440.png` });
});

test("the page subtitle does not claim every case is scored", async ({ page }) => {
  await page.goto("/#token=e2e-token");
  const sub = page.locator("#page-sub");
  await expect(sub).toContainText("Open cases first, then by due date.");
  await expect(sub).not.toContainText("Every one is scored");
});
