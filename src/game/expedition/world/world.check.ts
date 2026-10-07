/**
 * Node check for the expedition world layout (pure modules only):
 *
 *   npx esbuild src/game/expedition/world/world.check.ts --bundle \
 *     --platform=node --outfile=/tmp/world-check.cjs && node /tmp/world-check.cjs
 *
 * Verifies that placements sit on `expeditionHeight`, the bridge deck
 * matches `bridgeHeight`, the crevasse walls stay under the ladder and in
 * front of the carve, the rock band's holds are in the lane at climbable
 * spacing, the faces cover the cliff bands, the river stays in its channel,
 * and nothing intrudes into the walking corridor.
 */

import { bridgeHeight, CAMPS, CREVASSE_HALF_GAP, ROPE_END_S, ROPE_START_S, routeFrame } from '../exp-layout.js';
import { route } from '../exp-route.js';
import { expeditionHeight } from '../exp-terrain.js';
import { campLayouts, summitLayout } from './layout-camps.js';
import {
  BRIDGE_FRAME,
  BRIDGE_HALF_LENGTH,
  BRIDGE_LOGS,
  bridgeDeckY,
  bridgePoint,
  crevasseDepth,
  crevassePoint,
  crevasseWallHalf,
  type FaceGrid,
  faceGrid,
  ICE_FACE,
  LEDGE_UP_SIDE,
  ledgeWallGrid,
  outsideLane,
  RIVER_RIBBON_HALF,
  riverRows,
  ROCK_FACE,
  rockHolds,
} from './layout-features.js';
import {
  avalancheTrack,
  forestTrees,
  glacierSeams,
  moraineBoulders,
  ridgeRocks,
  rockfallGully,
  seracField,
  seracTower,
  valleyBoulders,
} from './layout-nature.js';
import { hairpinCairns, hairpins, sectionSigns, wandLayout } from './layout-route.js';
import {
  baseRadius,
  CORRIDOR_CLEAR,
  drain,
  groundMin,
  inStrip,
  type Item,
  MARKER_CLEAR,
  MARKER_KINDS,
  projectTo,
  routeClearance,
  SpacingGrid,
} from './layout-util.js';

let failures = 0;
let checks = 0;
function check(ok: boolean, what: string): void {
  checks++;
  if (!ok) {
    failures++;
    if (failures < 60) console.log('FAIL', what);
  }
}
const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps;
const t0 = performance.now();

// ------------------------------------------------------------ items -------

// Same order and spacing grids as the world system's build passes.
const lowlands = new SpacingGrid(16);
const camps = drain(campLayouts());
const summit = drain(summitLayout());
const groups: Record<string, Item[]> = {
  wands: drain(wandLayout()),
  cairns: drain(hairpinCairns()),
  valleyBoulders: drain(valleyBoulders(lowlands)),
  trees: drain(forestTrees(lowlands)),
  moraine: drain(moraineBoulders(lowlands)),
  ridge: drain(ridgeRocks(new SpacingGrid(16))),
  seracs: drain(seracField(new SpacingGrid(24))),
  summit: summit.items,
};
camps.forEach((c, i) => (groups[`camp${i}`] = c.items));
const tLayout = performance.now() - t0;

for (const [name, items] of Object.entries(groups)) {
  for (const it of items) {
    const label = `${name} ${it.kind} @ ${it.x.toFixed(1)},${it.z.toFixed(1)}`;
    // Never floating: the base is at or below the ground under its footprint.
    check(it.y <= groundMin(it.x, it.z, baseRadius(it.kind, it.r)) + 1e-6, `${label} floats`);
    // Never buried: no deeper than its intended sink plus the slope under it.
    const g = expeditionHeight(it.x, it.z);
    const allowed = it.kind === 'serac' ? 1.7 : it.kind === 'boulder' ? it.size * 0.35 : 0.42;
    check(g - it.y <= allowed + Math.max(0.6, it.r * 0.9) + 0.02, `${label} buried ${(g - it.y).toFixed(2)}`);
    // Corridor.
    const limit = MARKER_KINDS.has(it.kind) ? MARKER_CLEAR : CORRIDOR_CLEAR;
    check(routeClearance(it.x, it.z, it.r) >= limit - 1e-6, `${label} in corridor (${routeClearance(it.x, it.z, it.r).toFixed(2)})`);
  }
}
const av = avalancheTrack();
const gully = rockfallGully();
for (const it of [...groups.moraine, ...groups.ridge, ...groups.trees]) {
  check(!inStrip(av, it.x, it.z), `boulder in avalanche track ${it.x},${it.z}`);
  check(!inStrip(gully, it.x, it.z), `boulder in rockfall gully ${it.x},${it.z}`);
}
// Wands every ~25 m, alternate sides where possible.
check(groups.wands.length > 200, `wand count ${groups.wands.length}`);
const signs = drain(sectionSigns());
check(signs.length === 8, `section signs ${signs.length}`);
for (const s of [...signs, ...camps.flatMap((c) => c.signs), ...summit.signs]) {
  check(s.y <= expeditionHeight(s.x, s.z) + 1e-6 && expeditionHeight(s.x, s.z) - s.y < 0.5, `sign on ground ${s.lines[0]}`);
  check(routeClearance(s.x, s.z, 0.7) >= MARKER_CLEAR - 1e-6, `sign clear ${s.lines[0]}`);
}
check(hairpins().length >= 9, `hairpins ${hairpins().length}`);
check(groups.cairns.length === hairpins().length, `cairns at every hairpin ${groups.cairns.length}`);
for (const c of camps) {
  check(c.items.filter((i) => i.kind === 'tent').length >= (c.index === 0 ? 8 : 2), `camp ${c.index} tents`);
  check(near(c.fire.y, expeditionHeight(c.fire.x, c.fire.z), 1e-9), `camp ${c.index} fire on ground`);
  for (const d of c.dancers) check(near(d.y, expeditionHeight(d.x, d.z), 1e-9), 'dancer on ground');
}
check(camps.length === CAMPS.length, 'all camps');

// ----------------------------------------------------------- serac --------

const tower = seracTower();
check(near(tower.baseY, expeditionHeight(tower.x, tower.z), 1e-9), 'collapse serac base on ground');
check(routeClearance(tower.centreX, tower.centreZ, Math.hypot(tower.width, tower.depth) / 2) >= CORRIDOR_CLEAR, 'collapse serac clear of path');

// ----------------------------------------------------------- bridge -------

let bridgeMax = 0;
for (const log of BRIDGE_LOGS) {
  for (let a = -BRIDGE_HALF_LENGTH + 1e-3; a < BRIDGE_HALF_LENGTH; a += 0.25) {
    const p = bridgePoint(a, log.across);
    const h = bridgeHeight(p.x, p.z);
    check(h !== null, `bridge deck footprint ${a}`);
    if (h !== null) bridgeMax = Math.max(bridgeMax, Math.abs(h - bridgeDeckY(a)));
  }
}
check(bridgeMax < 1e-5, `bridge deck matches bridgeHeight (max error ${bridgeMax})`);

// ------------------------------------------------------------ river -------

const rows = drain(riverRows());
let wet = 0;
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  if (i > 0) check(r.y <= rows[i - 1].y + 1e-9, `river never flows uphill (${r.along})`);
  const f = BRIDGE_FRAME;
  for (const s of [-1, 1]) {
    const ex = r.x + f.tx * s * RIVER_RIBBON_HALF;
    const ez = r.z + f.tz * s * RIVER_RIBBON_HALF;
    check(expeditionHeight(ex, ez) >= r.y + 0.1 - 1e-6, `river edge tucked under bank (${r.along})`);
  }
  if (r.wet) wet++;
}
const mid = rows.reduce((b, r) => (Math.abs(r.along) < Math.abs(b.along) ? r : b));
check(mid.wet && bridgeDeckY(0) - mid.y > 2, `water under the bridge (${(bridgeDeckY(0) - mid.y).toFixed(2)} m below the deck)`);
check(wet > rows.length * 0.5, `river mostly visible (${wet}/${rows.length})`);

// --------------------------------------------------------- crevasse -------

for (let l = -30; l <= 30; l += 1) {
  const depth = crevasseDepth(l);
  if (depth < 0.5) continue;
  for (const side of [-1, 1]) {
    const top = crevassePoint(side * crevasseWallHalf(0, depth), l);
    const lipY = expeditionHeight(top.x, top.z);
    for (let down = 0.8; down < depth; down += 1.1) {
      const p = crevassePoint(side * crevasseWallHalf(down, depth), l);
      // The wall stands in the open slot: the carved terrain there is below it.
      check(expeditionHeight(p.x, p.z) <= lipY - down + 0.25, `crevasse wall in front of carve l=${l} down=${down.toFixed(1)}`);
    }
  }
}
check(CREVASSE_HALF_GAP > 1, 'crevasse gap');

// ----------------------------------------------------------- faces --------

function faceChecks(g: FaceGrid): { laneIssues: number } {
  let laneIssues = 0;
  const face = g.face;
  const base = face.crossing;
  for (let c = 0; c < g.cols; c++) {
    const along = g.along[c];
    if (Math.abs(along) > face.halfWidth - 7) continue;
    const inLane = outsideLane(face, along) < 0.99;
    for (let j = 1; j < g.rows; j++) {
      const i = c * g.rows + j;
      const x = g.x[i];
      const z = g.z[i];
      const y = g.y[i];
      // Just outside the face, the terrain is below the face point (nothing pokes through).
      const r = Math.hypot(x, z + 9000);
      const ox = x + (x / r) * 0.1;
      const oz = z + ((z + 9000) / r) * 0.1;
      // Points under the snow are hidden anyway.
      if (y < expeditionHeight(x, z) + 0.02) continue;
      // Just in front of a visible face point, the terrain must be lower.
      const poke = expeditionHeight(ox, oz) > y + 0.05;
      if (inLane) {
        if (poke) laneIssues++;
      } else check(!poke, `${face.id} face covers terrain c=${c} j=${j}`);
    }
    // Slab: starts on the lip, ends under the terrain.
    const s0 = c * g.slabRows;
    const sl = s0 + g.slabRows - 1;
    check(near(g.sy[s0], g.lip[c], 1e-9), `${face.id} slab meets lip`);
    check(g.sy[sl] < expeditionHeight(g.sx[sl], g.sz[sl]), `${face.id} slab dives under terrain`);
    for (let k = 1; k < g.slabRows - 1; k++) {
      check(g.sy[s0 + k] >= expeditionHeight(g.sx[s0 + k], g.sz[s0 + k]) + 0.2 - 1e-9, `${face.id} slab above terrain`);
    }
  }
  check(g.lip[Math.floor(g.cols / 2)] >= base.topY, `${face.id} lip reaches topY`);
  check(face.halfWidth * 2 >= (face.id === 'ice' ? 60 : 45), `${face.id} face wide enough`);
  return { laneIssues };
}

const ice = drain(faceGrid(ICE_FACE));
const rock = drain(faceGrid(ROCK_FACE));
const iceLane = faceChecks(ice);
const rockLane = faceChecks(rock);

const holds = rockHolds(rock);
const nx = ROCK_FACE.crossing.nx;
const nz = ROCK_FACE.crossing.nz;
let maxOut = -Infinity;
let minOut = Infinity;
for (const h of holds) {
  const dx = h.x - ROCK_FACE.crossing.baseX;
  const dz = h.z - ROCK_FACE.crossing.baseZ;
  const along = dx * nz - dz * nx; // tangent (nz, -nx), as climb-system
  const out = dx * nx + dz * nz;
  check(Math.abs(along) <= ROCK_FACE.laneHalf - 0.25, `hold in lane (${along.toFixed(2)})`);
  if (!h.lip) {
    maxOut = Math.max(maxOut, out);
    minOut = Math.min(minOut, out);
  }
  check(h.y >= ROCK_FACE.crossing.baseY - 1 && h.y <= ROCK_FACE.crossing.topY + 1, 'hold height within the wall');
}
check(minOut >= 0 && maxOut < 0.4, `holds on the face plane (out ${minOut.toFixed(2)}..${maxOut.toFixed(2)})`);
const plain = holds.filter((h) => !h.lip).sort((a, b) => a.y - b.y);
// The four main columns (the occasional fifth hold at the lane edge is a bonus).
const main = plain.filter((h) => Math.abs(h.along) < 1.75);
// Each hold has a neighbour 0.3-0.6 m above it (climbable spacing) until the top rows.
let gaps = 0;
for (const h of main) {
  if (h.y > plain[plain.length - 1].y - 0.6) continue;
  const next = main.some((o) => o !== h && o.y > h.y + 0.25 && Math.hypot(o.y - h.y, o.along - h.along) < 0.75);
  if (!next) gaps++;
}
check(gaps === 0, `holds have a reachable next hold (${gaps} gaps)`);
const lipHolds = holds.filter((h) => h.lip);
check(lipHolds.length >= 2 && lipHolds.every((h) => h.y >= ROCK_FACE.crossing.topY - 0.3), 'lip jugs on top');
check(plain[plain.length - 1].y >= ROCK_FACE.crossing.topY - 1.2, 'holds reach the top');

// ------------------------------------------------------- ledge wall -------

const ledge = drain(ledgeWallGrid());
for (let c = 0; c < ledge.cols; c++) {
  for (let j = 1; j < ledge.rows - 1; j++) {
    const i = c * ledge.rows + j;
    const p = projectTo(ledge.x[i], ledge.z[i], { s: 0, d: 0, dist: 0, elev: 0 });
    check(p.dist >= 2.35, `ledge wall clear of the rope and path (${p.dist.toFixed(2)})`);
    check(Math.sign(p.d) === LEDGE_UP_SIDE || p.dist < 0.01, 'ledge wall on the uphill side');
    if (ledge.y[i] < p.elev + 0.2) continue; // the foot row tucks under the snow
    check(expeditionHeight(ledge.x[i], ledge.z[i]) <= ledge.y[i] + 0.2, `ledge wall proud of the terrain c=${c} j=${j}`);
  }
}
check(routeFrame(ROPE_START_S).elev < routeFrame(ROPE_END_S).elev + 100, 'rope ledge');

// ----------------------------------------------------------- seams --------

const seams = drain(glacierSeams());
check(seams.length > 30, `seams ${seams.length}`);

// ---------------------------------------------------------- summary -------

const counts = Object.entries(groups)
  .map(([k, v]) => `${k}=${v.length}`)
  .join(' ');
console.log(counts);
console.log(`river rows ${rows.length} (wet ${wet}), holds ${holds.length}, seams ${seams.length}, signs ${signs.length}`);
console.log(`lane face points behind terrain: ice ${iceLane.laneIssues}, rock ${rockLane.laneIssues}`);
for (const f of [ICE_FACE, ROCK_FACE]) {
  const b = f.crossing;
  const g = expeditionHeight(b.baseX, b.baseZ);
  if (g - b.baseY > 0.5)
    console.log(
      `WARNING (terrain contract): ground at the ${f.id} wall's base point is ${g.toFixed(2)}, ${(g - b.baseY).toFixed(2)} m above baseY ` +
        `(the route bench ramps obliquely across the cliff band)`,
    );
}
console.log(`layout time ${tLayout.toFixed(0)} ms, route ${route.length.toFixed(0)} m`);
console.log(`${checks - failures}/${checks} checks passed`);
if (failures) throw new Error(`${failures} world layout checks failed`);
