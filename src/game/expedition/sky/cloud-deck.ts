/**
 * The expedition's cloud deck at EXP_CLOUD_DECK_Y, from both sides.
 *
 * The far layer already has the sunlit sea of clouds seen from above
 * (`buildCloudSea` in sky.ts, following the viewer at the level's
 * cloudDeckY). This module adds:
 *
 *  - a far-layer **underside** (faces down, log depth): the overcast
 *    ceiling over the lower mountain, a flat grey-blue cloud base with soft
 *    texture that glows toward a low sun.
 *  - both far surfaces (and the existing far top, via
 *    cloudSeaUniforms.uInnerRadius) skip the inner disc the near deck
 *    covers, so they cost little where they would be overdrawn.
 *  - a **near-layer deck** (standard depth, both sides) on the near-terrain
 *    disc around the head. The far layer is wiped from the depth buffer
 *    before near terrain draws, so without it near terrain below the deck
 *    would show straight through the sea of clouds (and terrain above it
 *    through the ceiling). Its top matches the far cloud sea exactly (same
 *    shading code and uniforms), so the seam at the disc edge is invisible.
 *    It draws first in the near layer (render order -100) so terrain hidden
 *    behind it is rejected by early depth.
 *
 * Both share `cloudSeaUniforms` (time, noise, sun, colours, haze), so the
 * weather and the time of day tint all three surfaces together.
 */

import {
  CircleGeometry,
  Color,
  DoubleSide,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  type Vector3,
} from '@iwsdk/core';
import { FAR_DEPTH_GLSL, FAR_LAYER_ORDER } from '../../far-layer.js';
import { cloudSeaUniforms } from '../../sky.js';
import { landTextures } from '../../textures.js';
import { EXP_CLOUD_DECK_Y } from '../exp-layout.js';

/** Radius of the near-layer deck: match the streamed near-terrain disc. */
export const NEAR_DECK_RADIUS = 1500;

/** Underside colours (the far top's uniforms live in cloudSeaUniforms). */
export const deckUniforms = {
  uUnderColor: { value: new Color(0.42, 0.45, 0.52) },
  uUnderGlow: { value: new Color(0, 0, 0) },
};

/** Shading shared by the far underside and the near deck. */
const DECK_GLSL = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uShadowColor;
uniform vec3 uHazeColor;
uniform float uHazeNear;
uniform float uHazeFar;
uniform float uStorm;
uniform vec3 uTint;
uniform sampler2D uNoise;
uniform vec3 uUnderColor;
uniform vec3 uUnderGlow;
// Same billows as the far cloud sea (sky.ts CLOUD_FRAGMENT): keep in sync.
float billow(vec2 p) {
  vec2 drift = vec2(uTime * 0.6, uTime * 0.25);
  float a = texture2D(uNoise, (p + drift) * 0.00009).r;
  float b = texture2D(uNoise, (p - drift * 1.7) * 0.00035).g;
  return a * 0.65 + b * 0.35;
}
vec3 deckTop(vec2 p) {
  float h = billow(p);
  vec2 toSun = normalize(uSunDir.xz + 1e-4) * 160.0;
  float hs = billow(p + toSun);
  float lit = clamp(0.6 + (h - hs) * 5.0, 0.0, 1.0);
  float cavity = smoothstep(0.25, 0.75, h);
  vec3 top = vec3(1.0) + uSunColor * 0.35;
  vec3 col = mix(uShadowColor * 0.95, top, lit * 0.8 + 0.2) * mix(0.82, 1.02, cavity);
  col = mix(col, uShadowColor * 0.6 + 0.2, uStorm * 0.7);
  return col * uTint;
}
vec3 deckUnder(vec2 p, vec3 view) {
  // Thick billows hang darker; thin patches let light soak through.
  float h = billow(p);
  float soft = texture2D(uNoise, p * 0.0013 + vec2(uTime * 0.0006, 0.37)).b;
  float thick = smoothstep(0.3, 0.8, h * 0.72 + soft * 0.38);
  vec3 col = uUnderColor * mix(1.22, 0.7, thick);
  // A low sun lights the cloud base from beneath, toward the sun and far off.
  float toward = max(dot(normalize(view.xz + 1e-4), normalize(uSunDir.xz + 1e-4)), 0.0);
  float far = smoothstep(200.0, 6000.0, length(view.xz));
  col += uUnderGlow * (toward * toward * toward) * (0.25 + 0.75 * far) * (1.2 - 0.7 * thick);
  return mix(col, uUnderColor * 0.85, uStorm * 0.5);
}
vec3 deckHaze(vec3 col, float dist) {
  return mix(col, uHazeColor, smoothstep(uHazeNear, uHazeFar, dist) * 0.85);
}
`;

function deckMaterialUniforms() {
  return { ...cloudSeaUniforms, ...deckUniforms };
}

/** Far layer, seen from below: the overcast ceiling out to the horizon. */
function buildFarUnderside(): Mesh {
  const geometry = new PlaneGeometry(200000, 200000, 1, 1);
  geometry.rotateX(Math.PI / 2); // faces down
  const material = new ShaderMaterial({
    uniforms: deckMaterialUniforms(),
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying float vViewZ;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vec4 mv = viewMatrix * w;
        vViewZ = -mv.z;
        gl_Position = projectionMatrix * mv;
        float nearZ = projectionMatrix[3][2] / (projectionMatrix[2][2] - 1.0);
        gl_Position.z = gl_Position.w - 2.0 * nearZ;
      }
    `,
    fragmentShader: /* glsl */ `
      ${DECK_GLSL}
      uniform float uInnerRadius;
      varying vec3 vWorld;
      varying float vViewZ;
      ${FAR_DEPTH_GLSL}
      void main() {
        vec3 view = vWorld - cameraPosition;
        // The near deck covers the inner disc.
        if (dot(view.xz, view.xz) < uInnerRadius * uInnerRadius) discard;
        vec3 col = deckHaze(deckUnder(vWorld.xz, view), length(view));
        gl_FragColor = vec4(col, 1.0);
        gl_FragDepth = farLayerDepth(vViewZ);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    fog: false,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'ExpCloudDeckUnderside';
  mesh.frustumCulled = false;
  mesh.renderOrder = FAR_LAYER_ORDER + 1;
  return mesh;
}

/** Near layer: both sides of the deck on the near-terrain disc. */
function buildNearDeck(): Mesh {
  const geometry = new CircleGeometry(1, 96);
  geometry.rotateX(-Math.PI / 2); // faces up
  const material = new ShaderMaterial({
    uniforms: deckMaterialUniforms(),
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      ${DECK_GLSL}
      varying vec3 vWorld;
      void main() {
        vec3 view = vWorld - cameraPosition;
        vec3 col = gl_FrontFacing ? deckTop(vWorld.xz) : deckUnder(vWorld.xz, view);
        gl_FragColor = vec4(deckHaze(col, length(view)), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    side: DoubleSide,
    fog: false,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'ExpCloudDeckNear';
  mesh.frustumCulled = false;
  mesh.renderOrder = -100;
  return mesh;
}

export class CloudDeck {
  readonly underside: Mesh;
  readonly near: Mesh;
  private radius = NEAR_DECK_RADIUS;

  constructor() {
    cloudSeaUniforms.uNoise.value = landTextures().noise;
    this.underside = buildFarUnderside();
    this.near = buildNearDeck();
    this.setNearRadius(NEAR_DECK_RADIUS);
  }

  /** Match the near deck to the near-terrain streaming radius. */
  setNearRadius(radius: number): void {
    this.radius = radius;
    this.near.scale.set(radius, 1, radius);
  }

  /** Follow the viewer; `show` false hides both (and stops the far surfaces skipping the disc). */
  update(head: Vector3, show: boolean): void {
    const dy = head.y - EXP_CLOUD_DECK_Y;
    this.near.visible = show && Math.abs(dy) < this.radius;
    // From above, the far top is the existing cloud sea; the underside is backface-culled.
    this.underside.visible = show && dy < 5;
    this.near.position.set(head.x, EXP_CLOUD_DECK_Y, head.z);
    this.underside.position.set(head.x, EXP_CLOUD_DECK_Y, head.z);
    cloudSeaUniforms.uInnerRadius.value = this.near.visible ? Math.max(0, this.radius - 40) : 0;
  }
}
