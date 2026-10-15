/**
 * The tutorial mountain as a Level: a short pole trail, one 6.6 m cliff with
 * placed holds, the cave in the bluff behind the summit, a glider build on
 * the beacon deck on top of that bluff, and a glide straight down to the party on the frozen
 * lake.
 */

import { Object3D, Vector3 } from '@iwsdk/core';
import { audio } from './audio.js';
import { FIRE_POS } from './campfire.js';
import type { ClimbWall, FogRange, Level } from './level.js';
import { LAUNCH_EDGE } from './cave-bluff.js';
import { CLIMB_TRIGGER_S, game, Phase, setPhase, SUMMIT_STAND } from './state.js';
import {
  clamp,
  CLIFF_BASE_Y,
  CLIFF_CENTER_X,
  CLOUD_SEA_Y,
  LAKE_CENTER_X,
  LAKE_CENTER_Z,
  LAKE_RADIUS_X,
  LAKE_RADIUS_Z,
  LAKE_Y,
  pathX,
  smoothstep,
  SUMMIT_Y,
  terrainHeight,
  TRAIL_HALF_WIDTH,
  WALL_S,
  WALL_Z,
} from './terrain.js';

const LANDING_SHORT_OF_FIRE = 26;

function groundAt(x: number, z: number): number {
  const lx = (x - LAKE_CENTER_X) / (LAKE_RADIUS_X * 0.88);
  const lz = (z - LAKE_CENTER_Z) / (LAKE_RADIUS_Z * 0.88);
  const h = terrainHeight(x, z);
  return lx * lx + lz * lz < 1 ? Math.max(h, LAKE_Y) : h;
}

const wall: ClimbWall = {
  id: 'tutorial-cliff',
  base: new Vector3(CLIFF_CENTER_X, CLIFF_BASE_Y, WALL_Z),
  normal: new Vector3(0, 0, 1),
  laneWidth: 4.8,
  baseY: CLIFF_BASE_Y,
  topY: SUMMIT_Y,
  topStand: new Vector3(SUMMIT_STAND.x, SUMMIT_Y, SUMMIT_STAND.z),
  standoff: 0.45,
  onTop: () => {
    audio.fanfare();
    // The kit on the summit is empty: its parts are up in the cave.
    setPhase(Phase.Cave);
  },
};

export const tutorialLevel: Level = {
  id: 'tutorial',
  groundAt,

  walkDirection(x: number, z: number, out: Vector3): Vector3 {
    // Follow the trail uphill, gently steering back to the centre line.
    out.set(pathX(z - 1) - pathX(z), 0, -1).normalize();
    out.x += clamp((pathX(z) - x) * 0.15, -0.3, 0.3);
    return out.normalize();
  },

  constrainWalk(head: Vector3, rig: Object3D, velocity: Vector3): void {
    let s = -head.z;
    const lateral = head.x - pathX(head.z);
    const clampedLateral = clamp(lateral, -TRAIL_HALF_WIDTH, TRAIL_HALF_WIDTH);
    if (clampedLateral !== lateral) {
      rig.position.x += clampedLateral - lateral;
      velocity.x *= 0.5;
    }
    const clampedS = clamp(s, -6, WALL_S - 0.6);
    if (clampedS !== s) {
      rig.position.z -= clampedS - s;
      velocity.z = 0;
      s = clampedS;
    }
    const remaining = Math.max(0, Math.round(WALL_S - s));
    if (game.distanceToCliff.peek() !== remaining) game.distanceToCliff.value = remaining;
    if (s >= CLIMB_TRIGGER_S) {
      velocity.set(0, 0, 0);
      setPhase(Phase.Climbing);
    }
  },

  currentWall: () => wall,

  // Off the open south edge of the beacon deck, facing the lake.
  launch: () => ({ x: LAUNCH_EDGE.x, z: LAUNCH_EDGE.z, floorY: LAUNCH_EDGE.y, yaw: Math.PI }),

  glideTarget: FIRE_POS,
  landingShort: LANDING_SHORT_OF_FIRE,
  glideSpeed: 9,

  stormTarget(head: Vector3): number {
    const s = -head.z;
    switch (game.phase.peek()) {
      case Phase.Poling:
        // A proper blizzard that worsens as you climb.
        return 0.55 + 0.4 * smoothstep(5, 60, s);
      case Phase.Climbing:
        // Still a blizzard, a notch short of the worst: the wall fills your
        // view and every flake in front of it is drawn over it.
        return 0.85;
      case Phase.Cave:
      case Phase.Beacon:
      case Phase.Building:
        // Breaking through the top of the storm: the sky clears.
        return 0.06;
      case Phase.Launch:
        return 0.03;
      case Phase.Gliding:
        return 0.05;
      default:
        return 0.12;
    }
  },

  cloudDeckY: CLOUD_SEA_Y,

  fogRange(storm: number, out: FogRange): FogRange {
    // A little haze even on a clear day, closing in fast as the snow
    // thickens: thick fog from the trailhead (about 55 m), about 40 m on
    // the cliff, a couple of kilometres of haze once you are above the storm.
    const t = Math.pow(Math.min(1, storm / 0.6), 0.55);
    out.near = 120 + (2 - 120) * t;
    out.far = Math.exp(Math.log(9000) + (Math.log(38) - Math.log(9000)) * t);
    return out;
  },

  cloudLanding: () => ({
    x: FIRE_POS.x,
    z: FIRE_POS.z - LANDING_SHORT_OF_FIRE,
    yaw: Math.PI,
  }),
};
