/**
 * Snow Survivors' second set of weapons, drawn (the survivors system owns
 * their rules; these hold what moves on its own and draw it, pooled and
 * instanced like the rest of survivors-fx.ts):
 *
 * - Avalanche Mortar: snowballs lobbed high onto the thickest of the crowd,
 *   a ring on the snow marking where each comes down.
 * - Frost Aura: a slow whirl of blizzard round your feet.
 * - Glacier Discs: spinning discs of ice thrown out and coming back.
 * - Ice Spikes: crystal spikes bursting up out of the snow under them.
 */

import {
  type BufferGeometry,
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
  Quaternion,
  RingGeometry,
  ShaderMaterial,
  Vector3,
} from '@iwsdk/core';
import { GeometryBuilder, placed } from '../mesh-utils.js';
import { additive, streakGeometry } from './survivors-fx.js';
import { duneHeight } from './survivors-level.js';

const tmpM = new Matrix4();
const tmpQ = new Quaternion();
const tmpS = new Vector3();
const tmpP = new Vector3();
const tmpC = new Color();
const tmpV = new Vector3();
const UP = new Vector3(0, 1, 0);
const Y_AXIS = UP;
const X_AXIS = new Vector3(1, 0, 0);
const spinQ = new Quaternion();

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

// ------------------------------------------------------------- mortar ---

const SHELL_CAP = 40;

/** Snowballs on a high arc from you to a spot on the snow, a ring marking each landing. */
export class Shells {
  n = 0;
  readonly fx = new Float32Array(SHELL_CAP);
  readonly fy = new Float32Array(SHELL_CAP);
  readonly fz = new Float32Array(SHELL_CAP);
  readonly tx = new Float32Array(SHELL_CAP);
  readonly tz = new Float32Array(SHELL_CAP);
  readonly age = new Float32Array(SHELL_CAP);
  readonly flight = new Float32Array(SHELL_CAP);
  readonly radius = new Float32Array(SHELL_CAP);
  readonly dmg = new Float32Array(SHELL_CAP);
  readonly size = new Float32Array(SHELL_CAP);
  private readonly ball: InstancedMesh;
  private readonly trail: InstancedMesh;
  private readonly ring: InstancedMesh;

  constructor(parent: Group) {
    this.ball = instanced(
      new IcosahedronGeometry(0.22, 1),
      new MeshBasicMaterial({ toneMapped: false }),
      SHELL_CAP,
      'MortarShells',
      parent,
    );
    this.trail = instanced(streakGeometry(0.4), additive({ vertexColors: true }), SHELL_CAP, 'MortarTrails', parent);
    this.ring = instanced(new RingGeometry(0.86, 1, 40).rotateX(-Math.PI / 2), additive(), SHELL_CAP, 'MortarMarks', parent);
  }

  lob(x: number, y: number, z: number, tx: number, tz: number, flight: number, radius: number, dmg: number, size: number): void {
    if (this.n >= SHELL_CAP) return;
    const i = this.n++;
    this.fx[i] = x;
    this.fy[i] = y;
    this.fz[i] = z;
    this.tx[i] = tx;
    this.tz[i] = tz;
    this.age[i] = 0;
    this.flight[i] = flight;
    this.radius[i] = radius;
    this.dmg[i] = dmg;
    this.size[i] = size;
  }

  remove(i: number): void {
    const j = --this.n;
    if (i === j) return;
    for (const a of [this.fx, this.fy, this.fz, this.tx, this.tz, this.age, this.flight, this.radius, this.dmg, this.size]) a[i] = a[j];
  }

  move(dt: number): void {
    for (let i = 0; i < this.n; i++) this.age[i] += dt;
  }

  /** Where shell i is now (a parabola peaking well over the crowd). */
  private at(i: number, t: number, out: Vector3): Vector3 {
    const gy = duneHeight(this.tx[i], this.tz[i]);
    const peak = 4 + this.flight[i] * 3;
    out.set(
      this.fx[i] + (this.tx[i] - this.fx[i]) * t,
      this.fy[i] + (gy - this.fy[i]) * t + 4 * peak * t * (1 - t),
      this.fz[i] + (this.tz[i] - this.fz[i]) * t,
    );
    return out;
  }

  draw(time: number): void {
    const v = tmpV;
    for (let i = 0; i < this.n; i++) {
      const t = Math.min(1, this.age[i] / this.flight[i]);
      this.at(i, t, tmpP);
      // Heading for the trail: from a moment ago to now.
      this.at(i, Math.max(0, t - 0.04), v);
      const s = this.size[i] * (1 + 0.08 * Math.sin(time * 20 + i));
      tmpQ.setFromAxisAngle(X_AXIS, time * 6 + i);
      tmpS.set(s, s, s);
      this.ball.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS));
      this.ball.setColorAt(i, tmpC.setRGB(1.4, 1.5, 1.7));
      // The streak behind it, pointing back along its flight.
      v.sub(tmpP);
      const len = v.length();
      if (len > 1e-4) {
        tmpM.lookAt(v.multiplyScalar(-1).add(tmpP), tmpP, UP);
        tmpQ.setFromRotationMatrix(tmpM);
      }
      tmpS.set(s, s, Math.min(2.4, 0.4 + len * 30) * s);
      this.trail.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS));
      this.trail.setColorAt(i, tmpC.setRGB(0.55, 0.7, 1.0));
      // The mark where it lands: tightening, brightening as it comes down.
      tmpP.set(this.tx[i], duneHeight(this.tx[i], this.tz[i]) + 0.06, this.tz[i]);
      const r = this.radius[i] * (1.5 - 0.5 * t);
      tmpS.set(r, 1, r);
      this.ring.setMatrixAt(i, tmpM.compose(tmpP, tmpQ.identity(), tmpS));
      this.ring.setColorAt(i, tmpC.setRGB(0.5, 0.75, 1.2).multiplyScalar(0.25 + 0.75 * t * t));
    }
    for (const m of [this.ball, this.trail, this.ring]) {
      m.count = this.n;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  clear(): void {
    this.n = 0;
  }
}

// --------------------------------------------------------------- aura ---

const AURA_VERT = /* glsl */ `
varying vec2 vP;
void main() {
  vP = position.xz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const AURA_FRAG = /* glsl */ `
uniform float uTime;
uniform float uPulse;
uniform vec3 uColor;
uniform float uAlpha;
varying vec2 vP;
void main() {
  float r = length(vP);
  if (r > 1.0) discard;
  float a = atan(vP.y, vP.x);
  // Arms of blowing snow whirling round, thickest toward the rim.
  float arms = 0.5 + 0.5 * sin(a * 5.0 - r * 9.0 + uTime * 3.2);
  float fine = 0.5 + 0.5 * sin(a * 13.0 + r * 22.0 - uTime * 5.0);
  float rim = smoothstep(0.55, 0.95, r) * (1.0 - smoothstep(0.95, 1.0, r));
  float body = smoothstep(0.2, 0.9, r) * (0.35 + 0.65 * arms) * (0.75 + 0.25 * fine);
  float alpha = (body * 0.32 + rim * 0.5 + uPulse * rim * 0.9) * uAlpha;
  gl_FragColor = vec4(uColor * (1.0 + uPulse), alpha);
}
`;

const FLAKES = 70;

/** A whirl of blizzard round your feet: a swirling disc and flakes riding round it. */
export class Aura {
  private readonly disc: Mesh;
  private readonly flakes: InstancedMesh;
  private pulse = 0;
  private spin = 0;

  constructor(parent: Group) {
    this.disc = new Mesh(
      new RingGeometry(0.05, 1, 64, 1).rotateX(-Math.PI / 2),
      new ShaderMaterial({
        vertexShader: AURA_VERT,
        fragmentShader: AURA_FRAG,
        uniforms: {
          uTime: { value: 0 },
          uPulse: { value: 0 },
          uColor: { value: new Color(0.7, 0.85, 1.2) },
          uAlpha: { value: 1 },
        },
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        toneMapped: false,
      }),
    );
    this.disc.renderOrder = 4;
    this.disc.visible = false;
    this.disc.name = 'FrostAura';
    parent.add(this.disc);
    const flake = new GeometryBuilder();
    flake.add(new ConeGeometry(0.035, 0.12, 4), placed(0, 0, 0), new Color(1, 1, 1));
    flake.add(new ConeGeometry(0.035, 0.12, 4).rotateX(Math.PI), placed(0, -0.12, 0), new Color(1, 1, 1));
    this.flakes = instanced(flake.build(), new MeshBasicMaterial({ vertexColors: true, toneMapped: false }), FLAKES, 'AuraFlakes', parent);
  }

  /** A tick of damage: the whirl flares. */
  flare(): void {
    this.pulse = 1;
  }

  /** Round (x, z) at `radius`, or hidden with radius 0. */
  draw(dt: number, time: number, x: number, z: number, radius: number, white: boolean): void {
    const on = radius > 0;
    this.disc.visible = on;
    this.flakes.count = on ? FLAKES : 0;
    if (!on) return;
    this.pulse = Math.max(0, this.pulse - dt * 4);
    this.spin += dt * 1.6;
    const y = duneHeight(x, z) + 0.05;
    this.disc.position.set(x, y, z);
    this.disc.scale.set(radius, 1, radius);
    const u = (this.disc.material as ShaderMaterial).uniforms;
    u.uTime.value = time;
    u.uPulse.value = this.pulse;
    (u.uColor.value as Color).setRGB(white ? 0.95 : 0.6, white ? 1.0 : 0.82, white ? 1.25 : 1.2);
    for (let k = 0; k < FLAKES; k++) {
      // Each flake on its own orbit, a little in or out, bobbing up and down.
      const lane = 0.45 + 0.55 * ((k * 0.618) % 1);
      const a = this.spin * (1.4 - lane * 0.6) + k * 2.399;
      const r = radius * lane;
      tmpP.set(x + Math.cos(a) * r, y + 0.15 + ((k * 0.37) % 1) * 1.1 + Math.sin(time * 2 + k) * 0.12, z + Math.sin(a) * r);
      tmpQ.setFromAxisAngle(Y_AXIS, time * 3 + k);
      const s = 0.8 + 0.6 * ((k * 0.73) % 1) + this.pulse * 0.6;
      tmpS.set(s, s, s);
      this.flakes.setMatrixAt(k, tmpM.compose(tmpP, tmpQ, tmpS));
      this.flakes.setColorAt(k, tmpC.setRGB(1.2, 1.3, 1.5));
    }
    this.flakes.instanceMatrix.needsUpdate = true;
    if (this.flakes.instanceColor) this.flakes.instanceColor.needsUpdate = true;
  }
}

// -------------------------------------------------------------- discs ---

const DISC_CAP = 24;

/** Discs of ice thrown out along a heading and spun back home to you. */
export class Discs {
  n = 0;
  readonly x = new Float32Array(DISC_CAP);
  readonly y = new Float32Array(DISC_CAP);
  readonly z = new Float32Array(DISC_CAP);
  /** Heading out (unit), how far it goes, and how long the whole trip takes. */
  readonly dx = new Float32Array(DISC_CAP);
  readonly dz = new Float32Array(DISC_CAP);
  readonly range = new Float32Array(DISC_CAP);
  readonly trip = new Float32Array(DISC_CAP);
  readonly age = new Float32Array(DISC_CAP);
  readonly dmg = new Float32Array(DISC_CAP);
  readonly size = new Float32Array(DISC_CAP);
  private readonly mesh: InstancedMesh;
  private readonly trail: InstancedMesh;

  constructor(parent: Group) {
    const b = new GeometryBuilder();
    b.add(new CylinderGeometry(1, 1, 0.12, 6), placed(0, 0, 0), new Color(0.75, 0.92, 1.3));
    b.add(new CylinderGeometry(0.45, 0.45, 0.18, 6), placed(0, 0, 0), new Color(1.6, 1.7, 1.9));
    // Saw teeth round the rim.
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
      b.add(new ConeGeometry(0.22, 0.5, 3).rotateZ(-Math.PI / 2).rotateY(-a), placed(Math.cos(a) * 1.05, 0, Math.sin(a) * 1.05), new Color(1.2, 1.4, 1.7));
    }
    this.mesh = instanced(b.build(), new MeshBasicMaterial({ vertexColors: true, toneMapped: false }), DISC_CAP, 'GlacierDiscs', parent);
    this.trail = instanced(streakGeometry(0.5), additive({ vertexColors: true }), DISC_CAP, 'DiscTrails', parent);
  }

  throw(x: number, y: number, z: number, dx: number, dz: number, range: number, trip: number, dmg: number, size: number): void {
    if (this.n >= DISC_CAP) return;
    const i = this.n++;
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = z;
    this.dx[i] = dx;
    this.dz[i] = dz;
    this.range[i] = range;
    this.trip[i] = trip;
    this.age[i] = 0;
    this.dmg[i] = dmg;
    this.size[i] = size;
  }

  remove(i: number): void {
    const j = --this.n;
    if (i === j) return;
    for (const a of [this.x, this.y, this.z, this.dx, this.dz, this.range, this.trip, this.age, this.dmg, this.size]) a[i] = a[j];
  }

  /**
   * Fly them: out along the heading, easing to a stop at full range, then
   * home to (px, py, pz) wherever you have gone. Returns nothing; the
   * system removes a disc once it is home (age ≥ trip).
   */
  move(dt: number, px: number, py: number, pz: number): void {
    for (let i = 0; i < this.n; i++) {
      this.age[i] += dt;
      const t = this.age[i] / this.trip[i];
      if (t < 0.5) {
        // Out: fast, slowing to a hang at the far end.
        const u = t / 0.5;
        const d = this.range[i] * (1 - (1 - u) * (1 - u));
        this.x[i] = px + this.dx[i] * d;
        this.z[i] = pz + this.dz[i] * d;
      } else {
        // Back: from wherever it hung, faster and faster, to you.
        const u = Math.min(1, (t - 0.5) / 0.5);
        const hx = px + this.dx[i] * this.range[i];
        const hz = pz + this.dz[i] * this.range[i];
        this.x[i] = hx + (px - hx) * u * u;
        this.z[i] = hz + (pz - hz) * u * u;
      }
      this.y[i] = py;
    }
  }

  draw(time: number): void {
    for (let i = 0; i < this.n; i++) {
      tmpP.set(this.x[i], this.y[i], this.z[i]);
      // Lying nearly flat, tilted a little, spinning hard.
      tmpQ.setFromAxisAngle(X_AXIS, 0.25);
      tmpQ.multiply(spinQ.setFromAxisAngle(Y_AXIS, time * 22 + i));
      const s = this.size[i];
      tmpS.set(s, s, s);
      this.mesh.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS));
      this.mesh.setColorAt(i, tmpC.setRGB(1, 1, 1));
      // The streak: behind it on the way out, ahead of it on the way home.
      const out = this.age[i] / this.trip[i] < 0.5;
      tmpQ.setFromAxisAngle(UP, Math.atan2(this.dx[i], this.dz[i]) + (out ? 0 : Math.PI));
      tmpS.set(s * 1.2, s, s * 2.4);
      this.trail.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS));
      this.trail.setColorAt(i, tmpC.setRGB(0.5, 0.8, 1.2));
    }
    for (const m of [this.mesh, this.trail]) {
      m.count = this.n;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  clear(): void {
    this.n = 0;
  }
}

// ------------------------------------------------------------- spikes ---

const SPIKE_CAP = 60;
/** Crystals per eruption. */
const PER = 5;

/** Clusters of ice crystals bursting up out of the snow, then sinking back. */
export class Spikes {
  private readonly mesh: InstancedMesh;
  private readonly mark: InstancedMesh;
  private readonly x = new Float32Array(SPIKE_CAP);
  private readonly z = new Float32Array(SPIKE_CAP);
  private readonly r = new Float32Array(SPIKE_CAP);
  /** Seconds since it was placed (negative: still warning on the snow). */
  private readonly age = new Float32Array(SPIKE_CAP).fill(9);
  private readonly seed = new Float32Array(SPIKE_CAP);
  private next = 0;

  constructor(parent: Group) {
    const geo = new ConeGeometry(0.16, 1, 5).translate(0, 0.5, 0);
    this.mesh = instanced(geo, new MeshBasicMaterial({ toneMapped: false }), SPIKE_CAP * PER, 'IceSpikes', parent);
    this.mark = instanced(new RingGeometry(0.7, 1, 32).rotateX(-Math.PI / 2), additive(), SPIKE_CAP, 'SpikeMarks', parent);
  }

  /** Mark a spot; it erupts after `warn` seconds. */
  place(x: number, z: number, radius: number, warn: number): void {
    const i = this.next;
    this.next = (this.next + 1) % SPIKE_CAP;
    this.x[i] = x;
    this.z[i] = z;
    this.r[i] = radius;
    this.age[i] = -warn;
    this.seed[i] = Math.random() * 100;
  }

  /**
   * Age them; `erupt(x, z, radius)` is called for each the moment it
   * bursts up (the system deals the damage).
   */
  tick(dt: number, erupt: (x: number, z: number, radius: number) => void): void {
    let n = 0;
    let m = 0;
    for (let i = 0; i < SPIKE_CAP; i++) {
      if (this.age[i] >= 1.1) continue;
      const before = this.age[i];
      this.age[i] += dt;
      const t = this.age[i];
      if (before < 0 && t >= 0) erupt(this.x[i], this.z[i], this.r[i]);
      const gy = duneHeight(this.x[i], this.z[i]);
      if (t < 0) {
        // The warning: a ring of frost tightening on the snow.
        tmpP.set(this.x[i], gy + 0.05, this.z[i]);
        const k = this.r[i] * (1 + Math.max(0, -t) * 2.5);
        tmpS.set(k, 1, k);
        this.mark.setMatrixAt(m, tmpM.compose(tmpP, tmpQ.identity(), tmpS));
        this.mark.setColorAt(m, tmpC.setRGB(0.6, 0.85, 1.3));
        m++;
        continue;
      }
      // Up fast, hold, then sink back into the snow.
      const grow = t < 0.12 ? t / 0.12 : t < 0.7 ? 1 : 1 - (t - 0.7) / 0.4;
      const h = Math.max(0.01, grow) * this.r[i] * 1.9;
      for (let c = 0; c < PER; c++) {
        const a = this.seed[i] + c * 1.257;
        const d = c === 0 ? 0 : this.r[i] * 0.45;
        tmpP.set(this.x[i] + Math.cos(a) * d, gy - 0.1, this.z[i] + Math.sin(a) * d);
        // Leaning out from the middle.
        tmpQ.setFromAxisAngle(tmpS.set(Math.sin(a), 0, -Math.cos(a)), c === 0 ? 0 : 0.35);
        const hh = h * (c === 0 ? 1.15 : 0.6 + 0.25 * ((a * 3.1) % 1));
        tmpS.set(this.r[i] * 0.9, hh, this.r[i] * 0.9);
        this.mesh.setMatrixAt(n, tmpM.compose(tmpP, tmpQ, tmpS));
        this.mesh.setColorAt(n, tmpC.setRGB(0.75, 0.95, 1.35).multiplyScalar(t < 0.1 ? 2 : 1));
        n++;
      }
    }
    this.mesh.count = n;
    this.mark.count = m;
    for (const mesh of [this.mesh, this.mark]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  clear(): void {
    this.age.fill(9);
    this.mesh.count = 0;
    this.mark.count = 0;
  }
}
