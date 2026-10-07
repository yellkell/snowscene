/**
 * Node smoke test of the Three.js build path: runs every build pass to the
 * end and reports chunk counts, the slowest build step, non-finite vertices,
 * and the draw calls / triangles visible from points along the route.
 *
 *   npx esbuild src/game/expedition/world/world.smoke.ts --bundle --platform=node \
 *     --alias:@iwsdk/core=three --outfile=/tmp/world-smoke.cjs && node /tmp/world-smoke.cjs
 *
 * (Aliasing @iwsdk/core to plain three is only for this headless test; the
 * app always imports Three through @iwsdk/core.)
 */

// Minimal canvas stand-in for the sign atlas.
const ctxStub = new Proxy(
  {},
  {
    get: (_t, k) => {
      if (k === 'measureText') return () => ({ width: 100 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
      return () => {};
    },
    set: () => true,
  },
);
(globalThis as unknown as { document: unknown }).document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ctxStub }),
};

import { type BufferGeometry, type InstancedMesh, type Mesh, Vector3 } from '@iwsdk/core';
import { routeFrame } from '../exp-layout.js';
import { route } from '../exp-route.js';
import { type Chunk, ChunkGrid, DETAIL_RADIUS, LARGE_RADIUS, LOD_RADIUS } from './chunks.js';
import { rockMaterial, signMaterial } from './materials.js';
import { SignAtlas } from './sign-atlas.js';
import { makePasses } from './world-build.js';

// The land textures are already built by the tutorial in the app; warm them here.
rockMaterial();
const atlas = new SignAtlas();
const grid = new ChunkGrid(() => signMaterial(atlas.texture));
const chunks: Chunk[] = [];
let fires = 0;
let holds = 0;
let serac = 0;
const passes = makePasses(grid, atlas, {
  fire: () => fires++,
  holds: (h, c) => {
    holds = h.proxies.length;
    c.extras.push(h.mesh);
  },
  serac: () => serac++,
  chunkDone: (c) => chunks.push(c),
});
const t0 = performance.now();
let steps = 0;
let worst = 0;
let worstPass = '';
for (const p of passes) {
  const gen = p.run();
  for (;;) {
    const a = performance.now();
    const r = gen.next();
    const dt = performance.now() - a;
    if (dt > 25) console.log(`slow step: ${p.name} #${steps} ${dt.toFixed(1)} ms`);
    if (dt > worst) {
      worst = dt;
      worstPass = p.name;
    }
    steps++;
    if (r.done) break;
  }
}
console.log(
  `built ${chunks.length} chunks in ${(performance.now() - t0).toFixed(0)} ms over ${steps} steps ` +
    `(slowest step ${worst.toFixed(1)} ms in '${worstPass}'); fires ${fires}, holds ${holds}, collapsing serac ${serac}`,
);

const tris = (g: BufferGeometry) => (g.index ? g.index.count : g.getAttribute('position').count) / 3;
const meshesOf = (c: Chunk, hi: boolean): Mesh[] => {
  const out: Mesh[] = [];
  for (const o of c.group.children) if (o !== c.hi && o !== c.lo && (o as Mesh).isMesh) out.push(o as Mesh);
  for (const o of (hi ? c.hi : c.lo).children) out.push(o as Mesh);
  return out;
};
let bad = 0;
for (const c of chunks) {
  if (!Number.isFinite(c.radius) || !Number.isFinite(c.centre.x)) {
    bad++;
    console.log('chunk without bounds', c.key, c.group.children.length);
  }
  for (const m of [...meshesOf(c, true), ...meshesOf(c, false)]) {
    const p = m.geometry.getAttribute('position').array as Float32Array;
    for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i])) bad++;
  }
}

let maxCalls = 0;
let maxCallsAt = 0;
let maxTris = 0;
let maxTrisAt = 0;
const head = new Vector3();
for (let s = 0; s <= route.length; s += 25) {
  const f = routeFrame(s);
  head.set(f.x, f.elev + 1.6, f.z);
  let calls = 0;
  let t = 0;
  for (const c of chunks) {
    const d = head.distanceTo(c.centre) - c.radius;
    if (d > (c.layer === 'detail' ? DETAIL_RADIUS : LARGE_RADIUS)) continue;
    for (const m of meshesOf(c, d + c.radius < LOD_RADIUS)) {
      calls++;
      t += tris(m.geometry) * ((m as InstancedMesh).isInstancedMesh ? (m as InstancedMesh).count : 1);
    }
  }
  if (calls > maxCalls) {
    maxCalls = calls;
    maxCallsAt = s;
  }
  if (t > maxTris) {
    maxTris = t;
    maxTrisAt = s;
  }
}
console.log(
  `worst view along the route (before frustum culling, excluding fires): ${maxCalls} draw calls at s=${maxCallsAt}, ` +
    `${Math.round(maxTris / 1000)}k triangles at s=${maxTrisAt}`,
);
if (bad) throw new Error(`${bad} non-finite vertex values`);
if (holds < 200 || fires !== 5 || serac !== 1) throw new Error('missing content');
if (maxCalls > 80) throw new Error('draw call budget exceeded');
console.log('smoke OK');
