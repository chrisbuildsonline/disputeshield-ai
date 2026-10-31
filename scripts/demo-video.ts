// Records the demo video (about 2.5 min) with an edge-tts voice track and a quiet synthesized pad: the problem and who pays,
// two real runs in the actual console (one by click, one by autopilot), how it works, and the real test counts.
// Needs bun, uv (uvicorn and pytest in .venv, edge-tts via uvx), Ollama with qwen3:8b, ffmpeg/ffprobe and Playwright's chromium (bun run e2e:install).
// Runs its own server on a free port in demo mode with a throwaway database. The LLM is on: if Ollama is not reachable it stops instead of narrating AI that did not run.
// bun run demo:video -> out/disputeshield-demo.mp4
import { chromium, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const TMP = mkdtempSync(join(tmpdir(), 'ds-demo-'));
const OUT = join(ROOT, 'out');
const VOICE = 'en-US-AndrewNeural';
const REPO_URL = 'https://github.com/chrisbuildsonline/disputeshield-ai';
const TOKEN = 'demo-video-token';
const MODEL = process.env.DISPUTESHIELD_OLLAMA_MODEL || 'qwen3:8b';
const OLLAMA = process.env.OLLAMA_HOST || 'http://localhost:11434';
type Clip = { file: string; ms: number };

let n = 0;
let queue: Promise<unknown> = Promise.resolve();
// one edge-tts at a time: parallel uvx runs stall each other
const tts = (text: string): Promise<Clip> => {
  const next = queue.then(() => speak(text));
  queue = next.catch(() => undefined);
  return next;
};
async function speak(text: string): Promise<Clip> {
  const file = join(TMP, `${String(n++).padStart(3, '0')}.mp3`);
  // edge-tts sometimes stalls on the network: give each try 60 s, three tries.
  for (let tryNo = 1; ; tryNo++) {
    const p = Bun.spawn(['timeout', '60', 'uvx', 'edge-tts', '--voice', VOICE, '--rate=+8%', '--text', text, '--write-media', file], { stdout: 'pipe', stderr: 'pipe' });
    const code = await p.exited;
    if (!code) break;
    if (tryNo === 3) throw new Error(`edge-tts exited ${code}: ${await new Response(p.stderr).text()} ${await new Response(p.stdout).text()}`);
  }
  const d = Bun.spawnSync(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return { file, ms: Math.round(Number(d.stdout.toString()) * 1000) };
}

function run(cmd: string[]) {
  const p = Bun.spawnSync(cmd, { cwd: ROOT, env: { ...process.env, CI: '1' } });
  const out = p.stdout.toString() + p.stderr.toString();
  if (p.exitCode) throw new Error(`${cmd.join(' ')} failed:\n${out.slice(-2000)}`);
  return out;
}
const grab = (text: string, re: RegExp, what: string) => {
  const m = text.match(re);
  if (!m) throw new Error(`could not read ${what} from the test output`);
  return m[1]!;
};

// ---- 1. real gate results, shown on the tests slide (the video is not made from a red build) ----
console.log('running the gates...');
const tests = run(['bun', 'run', 'test']);
run(['bun', 'run', 'typecheck']);
const pyPassed = grab(tests, /(\d+) passed/, 'pytest passes');
console.log(`pytest ${pyPassed} passed`);

// ---- 2. the model must really be there: load it now so the recording does not wait on a cold start ----
const warm = await fetch(`${OLLAMA}/api/generate`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: MODEL, prompt: 'ok', stream: false, keep_alive: '30m', options: { num_predict: 1 } }),
  signal: AbortSignal.timeout(180_000),
}).catch((e: unknown) => { throw new Error(`Ollama is not reachable at ${OLLAMA} (${String(e)}): run bun run llm:start and bun run llm:pull`); });
if (!warm.ok) throw new Error(`Ollama has no ${MODEL} (${warm.status}): run bun run llm:pull`);

// ---- 3. our own server: free port, demo mode, throwaway database, fixed token, LLM on ----
const probePort = Bun.serve({ port: 0, fetch: () => new Response('') });
const PORT = probePort.port;
await probePort.stop(true);
const BASE = `http://127.0.0.1:${PORT}`;
const server = Bun.spawn([join(ROOT, '.venv/bin/uvicorn'), 'app.main:app', '--port', String(PORT)], {
  cwd: ROOT,
  env: {
    ...process.env,
    DISPUTESHIELD_DEMO_MODE: '1',
    DISPUTESHIELD_DB: join(TMP, 'demo.db'),
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
let secs = '0';
let webm = '';
const clips: { file: string; at: number }[] = [];
const out = join(OUT, 'disputeshield-demo.mp4');
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
    if (i > 100) throw new Error('server did not start');
    await Bun.sleep(200);
  }

  // ---- 4. slides ----
  const CSS = `
:root{--ink:#e6edf7;--dim:#9db0c8;--line:#26354d;--a1:#60a5fa;--ok:#34d399;--hot:#fb7185}
*{box-sizing:border-box}
body{margin:0;height:100vh;background:#0a1220;color:var(--ink);font:19px/1.45 Inter,system-ui,sans-serif;overflow:hidden}
body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 60% 50% at 85% 0%,#12305c 0%,transparent 70%),radial-gradient(ellipse 50% 40% at 0% 100%,#0b2f3a 0%,transparent 70%);z-index:-1}
.stage{position:absolute;inset:0;padding:40px 56px 56px;display:flex;flex-direction:column;animation:enter .7s cubic-bezier(.2,.7,.2,1) both}
@keyframes enter{from{opacity:0;transform:translateY(14px)}}
.eyebrow{font:600 13px Inter,system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:var(--a1);margin-bottom:6px}
h1{font:700 36px/1.15 Inter,system-ui,sans-serif;letter-spacing:-.02em;margin:0 0 8px}
.lead{color:var(--dim);margin:0 0 22px;font-size:18px}
.card{background:#111c30;border:1px solid var(--line);border-radius:16px;padding:16px 20px}
.card b{font-weight:600}
.cols{display:grid;gap:18px}
.in{animation:enter .6s cubic-bezier(.2,.7,.2,1) both}
.mono{font:15px/1.6 ui-monospace,'JetBrains Mono',monospace}
.chip{display:inline-block;font:500 13px ui-monospace,monospace;background:#10264a;color:#bfdbfe;border:1px solid #1e4a8a;border-radius:8px;padding:2px 8px;margin:4px 4px 0 0}
.dim{color:var(--dim);font-size:16px}
.big{font:700 64px/1 Inter,system-ui,sans-serif;letter-spacing:-.03em;color:var(--ok)}
`;
  const slide = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body><div class="stage">${body}</div></body></html>`;
  const card = (d: number, inner: string) => `<div class="card in" style="animation-delay:${d}s">${inner}</div>`;

  const TITLE = slide(`<div class="eyebrow">Built for the PayPal AI Hackathon</div><h1 style="font-size:56px">DisputeShield AI</h1>
<p class="lead" style="font-size:22px">Chargeback defense for PayPal merchants</p>
<div class="cols" style="grid-template-columns:1fr 1fr 1fr;flex:1;align-content:start">
  ${card(0.6, `<div class="eyebrow">The problem</div><b>Merchants lose chargebacks they could win.</b><p class="dim">The proof is in a carrier receipt, but building the evidence by hand is slow, and an unanswered dispute is a lost dispute.</p>`)}
  ${card(1.2, `<div class="eyebrow">Who it is for</div><b>Small online merchants on PayPal</b><p class="dim">Shops that sell goods and ship them with a carrier, without a team to chase disputes.</p>`)}
  ${card(1.8, `<div class="eyebrow">Why it matters</div><b>A lost sale, plus a fee</b><p class="dim">Every lost dispute costs the order and the dispute fee on top of it.</p>`)}
</div>`);

  const step = (d: number, name: string, role: string, detail: string) => card(d, `<div class="eyebrow">${name}</div><b>${role}</b><p class="dim" style="margin:6px 0 0;font-size:14.5px">${detail}</p>`);
  const HOW = slide(`<div class="eyebrow">How it works</div><h1>Local AI reads, plain arithmetic decides</h1><p class="lead">The model never has a say in the score.</p>
<div class="cols" style="grid-template-columns:repeat(3,1fr)">
  ${step(0.3, 'PayPal', 'Disputes API and webhooks', 'Webhooks are checked with PayPal&rsquo;s <span class="chip">verify-webhook-signature</span> call. Evidence goes out through <span class="chip">provide-evidence</span>.')}
  ${step(0.9, 'Local AI with guards', 'qwen3:8b on Ollama', 'Facts not found in the PDF text are dropped. If the model is down, a <span class="chip">regex</span> parser and a <span class="chip">template</span> note take over.')}
  ${step(1.5, 'Deterministic scoring', 'A fixed rulebook', 'Base plus the weight of every proof factor that is met, between 0 and 100. Same input, same score.')}
  ${step(2.1, 'AG Grid console', 'One table, one panel', 'Every dispute, its evidence, score and audit trail.')}
  ${step(2.7, 'Operator token', 'The app never runs open', 'Every <span class="chip">/api</span> route needs the token.')}
  ${step(3.3, 'Docker', 'docker compose up', 'Runs with no keys in demo mode.')}
</div>`);

  const TESTS = slide(`<div class="eyebrow">Run just now, before this recording</div><h1>Tested</h1><p class="lead">The numbers come from the run that preceded this video.</p>
<div class="cols" style="grid-template-columns:repeat(2,1fr)">
  ${card(0.3, `<div class="big">${pyPassed}</div><p class="dim">pytest tests passed</p>`)}
  ${card(1.0, `<div class="big">0</div><p class="dim">type errors: tsc and strict mypy clean</p>`)}
</div>
<div class="card in mono" style="margin-top:22px;animation-delay:1.8s">$ bun run test &nbsp;<span style="color:var(--ok)">&#10003; ${pyPassed} passed</span><br>$ bun run typecheck &nbsp;<span style="color:var(--ok)">&#10003; no errors</span></div>`);

  const OUTRO = slide(`<div style="margin:auto;text-align:center">
  <h1 class="in" style="font-size:56px">DisputeShield AI</h1>
  <p class="lead in" style="font-size:22px;animation-delay:.4s">Do not lose the chargebacks you could win.</p>
  <div class="card in mono" style="display:inline-block;text-align:left;animation-delay:.9s">Code: ${REPO_URL}</div>
</div>`);

  // ---- 5. voice lines, synthesized up front so the recording never waits on edge-tts ----
  const N = {
    title: tts('DisputeShield AI defends PayPal chargebacks for small online merchants. When a buyer says an item never arrived, the proof is usually sitting in a carrier receipt. But writing it up by hand is slow, and an unanswered dispute is a lost dispute: the merchant loses the sale, and pays a fee on top. DisputeShield reads the evidence, scores the case, and sends it.'),
    simulate: tts('Here is the real console, running on my machine in demo mode. I click Simulate chargeback. A new item not received dispute for forty nine ninety lands in the AG Grid table, highlighted red because it is contested and still needs an answer. It arrives with a UPS receipt as a PDF, and the win probability is already one hundred percent.'),
    evidence: tts('Opening the dispute shows what the AI read from the UPS receipt. A local model, qwen three eight b, running on Ollama, pulls out the carrier, the tracking number, the delivery time, the address and the signature. The badge says which model did the reading. A tracking number that is not in the PDF text is dropped, so the model cannot invent one.'),
    score: tts('The win probability is not the model\'s opinion. A fixed rulebook adds points for each piece of proof: tracking, delivery confirmed, delivered to the billing address, a signature, a matching amount, and the order id. Here it comes to one hundred percent. The rebuttal note is written from the same facts, and fact checked before it is used.'),
    submit: tts('One click on Submit evidence sends the dossier. This is demo mode, so nothing leaves the machine, and the panel says so in plain words. With sandbox keys, the same click calls the PayPal provide evidence endpoint.'),
    audit: tts('Every step lands in the audit trail: the chargeback received, the document added, and the evidence submitted. The status is now under review, and the row is no longer red.'),
    autopilot: tts('Now autopilot. I switch it on, with the threshold at eighty five, and simulate another chargeback. I click nothing else. The agent scores the case at one hundred, above the threshold, and submits it by itself, with each step in the audit trail. Below the threshold it would flag the case as needs review instead.'),
    how: tts('How it works. Disputes arrive as PayPal webhooks, checked with PayPal\'s signature verification, and evidence goes back through the Disputes API. The AI is local, qwen three on Ollama, with guards that drop facts not found in the PDF, and a fallback if the model is down. The score is deterministic arithmetic. Every API route needs an operator token, and the app runs in Docker.'),
    tests: tts(`Before this recording, the test suite ran. ${pyPassed} Python tests passed, and the type checks are clean.`),
    outro: tts('DisputeShield AI. Do not lose the chargebacks you could win. The code is on GitHub, the link is on screen.'),
  };

  await Promise.all(Object.values(N));

  // ---- 6. recording ----
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, colorScheme: 'dark', recordVideo: { dir: TMP, size: { width: 1280, height: 720 } } });
  const page: Page = await ctx.newPage();
  const t0 = Date.now();
  const now = () => Date.now() - t0;
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  // Plays a narration clip; the steps run spread across it (for reveals in sync with the voice).
  async function narrate(clip: Promise<Clip>, steps: (() => Promise<unknown>)[] = []) {
    const c = await clip;
    const at = now();
    clips.push({ file: c.file, at });
    for (const s of steps) { await s(); await Bun.sleep(c.ms / (steps.length + 1)); }
    await Bun.sleep(Math.max(0, c.ms - (now() - at)) + 350);
  }
  async function show(html: string) {
    await page.setContent(html, { waitUntil: 'load' });
  }
  const glide = (selector: string) => page.locator(selector).evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  const WAIT = { timeout: 120_000 };
  async function simulate(): Promise<string> {
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/demo/chargeback'), WAIT),
      page.getByRole('button', { name: 'Simulate chargeback' }).click(),
    ]);
    return ((await res.json()) as { id: string }).id;
  }
  const detail = (id: string) => page.getByRole('dialog', { name: `Dispute ${id}` });

  await show(TITLE);
  await Bun.sleep(900);
  await narrate(N.title);

  // simulate: the contested row, red, 100%
  await page.goto(`${BASE}/#token=${TOKEN}`);
  await page.getByText('Demo mode', { exact: true }).waitFor();
  let id = '';
  await narrate(N.simulate, [
    async () => {
      id = await simulate();
      const row = page.locator(`.ag-row[row-id="${id}"]`);
      await row.waitFor(WAIT);
      const win = await row.locator('[col-id="win"]').filter({ hasText: '100%' }).waitFor(WAIT).then(() => '100%', () => 'not 100%');
      if (win !== '100%') throw new Error(`narration says 100%, the grid shows ${await row.locator('[col-id="win"]').innerText()}`);
      if (!(await row.getAttribute('class'))?.includes('row-contested')) throw new Error('the new row is not highlighted as contested');
    },
  ]);

  // evidence read by the local model, then the score
  const panel = detail(id);
  await narrate(N.evidence, [
    async () => {
      await page.locator(`.ag-row[row-id="${id}"] [col-id="reason"]`).click();
      await panel.waitFor();
      await panel.getByRole('heading', { name: 'Extracted evidence' }).waitFor(WAIT);
      const badge = (await panel.locator('#h-evidence + .card .badge-ai').first().innerText({ timeout: 120_000 }).catch(() => '')).trim();
      if (!badge.includes('AI') || !badge.includes(MODEL)) {
        throw new Error(`the evidence was not read by ${MODEL} (badge: "${badge || 'none'}"): refusing to narrate AI that did not run`);
      }
      await panel.getByText('1Z999AA10123456784', { exact: true }).waitFor();
      await glide('#h-evidence');
    },
  ]);
  await narrate(N.score, [
    async () => {
      const shown = await panel.locator('.score-num').first().innerText();
      if (shown.trim() !== '100%') throw new Error(`narration says 100%, the panel shows ${shown}`);
      await glide('#h-score');
    },
    () => glide('#h-dossier'),
  ]);

  // one-click submit, labelled simulated
  await narrate(N.submit, [
    async () => {
      await glide('#h-dossier');
      await panel.getByRole('button', { name: 'Submit evidence' }).click();
      await panel.getByText('Demo mode: nothing was sent to PayPal').waitFor(WAIT);
      await panel.getByRole('button', { name: 'Evidence submitted' }).waitFor();
    },
  ]);

  await narrate(N.audit, [
    async () => {
      await panel.getByText('Evidence submitted (demo mode, not sent to PayPal)').waitFor();
      await glide('#h-audit');
    },
    async () => {
      await panel.getByRole('button', { name: /Close/ }).click();
      const row = page.locator(`.ag-row[row-id="${id}"]`);
      await row.locator('[col-id="status"]').filter({ hasText: 'Under review' }).waitFor(WAIT);
    },
  ]);

  // autopilot: the next chargeback submits by itself
  let id2 = '';
  await narrate(N.autopilot, [
    async () => {
      const toggle = page.getByRole('switch', { name: 'Autopilot' });
      await toggle.check();
      const state = await page.request.get(`${BASE}/api/autopilot`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      const s = (await state.json()) as { enabled: boolean; threshold: number };
      if (!s.enabled || s.threshold !== 85) throw new Error(`autopilot is ${JSON.stringify(s)}`);
    },
    async () => {
      id2 = await simulate();
      const row = page.locator(`.ag-row[row-id="${id2}"]`);
      await row.locator('[col-id="status"]').filter({ hasText: 'Under review' }).waitFor(WAIT);
      if (!(await row.getAttribute('class'))?.includes('row-submitted')) throw new Error('autopilot did not submit the second chargeback');
    },
    async () => {
      await page.locator(`.ag-row[row-id="${id2}"] [col-id="reason"]`).click();
      const p2 = detail(id2);
      await p2.getByText('Autopilot submitted the evidence').waitFor(WAIT);
      await p2.getByText(/Autopilot scored the case 100% \(threshold 85%\)/).waitFor();
      await glide('#h-audit');
    },
  ]);

  await show(HOW);
  await narrate(N.how);
  await show(TESTS);
  await narrate(N.tests);
  await show(OUTRO);
  await narrate(N.outro);
  await Bun.sleep(1200);

  if (errors.length) throw new Error(`the console logged errors while recording:\n${errors.join('\n')}`);
  secs = (now() / 1000).toFixed(2);
  await ctx.close();
  await browser.close();
  webm = join(TMP, readdirSync(TMP).find((f) => f.endsWith('.webm'))!);
} finally {
  server.kill();
}

// ---- 7. mix: voice + a quiet synthesized pad (no licensed music) that ducks under speech; encode ----
mkdirSync(OUT, { recursive: true });
// Two soft chords crossfading every 8 s, low-passed, with a slow swell and a touch of echo.
const chord = (f: number[]) => f.map((hz, i) => `${(0.5 / (i + 1)).toFixed(2)}*sin(2*PI*${hz}*t+0.6*sin(2*PI*0.13*t))`).join('+');
const pad = `aevalsrc='(0.5+0.5*cos(2*PI*t/16))*(${chord([220, 277.18, 329.63, 493.88])})+(0.5-0.5*cos(2*PI*t/16))*(${chord([185, 220, 277.18, 329.63])})':s=48000:d=${secs},`
  + `lowpass=f=1100,aecho=0.8:0.6:180|360:0.25|0.15,volume=0.022,afade=t=in:d=2.5,afade=t=out:st=${(Number(secs) - 3).toFixed(2)}:d=3[pad]`;
const inputs = clips.flatMap((c) => ['-i', c.file]);
const voices = clips.map((c, i) => `[${i + 1}:a]adelay=${c.at}|${c.at}[a${i}]`).join(';')
  + `;${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length}:normalize=0,asplit[v1][v2]`;
const mix = `${voices};${pad};[pad][v2]sidechaincompress=threshold=0.015:ratio=6:attack=30:release=600[duck];[v1][duck]amix=inputs=2:normalize=0,alimiter=limit=0.9[aud]`;
const ff = Bun.spawnSync(['ffmpeg', '-y', '-v', 'error', '-i', webm, ...inputs, '-filter_complex', `[0:v]scale=1920:1080:flags=lanczos,fps=30[v];${mix}`,
  '-map', '[v]', '-map', '[aud]', '-c:v', 'libx264', '-crf', '17', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', out], { stderr: 'inherit' });
if (ff.exitCode) throw new Error('ffmpeg failed');

// ---- 8. assertions on the finished file ----
const probe = JSON.parse(Bun.spawnSync(['ffprobe', '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', out]).stdout.toString());
const v = probe.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
const a = probe.streams.find((s: { codec_type: string }) => s.codec_type === 'audio');
const dur = Number(probe.format.duration);
const failures = [
  v?.width !== 1920 && `width ${v?.width}`,
  v?.height !== 1080 && `height ${v?.height}`,
  v?.codec_name !== 'h264' && `video codec ${v?.codec_name}`,
  !a && 'no audio stream',
  !(dur >= 100 && dur <= 175) && `duration ${dur.toFixed(1)} s, wanted 100 to 175`,
].filter(Boolean);
if (failures.length) { console.error(`demo video failed: ${failures.join('; ')}`); process.exit(1); }
console.log(`demo video: ${out} (${v.width}x${v.height} ${v.codec_name}, ${a.codec_name} audio, ${dur.toFixed(1)} s)`);
