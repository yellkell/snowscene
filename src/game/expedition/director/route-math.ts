/**
 * Allocation-free route sampling for per-frame code (the shared
 * `routePoint` / `routeTangent` return fresh objects), plus small text
 * formatters. Pure TS: no Three.js, safe to node-check.
 */

import { clamp, route, SAMPLE_SPACING } from '../exp-route.js';

export interface RoutePos {
  x: number;
  z: number;
  elev: number;
}

export interface RouteDir {
  x: number;
  z: number;
}

/** Same interpolation as `routePoint(s)`, written into `out`. */
export function pointAt(s: number, out: RoutePos): RoutePos {
  const f = clamp(s / SAMPLE_SPACING, 0, route.count - 1);
  const i = Math.min(route.count - 2, Math.floor(f));
  const t = f - i;
  out.x = route.x[i] + (route.x[i + 1] - route.x[i]) * t;
  out.z = route.z[i] + (route.z[i + 1] - route.z[i]) * t;
  out.elev = route.elev[i] + (route.elev[i + 1] - route.elev[i]) * t;
  return out;
}

const pa: RoutePos = { x: 0, z: 0, elev: 0 };
const pb: RoutePos = { x: 0, z: 0, elev: 0 };

/** Same as `routeTangent(s)` (unit direction of travel), written into `out`. */
export function tangentAt(s: number, out: RouteDir): RouteDir {
  pointAt(s - 3, pa);
  pointAt(s + 3, pb);
  const dx = pb.x - pa.x;
  const dz = pb.z - pa.z;
  const len = Math.hypot(dx, dz) || 1;
  out.x = dx / len;
  out.z = dz / len;
  return out;
}

/** World yaw (yaw 0 faces -Z) of a horizontal direction. */
export function yawOf(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

const tan: RouteDir = { x: 0, z: 0 };

/** Yaw that faces up the route at arc length s. */
export function routeYaw(s: number): number {
  tangentAt(s, tan);
  return yawOf(tan.x, tan.z);
}

/** "350 m" / "1.2 km". */
export function formatDistance(metres: number): string {
  const m = Math.max(0, metres);
  if (m < 995) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

/** "1,240 m" (no locale dependence). */
export function formatAltitude(metres: number): string {
  const m = Math.max(0, Math.round(metres));
  const text = m >= 1000 ? `${Math.floor(m / 1000)},${String(m % 1000).padStart(3, '0')}` : String(m);
  return `${text} m`;
}

/** "06:36" from hours (wraps past midnight). */
export function formatClock(hours: number): string {
  const h = ((hours % 24) + 24) % 24;
  let hh = Math.floor(h);
  let mm = Math.round((h - hh) * 60);
  if (mm === 60) {
    mm = 0;
    hh = (hh + 1) % 24;
  }
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
