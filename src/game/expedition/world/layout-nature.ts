/**
 * Natural scatter: the spruce forest, boulder meadows and moraine fields,
 * ridge outcrops, the glacier's seracs and blue ice seams, and the serac
 * that collapses. Pure layout (no Three.js).
 */

import { mulberry32, valueNoise } from '../../terrain.js';
import {
  AVALANCHE,
  outwardSide,
  ROCKFALL,
  ROPE_END_S,
  ROPE_START_S,
  routeFrame,
  SERAC,
  SERAC_FIELD,
} from '../exp-layout.js';
import { route, smoothstep, SUMMIT_X, SUMMIT_Z } from '../exp-route.js';
import {
  baseRadius,
  CORRIDOR_CLEAR,
  fallStrip,
  type Gen,
  groundAt,
  groundMax,
  groundMin,
  inCamp,
  inRiver,
  inStrip,
  type Item,
  type ItemKind,
  nearBand,
  nearCrevasse,
  radiusAt,
  routeClearance,
  slopeAt,
  SpacingGrid,
  type Strip,
} from './layout-util.js';

/** Crown radius of a spruce relative to its height. */
export const TREE_CROWN = 0.3;
/** Boulder footprint relative to its size. */
export const BOULDER_FOOT = 1.15;

/** Avalanche track (mirrors fx/fx-layout.ts: 320 m above, 160 m below, fanning to ~38 m). */
let avalancheStrip: Strip | null = null;
export function avalancheTrack(): Strip {
  avalancheStrip ??= fallStrip(AVALANCHE.crossS, 320, 160, (AVALANCHE.width / 2) * 1.28);
  return avalancheStrip;
}

/** Rockfall gully (mirrors fx ROCK_GULLY_HALF = 14). */
let gullyStrip: Strip | null = null;
export function rockfallGully(): Strip {
  gullyStrip ??= fallStrip(ROCKFALL.s, 170, 40, 14);
  return gullyStrip;
}

// ------------------------------------------------------ collapse serac -----

/**
 * The serac tower that collapses at SERAC.s. Same placement as
 * `fx/fx-layout.ts` seracTower(): footprint centre 26 m to the uphill side,
 * toppling down the fall line angled toward the path.
 */
export interface SeracTower {
  /** Pivot: the downhill foot edge the tower topples over (world). */
  x: number;
  z: number;
  baseY: number;
  height: number;
  width: number;
  depth: number;
  fallX: number;
  fallZ: number;
  /** Yaw (rotation.y) that turns local +Z into the fall direction. */
  yaw: number;
  centreX: number;
  centreZ: number;
}

export const SERAC_HEIGHT = 22;

export function seracTower(): SeracTower {
  const f = routeFrame(SERAC.s);
  const upSide = -outwardSide(SERAC.s);
  const width = 9;
  const depth = 7;
  const cx = f.x + f.nx * upSide * 26;
  const cz = f.z + f.nz * upSide * 26;
  const r = Math.hypot(cx - SUMMIT_X, cz - SUMMIT_Z) || 1;
  let fx = (cx - SUMMIT_X) / r;
  let fz = (cz - SUMMIT_Z) / r;
  fx = 0.6 * fx - 0.4 * f.nx * upSide;
  fz = 0.6 * fz - 0.4 * f.nz * upSide;
  const l = Math.hypot(fx, fz) || 1;
  fx /= l;
  fz /= l;
  const x = cx + fx * (depth / 2);
  const z = cz + fz * (depth / 2);
  return {
    x,
    z,
    baseY: groundAt(x, z),
    height: SERAC_HEIGHT,
    width,
    depth,
    fallX: fx,
    fallZ: fz,
    yaw: Math.atan2(fx, fz),
    centreX: cx,
    centreZ: cz,
  };
}

/** True near the collapsing tower or the swath its ice sweeps across the path. */
function inSeracFall(t: SeracTower, x: number, z: number, margin: number): boolean {
  const dx = x - t.centreX;
  const dz = z - t.centreZ;
  const along = dx * t.fallX + dz * t.fallZ;
  const across = Math.abs(-dx * t.fallZ + dz * t.fallX);
  return along > -t.depth - margin && along < 46 + margin && across < t.width / 2 + 9 + margin;
}

// ------------------------------------------------------------ scatter -----

interface ScatterOptions {
  kind: ItemKind;
  seed: number;
  s0: number;
  s1: number;
  count: number;
  attempts: number;
  /** Lateral distance from the route centre line. */
  lateral: (rand: () => number) => number;
  /** Size for a candidate (tree height, boulder radius...). */
  size: (rand: () => number, x: number, z: number, h: number) => number;
  /** Footprint radius from size. */
  foot: (size: number) => number;
  /** Extra acceptance test (density, exclusions). */
  accept: (x: number, z: number, size: number, h: number, rand: () => number) => boolean;
  /** How far the base is pushed into the ground (from size). */
  sink: (size: number) => number;
  maxSlope: number;
  /** Minimum gap factor between footprints. */
  gap: number;
  /** Extra corridor margin for this kind. */
  corridor?: number;
}

function* scatter(o: ScatterOptions, grid: SpacingGrid): Gen<Item[]> {
  const rand = mulberry32(o.seed);
  const out: Item[] = [];
  for (let a = 0; a < o.attempts && out.length < o.count; a++) {
    if ((a & 63) === 63) yield;
    const s = o.s0 + rand() * (o.s1 - o.s0);
    const side = rand() < 0.5 ? -1 : 1;
    const f = routeFrame(s);
    const lat = o.lateral(rand);
    const jitter = (rand() - 0.5) * 12;
    const x = f.x + f.nx * side * lat + f.tx * jitter;
    const z = f.z + f.nz * side * lat + f.tz * jitter;
    const h = groundAt(x, z);
    const size = o.size(rand, x, z, h);
    if (size <= 0) continue;
    const r = o.foot(size);
    if (routeClearance(x, z, r) < CORRIDOR_CLEAR + (o.corridor ?? 0)) continue;
    if (!grid.fits(x, z, r, o.gap)) continue;
    if (!o.accept(x, z, size, h, rand)) continue;
    if (slopeAt(x, z) > o.maxSlope) continue;
    if (nearBand(x, z, 10 + r)) continue;
    const br = baseRadius(o.kind, r);
    const base = groundMin(x, z, br);
    // Nothing perched on a ledge: the footprint must sit fairly level.
    if (groundMax(x, z, br) - base > Math.max(0.6, r * 0.9)) continue;
    grid.add(x, z, r);
    out.push({ kind: o.kind, x, y: base - o.sink(size), z, r, yaw: rand() * Math.PI * 2, size, seed: o.seed * 7919 + out.length });
  }
  return out;
}

// ------------------------------------------------------------- forest -----

export function* forestTrees(grid: SpacingGrid): Gen<Item[]> {
  return yield* scatter(
    {
      kind: 'tree',
      seed: 4242,
      s0: 640,
      s1: 2520,
      count: 2300,
      attempts: 9000,
      lateral: (rand) => 6 + 150 * Math.pow(rand(), 1.7),
      size: (rand, _x, _z, h) => (7 + rand() * 9) * (1 - 0.45 * smoothstep(200, 290, h)),
      foot: (size) => size * TREE_CROWN,
      accept: (x, z, _size, h, rand) => {
        // Meadows on the valley floor, forest on the slopes, tree line ~290 m.
        let p = (0.2 + 0.8 * smoothstep(12, 45, h)) * smoothstep(300, 245, h);
        // Clumps and clearings.
        p *= 0.35 + 0.65 * smoothstep(-0.35, 0.15, valueNoise(x * 0.018, z * 0.018));
        if (rand() > p) return false;
        return !inRiver(x, z, 4) && !inCamp(x, z, 5);
      },
      sink: () => 0.25,
      maxSlope: 0.75,
      gap: 0.62,
    },
    grid,
  );
}

// ------------------------------------------------------------ boulders -----

export function* valleyBoulders(grid: SpacingGrid): Gen<Item[]> {
  return yield* scatter(
    {
      kind: 'boulder',
      seed: 1301,
      s0: 0,
      s1: 1250,
      count: 260,
      attempts: 2600,
      lateral: (rand) => 6 + 120 * Math.pow(rand(), 1.4),
      size: (rand) => 0.35 + 2.4 * Math.pow(rand(), 2.6),
      foot: (size) => size * BOULDER_FOOT,
      accept: (x, z, _size, _h, rand) =>
        rand() < 0.45 + 0.55 * smoothstep(-0.2, 0.3, valueNoise(x * 0.02 + 5, z * 0.02)) &&
        !inRiver(x, z, 1) &&
        !inCamp(x, z, 8),
      sink: (size) => size * 0.3,
      maxSlope: 0.8,
      gap: 1.05,
    },
    grid,
  );
}

export function* moraineBoulders(grid: SpacingGrid): Gen<Item[]> {
  const av = avalancheTrack();
  return yield* scatter(
    {
      kind: 'boulder',
      seed: 2378,
      s0: route.sectionStart.moraine - 30,
      s1: route.sectionStart.glacier + 60,
      count: 1150,
      attempts: 9000,
      lateral: (rand) => 6 + 210 * Math.pow(rand(), 1.5),
      size: (rand) => 0.5 + 5.5 * Math.pow(rand(), 2.4),
      foot: (size) => size * BOULDER_FOOT,
      accept: (x, z, size, _h, rand) =>
        rand() < 0.25 + 0.75 * smoothstep(-0.3, 0.25, valueNoise(x * 0.011 - 3, z * 0.011)) &&
        !inStrip(av, x, z, 6 + size) &&
        !inCamp(x, z, 6),
      sink: (size) => size * 0.32,
      maxSlope: 0.95,
      gap: 1.0,
    },
    grid,
  );
}

export function* ridgeRocks(grid: SpacingGrid): Gen<Item[]> {
  const gully = rockfallGully();
  return yield* scatter(
    {
      kind: 'boulder',
      seed: 5790,
      s0: route.sectionStart.ridge + 15,
      s1: route.sectionStart.rockband - 10,
      count: 340,
      attempts: 4000,
      lateral: (rand) => 5.5 + 95 * Math.pow(rand(), 1.5),
      size: (rand) => 0.35 + 3.2 * Math.pow(rand(), 2.2),
      foot: (size) => size * BOULDER_FOOT,
      accept: (x, z, size, _h, rand) => {
        if (rand() > 0.3 + 0.7 * smoothstep(-0.3, 0.2, valueNoise(x * 0.03, z * 0.03 + 9))) return false;
        if (inStrip(gully, x, z, 6 + size) || inCamp(x, z, 5)) return false;
        // Keep the exposed ledge's drop and wall clean.
        return !nearRopeLedge(x, z);
      },
      sink: (size) => size * 0.3,
      maxSlope: 1.0,
      gap: 1.0,
    },
    grid,
  );
}

function nearRopeLedge(x: number, z: number): boolean {
  for (let s = ROPE_START_S - 50; s <= ROPE_END_S + 50; s += 10) {
    const f = routeFrame(s);
    if (Math.hypot(x - f.x, z - f.z) < 48) return true;
  }
  return false;
}

// ------------------------------------------------------------- glacier -----

export function* seracField(grid: SpacingGrid): Gen<Item[]> {
  const tower = seracTower();
  grid.add(tower.centreX, tower.centreZ, 7);
  const field = yield* scatter(
    {
      kind: 'serac',
      seed: 4880,
      s0: SERAC_FIELD.startS,
      s1: SERAC_FIELD.endS,
      count: 60,
      attempts: 2400,
      lateral: (rand) => 9 + 150 * Math.pow(rand(), 1.6),
      size: (rand) => 7 + 15 * Math.pow(rand(), 1.4),
      foot: (size) => size * 0.42,
      accept: (x, z, size) => !inSeracFall(tower, x, z, size * 0.42) && !nearCrevasse(x, z, 10) && !inCamp(x, z, 8),
      sink: () => 1.6,
      maxSlope: 0.9,
      gap: 0.85,
      corridor: 2,
    },
    grid,
  );
  // Scattered ice blocks elsewhere on the glacier.
  const blocks = yield* scatter(
    {
      kind: 'serac',
      seed: 4301,
      s0: route.sectionStart.glacier + 80,
      s1: route.sectionStart.icewall - 60,
      count: 34,
      attempts: 1200,
      lateral: (rand) => 12 + 140 * Math.pow(rand(), 1.3),
      size: (rand) => 3 + 5 * rand(),
      foot: (size) => size * 0.42,
      accept: (x, z, size) =>
        !inSeracFall(tower, x, z, size * 0.42) && !nearCrevasse(x, z, 12) && !inCamp(x, z, 8) && radiusAt(x, z) > 760,
      sink: () => 0.9,
      maxSlope: 0.8,
      gap: 1.2,
      corridor: 2,
    },
    grid,
  );
  return field.concat(blocks);
}

/** A blue ice seam on the glacier surface: a strip following a contour. */
export interface Seam {
  /** Centre line points (world x, z). */
  x: number[];
  z: number[];
  width: number;
  seed: number;
}

export function* glacierSeams(): Gen<Seam[]> {
  const rand = mulberry32(4150);
  const out: Seam[] = [];
  const s0 = route.sectionStart.glacier + 20;
  const s1 = route.sectionStart.icewall - 25;
  for (let a = 0; a < 900 && out.length < 72; a++) {
    if ((a & 15) === 15) yield;
    const s = s0 + rand() * (s1 - s0);
    const side = rand() < 0.5 ? -1 : 1;
    const f = routeFrame(s);
    const lat = 7 + 160 * Math.pow(rand(), 1.3);
    const cx = f.x + f.nx * side * lat;
    const cz = f.z + f.nz * side * lat;
    const r = radiusAt(cx, cz);
    const theta = Math.atan2(cx - SUMMIT_X, cz - SUMMIT_Z);
    const length = 12 + rand() * 42;
    const width = 0.35 + rand() * 1.0;
    const wobble = rand() * 10;
    const xs: number[] = [];
    const zs: number[] = [];
    let ok = true;
    const n = Math.max(2, Math.round(length / 1.5));
    for (let i = 0; i <= n && ok; i++) {
      const t = i / n - 0.5;
      const rr = r + Math.sin(t * 5 + wobble) * 2.2;
      const th = theta + (t * length) / r;
      const x = SUMMIT_X + Math.sin(th) * rr;
      const z = SUMMIT_Z + Math.cos(th) * rr;
      if (routeClearance(x, z, width) < CORRIDOR_CLEAR || nearCrevasse(x, z, 4) || inCamp(x, z, 3) || nearBand(x, z, 8))
        ok = false;
      else if (slopeAt(x, z) > 0.85) ok = false;
      xs.push(x);
      zs.push(z);
    }
    if (ok) out.push({ x: xs, z: zs, width, seed: a });
  }
  return out;
}
