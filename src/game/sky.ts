/**
 * Physically based sky and the sea of clouds.
 *
 * The sky uses the Preetham analytic daylight model (adapted from the
 * three.js Sky example, MIT licence) for a realistic low-sun alpine sky with
 * a storm blend driven by the weather. The cloud sea is a vast, slowly
 * churning cloud deck that fills the lowlands below the valley, with sunlit
 * tops and aerial-perspective haze toward the horizon.
 */

import {
  BackSide,
  Color,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  type WebGLRenderer,
  type Texture,
} from '@iwsdk/core';
import { FAR_DEPTH_GLSL, FAR_LAYER_ORDER } from './far-layer.js';
import { CLOUD_SEA_Y } from './terrain.js';
import { landTextures } from './textures.js';

export const SKY_RADIUS = 20000;

export const skyUniforms = {
  sunPosition: { value: new Vector3() },
  up: { value: new Vector3(0, 1, 0) },
  turbidity: { value: 2.4 },
  rayleigh: { value: 2.2 },
  mieCoefficient: { value: 0.004 },
  mieDirectionalG: { value: 0.82 },
  uStorm: { value: 0 },
  uStormColor: { value: new Color(0.74, 0.8, 0.9) },
  // Night / twilight hook for the expedition's day-night cycle. The defaults
  // (gain 1, black) leave the tutorial sky exactly as it was.
  uSkyGain: { value: 1 },
  uNightZenith: { value: new Color(0, 0, 0) },
  uNightHorizon: { value: new Color(0, 0, 0) },
  uTwilightGlow: { value: new Color(0, 0, 0) },
  // The fog the weather is laying down, and how much of the sky it swallows
  // (0 in clear air .. 1 in thick fog), so fogged land melts into the sky
  // instead of standing out as pale cut-outs against it.
  uFogColor: { value: new Color(0.46, 0.58, 0.82) },
  uFogBlend: { value: 0 },
};

const SKY_VERTEX = /* glsl */ `
uniform vec3 sunPosition;
uniform float rayleigh;
uniform float turbidity;
uniform float mieCoefficient;
uniform vec3 up;
varying vec3 vWorldPosition;
varying vec3 vSunDirection;
varying float vSunfade;
varying vec3 vBetaR;
varying vec3 vBetaM;
varying float vSunE;
const float e = 2.71828182845904523536028747135266249775724709369995957;
const float pi = 3.141592653589793238462643383279502884197169;
const vec3 totalRayleigh = vec3(5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5);
const vec3 MieConst = vec3(1.8399918514433978E14, 2.7798023919660528E14, 4.0790479543861094E14);
const float cutoffAngle = 1.6110731556870734;
const float steepness = 1.5;
const float EE = 1000.0;
float sunIntensity(float zenithAngleCos) {
  zenithAngleCos = clamp(zenithAngleCos, -1.0, 1.0);
  return EE * max(0.0, 1.0 - pow(e, -((cutoffAngle - acos(zenithAngleCos)) / steepness)));
}
vec3 totalMie(float T) {
  float c = (0.2 * T) * 10E-18;
  return 0.434 * c * MieConst;
}
void main() {
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPosition.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position.z = gl_Position.w;
  vSunDirection = normalize(sunPosition);
  vSunE = sunIntensity(dot(vSunDirection, up));
  vSunfade = 1.0 - clamp(1.0 - exp((sunPosition.y / 450000.0)), 0.0, 1.0);
  float rayleighCoefficient = rayleigh - (1.0 * (1.0 - vSunfade));
  vBetaR = totalRayleigh * rayleighCoefficient;
  vBetaM = totalMie(turbidity) * mieCoefficient;
}
`;

const SKY_FRAGMENT = /* glsl */ `
varying vec3 vWorldPosition;
varying vec3 vSunDirection;
varying float vSunfade;
varying vec3 vBetaR;
varying vec3 vBetaM;
varying float vSunE;
uniform float mieDirectionalG;
uniform vec3 up;
uniform float uStorm;
uniform vec3 uStormColor;
uniform float uSkyGain;
uniform vec3 uNightZenith;
uniform vec3 uNightHorizon;
uniform vec3 uTwilightGlow;
uniform vec3 uFogColor;
uniform float uFogBlend;
const float pi = 3.141592653589793238462643383279502884197169;
const float rayleighZenithLength = 8.4E3;
const float mieZenithLength = 1.25E3;
const float sunAngularDiameterCos = 0.999956676946448443553574619906976478926848692873900859324;
const float THREE_OVER_SIXTEENPI = 0.05968310365946075;
const float ONE_OVER_FOURPI = 0.07957747154594767;
float rayleighPhase(float cosTheta) {
  return THREE_OVER_SIXTEENPI * (1.0 + pow(cosTheta, 2.0));
}
float hgPhase(float cosTheta, float g) {
  float g2 = pow(g, 2.0);
  float inverse = 1.0 / pow(1.0 - 2.0 * g * cosTheta + g2, 1.5);
  return ONE_OVER_FOURPI * ((1.0 - g2) * inverse);
}
void main() {
  vec3 direction = normalize(vWorldPosition - cameraPosition);
  float zenithAngle = acos(max(0.0, dot(up, direction)));
  float inverse = 1.0 / (cos(zenithAngle) + 0.15 * pow(93.885 - ((zenithAngle * 180.0) / pi), -1.253));
  float sR = rayleighZenithLength * inverse;
  float sM = mieZenithLength * inverse;
  vec3 Fex = exp(-(vBetaR * sR + vBetaM * sM));
  float cosTheta = dot(direction, vSunDirection);
  float rPhase = rayleighPhase(cosTheta * 0.5 + 0.5);
  vec3 betaRTheta = vBetaR * rPhase;
  float mPhase = hgPhase(cosTheta, mieDirectionalG);
  vec3 betaMTheta = vBetaM * mPhase;
  vec3 Lin = pow(vSunE * ((betaRTheta + betaMTheta) / (vBetaR + vBetaM)) * (1.0 - Fex), vec3(1.5));
  Lin *= mix(vec3(1.0), pow(vSunE * ((betaRTheta + betaMTheta) / (vBetaR + vBetaM)) * Fex, vec3(1.0 / 2.0)), clamp(pow(1.0 - dot(up, vSunDirection), 5.0), 0.0, 1.0));
  vec3 L0 = vec3(0.1) * Fex;
  float sundisk = smoothstep(sunAngularDiameterCos, sunAngularDiameterCos + 0.00002, cosTheta);
  L0 += (vSunE * 19000.0 * Fex) * sundisk;
  vec3 texColor = (Lin + L0) * 0.04 + vec3(0.0, 0.0003, 0.00075);
  vec3 retColor = pow(texColor, vec3(1.0 / (1.2 + (1.2 * vSunfade))));
  // Night and twilight (expedition hook; a no-op with the default uniforms).
  float skyUp = clamp(direction.y, 0.0, 1.0);
  float toSun = max(dot(normalize(direction.xz + 1e-5), normalize(vSunDirection.xz + 1e-5)) * 0.5 + 0.5, 0.0);
  retColor = retColor * uSkyGain + mix(uNightHorizon, uNightZenith, sqrt(skyUp))
    + uTwilightGlow * (toSun * toSun * toSun) * (1.0 - smoothstep(0.0, 0.3, skyUp));
  // Overcast: flatten toward a luminous grey, brighter toward the horizon.
  float horizon = 1.0 - smoothstep(0.0, 0.5, direction.y);
  vec3 overcast = uStormColor * (0.75 + 0.35 * horizon);
  retColor = mix(retColor, overcast, uStorm);
  // Thick fog fills the sky from the horizon up.
  float fogLow = 1.0 - smoothstep(-0.05, 0.25 + 0.75 * uFogBlend, direction.y);
  retColor = mix(retColor, uFogColor, uFogBlend * max(fogLow, uFogBlend * 0.85));
  gl_FragColor = vec4(retColor, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function buildSky(): Mesh {
  const material = new ShaderMaterial({
    uniforms: skyUniforms,
    vertexShader: SKY_VERTEX,
    fragmentShader: SKY_FRAGMENT,
    side: BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const mesh = new Mesh(new SphereGeometry(SKY_RADIUS, 48, 24), material);
  mesh.renderOrder = -1e9;
  mesh.frustumCulled = false;
  mesh.name = 'Sky';
  return mesh;
}

/** Point the sun (and sky) along a unit direction. */
export function setSunDirection(direction: Vector3): void {
  skyUniforms.sunPosition.value.copy(direction).multiplyScalar(450000);
}

/**
 * Bake image-based lighting from the sky plus a snowy ground hemisphere so
 * reflections and ambient light match what you see.
 */
export function bakeSkyEnvironment(renderer: WebGLRenderer, storm: number): Texture {
  const scene = new Scene();
  const sky = buildSky();
  sky.scale.setScalar(0.02);
  scene.add(sky);
  const ground = new Mesh(
    new SphereGeometry(300, 32, 16, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.5),
    new MeshBasicMaterial({ color: new Color(0.55, 0.6, 0.7).multiplyScalar(1 - storm * 0.3), side: BackSide }),
  );
  scene.add(ground);
  const previousStorm = skyUniforms.uStorm.value;
  skyUniforms.uStorm.value = storm;
  const pmrem = new PMREMGenerator(renderer);
  const target = pmrem.fromScene(scene, 0.02, 0.1, 1000);
  skyUniforms.uStorm.value = previousStorm;
  pmrem.dispose();
  sky.geometry.dispose();
  ground.geometry.dispose();
  return target.texture;
}

// ------------------------------------------------------------ cloud sea ----

export const cloudSeaUniforms = {
  uTime: { value: 0 },
  uNoise: { value: null as Texture | null },
  uSunDir: { value: new Vector3(0, 1, 0) },
  uSunColor: { value: new Color(1.0, 0.78, 0.58) },
  uShadowColor: { value: new Color(0.52, 0.58, 0.72) },
  uHazeColor: { value: new Color(0.8, 0.82, 0.9) },
  uHazeNear: { value: 400 },
  uHazeFar: { value: 24000 },
  uStorm: { value: 0 },
  /** Time-of-day tint/brightness of the deck (expedition hook; white = unchanged). */
  uTint: { value: new Color(1, 1, 1) },
  /** Skip this radius around the viewer where a near-layer deck covers it (0 = off). */
  uInnerRadius: { value: 0 },
};

const CLOUD_VERTEX = /* glsl */ `
varying vec3 vWorld;
varying float vViewZ;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vec4 mv = viewMatrix * w;
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
  // Far layer: depth comes from the fragment shader. Keep near-plane
  // clipping but push the far plane to infinity.
  float nearZ = projectionMatrix[3][2] / (projectionMatrix[2][2] - 1.0);
  gl_Position.z = gl_Position.w - 2.0 * nearZ;
}
`;

const CLOUD_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uShadowColor;
uniform vec3 uHazeColor;
uniform float uHazeNear;
uniform float uHazeFar;
uniform float uStorm;
uniform vec3 uTint;
uniform float uInnerRadius;
uniform sampler2D uNoise;
varying vec3 vWorld;
varying float vViewZ;
${FAR_DEPTH_GLSL}
// Billow height from a tileable fbm texture at three scales (cheap on mobile GPUs).
float billow(vec2 p) {
  vec2 drift = vec2(uTime * 0.6, uTime * 0.25);
  float a = texture2D(uNoise, (p + drift) * 0.00009).r;
  float b = texture2D(uNoise, (p - drift * 1.7) * 0.00035).g;
  return a * 0.65 + b * 0.35;
}
void main() {
  vec2 rel = vWorld.xz - cameraPosition.xz;
  if (dot(rel, rel) < uInnerRadius * uInnerRadius) discard;
  vec2 p = vWorld.xz;
  float h = billow(p);
  // Soft sunlit tops and blue-grey troughs, like a cumulus deck from above.
  vec2 toSun = normalize(uSunDir.xz + 1e-4) * 160.0;
  float hs = billow(p + toSun);
  float lit = clamp(0.6 + (h - hs) * 5.0, 0.0, 1.0);
  float cavity = smoothstep(0.25, 0.75, h);
  vec3 top = vec3(1.0) + uSunColor * 0.35;
  vec3 col = mix(uShadowColor * 0.95, top, lit * 0.8 + 0.2) * mix(0.82, 1.02, cavity);
  col = mix(col, uShadowColor * 0.6 + 0.2, uStorm * 0.7);
  col *= uTint;
  float dist = length(vWorld - cameraPosition);
  col = mix(col, uHazeColor, smoothstep(uHazeNear, uHazeFar, dist) * 0.85);
  gl_FragColor = vec4(col, 1.0);
  gl_FragDepth = farLayerDepth(vViewZ);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function buildCloudSea(): Mesh {
  cloudSeaUniforms.uNoise.value = landTextures().noise;
  const geometry = new PlaneGeometry(70000, 70000, 1, 1);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new Mesh(
    geometry,
    new ShaderMaterial({
      uniforms: cloudSeaUniforms,
      vertexShader: CLOUD_VERTEX,
      fragmentShader: CLOUD_FRAGMENT,
      fog: false,
    }),
  );
  mesh.position.y = CLOUD_SEA_Y;
  mesh.frustumCulled = false;
  mesh.renderOrder = FAR_LAYER_ORDER + 1;
  mesh.name = 'CloudSea';
  return mesh;
}
