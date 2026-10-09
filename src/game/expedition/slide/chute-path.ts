/**
 * The Summit Chute: the way down from the top before the glide home.
 *
 * Like DOWN's slides it is one long, straight, steep ride with three lanes
 * and barriers to lean past, but it runs down the side of the mountain: a
 * carved ice chute that leaves the launch flags by the summit marker, crosses
 * the summit dome, plunges over the rock band on a timber trestle (about 55
 * degrees) and drops down the ridge face (40 degrees and more) toward Base
 * Camp, to a timber deck just above the ice cliff. You unpack the glider
 * there and fly the rest of the way home.
 *
 * Pure maths (no Three.js), shared by the builder, the ride and the world
 * layout (which keeps boulders off the line).
 */

import { BAND_HALF_WIDTH, ICE_WALL_R, ROCK_BAND_R, SUMMIT_X, SUMMIT_Z, routePoint } from '../exp-route.js';
import { CAMPS, campCentre, SUMMIT_S } from '../exp-layout.js';
import { expeditionHeight } from '../exp-terrain.js';

/** Half width of the icy bed, and how high the side walls stand. */
export const CHUTE_HALF = 1.2;
export const CHUTE_WALL = 0.55;
/** The three lanes across the bed, along the rider's right. */
export const LANE_X = [-0.6, 0, 0.6];
/** The start gate stands this far past the summit marker. */
const GATE_PAST_MARKER = 8;
/** The line is turned this far west of Base Camp to stay well clear of the route. */
const BEARING_OFFSET = -0.03;
/** The ride ends on a deck this far inside the ice cliff's edge. */
const END_R = ICE_WALL_R - BAND_HALF_WIDTH - 6;
/** Steepest the bed may drop where it leaves the ground (tan 55 degrees). */
const MAX_DROP = Math.tan((55 * Math.PI) / 180);
/** Flat run-in at the gate and the braking run onto the deck (plan metres). */
const RUN_IN = 6;
const RUN_OUT = 26;
const DECK = 7;
/** Bed clearance over the snow (it is carved in, a hand's depth proud). */
const CLEARANCE = 0.12;

export interface ChuteSample {
  x: number;
  y: number;
  z: number;
  /** Downhill angle of the bed (radians, > 0 descending). */
  slope: number;
  /** Bed height above the ground under it (trestle height). */
  lift: number;
}

export type BarrierKind = 'ice' | 'rock' | 'gate';

export interface Barrier {
  s: number;
  lane: number;
  kind: BarrierKind;
}

export interface ChuteData {
  /** Plan direction downhill (unit) and the rider's right (unit). */
  dirX: number;
  dirZ: number;
  rightX: number;
  rightZ: number;
  /** World yaw facing down the chute (yaw 0 faces -Z). */
  yaw: number;
  /** Plan distance and bed arc length at each 1 m plan sample. */
  u: Float32Array;
  s: Float32Array;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  ground: Float32Array;
  slope: Float32Array;
  /** Total bed length (m). */
  length: number;
  /** Arc length of the lip over the rock band. */
  lipS: number;
  /** Restart points after a crash (arc lengths). */
  checkpoints: number[];
  barriers: Barrier[];
  /** Where the deck ends: take off from here, facing down the line. */
  launch: { x: number; z: number; floorY: number; yaw: number };
}

const radius = (x: number, z: number) => Math.hypot(x - SUMMIT_X, z - SUMMIT_Z);

/**
 * Gate patterns (lanes blocked at each barrier row), after DOWN's: single
 * blocks leave two ways through, doubles force one opening.
 */
const EASY = [[0], [2], [1], [0], [2], [1], [2], [0]];
const HARD = [[1], [0, 1], [2], [0], [1, 2], [0, 2], [1], [2], [0, 1], [1], [0, 2]];

function build(): ChuteData {
  const marker = routePoint(SUMMIT_S);
  const home = campCentre(CAMPS[0]);
  let dx = home.x - marker.x;
  let dz = home.z - marker.z;
  const len = Math.hypot(dx, dz) || 1;
  dx /= len;
  dz /= len;
  const c = Math.cos(BEARING_OFFSET);
  const sn = Math.sin(BEARING_OFFSET);
  // Rotate about +Y; a negative offset swings the line west (toward -x here).
  const dirX = dx * c + dz * sn;
  const dirZ = -dx * sn + dz * c;
  // Facing down the line, the rider's right is (-dirZ, dirX).
  const rightX = -dirZ;
  const rightZ = dirX;
  const x0 = marker.x + dirX * GATE_PAST_MARKER;
  const z0 = marker.z + dirZ * GATE_PAST_MARKER;

  // Plan samples down to the deck above the ice cliff.
  let n = 0;
  while (radius(x0 + dirX * n, z0 + dirZ * n) < END_R && n < 4000) n++;
  const rows = n + 1;
  const u = new Float32Array(rows);
  const x = new Float32Array(rows);
  const z = new Float32Array(rows);
  const ground = new Float32Array(rows);
  for (let i = 0; i < rows; i++) {
    u[i] = i;
    x[i] = x0 + dirX * i;
    z[i] = z0 + dirZ * i;
    // The bed must clear the snow across its whole width.
    let g = -Infinity;
    for (const lat of [-CHUTE_HALF - 0.2, 0, CHUTE_HALF + 0.2]) {
      g = Math.max(g, expeditionHeight(x[i] + rightX * lat, z[i] + rightZ * lat));
    }
    ground[i] = g;
  }

  // Bed: hug the ground, but never drop faster than MAX_DROP (it bridges the
  // rock band on a trestle instead), then smooth out the snow's lumps.
  const raw = new Float32Array(rows);
  for (let i = 0; i < rows; i++) {
    const floor = ground[i] + CLEARANCE;
    raw[i] = i === 0 ? floor : Math.max(floor, raw[i - 1] - MAX_DROP);
  }
  const y = new Float32Array(rows);
  const W = 3;
  for (let i = 0; i < rows; i++) {
    let sum = 0;
    let count = 0;
    for (let k = Math.max(0, i - W); k <= Math.min(rows - 1, i + W); k++) {
      sum += raw[k];
      count++;
    }
    y[i] = Math.max(sum / count, ground[i] + CLEARANCE);
  }
  // A level run-in at the gate.
  for (let i = 0; i < Math.min(rows, RUN_IN); i++) y[i] = Math.max(y[RUN_IN], ground[i] + CLEARANCE);
  // Braking run onto a level deck: the grade eases off to flat.
  const ro = Math.max(0, rows - 1 - RUN_OUT - DECK);
  const grade = ro > 0 ? (y[ro - 1] - y[ro]) : 0.7;
  for (let i = ro; i < rows; i++) {
    const t = Math.min(1, (i - ro) / RUN_OUT);
    // Integral of a grade falling linearly from `grade` to 0 over RUN_OUT.
    const drop = grade * RUN_OUT * (t - (t * t) / 2);
    y[i] = Math.max(y[ro] - drop, ground[i] + CLEARANCE);
  }
  const deckY = y[rows - 1 - DECK];
  for (let i = rows - DECK; i < rows; i++) y[i] = Math.max(deckY, ground[i] + CLEARANCE);

  // Arc length and slope along the bed.
  const s = new Float32Array(rows);
  const slope = new Float32Array(rows);
  for (let i = 1; i < rows; i++) s[i] = s[i - 1] + Math.hypot(1, y[i] - y[i - 1]);
  for (let i = 0; i < rows; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(rows - 1, i + 1);
    slope[i] = Math.atan2(y[a] - y[b], b - a);
  }
  const length = s[rows - 1];

  // Landmarks: the rock band lip and the middle of the ridge face.
  const sAtRadius = (r: number) => {
    for (let i = 0; i < rows; i++) if (radius(x[i], z[i]) >= r) return s[i];
    return length;
  };
  const lipS = sAtRadius(ROCK_BAND_R - BAND_HALF_WIDTH - 2);
  const midS = sAtRadius((ROCK_BAND_R + ICE_WALL_R) / 2);
  const checkpoints = [0, Math.max(0, lipS - 14), midS];

  // Barrier rows: easy over the dome, harder down the face, none on the
  // trestle, near a restart point or on the braking run.
  const barriers: Barrier[] = [];
  const kinds: BarrierKind[] = ['ice', 'rock', 'gate'];
  const brakeS = s[Math.max(0, ro - 8)];
  let row = 0;
  let at = 34;
  while (at < brakeS) {
    const i = indexAt(s, at);
    const lift = y[i] - ground[i];
    const nearCheckpoint = checkpoints.some((cp) => at > cp - 4 && at < cp + 22);
    const onFace = at > lipS;
    if (lift < 1.2 && !nearCheckpoint) {
      const pattern = onFace ? HARD : EASY;
      const lanes = pattern[row % pattern.length];
      const kind = kinds[(row * 7 + 3) % kinds.length];
      for (const lane of lanes) barriers.push({ s: at, lane, kind });
      row++;
    }
    at += onFace ? 21 : 27;
  }

  const yaw = Math.atan2(-dirX, -dirZ);
  const end = rows - 2;
  return {
    dirX,
    dirZ,
    rightX,
    rightZ,
    yaw,
    u,
    s,
    x,
    y,
    z,
    ground,
    slope,
    length,
    lipS,
    checkpoints,
    barriers,
    launch: { x: x[end], z: z[end], floorY: y[end], yaw },
  };
}

function indexAt(s: Float32Array, at: number): number {
  let lo = 0;
  let hi = s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid] <= at) lo = mid;
    else hi = mid;
  }
  return lo;
}

let data: ChuteData | null = null;

/** The chute (built on first use). */
export function chute(): ChuteData {
  data ??= build();
  return data;
}

/** Bed point and slope at arc length `s` (clamped to the chute). */
export function chuteSample(at: number, out: ChuteSample): ChuteSample {
  const c = chute();
  const s = Math.min(Math.max(at, 0), c.length);
  const i = Math.min(indexAt(c.s, s), c.s.length - 2);
  const t = (s - c.s[i]) / Math.max(1e-6, c.s[i + 1] - c.s[i]);
  out.x = c.x[i] + (c.x[i + 1] - c.x[i]) * t;
  out.y = c.y[i] + (c.y[i + 1] - c.y[i]) * t;
  out.z = c.z[i] + (c.z[i + 1] - c.z[i]) * t;
  out.slope = c.slope[i] + (c.slope[i + 1] - c.slope[i]) * t;
  out.lift = out.y - (c.ground[i] + (c.ground[i + 1] - c.ground[i]) * t);
  return out;
}

/** Riding speed at a point: steeper is faster (m/s). */
export function chuteSpeed(slope: number): number {
  return Math.min(27, Math.max(18, 16 + 14 * Math.sin(Math.max(0, slope))));
}

/** Distance (plan) from (x, z) to the chute's centre line, and whether it is alongside it. */
export function chuteDistance(x: number, z: number): number {
  const c = chute();
  const ox = x - c.x[0];
  const oz = z - c.z[0];
  const along = ox * c.dirX + oz * c.dirZ;
  const last = c.u[c.u.length - 1];
  const across = Math.abs(ox * c.rightX + oz * c.rightZ);
  if (along < 0) return Math.hypot(along, across);
  if (along > last) return Math.hypot(along - last, across);
  return across;
}
