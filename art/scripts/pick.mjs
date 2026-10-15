// What's under given pixels of a freecam view: node art/scripts/pick.mjs "x,y,z" "lx,ly,lz" "px,py;px,py;..."
// (world-space eye and look target as freecam takes them; pixels in the 1280x720 shot)
import { chromium } from 'playwright';
const [pos, look, pix] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(`http://localhost:8090/index.html?debug&pk=${Date.now()}`);
await page.waitForFunction(() => globalThis.__snow?.bakedView?.tutorialReady, null, { timeout: 180000 });
await page.evaluate(() => globalThis.__snow.setPhase(globalThis.__snow.Phase.Cave));
await page.waitForFunction(() => globalThis.__snow.cave.inside && globalThis.__snow.cave.v?.baked, null, { timeout: 60000 });
await page.waitForTimeout(6000);
await page.evaluate(([pos, look]) => {
  const s = globalThis.__snow;
  const w = s.world;
  const p = pos.split(',').map(Number);
  const l = look.split(',').map(Number);
  const eye = w.camera.getWorldPosition(w.camera.position.clone());
  w.player.position.x += p[0] - eye.x;
  w.player.position.y += p[1] - eye.y;
  w.player.position.z += p[2] - eye.z;
  w.player.updateMatrixWorld(true);
  const dx = l[0] - p[0], dy = l[1] - p[1], dz = l[2] - p[2];
  s.look.yaw = Math.atan2(-dx, -dz) - w.player.rotation.y;
  s.look.pitch = Math.atan2(dy, Math.hypot(dx, dz));
}, [pos, look]);
await page.evaluate((f) => { globalThis.__snow.lodDebug.force = 1; globalThis.__pickFov = f; }, Number(process.argv[5] || 0));
await page.waitForTimeout(800);
const out = await page.evaluate(([pos, look, pix]) => {
  globalThis.__snow.world.scene.updateMatrixWorld(true);
  const s = globalThis.__snow;
  const w = s.world;
  const cam = w.camera;
  if (globalThis.__pickFov) { cam.fov = globalThis.__pickFov; cam.updateProjectionMatrix(); cam.updateMatrixWorld(true); }
  const E = cam.getWorldPosition(cam.position.clone());
  const O = w.scene.getObjectByName('BakedCaveStatics').getWorldPosition(cam.position.clone());
  const kinds = {};
  w.scene.traverse((o) => {
    if (o.geometry && /Works/.test((o.parent?.name ?? '') + (o.parent?.parent?.name ?? '') + o.name)) {
      o.geometry.computeBoundingSphere();
      o.geometry.computeBoundingBox();
      kinds[o.type + ':' + o.name + ':' + o.visible] = 1;
    }
  });
  const shot = 'x,';
  const rc = new s.Raycaster();
  const res = [];
  for (const q of pix.split(';')) {
    const [x, y] = q.split(',').map(Number);
    rc.setFromCamera({ x: (x / 1280) * 2 - 1, y: -(y / 720) * 2 + 1 }, cam);
    const hits = rc.intersectObject(w.scene, true).filter((h) => h.object.visible && !/Pool|Shaft|Sky|Glitter/.test(h.object.name + (h.object.parent?.name ?? ''))).slice(0, 3);
    res.push([q, hits.map((h) => {
      let o = h.object;
      const chain = [];
      while (o && chain.length < 4) { chain.push(o.name || o.type); o = o.parent; }
      return { chain: chain.join('<'), local: [h.point.x - O.x, h.point.y - O.y, h.point.z - O.z].map((v) => +v.toFixed(2)), d: +h.distance.toFixed(2) };
    })]);
  }
  return [shot, [E.x - O.x, E.y - O.y, E.z - O.z].map((v) => +v.toFixed(2)), ...res];
}, [pos, look, pix]);
const { writeFileSync } = await import('node:fs');
out.shift();
await page.screenshot({ path: 'art/renders/cam/pick.jpg', type: 'jpeg', quality: 85 });
for (const r of out) console.log(JSON.stringify(r));
await browser.close();
