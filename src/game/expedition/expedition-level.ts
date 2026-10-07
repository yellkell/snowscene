/**
 * The expedition as a Level: 7.8 km of route from Base Camp to the 1,300 m
 * summit, two climbs (the ice wall with axes, the rock band on holds), a
 * summit launch and a ~3 km glide back down to the Base Camp party.
 *
 * Walking rules live in `director/walk-rules.ts` (pure, node-checked);
 * this file applies them to the rig and wires the level into the shared
 * pole / climb / glide / weather systems. The director installs
 * `expLevelHooks` for the parts that need the world (facing, checkpoints,
 * rescues).
 */

import { type Object3D, Vector3 } from '@iwsdk/core';
import { audio } from '../audio.js';
import { equipPair, stowAll } from '../equipment.js';
import type { ClimbWall, LaunchSite, Level } from '../level.js';
import { fadeThen, game, Phase, setPhase } from '../state.js';
import { clamp, project, type Projection, routePoint, sectionAt } from './exp-route.js';
import {
  bridgeHeight,
  CAMPS,
  campCentre,
  CREVASSE_S,
  EXP_CLOUD_DECK_Y,
  ladderHeight,
  RIVER_S,
  routeFrame,
  SUMMIT_S,
} from './exp-layout.js';
import { exp, expFrame, expHooks } from './exp-state.js';
import { expeditionHeight } from './exp-terrain.js';
import { walkGate } from './mechanics/walk-gate.js';
import { expControl } from './director/exp-control.js';
import { pointAt, type RouteDir, type RoutePos, tangentAt, yawOf } from './director/route-math.js';
import { drawExpeditionMap } from './director/topo-map.js';
import { newWalkResult, SUMMIT_FREE_RADIUS, walkRules, WALLS, type WallId } from './director/walk-rules.js';

/** Desktop walking speed (m/s); hold Shift for the testing sprint. */
const DESKTOP_SPEED = 7;
const DESKTOP_SPRINT = 20;

/** Set by the director from the keyboard. */
export const expInput = { sprint: false };

/** Installed by the director; defaults keep the level usable on its own. */
export const expLevelHooks = {
  /** A climb was topped out (after the level has handed back the poles). */
  wallTopped: (_id: WallId) => {},
  /** The flare was fired: return the message and maybe schedule a rescue. */
  flare: (): string => 'Your flare lights up the sky',
};

// ------------------------------------------------------------ ground ----

const RIVER_FRAME = routeFrame(RIVER_S);
const CREVASSE_FRAME = routeFrame(CREVASSE_S);

/** Walkable height: the log bridge, the crevasse ladder, else the terrain. */
function groundAt(x: number, z: number): number {
  let dx = x - RIVER_FRAME.x;
  let dz = z - RIVER_FRAME.z;
  if (dx * dx + dz * dz < 20 * 20) {
    const b = bridgeHeight(x, z);
    if (b !== null) return b;
  }
  dx = x - CREVASSE_FRAME.x;
  dz = z - CREVASSE_FRAME.z;
  if (dx * dx + dz * dz < 10 * 10) {
    const l = ladderHeight(x, z);
    if (l !== null) return l;
  }
  return expeditionHeight(x, z);
}

// ----------------------------------------------------------- progress ----

const trackProj: Projection = { s: 0, d: 0, dist: 0, elev: 0 };

/** Project the head onto the route and publish s / d / head / section. */
export function trackProgress(x: number, y: number, z: number): void {
  expFrame.head.set(x, y, z);
  project(x, z, trackProj);
  if (trackProj.dist !== Infinity) {
    expFrame.s = trackProj.s;
    expFrame.d = trackProj.d;
  }
  const section = sectionAt(expFrame.s);
  if (exp.section.peek() !== section) exp.section.value = section;
}

// -------------------------------------------------------------- walls ----

let activeWall: WallId | null = null;

/** Which band is being climbed (null when walking). */
export function expeditionWall(): WallId | null {
  return activeWall;
}

function makeWall(id: WallId): ClimbWall {
  const band = WALLS[id];
  const axes = id === 'ice';
  // Floor where the climber actually stands, just out from the face.
  const footY = expeditionHeight(band.baseX + band.nx * 0.9, band.baseZ + band.nz * 0.9);
  const baseY = Math.max(band.baseY, footY);
  return {
    id: axes ? 'expedition-ice-wall' : 'expedition-rock-band',
    base: new Vector3(band.baseX, baseY, band.baseZ),
    normal: new Vector3(band.nx, 0, band.nz),
    laneWidth: axes ? 6 : 5,
    baseY,
    topY: band.topY,
    topStand: new Vector3(band.topX, band.topY, band.topZ),
    mode: axes ? 'axes' : 'holds',
    standoff: axes ? 0.5 : 0.45,
    onTop: () => {
      audio.fanfare();
      equipPair('poles');
      activeWall = null;
      expControl.wall.value = null;
      game.velocity.set(0, 0, 0);
      setPhase(Phase.Poling);
      expLevelHooks.wallTopped(id);
    },
  };
}

let walls: Record<WallId, ClimbWall> | null = null;

function wallFor(id: WallId): ClimbWall {
  if (!walls) walls = { ice: makeWall('ice'), rock: makeWall('rock') };
  return walls[id];
}

/** Start climbing a band: tools in hand, then the Climbing phase. */
export function startClimb(id: WallId): void {
  activeWall = id;
  expControl.wall.value = id;
  game.velocity.set(0, 0, 0);
  if (id === 'ice') equipPair('axes');
  else stowAll();
  setPhase(Phase.Climbing);
}

/** Forget any climb in progress (respawn / restart). */
export function resetClimb(): void {
  activeWall = null;
  expControl.wall.value = null;
}

// -------------------------------------------------------------- launch ----

let launchSite: LaunchSite | null = null;

/** The summit launch: 10 m past the summit marker toward Base Camp, facing it. */
function computeLaunch(): LaunchSite {
  const m = routePoint(SUMMIT_S);
  const b = campCentre(CAMPS[0]);
  const len = Math.hypot(b.x - m.x, b.z - m.z) || 1;
  const dx = (b.x - m.x) / len;
  const dz = (b.z - m.z) / len;
  const x = m.x + dx * 10;
  const z = m.z + dz * 10;
  return { x, z, floorY: groundAt(x, z), yaw: yawOf(dx, dz) };
}

const baseCamp = campCentre(CAMPS[0]);

// ---------------------------------------------------------- the level ----

const walk = newWalkResult();
const dirProj: Projection = { s: 0, d: 0, dist: 0, elev: 0 };
const dirTan: RouteDir = { x: 0, z: 0 };
const lostPos: RoutePos = { x: 0, z: 0, elev: 0 };
const deployProj: Projection = { s: 0, d: 0, dist: 0, elev: 0 };
let gateToastAt = -Infinity;

export const expeditionLevel: Level = {
  id: 'expedition',
  groundAt,

  get desktopWalkSpeed(): number {
    return expInput.sprint ? DESKTOP_SPRINT : DESKTOP_SPEED;
  },

  walkDirection(x: number, z: number, out: Vector3): Vector3 {
    project(x, z, dirProj);
    const onRoute = dirProj.dist !== Infinity;
    const s = onRoute ? dirProj.s : expFrame.s;
    const d = onRoute ? dirProj.d : 0;
    tangentAt(s + 2, dirTan);
    // Steer back toward the centre line (left normal is (tz, -tx); d > 0 is left).
    const steer = clamp(-d * 0.18, -0.45, 0.45);
    out.set(dirTan.x + dirTan.z * steer, 0, dirTan.z - dirTan.x * steer);
    return out.normalize();
  },

  constrainWalk(head: Vector3, rig: Object3D, velocity: Vector3, dt: number): void {
    walkRules(head.x, head.z, head.y, expFrame.s, dt, walk);
    if (walk.lost) {
      // Somehow far off the route: put the head back where we last knew it.
      pointAt(expFrame.s, lostPos);
      rig.position.x += lostPos.x - head.x;
      rig.position.z += lostPos.z - head.z;
      velocity.set(0, 0, 0);
      return;
    }
    if (walk.dx !== 0 || walk.dz !== 0) {
      rig.position.x += walk.dx;
      rig.position.z += walk.dz;
      // Drop the part of the velocity that pushes against the correction.
      const len = Math.hypot(walk.dx, walk.dz);
      const ux = walk.dx / len;
      const uz = walk.dz / len;
      const vd = velocity.x * ux + velocity.z * uz;
      if (vd < 0) {
        velocity.x -= ux * vd;
        velocity.z -= uz * vd;
      }
    }
    const speed = Math.hypot(velocity.x, velocity.z);
    if (speed > walk.speedCap) velocity.multiplyScalar(walk.speedCap / speed);
    if (walk.blocked) {
      const now = performance.now() / 1000;
      if (now - gateToastAt > 6) {
        gateToastAt = now;
        expHooks.toast(walkGate.reason || "You can't go on yet", 4);
      }
    }
    trackProgress(head.x + walk.dx, head.y, head.z + walk.dz);
    if (walk.climb && game.phase.peek() === Phase.Poling) startClimb(walk.climb);
  },

  currentWall(): ClimbWall | null {
    if (!activeWall) {
      // Climbing started some other way (debug): take the nearer band.
      activeWall =
        Math.abs(expFrame.s - WALLS.ice.s) < Math.abs(expFrame.s - WALLS.rock.s) ? 'ice' : 'rock';
      expControl.wall.value = activeWall;
    }
    return wallFor(activeWall);
  },

  launch(): LaunchSite {
    if (!launchSite) launchSite = computeLaunch();
    return launchSite;
  },

  glideTarget: new Vector3(baseCamp.x, baseCamp.elev, baseCamp.z),
  landingShort: 30,
  glideSpeed: 14,
  // 1,300 m down over ~3 km: a steeper assisted glide, with terrain lift
  // over the ridges on the way (see glide-system).
  glideAssist: { maxSink: 9, weight: 1, clearance: 25 },

  stormTarget(): number {
    return expFrame.storm;
  },

  cloudDeckY: EXP_CLOUD_DECK_Y,

  drawMap(ctx: CanvasRenderingContext2D, size: number, you: Vector3, yaw: number): void {
    drawExpeditionMap(ctx, size, you, yaw);
  },

  gliderDeployBlocker(head: Vector3): string | null {
    if (game.phase.peek() !== Phase.Poling) return 'Not now';
    if (!exp.summited.peek()) return 'Save it for the summit';
    project(head.x, head.z, deployProj);
    const m = routePoint(SUMMIT_S);
    const nearMarker = Math.hypot(head.x - m.x, head.z - m.z) < SUMMIT_FREE_RADIUS;
    if (!nearMarker && (deployProj.dist === Infinity || deployProj.s < SUMMIT_S - 4)) {
      return 'Carry it to the summit marker';
    }
    return null;
  },

  deployGlider(): void {
    fadeThen(() => {
      stowAll();
      game.velocity.set(0, 0, 0);
      setPhase(Phase.Launch);
    });
  },

  onFlare(): string {
    return expLevelHooks.flare();
  },
};
