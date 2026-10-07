/**
 * The avalanche on the moraine.
 *
 * At AVALANCHE.triggerS a crack echoes off the valley walls and a slab
 * breaks away ~320 m up the fall line. A churning snow mass (one grid mesh
 * draped down the track and deformed on the GPU: a bulging head, churning
 * body, settling deposit) races down, crosses the route at AVALANCHE.crossS
 * ~11.5 s after the trigger at ~35 m/s, pours on into the runout and settles
 * into a lumpy deposit studded with tumbling snow blocks. A billowing powder
 * cloud rolls off the head and spreads sideways.
 *
 * Fairness (see fx-layout.ts and the node check): the lethal strip on the
 * route is ~s 3304-3356 for ~4 s around the crossing; a player who keeps
 * poling (<= 4 m/s) or retreats is never inside it. Anyone who is gets a
 * whiteout and a respawn. No camera motion: the drama comes from sound,
 * controller rumble, the powder haze and the spectacle itself.
 */

import {
  Color,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from '@iwsdk/core';
import { audio } from '../../audio.js';
import { mulberry32 } from '../../terrain.js';
import { clamp, project, type Projection, smoothstep } from '../exp-route.js';
import { crackAt, listenerDistance, Roar } from './fx-audio.js';
import type { FxContext } from './fx-context.js';
import { lumpGeometry } from './fx-geometry.js';
import {
  AV_DEPOSIT_START,
  AV_LENGTH,
  AV_SLAB,
  AV_STEP,
  AV_T_CROSS,
  AV_T_RELEASE,
  AV_T_STOP,
  AV_UP,
  avCoords,
  avFront,
  avHalfWidth,
  avLethal,
  avPoint,
  avSpeed,
  avTail,
  buildAvalanchePath,
  type AvalanchePath,
  type TrackCoords,
} from './fx-layout.js';

const ROW_STEP = 2;
const COLS = 25;
/** Across coordinate w spans [-W_SPAN, W_SPAN] (1 = nominal half width). */
const W_SPAN = 1.22;
const BLOCKS = 120;
/** How long after the trigger the event winds down. */
const T_END = AV_T_STOP + 26;

const GLSL = /* glsl */ `
uniform float uFront;
uniform float uTail;
uniform float uSpeed;
uniform float uTime;
uniform float uSettle;
uniform float uAlive;
attribute vec4 aTrack;
attribute vec2 aFlow;
varying float vThick;
varying float vShade;
float avHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float avNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(avHash(i), avHash(i + vec2(1.0, 0.0)), u.x), mix(avHash(i + vec2(0.0, 1.0)), avHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float avDeposit(float u, float w, float bench) {
  float lat = 1.0 - smoothstep(0.55, 1.0, abs(w) + 0.14 * avNoise(vec2(u * 0.09, w * 3.0)));
  float run = smoothstep(${(AV_UP + 8).toFixed(1)}, ${(AV_UP + 45).toFixed(1)}, u);
  float toe = smoothstep(${(AV_LENGTH - 75).toFixed(1)}, ${(AV_LENGTH - 22).toFixed(1)}, u) * (1.0 - smoothstep(${(AV_LENGTH - 14).toFixed(1)}, ${AV_LENGTH.toFixed(1)}, u));
  float lump = avNoise(vec2(u * 0.13, w * 5.0)) * 0.9 + avNoise(vec2(u * 0.45, w * 14.0)) * 0.45;
  float d = mix(0.2 + 0.25 * lump, 0.9 + 1.7 * toe + lump, run);
  d = mix(d, 0.1, bench);
  d *= smoothstep(${(AV_SLAB * 0.4).toFixed(1)}, ${AV_SLAB.toFixed(1)}, u);
  d *= 1.0 - smoothstep(${(AV_LENGTH - 6).toFixed(1)}, ${AV_LENGTH.toFixed(1)}, u);
  return d * lat;
}
float avBody(float u, float w) {
  float behind = uFront - u;
  float sp = clamp(uSpeed / 30.0, 0.0, 1.0);
  float lat = 1.0 - smoothstep(0.4, 1.0, abs(w) + 0.25 * sp * avNoise(vec2(u * 0.06 - uTime * 1.2, w * 2.5)));
  float nose = smoothstep(0.0, 6.0 + 7.0 * sp, behind);
  float headBulge = exp(-behind / 30.0) * sp;
  float churn = avNoise(vec2(u * 0.16 - uTime * 4.0 * sp, w * 5.0 + uTime * 0.6));
  float h = (0.8 + 0.4 * sp + 4.4 * headBulge) * nose * (0.75 + 0.5 * churn * (0.3 + sp));
  return h * lat;
}
float avThickness(float u, float w, float bench) {
  if (uAlive < 0.5 || u > uFront) return 0.0;
  float dep = avDeposit(u, w, bench);
  float body = mix(avBody(u, w), max(dep, 0.0), uSettle);
  float inBody = smoothstep(uTail - 6.0, uTail + 6.0, u);
  return mix(dep, body, inBody);
}
`;

/** CPU approximation of the shader thickness (no noise) for riding blocks. */
function thicknessApprox(u: number, w: number, front: number, tail: number, speed: number, settle: number): number {
  if (u > front) return 0;
  const lat = 1 - smoothstep(0.5, 1, Math.abs(w));
  const run = smoothstep(AV_UP + 8, AV_UP + 45, u);
  const dep = (0.3 + (1.2 - 0.3) * run) * lat;
  const sp = clamp(speed / 30, 0, 1);
  const behind = front - u;
  const body = (0.8 + 0.4 * sp + 4.4 * Math.exp(-behind / 30) * sp) * smoothstep(0, 6 + 7 * sp, behind) * lat;
  const b = body + (dep - body) * settle;
  const inBody = smoothstep(tail - 6, tail + 6, u);
  return dep + (b - dep) * inBody;
}

export class Avalanche {
  readonly group = new Group();
  state: 'armed' | 'running' | 'done' = 'armed';
  /** Seconds since the trigger. */
  t = 0;
  private readonly path: AvalanchePath;
  private readonly slab: Mesh;
  private readonly uniforms = {
    uFront: { value: AV_SLAB },
    uTail: { value: 0 },
    uSpeed: { value: 0 },
    uTime: { value: 0 },
    uSettle: { value: 0 },
    uAlive: { value: 0 },
  };
  private readonly rows: number;
  private readonly ground: Float32Array;
  private readonly blocks: InstancedMesh;
  private readonly bRestU = new Float32Array(BLOCKS);
  private readonly bV = new Float32Array(BLOCKS);
  private readonly bStartU = new Float32Array(BLOCKS);
  private readonly bLag = new Float32Array(BLOCKS);
  private readonly bSize = new Float32Array(BLOCKS);
  private readonly bSeed = new Float32Array(BLOCKS);
  private readonly bAxis: Vector3[] = [];
  private blocksSettled = false;
  private readonly roar = new Roar();
  private rumbleTimer = 0;
  private emitAcc = 0;
  private readonly coords: TrackCoords = { u: 0, v: 0 };
  private readonly pt = { x: 0, z: 0 };
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly p = new Vector3();
  private readonly sc = new Vector3();
  private warnedStop = false;
  private toldSettled = false;
  /** Crown and crossing positions (for sound). */
  readonly crown = new Vector3();
  readonly crossing = new Vector3();

  constructor(private readonly groundAt: (x: number, z: number) => number) {
    this.group.name = 'Avalanche';
    this.group.visible = false;
    this.path = buildAvalanchePath();
    const path = this.path;
    this.crown.set(path.x[0], groundAt(path.x[0], path.z[0]) + 2, path.z[0]);
    const c = path.crossIndex;
    this.crossing.set(path.x[c], groundAt(path.x[c], path.z[c]) + 2, path.z[c]);

    // ---- the snow mass: a grid down the track, deformed in the shader ----
    this.rows = Math.round(AV_LENGTH / ROW_STEP) + 1;
    const rows = this.rows;
    const n = rows * COLS;
    const pos = new Float32Array(n * 3);
    const nor = new Float32Array(n * 3);
    const track = new Float32Array(n * 4);
    const flow = new Float32Array(n * 2);
    this.ground = new Float32Array(n);
    const pr: Projection = { s: 0, d: 0, dist: 0, elev: 0 };
    for (let r = 0; r < rows; r++) {
      const u = r * ROW_STEP;
      const hw = avHalfWidth(u);
      const f = clamp(u / AV_STEP, 0, path.count - 1.0001);
      const i0 = Math.floor(f);
      const ft = f - i0;
      let fx = path.fx[i0] + (path.fx[i0 + 1] - path.fx[i0]) * ft;
      let fz = path.fz[i0] + (path.fz[i0 + 1] - path.fz[i0]) * ft;
      const fl = Math.hypot(fx, fz) || 1;
      fx /= fl;
      fz /= fl;
      for (let k = 0; k < COLS; k++) {
        const w = -W_SPAN + (2 * W_SPAN * k) / (COLS - 1);
        avPoint(path, u, w * hw, this.pt);
        const idx = r * COLS + k;
        const h = groundAt(this.pt.x, this.pt.z);
        this.ground[idx] = h;
        pos[idx * 3] = this.pt.x;
        pos[idx * 3 + 1] = h;
        pos[idx * 3 + 2] = this.pt.z;
        project(this.pt.x, this.pt.z, pr);
        track[idx * 4] = u;
        track[idx * 4 + 1] = w;
        track[idx * 4 + 2] = 1 - smoothstep(4, 9, pr.dist);
        track[idx * 4 + 3] = hw;
        flow[idx * 2] = fx;
        flow[idx * 2 + 1] = fz;
      }
    }
    // Terrain normals from the grid itself.
    for (let r = 0; r < rows; r++) {
      const hw = avHalfWidth(r * ROW_STEP);
      const dv = (2 * W_SPAN * hw) / (COLS - 1);
      for (let k = 0; k < COLS; k++) {
        const idx = r * COLS + k;
        const ra = Math.max(0, r - 1);
        const rb = Math.min(rows - 1, r + 1);
        const ka = Math.max(0, k - 1);
        const kb = Math.min(COLS - 1, k + 1);
        const dhdu = (this.ground[rb * COLS + k] - this.ground[ra * COLS + k]) / ((rb - ra) * ROW_STEP);
        // w grows to the left of the flow (avPoint), i.e. along S = (fz, -fx).
        const dhdv = (this.ground[r * COLS + kb] - this.ground[r * COLS + ka]) / ((kb - ka) * dv);
        const fx = flow[idx * 2];
        const fz = flow[idx * 2 + 1];
        const gx = fx * dhdu + fz * dhdv;
        const gz = fz * dhdu - fx * dhdv;
        const l = Math.hypot(gx, 1, gz);
        nor[idx * 3] = -gx / l;
        nor[idx * 3 + 1] = 1 / l;
        nor[idx * 3 + 2] = -gz / l;
      }
    }
    const index: number[] = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let k = 0; k < COLS - 1; k++) {
        const a = r * COLS + k;
        const b = a + 1;
        const c2 = a + COLS;
        const d = c2 + 1;
        // Counter-clockwise seen from above.
        index.push(a, c2, b, b, c2, d);
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new Float32BufferAttribute(nor, 3));
    geo.setAttribute('aTrack', new Float32BufferAttribute(track, 4));
    geo.setAttribute('aFlow', new Float32BufferAttribute(flow, 2));
    geo.setIndex(index);
    geo.computeBoundingSphere();
    if (geo.boundingSphere) geo.boundingSphere.radius += 14;
    // Make sure the winding faces up; flip if the first triangle points down.
    {
      const ia = index[0] * 3;
      const ib = index[1] * 3;
      const ic = index[2] * 3;
      const e1x = pos[ib] - pos[ia];
      const e1z = pos[ib + 2] - pos[ia + 2];
      const e2x = pos[ic] - pos[ia];
      const e2z = pos[ic + 2] - pos[ia + 2];
      // y of (e1 x e2) ignoring heights: e1z*e2x - e1x*e2z
      if (e1z * e2x - e1x * e2z < 0) {
        for (let i = 0; i < index.length; i += 3) {
          const tmp = index[i + 1];
          index[i + 1] = index[i + 2];
          index[i + 2] = tmp;
        }
        geo.setIndex(index);
      }
    }
    const material = new MeshStandardMaterial({
      color: new Color(0.93, 0.95, 0.98),
      roughness: 0.92,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    const uniforms = this.uniforms;
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${GLSL}`)
        .replace(
          '#include <beginnormal_vertex>',
          /* glsl */ `
          float avU = aTrack.x;
          float avW = aTrack.y;
          float avB = aTrack.z;
          float avHW = aTrack.w;
          float avH = avThickness(avU, avW, avB);
          float avHu = avThickness(avU + 1.5, avW, avB);
          float avHv = avThickness(avU, avW + 1.5 / avHW, avB);
          vec2 avS = vec2(aFlow.y, -aFlow.x);
          vec2 avGrad = aFlow * ((avHu - avH) / 1.5) + avS * ((avHv - avH) / 1.5);
          vec3 objectNormal = normalize(normal + vec3(-avGrad.x, 0.0, -avGrad.y));
          #ifdef USE_TANGENT
            vec3 objectTangent = vec3(tangent.xyz);
          #endif
          vThick = avH;
          vShade = 0.84 + 0.16 * avNoise(vec2(avU * 0.3 - uTime * 2.0 * clamp(uSpeed / 30.0, 0.0, 1.0), avW * 9.0));
          `,
        )
        .replace('#include <begin_vertex>', 'vec3 transformed = vec3(position);\ntransformed.y += avH + 0.05;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vThick;\nvarying float vShade;')
        .replace('void main() {', 'void main() {\n  if (vThick < 0.05) discard;')
        .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb *= vShade;');
    };
    material.customProgramCacheKey = () => 'expedition-avalanche-slab';
    this.slab = new Mesh(geo, material);
    this.slab.name = 'AvalancheMass';
    this.slab.receiveShadow = true;
    this.group.add(this.slab);

    // ---- snow blocks that ride the flow and come to rest as debris ----
    this.blocks = new InstancedMesh(
      lumpGeometry(31, 0.3, 1, 0.72, 0.9),
      new MeshStandardMaterial({ color: new Color(0.9, 0.93, 0.97), roughness: 0.88, flatShading: true }),
      BLOCKS,
    );
    this.blocks.name = 'AvalancheDebris';
    this.blocks.frustumCulled = false;
    this.blocks.receiveShadow = true;
    this.group.add(this.blocks);
    const rand = mulberry32(4242);
    for (let i = 0; i < BLOCKS; i++) {
      const onTrack = i >= 86;
      let u = 0;
      let v = 0;
      for (let tries = 0; tries < 20; tries++) {
        if (onTrack) u = AV_SLAB + 20 + rand() * (AV_UP - AV_SLAB - 34);
        else u = AV_DEPOSIT_START + 4 + Math.sqrt(rand()) * (AV_LENGTH - AV_DEPOSIT_START - 12);
        v = (rand() * 2 - 1) * avHalfWidth(u) * (onTrack ? 0.7 : 0.85);
        avPoint(path, u, v, this.pt);
        project(this.pt.x, this.pt.z, pr);
        if (pr.dist > 7) break;
      }
      this.bRestU[i] = u;
      this.bV[i] = v;
      this.bStartU[i] = rand() * AV_SLAB * 0.9;
      this.bLag[i] = onTrack ? 5 + rand() * 45 : rand() * Math.min(45, AV_LENGTH - u - 2);
      const toe = smoothstep(AV_LENGTH - 80, AV_LENGTH - 20, u);
      this.bSize[i] = onTrack ? 0.3 + rand() * 0.5 : 0.4 + rand() * (0.8 + 0.7 * toe);
      this.bSeed[i] = rand() * 10;
      this.bAxis.push(new Vector3(rand() - 0.5, rand() * 0.4, rand() - 0.5).normalize());
    }
    this.hideBlocks();
  }

  private hideBlocks(): void {
    this.m.makeScale(0, 0, 0);
    for (let i = 0; i < BLOCKS; i++) this.blocks.setMatrixAt(i, this.m);
    this.blocks.instanceMatrix.needsUpdate = true;
  }

  /** Track coordinates of a world point (for the director / checks). */
  coordsOf(x: number, z: number, out: TrackCoords): TrackCoords {
    return avCoords(this.path, x, z, out);
  }

  /** Ground under a track point, from the precomputed grid. */
  private groundAtTrack(u: number, v: number): number {
    const fr = clamp(u / ROW_STEP, 0, this.rows - 1.0001);
    const r = Math.floor(fr);
    const tr = fr - r;
    const w = clamp(v / avHalfWidth(u), -W_SPAN, W_SPAN);
    const fk = clamp(((w + W_SPAN) / (2 * W_SPAN)) * (COLS - 1), 0, COLS - 1.0001);
    const k = Math.floor(fk);
    const tk = fk - k;
    const g = this.ground;
    const a = g[r * COLS + k] + (g[r * COLS + k + 1] - g[r * COLS + k]) * tk;
    const b = g[(r + 1) * COLS + k] + (g[(r + 1) * COLS + k + 1] - g[(r + 1) * COLS + k]) * tk;
    return a + (b - a) * tr;
  }

  trigger(ctx: FxContext): void {
    if (this.state !== 'armed') return;
    this.state = 'running';
    this.t = 0;
    this.warnedStop = false;
    this.toldSettled = false;
    this.blocksSettled = false;
    this.emitAcc = 0;
    this.uniforms.uAlive.value = 1;
    this.group.visible = true;
    // The crack, echoing off the valley walls.
    crackAt(this.crown.x, this.crown.y, this.crown.z, 1.6, 3);
    // Fracture line: a row of puffs bursting up along the crown.
    for (let k = 0; k < 16; k++) {
      const v = (k / 15 - 0.5) * 2 * avHalfWidth(0) * 0.95;
      avPoint(this.path, 2 + Math.random() * 3, v, this.pt);
      const y = this.groundAt(this.pt.x, this.pt.z) + 0.5;
      ctx.powder.emit(this.pt.x, y, this.pt.z, 0, 3 + Math.random() * 3, 0, {
        size0: 2.5,
        size1: 9,
        life: 4 + Math.random() * 2,
        alpha: 0.7,
        drag: 1.2,
        rise: -0.2,
      });
    }
    // Where is the player relative to the path?
    avCoords(this.path, ctx.head.x, ctx.head.z, this.coords);
    const inPath =
      this.coords.u > 0 && this.coords.u < AV_LENGTH && Math.abs(this.coords.v) < avHalfWidth(this.coords.u) * 0.8 + 12;
    ctx.toast(inPath ? 'AVALANCHE! Run — get out of its path!' : 'AVALANCHE above! Get back — let it pass!', 6);
  }

  reset(): void {
    this.state = 'armed';
    this.t = 0;
    this.uniforms.uAlive.value = 0;
    this.uniforms.uFront.value = AV_SLAB;
    this.uniforms.uTail.value = 0;
    this.uniforms.uSpeed.value = 0;
    this.uniforms.uSettle.value = 0;
    this.roar.stop(0.3);
    this.hideBlocks();
    this.group.visible = false;
  }

  /** Keep the deposit visible only while the player is on the moraine. */
  setNearby(near: boolean): void {
    if (this.state === 'armed') return;
    this.group.visible = near || this.state === 'running';
  }

  update(ctx: FxContext): void {
    if (this.state !== 'running') return;
    const dt = ctx.dt;
    this.t += dt;
    const t = this.t;
    const front = avFront(t);
    const tail = avTail(t);
    const speed = avSpeed(t);
    const settle = smoothstep(AV_T_STOP - 5, AV_T_STOP + 1.5, t);
    const u = this.uniforms;
    u.uFront.value = front;
    u.uTail.value = tail;
    u.uSpeed.value = speed;
    u.uTime.value = t;
    u.uSettle.value = settle;

    if (t >= AV_T_RELEASE && !this.roar.running && t < AV_T_STOP) this.roar.start();
    this.updateBlocks(front, tail, speed, settle);
    this.emitPowder(ctx, front, tail, speed);
    this.updateSound(ctx, front, tail, speed);

    // Hazard: the player standing in the moving mass.
    avCoords(this.path, ctx.head.x, ctx.head.z, this.coords);
    const cu = this.coords.u;
    const cv = this.coords.v;
    if (!ctx.dying && ctx.head.y - ctx.floorY < 4 && avLethal(cu, cv, t)) {
      // Bury the view in powder, then respawn.
      for (let k = 0; k < 10; k++) {
        ctx.powder.emit(
          ctx.head.x + (Math.random() - 0.5) * 6,
          ctx.head.y + (Math.random() - 0.5) * 2,
          ctx.head.z + (Math.random() - 0.5) * 6,
          0,
          1,
          0,
          { size0: 4, size1: 10, life: 3, alpha: 0.9, drag: 2 },
        );
      }
      ctx.haptic(1, 400);
      ctx.engulf('Caught by the avalanche', 0.55);
    }
    // Second warning for someone walking into it before it arrives.
    if (!this.warnedStop && t > 5 && t < AV_T_CROSS + 2) {
      const edge = avHalfWidth(cu) * 0.8;
      if (cu > AV_UP - 60 && cu < AV_UP + 60 && Math.abs(cv) < edge + 22 && Math.abs(cv) > edge) {
        this.warnedStop = true;
        ctx.toast("Stop! Don't try to cross!", 3.5);
      }
    }
    if (!this.toldSettled && t > AV_T_STOP + 2) {
      this.toldSettled = true;
      ctx.toast('It is settling. Pick your way across the debris.', 5);
    }
    if (t > T_END) {
      this.state = 'done';
      this.roar.stop(2);
    }
  }

  private updateBlocks(front: number, tail: number, speed: number, settle: number): void {
    if (this.blocksSettled) return;
    const t = this.t;
    if (t < AV_T_RELEASE) return;
    const sp = clamp(speed / 30, 0, 1);
    let moving = 0;
    for (let i = 0; i < BLOCKS; i++) {
      const start = this.bStartU[i];
      const rest = this.bRestU[i];
      const cur = front - this.bLag[i];
      const uu = clamp(cur, start, rest);
      const isMoving = uu < rest - 0.01 && speed > 0.3;
      if (isMoving) moving++;
      const v = this.bV[i];
      const size = this.bSize[i];
      avPoint(this.path, uu, v, this.pt);
      const w = v / avHalfWidth(uu);
      const thick = thicknessApprox(uu, w, front, tail, speed, settle);
      const travelled = uu - start;
      const hop = isMoving ? Math.abs(Math.sin(travelled * 0.21 + this.bSeed[i] * 3)) * size * 1.6 * sp : 0;
      this.p.set(this.pt.x, this.groundAtTrack(uu, v) + thick * 0.6 + size * 0.25 + hop, this.pt.z);
      this.q.setFromAxisAngle(this.bAxis[i], travelled / (size * 0.9) + this.bSeed[i]);
      // Grow out of the slab as it breaks up, so blocks never pop in.
      const grow = clamp((t - AV_T_RELEASE) / 1.5, 0, 1);
      this.sc.set(size, size, size).multiplyScalar(grow);
      this.m.compose(this.p, this.q, this.sc);
      this.blocks.setMatrixAt(i, this.m);
    }
    this.blocks.instanceMatrix.needsUpdate = true;
    if (moving === 0 && t > AV_T_STOP + 2) this.blocksSettled = true;
  }

  private emitPowder(ctx: FxContext, front: number, tail: number, speed: number): void {
    const t = this.t;
    if (t < AV_T_RELEASE || t > AV_T_STOP + 1) return;
    const sp = clamp(speed / 30, 0, 1);
    // Rate rises with speed; the cap on the shared pool bounds the cost.
    this.emitAcc += ctx.dt * (5 + speed * 0.85);
    const path = this.path;
    while (this.emitAcc >= 1) {
      this.emitAcc -= 1;
      const atTail = Math.random() < 0.12;
      const uu = atTail ? tail + Math.random() * 20 : Math.max(0, front - Math.random() * 14);
      const w = (Math.random() * 2 - 1) * 0.95;
      const hw = avHalfWidth(uu);
      avPoint(path, uu, w * hw, this.pt);
      const f = clamp(uu / AV_STEP, 0, path.count - 1);
      const fi = Math.floor(f);
      const fx = path.fx[fi];
      const fz = path.fz[fi];
      const y = this.groundAtTrack(uu, w * hw) + 1 + Math.random() * (2 + 4 * sp);
      // Thrown forward with the head, outward to the sides, and up.
      const fwd = speed * (0.3 + Math.random() * 0.35);
      const side = w * (3 + 6 * Math.random()) * (0.4 + sp);
      const vx = fx * fwd + fz * side;
      const vz = fz * fwd - fx * side;
      const big = atTail ? 0.5 : 1;
      ctx.powder.emit(this.pt.x, y, this.pt.z, vx, 2 + Math.random() * 4 * (0.3 + sp), vz, {
        size0: (4 + Math.random() * 4) * big,
        size1: (13 + 15 * sp + Math.random() * 8) * big,
        life: 7 + Math.random() * 6,
        alpha: 0.72 + Math.random() * 0.2,
        drag: 0.55,
        rise: 0.35,
        tint: 0.94 + Math.random() * 0.06,
      });
    }
    // A last heave of powder as the toe stops.
    if (t >= AV_T_STOP - 0.5 && t - ctx.dt < AV_T_STOP - 0.5) {
      for (let k = 0; k < 24; k++) {
        avPoint(path, AV_LENGTH - Math.random() * 40, (Math.random() * 2 - 1) * avHalfWidth(AV_LENGTH) * 0.9, this.pt);
        ctx.powder.emit(this.pt.x, this.groundAt(this.pt.x, this.pt.z) + 2, this.pt.z, 0, 3 + Math.random() * 3, 0, {
          size0: 6,
          size1: 22,
          life: 8 + Math.random() * 4,
          alpha: 0.7,
          drag: 0.6,
          rise: 0.2,
        });
      }
    }
  }

  private updateSound(ctx: FxContext, front: number, tail: number, speed: number): void {
    const t = this.t;
    // Nearest point of the moving mass to the listener.
    avCoords(this.path, ctx.head.x, ctx.head.z, this.coords);
    const uu = clamp(this.coords.u, tail, front);
    const hw = avHalfWidth(uu);
    const vv = clamp(this.coords.v, -hw, hw);
    avPoint(this.path, uu, vv, this.pt);
    const gy = this.groundAtTrack(uu, vv);
    const d = listenerDistance(this.pt.x, gy, this.pt.z);
    const sp = clamp(speed / 30, 0, 1);
    const moving = t < AV_T_STOP ? 1 : Math.max(0, 1 - (t - AV_T_STOP) / 3);
    const near = 1 / (1 + d / 90);
    const level = (0.25 + 0.75 * sp) * near * 1.4 * moving * smoothstep(AV_T_RELEASE, AV_T_RELEASE + 2.5, t);
    if (this.roar.running) {
      this.roar.set(level, this.pt.x, gy, this.pt.z);
      if (t > AV_T_STOP + 3) this.roar.stop(3);
    }
    this.rumbleTimer -= ctx.dt;
    if (this.rumbleTimer <= 0 && level > 0.05) {
      this.rumbleTimer = 0.25 + Math.random() * 0.35;
      audio.rumble(Math.min(1, level * 1.2));
    }
    // Rumble the controllers as it gets close: you feel it through the ground.
    if (level > 0.22) ctx.haptic(Math.min(1, (level - 0.15) * 1.3), 120);
  }
}
