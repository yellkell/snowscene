/** Per-tick inputs shared by the soundscape modules (one object, reused). */

import { makeZones, type Zones } from './sound-plan.js';

export interface SoundFrame {
  /** AudioContext time of this tick. */
  now: number;
  /** Seconds since the previous tick. */
  dt: number;
  /** World elapsed time (the weather system's clock, for synced gusts). */
  time: number;
  /** Head position. */
  hx: number;
  hy: number;
  hz: number;
  /** Horizontal unit vector to the listener's right. */
  rx: number;
  rz: number;
  /** Arc length along the route. */
  s: number;
  zones: Zones;
  daylight: number;
  /** Smoothed storm (0..1), squall share of it, and the weather's gust 0..1. */
  storm: number;
  squall: number;
  gust: number;
  /** Unit direction the wind blows toward (XZ). */
  windX: number;
  windZ: number;
  aurora: number;
  /** On foot (poling or wandering the party): footsteps allowed. */
  walking: boolean;
  /** In the air (launch / glide). */
  flying: boolean;
  airspeed: number;
  /** Smoothed horizontal head speed (m/s) and this tick's travel (m). */
  speed: number;
  moved: number;
  /** Smoothed danger 0..1. */
  danger: number;
}

export function makeFrame(): SoundFrame {
  return {
    now: 0,
    dt: 0,
    time: 0,
    hx: 0,
    hy: 0,
    hz: 0,
    rx: 1,
    rz: 0,
    s: 0,
    zones: makeZones(),
    daylight: 1,
    storm: 0,
    squall: 0,
    gust: 0.5,
    windX: 1,
    windZ: 0,
    aurora: 0,
    walking: false,
    flying: false,
    airspeed: 0,
    speed: 0,
    moved: 0,
    danger: 0,
  };
}
