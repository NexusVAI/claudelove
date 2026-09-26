// Offline renderer: drives the page frame by frame in headless Chromium,
// dumps the sound cue list, then encodes the frames with ffmpeg.
//
//   node scripts/render.mjs                 # all frames -> out/frames, out/events.json
//   node scripts/render.mjs --stills=0.5,2  # single frames -> out/stills/*.png
//   node scripts/render.mjs --scale=1       # faster, non-supersampled
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer } from './server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'out');
const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
};
const scale = Number(arg('scale', '2'));
const stills = arg('stills', '');

const { server, port } = await startServer(0);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--font-render-hinting=none', '--disable-lcd-text', '--force-color-profile=srgb'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: scale });
page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
page.on('pageerror', (e) => { console.error('[pageerror]', e.message); process.exitCode = 1; });
await page.goto(`http://127.0.0.1:${port}/index.html?mode=render&scale=${scale}`);
await page.waitForFunction(() => window.SCENE && window.SCENE.ready, null, { timeout: 30000 });
const meta = await page.evaluate(() => ({ W: SCENE.W, H: SCENE.H, FPS: SCENE.FPS, DUR: SCENE.DUR, events: SCENE.events }));
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'events.json'), JSON.stringify({ fps: meta.FPS, duration: meta.DUR, events: meta.events }, null, 1));
console.log(`events: ${meta.events.length}`);

const canvas = page.locator('#c');
async function shot(t, file) {
  await page.evaluate((tt) => SCENE.renderAt(tt), t);
  await canvas.screenshot({ path: file, type: 'png', animations: 'disabled' });
}

if (stills) {
  const dir = path.join(OUT, 'stills');
  fs.mkdirSync(dir, { recursive: true });
  for (const s of stills.split(',')) {
    const t = Number(s);
    await shot(t, path.join(dir, `t_${t.toFixed(2)}.png`));
  }
  console.log(`stills -> ${dir}`);
} else {
  const dir = path.join(OUT, 'frames');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const total = Math.round(meta.DUR * meta.FPS);
  const t0 = Date.now();
  for (let f = 0; f < total; f++) {
    await shot(f / meta.FPS, path.join(dir, `${String(f).padStart(5, '0')}.png`));
    if (f % 60 === 0) console.log(`frame ${f}/${total}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  console.log(`frames -> ${dir} (${total})`);
}
await browser.close();
server.close();
