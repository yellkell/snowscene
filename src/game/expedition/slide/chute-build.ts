/**
 * The Summit Chute's meshes: a carved ice trough with lane lines, the timber
 * trestle that carries it over the rock band and holds up the landing deck,
 * marker poles, the start gate, restart arches and the barriers to lean
 * past. Everything is merged per material (five draws) and built relative
 * to the chute's start so the vertices keep their precision.
 */

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Vector3,
} from '@iwsdk/core';
import { GeometryBuilder, segmentMatrix } from '../../mesh-utils.js';
import { mulberry32 } from '../../terrain.js';
import { expeditionHeight } from '../exp-terrain.js';
import { iceFacetMaterial, iceSmoothMaterial, propsMaterial, rockMaterial } from '../world/materials.js';
import { CHUTE_HALF, CHUTE_WALL, chute, type ChuteData, chuteSample, type ChuteSample } from './chute-path.js';

const ICE_BED = new Color(0.74, 0.86, 1.0);
const SNOW_WALL = new Color(0.93, 0.95, 1.0);
const UNDERSIDE = new Color(0.55, 0.6, 0.68);
const LANE_LINE = new Color(0.08, 0.32, 0.95);
const WOOD = new Color(0.5, 0.33, 0.19);
const WOOD_DARK = new Color(0.31, 0.2, 0.12);
const MARKER = new Color(0.95, 0.42, 0.08);
const FLAG_GREEN = new Color(0.15, 0.7, 0.3);
const IRON = new Color(0.16, 0.16, 0.17);

/**
 * Cross-section of the trough as strips (lateral along the rider's right,
 * height above the bed), each going left to right / bottom to top as seen
 * from behind, so the faces point out of the solid. Separate strips keep the
 * corners crisp.
 */
const STRIPS: { pts: [number, number][]; color: Color }[] = [
  // The icy bed, slightly dished.
  {
    pts: [
      [-CHUTE_HALF, 0.08],
      [-CHUTE_HALF + 0.2, 0],
      [0, -0.02],
      [CHUTE_HALF - 0.2, 0],
      [CHUTE_HALF, 0.08],
    ],
    color: ICE_BED,
  },
  // Inner walls and their tops.
  { pts: [[CHUTE_HALF, 0.08], [CHUTE_HALF, CHUTE_WALL]], color: SNOW_WALL },
  { pts: [[-CHUTE_HALF, CHUTE_WALL], [-CHUTE_HALF, 0.08]], color: SNOW_WALL },
  { pts: [[CHUTE_HALF, CHUTE_WALL], [CHUTE_HALF + 0.3, CHUTE_WALL]], color: SNOW_WALL },
  { pts: [[-CHUTE_HALF - 0.3, CHUTE_WALL], [-CHUTE_HALF, CHUTE_WALL]], color: SNOW_WALL },
  // Outer sides and the underside (seen where it rides the trestle).
  { pts: [[CHUTE_HALF + 0.3, CHUTE_WALL], [CHUTE_HALF + 0.3, -0.35]], color: SNOW_WALL },
  { pts: [[-CHUTE_HALF - 0.3, -0.35], [-CHUTE_HALF - 0.3, CHUTE_WALL]], color: SNOW_WALL },
  { pts: [[CHUTE_HALF + 0.3, -0.35], [-CHUTE_HALF - 0.3, -0.35]], color: UNDERSIDE },
];

export interface ChuteVisuals {
  group: Group;
}

export function buildChute(): ChuteVisuals {
  const c = chute();
  const origin = new Vector3(c.x[0], c.y[0], c.z[0]);
  const group = new Group();
  group.name = 'SummitChute';
  group.position.copy(origin);

  const trough = new Mesh(buildTrough(c, origin), iceSmoothMaterial());
  trough.name = 'ChuteTrough';
  trough.receiveShadow = true;
  group.add(trough);

  const wood = new GeometryBuilder();
  const ice = new GeometryBuilder();
  const rock = new GeometryBuilder();
  addTrestle(wood, c, origin);
  addMarkers(wood, c, origin);
  addDeck(wood, c, origin);
  addArches(wood, c, origin);
  addBarriers(wood, ice, rock, c, origin);
  const timber = new Mesh(wood.build(), propsMaterial());
  timber.name = 'ChuteTimber';
  group.add(timber);
  const blocks = new Mesh(ice.build(), iceFacetMaterial());
  blocks.name = 'ChuteIceBlocks';
  group.add(blocks);
  const pillars = new Mesh(rock.build(), rockMaterial());
  pillars.name = 'ChuteRocks';
  group.add(pillars);
  group.add(buildGateSign(c, origin));
  return { group };
}

// ---------------------------------------------------------------- trough --

function buildTrough(c: ChuteData, origin: Vector3): BufferGeometry {
  // The trough stops where the landing deck starts.
  const rows = c.u.length - 8;
  const positions: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const put = (lat: number, h: number, r: number, along: number, col: Color) => {
    positions.push(c.x[r] + c.rightX * lat - origin.x, c.y[r] + h - origin.y, c.z[r] + c.rightZ * lat - origin.z);
    uvs.push(along * 0.5, c.s[r] * 0.5);
    colors.push(col.r, col.g, col.b);
  };
  /** A strip of quads along the whole trough through `pts`. */
  const strip = (pts: [number, number][], col: Color) => {
    const first = positions.length / 3;
    const cols = pts.length;
    for (let r = 0; r < rows; r++) {
      let along = 0;
      for (let k = 0; k < cols; k++) {
        if (k > 0) along += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
        put(pts[k][0], pts[k][1], r, along, col);
      }
    }
    for (let r = 0; r < rows - 1; r++) {
      for (let k = 0; k < cols - 1; k++) {
        const a = first + r * cols + k;
        const b = a + cols;
        indices.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
  };
  for (const st of STRIPS) strip(st.pts, st.color);
  // Lane lines: thin ribbons just proud of the dished bed.
  for (const lane of [-0.3, 0.3]) {
    const h = -0.02 + 0.02 * (Math.abs(lane) / (CHUTE_HALF - 0.2)) + 0.02;
    strip([[lane - 0.035, h], [lane + 0.035, h]], LANE_LINE);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

// ----------------------------------------------------------------- timber --

const A = new Vector3();
const B = new Vector3();

function rod(b: GeometryBuilder, a: Vector3, e: Vector3, r: number, color: Color, sides = 5) {
  b.add(new CylinderGeometry(r, r, 1, sides), segmentMatrix(a, e, new Matrix4()), color);
}

/** A box centred at a world point, turned to the chute's heading. */
function boxAt(b: GeometryBuilder, c: ChuteData, origin: Vector3, w: number, h: number, d: number, p: Vector3, color: Color) {
  const m = new Matrix4().makeRotationY(c.yaw).setPosition(p.x - origin.x, p.y - origin.y, p.z - origin.z);
  b.add(new BoxGeometry(w, h, d), m, color);
}

const local = (p: Vector3, origin: Vector3) => p.clone().sub(origin);

/** Bents every few metres wherever the bed stands off the snow. */
function addTrestle(b: GeometryBuilder, c: ChuteData, origin: Vector3) {
  const half = CHUTE_HALF + 0.22;
  let last = -10;
  for (let i = 0; i < c.u.length; i++) {
    const lift = c.y[i] - c.ground[i];
    if (lift < 0.7 || i - last < 3) continue;
    last = i;
    const top = c.y[i] - 0.36;
    for (const side of [-1, 1]) {
      const x = c.x[i] + c.rightX * side * half;
      const z = c.z[i] + c.rightZ * side * half;
      const g = expeditionHeight(x, z) - 0.4;
      rod(b, local(A.set(x, top, z), origin), local(B.set(x, g, z), origin), 0.09, WOOD_DARK, 4);
    }
    // Cap beam under the bed, and cross bracing on the tall ones.
    const lx = c.x[i] - c.rightX * half;
    const lz = c.z[i] - c.rightZ * half;
    const rx = c.x[i] + c.rightX * half;
    const rz = c.z[i] + c.rightZ * half;
    rod(b, local(A.set(lx, top, lz), origin), local(B.set(rx, top, rz), origin), 0.1, WOOD, 4);
    if (lift > 3) {
      const low = Math.max(c.ground[i], top - Math.min(lift, 7));
      rod(b, local(A.set(lx, top, lz), origin), local(B.set(rx, low, rz), origin), 0.05, WOOD_DARK, 4);
      rod(b, local(A.set(rx, top, rz), origin), local(B.set(lx, low, lz), origin), 0.05, WOOD_DARK, 4);
    }
  }
}

/** Orange marker poles with pennants down both sides. */
function addMarkers(b: GeometryBuilder, c: ChuteData, origin: Vector3) {
  const sample: ChuteSample = { x: 0, y: 0, z: 0, slope: 0, lift: 0 };
  let k = 0;
  for (let s = 10; s < c.length - 12; s += 16, k++) {
    chuteSample(s, sample);
    if (sample.lift > 0.7) continue;
    const side = k % 2 ? 1 : -1;
    const lat = side * (CHUTE_HALF + 0.75);
    const x = sample.x + c.rightX * lat;
    const z = sample.z + c.rightZ * lat;
    const g = expeditionHeight(x, z);
    rod(b, local(A.set(x, g - 0.2, z), origin), local(B.set(x, g + 1.6, z), origin), 0.025, MARKER, 5);
    boxAt(b, c, origin, 0.02, 0.22, 0.34, A.set(x, g + 1.45, z).add(B.set(c.dirX * -0.17, 0, c.dirZ * -0.17)), MARKER);
  }
}

/** The landing deck at the bottom, with rails down the sides. */
function addDeck(b: GeometryBuilder, c: ChuteData, origin: Vector3) {
  const rows = c.u.length;
  const from = rows - 9;
  const half = 1.9;
  for (let i = from; i < rows; i++) {
    const p = A.set(c.x[i], c.y[i] - 0.06, c.z[i]);
    boxAt(b, c, origin, half * 2, 0.1, 0.96, p, i % 2 ? WOOD : WOOD_DARK);
  }
  for (const side of [-1, 1]) {
    for (let i = from; i < rows; i += 2) {
      const x = c.x[i] + c.rightX * side * half;
      const z = c.z[i] + c.rightZ * side * half;
      rod(b, local(A.set(x, c.y[i], z), origin), local(B.set(x, c.y[i] + 1.05, z), origin), 0.045, WOOD_DARK, 5);
    }
    const x0 = c.x[from] + c.rightX * side * half;
    const z0 = c.z[from] + c.rightZ * side * half;
    const x1 = c.x[rows - 1] + c.rightX * side * half;
    const z1 = c.z[rows - 1] + c.rightZ * side * half;
    rod(b, local(A.set(x0, c.y[from] + 1.05, z0), origin), local(B.set(x1, c.y[rows - 1] + 1.05, z1), origin), 0.04, WOOD, 5);
  }
  // Deck bents (the trestle already stands under it; add a stringer either side).
  for (const side of [-1, 1]) {
    const x0 = c.x[from] + c.rightX * side * (half - 0.1);
    const z0 = c.z[from] + c.rightZ * side * (half - 0.1);
    const x1 = c.x[rows - 1] + c.rightX * side * (half - 0.1);
    const z1 = c.z[rows - 1] + c.rightZ * side * (half - 0.1);
    rod(b, local(A.set(x0, c.y[from] - 0.2, z0), origin), local(B.set(x1, c.y[rows - 1] - 0.2, z1), origin), 0.09, WOOD_DARK, 4);
    for (let i = from; i < rows; i += 3) {
      const x = c.x[i] + c.rightX * side * (half - 0.1);
      const z = c.z[i] + c.rightZ * side * (half - 0.1);
      rod(b, local(A.set(x, c.y[i] - 0.2, z), origin), local(B.set(x, expeditionHeight(x, z) - 0.4, z), origin), 0.1, WOOD_DARK, 4);
    }
  }
}

/** Start gate and the restart arches (with green pennants). */
function addArches(b: GeometryBuilder, c: ChuteData, origin: Vector3) {
  const sample: ChuteSample = { x: 0, y: 0, z: 0, slope: 0, lift: 0 };
  const half = CHUTE_HALF + 0.45;
  for (const s of c.checkpoints) {
    chuteSample(s + 1.5, sample);
    const height = 3.1;
    for (const side of [-1, 1]) {
      const x = sample.x + c.rightX * side * half;
      const z = sample.z + c.rightZ * side * half;
      const g = Math.min(sample.y, expeditionHeight(x, z));
      rod(b, local(A.set(x, g - 0.3, z), origin), local(B.set(x, sample.y + height, z), origin), 0.11, WOOD_DARK, 6);
      boxAt(b, c, origin, 0.03, 0.4, 0.55, A.set(x, sample.y + height - 0.45, z), FLAG_GREEN);
    }
    const lx = sample.x - c.rightX * (half + 0.2);
    const lz = sample.z - c.rightZ * (half + 0.2);
    const rx = sample.x + c.rightX * (half + 0.2);
    const rz = sample.z + c.rightZ * (half + 0.2);
    rod(b, local(A.set(lx, sample.y + height, lz), origin), local(B.set(rx, sample.y + height, rz), origin), 0.12, WOOD, 6);
    if (s === 0) {
      // The start bar you push off from, and a timber step either side.
      rod(b, local(A.set(lx, sample.y + 0.95, lz), origin), local(B.set(rx, sample.y + 0.95, rz), origin), 0.03, IRON, 6);
    }
  }
}

/** Barrier rows: ice blocks, rock pillars and slalom boards. */
function addBarriers(wood: GeometryBuilder, ice: GeometryBuilder, rock: GeometryBuilder, c: ChuteData, origin: Vector3) {
  const sample: ChuteSample = { x: 0, y: 0, z: 0, slope: 0, lift: 0 };
  const rand = mulberry32(4411);
  const LANES = [-0.6, 0, 0.6];
  for (const bar of c.barriers) {
    chuteSample(bar.s, sample);
    const lat = LANES[bar.lane];
    const x = sample.x + c.rightX * lat;
    const z = sample.z + c.rightZ * lat;
    const y = sample.y;
    const lx = x - origin.x;
    const ly = y - origin.y;
    const lz = z - origin.z;
    if (bar.kind === 'ice') {
      const h = 2.3 + rand() * 0.5;
      const m = new Matrix4()
        .makeRotationY(c.yaw + (rand() - 0.5) * 0.5)
        .multiply(new Matrix4().makeRotationZ((rand() - 0.5) * 0.12))
        .setPosition(lx, ly + h / 2 - 0.1, lz);
      ice.add(new BoxGeometry(0.46, h, 0.4), m, new Color(0.62, 0.84, 1.0));
      const cap = new Matrix4().makeRotationY(c.yaw + 0.7).setPosition(lx, ly + h - 0.05, lz);
      ice.add(new IcosahedronGeometry(0.26, 0), cap, new Color(0.75, 0.9, 1.0));
    } else if (bar.kind === 'rock') {
      const h = 2.2 + rand() * 0.6;
      const m = new Matrix4()
        .makeRotationY(rand() * 6)
        .multiply(new Matrix4().makeScale(0.28, h / 2, 0.26))
        .setPosition(lx, ly + h / 2 - 0.15, lz);
      rock.add(new IcosahedronGeometry(1, 1), m, new Color(1, 1, 1));
    } else {
      // A slalom board slung between two poles.
      const across = 0.2;
      for (const side of [-1, 1]) {
        const px = lx + c.rightX * side * across;
        const pz = lz + c.rightZ * side * across;
        rod(wood, A.set(px, ly - 0.1, pz), B.set(px, ly + 2.5, pz), 0.03, IRON, 5);
      }
      const red = bar.lane === 1 ? new Color(0.85, 0.12, 0.1) : MARKER;
      boxAt(wood, c, new Vector3(), 0.5, 1.5, 0.05, A.set(lx, ly + 1.65, lz), red);
      boxAt(wood, c, new Vector3(), 0.52, 0.08, 0.07, A.set(lx, ly + 2.42, lz), WOOD_DARK);
    }
  }
}

/** The sign over the start gate. */
function buildGateSign(c: ChuteData, origin: Vector3): Mesh {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 96;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#5d3f24';
  ctx.fillRect(0, 0, 512, 96);
  ctx.strokeStyle = '#2c1c0e';
  ctx.lineWidth = 8;
  ctx.strokeRect(4, 4, 504, 88);
  ctx.fillStyle = '#f4e6c8';
  ctx.font = '700 46px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.fillText('THE SUMMIT CHUTE', 256, 62);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const sign = new Mesh(
    new PlaneGeometry(2.6, 0.49),
    new MeshStandardMaterial({ map: texture, roughness: 0.9 }),
  );
  const sample: ChuteSample = { x: 0, y: 0, z: 0, slope: 0, lift: 0 };
  chuteSample(1.5, sample);
  // Hung under the gate's beam, readable as you walk up to it.
  sign.position.set(sample.x - origin.x, sample.y + 2.6 - origin.y, sample.z - origin.z);
  sign.rotation.y = c.yaw;
  sign.name = 'ChuteSign';
  return sign;
}
