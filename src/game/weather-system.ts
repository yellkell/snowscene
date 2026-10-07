/**
 * Dynamic mountain weather.
 *
 * A single "storm" value (0 = clear, 1 = blizzard) follows the journey:
 * light snow at the trailhead, thickening as you pole uphill, a gusty
 * blizzard on the cliff, then the sky clears at the summit for a golden
 * glide home and a gentle snowfall after landing. Storm and gusting wind
 * drive snowfall density, wind drift, blowing ground snow (spindrift),
 * fog distance, a grey sky veil, drifting clouds, sunlight and wind audio.
 */

import {
  BackSide,
  BufferGeometry,
  CanvasTexture,
  Color,
  createSystem,
  DirectionalLight,
  Float32BufferAttribute,
  Fog,
  Mesh,
  MeshBasicMaterial,
  Points,
  ShaderMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector3,
} from '@iwsdk/core';
import { audio } from './audio.js';
import { getHeadWorld } from './rig.js';
import { sceneRefs } from './scene-system.js';
import { game, Phase } from './state.js';
import { mulberry32, smoothstep, valueNoise } from './terrain.js';
import { FOG_COLOR } from './world-builders.js';

const STORM_FOG = new Color(0.64, 0.67, 0.75);
const CLOUD_COUNT = 26;

interface SnowLayerOptions {
  count: number;
  box: Vector3;
  size: number;
  maxSize: number;
  seed: number;
}

/** Points that wrap inside a box around the viewer; drift is a uniform offset. */
function buildSnowLayer(opts: SnowLayerOptions): Points {
  const rand = mulberry32(opts.seed);
  const positions = new Float32Array(opts.count * 3);
  const seeds = new Float32Array(opts.count);
  for (let i = 0; i < opts.count; i++) {
    positions[i * 3] = rand();
    positions[i * 3 + 1] = rand();
    positions[i * 3 + 2] = rand();
    seeds[i] = rand();
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new Float32BufferAttribute(seeds, 1));
  const material = new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uCenter: { value: new Vector3() },
      uBox: { value: opts.box.clone() },
      uOffset: { value: new Vector3() },
      uSize: { value: opts.size },
      uMaxSize: { value: opts.maxSize },
      uIntensity: { value: 1 },
      uOpacity: { value: 1 },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uCenter;
      uniform vec3 uBox;
      uniform vec3 uOffset;
      uniform float uSize;
      uniform float uMaxSize;
      uniform float uIntensity;
      uniform float uOpacity;
      attribute float aSeed;
      varying float vAlpha;
      void main() {
        vec3 p = position * uBox + uOffset * (0.75 + aSeed * 0.5);
        p.x += sin(uTime * 0.6 + aSeed * 30.0) * 0.4;
        p.z += cos(uTime * 0.45 + aSeed * 17.0) * 0.3;
        p = mod(p - uCenter + 0.5 * uBox, uBox) + uCenter - 0.5 * uBox;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float on = step(aSeed, uIntensity);
        gl_PointSize = on * min(uSize * (0.45 + aSeed * 0.7) / max(-mv.z, 0.1), uMaxSize);
        float r = length((p - uCenter) / (0.5 * uBox));
        vAlpha = on * (1.0 - smoothstep(0.55, 1.0, r)) * uOpacity;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      void main() {
        float a = smoothstep(0.5, 0.1, length(gl_PointCoord - 0.5)) * vAlpha;
        if (a < 0.02) discard;
        gl_FragColor = vec4(1.0, 1.0, 1.0, a);
      }
    `,
    transparent: true,
    depthWrite: false,
  });
  const points = new Points(geometry, material);
  points.frustumCulled = false;
  return points;
}

function cloudTexture(seed: number): CanvasTexture {
  const rand = mulberry32(seed);
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  for (let i = 0; i < 14; i++) {
    const x = 50 + rand() * 156;
    const y = 50 + rand() * 40 - (Math.abs(x - 128) / 128) * 10;
    const r = 22 + rand() * 32;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 128);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

interface Cloud {
  sprite: Sprite;
  base: number;
}

export class WeatherSystem extends createSystem({}) {
  private snow!: Points;
  private drift!: Points;
  private veil!: Mesh;
  private clouds: Cloud[] = [];
  private storm = 0.25;
  private gustWasHigh = false;
  private readonly head = new Vector3();
  private readonly snowOffset = new Vector3();
  private readonly driftOffset = new Vector3();
  private readonly fogColor = new Color();
  private readonly cloudTint = new Color();

  init(): void {
    const add = (object: Parameters<typeof this.world.createTransformEntity>[0]) =>
      this.world.createTransformEntity(object, { persistent: true });

    this.snow = buildSnowLayer({
      count: 4500,
      box: new Vector3(36, 30, 36),
      size: 36,
      maxSize: 14,
      seed: 12,
    });
    this.snow.name = 'Snowfall';
    add(this.snow);

    this.drift = buildSnowLayer({
      count: 2000,
      box: new Vector3(26, 2.4, 26),
      size: 16,
      maxSize: 7,
      seed: 31,
    });
    this.drift.name = 'Spindrift';
    add(this.drift);

    this.veil = new Mesh(
      new SphereGeometry(950, 24, 12),
      new MeshBasicMaterial({
        color: STORM_FOG,
        side: BackSide,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        fog: false,
      }),
    );
    this.veil.renderOrder = -1e8;
    this.veil.frustumCulled = false;
    this.veil.name = 'StormVeil';
    add(this.veil);

    const rand = mulberry32(77);
    const textures = [cloudTexture(1), cloudTexture(2), cloudTexture(3)];
    for (let i = 0; i < CLOUD_COUNT; i++) {
      const sprite = new Sprite(
        new SpriteMaterial({
          map: textures[i % textures.length],
          transparent: true,
          depthWrite: false,
          opacity: 0.7,
        }),
      );
      const low = i < 8; // mist banks that hang around the cliff band
      const angle = rand() * Math.PI * 2;
      const radius = low ? 30 + rand() * 60 : 140 + rand() * 360;
      sprite.position.set(
        Math.sin(angle) * radius,
        low ? 24 + rand() * 12 : 60 + rand() * 70,
        -50 + Math.cos(angle) * radius,
      );
      const size = low ? 40 + rand() * 30 : 120 + rand() * 140;
      sprite.scale.set(size, size * 0.45, 1);
      sprite.name = 'Cloud';
      add(sprite);
      this.clouds.push({ sprite, base: low ? 0.5 : 0.75 });
    }
  }

  private targetStorm(): number {
    const s = -this.head.z;
    switch (game.phase.peek()) {
      case Phase.Poling:
        return 0.2 + 0.6 * smoothstep(15, 65, s);
      case Phase.Climbing:
        return 0.88;
      case Phase.Building:
        return 0.12;
      case Phase.Launch:
        return 0.05;
      case Phase.Gliding:
        return 0.1;
      default:
        return 0.3;
    }
  }

  update(delta: number, time: number): void {
    const dt = Math.min(delta, 0.1);
    getHeadWorld(this.world, this.head);

    if (game.stormOverride !== null) this.storm = game.stormOverride;
    else this.storm += (this.targetStorm() - this.storm) * (1 - Math.exp(-dt / 4));
    const storm = this.storm;
    const gust = 0.5 + 0.5 * valueNoise(time * 0.35, 3.1);
    const windYaw = 0.6 + valueNoise(time * 0.04, 9.7) * 1.3;
    const windSpeed = 0.6 + storm * (2.5 + 5 * gust);
    const wx = Math.cos(windYaw) * windSpeed;
    const wz = Math.sin(windYaw) * windSpeed;

    // Falling snow: denser and more wind-driven as the storm builds.
    this.snowOffset.x += wx * dt;
    this.snowOffset.z += wz * dt;
    this.snowOffset.y -= (0.85 + storm * 0.7) * dt;
    const snow = (this.snow.material as ShaderMaterial).uniforms;
    snow.uTime.value = time;
    (snow.uCenter.value as Vector3).copy(this.head);
    (snow.uOffset.value as Vector3).copy(this.snowOffset);
    snow.uIntensity.value = 0.25 + storm * 0.75;

    // Spindrift: snow blown along the ground in strong wind.
    this.driftOffset.x += wx * 1.8 * dt;
    this.driftOffset.z += wz * 1.8 * dt;
    this.driftOffset.y += Math.sin(time * 1.3) * 0.3 * dt;
    const drift = (this.drift.material as ShaderMaterial).uniforms;
    drift.uTime.value = time;
    (drift.uCenter.value as Vector3).set(this.head.x, this.player.position.y + 0.9, this.head.z);
    (drift.uOffset.value as Vector3).copy(this.driftOffset);
    drift.uOpacity.value = smoothstep(1.8, 5.5, windSpeed) * 0.75;

    // Visibility closes in during the storm.
    const fog = this.scene.fog as Fog | null;
    this.fogColor.copy(FOG_COLOR).lerp(STORM_FOG, storm);
    if (fog) {
      fog.color.copy(this.fogColor);
      fog.near = 140 + (6 - 140) * storm;
      fog.far = 1500 + (110 - 1500) * Math.pow(storm, 0.7);
    }
    const veilMaterial = this.veil.material as MeshBasicMaterial;
    veilMaterial.color.copy(this.fogColor);
    veilMaterial.opacity = smoothstep(0.15, 0.9, storm) * 0.85;
    this.veil.visible = veilMaterial.opacity > 0.01;
    this.veil.position.copy(this.head);

    // Sun dims behind the clouds.
    const sun = sceneRefs.sunLight as DirectionalLight | null;
    if (sun) sun.intensity = 1.9 * (1 - 0.65 * storm);
    const sunSprite = sceneRefs.sunSprite as Sprite | null;
    if (sunSprite) (sunSprite.material as SpriteMaterial).opacity = 1 - storm * 0.95;

    // Clouds drift with the wind and darken in the storm.
    this.cloudTint.setRGB(1, 1, 1).lerp(STORM_FOG, storm * 0.8);
    for (const cloud of this.clouds) {
      const p = cloud.sprite.position;
      p.x += wx * 0.35 * dt;
      p.z += wz * 0.35 * dt;
      const dx = p.x;
      const dz = p.z + 50;
      if (dx * dx + dz * dz > 520 * 520) {
        p.x = -p.x * 0.95;
        p.z = -50 - dz * 0.95;
      }
      const material = cloud.sprite.material as SpriteMaterial;
      material.opacity = cloud.base * (0.55 + 0.45 * storm);
      material.color.copy(this.cloudTint);
    }

    // Wind audio follows both the weather and the glide speed.
    const weatherWind = storm * (0.2 + 0.6 * gust);
    audio.setWind(Math.max(weatherWind, Math.min(1, game.airspeed / 12)));
    const gustHigh = gust > 0.82 && storm > 0.5;
    if (gustHigh && !this.gustWasHigh) audio.whoosh();
    this.gustWasHigh = gustHigh;
  }
}
