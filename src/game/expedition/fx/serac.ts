/**
 * The serac collapse on the glacier.
 *
 * At SERAC.triggerS the ice tower beside the path (see `seracTower()` in
 * fx-layout.ts; ~26 m uphill of the route at SERAC.s) cracks with a few
 * sharp reports while ice dust sifts off its face, then leans, accelerates
 * and topples down the fall line toward the path, shattering into ~60
 * tumbling ice blocks and a rolling powder cloud that spills across the
 * route and on downhill. The player is ~60 m away when it falls, so it is
 * a spectacle; it only kills someone standing in its fall footprint or in
 * front of a big block.
 *
 * The world builder owns the standing serac mesh; when it installs
 * `fxHooks.setSeracVisible` we hide theirs at the trigger and topple our
 * own copy (built here, so we never depend on their geometry).
 */

import {
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from '@iwsdk/core';
import { mulberry32 } from '../../terrain.js';
import { project, type Projection, SUMMIT_X, SUMMIT_Z } from '../exp-route.js';
import { boomAt, crackAt, noiseAt, Roar, shatterAt, toneAt, clatterAt, listenerDistance } from './fx-audio.js';
import { type FxContext, fxHooks } from './fx-context.js';
import { colourGeometry, lumpGeometry, mergeGeometries } from './fx-geometry.js';
import { SERAC_T_LEAN, type SeracTower, seracTower } from './fx-layout.js';
import { BODY_ASLEEP, BODY_AWAKE, segmentDistance, TumbleSim } from './tumble-sim.js';

const BLOCKS = 64;
const SINK = 1.5;
const T_MAX = 40;

export class SeracCollapse {
  readonly group = new Group();
  readonly tower: SeracTower;
  state: 'armed' | 'running' | 'done' = 'armed';
  t = 0;
  private readonly pivot = new Group();
  private readonly towerMesh: Mesh;
  private readonly blocks: InstancedMesh;
  private readonly sim: TumbleSim;
  private readonly baseY: number;
  private readonly fullHeight: number;
  private theta = 0;
  private omega = 0;
  private fallen = false;
  private cracks = 0;
  private readonly roar = new Roar();
  private soundBudget = 0;
  private puffAcc = 0;
  private ctx: FxContext | null = null;
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly p = new Vector3();
  private readonly sc = new Vector3();
  private readonly pr: Projection = { s: 0, d: 0, dist: 0, elev: 0 };
  /** Horizontal unit vector across the fall direction (local +X). */
  private readonly ax: number;
  private readonly az: number;

  constructor(private readonly groundAt: (x: number, z: number) => number) {
    this.group.name = 'SeracCollapse';
    this.group.visible = false;
    const tw = seracTower(groundAt);
    this.tower = tw;
    this.ax = Math.cos(tw.yaw);
    this.az = -Math.sin(tw.yaw);
    // Sink the foot below the lowest corner of the footprint.
    let low = Infinity;
    for (const sx of [-0.5, 0.5]) {
      for (const sz of [0, -1]) {
        const x = tw.x + this.ax * sx * tw.width + tw.fallX * sz * tw.depth;
        const z = tw.z + this.az * sx * tw.width + tw.fallZ * sz * tw.depth;
        low = Math.min(low, groundAt(x, z));
      }
    }
    this.baseY = low - SINK;
    this.fullHeight = tw.height + (tw.baseY - this.baseY);

    // ---- the tower: stacked, jittered ice slabs with a snow cap ----
    const rand = mulberry32(9071);
    const ice = new Color(0.6, 0.8, 0.9);
    const deep = new Color(0.42, 0.66, 0.8);
    const snow = new Color(0.93, 0.95, 0.98);
    const parts: Array<{ geo: ReturnType<typeof lumpGeometry>; matrix: Matrix4 }> = [];
    const layers = 6;
    const segH = this.fullHeight / layers;
    for (let k = 0; k < layers; k++) {
      const taper = 1 - (k / layers) * 0.22;
      for (let j = 0; j < 2; j++) {
        const geo = colourGeometry(lumpGeometry(100 + k * 7 + j, 0.22, 1, 1, 1, 1), j ? deep : ice, 0.12, k * 13 + j);
        const w = tw.width * taper * (0.5 + rand() * 0.12);
        const d = tw.depth * taper * (0.48 + rand() * 0.1);
        const m = new Matrix4()
          .makeRotationY((rand() - 0.5) * 0.4)
          .scale(new Vector3(w, segH * 0.75, d))
          .setPosition((j ? 1 : -1) * tw.width * 0.18 + (rand() - 0.5) * 0.8, segH * (k + 0.55), -tw.depth / 2 + (rand() - 0.5) * 0.9);
        parts.push({ geo, matrix: m });
      }
    }
    parts.push({
      geo: colourGeometry(lumpGeometry(777, 0.25, 1, 0.45, 1, 1), snow, 0.05, 5),
      matrix: new Matrix4()
        .makeScale(tw.width * 0.48, 1.8, tw.depth * 0.5)
        .setPosition(0, this.fullHeight + 0.3, -tw.depth / 2),
    });
    this.towerMesh = new Mesh(
      mergeGeometries(parts),
      new MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.28,
        metalness: 0.02,
        flatShading: true,
        emissive: new Color(0.02, 0.07, 0.11),
      }),
    );
    this.towerMesh.name = 'FallingSerac';
    this.towerMesh.castShadow = true;
    this.towerMesh.receiveShadow = true;
    this.pivot.position.set(tw.x, this.baseY, tw.z);
    this.pivot.rotation.order = 'YXZ';
    this.pivot.rotation.y = tw.yaw;
    this.pivot.add(this.towerMesh);
    this.group.add(this.pivot);

    // ---- shattered blocks ----
    this.blocks = new InstancedMesh(
      lumpGeometry(55, 0.35, 1, 0.8, 0.9),
      new MeshStandardMaterial({
        color: new Color(0.68, 0.86, 0.94),
        roughness: 0.25,
        metalness: 0.02,
        flatShading: true,
        emissive: new Color(0.02, 0.06, 0.1),
      }),
      BLOCKS,
    );
    this.blocks.name = 'SeracBlocks';
    this.blocks.frustumCulled = false;
    this.blocks.castShadow = true;
    this.group.add(this.blocks);

    const pr = this.pr;
    this.sim = new TumbleSim(BLOCKS, {
      groundAt,
      restitution: 0.28,
      friction: 0.55,
      scatter: 0.18,
      roughness: 0.03,
      drag: 0.7,
      onImpact: (i, speed, x, y, z) => this.onImpact(i, speed, x, y, z),
      // Blocks never come to rest on the path: they slide off downhill.
      nudge: (x, z, out) => {
        project(x, z, pr);
        if (pr.dist > 5.5) return false;
        const r = Math.hypot(x - SUMMIT_X, z - SUMMIT_Z) || 1;
        out.x = ((x - SUMMIT_X) / r) * 5;
        out.z = ((z - SUMMIT_Z) / r) * 5;
        return true;
      },
    });
    this.hideBlocks();
  }

  private hideBlocks(): void {
    this.m.makeScale(0, 0, 0);
    for (let i = 0; i < BLOCKS; i++) this.blocks.setMatrixAt(i, this.m);
    this.blocks.instanceMatrix.needsUpdate = true;
  }

  /** Show the standing tower (only when the world builder doesn't own one). */
  setNearby(near: boolean): void {
    const ownTower = fxHooks.setSeracVisible === null;
    if (this.state === 'armed') {
      this.group.visible = near && ownTower;
      this.towerMesh.visible = true;
      return;
    }
    this.group.visible = near || this.state === 'running';
  }

  trigger(ctx: FxContext): void {
    if (this.state !== 'armed') return;
    this.state = 'running';
    this.t = 0;
    this.theta = 0;
    this.omega = 0;
    this.fallen = false;
    this.cracks = 0;
    this.puffAcc = 0;
    this.sim.clear();
    this.hideBlocks();
    fxHooks.setSeracVisible?.(false);
    this.group.visible = true;
    this.towerMesh.visible = true;
    this.pivot.rotation.x = 0;
    ctx.toast('The serac is cracking! Keep clear of the ice tower.', 5);
  }

  reset(): void {
    this.state = 'armed';
    this.t = 0;
    this.theta = 0;
    this.omega = 0;
    this.fallen = false;
    this.pivot.rotation.x = 0;
    this.towerMesh.visible = true;
    this.sim.clear();
    this.hideBlocks();
    this.roar.stop(0.3);
    this.group.visible = false;
    fxHooks.setSeracVisible?.(true);
  }

  /** World position of a point in the tower's local frame at the current lean. */
  private local(y: number, z: number, x: number, out: Vector3): Vector3 {
    const c = Math.cos(this.theta);
    const s = Math.sin(this.theta);
    const yr = y * c - z * s;
    const zr = y * s + z * c;
    const tw = this.tower;
    return out.set(tw.x + tw.fallX * zr + this.ax * x, this.baseY + yr, tw.z + tw.fallZ * zr + this.az * x);
  }

  update(ctx: FxContext): void {
    if (this.state !== 'running') return;
    this.ctx = ctx;
    const dt = ctx.dt;
    const prev = this.t;
    this.t += dt;
    const t = this.t;
    const tw = this.tower;
    const top = this.local(this.fullHeight, -tw.depth / 2, 0, this.p);
    const topX = top.x;
    const topY = top.y;
    const topZ = top.z;

    if (!this.fallen) {
      // Cracking: reports, a shiver, ice dust sifting off the face.
      const crackTimes = [0, 1.3, 2.5, SERAC_T_LEAN - 0.15];
      while (this.cracks < crackTimes.length && t >= crackTimes[this.cracks]) {
        crackAt(topX, topY - 6 - this.cracks * 3, topZ, 0.8 + this.cracks * 0.25, this.cracks === 0 ? 2 : 1);
        this.cracks++;
      }
      this.puffAcc += dt * (t < SERAC_T_LEAN ? 4 : 14);
      while (this.puffAcc >= 1) {
        this.puffAcc -= 1;
        const yy = this.fullHeight * (0.35 + Math.random() * 0.65);
        this.local(yy, -Math.random() * 0.5, (Math.random() - 0.5) * tw.width, this.p);
        ctx.powder.emit(this.p.x, this.p.y, this.p.z, tw.fallX * 1.5, -2 - Math.random() * 3, tw.fallZ * 1.5, {
          size0: 1,
          size1: 4,
          life: 2.5 + Math.random(),
          alpha: 0.55,
          drag: 0.8,
          rise: -2,
        });
      }
      if (t >= SERAC_T_LEAN) {
        if (prev < SERAC_T_LEAN) {
          // The groan of the base giving way.
          toneAt(tw.x, this.baseY + 4, tw.z, 70, 38, 2.2, 0.5, 'sawtooth', 50, 0, 0.4);
          noiseAt(tw.x, this.baseY + 4, tw.z, 300, 2, 2.4, 0.5, 'bandpass', 50, 0, 0.5);
          this.roar.start();
        }
        // Rigid toppling about the downhill foot edge.
        const k = (3 * 9.81) / (2 * this.fullHeight);
        this.omega += k * (Math.sin(this.theta) + 0.07) * dt;
        this.theta += this.omega * dt;
        this.pivot.rotation.x = this.theta;
        const d = listenerDistance(topX, topY, topZ);
        this.roar.set(Math.min(1, this.theta * 0.7) / (1 + d / 80), topX, topY, topZ);
        const ground = this.groundAt(topX, topZ);
        if (topY < ground + 1.5 || this.theta > 1.9) this.shatter(ctx);
      } else {
        // A slight shiver as it cracks (the tower moves, never the camera).
        this.pivot.rotation.x = Math.max(0, Math.sin(t * 41) * 0.003 * Math.min(1, t / 2));
      }
    } else {
      this.sim.step(dt);
      this.writeBlocks();
      this.checkBlocks(ctx);
      if (this.roar.running) {
        const fade = Math.max(0, 1 - (t - this.fallTime) / 4);
        const d = listenerDistance(tw.x, this.baseY, tw.z);
        this.roar.set(fade / (1 + d / 80), tw.x, this.baseY, tw.z);
        if (fade <= 0) this.roar.stop(1);
      }
      if (this.sim.awake === 0 || t > T_MAX) {
        this.state = 'done';
        this.roar.stop(1.5);
      }
    }
    this.soundBudget = Math.min(3, this.soundBudget + dt * 12);
  }

  private fallTime = 0;

  private shatter(ctx: FxContext): void {
    this.fallen = true;
    this.fallTime = this.t;
    this.towerMesh.visible = false;
    const tw = this.tower;
    const rand = Math.random;
    // Break the tower into a lattice of blocks moving with the fall.
    let i = 0;
    const rows = 8;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < 3; c++) {
        for (let l = 0; l < 2; l++) {
          if (i >= BLOCKS) break;
          const y = ((r + 0.5) / rows) * this.fullHeight;
          const z = -((l + 0.5) / 2) * tw.depth;
          const x = ((c - 1) / 3) * tw.width;
          this.spawnBlock(i++, y, z, x, (0.75 + rand() * 0.55) * (r > 5 ? 0.85 : 1.05), rand);
        }
      }
    }
    while (i < BLOCKS) {
      const y = rand() * this.fullHeight;
      this.spawnBlock(i++, y, -rand() * tw.depth, (rand() - 0.5) * tw.width, 0.22 + rand() * 0.35, rand);
    }
    // The impact: a boom, breaking glass, and powder rolling downhill.
    const cx = tw.x + tw.fallX * this.fullHeight * 0.55;
    const cz = tw.z + tw.fallZ * this.fullHeight * 0.55;
    const cy = this.groundAt(cx, cz) + 2;
    boomAt(cx, cy, cz, 1.7, 70);
    shatterAt(cx, cy, cz, 1.6);
    for (let k = 0; k < 90; k++) {
      const along = rand() * this.fullHeight * 1.1;
      const across = (rand() - 0.5) * tw.width * 1.6;
      const x = tw.x + tw.fallX * along + this.ax * across;
      const z = tw.z + tw.fallZ * along + this.az * across;
      const sp = 5 + rand() * 9;
      ctx.powder.emit(
        x,
        this.groundAt(x, z) + 1 + rand() * 4,
        z,
        tw.fallX * sp + this.ax * across * 0.5,
        2 + rand() * 5,
        tw.fallZ * sp + this.az * across * 0.5,
        { size0: 4 + rand() * 4, size1: 16 + rand() * 14, life: 7 + rand() * 6, alpha: 0.78, drag: 0.5, rise: 0.3 },
      );
    }
    const d = listenerDistance(cx, cy, cz);
    ctx.haptic(Math.min(1, 1.6 / (1 + d / 30)), 350);
    // Standing right under it?
    const hx = ctx.head.x - tw.x;
    const hz = ctx.head.z - tw.z;
    const along = hx * tw.fallX + hz * tw.fallZ;
    const across = hx * this.ax + hz * this.az;
    if (
      !ctx.dying &&
      along > -2 &&
      along < this.fullHeight + 2 &&
      Math.abs(across) < tw.width / 2 + 1.5 &&
      ctx.head.y - ctx.floorY < 4
    ) {
      ctx.engulf('Crushed by the collapsing serac', 0.35);
    }
  }

  private spawnBlock(i: number, y: number, z: number, x: number, radius: number, rand: () => number): void {
    const w = this.omega * 0.7;
    const c = Math.cos(this.theta);
    const s = Math.sin(this.theta);
    const yr = y * c - z * s;
    const zr = y * s + z * c;
    // Velocity of that point of the rotating tower (+ the shatter).
    const vAlong = w * yr + (rand() - 0.3) * 3;
    const vUp = -w * zr * 0.4 + 1.5 + rand() * 4;
    const vAcross = (rand() - 0.5) * 5;
    const tw = this.tower;
    this.local(y, z, x, this.p);
    const gy = this.groundAt(this.p.x, this.p.z);
    this.sim.spawn(
      i,
      this.p.x,
      Math.max(this.p.y, gy + radius + 0.1),
      this.p.z,
      tw.fallX * vAlong + this.ax * vAcross,
      vUp,
      tw.fallZ * vAlong + this.az * vAcross,
      radius,
    );
  }

  private writeBlocks(): void {
    const sim = this.sim;
    for (let i = 0; i < BLOCKS; i++) {
      if (sim.state[i] !== BODY_AWAKE && sim.state[i] !== BODY_ASLEEP) continue;
      this.p.set(sim.px[i], sim.py[i], sim.pz[i]);
      this.q.set(sim.qx[i], sim.qy[i], sim.qz[i], sim.qw[i]);
      const r = sim.r[i] * 1.25;
      this.sc.set(r, r, r);
      this.m.compose(this.p, this.q, this.sc);
      this.blocks.setMatrixAt(i, this.m);
    }
    this.blocks.instanceMatrix.needsUpdate = true;
  }

  private checkBlocks(ctx: FxContext): void {
    if (ctx.dying) return;
    const sim = this.sim;
    const h = ctx.head;
    for (let i = 0; i < BLOCKS; i++) {
      if (sim.state[i] !== BODY_AWAKE || sim.r[i] < 0.3) continue;
      if (sim.speed(i) < 3) continue;
      const d = segmentDistance(sim.px[i], sim.py[i], sim.pz[i], h.x, ctx.floorY + 0.4, h.z, h.x, h.y + 0.1, h.z);
      if (d < sim.r[i] * 1.1 + 0.3) {
        ctx.haptic(1, 300);
        ctx.engulf('Hit by falling ice', 0.3);
        return;
      }
    }
  }

  private onImpact(i: number, speed: number, x: number, y: number, z: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const r = this.sim.r[i];
    if (speed > 4 && Math.random() < 0.6) {
      ctx.powder.emit(x, y + r, z, 0, 1.5 + Math.random() * 2, 0, {
        size0: 1.5 + r,
        size1: 5 + r * 4,
        life: 2.5 + Math.random() * 1.5,
        alpha: 0.6,
        drag: 1.2,
        rise: 0.1,
      });
    }
    if (this.soundBudget >= 1) {
      this.soundBudget -= 1;
      const v = Math.min(1, speed / 10) * Math.min(1.3, 0.4 + r);
      if (r > 0.6) clatterAt(x, y, z, r, v * 0.8);
      else shatterAt(x, y, z, v * 0.5);
    }
  }
}
