/**
 * Node check for the expedition terrain (not part of the app bundle):
 *
 *   npx esbuild src/game/expedition/terrain/check-terrain.ts --bundle \
 *     --platform=node --outfile=/tmp/check-terrain.cjs && node /tmp/check-terrain.cjs
 *
 * Exercises the tile builder (heights, normals, warp, timing), seams between
 * neighbouring tiles of one level and across LOD boundaries, the polar far
 * mesh and backdrop (orientation, shared seam), and drives the scheduler
 * along the route, gliding and teleporting with fake GPU sinks, checking the
 * coverage, alignment, upload-rate and far-sink invariants every frame.
 * Throws if anything fails.
 */

import { BAND_HALF_WIDTH, ICE_WALL_R, route, ROCK_BAND_R, routePoint, SUMMIT_X, SUMMIT_Z } from '../exp-route.js';
import { CREVASSE_DEPTH, CREVASSE_S, ROPE_START_S, routeFrame } from '../exp-layout.js';
import { expeditionHeight } from '../exp-terrain.js';
import { backdropHeight, backdropRings, buildBackdrop, buildFarMesh, farRings, type MeshData } from './far-builder.js';
import {
  FAR_OUTER_R,
  FAR_SINK,
  FEATURE_LEVEL,
  FEATURE_TILES,
  FIRST_REGULAR_LEVEL,
  LEVEL_COUNT,
  LEVELS,
  SLOTS_PER_LEVEL,
  type TileLevelSpec,
  tilePayloadBytes,
  tileVertexCount,
} from './terrain-config.js';
import { buildTile, payloadViews, perimeterVertex, type TilePayload, tileIndexPattern, tileLocalPositions, tileScratchSize } from './tile-builder.js';
import { type TileBackend, TileScheduler, type TileSink } from './tile-scheduler.js';

const failures: string[] = [];
function check(ok: boolean, what: string): void {
  if (!ok) {
    failures.push(what);
    console.log(`  FAIL ${what}`);
  }
}

const scratch = new Float64Array(Math.max(...LEVELS.map(tileScratchSize)));
let buildCount = 0;
let buildTotal = 0;
let buildMax = 0;
const buildMsBy: number[][] = LEVELS.map(() => []);

interface Built {
  spec: TileLevelSpec;
  x: number;
  z: number;
  p: TilePayload;
}

function build(level: number, x: number, z: number): Built {
  const spec = LEVELS[level];
  const p = payloadViews(spec, new ArrayBuffer(tilePayloadBytes(spec)));
  const t0 = performance.now();
  buildTile(spec, x, z, p, scratch);
  const ms = performance.now() - t0;
  buildCount++;
  buildTotal += ms;
  buildMax = Math.max(buildMax, ms);
  buildMsBy[level].push(ms);
  return { spec, x, z, p };
}

/** World position of grid vertex (i, j) including the warp offset. */
function vertexXZ(b: Built, i: number, j: number): [number, number] {
  const q = b.spec.quads;
  const s = b.spec.tile / q;
  const v = j * (q + 1) + i;
  let x = b.x + (i * b.spec.tile) / q;
  let z = b.z + (j * b.spec.tile) / q;
  if (b.p.offsets) {
    x += (b.p.offsets[v * 2] / 32767) * s;
    z += (b.p.offsets[v * 2 + 1] / 32767) * s;
  }
  return [x, z];
}

function heightAt(b: Built, i: number, j: number): number {
  return b.p.heights[j * (b.spec.quads + 1) + i];
}

/** Bilinear-on-triangles height of a tile surface at a point on its edge line. */
function edgeHeight(b: Built, along: number, edge: 'x0' | 'x1' | 'z0' | 'z1'): number {
  const q = b.spec.quads;
  const s = b.spec.tile / q;
  const t = along / s;
  const k = Math.min(q - 1, Math.max(0, Math.floor(t)));
  const f = t - k;
  let h0: number;
  let h1: number;
  if (edge === 'x0' || edge === 'x1') {
    const i = edge === 'x0' ? 0 : q;
    h0 = heightAt(b, i, k);
    h1 = heightAt(b, i, k + 1);
  } else {
    const j = edge === 'z0' ? 0 : q;
    h0 = heightAt(b, k, j);
    h1 = heightAt(b, k + 1, j);
  }
  return h0 + (h1 - h0) * f;
}

// ----------------------------------------------------- tile builder ------

console.log('tile builder');
{
  // Places to test: along the route, on both cliff bands, the river, the rope ledge.
  const spots: Array<[string, number, number]> = [];
  for (let s = 0; s < route.length; s += 650) {
    const p = routePoint(s);
    spots.push([`route s=${s}`, p.x, p.z]);
  }
  spots.push(['ice wall', SUMMIT_X + ICE_WALL_R * 0.6, SUMMIT_Z + ICE_WALL_R * 0.8]);
  spots.push(['rock band', SUMMIT_X - ROCK_BAND_R * 0.8, SUMMIT_Z + ROCK_BAND_R * 0.6]);
  const rope = routePoint(ROPE_START_S + 60);
  spots.push(['rope ledge', rope.x, rope.z]);

  let maxHeightErr = 0;
  let maxNormalErr = 0;
  let minNy = 1;
  for (let level = FIRST_REGULAR_LEVEL; level < LEVEL_COUNT; level++) {
    const spec = LEVELS[level];
    for (const [, sx, sz] of spots) {
      const x = Math.floor(sx / spec.tile) * spec.tile;
      const z = Math.floor(sz / spec.tile) * spec.tile;
      const b = build(level, x, z);
      const q = spec.quads;
      for (let j = 0; j <= q; j++) {
        for (let i = 0; i <= q; i++) {
          const v = j * (q + 1) + i;
          const [wx, wz] = vertexXZ(b, i, j);
          // Offsets are quantised to i16: compare against the height at the decoded spot.
          const err = Math.abs(b.p.heights[v] - expeditionHeight(wx, wz));
          const moved = b.p.offsets && (b.p.offsets[v * 2] !== 0 || b.p.offsets[v * 2 + 1] !== 0);
          if (!moved) maxHeightErr = Math.max(maxHeightErr, err);
          const nx = b.p.normals[v * 3] / 32767;
          const ny = b.p.normals[v * 3 + 1] / 32767;
          const nz = b.p.normals[v * 3 + 2] / 32767;
          maxNormalErr = Math.max(maxNormalErr, Math.abs(Math.hypot(nx, ny, nz) - 1));
          minNy = Math.min(minNy, ny);
        }
      }
    }
  }
  console.log(`  height err ${maxHeightErr.toExponential(2)} m, |n|-1 ${maxNormalErr.toExponential(2)}, min ny ${minNy.toFixed(3)}`);
  check(maxHeightErr < 2e-3, 'tile heights match expeditionHeight');
  check(maxNormalErr < 2e-4, 'normals are unit length');
  check(minNy > 0, 'normals face up');
}

// Index pattern orientation: grid faces up, skirts face the tile interior.
{
  for (const spec of LEVELS) {
    const q = spec.quads;
    const idx = tileIndexPattern(q);
    const pos = tileLocalPositions(spec);
    let bad = 0;
    const half = spec.tile / 2;
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
      const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
      const ux = pos[b * 3] - ax, uy = pos[b * 3 + 1] - ay, uz = pos[b * 3 + 2] - az;
      const vx = pos[c * 3] - ax, vy = pos[c * 3 + 1] - ay, vz = pos[c * 3 + 2] - az;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const skirt = ay !== pos[b * 3 + 1] || ay !== pos[c * 3 + 1];
      if (!skirt) {
        if (!(ny > 0)) bad++;
      } else {
        // Normal must point toward the tile centre.
        const cx = (ax + pos[b * 3] + pos[c * 3]) / 3;
        const cz = (az + pos[b * 3 + 2] + pos[c * 3 + 2]) / 3;
        if (!(nx * (half - cx) + nz * (half - cz) > 0)) bad++;
      }
    }
    check(bad === 0, `${spec.name} triangle orientation (${bad} bad)`);
  }
  // Perimeter walk visits every edge vertex once.
  const q = 8;
  const seen = new Set<number>();
  for (let k = 0; k < 4 * q; k++) seen.add(perimeterVertex(q, k));
  check(seen.size === 4 * q, 'perimeter covers each edge vertex once');
}

// --------------------------------------------------------------- seams ---

console.log('seams');
{
  // Same level: neighbours share their edge bit for bit (heights and normals).
  let mismatches = 0;
  for (let level = 0; level < LEVEL_COUNT; level++) {
    const spec = LEVELS[level];
    const q = spec.quads;
    for (const s of [300, 2600, 5700, 7400]) {
      const p = routePoint(s);
      const x = Math.floor(p.x / spec.tile) * spec.tile;
      const z = Math.floor(p.z / spec.tile) * spec.tile;
      const a = build(level, x, z);
      const right = build(level, x + spec.tile, z);
      const up = build(level, x, z + spec.tile);
      for (let k = 0; k <= q; k++) {
        const va = k * (q + 1) + q;
        const vb = k * (q + 1);
        if (a.p.heights[va] !== right.p.heights[vb]) mismatches++;
        for (let c = 0; c < 3; c++) if (a.p.normals[va * 3 + c] !== right.p.normals[vb * 3 + c]) mismatches++;
        const wa = q * (q + 1) + k;
        const wb = k;
        if (a.p.heights[wa] !== up.p.heights[wb]) mismatches++;
        for (let c = 0; c < 3; c++) if (a.p.normals[wa * 3 + c] !== up.p.normals[wb * 3 + c]) mismatches++;
        // Edge vertices are never warped.
        if (a.p.offsets && (a.p.offsets[va * 2] !== 0 || a.p.offsets[wa * 2 + 1] !== 0)) mismatches++;
      }
    }
  }
  check(mismatches === 0, `same-level edges identical (${mismatches} mismatches)`);

  // LOD boundaries: walk the fine/coarse edge. Where the fine edge is above
  // the coarse one its skirt must reach down; where it's below, the coarse
  // tile's sunk wall (HOLE_SINK) closes the gap.
  const pairs: Array<[number, number]> = [
    [FEATURE_LEVEL, FIRST_REGULAR_LEVEL],
    [1, 2],
    [2, 3],
    [3, 4],
  ];
  const sites: Array<[string, number, number]> = [];
  for (let s = 100; s < route.length; s += 400) {
    const p = routePoint(s);
    sites.push([`s${s}`, p.x, p.z]);
  }
  // Boundaries crossing each cliff band, the river and the rope ledge.
  for (const R of [ICE_WALL_R, ROCK_BAND_R]) {
    for (let a = 0; a < 6.28; a += 0.7) sites.push([`band${R}`, SUMMIT_X + Math.sin(a) * R, SUMMIT_Z + Math.cos(a) * R]);
  }
  const rope = routePoint(ROPE_START_S + 100);
  sites.push(['rope', rope.x, rope.z]);
  let worstUp = 0;
  let worstDown = 0;
  let worstUpAt = '';
  for (const [fine, coarse] of pairs) {
    const fs = LEVELS[fine];
    const cs = LEVELS[coarse];
    for (const [name, sx, sz] of sites) {
      // A boundary line of the fine block through the site: the coarse tile
      // on the other side shares it. Test x-edges and z-edges.
      const fx = Math.round(sx / fs.tile) * fs.tile;
      const fz = Math.floor(sz / fs.tile) * fs.tile;
      const cxTile = Math.floor(fx / cs.tile) * cs.tile;
      const fineTile = build(fine, fx - fs.tile, fz); // its x1 edge lies on x = fx
      // Coarse tile to the right whose x0 edge... coarse tiles adjoin at x = fx only if fx is
      // on the coarse grid; otherwise the boundary runs through the coarse tile along a
      // grid line of it (fine rectangles always sit on coarse grid lines).
      const coarseTile = build(coarse, cxTile, Math.floor(fz / cs.tile) * cs.tile);
      const csp = cs.tile / cs.quads;
      const col = (fx - coarseTile.x) / csp;
      if (Math.abs(col - Math.round(col)) > 1e-6) {
        check(false, `fine edge x=${fx} not on ${cs.name} grid`);
        continue;
      }
      const ci = Math.round(col);
      if (coarseTile.p.offsets) {
        let off = 0;
        for (let k = 0; k <= cs.quads; k++) {
          const v = k * (cs.quads + 1) + ci;
          off += Math.abs(coarseTile.p.offsets[v * 2]) + Math.abs(coarseTile.p.offsets[v * 2 + 1]);
        }
        check(off === 0, `${cs.name} vertices on a ${fs.name} boundary are unwarped (${name})`);
      }
      for (let t = 0; t <= fs.tile; t += fs.tile / fs.quads / 2) {
        const z = fz + t;
        const hf = edgeHeight(fineTile, t, 'x1');
        // Coarse surface along its grid column ci at this z (unwarped column if the
        // edge is a tile edge of the coarse level; interior columns may be warped
        // near bands, so sample the column's vertex heights).
        const cz = z - coarseTile.z;
        if (cz < 0 || cz > cs.tile) continue;
        const k = Math.min(cs.quads - 1, Math.floor(cz / csp));
        const f = cz / csp - k;
        const h0 = heightAt(coarseTile, ci, k);
        const h1 = heightAt(coarseTile, ci, k + 1);
        const hc = h0 + (h1 - h0) * f;
        const up = hf - hc;
        if (up > worstUp) {
          worstUp = up;
          worstUpAt = `${fs.name}/${cs.name} at ${name}`;
        }
        worstDown = Math.max(worstDown, -up);
        check(up <= fs.skirt, `${fs.name}/${cs.name} skirt covers crack at ${name} (${up.toFixed(1)} m)`);
        check(-up <= 600, `${fs.name}/${cs.name} coarse wall covers crack at ${name}`);
      }
    }
  }
  console.log(`  worst fine-above-coarse ${worstUp.toFixed(2)} m (${worstUpAt}), worst coarse-above-fine ${worstDown.toFixed(2)} m`);
}

// ------------------------------------------------- cliff warp & features --

console.log('cliffs & features');
{
  // On every coarse level, the ice wall drawn across a tile interior should
  // be steep (the warp puts vertices on the band's edges and face).
  for (let level = 2; level < LEVEL_COUNT; level++) {
    const spec = LEVELS[level];
    const q = spec.quads;
    let steepest = 0;
    let folded = 0;
    for (let a = 0.3; a < 6.28; a += 0.9) {
      const px = SUMMIT_X + Math.sin(a) * ICE_WALL_R;
      const pz = SUMMIT_Z + Math.cos(a) * ICE_WALL_R;
      const b = build(level, Math.floor(px / spec.tile) * spec.tile, Math.floor(pz / spec.tile) * spec.tile);
      for (let j = 0; j < q; j++) {
        for (let i = 0; i < q; i++) {
          // Two triangles of the cell; check xz orientation and slope.
          const cells: Array<[number, number][]> = [
            [[i, j], [i, j + 1], [i + 1, j]],
            [[i + 1, j], [i, j + 1], [i + 1, j + 1]],
          ];
          for (const tri of cells) {
            const P = tri.map(([u, w]) => {
              const [x, z] = vertexXZ(b, u, w);
              return [x, heightAt(b, u, w), z];
            });
            const ux = P[1][0] - P[0][0], uy = P[1][1] - P[0][1], uz = P[1][2] - P[0][2];
            const vx = P[2][0] - P[0][0], vy = P[2][1] - P[0][1], vz = P[2][2] - P[0][2];
            const ny = uz * vx - ux * vz;
            if (ny <= 0) folded++;
            const nx = uy * vz - uz * vy;
            const nz = ux * vy - uy * vx;
            const slope = Math.atan2(Math.hypot(nx, nz), ny) * (180 / Math.PI);
            steepest = Math.max(steepest, slope);
          }
        }
      }
    }
    console.log(`  ${spec.name} ice wall steepest facet ${steepest.toFixed(1)} deg, folded ${folded}`);
    check(folded === 0, `${spec.name} warp never folds a triangle`);
    check(steepest > 70, `${spec.name} ice wall reads as a cliff`);
  }

  // The crevasse at 1 m cells: deep slot, at least one row of vertices at full depth.
  const f = FEATURE_TILES[0];
  const b = build(FEATURE_LEVEL, f.x, f.z);
  const c = routeFrame(CREVASSE_S);
  let minH = Infinity;
  for (let v = 0; v < tileVertexCount(LEVELS[FEATURE_LEVEL].quads); v++) minH = Math.min(minH, b.p.heights[v]);
  console.log(`  crevasse floor ${(minH - c.elev).toFixed(1)} m below the path`);
  check(c.elev - minH > CREVASSE_DEPTH * 0.85, 'crevasse slot shows at 1 m cells');
  // And within L0 at 2 m.
  const l0 = LEVELS[FIRST_REGULAR_LEVEL];
  const t0 = build(FIRST_REGULAR_LEVEL, Math.floor(c.x / l0.tile) * l0.tile, Math.floor(c.z / l0.tile) * l0.tile);
  let minL0 = Infinity;
  for (let v = 0; v < tileVertexCount(l0.quads); v++) minL0 = Math.min(minL0, t0.p.heights[v]);
  console.log(`  crevasse at 2 m: ${(c.elev - minL0).toFixed(1)} m deep`);
}

// --------------------------------------------------------------- timing ---

console.log('timing');
{
  // Fresh, JIT-warm builds around the route.
  for (let k = 0; k < LEVELS.length; k++) buildMsBy[k].length = 0;
  for (let n = 0; n < 12; n++) {
    const p = routePoint(n * 640);
    for (let level = 0; level < LEVEL_COUNT; level++) {
      const spec = LEVELS[level];
      build(level, Math.floor(p.x / spec.tile) * spec.tile, Math.floor(p.z / spec.tile) * spec.tile);
    }
  }
  for (let level = 0; level < LEVEL_COUNT; level++) {
    const ms = buildMsBy[level];
    const avg = ms.reduce((a, b) => a + b, 0) / ms.length;
    console.log(`  ${LEVELS[level].name} ${LEVELS[level].quads}x${LEVELS[level].quads}: avg ${avg.toFixed(2)} ms, max ${Math.max(...ms).toFixed(2)} ms`);
    if (LEVELS[level].quads === 64) check(avg < 20, `${LEVELS[level].name} builds under 20 ms`);
  }
}

// --------------------------------------------------- far mesh & backdrop --

console.log('far mesh & backdrop');
let far: MeshData;
{
  let t = performance.now();
  far = buildFarMesh();
  const farMs = performance.now() - t;
  t = performance.now();
  const back = buildBackdrop();
  const backMs = performance.now() - t;
  console.log(
    `  far: ${far.positions.length / 3} verts, ${far.indices.length / 3} tris, ${farMs.toFixed(0)} ms; ` +
      `backdrop: ${back.positions.length / 3} verts, ${back.indices.length / 3} tris, ${backMs.toFixed(0)} ms`,
  );
  const orient = (m: MeshData) => {
    let bad = 0;
    for (let t3 = 0; t3 < m.indices.length; t3 += 3) {
      const a = m.indices[t3] * 3, b = m.indices[t3 + 1] * 3, c = m.indices[t3 + 2] * 3;
      const ux = m.positions[b] - m.positions[a], uz = m.positions[b + 2] - m.positions[a + 2];
      const vx = m.positions[c] - m.positions[a], vz = m.positions[c + 2] - m.positions[a + 2];
      if (!(uz * vx - ux * vz > 0)) bad++;
    }
    return bad;
  };
  // Longest far-mesh edge: the sink margin must exceed it.
  let longest = 0;
  for (let t3 = 0; t3 < far.indices.length; t3 += 3) {
    for (let c = 0; c < 3; c++) {
      const a = far.indices[t3 + c] * 3;
      const b = far.indices[t3 + ((c + 1) % 3)] * 3;
      longest = Math.max(longest, Math.hypot(far.positions[a] - far.positions[b], far.positions[a + 2] - far.positions[b + 2]));
    }
  }
  console.log(`  longest far edge ${longest.toFixed(0)} m (sink margin ${FAR_SINK.margin} m)`);
  check(longest < FAR_SINK.margin, 'far sink margin exceeds the far mesh cell size');
  check(orient(far) === 0, `far mesh triangles face up (${orient(far)} bad)`);
  check(orient(back) === 0, `backdrop triangles face up (${orient(back)} bad)`);
  // Shared seam ring: the far mesh's last ring == the backdrop's first.
  const fr = farRings();
  const br = backdropRings();
  const n = fr[fr.length - 1].n;
  check(n === br[0].n && fr[fr.length - 1].r === FAR_OUTER_R && br[0].r === FAR_OUTER_R, 'seam rings line up');
  const farStart = far.positions.length / 3 - n;
  let seamGap = 0;
  let seamNormal = 0;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      seamGap = Math.max(seamGap, Math.abs(far.positions[(farStart + i) * 3 + c] - back.positions[i * 3 + c]));
      seamNormal = Math.max(seamNormal, Math.abs(far.normals[(farStart + i) * 3 + c] - back.normals[i * 3 + c]) / 32767);
    }
  }
  console.log(`  seam gap ${seamGap} m, normal diff ${seamNormal.toFixed(4)}`);
  check(seamGap === 0, 'far/backdrop seam is watertight');
  check(seamNormal < 0.01, 'far/backdrop seam normals match');
  // Cliff bands: rings straddle both band edges.
  for (const R of [ICE_WALL_R, ROCK_BAND_R]) {
    check(
      fr.some((r) => r.r === R - BAND_HALF_WIDTH) && fr.some((r) => r.r === R + BAND_HALF_WIDTH),
      `far rings on both edges of band r=${R}`,
    );
  }
  // Backdrop: big, with valleys under the cloud deck.
  let hi = -Infinity;
  let below = 0;
  for (let i = 1; i < back.positions.length; i += 3) {
    hi = Math.max(hi, back.positions[i]);
    if (back.positions[i] < 650) below++;
  }
  console.log(`  backdrop peak ${hi.toFixed(0)} m, ${((100 * below) / (back.positions.length / 3)).toFixed(0)}% below the deck`);
  check(hi > 3500 && below > 0, 'backdrop has giants and sub-cloud valleys');
  check(Math.abs(backdropHeight(SUMMIT_X, SUMMIT_Z + FAR_OUTER_R) - expeditionHeight(SUMMIT_X, SUMMIT_Z + FAR_OUTER_R)) < 1e-9, 'backdrop height continuous at seam');
}

// ------------------------------------------------------ scheduler sim ----

console.log('scheduler');
{
  class FakeSink implements TileSink {
    written = 0;
    uploaded = 0;
    writesThisFrame = 0;
    shown = new Array<boolean>(SLOTS_PER_LEVEL).fill(false);
    origin = new Array<[number, number]>(SLOTS_PER_LEVEL).fill([NaN, NaN]);
    draw = 0;
    holes = new Float64Array(LEVEL_COUNT * 4).fill(NaN);
    write(slot: number, x: number, z: number): number {
      check(!this.shown[slot], 'never write a shown slot');
      this.origin[slot] = [x, z];
      this.writesThisFrame++;
      return ++this.written;
    }
    copy(from: number, to: number): number {
      check(!this.shown[to], 'never copy over a shown slot');
      this.origin[to] = this.origin[from];
      this.writesThisFrame++;
      return ++this.written;
    }
    uploadedVersion(): number {
      return this.uploaded;
    }
    setShown(slot: number, shown: boolean): void {
      if (shown) check(this.uploaded >= 0, 'shown');
      this.shown[slot] = shown;
    }
    setDrawSlots(n: number): void {
      this.draw = n;
    }
    setHoles(rects: Float64Array): void {
      this.holes.set(rects);
    }
  }
  const sinks = LEVELS.map(() => new FakeSink());
  // Synchronous builder, answers at the start of the next frame.
  const queue: Array<{ id: number; buf: ArrayBuffer }> = [];
  const backend: TileBackend = {
    request(id, _level, _x, _z, buf) {
      queue.push({ id, buf });
    },
  };
  const sched = new TileScheduler(sinks, backend);
  sched.maxInFlight = 3;

  let frames = 0;
  let maxWrites = 0;
  let maxDraw = 0;
  let maxTris = 0;
  let maxReadyTris = 0;
  let triSum = 0;
  const triHist: number[] = [];
  const slack = new Array<number>(LEVEL_COUNT).fill(0);
  let steadyFrames = 0;
  let coverageMin = Infinity;

  let px = NaN;
  let pz = NaN;
  function frame(fx: number, fz: number, ahead = 0): void {
    // Anticipate along the direction of travel, like the system does.
    let hx = 0;
    let hz = 0;
    const ml = Math.hypot(fx - px, fz - pz);
    if (ml > 1e-6 && ml < 60) {
      hx = ((fx - px) / ml) * ahead;
      hz = ((fz - pz) / ml) * ahead;
    }
    px = fx;
    pz = fz;
    frames++;
    // The worker returns up to 3 tiles per frame (~3-5 ms each).
    for (let k = 0; k < 3 && queue.length; k++) {
      const job = queue.shift() as { id: number; buf: ArrayBuffer };
      sched.onBuilt(job.id, job.buf, 1);
    }
    for (const s of sinks) s.writesThisFrame = 0;
    sched.update(fx, fz, 0, -1, fx + hx, fz + hz, 2);
    let writes = 0;
    for (const s of sinks) writes += s.writesThisFrame;
    maxWrites = Math.max(maxWrites, writes);
    // "Render": everything written so far reaches the GPU.
    for (const s of sinks) s.uploaded = s.written;
    validate(fx, fz);
  }

  function validate(fx: number, fz: number): void {
    const r = sched.rects;
    // Shown slots of each level form its rectangle exactly.
    for (let L = 0; L < LEVEL_COUNT; L++) {
      const sink = sinks[L];
      const spec = LEVELS[L];
      let count = 0;
      for (let s = 0; s < SLOTS_PER_LEVEL; s++) {
        if (!sink.shown[s]) continue;
        count++;
        check(s < sink.draw, `${spec.name} shown slot inside the draw range`);
        const [ox, oz] = sink.origin[s];
        const o = L * 4;
        check(ox >= r[o] && oz >= r[o + 1] && ox + spec.tile <= r[o + 2] && oz + spec.tile <= r[o + 3], `${spec.name} shown tile inside its rect`);
      }
      if (L >= FIRST_REGULAR_LEVEL && !Number.isNaN(r[L * 4])) check(count === 9, `${spec.name} shows a full block (${count})`);
      maxDraw = Math.max(maxDraw, sink.draw);
      // Holes are exactly the finer levels' rects.
      for (let k = 0; k < LEVEL_COUNT * 4; k++) {
        const want = k < L * 4 ? r[k] : NaN;
        const got = sink.holes[k];
        check(Number.isNaN(want) ? Number.isNaN(got) : want === got, `${spec.name} holes up to date`);
      }
    }
    // Alignment: every shown rect lies on the vertex grid of each coarser level.
    for (let k = 0; k < LEVEL_COUNT; k++) {
      if (Number.isNaN(r[k * 4])) continue;
      // The feature tile only ever shows inside L0's block (checked below), so
      // only L0's grid matters for it.
      const last = k === FEATURE_LEVEL ? FIRST_REGULAR_LEVEL + 1 : LEVEL_COUNT;
      for (let j = Math.max(k + 1, FIRST_REGULAR_LEVEL); j < last; j++) {
        const sp = LEVELS[j].tile / LEVELS[j].quads;
        for (let c = 0; c < 4; c++) {
          const cells = r[k * 4 + c] / sp;
          check(Math.abs(cells - Math.round(cells)) < 1e-6, `${LEVELS[k].name} rect on ${LEVELS[j].name} grid`);
        }
      }
    }
    // Feature tile only inside the shown L0 block (the only level not aligned to it).
    if (!Number.isNaN(r[0])) {
      const o = FIRST_REGULAR_LEVEL * 4;
      check(r[0] >= r[o] && r[1] >= r[o + 1] && r[2] <= r[o + 2] && r[3] <= r[o + 3], 'feature inside L0 block');
    }
    // Coverage once settled: distance from focus to the union's edge.
    const o3 = (LEVEL_COUNT - 1) * 4;
    if (!Number.isNaN(r[o3])) {
      const margin = Math.min(fx - r[o3], fz - r[o3 + 1], r[o3 + 2] - fx, r[o3 + 3] - fz);
      if (sched.isReady(fx, fz, 1000)) {
        coverageMin = Math.min(coverageMin, margin);
        steadyFrames++;
      }
    }
    for (let L = 0; L < LEVEL_COUNT; L++) if (sinks[L].draw > sched.shownCount(L)) slack[L]++;
    const tris = sched.drawnTriangles();
    maxTris = Math.max(maxTris, tris);
    triSum += tris;
    triHist.push(tris);
    if (sched.isReady(fx, fz, 1000)) maxReadyTris = Math.max(maxReadyTris, tris);
  }

  // Start at Base Camp (prefetch).
  const start = routePoint(12);
  let ready = -1;
  for (let i = 0; i < 400; i++) {
    frame(start.x, start.z);
    if (sched.isReady(start.x, start.z, 300)) {
      ready = i;
      break;
    }
  }
  console.log(`  base camp ready after ${ready} frames (${sched.stats.built} tiles built)`);
  check(ready > 0, 'base camp becomes ready');
  // Walk the whole route at 0.1 m per frame (7 m/s at 72 Hz: faster than
  // poling, so transients are over-represented).
  for (let s = 12; s < route.length; s += 0.1) {
    const p = routePoint(s);
    frame(p.x, p.z, 30);
  }
  console.log(`  walk: ${frames} frames, built ${sched.stats.built}, dropped ${sched.stats.dropped}, switches ${sched.stats.switches}, defrag moves ${sched.stats.moves}`);
  // Glide from the summit back to Base Camp at 25 m/s (72 Hz).
  const sum = routePoint(7770);
  for (let t = 0; t <= 1; t += 25 / 72 / 3200) {
    frame(sum.x + (start.x - sum.x) * t, sum.z + (start.z - sum.z) * t, 100);
  }
  // Teleport (respawn) and settle.
  const cp = routePoint(4200);
  let settle = -1;
  for (let i = 0; i < 400; i++) {
    frame(cp.x, cp.z);
    if (sched.isReady(cp.x, cp.z, 300)) {
      settle = i;
      break;
    }
  }
  console.log(`  teleport settles in ${settle} frames`);
  check(settle > 0, 'teleport settles');
  // Near the crevasse the feature tile comes up.
  const cv = routeFrame(CREVASSE_S);
  for (let i = 0; i < 300; i++) frame(cv.x, cv.z);
  check(!Number.isNaN(sched.rects[0]), 'crevasse feature tile shown');

  console.log(
    `  max writes/frame ${maxWrites}, max draw slots ${maxDraw}, max near tris ${maxTris}, min coverage when ready ${coverageMin.toFixed(0)} m (${steadyFrames} ready frames)`,
  );
  check(maxWrites <= 2, 'at most 2 tile uploads per frame');
  check(coverageMin >= 1024 * 0.8, 'near terrain covers >= ~820 m around the player');
  triHist.sort((a, b) => a - b);
  console.log(`  frames with loose draw ranges per level: ${slack.join(', ')}`);
  console.log(
    `  near tris (incl. collapsed slots in the draw range): mean ${(triSum / triHist.length).toFixed(0)}, ` +
      `p95 ${triHist[Math.floor(triHist.length * 0.95)]}, p99.9 ${triHist[Math.floor(triHist.length * 0.999)]}, max ${maxTris}, max when settled ${maxReadyTris}`,
  );
  check(triHist[Math.floor(triHist.length * 0.99)] <= 240000, 'near triangles within budget (p99)');

  // Far sink: any far triangle touched by the sink lies wholly inside the
  // near blocks, so nothing outside is bent (no gap at the boundary).
  const r = sched.rects;
  const inside = (x: number, z: number) => {
    let best = -Infinity;
    for (let k = 0; k < LEVEL_COUNT; k++) {
      if (Number.isNaN(r[k * 4])) continue;
      best = Math.max(best, Math.min(x - r[k * 4], r[k * 4 + 2] - x, z - r[k * 4 + 1], r[k * 4 + 3] - z));
    }
    return best;
  };
  let bent = 0;
  for (let t3 = 0; t3 < far.indices.length; t3 += 3) {
    let sunk = false;
    let allIn = true;
    for (let c = 0; c < 3; c++) {
      const v = far.indices[t3 + c] * 3;
      const d = inside(far.positions[v], far.positions[v + 2]);
      if (d > FAR_SINK.margin) sunk = true;
      if (d < 0) allIn = false;
    }
    if (sunk && !allIn) bent++;
  }
  check(bent === 0, `far sink never bends a triangle outside the near terrain (${bent})`);
}

console.log(`\nbuilt ${buildCount} tiles, avg ${(buildTotal / buildCount).toFixed(2)} ms, max ${buildMax.toFixed(2)} ms`);
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  throw new Error(`terrain check failed: ${[...new Set(failures)].slice(0, 10).join('; ')}`);
}
console.log('\nall terrain checks passed');
