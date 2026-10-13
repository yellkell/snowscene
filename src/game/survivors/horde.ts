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
  /** Fur / shell colour, and the frost, horn or ember along its edges. */
  body: number;
  accent: number;
}

export const KINDS: Kind[] = [
  // The ghoul: skittering, frail, endless.
  { name: 'ghoul', radius: 0.42, speed: 1.9, hp: 5, dps: 3.5, xp: 1, body: 0x2c3652, accent: 0xc4e8ff },
  // The brute: a shelled thing that takes a volley or five.
  { name: 'brute', radius: 0.7, speed: 1.7, hp: 28, dps: 7, xp: 4, body: 0x4a3830, accent: 0xf0dfc0 },
  // The titan: an elite. Always drops something worth walking to.
  { name: 'titan', radius: 1.45, speed: 1.2, hp: 240, dps: 16, xp: 25, body: 0x2a2833, accent: 0xffb54a },
  // The bloater: a slow sac of ember. It bursts when it dies, hurting
  // everything round it (you too, up close), and bloaters set each other off.
  { name: 'bloater', radius: 0.62, speed: 1.15, hp: 16, dps: 5, xp: 3, body: 0x3b2a36, accent: 0xff8a3d },
  // The lunger: stops, scrabbles (its tell), then charges in a straight line.
  { name: 'lunger', radius: 0.5, speed: 2.1, hp: 10, dps: 6, xp: 2, body: 0x3a1f28, accent: 0xff5470 },
  // The splitter: a brood-carrier that bursts into three ghouls when it dies.
  { name: 'splitter', radius: 0.78, speed: 1.5, hp: 36, dps: 7, xp: 5, body: 0x2a2440, accent: 0xc39bff },
  // The glitterback: crusted in crystals, harmless, and running away. Catch
  // it before it burrows and it bursts in a fountain of crystals.
  { name: 'glitterback', radius: 0.55, speed: 3.0, hp: 70, dps: 0, xp: 20, body: 0x3d321e, accent: 0xffd166 },
];

export const GHOUL = 0;
export const BRUTE = 1;
export const TITAN = 2;
export const BLOATER = 3;
export const LUNGER = 4;
export const SPLITTER = 5;
export const GLITTER = 6;

/** A lunger charges from this far (m), after this tell (s), this fast (m/s) for this long (s). */
const LUNGE_RANGE = 9;
const LUNGE_TELL = 0.7;
const LUNGE_SPEED = 9.5;
const LUNGE_TIME = 0.55;

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
  /** Hit flash (s left); chilled (slowed, frosted) and frozen solid (s left). */
  readonly flash = new Float32Array(CAP);
  readonly chill = new Float32Array(CAP);
  readonly ice = new Float32Array(CAP);
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
  /** Seconds until it next hurls an ice boulder (the big ones). */
  readonly throwT = new Float32Array(CAP);
  /** Drops something when it dies: 1 an upgrade orb, 2 (a boss) a chest. */
  readonly carrier = new Uint8Array(CAP);
  /** A boss's number in the run (0, 1, 2) and its full health, for its ring. */
  readonly bossNo = new Uint8Array(CAP);
  readonly maxHp = new Float32Array(CAP);
  /** A lunger's move (0 closing in, 1 its tell, 2 charging) and seconds left of it; a glitterback's time left. */
  readonly state = new Uint8Array(CAP);
  readonly timer = new Float32Array(CAP);
  /** A charge's locked velocity. */
  readonly dvx = new Float32Array(CAP);
  readonly dvz = new Float32Array(CAP);
  /** Lungers that began their tell this step (the system growls for them). */
  tells = 0;

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
    this.chill[i] = 0;
    this.ice[i] = 0;
    this.rise[i] = 0;
    this.bite[i] = 0;
    this.kT[i] = 0;
    this.bladeCd[i] = 0;
    this.carrier[i] = 0;
    this.throwT[i] = 3 + Math.random() * 5;
    this.state[i] = 0;
    this.timer[i] = kind === LUNGER ? 1 + Math.random() * 2 : 0;
    this.dvx[i] = 0;
    this.dvz[i] = 0;
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
    this.chill[to] = this.chill[from];
    this.ice[to] = this.ice[from];
    this.rise[to] = this.rise[from];
    this.bite[to] = this.bite[from];
    this.kvx[to] = this.kvx[from];
    this.kvz[to] = this.kvz[from];
    this.kT[to] = this.kT[from];
    this.bladeCd[to] = this.bladeCd[from];
    this.carrier[to] = this.carrier[from];
    this.bossNo[to] = this.bossNo[from];
    this.maxHp[to] = this.maxHp[from];
    this.throwT[to] = this.throwT[from];
    this.state[to] = this.state[from];
    this.timer[to] = this.timer[from];
    this.dvx[to] = this.dvx[from];
    this.dvz[to] = this.dvz[from];
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
    this.tells = 0;
    let dps = 0;
    const { x, z, density } = this;
    for (let i = 0; i < this.n; i++) {
      if (this.dead[i]) continue;
      const k = KINDS[this.kind[i]];
      const r = k.radius * this.scale[i];
      this.flash[i] = Math.max(0, this.flash[i] - dt);
      this.chill[i] = Math.max(0, this.chill[i] - dt);
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
      if (this.ice[i] > 0) {
        // Frozen solid: a statue until it thaws (it can still be shoved).
        this.ice[i] -= dt;
        if (this.kT[i] > 0) {
          this.kT[i] -= dt;
          x[i] += this.kvx[i] * dt;
          z[i] += this.kvz[i] * dt;
        }
        this.bite[i] = Math.max(0, this.bite[i] - dt * 8);
        continue;
      }
      const kind = this.kind[i];
      if (kind === LUNGER) this.timer[i] -= dt;
      if (this.kT[i] > 0) {
        this.kT[i] -= dt;
        mx = this.kvx[i];
        mz = this.kvz[i];
        if (kind === LUNGER) this.state[i] = 0;
      } else if (kind === GLITTER) {
        // Away from you, weaving.
        const lean = this.veer[i] * 1.6 + Math.sin(this.stride[i] * 0.35) * 0.6;
        const c = Math.cos(lean);
        const s = Math.sin(lean);
        const ux = -dx / d;
        const uz = -dz / d;
        const v = k.speed * this.pace[i] * (this.chill[i] > 0 ? 0.55 : 1) * (d < 6 ? 1.25 : 1);
        mx = (ux * c - uz * s) * v;
        mz = (ux * s + uz * c) * v;
      } else if (kind === LUNGER && this.state[i] === 1) {
        // The tell: stopped dead, scrabbling, eyes on you.
        if (this.timer[i] <= 0) {
          this.state[i] = 2;
          this.timer[i] = LUNGE_TIME;
          this.dvx[i] = (dx / d) * LUNGE_SPEED;
          this.dvz[i] = (dz / d) * LUNGE_SPEED;
        }
      } else if (kind === LUNGER && this.state[i] === 2) {
        // The charge: a straight line, wherever you have gone.
        mx = this.dvx[i];
        mz = this.dvz[i];
        if (this.timer[i] <= 0) {
          this.state[i] = 0;
          this.timer[i] = 2 + Math.random() * 1.5;
        }
      } else if (kind === LUNGER && d < LUNGE_RANGE && d > reach + 1 && this.timer[i] <= 0) {
        this.state[i] = 1;
        this.timer[i] = LUNGE_TELL;
        this.tells++;
      } else if (d > reach) {
        // Lean off the line a little (less as it closes in).
        const lean = this.veer[i] * Math.min(1, d / 12);
        const c = Math.cos(lean);
        const s = Math.sin(lean);
        const ux = dx / d;
        const uz = dz / d;
        const v = k.speed * this.pace[i] * speedScale * (this.chill[i] > 0 ? 0.55 : 1);
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
      const biting = e < reach + 0.08 && this.kT[i] <= 0 && kind !== GLITTER;
      this.bite[i] += ((biting ? 1 : 0) - this.bite[i]) * Math.min(1, dt * 8);
      // A charging lunger hits far harder than a bite.
      if (biting) dps += k.dps * this.scale[i] * (kind === LUNGER && this.state[i] === 2 ? 4 : 1);
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
