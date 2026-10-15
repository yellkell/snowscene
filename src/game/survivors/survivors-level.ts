/**
 * Snow Survivors' level: a wide, gently rolling snowfield with low-poly
 * spruce scattered about. You can pole anywhere inside the arena (a soft
 * wall holds you in a 260 m circle); there is nothing to climb or glide.
 */

import { type Object3D, Vector3 } from '@iwsdk/core';
import type { FogRange, Level } from '../level.js';

/** You can roam this far from the middle. */
export const ARENA_RADIUS = 260;
/** The arena's middle: well away from the tutorial mountain's ground. */
export const ARENA_X = 4000;
export const ARENA_Z = 4000;

/**
 * The hill in the north-east quarter (arena-relative metres): a long whaleback
 * lying across the prevailing westerly, gentle on its windward (west) flank
 * and steeper in its lee, with one old spruce on the crown. You can pole up
 * it; so can the horde.
 */
export const HILL = {
  x: 118,
  z: -110,
  height: 22,
  /** Half-length along the ridge and half-width across it. */
  along: 76,
  across: 56,
  /** The ridge line's heading (radians from +X toward +Z). */
  angle: -0.55,
};
/** Where the lone spruce stands on the crown (arena-relative). */
export const HILL_TREE = { x: HILL.x - 3.5, z: HILL.z + 2.0 };

/** A cosine bell (0..1) over an ellipse; level at its crown and at its foot. */
function bell(u: number, v: number, a: number, b: number): number {
  const q2 = (u / a) ** 2 + (v / b) ** 2;
  return q2 >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * Math.sqrt(q2));
}

/**
 * The hill's height (m) at an arena-relative point: a whaleback, a lower
 * shoulder running off its eastern end and a knoll on its western foot,
 * softly united, with undulations a couple of metres high on the slopes.
 */
export function hillHeight(dx: number, dz: number): number {
  const px = dx - HILL.x;
  const pz = dz - HILL.z;
  const c = Math.cos(HILL.angle);
  const s = Math.sin(HILL.angle);
  const u = px * c + pz * s;
  const v = -px * s + pz * c;
  // Wind from the west: the windward flank (v < 0 after the turn) runs out
  // further, the lee drops away sooner.
  // (blended across the ridge line so the shoulder and knoll stay seamless)
  const across = HILL.across * (1.15 - 0.15 * Math.tanh(v / 12));
  const main = bell(u, v, HILL.along, across);
  const shoulder = 0.45 * bell(u - HILL.along * 0.62, v + 10, HILL.along * 0.55, across * 0.62);
  const knoll = 0.3 * bell(u + HILL.along * 0.68, v - 14, HILL.along * 0.32, across * 0.42);
  const k = 1 - (1 - main) * (1 - shoulder) * (1 - knoll);
  if (k <= 0) return 0;
  // Undulations that leave the crown and the foot alone.
  const lump = Math.sin(u * 0.09 + 1.1) * Math.sin(v * 0.12 - 0.4) + 0.5 * Math.sin(u * 0.23 - v * 0.17 + 2.0);
  return HILL.height * k + lump * k * (1 - k) * 3.5;
}

/**
 * The snowfield's long, low swells (m above 0) at a world point: under half
 * a metre high and tens of metres long, so it still plays as a flat field,
 * but the low evening sun catches one side of each swell and leaves the other
 * in blue shade, as it does on the valley floor. Flattens out past the
 * arena's edge. The hill rises out of the north-east quarter.
 */
export function duneHeight(x: number, z: number): number {
  const dx = x - ARENA_X;
  const dz = z - ARENA_Z;
  const r2 = dx * dx + dz * dz;
  if (r2 > 300 * 300) return 0;
  const r = Math.sqrt(r2);
  const fade = r < 250 ? 1 : 1 - (r - 250) / 50;
  const h = Math.sin(dx * 0.11 + Math.sin(dz * 0.05) * 1.7) * 0.55 + Math.sin(dz * 0.09 - dx * 0.04 + 1.3) * 0.45;
  return 0.42 * (h + 1) * 0.5 * fade * fade * (3 - 2 * fade) + hillHeight(dx, dz);
}

/** Where the head is looking (set every frame by the survivors system), for desktop W. */
export const survivorsView = { yaw: 0 };

export const survivorsLevel: Level = {
  id: 'survivors',
  groundAt: duneHeight,
  desktopWalkSpeed: 3.2,

  walkDirection(_x: number, _z: number, out: Vector3): Vector3 {
    return out.set(-Math.sin(survivorsView.yaw), 0, -Math.cos(survivorsView.yaw));
  },

  constrainWalk(head: Vector3, rig: Object3D, velocity: Vector3): void {
    const dx = head.x - ARENA_X;
    const dz = head.z - ARENA_Z;
    const d = Math.hypot(dx, dz);
    if (d <= ARENA_RADIUS) return;
    const k = (d - ARENA_RADIUS) / d;
    rig.position.x -= dx * k;
    rig.position.z -= dz * k;
    velocity.multiplyScalar(0.5);
  },

  currentWall: () => null,
  launch: () => ({ x: 0, z: 0, floorY: 0, yaw: 0 }),
  glideTarget: new Vector3(0, 0, -100),
  landingShort: 10,
  glideSpeed: 9,

  // The same weather as the valley you land in: a clear, golden evening
  // with a few flakes drifting and a long blue haze (the tutorial's own
  // clear-sky fog), so the arena looks like more of the same mountain.
  stormTarget: () => 0.12,
  fogRange(storm: number, out: FogRange): FogRange {
    const t = Math.pow(Math.min(1, storm / 0.6), 0.55);
    out.near = 120 + (2 - 120) * t;
    out.far = Math.exp(Math.log(9000) + (Math.log(38) - Math.log(9000)) * t);
    return out;
  },

  cloudDeckY: -1000,
};
