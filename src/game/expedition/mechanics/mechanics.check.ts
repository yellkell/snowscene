/**
 * Node check for the pure parts of the crossing mechanics (no Three.js):
 *
 *   npx esbuild src/game/expedition/mechanics/mechanics.check.ts --bundle \
 *     --platform=node --outfile=/tmp/mech-check.cjs && node /tmp/mech-check.cjs
 *
 * Verifies the rope geometry (uphill side of the ledge, height above the
 * terrain, anchors), the crossing footprints against exp-layout's walkable
 * overrides, the walk-gate defaults, and simulates the balance model for
 * careful / sloppy / reckless players.
 */

import { project, type Projection } from '../exp-route.js';
import {
  bridgeHeight,
  CREVASSE_HALF_GAP,
  ladderHeight,
  outwardSide,
  ROPE_END_S,
  ROPE_HEIGHT,
  ROPE_START_S,
} from '../exp-layout.js';
import { expeditionHeight } from '../exp-terrain.js';
import {
  ANCHOR_SPACING,
  nearestOnRope,
  ROPE_FIRST_S,
  ROPE_LAST_S,
  ROPE_SAG,
  ROPE_SIDE_OFFSET,
  ropeAnchors,
  ropeData,
  ropePoints,
  ropeSpanAt,
  type RopeHit,
} from './rope-geometry.js';
import {
  funnelHalfWidth,
  HANDLINE,
  handLineHeight,
  LADDER,
  LADDER_FLOOR_Y,
  LOG,
  logFloorY,
  nearestHandLine,
  onFootprint,
  speedCapAt,
  toLocal,
  type HandLineHit,
  type Local,
} from './crossing-geometry.js';
import {
  type BalanceInputs,
  type BalanceParams,
  createBalance,
  LADDER_BALANCE,
  LOG_BALANCE,
  stepBalance,
} from './balance.js';
import { walkGate } from './walk-gate.js';
import { mechanicsSpeedLimit } from './mechanics-state.js';
import { ROPE_GATE_S } from './rope-rules.js';

let failures = 0;
function check(ok: boolean, what: string): void {
  if (!ok) {
    failures++;
    console.log(`FAIL  ${what}`);
  } else {
    console.log(`ok    ${what}`);
  }
}
const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps;

// ------------------------------------------------------------- gate ------
check(walkGate.blockS === Infinity && walkGate.reason === '', 'walk gate starts open');
check(mechanicsSpeedLimit() === Infinity, 'speed limit starts unconstrained');
check(near(ROPE_GATE_S, ROPE_START_S - 1.5, 1e-9), `rope gate at ROPE_START_S - 1.5 (${ROPE_GATE_S})`);
check(ROPE_FIRST_S < ROPE_GATE_S - 1, 'rope begins before the gate (reachable while held there)');

// ------------------------------------------------------------- rope ------
const rope = ropeData();
const anchors = ropeAnchors();
const pts = ropePoints();
const proj: Projection = { s: 0, d: 0, dist: 0, elev: 0 };
check(anchors.length >= 2, `${anchors.length} anchors`);
check(near(anchors[0].s, ROPE_FIRST_S, 1e-6) && near(anchors[anchors.length - 1].s, ROPE_LAST_S, 1e-6), 'anchors span the rope');
check(ROPE_FIRST_S < ROPE_START_S && ROPE_LAST_S > ROPE_END_S, 'rope covers ROPE_START_S..ROPE_END_S');
check(Math.abs(rope.spacing - ANCHOR_SPACING) < 1.5, `anchor spacing ${rope.spacing.toFixed(2)} m (~12)`);
check(pts.length === rope.count, `${pts.length} dense rope points`);
const ledgeOut = outwardSide((ROPE_START_S + ROPE_END_S) / 2);
let worstSide = Infinity;
let worstOffset = 0;
let worstHeight = 0;
let worstLedge = 0;
for (const p of pts) {
  project(p.x, p.z, proj);
  // uphill = opposite to the outward (downhill) side
  worstSide = Math.min(worstSide, -proj.d * outwardSide(p.s));
  worstOffset = Math.max(worstOffset, Math.abs(proj.dist - ROPE_SIDE_OFFSET));
  const above = p.y - expeditionHeight(p.x, p.z);
  worstHeight = Math.max(worstHeight, Math.abs(above - (ROPE_HEIGHT - ROPE_SAG / 2)) - ROPE_SAG / 2);
  // the rope stands on the ledge itself: no drop, no wall under it
  worstLedge = Math.max(worstLedge, Math.abs(expeditionHeight(p.x, p.z) - proj.elev));
}
check(worstSide > 0.5, `every rope point is on the uphill side (min uphill offset ${worstSide.toFixed(3)} m)`);
check(worstOffset < 0.05, `rope lateral offset ${ROPE_SIDE_OFFSET} m from centre (worst error ${worstOffset.toFixed(3)})`);
check(worstHeight < 0.01, `rope height above expeditionHeight within [${ROPE_HEIGHT - ROPE_SAG}, ${ROPE_HEIGHT}] (excess ${worstHeight.toFixed(4)})`);
check(worstLedge < 0.25, `rope stands on the ledge floor (worst terrain deviation ${worstLedge.toFixed(3)} m)`);
for (const a of anchors) {
  if (!near(a.y - expeditionHeight(a.x, a.z), ROPE_HEIGHT, 1e-6)) {
    check(false, `anchor at s=${a.s} is ROPE_HEIGHT above the ground`);
  }
}
check(-ledgeOut === -outwardSide(ROPE_START_S) && -ledgeOut === -outwardSide(ROPE_END_S), 'uphill side constant along the ledge (matches the terrain ledge)');
// nearest-point queries
const hit: RopeHit = { dist: 0, u: 0, x: 0, y: 0, z: 0, tx: 0, tz: 0 };
{
  const mid = anchors[3];
  nearestOnRope(mid.x, mid.y + 0.05, mid.z, hit);
  check(near(hit.dist, 0.05, 0.005) && near(hit.u, mid.s, 0.3), `nearestOnRope at an anchor (d=${hit.dist.toFixed(3)}, u=${hit.u.toFixed(2)})`);
  nearestOnRope(mid.x, mid.y + 40, mid.z, hit);
  check(hit.dist > 30, 'nearestOnRope far above is far');
  nearestOnRope(0, 0, 0, hit);
  check(hit.dist === Infinity, 'nearestOnRope at the tutorial is Infinity');
  check(ropeSpanAt(anchors[0].s - 5) === 0 && ropeSpanAt(anchors[anchors.length - 1].s + 5) === anchors.length - 2, 'span index clamps');
  check(ropeSpanAt(anchors[2].s + 0.01) === 2, 'span index past an anchor');
}

// --------------------------------------------------------- crossings -----
const loc: Local = { a: 0, l: 0 };
function footprintMatches(c: typeof LADDER, height: (x: number, z: number) => number | null): boolean {
  for (let a = -c.halfLength - 1; a <= c.halfLength + 1; a += 0.25) {
    for (let l = -c.halfWidth - 0.5; l <= c.halfWidth + 0.5; l += 0.1) {
      const x = c.x + c.tx * a + c.nx * l;
      const z = c.z + c.tz * a + c.nz * l;
      toLocal(c, x, z, loc);
      const inside = onFootprint(c, loc);
      const h = height(x, z);
      // tolerate the boundary itself
      const edge = Math.abs(Math.abs(a) - c.halfLength) < 0.02 || Math.abs(Math.abs(l) - c.halfWidth) < 0.02;
      if (!edge && inside !== (h !== null)) return false;
    }
  }
  return true;
}
check(footprintMatches(LADDER, ladderHeight), 'ladder footprint matches ladderHeight');
check(footprintMatches(LOG, bridgeHeight), 'log footprint matches bridgeHeight');
check(near(LADDER_FLOOR_Y, ladderHeight(LADDER.x, LADDER.z) ?? NaN, 1e-6), 'ladder floor height');
check(near(logFloorY(0), bridgeHeight(LOG.x, LOG.z) ?? NaN, 1e-6), 'log floor height');
check(LADDER.gapHalf === CREVASSE_HALF_GAP, 'ladder gap = crevasse gap');
// the crevasse is really open beside the ladder and solid at the ladder ends
{
  const c = LADDER;
  const open = expeditionHeight(c.x + c.nx * 1.5, c.z + c.nz * 1.5);
  const lip = expeditionHeight(c.x + c.tx * (c.halfLength - 0.1), c.z + c.tz * (c.halfLength - 0.1));
  check(open < c.elev - 10, `crevasse open beside the ladder (${(open - c.elev).toFixed(1)} m)`);
  check(Math.abs(lip - c.elev) < 0.5, `ladder ends rest on the lips (${(lip - c.elev).toFixed(2)} m)`);
}
check(speedCapAt(LADDER, { a: 0, l: 0 }) === LADDER.speedCap, 'ladder speed cap on the ladder');
check(speedCapAt(LADDER, { a: 30, l: 0 }) === Infinity, 'no cap far from the ladder');
check(speedCapAt(LADDER, { a: LADDER.halfLength + 2, l: 0 }) > LADDER.speedCap, 'cap eases off on the approach');
check(funnelHalfWidth(LADDER, 0) === LADDER.footHalfWidth && funnelHalfWidth(LADDER, 6) > 4, 'funnel narrows only at the gap');
{
  const hh: HandLineHit = { side: 0, dist: 0, a: 0 };
  const y = LADDER_FLOOR_Y + handLineHeight(0);
  const x = LADDER.x + LADDER.nx * HANDLINE.lateral;
  const z = LADDER.z + LADDER.nz * HANDLINE.lateral;
  nearestHandLine(x, y, z, 0, hh);
  check(hh.side === 1 && hh.dist < 1e-6, 'left hand line found');
  nearestHandLine(LADDER.x - LADDER.nx * HANDLINE.lateral, y + 0.1, LADDER.z - LADDER.nz * HANDLINE.lateral, 0, hh);
  check(hh.side === -1 && near(hh.dist, 0.1, 1e-6), 'right hand line found');
  check(handLineHeight(HANDLINE.stakeA) === HANDLINE.height && handLineHeight(0) < HANDLINE.height, 'hand lines sag mid-span');
}

// ----------------------------------------------------------- balance -----
// Deterministic PRNG so the numbers are stable.
let seed = 12345;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const gauss = () => (rand() + rand() + rand() + rand() - 2) * 1.7;

interface Player {
  name: string;
  /** Mean and noise of the inputs. */
  lateral: number;
  lateralNoise: number;
  roll: number;
  rollNoise: number;
  asymNoise: number;
  effort: number;
  headSpeed: number;
  storm: number;
  holds: number;
}

/** Fraction of 12 s crossings that topple (|b| >= 1), and the median peak |b|. */
function simulate(p: BalanceParams, who: Player, trials = 600): { fall: number; peak: number } {
  let falls = 0;
  const peaks: number[] = [];
  const dt = 1 / 72;
  for (let t = 0; t < trials; t++) {
    const st = createBalance();
    let lat = 0;
    let roll = 0;
    let asym = 0;
    let peak = 0;
    let fell = false;
    const inp: BalanceInputs = { lateral: 0, roll: 0, handAsym: 0, sway: 0, effort: 0, headSpeed: 0, storm: 0, holds: 0 };
    for (let i = 0; i < 12 / dt; i++) {
      // Postural noise: slow random walks around the mean (OU processes).
      const prevLat = lat;
      lat += (-(lat - who.lateral) * 1.5 * dt) + who.lateralNoise * gauss() * Math.sqrt(dt) * 1.7;
      roll += (-(roll - who.roll) * 2 * dt) + who.rollNoise * gauss() * Math.sqrt(dt) * 2;
      asym += -asym * 2 * dt + who.asymNoise * gauss() * Math.sqrt(dt) * 2;
      inp.lateral = lat;
      inp.roll = roll;
      inp.handAsym = asym;
      inp.sway = (lat - prevLat) / dt;
      inp.effort = who.effort;
      inp.headSpeed = who.headSpeed;
      inp.storm = who.storm;
      inp.holds = who.holds;
      stepBalance(st, p, inp, dt, rand);
      peak = Math.max(peak, Math.abs(st.b));
      if (Math.abs(st.b) >= 1) {
        fell = true;
        break;
      }
    }
    if (fell) falls++;
    peaks.push(peak);
  }
  peaks.sort((a, b) => a - b);
  return { fall: falls / trials, peak: peaks[Math.floor(peaks.length / 2)] };
}

const careful: Player = { name: 'careful', lateral: 0, lateralNoise: 0.05, roll: 0, rollNoise: 0.06, asymNoise: 0.08, effort: 0.45, headSpeed: 0.4, storm: 0.65, holds: 0 };
const desktop: Player = { name: 'desktop W', lateral: 0, lateralNoise: 0, roll: 0, rollNoise: 0, asymNoise: 0, effort: 0.6, headSpeed: 0.5, storm: 0.65, holds: 0 };
const holding: Player = { ...careful, name: 'careful + both hand lines', effort: 0.8, holds: 2 };
const sloppy: Player = { name: 'sloppy', lateral: 0.18, lateralNoise: 0.08, roll: 0.12, rollNoise: 0.1, asymNoise: 0.15, effort: 0.9, headSpeed: 0.8, storm: 0.65, holds: 0 };
const reckless: Player = { name: 'reckless', lateral: 0.32, lateralNoise: 0.12, roll: 0.28, rollNoise: 0.15, asymNoise: 0.25, effort: 1.6, headSpeed: 1.3, storm: 0.65, holds: 0 };

const results: Array<[string, BalanceParams, Player, (r: { fall: number; peak: number }) => boolean, string]> = [
  ['ladder', LADDER_BALANCE, careful, (r) => r.fall < 0.01 && r.peak < 0.45, 'falls < 1 %, peak < 0.45'],
  ['ladder', LADDER_BALANCE, desktop, (r) => r.fall < 0.01, 'falls < 1 %'],
  ['ladder', LADDER_BALANCE, holding, (r) => r.fall === 0 && r.peak < 0.25, 'never falls, peak < 0.25'],
  ['ladder', LADDER_BALANCE, sloppy, (r) => r.fall > 0.05 && r.fall < 0.7 && r.peak > 0.5, 'wobbles hard, sometimes topples'],
  ['ladder', LADDER_BALANCE, reckless, (r) => r.fall > 0.9, 'almost always topples'],
  ['log', LOG_BALANCE, { ...careful, storm: 0.1, effort: 0.9 }, (r) => r.fall === 0 && r.peak < 0.35, 'never falls'],
  ['log', LOG_BALANCE, { ...sloppy, storm: 0.1, effort: 1.2 }, (r) => r.fall < 0.1, 'rarely falls'],
  ['log', LOG_BALANCE, { ...reckless, storm: 0.1, effort: 2.2, lateral: 0.45 }, (r) => r.fall > 0.25, 'often falls'],
];
for (const [where, params, who, ok, want] of results) {
  const r = simulate(params, who);
  check(ok(r), `${where} / ${who.name}: falls ${(r.fall * 100).toFixed(1)} %, median peak |b| ${r.peak.toFixed(2)} (${want})`);
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  throw new Error('mechanics check failed');
}
console.log('\nall mechanics checks passed');
