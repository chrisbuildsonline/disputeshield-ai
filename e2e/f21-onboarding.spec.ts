import { expect, test, type Page } from "@playwright/test";

const SHOTS = "e2e/screenshots";
const DEMO = { demo_mode: true, demo_token: "e2e-token" };
const OFF = { demo_mode: false, demo_token: null };

// a first-time visitor: no token in the browser, none sent by the test runner
test.use({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: {} });

/** Console errors, page errors and every failed response; plus the protected /api calls the page made. */
function watch(page: Page) {
  const errors: string[] = [];
  const calls: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 400) errors.push(`${r.status()} ${new URL(r.url()).pathname}`);
  });
  page.on("request", (r) => {
    const path = new URL(r.url()).pathname;
    if (path.startsWith("/api/") && path !== "/api/config") calls.push(path);
  });
  return { errors, calls };
}

// only the refused token itself may show up as an error: the 401 and the browser's own line about it
const only401 = (errors: string[]) => errors.filter((e) => !/^401 |status of 401/.test(e));

async function config(page: Page, body: object): Promise<void> {
  await page.route("**/api/config", (r) => r.fulfill({ json: body }));
}

const gate = (page: Page) => page.locator("#token-gate");
const demoBtn = (page: Page) => page.getByRole("button", { name: "Open demo console" });

test("demo mode: the gate leads with one dark pill and nothing protected is called before it", async ({ page }) => {
  const seen = watch(page);
  await config(page, DEMO);
  await page.goto("/");

  await expect(demoBtn(page)).toBeVisible();
  await expect(demoBtn(page)).toHaveClass(/btn-primary/);
  await expect(gate(page).locator(".btn-primary:visible")).toHaveCount(1); // the paste form steps back
  await expect(page.getByRole("button", { name: "Use token" })).not.toHaveClass(/btn-primary/);
  await expect(page.getByLabel("Token", { exact: true })).toBeVisible();
  const note = gate(page).locator(".gate-note");
  await expect(note).toContainText("sandbox only");
  await expect(note).toContainText("anyone who can reach this port");
  await expect(note).toContainText("DISPUTESHIELD_DEMO_MODE=0");
  await expect(page.getByRole("region", { name: "Disputes table" })).toBeHidden();
  await page.screenshot({ path: `${SHOTS}/f21-gate-desktop.png` });

  expect(seen.calls).toEqual([]);
  expect(seen.errors).toEqual([]);

  await demoBtn(page).click();
  await expect(page.locator("#status")).toHaveText("API online");
  await expect(gate(page)).toBeHidden();
  await expect(page.getByRole("region", { name: "Disputes table" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("disputeshield.token"))).toBe("e2e-token");
  await page.reload(); // remembered: straight in, no gate
  await expect(page.locator("#status")).toHaveText("API online");
  await expect(gate(page)).toBeHidden();
  expect(seen.errors).toEqual([]);
});

test("demo mode on a phone: the card fits 375px with the pill in reach", async ({ page }) => {
  const seen = watch(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await config(page, DEMO);
  await page.goto("/");
  await expect(demoBtn(page)).toBeVisible();
  const card = await gate(page).boundingBox();
  expect(card).not.toBeNull();
  expect(card!.x).toBeGreaterThanOrEqual(8);
  expect(card!.x + card!.width).toBeLessThanOrEqual(375 - 8);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375); // no sideways scroll
  await page.screenshot({ path: `${SHOTS}/f21-gate-phone.png`, fullPage: true });
  expect(seen.calls).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test("demo mode off: the paste form is the primary action and there is no demo button", async ({ page }) => {
  const seen = watch(page);
  await config(page, OFF);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Operator token needed" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Use token" })).toHaveClass(/btn-primary/);
  await expect(demoBtn(page)).toHaveCount(0);
  await expect(gate(page).locator(".gate-note")).toBeHidden();
  await page.screenshot({ path: `${SHOTS}/f21-gate-off.png` });
  expect(seen.calls).toEqual([]);
  expect(seen.errors).toEqual([]);

  await page.getByLabel("Token", { exact: true }).fill("e2e-token");
  await page.getByRole("button", { name: "Use token" }).click();
  await expect(page.locator("#status")).toHaveText("API online");
  expect(seen.errors).toEqual([]);
});

test("a bad link token is refused out loud, and demo mode still offers its button", async ({ page }) => {
  const seen = watch(page);
  await config(page, DEMO);
  await page.goto("/#token=not-the-token");
  await expect(page.getByRole("alert").filter({ hasText: "That token was not accepted." })).toBeVisible();
  expect(page.url()).not.toContain("token=");
  await expect(demoBtn(page)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/f21-gate-refused.png` });

  await demoBtn(page).click();
  await expect(page.locator("#status")).toHaveText("API online");
  await expect(page.getByRole("region", { name: "Disputes table" })).toBeVisible();
  expect(only401(seen.errors)).toEqual([]);
});

test("a bad pasted token is refused out loud with demo mode off", async ({ page }) => {
  const seen = watch(page);
  await config(page, OFF);
  await page.goto("/#token=not-the-token");
  await expect(page.getByRole("alert").filter({ hasText: "That token was not accepted." })).toBeVisible();
  await expect(demoBtn(page)).toHaveCount(0);

  await page.getByLabel("Token", { exact: true }).fill("still-wrong");
  await page.getByRole("button", { name: "Use token" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "That token was not accepted." })).toBeVisible();
  expect(only401(seen.errors)).toEqual([]);
});

test("the real /api/config of a demo server opens the console in one click", async ({ page }) => {
  const seen = watch(page);
  await page.goto("/");
  await expect(demoBtn(page)).toBeVisible();
  expect(seen.calls).toEqual([]);
  await demoBtn(page).click();
  await expect(page.locator("#status")).toHaveText("API online");
  await expect(page.getByRole("region", { name: "Disputes table" })).toBeVisible();
  expect(seen.errors).toEqual([]);
});
