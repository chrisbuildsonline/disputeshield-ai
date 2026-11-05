import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

// The e2e server runs with DISPUTESHIELD_LLM=off, so no model is reachable: the sample PDFs and the walkthrough
// come back with the output a real model run produced earlier (samples/recorded.json), source "recorded".
// Each badge names the model the backend reports for it (the reads are qwen3:8b, some notes qwen2.5:3b).
const SHOTS = "e2e/screenshots";
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 375, height: 812 };
// one model, or two when the read and the note came from different runs
const LINE = /^Recorded from (a real \S+ run|real \S+ and \S+ runs) on (this exact PDF|these exact PDFs)( and these case facts)?\. Start Ollama for live reads\.$/;

test.use({ viewport: DESKTOP });
test.describe.configure({ mode: "serial" }); // the later tests open the cases the first one makes

interface Row {
  id: string;
  currency: string | null;
  amount_value: string | null;
}

interface ScoreJson {
  documents: { name: string; evidence: { source: string; model?: string | null } }[];
  dossier: { note_source: string; note_model?: string | null };
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

// the five seeded cases by their amount, and the walkthrough chargeback
const CASES: [name: string, currency: string, value: string][] = [
  ["leeds", "USD", "49.90"],
  ["lisbon", "EUR", "128.00"],
  ["oslo", "NOK", "1299.00"],
  ["bristol", "GBP", "86.40"],
  ["madrid", "EUR", "312.50"],
];
const ids: Record<string, string> = {};

async function openCase(page: Page, id: string): Promise<Locator> {
  const cell = page.locator(`.ag-row[row-id="${id}"] [col-id="reason"]`);
  await cell.scrollIntoViewIfNeeded();
  await cell.click();
  const panel = page.getByRole("dialog", { name: `Dispute ${id}` });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Extracted evidence" })).toBeVisible();
  return panel;
}

async function closeCase(panel: Locator): Promise<void> {
  await panel.getByRole("button", { name: /Close/ }).click();
  await expect(panel).toBeHidden();
}

async function scoreOf(request: APIRequestContext, id: string): Promise<ScoreJson> {
  const s = (await (await request.get(`/api/disputes/${id}/score`)).json()) as ScoreJson;
  s.dossier = (await (await request.get(`/api/disputes/${id}/dossier`)).json()) as ScoreJson["dossier"];
  return s;
}

const noteBadge = (panel: Locator) => panel.locator("#h-dossier ~ .card .card-head .badge");

/**
 * Every evidence card and the note say a model wrote them from a recording, each badge naming the model the backend
 * reports for it; no fallback or template anywhere; and the one honest line names every model used.
 */
async function expectRecordedCase(panel: Locator, s: ScoreJson, name: string): Promise<void> {
  expect(s.documents.length, name).toBeGreaterThan(0);
  const models = new Set<string>();
  const cards = panel.locator("#h-evidence ~ .card");
  await expect(cards).toHaveCount(s.documents.length);
  for (const [i, doc] of s.documents.entries()) {
    expect([doc.evidence.source, !!doc.evidence.model], `${name} ${doc.name}`).toEqual(["recorded", true]);
    models.add(doc.evidence.model!);
    const badge = cards.nth(i).locator(".card-head .badge");
    await expect(badge).toHaveText(`AI · ${doc.evidence.model} · recorded`);
    await expect(badge).toHaveClass(/badge-ai/);
    await expect(badge).toHaveClass(/badge-recorded/);
    await expect(badge).toHaveAttribute("title", `Recorded from a real ${doc.evidence.model} run. Start Ollama for live reads.`);
  }
  expect([s.dossier.note_source, !!s.dossier.note_model], `${name} note`).toEqual(["recorded", true]);
  models.add(s.dossier.note_model!);
  await expect(noteBadge(panel)).toHaveText(`AI · ${s.dossier.note_model} · recorded`);
  await expect(noteBadge(panel)).toHaveClass(/badge-recorded/);

  await expect(panel.getByText("Regex fallback")).toHaveCount(0);
  await expect(panel.getByText("Template", { exact: true })).toHaveCount(0);
  const line = panel.locator(".recorded-line");
  await expect(line).toHaveCount(1);
  await expect(line).toHaveText(LINE);
  for (const m of models) await expect(line, name).toContainText(m);
  await expect(line).toContainText(s.documents.length > 1 ? "these exact PDFs and these case facts" : "this exact PDF and these case facts");
}

test("the walkthrough chargeback and the sample disputes read as recorded model output", async ({ page, request }) => {
  const errors = watchErrors(page);
  await page.goto("/#token=e2e-token");
  await expect(page.getByText("Demo mode", { exact: true })).toBeVisible();

  // load sample disputes (the same route the empty state's button calls), then simulate the walkthrough from the header
  const seed = await request.post("/api/demo/seed");
  expect(seed.ok()).toBeTruthy();
  const seeded = ((await seed.json()) as { disputes: Row[] }).disputes;
  expect(seeded).toHaveLength(5);
  for (const [name, currency, value] of CASES) ids[name] = seeded.find((d) => d.currency === currency && d.amount_value === value)!.id;

  const created = page.waitForResponse((r) => r.url().endsWith("/api/demo/chargeback") && r.request().method() === "POST");
  await page.locator("header").getByRole("button", { name: "Simulate chargeback" }).click();
  ids.walkthrough = ((await (await created).json()) as Row).id;
  await expect(page.locator(`.ag-row[row-id="${ids.walkthrough}"] [col-id="win"]`)).toHaveText("95%");

  // the walkthrough, then every seeded case: recorded reads and a recorded note, never a fallback or a template
  for (const name of ["walkthrough", ...CASES.map(([n]) => n)]) {
    const s = await scoreOf(request, ids[name]);
    const p = await openCase(page, ids[name]);
    await expectRecordedCase(p, s, name);
    // the shots show the evidence, the line and the note, not the score above them or the autopilot toast
    const toast = page.locator(".toast-close");
    if (await toast.isVisible()) await toast.click();
    await p.locator("#h-evidence").evaluate((h) => h.scrollIntoView({ block: "start" }));
    if (name === "walkthrough") await page.screenshot({ path: `${SHOTS}/f17-walkthrough.png` });
    if (name === "oslo") await page.screenshot({ path: `${SHOTS}/f17-oslo.png` }); // two recorded PDFs, one line
    if (name === "lisbon") await page.screenshot({ path: `${SHOTS}/f17-lisbon.png` }); // read by one model, written by another
    await closeCase(p);
  }
  expect(errors).toEqual([]);
});

test("a live model read shows the plain AI badge and no recorded line", async ({ page, request }) => {
  const errors = watchErrors(page);
  // the e2e server never calls a model, so turn the recorded answer into a live one on the way to the browser
  await page.route("**/api/disputes/*/score", async (route) => {
    const res = await route.fetch();
    const s = (await res.json()) as ScoreJson;
    for (const d of s.documents) d.evidence.source = "ollama";
    await route.fulfill({ response: res, json: s });
  });
  await page.route("**/api/disputes/*/dossier", async (route) => {
    const res = await route.fetch();
    const n = (await res.json()) as ScoreJson["dossier"];
    n.note_source = "ollama";
    await route.fulfill({ response: res, json: n });
  });
  const s = await scoreOf(request, ids.walkthrough);
  expect(s.documents[0].evidence.source).toBe("recorded");
  await page.goto("/#token=e2e-token");
  const panel = await openCase(page, ids.walkthrough);
  const badge = panel.locator("#h-evidence ~ .card .card-head .badge");
  await expect(badge).toHaveText(`AI · ${s.documents[0].evidence.model} · live`);
  await expect(badge).toHaveClass(/badge-ai/);
  await expect(badge).not.toHaveClass(/badge-recorded/);
  await expect(badge).not.toHaveAttribute("title", /.+/);
  await expect(noteBadge(panel)).toHaveText(`AI · ${s.dossier.note_model} · live`);
  await expect(noteBadge(panel)).not.toHaveClass(/badge-recorded/);
  await expect(panel.locator(".recorded-line")).toHaveCount(0);
  await expect(panel.getByText(/recorded/i)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test.describe("phone", () => {
  test.use({ viewport: MOBILE, isMobile: true, hasTouch: true });

  // the walkthrough, and lisbon: read by one model, written by another, so the longest line
  for (const name of ["walkthrough", "lisbon"]) {
    test(`the recorded badges and the line fit a 375px panel (${name})`, async ({ page, request }) => {
      const errors = watchErrors(page);
      const s = await scoreOf(request, ids[name]);
      await page.goto("/#token=e2e-token");
      const card = page.locator(`#cards .case-card[data-id="${ids[name]}"]`); // a phone lists the cases as cards
      await card.scrollIntoViewIfNeeded();
      await card.tap();
      const panel = page.getByRole("dialog", { name: `Dispute ${ids[name]}` });
      await expect(panel).toBeVisible();
      await expectRecordedCase(panel, s, name);
      // nothing spills sideways: every badge stays inside its card and the body never scrolls horizontally
      for (const card of await panel.locator(".card").all()) {
        const box = (await card.boundingBox())!;
        const b = (await card.locator(".card-head .badge").boundingBox())!;
        expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
      }
      const body = panel.locator(".detail-body");
      expect(await body.evaluate((b) => b.scrollWidth - b.clientWidth)).toBeLessThanOrEqual(0);
      // centred: the sticky Needs review banner would cover a card scrolled to the top
      await panel.locator(".recorded-line").evaluate((l) => l.scrollIntoView({ block: "center" }));
      await page.screenshot({ path: `${SHOTS}/f17-phone-${name}.png` });
      await noteBadge(panel).evaluate((b) => b.scrollIntoView({ block: "start" }));
      await page.screenshot({ path: `${SHOTS}/f17-phone-${name}-note.png` });
      expect(errors).toEqual([]);
    });
  }
});
