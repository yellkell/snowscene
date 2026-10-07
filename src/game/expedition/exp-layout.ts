/**
 * Where everything on the expedition happens, as arc lengths along the route
 * (metres from Base Camp). Pure data + math, no Three.js, so the terrain
 * worker, content builders, mechanics and the director all agree.
 *
 * Route legs (straight-ish stretches between hairpins):
 *   valley   0-1710      the long walk in: one 1.7 km arc, river at 650
 *   forest   1760-2360   switchback through the trees
 *   moraine  2410-3010, 3050-3600 (avalanche), 3640-4120
 *   glacier  4170-4750 (crevasse ladder, cloud deck), 4800-5290 (seracs), 5340-5753
 *   icewall  ~5760       45 m ice wall (axes)
 *   ridge    5790-6320, 6350-6780 (fixed rope traverse), 6810-7160 (rockfall), 7200-7477
 *   rockband ~7495       35 m rock band (holds)
 *   summit   7505-7788   summit dome, glider launch
 */

import {
  BAND_HALF_WIDTH,
  clamp,
  profile,
  ICE_WALL_R,
  ROCK_BAND_R,
  route,
  routePoint,
  routeTangent,
  type SectionId,
  smoothstep,
  SUMMIT_X,
  SUMMIT_Z,
} from './exp-route.js';

// ------------------------------------------------------------- camps -------

export interface Camp {
  id: string;
  name: string;
  /** Arc length of the camp on the route. */
  s: number;
  /** Flattened radius around the camp centre. */
  radius: number;
  /** Which side of the route the camp sits on (+1 left, -1 right, 0 on it). */
  side: number;
  /** Lateral offset of the camp centre from the route centre line. */
  offset: number;
  /** Size of the bonfire (Bonfire scale) and whether it's a party. */
  fireScale: number;
  party: boolean;
}

export const CAMPS: Camp[] = [
  { id: 'base', name: 'Base Camp', s: 45, radius: 38, side: 1, offset: 22, fireScale: 1.4, party: true },
  { id: 'c1', name: 'Camp 1 · Treeline', s: 2440, radius: 16, side: -1, offset: 11, fireScale: 0.35, party: false },
  { id: 'c2', name: 'Camp 2 · Glacier Foot', s: 4200, radius: 16, side: 1, offset: 11, fireScale: 0.35, party: false },
  { id: 'c3', name: 'Camp 3 · Below the Ice', s: 5650, radius: 14, side: -1, offset: 10, fireScale: 0.3, party: false },
  { id: 'c4', name: 'High Camp', s: 7300, radius: 12, side: 1, offset: 9, fireScale: 0.28, party: false },
];

/** Where the player stands to begin (and respawns at the start). */
export const START_S = 12;
/** The summit marker; the glider launches from just past it. */
export const SUMMIT_S = 7770;

// ---------------------------------------------------------- features -------

export const RIVER_S = 650;
export const RIVER_HALF_WIDTH = 6;
export const RIVER_DEPTH = 3.2;

export const CREVASSE_S = 4500;
export const CREVASSE_HALF_GAP = 1.4;
export const CREVASSE_HALF_LENGTH = 32;
export const CREVASSE_DEPTH = 28;

/** Exposed ledge with a fixed rope: the downhill side drops away. */
export const ROPE_START_S = 6450;
export const ROPE_END_S = 6650;
/** Height of the fixed rope above the path (anchors every ~12 m). */
export const ROPE_HEIGHT = 1.05;

/** Timed events: triggered when the player passes `triggerS`. */
export const AVALANCHE = { triggerS: 3240, crossS: 3330, width: 60 };
export const SERAC = { triggerS: 4990, s: 5060 };
export const ROCKFALL = { triggerS: 6920, s: 6990 };
/** Serac field on the glacier. */
export const SERAC_FIELD = { startS: 4880, endS: 5260 };

/** Height of the cloud deck (sea of clouds). The glacier climbs through it. */
export const EXP_CLOUD_DECK_Y = 650;

// ---------------------------------------------------- frames on route -----

export interface RouteFrame {
  x: number;
  z: number;
  elev: number;
  /** Unit direction of travel. */
  tx: number;
  tz: number;
  /** Unit left normal (tx, tz rotated +90 degrees about +Y). */
  nx: number;
  nz: number;
}

/** Position and orientation of the route at arc length s. */
export function routeFrame(s: number, out: RouteFrame = {} as RouteFrame): RouteFrame {
  const p = routePoint(s);
  const t = routeTangent(s);
  out.x = p.x;
  out.z = p.z;
  out.elev = p.elev;
  out.tx = t.x;
  out.tz = t.z;
  // Left of travel when looking down from +Y with yaw 0 = -Z: (tz, -tx).
  out.nx = t.z;
  out.nz = -t.x;
  return out;
}

/** Signed "outward" (away from the summit) direction at s: +1 if left is downhill. */
export function outwardSide(s: number): number {
  const f = routeFrame(s);
  const ox = f.x - SUMMIT_X;
  const oz = f.z - SUMMIT_Z;
  return f.nx * ox + f.nz * oz >= 0 ? 1 : -1;
}

/** World centre of a camp. */
export function campCentre(camp: Camp): { x: number; z: number; elev: number } {
  const f = routeFrame(camp.s);
  return {
    x: f.x + f.nx * camp.side * camp.offset,
    z: f.z + f.nz * camp.side * camp.offset,
    elev: f.elev,
  };
}

// ------------------------------------------------------- cliff bands ------

export interface BandCrossing {
  /** Arc length where the route crosses the band edge. */
  s: number;
  /** Where the wall's foot meets the route (outer edge of the band slope). */
  baseX: number;
  baseZ: number;
  /** Outward (away from summit) horizontal unit normal of the face. */
  nx: number;
  nz: number;
  /** Floor heights at the foot and on top. */
  baseY: number;
  topY: number;
  /** Where to stand after topping out. */
  topX: number;
  topZ: number;
}

function crossing(radius: number): BandCrossing {
  let s = 0;
  for (let q = 0; q < route.length; q += 1) {
    const p = routePoint(q);
    if (Math.hypot(p.x - SUMMIT_X, p.z - SUMMIT_Z) <= radius) {
      s = q;
      break;
    }
  }
  const p = routePoint(s);
  const ox = p.x - SUMMIT_X;
  const oz = p.z - SUMMIT_Z;
  const len = Math.hypot(ox, oz);
  const nx = ox / len;
  const nz = oz / len;
  const outer = radius + BAND_HALF_WIDTH + 0.8;
  const inner = radius - BAND_HALF_WIDTH - 3;
  return {
    s,
    baseX: SUMMIT_X + nx * outer,
    baseZ: SUMMIT_Z + nz * outer,
    nx,
    nz,
    baseY: profile(outer),
    topY: profile(inner),
    topX: SUMMIT_X + nx * inner,
    topZ: SUMMIT_Z + nz * inner,
  };
}

/** The ice wall (climbed with axes) and the rock band (climbed on holds). */
export const ICE_WALL = crossing(ICE_WALL_R);
export const ROCK_BAND = crossing(ROCK_BAND_R);

// ------------------------------------------------- time and weather -------

interface Key {
  s: number;
  v: number;
}

function keyed(keys: Key[], s: number): number {
  if (s <= keys[0].s) return keys[0].v;
  for (let i = 1; i < keys.length; i++) {
    if (s <= keys[i].s) {
      const a = keys[i - 1];
      const b = keys[i];
      const t = smoothstep(0, 1, (s - a.s) / (b.s - a.s));
      return a.v + (b.v - a.v) * t;
    }
  }
  return keys[keys.length - 1].v;
}

/**
 * Time of day (hours, may exceed 24 after midnight) as a function of
 * progress: dawn at Base Camp, dusk at the ice wall, a night on the ridge
 * under the aurora, sunrise on the summit.
 */
const TIME_KEYS: Key[] = [
  { s: 0, v: 6.6 },
  { s: 1700, v: 9.0 },
  { s: 3000, v: 11.5 },
  { s: 4200, v: 14.5 },
  { s: 5300, v: 17.2 },
  { s: 5760, v: 19.3 },
  { s: 6300, v: 22.0 },
  { s: 6900, v: 25.5 },
  { s: 7300, v: 28.4 },
  { s: 7700, v: 29.9 },
  { s: 7788, v: 30.2 },
];

export function timeOfDayAt(s: number): number {
  return keyed(TIME_KEYS, s);
}

/** Baseline storm level (0..1) by progress; the director adds squalls. */
const STORM_KEYS: Key[] = [
  { s: 0, v: 0.12 },
  { s: 900, v: 0.08 },
  { s: 1400, v: 0.35 },
  { s: 2300, v: 0.3 },
  { s: 2600, v: 0.05 },
  { s: 4100, v: 0.1 },
  { s: 4450, v: 0.65 },
  { s: 4750, v: 0.55 },
  { s: 5000, v: 0.12 },
  { s: 5550, v: 0.55 },
  { s: 5760, v: 0.95 },
  { s: 5850, v: 0.5 },
  { s: 6100, v: 0.02 },
  { s: 7100, v: 0.0 },
  { s: 7350, v: 0.35 },
  { s: 7500, v: 0.4 },
  { s: 7600, v: 0.03 },
];

export function baseStormAt(s: number): number {
  return clamp(keyed(STORM_KEYS, s), 0, 1);
}

/** Display names for each section (guide / wrist HUD). */
export const SECTION_NAMES: Record<SectionId, string> = {
  valley: 'The Long Valley',
  forest: 'Pine Switchbacks',
  moraine: 'The Moraine',
  glacier: 'Glacier & Cloud Sea',
  icewall: 'The Ice Wall',
  ridge: 'The Night Ridge',
  rockband: 'Summit Rock Band',
  summit: 'The Summit',
};

// ------------------------------------------------- walkable overrides -----

/** Half length of the log bridge's walkable deck. */
export const BRIDGE_HALF_LENGTH = RIVER_HALF_WIDTH + 4;
const bridgeEnds = {
  near: routePoint(RIVER_S - BRIDGE_HALF_LENGTH).elev,
  far: routePoint(RIVER_S + BRIDGE_HALF_LENGTH).elev,
};

/**
 * Deck height at along-route offset a (-BRIDGE_HALF_LENGTH..+): it follows
 * the path's slope so each end meets the bank without a step (deck ends sit
 * 12 cm above the path), and sags a little in the middle.
 */
export function bridgeDeckAt(a: number): number {
  const t = clamp(a / BRIDGE_HALF_LENGTH, -1, 1);
  const base = bridgeEnds.near + (bridgeEnds.far - bridgeEnds.near) * (t * 0.5 + 0.5);
  return base + 0.12 - 0.18 * (1 - t * t);
}

/** Height of the log bridge over the river, or null off the bridge. */
export function bridgeHeight(x: number, z: number): number | null {
  const f = routeFrame(RIVER_S);
  const dx = x - f.x;
  const dz = z - f.z;
  const along = dx * f.tx + dz * f.tz;
  const across = dx * f.nx + dz * f.nz;
  if (Math.abs(along) > BRIDGE_HALF_LENGTH || Math.abs(across) > 1.6) return null;
  return bridgeDeckAt(along);
}

/** Height of the ladder across the crevasse, or null off it. */
export function ladderHeight(x: number, z: number): number | null {
  const f = routeFrame(CREVASSE_S);
  const dx = x - f.x;
  const dz = z - f.z;
  const along = dx * f.tx + dz * f.tz;
  const across = dx * f.nx + dz * f.nz;
  if (Math.abs(along) > CREVASSE_HALF_GAP + 0.9 || Math.abs(across) > 0.5) return null;
  return f.elev + 0.08;
}
