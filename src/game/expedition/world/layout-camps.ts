/**
 * Camps and the summit: Base Camp's party (bonfire, partygoers, festoon
 * lights, mess tent, puja altar with prayer flags, the glider landing zone
 * and supply depot), the four small camps up the mountain, and the summit
 * cairn, marker and launch pad. Pure layout (no Three.js).
 *
 * Camps use a local frame: `u` along the route at the camp, `v` from the
 * route toward the camp centre (the route runs along v = -offset).
 */

import { mulberry32 } from '../../terrain.js';
import { type Camp, CAMPS, campCentre, routeFrame, SUMMIT_S } from '../exp-layout.js';
import { route, routePoint } from '../exp-route.js';
import { CHUTE_HALF, chuteDistance } from '../slide/chute-path.js';
import { campSignLines, signBeside, type SignSpec } from './layout-route.js';
import {
  CORRIDOR_CLEAR,
  type Gen,
  groundAt,
  groundMin,
  type Item,
  item,
  type ItemKind,
  MARKER_CLEAR,
  MARKER_KINDS,
  routeClearance,
  slopeAt,
} from './layout-util.js';

export interface P3 {
  x: number;
  y: number;
  z: number;
}

/** A line of prayer flags (or a festoon wire) between two points. */
export interface Line {
  a: P3;
  b: P3;
  /** Mid-span sag (m). */
  sag: number;
  seed: number;
}

export interface DancerSpec {
  x: number;
  y: number;
  z: number;
  yaw: number;
  phase: number;
  speed: number;
  /** 0 = dancing round the fire, 1 = waving gliders in. */
  mode: number;
  look: number;
}

/** A flat patch on the snow (trampled snow, landing cross, launch pad). */
export interface Decal {
  kind: 'trampled-ring' | 'landing-cross' | 'launch-pad';
  x: number;
  z: number;
  yaw: number;
  /** Ring: inner/outer radius. Cross/pad: half length / half width. */
  a: number;
  b: number;
}

export interface Windsock {
  x: number;
  y: number;
  z: number;
  height: number;
  /** Direction the sock streams toward (unit, horizontal). */
  dx: number;
  dz: number;
}

export interface CampLayout {
  index: number;
  camp: Camp;
  centre: P3;
  fire: P3 & { scale: number; approachYaw: number };
  items: Item[];
  flagLines: Line[];
  festoon: Line[];
  dancers: DancerSpec[];
  decals: Decal[];
  windsocks: Windsock[];
  signs: SignSpec[];
}

/** Wind streams from the summit down the mountain (unit vector, +Z ~ south). */
export const WIND_DIR = { x: 0.08, z: 0.997 };

// ------------------------------------------------------------- frames -----

interface Frame {
  cx: number;
  cz: number;
  ux: number;
  uz: number;
  vx: number;
  vz: number;
}

function campFrame(camp: Camp): Frame {
  const f = routeFrame(camp.s);
  const c = campCentre(camp);
  const side = camp.side || 1;
  return { cx: c.x, cz: c.z, ux: f.tx, uz: f.tz, vx: f.nx * side, vz: f.nz * side };
}

function at(fr: Frame, u: number, v: number): { x: number; z: number } {
  return { x: fr.cx + fr.ux * u + fr.vx * v, z: fr.cz + fr.uz * u + fr.vz * v };
}

/** Yaw that turns local +Z toward the local direction (du, dv). */
function yawLocal(fr: Frame, du: number, dv: number): number {
  return Math.atan2(fr.ux * du + fr.vx * dv, fr.uz * du + fr.vz * dv);
}

function fits(x: number, z: number, r: number, kind: ItemKind): boolean {
  const limit = MARKER_KINDS.has(kind) ? MARKER_CLEAR : CORRIDOR_CLEAR;
  return routeClearance(x, z, r) >= limit;
}

function top(it: Item, h: number): P3 {
  return { x: it.x, y: it.y + h, z: it.z };
}

// ----------------------------------------------------------- base camp -----

/** Base Camp's glider landing zone (the finale glide should end here). */
export interface LandingZone {
  x: number;
  y: number;
  z: number;
  radius: number;
  /** Yaw a glider flying in from the summit faces when it lands (yaw 0 = -Z). */
  yaw: number;
}

const BASE = CAMPS[0];
const baseFrame = campFrame(BASE);
const LANDING_V = 25;

export const BASE_CAMP_FIRE: P3 = (() => {
  const c = campCentre(BASE);
  return { x: c.x, y: groundAt(c.x, c.z), z: c.z };
})();

export const BASE_CAMP_LANDING: LandingZone = (() => {
  const p = at(baseFrame, 0, LANDING_V);
  // Fly in from the summit side (+v), i.e. facing -v.
  const dx = -baseFrame.vx;
  const dz = -baseFrame.vz;
  return { x: p.x, y: groundAt(p.x, p.z), z: p.z, radius: 9.5, yaw: Math.atan2(-dx, -dz) };
})();

function baseCamp(): CampLayout {
  const fr = baseFrame;
  const rand = mulberry32(2024);
  const items: Item[] = [];
  const flagLines: Line[] = [];
  const festoon: Line[] = [];
  const dancers: DancerSpec[] = [];
  const decals: Decal[] = [];
  const windsocks: Windsock[] = [];
  let seed = 0;
  const put = (kind: ItemKind, u: number, v: number, r: number, yaw: number, size: number, sink = 0, variant?: number) => {
    const p = at(fr, u, v);
    if (!fits(p.x, p.z, r, kind)) return null;
    const it = item(kind, p.x, p.z, r, yaw, size, seed++, sink, variant);
    items.push(it);
    return it;
  };
  const fireScale = BASE.fireScale;
  const approachYaw = Math.atan2(-fr.vz, -fr.vx); // Bonfire convention: angle in the XZ plane
  const fire = { ...BASE_CAMP_FIRE, scale: fireScale, approachYaw };
  items.push(item('fire', fire.x, fire.z, 3.7 * fireScale, 0, fireScale, seed++));
  decals.push({ kind: 'trampled-ring', x: fire.x, z: fire.z, yaw: 0, a: 3.9 * fireScale, b: 12.2 });

  // Partygoers dancing in a loose ring round the fire.
  const count = 26;
  for (let i = 0; i < count; i++) {
    const ang = (i / count) * Math.PI * 2 + (rand() - 0.5) * 0.18;
    const r = 7.4 + rand() * 3.2;
    const p = at(fr, Math.cos(ang) * r, Math.sin(ang) * r);
    dancers.push({
      x: p.x,
      y: groundAt(p.x, p.z),
      z: p.z,
      yaw: yawLocal(fr, -Math.cos(ang), -Math.sin(ang)),
      phase: rand() * 20,
      speed: 2.2 + rand() * 1.4,
      mode: 0,
      look: i,
    });
  }

  // Festoon lights swagged between a ring of poles.
  const poles = 12;
  const poleR = 14.5;
  const poleH = 4.6;
  const ring: Item[] = [];
  for (let i = 0; i < poles; i++) {
    const ang = (i / poles) * Math.PI * 2 + 0.13;
    const it = put('pole', Math.cos(ang) * poleR, Math.sin(ang) * poleR, 0.1, 0, poleH, 0.3, 1);
    if (it) ring.push(it);
  }
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    festoon.push({ a: top(a, poleH - 0.45), b: top(b, poleH - 0.45), sag: 0.85, seed: i });
  }
  // A few log benches outside the dancers.
  for (let i = 0; i < 5; i++) {
    const ang = Math.PI * (0.35 + i * 0.32);
    put('bench', Math.cos(ang) * 12, Math.sin(ang) * 12, 1.5, yawLocal(fr, -Math.sin(ang), Math.cos(ang)), 2.8);
  }

  // Expedition tents in two clusters either side; the mess tent to the west.
  const tentSpots: Array<[number, number]> = [
    [22, -7],
    [28, 0],
    [22.5, 7],
    [30, 9.5],
    [24.5, 16.5],
    [-21, -8],
    [-21.5, 15.5],
    [-29.5, 12],
    [16, -11],
  ];
  tentSpots.forEach(([u, v], i) => {
    put('tent', u, v, 1.9, yawLocal(fr, -u, -v) + (rand() - 0.5) * 0.5, 1.15 + rand() * 0.2, 0.05, i);
  });
  // Mess tent: its door (local +X) faces the fire.
  put('mess-tent', -26, 2, 4.8, Math.atan2(-fr.uz, fr.ux), 1, 0.05);
  // Supply depot by the mess tent: crates and blue barrels.
  const depot: Array<[number, number, ItemKind]> = [
    [-17.5, -8.5, 'crate'],
    [-16.4, -9.4, 'crate'],
    [-16.9, -7.2, 'crate'],
    [-18.6, -10.3, 'barrel'],
    [-15.2, -7.6, 'barrel'],
    [-19.5, -9.0, 'barrel'],
    [-14.6, -10.6, 'crate'],
    [-20.6, -4.6, 'crate'],
    [17.5, 2.5, 'crate'],
    [18.2, 3.6, 'barrel'],
  ];
  for (const [u, v, kind] of depot) {
    put(kind, u, v, kind === 'crate' ? 0.5 : 0.35, rand() * Math.PI, kind === 'crate' ? 0.6 + rand() * 0.25 : 0.62, 0.04, Math.floor(rand() * 4));
  }

  // Puja altar (chorten) with prayer flags radiating from its mast.
  const chorten = put('chorten', -20, 29, 1.6, yawLocal(fr, 1, -1), 1, 0.15);
  if (chorten) {
    const mastTop = top(chorten, 8.2);
    for (let k = 0; k < 6; k++) {
      const ang = Math.PI * (0.55 + k * 0.29);
      const su = -20 + Math.cos(ang) * 12;
      const sv = 29 + Math.sin(ang) * 12;
      const stake = put('stake', su, sv, 0.08, 0, 0.9, 0.3);
      if (stake) flagLines.push({ a: mastTop, b: top(stake, 0.6), sag: 0.7, seed: 10 + k });
    }
  }
  // A long welcome line of flags facing the route.
  const p1 = put('pole', -9, -12.5, 0.1, 0, 4.2, 0.3, 0);
  const p2 = put('pole', 9, -12.5, 0.1, 0, 4.2, 0.3, 0);
  if (p1 && p2) flagLines.push({ a: top(p1, 4.0), b: top(p2, 4.0), sag: 0.9, seed: 3 });

  // Glider landing zone toward the summit: a big orange cross ringed by flags.
  const lz = BASE_CAMP_LANDING;
  decals.push({ kind: 'landing-cross', x: lz.x, z: lz.z, yaw: yawLocal(fr, 1, 1), a: 5.5, b: 0.45 });
  decals.push({ kind: 'landing-cross', x: lz.x, z: lz.z, yaw: yawLocal(fr, 1, -1), a: 5.5, b: 0.45 });
  for (let k = 0; k < 14; k++) {
    const ang = (k / 14) * Math.PI * 2;
    put('marker', Math.cos(ang) * lz.radius, LANDING_V + Math.sin(ang) * lz.radius, 0.05, rand() * 6, 1.4, 0.25, 2);
  }
  const sockPos = at(fr, 14, LANDING_V + 7);
  const sockMast = put('mast', 14, LANDING_V + 7, 0.12, 0, 6, 0.4);
  if (sockMast) windsocks.push({ x: sockPos.x, y: sockMast.y, z: sockPos.z, height: 6, dx: WIND_DIR.x, dz: WIND_DIR.z });
  // A welcoming committee waving gliders in.
  const wavers: Array<[number, number]> = [
    [-11.5, 21],
    [-12.5, 26.5],
    [11.5, 20],
    [12.2, 26],
    [-10.5, 31],
  ];
  for (const [u, v] of wavers) {
    const p = at(fr, u, v);
    dancers.push({
      x: p.x,
      y: groundAt(p.x, p.z),
      z: p.z,
      yaw: yawLocal(fr, (0 - u) * 0.4, LANDING_V + 12 - v),
      phase: rand() * 20,
      speed: 1.6 + rand() * 0.6,
      mode: 1,
      look: dancers.length,
    });
  }

  const signs: SignSpec[] = [];
  const sign = signBeside(BASE.s - 20, campSignLines(0), 5.4, BASE.side);
  if (sign) signs.push(sign);
  const lzSign = at(fr, -6, LANDING_V - 11.5);
  signs.push({
    x: lzSign.x,
    y: groundMin(lzSign.x, lzSign.z, 0.3),
    z: lzSign.z,
    yaw: yawLocal(fr, 0.3, 1),
    lines: ['LANDING ZONE', 'Gliders from the summit  ·  welcome home'],
    boardY: 1.45,
  });

  return {
    index: 0,
    camp: BASE,
    centre: { x: fr.cx, y: groundAt(fr.cx, fr.cz), z: fr.cz },
    fire,
    items,
    flagLines,
    festoon,
    dancers,
    decals,
    windsocks,
    signs,
  };
}

// --------------------------------------------------------- small camps -----

const TENT_COUNT = [0, 3, 4, 3, 2];
/** Candidate tent directions around the fire (radians from +u toward +v). */
const TENT_ANGLES = [Math.PI / 2, 0.75, Math.PI - 0.75, 0.05, Math.PI - 0.05, 1.2, Math.PI - 1.2, -0.45, Math.PI + 0.45];

function smallCamp(index: number): CampLayout {
  const camp = CAMPS[index];
  const fr = campFrame(camp);
  const rand = mulberry32(300 + index * 17);
  const items: Item[] = [];
  const flagLines: Line[] = [];
  let seed = index * 100;
  const put = (kind: ItemKind, u: number, v: number, r: number, yaw: number, size: number, sink = 0, variant?: number) => {
    const p = at(fr, u, v);
    if (!fits(p.x, p.z, r, kind)) return null;
    if (Math.hypot(u, v) + r > camp.radius + 3) return null;
    const it = item(kind, p.x, p.z, r, yaw, size, seed++, sink, variant);
    items.push(it);
    return it;
  };
  const fireV = 1.5;
  const fp = at(fr, 0, fireV);
  const fire = {
    x: fp.x,
    y: groundAt(fp.x, fp.z),
    z: fp.z,
    scale: camp.fireScale,
    approachYaw: Math.atan2(-fr.vz, -fr.vx),
  };
  items.push(item('fire', fp.x, fp.z, 3.7 * camp.fireScale, 0, camp.fireScale, seed++));

  let tents = 0;
  for (const ang of TENT_ANGLES) {
    if (tents >= TENT_COUNT[index]) break;
    const r = 5.4 + rand() * 0.8;
    const u = Math.cos(ang) * r;
    const v = fireV + Math.sin(ang) * r;
    const t = put('tent', u, v, 1.9, yawLocal(fr, -Math.cos(ang), -Math.sin(ang)), 1.0 + rand() * 0.15, 0.05, index * 3 + tents);
    if (t) tents++;
  }
  // A few crates and a barrel by the fire.
  for (let k = 0; k < 3; k++) {
    const ang = 0.4 + k * 0.5 + rand() * 0.2;
    const kind: ItemKind = k === 2 ? 'barrel' : 'crate';
    put(kind, -Math.cos(ang) * 3.2 - 1, fireV - Math.sin(ang) * 2.4, kind === 'crate' ? 0.45 : 0.35, rand() * 3, kind === 'crate' ? 0.55 + rand() * 0.2 : 0.62, 0.04, Math.floor(rand() * 4));
  }
  // Prayer flags strung between two poles behind the tents.
  const R = camp.radius;
  const pa = put('pole', -R * 0.62, R * 0.5, 0.1, 0, 3.4, 0.3, 0);
  const pb = put('pole', R * 0.62, R * 0.5, 0.1, 0, 3.4, 0.3, 0);
  if (pa && pb) flagLines.push({ a: top(pa, 3.3), b: top(pb, 3.3), sag: 0.6, seed: index * 7 });
  // A cairn at the camp's edge with a short line of flags to it.
  const cairn = put('cairn', -R * 0.62, -R * 0.12, 0.8, rand() * 6, 1.15, 0.1);
  if (cairn && pa) flagLines.push({ a: top(pa, 3.3), b: top(cairn, 1.05), sag: 0.25, seed: index * 7 + 1 });

  const signs: SignSpec[] = [];
  const sign = signBeside(camp.s - 12, campSignLines(index), 5.0, camp.side);
  if (sign) signs.push(sign);

  return {
    index,
    camp,
    centre: { x: fr.cx, y: groundAt(fr.cx, fr.cz), z: fr.cz },
    fire,
    items,
    flagLines,
    festoon: [],
    dancers: [],
    decals: [{ kind: 'trampled-ring', x: fire.x, z: fire.z, yaw: 0, a: 3.75 * camp.fireScale, b: 4.4 }],
    windsocks: [],
    signs,
  };
}

export function* campLayouts(): Gen<CampLayout[]> {
  const out: CampLayout[] = [baseCamp()];
  yield;
  for (let i = 1; i < CAMPS.length; i++) {
    out.push(smallCamp(i));
    yield;
  }
  return out;
}

export function campLayout(index: number): CampLayout {
  return index === 0 ? baseCamp() : smallCamp(index);
}

// ------------------------------------------------------------- summit -----

/** The glider launch on the summit (suggested `level.launch()` site). */
export interface LaunchPad {
  x: number;
  z: number;
  floorY: number;
  /** World yaw to face for take-off (yaw 0 faces -Z): toward Base Camp. */
  yaw: number;
  halfLength: number;
  halfWidth: number;
}

export const LAUNCH_PAD: LaunchPad = (() => {
  const p = routePoint(route.length - 7);
  const dx = BASE_CAMP_LANDING.x - p.x;
  const dz = BASE_CAMP_LANDING.z - p.z;
  const l = Math.hypot(dx, dz) || 1;
  return { x: p.x, z: p.z, floorY: groundAt(p.x, p.z), yaw: Math.atan2(-dx / l, -dz / l), halfLength: 9, halfWidth: 5.5 };
})();

export interface SummitLayout {
  items: Item[];
  flagLines: Line[];
  decals: Decal[];
  windsocks: Windsock[];
  signs: SignSpec[];
  cairn: Item;
  launch: LaunchPad;
}

export function* summitLayout(): Gen<SummitLayout> {
  const rand = mulberry32(7788);
  const items: Item[] = [];
  const flagLines: Line[] = [];
  const decals: Decal[] = [];
  const windsocks: Windsock[] = [];
  const signs: SignSpec[] = [];
  const end = routePoint(route.length);
  const f = routeFrame(route.length - 6);
  // The summit cairn stands just past the end of the trail.
  let cairn: Item | null = null;
  for (let d = 7.5; d < 20 && !cairn; d += 0.5) {
    const x = end.x + f.tx * d;
    const z = end.z + f.tz * d;
    if (routeClearance(x, z, 1.3) < CORRIDOR_CLEAR || slopeAt(x, z) > 0.5) continue;
    cairn = item('cairn', x, z, 1.3, 0.4, 2.1, 7001, 0.15);
  }
  if (!cairn) cairn = item('cairn', end.x + f.tx * 12, end.z + f.tz * 12, 1.3, 0.4, 2.1, 7001, 0.15);
  items.push(cairn);
  const mastTop = { x: cairn.x, y: cairn.y + 4.6, z: cairn.z };
  items.push({ ...cairn, kind: 'pole', r: 0.08, size: 4.6, seed: 7002, variant: 1 });
  yield;
  for (let k = 0; k < 6; k++) {
    // Radiate away from the trail (forward half-plane).
    const ang = Math.atan2(f.tz, f.tx) + (k / 5 - 0.5) * Math.PI * 1.25;
    const x = cairn.x + Math.cos(ang) * 9;
    const z = cairn.z + Math.sin(ang) * 9;
    if (routeClearance(x, z, 0.1) < MARKER_CLEAR) continue;
    const stake = item('stake', x, z, 0.08, 0, 0.9, 7010 + k, 0.3);
    items.push(stake);
    flagLines.push({ a: mastTop, b: { x, y: stake.y + 0.6, z }, sag: 0.55, seed: 70 + k });
  }
  // The summit marker beside the trail at SUMMIT_S.
  const mark = signBeside(SUMMIT_S - 3, ['THE SUMMIT', '1,300 m above Base Camp  ·  7.8 km walked'], 4.7);
  if (mark) signs.push(mark);
  const mf = routeFrame(SUMMIT_S);
  const side = mark ? -Math.sign((mark.x - mf.x) * mf.nx + (mark.z - mf.z) * mf.nz) || 1 : 1;
  const tx = mf.x + mf.nx * side * 4.6;
  const tz = mf.z + mf.nz * side * 4.6;
  if (routeClearance(tx, tz, 0.45) >= MARKER_CLEAR) items.push(item('marker', tx, tz, 0.45, rand() * 6, 1.6, 7020, 0.05, 1));
  yield;

  // Launch pad: packed snow, orange edge flags and a windsock.
  const lp = LAUNCH_PAD;
  decals.push({ kind: 'launch-pad', x: lp.x, z: lp.z, yaw: lp.yaw, a: lp.halfLength, b: lp.halfWidth });
  const fx = -Math.sin(lp.yaw);
  const fz = -Math.cos(lp.yaw);
  const sx = -fz;
  const sz = fx;
  for (let k = 0; k < 5; k++) {
    const along = -lp.halfLength + (k / 4) * lp.halfLength * 2;
    for (const s of [-1, 1]) {
      const x = lp.x + fx * along + sx * s * (lp.halfWidth + 0.4);
      const z = lp.z + fz * along + sz * s * (lp.halfWidth + 0.4);
      if (routeClearance(x, z, 0.05) < MARKER_CLEAR) continue;
      items.push(item('marker', x, z, 0.05, rand() * 6, 1.3, 7030 + k * 2 + (s > 0 ? 1 : 0), 0.25, 2));
    }
  }
  for (const s of [1, -1]) {
    const x = lp.x - fx * (lp.halfLength - 2) + sx * s * (lp.halfWidth + 3.2);
    const z = lp.z - fz * (lp.halfLength - 2) + sz * s * (lp.halfWidth + 3.2);
    if (routeClearance(x, z, 0.15) < CORRIDOR_CLEAR) continue;
    const mast = item('mast', x, z, 0.12, 0, 5, 7050, 0.4);
    items.push(mast);
    windsocks.push({ x, y: mast.y, z, height: 5, dx: WIND_DIR.x, dz: WIND_DIR.z });
    break;
  }
  for (const s of [1, -1]) {
    const x = lp.x - fx * (lp.halfLength + 1.5) + sx * s * 3.5;
    const z = lp.z - fz * (lp.halfLength + 1.5) + sz * s * 3.5;
    if (routeClearance(x, z, 0.7) < MARKER_CLEAR) continue;
    signs.push({
      x,
      y: groundMin(x, z, 0.3),
      z,
      yaw: lp.yaw + Math.PI,
      lines: ['THE SUMMIT CHUTE', 'Ride down to the ice cliff  ·  then fly to Base Camp'],
      boardY: 1.45,
    });
    break;
  }
  // Scattered summit rocks.
  for (let i = 0; i < 40 && items.length < 80; i++) {
    const ang = rand() * Math.PI * 2;
    const d = 7 + rand() * 45;
    const x = end.x + Math.cos(ang) * d;
    const z = end.z + Math.sin(ang) * d;
    const size = 0.25 + rand() * rand() * 1.4;
    if (routeClearance(x, z, size) < CORRIDOR_CLEAR + 0.5) continue;
    const lx = x - lp.x;
    const lz = z - lp.z;
    if (Math.abs(lx * fx + lz * fz) < lp.halfLength + 3 && Math.abs(lx * sx + lz * sz) < lp.halfWidth + 3) continue;
    if (Math.hypot(x - cairn.x, z - cairn.z) < 10) continue;
    if (chuteDistance(x, z) < CHUTE_HALF + 3 + size) continue;
    items.push(item('boulder', x, z, size, rand() * 6, size, 7100 + i, size * 0.35));
  }
  return { items, flagLines, decals, windsocks, signs, cairn, launch: lp };
}
