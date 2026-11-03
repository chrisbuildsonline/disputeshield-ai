import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const SHOTS = "e2e/screenshots";
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 375, height: 812 };

test.use({ viewport: DESKTOP });

interface Row {
  id: string;
  status: string | null;
  outcome: string | null;
  currency: string | null;
  amount_value: string | null;
  win_probability: number | null;
  seller_response_due_date: string | null;
  review_reasons: string[] | null;
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

// the browser logs every refused request itself; only the statuses a test provokes on purpose are allowed
const unexpected = (errors: string[], allowed: number[]) =>
  errors.filter((e) => !allowed.some((s) => e.includes(`Failed to load resource: the server responded with a status of ${s}`)));

const intersects = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const list = async (request: APIRequestContext) => (await (await request.get("/api/disputes")).json()) as Row[];
const isOpen = (d: Row) => !d.outcome && (d.status === "OPEN" || d.status === "WAITING_FOR_SELLER_RESPONSE");

// the setting lives in the shared database, so leave it off for the other specs whatever happens here
test.afterEach(async ({ request }) => {
  await request.put("/api/autopilot", { data: { enabled: false, threshold: 85 } });
});

/** Enough cases that the desktop grid runs to the bottom of its surface (each seed adds the five samples). */
async function enoughRows(request: APIRequestContext, n = 14): Promise<Row[]> {
  await request.put("/api/autopilot", { data: { enabled: false, threshold: 85 } });
  while ((await list(request)).length < n) expect((await request.post("/api/demo/seed")).ok()).toBeTruthy();
  return list(request);
}

/** A webhook dispute, open, due in `hours`: the autopilot (off) scores it and leaves it. */
async function webhookCase(request: APIRequestContext, tag: string, hours: number, value = "10.00"): Promise<string> {
  const id = `PP-D-F20${tag}${Date.now().toString(36).toUpperCase()}`;
  const res = await request.post("/api/webhooks/paypal", {
    data: {
      id: `WH-${id}`,
      event_type: "CUSTOMER.DISPUTE.CREATED",
      resource: {
        dispute_id: id,
        reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
        status: "WAITING_FOR_SELLER_RESPONSE",
        dispute_amount: { currency_code: "USD", value },
        seller_response_due_date: new Date(Date.now() + hours * 3600 * 1000).toISOString(),
      },
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return id;
}

const cards = (page: Page) => page.locator("#cards .case-card");
const cardOrder = (page: Page) => cards(page).evaluateAll((cs) => cs.map((c) => (c as HTMLElement).dataset.id ?? ""));

/** The part of each element its scrolling ancestors actually show. */
function visibleBoxes(els: Element[]): { id: string; box: Box }[] {
  const out: { id: string; box: Box }[] = [];
  for (const el of els) {
    const r = el.getBoundingClientRect();
    let [top, bottom, left, right] = [r.top, r.bottom, r.left, r.right];
    for (let p = el.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (/auto|scroll|hidden|clip/.test(s.overflowY + s.overflowX)) {
        const pr = p.getBoundingClientRect();
        top = Math.max(top, pr.top);
        bottom = Math.min(bottom, pr.bottom);
        left = Math.max(left, pr.left);
        right = Math.min(right, pr.right);
      }
    }
    top = Math.max(top, 0);
    bottom = Math.min(bottom, window.innerHeight);
    if (bottom - top < 1 || right - left < 1) continue;
    out.push({ id: el.getAttribute("row-id") ?? (el as HTMLElement).dataset.id ?? el.className, box: { x: left, y: top, width: right - left, height: bottom - top } });
  }
  return out;
}

/** Every visible column whole inside the grid: no header past its right edge, no sideways scroll. */
const columnsCut = (page: Page) =>
  page.locator("#grid").evaluate((grid) => {
    const out: string[] = [];
    const edge = grid.querySelector(".ag-root-wrapper")!.getBoundingClientRect().right;
    for (const h of Array.from(grid.querySelectorAll<HTMLElement>(".ag-header-cell[col-id]"))) {
      const r = h.getBoundingClientRect();
      if (r.width > 0 && r.right > edge + 0.5) out.push(`${h.getAttribute("col-id")} ends at ${Math.round(r.right)} > ${Math.round(edge)}`);
    }
    const v = grid.querySelector<HTMLElement>(".ag-grid-viewport");
    if (v && v.scrollWidth > v.clientWidth) out.push(`scrolls sideways: ${v.scrollWidth} > ${v.clientWidth}`);
    return out;
  });

/** From the first frame the panel shows, record any header cell past the grid's right edge (columns sliding into place). */
const watchColumns = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { f20Cut: string[]; f20Stop: boolean };
    w.f20Cut = [];
    w.f20Stop = false;
    const grid = document.querySelector("#grid")!;
    const tick = () => {
      if (!document.querySelector<HTMLElement>("#detail")!.hidden) {
        const edge = grid.querySelector(".ag-root-wrapper")!.getBoundingClientRect().right;
        for (const h of Array.from(grid.querySelectorAll<HTMLElement>(".ag-header-cell[col-id]"))) {
          const r = h.getBoundingClientRect();
          if (r.width > 0 && r.right > edge + 0.5) w.f20Cut.push(`${h.getAttribute("col-id")} ${Math.round(r.left)}-${Math.round(r.right)} > ${Math.round(edge)}`);
        }
      }
      if (!w.f20Stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

async function columnsCutWhileOpening(page: Page): Promise<string[]> {
  await page.waitForTimeout(600); // longer than any column animation
  return page.evaluate(() => {
    const w = window as unknown as { f20Cut: string[]; f20Stop: boolean };
    w.f20Stop = true;
    return [...new Set(w.f20Cut)];
  });
}

test("a phone gets a card list: id, amount, status, win % and due, and a tap opens the case", async ({ page, request }) => {
  const errors = watchErrors(page);
  await enoughRows(request, 6);
  const soon = await webhookCase(request, "S", 20, "1299.00"); // due in 20 h: the red urgency pill, first of the open ones
  await page.setViewportSize(MOBILE);
  await page.goto("/#token=e2e-token");

  // the card list, not the 7-column grid squeezed to two columns
  await expect(cards(page).first()).toBeVisible();
  await expect(page.locator("#grid")).toBeHidden();
  const api = await list(request);
  await expect.poll(() => cardOrder(page)).toEqual(api.map((d) => d.id)); // the grid's order: open first, then by due date

  const row = api.find((d) => d.id === soon)!;
  const card = page.locator(`#cards .case-card[data-id="${soon}"]`);
  await expect(card.locator(".cc-id")).toHaveText(soon);
  await expect(card.locator(".amount")).toHaveText("$1,299.00"); // the grid's money format
  await expect(card.locator(".cc-status .badge").first()).toHaveText("Waiting for seller response");
  await expect(card.locator(".cc-win")).toContainText(row.win_probability === null ? "—" : `${row.win_probability}%`);
  await expect(card.locator(".cc-due .badge-red")).toHaveText(/^\d+h \d+m left$/); // under 48 h: urgent
  await expect(card.locator(".cc-due")).toContainText("by ");

  // every card fits the phone and the page never scrolls sideways
  for (const c of await cards(page).all()) {
    const b = (await c.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(MOBILE.width);
  }
  const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(scroll).toBe(client);
  await card.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0, document.querySelector("#cards")!.getBoundingClientRect().top + window.scrollY - 200));
  await page.screenshot({ path: `${SHOTS}/f20-phone-cards.png` });

  // a real button with a name a screen reader can say
  const named = page.getByRole("button", { name: new RegExp(`Dispute ${soon}`) });
  await expect(named).toHaveCount(1);
  await expect(named).toHaveAccessibleName(/\$1,299\.00/);

  // tapping opens the same full-screen sheet as a grid row
  await card.click();
  const sheet = page.getByRole("dialog", { name: `Dispute ${soon}` });
  await expect(sheet.getByRole("heading", { name: "Win probability" })).toBeVisible();
  const s = (await sheet.boundingBox())!;
  expect(s.width).toBeGreaterThanOrEqual(MOBILE.width - 1);
  await page.screenshot({ path: `${SHOTS}/f20-phone-sheet.png` });

  // closing hands focus back to the card; Enter on a focused card opens it too
  await sheet.getByRole("button", { name: /Close/ }).click();
  await expect(sheet).toBeHidden();
  await expect(card).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(sheet).toBeVisible();
  expect(errors).toEqual([]);
});

test("the card list follows the data: a new chargeback and a status change show up in place", async ({ page, request }) => {
  const errors = watchErrors(page);
  await enoughRows(request, 6);
  await page.setViewportSize(MOBILE);
  await page.goto("/#token=e2e-token");
  await expect(cards(page).first()).toBeVisible();

  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/demo/chargeback")),
    page.locator("#simulate-btn").click(),
  ]);
  const made = ((await res.json()) as Row).id;
  await expect(page.locator(`#cards .case-card[data-id="${made}"]`)).toBeVisible();
  await expect.poll(async () => JSON.stringify(await cardOrder(page)) === JSON.stringify((await list(request)).map((d) => d.id))).toBe(true);

  // answered elsewhere: the next poll turns its pill and moves it under the open cases
  expect((await request.post(`/api/disputes/${made}/accept`)).ok()).toBeTruthy();
  const card = page.locator(`#cards .case-card[data-id="${made}"]`);
  await expect(card.locator(".cc-status .badge").first()).toHaveText("Resolved");
  await expect(card).toHaveClass(/is-closed/);
  await expect.poll(async () => JSON.stringify(await cardOrder(page)) === JSON.stringify((await list(request)).map((d) => d.id))).toBe(true);
  const api = await list(request);
  const lastOpen = Math.max(...api.map((d, i) => (isOpen(d) ? i : -1)));
  expect((await cardOrder(page)).indexOf(made)).toBeGreaterThan(lastOpen);
  expect(errors).toEqual([]);
});

test("desktop keeps the grid; the card list only shows on a phone", async ({ page, request }) => {
  const errors = watchErrors(page);
  await enoughRows(request, 6);
  await page.goto("/#token=e2e-token");
  await expect(page.locator(".ag-row[row-id]").first()).toBeVisible();
  await expect(page.locator("#cards")).toBeHidden();
  await page.setViewportSize(MOBILE);
  await expect(page.locator("#grid")).toBeHidden();
  await expect(cards(page).first()).toBeVisible();
  await page.setViewportSize(DESKTOP);
  await expect(page.locator(".ag-row[row-id]").first()).toBeVisible();
  await expect(page.locator("#cards")).toBeHidden();
  expect(errors).toEqual([]);
});

test("a toast never covers a grid row or a case card", async ({ page, request }) => {
  const errors = watchErrors(page);
  await enoughRows(request);
  await page.goto("/#token=e2e-token");
  await expect(page.locator(".ag-row[row-id]").first()).toBeVisible();
  // no PayPal keys in the e2e server: an error toast that stays until dismissed
  await page.getByRole("button", { name: "Sync from PayPal" }).click();
  const toast = page.locator("#toast .toast-card");
  await expect(toast).toContainText("PayPal keys are not set");

  const rowsUnder = async () => {
    const t = (await toast.boundingBox())!;
    const rows = await page.locator("#grid .ag-row[row-id]").evaluateAll(visibleBoxes);
    expect(rows.length).toBeGreaterThan(3);
    return rows.filter((r) => intersects(r.box, t)).map((r) => r.id);
  };
  await expect.poll(rowsUnder).toEqual([]);
  // the grid still reaches down to the toast: it isn't parked far away from the rows
  const t = (await toast.boundingBox())!;
  expect(t.y + t.height).toBeLessThanOrEqual(DESKTOP.height);
  await page.screenshot({ path: `${SHOTS}/f20-desktop-toast.png` });

  // with a case open too: the toast stays clear of the rows and of the panel, and from the first frame the
  // panel shows, every grid column is whole (no column cut at the grid's edge while it settles)
  await watchColumns(page);
  await page.locator(".ag-row[row-id] [col-id='id']").first().click();
  const panel = page.getByRole("dialog");
  await expect(panel.getByRole("heading", { name: "Win probability" })).toBeVisible();
  await expect.poll(rowsUnder).toEqual([]);
  expect(intersects((await toast.boundingBox())!, (await panel.boundingBox())!)).toBe(false);
  expect(await columnsCutWhileOpening(page)).toEqual([]);
  expect(await columnsCut(page)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/f20-desktop-toast-panel.png` });
  await panel.getByRole("button", { name: /Close/ }).click();

  // a phone: the toast sits clear of every card on screen
  await page.setViewportSize(MOBILE);
  await expect(toast).toBeInViewport();
  await expect(cards(page).first()).toBeVisible();
  for (const y of [0, 400, 800]) {
    await page.evaluate((y) => window.scrollTo(0, y), y);
    const tb = await toast.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const under = (await cards(page).evaluateAll(visibleBoxes)).filter((c) => intersects(c.box, tb)).map((c) => c.id);
    expect(under).toEqual([]);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${SHOTS}/f20-phone-toast.png` });
  expect(unexpected(errors, [409])).toEqual([]);
});

test("with the panel open on a desktop, every status pill stays whole", async ({ page, request }) => {
  const errors = watchErrors(page);
  await enoughRows(request);
  // an Open case the autopilot flagged: the widest status cell, Open + Needs review
  await request.put("/api/autopilot", { data: { enabled: true, threshold: 85 } });
  const flagged = await webhookCase(request, "R", 30);
  await expect.poll(async () => (await list(request)).find((d) => d.id === flagged)?.review_reasons ?? null).not.toBeNull();
  await request.put("/api/autopilot", { data: { enabled: false, threshold: 85 } });

  for (const size of [DESKTOP, { width: 1280, height: 900 }]) {
    await page.setViewportSize(size);
    await page.goto("/#token=e2e-token");
    const row = page.locator(`.ag-row[row-id="${flagged}"]`);
    await expect(row).toBeVisible();
    await watchColumns(page);
    await row.locator("[col-id='id']").click();
    const panel = page.getByRole("dialog", { name: `Dispute ${flagged}` });
    await expect(panel.getByRole("heading", { name: "Win probability" })).toBeVisible();
    await expect(row.locator(".badge")).toContainText(["Waiting for seller response", "Needs review"]);
    expect(await columnsCutWhileOpening(page)).toEqual([]); // whole from the first frame, not only once settled

    const p = (await panel.boundingBox())!;
    const cut = await page.locator("#grid .ag-row[row-id] .badge").evaluateAll((badges, panelLeft) => {
      const out: string[] = [];
      for (const b of badges) {
        const r = b.getBoundingClientRect();
        let [left, right] = [r.left, r.right];
        for (let el = b.parentElement; el; el = el.parentElement) {
          const s = getComputedStyle(el);
          if (/auto|scroll|hidden|clip/.test(s.overflowX)) {
            const pr = el.getBoundingClientRect();
            left = Math.max(left, pr.left);
            right = Math.min(right, pr.right);
          }
        }
        const whole = left <= r.left + 0.5 && right >= r.right - 0.5 && b.scrollWidth <= b.clientWidth && r.right <= panelLeft;
        if (!whole) out.push(`${b.closest(".ag-row")?.getAttribute("row-id")}: ${b.textContent}`);
      }
      return out;
    }, p.x);
    expect(cut).toEqual([]);
    expect(await columnsCut(page)).toEqual([]);
    // only what the panel already says is dropped: at 1440 the countdown stays next to the status
    const shown = ["id", "status", "win", ...(size.width >= 1440 ? ["due"] : [])];
    for (const col of shown) await expect(page.locator(`.ag-header-cell[col-id="${col}"]`)).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/f20-desktop-panel-${size.width}.png` });
  }
  expect(errors).toEqual([]);
});

test("rows never draw over each other when a new case is inserted", async ({ page, request }) => {
  const errors = watchErrors(page);
  await enoughRows(request);
  await page.goto("/#token=e2e-token");
  await expect(page.locator(".ag-row[row-id]").nth(5)).toBeVisible();

  // record, every frame, any two rows of the grid whose boxes overlap
  await page.evaluate(() => {
    const w = window as unknown as { f20Overlaps: string[]; f20Stop: boolean };
    w.f20Overlaps = [];
    w.f20Stop = false;
    const tick = () => {
      const rows = Array.from(document.querySelectorAll("#grid .ag-row[row-id]")).map((r) => ({
        id: r.getAttribute("row-id")!,
        r: r.getBoundingClientRect(),
      }));
      for (let i = 0; i < rows.length; i++)
        for (let j = i + 1; j < rows.length; j++) {
          const [a, b] = [rows[i].r, rows[j].r];
          if (a.top < b.bottom - 1 && b.top < a.bottom - 1) w.f20Overlaps.push(`${rows[i].id} over ${rows[j].id}`);
        }
      if (!w.f20Stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  // a new open case due first: it goes in at the top and every row under it moves down one
  const first = await webhookCase(request, "N", 1);
  await expect(page.locator(`.ag-row[row-id="${first}"]`)).toBeVisible();
  // and an answered one moves the other way
  const api = await list(request);
  const open = api.filter(isOpen);
  expect((await request.post(`/api/disputes/${open[open.length - 1].id}/accept`)).ok()).toBeTruthy();
  await page.waitForResponse((r) => r.url().endsWith("/api/disputes"));
  await page.waitForTimeout(1200); // longer than any row animation
  await page.screenshot({ path: `${SHOTS}/f20-desktop-inserted.png` });
  const overlaps = await page.evaluate(() => {
    const w = window as unknown as { f20Overlaps: string[]; f20Stop: boolean };
    w.f20Stop = true;
    return [...new Set(w.f20Overlaps)];
  });
  expect(overlaps).toEqual([]);

  // and the rows stand where the server's order says, one row height apart
  const tops = await page.locator("#grid .ag-row[row-id]").evaluateAll((rs) =>
    rs.map((r) => ({ index: Number(r.getAttribute("row-index")), top: Math.round(r.getBoundingClientRect().top) })).sort((a, b) => a.index - b.index),
  );
  for (let i = 1; i < tops.length; i++) expect(tops[i].top - tops[i - 1].top).toBe(56 * (tops[i].index - tops[i - 1].index));
  expect(errors).toEqual([]);
});

