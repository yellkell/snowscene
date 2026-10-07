/**
 * Billowing powder / dust cloud shared by the avalanche, the serac collapse
 * and the rockfall: one draw call of instanced camera-facing soft sprites.
 *
 * Each puff is shaded as a little sphere lit from the sun (or the moon at
 * night), so the cloud has a bright sunny side and blue-grey shadowed side.
 * Overdraw is kept down by: a hard cap on live puffs, puffs fading out as
 * they get within ~their own size of the camera (inside the cloud the
 * events system shows a single white haze layer instead, from
 * `densityAtHead`), and early discard of the transparent fringe.
 */

import {
  Color,
  DataTexture,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  PlaneGeometry,
  RedFormat,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  UnsignedByteType,
  Vector3,
} from '@iwsdk/core';
import { fbm } from '../../terrain.js';

/** A soft, cauliflower-edged puff in the red channel. */
function puffTexture(): DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size - 0.5;
      const v = (y + 0.5) / size - 0.5;
      const r = Math.hypot(u, v) * 2;
      const n = fbm(u * 5 + 3.1, v * 5 - 1.7, 4);
      const edge = r * (1 + 0.45 * n);
      let a = 1 - Math.min(1, Math.max(0, (edge - 0.25) / 0.75));
      a = a * a * (3 - 2 * a);
      // Some inner texture so a puff is not a flat disc.
      a *= 0.78 + 0.22 * (0.5 + n);
      data[y * size + x] = Math.round(Math.max(0, Math.min(1, a)) * 255);
    }
  }
  const tex = new DataTexture(data, size, size, RedFormat, UnsignedByteType);
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

export interface PuffOptions {
  /** Size (metres, sprite edge) at birth and at death. */
  size0: number;
  size1: number;
  life: number;
  alpha: number;
  /** Velocity damping per second. */
  drag?: number;
  /** Upward acceleration (buoyancy) in m/s². Negative settles. */
  rise?: number;
  /** Colour multiplier (1 = clean snow; < 1 grey dust). */
  tint?: number;
  /** Warm the tint toward earth brown (0..1) for rock dust. */
  dust?: number;
}

export class PowderCloud {
  readonly mesh: Mesh;
  readonly capacity: number;
  /** Live puffs (packed at the front of the arrays). */
  live = 0;
  /** Whiteness around the viewer's head (0..~1), refreshed by update(). */
  densityAtHead = 0;

  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pz: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly vz: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly s0: Float32Array;
  private readonly s1: Float32Array;
  private readonly a0: Float32Array;
  private readonly drag: Float32Array;
  private readonly rise: Float32Array;
  private readonly rot: Float32Array;
  private readonly spin: Float32Array;
  private readonly center: Float32Array;
  private readonly params: Float32Array;
  private readonly tint: Float32Array;
  private readonly centerAttr: InstancedBufferAttribute;
  private readonly paramsAttr: InstancedBufferAttribute;
  private readonly tintAttr: InstancedBufferAttribute;
  private readonly geometry: InstancedBufferGeometry;
  readonly uniforms: {
    uMap: { value: DataTexture };
    uLightDir: { value: Vector3 };
    uLit: { value: Color };
    uAmbient: { value: Color };
  };

  constructor(capacity: number) {
    this.capacity = capacity;
    const f = () => new Float32Array(capacity);
    this.px = f();
    this.py = f();
    this.pz = f();
    this.vx = f();
    this.vy = f();
    this.vz = f();
    this.age = f();
    this.life = f();
    this.s0 = f();
    this.s1 = f();
    this.a0 = f();
    this.drag = f();
    this.rise = f();
    this.rot = f();
    this.spin = f();
    this.center = new Float32Array(capacity * 3);
    this.params = new Float32Array(capacity * 4);
    this.tint = new Float32Array(capacity * 3);

    const quad = new PlaneGeometry(1, 1);
    const geometry = new InstancedBufferGeometry();
    geometry.index = quad.index;
    geometry.setAttribute('position', quad.getAttribute('position'));
    geometry.setAttribute('uv', quad.getAttribute('uv'));
    this.centerAttr = new InstancedBufferAttribute(this.center, 3);
    this.paramsAttr = new InstancedBufferAttribute(this.params, 4);
    this.tintAttr = new InstancedBufferAttribute(this.tint, 3);
    this.centerAttr.setUsage(DynamicDrawUsage);
    this.paramsAttr.setUsage(DynamicDrawUsage);
    this.tintAttr.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aCenter', this.centerAttr);
    geometry.setAttribute('aParams', this.paramsAttr);
    geometry.setAttribute('aTint', this.tintAttr);
    geometry.instanceCount = 0;
    this.geometry = geometry;

    this.uniforms = {
      uMap: { value: puffTexture() },
      uLightDir: { value: new Vector3(0.3, 0.6, -0.7).normalize() },
      uLit: { value: new Color(2.2, 2.15, 2.05) },
      uAmbient: { value: new Color(0.75, 0.85, 1.05) },
    };
    const material = new ShaderMaterial({
      uniforms: { ...UniformsUtils.clone(UniformsLib.fog), ...this.uniforms },
      vertexShader: /* glsl */ `
        attribute vec3 aCenter;
        attribute vec4 aParams; // size, alpha, rotation, unused
        attribute vec3 aTint;
        uniform vec3 uLightDir;
        varying vec2 vUv;
        varying vec2 vN;
        varying float vAlpha;
        varying vec3 vTint;
        varying vec3 vLight;
        #include <fog_pars_vertex>
        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(aCenter, 1.0);
          float size = aParams.x;
          float d = -mvPosition.z;
          // Fade puffs that reach the camera: the haze layer takes over.
          float nearFade = smoothstep(size * 0.3, size * 0.95, d);
          float c = cos(aParams.z);
          float s = sin(aParams.z);
          vec2 corner = position.xy;
          vec2 rc = vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y);
          mvPosition.xy += rc * size;
          gl_Position = projectionMatrix * mvPosition;
          vUv = uv;
          vN = rc * 2.0;
          vAlpha = aParams.y * nearFade;
          vTint = aTint;
          vLight = normalize((viewMatrix * vec4(uLightDir, 0.0)).xyz);
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        uniform vec3 uLit;
        uniform vec3 uAmbient;
        varying vec2 vUv;
        varying vec2 vN;
        varying float vAlpha;
        varying vec3 vTint;
        varying vec3 vLight;
        #include <fog_pars_fragment>
        void main() {
          float a = texture2D(uMap, vUv).r * vAlpha;
          if (a < 0.012) discard;
          vec3 n = vec3(vN, sqrt(max(0.0, 1.0 - dot(vN, vN))));
          float l = clamp(dot(n, vLight) * 0.65 + 0.35, 0.0, 1.0);
          vec3 col = vTint * (uAmbient + uLit * l * l);
          gl_FragColor = vec4(col, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    this.mesh = new Mesh(geometry, material);
    this.mesh.name = 'PowderCloud';
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    // Draw after opaque scenery and before the far-off fireworks/sparks.
    this.mesh.renderOrder = 2;
  }

  /** Set the light (call once per frame while live). */
  setLight(dir: Vector3, daylight: number): void {
    const u = this.uniforms;
    u.uLightDir.value.copy(dir);
    // Sunlit snow is bright; moonlit snow is a cold dim blue.
    const d = Math.max(0, Math.min(1, daylight));
    u.uLit.value.setRGB(0.22 + 2.0 * d, 0.26 + 1.92 * d, 0.36 + 1.72 * d);
    u.uAmbient.value.setRGB(0.05 + 0.7 * d, 0.07 + 0.78 * d, 0.13 + 0.92 * d);
  }

  /** Spawn one puff; returns false when the pool is full. */
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, o: PuffOptions): boolean {
    if (this.live >= this.capacity) return false;
    const i = this.live++;
    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.age[i] = 0;
    this.life[i] = o.life;
    this.s0[i] = o.size0;
    this.s1[i] = o.size1;
    this.a0[i] = o.alpha;
    this.drag[i] = o.drag ?? 0.6;
    this.rise[i] = o.rise ?? 0.3;
    this.rot[i] = Math.random() * Math.PI * 2;
    this.spin[i] = (Math.random() - 0.5) * 0.5;
    const tint = (o.tint ?? 1) * (0.9 + Math.random() * 0.1);
    const dust = o.dust ?? 0;
    this.tint[i * 3] = tint * (1 - 0.1 * dust);
    this.tint[i * 3 + 1] = tint * (1 - 0.18 * dust);
    this.tint[i * 3 + 2] = tint * (1 - 0.3 * dust);
    this.mesh.visible = true;
    return true;
  }

  clear(): void {
    this.live = 0;
    this.geometry.instanceCount = 0;
    this.densityAtHead = 0;
    this.mesh.visible = false;
  }

  update(dt: number, head: Vector3): void {
    let density = 0;
    let n = this.live;
    for (let i = 0; i < n; i++) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        // Swap-remove: move the last live puff into this slot.
        n--;
        if (i !== n) this.copy(n, i);
        i--;
        continue;
      }
      const t = this.age[i] / this.life[i];
      const damp = Math.exp(-this.drag[i] * dt);
      this.vx[i] *= damp;
      this.vz[i] *= damp;
      this.vy[i] = this.vy[i] * damp + this.rise[i] * dt;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      this.rot[i] += this.spin[i] * dt;
      const g = 1 - (1 - t) * (1 - t);
      const size = this.s0[i] + (this.s1[i] - this.s0[i]) * g;
      const fadeIn = Math.min(1, t * 10);
      const fadeOut = t < 0.5 ? 1 : 1 - (t - 0.5) / 0.5;
      const alpha = this.a0[i] * fadeIn * fadeOut * fadeOut;
      this.center[i * 3] = this.px[i];
      this.center[i * 3 + 1] = this.py[i];
      this.center[i * 3 + 2] = this.pz[i];
      this.params[i * 4] = size;
      this.params[i * 4 + 1] = alpha;
      this.params[i * 4 + 2] = this.rot[i];
      // How much this puff whites out the viewer's eyes.
      const dx = this.px[i] - head.x;
      const dy = this.py[i] - head.y;
      const dz = this.pz[i] - head.z;
      const r = size * 0.55;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < r * r) density += alpha * (1 - Math.sqrt(d2) / r);
    }
    this.live = n;
    this.densityAtHead = density;
    this.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n > 0) {
      this.centerAttr.clearUpdateRanges();
      this.centerAttr.addUpdateRange(0, n * 3);
      this.centerAttr.needsUpdate = true;
      this.paramsAttr.clearUpdateRanges();
      this.paramsAttr.addUpdateRange(0, n * 4);
      this.paramsAttr.needsUpdate = true;
      this.tintAttr.clearUpdateRanges();
      this.tintAttr.addUpdateRange(0, n * 3);
      this.tintAttr.needsUpdate = true;
    }
  }

  private copy(from: number, to: number): void {
    this.px[to] = this.px[from];
    this.py[to] = this.py[from];
    this.pz[to] = this.pz[from];
    this.vx[to] = this.vx[from];
    this.vy[to] = this.vy[from];
    this.vz[to] = this.vz[from];
    this.age[to] = this.age[from];
    this.life[to] = this.life[from];
    this.s0[to] = this.s0[from];
    this.s1[to] = this.s1[from];
    this.a0[to] = this.a0[from];
    this.drag[to] = this.drag[from];
    this.rise[to] = this.rise[from];
    this.rot[to] = this.rot[from];
    this.spin[to] = this.spin[from];
    this.tint[to * 3] = this.tint[from * 3];
    this.tint[to * 3 + 1] = this.tint[from * 3 + 1];
    this.tint[to * 3 + 2] = this.tint[from * 3 + 2];
  }
}
