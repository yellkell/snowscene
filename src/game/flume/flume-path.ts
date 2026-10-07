/**
 * The log flume that spirals down the Needle, from the beacon deck on top to
 * the summit shoulder at its foot. Like HELTER's slide it is parametrised by
 * arc length `s`: two tiers, each a flat run-up, a descending helix and a
 * flat arrival, with a holding bay between them.
 *
 * Pure maths (no meshes), shared by the builder and the ride.
 */

import { Vector3 } from '@iwsdk/core';
import { SUMMIT_Y, terrainHeight } from '../terrain.js';

/** The rock needle on the summit shoulder that holds the ice cave. */
export const NEEDLE = { x: -3, z: -93, base: SUMMIT_Y - 3, top: 55, baseR: 6.6, topR: 4.5 };
/** Radius of the needle's rock at height y. */
export function needleRadius(y: number): number {
  const t = Math.min(1, Math.max(0, (y - NEEDLE.base) / (NEEDLE.top - NEEDLE.base)));
  return NEEDLE.baseR + (NEEDLE.topR - NEEDLE.baseR) * Math.pow(t, 0.8);
}

/** Centreline radius of the flume around the needle's axis. */
export const FLUME_R = 9.6;
export const FLUME_PITCH = (10 * Math.PI) / 180;
export const TRACK_WIDTH = 2.3;
export const OUTER_LIP = 0.85;
export const INNER_LIP = 0.45;
/** The three lanes across the flume, along the rider's right. */
export const LANE_X = [-0.55, 0, 0.55];
/** Flume speed along the bed (m/s) and the eased launch. */
export const SLIDE_SPEED = 9;
export const SLIDE_ACCEL_TIME = 1.4;

const START_RUN = 6;
const BAY_HALF = 2.5;
const ARRIVAL = 4;
/** The run ends on the needle's north side, behind it as seen from the summit. */
const END_ANGLE = -Math.PI / 2;
/** The flume starts level with the beacon deck. */
export const START_Y = NEEDLE.top + 0.05;

export interface FlumeSample {
  position: Vector3;
  forward: Vector3;
  /** The rider's right (the rig's local +x), horizontal. */
  right: Vector3;
  yaw: number;
  angle: number;
  flat: boolean;
}

interface Segment {
  s0: number;
  length: number;
  angle0: number;
  y0: number;
  slope: number;
  turn: number;
}

export interface Tier {
  index: number;
  s0: number;
  s1: number;
  helixS0: number;
  helixS1: number;
}

/** Floor height of the arrival bay: clear of the snow along its length. */
function endY(): number {
  let h = -Infinity;
  for (let k = 0; k <= 8; k++) {
    const a = END_ANGLE - ((k / 8) * ARRIVAL) / FLUME_R;
    for (const r of [-1.3, 0, 1.3]) {
      const x = NEEDLE.x + Math.cos(a) * (FLUME_R + r);
      const z = NEEDLE.z + Math.sin(a) * (FLUME_R + r);
      h = Math.max(h, terrainHeight(x, z));
    }
  }
  return h + 0.5;
}

export class FlumePath {
  readonly segments: Segment[] = [];
  readonly tiers: Tier[] = [];
  readonly totalLength: number;
  readonly endY: number;

  constructor() {
    this.endY = endY();
    const sinP = Math.sin(FLUME_PITCH);
    const cosP = Math.cos(FLUME_PITCH);
    const drop = START_Y - this.endY;
    const helix = drop / 2 / sinP;
    const flatTurn = 1 / FLUME_R;
    const helixTurn = cosP / FLUME_R;
    const totalTurn = (START_RUN + BAY_HALF * 2 + ARRIVAL) * flatTurn + 2 * helix * helixTurn;

    let s = 0;
    let angle = END_ANGLE - totalTurn;
    let y = START_Y;
    const push = (length: number, slope: number, turn: number) => {
      this.segments.push({ s0: s, length, angle0: angle, y0: y, slope, turn });
      s += length;
      angle += turn * length;
      y -= slope * length;
    };
    for (let i = 0; i < 2; i++) {
      const tierS0 = s;
      push(i === 0 ? START_RUN : BAY_HALF, 0, flatTurn);
      const helixS0 = s;
      push(helix, sinP, helixTurn);
      const helixS1 = s;
      push(i === 0 ? BAY_HALF : ARRIVAL, 0, flatTurn);
      this.tiers.push({ index: i, s0: tierS0, s1: s, helixS0, helixS1 });
    }
    this.totalLength = s;
  }

  private segmentAt(s: number): Segment {
    for (let i = this.segments.length - 1; i >= 0; i--) if (s >= this.segments[i].s0) return this.segments[i];
    return this.segments[0];
  }

  sample(s: number, out: FlumeSample): FlumeSample {
    const c = Math.max(0, Math.min(this.totalLength, s));
    const seg = this.segmentAt(c);
    const ds = c - seg.s0;
    const angle = seg.angle0 + seg.turn * ds;
    out.angle = angle;
    out.flat = seg.slope === 0;
    out.position.set(
      NEEDLE.x + Math.cos(angle) * FLUME_R,
      seg.y0 - seg.slope * ds,
      NEEDLE.z + Math.sin(angle) * FLUME_R,
    );
    const horiz = seg.turn * FLUME_R;
    out.forward.set(-Math.sin(angle) * horiz, -seg.slope, Math.cos(angle) * horiz).normalize();
    out.yaw = Math.atan2(-out.forward.x, -out.forward.z);
    out.right.set(Math.cos(out.yaw), 0, -Math.sin(out.yaw));
    return out;
  }

  static makeSample(): FlumeSample {
    return { position: new Vector3(), forward: new Vector3(), right: new Vector3(), yaw: 0, angle: 0, flat: true };
  }
}

export const flumePath = new FlumePath();

/**
 * Hazards per tier: each entry is the set of lanes blocked at that gantry.
 * One-lane gantries leave two ways through; two-lane gantries force one.
 */
export const HAZARD_PATTERNS: number[][][] = [
  [[0], [2], [1], [0, 1], [2], [1, 2], [0]],
  [[1], [0, 2], [2], [0, 1], [1], [1, 2], [0], [0, 2], [2]],
];
export const HAZARD_SPACING = [11, 9.5];

export interface Hazard {
  s: number;
  tier: number;
  lane: number;
  /** Which prop hangs there: a timber board, a clump of icicles or an ore bucket. */
  kind: 'board' | 'icicles' | 'bucket';
}

export function layoutHazards(): Hazard[] {
  const out: Hazard[] = [];
  const kinds: Hazard['kind'][] = ['board', 'icicles', 'bucket'];
  flumePath.tiers.forEach((tier, i) => {
    const pattern = HAZARD_PATTERNS[i];
    const spacing = HAZARD_SPACING[i];
    const count = Math.min(pattern.length, Math.floor((tier.helixS1 - tier.helixS0 - 14) / spacing));
    for (let k = 0; k < count; k++) {
      const s = tier.helixS0 + 9 + k * spacing;
      for (const lane of pattern[k]) out.push({ s, tier: i, lane, kind: kinds[(k + lane + i) % 3] });
    }
  });
  return out;
}
