// Captures Play Store screenshots (1920×1080, phone landscape) and the 1024×500 feature graphic
// from the running dev server, using each level's reference solution.
//
//   cd web && pnpm dev            # in one terminal
//   npx -y playwright@1.56.1 install chromium   # once, if you have no Playwright browser
//   node scripts/store-screenshots.mjs          # writes docs/store/*.png
//
// Convert to JPEG before committing if you want smaller files.
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'docs/store');
const L = path.join(root, 'levels');
const BASE = process.env.WAVESMITH_URL ?? 'http://localhost:5173/';
const shots = [
  ['5-3', 'ch5/03-prism', 9.5, '01-prism'],
  ['6-3', 'ch6/03-two-tone', 5, '02-doppler'],
  ['4-3', 'ch4/03-shoal', 8, '03-shoal'],
  ['2-2', 'ch2/02-two-voices', 7.5, '04-interference'],
  ['1-5', 'ch1/05-whispering-gallery', 5, '05-gallery'],
  ['5-4', 'ch5/04-light-pipe', 16, '06-light-pipe'],
];
const browser = await chromium.launch();
for (const [id, file, wait, name] of shots) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 2 });
  await page.addInitScript(() => localStorage.setItem('wavesmith.progress.v1', JSON.stringify({ stars: {}, settings: { tutorialSeen: true } })));
  const pieces = JSON.parse(fs.readFileSync(`${L}/${file}.solution.json`, 'utf8')).pieces;
  const code = Buffer.from(JSON.stringify(pieces)).toString('base64url');
  await page.goto(`${BASE}#/play/${id}?s=${code}`);
  await page.addStyleTag({ content: '.result-layer,.toast,.slow-badge,.perf-stats{display:none!important} .stage.paused .board::after{display:none!important}' });
  await page.waitForTimeout(800);
  await page.keyboard.press('f');
  // Wait for the in-game clock, since headless rendering runs the sim slowly.
  await page.waitForFunction((t) => parseFloat(document.querySelector('.clock')?.textContent ?? '0') >= t, wait, { timeout: 240000, polling: 200 });
  await page.keyboard.press(' ');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  await page.close();
  console.log(name);
}
// Title and feature graphic.
const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 2 });
await page.goto(BASE);
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}/00-title.png` });
await page.setViewportSize({ width: 1024, height: 500 });
await page.evaluate(() => {
  document.querySelector('.title-actions')?.remove();
  document.querySelector('.title-editor')?.remove();
  document.querySelector('.title-progress')?.remove();
});
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/feature-graphic.png`, scale: 'css' });
await browser.close();
