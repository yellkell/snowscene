/**
 * THE TIMBER WORKS: the score for the cave inside the Needle.
 *
 * The old timber company left a stack of wooden machinery in the ice cave
 * under the summit needle: rafts on a meltwater pool, rope hoists, a mill
 * wheel with level-hung gondolas, rope swings, ore skips and a ropeway. It
 * still runs on its own clock. The glider parts are on racks at three of its
 * stations and the old signal beacon is at the top of the chimney.
 *
 * The grammar is ff2's VOIDSTEP (Eye of the Temple's moving frame of
 * reference on a bar grid): every platform claims squares of a 3x3 grid laid
 * over a 2x2 m play space and moves its ANCHOR, the rig pose that pins it
 * to that claim. Consecutive platforms on the route share an anchor at the
 * moment of handover, so every crossing is one real step onto the next deck.
 * Unlike VOIDSTEP it is a climb, not a lap: the route never comes home. It
 * starts on the pool's jetty and ends 26 m higher at the beacon.
 *
 * The authoring rule that keeps it collision free: stations stand you on
 * their centre square, and a machine docks on one side of you and travels
 * across that side (or straight up), never along it. `validateScore()`
 * checks it and the sweep below boxes every deck against every other deck
 * over the full cycle.
 */

export type Sq = readonly [number, number]; // [col +east, row +south], -1..1
export interface V3 {
  x: number;
  y: number;
  z: number;
}

export const GRID = {
  /** Eye of the Temple's 3x3 grid over a 2x2 m play space. */
  pitch: 0.66,
  /** Deck edge; the 6 cm gap is the seam between squares. */
  tile: 0.6,
};

export const RIG = {
  /** A platform can take over tracking only when its anchor is within this of the rig. */
  alignEps: 0.03,
  alignEpsY: 0.05,
  /** A tile owns the head only when it is clearly inside; the tracked tile keeps a skirt. */
  tileInset: 0.05,
  trackedOutset: 0.09,
};

export const MUSIC = { bpm: 108, beatsPerBar: 4 };
export const BAR_SEC = (60 / MUSIC.bpm) * MUSIC.beatsPerBar;

/** Machine kinds, which decide how a platform is drawn. */
export type Kind =
  | 'station'
  | 'raft'
  | 'hoist'
  | 'incline'
  | 'swing'
  | 'gondola'
  | 'skip'
  | 'ropeway'
  | 'corner';

export interface PathKey {
  bar: number;
  a: V3;
  /** The segment arriving at this key follows a circle about `c` in a vertical plane. */
  arc?: { c: V3; plane: 'xy' | 'yz' };
}

export interface PlatformSpec {
  id: string;
  kind: Kind;
  claim: Sq[];
  keys: PathKey[];
  loopBars?: number;
  /** A glider part waits on this station's rack. */
  part?: 'LeftWing' | 'RightWing' | 'ControlBar';
  /** The station with the signal beacon. */
  beacon?: boolean;
}

export const v3 = (x: number, y: number, z: number): V3 => ({ x, y, z });
export const sqOffset = (sq: Sq): { x: number; z: number } => ({
  x: sq[0] * GRID.pitch,
  z: sq[1] * GRID.pitch,
});

const C: Sq = [0, 0];
const N: Sq = [0, -1];
const S: Sq = [0, 1];
const E: Sq = [1, 0];
const W: Sq = [-1, 0];
const NE: Sq = [1, -1];
const NW: Sq = [-1, -1];
const SE: Sq = [1, 1];
const SW: Sq = [-1, 1];

/* ── Anchors: the route through the cave, bottom to top ─────────────────── */

const P0 = v3(0, 0, 0); // the jetty on the meltwater pool
const P1 = v3(5.4, 0, 0); // across the pool by raft
const P2 = v3(5.4, 3.2, 0); // up the first hoist
const P3 = v3(5.4, 4.4, -6); // north up the incline
const P4 = v3(0, 4.4, -6); // west on the first rope swing
const P5 = v3(0, 9.4, -6); // up the long hoist: LEFT WING
const P6 = v3(0, 9.4, -12); // over the top of the mill wheel
const P7 = v3(-5.4, 12.4, -12); // west and up in the ore skip
const P8 = v3(-5.4, 13.4, -19); // north on the ropeway: RIGHT WING
const P9 = v3(-5.4, 18.4, -19); // up the chimney lift
const P10 = v3(-5.4, 21.4, -13); // the chimney trolley: up, then south
const P11 = v3(0.6, 21.4, -13); // east on the high swing: CONTROL BAR
const P12 = v3(0.6, 26.4, -13); // the last hoist to the beacon

const T10 = v3(-5.4, 21.4, -19); // the chimney trolley's corner

/** Mill wheel: gondolas ride a circle of radius WHEEL_R about this anchor. */
export const WHEEL_R = 3;
export const WHEEL_C = v3(0, 9.4, -9);
/** Rope swings hang from pivots this far above their stations. */
const SWING_LEN = 4;

/** Eight bars: docked at `a` from bar t, `dwell` there, `ride` to `b`, back. */
function shuttle(t: number, a: V3, b: V3, dwell = 2, ride = 2, arc?: PathKey['arc']) {
  return {
    keys: [
      { bar: t, a },
      { bar: t + dwell, a },
      { bar: t + dwell + ride, a: b, arc },
      { bar: t + 2 * dwell + ride, a: b },
      { bar: t + 2 * (dwell + ride), a, arc },
    ] as PathKey[],
    loopBars: 2 * (dwell + ride),
  };
}

/** The same with a corner in each ride: one bar to the turn, one bar on. */
function corner(t: number, a: V3, turn: V3, b: V3) {
  return {
    keys: [
      { bar: t, a },
      { bar: t + 2, a },
      { bar: t + 3, a: turn },
      { bar: t + 4, a: b },
      { bar: t + 6, a: b },
      { bar: t + 7, a: turn },
      { bar: t + 8, a },
    ] as PathKey[],
    loopBars: 8,
  };
}

/** The pivot a rope swing between `a` and `b` hangs from. */
function swingPivot(a: V3, b: V3): V3 {
  const half = Math.hypot(b.x - a.x, b.z - a.z) / 2;
  const rise = Math.sqrt(SWING_LEN * SWING_LEN - half * half);
  return v3((a.x + b.x) / 2, (a.y + b.y) / 2 + rise, (a.z + b.z) / 2);
}
export const SWING_1 = swingPivot(P3, P4);
export const SWING_2 = swingPivot(P10, P11);

/**
 * The mill wheel turns a quarter every four bars (two dwelling, two turning)
 * and carries four gondolas. One is always docked at the near station and
 * one at the far station; you ride near -> top -> far, eight bars.
 */
const WHEEL_STOPS: V3[] = [
  v3(WHEEL_C.x, WHEEL_C.y, WHEEL_C.z + WHEEL_R), // near (south)
  v3(WHEEL_C.x, WHEEL_C.y + WHEEL_R, WHEEL_C.z), // top
  v3(WHEEL_C.x, WHEEL_C.y, WHEEL_C.z - WHEEL_R), // far (north)
  v3(WHEEL_C.x, WHEEL_C.y - WHEEL_R, WHEEL_C.z), // bottom
];
function gondola(index: number): PlatformSpec {
  const keys: PathKey[] = [];
  for (let k = 0; k < 4; k++) {
    const at = WHEEL_STOPS[(index + k) % 4];
    keys.push({ bar: k * 4, a: at, arc: k > 0 ? { c: WHEEL_C, plane: 'yz' } : undefined });
    keys.push({ bar: k * 4 + 2, a: at });
  }
  keys.push({ bar: 16, a: WHEEL_STOPS[index], arc: { c: WHEEL_C, plane: 'yz' } });
  return { id: `gondola-${index}`, kind: 'gondola', claim: [E], keys, loopBars: 16 };
}

/** Quarter turns the wheel has made by `bar` (continuous, eased). */
export function wheelTurns(bar: number): number {
  const step = Math.floor(bar / 4);
  const f = bar - step * 4;
  return step + (f < 2 ? 0 : smooth((f - 2) / 2));
}

const station = (id: string, at: V3, claim: Sq[], extra: Partial<PlatformSpec> = {}): PlatformSpec => ({
  id,
  kind: 'station',
  claim,
  keys: [{ bar: 0, a: at }],
  ...extra,
});

export const PLATFORMS: PlatformSpec[] = [
  // ── The pool ──
  station('jetty', P0, [C, S, SW, SE]),
  { id: 'raft', kind: 'raft', claim: [NW, N, NE], ...shuttle(0, P0, P1) },
  station('pool-landing', P1, [C, S]),
  { id: 'hoist-1', kind: 'hoist', claim: [E], ...shuttle(5, P1, P2) },
  station('loft', P2, [C]),
  { id: 'incline', kind: 'incline', claim: [W], ...shuttle(10, P2, P3) },
  station('ledge', P3, [C, E]),
  { id: 'swing-1', kind: 'swing', claim: [N], ...shuttle(15, P3, P4, 2, 2, { c: SWING_1, plane: 'xy' }) },
  station('swing-landing', P4, [C, S]),
  { id: 'hoist-2', kind: 'hoist', claim: [W], ...shuttle(20, P4, P5, 2, 3) },
  station('wing-rack', P5, [C, S], { part: 'LeftWing' }),
  // ── The wheel hall ──
  gondola(0),
  gondola(1),
  gondola(2),
  gondola(3),
  station('wheel-landing', P6, [C, W]),
  { id: 'skip', kind: 'skip', claim: [N], ...shuttle(37, P6, P7) },
  station('skip-landing', P7, [C, S]),
  { id: 'ropeway', kind: 'ropeway', claim: [W], ...shuttle(42, P7, P8, 2, 3) },
  station('ropeway-rack', P8, [C, E], { part: 'RightWing' }),
  // ── The chimney ──
  { id: 'lift-3', kind: 'hoist', claim: [N], ...shuttle(50, P8, P9) },
  station('chimney-foot', P9, [C, W]),
  { id: 'trolley', kind: 'corner', claim: [E], ...corner(55, P9, T10, P10) },
  station('chimney-ledge', P10, [C, W]),
  { id: 'swing-2', kind: 'swing', claim: [N], ...shuttle(60, P10, P11, 2, 2, { c: SWING_2, plane: 'xy' }) },
  station('bar-rack', P11, [C, E], { part: 'ControlBar' }),
  { id: 'hoist-3', kind: 'hoist', claim: [W], ...shuttle(67, P11, P12, 2, 3) },
  station('beacon', P12, [C, E, SE], { beacon: true }),
];

export const INDEX: Record<string, number> = {};
PLATFORMS.forEach((p, i) => (INDEX[p.id] = i));

/** The route in order. A step may be any one of a group (the wheel's gondolas). */
export const ROUTE: string[][] = [
  ['jetty'],
  ['raft'],
  ['pool-landing'],
  ['hoist-1'],
  ['loft'],
  ['incline'],
  ['ledge'],
  ['swing-1'],
  ['swing-landing'],
  ['hoist-2'],
  ['wing-rack'],
  ['gondola-0', 'gondola-1', 'gondola-2', 'gondola-3'],
  ['wheel-landing'],
  ['skip'],
  ['skip-landing'],
  ['ropeway'],
  ['ropeway-rack'],
  ['lift-3'],
  ['chimney-foot'],
  ['trolley'],
  ['chimney-ledge'],
  ['swing-2'],
  ['bar-rack'],
  ['hoist-3'],
  ['beacon'],
];

/** Route step of every platform (-1 if it is not on the route). */
export const ROUTE_STEP: number[] = PLATFORMS.map((p) => ROUTE.findIndex((step) => step.includes(p.id)));
export const START_INDEX = INDEX['jetty'];
export const BEACON_INDEX = INDEX['beacon'];

/* ── Evaluation ─────────────────────────────────────────────────────────── */

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function loopBar(spec: PlatformSpec, bar: number): number {
  if (!spec.loopBars) return bar;
  const t0 = spec.keys[0].bar;
  let t = ((bar - t0) % spec.loopBars) + t0;
  if (t < t0) t += spec.loopBars;
  return t;
}

function lerpArc(k0: PathKey, k1: PathKey, f: number, out: V3): void {
  const arc = k1.arc;
  if (!arc) {
    out.x = k0.a.x + (k1.a.x - k0.a.x) * f;
    out.y = k0.a.y + (k1.a.y - k0.a.y) * f;
    out.z = k0.a.z + (k1.a.z - k0.a.z) * f;
    return;
  }
  // Circle in a vertical plane: 'xy' swings across x, 'yz' across z.
  const c = arc.c;
  const h0 = arc.plane === 'xy' ? k0.a.x - c.x : k0.a.z - c.z;
  const h1 = arc.plane === 'xy' ? k1.a.x - c.x : k1.a.z - c.z;
  const a0 = Math.atan2(k0.a.y - c.y, h0);
  let a1 = Math.atan2(k1.a.y - c.y, h1);
  while (a1 - a0 > Math.PI) a1 -= Math.PI * 2;
  while (a1 - a0 < -Math.PI) a1 += Math.PI * 2;
  const r0 = Math.hypot(h0, k0.a.y - c.y);
  const r1 = Math.hypot(h1, k1.a.y - c.y);
  const a = a0 + (a1 - a0) * f;
  const r = r0 + (r1 - r0) * f;
  const h = Math.cos(a) * r;
  out.y = c.y + Math.sin(a) * r;
  if (arc.plane === 'xy') {
    out.x = c.x + h;
    out.z = k0.a.z + (k1.a.z - k0.a.z) * f;
  } else {
    out.z = c.z + h;
    out.x = k0.a.x + (k1.a.x - k0.a.x) * f;
  }
}

/** A platform's anchor at bar time `bar`. */
export function anchorAt(spec: PlatformSpec, bar: number, out: V3): V3 {
  const keys = spec.keys;
  if (keys.length === 1 || !spec.loopBars) {
    out.x = keys[0].a.x;
    out.y = keys[0].a.y;
    out.z = keys[0].a.z;
    return out;
  }
  const t = loopBar(spec, bar);
  for (let i = keys.length - 2; i >= 0; i--) {
    if (t >= keys[i].bar) {
      const k0 = keys[i];
      const k1 = keys[i + 1];
      const span = k1.bar - k0.bar;
      lerpArc(k0, k1, span > 0 ? smooth((t - k0.bar) / span) : 0, out);
      return out;
    }
  }
  out.x = keys[0].a.x;
  out.y = keys[0].a.y;
  out.z = keys[0].a.z;
  return out;
}

const same = (a: V3, b: V3): boolean => a.x === b.x && a.y === b.y && a.z === b.z;

/** Whether the platform is travelling, and bars until its current dwell ends. */
export function dwellInfo(spec: PlatformSpec, bar: number, out: { moving: boolean; departIn: number }) {
  const keys = spec.keys;
  out.moving = false;
  out.departIn = Infinity;
  if (keys.length === 1 || !spec.loopBars) return out;
  const t = loopBar(spec, bar);
  for (let i = keys.length - 2; i >= 0; i--) {
    if (t >= keys[i].bar) {
      if (!same(keys[i].a, keys[i + 1].a)) out.moving = true;
      else out.departIn = keys[i + 1].bar - t;
      return out;
    }
  }
  return out;
}

/** The anchors a platform dwells at (its berths). */
export function berthsOf(spec: PlatformSpec): V3[] {
  if (spec.keys.length === 1) return [spec.keys[0].a];
  const seen: V3[] = [];
  for (let i = 0; i + 1 < spec.keys.length; i++) {
    const a = spec.keys[i].a;
    if (!same(a, spec.keys[i + 1].a)) continue;
    if (!seen.some((b) => same(a, b))) seen.push(a);
  }
  return seen;
}

/**
 * For each route step, the anchor where you board it and the square of it you
 * step onto (null for the start). Used for wayfinding, fences and the
 * no-headset step.
 */
export interface Boarding {
  anchor: V3;
  from: Sq;
  to: Sq;
}
export const BOARDINGS: (Boarding | null)[] = ROUTE.map((step, i) => {
  if (i === 0) return null;
  const prev = PLATFORMS[INDEX[ROUTE[i - 1][0]]];
  const next = PLATFORMS[INDEX[step[0]]];
  for (const a of berthsOf(prev)) {
    if (!berthsOf(next).some((b) => same(a, b))) continue;
    for (const from of prev.claim) {
      for (const to of next.claim) {
        if (Math.abs(from[0] - to[0]) + Math.abs(from[1] - to[1]) === 1) return { anchor: a, from, to };
      }
    }
  }
  return null;
});

/**
 * The score must tile: every route step shares a berth with the next and
 * offers a one-square step onto it, no two platforms park decks on the same
 * spot, and nothing shares space while moving. A score that breaks this is a
 * bug, so it throws on the way in rather than halfway up the cave.
 */
export function validateScore(): void {
  for (let i = 1; i < ROUTE.length; i++) {
    if (!BOARDINGS[i]) throw new Error(`cave: no step from ${ROUTE[i - 1][0]} onto ${ROUTE[i][0]}`);
  }
  const tilesOf = (spec: PlatformSpec): V3[] => {
    const out: V3[] = [];
    for (const a of berthsOf(spec)) {
      for (const sq of spec.claim) {
        const o = sqOffset(sq);
        out.push(v3(a.x + o.x, a.y, a.z + o.z));
      }
    }
    return out;
  };
  const eps = 1e-6;
  for (let i = 0; i < PLATFORMS.length; i++) {
    for (let j = i + 1; j < PLATFORMS.length; j++) {
      // The wheel's gondolas share berths by taking turns; the sweep checks them.
      if (PLATFORMS[i].kind === 'gondola' && PLATFORMS[j].kind === 'gondola') continue;
      for (const ta of tilesOf(PLATFORMS[i])) {
        for (const tb of tilesOf(PLATFORMS[j])) {
          if (Math.abs(ta.x - tb.x) < eps && Math.abs(ta.y - tb.y) < eps && Math.abs(ta.z - tb.z) < eps) {
            throw new Error(`cave: ${PLATFORMS[i].id} and ${PLATFORMS[j].id} park on the same spot`);
          }
        }
      }
    }
  }
  sweepScore();
}

/** Box every deck tile against every other over the whole cycle. */
export function sweepScore(): void {
  const gcd = (x: number, y: number): number => (y ? gcd(y, x % y) : x);
  let span = 1;
  for (const p of PLATFORMS) if (p.loopBars) span = (span * p.loopBars) / gcd(span, p.loopBars);
  const reach = GRID.tile - 2e-4; // a shared seam is not an overlap
  const slab = 0.35; // deck + framing underneath
  const a = v3(0, 0, 0);
  const b = v3(0, 0, 0);
  for (let bar = 0; bar < span; bar += 1 / 16) {
    for (let i = 0; i < PLATFORMS.length; i++) {
      anchorAt(PLATFORMS[i], bar, a);
      for (let j = i + 1; j < PLATFORMS.length; j++) {
        anchorAt(PLATFORMS[j], bar, b);
        if (Math.abs(a.y - b.y) >= slab) continue;
        for (const sa of PLATFORMS[i].claim) {
          const oa = sqOffset(sa);
          for (const sb of PLATFORMS[j].claim) {
            const ob = sqOffset(sb);
            if (
              Math.abs(a.x + oa.x - b.x - ob.x) < reach &&
              Math.abs(a.z + oa.z - b.z - ob.z) < reach
            ) {
              throw new Error(
                `cave: ${PLATFORMS[i].id} and ${PLATFORMS[j].id} collide at bar ${bar.toFixed(2)}`,
              );
            }
          }
        }
      }
    }
  }
}
