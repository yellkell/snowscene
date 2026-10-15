// Where the triangles and draw calls go, per view: node art/scripts/profile_views.mjs [--url ...]
// For each view: the renderer's totals, then the heaviest visible meshes (instanced counted in full,
// frustum-tested by bounding sphere), and the transparent ones (overdraw on Quest).

import { chromium } from 'playwright';

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : d;
};
const BASE = arg('--url', 'http://localhost:8090/index.html');
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });

async function profile(page, label) {
  const r = await page.evaluate((label) => {
    const s = globalThis.__snow;
    const w = s.world;
    const cam = w.camera;
    cam.updateMatrixWorld(true);
    const proj = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse);
    const e = proj.elements;
    const planes = [
      [e[3] - e[0], e[7] - e[4], e[11] - e[8], e[15] - e[12]],
      [e[3] + e[0], e[7] + e[4], e[11] + e[8], e[15] + e[12]],
      [e[3] + e[1], e[7] + e[5], e[11] + e[9], e[15] + e[13]],
      [e[3] - e[1], e[7] - e[5], e[11] - e[9], e[15] - e[13]],
      [e[3] - e[2], e[7] - e[6], e[11] - e[10], e[15] - e[14]],
      [e[3] + e[2], e[7] + e[6], e[11] + e[10], e[15] + e[14]],
    ].map((p) => {
      const l = Math.hypot(p[0], p[1], p[2]);
      return p.map((v) => v / l);
    });
    const inFrustum = (c, rad) => planes.every((p) => p[0] * c.x + p[1] * c.y + p[2] * c.z + p[3] > -rad);
    const rows = [];
    w.scene.updateMatrixWorld(true);
    w.scene.traverseVisible((o) => {
      if (!(o.isMesh || o.isPoints) || !o.geometry) return;
      const g = o.geometry;
      if (!g.boundingSphere) g.computeBoundingSphere();
      const c = g.boundingSphere.center.clone().applyMatrix4(o.matrixWorld);
      const rad = g.boundingSphere.radius * o.matrixWorld.getMaxScaleOnAxis();
      if (!o.isInstancedMesh && o.frustumCulled !== false && !inFrustum(c, rad)) return;
      const per = o.isPoints ? (g.drawRange.count !== Infinity ? g.drawRange.count : g.attributes.position.count) : (g.index ? g.index.count : g.attributes.position.count) / 3;
      const inst = o.isInstancedMesh ? o.count : g.isInstancedBufferGeometry ? g.instanceCount : 1;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      let a = o;
      while (a && !a.name) a = a.parent;
      const family = (a?.name || '?').replace(/-\d+(-l[01])?$/, '').replace(/\d+$/, '#').slice(0, 24);
      rows.push({ family, name: (o.name || o.parent?.name || '?').slice(0, 28), tris: Math.round(per * (Number.isFinite(inst) ? inst : 1)), inst, transparent: !!m?.transparent, points: !!o.isPoints });
    });
    const ri = w.renderer.info;
    w.renderer.info.autoReset = false;
    w.renderer.info.reset();
    w.renderer.render(w.scene, cam);
    const tot = { calls: ri.render.calls, tris: ri.render.triangles, points: ri.render.points, textures: ri.memory.textures, geometries: ri.memory.geometries };
    w.renderer.info.autoReset = true;
    // group by name
    const by = {};
    for (const row of rows) {
      const k = row.family;
      by[k] = by[k] || { name: k, tris: 0, draws: 0, transparent: row.transparent, points: row.points };
      by[k].tris += row.tris;
      by[k].draws += 1;
    }
    const list = Object.values(by).sort((a, b) => b.tris - a.tris);
    // draws by family (chunks of one layer together; unnamed meshes by their nearest named ancestor)
    const fam = {};
    for (const row of rows) {
      const f = row.family;
      fam[f] = (fam[f] || 0) + 1;
    }
    const families = Object.entries(fam).sort((a, b) => b[1] - a[1]).slice(0, 16);
    return { label, tot, top: list.slice(0, 14), transparent: list.filter((x) => x.transparent).slice(0, 10), families };
  }, label);
  console.log(`\n== ${r.label}: calls ${r.tot.calls}  tris ${r.tot.tris}  points ${r.tot.points}  textures ${r.tot.textures}`);
  for (const x of r.top) console.log(`   ${String(x.tris).padStart(8)}  x${String(x.draws).padEnd(3)} ${x.name}${x.transparent ? '  [transparent]' : ''}`);
  console.log('   draws:', r.families.map(([f, n]) => `${f} ${n}`).join(', '));
  console.log('   transparent:', r.transparent.map((x) => `${x.name}(${x.tris}${x.points ? ' pts' : ''})`).join(', '));
}

async function tutorialPage() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${BASE}?debug&prof=${Date.now()}`);
  await page.waitForFunction(() => globalThis.__snow?.bakedView?.tutorialReady, null, { timeout: 180000 });
  await page.waitForTimeout(3000);
  return page;
}

// 1. tutorial: the start, half-way up the trail, the launch, a glide, the landing
{
  const page = await tutorialPage();
  await profile(page, 'trail start');
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(9000);
  await page.keyboard.up('KeyW');
  await profile(page, 'trail half-way');
  await page.evaluate(() => globalThis.__snow.setPhase(globalThis.__snow.Phase.Launch));
  await page.waitForTimeout(4000);
  await profile(page, 'launch deck');
  await page.keyboard.down('Space');
  await page.waitForTimeout(6000);
  await page.keyboard.up('Space');
  await profile(page, 'gliding');
  await page.waitForTimeout(8000);
  await profile(page, 'gliding later');
  await page.evaluate(() => globalThis.__snow.setPhase(globalThis.__snow.Phase.Cave));
  await page.waitForFunction(() => globalThis.__snow.cave.inside && globalThis.__snow.cave.v?.baked, null, { timeout: 60000 });
  await page.waitForTimeout(3000);
  await profile(page, 'cave entry');
  await page.close();
}
// 2. survivors, once the horde has built up
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${BASE}?survivors&debug&prof=${Date.now()}`);
  await page.waitForFunction(() => globalThis.__snow?.survivors?.arena, null, { timeout: 180000 });
  await page.waitForTimeout(5000);
  await profile(page, 'survivors early');
  // skip ahead: the horde at minute 6
  const ok = await page.evaluate(() => {
    const sv = globalThis.__snow.survivors;
    if (typeof sv.time !== 'number') return false;
    sv.time = 360;
    return true;
  });
  await page.waitForTimeout(25000);
  await profile(page, `survivors late${ok ? ' (t=6 min)' : ''}`);
  await page.close();
}
await browser.close();
