/**
 * The tutorial mountain from the Blender bake (art/scripts/tutorial_bake.py -> public/tutorial/):
 * the bowl's ground in two regions (the trail corridor at a few centimetres, the rest coarser), the
 * climbing wall, the cliff bands, the bluff with the adit, the beacon deck, the huts, the boulders and
 * trail furniture, the ring of ranges round the bowl, the shared spruce forest, and the vista panorama
 * (sky, the great ranges and the sea of clouds).
 *
 * Everything is re-lit by the shared bakedLight terms, which `TutorialLook` drives from the weather:
 * in the blizzard the sun goes out, the sky turns to flat overcast and the haze closes into a whiteout
 * as bright as the snow; above the storm the evening sun comes back.
 */

import {
  BufferGeometry,
  Color,
  Group,
  Mesh,
  type Object3D,
  RepeatWrapping,
  ShaderMaterial,
  type Texture,
  Vector3,
  Vector4,
} from '@iwsdk/core';
import { BAKED_GLSL, HAZE_VERT, bakedLight, bakedView } from './light.js';
import { loadGLTF, loadJSON, loadTexture } from './loaders.js';
import { terrainHeight } from '../terrain.js';
import { fogCullables } from '../fog-cull.js';
import { loadChunked, lodIndex } from './lod.js';
import {
  buildSky,
  firstGeometry,
  Forest,
  material,
  propsMaterial,
  type SkyDome,
  sunDirection,
  type SurvivorsManifest,
} from './survivors-arena.js';

const DIR = 'tutorial/';

interface GroundInfo {
  light: string;
  albedo: string | null;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  sun_max: number;
  sky_max: number;
  open_sun: number;
  open_sky: number;
}

interface AtlasInfo {
  mesh: string;
  albedo: string;
  light: string;
  sun_max: number;
  sky_max: number;
}

export interface TutorialManifest {
  grounds: Record<string, GroundInfo>;
  atlases: Record<string, AtlasInfo>;
  cabins: [number, number, number][];
  trees: { shared: string; instances: [string, number, number, number, number][] };
  vista?: { texture: string; max: number; lat_min_deg: number; horizon_rgb: number[] };
  sun: { azim_deg: number; elev_deg: number };
  sky: { irradiance?: number; color?: number[]; hid?: string };
}

// ---------------------------------------------------------------- ground (two regions)
function groundMaterial(
  g: GroundInfo,
  t: GroundInfo,
  tex: { gl: Texture; ga: Texture; tl: Texture; ta: Texture; detail: Texture },
): ShaderMaterial {
  tex.detail.wrapS = tex.detail.wrapT = RepeatWrapping;
  return material({
    uniforms: {
      tGL: { value: tex.gl },
      tGA: { value: tex.ga },
      tTL: { value: tex.tl },
      tTA: { value: tex.ta },
      tDetail: { value: tex.detail },
      uG: { value: new Vector4(g.x0, g.x1, g.z0, g.z1) },
      uT: { value: new Vector4(t.x0, t.x1, t.z0, t.z1) },
      uGMax: { value: new Vector3(g.sun_max, g.sky_max, 0) },
      uTMax: { value: new Vector3(t.sun_max, t.sky_max, 0) },
    },
    vertexShader: /* glsl */ `
      ${HAZE_VERT}
      varying vec3 vWorld;
      varying vec3 vNormalW;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
        computeHaze(wp.xyz);
      }`,
    fragmentShader: /* glsl */ `
      ${BAKED_GLSL}
      uniform sampler2D tGL;
      uniform sampler2D tGA;
      uniform sampler2D tTL;
      uniform sampler2D tTA;
      uniform sampler2D tDetail;
      uniform vec4 uG;
      uniform vec4 uT;
      uniform vec3 uGMax;
      uniform vec3 uTMax;
      varying vec3 vWorld;
      varying vec3 vNormalW;
      varying float vHazeF;
      // region uv: u along +x, v along -z (Blender +y); rows bottom-up (three's flipY)
      vec2 regionUv(vec4 r) { return vec2((vWorld.x - r.x) / (r.y - r.x), (r.w - vWorld.z) / (r.w - r.z)); }
      void main() {
        vec2 ut = regionUv(uT);
        bool trail = all(greaterThan(ut, vec2(0.002))) && all(lessThan(ut, vec2(0.998)));
        vec3 l;
        vec3 alb;
        if (trail) {
          vec3 t = texture2D(tTL, ut).rgb;
          l = vec3(decodeLight(t.r, uTMax.x), decodeLight(t.g, uTMax.y), 0.0);
          alb = texture2D(tTA, ut).rgb;
        } else {
          vec2 ug = regionUv(uG);
          vec3 t = texture2D(tGL, ug).rgb;
          l = vec3(decodeLight(t.r, uGMax.x), decodeLight(t.g, uGMax.y), 0.0);
          alb = texture2D(tGA, ug).rgb;
        }
        vec3 ng = normalize(vNormalW);
        vec3 nm = texture2D(tDetail, vWorld.xz * 0.5).xyz * 2.0 - 1.0;
        vec3 n = normalize(ng + vec3(nm.x, 0.0, nm.y) * 0.8);
        float cg = max(dot(ng, uSunDir), 0.04);
        float Ls = l.x * clamp(mix(1.0, max(dot(n, uSunDir), 0.0) / cg, 0.8), 0.0, 2.6);
        vec3 col = alb * (Ls * uSunColor + l.y * uSkyTint * uSkyGain + fireLight(vWorld, n));
        vec2 cell = floor(vWorld.xz * 38.0);
        if (hash12(cell) > 0.975 && Ls > 0.0) {
          vec3 fn = normalize(vec3(hash12(cell + 7.1) - 0.5, 0.55, hash12(cell + 3.7) - 0.5));
          vec3 V = normalize(cameraPosition - vWorld);
          float s = pow(max(dot(fn, normalize(V + uSunDir)), 0.0), 900.0);
          col += uSunColor * (Ls / cg) * s * 60.0 * (1.0 - smoothstep(6.0, 30.0, length(cameraPosition - vWorld)));
        }
        col = applyHaze(col, vHazeF);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

// ---------------------------------------------------------------- the look: weather -> light
export interface TutorialLookInputs {
  /** 0 clear .. 1 blizzard (the weather's smoothed storm level). */
  storm: number;
  /** The weather's fog distance (m). */
  fogFar: number;
  /** 0 outdoors .. 1 inside the cave. */
  indoors: number;
}

const OVERCAST = new Color(1.0, 1.02, 1.07);

export class TutorialLook {
  private readonly clearTint = new Color();
  private readonly clearHaze = new Color();
  private readonly sunColor = new Color();
  private readonly tmp = new Color();
  private readonly sunDir = new Vector3();

  constructor(
    man: TutorialManifest,
    private readonly ground: GroundInfo,
    private readonly groundLight: Texture,
    private readonly dome: SkyDome | null,
  ) {
    sunDirection(man.sun.azim_deg, man.sun.elev_deg, this.sunDir);
    const sky = man.sky as unknown as { irradiance: number; color: number[] };
    this.sunColor.setRGB(sky.color?.[0] ?? 1, sky.color?.[1] ?? 0.6, sky.color?.[2] ?? 0.3).multiplyScalar(sky.irradiance ?? 3);
    const h = man.vista?.horizon_rgb ?? [1.2, 1.1, 1.0];
    this.clearHaze.setRGB(h[0], h[1], h[2]);
    // the sunset sky's light on a level surface, as a tint (survivors' bake measured the same sky)
    this.clearTint.setRGB(0.81, 1.05, 1.49);
  }

  apply(i: TutorialLookInputs): void {
    const L = bakedLight;
    // out on the mountain, moving things are lit by these terms, not the cave's light volume (which is
    // black outside its bounds); the cave's look raises the flag again every frame you're inside it
    if (i.indoors < 0.5) L.uCaveOn.value = 0;
    const s = Math.min(1, Math.max(0, (i.storm - 0.08) / 0.45));
    const k = s * s * (3 - 2 * s);
    L.uSunDir.value.copy(this.sunDir);
    L.uSunColor.value.copy(this.sunColor).multiplyScalar(1 - k);
    L.uSkyTint.value.copy(this.clearTint).lerp(OVERCAST, k);
    L.uSkyGain.value = 1 - 0.3 * k;
    L.uOpenSun.value = this.ground.open_sun;
    L.uOpenSky.value = this.ground.open_sky;
    L.uGroundLight.value = this.groundLight;
    const g = this.ground;
    L.uGroundLM.value.set((g.x0 + g.x1) / 2, (g.z0 + g.z1) / 2, (g.x1 - g.x0) / 2, g.sun_max);
    // the whiteout glows as bright as the snow under the same overcast
    this.tmp.copy(L.uSkyTint.value).multiplyScalar(L.uOpenSky.value * L.uSkyGain.value * 0.9);
    L.uHazeColor.value.copy(this.clearHaze).lerp(this.tmp, k);
    L.uHaze.value.set(Math.max(12, i.fogFar * 0.42), 0.85 + 0.15 * k);
    if (this.dome) this.dome.uniforms.uSkyFog.value = Math.min(1, k * 1.15);
    // eyes adapt to the dim storm a little
    bakedView.exposure = 1 + 0.35 * k;
  }
}

// ---------------------------------------------------------------- load
export interface TutorialWorld {
  group: Group;
  sky: Mesh | null;
  groundMaterial: ShaderMaterial;
  /** The beacon deck (shown once you come up the chimney). */
  deck: Mesh | null;
  /** The lake party's camp in party space (shown when the fire is lit). */
  party: Object3D | null;
  look: TutorialLook;
  /** `farOnly`: the forest stays on its stand-ins (the launch and the glide). */
  update(dt: number, head: Vector3, farOnly?: boolean): void;
}

export async function loadTutorialWorld(): Promise<TutorialWorld> {
  const man = await loadJSON<TutorialManifest>(`${DIR}manifest.json`);
  const g = man.grounds.ground;
  const t = man.grounds.trail;
  const [gl, ga, tl, ta, detail] = await Promise.all([
    loadTexture(DIR + g.light, false, 8),
    loadTexture(DIR + g.albedo!, true, 8),
    loadTexture(DIR + t.light, false, 8),
    loadTexture(DIR + t.albedo!, true, 8),
    loadTexture('textures/snow_detail_nor.webp', false, 8),
  ]);
  const groundMat = groundMaterial(g, t, { gl, ga, tl, ta, detail });
  const group = new Group();
  group.name = 'BakedTutorial';
  let deck: Mesh | null = null;
  let party: Object3D | null = null;
  const lods = await lodIndex(DIR);
  await Promise.all(
    Object.entries(man.atlases).map(async ([name, a]) => {
      const [alb, light] = await Promise.all([loadTexture(DIR + a.albedo, true), loadTexture(DIR + a.light, false)]);
      const mat = propsMaterial(alb, light, a);
      if (name === 'hut') {
        // one baked hut, standing at each of the three sites (baked in its own space at the base camp;
        // each stands on the ground where the game puts it), each with its own distance stand-in
        const huts = new Group();
        huts.name = 'Huts';
        const chunked = lods.hut ? await loadChunked(DIR, 'hut', mat, { label: 'Hut' }) : null;
        const geo = chunked ? null : firstGeometry((await loadGLTF(DIR + a.mesh)).scene);
        man.cabins.forEach(([x, z, r], i) => {
          const site = new Group();
          site.name = `Hut${i}`;
          site.position.set(x, terrainHeight(x, z) - 0.08, z);
          site.rotation.y = r;
          if (chunked) {
            for (const chunk of chunked.group.children) {
              const near = chunk.children[0] as Mesh;
              const far = chunk.children[1] as Mesh | undefined;
              const own = new Group();
              own.add(new Mesh(near.geometry, mat));
              if (far) own.add(Object.assign(new Mesh(far.geometry, mat), { visible: false }));
              site.add(own);
              near.geometry.computeBoundingSphere();
              const sph = near.geometry.boundingSphere!;
              fogCullables.push({
                object: own,
                center: sph.center.clone(),
                radius: sph.radius,
                fogScale: 1.6,
                ownLod: true,
                local: { world: new Vector3() },
                lod: far ? { near: [own.children[0]], far: own.children[1], distance: lods.hut.switch } : undefined,
              });
            }
          } else if (geo) site.add(new Mesh(geo, mat));
          huts.add(site);
        });
        if (chunked) for (const c of [...chunked.group.children]) c.removeFromParent();
        group.add(huts);
        return;
      }
      if (name === 'deck') {
        const geo = firstGeometry((await loadGLTF(DIR + a.mesh)).scene);
        if (geo) deck = new Mesh(geo, mat);
        return;
      }
      // as chunks the frustum and the fog can drop, with decimated stand-ins (lod_build.py)
      const chunked = lods[name] ? await loadChunked(DIR, name, mat, { label: `Baked_${name}` }) : null;
      let obj: Object3D;
      if (chunked) obj = chunked.group;
      else {
        const geo = firstGeometry((await loadGLTF(DIR + a.mesh)).scene);
        if (!geo) return;
        obj = new Mesh(geo, mat);
        obj.name = `Baked_${name}`;
      }
      if (name === 'party') {
        // the camp's own visibility follows the fire; its LOD lives on the inner group
        const wrap = new Group();
        wrap.name = 'Baked_party';
        wrap.add(obj);
        party = wrap;
      } else group.add(obj);
    }),
  );
  // the vista: sky, the great ranges and the sea of clouds
  let dome: SkyDome | null = null;
  if (man.vista) {
    const vt = await loadTexture(DIR + man.vista.texture, false, 1);
    dome = buildSky(vt, man.vista.max, man.vista.lat_min_deg);
    dome.uniforms.uSunVis.value = 1;
    dome.uniforms.uSunElev.value = (man.sun.elev_deg * Math.PI) / 180;
  }
  // the forest: the survivors spruce bake, at the tutorial's own tree spots
  const sm = await loadJSON<SurvivorsManifest>(man.trees.shared.replace('../', ''));
  let forest: Forest | null = null;
  if (sm.trees) {
    const tr = sm.trees;
    const [sun, sky, spray] = await Promise.all([
      loadTexture('survivors/' + tr.atlas_sun, false, 4),
      loadTexture('survivors/' + tr.atlas_sky, false, 4),
      loadTexture('textures/spray.webp', true, 4),
    ]);
    const lods = new Map<string, BufferGeometry>();
    await Promise.all(
      Object.entries(tr.variants).map(async ([k, v]) => {
        try {
          const geo = firstGeometry((await loadGLTF('survivors/' + v.mesh)).scene);
          if (geo) lods.set(k, geo);
        } catch {
          /* stays an impostor */
        }
      }),
    );
    forest = new Forest({ ...tr, instances: man.trees.instances }, sun, sky, lods, spray);
    group.add(forest.group);
  }
  const look = new TutorialLook(man, g, gl, dome);
  return {
    group,
    sky: dome ? dome.mesh : null,
    groundMaterial: groundMat,
    deck,
    party,
    look,
    update(dt: number, head: Vector3, farOnly = false) {
      bakedLight.uTime.value += dt;
      forest?.update(dt, head, farOnly);
    },
  };
}
