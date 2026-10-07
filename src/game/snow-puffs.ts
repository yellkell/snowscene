/**
 * Small pool of snow-spray particles kicked up by pole plants and landings.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Points,
  ShaderMaterial,
  Vector3,
} from '@iwsdk/core';

const COUNT = 96;

export class SnowPuffs {
  readonly points: Points;
  private readonly positions: Float32Array;
  private readonly alphas: Float32Array;
  private readonly velocities = new Float32Array(COUNT * 3);
  private readonly life = new Float32Array(COUNT);
  private next = 0;

  constructor() {
    this.positions = new Float32Array(COUNT * 3);
    this.alphas = new Float32Array(COUNT);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(this.positions, 3));
    geometry.setAttribute('aAlpha', new BufferAttribute(this.alphas, 1));
    const material = new ShaderMaterial({
      uniforms: { uSize: { value: 70 } },
      vertexShader: /* glsl */ `
        uniform float uSize;
        attribute float aAlpha;
        varying float vAlpha;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = uSize * (0.4 + (1.0 - aAlpha)) / max(-mv.z, 0.1);
          vAlpha = aAlpha;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        void main() {
          float a = smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5)) * vAlpha;
          if (a < 0.02) discard;
          gl_FragColor = vec4(0.97, 0.98, 1.0, a);
        }
      `,
      transparent: true,
      depthWrite: false,
    });
    this.points = new Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.name = 'SnowPuffs';
  }

  emit(at: Vector3, count: number, strength = 1): void {
    for (let n = 0; n < count; n++) {
      const i = this.next;
      this.next = (this.next + 1) % COUNT;
      this.positions[i * 3] = at.x + (Math.random() - 0.5) * 0.06;
      this.positions[i * 3 + 1] = at.y + 0.02;
      this.positions[i * 3 + 2] = at.z + (Math.random() - 0.5) * 0.06;
      const a = Math.random() * Math.PI * 2;
      const r = (0.3 + Math.random() * 0.6) * strength;
      this.velocities[i * 3] = Math.cos(a) * r;
      this.velocities[i * 3 + 1] = (0.6 + Math.random() * 0.9) * strength;
      this.velocities[i * 3 + 2] = Math.sin(a) * r;
      this.life[i] = 0.7 + Math.random() * 0.5;
    }
  }

  update(dt: number): void {
    let active = false;
    for (let i = 0; i < COUNT; i++) {
      if (this.life[i] <= 0) {
        this.alphas[i] = 0;
        continue;
      }
      active = true;
      this.life[i] -= dt;
      this.velocities[i * 3 + 1] -= 3.2 * dt;
      const drag = Math.exp(-2.5 * dt);
      this.velocities[i * 3] *= drag;
      this.velocities[i * 3 + 2] *= drag;
      this.positions[i * 3] += this.velocities[i * 3] * dt;
      this.positions[i * 3 + 1] += this.velocities[i * 3 + 1] * dt;
      this.positions[i * 3 + 2] += this.velocities[i * 3 + 2] * dt;
      this.alphas[i] = Math.max(0, Math.min(1, this.life[i] * 1.4)) * 0.85;
    }
    const geo = this.points.geometry;
    geo.getAttribute('position').needsUpdate = active;
    geo.getAttribute('aAlpha').needsUpdate = true;
  }
}
