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
          step: 'STEP 1 OF 4  -  THE TRAIL',
          title: 'Pole up the mountain',
          body: immersive
            ? 'Make a fist to grip each walking pole. Plant the tip in the snow, then pull your hand back to push yourself up the trail. Alternate arms, or push with both at once for a big stride.'
            : 'Hold W or the Up arrow to pole up the trail. Drag the mouse to look around. For the full experience, enter VR and use hand tracking.',
          hint: `${game.distanceToCliff.peek()} m to the cliff`,
        };
      case Phase.Climbing:
        return {
          step: 'STEP 2 OF 4  -  THE CLIFF',
          title: 'Climb the last stretch',
          body: immersive
            ? 'Reach for a glowing hold and make a fist to grab it. Pull down to lift yourself, then reach higher with your other hand. Haul yourself over the top.'
            : 'Hold W or the Up arrow to climb the rock wall.',
          hint: 'Let go of everything and you will slide gently back down.',
        };
      case Phase.Building:
        return {
          step: 'STEP 3 OF 4  -  THE SUMMIT',
          title: 'Build your glider',
          body: immersive
            ? 'Grab each loose part with a fist, carry it to its glowing outline on the frame and open your hand to fit it.'
            : 'Press E to fit the next part onto the glider frame.',
          hint: `${game.partsPlaced.peek()} of 3 parts fitted`,
        };
      case Phase.Launch:
        return {
          step: 'STEP 3 OF 4  -  THE SUMMIT',
          title: 'Ready for take-off',
          body: immersive
            ? 'Close both hands around the control bar in front of you to launch off the edge.'
            : 'Press Space to launch off the edge.',
          hint: game.barHeld.peek() ? 'Hold on...' : 'Both hands on the bar.',
        };
      case Phase.Gliding:
        return {
          step: 'STEP 4 OF 4  -  THE DESCENT',
          title: 'Fly!',
          body: immersive
            ? 'Tilt the bar like a steering wheel to turn. Pull it in to dive, push it out to float. Glide down to the valley.'
            : 'A and D to steer, W to dive, S to float. Glide down to the valley.',
          hint: 'Land anywhere in the valley.',
        };
      case Phase.Landed:
      default:
        return {
          step: 'SUMMIT TO VALLEY  -  COMPLETE',
          title: 'Thanks for playing!',
          body: 'You poled up the mountain, scaled the cliff, built a glider and soared home on the evening wind.',
          hint: 'Snow Scene  -  made with the Immersive Web SDK',
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
    this.hintText.setProperties({ text: copy.hint });
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
