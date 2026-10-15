/**
 * The guide panel: explains each phase, follows the player's gaze in VR
 * (lazily, so it never feels head-locked) and offers Enter VR / Play again.
 */

import {
  CanvasTexture,
  createSystem,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  SRGBColorSpace,
  UIKit,
  UIKitMLAsset,
  Vector3,
  VisibilityState,
} from '@iwsdk/core';
import { audio } from './audio.js';
import { packRefs } from './backpack-system.js';
import { expControl } from './expedition/director/exp-control.js';
import { SECTION_ORDER, type SectionId, SUMMIT_ELEV } from './expedition/exp-route.js';
import { SECTION_NAMES } from './expedition/exp-layout.js';
import { exp } from './expedition/exp-state.js';
import { chuteState } from './expedition/slide/chute-state.js';
import { survivors, survivorsControl } from './survivors/survivors-state.js';
import { currentLevel } from './level.js';
import { faceYaw, getHeadWorld, getHeadYaw, placeHeadAt, yawForward } from './rig.js';
import { fadeThen, game, PART_COUNT, Phase, requestRestart, setPhase, toast } from './state.js';
import { CLIFF_HEIGHT, WALL_S, WALL_Z } from './terrain.js';
import { startTutorialKit } from './tutorial-kit.js';

const PANEL_NODE_ID = 'guide-panel';
/** Panel world scale when it floats at REFERENCE_DISTANCE. */
const BASE_SCALE = 0.17;
const REFERENCE_DISTANCE = 1.25;

interface Copy {
  step: string;
  title: string;
  body: string;
  hint: string;
  /** Big distance line ("48 m to the summit"); empty hides it. */
  metric?: string;
}

export class GuideSystem extends createSystem({}) {
  private panel: UIKitMLAsset | null = null;
  private panelObject: Object3D | null = null;
  private stepText!: UIKit.Text;
  private titleText!: UIKit.Text;
  private bodyText!: UIKit.Text;
  private hintText!: UIKit.Text;
  private metricText!: UIKit.Text;
  private xrButton!: UIKit.Component;
  private restartButton!: UIKit.Component;
  private expeditionButton!: UIKit.Component;
  private skipButton!: UIKit.Component;
  private expRestartButton!: UIKit.Component;
  private tutorialButton!: UIKit.Component;
  private survivorsButton!: UIKit.Component;
  private survivorsAgainButton!: UIKit.Component;
  private survivorsExitButton!: UIKit.Component;

  private readonly head = new Vector3();
  private readonly fwd = new Vector3();
  /** Big "pinch to turn on the sound" card while the browser still holds audio back. */
  private soundCard!: Mesh;
  private presentingFor = 0;
  private readonly target = new Vector3();
  private readonly localAnchor = new Vector3();
  private readonly localTarget = new Vector3();
  private readonly toPanel = new Vector3();
  private anchored = false;

  private phaseTime = 0;

  init(): void {
    this.soundCard = buildSoundCard();
    this.world.createTransformEntity(this.soundCard, { persistent: true });
    // Score: "By the River" for the ascent, "Night Catch" from the moment
    // the beacon is lit, through the build on top of the rock and the glide.
    const updateMusic = () => {
      // On the expedition the soundscape system owns the score.
      if (exp.active.peek()) return;
      if (survivors.active.peek()) {
        audio.setMusic('night');
        return;
      }
      const phase = game.phase.peek();
      const built =
        exp.summited.peek() ||
        game.beaconLit.peek() ||
        game.partsPlaced.peek() >= PART_COUNT ||
        phase === Phase.Launch ||
        phase === Phase.Gliding ||
        phase === Phase.Landed;
      audio.setMusic(built ? 'night' : 'river');
    };
    this.cleanupFuncs.push(
      game.phase.subscribe(updateMusic),
      game.partsPlaced.subscribe(updateMusic),
      exp.summited.subscribe(updateMusic),
      game.beaconLit.subscribe(updateMusic),
      survivors.active.subscribe(updateMusic),
    );
    // Browsers only start audio from a user gesture, so try on every kind
    // we can see: page input, entering XR, and XR pinches / squeezes (which
    // count as user activation inside an immersive session).
    const unlock = () => audio.unlock();
    const pageEvents = ['pointerdown', 'pointerup', 'click', 'touchend', 'keydown'];
    for (const type of pageEvents) window.addEventListener(type, unlock);
    // Entering through the browser's own "Enter VR" offer gives the page no
    // gesture, so these XR presses are the first chance the sound has.
    const xrEvents = ['selectstart', 'select', 'selectend', 'squeezestart', 'squeeze', 'squeezeend', 'inputsourceschange'];
    const xr = this.world.renderer.xr;
    const onSessionStart = () => {
      audio.unlock();
      const session = xr.getSession();
      if (!session) return;
      for (const type of xrEvents) session.addEventListener(type, unlock);
      session.addEventListener('visibilitychange', unlock);
    };
    xr.addEventListener('sessionstart', onSessionStart);
    this.cleanupFuncs.push(
      () => {
        for (const type of pageEvents) window.removeEventListener(type, unlock);
      },
      () => xr.removeEventListener('sessionstart', onSessionStart),
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
    this.metricText = panel.requireElementById<UIKit.Text>('guide-metric');
    this.xrButton = panel.requireElementById('xr-button');
    this.restartButton = panel.requireElementById('restart-button');
    this.stepText.name = 'guide-step';
    this.titleText.name = 'guide-title';
    this.bodyText.name = 'guide-body';
    this.xrButton.name = 'xr-button';
    this.restartButton.name = 'restart-button';
    this.expeditionButton = panel.requireElementById('expedition-button');
    this.skipButton = panel.requireElementById('skip-button');
    this.expRestartButton = panel.requireElementById('exp-restart-button');
    this.tutorialButton = panel.requireElementById('tutorial-button');
    this.survivorsButton = panel.requireElementById('survivors-button');
    this.survivorsAgainButton = panel.requireElementById('survivors-again-button');
    this.survivorsExitButton = panel.requireElementById('survivors-exit-button');
    this.survivorsButton.name = 'survivors-button';
    this.survivorsAgainButton.name = 'survivors-again-button';
    this.survivorsExitButton.name = 'survivors-exit-button';
    this.expeditionButton.name = 'expedition-button';
    this.skipButton.name = 'skip-button';
    this.expRestartButton.name = 'exp-restart-button';
    this.tutorialButton.name = 'tutorial-button';
    const expButtons: Array<[UIKit.Component, () => void]> = [
      [this.survivorsButton, () => survivorsControl.start()],
      [this.survivorsAgainButton, () => survivorsControl.start()],
      [this.survivorsExitButton, () => survivorsControl.exit()],
      [this.expeditionButton, () => expControl.start()],
      [this.skipButton, () => expControl.skipAhead()],
      [this.expRestartButton, () => expControl.restart()],
      [this.tutorialButton, () => expControl.toTutorial()],
    ];
    for (const [button, action] of expButtons) {
      const onClick = () => {
        audio.unlock();
        action();
      };
      button.addEventListener('click', onClick);
      this.cleanupFuncs.push(() => button.removeEventListener('click', onClick));
    }

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
      game.partsFound.subscribe(() => this.refresh()),
      game.beaconLit.subscribe(() => this.refresh()),
      game.barHeld.subscribe(() => this.refresh()),
      game.toast.subscribe(() => this.refresh()),

      exp.active.subscribe(() => this.refresh()),
      exp.section.subscribe(() => this.refresh()),
      exp.summited.subscribe(() => this.refresh()),
      chuteState.arrived.subscribe(() => this.refresh()),
      exp.finished.subscribe(() => this.refresh()),
      survivors.active.subscribe(() => this.refresh()),
      survivors.dead.subscribe(() => this.refresh()),
      expControl.hint.subscribe(() => this.refresh()),
      expControl.camp.subscribe(() => this.refresh()),
      expControl.wall.subscribe(() => this.refresh()),
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
      startTutorialKit();
      setPhase(Phase.Poling);
    });
  }

  private copyFor(phase: Phase, immersive: boolean): Copy {
    if (exp.active.peek()) return this.expeditionCopy(phase, immersive);
    if (survivors.active.peek()) return this.survivorsCopy(immersive);
    switch (phase) {
      case Phase.Poling:
        return {
          step: 'STEP 1 OF 6',
          title: 'Pole up the trail',
          body: immersive ? 'Fist to grip. Plant, then pull back.' : 'Hold W to pole. Drag to look.',
          hint: '',
          metric: `${game.distanceToCliff.peek() + Math.round(CLIFF_HEIGHT)} m to the summit`,
        };
      case Phase.Climbing:
        return {
          step: 'STEP 2 OF 6',
          title: 'Climb',
          body: immersive ? 'Grab a glowing hold. Pull down.' : 'Hold W to climb.',
          hint: '',
        };
      case Phase.Cave:
        return {
          step: 'STEP 3 OF 6',
          title: 'The timber works',
          body: immersive
            ? game.partsFound.peek() === 0
              ? 'Step onto decks with green lamps. Pick up the glider parts on the racks.'
              : 'Step onto decks with green lamps. Amber: leaving. Red: moving.'
            : 'W steps across on green lamps. E takes a part.',
          hint: `${game.partsFound.peek()} of 3 parts found`,
        };
      case Phase.Beacon:
        return {
          step: 'STEP 4 OF 6',
          title: game.beaconLit.peek() ? 'The beacon is lit' : 'Light the beacon',
          body: game.beaconLit.peek()
            ? 'The party below has seen you. Up and out to the top!'
            : immersive
              ? 'Squeeze to take the glowing torch off its post. Hold its flame in the iron basket.'
              : 'Press E to light the beacon.',
          hint: game.beaconLit.peek() ? '' : 'The basket glows where the flame must go',
        };
      case Phase.Building:
        return {
          step: 'STEP 5 OF 6',
          title: 'Build your glider',
          body: immersive
            ? 'Take the glider parts you collected out of your backpack and assemble them here.'
            : 'Press E to fit a part from your pack.',
          hint: `${game.partsPlaced.peek()} of 3 fitted`,
        };
      case Phase.Launch:
        return {
          step: 'STEP 5 OF 6',
          title: 'Take off',
          body: immersive ? 'Grab the bar. Fly to the fire.' : 'Space to launch. Fly to the fire.',
          hint: game.barHeld.peek() ? 'Hold on...' : '',
        };
      case Phase.Gliding:
        return {
          step: 'STEP 6 OF 6',
          title: 'Fly to the campfire',
          body: immersive ? 'Tilt the bar to turn. Pull in to dive.' : 'A / D steer. W dive, S float.',
          hint: '',
        };
      case Phase.Landed:
      default:
        return {
          step: 'COMPLETE',
          title: 'Thanks for playing!',
          body: immersive ? 'Well flown. Ready for the real mountain?' : 'Well flown. Press E for the real mountain.',
          hint: '',
        };
    }
  }

  /** Snow Survivors: how to play, or how the run ended. */
  private survivorsCopy(immersive: boolean): Copy {
    if (survivors.dead.peek()) {
      const t = survivors.time.peek();
      return {
        step: 'SNOW SURVIVORS',
        title: survivors.won.peek() ? 'You survived!' : 'You fell!',
        body:
          `Survived ${Math.floor(t / 60)}:${(t % 60).toString().padStart(2, '0')} with ${survivors.kills.peek().toLocaleString()} kills, level ${survivors.level.peek()}. ` +
          `Best combo ${survivors.bestCombo.peek().toLocaleString()}` +
          (survivors.bosses.peek() > 0 ? `, ${survivors.bosses.peek()} boss${survivors.bosses.peek() > 1 ? 'es' : ''} down.` : '.'),
        hint: '',
      };
    }
    return {
      step: 'SNOW SURVIVORS',
      title: 'Survive the horde',
      body: immersive
        ? 'Hold out for 8 minutes. Pole about: fist, plant, pull. Jab a pole into the small ones to finish them. Your weapons fire by themselves. Level up, then poke the upgrade you want. Go fast to ram straight through them.'
        : 'Hold out for 8 minutes. W to move, drag to look. Your weapons fire by themselves. Level up, then press 1-4 for the upgrade you want. Go fast to ram straight through them.',
      hint: '',
    };
  }

  /** Short copy for the expedition (the status line comes from the director). */
  private expeditionCopy(phase: Phase, immersive: boolean): Copy {
    const section = exp.section.peek();
    const step = `EXPEDITION · ${SECTION_ORDER.indexOf(section) + 1} OF ${SECTION_ORDER.length}`;
    const hint = expControl.hint.peek();
    const toSummit = Math.max(0, Math.round((SUMMIT_ELEV - this.player.position.y) / 10) * 10);
    const metric =
      !exp.summited.peek() && (phase === Phase.Poling || phase === Phase.Climbing)
        ? `${toSummit.toLocaleString('en-GB')} m to the summit`
        : '';
    const copy = this.expeditionPhaseCopy(phase, immersive, step, section, hint);
    copy.metric = metric;
    return copy;
  }

  private expeditionPhaseCopy(
    phase: Phase,
    immersive: boolean,
    step: string,
    section: SectionId,
    hint: string,
  ): Copy {
    switch (phase) {
      case Phase.Climbing:
        if (expControl.wall.peek() === 'ice') {
          return {
            step,
            title: 'The Ice Wall',
            body: immersive ? 'Swing the axes into the ice. Pull down.' : 'Hold W to climb.',
            hint,
          };
        }
        return {
          step,
          title: 'The Rock Band',
          body: immersive ? 'Grab a glowing hold. Pull down.' : 'Hold W to climb.',
          hint,
        };
      case Phase.Sliding:
        if (chuteState.arrived.peek()) {
          return { step: 'THE DESCENT', title: 'Fly home', body: 'Unpack the glider and drop it to launch.', hint };
        }
        return {
          step: 'THE DESCENT',
          title: 'The Summit Chute',
          body: immersive ? 'Lean left or right past the barriers.' : 'A / D to lean past the barriers.',
          hint,
        };
      case Phase.Launch:
        return {
          step: 'THE DESCENT',
          title: 'Fly home',
          body: immersive ? 'Grab the bar. Glide to Base Camp.' : 'Space to launch.',
          hint: game.barHeld.peek() ? 'Hold on...' : '',
        };
      case Phase.Gliding:
        return {
          step: 'THE DESCENT',
          title: 'Fly to Base Camp',
          body: immersive ? 'Tilt the bar to turn. Pull in to dive.' : 'A / D steer. W dive, S float.',
          hint: '',
        };
      case Phase.Landed:
        return exp.finished.peek()
          ? { step: 'EXPEDITION COMPLETE', title: 'Thanks for playing!', body: 'You climbed the mountain.', hint: '' }
          : { step: 'THE DESCENT', title: 'Touchdown', body: 'Hold on...', hint: '' };
      case Phase.Poling:
      default:
        if (exp.summited.peek()) {
          return { step: 'THE SUMMIT', title: 'You made it!', body: 'Ride the Summit Chute down, then fly home.', hint };
        }
        if (expControl.camp.peek() > 0) {
          return {
            step,
            title: SECTION_NAMES[section],
            body: immersive ? 'Hold your hands to the fire.' : 'Stand by the fire to warm up.',
            hint,
          };
        }
        return {
          step,
          title: SECTION_NAMES[section],
          body: immersive ? 'Plant your poles and push.' : 'Hold W to walk. T: watch.',
          hint,
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
    const toastNow = game.toast.peek();
    let hint = toastNow && toastNow.until > performance.now() / 1000 ? toastNow.text : copy.hint;
    // While the panel still floats with you, teach the pack gesture: a
    // third of the way up the first slope the panel moves into the pack.
    if (immersive && !this.panelInPack() && phase === Phase.Poling) {
      hint = hint || 'Soon these notes go in your pack: turn a palm up to open it';
    }
    this.hintText.setProperties({ text: hint, display: hint ? 'flex' : 'none' });
    const metric = copy.metric ?? '';
    this.metricText.setProperties({ text: metric, display: metric ? 'flex' : 'none' });
    this.xrButton.setProperties({
      display: !immersive && this.world.xrEnabled ? 'flex' : 'none',
    });
    const expedition = exp.active.peek();
    const finished = expedition && exp.finished.peek();
    this.restartButton.setProperties({ display: phase === Phase.Landed && !expedition ? 'flex' : 'none' });
    this.expeditionButton.setProperties({ display: phase === Phase.Landed && !expedition ? 'flex' : 'none' });
    this.skipButton.setProperties({
      display: expedition && phase === Phase.Poling && expControl.camp.peek() >= 0 && !exp.summited.peek() ? 'flex' : 'none',
    });
    this.expRestartButton.setProperties({ display: finished ? 'flex' : 'none' });
    this.tutorialButton.setProperties({ display: finished ? 'flex' : 'none' });
    // Snow Survivors: offered at the trailhead and on the end screen, in VR
    // only (it is played with the poles); once in, a way back to the
    // mountain (in the pack), and another go when you fall.
    const inSurvivors = survivors.active.peek();
    const atTrailhead = !expedition && !inSurvivors && phase === Phase.Poling && !this.panelInPack();
    this.survivorsButton.setProperties({
      display: immersive && !inSurvivors && !expedition && (atTrailhead || phase === Phase.Landed) ? 'flex' : 'none',
    });
    this.survivorsAgainButton.setProperties({ display: inSurvivors && survivors.dead.peek() ? 'flex' : 'none' });
    this.survivorsExitButton.setProperties({ display: inSurvivors ? 'flex' : 'none' });
  }

  update(delta: number): void {
    this.updateSoundCard(delta);
    if (!this.tryBindPanel()) return;
    this.phaseTime += delta;
    const toastNow = game.toast.peek();
    if (toastNow && toastNow.until <= performance.now() / 1000) game.toast.value = null;
    if (!this.world.renderer.xr.isPresenting || !this.panelObject) return;
    this.placeInFront();
  }

  /**
   * The browser keeps audio silent until a press it counts as a gesture, and
   * entering through its own "Enter VR" offer is not one. Hands closing into
   * fists are not one either, so without this the first pinch (often a minute
   * in) is when the sound finally starts. A big card right in front of you
   * asks for it from the moment you are in, and goes once the sound is on.
   */
  private updateSoundCard(delta: number): void {
    const presenting = this.world.renderer.xr.isPresenting;
    this.presentingFor = presenting ? this.presentingFor + delta : 0;
    const show = presenting && this.presentingFor > 0.6 && !audio.running();
    this.soundCard.visible = show;
    if (!show) return;
    getHeadWorld(this.world, this.head);
    yawForward(getHeadYaw(this.world), this.fwd);
    const card = this.soundCard;
    const tx = this.head.x + this.fwd.x * 0.95;
    const ty = this.head.y - 0.12;
    const tz = this.head.z + this.fwd.z * 0.95;
    const k = card.userData.placed ? 1 - Math.exp(-4 * delta) : 1;
    card.userData.placed = true;
    card.position.set(card.position.x + (tx - card.position.x) * k, card.position.y + (ty - card.position.y) * k, card.position.z + (tz - card.position.z) * k);
    card.lookAt(this.head.x, card.position.y, this.head.z);
    const pulse = 1 + 0.03 * Math.sin(performance.now() / 180);
    card.scale.setScalar(pulse);
  }

  /** Float the panel in front of the viewer, re-centring only when needed. */
  private placeInFront(): void {
    const object = this.panelObject!;
    const phase = game.phase.peek();
    // A third of the way up the first slope, the notes move into the pack
    // (except for the end-of-run screen and its buttons).
    if (this.panelInPack()) {
      this.placeInPack(object);
      return;
    }
    // While gliding or sliding, show the tips briefly and then get out of the way.
    object.visible = !(
      (phase === Phase.Gliding && this.phaseTime > 9) ||
      (phase === Phase.Sliding && this.phaseTime > 6)
    );
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
    } else if (phase === Phase.Climbing && exp.active.peek()) {
      // Expedition walls face any direction: keep the panel out of the face.
      const wall = currentLevel().currentWall();
      const into = wall ? -this.fwd.dot(wall.normal) : 0;
      if (wall && into > 0.2) {
        const out = this.toPanel.subVectors(this.head, wall.base).dot(wall.normal);
        distance = clampRange((out - 0.4) / into, 0.45, REFERENCE_DISTANCE);
        drop = 0.12;
      }
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

  /** In XR, does the panel live in the backpack (shown only while it's open)? */
  private panelInPack(): boolean {
    const phase = game.phase.peek();
    // Snow Survivors: out of the way while you fight, in front when you fall.
    if (survivors.active.peek()) return !survivors.dead.peek();
    if (phase === Phase.Landed) return false;
    if (exp.active.peek()) return true;
    if (phase !== Phase.Poling) return true;
    // Tutorial trail: float with you for the first third of the slope.
    return game.distanceToCliff.peek() <= (WALL_S * 2) / 3;
  }

  /** Rest against the open lid of the pack, facing you; hidden while it's shut. */
  private placeInPack(object: Object3D): void {
    const pack = packRefs.root;
    const notes = packRefs.notes;
    const open = game.packOpen.peek() && !!pack && !!notes && pack.scale.x > 0.6;
    object.visible = open;
    this.anchored = false;
    if (!open || !pack || !notes) return;
    getHeadWorld(this.world, this.head);
    pack.updateMatrixWorld(true);
    notes.getWorldPosition(object.position);
    const d = object.position.distanceTo(this.head);
    object.scale.setScalar(((BASE_SCALE * d) / REFERENCE_DISTANCE) * 0.62 * Math.min(1, pack.scale.x));
    object.lookAt(this.head);
  }
}

function clampRange(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** "Pinch to turn on the sound": a dark rounded card with big friendly text. */
function buildSoundCard(): Mesh {
  const w = 1024;
  const h = 420;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(16,26,48,0.92)';
  ctx.beginPath();
  ctx.roundRect(10, 10, w - 20, h - 20, 56);
  ctx.fill();
  ctx.strokeStyle = '#ffd25a';
  ctx.lineWidth = 10;
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffd25a';
  ctx.font = '800 88px system-ui, sans-serif';
  ctx.fillText('\u{1F50A}  Turn on the sound', w / 2, 140);
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 58px system-ui, sans-serif';
  ctx.fillText('Pinch your finger and thumb together', w / 2, 255);
  ctx.fillStyle = '#c9d6ee';
  ctx.font = '600 46px system-ui, sans-serif';
  ctx.fillText('(or pull a trigger)', w / 2, 335);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const card = new Mesh(
    new PlaneGeometry(0.62, (0.62 * h) / w),
    new MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }),
  );
  card.renderOrder = 50;
  card.name = 'SoundCard';
  card.visible = false;
  return card;
}
