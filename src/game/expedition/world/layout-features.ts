/**
 * Set-piece features: the log bridge over the river, the river itself, the
 * crevasse ladder and hand lines, and the two climbing faces (the ice wall
 * and the summit rock band) with the rock band's holds. Pure math (no
 * Three.js) so decks, rungs, faces and holds can be node-checked.
 */

import { BRIDGE_HALF_LENGTH as LAYOUT_BRIDGE_HALF_LENGTH, bridgeDeckAt } from '../exp-layout.js';
import { fbm, valueNoise } from '../../terrain.js';
import {
  type BandCrossing,
  CREVASSE_DEPTH,
  CREVASSE_HALF_GAP,
  CREVASSE_HALF_LENGTH,
  CREVASSE_S,
  ICE_WALL,
  outwardSide,
  RIVER_HALF_WIDTH,
  RIVER_S,
  ROCK_BAND,
  ROPE_END_S,
  ROPE_START_S,
  routeFrame,
} from '../exp-layout.js';
import { ICE_WALL_R, ROCK_BAND_R, smoothstep, SUMMIT_X, SUMMIT_Z } from '../exp-route.js';
import { type Gen, groundAt, groundMin } from './layout-util.js';

// ---------------------------------------------------------- log bridge ----

export const BRIDGE_FRAME = routeFrame(RIVER_S);
/** Half length of the walkable deck (matches `bridgeHeight`). */
export const BRIDGE_HALF_LENGTH = LAYOUT_BRIDGE_HALF_LENGTH;
/** The deck: three lashed logs, their tops flush with `bridgeHeight`. */
export const BRIDGE_LOGS: ReadonlyArray<{ across: number; radius: number }> = [
  { across: -0.43, radius: 0.22 },
  { across: 0, radius: 0.23 },
  { across: 0.43, radius: 0.22 },
];
/** Half width of the walkable log deck (mechanics: footHalfWidth 0.55). */
export const BRIDGE_DECK_HALF_WIDTH = 0.65;
/** The logs run on past the deck ends to rest on the abutments. */
export const BRIDGE_LOG_OVERHANG = 1.4;

/** Deck height at along-offset a (same formula as `bridgeHeight`). */
export function bridgeDeckY(a: number): number {
  return bridgeDeckAt(a);
}

/** World position of a bridge-local point (a along the route, l to the left). */
export function bridgePoint(a: number, l: number): { x: number; z: number } {
  const f = BRIDGE_FRAME;
  return { x: f.x + f.tx * a + f.nx * l, z: f.z + f.tz * a + f.nz * l };
}

// ----------------------------------------------------------- crevasse -----

/**
 * The crevasse slot (the ladder, its hand lines and the rope are drawn by
 * the mechanics module). Local coordinates: `a` along the route (across the
 * slot), `l` along the slot (the route's left normal).
 */
export const CREVASSE_FRAME = routeFrame(CREVASSE_S);
/** Ladder walking surface (matches `ladderHeight`; the walls keep below it). */
export const LADDER_FLOOR_Y = CREVASSE_FRAME.elev + 0.08;

export function crevassePoint(a: number, l: number): { x: number; z: number } {
  const f = CREVASSE_FRAME;
  return { x: f.x + f.tx * a + f.nx * l, z: f.z + f.tz * a + f.nz * l };
}

/** Depth of the carved slot at along-slot offset l (matches the terrain carve). */
export function crevasseDepth(l: number): number {
  return CREVASSE_DEPTH * smoothstep(CREVASSE_HALF_LENGTH, CREVASSE_HALF_LENGTH - 8, Math.abs(l));
}

/**
 * Half width of an ice wall at depth `down` below the lip: it starts just
 * outside the carve's lip, curls in under a snow overhang and narrows to a
 * dark slot at the bottom. Always inside the terrain carve (so it hides it).
 */
export function crevasseWallHalf(down: number, depth: number): number {
  if (down <= 0) return CREVASSE_HALF_GAP + 0.5;
  if (down < 1.2) return CREVASSE_HALF_GAP + 0.5 - 0.62 * smoothstep(0, 1.2, down);
  const t = Math.min(1, (down - 1.2) / Math.max(1, depth - 1.2));
  return CREVASSE_HALF_GAP - 0.12 - 0.9 * t;
}

// --------------------------------------------------- rope-ledge rock wall --

/** The uphill wall beside the fixed-rope ledge (the terrain rises 22 m there). */
export const LEDGE_WALL = {
  s0: ROPE_START_S - 34,
  s1: ROPE_END_S + 34,
  rise: 22,
  /** Lateral band (from the path centre) the terrain's wall occupies. */
  d0: 3.2,
  d1: 9,
};

/** Uphill side of the ledge (+1 = left of travel), as the terrain shapes it. */
export const LEDGE_UP_SIDE = -outwardSide((ROPE_START_S + ROPE_END_S) / 2);

export interface LedgeWallGrid {
  cols: number;
  rows: number;
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
}

/**
 * A rock face draped over the ledge's uphill wall, a little proud of the
 * terrain (so the coarse terrain triangles never show), from below the
 * ledge floor to where the wall tops out.
 */
export function* ledgeWallGrid(): Gen<LedgeWallGrid> {
  const step = 2;
  const cols = Math.round((LEDGE_WALL.s1 - LEDGE_WALL.s0) / step) + 1;
  const rows = 16;
  const g: LedgeWallGrid = {
    cols,
    rows,
    x: new Float64Array(cols * rows),
    y: new Float64Array(cols * rows),
    z: new Float64Array(cols * rows),
  };
  const scanStep = 0.2;
  const scanD0 = 2.6;
  const scanN = Math.round((14 - scanD0) / scanStep) + 1;
  const hs = new Float64Array(scanN);
  const up = LEDGE_UP_SIDE;
  for (let c = 0; c < cols; c++) {
    const s = LEDGE_WALL.s0 + c * step;
    const f = routeFrame(s);
    for (let k = 0; k < scanN; k++) {
      const d = scanD0 + k * scanStep;
      hs[k] = groundAt(f.x + f.nx * up * d, f.z + f.nz * up * d);
    }
    // Innermost lateral distance at which the terrain reaches a height.
    const offsetAt = (y: number): number => {
      for (let k = 0; k < scanN; k++) {
        if (hs[k] >= y) {
          if (k === 0) return scanD0;
          const t = (y - hs[k - 1]) / Math.max(1e-6, hs[k] - hs[k - 1]);
          return scanD0 + (k - 1 + t) * scanStep;
        }
      }
      return scanD0 + (scanN - 1) * scanStep;
    };
    const topRise = Math.max(0.5, Math.min(LEDGE_WALL.rise + 4, hs[Math.round((10 - scanD0) / scanStep)] - f.elev));
    for (let j = 0; j < rows; j++) {
      const t = j / (rows - 1);
      const rise = -0.4 + t * (topRise + 0.4);
      let d = offsetAt(f.elev + Math.max(0.05, rise));
      if (j === rows - 1) {
        // The top row tucks back into the slope.
        d = offsetAt(f.elev + topRise + 0.8) + 0.6;
      } else {
        // Rock relief stands proud of the terrain, fading out at the foot.
        const relief = (0.2 + 0.6 * Math.abs(fbm(s * 0.09, rise * 0.15 + 4, 3))) * smoothstep(0.3, 1.8, rise);
        d = Math.max(scanD0 - 0.2, d - relief - 0.1);
      }
      const x = f.x + f.nx * up * d;
      const z = f.z + f.nz * up * d;
      const i = c * rows + j;
      g.x[i] = x;
      g.y[i] = j === 0 ? groundAt(x, z) - 0.4 : j === rows - 1 ? f.elev + topRise : f.elev + rise;
      g.z[i] = z;
    }
    if ((c & 15) === 15) yield;
  }
  return g;
}

// -------------------------------------------------------------- river -----

/**
 * The river runs down the carved channel across the valley (along the
 * route's normal at RIVER_S), flowing outward away from the summit. Rows
 * go from upstream to downstream; the water level never rises downstream
 * and always stays tucked under the banks.
 */
export interface RiverRow {
  /** Offset along the channel axis (+ = route left normal). */
  along: number;
  /** Centre of the row and the water level. */
  x: number;
  z: number;
  y: number;
  /** Water visible at this row (above the channel floor). */
  wet: boolean;
  /** White water amount (steep reaches), 0..1. */
  rapid: number;
  /** Downstream distance from the first row (for the flow shader). */
  dist: number;
}

/** Half width of the water ribbon (edges tuck under the banks). */
export const RIVER_RIBBON_HALF = 7.4;
export const RIVER_STEP = 3;
const RIVER_UP = 690;
const RIVER_DOWN = 640;

/** Unit horizontal direction the river flows (downstream). */
export const RIVER_FLOW = (() => {
  const f = BRIDGE_FRAME;
  const o = outwardSide(RIVER_S); // +1 if left is downhill
  return { x: f.nx * o, z: f.nz * o, sign: o };
})();

export function* riverRows(): Gen<RiverRow[]> {
  const f = BRIDGE_FRAME;
  const rows: RiverRow[] = [];
  let running = Infinity;
  let dist = 0;
  // `k` walks downstream: along = -sign * k ... start upstream.
  const sign = RIVER_FLOW.sign;
  const start = -sign * RIVER_UP;
  const n = Math.round((RIVER_UP + RIVER_DOWN) / RIVER_STEP);
  for (let i = 0; i <= n; i++) {
    const along = start + sign * i * RIVER_STEP;
    const cx = f.x + f.nx * along;
    const cz = f.z + f.nz * along;
    let floor = Infinity;
    for (let a = -4.5; a <= 4.5; a += 1.5) floor = Math.min(floor, groundAt(cx + f.tx * a, cz + f.tz * a));
    const bank = Math.min(
      groundAt(cx + f.tx * RIVER_RIBBON_HALF, cz + f.tz * RIVER_RIBBON_HALF),
      groundAt(cx - f.tx * RIVER_RIBBON_HALF, cz - f.tz * RIVER_RIBBON_HALF),
    );
    // The channel fades out at its ends; so does the water.
    const ends = smoothstep(RIVER_UP, RIVER_UP - 90, Math.abs(along)) * smoothstep(RIVER_DOWN + 10, RIVER_DOWN - 60, Math.abs(along));
    const level = floor + 1.25 * ends - 0.4 * (1 - ends);
    running = Math.min(running, level);
    const y = Math.min(running, bank - 0.15);
    rows.push({ along, x: cx, z: cz, y, wet: y > floor + 0.05, rapid: 0, dist });
    dist += RIVER_STEP;
    if ((i & 31) === 31) yield;
  }
  for (let i = 0; i < rows.length; i++) {
    const a = rows[Math.max(0, i - 2)];
    const b = rows[Math.min(rows.length - 1, i + 2)];
    const grade = (a.y - b.y) / Math.max(1, b.dist - a.dist);
    rows[i].rapid = smoothstep(0.06, 0.32, grade);
  }
  return rows;
}

// ------------------------------------------------------- climbing faces ----

export interface BandFace {
  id: 'ice' | 'rock';
  crossing: BandCrossing;
  /** Radius of the terrain's cliff band. */
  bandR: number;
  /** Radius of the climbable face (through the wall's base point). */
  faceR: number;
  /** Polar angle of the base point (theta = atan2(x - SX, z - SZ)). */
  theta0: number;
  /** Half width of the face along its arc (metres). */
  halfWidth: number;
  /** Suggested ClimbWall.laneWidth / 2 (the lane stays planar). */
  laneHalf: number;
  cols: number;
  rows: number;
}

function band(id: 'ice' | 'rock', crossing: BandCrossing, bandR: number, halfWidth: number, laneHalf: number, rows: number): BandFace {
  const faceR = Math.hypot(crossing.baseX - SUMMIT_X, crossing.baseZ - SUMMIT_Z);
  return {
    id,
    crossing,
    bandR,
    faceR,
    theta0: Math.atan2(crossing.baseX - SUMMIT_X, crossing.baseZ - SUMMIT_Z),
    halfWidth,
    laneHalf,
    cols: Math.round(halfWidth * 2) + 1,
    rows,
  };
}

/** Ice wall: 84 m wide along the r = 720 circle; suggested lane width 6 m. */
export const ICE_FACE = band('ice', ICE_WALL, ICE_WALL_R, 42, 3, 58);
/** Rock band: 48 m wide along the r = 300 circle; suggested lane width 4.8 m. */
export const ROCK_FACE = band('rock', ROCK_BAND, ROCK_BAND_R, 24, 2.4, 46);

/** World (x, z) of a face point at arc offset `along` (+ = the climb tangent (nz, -nx)) and radius r. */
export function facePoint(face: BandFace, along: number, r: number): { x: number; z: number } {
  const th = face.theta0 + along / face.faceR;
  return { x: SUMMIT_X + Math.sin(th) * r, z: SUMMIT_Z + Math.cos(th) * r };
}

/** 0 inside the climbing lane, 1 well outside it. */
export function outsideLane(face: BandFace, along: number): number {
  return smoothstep(face.laneHalf + 0.6, face.laneHalf + 3.5, Math.abs(along));
}

/** Outward relief of the face (>= 0) at arc offset `along` and height y. */
export function faceRelief(face: BandFace, along: number, y: number): number {
  const lane = outsideLane(face, along);
  if (face.id === 'ice') {
    const flutes = 0.5 + 0.5 * Math.sin(along * 0.85 + 1.7 * valueNoise(along * 0.08, y * 0.05));
    const bulge = Math.max(0, valueNoise(along * 0.06 + 3, y * 0.045));
    const full = 0.3 + 0.55 * flutes + 0.7 * bulge + 0.12 * (valueNoise(along * 0.6, y * 0.6) + 1);
    const inLane = 0.04 + 0.03 * (valueNoise(along * 0.9, y * 0.7) + 1);
    return inLane + (full - inLane) * lane;
  }
  const blocks = Math.abs(fbm(along * 0.11 + 5, y * 0.13, 4)) * 1.4;
  const ledges = 0.35 * Math.max(0, Math.sin(y * 1.25 + valueNoise(along * 0.2, y * 0.1) * 2.2));
  const cracks = 0.25 * Math.abs(valueNoise(along * 0.9 + 3.3, y * 0.08));
  const full = 0.25 + blocks + ledges + cracks;
  const inLane = 0.06 + 0.05 * (valueNoise(along * 1.3, y * 1.1) + 1) + 0.04 * Math.max(0, Math.sin(y * 2.1));
  return inLane + (full - inLane) * lane;
}

export interface FaceGrid {
  face: BandFace;
  cols: number;
  rows: number;
  /** Face vertices, column-major: index = c * rows + j (j = 0 bottom). */
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  /** Arc offset of each column. */
  along: Float64Array;
  /** Height of the lip (face top) of each column. */
  lip: Float64Array;
  /** Radius of the face's top vertex in each column. */
  topR: Float64Array;
  /** Slab over the top (no hole behind the lip): same columns, `slabRows` rows. */
  slabRows: number;
  sx: Float64Array;
  sy: Float64Array;
  sz: Float64Array;
}

const SLAB_DR = [0, 0.35, 0.9, 1.8, 3, 4.5, 6.5, 9, 12, 16, 21, 27];
const SCAN_OUT = 4;
const SCAN_IN = 9;
const SCAN_STEP = 0.25;

/**
 * Build the face as a column grid along the band circle. Each column runs
 * from below the ground at its foot to the lip; outside the climbing lane
 * the face also wraps out over any terrain that pokes past it, and its ends
 * sink back into the terrain's own cliff band. The lane stays planar so the
 * climb (holds / axe bites) matches the ClimbWall plane.
 */
export function* faceGrid(face: BandFace): Gen<FaceGrid> {
  const cols = face.cols;
  const rows = face.rows;
  const n = cols * rows;
  const g: FaceGrid = {
    face,
    cols,
    rows,
    x: new Float64Array(n),
    y: new Float64Array(n),
    z: new Float64Array(n),
    along: new Float64Array(cols),
    lip: new Float64Array(cols),
    topR: new Float64Array(cols),
    slabRows: SLAB_DR.length,
    sx: new Float64Array(cols * SLAB_DR.length),
    sy: new Float64Array(cols * SLAB_DR.length),
    sz: new Float64Array(cols * SLAB_DR.length),
  };
  const scanN = Math.round((SCAN_OUT + SCAN_IN) / SCAN_STEP) + 1;
  const scanH = new Float64Array(scanN);
  const topY = face.crossing.topY;
  for (let c = 0; c < cols; c++) {
    const along = -face.halfWidth + (c / (cols - 1)) * face.halfWidth * 2;
    g.along[c] = along;
    // Terrain along the radial line through this column, outermost first.
    for (let k = 0; k < scanN; k++) {
      const r = face.faceR + SCAN_OUT - k * SCAN_STEP;
      const p = facePoint(face, along, r);
      scanH[k] = groundAt(p.x, p.z);
    }
    let front = Infinity;
    let behind = -Infinity;
    for (let k = 0; k < scanN; k++) {
      const r = face.faceR + SCAN_OUT - k * SCAN_STEP;
      if (r >= face.faceR + 0.5 && r <= face.faceR + 3) front = Math.min(front, scanH[k]);
      if (r <= face.faceR && r >= face.faceR - 8) behind = Math.max(behind, scanH[k]);
    }
    // Down to below the climb's floor too, so the lane is ice/rock from the start.
    const bottom = Math.min(front, face.crossing.baseY) - 1.6;
    const lip = Math.max(topY + 0.1, behind + 0.05);
    g.lip[c] = lip;
    const wrapW = outsideLane(face, along);
    const endT = smoothstep(face.halfWidth - 7, face.halfWidth, Math.abs(along));
    for (let j = 0; j < rows; j++) {
      const y = bottom + ((lip - bottom) * j) / (rows - 1);
      let r = face.faceR + faceRelief(face, along, y);
      if (wrapW > 0) {
        // Outermost terrain at or above this height: stay just outside it.
        for (let k = 0; k < scanN; k++) {
          if (scanH[k] >= y) {
            const rt = face.faceR + SCAN_OUT - k * SCAN_STEP;
            const wrap = Math.min(rt + 0.35, face.faceR + SCAN_OUT);
            if (wrap > r) r += (wrap - r) * wrapW;
            break;
          }
        }
      }
      r += (face.bandR - 2.5 - r) * endT;
      const p = facePoint(face, along, r);
      const i = c * rows + j;
      g.x[i] = p.x;
      g.y[i] = y;
      g.z[i] = p.z;
      if (j === rows - 1) g.topR[c] = r;
    }
    // The slab: from the lip inward until it has met the terrain.
    for (let k = 0; k < SLAB_DR.length; k++) {
      const dr = SLAB_DR[k];
      const r = g.topR[c] - dr;
      const p = facePoint(face, along, r);
      const h = groundAt(p.x, p.z);
      const drop = dr <= 8 ? 0.12 * dr : 0.96 + 0.5 * (dr - 8);
      let y = Math.max(h + 0.22, lip - drop);
      if (k === 0) y = lip;
      if (k === SLAB_DR.length - 1) y = h - 0.8;
      const i = c * SLAB_DR.length + k;
      g.sx[i] = p.x;
      g.sy[i] = y;
      g.sz[i] = p.z;
    }
    if ((c & 7) === 7) yield;
  }
  return g;
}

// -------------------------------------------------------------- holds -----

export interface HoldSpec {
  x: number;
  y: number;
  z: number;
  /** Arc offset along the lane (for checks). */
  along: number;
  lip: boolean;
  /** Mesh scale and seed. */
  scale: number;
  seed: number;
}

/**
 * Holds up the rock band's lane, like the tutorial's holdLayout(): rows
 * 0.46 m apart, 4-5 holds across, staggered, from just above the foot to
 * the lip, then three big lip jugs on top.
 */
export function rockHolds(grid: FaceGrid): HoldSpec[] {
  const face = grid.face;
  const holds: HoldSpec[] = [];
  let seed = 1;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const mid = Math.floor(grid.cols / 2);
  const lip = grid.lip[mid];
  const foot = facePoint(face, 0, face.faceR + 1.2);
  const start = Math.max(face.crossing.baseY + 0.9, groundAt(foot.x, foot.z) + 0.35);
  const end = lip - 0.4;
  const span = face.laneHalf - 0.3;
  let row = 0;
  for (let y = start; y <= end; y += 0.46, row++) {
    const across = [-1.35, -0.45, 0.45, 1.35];
    if (row % 3 === 1) across.push(row % 2 ? 1.85 : -1.85);
    const stagger = row % 2 ? 0.12 : -0.12;
    for (const a0 of across) {
      const along = Math.max(-span, Math.min(span, a0 + stagger + (rnd() - 0.5) * 0.24));
      const hy = Math.min(end + 0.1, y + (rnd() - 0.5) * 0.14);
      const r = face.faceR + faceRelief(face, along, hy) + 0.05;
      const p = facePoint(face, along, r);
      holds.push({ x: p.x, y: hy, z: p.z, along, lip: false, scale: 1 + rnd() * 0.25, seed: holds.length * 3.1 });
    }
  }
  for (const along of [-0.7, 0, 0.7]) {
    const p = facePoint(face, along, face.faceR - 0.12);
    holds.push({ x: p.x, y: lip + 0.12, z: p.z, along, lip: true, scale: 1.6, seed: holds.length * 3.1 });
  }
  return holds;
}

/** Where a face column's foot meets the ground (for talus and signs). */
export function faceFootY(face: BandFace, along: number): number {
  const p = facePoint(face, along, face.faceR + 1.5);
  return groundMin(p.x, p.z, 1);
}
