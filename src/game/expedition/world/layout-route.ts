/**
 * Route dressing: bamboo marker wands, cairns at the hairpins and trail
 * signs at the start of each section. Pure layout (no Three.js).
 */

import { mulberry32 } from '../../terrain.js';
import {
  CAMPS,
  campCentre,
  CREVASSE_S,
  ICE_WALL,
  outwardSide,
  RIVER_S,
  ROCK_BAND,
  ROPE_END_S,
  ROPE_START_S,
  routeFrame,
  SECTION_NAMES,
  SUMMIT_S,
} from '../exp-layout.js';
import { route, SECTION_ORDER, type SectionId } from '../exp-route.js';
import {
  CORRIDOR_CLEAR,
  type Gen,
  groundAt,
  groundMin,
  inCamp,
  type Item,
  item,
  MARKER_CLEAR,
  routeClearance,
  slopeAt,
} from './layout-util.js';

/** Spacing of the marker wands along the route. */
export const WAND_SPACING = 25;
/** Lateral position of the wands (at the edge of the flat bench). */
export const WAND_OFFSET = 4.3;

/** Arc-length ranges with no wands (features that mark themselves). */
const WAND_GAPS: Array<[number, number]> = [
  [RIVER_S - 16, RIVER_S + 16],
  [CREVASSE_S - 9, CREVASSE_S + 9],
  [ICE_WALL.s - 30, ICE_WALL.s + 28],
  [ROPE_START_S - 30, ROPE_END_S + 30],
  [ROCK_BAND.s - 26, ROCK_BAND.s + 18],
  [SUMMIT_S - 14, route.length + 1],
];

function inGap(s: number): boolean {
  for (const [a, b] of WAND_GAPS) if (s >= a && s <= b) return true;
  return false;
}

/** Ground beside the bench is close to the path height and not a drop. */
function besidePath(x: number, z: number, elev: number, tolerance: number): boolean {
  return Math.abs(groundAt(x, z) - elev) < tolerance && slopeAt(x, z) < 0.75;
}

export function* wandLayout(): Gen<Item[]> {
  const rand = mulberry32(811);
  const out: Item[] = [];
  let side = 1;
  let n = 0;
  for (let s = 20; s < route.length - 4; s += WAND_SPACING) {
    side = -side;
    if (inGap(s)) continue;
    const f = routeFrame(s);
    for (const trySide of [side, -side]) {
      const x = f.x + f.nx * trySide * WAND_OFFSET;
      const z = f.z + f.nz * trySide * WAND_OFFSET;
      if (!besidePath(x, z, f.elev, 0.4)) continue;
      if (routeClearance(x, z, 0.05) < MARKER_CLEAR) continue;
      if (inCamp(x, z, -2)) continue;
      // Bamboo wands are pushed ~25 cm into the snow.
      const w = item('wand', x, z, 0.05, rand() * Math.PI * 2, 1.65 + rand() * 0.25, n, 0.25, n % 2);
      out.push(w);
      break;
    }
    if (++n % 24 === 0) yield;
  }
  return out;
}

// ----------------------------------------------------------- hairpins -----

/** Arc lengths of the hairpin bends (excluding the two cliff crossings). */
export function hairpins(): number[] {
  const turn = (s: number) => {
    const a = routeFrame(s - 20);
    const b = routeFrame(s + 20);
    return Math.acos(Math.max(-1, Math.min(1, a.tx * b.tx + a.tz * b.tz)));
  };
  const out: number[] = [];
  for (let s = 32; s < route.length - 32; s += 2) {
    const t = turn(s);
    if (t < 1.0 || t < turn(s - 2) || t < turn(s + 2)) continue;
    if (Math.abs(s - ICE_WALL.s) < 45 || Math.abs(s - ROCK_BAND.s) < 45) continue;
    if (out.length && s - out[out.length - 1] < 60) continue;
    out.push(s);
  }
  return out;
}

/** A cairn on the outside of each hairpin. */
export function* hairpinCairns(): Gen<Item[]> {
  const out: Item[] = [];
  let seed = 0;
  for (const s of hairpins()) {
    const f = routeFrame(s);
    const a = routeFrame(s - 25);
    const b = routeFrame(s + 25);
    let ox = a.tx - b.tx;
    let oz = a.tz - b.tz;
    const ol = Math.hypot(ox, oz) || 1;
    ox /= ol;
    oz /= ol;
    for (let dist = 6.5; dist <= 16; dist += 0.5) {
      const x = f.x + ox * dist;
      const z = f.z + oz * dist;
      if (routeClearance(x, z, 0.8) < CORRIDOR_CLEAR) continue;
      if (slopeAt(x, z) > 0.6 || Math.abs(groundAt(x, z) - f.elev) > 2.5) continue;
      out.push(item('cairn', x, z, 0.8, seed * 1.7, 1.25, 100 + seed, 0.1));
      break;
    }
    seed++;
    yield;
  }
  return out;
}

// -------------------------------------------------------------- signs -----

export interface SignSpec {
  x: number;
  y: number;
  z: number;
  /** Yaw so the board's front (+Z) faces the walker. */
  yaw: number;
  lines: [string, string];
  /** Height of the board centre above the base. */
  boardY: number;
}

/** Short names for distances on the signs. */
const CAMP_SHORT = ['Base Camp', 'Camp 1', 'Camp 2', 'Camp 3', 'High Camp'];

function km(m: number): string {
  return `${(Math.max(0, m) / 1000).toFixed(1)} km`;
}

function nextCampText(s: number): string {
  for (let i = 1; i < CAMPS.length; i++) {
    if (CAMPS[i].s > s + 20) return `${CAMP_SHORT[i]} ${km(CAMPS[i].s - s)}  ·  Summit ${km(SUMMIT_S - s)}`;
  }
  return `Summit ${km(SUMMIT_S - s)}  ·  glider launch`;
}

const SECTION_SUBTITLE: Partial<Record<SectionId, string>> = {
  icewall: '45 m of ice  ·  ice axes in both hands',
  rockband: '35 m of rock  ·  climb the holds',
};

/**
 * Place a sign beside the route at about arc length s, preferring the
 * uphill side, at `offset` from the centre line, facing oncoming walkers.
 */
export function signBeside(s: number, lines: [string, string], offset = 4.9, preferSide?: number): SignSpec | null {
  for (let tries = 0; tries < 8; tries++) {
    const q = s + tries * 3;
    const f = routeFrame(q);
    const up = preferSide ?? -outwardSide(q);
    for (const side of [up, -up]) {
      const x = f.x + f.nx * side * offset;
      const z = f.z + f.nz * side * offset;
      if (!besidePath(x, z, f.elev, 0.6)) continue;
      if (routeClearance(x, z, 0.7) < MARKER_CLEAR) continue;
      return {
        x,
        y: groundMin(x, z, 0.3),
        z,
        // Turned 25 degrees toward the path so it reads as you approach.
        yaw: Math.atan2(-f.tx, -f.tz) + side * 0.42,
        lines,
        boardY: 1.45,
      };
    }
  }
  return null;
}

export function* sectionSigns(): Gen<SignSpec[]> {
  const out: SignSpec[] = [];
  for (const id of SECTION_ORDER) {
    const start = route.sectionStart[id];
    let s = start + 8;
    if (id === 'valley') s = 70; // past Base Camp's own sign
    if (id === 'icewall') s = ICE_WALL.s - 22;
    if (id === 'rockband') s = ROCK_BAND.s - 20;
    const sub = SECTION_SUBTITLE[id] ?? nextCampText(s);
    const sign = signBeside(s, [SECTION_NAMES[id], sub]);
    if (sign) out.push(sign);
    yield;
  }
  return out;
}

/** Elevation gain above Base Camp, for the camp signs. */
export function campSignLines(index: number): [string, string] {
  const camp = CAMPS[index];
  const c = campCentre(camp);
  const gain = Math.round(c.elev - campCentre(CAMPS[0]).elev);
  if (index === 0) return ['BASE CAMP', `Summit ${km(SUMMIT_S - camp.s)}  ·  1,300 m above`];
  return [camp.name.toUpperCase(), `${gain.toLocaleString('en-US')} m above Base Camp  ·  Summit ${km(SUMMIT_S - camp.s)}`];
}
