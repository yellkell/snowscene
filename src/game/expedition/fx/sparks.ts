/**
 * Additive glowing points (firework stars, rock-strike sparks). One draw
 * call; each point is stretched along its screen-space motion so fast
 * stars read as short streaks without spawning trail particles.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Points,
  ShaderMaterial,
} from '@iwsdk/core';

/** Twinkle: strobes on and off near the end of its life. */
export const SPARK_TWINKLE = 1;
/** Glitter: sheds dim gold sparks behind it (willow / chrysanthemum). */
export const SPARK_GLITTER = 2;
/** Crackle: bursts into a few white pops when it dies. */
export const SPARK_CRACKLE = 4;
/** Cools from its colour toward ember orange as it ages. */
export const SPARK_COOL = 8;

function touch(attr: BufferAttribute, count: number): void {
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, count);
  attr.needsUpdate = true;
}

export class SparkPool {
  readonly points: Points;
  readonly capacity: number;
  live = 0;

  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly col: Float32Array;
  private readonly size: Float32Array;
  private readonly base: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly drag: Float32Array;
  private readonly grav: Float32Array;
  private readonly baseSize: Float32Array;
  private readonly flags: Uint8Array;
  private readonly shed: Float32Array;
  private readonly posAttr: BufferAttribute;
  private readonly velAttr: BufferAttribute;
  private readonly colAttr: BufferAttribute;
  private readonly sizeAttr: BufferAttribute;
  /** Count of crackle pops this frame (for sound), with their mean position. */
  crackles = 0;
  readonly crackleAt = { x: 0, y: 0, z: 0 };

  constructor(capacity: number, pixelScale = 900) {
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 3);
    this.base = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.age = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.grav = new Float32Array(capacity);
    this.baseSize = new Float32Array(capacity);
    this.flags = new Uint8Array(capacity);
    this.shed = new Float32Array(capacity);
    const geometry = new BufferGeometry();
    this.posAttr = new BufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage);
    this.velAttr = new BufferAttribute(this.vel, 3).setUsage(DynamicDrawUsage);
    this.colAttr = new BufferAttribute(this.col, 3).setUsage(DynamicDrawUsage);
    this.sizeAttr = new BufferAttribute(this.size, 1).setUsage(DynamicDrawUsage);
    geometry.setAttribute('position', this.posAttr);
    geometry.setAttribute('aVel', this.velAttr);
    geometry.setAttribute('aColor', this.colAttr);
    geometry.setAttribute('aSize', this.sizeAttr);
    geometry.setDrawRange(0, 0);
    const material = new ShaderMaterial({
      uniforms: { uScale: { value: pixelScale } },
      vertexShader: /* glsl */ `
        attribute vec3 aVel;
        attribute vec3 aColor;
        attribute float aSize;
        uniform float uScale;
        varying vec3 vColor;
        varying vec2 vDir;
        varying float vStretch;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          vec4 ahead = projectionMatrix * (modelViewMatrix * vec4(position + aVel * 0.06, 1.0));
          vec2 d = ahead.xy / ahead.w - gl_Position.xy / gl_Position.w;
          float base = clamp(aSize * uScale / max(-mv.z, 0.5), 1.5, 40.0);
          float streak = length(d) * uScale * 0.5;
          vStretch = clamp(1.0 + streak / base, 1.0, 6.0);
          vDir = length(d) > 1e-6 ? normalize(vec2(d.x, -d.y)) : vec2(0.0, 1.0);
          gl_PointSize = base * vStretch;
          vColor = aColor;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying vec2 vDir;
        varying float vStretch;
        void main() {
          vec2 pc = gl_PointCoord - 0.5;
          float along = dot(pc, vDir);
          float across = dot(pc, vec2(-vDir.y, vDir.x)) * vStretch;
          float r = length(vec2(along, across)) * 2.0;
          float a = 1.0 - r;
          if (a <= 0.0) discard;
          a = a * a;
          gl_FragColor = vec4(vColor, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.points = new Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.visible = false;
    this.points.renderOrder = 3;
  }

  emit(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    r: number,
    g: number,
    b: number,
    life: number,
    size: number,
    drag = 0.4,
    gravity = 4,
    flags = 0,
  ): boolean {
    if (this.live >= this.capacity) return false;
    const i = this.live++;
    const i3 = i * 3;
    this.pos[i3] = x;
    this.pos[i3 + 1] = y;
    this.pos[i3 + 2] = z;
    this.vel[i3] = vx;
    this.vel[i3 + 1] = vy;
    this.vel[i3 + 2] = vz;
    this.base[i3] = r;
    this.base[i3 + 1] = g;
    this.base[i3 + 2] = b;
    this.age[i] = 0;
    this.life[i] = life;
    this.baseSize[i] = size;
    this.drag[i] = drag;
    this.grav[i] = gravity;
    this.flags[i] = flags;
    this.shed[i] = Math.random() * 0.05;
    this.points.visible = true;
    return true;
  }

  clear(): void {
    this.live = 0;
    this.points.geometry.setDrawRange(0, 0);
    this.points.visible = false;
  }

  update(dt: number, time: number): void {
    this.crackles = 0;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    // Iterate over the count at the start: children shed this frame start next frame.
    let n = this.live;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        if (this.flags[i] & SPARK_CRACKLE) {
          cx += this.pos[i3];
          cy += this.pos[i3 + 1];
          cz += this.pos[i3 + 2];
          this.crackles++;
          // A few white pops in place of the star.
          for (let k = 0; k < 3; k++) {
            this.spawnChild(this.pos[i3], this.pos[i3 + 1], this.pos[i3 + 2], 3, 3.2, 3, 2.6, 0.18 + Math.random() * 0.12, this.baseSize[i] * 0.8, 0);
          }
        }
        n = this.removeAt(i, n);
        i--;
        continue;
      }
      const t = this.age[i] / this.life[i];
      const damp = Math.exp(-this.drag[i] * dt);
      this.vel[i3] *= damp;
      this.vel[i3 + 1] = this.vel[i3 + 1] * damp - this.grav[i] * dt;
      this.vel[i3 + 2] *= damp;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      let bright = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
      if (this.flags[i] & SPARK_TWINKLE && t > 0.35) bright *= Math.sin(time * 38 + i * 1.7) > 0.1 ? 1.4 : 0.08;
      let r = this.base[i3];
      let g = this.base[i3 + 1];
      let b = this.base[i3 + 2];
      if (this.flags[i] & SPARK_COOL) {
        const c = Math.min(1, t * 1.3);
        r += (1.6 - r) * c;
        g += (0.5 - g) * c;
        b += (0.12 - b) * c;
      }
      this.col[i3] = r * bright;
      this.col[i3 + 1] = g * bright;
      this.col[i3 + 2] = b * bright;
      this.size[i] = this.baseSize[i] * (0.6 + 0.4 * bright);
      if (this.flags[i] & SPARK_GLITTER) {
        this.shed[i] -= dt;
        if (this.shed[i] <= 0 && t < 0.85) {
          this.shed[i] = 0.07;
          this.spawnChild(this.pos[i3], this.pos[i3 + 1], this.pos[i3 + 2], 1.5, 0.95, 0.4, 0.8, 0.9 + Math.random() * 0.8, this.baseSize[i] * 0.55, 1.5);
        }
      }
    }
    this.live = Math.min(this.live, this.capacity);
    if (this.crackles > 0) {
      this.crackleAt.x = cx / this.crackles;
      this.crackleAt.y = cy / this.crackles;
      this.crackleAt.z = cz / this.crackles;
    }
    const geo = this.points.geometry;
    geo.setDrawRange(0, this.live);
    this.points.visible = this.live > 0;
    if (this.live > 0) {
      touch(this.posAttr, this.live * 3);
      touch(this.velAttr, this.live * 3);
      touch(this.colAttr, this.live * 3);
      touch(this.sizeAttr, this.live);
    }
  }

  /** Remove index i (swap with the last of the first n being iterated). */
  private removeAt(i: number, n: number): number {
    // Keep particles appended this frame (beyond n) packed too.
    const last = this.live - 1;
    if (n - 1 !== i) this.copy(n - 1, i);
    if (last !== n - 1) this.copy(last, n - 1);
    this.live--;
    return n - 1;
  }

  private spawnChild(
    x: number,
    y: number,
    z: number,
    speed: number,
    r: number,
    g: number,
    b: number,
    life: number,
    size: number,
    gravity: number,
  ): void {
    const u = Math.random() * 2 - 1;
    const a = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u) * speed;
    this.emit(x, y, z, Math.cos(a) * s, u * speed, Math.sin(a) * s, r, g, b, life, size, 2.2, gravity, 0);
  }

  private copy(from: number, to: number): void {
    const f3 = from * 3;
    const t3 = to * 3;
    for (let k = 0; k < 3; k++) {
      this.pos[t3 + k] = this.pos[f3 + k];
      this.vel[t3 + k] = this.vel[f3 + k];
      this.base[t3 + k] = this.base[f3 + k];
      this.col[t3 + k] = this.col[f3 + k];
    }
    this.size[to] = this.size[from];
    this.age[to] = this.age[from];
    this.life[to] = this.life[from];
    this.drag[to] = this.drag[from];
    this.grav[to] = this.grav[from];
    this.baseSize[to] = this.baseSize[from];
    this.flags[to] = this.flags[from];
    this.shed[to] = this.shed[from];
  }
}
