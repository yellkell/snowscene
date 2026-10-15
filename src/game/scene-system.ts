/**
 * Builds the mountain world once and drives the ambient pieces: the sky and
 * sea of clouds that follow the viewer, the sun's shadow frustum that
 * tracks the player, the summit flag, snow puffs and the white fade used to
 * hide phase transitions.
 */

import {
  Color,
  createSystem,
  AgXToneMapping,
  CustomToneMapping,
  DirectionalLight,
  type Entity,
  Fog,
  Group,
  type InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PCFShadowMap,
  type Texture,
  Vector3,
  type WebGLRenderer,
} from '@iwsdk/core';
import { bakedView } from './baked/light.js';
import { caveView } from './cave/cave-baked.js';
import { FIRE_POS } from './campfire.js';
import { bakeFlag, type BakedFlag } from './baked/flag.js';
import { HoldGlowMaterial } from './baked/hold-glow.js';
import { loadTutorialWorld, type TutorialWorld } from './baked/tutorial-world.js';
import { weatherHooks } from './weather-system.js';
import { buildDepthClear } from './far-layer.js';
import { buildFarRanges } from './far-ranges.js';
import { ClimbHold } from './game-components.js';
import { landUniforms } from './land-material.js';
import { currentLevel } from './level.js';
import { getHeadWorld } from './rig.js';
import {
  bakeSkyEnvironment,
  buildCloudSea,
  buildSky,
  cloudSeaUniforms,
  setSunDirection,
} from './sky.js';
import { SnowPuffs } from './snow-puffs.js';
import { game, Phase } from './state.js';
import { LAKE_CENTER_Z } from './terrain.js';
import { buildForest } from './trees.js';
import { chunkInstanced, fogCullables } from './fog-cull.js';
import { splitMesh } from './baked/lod.js';
import {
  buildCabin,
  buildCliff,
  buildFadeSphere,
  buildHoldMesh,
  buildLake,
  buildRocks,
  buildSummitFlag,
  buildSummitSign,
  buildTerrain,
  buildTrailMarkers,
  buildTrailSign,
  FOG_COLOR,
  holdLayout,
  SUN_DIRECTION,
  waveFlag,
} from './world-builders.js';

/** Render resolution multiplier for the headset (crisper detail). */
const XR_RESOLUTION_SCALE = 1.0;
/** Half-size of the sun's shadow frustum that follows the player (metres). */
const SHADOW_EXTENT = 45;
/**
 * The shadow frustum only re-centres once you are this far (metres, across
 * the sun's view) from its centre. Its texel grid is fixed in the world, so a
 * re-centre changes nothing you can see, and in between it costs nothing.
 */
const SHADOW_RECENTRE = 3;
/** ...or this far along the sun's direction (the frustum is 400 m deep). */
const SHADOW_RECENTRE_DEPTH = 40;

/** Shared handles to scene pieces other systems need. */
export const sceneRefs = {
  puffs: null as SnowPuffs | null,
  /** Parent of everything that belongs only to the tutorial mountain. */
  tutorialRoot: null as Entity | null,
  sunLight: null as DirectionalLight | null,
  /** The tutorial's distant ranges (hidden while fog swallows them). */
  farRanges: null as Object3D | null,
  clearEnvironment: null as Texture | null,
  stormEnvironment: null as Texture | null,
  /** Analytic sky and cloud deck: hidden while a baked level brings its own sky. */
  sky: null as Mesh | null,
  cloudSea: null as Mesh | null,
  /** The bluff's parts (face and portal under root, the beacon deck). */
  bluff: null as { root: Object3D; deck: Mesh } | null,
  /** The lake party's bonfire (its objects show and hide with the fire). */
  party: null as { objects: Object3D[]; visible: boolean } | null,
  depthClear: null as Mesh | null,
};

/**
 * Switch between the tutorial's live look and a baked level's (Snow
 * Survivors): the baked level brings its own photographed sky, is lit by its
 * bake rather than the shadow-casting sun, and is graded with AgX, the view
 * transform its Cycles reference renders use.
 */
export function setBakedLook(renderer: WebGLRenderer, baked: boolean): void {
  // once the tutorial's own bake is in, both levels are baked
  if (bakedView.tutorialReady) baked = true;
  if (sceneRefs.sky) sceneRefs.sky.visible = !baked;
  if (sceneRefs.cloudSea) sceneRefs.cloudSea.visible = !baked;
  // with the baked skies nothing draws in the far depth layer any more: skip its depth clear
  if (sceneRefs.depthClear) sceneRefs.depthClear.visible = !baked;
  if (sceneRefs.sunLight) sceneRefs.sunLight.visible = !baked;
  bakedView.active = baked;
  renderer.toneMapping = baked ? AgXToneMapping : CustomToneMapping;
  renderer.toneMappingExposure = baked ? 1.0 : 0.56;
}

/** The holds glow on the approach and the climb; after that nothing reaches for them. */
const holdsInPlay = (): boolean => {
  const p = game.phase.peek();
  return p === Phase.Poling || p === Phase.Climbing;
};

export class SceneSetupSystem extends createSystem({}) {
  private flagCloth!: Mesh;
  private bakedFlag: BakedFlag | null = null;
  private fadeSphere!: Mesh;
  private puffs!: SnowPuffs;
  private sky!: Mesh;
  private cloudSea!: Mesh;
  private sun!: DirectionalLight;
  private readonly head = new Vector3();
  private flagFrame = 0;
  private shadowFrame = 0;
  /** The sun's view axes, the direction they were built for, and the frustum centre in them. */
  private readonly sunRight = new Vector3();
  private readonly sunUp = new Vector3();
  private readonly sunBack = new Vector3();
  private readonly sunDir = new Vector3();
  private readonly basis = new Matrix4();
  private readonly origin = new Vector3();
  private readonly shadowAt = new Vector3(Infinity, 0, 0);
  private baked: TutorialWorld | null = null;

  init(): void {
    const { renderer, scene } = this.world;
    // ACES with the game's grade on top (toon-style.ts).
    renderer.toneMapping = CustomToneMapping;
    // A touch under the old 0.62: sunlit snow keeps its shape instead of clipping to white.
    renderer.toneMappingExposure = 0.56;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
    // Shadows are refreshed only when the frustum moves (see update).
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    renderer.xr.setFramebufferScaleFactor(XR_RESOLUTION_SCALE);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio * 1.25, 2.5));
    scene.fog = new Fog(FOG_COLOR, 400, 24000);

    setSunDirection(SUN_DIRECTION);
    landUniforms.uSunDir.value.copy(SUN_DIRECTION);
    cloudSeaUniforms.uSunDir.value.copy(SUN_DIRECTION);
    // Image-based lighting baked from the sky itself, clear and overcast.
    sceneRefs.clearEnvironment = bakeSkyEnvironment(renderer, 0);
    sceneRefs.stormEnvironment = bakeSkyEnvironment(renderer, 1);
    scene.environment = sceneRefs.clearEnvironment;

    const add = (object: Object3D) =>
      this.world.createTransformEntity(object, { persistent: true });
    const tutorialGroup = new Group();
    tutorialGroup.name = 'TutorialRoot';
    const tutorialRoot = add(tutorialGroup);
    sceneRefs.tutorialRoot = tutorialRoot;
    const addTutorial = (object: Object3D) =>
      this.world.createTransformEntity(object, { parent: tutorialRoot, persistent: true });

    this.sky = buildSky();
    add(this.sky);
    sceneRefs.sky = this.sky;
    this.cloudSea = buildCloudSea();
    add(this.cloudSea);
    sceneRefs.cloudSea = this.cloudSea;
    // Distant scenery draws first in its own depth range; then depth clears.
    sceneRefs.depthClear = buildDepthClear();
    add(sceneRefs.depthClear);

    // Low golden sun with a shadow frustum that follows the player.
    this.sun = new DirectionalLight(new Color(1.0, 0.8, 0.6), 3.2);
    this.sun.name = 'Sun Light';
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const cam = this.sun.shadow.camera;
    cam.left = -SHADOW_EXTENT;
    cam.right = SHADOW_EXTENT;
    cam.top = SHADOW_EXTENT;
    cam.bottom = -SHADOW_EXTENT;
    cam.near = 1;
    cam.far = 400;
    this.sun.shadow.bias = -0.0004;
    // The sun is barely above the horizon, so most lit faces take it at a
    // grazing angle: a texel and a half of normal offset keeps them free of
    // acne (the striped crawl you'd otherwise see on the cabin's logs).
    this.sun.shadow.normalBias = 0.07;
    this.sun.position.copy(SUN_DIRECTION).multiplyScalar(200);
    this.sunAxes(SUN_DIRECTION);
    add(this.sun);
    add(this.sun.target);
    sceneRefs.sunLight = this.sun;

    const terrain = buildTerrain();
    addTutorial(terrain);
    const farRanges = buildFarRanges();
    sceneRefs.farRanges = farRanges;
    addTutorial(farRanges);
    // The procedural world: replaced by the Blender bake once it has loaded (baked/tutorial-world.ts).
    const replaced: Object3D[] = [
      buildForest(),
      chunkInstanced([buildRocks()], 100, 'Rocks'),
      buildCliff(),
      buildTrailMarkers(),
      buildTrailSign(),
      buildSummitSign(),
      buildCabin(-9.5, 4.5, 0.65),
      buildCabin(-36, LAKE_CENTER_Z + 14, 1.3),
      buildCabin(22, LAKE_CENTER_Z + 30, -0.9),
      buildLake(),
    ];
    for (const o of replaced) addTutorial(o);
    const holdMeshes: Mesh[] = [];
    const flag = buildSummitFlag();
    this.flagCloth = flag.cloth;
    const flagGroup = flag.group;
    addTutorial(flag.group);

    holdLayout().forEach((hold, i) => {
      const mesh = buildHoldMesh(i * 3.1);
      mesh.position.copy(hold.position);
      if (hold.lip) {
        // Bigger, level jugs for the final pull over the top.
        mesh.scale.setScalar(1.6);
        mesh.rotation.set(0, i * 1.3, 0);
      } else {
        mesh.rotation.set(i * 0.7, i * 1.3, i * 0.4);
      }
      mesh.name = `ClimbHold${i}`;
      // Thirty separate little draws: only worth it near the cliff.
      // and only until you're over the top (from the launch deck they were 31 additive halos for nothing)
      fogCullables.push({ object: mesh, center: mesh.position.clone(), radius: 0.4, maxDistance: 60, enabled: holdsInPlay });
      holdMeshes.push(mesh);
      addTutorial(mesh).addComponent(ClimbHold, { lip: hold.lip, glow: 0 });
    });

    this.puffs = new SnowPuffs();
    sceneRefs.puffs = this.puffs;
    add(this.puffs.points);
    this.fadeSphere = buildFadeSphere();
    add(this.fadeSphere);

    loadTutorialWorld()
      .then((w) => {
        this.baked = w;
        // the terrain as chunks the frustum and the fog can drop (it's one 80k-triangle mesh otherwise)
        terrain.visible = false;
        tutorialGroup.add(splitMesh((terrain as Mesh).geometry, w.groundMaterial, 'TerrainChunks', 14000, 60));
        for (const o of replaced) o.visible = false;
        if (sceneRefs.farRanges) sceneRefs.farRanges.visible = false;
        sceneRefs.farRanges = null;
        tutorialGroup.add(w.group);
        if (w.sky) tutorialGroup.add(w.sky);
        // the holds are carved into the baked wall; what stays is their guiding glow
        for (const m of holdMeshes) m.material = new HoldGlowMaterial();
        this.bakedFlag = bakeFlag(flagGroup, this.flagCloth);
        // nothing samples the realtime shadow map any more: the light is in the bake
        this.sun.castShadow = false;
        this.world.renderer.shadowMap.enabled = false;
        const bluff = sceneRefs.bluff;
        if (bluff) {
          for (const c of bluff.root.children) if (c !== bluff.deck) c.visible = false;
          if (w.deck) {
            bluff.deck.geometry = w.deck.geometry;
            bluff.deck.material = w.deck.material;
          }
        }
        // the party: the baked camp replaces the procedural log stack, tents, benches and festoons, and
        // shows and hides with the fire like they did
        const party = sceneRefs.party;
        if (party && w.party) {
          for (const o of [...party.objects]) {
            if (o.name === 'Bonfire' || o.name === 'Camp') {
              o.visible = false;
              party.objects.splice(party.objects.indexOf(o), 1);
            } else if (o.name === 'FestoonLights') {
              // the poles and wires are baked; the bulbs still glow on their own
              for (const c of o.children) if (!(c as InstancedMesh).isInstancedMesh) c.visible = false;
            }
          }
          w.party.position.copy(FIRE_POS);
          w.party.visible = party.visible;
          tutorialGroup.add(w.party);
          party.objects.push(w.party);
        }
        bakedView.tutorialReady = true;
        setBakedLook(this.world.renderer, true);
      })
      .catch((e) => console.error('Tutorial bake failed to load', e));
  }

  update(delta: number, time: number): void {
    const dt = Math.min(delta, 0.1);
    getHeadWorld(this.world, this.head);

    // The baked tutorial: light follows the weather; the sky dome stays on the viewer. Inside the ice
    // cave its own bake (cave/cave-baked.ts) writes the shared light terms instead, under the same AgX.
    if (game.indoors > 0.5 && caveView.look) {
      const ci = caveView.inputs;
      ci.storm = weatherHooks.storm;
      ci.beacon = caveView.beacon;
      ci.time = time;
      ci.head.copy(this.head);
      caveView.look.apply(ci);
      this.world.renderer.toneMapping = AgXToneMapping;
      this.world.renderer.toneMappingExposure = bakedView.exposure;
    } else if (this.baked && currentLevel().id === 'tutorial') {
      const fog = this.world.scene.fog as Fog | null;
      this.baked.look.apply({ storm: weatherHooks.storm, fogFar: fog ? fog.far : 5000, indoors: game.indoors });
      this.baked.sky?.position.copy(this.head);
      // from the launch deck to the landing the forest stays on its stand-ins: no trees popping below you
      const phase = game.phase.peek();
      this.baked.update(dt, this.head, phase === Phase.Launch || phase === Phase.Gliding);
      this.world.renderer.toneMapping = AgXToneMapping;
      this.world.renderer.toneMappingExposure = bakedView.exposure;
    }
    // Sky and cloud deck stay centred on the viewer.
    this.sky.position.copy(this.head);
    this.cloudSea.position.set(this.head.x, currentLevel().cloudDeckY, this.head.z);
    cloudSeaUniforms.uTime.value = time;

    // Keep the shadow frustum on the player. It is snapped to whole shadow
    // texels in the sun's own view (snapping world x/z does not line up
    // with a low sun's texel grid, so every step you took slid every shadow
    // edge by a fraction of a texel: the crawling flicker on the cabin
    // front), and it only re-centres every few metres. Between re-centres
    // the shadow map is only redrawn by the slow refresh for the few things
    // that move on their own (flag, glider parts).
    const texel = (SHADOW_EXTENT * 2) / this.sun.shadow.mapSize.x;
    // The expedition swings the sun round with the time of day.
    this.sunDir.subVectors(this.sun.position, this.sun.target.position).normalize();
    if (this.sunDir.distanceToSquared(this.sunBack) > 1e-8) this.sunAxes(this.sunDir);
    const u = this.head.dot(this.sunRight);
    const v = this.head.dot(this.sunUp);
    const w = this.head.dot(this.sunBack);
    const at = this.shadowAt;
    let recentred = false;
    if (
      Math.abs(u - at.x) > SHADOW_RECENTRE ||
      Math.abs(v - at.y) > SHADOW_RECENTRE ||
      Math.abs(w - at.z) > SHADOW_RECENTRE_DEPTH
    ) {
      at.set(Math.round(u / texel) * texel, Math.round(v / texel) * texel, Math.round(w));
      this.sun.target.position
        .copy(this.sunRight)
        .multiplyScalar(at.x)
        .addScaledVector(this.sunUp, at.y)
        .addScaledVector(this.sunBack, at.z);
      this.sun.position.copy(this.sun.target.position).addScaledVector(this.sunBack, 200);
      this.sun.target.updateMatrixWorld();
      recentred = true;
    }
    // Once the bake is in nothing samples the shadow map (it's switched off): only the flag and puffs.
    if (this.bakedFlag) {
      this.puffs.update(dt);
      this.updateFade(dt);
      this.bakedFlag.update(time, weatherHooks.windYaw, weatherHooks.windSpeed);
      return;
    }
    // Nothing that moves casts a shadow on the tutorial's cliff (the poles
    // are leant on the rock), so the climb skips the slow refresh: a whole
    // shadow pass every eighth frame was a regular hitch while you climbed.
    const still = game.phase.peek() === Phase.Climbing && currentLevel().id === 'tutorial';
    const refresh = !still && this.shadowFrame++ % 8 === 0;
    if (recentred || refresh) this.world.renderer.shadowMap.needsUpdate = true;

    // The flag only needs a refresh every other frame (the baked one waves on the GPU, above).
    if ((this.flagFrame++ & 1) === 0) waveFlag(this.flagCloth, time);
    this.puffs.update(dt);
    this.updateFade(dt);
  }

  /**
   * The shadow camera's axes for a sun in `dir`, exactly as three builds
   * them (eye on the sun side looking at the target, world up), so snapping
   * in them lands the frustum on whole shadow texels.
   */
  private sunAxes(dir: Vector3): void {
    this.basis.lookAt(dir, this.origin, this.sun.shadow.camera.up);
    this.basis.extractBasis(this.sunRight, this.sunUp, this.sunBack);
  }

  private updateFade(dt: number): void {
    const step = dt * 2.4;
    if (game.fade < game.fadeTarget) game.fade = Math.min(game.fadeTarget, game.fade + step);
    else if (game.fade > game.fadeTarget) game.fade = Math.max(game.fadeTarget, game.fade - step);

    if (game.fade >= 1 && game.pendingFadeAction) {
      const action = game.pendingFadeAction;
      game.pendingFadeAction = null;
      action();
      game.fadeTarget = 0;
    }

    const material = this.fadeSphere.material as MeshBasicMaterial;
    material.opacity = game.fade;
    this.fadeSphere.visible = game.fade > 0.001;
    if (this.fadeSphere.visible) {
      getHeadWorld(this.world, this.head);
      this.fadeSphere.position.copy(this.head);
    }
  }
}
