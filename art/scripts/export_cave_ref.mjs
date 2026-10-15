/**
 * Run the game's own cave builder in Node and write what it places as reference data for the Blender
 * rebuild of the ice cave (art/scripts/cave_build.py), so the photoreal works trace exactly the timbers
 * the gameplay's clearance logic laid out.
 *
 *   node art/scripts/export_cave_ref.mjs
 *
 * Writes art/work/cave_ref/cave_layout.json (course space, game axes, Y up):
 *   parts      every primitive of every works mesh: group, three geometry type + parameters, matrix, material
 *   lanterns   lantern points (group-local, like the parts)
 *   groups     where each group lives: statics/racks/plinth in course space, platforms at their anchor,
 *              the wheel at its hub, the brazier and torch at their own origins
 *   platforms  id, kind, claim, berths, keys, loopBars, the anchor and deck tiles at bar 0
 *   swept      every platform's swept frame boxes over its cycle (for clearance in Blender)
 *   shell      the procedural cave shell's vertex grid (rings x segments) and the shellFrame table
 */
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'art', 'work', 'cave_ref');
mkdirSync(OUT, { recursive: true });

const ctx2d = new Proxy(
  {},
  {
    get: (t, k) => {
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient' || k === 'createPattern') return () => ({ addColorStop() {} });
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

const C = await load('src/game/cave/cave-build.ts');
const S = await load('src/game/cave/cave-score.ts');
const r4 = (v) => Math.round(v * 1e5) / 1e5;
const v3 = (v) => [r4(v.x), r4(v.y), r4(v.z)];

C.caveRec.on = true;
const cave = C.buildCave();
C.caveRec.on = false;

const groups = { statics: [0, 0, 0], wheel: v3(cave.wheel.position), plinth: [0, 0, 0], torch: v3(cave.torchHome) };
for (const p of cave.platforms) groups[`platform:${p.spec.id}`] = v3(p.spec.keys[0].a);
let brazierAt = null;
cave.root.traverse((o) => {
  if (o.name === 'Brazier') brazierAt = v3(o.position);
});
groups.brazier = brazierAt;
for (const id of Object.keys(cave.parts)) groups[`rack:${id}`] = [0, 0, 0];

// The shell's vertex grid (rings x (segs + 1)) and the frame it was built on.
let shell = null;
cave.root.traverse((o) => {
  if (o.name === 'CaveShell') {
    const pos = o.geometry.getAttribute('position');
    const pts = [];
    for (let i = 0; i < pos.count; i++) pts.push([r4(pos.getX(i)), r4(pos.getY(i)), r4(pos.getZ(i))]);
    shell = { rings: 65, segs: 97, points: pts };
  }
});
const clr = C.caveClearance();
const frame = [];
for (let y = C.CAVE_SHELL.floorY; y <= C.CAVE_SHELL.top + 1e-6; y += 0.25) {
  const f = clr.frame(y);
  frame.push([r4(y), r4(f.cx), r4(f.cz), r4(f.rx), r4(f.rz)]);
}

const anchor = { x: 0, y: 0, z: 0 };
const platforms = S.PLATFORMS.map((p, i) => {
  S.anchorAt(p, 0, anchor);
  return {
    id: p.id,
    kind: p.kind,
    claim: p.claim,
    keys: p.keys,
    loopBars: p.loopBars ?? null,
    part: p.part ?? null,
    beacon: !!p.beacon,
    hop: p.hop ?? null,
    berths: S.berthsOf(p).map((a) => [a.x, a.y, a.z]),
    sweptMin: v3(clr.swept[i].min),
    sweptMax: v3(clr.swept[i].max),
    swept: Array.from(clr.swept[i].boxes).map(r4),
  };
});

const parts = {};
for (const id of Object.keys(cave.parts)) {
  const h = cave.parts[id];
  parts[id] = { at: v3(h.position), yaw: r4(h.rotation.y) };
}

const out = {
  origin: v3(C.CAVE_ORIGIN),
  poolY: C.POOL_Y,
  gondolaHang: C.GONDOLA_HANG,
  shellConst: C.CAVE_SHELL,
  grid: S.GRID,
  wheel: { c: v3(S.WHEEL_C), r: S.WHEEL_R, hub: v3(cave.wheel.position) },
  swing1: v3(S.SWING_1),
  swing2: v3(S.SWING_2),
  barSec: S.BAR_SEC,
  route: S.ROUTE,
  groups,
  parts: C.caveRec.parts.map((p) => ({ ...p, matrix: p.matrix.map(r4) })),
  lanterns: C.caveRec.lanterns,
  ropes: cave.ropeSpecs.map((r) => ({ platform: r.platform, local: v3(r.local), far: v3(r.far) })),
  platforms,
  keep: clr.keep.map((k) => ({ min: v3(k.min), max: v3(k.max) })),
  racks: parts,
  brazier: v3(cave.brazier),
  torchHome: v3(cave.torchHome),
  torchScale: C.TORCH_SCALE,
  shell,
  frame,
};
writeFileSync(join(OUT, 'cave_layout.json'), JSON.stringify(out));
const byGroup = {};
for (const p of out.parts) byGroup[p.group] = (byGroup[p.group] ?? 0) + 1;
console.log('parts', out.parts.length, 'lanterns', out.lanterns.length, 'ropes', out.ropes.length);
console.log(byGroup);
