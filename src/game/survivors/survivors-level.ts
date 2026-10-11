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
 * The snowfield's long, low swells (m above 0) at a world point: under half
 * a metre high and tens of metres long, so it still plays as a flat field,
 * but the low evening sun catches one side of each swell and leaves the other
 * in blue shade, as it does on the valley floor. Flattens out past the
 * arena's edge.
 */
export function duneHeight(x: number, z: number): number {
  const dx = x - ARENA_X;
  const dz = z - ARENA_Z;
  const r2 = dx * dx + dz * dz;
  if (r2 > 300 * 300) return 0;
  const r = Math.sqrt(r2);
  const fade = r < 250 ? 1 : 1 - (r - 250) / 50;
  const h = Math.sin(dx * 0.11 + Math.sin(dz * 0.05) * 1.7) * 0.55 + Math.sin(dz * 0.09 - dx * 0.04 + 1.3) * 0.45;
  return 0.42 * (h + 1) * 0.5 * fade * fade * (3 - 2 * fade);
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
