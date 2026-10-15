// Plays the whole tutorial in headless Chrome on the GPU, the way a desktop player would, and keeps a
// record: the player's own view every few seconds, and the frame rate / draw calls / triangles at each.
//   node art/scripts/playthrough.mjs [--url http://localhost:8090/index.html] [--out art/renders/play] [--every 4]
// Trail: hold W. Wall: hold W. Cave: W onto green decks, E for parts and the beacon. Build: E. Launch:
// Space. Glide: steer for the fire with A / D. Stops when it lands (or after 20 minutes).

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : d;
};
const URL_ = arg('--url', 'http://localhost:8090/index.html');
const OUT = arg('--out', 'art/renders/play');
const EVERY = Number(arg('--every', '4')) * 1000;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
});
await page.goto(`${URL_}?debug&play=${Date.now()}`);
await page.waitForFunction(() => globalThis.__snow?.bakedView?.tutorialReady, null, { timeout: 180000 });
// a frame meter: frames in the last second, and the worst frame in it
await page.evaluate(() => {
  const f = { times: [], worst: 0 };
  let last = performance.now();
  const tick = (t) => {
    const dt = t - last;
    last = t;
    f.times.push(t);
    while (f.times.length && f.times[0] < t - 1000) f.times.shift();
    f.worst = Math.max(f.worst * 0.98, dt);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  globalThis.__meter = f;
});

const state = () =>
  page.evaluate(() => {
    const s = globalThis.__snow;
    const r = s.world.renderer.info;
    const p = s.world.player.position;
    return {
      phase: s.game.phase.value,
      parts: s.game.partsFound?.value,
      lit: s.game.beaconLit?.value,
      fps: globalThis.__meter.times.length,
      worstMs: Math.round(globalThis.__meter.worst),
      calls: r.render.calls,
      tris: r.render.triangles,
      tex: r.memory.textures,
      pos: [p.x, p.y, p.z].map((v) => Math.round(v * 10) / 10),
    };
  });

const log = [];
const t0 = Date.now();
let lastShot = 0;
let held = null;
// a key held across a couple of frames, so the game's per-frame input sees it go down
const tap = async (key) => {
  await page.keyboard.down(key);
  await page.waitForTimeout(90);
  await page.keyboard.up(key);
};
const hold = async (key) => {
  if (held === key) return;
  if (held) await page.keyboard.up(held);
  held = key;
  if (key) await page.keyboard.down(key);
};
let n = 0;
let landedAt = 0;
while (Date.now() - t0 < 20 * 60 * 1000) {
  const st = await state();
  const t = (Date.now() - t0) / 1000;
  if (Date.now() - lastShot > EVERY) {
    lastShot = Date.now();
    const name = `${String(n++).padStart(3, '0')}_${st.phase}.jpg`;
    await page.screenshot({ path: join(OUT, name), type: 'jpeg', quality: 85 });
    log.push({ t: Math.round(t), shot: name, ...st });
    console.log(t.toFixed(0), JSON.stringify(st));
  }
  switch (st.phase) {
    case 'Poling':
    case 'Climbing':
      await hold('KeyW');
      break;
    case 'Cave':
    case 'Beacon':
      await hold(null);
      await tap('KeyE');
      await tap('KeyW');
      break;
    case 'Building':
      await hold(null);
      await tap('KeyE');
      break;
    case 'Launch':
      // the bar is held for a moment before you run off the edge
      await hold('Space');
      break;
    case 'Gliding': {
      // turn toward the party's fire
      const steer = await page.evaluate(() => {
        const s = globalThis.__snow;
        const fire = s.world.scene.getObjectByName('Baked_party')?.position;
        if (!fire) return null;
        const p = s.world.player.position;
        const cam = s.world.camera;
        const fwd = new p.constructor(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new cam.quaternion.constructor()));
        const to = fire.clone().sub(p);
        const cross = fwd.x * to.z - fwd.z * to.x;
        return cross;
      });
      await hold(steer == null ? null : steer > 0.5 ? 'KeyD' : steer < -0.5 ? 'KeyA' : null);
      break;
    }
    case 'Landed':
      await hold(null);
      if (!landedAt) landedAt = Date.now();
      break;
    default:
      await hold(null);
  }
  if (landedAt && Date.now() - landedAt > 12000) break;
  await page.waitForTimeout(200);
}
await hold(null);
const final = await state();
log.push({ t: Math.round((Date.now() - t0) / 1000), final: true, ...final });
writeFileSync(join(OUT, 'log.json'), JSON.stringify({ log, errors }, null, 1));
console.log('final', JSON.stringify(final), 'errors', errors.length);
await browser.close();
