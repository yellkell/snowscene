/**
 * Dynamic mountain weather.
 *
 * A single "storm" value (0 = clear, 1 = blizzard) follows the journey:
 * light snow at the trailhead, thickening as you pole uphill, a gusty
 * blizzard on the cliff, then the sky clears at the summit for a golden
 * glide home and a gentle snowfall after landing. Storm and gusting wind
 * drive snowfall density, wind drift, blowing ground snow (spindrift),
 * the overcast sky, image-based lighting, fog and aerial haze, the cloud
 * sea, sunlight, snow glints and wind audio.
 */

import {
  BufferGeometry,
  Color,
  createSystem,
  Float32BufferAttribute,
  Fog,
  Points,
  ShaderMaterial,
  Vector3,
} from '@iwsdk/core';
import { audio } from './audio.js';
import { landUniforms } from './land-material.js';
import { fogCullables } from './fog-cull.js';
import { forestUniforms } from './trees.js';
import { currentLevel, type FogRange } from './level.js';
import { getHeadWorld } from './rig.js';
import { sceneRefs } from './scene-system.js';
import { cloudSeaUniforms, skyUniforms } from './sky.js';
import { game } from './state.js';
import { mulberry32, RANGES_INNER_RADIUS, smoothstep, TUTORIAL_CENTER_X, TUTORIAL_CENTER_Z, valueNoise } from './terrain.js';
import { FOG_COLOR } from './world-builders.js';

// Cool blue-grey rather than white: distance reads as depth, not whiteout.
const STORM_FOG = new Color(0.62, 0.67, 0.76);
const CAVE_FOG = new Color(0.035, 0.09, 0.16);
const SUN_BASE = 3.2;

/**
 * Live weather values for other systems, and optional fog colours that
 * replace the tutorial's (the expedition sky retints them by time of day;
 * null keeps FOG_COLOR / STORM_FOG).
 */
export const weatherHooks = {
  /** Current (smoothed) storm level 0..1. */
  storm: 0,
  clearFog: null as Color | null,
  stormFog: null as Color | null,
  /** Falling-snow colour (display space; null = white). Dimmed at night. */
  snowTint: null as Color | null,
};
const SNOW_WHITE = new Color(1, 1, 1);

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
      uVelocity: { value: new Vector3() },
      uSize: { value: opts.size },
      uMaxSize: { value: opts.maxSize },
      uIntensity: { value: 1 },
      uOpacity: { value: 1 },
      uTint: { value: new Color(1, 1, 1) },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uCenter;
      uniform vec3 uBox;
      uniform vec3 uOffset;
      uniform vec3 uVelocity;
      uniform float uSize;
      uniform float uMaxSize;
      uniform float uIntensity;
      uniform float uOpacity;
      attribute float aSeed;
      varying float vAlpha;
      varying vec2 vDir;
      varying float vStretch;
      void main() {
        float speedVar = 0.75 + aSeed * 0.5;
        vec3 p = position * uBox + uOffset * speedVar;
        p.x += sin(uTime * 0.6 + aSeed * 30.0) * 0.4;
        p.z += cos(uTime * 0.45 + aSeed * 17.0) * 0.3;
        p = mod(p - uCenter + 0.5 * uBox, uBox) + uCenter - 0.5 * uBox;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        // Motion streak: where this flake will be a moment from now, on screen.
        vec4 ahead = projectionMatrix * (modelViewMatrix * vec4(p + uVelocity * speedVar * 0.045, 1.0));
        vec2 d = ahead.xy / ahead.w - gl_Position.xy / gl_Position.w;
        float on = step(aSeed, uIntensity);
        float base = min(uSize * (0.45 + aSeed * 0.7) / max(-mv.z, 0.1), uMaxSize);
        float streakPx = length(d) * 600.0;
        vStretch = clamp(1.0 + streakPx / max(base, 1.0), 1.0, 2.5);
        vDir = length(d) > 1e-6 ? normalize(vec2(d.x, -d.y)) : vec2(0.0, 1.0);
        gl_PointSize = on * base * vStretch;
        float r = length((p - uCenter) / (0.5 * uBox));
        vAlpha = on * (1.0 - smoothstep(0.55, 1.0, r)) * uOpacity;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uTint;
      varying float vAlpha;
      varying vec2 vDir;
      varying float vStretch;
      void main() {
        vec2 pc = gl_PointCoord - 0.5;
        // Elliptical flake stretched along its screen-space motion.
        float along = dot(pc, vDir);
        float across = dot(pc, vec2(-vDir.y, vDir.x)) * vStretch;
        float a = smoothstep(0.5, 0.1, length(vec2(along, across))) * vAlpha;
        if (a < 0.02) discard;
        gl_FragColor = vec4(uTint, a);
      }
    `,
    transparent: true,
    depthWrite: false,
  });
  const points = new Points(geometry, material);
  points.frustumCulled = false;
  return points;
}

export class WeatherSystem extends createSystem({}) {
  private snow!: Points;
  private drift!: Points;
  private storm = -1;
  private gustWasHigh = false;
  private readonly head = new Vector3();
  private readonly snowOffset = new Vector3();
  private readonly driftOffset = new Vector3();
  private readonly fogColor = new Color();
  private readonly fogRange: FogRange = { near: 0, far: 0 };
  private stormLighting = false;

  init(): void {
    const add = (object: Parameters<typeof this.world.createTransformEntity>[0]) =>
      this.world.createTransformEntity(object, { persistent: true });

    // Point sprites right in front of the eyes are the most expensive pixels
    // in a blizzard (the cliff climb is all snow and rock face), so keep the
    // count and the on-screen size of the nearest flakes in check.
    this.snow = buildSnowLayer({
      count: 3200,
      box: new Vector3(30, 24, 30),
      size: 36,
      maxSize: 10,
      seed: 12,
    });
    this.snow.name = 'Snowfall';
    add(this.snow);

    this.drift = buildSnowLayer({
      count: 1200,
      box: new Vector3(24, 2.4, 24),
      size: 16,
      maxSize: 6,
      seed: 31,
    });
    this.drift.name = 'Spindrift';
    add(this.drift);

  }

  update(delta: number, time: number): void {
    const dt = Math.min(delta, 0.1);
    getHeadWorld(this.world, this.head);

    if (game.stormOverride !== null) this.storm = game.stormOverride;
    else if (this.storm < 0) this.storm = currentLevel().stormTarget(this.head); // start in the weather, not clear air
    else this.storm += (currentLevel().stormTarget(this.head) - this.storm) * (1 - Math.exp(-dt / 3.2));
    const storm = this.storm;
    weatherHooks.storm = storm;
    const gust = 0.5 + 0.5 * valueNoise(time * 0.35, 3.1);
    const windYaw = 0.6 + valueNoise(time * 0.04, 9.7) * 1.3;
    const windSpeed = 0.6 + storm * (3.5 + 8.5 * gust * gust);
    forestUniforms.uTime.value = time;
    forestUniforms.uWind.value = 0.35 + windSpeed * 0.12;
    const wx = Math.cos(windYaw) * windSpeed;
    const wz = Math.sin(windYaw) * windSpeed;

    // Falling snow: denser and more wind-driven as the storm builds.
    this.snowOffset.x += wx * dt;
    this.snowOffset.z += wz * dt;
    const fall = 0.85 + storm * 0.9;
    this.snowOffset.y -= fall * dt;
    const snow = (this.snow.material as ShaderMaterial).uniforms;
    snow.uTime.value = time;
    (snow.uCenter.value as Vector3).copy(this.head);
    (snow.uOffset.value as Vector3).copy(this.snowOffset);
    (snow.uVelocity.value as Vector3).set(wx, -fall, wz);
    // Indoors (the ice cave) the weather stands down entirely.
    const outdoors = 1 - game.indoors;
    snow.uIntensity.value = (0.18 + storm * 0.82) * outdoors;
    this.snow.visible = snow.uIntensity.value > 0.01;
    (snow.uTint.value as Color).copy(weatherHooks.snowTint ?? SNOW_WHITE);

    // Spindrift: snow blown along the ground in strong wind.
    this.driftOffset.x += wx * 1.8 * dt;
    this.driftOffset.z += wz * 1.8 * dt;
    this.driftOffset.y += Math.sin(time * 1.3) * 0.3 * dt;
    const drift = (this.drift.material as ShaderMaterial).uniforms;
    drift.uTime.value = time;
    (drift.uCenter.value as Vector3).set(this.head.x, this.player.position.y + 0.9, this.head.z);
    (drift.uOffset.value as Vector3).copy(this.driftOffset);
    (drift.uVelocity.value as Vector3).set(wx * 1.8, 0, wz * 1.8);
    drift.uOpacity.value = smoothstep(1.8, 5.5, windSpeed) * 0.75 * outdoors;
    // Invisible spindrift still rasterises every flake: skip the draw.
    this.drift.visible = drift.uOpacity.value > 0.01;
    (drift.uTint.value as Color).copy(weatherHooks.snowTint ?? SNOW_WHITE);

    // Visibility closes in during the storm; in clear air only the far
    // ranges pick up aerial haze.
    const fog = this.scene.fog as Fog | null;
    this.fogColor.copy(weatherHooks.clearFog ?? FOG_COLOR).lerp(weatherHooks.stormFog ?? STORM_FOG, storm);
    const level = currentLevel();
    let near = 400 + (6 - 400) * storm;
    let far = 24000 + (80 - 24000) * Math.pow(storm, 0.6);
    if (level.fogRange) {
      level.fogRange(storm, this.fogRange);
      near = this.fogRange.near;
      far = this.fogRange.far;
    }
    // Inside the ice cave: a deep blue haze of its own.
    if (game.indoors > 0) {
      const k = game.indoors;
      this.fogColor.lerp(CAVE_FOG, k);
      near += (4 - near) * k;
      far += (48 - far) * k;
    }
    // Scenery wholly inside the fog costs triangles for nothing: skip it.
    for (const item of fogCullables) {
      const d = item.center.distanceTo(this.head) - item.radius;
      item.object.visible = d < Math.min(far + 10, item.maxDistance ?? Infinity);
      if (item.lod && item.object.visible) {
        const distant = d > item.lod.distance;
        item.lod.far.visible = distant;
        for (const o of item.lod.near) o.visible = !distant;
      }
    }
    // Ranges lost in the fog likewise.
    const ranges = sceneRefs.farRanges;
    if (ranges) {
      const toRanges = RANGES_INNER_RADIUS - Math.hypot(this.head.x - TUTORIAL_CENTER_X, this.head.z - TUTORIAL_CENTER_Z);
      ranges.visible = far > toRanges - 20 || game.indoors > 0;
    }
    // Let the sky take the fog colour as visibility closes in.
    skyUniforms.uFogColor.value.copy(this.fogColor);
    skyUniforms.uFogBlend.value = Math.min(1, Math.max(0, (1600 - far) / 1400));
    if (fog) {
      fog.color.copy(this.fogColor);
      fog.near = near;
      fog.far = far;
    }
    cloudSeaUniforms.uHazeColor.value.copy(this.fogColor);
    cloudSeaUniforms.uHazeNear.value = near;
    cloudSeaUniforms.uHazeFar.value = far;
    cloudSeaUniforms.uStorm.value = storm;

    // Overcast sky and lighting.
    skyUniforms.uStorm.value = smoothstep(0.1, 0.85, storm);
    const stormLighting = storm > 0.5;
    if (stormLighting !== this.stormLighting) {
      this.stormLighting = stormLighting;
      const env = stormLighting ? sceneRefs.stormEnvironment : sceneRefs.clearEnvironment;
      if (env) this.scene.environment = env;
    }
    // Indoors the (warm, outdoor) sky light all but goes: the cave's own icy fill takes over.
    this.scene.environmentIntensity = (stormLighting ? 1.25 : 1 + storm * 0.3) * (1 - 0.94 * game.indoors);
    const sun = sceneRefs.sunLight;
    if (sun) sun.intensity = SUN_BASE * (1 - 0.8 * smoothstep(0.1, 0.8, storm));
    landUniforms.uSparkle.value = 3 * (1 - smoothstep(0.15, 0.6, storm));

    // Wind audio follows both the weather and the glide speed.
    const weatherWind = storm * (0.3 + 0.7 * gust);
    audio.setWind(Math.max(weatherWind * outdoors, Math.min(1, game.airspeed / 12)));
    audio.setStorm(storm * outdoors, gust);
    const gustHigh = gust > 0.78 && storm > 0.45 && outdoors > 0.5;
    if (gustHigh && !this.gustWasHigh) audio.whoosh();
    this.gustWasHigh = gustHigh;
  }
}
