/**
 * Where and when the set-piece events happen: the avalanche track and its
 * timeline, the collapsing serac tower, the rockfall gully. Pure math (no
 * Three.js) so it can be node-checked and shared with the world builder.
 *
 * Conventions: arc lengths `s` along the route (exp-layout.ts); the
 * avalanche track is a polyline from the crown (u = 0) down the fall line,
 * across the route (u = AV_UP) and into the runout (u = AV_LENGTH); `v` is
 * the signed distance across the track.
 */

import { clamp, project, type Projection, smoothstep, SUMMIT_X, SUMMIT_Z } from '../exp-route.js';
import { naturalHeight } from '../exp-terrain.js';
import { AVALANCHE, outwardSide, ROCKFALL, routeFrame, SERAC } from '../exp-layout.js';

const scratch: Projection = { s: 0, d: 0, dist: 0, elev: 0 };

/** Natural (un-benched) height with the relief mask the real terrain uses. */
function natural(x: number, z: number): number {
  project(x, z, scratch);
  return naturalHeight(x, z, scratch.dist);
}

/**
 * Trace a fall line from (x, z). `sign` +1 climbs (steepest ascent), -1
 * descends. The local gradient (smoothed over ~12 m) is blended with the
 * radial direction so the line stays stable across the flattened route
 * bench. Returns `count` points spaced `step` apart, starting at (x, z).
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
    // Radially inward is uphill on this mountain.
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

// ------------------------------------------------------------ avalanche -----

/** Spacing of the avalanche centre line (metres). */
export const AV_STEP = 4;
/** Track length above the route (crown to crossing). */
export const AV_UP = 320;
/** Runout below the route (stops short of the leg below). */
export const AV_DOWN = 160;
export const AV_LENGTH = AV_UP + AV_DOWN;
/** Half width of the flowing mass. */
export const AV_HALF_WIDTH = AVALANCHE.width / 2;
/** Length of the slab that breaks away at the crown. */
export const AV_SLAB = 60;

/** Timeline (seconds after the trigger). */
export const AV_T_RELEASE = 0.7;
/** The front reaches the route. */
export const AV_T_CROSS = 11.5;
/** Ease-in exponent of the acceleration down the track. */
const AV_P = 1.45;
/** Lag of the tail behind the front (seconds of front travel). */
const AV_TAIL_LAG = 2.0;
/** The deposit starts this far below the route. */
export const AV_DEPOSIT_START = AV_UP + 22;
/** Speed of the front when it crosses the route (m/s). */
export const AV_CROSS_SPEED = (AV_P * (AV_UP - AV_SLAB)) / (AV_T_CROSS - AV_T_RELEASE);
/** Deceleration in the runout. */
const AV_DECEL = (AV_CROSS_SPEED * AV_CROSS_SPEED) / (2 * AV_DOWN);
/** When the front stops. */
export const AV_T_STOP = AV_T_CROSS + AV_CROSS_SPEED / AV_DECEL;

/** Position of the front (u) at time t after the trigger. */
export function avFront(t: number): number {
  if (t <= AV_T_RELEASE) return AV_SLAB;
  if (t <= AV_T_CROSS) {
    const x = (t - AV_T_RELEASE) / (AV_T_CROSS - AV_T_RELEASE);
    return AV_SLAB + (AV_UP - AV_SLAB) * Math.pow(x, AV_P);
  }
  const tau = Math.min(t, AV_T_STOP) - AV_T_CROSS;
  return AV_UP + AV_CROSS_SPEED * tau - 0.5 * AV_DECEL * tau * tau;
}

/** Speed of the front (m/s). */
export function avSpeed(t: number): number {
  if (t <= AV_T_RELEASE) return 0;
  if (t <= AV_T_CROSS) {
    const x = (t - AV_T_RELEASE) / (AV_T_CROSS - AV_T_RELEASE);
    return AV_CROSS_SPEED * Math.pow(x, AV_P - 1);
  }
  if (t >= AV_T_STOP) return 0;
  return AV_CROSS_SPEED - AV_DECEL * (t - AV_T_CROSS);
}

/** Upper end of the moving mass (u). */
export function avTail(t: number): number {
  return clamp(avFront(t - AV_TAIL_LAG) - AV_SLAB, 0, AV_DEPOSIT_START);
}

/** Half width of the track at u (narrow at the crown, fanning in the runout). */
export function avHalfWidth(u: number): number {
  return AV_HALF_WIDTH * (0.82 + 0.18 * smoothstep(0, 120, u) + 0.28 * smoothstep(AV_UP, AV_LENGTH, u));
}

/** Can the mass at (u, v) kill someone standing there at time t? */
export function avLethal(u: number, v: number, t: number): boolean {
  if (Math.abs(v) > avHalfWidth(u) * 0.8) return false;
  const front = avFront(t);
  if (u > front + 1 || u < avTail(t) + 3) return false;
  // Only while it is still really moving where you stand.
  return avSpeed(t) > 4 || u > front - 30;
}

export interface AvalanchePath {
  count: number;
  /** Centre line points (crown first), AV_STEP apart. */
  x: Float32Array;
  z: Float32Array;
  /** Unit downhill flow direction at each point. */
  fx: Float32Array;
  fz: Float32Array;
  /** Index of the route crossing (u = AV_UP). */
  crossIndex: number;
}

/** The avalanche track: fall line through the route at AVALANCHE.crossS. */
export function buildAvalanchePath(): AvalanchePath {
  const c = routeFrame(AVALANCHE.crossS);
  const nUp = Math.round(AV_UP / AV_STEP);
  const nDown = Math.round(AV_DOWN / AV_STEP);
  const up = traceFallLine(c.x, c.z, 1, nUp + 1, AV_STEP);
  const down = traceFallLine(c.x, c.z, -1, nDown + 1, AV_STEP);
  const count = nUp + nDown + 1;
  const x = new Float32Array(count);
  const z = new Float32Array(count);
  for (let i = 0; i <= nUp; i++) {
    x[i] = up.x[nUp - i];
    z[i] = up.z[nUp - i];
  }
  for (let i = 1; i <= nDown; i++) {
    x[nUp + i] = down.x[i];
    z[nUp + i] = down.z[i];
  }
  const fx = new Float32Array(count);
  const fz = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const a = Math.max(0, i - 2);
    const b = Math.min(count - 1, i + 2);
    const dx = x[b] - x[a];
    const dz = z[b] - z[a];
    const l = Math.hypot(dx, dz) || 1;
    fx[i] = dx / l;
    fz[i] = dz / l;
  }
  return { count, x, z, fx, fz, crossIndex: nUp };
}

export interface TrackCoords {
  /** Distance down the track from the crown (may be < 0 or > length). */
  u: number;
  /** Signed distance across the track (+ = left of the flow). */
  v: number;
}

/** Project a point onto the avalanche centre line. */
export function avCoords(path: AvalanchePath, x: number, z: number, out: TrackCoords): TrackCoords {
  let best = Infinity;
  let bi = 0;
  let bt = 0;
  for (let i = 0; i < path.count - 1; i++) {
    const ax = path.x[i];
    const az = path.z[i];
    const ex = path.x[i + 1] - ax;
    const ez = path.z[i + 1] - az;
    const l2 = ex * ex + ez * ez;
    let t = ((x - ax) * ex + (z - az) * ez) / l2;
    // Let the ends extrapolate so "above the crown" reads as u < 0.
    if (i > 0) t = Math.max(t, 0);
    if (i < path.count - 2) t = Math.min(t, 1);
    const px = ax + ex * t - x;
    const pz = az + ez * t - z;
    const d2 = px * px + pz * pz;
    if (d2 < best) {
      best = d2;
      bi = i;
      bt = t;
    }
  }
  const ex = path.x[bi + 1] - path.x[bi];
  const ez = path.z[bi + 1] - path.z[bi];
  const l = Math.hypot(ex, ez) || 1;
  // Left of the flow direction (rotate +90 degrees about +Y, as routeFrame).
  const nx = ez / l;
  const nz = -ex / l;
  out.u = (bi + bt) * AV_STEP;
  out.v = (x - path.x[bi] - ex * bt) * nx + (z - path.z[bi] - ez * bt) * nz;
  return out;
}

/** Point on the track at (u, v). */
export function avPoint(path: AvalanchePath, u: number, v: number, out: { x: number; z: number }) {
  const f = clamp(u / AV_STEP, 0, path.count - 1.0001);
  const i = Math.floor(f);
  const t = f - i;
  const cx = path.x[i] + (path.x[i + 1] - path.x[i]) * t;
  const cz = path.z[i] + (path.z[i + 1] - path.z[i]) * t;
  const fx = path.fx[i] + (path.fx[i + 1] - path.fx[i]) * t;
  const fz = path.fz[i] + (path.fz[i + 1] - path.fz[i]) * t;
  const l = Math.hypot(fx, fz) || 1;
  out.x = cx + (fz / l) * v;
  out.z = cz - (fx / l) * v;
  return out;
}

// ---------------------------------------------------------------- serac -----

/** The ice tower that collapses (the world builder should put its serac here). */
export interface SeracTower {
  /** Pivot: the downhill foot edge the tower topples over (world). */
  x: number;
  z: number;
  /** Ground height at the pivot (the tower sinks 1.5 m into the glacier). */
  baseY: number;
  height: number;
  /** Across the fall direction. */
  width: number;
  /** Along the fall direction (the tower stands uphill of the pivot). */
  depth: number;
  /** Unit horizontal fall direction (downhill, toward and across the path). */
  fallX: number;
  fallZ: number;
  /** Yaw (rotation.y) that turns local +Z into the fall direction. */
  yaw: number;
  /** Centre of the tower's footprint. */
  centreX: number;
  centreZ: number;
}

export const SERAC_HEIGHT = 22;

export function seracTower(groundAt: (x: number, z: number) => number): SeracTower {
  const f = routeFrame(SERAC.s);
  const upSide = -outwardSide(SERAC.s);
  const width = 9;
  const depth = 7;
  // Footprint centre ~26 m to the uphill side of the path.
  const cx = f.x + f.nx * upSide * 26;
  const cz = f.z + f.nz * upSide * 26;
  // Topple down the fall line (radially outward), angled toward the path.
  const r = Math.hypot(cx - SUMMIT_X, cz - SUMMIT_Z) || 1;
  let fx = (cx - SUMMIT_X) / r;
  let fz = (cz - SUMMIT_Z) / r;
  // Bias toward the path so the ice spills across it.
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

/** Serac timeline (seconds after the trigger). */
export const SERAC_T_LEAN = 3.4;

// ------------------------------------------------------------- rockfall -----

/** The gully: where rocks cross the path, and how far up they start. */
export const ROCK_GULLY_HALF = 14;
/** Release distance above the path (along the fall line) for aimed stones. */
export const ROCK_NEAR_RELEASE = 56;
/** Release distance for the opening volley (from above the leg above). */
export const ROCK_FAR_RELEASE = 150;
/** The gully stays live until the player is past this arc length... */
export const ROCK_END_S = ROCKFALL.s + ROCK_GULLY_HALF + 24;
/** ...or this long after the trigger. */
export const ROCK_LIVE_SECONDS = 70;
