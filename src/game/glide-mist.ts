/**
 * Fog on the glide: soft banks of mist along the way from the launch to the
 * landing, some below you, some right on your line so you fly through them.
 * Inside a bank the scene fog closes in (see `mistHooks`, read by the
 * weather system) and the bank's own billboard thins away, so going in and
 * out reads as one continuous whiteout rather than a flat sprite. A light
 * haze over the whole glide softens the distance without hiding the
 * ranges outright.
 *
 * One draw: an instanced, camera-facing quad per bank.
 */

import {
  CanvasTexture,
  Color,
  createSystem,
  type Fog,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  SRGBColorSpace,
  Vector3,
} from '@iwsdk/core';
import { currentLevel } from './level.js';
import { getHeadWorld } from './rig.js';
import { game, Phase } from './state.js';
import { mulberry32 } from './terrain.js';

const BANKS = 20;
/** Bank width as a share of the glide's length, and its limits (m). */
const SIZE_MIN = 0.1;
const SIZE_SPREAD = 0.1;
const SIZE_LIMITS = [30, 450] as const;
const OPACITY = 0.65;
/** Glide haze: fog from this near distance out to `length x HAZE_SCALE`, within limits (m). */
const HAZE_NEAR = 30;
const HAZE_SCALE = 12;
const HAZE_FAR_LIMITS = [3000, 12000] as const;
const MIST_WHITE = new Color(0.93, 0.95, 0.98);

/** How deep in a bank the viewer is (0..1) and how far the fog lets you see there. */
export const mistHooks = {
  inside: 0,
  far: 60,
  color: MIST_WHITE,
  /** Glide haze strength (0..1) and its fog range. */
  haze: 0,
  hazeNear: HAZE_NEAR,
  hazeFar: HAZE_FAR_LIMITS[1] as number,
};

const vertexShader = /* glsl */ `
attribute vec3 aCenter;
attribute vec2 aSize; // width, seed
uniform float uTime;
uniform vec3 uEye;
uniform float uFar;
varying vec2 vUv;
varying float vFade;
void main() {
  vUv = uv;
  float size = aSize.x;
  vec3 c = aCenter + vec3(sin(uTime * 0.03 + aSize.y), 0.0, cos(uTime * 0.025 + aSize.y * 1.7)) * size * 0.06;
  float d = distance(c, uEye);
  // Thin away up close (the scene fog takes over inside) and fade in from afar.
  vFade = smoothstep(size * 0.3, size * 0.95, d) * (1.0 - smoothstep(uFar * 0.75, uFar, d));
  vec4 mv = modelViewMatrix * vec4(c, 1.0);
  mv.xy += position.xy * size;
  gl_Position = projectionMatrix * mv;
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vUv;
varying float vFade;
void main() {
  vec4 t = texture2D(uMap, vUv);
  float a = t.a * vFade * uOpacity;
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor * t.rgb, a);
}
`;

/** A soft, lumpy puff of mist (white, alpha falls off to the edges). */
function mistTexture(): CanvasTexture {
  const w = 256;
  const h = 160;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const rand = mulberry32(4242);
  for (let i = 0; i < 26; i++) {
    const x = w * (0.2 + rand() * 0.6);
    const y = h * (0.35 + rand() * 0.35);
    const r = h * (0.18 + rand() * 0.22);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const shade = Math.round(225 + rand() * 30);
    g.addColorStop(0, `rgba(${shade},${shade},${shade + 0},0.22)`);
    g.addColorStop(1, `rgba(${shade},${shade},${shade},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

export class GlideMistSystem extends createSystem({}) {
  private mesh!: Mesh;
  private material!: ShaderMaterial;
  private centers!: InstancedBufferAttribute;
  private sizes!: InstancedBufferAttribute;
  private opacity = 0;
  private placed = false;
  private readonly head = new Vector3();
  private readonly c = new Vector3();

  init(): void {
    const quad = new PlaneGeometry(1, 0.62);
    const geometry = new InstancedBufferGeometry();
    geometry.index = quad.index;
    geometry.setAttribute('position', quad.getAttribute('position'));
    geometry.setAttribute('uv', quad.getAttribute('uv'));
    this.centers = new InstancedBufferAttribute(new Float32Array(BANKS * 3), 3);
    this.sizes = new InstancedBufferAttribute(new Float32Array(BANKS * 2), 2);
    geometry.setAttribute('aCenter', this.centers);
    geometry.setAttribute('aSize', this.sizes);
    geometry.instanceCount = BANKS;
    this.material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uMap: { value: mistTexture() },
        uColor: { value: new Color(1, 1, 1) },
        uOpacity: { value: 0 },
        uTime: { value: 0 },
        uEye: { value: new Vector3() },
        uFar: { value: 4000 },
      },
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new Mesh(geometry, this.material);
    this.mesh.name = 'GlideMist';
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.world.createTransformEntity(this.mesh, { persistent: true });

    this.cleanupFuncs.push(
      game.phase.subscribe((phase) => {
        if (phase === Phase.Launch) this.place();
      }),
      game.resetCount.subscribe(() => {
        this.placed = false;
        this.opacity = 0;
        this.mesh.visible = false;
        mistHooks.inside = 0;
        mistHooks.haze = 0;
      }),
    );
  }

  /** Lay the banks out along this level's glide, from the launch to the landing. */
  private place(): void {
    const lvl = currentLevel();
    const site = lvl.launch();
    const sx = site.x;
    const sy = site.floorY + 1.6;
    const sz = site.z;
    const end = lvl.glideTarget;
    const dx = end.x - sx;
    const dz = end.z - sz;
    const length = Math.max(1, Math.hypot(dx, dz));
    const px = -dz / length;
    const pz = dx / length;
    const rand = mulberry32(Math.round(length) + 7);
    const centers = this.centers.array as Float32Array;
    const sizes = this.sizes.array as Float32Array;
    for (let i = 0; i < BANKS; i++) {
      const t = 0.1 + (0.85 * (i + rand())) / BANKS;
      // Every third bank sits on your line, so you fly through it.
      const through = i % 3 === 0;
      const size = Math.min(SIZE_LIMITS[1], Math.max(SIZE_LIMITS[0], length * (SIZE_MIN + rand() * SIZE_SPREAD)));
      const lateral = (rand() * 2 - 1) * (through ? size * 0.3 : length * 0.22);
      const x = sx + dx * t + px * lateral;
      const z = sz + dz * t + pz * lateral;
      const pathY = sy + (end.y - sy) * t;
      let y = through ? pathY + (rand() - 0.6) * size * 0.3 : pathY - size * (0.4 + rand() * 0.8);
      y = Math.max(y, lvl.groundAt(x, z) + size * 0.3);
      centers[i * 3] = x;
      centers[i * 3 + 1] = y;
      centers[i * 3 + 2] = z;
      sizes[i * 2] = size;
      sizes[i * 2 + 1] = rand() * 100;
    }
    this.centers.needsUpdate = true;
    this.sizes.needsUpdate = true;
    this.material.uniforms.uFar.value = length * 1.4;
    mistHooks.hazeFar = Math.min(HAZE_FAR_LIMITS[1], Math.max(HAZE_FAR_LIMITS[0], length * HAZE_SCALE));
    this.placed = true;
  }

  update(delta: number, time: number): void {
    const dt = Math.min(delta, 0.1);
    const phase = game.phase.peek();
    const active =
      this.placed && game.indoors < 0.5 && (phase === Phase.Launch || phase === Phase.Gliding || phase === Phase.Landed);
    this.opacity += ((active ? OPACITY : 0) - this.opacity) * (1 - Math.exp(-dt / 1.5));
    this.mesh.visible = this.opacity > 0.01;
    mistHooks.haze = this.opacity / OPACITY;
    if (!this.mesh.visible) {
      mistHooks.inside = 0;
      return;
    }
    getHeadWorld(this.world, this.head);
    const u = this.material.uniforms;
    u.uTime.value = time;
    (u.uEye.value as Vector3).copy(this.head);
    u.uOpacity.value = this.opacity;
    const fog = this.scene.fog as Fog | null;
    (u.uColor.value as Color).copy(fog ? fog.color : MIST_WHITE).lerp(MIST_WHITE, 0.2);

    // How far into the nearest bank we are.
    const centers = this.centers.array as Float32Array;
    const sizes = this.sizes.array as Float32Array;
    let deepest = 0;
    let far = mistHooks.far;
    for (let i = 0; i < BANKS; i++) {
      const size = sizes[i * 2];
      this.c.set(centers[i * 3], centers[i * 3 + 1], centers[i * 3 + 2]);
      const ratio = this.c.distanceTo(this.head) / size;
      const inside = 1 - smoothstep(0.35, 0.75, ratio);
      if (inside > deepest) {
        deepest = inside;
        far = size * 0.9;
      }
    }
    mistHooks.inside = deepest * (this.opacity / OPACITY);
    mistHooks.far = far;
  }
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
