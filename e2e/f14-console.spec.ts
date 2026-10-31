import { expect, test, type APIRequestContext, type Page, type Route } from "@playwright/test";

const SHOTS = "e2e/screenshots";
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 375, height: 812 };
const EMPTY_SUMMARY = { open_count: 0, at_risk: [], avg_win: null, next_deadline: null };

test.use({ viewport: DESKTOP });
test.describe.configure({ mode: "serial" }); // the later tests work on the five cases the second one seeds

interface Row {
  id: string;
  status: string | null;
  outcome: string | null;
  currency: string | null;
  amount_value: string | null;
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

/** Earlier specs share this database: settle what they left open, so the seeded five are the only open cases. */
async function closeOpen(request: APIRequestContext): Promise<void> {
  const all = (await (await request.get("/api/disputes")).json()) as Row[];
  for (const d of all) {
    if (!d.outcome && (d.status === "OPEN" || d.status === "WAITING_FOR_SELLER_RESPONSE")) {
      await request.post(`/api/disputes/${d.id}/accept`);
    }
  }
  const s = await (await request.get("/api/summary")).json();
  expect(s.open_count).toBe(0);
}

/** The browser sees an empty database while `state.empty` is true; everything else goes to the real server. */
async function fakeEmpty(page: Page, state: { empty: boolean }): Promise<void> {
  const list = (r: Route) => (state.empty && r.request().method() === "GET" ? r.fulfill({ json: [] }) : r.continue());
  await page.route("**/api/disputes", list);
  await page.route("**/api/summary", (r) => (state.empty ? r.fulfill({ json: EMPTY_SUMMARY }) : r.continue()));
}

const kpi = (page: Page, name: string) => page.locator(`#kpis [data-kpi="${name}"]`);

let seeded: Row[] = [];
const seededBy = (currency: string, value: string) => seeded.find((d) => d.currency === currency && d.amount_value === value)!;

test("an empty database shows a designed empty state, not the grid's own", async ({ page }) => {
  const errors = watchErrors(page);
  await fakeEmpty(page, { empty: true });
  await page.goto("/#token=e2e-token");
  await expect(page.locator("#status")).toHaveText("API online");

  const empty = page.locator("#empty");
  await expect(empty).toBeVisible();
  await expect(empty.getByRole("heading", { name: "No disputes yet" })).toBeVisible();
  await expect(page.getByText("No Rows To Show")).toHaveCount(0);
  await expect(page.locator("#grid-loading")).toBeHidden();

  const first = empty.getByRole("button", { name: "Simulate your first chargeback" });
  const sample = empty.getByRole("button", { name: "Load sample disputes" });
  await expect(first).toBeVisible();
  await expect(first).toHaveCSS("background-color", "rgb(17, 24, 39)"); // the near-black pill
  await expect(sample).toBeVisible();
  await expect(sample).toHaveCSS("background-color", "rgb(255, 255, 255)");
  // one dark pill on the screen: the header's Simulate steps back while the empty state offers it
  await expect(page.locator("header").getByRole("button", { name: "Simulate chargeback" })).toHaveCSS("background-color", "rgb(255, 255, 255)");

  await expect(page.getByRole("heading", { name: "Disputes", exact: true })).toBeVisible();
  await expect(kpi(page, "open").locator(".kpi-value")).toHaveText("0");
  await expect(kpi(page, "risk").locator(".kpi-value")).toHaveText("—");
  await expect(kpi(page, "win").locator(".kpi-value")).toHaveText("—");
  await expect(kpi(page, "deadline").locator(".kpi-value")).toHaveText("—");
  await page.screenshot({ path: `${SHOTS}/f14-empty.png` });

  // the dark pill runs the existing walkthrough route (the next test settles the case it opens)
  const created = page.waitForResponse((r) => r.url().endsWith("/api/demo/chargeback") && r.request().method() === "POST");
  await first.click();
  expect((await created).ok()).toBeTruthy();
  expect(errors).toEqual([]);
});

test("sample disputes fill the grid and the KPI strip", async ({ page, request }) => {
  const errors = watchErrors(page);
  await closeOpen(request);
  const state = { empty: true };
  await fakeEmpty(page, state);
  await page.goto("/#token=e2e-token");
  const sample = page.locator("#empty").getByRole("button", { name: "Load sample disputes" });
  await expect(sample).toBeVisible();

  state.empty = false;
  const seed = page.waitForResponse((r) => r.url().endsWith("/api/demo/seed") && r.request().method() === "POST");
  await sample.click();
  const res = await seed;
  expect(res.ok()).toBeTruthy();
  seeded = ((await res.json()) as { disputes: Row[] }).disputes;
  expect(seeded).toHaveLength(5);
  await expect(page.locator("#empty")).toBeHidden();

  // five open rows, each in its own currency and with its own score
  await expect(page.locator(".ag-row.row-contested")).toHaveCount(5);
  // the colour band is the backend's recommendation band: >= 60 fight (green), 30-59 offer (amber), < 30 accept (red)
  const expected: [string, string, string, string, string, string][] = [
    ["USD", "49.90", "$49.90", "94%", "fight", "green"],
    ["EUR", "128.00", "€128.00", "79%", "fight", "green"],
    ["NOK", "1299.00", "NOK 1,299.00", "55%", "offer", "amber"],
    ["GBP", "86.40", "£86.40", "44%", "offer", "amber"],
    ["EUR", "312.50", "€312.50", "25%", "accept", "red"],
  ];
  for (const [currency, value, amount, win, band, tone] of expected) {
    const row = page.locator(`.ag-row[row-id="${seededBy(currency, value).id}"]`);
    await expect(row.locator('[col-id="amount"]')).toHaveText(amount);
    await expect(row.locator('[col-id="win"]')).toHaveText(win);
    await expect(row.locator('[col-id="win"] .win')).toHaveAttribute("data-band", band);
    await expect(row.locator('[col-id="win"] .badge')).toHaveClass(new RegExp(`badge-${tone}`));
  }
  await expect(page.locator(`.ag-row[row-id="${seededBy("NOK", "1299.00").id}"] [col-id="due"] .badge-red`)).toBeVisible();

  // the KPI strip says what /api/summary says
  const summary = await (await request.get("/api/summary")).json();
  expect(summary.open_count).toBe(5);
  expect(summary.avg_win).toBe(59);
  expect(summary.next_deadline.dispute_id).toBe(seededBy("NOK", "1299.00").id);
  await expect(kpi(page, "open").locator(".kpi-value")).toHaveText("5");
  await expect(kpi(page, "open").locator(".badge-red")).toHaveText("1 due in 48 h");
  const risk = kpi(page, "risk");
  for (const m of ["€440.50", "£86.40", "NOK 1,299.00", "$49.90"]) await expect(risk).toContainText(m);
  await expect(kpi(page, "win").locator(".kpi-value")).toHaveText("59%");
  await expect(page.locator("#kpi-win-bar")).toHaveAttribute("data-band", "offer");
  const due = kpi(page, "deadline");
  const pill = due.locator(".badge");
  await expect(pill).toHaveText(/^Due in 29 h$/); // 30 h from now, counted down to the whole hour like the row
  await expect(pill).toHaveClass(/badge-red/);
  await expect(due).toContainText("NOK 1,299.00");
  await page.screenshot({ path: `${SHOTS}/f14-desktop.png` });

  // the deadline card opens that case
  const osloId = seededBy("NOK", "1299.00").id;
  await due.getByRole("button").click();
  const detail = page.getByRole("dialog", { name: `Dispute ${osloId}` });
  await expect(detail).toBeVisible();
  await expect(detail.locator(".score-bar span")).toHaveAttribute("data-band", "offer"); // 55%: the panel uses the same bands
  await detail.getByRole("button", { name: /Close/ }).click();
  await expect(detail).toBeHidden();

  // a phone: the strip is a 2x2 block that never runs off the side
  await page.setViewportSize(MOBILE);
  for (const name of ["open", "risk", "win", "deadline"]) {
    const box = (await kpi(page, name).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(MOBILE.width);
  }
  const strip = await page.locator("#kpis").evaluate((el) => [el.scrollWidth, el.clientWidth]);
  expect(strip[0]).toBeLessThanOrEqual(strip[1]);
  await page.locator("#kpis").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/f14-mobile.png` });
  expect(errors).toEqual([]);
});

test("the KPI strip follows an action at once", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/#token=e2e-token");
  await expect(kpi(page, "open").locator(".kpi-value")).toHaveText("5");

  const madrid = seededBy("EUR", "312.50");
  await page.locator(`.ag-row[row-id="${madrid.id}"] [col-id="reason"]`).click();
  const detail = page.getByRole("dialog", { name: `Dispute ${madrid.id}` });
  await expect(detail.getByRole("heading", { name: "Win probability" })).toBeVisible();
  await detail.getByRole("button", { name: "Accept claim" }).click();
  await detail.getByRole("button", { name: /^Yes, accept and refund/ }).click();
  await expect(detail.getByRole("button", { name: "Claim accepted" })).toBeVisible();

  // sooner than the 3 s poll: the action itself refreshes the strip
  await expect(kpi(page, "open").locator(".kpi-value")).toHaveText("4", { timeout: 2500 });
  await expect(kpi(page, "win").locator(".kpi-value")).toHaveText("68%", { timeout: 2500 });
  await expect(kpi(page, "risk")).not.toContainText("€440.50");
  await expect(kpi(page, "risk")).toContainText("€128.00");
  expect(errors).toEqual([]);
});

test("a loading overlay shows while the list is in flight, never an empty grid", async ({ page }) => {
  const errors = watchErrors(page);
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/disputes", async (r) => {
    await held;
    await r.continue();
  });
  await page.goto("/#token=e2e-token");
  const overlay = page.locator("#grid-loading");
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText("Loading disputes");
  await expect(page.locator("#empty")).toBeHidden();
  await expect(page.getByText("No Rows To Show")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/f14-loading.png` });

  release();
  await expect(overlay).toBeHidden();
  await expect(page.locator(".ag-row.row-contested")).toHaveCount(4);
  expect(errors).toEqual([]);
});
