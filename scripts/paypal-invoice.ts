// Reproduces the real PayPal sandbox invoice end to end, using the keys in .env (never printed).
// Refuses unless PAYPAL_API_BASE is the sandbox. Starts the app with demo mode OFF on a free port and a throwaway
// database, seeds one simulated case, opens it in the console, clicks "Record as PayPal invoice" and saves a screenshot.
// The dispute is a seeded simulation; the calls are real: OAuth token, Invoicing v2 create draft, read it back.
// bun run paypal:invoice -> docs/screenshots/invoice-sandbox.png, and the invoice number + debug id on stdout
import { chromium, type Browser } from '@playwright/test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const TMP = mkdtempSync(join(tmpdir(), 'ds-invoice-'));
const OUT = join(ROOT, 'docs', 'screenshots', 'invoice-sandbox.png');
const TOKEN = 'paypal-invoice-token';
const PY = join(ROOT, '.venv/bin/python');

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

// ---- 1. refuse unless this is the sandbox with keys (bun loads .env into process.env) ----
if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) fail('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set in .env');
const guard = Bun.spawnSync([PY, 'scripts/check_sandbox.py'], { cwd: ROOT, env: process.env });
if (guard.exitCode) fail(guard.stderr.toString().trim() || 'refused: PAYPAL_API_BASE is not the PayPal sandbox');

const env = {
  ...process.env,
  DISPUTESHIELD_DEMO_MODE: '0',
  DISPUTESHIELD_DB: join(TMP, 'invoice.db'),
  DISPUTESHIELD_OPERATOR_TOKEN: TOKEN,
  DISPUTESHIELD_LLM: 'off',
  ANTHROPIC_API_KEY: '',
  PAYPAL_WEBHOOK_ID: '',
};

// ---- 2. the console bundle and one seeded case ----
const build = Bun.spawnSync(['bun', 'run', 'build'], { cwd: ROOT });
if (build.exitCode) fail(`bun run build failed:\n${build.stderr.toString().slice(-1500)}`);
const seed = Bun.spawnSync([PY, 'scripts/seed_case.py'], { cwd: ROOT, env: { ...env, PYTHONPATH: ROOT } });
if (seed.exitCode) fail(`seeding failed:\n${seed.stderr.toString().slice(-1500)}`);
const id = seed.stdout.toString().trim().split('\n').pop()!;

// ---- 3. our own server: free port, demo mode off ----
const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
const PORT = probe.port;
await probe.stop(true);
const BASE = `http://127.0.0.1:${PORT}`;
const server = Bun.spawn([join(ROOT, '.venv/bin/uvicorn'), 'app.main:app', '--port', String(PORT)], {
  cwd: ROOT, env, stdout: 'ignore', stderr: 'inherit',
});

let browser: Browser | undefined;
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
    if (i > 100) throw new Error('server did not start');
    await Bun.sleep(200);
  }
  browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })).newPage();
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
  await page.goto(`${BASE}/#token=${TOKEN}`);
  await page.locator(`.ag-row[row-id="${id}"] [col-id="reason"]`).click();
  const panel = page.getByRole('dialog', { name: `Dispute ${id}` });
  await panel.getByRole('heading', { name: 'Extracted evidence' }).waitFor();

  const answered = page.waitForResponse((r) => r.url().endsWith('/paypal-invoice') && r.request().method() === 'POST', { timeout: 60_000 });
  await panel.getByRole('button', { name: 'Record as PayPal invoice' }).click();
  const res = await answered;
  if (!res.ok()) fail(`PayPal sandbox call failed (${res.status()}): ${await res.text()}`);
  const r = (await res.json()) as { invoice_number: string; invoice_id: string; debug_id: string | null; lookup_debug_id: string | null; simulated_case: boolean };
  const banner = panel.locator('#invoice-box .banner');
  await banner.getByText('Recorded on PayPal sandbox').waitFor({ timeout: 10_000 });
  await banner.getByText('Simulated case · invoice call live on sandbox').waitFor({ timeout: 10_000 });
  await banner.evaluate((b) => b.scrollIntoView({ block: 'center' }));
  await page.evaluate(() => document.fonts.ready);
  await Bun.sleep(500);
  mkdirSync(join(ROOT, 'docs', 'screenshots'), { recursive: true });
  await page.screenshot({ path: OUT, animations: 'disabled' });
  console.log(`invoice number: ${r.invoice_number}`);
  console.log(`invoice id: ${r.invoice_id}`);
  console.log(`paypal-debug-id (create): ${r.debug_id}`);
  console.log(`paypal-debug-id (read back): ${r.lookup_debug_id}`);
  console.log(`screenshot: ${OUT}`);
  if (errors.length) console.log(`console messages:\n${errors.join('\n')}`);
} finally {
  await browser?.close();
  server.kill();
}
