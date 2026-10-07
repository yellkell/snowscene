/**
 * Builders for the man-made props on the mountain. Each one appends merged
 * geometry to a chunk's batches (one draw call per material per chunk):
 * dome tents, the mess tent, crates and barrels, bamboo wands and marker
 * flags, poles, masts and windsocks, the puja altar, cairns, signs, prayer
 * flag lines, festoon wires, and flat patches on the snow.
 */

import {
  BoxGeometry,
  type BufferGeometry,
  Color,
  CylinderGeometry,
  IcosahedronGeometry,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from '@iwsdk/core';
import { segmentMatrix } from '../../mesh-utils.js';
import { mulberry32, valueNoise } from '../../terrain.js';
import { type Fx } from './batch.js';
import { bulbMaterial } from './materials.js';
import type { Chunk } from './chunks.js';
import { type Decal, type Line, WIND_DIR, type Windsock } from './layout-camps.js';
import type { SignSpec } from './layout-route.js';
import { groundAt, type Item } from './layout-util.js';
import type { SignAtlas } from './sign-atlas.js';

const hex = (h: number) => new Color(h);

const WOOD = hex(0x7a5534);
const WOOD_DARK = hex(0x4e3420);
const SNOW = new Color(0.93, 0.95, 0.99);
const BAMBOO = new Color(0.72, 0.6, 0.34);
const STEEL = new Color(0.62, 0.64, 0.68);
const ROPE = new Color(0.82, 0.8, 0.72);
const WIRE = new Color(0.05, 0.05, 0.05);
const ORANGE = new Color(1, 0.3, 0.04);
const WHITE = new Color(0.92, 0.92, 0.9);

/** Expedition tent flysheets. */
export const TENT_COLORS = [0xe8b13a, 0xd8452b, 0xf06a2a, 0x2f6fb5, 0x3f9a5a, 0xe8b13a, 0xd8452b, 0xb53f8f, 0xf06a2a].map(hex);
/** Prayer flags, in their traditional order: blue, white, red, green, yellow. */
const LUNGTA = [0x1f5fbf, 0xf2f0e8, 0xd42a1e, 0x1e9a4a, 0xf2c21a].map(hex);
const BULBS = [new Color(1, 0.72, 0.3), new Color(1, 0.3, 0.22), new Color(0.35, 0.95, 0.45), new Color(0.35, 0.6, 1), new Color(1, 0.45, 0.85)];

const FABRIC_FX: Fx = [0.55, 0, 0.75, 0];
const CANVAS_FX: Fx = [0.42, 0, 0.85, 0];
const METAL_FX: Fx = [0, 0.75, 0.35, 0];
const PAINT_FX: Fx = [0, 0.2, 0.45, 0];

const v1 = new Vector3();
const v2 = new Vector3();

/** Object frame of an item: translation to its base plus yaw. */
function frame(it: { x: number; y: number; z: number; yaw: number }): Matrix4 {
  return new Matrix4().makeRotationY(it.yaw).setPosition(it.x, it.y, it.z);
}

/** frame * translate(x, y, z) * rotY(ry) * scale(sx, sy, sz) */
function local(fr: Matrix4, x: number, y: number, z: number, sx = 1, sy = sx, sz = sx, ry = 0): Matrix4 {
  return fr.clone().multiply(new Matrix4().makeRotationY(ry).scale(v1.set(sx, sy, sz)).setPosition(x, y, z));
}

function pointIn(fr: Matrix4, x: number, y: number, z: number): Vector3 {
  return new Vector3(x, y, z).applyMatrix4(fr);
}

// --------------------------------------------------------------- tents -----

export function addTent(chunk: Chunk, it: Item): void {
  const s = it.size;
  const fr = frame(it);
  const fabric = TENT_COLORS[(it.variant ?? 0) % TENT_COLORS.length];
  const door = fabric.clone().multiplyScalar(0.45);
  const hem = fabric.clone().multiplyScalar(0.7);
  const props = chunk.batch('props');
  const dome = new SphereGeometry(1, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  props.add(dome, local(fr, 0, 0, 0, 1.25 * s, 1.1 * s, 1.0 * s), (_p, _n, out, l) => {
    if (l.z > 0.55 && Math.abs(l.x) < 0.42 && l.y < 0.78) out.copy(door);
    else if (l.y < 0.1) out.copy(hem);
    else out.copy(fabric);
  }, FABRIC_FX);
  // Crossed poles just proud of the flysheet.
  for (const ry of [Math.PI / 4, -Math.PI / 4]) {
    const arc = new TorusGeometry(1, 0.018, 4, 12, Math.PI);
    const m = fr.clone().multiply(new Matrix4().makeRotationY(ry).scale(v1.set(1.27 * s, 1.12 * s, 1.02 * s)));
    props.add(arc, m, WIRE, METAL_FX);
  }
  // Snow banked round the skirt.
  props.add(new CylinderGeometry(1.06, 1.16, 0.18, 14), local(fr, 0, 0.04, 0, 1.25 * s, 1, 1.0 * s), SNOW);
  // Guy lines.
  for (const [gx, gz] of [
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
  ]) {
    const a = pointIn(fr, gx * 0.85 * s, 0.7 * s, gz * 0.6 * s);
    const b = pointIn(fr, gx * 1.9 * s, 0.02, gz * 1.5 * s);
    props.add(new CylinderGeometry(0.006, 0.006, 1, 3), segmentMatrix(a, b, new Matrix4()), ORANGE);
  }
  chunk.extend(it.x, it.y + s, it.z, 2.2 * s);
}

export function addMessTent(chunk: Chunk, it: Item): void {
  const fr = frame(it);
  const props = chunk.batch('props');
  const canvas = hex(0x2c5d8f);
  const canvasDark = hex(0x1d3f63);
  const L = 7;
  const W = 4.6;
  const eave = 1.9;
  const ridge = 3.1;
  props.add(new BoxGeometry(L, eave, W), local(fr, 0, eave / 2, 0), canvas, CANVAS_FX);
  const slope = Math.atan2(ridge - eave, W / 2);
  const slab = Math.hypot(ridge - eave, W / 2) + 0.25;
  for (const side of [-1, 1]) {
    const m = fr.clone().multiply(new Matrix4().makeRotationX(side * slope).setPosition(0, (eave + ridge) / 2 + 0.05, (side * W) / 4));
    props.add(new BoxGeometry(L + 0.4, 0.07, slab), m, canvasDark, CANVAS_FX);
    const ms = fr.clone().multiply(new Matrix4().makeRotationX(side * slope).setPosition(0, (eave + ridge) / 2 + 0.13, (side * W) / 4));
    props.add(new BoxGeometry(L + 0.3, 0.09, slab - 0.15), ms, SNOW);
  }
  // Gables.
  for (const end of [-1, 1]) {
    const a = pointIn(fr, (end * L) / 2, eave, -W / 2);
    const b = pointIn(fr, (end * L) / 2, eave, W / 2);
    const c = pointIn(fr, (end * L) / 2, ridge, 0);
    const outN = v2.set(end, 0, 0).transformDirection(fr);
    const tri = props;
    const ab = new Vector3().subVectors(b, a);
    const ac = new Vector3().subVectors(c, a);
    const facing = new Vector3().crossVectors(ab, ac).dot(outN) > 0;
    const [p, q] = facing ? [b, c] : [c, b];
    for (const v of [a, p, q]) tri.vertex(v.x, v.y, v.z, outN.x, outN.y, outN.z, canvas, CANVAS_FX);
  }
  // Door at the front end and an awning over a table.
  props.add(new BoxGeometry(0.05, 1.6, 1.3), local(fr, L / 2 + 0.01, 0.8, 0), canvasDark, CANVAS_FX);
  const awn = fr.clone().multiply(new Matrix4().makeRotationZ(-0.18).setPosition(L / 2 + 1.25, 2.05, 0));
  props.add(new BoxGeometry(2.6, 0.05, 3.4), awn, hex(0xd9a441), CANVAS_FX);
  for (const z of [-1.6, 1.6]) props.add(new CylinderGeometry(0.035, 0.035, 1.85, 6), local(fr, L / 2 + 2.45, 0.92, z), STEEL, METAL_FX);
  props.add(new BoxGeometry(1.0, 0.05, 1.8), local(fr, L / 2 + 1.3, 0.75, 0), WOOD);
  for (const [x, z] of [
    [0.45, 0.8],
    [-0.45, 0.8],
    [0.45, -0.8],
    [-0.45, -0.8],
  ]) props.add(new BoxGeometry(0.05, 0.75, 0.05), local(fr, L / 2 + 1.3 + x, 0.375, z), WOOD_DARK);
  for (const x of [0.85, -0.85]) props.add(new BoxGeometry(0.28, 0.42, 1.8), local(fr, L / 2 + 1.3 + x, 0.21, 0), WOOD_DARK);
  // Snow drift along the walls.
  props.add(new BoxGeometry(L + 0.6, 0.22, W + 0.6), local(fr, 0, 0.03, 0), SNOW);
  chunk.extend(it.x, it.y + 2, it.z, 6);
}

// ------------------------------------------------------- crates, barrels ---

export function addCrate(chunk: Chunk, it: Item): void {
  const s = it.size;
  const fr = frame(it);
  const props = chunk.batch('props');
  const wood = WOOD.clone().multiplyScalar(0.85 + ((it.variant ?? 0) % 3) * 0.1);
  props.add(new BoxGeometry(s * 1.3, s * 0.8, s * 0.85), local(fr, 0, s * 0.4, 0), wood);
  for (const y of [0.22, 0.62]) props.add(new BoxGeometry(s * 1.32, s * 0.07, s * 0.87), local(fr, 0, s * y, 0), WOOD_DARK);
  props.add(new BoxGeometry(s * 1.2, s * 0.05, s * 0.75), local(fr, 0, s * 0.82, 0), SNOW);
  // Stencil band.
  props.add(new BoxGeometry(s * 0.5, s * 0.12, s * 0.87), local(fr, 0, s * 0.42, 0), hex(0xc9302c));
  chunk.extend(it.x, it.y, it.z, s);
}

export function addBarrel(chunk: Chunk, it: Item): void {
  const fr = frame(it);
  const props = chunk.batch('props');
  const blue = hex(0x1d5fa8);
  props.add(new CylinderGeometry(0.29, 0.29, 0.62, 12), local(fr, 0, 0.31, 0), blue, PAINT_FX);
  for (const y of [0.15, 0.47]) props.add(new CylinderGeometry(0.3, 0.3, 0.035, 12), local(fr, 0, y, 0), hex(0x123a66), PAINT_FX);
  props.add(new CylinderGeometry(0.27, 0.29, 0.06, 12), local(fr, 0, 0.64, 0), SNOW);
  props.add(new CylinderGeometry(0.035, 0.035, 0.08, 6), local(fr, 0.12, 0.66, 0.08), hex(0x111111), METAL_FX);
  chunk.extend(it.x, it.y, it.z, 0.6);
}

// ------------------------------------------------- poles, masts, flags -----

export function addPole(chunk: Chunk, it: Item): void {
  const h = it.size;
  const fr = frame(it);
  const props = chunk.batch('props');
  const festoon = it.variant === 1;
  const color = festoon ? hex(0x3a2a1c) : BAMBOO;
  props.add(new CylinderGeometry(festoon ? 0.05 : 0.03, festoon ? 0.07 : 0.04, h + 0.3, 6), local(fr, 0, (h + 0.3) / 2, 0), color);
  props.add(new CylinderGeometry(0.06, 0.03, 0.05, 6), local(fr, 0, h + 0.3, 0), SNOW);
  chunk.extend(it.x, it.y + h / 2, it.z, h / 2 + 0.5);
}

export function addStake(chunk: Chunk, it: Item): void {
  const fr = frame(it);
  chunk.batch('props').add(new CylinderGeometry(0.025, 0.035, it.size + 0.3, 5), local(fr, 0, (it.size + 0.3) / 2, 0), WOOD_DARK);
  chunk.extend(it.x, it.y, it.z, 1);
}

/** Red-and-white striped mast (windsock and summit masts). */
export function addMast(chunk: Chunk, it: Item): void {
  const h = it.size + 0.4;
  const fr = frame(it);
  chunk.batch('props').add(new CylinderGeometry(0.045, 0.06, h, 8, 10), local(fr, 0, h / 2, 0), (_p, _n, out, l) => {
    const band = Math.floor((l.y / h + 0.5) * 10);
    out.copy(band % 2 ? WHITE : hex(0xd42a1e));
  }, PAINT_FX);
  chunk.extend(it.x, it.y + h / 2, it.z, h / 2 + 1);
}

/** A rectangular flag streaming downwind from a pole top (on the cloth batch). */
function streamer(chunk: Chunk, top: Vector3, w: number, h: number, color: Color, phase: number): void {
  const cloth = chunk.batch('cloth');
  const dx = WIND_DIR.x;
  const dz = WIND_DIR.z;
  const px = -dz;
  const pz = dx;
  const n = new Vector3(px, 0, pz);
  const fx = (t: number): Fx => [t, phase, px, pz];
  const a = [top.x, top.y, top.z];
  const b = [top.x + dx * w, top.y - 0.02, top.z + dz * w];
  const c = [b[0], b[1] - h, b[2]];
  const d = [a[0], a[1] - h, a[2]];
  cloth.vertex(a[0], a[1], a[2], n.x, n.y, n.z, color, fx(0));
  cloth.vertex(b[0], b[1], b[2], n.x, n.y, n.z, color, fx(1));
  cloth.vertex(c[0], c[1], c[2], n.x, n.y, n.z, color, fx(1));
  cloth.vertex(a[0], a[1], a[2], n.x, n.y, n.z, color, fx(0));
  cloth.vertex(c[0], c[1], c[2], n.x, n.y, n.z, color, fx(1));
  cloth.vertex(d[0], d[1], d[2], n.x, n.y, n.z, color, fx(0));
}

/** Bamboo marker wand (pushed into the snow) with a small flag. */
export function addWand(chunk: Chunk, it: Item): void {
  const h = it.size;
  const lean = 0.04;
  const fr = frame(it).multiply(new Matrix4().makeRotationX(lean * Math.cos(it.seed)).multiply(new Matrix4().makeRotationZ(lean * Math.sin(it.seed))));
  chunk.batch('props').add(new CylinderGeometry(0.011, 0.015, h, 5), local(fr, 0, h / 2, 0), BAMBOO);
  const top = pointIn(fr, 0, h - 0.02, 0);
  const color = it.variant === 2 ? new Color(1, 0.55, 0.02) : it.variant === 1 ? new Color(1, 0.1, 0.3) : new Color(1, 0.22, 0.03);
  streamer(chunk, top, 0.3, 0.2, color, it.seed * 1.3);
  chunk.extend(it.x, it.y + h / 2, it.z, h);
}

/** Survey marker: an aluminium tripod with a brass plate and a pennant. */
export function addMarker(chunk: Chunk, it: Item): void {
  if (it.variant !== 1) {
    addWand(chunk, it);
    return;
  }
  const fr = frame(it);
  const props = chunk.batch('props');
  const apex = pointIn(fr, 0, 1.45, 0);
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    const foot = pointIn(fr, Math.cos(a) * 0.45, -0.1, Math.sin(a) * 0.45);
    props.add(new CylinderGeometry(0.018, 0.018, 1, 5), segmentMatrix(foot, apex, new Matrix4()), STEEL, METAL_FX);
  }
  props.add(new CylinderGeometry(0.02, 0.02, 0.9, 6), local(fr, 0, 1.85, 0), STEEL, METAL_FX);
  props.add(new BoxGeometry(0.28, 0.2, 0.02), local(fr, 0, 1.25, 0.06), hex(0xc8a24a), [0, 0.9, 0.3, 0]);
  streamer(chunk, pointIn(fr, 0, 2.28, 0), 0.5, 0.32, hex(0xd42a1e), it.seed);
  chunk.extend(it.x, it.y + 1, it.z, 1.5);
}

export function addWindsock(chunk: Chunk, ws: Windsock): void {
  const top = new Vector3(ws.x, ws.y + ws.height + 0.3, ws.z);
  const props = chunk.batch('props');
  const cloth = chunk.batch('cloth');
  // Hoop and bracket.
  const dir = new Vector3(ws.dx, -0.18, ws.dz).normalize();
  const hoop = top.clone().addScaledVector(dir, 0.35);
  // lookAt(eye, target) aims local +Z from target to eye: +Z = downwind.
  const q = new Matrix4().lookAt(dir, new Vector3(), new Vector3(0, 1, 0));
  props.add(new TorusGeometry(0.3, 0.015, 4, 14), q.clone().setPosition(hoop), STEEL, METAL_FX);
  props.add(new CylinderGeometry(0.015, 0.015, 1, 4), segmentMatrix(top, hoop, new Matrix4()), STEEL, METAL_FX);
  // The sock: a striped cone streaming downwind.
  const len = 1.7;
  const sock = new CylinderGeometry(0.11, 0.3, len, 10, 5, true);
  const align = new Matrix4().makeRotationX(Math.PI / 2); // +Y -> +Z
  const m = q.clone().multiply(align).setPosition(hoop.clone().addScaledVector(dir, len / 2));
  const px = -ws.dz;
  const pz = ws.dx;
  cloth.add(sock, m, (_p, _n, out, l) => {
    const band = Math.floor((l.y / len + 0.5) * 5 + 1e-3);
    out.copy(band % 2 ? WHITE : ORANGE);
  }, (_p, _n, l, out) => {
    out[0] = Math.max(0, Math.min(1, l.y / len + 0.5));
    out[1] = 0.7;
    out[2] = px;
    out[3] = pz;
  });
  chunk.extend(ws.x, ws.y + ws.height / 2, ws.z, ws.height);
}

// ------------------------------------------------------ altar, cairns ------

export function addChorten(chunk: Chunk, it: Item): void {
  const fr = frame(it);
  const props = chunk.batch('props');
  const wash = new Color(0.86, 0.84, 0.78);
  const ochre = hex(0xb5652a);
  props.add(new BoxGeometry(2.0, 0.75, 2.0), local(fr, 0, 0.3, 0), wash);
  props.add(new BoxGeometry(1.55, 0.12, 1.55), local(fr, 0, 0.74, 0), ochre);
  props.add(new BoxGeometry(1.45, 0.6, 1.45), local(fr, 0, 1.08, 0), wash);
  props.add(new SphereGeometry(0.62, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2), local(fr, 0, 1.38, 0), wash);
  props.add(new CylinderGeometry(0.12, 0.2, 0.5, 8), local(fr, 0, 2.15, 0), hex(0xc8a24a), [0, 0.8, 0.35, 0]);
  // Offering ledge with juniper.
  props.add(new BoxGeometry(0.8, 0.1, 0.4), local(fr, 0, 0.72, 1.05), WOOD_DARK);
  props.add(new IcosahedronGeometry(0.16, 0), local(fr, 0, 0.84, 1.05, 1, 0.6, 1), hex(0x2c4a2a));
  // Snow on the ledges.
  props.add(new BoxGeometry(1.9, 0.06, 1.9), local(fr, 0, 0.7, 0), SNOW);
  props.add(new BoxGeometry(1.4, 0.06, 1.4), local(fr, 0, 1.39, 0), SNOW);
  // The mast the prayer flags radiate from.
  props.add(new CylinderGeometry(0.05, 0.08, 6.4, 6), local(fr, 0, 5.4, 0), WOOD_DARK);
  props.add(new SphereGeometry(0.1, 6, 4), local(fr, 0, 8.65, 0), hex(0xc8a24a), [0, 0.8, 0.35, 0]);
  chunk.extend(it.x, it.y + 4, it.z, 5);
}

/** A cairn of flat stacked stones (rock batch), topped by a little pennant. */
export function addCairn(chunk: Chunk, it: Item, pennant = true): void {
  const rand = mulberry32(Math.floor(it.seed * 977) + 3);
  const H = it.size;
  const rock = chunk.batch('rock');
  let y = it.y;
  const n = 6;
  let top = new Vector3(it.x, it.y, it.z);
  for (let k = 0; k < n; k++) {
    const r = (0.62 - k * 0.075) * (H / 1.25) * (0.9 + rand() * 0.2);
    const h = r * (0.42 + rand() * 0.15);
    const ox = (rand() - 0.5) * 0.08 * H;
    const oz = (rand() - 0.5) * 0.08 * H;
    const m = new Matrix4().makeRotationY(rand() * 6).scale(v1.set(r, h, r * (0.8 + rand() * 0.3)));
    m.setPosition(it.x + ox, y + h * 0.75, it.z + oz);
    rock.add(new IcosahedronGeometry(1, 1), m, WHITE);
    y += h * 1.45;
    top = new Vector3(it.x + ox, y, it.z + oz);
  }
  if (pennant) {
    const props = chunk.batch('props');
    props.add(new CylinderGeometry(0.012, 0.015, 0.9, 5), new Matrix4().setPosition(top.x, top.y + 0.35, top.z), BAMBOO);
    streamer(chunk, top.clone().setY(top.y + 0.78), 0.32, 0.22, new Color(1, 0.22, 0.03), it.seed);
  }
  chunk.extend(it.x, it.y + H / 2, it.z, H + 0.5);
}

export function addBench(chunk: Chunk, it: Item): void {
  const fr = frame(it);
  const bark = chunk.batch('bark');
  // The log lies along its local +Z (the bench's yaw).
  const m = fr.clone().multiply(new Matrix4().makeRotationX(Math.PI / 2).setPosition(0, 0.24, 0));
  bark.add(new CylinderGeometry(0.22, 0.24, it.size, 10), m, new Color(1, 1, 1), undefined, 1);
  chunk.batch('props').add(new BoxGeometry(0.3, 0.05, it.size * 0.9), local(fr, 0, 0.47, 0), SNOW);
  chunk.extend(it.x, it.y, it.z, it.size);
}

// --------------------------------------------------------------- signs -----

export function addSign(chunk: Chunk, spec: SignSpec, atlas: SignAtlas): void {
  const fr = frame(spec);
  const props = chunk.batch('props');
  const W = 1.5;
  const H = 0.375;
  const by = spec.boardY;
  for (const x of [-0.62, 0.62]) props.add(new BoxGeometry(0.09, by + H / 2 + 0.35, 0.09), local(fr, x, (by + H / 2 - 0.35) / 2 + 0.1, -0.06), WOOD_DARK);
  props.add(new BoxGeometry(W + 0.06, H + 0.06, 0.06), local(fr, 0, by, -0.005), WOOD);
  props.add(new BoxGeometry(W + 0.1, 0.06, 0.12), local(fr, 0, by + H / 2 + 0.05, -0.01), SNOW);
  const [u0, v0, u1, v1_] = atlas.rect(spec.lines);
  const face = new PlaneGeometry(W, H);
  const uv = face.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) < 0.5 ? u0 : u1, uv.getY(i) < 0.5 ? v0 : v1_);
  }
  chunk.batch('sign').add(face, local(fr, 0, by, 0.027), new Color(1, 1, 1));
  chunk.extend(spec.x, spec.y + 1, spec.z, 1.5);
}

// ----------------------------------------------------------- flag lines -----

function ropeBetween(chunk: Chunk, a: Vector3, b: Vector3, sag: number, color: Color, radius: number, segs: number): Vector3[] {
  const pts: Vector3[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    pts.push(new Vector3().lerpVectors(a, b, t).setY(a.y + (b.y - a.y) * t - sag * 4 * t * (1 - t)));
  }
  const props = chunk.batch('props');
  for (let i = 0; i < segs; i++) {
    props.add(new CylinderGeometry(radius, radius, 1, 4, 1, true), segmentMatrix(pts[i], pts[i + 1], new Matrix4()), color);
  }
  return pts;
}

/** A line of prayer flags hanging from a rope. */
export function addFlagLine(chunk: Chunk, line: Line): void {
  const a = new Vector3(line.a.x, line.a.y, line.a.z);
  const b = new Vector3(line.b.x, line.b.y, line.b.z);
  const len = a.distanceTo(b);
  ropeBetween(chunk, a, b, line.sag, ROPE, 0.008, Math.max(4, Math.round(len / 1.2)));
  const cloth = chunk.batch('cloth');
  const dx = (b.x - a.x) / len;
  const dz = (b.z - a.z) / len;
  // Flags flap perpendicular to the line.
  const px = -dz;
  const pz = dx;
  const count = Math.floor((len - 0.4) / 0.36);
  const at = (t: number) => new Vector3().lerpVectors(a, b, t).setY(a.y + (b.y - a.y) * t - line.sag * 4 * t * (1 - t));
  for (let k = 0; k < count; k++) {
    const t0 = (0.2 + k * 0.36) / len;
    const t1 = (0.2 + k * 0.36 + 0.27) / len;
    const p0 = at(t0);
    const p1 = at(t1);
    const color = LUNGTA[(k + line.seed) % LUNGTA.length];
    const fh = 0.3;
    const top: Fx = [0, line.seed * 3.1 + k * 0.7, px, pz];
    const bot: Fx = [1, line.seed * 3.1 + k * 0.7, px, pz];
    cloth.vertex(p0.x, p0.y - 0.01, p0.z, px, 0, pz, color, top);
    cloth.vertex(p1.x, p1.y - 0.01, p1.z, px, 0, pz, color, top);
    cloth.vertex(p1.x, p1.y - fh, p1.z, px, 0, pz, color, bot);
    cloth.vertex(p0.x, p0.y - 0.01, p0.z, px, 0, pz, color, top);
    cloth.vertex(p1.x, p1.y - fh, p1.z, px, 0, pz, color, bot);
    cloth.vertex(p0.x, p0.y - fh, p0.z, px, 0, pz, color, bot);
  }
  chunk.extend((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2, len / 2 + 1);
}

/** Festoon wire with coloured bulbs (bulbs are instanced). */
export function addFestoon(chunk: Chunk, line: Line, bulbGeometry: BufferGeometry): void {
  const a = new Vector3(line.a.x, line.a.y, line.a.z);
  const b = new Vector3(line.b.x, line.b.y, line.b.z);
  ropeBetween(chunk, a, b, line.sag, WIRE, 0.01, 12);
  const bulbs = chunk.inst('bulbs', bulbGeometry, null, bulbMaterial(), false, true);
  const count = 13;
  for (let k = 0; k < count; k++) {
    const t = (k + 0.5) / count;
    const p = new Vector3().lerpVectors(a, b, t).setY(a.y + (b.y - a.y) * t - line.sag * 4 * t * (1 - t) - 0.1);
    bulbs.push(p.x, p.y, p.z, IDENTITY_Q, 1, 1, 1, BULBS[(k + line.seed * 3) % BULBS.length]);
  }
  chunk.extend((a.x + b.x) / 2, a.y, (a.z + b.z) / 2, a.distanceTo(b) / 2 + 1);
}

const IDENTITY_Q = new Quaternion();

// --------------------------------------------------------------- decals ----

const TRAMPLED = new Color(0.74, 0.77, 0.84);
const PACKED = new Color(0.82, 0.86, 0.93);

/** Flat patches conforming to the ground, a few cm up. */
export function addDecal(chunk: Chunk, d: Decal): void {
  const b = chunk.batch('decal');
  const lift = 0.035;
  const put = (x: number, z: number, color: Color) => b.vertex(x, groundAt(x, z) + lift, z, 0, 1, 0, color);
  if (d.kind === 'trampled-ring') {
    const segs = 40;
    const rings = 4;
    for (let i = 0; i < segs; i++) {
      for (let j = 0; j < rings; j++) {
        const a0 = (i / segs) * Math.PI * 2;
        const a1 = ((i + 1) / segs) * Math.PI * 2;
        const r0 = d.a + ((d.b - d.a) * j) / rings;
        const r1 = d.a + ((d.b - d.a) * (j + 1)) / rings;
        const c = (r: number, a: number) => {
          const shade = 0.94 + 0.06 * valueNoise(Math.cos(a) * r * 0.7, Math.sin(a) * r * 0.7);
          const edge = Math.min(1, (d.b - r) / 1.2);
          return TRAMPLED.clone().multiplyScalar(shade).lerp(SNOW, 1 - edge);
        };
        const p = (r: number, a: number) => [d.x + Math.cos(a) * r, d.z + Math.sin(a) * r] as const;
        const [ax, az] = p(r0, a0);
        const [bx, bz] = p(r1, a0);
        const [cx, cz] = p(r1, a1);
        const [dx, dz] = p(r0, a1);
        // Counter-clockwise seen from above.
        put(ax, az, c(r0, a0));
        put(dx, dz, c(r0, a1));
        put(cx, cz, c(r1, a1));
        put(ax, az, c(r0, a0));
        put(cx, cz, c(r1, a1));
        put(bx, bz, c(r1, a0));
      }
    }
    chunk.extend(d.x, groundAt(d.x, d.z), d.z, d.b);
    return;
  }
  // Rectangles: a = half length (along yaw's +Z), b = half width.
  const fx = Math.sin(d.yaw);
  const fz = Math.cos(d.yaw);
  const sx = fz;
  const sz = -fx;
  const rect = (l0: number, l1: number, w0: number, w1: number, color: Color, steps: number) => {
    for (let i = 0; i < steps; i++) {
      const la = l0 + ((l1 - l0) * i) / steps;
      const lb = l0 + ((l1 - l0) * (i + 1)) / steps;
      const P = (l: number, w: number) => [d.x + fx * l + sx * w, d.z + fz * l + sz * w] as const;
      const [ax, az] = P(la, w0);
      const [bx, bz] = P(lb, w0);
      const [cx, cz] = P(lb, w1);
      const [ex, ez] = P(la, w1);
      // Orientation: make the quad face up whatever the handedness.
      const cross = (bx - ax) * (ez - az) - (bz - az) * (ex - ax);
      if (cross < 0) {
        put(ax, az, color);
        put(bx, bz, color);
        put(cx, cz, color);
        put(ax, az, color);
        put(cx, cz, color);
        put(ex, ez, color);
      } else {
        put(ax, az, color);
        put(cx, cz, color);
        put(bx, bz, color);
        put(ax, az, color);
        put(ex, ez, color);
        put(cx, cz, color);
      }
    }
  };
  if (d.kind === 'landing-cross') {
    rect(-d.a, d.a, -d.b, d.b, ORANGE, 8);
  } else {
    // Packed launch pad with orange edge lines and chevrons toward Base Camp.
    // Pad yaw faces -Z at yaw 0 (level convention), so "forward" is -(fx, fz).
    rect(-d.a, d.a, -d.b, d.b, PACKED, 9);
    rect(-d.a, d.a, d.b - 0.3, d.b, ORANGE, 9);
    rect(-d.a, d.a, -d.b, -d.b + 0.3, ORANGE, 9);
    for (let k = 0; k < 3; k++) {
      const tip = -(d.a * 0.6 - k * 2.2);
      for (const s of [-1, 1]) {
        // Stepped arms sweeping back from the tip: a chevron pointing forward.
        for (let j = 0; j < 4; j++) {
          const l = tip + j * 0.28;
          rect(l - 0.2, l + 0.2, s * (0.05 + j * 0.35), s * (0.4 + j * 0.35), ORANGE, 1);
        }
      }
    }
  }
  chunk.extend(d.x, groundAt(d.x, d.z), d.z, Math.hypot(d.a, d.b));
}
