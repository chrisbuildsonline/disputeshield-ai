import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

// The e2e server runs with DISPUTESHIELD_LLM=off: no model answers, and a PDF made here has no recorded read, so the
// upload is read by the text parser. That is the honest badge this spec expects ("Text parser"), never a fake live one.
const SHOTS = "e2e/screenshots";
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 375, height: 812 };
const PARSER_TITLE = "No model answered, so the text parser read this PDF";

test.use({ viewport: DESKTOP });

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

// the browser logs every refused request itself; only what a test provokes on purpose is allowed
const unexpected = (errors: string[], allowed: RegExp[]) => errors.filter((e) => !allowed.some((a) => a.test(e)));

/** A small, valid one-page PDF with these lines of text, made fresh so no recorded read can match its bytes. */
function makePdf(lines: string[]): Buffer {
  const text = lines.map((l) => `(${l.replace(/[\\()]/g, (c) => `\\${c}`)}) Tj T*`).join("\n");
  const content = `BT\n/F1 12 Tf\n16 TL\n72 740 Td\n${text}\nET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const stamp = () => Date.now().toString(36).toUpperCase();

function receipt(tag: string): { pdf: Buffer; tracking: string; order: string } {
  const tracking = `1Z${`F22${tag}${stamp()}`.replace(/[^0-9A-Z]/g, "").padEnd(16, "7").slice(0, 16)}`;
  const order = `F22-${stamp()}`;
  const pdf = makePdf([
    "Harbour Goods Ltd - shipping receipt",
    "Carrier: UPS",
    `Tracking Number: ${tracking}`,
    "Status: Delivered",
    "Delivered: 2026-10-20 15:42:00",
    "Delivered To: 9 Harbour Road, Bristol BS1 5TT",
    `Order ID: ${order}`,
    "Total: USD 64.00",
  ]);
  return { pdf, tracking, order };
}

/** A webhook dispute with no documents yet: the grid shows no win chance until one is added. */
async function bareCase(request: APIRequestContext, tag: string): Promise<string> {
  const id = `PP-D-F22${tag}${stamp()}`;
  const res = await request.post("/api/webhooks/paypal", {
    data: {
      id: `WH-${id}`,
      event_type: "CUSTOMER.DISPUTE.CREATED",
      resource: {
        dispute_id: id,
        reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
        status: "WAITING_FOR_SELLER_RESPONSE",
        dispute_amount: { currency_code: "USD", value: "64.00" },
        seller_response_due_date: new Date(Date.now() + 120 * 3600 * 1000).toISOString(),
      },
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  made.push(id);
  return id;
}

// the cases stay in the shared database: close them, or they crowd the open rows and push later specs' new cases
// (the autopilot spec's simulated one is due in 144-168 h) below the grid's rendered rows
const made: string[] = [];
test.afterEach(async ({ request }) => {
  for (const id of made.splice(0)) {
    const res = await request.post("/api/webhooks/paypal", {
      data: {
        id: `WH-${id}-closed`,
        event_type: "CUSTOMER.DISPUTE.RESOLVED",
        resource: {
          dispute_id: id,
          reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
          status: "RESOLVED",
          dispute_outcome: { outcome_code: "RESOLVED_SELLER_FAVOUR" },
          dispute_amount: { currency_code: "USD", value: "64.00" },
        },
      },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
  }
});

async function openCase(page: Page, id: string): Promise<Locator> {
  const cell = page.locator(`.ag-row[row-id="${id}"] [col-id="reason"]`);
  await cell.scrollIntoViewIfNeeded();
  await cell.click();
  const panel = page.getByRole("dialog", { name: `Dispute ${id}` });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Extracted evidence" })).toBeVisible();
  return panel;
}

const addBtn = (panel: Locator) => panel.getByRole("button", { name: "Add evidence" });
const fileInput = (panel: Locator) => panel.locator('input[type="file"]');
const cards = (panel: Locator) => panel.locator("#h-evidence ~ .card");

// the setting lives in the shared database: off, so a new case is scored and left for a person
test.beforeEach(async ({ request }) => {
  await request.put("/api/autopilot", { data: { enabled: false, threshold: 85 } });
});

test("an unseen PDF added through the file picker is read, scored and shown without a reload", async ({ page, request }) => {
  const errors = watchErrors(page);
  const id = await bareCase(request, "A");
  const { pdf, tracking, order } = receipt("A");
  await page.goto("/#token=e2e-token");
  await page.evaluate(() => ((window as unknown as { f22Mark: number }).f22Mark = 1)); // gone if the page reloads
  const row = page.locator(`.ag-row[row-id="${id}"]`);
  await expect(row.locator('[col-id="win"]')).toHaveText("—");

  const panel = await openCase(page, id);
  // the empty state invites the upload, and the control is a real, keyboard-reachable button
  const section = panel.locator("section", { has: page.locator("#h-evidence") });
  await expect(section.getByText("No documents uploaded yet.")).toBeVisible();
  await expect(section).toContainText(/drop/i);
  await expect(addBtn(panel)).toBeVisible();
  await expect(addBtn(panel)).toBeEnabled();
  const input = fileInput(panel);
  await expect(input).toHaveAttribute("accept", "application/pdf");
  await expect(input).toBeHidden(); // visually hidden: the pill is what you see and focus
  await addBtn(panel).focus();
  await expect(addBtn(panel)).toBeFocused();
  await page.locator(".toast-close").click({ timeout: 1000 }).catch(() => {});
  await section.evaluate((s) => s.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: `${SHOTS}/f22-desktop-empty.png` });
  const before = (await panel.locator(".score-num").textContent())?.trim();

  // slow the upload down a little so the busy state can be seen
  await page.route("**/api/disputes/*/documents?*", async (route) => {
    await new Promise((r) => setTimeout(r, 700));
    await route.continue();
  });
  await input.setInputFiles({ name: "harbour receipt.pdf", mimeType: "application/pdf", buffer: pdf });
  const busy = panel.locator('button[aria-busy="true"]');
  await expect(busy).toBeVisible();
  await expect(busy).toBeDisabled();
  await expect(busy).toContainText(/Reading/);

  // the new card, read by the text parser (no model in the e2e run), with the facts from this PDF
  await expect(cards(panel)).toHaveCount(1, { timeout: 15000 });
  const card = cards(panel).first();
  await expect(card).toContainText("harbour receipt.pdf");
  await expect(card.getByText(tracking, { exact: true })).toBeVisible();
  await expect(card.getByText(order, { exact: true })).toBeVisible();
  const badge = card.locator(".card-head .badge");
  await expect(badge).toHaveText("Text parser");
  await expect(badge).toHaveAttribute("title", PARSER_TITLE);
  await expect(panel.getByText("Regex fallback")).toHaveCount(0);
  await expect(addBtn(panel)).toBeEnabled(); // the busy state is over and the button is back for a second file

  // the score in the panel moved, and the grid row and the phone card say the same number, no reload
  const after = panel.locator(".score-num");
  await expect(after).toHaveText(/^\d+%$/);
  const pct = (await after.textContent())!.trim();
  expect(pct).not.toBe(before);
  await expect(row.locator('[col-id="win"]')).toHaveText(pct);
  await expect(page.locator(`#cards .case-card[data-id="${id}"] .cc-win`)).toContainText(pct);
  expect(await page.evaluate(() => (window as unknown as { f22Mark?: number }).f22Mark)).toBe(1);
  await expect(panel.getByText("Document added: harbour receipt.pdf")).toBeVisible();

  await page.locator(".toast-close").click({ timeout: 1000 }).catch(() => {});
  await section.evaluate((s) => s.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: `${SHOTS}/f22-desktop-added.png` });
  expect(errors).toEqual([]);
});

test("a second PDF dropped on the evidence area joins the first, with a visible drop state", async ({ page, request }) => {
  const errors = watchErrors(page);
  const id = await bareCase(request, "D");
  const first = receipt("D1");
  const up = await request.post(`/api/disputes/${id}/documents?name=first.pdf`, { data: first.pdf, headers: { "content-type": "application/pdf" } });
  expect(up.ok(), await up.text()).toBeTruthy();
  await page.goto("/#token=e2e-token");
  const panel = await openCase(page, id);
  await expect(cards(panel)).toHaveCount(1);

  const second = makePdf(["Order export", `Order ID: F22-DROP-${stamp()}`, "Customer Message: thanks, it arrived fine", "Total: USD 64.00"]);
  const zone = panel.locator("[data-drop]");
  await expect(zone).toBeVisible();
  const dt = await page.evaluateHandle((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const t = new DataTransfer();
    t.items.add(new File([bytes], "order export.pdf", { type: "application/pdf" }));
    return t;
  }, second.toString("base64"));
  await zone.dispatchEvent("dragenter", { dataTransfer: dt });
  await zone.dispatchEvent("dragover", { dataTransfer: dt });
  await expect(zone).toHaveClass(/is-over/);
  await page.locator(".toast-close").click({ timeout: 1000 }).catch(() => {});
  await zone.evaluate((z) => z.scrollIntoView({ block: "center" }));
  await page.screenshot({ path: `${SHOTS}/f22-desktop-dragover.png` });
  await zone.dispatchEvent("drop", { dataTransfer: dt });
  await expect(zone).not.toHaveClass(/is-over/);

  await expect(cards(panel)).toHaveCount(2, { timeout: 15000 });
  await expect(cards(panel).filter({ hasText: "order export.pdf" })).toHaveCount(1); // the name is also in the dossier list and the audit trail
  await expect(panel.getByText("thanks, it arrived fine")).toBeVisible();
  expect(errors).toEqual([]);
});

test("a file that isn't a PDF, a server refusal and a lost connection each show a plain bad banner", async ({ page, request }) => {
  const errors = watchErrors(page);
  const id = await bareCase(request, "B");
  await page.goto("/#token=e2e-token");
  const panel = await openCase(page, id);
  const input = fileInput(panel);
  const bad = panel.locator("#h-evidence ~ .banner-bad"); // not the "Needs review" banner, which a good upload can legitimately raise

  // text bytes named .pdf: refused in the browser, nothing is sent
  let posts = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/documents")) posts += 1;
  });
  await input.setInputFiles({ name: "notes.pdf", mimeType: "application/pdf", buffer: Buffer.from("just some notes, not a receipt\n") });
  await expect(bad).toBeVisible();
  await expect(bad).toContainText("That file isn't a PDF.");
  expect(posts).toBe(0);
  await expect(cards(panel)).toHaveCount(0);
  await page.locator(".toast-close").click({ timeout: 1000 }).catch(() => {});
  await bad.evaluate((b) => b.scrollIntoView({ block: "center" }));
  await page.screenshot({ path: `${SHOTS}/f22-desktop-error.png` });

  // the server's own refusal, made human
  await page.route("**/api/disputes/*/documents?*", (route) =>
    route.fulfill({ status: 422, json: { detail: "file larger than the 10 MB limit: 'big.pdf'" } }),
  );
  await input.setInputFiles({ name: "big.pdf", mimeType: "application/pdf", buffer: receipt("B").pdf });
  await expect(bad).toContainText("That PDF is over the 10 MB limit.");
  await expect(bad).not.toContainText("isn't a PDF");

  // a lost connection
  await page.unroute("**/api/disputes/*/documents?*");
  await page.route("**/api/disputes/*/documents?*", (route) => route.abort("failed"));
  await input.setInputFiles({ name: "again.pdf", mimeType: "application/pdf", buffer: receipt("C").pdf });
  await expect(bad).toContainText("Could not reach the server");
  await expect(addBtn(panel)).toBeEnabled();
  await expect(cards(panel)).toHaveCount(0);

  // the next good file clears the banner
  await page.unroute("**/api/disputes/*/documents?*");
  await input.setInputFiles({ name: "good.pdf", mimeType: "application/pdf", buffer: receipt("E").pdf });
  await expect(cards(panel)).toHaveCount(1, { timeout: 15000 });
  await expect(bad).toHaveCount(0);
  expect(unexpected(errors, [/status of 422/, /net::ERR_FAILED/])).toEqual([]);
});

test.describe("phone", () => {
  test.use({ viewport: MOBILE, isMobile: true, hasTouch: true });

  test("the Add evidence pill is full width and an upload works at 375px", async ({ page, request }) => {
    const errors = watchErrors(page);
    const id = await bareCase(request, "P");
    const { pdf, tracking } = receipt("P");
    await page.goto("/#token=e2e-token");
    const card = page.locator(`#cards .case-card[data-id="${id}"]`);
    await card.scrollIntoViewIfNeeded();
    await card.tap();
    const panel = page.getByRole("dialog", { name: `Dispute ${id}` });
    await expect(panel).toBeVisible();
    const btn = addBtn(panel);
    await btn.scrollIntoViewIfNeeded();
    await expect(btn).toBeVisible();

    // full width of the panel body's content, and a real thumb target
    const body = (await panel.locator(".detail-body").boundingBox())!;
    const b = (await btn.boundingBox())!;
    expect(b.width).toBeGreaterThanOrEqual(body.width - 2 * 22 - 34); // the body's padding plus the drop zone's own
    expect(b.height).toBeGreaterThanOrEqual(44);
    expect(await panel.locator(".detail-body").evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    await panel.locator("#h-evidence").evaluate((h) => h.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: `${SHOTS}/f22-phone-empty.png` });

    await fileInput(panel).setInputFiles({ name: "phone receipt.pdf", mimeType: "application/pdf", buffer: pdf });
    await expect(cards(panel)).toHaveCount(1, { timeout: 15000 });
    await expect(panel.getByText(tracking, { exact: true })).toBeVisible();
    await expect(cards(panel).first().locator(".card-head .badge")).toHaveText("Text parser");
    const pct = (await panel.locator(".score-num").textContent())!.trim();
    await panel.locator("#h-evidence").evaluate((h) => h.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: `${SHOTS}/f22-phone-added.png` });

    // back on the list, the case card carries the new win chance
    await panel.getByRole("button", { name: /Close/ }).tap();
    await expect(card.locator(".cc-win")).toContainText(pct);
    expect(errors).toEqual([]);
  });
});
