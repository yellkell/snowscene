/**
 * Snow Survivors' level: a flat, endless-looking snowfield with low-poly
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

/** Where the head is looking (set every frame by the survivors system), for desktop W. */
export const survivorsView = { yaw: 0 };

export const survivorsLevel: Level = {
  id: 'survivors',
  groundAt: () => 0,
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

  // Light snow, and a mist the horde comes out of.
  stormTarget: () => 0.2,
  fogRange(_storm: number, out: FogRange): FogRange {
    out.near = 22;
    out.far = 150;
    return out;
  },

  cloudDeckY: -1000,
};
