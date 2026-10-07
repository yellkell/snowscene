/**
 * Builds the procedural mountain once and drives the ambient effects:
 * snowfall around the viewer, the summit flag, snow puffs and the white
 * fade used to hide phase transitions.
 */

import {
  Color,
  createSystem,
  DirectionalLight,
  Fog,
  Mesh,
  MeshBasicMaterial,
  NeutralToneMapping,
  Object3D,
  Points,
  ShaderMaterial,
  Vector3,
} from '@iwsdk/core';
import { ClimbHold } from './game-components.js';
import { getHeadWorld } from './rig.js';
import { SnowPuffs } from './snow-puffs.js';
import { game } from './state.js';
import {
  buildCabin,
  buildCliff,
  buildDistantPeaks,
  buildFadeSphere,
  buildForest,
  buildHoldMesh,
  buildLake,
  buildRocks,
  buildSnowfall,
  buildSummitFlag,
  buildSun,
  buildTerrain,
  buildTrailMarkers,
  buildTrailSign,
  FOG_COLOR,
  holdLayout,
  SUN_DIRECTION,
  waveFlag,
} from './world-builders.js';

/** Shared handles to scene pieces other systems need. */
export const sceneRefs = {
  puffs: null as SnowPuffs | null,
};

export class SceneSetupSystem extends createSystem({}) {
  private snowfall!: Points;
  private flagCloth!: Mesh;
  private fadeSphere!: Mesh;
  private puffs!: SnowPuffs;
  private readonly head = new Vector3();
  private flagFrame = 0;

  init(): void {
    const { renderer, scene } = this.world;
    renderer.toneMapping = NeutralToneMapping;
    renderer.toneMappingExposure = 0.95;
    scene.fog = new Fog(FOG_COLOR, 140, 1500);

    const add = (object: Object3D) =>
      this.world.createTransformEntity(object, { persistent: true });

    const sun = new DirectionalLight(new Color(1.0, 0.85, 0.68), 1.9);
    sun.position.copy(SUN_DIRECTION).multiplyScalar(100);
    sun.name = 'Sun Light';
    add(sun);
    // Cool sky bounce from the opposite side keeps shaded slopes blue.
    const fill = new DirectionalLight(new Color(0.5, 0.64, 1.0), 0.55);
    fill.position.set(40, 60, -80);
    fill.name = 'Sky Fill';
    add(fill);

    add(buildTerrain());
    add(buildDistantPeaks());
    add(buildForest());
    add(buildRocks());
    add(buildCliff());
    add(buildTrailMarkers());
    add(buildTrailSign());
    add(buildCabin(-9.5, 4.5, 0.65));
    add(buildCabin(-36, 126, 1.3));
    add(buildCabin(22, 142, -0.9));
    add(buildLake());
    add(buildSun());
    const flag = buildSummitFlag();
    this.flagCloth = flag.cloth;
    add(flag.group);

    holdLayout().forEach((hold, i) => {
      const mesh = buildHoldMesh(i * 3.1);
      mesh.position.copy(hold.position);
      mesh.rotation.set(i * 0.7, i * 1.3, i * 0.4);
      mesh.name = `ClimbHold${i}`;
      add(mesh).addComponent(ClimbHold, { lip: hold.lip, glow: 0 });
    });

    this.snowfall = buildSnowfall();
    add(this.snowfall);
    this.puffs = new SnowPuffs();
    sceneRefs.puffs = this.puffs;
    add(this.puffs.points);
    this.fadeSphere = buildFadeSphere();
    add(this.fadeSphere);
  }

  update(delta: number, time: number): void {
    const dt = Math.min(delta, 0.1);
    getHeadWorld(this.world, this.head);

    const snow = this.snowfall.material as ShaderMaterial;
    snow.uniforms.uTime.value = time;
    (snow.uniforms.uCenter.value as Vector3).copy(this.head);

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
