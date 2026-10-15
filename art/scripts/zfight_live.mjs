// Depth fights in the running cave, whatever meshes they're between: each view is rendered twice in one
// frame with the near plane nudged 2 % (only the depth precision changes, nothing moves), and pixels that
// flip are fighting. A grid of viewpoints through the works; then, in the worst views, each mesh is hidden
// in turn to see whose fight it is.  node art/scripts/zfight_live.mjs [--url ...]
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : d;
};
const BASE = arg('--url', 'http://localhost:8090/index.html');
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: process.argv.includes('--big') ? { width: 1600, height: 900 } : { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}?debug&zf=${Date.now()}`);
await page.waitForFunction(() => globalThis.__snow?.bakedView?.tutorialReady, null, { timeout: 180000 });
await page.evaluate(() => globalThis.__snow.setPhase(globalThis.__snow.Phase.Cave));
await page.waitForFunction(() => globalThis.__snow.cave.inside && globalThis.__snow.cave.v?.baked, null, { timeout: 60000 });
await page.waitForTimeout(4000);

if (process.argv.includes('--control')) await page.evaluate(() => (globalThis.__zfNear = 0.06));
const viewArg = process.argv.indexOf('--view');
if (viewArg > 0) await page.evaluate((v) => (globalThis.__zfView = v), process.argv[viewArg + 1].split(',').map(Number));
const hideArg = process.argv.indexOf('--hide');
if (hideArg > 0) await page.evaluate((names) => globalThis.__snow.world.scene.traverse((o) => { if (names.includes(o.name)) o.visible = false; }), process.argv[hideArg + 1].split(','));
const nearArg = process.argv.indexOf('--near');
if (nearArg > 0) await page.evaluate((n) => (globalThis.__zfBase = n), Number(process.argv[nearArg + 1]));
const out = await page.evaluate(() => {
  const s = globalThis.__snow;
  const w = s.world;
  const r = w.renderer;
  const gl = r.getContext();
  const W = r.domElement.width;
  const H = r.domElement.height;
  const A = new Uint8Array(W * H * 4);
  const B = new Uint8Array(W * H * 4);
  const statics = w.scene.getObjectByName('BakedCaveStatics');
  const O = statics.getWorldPosition(statics.position.clone());
  const cam = new w.camera.constructor(70, W / H, 0.06, 6000);
  const V = cam.position.constructor;
  const shoot = (near) => {
    cam.near = near;
    cam.updateProjectionMatrix();
    r.setRenderTarget(null);
    r.render(w.scene, cam);
  };
  const flips = () => {
    shoot(globalThis.__zfBase ?? 0.06);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, A);
    shoot(globalThis.__zfNear ?? (globalThis.__zfBase ?? 0.06) * 1.02);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, B);
    let n = 0;
    for (let i = 0; i < A.length; i += 4) {
      if (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]) > 45) n++;
    }
    return n;
  };
  const views = [];
  const dirs = [[1, -0.25, 0], [-1, -0.25, 0], [0, -0.25, 1], [0, -0.25, -1], [0.7, 0.2, -0.7], [-0.7, 0.2, 0.7], [0.7, -0.5, 0.7], [-0.7, -0.5, -0.7]];
  // where you stand: eye height over every deck square (the Decks bank's instances)
  const decks = w.scene.getObjectByName('Decks');
  const M = new decks.matrixWorld.constructor();
  const eyes = [];
  for (let i = 0; i < decks.count; i++) {
    decks.getMatrixAt(i, M);
    const p = new V().setFromMatrixPosition(M.premultiply(decks.matrixWorld));
    eyes.push([p.x - O.x, p.y - O.y + 1.65, p.z - O.z]);
  }
  const one = globalThis.__zfView;
  if (one) {
    eyes.length = 0;
    eyes.push(one.slice(0, 3));
    dirs.length = 0;
    dirs.push([one[3] - one[0], one[4] - one[1], one[5] - one[2]]);
  }
  for (const e of eyes) {
    for (const d of dirs) {
      cam.position.set(O.x + e[0], O.y + e[1], O.z + e[2]);
      cam.lookAt(cam.position.x + d[0], cam.position.y + d[1], cam.position.z + d[2]);
      cam.updateMatrixWorld(true);
      views.push({ p: e.map((v) => +v.toFixed(2)), d, n: flips() });
    }
  }
  views.sort((a, b) => b.n - a.n);
  const total = views.reduce((t, v) => t + v.n, 0);
  // whose fights: in the worst views, hide each visible mesh in turn
  const blame = {};
  const meshes = [];
  w.scene.traverseVisible((o) => {
    if (o.isMesh || o.isInstancedMesh) meshes.push(o);
  });
  for (const v of views.slice(0, 8)) {
    cam.position.set(O.x + v.p[0], O.y + v.p[1], O.z + v.p[2]);
    cam.lookAt(cam.position.x + v.d[0], cam.position.y + v.d[1], cam.position.z + v.d[2]);
    cam.updateMatrixWorld(true);
    const base = flips();
    for (const m of meshes) {
      m.visible = false;
      const n = flips();
      m.visible = true;
      const drop = base - n;
      if (drop > 30) {
        const key = m.name || m.parent?.name || '?';
        blame[key] = (blame[key] || 0) + drop;
      }
    }
  }
  // pictures: the worst views with their flipping pixels painted magenta
  const masks = [];
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d');
  const seenSpot = new Set();
  for (const v of views) {
    const key = v.p.join(',');
    if (seenSpot.has(key)) continue;
    seenSpot.add(key);
    if (masks.length >= 6) break;
    cam.position.set(O.x + v.p[0], O.y + v.p[1], O.z + v.p[2]);
    cam.lookAt(cam.position.x + v.d[0], cam.position.y + v.d[1], cam.position.z + v.d[2]);
    cam.updateMatrixWorld(true);
    flips();
    const img = ctx.createImageData(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = ((H - 1 - y) * W + x) * 4;
      const o = (y * W + x) * 4;
      const f = Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]) > 45;
      img.data[o] = f ? 255 : A[i];
      img.data[o + 1] = f ? 0 : A[i + 1];
      img.data[o + 2] = f ? 255 : A[i + 2];
      img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    masks.push([v.p, v.d, v.n, cv.toDataURL('image/jpeg', 0.85)]);
  }
  const where = [];
  return { total, where, masks, worst: views.slice(0, 10), blame: Object.entries(blame).sort((a, b) => b[1] - a[1]).slice(0, 20), origin: [O.x, O.y, O.z] };
});
mkdirSync('art/renders/zf', { recursive: true });
(out.masks || []).forEach(([p, d, n, url], i) => writeFileSync(`art/renders/zf/mask_${i}.jpg`, Buffer.from(url.split(',')[1], 'base64')));
delete out.masks;
console.log(JSON.stringify(out, null, 1));
console.log('errors', errors.length);
await browser.close();
