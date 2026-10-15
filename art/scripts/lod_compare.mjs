// LOD check: the same views with every chunk forced to full detail, to its stand-in, and on auto
// (art/renders/lod/<view>_{near,far,auto}.png). node art/scripts/lod_compare.mjs [--url ...]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : d;
};
const BASE = arg('--url', 'http://localhost:8090/index.html');
const OUT = 'art/renders/lod';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });

async function trio(page, view) {
  for (const [force, tag] of [[1, 'near'], [2, 'far'], [0, 'auto']]) {
    await page.evaluate((f) => (globalThis.__snow.lodDebug.force = f), force);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/${view}_${tag}.png` });
  }
  console.log('shot', view);
}

const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(`${BASE}?debug&lod=${Date.now()}`);
await page.waitForFunction(() => globalThis.__snow?.bakedView?.tutorialReady, null, { timeout: 180000 });
await page.waitForTimeout(3000);
console.log('stand-ins', JSON.stringify(await page.evaluate(() => globalThis.__snow.lodStats)));
await trio(page, 'trail');
await page.evaluate(() => globalThis.__snow.setPhase(globalThis.__snow.Phase.Launch));
await page.waitForTimeout(4000);
await trio(page, 'launch');
await page.keyboard.down('Space');
await page.waitForTimeout(6000);
await page.keyboard.up('Space');
await trio(page, 'glide');
await page.waitForTimeout(9000);
await trio(page, 'glide2');
await page.evaluate(() => globalThis.__snow.setPhase(globalThis.__snow.Phase.Cave));
await page.waitForFunction(() => globalThis.__snow.cave.inside && globalThis.__snow.cave.v?.baked, null, { timeout: 60000 });
await page.waitForTimeout(3000);
console.log('stand-ins with cave', JSON.stringify(await page.evaluate(() => globalThis.__snow.lodStats)));
await trio(page, 'cave');
await page.close();
const sv = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await sv.goto(`${BASE}?survivors&debug&lod=${Date.now()}`);
await sv.waitForFunction(() => globalThis.__snow?.survivors?.arena, null, { timeout: 180000 });
await sv.waitForTimeout(6000);
await trio(sv, 'survivors');
await browser.close();
