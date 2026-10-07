/**
 * Builds one near-terrain tile from `expeditionHeight`. Pure TS (no
 * Three.js): runs in the tile worker, in the main-thread fallback and in the
 * node check.
 *
 * Vertex layout of a tile with q cells per edge:
 *   0 .. (q+1)^2-1          the grid, row-major (i along +x, j along +z)
 *   (q+1)^2 .. +4q-1        skirt: one vertex below each perimeter vertex,
 *                           in perimeter order (see `perimeterVertex`)
 *
 * The payload sent to the GPU is per vertex: height (f32), normal (3 x i16
 * normalised) and, on coarse levels, a horizontal warp offset (2 x i16
 * normalised, in units of the cell size). The x/z grid itself is a static
 * attribute shared by every slot of a level; the tile origin is a uniform.
 */

import { BAND_HALF_WIDTH, ICE_WALL_R, ROCK_BAND_R, SUMMIT_X, SUMMIT_Z } from '../exp-route.js';
import { expeditionHeight } from '../exp-terrain.js';
import { tileIndexCount, type TileLevelSpec, tileVertexCount } from './terrain-config.js';

export interface TilePayload {
  heights: Float32Array;
  normals: Int16Array;
  /** Warp offsets / cell size, or null on levels without warp. */
  offsets: Int16Array | null;
}

/** Typed views over a tile payload buffer (layout: heights, normals, offsets). */
export function payloadViews(spec: TileLevelSpec, buffer: ArrayBuffer): TilePayload {
  const v = tileVertexCount(spec.quads);
  return {
    heights: new Float32Array(buffer, 0, v),
    normals: new Int16Array(buffer, v * 4, v * 3),
    offsets: spec.warp ? new Int16Array(buffer, v * 10, v * 2) : null,
  };
}

/** Grid index of perimeter vertex k (0 <= k < 4q), walking the edge loop. */
export function perimeterVertex(q: number, k: number): number {
  let i: number;
  let j: number;
  if (k < q) {
    i = k;
    j = 0;
  } else if (k < 2 * q) {
    i = q;
    j = k - q;
  } else if (k < 3 * q) {
    i = q - (k - 2 * q);
    j = q;
  } else {
    i = 0;
    j = q - (k - 3 * q);
  }
  return j * (q + 1) + i;
}

/** Local index pattern of one tile (counter-clockwise seen from above). */
export function tileIndexPattern(q: number): Uint32Array {
  const out = new Uint32Array(tileIndexCount(q));
  const row = q + 1;
  let t = 0;
  for (let j = 0; j < q; j++) {
    for (let i = 0; i < q; i++) {
      const a = j * row + i;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      out[t++] = a;
      out[t++] = c;
      out[t++] = b;
      out[t++] = b;
      out[t++] = c;
      out[t++] = d;
    }
  }
  // Skirt quads face the tile's interior: cracks at LOD boundaries are only
  // ever seen from inside the finer region, where the viewer is.
  const base = row * row;
  const n = 4 * q;
  for (let k = 0; k < n; k++) {
    const p0 = perimeterVertex(q, k);
    const p1 = perimeterVertex(q, (k + 1) % n);
    const s0 = base + k;
    const s1 = base + ((k + 1) % n);
    out[t++] = p0;
    out[t++] = s0;
    out[t++] = p1;
    out[t++] = p1;
    out[t++] = s0;
    out[t++] = s1;
  }
  return out;
}

/** Static local positions of one tile: x/z on the grid, y = -skirt on skirt vertices. */
export function tileLocalPositions(spec: TileLevelSpec): Float32Array {
  const q = spec.quads;
  const row = q + 1;
  const out = new Float32Array(tileVertexCount(q) * 3);
  for (let j = 0; j <= q; j++) {
    for (let i = 0; i <= q; i++) {
      const v = (j * row + i) * 3;
      out[v] = (i * spec.tile) / q;
      out[v + 1] = 0;
      out[v + 2] = (j * spec.tile) / q;
    }
  }
  const base = row * row;
  for (let k = 0; k < 4 * q; k++) {
    const p = perimeterVertex(q, k) * 3;
    const v = (base + k) * 3;
    out[v] = out[p];
    out[v + 1] = -spec.skirt;
    out[v + 2] = out[p + 2];
  }
  return out;
}

// ------------------------------------------------------- cliff warp -------

const BANDS = [ICE_WALL_R, ROCK_BAND_R];

/**
 * Radial remap that pulls the vertices within one cell of a cliff band onto
 * the band's 6 m-wide step, so a coarse grid still draws a sheer cliff:
 * |d| <= s/2 maps onto the step, s/2 < |d| < s onto the shoulders,
 * identity beyond. Monotone, continuous. Returns the new distance from the
 * band centre line.
 */
function bandRemap(d: number, s: number): number {
  const a = s / 2;
  const b = BAND_HALF_WIDTH;
  const ad = Math.abs(d);
  if (ad <= a) return d * (b / a);
  if (ad < s) return Math.sign(d) * (b + ((ad - a) * (s - b)) / (s - a));
  return d;
}

export interface WarpResult {
  x: number;
  z: number;
  /** True when the point moved. */
  moved: boolean;
  /** Distance of the moved point from the band centre line (when moved). */
  bandDist: number;
}

/**
 * Warp (x, z) on a grid of cell size s; `weight` (0..1) fades the warp out
 * toward tile edges and possible LOD boundaries so those stay on the grid.
 */
export function bandWarp(x: number, z: number, s: number, weight: number, out: WarpResult): WarpResult {
  out.x = x;
  out.z = z;
  out.moved = false;
  out.bandDist = Infinity;
  if (weight <= 0 || s <= BAND_HALF_WIDTH + 0.5) return out;
  const dx = x - SUMMIT_X;
  const dz = z - SUMMIT_Z;
  const r = Math.hypot(dx, dz);
  if (r < 1e-3) return out;
  for (const R of BANDS) {
    const d = r - R;
    if (Math.abs(d) >= s) continue;
    const nd = d + (bandRemap(d, s) - d) * weight;
    const k = (R + nd) / r;
    out.x = SUMMIT_X + dx * k;
    out.z = SUMMIT_Z + dz * k;
    out.moved = Math.abs(nd - d) > 1e-6;
    out.bandDist = nd;
    return out;
  }
  return out;
}

// ------------------------------------------------------------ build -------

/** Scratch floats `buildTile` needs for a level. */
export function tileScratchSize(spec: TileLevelSpec): number {
  return (spec.quads + 3) * (spec.quads + 3);
}

function packNormal(out: Int16Array, v: number, gx: number, gz: number): void {
  // Normal of the height field: (-dh/dx, 1, -dh/dz), normalised.
  const inv = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
  out[v * 3] = Math.round(-gx * inv * 32767);
  out[v * 3 + 1] = Math.round(inv * 32767);
  out[v * 3 + 2] = Math.round(-gz * inv * 32767);
}

const warp: WarpResult = { x: 0, z: 0, moved: false, bandDist: 0 };

/**
 * Fill `out` for the tile whose minimum corner is (originX, originZ).
 * Heights are sampled on the grid plus a one-cell border, normals come from
 * central differences of those samples (so neighbouring tiles of one level
 * agree bit-for-bit along shared edges). Warped vertices near the cliff
 * bands are resampled at their moved positions, with radial differences
 * taken across 1 m so the cliff face gets a steep normal.
 */
export function buildTile(
  spec: TileLevelSpec,
  originX: number,
  originZ: number,
  out: TilePayload,
  scratch: Float64Array,
): void {
  const q = spec.quads;
  const T = spec.tile;
  const s = T / q;
  const g = q + 3;
  const H = scratch;
  for (let gj = 0; gj < g; gj++) {
    const z = originZ + ((gj - 1) * T) / q;
    for (let gi = 0; gi < g; gi++) {
      H[gj * g + gi] = expeditionHeight(originX + ((gi - 1) * T) / q, z);
    }
  }
  const row = q + 1;
  const inv2s = 1 / (2 * s);
  const offsets = out.offsets;
  // Cells between warp-free lines (see TileLevelSpec.warpLines).
  const cpl = Math.round(spec.warpLines / s);
  for (let j = 0; j <= q; j++) {
    const z = originZ + (j * T) / q;
    for (let i = 0; i <= q; i++) {
      const v = j * row + i;
      const c = (j + 1) * g + (i + 1);
      let moved = false;
      if (offsets) {
        const li = i % cpl;
        const lj = j % cpl;
        const edge = Math.min(li, cpl - li, lj, cpl - lj);
        const x = originX + (i * T) / q;
        bandWarp(x, z, s, Math.min(1, edge / 2), warp);
        if (warp.moved) {
          moved = true;
          out.heights[v] = expeditionHeight(warp.x, warp.z);
          // Gradient: radial across +-1 m on the step (+-s/2 on the
          // shoulders), tangential across +-s/2, then back to x/z.
          const rx = warp.x - SUMMIT_X;
          const rz = warp.z - SUMMIT_Z;
          const rl = Math.hypot(rx, rz);
          const ux = rx / rl;
          const uz = rz / rl;
          const er = Math.abs(warp.bandDist) <= BAND_HALF_WIDTH + 0.5 ? 1 : s / 2;
          const et = s / 2;
          const dr =
            (expeditionHeight(warp.x + ux * er, warp.z + uz * er) -
              expeditionHeight(warp.x - ux * er, warp.z - uz * er)) /
            (2 * er);
          const dt =
            (expeditionHeight(warp.x - uz * et, warp.z + ux * et) -
              expeditionHeight(warp.x + uz * et, warp.z - ux * et)) /
            (2 * et);
          packNormal(out.normals, v, dr * ux - dt * uz, dr * uz + dt * ux);
          offsets[v * 2] = Math.round(Math.max(-1, Math.min(1, (warp.x - x) / s)) * 32767);
          offsets[v * 2 + 1] = Math.round(Math.max(-1, Math.min(1, (warp.z - z) / s)) * 32767);
        } else {
          offsets[v * 2] = 0;
          offsets[v * 2 + 1] = 0;
        }
      }
      if (!moved) {
        out.heights[v] = H[c];
        packNormal(out.normals, v, (H[c + 1] - H[c - 1]) * inv2s, (H[c + g] - H[c - g]) * inv2s);
      }
    }
  }
  // Skirt vertices copy their perimeter vertex (the drop is in the static positions).
  const base = row * row;
  for (let k = 0; k < 4 * q; k++) {
    const p = perimeterVertex(q, k);
    const v = base + k;
    out.heights[v] = out.heights[p];
    out.normals[v * 3] = out.normals[p * 3];
    out.normals[v * 3 + 1] = out.normals[p * 3 + 1];
    out.normals[v * 3 + 2] = out.normals[p * 3 + 2];
    if (offsets) {
      offsets[v * 2] = offsets[p * 2];
      offsets[v * 2 + 1] = offsets[p * 2 + 1];
    }
  }
}
