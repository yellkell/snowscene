/**
 * Snow Survivors' fire, drawn (the survivors system owns the rules; these hold what moves on its own
 * and draw it, pooled and instanced). The fire itself is a Mantaflow sim rendered in Cycles
 * (art/scripts/fx_sims.py): blackbody emission and smoke density as flipbooks, re-coloured and
 * re-lit here so it sits in the evening's light.
 *
 * - Embers: every spark of fire in the run: glowing grains stretched along their motion (motion blur),
 *   cooling from yellow-white through orange to a dull red.
 * - Flames: fires standing on the snow (the ember trail): flipbook billboards turned to you, with the
 *   smoke rising off them; each lights the snow round it (GroundGlow).
 * - Breath: the jet of flame, a stream of rolling fireballs that cool to smoke.
 * - Rockets: a paper firework on a gold exhaust and a trail of smoke.
 * - Comets: burning rocks out of the sky trailing fire and smoke; the snow where each will strike
 *   lights up as it comes down.
 */

import {
  BufferGeometry,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  Float32BufferAttribute,
  type Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from '@iwsdk/core';
import {
  FIREBALL_LMAX,
  FIRE_LMAX,
  FX_FRAG,
  FX_VERT,
  GroundGlow,
  InstPool,
  SUNVIS_VERT,
  fx,
  fxMaterial,
  fxModel,
  fxTex,
  unitQuad,
} from './fx-assets.js';
import { duneHeight } from './survivors-level.js';

const tmpM = new Matrix4();
const tmpQ = new Quaternion();
const tmpS = new Vector3();
const tmpP = new Vector3();
const tmpV = new Vector3();
const tmpC = new Color();
const UP = new Vector3(0, 1, 0);

function instanced(geo: BufferGeometry, material: import('@iwsdk/core').Material, cap: number, name: string, parent: Group, order = 0): InstancedMesh {
  const mesh = new InstancedMesh(geo, material, cap);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.setColorAt(0, tmpC.set(0xffffff));
  mesh.instanceColor!.setUsage(DynamicDrawUsage);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.name = name;
  mesh.renderOrder = order;
  parent.add(mesh);
  return mesh;
}

/**
 * Camera-facing ribbon along an instance's local -Z (head at its origin, length = its z scale, width =
 * its x scale). Geometry: unit quad with y in [-0.5, 0.5]; vRib = (across -1..1, along 0 head..1 tail).
 */
export const RIBBON_VERT = /* glsl */ `
varying vec2 vRib;
vec3 ribbon(float taper) {
  vec3 head = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec3 axis = (instanceMatrix * vec4(0.0, 0.0, -1.0, 0.0)).xyz;
  float width = length(instanceMatrix[0].xyz);
  float t = position.y + 0.5;
  vec3 p = head + axis * t;
  vec3 side = cross(normalize(axis + vec3(1e-5)), normalize(cameraPosition - p));
  side = normalize(side + vec3(1e-6));
  vRib = vec2(position.x * 2.0, t);
  return p + side * position.x * width * mix(1.0, taper, t);
}
`;

// ------------------------------------------------------------- embers ---

/** The glow budget's gain (survivors-fx `fx.gain`), as a uniform every fire material shares. */
const fireGain = { value: 1 };

const EMBER_CAP = 2400;

/** Every spark of fire in the run: glowing grains with motion streaks, rising, flickering, burning down. */
export class Embers {
  private readonly pool: InstPool;
  private readonly pos = new Float32Array(EMBER_CAP * 3);
  private readonly vel = new Float32Array(EMBER_CAP * 3);
  private readonly life = new Float32Array(EMBER_CAP);
  private readonly maxLife = new Float32Array(EMBER_CAP);
  private readonly base = new Float32Array(EMBER_CAP);
  private readonly tint = new Float32Array(EMBER_CAP * 3);
  /** Buoyancy: fire rises, firework sparks fall. */
  private readonly lift = new Float32Array(EMBER_CAP);
  private next = 0;
  private readonly viewH = { value: 900 };

  constructor(parent: Group) {
    const mat = fxMaterial({
      blend: 'additive',
      uniforms: { uViewH: this.viewH, uGain: fireGain },
      vertexShader: /* glsl */ `
        ${FX_VERT}
        uniform float uViewH;
        attribute vec4 aPos;   // xyz, size (m)
        attribute vec4 aVel;   // velocity, heat 0..1
        attribute vec4 aTint;  // firework colour, tinted flag
        varying vec2 vQ;
        varying float vHeat;
        varying vec4 vTint;
        varying float vFade;
        void main() {
          vec4 pv = viewMatrix * vec4(aPos.xyz, 1.0);
          vec3 vv = mat3(viewMatrix) * aVel.xyz;
          float depth = max(0.05, -pv.z);
          // Never a screenful: the grain is capped in pixels, gone when right at your eyes.
          float pxPerM = projectionMatrix[1][1] * uViewH * 0.5 / depth;
          float size = min(aPos.w, 14.0 / pxPerM);
          // Motion blur: a 1/45 s exposure of its flight, at least its own size, capped on screen.
          float sp = length(vv.xy);
          vec2 dir = sp > 1e-4 ? vv.xy / sp : vec2(0.0, 1.0);
          float len = clamp(sp / 45.0, size, 90.0 / pxPerM);
          vec2 side = vec2(-dir.y, dir.x);
          vec2 off = side * position.x * size + dir * position.y * (len + size);
          pv.xy += off;
          vQ = position.xy * 2.0;
          vHeat = aVel.w;
          vTint = aTint;
          // Brighter for a short streak, spread thinner over a long one.
          vFade = smoothstep(0.6, 1.8, depth) * size / (len + size) * 2.0;
          computeHaze(aPos.xyz);
          gl_Position = projectionMatrix * pv;
        }`,
      fragmentShader: /* glsl */ `
        ${FX_FRAG}
        uniform float uGain;
        varying vec2 vQ;
        varying float vHeat;
        varying vec4 vTint;
        varying float vFade;
        void main() {
          float across = exp(-vQ.x * vQ.x * 4.0);
          float along = 1.0 - smoothstep(0.2, 1.0, abs(vQ.y));
          float k = across * along;
          if (k < 0.01) discard;
          // A grain of burning soot: radiance climbs steeply with its heat, golden at its hottest and
          // never white (it is seen over snow; white sparks by the hundred hazed the crowd over).
          float L = 0.25 + 5.0 * vHeat * vHeat * vHeat;
          vec3 c = vTint.w > 0.5 ? mix(vTint.rgb, vec3(1.0), 0.08 * vHeat) * (0.6 + 4.0 * vHeat * vHeat) : fireTint(min(vHeat, 0.78) * 1.05) * L;
          vec3 col = c * k * vFade * uEmit * (1.0 - vHazeF) * (0.6 + 0.4 * uGain);
          gl_FragColor = fxOut(vec4(col, 0.0), bgAir());
        }`,
    });
    this.pool = new InstPool(unitQuad(), mat, EMBER_CAP, ['aPos', 'aVel', 'aTint'], parent, 'Embers', 7);
  }

  /** Pixel height of the view (sizes are capped in pixels). */
  setViewHeight(h: number): void {
    this.viewH.value = h;
  }

  /**
   * One spark at (x, y, z) moving (vx, vy, vz) for `life` s, `size` m across; `tint` a colour for a
   * firework spark (0 for fire), `lift` how hard it rises (negative falls).
   */
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, tint = 0, lift = 1.6): void {
    const i = this.next;
    this.next = (this.next + 1) % EMBER_CAP;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.life[i] = this.maxLife[i] = life;
    // Real sparks are grains: the old sprite sizes were the glow round them.
    this.base[i] = size * 0.32;
    this.lift[i] = lift;
    if (tint) {
      tmpC.set(tint);
      this.tint[i * 3] = tmpC.r;
      this.tint[i * 3 + 1] = tmpC.g;
      this.tint[i * 3 + 2] = tmpC.b;
    } else {
      this.tint[i * 3] = -1;
    }
  }

  /** Sparks alight this frame (for the glow budget). */
  live = 0;

  tick(dt: number, time: number): void {
    const damp = Math.exp(-dt * 1.6);
    fireGain.value = fx.gain;
    const p = this.pool;
    p.begin();
    for (let i = 0; i < EMBER_CAP; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) continue;
      const t = this.life[i] / this.maxLife[i];
      const o = i * 3;
      this.vel[o] *= damp;
      this.vel[o + 2] *= damp;
      this.vel[o + 1] = this.vel[o + 1] * damp + this.lift[i] * dt * 2.2;
      // A little flutter side to side.
      const flutter = Math.sin(time * 9 + i * 1.7) * 0.25;
      this.pos[o] += (this.vel[o] + flutter) * dt;
      this.pos[o + 1] += this.vel[o + 1] * dt;
      this.pos[o + 2] += (this.vel[o + 2] - flutter) * dt;
      const heat = t * (0.82 + 0.18 * Math.sin(time * 31 + i * 2.3));
      const size = this.base[i] * (t > 0.85 ? ((1 - t) / 0.15) * 0.6 + 0.4 : 0.5 + 0.5 * t);
      const k = p.add();
      p.set('aPos', k, this.pos[o], this.pos[o + 1], this.pos[o + 2], size);
      p.set('aVel', k, this.vel[o] + flutter, this.vel[o + 1], this.vel[o + 2] - flutter, heat);
      const tinted = this.tint[o] >= 0;
      p.set('aTint', k, tinted ? this.tint[o] : 0, tinted ? this.tint[o + 1] : 0, tinted ? this.tint[o + 2] : 0, tinted ? 1 : 0);
    }
    p.end();
    this.live = p.mesh.count;
  }

  clear(): void {
    this.life.fill(0);
  }
}

// ------------------------------------------------------------- flames ---

const FLAME_CAP = 520;
/** The flame fills the bottom 46 % of a fire frame; the rest is the smoke above it (fx_sims.py fire). */
const FLAME_FRACTION = 0.46;
/** The fuel bed sits this far up the frame. */
const FLAME_BASE = 0.05;
/** The top of the frame is only faint smoke: the quad stops here. */
const FRAME_TOP = 0.86;

/**
 * Fire billboards from the fire flipbook (8 x 8 frames, looping): blackbody emission over smoke,
 * premultiplied in one draw. Shared by the ember trail and the comets' strikes.
 */
function fireMaterial(atlas: 'fire' | 'fireball', lmax: number, grid: number, count: number, loop: boolean) {
  return fxMaterial({
    blend: 'premul',
    uniforms: { tFire: { value: fxTex()[atlas] }, uGain: fireGain },
    defines: { LMAX: lmax.toFixed(3), GRID: grid.toFixed(1), COUNT: count.toFixed(1), LOOP: loop ? 1 : 0 },
    vertexShader: /* glsl */ `
      ${FX_VERT}
      ${SUNVIS_VERT}
      attribute vec4 aPos;   // base x, y, z, frame height (m)
      attribute vec4 aData;  // frame, strength 0..1, flip, roll (rad)
      attribute vec4 aDir;   // x 0: turned about the vertical (standing fire), 1: full billboard; y: gold root
      varying vec2 vUv;
      varying vec3 vData;
      varying float vSunVis;
      varying float vNear;
      varying float vGold;
      varying float vBall;
      void main() {
        float h = aPos.w;
        float w = h * 0.5;
        vec3 toCam = cameraPosition - aPos.xyz;
        vec3 right, up;
        if (aDir.x < 0.5) {
          up = vec3(0.0, 1.0, 0.0);
          right = normalize(cross(up, vec3(toCam.x, 0.0, toCam.z) + vec3(1e-4, 0.0, 0.0)));
        } else {
          vec3 f = normalize(toCam);
          right = normalize(cross(vec3(0.0, 1.0, 0.0), f) + vec3(1e-4, 0.0, 0.0));
          up = cross(f, right);
          float c = cos(aData.w), s = sin(aData.w);
          vec3 r2 = right * c + up * s;
          up = up * c - right * s;
          right = r2;
        }
        // Standing fires sink their base into the snow a little; balls are centred.
        vec2 q = position.xy + 0.5;
        vUv = vec2(aData.z > 0.5 ? 1.0 - q.x : q.x, q.y);
        float y0 = aDir.x < 0.5 ? -FLAME_BASE_V * h - 0.03 * h : -0.5 * h;
        vec3 wp = aPos.xyz + right * (q.x - 0.5) * w * (aDir.x < 0.5 ? 1.0 : 2.0) + up * (y0 + q.y * h);
        vData = aData.xyz;
        vData.y = aData.y;
        vGold = aDir.y;
        vBall = aDir.x;
        vSunVis = groundSunVisibility(aPos.xz);
        // Standing fires fade right at your eyes; the breath's balls over the first few metres of the jet
        // (you always look straight down it: up close they veiled the middle of the view).
        vNear = aDir.x < 0.5 ? smoothstep(0.5, 1.8, length(toCam)) : smoothstep(2.5, 6.5, length(toCam));
        computeHaze(wp);
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`.replace('FLAME_BASE_V', FLAME_BASE.toFixed(3)),
    fragmentShader: /* glsl */ `
      ${FX_FRAG}
      uniform sampler2D tFire;
      uniform float uGain;
      varying vec2 vUv;
      varying vec3 vData;
      varying float vSunVis;
      varying float vNear;
      varying float vGold;
      varying float vBall;
      void main() {
        vec4 s = flipbook(tFire, vUv, vData.x, vec2(GRID), COUNT, LOOP == 1);
        float strength = vData.y;
        // Dying down: the flame shrinks, cools and dims faster than its smoke.
        float L = s.r * s.r * LMAX * strength * sqrt(strength);
        float heat = s.g * mix(0.55, 1.0, strength);
        vec3 emit = fireTint(heat) * L;
        // Wildfire burns gold at the root.
        emit = mix(emit, vec3(1.0, 0.78, 0.3) * L * 0.9, vGold * (1.0 - smoothstep(0.05, 0.3, vUv.y)));
        // Under the glow budget the flames soften (their smoke and shape stay).
        emit *= 0.55 + 0.45 * uGain;
        // The breath's smoke is thinner than a standing fire's, so the crowd shows through the jet.
        float a = s.b * mix(0.55, 1.0, strength) * vNear * (vBall < 0.5 ? 1.0 : 0.45);
        // Soot lit by the evening (from above, a little sun) and by the flames beneath it.
        vec3 smoke = vec3(0.055, 0.052, 0.05) * (uOpenSky * uSkyTint * uSkyGain * 0.9 + uSunColor * 0.25 * vSunVis)
                     + vec3(0.6, 0.25, 0.08) * 0.012 * LMAX * strength * uEmit * (1.0 - vUv.y);
        // The smoke thins off the top of the frame.
        a *= 1.0 - smoothstep(0.6, 0.86, vUv.y);
        // The flames rise out of the snow, not off a hard edge.
        emit *= vNear * smoothstep(0.0, 0.06, vUv.y);
        vec4 o = hazePremul(emit * uEmit, smoke, a, vHazeF);
        if (o.a < 0.002 && dot(o.rgb, vec3(1.0)) < 0.002) discard;
        gl_FragColor = fxOut(o, bgAir());
      }`,
  });
}

/** Fires standing on the snow (the ember trail), each a flipbook billboard turned to face you. */
export class Flames {
  private readonly pool: InstPool;
  /** Fires standing this frame (for the glow budget). */
  get live(): number {
    return this.pool.mesh.count;
  }

  constructor(parent: Group) {
    // The quad stops below the top of the frame (only faint smoke up there): less to fill.
    const geo = new PlaneGeometry(1, FRAME_TOP).translate(0, FRAME_TOP / 2 - 0.5, 0);
    const uv = geo.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) * FRAME_TOP);
    this.pool = new InstPool(geo, fireMaterial('fire', FIRE_LMAX, 8, 64, true), FLAME_CAP, ['aPos', 'aData', 'aDir'], parent, 'Flames', 6);
  }

  /** Start a frame's flames. */
  begin(): void {
    this.pool.begin();
  }

  /**
   * A fire at (x, y, z) with flames `height` m tall, flickering on `phase`, at `strength` 0..1; `wild`
   * burns gold at the root (Wildfire).
   */
  add(x: number, y: number, z: number, height: number, phase: number, strength: number, time: number, _eye?: Vector3, wild = false): void {
    const i = this.pool.add();
    if (i < 0) return;
    const h = (height * (0.55 + 0.45 * strength)) / FLAME_FRACTION;
    // Each fire runs the loop at its own speed and place in it.
    const frame = time * (22 + (phase % 5)) + phase * 9.3;
    this.pool.set('aPos', i, x, y, z, h);
    this.pool.set('aData', i, frame, strength, Math.floor(phase * 3.7) % 2, 0);
    this.pool.set('aDir', i, 0, wild ? 1 : 0, 0, 0);
  }

  end(): void {
    this.pool.end();
  }
}

// ------------------------------------------------------------- breath ---

const PUFF_CAP = 56;

/**
 * The jet of flame: a stream of rolling fireballs (the Cycles fireball flipbook) thrown along your
 * heading, each swelling, cooling to smoke and slowing as it goes. One draw; it lights the snow under it.
 */
export class Breath {
  private readonly pool: InstPool;
  private readonly px = new Float32Array(PUFF_CAP);
  private readonly py = new Float32Array(PUFF_CAP);
  private readonly pz = new Float32Array(PUFF_CAP);
  private readonly vx = new Float32Array(PUFF_CAP);
  private readonly vy = new Float32Array(PUFF_CAP);
  private readonly vz = new Float32Array(PUFF_CAP);
  private readonly age = new Float32Array(PUFF_CAP).fill(1);
  private readonly span = new Float32Array(PUFF_CAP).fill(1);
  private readonly size = new Float32Array(PUFF_CAP);
  private readonly roll = new Float32Array(PUFF_CAP);
  private next = 0;
  private lastTime = -1;
  private spawnAcc = 0;

  constructor(parent: Group, private readonly glow?: GroundGlow) {
    this.pool = new InstPool(unitQuad(), fireMaterial('fireball', FIREBALL_LMAX * 0.6, 4, 16, false), PUFF_CAP, ['aPos', 'aData', 'aDir'], parent, 'FireBreath', 6);
  }

  /**
   * Out from (x, y, z) along `yaw`, `length` long and `width` across at the end, at `alpha` (0 stops it);
   * `dragon` for Dragon's Breath (a hotter, white-gold heart).
   */
  draw(x: number, y: number, z: number, yaw: number, length: number, width: number, alpha: number, time: number, dragon = false): void {
    const dt = this.lastTime < 0 ? 0 : Math.min(0.05, Math.max(0, time - this.lastTime));
    this.lastTime = time;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    // New fireballs while it roars (time stopped: none).
    if (alpha > 0.05 && dt > 0) {
      this.spawnAcc += dt * 50 * alpha;
      while (this.spawnAcc >= 1) {
        this.spawnAcc -= 1;
        const i = this.next;
        this.next = (this.next + 1) % PUFF_CAP;
        const spread = (Math.random() - 0.5) * (width / length) * 1.8;
        const life = 0.42 + Math.random() * 0.18;
        const speed = (length / life) * (1.1 + Math.random() * 0.25);
        const dx = fx + -fz * spread;
        const dz = fz + fx * spread;
        // You always look straight down the jet: it starts a stride out, so the first stretch from your
        // chest is clear air (as a film right in front of you it veiled the middle of the view).
        this.px[i] = x + fx * 0.7;
        this.py[i] = y;
        this.pz[i] = z + fz * 0.7;
        this.vx[i] = dx * speed;
        this.vz[i] = dz * speed;
        this.vy[i] = -0.08 * speed + (Math.random() - 0.3) * 1.2;
        this.age[i] = 0;
        this.span[i] = life;
        // Separate tongues with clear air between them (one wall of fire hid the crowd): many small balls
        // spread across the cone, not a few as wide as it.
        this.size[i] = Math.min(2.4, width * (0.22 + Math.random() * 0.14));
        this.roll[i] = Math.random() * Math.PI * 2;
      }
    }
    const p = this.pool;
    p.begin();
    let gx = 0;
    let gz = 0;
    let gw = 0;
    for (let i = 0; i < PUFF_CAP; i++) {
      if (this.age[i] >= 1) continue;
      this.age[i] = Math.min(1, this.age[i] + dt / this.span[i]);
      const a = this.age[i];
      // Drag: fast out of the mouth, slowing as it swells; the hot gas rises as it slows.
      const drag = Math.exp(-dt * 2.6);
      this.vx[i] *= drag;
      this.vz[i] *= drag;
      this.vy[i] = this.vy[i] * drag + dt * 3.5 * a;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      const floor = duneHeight(this.px[i], this.pz[i]) + 0.25;
      if (this.py[i] < floor) this.py[i] = floor;
      const k = p.add();
      const s = this.size[i] * (0.28 + 0.95 * Math.sqrt(a));
      p.set('aPos', k, this.px[i], this.py[i], this.pz[i], s);
      // Through the first 11 frames (the burn); the smoke tail is left to the embers.
      p.set('aData', k, a * 11, dragon ? 1.3 : 1, i & 1, this.roll[i] + a * 1.5);
      p.set('aDir', k, 1, 0, 0, 0);
      const heat = 1 - a;
      gx += this.px[i] * heat;
      gz += this.pz[i] * heat;
      gw += heat;
    }
    p.end();
    if (this.glow && gw > 0.5) {
      // The jet lights the snow under it: a pool at its middle and one at the mouth.
      this.glow.add(gx / gw, gz / gw, Math.max(2.5, length * 0.7), 1.0, 0.5, 0.18, 0.12 * Math.min(1, gw / 8), 1.3);
      this.glow.add(x + fx * 1.2, z + fz * 1.2, 2.2, 1.0, 0.55, 0.2, 0.08 * alpha, 2.1);
    }
  }
}

// ------------------------------------------------------------ rockets ---

const ROCKET_CAP = 40;

/** A lit, solid thing on an InstancedMesh (instance matrices), shaded with the evening's light. */
const LIT_VERT = /* glsl */ `
${FX_VERT}
${SUNVIS_VERT}
attribute vec3 color;
varying vec3 vN;
varying vec3 vW;
varying vec3 vCol;
varying vec3 vInst;
varying float vSunVis;
void main() {
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  vW = wp.xyz;
  vCol = color;
  vInst = instanceColor;
  vSunVis = groundSunVisibility(wp.xz);
  computeHaze(wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

/** Fireworks: up on a gold exhaust and a trail of smoke, then over and down onto a target. */
export class Rockets {
  n = 0;
  readonly x = new Float32Array(ROCKET_CAP);
  readonly y = new Float32Array(ROCKET_CAP);
  readonly z = new Float32Array(ROCKET_CAP);
  readonly vx = new Float32Array(ROCKET_CAP);
  readonly vy = new Float32Array(ROCKET_CAP);
  readonly vz = new Float32Array(ROCKET_CAP);
  readonly tx = new Float32Array(ROCKET_CAP);
  readonly tz = new Float32Array(ROCKET_CAP);
  readonly age = new Float32Array(ROCKET_CAP);
  readonly color = new Uint32Array(ROCKET_CAP);
  readonly dmg = new Float32Array(ROCKET_CAP);
  readonly radius = new Float32Array(ROCKET_CAP);
  /** Set when a rocket has burst (the system reads, then removes it). */
  readonly burst = new Uint8Array(ROCKET_CAP);
  private readonly body: InstancedMesh;
  private readonly trail: InstancedMesh;

  constructor(parent: Group) {
    // A paper tube with a conical cap, along +Z (nose forward), and its stick.
    const tube = new CylinderGeometry(0.035, 0.035, 0.2, 10, 1).rotateX(Math.PI / 2);
    const cap = new CylinderGeometry(0.0, 0.037, 0.07, 10, 1).rotateX(Math.PI / 2).translate(0, 0, 0.135);
    const stick = new CylinderGeometry(0.005, 0.005, 0.35, 4, 1).rotateX(Math.PI / 2).translate(0.04, 0, -0.25);
    const geo = mergeColored([
      [tube, [0.62, 0.08, 0.06]],
      [cap, [0.85, 0.8, 0.68]],
      [stick, [0.45, 0.33, 0.2]],
    ]);
    const mat = fxMaterial({
      vertexShader: LIT_VERT,
      fragmentShader: /* glsl */ `
        ${FX_FRAG}
        varying vec3 vN;
        varying vec3 vW;
        varying vec3 vCol;
        varying vec3 vInst;
        varying float vSunVis;
        void main() {
          vec3 n = normalize(vN);
          vec3 col = vCol * dynamicLight(n, 1.0, vSunVis);
          // Lit from behind by its own exhaust.
          col += vCol * vec3(1.0, 0.6, 0.25) * 0.6 * uEmit;
          col = applyHaze(col, vHazeF);
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.body = instanced(geo, mat, ROCKET_CAP, 'Rockets', parent);
    const trailGeo = new PlaneGeometry(1, 1, 1, 6);
    const trailMat = fxMaterial({
      blend: 'premul',
      uniforms: { tMisc: { value: fxTex().misc } },
      vertexShader: /* glsl */ `
        ${FX_VERT}
        ${RIBBON_VERT}
        varying vec3 vInst;
        void main() {
          vec3 wp = ribbon(3.0);
          vInst = instanceColor;
          computeHaze(wp);
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        ${FX_FRAG}
        uniform sampler2D tMisc;
        varying vec3 vInst;
        varying vec2 vRib;
        void main() {
          float x = vRib.x, t = vRib.y;
          // Exhaust: a white-gold jet at the nozzle.
          float jet = exp(-x * x * 9.0) * exp(-t * 22.0);
          vec3 emit = vec3(1.0, 0.62, 0.25) * 14.0 * jet;
          // Smoke: billowing, widening, thinning behind.
          float n = texture2D(tMisc, vec2(0.5 + 0.5 * fract(x * 0.15 + 0.5), fract(t * 1.3 - uFxTime * 0.7)) ).r;
          float body = exp(-x * x * 2.2) * smoothstep(0.0, 0.08, t) * (1.0 - t);
          float a = clamp(body * (0.25 + 0.9 * n) * 0.55, 0.0, 1.0);
          vec3 smoke = vec3(0.32) * (uOpenSky * uSkyTint * uSkyGain + uSunColor * 0.15);
          gl_FragColor = fxOut(hazePremul(emit * uEmit, smoke, a, vHazeF), bgAir());
        }`,
    });
    this.trail = instanced(trailGeo, trailMat, ROCKET_CAP, 'RocketTrails', parent, 5);
  }

  launch(x: number, y: number, z: number, tx: number, tz: number, color: number, dmg: number, radius: number): void {
    if (this.n >= ROCKET_CAP) return;
    const i = this.n++;
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = z;
    // Straight up, a little out toward the target and a little wild.
    const dx = tx - x;
    const dz = tz - z;
    const d = Math.hypot(dx, dz) || 1;
    this.vx[i] = (dx / d) * 2 + (Math.random() - 0.5) * 2.5;
    this.vy[i] = 11 + Math.random() * 3;
    this.vz[i] = (dz / d) * 2 + (Math.random() - 0.5) * 2.5;
    this.tx[i] = tx;
    this.tz[i] = tz;
    this.age[i] = 0;
    this.color[i] = color;
    this.dmg[i] = dmg;
    this.radius[i] = radius;
    this.burst[i] = 0;
  }

  remove(i: number): void {
    const j = --this.n;
    if (i === j) return;
    this.x[i] = this.x[j];
    this.y[i] = this.y[j];
    this.z[i] = this.z[j];
    this.vx[i] = this.vx[j];
    this.vy[i] = this.vy[j];
    this.vz[i] = this.vz[j];
    this.tx[i] = this.tx[j];
    this.tz[i] = this.tz[j];
    this.age[i] = this.age[j];
    this.dmg[i] = this.dmg[j];
    this.radius[i] = this.radius[j];
    this.color[i] = this.color[j];
    this.burst[i] = this.burst[j];
  }

  /** Climb, then steer harder and harder down onto the target; sparkle all the way. */
  move(dt: number, embers: Embers): void {
    for (let i = 0; i < this.n; i++) {
      if (this.burst[i]) continue;
      this.age[i] += dt;
      const gy = duneHeight(this.tx[i], this.tz[i]);
      if (this.age[i] > 0.45) {
        // Homing: steer the velocity toward the target, harder with time.
        tmpV.set(this.tx[i] - this.x[i], gy + 0.4 - this.y[i], this.tz[i] - this.z[i]);
        const d = tmpV.length() || 1;
        const speed = 16 + this.age[i] * 10;
        const k = Math.min(1, dt * (2 + this.age[i] * 6));
        this.vx[i] += ((tmpV.x / d) * speed - this.vx[i]) * k;
        this.vy[i] += ((tmpV.y / d) * speed - this.vy[i]) * k;
        this.vz[i] += ((tmpV.z / d) * speed - this.vz[i]) * k;
      } else {
        this.vy[i] -= 4 * dt;
      }
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      this.z[i] += this.vz[i] * dt;
      embers.emit(this.x[i], this.y[i], this.z[i], (Math.random() - 0.5) * 0.8, -0.5, (Math.random() - 0.5) * 0.8, 0.35 + Math.random() * 0.25, 0.09, Math.random() < 0.5 ? this.color[i] : 0, -0.6);
      const near = Math.hypot(this.tx[i] - this.x[i], this.tz[i] - this.z[i]) < 0.8 && this.y[i] < gy + 1.2;
      if (near || this.y[i] < gy + 0.1 || this.age[i] > 3) this.burst[i] = 1;
    }
  }

  draw(): void {
    for (let i = 0; i < this.n; i++) {
      tmpP.set(this.x[i], this.y[i], this.z[i]);
      tmpV.set(this.x[i] + this.vx[i], this.y[i] + this.vy[i], this.z[i] + this.vz[i]);
      tmpM.lookAt(tmpV, tmpP, UP);
      tmpQ.setFromRotationMatrix(tmpM);
      tmpS.set(1, 1, 1);
      this.body.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS));
      // The smoke trail, as long as the last half second of its flight (it hangs in the air).
      const sp = Math.hypot(this.vx[i], this.vy[i], this.vz[i]);
      tmpS.set(0.22, 1, Math.min(4.5, 0.4 + sp * 0.3 * Math.min(1, this.age[i] * 2)));
      tmpP.set(this.x[i] - this.vx[i] * 0.012, this.y[i] - this.vy[i] * 0.012, this.z[i] - this.vz[i] * 0.012);
      this.trail.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS));
      this.trail.setColorAt(i, tmpC.set(this.color[i]).multiplyScalar(0.5 + 0.5 * fx.gain));
    }
    for (const m of [this.body, this.trail]) {
      m.count = this.n;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  clear(): void {
    this.n = 0;
  }
}

/** Merge geometries, each with one flat vertex colour (attribute `color`). */
export function mergeColored(parts: [BufferGeometry, number[]][]): BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  for (const [g0, c] of parts) {
    const g = g0.index ? g0.toNonIndexed() : g0;
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nor.push(n.getX(i), n.getY(i), n.getZ(i));
      col.push(c[0], c[1], c[2]);
    }
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new Float32BufferAttribute(col, 3));
  return out;
}

// ------------------------------------------------------------- comets ---

const COMET_CAP = 12;
/** How high a comet starts, and how far off to one side. */
const COMET_HEIGHT = 34;
const COMET_SLANT = 14;

/** The boulder scan (fx_props.py rock), lit, with its cracks glowing as it burns (comets) or not (hurls). */
export function rockMaterial(burning: boolean) {
  const t = fxTex();
  return fxMaterial({
    uniforms: { tAlb: { value: t.rock }, tNrm: { value: t.rockN } },
    defines: { BURNING: burning ? 1 : 0 },
    vertexShader: /* glsl */ `
      ${FX_VERT}
      ${SUNVIS_VERT}
      varying vec3 vN;
      varying vec3 vW;
      varying vec2 vUv;
      varying vec3 vInst;
      varying float vSunVis;
      varying vec3 vObj;
      void main() {
        vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
        vW = wp.xyz;
        vUv = uv;
        vObj = position;
        vInst = instanceColor;
        vSunVis = groundSunVisibility(wp.xz);
        computeHaze(wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      ${FX_FRAG}
      uniform sampler2D tAlb;
      uniform sampler2D tNrm;
      varying vec3 vN;
      varying vec3 vW;
      varying vec2 vUv;
      varying vec3 vInst;
      varying float vSunVis;
      varying vec3 vObj;
      // Tangent frame from derivatives (no tangents in the mesh).
      vec3 perturb(vec3 n, vec3 p, vec2 uv, vec3 m) {
        vec3 dp1 = dFdx(p), dp2 = dFdy(p);
        vec2 du1 = dFdx(uv), du2 = dFdy(uv);
        vec3 dp2perp = cross(dp2, n), dp1perp = cross(n, dp1);
        vec3 T = dp2perp * du1.x + dp1perp * du2.x;
        vec3 B = dp2perp * du1.y + dp1perp * du2.y;
        float inv = inversesqrt(max(dot(T, T), dot(B, B)) + 1e-12);
        return normalize(T * inv * m.x + B * inv * m.y + n * m.z);
      }
      void main() {
        vec3 alb = texture2D(tAlb, vUv).rgb;
        vec3 m = texture2D(tNrm, vUv).xyz * 2.0 - 1.0;
        vec3 n = perturb(normalize(vN), vW, vUv, m);
        #if BURNING
          // Scorched black, molten in the cracks.
          alb *= vec3(0.32, 0.29, 0.27);
        #else
          // An ice boulder: the scan under a skin of rime and clear ice.
          alb = mix(alb, vec3(0.62, 0.7, 0.8) * dot(alb, vec3(0.33)) * 2.2, 0.35);
        #endif
        float lum = dot(texture2D(tAlb, vUv).rgb, vec3(0.333));
        vec3 col = alb * dynamicLight(n, 1.0, vSunVis);
        vec3 V = normalize(cameraPosition - vW);
        #if BURNING
          float crack = smoothstep(0.16, 0.05, lum);
          float flick = 0.75 + 0.25 * sin(uFxTime * 17.0 + vObj.x * 40.0);
          col += fireTint(0.55 + 0.4 * crack) * (crack * 7.0 + 0.35) * flick * uEmit * vInst.r;
        #else
          col += envRadiance(reflect(-V, n), vSunVis, 60.0) * schlick(max(dot(n, V), 0.0), 0.03) * 0.8;
          // A cold glow deep in the cracks (what makes it a titan's ice, and visible at night).
          float crack = smoothstep(0.14, 0.04, lum);
          col += vec3(0.25, 0.65, 1.0) * crack * 1.6 * uEmit * vInst.r;
        #endif
        col = applyHaze(col, vHazeF);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

/** Swap an instanced mesh's geometry to the first mesh of a model once it loads. */
export function useModel(mesh: InstancedMesh, name: string, index = 0, scale = 1): void {
  fxModel(name)
    .then((geos) => {
      if (!geos[index]) return;
      const g = geos[index].clone();
      if (scale !== 1) g.scale(scale, scale, scale);
      const old = mesh.geometry;
      mesh.geometry = g;
      old.dispose();
    })
    .catch(() => undefined);
}

/** Burning rocks out of the sky trailing fire and smoke; where each will strike, the snow lights up. */
export class Comets {
  n = 0;
  readonly tx = new Float32Array(COMET_CAP);
  readonly tz = new Float32Array(COMET_CAP);
  readonly sx = new Float32Array(COMET_CAP);
  readonly sz = new Float32Array(COMET_CAP);
  readonly age = new Float32Array(COMET_CAP);
  readonly fall = new Float32Array(COMET_CAP);
  readonly dmg = new Float32Array(COMET_CAP);
  readonly radius = new Float32Array(COMET_CAP);
  readonly size = new Float32Array(COMET_CAP);
  private readonly rock: InstancedMesh;
  private readonly tail: InstancedMesh;
  readonly at = new Vector3();

  constructor(parent: Group, private readonly glow?: GroundGlow) {
    // The rock is the boulder scan (0.62 m across); its placeholder until it loads.
    this.rock = instanced(new IcosahedronGeometry(0.31, 1), rockMaterial(true), COMET_CAP, 'Comets', parent);
    useModel(this.rock, 'rock', 0, 1.6);
    const tailMat = fxMaterial({
      blend: 'premul',
      uniforms: { tMisc: { value: fxTex().misc }, uGain: fireGain },
      vertexShader: /* glsl */ `
        ${FX_VERT}
        ${RIBBON_VERT}
        void main() {
          vec3 wp = ribbon(2.6);
          computeHaze(wp);
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        ${FX_FRAG}
        uniform sampler2D tMisc;
        uniform float uGain;
        varying vec2 vRib;
        void main() {
          float x = vRib.x, t = vRib.y;
          vec2 nuv = vec2(0.5 + 0.5 * fract(x * 0.2 + t * 0.15 + 0.3), fract(t * 1.6 + uFxTime * 1.8));
          float n = texture2D(tMisc, nuv).r;
          float n2 = texture2D(tMisc, vec2(0.5 + 0.5 * fract(x * 0.35 + 0.7), fract(t * 3.1 + uFxTime * 3.3))).g;
          float core = exp(-x * x * (3.0 + 10.0 * t));
          // Fire close behind the rock, burning out into a long smoke trail.
          float fire = core * exp(-t * 7.0) * smoothstep(0.25, 0.65, n * 0.6 + n2 * 0.6 - t * 0.6 + 0.2);
          float heat = clamp(1.0 - t * 4.0, 0.0, 1.0);
          vec3 emit = fireTint(heat) * fire * 7.0 * (0.55 + 0.45 * uGain);
          float a = clamp(exp(-x * x * 2.0) * smoothstep(0.02, 0.2, t) * (1.0 - t) * (0.2 + 0.9 * n) * 0.8, 0.0, 1.0);
          vec3 smoke = vec3(0.06) * (uOpenSky * uSkyTint * uSkyGain + uSunColor * 0.2) + vec3(0.6, 0.25, 0.05) * 0.4 * uEmit * exp(-t * 5.0);
          gl_FragColor = fxOut(hazePremul(emit * uEmit, smoke, a, vHazeF), bgAir());
        }`,
    });
    this.tail = instanced(new PlaneGeometry(1, 1, 1, 10), tailMat, COMET_CAP, 'CometTails', parent, 5);
  }

  drop(tx: number, tz: number, fall: number, dmg: number, radius: number, size: number): void {
    if (this.n >= COMET_CAP) return;
    const i = this.n++;
    const a = Math.random() * Math.PI * 2;
    this.tx[i] = tx;
    this.tz[i] = tz;
    this.sx[i] = tx + Math.cos(a) * COMET_SLANT;
    this.sz[i] = tz + Math.sin(a) * COMET_SLANT;
    this.age[i] = 0;
    this.fall[i] = fall;
    this.dmg[i] = dmg;
    this.radius[i] = radius;
    this.size[i] = size;
  }

  remove(i: number): void {
    const j = --this.n;
    if (i === j) return;
    this.tx[i] = this.tx[j];
    this.tz[i] = this.tz[j];
    this.sx[i] = this.sx[j];
    this.sz[i] = this.sz[j];
    this.age[i] = this.age[j];
    this.fall[i] = this.fall[j];
    this.dmg[i] = this.dmg[j];
    this.radius[i] = this.radius[j];
    this.size[i] = this.size[j];
  }

  /** Comet i's position at its fraction of the fall (into `at`). */
  where(i: number, t: number): Vector3 {
    const gy = duneHeight(this.tx[i], this.tz[i]);
    // Accelerating in.
    const e = t * t;
    return this.at.set(this.sx[i] + (this.tx[i] - this.sx[i]) * e, gy + COMET_HEIGHT * (1 - e), this.sz[i] + (this.tz[i] - this.sz[i]) * e);
  }

  move(dt: number, embers: Embers): void {
    for (let i = 0; i < this.n; i++) {
      this.age[i] += dt;
      const t = Math.min(1, this.age[i] / this.fall[i]);
      const p = this.where(i, t);
      for (let k = 0; k < 3; k++) {
        embers.emit(p.x + (Math.random() - 0.5) * 0.6, p.y + (Math.random() - 0.5) * 0.6, p.z + (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 1.5, Math.random() * 1.5, (Math.random() - 0.5) * 1.5, 0.5 + Math.random() * 0.5, 0.35 * this.size[i]);
      }
    }
  }

  draw(time: number): void {
    for (let i = 0; i < this.n; i++) {
      const t = Math.min(1, this.age[i] / this.fall[i]);
      const p = this.where(i, t);
      tmpP.copy(p);
      const s = this.size[i];
      tmpQ.setFromAxisAngle(UP, time * 4 + i);
      tmpS.set(s, s, s);
      this.rock.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS));
      this.rock.setColorAt(i, tmpC.setRGB(1, 1, 1));
      // The tail, back up the way it came.
      tmpV.set(this.sx[i], p.y + 30, this.sz[i]);
      tmpM.lookAt(tmpV.sub(p).multiplyScalar(-1).add(p), p, UP);
      tmpQ.setFromRotationMatrix(tmpM);
      tmpS.set(s * 1.6, 1, 11 * s);
      this.tail.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS));
      // Where it will strike: the fireball's light on the snow, growing as it falls (1/r^2 from its height).
      if (this.glow) {
        const h = COMET_HEIGHT * (1 - t * t) + 1.5;
        const e = Math.min(0.7, 18 / (h * h));
        this.glow.add(this.tx[i], this.tz[i], this.radius[i] * (1.1 + 0.5 * (1 - t)), 1.0, 0.55, 0.22, e, i * 1.3);
        this.glow.add(this.tx[i], this.tz[i], this.radius[i], 1.0, 0.45, 0.15, 0.08 + 0.25 * t, i, 0.06);
      }
    }
    for (const m of [this.rock, this.tail]) {
      m.count = this.n;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  clear(): void {
    this.n = 0;
  }
}
