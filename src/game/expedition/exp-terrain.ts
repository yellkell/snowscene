/**
 * Height field of the expedition mountain. Pure math (no Three.js) so the
 * terrain worker, gameplay and content placement all agree exactly.
 *
 *   naturalHeight  the radial profile plus ridges, gullies and fine relief;
 *                  relief fades out near the route and the two cliff bands.
 *   expeditionHeight  natural terrain with a walkable bench carved along
 *                  the route (flat across, following the route's smoothed
 *                  elevation), blended back into the natural slope.
 */

import { fbm, valueNoise } from '../terrain.js';
import {
  BAND_HALF_WIDTH,
  clamp,
  ICE_WALL_R,
  profile,
  project,
  type Projection,
  ROCK_BAND_R,
  smoothstep,
  SUMMIT_ELEV,
  SUMMIT_X,
  SUMMIT_Z,
} from './exp-route.js';
import {
  CAMPS,
  campCentre,
  CREVASSE_DEPTH,
  CREVASSE_HALF_GAP,
  CREVASSE_HALF_LENGTH,
  CREVASSE_S,
  outwardSide,
  RIVER_DEPTH,
  RIVER_HALF_WIDTH,
  RIVER_S,
  ROPE_END_S,
  ROPE_START_S,
  routeFrame,
} from './exp-layout.js';

/** Half width of the flat walkable bench along the route (metres). */
export const BENCH_HALF_WIDTH = 4;
/** Distance over which the bench blends back into the natural slope. */
export const BENCH_BLEND = 26;

/** Ridged multifractal in [0, ~1]. */
function ridged(x: number, z: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let weight = 1;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(valueNoise(x * freq + i * 13.7, z * freq - i * 7.3));
    n *= n;
    n *= weight;
    weight = clamp(n * 1.8, 0, 1);
    sum += n * amp;
    freq *= 2.07;
    amp *= 0.5;
  }
  return sum;
}

const scratch: Projection = { s: 0, d: 0, dist: 0, elev: 0 };

/** Relief strength: 0 on the route and on the cliff bands, 1 far from both. */
function reliefMask(r: number, routeDist: number): number {
  const band =
    smoothstep(BAND_HALF_WIDTH + 1, BAND_HALF_WIDTH + 14, Math.abs(r - ICE_WALL_R)) *
    smoothstep(BAND_HALF_WIDTH + 1, BAND_HALF_WIDTH + 14, Math.abs(r - ROCK_BAND_R));
  const route = smoothstep(BENCH_HALF_WIDTH + 4, 170, routeDist);
  return band * route;
}

/** Natural mountain surface (no route bench). `routeDist` from `project`. */
export function naturalHeight(x: number, z: number, routeDist = Infinity): number {
  const dx = x - SUMMIT_X;
  const dz = z - SUMMIT_Z;
  const r = Math.hypot(dx, dz);
  const base = profile(r);
  const alt = clamp(base / SUMMIT_ELEV, 0, 1);
  const mask = reliefMask(r, routeDist);
  // Big ridges and gullies, stronger with altitude; small rolling detail.
  const ridges = (ridged(x / 520, z / 520, 6) - 0.35) * (30 + 190 * alt);
  const rolls = fbm(x / 140, z / 140, 4) * (10 + 18 * alt);
  // Fine relief everywhere except right on the bench (kept walkable).
  const fine = fbm(x / 22, z / 22, 3) * 1.6 * smoothstep(BENCH_HALF_WIDTH, BENCH_HALF_WIDTH + 10, routeDist);
  return base + mask * (ridges + rolls) + fine;
}

// Precomputed feature frames (module load; cheap).
const campFlats = CAMPS.map((camp) => {
  const c = campCentre(camp);
  return { x: c.x, z: c.z, elev: c.elev, radius: camp.radius };
});
const river = routeFrame(RIVER_S);
const crevasse = routeFrame(CREVASSE_S);
const ropeOutward = outwardSide((ROPE_START_S + ROPE_END_S) / 2);

/** Ground height of the expedition terrain at (x, z). */
export function expeditionHeight(x: number, z: number): number {
  const p = project(x, z, scratch);
  const natural = naturalHeight(x, z, p.dist);
  let h = natural;
  if (p.dist !== Infinity) {
    const w = 1 - smoothstep(BENCH_HALF_WIDTH, BENCH_HALF_WIDTH + BENCH_BLEND, p.dist);
    if (w > 0) {
      // Wind ripples on the bench (a few centimetres) so it isn't a flat ribbon.
      const bench = p.elev + valueNoise(x * 0.5, z * 0.5) * 0.04;
      h = natural + (bench - natural) * w;
    }
    // The fixed-rope ledge: a sheer drop on the downhill side, a rock wall
    // on the uphill side.
    if (p.s > ROPE_START_S - 40 && p.s < ROPE_END_S + 40) {
      const win = smoothstep(ROPE_START_S - 40, ROPE_START_S, p.s) * smoothstep(ROPE_END_S + 40, ROPE_END_S, p.s);
      const out = p.d * ropeOutward;
      h -= 70 * smoothstep(2.6, 11, out) * win;
      h += 22 * smoothstep(3.2, 9, -out) * win;
    }
  }
  // Camps sit on flattened pads.
  for (const c of campFlats) {
    const dx = x - c.x;
    const dz = z - c.z;
    const d2 = dx * dx + dz * dz;
    const outer = c.radius + 24;
    if (d2 > outer * outer) continue;
    const w = 1 - smoothstep(c.radius, outer, Math.sqrt(d2));
    h += (c.elev + valueNoise(x * 0.3, z * 0.3) * 0.05 - h) * w;
  }
  // The river cuts a channel across the valley, flowing away from the peak.
  {
    const dx = x - river.x;
    const dz = z - river.z;
    const across = Math.abs(dx * river.tx + dz * river.tz);
    const along = dx * river.nx + dz * river.nz;
    if (across < RIVER_HALF_WIDTH + 14 && Math.abs(along) < 900) {
      const taper = smoothstep(900, 700, Math.abs(along));
      h -= RIVER_DEPTH * (1 - smoothstep(RIVER_HALF_WIDTH - 1.5, RIVER_HALF_WIDTH + 2.5, across)) * taper;
      h -= 1.2 * (1 - smoothstep(RIVER_HALF_WIDTH + 2.5, RIVER_HALF_WIDTH + 14, across)) * taper;
    }
  }
  // The crevasse: a deep slot across the glacier route.
  {
    const dx = x - crevasse.x;
    const dz = z - crevasse.z;
    const across = Math.abs(dx * crevasse.tx + dz * crevasse.tz);
    const along = Math.abs(dx * crevasse.nx + dz * crevasse.nz);
    if (across < CREVASSE_HALF_GAP + 0.6 && along < CREVASSE_HALF_LENGTH) {
      const lip = 1 - smoothstep(CREVASSE_HALF_GAP - 0.25, CREVASSE_HALF_GAP + 0.35, across);
      const ends = smoothstep(CREVASSE_HALF_LENGTH, CREVASSE_HALF_LENGTH - 8, along);
      h -= CREVASSE_DEPTH * lip * ends;
    }
  }
  return h;
}

/** Approximate slope (rise / run) of the expedition terrain. */
export function expeditionSlope(x: number, z: number): number {
  const e = 1;
  const dx = expeditionHeight(x + e, z) - expeditionHeight(x - e, z);
  const dz = expeditionHeight(x, z + e) - expeditionHeight(x, z - e);
  return Math.hypot(dx, dz) / (2 * e);
}
