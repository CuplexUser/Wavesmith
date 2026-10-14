// Records a short gameplay video for the store listing: the title screen, then several levels
// solving with their reference solutions, as a 1920×1080 WebM. Play wants a YouTube link for
// the trailer, so upload the result there (or edit it first).
//
//   cd web && pnpm dev                       # in one terminal
//   node scripts/capture-trailer.mjs          # writes docs/store/trailer.webm (gitignored)
//
// Runs best on a machine with a real GPU; software rendering records at a low frame rate.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.WAVESMITH_URL ?? 'http://localhost:5173/';
const OUT = path.join(root, 'docs/store');
const scenes = [
  ['1-5', 'ch1/05-whispering-gallery', 6],
  ['2-2', 'ch2/02-two-voices', 6],
  ['5-3', 'ch5/03-prism', 10],
  ['6-3', 'ch6/03-two-tone', 6],
  ['4-3', 'ch4/03-shoal', 7],
];

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 960, height: 540 },
  deviceScaleFactor: 2,
  recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } },
});
await context.addInitScript(() =>
  localStorage.setItem('wavesmith.progress.v1', JSON.stringify({ stars: {}, settings: { tutorialSeen: true } })),
);
const page = await context.newPage();
await page.goto(BASE);
await page.waitForTimeout(4000);
for (const [id, file, until] of scenes) {
  const pieces = JSON.parse(fs.readFileSync(path.join(root, 'levels', `${file}.solution.json`), 'utf8')).pieces;
  const code = Buffer.from(JSON.stringify(pieces)).toString('base64url');
  await page.goto(`${BASE}#/play/${id}?s=${code}`);
  await page.addStyleTag({ content: '.toast,.slow-badge,.perf-stats{display:none!important}' });
  await page.waitForFunction(
    (t) => parseFloat(document.querySelector('.clock')?.textContent ?? '0') >= t,
    until,
    { timeout: 120000, polling: 200 },
  );
  await page.waitForTimeout(1500);
}
const video = page.video();
await context.close();
await browser.close();
const target = path.join(OUT, 'trailer.webm');
fs.renameSync(await video.path(), target);
console.log(`wrote ${target}`);
