/**
 * The climbing holds are carved into the baked wall; what the game adds on top is their guiding glow.
 * A soft warm halo drawn additively round each hold (rim light only), as strong as the climb system's
 * `emissiveIntensity` (it pulses, brightens as a hand comes near, flares on a grab).
 */

import { AdditiveBlending, Color, ShaderMaterial } from '@iwsdk/core';

export class HoldGlowMaterial extends ShaderMaterial {
  constructor() {
    super({
      uniforms: { uGlow: { value: 0.2 }, uColor: { value: new Color(1.0, 0.78, 0.48) } },
      vertexShader: /* glsl */ `
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          // a little larger than the hold, so the halo stands round the jug carved into the rock
          vec4 mv = modelViewMatrix * vec4(position * 1.3, 1.0);
          vN = normalize(normalMatrix * normal);
          vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uGlow;
        uniform vec3 uColor;
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          // a halo, not a fill: light only toward the silhouette, nothing across the face (a filled
          // blob over the carved hold read as a sticker)
          float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.5);
          float a = max(0.0, uGlow - 0.12) * rim * 1.6;
          gl_FragColor = vec4(uColor * a * 0.9, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
  }

  /** The climb system drives this exactly as it did the old standard material's. */
  get emissiveIntensity(): number {
    return this.uniforms.uGlow.value as number;
  }

  set emissiveIntensity(v: number) {
    if (this.uniforms) this.uniforms.uGlow.value = v;
  }
}
