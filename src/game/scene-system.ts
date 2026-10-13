/**
 * Builds the mountain world once and drives the ambient pieces: the sky and
 * sea of clouds that follow the viewer, the sun's shadow frustum that
 * tracks the player, the summit flag, snow puffs and the white fade used to
 * hide phase transitions.
 */

import {
  Color,
  createSystem,
  CustomToneMapping,
  DirectionalLight,
  type Entity,
  Fog,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PCFShadowMap,
  type Texture,
  Vector3,
} from '@iwsdk/core';
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
};

export class SceneSetupSystem extends createSystem({}) {
  private flagCloth!: Mesh;
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
    this.cloudSea = buildCloudSea();
    add(this.cloudSea);
    // Distant scenery draws first in its own depth range; then depth clears.
    add(buildDepthClear());

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

    addTutorial(buildTerrain());
    const farRanges = buildFarRanges();
    sceneRefs.farRanges = farRanges;
    addTutorial(farRanges);
    addTutorial(buildForest());
    addTutorial(chunkInstanced([buildRocks()], 100, 'Rocks'));
    addTutorial(buildCliff());
    addTutorial(buildTrailMarkers());
    addTutorial(buildTrailSign());
    addTutorial(buildSummitSign());
    addTutorial(buildCabin(-9.5, 4.5, 0.65));
    addTutorial(buildCabin(-36, LAKE_CENTER_Z + 14, 1.3));
    addTutorial(buildCabin(22, LAKE_CENTER_Z + 30, -0.9));
    addTutorial(buildLake());
    const flag = buildSummitFlag();
    this.flagCloth = flag.cloth;
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
      fogCullables.push({ object: mesh, center: mesh.position.clone(), radius: 0.4, maxDistance: 60 });
      addTutorial(mesh).addComponent(ClimbHold, { lip: hold.lip, glow: 0 });
    });

    this.puffs = new SnowPuffs();
    sceneRefs.puffs = this.puffs;
    add(this.puffs.points);
    this.fadeSphere = buildFadeSphere();
    add(this.fadeSphere);
  }

  update(delta: number, time: number): void {
    const dt = Math.min(delta, 0.1);
    getHeadWorld(this.world, this.head);

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
    // Nothing that moves casts a shadow on the tutorial's cliff (the poles
    // are leant on the rock), so the climb skips the slow refresh: a whole
    // shadow pass every eighth frame was a regular hitch while you climbed.
    const still = game.phase.peek() === Phase.Climbing && currentLevel().id === 'tutorial';
    const refresh = !still && this.shadowFrame++ % 8 === 0;
    if (recentred || refresh) this.world.renderer.shadowMap.needsUpdate = true;

    // The flag only needs a refresh every other frame.
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
