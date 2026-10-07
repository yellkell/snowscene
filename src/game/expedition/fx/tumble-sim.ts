/**
 * Tumbling spheres on a height field (rocks, ice blocks). Pure TS, no
 * Three.js, so trajectories can be node-checked against the route.
 *
 * Gravity, bounce with restitution off the ground normal, Coulomb friction,
 * rolling spin, a little random scatter on each bounce, and sleeping once
 * a body comes to rest. Bodies do not collide with each other.
 */

export interface TumbleConfig {
  groundAt: (x: number, z: number) => number;
  /** Fraction of the normal speed kept on a bounce. */
  restitution: number;
  /** Coulomb friction coefficient. */
  friction: number;
  /** Random tilt of the bounce normal (0..~0.4) so paths fan out. */
  scatter: number;
  gravity?: number;
  /** Bumps per second per (m/s) of sliding speed that kick a body airborne. */
  roughness?: number;
  /** Rolling/ploughing drag while in contact (per second). */
  drag?: number;
  rng?: () => number;
  /** Called for hard ground strikes (speed = normal speed in m/s). */
  onImpact?: (i: number, speed: number, x: number, y: number, z: number) => void;
  /**
   * Keep bodies off somewhere (the route bench): return true and write a
   * horizontal acceleration to push them away; such bodies never sleep.
   */
  nudge?: (x: number, z: number, out: { x: number; z: number }) => boolean;
}

export const BODY_FREE = 0;
export const BODY_AWAKE = 1;
export const BODY_ASLEEP = 2;

const MAX_STEP = 1 / 110;

export class TumbleSim {
  readonly n: number;
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  readonly wx: Float32Array;
  readonly wy: Float32Array;
  readonly wz: Float32Array;
  readonly qx: Float32Array;
  readonly qy: Float32Array;
  readonly qz: Float32Array;
  readonly qw: Float32Array;
  readonly r: Float32Array;
  readonly state: Uint8Array;
  /** Seconds since spawn. */
  readonly age: Float32Array;
  private readonly rest: Float32Array;
  private readonly cfg: TumbleConfig;
  private readonly rng: () => number;
  private readonly push = { x: 0, z: 0 };
  awake = 0;

  constructor(n: number, cfg: TumbleConfig) {
    this.n = n;
    const f = () => new Float32Array(n);
    this.px = f();
    this.py = f();
    this.pz = f();
    this.vx = f();
    this.vy = f();
    this.vz = f();
    this.wx = f();
    this.wy = f();
    this.wz = f();
    this.qx = f();
    this.qy = f();
    this.qz = f();
    this.qw = f();
    this.r = f();
    this.age = f();
    this.rest = f();
    this.state = new Uint8Array(n);
    this.cfg = cfg;
    this.rng = cfg.rng ?? Math.random;
  }

  spawn(i: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, radius: number): void {
    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.r[i] = radius;
    this.age[i] = 0;
    this.rest[i] = 0;
    // Random orientation and tumble.
    const a = this.rng() * Math.PI * 2;
    const b = this.rng() * Math.PI * 2;
    const c = this.rng() * Math.PI;
    this.qx[i] = Math.sin(c) * Math.cos(a) * Math.sin(b / 2);
    this.qy[i] = Math.sin(c) * Math.sin(a) * Math.sin(b / 2);
    this.qz[i] = Math.cos(c) * Math.sin(b / 2);
    this.qw[i] = Math.cos(b / 2);
    this.wx[i] = (this.rng() - 0.5) * 4;
    this.wy[i] = (this.rng() - 0.5) * 4;
    this.wz[i] = (this.rng() - 0.5) * 4;
    this.state[i] = BODY_AWAKE;
  }

  free(i: number): void {
    this.state[i] = BODY_FREE;
  }

  clear(): void {
    this.state.fill(BODY_FREE);
    this.awake = 0;
  }

  /** Index of a free body, or -1. */
  freeIndex(): number {
    for (let i = 0; i < this.n; i++) if (this.state[i] === BODY_FREE) return i;
    return -1;
  }

  step(dt: number): void {
    const steps = Math.max(1, Math.ceil(dt / MAX_STEP));
    const h = dt / steps;
    for (let k = 0; k < steps; k++) this.substep(h);
    let awake = 0;
    for (let i = 0; i < this.n; i++) if (this.state[i] === BODY_AWAKE) awake++;
    this.awake = awake;
  }

  speed(i: number): number {
    return Math.hypot(this.vx[i], this.vy[i], this.vz[i]);
  }

  private substep(dt: number): void {
    const g = this.cfg.gravity ?? 9.81;
    const ground = this.cfg.groundAt;
    const push = this.push;
    for (let i = 0; i < this.n; i++) {
      if (this.state[i] !== BODY_AWAKE) continue;
      this.age[i] += dt;
      let vx = this.vx[i];
      let vy = this.vy[i] - g * dt;
      let vz = this.vz[i];
      let nudged = false;
      if (this.cfg.nudge && this.cfg.nudge(this.px[i], this.pz[i], push)) {
        nudged = true;
        vx += push.x * dt;
        vz += push.z * dt;
      }
      const x = this.px[i] + vx * dt;
      let y = this.py[i] + vy * dt;
      const z = this.pz[i] + vz * dt;
      const r = this.r[i];
      const hy = ground(x, z);
      let grounded = false;
      if (y - r < hy) {
        grounded = true;
        const e = 0.6;
        const gx = (ground(x + e, z) - ground(x - e, z)) / (2 * e);
        const gz = (ground(x, z + e) - ground(x, z - e)) / (2 * e);
        let nx = -gx + (this.rng() - 0.5) * this.cfg.scatter;
        let ny = 1;
        let nz = -gz + (this.rng() - 0.5) * this.cfg.scatter;
        const nl = Math.hypot(nx, ny, nz);
        nx /= nl;
        ny /= nl;
        nz /= nl;
        y = hy + r;
        const vn = vx * nx + vy * ny + vz * nz;
        if (vn < 0) {
          const impact = -vn;
          const rest = impact > 1.4 ? this.cfg.restitution : 0;
          let jn = -(1 + rest) * vn;
          // Rough ground: now and then a bump throws a fast body into the air.
          const slide = Math.hypot(vx - vn * nx, vy - vn * ny, vz - vn * nz);
          if (this.cfg.roughness && this.rng() < this.cfg.roughness * slide * dt) {
            jn += slide * (0.18 + 0.32 * this.rng());
          }
          vx += jn * nx;
          vy += jn * ny;
          vz += jn * nz;
          // Friction opposes sliding, limited by the normal impulse.
          const vd = vx * nx + vy * ny + vz * nz;
          let tx = vx - vd * nx;
          let ty = vy - vd * ny;
          let tz = vz - vd * nz;
          const tl = Math.hypot(tx, ty, tz);
          if (tl > 1e-6) {
            const dv = Math.min(tl, this.cfg.friction * jn);
            vx -= (tx / tl) * dv;
            vy -= (ty / tl) * dv;
            vz -= (tz / tl) * dv;
            const k = (tl - dv) / tl;
            tx *= k;
            ty *= k;
            tz *= k;
          }
          // Rolling: spin = n x v_t / r, blended with the existing tumble.
          const rx = (ny * tz - nz * ty) / r;
          const ry = (nz * tx - nx * tz) / r;
          const rz = (nx * ty - ny * tx) / r;
          this.wx[i] += (rx - this.wx[i]) * 0.5;
          this.wy[i] += (ry - this.wy[i]) * 0.5;
          this.wz[i] += (rz - this.wz[i]) * 0.5;
          if (impact > 2.5 && this.cfg.onImpact) this.cfg.onImpact(i, impact, x, hy, z);
        }
      }
      if (grounded && this.cfg.drag) {
        const k = Math.exp(-this.cfg.drag * dt);
        vx *= k;
        vy *= k;
        vz *= k;
      }
      this.px[i] = x;
      this.py[i] = y;
      this.pz[i] = z;
      this.vx[i] = vx;
      this.vy[i] = vy;
      this.vz[i] = vz;
      // Integrate orientation: q += 0.5 * (w, 0) * q * dt.
      const wx = this.wx[i];
      const wy = this.wy[i];
      const wz = this.wz[i];
      const qx = this.qx[i];
      const qy = this.qy[i];
      const qz = this.qz[i];
      const qw = this.qw[i];
      let nqx = qx + 0.5 * dt * (wx * qw + wy * qz - wz * qy);
      let nqy = qy + 0.5 * dt * (wy * qw + wz * qx - wx * qz);
      let nqz = qz + 0.5 * dt * (wz * qw + wx * qy - wy * qx);
      let nqw = qw + 0.5 * dt * (-wx * qx - wy * qy - wz * qz);
      const ql = Math.hypot(nqx, nqy, nqz, nqw) || 1;
      nqx /= ql;
      nqy /= ql;
      nqz /= ql;
      nqw /= ql;
      this.qx[i] = nqx;
      this.qy[i] = nqy;
      this.qz[i] = nqz;
      this.qw[i] = nqw;
      // Sleep once it has come to rest on the ground.
      const sp = Math.hypot(vx, vy, vz);
      if (grounded && sp < 0.45 && !nudged) {
        this.rest[i] += dt;
        if (this.rest[i] > 0.6) {
          this.state[i] = BODY_ASLEEP;
          this.vx[i] = this.vy[i] = this.vz[i] = 0;
          this.wx[i] = this.wy[i] = this.wz[i] = 0;
        }
      } else {
        this.rest[i] = 0;
      }
    }
  }
}

/** Distance from point p to the segment a-b (the player's body capsule). */
export function segmentDistance(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): number {
  const ex = bx - ax;
  const ey = by - ay;
  const ez = bz - az;
  const l2 = ex * ex + ey * ey + ez * ez;
  let t = l2 > 0 ? ((px - ax) * ex + (py - ay) * ey + (pz - az) * ez) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(ax + ex * t - px, ay + ey * t - py, az + ez * t - pz);
}
