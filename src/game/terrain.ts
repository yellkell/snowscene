/**
 * Analytic mountain terrain shared by the mesh builder and gameplay systems.
 *
 * Layout (metres, player starts at the origin facing -Z):
 *   z > 12        long valley behind the start; the party lake sits near its
 *                 far end (z ~ 232) before it drops into the sea of clouds
 *   0 .. -68      the pole trail, climbing ~19.5 m up a gentle couloir
 *   -68 .. -72    flat landing below the cliff
 *   -72           the rock wall (climbing section)
 *   < -72         summit shoulder where the glider is built; the main peak
 *                 rises further behind it
 *
 * Everything here is pure math so gameplay can sample heights without
 * touching meshes.
 */

export const TRAIL_END_S = 68;
export const WALL_S = 72;
export const WALL_Z = -WALL_S;
export const TRAIL_RISE = 19.5;
export const CLIFF_BASE_Y = TRAIL_RISE;
export const CLIFF_HEIGHT = 6.6;
export const SUMMIT_Y = CLIFF_BASE_Y + CLIFF_HEIGHT;
export const VALLEY_FLOOR_Y = -14;
/** Height of the sea of clouds that fills the lowlands beyond the valley. */
export const CLOUD_SEA_Y = -120;
export const LAKE_CENTER_X = -6;
export const LAKE_CENTER_Z = 232;
export const LAKE_RADIUS_X = 26;
export const LAKE_RADIUS_Z = 34;
export const LAKE_Y = VALLEY_FLOOR_Y - 0.05;
/** The great ranges ring starts at this radius around the tutorial centre... */
export const TUTORIAL_CENTER_X = 0;
export const TUTORIAL_CENTER_Z = -10;
export const RANGES_INNER_RADIUS = 380;
/** ...and the playable terrain stops just inside it. */
export const TUTORIAL_TERRAIN_RADIUS = RANGES_INNER_RADIUS - 8;
/** Half width of the walkable trail corridor around the path centre line. */
export const TRAIL_HALF_WIDTH = 5.5;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------- noise ----

function hash2(ix: number, iz: number): number {
  let h = (ix * 374761393 + iz * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

/** Smooth value noise in [-1, 1]. */
export function valueNoise(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  const v = a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
  return v * 2 - 1;
}

export function fbm(x: number, z: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * freq + i * 17.3, z * freq - i * 9.1) * amp;
    freq *= 2.03;
    amp *= 0.5;
  }
  return sum;
}

/** Deterministic pseudo random generator for scattering props. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------ path/trail ---

/** X coordinate of the trail centre line at a given z. */
export function pathX(z: number): number {
  const s = clamp(-z, -40, WALL_S + 30);
  return 4.5 * Math.sin(s * 0.05);
}

/** Trail floor height as a function of distance up the trail (s = -z). */
export function trailHeight(s: number): number {
  if (s <= 0) return 0;
  if (s >= TRAIL_END_S) return TRAIL_RISE;
  const t = s / TRAIL_END_S;
  const ease = t * 0.75 + (3 * t * t - 2 * t * t * t) * 0.25;
  return TRAIL_RISE * ease;
}

/** Height along the mountain's main axis before lateral shaping. */
function baseProfile(z: number): number {
  const s = -z;
  if (z > 0) {
    // valley falling away behind the start, rising again far beyond the lake
    // The valley ends in a drop-off into the sea of clouds.
    return VALLEY_FLOOR_Y * smoothstep(12, 55, z) - 260 * smoothstep(300, 395, z);
  }
  if (s < WALL_S) return trailHeight(s);
  // cliff step then the summit shoulder, then the rise toward the main peak
  const step = smoothstep(WALL_S, WALL_S + 0.9, s);
  const rise = Math.pow(smoothstep(90, 200, s), 1.4) * 70;
  return CLIFF_BASE_Y + CLIFF_HEIGHT * step + rise;
}

/** Ground height at world (x, z). */
export function terrainHeight(x: number, z: number): number {
  const s = -z;
  const d = Math.abs(x - pathX(z));
  let h = baseProfile(z);

  // Couloir ridges either side of the trail; the valley is wider and flatter.
  const valleyBlend = smoothstep(0, 35, z);
  const ridge = 18 * smoothstep(6, 36, d) + 46 * smoothstep(55, 170, d);
  const valley = 9 * smoothstep(28, 95, d) + 55 * smoothstep(95, 230, d);
  h += ridge * (1 - valleyBlend) + valley * valleyBlend;

  // The main peak behind the summit, offset to one side for a nicer silhouette.
  const px = x - 18;
  const pz = z + 175;
  // Confined to beyond the summit shoulder so trail and cliff heights stay exact.
  h += 38 * Math.exp(-(px * px + pz * pz) / (2 * 55 * 55)) * smoothstep(92, 135, s);

  // Rolling detail, kept off the walkable trail so poling stays smooth.
  const offTrail = smoothstep(2.5, 11, d);
  h += fbm(x * 0.025, z * 0.025) * 7 * smoothstep(4, 25, d);
  h += fbm(x * 0.11 + 3.7, z * 0.11) * 0.7 * offTrail;
  // Wind-sculpted ripples along the trail itself (very subtle).
  if (s > -4 && s < WALL_S) h += valueNoise(x * 0.6, z * 0.35) * 0.05;

  // Shallow basin for the frozen lake.
  const lx = (x - LAKE_CENTER_X) / LAKE_RADIUS_X;
  const lz = (z - LAKE_CENTER_Z) / LAKE_RADIUS_Z;
  const lr = lx * lx + lz * lz;
  if (lr < 1.6) h -= 0.6 * (1 - smoothstep(0.75, 1.15, lr));

  return h;
}

/** Approximate slope magnitude (rise/run) at a point. */
export function terrainSlope(x: number, z: number): number {
  const e = 0.5;
  const dx = terrainHeight(x + e, z) - terrainHeight(x - e, z);
  const dz = terrainHeight(x, z + e) - terrainHeight(x, z - e);
  return Math.sqrt(dx * dx + dz * dz) / (2 * e);
}

export const CLIFF_CENTER_X = pathX(WALL_Z);
