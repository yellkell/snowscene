/**
 * What the events system hands each effect every frame, and the hooks other
 * expedition modules install or call.
 */

import type { Vector3 } from '@iwsdk/core';
import type { PowderCloud } from './powder-cloud.js';

export interface FxContext {
  /** Viewer's head (world). */
  readonly head: Vector3;
  /** Floor height under the head. */
  floorY: number;
  /** Horizontal unit vector to the viewer's right (for panning). */
  readonly right: Vector3;
  /** Player arc length / lateral offset on the route. */
  s: number;
  d: number;
  /** Real seconds since the last frame (clamped). */
  dt: number;
  time: number;
  /** Shared powder/dust cloud. */
  readonly powder: PowderCloud;
  /** Controller rumble (0..1); harmless with hand tracking. */
  haptic(level: number, ms?: number): void;
  /** White the view out, then respawn at the last checkpoint. */
  engulf(reason: string, seconds?: number): void;
  /** True while a death is being shown (no further hazard checks). */
  readonly dying: boolean;
  /** Short message on the guide panel / wrist. */
  toast(text: string, seconds?: number): void;
}

/**
 * Hooks for the rest of the expedition. Installed/called by other modules;
 * defaults are harmless.
 */
export const fxHooks = {
  /**
   * The world builder installs this to show/hide its own serac tower at
   * `seracTower()` (fx-layout). While null, the events system shows its own
   * tower mesh for the whole serac field visit, so the collapse always has
   * a tower to topple.
   */
  setSeracVisible: null as ((visible: boolean) => void) | null,
};

/** Control surface for the director / debugging (installed by the events system). */
export const expeditionEvents = {
  /** Re-arm every event at or beyond arc length s (call after a respawn). */
  rearmFrom: (_s: number) => {},
  /** Reset and re-arm everything (restart). */
  resetAll: () => {},
  /** Fire one event now, wherever the player is (debug). */
  trigger: (_name: 'avalanche' | 'serac' | 'rockfall' | 'fireworks' | 'eaglePass') => {},
};
