/**
 * Launch and glide.
 *
 * After assembly the player stands at the cliff edge inside a full-size
 * hang glider. Closing both hands on the control bar launches. In flight:
 *  - tilt the bar like a steering wheel (raise one hand, lower the other)
 *    to turn;
 *  - pull the bar toward you to dive and speed up, push it away to float.
 * Touch down anywhere in the valley to finish.
 *
 * Controllers: thumbstick steers / pitches. Desktop: Space launches,
 * A/D steer, W dives, S floats.
 */

import { createSystem, Euler, InputComponent, Quaternion, Vector3 } from '@iwsdk/core';
import { audio } from './audio.js';
import { BAR_BELOW_EYES, BAR_HALF_WIDTH, BAR_Y, BAR_Z, buildGlider } from './glider-model.js';
import { hands, HANDS } from './hand-input.js';
import { currentLevel } from './level.js';
import { faceYaw, getHeadWorld, placeHeadAt, rotateRigAroundHead, wrapAngle, yawForward } from './rig.js';
import { sceneRefs } from './scene-system.js';
import { fadeThen, game, Phase, setPhase } from './state.js';
import { clamp } from './terrain.js';

const BAR_REACH = 0.2;
/** The bar follows your hands this far from its resting spot at most (m). */
const BAR_FOLLOW_MAX = 0.4;
/** How quickly the bar settles into your hands (per second). */
const BAR_FOLLOW_RATE = 30;
const MAX_BAR_ROLL = 0.6;
const MAX_TURN_RATE = 0.55; // rad/s
const LAUNCH_HOLD_TIME = 0.35;

const groundAt = (x: number, z: number): number => currentLevel().groundAt(x, z);

export class GlideSystem extends createSystem({}) {
  private glider = buildGlider();
  private gliderYawOffset = 0;
  private speed = 0;
  private steer = 0;
  private pitch = 0;
  private neutralReach = 0.5;
  private barTimer = 0;
  /** Seconds of take-off run during which the feet skim the snow instead of landing. */
  private runOff = 0;
  private cloudLanding = false;
  private landedStopped = false;
  private readonly head = new Vector3();
  private readonly fwd = new Vector3();
  private readonly barA = new Vector3();
  private readonly barB = new Vector3();
  private readonly tmp = new Vector3();
  private readonly avg = new Vector3();
  /** Where the bar sits relative to its resting spot, and its tilt, while held. */
  private readonly barOffset = new Vector3();
  private readonly barTarget = new Vector3();
  private barRoll = 0;
  private handBlend = 0;
  private readonly barLocal = new Vector3(0, BAR_Y, BAR_Z);
  private readonly handL = new Vector3();
  private readonly handR = new Vector3();
  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private readonly quat = new Quaternion();

  init(): void {
    this.glider.root.visible = false;
    this.glider.root.traverse((child) => {
      child.castShadow = true;
    });
    this.world.createTransformEntity(this.glider.root, { persistent: true });
    game.flyingGlider = this.glider.root;
    this.cleanupFuncs.push(
      game.phase.subscribe((phase) => {
        if (phase === Phase.Launch) this.prepareLaunch();
        if (phase === Phase.Landed) {
          this.landedStopped = false;
          audio.fanfare();
          getHeadWorld(this.world, this.head);
          sceneRefs.puffs?.emit(this.tmp.set(this.head.x, this.player.position.y, this.head.z), 16, 1.4);
        }
      }),
      game.resetCount.subscribe(() => {
        this.glider.root.visible = false;
        this.speed = 0;
        game.airspeed = 0;
        game.barHeld.value = false;
      }),
    );
  }

  /** Runs while the screen is white: stand the player at the edge, facing out. */
  private prepareLaunch(): void {
    const site = currentLevel().launch();
    faceYaw(this.world, site.yaw);
    placeHeadAt(this.world, site.x, site.z, site.floorY);
    this.gliderYawOffset = site.yaw - this.player.rotation.y;
    this.glider.root.visible = true;
    this.speed = 0;
    this.steer = 0;
    this.pitch = 0;
    this.barTimer = 0;
    game.barHeld.value = false;
    this.handBlend = 0;
    this.barOffset.set(0, 0, 0);
    this.barRoll = 0;
    this.poseGlider();
  }

  update(delta: number): void {
    const dt = Math.min(delta, 0.1);
    const phase = game.phase.peek();
    if (phase === Phase.Launch) this.updateLaunch(dt);
    else if (phase === Phase.Gliding) this.updateGlide(dt);
    else if (phase === Phase.Landed) this.updateLanded(dt);
  }

  private get gliderYaw(): number {
    return this.player.rotation.y + this.gliderYawOffset;
  }

  /**
   * Hang the glider from its control bar. The bar rests below and in front
   * of the eyes; while both hands hold it, it sits in your hands instead
   * (centred between them, tilted with them), and the wing pivots about the
   * bar like a real hang glider's.
   */
  private poseGlider(dt = 0, followHands = false): void {
    getHeadWorld(this.world, this.head);
    const root = this.glider.root;
    const yaw = this.gliderYaw;
    yawForward(yaw, this.fwd);
    // The bar's resting spot.
    const rest = this.tmp.set(this.head.x, this.head.y - BAR_BELOW_EYES, this.head.z).addScaledVector(this.fwd, -BAR_Z);
    let roll = -this.steer * 0.32;

    const holding = followHands && hands.left.tracked && hands.right.tracked && hands.left.grip && hands.right.grip;
    if (holding) {
      // Fresh hand positions: the rig has moved since the hands were read this frame.
      const grips = this.player.gripSpaces;
      grips.left.updateWorldMatrix(true, false);
      grips.right.updateWorldMatrix(true, false);
      const left = this.handL.setFromMatrixPosition(grips.left.matrixWorld);
      const right = this.handR.setFromMatrixPosition(grips.right.matrixWorld);
      this.barTarget.addVectors(left, right).multiplyScalar(0.5).sub(rest);
      if (this.barTarget.length() > BAR_FOLLOW_MAX) this.barTarget.setLength(BAR_FOLLOW_MAX);
      const span = Math.max(0.2, left.distanceTo(right));
      const handRoll = clamp(Math.asin(clamp((right.y - left.y) / span, -1, 1)), -MAX_BAR_ROLL, MAX_BAR_ROLL);
      const k = dt > 0 ? 1 - Math.exp(-BAR_FOLLOW_RATE * dt) : 1;
      this.barOffset.lerp(this.barTarget, k);
      this.barRoll += (handRoll - this.barRoll) * k;
    }
    const blendRate = dt > 0 ? 1 - Math.exp(-(holding ? 12 : 3) * dt) : 1;
    this.handBlend += ((holding ? 1 : 0) - this.handBlend) * blendRate;
    if (this.handBlend < 1e-3 && !holding) {
      this.barOffset.set(0, 0, 0);
      this.barRoll = roll;
    }
    roll += (this.barRoll - roll) * this.handBlend;
    rest.addScaledVector(this.barOffset, this.handBlend);

    this.euler.set(this.pitch * 0.14, yaw, roll, 'YXZ');
    root.rotation.copy(this.euler);
    this.quat.setFromEuler(this.euler);
    root.position.copy(this.barLocal).applyQuaternion(this.quat).multiplyScalar(-1).add(rest);
    root.updateMatrixWorld(true);
  }

  /** Distance from a point to the control bar's base tube. */
  private barDistance(point: Vector3): number {
    const root = this.glider.root;
    root.localToWorld(this.barA.set(-BAR_HALF_WIDTH, BAR_Y, BAR_Z));
    root.localToWorld(this.barB.set(BAR_HALF_WIDTH, BAR_Y, BAR_Z));
    this.tmp.subVectors(this.barB, this.barA);
    const t = clamp(this.tmp.dot(this.avg.subVectors(point, this.barA)) / this.tmp.lengthSq(), 0, 1);
    this.tmp.multiplyScalar(t).add(this.barA);
    return this.tmp.distanceTo(point);
  }

  private bothHandsOnBar(): boolean {
    let onBar = 0;
    for (const hand of HANDS) {
      if (hand.tracked && hand.grip && this.barDistance(hand.position) < BAR_REACH) onBar++;
    }
    return onBar === 2;
  }

  private updateLaunch(dt: number): void {
    const gripping = hands.left.tracked && hands.right.tracked && hands.left.grip && hands.right.grip;
    const held = this.world.renderer.xr.isPresenting
      ? gripping && (this.handBlend > 0.5 || this.bothHandsOnBar())
      : this.input.keyboard.getKeyPressed('Space') || this.input.keyboard.getKeyPressed('KeyW');
    if (game.barHeld.peek() !== held) game.barHeld.value = held;
    this.poseGlider(dt, held && this.world.renderer.xr.isPresenting);
    this.barTimer = held ? this.barTimer + dt : 0;
    if (this.barTimer >= LAUNCH_HOLD_TIME) {
      getHeadWorld(this.world, this.head);
      yawForward(this.gliderYaw, this.fwd);
      this.neutralReach = this.handReach();
      this.speed = 6.5;
      this.runOff = 1.2;
      audio.whoosh();
      setPhase(Phase.Gliding);
    }
  }

  /** How far in front of the eyes the hands are, along the glider heading. */
  private handReach(): number {
    this.avg.addVectors(hands.left.position, hands.right.position).multiplyScalar(0.5);
    return this.tmp.subVectors(this.avg, this.head).dot(this.fwd);
  }

  private readInputs(dt: number): void {
    let steer = 0;
    let pitch = 0;
    if (this.world.renderer.xr.isPresenting) {
      const left = hands.left;
      const right = hands.right;
      if (left.tracked && right.tracked && left.grip && right.grip) {
        // Steering wheel: left hand up / right hand down turns right.
        steer = clamp((left.position.y - right.position.y) / 0.28, -1, 1);
        pitch = clamp((this.handReach() - this.neutralReach) / 0.16, -1, 1);
      }
      for (const side of ['left', 'right'] as const) {
        const pad = this.input.xr.gamepads[side];
        const axes = pad?.getAxesValues(InputComponent.Thumbstick);
        if (axes && (Math.abs(axes.x) > 0.1 || Math.abs(axes.y) > 0.1)) {
          steer = axes.x;
          pitch = axes.y;
        }
      }
    } else {
      const kb = this.input.keyboard;
      steer = (kb.getKeyPressed('KeyD') || kb.getKeyPressed('ArrowRight') ? 1 : 0) -
        (kb.getKeyPressed('KeyA') || kb.getKeyPressed('ArrowLeft') ? 1 : 0);
      pitch = (kb.getKeyPressed('KeyS') || kb.getKeyPressed('ArrowDown') ? 1 : 0) -
        (kb.getKeyPressed('KeyW') || kb.getKeyPressed('ArrowUp') ? 1 : 0);
    }
    const k = Math.min(1, dt * 4);
    this.steer += (steer - this.steer) * k;
    this.pitch += (pitch - this.pitch) * k;
  }

  private updateGlide(dt: number): void {
    getHeadWorld(this.world, this.head);
    yawForward(this.gliderYaw, this.fwd);
    this.readInputs(dt);

    // Push out (pitch > 0) floats slowly, pull in (pitch < 0) dives fast.
    const lvl = currentLevel();
    const targetSpeed = lvl.glideSpeed - 2.2 * this.pitch;
    let sink = this.pitch < 0 ? 1.45 - this.pitch * 2.8 : 1.45 - this.pitch * 0.55;
    this.speed += (targetSpeed - this.speed) * Math.min(1, dt * 0.8);
    game.airspeed = this.speed;

    // Gentle approach assist toward a landing spot just short of the camp
    // fire. Your own steering and pitch always take precedence.
    let autoTurn = 0;
    const toX = lvl.glideTarget.x - this.head.x;
    const toZ = lvl.glideTarget.z - this.head.z;
    const fireDist = Math.hypot(toX, toZ);
    const aimDist = fireDist - lvl.landingShort;
    if (aimDist > 3) {
      const err = wrapAngle(Math.atan2(-toX, -toZ) - this.gliderYaw);
      if (Math.abs(this.steer) < 0.15) autoTurn = clamp(err * 0.6, -0.4, 0.4);
      if (Math.abs(err) < 0.9) {
        const needed = ((this.player.position.y - lvl.glideTarget.y) / aimDist) * this.speed;
        const weight = (lvl.glideAssist?.weight ?? 0.8) * (1 - Math.min(1, Math.abs(this.pitch)));
        sink += (clamp(needed, 0.3, lvl.glideAssist?.maxSink ?? 4.5) - sink) * weight;
      }
      const clearance = lvl.glideAssist?.clearance ?? 0;
      if (clearance > 0) sink = this.terrainLift(sink, clearance, aimDist);
    }

    const rig = this.player;
    rig.position.addScaledVector(this.fwd, this.speed * dt);
    rig.position.y -= sink * dt;
    const turn = (-this.steer * MAX_TURN_RATE + autoTurn) * dt;
    if (turn !== 0) rotateRigAroundHead(this.world, turn, this.head);
    rig.updateMatrixWorld(true);
    this.poseGlider(dt, true);

    getHeadWorld(this.world, this.head);
    const ground = groundAt(this.head.x, this.head.z);
    if (this.runOff > 0) {
      // Running off the edge: stay on the snow until it drops away beneath us.
      this.runOff -= dt;
      if (rig.position.y < ground) rig.position.y = ground;
      return;
    }
    const deck = lvl.cloudDeckY;
    if (lvl.cloudLanding && ground < deck + 5 && rig.position.y < deck + 18) {
      // Flown out over open air: sink through the clouds and touch down
      // softly near the landing site.
      if (!this.cloudLanding) {
        this.cloudLanding = true;
        fadeThen(() => {
          this.cloudLanding = false;
          const spot = lvl.cloudLanding?.();
          if (spot) {
            faceYaw(this.world, spot.yaw);
            placeHeadAt(this.world, spot.x, spot.z, groundAt(spot.x, spot.z));
            this.gliderYawOffset = spot.yaw - this.player.rotation.y;
          }
          this.speed = 0;
          setPhase(Phase.Landed);
        });
      }
      return;
    }
    if (rig.position.y <= ground + 0.05) {
      rig.position.y = ground;
      setPhase(Phase.Landed);
    }
  }

  /**
   * Lift over rising ground (levels with `glideAssist.clearance`): keep about
   * `clearance` metres of air under the glider, looking 1.5 s and 3 s ahead,
   * easing to a few metres on the final approach so you can still land.
   */
  private terrainLift(sink: number, clearance: number, aimDist: number): number {
    const t = clamp((aimDist - 60) / 160, 0, 1);
    const want = clearance * (0.12 + 0.88 * t * t * (3 - 2 * t));
    const reach = this.speed;
    const ground = Math.max(
      groundAt(this.head.x, this.head.z),
      groundAt(this.head.x + this.fwd.x * reach * 1.5, this.head.z + this.fwd.z * reach * 1.5),
      groundAt(this.head.x + this.fwd.x * reach * 3, this.head.z + this.fwd.z * reach * 3),
    );
    const agl = this.player.position.y - ground;
    if (agl >= want) return sink;
    const k = clamp(agl / want, 0, 1);
    return Math.min(sink, -3 + (sink + 3) * k);
  }

  private updateLanded(dt: number): void {
    if (this.landedStopped) return;
    getHeadWorld(this.world, this.head);
    yawForward(this.gliderYaw, this.fwd);
    this.speed *= Math.exp(-2.4 * dt);
    this.steer *= Math.exp(-4 * dt);
    this.pitch *= Math.exp(-4 * dt);
    const rig = this.player;
    rig.position.addScaledVector(this.fwd, this.speed * dt);
    rig.updateMatrixWorld(true);
    getHeadWorld(this.world, this.head);
    rig.position.y = groundAt(this.head.x, this.head.z);
    game.airspeed = this.speed;
    this.poseGlider(dt, true);
    if (this.speed < 0.15) {
      this.landedStopped = true;
      game.airspeed = 0;
      // Unclip: the glider ends up resting in the snow beside the player.
      fadeThen(() => this.parkGlider());
    }
  }

  private parkGlider(): void {
    getHeadWorld(this.world, this.head);
    yawForward(this.gliderYaw, this.fwd);
    const root = this.glider.root;
    // Set it down off to the side, clear of the campfire ahead.
    const x = this.head.x - this.fwd.x * 0.5 - this.fwd.z * 5;
    const z = this.head.z - this.fwd.z * 0.5 + this.fwd.x * 5;
    root.position.set(x, groundAt(x, z) - 0.95, z);
    root.rotation.set(-0.12, this.gliderYaw + 1.3, 0.28, 'YXZ');
    root.updateMatrixWorld(true);
  }

}
