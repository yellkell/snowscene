/**
 * Sky, sun, moon and time of day for the expedition.
 *
 * While `exp.active` is set, every frame (after SceneSetup and Weather, so
 * it has the last word on lighting):
 *
 *  - puts the sun and moon where `expFrame.timeOfDay` says (sky-math.ts),
 *    publishes sunDirection / moonDirection / daylight / aurora on expFrame;
 *  - drives the Preetham sky (plus its night/twilight hook), the single
 *    DirectionalLight (sun by day; cool, dim, shadow-casting moonlight by
 *    night), tone mapping exposure, fog, the cloud-sea tint, snow glints,
 *    the headlamp gain, and image-based lighting blended from lazily baked
 *    keyframes (sky-environment.ts);
 *  - draws the night sky (night-sky.ts) and the cloud deck from both sides
 *    with a whiteout as you climb through it (cloud-deck.ts).
 *
 * When the expedition is not active it does nothing (the tutorial look is
 * untouched); if it stops, the tutorial values are restored once.
 *
 * Register after WeatherSystem (21), e.g. priority 23, and after the
 * director (which writes expFrame.timeOfDay).
 */

import { Color, createSystem, type Fog, Vector3 } from '@iwsdk/core';
import { landUniforms } from '../../land-material.js';
import { getHeadWorld } from '../../rig.js';
import { sceneRefs } from '../../scene-system.js';
import { cloudSeaUniforms, setSunDirection, skyUniforms } from '../../sky.js';
import { game } from '../../state.js';
import { landTextures } from '../../textures.js';
import { valueNoise } from '../../terrain.js';
import { weatherHooks } from '../../weather-system.js';
import { EXP_CLOUD_DECK_Y, timeOfDayAt } from '../exp-layout.js';
import { exp, expFrame } from '../exp-state.js';
import { CloudDeck, deckUniforms } from './cloud-deck.js';
import { headlamp } from './headlamp.js';
import { NightSky, type NightSkyState } from './night-sky.js';
import { SkyEnvironment } from './sky-environment.js';
import {
  auroraWindow,
  clamp01,
  computePalette,
  createPalette,
  displayFromScene,
  meteorRate,
  moonDirectionAt,
  type RGB,
  smooth,
  sunDirectionAt,
} from './sky-math.js';

/** Whiteout: full within this many metres of the deck, gone by WHITEOUT_OUT. */
const WHITEOUT_IN = 18;
const WHITEOUT_OUT = 55;
/** Below the deck by this much the overcast ceiling is fully overhead. */
const UNDER_DEPTH = 90;
/** How far ahead (route metres) to pre-bake lighting keyframes. */
const PREFETCH_AHEAD = 320;

/** Values the expedition overrides, captured on activation and restored after. */
interface Snapshot {
  exposure: number;
  sunDir: Vector3;
  lightColor: Color;
  stormColor: Color;
  cloudSun: Color;
  cloudShadow: Color;
}

export class ExpeditionSkySystem extends createSystem({}) {
  private env: SkyEnvironment | null = null;
  private night: NightSky | null = null;
  private deck: CloudDeck | null = null;
  private active = false;
  private warmFrames = 0;
  private prefetchTimer = 0;
  private aurora = 0;
  private snapshot: Snapshot | null = null;

  private readonly palette = createPalette();
  private readonly futurePalette = createPalette();
  private readonly head = new Vector3();
  private readonly sun = new Vector3();
  private readonly moon = new Vector3();
  private readonly light = new Vector3();
  private readonly futureSun = new Vector3();
  private readonly futureMoon = new Vector3();
  private readonly clearFog = new Color();
  private readonly stormFog = new Color();
  private readonly whiteFog = new Color();
  private readonly snowTint = new Color();
  private readonly mist = new Color();
  private readonly mistTop = new Color();
  private readonly hazePre = new Color();
  private readonly whitePre = new Color();
  private readonly rgbA: RGB = { r: 0, g: 0, b: 0 };
  private readonly rgbB: RGB = { r: 0, g: 0, b: 0 };
  private readonly nightState: NightSkyState = {
    head: new Vector3(),
    time: 0,
    dt: 0,
    hours: 0,
    sun: new Vector3(),
    moon: new Vector3(),
    stars: 0,
    moonAlpha: 0,
    moonHalo: 0,
    night: 0,
    aurora: 0,
    meteorRate: 0,
  };

  update(delta: number, time: number): void {
    const on = exp.active.peek();
    if (!on) {
      if (this.active) this.deactivate();
      return;
    }
    if (!this.active) this.activate();
    const dt = Math.min(delta, 0.1);
    getHeadWorld(this.world, this.head);

    const hours = expFrame.timeOfDay;
    sunDirectionAt(hours, this.sun);
    moonDirectionAt(hours, this.moon);
    expFrame.sunDirection.copy(this.sun);
    expFrame.moonDirection.copy(this.moon);

    // --- where we are relative to the cloud deck
    const dy = this.head.y - EXP_CLOUD_DECK_Y;
    // Denser and thinner patches as you move through the cloud (0..1).
    const patch = 0.5 + 0.5 * valueNoise(this.head.x * 0.012 + time * 0.05, this.head.z * 0.012);
    const whiteout = 1 - smooth(WHITEOUT_IN, WHITEOUT_OUT + 15 * patch, Math.abs(dy));
    const under = smooth(8, UNDER_DEPTH, -dy);

    const storm = weatherHooks.storm;
    const skyStorm = smooth(0.1, 0.85, storm);
    const overcast = clamp01(Math.max(skyStorm, under * 0.8, whiteout));
    const pal = computePalette(this.palette, this.sun, this.moon, Math.max(skyStorm, whiteout));
    expFrame.daylight = pal.daylight;

    // --- image-based lighting (bakes at most one keyframe per frame)
    this.updateEnvironment(dt, hours, pal.sunAltitude, overcast);
    const scene = this.scene;
    const env = this.env?.texture ?? null;
    if (env) scene.environment = env;
    scene.environmentIntensity = (1 + 0.25 * overcast) * pal.envBoost;
    this.world.renderer.toneMappingExposure = pal.exposure;

    // --- the one directional light: sun by day, moon by night
    this.light.set(pal.lightDir.x, Math.max(0.03, pal.lightDir.y), pal.lightDir.z).normalize();
    const lightI =
      pal.lightIntensity * (1 - 0.8 * skyStorm) * (1 - 0.45 * under) * (1 - 0.75 * whiteout);
    const sunLight = sceneRefs.sunLight;
    if (sunLight) {
      sunLight.color.setRGB(pal.lightColor.r, pal.lightColor.g, pal.lightColor.b);
      sunLight.intensity = lightI;
      sunLight.position.copy(sunLight.target.position).addScaledVector(this.light, 200);
      // Softer shadows under the overcast and in cloud.
      sunLight.shadow.intensity = 1 - 0.4 * under - 0.4 * whiteout;
    }
    landUniforms.uSunDir.value.copy(this.light);
    // The snow's grazing sheen fades with the light (a faint moonlit edge at night).
    landUniforms.uLandSheen.value = 0.03 + 0.07 * pal.daylight;
    landUniforms.uSparkle.value =
      3 * (1 - smooth(0.15, 0.6, storm)) * Math.min(1, lightI / 1.2) * (1 - 0.7 * under);
    headlamp.gain = Math.max(0.3, Math.min(1, 0.56 / pal.exposure));

    // --- sky dome
    setSunDirection(this.sun);
    skyUniforms.uSkyGain.value = pal.skyGain;
    skyUniforms.uNightZenith.value.setRGB(pal.nightZenith.r, pal.nightZenith.g, pal.nightZenith.b);
    skyUniforms.uNightHorizon.value.setRGB(pal.nightHorizon.r, pal.nightHorizon.g, pal.nightHorizon.b);
    skyUniforms.uTwilightGlow.value.setRGB(pal.twilightGlow.r, pal.twilightGlow.g, pal.twilightGlow.b);
    // In-cloud colour (scene-linear and display) for the whiteout.
    this.rgbA.r = pal.underColor.r * 1.3;
    this.rgbA.g = pal.underColor.g * 1.3;
    this.rgbA.b = pal.underColor.b * 1.3;
    this.whitePre.setRGB(this.rgbA.r, this.rgbA.g, this.rgbA.b);
    displayFromScene(this.rgbA, pal.exposure, this.rgbB);
    this.whiteFog.setRGB(this.rgbB.r, this.rgbB.g, this.rgbB.b);
    skyUniforms.uStormColor.value.setRGB(pal.stormSky.r, pal.stormSky.g, pal.stormSky.b).lerp(this.whitePre, whiteout);
    skyUniforms.uStorm.value = Math.max(skyUniforms.uStorm.value, whiteout);

    // --- fog (display space) and the cloud-sea haze (scene-linear)
    this.clearFog.setRGB(pal.clearFog.r, pal.clearFog.g, pal.clearFog.b);
    this.stormFog.setRGB(pal.stormFog.r, pal.stormFog.g, pal.stormFog.b);
    // Under the overcast ceiling distant air greys over.
    this.clearFog.lerp(this.stormFog, 0.55 * under);
    weatherHooks.clearFog = this.clearFog;
    weatherHooks.stormFog = this.stormFog;
    const fog = scene.fog as Fog | null;
    this.hazePre
      .setRGB(pal.horizon.r, pal.horizon.g, pal.horizon.b)
      .lerp(skyUniforms.uStormColor.value, Math.max(skyStorm, 0.6 * under))
      .lerp(this.whitePre, whiteout);
    cloudSeaUniforms.uHazeColor.value.copy(this.hazePre);
    if (fog) {
      fog.color.copy(this.clearFog).lerp(this.stormFog, storm).lerp(this.whiteFog, whiteout);
      skyUniforms.uFogColor.value.copy(fog.color);
      // The faintest green cast in the air under a strong aurora.
      fog.color.g += 0.014 * this.aurora;
      fog.color.b += 0.004 * this.aurora;
      // Whiteout: visibility closes to a few tens of metres inside the cloud.
      fog.near += (0.5 - fog.near) * whiteout;
      fog.far += (32 + 30 * patch - fog.far) * whiteout;
      cloudSeaUniforms.uHazeNear.value = fog.near;
      cloudSeaUniforms.uHazeFar.value = fog.far;
      // Falling snow is unlit: at night it takes the air's colour, brightened
      // a little (it catches the moon and the headlamp), instead of glowing white.
      const k = 2.3 + (1.35 - 2.3) * pal.daylight;
      this.snowTint.copy(fog.color).multiplyScalar(k);
      this.snowTint.setRGB(Math.min(1, this.snowTint.r), Math.min(1, this.snowTint.g), Math.min(1, this.snowTint.b));
      weatherHooks.snowTint = this.snowTint;
    }

    // --- cloud deck tint (the far sea, the near deck and the underside)
    cloudSeaUniforms.uSunDir.value.copy(this.light);
    cloudSeaUniforms.uSunColor.value.setRGB(pal.cloudSun.r, pal.cloudSun.g, pal.cloudSun.b);
    cloudSeaUniforms.uShadowColor.value.setRGB(pal.cloudShadow.r, pal.cloudShadow.g, pal.cloudShadow.b);
    cloudSeaUniforms.uTint.value.setRGB(pal.cloudTint.r, pal.cloudTint.g, pal.cloudTint.b);
    deckUniforms.uUnderColor.value.setRGB(pal.underColor.r, pal.underColor.g, pal.underColor.b);
    deckUniforms.uUnderGlow.value.setRGB(pal.underGlow.r, pal.underGlow.g, pal.underGlow.b);
    this.deck?.update(this.head, true);
    // Land wreathed in mist where it meets the deck (display space, like fog):
    // the cloud base colour from below, the sunlit tops from above.
    this.rgbA.r = pal.underColor.r * 1.1;
    this.rgbA.g = pal.underColor.g * 1.1;
    this.rgbA.b = pal.underColor.b * 1.1;
    displayFromScene(this.rgbA, pal.exposure, this.rgbB);
    this.mist.setRGB(this.rgbB.r, this.rgbB.g, this.rgbB.b);
    this.rgbA.r = pal.cloudTint.r * (0.95 + 0.25 * pal.cloudSun.r);
    this.rgbA.g = pal.cloudTint.g * (0.95 + 0.25 * pal.cloudSun.g);
    this.rgbA.b = pal.cloudTint.b * (0.95 + 0.25 * pal.cloudSun.b);
    displayFromScene(this.rgbA, pal.exposure, this.rgbB);
    this.mistTop.setRGB(this.rgbB.r, this.rgbB.g, this.rgbB.b);
    this.mist.lerp(this.mistTop, smooth(-25, 25, dy)).lerp(this.whiteFog, whiteout);
    landUniforms.uDeckY.value = EXP_CLOUD_DECK_Y;
    landUniforms.uDeckMist.value.copy(this.mist);
    landUniforms.uDeckMistStrength.value = 0.88;

    // --- night sky
    const darkness = 1 - smooth(-12, -3, pal.sunAltitude);
    const clear = (1 - smooth(0.1, 0.5, storm)) * (1 - whiteout) * (1 - under);
    const auroraTarget = auroraWindow(hours) * darkness * clear;
    this.aurora += (auroraTarget - this.aurora) * (1 - Math.exp(-dt / 4));
    expFrame.aurora = this.aurora;
    const ns = this.nightState;
    ns.head.copy(this.head);
    ns.time = time;
    ns.dt = dt;
    ns.hours = hours;
    ns.sun.copy(this.sun);
    ns.moon.copy(this.moon);
    ns.stars = darkness * clear;
    ns.moonAlpha = (0.3 + 0.7 * darkness) * (1 - smooth(0.2, 0.65, storm)) * (1 - whiteout) * (1 - under);
    ns.moonHalo = (0.5 + 1.6 * smooth(0.05, 0.4, storm)) * darkness;
    ns.night = darkness;
    ns.aurora = this.aurora * (0.8 + 0.2 * Math.sin(time * 0.045));
    ns.meteorRate = meteorRate(hours, darkness * clear);
    if (this.night) {
      this.night.update(ns);
      if (this.warmFrames > 0) this.night.group.traverse(showAll);
    }
    if (this.warmFrames > 0) this.warmFrames--;
  }

  private updateEnvironment(dt: number, hours: number, sunAltitude: number, overcast: number): void {
    const env = this.env;
    if (!env) return;
    const fading = game.fade > 0.25;
    // Missing keys needed right now are baked immediately (one per frame).
    const baked = env.update(hours, sunAltitude, overcast, 1);
    if (baked > 0 || env.complete) return;
    if (fading) {
      // Behind the white fade, bake ahead: nobody sees the hitch.
      env.bakeNearest(hours, sunAltitude);
      return;
    }
    // Otherwise only bake what the next stretch of route will need, rarely.
    this.prefetchTimer -= dt;
    if (this.prefetchTimer > 0) return;
    this.prefetchTimer = 2;
    const future = timeOfDayAt(expFrame.s + PREFETCH_AHEAD);
    sunDirectionAt(future, this.futureSun);
    moonDirectionAt(future, this.futureMoon);
    const fp = computePalette(this.futurePalette, this.futureSun, this.futureMoon, 0);
    if (!env.prefetch(future, fp.sunAltitude, 0)) env.prefetch(future, fp.sunAltitude, 1);
  }

  private activate(): void {
    this.active = true;
    const renderer = this.world.renderer;
    const sunLight = sceneRefs.sunLight;
    if (!this.snapshot) {
      this.snapshot = {
        exposure: renderer.toneMappingExposure,
        sunDir: new Vector3().copy(landUniforms.uSunDir.value),
        lightColor: sunLight ? sunLight.color.clone() : new Color(1, 0.8, 0.6),
        stormColor: skyUniforms.uStormColor.value.clone(),
        cloudSun: cloudSeaUniforms.uSunColor.value.clone(),
        cloudShadow: cloudSeaUniforms.uShadowColor.value.clone(),
      };
    }
    if (!this.env) this.env = new SkyEnvironment(renderer);
    if (!this.deck) {
      this.deck = new CloudDeck();
      this.world.createTransformEntity(this.deck.underside, { persistent: true });
      this.world.createTransformEntity(this.deck.near, { persistent: true });
    }
    if (!this.night) {
      this.night = new NightSky(landTextures().noise);
      this.world.createTransformEntity(this.night.group, { persistent: true });
    }
    this.night.group.visible = true;
    // The headlamp joins the scene now, while the screen is faded: adding a
    // light recompiles every lit shader once.
    headlamp.ensure();
    // Render every night-sky layer (at zero strength) for a couple of frames
    // so their shaders compile behind the fade, not mid-climb.
    this.warmFrames = 3;
    this.aurora = 0;
  }

  private deactivate(): void {
    this.active = false;
    const snap = this.snapshot;
    const { renderer, scene } = this.world;
    if (this.night) this.night.group.visible = false;
    this.deck?.update(this.head, false);
    weatherHooks.clearFog = null;
    weatherHooks.stormFog = null;
    weatherHooks.snowTint = null;
    landUniforms.uDeckMistStrength.value = 0;
    landUniforms.uLandSheen.value = 0.1;
    skyUniforms.uSkyGain.value = 1;
    skyUniforms.uNightZenith.value.setRGB(0, 0, 0);
    skyUniforms.uNightHorizon.value.setRGB(0, 0, 0);
    skyUniforms.uTwilightGlow.value.setRGB(0, 0, 0);
    cloudSeaUniforms.uTint.value.setRGB(1, 1, 1);
    headlamp.gain = 1;
    if (sceneRefs.sunLight) sceneRefs.sunLight.shadow.intensity = 1;
    const env = weatherHooks.storm > 0.5 ? sceneRefs.stormEnvironment : sceneRefs.clearEnvironment;
    if (env) scene.environment = env;
    if (!snap) return;
    renderer.toneMappingExposure = snap.exposure;
    setSunDirection(snap.sunDir);
    landUniforms.uSunDir.value.copy(snap.sunDir);
    cloudSeaUniforms.uSunDir.value.copy(snap.sunDir);
    if (sceneRefs.sunLight) sceneRefs.sunLight.color.copy(snap.lightColor);
    skyUniforms.uStormColor.value.copy(snap.stormColor);
    cloudSeaUniforms.uSunColor.value.copy(snap.cloudSun);
    cloudSeaUniforms.uShadowColor.value.copy(snap.cloudShadow);
  }
}

function showAll(o: { visible: boolean }): void {
  o.visible = true;
}
