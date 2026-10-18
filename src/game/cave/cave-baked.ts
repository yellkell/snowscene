/**
 * The ice mine from the Blender bake (art/scripts/cave_build.py -> cave_bake.py -> cave_encode.py ->
 * public/cave/): the glacier shell and every fixed timber as two light-mapped regions, the fifteen
 * machines and the mill wheel lit from a baked light volume, the deck tiles, signal lamps, glow cards and
 * ropes as instanced banks, the black meltwater and the chimney's daylight.
 *
 * Light (art/DESIGN.md §2, the cave's version) is re-lit from three channels baked apart:
 *   day      the chimney's daylight and the glacier glowing with it (follows the weather outside)
 *   lantern  the oil lanterns (a slow, slight flicker)
 *   beacon   the brazier at the top, dark until you light it (then the cave warms from the top down)
 * Regions decode  albedo * (Ld * day + Ll * lantern + Lb * beacon); machines, decks, lamps and ropes take
 * the same three terms from an ambient cube per probe of the light volume, so a gondola darkens under the
 * wheel and warms beside a lantern. Everything tone-maps through AgX; the look-dev renders' exposure is
 * folded into the channels' colours (CAVE_EXPOSURE). The wet ice and the pool reflect a cube of the cave
 * captured once at runtime (captureCaveEnv).
 */

import {
  AdditiveBlending,
  type Box3,
  CustomBlending,
  ZeroFactor,
  SrcColorFactor,
  type BufferGeometry,
  ClampToEdgeWrapping,
  Color,
  CubeCamera,
  CylinderGeometry,
  Data3DTexture,
  DoubleSide,
  Group,
  Float32BufferAttribute,
  InstancedMesh,
  HalfFloatType,
  LatheGeometry,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  type Object3D,
  PlaneGeometry,
  RepeatWrapping,
  RGBAFormat,
  type Scene,
  ShaderMaterial,
  type Texture,
  UnsignedByteType,
  Vector2,
  Vector3,
  Vector4,
  WebGLCubeRenderTarget,
  type WebGLRenderer,
} from '@iwsdk/core';
import { assetUrl, loadGLTF, loadJSON, loadTexture, track } from '../baked/loaders.js';
import { bakedLight, bakedView } from '../baked/light.js';
import { firstGeometry } from '../baked/survivors-arena.js';
import { cutTriangles, loadChunked } from '../baked/lod.js';

const DIR = 'cave/';

interface RegionInfo {
  mesh: string;
  albedo: string;
  light: string;
  max: [number, number, number];
  glow_max?: number;
  emit_max?: number;
  tris: number;
}

export interface CaveManifest {
  shell: RegionInfo;
  works: RegionInfo;
  /** Icicles, rocks frozen into the ice and at the waterline, drips under the beams. */
  debris?: RegionInfo;
  machines: { albedo: string; objects: Record<string, { mesh: string; tris: number }> };
  deck: { albedo: string; mesh: string; tris: number };
  rope: { albedo: string; normal: string; lay: number; radius: number };
  volume: { file: string; dims: [number, number, number]; origin: [number, number, number]; step: number; max: [number, number, number] };
  lanterns: [number, number, number][];
  /** How many of `lanterns` stand on the stations' corner posts (they come first; the rest hang from brackets). */
  lanterns_station?: number;
  beacon: [number, number, number];
  /** The chimney's top ring: [y, cx, cz, rx, rz] (course space). */
  chimney: [number, number, number, number, number];
  detail?: { wood: string; ice: string };
}

/* ── light: the three channels' colours (chroma of the baked emitters, luminance 1) ─────────────── */

const LANTERN_CHROMA = new Color(1.587, 0.889, 0.381);
const DAY_CHROMA = new Color(0.89, 1.0, 1.23);
const BEACON_CHROMA = new Color(1.715, 0.858, 0.309);
const GLOW_CHROMA = new Color(0.53, 1.06, 1.77);
const GLOBE_CHROMA = new Color(1.48, 0.917, 0.414);
/**
 * Blender's view exposure for the look-dev renders (+4 stops), folded into the channels' colours so the
 * renderer itself stays at exposure 1 (the fire, the torch and the glider parts are graded for that).
 */
export const CAVE_EXPOSURE = 16;
/** The renderer's exposure inside the cave (on top of CAVE_EXPOSURE's grade). */
const CAVE_VIEW_EXPOSURE = 1.75;
/** The pool's surface in cave space (cave-build.ts POOL_Y; not imported, cave-build imports this file). */
const POOL_LOCAL_Y = -0.32;
/** How many lanterns' glints the wet ice and the pool evaluate (the nearest few). */
const GLINTS = 4;

/** Shared by every cave material. Positions are world space. */
export const caveLight = {
  uDayCol: { value: new Color() },
  uLanCol: { value: new Color() },
  uBeaCol: { value: new Color() },
  uBeaFront: { value: 1e4 },
  uGlowCol: { value: new Color() },
  uGlobeCol: { value: new Color() },
  tVol: { value: null as Data3DTexture | null },
  uVolOrigin: { value: new Vector3() },
  uVolDims: { value: new Vector3(1, 1, 1) },
  uVolStep: { value: 0.5 },
  uVolMax: { value: new Vector3(1, 1, 1) },
  /** The next deck's square: warm lantern light pooled on its boards (xyz world, strength). */
  uMarker: { value: new Vector4(0, -1e4, 0, 0) },
  /** The nearest lanterns (xyz world, intensity) for glints on wet ice and water. */
  uGlints: { value: Array.from({ length: GLINTS }, () => new Vector4()) },
  tWood: { value: null as Texture | null },
  tIce: { value: null as Texture | null },
  /** The ice's fine albedo detail (bubbles, hairline fractures, growth layers; art/scripts/ice_fine.py). */
  tIceFine: { value: null as Texture | null },
  uCaveTime: { value: 0 },
  /** The cave seen from above the pool (captured once at runtime, linear HDR) for wet reflections. */
  tEnv: { value: null as Texture | null },
  /** Where it was captured, and the ellipsoid its reflections are projected onto (world). */
  uEnvC: { value: new Vector3() },
  uEnvR: { value: new Vector3(11, 16, 15) },
  uEnvOn: { value: 0 },
  /** The pool's surface (world y): the ice is wet for a couple of metres above it. */
  uLowWet: { value: -1e4 },
  /** Debug: 1 shows the shell's baked diffuse alone, 2 its albedo, 3 its light. */
  uCaveDebug: { value: 0 },
};

export const CAVE_GLSL = /* glsl */ `
uniform vec3 uDayCol;
uniform vec3 uLanCol;
uniform vec3 uBeaCol;
uniform float uBeaFront;
uniform vec3 uGlowCol;
uniform vec3 uGlobeCol;
uniform highp sampler3D tVol;
uniform vec3 uVolOrigin;
uniform vec3 uVolDims;
uniform float uVolStep;
uniform vec3 uVolMax;
uniform vec4 uMarker;
uniform vec4 uGlints[${GLINTS}];
uniform sampler2D tWood;
uniform sampler2D tIce;
uniform sampler2D tIceFine;
// The ice at arm's length: bubbles, hairline fractures, growth layers (triplanar, ~0.6 m), fading out
// with distance before it can shimmer. Multiplies the albedo around 1.
vec3 iceFine(vec3 p, vec3 n, vec3 cam) {
  vec3 w = abs(n);
  w = w * w;
  w /= (w.x + w.y + w.z);
  float near = 1.0 - smoothstep(3.0, 12.0, length(cam - p));
  // past 12 m it has faded out: skip its three fetches (most of a big chamber's pixels)
  if (near <= 0.0) return vec3(1.0);
  float s = 1.0 / 0.6;
  float f = texture2D(tIceFine, p.zy * s).r * w.x + texture2D(tIceFine, p.xz * s).r * w.y + texture2D(tIceFine, p.xy * s).r * w.z;
  return vec3(mix(1.0, f * 2.0, near));
}
uniform float uCaveTime;
uniform samplerCube tEnv;
uniform vec3 uEnvC;
uniform vec3 uEnvR;
uniform float uEnvOn;
uniform float uCaveDebug;
uniform float uLowWet;
// The cave as reflected along r from p: the capture, parallax-corrected onto an ellipsoid round the cave.
vec3 caveEnv(vec3 p, vec3 r, float blur) {
  vec3 o = (p - uEnvC) / uEnvR;
  vec3 d = r / uEnvR;
  float a = dot(d, d);
  float b = dot(o, d);
  float c = dot(o, o) - 1.0;
  float t = (-b + sqrt(max(b * b - a * c, 0.0))) / a;
  // (clamped first, so the roll-off below never sees an overflowed half-float texel)
  vec3 e = min(textureCube(tEnv, p + r * t - uEnvC, blur).rgb, vec3(1e3)) * uEnvOn;
  // the chimney's sky is far brighter than anything else in the capture: don't let it sparkle everywhere
  return e / (1.0 + dot(e, vec3(0.08)));
}
// The three channels' irradiance (day, lantern, beacon) -> radiance off a white surface.
// The beacon's light spreads down the cave from the top as the fire takes (uBeaFront: world height).
vec3 caveLight(vec3 L, float wy) {
  float b = smoothstep(uBeaFront - 6.0, uBeaFront, wy);
  return L.x * uDayCol + L.y * uLanCol + L.z * b * uBeaCol;
}
// One face of the light volume's ambient cubes at grid coordinate g (depth = face * nz + k).
vec3 volFace(vec3 g, float f) {
  vec3 c = clamp(g, vec3(0.0), uVolDims - 1.0);
  vec3 uvw = vec3((c.x + 0.5) / uVolDims.x, (c.y + 0.5) / uVolDims.y, (f * uVolDims.z + c.z + 0.5) / (6.0 * uVolDims.z));
  vec3 t = texture(tVol, uvw).rgb;
  return t * t * uVolMax;
}
// Irradiance per channel onto a surface facing n at world point p, from the baked ambient cubes.
vec3 ambientCube(vec3 n, vec3 p) {
  vec3 g = (p - uVolOrigin) / uVolStep;
  vec3 n2 = n * n;
  return n2.x * volFace(g, n.x >= 0.0 ? 0.0 : 1.0)
       + n2.y * volFace(g, n.y >= 0.0 ? 2.0 : 3.0)
       + n2.z * volFace(g, n.z >= 0.0 ? 4.0 : 5.0);
}
// Wood: the scan's own grain at full resolution over the atlas's (WoodUV: one plank strip per face).
vec3 woodDetail(vec3 alb, vec2 uv1) {
  if (uv1.x < -25.0) return vec3(0.05, 0.048, 0.05);       // a bolt or nail head: forged iron
  if (uv1.x < -5.0) return alb;
  float r = texture(tWood, uv1).r * 2.0;
  return alb * mix(1.0, r, 0.85);
}
// The next deck's warm pool of light (added onto the boards).
vec3 markerLight(vec3 wp) {
  if (uMarker.w <= 0.0) return vec3(0.0);
  vec3 d = wp - uMarker.xyz;
  float r = length(d.xz);
  float f = (1.0 - smoothstep(0.05, 0.5, r)) * (1.0 - smoothstep(0.0, 0.12, abs(d.y)));
  return vec3(1.0, 0.62, 0.3) * uMarker.w * f;
}
float caveHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

const OUT_FRAG = /* glsl */ `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;

function shader(uniforms: Record<string, { value: unknown }>, vertexShader: string, fragmentShader: string): ShaderMaterial {
  const m = new ShaderMaterial({ uniforms: { ...caveLight, ...uniforms }, vertexShader, fragmentShader, fog: false });
  return m;
}

/* ── regions: the shell and the works ───────────────────────────────────────────────────────────── */

const REGION_VERT = /* glsl */ `
attribute vec2 uv1;
varying vec2 vUv;
varying vec2 vUv1;
varying vec3 vW;
varying vec3 vN;
void main() {
  vUv = uv;
  vUv1 = uv1;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

function regionMaterial(kind: 'shell' | 'works' | 'debris', r: RegionInfo, albedo: Texture, light: Texture): ShaderMaterial {
  // the debris (ice, wet rock) is shaded like the shell: wet glints and the cave's own reflection
  const shell = kind !== 'works';
  return shader(
    {
      tAlbedo: { value: albedo },
      tLight: { value: light },
      uMax: { value: new Vector3(r.max[0], r.max[1], r.max[2]) },
      uExtraMax: { value: (shell ? r.glow_max : r.emit_max) ?? 1 },
    },
    shell ? REGION_VERT.replace('attribute vec2 uv1;', 'vec2 uv1 = vec2(-20.0);') : REGION_VERT,
    /* glsl */ `
    ${CAVE_GLSL}
    uniform sampler2D tAlbedo;
    uniform sampler2D tLight;
    uniform vec3 uMax;
    uniform float uExtraMax;
    varying vec2 vUv;
    varying vec2 vUv1;
    varying vec3 vW;
    varying vec3 vN;
    void main() {
      vec4 a = texture2D(tAlbedo, vUv);
      vec3 t = texture2D(tLight, vUv).rgb;
      vec3 L = t * t * uMax;
      // under the water the bake saw the old black pool and baked the ice beneath it black; through the
      // clear water it reads lit by what reaches the surface above it (as the bed is)
      float sub = smoothstep(uLowWet - 0.03, uLowWet - 0.35, vW.y);
      // (sampled a metre out from the ice, in the open: the volume's cells against the wall lie in the ice)
      vec3 hz = vec3(vN.x, 0.0, vN.z);
      vec3 sp = vec3(vW.x, uLowWet + 0.4, vW.z) + hz * (1.0 / max(length(hz), 1e-3));
      if (sub > 0.0) L = mix(L, 0.6 * ambientCube(vec3(0.0, 1.0, 0.0), sp), sub);
      float extra = a.a * a.a * uExtraMax;
      ${
        shell
          ? /* glsl */ `
      vec3 alb = a.rgb * iceFine(vW, normalize(vN), cameraPosition);
      vec3 col = alb * caveLight(L, vW.y) + extra * uGlowCol;
      if (uCaveDebug > 0.5) {
        gl_FragColor = vec4(uCaveDebug < 1.5 ? col : (uCaveDebug < 2.5 ? alb : (uCaveDebug < 3.5 ? caveLight(L, vW.y) * 0.2 : vec3(fract(vUv * 4.0), 0.0))), 1.0);
        ${OUT_FRAG}
        return;
      }
      // Wet ice: the nearest lanterns glint in the scallops (only where the bake says their light reaches).
      // Wet only in places: meltwater streaks down the walls, and everything near the waterline. Glints
      // on every scallop at once read as a mosaic, not as wet ice.
      vec3 ng = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0);
      float streak = texture2D(tIce, vec2(vW.x * 0.11 + vW.z * 0.07, vW.y * 0.012)).x;
      float wet = clamp(smoothstep(0.66, 0.86, streak) + smoothstep(uLowWet + 2.5, uLowWet, vW.y), 0.0, 1.0) * (1.0 - sub);
      vec3 V = normalize(cameraPosition - vW);
      vec3 n = ng;
      if (wet > 0.0) {
        // the scallops' fine relief (three fetches) and the glints only where it's wet: on dry, frosted ice
        // neither shows, so most of the shell skips them
        vec3 bw = abs(ng);
        bw = bw / (bw.x + bw.y + bw.z);
        vec2 dx = texture2D(tIce, vW.zy * 0.62).xy * 2.0 - 1.0;
        vec2 dy = texture2D(tIce, vW.xz * 0.62).xy * 2.0 - 1.0;
        vec2 dz = texture2D(tIce, vW.xy * 0.62).xy * 2.0 - 1.0;
        n = normalize(ng + (vec3(0.0, dx.y, dx.x) * bw.x + vec3(dy.x, 0.0, dy.y) * bw.y + vec3(dz.x, dz.y, 0.0) * bw.z) * 0.16);
      }
      float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
      if (wet > 0.0) {
        vec3 spec = vec3(0.0);
        float direct = 0.0;
        for (int i = 0; i < ${GLINTS}; i++) {
          vec4 g = uGlints[i];
          if (g.w <= 0.0) continue;
          vec3 d = g.xyz - vW;
          float r2 = max(dot(d, d), 0.04);
          vec3 l = d * inversesqrt(r2);
          float e = g.w / r2;
          direct += e * max(dot(ng, l), 0.0);
          vec3 h = normalize(l + V);
          spec += e * pow(max(dot(n, h), 0.0), 400.0) * 14.0 * fres * max(dot(n, l), 0.0);
        }
        // how much of that light the bake says actually lands here (shadowed glints go dark)
        float vis = clamp(L.y / max(direct, 1e-4), 0.0, 1.0);
        col += spec * vis * wet * uLanCol * 0.6;
      }
      // and the wet sheen: the cave itself, mirrored in the ice - where it's wet; dry, frosted ice only
      // gives back a hazy hint (full-strength mirroring on the runtime shell's facets read as plates)
      col += fres * (0.05 + 0.3 * wet) * min(caveEnv(vW, reflect(-V, n), 4.0 + 4.0 * (1.0 - wet)), vec3(1.5));`
          : /* glsl */ `
      vec3 alb = woodDetail(a.rgb, vUv1);
      // the lantern globes: amber glass with a hotter core, held below where AgX clips a warm colour to
      // white (the bake's emission x the cave exposure is ~1000 at peak; a lit globe wants ~8)
      float g = a.a * a.a;
      vec3 col = alb * caveLight(L, vW.y) + uGlobeCol * (g * (0.45 + 0.55 * g) * ${(9 / CAVE_EXPOSURE).toFixed(4)});
      if (uCaveDebug > 0.5) {
        gl_FragColor = vec4(uCaveDebug < 1.5 ? col : (uCaveDebug < 2.5 ? alb : (uCaveDebug < 3.5 ? caveLight(L, vW.y) * 0.2 : vec3(fract(vUv * 4.0), 0.0))), 1.0);
        ${OUT_FRAG}
        return;
      }`
      }
      gl_FragColor = vec4(col, 1.0);
      ${OUT_FRAG}
    }`,
  );
}

/* ── machines, wheel, decks: albedo + AO, lit from the volume ──────────────────────────────────── */

const VOLUME_VERT = /* glsl */ `
attribute vec2 uv1;
varying vec2 vUv;
varying vec2 vUv1;
varying vec3 vW;
varying vec3 vN;
#ifdef USE_INSTANCING_COLOR
varying vec3 vTint;
#endif
void main() {
  vUv = uv;
  vUv1 = uv1;
  #ifdef USE_INSTANCING
  mat4 m = modelMatrix * instanceMatrix;
  #else
  mat4 m = modelMatrix;
  #endif
  #ifdef USE_INSTANCING_COLOR
  vTint = instanceColor;
  #endif
  vec4 wp = m * vec4(position, 1.0);
  vW = wp.xyz;
  vN = normalize(mat3(m) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

function volumeMaterial(albedoAo: Texture, deck = false): ShaderMaterial {
  return shader(
    { tAlbedo: { value: albedoAo } },
    VOLUME_VERT,
    /* glsl */ `
    ${CAVE_GLSL}
    uniform sampler2D tAlbedo;
    varying vec2 vUv;
    varying vec2 vUv1;
    varying vec3 vW;
    varying vec3 vN;
    #ifdef USE_INSTANCING_COLOR
    varying vec3 vTint;
    #endif
    void main() {
      vec4 a = texture2D(tAlbedo, vUv);
      vec3 alb = woodDetail(a.rgb, vUv1);
      vec3 n = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0);
      // sample the volume a little off the surface, toward the open side
      vec3 E = ambientCube(n, vW + n * 0.12);
      vec3 col = alb * caveLight(E, vW.y) * a.a;
      ${
        deck
          ? /* glsl */ `
      col += alb * markerLight(vW) * a.a;
      #ifdef USE_INSTANCING_COLOR
      // a slip burns the deck that left without you
      col = mix(col, col * vTint + vec3(0.6, 0.02, 0.0) * (1.0 - vTint.g), step(vTint.g, 0.99));
      #endif`
          : ''
      }
      gl_FragColor = vec4(col, 1.0);
      ${OUT_FRAG}
    }`,
  );
}

/* ── signal lamps: cast-iron railway lamps, a coloured glass dome lit by the signal ─────────────── */

function lampGeometry(): BufferGeometry {
  // Squat iron body with a rim, a domed lens on top (lens verts flagged in uv.x > 1).
  const pts: Vector2[] = [
    new Vector2(0.0, -0.03),
    new Vector2(0.03, -0.03),
    new Vector2(0.032, -0.026),
    new Vector2(0.028, -0.022),
    new Vector2(0.027, 0.0),
    new Vector2(0.031, 0.002),
    new Vector2(0.031, 0.008),
    new Vector2(0.024, 0.009),
  ];
  const lens: Vector2[] = [];
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * (Math.PI / 2);
    lens.push(new Vector2(Math.cos(a) * 0.023 + 1e-4, 0.009 + Math.sin(a) * 0.02));
  }
  const body = new LatheGeometry(pts, 14);
  const dome = new LatheGeometry(lens, 14);
  const uvB = body.getAttribute('uv');
  for (let i = 0; i < uvB.count; i++) uvB.setX(i, 0);
  const uvD = dome.getAttribute('uv');
  for (let i = 0; i < uvD.count; i++) uvD.setX(i, 2);
  return mergeTwo(body, dome);
}

function mergeTwo(a: BufferGeometry, b: BufferGeometry): BufferGeometry {
  const ga = a.index ? a.toNonIndexed() : a;
  const gb = b.index ? b.toNonIndexed() : b;
  const out = ga.clone();
  for (const name of ['position', 'normal', 'uv']) {
    const x = ga.getAttribute(name);
    const y = gb.getAttribute(name);
    const arr = new Float32Array(x.array.length + y.array.length);
    arr.set(x.array as Float32Array, 0);
    arr.set(y.array as Float32Array, x.array.length);
    out.setAttribute(name, new Float32BufferAttribute(arr, x.itemSize));
  }
  out.computeBoundingSphere();
  return out;
}

function lampMaterial(): ShaderMaterial {
  return shader(
    {},
    /* glsl */ `
    varying vec3 vW;
    varying vec3 vN;
    varying float vLens;
    varying vec3 vSig;
    void main() {
      vLens = step(1.0, uv.x);
      #ifdef USE_INSTANCING_COLOR
      vSig = instanceColor;
      #else
      vSig = vec3(0.0);
      #endif
      mat4 m = modelMatrix * instanceMatrix;
      vec4 wp = m * vec4(position, 1.0);
      vW = wp.xyz;
      vN = normalize(mat3(m) * normal);
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
    /* glsl */ `
    ${CAVE_GLSL}
    varying vec3 vW;
    varying vec3 vN;
    varying float vLens;
    varying vec3 vSig;
    void main() {
      vec3 n = normalize(vN);
      vec3 E = ambientCube(n, vW + n * 0.1);
      vec3 iron = vec3(0.045, 0.043, 0.045) * caveLight(E, vW.y);
      // the lens: coloured glass, lit from inside by the signal (off: dark glass that still catches light)
      vec3 V = normalize(cameraPosition - vW);
      float rim = pow(1.0 - max(dot(n, V), 0.0), 2.0);
      float lit = max(vSig.r, max(vSig.g, vSig.b));
      vec3 glass = vSig * 9.0 * (0.75 + 0.5 * rim) + vec3(0.03, 0.03, 0.035) * caveLight(E, vW.y) + rim * 0.02;
      vec3 col = mix(iron, glass, vLens);
      gl_FragColor = vec4(col, 1.0);
      ${OUT_FRAG}
    }`,
  );
}

/* ── the lantern globes ─────────────────────────────────────────────────────────────────────────── */

/**
 * The scanned lantern's globe came out of the bake's decimation with its shoulder unlit (a dark V under
 * the hood) and half of the flame inside it dark: a clean glass globe goes over it, just inside the wire
 * guard. Profile (radius, height above the lantern's base), traced off the baked glass.
 */
const GLOBE_PROFILE: [number, number][] = [
  [0.0, 0.032],
  [0.022, 0.034],
  [0.033, 0.048],
  [0.041, 0.068],
  [0.0455, 0.088],
  [0.0465, 0.104],
  [0.0415, 0.122],
  [0.036, 0.136],
  [0.028, 0.147],
  [0.014, 0.155],
  [0.0, 0.157],
];
/** The flame's height above the lantern's base. */
const GLOBE_FLAME_Y = 0.095;
/** A manifest lantern point sits this far above its lantern's base: on a station post, and hung. */
const LANTERN_BASE_DROP = { station: 0.12, hung: 0.17 };

function globeMaterial(): ShaderMaterial {
  return shader(
    {},
    /* glsl */ `
    varying vec3 vW;
    varying vec3 vN;
    varying float vH;
    void main() {
      vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
      vW = wp.xyz;
      vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
      vH = position.y;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
    /* glsl */ `
    ${CAVE_GLSL}
    varying vec3 vW;
    varying vec3 vN;
    varying float vH;
    void main() {
      // amber glass with the flame behind it: hottest looking straight through at flame height, as the
      // baked globes are graded (well below where AgX clips a warm colour to white)
      float f = abs(dot(normalize(vN), normalize(cameraPosition - vW)));
      float h = (vH - ${GLOBE_FLAME_Y.toFixed(3)}) / 0.035;
      float k = 0.05 + 0.1 * f * f + 0.35 * pow(f, 6.0) * exp(-h * h);
      gl_FragColor = vec4(uGlobeCol * (k * ${(9 / CAVE_EXPOSURE).toFixed(4)}), 1.0);
      ${OUT_FRAG}
    }`,
  );
}

/** Every lantern's globe, as one instanced bank (course space). */
function lanternGlobes(man: CaveManifest): InstancedMesh {
  const geo = new LatheGeometry(
    GLOBE_PROFILE.map(([r, y]) => new Vector2(r, y)),
    20,
  );
  const n = man.lanterns.length;
  const station = man.lanterns_station ?? n;
  const globes = new InstancedMesh(geo, globeMaterial(), n);
  const m = new Matrix4();
  man.lanterns.forEach(([x, y, z], i) => {
    globes.setMatrixAt(i, m.makeTranslation(x, y - (i < station ? LANTERN_BASE_DROP.station : LANTERN_BASE_DROP.hung), z));
  });
  globes.instanceMatrix.needsUpdate = true;
  globes.computeBoundingSphere();
  globes.name = 'LanternGlobes';
  return globes;
}

/** Soft glow cards round every lit lamp, facing the eye (shares the lamps' matrices and colours). */
function glowMaterial(): ShaderMaterial {
  const m = shader(
    {},
    /* glsl */ `
    varying vec2 vQ;
    varying vec3 vSig;
    void main() {
      vQ = position.xy;
      #ifdef USE_INSTANCING_COLOR
      vSig = instanceColor;
      #else
      vSig = vec3(0.0);
      #endif
      mat4 m = modelMatrix * instanceMatrix;
      vec3 c = (m * vec4(0.0, 0.02, 0.0, 1.0)).xyz;
      vec3 d = normalize(cameraPosition - c);
      vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), d) + vec3(1e-4, 0.0, 0.0));
      vec3 up = cross(d, right);
      float lit = max(vSig.r, max(vSig.g, vSig.b));
      // the lens looks up: from under the deck there's nothing to see
      float size = lit > 0.2 ? 0.15 * smoothstep(-0.08, 0.2, d.y) : 0.0;
      // pulled toward the eye a touch so it never sinks into the deck
      vec3 wp = c + d * 0.05 + (right * position.x + up * position.y) * size;
      gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
    }`,
    /* glsl */ `
    varying vec2 vQ;
    varying vec3 vSig;
    void main() {
      // a lens seen through cold air: a hot point and a tight halo (not a soft ball of colour)
      float r = length(vQ) * 2.0;
      float a = (exp(-r * r * 60.0) * 1.4 + exp(-r * r * 11.0) * 0.32) * (1.0 - smoothstep(0.8, 1.0, r));
      gl_FragColor = vec4(vSig * a, 1.0);
      ${OUT_FRAG}
    }`,
  );
  m.transparent = true;
  m.depthWrite = false;
  m.blending = AdditiveBlending;
  return m;
}

/* ── ropes: one instanced cylinder, tarred hemp whose texture runs along the rope's length ──────── */

function ropeMaterial(albedo: Texture, lay: number): ShaderMaterial {
  albedo.wrapS = albedo.wrapT = RepeatWrapping;
  return shader(
    { tRope: { value: albedo }, uLay: { value: lay } },
    /* glsl */ `
    uniform float uLay;
    varying vec2 vUv;
    varying vec3 vW;
    varying vec3 vN;
    void main() {
      mat4 m = modelMatrix * instanceMatrix;
      float len = length(instanceMatrix[1].xyz);
      // the geometry runs y -0.5..0.5; the lay repeats along the rope's true length
      vUv = vec2(uv.x, (position.y + 0.5) * len / uLay);
      vec4 wp = m * vec4(position, 1.0);
      vW = wp.xyz;
      vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
    /* glsl */ `
    ${CAVE_GLSL}
    uniform sampler2D tRope;
    varying vec2 vUv;
    varying vec3 vW;
    varying vec3 vN;
    void main() {
      vec4 a = texture2D(tRope, vUv);
      vec3 n = normalize(vN);
      vec3 E = ambientCube(n, vW + n * 0.1);
      gl_FragColor = vec4(a.rgb * a.a * caveLight(E, vW.y), 1.0);
      ${OUT_FRAG}
    }`,
  );
}

/* ── the meltwater: black, a mirror for the lanterns and the sky at the top of the chimney ──────── */

/**
 * Clear glacial meltwater over a stony bed: the bed is a shallow basin under the whole pool (deepest in the
 * middle), lit by the cave's light volume, with caustics from the light above playing on it. The water
 * absorbs each colour by the length of the path through it (red first), so the shallows are clear and the
 * deep middle glacial turquoise; posts and stones under it take the same tint. Three draws: the bed, then
 * the water's transmittance multiplied over everything under it, then its reflections and glow added.
 */
const POOL_GLSL = /* glsl */ `
uniform vec2 uPoolC;
// how deep the bed lies under the surface at q (pool-centred world x, z)
float bedDepth(vec2 q) {
  float r = length(q * vec2(1.0, 0.85)) / 11.0;
  float d = 0.4 + 2.4 * (1.0 - smoothstep(0.1, 1.1, r));
  d += 0.22 * sin(q.x * 0.83 + 1.3) * sin(q.y * 0.71 - 0.4) + 0.09 * sin(q.x * 2.3 + q.y * 1.7) + 0.05 * sin(q.x * 5.1 - q.y * 4.3);
  return max(d, 0.22);
}
// moving caustic lines: a warped interference pattern, sharpened into bright filaments
float caustic(vec2 p, float t) {
  vec2 a = p;
  float c = 0.0;
  for (int i = 0; i < 3; i++) {
    a += vec2(sin(a.y * 1.31 + t * 0.71 + float(i) * 1.7), cos(a.x * 1.17 - t * 0.53 + float(i) * 2.3)) * 0.42;
    float v = abs(sin(a.x * 2.1) + sin(a.y * 2.3)) * 0.5;
    c += pow(1.0 - min(v, 1.0), 6.0);
  }
  return c / 3.0;
}
// the water's slope where it shivers (drips from the icicles): smooth travelling wavelets
vec3 waterNormal(vec2 q, float t) {
  vec2 slope = vec2(0.0);
  const vec2 D0 = vec2(0.83, 0.56), D1 = vec2(-0.47, 0.88), D2 = vec2(0.12, -0.99), D3 = vec2(-0.91, -0.41), D4 = vec2(0.64, -0.77);
  slope += D0 * cos(dot(q, D0) * 2.3 + t * 0.9) * 0.010;
  slope += D1 * cos(dot(q, D1) * 3.7 - t * 1.3) * 0.007;
  slope += D2 * cos(dot(q, D2) * 5.9 + t * 1.7) * 0.005;
  slope += D3 * cos(dot(q, D3) * 9.1 - t * 2.2) * 0.0035;
  slope += D4 * cos(dot(q, D4) * 14.3 + t * 2.9) * 0.0025;
  return normalize(vec3(slope.x, 1.0, slope.y));
}
// glacial meltwater's absorption per metre (red goes first, then green): turquoise
const vec3 SIGMA = vec3(0.6, 0.13, 0.07);
`;

// The light over the water: the light volume's, except the daylight down the chimney, which the volume's
// half-metre cells drew as a stepped white blot (with the posts' shadows in it): that lands as a soft-edged
// disc under the chimney, as bright as the volume has it at the shaft's centre.
const POOL_LIGHT_GLSL = /* glsl */ `
uniform vec2 uShaftC;
uniform vec2 uShaftR;
vec3 poolLight(vec2 xz, float h) {
  // (a metre in toward the middle: by the walls the volume's cells lie in the ice, and read black)
  vec2 toC = uPoolC - xz;
  xz += toC * min(1.0, 1.0 / max(length(toC), 1e-3));
  vec3 L = ambientCube(vec3(0.0, 1.0, 0.0), vec3(xz.x, h, xz.y));
  float day = ambientCube(vec3(0.0, 1.0, 0.0), vec3(uShaftC.x, h, uShaftC.y)).x;
  float disc = 1.0 - smoothstep(0.55, 1.2, length((xz - uShaftC) / uShaftR));
  L.x = min(L.x, day * 0.12) + day * 0.88 * disc;
  return caveLight(L, h);
}
`;

const POOL_SURFACE_VERT = /* glsl */ `
varying vec3 vW;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

/** The bed: gravel and pale stones under the water, the glacier's blue in the hollows, caustics on it. */
function poolBedMaterial(poolC: Vector2, shaftC: Vector2, shaftR: Vector2): ShaderMaterial {
  const m = shader(
    { uPoolC: { value: poolC }, uShaftC: { value: shaftC }, uShaftR: { value: shaftR } },
    /* glsl */ `
    uniform float uLowWet;
    ${POOL_GLSL}
    varying vec3 vW;
    varying vec3 vN;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vec2 q = wp.xz - uPoolC;
      wp.y = uLowWet - bedDepth(q);
      float e = 0.15;
      float hx = bedDepth(q + vec2(e, 0.0)) - bedDepth(q - vec2(e, 0.0));
      float hz = bedDepth(q + vec2(0.0, e)) - bedDepth(q - vec2(0.0, e));
      vN = normalize(vec3(hx, 2.0 * e, hz));
      vW = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
    /* glsl */ `
    ${CAVE_GLSL}
    ${POOL_GLSL}
    ${POOL_LIGHT_GLSL}
    varying vec3 vW;
    varying vec3 vN;
    float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float vn(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
    }
    void main() {
      vec3 n = normalize(vN);
      vec2 p = vW.xz;
      // rounded cobbles (cells of a jittered grid, each its own tone, dark silt in the gaps between them)
      // over fine gravel, and glacial silt settled blue-grey in the deep hollows
      vec2 c = p * 2.4 + (vec2(vn(p * 0.6), vn(p * 0.6 + 5.3)) - 0.5) * 0.9;
      vec2 ci = floor(c);
      float d1 = 9.0, d2 = 9.0;
      vec2 id = ci;
      for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
        vec2 g = ci + vec2(float(i), float(j));
        vec2 o = g + 0.5 + 0.38 * (vec2(h21(g), h21(g + 17.3)) - 0.5) * 2.0;
        float d = length(c - o);
        if (d < d1) { d2 = d1; d1 = d; id = g; } else if (d < d2) d2 = d;
      }
      float edge = smoothstep(0.02, 0.09, d2 - d1);
      // each stone domed: lit on top, falling off toward its rim
      float dome = 0.62 + 0.38 * (1.0 - smoothstep(0.05, 0.55, d1));
      float tone = h21(id + 3.1);
      float gravel = vn(p * 11.0) * 0.6 + vn(p * 29.0) * 0.4;
      vec3 stone = mix(vec3(0.46, 0.47, 0.47), vec3(0.8, 0.8, 0.77), tone);
      stone = mix(stone, vec3(0.55, 0.5, 0.44), step(0.82, tone)) * (0.85 + 0.25 * vn(p * 14.0));
      // gravel and silt between and around the stones; whole patches with none (bare gravel, larger at random)
      float bare = max(smoothstep(0.66, 0.72, vn(p * 0.5 + 2.0)), step(0.86, h21(id + 9.7)));
      vec3 grav = mix(vec3(0.26, 0.27, 0.27), vec3(0.42, 0.42, 0.4), gravel);
      vec3 alb = mix(grav * 0.7, stone * dome, edge * (1.0 - bare));
      alb = mix(alb, grav, bare);
      float hollow = smoothstep(1.2, 2.6, uLowWet - vW.y);
      alb = mix(alb, vec3(0.5, 0.6, 0.66), hollow * 0.55);
      // lit by the light that reaches the water's surface above it (the light volume below the surface holds
      // only the dark of the old black pool)
      vec3 L = 0.6 * poolLight(vW.xz, uLowWet + 0.4) * (0.85 + 0.15 * n.y);
      // caustics: the light above, gathered by the ripples into moving lines (sharper in the shallows)
      float depth = uLowWet - vW.y;
      float cs = caustic(p * (1.6 / (0.6 + 0.4 * depth)), uCaveTime * 0.9);
      vec3 col = alb * L * (0.8 + 1.3 * cs * exp(-0.22 * depth));
      gl_FragColor = vec4(col, 1.0);
      ${OUT_FRAG}
    }`,
  );
  return m;
}

/** What makes it through the water to the eye: multiplied over the bed and everything else under it. */
function poolAbsorbMaterial(poolC: Vector2): ShaderMaterial {
  const m = shader(
    { uPoolC: { value: poolC } },
    POOL_SURFACE_VERT,
    /* glsl */ `
    ${CAVE_GLSL}
    ${POOL_GLSL}
    varying vec3 vW;
    void main() {
      vec2 q = vW.xz - uPoolC;
      vec3 n = waterNormal(vW.xz, uCaveTime);
      vec3 V = normalize(cameraPosition - vW);
      float c = max(dot(n, V), 0.0);
      float fres = 0.02 + 0.98 * pow(1.0 - c, 5.0);
      // the path down to the bed, bent by refraction (1.33)
      float ct = sqrt(max(1.0 - (1.0 - c * c) / 1.77, 0.04));
      float path = bedDepth(q) / ct;
      vec3 T = exp(-SIGMA * path) * (1.0 - fres);
      // the scene behind is already display-encoded: carry the factor over to that space
      gl_FragColor = vec4(pow(T, vec3(1.0 / 2.2)), 1.0);
    }`,
  );
  m.transparent = true;
  m.depthWrite = false;
  m.blending = CustomBlending;
  m.blendSrc = ZeroFactor;
  m.blendDst = SrcColorFactor;
  return m;
}

/** The water's own light: the cave mirrored on it, lanterns drawn out into streaks, and the blue glow of
 * light scattered in its depth. Added over the transmitted view. */
function poolMaterial(chimney: Vector3, chimneyR: Vector2, poolC: Vector2, shaftC: Vector2, shaftR: Vector2): ShaderMaterial {
  const m = shader(
    { uChimney: { value: chimney }, uChimneyR: { value: chimneyR }, uPoolC: { value: poolC }, uShaftC: { value: shaftC }, uShaftR: { value: shaftR } },
    POOL_SURFACE_VERT,
    /* glsl */ `
    ${CAVE_GLSL}
    ${POOL_GLSL}
    ${POOL_LIGHT_GLSL}
    uniform vec3 uChimney;
    uniform vec2 uChimneyR;
    varying vec3 vW;
    void main() {
      vec2 q = vW.xz - uPoolC;
      vec3 n = waterNormal(vW.xz, uCaveTime);
      vec3 V = normalize(cameraPosition - vW);
      vec3 R = reflect(-V, n);
      float c = max(dot(n, V), 0.0);
      float fres = 0.02 + 0.98 * pow(1.0 - c, 5.0);
      // the cave mirrored: four taps a little apart (the capture is coarse, and the chimney's bright mouth
      // drew its texels as steps), capped near the walls' own brightness so that mouth, seen from straight
      // below, is a soft glow on the water and not a white blot
      vec3 t1 = normalize(cross(R, vec3(0.0, 0.0, 1.0)));
      vec3 t2 = cross(R, t1);
      vec3 env = caveEnv(vW, normalize(R + t1 * 0.035), 0.0) + caveEnv(vW, normalize(R - t1 * 0.035), 0.0)
               + caveEnv(vW, normalize(R + t2 * 0.035), 0.0) + caveEnv(vW, normalize(R - t2 * 0.035), 0.0);
      env *= 0.25;
      env *= min(1.0, 0.45 / max(dot(env, vec3(0.333)), 1e-3));
      vec3 col = fres * env * 0.3;
      // the chimney's daylight, far above
      if (R.y > 0.0 && uEnvOn < 0.5) {
        vec3 hit = vW + R * ((uChimney.y - vW.y) / R.y);
        vec2 e = (hit.xz - uChimney.xz) / uChimneyR;
        float inside = 1.0 - smoothstep(0.85, 1.05, length(e));
        col += fres * inside * uDayCol * 0.55;
        col += fres * uGlowCol * 0.01 * smoothstep(0.0, 0.6, R.y);
      }
      // the lanterns, mirrored and drawn out into streaks by the ripples
      for (int i = 0; i < ${GLINTS}; i++) {
        vec4 g = uGlints[i];
        if (g.w <= 0.0) continue;
        vec3 l = normalize(g.xyz - vW);
        float s = pow(max(dot(R, l), 0.0), 3000.0);
        col += uLanCol * g.w * s * fres * 4.0;
      }
      // light scattered back out of the depth: glacial blue, more of it over the deep middle
      float ct = sqrt(max(1.0 - (1.0 - c * c) / 1.77, 0.04));
      float path = bedDepth(q) / ct;
      vec3 Lw = poolLight(vW.xz, vW.y + 0.3);
      col += (1.0 - fres) * Lw * vec3(0.004, 0.026, 0.032) * (1.0 - exp(-0.5 * path));
      gl_FragColor = vec4(col, 1.0);
      ${OUT_FRAG}
    }`,
  );
  m.transparent = true;
  m.depthWrite = false;
  m.blending = AdditiveBlending;
  return m;
}

/* ── the chimney: the sky through its mouth, and the light falling down it ─────────────────────── */

function skyMaterial(): ShaderMaterial {
  return shader(
    {},
    /* glsl */ `
    varying vec2 vQ;
    void main() {
      vQ = position.xy;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
    /* glsl */ `
    ${CAVE_GLSL}
    varying vec2 vQ;
    void main() {
      float r = length(vQ);
      gl_FragColor = vec4(uDayCol * (1.6 - 0.6 * r), 1.0);
      ${OUT_FRAG}
    }`,
  );
}

function shaftMaterial(): ShaderMaterial {
  const m = shader(
    {},
    /* glsl */ `
    varying vec3 vW;
    varying vec3 vN;
    varying float vH;
    void main() {
      vH = position.y;
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vW = wp.xyz;
      vN = normalize(mat3(modelMatrix) * normal);
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
    /* glsl */ `
    ${CAVE_GLSL}
    varying vec3 vW;
    varying vec3 vN;
    varying float vH;
    void main() {
      vec3 V = normalize(cameraPosition - vW);
      // a soft column: thickest where you look through its middle, fading to nothing at its edge
      float edge = abs(dot(normalize(vN), V));
      float body = edge * edge;
      float fall = smoothstep(-0.5, 0.45, vH);               // strongest near the top
      float drift = 0.75 + 0.25 * sin(vW.y * 0.7 + uCaveTime * 0.3 + vW.x * 1.3);
      vec3 c = uDayCol * body * fall * drift * 0.006;
      gl_FragColor = vec4(c, 1.0);
      ${OUT_FRAG}
    }`,
  );
  m.transparent = true;
  m.depthWrite = false;
  m.blending = AdditiveBlending;
  m.side = DoubleSide;
  return m;
}

/* ── load ───────────────────────────────────────────────────────────────────────────────────────── */

export interface CaveBaked {
  /** Fixed things in course space: shell, works, pool, chimney sky and shaft. */
  statics: Group;
  /** Each machine's mesh in its own frame, by platform id ('wheel' for the mill wheel). */
  machines: Map<string, Mesh>;
  deckGeometry: BufferGeometry;
  deckMaterial: ShaderMaterial;
  lampGeometry: BufferGeometry;
  lampMaterial: ShaderMaterial;
  glowGeometry: BufferGeometry;
  glowMaterial: ShaderMaterial;
  ropeGeometry: BufferGeometry;
  ropeMaterial: ShaderMaterial;
  manifest: CaveManifest;
  look: CaveLook;
}

async function loadVolume(man: CaveManifest, origin: Vector3): Promise<void> {
  const v = man.volume;
  const r = await track(fetch(assetUrl(DIR + v.file)));
  if (!r.ok) throw new Error(`cave volume: ${r.status}`);
  const data = new Uint8Array(await r.arrayBuffer());
  const [nx, ny, nz] = v.dims;
  const tex = new Data3DTexture(data, nx, ny, nz * 6);
  tex.format = RGBAFormat;
  tex.type = UnsignedByteType;
  tex.minFilter = tex.magFilter = LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = ClampToEdgeWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  caveLight.tVol.value = tex;
  caveLight.uVolOrigin.value.set(v.origin[0], v.origin[1], v.origin[2]).add(origin);
  caveLight.uVolDims.value.set(nx, ny, nz);
  caveLight.uVolStep.value = v.step;
  caveLight.uVolMax.value.set(v.max[0], v.max[1], v.max[2]);
}

/** Shift a geometry so a deck tile's top sits where the game's tile box top was (+0.04 above its centre). */
function lift(geo: BufferGeometry, dy: number): BufferGeometry {
  geo.translate(0, dy, 0);
  return geo;
}

/** `cut`: boxes (course space) whose pieces of the baked works are left out (see bakedRackCuts). */
export async function loadCaveBaked(origin: Vector3, cut: readonly Box3[] = []): Promise<CaveBaked> {
  const man = await loadJSON<CaveManifest>(`${DIR}manifest.json`);
  const tex = (p: string, color: boolean, aniso = 4) => loadTexture(DIR + p, color, aniso);
  const debrisTex = man.debris ? Promise.all([tex(man.debris.albedo, true, 4), tex(man.debris.light, false, 4)]) : Promise.resolve(null);
  const [shellA, shellL, worksA, worksL, machA, deckA, ropeA, wood, ice, iceFine] = await Promise.all([
    tex(man.shell.albedo, true, 4),
    tex(man.shell.light, false, 4),
    tex(man.works.albedo, true, 8),
    tex(man.works.light, false, 8),
    tex(man.machines.albedo, true, 8),
    tex(man.deck.albedo, true, 8),
    tex(man.rope.albedo, true, 4),
    tex(man.detail?.wood ?? 'wood_detail.webp', false, 8),
    tex(man.detail?.ice ?? 'ice_detail.webp', false, 4),
    tex('ice_fine.webp', false, 8),
  ]);
  // The atlases are sampled at the glTF's UVs (which the exporter flips, v = 1 - v), and cave_encode
  // writes them top row first: so they load unflipped. The wood detail likewise.
  const debris = await debrisTex;
  for (const t of [shellA, shellL, worksA, worksL, machA, deckA, ...(debris ? [debris[0], debris[1]] : [])]) {
    t.flipY = false;
    t.needsUpdate = true;
  }
  wood.flipY = false;
  wood.wrapS = wood.wrapT = RepeatWrapping;
  wood.needsUpdate = true;
  ice.wrapS = ice.wrapT = RepeatWrapping;
  caveLight.tWood.value = wood;
  caveLight.tIce.value = ice;
  iceFine.wrapS = iceFine.wrapT = RepeatWrapping;
  caveLight.tIceFine.value = iceFine;
  await loadVolume(man, origin);

  const statics = new Group();
  statics.name = 'BakedCaveStatics';
  // each region as chunks the frustum can drop, with decimated stand-ins past a few metres (lod_build.py);
  // the single baked mesh when there are none
  const region = async (kind: 'shell' | 'works' | 'debris', r: RegionInfo, albedo: Texture, light: Texture, label: string) => {
    const mat = regionMaterial(kind, r, albedo, light);
    const regionCut = kind === 'works' ? cut : [];
    const chunked = await loadChunked(DIR, kind, mat, { label, cut: regionCut });
    if (chunked) return chunked.group;
    const geo = firstGeometry((await loadGLTF(DIR + r.mesh)).scene)!;
    cutTriangles(geo, regionCut);
    const mesh = new Mesh(geo, mat);
    mesh.name = label;
    mesh.frustumCulled = false;
    return mesh;
  };
  const regions = await Promise.all([
    region('shell', man.shell, shellA, shellL, 'BakedShell'),
    region('works', man.works, worksA, worksL, 'BakedWorks'),
    ...(debris && man.debris ? [region('debris', man.debris, debris[0], debris[1], 'BakedDebris')] : []),
  ]);
  statics.add(...regions);
  statics.add(lanternGlobes(man));

  // the pool: one big quad at the waterline (the shell hides its edges)
  const top = man.chimney;
  // (its centre in world x, z: the bed's depth is measured from there)
  const poolC = new Vector2(origin.x, origin.z - 9);
  // where the shaft (below) lands on the water, and its half-widths there
  const shaftC = new Vector2(top[1] + origin.x, top[2] + origin.z);
  const shaftR = new Vector2(top[3] * 1.1, top[4] * 1.1);
  const poolGeo = new PlaneGeometry(40, 40).rotateX(-Math.PI / 2);
  const bed = new Mesh(new PlaneGeometry(40, 40, 120, 120).rotateX(-Math.PI / 2), poolBedMaterial(poolC, shaftC, shaftR));
  bed.position.set(0, -0.32, -9);
  bed.name = 'PoolBed';
  bed.frustumCulled = false;
  // where it runs in under the foot of the wall, the wall wins (they met at a shallow angle and flickered)
  bed.material.polygonOffset = true;
  bed.material.polygonOffsetFactor = 2;
  bed.material.polygonOffsetUnits = 4;
  statics.add(bed);
  const absorb = new Mesh(poolGeo, poolAbsorbMaterial(poolC));
  absorb.position.set(0, -0.32, -9);
  absorb.name = 'BakedPool';
  absorb.renderOrder = 1;
  statics.add(absorb);
  const pool = new Mesh(poolGeo, poolMaterial(
    new Vector3(top[1] + origin.x, top[0] + 2.6 + origin.y, top[2] + origin.z),
    new Vector2(top[3] * 0.85, top[4] * 0.85),
    poolC,
    shaftC,
    shaftR,
  ));
  pool.position.set(0, -0.32, -9);
  pool.name = 'BakedPool';
  pool.renderOrder = 2;
  statics.add(pool);
  // the sky in the chimney's mouth
  const sky = new Mesh(new PlaneGeometry(2, 2).rotateX(Math.PI / 2), skyMaterial());
  sky.scale.set(top[3] * 0.98, 1, top[4] * 0.98);
  sky.position.set(top[1], top[0] + 2.5, top[2]);
  sky.name = 'ChimneySky';
  statics.add(sky);
  // the column of daylight falling from it
  const shaft = new Mesh(new CylinderGeometry(top[3] * 0.55, top[3] * 1.1, 30, 28, 1, true), shaftMaterial());
  shaft.scale.set(1, 1, top[4] / top[3]);
  shaft.position.set(top[1], top[0] + 2.5 - 15, top[2]);
  shaft.name = 'DaylightShaft';
  shaft.renderOrder = 5;
  statics.add(shaft);

  // machines: one mesh each, in its own frame (the four gondolas share one)
  const machines = new Map<string, Mesh>();
  const machMat = volumeMaterial(machA);
  await Promise.all(
    Object.entries(man.machines.objects).map(async ([name, o]) => {
      const geo = firstGeometry((await loadGLTF(DIR + o.mesh)).scene);
      if (!geo) return;
      const id = name.replace(/^MC_/, '');
      const mesh = new Mesh(geo, machMat);
      mesh.name = `Baked_${id}`;
      machines.set(id, mesh);
    }),
  );
  const deckGeo = lift(firstGeometry((await loadGLTF(DIR + man.deck.mesh)).scene)!, 0.04);
  const glowGeo = new PlaneGeometry(1, 1);
  const ropeGeo = new CylinderGeometry(man.rope.radius, man.rope.radius, 1, 8, 1, true);
  return {
    statics,
    machines,
    deckGeometry: deckGeo,
    deckMaterial: volumeMaterial(deckA, true),
    lampGeometry: lampGeometry(),
    lampMaterial: lampMaterial(),
    glowGeometry: glowGeo,
    glowMaterial: glowMaterial(),
    ropeGeometry: ropeGeo,
    ropeMaterial: ropeMaterial(ropeA, man.rope.lay),
    manifest: man,
    look: new CaveLook(man, origin),
  };
}

/** The baked cave's look, once loaded, and the beacon's fire (0..1), for the scene system to apply. */
export const caveView = {
  look: null as CaveLook | null,
  beacon: 0,
  /** Reused every frame (no allocation): fill it and pass it to look.apply. */
  inputs: { storm: 0, beacon: 0, time: 0, head: new Vector3() } as CaveLookInputs,
};

/**
 * Capture the cave from just above the middle of the pool into a small HDR cube (once, when you come in):
 * the black water and the wet ice reflect it. Ropes, lamps and glows are left out (they move or blink).
 */
export function captureCaveEnv(renderer: WebGLRenderer, scene: Scene, at: Vector3, hide: Object3D[]): void {
  const target = new WebGLCubeRenderTarget(256, { type: HalfFloatType, generateMipmaps: true, minFilter: LinearMipmapLinearFilter });
  const cam = new CubeCamera(0.05, 200, target);
  cam.position.copy(at);
  cam.updateMatrixWorld(true);
  const was = hide.map((o) => o.visible);
  for (const o of hide) o.visible = false;
  caveLight.uEnvOn.value = 0;
  cam.update(renderer, scene);
  hide.forEach((o, i) => (o.visible = was[i]));
  const old = caveLight.tEnv.value;
  caveLight.tEnv.value = target.texture;
  caveLight.uEnvC.value.copy(at);
  caveLight.uEnvOn.value = 1;
  old?.dispose();
}

/* ── the look: channel levels, flicker, glints, and the shared baked terms while inside ─────────── */

export interface CaveLookInputs {
  /** 0 clear .. 1 blizzard outside (the chimney's daylight dims and greys with it). */
  storm: number;
  /** 0..1 the beacon's fire (0 until it is lit). */
  beacon: number;
  /** Seconds. */
  time: number;
  /** The viewer's head, world space. */
  head: Vector3;
}

export class CaveLook {
  private readonly lanterns: Vector3[];
  private readonly beaconAt: Vector3;
  private readonly order: number[];
  private readonly dist: Float32Array;
  private readonly tmp = new Color();
  private readonly floorY: number;

  constructor(man: CaveManifest, origin: Vector3) {
    this.lanterns = man.lanterns.map((p) => new Vector3(p[0], p[1], p[2]).add(origin));
    this.beaconAt = new Vector3(man.beacon[0], man.beacon[1], man.beacon[2]).add(origin);
    this.floorY = origin.y - 2.2;
    caveLight.uLowWet.value = origin.y + POOL_LOCAL_Y;
    this.order = this.lanterns.map((_, i) => i);
    this.dist = new Float32Array(this.lanterns.length);
  }

  apply(i: CaveLookInputs): void {
    const L = caveLight;
    const t = i.time;
    // daylight: an evening sky above the glacier, greyer and dimmer while the storm blows
    const X = CAVE_EXPOSURE;
    const day = (1 - 0.55 * Math.min(1, Math.max(0, i.storm))) * X;
    L.uDayCol.value.copy(DAY_CHROMA).multiplyScalar(day);
    L.uGlowCol.value.copy(GLOW_CHROMA).multiplyScalar(day);
    // lanterns: a slow breath and a faint quiver, all together (one channel)
    const flick = 1 + 0.035 * Math.sin(t * 1.7) + 0.02 * Math.sin(t * 5.3 + 1.1) + 0.012 * Math.sin(t * 13.1);
    L.uLanCol.value.copy(LANTERN_CHROMA).multiplyScalar(flick * X);
    L.uGlobeCol.value.copy(GLOBE_CHROMA).multiplyScalar(flick * X);
    const fire = i.beacon * (1 + 0.08 * Math.sin(t * 7.3) + 0.05 * Math.sin(t * 11.7 + 2.0));
    L.uBeaCol.value.copy(BEACON_CHROMA).multiplyScalar(fire * X);
    // the warmth runs down from the brazier to the pool over the first moments of the fire
    L.uBeaFront.value = this.beaconAt.y + 2 - Math.min(1, i.beacon * 1.15) * (this.beaconAt.y + 10 - this.floorY);
    L.uCaveTime.value = t;
    // the nearest lanterns glint on the ice and in the pool (the beacon too once it burns)
    const n = this.lanterns.length;
    for (let k = 0; k < n; k++) this.dist[k] = this.lanterns[k].distanceToSquared(i.head);
    // insertion sort by distance (no allocation; the order barely changes frame to frame)
    const o = this.order;
    for (let k = 1; k < n; k++) {
      const v = o[k];
      let j = k - 1;
      while (j >= 0 && this.dist[o[j]] > this.dist[v]) {
        o[j + 1] = o[j];
        j--;
      }
      o[j + 1] = v;
    }
    for (let k = 0; k < GLINTS; k++) {
      const g = L.uGlints.value[k];
      if (k === GLINTS - 1 && i.beacon > 0.01) {
        g.set(this.beaconAt.x, this.beaconAt.y + 0.2, this.beaconAt.z, 5.6 * fire);
      } else if (k < n) {
        const p = this.lanterns[this.order[k]];
        // in the bake's units: a 12 W lantern gives L = 0.304 / r^2
        g.set(p.x, p.y, p.z, 0.304 * flick);
      } else g.w = 0;
    }
    // things not in the bake (the glider parts, the torch, the hands' gear) are lit by the shared baked
    // terms: no sun in here, a dim cold ambient, and the nearest lantern as the "fire"
    const B = bakedLight;
    B.uCaveOn.value = 1;
    B.uSunColor.value.setRGB(0, 0, 0);
    this.tmp.copy(DAY_CHROMA);
    B.uSkyTint.value.copy(this.tmp);
    B.uSkyGain.value = 0.0025 * day + 0.02;
    B.uOpenSky.value = 1;
    B.uOpenSun.value = 0;
    B.uHaze.value.set(1e6, 0);
    const near = this.lanterns[this.order[0]];
    if (near) B.uFire.value.set(near.x, near.y, near.z, 10 * flick);
    if (i.beacon > 0.01 && this.beaconAt.distanceToSquared(i.head) < 36) {
      B.uFire.value.set(this.beaconAt.x, this.beaconAt.y + 0.3, this.beaconAt.z, 60 * fire);
    }
    // about four fifths of a stop over the look-dev grade: in the headset the timber in the shadows read too dark
    bakedView.exposure = CAVE_VIEW_EXPOSURE;
  }
}

