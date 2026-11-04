import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

const SHOTS = "e2e/screenshots";
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 375, height: 812 };

test.use({ viewport: DESKTOP }); // the tests share the five sample cases the first one to run loads (seedOnce)

interface Row {
  id: string;
  status: string | null;
  outcome: string | null;
  currency: string | null;
  amount_value: string | null;
  seller_response_due_date: string | null;
  review_reasons: string[] | null;
}

interface AuditRow {
  action: string;
  detail: Record<string, unknown>;
}

type Box = { x: number; y: number; width: number; height: number };

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

const list = async (request: APIRequestContext) => (await (await request.get("/api/disputes")).json()) as Row[];
const audit = async (request: APIRequestContext, id: string) => (await (await request.get(`/api/disputes/${id}/audit`)).json()) as AuditRow[];
const isOpen = (d: Row) => !d.outcome && (d.status === "OPEN" || d.status === "WAITING_FOR_SELLER_RESPONSE");

// the setting lives in the shared database, so leave it off for the other specs whatever happens here
test.afterEach(async ({ request }) => {
  await request.put("/api/autopilot", { data: { enabled: false, threshold: 85 } });
});

let seeded: Row[] = [];
const seededBy = (currency: string, value: string) => seeded.find((d) => d.currency === currency && d.amount_value === value)!;

/**
 * Earlier specs share this database: settle what they left open, then load the five samples with autopilot off
 * (threshold 85), and wait until the autopilot has looked at each one. 100% waits for review; the rest are flagged.
 */
async function seedOnce(request: APIRequestContext): Promise<void> {
  if (seeded.length) return;
  for (const d of await list(request)) if (isOpen(d)) await request.post(`/api/disputes/${d.id}/accept`);
  await request.put("/api/autopilot", { data: { enabled: false, threshold: 85 } });
  const res = await request.post("/api/demo/seed");
  expect(res.ok()).toBeTruthy();
  seeded = ((await res.json()) as { disputes: Row[] }).disputes;
  expect(seeded).toHaveLength(5);
  for (const d of seeded) {
    await expect
      .poll(async () => (await audit(request, d.id)).some((a) => a.action === "autopilot_awaiting" || a.action === "autopilot_flagged"))
      .toBe(true);
  }
}

/** The ids the grid shows, top to bottom (the grid only draws the rows near its scroll position). */
const gridOrder = (page: Page) =>
  page.locator("#grid").evaluate((grid) => {
    const seen = new Map<string, number>();
    for (const r of Array.from(grid.querySelectorAll(".ag-row[row-id][row-index]")))
      seen.set(r.getAttribute("row-id")!, Number(r.getAttribute("row-index")));
    return [...seen.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  });

async function openCase(page: Page, id: string): Promise<Locator> {
  if (page.viewportSize()!.width <= 700) {
    // a phone lists the cases as cards: tap the case's card
    const card = page.locator(`#cards .case-card[data-id="${id}"]`);
    await card.scrollIntoViewIfNeeded();
    await card.click();
  } else await openRow(page, id);
  const detail = page.getByRole("dialog", { name: `Dispute ${id}` });
  await expect(detail.getByRole("heading", { name: "Win probability" })).toBeVisible();
  await expect(detail.locator(".audit li").first()).toBeVisible();
  return detail;
}

async function openRow(page: Page, id: string): Promise<void> {
  await expect
    .poll(() =>
      page.locator("#grid").evaluate((grid, id) => {
        const rows = Array.from(grid.querySelectorAll(".ag-row[row-id]"));
        let v = rows[0]?.parentElement ?? null;
        while (v && v !== grid && !(v.scrollHeight > v.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(v).overflowY)))
          v = v.parentElement;
        const box = (v ?? grid).getBoundingClientRect();
        const shown = rows.filter((r) => {
          const b = r.getBoundingClientRect();
          return b.bottom > box.top && b.top < box.bottom;
        });
        if (shown.some((r) => r.getAttribute("row-id") === id)) return true;
        if (shown.length && v && v !== grid) v.scrollBy(0, v.clientHeight - 56);
        return false;
      }, id),
    )
    .toBe(true);
  await page.locator(`.ag-row[row-id="${id}"] [col-id="reason"]`).click();
}

test("the audit trail says the auto-check is waiting, and only real flags show Needs review", async ({ page, request }) => {
  const errors = watchErrors(page);
  await seedOnce(request);
  const walkthrough = seededBy("USD", "49.90"); // 100%: nothing wrong, it waits for the operator
  const lisbon = seededBy("EUR", "128.00"); // 79%: below the 85% threshold

  await page.goto("/#token=e2e-token");
  const waiting = await openCase(page, walkthrough.id);
  await expect(waiting.locator(".audit li", { hasText: "Auto-check: scored 100%, waiting for your review" })).toBeVisible();
  await expect(waiting.locator("#detail-flag .banner")).toHaveCount(0);
  await expect(page.locator(`.ag-row[row-id="${walkthrough.id}"]`).getByText("Needs review")).toHaveCount(0);
  await expect(page.getByText("Waiting for you to review")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/f19-desktop-awaiting.png` });
  await page.setViewportSize(MOBILE);
  await waiting.locator(".audit").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/f19-phone-awaiting.png` });
  await page.setViewportSize(DESKTOP);
  await waiting.getByRole("button", { name: /Close/ }).click();

  const flagged = await openCase(page, lisbon.id);
  const banner = flagged.locator("#detail-flag .banner");
  await expect(banner).toContainText("Needs review");
  await expect(banner).toContainText("Win probability 79% is below the 85% threshold");
  await expect(flagged.locator(".audit li", { hasText: /Waiting for review: Win probability 79% is below the 85% threshold/ })).toBeVisible();
  await expect(flagged.locator(".audit li", { hasText: /flagged for review: Waiting for you to review/ })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/f19-desktop-flagged.png` });
  expect(errors).toEqual([]);
});

test("the grid keeps the server's order: open cases first, then by due date", async ({ page, request }) => {
  const errors = watchErrors(page);
  await seedOnce(request);
  // a closed case: whatever its dates, it goes under every open one
  const closedId = `PP-D-F19C${Date.now().toString(36).toUpperCase()}`;
  const made = await request.post("/api/webhooks/paypal", {
    data: {
      id: `WH-${closedId}`,
      event_type: "CUSTOMER.DISPUTE.CREATED",
      resource: {
        dispute_id: closedId,
        reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
        status: "WAITING_FOR_SELLER_RESPONSE",
        dispute_amount: { currency_code: "USD", value: "12.00" },
        seller_response_due_date: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
      },
    },
  });
  expect(made.ok(), await made.text()).toBeTruthy();
  expect((await request.post(`/api/disputes/${closedId}/accept`)).ok()).toBeTruthy();

  await page.goto("/#token=e2e-token");
  await expect(page.locator("#page-sub")).toContainText("then by due date");
  const api = (await list(request)).map((d) => d.id);
  await expect.poll(async () => (await gridOrder(page)).length).toBeGreaterThan(5);
  const shown = await gridOrder(page);
  expect(shown).toEqual(api.slice(0, shown.length));
  // no column sort of its own on top of the server's order
  await expect(page.locator('.ag-header-cell[aria-sort="ascending"], .ag-header-cell[aria-sort="descending"]')).toHaveCount(0);

  const rows = await list(request);
  const lastOpen = Math.max(...rows.map((d, i) => (isOpen(d) ? i : -1)));
  expect(rows.findIndex((d) => d.id === closedId)).toBeGreaterThan(lastOpen);
  for (const d of seeded) expect(api.indexOf(d.id)).toBeLessThan(api.indexOf(closedId));

  // a new open case, due after the samples' soonest: the next poll puts it where the server does, not at the end
  const lateId = `PP-D-F19L${Date.now().toString(36).toUpperCase()}`;
  const late = await request.post("/api/webhooks/paypal", {
    data: {
      id: `WH-${lateId}`,
      event_type: "CUSTOMER.DISPUTE.CREATED",
      resource: {
        dispute_id: lateId,
        reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
        status: "WAITING_FOR_SELLER_RESPONSE",
        dispute_amount: { currency_code: "USD", value: "10.00" },
        seller_response_due_date: new Date(Date.now() + 40 * 3600 * 1000).toISOString(),
      },
    },
  });
  expect(late.ok(), await late.text()).toBeTruthy();
  await expect(page.locator(`.ag-row[row-id="${lateId}"]`)).toBeVisible();
  const after = (await list(request)).map((d) => d.id);
  expect(after.indexOf(lateId)).toBeLessThan(after.indexOf(closedId));
  await expect.poll(async () => {
    const now = await gridOrder(page);
    return JSON.stringify(now) === JSON.stringify(after.slice(0, now.length));
  }).toBe(true);
  await page.screenshot({ path: `${SHOTS}/f19-grid-order.png` });
  expect(errors).toEqual([]);
});

test("the KPI strip updates in place: the focused next-deadline link keeps its focus across a poll", async ({ page, request }) => {
  const errors = watchErrors(page);
  await seedOnce(request);
  await page.goto("/#token=e2e-token");
  const link = page.locator("#kpis .kpi-link");
  await expect(link).toBeVisible();
  await link.focus();
  await link.evaluate((el) => ((el as HTMLElement & { f19?: number }).f19 = 1));
  // two summary answers after the focus: at least one full poll has repainted the strip
  for (let i = 0; i < 2; i++) await page.waitForResponse((r) => r.url().endsWith("/api/summary"));
  await page.waitForTimeout(200);
  const still = await page.evaluate(() => {
    const a = document.activeElement as (HTMLElement & { f19?: number }) | null;
    return { marker: a?.f19 ?? null, kpiLink: !!a?.classList.contains("kpi-link") };
  });
  expect(still).toEqual({ marker: 1, kpiLink: true });
  await expect(link).toBeFocused();
  await page.locator("#kpis").screenshot({ path: `${SHOTS}/f19-kpi-focus.png` });
  // and it still opens its case
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(errors).toEqual([]);
});

test("one money format: the same amount reads the same in the grid, the KPI strip and the panel", async ({ page, request }) => {
  const errors = watchErrors(page);
  await seedOnce(request);
  const oslo = seededBy("NOK", "1299.00"); // the next deadline (30 h), the only NOK case
  await page.goto("/#token=e2e-token");
  const grid = page.locator(`.ag-row[row-id="${oslo.id}"] [col-id="amount"] .amount`);
  const deadline = page.locator("#kpis .kpi-link .kpi-amount");
  const risk = page.locator("#kpi-risk li", { hasText: "NOK" });
  await expect(grid).toHaveText("NOK 1,299.00");
  await expect(deadline).toHaveText("NOK 1,299.00");
  await expect(risk).toHaveText("NOK 1,299.00");
  // the same parts too: the code and the decimals muted the same way everywhere
  const html = async (l: Locator) => (await l.innerHTML()).trim();
  expect(await html(deadline)).toBe(await html(grid));
  expect(await html(risk)).toBe(await html(grid));

  const panel = await openCase(page, oslo.id);
  await expect(panel.locator("#detail-sub")).toContainText("NOK 1,299.00");
  // the amount read from the receipt is money in the case's currency too, not a bare "1299.00"
  const facts = panel.locator(".facts");
  await expect(facts.locator("dt", { hasText: "Order amount" })).toHaveCount(1);
  await expect(facts.locator("dt:text-is('Order amount') + dd")).toHaveText("NOK 1,299.00");
  await panel.getByRole("button", { name: "Offer refund" }).click();
  await expect(panel.locator("#offer-max")).toContainText("NOK 1,299.00");
  expect(errors).toEqual([]);
});

test("the offer form starts at half for a partial refund and catches a bad amount before sending", async ({ page, request }) => {
  const errors = watchErrors(page);
  await seedOnce(request);
  const oslo = seededBy("NOK", "1299.00"); // 55%: offer a partial refund
  const madrid = seededBy("EUR", "312.50"); // 25%: accept, so an offer starts at the full amount
  const offers: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/offer$/.test(r.url())) offers.push(r.url());
  });
  await page.goto("/#token=e2e-token");

  const accept = await openCase(page, madrid.id);
  await expect(accept.locator(".rec-pill")).toHaveText("Accept");
  await accept.getByRole("button", { name: "Offer refund" }).click();
  await expect(accept.getByLabel("Refund amount")).toHaveValue("312.50");
  await accept.getByRole("button", { name: "Cancel" }).click();
  await accept.getByRole("button", { name: /Close/ }).click();

  const panel = await openCase(page, oslo.id);
  await expect(panel.locator(".rec-pill")).toHaveText("Offer refund");
  await panel.getByRole("button", { name: "Offer refund" }).click();
  const amount = panel.getByLabel("Refund amount");
  await expect(amount).toBeFocused();
  await expect(amount).toHaveValue("649.50"); // half of NOK 1,299.00
  await expect(amount).not.toHaveAttribute("aria-invalid", "true");
  const send = panel.getByRole("button", { name: "Send offer" });
  const message = panel.locator("#offer-error");

  const bad: [string, RegExp][] = [
    ["", /Enter the refund amount/],
    ["0", /more than 0/],
    ["-5", /more than 0/],
    ["1300", /can't be more than NOK\s1,299\.00/], // Intl puts a no-break space after the code
    ["12.345", /two decimals/],
    [".5", /Enter the refund amount as a number, like 25\.00/], // the server wants a digit before the point too
  ];
  for (const [value, says] of bad) {
    await amount.fill(value);
    await send.click();
    await expect(amount).toHaveAttribute("aria-invalid", "true");
    await expect(message).toBeVisible();
    await expect(message).toHaveText(says);
    expect((await amount.getAttribute("aria-describedby"))?.split(" ")).toContain("offer-error");
  }
  // not a number at all: a number box keeps "1e" as bad input and reports an empty value
  await amount.fill("");
  await amount.pressSequentially("1e");
  await send.click();
  await expect(amount).toHaveAttribute("aria-invalid", "true");
  await expect(message).toHaveText(/Enter the refund amount/);
  await expect(panel.locator("#submit-result .banner")).toHaveCount(0); // nothing went to the server, so no server answer
  await page.screenshot({ path: `${SHOTS}/f19-offer-invalid-desktop.png` });
  await page.setViewportSize(MOBILE);
  await expect(message).toBeInViewport();
  await page.screenshot({ path: `${SHOTS}/f19-offer-invalid-phone.png` });
  await page.setViewportSize(DESKTOP);

  // fixing the value clears the mark and the message
  await amount.fill("600");
  await expect(amount).not.toHaveAttribute("aria-invalid", "true");
  await expect(message).toBeHidden();
  expect(offers).toEqual([]);
  expect(errors).toEqual([]); // no refused request (422) in the console either
});

test("with autopilot off, a simulated case answered by hand stops its audit polling", async ({ page, request }) => {
  const errors = watchErrors(page);
  await seedOnce(request);
  await request.put("/api/autopilot", { data: { enabled: false, threshold: 0 } }); // nothing is below 0%: it waits for review
  const audits: string[] = [];
  page.on("request", (r) => {
    const m = /\/api\/disputes\/([^/]+)\/audit$/.exec(r.url());
    if (m) audits.push(decodeURIComponent(m[1]));
  });
  const polls = async (n: number) => {
    for (let i = 0; i < n; i++) await page.waitForResponse((r) => r.url().endsWith("/api/disputes"));
  };
  await page.goto("/#token=e2e-token");
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/demo/chargeback")),
    page.getByRole("button", { name: "Simulate chargeback" }).click(),
  ]);
  const id = ((await res.json()) as Row).id;
  await expect.poll(async () => (await audit(request, id)).some((a) => a.action === "autopilot_awaiting")).toBe(true);
  expect((await request.post(`/api/disputes/${id}/submit`)).ok()).toBeTruthy();
  // the poll that sees it answered reads its audit once
  await expect.poll(() => audits.includes(id), { timeout: 10_000 }).toBe(true);
  await polls(1);
  await page.waitForTimeout(300); // let that poll's audit read go out too
  const seen = audits.filter((a) => a === id).length;
  await polls(3);
  expect(audits.filter((a) => a === id).length).toBe(seen);
  await expect(page.locator(".toast", { hasText: id })).toHaveCount(0); // waiting for review is not a flag: no toast
  expect(errors).toEqual([]);
});

for (const [name, size] of [
  ["phone", MOBILE],
  ["desktop", DESKTOP],
] as const) {
  test(`the Needs review banner never covers the panel content (${name})`, async ({ page, request }) => {
    const errors = watchErrors(page);
    await seedOnce(request);
    const lisbon = seededBy("EUR", "128.00"); // flagged, with an evidence card, a note and an invoice block: a long panel
    await page.setViewportSize(size);
    await page.goto("/#token=e2e-token");
    const panel = await openCase(page, lisbon.id);
    const banner = panel.locator("#detail-flag .banner");
    await expect(banner).toBeVisible();
    expect(await banner.evaluate((b) => [getComputedStyle(b).position, getComputedStyle(b.parentElement!).position])).not.toContain("sticky");

    // the element that scrolls the panel content
    const scroller = panel.locator(".detail-body section").first();
    const scrollBy = (px: number) =>
      scroller.evaluate((s, px) => {
        let v: HTMLElement | null = s.parentElement;
        while (v && !(v.scrollHeight > v.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(v).overflowY))) v = v.parentElement;
        v!.scrollTop += px;
        return v!.scrollTop;
      }, px);
    const before = (await banner.boundingBox())!;
    const moved = await scrollBy(120);
    expect(moved).toBeGreaterThan(0);
    const after = await banner.boundingBox();
    // the banner scrolls away with the content instead of staying put over it
    expect(after === null || after.y < before.y - 100).toBe(true);

    // at every scroll position, nothing visible of a card sits under the banner
    for (const step of [0, 120, 240]) {
      await scrollBy(step === 0 ? -10_000 : 120);
      const b = await banner.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      });
      const hits = await panel.locator(".detail-body .card, .detail-body .rec, .detail-body .score").evaluateAll(
        (cards, b: Box) => {
          const out: string[] = [];
          for (const c of cards) {
            // the part of the card the panel actually shows
            const r = c.getBoundingClientRect();
            let top = r.top;
            let bottom = r.bottom;
            for (let p = c.parentElement; p; p = p.parentElement) {
              if (/auto|scroll|hidden/.test(getComputedStyle(p).overflowY)) {
                const pr = p.getBoundingClientRect();
                top = Math.max(top, pr.top);
                bottom = Math.min(bottom, pr.bottom);
              }
            }
            if (bottom <= top) continue;
            const overlap = r.left < b.x + b.width && b.x < r.right && top < b.y + b.height && b.y < bottom;
            if (overlap) out.push(c.className);
          }
          return out;
        },
        b,
      );
      expect(hits).toEqual([]);
    }
    await scrollBy(-10_000);
    await scrollBy(180);
    await page.screenshot({ path: `${SHOTS}/f19-${name}-review-scrolled.png` });
    expect(errors).toEqual([]);
  });
}
