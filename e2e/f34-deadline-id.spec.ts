import { expect, test, type Page } from "@playwright/test";

const SHOTS = "e2e/screenshots";
const AUTH = { Authorization: "Bearer e2e-token" };

async function deadlineLine(page: Page) {
  return page.evaluate(() => {
    const foot = document.querySelector<HTMLElement>("#kpi-link .kpi-foot")!;
    const id = document.querySelector<HTMLElement>("#kpi-link-id")!;
    return {
      scroll: foot.scrollWidth,
      client: foot.clientWidth,
      idScroll: id.scrollWidth,
      idClient: id.clientWidth,
      text: foot.innerText,
      fontPx: parseFloat(getComputedStyle(foot).fontSize),
    };
  });
}

async function seeded(page: Page, request: any, w: number, h: number) {
  await page.setViewportSize({ width: w, height: h });
  await request.post("/api/demo/seed", { headers: AUTH });
  await page.goto("/#token=e2e-token");
  const link = page.locator("#kpi-link");
  await expect(link).toBeVisible();
  return (await link.getAttribute("data-id"))!;
}

for (const [w, h] of [[1100, 900], [1280, 900], [1440, 1200]] as const) {
  test(`${w}: next deadline shows the full case id with a case open`, async ({ page, request }) => {
    const dueId = await seeded(page, request, w, h);
    const other = page.locator(`.ag-row:not([row-id="${dueId}"])`).first();
    await other.locator('[col-id="reason"]').click();
    await expect(page.locator(".detail:not([hidden])")).toBeVisible();
    const d = await deadlineLine(page);
    expect(d.text).toContain(dueId);
    expect(d.scroll, "reason line overflow").toBeLessThanOrEqual(d.client + 1);
    expect(d.idScroll, "id overflow").toBeLessThanOrEqual(d.idClient + 1);
    expect(d.fontPx).toBeGreaterThanOrEqual(12);
    const cards = page.locator(".kpis .kpi");
    const heights = new Set<number>();
    for (let i = 0; i < 2; i++) heights.add(Math.round((await cards.nth(i + 2).boundingBox())!.height));
    expect(heights.size, "bottom row cards align").toBe(1);
    await page.screenshot({ path: `${SHOTS}/f34-deadline-${w}.png` });
  });
}

for (const [w, h] of [[1440, 1200], [375, 812]] as const) {
  test(`${w}: panel closed, the deadline line is not cut off`, async ({ page, request }) => {
    const dueId = await seeded(page, request, w, h);
    await expect(page.locator(".detail:not([hidden])")).toHaveCount(0);
    const d = await deadlineLine(page);
    expect(d.text).toContain(dueId);
    expect(d.scroll).toBeLessThanOrEqual(d.client + 1);
    expect(d.idScroll).toBeLessThanOrEqual(d.idClient + 1);
  });
}

test("375: the phone id is whole, on one line, no page overflow", async ({ page, request }) => {
  const dueId = await seeded(page, request, 375, 812);
  const m = await page.evaluate(() => {
    const id = document.querySelector<HTMLElement>("#kpi-link-id")!;
    const cs = getComputedStyle(id);
    const de = document.documentElement;
    return {
      text: id.textContent!.trim(),
      idScroll: id.scrollWidth,
      idClient: id.clientWidth,
      height: id.getBoundingClientRect().height,
      lineHeight: parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5,
      ws: cs.whiteSpace,
      fontPx: parseFloat(cs.fontSize),
      pageScroll: de.scrollWidth,
      pageClient: de.clientWidth,
    };
  });
  expect(m.text).toBe(dueId);
  expect(m.idScroll, "id ellipsized").toBeLessThanOrEqual(m.idClient);
  expect(m.ws).toBe("nowrap");
  expect(m.height, "one line").toBeLessThanOrEqual(m.lineHeight + 1);
  expect(m.fontPx).toBeGreaterThanOrEqual(12);
  expect(m.pageScroll, "page overflow").toBeLessThanOrEqual(m.pageClient);
  await page.screenshot({ path: `${SHOTS}/f35-deadline-375.png` });
});
