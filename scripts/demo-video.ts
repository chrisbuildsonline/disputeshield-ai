// Records the demo video (under 3 min) in the story-cards look, narrated by Chris's American voice clone over a quiet
// synthesized music bed. Every product shot is the real console, driven by Playwright:
// a small shop gets an "item not received" dispute, the live qwen3:8b read of the carrier receipt, the rule-based score,
// the dossier and note, Submit (demo mode, nothing sent to PayPal), a weaker case that gets a refund offer, and a real
// PayPal Invoicing sandbox call on a second server with demo mode off.
// Needs bun, uv (.venv), Ollama with qwen3:8b, the voice-clone venv, ffmpeg/ffprobe, Playwright's chromium, and the
// sandbox keys in .env (PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_API_BASE on the sandbox) for the invoice shot.
// Waits for a quiet window on the shared Ollama before filming: the AI scenes refuse to run on a fallback read.
// Long waits for the model (no voice playing) are cut from the video; a short piece of each wait stays in.
// bun run demo:video -> out/disputeshield-demo.mp4 (plus out/demo-narration.txt, the lines and the wav files used)
import { chromium, type Browser, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { hudCss, hudHtml, loadPack, resolveStyles, slideHtml } from '../../../demo-styles/render.mjs';

const ROOT = join(import.meta.dir, '..');
const TMP = mkdtempSync(join(tmpdir(), 'ds-demo-'));
const OUT = join(ROOT, 'out');
const VOICE_DIR = join(OUT, 'voice'); // cache: the same line is not cloned twice
const SPEAK = join(homedir(), '.venvs/voice-clone/bin/python');
const SPEAK_SCRIPT = '/home/chris/projects/AI Influencer/voice-clone/scripts/speak.py';
const REPO_URL = 'https://github.com/chrisbuildsonline/disputeshield-ai';
const TOKEN = 'demo-video-token';
const MODEL = process.env.DISPUTESHIELD_OLLAMA_MODEL || 'qwen3:8b';
const OLLAMA = process.env.OLLAMA_HOST || 'http://localhost:11434';
const PY = join(ROOT, '.venv/bin/python');
const WAIT = { timeout: 240_000 };
const MAX_SECS = 178;
type Clip = { file: string; ms: number };

function run(cmd: string[]) {
  const p = Bun.spawnSync(cmd, { cwd: ROOT, env: { ...process.env, CI: '1' } });
  const out = p.stdout.toString() + p.stderr.toString();
  if (p.exitCode) throw new Error(`${cmd.join(' ')} failed:\n${out.slice(-2000)}`);
  return out;
}
const durationMs = (file: string) =>
  Math.round(Number(Bun.spawnSync(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).stdout.toString()) * 1000);

// ---- 1. gates: the offline suite and the type checks (the live model and sandbox tests need a quiet host; the video itself proves those paths) ----
console.log('running the gates...');
run(['bun', 'run', 'build']);
const tests = run(['uv', 'run', 'pytest', '-q', '-k', 'not live']);
run(['bun', 'run', 'typecheck']);
const passed = tests.match(/(\d+) passed/)?.[1];
if (!passed) throw new Error('could not read the pytest count');
console.log(`pytest ${passed} passed (offline)`);

// ---- 2. the sandbox keys must be there for the invoice shot ----
if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set in .env for the invoice shot');
const guard = Bun.spawnSync([PY, 'scripts/check_sandbox.py'], { cwd: ROOT, env: process.env });
if (guard.exitCode) throw new Error(guard.stderr.toString().trim() || 'refused: PAYPAL_API_BASE is not the PayPal sandbox');

// ---- 3. the words. `say` is what the voice reads (spelled for the ear); `cap` is the short lower-third line ----
const LINES = {
  title: {
    say: 'A buyer tells PayPal their parcel never arrived. For a small online shop, that means the sale is on hold, a fee is coming, and the proof of delivery is buried in a carrier receipt. DisputeShield AI reads that proof, scores the case, and drafts the answer.',
  },
  console: {
    say: 'This is the real console, running on my machine in demo mode. Every PayPal dispute is a row in an A G Grid table. I click Simulate chargeback: a test dispute in PayPal\'s own format. Item not received, forty-nine ninety, with the receipt attached as a PDF.',
    cap: 'A new PayPal dispute: item not received, $49.90',
    step: '01 Console',
  },
  row: {
    say: 'Here it is, in red: contested, and still waiting for an answer.',
    cap: 'Contested and unanswered, so the row is red',
    step: '01 Console',
  },
  evidence: {
    say: 'I open it. The local model, Kwen three, eight B, on Ollama, read the receipt live, and the badge says so. Carrier, tracking number, delivery, address, signature and order number. A fact that is not in the PDF text gets dropped.',
    cap: 'qwen3:8b on Ollama reads the receipt PDF, live',
    step: '02 AI read',
  },
  score: {
    say: 'The win chance is not the model\'s opinion. A fixed rulebook adds points for each proof it found. This case has them all, so it shows ninety-five percent, the most the console ever claims.',
    cap: 'Fixed rules, not the model, set the win chance',
    step: '03 Score',
  },
  dossier: {
    say: 'From the same facts it builds the dossier: a rebuttal note, checked against the receipt, and the PDF to attach.',
    cap: 'Rebuttal note, fact-checked against the receipt',
    step: '04 Dossier',
  },
  submit: {
    say: 'I click Submit evidence. This is demo mode, so nothing was sent to PayPal, and the panel says so. With keys and a real dispute, this button calls PayPal\'s provide evidence endpoint.',
    cap: 'Demo mode: nothing is sent to PayPal',
    step: '05 Submit',
  },
  weak: {
    say: 'Not every case is worth fighting. This parcel was delivered, but to a different address, with no signature. Forty-four percent, so DisputeShield recommends a partial refund offer instead.',
    cap: '44%: offer a partial refund instead of a fight',
    step: '06 Weak case',
  },
  invoice: {
    say: 'A second PayPal API keeps a record. With demo mode off and sandbox keys, one click files the disputed order as a draft invoice in the PayPal sandbox, never sent to the buyer. The case is simulated. The invoice call is live.',
    cap: 'A real PayPal sandbox call: a draft invoice, never sent',
    step: '07 Invoicing',
  },
  how: {
    say: 'Under the hood: signed PayPal webhooks, Ollama with Kwen three as the default model, Claude optional, and a plain parser if no model answers. The score is fixed arithmetic: same evidence, same number.',
  },
  tests: {
    say: `${passed} offline tests passed just before this recording, and the type checks are clean.`,
  },
  outro: {
    say: 'DisputeShield AI is for the small PayPal shop that ships real parcels and has no one to answer chargebacks. It finds the proof, says which disputes to fight or settle, and leaves the final click to you. The code is open source on GitHub.',
  },
} satisfies Record<string, { say: string; cap?: string; step?: string }>;
type Key = keyof typeof LINES;

// ---- 4. the voice: Chris's American clone (speak.py), one model load for every missing line, cached by text ----
async function speakAll(): Promise<Record<Key, Clip>> {
  mkdirSync(VOICE_DIR, { recursive: true });
  const jobs = (Object.keys(LINES) as Key[]).map((key) => {
    const text = LINES[key].say;
    const hash = createHash('sha1').update(`american|sentence|${text}`).digest('hex').slice(0, 16);
    return { key, text, out: join(VOICE_DIR, `${key}-${hash}.wav`) };
  });
  const missing = jobs.filter((j) => !existsSync(j.out));
  if (missing.length) {
    console.log(`voice clone: ${missing.length} line(s) to speak`);
    const list = join(TMP, 'lines.json');
    writeFileSync(list, JSON.stringify(missing.map(({ text, out }) => ({ text, out }))));
    const p = Bun.spawn([SPEAK, SPEAK_SCRIPT, '--profile', 'american', '--chunk', 'sentence', '--batch', list], { stdout: 'inherit', stderr: 'inherit' });
    if (await p.exited) throw new Error('the American voice clone (speak.py) failed');
  }
  const clips = {} as Record<Key, Clip>;
  const log: string[] = [];
  for (const job of jobs) {
    if (!existsSync(job.out)) throw new Error(`speak.py wrote no ${job.out}`);
    const brisk = join(TMP, `${job.key}-brisk.wav`);
    const sped = Bun.spawnSync(['ffmpeg', '-y', '-v', 'error', '-i', job.out, '-filter:a', 'atempo=1.08', brisk]);
    if (sped.exitCode) throw new Error(`could not pace ${job.key}`);
    clips[job.key] = { file: brisk, ms: durationMs(brisk) };
    log.push(`[${job.key}] ${(clips[job.key].ms / 1000).toFixed(1)} s  speak.py --profile american -> ${job.out}\n  "${job.text}"`);
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'demo-narration.txt'), `${log.join('\n\n')}\n`);
  return clips;
}
const N = await speakAll();
console.log(`narration: ${(Object.values(N).reduce((s, c) => s + c.ms, 0) / 1000).toFixed(1)} s of voice (see out/demo-narration.txt)`);
if (process.argv.includes('--voice-only')) process.exit(0);

// ---- 5. a quiet window on the shared Ollama: a schema call has to answer fast before filming starts ----
async function ollamaReady(): Promise<boolean> {
  const t = Date.now();
  try {
    const r = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, stream: false, think: false, keep_alive: '30m',
        messages: [{ role: 'user', content: 'Reply with {"ok": true}' }],
        format: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
        options: { num_predict: 16 },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    return r.ok && Date.now() - t < 12_000;
  } catch {
    return false;
  }
}
// ---- 5-7. film; a read that fell back (the shared Ollama hiccupped) throws NotLive and the take is filmed again ----
class NotLive extends Error {}
const TRIES = Number(process.env.DEMO_TRIES || 6);
const clips: { file: string; at: number }[] = [];
const cuts: { from: number; to: number }[] = [];
const out = join(OUT, 'disputeshield-demo.mp4');
let secs = 0;
let webm = '';
for (let tryNo = 1; ; tryNo++) {
  const REC = join(TMP, `rec-${tryNo}`);
  mkdirSync(REC, { recursive: true });
  try {
  const waitMins = Number(process.env.DEMO_OLLAMA_WAIT_MIN || 60);
  for (let i = 0; ; i++) {
    if (await ollamaReady()) break;
    if (i * 1.5 > waitMins) throw new Error(`Ollama (${MODEL}) did not answer a schema call fast for ${waitMins} min: it is busy or down (bun run llm:start)`);
    console.log('Ollama is busy, waiting for a quiet window...');
    await Bun.sleep(30_000);
  }
  console.log('Ollama answered fast: filming');

  // ---- 6. two servers: A = demo mode with the live model; B = demo mode off with the sandbox keys, for the invoice ----
  async function freePort() {
    const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
    const port = probe.port!;
    await probe.stop(true);
    return port;
  }
  const noKeys = { PAYPAL_CLIENT_ID: '', PAYPAL_CLIENT_SECRET: '', PAYPAL_WEBHOOK_ID: '', ANTHROPIC_API_KEY: '' };
  const envA = {
    ...process.env, ...noKeys,
    DISPUTESHIELD_DEMO_MODE: '1', DISPUTESHIELD_DB: join(TMP, `demo-${tryNo}.db`), DISPUTESHIELD_OPERATOR_TOKEN: TOKEN,
    DISPUTESHIELD_LLM: 'ollama', DISPUTESHIELD_OLLAMA_MODEL: MODEL, OLLAMA_HOST: OLLAMA,
  };
  const envB = {
    ...process.env, ANTHROPIC_API_KEY: '', PAYPAL_WEBHOOK_ID: '',
    DISPUTESHIELD_DEMO_MODE: '0', DISPUTESHIELD_DB: join(TMP, `invoice-${tryNo}.db`), DISPUTESHIELD_OPERATOR_TOKEN: TOKEN, DISPUTESHIELD_LLM: 'off',
  };
  const seed = Bun.spawnSync([PY, 'scripts/seed_case.py'], { cwd: ROOT, env: { ...envB, PYTHONPATH: ROOT } });
  if (seed.exitCode) throw new Error(`seeding the invoice case failed:\n${seed.stderr.toString().slice(-1500)}`);
  const invoiceCase = seed.stdout.toString().trim().split('\n').pop()!;
  const portA = await freePort();
  let portB = await freePort();
  while (portB === portA) portB = await freePort();
  const A = `http://127.0.0.1:${portA}`;
  const B = `http://127.0.0.1:${portB}`;
  const uvicorn = (port: number, env: Record<string, string | undefined>) =>
    Bun.spawn([join(ROOT, '.venv/bin/uvicorn'), 'app.main:app', '--port', String(port)], { cwd: ROOT, env, stdout: 'ignore', stderr: 'ignore' });
  const servers = [uvicorn(portA, envA), uvicorn(portB, envB)];
  let browser: Browser | undefined;

  const pack = loadPack(resolveStyles()[0]!);
  // the lower third sits bottom-left, ribbon and caption on one row, so it never covers the case panel (x >= 688) or the app header
  const HUD_CSS = `${hudCss(pack)}
  #demo-style-hud{inset:auto auto 10px 24px;display:flex;align-items:center;gap:10px;max-width:640px}
  #demo-style-hud .ribbon,#demo-style-hud .cap{position:static}
  #demo-style-hud .ribbon{flex:none;padding:9px 12px}
  #demo-style-hud .cap{font-size:16px;padding:9px 14px;border-radius:14px}
  .demo-spot{box-shadow:0 0 0 3px rgba(184,74,39,.45)!important;transition:box-shadow .3s}`;

  clips.length = 0;
  cuts.length = 0;
  try {
    for (const base of [A, B]) {
      for (let i = 0; ; i++) {
        try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
        if (i > 150) throw new Error(`server ${base} did not start`);
        await Bun.sleep(200);
      }
    }

    // a few unanswered disputes already in the inbox (webhooks with no documents yet), so the grid is a real inbox
    const iso = (d: Date) => d.toISOString().replace(/\.\d+Z$/, '.000Z');
    const inbox = [
      { reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', cur: 'NOK', value: '1299.00', hours: 30, buyer: 'Ola Berg', msg: 'the jacket is not what the listing showed' },
      { reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', cur: 'EUR', value: '128.00', hours: 120, buyer: 'Marta Nunes', msg: 'my parcel never came' },
      { reason: 'UNAUTHORISED', cur: 'EUR', value: '312.50', hours: 144, buyer: 'Carlos Vega', msg: 'I did not make this purchase' },
    ];
    for (const [i, c] of inbox.entries()) {
      const now = new Date();
      const id = `PP-D-${crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
      const r = await fetch(`${A}/api/webhooks/paypal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: `WH-DEMO-${i}-${id}`,
          event_type: 'CUSTOMER.DISPUTE.CREATED',
          resource: {
            dispute_id: id, reason: c.reason, status: 'OPEN',
            dispute_amount: { currency_code: c.cur, value: c.value },
            create_time: iso(now), update_time: iso(now),
            seller_response_due_date: iso(new Date(now.getTime() + c.hours * 3600_000)),
            dispute_channel: 'INTERNAL',
            messages: [{ posted_by: 'BUYER', time_posted: iso(now), content: c.msg }],
            buyer: { name: c.buyer },
          },
        }),
      });
      if (!r.ok) throw new Error(`inbox webhook answered ${r.status}: ${await r.text()}`);
    }

    const slide = (s: Parameters<typeof slideHtml>[1]) => slideHtml(pack, s);
    const TITLE = slide({
      eyebrow: 'Chargeback defense',
      title: 'DisputeShield AI',
      lead: 'Win the PayPal disputes you should win. Settle the rest.',
      cards: [
        { kicker: 'The problem', title: 'Lost by default', body: 'An unanswered PayPal dispute costs the sale plus a fee, even when the parcel arrived.' },
        { kicker: 'Who it is for', title: 'Small online shops', body: 'Sellers who ship real parcels and have no team to chase chargebacks.' },
        { kicker: 'What it does', title: 'Reads, scores, drafts', body: 'Local AI reads the receipt. Fixed rules score the case. You decide.' },
      ],
    });
    const HOW = slide({
      eyebrow: 'How it works',
      title: 'Local AI reads. Plain arithmetic decides.',
      lead: 'FastAPI and an AG Grid console behind an operator token, in Docker.',
      cards: [
        { kicker: 'PayPal', title: 'Disputes and Invoicing', body: 'Signed webhooks, provide-evidence, and draft invoices in the sandbox.' },
        { kicker: 'Local AI', title: 'qwen3:8b on Ollama', body: 'The default model reads PDFs and drafts the note. Claude is optional.' },
        { kicker: 'Fixed rules', title: 'Same proof, same score', body: 'Points for each proof found, capped at 95%. The model never sets it.' },
      ],
    });
    const TESTS = slide({
      eyebrow: 'Run just now',
      title: 'Tested before filming',
      lead: 'pytest without the live-model tests, then tsc and strict mypy.',
      stats: [
        { big: passed, label: 'offline tests passed' },
        { big: '0', label: 'type errors' },
      ],
    });
    const OUTRO = slide({
      eyebrow: 'Who it is for',
      title: 'DisputeShield AI',
      lead: 'Open source, MIT.',
      cards: [
        { kicker: 'For', title: 'The one-person shop', body: 'Sells on PayPal, ships real parcels, has no team for chargebacks.' },
        { kicker: 'It does', title: 'Finds the proof', body: 'Reads receipts, scores the case, drafts the dossier and the note.' },
        { kicker: 'You decide', title: 'Fight or settle', body: 'A clear recommendation. The final click stays yours.' },
      ],
      links: [`Code: ${REPO_URL}`],
    });

    // ---- 7. filming ----
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, colorScheme: 'light', recordVideo: { dir: REC, size: { width: 1280, height: 720 } } });
    const page: Page = await ctx.newPage();
    const t0 = Date.now();
    const now = () => Date.now() - t0;
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${m.type()}: ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    let onSlide = true;

    async function mountHud() {
      await page.evaluate(({ css, html }) => {
        document.getElementById('demo-style-hud')?.remove();
        document.getElementById('demo-style-hud-css')?.remove();
        const st = document.createElement('style');
        st.id = 'demo-style-hud-css';
        st.textContent = css;
        document.documentElement.appendChild(st);
        const d = document.createElement('div');
        d.id = 'demo-style-hud';
        d.innerHTML = html;
        document.body.appendChild(d);
      }, { css: HUD_CSS, html: hudHtml(pack) });
    }
    async function caption(text: string, step: string) {
      if (!(await page.locator('#demo-cap').count())) await mountHud();
      await page.evaluate(({ text, step }) => {
        const cap = document.getElementById('demo-cap');
        const badge = document.getElementById('demo-step');
        if (badge && badge.textContent !== step) {
          badge.textContent = step;
          badge.classList.remove('pop');
          void badge.offsetWidth;
          badge.classList.add('pop');
        }
        if (cap) {
          cap.replaceChildren();
          for (const [i, word] of text.split(/\s+/).filter(Boolean).entries()) {
            const s = document.createElement('span');
            s.textContent = word;
            s.style.animationDelay = `${(i * 0.045).toFixed(3)}s`;
            cap.appendChild(s);
          }
        }
      }, { text, step });
    }
    /** Plays a line. Each step runs at its share of the line (0..1); the line always plays out in full. */
    async function narrate(key: Key, steps: [number, () => Promise<unknown>][] = []) {
      const c = N[key];
      const line = LINES[key] as { cap?: string; step?: string };
      const at = now();
      clips.push({ file: c.file, at });
      if (!onSlide && line.cap) await caption(line.cap, line.step ?? '');
      for (const [share, fn] of steps) {
        await Bun.sleep(Math.max(0, at + c.ms * share - now()));
        await fn();
      }
      await Bun.sleep(Math.max(0, c.ms - (now() - at)) + 450);
    }
    /** A wait on the model with no voice playing: everything but `keep` ms of it is cut from the video. */
    async function waitCut<T>(fn: () => Promise<T>, keep = 1400): Promise<T> {
      const a = now();
      const r = await fn();
      const b = now();
      if (b - a > keep + 600) cuts.push({ from: a + keep / 2, to: b - keep / 2 });
      return r;
    }
    async function show(html: string) {
      // a fresh document first: setContent keeps the window, so the console's timers would keep polling a page that is gone
      if (!onSlide) await page.goto('about:blank');
      onSlide = true;
      await page.setContent(html, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
    }
    async function go(url: string) {
      onSlide = false;
      await page.goto(url);
      await page.getByText(/Disputes/).first().waitFor();
      await mountHud();
    }
    const scrollTo = (panel: Locator, sel: string, block: ScrollLogicalPosition = 'start') =>
      panel.locator(sel).first().evaluate((el, block) => el.scrollIntoView({ behavior: 'smooth', block }), block);
    const spot = (loc: Locator, on: boolean) => loc.evaluate((el, on) => el.classList.toggle('demo-spot', on), on);
    async function openCase(id: string): Promise<Locator> {
      await page.locator(`.ag-row[row-id="${id}"] [col-id="reason"]`).click();
      const panel = page.getByRole('dialog', { name: `Dispute ${id}` });
      await panel.waitFor(WAIT);
      return panel;
    }
    /** Both the receipt read and the note must say "AI · qwen3:8b · live": never narrate a fallback as AI. */
    async function expectLive(panel: Locator, id: string) {
      await panel.getByRole('heading', { name: 'Extracted evidence' }).waitFor(WAIT);
      await panel.locator('#dossier-sec .card-head .badge').waitFor(WAIT);
      const badges = (await panel.locator('.card-head .badge').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
      const want = `AI · ${MODEL} · live`;
      if (badges.length < 2 || badges.some((b) => b !== want)) {
        throw new NotLive(`case ${id}: the panel shows ${JSON.stringify(badges)}, wanted every badge to be "${want}". Ollama may have timed out; rerun in a quiet window`);
      }
    }
    /** Simulate chargeback pinned to one scenario; the POST answers once the model has read the receipt. */
    async function simulateStart(scenario: string) {
      await page.setExtraHTTPHeaders({ 'X-Demo-Scenario': scenario });
      const res = page.waitForResponse((r) => r.url().endsWith('/api/demo/chargeback'), WAIT);
      await page.locator('#simulate-btn').click();
      return res;
    }

    // -- title card --
    await show(TITLE);
    await Bun.sleep(700);
    await narrate('title');

    // -- the console, Simulate chargeback --
    await go(`${A}/#token=${TOKEN}`);
    await page.getByText('Demo mode', { exact: true }).waitFor();
    await page.locator('.ag-row').nth(2).waitFor(WAIT);
    let pending: ReturnType<typeof simulateStart> | undefined;
    await narrate('console', [
      [0.62, async () => { await page.locator('#simulate-btn').hover(); }],
      [0.7, async () => { pending = simulateStart('leeds'); }],
    ]);
    const id = await waitCut(async () => {
      const res = await pending!;
      if (!res.ok()) throw new Error(`demo chargeback answered ${res.status()}`);
      const id = ((await res.json()) as { id: string }).id;
      const row = page.locator(`.ag-row[row-id="${id}"]`);
      await row.locator('[col-id="win"]').filter({ hasText: '95%' }).waitFor(WAIT);
      return id;
    });
    const row = page.locator(`.ag-row[row-id="${id}"]`);
    if (!(await row.getAttribute('class'))?.includes('row-contested')) throw new Error('the new row is not highlighted as contested');
    await page.mouse.move(640, 690);
    await narrate('row', [[0.15, () => spot(row, true)]]);
    await spot(row, false);

    // -- the live read --
    const panel = await openCase(id);
    await waitCut(() => expectLive(panel, id));
    await panel.getByText('1Z999AA10123456784', { exact: true }).waitFor();
    const readBadge = panel.locator('#evidence-box .card-head .badge').first();
    await narrate('evidence', [
      [0.08, () => scrollTo(panel, '#h-evidence')],
      [0.3, () => spot(readBadge, true)],
      [0.62, () => spot(readBadge, false)],
    ]);

    // -- the score --
    const shown = (await panel.locator('.score-num').first().innerText()).trim();
    if (shown !== '95%') throw new Error(`narration says 95%, the panel shows ${shown}`);
    await narrate('score', [
      [0.02, () => scrollTo(panel, '#h-score')],
      [0.35, () => scrollTo(panel, '.factors .factor.base')],
      [0.75, () => spot(panel.locator('.score-num').first(), true)],
    ]);
    await spot(panel.locator('.score-num').first(), false);

    // -- dossier and note --
    await narrate('dossier', [
      [0.02, () => scrollTo(panel, '#h-dossier')],
      [0.3, () => spot(panel.locator('#dossier-sec .card').first(), true)],
      [0.85, () => spot(panel.locator('#dossier-sec .card').first(), false)],
    ]);

    // -- submit, labelled demo mode --
    await narrate('submit', [
      [0.12, async () => {
        await panel.getByRole('button', { name: 'Submit evidence' }).click();
        await panel.getByText('Demo mode: nothing was sent to PayPal').waitFor(WAIT);
        await panel.getByRole('button', { name: 'Evidence submitted' }).waitFor();
      }],
      [0.4, () => spot(panel.getByText('Demo mode: nothing was sent to PayPal').locator('..'), true)],
    ]);
    await panel.getByRole('button', { name: /Close/ }).click();
    await row.locator('[col-id="status"]').filter({ hasText: 'Under review' }).waitFor(WAIT);

    // -- a weaker case: the advice is a refund offer --
    const weakRes = await waitCut(async () => {
      const res = await simulateStart('bristol');
      if (!res.ok()) throw new Error(`demo chargeback answered ${res.status()}`);
      return res;
    });
    const weakId = ((await weakRes.json()) as { id: string }).id;
    await page.locator(`.ag-row[row-id="${weakId}"]`).waitFor(WAIT);
    const weak = await openCase(weakId);
    await waitCut(() => expectLive(weak, weakId));
    const weakPct = (await weak.locator('.score-num').first().innerText()).trim();
    if (weakPct !== '44%') throw new Error(`narration says 44%, the weak case shows ${weakPct}`);
    const pill = (await weak.locator('.rec-pill').innerText()).trim();
    if (pill !== 'Offer refund') throw new Error(`narration says a refund offer, the panel recommends "${pill}"`);
    await narrate('weak', [
      [0.05, () => scrollTo(weak, '#h-score')],
      [0.25, () => scrollTo(weak, '.factors .factor.unmet', 'center')],
      [0.72, () => scrollTo(weak, '#h-score')],
      [0.78, () => spot(weak.locator('.rec').first(), true)],
    ]);

    // -- server B: demo mode off, sandbox keys, a real Invoicing v2 call --
    await go(`${B}/#token=${TOKEN}`);
    await page.locator(`.ag-row[row-id="${invoiceCase}"]`).waitFor(WAIT);
    const inv = await openCase(invoiceCase);
    await inv.getByRole('heading', { name: 'Extracted evidence' }).waitFor(WAIT);
    await scrollTo(inv, '#h-invoice');
    let invoiceNo = '';
    await narrate('invoice', [
      [0.3, async () => {
        const answered = page.waitForResponse((r) => r.url().endsWith('/paypal-invoice') && r.request().method() === 'POST', { timeout: 60_000 });
        await inv.getByRole('button', { name: 'Record as PayPal invoice' }).click();
        const res = await answered;
        if (!res.ok()) throw new Error(`PayPal sandbox invoice call failed (${res.status()}): ${await res.text()}`);
        invoiceNo = ((await res.json()) as { invoice_id: string }).invoice_id;
        const banner = inv.locator('#invoice-box .banner');
        await banner.getByText('Recorded on PayPal sandbox').waitFor({ timeout: 10_000 });
        await banner.getByText('Simulated case · invoice call live on sandbox').waitFor({ timeout: 10_000 });
        await banner.evaluate((b) => b.scrollIntoView({ behavior: 'smooth', block: 'center' }));
      }],
      [0.6, () => spot(inv.locator('#invoice-box .banner'), true)],
    ]);

    // -- how, tests, outro --
    await show(HOW);
    await narrate('how');
    await show(TESTS);
    await narrate('tests');
    await show(OUTRO);
    await narrate('outro');
    await Bun.sleep(1500);

    if (errors.length) throw new Error(`the console logged errors while filming:\n${errors.join('\n')}`);
    secs = now() / 1000;
    await ctx.close();
    await browser.close();
    webm = join(REC, readdirSync(REC).find((f) => f.endsWith('.webm'))!);
    copyFileSync(webm, join(OUT, 'demo-raw.webm'));
    console.log(`sandbox draft invoice: ${invoiceNo}`);
  } finally {
    await browser?.close().catch(() => undefined);
    for (const s of servers) s.kill();
  }
    break;
  } catch (e) {
    if (!(e instanceof NotLive) || tryNo >= TRIES) throw e;
    console.log(`take ${tryNo} not live (${e.message.slice(0, 160)}): filming again`);
  }
}

// ---- 8. edit and mix: drop the long model waits, lay the voice on top of a quiet synthesized bed that ducks under it ----
const cutMs = (t: number) => cuts.filter((c) => c.to <= t).reduce((s, c) => s + (c.to - c.from), 0);
for (const c of clips) if (cuts.some((k) => c.at > k.from && c.at < k.to)) throw new Error('a voice line starts inside a cut');
const total = secs - cutMs(Infinity) / 1000;
const keep = cuts.length
  ? `select='not(${cuts.map((c) => `between(t,${(c.from / 1000).toFixed(3)},${(c.to / 1000).toFixed(3)})`).join('+')})',setpts=N/30/TB,`
  : '';
// Original bed: a slow two-chord pad (A major 7 / F#m7) with a soft plucked arpeggio on top, low-passed and quiet.
const chord = (f: number[]) => f.map((hz, i) => `${(0.5 / (i + 1)).toFixed(2)}*sin(2*PI*${hz}*t+0.6*sin(2*PI*0.13*t))`).join('+');
const pluck = (hz: number, off: number) => `0.18*sin(2*PI*${hz}*t)*exp(-3*mod(t+${off},2))`;
const bed = `aevalsrc='(0.5+0.5*cos(2*PI*t/16))*(${chord([220, 277.18, 329.63, 415.3])})+(0.5-0.5*cos(2*PI*t/16))*(${chord([185, 220, 277.18, 329.63])})`
  + `+${pluck(440, 0)}+${pluck(554.37, 1)}':s=48000:d=${total.toFixed(2)},`
  + `lowpass=f=1300,aecho=0.8:0.6:220|440:0.25|0.15,volume=0.03,afade=t=in:d=2.5,afade=t=out:st=${(total - 3).toFixed(2)}:d=3[pad]`;
const inputs = clips.flatMap((c) => ['-i', c.file]);
const voices = clips.map((c, i) => { const at = Math.round(c.at - cutMs(c.at)); return `[${i + 1}:a]aresample=48000,adelay=${at}|${at}[a${i}]`; }).join(';')
  + `;${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length}:normalize=0,asplit[v1][v2]`;
const mix = `${voices};${bed};[pad][v2]sidechaincompress=threshold=0.012:ratio=8:attack=20:release=700[duck];[v1][duck]amix=inputs=2:normalize=0,alimiter=limit=0.9[aud]`;
const ff = Bun.spawnSync(['ffmpeg', '-y', '-v', 'error', '-i', webm, ...inputs, '-filter_complex', `[0:v]fps=30,${keep}scale=1920:1080:flags=lanczos[v];${mix}`,
  '-map', '[v]', '-map', '[aud]', '-t', total.toFixed(2), '-c:v', 'libx264', '-crf', '17', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', out], { stderr: 'inherit' });
if (ff.exitCode) throw new Error('ffmpeg failed');

// ---- 9. checks on the finished file ----
const probe = JSON.parse(Bun.spawnSync(['ffprobe', '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', out]).stdout.toString());
const v = probe.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
const a = probe.streams.find((s: { codec_type: string }) => s.codec_type === 'audio');
const dur = Number(probe.format.duration);
const failures = [
  v?.width !== 1920 && `width ${v?.width}`,
  v?.height !== 1080 && `height ${v?.height}`,
  v?.codec_name !== 'h264' && `video codec ${v?.codec_name}`,
  !a && 'no audio stream',
  !(dur >= 90 && dur <= MAX_SECS) && `duration ${dur.toFixed(1)} s, wanted 90 to ${MAX_SECS}`,
].filter(Boolean);
if (failures.length) { console.error(`demo video failed: ${failures.join('; ')}`); process.exit(1); }
console.log(`cut ${(cutMs(Infinity) / 1000).toFixed(1)} s of model waits in ${cuts.length} place(s)`);
console.log(`demo video: ${out} (${v.width}x${v.height} ${v.codec_name}, ${a.codec_name} audio, ${dur.toFixed(1)} s)`);
