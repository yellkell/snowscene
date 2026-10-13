/**
 * Snow Survivors' fire, drawn (the survivors system owns the rules; these
 * hold what moves on its own and draw it, pooled and instanced):
 *
 * - Embers: one particle system for every spark of fire in the run (a jet
 *   of breath, a burning trail, a burning enemy, a firework's burst, a
 *   comet's tail): soft glowing points that rise, flicker and burn down
 *   from white through orange to red and out.
 * - Flames: tongues of fire standing on the snow (the ember trail), each a
 *   flickering billboard turned to face you.
 * - Breath: the jet of flame itself, a cone of churning fire.
 * - Rockets: fireworks climbing on a sparkling trail, then diving.
 * - Comets: burning rocks falling out of the sky on a long tail, a ring on
 *   the snow where each will strike.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  CanvasTexture,
  Color,
  ConeGeometry,
  DoubleSide,
  DynamicDrawUsage,
  type Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Points,
  Quaternion,
  RingGeometry,
  ShaderMaterial,
  SRGBColorSpace,
  BufferGeometry,
  Vector3,
} from '@iwsdk/core';
import { GeometryBuilder, placed } from '../mesh-utils.js';
import { additive, fx, streakGeometry } from './survivors-fx.js';
import { duneHeight } from './survivors-level.js';

const tmpM = new Matrix4();
const tmpQ = new Quaternion();
const tmpS = new Vector3();
const tmpP = new Vector3();
const tmpV = new Vector3();
const tmpC = new Color();
const UP = new Vector3(0, 1, 0);
const tmpQ2 = new Quaternion();
const Z_AXIS = new Vector3(0, 0, 1);

function instanced(geo: BufferGeometry, material: MeshBasicMaterial, cap: number, name: string, parent: Group): InstancedMesh {
  const mesh = new InstancedMesh(geo, material, cap);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.setColorAt(0, tmpC.set(0xffffff));
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.name = name;
  parent.add(mesh);
  return mesh;
}

// ------------------------------------------------------------- embers ---

const EMBER_CAP = 2400;

const EMBER_VERT = /* glsl */ `
attribute float aSize;
attribute float aHeat;
uniform float uViewH;
varying float vHeat;
varying vec3 vTint;
varying float vNear;
attribute vec3 aTint;
void main() {
  vHeat = aHeat;
  vTint = aTint;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float depth = max(0.05, -mv.z);
  // Never a screenful: capped in pixels, and gone when right at your eyes.
  gl_PointSize = min(aSize * projectionMatrix[1][1] * uViewH * 0.5 / depth, 30.0);
  vNear = smoothstep(0.8, 2.2, depth);
}
`;
const EMBER_FRAG = /* glsl */ `
uniform float uGain;
varying float vHeat;
varying vec3 vTint;
varying float vNear;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  if (d > 1.0) discard;
  float core = 1.0 - smoothstep(0.0, 1.0, d);
  // Fire: white-hot, through yellow and orange to deep red as it cools.
  vec3 hot = mix(vec3(0.9, 0.12, 0.02), vec3(1.0, 0.55, 0.08), smoothstep(0.15, 0.5, vHeat));
  hot = mix(hot, vec3(1.0, 0.82, 0.45), smoothstep(0.7, 1.0, vHeat));
  // A tinted spark (fireworks) keeps its colour, whitening at the core.
  vec3 col = mix(hot, vTint, step(0.001, dot(vTint, vec3(1.0))));
  col = mix(col, vec3(1.0), core * core * 0.22 * vHeat);
  // Under the glow budget, but never below half: fire is the point of fire.
  float a = core * smoothstep(0.0, 0.25, vHeat) * vNear * (0.5 + 0.5 * uGain);
  gl_FragColor = vec4(col * (1.0 + 0.6 * vHeat), a);
}
`;

/** Every spark of fire in the run, rising, flickering and burning down. */
export class Embers {
  private readonly points: Points;
  private readonly pos = new Float32Array(EMBER_CAP * 3);
  private readonly vel = new Float32Array(EMBER_CAP * 3);
  private readonly life = new Float32Array(EMBER_CAP);
  private readonly maxLife = new Float32Array(EMBER_CAP);
  private readonly base = new Float32Array(EMBER_CAP);
  private readonly size = new Float32Array(EMBER_CAP);
  private readonly heat = new Float32Array(EMBER_CAP);
  private readonly tint = new Float32Array(EMBER_CAP * 3);
  /** Buoyancy: fire rises, firework sparks fall. */
  private readonly lift = new Float32Array(EMBER_CAP);
  private next = 0;
  private readonly material: ShaderMaterial;

  constructor(parent: Group) {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage));
    geo.setAttribute('aSize', new BufferAttribute(this.size, 1).setUsage(DynamicDrawUsage));
    geo.setAttribute('aHeat', new BufferAttribute(this.heat, 1).setUsage(DynamicDrawUsage));
    geo.setAttribute('aTint', new BufferAttribute(this.tint, 3).setUsage(DynamicDrawUsage));
    this.material = new ShaderMaterial({
      vertexShader: EMBER_VERT,
      fragmentShader: EMBER_FRAG,
      uniforms: { uViewH: { value: 900 }, uGain: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
    });
    this.points = new Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 7;
    this.points.name = 'Embers';
    parent.add(this.points);
  }

  /** Pixel height of the view (point sizes are in metres). */
  setViewHeight(h: number): void {
    this.material.uniforms.uViewH.value = h;
  }

  /**
   * One spark at (x, y, z) moving (vx, vy, vz) for `life` s, `size` m
   * across; `tint` a colour for a firework spark (0 for fire), `lift` how
   * hard it rises (negative falls).
   */
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, tint = 0, lift = 1.6): void {
    const i = this.next;
    this.next = (this.next + 1) % EMBER_CAP;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.life[i] = this.maxLife[i] = life;
    this.base[i] = size;
    this.lift[i] = lift;
    if (tint) {
      tmpC.set(tint);
      this.tint[i * 3] = tmpC.r;
      this.tint[i * 3 + 1] = tmpC.g;
      this.tint[i * 3 + 2] = tmpC.b;
    } else {
      this.tint[i * 3] = this.tint[i * 3 + 1] = this.tint[i * 3 + 2] = 0;
    }
  }

  /** Sparks alight this frame. */
  live = 0;

  tick(dt: number, time: number): void {
    const damp = Math.exp(-dt * 1.6);
    this.material.uniforms.uGain.value = fx.gain;
    let live = 0;
    for (let i = 0; i < EMBER_CAP; i++) {
      if (this.life[i] <= 0) {
        this.size[i] = 0;
        continue;
      }
      live++;
      this.life[i] -= dt;
      const t = Math.max(0, this.life[i] / this.maxLife[i]);
      const o = i * 3;
      this.vel[o] *= damp;
      this.vel[o + 2] *= damp;
      this.vel[o + 1] = this.vel[o + 1] * damp + this.lift[i] * dt * 2.2;
      // A little flutter side to side.
      const flutter = Math.sin(time * 9 + i * 1.7) * 0.25 * dt;
      this.pos[o] += this.vel[o] * dt + flutter;
      this.pos[o + 1] += this.vel[o + 1] * dt;
      this.pos[o + 2] += this.vel[o + 2] * dt - flutter;
      this.heat[i] = t * (0.85 + 0.15 * Math.sin(time * 30 + i));
      // Swells as it catches, shrinks as it cools.
      this.size[i] = this.base[i] * (t > 0.85 ? (1 - t) / 0.15 * 0.6 + 0.4 : 0.4 + 0.6 * t);
    }
    this.live = live;
    const geo = this.points.geometry;
    for (const name of ['position', 'aSize', 'aHeat', 'aTint']) (geo.getAttribute(name) as BufferAttribute).needsUpdate = true;
  }

  clear(): void {
    this.life.fill(0);
  }
}

// ------------------------------------------------------------- flames ---

/** A tongue of flame: hot white at the root, orange up through, licking to a point. */
function flameTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 128, 0, 0);
  g.addColorStop(0, 'rgba(255,250,220,1)');
  g.addColorStop(0.25, 'rgba(255,190,70,0.95)');
  g.addColorStop(0.6, 'rgba(255,90,20,0.75)');
  g.addColorStop(1, 'rgba(160,20,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(32, 2);
  ctx.bezierCurveTo(46, 40, 62, 70, 58, 100);
  ctx.bezierCurveTo(54, 122, 10, 122, 6, 100);
  ctx.bezierCurveTo(2, 70, 18, 40, 32, 2);
  ctx.fill();
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

const FLAME_CAP = 520;

/** Tongues of fire on the snow, each one a flickering billboard turned to face you. */
export class Flames {
  private readonly mesh: InstancedMesh;
  private n = 0;
  /** Tongues standing this frame. */
  get live(): number {
    return this.n;
  }

  constructor(parent: Group) {
    const geo = new PlaneGeometry(1, 2).translate(0, 1, 0);
    this.mesh = instanced(geo, additive({ map: flameTexture() }), FLAME_CAP, 'Flames', parent);
    this.mesh.renderOrder = 6;
  }

  /** Start a frame's flames. */
  begin(): void {
    this.n = 0;
  }

  /** One tongue at (x, y, z), `height` m tall, flickering on `phase`, at `strength` 0..1. */
  add(x: number, y: number, z: number, height: number, phase: number, strength: number, time: number, eye: Vector3): void {
    if (this.n >= FLAME_CAP) return;
    const flick = 0.75 + 0.25 * Math.sin(time * 13 + phase) + 0.12 * Math.sin(time * 29 + phase * 2.3);
    const h = height * flick * strength;
    tmpP.set(x, y, z);
    // Turned about the vertical to face you, swaying a little.
    tmpQ.setFromAxisAngle(UP, Math.atan2(eye.x - x, eye.z - z));
    tmpQ.multiply(tmpQ2.setFromAxisAngle(Z_AXIS, Math.sin(time * 5 + phase) * 0.15));
    tmpS.set(h * 0.45, h * 0.5, 1);
    this.mesh.setMatrixAt(this.n, tmpM.compose(tmpP, tmpQ, tmpS));
    this.mesh.setColorAt(this.n, tmpC.setRGB(1.3, 1.1, 1.0).multiplyScalar((0.6 + 0.6 * strength) * (0.55 + 0.45 * fx.gain)));
    this.n++;
  }

  end(): void {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

// ------------------------------------------------------------- breath ---

const BREATH_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const BREATH_FRAG = /* glsl */ `
uniform float uTime;
uniform float uAlpha;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  // v runs from the mouth (1) to the far end (0) of the cone.
  float along = 1.0 - vUv.y;
  float n = noise(vec2(vUv.x * 9.0, along * 5.0 - uTime * 7.0)) * 0.6 + noise(vec2(vUv.x * 21.0, along * 11.0 - uTime * 13.0)) * 0.4;
  float body = smoothstep(0.05, 0.3, along) * (1.0 - smoothstep(0.55, 1.0, along));
  float a = body * smoothstep(0.25, 0.75, n + 0.35 - along * 0.3) * uAlpha * 0.45;
  vec3 col = mix(vec3(1.0, 0.8, 0.45), vec3(1.0, 0.35, 0.05), smoothstep(0.1, 0.6, along));
  col = mix(col, vec3(0.6, 0.06, 0.02), smoothstep(0.7, 1.0, along));
  gl_FragColor = vec4(col, a);
}
`;

/** The jet of flame: a cone of churning fire from your chest out along a heading. */
export class Breath {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;

  constructor(parent: Group) {
    // A unit cone lying along +Z from its tip at the origin.
    const geo = new ConeGeometry(1, 1, 24, 1, true).rotateX(-Math.PI / 2).translate(0, 0, 0.5);
    this.material = new ShaderMaterial({
      vertexShader: BREATH_VERT,
      fragmentShader: BREATH_FRAG,
      uniforms: { uTime: { value: 0 }, uAlpha: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      toneMapped: false,
    });
    this.mesh = new Mesh(geo, this.material);
    this.mesh.visible = false;
    this.mesh.renderOrder = 6;
    this.mesh.name = 'FireBreath';
    parent.add(this.mesh);
  }

  /** Out from (x, y, z) along `yaw`, `length` long and `width` across at the end, at `alpha` (0 hides it). */
  draw(x: number, y: number, z: number, yaw: number, length: number, width: number, alpha: number, time: number): void {
    this.mesh.visible = alpha > 0.01;
    if (!this.mesh.visible) return;
    this.mesh.position.set(x, y, z);
    // The cone's +Z along the heading (yaw 0 faces -Z), tipped down a touch.
    this.mesh.rotation.set(0.08, yaw + Math.PI, 0, 'YXZ');
    this.mesh.scale.set(width, width * 0.7, length);
    this.material.uniforms.uTime.value = time;
    this.material.uniforms.uAlpha.value = alpha;
  }
}

// ------------------------------------------------------------ rockets ---

const ROCKET_CAP = 40;

/** Fireworks: up on a sparkling trail, then over and down onto a target. */
export class Rockets {
  n = 0;
  readonly x = new Float32Array(ROCKET_CAP);
  readonly y = new Float32Array(ROCKET_CAP);
  readonly z = new Float32Array(ROCKET_CAP);
  readonly vx = new Float32Array(ROCKET_CAP);
  readonly vy = new Float32Array(ROCKET_CAP);
  readonly vz = new Float32Array(ROCKET_CAP);
  readonly tx = new Float32Array(ROCKET_CAP);
  readonly tz = new Float32Array(ROCKET_CAP);
  readonly age = new Float32Array(ROCKET_CAP);
  readonly color = new Uint32Array(ROCKET_CAP);
  readonly dmg = new Float32Array(ROCKET_CAP);
  readonly radius = new Float32Array(ROCKET_CAP);
  /** Set when a rocket has burst (the system reads, then removes it). */
  readonly burst = new Uint8Array(ROCKET_CAP);
  private readonly body: InstancedMesh;
  private readonly trail: InstancedMesh;

  constructor(parent: Group) {
    const b = new GeometryBuilder();
    b.add(new ConeGeometry(0.06, 0.22, 6).rotateX(Math.PI / 2), placed(0, 0, 0.11), new Color(1.6, 1.4, 1.1));
    this.body = instanced(b.build(), new MeshBasicMaterial({ vertexColors: true, toneMapped: false }), ROCKET_CAP, 'Rockets', parent);
    this.trail = instanced(streakGeometry(0.16), additive({ vertexColors: true }), ROCKET_CAP, 'RocketTrails', parent);
  }

  launch(x: number, y: number, z: number, tx: number, tz: number, color: number, dmg: number, radius: number): void {
    if (this.n >= ROCKET_CAP) return;
    const i = this.n++;
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = z;
    // Straight up, a little out toward the target and a little wild.
    const dx = tx - x;
    const dz = tz - z;
    const d = Math.hypot(dx, dz) || 1;
    this.vx[i] = (dx / d) * 2 + (Math.random() - 0.5) * 2.5;
    this.vy[i] = 11 + Math.random() * 3;
    this.vz[i] = (dz / d) * 2 + (Math.random() - 0.5) * 2.5;
    this.tx[i] = tx;
    this.tz[i] = tz;
    this.age[i] = 0;
    this.color[i] = color;
    this.dmg[i] = dmg;
    this.radius[i] = radius;
    this.burst[i] = 0;
  }

  remove(i: number): void {
    const j = --this.n;
    if (i === j) return;
    for (const a of [this.x, this.y, this.z, this.vx, this.vy, this.vz, this.tx, this.tz, this.age, this.dmg, this.radius]) a[i] = a[j];
    this.color[i] = this.color[j];
    this.burst[i] = this.burst[j];
  }

  /** Climb, then steer harder and harder down onto the target; sparkle all the way. */
  move(dt: number, embers: Embers): void {
    for (let i = 0; i < this.n; i++) {
      if (this.burst[i]) continue;
      this.age[i] += dt;
      const gy = duneHeight(this.tx[i], this.tz[i]);
      if (this.age[i] > 0.45) {
        // Homing: steer the velocity toward the target, harder with time.
        tmpV.set(this.tx[i] - this.x[i], gy + 0.4 - this.y[i], this.tz[i] - this.z[i]);
        const d = tmpV.length() || 1;
        const speed = 16 + this.age[i] * 10;
        const k = Math.min(1, dt * (2 + this.age[i] * 6));
        this.vx[i] += ((tmpV.x / d) * speed - this.vx[i]) * k;
        this.vy[i] += ((tmpV.y / d) * speed - this.vy[i]) * k;
        this.vz[i] += ((tmpV.z / d) * speed - this.vz[i]) * k;
      } else {
        this.vy[i] -= 4 * dt;
      }
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      this.z[i] += this.vz[i] * dt;
      embers.emit(this.x[i], this.y[i], this.z[i], (Math.random() - 0.5) * 0.8, -0.5, (Math.random() - 0.5) * 0.8, 0.35 + Math.random() * 0.25, 0.09, Math.random() < 0.5 ? this.color[i] : 0, -0.6);
      const near = Math.hypot(this.tx[i] - this.x[i], this.tz[i] - this.z[i]) < 0.8 && this.y[i] < gy + 1.2;
      if (near || this.y[i] < gy + 0.1 || this.age[i] > 3) this.burst[i] = 1;
    }
  }

  draw(): void {
    for (let i = 0; i < this.n; i++) {
      tmpP.set(this.x[i], this.y[i], this.z[i]);
      tmpV.set(this.x[i] + this.vx[i], this.y[i] + this.vy[i], this.z[i] + this.vz[i]);
      tmpM.lookAt(tmpV, tmpP, UP);
      tmpQ.setFromRotationMatrix(tmpM);
      tmpS.set(1, 1, 1);
      this.body.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS));
      this.body.setColorAt(i, tmpC.setRGB(1, 1, 1));
      tmpS.set(1, 1, 1.4);
      this.trail.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS));
      this.trail.setColorAt(i, tmpC.set(this.color[i]).multiplyScalar(1.4 * (0.5 + 0.5 * fx.gain)));
    }
    for (const m of [this.body, this.trail]) {
      m.count = this.n;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  clear(): void {
    this.n = 0;
  }
}

// ------------------------------------------------------------- comets ---

const COMET_CAP = 12;
/** How high a comet starts, and how far off to one side. */
const COMET_HEIGHT = 34;
const COMET_SLANT = 14;

/** Burning rocks out of the sky on a long tail, a ring on the snow where each strikes. */
export class Comets {
  n = 0;
  readonly tx = new Float32Array(COMET_CAP);
  readonly tz = new Float32Array(COMET_CAP);
  readonly sx = new Float32Array(COMET_CAP);
  readonly sz = new Float32Array(COMET_CAP);
  readonly age = new Float32Array(COMET_CAP);
  readonly fall = new Float32Array(COMET_CAP);
  readonly dmg = new Float32Array(COMET_CAP);
  readonly radius = new Float32Array(COMET_CAP);
  readonly size = new Float32Array(COMET_CAP);
  private readonly rock: InstancedMesh;
  private readonly tail: InstancedMesh;
  private readonly ring: InstancedMesh;
  readonly at = new Vector3();

  constructor(parent: Group) {
    this.rock = instanced(new IcosahedronGeometry(0.5, 0), new MeshBasicMaterial({ toneMapped: false }), COMET_CAP, 'Comets', parent);
    this.tail = instanced(streakGeometry(1.1), additive({ vertexColors: true }), COMET_CAP, 'CometTails', parent);
    this.ring = instanced(new RingGeometry(0.88, 1, 48).rotateX(-Math.PI / 2), additive(), COMET_CAP, 'CometMarks', parent);
  }

  drop(tx: number, tz: number, fall: number, dmg: number, radius: number, size: number): void {
    if (this.n >= COMET_CAP) return;
    const i = this.n++;
    const a = Math.random() * Math.PI * 2;
    this.tx[i] = tx;
    this.tz[i] = tz;
    this.sx[i] = tx + Math.cos(a) * COMET_SLANT;
    this.sz[i] = tz + Math.sin(a) * COMET_SLANT;
    this.age[i] = 0;
    this.fall[i] = fall;
    this.dmg[i] = dmg;
    this.radius[i] = radius;
    this.size[i] = size;
  }

  remove(i: number): void {
    const j = --this.n;
    if (i === j) return;
    for (const a of [this.tx, this.tz, this.sx, this.sz, this.age, this.fall, this.dmg, this.radius, this.size]) a[i] = a[j];
  }

  /** Comet i's position at its fraction of the fall (into `at`). */
  where(i: number, t: number): Vector3 {
    const gy = duneHeight(this.tx[i], this.tz[i]);
    // Accelerating in.
    const e = t * t;
    return this.at.set(
      this.sx[i] + (this.tx[i] - this.sx[i]) * e,
      gy + COMET_HEIGHT * (1 - e),
      this.sz[i] + (this.tz[i] - this.sz[i]) * e,
    );
  }

  move(dt: number, embers: Embers): void {
    for (let i = 0; i < this.n; i++) {
      this.age[i] += dt;
      const t = Math.min(1, this.age[i] / this.fall[i]);
      const p = this.where(i, t);
      for (let k = 0; k < 3; k++) {
        embers.emit(p.x + (Math.random() - 0.5) * 0.6, p.y + (Math.random() - 0.5) * 0.6, p.z + (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 1.5, Math.random() * 1.5, (Math.random() - 0.5) * 1.5, 0.5 + Math.random() * 0.5, 0.35 * this.size[i]);
      }
    }
  }

  draw(time: number): void {
    for (let i = 0; i < this.n; i++) {
      const t = Math.min(1, this.age[i] / this.fall[i]);
      const p = this.where(i, t);
      tmpP.copy(p);
      const s = this.size[i] * (1 + 0.1 * Math.sin(time * 25 + i));
      tmpQ.setFromAxisAngle(UP, time * 4 + i);
      tmpS.set(s, s, s);
      this.rock.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS));
      this.rock.setColorAt(i, tmpC.setRGB(2.2, 1.4, 0.6));
      // The tail, back up the way it came.
      tmpV.set(this.sx[i], p.y + 30, this.sz[i]);
      tmpM.lookAt(tmpV.sub(p).multiplyScalar(-1).add(p), p, UP);
      tmpQ.setFromRotationMatrix(tmpM);
      tmpS.set(s * 1.2, s * 1.2, 9 * s);
      this.tail.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS));
      this.tail.setColorAt(i, tmpC.setRGB(1.6, 0.7, 0.2));
      // Where it will strike: a ring tightening and reddening.
      tmpP.set(this.tx[i], duneHeight(this.tx[i], this.tz[i]) + 0.06, this.tz[i]);
      const r = this.radius[i] * (1.6 - 0.6 * t);
      tmpS.set(r, 1, r);
      this.ring.setMatrixAt(i, tmpM.compose(tmpP, tmpQ.identity(), tmpS));
      this.ring.setColorAt(i, tmpC.setRGB(1.6, 0.5 + 0.4 * (1 - t), 0.15).multiplyScalar(0.3 + 0.7 * t));
    }
    for (const m of [this.rock, this.tail, this.ring]) {
      m.count = this.n;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  clear(): void {
    this.n = 0;
  }
}
