/**
 * Shared ground for the Snow Survivors FX (survivors-fx.ts, fire-fx.ts): the Blender-made textures and
 * models in public/survivors/fx/ (art/scripts/fx_sims.py, fx_powder.py, fx_props.py, packed by
 * fx_pack.py), the shader helpers every effect uses on top of the baked-light contract, and the two
 * ground systems the effects paint with: light pools (fire lighting the snow) and decals (scorched,
 * melted snow; a falling boulder's shadow).
 *
 * Emission is physical radiance, tone-mapped by AgX with the scene. The eye adapts through the evening
 * (exposure rises toward night); a self-luminous thing is not dimmed by that adaptation as much as the
 * snow is lifted by it, so emission carries `uEmit` = exposure^-0.6: a fire that is 6x the snow at
 * golden hour blazes ~4x brighter on screen by night instead of clipping to a white blob.
 */

import {
  BufferGeometry,
  Color,
  CustomBlending,
  DstColorFactor,
  DynamicDrawUsage,
  type Group,
  InstancedBufferAttribute,
  InstancedMesh,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PlaneGeometry,
  ShaderMaterial,
  SRGBColorSpace,
  type Texture,
  TextureLoader,
  Vector3,
  ZeroFactor,
} from '@iwsdk/core';
import { BAKED_GLSL, HAZE_VERT, bakedLight } from '../baked/light.js';
import { assetUrl, loadGLTF } from '../baked/loaders.js';
import { duneHeight } from './survivors-level.js';

// ------------------------------------------------------------ assets ---

const loader = new TextureLoader();

function tex(name: string, color: boolean, mips = true, gltfUv = false): Texture {
  const t = loader.load(assetUrl(`survivors/fx/${name}.webp`));
  // Maps for glTF meshes use glTF's uv origin (top-left).
  t.flipY = !gltfUv;
  t.colorSpace = color ? SRGBColorSpace : NoColorSpace;
  t.minFilter = mips ? LinearMipmapLinearFilter : LinearFilter;
  t.generateMipmaps = mips;
  t.anisotropy = 2;
  return t;
}

let textures: Record<string, Texture> | null = null;

/** The FX textures (created on first use; they fill in as they load). */
export function fxTex(): Record<'fire' | 'fireball' | 'powder' | 'misc' | 'chest' | 'rock' | 'rockN' | 'blade', Texture> {
  if (!textures) {
    textures = {
      // Flipbooks: no mips across frame borders would bleed; their frames are padded and soft, mips are fine.
      fire: tex('fire', false),
      fireball: tex('fireball', false),
      powder: tex('powder', false),
      misc: tex('misc', false),
      chest: tex('chest', true, true, true),
      rock: tex('rock', true, true, true),
      rockN: tex('rock_n', false, true, true),
      blade: tex('blade', true, true, true),
    };
  }
  return textures as ReturnType<typeof fxTex>;
}

const models = new Map<string, Promise<BufferGeometry[]>>();

/** The meshes of public/survivors/fx/<name>.glb, in file order, each in its node's frame (userData.origin = node position). */
export function fxModel(name: string): Promise<BufferGeometry[]> {
  let p = models.get(name);
  if (!p) {
    p = loadGLTF(`survivors/fx/${name}.glb`).then((g) => {
      const out: BufferGeometry[] = [];
      g.scene.updateMatrixWorld(true);
      g.scene.traverse((o) => {
        const m = o as unknown as { isMesh?: boolean; geometry: BufferGeometry; matrixWorld: import('@iwsdk/core').Matrix4; name: string };
        if (m.isMesh) {
          // Geometry in the node's own frame; the node's position kept (a lid's hinge).
          const geo = m.geometry.clone();
          geo.name = m.name;
          const e = m.matrixWorld.elements;
          geo.userData.origin = [e[12], e[13], e[14]];
          out.push(geo);
        }
      });
      return out;
    });
    p.catch((e) => console.warn('[fx] model', name, e));
    models.set(name, p);
  }
  return p;
}

// ---------------------------------------------------------- uniforms ---

/** Shared FX uniforms (put into materials by reference, alongside bakedLight). */
export const fxUniforms = {
  /** Emission gain: exposure^-0.6 (see the file comment). */
  uEmit: { value: 1 },
  /** Seconds, for flicker and flipbooks (frozen while time is stopped). */
  uFxTime: { value: 0 },
};

/** Once a frame, before drawing: the tone-mapping exposure in use and the effects' clock. */
/**
 * The glow budget. Every glow, trail, sweep and flash adds light, and late in a run hundreds of them stack
 * into a white haze that hides the horde and the shape of every attack. The survivors system works out
 * how much is on screen each frame and eases `gain` down as it fills (never below MIN_GAIN): the glows
 * soften, while the crisp cores of the attacks (the ice, the steel, lightning's white-hot spine, the
 * spikes) stay at full strength, so each weapon keeps its shape.
 */
export const fx = { gain: 1 };
export const MIN_GAIN = 0.38;

export function fxFrame(exposure: number, time: number): void {
  fxUniforms.uEmit.value = Math.pow(Math.max(exposure, 1e-3), -0.6);
  fxUniforms.uFxTime.value = time;
}

/** Fire flipbook constants (art/work/fx/pack.json): emitted luminance max, blackbody chroma ramp. */
export const FIRE_LMAX = 5.214;
export const FIREBALL_LMAX = 3.486;

/**
 * GLSL on top of BAKED_GLSL: fire colour, flipbook sampling, the sky as a mirror sees it, haze for
 * premultiplied output.
 */
export const FX_GLSL = /* glsl */ `
uniform float uEmit;
uniform float uFxTime;
// Blackbody chroma (rgb / luminance) against heat 0..1, measured off the Cycles fire (fx_pack.py).
vec3 fireTint(float h) {
  h = clamp(h, 0.0, 1.0) * 4.0;
  vec3 a = vec3(3.825, 0.2611, 0.0011);
  vec3 b = vec3(3.3748, 0.3949, 0.0008);
  vec3 c = vec3(2.9795, 0.5122, 0.0037);
  vec3 d = vec3(2.6632, 0.6042, 0.0231);
  vec3 e = vec3(2.4328, 0.67, 0.0498);
  return h < 1.0 ? mix(a, b, h) : h < 2.0 ? mix(b, c, h - 1.0) : h < 3.0 ? mix(c, d, h - 2.0) : mix(d, e, h - 3.0);
}
// Frame f (fractional: blends to the next) of a cols x rows flipbook, frames row-major from the top-left.
vec2 flipCell(vec2 uv, float f, vec2 grid) {
  float col = mod(f, grid.x);
  float row = floor(f / grid.x);
  return vec2((col + uv.x) / grid.x, 1.0 - (row + 1.0 - uv.y) / grid.y);
}
vec4 flipbook(sampler2D t, vec2 uv, float f, vec2 grid, float count, bool loop) {
  float f0 = floor(f);
  float k = f - f0;
  float f1 = f0 + 1.0;
  if (loop) { f0 = mod(f0, count); f1 = mod(f1, count); }
  else { f0 = min(f0, count - 1.0); f1 = min(f1, count - 1.0); }
  return mix(texture2D(t, flipCell(uv, f0, grid)), texture2D(t, flipCell(uv, f1, grid)), k);
}
// Radiance of what a mirror facing r sees: the snow below, the sky (horizon haze to zenith), the sun.
vec3 envRadiance(vec3 r, float sunVis, float gloss) {
  vec3 sky = uOpenSky * uSkyTint * uSkyGain;
  vec3 snow = uSnowAlbedo * (uOpenSun * uSunColor + sky);
  vec3 env = r.y < 0.0 ? mix(uHazeColor * 0.7, snow, smoothstep(0.0, -0.25, r.y))
                       : mix(uHazeColor, sky * 0.9, smoothstep(0.02, 0.5, r.y));
  float s = max(dot(r, uSunDir), 0.0);
  env += uSunColor * sunVis * pow(s, gloss) * (gloss + 2.0) * 0.08;
  return env;
}
float schlick(float c, float f0) { float m = 1.0 - c; return f0 + (1.0 - f0) * m * m * m * m * m; }
// Effects composite in display space (the framebuffer holds tone-mapped colour), so light added there would
// be overstated (AgX lifts its toe). Each effect knows roughly what lies behind it (open snow, or the air
// over it), tone-maps background + itself, and outputs the difference over that background: what it would
// have added had it been composited in linear light. Premultiplied: blend ONE, ONE_MINUS_SRC_ALPHA (or ONE, ONE).
vec3 bgSnow() { return uSnowAlbedo * (uOpenSun * uSunColor * 0.4 + uOpenSky * uSkyTint * uSkyGain); }
vec3 bgAir() { return mix(bgSnow(), uHazeColor, 0.5); }
vec3 tmOut(vec3 c) {
#ifdef TONE_MAPPING
  c = toneMapping(c);
#endif
  return linearToOutputTexel(vec4(c, 1.0)).rgb;
}
vec4 fxOut(vec4 o, vec3 bg) {
  vec3 full = tmOut(bg * (1.0 - o.a) + o.rgb);
  return vec4(max(full - tmOut(bg) * (1.0 - o.a), 0.0), o.a);
}
// Haze for premultiplied output: what the air adds over the covered part, the emission fading with distance.
vec4 hazePremul(vec3 emit, vec3 surf, float a, float f) {
  return vec4(emit * (1.0 - f) + (surf * (1.0 - f) + uHazeColor * f) * a, a);
}
`;

/** A ShaderMaterial that shares the baked light and FX uniforms by reference. */
export function fxMaterial(params: {
  vertexShader: string;
  fragmentShader: string;
  uniforms?: Record<string, { value: unknown }>;
  blend?: 'opaque' | 'premul' | 'additive' | 'multiply' | 'alpha';
  side?: number;
  depthWrite?: boolean;
  toneMapped?: boolean;
  defines?: Record<string, string | number>;
}): ShaderMaterial {
  const m = new ShaderMaterial({
    vertexShader: params.vertexShader,
    fragmentShader: params.fragmentShader,
    uniforms: { ...bakedLight, ...fxUniforms, ...(params.uniforms ?? {}) } as unknown as Record<string, { value: unknown }>,
    defines: params.defines ?? {},
    fog: false,
  });
  const blend = params.blend ?? 'opaque';
  if (blend !== 'opaque') {
    m.transparent = true;
    m.depthWrite = params.depthWrite ?? false;
    m.blending = CustomBlending;
    if (blend === 'premul' || blend === 'alpha') {
      m.blendSrc = OneFactor;
      m.blendDst = OneMinusSrcAlphaFactor;
      m.blendSrcAlpha = OneFactor;
      m.blendDstAlpha = OneMinusSrcAlphaFactor;
    } else if (blend === 'additive') {
      m.blendSrc = OneFactor;
      m.blendDst = OneFactor;
      m.blendSrcAlpha = ZeroFactor;
      m.blendDstAlpha = OneFactor;
    } else {
      m.blendSrc = DstColorFactor;
      m.blendDst = ZeroFactor;
      m.blendSrcAlpha = ZeroFactor;
      m.blendDstAlpha = OneFactor;
    }
  }
  if (params.side !== undefined) m.side = params.side as ShaderMaterial['side'];
  if (params.toneMapped === false) m.toneMapped = false;
  return m;
}

/** Vertex-side prelude: haze, and the baked-light GLSL (for groundSunVisibility in the vertex stage). */
export const FX_VERT = /* glsl */ `
${HAZE_VERT}
uniform float uFxTime;
uniform float uEmit;
`;
export const FX_FRAG = /* glsl */ `
${BAKED_GLSL}
${FX_GLSL}
varying float vHazeF;
`;
/** BAKED_GLSL declares the uniforms; in the vertex stage we only need the sun-visibility lookup. */
export const SUNVIS_VERT = /* glsl */ `
uniform sampler2D uGroundLight;
uniform vec4 uGroundLM;
uniform float uOpenSun;
float groundSunVisibility(vec2 xz) {
  vec2 rel = xz - uGroundLM.xy;
  if (abs(rel.x) > uGroundLM.z || abs(rel.y) > uGroundLM.z) return 1.0;
  vec2 uv = vec2((rel.x + uGroundLM.z) / (2.0 * uGroundLM.z), (uGroundLM.z - rel.y) / (2.0 * uGroundLM.z));
  float t = texture2D(uGroundLight, uv).r;
  return clamp(t * t * uGroundLM.w / max(uOpenSun, 1e-4), 0.0, 1.0);
}
`;

// --------------------------------------------------- instanced pool ---

/**
 * An instanced mesh whose instances are driven by plain vec4 attributes (no matrices): rebuilt each
 * frame with begin / set / end, drawn in one call.
 */
export class InstPool {
  readonly mesh: InstancedMesh;
  readonly data: Record<string, Float32Array> = {};
  private readonly attrs: InstancedBufferAttribute[] = [];
  private readonly ranges: { start: number; count: number }[] = [];
  n = 0;

  constructor(
    geometry: BufferGeometry,
    material: ShaderMaterial,
    readonly cap: number,
    names: string[],
    parent: Group,
    name: string,
    renderOrder = 0,
  ) {
    for (const k of names) {
      const arr = new Float32Array(cap * 4);
      this.data[k] = arr;
      const a = new InstancedBufferAttribute(arr, 4).setUsage(DynamicDrawUsage);
      geometry.setAttribute(k, a);
      this.attrs.push(a);
      this.ranges.push({ start: 0, count: 0 });
    }
    this.mesh = new InstancedMesh(geometry, material, cap);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.name = name;
    this.mesh.renderOrder = renderOrder;
    parent.add(this.mesh);
  }

  begin(): void {
    this.n = 0;
  }

  /** Next instance index, or -1 when full. */
  add(): number {
    return this.n < this.cap ? this.n++ : -1;
  }

  set(attr: string, i: number, a: number, b: number, c: number, d: number): void {
    const o = i * 4;
    const arr = this.data[attr];
    arr[o] = a;
    arr[o + 1] = b;
    arr[o + 2] = c;
    arr[o + 3] = d;
  }

  end(): void {
    this.mesh.count = this.n;
    for (let k = 0; k < this.attrs.length; k++) {
      const a = this.attrs[k];
      // Upload only the live instances; the range objects are reused (no garbage per frame).
      a.updateRanges.length = 0;
      if (this.n > 0) {
        this.ranges[k].count = this.n * 4;
        a.updateRanges.push(this.ranges[k]);
        a.needsUpdate = true;
      }
    }
  }
}

/** A quad in XY from (-0.5, -0.5) to (0.5, 0.5) with uv, as an instancing base. */
export function unitQuad(): BufferGeometry {
  return new PlaneGeometry(1, 1);
}

// ------------------------------------------------------- light pools ---

const GLOW_CAP = 72;

/**
 * Warm light pooled on the snow round fires and glowing things (there are no dynamic lights): soft
 * additive quads laid on the ground, physically scaled (subtle by day, strong by night). Rebuilt every
 * frame from whatever is burning. One draw.
 */
export class GroundGlow {
  private readonly pool: InstPool;
  private readonly n0 = new Vector3();

  constructor(parent: Group) {
    const mat = fxMaterial({
      blend: 'additive',
      vertexShader: /* glsl */ `
        ${FX_VERT}
        attribute vec4 aPos;   // x, y, z, radius
        attribute vec4 aCol;   // linear colour * intensity (irradiance-ish), w: ground slope x
        attribute vec4 aTilt;  // ground normal xz, flicker phase, ring (0 pool, >0 ring width)
        varying vec2 vUv;
        varying vec4 vCol;
        varying float vRing;
        void main() {
          vUv = position.xy * 2.0;
          vec3 n = normalize(vec3(aTilt.x, 1.0, aTilt.y));
          vec3 t = normalize(cross(vec3(0.0, 0.0, 1.0), n));
          vec3 b = cross(n, t);
          vec3 wp = aPos.xyz + (t * position.x * 2.0 + b * position.y * 2.0) * aPos.w + n * 0.03;
          float fl = 0.86 + 0.1 * sin(uFxTime * 11.0 + aTilt.z) + 0.06 * sin(uFxTime * 23.0 + aTilt.z * 1.7);
          vCol = vec4(aCol.rgb * fl, 1.0);
          vRing = aTilt.w;
          computeHaze(wp);
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        ${FX_FRAG}
        varying vec2 vUv;
        varying vec4 vCol;
        varying float vRing;
        void main() {
          float r = length(vUv);
          if (r > 1.0) discard;
          // Irradiance from a source just above the snow: inverse-square-ish falloff, soft to the edge.
          float e = 1.0 / (1.0 + 18.0 * r * r) - 0.0526;
          e = max(e, 0.0) * 1.06;
          if (vRing > 0.0) e = exp(-pow((r - 0.86) / vRing, 2.0)) * (1.0 - smoothstep(0.9, 1.0, r));
          vec3 col = uSnowAlbedo * vCol.rgb * e * uEmit * (1.0 - vHazeF);
          gl_FragColor = fxOut(vec4(col, 0.0), bgSnow());
        }`,
    });
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -2;
    mat.polygonOffsetUnits = -4;
    this.pool = new InstPool(unitQuad(), mat, GLOW_CAP, ['aPos', 'aCol', 'aTilt'], parent, 'FireLightPools', 2);
  }

  begin(): void {
    this.pool.begin();
  }

  /**
   * Light on the snow round (x, z): `radius` m, colour (r, g, b) linear at `intensity` (radiance on
   * white snow at the centre, scene units). `ring` > 0 makes it a thin ring of that relative width.
   */
  add(x: number, z: number, radius: number, r: number, g: number, b: number, intensity: number, phase = 0, ring = 0): void {
    const i = this.pool.add();
    if (i < 0) return;
    const y = duneHeight(x, z);
    const d = Math.max(0.5, radius * 0.5);
    const sx = (duneHeight(x - d, z) - duneHeight(x + d, z)) / (2 * d);
    const sz = (duneHeight(x, z - d) - duneHeight(x, z + d)) / (2 * d);
    this.n0.set(sx, 1, sz);
    this.pool.set('aPos', i, x, y, z, radius);
    this.pool.set('aCol', i, r * intensity, g * intensity, b * intensity, 0);
    this.pool.set('aTilt', i, sx, sz, phase, ring);
  }

  end(): void {
    this.pool.end();
  }
}

// ------------------------------------------------------------ decals ---

const DECAL_CAP = 96;

/**
 * Ground decals, multiplied into the snow: scorched and melted snow where fire burned (a Blender
 * render of burned snow over clean snow, fx_props.py scorch), and the soft shadow of a boulder about
 * to land. One draw. Scorches are kept (ring buffer) and fade out; shadows are re-added every frame.
 */
export class GroundDecals {
  private readonly pool: InstPool;
  private readonly sx = new Float32Array(DECAL_CAP);
  private readonly sz = new Float32Array(DECAL_CAP);
  private readonly sr = new Float32Array(DECAL_CAP);
  private readonly sAge = new Float32Array(DECAL_CAP);
  private readonly sLife = new Float32Array(DECAL_CAP);
  private readonly sRot = new Float32Array(DECAL_CAP);
  private next = 0;
  private readonly shadows: number[] = [];
  private readonly rings: number[] = [];

  constructor(parent: Group) {
    const mat = fxMaterial({
      blend: 'multiply',
      toneMapped: false,
      uniforms: { tMisc: { value: fxTex().misc } },
      vertexShader: /* glsl */ `
        ${FX_VERT}
        attribute vec4 aPos;   // x, y, z, radius
        attribute vec4 aTilt;  // slope x, slope z, rotation, kind (0 scorch, 1 shadow, 2 ring)
        attribute vec4 aParam; // strength, softness, -, -
        varying vec2 vUv;
        varying vec4 vParam;
        varying float vKind;
        void main() {
          vec3 n = normalize(vec3(aTilt.x, 1.0, aTilt.y));
          vec3 t = normalize(cross(vec3(0.0, 0.0, 1.0), n));
          vec3 b = cross(n, t);
          float c = cos(aTilt.z), s = sin(aTilt.z);
          vec2 p = mat2(c, s, -s, c) * position.xy;
          vUv = position.xy + 0.5;
          vec3 wp = aPos.xyz + (t * p.x + b * p.y) * 2.0 * aPos.w + n * 0.02;
          vParam = aParam;
          vKind = aTilt.w;
          computeHaze(wp);
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tMisc;
        varying float vHazeF;
        varying vec2 vUv;
        varying vec4 vParam;
        varying float vKind;
        void main() {
          vec3 m;
          if (vKind < 0.5) {
            // Scorch: the display-space ratio of burned over clean snow (left half of misc.webp).
            m = texture2D(tMisc, vec2(vUv.x * 0.5, vUv.y)).rgb * 1.05;
            m = mix(vec3(1.0), m, vParam.x * 0.8);
          } else if (vKind < 1.5) {
            // A soft shadow, umbra growing as the thing above comes down.
            float r = length(vUv - 0.5) * 2.0;
            float sh = 1.0 - smoothstep(vParam.y, 1.0, r);
            m = vec3(1.0 - vParam.x * sh);
            m *= vec3(0.98, 0.99, 1.0);
          } else {
            // Snow shuddering in a ring: a broken band of disturbed, shadowed snow, quivering.
            vec2 q = vUv - 0.5;
            float r = length(q) * 2.0;
            float ang = atan(q.y, q.x);
            float ph = vParam.y;
            float wob = 0.012 * sin(ang * 31.0 + ph * 1.7) + 0.01 * sin(ang * 13.0 - ph);
            float band = exp(-pow((r - 0.9 - wob) / 0.045, 2.0));
            float broken = 0.55 + 0.45 * sin(ang * 23.0 + ph * 0.6) * sin(ang * 9.0 - ph * 0.4);
            float inner = exp(-pow((r - 0.8 - wob * 2.0) / 0.02, 2.0)) * 0.5;
            m = vec3(1.0 - vParam.x * (band * broken + inner * (1.0 - broken)));
          }
          m = mix(m, vec3(1.0), vHazeF);
          gl_FragColor = vec4(m, 1.0);
        }`,
    });
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -1;
    mat.polygonOffsetUnits = -2;
    this.pool = new InstPool(unitQuad(), mat, DECAL_CAP, ['aPos', 'aTilt', 'aParam'], parent, 'GroundDecals', 1);
  }

  /** Scorched, melted snow at (x, z), `radius` m, lasting `life` s (it fades over the last third). */
  scorch(x: number, z: number, radius: number, life = 14): void {
    const i = this.next;
    this.next = (this.next + 1) % DECAL_CAP;
    this.sx[i] = x;
    this.sz[i] = z;
    this.sr[i] = radius;
    this.sAge[i] = 0;
    this.sLife[i] = life;
    this.sRot[i] = Math.random() * Math.PI * 2;
  }

  /** A shadow this frame at (x, z): `radius` m, `dark` 0..1, umbra fraction `sharp` 0..1. */
  shadow(x: number, z: number, radius: number, dark: number, sharp: number): void {
    this.shadows.push(x, z, radius, dark, sharp);
  }

  /** A shuddering ring of snow this frame at (x, z), `radius` m, `strength` 0..1, animated by `phase`. */
  ring(x: number, z: number, radius: number, strength: number, phase: number): void {
    this.rings.push(x, z, radius, strength, phase);
  }

  /** Age the scorches, lay everything down. */
  update(dt: number): void {
    const p = this.pool;
    p.begin();
    for (let k = 0; k < this.shadows.length; k += 5) {
      const i = p.add();
      if (i < 0) break;
      this.place(i, this.shadows[k], this.shadows[k + 1], this.shadows[k + 2], 0, 1);
      p.set('aParam', i, this.shadows[k + 3], this.shadows[k + 4], 0, 0);
    }
    this.shadows.length = 0;
    for (let k = 0; k < this.rings.length; k += 5) {
      const i = p.add();
      if (i < 0) break;
      this.place(i, this.rings[k], this.rings[k + 1], this.rings[k + 2], 0, 2);
      p.set('aParam', i, this.rings[k + 3], this.rings[k + 4], 0, 0);
    }
    this.rings.length = 0;
    for (let s = 0; s < DECAL_CAP; s++) {
      if (this.sAge[s] >= this.sLife[s]) continue;
      this.sAge[s] += dt;
      const left = 1 - this.sAge[s] / this.sLife[s];
      const i = p.add();
      if (i < 0) break;
      // Darkens as it burns in (first second), fades as fresh snow sifts over it.
      const k = Math.min(1, this.sAge[s] / 1.2) * Math.min(1, left * 3);
      this.place(i, this.sx[s], this.sz[s], this.sr[s], this.sRot[s], 0);
      p.set('aParam', i, k, 0, 0, 0);
    }
    p.end();
  }

  private place(i: number, x: number, z: number, r: number, rot: number, kind: number): void {
    const d = Math.max(0.5, r * 0.5);
    const sx = (duneHeight(x - d, z) - duneHeight(x + d, z)) / (2 * d);
    const sz = (duneHeight(x, z - d) - duneHeight(x, z + d)) / (2 * d);
    this.pool.set('aPos', i, x, duneHeight(x, z), z, r);
    this.pool.set('aTilt', i, sx, sz, rot, kind);
  }

  clear(): void {
    this.sAge.fill(1e9);
    this.shadows.length = 0;
    this.rings.length = 0;
  }
}
