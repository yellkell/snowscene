/**
 * Geometry of the two balance crossings: the aluminium ladder over the
 * crevasse (CREVASSE_S) and the log bridge over the river (RIVER_S).
 * Footprints match `ladderHeight` / `bridgeHeight` in exp-layout.ts. Pure
 * math, no Three.js.
 *
 * Local coordinates of a crossing: `a` = metres along the route (+ = the
 * direction of travel) from the crossing centre, `l` = metres to the left
 * of the centre line.
 */

import { bridgeDeckAt } from '../exp-layout.js';
import {
  CREVASSE_HALF_GAP,
  CREVASSE_HALF_LENGTH,
  RIVER_HALF_WIDTH,
  RIVER_S,
  CREVASSE_S,
  routeFrame,
} from '../exp-layout.js';

export interface Crossing {
  id: 'ladder' | 'log';
  /** Route arc length of the centre. */
  s: number;
  x: number;
  z: number;
  elev: number;
  /** Horizontal unit tangent (travel) and left normal. */
  tx: number;
  tz: number;
  nx: number;
  nz: number;
  /** Walkable footprint (|a| <= halfLength, |l| <= halfWidth). */
  halfLength: number;
  halfWidth: number;
  /** The open (deadly / wet) part spans |a| < gapHalf. */
  gapHalf: number;
  /** How far the feet may stray from the centre line over the gap. */
  footHalfWidth: number;
  /** Careful mode (speed cap, balance) begins this far beyond the footprint ends. */
  approach: number;
  /** Speed cap on the crossing (m/s). */
  speedCap: number;
}

function makeCrossing(
  id: Crossing['id'],
  s: number,
  halfLength: number,
  halfWidth: number,
  gapHalf: number,
  footHalfWidth: number,
  speedCap: number,
): Crossing {
  const f = routeFrame(s);
  return {
    id,
    s,
    x: f.x,
    z: f.z,
    elev: f.elev,
    tx: f.tx,
    tz: f.tz,
    nx: f.nx,
    nz: f.nz,
    halfLength,
    halfWidth,
    gapHalf,
    footHalfWidth,
    approach: 3.5,
    speedCap,
  };
}

/** Ladder: footprint as in `ladderHeight` (|a| <= gap + 0.9, |l| <= 0.5). */
export const LADDER = makeCrossing('ladder', CREVASSE_S, CREVASSE_HALF_GAP + 0.9, 0.5, CREVASSE_HALF_GAP, 0.42, 0.5);
/** Log bridge: footprint as in `bridgeHeight` (|a| <= w + 4, |l| <= 1.6). */
export const LOG = makeCrossing('log', RIVER_S, RIVER_HALF_WIDTH + 4, 1.6, RIVER_HALF_WIDTH + 1, 0.55, 0.95);

/** Ladder rail top = walking surface height (matches `ladderHeight`). */
export const LADDER_FLOOR_Y = LADDER.elev + 0.08;

export interface Local {
  a: number;
  l: number;
}

export function toLocal(c: Crossing, x: number, z: number, out: Local): Local {
  const dx = x - c.x;
  const dz = z - c.z;
  out.a = dx * c.tx + dz * c.tz;
  out.l = dx * c.nx + dz * c.nz;
  return out;
}

/** Is a local point on the walkable footprint? */
export function onFootprint(c: Crossing, p: Local): boolean {
  return Math.abs(p.a) <= c.halfLength && Math.abs(p.l) <= c.halfWidth;
}

/** Is a local point within the careful zone (footprint plus the approach)? */
export function inCarefulZone(c: Crossing, p: Local): boolean {
  return Math.abs(p.a) <= c.halfLength + c.approach && Math.abs(p.l) <= 4.5;
}

/**
 * Speed cap at a local point: the crossing's cap on the footprint, easing up
 * over the approach so the player slows down smoothly rather than hitting a
 * wall. Infinity outside the careful zone.
 */
export function speedCapAt(c: Crossing, p: Local): number {
  if (!inCarefulZone(c, p)) return Infinity;
  const beyond = Math.max(0, Math.abs(p.a) - c.halfLength);
  return c.speedCap + beyond * 0.9;
}

/**
 * Lateral funnel: the head may be at most this far from the centre line.
 * Narrows to `footHalfWidth` over the gap and widens away from it, so a
 * player walking toward the crossing off-centre is eased onto it.
 */
export function funnelHalfWidth(c: Crossing, a: number): number {
  const beyond = Math.max(0, Math.abs(a) - c.gapHalf - 0.25);
  return c.footHalfWidth + beyond * 1.3;
}

/** Is the point over the open crevasse but off the ladder (a sure fall)? */
export function overOpenCrevasse(p: Local): boolean {
  return (
    Math.abs(p.a) < CREVASSE_HALF_GAP - 0.2 &&
    Math.abs(p.l) > LADDER.halfWidth + 0.15 &&
    Math.abs(p.l) < CREVASSE_HALF_LENGTH - 4
  );
}

// ---------------------------------------------------------- hand lines ----

/** The ladder's two hand lines, staked in the snow beyond each lip. */
export const HANDLINE = {
  /** Stake positions along the route (±) and to each side (±). */
  stakeA: CREVASSE_HALF_GAP + 1.7,
  lateral: 0.62,
  /** Height above the ladder floor at the stakes, and the mid-span sag. */
  height: 1.0,
  sag: 0.12,
};

/** Height of the hand line above the ladder floor at along-offset a. */
export function handLineHeight(a: number): number {
  const t = Math.min(1, Math.abs(a) / HANDLINE.stakeA);
  return HANDLINE.height - HANDLINE.sag * (1 - t * t);
}

export interface HandLineHit {
  /** -1 = right line, +1 = left line. */
  side: number;
  dist: number;
  /** Along-offset of the closest point. */
  a: number;
}

/**
 * Closest hand line to a world point (the lines are straight in plan and
 * sag gently, so a local-coordinate distance is exact enough).
 * `wobble` is the current lateral sway of the lines (m, + = left).
 */
export function nearestHandLine(
  x: number,
  y: number,
  z: number,
  wobble: number,
  out: HandLineHit,
): HandLineHit {
  const dx = x - LADDER.x;
  const dz = z - LADDER.z;
  const a = dx * LADDER.tx + dz * LADDER.tz;
  const l = dx * LADDER.nx + dz * LADDER.nz;
  out.dist = Infinity;
  out.side = 0;
  out.a = a;
  if (Math.abs(a) > HANDLINE.stakeA) return out;
  const lineY = LADDER_FLOOR_Y + handLineHeight(a);
  for (let side = -1; side <= 1; side += 2) {
    const dl = l - (side * HANDLINE.lateral + wobble);
    const dy = y - lineY;
    const d = Math.sqrt(dl * dl + dy * dy);
    if (d < out.dist) {
      out.dist = d;
      out.side = side;
    }
  }
  return out;
}

/** Floor height of the log bridge at along-offset a (matches `bridgeHeight`). */
export function logFloorY(a: number): number {
  return bridgeDeckAt(a);
}
