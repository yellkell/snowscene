/**
 * Snow Survivors' weapons and pickups, drawn: pooled and instanced so a
 * screen full of bolts, swords, crystals and lightning costs a handful of
 * draws. Also the ice boulders the big ones hurl back at you. The survivors system owns the rules; these only hold state that
 * moves on its own (a bolt's flight, a crystal's bob) and draw it.
 */

import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  type Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  OctahedronGeometry,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Euler,
  Vector3,
} from '@iwsdk/core';
import { GeometryBuilder, placed } from '../mesh-utils.js';
import { drawLettering, fitLettering } from './lettering.js';
import { duneHeight } from './survivors-level.js';

const tmpM = new Matrix4();
const tmpQ = new Quaternion();
const tmpS = new Vector3();
const tmpP = new Vector3();
const UP = new Vector3(0, 1, 0);
const Z_AXIS = new Vector3(0, 0, 1);
const WHITE = new Color(1, 1, 1);
const spinQ = new Quaternion();
const tmpC = new Color();
const tmpE = new Euler(0, 0, 0, 'YXZ');

/**
 * The way the viewer faces this frame (the system sets it before drawing):
 * glows drawn as flat cards turned to it always face you.
 */
export const billboard = new Quaternion();

/** Shared soft glow for halos and glints (one texture for all of them). */
let flare: CanvasTexture | null = null;
function sharedFlare(): CanvasTexture {
  if (!flare) flare = flareTexture();
  return flare;
}

/**
 * Crossed quads along -Z from z = 0 (bright, `head`) to z = -1 (dark,
 * `tail`), `width` wide: a streak that reads from any side (one quad
 * upright, one flat), for additive trails.
 */
export function streakGeometry(width: number, head = 1, tail = 0): BufferGeometry {
  const w = width / 2;
  const pos: number[] = [];
  const col: number[] = [];
  const quad = (ax: number, ay: number) => {
    // (offset at head, offset at tail): tapering to a point.
    const p = [
      [ax, ay, 0],
      [-ax, -ay, 0],
      [-ax * 0.15, -ay * 0.15, -1],
      [ax, ay, 0],
      [-ax * 0.15, -ay * 0.15, -1],
      [ax * 0.15, ay * 0.15, -1],
    ];
    for (const v of p) {
      pos.push(v[0], v[1], v[2]);
      const c = v[2] === 0 ? head : tail;
      col.push(c, c, c);
    }
  };
  quad(w, 0);
  quad(0, w);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  return g;
}

export function additive(extra: { vertexColors?: boolean; map?: CanvasTexture } = {}): MeshBasicMaterial {
  return new MeshBasicMaterial({
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
    toneMapped: false,
    fog: false,
    ...extra,
  });
}

/** A soft four-pointed flare with a bright core, for hit flashes. */
export function flareTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.18, 'rgba(255,255,255,0.75)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.18)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  // The spikes.
  ctx.globalCompositeOperation = 'lighter';
  for (const [w, h] of [
    [128, 6],
    [6, 128],
  ]) {
    const s = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    s.addColorStop(0, 'rgba(255,255,255,0.9)');
    s.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = s;
    ctx.fillRect(64 - w / 2, 64 - h / 2, w, h);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

// ------------------------------------------------------------ impacts ---

const IMPACT_CAP = 160;

/**
 * Hit flashes: a bright flare that pops and fades where a bolt, a blade or
 * a bolt of lightning lands, turned to face you. Pooled; the oldest goes
 * when it is full.
 */
export class Impacts {
  readonly mesh: InstancedMesh;
  private readonly x = new Float32Array(IMPACT_CAP);
  private readonly y = new Float32Array(IMPACT_CAP);
  private readonly z = new Float32Array(IMPACT_CAP);
  private readonly size = new Float32Array(IMPACT_CAP);
  private readonly age = new Float32Array(IMPACT_CAP).fill(1);
  private readonly spin = new Float32Array(IMPACT_CAP);
  private readonly color = new Uint32Array(IMPACT_CAP);
  private next = 0;

  constructor(parent: Group) {
    this.mesh = new InstancedMesh(new PlaneGeometry(1, 1), additive({ map: flareTexture() }), IMPACT_CAP);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.setColorAt(0, tmpC.set(0xffffff));
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.mesh.name = 'Impacts';
    parent.add(this.mesh);
  }

  spawn(x: number, y: number, z: number, color: number, size: number): void {
    const i = this.next;
    this.next = (this.next + 1) % IMPACT_CAP;
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = z;
    this.size[i] = size;
    this.age[i] = 0;
    this.spin[i] = Math.random() * Math.PI;
    this.color[i] = color;
  }

  /** Age them and face them to `eye`. */
  tick(dt: number, eye: Vector3): void {
    let n = 0;
    for (let i = 0; i < IMPACT_CAP; i++) {
      if (this.age[i] >= 1) continue;
      this.age[i] = Math.min(1, this.age[i] + dt / 0.22);
      const t = this.age[i];
      tmpP.set(this.x[i], this.y[i], this.z[i]);
      tmpM.lookAt(eye, tmpP, UP);
      tmpQ.setFromRotationMatrix(tmpM);
      tmpQ.multiply(spinQ.setFromAxisAngle(Z_AXIS, this.spin[i]));
      // Pops big, then shrinks as it fades; never filling your view, and
      // dimmed when it goes off right beside you.
      const d = tmpP.distanceTo(eye);
      const s = Math.min(this.size[i], d * 0.45) * (t < 0.2 ? 0.6 + 2.4 * t : 1.08 - 0.5 * (t - 0.2));
      const near = Math.min(1, Math.max(0.15, (d - 0.8) / 2.5));
      tmpS.set(s, s, s);
      this.mesh.setMatrixAt(n, tmpM.compose(tmpP, tmpQ, tmpS));
      this.mesh.setColorAt(n, tmpC.set(this.color[i]).lerp(WHITE, 0.5 * (1 - t)).multiplyScalar(1.8 * near * (1 - t) * (1 - t)));
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  clear(): void {
    this.age.fill(1);
    this.mesh.count = 0;
  }
}

// ------------------------------------------------------------- bolts ---

export const BOLT_CAP = 700;

/** Flying projectiles: icicles at the nearest, compass shards every way. */
export class Bolts {
  readonly mesh: InstancedMesh;
  n = 0;
  readonly x = new Float32Array(BOLT_CAP);
  readonly y = new Float32Array(BOLT_CAP);
  readonly z = new Float32Array(BOLT_CAP);
  readonly vx = new Float32Array(BOLT_CAP);
  readonly vz = new Float32Array(BOLT_CAP);
  readonly life = new Float32Array(BOLT_CAP);
  readonly dmg = new Float32Array(BOLT_CAP);
  readonly radius = new Float32Array(BOLT_CAP);
  readonly pierce = new Int16Array(BOLT_CAP);
  /** Seconds before it can hit again (it passes through what it just hit). */
  readonly cool = new Float32Array(BOLT_CAP);
  readonly color = new Uint32Array(BOLT_CAP);
  /** A streak of light behind each one. */
  readonly trail: InstancedMesh;
  /** A soft glow round each one, always facing you: they shine like magic ice. */
  readonly halo: InstancedMesh;

  constructor(parent: Group) {
    // A long faceted crystal of ice: a white core inside a coloured shell.
    const b = new GeometryBuilder();
    b.add(new OctahedronGeometry(1, 0), placed(0, 0, 0.1, 0, 0.075, 0.075, 0.42), new Color(1, 1, 1));
    b.add(new OctahedronGeometry(1, 0), placed(0, 0, 0.12, 0, 0.035, 0.035, 0.36), new Color(2.4, 2.4, 2.4));
    this.mesh = new InstancedMesh(b.build(), new MeshBasicMaterial({ vertexColors: true, toneMapped: false }), BOLT_CAP);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.setColorAt(0, tmpC.set(0xffffff));
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'Bolts';
    parent.add(this.mesh);
    this.trail = new InstancedMesh(streakGeometry(0.16), additive({ vertexColors: true }), BOLT_CAP);
    this.trail.instanceMatrix.setUsage(DynamicDrawUsage);
    this.trail.setColorAt(0, tmpC.set(0xffffff));
    this.trail.count = 0;
    this.trail.frustumCulled = false;
    this.trail.renderOrder = 5;
    this.trail.name = 'BoltTrails';
    parent.add(this.trail);
    this.halo = new InstancedMesh(new PlaneGeometry(1, 1), additive({ map: sharedFlare() }), BOLT_CAP);
    this.halo.instanceMatrix.setUsage(DynamicDrawUsage);
    this.halo.setColorAt(0, tmpC.set(0xffffff));
    this.halo.count = 0;
    this.halo.frustumCulled = false;
    this.halo.renderOrder = 6;
    this.halo.name = 'BoltHalos';
    parent.add(this.halo);
  }

  fire(x: number, y: number, z: number, dirX: number, dirZ: number, speed: number, dmg: number, radius: number, pierce: number, life: number, color: number): void {
    if (this.n >= BOLT_CAP) return;
    const i = this.n++;
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = z;
    this.vx[i] = dirX * speed;
    this.vz[i] = dirZ * speed;
    this.life[i] = life;
    this.dmg[i] = dmg;
    this.radius[i] = radius;
    this.pierce[i] = pierce;
    this.cool[i] = 0;
    this.color[i] = color;
  }

  /** Remove bolt i (swap the last one into its place). */
  remove(i: number): void {
    const j = --this.n;
    if (i === j) return;
    this.x[i] = this.x[j];
    this.y[i] = this.y[j];
    this.z[i] = this.z[j];
    this.vx[i] = this.vx[j];
    this.vz[i] = this.vz[j];
    this.life[i] = this.life[j];
    this.dmg[i] = this.dmg[j];
    this.radius[i] = this.radius[j];
    this.pierce[i] = this.pierce[j];
    this.cool[i] = this.cool[j];
    this.color[i] = this.color[j];
  }

  draw(): void {
    for (let i = 0; i < this.n; i++) {
      tmpP.set(this.x[i], this.y[i], this.z[i]);
      const heading = Math.atan2(this.vx[i], this.vz[i]);
      tmpQ.setFromAxisAngle(UP, heading);
      const s = this.radius[i] / 0.35;
      // A little roll as it flies, so its facets catch the light.
      tmpQ.multiply(spinQ.setFromAxisAngle(Z_AXIS, this.life[i] * 14));
      tmpS.set(s, s, s);
      this.mesh.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS));
      this.mesh.setColorAt(i, tmpC.set(this.color[i]).multiplyScalar(1.5));
      // The streak, as long as a few frames of its flight, fading as it dies.
      tmpQ.setFromAxisAngle(UP, heading);
      const speed = Math.hypot(this.vx[i], this.vz[i]);
      tmpS.set(s, s, Math.min(1.6, speed * 0.05) * s);
      this.trail.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS));
      const fade = Math.min(1, this.life[i] * 4);
      this.trail.setColorAt(i, tmpC.set(this.color[i]).multiplyScalar(1.3 * fade));
      // The glow: a little twinkle so a volley glitters as it flies.
      const g = s * (0.55 + 0.08 * Math.sin(this.life[i] * 40 + i));
      tmpS.set(g, g, g);
      this.halo.setMatrixAt(i, tmpM.compose(tmpP, billboard, tmpS));
      this.halo.setColorAt(i, tmpC.set(this.color[i]).multiplyScalar(0.75 * fade));
    }
    this.mesh.count = this.n;
    this.trail.count = this.n;
    this.halo.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.trail.instanceMatrix.needsUpdate = true;
    this.halo.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    if (this.trail.instanceColor) this.trail.instanceColor.needsUpdate = true;
    if (this.halo.instanceColor) this.halo.instanceColor.needsUpdate = true;
  }
}

// ------------------------------------------------------------ boulders ---

const HURL_CAP = 48;
const GRAVITY = 9.8;

/**
 * Ice boulders the titans (and later the brutes) lob at you: a glowing rock
 * on a high arc, with a red ring on the snow where it will come down, so you
 * can see it coming and pole out of the way.
 */
export class Hurls {
  readonly rock: InstancedMesh;
  readonly ring: InstancedMesh;
  n = 0;
  readonly x = new Float32Array(HURL_CAP);
  readonly y = new Float32Array(HURL_CAP);
  readonly z = new Float32Array(HURL_CAP);
  readonly vx = new Float32Array(HURL_CAP);
  readonly vy = new Float32Array(HURL_CAP);
  readonly vz = new Float32Array(HURL_CAP);
  /** Where it lands, its flight time and time flown, and its damage. */
  readonly tx = new Float32Array(HURL_CAP);
  readonly tz = new Float32Array(HURL_CAP);
  readonly flight = new Float32Array(HURL_CAP);
  readonly age = new Float32Array(HURL_CAP);
  readonly dmg = new Float32Array(HURL_CAP);
  readonly size = new Float32Array(HURL_CAP);

  constructor(parent: Group) {
    this.rock = new InstancedMesh(
      new IcosahedronGeometry(0.3, 0),
      new MeshBasicMaterial({ color: new Color(1.5, 0.45, 0.25), toneMapped: false }),
      HURL_CAP,
    );
    this.rock.instanceMatrix.setUsage(DynamicDrawUsage);
    this.rock.count = 0;
    this.rock.frustumCulled = false;
    this.rock.name = 'IceBoulders';
    parent.add(this.rock);
    this.ring = new InstancedMesh(
      new RingGeometry(0.78, 1, 32).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ color: new Color(1.4, 0.15, 0.1), transparent: true, opacity: 0.75, depthWrite: false, side: DoubleSide, toneMapped: false }),
      HURL_CAP,
    );
    this.ring.instanceMatrix.setUsage(DynamicDrawUsage);
    this.ring.count = 0;
    this.ring.frustumCulled = false;
    this.ring.name = 'BoulderMarks';
    parent.add(this.ring);
  }

  /** Lob one from (x, y, z) to land on (tx, tz) after `flight` seconds. */
  throw(x: number, y: number, z: number, tx: number, tz: number, flight: number, dmg: number, size: number): boolean {
    if (this.n >= HURL_CAP) return false;
    const i = this.n++;
    const gy = duneHeight(tx, tz);
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = z;
    this.vx[i] = (tx - x) / flight;
    this.vz[i] = (tz - z) / flight;
    this.vy[i] = (gy - y + 0.5 * GRAVITY * flight * flight) / flight;
    this.tx[i] = tx;
    this.tz[i] = tz;
    this.flight[i] = flight;
    this.age[i] = 0;
    this.dmg[i] = dmg;
    this.size[i] = size;
    return true;
  }

  remove(i: number): void {
    const j = --this.n;
    if (i === j) return;
    for (const a of [this.x, this.y, this.z, this.vx, this.vy, this.vz, this.tx, this.tz, this.flight, this.age, this.dmg, this.size]) a[i] = a[j];
  }

  /** Fly them; returns nothing (the system checks `age >= flight` for landings). */
  move(dt: number): void {
    for (let i = 0; i < this.n; i++) {
      this.age[i] += dt;
      this.x[i] += this.vx[i] * dt;
      this.z[i] += this.vz[i] * dt;
      this.vy[i] -= GRAVITY * dt;
      this.y[i] += this.vy[i] * dt;
    }
  }

  draw(time: number): void {
    for (let i = 0; i < this.n; i++) {
      tmpP.set(this.x[i], this.y[i], this.z[i]);
      tmpQ.setFromAxisAngle(UP, time * 5 + i);
      const s = this.size[i];
      tmpS.set(s, s, s);
      this.rock.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS));
      // The landing mark tightens as it falls.
      const left = Math.max(0, 1 - this.age[i] / this.flight[i]);
      tmpP.set(this.tx[i], duneHeight(this.tx[i], this.tz[i]) + 0.06, this.tz[i]);
      tmpQ.identity();
      const r = (0.9 + 0.8 * left) * s;
      tmpS.set(r, 1, r);
      this.ring.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS));
    }
    this.rock.count = this.n;
    this.ring.count = this.n;
    this.rock.instanceMatrix.needsUpdate = true;
    this.ring.instanceMatrix.needsUpdate = true;
  }
}

// ------------------------------------------------------------ blades ---

export const BLADE_CAP = 30;

/**
 * An arc of light behind a sword, in the plane it sweeps: a ring sector from
 * the sword's angle back `span` radians (toward -X, the trailing side),
 * bright at the sword and fading behind, radii 0.3..1 (scaled to the tip).
 */
function sweepGeometry(span: number): BufferGeometry {
  const steps = 16;
  // Radii across the arc and their brightness: dark inside, a thin bright
  // band where the tips cut.
  const R = [0.55, 0.86, 0.97, 1.02];
  const B = [0, 0.18, 1, 0];
  const pos: number[] = [];
  const col: number[] = [];
  const at = (k: number, r: number): number[] => {
    const a = (-k / steps) * span;
    return [Math.sin(a) * r, 0, Math.cos(a) * r];
  };
  for (let k = 0; k < steps; k++) {
    const f0 = Math.pow(1 - k / steps, 1.8);
    const f1 = Math.pow(1 - (k + 1) / steps, 1.8);
    for (let j = 0; j < R.length - 1; j++) {
      const a0 = at(k, R[j]);
      const b0 = at(k, R[j + 1]);
      const a1 = at(k + 1, R[j]);
      const b1 = at(k + 1, R[j + 1]);
      for (const [v, c] of [
        [a0, B[j] * f0],
        [b0, B[j + 1] * f0],
        [b1, B[j + 1] * f1],
        [a0, B[j] * f0],
        [b1, B[j + 1] * f1],
        [a1, B[j] * f1],
      ] as [number[], number][]) {
        pos.push(v[0], v[1], v[2]);
        col.push(c, c, c);
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  return g;
}

/** Swords that spin round you: a blade, a guard and a grip, glowing gold, each sweeping an arc of light. */
export class Blades {
  readonly mesh: InstancedMesh;
  readonly sweep: InstancedMesh;
  /** A star of light riding each sword's tip. */
  readonly glint: InstancedMesh;
  private turn = 0;

  constructor(parent: Group) {
    const b = new GeometryBuilder();
    b.add(new BoxGeometry(0.07, 0.02, 0.9), placed(0, 0, 0.45), new Color(1.6, 1.5, 1.2));
    b.add(new ConeGeometry(0.05, 0.16, 4).rotateX(Math.PI / 2), placed(0, 0, 0.98), new Color(1.6, 1.5, 1.2));
    b.add(new BoxGeometry(0.3, 0.04, 0.05), placed(0, 0, 0), new Color(1.5, 1.0, 0.2));
    b.add(new CylinderGeometry(0.025, 0.025, 0.2, 6).rotateX(Math.PI / 2), placed(0, 0, -0.12), new Color(0.35, 0.18, 0.08));
    this.mesh = new InstancedMesh(b.build(), new MeshBasicMaterial({ vertexColors: true, toneMapped: false, side: DoubleSide }), BLADE_CAP);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'OrbitBlades';
    parent.add(this.mesh);
    this.sweep = new InstancedMesh(sweepGeometry(0.9), additive({ vertexColors: true }), BLADE_CAP);
    this.sweep.instanceMatrix.setUsage(DynamicDrawUsage);
    this.sweep.setColorAt(0, tmpC.set(0xffffff));
    this.sweep.count = 0;
    this.sweep.frustumCulled = false;
    this.sweep.renderOrder = 5;
    this.sweep.name = 'BladeSweeps';
    parent.add(this.sweep);
    this.glint = new InstancedMesh(new PlaneGeometry(1, 1), additive({ map: sharedFlare() }), BLADE_CAP);
    this.glint.instanceMatrix.setUsage(DynamicDrawUsage);
    this.glint.setColorAt(0, tmpC.set(0xffffff));
    this.glint.count = 0;
    this.glint.frustumCulled = false;
    this.glint.renderOrder = 6;
    this.glint.name = 'BladeGlints';
    parent.add(this.glint);
  }

  /** No swords out. */
  hide(): void {
    this.mesh.count = 0;
    this.sweep.count = 0;
    this.glint.count = 0;
  }

  /**
   * Lay out `count` swords on a circle round (x, y, z), pointing outward,
   * spun to `angle`, from instance `start` on (so two rings can share the
   * mesh). Returns the next free instance.
   */
  draw(
    count: number,
    x: number,
    y: number,
    z: number,
    radius: number,
    angle: number,
    size: number,
    start = 0,
    color = 0xffd36a,
    spin = 1,
  ): number {
    count = Math.min(count, BLADE_CAP - start);
    // Where the tips reach: the sword runs from 0.35 r out by its length.
    const tip = radius * 0.35 + size * radius * 0.75 * 1.06;
    this.turn += 0.016;
    for (let k = 0; k < count; k++) {
      tmpC.set(color).multiplyScalar(0.8);
      const a = angle + (k / count) * Math.PI * 2;
      const dx = Math.sin(a);
      const dz = Math.cos(a);
      tmpP.set(x + dx * radius * 0.35, y, z + dz * radius * 0.35);
      tmpQ.setFromAxisAngle(UP, a);
      tmpS.set(size, size, size * (radius * 0.75));
      this.mesh.setMatrixAt(start + k, tmpM.compose(tmpP, tmpQ, tmpS));
      // The arc behind it (mirrored when the ring spins the other way).
      tmpP.set(x, y, z);
      tmpS.set(tip * spin, 1, tip);
      this.sweep.setMatrixAt(start + k, tmpM.compose(tmpP, tmpQ, tmpS));
      this.sweep.setColorAt(start + k, tmpC);
      // The glint at the tip, turning and pulsing as it goes round.
      tmpP.set(x + dx * tip * 0.97, y, z + dz * tip * 0.97);
      const g = 0.42 * size * (0.8 + 0.35 * Math.sin(this.turn * 9 + k * 2.1));
      tmpS.set(g, g, g);
      tmpQ.copy(billboard).multiply(spinQ.setFromAxisAngle(Z_AXIS, this.turn * 3 + k));
      this.glint.setMatrixAt(start + k, tmpM.compose(tmpP, tmpQ, tmpS));
      this.glint.setColorAt(start + k, tmpC.set(color).lerp(WHITE, 0.4).multiplyScalar(1.1));
    }
    this.mesh.count = start + count;
    this.sweep.count = start + count;
    this.glint.count = start + count;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.sweep.instanceMatrix.needsUpdate = true;
    this.glint.instanceMatrix.needsUpdate = true;
    if (this.sweep.instanceColor) this.sweep.instanceColor.needsUpdate = true;
    if (this.glint.instanceColor) this.glint.instanceColor.needsUpdate = true;
    return start + count;
  }
}

// -------------------------------------------------------------- novas ---

/** A short open cylinder, bright at its foot and fading up (the shock wall). */
function wallGeometry(): BufferGeometry {
  const g = new CylinderGeometry(1, 1, 1, 48, 1, true).translate(0, 0.5, 0);
  const pos = g.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const c = Math.pow(1 - pos.getY(i), 2);
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = c;
  }
  g.setAttribute('color', new BufferAttribute(col, 3));
  return g;
}

/**
 * Frost blasts: a bright ring racing out over the snow, a wall of light
 * standing up from it and sinking as it goes, and a flash on the ground
 * where it started.
 */
/** Ice spikes each nova throws up along its front. */
const NOVA_SPIKES = 30;
const NOVA_POOL = 14;

/** A cheap repeatable 0..1 for spike k (its own height, lean and gap). */
function spikeRnd(k: number): number {
  const v = Math.sin(k * 12.9898) * 43758.5453;
  return v - Math.floor(v);
}

/** An ice spike: a faceted cone, its base at the origin, pale at the foot and white-hot at the point. */
function spikeGeometry(): BufferGeometry {
  const g = new ConeGeometry(0.11, 1, 5, 1).translate(0, 0.5, 0).toNonIndexed();
  const pos = g.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const c = 0.55 + 0.9 * pos.getY(i);
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = c;
  }
  g.setAttribute('color', new BufferAttribute(col, 3));
  return g;
}

export class Novas {
  private readonly rings: { ring: Mesh; wall: Mesh; flash: Mesh; t: number; r: number; x: number; y: number; z: number; color: number }[] = [];
  /** Spikes of ice bursting up out of the snow along every ring's front. */
  private readonly spikes: InstancedMesh;

  constructor(parent: Group) {
    const wallGeo = wallGeometry();
    const ringGeo = new RingGeometry(0.82, 1, 64).rotateX(-Math.PI / 2);
    const flashGeo = new PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    const flashTex = flareTexture();
    for (let k = 0; k < 14; k++) {
      const ring = new Mesh(ringGeo, additive());
      const wall = new Mesh(wallGeo, additive({ vertexColors: true }));
      const flash = new Mesh(flashGeo, additive({ map: flashTex }));
      for (const m of [ring, wall, flash]) {
        m.visible = false;
        m.renderOrder = 4;
        parent.add(m);
      }
      ring.name = 'Nova';
      this.rings.push({ ring, wall, flash, t: 1, r: 1, x: 0, y: 0, z: 0, color: 0xffffff });
    }
    this.spikes = new InstancedMesh(
      spikeGeometry(),
      new MeshBasicMaterial({ vertexColors: true, toneMapped: false, transparent: true, opacity: 0.92 }),
      NOVA_SPIKES * NOVA_POOL,
    );
    this.spikes.instanceMatrix.setUsage(DynamicDrawUsage);
    this.spikes.setColorAt(0, tmpC.set(0xffffff));
    this.spikes.count = 0;
    this.spikes.frustumCulled = false;
    this.spikes.name = 'NovaSpikes';
    parent.add(this.spikes);
  }

  burst(x: number, z: number, radius: number, color: number): void {
    const n = this.rings.find((r) => r.t >= 1) ?? this.rings[0];
    n.t = 0;
    n.r = radius;
    const y = 0.06 + duneHeight(x, z);
    n.x = x;
    n.y = y;
    n.z = z;
    n.color = color;
    for (const m of [n.ring, n.wall, n.flash]) {
      m.position.set(x, y, z);
      (m.material as MeshBasicMaterial).color.set(color).multiplyScalar(1.6);
      m.visible = true;
    }
    n.flash.position.y += 0.02;
  }

  tick(dt: number): void {
    let spikes = 0;
    for (const n of this.rings) {
      if (n.t >= 1) continue;
      n.t = Math.min(1, n.t + dt / 0.5);
      spikes = this.placeSpikes(n, spikes);
      const t = n.t;
      const e = 1 - Math.pow(1 - t, 3);
      const r = Math.max(0.01, n.r * e);
      n.ring.scale.setScalar(r);
      (n.ring.material as MeshBasicMaterial).opacity = 1 - t;
      // The wall stands tallest early and sinks as it spreads.
      n.wall.scale.set(r, Math.max(0.01, Math.min(0.7, 0.3 + 0.06 * n.r) * (1 - t) * (1 - t)), r);
      (n.wall.material as MeshBasicMaterial).opacity = 0.45 * (1 - t);
      n.flash.scale.setScalar(Math.max(0.01, 0.4 * n.r * (0.6 + 0.6 * e)));
      (n.flash.material as MeshBasicMaterial).opacity = Math.max(0, 1 - t * 2.5);
      if (t >= 1) {
        n.ring.visible = false;
        n.wall.visible = false;
        n.flash.visible = false;
      }
    }
    this.spikes.count = spikes;
    if (spikes > 0) {
      this.spikes.instanceMatrix.needsUpdate = true;
      if (this.spikes.instanceColor) this.spikes.instanceColor.needsUpdate = true;
    }
  }

  /**
   * A crown of ice spikes riding a ring's front: they burst up as it sets
   * off, leaning outward, and sink back into the snow as it spreads.
   */
  private placeSpikes(n: { t: number; r: number; x: number; y: number; z: number; color: number }, at: number): number {
    const t = n.t;
    const e = 1 - Math.pow(1 - t, 3);
    const grow = Math.min(1, t / 0.12);
    const sink = Math.pow(1 - t, 1.6);
    const tall = Math.min(1.4, 0.45 + 0.07 * n.r);
    tmpC.set(n.color).lerp(WHITE, 0.45).multiplyScalar(1.25);
    for (let k = 0; k < NOVA_SPIKES; k++) {
      const r1 = spikeRnd(k);
      const r2 = spikeRnd(k + 37);
      const a = (k / NOVA_SPIKES) * Math.PI * 2 + (r1 - 0.5) * 0.18;
      const rr = Math.max(0.05, n.r * e * (0.9 + 0.1 * r2));
      const h = tall * (0.55 + 0.45 * r2) * grow * sink;
      if (h < 0.01) continue;
      tmpP.set(n.x + Math.sin(a) * rr, n.y - 0.05, n.z + Math.cos(a) * rr);
      tmpQ.setFromEuler(tmpE.set(0.3 + 0.35 * r1, a, (r2 - 0.5) * 0.4, 'YXZ'));
      const w = 0.7 + 0.6 * r1;
      tmpS.set(w, h, w);
      this.spikes.setMatrixAt(at, tmpM.compose(tmpP, tmpQ, tmpS));
      this.spikes.setColorAt(at, tmpC);
      at++;
    }
    return at;
  }
}

// ------------------------------------------------------------ lightning ---

const ZAP_CAP = 96;

/** Vertices per bolt: 6 pieces x 2 layers (core, glow) x 2 crossed quads x 6. */
const ZAP_VERTS = 6 * 2 * 2 * 6;

/**
 * Jagged bolts between enemies, flickering out in a blink. Each is a chain
 * of crossed ribbons (one upright, one flat, so it reads from any side): a
 * thin white-hot core inside a wider glow in the bolt's colour, re-jagged
 * every frame so it crackles.
 */
export class Zaps {
  private readonly mesh: Mesh;
  private readonly pos = new Float32Array(ZAP_CAP * ZAP_VERTS * 3);
  private readonly col = new Float32Array(ZAP_CAP * ZAP_VERTS * 3);
  private readonly age = new Float32Array(ZAP_CAP);
  private readonly seg = new Float32Array(ZAP_CAP * 6);
  private readonly pts = new Float32Array(7 * 3);
  private readonly glow = new Color(1.0, 0.95, 0.45);
  private n = 0;

  constructor(parent: Group) {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage));
    geo.setAttribute('color', new BufferAttribute(this.col, 3).setUsage(DynamicDrawUsage));
    this.mesh = new Mesh(geo, additive({ vertexColors: true }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.mesh.name = 'Lightning';
    parent.add(this.mesh);
  }

  /** The glow's colour (the core stays white). */
  setColor(hex: number): void {
    this.glow.set(hex);
  }

  zap(ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
    const i = this.n < ZAP_CAP ? this.n++ : Math.floor(Math.random() * ZAP_CAP);
    this.seg.set([ax, ay, az, bx, by, bz], i * 6);
    this.age[i] = 0;
  }

  tick(dt: number): void {
    let w = 0;
    let v = 0;
    const P = this.pts;
    for (let i = 0; i < this.n; i++) {
      this.age[i] += dt;
      if (this.age[i] > 0.2) continue;
      if (w !== i) {
        this.seg.copyWithin(w * 6, i * 6, i * 6 + 6);
        this.age[w] = this.age[i];
      }
      const o = w * 6;
      const fade = 1 - this.age[w] / 0.2;
      // Six jagged pieces, jag biggest in the middle.
      const len = Math.hypot(this.seg[o + 3] - this.seg[o], this.seg[o + 5] - this.seg[o + 2]);
      for (let k = 0; k <= 6; k++) {
        const t = k / 6;
        const j = k === 0 || k === 6 ? 0 : Math.min(0.6, 0.12 + len * 0.06) * Math.sin(t * Math.PI);
        P[k * 3] = this.seg[o] + (this.seg[o + 3] - this.seg[o]) * t + (Math.random() - 0.5) * j;
        P[k * 3 + 1] = this.seg[o + 1] + (this.seg[o + 4] - this.seg[o + 1]) * t + (Math.random() - 0.5) * j;
        P[k * 3 + 2] = this.seg[o + 2] + (this.seg[o + 5] - this.seg[o + 2]) * t + (Math.random() - 0.5) * j;
      }
      for (let k = 0; k < 6; k++) {
        const ax = P[k * 3];
        const ay = P[k * 3 + 1];
        const az = P[k * 3 + 2];
        const bx = P[k * 3 + 3];
        const by = P[k * 3 + 4];
        const bz = P[k * 3 + 5];
        // Across the piece, flat: perpendicular in the ground plane.
        let sx = -(bz - az);
        let sz = bx - ax;
        const sl = Math.hypot(sx, sz) || 1;
        sx /= sl;
        sz /= sl;
        for (let layer = 0; layer < 2; layer++) {
          const half = layer === 0 ? 0.19 : 0.04;
          const r = layer === 0 ? this.glow.r * 0.9 * fade : 2.4 * fade;
          const g = layer === 0 ? this.glow.g * 0.9 * fade : 2.4 * fade;
          const b = layer === 0 ? this.glow.b * 0.9 * fade : 2.2 * fade;
          for (let q = 0; q < 2; q++) {
            const ox = q === 0 ? 0 : sx * half;
            const oy = q === 0 ? half : 0;
            const oz = q === 0 ? 0 : sz * half;
            const quad = [
              ax + ox, ay + oy, az + oz,
              ax - ox, ay - oy, az - oz,
              bx - ox, by - oy, bz - oz,
              ax + ox, ay + oy, az + oz,
              bx - ox, by - oy, bz - oz,
              bx + ox, by + oy, bz + oz,
            ];
            this.pos.set(quad, v * 3);
            for (let c = 0; c < 6; c++) {
              this.col[(v + c) * 3] = r;
              this.col[(v + c) * 3 + 1] = g;
              this.col[(v + c) * 3 + 2] = b;
            }
            v += 6;
          }
        }
      }
      w++;
    }
    this.n = w;
    const geo = this.mesh.geometry;
    geo.setDrawRange(0, v);
    (geo.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (geo.getAttribute('color') as BufferAttribute).needsUpdate = true;
    this.mesh.visible = v > 0;
  }
}

// ------------------------------------------------------------ crystals ---

export const GEM_CAP = 1800;

/**
 * Experience crystals: blue, green, red by worth. They hop out of whatever
 * died, bounce once on the snow and sit there spinning until you come
 * within your magnet, then spiral in to you.
 */
export class Gems {
  readonly mesh: InstancedMesh;
  n = 0;
  readonly x = new Float32Array(GEM_CAP);
  readonly z = new Float32Array(GEM_CAP);
  readonly y = new Float32Array(GEM_CAP);
  readonly value = new Float32Array(GEM_CAP);
  /** Flying to you (once inside the magnet it never lets go). */
  readonly pulled = new Uint8Array(GEM_CAP);
  /** In the air (hopping out of a kill or flung from a fountain), and its flight. */
  readonly air = new Uint8Array(GEM_CAP);
  readonly vx = new Float32Array(GEM_CAP);
  readonly vy = new Float32Array(GEM_CAP);
  readonly vz = new Float32Array(GEM_CAP);

  constructor(parent: Group) {
    this.mesh = new InstancedMesh(new OctahedronGeometry(0.11, 0), new MeshBasicMaterial({ toneMapped: false }), GEM_CAP);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.setColorAt(0, tmpC.set(0xffffff));
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'Crystals';
    parent.add(this.mesh);
  }

  /** A crystal hops out of (x, z) and lands nearby. */
  drop(x: number, z: number, value: number): void {
    const a = Math.random() * Math.PI * 2;
    const out = 0.6 + Math.random() * 1.2;
    this.fling(x, 0.6 + duneHeight(x, z), z, value, Math.cos(a) * out, 2.6 + Math.random() * 1.8, Math.sin(a) * out);
  }

  /** A crystal thrown from (x, y, z) with velocity (vx, vy, vz). */
  fling(x: number, y: number, z: number, value: number, vx: number, vy: number, vz: number): void {
    if (this.n >= GEM_CAP) {
      // Full: fold it into the oldest crystal instead of losing it.
      this.value[0] += value;
      return;
    }
    const i = this.n++;
    this.x[i] = x;
    this.z[i] = z;
    this.y[i] = y;
    this.value[i] = value;
    this.pulled[i] = 0;
    this.air[i] = 1;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
  }

  /** Fly the airborne ones: arc, a bounce, then rest. */
  tick(dt: number): void {
    for (let i = 0; i < this.n; i++) {
      if (!this.air[i] || this.pulled[i]) continue;
      this.vy[i] -= 11 * dt;
      this.x[i] += this.vx[i] * dt;
      this.z[i] += this.vz[i] * dt;
      this.y[i] += this.vy[i] * dt;
      const floor = 0.35 + duneHeight(this.x[i], this.z[i]);
      if (this.y[i] < floor && this.vy[i] < 0) {
        this.y[i] = floor;
        if (this.vy[i] < -2.2) {
          this.vy[i] *= -0.32;
          this.vx[i] *= 0.5;
          this.vz[i] *= 0.5;
        } else {
          this.air[i] = 0;
        }
      }
    }
  }

  remove(i: number): void {
    const j = --this.n;
    if (i === j) return;
    this.x[i] = this.x[j];
    this.z[i] = this.z[j];
    this.y[i] = this.y[j];
    this.value[i] = this.value[j];
    this.pulled[i] = this.pulled[j];
    this.air[i] = this.air[j];
    this.vx[i] = this.vx[j];
    this.vy[i] = this.vy[j];
    this.vz[i] = this.vz[j];
  }

  draw(time: number): void {
    for (let i = 0; i < this.n; i++) {
      const v = this.value[i];
      const s = v >= 20 ? 2.1 : v >= 4 ? 1.5 : 1;
      const bob = this.air[i] || this.pulled[i] ? 0 : Math.sin(time * 3 + i) * 0.06;
      tmpP.set(this.x[i], this.y[i] + bob, this.z[i]);
      // Spinning, and faster still in flight.
      tmpQ.setFromAxisAngle(UP, time * (this.air[i] || this.pulled[i] ? 14 : 2) + i);
      tmpS.set(s, s * 1.4, s);
      this.mesh.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS));
      this.mesh.setColorAt(i, tmpC.set(v >= 20 ? 0xff4060 : v >= 4 ? 0x40ff90 : 0x40b8ff).multiplyScalar(1.5));
    }
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

// --------------------------------------------------------- upgrade orbs ---

/** A floating label: the upgrade's name in the run's lettering (no pill behind it), always facing you. */
function labelSprite(text: string, color: string): Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 160;
  const ctx = canvas.getContext('2d')!;
  ctx.textAlign = 'center';
  const name = text.toUpperCase();
  const size = fitLettering(ctx, name, 430, 76, 28);
  drawLettering(ctx, name, 256, 80 + size * 0.36, size, color.length === 7 ? color : '#ffd166');
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const sprite = new Sprite(new SpriteMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false }));
  sprite.scale.set(1.2, 0.375, 1);
  return sprite;
}

export interface Orb {
  root: Object3D;
  gem: Mesh;
  label: Sprite;
  x: number;
  z: number;
  upgradeId: string;
  active: boolean;
  age: number;
}

/** Glowing upgrade orbs on the snow, each named, waiting for you to walk into them. */
export class Orbs {
  readonly list: Orb[] = [];
  private readonly parent: Group;
  private readonly geo = new IcosahedronGeometry(0.28, 0);

  constructor(parent: Group) {
    this.parent = parent;
  }

  drop(x: number, z: number, upgradeId: string, name: string, color: string): void {
    let orb = this.list.find((o) => !o.active);
    if (!orb) {
      const root = new Object3D();
      const gem = new Mesh(this.geo, new MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 1.4, roughness: 0.3, flatShading: true }));
      root.add(gem);
      const label = labelSprite('', '#fff');
      root.add(label);
      this.parent.add(root);
      orb = { root, gem, label, x, z, upgradeId, active: true, age: 0 };
      this.list.push(orb);
    }
    // A fresh label for this upgrade.
    const old = orb.label;
    orb.root.remove(old);
    old.material.map?.dispose();
    old.material.dispose();
    orb.label = labelSprite(name, color);
    orb.label.position.y = 0.7;
    orb.root.add(orb.label);
    (orb.gem.material as MeshStandardMaterial).color.set(color);
    (orb.gem.material as MeshStandardMaterial).emissive.set(color);
    orb.x = x;
    orb.z = z;
    orb.upgradeId = upgradeId;
    orb.active = true;
    orb.age = 0;
    orb.root.visible = true;
    orb.root.position.set(x, 0.8 + duneHeight(x, z), z);
  }

  tick(dt: number, time: number): void {
    for (const orb of this.list) {
      if (!orb.active) continue;
      orb.age += dt;
      orb.root.position.set(orb.x, 0.8 + duneHeight(orb.x, orb.z) + Math.sin(time * 2.4 + orb.x) * 0.12, orb.z);
      orb.gem.rotation.y = time * 1.6;
      orb.gem.rotation.x = time * 0.9;
      orb.gem.scale.setScalar(Math.min(1, orb.age * 3) * (1 + 0.1 * Math.sin(time * 6)));
    }
  }

  take(orb: Orb): void {
    orb.active = false;
    orb.root.visible = false;
  }

  clear(): void {
    for (const orb of this.list) this.take(orb);
  }
}

// --------------------------------------------------------------- chests ---

export interface Chest {
  root: Object3D;
  lid: Object3D;
  beam: Mesh;
  x: number;
  z: number;
  active: boolean;
  opening: number;
  /** Snow height where it stands. */
  ground: number;
  /** Upgrade picks inside: 1, or 2 for a boss's hoard. */
  picks: number;
}

/** Treasure chests with a pillar of light over them: walk into one for a burst of upgrades. */
export class Chests {
  readonly list: Chest[] = [];

  constructor(parent: Group) {
    // Three for ordinary chests, and room kept for bosses' hoards.
    for (let k = 0; k < 6; k++) {
      const root = new Object3D();
      const wood = new MeshStandardMaterial({ color: 0x7a4a26, roughness: 0.8 });
      const gold = new MeshStandardMaterial({ color: 0xffc94a, emissive: 0xffaa00, emissiveIntensity: 0.6, metalness: 0.6, roughness: 0.35 });
      const body = new Mesh(new BoxGeometry(0.9, 0.55, 0.6), wood);
      body.position.y = 0.275;
      root.add(body);
      const band = new Mesh(new BoxGeometry(0.94, 0.08, 0.64), gold);
      band.position.y = 0.4;
      root.add(band);
      const lid = new Object3D();
      lid.position.set(0, 0.55, -0.3);
      const lidMesh = new Mesh(new CylinderGeometry(0.3, 0.3, 0.9, 10, 1, false, 0, Math.PI).rotateZ(Math.PI / 2), wood);
      lidMesh.position.z = 0.3;
      lid.add(lidMesh);
      const lock = new Mesh(new BoxGeometry(0.12, 0.16, 0.06), gold);
      lock.position.set(0, 0.05, 0.62);
      lid.add(lock);
      root.add(lid);
      const beam = new Mesh(
        new CylinderGeometry(0.35, 0.9, 40, 16, 1, true),
        new MeshBasicMaterial({ color: new Color(1.4, 1.1, 0.4), transparent: true, opacity: 0.22, blending: AdditiveBlending, depthWrite: false, side: DoubleSide, toneMapped: false, fog: false }),
      );
      beam.position.y = 20;
      root.add(beam);
      root.visible = false;
      root.name = 'Chest';
      parent.add(root);
      this.list.push({ root, lid, beam, x: 0, z: 0, active: false, opening: -1, ground: 0, picks: 1 });
    }
  }

  /** A chest at (x, z) with `picks` upgrades in it (a boss's hoard is bigger, under a red-gold pillar). */
  place(x: number, z: number, picks = 1): boolean {
    if (picks === 1 && this.list.filter((c) => c.active && c.picks === 1).length >= 3) return false;
    const chest = this.list.find((c) => !c.active && c.opening < 0);
    if (!chest) return false;
    chest.picks = picks;
    chest.root.scale.setScalar(picks > 1 ? 1.45 : 1);
    (chest.beam.material as MeshBasicMaterial).color.setRGB(1.4, picks > 1 ? 0.55 : 1.1, picks > 1 ? 0.3 : 0.4);
    chest.x = x;
    chest.z = z;
    chest.active = true;
    chest.opening = -1;
    chest.ground = duneHeight(x, z);
    chest.root.position.set(x, chest.ground, z);
    chest.root.rotation.y = Math.random() * Math.PI * 2;
    chest.lid.rotation.x = 0;
    chest.beam.visible = true;
    chest.root.visible = true;
    return true;
  }

  tick(dt: number, time: number): void {
    for (const chest of this.list) {
      if (!chest.root.visible) continue;
      (chest.beam.material as MeshBasicMaterial).opacity = 0.16 + 0.08 * Math.sin(time * 3);
      if (chest.opening >= 0) {
        // The lid flies open, then the chest sinks away.
        chest.opening += dt;
        chest.lid.rotation.x = -Math.min(1.9, chest.opening * 7);
        chest.beam.visible = false;
        if (chest.opening > 1.6) {
          chest.root.position.y = chest.ground - (chest.opening - 1.6) * 1.5;
          if (chest.opening > 2.4) {
            chest.root.visible = false;
            chest.opening = -1;
          }
        }
      }
    }
  }

  open(chest: Chest): void {
    chest.active = false;
    chest.opening = 0;
  }

  clear(): void {
    for (const chest of this.list) {
      chest.active = false;
      chest.opening = -1;
      chest.root.visible = false;
    }
  }
}
