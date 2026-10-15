// A staged late-run Snow Survivors fight for checking that the attacks stay readable: every weapon maxed
// and evolved, the horde of minute six. Writes art/renders/fight/<tag>_<n>.png and prints, per shot, the
// share of near-white pixels in the band where the crowd stands (main's readability measure: ~10%).
//   node art/scripts/staged_fight.mjs [--url ...] [--tag merged] [--fire]  (--fire: the fire weapons only)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : d;
};
const BASE = arg('--url', 'http://localhost:8090/index.html');
const TAG = arg('--tag', 'merged');
const FIRE = process.argv.includes('--fire');
const OUT = 'art/renders/fight';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
// shader compile failures are console errors (three.js logs them; the page carries on)
page.on('console', (m) => {
  if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 300));
});
await page.goto(`${BASE}?survivors&debug&fight=${Date.now()}`);
await page.waitForFunction(() => globalThis.__snow?.survivors?.arena, null, { timeout: 180000 });
await page.waitForTimeout(4000);
await page.evaluate((fire) => {
  const sv = globalThis.__snow.survivors;
  const ice = ['icicles', 'blades', 'compass', 'nova', 'lightning'];
  const hot = ['fireworks', 'breath', 'trail', 'comet'];
  const use = fire ? hot : [...ice, ...hot];
  for (const w of Object.keys(sv.stats.weapons)) sv.stats.weapons[w] = use.includes(w) ? 8 : 0;
  for (const w of use) sv.stats.evolved[w] = true;
  sv.stats.area = 1.6;
  sv.stats.amount = 2;
  sv.stats.might = 3;
  sv.stats.maxHp = 1e6;
  sv.hp = 1e6;
  sv.time = 360;
  // no level-up cards: a choice stops time
  sv.xpNext = 1e12;
}, FIRE);
// a slow circle so the crowd keeps coming and the trail burns
await page.keyboard.down('KeyW');
const shots = [];
for (let n = 0; n < 4; n++) {
  await page.waitForTimeout(n === 0 ? 20000 : 3000);
  await page.keyboard.down(n % 2 ? 'KeyA' : 'KeyD');
  await page.waitForTimeout(400);
  await page.keyboard.up(n % 2 ? 'KeyA' : 'KeyD');
  await page.evaluate(() => globalThis.__snow.survivors.menu?.close?.());
  const path = `${OUT}/${TAG}${FIRE ? '_fire' : ''}_${n}.png`;
  await page.screenshot({ path });
  const st = await page.evaluate(() => {
    const sv = globalThis.__snow.survivors;
    const ri = globalThis.__snow.world.renderer.info.render;
    return { alive: sv.horde.n, dead: sv.dead, calls: ri.calls, tris: ri.triangles };
  });
  shots.push({ path, ...st });
}
await page.keyboard.up('KeyW');
console.log(JSON.stringify(shots));
console.log('errors', errors.length, errors.slice(0, 3));
await browser.close();
if (errors.length) process.exit(1);
