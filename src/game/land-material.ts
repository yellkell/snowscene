/**
 * Physically based snow-and-rock material shared by the terrain, cliff,
 * boulders and distant ranges. Built on MeshStandardMaterial (so it keeps
 * shadows, fog, image-based lighting and tone mapping) and extended with:
 *
 *  - slope-driven snow / rock blending with noisy, natural boundaries;
 *  - triplanar rock albedo and normals so cliffs don't stretch;
 *  - world-space snow micro-relief (wind ripples and drifts);
 *  - view-dependent glints on sunlit snow.
 */

import { Color, MeshStandardMaterial, type Texture, Vector3, Vector4 } from '@iwsdk/core';
import { FAR_DEPTH_GLSL, FAR_VERTEX_DEPTH } from './far-layer.js';
import { CLOUD_SEA_Y } from './terrain.js';
import { landTextures } from './textures.js';

export interface LandMaterialOptions {
  /** World metres per rock texture repeat. */
  rockScale?: number;
  /** World metres per fine snow-relief repeat. */
  snowScale?: number;
  /** Extra rock on steep-ish faces (boulders use this). */
  rockBias?: number;
  /** How much steeper snow can cling before rock shows (big ranges use ice). */
  snowCling?: number;
  /** Wreathe the land in mist where it meets the sea of clouds. */
  cloudMist?: boolean;
  /** Enable snow glints (near-field only). */
  sparkle?: boolean;
  vertexColors?: boolean;
  /** Draw in the far depth layer (see far-layer.ts). */
  farLayer?: boolean;
}

/** Uniforms shared by every land material so weather can drive them. */
export const landUniforms = {
  uSunDir: { value: new Vector3(0, 1, 0) },
  uSparkle: { value: 3.0 },
  /** Warm light pool from a bonfire: xyz = position, w = strength (0 = off). */
  uFireGlow: { value: new Vector4(0, 0, 0, 0) },
  // Expedition cloud-deck mist band: land fades into the deck within
  // uDeckBelow metres under it and uDeckAbove over it. Strength 0 (the
  // default) leaves every land material exactly as it was.
  uDeckY: { value: 0 },
  uDeckBelow: { value: 90 },
  uDeckAbove: { value: 50 },
  uDeckMist: { value: new Color(1, 1, 1) },
  uDeckMistStrength: { value: 0 },
};

const DECK_MIST_PARS = /* glsl */ `
uniform float uDeckY;
uniform float uDeckBelow;
uniform float uDeckAbove;
uniform vec3 uDeckMist;
uniform float uDeckMistStrength;
`;

const DECK_MIST = /* glsl */ `
if (uDeckMistStrength > 0.0) {
  float deckD = vLandWorld.y - uDeckY;
  float deckBand = 1.0 - smoothstep(0.0, deckD < 0.0 ? uDeckBelow : uDeckAbove, abs(deckD));
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uDeckMist, deckBand * uDeckMistStrength);
}
`;

/** GLSL: warm bonfire light on a surface (cheap stand-in for a PointLight). */
const FIRE_GLOW_GLSL = `
  {
    float fireD = distance(FIRE_GLOW_POS.xz, uFireGlow.xz);
    totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.42, 0.13) * uFireGlow.w
      * smoothstep(52.0, 6.0, fireD) / (1.0 + fireD * fireD * 0.012);
  }
`;

/** Add the bonfire glow to any MeshStandardMaterial (e.g. the frozen lake). */
export function applyFireGlow(material: MeshStandardMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uFireGlow = landUniforms.uFireGlow;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGlowWorld;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\nvGlowWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGlowWorld;\nuniform vec4 uFireGlow;\n#define FIRE_GLOW_POS vGlowWorld')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${FIRE_GLOW_GLSL}`);
  };
  material.customProgramCacheKey = () => 'fireglow';
}

export function createLandMaterial(opts: LandMaterialOptions = {}): MeshStandardMaterial {
  const tex = landTextures();
  const rockScale = opts.rockScale ?? 4;
  const snowScale = opts.snowScale ?? 2.2;
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.8,
    metalness: 0,
    vertexColors: opts.vertexColors ?? false,
  });
  const defines = `
    #define LAND_ROCK_SCALE ${(1 / rockScale).toFixed(5)}
    #define LAND_SNOW_SCALE ${(1 / snowScale).toFixed(5)}
    #define LAND_ROCK_BIAS ${(opts.rockBias ?? 0).toFixed(3)}
    #define LAND_SNOW_CLING ${(opts.snowCling ?? 0).toFixed(3)}
    ${opts.sparkle ? '#define LAND_SPARKLE' : ''}
    ${opts.cloudMist ? '#define LAND_MIST' : ''}
    ${opts.farLayer ? '#define LAND_FAR' : ''}
    #define FIRE_GLOW_POS vLandWorld
    #define LAND_CLOUD_Y ${CLOUD_SEA_Y.toFixed(1)}
  `;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSnowNormal = { value: tex.snowNormal as Texture };
    shader.uniforms.uRockAlbedo = { value: tex.rockAlbedo };
    shader.uniforms.uRockNormal = { value: tex.rockNormal };
    shader.uniforms.uLandNoise = { value: tex.noise };
    shader.uniforms.uSunDir = landUniforms.uSunDir;
    shader.uniforms.uSparkle = landUniforms.uSparkle;
    shader.uniforms.uFireGlow = landUniforms.uFireGlow;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vLandWorld;
        varying vec3 vLandNormal;
        ${opts.farLayer ? FAR_DEPTH_GLSL : ''}`,
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        ${opts.farLayer ? FAR_VERTEX_DEPTH : ''}
        vec4 landWorld = vec4(transformed, 1.0);
        vec3 landN = objectNormal;
        #ifdef USE_INSTANCING
          landWorld = instanceMatrix * landWorld;
          landN = mat3(instanceMatrix) * landN;
        #endif
        landWorld = modelMatrix * landWorld;
        vLandWorld = landWorld.xyz;
        vLandNormal = normalize(mat3(modelMatrix) * landN);`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        ${defines}
        varying vec3 vLandWorld;
        varying vec3 vLandNormal;
        uniform sampler2D uSnowNormal;
        uniform sampler2D uRockAlbedo;
        uniform sampler2D uRockNormal;
        uniform sampler2D uLandNoise;
        uniform vec3 uSunDir;
        uniform float uSparkle;
        uniform vec4 uFireGlow;`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        vec3 landNW = normalize(vLandNormal);
        vec3 landNoise = texture2D(uLandNoise, vLandWorld.xz * 0.0035).rgb;
        float landFine = texture2D(uLandNoise, vLandWorld.xz * 0.045).g;
        // Steep faces shed their snow; noise keeps the boundary natural.
        float landRock = smoothstep(0.8 - LAND_SNOW_CLING, 0.6 - LAND_SNOW_CLING, landNW.y + (landNoise.r - 0.5) * 0.3 + (landFine - 0.5) * 0.12);
        landRock = max(landRock, LAND_ROCK_BIAS * smoothstep(0.92, 0.6, landNW.y + (landFine - 0.5) * 0.3));
        vec3 landW = pow(abs(landNW), vec3(4.0));
        landW /= (landW.x + landW.y + landW.z);
        vec3 landRockCol = vec3(0.3);
        if (landRock > 0.01) {
          landRockCol =
            texture2D(uRockAlbedo, vLandWorld.zy * LAND_ROCK_SCALE).rgb * landW.x +
            texture2D(uRockAlbedo, vLandWorld.xz * LAND_ROCK_SCALE).rgb * landW.y +
            texture2D(uRockAlbedo, vLandWorld.xy * LAND_ROCK_SCALE).rgb * landW.z;
          landRockCol *= 0.75 + 0.5 * landNoise.g;
        }
        // Fresh snow: bright, faintly blue in the large-scale hollows.
        vec3 landSnow = mix(vec3(0.86, 0.9, 0.97), vec3(0.95, 0.96, 0.98), landNoise.b);
        diffuseColor.rgb *= mix(landSnow, landRockCol, landRock);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix(0.68 + landFine * 0.15, 0.92, landRock);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        {
          vec2 sa = texture2D(uSnowNormal, vLandWorld.xz * LAND_SNOW_SCALE).xy * 2.0 - 1.0;
          vec2 sb = texture2D(uSnowNormal, vLandWorld.xz * LAND_SNOW_SCALE * 0.13 + 0.37).xy * 2.0 - 1.0;
          vec3 snowN = normalize(landNW + vec3(sa.x * 0.25 + sb.x * 0.4, 0.0, sa.y * 0.25 + sb.y * 0.4));
          vec3 rockN = landNW;
          if (landRock > 0.01) {
            vec3 tx = texture2D(uRockNormal, vLandWorld.zy * LAND_ROCK_SCALE).xyz * 2.0 - 1.0;
            vec3 ty = texture2D(uRockNormal, vLandWorld.xz * LAND_ROCK_SCALE).xyz * 2.0 - 1.0;
            vec3 tz = texture2D(uRockNormal, vLandWorld.xy * LAND_ROCK_SCALE).xyz * 2.0 - 1.0;
            tx = vec3(tx.xy + landNW.zy, abs(tx.z) * landNW.x);
            ty = vec3(ty.xy + landNW.xz, abs(ty.z) * landNW.y);
            tz = vec3(tz.xy + landNW.xy, abs(tz.z) * landNW.z);
            rockN = normalize(tx.zyx * landW.x + ty.xzy * landW.y + tz.xyz * landW.z);
          }
          vec3 landShadeN = normalize(mix(snowN, rockN, landRock));
          normal = normalize((viewMatrix * vec4(landShadeN, 0.0)).xyz);
        }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        #ifdef LAND_SPARKLE
        {
          vec3 cell = floor(vLandWorld * 32.0);
          float h = fract(sin(dot(cell, vec3(12.9898, 78.233, 45.164))) * 43758.5453);
          vec3 toEye = cameraPosition - vLandWorld;
          float dist = length(toEye);
          vec3 R = reflect(-uSunDir, landNW);
          float glint = step(0.9965, h) * pow(max(dot(R, toEye / dist), 0.0), 5.0);
          glint *= (1.0 - landRock) * (1.0 - smoothstep(5.0, 22.0, dist)) * step(0.0, uSunDir.y);
          totalEmissiveRadiance += vec3(1.0, 0.95, 0.85) * glint * uSparkle;
        }
        #endif
        #ifndef LAND_FAR
        ${FIRE_GLOW_GLSL}
        #endif`,
      )
      .replace(
        '#include <fog_fragment>',
        `#include <fog_fragment>
        #ifdef LAND_MIST
        {
          // Cloud tops lap against the mountains, thinning with height.
          float mist = 1.0 - smoothstep(LAND_CLOUD_Y - 20.0, LAND_CLOUD_Y + 320.0, vLandWorld.y);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.9, 0.91, 0.94), mist * 0.85);
        }
        #endif`,
      );
    // Expedition cloud-deck mist (off unless uDeckMistStrength > 0).
    shader.uniforms.uDeckY = landUniforms.uDeckY;
    shader.uniforms.uDeckBelow = landUniforms.uDeckBelow;
    shader.uniforms.uDeckAbove = landUniforms.uDeckAbove;
    shader.uniforms.uDeckMist = landUniforms.uDeckMist;
    shader.uniforms.uDeckMistStrength = landUniforms.uDeckMistStrength;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${DECK_MIST_PARS}`)
      .replace('#include <premultiplied_alpha_fragment>', `${DECK_MIST}\n#include <premultiplied_alpha_fragment>`);
  };
  material.customProgramCacheKey = () =>
    `land:${rockScale}:${snowScale}:${opts.rockBias ?? 0}:${opts.snowCling ?? 0}:${opts.cloudMist ? 1 : 0}:${opts.sparkle ? 1 : 0}:${opts.vertexColors ? 1 : 0}:${opts.farLayer ? 1 : 0}`;
  return material;
}
