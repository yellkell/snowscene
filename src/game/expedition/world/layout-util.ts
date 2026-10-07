/**
 * Shared helpers for laying out the expedition's world content. Pure math
 * (no Three.js) so placements can be node-checked against the terrain.
 *
 * Every placement is matched to `expeditionHeight`: objects with a
 * footprint sit at the lowest ground under it (`groundMin`) so nothing ever
 * floats, then sink a little so nothing looks perched.
 *
 * Layout functions are generators (`Gen<T>`) so the world system can spread
 * the terrain sampling over several frames; `drain()` runs one to the end.
 */

import { naturalHeight, expeditionHeight, expeditionSlope } from '../exp-terrain.js';
import {
  CAMPS,
  campCentre,
  CREVASSE_HALF_LENGTH,
  CREVASSE_S,
  RIVER_HALF_WIDTH,
  RIVER_S,
  routeFrame,
} from '../exp-layout.js';
import {
  ICE_WALL_R,
  project,
  type Projection,
  ROCK_BAND_R,
  SUMMIT_X,
  SUMMIT_Z,
} from '../exp-route.js';

/** Thin markers (wands, sign posts, cairns) stay at least this far from the centre line. */
export const MARKER_CLEAR = 4.0;
/** Everything else keeps the 10 m walking corridor clear. */
export const CORRIDOR_CLEAR = 5.0;

export type Gen<T> = Generator<void, T, unknown>;

/** Run a layout generator to completion. */
export function drain<T>(gen: Gen<T>): T {
  let r = gen.next();
  while (!r.done) r = gen.next();
  return r.value;
}

const scratch: Projection = { s: 0, d: 0, dist: 0, elev: 0 };

/** Distance from (x, z) to the nearest point of the route (Infinity if far). */
export function routeDistance(x: number, z: number): number {
  return project(x, z, scratch).dist;
}

/** Projection onto the route, copied into `out`. */
export function projectTo(x: number, z: number, out: Projection): Projection {
  project(x, z, scratch);
  out.s = scratch.s;
  out.d = scratch.d;
  out.dist = scratch.dist;
  out.elev = scratch.elev;
  return out;
}

export const groundAt = expeditionHeight;
export const slopeAt = expeditionSlope;

/** Lowest ground under a disc of radius r (centre plus a ring of 6 points). */
export function groundMin(x: number, z: number, r: number): number {
  let h = expeditionHeight(x, z);
  if (r <= 0) return h;
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + 0.3;
    h = Math.min(h, expeditionHeight(x + Math.cos(a) * r, z + Math.sin(a) * r));
  }
  return h;
}

/** Highest ground under a disc of radius r. */
export function groundMax(x: number, z: number, r: number): number {
  let h = expeditionHeight(x, z);
  if (r <= 0) return h;
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + 0.3;
    h = Math.max(h, expeditionHeight(x + Math.cos(a) * r, z + Math.sin(a) * r));
  }
  return h;
}

/** Distance from the summit axis. */
export function radiusAt(x: number, z: number): number {
  return Math.hypot(x - SUMMIT_X, z - SUMMIT_Z);
}

// ---------------------------------------------------------------- items ----

export type ItemKind =
  | 'tree'
  | 'boulder'
  | 'serac'
  | 'tent'
  | 'mess-tent'
  | 'crate'
  | 'barrel'
  | 'cairn'
  | 'sign'
  | 'wand'
  | 'pole'
  | 'fire'
  | 'chorten'
  | 'bench'
  | 'mast'
  | 'stake'
  | 'marker';

/** Kinds that are thin enough to stand at the edge of the bench. */
export const MARKER_KINDS: ReadonlySet<ItemKind> = new Set<ItemKind>(['wand', 'sign', 'cairn', 'stake', 'marker']);

/** One placed object. `y` is the height of its origin (its base). */
export interface Item {
  kind: ItemKind;
  x: number;
  y: number;
  z: number;
  /** Footprint radius (for spacing, corridor and ground checks). */
  r: number;
  yaw: number;
  /** Kind-specific size (tree height, boulder radius, tent scale...). */
  size: number;
  seed: number;
  /** Optional palette index or variant. */
  variant?: number;
}

/** Radius over which an item's base must sit on the ground (trees: the trunk). */
export function baseRadius(kind: ItemKind, r: number): number {
  return kind === 'tree' ? 0.8 : r * 0.8;
}

export function item(
  kind: ItemKind,
  x: number,
  z: number,
  r: number,
  yaw: number,
  size: number,
  seed: number,
  sink = 0,
  variant?: number,
): Item {
  return { kind, x, y: groundMin(x, z, baseRadius(kind, r)) - sink, z, r, yaw, size, seed, variant };
}

/** Clearance from the route centre line minus the footprint (>= limit to be clear). */
export function routeClearance(x: number, z: number, r: number): number {
  return routeDistance(x, z) - r;
}

export function clearOfCorridor(x: number, z: number, r: number, limit = CORRIDOR_CLEAR): boolean {
  return routeClearance(x, z, r) >= limit;
}

// ------------------------------------------------------- spacing grid ----

/** Spatial hash for keeping scattered objects apart. */
export class SpacingGrid {
  private readonly cells = new Map<number, number[]>();
  constructor(private readonly cell = 16) {}

  private key(cx: number, cz: number): number {
    return (cx + 50000) * 100003 + (cz + 50000);
  }

  /** True if a disc of radius r at (x, z) keeps `gap` x (r + other r) from all others. */
  fits(x: number, z: number, r: number, gap = 1): boolean {
    const reach = Math.ceil((r * 2 + 12) / this.cell);
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    for (let i = cx - reach; i <= cx + reach; i++) {
      for (let j = cz - reach; j <= cz + reach; j++) {
        const list = this.cells.get(this.key(i, j));
        if (!list) continue;
        for (let k = 0; k < list.length; k += 3) {
          const dx = list[k] - x;
          const dz = list[k + 1] - z;
          const min = (list[k + 2] + r) * gap;
          if (dx * dx + dz * dz < min * min) return false;
        }
      }
    }
    return true;
  }

  add(x: number, z: number, r: number): void {
    const k = this.key(Math.floor(x / this.cell), Math.floor(z / this.cell));
    let list = this.cells.get(k);
    if (!list) {
      list = [];
      this.cells.set(k, list);
    }
    list.push(x, z, r);
  }
}

// -------------------------------------------------------- exclusions -----

const campCentres = CAMPS.map((camp) => ({ camp, ...campCentre(camp) }));

/** Inside a camp's flattened pad (plus margin)? */
export function inCamp(x: number, z: number, margin = 0): boolean {
  for (const c of campCentres) {
    const rr = c.camp.radius + margin;
    const dx = x - c.x;
    const dz = z - c.z;
    if (dx * dx + dz * dz < rr * rr) return true;
  }
  return false;
}

const river = routeFrame(RIVER_S);

/** Local river coordinates: `across` (along the route) and `along` (downstream axis). */
export function riverLocal(x: number, z: number): { across: number; along: number } {
  const dx = x - river.x;
  const dz = z - river.z;
  return { across: dx * river.tx + dz * river.tz, along: dx * river.nx + dz * river.nz };
}

/** In or beside the carved river channel. */
export function inRiver(x: number, z: number, margin = 0): boolean {
  const l = riverLocal(x, z);
  return Math.abs(l.across) < RIVER_HALF_WIDTH + 8 + margin && Math.abs(l.along) < 920;
}

const crevasse = routeFrame(CREVASSE_S);

/** In or beside the crevasse slot. */
export function nearCrevasse(x: number, z: number, margin = 0): boolean {
  const dx = x - crevasse.x;
  const dz = z - crevasse.z;
  const across = dx * crevasse.tx + dz * crevasse.tz;
  const along = dx * crevasse.nx + dz * crevasse.nz;
  return Math.abs(across) < 3 + margin && Math.abs(along) < CREVASSE_HALF_LENGTH + 2 + margin;
}

/** Near one of the two cliff bands (their 80 degree slopes are no place for props). */
export function nearBand(x: number, z: number, margin = 10): boolean {
  const r = radiusAt(x, z);
  return Math.abs(r - ICE_WALL_R) < margin || Math.abs(r - ROCK_BAND_R) < margin;
}

// --------------------------------------------------------- fall lines -----

const fallScratch: Projection = { s: 0, d: 0, dist: 0, elev: 0 };

function natural(x: number, z: number): number {
  project(x, z, fallScratch);
  return naturalHeight(x, z, fallScratch.dist);
}

/**
 * Fall line from (x, z): +1 climbs, -1 descends. Mirrors
 * `fx/fx-layout.ts` traceFallLine so the avalanche and rockfall tracks the
 * events agent animates are exactly the strips this module keeps clear.
 */
export function traceFallLine(
  x: number,
  z: number,
  sign: number,
  count: number,
  step: number,
  radialWeight = 0.55,
): { x: number[]; z: number[] } {
  const xs = [x];
  const zs = [z];
  let px = x;
  let pz = z;
  let dx = 0;
  let dz = 0;
  const e = 12;
  for (let i = 1; i < count; i++) {
    const gx = (natural(px + e, pz) - natural(px - e, pz)) / (2 * e);
    const gz = (natural(px, pz + e) - natural(px, pz - e)) / (2 * e);
    const gl = Math.hypot(gx, gz) || 1;
    const r = Math.hypot(px - SUMMIT_X, pz - SUMMIT_Z) || 1;
    const rx = -(px - SUMMIT_X) / r;
    const rz = -(pz - SUMMIT_Z) / r;
    let nx = (1 - radialWeight) * (gx / gl) + radialWeight * rx;
    let nz = (1 - radialWeight) * (gz / gl) + radialWeight * rz;
    nx *= sign;
    nz *= sign;
    if (i > 1) {
      nx = 0.75 * dx + 0.25 * nx;
      nz = 0.75 * dz + 0.25 * nz;
    }
    const nl = Math.hypot(nx, nz) || 1;
    dx = nx / nl;
    dz = nz / nl;
    px += dx * step;
    pz += dz * step;
    xs.push(px);
    zs.push(pz);
  }
  return { x: xs, z: zs };
}

/** A polyline strip (centre line plus half width) kept free of props. */
export interface Strip {
  x: number[];
  z: number[];
  halfWidth: number;
}

/** Strip from `up` metres above a route point down its fall line to `down` metres below. */
export function fallStrip(s: number, up: number, down: number, halfWidth: number): Strip {
  const f = routeFrame(s);
  const step = 4;
  const nUp = Math.round(up / step);
  const nDown = Math.round(down / step);
  const a = traceFallLine(f.x, f.z, 1, nUp + 1, step);
  const b = traceFallLine(f.x, f.z, -1, nDown + 1, step);
  const x: number[] = [];
  const z: number[] = [];
  for (let i = nUp; i >= 0; i--) {
    x.push(a.x[i]);
    z.push(a.z[i]);
  }
  for (let i = 1; i <= nDown; i++) {
    x.push(b.x[i]);
    z.push(b.z[i]);
  }
  return { x, z, halfWidth };
}

/** Distance from (x, z) to a strip's centre line. */
export function stripDistance(strip: Strip, x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < strip.x.length - 1; i++) {
    const ax = strip.x[i];
    const az = strip.z[i];
    const ex = strip.x[i + 1] - ax;
    const ez = strip.z[i + 1] - az;
    const l2 = ex * ex + ez * ez || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2));
    const px = ax + ex * t - x;
    const pz = az + ez * t - z;
    best = Math.min(best, px * px + pz * pz);
  }
  return Math.sqrt(best);
}

export function inStrip(strip: Strip, x: number, z: number, margin = 0): boolean {
  return stripDistance(strip, x, z) < strip.halfWidth + margin;
}

// ------------------------------------------------------------- misc ------

/** Yaw (rotation.y) that turns local +Z toward the horizontal direction (dx, dz). */
export function yawToward(dx: number, dz: number): number {
  return Math.atan2(dx, dz);
}

/** Catenary-ish sag: height offset at parameter t in [0, 1]. */
export function sag(t: number, amount: number): number {
  return -amount * 4 * t * (1 - t);
}
