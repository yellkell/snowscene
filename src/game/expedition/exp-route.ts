/**
 * The expedition route and the shape of the mountain. Pure math with no
 * Three.js imports so the terrain worker can share it.
 *
 * The mountain is radially organised around its summit S: elevation is
 * mostly a function of distance r from S (with an ice cliff band at r = 720
 * and a summit rock band at r = 300), plus natural detail. The route spirals
 * in from Base Camp (r = 3000) to the summit, so climbing the route means
 * walking inward and around the mountain.
 */

export const SUMMIT_X = 0;
export const SUMMIT_Z = -9000;
export const SUMMIT_ELEV = 1300;
export const CLOUD_DECK_Y = 650;

/** Radii of the two climbing bands (cliff faces facing outward, +r). */
export const ICE_WALL_R = 720;
export const ICE_WALL_HEIGHT = 45;
export const ROCK_BAND_R = 300;
export const ROCK_BAND_HEIGHT = 35;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Mostly-linear ramp with soft ends: 0 at r = a, 1 at r = b. */
function ramp(a: number, b: number, r: number): number {
  const t = clamp((r - a) / (b - a), 0, 1);
  return 0.6 * t + 0.4 * t * t * (3 - 2 * t);
}

/** Half-width of each cliff band's slope in the terrain (the climbable
 * wall meshes stand just outside it and hide it). */
export const BAND_HALF_WIDTH = 3;

/** Steep step (~80 degrees) rising inward across 2 * BAND_HALF_WIDTH metres. */
function step(edge: number, r: number): number {
  return smoothstep(edge + BAND_HALF_WIDTH, edge - BAND_HALF_WIDTH, r);
}

/** Elevation of the mountain as a function of distance from the summit. */
export function profile(r: number): number {
  let e = 0;
  e += 40 * ramp(3000, 2850, r); // valley floor rising gently
  e += 210 * ramp(2850, 2250, r); // forest climb
  e += 350 * ramp(2250, 1550, r); // moraine
  e += 250 * ramp(1550, ICE_WALL_R + BAND_HALF_WIDTH + 1, r); // glacier
  e += ICE_WALL_HEIGHT * step(ICE_WALL_R, r); // ice cliff band
  e += 340 * ramp(ICE_WALL_R - BAND_HALF_WIDTH - 1, ROCK_BAND_R + BAND_HALF_WIDTH + 1, r); // ridge
  e += ROCK_BAND_HEIGHT * step(ROCK_BAND_R, r); // summit rock band
  e += 30 * ramp(ROCK_BAND_R - BAND_HALF_WIDTH - 1, 0, r); // summit dome
  // Surrounding ranges rise again beyond the valley.
  e += 420 * smoothstep(3500, 5200, r);
  return e;
}

// ------------------------------------------------------------ the route -----

export type SectionId =
  | 'valley'
  | 'forest'
  | 'moraine'
  | 'glacier'
  | 'icewall'
  | 'ridge'
  | 'rockband'
  | 'summit';

interface Waypoint {
  r: number;
  theta: number;
  /** Section that starts at this waypoint. */
  section?: SectionId;
}

interface Leg {
  section: SectionId;
  r0: number;
  r1: number;
  /** Number of switchback legs (1 = a single traverse). */
  legs: number;
  /** Angle swept by each leg (alternating direction for switchbacks). */
  span: number;
}

/**
 * The route plan: long traverses and switchbacks keep the walking grade near
 * 15-20 %, with two short vertical steps (the ice wall and the rock band).
 */
const PLAN: Leg[] = [
  { section: 'valley', r0: 3000, r1: 2850, legs: 1, span: 0.34 },
  { section: 'forest', r0: 2850, r1: 2250, legs: 2, span: 0.24 },
  { section: 'moraine', r0: 2250, r1: 1550, legs: 3, span: 0.28 },
  { section: 'glacier', r0: 1550, r1: ICE_WALL_R + 8, legs: 3, span: 0.4 },
  { section: 'icewall', r0: ICE_WALL_R + 8, r1: ICE_WALL_R - 9, legs: 1, span: 0.001 },
  { section: 'ridge', r0: ICE_WALL_R - 9, r1: ROCK_BAND_R + 8, legs: 4, span: 0.8 },
  { section: 'rockband', r0: ROCK_BAND_R + 8, r1: ROCK_BAND_R - 9, legs: 1, span: 0.001 },
  { section: 'summit', r0: ROCK_BAND_R - 9, r1: 25, legs: 1, span: 0.6 },
];

/** Control points in polar form (theta = 0 points along +Z from the summit). */
const WAYPOINTS: Waypoint[] = (() => {
  const out: Waypoint[] = [];
  let theta = 0;
  let dir = 1;
  for (const leg of PLAN) {
    const steps = leg.legs;
    for (let k = 0; k < steps; k++) {
      const ra = leg.r0 + ((leg.r1 - leg.r0) * k) / steps;
      const rb = leg.r0 + ((leg.r1 - leg.r0) * (k + 1)) / steps;
      const thetaB = theta + dir * leg.span;
      // Start of leg (first leg of a section carries the section tag).
      if (out.length === 0 || k > 0 || leg.span < 0.01) {
        if (k === 0) out.push({ r: ra, theta, section: leg.section });
        else out.push({ r: ra, theta });
      } else {
        out.push({ r: ra, theta, section: leg.section });
      }
      // Points along the leg so it follows the contour instead of a chord.
      const inner = leg.span < 0.01 ? 0 : Math.max(1, Math.round((leg.span * (ra + rb)) / 2 / 160));
      for (let m = 1; m <= inner; m++) {
        const t = m / (inner + 1);
        out.push({ r: ra + (rb - ra) * t, theta: theta + (thetaB - theta) * t });
      }
      theta = thetaB;
      if (leg.legs > 1) dir = -dir;
    }
  }
  out.push({ r: PLAN[PLAN.length - 1].r1, theta });
  return out;
})();

export const SAMPLE_SPACING = 4;
/** Half-window (samples) for smoothing the route's elevation. */
const ELEV_SMOOTH_SAMPLES = 22;

export interface RouteData {
  /** Flat arrays of resampled points. */
  x: Float32Array;
  z: Float32Array;
  /** Arc length at each point. */
  s: Float32Array;
  /** Path floor elevation at each point. */
  elev: Float32Array;
  count: number;
  length: number;
  /** Arc length where each section begins. */
  sectionStart: Record<SectionId, number>;
}

function polarToXZ(r: number, theta: number): [number, number] {
  return [SUMMIT_X + Math.sin(theta) * r, SUMMIT_Z + Math.cos(theta) * r];
}

/** Catmull-Rom through the waypoints, resampled at even arc-length spacing. */
function buildRoute(): RouteData {
  const pts = WAYPOINTS.map((w) => polarToXZ(w.r, w.theta));
  const dense: Array<[number, number, number]> = []; // x, z, waypoint index (fractional)
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const steps = 60;
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      dense.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1]), i + t]);
    }
  }
  dense.push([pts[pts.length - 1][0], pts[pts.length - 1][1], pts.length - 1]);

  // Arc length along the dense curve.
  const dl: number[] = [0];
  for (let i = 1; i < dense.length; i++) {
    dl.push(dl[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]));
  }
  const length = dl[dl.length - 1];
  const count = Math.floor(length / SAMPLE_SPACING) + 1;
  const x = new Float32Array(count);
  const z = new Float32Array(count);
  const s = new Float32Array(count);
  const elev = new Float32Array(count);
  const sectionStart = {} as Record<SectionId, number>;
  let j = 0;
  for (let i = 0; i < count; i++) {
    const target = Math.min(length, i * SAMPLE_SPACING);
    while (j < dl.length - 2 && dl[j + 1] < target) j++;
    const seg = dl[j + 1] - dl[j];
    const t = seg > 0 ? (target - dl[j]) / seg : 0;
    x[i] = dense[j][0] + (dense[j + 1][0] - dense[j][0]) * t;
    z[i] = dense[j][1] + (dense[j + 1][1] - dense[j][1]) * t;
    s[i] = target;
  }
  // Section starts: arc length of the dense sample at each tagged waypoint.
  for (let w = 0; w < WAYPOINTS.length; w++) {
    const section = WAYPOINTS[w].section;
    if (!section) continue;
    let best = 0;
    for (let i = 0; i < dense.length; i++) {
      if (Math.abs(dense[i][2] - w) < Math.abs(dense[best][2] - w)) best = i;
    }
    sectionStart[section] = dl[best];
  }
  // Path elevation follows the mountain profile, lightly smoothed except
  // across the two cliff bands (which must stay sharp steps).
  const raw = new Float32Array(count);
  for (let i = 0; i < count; i++) raw[i] = profile(Math.hypot(x[i] - SUMMIT_X, z[i] - SUMMIT_Z));
  const bandAt = (i: number) => {
    const r = Math.hypot(x[i] - SUMMIT_X, z[i] - SUMMIT_Z);
    return Math.abs(r - ICE_WALL_R) < 12 || Math.abs(r - ROCK_BAND_R) < 12;
  };
  // Distance (in samples) to the nearest cliff-band sample: the smoothing
  // window shrinks to nothing at the bands so their steps stay exact.
  const toBand = new Int32Array(count).fill(1 << 20);
  for (let i = 0, last = -(1 << 20); i < count; i++) {
    if (bandAt(i)) last = i;
    toBand[i] = i - last;
  }
  for (let i = count - 1, last = 1 << 21; i >= 0; i--) {
    if (bandAt(i)) last = i;
    toBand[i] = Math.min(toBand[i], last - i);
  }
  // Wide smoothing spreads the rise of each hairpin over its approach.
  for (let i = 0; i < count; i++) {
    const half = Math.min(ELEV_SMOOTH_SAMPLES, toBand[i], i, count - 1 - i);
    let sum = 0;
    for (let k = -half; k <= half; k++) sum += raw[i + k];
    elev[i] = sum / (2 * half + 1);
  }
  return { x, z, s, elev, count, length, sectionStart };
}

export const route: RouteData = buildRoute();

export const SECTION_ORDER: SectionId[] = [
  'valley',
  'forest',
  'moraine',
  'glacier',
  'icewall',
  'ridge',
  'rockband',
  'summit',
];

export function sectionAt(s: number): SectionId {
  let current: SectionId = 'valley';
  for (const id of SECTION_ORDER) if (s >= route.sectionStart[id]) current = id;
  return current;
}

/** Point on the route at arc length s. */
export function routePoint(s: number): { x: number; z: number; elev: number } {
  const f = clamp(s / SAMPLE_SPACING, 0, route.count - 1);
  const i = Math.min(route.count - 2, Math.floor(f));
  const t = f - i;
  return {
    x: route.x[i] + (route.x[i + 1] - route.x[i]) * t,
    z: route.z[i] + (route.z[i + 1] - route.z[i]) * t,
    elev: route.elev[i] + (route.elev[i + 1] - route.elev[i]) * t,
  };
}

/** Unit tangent (direction of travel) at arc length s. */
export function routeTangent(s: number): { x: number; z: number } {
  const a = routePoint(s - 3);
  const b = routePoint(s + 3);
  const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  return { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
}

// ------------------------------------------------------- projection -------

const CELL = 64;
const REACH = 220;
const grid = new Map<number, number[]>();
const cellKey = (cx: number, cz: number) => (cx + 4096) * 8192 + (cz + 4096);

(function buildIndex() {
  for (let i = 0; i < route.count - 1; i++) {
    const minX = Math.min(route.x[i], route.x[i + 1]) - REACH;
    const maxX = Math.max(route.x[i], route.x[i + 1]) + REACH;
    const minZ = Math.min(route.z[i], route.z[i + 1]) - REACH;
    const maxZ = Math.max(route.z[i], route.z[i + 1]) + REACH;
    for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) {
      for (let cz = Math.floor(minZ / CELL); cz <= Math.floor(maxZ / CELL); cz++) {
        const key = cellKey(cx, cz);
        let list = grid.get(key);
        if (!list) {
          list = [];
          grid.set(key, list);
        }
        list.push(i);
      }
    }
  }
})();

export interface Projection {
  /** Arc length of the nearest route point. */
  s: number;
  /** Signed lateral distance (positive = left of travel direction). */
  d: number;
  /** Unsigned distance. */
  dist: number;
  /** Route floor elevation at s. */
  elev: number;
}

/** Nearest point on the route within REACH metres, or dist = Infinity. */
export function project(x: number, z: number, out: Projection): Projection {
  out.dist = Infinity;
  out.d = 0;
  out.s = 0;
  out.elev = 0;
  const list = grid.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
  if (!list) return out;
  let best = Infinity;
  let bestI = -1;
  let bestT = 0;
  for (const i of list) {
    const ax = route.x[i];
    const az = route.z[i];
    const bx = route.x[i + 1];
    const bz = route.z[i + 1];
    const ex = bx - ax;
    const ez = bz - az;
    const len2 = ex * ex + ez * ez;
    const t = len2 > 0 ? clamp(((x - ax) * ex + (z - az) * ez) / len2, 0, 1) : 0;
    const px = ax + ex * t - x;
    const pz = az + ez * t - z;
    const d2 = px * px + pz * pz;
    if (d2 < best) {
      best = d2;
      bestI = i;
      bestT = t;
    }
  }
  if (bestI < 0) return out;
  const i = bestI;
  const ex = route.x[i + 1] - route.x[i];
  const ez = route.z[i + 1] - route.z[i];
  const len = Math.hypot(ex, ez) || 1;
  // Left of travel: cross product sign in the XZ plane.
  const cross = (ex * (z - route.z[i]) - ez * (x - route.x[i])) / len;
  out.dist = Math.sqrt(best);
  out.d = cross >= 0 ? -out.dist : out.dist;
  out.s = route.s[i] + bestT * (route.s[i + 1] - route.s[i]);
  out.elev = route.elev[i] + bestT * (route.elev[i + 1] - route.elev[i]);
  return out;
}
