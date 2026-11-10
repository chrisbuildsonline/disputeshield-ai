// Turns a take (`bun scripts/demo-video.ts --take` -> out/take) into the assets of the explainroo project in
// out/explainroo: the footage with the model waits cut out, one narration file per scene (the voice clone), the hero
// screenshot, the take's line starts and close-up targets written into scenes.js, and each app scene's hold set so the
// scenes keep the take's spacing. Then: npx --yes explainroo@0.5.0 voice|check|sheet|render out/explainroo
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const TAKE_DIR = join(ROOT, 'out/take');
const PROJECT = join(ROOT, 'out/explainroo');
const ASSETS = join(PROJECT, 'assets');
const APP_SCENES = ['console', 'row', 'evidence', 'score', 'dossier', 'submit', 'weak', 'invoice'];
const LEAD = 0.25; // seconds before the voice in each app scene after the first
const MAX_SECONDS = 180;

type Rect = { x: number; y: number; w: number; h: number };
type Take = { seconds: number; cuts: { from: number; to: number }[]; lines: { line: string; at: number; seconds: number }[]; focus: { t: number; rect: Rect | null; max: number }[] };
const take = JSON.parse(readFileSync(join(TAKE_DIR, 'take.json'), 'utf8')) as Take;

function ff(args: string[], what: string) {
  const p = Bun.spawnSync(['ffmpeg', '-y', '-v', 'error', ...args]);
  if (p.exitCode) throw new Error(`ffmpeg could not ${what}: ${p.stderr.toString().slice(-600)}`);
}

// take seconds -> seconds in the cut footage (a time inside a cut lands on the cut)
const cutBefore = (t: number) => take.cuts.reduce((s, c) => s + (t >= c.to ? c.to - c.from : t > c.from ? t - c.from : 0), 0);
const edited = (t: number) => Math.round((t - cutBefore(t)) * 1000) / 1000;

mkdirSync(join(ASSETS, 'narration'), { recursive: true });
const keep = take.cuts.length ? `select='not(${take.cuts.map((c) => `between(t,${c.from},${c.to})`).join('+')})',setpts=N/30/TB,` : '';
ff(['-i', join(TAKE_DIR, 'capture.mp4'), '-vf', `${keep}format=yuv420p`, '-an', '-c:v', 'libx264', '-crf', '16', '-preset', 'medium', join(ASSETS, 'take.mp4')], 'cut the take');
for (const f of ['title', 'console', 'row', 'evidence', 'score', 'dossier', 'submit', 'weak', 'invoice', 'how', 'tests', 'outro']) {
  const src = join(TAKE_DIR, 'voice', `${f}.wav`);
  if (!existsSync(src)) throw new Error(`no voice file ${src}`);
  ff(['-i', src, '-af', 'alimiter=limit=0.95:level=false', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', join(ASSETS, 'narration', `${f}.wav`)], `convert ${f}`);
}
ff(['-i', join(ROOT, 'docs/screenshots/hero.png'), '-vf', 'crop=1440:810:0:0', join(ASSETS, 'hero.png')], 'crop the hero shot');

const lines = Object.fromEntries(take.lines.map((l) => [l.line, { at: edited(l.at), seconds: l.seconds }]));
const focus = take.focus.map((f) => ({ t: edited(f.t), rect: f.rect }));
const scenesFile = join(PROJECT, 'scenes.js');
const scenes = readFileSync(scenesFile, 'utf8').replace(/const TAKE = \/\*TAKE\*\/ .*;/, `const TAKE = /*TAKE*/ ${JSON.stringify({ lines, focus })};`);
writeFileSync(scenesFile, scenes);

// each app scene holds until the next line would start in the take, so the footage runs on without jumps
const scriptFile = join(PROJECT, 'script.md');
let script = readFileSync(scriptFile, 'utf8');
let total = 0;
for (const [i, key] of APP_SCENES.entries()) {
  const next = APP_SCENES[i + 1];
  const lead = i === 0 ? 0.35 : LEAD;
  const hold = next ? Math.max(0.15, lines[next].at - lines[key].at - lines[key].seconds - LEAD) : 0.7;
  total += lead + lines[key].seconds + hold;
  script = script.replace(new RegExp(`^## ${key} \\{[^}]*\\}`, 'm'), (h) => `${h.replace(/ (lead|hold)=[\d.]+/g, '').replace(/\}$/, '')} lead=${lead} hold=${hold.toFixed(2)}}`);
}
writeFileSync(scriptFile, script);
const slides = ['title', 'how', 'tests', 'outro'].reduce((s, k) => s + Number(Bun.spawnSync(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(ASSETS, 'narration', `${k}.wav`)]).stdout.toString()) + 1.05, 0.45);
console.log(`assets in ${ASSETS}: take.mp4 (${take.cuts.length} cut(s)), 12 narration files, hero.png; ${focus.length} close-ups`);
console.log(`about ${(total + slides).toFixed(1)} s (app scenes ${total.toFixed(1)} s, other scenes ${slides.toFixed(1)} s); the limit is ${MAX_SECONDS} s`);
if (total + slides > MAX_SECONDS) throw new Error('over 3 minutes: shorten a line or a hold');
