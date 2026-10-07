/**
 * The static far geometry, built once in the tile worker. Pure TS.
 *
 *  - Far mesh: the whole mountain and its valley out to FAR_OUTER_R, as a
 *    polar grid around the summit (the terrain is radially organised).
 *    Rings are spaced by the curvature of the radial profile, and the two
 *    cliff bands get rings exactly on their edges and across their face so
 *    they read as sheer walls from kilometres away.
 *  - Backdrop: the ring of great ranges from FAR_OUTER_R to
 *    BACKDROP_OUTER_R: ridged massifs with valleys that drop below the
 *    cloud deck, named giants around the compass, and a low opening beyond
 *    Base Camp where the sea of clouds runs to the horizon. Its inner ring
 *    is the far mesh's outer ring (same radius, same segments, same height
 *    function there), so the two meet without a seam.
 */

import { BAND_HALF_WIDTH, clamp, ICE_WALL_R, profile, ROCK_BAND_R, smoothstep, SUMMIT_X, SUMMIT_Z } from '../exp-route.js';
import { expeditionHeight, naturalHeight } from '../exp-terrain.js';
import { valueNoise } from '../../terrain.js';
import { BACKDROP_OUTER_R, FAR_OUTER_R, SEAM_SEGMENTS } from './terrain-config.js';

export interface PolarRing {
  r: number;
  /** Vertices around the ring (1 for the centre point). */
  n: number;
  /** Fixed normal step (metres); otherwise derived from the local spacing. */
  eps?: number;
}

export interface MeshData {
  positions: Float32Array;
  /** 3 x i16 normalised. */
  normals: Int16Array;
  indices: Uint32Array;
}

type HeightFn = (x: number, z: number) => number;

/**
 * Triangulate concentric rings (any vertex counts) by walking both rings in
 * angle order. Vertex k of a ring sits at angle 2*pi*k/n measured from +Z
 * toward +X, so triangles (inner, outer, inner+1) are counter-clockwise
 * seen from above.
 */
export function buildPolarMesh(rings: PolarRing[], height: HeightFn): MeshData {
  let count = 0;
  const start: number[] = [];
  for (const ring of rings) {
    start.push(count);
    count += ring.n;
  }
  const positions = new Float32Array(count * 3);
  const normals = new Int16Array(count * 3);
  let triangles = 0;
  for (let k = 0; k < rings.length - 1; k++) triangles += rings[k].n + rings[k + 1].n;
  const indices = new Uint32Array(triangles * 3);

  for (let k = 0; k < rings.length; k++) {
    const { r, n } = rings[k];
    // Normal step: a fraction of the local ring spacing (fine on the bands).
    const prev = k > 0 ? r - rings[k - 1].r : Infinity;
    const next = k < rings.length - 1 ? rings[k + 1].r - r : Infinity;
    const arc = n > 1 ? (2 * Math.PI * r) / n : Infinity;
    const eps = rings[k].eps ?? clamp(0.4 * Math.min(prev, next, arc), 0.5, 80);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const x = SUMMIT_X + Math.sin(a) * r;
      const z = SUMMIT_Z + Math.cos(a) * r;
      const v = (start[k] + i) * 3;
      positions[v] = x;
      positions[v + 1] = height(x, z);
      positions[v + 2] = z;
      const gx = (height(x + eps, z) - height(x - eps, z)) / (2 * eps);
      const gz = (height(x, z + eps) - height(x, z - eps)) / (2 * eps);
      const inv = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
      normals[v] = Math.round(-gx * inv * 32767);
      normals[v + 1] = Math.round(inv * 32767);
      normals[v + 2] = Math.round(-gz * inv * 32767);
    }
  }

  let t = 0;
  for (let k = 0; k < rings.length - 1; k++) {
    const A = start[k];
    const nA = rings[k].n;
    const B = start[k + 1];
    const nB = rings[k + 1].n;
    let i = 0;
    let j = 0;
    while (i < nA || j < nB) {
      const ai = A + (i % nA);
      const ai1 = A + ((i + 1) % nA);
      const bj = B + (j % nB);
      const bj1 = B + ((j + 1) % nB);
      if (j >= nB || (i < nA && (i + 1) / nA <= (j + 1) / nB)) {
        if (ai !== ai1) {
          indices[t++] = ai;
          indices[t++] = bj;
          indices[t++] = ai1;
        }
        i++;
      } else {
        indices[t++] = ai;
        indices[t++] = bj;
        indices[t++] = bj1;
        j++;
      }
    }
  }
  return { positions, normals, indices: t === indices.length ? indices : indices.slice(0, t) };
}

// ------------------------------------------------------------ far mesh ----

/** Both meshes take normals on the shared seam ring with the same step. */
const SEAM_NORMAL_EPS = 40;

/** Allowed ring vertex counts (fewer distinct counts = tidier stitching). */
const SEGMENT_STEPS = [8, 16, 32, 64, 128, 192, 256, 320, SEAM_SEGMENTS];

function segmentsFor(r: number, arcPerMetre: number, minArc: number, maxN: number): number {
  const want = (2 * Math.PI * r) / Math.max(minArc, arcPerMetre * r);
  for (const n of SEGMENT_STEPS) if (n >= want && n <= maxN) return n;
  return maxN;
}

/** Ring radii of the far mesh, densest where the profile bends and on the cliffs. */
export function farRings(): PolarRing[] {
  // Base radii: spacing limited by profile curvature (linear error ~ 1.5 m)
  // and by a fraction of the radius.
  const base: number[] = [];
  const tol = 1.5;
  let r = 10;
  while (r < FAR_OUTER_R) {
    base.push(r);
    const h = 4;
    const curv = Math.abs(profile(r + h) - 2 * profile(r) + profile(r - h)) / (h * h);
    const byCurv = curv > 1e-9 ? Math.sqrt((8 * tol) / curv) : Infinity;
    r += clamp(Math.min(0.06 * r, byCurv), 10, 200);
  }
  // The cliff bands: rings on both edges of the 6 m step and across it, plus
  // shoulders, replacing any base radius nearby.
  const forced: number[] = [];
  const w = BAND_HALF_WIDTH;
  for (const R of [ROCK_BAND_R, ICE_WALL_R]) {
    for (const o of [-w - 4, -w, -w / 2, 0, w / 2, w, w + 4]) forced.push(R + o);
  }
  const radii = base
    .filter((x) => forced.every((f) => Math.abs(x - f) > 9))
    .concat(forced)
    .sort((a, b) => a - b);
  const rings: PolarRing[] = [{ r: 0, n: 1 }];
  for (const x of radii) rings.push({ r: x, n: segmentsFor(x, 0.024, 12, SEAM_SEGMENTS) });
  rings.push({ r: FAR_OUTER_R, n: SEAM_SEGMENTS, eps: SEAM_NORMAL_EPS });
  // Never let the count drop going outward.
  for (let k = 2; k < rings.length; k++) rings[k].n = Math.max(rings[k].n, rings[k - 1].n);
  return rings;
}

export function buildFarMesh(): MeshData {
  return buildPolarMesh(farRings(), expeditionHeight);
}

// ------------------------------------------------------------ backdrop ----

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

interface Giant {
  /** Bearing from the summit (radians, 0 = +Z toward Base Camp, +pi/2 = +X). */
  bearing: number;
  r: number;
  height: number;
  radius: number;
}

/** Named giants. Behind the summit a vast throne; flanking walls; two far
 * peaks piercing the cloud sea beyond the glide. */
const GIANTS: Array<Giant & { x: number; z: number }> = [
  { bearing: Math.PI, r: 15500, height: 4300, radius: 2600 },
  { bearing: 2.4, r: 12600, height: 3100, radius: 1700 },
  { bearing: -2.3, r: 13600, height: 3500, radius: 1900 },
  { bearing: -1.35, r: 18500, height: 3900, radius: 2400 },
  { bearing: 1.3, r: 17000, height: 3600, radius: 2200 },
  { bearing: 0.42, r: 21500, height: 4700, radius: 2800 },
  { bearing: -0.55, r: 20000, height: 4100, radius: 2500 },
].map((g) => ({ ...g, x: SUMMIT_X + Math.sin(g.bearing) * g.r, z: SUMMIT_Z + Math.cos(g.bearing) * g.r }));

/** Height of the surrounding ranges; equals the mountain's own terrain at FAR_OUTER_R. */
export function backdropHeight(x: number, z: number): number {
  const dx = x - SUMMIT_X;
  const dz = z - SUMMIT_Z;
  const r = Math.hypot(dx, dz);
  const inner = naturalHeight(x, z);
  if (r <= FAR_OUTER_R) return inner;
  const bearing = Math.atan2(dx, dz);
  // Beyond Base Camp the land opens low under the cloud sea (the glide view).
  const open = 1 - smoothstep(0.3, 0.9, Math.abs(bearing));
  // Big azimuthal swells so the skyline has rhythm: massifs and saddles.
  const swell = 0.55 + 0.45 * valueNoise(bearing * 2.3 + 4.2, 1.7) + 0.2 * valueNoise(bearing * 7.1 - 2.0, 9.3);
  const lift = smoothstep(FAR_OUTER_R, 14000, r) * (1 - 0.35 * smoothstep(25000, BACKDROP_OUTER_R, r));
  const ridge = ridged(x / 3600 + 31.7, z / 3600 - 12.9, 7);
  let h = 250 + ridge * 3400 * lift * clamp(swell, 0.2, 1.2) * (1 - 0.85 * open);
  for (const g of GIANTS) {
    const gx = (x - g.x) / g.radius;
    const gz = (z - g.z) / g.radius;
    const d2 = gx * gx + gz * gz;
    if (d2 > 7) continue;
    const cone = Math.max(0, 1 - Math.sqrt(d2) / 2.6);
    const crag = 0.62 + 0.7 * ridged(x / 800 + g.bearing * 5, z / 800, 5);
    const summit = Math.pow(cone, 1.7) * crag + Math.pow(cone, 6) * 0.25;
    h = Math.max(h, 300 + g.height * summit);
  }
  const t = smoothstep(FAR_OUTER_R, FAR_OUTER_R + 3200, r);
  return inner + (h - inner) * t;
}

export function backdropRings(): PolarRing[] {
  const rings: PolarRing[] = [{ r: FAR_OUTER_R, n: SEAM_SEGMENTS, eps: SEAM_NORMAL_EPS }];
  let r = FAR_OUTER_R;
  while (r < BACKDROP_OUTER_R) {
    r = Math.min(BACKDROP_OUTER_R, r * 1.05);
    rings.push({ r, n: 512 });
  }
  return rings;
}

export function buildBackdrop(): MeshData {
  return buildPolarMesh(backdropRings(), backdropHeight);
}
