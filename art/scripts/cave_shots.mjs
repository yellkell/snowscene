/**
 * Runtime stills of the baked ice cave from the built game (dist served on :8090), for look-dev and checks.
 *
 *   node art/scripts/cave_shots.mjs [--url http://localhost:8090/] [--out art/renders/rt] [--only jetty,wheel]
 *
 * Jumps into the cave (debug handle), stops the render loop and renders fixed eye points through a camera
 * of its own, then plays the course on its own (the desktop W step) to check it climbs to the beacon.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : d;
};
const URL_ = arg('--url', 'http://localhost:8090/');
const OUT = arg('--out', 'art/renders/rt');
const ONLY = arg('--only', '');
const PLAY = process.argv.includes('--play');
const DEBUG = Number(arg('--debug', '0'));
const BEACON = Number(arg('--beacon', '0'));
const TAG = arg('--tag', '');
mkdirSync(OUT, { recursive: true });

// eye, target (course space), fov
const SHOTS = {
  jetty: [[0, 1.65, 0.66], [5.4, 1.6, -2.5], 70],
  jetty_up: [[0, 1.65, 0.66], [1.0, 9.0, -9.0], 75],
  feet: [[0, 1.65, 0.66], [0.0, 0.0, -1.0], 75],
  deck: [[0.2, 1.25, 0.5], [-0.1, 0.0, -0.75], 60],
  lamp: [[0.5, 0.45, 0.2], [0.25, 0.0, -0.45], 50],
  rope: [[5.3, 1.65, 0.9], [6.06, 3.6, 0.0], 55],
  gondola: [[0, 11.05, -12.0], [0.7, 9.0, -9.0], 70],
  loft: [[5.4, 4.85, 0], [4.0, 4.6, -7.0], 70],
  ledge: [[5.4, 6.05, -6], [0.0, 5.5, -7.0], 70],
  wingrack: [[0, 11.05, -5.34], [0.8, 10.5, -12.0], 70],
  wheel: [[0, 11.05, -12], [-5.4, 12.6, -13.0], 70],
  chimney: [[-5.4, 20.05, -19], [-3.0, 30.0, -14.0], 80],
  beacon: [[0.9, 28.05, -12.7], [-1.0, 10.0, -6.0], 80],
  overview: [[6.5, 15.0, -1.0], [-1.0, 9.0, -12.0], 80],
};

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('requestfailed', (r) => logs.push(`[error] request failed ${r.url()} ${r.failure()?.errorText}`));
await page.goto(`${URL_}?debug`);
await page.waitForFunction(() => !!globalThis.__snow, null, { timeout: 120000 });
await page.evaluate(() => {
  const s = globalThis.__snow;
  s.setPhase(s.Phase.Cave);
});
await page.waitForFunction(() => globalThis.__snow.cave.inside && globalThis.__snow.cave.v.baked, null, { timeout: 120000 });
await page.waitForTimeout(1500);

if (PLAY) {
  // the desktop step: W carries you onto the next deck when its lamps are green; E takes parts / lights
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < 400000) {
    const st = await page.evaluate(() => {
      const s = globalThis.__snow;
      return { tracked: s.cave.tracked, phase: s.game.phase.value, parts: s.game.partsFound.value, lit: s.game.beaconLit.value };
    });
    const line = JSON.stringify(st);
    if (line !== last) console.log(((Date.now() - t0) / 1000).toFixed(1), line);
    last = line;
    if (st.phase !== 'Cave' && st.phase !== 'Beacon') break;
    await page.keyboard.press('KeyE');
    await page.keyboard.press('KeyW');
    await page.waitForTimeout(250);
  }
} else {
  await page.evaluate(() => {
    const s = globalThis.__snow;
    s.world.renderer.setAnimationLoop(null);
  });
  await page.evaluate((b) => (globalThis.__beacon = b), BEACON);
  if (DEBUG) {
    await page.evaluate((d) => {
      globalThis.__snow.cave.v.root.traverse((o) => {
        if (o.material?.uniforms?.uCaveDebug) o.material.uniforms.uCaveDebug.value = d;
      });
    }, DEBUG);
  }
  for (const [name, [e, t, fov]] of Object.entries(SHOTS)) {
    if (ONLY && !ONLY.split(',').includes(name)) continue;
    await page.evaluate(
      ([e, t, fov]) => {
        const s = globalThis.__snow;
        const w = s.world;
        const c = new w.camera.constructor(fov, 1280 / 720, 0.05, 500);
        c.fov = fov;
        c.aspect = 1280 / 720;
        c.near = 0.05;
        c.far = 500;
        c.updateProjectionMatrix();
        c.position.set(e[0], e[1] - 700, e[2] - 93);
        c.lookAt(t[0], t[1] - 700, t[2] - 93);
        c.updateMatrixWorld();
        // move the player there too so per-viewer terms (glints) follow
        w.player.position.set(e[0], e[1] - 700 - 1.6, e[2] - 93);
        w.player.updateMatrixWorld(true);
        s.cave.view.beacon = globalThis.__beacon ?? 0;
        s.__t = (s.__t ?? 100) + 1 / 60;
        w.update(1 / 60, s.__t);
        w.player.position.set(e[0], e[1] - 700 - 1.6, e[2] - 93);
        w.player.updateMatrixWorld(true);
        w.renderer.info.autoReset = false;
        w.renderer.info.reset();
        w.renderer.render(w.scene, c);
        const r = w.renderer.info;
        globalThis.__info = { calls: r.render.calls, tris: r.render.triangles, textures: r.memory.textures, geometries: r.memory.geometries };
        r.autoReset = true;
      },
      [e, t, fov],
    );
    console.log('info', name, JSON.stringify(await page.evaluate(() => globalThis.__info)));
    await page.screenshot({ path: join(OUT, `cave_${name}${DEBUG ? '_d' + DEBUG : ''}${BEACON ? '_lit' : ''}${TAG}.png`) });
    console.log('shot', name);
  }
}
const errs = logs.filter((l) => /error|warn/i.test(l));
console.log(errs.slice(0, 20).join('\n'));
await browser.close();
