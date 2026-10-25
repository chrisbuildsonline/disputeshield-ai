import { expect, test, type Page } from "@playwright/test";

const SHOTS = "e2e/screenshots";

test.use({ viewport: { width: 1280, height: 1250 } }); // tall enough that the screenshots show the whole detail panel

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

test("simulate a chargeback, review the evidence and submit it", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "DisputeShield AI" })).toBeVisible();
  await expect(page.getByText("Demo mode", { exact: true })).toBeVisible();
  await expect(page.getByText("No disputes yet")).toBeVisible();

  // simulate: the new row appears, red, 94%, selected
  await page.getByRole("button", { name: "Simulate chargeback" }).click();
  const rows = page.locator(".ag-row[row-id]");
  const row = rows.first();
  await expect(row).toBeVisible();
  await expect(row).toHaveClass(/row-contested/);
  await expect(row).toHaveClass(/ag-row-selected/);
  await expect(row.locator('[col-id="win"]')).toHaveText("94%");
  await expect(row.locator('[col-id="source"]')).toHaveText("Simulated");
  await expect(row.locator('[col-id="amount"]')).toHaveText("$49.90");
  await expect(row.locator('[col-id="due"]')).toContainText(/\dd \d+h left/);
  await expect(page.getByText("No disputes yet")).toBeHidden();
  const id = (await row.locator('[col-id="id"]').textContent())?.trim() ?? "";
  expect(id).toMatch(/^PP-D-/);
  await page.screenshot({ path: `${SHOTS}/f8-grid.png` });

  // open by click
  const detail = page.getByRole("dialog", { name: `Dispute ${id}` });
  await row.locator('[col-id="reason"]').click();
  await expect(detail).toBeVisible();
  await expect(detail.getByRole("heading", { name: "Extracted evidence" })).toBeVisible();
  await expect(detail.getByText("1Z999AA10123456784", { exact: true })).toBeVisible();
  await expect(detail.getByText("Regex fallback")).toBeVisible();
  await expect(detail.getByRole("heading", { name: "Win probability" })).toBeVisible();
  await expect(detail.getByLabel("Win probability 94 percent")).toBeVisible();
  await expect(detail.getByText("Delivered to the billing address", { exact: true })).toBeVisible();
  await expect(detail.getByText("Order ID on file", { exact: true })).toBeVisible();
  await expect(detail.getByRole("heading", { name: "Dossier preview" })).toBeVisible();
  await expect(detail.getByText("It was shipped with UPS under tracking number 1Z999AA10123456784")).toBeVisible();
  await expect(detail.getByText("Template", { exact: true })).toBeVisible();
  await expect(detail.getByText("Chargeback received (simulated)")).toBeVisible();
  await expect(detail.getByText("Document added: ups_receipt.pdf")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/f8-detail.png` });

  // Escape closes it and focus goes back to the grid
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();
  await expect(row.locator('[col-id="id"]')).toBeFocused();

  // open again by keyboard: Enter on the focused row
  await page.keyboard.press("Enter");
  await expect(detail).toBeVisible();
  await expect(detail).toBeFocused();
  await expect(detail.getByText("1Z999AA10123456784", { exact: true })).toBeVisible();

  // submit
  const submit = detail.getByRole("button", { name: "Submit evidence" });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(detail.getByText("Demo mode: nothing was sent to PayPal")).toBeVisible();
  await expect(detail.getByText(/Status: Under review/)).toBeVisible();
  await expect(detail.getByRole("button", { name: "Evidence submitted" })).toBeDisabled();
  await expect(detail.getByText("Evidence submitted (demo mode, not sent to PayPal)")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/f8-submitted.png` });

  // the grid follows: status changes and the row is no longer red
  await detail.getByRole("button", { name: /Close/ }).click();
  await expect(row).not.toHaveClass(/row-contested/);
  await expect(row).toHaveClass(/row-submitted/);
  await expect(row.locator('[col-id="status"]')).toHaveText("Under review");

  // simulating again gives a second, separate dispute
  await page.getByRole("button", { name: "Simulate chargeback" }).click();
  await expect(rows).toHaveCount(2);
  await expect(page.locator(".ag-row.row-contested")).toHaveCount(1);

  expect(errors).toEqual([]);
});
