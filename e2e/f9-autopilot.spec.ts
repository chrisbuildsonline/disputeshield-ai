import { expect, test, type Page } from "@playwright/test";

const SHOTS = "e2e/screenshots";

test.use({ viewport: { width: 1280, height: 1250 } });

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

// the setting lives in the shared database, so leave it off for the other specs whatever happens here
test.afterEach(async ({ request }) => {
  await request.put("/api/autopilot", { data: { enabled: false, threshold: 85 } });
});

async function simulate(page: Page): Promise<string> {
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/demo/chargeback")),
    page.getByRole("button", { name: "Simulate chargeback" }).click(),
  ]);
  return ((await res.json()) as { id: string }).id;
}

test("autopilot sends a chargeback on its own, and flags the next one when switched off", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/#token=e2e-token");
  const toggle = page.getByRole("switch", { name: "Autopilot" });
  const threshold = page.getByLabel("Threshold");
  await expect(toggle).not.toBeChecked();
  await expect(threshold).toHaveValue("85");

  // on: the new chargeback is submitted without a click on Submit
  await toggle.check();
  await expect.poll(async () => (await page.request.get("/api/autopilot")).json()).toEqual({ enabled: true, threshold: 85 });
  const sentId = await simulate(page);
  const sent = page.locator(`.ag-row[row-id="${sentId}"]`);
  await expect(sent.locator('[col-id="status"]')).toHaveText("Under review");
  await expect(sent).toHaveClass(/row-submitted/);
  const detail = page.getByRole("dialog", { name: `Dispute ${sentId}` });
  await sent.locator('[col-id="reason"]').click();
  await expect(detail).toBeVisible();
  await expect(detail.getByText("Autopilot started")).toBeVisible();
  await expect(detail.getByText(/Autopilot scored the case 94% \(threshold 85%\)/)).toBeVisible();
  await expect(detail.getByText("Autopilot submitted the evidence")).toBeVisible();
  await expect(detail.getByText("Evidence submitted (demo mode, not sent to PayPal)")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/f9-autopilot-on.png` });
  await detail.getByRole("button", { name: /Close/ }).click();

  // off: the next one is flagged, not sent
  await toggle.uncheck();
  await expect.poll(async () => (await page.request.get("/api/autopilot")).json()).toEqual({ enabled: false, threshold: 85 });
  const flaggedId = await simulate(page);
  const flagged = page.locator(`.ag-row[row-id="${flaggedId}"]`);
  await expect(flagged).toHaveClass(/row-contested/);
  await expect(flagged.getByText("Needs review")).toBeVisible();
  await expect(sent.getByText("Needs review")).toBeHidden();
  await flagged.locator('[col-id="reason"]').click();
  const flaggedDetail = page.getByRole("dialog", { name: `Dispute ${flaggedId}` });
  await expect(flaggedDetail.getByText("Autopilot is off").first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/f9-flagged.png` });

  // a bad threshold is refused and says so
  await threshold.fill("101");
  await threshold.blur();
  await expect(page.getByRole("alert")).toContainText("0 to 100");

  expect(errors.filter((e) => !e.includes("422"))).toEqual([]); // the browser logs the refused PUT itself
});
