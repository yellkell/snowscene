/**
 * Snow Survivors' weapons and pickups, drawn: pooled and instanced so a screen full of bolts, swords,
 * crystals and lightning costs a handful of draws. Also the ice boulders the big ones hurl back at you.
 * The survivors system owns the rules; these only hold state that moves on its own (a bolt's flight, a
 * crystal's bob) and draw it.
 *
 * Everything solid is lit by the evening's light (bakedLight: sun, sky, snow bounce) and everything that
 * glows emits physical radiance (fx-assets.ts): ice shards that refract the sky, forged swords, the
 * boulder scan, faceted crystals lit from within, a plank chest under a shaft of light. Hits kick up snow
 * powder (a Cycles volume flipbook) with ice-crystal glints; frost blasts drive a ring of snow dust over
 * the field; chain lightning is a branching arc with a white-hot core in a blue corona.
 */

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  type Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  Object3D,
  OctahedronGeometry,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  type ShaderMaterial,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector3,
  CylinderGeometry,
  IcosahedronGeometry,
} from '@iwsdk/core';
import { FX_FRAG, FX_VERT, GroundDecals, GroundGlow, InstPool, SUNVIS_VERT, fxMaterial, fxModel, fxTex, unitQuad } from './fx-assets.js';
import { RIBBON_VERT, rockMaterial, useModel } from './fire-fx.js';
import { duneHeight } from './survivors-level.js';

const tmpM = new Matrix4();
const tmpM2 = new Matrix4();
const tmpQ = new Quaternion();
const tmpS = new Vector3();
const tmpP = new Vector3();
const UP = new Vector3(0, 1, 0);
const X_AXIS = new Vector3(1, 0, 0);
const Z_AXIS = new Vector3(0, 0, 1);
const spinQ = new Quaternion();
const tmpC = new Color();

/** The ground systems effects paint with (one of each, shared). */
export interface FxGround {
  glow: GroundGlow;
  decals: GroundDecals;
}

function instanced(geo: BufferGeometry, material: ShaderMaterial, cap: number, name: string, parent: Group, order = 0): InstancedMesh {
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

function flush(...meshes: InstancedMesh[]): void {
  for (const m of meshes) {
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }
}

/** Shared vertex stage for lit instanced solids (world normal, position, uv, instance colour, sun visibility). */
const SOLID_VERT = /* glsl */ `
${FX_VERT}
${SUNVIS_VERT}
varying vec3 vN;
varying vec3 vW;
varying vec2 vUv;
varying vec3 vInst;
varying float vSunVis;
varying vec3 vObj;
#ifdef VCOL
attribute vec4 color;
varying vec4 vVcol;
#endif
void main() {
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  vW = wp.xyz;
  vUv = uv;
  vObj = position;
  vInst = instanceColor;
  vSunVis = groundSunVisibility(wp.xz);
  #ifdef VCOL
  vVcol = color;
  #endif
  computeHaze(wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const SOLID_FRAG_HEAD = /* glsl */ `
${FX_FRAG}
varying vec3 vN;
varying vec3 vW;
varying vec2 vUv;
varying vec3 vInst;
varying float vSunVis;
varying vec3 vObj;
#ifdef VCOL
varying vec4 vVcol;
#endif
`;

/** Lit metal and wood (chest, swords): albedo map, COLOR_0 = (metal, roughness). */
function propMaterial(map: import('@iwsdk/core').Texture, extra = ''): ShaderMaterial {
  return fxMaterial({
    uniforms: { tAlb: { value: map } },
    defines: { VCOL: 1 },
    vertexShader: SOLID_VERT,
    fragmentShader: /* glsl */ `
      ${SOLID_FRAG_HEAD}
      uniform sampler2D tAlb;
      void main() {
        vec3 alb = texture2D(tAlb, vUv).rgb;
        vec3 n = normalize(vN);
        if (!gl_FrontFacing) n = -n;
        vec3 V = normalize(cameraPosition - vW);
        float metal = vVcol.r;
        float rough = clamp(vVcol.g, 0.05, 1.0);
        float gloss = mix(900.0, 8.0, rough);
        vec3 R = reflect(-V, n);
        vec3 diff = alb * dynamicLight(n, 1.0, vSunVis) * (1.0 - metal);
        float f = schlick(max(dot(n, V), 0.0), 0.04);
        vec3 spec = envRadiance(R, vSunVis, gloss) * mix(vec3(f) * (1.0 - rough * 0.7), alb, metal);
        vec3 col = diff + spec;
        ${extra}
        col = applyHaze(col, vHazeF);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

// ------------------------------------------------------------ impacts ---

const IMPACT_CAP = 160;
const IMPACT_LIFE = 0.5;

/**
 * Hits: a puff of snow powder kicked out where a bolt, a blade or a bolt of lightning lands (a Cycles
 * volume flipbook, re-lit by the evening), ice crystals glinting in it, and a brief hot flash of the
 * hit's colour at its heart so you still read every hit. Pooled; the oldest goes when it is full.
 */
export class Impacts {
  private readonly pool: InstPool;
  private readonly x = new Float32Array(IMPACT_CAP);
  private readonly y = new Float32Array(IMPACT_CAP);
  private readonly z = new Float32Array(IMPACT_CAP);
  private readonly size = new Float32Array(IMPACT_CAP);
  private readonly age = new Float32Array(IMPACT_CAP).fill(1);
  private readonly spin = new Float32Array(IMPACT_CAP);
  private readonly color = new Uint32Array(IMPACT_CAP);
  private next = 0;

  constructor(parent: Group) {
    const mat = fxMaterial({
      blend: 'premul',
      uniforms: { tPowder: { value: fxTex().powder } },
      vertexShader: /* glsl */ `
        ${FX_VERT}
        ${SUNVIS_VERT}
        attribute vec4 aPos;  // xyz, size
        attribute vec4 aData; // age 0..1, spin, seed, near fade
        attribute vec4 aCol;  // hit colour
        varying vec2 vUv;
        varying vec4 vData;
        varying vec3 vCol;
        varying float vSunVis;
        void main() {
          vec3 f = normalize(cameraPosition - aPos.xyz);
          vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), f) + vec3(1e-4, 0.0, 0.0));
          vec3 up = cross(f, right);
          float c = cos(aData.y), s = sin(aData.y);
          vec2 p = mat2(c, s, -s, c) * position.xy;
          vec3 wp = aPos.xyz + (right * p.x + up * p.y) * aPos.w;
          vUv = position.xy + 0.5;
          vData = aData;
          vCol = aCol.rgb;
          vSunVis = groundSunVisibility(aPos.xz);
          computeHaze(wp);
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        ${FX_FRAG}
        uniform sampler2D tPowder;
        varying vec2 vUv;
        varying vec4 vData;
        varying vec3 vCol;
        varying float vSunVis;
        void main() {
          float age = vData.x;
          vec4 s = flipbook(tPowder, vUv, age * 15.0, vec2(4.0), 16.0, false);
          float a = s.r * (1.0 - age * age) * vData.w;
          // Snow dust lit by the sky (its own self-shadowing in G) and the sun (B).
          vec3 dust = (0.5 + 0.6 * s.g) * uOpenSky * uSkyTint * uSkyGain + (0.25 + s.b) * uSunColor * 0.3183 * vSunVis * 1.4;
          vec2 q = vUv - 0.5;
          float r2 = dot(q, q);
          // The hit itself: a hot flash of its colour, gone in a tenth of a second.
          float flash = exp(-r2 * 90.0) * max(0.0, 1.0 - age * 6.0);
          vec3 emit = (vCol * 7.0 + vec3(3.0)) * flash;
          // Ice crystals in the burst catching the light.
          vec2 g = vUv * 9.0 + vData.z * 17.0;
          vec2 cell = floor(g);
          float h = hash12(cell);
          if (h > 0.82 && s.r > 0.04) {
            vec2 pt = cell + 0.5 + 0.35 * vec2(hash12(cell + 3.1) - 0.5, hash12(cell + 7.7) - 0.5);
            float d = length(g - pt);
            float tw = 0.5 + 0.5 * sin(uFxTime * 40.0 * h + h * 50.0);
            emit += (vec3(0.9, 0.95, 1.0) * (1.0 + 4.0 * vSunVis) + vCol) * exp(-d * d * 40.0) * tw * (1.0 - age) * 2.5;
          }
          emit *= vData.w;
          vec4 o = hazePremul(emit * uEmit, dust, clamp(a, 0.0, 1.0), vHazeF);
          if (o.a < 0.003 && dot(o.rgb, vec3(1.0)) < 0.003) discard;
          gl_FragColor = fxOut(o, bgAir());
        }`,
    });
    this.pool = new InstPool(unitQuad(), mat, IMPACT_CAP, ['aPos', 'aData', 'aCol'], parent, 'Impacts', 6);
  }

  spawn(x: number, y: number, z: number, color: number, size: number): void {
    const i = this.next;
    this.next = (this.next + 1) % IMPACT_CAP;
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = z;
    this.size[i] = size;
    this.age[i] = 0;
    this.spin[i] = Math.random() * Math.PI * 2;
    this.color[i] = color;
  }

  /** Age them and face them to `eye`. */
  tick(dt: number, eye: Vector3): void {
    const p = this.pool;
    p.begin();
    for (let i = 0; i < IMPACT_CAP; i++) {
      if (this.age[i] >= 1) continue;
      this.age[i] = Math.min(1, this.age[i] + dt / IMPACT_LIFE);
      const d = Math.hypot(this.x[i] - eye.x, this.y[i] - eye.y, this.z[i] - eye.z);
      // The puff is the flipbook's own growth; never filling your view, dimmed right beside you.
      const s = Math.min(this.size[i] * 2.2, d * 0.5);
      const near = Math.min(1, Math.max(0.15, (d - 0.8) / 2.5));
      const k = p.add();
      tmpC.set(this.color[i]);
      p.set('aPos', k, this.x[i], this.y[i], this.z[i], s);
      p.set('aData', k, this.age[i], this.spin[i] + this.age[i] * 0.6, i * 0.37, near);
      p.set('aCol', k, tmpC.r, tmpC.g, tmpC.b, 0);
    }
    p.end();
  }

  clear(): void {
    this.age.fill(1);
    this.pool.begin();
    this.pool.end();
  }
}

// ------------------------------------------------------------- bolts ---

export const BOLT_CAP = 700;

/** A long shard of ice along +Z (tip forward): a hexagonal bipyramid, unevenly faceted. Flat normals. */
function icicleGeometry(): BufferGeometry {
  const ring: number[][] = [];
  const sides = 6;
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2 + 0.3;
    const r = 0.07 * (0.85 + 0.3 * ((i * 7919) % 5) / 4);
    ring.push([Math.cos(a) * r, Math.sin(a) * r * 0.8]);
  }
  const tip = [0, 0.01, 0.55];
  const back = [0, -0.005, -0.3];
  const z0 = 0.06;
  const pos: number[] = [];
  const tri = (a: number[], b: number[], c: number[]) => pos.push(...a, ...b, ...c);
  for (let i = 0; i < sides; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % sides];
    tri([a[0], a[1], z0], [b[0], b[1], z0], tip);
    tri([b[0], b[1], z0], [a[0], a[1], z0], back);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.computeVertexNormals();
  const uv = new Float32Array((pos.length / 3) * 2);
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  return g;
}

/** Flying projectiles: icicles at the nearest, compass shards every way. */
export class Bolts {
  readonly mesh: InstancedMesh;
  n = 0;
  readonly x = new Float32Array(BOLT_CAP);
  readonly y = new Float32Array(BOLT_CAP);
  readonly z = new Float32Array(BOLT_CAP);
  readonly vx = new Float32Array(BOLT_CAP);
  readonly vz = new Float32Array(BOLT_CAP);
  readonly life = new Float32Array(BOLT_CAP);
  readonly dmg = new Float32Array(BOLT_CAP);
  readonly radius = new Float32Array(BOLT_CAP);
  readonly pierce = new Int16Array(BOLT_CAP);
  /** Seconds before it can hit again (it passes through what it just hit). */
  readonly cool = new Float32Array(BOLT_CAP);
  readonly color = new Uint32Array(BOLT_CAP);
  /** The air it tears through: a wake of disturbed air and snow dust behind each one. */
  readonly trail: InstancedMesh;

  constructor(parent: Group) {
    const ice = fxMaterial({
      vertexShader: SOLID_VERT,
      fragmentShader: /* glsl */ `
        ${SOLID_FRAG_HEAD}
        void main() {
          vec3 n = normalize(vN);
          vec3 V = normalize(cameraPosition - vW);
          float c = max(dot(n, V), 0.0);
          float f = schlick(c, 0.02);
          vec3 refl = envRadiance(reflect(-V, n), vSunVis, 400.0);
          // Through the ice: the world behind, bent and stained blue by the depth of ice.
          vec3 thru = envRadiance(refract(-V, n, 0.76), vSunVis, 30.0) * vec3(0.45, 0.75, 0.95);
          // Fracture planes inside catching the sun.
          vec3 cell = floor(vObj * 18.0);
          float h = hash12(cell.xy + cell.z * 7.3);
          vec3 fn = normalize(vec3(hash12(cell.xz + 1.3), hash12(cell.yz + 2.1), hash12(cell.xy + 4.7)) - 0.5);
          float glint = step(0.7, h) * pow(max(dot(fn, normalize(V + uSunDir)), 0.0), 40.0) * vSunVis;
          vec3 col = mix(thru, refl, f) + uSunColor * glint * 3.0;
          // A cold light at its heart (the magic in it; what you see of it at night).
          col += vInst * (0.25 + 0.75 * c * c) * 1.4 * uEmit;
          col = applyHaze(col, vHazeF);
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = instanced(icicleGeometry(), ice, BOLT_CAP, 'Bolts', parent);
    const wake = fxMaterial({
      blend: 'premul',
      uniforms: { tMisc: { value: fxTex().misc } },
      vertexShader: /* glsl */ `
        ${FX_VERT}
        ${RIBBON_VERT}
        varying vec3 vInst;
        void main() {
          vec3 wp = ribbon(2.2);
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
          float n = texture2D(tMisc, vec2(0.5 + 0.5 * fract(x * 0.12 + t * 0.2 + vInst.g), fract(t * 0.9 - uFxTime * 2.0))).g;
          float body = exp(-x * x * 3.0) * smoothstep(0.0, 0.06, t) * (1.0 - t) * (1.0 - t);
          // Frost smoke: fine ice dust off the shard, lit like snow.
          float a = clamp(body * (0.1 + 0.55 * n), 0.0, 1.0) * 0.55;
          vec3 dust = uSnowAlbedo * (uOpenSky * uSkyTint * uSkyGain * 1.1 + uSunColor * 0.12);
          vec3 emit = vInst * exp(-x * x * 10.0) * (1.0 - t) * (1.0 - t) * 0.6;
          gl_FragColor = fxOut(hazePremul(emit * uEmit, dust, a, vHazeF), bgAir());
        }`,
    });
    this.trail = instanced(new PlaneGeometry(1, 1, 1, 4), wake, BOLT_CAP, 'BoltTrails', parent, 5);
  }

  fire(x: number, y: number, z: number, dirX: number, dirZ: number, speed: number, dmg: number, radius: number, pierce: number, life: number, color: number): void {
    if (this.n >= BOLT_CAP) return;
    const i = this.n++;
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = z;
    this.vx[i] = dirX * speed;
    this.vz[i] = dirZ * speed;
    this.life[i] = life;
    this.dmg[i] = dmg;
    this.radius[i] = radius;
    this.pierce[i] = pierce;
    this.cool[i] = 0;
    this.color[i] = color;
  }

  /** Remove bolt i (swap the last one into its place). */
  remove(i: number): void {
    const j = --this.n;
    if (i === j) return;
    this.x[i] = this.x[j];
    this.y[i] = this.y[j];
    this.z[i] = this.z[j];
    this.vx[i] = this.vx[j];
    this.vz[i] = this.vz[j];
    this.life[i] = this.life[j];
    this.dmg[i] = this.dmg[j];
    this.radius[i] = this.radius[j];
    this.pierce[i] = this.pierce[j];
    this.cool[i] = this.cool[j];
    this.color[i] = this.color[j];
  }

  draw(): void {
    for (let i = 0; i < this.n; i++) {
      tmpP.set(this.x[i], this.y[i], this.z[i]);
      const heading = Math.atan2(this.vx[i], this.vz[i]);
      tmpQ.setFromAxisAngle(UP, heading);
      const s = this.radius[i] / 0.35;
      // A little roll as it flies, so its facets catch the light.
      tmpQ.multiply(spinQ.setFromAxisAngle(Z_AXIS, this.life[i] * 14));
      tmpS.set(s, s, s);
      this.mesh.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS));
      this.mesh.setColorAt(i, tmpC.set(this.color[i]).multiplyScalar(0.5));
      // The wake, as long as a few frames of its flight, fading as it dies.
      tmpQ.setFromAxisAngle(UP, heading);
      const speed = Math.hypot(this.vx[i], this.vz[i]);
      tmpS.set(0.2 * s, 1, Math.min(2.2, speed * 0.07) * s);
      this.trail.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS));
      this.trail.setColorAt(i, tmpC.set(this.color[i]).multiplyScalar(Math.min(1, this.life[i] * 4)));
    }
    this.mesh.count = this.n;
    this.trail.count = this.n;
    flush(this.mesh, this.trail);
  }
}

// ------------------------------------------------------------ boulders ---

const HURL_CAP = 48;
const GRAVITY = 9.8;

/**
 * Ice boulders the titans (and later the brutes) lob at you: a frosted boulder on a high arc, cold light
 * in its cracks. Where it will come down, its shadow grows and sharpens on the snow, the snow in a ring
 * as wide as the blow shudders and darkens, and its cold light pools there as it falls, so you can see
 * it coming (day or night) and pole out of the way.
 */
export class Hurls {
  readonly rock: InstancedMesh;
  n = 0;
  readonly x = new Float32Array(HURL_CAP);
  readonly y = new Float32Array(HURL_CAP);
  readonly z = new Float32Array(HURL_CAP);
  readonly vx = new Float32Array(HURL_CAP);
  readonly vy = new Float32Array(HURL_CAP);
  readonly vz = new Float32Array(HURL_CAP);
  /** Where it lands, its flight time and time flown, and its damage. */
  readonly tx = new Float32Array(HURL_CAP);
  readonly tz = new Float32Array(HURL_CAP);
  readonly flight = new Float32Array(HURL_CAP);
  readonly age = new Float32Array(HURL_CAP);
  readonly dmg = new Float32Array(HURL_CAP);
  readonly size = new Float32Array(HURL_CAP);
  private readonly axis = new Vector3();

  constructor(parent: Group, private readonly ground?: FxGround) {
    this.rock = instanced(new IcosahedronGeometry(0.3, 1), rockMaterial(false), HURL_CAP, 'IceBoulders', parent);
    useModel(this.rock, 'rock', 0, 1);
  }

  /** Lob one from (x, y, z) to land on (tx, tz) after `flight` seconds. */
  throw(x: number, y: number, z: number, tx: number, tz: number, flight: number, dmg: number, size: number): boolean {
    if (this.n >= HURL_CAP) return false;
    const i = this.n++;
    const gy = duneHeight(tx, tz);
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = z;
    this.vx[i] = (tx - x) / flight;
    this.vz[i] = (tz - z) / flight;
    this.vy[i] = (gy - y + 0.5 * GRAVITY * flight * flight) / flight;
    this.tx[i] = tx;
    this.tz[i] = tz;
    this.flight[i] = flight;
    this.age[i] = 0;
    this.dmg[i] = dmg;
    this.size[i] = size;
    return true;
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
    this.flight[i] = this.flight[j];
    this.age[i] = this.age[j];
    this.dmg[i] = this.dmg[j];
    this.size[i] = this.size[j];
  }

  /** Fly them; returns nothing (the system checks `age >= flight` for landings). */
  move(dt: number): void {
    for (let i = 0; i < this.n; i++) {
      this.age[i] += dt;
      this.x[i] += this.vx[i] * dt;
      this.z[i] += this.vz[i] * dt;
      this.vy[i] -= GRAVITY * dt;
      this.y[i] += this.vy[i] * dt;
    }
  }

  draw(time: number): void {
    for (let i = 0; i < this.n; i++) {
      tmpP.set(this.x[i], this.y[i], this.z[i]);
      // Tumbling end over end about an axis across its flight.
      this.axis.set(this.vz[i], 0.3, -this.vx[i]).normalize();
      tmpQ.setFromAxisAngle(this.axis, time * 4 + i * 1.3);
      const s = this.size[i];
      tmpS.set(s, s, s);
      this.rock.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS));
      this.rock.setColorAt(i, tmpC.setRGB(1, 1, 1));
      if (this.ground) {
        const t = Math.min(1, this.age[i] / this.flight[i]);
        const gy = duneHeight(this.tx[i], this.tz[i]);
        const h = Math.max(0.2, this.y[i] - gy);
        // How far the blow reaches (the system's own rule), so the ring is the truth.
        const reach = 0.75 + 0.35 * s;
        // Its shadow: wide and faint while it is high, sharp and dark as it comes down.
        this.ground.decals.shadow(this.tx[i], this.tz[i], Math.max(reach * 0.7, s * 0.4 + h * 0.12), 0.25 + 0.55 * t * t, 0.15 + 0.6 * t);
        this.ground.decals.ring(this.tx[i], this.tz[i], reach, 0.3 + 0.5 * t, time * (6 + 18 * t) + i);
        this.ground.glow.add(this.tx[i], this.tz[i], reach * 1.3, 0.35, 0.65, 1.0, 0.04 + 0.3 * t * t + Math.min(0.35, 1.2 / (h * h + 1)), i * 2.1);
      }
    }
    this.rock.count = this.n;
    flush(this.rock);
  }
}

// ------------------------------------------------------------ blades ---

export const BLADE_CAP = 30;

/**
 * What a sword sweeping round you leaves: air torn behind the edge, a smear of the steel catching the
 * light (as a camera's shutter would see it), brightest where the tip cuts. A ring sector from the
 * sword's angle back `span` radians (toward -X, the trailing side), radii 0.55..1.02 of the tip.
 */
function sweepGeometry(span: number): BufferGeometry {
  const steps = 16;
  const R = [0.55, 0.86, 0.97, 1.02];
  const B = [0, 0.18, 1, 0];
  const pos: number[] = [];
  const col: number[] = [];
  const at = (k: number, r: number): number[] => {
    const a = (-k / steps) * span;
    return [Math.sin(a) * r, 0, Math.cos(a) * r];
  };
  for (let k = 0; k < steps; k++) {
    const f0 = Math.pow(1 - k / steps, 1.8);
    const f1 = Math.pow(1 - (k + 1) / steps, 1.8);
    for (let j = 0; j < R.length - 1; j++) {
      const a0 = at(k, R[j]);
      const b0 = at(k, R[j + 1]);
      const a1 = at(k + 1, R[j]);
      const b1 = at(k + 1, R[j + 1]);
      for (const [v, c, kk] of [
        [a0, B[j] * f0, k],
        [b0, B[j + 1] * f0, k],
        [b1, B[j + 1] * f1, k + 1],
        [a0, B[j] * f0, k],
        [b1, B[j + 1] * f1, k + 1],
        [a1, B[j] * f1, k + 1],
      ] as [number[], number, number][]) {
        pos.push(v[0], v[1], v[2]);
        col.push(c, kk / steps, Math.hypot(v[0], v[2]));
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  return g;
}

/** Swords that spin round you: forged steel, an iron guard, a leather grip, each tearing an arc through the air. */
export class Blades {
  readonly mesh: InstancedMesh;
  readonly sweep: InstancedMesh;

  constructor(parent: Group) {
    const placeholder = new BoxGeometry(0.07, 0.02, 1.0).translate(0, 0, 0.5);
    placeholder.setAttribute('color', new BufferAttribute(new Float32Array(placeholder.getAttribute('position').count * 4).fill(0.4), 4));
    const steel = propMaterial(fxTex().blade);
    steel.side = DoubleSide;
    this.mesh = instanced(placeholder, steel, BLADE_CAP, 'OrbitBlades', parent);
    fxModel('blade')
      .then((geos) => {
        if (!geos[0]) return;
        // Exported Y-up: the blade runs along +Y; the game's sword runs along +Z.
        const g = geos[0].clone().rotateX(Math.PI / 2);
        const old = this.mesh.geometry;
        this.mesh.geometry = g;
        old.dispose();
      })
      .catch(() => undefined);
    const smear = fxMaterial({
      blend: 'premul',
      side: DoubleSide,
      uniforms: { tMisc: { value: fxTex().misc } },
      vertexShader: /* glsl */ `
        ${FX_VERT}
        attribute vec3 color;
        varying vec3 vC;
        varying vec3 vInst;
        varying vec3 vW;
        void main() {
          vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vC = color;
          vInst = instanceColor;
          vW = wp.xyz;
          computeHaze(wp.xyz);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        ${FX_FRAG}
        uniform sampler2D tMisc;
        varying vec3 vC;
        varying vec3 vInst;
        varying vec3 vW;
        void main() {
          float b = vC.x;          // brightness profile (the tip's band)
          float along = vC.y;      // 0 at the blade, 1 at the end of the arc
          float n = texture2D(tMisc, vec2(0.5 + 0.5 * fract(along * 1.7 + vC.z * 0.6), fract(vC.z * 2.0 - uFxTime * 0.5))).r;
          // The steel smeared through the shutter: it reflects the sky as it passes.
          vec3 V = normalize(cameraPosition - vW);
          vec3 steel = envRadiance(reflect(-V, vec3(0.0, 1.0, 0.0)), 1.0, 30.0) * 0.6;
          float a = clamp(b * (0.35 + 0.5 * n) * 0.5, 0.0, 1.0);
          // The edge's colour (the weapon's tell), hottest at the blade.
          vec3 emit = vInst * b * b * (1.0 - along) * 1.6;
          gl_FragColor = fxOut(hazePremul(emit * uEmit, steel, a, vHazeF), bgAir());
        }`,
    });
    this.sweep = instanced(sweepGeometry(0.9), smear, BLADE_CAP, 'BladeSweeps', parent, 5);
  }

  /** No swords out. */
  hide(): void {
    this.mesh.count = 0;
    this.sweep.count = 0;
  }

  /**
   * Lay out `count` swords on a circle round (x, y, z), pointing outward, spun to `angle`, from instance
   * `start` on (so two rings can share the mesh). Returns the next free instance.
   */
  draw(count: number, x: number, y: number, z: number, radius: number, angle: number, size: number, start = 0, color = 0xffd36a, spin = 1): number {
    count = Math.min(count, BLADE_CAP - start);
    // Where the tips reach: the sword runs from 0.35 r out by its length.
    const tip = radius * 0.35 + size * radius * 0.75 * 1.06;
    tmpC.set(color).multiplyScalar(0.8);
    for (let k = 0; k < count; k++) {
      const a = angle + (k / count) * Math.PI * 2;
      const dx = Math.sin(a);
      const dz = Math.cos(a);
      tmpP.set(x + dx * radius * 0.35, y, z + dz * radius * 0.35);
      tmpQ.setFromAxisAngle(UP, a);
      // Edge-on to the sweep (the flat of the blade horizontal), a slight cant.
      tmpQ.multiply(spinQ.setFromAxisAngle(Z_AXIS, 0.25 * spin));
      tmpS.set(size, size, size * (radius * 0.75));
      this.mesh.setMatrixAt(start + k, tmpM.compose(tmpP, tmpQ, tmpS));
      this.mesh.setColorAt(start + k, tmpC);
      // The arc behind it (mirrored when the ring spins the other way).
      tmpQ.setFromAxisAngle(UP, a);
      tmpP.set(x, y, z);
      tmpS.set(tip * spin, 1, tip);
      this.sweep.setMatrixAt(start + k, tmpM.compose(tmpP, tmpQ, tmpS));
      this.sweep.setColorAt(start + k, tmpC);
    }
    this.mesh.count = start + count;
    this.sweep.count = start + count;
    flush(this.mesh, this.sweep);
    return start + count;
  }
}

// -------------------------------------------------------------- novas ---

const NOVA_CAP = 14;

/**
 * Frost blasts: a shock that drives a ring of snow dust out over the field, a wall of kicked-up powder
 * standing from it and settling as it spreads, a brief flash of the blast's colour on the snow where it
 * started. Two draws for all of them (the dust wall, the ground front).
 */
export class Novas {
  private readonly wall: InstPool;
  private readonly front: InstPool;
  private readonly t = new Float32Array(NOVA_CAP).fill(1);
  private readonly r = new Float32Array(NOVA_CAP);
  private readonly x = new Float32Array(NOVA_CAP);
  private readonly y = new Float32Array(NOVA_CAP);
  private readonly z = new Float32Array(NOVA_CAP);
  private readonly col = new Uint32Array(NOVA_CAP);
  private next = 0;

  constructor(parent: Group, private readonly ground?: FxGround) {
    const tex = { tMisc: { value: fxTex().misc } };
    const wallGeo = new CylinderGeometry(1, 1, 1, 64, 4, true).translate(0, 0.5, 0);
    const dust = /* glsl */ `
      vec3 dustLight(float sunVis) {
        return uSnowAlbedo * (uOpenSky * uSkyTint * uSkyGain * 1.05 + uSunColor * 0.3183 * 0.6 * sunVis);
      }`;
    this.wall = new InstPool(
      wallGeo,
      fxMaterial({
        blend: 'premul',
        side: DoubleSide,
        uniforms: tex,
        vertexShader: /* glsl */ `
          ${FX_VERT}
          ${SUNVIS_VERT}
          attribute vec4 aPos;  // centre, current radius
          attribute vec4 aData; // t, full radius, height, seed
          attribute vec4 aCol;
          varying vec2 vUv;
          varying vec4 vData;
          varying vec3 vCol;
          varying float vSunVis;
          void main() {
            // The wall leans out as the dust is thrown.
            vec3 wp = aPos.xyz + vec3(position.x * aPos.w * (1.0 + 0.12 * position.y), position.y * aData.z, position.z * aPos.w * (1.0 + 0.12 * position.y));
            vUv = vec2(atan(position.z, position.x) / 6.2831853 + 0.5, position.y);
            vData = aData;
            vCol = aCol.rgb;
            vSunVis = groundSunVisibility(wp.xz);
            computeHaze(wp);
            gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          ${FX_FRAG}
          uniform sampler2D tMisc;
          varying vec2 vUv;
          varying vec4 vData;
          varying vec3 vCol;
          varying float vSunVis;
          ${dust}
          void main() {
            float t = vData.x;
            float reps = max(3.0, floor(vData.y * 1.2));
            vec2 nuv = vec2(0.5 + 0.5 * fract(vUv.x * reps + vData.w), fract(vUv.y * 0.6 - t * 0.9 + vData.w));
            float n = texture2D(tMisc, nuv).r;
            float n2 = texture2D(tMisc, vec2(0.5 + 0.5 * fract(vUv.x * reps * 2.3), fract(vUv.y * 1.3 - t * 1.6))).g;
            float y = vUv.y;
            // Billowing powder: dense at the foot, ragged at the top.
            float body = pow(1.0 - y, 1.3) * smoothstep(0.0, 0.08, y + 0.05);
            float a = smoothstep(0.3, 0.8, n * 0.8 + n2 * 0.5 - y * 0.45) * body * (1.0 - t) * 1.1;
            vec3 emit = vCol * pow(1.0 - y, 6.0) * (1.0 - t) * 0.2;
            vec4 o = hazePremul(emit * uEmit, dustLight(vSunVis), clamp(a, 0.0, 1.0), vHazeF);
            if (o.a < 0.003) discard;
            gl_FragColor = fxOut(o, bgSnow());
          }`,
      }),
      NOVA_CAP,
      ['aPos', 'aData', 'aCol'],
      parent,
      'NovaDust',
      4,
    );
    const ring = new RingGeometry(0.62, 1.12, 72, 1).rotateX(-Math.PI / 2);
    this.front = new InstPool(
      ring,
      fxMaterial({
        blend: 'premul',
        uniforms: tex,
        vertexShader: /* glsl */ `
          ${FX_VERT}
          ${SUNVIS_VERT}
          attribute vec4 aPos;
          attribute vec4 aData;
          attribute vec4 aCol;
          varying vec2 vP;
          varying vec4 vData;
          varying vec3 vCol;
          varying float vSunVis;
          void main() {
            vec3 wp = aPos.xyz + position * aPos.w + vec3(0.0, 0.06, 0.0);
            vP = position.xz;
            vData = aData;
            vCol = aCol.rgb;
            vSunVis = groundSunVisibility(wp.xz);
            computeHaze(wp);
            gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          ${FX_FRAG}
          uniform sampler2D tMisc;
          varying vec2 vP;
          varying vec4 vData;
          varying vec3 vCol;
          varying float vSunVis;
          ${dust}
          void main() {
            float t = vData.x;
            float d = length(vP);
            float ang = atan(vP.y, vP.x) / 6.2831853 + 0.5;
            float reps = max(4.0, floor(vData.y * 1.5));
            float n = texture2D(tMisc, vec2(0.5 + 0.5 * fract(ang * reps + vData.w), fract(d * 0.8 - t))).r;
            // The front: a crest of snow being shoved along, a scuffed band trailing inside it.
            float crest = exp(-pow((d - 0.97) / 0.1, 2.0));
            float scuff = smoothstep(0.62, 0.95, d) * (1.0 - smoothstep(0.95, 1.1, d));
            float a = clamp((crest * 0.6 + scuff * 0.25) * smoothstep(0.2, 0.8, n + 0.1) * (1.0 - t), 0.0, 1.0);
            vec3 emit = vCol * crest * (1.0 - t) * (1.0 - t) * 0.25;
            vec4 o = hazePremul(emit * uEmit, dustLight(vSunVis) * 1.05, a, vHazeF);
            if (o.a < 0.003) discard;
            gl_FragColor = fxOut(o, bgSnow());
          }`,
      }),
      NOVA_CAP,
      ['aPos', 'aData', 'aCol'],
      parent,
      'NovaFront',
      4,
    );
  }

  burst(x: number, z: number, radius: number, color: number): void {
    let k = -1;
    for (let i = 0; i < NOVA_CAP; i++) {
      if (this.t[i] >= 1) {
        k = i;
        break;
      }
    }
    if (k < 0) {
      k = this.next;
      this.next = (this.next + 1) % NOVA_CAP;
    }
    this.t[k] = 0;
    this.r[k] = radius;
    this.x[k] = x;
    this.z[k] = z;
    this.y[k] = duneHeight(x, z);
    this.col[k] = color;
  }

  tick(dt: number): void {
    this.wall.begin();
    this.front.begin();
    for (let k = 0; k < NOVA_CAP; k++) {
      if (this.t[k] >= 1) continue;
      this.t[k] = Math.min(1, this.t[k] + dt / 0.6);
      const t = this.t[k];
      if (t >= 1) continue;
      const e = 1 - Math.pow(1 - t, 3);
      const r = Math.max(0.05, this.r[k] * e);
      const R = this.r[k];
      tmpC.set(this.col[k]);
      // The powder stands tallest early and close, settling as it spreads.
      const h = Math.min(1.6, 0.35 + 0.07 * R) * (0.55 + 0.9 * t) * (1 - 0.5 * t);
      const i = this.wall.add();
      this.wall.set('aPos', i, this.x[k], this.y[k] - 0.05, this.z[k], r);
      this.wall.set('aData', i, t, R, h, k * 0.31);
      this.wall.set('aCol', i, tmpC.r, tmpC.g, tmpC.b, 0);
      const j = this.front.add();
      this.front.set('aPos', j, this.x[k], this.y[k], this.z[k], r);
      this.front.set('aData', j, t, R, 0, k * 0.53);
      this.front.set('aCol', j, tmpC.r, tmpC.g, tmpC.b, 0);
      // The flash on the snow where it went off, in its colour.
      if (this.ground && t < 0.35) {
        const f = 1 - t / 0.35;
        this.ground.glow.add(this.x[k], this.z[k], Math.min(8, 1.5 + R * 0.4), tmpC.r, tmpC.g, tmpC.b, 0.4 * f * f, k);
      }
    }
    this.wall.end();
    this.front.end();
  }
}

// ------------------------------------------------------------ lightning ---

const ZAP_CAP = 96;
/** Main path pieces and branch pieces per bolt. */
const ZAP_MAIN = 9;
const ZAP_BRANCH = 4;
const ZAP_QUADS = ZAP_MAIN + 2 * ZAP_BRANCH;
const ZAP_VERTS = ZAP_QUADS * 6;
const ZAP_LIFE = 0.2;

/**
 * Chain lightning between enemies: a branching arc re-jagged every frame so it crackles, drawn as
 * ribbons turned to your eye with a white-hot core inside a blue corona (HDR, so it blooms through the
 * tone mapping), flashing the snow beneath it blue. One draw.
 */
export class Zaps {
  private readonly mesh: Mesh;
  private readonly pos = new Float32Array(ZAP_CAP * ZAP_VERTS * 3);
  private readonly rib = new Float32Array(ZAP_CAP * ZAP_VERTS * 4);
  private readonly age = new Float32Array(ZAP_CAP);
  private readonly seg = new Float32Array(ZAP_CAP * 6);
  private readonly pts = new Float32Array((ZAP_MAIN + 1) * 3);
  private readonly bpts = new Float32Array((ZAP_BRANCH + 1) * 3);
  private readonly corona = { value: new Color(0.35, 0.55, 1.0) };
  private readonly eye = new Vector3();
  private n = 0;
  private v = 0;
  private readonly posRange = { start: 0, count: 0 };
  private readonly ribRange = { start: 0, count: 0 };

  constructor(parent: Group, private readonly ground?: FxGround) {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage));
    geo.setAttribute('aRib', new BufferAttribute(this.rib, 4).setUsage(DynamicDrawUsage));
    this.mesh = new Mesh(
      geo,
      fxMaterial({
        blend: 'additive',
        side: DoubleSide,
        uniforms: { uCorona: this.corona },
        vertexShader: /* glsl */ `
          ${FX_VERT}
          attribute vec4 aRib; // across -1..1, fade, thickness, branch
          varying vec4 vRibA;
          void main() {
            vRibA = aRib;
            vec4 wp = modelMatrix * vec4(position, 1.0);
            computeHaze(wp.xyz);
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader: /* glsl */ `
          ${FX_FRAG}
          uniform vec3 uCorona;
          varying vec4 vRibA;
          void main() {
            float x = vRibA.x;
            float fade = vRibA.y;
            float core = exp(-x * x * 160.0 / vRibA.z);
            float corona = exp(-x * x * 6.0) * 0.8 + exp(-x * x * 30.0) * 0.6;
            vec3 col = vec3(1.0, 0.97, 1.0) * core * 30.0 + uCorona * corona * 2.2;
            col *= fade * (vRibA.w > 0.5 ? 0.5 : 1.0) * uEmit * (1.0 - vHazeF);
            gl_FragColor = fxOut(vec4(col, 0.0), bgAir());
          }`,
      }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.mesh.name = 'Lightning';
    parent.add(this.mesh);
  }

  /** The bolt's tint (Thunder's is whiter): the corona stays an electric blue, warmed a touch toward it. */
  setColor(hex: number): void {
    tmpC.set(hex);
    this.corona.value.setRGB(0.32, 0.52, 1.0).lerp(tmpC, 0.12);
  }

  zap(ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
    const i = this.n < ZAP_CAP ? this.n++ : Math.floor(Math.random() * ZAP_CAP);
    const o = i * 6;
    this.seg[o] = ax;
    this.seg[o + 1] = ay;
    this.seg[o + 2] = az;
    this.seg[o + 3] = bx;
    this.seg[o + 4] = by;
    this.seg[o + 5] = bz;
    this.age[i] = 0;
  }

  /** Jag a path from (ax..) to (bx..) into `pts` (count+1 points), jag biggest in the middle. */
  private jag(pts: Float32Array, count: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, amp: number): void {
    for (let k = 0; k <= count; k++) {
      const t = k / count;
      const j = k === 0 || k === count ? 0 : amp * Math.sin(t * Math.PI);
      pts[k * 3] = ax + (bx - ax) * t + (Math.random() - 0.5) * j;
      pts[k * 3 + 1] = ay + (by - ay) * t + (Math.random() - 0.5) * j;
      pts[k * 3 + 2] = az + (bz - az) * t + (Math.random() - 0.5) * j;
    }
  }

  private readonly side = new Float32Array((ZAP_MAIN + 1) * 3);

  /**
   * A continuous ribbon along `count` pieces of P, turned to the eye: the side at each point is taken
   * across the path's local direction, so the pieces join without gaps or overlaps (no beads at the kinks).
   */
  private strip(P: Float32Array, count: number, half: number, fade0: number, fade1: number, thick: number, branch: number): void {
    const S = this.side;
    for (let k = 0; k <= count; k++) {
      const k0 = Math.max(0, k - 1);
      const k1 = Math.min(count, k + 1);
      const dx = P[k1 * 3] - P[k0 * 3];
      const dy = P[k1 * 3 + 1] - P[k0 * 3 + 1];
      const dz = P[k1 * 3 + 2] - P[k0 * 3 + 2];
      const ex = this.eye.x - P[k * 3];
      const ey = this.eye.y - P[k * 3 + 1];
      const ez = this.eye.z - P[k * 3 + 2];
      let sx = dy * ez - dz * ey;
      let sy = dz * ex - dx * ez;
      let sz = dx * ey - dy * ex;
      // Thinner toward the ends (where it leaps into a body), and per point a little uneven.
      const w = (half * (0.6 + 0.4 * Math.sin((k / count) * Math.PI))) / (Math.hypot(sx, sy, sz) || 1);
      sx *= w;
      sy *= w;
      sz *= w;
      S[k * 3] = sx;
      S[k * 3 + 1] = sy;
      S[k * 3 + 2] = sz;
    }
    for (let k = 0; k < count; k++) {
      const a = k * 3;
      const b = a + 3;
      const fa = fade0 + (fade1 - fade0) * (k / count);
      const fb = fade0 + (fade1 - fade0) * ((k + 1) / count);
      // Two triangles: (a+, a-, b-), (a+, b-, b+).
      this.vert(P[a] + S[a], P[a + 1] + S[a + 1], P[a + 2] + S[a + 2], -1, fa, thick, branch);
      this.vert(P[a] - S[a], P[a + 1] - S[a + 1], P[a + 2] - S[a + 2], 1, fa, thick, branch);
      this.vert(P[b] - S[b], P[b + 1] - S[b + 1], P[b + 2] - S[b + 2], 1, fb, thick, branch);
      this.vert(P[a] + S[a], P[a + 1] + S[a + 1], P[a + 2] + S[a + 2], -1, fa, thick, branch);
      this.vert(P[b] - S[b], P[b + 1] - S[b + 1], P[b + 2] - S[b + 2], 1, fb, thick, branch);
      this.vert(P[b] + S[b], P[b + 1] + S[b + 1], P[b + 2] + S[b + 2], -1, fb, thick, branch);
    }
  }

  private vert(x: number, y: number, z: number, across: number, fade: number, thick: number, branch: number): void {
    const v = this.v++;
    this.pos[v * 3] = x;
    this.pos[v * 3 + 1] = y;
    this.pos[v * 3 + 2] = z;
    this.rib[v * 4] = across;
    this.rib[v * 4 + 1] = fade;
    this.rib[v * 4 + 2] = thick;
    this.rib[v * 4 + 3] = branch;
  }

  tick(dt: number, eye?: Vector3): void {
    if (eye) this.eye.copy(eye);
    let w = 0;
    this.v = 0;
    const P = this.pts;
    const Bp = this.bpts;
    let pools = 0;
    for (let i = 0; i < this.n; i++) {
      this.age[i] += dt;
      if (this.age[i] > ZAP_LIFE) continue;
      if (w !== i) {
        this.seg.copyWithin(w * 6, i * 6, i * 6 + 6);
        this.age[w] = this.age[i];
      }
      const o = w * 6;
      const s = this.seg;
      // Flickers as it dies (return strokes), rather than fading smoothly.
      const life = 1 - this.age[w] / ZAP_LIFE;
      const fade = life * (0.55 + 0.45 * Math.random());
      const len = Math.hypot(s[o + 3] - s[o], s[o + 4] - s[o + 1], s[o + 5] - s[o + 2]);
      this.jag(P, ZAP_MAIN, s[o], s[o + 1], s[o + 2], s[o + 3], s[o + 4], s[o + 5], Math.min(0.7, 0.14 + len * 0.07));
      this.strip(P, ZAP_MAIN, 0.11, fade, fade, 1, 0);
      // Two branches forking off toward the ground and away, short and thin.
      for (let b = 0; b < 2; b++) {
        const at = 2 + Math.floor(Math.random() * (ZAP_MAIN - 4));
        const bx = P[at * 3];
        const by = P[at * 3 + 1];
        const bz = P[at * 3 + 2];
        const bl = len * (0.2 + Math.random() * 0.2);
        this.jag(Bp, ZAP_BRANCH, bx, by, bz, bx + (Math.random() - 0.5) * bl, Math.max(by - bl * (0.3 + Math.random() * 0.5), duneHeight(bx, bz) + 0.05), bz + (Math.random() - 0.5) * bl, bl * 0.3);
        this.strip(Bp, ZAP_BRANCH, 0.07, fade, 0, 0.6, 1);
      }
      if (this.ground && pools < 10 && life > 0.4) {
        pools++;
        this.ground.glow.add(s[o + 3], s[o + 5], 2.4, this.corona.value.r, this.corona.value.g, this.corona.value.b, 0.35 * fade, i);
      }
      w++;
    }
    this.n = w;
    const geo = this.mesh.geometry;
    geo.setDrawRange(0, this.v);
    const pa = geo.getAttribute('position') as BufferAttribute;
    const ra = geo.getAttribute('aRib') as BufferAttribute;
    pa.updateRanges.length = 0;
    ra.updateRanges.length = 0;
    if (this.v > 0) {
      this.posRange.count = this.v * 3;
      this.ribRange.count = this.v * 4;
      pa.updateRanges.push(this.posRange);
      ra.updateRanges.push(this.ribRange);
      pa.needsUpdate = true;
      ra.needsUpdate = true;
    }
    this.mesh.visible = this.v > 0;
  }
}

// ------------------------------------------------------------ crystals ---

export const GEM_CAP = 1800;

/** A crystal of ice or gem: refracting, mirror-faceted, lit from within by its colour, sparkling as it turns. */
function crystalMaterial(colorUniform?: { value: Color }): ShaderMaterial {
  return fxMaterial({
    uniforms: colorUniform ? { uGemCol: colorUniform } : {},
    defines: colorUniform ? { UNIFORM_COL: 1 } : {},
    vertexShader: colorUniform
      ? SOLID_VERT.replace('modelMatrix * instanceMatrix', 'modelMatrix').replace('mat3(modelMatrix) * mat3(instanceMatrix)', 'mat3(modelMatrix)').replace('vInst = instanceColor;', 'vInst = vec3(1.0);')
      : SOLID_VERT,
    fragmentShader: /* glsl */ `
      ${SOLID_FRAG_HEAD}
      #ifdef UNIFORM_COL
      uniform vec3 uGemCol;
      #endif
      void main() {
        #ifdef UNIFORM_COL
        vec3 gc = uGemCol;
        #else
        vec3 gc = vInst;
        #endif
        vec3 n = normalize(vN);
        vec3 V = normalize(cameraPosition - vW);
        float c = max(dot(n, V), 0.0);
        float f = schlick(c, 0.07);
        vec3 R = reflect(-V, n);
        vec3 refl = envRadiance(R, vSunVis, 600.0);
        // Coloured glass: what shows through is stained deep by the body's colour.
        vec3 thru = envRadiance(refract(-V, n, 0.64), vSunVis, 40.0) * gc * gc * 0.22;
        // Light from within: brightest looking into the body, the facets' edges darker.
        vec3 inner = gc * gc * (0.1 + 0.9 * c * c) * 0.42;
        // Internal reflections: each facet shows a different depth of the stone, some bright, some dark.
        float fi = hash12(floor(n.xy * 4.0 + n.z * 2.7) + 0.37);
        inner *= mix(0.35, 1.8, fi * fi);
        // Each facet flashes as it turns through the sun's reflection; a few twinkle on their own.
        float fh = hash12(floor(n.xz * 5.0 + n.y * 3.0) + floor(vW.xz * 0.5));
        float flash = pow(max(dot(R, uSunDir), 0.0), 200.0) * vSunVis * 60.0;
        float tw = step(0.93, fract(fh * 13.0 + uFxTime * (0.7 + fh))) * 2.5;
        vec3 col = mix(thru, refl, f) + inner * uEmit + (uSunColor * flash + gc * tw * uEmit) * (0.3 + 0.7 * fh);
        col = applyHaze(col, vHazeF);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

/**
 * Experience crystals: blue, green, red by worth. They hop out of whatever died, bounce once on the snow
 * and sit there turning until you come within your magnet, then spiral in to you.
 */
export class Gems {
  readonly mesh: InstancedMesh;
  n = 0;
  readonly x = new Float32Array(GEM_CAP);
  readonly z = new Float32Array(GEM_CAP);
  readonly y = new Float32Array(GEM_CAP);
  readonly value = new Float32Array(GEM_CAP);
  /** Flying to you (once inside the magnet it never lets go). */
  readonly pulled = new Uint8Array(GEM_CAP);
  /** In the air (hopping out of a kill or flung from a fountain), and its flight. */
  readonly air = new Uint8Array(GEM_CAP);
  readonly vx = new Float32Array(GEM_CAP);
  readonly vy = new Float32Array(GEM_CAP);
  readonly vz = new Float32Array(GEM_CAP);

  constructor(parent: Group) {
    this.mesh = instanced(new OctahedronGeometry(0.11, 0).scale(0.8, 1.4, 0.8), crystalMaterial(), GEM_CAP, 'Crystals', parent);
    fxModel('gem')
      .then((geos) => {
        if (!geos[0]) return;
        // A slim hexagonal crystal (0.24 m) made a little stouter, so it reads at a distance.
        const g = geos[0].clone().scale(1.7, 1.3, 1.7);
        if (!g.getAttribute('uv')) g.setAttribute('uv', new BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
        const old = this.mesh.geometry;
        this.mesh.geometry = g;
        old.dispose();
      })
      .catch(() => undefined);
  }

  /** A crystal hops out of (x, z) and lands nearby. */
  drop(x: number, z: number, value: number): void {
    const a = Math.random() * Math.PI * 2;
    const out = 0.6 + Math.random() * 1.2;
    this.fling(x, 0.6 + duneHeight(x, z), z, value, Math.cos(a) * out, 2.6 + Math.random() * 1.8, Math.sin(a) * out);
  }

  /** A crystal thrown from (x, y, z) with velocity (vx, vy, vz). */
  fling(x: number, y: number, z: number, value: number, vx: number, vy: number, vz: number): void {
    if (this.n >= GEM_CAP) {
      // Full: fold it into the oldest crystal instead of losing it.
      this.value[0] += value;
      return;
    }
    const i = this.n++;
    this.x[i] = x;
    this.z[i] = z;
    this.y[i] = y;
    this.value[i] = value;
    this.pulled[i] = 0;
    this.air[i] = 1;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
  }

  /** Fly the airborne ones: arc, a bounce, then rest. */
  tick(dt: number): void {
    for (let i = 0; i < this.n; i++) {
      if (!this.air[i] || this.pulled[i]) continue;
      this.vy[i] -= 11 * dt;
      this.x[i] += this.vx[i] * dt;
      this.z[i] += this.vz[i] * dt;
      this.y[i] += this.vy[i] * dt;
      const floor = 0.35 + duneHeight(this.x[i], this.z[i]);
      if (this.y[i] < floor && this.vy[i] < 0) {
        this.y[i] = floor;
        if (this.vy[i] < -2.2) {
          this.vy[i] *= -0.32;
          this.vx[i] *= 0.5;
          this.vz[i] *= 0.5;
        } else {
          this.air[i] = 0;
        }
      }
    }
  }

  remove(i: number): void {
    const j = --this.n;
    if (i === j) return;
    this.x[i] = this.x[j];
    this.z[i] = this.z[j];
    this.y[i] = this.y[j];
    this.value[i] = this.value[j];
    this.pulled[i] = this.pulled[j];
    this.air[i] = this.air[j];
    this.vx[i] = this.vx[j];
    this.vy[i] = this.vy[j];
    this.vz[i] = this.vz[j];
  }

  draw(time: number): void {
    for (let i = 0; i < this.n; i++) {
      const v = this.value[i];
      const s = v >= 20 ? 2.1 : v >= 4 ? 1.5 : 1;
      const bob = this.air[i] || this.pulled[i] ? 0 : Math.sin(time * 3 + i) * 0.06;
      tmpP.set(this.x[i], this.y[i] + bob, this.z[i]);
      // Turning, and faster still in flight; tipped a little so its facets catch the light.
      tmpQ.setFromAxisAngle(UP, time * (this.air[i] || this.pulled[i] ? 14 : 2) + i);
      tmpQ.multiply(spinQ.setFromAxisAngle(X_AXIS, 0.18));
      tmpS.set(s, s, s);
      this.mesh.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS));
      // Sapphire, emerald, ruby: the gem's own colour (its light is set by the shader).
      this.mesh.setColorAt(i, v >= 20 ? tmpC.setRGB(1.0, 0.1, 0.18) : v >= 4 ? tmpC.setRGB(0.15, 1.0, 0.45) : tmpC.setRGB(0.2, 0.62, 1.0));
    }
    this.mesh.count = this.n;
    flush(this.mesh);
  }
}

// --------------------------------------------------------- upgrade orbs ---

/** A floating label: the upgrade's name on a dark frosted plate with a bar of its colour, always facing you. */
function labelSprite(text: string, color: string): Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 14, 0, 114);
  g.addColorStop(0, 'rgba(22,28,40,0.86)');
  g.addColorStop(1, 'rgba(8,11,18,0.86)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.roundRect(8, 18, 496, 92, 18);
  ctx.fill();
  ctx.strokeStyle = 'rgba(220,235,255,0.28)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(26, 38, 8, 52, 4);
  ctx.fill();
  ctx.fillStyle = '#f2f6ff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let size = 54;
  ctx.font = `700 ${size}px system-ui, sans-serif`;
  while (ctx.measureText(text).width > 420 && size > 24) {
    size -= 4;
    ctx.font = `700 ${size}px system-ui, sans-serif`;
  }
  ctx.shadowColor = color;
  ctx.shadowBlur = 10;
  ctx.fillText(text, 270, 66);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const sprite = new Sprite(new SpriteMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false }));
  sprite.scale.set(1.2, 0.3, 1);
  return sprite;
}

/** A soft glow round something bright (a card turned to you, additive, HDR). */
function haloMaterial(color: { value: Color }): ShaderMaterial {
  return fxMaterial({
    blend: 'additive',
    uniforms: { uHaloCol: color },
    vertexShader: /* glsl */ `
      ${FX_VERT}
      varying vec2 vUv;
      void main() {
        vec3 c = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        float s = length(modelMatrix[0].xyz);
        vec3 f = normalize(cameraPosition - c);
        vec3 r = normalize(cross(vec3(0.0, 1.0, 0.0), f) + vec3(1e-4, 0.0, 0.0));
        vec3 u = cross(f, r);
        vec3 wp = c + (r * position.x + u * position.y) * s;
        vUv = position.xy * 2.0;
        computeHaze(wp);
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      ${FX_FRAG}
      uniform vec3 uHaloCol;
      varying vec2 vUv;
      void main() {
        float r2 = dot(vUv, vUv);
        if (r2 > 1.0) discard;
        float g = exp(-r2 * 9.0) * 0.12 + exp(-r2 * 60.0) * 0.35;
        gl_FragColor = fxOut(vec4(uHaloCol * g * uEmit * (1.0 - vHazeF), 0.0), bgAir());
      }`,
  });
}

export interface Orb {
  root: Object3D;
  gem: Mesh;
  label: Sprite;
  x: number;
  z: number;
  upgradeId: string;
  active: boolean;
  age: number;
  color: { value: Color };
  halo: Mesh;
}

/** Upgrade crystals on the snow, each a cluster lit from within and named, waiting for you to walk into them. */
export class Orbs {
  readonly list: Orb[] = [];
  private readonly parent: Group;
  private geo: BufferGeometry = new IcosahedronGeometry(0.28, 0);
  private readonly haloGeo = new PlaneGeometry(1, 1);

  constructor(parent: Group, private readonly ground?: FxGround) {
    this.parent = parent;
    fxModel('orb')
      .then((geos) => {
        if (!geos[0]) return;
        const g = geos[0].clone().scale(1.1, 1.1, 1.1);
        if (!g.getAttribute('uv')) g.setAttribute('uv', new BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
        this.geo = g;
        for (const o of this.list) o.gem.geometry = g;
      })
      .catch(() => undefined);
  }

  drop(x: number, z: number, upgradeId: string, name: string, color: string): void {
    let orb = this.list.find((o) => !o.active);
    if (!orb) {
      const root = new Object3D();
      const col = { value: new Color(1, 1, 1) };
      const gem = new Mesh(this.geo, crystalMaterial(col));
      root.add(gem);
      const halo = new Mesh(this.haloGeo, haloMaterial(col));
      halo.scale.setScalar(1.6);
      halo.renderOrder = 6;
      root.add(halo);
      const label = labelSprite('', '#fff');
      root.add(label);
      this.parent.add(root);
      orb = { root, gem, label, x, z, upgradeId, active: true, age: 0, color: col, halo };
      this.list.push(orb);
    }
    // A fresh label for this upgrade.
    const old = orb.label;
    orb.root.remove(old);
    old.material.map?.dispose();
    old.material.dispose();
    orb.label = labelSprite(name, color);
    orb.label.position.y = 0.75;
    orb.root.add(orb.label);
    orb.color.value.set(color);
    orb.x = x;
    orb.z = z;
    orb.upgradeId = upgradeId;
    orb.active = true;
    orb.age = 0;
    orb.root.visible = true;
    orb.root.position.set(x, 0.8 + duneHeight(x, z), z);
  }

  tick(dt: number, time: number): void {
    for (const orb of this.list) {
      if (!orb.active) continue;
      orb.age += dt;
      orb.root.position.set(orb.x, 0.8 + duneHeight(orb.x, orb.z) + Math.sin(time * 2.4 + orb.x) * 0.12, orb.z);
      orb.gem.rotation.y = time * 0.9;
      orb.gem.rotation.x = Math.sin(time * 0.7) * 0.25;
      orb.gem.scale.setScalar(Math.min(1, orb.age * 3));
      orb.halo.scale.setScalar(1.4 + 0.15 * Math.sin(time * 5));
      const c = orb.color.value;
      this.ground?.glow.add(orb.x, orb.z, 2.2, c.r, c.g, c.b, 0.1, orb.x);
    }
  }

  take(orb: Orb): void {
    orb.active = false;
    orb.root.visible = false;
  }

  clear(): void {
    for (const orb of this.list) this.take(orb);
  }
}

// --------------------------------------------------------------- chests ---

const CHEST_CAP = 6;
/** Hinge of the lid (top of the body, back edge), chest space: matches fx_props.py (W 0.9, D 0.6, H 0.55). */
const HINGE = new Vector3(0, 0.55, -0.3);

export interface Chest {
  x: number;
  z: number;
  active: boolean;
  opening: number;
  /** Snow height where it stands. */
  ground: number;
  /** Upgrade picks inside: 1, or 2 for a boss's hoard. */
  picks: number;
  /** Shown (closed or opening). */
  shown: boolean;
  yaw: number;
  sink: number;
}

/**
 * Treasure chests: weathered plank chests with forged iron straps (fx_props.py chest), with a shaft of
 * light standing over each, soft as light in the air is, and warm light on the snow round it: walk into
 * one for a burst of upgrades. Three draws for all of them (bodies, lids, shafts).
 */
export class Chests {
  readonly list: Chest[] = [];
  private readonly body: InstancedMesh;
  private readonly lid: InstancedMesh;
  private readonly beam: InstancedMesh;
  private readonly root = new Vector3();
  private readonly hinge = HINGE.clone();

  constructor(parent: Group, private readonly ground?: FxGround) {
    const t = fxTex();
    const ph = new BoxGeometry(0.9, 0.55, 0.6).translate(0, 0.275, 0);
    ph.setAttribute('color', new BufferAttribute(new Float32Array(ph.getAttribute('position').count * 4).fill(0.3), 4));
    const mat = propMaterial(t.chest);
    this.body = instanced(ph, mat, CHEST_CAP, 'Chests', parent);
    const lph = new BoxGeometry(0.9, 0.3, 0.6).translate(0, 0.15, 0.3);
    lph.setAttribute('color', new BufferAttribute(new Float32Array(lph.getAttribute('position').count * 4).fill(0.3), 4));
    this.lid = instanced(lph, mat, CHEST_CAP, 'ChestLids', parent);
    fxModel('chest')
      .then((geos) => {
        const b = geos.find((g) => g.name.toLowerCase().includes('body')) ?? geos[0];
        const l = geos.find((g) => g.name.toLowerCase().includes('lid')) ?? geos[1];
        if (b) {
          this.body.geometry.dispose();
          this.body.geometry = b;
        }
        if (l) {
          const o = l.userData.origin as number[] | undefined;
          if (o) this.hinge.set(o[0], o[1], o[2]);
          this.lid.geometry.dispose();
          this.lid.geometry = l;
        }
      })
      .catch(() => undefined);
    const beamGeo = new PlaneGeometry(1, 1, 1, 8).translate(0, 0.5, 0);
    const beamMat = fxMaterial({
      blend: 'additive',
      uniforms: { tMisc: { value: t.misc } },
      vertexShader: /* glsl */ `
        ${FX_VERT}
        varying vec2 vB;
        varying vec3 vInst;
        varying float vNear;
        void main() {
          vec3 base = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          float w = length(instanceMatrix[0].xyz);
          float h = length(instanceMatrix[1].xyz);
          vec3 toCam = cameraPosition - base;
          vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), vec3(toCam.x, 0.0, toCam.z) + vec3(1e-4, 0.0, 0.0)));
          vec3 wp = base + right * position.x * w + vec3(0.0, position.y * h, 0.0);
          vB = vec2(position.x * 2.0, position.y * h);
          vInst = instanceColor;
          vNear = smoothstep(0.6, 2.5, length(toCam.xz));
          computeHaze(wp);
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        ${FX_FRAG}
        uniform sampler2D tMisc;
        varying vec2 vB;
        varying vec3 vInst;
        varying float vNear;
        void main() {
          float x = vB.x;
          float y = vB.y;
          // Light scattered out of a shaft: a soft gaussian across (no edges), fading with height.
          float across = exp(-x * x * 5.0);
          float core = exp(-x * x * 40.0);
          float up = exp(-y * 0.07) * smoothstep(0.0, 0.6, y);
          // Ice crystals drifting up through it, glittering.
          float motes = texture2D(tMisc, vec2(0.5 + 0.5 * fract(x * 0.4 + 0.3), fract(y * 0.18 - uFxTime * 0.25))).b;
          float glit = smoothstep(0.72, 0.9, motes) * exp(-x * x * 3.0) * (0.5 + 0.5 * sin(uFxTime * 9.0 + y * 3.0));
          float pulse = 0.85 + 0.15 * sin(uFxTime * 3.0);
          vec3 col = vInst * (across * 0.07 + core * 0.16 + glit * 0.9) * up * pulse * vNear;
          gl_FragColor = fxOut(vec4(col * uEmit * (1.0 - vHazeF), 0.0), bgAir());
        }`,
    });
    this.beam = instanced(beamGeo, beamMat, CHEST_CAP, 'ChestBeams', parent, 6);
    for (let k = 0; k < CHEST_CAP; k++) {
      this.list.push({ x: 0, z: 0, active: false, opening: -1, ground: 0, picks: 1, shown: false, yaw: 0, sink: 0 });
    }
  }

  /** A chest at (x, z) with `picks` upgrades in it (a boss's hoard is bigger, under a red-gold shaft). */
  place(x: number, z: number, picks = 1): boolean {
    if (picks === 1 && this.list.filter((c) => c.active && c.picks === 1).length >= 3) return false;
    const chest = this.list.find((c) => !c.active && c.opening < 0);
    if (!chest) return false;
    chest.picks = picks;
    chest.x = x;
    chest.z = z;
    chest.active = true;
    chest.opening = -1;
    chest.ground = duneHeight(x, z);
    chest.yaw = Math.random() * Math.PI * 2;
    chest.sink = 0;
    chest.shown = true;
    return true;
  }

  tick(dt: number, _time: number): void {
    let n = 0;
    let nb = 0;
    for (const chest of this.list) {
      if (!chest.shown) continue;
      let lidA = 0;
      let beam = true;
      if (chest.opening >= 0) {
        // The lid flies open, then the chest sinks away.
        chest.opening += dt;
        lidA = Math.min(1.9, chest.opening * 7);
        beam = false;
        if (chest.opening > 1.6) {
          chest.sink = (chest.opening - 1.6) * 1.5;
          if (chest.opening > 2.4) {
            chest.shown = false;
            chest.opening = -1;
            continue;
          }
        }
      }
      const s = chest.picks > 1 ? 1.45 : 1;
      // Settled into the snow a few centimetres.
      this.root.set(chest.x, chest.ground - 0.04 - chest.sink, chest.z);
      tmpQ.setFromAxisAngle(UP, chest.yaw);
      tmpS.set(s, s, s);
      tmpM.compose(this.root, tmpQ, tmpS);
      this.body.setMatrixAt(n, tmpM);
      tmpM2.makeTranslation(this.hinge.x, this.hinge.y, this.hinge.z);
      tmpM.multiply(tmpM2);
      tmpM2.makeRotationX(-lidA);
      tmpM.multiply(tmpM2);
      this.lid.setMatrixAt(n, tmpM);
      n++;
      if (beam) {
        tmpP.set(chest.x, chest.ground, chest.z);
        tmpS.set(1.1 * s, 40, 1);
        this.beam.setMatrixAt(nb, tmpM.compose(tmpP, tmpQ.identity(), tmpS));
        if (chest.picks > 1) this.beam.setColorAt(nb, tmpC.setRGB(1.0, 0.42, 0.2));
        else this.beam.setColorAt(nb, tmpC.setRGB(1.0, 0.78, 0.38));
        nb++;
        this.ground?.glow.add(chest.x, chest.z, 2.6 * s, tmpC.r, tmpC.g, tmpC.b, 0.1, chest.x);
      }
    }
    this.body.count = n;
    this.lid.count = n;
    this.beam.count = nb;
    flush(this.body, this.lid, this.beam);
  }

  open(chest: Chest): void {
    chest.active = false;
    chest.opening = 0;
  }

  clear(): void {
    for (const chest of this.list) {
      chest.active = false;
      chest.opening = -1;
      chest.shown = false;
    }
    this.body.count = 0;
    this.lid.count = 0;
    this.beam.count = 0;
  }
}
