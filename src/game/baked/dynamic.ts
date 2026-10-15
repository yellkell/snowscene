/**
 * Things that move (held gear, the glider, kit parts): not light-baked, but lit by the same terms as the
 * baked world. Albedo and an AO / roughness map come from their Cycles bake (art/scripts/gear_bake.py);
 * metalness and fabric translucency from a vertex colour. Diffuse is dynamicLight (sky over snow, the sun
 * as it bakes, the snow's bounce, and the ground lightmap's shadow under you); specular reflects the
 * sky's light and glints the sun; thin fabric lets the light behind it through.
 *
 * Gear is preloaded before the world is built (preloadGear), so builders can use it synchronously.
 */

import { Color, type BufferGeometry, type Group, Mesh, ShaderMaterial, type Texture } from '@iwsdk/core';
import { BAKED_GLSL, HAZE_VERT, bakedLight } from './light.js';
import { CAVE_GLSL, caveLight } from '../cave/cave-baked.js';
import { loadGLTF, loadJSON, loadTexture } from './loaders.js';
import { firstGeometry } from './survivors-arena.js';

const VERT = /* glsl */ `
  ${HAZE_VERT}
  attribute vec4 color;
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vW;
  varying float vMetal;
  varying float vTrans;
  void main() {
    vUv = uv;
    vMetal = color.r;
    vTrans = color.g;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vW = wp.xyz;
    vN = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
    computeHaze(wp.xyz);
  }`;

const FRAG = /* glsl */ `
  ${BAKED_GLSL}
  ${CAVE_GLSL}
  uniform sampler2D tAlbedo;
  uniform sampler2D tOrm;
  uniform vec3 uEmissive;
  uniform float uEmissiveIntensity;
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vW;
  varying float vMetal;
  varying float vTrans;
  varying float vHazeF;
  void main() {
    vec3 alb = texture2D(tAlbedo, vUv).rgb;
    vec3 orm = texture2D(tOrm, vUv).rgb;
    float ao = orm.r;
    float rough = clamp(orm.g, 0.05, 1.0);
    float metal = vMetal;
    vec3 n = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0);
    vec3 V = normalize(cameraPosition - vW);
    float sunVis = groundSunVisibility(vW.xz);
    vec3 diffuse;
    if (uCaveOn > 0.5) {
      // in the ice cave: its baked light volume (lanterns, the chimney's daylight, the beacon), sampled a
      // little off the surface, in the cave's own units - the same light the timbers round it were baked in
      vec3 front = caveLight(ambientCube(n, vW + n * 0.12), vW.y);
      vec3 back = caveLight(ambientCube(-n, vW - n * 0.12), vW.y);
      diffuse = alb * (1.0 - metal) * front * ao + alb * vTrans * back * ao;
    } else {
      diffuse = alb * (1.0 - metal) * (dynamicLight(n, ao, sunVis) + fireLight(vW, n) * ao);
      // thin fabric: the light behind it comes through (the sail glows against a low sun)
      diffuse += alb * vTrans * (dynamicLight(-n, ao, sunVis) + uSunColor * uOpenSun / max(uSunDir.y, 0.05) * pow(max(dot(-V, uSunDir), 0.0), 3.0) * sunVis);
    }
    // specular: the sky above, the bright snow below, and the sun
    vec3 R = reflect(-V, n);
    vec3 skyR = uOpenSky * uSkyTint * uSkyGain * (0.6 + 0.4 * R.y);
    vec3 snowR = uSnowAlbedo * (uOpenSky * uSkyTint * uSkyGain + uOpenSun * uSunColor);
    vec3 env = mix(snowR, skyR, smoothstep(-0.15, 0.2, R.y)) * ao;
    vec3 F0 = mix(vec3(0.04), alb, metal);
    float fres = pow(1.0 - max(dot(n, V), 0.0), 5.0);
    float gloss = 1.0 - rough;
    vec3 F = F0 + (1.0 - F0) * fres * gloss;
    vec3 spec = F * env * gloss;
    float sp = pow(max(dot(R, uSunDir), 0.0), mix(8.0, 1800.0, gloss * gloss));
    spec += F * uSunColor * uOpenSun / max(uSunDir.y, 0.05) * sp * sunVis * gloss * 4.0;
    // a gameplay glow (kit parts you can pick up), in the scene's light units
    vec3 glow = uEmissive * uEmissiveIntensity * (uOpenSky * uSkyGain + 0.05) * 0.6;
    vec3 col = applyHaze(diffuse + spec + glow, vHazeF);
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

/** The gear material. Clones keep the shared light uniforms shared (and their own glow). */
export class DynamicMaterial extends ShaderMaterial {
  /** Like MeshStandardMaterial's: what glows, and how much. */
  readonly emissive = new Color(0, 0, 0);

  constructor(
    private readonly albedo: Texture,
    private readonly orm: Texture,
  ) {
    super({ vertexShader: VERT, fragmentShader: FRAG, fog: false });
    this.uniforms = {
      ...bakedLight,
      ...caveLight,
      tAlbedo: { value: albedo },
      tOrm: { value: orm },
      uEmissive: { value: this.emissive },
      uEmissiveIntensity: { value: 0 },
    } as unknown as typeof this.uniforms;
  }

  get emissiveIntensity(): number {
    return (this.uniforms?.uEmissiveIntensity?.value as number) ?? 0;
  }

  set emissiveIntensity(v: number) {
    if (this.uniforms?.uEmissiveIntensity) this.uniforms.uEmissiveIntensity.value = v;
  }

  // @ts-expect-error -- three's clone() returns `this`; a fresh DynamicMaterial is that type
  clone(): DynamicMaterial {
    const m = new DynamicMaterial(this.albedo, this.orm);
    m.emissive.copy(this.emissive);
    m.emissiveIntensity = this.emissiveIntensity;
    m.side = this.side;
    return m;
  }
}

interface GearInfo {
  mesh: string;
  albedo: string;
  orm: string;
}

export interface Gear {
  geometry: BufferGeometry;
  material: DynamicMaterial;
}

const ready = new Map<string, Gear>();
let loading: Promise<void> | null = null;

/** Load every baked gear item (public/gear/). Call before the world is built. */
export function preloadGear(): Promise<void> {
  if (!loading) {
    loading = (async () => {
      const man = await loadJSON<Record<string, GearInfo>>('gear/manifest.json');
      // parts of one thing (a figure's body and arms) share their textures, and so one material
      const textures = new Map<string, Promise<Texture>>();
      const tex = (path: string, color: boolean) => {
        if (!textures.has(path)) {
          textures.set(
            path,
            loadTexture('gear/' + path, color, 8).then((t) => {
              // Blender's writer saves these top-down already (glTF convention), unlike encode.py's arrays
              t.flipY = false;
              return t;
            }),
          );
        }
        return textures.get(path)!;
      };
      const materials = new Map<string, DynamicMaterial>();
      await Promise.all(
        Object.entries(man).map(async ([name, g]) => {
          const [gltf, alb, orm] = await Promise.all([loadGLTF('gear/' + g.mesh), tex(g.albedo, true), tex(g.orm, false)]);
          const key = g.albedo + '|' + g.orm;
          if (!materials.has(key)) materials.set(key, new DynamicMaterial(alb, orm));
          const geometry = firstGeometry(gltf.scene as unknown as Group);
          if (geometry) ready.set(name, { geometry, material: materials.get(key)! });
        }),
      );
    })().catch((e) => console.error('gear failed to load', e));
  }
  return loading;
}

/** A preloaded gear item, or null (then callers keep their procedural stand-in). */
export function gear(name: string): Gear | null {
  return ready.get(name) ?? null;
}

/** Give a procedural mesh its baked gear, if loaded. */
export function upgradeMesh(mesh: Mesh, name: string): void {
  const g = gear(name);
  if (!g) return;
  mesh.geometry = g.geometry;
  mesh.material = g.material;
}
