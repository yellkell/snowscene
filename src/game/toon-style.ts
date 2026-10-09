/**
 * The game's stylised look, applied to every lit material at once by
 * patching three's shared shader chunks before anything compiles:
 *
 * - Sunlight falls off in soft cel bands (lit, half-lit, shade) instead of a
 *   smooth photographic gradient, so forms read as clean graphic shapes.
 * - Ambient light (sky IBL, hemisphere fills) is richer in hue: shade on snow
 *   turns a clear blue-violet instead of grey.
 * - A rim of ambient light picks out silhouettes against the sky. It scales
 *   with the ambient level, so it fades away in the dark cave and at night.
 * - A custom tone curve (ACES underneath) adds saturation and a little
 *   contrast, cools the shadows and warms the highlights.
 *
 * Nothing here costs a draw call; it is a few ALU per pixel. Materials can opt
 * out with `defines: { TOON_NO_RIM: '' }` (large terrain: grazing views would
 * rim the whole horizon) or `TOON_OFF` for all of it.
 */

import { ShaderChunk } from '@iwsdk/core';

let installed = false;

const RAMP = /* glsl */ `
float toonRamp( float x ) {
  // Shade below ~0.06, a half-lit band to ~0.45, full light above; soft edges
  // keep it from aliasing on a headset.
  return 0.58 * smoothstep( 0.0, 0.1, x ) + 0.42 * smoothstep( 0.32, 0.52, x );
}
`;

export function installToonStyle(): void {
  if (installed) return;
  installed = true;

  // --- cel-banded direct light (standard/physical, lambert, phong) ---
  const direct = 'vec3 irradiance = dotNL * directLight.color;';
  const toonDirect = /* glsl */ `
	#ifndef TOON_OFF
	vec3 irradiance = toonRamp( dotNL ) * directLight.color;
	#else
	vec3 irradiance = dotNL * directLight.color;
	#endif`;
  for (const name of ['lights_physical_pars_fragment', 'lights_lambert_pars_fragment', 'lights_phong_pars_fragment'] as const) {
    const chunk = ShaderChunk[name];
    if (!chunk.includes(direct)) continue;
    ShaderChunk[name] = RAMP + chunk.replace(direct, toonDirect);
  }

  // --- richer ambient and an ambient rim, ahead of the indirect terms ---
  ShaderChunk.lights_fragment_end =
    /* glsl */ `
#if defined( RE_IndirectDiffuse ) && !defined( TOON_OFF )
{
  // Push ambient hue: blue sky light makes blue shade.
  float ambL = dot( irradiance, vec3( 0.2126, 0.7152, 0.0722 ) );
  irradiance = max( mix( vec3( ambL ), irradiance, 1.55 ), 0.0 );
  float iblL = dot( iblIrradiance, vec3( 0.2126, 0.7152, 0.0722 ) );
  iblIrradiance = max( mix( vec3( iblL ), iblIrradiance, 1.55 ), 0.0 );
  #ifndef TOON_NO_RIM
  float facing = saturate( dot( geometryNormal, geometryViewDir ) );
  float rim = smoothstep( 0.62, 0.92, 1.0 - facing );
  vec3 rimLight = ( irradiance + iblIrradiance ) * rim * 0.55;
  reflectedLight.indirectDiffuse += rimLight * material.diffuseColor * RECIPROCAL_PI;
  #endif
}
#endif
` + ShaderChunk.lights_fragment_end;

  // --- the grade: ACES, then saturation, contrast and split toning ---
  ShaderChunk.tonemapping_pars_fragment = ShaderChunk.tonemapping_pars_fragment.replace(
    'vec3 CustomToneMapping( vec3 color ) { return color; }',
    /* glsl */ `
vec3 CustomToneMapping( vec3 color ) {
  vec3 c = ACESFilmicToneMapping( color );
  float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
  // ACES greys colours out as they brighten: give them back.
  c = mix( vec3( l ), c, 1.28 );
  // A gentle S-curve for punch.
  c = mix( c, c * c * ( 3.0 - 2.0 * c ), 0.22 );
  // Cool shade, warm light.
  c += vec3( -0.012, 0.0, 0.03 ) * ( 1.0 - l ) * ( 1.0 - l );
  c += vec3( 0.02, 0.008, -0.02 ) * l * l;
  return clamp( c, 0.0, 1.0 );
}`,
  );
}
