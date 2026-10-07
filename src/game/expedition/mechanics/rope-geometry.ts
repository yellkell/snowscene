/**
 * Geometry of the fixed rope along the exposed ledge (ROPE_START_S ..
 * ROPE_END_S). Pure math, no Three.js, so the world builder, the mechanics
 * and node checks agree exactly.
 *
 * The rope runs ROPE_SIDE_OFFSET metres to the uphill side of the path
 * centre (`-outwardSide(s)`), ROPE_HEIGHT above the terrain
 * (`expeditionHeight`) at each anchor, sagging slightly between anchors,
 * which stand every ~12 m. It starts a few metres before ROPE_START_S so
 * the player can clip in at the walk gate, and ends a little after
 * ROPE_END_S.
 *
 * NOTE for integration: the world agent's `world/rope-path.ts`
 * `ropeAnchors()` should use (or be replaced by) this module so the drawn
 * rope and the clip/grab mechanics are the same rope.
 */

import { project, type Projection } from '../exp-route.js';
import { outwardSide, ROPE_END_S, ROPE_HEIGHT, ROPE_START_S, routeFrame } from '../exp-layout.js';
import { expeditionHeight } from '../exp-terrain.js';

/** First and last anchor (arc length). */
export const ROPE_FIRST_S = ROPE_START_S - 3.5;
export const ROPE_LAST_S = ROPE_END_S + 3.5;
/** Lateral distance of the rope from the path centre, toward the uphill wall. */
export const ROPE_SIDE_OFFSET = 0.6;
/** Target spacing between anchors (the real spacing divides the rope evenly). */
export const ANCHOR_SPACING = 12;
/** How far the rope sags midway between anchors (m). */
export const ROPE_SAG = 0.07;
/** Rope points per span (dense polyline). */
const POINTS_PER_SPAN = 24;

export interface RopePoint {
  x: number;
  y: number;
  z: number;
  /** Arc length of the route point this rope point sits beside. */
  s: number;
}

export interface RopeData {
  /** Number of dense points and their parameter spacing (in route arc length). */
  count: number;
  s0: number;
  h: number;
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  /** Horizontal unit tangent (direction of travel) at each point. */
  tx: Float64Array;
  tz: Float64Array;
  /** Terrain height below each point. */
  ground: Float64Array;
  /** Sign of the route's lateral offset `d` on the rope's side (+1 left). */
  side: Int8Array;
  /** Anchor arc lengths, ascending; anchorIndex[i] is the dense index. */
  anchorS: number[];
  anchorIndex: number[];
  spacing: number;
}

let cached: RopeData | null = null;

/** The rope, computed once. */
export function ropeData(): RopeData {
  if (cached) return cached;
  const spans = Math.max(1, Math.round((ROPE_LAST_S - ROPE_FIRST_S) / ANCHOR_SPACING));
  const spacing = (ROPE_LAST_S - ROPE_FIRST_S) / spans;
  const count = spans * POINTS_PER_SPAN + 1;
  const h = spacing / POINTS_PER_SPAN;
  const data: RopeData = {
    count,
    s0: ROPE_FIRST_S,
    h,
    x: new Float64Array(count),
    y: new Float64Array(count),
    z: new Float64Array(count),
    tx: new Float64Array(count),
    tz: new Float64Array(count),
    ground: new Float64Array(count),
    side: new Int8Array(count),
    anchorS: [],
    anchorIndex: [],
    spacing,
  };
  for (let i = 0; i < count; i++) {
    const s = ROPE_FIRST_S + i * h;
    const f = routeFrame(s);
    const side = -outwardSide(s);
    const x = f.x + f.nx * side * ROPE_SIDE_OFFSET;
    const z = f.z + f.nz * side * ROPE_SIDE_OFFSET;
    const ground = expeditionHeight(x, z);
    const k = i % POINTS_PER_SPAN;
    const t = k / POINTS_PER_SPAN;
    data.x[i] = x;
    data.z[i] = z;
    data.ground[i] = ground;
    data.y[i] = ground + ROPE_HEIGHT - ROPE_SAG * 4 * t * (1 - t);
    data.tx[i] = f.tx;
    data.tz[i] = f.tz;
    data.side[i] = side;
    if (k === 0) {
      data.anchorS.push(s);
      data.anchorIndex.push(i);
    }
  }
  cached = data;
  return data;
}

/** Anchor points of the fixed rope (where the stakes stand), in order. */
export function ropeAnchors(): RopePoint[] {
  const r = ropeData();
  return r.anchorIndex.map((i, k) => ({ x: r.x[i], y: r.y[i], z: r.z[i], s: r.anchorS[k] }));
}

/** Dense polyline of the rope (anchors included), in order. */
export function ropePoints(): RopePoint[] {
  const r = ropeData();
  const out: RopePoint[] = [];
  for (let i = 0; i < r.count; i++) out.push({ x: r.x[i], y: r.y[i], z: r.z[i], s: r.s0 + i * r.h });
  return out;
}

/** Index of the span (between anchor k and k + 1) containing parameter u. */
export function ropeSpanAt(u: number): number {
  const r = ropeData();
  const spans = r.anchorS.length - 1;
  const k = Math.floor((u - r.s0) / r.spacing);
  return k < 0 ? 0 : k >= spans ? spans - 1 : k;
}

/** Point on the rope at parameter u (route arc length), written to `out`. */
export function ropePointAt(u: number, out: { x: number; y: number; z: number }): void {
  const r = ropeData();
  let f = (u - r.s0) / r.h;
  if (f < 0) f = 0;
  if (f > r.count - 1) f = r.count - 1;
  const i = Math.min(r.count - 2, Math.floor(f));
  const t = f - i;
  out.x = r.x[i] + (r.x[i + 1] - r.x[i]) * t;
  out.y = r.y[i] + (r.y[i + 1] - r.y[i]) * t;
  out.z = r.z[i] + (r.z[i + 1] - r.z[i]) * t;
}

export interface RopeHit {
  /** 3D distance from the query point to the rope. */
  dist: number;
  /** Rope parameter (route arc length) of the closest point. */
  u: number;
  x: number;
  y: number;
  z: number;
  /** Horizontal tangent at the closest point. */
  tx: number;
  tz: number;
}

const scratch: Projection = { s: 0, d: 0, dist: 0, elev: 0 };

/**
 * Closest point on the rope to (px, py, pz). Returns `out` with
 * dist = Infinity when the point is nowhere near the rope. No allocation.
 */
export function nearestOnRope(px: number, py: number, pz: number, out: RopeHit): RopeHit {
  const r = ropeData();
  out.dist = Infinity;
  project(px, pz, scratch);
  if (scratch.dist > 30) return out;
  const centre = Math.round((scratch.s - r.s0) / r.h);
  if (centre < -6 || centre > r.count + 6) return out;
  const lo = Math.max(0, centre - 6);
  const hi = Math.min(r.count - 1, centre + 6);
  let best = Infinity;
  for (let i = lo; i < hi; i++) {
    const ax = r.x[i];
    const ay = r.y[i];
    const az = r.z[i];
    const ex = r.x[i + 1] - ax;
    const ey = r.y[i + 1] - ay;
    const ez = r.z[i + 1] - az;
    const len2 = ex * ex + ey * ey + ez * ez;
    let t = len2 > 0 ? ((px - ax) * ex + (py - ay) * ey + (pz - az) * ez) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + ex * t;
    const cy = ay + ey * t;
    const cz = az + ez * t;
    const dx = px - cx;
    const dy = py - cy;
    const dz = pz - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < best) {
      best = d2;
      out.u = r.s0 + (i + t) * r.h;
      out.x = cx;
      out.y = cy;
      out.z = cz;
      out.tx = r.tx[i];
      out.tz = r.tz[i];
    }
  }
  out.dist = Math.sqrt(best);
  return out;
}
