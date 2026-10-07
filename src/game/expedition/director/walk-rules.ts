/**
 * Walking rules for the expedition, as pure math (node-checkable): keep the
 * head on the route bench (or inside a camp / on the summit platform),
 * narrow the path onto the log bridge, the crevasse ladder and the rope
 * ledge, stop at the foot of each climbing band (and trigger the climb),
 * stop you walking back off the top of one, and respect the mechanics'
 * walk gate. The level applies the returned correction to the rig.
 */

import { project, type Projection, routePoint, smoothstep } from '../exp-route.js';
import {
  type BandCrossing,
  CAMPS,
  campCentre,
  CREVASSE_HALF_GAP,
  CREVASSE_S,
  ICE_WALL,
  RIVER_HALF_WIDTH,
  RIVER_S,
  ROCK_BAND,
  ROPE_END_S,
  ROPE_START_S,
  SUMMIT_S,
} from '../exp-layout.js';
import { mechanicsSpeedLimit } from '../mechanics/mechanics-state.js';
import { walkGate } from '../mechanics/walk-gate.js';
import { wallOut } from './checkpoints.js';
import { pointAt, type RouteDir, type RoutePos, tangentAt } from './route-math.js';

export type WallId = 'ice' | 'rock';

export const WALLS: Record<WallId, BandCrossing> = { ice: ICE_WALL, rock: ROCK_BAND };

/** Half width of the walkable bench the head is kept within (terrain bench is 4 m). */
export const BENCH_LIMIT = 3.6;
/** Beyond the limit the push-back is soft, but never lets you get further than this. */
const HARD_SLACK = 0.35;
const SOFT_RATE = 12;
/** Narrowed half widths: log bridge, crevasse ladder, exposed rope ledge. */
const BRIDGE_HALF = 1.25;
const LADDER_HALF = 0.38;
/** Mechanics' gusts push you up to ~3 m out on the rope ledge. */
const LEDGE_HALF = 3.0;
/** Distance over which the path narrows down to a bridge / ladder / ledge. */
const FUNNEL = 10;
/** The climb starts when the head comes this close to a band's face. */
export const CLIMB_TRIGGER_OUT = 2.0;
/** Never closer to the face than this while standing at its foot. */
const FOOT_MIN_OUT = 1.4;
/** On top, stay at least this far back from the face plane (the lip is at ~-6.8). */
const TOP_MAX_OUT = -7.5;
/** Free-roam disc on the summit platform (around the summit marker). */
export const SUMMIT_FREE_RADIUS = 13;
/** Slow walking on the bridge and the ladder (m/s). */
export const NARROW_SPEED = 1.6;

const BRIDGE_HALF_SPAN = RIVER_HALF_WIDTH + 4;
const LADDER_HALF_SPAN = CREVASSE_HALF_GAP + 0.9;

export interface WalkResult {
  /** The head is nowhere near the route (projection failed). */
  lost: boolean;
  /** Arc length and lateral offset after the correction. */
  s: number;
  d: number;
  /** Horizontal correction to apply to the rig. */
  dx: number;
  dz: number;
  /** Forward progress was clamped by the walk gate. */
  blocked: boolean;
  /** Reached the foot of a climbing band. */
  climb: WallId | null;
  /** Maximum walking speed here (m/s). */
  speedCap: number;
}

export function newWalkResult(): WalkResult {
  return { lost: false, s: 0, d: 0, dx: 0, dz: 0, blocked: false, climb: null, speedCap: Infinity };
}

function funnel(s: number, centre: number, halfSpan: number, narrow: number): number {
  const e = Math.abs(s - centre) - halfSpan;
  return narrow + (BENCH_LIMIT - narrow) * smoothstep(0, FUNNEL, e);
}

/** Half width the head may stray from the centre line at arc length s. */
export function halfWidthAt(s: number): number {
  let hw = BENCH_LIMIT;
  hw = Math.min(hw, funnel(s, RIVER_S, BRIDGE_HALF_SPAN, BRIDGE_HALF));
  hw = Math.min(hw, funnel(s, CREVASSE_S, LADDER_HALF_SPAN, LADDER_HALF));
  // The ledge drop starts 40 m before the rope (see exp-terrain).
  const a = ROPE_START_S - 40;
  const b = ROPE_END_S + 40;
  const outside = Math.max(a - s, s - b);
  hw = Math.min(hw, LEDGE_HALF + (BENCH_LIMIT - LEDGE_HALF) * smoothstep(0, 15, outside));
  return hw;
}

interface FreeDisc {
  x: number;
  z: number;
  radius: number;
}

const FREE_DISCS: FreeDisc[] = (() => {
  const discs = CAMPS.map((camp) => {
    const c = campCentre(camp);
    return { x: c.x, z: c.z, radius: camp.radius - 1.5 };
  });
  const p = routePoint(SUMMIT_S);
  discs.push({ x: p.x, z: p.z, radius: SUMMIT_FREE_RADIUS });
  return discs;
})();

const proj: Projection = { s: 0, d: 0, dist: 0, elev: 0 };
const near: RoutePos = { x: 0, z: 0, elev: 0 };
const tan: RouteDir = { x: 0, z: 0 };

function correction(excess: number, dt: number): number {
  return Math.max(excess * (1 - Math.exp(-SOFT_RATE * dt)), excess - HARD_SLACK);
}

/**
 * Evaluate the walking rules for a head at (x, headY, z). `prevS` is last
 * frame's arc length (the walk gate only holds you if you were behind it).
 */
export function walkRules(x: number, z: number, headY: number, prevS: number, dt: number, out: WalkResult): WalkResult {
  out.dx = 0;
  out.dz = 0;
  out.blocked = false;
  out.climb = null;
  out.lost = false;
  out.speedCap = Infinity;
  project(x, z, proj);
  if (proj.dist === Infinity) {
    out.lost = true;
    out.s = prevS;
    out.d = 0;
    return out;
  }
  const s = proj.s;

  // 1. Stay on the bench, unless inside a camp or on the summit platform.
  const benchExcess = proj.dist - halfWidthAt(s);
  if (benchExcess > 0) {
    let freeExcess = Infinity;
    let fx = 0;
    let fz = 0;
    for (const disc of FREE_DISCS) {
      const dx = disc.x - x;
      const dz = disc.z - z;
      const dist = Math.hypot(dx, dz);
      const e = dist - disc.radius;
      if (e < freeExcess) {
        freeExcess = e;
        fx = dx / (dist || 1);
        fz = dz / (dist || 1);
      }
    }
    if (freeExcess > 0) {
      if (freeExcess < benchExcess) {
        const c = correction(freeExcess, dt);
        out.dx += fx * c;
        out.dz += fz * c;
      } else {
        // Straight back toward the nearest route point (also right at the ends).
        pointAt(s, near);
        const ox = x - near.x;
        const oz = z - near.z;
        const len = Math.hypot(ox, oz) || 1;
        const c = correction(benchExcess, dt);
        out.dx -= (ox / len) * c;
        out.dz -= (oz / len) * c;
      }
    }
  }

  // 2. Climbing bands: stop at the foot (and start the climb), don't walk back off the top.
  for (const id of ['ice', 'rock'] as const) {
    const band = WALLS[id];
    if (Math.abs(s - band.s) > 45) continue;
    const o = wallOut(band, x + out.dx, z + out.dz);
    if (headY < band.baseY + 5) {
      if (o < CLIMB_TRIGGER_OUT) out.climb = id;
      if (o < FOOT_MIN_OUT) {
        out.dx += band.nx * (FOOT_MIN_OUT - o);
        out.dz += band.nz * (FOOT_MIN_OUT - o);
      }
    } else if (headY > band.topY - 6 && o > TOP_MAX_OUT) {
      out.dx -= band.nx * (o - TOP_MAX_OUT);
      out.dz -= band.nz * (o - TOP_MAX_OUT);
    }
  }

  // 3. The mechanics' gate (e.g. the fixed rope before you clip in).
  const gate = walkGate.blockS;
  if (gate < Infinity && prevS <= gate + 2 && s > gate) {
    const back = s - gate;
    tangentAt(s, tan);
    out.dx -= tan.x * back;
    out.dz -= tan.z * back;
    out.blocked = true;
  }

  // 4. Speed: careful on the bridge and the ladder; mechanics may cap it too.
  if (Math.abs(s - RIVER_S) < BRIDGE_HALF_SPAN + 1 || Math.abs(s - CREVASSE_S) < LADDER_HALF_SPAN + 1) {
    out.speedCap = NARROW_SPEED;
  }
  out.speedCap = Math.min(out.speedCap, mechanicsSpeedLimit());

  if (out.dx !== 0 || out.dz !== 0) project(x + out.dx, z + out.dz, proj);
  out.s = proj.dist === Infinity ? s : proj.s;
  out.d = proj.dist === Infinity ? 0 : proj.d;
  return out;
}
