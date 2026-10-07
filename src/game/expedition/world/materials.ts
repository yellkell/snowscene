/**
 * Shared materials for the expedition's world content. Each is created once
 * and shared by every chunk so the whole mountain compiles a handful of
 * shader programs. All are opaque (no alpha test, no blending).
 *
 *  - props: vertex-coloured PBR with a per-vertex `aFx` (night glow,
 *    metalness, roughness) so wood, canvas and steel share one draw call;
 *    tents glow warmly at night.
 *  - cloth: double-sided flags whose free edges flutter in the wind
 *    (vertex shader, `aFlap` = weight, phase, direction).
 *  - ice: blue-white glacier ice with a cheap fake subsurface glow
 *    (fresnel-weighted emissive tint), faceted or smooth.
 *  - water: dark river water with scrolling normals and white water.
 *  - holds and partygoers: instanced holds that glow per instance, and
 *    dancers animated entirely in the vertex shader.
 */

import {
  Color,
  DoubleSide,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Texture,
} from '@iwsdk/core';
import { createLandMaterial } from '../../land-material.js';
import { buildBarkTexture, landTextures } from '../../textures.js';

/** Uniforms the world system drives every frame. */
export const worldUniforms = {
  uTime: { value: 0 },
  /** 0 calm .. 1 gale (flags, windsocks). */
  uWind: { value: 0.4 },
  /** 0 by day .. 1 at night (tent glow, bulbs). */
  uNight: { value: 0 },
  /** Strength of the ice's blue inner glow (follows daylight). */
  uIceGlow: { value: 1 },
};

const cache = new Map<string, unknown>();
function once<T>(key: string, make: () => T): T {
  let v = cache.get(key) as T | undefined;
  if (!v) {
    v = make();
    cache.set(key, v);
  }
  return v;
}

/** Vertex-coloured wood / canvas / steel with night glow (aFx = glow, metal, rough, -). */
export function propsMaterial(): MeshStandardMaterial {
  return once('props', () => {
    const m = new MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 });
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uNight = worldUniforms.uNight;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 aFx;\nvarying vec4 vFx;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFx = aFx;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec4 vFx;\nuniform float uNight;')
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nif (vFx.z > 0.0) roughnessFactor = vFx.z;')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = max(metalnessFactor, vFx.y);')
        .replace(
          '#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vFx.x * uNight;',
        );
    };
    m.customProgramCacheKey = () => 'exp-props';
    return m;
  });
}

/** Spruce foliage and trunks (instanced, tinted per tree). */
export function treeMaterial(): MeshStandardMaterial {
  return once('tree', () => new MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 }));
}

/** Double-sided fluttering cloth (aFlap = weight, phase, dirX, dirZ). */
export function clothMaterial(): MeshStandardMaterial {
  return once('cloth', () => {
    const m = new MeshStandardMaterial({ vertexColors: true, roughness: 0.88, side: DoubleSide });
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = worldUniforms.uTime;
      shader.uniforms.uWind = worldUniforms.uWind;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 aFlap;\nuniform float uTime;\nuniform float uWind;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          if (aFlap.x > 0.0) {
            vec3 flapW = (modelMatrix * vec4(position, 1.0)).xyz;
            float ph = aFlap.y + dot(flapW.xz, vec2(0.9, 0.55));
            float wave = sin(uTime * (6.0 + 3.0 * uWind) + ph) * 0.65 + sin(uTime * 10.7 + ph * 1.9) * 0.35;
            float amp = aFlap.x * (0.035 + 0.13 * uWind);
            transformed.xz += aFlap.zw * wave * amp;
            transformed.y += aFlap.x * aFlap.x * sin(uTime * 4.3 + ph * 1.3) * 0.025 * (0.3 + uWind);
          }`,
        );
    };
    m.customProgramCacheKey = () => 'exp-cloth';
    return m;
  });
}

function iceShader(m: MeshStandardMaterial, key: string): void {
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uIceGlow = worldUniforms.uIceGlow;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uIceGlow;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          vec3 iceView = normalize(vViewPosition);
          float iceFres = pow(1.0 - clamp(abs(dot(normal, iceView)), 0.0, 1.0), 2.5);
          float iceBlue = clamp((diffuseColor.b - diffuseColor.r) * 3.0, 0.0, 1.0);
          totalEmissiveRadiance += vec3(0.05, 0.26, 0.48) * (0.18 + 0.85 * iceFres) * uIceGlow * mix(0.25, 1.0, iceBlue);
        }`,
      );
  };
  m.customProgramCacheKey = () => key;
}

/** Faceted serac ice. */
export function iceFacetMaterial(): MeshStandardMaterial {
  return once('ice-facet', () => {
    const m = new MeshStandardMaterial({ vertexColors: true, roughness: 0.2, metalness: 0, flatShading: true });
    iceShader(m, 'exp-ice-facet');
    return m;
  });
}

/** Smooth ice (the ice wall, crevasse walls, icicles). */
export function iceSmoothMaterial(): MeshStandardMaterial {
  return once('ice-smooth', () => {
    const m = new MeshStandardMaterial({ vertexColors: true, roughness: 0.24, metalness: 0 });
    m.normalMap = landTextures().snowNormal;
    m.normalScale.set(0.6, 0.6);
    iceShader(m, 'exp-ice-smooth');
    return m;
  });
}

/** Blue ice seams lying on the glacier (pulled toward the camera so they never z-fight). */
export function seamMaterial(): MeshStandardMaterial {
  return once('seam', () => {
    const m = new MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.12,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    iceShader(m, 'exp-ice-seam');
    return m;
  });
}

/** Flat patches on the snow: trampled snow, the landing cross, the launch pad. */
export function decalMaterial(): MeshStandardMaterial {
  return once(
    'decal',
    () =>
      new MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.9,
        metalness: 0,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -4,
      }),
  );
}

/** Boulders and cairns: the shared snow-and-rock land material, rock-biased. */
export function rockMaterial(): MeshStandardMaterial {
  return once('rock', () => createLandMaterial({ rockBias: 1, rockScale: 1.6, snowScale: 1.5 }));
}

/** The rock band and the ledge wall: big triplanar rock with snow on the ledges. */
export function faceRockMaterial(): MeshStandardMaterial {
  return once('face-rock', () => createLandMaterial({ rockScale: 4.5, snowScale: 1.5, rockBias: 0.6 }));
}

/** Snow (slabs over the cliff tops, cornices, crevasse lips). */
export function snowMaterial(): MeshStandardMaterial {
  return once('snow', () => createLandMaterial({ snowScale: 1.5, sparkle: true }));
}

/** Bark-textured logs (the bridge, benches, cribs). */
export function barkMaterial(): MeshStandardMaterial {
  return once('bark', () => new MeshStandardMaterial({ map: buildBarkTexture(), vertexColors: true, roughness: 0.92 }));
}

/** Festoon bulbs: unlit, coloured per instance. */
export function bulbMaterial(): MeshBasicMaterial {
  return once('bulb', () => {
    const m = new MeshBasicMaterial({ color: new Color(1.4, 1.4, 1.4) });
    return m;
  });
}

/** Rock band holds: chalky stone whose warm glow is set per instance (aGlow). */
export function holdMaterial(): MeshStandardMaterial {
  return once('hold', () => {
    const m = new MeshStandardMaterial({
      color: 0xb8a58e,
      roughness: 0.85,
      emissive: new Color(1, 0.7, 0.4),
      emissiveIntensity: 1,
    });
    m.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aGlow;\nvarying float vHoldGlow;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHoldGlow = aGlow;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vHoldGlow;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= vHoldGlow;');
    };
    m.customProgramCacheKey = () => 'exp-hold';
    return m;
  });
}

/** Signs: one canvas atlas for every board on the mountain. */
export function signMaterial(atlas: Texture): MeshStandardMaterial {
  return once('sign', () => new MeshStandardMaterial({ map: atlas, roughness: 0.8 }));
}

/** River water: scrolling normals along the flow, white water on the steep reaches. */
export function waterMaterial(): MeshStandardMaterial {
  return once('water', () => {
    const m = new MeshStandardMaterial({
      color: new Color(0.035, 0.11, 0.13),
      roughness: 0.06,
      metalness: 0,
      envMapIntensity: 1.3,
    });
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = worldUniforms.uTime;
      shader.uniforms.uWaterNormal = { value: landTextures().snowNormal };
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nattribute vec2 aWater;\nattribute float aRapid;\nvarying vec2 vWater;\nvarying float vRapid;',
        )
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWater = aWater;\nvRapid = aRapid;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float uTime;\nuniform sampler2D uWaterNormal;\nvarying vec2 vWater;\nvarying float vRapid;',
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
          float wSpeed = 1.6 + 2.6 * vRapid;
          vec2 wa = texture2D(uWaterNormal, vec2(vWater.x * 0.18, vWater.y * 0.11 - uTime * wSpeed * 0.11)).xy * 2.0 - 1.0;
          vec2 wb = texture2D(uWaterNormal, vec2(vWater.x * 0.31 + 0.4, vWater.y * 0.23 - uTime * wSpeed * 0.19)).xy * 2.0 - 1.0;
          float edge = smoothstep(0.62, 0.98, abs(vWater.x));
          float churn = clamp((wa.x + wb.y) * 0.5 + 0.5, 0.0, 1.0);
          float foam = clamp(edge * (0.35 + 0.65 * churn) + vRapid * smoothstep(0.35, 0.75, churn), 0.0, 1.0);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.9, 0.93), foam);`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.75, foam);',
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
          {
            vec3 wn = normalize(vec3((wa.x + wb.x) * (0.18 + 0.25 * vRapid), 1.0, (wa.y + wb.y) * (0.18 + 0.25 * vRapid)));
            normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
          }`,
        );
    };
    m.customProgramCacheKey = () => 'exp-water';
    return m;
  });
}

/** Every world material, for shader warm-up. */
export function allWorldMaterials(): Array<MeshStandardMaterial | MeshBasicMaterial> {
  return [
    propsMaterial(),
    treeMaterial(),
    clothMaterial(),
    iceFacetMaterial(),
    iceSmoothMaterial(),
    seamMaterial(),
    decalMaterial(),
    rockMaterial(),
    faceRockMaterial(),
    snowMaterial(),
    barkMaterial(),
    bulbMaterial(),
    holdMaterial(),
    waterMaterial(),
  ];
}
