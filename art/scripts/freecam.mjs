// Render the running game from free cameras (headless, GPU): node art/scripts/freecam.mjs <spec.mjs>
// (the spec module's default export; functions for prep/eval/pos/look run in the page, with s = __snow)
// spec: { url?, query?: '?debug', phase?: 'Cave', waitCave?: bool, prep?: 'js run once loaded (s = __snow)',
//         shots: [{ name, pos: [x,y,z], look: [x,y,z], fov?: 70, eval?: 'js before this shot' }] }
// Positions can be functions (s => [x, y, z]) for things the scene knows (a hold's position). Shots go
// through the game's own camera and frame (the player is moved there, the desktop look turned). Writes art/renders/cam/<name>.jpg; reports console errors.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const spec = (await import(pathToFileURL(resolve(process.argv[2])).href)).default;
// functions travel to the page as source
const src = (f) => (typeof f === 'function' ? `return (${f.toString()})(s);` : f);
const OUT = spec.out ?? 'art/renders/cam';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: spec.width ?? 1280, height: spec.height ?? 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 300));
});
await page.goto(`${spec.url ?? 'http://localhost:8090/index.html'}${spec.query ?? '?debug'}&cam=${Date.now()}`);
await page.waitForFunction(() => globalThis.__snow?.bakedView?.tutorialReady, null, { timeout: 180000 });
if (spec.phase) await page.evaluate((p) => globalThis.__snow.setPhase(globalThis.__snow.Phase[p]), spec.phase);
if (spec.waitCave) await page.waitForFunction(() => globalThis.__snow.cave.inside && globalThis.__snow.cave.v?.baked, null, { timeout: 60000 });
await page.waitForTimeout(spec.settle ?? 4000);
if (spec.prep) {
  console.log('prep', JSON.stringify(await page.evaluate((code) => new Function('s', code)(globalThis.__snow), src(spec.prep))));
  await page.waitForTimeout(1500);
}
for (const shot of spec.shots) {
  if (shot.eval) console.log(shot.name, 'eval', JSON.stringify(await page.evaluate((code) => new Function('s', code)(globalThis.__snow), src(shot.eval))));
  await page.waitForTimeout(shot.wait ?? 300);
  const sh = { ...shot, pos: src(shot.pos), look: src(shot.look), eval: undefined };
  // The game's own camera, through its own frame: move the player so the eye lands at `pos`, and turn
  // the desktop look to face `look` (every system then culls, LODs and lights from there).
  await page.evaluate((sh) => {
    const s = globalThis.__snow;
    const w = s.world;
    const at = (v) => (typeof v === 'string' ? new Function('s', v)(s) : v);
    const p = at(sh.pos);
    const l = at(sh.look);
    const eye = w.camera.getWorldPosition(w.camera.position.clone());
    w.player.position.x += p[0] - eye.x;
    w.player.position.y += p[1] - eye.y;
    w.player.position.z += p[2] - eye.z;
    w.player.updateMatrixWorld(true);
    const dx = l[0] - p[0], dy = l[1] - p[1], dz = l[2] - p[2];
    s.look.yaw = Math.atan2(-dx, -dz) - w.player.rotation.y;
    s.look.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    if (sh.fov) {
      w.camera.fov = sh.fov;
      w.camera.updateProjectionMatrix();
    }
  }, sh);
  await page.waitForTimeout(sh.settle ?? 700);
  await page.screenshot({ path: `${OUT}/${shot.name}.jpg`, type: 'jpeg', quality: 88 });
  console.log('shot', shot.name);
}
console.log('errors', errors.length, errors.slice(0, 3));
await browser.close();
