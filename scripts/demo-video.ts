// Records the demo video (under 3 min) in the story-cards look, narrated by Chris's American voice clone over an
// original music bed. Every product shot is the real console, driven by Playwright inside a browser window on the
// demo-styles stage (1080p, moving cursor, zoom onto what the voice is about):
// a small shop gets an "item not received" dispute, the live qwen3:8b read of the carrier receipt, the rule-based score,
// the dossier and note, Submit (demo mode, nothing sent to PayPal), a weaker case that gets a refund offer, and a real
// PayPal Invoicing sandbox call on a second server with demo mode off.
// Needs bun, uv (.venv), Ollama with qwen3:8b, the voice-clone venv, ffmpeg/ffprobe, Playwright's chromium, and the
// sandbox keys in .env (PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_API_BASE on the sandbox) for the invoice shot.
// Waits for a quiet window on the shared Ollama before filming: the AI scenes refuse to run on a fallback read.
// Long waits for the model (no voice playing) are cut from the video; a short piece of each wait stays in.
// bun run demo:video -> out/disputeshield-demo.mp4 (plus out/demo-narration.txt, the lines and the wav files used)
// --rehearse: the same take with the model off (no Ollama wait, no live checks) -> out/rehearsal.mp4, to check look and sound
// --remix: new music and a new edit from what is already in out/stems, no filming
// The edit is made in Concat (the user's editor) when it is installed: a project with picture, voice and music on their own lanes
import { chromium, type Browser, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { concatEdit } from '../../../demo-styles/concat.mjs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeBed } from '../../../demo-styles/music.mjs';
import { loadPack, resolveStyles, slideHtml } from '../../../demo-styles/render.mjs';
import { stageHtml, startScreencast, writeConcat, type Frame } from '../../../demo-styles/stage.mjs';

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
const VOICE_LUFS = -16; // every line is levelled to this before the mix
const BED_UNDER = Number(process.env.DEMO_MUSIC_UNDER_DB || 14); // the music sits this many dB (LUFS) under the voice, steady
const ZOOM_MS = 1150; // the stage's zoom transition, plus a frame
const REHEARSE = process.argv.includes('--rehearse');
const REMIX = process.argv.includes('--remix');
const STEMS = join(OUT, REHEARSE ? 'stems-rehearsal' : 'stems');
const out = join(OUT, REHEARSE ? 'rehearsal.mp4' : 'disputeshield-demo.mp4');
type Clip = { file: string; ms: number };

function run(cmd: string[]) {
  const p = Bun.spawnSync(cmd, { cwd: ROOT, env: { ...process.env, CI: '1' } });
  const out = p.stdout.toString() + p.stderr.toString();
  if (p.exitCode) throw new Error(`${cmd.join(' ')} failed:\n${out.slice(-2000)}`);
  return out;
}
const durationMs = (file: string) =>
  Math.round(Number(Bun.spawnSync(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).stdout.toString()) * 1000);
/** Integrated loudness (LUFS) of a file after an optional filter chain. */
function lufs(file: string, pre = '') {
  const err = Bun.spawnSync(['ffmpeg', '-hide_banner', '-nostats', '-i', file, '-af', `${pre}${pre ? ',' : ''}loudnorm=print_format=json`, '-f', 'null', '-']).stderr.toString();
  const i = Number(err.match(/"input_i"\s*:\s*"(-?[\d.]+)"/)?.[1]);
  if (!Number.isFinite(i)) throw new Error(`could not measure the loudness of ${file}`);
  return i;
}

// ---- the end of every run: music, the edit and the file, from what filming left in out/stems ----
// out/stems: capture.mp4 (the whole take, no sound), voice/NN-<line>.wav (each line, levelled), voice.wav (the lines laid
// out), edit.json (the cut spans and where each line starts) and music.wav (made here, a steady BED_UNDER dB under the
// voice). The edit is done in Concat: the capture with the model waits cut out and a dissolve on each join, every line
// its own clip, the music on its own lane; the project stays in Concat's projects to adjust by hand. Without Concat,
// ffmpeg makes the same cut. `--remix` runs only this: new music and a new edit, no filming.
type Edit = { seconds: number; cuts: { from: number; to: number }[]; lines: { line: string; file: string; at: number }[] };
async function finish() {
  const capture = join(STEMS, 'capture.mp4');
  const voice = join(STEMS, 'voice.wav');
  const music = join(STEMS, 'music.wav');
  if (!existsSync(capture) || !existsSync(join(STEMS, 'edit.json'))) throw new Error('nothing filmed in out/stems yet: run bun run demo:video first');
  const edit = JSON.parse(readFileSync(join(STEMS, 'edit.json'), 'utf8')) as Edit;
  // the edit ends 1.5 s after the last word: whatever the take ran on past that is cut off the end
  const lastWord = Math.max(...edit.lines.map((l) => l.at + durationMs(join(STEMS, l.file)) / 1000));
  const end = Math.round((lastWord + 1.5) * 30) / 30;
  if (end < edit.seconds) {
    const cutTotal = edit.cuts.reduce((s, c) => s + (c.to - c.from), 0);
    edit.cuts = [...edit.cuts, { from: end + cutTotal, to: durationMs(capture) / 1000 }];
    edit.seconds = end;
  }
  const bed = writeBed(join(TMP, 'bed.wav'), edit.seconds);
  const gain = lufs(voice) - BED_UNDER - lufs(bed);
  const mu = Bun.spawnSync(['ffmpeg', '-y', '-v', 'error', '-i', bed, '-af', `volume=${gain.toFixed(2)}dB`, '-c:a', 'pcm_f32le', music], { stderr: 'inherit' });
  if (mu.exitCode) throw new Error('ffmpeg could not level the music');

  const cut = join(TMP, 'edit.mp4');
  const d = new Date();
  const stamp = `${d.toLocaleDateString('sv-SE')} ${d.toTimeString().slice(0, 5).replace(':', '')}`; // local time, as the user reads it
  let project = '';
  try {
    const r = await concatEdit({
      name: `DisputeShield ${REHEARSE ? 'rehearsal' : 'demo'} ${stamp}`, capture, cuts: edit.cuts, music, output: cut,
      lines: edit.lines.map((l) => ({ file: join(STEMS, l.file), at: l.at })),
      onProgress: (st) => console.log(`Concat export: ${st.state} ${Math.round((st.fraction ?? 0) * 100)}%`),
    });
    project = r?.project ?? '';
  } catch (e) {
    console.log(`Concat edit failed, cutting with ffmpeg instead: ${(e as Error).message}`);
  }
  if (!project) {
    const keep = edit.cuts.length ? `select='not(${edit.cuts.map((c) => `between(t,${c.from},${c.to})`).join('+')})',setpts=N/30/TB,` : '';
    const ff = Bun.spawnSync(['ffmpeg', '-y', '-v', 'error', '-i', capture, '-i', voice, '-i', music, '-filter_complex', `[0:v]${keep}format=yuv420p[v];[1:a][2:a]amix=inputs=2:normalize=0[a]`,
      '-map', '[v]', '-map', '[a]', '-t', edit.seconds.toFixed(3), '-c:v', 'libx264', '-crf', '17', '-preset', 'slow', '-c:a', 'pcm_f32le', '-f', 'mov', cut], { stderr: 'inherit' });
    if (ff.exitCode) throw new Error('ffmpeg could not cut the video');
  }
  // the finished file: the edit's sound to -15 LUFS (YouTube plays it at about that), peaks under -1 dBFS, picture untouched
  const ff = Bun.spawnSync(['ffmpeg', '-y', '-v', 'error', '-i', cut, '-map', '0:v', '-map', '0:a',
    '-af', `volume=${(-15 - lufs(cut)).toFixed(2)}dB,alimiter=limit=0.89:attack=5:release=60:level=false`,
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out], { stderr: 'inherit' });
  if (ff.exitCode) throw new Error('ffmpeg could not write the video');

  const probe = JSON.parse(Bun.spawnSync(['ffprobe', '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', out]).stdout.toString());
  const v = probe.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
  const a = probe.streams.find((s: { codec_type: string }) => s.codec_type === 'audio');
  const dur = Number(probe.format.duration);
  const failures = [
    v?.width !== 1920 && `width ${v?.width}`,
    v?.height !== 1080 && `height ${v?.height}`,
    v?.codec_name !== 'h264' && `video codec ${v?.codec_name}`,
    !a && 'no audio stream',
    a?.channels !== 2 && `audio channels ${a?.channels}`,
    Math.abs(dur - edit.seconds) > 0.5 && `duration ${dur.toFixed(2)} s, the edit is ${edit.seconds.toFixed(2)} s`,
    !(dur >= 90 && dur <= MAX_SECS) && `duration ${dur.toFixed(1)} s, wanted 90 to ${MAX_SECS}`,
  ].filter(Boolean);
  if (failures.length) { console.error(`demo video failed: ${failures.join('; ')}`); process.exit(1); }
  console.log(`demo video: ${out} (${v.width}x${v.height} ${v.codec_name}, ${a.codec_name} audio, ${dur.toFixed(1)} s, ${lufs(out).toFixed(1)} LUFS)`);
  console.log(project ? `edited in Concat: ${project} (music on its own lane, ${BED_UNDER} dB under the voice)` : `cut with ffmpeg; tracks in ${STEMS}`);
}
if (REMIX) {
  await finish();
  process.exit(0);
}

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
    say: 'There it is at the bottom: open, contested, and still waiting for an answer.',
    cap: 'Open and contested: it still needs an answer',
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
    cap: 'Real PayPal sandbox call: a draft invoice',
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
// "seam2": lines spoken after the speak.py fix that stopped a sentence's first syllable landing before the pause
async function speakAll(): Promise<Record<Key, Clip>> {
  mkdirSync(VOICE_DIR, { recursive: true });
  const jobs = (Object.keys(LINES) as Key[]).map((key) => {
    const text = LINES[key].say;
    const hash = createHash('sha1').update(`american|sentence|seam2|${text}`).digest('hex').slice(0, 16);
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
    // paced a little brisker, rumble cut, and levelled so no line jumps out or sinks under the music
    const ready = join(TMP, `${job.key}-voice.wav`);
    const pace = 'highpass=f=70,atempo=1.1';
    const gain = (VOICE_LUFS - lufs(job.out, pace)).toFixed(2);
    const done = Bun.spawnSync(['ffmpeg', '-y', '-v', 'error', '-i', job.out, '-af', `${pace},volume=${gain}dB,aresample=48000`, '-c:a', 'pcm_f32le', ready]);
    if (done.exitCode) throw new Error(`could not level ${job.key}: ${done.stderr.toString()}`);
    clips[job.key] = { file: ready, ms: durationMs(ready) };
    log.push(`[${job.key}] ${(clips[job.key].ms / 1000).toFixed(1)} s  ${gain} dB  speak.py --profile american -> ${job.out}\n  "${job.text}"`);
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
let endMs = 0;
let t0 = 0;
let frames: Frame[] = [];
for (let tryNo = 1; ; tryNo++) {
  const REC = join(TMP, `rec-${tryNo}`);
  mkdirSync(REC, { recursive: true });
  try {
  const waitMins = Number(process.env.DEMO_OLLAMA_WAIT_MIN || 60);
  for (let i = 0; ; i++) {
    if (REHEARSE || (await ollamaReady())) break;
    if (i * 1.5 > waitMins) throw new Error(`Ollama (${MODEL}) did not answer a schema call fast for ${waitMins} min: it is busy or down (bun run llm:start)`);
    console.log('Ollama is busy, waiting for a quiet window...');
    await Bun.sleep(30_000);
  }
  console.log('Ollama answered fast: filming');

  // ---- 6. two servers: A = demo mode with the live model; B = demo mode off with the sandbox keys, for the invoice ----
  // 8000 and 8001 when free, so the URL bar reads like the README; any free port otherwise
  async function freePort(prefer = 0): Promise<number> {
    try {
      const probe = Bun.serve({ port: prefer, hostname: '127.0.0.1', fetch: () => new Response('') });
      const port = probe.port!;
      await probe.stop(true);
      return port;
    } catch {
      if (!prefer) throw new Error('no free port');
      return freePort(0);
    }
  }
  const noKeys = { PAYPAL_CLIENT_ID: '', PAYPAL_CLIENT_SECRET: '', PAYPAL_WEBHOOK_ID: '', ANTHROPIC_API_KEY: '' };
  const envA = {
    ...process.env, ...noKeys,
    DISPUTESHIELD_DEMO_MODE: '1', DISPUTESHIELD_DB: join(TMP, `demo-${tryNo}.db`), DISPUTESHIELD_OPERATOR_TOKEN: TOKEN,
    DISPUTESHIELD_LLM: REHEARSE ? 'off' : 'ollama', DISPUTESHIELD_OLLAMA_MODEL: MODEL, OLLAMA_HOST: OLLAMA,
  };
  const envB = {
    ...process.env, ANTHROPIC_API_KEY: '', PAYPAL_WEBHOOK_ID: '',
    DISPUTESHIELD_DEMO_MODE: '0', DISPUTESHIELD_DB: join(TMP, `invoice-${tryNo}.db`), DISPUTESHIELD_OPERATOR_TOKEN: TOKEN, DISPUTESHIELD_LLM: 'off',
  };
  const seed = Bun.spawnSync([PY, 'scripts/seed_case.py'], { cwd: ROOT, env: { ...envB, PYTHONPATH: ROOT } });
  if (seed.exitCode) throw new Error(`seeding the invoice case failed:\n${seed.stderr.toString().slice(-1500)}`);
  const invoiceCase = seed.stdout.toString().trim().split('\n').pop()!;
  const portA = await freePort(8000);
  let portB = await freePort(portA === 8000 ? 8001 : 0);
  while (portB === portA) portB = await freePort();
  const A = `http://127.0.0.1:${portA}`;
  const B = `http://127.0.0.1:${portB}`;
  const uvicorn = (port: number, env: Record<string, string | undefined>) =>
    Bun.spawn([join(ROOT, '.venv/bin/uvicorn'), 'app.main:app', '--port', String(port)], { cwd: ROOT, env, stdout: 'ignore', stderr: 'ignore' });
  const servers = [uvicorn(portA, envA), uvicorn(portB, envB)];
  let browser: Browser | undefined;

  const pack = loadPack(resolveStyles()[0]!);
  // the spotlight lives in the app's own document (it outlines an element of the console)
  const SPOT_CSS = `.demo-spot{box-shadow:0 0 0 3px rgba(184,74,39,.5)!important;transition:box-shadow .3s}
.ag-row.demo-spot{box-shadow:inset 0 0 0 2px rgba(184,74,39,.75)!important}`;

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
      lead: 'Run by this script, right before the recording.',
      cards: [
        { kicker: 'pytest', title: `${passed} passed`, body: 'API, scoring, guards and the demo flow. The live-model tests wait for a quiet host.' },
        { kicker: 'Types', title: '0 errors', body: 'tsc on the console and the scripts, strict mypy on the app and the tests.' },
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

    // ---- 7. filming, on the 1920x1080 stage: the console runs in the browser window's iframe ----
    browser = await chromium.launch();
    const page: Page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, colorScheme: 'light' });
    await page.setContent(stageHtml(pack, { url: `localhost:${portA}` }), { waitUntil: 'load' });
    const app = page.frameLocator('#app');
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${m.type()}: ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    const stopRec = await startScreencast(page, REC);
    t0 = Date.now();
    const now = () => Date.now() - t0;
    let onSlide = true;

    const stage = (fn: string, ...args: unknown[]) =>
      page.evaluate(({ fn, args }) => (window as unknown as { stage: Record<string, (...a: unknown[]) => unknown> }).stage[fn](...args), { fn, args });
    /** Plays a line. Each step runs at its share of the line (0..1); the line always plays out in full. */
    async function narrate(key: Key, steps: [number, () => Promise<unknown>][] = []) {
      const c = N[key];
      const line = LINES[key] as { cap?: string; step?: string };
      const at = now();
      clips.push({ file: c.file, at });
      if (!onSlide && line.cap) await stage('caption', line.cap, line.step ?? '');
      for (const [share, fn] of steps) {
        await Bun.sleep(Math.max(0, at + c.ms * share - now()));
        await fn();
      }
      await Bun.sleep(Math.max(0, c.ms - (now() - at)) + 300);
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
      onSlide = true;
      await stage('slide', html);
    }
    /** Points the browser window at a console (behind a slide or in view) and waits for the grid. */
    async function openApp(base: string) {
      await page.locator('#app').evaluate((f: HTMLIFrameElement, u) => { f.src = u; }, `${base}/#token=${TOKEN}`);
      await app.getByText(/Disputes/).first().waitFor(WAIT);
      await app.locator('head').evaluate((h, css) => { const s = document.createElement('style'); s.textContent = css; h.appendChild(s); }, SPOT_CSS);
      await stage('url', `localhost:${new URL(base).port}`);
    }
    async function enterApp() { // the window rises in while the next line starts
      onSlide = false;
      await stage('unslide');
    }
    /** Zooms the window onto an element (its on-screen part); null goes back to the whole window. */
    async function focus(loc: Locator | null, max = 2) {
      const r = loc
        ? await loc.evaluate((el) => {
          const b = el.getBoundingClientRect();
          const x = Math.max(0, b.left), y = Math.max(0, b.top);
          return { x, y, w: Math.min(innerWidth, b.right) - x, h: Math.min(innerHeight, b.bottom) - y };
        })
        : null;
      await stage('focus', r, max);
      await Bun.sleep(ZOOM_MS);
    }
    async function pointAt(loc: Locator) {
      await loc.scrollIntoViewIfNeeded();
      const b = await loc.boundingBox();
      if (!b) throw new Error('the cursor cannot point at an element that is not on screen');
      await stage('cursor', b.x + b.width / 2, b.y + b.height / 2);
      await Bun.sleep(850);
    }
    async function clickOn(loc: Locator) {
      await pointAt(loc);
      await stage('click');
      await loc.click();
    }
    const scrollTo = async (panel: Locator, sel: string, block: ScrollLogicalPosition = 'start') => {
      await panel.locator(sel).first().evaluate((el, block) => el.scrollIntoView({ behavior: 'smooth', block }), block);
      await Bun.sleep(550);
    };
    const spot = (loc: Locator, on: boolean) => loc.evaluate((el, on) => el.classList.toggle('demo-spot', on), on);
    async function openCase(id: string): Promise<Locator> {
      await clickOn(app.locator(`.ag-row[row-id="${id}"] [col-id="reason"]`));
      const panel = app.getByRole('dialog', { name: `Dispute ${id}` });
      await panel.waitFor(WAIT);
      return panel;
    }
    /** Both the receipt read and the note must say "AI · qwen3:8b · live": never narrate a fallback as AI. */
    async function expectLive(panel: Locator, id: string) {
      await panel.getByRole('heading', { name: 'Extracted evidence' }).waitFor(WAIT);
      await panel.locator('#dossier-sec .card-head .badge').waitFor(WAIT);
      if (REHEARSE) return;
      const badges = (await panel.locator('.card-head .badge').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
      const want = `AI · ${MODEL} · live`;
      if (badges.length < 2 || badges.some((b) => b !== want)) {
        throw new NotLive(`case ${id}: the panel shows ${JSON.stringify(badges)}, wanted every badge to be "${want}". Ollama may have timed out; rerun in a quiet window`);
      }
    }
    /** Simulate chargeback pinned to one scenario (cursor already on the button); the POST answers once the model has read the receipt. */
    async function simulateStart(scenario: string) {
      await page.setExtraHTTPHeaders({ 'X-Demo-Scenario': scenario });
      const res = page.waitForResponse((r) => r.url().endsWith('/api/demo/chargeback'), WAIT);
      await stage('click');
      await app.locator('#simulate-btn').click();
      return res;
    }
    const section = (panel: Locator, heading: string) => panel.locator(`section[aria-labelledby="${heading}"]`);

    // -- title card --
    await show(TITLE);
    await Bun.sleep(700);
    const appReady = openApp(A); // loads behind the title
    await narrate('title');
    await appReady;

    // -- the console, Simulate chargeback --
    await app.getByText('Demo mode', { exact: true }).waitFor();
    await app.locator('.ag-row').nth(2).waitFor(WAIT);
    await enterApp();
    let pending: ReturnType<typeof simulateStart> | undefined;
    await narrate('console', [
      [0.3, () => focus(app.locator('#grid'), 1.6)],
      [0.55, () => focus(app.locator('#simulate-btn').locator('..'), 1.8)],
      [0.64, () => pointAt(app.locator('#simulate-btn'))],
      [0.7, async () => { pending = simulateStart('leeds'); }],
    ]);
    const id = await waitCut(async () => {
      const res = await pending!;
      if (!res.ok()) throw new Error(`demo chargeback answered ${res.status()}`);
      const id = ((await res.json()) as { id: string }).id;
      const row = app.locator(`.ag-row[row-id="${id}"]`);
      await row.locator('[col-id="win"]').filter({ hasText: REHEARSE ? /%/ : '95%' }).waitFor(WAIT);
      return id;
    });
    const row = app.locator(`.ag-row[row-id="${id}"]`);
    if (!(await row.getAttribute('class'))?.includes('row-contested')) throw new Error('the new row is not highlighted as contested');
    await page.mouse.move(4, 4); // the real mouse off the console: no hover on the new row
    await app.locator('body').evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); // no grid focus box either
    await narrate('row', [
      [0.02, () => focus(row, 1.7)],
      [0.05, () => spot(row, true)],
    ]);
    await spot(row, false);

    // -- the live read --
    const panel = await openCase(id);
    await waitCut(() => expectLive(panel, id));
    if (!REHEARSE) await panel.getByText('1Z999AA10123456784', { exact: true }).waitFor();
    const readBadge = panel.locator('#evidence-box .card-head .badge').first();
    await narrate('evidence', [
      [0.0, async () => { await scrollTo(panel, '#h-evidence'); await focus(panel.locator('#evidence-box')); }],
      [0.3, () => spot(readBadge, true)],
      [0.62, () => spot(readBadge, false)],
    ]);

    // -- the score --
    const shown = (await panel.locator('.score-num').first().innerText()).trim();
    if (shown !== '95%' && !REHEARSE) throw new Error(`narration says 95%, the panel shows ${shown}`);
    await narrate('score', [
      [0.02, async () => { await scrollTo(panel, '#h-score'); await focus(section(panel, 'h-score')); }],
      [0.35, async () => { await scrollTo(panel, '.factors .factor.base'); await focus(panel.locator('.factors')); }],
      [0.72, async () => { await scrollTo(panel, '#h-score'); await focus(panel.locator('.score').first(), 1.9); }],
      [0.78, () => spot(panel.locator('.score-num').first(), true)],
    ]);
    await spot(panel.locator('.score-num').first(), false);

    // -- dossier and note --
    await narrate('dossier', [
      [0.02, async () => { await scrollTo(panel, '#h-dossier'); await focus(panel.locator('#dossier-sec')); }],
      [0.3, () => spot(panel.locator('#dossier-sec .card').first(), true)],
      [0.85, () => spot(panel.locator('#dossier-sec .card').first(), false)],
    ]);

    // -- submit, labelled demo mode --
    const foot = panel.locator('.detail-foot');
    await narrate('submit', [
      [0.0, () => focus(foot, 1.7)],
      [0.06, async () => {
        await clickOn(panel.getByRole('button', { name: 'Submit evidence' }));
        await panel.getByText('Demo mode: nothing was sent to PayPal').waitFor(WAIT);
        await panel.getByRole('button', { name: 'Evidence submitted' }).waitFor();
        await focus(foot, 1.7); // the banner made the footer taller
      }],
      [0.4, () => spot(panel.getByText('Demo mode: nothing was sent to PayPal').locator('..'), true)],
    ]);
    await stage('focus', null); // zoom out while the panel closes
    await panel.getByRole('button', { name: /Close/ }).dispatchEvent('click');
    await Bun.sleep(ZOOM_MS);
    await row.locator('[col-id="status"]').filter({ hasText: 'Under review' }).waitFor(WAIT);

    // -- a weaker case: the advice is a refund offer --
    await pointAt(app.locator('#simulate-btn'));
    const weakRes = await waitCut(async () => {
      const res = await simulateStart('bristol');
      if (!res.ok()) throw new Error(`demo chargeback answered ${res.status()}`);
      return res;
    });
    const weakId = ((await weakRes.json()) as { id: string }).id;
    await app.locator(`.ag-row[row-id="${weakId}"]`).waitFor(WAIT);
    const weak = await openCase(weakId);
    await waitCut(() => expectLive(weak, weakId));
    const weakPct = (await weak.locator('.score-num').first().innerText()).trim();
    if (weakPct !== '44%' && !REHEARSE) throw new Error(`narration says 44%, the weak case shows ${weakPct}`);
    const pill = (await weak.locator('.rec-pill').innerText()).trim();
    if (pill !== 'Offer refund' && !REHEARSE) throw new Error(`narration says a refund offer, the panel recommends "${pill}"`);
    await narrate('weak', [
      [0.0, async () => { await scrollTo(weak, '#h-score'); await focus(section(weak, 'h-score')); }],
      [0.25, async () => { await scrollTo(weak, '.factors .factor.unmet', 'center'); await focus(weak.locator('.factors .factor.unmet').first(), 1.8); }],
      [0.72, async () => { await scrollTo(weak, '#h-score'); await focus(weak.locator('.rec').first(), 1.9); }],
      [0.78, () => spot(weak.locator('.rec').first(), true)],
    ]);

    // -- server B: demo mode off, sandbox keys, a real Invoicing v2 call --
    await stage('focus', null); // zoom out while server B loads
    const zoomedOut = Bun.sleep(ZOOM_MS);
    await openApp(B);
    await zoomedOut; // the cursor aims at settled coordinates
    await app.locator(`.ag-row[row-id="${invoiceCase}"]`).waitFor(WAIT);
    const inv = await openCase(invoiceCase);
    await inv.getByRole('heading', { name: 'Extracted evidence' }).waitFor(WAIT);
    await scrollTo(inv, '#h-invoice');
    await focus(section(inv, 'h-invoice'), 1.9);
    let invoiceNo = '';
    await narrate('invoice', [
      [0.3, async () => {
        const answered = page.waitForResponse((r) => r.url().endsWith('/paypal-invoice') && r.request().method() === 'POST', { timeout: 60_000 });
        await clickOn(inv.getByRole('button', { name: 'Record as PayPal invoice' }));
        const res = await answered;
        if (!res.ok()) throw new Error(`PayPal sandbox invoice call failed (${res.status()}): ${await res.text()}`);
        invoiceNo = ((await res.json()) as { invoice_id: string }).invoice_id;
        const banner = inv.locator('#invoice-box .banner');
        await banner.getByText('Recorded on PayPal sandbox').waitFor({ timeout: 10_000 });
        await banner.getByText('Simulated case · invoice call live on sandbox').waitFor({ timeout: 10_000 });
        await banner.evaluate((b) => b.scrollIntoView({ behavior: 'smooth', block: 'center' }));
        await Bun.sleep(550);
        await focus(banner, 1.9);
      }],
      [0.6, () => spot(inv.locator('#invoice-box .banner'), true)],
    ]);

    // -- how, tests, outro --
    await show(HOW);
    await page.locator('#app').evaluate((f: HTMLIFrameElement) => { f.src = 'about:blank'; }); // the console stops polling under the slides
    await narrate('how');
    await show(TESTS);
    await narrate('tests');
    await show(OUTRO);
    await narrate('outro');
    await Bun.sleep(1000);

    if (errors.length) throw new Error(`the console logged errors while filming:\n${errors.join('\n')}`);
    endMs = now();
    frames = await stopRec();
    await browser.close();
    console.log(`sandbox draft invoice: ${invoiceNo}; ${frames.length} frames`);
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

// ---- 8. what filming leaves for the edit (out/stems): the whole take, the cut spans, every line and where it starts ----
// the cut spans on whole frames, so the picture Concat cuts and the voice laid here agree to the frame
const cutSecs = cuts.map((c) => ({ from: Math.round((c.from / 1000) * 30) / 30, to: Math.round((c.to / 1000) * 30) / 30 }));
const cutBefore = (sec: number) => cutSecs.filter((c) => c.to <= sec).reduce((s, c) => s + (c.to - c.from), 0);
for (const c of clips) if (cutSecs.some((k) => c.at / 1000 > k.from && c.at / 1000 < k.to)) throw new Error('a voice line starts inside a cut');
rmSync(STEMS, { recursive: true, force: true });
mkdirSync(join(STEMS, 'voice'), { recursive: true });
const list = join(TMP, 'frames.txt');
const taken = writeConcat(frames, { t0, endMs, fps: 30, file: list });
const pic = Bun.spawnSync(['ffmpeg', '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-vf', 'fps=30,scale=1920:1080:out_range=tv,format=yuv420p',
  '-t', taken.toFixed(3), '-an', '-c:v', 'libx264', '-crf', '16', '-preset', 'medium', '-g', '30', join(STEMS, 'capture.mp4')], { stderr: 'inherit' });
if (pic.exitCode) throw new Error('ffmpeg could not encode the capture');
const keys = Object.keys(LINES) as Key[];
const lines = clips.map((c, i) => {
  const line = keys.find((k) => N[k].file === c.file) ?? `line${i}`;
  const file = join('voice', `${String(i + 1).padStart(2, '0')}-${line}.wav`);
  copyFileSync(c.file, join(STEMS, file));
  return { line, file, at: Math.round((c.at / 1000 - cutBefore(c.at / 1000)) * 1000) / 1000 };
});
const seconds = taken - cutBefore(Infinity);
const lay = lines.map((l, i) => `[${i}:a]adelay=${Math.round(l.at * 1000)}|${Math.round(l.at * 1000)},aformat=channel_layouts=stereo[a${i}]`).join(';')
  + `;${lines.map((_, i) => `[a${i}]`).join('')}amix=inputs=${lines.length}:normalize=0[v]`;
const vo = Bun.spawnSync(['ffmpeg', '-y', '-v', 'error', ...lines.flatMap((l) => ['-i', join(STEMS, l.file)]), '-filter_complex', lay, '-map', '[v]',
  '-t', seconds.toFixed(3), '-ar', '48000', '-c:a', 'pcm_f32le', join(STEMS, 'voice.wav')], { stderr: 'inherit' });
if (vo.exitCode) throw new Error('ffmpeg could not lay the voice track');
writeFileSync(join(STEMS, 'edit.json'), `${JSON.stringify({ seconds, cuts: cutSecs, lines } satisfies Edit, null, 2)}\n`);
console.log(`take ${taken.toFixed(1)} s; ${cutSecs.length} model wait(s) to cut, ${cutBefore(Infinity).toFixed(1)} s; the edit is ${seconds.toFixed(1)} s`);
await finish();
