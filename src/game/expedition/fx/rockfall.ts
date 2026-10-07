/**
 * Rockfall on the night ridge.
 *
 * At ROCKFALL.triggerS stones break loose high in the gully above the path
 * at ROCKFALL.s (~70 m ahead of the player): an opening volley from above
 * the leg overhead clatters down and crosses the path ahead, striking sparks
 * and kicking up snow. The gully then stays live while the player crosses
 * it: every 6-9 s one stone is released ~56 m up the fall line, aimed a few
 * metres to one side of where a steadily walking player will be. Each stone
 * is audible (positional clatter from its release) and visible ~6 s before
 * it reaches the path, so you can stop or hurry; standing still in the
 * gully is the dangerous choice. A stone that passes through the player's
 * body capsule kills ("Struck by rockfall").
 *
 * Node check: aimed stones cross within sd ~4.5 m of their aim point at
 * ~15 m/s, 0.3-1.5 m above the bench; ~4 % hit a non-reacting walker, ~30 %
 * are near misses (< 3 m).
 */

import {
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from '@iwsdk/core';
import { mulberry32 } from '../../terrain.js';
import { expFrame } from '../exp-state.js';
import { ROCKFALL, routeFrame } from '../exp-layout.js';
import { clamp } from '../exp-route.js';
import { clatterAt, crackAt, whooshAt } from './fx-audio.js';
import type { FxContext } from './fx-context.js';
import { lumpGeometry } from './fx-geometry.js';
import {
  ROCK_END_S,
  ROCK_FAR_RELEASE,
  ROCK_GULLY_HALF,
  ROCK_LIVE_SECONDS,
  ROCK_NEAR_RELEASE,
  traceFallLine,
} from './fx-layout.js';
import { SPARK_COOL, SparkPool } from './sparks.js';
import { BODY_AWAKE, BODY_FREE, segmentDistance, TumbleSim } from './tumble-sim.js';

const ROCKS = 14;
const VOLLEY = [0.2, 0.7, 1.1, 1.6, 2.3, 9.0, 9.6, 10.4];
const MAX_AIMED = 4;
const RELEASE_LEAD = 6.0;
const GULLY_LO = ROCKFALL.s - ROCK_GULLY_HALF;
const GULLY_HI = ROCKFALL.s + ROCK_GULLY_HALF;

export class Rockfall {
  readonly group = new Group();
  state: 'armed' | 'running' | 'done' = 'armed';
  t = 0;
  readonly sparks = new SparkPool(96);
  private readonly rocks: InstancedMesh;
  private readonly sim: TumbleSim;
  private readonly fade = new Float32Array(ROCKS);
  private readonly whooshed = new Uint8Array(ROCKS);
  private volleyIndex = 0;
  private aimed = 0;
  private nextAimed = 0;
  private toldLookUp = false;
  private soundBudget = 0;
  private lastS = 0;
  private walkSpeed = 0;
  private readonly pathElev: number;
  private ctx: FxContext | null = null;
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly p = new Vector3();
  private readonly sc = new Vector3();

  constructor(private readonly groundAt: (x: number, z: number) => number) {
    this.group.name = 'Rockfall';
    this.group.visible = false;
    this.pathElev = routeFrame(ROCKFALL.s).elev;
    this.rocks = new InstancedMesh(
      lumpGeometry(808, 0.32, 1, 0.78, 0.9, 1),
      new MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, flatShading: true }),
      ROCKS,
    );
    const rand = mulberry32(77);
    const c = new Color();
    for (let i = 0; i < ROCKS; i++) {
      const k = 0.85 + rand() * 0.3;
      c.setRGB(0.36 * k, 0.34 * k, 0.32 * k);
      this.rocks.setColorAt(i, c);
    }
    this.rocks.name = 'RockfallStones';
    this.rocks.frustumCulled = false;
    this.rocks.castShadow = true;
    this.group.add(this.rocks, this.sparks.points);
    this.sim = new TumbleSim(ROCKS, {
      groundAt,
      restitution: 0.5,
      friction: 0.3,
      scatter: 0.25,
      roughness: 0.05,
      drag: 0.6,
      onImpact: (i, speed, x, y, z) => this.onImpact(i, speed, x, y, z),
    });
    this.hideAll();
  }

  private hideAll(): void {
    this.m.makeScale(0, 0, 0);
    for (let i = 0; i < ROCKS; i++) this.rocks.setMatrixAt(i, this.m);
    this.rocks.instanceMatrix.needsUpdate = true;
  }

  setNearby(near: boolean): void {
    if (this.state === 'armed') return;
    this.group.visible = near || this.state === 'running';
  }

  trigger(ctx: FxContext): void {
    if (this.state !== 'armed') return;
    this.state = 'running';
    this.t = 0;
    this.volleyIndex = 0;
    this.aimed = 0;
    this.nextAimed = 5;
    this.toldLookUp = false;
    this.lastS = ctx.s;
    this.walkSpeed = 0;
    this.sim.clear();
    this.fade.fill(0);
    this.group.visible = true;
    // The first stone breaking loose high above.
    const f = routeFrame(ROCKFALL.s);
    crackAt(f.x, f.elev + 120, f.z, 0.7, 2);
    ctx.toast('Rockfall in the gully ahead! Watch and listen, then cross quickly — never stop in it.', 7);
  }

  reset(): void {
    this.state = 'armed';
    this.t = 0;
    this.sim.clear();
    this.sparks.clear();
    this.hideAll();
    this.group.visible = false;
  }

  /** Release one stone aimed to cross the path at arc length `aimS`. */
  private release(aimS: number, distance: number, ctx: FxContext): void {
    let i = this.sim.freeIndex();
    if (i < 0) {
      // Recycle the oldest stone.
      let oldest = 0;
      for (let k = 1; k < ROCKS; k++) if (this.sim.age[k] > this.sim.age[oldest]) oldest = k;
      i = oldest;
    }
    const f = routeFrame(aimS);
    const n = Math.round(distance / 4) + 1;
    const line = traceFallLine(f.x, f.z, 1, n, 4);
    const rx = line.x[n - 1];
    const rz = line.z[n - 1];
    const dx = line.x[n - 2] - rx;
    const dz = line.z[n - 2] - rz;
    const dl = Math.hypot(dx, dz) || 1;
    const r = 0.18 + Math.random() * 0.32;
    const gy = this.groundAt(rx, rz);
    this.sim.spawn(i, rx, gy + r + 0.5, rz, (dx / dl) * 3, 1, (dz / dl) * 3, r);
    this.fade[i] = 1;
    this.whooshed[i] = 0;
    clatterAt(rx, gy, rz, 0.5, 1.2);
    ctx.powder.emit(rx, gy + 0.5, rz, 0, 1.5, 0, { size0: 1, size1: 4, life: 2.5, alpha: 0.5, drag: 1, dust: 0.6, tint: 0.85 });
  }

  update(ctx: FxContext): void {
    if (this.state === 'armed') return;
    this.ctx = ctx;
    const dt = ctx.dt;
    this.sparks.update(dt, ctx.time);
    if (this.state === 'done') return;
    this.t += dt;
    const t = this.t;
    // The player's pace along the route (smoothed), to lead aimed stones.
    const vs = dt > 0 ? (ctx.s - this.lastS) / dt : 0;
    this.lastS = ctx.s;
    this.walkSpeed += (clamp(vs, -1, 4) - this.walkSpeed) * Math.min(1, dt * 1.5);

    while (this.volleyIndex < VOLLEY.length && t >= VOLLEY[this.volleyIndex]) {
      // The second wave lands in the far half of the gully, ahead of a player
      // who is only now reaching it.
      const far = this.volleyIndex >= 5;
      const aim = far ? ROCKFALL.s + Math.random() * ROCK_GULLY_HALF : ROCKFALL.s + (Math.random() - 0.5) * 2 * ROCK_GULLY_HALF;
      this.release(aim, ROCK_FAR_RELEASE, ctx);
      this.volleyIndex++;
    }
    const live = t < ROCK_LIVE_SECONDS && ctx.s < ROCK_END_S;
    const inZone = ctx.s > GULLY_LO - 10 && ctx.s < GULLY_HI + 8;
    if (live && inZone && t >= this.nextAimed && this.aimed < MAX_AIMED) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const predicted = ctx.s + Math.max(0, this.walkSpeed) * RELEASE_LEAD;
      const aim = clamp(predicted + side * (3.5 + Math.random() * 3.5), GULLY_LO, GULLY_HI);
      this.release(aim, ROCK_NEAR_RELEASE, ctx);
      this.aimed++;
      this.nextAimed = t + 6 + Math.random() * 2.5;
      if (!this.toldLookUp) {
        this.toldLookUp = true;
        ctx.toast('Rock! Look up — keep moving!', 3);
      }
    }

    this.sim.step(dt);
    this.retire(ctx, dt);
    this.writeRocks();
    this.checkHits(ctx);
    this.soundBudget = Math.min(3, this.soundBudget + dt * 10);
    if (!live && this.sim.awake === 0 && this.sparks.live === 0) {
      this.state = 'done';
      this.hideAll();
    }
  }

  /** Stones that have left the scene shrink away and free their slot. */
  private retire(ctx: FxContext, dt: number): void {
    const sim = this.sim;
    for (let i = 0; i < ROCKS; i++) {
      if (sim.state[i] === BODY_FREE) continue;
      const gone =
        sim.state[i] !== BODY_AWAKE ||
        sim.age[i] > 22 ||
        (sim.py[i] < this.pathElev - 35 &&
          Math.hypot(sim.px[i] - ctx.head.x, sim.pz[i] - ctx.head.z) > 25);
      if (gone) {
        this.fade[i] -= dt / 0.8;
        if (this.fade[i] <= 0) {
          this.fade[i] = 0;
          sim.free(i);
        }
      }
    }
  }

  private writeRocks(): void {
    const sim = this.sim;
    for (let i = 0; i < ROCKS; i++) {
      if (sim.state[i] === BODY_FREE) {
        this.m.makeScale(0, 0, 0);
      } else {
        this.p.set(sim.px[i], sim.py[i], sim.pz[i]);
        this.q.set(sim.qx[i], sim.qy[i], sim.qz[i], sim.qw[i]);
        const r = sim.r[i] * 1.3 * this.fade[i];
        this.sc.set(r, r, r);
        this.m.compose(this.p, this.q, this.sc);
      }
      this.rocks.setMatrixAt(i, this.m);
    }
    this.rocks.instanceMatrix.needsUpdate = true;
  }

  private checkHits(ctx: FxContext): void {
    const sim = this.sim;
    const h = ctx.head;
    for (let i = 0; i < ROCKS; i++) {
      if (sim.state[i] !== BODY_AWAKE) continue;
      const speed = sim.speed(i);
      if (speed < 2.5) continue;
      const d = segmentDistance(sim.px[i], sim.py[i], sim.pz[i], h.x, ctx.floorY + 0.9, h.z, h.x, h.y + 0.1, h.z);
      if (!ctx.dying && d < sim.r[i] + 0.28) {
        ctx.haptic(1, 300);
        clatterAt(h.x, h.y, h.z, sim.r[i], 1.5);
        ctx.engulf('Struck by rockfall', 0.25);
        return;
      }
      // Near miss: the hiss of a stone going by.
      if (!this.whooshed[i] && d < 3.5 && speed > 5) {
        this.whooshed[i] = 1;
        whooshAt(sim.px[i], sim.py[i], sim.pz[i], 1.2);
        ctx.haptic(0.5, 90);
      }
    }
  }

  private onImpact(i: number, speed: number, x: number, y: number, z: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const r = this.sim.r[i];
    // Snow and grit kicked up (moonlit at night).
    ctx.powder.emit(x, y + 0.3, z, 0, 1 + speed * 0.12, 0, {
      size0: 0.8 + r,
      size1: 3 + r * 5,
      life: 2 + Math.random() * 1.5,
      alpha: 0.55,
      drag: 1.4,
      rise: -0.1,
      tint: 0.92,
      dust: 0.35,
    });
    // Rock on rock strikes sparks, which you can see at night.
    if (speed > 6 && expFrame.daylight < 0.6) {
      const n = 4 + Math.floor(Math.random() * 5);
      for (let k = 0; k < n; k++) {
        const a = Math.random() * Math.PI * 2;
        const s = 2 + Math.random() * 5;
        this.sparks.emit(x, y + 0.1, z, Math.cos(a) * s, 1 + Math.random() * 3, Math.sin(a) * s, 3, 1.6, 0.5, 0.25 + Math.random() * 0.3, 0.05, 1.5, 9.8, SPARK_COOL);
      }
    }
    if (this.soundBudget >= 1) {
      this.soundBudget -= 1;
      clatterAt(x, y, z, r, Math.min(1.2, speed / 9));
    }
  }
}
