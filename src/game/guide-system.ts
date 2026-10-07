/**
 * The guide panel: explains each phase, follows the player's gaze in VR
 * (lazily, so it never feels head-locked) and offers Enter VR / Play again.
 */

import {
  createSystem,
  Object3D,
  UIKit,
  UIKitMLAsset,
  Vector3,
  VisibilityState,
} from '@iwsdk/core';
import { audio } from './audio.js';
import { faceYaw, getHeadWorld, getHeadYaw, placeHeadAt, yawForward } from './rig.js';
import { fadeThen, game, Phase, requestRestart, setPhase } from './state.js';
import { WALL_Z } from './terrain.js';

const PANEL_NODE_ID = 'guide-panel';
/** Panel world scale when it floats at REFERENCE_DISTANCE. */
const BASE_SCALE = 0.17;
const REFERENCE_DISTANCE = 1.25;

interface Copy {
  step: string;
  title: string;
  body: string;
  hint: string;
}

export class GuideSystem extends createSystem({}) {
  private panel: UIKitMLAsset | null = null;
  private panelObject: Object3D | null = null;
  private stepText!: UIKit.Text;
  private titleText!: UIKit.Text;
  private bodyText!: UIKit.Text;
  private hintText!: UIKit.Text;
  private xrButton!: UIKit.Component;
  private restartButton!: UIKit.Component;

  private readonly head = new Vector3();
  private readonly fwd = new Vector3();
  private readonly target = new Vector3();
  private readonly localAnchor = new Vector3();
  private readonly localTarget = new Vector3();
  private readonly toPanel = new Vector3();
  private anchored = false;
  private phaseTime = 0;

  init(): void {
    const unlock = () => audio.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    this.cleanupFuncs.push(
      () => window.removeEventListener('pointerdown', unlock),
      () => window.removeEventListener('keydown', unlock),
    );
    this.tryBindPanel();
  }

  private tryBindPanel(): boolean {
    if (this.panel) return true;
    const panel = this.world.getSceneObject<UIKitMLAsset>(PANEL_NODE_ID);
    if (!panel) return false;
    this.panel = panel;
    this.panelObject = this.world.getSceneEntity(PANEL_NODE_ID)?.object3D ?? panel;
    this.stepText = panel.requireElementById<UIKit.Text>('guide-step');
    this.titleText = panel.requireElementById<UIKit.Text>('guide-title');
    this.bodyText = panel.requireElementById<UIKit.Text>('guide-body');
    this.hintText = panel.requireElementById<UIKit.Text>('guide-hint');
    this.xrButton = panel.requireElementById('xr-button');
    this.restartButton = panel.requireElementById('restart-button');
    this.stepText.name = 'guide-step';
    this.titleText.name = 'guide-title';
    this.bodyText.name = 'guide-body';
    this.xrButton.name = 'xr-button';
    this.restartButton.name = 'restart-button';

    const enterXR = () => {
      audio.unlock();
      this.world.launchXR();
    };
    const restart = () => {
      audio.unlock();
      this.restart();
    };
    this.xrButton.addEventListener('click', enterXR);
    this.restartButton.addEventListener('click', restart);
    this.cleanupFuncs.push(
      () => this.xrButton.removeEventListener('click', enterXR),
      () => this.restartButton.removeEventListener('click', restart),
      game.phase.subscribe(() => {
        this.anchored = false;
        this.phaseTime = 0;
        this.refresh();
      }),
      game.distanceToCliff.subscribe(() => this.refresh()),
      game.partsPlaced.subscribe(() => this.refresh()),
      game.barHeld.subscribe(() => this.refresh()),
      this.world.visibilityState.subscribe((state) => {
        if (state !== VisibilityState.NonImmersive) audio.unlock();
        this.anchored = false;
        this.refresh();
      }),
    );
    return true;
  }

  private restart(): void {
    fadeThen(() => {
      const rig = this.player;
      rig.rotation.y = 0;
      rig.position.set(0, 0, 0);
      rig.updateMatrixWorld(true);
      faceYaw(this.world, 0);
      placeHeadAt(this.world, 0, 0.3, 0);
      game.velocity.set(0, 0, 0);
      game.distanceToCliff.value = Math.round(-WALL_Z);
      requestRestart();
      setPhase(Phase.Poling);
    });
  }

  private copyFor(phase: Phase, immersive: boolean): Copy {
    switch (phase) {
      case Phase.Poling:
        return {
          step: 'STEP 1 OF 4',
          title: 'Pole up the trail',
          body: immersive ? 'Fist to grip. Plant, then pull back.' : 'Hold W to pole. Drag to look.',
          hint: `${game.distanceToCliff.peek()} m to the cliff`,
        };
      case Phase.Climbing:
        return {
          step: 'STEP 2 OF 4',
          title: 'Climb',
          body: immersive ? 'Grab a glowing hold. Pull down.' : 'Hold W to climb.',
          hint: '',
        };
      case Phase.Building:
        return {
          step: 'STEP 3 OF 4',
          title: 'Build your glider',
          body: immersive ? 'Carry each part to its outline.' : 'Press E to fit a part.',
          hint: `${game.partsPlaced.peek()} of 3 fitted`,
        };
      case Phase.Launch:
        return {
          step: 'STEP 3 OF 4',
          title: 'Take off',
          body: immersive ? 'Grab the bar with both hands.' : 'Press Space to launch.',
          hint: game.barHeld.peek() ? 'Hold on...' : '',
        };
      case Phase.Gliding:
        return {
          step: 'STEP 4 OF 4',
          title: 'Fly!',
          body: immersive ? 'Tilt the bar to turn. Pull in to dive.' : 'A / D steer. W dive, S float.',
          hint: '',
        };
      case Phase.Landed:
      default:
        return {
          step: 'COMPLETE',
          title: 'Thanks for playing!',
          body: 'Summit to valley. Well flown.',
          hint: '',
        };
    }
  }

  private refresh(): void {
    if (!this.panel) return;
    const immersive = this.world.visibilityState.peek() !== VisibilityState.NonImmersive;
    const phase = game.phase.peek();
    const copy = this.copyFor(phase, immersive);
    this.stepText.setProperties({ text: copy.step });
    this.titleText.setProperties({ text: copy.title });
    this.bodyText.setProperties({ text: copy.body });
    this.hintText.setProperties({ text: copy.hint, display: copy.hint ? 'flex' : 'none' });
    this.xrButton.setProperties({
      display: !immersive && this.world.xrEnabled ? 'flex' : 'none',
    });
    this.restartButton.setProperties({ display: phase === Phase.Landed ? 'flex' : 'none' });
  }

  update(delta: number): void {
    if (!this.tryBindPanel()) return;
    this.phaseTime += delta;
    if (!this.world.renderer.xr.isPresenting || !this.panelObject) return;
    this.placeInFront();
  }

  /** Float the panel in front of the viewer, re-centring only when needed. */
  private placeInFront(): void {
    const object = this.panelObject!;
    const phase = game.phase.peek();
    // While gliding, show the tips briefly and then get out of the way.
    object.visible = !(phase === Phase.Gliding && this.phaseTime > 9);
    if (!object.visible) return;

    getHeadWorld(this.world, this.head);
    yawForward(getHeadYaw(this.world), this.fwd);

    let distance = REFERENCE_DISTANCE;
    let drop = 0.3;
    if (phase === Phase.Gliding) {
      distance = 1.8;
      drop = 0.75;
    } else if (phase === Phase.Landed) {
      distance = 1.2;
      drop = 0.05;
    } else if (phase === Phase.Building) {
      // Float above and in front of the glider kit so it never cuts through.
      distance = 0.95;
      drop = -0.22;
    } else if (phase === Phase.Climbing && this.fwd.z < -0.2) {
      // Don't bury the panel inside the rock face.
      const room = (this.head.z - (WALL_Z + 0.4)) / -this.fwd.z;
      distance = clampRange(room, 0.45, REFERENCE_DISTANCE);
      drop = 0.12;
    }

    this.target.copy(this.head).addScaledVector(this.fwd, distance);
    this.target.y = this.head.y - drop;
    const rig = this.player;
    rig.updateMatrixWorld(true);
    this.localTarget.copy(this.target);
    rig.worldToLocal(this.localTarget);

    // Re-anchor when the viewer has looked well away from the panel.
    this.toPanel.copy(this.localAnchor);
    rig.localToWorld(this.toPanel).sub(this.head);
    this.toPanel.y = 0;
    const offAngle = this.toPanel.lengthSq() > 1e-6 ? this.toPanel.normalize().angleTo(this.fwd) : Math.PI;
    if (!this.anchored || offAngle > 0.6 || phase === Phase.Climbing) {
      if (!this.anchored) this.localAnchor.copy(this.localTarget);
      this.anchored = true;
      this.localAnchor.lerp(this.localTarget, 0.08);
    }

    object.position.copy(this.localAnchor);
    rig.localToWorld(object.position);
    const d = object.position.distanceTo(this.head);
    object.scale.setScalar((BASE_SCALE * d) / REFERENCE_DISTANCE);
    object.lookAt(this.head);
  }
}

function clampRange(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
