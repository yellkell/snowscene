/**
 * Image-based lighting for the day/night cycle without per-frame PMREM
 * bakes.
 *
 * A PMREM bake renders the sky six times and runs a 256-sample GGX filter
 * over every mip: far too slow to do continuously on Quest. Instead a small
 * set of keyframes is baked once each (lazily, at most one per call, mostly
 * behind the start fade): eleven clear-sky hours around the clock and five
 * overcast levels by sun height. The scene's environment is a blend target
 * of the same size, refreshed with a single cheap full-screen pass (four
 * texture reads per texel, 384x512 texels) only when the blend weights move,
 * so lighting changes smoothly with no shader recompiles.
 *
 * Bakes are 128 px per face (1.5 MB each, ~26 MB with the blend target).
 * The tutorial's 256 px maps differ in size, so lit materials recompile
 * once when the expedition takes over (behind the start fade).
 */

import {
  BackSide,
  BufferGeometry,
  Color,
  CubeUVReflectionMapping,
  Float32BufferAttribute,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PMREMGenerator,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  type Texture,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type WebGLRenderer,
} from '@iwsdk/core';
import { buildSky, setSunDirection, skyUniforms } from '../../sky.js';
import { computePalette, createPalette, moonDirectionAt, sunDirectionAt } from './sky-math.js';

const ENV_SIZE = 128;
/** Clear-sky keyframes, hour of day (symmetric about solar noon 12:30). */
const CLEAR_HOURS = [0.5, 3.4, 4.6, 5.6, 6.6, 9.5, 15.5, 18.4, 19.4, 20.4, 22.0];
/** Overcast keyframes by sun altitude (degrees): azimuth hardly matters under cloud. */
const STORM_ALTS = [-25, -6, 3, 15, 45];
const DEG = Math.PI / 180;
const SAMPLERS = ['t0', 't1', 't2', 't3'] as const;

interface EnvKey {
  storm: boolean;
  /** Hour of day (clear) or sun altitude in degrees (storm). */
  at: number;
  target: WebGLRenderTarget | null;
}

/** Four keys and their weights (clear a, clear b, storm a, storm b). */
interface Selection {
  keys: (EnvKey | null)[];
  weights: number[];
}

export class SkyEnvironment {
  private readonly clear: EnvKey[] = CLEAR_HOURS.map((at) => ({ storm: false, at, target: null }));
  private readonly storm: EnvKey[] = STORM_ALTS.map((at) => ({ storm: true, at, target: null }));
  private readonly pmrem: PMREMGenerator;
  private readonly bakeScene = new Scene();
  private readonly groundMaterial = new MeshBasicMaterial({ color: 0xffffff, side: BackSide });
  private readonly palette = createPalette();
  private readonly sun = new Vector3();
  private readonly moon = new Vector3();

  private blendTarget: WebGLRenderTarget | null = null;
  private readonly blendScene = new Scene();
  private readonly blendCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly blendMaterial: ShaderMaterial;
  private readonly want: Selection = { keys: [null, null, null, null], weights: [0, 0, 0, 0] };
  private readonly shown: Selection = { keys: [null, null, null, null], weights: [-1, -1, -1, -1] };
  private framesSinceBlend = 0;

  // Saved live sky uniforms (restored after a bake).
  private readonly savedSun = new Vector3();
  private readonly savedStormColor = new Color();
  private readonly savedZenith = new Color();
  private readonly savedHorizon = new Color();
  private readonly savedGlow = new Color();

  constructor(private readonly renderer: WebGLRenderer) {
    this.pmrem = new PMREMGenerator(renderer);
    const sky = buildSky();
    sky.scale.setScalar(0.02);
    this.bakeScene.add(sky);
    this.bakeScene.add(
      new Mesh(new SphereGeometry(300, 24, 12, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.5), this.groundMaterial),
    );

    this.blendMaterial = new ShaderMaterial({
      uniforms: {
        t0: { value: null },
        t1: { value: null },
        t2: { value: null },
        t3: { value: null },
        uW: { value: new Vector4() },
        uInvSize: { value: new Vector2() },
      },
      vertexShader: /* glsl */ `
        void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D t0;
        uniform sampler2D t1;
        uniform sampler2D t2;
        uniform sampler2D t3;
        uniform vec4 uW;
        uniform vec2 uInvSize;
        void main() {
          vec2 uv = gl_FragCoord.xy * uInvSize;
          gl_FragColor = texture2D(t0, uv) * uW.x + texture2D(t1, uv) * uW.y
            + texture2D(t2, uv) * uW.z + texture2D(t3, uv) * uW.w;
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
    const tri = new BufferGeometry();
    tri.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const quad = new Mesh(tri, this.blendMaterial);
    quad.frustumCulled = false;
    this.blendScene.add(quad);
  }

  /** The blended environment (null until the first key is baked). */
  get texture(): Texture | null {
    return this.blendTarget ? this.blendTarget.texture : null;
  }

  /** True once every keyframe is baked. */
  get complete(): boolean {
    for (const k of this.clear) if (!k.target) return false;
    for (const k of this.storm) if (!k.target) return false;
    return true;
  }

  /**
   * Choose the keys for an hour, sun altitude (degrees) and overcast weight,
   * bake at most `maxBakes` of them that are missing (nearest first), and
   * refresh the blend if it moved. Returns the number of bakes done.
   */
  update(hours: number, sunAltitude: number, overcast: number, maxBakes: number): number {
    this.select(hours, sunAltitude, overcast, this.want);
    let baked = 0;
    for (let i = 0; i < 4 && baked < maxBakes; i++) {
      const key = this.want.keys[i];
      if (key && !key.target && this.want.weights[i] > 0) {
        this.bake(key);
        baked++;
      }
    }
    this.resolveMissing(this.want);
    this.framesSinceBlend++;
    if (this.needsBlend(baked > 0)) this.blend();
    return baked;
  }

  /** Bake the missing keys a future moment will need (at most one). */
  prefetch(hours: number, sunAltitude: number, overcast: number): boolean {
    const sel = this.scratch;
    this.select(hours, sunAltitude, overcast, sel);
    for (let i = 0; i < 4; i++) {
      const key = sel.keys[i];
      if (key && !key.target && sel.weights[i] > 0) {
        this.bake(key);
        return true;
      }
    }
    return false;
  }

  /** Bake the missing key nearest to the given hour / altitude (for idle fade frames). */
  bakeNearest(hours: number, sunAltitude: number): boolean {
    const hod = ((hours % 24) + 24) % 24;
    let best: EnvKey | null = null;
    let bestD = Infinity;
    for (const k of this.clear) {
      if (k.target) continue;
      const d = Math.abs(((k.at - hod + 36) % 24) - 12) * 6; // ~6 degrees of sun per hour
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    for (const k of this.storm) {
      if (k.target) continue;
      const d = Math.abs(k.at - sunAltitude) + 8;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    if (!best) return false;
    this.bake(best);
    return true;
  }

  private readonly scratch: Selection = { keys: [null, null, null, null], weights: [0, 0, 0, 0] };

  private select(hours: number, sunAltitude: number, overcast: number, out: Selection): void {
    const hod = ((hours % 24) + 24) % 24;
    const n = CLEAR_HOURS.length;
    let i = n - 1;
    for (let k = 0; k < n; k++) {
      if (CLEAR_HOURS[k] <= hod) i = k;
    }
    // Before the first key of the day, the bracket wraps from the last one.
    if (hod < CLEAR_HOURS[0]) i = n - 1;
    const j = (i + 1) % n;
    const a = CLEAR_HOURS[i];
    let b = CLEAR_HOURS[j];
    let h = hod;
    if (b <= a) b += 24;
    if (h < a) h += 24;
    const tc = (h - a) / (b - a);

    let s = 0;
    const alt = Math.max(STORM_ALTS[0], Math.min(STORM_ALTS[STORM_ALTS.length - 1], sunAltitude));
    for (let k = 0; k < STORM_ALTS.length - 1; k++) if (STORM_ALTS[k] <= alt) s = k;
    const ts = (alt - STORM_ALTS[s]) / (STORM_ALTS[s + 1] - STORM_ALTS[s]);

    const w = overcast < 0.002 ? 0 : overcast > 0.998 ? 1 : overcast;
    out.keys[0] = this.clear[i];
    out.keys[1] = this.clear[j];
    out.keys[2] = this.storm[s];
    out.keys[3] = this.storm[s + 1];
    out.weights[0] = (1 - tc) * (1 - w);
    out.weights[1] = tc * (1 - w);
    out.weights[2] = (1 - ts) * w;
    out.weights[3] = ts * w;
    let sum = 0;
    for (let k = 0; k < 4; k++) {
      if (out.weights[k] < 0.002) out.weights[k] = 0;
      sum += out.weights[k];
    }
    for (let k = 0; k < 4; k++) out.weights[k] /= sum;
  }

  /** Keys still missing hand their weight to a baked partner (or the other group). */
  private resolveMissing(sel: Selection): void {
    for (let g = 0; g < 4; g += 2) {
      const a = sel.keys[g];
      const b = sel.keys[g + 1];
      if (a && !a.target) {
        sel.weights[g + 1] += sel.weights[g];
        sel.weights[g] = 0;
      }
      if (b && !b.target) {
        sel.weights[g] += sel.weights[g + 1];
        sel.weights[g + 1] = 0;
      }
      if (a && !a.target && b && !b.target) {
        const o = g === 0 ? 2 : 0;
        const sum = sel.weights[g] + sel.weights[g + 1];
        sel.weights[g] = 0;
        sel.weights[g + 1] = 0;
        if (sel.keys[o]?.target) sel.weights[o] += sum;
        else if (sel.keys[o + 1]?.target) sel.weights[o + 1] += sum;
      }
    }
    // Nothing baked in either group: fall back to any baked key.
    let total = 0;
    for (let k = 0; k < 4; k++) total += sel.weights[k];
    if (total < 1e-4) {
      let any: EnvKey | null = null;
      for (const k of this.clear) if (!any && k.target) any = k;
      for (const k of this.storm) if (!any && k.target) any = k;
      sel.keys[0] = any;
      sel.weights[0] = any ? 1 : 0;
      sel.weights[1] = sel.weights[2] = sel.weights[3] = 0;
    }
  }

  private needsBlend(force: boolean): boolean {
    let total = 0;
    for (let k = 0; k < 4; k++) total += this.want.weights[k];
    if (total < 1e-4) return false;
    if (!this.blendTarget || force) return true;
    let maxDiff = 0;
    for (let k = 0; k < 4; k++) {
      const wk = this.want.weights[k];
      const shownK = this.shown.keys[k];
      if (wk > 0 && shownK !== this.want.keys[k]) return true;
      maxDiff = Math.max(maxDiff, Math.abs(wk - this.shown.weights[k]));
    }
    // Small drifts are batched; a big jump (storm switching) refreshes at once.
    return maxDiff > 0.05 || (maxDiff > 0.004 && this.framesSinceBlend >= 3);
  }

  private blend(): void {
    const renderer = this.renderer;
    let first: WebGLRenderTarget | null = null;
    for (let k = 0; k < 4 && !first; k++) {
      const key = this.want.keys[k];
      if (key?.target && this.want.weights[k] > 0) first = key.target;
    }
    if (!first) return;
    const src = first.texture;
    if (!this.blendTarget) {
      const t = new WebGLRenderTarget(first.width, first.height, {
        magFilter: LinearFilter,
        minFilter: LinearFilter,
        generateMipmaps: false,
        type: HalfFloatType,
        format: RGBAFormat,
        colorSpace: LinearSRGBColorSpace,
        depthBuffer: false,
      });
      t.texture.mapping = CubeUVReflectionMapping;
      t.texture.name = 'ExpeditionSkyEnv';
      this.blendTarget = t;
      (this.blendMaterial.uniforms.uInvSize.value as Vector2).set(1 / first.width, 1 / first.height);
    }
    const u = this.blendMaterial.uniforms;
    const w = u.uW.value as Vector4;
    for (let k = 0; k < 4; k++) {
      const key = this.want.keys[k];
      const weight = key?.target ? this.want.weights[k] : 0;
      u[SAMPLERS[k]].value = weight > 0 && key?.target ? key.target.texture : src;
      w.setComponent(k, weight);
      this.shown.keys[k] = key;
      this.shown.weights[k] = this.want.weights[k];
    }
    const previous = renderer.getRenderTarget();
    const xr = renderer.xr.enabled;
    renderer.xr.enabled = false;
    renderer.setRenderTarget(this.blendTarget);
    renderer.render(this.blendScene, this.blendCamera);
    renderer.setRenderTarget(previous);
    renderer.xr.enabled = xr;
    this.framesSinceBlend = 0;
  }

  private bake(key: EnvKey): void {
    const p = this.palette;
    if (key.storm) {
      const a = key.at * DEG;
      this.sun.set(0, Math.sin(a), Math.cos(a));
      this.moon.set(0, -1, 0);
      computePalette(p, this.sun, this.moon, 1);
    } else {
      sunDirectionAt(key.at, this.sun);
      moonDirectionAt(key.at, this.moon);
      computePalette(p, this.sun, this.moon, 0);
    }
    const u = skyUniforms;
    this.savedSun.copy(u.sunPosition.value);
    const savedStorm = u.uStorm.value;
    const savedGain = u.uSkyGain.value;
    this.savedStormColor.copy(u.uStormColor.value);
    this.savedZenith.copy(u.uNightZenith.value);
    this.savedHorizon.copy(u.uNightHorizon.value);
    this.savedGlow.copy(u.uTwilightGlow.value);

    setSunDirection(this.sun.set(p.skySun.x, p.skySun.y, p.skySun.z));
    u.uSkyGain.value = p.skyGain;
    u.uNightZenith.value.setRGB(p.nightZenith.r, p.nightZenith.g, p.nightZenith.b);
    u.uNightHorizon.value.setRGB(p.nightHorizon.r, p.nightHorizon.g, p.nightHorizon.b);
    u.uTwilightGlow.value.setRGB(p.twilightGlow.r, p.twilightGlow.g, p.twilightGlow.b);
    u.uStorm.value = key.storm ? 1 : 0;
    u.uStormColor.value.setRGB(p.stormSky.r, p.stormSky.g, p.stormSky.b);
    if (key.storm) {
      this.groundMaterial.color.setRGB(
        (p.ground.r * 0.7 + p.stormSky.r * 0.75) * 0.5,
        (p.ground.g * 0.7 + p.stormSky.g * 0.75) * 0.5,
        (p.ground.b * 0.7 + p.stormSky.b * 0.75) * 0.5,
      );
    } else {
      this.groundMaterial.color.setRGB(p.ground.r, p.ground.g, p.ground.b);
    }

    key.target = this.pmrem.fromScene(this.bakeScene, 0, 0.1, 1000, { size: ENV_SIZE });

    u.sunPosition.value.copy(this.savedSun);
    u.uStorm.value = savedStorm;
    u.uSkyGain.value = savedGain;
    u.uStormColor.value.copy(this.savedStormColor);
    u.uNightZenith.value.copy(this.savedZenith);
    u.uNightHorizon.value.copy(this.savedHorizon);
    u.uTwilightGlow.value.copy(this.savedGlow);
  }
}
