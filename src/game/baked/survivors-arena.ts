/**
 * The Snow Survivors arena, from the Blender bake (art/scripts/survivors_bake.py
 * -> public/survivors/). Everything is re-lit from the shared bakedLight terms:
 *
 * - sky: the photographed sunset (sun painted out) on a dome, with the sun drawn
 *   back in at the baked sun's direction.
 * - ground: the game's own ground mesh (duneHeight), lit by the baked lightmap
 *   (sun, sky, scour) with a scanned snow normal for micro relief and glints.
 * - forest: every spruce as an impostor (16 headings x 3 elevations, rendered in
 *   Cycles lit by the sun alone and the sky alone); the nearest swap to real
 *   geometry with per-vertex baked light.
 * - props: rocks, logs and stumps in one atlas-baked mesh.
 */

import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  PlaneGeometry,
  RepeatWrapping,
  ShaderMaterial,
  SphereGeometry,
  UniformsUtils,
  Vector3,
  Vector4,
  type Side,
  type Texture,
} from '@iwsdk/core';
import { loadChunked } from './lod.js';
import { BAKED_GLSL, HAZE_VERT, bakedLight, bakedView } from './light.js';
import { loadGLTF, loadJSON, loadTexture } from './loaders.js';

interface VariantInfo {
  mesh: string;
  rect: { x: number; y: number; w: number; h: number };
  frame: [number, number];
  yaws: number;
  elevs: number[];
  width: number;
  height: number;
  centre_y: number;
  ortho: number[];
  tris: number;
  light_max: { sun: number; sky: number };
}

export interface SurvivorsManifest {
  ground?: { lightmap: string; extent: number; sun_max: number; sky_max: number; open_sun?: number; open_sky?: number };
  props?: { mesh: string; albedo: string; light: string; sun_max: number; sky_max: number };
  trees?: {
    atlas_sun: string;
    atlas_sky: string;
    atlas_size: [number, number];
    sun_max: number;
    sky_max: number;
    variants: Record<string, VariantInfo>;
    instances: [string, number, number, number, number][];
  };
  skies?: Record<string, SkyInfo>;
  sky?: {
    texture: string;
    max: number;
    lat_min_deg: number;
    irradiance_rgb: number[];
    sun_irradiance: number;
    sun_color: number[];
    sun_azim_deg: number;
    sun_elev_deg: number;
    horizon_rgb?: number[];
  };
}

interface SkyInfo {
  texture: string;
  max: number;
  lat_min_deg: number;
  horizon_rgb: number[];
  irradiance_rgb: number[];
  sun_irradiance: number;
  sun_color: number[];
}

const DIR = 'survivors/';

/** Sun direction (game space, toward the sun) from the bake's Blender azimuth/elevation. */
export function sunDirection(azimDeg: number, elevDeg: number, out: Vector3): Vector3 {
  const az = (azimDeg * Math.PI) / 180;
  const el = (elevDeg * Math.PI) / 180;
  // Blender (x, y, z) -> game (x, z, -y)
  return out.set(Math.cos(el) * Math.cos(az), Math.sin(el), -Math.cos(el) * Math.sin(az)).normalize();
}

/** Point the shared light at this bake's sun and sky. */
export function applySurvivorsLight(man: SurvivorsManifest): void {
  const s = man.sky;
  if (!s) return;
  sunDirection(s.sun_azim_deg, s.sun_elev_deg, bakedLight.uSunDir.value);
  const c = s.sun_color;
  bakedLight.uSunColor.value.setRGB(c[0], c[1], c[2]).multiplyScalar(s.sun_irradiance);
  const e = s.irradiance_rgb;
  const lum = e[0] * 0.2126 + e[1] * 0.7152 + e[2] * 0.0722;
  bakedLight.uSkyTint.value.setRGB(e[0] / lum, e[1] / lum, e[2] / lum);
  bakedLight.uSkyGain.value = 1;
  if (s.horizon_rgb) bakedLight.uHazeColor.value.setRGB(s.horizon_rgb[0], s.horizon_rgb[1], s.horizon_rgb[2]);
}

// ---------------------------------------------------------------- shaders
const FOG_V = HAZE_VERT;

export function material(params: {
  uniforms: Record<string, { value: unknown }>;
  vertexShader: string;
  fragmentShader: string;
  fog?: boolean;
  side?: Side;
  alphaToCoverage?: boolean;
}): ShaderMaterial {
  const m = new ShaderMaterial({
    uniforms: UniformsUtils.clone(params.uniforms),
    vertexShader: params.vertexShader,
    fragmentShader: params.fragmentShader,
    fog: false,
  });
  if (params.side !== undefined) m.side = params.side;
  // Keep the shared light objects shared (merge() clones them).
  for (const k of Object.keys(bakedLight)) (m.uniforms as Record<string, unknown>)[k] = (bakedLight as Record<string, unknown>)[k];
  for (const [k, v] of Object.entries(params.uniforms)) m.uniforms[k] = v as { value: unknown };
  if (params.alphaToCoverage) m.alphaToCoverage = true;
  return m;
}

// ---------------------------------------------------------------- sky
export interface SkyDome {
  mesh: Mesh;
  uniforms: {
    tSkyA: { value: Texture };
    tSkyB: { value: Texture };
    uMaxA: { value: number };
    uMaxB: { value: number };
    uBlend: { value: number };
    uSunVis: { value: number };
    uSunElev: { value: number };
    uSkyFog: { value: number };
  };
}

export function buildSky(tex: Texture, maxv: number, latMinDeg: number): SkyDome {
  const m = material({
    side: BackSide,
    uniforms: {
      tSkyA: { value: tex },
      tSkyB: { value: tex },
      uMaxA: { value: maxv },
      uMaxB: { value: maxv },
      uBlend: { value: 0 },
      uSunVis: { value: 1 },
      uSunElev: { value: 0.12 },
      uSkyFog: { value: 0 },
      uLatMin: { value: (latMinDeg * Math.PI) / 180 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      ${BAKED_GLSL}
      uniform sampler2D tSkyA;
      uniform sampler2D tSkyB;
      uniform float uMaxA;
      uniform float uMaxB;
      uniform float uBlend;
      uniform float uSunVis;
      uniform float uSunElev;
      uniform float uSkyFog;
      uniform float uLatMin;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float lat = asin(clamp(d.y, -1.0, 1.0));
        float phi = atan(-d.z, d.x);
        vec2 uv = vec2((3.14159265 - phi) / 6.2831853, clamp((lat - uLatMin) / (1.5707963 - uLatMin), 0.002, 0.998));
        vec3 a = decodeLight3(texture2D(tSkyA, uv).rgb, uMaxA);
        vec3 b = decodeLight3(texture2D(tSkyB, uv).rgb, uMaxB);
        vec3 c = mix(a, b, uBlend);
        // The sun, painted out of the photograph, drawn back where it now stands (it sinks through the
        // run): a 0.53 deg disc and a tight aureole, carrying the lamp's light.
        vec3 sd = normalize(normalize(vec3(uSunDir.x, 0.0, uSunDir.z)) * cos(uSunElev) + vec3(0.0, sin(uSunElev), 0.0));
        float cd = dot(d, sd);
        float disc = smoothstep(0.999955, 0.999975, cd) * step(-0.004, d.y);
        c += uSunColor * uSunVis * (disc * 2400.0 + pow(max(cd, 0.0), 900.0) * 3.0);
        // in a whiteout the sky is the storm itself
        c = mix(c, uHazeColor, uSkyFog);
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  m.depthWrite = false;
  const mesh = new Mesh(new SphereGeometry(1000, 64, 32), m);
  // last of the opaque things, at the far plane (xyww): it only shades the pixels nothing else covered,
  // not the whole view under everything (on Quest that's a full extra pass of asin/atan per eye)
  mesh.renderOrder = 1e6;
  mesh.frustumCulled = false;
  mesh.name = 'BakedSky';
  return { mesh, uniforms: m.uniforms as unknown as SkyDome['uniforms'] };
}

// ---------------------------------------------------------------- the evening
/**
 * Through a run the evening falls: golden hour, the sun reddening as it sinks, sunset, two dusks, night.
 * Each key: which photographed sky, how much of the baked sun is left, and the disc's elevation (deg).
 */
const EVENING: Array<{ at: number; sky: string; sun: number; elev: number }> = [
  { at: 0.0, sky: 'sunset', sun: 1.0, elev: 7 },
  { at: 0.38, sky: 'sunset', sun: 0.8, elev: 3.5 },
  { at: 0.52, sky: 'sunset', sun: 0.0, elev: -0.6 },
  { at: 0.62, sky: 'dusk1', sun: 0, elev: -3 },
  { at: 0.8, sky: 'dusk2', sun: 0, elev: -6 },
  { at: 1.0, sky: 'night', sun: 0, elev: -12 },
];

class Evening {
  private readonly lum0: number;
  private readonly tmpA = new Color();
  private readonly tmpB = new Color();

  constructor(
    private readonly skies: Record<string, SkyInfo>,
    private readonly tex: Record<string, Texture>,
    private readonly dome: SkyDome | null,
  ) {
    const e = skies.sunset.irradiance_rgb;
    this.lum0 = e[0] * 0.2126 + e[1] * 0.7152 + e[2] * 0.0722;
  }

  set(p: number): void {
    let i = 0;
    while (i < EVENING.length - 2 && p > EVENING[i + 1].at) i++;
    const a = EVENING[i];
    const b = EVENING[i + 1];
    const t = Math.min(1, Math.max(0, (p - a.at) / (b.at - a.at)));
    const k = t * t * (3 - 2 * t);
    const A = this.skies[a.sky] ?? this.skies.sunset;
    const B = this.skies[b.sky] ?? this.skies.sunset;
    // Sky light: the bakes were lit by the sunset sky; scale and tint toward the sky of the hour.
    const ea = A.irradiance_rgb;
    const eb = B.irradiance_rgb;
    this.tmpA.setRGB(ea[0], ea[1], ea[2]).lerp(this.tmpB.setRGB(eb[0], eb[1], eb[2]), k);
    const lum = this.tmpA.r * 0.2126 + this.tmpA.g * 0.7152 + this.tmpA.b * 0.0722;
    bakedLight.uSkyGain.value = lum / this.lum0;
    bakedLight.uSkyTint.value.copy(this.tmpA).multiplyScalar(1 / Math.max(lum, 1e-9));
    // As the light fails the eye's rods take over (the Purkinje shift): snow under the night sky reads
    // deep blue, not grey.
    const dark = Math.min(1, Math.max(0, Math.log10(this.lum0 / Math.max(lum, 1e-9)) / 1.9));
    bakedLight.uSkyTint.value.lerp(this.tmpB.setRGB(0.55, 0.78, 1.45), dark * 0.85);
    // The sun: dims and reddens as it sinks into the haze, gone at the horizon.
    const sun = a.sun + (b.sun - a.sun) * k;
    const s0 = this.skies.sunset;
    const redden = 1 - sun;
    bakedLight.uSunColor.value
      .setRGB(s0.sun_color[0], s0.sun_color[1] * (1 - 0.35 * redden), s0.sun_color[2] * (1 - 0.6 * redden))
      .multiplyScalar(s0.sun_irradiance * sun);
    // Haze: the horizon of the hour.
    const ha = A.horizon_rgb;
    const hb = B.horizon_rgb;
    bakedLight.uHazeColor.value.setRGB(ha[0], ha[1], ha[2]).lerp(this.tmpB.setRGB(hb[0], hb[1], hb[2]), k);
    // Eyes adapt, but not all the way: night stays night.
    const key = bakedLight.uOpenSky.value * lum + bakedLight.uOpenSun.value * s0.sun_irradiance * sun * 0.5;
    const key0 = bakedLight.uOpenSky.value * this.lum0 + bakedLight.uOpenSun.value * s0.sun_irradiance * 0.5;
    bakedView.exposure = Math.min(30, Math.pow(key0 / Math.max(key, 1e-9), 0.55));
    if (this.dome) {
      const u = this.dome.uniforms;
      u.tSkyA.value = this.tex[a.sky] ?? this.tex.sunset;
      u.tSkyB.value = this.tex[b.sky] ?? this.tex.sunset;
      u.uMaxA.value = A.max;
      u.uMaxB.value = B.max;
      u.uBlend.value = a.sky === b.sky ? 0 : k;
      const elev = a.elev + (b.elev - a.elev) * k;
      u.uSunVis.value = Math.max(0, Math.min(1, (elev + 0.6) / 1.2));
      u.uSunElev.value = (elev * Math.PI) / 180;
    }
  }
}

// ---------------------------------------------------------------- ground
export function bakedGroundMaterial(
  light: Texture,
  detail: Texture,
  g: NonNullable<SurvivorsManifest['ground']>,
  originX: number,
  originZ: number,
): ShaderMaterial {
  detail.wrapS = detail.wrapT = RepeatWrapping;
  return material({
    uniforms: {
      tLight: { value: light },
      tDetail: { value: detail },
      uLM: { value: new Vector4(originX, originZ, g.extent, 0) },
      uSunMax: { value: g.sun_max },
      uSkyMax: { value: g.sky_max },
      uThinTint: { value: new Color(0.42, 0.39, 0.36) },
    },
    vertexShader: /* glsl */ `
      ${FOG_V}
      varying vec3 vWorld;
      varying vec3 vNormalW;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        computeHaze(wp.xyz);
      }`,
    fragmentShader: /* glsl */ `
      ${BAKED_GLSL}
      varying float vHazeF;
      uniform sampler2D tLight;
      uniform sampler2D tDetail;
      uniform vec4 uLM;
      uniform float uSunMax;
      uniform float uSkyMax;
      uniform vec3 uThinTint;
      varying vec3 vWorld;
      varying vec3 vNormalW;
      void main() {
        vec2 rel = vWorld.xz - uLM.xy;
        vec2 uv = vec2((rel.x + uLM.z) / (2.0 * uLM.z), (uLM.z - rel.y) / (2.0 * uLM.z));
        vec3 t = texture2D(tLight, uv).rgb;
        float inside = step(abs(rel.x), uLM.z) * step(abs(rel.y), uLM.z);
        float Ls = decodeLight(t.r, uSunMax) * inside;
        float Lk = mix(0.62, decodeLight(t.g, uSkyMax), inside);
        float clean = mix(1.0, t.b, inside);
        vec3 ng = normalize(vNormalW);
        // Scanned snow relief (2 m tile). OpenGL normal map: +v runs along +z here.
        vec3 nm = texture2D(tDetail, vWorld.xz * 0.5).xyz * 2.0 - 1.0;
        vec3 n = normalize(ng + vec3(nm.x, 0.0, nm.y) * 0.9);
        // The baked sun term already holds the cosine for the smooth surface; re-shade it for the relief,
        // which is what makes wind crust read at a low sun.
        float cg = max(dot(ng, uSunDir), 0.04);
        Ls *= clamp(mix(1.0, max(dot(n, uSunDir), 0.0) / cg, 0.8), 0.0, 2.6);
        vec3 alb = mix(uThinTint, uSnowAlbedo, smoothstep(0.45, 0.95, clean));
        vec3 col = alb * (Ls * uSunColor + Lk * uSkyTint * uSkyGain);
        // Ice-crystal glints: a sparse field of tiny facets that flash toward the sun.
        vec2 cell = floor(vWorld.xz * 38.0);
        float h = hash12(cell);
        if (h > 0.975 && Ls > 0.0) {
          vec3 fn = normalize(vec3(hash12(cell + 7.1) - 0.5, 0.55, hash12(cell + 3.7) - 0.5));
          vec3 V = normalize(cameraPosition - vWorld);
          float s = pow(max(dot(fn, normalize(V + uSunDir)), 0.0), 900.0);
          float fade = 1.0 - smoothstep(6.0, 30.0, length(cameraPosition - vWorld));
          col += uSunColor * (Ls / cg) * s * 60.0 * fade;
        }
        col = applyHaze(col, vHazeF);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

// ---------------------------------------------------------------- forest
const NEAR_RADIUS = 30;
const NEAR_MAX = 28;

export class Forest {
  readonly group = new Group();
  private readonly impostors: Mesh;
  private readonly scaleAttr: InstancedBufferAttribute;
  private readonly scales: Float32Array;
  private readonly near = new Map<string, InstancedMesh>();
  private readonly pos: Float32Array;
  private readonly kind: string[];
  private readonly baseScale: Float32Array;
  private readonly local = new Vector3();
  private readonly m4 = new Matrix4();
  private timer = 0;
  private farOnly = false;

  constructor(
    man: NonNullable<SurvivorsManifest['trees']>,
    atlasSun: Texture,
    atlasSky: Texture,
    lods: Map<string, BufferGeometry>,
    spray: Texture,
  ) {
    const keys = Object.keys(man.variants);
    const index = new Map(keys.map((k, i) => [k, i]));
    const n = man.instances.length;
    this.pos = new Float32Array(n * 3);
    this.scales = new Float32Array(n);
    this.baseScale = new Float32Array(n);
    this.kind = [];
    const varIdx = new Float32Array(n);
    man.instances.forEach(([k, x, y, z, s], i) => {
      this.pos.set([x, y, z], i * 3);
      this.scales[i] = this.baseScale[i] = s;
      varIdx[i] = index.get(k) ?? 0;
      this.kind.push(k);
    });
    const geo = new InstancedBufferGeometry();
    const quad = new PlaneGeometry(1, 1);
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('iPos', new InstancedBufferAttribute(this.pos, 3));
    this.scaleAttr = new InstancedBufferAttribute(this.scales, 1);
    geo.setAttribute('iScale', this.scaleAttr);
    geo.setAttribute('iVar', new InstancedBufferAttribute(varIdx, 1));
    geo.instanceCount = n;
    const rect = keys.map((k) => {
      const r = man.variants[k].rect;
      return new Vector4(r.x, r.y, r.w, r.h);
    });
    const frame = keys.map((k) => {
      const v = man.variants[k];
      return new Vector4(v.frame[0], v.frame[1], v.centre_y, v.yaws);
    });
    const ortho = keys.map((k) => {
      const o = man.variants[k].ortho;
      return new Vector3(o[0], o[1], o[2]);
    });
    const elevs = man.variants[keys[0]].elevs;
    const NV = keys.length;
    const mat = material({
      alphaToCoverage: true,
      uniforms: {
        tSun: { value: atlasSun },
        tSky: { value: atlasSky },
        uAtlas: { value: new Vector3(man.atlas_size[0], man.atlas_size[1], 0) },
        uSunMax: { value: man.sun_max },
        uSkyMax: { value: man.sky_max },
        uRect: { value: rect },
        uFrame: { value: frame },
        uOrtho: { value: ortho },
        uElev: { value: new Vector3(elevs[0], elevs[1], elevs[2]) },
      },
      vertexShader: /* glsl */ `
        ${FOG_V}
        #define NV ${NV}
        attribute vec3 iPos;
        attribute float iScale;
        attribute float iVar;
        uniform vec3 uAtlas;
        uniform vec4 uRect[NV];
        uniform vec4 uFrame[NV];
        uniform vec3 uOrtho[NV];
        uniform vec3 uElev;
        varying vec2 vUv;
        varying vec4 vRect;
        void main() {
          int v = int(iVar + 0.5);
          vec4 rect = uRect[v];
          vec4 fr = uFrame[v];
          vec3 orth = uOrtho[v];
          vec3 centre = (modelMatrix * vec4(iPos + vec3(0.0, fr.z * iScale, 0.0), 1.0)).xyz;
          vec3 d = normalize(cameraPosition - centre);
          float el = degrees(asin(clamp(d.y, -1.0, 1.0)));
          float row = el < (uElev.x + uElev.y) * 0.5 ? 0.0 : (el < (uElev.y + uElev.z) * 0.5 ? 1.0 : 2.0);
          float ortho = row < 0.5 ? orth.x : (row < 1.5 ? orth.y : orth.z);
          float az = atan(-d.z, d.x);
          float yi = mod(floor(az / (6.2831853 / fr.w) + 0.5), fr.w);
          float hgt = ortho * iScale;
          float wid = hgt * fr.x / fr.y;
          vec3 right = normalize(vec3(d.z, 0.0, -d.x));
          vec3 up = cross(d, right);
          vec3 wp = centre + right * (position.x * wid) + up * (position.y * hgt);
          float u0 = rect.x + yi * fr.x;
          float v0 = uAtlas.y - rect.y - rect.w + row * fr.y;
          vUv = vec2((u0 + (position.x + 0.5) * fr.x) / uAtlas.x, (v0 + (position.y + 0.5) * fr.y) / uAtlas.y);
          vRect = vec4(u0 / uAtlas.x, v0 / uAtlas.y, (u0 + fr.x) / uAtlas.x, (v0 + fr.y) / uAtlas.y);
          vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          if (iScale <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          computeHaze(wp.xyz);
        }`,
      fragmentShader: /* glsl */ `
        ${BAKED_GLSL}
        varying float vHazeF;
        uniform sampler2D tSun;
        uniform sampler2D tSky;
        uniform float uSunMax;
        uniform float uSkyMax;
        uniform vec3 uAtlas;
        varying vec2 vUv;
        varying vec4 vRect;
        void main() {
          // the frames sit edge to edge: keep the filter footprint of the mip being sampled inside this
          // frame, or the neighbour's snow base bleeds in round the tips at distance
          vec2 px = fwidth(vUv) * uAtlas.xy;
          vec2 m = exp2(max(0.0, log2(max(px.x, px.y)))) * 0.5 / uAtlas.xy;
          vec2 uv = clamp(vUv, vRect.xy + m, vRect.zw - m);
          vec4 s = texture2D(tSun, uv);
          if (s.a < 0.08) discard;
          vec3 k = texture2D(tSky, uv).rgb;
          vec3 col = decodeLight3(s.rgb, uSunMax) * uSunColor + decodeLight3(k, uSkyMax) * uSkyGain;
          // sharpen the coverage so the needle fringe stays crisp under MSAA
          col = applyHaze(col, vHazeF);
          gl_FragColor = vec4(col, clamp((s.a - 0.35) / fwidth(s.a) * 0.5 + 0.5, 0.0, 1.0));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          }`,
    });
    this.impostors = new Mesh(geo, mat);
    this.impostors.frustumCulled = false;
    this.impostors.name = 'ForestImpostors';
    this.group.add(this.impostors);

    // Near trees: real geometry with per-vertex baked light.
    spray.wrapS = spray.wrapT = RepeatWrapping;
    // a plain image under glTF UVs: top row is v = 0
    spray.flipY = false;
    spray.needsUpdate = true;
    for (const k of keys) {
      const g = lods.get(k);
      if (!g) continue;
      const lm = man.variants[k].light_max;
      const m = material({
        alphaToCoverage: true,
        side: DoubleSide,
        uniforms: { tSpray: { value: spray }, uLSun: { value: lm.sun }, uLSky: { value: lm.sky } },
        vertexShader: /* glsl */ `
          ${FOG_V}
          attribute vec4 color;
          varying vec4 vC;
          varying vec2 vUv;
          varying vec3 vN;
          varying vec3 vW;
          void main() {
            vC = color;
            vUv = uv;
            mat4 mw = modelMatrix * instanceMatrix;
            vN = normalize(mat3(mw) * normal);
            vec4 wp = mw * vec4(position, 1.0);
            vW = wp.xyz;
            vec4 mvPosition = viewMatrix * wp;
            gl_Position = projectionMatrix * mvPosition;
            computeHaze(wp.xyz);
          }`,
        fragmentShader: /* glsl */ `
          ${BAKED_GLSL}
          varying float vHazeF;
          uniform sampler2D tSpray;
          uniform float uLSun;
          uniform float uLSky;
          varying vec4 vC;
          varying vec2 vUv;
          varying vec3 vN;
          varying vec3 vW;
          void main() {
            float kind = vC.a * 2.0;
            vec3 alb;
            float a = 1.0;
            if (kind < 0.5) {
              vec4 t = texture2D(tSpray, vUv);
              a = t.a;
              if (a < 0.08) discard;
              // the spray texture carries the same winter grade as the Cycles material
              alb = t.rgb;
              // snow held in the sprays' upper faces; a little more than the impostor's needles carry,
              // standing in for the fused snow ridges this LOD leaves out
              float up = smoothstep(0.1, 0.6, normalize(vN).y) * (gl_FrontFacing ? 1.0 : 0.0);
              float speck = hash12(floor(vW.xz * 22.0) + floor(vW.y * 22.0));
              float held = up * smoothstep(0.35, 0.8, vC.b + speck * 0.6);
              alb = mix(alb, uSnowAlbedo, held);
            } else if (kind < 1.5) {
              alb = vec3(0.09, 0.075, 0.065);
            } else {
              alb = uSnowAlbedo;
            }
            float Ls = decodeLight(vC.r, uLSun);
            float Lk = decodeLight(vC.g, uLSky);
            vec3 col = alb * (Ls * uSunColor + Lk * uSkyTint * uSkyGain);
            col = applyHaze(col, vHazeF);
            gl_FragColor = vec4(col, clamp((a - 0.35) / max(fwidth(a), 1e-4) * 0.5 + 0.5, 0.0, 1.0));
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
              }`,
      });
      const im = new InstancedMesh(g, m, NEAR_MAX);
      im.count = 0;
      im.frustumCulled = false;
      im.name = `NearSpruce_${k}`;
      this.near.set(k, im);
      this.group.add(im);
    }
  }

  /**
   * Swap the trees nearest `head` (world) to real geometry, a few times a second; `farOnly` keeps every
   * tree on its stand-in (flying over them, the swaps read as trees popping).
   */
  update(dt: number, head: Vector3, farOnly = false): void {
    this.timer -= dt;
    if (this.timer > 0 && farOnly === this.farOnly) return;
    this.farOnly = farOnly;
    this.timer = 0.2;
    this.group.worldToLocal(this.local.copy(head));
    const r2 = farOnly ? 0 : NEAR_RADIUS * NEAR_RADIUS;
    for (const im of this.near.values()) im.count = 0;
    const n = this.baseScale.length;
    let changed = false;
    for (let i = 0; i < n; i++) {
      const dx = this.pos[i * 3] - this.local.x;
      const dz = this.pos[i * 3 + 2] - this.local.z;
      const close = dx * dx + dz * dz < r2;
      let want = this.baseScale[i];
      if (close) {
        const im = this.near.get(this.kind[i]);
        if (im && im.count < NEAR_MAX) {
          const s = this.baseScale[i];
          this.m4.makeScale(s, s, s).setPosition(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
          im.setMatrixAt(im.count++, this.m4);
          want = 0;
        }
      }
      if (this.scales[i] !== want) {
        this.scales[i] = want;
        changed = true;
      }
    }
    for (const im of this.near.values()) im.instanceMatrix.needsUpdate = true;
    if (changed) this.scaleAttr.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- props
export function buildProps(geo: BufferGeometry, albedo: Texture, light: Texture, p: { sun_max: number; sky_max: number }): Mesh {
  const mesh = new Mesh(geo, propsMaterial(albedo, light, p));
  mesh.name = 'Props';
  return mesh;
}

/** The atlas-baked layers' material (one per atlas, shared by all of its chunks). */
export function propsMaterial(albedo: Texture, light: Texture, p: { sun_max: number; sky_max: number }): ShaderMaterial {
  // encode.py writes atlases top row first (v = 1), the glTF convention: sample them unflipped
  albedo.flipY = light.flipY = false;
  albedo.needsUpdate = light.needsUpdate = true;
  return material({
    uniforms: { tAlbedo: { value: albedo }, tLight: { value: light }, uSunMax: { value: p.sun_max }, uSkyMax: { value: p.sky_max } },
    vertexShader: /* glsl */ `
      ${FOG_V}
      varying vec2 vUv;
      varying vec3 vW;
      varying vec3 vN;
      void main() {
        vUv = uv;
        vec4 lp = vec4(position, 1.0);
        vec3 ln = normal;
        #ifdef USE_INSTANCING
          lp = instanceMatrix * lp;
          ln = mat3(instanceMatrix) * ln;
        #endif
        vec4 wp = modelMatrix * lp;
        vW = wp.xyz;
        vN = normalize(mat3(modelMatrix) * ln);
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        computeHaze(wp.xyz);
      }`,
    fragmentShader: /* glsl */ `
      ${BAKED_GLSL}
      varying float vHazeF;
      uniform sampler2D tAlbedo;
      uniform sampler2D tLight;
      uniform float uSunMax;
      uniform float uSkyMax;
      varying vec2 vUv;
      varying vec3 vW;
      varying vec3 vN;
      void main() {
        vec3 alb = texture2D(tAlbedo, vUv).rgb;
        vec3 t = texture2D(tLight, vUv).rgb;
        float Lk = decodeLight(t.g, uSkyMax);
        // firelight, dimmed where the sky bake says the surface is tucked away (a stand-in for its shadow)
        float open = sqrt(clamp(Lk / max(uOpenSky, 1e-3), 0.0, 1.0));
        vec3 n = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0);
        vec3 col = alb * (decodeLight(t.r, uSunMax) * uSunColor + Lk * uSkyTint * uSkyGain + fireLight(vW, n) * open);
        col = applyHaze(col, vHazeF);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

// ---------------------------------------------------------------- the arena
export interface BakedArena {
  /** Arena-relative content (place at the arena origin). */
  group: Group;
  /** World-space sky dome; keep centred on the head. */
  sky: Mesh | null;
  /** Ground material for the game's ground mesh, if the bake has one. */
  groundMaterial: ShaderMaterial | null;
  /** `progress` 0..1 through the run: the evening falls with it. */
  update(dt: number, head: Vector3, progress: number): void;
}

/** The first mesh's geometry with its node transform baked in (glTF nodes carry the object's transform). */
export function firstGeometry(root: Group): BufferGeometry | null {
  let g: BufferGeometry | null = null;
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const m = o as Mesh;
    if (!g && m.isMesh) g = (m.geometry as BufferGeometry).clone().applyMatrix4(m.matrixWorld);
  });
  return g;
}

/** Load everything the bake produced. Missing parts are simply skipped. */
export async function loadSurvivorsArena(originX: number, originZ: number): Promise<BakedArena> {
  const man = await loadJSON<SurvivorsManifest>(`${DIR}manifest.json`);
  applySurvivorsLight(man);
  const group = new Group();
  group.name = 'BakedArena';
  let sky: Mesh | null = null;
  let groundMaterial: ShaderMaterial | null = null;
  let forest: Forest | null = null;
  const jobs: Promise<void>[] = [];
  const skyTex: Record<string, Texture> = {};
  let dome: SkyDome | null = null;
  const skies = man.skies;
  if (skies?.sunset) {
    jobs.push(
      Promise.all(
        Object.entries(skies).map(async ([k, s]) => {
          skyTex[k] = await loadTexture(DIR + s.texture, false, 1);
        }),
      ).then(() => {
        dome = buildSky(skyTex.sunset, skies.sunset.max, skies.sunset.lat_min_deg);
        sky = dome.mesh;
      }),
    );
  }
  if (man.ground) {
    const g = man.ground;
    jobs.push(
      Promise.all([loadTexture(DIR + g.lightmap, false, 8), loadTexture('textures/snow_detail_nor.webp', false, 8)]).then(
        ([l, d]) => {
          groundMaterial = bakedGroundMaterial(l, d, g, originX, originZ);
          bakedLight.uGroundLight.value = l;
          bakedLight.uGroundLM.value.set(originX, originZ, g.extent, g.sun_max);
          if (g.open_sun) bakedLight.uOpenSun.value = g.open_sun;
          if (g.open_sky) bakedLight.uOpenSky.value = g.open_sky;
        },
      ),
    );
  }
  if (man.props) {
    const p = man.props;
    jobs.push(
      (async () => {
        const [a, l] = await Promise.all([loadTexture(DIR + p.albedo, true), loadTexture(DIR + p.light, false)]);
        // as chunks with distance stand-ins (lod_build.py), else the one baked mesh
        const mat = propsMaterial(a, l, p);
        const chunked = await loadChunked(DIR, 'props', mat, { label: 'Props' });
        if (chunked) {
          group.add(chunked.group);
          return;
        }
        const g = firstGeometry((await loadGLTF(DIR + p.mesh)).scene);
        if (g) group.add(new Mesh(g, mat));
      })(),
    );
  }
  if (man.trees) {
    const t = man.trees;
    jobs.push(
      (async () => {
        const [sun, skyT, spray] = await Promise.all([
          loadTexture(DIR + t.atlas_sun, false, 4),
          loadTexture(DIR + t.atlas_sky, false, 4),
          loadTexture('textures/spray.webp', true, 4),
        ]);
        const lods = new Map<string, BufferGeometry>();
        await Promise.all(
          Object.entries(t.variants).map(async ([k, v]) => {
            try {
              const g = firstGeometry((await loadGLTF(DIR + v.mesh)).scene);
              if (g) lods.set(k, g);
            } catch {
              /* a variant without a near mesh just stays an impostor */
            }
          }),
        );
        forest = new Forest(t, sun, skyT, lods, spray);
        group.add(forest.group);
      })(),
    );
  }
  await Promise.all(jobs);
  const evening = skies?.sunset ? new Evening(skies, skyTex, dome) : null;
  evening?.set(0);
  return {
    group,
    sky,
    groundMaterial,
    update(dt: number, head: Vector3, progress: number) {
      bakedLight.uTime.value += dt;
      evening?.set(progress);
      forest?.update(dt, head);
    },
  };
}

