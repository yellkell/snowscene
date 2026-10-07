/**
 * Builds the mountain world once and drives the ambient pieces: the sky and
 * sea of clouds that follow the viewer, the sun's shadow frustum that
 * tracks the player, the summit flag, snow puffs and the white fade used to
 * hide phase transitions.
 */

import {
  ACESFilmicToneMapping,
  Color,
  createSystem,
  DirectionalLight,
  type Entity,
  Fog,
  Group,
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
import { game } from './state.js';
import { LAKE_CENTER_Z } from './terrain.js';
import { buildForest } from './trees.js';
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

/** Shared handles to scene pieces other systems need. */
export const sceneRefs = {
  puffs: null as SnowPuffs | null,
  /** Parent of everything that belongs only to the tutorial mountain. */
  tutorialRoot: null as Entity | null,
  sunLight: null as DirectionalLight | null,
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

  init(): void {
    const { renderer, scene } = this.world;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.62;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
    // Shadows are refreshed every other frame (see update).
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
    this.sun.shadow.normalBias = 0.05;
    add(this.sun);
    add(this.sun.target);
    sceneRefs.sunLight = this.sun;

    addTutorial(buildTerrain());
    addTutorial(buildFarRanges());
    addTutorial(buildForest());
    addTutorial(buildRocks());
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

    // Keep the shadow frustum on the player, snapped to shadow texels so
    // shadows don't shimmer as you move.
    const texel = (SHADOW_EXTENT * 2) / this.sun.shadow.mapSize.x;
    const sx = Math.round(this.head.x / texel) * texel;
    const sz = Math.round(this.head.z / texel) * texel;
    this.sun.target.position.set(sx, this.head.y - 1, sz);
    this.sun.position.copy(this.sun.target.position).addScaledVector(SUN_DIRECTION, 200);
    this.sun.target.updateMatrixWorld();
    if ((this.shadowFrame++ & 1) === 0) this.world.renderer.shadowMap.needsUpdate = true;

    // The flag only needs a refresh every other frame.
    if ((this.flagFrame++ & 1) === 0) waveFlag(this.flagCloth, time);
    this.puffs.update(dt);
    this.updateFade(dt);
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
