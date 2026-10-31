// Takes the README screenshots from the real console with the local model on, so they show the AI badge, not the fallbacks.
// Needs bun, uv (.venv with uvicorn), Ollama with qwen3:8b (bun run llm:start, bun run llm:pull) and Playwright's chromium.
// Runs its own server on a free port in demo mode with a throwaway database, like scripts/demo-video.ts.
// bun run readme:shots -> docs/screenshots/*.png
import { chromium, type Browser, type Locator, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const TMP = mkdtempSync(join(tmpdir(), 'ds-shots-'));
const OUT = join(ROOT, 'docs', 'screenshots');
const TOKEN = 'readme-shots-token';
const MODEL = process.env.DISPUTESHIELD_OLLAMA_MODEL || 'qwen3:8b';
const OLLAMA = process.env.OLLAMA_HOST || 'http://localhost:11434';
const MAX_BYTES = 700_000;
const WAIT = { timeout: 180_000 };
const FALLBACK = /Regex fallback|Template|recorded/i; // a recorded read is honest, but these shots are meant to show a live one

function run(cmd: string[]): void {
  const p = Bun.spawnSync(cmd, { cwd: ROOT, env: { ...process.env, CI: '1' } });
  if (p.exitCode) throw new Error(`${cmd.join(' ')} failed:\n${(p.stdout.toString() + p.stderr.toString()).slice(-2000)}`);
}

// ---- 1. the console bundle, and a warm model (a cold start would time out the first read) ----
run(['bun', 'run', 'build']);
const warm = await fetch(`${OLLAMA}/api/generate`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: MODEL, prompt: 'ok', stream: false, keep_alive: '30m', options: { num_predict: 1 } }),
  signal: AbortSignal.timeout(180_000),
}).catch((e: unknown) => { throw new Error(`Ollama is not reachable at ${OLLAMA} (${String(e)}): run bun run llm:start and bun run llm:pull`); });
if (!warm.ok) throw new Error(`Ollama has no ${MODEL} (${warm.status}): run bun run llm:pull`);

// ---- 2. our own server: free port, demo mode, throwaway database, fixed token, model on ----
const probePort = Bun.serve({ port: 0, fetch: () => new Response('') });
const PORT = probePort.port;
await probePort.stop(true);
const BASE = `http://127.0.0.1:${PORT}`;
const server = Bun.spawn([join(ROOT, '.venv/bin/uvicorn'), 'app.main:app', '--port', String(PORT)], {
  cwd: ROOT,
  env: {
    ...process.env,
    DISPUTESHIELD_DEMO_MODE: '1',
    DISPUTESHIELD_DB: join(TMP, 'shots.db'),
    DISPUTESHIELD_OPERATOR_TOKEN: TOKEN,
    DISPUTESHIELD_LLM: 'ollama',
    DISPUTESHIELD_OLLAMA_MODEL: MODEL,
    OLLAMA_HOST: OLLAMA,
    ANTHROPIC_API_KEY: '',
    PAYPAL_CLIENT_ID: '',
    PAYPAL_CLIENT_SECRET: '',
    PAYPAL_WEBHOOK_ID: '',
  },
  stdout: 'ignore', stderr: 'inherit',
});

const AUTH = { Authorization: `Bearer ${TOKEN}` };
const errors: string[] = [];
const saved: string[] = [];
let browser: Browser | undefined;

function watch(page: Page): void {
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
}

async function shot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await Bun.sleep(400); // let the panel and toast transitions finish
  const file = join(OUT, name);
  await page.screenshot({ path: file, animations: 'disabled' });
  const size = statSync(file).size;
  if (size > MAX_BYTES) throw new Error(`${name} is ${size} bytes, over ${MAX_BYTES}`);
  saved.push(`${name} ${Math.round(size / 1024)} KB`);
}

/** The panel must say the model did the reading and the writing, never a fallback. */
async function expectAi(panel: Locator, id: string): Promise<void> {
  await panel.getByRole('heading', { name: 'Extracted evidence' }).waitFor(WAIT);
  const badges = (await panel.locator('.card-head .badge').allInnerTexts()).map((t) => t.trim());
  const bad = badges.filter((t) => !t.includes('AI') || !t.includes(MODEL));
  if (!badges.length || bad.length) {
    const s = (await (await fetch(`${BASE}/api/disputes/${id}/score`, { headers: AUTH })).json()) as Record<string, unknown>;
    console.error(JSON.stringify(s, null, 2));
    throw new Error(`the panel shows ${JSON.stringify(badges)}, wanted every badge to be "AI · ${MODEL}"`);
  }
  if (FALLBACK.test(await panel.innerText())) throw new Error('the panel mentions a fallback or a recorded read: is Ollama answering?');
}

async function dismissToast(page: Page): Promise<void> {
  const close = page.locator('.toast-close');
  if (await close.count()) await close.click();
}

/** The autopilot runs once per demo chargeback and its toast lands on a later poll: wait for it so it never pops into a shot. */
async function waitForToast(page: Page, text: RegExp): Promise<void> {
  await page.locator('.toast-card').filter({ hasText: text }).waitFor(WAIT);
}

async function simulate(page: Page): Promise<string> {
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/demo/chargeback'), WAIT),
    page.locator('#simulate-btn').click(),
  ]);
  if (!res.ok()) throw new Error(`demo chargeback answered ${res.status()}`);
  return ((await res.json()) as { id: string }).id;
}

async function openRow(page: Page, id: string): Promise<Locator> {
  await page.locator(`.ag-row[row-id="${id}"] [col-id="reason"]`).click();
  const panel = page.getByRole('dialog', { name: `Dispute ${id}` });
  await panel.waitFor();
  return panel;
}

try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
    if (i > 100) throw new Error('server did not start');
    await Bun.sleep(200);
  }
  mkdirSync(OUT, { recursive: true });
  browser = await chromium.launch();
  const desk = await browser.newContext({ viewport: { width: 1440, height: 1200 }, colorScheme: 'light' });
  const page = await desk.newPage();
  watch(page);
  await page.goto(`${BASE}/#token=${TOKEN}`);
  await page.getByText('Demo mode', { exact: true }).waitFor();

  // ---- (a) hero: the five sample rows, then the walkthrough chargeback read by the model, its panel open ----
  await page.getByRole('button', { name: 'Load sample disputes' }).click();
  await page.locator('.ag-row').nth(4).waitFor(WAIT);
  const id = await simulate(page);
  const row = page.locator(`.ag-row[row-id="${id}"]`);
  await row.locator('[col-id="win"]').filter({ hasText: '100%' }).waitFor(WAIT);
  await waitForToast(page, /Autopilot flagged/);
  await dismissToast(page);
  const panel = await openRow(page, id);
  await expectAi(panel, id);
  const win = (await panel.locator('.score-num').innerText()).trim();
  if (win !== '100%') throw new Error(`the README says the walkthrough scores 100%, the panel shows ${win}`);
  await panel.getByText('1Z999AA10123456784', { exact: true }).waitFor();
  await shot(page, 'hero.png');

  // ---- (b) evidence submitted: the demo-mode label and the audit trail ----
  await panel.getByRole('button', { name: 'Submit evidence' }).click();
  await panel.getByText('Demo mode: nothing was sent to PayPal').waitFor(WAIT);
  await panel.getByRole('button', { name: 'Evidence submitted' }).waitFor();
  await panel.getByText('Evidence submitted (demo mode, not sent to PayPal)').waitFor(WAIT);
  await panel.locator('#h-audit').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await shot(page, 'submitted.png');
  await panel.getByRole('button', { name: /Close/ }).click();
  await row.locator('[col-id="status"]').filter({ hasText: 'Under review' }).waitFor(WAIT);

  // ---- (d) a weak case: a webhook for a "not as described" claim, its PDFs uploaded and read by the model ----
  // (the Madrid receipt is not used: qwen3:8b glues its date and tracking number into one id, the fact check rejects the note
  // and the Template badge shows, at temperature 0 on every run)
  const did = `PP-D-${crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`; // the same shape as app/demo.py's ids
  const now = new Date();
  const iso = (d: Date) => d.toISOString().replace(/\.\d+Z$/, '.000Z');
  const hook = await fetch(`${BASE}/api/webhooks/paypal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: `WH-SHOTS-${did}`,
      event_type: 'CUSTOMER.DISPUTE.CREATED',
      resource: {
        dispute_id: did,
        reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
        status: 'OPEN',
        dispute_amount: { currency_code: 'NOK', value: '1299.00' },
        create_time: iso(now),
        update_time: iso(now),
        seller_response_due_date: iso(new Date(now.getTime() + 30 * 3600_000)),
        dispute_channel: 'INTERNAL',
        messages: [{ posted_by: 'BUYER', time_posted: iso(now), content: 'the jacket is not what the listing showed' }],
        buyer: { name: 'Ola Berg' },
        buyer_billing_address: 'Storgata 14, 0155 Oslo',
      },
    }),
  });
  if (!hook.ok) throw new Error(`webhook answered ${hook.status}: ${await hook.text()}`);
  for (const name of ['postnord_oslo_receipt.pdf', 'crm_oslo_order.pdf']) {
    const up = await fetch(`${BASE}/api/disputes/${did}/documents?name=${name}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/pdf' },
      body: readFileSync(join(ROOT, 'samples', name)),
      signal: AbortSignal.timeout(180_000),
    });
    if (!up.ok) throw new Error(`upload of ${name} answered ${up.status}: ${await up.text()}`);
  }
  const weakRow = page.locator(`.ag-row[row-id="${did}"]`);
  await weakRow.waitFor(WAIT);
  const weak = await openRow(page, did);
  await expectAi(weak, did);
  const pct = Number((await weak.locator('.score-num').innerText()).replace('%', ''));
  if (!(pct < 60)) throw new Error(`the weak case scores ${pct}%, wanted under 60 so Accept and Offer refund show`);
  await weak.getByRole('button', { name: 'Offer refund' }).waitFor();
  await weak.getByRole('button', { name: 'Accept claim' }).waitFor();
  await shot(page, 'recommendation.png');
  await weak.getByRole('button', { name: /Close/ }).click();

  // ---- (c) autopilot on: the next chargeback is scored and submitted with no click ----
  await page.getByRole('switch', { name: 'Autopilot' }).check();
  const ap = (await (await fetch(`${BASE}/api/autopilot`, { headers: AUTH })).json()) as { enabled: boolean; threshold: number };
  if (!ap.enabled || ap.threshold !== 85) throw new Error(`autopilot is ${JSON.stringify(ap)}`);
  const id2 = await simulate(page);
  const row2 = page.locator(`.ag-row[row-id="${id2}"]`);
  await row2.locator('[col-id="status"]').filter({ hasText: 'Under review' }).waitFor(WAIT);
  await waitForToast(page, /Autopilot submitted evidence/);
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); // no focus ring on the grid cell
  await shot(page, 'autopilot.png');
  await dismissToast(page);

  // ---- (e) phone: the same console at 375 wide ----
  const phone = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light' });
  const mob = await phone.newPage();
  watch(mob);
  await mob.goto(`${BASE}/#token=${TOKEN}`);
  await mob.getByText('Demo mode', { exact: true }).waitFor();
  await mob.locator('.ag-row').nth(6).waitFor(WAIT);
  await shot(mob, 'phone.png');

  if (errors.length) throw new Error(`the console logged errors:\n${errors.join('\n')}`);
  console.log(`saved to ${OUT}:\n${saved.join('\n')}`);
} finally {
  await browser?.close();
  server.kill();
}
