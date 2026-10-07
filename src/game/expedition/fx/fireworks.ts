/**
 * The finale: ~60 s of fireworks over Base Camp after the landing.
 *
 * Shells climb on a whistle with a short sparkling tail and burst 80-130 m
 * up into peonies, glittering chrysanthemums, golden willows, rings,
 * crackling stars and strobes. Booms are positional and arrive late by the
 * speed of sound, so the flash comes first. The show builds to a finale
 * barrage and ends on a trio of willows. All stars share one additive point
 * pool (capped at 1800).
 */

import { Vector3 } from '@iwsdk/core';
import { boomAt, crackleAt, whistleAt } from './fx-audio.js';
import {
  SPARK_COOL,
  SPARK_CRACKLE,
  SPARK_GLITTER,
  SPARK_TWINKLE,
  SparkPool,
} from './sparks.js';

const SHELLS = 16;
const SHOW_SECONDS = 60;
const SHELL_GRAVITY = 16;

const PALETTE: Array<[number, number, number]> = [
  [4.2, 0.6, 0.45], // red
  [0.6, 3.6, 0.9], // green
  [0.7, 1.3, 4.6], // blue
  [4.0, 2.6, 0.8], // gold
  [2.9, 0.8, 4.0], // purple
  [3.6, 3.6, 3.6], // white
  [0.6, 3.1, 3.6], // cyan
  [4.2, 1.4, 0.3], // orange
];

const enum Kind {
  Peony,
  Chrysanthemum,
  Willow,
  Ring,
  Crackle,
  Strobe,
}

interface Shell {
  live: boolean;
  pos: Vector3;
  vel: Vector3;
  fuse: number;
  age: number;
  kind: Kind;
  colour: number;
  colour2: number;
  scale: number;
  trail: number;
}

export class FireworksShow {
  readonly sparks = new SparkPool(1800, 900);
  running = false;
  t = 0;
  private readonly shells: Shell[] = [];
  private readonly site = new Vector3();
  private readonly out = new Vector3(0, 0, 1);
  private nextLaunch = 0;
  private finaleDone = false;
  private groundAt: (x: number, z: number) => number;

  constructor(groundAt: (x: number, z: number) => number) {
    this.groundAt = groundAt;
    for (let i = 0; i < SHELLS; i++) {
      this.shells.push({
        live: false,
        pos: new Vector3(),
        vel: new Vector3(),
        fuse: 0,
        age: 0,
        kind: Kind.Peony,
        colour: 0,
        colour2: 0,
        scale: 1,
        trail: 0,
      });
    }
    this.sparks.points.name = 'Fireworks';
  }

  /**
   * Start the show. `centre` is the camp; `outX/outZ` the horizontal
   * direction away from the mountain, where the launch field sits.
   */
  start(centre: Vector3, outX: number, outZ: number): void {
    this.site.copy(centre);
    this.out.set(outX, 0, outZ).normalize();
    this.running = true;
    this.t = 0;
    this.nextLaunch = 1.5;
    this.finaleDone = false;
  }

  stop(): void {
    this.running = false;
    for (const s of this.shells) s.live = false;
    this.sparks.clear();
  }

  get active(): boolean {
    return this.running || this.sparks.live > 0;
  }

  private launch(kind: Kind, scale = 1): void {
    let shell: Shell | null = null;
    for (const s of this.shells) {
      if (!s.live) {
        shell = s;
        break;
      }
    }
    if (!shell) return;
    const lateral = (Math.random() - 0.5) * 70;
    const dist = 75 + Math.random() * 25;
    const x = this.site.x + this.out.x * dist - this.out.z * lateral;
    const z = this.site.z + this.out.z * dist + this.out.x * lateral;
    const y = this.groundAt(x, z) + 1;
    const h = 80 + Math.random() * 50 * scale;
    const vy = Math.sqrt(2 * SHELL_GRAVITY * h);
    shell.live = true;
    shell.pos.set(x, y, z);
    // A slight lean back toward the camp so bursts fill the sky above it.
    shell.vel.set(-this.out.x * 3 + (Math.random() - 0.5) * 3, vy, -this.out.z * 3 + (Math.random() - 0.5) * 3);
    shell.fuse = (vy / SHELL_GRAVITY) * (0.9 + Math.random() * 0.08);
    shell.age = 0;
    shell.kind = kind;
    shell.colour = Math.floor(Math.random() * PALETTE.length);
    shell.colour2 = Math.random() < 0.4 ? Math.floor(Math.random() * PALETTE.length) : shell.colour;
    shell.scale = scale;
    shell.trail = 0;
    whistleAt(x, y + 10, z, shell.fuse * 0.85, 0.8);
  }

  private randomKind(): Kind {
    const r = Math.random();
    if (r < 0.28) return Kind.Peony;
    if (r < 0.46) return Kind.Chrysanthemum;
    if (r < 0.6) return Kind.Willow;
    if (r < 0.72) return Kind.Ring;
    if (r < 0.88) return Kind.Crackle;
    return Kind.Strobe;
  }

  private schedule(): void {
    const t = this.t;
    if (t >= SHOW_SECONDS - 6) {
      if (!this.finaleDone) {
        this.finaleDone = true;
        for (let k = 0; k < 3; k++) this.launch(Kind.Willow, 1.25);
      }
      this.nextLaunch = Infinity;
      return;
    }
    if (t > SHOW_SECONDS - 18) {
      // Finale barrage.
      this.launch(this.randomKind(), 1.1);
      if (Math.random() < 0.5) this.launch(Math.random() < 0.5 ? Kind.Peony : Kind.Crackle, 1);
      this.nextLaunch = t + 0.35 + Math.random() * 0.3;
    } else if (t < 8) {
      this.launch(t < 3 ? Kind.Peony : this.randomKind());
      this.nextLaunch = t + 2 + Math.random() * 0.6;
    } else {
      this.launch(this.randomKind());
      if (Math.random() < 0.25) this.launch(this.randomKind());
      this.nextLaunch = t + 1.3 + Math.random() * 1.2;
    }
  }

  private burst(s: Shell): void {
    const sp = this.sparks;
    const [r, g, b] = PALETTE[s.colour];
    const [r2, g2, b2] = PALETTE[s.colour2];
    const x = s.pos.x;
    const y = s.pos.y;
    const z = s.pos.z;
    const k = s.scale;
    // The flash.
    for (let i = 0; i < 4; i++) sp.emit(x, y, z, 0, 0, 0, 5, 4.5, 3.5, 0.12, 9 * k, 0, 0, 0);
    switch (s.kind) {
      case Kind.Peony:
      case Kind.Chrysanthemum: {
        const n = Math.round(110 * k);
        const glitter = s.kind === Kind.Chrysanthemum;
        for (let i = 0; i < n; i++) {
          const u = Math.random() * 2 - 1;
          const a = Math.random() * Math.PI * 2;
          const q = Math.sqrt(1 - u * u);
          const v = (17 + Math.random() * 3) * k;
          const two = i % 2 === 0;
          sp.emit(
            x, y, z,
            Math.cos(a) * q * v, u * v, Math.sin(a) * q * v,
            two ? r : r2, two ? g : g2, two ? b : b2,
            1.7 + Math.random() * 0.6, 1.3, 1.1, 3,
            (glitter && i % 3 === 0 ? SPARK_GLITTER : 0) | (Math.random() < 0.2 ? SPARK_TWINKLE : 0),
          );
        }
        break;
      }
      case Kind.Willow: {
        const n = Math.round(80 * k);
        for (let i = 0; i < n; i++) {
          const u = Math.random() * 2 - 1;
          const a = Math.random() * Math.PI * 2;
          const q = Math.sqrt(1 - u * u);
          const v = (15 + Math.random() * 3) * k;
          sp.emit(
            x, y, z,
            Math.cos(a) * q * v, u * v + 2, Math.sin(a) * q * v,
            3.6, 2.2, 0.7,
            3.6 + Math.random() * 1.2, 1.2, 1.7, 2.2,
            SPARK_COOL | (i % 4 === 0 ? SPARK_GLITTER : 0),
          );
        }
        break;
      }
      case Kind.Ring: {
        const n = Math.round(70 * k);
        // Random ring plane.
        const ax = Math.random() - 0.5;
        const ay = Math.random() * 0.6 + 0.4;
        const az = Math.random() - 0.5;
        const al = Math.hypot(ax, ay, az);
        const nx = ax / al;
        const ny = ay / al;
        const nz = az / al;
        // Two unit vectors spanning the plane.
        let ux = ny;
        let uy = -nx;
        let uz = 0;
        const ul = Math.hypot(ux, uy, uz) || 1;
        ux /= ul;
        uy /= ul;
        uz /= ul;
        const wx = ny * uz - nz * uy;
        const wy = nz * ux - nx * uz;
        const wz = nx * uy - ny * ux;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          const c = Math.cos(a);
          const sn = Math.sin(a);
          const v = 19 * k;
          sp.emit(
            x, y, z,
            (ux * c + wx * sn) * v, (uy * c + wy * sn) * v, (uz * c + wz * sn) * v,
            r, g, b, 1.8 + Math.random() * 0.3, 1.4, 1.1, 3, 0,
          );
        }
        // A contrasting core.
        for (let i = 0; i < 20; i++) {
          const u = Math.random() * 2 - 1;
          const a = Math.random() * Math.PI * 2;
          const q = Math.sqrt(1 - u * u);
          const v = 6;
          sp.emit(x, y, z, Math.cos(a) * q * v, u * v, Math.sin(a) * q * v, r2, g2, b2, 1.2, 1.1, 1.5, 3, SPARK_TWINKLE);
        }
        break;
      }
      case Kind.Crackle: {
        const n = Math.round(70 * k);
        for (let i = 0; i < n; i++) {
          const u = Math.random() * 2 - 1;
          const a = Math.random() * Math.PI * 2;
          const q = Math.sqrt(1 - u * u);
          const v = (13 + Math.random() * 4) * k;
          sp.emit(
            x, y, z,
            Math.cos(a) * q * v, u * v, Math.sin(a) * q * v,
            3.8, 3.0, 1.6, 1.1 + Math.random() * 0.6, 1.1, 1.3, 3, SPARK_CRACKLE,
          );
        }
        // The crackle arrives with the stars' deaths (sound delay applied inside).
        crackleAt(x, y, z, 1, 30);
        break;
      }
      case Kind.Strobe: {
        const n = Math.round(60 * k);
        for (let i = 0; i < n; i++) {
          const u = Math.random() * 2 - 1;
          const a = Math.random() * Math.PI * 2;
          const q = Math.sqrt(1 - u * u);
          const v = (12 + Math.random() * 6) * k;
          sp.emit(x, y, z, Math.cos(a) * q * v, u * v, Math.sin(a) * q * v, 3.6, 3.6, 3.8, 2.4 + Math.random(), 1.2, 1.3, 2.5, SPARK_TWINKLE);
        }
        break;
      }
    }
    boomAt(x, y, z, 1.3 * k, 90);
  }

  update(dt: number, time: number): void {
    if (this.running) {
      this.t += dt;
      if (this.t >= this.nextLaunch) this.schedule();
      if (this.t > SHOW_SECONDS + 8) this.running = false;
    }
    for (const s of this.shells) {
      if (!s.live) continue;
      s.age += dt;
      s.vel.y -= SHELL_GRAVITY * dt;
      s.pos.addScaledVector(s.vel, dt);
      // A short sparkling tail behind the rising shell.
      s.trail -= dt;
      if (s.trail <= 0) {
        s.trail = 0.05;
        this.sparks.emit(
          s.pos.x, s.pos.y, s.pos.z,
          (Math.random() - 0.5) * 1.5, -3, (Math.random() - 0.5) * 1.5,
          3.2, 1.8, 0.6, 0.45 + Math.random() * 0.3, 0.7, 1.5, 6, SPARK_COOL,
        );
      }
      if (s.age >= s.fuse) {
        s.live = false;
        this.burst(s);
      }
    }
    this.sparks.update(dt, time);
  }
}
