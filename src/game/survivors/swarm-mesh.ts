/**
 * Snow Survivors' horde, drawn: every enemy on the field in three draw
 * calls, and the shards they burst into.
 *
 * Ported from Factory Fight's swarm (yellkell/factoryfight,
 * src/systems/swarm.ts): the same faceted bodies (the mite, the beetle and
 * the hulk) built out of flat triangles with a glow per corner, drawn
 * instanced, one draw call per kind, and animated entirely on the GPU from
 * a few numbers per enemy (where it stands, which way it faces, how far it
 * has walked, a hit flash, how far out of the snow it has climbed, whether
 * it is biting). The CPU's whole job per frame is one pass copying columns.
 *
 * Changes for the snowfield: the bodies are scaled up to person-sized
 * monsters, the neon is frost-vampire colours, and the shader fades them
 * into the scene's fog so they loom out of the mist.
 */

import {
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Float32BufferAttribute,
  type Fog,
  type Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
  Vector3,
  Vector4,
} from '@iwsdk/core';
import { CAP, type Horde, KINDS } from './horde.js';

/** The hostile body: near-black, so the neon carries the shape. */
const BODY = 0x0b0a10;

/* ── the builder ────────────────────────────────────────────────────────── */

type V3 = [number, number, number];
/** A corner and how hot it is: x, y, z, glow (0 shell → 1 neon → 2+ hot
 *  white). Glow is per CORNER, so a facet can burn at one edge and be
 *  black at the other — that is how a plate gets a neon rim for free. */
type P = [number, number, number, number];

/** What a triangle hangs off; the vertex shader moves each its own way. */
const PART_BODY = 0;
const PART_LEG = 1;
const PART_HEAD = 2;
const PART_JAW = 3;
const PART_ARM = 4;
const PART_CORE = 5;

/**
 * A body, triangle by triangle. Local frame: unit RADIUS (the crawler's
 * spec radius scales it), +Z forward, standing on y = 0. No normals: the
 * fragment shader takes each facet's own from its screen derivatives, so
 * it stays a crisp flat facet however the legs and jaws bend it.
 */
class Body {
  private readonly pos: number[] = [];
  private readonly glow: number[] = [];
  private readonly rig: number[] = [];
  private readonly pivot: number[] = [];
  private part = PART_BODY;
  private beat = 0;
  private at: V3 = [0, 0, 0];

  /** Hang what follows off a part, turning about `at`, in gait half `beat`. */
  on(part: number, at: V3 = [0, 0, 0], beat = 0): this {
    this.part = part;
    this.at = at;
    this.beat = beat;
    return this;
  }

  tri(a: P, b: P, c: P): void {
    for (const v of [a, b, c]) {
      this.pos.push(v[0], v[1], v[2]);
      this.glow.push(v[3]);
      this.rig.push(this.part, this.beat);
      this.pivot.push(...this.at);
    }
  }

  quad(a: P, b: P, c: P, d: P): void {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  /** Rings joined band to band (each a closed loop), capped by apexes. */
  loft(rings: P[][], front?: P, back?: P): void {
    for (let r = 0; r + 1 < rings.length; r++) {
      const A = rings[r];
      const B = rings[r + 1];
      for (let s = 0; s < A.length; s++) this.quad(A[s], A[(s + 1) % A.length], B[(s + 1) % B.length], B[s]);
    }
    if (front) this.fan(front, rings[0]);
    if (back) this.fan(back, rings[rings.length - 1]);
  }

  fan(apex: P, ring: P[]): void {
    for (let s = 0; s < ring.length; s++) this.tri(apex, ring[s], ring[(s + 1) % ring.length]);
  }

  /**
   * A bipyramid round c: k corners on a flat ring (radii rx across, rz
   * along; corner 0 dead ahead), apexes up and down. Returns its corners
   * so a caller can set eyes into its faces.
   */
  gem(c: V3, rx: number, rz: number, up: number, down: number, k: number, ringGlow: (s: number) => number, gTop: number, gBot = 0): { ring: P[]; top: P } {
    const ring: P[] = [];
    for (let s = 0; s < k; s++) {
      const t = (s / k) * Math.PI * 2;
      ring.push([c[0] + Math.sin(t) * rx, c[1], c[2] + Math.cos(t) * rz, ringGlow(s)]);
    }
    const top: P = [c[0], c[1] + up, c[2], gTop];
    this.fan(top, ring);
    this.fan([c[0], c[1] - down, c[2], gBot], ring);
    return { ring, top };
  }

  /**
   * A limb from p to q: a `sides`-sided tube, w0 across at p and w1 at q
   * (w1 = 0 tapers it to a point), glow g0 → g1 along it — on its top
   * ridge; the other corners get `side` of that, so side 0 is a dark,
   * armoured limb with one neon line down its back. Open-ended: its ends
   * are always buried in the next piece.
   */
  limb(p: V3, q: V3, w0: number, w1: number, g0: number, g1: number, sides = 3, side = 1): void {
    const d = new Vector3(q[0] - p[0], q[1] - p[1], q[2] - p[2]).normalize();
    const v = new Vector3(0, 1, 0).addScaledVector(d, -d.y);
    if (v.lengthSq() < 1e-6) v.set(0, 0, 1);
    v.normalize();
    const u = new Vector3().crossVectors(d, v);
    const at = (o: V3, w: number, g: number, s: number): P => {
      // Corner 0 straight up, so the top edge (what a standing player
      // sees) is always a ridge, never a flat.
      if (s % sides !== 0) g *= side;
      const t = (s / sides) * Math.PI * 2;
      const cu = Math.sin(t) * w;
      const cv = Math.cos(t) * w;
      return [o[0] + u.x * cu + v.x * cv, o[1] + u.y * cu + v.y * cv, o[2] + u.z * cu + v.z * cv, g];
    };
    for (let s = 0; s < sides; s++) {
      const a = at(p, w0, g0, s);
      const b = at(p, w0, g0, s + 1);
      if (w1 <= 0) this.tri(a, b, [q[0], q[1], q[2], g1]);
      else this.quad(a, b, at(q, w1, g1, s + 1), at(q, w1, g1, s));
    }
  }

  /**
   * A blade: two triangles folded along a crease that rides on top, from
   * a base w across at p to a point at q. Seen from above, from the side
   * or from below it is never edge-on — the cheapest leg that always
   * reads, and a mite has twelve of them.
   */
  blade(p: V3, q: V3, w: number, g0: number, g1: number): void {
    const d = new Vector3(q[0] - p[0], q[1] - p[1], q[2] - p[2]).normalize();
    const v = new Vector3(0, 1, 0).addScaledVector(d, -d.y);
    if (v.lengthSq() < 1e-6) v.set(0, 0, 1);
    v.normalize();
    const u = new Vector3().crossVectors(d, v).multiplyScalar(w);
    v.multiplyScalar(w * 0.7);
    const l: P = [p[0] - u.x, p[1] - u.y, p[2] - u.z, g0];
    const r: P = [p[0] + u.x, p[1] + u.y, p[2] + u.z, g0];
    const c: P = [p[0] + v.x, p[1] + v.y, p[2] + v.z, g0];
    const tip: P = [q[0], q[1], q[2], g1];
    this.tri(l, c, tip);
    this.tri(c, r, tip);
  }

  /** A face's middle, shrunk to `k` of it and lifted off it (away from
   *  `inside`): an eye set into a head, a vent into a flank. */
  inset(a: P, b: P, c: P, inside: V3, k: number, lift: number, g: number): void {
    const o = (1 - k) / 3;
    this.decal(a, b, c, inside, [[o + k, o, o], [o, o + k, o], [o, o, o + k]], lift, g);
  }

  /** A triangle laid on face abc (each corner a blend of a, b and c),
   *  lifted off it, away from `inside`. */
  decal(a: P, b: P, c: P, inside: V3, w: [V3, V3, V3], lift: number, g: number): void {
    const A = new Vector3(a[0], a[1], a[2]);
    const B = new Vector3(b[0], b[1], b[2]);
    const C = new Vector3(c[0], c[1], c[2]);
    const n = B.clone().sub(A).cross(C.clone().sub(A)).normalize();
    const m = A.clone().add(B).add(C).divideScalar(3);
    if (n.dot(m.sub(new Vector3(...inside))) < 0) n.negate();
    const pt = (k: V3): P => {
      const o = A.clone().multiplyScalar(k[0]).addScaledVector(B, k[1]).addScaledVector(C, k[2]).addScaledVector(n, lift);
      return [o.x, o.y, o.z, g];
    };
    this.tri(pt(w[0]), pt(w[1]), pt(w[2]));
  }

  /**
   * Indexed: a corner shared by several facets (same place, glow and
   * part) is ONE vertex. With no normals to keep apart, the flat facets
   * cost nothing to share, and the GPU runs the vertex shader for each
   * corner once instead of once per triangle — roughly a third of the
   * work, times eight thousand mites.
   */
  geometry(): InstancedBufferGeometry {
    const seen = new Map<string, number>();
    const index: number[] = [];
    const pos: number[] = [];
    const glow: number[] = [];
    const rig: number[] = [];
    const pivot: number[] = [];
    for (let v = 0; v < this.glow.length; v++) {
      const p = this.pos.slice(v * 3, v * 3 + 3);
      const r = this.rig.slice(v * 2, v * 2 + 2);
      const o = this.pivot.slice(v * 3, v * 3 + 3);
      const key = [...p, this.glow[v], ...r, ...o].map((x) => x.toFixed(5)).join();
      let i = seen.get(key);
      if (i === undefined) {
        i = glow.length;
        seen.set(key, i);
        pos.push(...p);
        glow.push(this.glow[v]);
        rig.push(...r);
        pivot.push(...o);
      }
      index.push(i);
    }
    const g = new InstancedBufferGeometry();
    g.setIndex(index);
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setAttribute('aGlow', new Float32BufferAttribute(glow, 1));
    g.setAttribute('aRig', new Float32BufferAttribute(rig, 2));
    g.setAttribute('aPivot', new Float32BufferAttribute(pivot, 3));
    return g;
  }
}

/** A cross-section round the Z axis at depth z: k corners, corner 0 on
 *  top, glow by corner. */
function ring(z: number, y: number, rx: number, up: number, down: number, k: number, glow: (s: number) => number): P[] {
  const out: P[] = [];
  for (let s = 0; s < k; s++) {
    const t = (s / k) * Math.PI * 2;
    const c = Math.cos(t);
    out.push([Math.sin(t) * rx, y + c * (c >= 0 ? up : down), z, glow(s)]);
  }
  return out;
}

/* ── the mite ───────────────────────────────────────────────────────────── */

/** Where a mite's head turns: the neck. */
const MITE_NECK: V3 = [0, 0.58, 0.44];

/**
 * THE MITE. Three segments, each a diamond in section so its spine is a
 * RIDGE — and the ridge corners burn, so from above a mite is a dashed
 * neon line with legs: thorax, pinch, abdomen, pinch, stinger. A dart of
 * a head, two slanted eyes, mandibles that snap, feelers out in front,
 * and six long legs whose knees ride high above its back and glow hot.
 */
function miteBody(): Body {
  const b = new Body();
  const spine = (s: number): number => (s === 0 ? 1 : 0);
  // The abdomen: waist, swell, taper, a hot stinger at the tail.
  b.loft(
    [ring(-0.5, 0.6, 0.46, 0.3, 0.22, 4, spine), ring(-0.95, 0.55, 0.34, 0.24, 0.16, 4, spine)],
    [0, 0.52, -0.14, 1],
    [0, 0.45, -1.38, 1.3],
  );
  // The thorax, where the legs root.
  b.loft([ring(0.2, 0.6, 0.3, 0.28, 0.2, 4, spine)], [0, 0.6, -0.08, 1], [0, 0.6, 0.46, 1]);
  // The head: a dart, two eyes slanted into its upper faces.
  b.on(PART_HEAD, MITE_NECK);
  const crown: P[] = ring(0.62, 0.58, 0.3, 0.2, 0.18, 4, (s) => (s === 0 ? 0.6 : 0));
  const snout: P = [0, 0.5, 1.0, 0.45];
  b.loft([crown], [0, 0.58, 0.42, 0.2], snout);
  for (const s of [1, 3]) b.inset(crown[0], crown[s], snout, [0, 0.56, 0.66], 0.5, 0.02, 2.6);
  // Feelers, out ahead and up.
  for (const sx of [-1, 1]) b.blade([sx * 0.08, 0.72, 0.7], [sx * 0.62, 1.15, 1.4], 0.05, 1, 1.4);
  // Mandibles: hooked in toward each other in front of the snout.
  for (const sx of [-1, 1]) {
    const base: V3 = [sx * 0.14, 0.46, 0.86];
    b.on(PART_JAW, base);
    b.blade(base, [sx * 0.05, 0.42, 1.3], 0.07, 0.7, 1.6);
  }
  // Six legs: hip on the thorax, knee high above the back, foot far out.
  // Tripod groups: L1 R2 L3 | R1 L2 R3. Thigh and shin are both blades
  // spreading FROM the knee — back to the hip, down to a point on the
  // floor — so the knee is the leg's widest, hottest point: a joint you
  // can see from across the room.
  const legs: Array<[number, V3, V3]> = [
    [0.32, [0.75, 1.0, 0.75], [1.15, 0, 1.38]],
    [0.2, [0.98, 1.1, 0.28], [1.68, 0, 0.42]],
    [0.08, [0.8, 1.02, -0.32], [1.36, 0, -1.06]],
  ];
  legs.forEach(([z, knee, foot], k) => {
    for (const sx of [-1, 1]) {
      const hip: V3 = [sx * 0.26, 0.58, z];
      b.on(PART_LEG, hip, (k % 2 === 0) === sx < 0 ? 0 : 1);
      const kn: V3 = [sx * knee[0], knee[1], knee[2]];
      b.blade(kn, hip, 0.075, 1.45, 0.9);
      b.blade(kn, [sx * foot[0], foot[1], foot[2]], 0.07, 1.45, 1.0);
    }
  });
  return b;
}

/* ── the beetle ─────────────────────────────────────────────────────────── */

const BEETLE_NECK: V3 = [0, 0.5, 0.72];

/**
 * THE BEETLE. A domed wing-case, split: in section it rises from a neon
 * RIM over a dark shoulder to a crest each side, and dips to a neon SEAM
 * down the middle — so from above it is a black shell drawn in three
 * neon lines, closing to a hot point at the tail. A shield in front of
 * it with a burning lip, a broad low head, a horn, a pair of pincers,
 * and six short, thick legs. It looks like it would take a slug or five.
 */
function beetleBody(): Body {
  const b = new Body();
  const shell = (z: number, y0: number, w: number, h: number, belly: number): P[] => [
    [-w, y0, z, 1],
    [-0.78 * w, y0 + 0.6 * h, z, 0],
    [-0.32 * w, y0 + h, z, 0.12],
    [0, y0 + 0.9 * h, z, 1],
    [0.32 * w, y0 + h, z, 0.12],
    [0.78 * w, y0 + 0.6 * h, z, 0],
    [w, y0, z, 1],
    [0, y0 - belly, z, 0],
  ];
  // Open in front: the shield covers it.
  b.loft(
    [
      shell(0.3, 0.38, 0.7, 0.42, 0.2),
      shell(-0.1, 0.36, 0.86, 0.6, 0.22),
      shell(-0.58, 0.36, 0.78, 0.52, 0.2),
      shell(-0.95, 0.38, 0.44, 0.3, 0.14),
    ],
    undefined,
    [0, 0.5, -1.16, 1.1],
  );
  // The shield (pronotum): wide and low, its front lip burning.
  b.gem([0, 0.6, 0.48], 0.66, 0.36, 0.32, 0.22, 6, (s) => (s === 0 || s === 1 || s === 5 ? 1 : 0), 0.15);
  // The head, broad and low, eyes on its shoulders.
  b.on(PART_HEAD, BEETLE_NECK);
  const head = b.gem([0, 0.48, 0.9], 0.4, 0.24, 0.17, 0.14, 5, (s) => (s === 0 ? 0.55 : 0), 0);
  for (const s of [0, 4]) b.inset(head.top, head.ring[s], head.ring[(s + 1) % 5], [0, 0.48, 0.9], 0.6, 0.015, 2.4);
  // The horn, curving up off the brow.
  b.limb([0, 0.58, 0.92], [0, 1.05, 1.2], 0.09, 0, 0.3, 1.7);
  // Pincers: out, then hooked back in, hot at the tips.
  for (const sx of [-1, 1]) {
    const base: V3 = [sx * 0.22, 0.42, 1.0];
    const elbow: V3 = [sx * 0.42, 0.42, 1.3];
    b.on(PART_JAW, base);
    b.blade(base, elbow, 0.085, 0.6, 1.1);
    b.blade(elbow, [sx * 0.12, 0.4, 1.56], 0.07, 1.0, 1.7);
  }
  // Six legs: short, thick, armoured thighs (three-sided tubes, neon only
  // down the top ridge), a hot knee, and a neon spike of a shin.
  const legs: Array<[number, V3, V3]> = [
    [0.3, [0.92, 0.62, 0.62], [1.18, 0, 0.98]],
    [-0.05, [1.06, 0.66, -0.02], [1.38, 0, 0.06]],
    [-0.4, [0.96, 0.62, -0.62], [1.22, 0, -1.02]],
  ];
  legs.forEach(([z, knee, foot], k) => {
    for (const sx of [-1, 1]) {
      const hip: V3 = [sx * 0.5, 0.36, z];
      b.on(PART_LEG, hip, (k % 2 === 0) === sx < 0 ? 0 : 1);
      const kn: V3 = [sx * knee[0], knee[1], knee[2]];
      b.limb(hip, kn, 0.13, 0.09, 0.55, 1.5, 3, 0.3);
      b.limb(kn, [sx * foot[0], foot[1], foot[2]], 0.1, 0, 1.25, 1.0);
    }
  });
  return b;
}

/* ── the hulk ───────────────────────────────────────────────────────────── */

const HULK_NECK: V3 = [0, 0.92, 0.62];

/**
 * THE HULK. A dark hull, and over it three back plates laid like roof
 * tiles the wrong way round — each one's front edge reared up into a
 * burning LIP, and between them, cracks where the CORE shows through,
 * white-hot and throbbing. Spikes off the plates. A low head sunk under
 * the mantle, scowling out of two hot slits over its tusks; shoulders; two
 * forelimbs it knuckle-walks on, ending in two-pronged claws; four legs
 * that thicken toward the floor like a thing that weighs what it is.
 */
function hulkBody(): Body {
  const b = new Body();
  // The hull, under everything.
  const dark = (): number => 0;
  const hull = [ring(0.55, 0.85, 0.5, 0.35, 0.3, 6, dark), ring(0, 0.85, 0.62, 0.4, 0.38, 6, dark), ring(-0.6, 0.8, 0.5, 0.35, 0.32, 6, dark)];
  b.loft(hull, [0, 0.8, 0.82, 0], [0, 0.75, -0.95, 0]);
  // Vents down each flank, burning with the core.
  b.on(PART_CORE);
  for (const s of [1, 2, 4, 5]) {
    const n = (s + 1) % 6;
    b.inset(hull[1][s], hull[1][n], hull[2][n], [0, 0.8, -0.3], 0.55, 0.02, 1.9);
    b.inset(hull[1][s], hull[2][n], hull[2][s], [0, 0.8, -0.3], 0.55, 0.02, 1.9);
  }
  // The core: proud of the hull, so it shows in every crack.
  b.gem([0, 1.08, -0.08], 0.42, 0.58, 0.4, 0.25, 6, () => 1.8, 2.6);
  b.on(PART_BODY);
  // Three plates. Top surface (rim, shoulder, crest, shoulder, rim) front
  // to back — neon down the rims and the crest, black between — and a lip
  // face hanging off the front edge, solid neon.
  const plate = (zF: number, zB: number, yF: number, yB: number, w: number, h: number): void => {
    const top = (z: number, y: number): P[] => [
      [-w, y - 0.1, z, 1],
      [-0.6 * w, y + 0.6 * h, z, 0],
      [0, y + h, z, 1],
      [0.6 * w, y + 0.6 * h, z, 0],
      [w, y - 0.1, z, 1],
    ];
    const F = top(zF, yF);
    const B = top(zB, yB);
    for (let s = 0; s < 4; s++) b.quad(F[s], F[s + 1], B[s + 1], B[s]);
    const L = F.map((p): P => [p[0], p[1] - 0.13, p[2] - 0.03, 1.15]);
    const Fl = F.map((p): P => [p[0], p[1], p[2], 1.15]);
    for (let s = 0; s < 4; s++) b.quad(Fl[s], Fl[s + 1], L[s + 1], L[s]);
  };
  plate(0.66, 0.2, 1.32, 1.42, 0.84, 0.26);
  plate(0.02, -0.36, 1.46, 1.36, 0.74, 0.26);
  plate(-0.54, -0.92, 1.34, 1.06, 0.6, 0.2);
  // Spikes off the plates, neon at the tips.
  const spikes: Array<[V3, V3, number]> = [
    [[-0.46, 1.5, 0.36], [-0.78, 1.98, 0.1], 0.11],
    [[0.46, 1.5, 0.36], [0.78, 1.98, 0.1], 0.11],
    [[0, 1.66, -0.12], [0, 2.1, -0.46], 0.13],
    [[0, 1.48, -0.64], [0, 1.82, -0.98], 0.1],
    [[0, 1.54, 0.42], [0, 1.86, 0.2], 0.09],
  ];
  for (const [p, q, w] of spikes) b.limb(p, q, w, 0, 0.05, 1.5, 4);
  // Shoulders: armoured knobs, burning along the outer edge.
  for (const sx of [-1, 1]) {
    const outer = (s: number): number => (Math.sin((s / 5) * Math.PI * 2) * sx > 0.3 ? 0.9 : 0);
    b.gem([sx * 0.72, 1.2, 0.42], 0.32, 0.36, 0.3, 0.2, 5, outer, 0.05);
  }
  // The head, low under the mantle, and tusks.
  b.on(PART_HEAD, HULK_NECK);
  const head = b.gem([0, 0.8, 0.84], 0.36, 0.3, 0.25, 0.2, 6, (s) => (s === 0 ? 0.4 : 0), 0);
  // Eyes: a slanted slit each side of the brow, low at the middle and
  // rising outward — a scowl, not a face.
  const [top, r0, r1, r5] = [head.top, head.ring[0], head.ring[1], head.ring[5]];
  b.decal(top, r0, r1, [0, 0.8, 0.84], [[0.3, 0.65, 0.05], [0.47, 0.08, 0.45], [0.18, 0.42, 0.4]], 0.015, 2.6);
  b.decal(top, r5, r0, [0, 0.8, 0.84], [[0.3, 0.05, 0.65], [0.47, 0.45, 0.08], [0.18, 0.4, 0.42]], 0.015, 2.6);
  for (const sx of [-1, 1]) {
    const base: V3 = [sx * 0.18, 0.66, 1.0];
    b.on(PART_JAW, base);
    b.limb(base, [sx * 0.08, 0.36, 1.4], 0.07, 0, 0.4, 1.6, 4);
  }
  // Forelimbs: shoulder → elbow (out, with a spur) → wrist → two claws on
  // the floor. Knuckle-walked, and slammed down when it bites.
  for (const sx of [-1, 1]) {
    const sh: V3 = [sx * 0.72, 1.05, 0.42];
    const el: V3 = [sx * 1.18, 0.86, 0.74];
    const wr: V3 = [sx * 1.06, 0.3, 1.28];
    b.on(PART_ARM, sh, sx < 0 ? 1 : 0);
    b.limb(sh, el, 0.2, 0.16, 0.5, 1.4, 4, 0);
    b.limb(el, wr, 0.19, 0.14, 1.4, 1.0, 4, 0.1);
    b.limb(el, [sx * 1.42, 1.12, 0.46], 0.08, 0, 0.3, 1.4);
    b.limb([sx * 1.16, 0.3, 1.3], [sx * 1.24, 0.02, 1.72], 0.1, 0, 0.9, 1.7, 4, 0.6);
    b.limb([sx * 0.96, 0.3, 1.3], [sx * 0.8, 0.04, 1.66], 0.1, 0, 0.9, 1.7, 4, 0.6);
  }
  // Four legs: thighs up to a spurred knee, shins that THICKEN to a hoof.
  const legs: Array<[V3, V3, V3, number]> = [
    [[0.5, 0.75, -0.1], [1.16, 1.14, -0.05], [1.3, 0, 0.12], 0],
    [[0.45, 0.75, -0.55], [1.06, 1.1, -0.76], [1.26, 0, -1.06], 1],
  ];
  for (const [hip, knee, foot, beat] of legs) {
    for (const sx of [-1, 1]) {
      const h: V3 = [sx * hip[0], hip[1], hip[2]];
      const kn: V3 = [sx * knee[0], knee[1], knee[2]];
      // Tripods again: L-arm R-mid L-rear | R-arm L-mid R-rear.
      b.on(PART_LEG, h, sx < 0 ? beat : 1 - beat);
      b.limb(h, kn, 0.17, 0.13, 0.6, 1.4, 4, 0);
      b.limb(kn, [sx * foot[0], foot[1], foot[2]], 0.11, 0.17, 1.4, 1.0, 4, 0.1);
      b.limb(kn, [kn[0] + sx * 0.14, kn[1] + 0.3, kn[2] - 0.12], 0.07, 0, 0.2, 1.4);
    }
  }
  return b;
}

/* ── the shader ─────────────────────────────────────────────────────────── */

const SWARM_VERT = /* glsl */ `
attribute float aGlow;
attribute vec2 aRig;    // part, beat (which half of the gait)
attribute vec3 aPivot;  // where the part turns
attribute vec4 iPose;   // x, z, heading, radius
attribute vec4 iAnim;   // stride, flash, burn, rise
attribute vec3 iAct;    // height off the floor, flailing (0..1), biting (0..1)
uniform float uTime;
uniform vec4 uGait;     // cadence, leg swing, foot lift, body bob
uniform vec4 uMove;     // roll, jaw snap, arm swing, thrash rate
uniform vec3 uNeck;     // where the head nods
varying float vGlow;
varying vec3 vW;
varying float vFlash;
varying float vBurn;

vec3 turnY(vec3 p, vec3 o, float a) {
  vec2 r = p.xz - o.xz;
  float c = cos(a);
  float s = sin(a);
  return vec3(o.x + r.x * c - r.y * s, p.y, o.z + r.x * s + r.y * c);
}
vec3 turnX(vec3 p, vec3 o, float a) {
  vec2 r = p.yz - o.yz;
  float c = cos(a);
  float s = sin(a);
  return vec3(p.x, o.y + r.x * c - r.y * s, o.z + r.x * s + r.y * c);
}

void main() {
  vec3 p = position;
  float part = aRig.x;
  float beat = aRig.y * 3.14159;
  float seed = fract(sin(iPose.x * 12.9898 + iPose.y * 78.233) * 43758.5453) * 6.2832;
  float fl = iAct.y;
  float bite = iAct.z;
  // The gait runs on distance walked (so a stopped crawler stands still),
  // a kind's cadence per body-radius: a mite skitters, a hulk plods.
  float ph = iAnim.x * uGait.x / max(iPose.w, 0.01);
  // In your fist or in the air, everything thrashes.
  ph = mix(ph, uTime * uMove.w + seed, fl);
  // Chewing a tower: the feet scrabble where they stand.
  ph += bite * sin(uTime * 13.0 + seed) * 0.5;
  float lp = ph + beat;
  float glow = aGlow;
  if (part == 1.0 || part == 4.0) {
    // A leg (or a hulk's arm) swings about its hip and lifts on the way
    // forward, the farther from the hip the higher.
    float reach = clamp(length(p.xz - aPivot.xz) / 1.2, 0.0, 1.0);
    float sw = sin(lp) * (part == 4.0 ? uMove.z : uGait.y);
    p = turnY(p, aPivot, sw);
    p.y += pow(max(0.0, cos(lp)), 0.7) * uGait.z * reach;
    if (part == 4.0) {
      // Biting, a hulk raises both fists and brings them down.
      float slam = pow(0.5 + 0.5 * sin(uTime * 5.0 + seed + beat * 0.4), 3.0);
      p = turnX(p, aPivot, -bite * slam * 1.1 - fl * 0.5 * (0.5 + 0.5 * sin(uTime * 9.0 + beat)));
    }
  } else {
    if (part == 3.0) {
      // Jaws: idly working as it walks; snapping when it bites.
      float open = mix(0.3 + 0.3 * sin(ph * 0.5 + seed + uTime * 3.0), 0.5 + 0.5 * sin(uTime * 24.0 + seed), max(bite, fl));
      p = turnY(p, aPivot, open * uMove.y * (aPivot.x < 0.0 ? 1.0 : -1.0));
    }
    if (part == 2.0 || part == 3.0) {
      // Heads nod into a bite.
      float nod = bite * (sin(uTime * 26.0 + seed) * 0.14 - 0.12) + sin(ph * 0.5) * 0.04;
      p = turnX(p, uNeck, nod);
    }
    if (part == 5.0) {
      // The core breathes, and races when it is in a fight.
      glow *= 0.75 + 0.25 * sin(uTime * mix(3.0, 9.0, max(bite, fl)) + seed);
    }
    // The body rides the legs: up and down with each step, and a roll
    // from side to side on the heavy ones.
    p.y += abs(sin(ph)) * uGait.w + p.x * sin(ph) * uMove.x;
  }
  // Climbing out of the floor: it grows to full size as it comes.
  float s = iPose.w * mix(0.45, 1.0, iAnim.w);
  float h = iPose.z;
  float ch = cos(h);
  float sh = sin(h);
  vec3 w = vec3(p.x * ch + p.z * sh, p.y, -p.x * sh + p.z * ch) * s;
  w.x += iPose.x;
  w.y += iAct.x;
  w.z += iPose.y;
  vec4 wp = modelMatrix * vec4(w, 1.0);
  vW = wp.xyz;
  vGlow = glow;
  vFlash = iAnim.y;
  vBurn = iAnim.z;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SWARM_FRAG = /* glsl */ `
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform vec3 uNeon;
uniform vec3 uBody;
uniform float uTime;
varying float vGlow;
varying vec3 vW;
varying float vFlash;
varying float vBurn;

void main() {
  // Each facet's own normal, from how the surface moves across the
  // screen: flat-shaded whatever the legs did to it.
  vec3 n = normalize(cross(dFdx(vW), dFdy(vW)));
  vec3 v = normalize(cameraPosition - vW);
  if (dot(n, v) < 0.0) n = -n;
  float facing = clamp(dot(n, v), 0.0, 1.0);
  // The shell: near-black, but every facet catches the light from above
  // a little differently (crystal, not a blob), a glint on the ones
  // square to it, and the kind's neon creeping round the silhouette.
  float key = clamp(dot(n, normalize(vec3(0.3, 1.0, 0.35))), 0.0, 1.0);
  vec3 shell = uBody * (0.35 + 2.4 * key) + uNeon * (pow(1.0 - facing, 4.0) * 0.08 + pow(key, 24.0) * 0.012);
  // Neon: a corner's glow fades across its facets, and the curve turns
  // that fade into a hard-ish neon edge with a faint tint behind it.
  float g = clamp(vGlow, 0.0, 1.0);
  float lit = smoothstep(0.86, 1.0, g) + g * 0.015;
  vec3 col = mix(shell, uNeon * (0.75 + 0.35 * facing), lit);
  // Past 1, neon goes white-hot (eyes, knees, tips, the core).
  col = mix(col, vec3(1.0, 0.97, 0.92), clamp((vGlow - 1.0) * 0.6, 0.0, 0.9));
  // On fire: it flickers toward flame.
  float flick = 0.6 + 0.4 * sin(uTime * 37.0 + vW.x * 60.0 + vW.z * 40.0);
  col = mix(col, vec3(1.0, 0.5, 0.12), vBurn * 0.55 * flick);
  col = mix(col, vec3(1.0), vFlash);
  // Out of the mist: the scene's fog, by distance.
  col = mix(col, uFogColor, smoothstep(uFogNear, uFogFar, length(vW - cameraPosition)));
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

/**
 * How each kind walks: cadence (gait radians per body-radius walked), leg
 * swing, foot lift, body bob; then roll, jaw snap, arm swing, thrash rate.
 */
const GAITS: Array<{ body: () => Body; neck: V3; gait: Vector4; move: Vector4 }> = [
  { body: miteBody, neck: MITE_NECK, gait: new Vector4(2.6, 0.46, 0.38, 0.06), move: new Vector4(0, 0.45, 0, 30) },
  { body: beetleBody, neck: BEETLE_NECK, gait: new Vector4(3.0, 0.3, 0.24, 0.04), move: new Vector4(0.03, 0.35, 0, 22) },
  { body: hulkBody, neck: HULK_NECK, gait: new Vector4(3.8, 0.24, 0.42, 0.07), move: new Vector4(0.07, 0.3, 0.3, 12) },
];

/** One kind's mesh: its own body, its own instance columns. */
class Brood {
  readonly mesh: Mesh;
  readonly geo: InstancedBufferGeometry;
  readonly pose = new InstancedBufferAttribute(new Float32Array(CAP * 4), 4).setUsage(DynamicDrawUsage);
  readonly anim = new InstancedBufferAttribute(new Float32Array(CAP * 4), 4).setUsage(DynamicDrawUsage);
  readonly act = new InstancedBufferAttribute(new Float32Array(CAP * 3), 3).setUsage(DynamicDrawUsage);

  constructor(parent: Group, kind: number, time: { value: number }, fog: FogUniforms) {
    const spec = GAITS[kind];
    this.geo = spec.body().geometry();
    this.geo.setAttribute('iPose', this.pose);
    this.geo.setAttribute('iAnim', this.anim);
    this.geo.setAttribute('iAct', this.act);
    this.geo.instanceCount = 0;
    const mat = new ShaderMaterial({
      vertexShader: SWARM_VERT,
      fragmentShader: SWARM_FRAG,
      side: DoubleSide,
      uniforms: {
        uNeon: { value: new Color(KINDS[kind].neon) },
        uBody: { value: new Color(BODY) },
        uGait: { value: spec.gait },
        uMove: { value: spec.move },
        uNeck: { value: new Vector3(...spec.neck) },
        uTime: time,
        uFogColor: fog.color,
        uFogNear: fog.near,
        uFogFar: fog.far,
      },
    });
    this.mesh = new Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.name = `swarm-${KINDS[kind].name}`;
    parent.add(this.mesh);
  }

  /** Hand this frame's first `n` crawlers to the GPU. */
  flush(n: number): void {
    this.geo.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n === 0) return;
    for (const at of [this.pose, this.anim, this.act]) {
      at.clearUpdateRanges();
      at.addUpdateRange(0, n * at.itemSize);
      at.needsUpdate = true;
    }
  }
}

/* ── the shards ─────────────────────────────────────────────────────────── */

const SHARD_CAP = 3000;

const SHARD_VERT = /* glsl */ `
attribute vec4 iPos;   // x, y, z, size
attribute vec4 iRot;   // axis, angle
attribute vec3 iCol;
varying vec3 vCol;
varying vec3 vN;
varying vec3 vV;
vec3 rot(vec3 v, vec3 k, float a) {
  float c = cos(a);
  float s = sin(a);
  return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
}
void main() {
  vec3 k = normalize(iRot.xyz + vec3(1e-4));
  vec3 p = rot(position, k, iRot.w) * iPos.w + iPos.xyz;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vN = normalize(normalMatrix * rot(normal, k, iRot.w));
  vV = -mv.xyz;
  vCol = iCol;
  gl_Position = projectionMatrix * mv;
}
`;

const SHARD_FRAG = /* glsl */ `
varying vec3 vCol;
varying vec3 vN;
varying vec3 vV;
void main() {
  float f = abs(dot(normalize(vN), normalize(vV)));
  vec3 col = vCol * (0.35 + 0.65 * f) + vCol * pow(1.0 - f, 2.0) * 0.8;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

/** A tetrahedron, flat-shaded, unit size. */
function shardGeometry(): BufferGeometry {
  const v = [
    [0, 1, 0],
    [0.94, -0.33, 0],
    [-0.47, -0.33, 0.82],
    [-0.47, -0.33, -0.82],
  ];
  const faces = [
    [0, 1, 2],
    [0, 2, 3],
    [0, 3, 1],
    [1, 3, 2],
  ];
  const pos: number[] = [];
  const nor: number[] = [];
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  for (const f of faces) {
    a.fromArray(v[f[0]]);
    b.fromArray(v[f[1]]);
    c.fromArray(v[f[2]]);
    const n = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
    for (const p of [a, b, c]) {
      pos.push(p.x, p.y, p.z);
      nor.push(n.x, n.y, n.z);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new Float32BufferAttribute(nor, 3));
  return g;
}

export class Shards {
  readonly mesh: Mesh;
  private readonly geo: InstancedBufferGeometry;
  private readonly iPos: InstancedBufferAttribute;
  private readonly iRot: InstancedBufferAttribute;
  private readonly iCol: InstancedBufferAttribute;
  private readonly p = new Float32Array(SHARD_CAP * 3);
  private readonly v = new Float32Array(SHARD_CAP * 3);
  private readonly axis = new Float32Array(SHARD_CAP * 3);
  private readonly ang = new Float32Array(SHARD_CAP);
  private readonly spin = new Float32Array(SHARD_CAP);
  private readonly life = new Float32Array(SHARD_CAP);
  private readonly maxLife = new Float32Array(SHARD_CAP);
  private readonly size = new Float32Array(SHARD_CAP);
  private readonly col = new Float32Array(SHARD_CAP * 3);
  private next = 0;
  private readonly tmp = new Color();
  /** Shards in the air or on the floor right now. */
  live = 0;

  constructor(parent: Group) {
    const base = shardGeometry();
    this.geo = new InstancedBufferGeometry();
    this.geo.setAttribute('position', base.getAttribute('position'));
    this.geo.setAttribute('normal', base.getAttribute('normal'));
    this.iPos = new InstancedBufferAttribute(new Float32Array(SHARD_CAP * 4), 4).setUsage(DynamicDrawUsage);
    this.iRot = new InstancedBufferAttribute(new Float32Array(SHARD_CAP * 4), 4).setUsage(DynamicDrawUsage);
    this.iCol = new InstancedBufferAttribute(new Float32Array(SHARD_CAP * 3), 3).setUsage(DynamicDrawUsage);
    this.geo.setAttribute('iPos', this.iPos);
    this.geo.setAttribute('iRot', this.iRot);
    this.geo.setAttribute('iCol', this.iCol);
    this.geo.instanceCount = 0;
    this.mesh = new Mesh(this.geo, new ShaderMaterial({ vertexShader: SHARD_VERT, fragmentShader: SHARD_FRAG, side: DoubleSide }));
    this.mesh.frustumCulled = false;
    this.mesh.name = 'shards';
    parent.add(this.mesh);
  }

  /** Burst `n` shards out of (x, y, z): `speed` outward, `up` upward. */
  burst(x: number, y: number, z: number, n: number, hex: number, size: number, speed: number, up: number): void {
    this.tmp.set(hex);
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % SHARD_CAP;
      const a = Math.random() * Math.PI * 2;
      const sp = speed * (0.4 + Math.random() * 0.8);
      this.p[i * 3] = x;
      this.p[i * 3 + 1] = y;
      this.p[i * 3 + 2] = z;
      this.v[i * 3] = Math.sin(a) * sp;
      this.v[i * 3 + 1] = up * (0.5 + Math.random());
      this.v[i * 3 + 2] = Math.cos(a) * sp;
      this.axis[i * 3] = Math.random() - 0.5;
      this.axis[i * 3 + 1] = Math.random() - 0.5;
      this.axis[i * 3 + 2] = Math.random() - 0.5;
      this.ang[i] = Math.random() * 6;
      this.spin[i] = (Math.random() - 0.5) * 30;
      this.life[i] = this.maxLife[i] = 0.5 + Math.random() * 0.5;
      this.size[i] = size * (0.5 + Math.random() * 0.8);
      // Most shards are its neon; some are its dark shell.
      const dark = Math.random() < 0.3;
      const f = dark ? 0.12 : 1;
      this.col[i * 3] = this.tmp.r * f;
      this.col[i * 3 + 1] = this.tmp.g * f;
      this.col[i * 3 + 2] = this.tmp.b * f;
    }
  }

  tick(dt: number): void {
    const P = this.iPos.array as Float32Array;
    const R = this.iRot.array as Float32Array;
    const C = this.iCol.array as Float32Array;
    let n = 0;
    for (let i = 0; i < SHARD_CAP; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) continue;
      const o = i * 3;
      this.v[o + 1] -= 6 * dt;
      this.p[o] += this.v[o] * dt;
      this.p[o + 1] += this.v[o + 1] * dt;
      this.p[o + 2] += this.v[o + 2] * dt;
      // The floor: bounce, lose most of it, skid, and settle.
      const s = this.size[i];
      if (this.p[o + 1] < s * 0.4) {
        this.p[o + 1] = s * 0.4;
        if (this.v[o + 1] < 0) this.v[o + 1] *= -0.35;
        this.v[o] *= 0.7;
        this.v[o + 2] *= 0.7;
        this.spin[i] *= 0.6;
      }
      this.ang[i] += this.spin[i] * dt;
      // Shrinks away over its last third.
      const fade = Math.min(1, this.life[i] / (this.maxLife[i] * 0.35));
      const q = n * 4;
      P[q] = this.p[o];
      P[q + 1] = this.p[o + 1];
      P[q + 2] = this.p[o + 2];
      P[q + 3] = s * fade;
      R[q] = this.axis[o];
      R[q + 1] = this.axis[o + 1];
      R[q + 2] = this.axis[o + 2];
      R[q + 3] = this.ang[i];
      C[n * 3] = this.col[o];
      C[n * 3 + 1] = this.col[o + 1];
      C[n * 3 + 2] = this.col[o + 2];
      n++;
    }
    this.live = n;
    this.geo.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n > 0) {
      for (const at of [this.iPos, this.iRot, this.iCol]) {
        at.clearUpdateRanges();
        at.addUpdateRange(0, n * at.itemSize);
        at.needsUpdate = true;
      }
    }
  }
}


/* ── the horde, every frame ─────────────────────────────────────────────── */

interface FogUniforms {
  color: { value: Color };
  near: { value: number };
  far: { value: number };
}

export class SwarmMesh {
  /** One per kind, in KINDS order. */
  private readonly broods: Brood[];
  private readonly time = { value: 0 };
  private readonly fog: FogUniforms = { color: { value: new Color() }, near: { value: 1e5 }, far: { value: 2e5 } };
  private readonly P: Float32Array[];
  private readonly A: Float32Array[];
  private readonly R: Float32Array[];
  private readonly count = new Int32Array(KINDS.length);

  constructor(parent: Group) {
    this.broods = KINDS.map((_, k) => new Brood(parent, k, this.time, this.fog));
    this.P = this.broods.map((b) => b.pose.array as Float32Array);
    this.A = this.broods.map((b) => b.anim.array as Float32Array);
    this.R = this.broods.map((b) => b.act.array as Float32Array);
  }

  /** Copy the horde into the instance buffers: one pass, each enemy into its kind's columns. */
  update(h: Horde, clock: number, fog: Fog | null): void {
    const { P, A, R, count } = this;
    count.fill(0);
    for (let i = 0; i < h.n; i++) {
      if (h.dead[i]) continue;
      const k = h.kind[i];
      const n = count[k]++;
      const o = n * 4;
      const pose = P[k];
      const anim = A[k];
      const act = R[k];
      pose[o] = h.x[i];
      pose[o + 1] = h.z[i];
      pose[o + 2] = h.heading[i];
      pose[o + 3] = KINDS[k].radius * h.scale[i];
      anim[o] = h.stride[i];
      anim[o + 1] = h.flash[i] > 0 ? Math.min(1, h.flash[i] / 0.1) : 0;
      anim[o + 2] = h.burn[i] > 0 ? 1 : 0;
      anim[o + 3] = h.rise[i];
      const q = n * 3;
      act[q] = (h.rise[i] - 1) * KINDS[k].radius * 1.4;
      act[q + 1] = h.kT[i] > 0 ? 1 : 0;
      act[q + 2] = h.bite[i];
    }
    for (let k = 0; k < this.broods.length; k++) this.broods[k].flush(count[k]);
    this.time.value = clock;
    if (fog) {
      this.fog.color.value.copy(fog.color);
      this.fog.near.value = fog.near;
      this.fog.far.value = fog.far;
    }
  }

  setVisible(visible: boolean): void {
    for (const b of this.broods) b.mesh.visible = visible && b.geo.instanceCount > 0;
  }
}
