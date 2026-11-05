import { expect, test, type Page } from "@playwright/test";

const SHOTS = "e2e/screenshots";
const AUTH = { Authorization: "Bearer e2e-token" };

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

type Box = { left: number; right: number; top: number; bottom: number };

async function box(page: Page, selector: string): Promise<Box> {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`no box for ${selector}`);
  return { left: b.x, right: b.x + b.width, top: b.y, bottom: b.y + b.height };
}

async function openFirstRow(page: Page): Promise<string> {
  const row = page.locator(".ag-row").first();
  await expect(row).toBeVisible();
  const id = (await row.getAttribute("row-id"))!;
  await row.locator('[col-id="reason"]').click();
  await expect(page.getByRole("dialog", { name: `Dispute ${id}` })).toBeVisible();
  return id;
}

for (const [w, h] of [[1440, 1200], [1280, 900], [1100, 900]] as const) {
  test(`${w}x${h}: with a case open the four KPI cards sit fully left of the panel`, async ({ page, request }) => {
    const errors = watchErrors(page);
    await page.setViewportSize({ width: w, height: h });
    await request.post("/api/demo/seed", { headers: AUTH });
    await page.goto("/#token=e2e-token");
    await expect(page.locator("#kpi-link")).toBeVisible();
    await openFirstRow(page);
    const panel = await box(page, ".detail:not([hidden])");

    const cards = page.locator(".kpis .kpi");
    await expect(cards).toHaveCount(4);
    for (let i = 0; i < 4; i++) {
      const b = (await cards.nth(i).boundingBox())!;
      const right = b.x + b.width;
      expect(right, `card ${i} right edge`).toBeLessThanOrEqual(panel.left - 16 + 1);
      expect(b.x, `card ${i} left`).toBeGreaterThanOrEqual(0);
      expect(right, `card ${i} inside viewport`).toBeLessThanOrEqual(w);
      expect(b.y + b.height, `card ${i} bottom`).toBeLessThanOrEqual(h);
    }
    // nothing on a card is cut off: big numbers, the money list and the deadline button all fit their card
    const clipped = await page.evaluate(() => {
      const bad: string[] = [];
      document.querySelectorAll<HTMLElement>(".kpis .kpi").forEach((card, i) => {
        const cr = card.getBoundingClientRect();
        card.querySelectorAll<HTMLElement>(".kpi-value, .kpi-amount, .kpi-money, .kpi-money li, .kpi-link, .kpi-label").forEach((el) => {
          if (el.offsetParent === null) return;
          const r = el.getBoundingClientRect();
          if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).display !== "inline") bad.push(`card ${i} ${el.className} scroll ${el.scrollWidth}>${el.clientWidth}`);
          if (r.right > cr.right + 1 || r.left < cr.left - 1) bad.push(`card ${i} ${el.className} outside card`);
        });
      });
      return bad;
    });
    expect(clipped).toEqual([]);
    const tops = new Set<number>();
    for (let i = 0; i < 4; i++) tops.add(Math.round((await cards.nth(i).boundingBox())!.y));
    expect(tops.size, "two rows of cards").toBe(2);
    await page.screenshot({ path: `${SHOTS}/f29-panel-${w}.png` });
    expect(errors).toEqual([]);
  });
}

test("1440: the Next deadline button opens its case while the panel is open, and Close puts the cards back in one row", async ({ page, request }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1440, height: 1200 });
  await request.post("/api/demo/seed", { headers: AUTH });
  await page.goto("/#token=e2e-token");
  const link = page.locator("#kpi-link");
  await expect(link).toBeVisible();
  const dueId = (await link.getAttribute("data-id"))!;
  // open some other case first, so the click has to switch the panel
  const other = page.locator(`.ag-row:not([row-id="${dueId}"])`).first();
  await other.locator('[col-id="reason"]').click();
  const otherId = (await other.getAttribute("row-id"))!;
  await expect(page.getByRole("dialog", { name: `Dispute ${otherId}` })).toBeVisible();
  await link.click();
  const sheet = page.getByRole("dialog", { name: `Dispute ${dueId}` });
  await expect(sheet).toBeVisible();

  await sheet.getByRole("button", { name: "Close" }).first().click();
  await expect(page.locator(".detail:not([hidden])")).toHaveCount(0);
  const cards = page.locator(".kpis .kpi");
  const tops = new Set<number>();
  for (let i = 0; i < 4; i++) tops.add(Math.round((await cards.nth(i).boundingBox())!.y));
  expect(tops.size, "one row of cards").toBe(1);
  await page.screenshot({ path: `${SHOTS}/f29-closed-1440.png` });
  expect(errors).toEqual([]);
});

test("375: the phone layout is unchanged, 2x2 cards and a full-screen panel", async ({ page, request }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await request.post("/api/demo/seed", { headers: AUTH });
  await page.goto("/#token=e2e-token");
  const cards = page.locator(".kpis .kpi");
  await expect(cards).toHaveCount(4);
  const boxes = [] as { x: number; y: number; width: number }[];
  for (let i = 0; i < 4; i++) boxes.push((await cards.nth(i).boundingBox())!);
  expect(Math.round(boxes[0].y)).toBe(Math.round(boxes[1].y));
  expect(Math.round(boxes[2].y)).toBe(Math.round(boxes[3].y));
  expect(boxes[2].y).toBeGreaterThan(boxes[0].y);
  for (const b of boxes) expect(b.x + b.width).toBeLessThanOrEqual(375);
  const card = page.locator("#cards .case-card").first();
  await card.scrollIntoViewIfNeeded();
  await card.click();
  const panel = (await page.locator(".detail:not([hidden])").boundingBox())!;
  expect(Math.round(panel.width)).toBe(375);
});
