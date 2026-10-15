/**
 * The active level (the tutorial mountain or the Snow Survivors arena).
 * Shared systems — poling, climbing, gliding, weather — ask the level for ground
 * heights, walking rules, climbing walls, the launch site and the glide
 * target instead of hard-coding one mountain.
 */

import { Object3D, signal, Vector3 } from '@iwsdk/core';

export type LevelId = 'tutorial' | 'survivors';

/** A climbable face, treated as a vertical plane with a lane on it. */
export interface ClimbWall {
  id: string;
  /** Point on the face at the bottom centre of the climbing lane. */
  base: Vector3;
  /** Horizontal unit normal pointing out of the face, toward the climber. */
  normal: Vector3;
  /** Width of the climbable lane in metres. */
  laneWidth: number;
  /** Floor height at the foot of the wall and at the top lip. */
  baseY: number;
  topY: number;
  /** Where the climber stands (floor position) after hauling over the top. */
  topStand: Vector3;
  /** Head is kept at least this far off the face. */
  standoff: number;
  /** Called once the climber has topped out. */
  onTop: () => void;
}

export interface LaunchSite {
  /** Head position (x, z) and floor height at the launch edge. */
  x: number;
  z: number;
  floorY: number;
  /** World yaw to face for take-off (yaw 0 faces -Z). */
  yaw: number;
}

/** Linear fog distances (metres) for a storm level. */
export interface FogRange {
  near: number;
  far: number;
}

export interface Level {
  id: LevelId;
  /** Walkable surface height: terrain and ice. */
  groundAt(x: number, z: number): number;
  /** Desktop (keyboard) walking speed, m/s. */
  desktopWalkSpeed?: number;
  /** Preferred walking direction at a point (desktop W key and hints). */
  walkDirection(x: number, z: number, out: Vector3): Vector3;
  /**
   * Keep a walking player on the route. Moves `rig` as needed and may change
   * phase (e.g. arriving at a wall). `head` is the current head position.
   */
  constrainWalk(head: Vector3, rig: Object3D, velocity: Vector3, dt: number): void;
  /** The wall to climb when the Climbing phase starts. */
  currentWall(): ClimbWall | null;
  launch(): LaunchSite;
  /** Where the glide assist steers, and how far short of it to land. */
  glideTarget: Vector3;
  landingShort: number;
  /** Cruise airspeed for this level's glider (m/s). */
  glideSpeed: number;
  /** Storm level the weather should head toward right now (0..1). */
  stormTarget(head: Vector3): number;
  /** Height of the cloud deck (sea of clouds). */
  cloudDeckY: number;
  /** Fog distances for a storm level (0..1); the weather's default curve if absent. */
  fogRange?(storm: number, out: FogRange): FogRange;
  /** Called when the glide passes below the cloud deck over open air. */
  cloudLanding?(): { x: number; z: number; yaw: number } | null;
}

/** The current level; systems read `level.peek()` every frame. */
export const level = signal<Level | null>(null);

export function currentLevel(): Level {
  const l = level.peek();
  if (!l) throw new Error('No active level');
  return l;
}
