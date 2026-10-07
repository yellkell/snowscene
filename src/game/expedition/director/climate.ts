/**
 * Time, weather and cold on the expedition, as pure functions the director
 * evaluates each frame (node-checkable).
 */

import { clamp, smoothstep, SUMMIT_ELEV } from '../exp-route.js';

/** 0 at night, 1 in full day, smooth through dawn (~5.6-7.4 h) and dusk (~18.2-20.2 h). */
export function daylightAt(hours: number): number {
  const h = ((hours % 24) + 24) % 24;
  return smoothstep(5.6, 7.4, h) * (1 - smoothstep(18.2, 20.2, h));
}

/**
 * How cold it is here (0..1): altitude, darkness and storm all bite. The
 * valley at dawn is ~0.15, the ridge at night ~0.65, the ice wall in its
 * blizzard ~0.95.
 */
export function coldAt(altitude: number, daylight: number, storm: number): number {
  const alt = clamp(altitude / SUMMIT_ELEV, 0, 1);
  return clamp(0.06 + 0.42 * alt + 0.25 * (1 - daylight) + 0.45 * storm, 0, 1);
}

/** Warmth lost per second at cold = 1 (a full bar lasts ~7 minutes). */
export const WARMTH_DRAIN_AT_FULL_COLD = 1 / 420;

/** Squall timing (real time, seconds). */
export const SQUALL = {
  minGap: 180,
  maxGap: 360,
  minDuration: 45,
  maxDuration: 90,
  minPeak: 0.3,
  maxPeak: 0.45,
  rise: 10,
  fall: 15,
};

/** Squall strength `t` seconds into a squall of `duration` and `peak`. */
export function squallEnvelope(t: number, duration: number, peak: number): number {
  if (t < 0 || t > duration) return 0;
  return peak * smoothstep(0, SQUALL.rise, t) * (1 - smoothstep(duration - SQUALL.fall, duration, t));
}

/** Seconds until the next squall, from a uniform random number in [0, 1). */
export function squallGap(r: number): number {
  return SQUALL.minGap + (SQUALL.maxGap - SQUALL.minGap) * r;
}
