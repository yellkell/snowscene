/**
 * Snow Survivors' horde, drawn: every enemy on the field in 7 kinds x 3
 * levels of detail = 21 instanced draws at most, and the shards they burst
 * into.
 *
 * The creatures are modelled in Blender (art/scripts/creatures.py): an
 * ice-crusted arachnid, an armoured frost beetle, a rock-and-ice titan, an
 * ember-sac bloater, a stilt-legged lunger, a beetle carrying glowing egg sacs
 * and one crusted in citrine. Each has three LODs (public/survivors/creatures/
 * creatures.glb) sampling one shared 2048 atlas (albedo + gloss; object-space
 * normal, AO and emission) baked from the Cycles HIGH models, and is lit like
 * everything else in the baked scene (baked/light.ts): the low sun, the sky,
 * the snow's bounce, aerial haze, AgX.
 *
 * Animation is still entirely on the GPU, after Factory Fight's swarm
 * (yellkell/factoryfight, src/systems/swarm.ts): every vertex hangs off one
 * rigid part (body, leg, head, jaw, arm, core) that turns about its pivot,
 * driven by a few numbers per enemy (where it stands, which way it faces, how
 * far it has walked, a hit flash, frost or fire, how far out of the snow it
 * has climbed, whether it is biting). The CPU's whole job per frame is one
 * pass copying columns, choosing each enemy's level of detail as it goes.
 *
 * Until the bake has loaded (or if it is missing) the horde draws as the old
 * procedural faceted bodies below, under the same light.
 */

import {
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Float32BufferAttribute,
  type Fog,
  FrontSide,
  type Group,
  ImageBitmapLoader,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix3,
  Mesh,
  NoColorSpace,
  SRGBColorSpace,
  ShaderMaterial,
  type Side,
  Texture,
  Vector3,
  Vector4,
} from '@iwsdk/core';
import { BAKED_GLSL, HAZE_VERT, bakedLight } from '../baked/light.js';
import { assetUrl, loadCompressed, loadGLTF, loadJSON } from '../baked/loaders.js';
import { CAP, type Horde, KINDS, LUNGER } from './horde.js';
import { SOURCE_COLORS } from './weapon-colors.js';
import { duneHeight } from './survivors-level.js';

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

  /** Scale everything built so far (and where its parts turn) about the origin. */
  stretch(sx: number, sy: number, sz: number): this {
    for (let i = 0; i < this.pos.length; i += 3) {
      this.pos[i] *= sx;
      this.pos[i + 1] *= sy;
      this.pos[i + 2] *= sz;
      this.pivot[i] *= sx;
      this.pivot[i + 1] *= sy;
      this.pivot[i + 2] *= sz;
    }
    return this;
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

/* ── the bloater ────────────────────────────────────────────────────────── */

const BLOAT_NECK: V3 = [0, 0.95, 0.66];

/**
 * THE BLOATER. A swollen sac of ember on spindly legs, caged in dark ribs,
 * the fire inside throbbing faster as it nears you: it is going to burst.
 * A small, low head hangs off the front of it.
 */
function bloatBody(): Body {
  const b = new Body();
  b.on(PART_CORE);
  b.gem([0, 1.0, -0.12], 0.8, 0.9, 0.78, 0.5, 8, (s) => (s % 2 ? 1.7 : 1.2), 2.5, 1.1);
  b.on(PART_BODY);
  // Ribs arching over the sac.
  for (const z of [-0.62, -0.14, 0.34]) {
    for (const sx of [-1, 1]) b.limb([sx * 0.86, 0.85, z], [0, 1.84, z * 0.8], 0.09, 0.07, 0, 0.3, 3, 0.2);
  }
  // A spine of studs down the top.
  for (const z of [-0.5, 0, 0.4]) b.limb([0, 1.76, z], [0, 2.02, z - 0.1], 0.08, 0, 0.2, 1.3, 4);
  // A thick neck out of the front of the sac (at its widest), the head on
  // it, and its little mandibles.
  b.limb([0, 1.0, 0.45], [0, 0.95, 0.86], 0.2, 0.16, 0, 0.2, 5, 0.5);
  b.on(PART_HEAD, BLOAT_NECK);
  const head = b.gem([0, 0.95, 0.98], 0.28, 0.26, 0.2, 0.16, 5, (s) => (s === 0 ? 0.5 : 0), 0);
  for (const s of [0, 4]) b.inset(head.top, head.ring[s], head.ring[(s + 1) % 5], [0, 0.95, 0.98], 0.6, 0.015, 2.4);
  for (const sx of [-1, 1]) {
    const base: V3 = [sx * 0.12, 0.84, 1.16];
    b.on(PART_JAW, base);
    b.blade(base, [sx * 0.04, 0.76, 1.42], 0.06, 0.6, 1.5);
  }
  // Six thin legs straining under the weight.
  const legs: Array<[number, V3, V3]> = [
    [0.45, [1.05, 1.0, 0.8], [1.3, 0, 1.15]],
    [0, [1.2, 1.05, 0.05], [1.55, 0, 0.1]],
    [-0.5, [1.05, 1.0, -0.75], [1.3, 0, -1.15]],
  ];
  legs.forEach(([z, knee, foot], k) => {
    for (const sx of [-1, 1]) {
      const hip: V3 = [sx * 0.7, 0.62, z];
      b.on(PART_LEG, hip, (k % 2 === 0) === sx < 0 ? 0 : 1);
      const kn: V3 = [sx * knee[0], knee[1], knee[2]];
      b.blade(kn, hip, 0.07, 1.3, 0.6);
      b.blade(kn, [sx * foot[0], foot[1], foot[2]], 0.06, 1.3, 1.0);
    }
  });
  return b;
}

/* ── the lunger, the splitter and the glitterback ───────────────────────── */

/** The lunger: a mite drawn out long and low, built to charge. */
const LUNGER_STRETCH: V3 = [0.86, 0.88, 1.42];
const LUNGER_NECK: V3 = [MITE_NECK[0], MITE_NECK[1] * LUNGER_STRETCH[1], MITE_NECK[2] * LUNGER_STRETCH[2]];
function lungerBody(): Body {
  const b = miteBody().stretch(...LUNGER_STRETCH);
  // Swept-back spines along its back, hot at the tips.
  b.on(PART_BODY);
  for (const z of [-0.2, -0.75, -1.25]) b.limb([0, 0.68, z], [0, 1.05, z - 0.42], 0.09, 0, 0.3, 1.6, 4);
  return b;
}

/** The splitter: a broad beetle with three glowing brood sacs on its back. */
const SPLITTER_STRETCH: V3 = [1.12, 1.15, 1.05];
const SPLITTER_NECK: V3 = [BEETLE_NECK[0], BEETLE_NECK[1] * SPLITTER_STRETCH[1], BEETLE_NECK[2] * SPLITTER_STRETCH[2]];
function splitterBody(): Body {
  const b = beetleBody();
  b.on(PART_CORE);
  for (const [x, z] of [
    [-0.32, -0.25],
    [0.32, -0.25],
    [0, -0.65],
  ]) {
    b.gem([x, 1.0, z], 0.22, 0.24, 0.22, 0.12, 6, () => 1.5, 2.2);
  }
  return b.stretch(...SPLITTER_STRETCH);
}

/** The glitterback: a small beetle crusted in crystals that blaze. */
const GLITTER_STRETCH: V3 = [0.9, 0.9, 0.9];
const GLITTER_NECK: V3 = [BEETLE_NECK[0], BEETLE_NECK[1] * 0.9, BEETLE_NECK[2] * 0.9];
function glitterBody(): Body {
  const b = beetleBody();
  b.on(PART_CORE);
  const crystals: Array<[V3, number, number]> = [
    [[0, 0.95, -0.1], 0.2, 0.75],
    [[-0.34, 0.86, -0.35], 0.15, 0.55],
    [[0.34, 0.86, -0.35], 0.15, 0.55],
    [[-0.2, 0.9, 0.2], 0.13, 0.45],
    [[0.22, 0.88, 0.18], 0.13, 0.5],
    [[0, 0.8, -0.72], 0.14, 0.45],
  ];
  for (const [c, r, h] of crystals) b.gem(c, r, r, h, 0.05, 5, () => 1.6, 2.8);
  return b.stretch(...GLITTER_STRETCH);
}

/* ── the shader ─────────────────────────────────────────────────────────── */

/**
 * The scene's light for things that move (baked/light.ts): sun, sky and snow
 * bounce as dynamicLight() gives them, plus what dynamicLight leaves out, the
 * specular: the low sun's highlight on wax and ice, and the sky (or the snow
 * below) mirrored at grazing angles, which is what makes chitin read as
 * chitin rather than painted clay.
 */
const SPECULAR_GLSL = /* glsl */ `
vec3 specular(vec3 n, vec3 V, float gloss, float ao, float sunVis) {
  float r = mix(0.72, 0.13, gloss);
  float a2 = r * r * r * r;
  vec3 H = normalize(uSunDir + V);
  float nh = max(dot(n, H), 0.0);
  float nl = max(dot(n, uSunDir), 0.0);
  float vh = max(dot(V, H), 0.0);
  float dd = nh * nh * (a2 - 1.0) + 1.0;
  float D = a2 / (3.14159 * dd * dd);
  float F = 0.04 + 0.96 * pow(1.0 - vh, 5.0);
  vec3 col = uSunColor * min(D * F * 0.25 * nl / max(vh * vh, 0.2), 40.0) * sunVis;
  vec3 R = reflect(-V, n);
  vec3 sky = uSkyGain * mix(uHazeColor, uOpenSky * uSkyTint * 1.15, smoothstep(0.0, 0.55, R.y));
  vec3 snow = uSnowAlbedo * (uOpenSun * uSunColor + uOpenSky * uSkyTint * uSkyGain);
  vec3 env = mix(sky, snow, smoothstep(0.0, -0.3, R.y));
  float nv = max(dot(n, V), 0.0);
  float Fe = 0.04 + 0.96 * pow(1.0 - nv, 5.0) * (1.0 - r) * (1.0 - r);
  return col + env * Fe * mix(0.35, 1.0, gloss) * ao;
}
// Cheap 3D value noise (for rime and embers that cling to the body as it walks).
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float k = 17.31;
  float a = mix(hash12(i.xy + i.z * k), hash12(i.xy + vec2(1.0, 0.0) + i.z * k), f.x);
  float b = mix(hash12(i.xy + vec2(0.0, 1.0) + i.z * k), hash12(i.xy + vec2(1.0) + i.z * k), f.x);
  float c = mix(hash12(i.xy + (i.z + 1.0) * k), hash12(i.xy + vec2(1.0, 0.0) + (i.z + 1.0) * k), f.x);
  float d = mix(hash12(i.xy + vec2(0.0, 1.0) + (i.z + 1.0) * k), hash12(i.xy + vec2(1.0) + (i.z + 1.0) * k), f.x);
  return mix(mix(a, b, f.y), mix(c, d, f.y), f.z);
}
`;

/** BAKED_GLSL for a vertex shader that also includes HAZE_VERT (which declares uHaze itself). */
const VERT_LIGHT = BAKED_GLSL.replace('uniform vec2 uHaze;', '');

/**
 * The horde's vertex shader: every enemy animated from a few numbers. Each
 * vertex hangs off one rigid part (aRig.x: body, leg, head, jaw, arm, core)
 * that turns about its own pivot; the same turns are carried to the fragment
 * shader as a quaternion (vQ) so the baked object-space normals turn with the
 * legs, jaws and heading.
 */
const SWARM_VERT = /* glsl */ `
attribute vec2 aRig;    // part, beat (which half of the gait)
attribute vec3 aPivot;  // where the part turns
attribute float aGlow;  // atlas: how much its glow breathes; fallback: corner glow
attribute vec4 iPose;   // x, z, heading, radius
attribute vec4 iAnim;   // stride, flash, frost (+) / fire (-), rise
attribute vec3 iAct;    // height off the floor, flailing (0..1), biting (0..1)
uniform float uClock;
uniform vec4 uGait;     // cadence, leg swing, foot lift, body bob
uniform vec4 uMove;     // roll, jaw snap, arm swing, thrash rate
uniform vec3 uNeck;     // where the head nods
uniform vec3 uFlashPal[${SOURCE_COLORS.length}];
varying vec3 vW;
varying vec4 vQ;
varying vec4 vFx;       // flash, frost/fire, glow breath, fallback glow
varying float vSunVis;
#ifdef ATLAS
varying vec2 vUv;
varying vec3 vObj;
#endif
${HAZE_VERT}
${VERT_LIGHT}
varying vec3 vFlashCol;

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
// turnY(a) is a rotation of -a about +y; turnX(a) one of +a about +x.
vec4 qY(float a) { return vec4(0.0, sin(a * 0.5), 0.0, cos(a * 0.5)); }
vec4 qX(float a) { return vec4(sin(a * 0.5), 0.0, 0.0, cos(a * 0.5)); }
vec4 qMul(vec4 a, vec4 b) { return vec4(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz)); }

void main() {
  vec3 p = position;
  vec4 q = vec4(0.0, 0.0, 0.0, 1.0);
  float part = aRig.x;
  float beat = aRig.y * 3.14159;
  float seed = fract(sin(iPose.x * 12.9898 + iPose.y * 78.233) * 43758.5453) * 6.2832;
  float fl = iAct.y;
  float bite = iAct.z;
  // The gait runs on distance walked (so a stopped crawler stands still),
  // a kind's cadence per body-radius: a mite skitters, a hulk plods.
  float ph = iAnim.x * uGait.x / max(iPose.w, 0.01);
  // In your fist or in the air, everything thrashes.
  ph = mix(ph, uClock * uMove.w + seed, fl);
  // Chewing a tower: the feet scrabble where they stand.
  ph += bite * sin(uClock * 13.0 + seed) * 0.5;
  float lp = ph + beat;
  float breath = 0.75 + 0.25 * sin(uClock * mix(3.0, 9.0, max(bite, fl)) + seed);
  float breathes = part == 5.0 ? 1.0 : 0.0;
  if (part == 1.0 || part == 4.0) {
    // A leg (or a hulk's arm) swings about its hip and lifts on the way
    // forward, the farther from the hip the higher.
    float reach = clamp(length(p.xz - aPivot.xz) / 1.2, 0.0, 1.0);
    float sw = sin(lp) * (part == 4.0 ? uMove.z : uGait.y);
    p = turnY(p, aPivot, sw);
    q = qY(-sw);
    p.y += pow(max(0.0, cos(lp)), 0.7) * uGait.z * reach;
    if (part == 4.0) {
      // Biting, a hulk raises both fists and brings them down.
      float slam = pow(0.5 + 0.5 * sin(uClock * 5.0 + seed + beat * 0.4), 3.0);
      float ang = -bite * slam * 1.1 - fl * 0.5 * (0.5 + 0.5 * sin(uClock * 9.0 + beat));
      p = turnX(p, aPivot, ang);
      q = qMul(qX(ang), q);
    }
  } else {
    if (part == 3.0) {
      // Jaws: idly working as it walks; snapping when it bites.
      float open = mix(0.3 + 0.3 * sin(ph * 0.5 + seed + uClock * 3.0), 0.5 + 0.5 * sin(uClock * 24.0 + seed), max(bite, fl));
      float o = open * uMove.y * (aPivot.x < 0.0 ? 1.0 : -1.0);
      p = turnY(p, aPivot, o);
      q = qY(-o);
    }
    if (part == 2.0 || part == 3.0) {
      // Heads nod into a bite.
      float nod = bite * (sin(uClock * 26.0 + seed) * 0.14 - 0.12) + sin(ph * 0.5) * 0.04;
      p = turnX(p, uNeck, nod);
      q = qMul(qX(nod), q);
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
  vQ = qMul(qY(h), q);
#ifdef ATLAS
  vUv = uv;
  vObj = position;
  breathes = max(breathes, aGlow * 0.5);
#endif
  // The flash carries what hit it: (palette index) * 2 + strength.
  float src = floor(iAnim.y * 0.5 + 0.001);
  vFlashCol = uFlashPal[int(min(src, ${(SOURCE_COLORS.length - 1).toFixed(1)}))];
  vFx = vec4(iAnim.y - src * 2.0, iAnim.z, mix(1.0, breath, breathes), aGlow * (part == 5.0 ? breath : 1.0));
  vec3 inst = (modelMatrix * vec4(iPose.x, iAct.x, iPose.y, 1.0)).xyz;
  vSunVis = groundSunVisibility(inst.xz);
  computeHaze(wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

/**
 * The horde's fragment shader. With ATLAS: albedo + gloss, object-space
 * normal (octahedral), AO and emission from the shared creature atlas baked
 * in Blender (art/scripts/creatures.py), lit by the scene's light. Without:
 * the procedural fallback bodies, flat facets in the kind's colours.
 *
 * Frost is rime: it grows from the surfaces facing the sky and the crevices
 * first and, frozen solid, glazes the creature in clear ice. Fire chars the
 * shell and lights embers in its cracks. A hit is a brief pale flare at the
 * silhouette, not a white-out.
 */
const SWARM_FRAG = /* glsl */ `
${BAKED_GLSL}
${SPECULAR_GLSL}
uniform vec3 uAccent;
uniform vec3 uBody;
uniform float uEmit;
uniform float uClock;
uniform mat3 uRoot;   // the horde group's rotation (modelMatrix is vertex-only)
varying float vHazeF;
varying vec3 vW;
varying vec4 vQ;
varying vec4 vFx;
varying float vSunVis;
#ifdef ATLAS
uniform sampler2D tAlbedo;
uniform sampler2D tData;
varying vec2 vUv;
varying vec3 vObj;
#endif

vec3 qrot(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
vec3 octDecode(vec2 e) {
  e = e * 2.0 - 1.0;
  vec3 n = vec3(e.x, e.y, 1.0 - abs(e.x) - abs(e.y));
  float t = max(-n.z, 0.0);
  n.x += n.x >= 0.0 ? -t : t;
  n.y += n.y >= 0.0 ? -t : t;
  return normalize(n);
}
varying vec3 vFlashCol;

void main() {
  vec3 V = normalize(cameraPosition - vW);
#ifdef ATLAS
  vec4 A = texture2D(tAlbedo, vUv);
  vec4 D = texture2D(tData, vUv);
  vec3 alb = A.rgb;
  float gloss = A.a;
  float ao = D.b;
  vec3 n = normalize(uRoot * qrot(vQ, octDecode(D.rg)));
  vec3 E = uAccent * (D.a * uEmit * vFx.z);
  vec3 rp = vObj;
#else
  vec3 n = normalize(cross(dFdx(vW), dFdy(vW)));
  if (dot(n, V) < 0.0) n = -n;
  float g = clamp(vFx.w, 0.0, 1.0);
  vec3 alb = mix(uBody * 0.35, uAccent * 0.6, smoothstep(0.86, 1.0, g));
  float gloss = 0.35;
  float ao = 1.0;
  vec3 E = mix(uAccent, vec3(1.0, 0.84, 0.5), 0.5) * clamp(vFx.w - 1.0, 0.0, 1.0) * 2.0;
  vec3 rp = vW * 0.5;
#endif
  float fx = vFx.y;
#ifndef CHEAP
  if (fx > 0.0) {
    // Rime: up-facing surfaces and crevices first, feathered by noise; frozen
    // solid, a glaze of clear ice over everything.
    float nz = vnoise(rp * 9.0) * 0.6 + vnoise(rp * 23.0) * 0.4;
    float cover = 0.45 * (n.y * 0.5 + 0.5) + 0.35 * (1.0 - ao) + 0.55 * nz;
    float grow = min(fx, 0.3) * 1.1;
    float rime = smoothstep(1.15 - grow, 1.3 - grow, cover);
    float solid = smoothstep(0.9, 1.0, fx);
    alb = mix(alb, vec3(0.78, 0.84, 0.92), rime);
    // frozen solid: deep glacier blue under the glaze, so a frozen crowd still stands out on the snow
    alb = mix(alb, vec3(0.1, 0.24, 0.55), solid * (1.0 - rime) * 0.85);
    gloss = mix(mix(gloss, 0.12, rime), 0.95, solid * (1.0 - rime));
    E *= 1.0 - 0.7 * max(rime, solid);
  } else if (fx < 0.0) {
    // Burning: the shell chars and embers glow in its cracks, flickering.
    float b = -fx;
    float flick = vnoise(rp * 7.0 + vec3(0.0, -uClock * 1.9, uClock * 0.7));
    // thin seams (ridges of noise) and the deepest crevices (baked AO)
    float seam = smoothstep(0.93, 0.99, 1.0 - abs(vnoise(rp * 9.0) * 2.0 - 1.0));
    float crack = clamp(seam * smoothstep(0.35, 0.7, flick) + smoothstep(0.72, 0.92, 1.0 - ao) * 0.7, 0.0, 1.0);
    alb *= mix(1.0, 0.3, b);
    gloss *= 1.0 - 0.7 * b;
    E += vec3(1.0, 0.28, 0.04) * crack * b * (0.6 + 1.6 * flick);
  }
#else
  if (fx > 0.0) {
    alb = mix(alb, vec3(0.78, 0.84, 0.92), fx * 0.8);
    gloss = mix(gloss, 0.5, fx);
  } else if (fx < 0.0) {
    alb *= mix(1.0, 0.3, -fx);
    E += vec3(1.0, 0.3, 0.05) * (1.0 - ao) * -fx * 2.0;
  }
#endif
  vec3 col = alb * (dynamicLight(n, ao, vSunVis) + fireLight(vW, n));
  col += specular(n, V, gloss, ao, vSunVis);
  col += E;
  // A hit flares in the colour of what hit it: a little over the body, strongest at the silhouette.
  float nv = clamp(dot(n, V), 0.0, 1.0);
  col += mix(vec3(1.0, 0.92, 0.82), vFlashCol, 0.7) * vFx.x * (0.08 + 0.8 * (1.0 - nv) * (1.0 - nv));
  col = applyHaze(col, vHazeF);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
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
  { body: bloatBody, neck: BLOAT_NECK, gait: new Vector4(3.4, 0.32, 0.3, 0.09), move: new Vector4(0.06, 0.3, 0, 26) },
  { body: lungerBody, neck: LUNGER_NECK, gait: new Vector4(2.2, 0.5, 0.36, 0.05), move: new Vector4(0, 0.6, 0, 40) },
  { body: splitterBody, neck: SPLITTER_NECK, gait: new Vector4(3.0, 0.3, 0.24, 0.05), move: new Vector4(0.04, 0.35, 0, 22) },
  { body: glitterBody, neck: GLITTER_NECK, gait: new Vector4(2.8, 0.42, 0.34, 0.07), move: new Vector4(0.03, 0.35, 0, 30) },
];

/** Shader materials share the scene's light uniforms by reference. */
function litMaterial(uniforms: Record<string, { value: unknown }>, defines: Record<string, string>, side: Side = FrontSide): ShaderMaterial {
  const m = new ShaderMaterial({ uniforms: { ...uniforms }, vertexShader: SWARM_VERT, fragmentShader: SWARM_FRAG, defines, side, fog: false });
  for (const [k, v] of Object.entries(bakedLight)) m.uniforms[k] = v as { value: unknown };
  return m;
}

/** Levels of detail per kind, nearest first. */
const LODS = 3;

/** One kind at one level of detail: its body and its own instance columns. */
class Brood {
  readonly mesh: Mesh;
  geo: InstancedBufferGeometry;
  readonly pose = new InstancedBufferAttribute(new Float32Array(CAP * 4), 4).setUsage(DynamicDrawUsage);
  readonly anim = new InstancedBufferAttribute(new Float32Array(CAP * 4), 4).setUsage(DynamicDrawUsage);
  readonly act = new InstancedBufferAttribute(new Float32Array(CAP * 3), 3).setUsage(DynamicDrawUsage);
  /** Triangles per enemy drawn by this brood. */
  tris = 0;

  constructor(parent: Group, kind: number, lod: number, body: BufferGeometry, mat: ShaderMaterial) {
    this.geo = this.instanced(body);
    this.mesh = new Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = lod;
    this.mesh.name = `swarm-${KINDS[kind].name}-lod${lod}`;
    parent.add(this.mesh);
  }

  private instanced(body: BufferGeometry): InstancedBufferGeometry {
    const g = new InstancedBufferGeometry();
    g.setIndex(body.index);
    for (const [name, at] of Object.entries(body.attributes)) g.setAttribute(name, at);
    g.setAttribute('iPose', this.pose);
    g.setAttribute('iAnim', this.anim);
    g.setAttribute('iAct', this.act);
    g.instanceCount = 0;
    this.tris = (body.index ? body.index.count : body.getAttribute('position').count) / 3;
    return g;
  }

  /** Swap in a new body (the baked LOD replacing the procedural fallback). */
  setBody(body: BufferGeometry, mat: ShaderMaterial): void {
    const old = this.geo;
    this.geo = this.instanced(body);
    this.geo.instanceCount = old.instanceCount;
    this.mesh.geometry = this.geo;
    this.mesh.material = mat;
    old.dispose();
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

/* ── the baked creatures ────────────────────────────────────────────────── */

const CREATURE_DIR = 'survivors/creatures/';

interface CreatureManifest {
  glb: string;
  albedo: string;
  data: string;
  emit_max: number;
  kinds: Record<string, { radius: number; neck: [number, number, number]; lods: { tris: number; verts: number }[] }>;
}

/** An atlas page, decoded off the main thread and never premultiplied (its alpha is data, not coverage). */
async function atlasTexture(path: string, color: boolean): Promise<Texture> {
  // the KTX2 twin when there is one (art/scripts/ktx2.mjs): a fifth of the GPU memory; stored unflipped
  // with its alpha as data, exactly as this page is sampled
  const packed = await loadCompressed(path, color, 4);
  if (packed) return packed;
  const loader = new ImageBitmapLoader().setOptions({ imageOrientation: 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const bitmap = (await loader.loadAsync(assetUrl(path))) as ImageBitmap;
  const t = new Texture(bitmap);
  t.flipY = false;
  t.colorSpace = color ? SRGBColorSpace : NoColorSpace;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/** A glTF LOD as the swarm's attributes (GLTFLoader lower-cases custom names: _RIG -> _rig). */
function lodBody(src: BufferGeometry): BufferGeometry {
  const g = new BufferGeometry();
  g.setIndex(src.index);
  g.setAttribute('position', src.getAttribute('position'));
  g.setAttribute('uv', src.getAttribute('uv'));
  g.setAttribute('aRig', src.getAttribute('_rig'));
  g.setAttribute('aPivot', src.getAttribute('_pivot'));
  g.setAttribute('aGlow', src.getAttribute('_glow'));
  return g;
}

/* ── the shards ─────────────────────────────────────────────────────────── */

const SHARD_CAP = 3000;

const SHARD_VERT = /* glsl */ `
attribute vec4 iPos;   // x, y, z, size
attribute vec4 iRot;   // axis, angle
attribute vec3 iCol;   // tint
attribute vec2 iInfo;  // kind (0 ice, 1 shell), heat
varying vec3 vCol;
varying vec3 vN;
varying vec3 vW;
varying vec2 vInfo;
varying float vSunVis;
${HAZE_VERT}
${VERT_LIGHT}
vec3 rot(vec3 v, vec3 k, float a) {
  float c = cos(a);
  float s = sin(a);
  return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
}
void main() {
  vec3 k = normalize(iRot.xyz + vec3(1e-4));
  vec3 p = rot(position, k, iRot.w) * iPos.w + iPos.xyz;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vN = normalize(mat3(modelMatrix) * rot(normal, k, iRot.w));
  vW = wp.xyz;
  vCol = iCol;
  vInfo = iInfo;
  vSunVis = groundSunVisibility(wp.xz);
  computeHaze(wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SHARD_FRAG = /* glsl */ `
${BAKED_GLSL}
${SPECULAR_GLSL}
varying float vHazeF;
varying vec3 vCol;
varying vec3 vN;
varying vec3 vW;
varying vec2 vInfo;
varying float vSunVis;
void main() {
  vec3 n = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  bool shell = vInfo.x > 0.5;
  // Ice splinters tinted by what burst (clear, catching the sky), or chips of dark shell.
  vec3 alb = shell ? vCol * 0.05 + 0.012 : mix(vec3(0.42, 0.55, 0.66), vCol, 0.3);
  float gloss = shell ? 0.55 : 0.92;
  vec3 col = alb * (dynamicLight(n, 1.0, vSunVis) + fireLight(vW, n)) + specular(n, V, gloss, 1.0, vSunVis);
  // Still hot (or still charged) as they fly; cooling as they settle.
  col += vCol * (vInfo.y * vInfo.y) * (shell ? 0.4 : 1.6);
  col = applyHaze(col, vHazeF);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** A splinter: an irregular, elongated, flat-faceted chunk, unit size. */
function shardGeometry(): BufferGeometry {
  const v = [
    [0.05, 1.0, 0.02],
    [0.55, 0.05, 0.12],
    [-0.12, 0.1, 0.5],
    [-0.5, -0.05, -0.08],
    [0.1, -0.02, -0.45],
    [-0.04, -0.85, 0.05],
  ];
  const faces = [
    [0, 2, 1],
    [0, 3, 2],
    [0, 4, 3],
    [0, 1, 4],
    [5, 1, 2],
    [5, 2, 3],
    [5, 3, 4],
    [5, 4, 1],
  ];
  const pos: number[] = [];
  const nor: number[] = [];
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const e1 = new Vector3();
  const e2 = new Vector3();
  for (const f of faces) {
    a.fromArray(v[f[0]]);
    b.fromArray(v[f[1]]);
    c.fromArray(v[f[2]]);
    const n = e1.subVectors(b, a).cross(e2.subVectors(c, a)).normalize();
    // keep every face wound outward
    if (n.dot(a) < 0) {
      n.negate();
      for (const p of [a, c, b]) pos.push(p.x, p.y, p.z);
    } else for (const p of [a, b, c]) pos.push(p.x, p.y, p.z);
    for (let k = 0; k < 3; k++) nor.push(n.x, n.y, n.z);
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
  private readonly iInfo: InstancedBufferAttribute;
  private readonly p = new Float32Array(SHARD_CAP * 3);
  private readonly v = new Float32Array(SHARD_CAP * 3);
  private readonly axis = new Float32Array(SHARD_CAP * 3);
  private readonly ang = new Float32Array(SHARD_CAP);
  private readonly spin = new Float32Array(SHARD_CAP);
  private readonly life = new Float32Array(SHARD_CAP);
  private readonly maxLife = new Float32Array(SHARD_CAP);
  private readonly size = new Float32Array(SHARD_CAP);
  private readonly col = new Float32Array(SHARD_CAP * 3);
  private readonly shell = new Uint8Array(SHARD_CAP);
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
    this.iInfo = new InstancedBufferAttribute(new Float32Array(SHARD_CAP * 2), 2).setUsage(DynamicDrawUsage);
    this.geo.setAttribute('iPos', this.iPos);
    this.geo.setAttribute('iRot', this.iRot);
    this.geo.setAttribute('iCol', this.iCol);
    this.geo.setAttribute('iInfo', this.iInfo);
    this.geo.instanceCount = 0;
    const mat = new ShaderMaterial({ vertexShader: SHARD_VERT, fragmentShader: SHARD_FRAG, side: FrontSide, fog: false });
    for (const [k, val] of Object.entries(bakedLight)) mat.uniforms[k] = val as { value: unknown };
    this.mesh = new Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'shards';
    parent.add(this.mesh);
  }

  /** Burst `n` shards out of (x, y, z): `speed` outward, `up` upward. */
  burst(x: number, y: number, z: number, n: number, hex: number, size: number, speed: number, up: number): void {
    // the burst colour is sRGB; the shader lights in linear
    this.tmp.setHex(hex);
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
      // Most are splinters of ice tinted by what burst; some are its dark shell.
      this.shell[i] = Math.random() < 0.3 ? 1 : 0;
      this.col[i * 3] = this.tmp.r;
      this.col[i * 3 + 1] = this.tmp.g;
      this.col[i * 3 + 2] = this.tmp.b;
    }
  }

  tick(dt: number): void {
    const P = this.iPos.array as Float32Array;
    const R = this.iRot.array as Float32Array;
    const C = this.iCol.array as Float32Array;
    const I = this.iInfo.array as Float32Array;
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
      I[n * 2] = this.shell[i];
      I[n * 2 + 1] = this.life[i] / this.maxLife[i];
      n++;
    }
    this.live = n;
    this.geo.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n > 0) {
      for (const at of [this.iPos, this.iRot, this.iCol, this.iInfo]) {
        at.clearUpdateRanges();
        at.addUpdateRange(0, n * at.itemSize);
        at.needsUpdate = true;
      }
    }
  }
}

/* ── the horde, every frame ─────────────────────────────────────────────── */

/** The weapons' colours, for the hit flash (shared by every kind). */
const FLASH_PALETTE = { value: SOURCE_COLORS.map((c) => new Color(c)) };

/**
 * Distance LOD with fixed budgets. Each enemy is measured in its own body
 * radii from the head (so a boss is "near" from farther off) and routed to
 * LOD0 / LOD1 / LOD2 by two cut-offs. The cut-offs come from last frame's
 * histogram of that measure, weighted by what each enemy would cost in
 * triangles, so the nearest ones fill each band's triangle budget; the
 * budgets (and per-band counts) are also enforced as the pass runs, so the
 * horde can never draw more than B0 + B1 + 3000 x LOD2.
 */
// sized for Quest 3 (with the ground, props and forest the late horde stays under ~450k triangles)
const BUDGET0 = 70_000;
const BUDGET1 = 80_000;
const COUNT0 = 150;
const COUNT1 = 900;
/** Beyond these (body radii) a band is wasted detail whatever the budget. */
const FAR0 = 60;
const FAR1 = 220;
/** Histogram of sqrt(radii) in 1/8 steps. */
const BINS = 128;

export class SwarmMesh {
  /** KINDS.length x LODS, kind-major. */
  private readonly broods: Brood[] = [];
  private readonly clock = { value: 0 };
  private readonly root = { value: new Matrix3() };
  private readonly P: Float32Array[] = [];
  private readonly A: Float32Array[] = [];
  private readonly R: Float32Array[] = [];
  private readonly count = new Int32Array(KINDS.length * LODS);
  /** Triangles per enemy per (kind, lod). */
  private readonly tris = new Float32Array(KINDS.length * LODS);
  private readonly hist0 = new Float32Array(BINS);
  private readonly hist1 = new Float32Array(BINS);
  private cut0 = 12;
  private cut1 = 60;
  private readonly local = new Vector3();
  /** Per kind: the uniforms its materials share (gait, neck, accent...). */
  private readonly kindUniforms: Record<string, { value: unknown }>[] = [];
  /** Triangles drawn last frame (for the HUD / profiling). */
  drawnTris = 0;

  constructor(private readonly parent: Group) {
    KINDS.forEach((kind, k) => {
      const spec = GAITS[k];
      const uniforms = {
        uAccent: { value: new Color(kind.accent) },
        uBody: { value: new Color(kind.body) },
        uGait: { value: spec.gait },
        uMove: { value: spec.move },
        uNeck: { value: new Vector3(...spec.neck) },
        uEmit: { value: 8 },
        uClock: this.clock,
        uFlashPal: FLASH_PALETTE,
        uRoot: this.root,
      };
      const body = spec.body().geometry();
      const fallback = litMaterial(uniforms, {}, DoubleSide);
      this.kindUniforms.push(uniforms);
      for (let l = 0; l < LODS; l++) {
        const b = new Brood(parent, k, l, body, fallback);
        this.broods.push(b);
        this.P.push(b.pose.array as Float32Array);
        this.A.push(b.anim.array as Float32Array);
        this.R.push(b.act.array as Float32Array);
        this.tris[k * LODS + l] = b.tris;
      }
    });
    this.load().catch((e) => console.warn('Snow Survivors: creature bake not loaded, keeping the procedural horde', e));
  }

  /** Swap the procedural bodies for the Blender-baked creatures as soon as they arrive. */
  private async load(): Promise<void> {
    const man = await loadJSON<CreatureManifest>(`${CREATURE_DIR}manifest.json`);
    const [gltf, albedo, data] = await Promise.all([
      loadGLTF(CREATURE_DIR + man.glb),
      atlasTexture(CREATURE_DIR + man.albedo, true),
      atlasTexture(CREATURE_DIR + man.data, false),
    ]);
    const meshes = new Map<string, BufferGeometry>();
    gltf.scene.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) meshes.set(m.name, m.geometry as BufferGeometry);
    });
    KINDS.forEach((kind, k) => {
      const info = man.kinds[kind.name];
      if (!info) return;
      const base = this.kindUniforms[k];
      (base.uNeck.value as Vector3).fromArray(info.neck);
      base.uEmit.value = man.emit_max;
      const atlas = { ...base, tAlbedo: { value: albedo }, tData: { value: data } };
      for (let l = 0; l < LODS; l++) {
        const src = meshes.get(`${kind.name}_lod${l}`);
        if (!src) continue;
        const mat = litMaterial(atlas, l === LODS - 1 ? { ATLAS: '', CHEAP: '' } : { ATLAS: '' });
        const b = this.broods[k * LODS + l];
        b.setBody(lodBody(src), mat);
        this.tris[k * LODS + l] = b.tris;
      }
    });
  }

  /**
   * Copy the horde into the instance buffers: one pass, each enemy into its
   * kind's columns at the level of detail its distance from `head` (world)
   * and the triangle budgets allow.
   */
  update(h: Horde, clock: number, _fog?: Fog | null, head?: Vector3): void {
    const { P, A, R, count, tris, hist0, hist1 } = this;
    count.fill(0);
    hist0.fill(0);
    hist1.fill(0);
    let hx = 0;
    let hz = 0;
    if (head) {
      this.parent.worldToLocal(this.local.copy(head));
      hx = this.local.x;
      hz = this.local.z;
    }
    const cut0 = head ? this.cut0 : -1;
    const cut1 = head ? this.cut1 : -1;
    let used0 = 0;
    let used1 = 0;
    let n0 = 0;
    let n1 = 0;
    let drawn = 0;
    for (let i = 0; i < h.n; i++) {
      if (h.dead[i]) continue;
      const k = h.kind[i];
      const size = KINDS[k].radius * h.scale[i];
      const dx = h.x[i] - hx;
      const dz = h.z[i] - hz;
      const m = Math.sqrt(dx * dx + dz * dz) / size;
      const b = Math.min(BINS - 1, Math.floor(Math.sqrt(m) * 8));
      const t0 = tris[k * LODS];
      const t1 = tris[k * LODS + 1];
      hist0[b] += t0;
      hist1[b] += t1;
      let lod = 2;
      if (m < cut0 && n0 < COUNT0 && used0 + t0 <= BUDGET0) {
        lod = 0;
        used0 += t0;
        n0++;
      } else if (m < cut1 && n1 < COUNT1 && used1 + t1 <= BUDGET1) {
        lod = 1;
        used1 += t1;
        n1++;
      }
      const slot = k * LODS + lod;
      drawn += tris[slot];
      const n = count[slot]++;
      const o = n * 4;
      const pose = P[slot];
      const anim = A[slot];
      const act = R[slot];
      pose[o] = h.x[i];
      pose[o + 1] = h.z[i];
      pose[o + 2] = h.heading[i];
      pose[o + 3] = size;
      anim[o] = h.stride[i];
      anim[o + 1] = (h.flash[i] > 0 ? Math.min(1, h.flash[i] / 0.1) : 0) + h.hitBy[i] * 2;
      // Frost as positive, fire as negative (burning, it glows ember).
      anim[o + 2] = h.ice[i] > 0 ? 1 : h.burn[i] > 0 ? -Math.min(1, 0.5 + h.burn[i] * 0.25) : h.chill[i] > 0 ? 0.3 : 0;
      anim[o + 3] = h.rise[i];
      const q = n * 3;
      act[q] = duneHeight(h.x[i], h.z[i]) + (h.rise[i] - 1) * KINDS[k].radius * 1.4;
      // Flailing: knocked flying, or a lunger's tell (scrabbling on the spot).
      act[q + 1] = h.kT[i] > 0 || (k === LUNGER && h.state[i] === 1) ? 1 : 0;
      act[q + 2] = h.bite[i];
    }
    for (let s = 0; s < this.broods.length; s++) this.broods[s].flush(count[s]);
    this.drawnTris = drawn;
    this.clock.value = clock;
    this.root.value.setFromMatrix4(this.parent.matrixWorld);
    // Next frame's cut-offs: fill each band's budget from the nearest out.
    let acc = 0;
    let bin = 0;
    for (; bin < BINS; bin++) {
      if (acc + hist0[bin] > BUDGET0 * 0.95) break;
      acc += hist0[bin];
    }
    this.cut0 = Math.min(FAR0, (bin / 8) * (bin / 8));
    bin = Math.min(bin, Math.floor(Math.sqrt(FAR0) * 8));
    acc = 0;
    for (; bin < BINS; bin++) {
      if (acc + hist1[bin] > BUDGET1 * 0.95) break;
      acc += hist1[bin];
    }
    this.cut1 = Math.min(FAR1, (bin / 8) * (bin / 8));
  }

  setVisible(visible: boolean): void {
    for (const b of this.broods) b.mesh.visible = visible && b.geo.instanceCount > 0;
  }
}
