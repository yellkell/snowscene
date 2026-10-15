/**
 * The summit flag, for the baked mountain: nylon that streams and flutters in the wind the snow blows in
 * (it turns downwind, flaps harder and faster as the wind rises, hangs down the pole in a lull; animated on
 * the GPU, so no per-frame vertex upload) and is lit like everything else that moves (dynamicLight) — the
 * low sun glows through it from behind — on an anodised pole with a gilt finial and its halyard.
 */

import {
  BufferAttribute,
  CylinderGeometry,
  DataTexture,
  DoubleSide,
  type Group,
  Mesh,
  PlaneGeometry,
  RGBAFormat,
  SRGBColorSpace,
  ShaderMaterial,
  SphereGeometry,
  type BufferGeometry,
} from '@iwsdk/core';
import { DynamicMaterial } from './dynamic.js';
import { BAKED_GLSL, HAZE_VERT, bakedLight } from './light.js';

const FLAG_W = 1.1;
const FLAG_H = 0.7;

const VERT = /* glsl */ `
  ${HAZE_VERT}
  uniform float uFlagTime;
  uniform float uFlagPhase;
  uniform float uWind;
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vW;
  // the cloth at (x along from the hoist, y up): waves travelling downwind (their phase is the wind's own
  // run, so they speed up and slow down with it), growing toward the fly; a flutter at the free end; and
  // in the lulls it sags: each strip bends down more the further it is from the pole (the hoist stays on it)
  vec3 cloth(vec2 p) {
    float s = p.x / ${FLAG_W.toFixed(2)};
    float w = uWind;
    float t = uFlagTime;
    float ph = p.x * (5.6 - 1.6 * w) - uFlagPhase + p.y * 1.1;
    float amp = 0.07 + 0.16 * w;
    float z = pow(s, 1.1) * amp * (sin(ph) + 0.35 * sin(2.3 * ph + 1.7 + p.y * 2.6));
    z += pow(s, 3.0) * (0.01 + 0.04 * w) * sin(p.x * 17.0 - uFlagPhase * 2.6 + p.y * 5.0);
    // the waves take up length: the fly end draws in as they deepen
    float x = p.x * (1.0 - 0.06 * s * w);
    // the sag: up to ~55 deg at the fly end in a calm, almost none in a gale; bent, not swung
    float hang = (0.95 * (1.0 - w) * (1.0 - w) + 0.08 * (1.0 - w)) * smoothstep(0.0, 1.0, s);
    float ch = cos(hang), sh = sin(hang);
    return vec3(x * ch, p.y - x * sh + 0.02 * s * w * sin(ph * 0.5 + t), z);
  }
  void main() {
    vUv = uv;
    vec3 c = cloth(position.xy);
    vec3 dx = cloth(position.xy + vec2(0.01, 0.0)) - c;
    vec3 dy = cloth(position.xy + vec2(0.0, 0.01)) - c;
    vN = normalize(mat3(modelMatrix) * cross(dx, dy));
    vec4 wp = modelMatrix * vec4(c, 1.0);
    vW = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
    computeHaze(wp.xyz);
  }`;

const FRAG = /* glsl */ `
  ${BAKED_GLSL}
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vW;
  varying float vHazeF;
  void main() {
    // dyed nylon, a double-stitched hem round the free edges, a white hoist sleeve
    vec3 alb = vec3(0.62, 0.035, 0.025);
    vec2 m = vec2(vUv.x * ${FLAG_W.toFixed(2)}, vUv.y * ${FLAG_H.toFixed(2)});
    float edge = min(min(${FLAG_W.toFixed(2)} - m.x, m.y), ${FLAG_H.toFixed(2)} - m.y);
    float hem = 1.0 - smoothstep(0.016, 0.022, edge);
    alb *= mix(1.0, 0.78, hem);
    alb = mix(alb, vec3(0.8, 0.8, 0.78), 1.0 - smoothstep(0.04, 0.045, m.x));
    vec3 V = normalize(cameraPosition - vW);
    vec3 n = normalize(vN);
    n = dot(n, V) < 0.0 ? -n : n;
    float sunVis = groundSunVisibility(vW.xz);
    vec3 col = alb * (dynamicLight(n, 1.0, sunVis) + fireLight(vW, n));
    // thin nylon: the light behind it comes through, the low sun most of all
    vec3 sunL = uSunColor * uOpenSun / max(uSunDir.y, 0.05) * sunVis;
    col += alb * 0.5 * dynamicLight(-n, 1.0, sunVis);
    col += alb * 1.4 * sunL * pow(max(dot(-V, uSunDir), 0.0), 2.0) * max(dot(-n, uSunDir), 0.0);
    // a soft sheen
    vec3 H = normalize(V + uSunDir);
    col += 0.05 * sunL * pow(max(dot(n, H), 0.0), 40.0);
    gl_FragColor = vec4(applyHaze(col, vHazeF), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

function solid(rgb: [number, number, number], rough: number): DataTexture[] {
  const a = new DataTexture(new Uint8Array([...rgb.map((v) => Math.round(v * 255)), 255]), 1, 1, RGBAFormat);
  a.colorSpace = SRGBColorSpace;
  const o = new DataTexture(new Uint8Array([255, Math.round(rough * 255), 0, 255]), 1, 1, RGBAFormat);
  a.needsUpdate = o.needsUpdate = true;
  return [a, o];
}

/** Vertex colour for DynamicMaterial: r metal, g translucency. */
function tagged(g: BufferGeometry, metal: number): BufferGeometry {
  const n = g.getAttribute('position').count;
  const c = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) c.set([metal, 0, 0, 1], i * 4);
  g.setAttribute('color', new BufferAttribute(c, 4));
  return g;
}

export interface BakedFlag {
  /** `windYaw`: the heading the wind blows toward (x, z = cos, sin); `windSpeed` in m/s. */
  update(time: number, windYaw: number, windSpeed: number): void;
}

/**
 * Rebuild the summit flag group (world-builders' buildSummitFlag) in place: pole, finial, halyard and
 * cloth. The cloth's hoist stays where it was (x from 0 at the pole, centred at y = 2.6).
 */
export function bakeFlag(group: Group, cloth: Mesh): BakedFlag {
  for (const c of [...group.children]) if (c !== cloth) group.remove(c);
  const [poleA, poleO] = solid([0.78, 0.8, 0.83], 0.3);
  const [goldA, goldO] = solid([1.0, 0.78, 0.36], 0.22);
  const [ropeA, ropeO] = solid([0.85, 0.84, 0.8], 0.85);
  const pole = new Mesh(tagged(new CylinderGeometry(0.022, 0.03, 3.2, 16), 1), new DynamicMaterial(poleA, poleO));
  pole.position.y = 1.5;
  const finial = new Mesh(tagged(new SphereGeometry(0.045, 16, 10), 1), new DynamicMaterial(goldA, goldO));
  finial.position.y = 3.13;
  const halyard = new Mesh(tagged(new CylinderGeometry(0.0035, 0.0035, 3.0, 5), 0), new DynamicMaterial(ropeA, ropeO));
  halyard.position.set(-0.034, 1.55, 0.012);
  group.add(pole, finial, halyard);

  const uniforms = { ...bakedLight, uFlagTime: { value: 0 }, uFlagPhase: { value: 0 }, uWind: { value: 0.3 } };
  const g = new PlaneGeometry(FLAG_W, FLAG_H, 28, 12);
  g.translate(FLAG_W / 2, 0, 0);
  cloth.geometry.dispose();
  cloth.geometry = g;
  cloth.material = new ShaderMaterial({
    uniforms: uniforms as unknown as ShaderMaterial['uniforms'],
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: DoubleSide,
    fog: false,
  });
  cloth.position.set(0.03, 2.72, 0);
  // the waves move the cloth beyond its rest bounds
  cloth.frustumCulled = false;
  let last = -1;
  let yaw = 0;
  let wind = 0.3;
  let started = false;
  return {
    update(time: number, windYaw: number, windSpeed: number) {
      const dt = last < 0 ? 0 : Math.min(0.1, Math.max(0, time - last));
      last = time;
      // 0 a calm (it hangs), 1 a gale (it streams level and cracks)
      const target = Math.min(1, Math.max(0.1, (windSpeed - 0.4) / 8));
      wind += (target - wind) * Math.min(1, dt * 1.5);
      // it swings round to stream downwind (the cloth runs along the group's +x): a heavy, damped turn
      const want = -windYaw;
      if (!started) {
        yaw = want;
        started = true;
      }
      let d = want - yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      yaw += d * Math.min(1, dt * 0.8);
      group.rotation.y = yaw;
      uniforms.uFlagTime.value = time;
      uniforms.uWind.value = wind;
      // the waves' run: faster in a stronger wind (integrated, so a change of speed never jumps them)
      uniforms.uFlagPhase.value += dt * (3.5 + 11 * wind);
    },
  };
}
