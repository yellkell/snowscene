/**
 * The night sky over the expedition: a wheeling star field with the Milky
 * Way, a phased moon with a soft halo, aurora curtains and meteors.
 *
 * Everything here is a sky-dome layer: drawn right after the sky sphere
 * (render orders between the sky's -1e9 and FAR_LAYER_ORDER), opaque-queue
 * so the far layer and the terrain simply paint over it, no depth test, no
 * depth write, additive (the moon uses premultiplied "over" so its dark limb
 * hides the stars behind it). Colours are authored in display space: these
 * layers skip tone mapping, so they read the same at any exposure, and they
 * fade with daylight, cloud and whiteout instead.
 *
 * Cost: 5 draw calls at most (each hidden when invisible), ~3.8k points and
 * ~2.5k triangles; fragment shaders are a few ALU ops and <= 3 texture reads.
 */

import {
  AdditiveBlending,
  BufferGeometry,
  CustomBlending,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Matrix4,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  Points,
  Quaternion,
  ShaderMaterial,
  type Texture,
  Vector3,
} from '@iwsdk/core';
import { mulberry32 } from '../../terrain.js';
import { CELESTIAL_POLE, siderealAngle } from './sky-math.js';

/** Dome radius for the layers (they follow the head; depth is ignored). */
const R = 1000;
const DEG = Math.PI / 180;

export const NIGHT_ORDER = {
  milkyWay: -6e8,
  stars: -5e8,
  aurora: -4e8,
  moon: -3e8,
  meteors: -2e8,
};

/** Shared vertex tail: keep the vertex inside the clip volume at any distance. */
const DOME_Z = /* glsl */ `gl_Position.z = gl_Position.w * 0.99999;`;

export interface NightSkyState {
  head: Vector3;
  time: number;
  dt: number;
  hours: number;
  sun: Vector3;
  moon: Vector3;
  /** Star / Milky Way visibility 0..1. */
  stars: number;
  /** Moon visibility 0..1 and how much of a halo (haze, thin cloud). */
  moonAlpha: number;
  moonHalo: number;
  /** 0 by day (the moon is a pale additive disc), 1 at night (it occludes stars). */
  night: number;
  aurora: number;
  /** Expected meteors per second. */
  meteorRate: number;
}

// ------------------------------------------------------------- celestial ---

/** Unit vector for right ascension / declination in the celestial frame (pole = +Y). */
function equatorial(raDeg: number, decDeg: number, out: Vector3): Vector3 {
  const a = raDeg * DEG;
  const d = decDeg * DEG;
  return out.set(Math.cos(d) * Math.sin(a), Math.sin(d), Math.cos(d) * Math.cos(a));
}

const GAL_POLE = equatorial(192.86, 27.13, new Vector3());
const GAL_CENTRE = (() => {
  const c = equatorial(266.4, -28.94, new Vector3());
  return c.addScaledVector(GAL_POLE, -c.dot(GAL_POLE)).normalize();
})();
const GAL_Y = new Vector3().crossVectors(GAL_POLE, GAL_CENTRE).normalize();

function galactic(l: number, b: number, out: Vector3): Vector3 {
  const cb = Math.cos(b);
  return out
    .set(0, 0, 0)
    .addScaledVector(GAL_CENTRE, cb * Math.cos(l))
    .addScaledVector(GAL_Y, cb * Math.sin(l))
    .addScaledVector(GAL_POLE, Math.sin(b));
}

/** Perseid-like shower radiant, celestial frame. */
const RADIANT = equatorial(48, 58, new Vector3());

// ------------------------------------------------------------------ stars --

function buildStars(): Points {
  const rand = mulberry32(4242);
  const count = 3800;
  const pos = new Float32Array(count * 3);
  const tint = new Float32Array(count * 3);
  const mag = new Float32Array(count);
  const seed = new Float32Array(count);
  const v = new Vector3();
  for (let i = 0; i < count; i++) {
    if (i < 2500) {
      // Uniform over the sphere.
      const y = rand() * 2 - 1;
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(1 - y * y);
      v.set(r * Math.cos(a), y, r * Math.sin(a));
    } else {
      // Crowded toward the galactic plane.
      const g = (rand() + rand() + rand() - 1.5) * 0.36;
      galactic(rand() * Math.PI * 2, g, v);
    }
    v.normalize().multiplyScalar(R);
    pos[i * 3] = v.x;
    pos[i * 3 + 1] = v.y;
    pos[i * 3 + 2] = v.z;
    const m = Math.pow(rand(), 5.5);
    mag[i] = m;
    // Colour temperature: mostly white, some blue-white, some orange.
    const t = rand();
    if (t < 0.18) tint.set([1.0, 0.8, 0.6], i * 3);
    else if (t < 0.4) tint.set([0.78, 0.86, 1.0], i * 3);
    else if (t < 0.5) tint.set([1.0, 0.93, 0.78], i * 3);
    else tint.set([0.95, 0.97, 1.0], i * 3);
    seed[i] = rand();
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geometry.setAttribute('aTint', new Float32BufferAttribute(tint, 3));
  geometry.setAttribute('aMag', new Float32BufferAttribute(mag, 1));
  geometry.setAttribute('aSeed', new Float32BufferAttribute(seed, 1));
  const material = new ShaderMaterial({
    uniforms: { uAlpha: { value: 0 }, uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      uniform float uAlpha;
      uniform float uTime;
      attribute vec3 aTint;
      attribute float aMag;
      attribute float aSeed;
      varying vec3 vColor;
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        ${DOME_Z}
        float alt = normalize((modelMatrix * vec4(position, 0.0)).xyz).y;
        // Extinction and stronger scintillation toward the horizon.
        float ext = smoothstep(-0.03, 0.28, alt);
        float scint = 0.12 + 0.45 * (1.0 - smoothstep(0.05, 0.6, alt));
        float tw = 1.0 + scint * sin(uTime * (2.3 + aSeed * 7.0) + aSeed * 71.0)
                       * sin(uTime * (0.9 + aSeed * 3.1) + aSeed * 13.0);
        float b = (0.07 + 0.93 * aMag) * ext * tw * uAlpha;
        vColor = aTint * b;
        gl_PointSize = 1.5 + 3.2 * aMag;
        if (b < 0.004) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float f = exp(-dot(c, c) * 14.0);
        gl_FragColor = vec4(vColor * f, 1.0);
      }
    `,
    blending: AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    transparent: false,
    fog: false,
  });
  const points = new Points(geometry, material);
  points.name = 'ExpStars';
  points.frustumCulled = false;
  points.renderOrder = NIGHT_ORDER.stars;
  return points;
}

// ------------------------------------------------------------- milky way --

function buildMilkyWay(noise: Texture): Mesh {
  const cols = 160;
  const rows = [-26, -15, -8, -3, 0, 3, 8, 15, 26];
  const pos: number[] = [];
  const gal: number[] = [];
  const index: number[] = [];
  const v = new Vector3();
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c <= cols; c++) {
      const l = c / cols;
      galactic(l * Math.PI * 2, rows[r] * DEG, v).multiplyScalar(R);
      pos.push(v.x, v.y, v.z);
      gal.push(l, rows[r]);
    }
  }
  for (let r = 0; r < rows.length - 1; r++) {
    for (let c = 0; c < cols; c++) {
      const a = r * (cols + 1) + c;
      const b = a + cols + 1;
      index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geometry.setAttribute('aGal', new Float32BufferAttribute(gal, 2));
  geometry.setIndex(index);
  const material = new ShaderMaterial({
    uniforms: { uAlpha: { value: 0 }, uNoise: { value: noise } },
    vertexShader: /* glsl */ `
      attribute vec2 aGal;
      varying vec2 vGal;
      varying float vAlt;
      void main() {
        vGal = aGal;
        vAlt = normalize((modelMatrix * vec4(position, 0.0)).xyz).y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        ${DOME_Z}
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uAlpha;
      uniform sampler2D uNoise;
      varying vec2 vGal;
      varying float vAlt;
      void main() {
        float l = vGal.x;
        float b = vGal.y;
        float dl = min(l, 1.0 - l) * 6.2832;
        float core = exp(-dl * dl * 2.8);
        float width = 6.5 + 8.0 * core;
        float band = exp(-b * b / (width * width));
        vec2 uv = vec2(l * 4.0, b * 0.018);
        float n1 = texture2D(uNoise, uv + 0.17).r;
        float n2 = texture2D(uNoise, uv * 3.0 + 0.53).g;
        float clouds = smoothstep(0.28, 0.82, n1 * 0.6 + n2 * 0.55);
        // The dark rift: dust lanes wandering along the plane.
        float lane = (b + 1.0 - (n1 - 0.5) * 7.0) / 2.4;
        float rift = 1.0 - 0.8 * exp(-lane * lane) * smoothstep(0.35, 0.65, n2) * (0.4 + 0.6 * core);
        float I = band * (0.3 + 0.95 * clouds) * rift * (0.55 + 1.1 * core);
        I *= smoothstep(-0.02, 0.35, vAlt) * uAlpha;
        vec3 col = mix(vec3(0.6, 0.68, 0.95), vec3(1.0, 0.86, 0.7), core * 0.85);
        gl_FragColor = vec4(col * I * 0.085, 1.0);
      }
    `,
    blending: AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    transparent: false,
    fog: false,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'ExpMilkyWay';
  mesh.frustumCulled = false;
  mesh.renderOrder = NIGHT_ORDER.milkyWay;
  return mesh;
}

// ----------------------------------------------------------------- aurora --

/** Curtains: azimuth centre, span, base elevation, height (degrees; azimuth from north toward east). */
const CURTAINS = [
  [-4, 120, 9, 30],
  [-38, 78, 17, 22],
  [34, 70, 6, 17],
];

function buildAurora(noise: Texture): Mesh {
  const seg = 96;
  const pos: number[] = [];
  const index: number[] = [];
  for (let c = 0; c < CURTAINS.length; c++) {
    const base = pos.length / 3;
    for (let i = 0; i <= seg; i++) {
      const u = i / seg;
      pos.push(u, 0, c, u, 1, c);
    }
    for (let i = 0; i < seg; i++) {
      const a = base + i * 2;
      index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geometry.setIndex(index);
  const glslCurtains = CURTAINS.map(
    (c) => `vec4(${(c[0] * DEG).toFixed(4)}, ${(c[1] * DEG).toFixed(4)}, ${(c[2] * DEG).toFixed(4)}, ${(c[3] * DEG).toFixed(4)})`,
  ).join(', ');
  const material = new ShaderMaterial({
    uniforms: { uStrength: { value: 0 }, uTime: { value: 0 }, uNoise: { value: noise } },
    vertexShader: /* glsl */ `
      uniform float uTime;
      varying vec2 vUv;
      varying float vId;
      const vec4 CURTAINS[3] = vec4[3](${glslCurtains});
      void main() {
        float u = position.x;
        float v = position.y;
        float id = position.z;
        vec4 c = CURTAINS[int(id + 0.5)];
        float t = uTime;
        // Slow folds travelling along the curtain, finer ripples on top.
        float az = c.x + (u - 0.5) * c.y
          + 0.07 * sin(u * 6.0 + t * 0.11 + id * 2.1)
          + 0.025 * sin(u * 19.0 - t * 0.27 + id * 4.7);
        float el = c.z + 0.025 * sin(u * 4.3 + t * 0.07 + id * 1.3)
          + v * c.w * (0.8 + 0.35 * sin(u * 3.1 + id + t * 0.05));
        vec3 dir = vec3(sin(az) * cos(el), sin(el), -cos(az) * cos(el));
        vUv = vec2(u, v);
        vId = id;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(dir * ${R.toFixed(1)}, 1.0);
        ${DOME_Z}
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uStrength;
      uniform float uTime;
      uniform sampler2D uNoise;
      varying vec2 vUv;
      varying float vId;
      void main() {
        float u = vUv.x;
        float v = vUv.y;
        float t = uTime;
        // Vertical rays drifting along the arc, at two scales.
        float rays = texture2D(uNoise, vec2(u * 2.6 + vId * 0.37 + t * 0.0035, 0.21 * vId + v * 0.03)).b;
        float fine = texture2D(uNoise, vec2(u * 9.0 - t * 0.009 + vId * 0.61, 0.73 + v * 0.02)).g;
        float r = smoothstep(0.3, 0.85, rays * 0.55 + fine * 0.6);
        // Bright surges sweeping along the curtain.
        float surge = smoothstep(0.32, 0.78, texture2D(uNoise, vec2(u * 0.55 - t * 0.0055 + vId * 0.23, t * 0.0017 + vId * 0.5)).r);
        // Sharp lower hem, long fade upward.
        float prof = smoothstep(0.0, 0.07, v) * exp(-v * 2.3);
        float ends = smoothstep(0.0, 0.16, u) * smoothstep(1.0, 0.84, u);
        vec3 col = mix(vec3(0.1, 1.0, 0.42), vec3(0.5, 0.2, 0.95), smoothstep(0.22, 0.85, v));
        // Magenta fringe on the hem when a surge passes.
        col = mix(col, vec3(1.0, 0.25, 0.6), (1.0 - smoothstep(0.0, 0.09, v)) * surge * 0.55);
        float a = prof * ends * (0.3 + 0.7 * r) * (0.35 + 0.95 * surge) * uStrength;
        gl_FragColor = vec4(col * a * 0.34, 1.0);
      }
    `,
    blending: AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    transparent: false,
    side: DoubleSide,
    fog: false,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'ExpAurora';
  mesh.frustumCulled = false;
  mesh.renderOrder = NIGHT_ORDER.aurora;
  return mesh;
}

// ------------------------------------------------------------------- moon --

/** Disc radius (radians; ~2.3x the real moon so it reads in the headset) and halo extent. */
const MOON_RADIUS = 0.6 * DEG;
const MOON_HALO = 9;

function buildMoon(noise: Texture): Mesh {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const material = new ShaderMaterial({
    uniforms: {
      uDir: { value: new Vector3(0, 1, 0) },
      uX: { value: new Vector3(1, 0, 0) },
      uY: { value: new Vector3(0, 0, 1) },
      uSunLocal: { value: new Vector3(0, 0, 1) },
      uAlpha: { value: 0 },
      uHalo: { value: 0 },
      uNight: { value: 0 },
      uNoise: { value: noise },
    },
    vertexShader: /* glsl */ `
      uniform vec3 uDir;
      uniform vec3 uX;
      uniform vec3 uY;
      varying vec2 vP;
      void main() {
        vP = position.xy * ${MOON_HALO.toFixed(1)};
        vec3 d = uDir + (uX * position.x + uY * position.y) * ${Math.tan(MOON_RADIUS * MOON_HALO).toFixed(5)};
        gl_Position = projectionMatrix * modelViewMatrix * vec4(d * ${R.toFixed(1)}, 1.0);
        ${DOME_Z}
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunLocal;
      uniform float uAlpha;
      uniform float uHalo;
      uniform float uNight;
      uniform sampler2D uNoise;
      varying vec2 vP;
      void main() {
        float r = length(vP);
        float disc = 1.0 - smoothstep(0.93, 1.0, r);
        vec3 n = vec3(vP, sqrt(max(0.0, 1.0 - r * r)));
        float lit = smoothstep(-0.06, 0.1, dot(n, uSunLocal));
        // Maria and highlands, limb darkening.
        float maria = texture2D(uNoise, vP * 0.2 + vec2(0.31, 0.62)).r;
        float alb = mix(0.62, 1.05, smoothstep(0.38, 0.62, maria)) * (0.78 + 0.22 * n.z);
        vec3 face = vec3(1.0, 0.97, 0.9) * alb * lit;
        float halo = (exp(-r * 0.75) * 0.1 + exp(-r * 2.2) * 0.22) * uHalo * (1.0 - disc);
        vec3 col = face * disc + vec3(0.55, 0.65, 0.85) * halo;
        gl_FragColor = vec4(col * uAlpha, disc * uAlpha * uNight);
      }
    `,
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
    depthTest: false,
    depthWrite: false,
    transparent: false,
    fog: false,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'ExpMoon';
  mesh.frustumCulled = false;
  mesh.renderOrder = NIGHT_ORDER.moon;
  return mesh;
}

// ---------------------------------------------------------------- meteors --

const METEORS = 6;

function buildMeteors(): Mesh {
  const pos: number[] = [];
  const index: number[] = [];
  for (let i = 0; i < METEORS; i++) {
    // x: along (0 tail .. 1 head), y: side (-1..1), z: slot
    pos.push(0, -1, i, 1, -1, i, 1, 1, i, 0, 1, i);
    const a = i * 4;
    index.push(a, a + 1, a + 2, a, a + 2, a + 3);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geometry.setIndex(index);
  const starts: Vector3[] = [];
  const dirs: Vector3[] = [];
  const params: Vector3[] = [];
  const looks: Vector3[] = [];
  for (let i = 0; i < METEORS; i++) {
    starts.push(new Vector3(0, 1, 0));
    dirs.push(new Vector3(1, 0, 0));
    params.push(new Vector3(-100, 1, 0)); // start time, duration, arc length
    looks.push(new Vector3(0, 0, 0)); // brightness, width, colour mix
  }
  const material = new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uStart: { value: starts },
      uDir: { value: dirs },
      uParam: { value: params },
      uLook: { value: looks },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uStart[${METEORS}];
      uniform vec3 uDir[${METEORS}];
      uniform vec3 uParam[${METEORS}];
      uniform vec3 uLook[${METEORS}];
      varying float vAlong;
      varying float vSide;
      varying float vBright;
      varying float vMix;
      void main() {
        int i = int(position.z + 0.5);
        vec3 P = uParam[i];
        vec3 L = uLook[i];
        float age = (uTime - P.x) / P.y;
        float alive = step(0.0, age) * step(age, 1.0);
        float head = clamp(age, 0.0, 1.0) * P.z;
        float tail = max(0.0, head - P.z * 0.5);
        float a = mix(tail, head, position.x);
        vec3 d = uStart[i] * cos(a) + uDir[i] * sin(a);
        vec3 side = normalize(cross(d, uDir[i]));
        float w = L.y * (0.25 + 0.75 * position.x);
        gl_Position = projectionMatrix * modelViewMatrix * vec4((d + side * position.y * w) * ${R.toFixed(1)}, 1.0);
        ${DOME_Z}
        if (alive < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        vAlong = position.x;
        vSide = position.y;
        // Flare up quickly, burn, fade out at the end.
        vBright = L.x * smoothstep(0.0, 0.12, age) * (1.0 - smoothstep(0.7, 1.0, age));
        vMix = L.z;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlong;
      varying float vSide;
      varying float vBright;
      varying float vMix;
      void main() {
        float core = exp(-vSide * vSide * 5.0);
        float trail = vAlong * vAlong * vAlong;
        vec3 col = mix(vec3(0.85, 0.92, 1.0), vec3(0.55, 1.0, 0.7), vMix * (1.0 - vAlong * 0.5));
        col = mix(col, vec3(1.0, 0.95, 0.85), smoothstep(0.85, 1.0, vAlong));
        gl_FragColor = vec4(col * core * trail * vBright, 1.0);
      }
    `,
    blending: AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    transparent: false,
    fog: false,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'ExpMeteors';
  mesh.frustumCulled = false;
  mesh.renderOrder = NIGHT_ORDER.meteors;
  return mesh;
}

// ---------------------------------------------------------------- the sky --

export class NightSky {
  /** Add this to the scene; it follows the viewer. */
  readonly group = new Group();
  private readonly celestial = new Group();
  private readonly stars: Points;
  private readonly milkyWay: Mesh;
  private readonly aurora: Mesh;
  private readonly moon: Mesh;
  private readonly meteors: Mesh;
  private readonly basis = new Quaternion();
  private readonly spin = new Quaternion();
  private readonly yAxis = new Vector3(0, 1, 0);
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly radiant = new Vector3();
  private readonly meteorEnd = new Float32Array(METEORS);
  private meteorLive = 0;

  constructor(noise: Texture) {
    this.group.name = 'ExpNightSky';
    this.stars = buildStars();
    this.milkyWay = buildMilkyWay(noise);
    this.aurora = buildAurora(noise);
    this.moon = buildMoon(noise);
    this.meteors = buildMeteors();
    this.celestial.add(this.milkyWay, this.stars);
    this.group.add(this.celestial, this.aurora, this.moon, this.meteors);

    // Celestial frame: X east, Y the celestial pole, Z the equator on the meridian.
    const x = new Vector3(1, 0, 0);
    const y = new Vector3(CELESTIAL_POLE.x, CELESTIAL_POLE.y, CELESTIAL_POLE.z);
    const z = new Vector3().crossVectors(x, y);
    this.basis.setFromRotationMatrix(new Matrix4().makeBasis(x, y, z));
    this.meteorEnd.fill(-1);
  }

  update(s: NightSkyState): void {
    this.group.position.copy(s.head);

    // Stars wheel about the pole: rotation -LST about the celestial Y axis.
    this.spin.setFromAxisAngle(this.yAxis, -siderealAngle(s.hours));
    this.celestial.quaternion.copy(this.basis).multiply(this.spin);

    const starsOn = s.stars > 0.003;
    this.celestial.visible = starsOn;
    if (starsOn) {
      const su = (this.stars.material as ShaderMaterial).uniforms;
      su.uAlpha.value = s.stars;
      su.uTime.value = s.time;
      (this.milkyWay.material as ShaderMaterial).uniforms.uAlpha.value = s.stars * s.stars;
    }

    const auroraOn = s.aurora > 0.003;
    this.aurora.visible = auroraOn;
    if (auroraOn) {
      const au = (this.aurora.material as ShaderMaterial).uniforms;
      au.uStrength.value = s.aurora;
      au.uTime.value = s.time;
    }

    this.updateMoon(s);
    this.updateMeteors(s);
  }

  private updateMoon(s: NightSkyState): void {
    const m = s.moon;
    const on = s.moonAlpha > 0.003 && m.y > -0.06;
    this.moon.visible = on;
    if (!on) return;
    const u = (this.moon.material as ShaderMaterial).uniforms;
    const zAxis = this.tmp.copy(m).negate(); // the disc faces the viewer
    const xAxis = (u.uX.value as Vector3).crossVectors(this.yAxis, zAxis);
    if (xAxis.lengthSq() < 1e-6) xAxis.set(1, 0, 0);
    xAxis.normalize();
    const yAxis = (u.uY.value as Vector3).crossVectors(zAxis, xAxis).normalize();
    (u.uDir.value as Vector3).copy(m);
    (u.uSunLocal.value as Vector3).set(s.sun.dot(xAxis), s.sun.dot(yAxis), s.sun.dot(zAxis));
    u.uAlpha.value = s.moonAlpha;
    u.uHalo.value = s.moonHalo;
    u.uNight.value = s.night;
  }

  private updateMeteors(s: NightSkyState): void {
    const u = (this.meteors.material as ShaderMaterial).uniforms;
    u.uTime.value = s.time;
    // Spawn (Poisson) into a free slot.
    if (s.meteorRate > 0 && Math.random() < s.meteorRate * s.dt) this.spawnMeteor(s, u);
    let live = 0;
    for (let i = 0; i < METEORS; i++) if (this.meteorEnd[i] > s.time) live++;
    this.meteorLive = live;
    this.meteors.visible = live > 0;
  }

  private spawnMeteor(s: NightSkyState, u: ShaderMaterial['uniforms']): void {
    let slot = -1;
    for (let i = 0; i < METEORS; i++) {
      if (this.meteorEnd[i] <= s.time) {
        slot = i;
        break;
      }
    }
    if (slot < 0 || this.meteorLive >= METEORS) return;
    const start = (u.uStart.value as Vector3[])[slot];
    const dir = (u.uDir.value as Vector3[])[slot];
    const param = (u.uParam.value as Vector3[])[slot];
    const look = (u.uLook.value as Vector3[])[slot];
    const fireball = Math.random() < 0.12;
    const shower = Math.random() < 0.7;
    this.radiant.copy(RADIANT).applyQuaternion(this.celestial.quaternion);
    // Start somewhere 25-75 degrees up.
    const az = Math.random() * Math.PI * 2;
    const el = (25 + Math.random() * 50) * DEG;
    start.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    if (shower && this.radiant.y > -0.1) {
      // Streak away from the radiant along the great circle through it.
      dir.copy(start).multiplyScalar(start.dot(this.radiant)).sub(this.radiant);
    } else {
      // Sporadic: any direction, biased downward.
      this.tmp2.set(Math.random() - 0.5, -0.6 - Math.random(), Math.random() - 0.5);
      dir.copy(this.tmp2).addScaledVector(start, -this.tmp2.dot(start));
    }
    if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0).addScaledVector(start, -start.x);
    dir.normalize();
    const duration = fireball ? 1.6 + Math.random() * 1.2 : 0.35 + Math.random() * 0.8;
    const arc = (fireball ? 22 + Math.random() * 18 : 6 + Math.random() * 14) * DEG;
    param.set(s.time, duration, arc);
    const bright = fireball ? 1.4 + Math.random() * 0.8 : 0.35 + Math.random() * 0.6;
    look.set(bright * s.stars, (fireball ? 0.0034 : 0.0015) * (0.8 + Math.random() * 0.4), fireball ? 0.7 : Math.random() * 0.25);
    this.meteorEnd[slot] = s.time + duration;
  }
}
