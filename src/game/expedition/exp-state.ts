/**
 * Shared expedition state. Signals for things UI reacts to; a plain
 * `expFrame` object for per-frame values (written by the director each
 * frame, read by everyone with no allocation); hooks the director installs
 * so other modules can request a respawn, a toast, etc. without importing
 * the director.
 */

import { type Entity, signal, Vector3 } from '@iwsdk/core';
import type { SectionId } from './exp-route.js';

export const exp = {
  /** True once the expedition has started (tutorial hidden). */
  active: signal(false),
  /** Current section of the route. */
  section: signal<SectionId>('valley'),
  /** Index of the last checkpoint reached (see the director's list). */
  checkpoint: signal(0),
  /** Set when the player reaches the summit marker. */
  summited: signal(false),
  /** Set when the player lands back at Base Camp after the summit glide. */
  finished: signal(false),
  /** Clipped onto the fixed rope (mechanics writes, level gates on it). */
  ropeClipped: signal(false),
};

/** Per-frame values, mutated in place. */
export const expFrame = {
  /** Player's arc length along the route (from projection of the head). */
  s: 0,
  /** Signed lateral offset from the route centre line (+ = left of travel). */
  d: 0,
  /** Head world position. */
  head: new Vector3(),
  /** Hours; may exceed 24 after midnight (use % 24 for a clock face). */
  timeOfDay: 6.6,
  /** 0 at night, 1 in full day (smooth through dawn/dusk). */
  daylight: 1,
  /** Unit vector toward the sun (below the horizon at night). */
  sunDirection: new Vector3(0.3, 0.4, -0.8).normalize(),
  /** Unit vector toward the moon. */
  moonDirection: new Vector3(-0.4, 0.5, 0.7).normalize(),
  /** Extra storm from passing squalls (director), added to the baseline. */
  squall: 0,
  /** Final storm target the level hands to the weather system. */
  storm: 0,
  /** Aurora strength 0..1 (night on the ridge). */
  aurora: 0,
  /** Cold 0..1: how fast warmth drains here (altitude, night, wind). */
  cold: 0,
};

/** Scene handles shared across expedition modules. */
export const expRefs = {
  /** Parent of everything that exists only on the expedition (hidden until it starts). */
  root: null as Entity | null,
};

/** Hooks installed by the director. Defaults are harmless no-ops. */
export const expHooks = {
  /** Something killed or stranded the player: fade and return to the last checkpoint. */
  respawn: (_reason: string) => {},
  /** Short message on the guide panel / wrist. */
  toast: (_text: string, _seconds?: number) => {},
  /** Ask the terrain streamer whether tiles around a point are ready. */
  terrainReady: (_x: number, _z: number, _radius: number) => true,
};
