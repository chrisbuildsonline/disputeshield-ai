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

test("autopilot sends a chargeback on its own, and leaves the next one for review when switched off", async ({ page }) => {
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
  await expect(sent.locator('[col-id="status"]')).toHaveText("Under review", { timeout: 15000 }); // the grid repaints on its next poll
  await expect(sent).toHaveClass(/row-submitted/);
  const detail = page.getByRole("dialog", { name: `Dispute ${sentId}` });
  await sent.locator('[col-id="reason"]').click();
  await expect(detail).toBeVisible();
  await expect(detail.getByText("Autopilot started")).toBeVisible();
  await expect(detail.getByText(/Autopilot scored the case 100% \(threshold 85%\)/)).toBeVisible();
  await expect(detail.getByText("Autopilot submitted the evidence")).toBeVisible();
  await expect(detail.getByText("Evidence submitted (demo mode, not sent to PayPal)")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/f9-autopilot-on.png` });
  await detail.getByRole("button", { name: /Close/ }).click();

  // off: the next one is scored and left open for a person; it scores 100%, so nothing flags it
  await toggle.uncheck();
  await expect.poll(async () => (await page.request.get("/api/autopilot")).json()).toEqual({ enabled: false, threshold: 85 });
  const waitingId = await simulate(page);
  const waiting = page.locator(`.ag-row[row-id="${waitingId}"]`);
  await expect(waiting).toHaveClass(/row-contested/);
  await waiting.locator('[col-id="reason"]').click();
  const waitingDetail = page.getByRole("dialog", { name: `Dispute ${waitingId}` });
  await expect(waitingDetail.getByText("Auto-check: scored 100%, waiting for your review")).toBeVisible();
  await expect(waitingDetail.getByRole("button", { name: "Submit evidence" })).toBeEnabled(); // not sent
  await expect(waitingDetail.locator("#detail-flag .banner")).toHaveCount(0);
  await expect(waiting.getByText("Needs review")).toHaveCount(0);
  await expect(sent.getByText("Needs review")).toBeHidden();
  await page.screenshot({ path: `${SHOTS}/f9-awaiting.png` });

  // a bad threshold is refused and says so
  await threshold.fill("101");
  await threshold.blur();
  await expect(page.getByRole("alert")).toContainText("0 to 100");

  expect(errors.filter((e) => !e.includes("422"))).toEqual([]); // the browser logs the refused PUT itself
});
