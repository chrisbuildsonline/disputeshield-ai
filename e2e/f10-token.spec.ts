import { expect, test, type Page } from "@playwright/test";

const SHOTS = "e2e/screenshots";
const TOKEN = "e2e-token";

test.use({ viewport: { width: 1280, height: 800 }, extraHTTPHeaders: {} }); // act like a stranger: no token unless the page has one

// the browser logs every refused request itself; those 401s are the only errors allowed
const REFUSED = /^Failed to load resource: the server responded with a status of 401/;

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

const unexpected = (errors: string[]) => errors.filter((e) => !REFUSED.test(e.replace(/^(error|warning): /, "")));

test("a link with the token opens the grid and drops the token from the address bar", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto(`/#token=${TOKEN}`);
  await expect(page.locator("#status")).toHaveText("API online");
  await expect(page.getByRole("heading", { name: "Operator token needed" })).toBeHidden();
  await expect(page.getByRole("region", { name: "Disputes table" })).toBeVisible();
  expect(page.url()).not.toContain("token=");
  expect(await page.evaluate(() => location.hash)).toBe("");

  await page.reload(); // the token is remembered
  await expect(page.locator("#status")).toHaveText("API online");
  expect(errors).toEqual([]);
});

test("without a token the page asks for it, and pasting it brings the grid back", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/");
  const heading = page.getByRole("heading", { name: "Operator token needed" });
  await expect(heading).toBeVisible();
  await expect(page.getByText("The server prints a link with the token when it starts.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Disputes table" })).toBeHidden(); // no broken grid behind it
  await expect(page.locator("#status")).toHaveText("Operator token needed");
  await page.screenshot({ path: `${SHOTS}/f10-token.png` });

  await page.getByLabel("Token", { exact: true }).fill(TOKEN);
  await page.getByRole("button", { name: "Use token" }).click();
  await expect(heading).toBeHidden();
  await expect(page.locator("#status")).toHaveText("API online");

  await page.getByRole("button", { name: "Simulate chargeback" }).click();
  await expect(page.locator(".ag-row[row-id]").first()).toBeVisible();
  expect(unexpected(errors)).toEqual([]);
});

test("a wrong token is refused and the page says so", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/#token=not-the-token");
  const heading = page.getByRole("heading", { name: "Operator token needed" });
  await expect(heading).toBeVisible();
  expect(page.url()).not.toContain("token=");

  await page.getByLabel("Token", { exact: true }).fill("still-wrong");
  await page.getByRole("button", { name: "Use token" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "That token was not accepted." })).toBeVisible();
  await expect(heading).toBeVisible();
  expect(unexpected(errors)).toEqual([]);
});
