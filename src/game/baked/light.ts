/**
 * The light baked scenes are re-lit with. Bakes store the sun's and the
 * sky's contribution separately (art/DESIGN.md §2); every baked material
 * recombines them as  albedo * (sunColor * Ls + skyTint * skyGain * Lk),
 * so the weather and the time of day can change what was baked.
 *
 * Units are Blender's: sunColor is the sun lamp's colour times its
 * irradiance, skyGain 1 is the photographed sky as baked.
 */

import { Color, type Texture, Vector2, Vector3, Vector4 } from '@iwsdk/core';

/** Tone-mapping exposure the baked look wants (eye adaptation through the evening). */
export const bakedView = {
  exposure: 1,
  /** a baked level is showing */
  active: false,
  /** debug: force the evening's progress (0..1); negative follows the run */
  forceProgress: -1,
  /** the tutorial's bake has loaded (both levels are baked from then on) */
  tutorialReady: false,
};

export const bakedLight = {
  /** Toward the sun, game space. */
  uSunDir: { value: new Vector3(0, 1, 0) },
  /** Sun colour times irradiance. */
  uSunColor: { value: new Color(1, 1, 1) },
  /** Colour of the sky's light on a level surface, luminance 1. */
  uSkyTint: { value: new Color(1, 1, 1) },
  /** Scales the baked sky light (1 = as baked). */
  uSkyGain: { value: 1 },
  /** Fresh-snow albedo. */
  uSnowAlbedo: { value: new Color(0.86, 0.89, 0.93) },
  uTime: { value: 0 },
  /** Radiance of the air at distance (the sky's horizon), absolute. */
  uHazeColor: { value: new Color(0.5, 0.55, 0.65) },
  /** Aerial perspective: (distance scale m, maximum amount). */
  uHaze: { value: new Vector2(2600, 0.85) },
  /** The baked terms on open, flat snow (medians of the ground bake), for things that move. */
  uOpenSun: { value: 0.02 },
  uOpenSky: { value: 0.65 },
  /** The ground lightmap, so moving things can tell when they walk into a baked shadow. */
  uGroundLight: { value: null as Texture | null },
  /** Ground lightmap placement: (origin x, origin z, half extent, sun max). */
  uGroundLM: { value: new Vector4(0, 0, 1, 1) },
  /** The lake party's bonfire as a point light: (world position of the flames' heart, intensity; 0 = out). */
  uFire: { value: new Vector4(0, 0, 0, 0) },
  /** 1 inside the ice cave: things that move are lit from its baked light volume (cave-baked.ts). */
  uCaveOn: { value: 0 },
};

/** Decode helpers shared by every baked shader. */
export const BAKED_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyTint;
uniform float uSkyGain;
uniform vec3 uSnowAlbedo;
uniform float uTime;
uniform vec3 uHazeColor;
uniform vec2 uHaze;
// Aerial perspective in linear light, before tone mapping, so distance fades toward the real horizon.
vec3 applyHaze(vec3 col, float f) { return mix(col, uHazeColor, f); }
uniform float uOpenSun;
uniform float uOpenSky;
uniform sampler2D uGroundLight;
uniform vec4 uGroundLM;
// How much sun reaches the ground at a world point (0 in a baked shadow, 1 in the open), from the
// ground lightmap's sun channel against what open flat snow gets there.
float groundSunVisibility(vec2 xz) {
  vec2 rel = xz - uGroundLM.xy;
  if (abs(rel.x) > uGroundLM.z || abs(rel.y) > uGroundLM.z) return 1.0;
  vec2 uv = vec2((rel.x + uGroundLM.z) / (2.0 * uGroundLM.z), (uGroundLM.z - rel.y) / (2.0 * uGroundLM.z));
  float t = texture2D(uGroundLight, uv).r;
  float ls = t * t * uGroundLM.w;
  return clamp(ls / max(uOpenSun, 1e-4), 0.0, 1.0);
}
// Light for things that move (not in any bake), on the same scale as the baked terms: the sun as it
// bakes on an unshadowed surface, the sky as over open snow (less facing down), and
// the snow's bounce from below. Multiply by albedo.
vec3 dynamicLight(vec3 n, float ao, float sunVis) {
  // calibrated to the bake: a level surface in the open gets exactly the open-snow sun term
  float sun = max(dot(n, uSunDir), 0.0) * uOpenSun / max(uSunDir.y, 0.05) * sunVis;
  float up = n.y * 0.5 + 0.5;
  vec3 sky = uOpenSky * mix(0.3, 1.0, up) * uSkyTint * uSkyGain;
  vec3 bounce = uSnowAlbedo * (uOpenSun * uSunColor + uOpenSky * uSkyTint * uSkyGain) * (1.0 - up) * 0.6;
  return sun * uSunColor + (sky + bounce) * ao;
}
uniform vec4 uFire;
uniform float uCaveOn;
// The bonfire: a warm point light in the same units (not in any bake: it comes and goes). Unshadowed;
// the wrap stands in for the flames' size, the +4 m^2 keeps it finite at the fire.
vec3 fireLight(vec3 wp, vec3 n) {
  if (uFire.w <= 0.0) return vec3(0.0);
  vec3 d = uFire.xyz - wp;
  float r2 = dot(d, d);
  float ndl = clamp((dot(n, d * inversesqrt(r2)) + 0.3) / 1.3, 0.0, 1.0);
  return vec3(1.0, 0.43, 0.15) * (uFire.w * ndl / (r2 + 4.0));
}
// Light channels are sqrt-encoded against a maximum: L = t^2 * max.
float decodeLight(float t, float mx) { return t * t * mx; }
vec3 decodeLight3(vec3 t, float mx) { return t * t * mx; }
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

/** Vertex-side haze amount for a world position (declare `varying float vHazeF;`). */
export const HAZE_VERT = /* glsl */ `
uniform vec2 uHaze;
varying float vHazeF;
void computeHaze(vec3 wp) {
  float d = length(wp - cameraPosition);
  vHazeF = (1.0 - exp(-d / uHaze.x)) * uHaze.y;
}
`;
