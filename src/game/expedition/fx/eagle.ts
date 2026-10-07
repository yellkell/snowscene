/**
 * Golden eagles. A procedural low-poly bird (~2.2 m span) whose wings bend
 * at shoulder and wrist in the vertex shader, so a pair of them is a single
 * instanced draw call.
 *
 * Over the valley, forest and moraine the pair circles a thermal that keeps
 * a little ahead of the player above the downhill side, mostly gliding with
 * a few strong wingbeats to climb; every minute or so one sweeps past the
 * player close-ish (12-18 m) with a cry. During the summit glide both join
 * the player and fly alongside in formation, peeling away before landing.
 *
 * Flight is a small steering model: a target point per mode, limited
 * acceleration, bank from the actual (centripetal) acceleration.
 */

import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from '@iwsdk/core';
import { audio } from '../../audio.js';
import { game, Phase } from '../../state.js';
import { exp, expFrame } from '../exp-state.js';
import { outwardSide, routeFrame } from '../exp-layout.js';
import { clamp } from '../exp-route.js';
import { lumpGeometry } from './fx-geometry.js';

const SHOULDER = 0.08;
const WRIST = 0.6;
const BIRDS = 2;
/** Eagles live over the lower mountain only. */
const EAGLE_MAX_S = 4250;

type Mode = 'off' | 'circle' | 'pass' | 'exit' | 'formation' | 'leave';

interface Bird {
  pos: Vector3;
  vel: Vector3;
  acc: Vector3;
  target: Vector3;
  mode: Mode;
  modeTime: number;
  radius: number;
  height: number;
  dir: number;
  flapPhase: number;
  flap: number;
  flapWant: number;
  flapBurst: number;
  cried: boolean;
  scale: number;
}

function buildEagleGeometry(): BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const seg: number[] = [];
  const v = new Vector3();
  const addGeo = (geo: BufferGeometry, m: Matrix4, c: Color, s: number) => {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const pa = g.getAttribute('position');
    const na = g.getAttribute('normal');
    const nm = new Matrix4().copy(m).invert().transpose();
    for (let i = 0; i < pa.count; i++) {
      v.fromBufferAttribute(pa, i).applyMatrix4(m);
      pos.push(v.x, v.y, v.z);
      v.fromBufferAttribute(na, i).transformDirection(nm);
      nor.push(v.x, v.y, v.z);
      const k = 0.92 + 0.16 * (((i / 3) | 0) % 3) * 0.5;
      col.push(c.r * k, c.g * k, c.b * k);
      seg.push(s);
    }
  };
  const a = new Vector3();
  const b = new Vector3();
  const n = new Vector3();
  const tri = (p: number[], q: number[], r: number[], c: Color, s: number) => {
    a.set(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    b.set(r[0] - p[0], r[1] - p[1], r[2] - p[2]);
    n.crossVectors(a, b).normalize();
    if (n.y < 0) n.negate();
    for (const pt of [p, q, r]) {
      pos.push(pt[0], pt[1], pt[2]);
      nor.push(n.x, n.y, n.z);
      col.push(c.r, c.g, c.b);
      seg.push(s);
    }
  };
  const quad = (p: number[], q: number[], r: number[], t: number[], c: Color, s: number) => {
    tri(p, q, r, c, s);
    tri(p, r, t, c, s);
  };
  const body = new Color(0.2, 0.13, 0.075);
  const nape = new Color(0.62, 0.43, 0.18);
  const beak = new Color(0.78, 0.66, 0.3);
  const coverts = new Color(0.4, 0.27, 0.14);
  const flight = new Color(0.14, 0.1, 0.065);
  const tailCol = new Color(0.24, 0.16, 0.09);
  addGeo(lumpGeometry(61, 0.1, 0.12, 0.11, 0.4, 1), new Matrix4(), body, 0);
  addGeo(lumpGeometry(62, 0.08, 0.075, 0.07, 0.09, 1), new Matrix4().makeTranslation(0, 0.035, 0.42), nape, 0);
  addGeo(lumpGeometry(63, 0.05, 0.022, 0.028, 0.055, 0), new Matrix4().makeTranslation(0, 0.015, 0.52), beak, 0);
  // Tail fan.
  quad([-0.06, 0, -0.32], [0.06, 0, -0.32], [0.17, 0, -0.74], [-0.17, 0, -0.74], tailCol, 0);
  for (const s of [-1, 1]) {
    // Inner wing: coverts in front, secondaries behind.
    quad([s * SHOULDER, 0.02, 0.13], [s * WRIST, 0.02, 0.1], [s * WRIST, 0.01, -0.05], [s * SHOULDER, 0.01, -0.06], coverts, 1);
    quad([s * SHOULDER, 0.01, -0.06], [s * WRIST, 0.01, -0.05], [s * WRIST, 0, -0.22], [s * SHOULDER, 0, -0.27], flight, 1);
    // Outer wing (hand) and the splayed primaries ("fingers").
    quad([s * WRIST, 0.02, 0.1], [s * 0.98, 0.01, 0.01], [s * 1.0, 0, -0.1], [s * WRIST, 0, -0.22], flight, 2);
    quad([s * WRIST, 0.02, 0.1], [s * 0.8, 0.015, 0.06], [s * 0.8, 0.008, -0.04], [s * WRIST, 0.01, -0.05], coverts, 2);
    for (let k = 0; k < 5; k++) {
      const f0 = k / 5;
      const f1 = (k + 0.55) / 5;
      const z0 = 0.01 - 0.11 * f0;
      const z1 = 0.01 - 0.11 * f1;
      const x0 = 0.98 + 0.02 * f0;
      const x1 = 0.98 + 0.02 * f1;
      tri([s * x0, 0.004, z0], [s * x1, 0.004, z1], [s * (1.1 - 0.03 * k), 0, (z0 + z1) / 2 - 0.05 * k], flight, 2);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new Float32BufferAttribute(nor, 3));
  geo.setAttribute('color', new Float32BufferAttribute(col, 3));
  geo.setAttribute('aSeg', new Float32BufferAttribute(seg, 1));
  geo.computeBoundingSphere();
  return geo;
}

const BEND_GLSL = /* glsl */ `
attribute float aSeg;
attribute vec2 aFlap;
vec2 eagleRot(vec2 q, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec2(c * q.x - s * q.y, s * q.x + c * q.y);
}
`;

export class EagleFlock {
  readonly mesh: InstancedMesh;
  private readonly flapAttr: InstancedBufferAttribute;
  private readonly birds: Bird[] = [];
  private readonly centre = new Vector3();
  private readonly centreTarget = new Vector3();
  private centreReady = false;
  private passTimer = 35;
  private readonly prevHead = new Vector3();
  private readonly playerVel = new Vector3();
  private hasPrevHead = false;
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly fwd = new Vector3();
  private readonly up = new Vector3();
  private readonly side = new Vector3();
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly sc = new Vector3();
  private readonly zero = new Matrix4().makeScale(0, 0, 0);
  private readonly frame = { x: 0, z: 0, elev: 0, tx: 0, tz: 0, nx: 0, nz: 0 };
  private wasGliding = false;

  constructor(private readonly groundAt: (x: number, z: number) => number) {
    const geo = buildEagleGeometry();
    this.flapAttr = new InstancedBufferAttribute(new Float32Array(BIRDS * 2), 2);
    geo.setAttribute('aFlap', this.flapAttr);
    const material = new MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.85,
      flatShading: true,
      side: DoubleSide,
    });
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${BEND_GLSL}`)
        .replace(
          '#include <beginnormal_vertex>',
          /* glsl */ `
          vec3 eP = position;
          vec3 objectNormal = normal;
          if (aSeg > 0.5) {
            float side = position.x >= 0.0 ? 1.0 : -1.0;
            if (aSeg > 1.5) {
              float b = aFlap.y * side;
              eP.xy = eagleRot(eP.xy - vec2(side * ${WRIST.toFixed(3)}, 0.0), b) + vec2(side * ${WRIST.toFixed(3)}, 0.0);
              objectNormal.xy = eagleRot(objectNormal.xy, b);
            }
            float a = aFlap.x * side;
            eP.xy = eagleRot(eP.xy - vec2(side * ${SHOULDER.toFixed(3)}, 0.0), a) + vec2(side * ${SHOULDER.toFixed(3)}, 0.0);
            objectNormal.xy = eagleRot(objectNormal.xy, a);
          }
          #ifdef USE_TANGENT
            vec3 objectTangent = vec3(tangent.xyz);
          #endif
          `,
        )
        .replace('#include <begin_vertex>', 'vec3 transformed = eP;');
    };
    material.customProgramCacheKey = () => 'expedition-eagle';
    this.mesh = new InstancedMesh(geo, material, BIRDS);
    this.mesh.name = 'GoldenEagles';
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    for (let i = 0; i < BIRDS; i++) {
      this.mesh.setMatrixAt(i, this.zero);
      this.birds.push({
        pos: new Vector3(),
        vel: new Vector3(0, 0, 12),
        acc: new Vector3(),
        target: new Vector3(),
        mode: 'off',
        modeTime: 0,
        radius: 55 + i * 22,
        height: i * 14,
        dir: i ? -1 : 1,
        flapPhase: i * 1.3,
        flap: 0,
        flapWant: 0,
        flapBurst: 0,
        cried: false,
        scale: i ? 0.94 : 1,
      });
    }
  }

  reset(): void {
    for (const b of this.birds) b.mode = 'off';
    this.centreReady = false;
    this.hasPrevHead = false;
    this.wasGliding = false;
    this.mesh.visible = false;
  }

  /** Debug: send one bird past the player now. */
  forcePass(head: Vector3): void {
    const b = this.birds[0];
    if (b.mode === 'circle') this.startPass(b, head);
    else this.passTimer = 0;
  }

  update(dt: number, time: number, head: Vector3): void {
    if (dt <= 0) return;
    // Player velocity (for formation flying).
    if (this.hasPrevHead) {
      this.tmp.subVectors(head, this.prevHead).divideScalar(dt);
      if (this.tmp.lengthSq() < 60 * 60) this.playerVel.lerp(this.tmp, Math.min(1, dt * 2));
    }
    this.prevHead.copy(head);
    this.hasPrevHead = true;

    const phase = game.phase.peek();
    const gliding = exp.summited.peek() && (phase === Phase.Gliding || phase === Phase.Launch);
    const s = expFrame.s;
    const lower = !exp.summited.peek() && s < EAGLE_MAX_S && phase !== Phase.Gliding;

    if (gliding && phase === Phase.Gliding && !this.wasGliding) this.joinGlide(head);
    this.wasGliding = gliding && phase === Phase.Gliding;

    if (lower) this.updateThermal(dt, s);
    let any = false;
    for (let i = 0; i < BIRDS; i++) {
      const b = this.birds[i];
      b.modeTime += dt;
      if (b.mode === 'off') {
        if (lower && this.centreReady) this.enterCircle(b, head);
        else continue;
      }
      if (b.mode === 'formation' && (!gliding || this.nearGround(head, 70))) this.startLeave(b);
      if ((b.mode === 'circle' || b.mode === 'pass' || b.mode === 'exit') && !lower) this.startLeave(b);
      if (b.mode === 'leave' && b.modeTime > 18) {
        b.mode = 'off';
        this.mesh.setMatrixAt(i, this.zero);
        continue;
      }
      this.steer(b, i, dt, time, head);
      any = true;
    }
    // Scheduled close pass.
    if (lower) {
      this.passTimer -= dt;
      if (this.passTimer <= 0) {
        this.passTimer = 50 + Math.random() * 40;
        const b = this.birds[Math.random() < 0.5 ? 0 : 1];
        if (b.mode === 'circle') this.startPass(b, head);
      }
    }
    this.mesh.visible = any;
    if (any) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.flapAttr.needsUpdate = true;
    }
  }

  private nearGround(head: Vector3, h: number): boolean {
    return head.y - this.groundAt(head.x, head.z) < h;
  }

  private updateThermal(dt: number, s: number): void {
    const f = routeFrame(clamp(s + 170, 0, EAGLE_MAX_S - 150), this.frame);
    const out = outwardSide(clamp(s + 170, 0, EAGLE_MAX_S - 150));
    const x = f.x + f.nx * out * 95;
    const z = f.z + f.nz * out * 95;
    const y = Math.max(f.elev + 70, this.groundAt(x, z) + 55);
    this.centreTarget.set(x, y, z);
    if (!this.centreReady) {
      this.centre.copy(this.centreTarget);
      this.centreReady = true;
      return;
    }
    // The thermal drifts after the player at a few metres per second.
    this.tmp.subVectors(this.centreTarget, this.centre);
    const d = this.tmp.length();
    const step = Math.min(d, 6 * dt);
    if (d > 1e-3) this.centre.addScaledVector(this.tmp, step / d);
  }

  private enterCircle(b: Bird, head: Vector3): void {
    b.mode = 'circle';
    b.modeTime = 0;
    // Arrive from the far side of the thermal, away from the player.
    this.tmp.subVectors(this.centre, head).setY(0);
    if (this.tmp.lengthSq() < 1) this.tmp.set(1, 0, 0);
    this.tmp.normalize();
    b.pos.copy(this.centre).addScaledVector(this.tmp, b.radius + 60);
    b.pos.y += b.height + 10;
    b.vel.set(-this.tmp.z * b.dir, 0, this.tmp.x * b.dir).multiplyScalar(12);
    b.acc.set(0, 0, 0);
  }

  private startPass(b: Bird, head: Vector3): void {
    b.mode = 'pass';
    b.modeTime = 0;
    b.cried = false;
    // Sweep by to one side of the player, a few metres above head height.
    this.tmp.subVectors(head, b.pos).setY(0);
    if (this.tmp.lengthSq() < 1) this.tmp.set(0, 0, 1);
    this.tmp.normalize();
    const side = Math.random() < 0.5 ? -1 : 1;
    const off = 12 + Math.random() * 6;
    b.target.set(head.x - this.tmp.z * side * off, head.y + 5 + Math.random() * 3, head.z + this.tmp.x * side * off);
    const g = this.groundAt(b.target.x, b.target.z);
    b.target.y = Math.max(b.target.y, g + 6);
    const d = b.pos.distanceTo(head);
    if (d < 260) audio.eagleCry(0.05 + 0.1 / (1 + d / 80));
  }

  private startLeave(b: Bird): void {
    if (b.mode === 'leave' || b.mode === 'off') return;
    b.mode = 'leave';
    b.modeTime = 0;
    this.tmp.copy(b.vel).setY(0);
    if (this.tmp.lengthSq() < 1) this.tmp.set(0, 0, 1);
    this.tmp.normalize();
    b.target.copy(b.pos).addScaledVector(this.tmp, 400);
    b.target.y += 120;
  }

  private joinGlide(head: Vector3): void {
    // Both birds come in from ahead and slot in beside the glider.
    this.fwd.copy(this.playerVel).setY(0);
    if (this.fwd.lengthSq() < 1) this.fwd.set(0, 0, 1);
    this.fwd.normalize();
    for (let i = 0; i < BIRDS; i++) {
      const b = this.birds[i];
      const side = i ? 1 : -1;
      b.mode = 'formation';
      b.modeTime = 0;
      b.pos
        .copy(head)
        .addScaledVector(this.fwd, 140 + i * 30)
        .add(this.tmp.set(-this.fwd.z * side * 60, 25, this.fwd.x * side * 60));
      b.vel.copy(this.fwd).multiplyScalar(-6);
      b.acc.set(0, 0, 0);
      b.cried = false;
    }
  }

  private steer(b: Bird, i: number, dt: number, time: number, head: Vector3): void {
    const desired = this.tmp2;
    let cruise = 13;
    let maxAcc = 5;
    switch (b.mode) {
      case 'circle': {
        const c = this.centre;
        const ang = Math.atan2(b.pos.z - c.z, b.pos.x - c.x) + b.dir * 0.55;
        b.target.set(
          c.x + Math.cos(ang) * b.radius,
          c.y + b.height + 5 * Math.sin(time * 0.15 + i * 2),
          c.z + Math.sin(ang) * b.radius,
        );
        desired.subVectors(b.target, b.pos).normalize().multiplyScalar(cruise);
        break;
      }
      case 'pass': {
        cruise = 17;
        maxAcc = 7;
        desired.subVectors(b.target, b.pos);
        const d = desired.length();
        desired.multiplyScalar(cruise / Math.max(d, 1e-3));
        const dh = b.pos.distanceTo(head);
        if (!b.cried && dh < 32) {
          b.cried = true;
          audio.eagleCry(0.22 / (1 + dh / 25));
        }
        if (d < 10 || b.modeTime > 30) {
          b.mode = 'exit';
          b.modeTime = 0;
          this.tmp.copy(b.vel).normalize();
          b.target.copy(b.pos).addScaledVector(this.tmp, 120);
          b.target.y += 35;
        }
        break;
      }
      case 'exit': {
        desired.subVectors(b.target, b.pos).normalize().multiplyScalar(cruise);
        if (b.modeTime > 6) {
          b.mode = 'circle';
          b.modeTime = 0;
        }
        break;
      }
      case 'formation': {
        // Slot beside and slightly behind the glider, matching its velocity.
        this.fwd.copy(this.playerVel);
        if (this.fwd.lengthSq() < 4) this.fwd.set(0, 0, 1);
        this.fwd.normalize();
        const side = i ? 1 : -1;
        this.side.set(-this.fwd.z, 0, this.fwd.x).normalize();
        b.target
          .copy(head)
          .addScaledVector(this.side, side * (14 + i * 3))
          .addScaledVector(this.fwd, 2 - i * 5 + 1.5 * Math.sin(time * 0.3 + i))
          .add(this.tmp.set(0, 1.5 - i * 1.5 + Math.sin(time * 0.45 + i * 2), 0));
        desired.subVectors(b.target, b.pos).multiplyScalar(0.7).add(this.playerVel);
        const l = desired.length();
        if (l > 34) desired.multiplyScalar(34 / l);
        maxAcc = 9;
        cruise = Math.max(12, this.playerVel.length());
        if (!b.cried && b.modeTime > 6 && b.pos.distanceTo(head) < 30) {
          b.cried = true;
          audio.eagleCry(0.16);
        }
        break;
      }
      case 'leave': {
        desired.subVectors(b.target, b.pos).normalize().multiplyScalar(16);
        break;
      }
      default:
        return;
    }
    // Keep clear of the ground.
    const g = this.groundAt(b.pos.x, b.pos.z);
    if (b.pos.y < g + 12) desired.y = Math.max(desired.y, 4);
    // Limited acceleration toward the desired velocity.
    this.tmp.subVectors(desired, b.vel);
    const need = this.tmp.length();
    if (need > maxAcc * dt) this.tmp.multiplyScalar((maxAcc * dt) / need);
    b.vel.add(this.tmp);
    b.acc.lerp(this.tmp.divideScalar(dt), Math.min(1, dt * 3));
    b.pos.addScaledVector(b.vel, dt);

    // Flap to climb or catch up; otherwise glide.
    const climbing = desired.y - b.vel.y > 0.6 || b.vel.y > 1.2;
    const slow = b.vel.length() < cruise - 1.5;
    b.flapBurst -= dt;
    if ((climbing || slow) && b.flapBurst <= 0) b.flapBurst = 1.2 + Math.random() * 1.2;
    b.flapWant = b.flapBurst > 0 ? 1 : 0;
    b.flap += (b.flapWant - b.flap) * Math.min(1, dt * 3);
    b.flapPhase += dt * Math.PI * 2 * 2.6 * (0.3 + 0.7 * b.flap);
    const sw = Math.sin(b.flapPhase);
    const inner = 0.1 + b.flap * 0.6 * sw + (1 - b.flap) * 0.03 * Math.sin(time * 1.7 + i);
    const outer = 0.05 + b.flap * 0.35 * Math.sin(b.flapPhase - 0.7);
    this.flapAttr.setXY(i, inner, outer);

    // Orientation: forward along velocity, up along lift (bank into turns).
    this.fwd.copy(b.vel);
    if (this.fwd.lengthSq() < 1e-4) this.fwd.set(0, 0, 1);
    this.fwd.normalize();
    this.up.copy(b.acc).add(this.tmp.set(0, 9.81, 0));
    this.up.addScaledVector(this.fwd, -this.up.dot(this.fwd)).normalize();
    this.side.crossVectors(this.up, this.fwd).normalize();
    this.m.makeBasis(this.side, this.up, this.fwd);
    this.q.setFromRotationMatrix(this.m);
    this.sc.setScalar(b.scale);
    this.m.compose(b.pos, this.q, this.sc);
    this.mesh.setMatrixAt(i, this.m);
  }
}
