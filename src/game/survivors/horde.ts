/**
 * Snow Survivors' horde, as columns of numbers (after Factory Fight's
 * factory/horde.ts): thousands of enemies are not objects, each field is one
 * typed array and an enemy is an index into all of them. Live ones are
 * packed into [0, n); a death only marks `dead`, and `sweep()` packs the
 * survivors down once a frame, so an index stays good for the whole frame.
 *
 * Each frame everyone walks at the player, each with its own pace and lean
 * so the crowd fans out into a tide rather than filing in on one line. A
 * coarse density grid around the player pushes them apart (each one steps
 * down the crowd's slope, the cheap way to keep thousands from stacking up),
 * and a spatial hash answers "who is near here" for the weapons without any
 * of them walking all n.
 */

/** Most enemies alive at once. */
export const CAP = 3000;

export interface Kind {
  name: string;
  /** Body radius (m) at scale 1. */
  radius: number;
  /** Walking speed (m/s). */
  speed: number;
  /** Hit points at the start of a run (they grow with time). */
  hp: number;
  /** Damage per second while biting you. */
  dps: number;
  /** Experience its crystal is worth. */
  xp: number;
  neon: number;
}

export const KINDS: Kind[] = [
  // The ghoul: skittering, frail, endless.
  { name: 'ghoul', radius: 0.42, speed: 2.4, hp: 5, dps: 7, xp: 1, neon: 0xff2d55 },
  // The brute: a shelled thing that takes a volley or five.
  { name: 'brute', radius: 0.7, speed: 1.7, hp: 28, dps: 12, xp: 4, neon: 0xb64dff },
  // The titan: an elite. Always drops something worth walking to.
  { name: 'titan', radius: 1.45, speed: 1.2, hp: 240, dps: 26, xp: 25, neon: 0xff9a1f },
];

/** Crowd and hash grid: cell edge (m) and cells per side, centred on the player. */
const CELL = 1.0;
const SIDE = 128;
const CELLS = SIDE * SIDE;

export class Horde {
  n = 0;
  readonly kind = new Uint8Array(CAP);
  readonly dead = new Uint8Array(CAP);
  readonly x = new Float32Array(CAP);
  readonly z = new Float32Array(CAP);
  readonly hp = new Float32Array(CAP);
  readonly heading = new Float32Array(CAP);
  /** Size, as a share of its kind's (elites come a little bigger). */
  readonly scale = new Float32Array(CAP);
  /** Its pace (share of its kind's speed) and lean off the straight line (rad). */
  readonly pace = new Float32Array(CAP);
  readonly veer = new Float32Array(CAP);
  /** Distance walked (the legs' cycle). */
  readonly stride = new Float32Array(CAP);
  /** Hit flash (s left) and burning/frozen tint (s left). */
  readonly flash = new Float32Array(CAP);
  readonly burn = new Float32Array(CAP);
  /** Climbing out of the snow, 0 → 1. */
  readonly rise = new Float32Array(CAP);
  /** Biting you (0..1, eased). */
  readonly bite = new Float32Array(CAP);
  /** Knockback velocity and seconds of it left. */
  readonly kvx = new Float32Array(CAP);
  readonly kvz = new Float32Array(CAP);
  readonly kT = new Float32Array(CAP);
  /** Per-enemy cooldown for the orbiting blades (s), so one pass is one hit. */
  readonly bladeCd = new Float32Array(CAP);
  /** Drops something (an upgrade orb) when it dies. */
  readonly carrier = new Uint8Array(CAP);

  /** Crowd density per cell, and the hash: first enemy per cell, next in cell. */
  private readonly density = new Float32Array(CELLS);
  private readonly head = new Int32Array(CELLS);
  private readonly next = new Int32Array(CAP);
  private ox = 0;
  private oz = 0;

  spawn(kind: number, x: number, z: number, hpScale: number, scale = 1): number {
    if (this.n >= CAP) return -1;
    const i = this.n++;
    const k = KINDS[kind];
    this.kind[i] = kind;
    this.dead[i] = 0;
    this.x[i] = x;
    this.z[i] = z;
    this.hp[i] = k.hp * hpScale * scale * scale;
    this.heading[i] = Math.random() * Math.PI * 2;
    this.scale[i] = scale;
    this.pace[i] = 0.82 + Math.random() * 0.36;
    this.veer[i] = (Math.random() - 0.5) * 0.7;
    this.stride[i] = Math.random() * 10;
    this.flash[i] = 0;
    this.burn[i] = 0;
    this.rise[i] = 0;
    this.bite[i] = 0;
    this.kT[i] = 0;
    this.bladeCd[i] = 0;
    this.carrier[i] = 0;
    return i;
  }

  /** Pack the living down to [0, n). */
  sweep(): void {
    let w = 0;
    for (let r = 0; r < this.n; r++) {
      if (this.dead[r]) continue;
      if (w !== r) this.copy(r, w);
      w++;
    }
    this.n = w;
  }

  private copy(from: number, to: number): void {
    this.kind[to] = this.kind[from];
    this.dead[to] = 0;
    this.x[to] = this.x[from];
    this.z[to] = this.z[from];
    this.hp[to] = this.hp[from];
    this.heading[to] = this.heading[from];
    this.scale[to] = this.scale[from];
    this.pace[to] = this.pace[from];
    this.veer[to] = this.veer[from];
    this.stride[to] = this.stride[from];
    this.flash[to] = this.flash[from];
    this.burn[to] = this.burn[from];
    this.rise[to] = this.rise[from];
    this.bite[to] = this.bite[from];
    this.kvx[to] = this.kvx[from];
    this.kvz[to] = this.kvz[from];
    this.kT[to] = this.kT[from];
    this.bladeCd[to] = this.bladeCd[from];
    this.carrier[to] = this.carrier[from];
  }

  clear(): void {
    this.n = 0;
  }

  radius(i: number): number {
    return KINDS[this.kind[i]].radius * this.scale[i];
  }

  /**
   * Everyone steps toward (px, pz): down the crowd's slope, round the
   * player rather than through, knocked back when hit. Returns the damage
   * per second the biters are doing to the player.
   */
  step(dt: number, px: number, pz: number, speedScale: number): number {
    this.rebuild(px, pz);
    let dps = 0;
    const { x, z, density } = this;
    for (let i = 0; i < this.n; i++) {
      if (this.dead[i]) continue;
      const k = KINDS[this.kind[i]];
      const r = k.radius * this.scale[i];
      this.flash[i] = Math.max(0, this.flash[i] - dt);
      this.burn[i] = Math.max(0, this.burn[i] - dt);
      this.bladeCd[i] = Math.max(0, this.bladeCd[i] - dt);
      if (this.rise[i] < 1) {
        // Clawing out of the snow first.
        this.rise[i] = Math.min(1, this.rise[i] + dt * 1.6);
        continue;
      }
      const dx = px - x[i];
      const dz = pz - z[i];
      const d = Math.hypot(dx, dz) || 1e-3;
      const reach = r + 0.45;
      let mx = 0;
      let mz = 0;
      if (this.kT[i] > 0) {
        this.kT[i] -= dt;
        mx = this.kvx[i];
        mz = this.kvz[i];
      } else if (d > reach) {
        // Lean off the line a little (less as it closes in).
        const lean = this.veer[i] * Math.min(1, d / 12);
        const c = Math.cos(lean);
        const s = Math.sin(lean);
        const ux = dx / d;
        const uz = dz / d;
        const v = k.speed * this.pace[i] * speedScale * (this.burn[i] > 0 ? 0.55 : 1);
        mx = (ux * c - uz * s) * v;
        mz = (ux * s + uz * c) * v;
      }
      // Down the crowd's slope.
      const cx = Math.floor((x[i] - this.ox) / CELL);
      const cz = Math.floor((z[i] - this.oz) / CELL);
      if (cx > 0 && cz > 0 && cx < SIDE - 1 && cz < SIDE - 1) {
        const c = cz * SIDE + cx;
        const gx = density[c + 1] - density[c - 1];
        const gz = density[c + SIDE] - density[c - SIDE];
        const push = 1.6 / (r + 0.3);
        mx -= gx * push;
        mz -= gz * push;
      }
      x[i] += mx * dt;
      z[i] += mz * dt;
      // Never through the player: held at arm's length, biting.
      const ex = x[i] - px;
      const ez = z[i] - pz;
      const e = Math.hypot(ex, ez) || 1e-3;
      if (e < reach * 0.92) {
        x[i] = px + (ex / e) * reach * 0.92;
        z[i] = pz + (ez / e) * reach * 0.92;
      }
      const biting = e < reach + 0.08 && this.kT[i] <= 0;
      this.bite[i] += ((biting ? 1 : 0) - this.bite[i]) * Math.min(1, dt * 8);
      if (biting) dps += k.dps;
      const moved = Math.hypot(mx, mz) * dt;
      this.stride[i] += moved;
      // Face where it is going (or at you, when it bites).
      const want = biting || moved < 1e-4 ? Math.atan2(dx, dz) : Math.atan2(mx, mz);
      let dh = want - this.heading[i];
      dh -= Math.round(dh / (Math.PI * 2)) * Math.PI * 2;
      this.heading[i] += dh * Math.min(1, dt * 9);
    }
    return dps;
  }

  /** Crowd density and the hash, around (px, pz). */
  private rebuild(px: number, pz: number): void {
    this.ox = Math.floor(px / CELL) * CELL - (SIDE / 2) * CELL;
    this.oz = Math.floor(pz / CELL) * CELL - (SIDE / 2) * CELL;
    this.density.fill(0);
    this.head.fill(-1);
    for (let i = 0; i < this.n; i++) {
      if (this.dead[i]) continue;
      const cx = Math.floor((this.x[i] - this.ox) / CELL);
      const cz = Math.floor((this.z[i] - this.oz) / CELL);
      if (cx < 0 || cz < 0 || cx >= SIDE || cz >= SIDE) continue;
      const c = cz * SIDE + cx;
      const r = this.radius(i);
      this.density[c] += r * r * 2.2;
      this.next[i] = this.head[c];
      this.head[c] = i;
    }
  }

  /**
   * Call `fn` for every live enemy whose body is within `radius` of (x, z),
   * with the squared distance between centres. Return true from `fn` to stop.
   */
  query(x: number, z: number, radius: number, fn: (i: number, d2: number) => boolean | void): void {
    const reach = radius + 2.2;
    const c0 = Math.max(0, Math.floor((x - reach - this.ox) / CELL));
    const c1 = Math.min(SIDE - 1, Math.floor((x + reach - this.ox) / CELL));
    const r0 = Math.max(0, Math.floor((z - reach - this.oz) / CELL));
    const r1 = Math.min(SIDE - 1, Math.floor((z + reach - this.oz) / CELL));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        for (let i = this.head[r * SIDE + c]; i >= 0; i = this.next[i]) {
          if (this.dead[i]) continue;
          const dx = this.x[i] - x;
          const dz = this.z[i] - z;
          const d2 = dx * dx + dz * dz;
          const rr = radius + this.radius(i);
          if (d2 <= rr * rr && fn(i, d2)) return;
        }
      }
    }
  }

  /**
   * Fill `out` with every live, risen enemy whose body is within `radius`
   * of (x, z); returns how many (no allocation, for the hot loops).
   */
  gather(x: number, z: number, radius: number, out: Int32Array): number {
    let n = 0;
    const reach = radius + 2.2;
    const c0 = Math.max(0, Math.floor((x - reach - this.ox) / CELL));
    const c1 = Math.min(SIDE - 1, Math.floor((x + reach - this.ox) / CELL));
    const r0 = Math.max(0, Math.floor((z - reach - this.oz) / CELL));
    const r1 = Math.min(SIDE - 1, Math.floor((z + reach - this.oz) / CELL));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        for (let i = this.head[r * SIDE + c]; i >= 0; i = this.next[i]) {
          if (this.dead[i] || this.rise[i] < 0.6) continue;
          const dx = this.x[i] - x;
          const dz = this.z[i] - z;
          const rr = radius + this.radius(i);
          if (dx * dx + dz * dz > rr * rr) continue;
          out[n++] = i;
          if (n >= out.length) return n;
        }
      }
    }
    return n;
  }

  /** The live enemy nearest (x, z) within `max` m, skipping those in `skip`, or -1. */
  nearest(x: number, z: number, max: number, skip?: Set<number>): number {
    let best = -1;
    let bestD = max * max;
    this.query(x, z, max, (i, d2) => {
      if (d2 < bestD && this.rise[i] >= 1 && !skip?.has(i)) {
        bestD = d2;
        best = i;
      }
    });
    return best;
  }
}
