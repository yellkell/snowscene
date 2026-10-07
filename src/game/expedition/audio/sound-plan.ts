/**
 * Pure planning logic for the expedition soundscape (no WebAudio, no Three):
 * which ambience zones are active at an arc length, the footstep surface,
 * where the river and camps are, distance curves, the score plan (which
 * music or pad plays where, with a fatigue rule so neither track loops
 * forever) and the footstep stride clock. Checked in node.
 */

import { clamp, route, smoothstep } from '../exp-route.js';
import {
  bridgeHeight,
  CAMPS,
  campCentre,
  ladderHeight,
  RIVER_DEPTH,
  RIVER_S,
  routeFrame,
  START_S,
} from '../exp-layout.js';

// ------------------------------------------------------------- zones ------

/** Ambience zone weights 0..1 (overlapping crossfades between sections). */
export interface Zones {
  valley: number;
  forest: number;
  moraine: number;
  glacier: number;
  ridge: number;
  summit: number;
}

export function makeZones(): Zones {
  return { valley: 1, forest: 0, moraine: 0, glacier: 0, ridge: 0, summit: 0 };
}

const ST = route.sectionStart;

/** Fill `out` with the zone weights at arc length s. */
export function zoneWeights(s: number, out: Zones): Zones {
  const intoForest = smoothstep(ST.forest - 150, ST.forest + 60, s);
  const intoMoraine = smoothstep(ST.moraine - 40, ST.moraine + 120, s);
  const intoGlacier = smoothstep(ST.glacier - 60, ST.glacier + 100, s);
  const intoRidge = smoothstep(ST.icewall - 10, ST.ridge + 40, s);
  const intoSummit = smoothstep(ST.summit - 20, ST.summit + 60, s);
  out.valley = 1 - intoForest;
  out.forest = intoForest * (1 - intoMoraine);
  out.moraine = intoMoraine * (1 - intoGlacier);
  out.glacier = intoGlacier * (1 - intoRidge);
  out.ridge = intoRidge * (1 - intoSummit);
  out.summit = intoSummit;
  return out;
}

/** Zones at Base Camp (the finale): the valley. */
export function valleyZones(out: Zones): Zones {
  out.valley = 1;
  out.forest = out.moraine = out.glacier = out.ridge = out.summit = 0;
  return out;
}

export function silentZones(out: Zones): Zones {
  out.valley = out.forest = out.moraine = out.glacier = out.ridge = out.summit = 0;
  return out;
}

// ----------------------------------------------------------- surfaces -----

export type Surface = 'packed' | 'powder' | 'gravel' | 'firn' | 'squeak' | 'wood' | 'metal';

/** What the boots are on. Bridge and ladder take priority over the section. */
export function surfaceAt(s: number, x: number, z: number, daylight: number): Surface {
  if (Math.abs(s - RIVER_S) < 20 && bridgeHeight(x, z) !== null) return 'wood';
  if (ladderHeight(x, z) !== null) return 'metal';
  if (s >= ST.icewall) {
    // Above the ice wall: hard, bitterly cold snow squeaks underfoot at night.
    return daylight < 0.55 ? 'squeak' : 'firn';
  }
  if (s >= ST.glacier) return 'firn';
  if (s >= ST.moraine) return 'gravel';
  if (s >= ST.forest + 60) return 'powder';
  return 'packed';
}

// -------------------------------------------------------- the river -------

const river = routeFrame(RIVER_S);
/** Water surface height under the bridge. */
const RIVER_Y = river.elev - RIVER_DEPTH + 0.6;
/** Half-length of the audible channel (it tapers out by 900 m). */
const RIVER_REACH = 760;

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Nearest point on the river (a line across the valley through the bridge,
 * flowing along the route's normal) to (x, z). Returns the 3D distance from
 * (x, y, z) to it.
 */
export function nearestRiverPoint(x: number, y: number, z: number, out: Point3): number {
  const t = clamp((x - river.x) * river.nx + (z - river.z) * river.nz, -RIVER_REACH, RIVER_REACH);
  out.x = river.x + river.nx * t;
  out.z = river.z + river.nz * t;
  out.y = RIVER_Y;
  return Math.hypot(x - out.x, y - out.y, z - out.z);
}

// --------------------------------------------------------- the camps ------

export interface CampPoint extends Point3 {
  id: string;
  party: boolean;
}

export const CAMP_POINTS: CampPoint[] = CAMPS.map((camp) => {
  const c = campCentre(camp);
  return { id: camp.id, party: camp.party, x: c.x, y: c.elev + 1.2, z: c.z };
});

/** Index of the nearest camp to (x, z), its distance written to dist[0]. */
export function nearestCamp(x: number, y: number, z: number, dist: number[]): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < CAMP_POINTS.length; i++) {
    const c = CAMP_POINTS[i];
    const d = Math.hypot(x - c.x, y - c.y, z - c.z);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  dist[0] = bestD;
  return best;
}

// --------------------------------------------------------- distances ------

/**
 * Loudness falloff we control ourselves (panners run with rolloff 0):
 * 1 / (1 + (d / ref)^power), faded to silence between fadeStart and fadeEnd.
 */
export function falloff(d: number, ref: number, power: number, fadeStart: number, fadeEnd: number): number {
  const g = 1 / (1 + Math.pow(Math.max(0, d) / ref, power));
  return g * (1 - smoothstep(fadeStart, fadeEnd, d));
}

/** Air absorption: low-pass cutoff (Hz) for a source d metres away. */
export function airCutoff(d: number, near = 16000): number {
  return clamp(near / (1 + d / 45), 700, near);
}

/** Bernoulli trial for a memoryless event at `rate` per second over dt. */
export function chance(rate: number, dt: number, rng: () => number): boolean {
  return rate > 0 && rng() < 1 - Math.exp(-rate * dt);
}

// ------------------------------------------------------------ score -------

/**
 * 'intro'    Base Camp before setting out: no score, just camp and guitar.
 * 'river'    By the River (valley + forest, and again above the clouds).
 * 'pad'      generative day pad (moraine, glacier whiteout, rests).
 * 'padNight' minor pad with the aurora (night ridge, rock band).
 * 'night'    Night Catch (summit, glide, Base Camp party).
 * 'silence'  nothing (director override only).
 */
export type ScoreMode = 'intro' | 'river' | 'pad' | 'padNight' | 'night' | 'silence';

export const SCORE_MARKS = {
  /** Walk this far out of Base Camp, or wait this long, and the score begins. */
  introLeaveS: START_S + 45,
  introSeconds: 50,
  /** Just past Camp 1: the moraine belongs to the pad. */
  riverEndS: 2470,
  /** Above the cloud deck on the glacier: By the River returns. */
  breakoutS: 4760,
  /** Once the ice wall's blizzard is behind: the night pad. */
  nightPadS: ST.ridge + 100,
  /** Summit section (sunrise): Night Catch through to the end. */
  summitS: ST.summit,
};

/** Longest unbroken run of By the River before the pad takes a turn. */
export const RIVER_MAX_SECONDS = 12.5 * 60;
/** How long a fatigue rest lasts. */
export const REST_SECONDS = 3.5 * 60;
/** A mode is held at least this long before an s-driven change (no flapping). */
export const MIN_HOLD_SECONDS = 25;
/** A wanted change must persist this long before it happens. */
export const DEBOUNCE_SECONDS = 3;
/** Metres past a mark before the route changes the score (walking back and forth). */
export const HYSTERESIS_M = 60;
/** Don't start a fatigue rest this close to the end of a river stretch... */
export const REST_MIN_LEFT_M = 400;
/** ...and don't bring the river back for less than this. */
export const RETURN_MIN_LEFT_M = 300;

export interface ScoreContext {
  s: number;
  /** Launch, Gliding or Landed: the finale. */
  flying: boolean;
  summited: boolean;
  /** Seconds since the expedition started. */
  sinceStart: number;
}

/** The score the route asks for at this point, before fatigue and debounce. */
export function desiredScore(c: ScoreContext): ScoreMode {
  const m = SCORE_MARKS;
  if (c.flying || c.summited || c.s >= m.summitS) return 'night';
  if (c.sinceStart < m.introSeconds && c.s < m.introLeaveS) return 'intro';
  if (c.s < m.riverEndS) return 'river';
  if (c.s < m.breakoutS) return 'pad';
  if (c.s < m.nightPadS) return 'river';
  return 'padNight';
}

/** Metres of By the River stretch left ahead of s (0 outside one). */
export function riverLeft(s: number): number {
  const m = SCORE_MARKS;
  if (s < m.riverEndS) return m.riverEndS - s;
  if (s >= m.breakoutS && s < m.nightPadS) return m.nightPadS - s;
  return 0;
}

export class ScorePlanner {
  mode: ScoreMode = 'intro';
  /** Seconds in the current mode. */
  held = 0;
  /** Seconds of unbroken By the River. */
  riverRun = 0;
  /** Seconds left of a fatigue rest (pad instead of river). */
  restLeft = 0;
  private pending: ScoreMode | null = null;
  private pendingFor = 0;
  private offRiver = 0;

  reset(): void {
    this.mode = 'intro';
    this.held = 0;
    this.riverRun = 0;
    this.restLeft = 0;
    this.pending = null;
    this.pendingFor = 0;
    this.offRiver = 0;
  }

  update(c: ScoreContext, dt: number, override: ScoreMode | null): ScoreMode {
    this.held += dt;
    // Track how long By the River has been looping.
    if (this.mode === 'river') {
      this.riverRun += dt;
      this.offRiver = 0;
    } else if (this.restLeft <= 0) {
      this.offRiver += dt;
      if (this.offRiver > 45) this.riverRun = 0;
    }

    let want = override ?? this.routeWant(c);
    if (override === null && want === 'river') {
      const left = riverLeft(c.s);
      if (this.restLeft <= 0 && this.riverRun >= RIVER_MAX_SECONDS && left > REST_MIN_LEFT_M) {
        this.restLeft = REST_SECONDS;
      }
      if (this.restLeft > 0) {
        this.restLeft -= dt;
        want = 'pad';
        if (this.restLeft <= 0) {
          if (left < RETURN_MIN_LEFT_M) {
            // Nearly at the end of the stretch: stay on the pad.
            this.restLeft = 1;
          } else {
            this.restLeft = 0;
            this.riverRun = 0;
            want = 'river';
          }
        }
      }
    } else if (this.restLeft > 0) {
      // Left the river stretch mid-rest: the rest is over.
      this.restLeft = 0;
      this.riverRun = 0;
    }

    if (want === this.mode) {
      this.pending = null;
      this.pendingFor = 0;
      return this.mode;
    }
    const forced = override !== null || want === 'night' || this.mode === 'intro' || this.restLeft > 0;
    if (want !== this.pending) {
      this.pending = want;
      this.pendingFor = 0;
    }
    this.pendingFor += dt;
    const resting = this.mode === 'river' && want === 'pad' && this.restLeft > 0;
    const leavingRest = this.mode === 'pad' && want === 'river' && this.riverRun === 0 && this.offRiver === 0;
    if (forced || resting || leavingRest || (this.pendingFor >= DEBOUNCE_SECONDS && this.held >= MIN_HOLD_SECONDS)) {
      this.mode = want;
      this.held = 0;
      this.pending = null;
      this.pendingFor = 0;
    }
    return this.mode;
  }

  /** The route's score with hysteresis: keep the current mode near its edges. */
  private routeWant(c: ScoreContext): ScoreMode {
    const want = desiredScore(c);
    if (want === this.mode || want === 'night' || this.mode === 'intro' || this.mode === 'night') return want;
    const s = c.s;
    c.s = s - HYSTERESIS_M;
    const behind = desiredScore(c);
    c.s = s + HYSTERESIS_M;
    const ahead = desiredScore(c);
    c.s = s;
    // A fatigue rest plays the pad inside a river stretch: compare as river.
    const current = this.mode === 'pad' && this.restLeft > 0 ? 'river' : this.mode;
    return behind === current || ahead === current ? current : want;
  }
}

// --------------------------------------------------------- footsteps ------

/** Turns head travel into footfalls: returns -1 (left), +1 (right) or 0. */
export class StepClock {
  private travelled = 0;
  private since = 0;
  private side = 1;

  reset(): void {
    this.travelled = 0;
    this.since = 0;
  }

  /** Stride length grows with speed (longer, quicker steps when hurrying). */
  static stride(speed: number): number {
    return clamp(0.62 + speed * 0.16, 0.65, 1.15);
  }

  advance(dist: number, dt: number, speed: number): number {
    this.since += dt;
    const stride = StepClock.stride(speed);
    if (speed < 0.3) {
      // Standing: the next step lands half a stride after setting off.
      this.travelled = Math.min(this.travelled, stride * 0.5);
      return 0;
    }
    this.travelled += dist;
    if (this.travelled < stride || this.since < 0.26) return 0;
    this.travelled = Math.min(this.travelled - stride, stride * 0.5);
    this.since = 0;
    this.side = -this.side;
    return this.side;
  }
}
