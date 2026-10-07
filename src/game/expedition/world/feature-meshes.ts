/**
 * Meshes for the set pieces: the log bridge, the river, the crevasse's ice
 * walls, the ice wall and rock band faces (with the slab over each lip,
 * cornices and icicles), the rock wall above the fixed-rope ledge, the rock
 * band's holds and the serac tower that collapses.
 */

import {
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  TorusGeometry,
  Uint32BufferAttribute,
  Vector3,
} from '@iwsdk/core';
import { segmentMatrix } from '../../mesh-utils.js';
import { mulberry32, valueNoise } from '../../terrain.js';
import { CREVASSE_HALF_GAP } from '../exp-layout.js';
import type { Chunk } from './chunks.js';
import {
  BRIDGE_FRAME,
  BRIDGE_HALF_LENGTH,
  BRIDGE_LOG_OVERHANG,
  BRIDGE_LOGS,
  bridgeDeckY,
  bridgePoint,
  crevasseDepth,
  crevassePoint,
  crevasseWallHalf,
  type FaceGrid,
  type HoldSpec,
  type LedgeWallGrid,
  RIVER_FLOW,
  RIVER_RIBBON_HALF,
  type RiverRow,
} from './layout-features.js';
import type { SeracTower, Seam } from './layout-nature.js';
import { groundAt, groundMin } from './layout-util.js';
import { holdMaterial, iceFacetMaterial, waterMaterial } from './materials.js';
import { seracColor, seracGeometry } from './nature-meshes.js';
import { Batch } from './batch.js';

const SNOW = new Color(0.93, 0.95, 0.99);
const WHITE = new Color(1, 1, 1);
const LASHING = new Color(0.55, 0.44, 0.3);

// --------------------------------------------------------------- grids -----

/**
 * Indexed grid (column-major, `rows` per column) with positions relative to
 * `origin`; winding chosen so the middle quad faces `facing`.
 */
function gridGeometry(
  cols: number,
  rows: number,
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  z: ArrayLike<number>,
  origin: Vector3,
  facing: Vector3,
): BufferGeometry {
  const pos = new Float32Array(cols * rows * 3);
  for (let i = 0; i < cols * rows; i++) {
    pos[i * 3] = x[i] - origin.x;
    pos[i * 3 + 1] = y[i] - origin.y;
    pos[i * 3 + 2] = z[i] - origin.z;
  }
  const mc = Math.floor((cols - 1) / 2);
  const mj = Math.floor((rows - 1) / 2);
  const P = (c: number, j: number) => {
    const i = (c * rows + j) * 3;
    return new Vector3(pos[i], pos[i + 1], pos[i + 2]);
  };
  const a = P(mc, mj);
  const n = new Vector3().subVectors(P(mc + 1, mj), a).cross(new Vector3().subVectors(P(mc, mj + 1), a));
  const flip = n.dot(facing) < 0;
  const index: number[] = [];
  for (let c = 0; c < cols - 1; c++) {
    for (let j = 0; j < rows - 1; j++) {
      const i00 = c * rows + j;
      const i10 = (c + 1) * rows + j;
      const i11 = (c + 1) * rows + j + 1;
      const i01 = c * rows + j + 1;
      if (flip) index.push(i00, i11, i10, i00, i01, i11);
      else index.push(i00, i10, i11, i00, i11, i01);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setIndex(new Uint32BufferAttribute(index, 1));
  g.computeVertexNormals();
  return g;
}

function originOf(x: ArrayLike<number>, y: ArrayLike<number>, z: ArrayLike<number>): Vector3 {
  return new Vector3(Math.round(x[0]), Math.round(y[0]), Math.round(z[0]));
}

// ------------------------------------------------------------- bridge ------

export function addBridge(chunk: Chunk): void {
  const f = BRIDGE_FRAME;
  const bark = chunk.batch('bark');
  const props = chunk.batch('props');
  const rock = chunk.batch('rock');
  const reach = BRIDGE_HALF_LENGTH + BRIDGE_LOG_OVERHANG;
  const segs = 24;
  const m = new Matrix4();
  for (const log of BRIDGE_LOGS) {
    // Log centre line: its top runs exactly along the deck height.
    const pts: Vector3[] = [];
    for (let i = 0; i <= segs; i++) {
      const a = -reach + (2 * reach * i) / segs;
      const p = bridgePoint(a, log.across);
      const top = bridgeDeckY(Math.max(-BRIDGE_HALF_LENGTH, Math.min(BRIDGE_HALF_LENGTH, a)));
      pts.push(new Vector3(p.x, top - log.radius, p.z));
    }
    for (let i = 0; i < segs; i++) {
      // Slight taper toward the far end of the trunk.
      const r = log.radius * (1.04 - 0.08 * (i / segs));
      bark.add(new CylinderGeometry(r, r, 1, 10, 1, i === 0 || i === segs - 1 ? false : true), segmentMatrix(pts[i], pts[i + 1], m), WHITE, undefined, 1);
    }
  }
  // Rope lashings binding the three logs.
  for (const a of [-8.5, -4, 0.5, 5, 9]) {
    const c = bridgePoint(a, 0);
    const y = bridgeDeckY(a) - 0.22;
    const ring = new TorusGeometry(1, 0.035, 4, 18);
    // The ring's axis (+Z) runs along the bridge so it wraps the three logs.
    const turn = new Matrix4().makeRotationY(Math.atan2(f.tx, f.tz)).scale(new Vector3(0.72, 0.28, 1)).setPosition(c.x, y, c.z);
    props.add(ring, turn, LASHING);
  }
  // Log cribs filled with stones under each end of the span.
  for (const end of [-1, 1]) {
    const aIn = end * (BRIDGE_HALF_LENGTH - 1.8);
    const aOut = end * (BRIDGE_HALF_LENGTH + 1.4);
    const aMid = (aIn + aOut) / 2;
    const centre = bridgePoint(aMid, 0);
    const ground = groundMin(centre.x, centre.z, 1.8) - 0.15;
    const topY = bridgeDeckY(end * BRIDGE_HALF_LENGTH) - 2 * 0.23;
    const layer = 0.26;
    let y = ground + layer / 2;
    let k = 0;
    while (y + layer / 2 <= topY + 0.02) {
      if (k % 2 === 0) {
        for (const l of [-0.95, 0.95]) {
          const a = bridgePoint(aIn, l);
          const b = bridgePoint(aOut, l);
          bark.add(new CylinderGeometry(0.13, 0.13, 1, 8), segmentMatrix(new Vector3(a.x, y, a.z), new Vector3(b.x, y, b.z), m), WHITE, undefined, 1);
        }
      } else {
        for (const a0 of [aIn, aOut]) {
          const a = bridgePoint(a0, -1.25);
          const b = bridgePoint(a0, 1.25);
          bark.add(new CylinderGeometry(0.13, 0.13, 1, 8), segmentMatrix(new Vector3(a.x, y, a.z), new Vector3(b.x, y, b.z), m), WHITE, undefined, 1);
        }
      }
      y += layer;
      k++;
    }
    // Stones packed inside the crib.
    const rand = mulberry32(end > 0 ? 11 : 12);
    for (let s = 0; s < 7; s++) {
      const a = aMid + (rand() - 0.5) * 2.2;
      const l = (rand() - 0.5) * 1.4;
      const p = bridgePoint(a, l);
      const r = 0.28 + rand() * 0.2;
      const top = Math.min(topY - 0.1, ground + 0.3 + rand() * Math.max(0, topY - ground - 0.4));
      rock.add(new IcosahedronGeometry(1, 1), new Matrix4().makeRotationY(rand() * 6).scale(new Vector3(r, r * 0.8, r)).setPosition(p.x, top, p.z), WHITE);
    }
    // Snow on the crib top either side of the logs.
    for (const l of [-1.05, 1.05]) {
      const p = bridgePoint(aMid, l);
      props.add(new CylinderGeometry(0.2, 0.25, 3.4, 6), new Matrix4().makeRotationY(Math.atan2(f.tx, f.tz)).multiply(new Matrix4().makeRotationX(Math.PI / 2)).setPosition(p.x, topY + 0.08, p.z), SNOW);
    }
  }
  chunk.extend(f.x, f.elev, f.z, reach + 2);
}

// -------------------------------------------------------------- river ------

/** River water as one or more meshes (one per run of rows), placed in world. */
export function riverMeshes(rows: RiverRow[], from: number, to: number): Mesh[] {
  const f = BRIDGE_FRAME;
  const out: Mesh[] = [];
  const cols = [-1, -0.6, -0.25, 0, 0.25, 0.6, 1];
  let start = -1;
  const flush = (a: number, b: number) => {
    if (b - a < 1) return;
    const origin = new Vector3(Math.round(rows[a].x), Math.round(rows[a].y), Math.round(rows[a].z));
    const nr = b - a + 1;
    const pos = new Float32Array(nr * cols.length * 3);
    const water = new Float32Array(nr * cols.length * 2);
    const rapid = new Float32Array(nr * cols.length);
    const nor = new Float32Array(nr * cols.length * 3);
    for (let i = 0; i < nr; i++) {
      const r = rows[a + i];
      for (let k = 0; k < cols.length; k++) {
        const v = i * cols.length + k;
        const across = cols[k] * RIVER_RIBBON_HALF;
        // Ripple the banks so the edges don't read as straight lines.
        const wob = 0.6 * valueNoise(r.dist * 0.05 + k, cols[k] * 3);
        pos[v * 3] = r.x + f.tx * (across + wob * Math.abs(cols[k])) - origin.x;
        pos[v * 3 + 1] = r.y - origin.y;
        pos[v * 3 + 2] = r.z + f.tz * (across + wob * Math.abs(cols[k])) - origin.z;
        nor[v * 3 + 1] = 1;
        water[v * 2] = cols[k];
        water[v * 2 + 1] = r.dist;
        rapid[v] = r.rapid;
      }
    }
    const index: number[] = [];
    // Orientation: rows advance downstream, columns along the route tangent.
    const ax = RIVER_FLOW.x;
    const az = RIVER_FLOW.z;
    const up = f.tx * az - f.tz * ax < 0; // (col dir x row dir).y sign
    for (let i = 0; i < nr - 1; i++) {
      for (let k = 0; k < cols.length - 1; k++) {
        const p00 = i * cols.length + k;
        const p01 = p00 + 1;
        const p10 = p00 + cols.length;
        const p11 = p10 + 1;
        if (up) index.push(p00, p01, p11, p00, p11, p10);
        else index.push(p00, p11, p01, p00, p10, p11);
      }
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new Float32BufferAttribute(nor, 3));
    g.setAttribute('aWater', new Float32BufferAttribute(water, 2));
    g.setAttribute('aRapid', new Float32BufferAttribute(rapid, 1));
    g.setIndex(index);
    g.computeBoundingSphere();
    const mesh = new Mesh(g, waterMaterial());
    mesh.position.copy(origin);
    mesh.name = 'River';
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    out.push(mesh);
  };
  for (let i = from; i <= to; i++) {
    // Keep a dry row either side of a wet run so the water tucks under the snow.
    const wet = rows[i].wet || (i > 0 && rows[i - 1].wet) || (i < rows.length - 1 && rows[i + 1].wet);
    if (wet && start < 0) start = i;
    if ((!wet || i === to) && start >= 0) {
      flush(start, wet ? i : i - 1);
      start = -1;
    }
  }
  return out;
}

// ----------------------------------------------------------- crevasse ------

const DEEP = [
  { d: 0, c: new Color(0.78, 0.9, 0.98) },
  { d: 2.5, c: new Color(0.42, 0.68, 0.9) },
  { d: 9, c: new Color(0.14, 0.36, 0.62) },
  { d: 18, c: new Color(0.05, 0.14, 0.32) },
  { d: 30, c: new Color(0.01, 0.03, 0.08) },
];

function deepColor(down: number, out: Color): Color {
  for (let i = 1; i < DEEP.length; i++) {
    if (down <= DEEP[i].d) {
      const t = (down - DEEP[i - 1].d) / (DEEP[i].d - DEEP[i - 1].d);
      return out.copy(DEEP[i - 1].c).lerp(DEEP[i].c, t);
    }
  }
  return out.copy(DEEP[DEEP.length - 1].c);
}

/** The slot's blue ice walls, its dark floor and the snow lips (not under the ladder). */
export function* addCrevasse(chunk: Chunk): Generator<void, void, unknown> {
  const ice = chunk.batch('ice');
  const snow = chunk.batch('snow');
  const ls: number[] = [];
  for (let l = -32; l <= 32; l += 1) ls.push(l);
  const downsFor = (depth: number) => {
    const d: number[] = [0, 0.3, 0.7, 1.2];
    for (let k = 1; k <= 9; k++) d.push(1.2 + ((depth - 1.2) * k) / 9);
    return d.map((v) => Math.min(v, Math.max(0, depth)));
  };
  const rows = 13;
  const cols = ls.length;
  const tmp = new Color();
  for (const side of [-1, 1]) {
    const X = new Float64Array(cols * rows);
    const Y = new Float64Array(cols * rows);
    const Z = new Float64Array(cols * rows);
    const D = new Float64Array(cols * rows);
    ls.forEach((l, c) => {
      const depth = crevasseDepth(l);
      const lip = crevassePoint(side * crevasseWallHalf(0, depth), l);
      const lipY = groundAt(lip.x, lip.z);
      downsFor(depth).forEach((down, j) => {
        const wob = j > 0 ? 0.07 * valueNoise(l * 0.6 + side * 7, down * 0.4) : 0;
        const p = crevassePoint(side * (crevasseWallHalf(down, depth) + wob), l);
        const i = c * rows + j;
        X[i] = p.x;
        Y[i] = lipY - down;
        Z[i] = p.z;
        D[i] = down;
      });
    });
    const origin = originOf(X, Y, Z);
    // Faces point into the slot: toward a = 0, i.e. -side along the route tangent.
    const centre = crevassePoint(0, 0);
    const wallMid = crevassePoint(side * 1.3, 0);
    const facing = new Vector3(centre.x - wallMid.x, 0, centre.z - wallMid.z);
    const g = gridGeometry(cols, rows, X, Y, Z, origin, facing);
    // Colour by depth (per grid vertex, carried through the de-indexing).
    const colors = new Float32Array(cols * rows * 3);
    for (let i = 0; i < D.length; i++) {
      deepColor(D[i], tmp);
      colors[i * 3] = tmp.r;
      colors[i * 3 + 1] = tmp.g;
      colors[i * 3 + 2] = tmp.b;
    }
    g.setAttribute('color', new Float32BufferAttribute(colors, 3));
    const uv = new Float32Array(cols * rows * 2);
    for (let i = 0; i < D.length; i++) {
      uv[i * 2] = ls[Math.floor(i / rows)] * 0.35;
      uv[i * 2 + 1] = D[i] * 0.35;
    }
    g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
    addColoured(ice, g, origin);
    yield;
    // Snow lip overhanging the edge, kept off the ladder's span.
    for (let c = 0; c < cols - 1; c++) {
      const l0 = ls[c];
      const l1 = ls[c + 1];
      if (Math.abs(l0) < 1.6 || Math.abs(l1) < 1.6) continue;
      if (crevasseDepth(l0) < 0.4 && crevasseDepth(l1) < 0.4) continue;
      const a = crevassePoint(side * (CREVASSE_HALF_GAP + 0.38), l0);
      const b = crevassePoint(side * (CREVASSE_HALF_GAP + 0.38), l1);
      const ya = groundAt(a.x, a.z) - 0.1;
      const yb = groundAt(b.x, b.z) - 0.1;
      const m = segmentMatrix(new Vector3(a.x, ya, a.z), new Vector3(b.x, yb, b.z), new Matrix4());
      m.multiply(new Matrix4().makeScale(1, 1.06, 0.7));
      snow.add(new CylinderGeometry(0.24, 0.24, 1, 7, 1, true), m, SNOW);
    }
    yield;
  }
  // A dark floor closing the bottom of the slot.
  for (let c = 0; c < cols - 1; c++) {
    const l0 = ls[c];
    const l1 = ls[c + 1];
    const d0 = crevasseDepth(l0);
    const d1 = crevasseDepth(l1);
    if (d0 < 1.3 || d1 < 1.3) continue;
    const half0 = crevasseWallHalf(d0, d0);
    const half1 = crevasseWallHalf(d1, d1);
    const y0 = groundAt(crevassePoint(CREVASSE_HALF_GAP + 0.5, l0).x, crevassePoint(CREVASSE_HALF_GAP + 0.5, l0).z) - d0;
    const y1 = groundAt(crevassePoint(CREVASSE_HALF_GAP + 0.5, l1).x, crevassePoint(CREVASSE_HALF_GAP + 0.5, l1).z) - d1;
    const a = crevassePoint(-half0 - 0.1, l0);
    const b = crevassePoint(half0 + 0.1, l0);
    const cc = crevassePoint(half1 + 0.1, l1);
    const d = crevassePoint(-half1 - 0.1, l1);
    const dark = deepColor(30, tmp).clone();
    const quad = [
      [a, y0],
      [b, y0],
      [cc, y1],
      [a, y0],
      [cc, y1],
      [d, y1],
    ] as const;
    // Face up whichever way the slot's frame is handed.
    const ux = b.x - a.x;
    const uz = b.z - a.z;
    const vx = d.x - a.x;
    const vz = d.z - a.z;
    const upward = uz * vx - ux * vz > 0;
    const seq = upward ? quad : ([quad[0], quad[2], quad[1], quad[3], quad[5], quad[4]] as const);
    for (const [p, y] of seq) ice.vertex(p.x, y, p.z, 0, 1, 0, dark, undefined, p.x * 0.3, p.z * 0.3);
  }
  const f = crevassePoint(0, 0);
  chunk.extend(f.x, groundAt(f.x, f.z) - 14, f.z, 36);
}

/** Append an indexed, coloured geometry (in local coords) to a batch. */
function addColoured(batch: Batch, g: BufferGeometry, origin: Vector3): void {
  const flat = g.toNonIndexed();
  const col = flat.getAttribute('color');
  let i = 0;
  batch.add(flat, new Matrix4().makeTranslation(origin.x, origin.y, origin.z), (_p, _n, out) => {
    out.fromBufferAttribute(col, i++);
  });
  g.dispose();
}

// ---------------------------------------------------------------- faces ----

const ICE_BLUE = new Color(0.56, 0.77, 0.92);
const ICE_DEEP = new Color(0.3, 0.55, 0.8);
const ICE_SNOW = new Color(0.92, 0.95, 0.99);

/** The climbing face, the slab over its lip, a cornice and (ice) icicles. */
export function* addFace(chunk: Chunk, g: FaceGrid): Generator<void, void, unknown> {
  const face = g.face;
  const origin = originOf(g.x, g.y, g.z);
  const outward = new Vector3(face.crossing.nx, 0, face.crossing.nz);
  const geo = gridGeometry(g.cols, g.rows, g.x, g.y, g.z, origin, outward);
  const tr = new Matrix4().makeTranslation(origin.x, origin.y, origin.z);
  if (face.id === 'ice') {
    const uv = new Float32Array(g.cols * g.rows * 2);
    for (let c = 0; c < g.cols; c++) {
      for (let j = 0; j < g.rows; j++) {
        const i = c * g.rows + j;
        uv[i * 2] = g.along[c] * 0.22;
        uv[i * 2 + 1] = g.y[i] * 0.22;
      }
    }
    geo.setAttribute('uv', new Float32BufferAttribute(uv, 2));
    chunk.batch('ice').add(geo, tr, (p, n, out) => {
      if (n.y > 0.5) {
        out.copy(ICE_SNOW);
        return;
      }
      const streak = valueNoise((p.x + p.z) * 0.45, p.y * 0.035);
      out.copy(ICE_BLUE).lerp(ICE_DEEP, Math.max(0, Math.min(1, streak * 1.2 + 0.25)));
      if (n.y > 0.25) out.lerp(ICE_SNOW, (n.y - 0.25) * 3);
    });
  } else {
    chunk.batch('faceRock').add(geo, tr, WHITE);
  }
  yield;
  // Slab over the top, so there is never a hole behind the lip.
  const sOrigin = originOf(g.sx, g.sy, g.sz);
  const slab = gridGeometry(g.cols, g.slabRows, g.sx, g.sy, g.sz, sOrigin, new Vector3(0, 1, 0));
  chunk.batch('snow').add(slab, new Matrix4().makeTranslation(sOrigin.x, sOrigin.y, sOrigin.z), SNOW);
  // Cornice along the lip.
  const snow = chunk.batch('snow');
  const m = new Matrix4();
  for (let c = 0; c < g.cols - 1; c++) {
    const ia = c * g.rows + g.rows - 1;
    const ib = (c + 1) * g.rows + g.rows - 1;
    const a = new Vector3(g.x[ia], g.y[ia] - 0.05, g.z[ia]);
    const b = new Vector3(g.x[ib], g.y[ib] - 0.05, g.z[ib]);
    const ma = segmentMatrix(a, b, m).multiply(new Matrix4().makeScale(1, 1.05, 0.55));
    snow.add(new CylinderGeometry(0.34, 0.34, 1, 8, 1, true), ma, SNOW);
  }
  yield;
  if (face.id === 'ice') {
    const ice = chunk.batch('ice');
    const rand = mulberry32(720);
    for (let c = 1; c < g.cols - 1; c++) {
      if (Math.abs(g.along[c]) > face.halfWidth - 6) continue;
      const it = c * g.rows + g.rows - 1;
      for (let k = 0; k < 2; k++) {
        if (rand() < 0.25) continue;
        const t = rand();
        const ib = (c + 1) * g.rows + g.rows - 1;
        const x = g.x[it] + (g.x[ib] - g.x[it]) * t + outward.x * 0.22;
        const z = g.z[it] + (g.z[ib] - g.z[it]) * t + outward.z * 0.22;
        const len = 0.3 + Math.pow(rand(), 2) * 2.2;
        // Keep the climbing lane's icicles short so they never block the axes.
        const inLane = Math.abs(g.along[c]) < face.laneHalf + 1.5;
        const L = inLane ? Math.min(len, 0.5) : len;
        const r = 0.04 + L * 0.05;
        const y = g.y[it] - 0.18 - L / 2;
        ice.add(new ConeGeometry(r, L, 5), new Matrix4().makeRotationX(Math.PI).setPosition(x, y, z), ICE_SNOW, undefined, 0.5);
      }
    }
  }
  const mid = Math.floor(g.cols / 2) * g.rows + Math.floor(g.rows / 2);
  chunk.extend(g.x[mid], g.y[mid], g.z[mid], face.halfWidth + 30);
}

/** The rock wall rising above the fixed-rope ledge. */
export function addLedgeWall(chunk: Chunk, g: LedgeWallGrid): void {
  const origin = originOf(g.x, g.y, g.z);
  const mc = Math.floor(g.cols / 2) * g.rows;
  const top = mc + g.rows - 1;
  const towardPath = new Vector3(g.x[mc] - g.x[top], 0, g.z[mc] - g.z[top]).normalize();
  const geo = gridGeometry(g.cols, g.rows, g.x, g.y, g.z, origin, towardPath);
  chunk.batch('faceRock').add(geo, new Matrix4().makeTranslation(origin.x, origin.y, origin.z), WHITE);
  chunk.extend(g.x[mc], g.y[mc] + 10, g.z[mc], 140);
}

// ---------------------------------------------------------------- seams ----

const SEAM_CORE = new Color(0.16, 0.4, 0.68);
const SEAM_EDGE = new Color(0.55, 0.76, 0.92);

export function addSeam(chunk: Chunk, seam: Seam): void {
  const b = chunk.batch('seam');
  const n = seam.x.length;
  const lift = 0.04;
  const pts: Array<[number, number, number, number, number, number]> = [];
  for (let i = 0; i < n; i++) {
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(n - 1, i + 1);
    const tx = seam.x[i1] - seam.x[i0];
    const tz = seam.z[i1] - seam.z[i0];
    const tl = Math.hypot(tx, tz) || 1;
    const t = i / (n - 1);
    const w = seam.width * Math.sin(Math.PI * Math.min(1, Math.max(0.02, t))) * (0.75 + 0.25 * valueNoise(i * 0.4, seam.seed));
    const px = (-tz / tl) * w * 0.5;
    const pz = (tx / tl) * w * 0.5;
    pts.push([seam.x[i] - px, seam.z[i] - pz, seam.x[i], seam.z[i], seam.x[i] + px, seam.z[i] + pz]);
  }
  const put = (x: number, z: number, c: Color) => b.vertex(x, groundAt(x, z) + lift, z, 0, 1, 0, c);
  const quad = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number, ca: Color, cb: Color) => {
    // a-b on one cross-section, d-c on the next; face up whatever the handedness.
    const upward = (bx - ax) * (dz - az) - (bz - az) * (dx - ax) < 0;
    if (upward) {
      put(ax, az, ca);
      put(bx, bz, cb);
      put(cx, cz, cb);
      put(ax, az, ca);
      put(cx, cz, cb);
      put(dx, dz, ca);
    } else {
      put(ax, az, ca);
      put(cx, cz, cb);
      put(bx, bz, cb);
      put(ax, az, ca);
      put(dx, dz, ca);
      put(cx, cz, cb);
    }
  };
  for (let i = 0; i < n - 1; i++) {
    const [lx0, lz0, mx0, mz0, rx0, rz0] = pts[i];
    const [lx1, lz1, mx1, mz1, rx1, rz1] = pts[i + 1];
    quad(lx0, lz0, mx0, mz0, mx1, mz1, lx1, lz1, SEAM_EDGE, SEAM_CORE);
    quad(mx0, mz0, rx0, rz0, rx1, rz1, mx1, mz1, SEAM_CORE, SEAM_EDGE);
  }
  chunk.extend(seam.x[n >> 1], groundAt(seam.x[n >> 1], seam.z[n >> 1]), seam.z[n >> 1], n * 0.8);
}

// ---------------------------------------------------------------- holds ----

/** Chalk-dusted hold geometry (like world-builders' buildHoldMesh). */
function holdGeometry(): BufferGeometry {
  const geo = new IcosahedronGeometry(0.075, 2);
  const pos = geo.getAttribute('position');
  const nor = geo.getAttribute('normal');
  for (let v = 0; v < pos.count; v++) {
    const x = pos.getX(v);
    const y = pos.getY(v);
    const z = pos.getZ(v);
    const f = 1 + 0.15 * valueNoise(x * 30 + 3, y * 30 + z * 20);
    pos.setXYZ(v, x * f * 1.35, y * f * 0.8, z * f * 0.95);
    const len = Math.hypot(x / 1.35, y / 0.8, z / 0.95);
    nor.setXYZ(v, x / 1.35 / len, y / 0.8 / len, z / 0.95 / len);
  }
  return geo;
}

export interface HoldMeshes {
  /** All holds drawn in one call; per-instance glow in `glow`. */
  mesh: InstancedMesh;
  glow: InstancedBufferAttribute;
  /** Invisible proxies (one per hold) for ClimbHold entities, in world coordinates. */
  proxies: Mesh[];
  /** Which holds are the big jugs on the lip. */
  lips: boolean[];
}

const proxyMaterial = new MeshBasicMaterial({ colorWrite: false, depthWrite: false });

export function buildHolds(holds: HoldSpec[], wallNormal: Vector3): HoldMeshes {
  const origin = new Vector3(Math.round(holds[0].x), Math.round(holds[0].y), Math.round(holds[0].z));
  const mesh = new InstancedMesh(holdGeometry(), holdMaterial(), holds.length);
  const glow = new InstancedBufferAttribute(new Float32Array(holds.length).fill(0.12), 1);
  mesh.geometry.setAttribute('aGlow', glow);
  const m = new Matrix4();
  const q = new Matrix4();
  const yaw = Math.atan2(wallNormal.x, wallNormal.z);
  const proxies: Mesh[] = [];
  const proxyGeo = new IcosahedronGeometry(0.05, 0);
  holds.forEach((h, i) => {
    q.makeRotationY(yaw + (h.lip ? 0 : Math.sin(h.seed) * 0.6));
    if (!h.lip) q.multiply(new Matrix4().makeRotationX(Math.cos(h.seed * 1.3) * 0.5));
    m.copy(q).scale(new Vector3(h.scale, h.scale, h.scale)).setPosition(h.x - origin.x, h.y - origin.y, h.z - origin.z);
    mesh.setMatrixAt(i, m);
    const proxy = new Mesh(proxyGeo, proxyMaterial);
    proxy.position.set(h.x, h.y, h.z);
    proxy.visible = false;
    proxy.name = `ExpRockHold${i}`;
    proxies.push(proxy);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.position.copy(origin);
  mesh.computeBoundingSphere();
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'ExpRockBandHolds';
  return { mesh, glow, proxies, lips: holds.map((h) => h.lip) };
}

// ------------------------------------------------------- collapse serac ----

/**
 * The serac that collapses: a group at the pivot (the downhill foot edge)
 * turned so local +Z is the fall direction; the tower stands on local
 * z in [-depth, 0], sunk 1.5 m into the glacier. Rotate the group about
 * its local X axis to topple it.
 */
export function buildCollapseSerac(t: SeracTower): Group {
  const group = new Group();
  group.name = 'CollapsingSerac';
  group.position.set(t.x, t.baseY, t.z);
  group.rotation.y = t.yaw;
  const b = new Batch(null, false);
  const geo = seracGeometry(5060.5, t.width, t.height, t.depth);
  b.add(geo, new Matrix4().makeTranslation(0, -1.5, -t.depth / 2), seracColor(-1.5, t.height));
  const mesh = b.mesh(new Vector3(), iceFacetMaterial(), 'CollapsingSeracIce', true)!;
  group.add(mesh);
  return group;
}

export function emptyObject(name: string): Object3D {
  const o = new Object3D();
  o.name = name;
  return o;
}
