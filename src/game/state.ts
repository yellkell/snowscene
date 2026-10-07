/**
 * Shared game state for the mountain experience. Systems communicate through
 * these signals and plain objects instead of tracking each other directly.
 */

import { Object3D, signal, Vector3 } from '@iwsdk/core';
import { CLIFF_CENTER_X, TRAIL_END_S, WALL_Z } from './terrain.js';

export const Phase = {
  /** Plant the walking poles in the snow and push to travel up the trail. */
  Poling: 'Poling',
  /** Grab rock holds with closed hands and pull to climb the cliff. */
  Climbing: 'Climbing',
  /** Assemble the hang glider kit on the summit workbench. */
  Building: 'Building',
  /** Glider is assembled; grab the control bar with both hands to launch. */
  Launch: 'Launch',
  /** Flying down to the valley. */
  Gliding: 'Gliding',
  /** Touched down; thanks for playing. */
  Landed: 'Landed',
} as const;
export type Phase = (typeof Phase)[keyof typeof Phase];

export const PART_COUNT = 3;

/** Where the player stands once they have hauled themselves over the lip. */
export const SUMMIT_STAND = new Vector3(CLIFF_CENTER_X, 0, WALL_Z - 1.4);
/** Root of the glider kit on the summit (floor level), in front of the player. */
export const WORKBENCH_POS = new Vector3(CLIFF_CENTER_X, 0, WALL_Z - 2.75);
/** Distance up the trail at which the cliff section begins. */
export const CLIMB_TRIGGER_S = TRAIL_END_S + 1.5;

export const game = {
  phase: signal<Phase>(Phase.Poling),
  /** Metres remaining to the foot of the cliff, for the guide panel. */
  distanceToCliff: signal(Math.round(-WALL_Z)),
  /** How many glider parts have been fitted. */
  partsPlaced: signal(0),
  /** Increments whenever the experience restarts so systems can reset. */
  resetCount: signal(0),
  /** True while the player is holding the control bar with both hands. */
  barHeld: signal(false),
  /** Debug: force the storm level (0..1); null lets the weather follow the journey. */
  stormOverride: null as number | null,
  /** Glide speed in m/s, for the HUD and wind audio. */
  airspeed: 0,
  /** 0..1 white-out used to hide comfort-sensitive transitions. */
  fade: 0,
  fadeTarget: 0,
  /**
   * Horizontal velocity carried by the player rig between pole pushes.
   * Shared so other phases can zero it.
   */
  velocity: new Vector3(),
  /** Root object of the full-size glider that flies with the player. */
  flyingGlider: null as Object3D | null,
  /** Runs once the screen is fully faded out, then the fade lifts. */
  pendingFadeAction: null as (() => void) | null,
  /** Body warmth, 1 = toasty, 0 = hypothermic (expedition only drains it). */
  warmth: signal(1),
  /** Sips left in the thermos (refilled at camps). */
  thermosSips: 4,
  /** A short message shown on the guide panel for a few seconds. */
  toast: signal<{ text: string; until: number } | null>(null),
  /** The backpack is open (palm up). */
  packOpen: signal(false),
};

/** Show a brief message on the guide panel. */
export function toast(text: string, seconds = 3.5): void {
  game.toast.value = { text, until: performance.now() / 1000 + seconds };
}

export function addWarmth(amount: number): void {
  const w = Math.max(0, Math.min(1, game.warmth.peek() + amount));
  if (w !== game.warmth.peek()) game.warmth.value = w;
}

/** Fade to white, run `action` while hidden, then fade back in. */
export function fadeThen(action: () => void): void {
  game.pendingFadeAction = action;
  game.fadeTarget = 1;
}

export function setPhase(phase: Phase): void {
  if (game.phase.peek() !== phase) game.phase.value = phase;
}

export function requestRestart(): void {
  game.resetCount.value = game.resetCount.peek() + 1;
}
