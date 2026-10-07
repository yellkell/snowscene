/**
 * Level-of-detail layout for the expedition terrain. Pure data (no Three.js)
 * so the worker, the scheduler and the node check all agree.
 *
 * Near terrain is a set of nested 3x3 blocks of square tiles centred on the
 * player, one block per LOD level, each tile a regular grid of `quads` x
 * `quads` cells plus a skirt. Levels overlap freely: a tile vertex that lies
 * strictly inside the rectangle of any finer *displayed* level is sunk far
 * below ground in the vertex shader, so exactly one level shows at every
 * point and there are never gaps, whatever mix of blocks is on screen.
 * (Every level's rectangle lies on the vertex grid of every coarser level, so
 * a coarse cell is either wholly inside a finer rectangle or wholly outside.)
 *
 *   level  tile    quads  spacing  block covers (Chebyshev from the player)
 *   F      64 m    64     1 m      fixed feature tiles (the crevasse)
 *   L0     128 m   64     2 m      128 .. 256 m
 *   L1     256 m   64     4 m      256 .. 512 m
 *   L2     512 m   48     10.7 m   512 .. 1024 m
 *   L3     1024 m  32     32 m     1024 .. 2048 m
 *
 * Beyond the near blocks the static far mesh (polar, around the summit) and
 * the backdrop ranges take over in the far depth layer.
 */

import { CREVASSE_HALF_LENGTH, CREVASSE_S, routeFrame } from '../exp-layout.js';

export interface TileLevelSpec {
  /** Short name for logs. */
  name: string;
  /** Tile edge length in metres (tiles of a regular level sit on a grid of this size). */
  tile: number;
  /** Cells per tile edge. */
  quads: number;
  /** Depth of the crack-hiding skirt hung from each tile edge (metres). */
  skirt: number;
  /** Radially sharpen the cliff bands inside the tile (coarse levels only). */
  warp: boolean;
  /**
   * Grid lines (every `warpLines` metres) where the warp fades to zero: the
   * tile edges and every line a finer level's block can end on, so coarse
   * vertices on a LOD boundary stay exactly on it.
   */
  warpLines: number;
  /** Fine material (snow glints, shadow receiving). */
  fine: boolean;
}

/** Index 0 is the feature level; 1..4 are the regular clipmap levels L0..L3. */
export const LEVELS: TileLevelSpec[] = [
  { name: 'F', tile: 64, quads: 64, skirt: 40, warp: false, warpLines: 64, fine: true },
  { name: 'L0', tile: 128, quads: 64, skirt: 50, warp: false, warpLines: 128, fine: true },
  { name: 'L1', tile: 256, quads: 64, skirt: 60, warp: true, warpLines: 128, fine: false },
  { name: 'L2', tile: 512, quads: 48, skirt: 100, warp: true, warpLines: 256, fine: false },
  { name: 'L3', tile: 1024, quads: 32, skirt: 160, warp: true, warpLines: 512, fine: false },
];
export const FEATURE_LEVEL = 0;
export const FIRST_REGULAR_LEVEL = 1;
export const LEVEL_COUNT = LEVELS.length;

/** GPU slots per level batch: a full 3x3 block shown plus a full 3x3 being built. */
export const SLOTS_PER_LEVEL = 18;
/** Hysteresis (fraction of a tile) before a block re-centres. */
export const RECENTRE_HYSTERESIS = 0.15;
/** How far tile vertices inside a finer level are pushed down (metres). */
export const HOLE_SINK = 600;

/** Vertices per tile: grid plus one skirt vertex per perimeter vertex. */
export function tileVertexCount(quads: number): number {
  return (quads + 1) * (quads + 1) + 4 * quads;
}

/** Indices per tile: two triangles per cell and per skirt segment. */
export function tileIndexCount(quads: number): number {
  return 6 * quads * quads + 6 * 4 * quads;
}

/** Floats/shorts in a tile payload (see tile-builder `buildTile`). */
export function tilePayloadBytes(spec: TileLevelSpec): number {
  const v = tileVertexCount(spec.quads);
  // heights f32, normals 3 x i16, warp offsets 2 x i16 (coarse levels only)
  return v * 4 + v * 6 + (spec.warp ? v * 4 : 0);
}

// ---------------------------------------------------------- features -------

export interface FeatureTile {
  name: string;
  /** Tile origin (min x, min z), aligned to the L0 vertex grid. */
  x: number;
  z: number;
  /** Request when the player is within this distance of the centre. */
  loadRadius: number;
  /** Show (if it lies inside the displayed L0 block) within this distance. */
  showRadius: number;
}

function featureAt(name: string, cx: number, cz: number): FeatureTile {
  const size = LEVELS[FEATURE_LEVEL].tile;
  const grid = LEVELS[FIRST_REGULAR_LEVEL].tile / LEVELS[FIRST_REGULAR_LEVEL].quads;
  return {
    name,
    x: Math.round((cx - size / 2) / grid) * grid,
    z: Math.round((cz - size / 2) / grid) * grid,
    loadRadius: 420,
    showRadius: 300,
  };
}

const crevasse = routeFrame(CREVASSE_S);
/** The crevasse slot is under 3 m wide: it gets 1 m cells. */
export const FEATURE_TILES: FeatureTile[] = [featureAt('crevasse', crevasse.x, crevasse.z)];
// The slot (64 m long, any orientation) must fit inside one feature tile.
if (CREVASSE_HALF_LENGTH * 2 > LEVELS[FEATURE_LEVEL].tile) throw new Error('crevasse feature tile too small');

// ------------------------------------------------------------ far ---------

/** Outer radius of the far mesh around the summit; the backdrop starts here. */
export const FAR_OUTER_R = 7600;
/** Outer radius of the backdrop ranges. */
export const BACKDROP_OUTER_R = 36000;
/** Angular segments on the shared far/backdrop seam ring. */
export const SEAM_SEGMENTS = 384;

/**
 * Far-mesh sink: vertices deeper than `margin` inside the displayed near
 * blocks drop by `depth`, ramping over `ramp`. The margin is larger than a
 * far-mesh cell there, so no far triangle that crosses the near boundary is
 * ever bent (which would open a gap just outside the near terrain).
 */
export const FAR_SINK = { margin: 280, ramp: 250, depth: 900 };
