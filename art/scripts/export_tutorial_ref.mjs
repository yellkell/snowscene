/**
 * Run the game's own tutorial builders in Node and write what they make as reference geometry for the
 * Blender rebuild, so the photoreal tutorial is traced over the exact layout the gameplay uses.
 *
 *   node art/scripts/export_tutorial_ref.mjs
 *
 * Writes art/work/tutorial_ref/<name>.obj (game space, Y up) and art/work/tutorial_ref/layout.json
 * (holds, key points, cave berths and platform keys). Canvas-drawn textures are stubbed out.
 */
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'art', 'work', 'tutorial_ref');
mkdirSync(OUT, { recursive: true });

// A do-nothing canvas so CanvasTexture-based builders run.
const ctx2d = new Proxy(
  {},
  {
    get: (t, k) => {
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient' || k === 'createPattern')
        return () => ({ addColorStop() {} });
      if (k === 'getImageData' || k === 'createImageData') return (x, y, w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
      if (k in t) return t[k];
      return () => {};
    },
    set: (t, k, v) => ((t[k] = v), true),
  },
);
globalThis.document = {
  createElement: () => ({ width: 1, height: 1, getContext: () => ctx2d, style: {} }),
  createElementNS: () => ({ width: 1, height: 1, getContext: () => ctx2d, style: {} }),
};
globalThis.window = globalThis;
globalThis.performance ??= { now: () => Date.now() };

async function load(entry) {
  const out = join(OUT, `_${entry.replace(/[\\/]/g, '_')}.mjs`);
  await build({
    entryPoints: [join(ROOT, entry)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: out,
    alias: { '@iwsdk/core': join(ROOT, 'art', 'scripts', 'iwsdk-shim.mjs') },
    logLevel: 'error',
  });
  return import(pathToFileURL(out).href);
}

const { OBJExporter } = await import('three/examples/jsm/exporters/OBJExporter.js');
const exporter = new OBJExporter();
function save(name, object) {
  object.updateMatrixWorld(true);
  writeFileSync(join(OUT, `${name}.obj`), exporter.parse(object));
  let tris = 0;
  object.traverse((o) => {
    if (o.isMesh && o.geometry) tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
  });
  console.log(name, Math.round(tris), 'tris');
}
function attempt(name, fn) {
  try {
    const o = fn();
    if (o) save(name, o);
  } catch (e) {
    console.log(name, 'FAILED', String(e).slice(0, 160));
  }
}

const W = await load('src/game/world-builders.ts');
const T = await load('src/game/terrain.ts');
const B = await load('src/game/cave-bluff.ts');
const layout = { holds: [], points: {}, cabins: [[-9.5, 4.5, 0.65], [-36, T.LAKE_CENTER_Z + 14, 1.3], [22, T.LAKE_CENTER_Z + 30, -0.9]] };

attempt('cliff', () => W.buildCliff());
attempt('trail_markers', () => W.buildTrailMarkers());
attempt('trail_sign', () => W.buildTrailSign());
attempt('summit_sign', () => W.buildSummitSign());
layout.cabins.forEach(([x, z, r], i) => attempt(`cabin_${i}`, () => W.buildCabin(x, z, r)));
attempt('lake', () => W.buildLake());
attempt('summit_flag', () => W.buildSummitFlag().group);
attempt('workbench', () => W.buildWorkbench(B.WORKBENCH_POS));
attempt('pole', () => W.buildPole());
attempt('rocks', () => W.buildRocks());
attempt('bluff', () => {
  const b = B.buildBluffWorld();
  return b.group ?? b.root ?? b;
});
function instances(root) {
  const out = [];
  root.updateMatrixWorld?.(true);
  const visit = (o) => {
    if (o.isInstancedMesh) {
      const m = new o.matrixWorld.constructor();
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m);
        m.premultiply(o.matrixWorld);
        out.push(Array.from(m.elements).map((v) => Math.round(v * 1e4) / 1e4));
      }
    }
    o.children?.forEach(visit);
  };
  visit(root);
  return out;
}
try {
  layout.rocks = instances(W.buildRocks());
} catch (e) {
  console.log('rocks instances FAILED', String(e).slice(0, 160));
}
try {
  const TR = await load('src/game/trees.ts');
  const forest = TR.buildForest();
  // one matrix per tree (the first instanced mesh of each chunk is the crown layer)
  const all = [];
  forest.traverse((o) => {
    if (o.isInstancedMesh && /crown|foliage|tree/i.test(o.name || '')) all.push(o);
  });
  layout.forestMeshes = all.map((o) => o.name);
  layout.trees = instances(all.length ? (() => { const g = new forest.constructor(); all.forEach((o) => g.add(o.clone())); return g; })() : forest);
  console.log('trees', layout.trees.length, layout.forestMeshes.slice(0, 6));
} catch (e) {
  console.log('forest FAILED', String(e).slice(0, 200));
}
for (const h of W.holdLayout()) layout.holds.push({ p: h.position.toArray(), lip: !!h.lip });
for (const k of ['BEACON_TOP', 'BUILD_STAND', 'WORKBENCH_POS', 'LAUNCH_EDGE']) layout.points[k] = B[k].toArray();
layout.points.BLUFF_TOP_Y = B.BLUFF_TOP_Y;
layout.cliff = { width: W.CLIFF_WIDTH, faceZ: W.CLIFF_FACE_Z, centerX: T.CLIFF_CENTER_X };

const F = await load('src/game/campfire.ts');
layout.points.FIRE_POS = F.FIRE_POS.toArray();
layout.points.PARTY_RADIUS = F.PARTY_RADIUS;

const G = await load('src/game/glider-model.ts');
attempt('glider', () => {
  const g = G.buildGlider();
  return g.root ?? g.group ?? g;
});

const C = await load('src/game/cave/cave-build.ts');
attempt('cave', () => {
  const c = C.buildCave();
  return c.root ?? c.group ?? c;
});
layout.cave = { origin: C.CAVE_ORIGIN.toArray(), poolY: C.POOL_Y, gondolaHang: C.GONDOLA_HANG };
const S = await load('src/game/cave/cave-score.ts');
layout.caveScore = {};
for (const [k, v] of Object.entries(S)) {
  if (typeof v === 'number') layout.caveScore[k] = v;
  else if (v && typeof v === 'object' && !Array.isArray(v) && 'x' in v && 'y' in v && 'z' in v) layout.caveScore[k] = [v.x, v.y, v.z];
}
if (S.PLATFORMS) layout.caveScore.PLATFORMS = JSON.parse(JSON.stringify(S.PLATFORMS));
if (S.ROUTE) layout.caveScore.ROUTE = JSON.parse(JSON.stringify(S.ROUTE));
if (S.GRID) layout.caveScore.GRID = JSON.parse(JSON.stringify(S.GRID));
writeFileSync(join(OUT, 'layout.json'), JSON.stringify(layout, null, 1));
console.log('layout.json', layout.holds.length, 'holds');
