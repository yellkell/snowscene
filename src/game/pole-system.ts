/**
 * Walking-stick locomotion.
 *
 * Close a hand to grip its pole. When the tip of a gripped pole touches the
 * snow it plants; while planted, pulling your hand back drives you forward
 * (as if levering yourself along the pole). Pushes feed a smoothed velocity
 * rather than moving you directly, so hand-tracking jitter never jerks the
 * view, and a little momentum carries you between strokes. A planted pole
 * never brakes you. Open the hand or lift the pole to unplant. Every plant
 * leaves a hole in the snow, so your strides leave a trail behind you.
 *
 * In the desktop browser (no headset) hold W / ArrowUp to stride and watch
 * the simulated poles swing.
 */

import { createSystem, Mesh, Quaternion, Vector3 } from '@iwsdk/core';
import { audio } from './audio.js';
import { hands, HANDS, type HandState } from './hand-input.js';
import { getHeadWorld, getHeadYaw, yawForward } from './rig.js';
import { sceneRefs } from './scene-system.js';
import { holding } from './equipment.js';
import { currentLevel, level } from './level.js';
import { PoleMarks } from './pole-marks.js';
import { game, Phase } from './state.js';
import { buildPole, POLE_TIP_DISTANCE } from './world-builders.js';

/** Body speed per unit of planted-hand speed. */
const POLE_GAIN = 1.5;
const MAX_SPEED = 3.4;
const DESKTOP_SPEED = 2.4;
/** Hand speeds below this (m/s) are treated as tracking noise. */
const PUSH_DEAD_ZONE = 0.12;
/** How quickly a push brings the body up to speed (per second). */
const PUSH_RESPONSE = 14;
/** Fraction of "straight down" mixed into the grip axis so tips plant easily. */
const DOWN_BIAS = 0.3;
const PLANT_DEPTH = 0.04;
const UNPLANT_HEIGHT = 0.18;

interface PoleState {
  mesh: Mesh;
  planted: boolean;
  /** Where the tip went into the snow (world). */
  readonly anchor: Vector3;
  /** Hand position in rig-local space last frame (for hand velocity). */
  readonly prevLocal: Vector3;
  /** Smoothed hand velocity relative to the body, rig-local. */
  readonly handVel: Vector3;
  /** Smoothed visual orientation. */
  readonly quat: Quaternion;
}

const groundHeight = (x: number, z: number): number => currentLevel().groundAt(x, z);

const Z_AXIS = new Vector3(0, 0, 1);
const DOWN = new Vector3(0, -1, 0);

export class PoleSystem extends createSystem({}) {
  private poles!: Record<'left' | 'right', PoleState>;
  private readonly head = new Vector3();
  private readonly tip = new Vector3();
  private readonly local = new Vector3();
  private readonly push = new Vector3();
  private readonly dir = new Vector3();
  private readonly fwd = new Vector3();
  private readonly right = new Vector3();
  private readonly target = new Quaternion();
  private readonly hangTarget = new Quaternion().setFromUnitVectors(Z_AXIS, DOWN);
  private strideClock = 0;
  private readonly marks = new PoleMarks();

  init(): void {
    this.world.createTransformEntity(this.marks.mesh, { persistent: true });
    const makePole = (): PoleState => {
      const mesh = buildPole();
      mesh.visible = false;
      mesh.castShadow = true;
      this.world.createTransformEntity(mesh, { persistent: true });
      return {
        mesh,
        planted: false,
        anchor: new Vector3(),
        prevLocal: new Vector3(),
        handVel: new Vector3(),
        quat: new Quaternion().copy(this.hangTarget),
      };
    };
    this.poles = { left: makePole(), right: makePole() };

    this.cleanupFuncs.push(
      // A fresh mountain (or a restart) starts with untrodden snow.
      game.resetCount.subscribe(() => this.marks.clear()),
      level.subscribe(() => this.marks.clear()),
      game.phase.subscribe((phase) => {
        if (phase !== Phase.Poling) {
          for (const pole of Object.values(this.poles)) {
            pole.planted = false;
            pole.mesh.visible = false;
          }
        }
      }),
    );
  }

  update(delta: number): void {
    if (game.phase.peek() !== Phase.Poling) return;
    const dt = Math.max(1e-3, Math.min(delta, 0.1));
    const rig = this.player;

    if (!this.world.renderer.xr.isPresenting) {
      this.updateDesktop(dt);
      this.constrainToTrail(dt);
      return;
    }

    this.push.set(0, 0, 0);
    let pushing = 0;
    for (const hand of HANDS) {
      if (this.updatePole(hand, this.poles[hand.handedness], dt)) pushing++;
    }

    const speed = Math.hypot(game.velocity.x, game.velocity.z);
    const pushSpeed = Math.hypot(this.push.x, this.push.z) / Math.max(1, pushing);
    if (pushing > 0 && pushSpeed > speed) {
      // Ease toward the push velocity: smooth, but responsive.
      this.push.divideScalar(pushing);
      const k = 1 - Math.exp(-PUSH_RESPONSE * dt);
      game.velocity.x += (this.push.x - game.velocity.x) * k;
      game.velocity.z += (this.push.z - game.velocity.z) * k;
    } else {
      // Coast on the snow, a little more drag when heading uphill.
      getHeadWorld(this.world, this.head);
      const ahead = groundHeight(
        this.head.x + game.velocity.x * 0.25,
        this.head.z + game.velocity.z * 0.25,
      );
      const uphill = Math.max(0, ahead - groundHeight(this.head.x, this.head.z));
      game.velocity.multiplyScalar(Math.exp(-(1.3 + uphill * 6) * dt));
    }
    const v = Math.hypot(game.velocity.x, game.velocity.z);
    if (v > MAX_SPEED) game.velocity.multiplyScalar(MAX_SPEED / v);
    rig.position.x += game.velocity.x * dt;
    rig.position.z += game.velocity.z * dt;

    this.constrainToTrail(dt);
  }

  /** Returns true if this pole is planted and being pushed. */
  private updatePole(hand: HandState, pole: PoleState, dt: number): boolean {
    if (!hand.tracked || !holding(hand.handedness, 'poles')) {
      pole.mesh.visible = false;
      pole.planted = false;
      return false;
    }
    pole.mesh.visible = true;
    pole.mesh.position.copy(hand.position);
    const smooth = 1 - Math.exp(-25 * dt);

    if (!hand.grip) {
      pole.planted = false;
      pole.quat.slerp(this.hangTarget, 1 - Math.exp(-10 * dt));
      pole.mesh.quaternion.copy(pole.quat);
      return false;
    }

    // Shaft runs out of the pinky side of the fist (grip +Z), biased down.
    this.dir.copy(Z_AXIS).applyQuaternion(hand.quaternion);
    this.dir.multiplyScalar(1 - DOWN_BIAS).addScaledVector(DOWN, DOWN_BIAS).normalize();
    this.tip.copy(hand.position).addScaledVector(this.dir, POLE_TIP_DISTANCE);
    const ground = groundHeight(this.tip.x, this.tip.z);

    if (!pole.planted && this.tip.y < ground + PLANT_DEPTH) {
      pole.planted = true;
      pole.anchor.set(this.tip.x, ground, this.tip.z);
      this.player.worldToLocal(pole.prevLocal.copy(hand.position));
      pole.handVel.set(0, 0, 0);
      audio.crunch(hand.isHand ? 1 : 0.8);
      sceneRefs.puffs?.emit(pole.anchor, 7);
      this.marks.add(pole.anchor.x, pole.anchor.z, groundHeight);
      this.pulse(hand.handedness);
    } else if (pole.planted) {
      const lifted = this.tip.y > ground + UNPLANT_HEIGHT;
      const overreached = hand.position.distanceTo(pole.anchor) > POLE_TIP_DISTANCE + 0.35;
      if (lifted || overreached) pole.planted = false;
    }

    if (pole.planted) {
      // Visually pivot the pole about the planted tip.
      this.dir.subVectors(pole.anchor, hand.position).normalize();
    }
    this.target.setFromUnitVectors(Z_AXIS, this.dir);
    pole.quat.slerp(this.target, pole.planted ? 1 : smooth);
    pole.mesh.quaternion.copy(pole.quat);
    if (!pole.planted) return false;

    // Hand velocity relative to the body (rig-local), low-passed.
    this.player.worldToLocal(this.local.copy(hand.position));
    const vx = (this.local.x - pole.prevLocal.x) / dt;
    const vz = (this.local.z - pole.prevLocal.z) / dt;
    pole.prevLocal.copy(this.local);
    const k = 1 - Math.exp(-20 * dt);
    pole.handVel.x += (vx - pole.handVel.x) * k;
    pole.handVel.z += (vz - pole.handVel.z) * k;
    const handSpeed = Math.hypot(pole.handVel.x, pole.handVel.z);
    if (handSpeed < PUSH_DEAD_ZONE) return false;

    // Hand moving back relative to the body => body moves forward.
    const scale = (POLE_GAIN * (handSpeed - PUSH_DEAD_ZONE)) / handSpeed;
    const lx = -pole.handVel.x * scale;
    const lz = -pole.handVel.z * scale;
    const yaw = this.player.rotation.y;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    this.push.x += lx * cos + lz * sin;
    this.push.z += -lx * sin + lz * cos;
    return true;
  }

  /** Short haptic tick on controllers when a pole bites into the snow. */
  private pulse(side: 'left' | 'right'): void {
    const actuator = this.input.xr.gamepads[side]?.gamepad?.hapticActuators?.[0] as
      | { pulse?: (value: number, duration: number) => void }
      | undefined;
    actuator?.pulse?.(0.35, 30);
  }

  private updateDesktop(dt: number): void {
    const keyboard = this.input.keyboard;
    const forward = keyboard.getKeyPressed('KeyW') || keyboard.getKeyPressed('ArrowUp');
    const back = keyboard.getKeyPressed('KeyS') || keyboard.getKeyPressed('ArrowDown');
    getHeadWorld(this.world, this.head);
    // Follow the route so W always heads the right way along it.
    currentLevel().walkDirection(this.head.x, this.head.z, this.fwd);
    const cruise = currentLevel().desktopWalkSpeed ?? DESKTOP_SPEED;
    const target = forward ? cruise : back ? -1.2 : 0;
    const vx = this.fwd.x * target;
    const vz = this.fwd.z * target;
    game.velocity.x += (vx - game.velocity.x) * Math.min(1, dt * 3);
    game.velocity.z += (vz - game.velocity.z) * Math.min(1, dt * 3);
    this.player.position.x += game.velocity.x * dt;
    this.player.position.z += game.velocity.z * dt;

    // Simulated poles swinging in front of the camera.
    const speed = Math.hypot(game.velocity.x, game.velocity.z);
    this.strideClock += speed * dt * 2.2;
    const yaw = getHeadYaw(this.world);
    yawForward(yaw, this.dir);
    this.right.set(-this.dir.z, 0, this.dir.x);
    for (const hand of HANDS) {
      const pole = this.poles[hand.handedness];
      const side = hand === hands.left ? -1 : 1;
      const phase = this.strideClock + (side > 0 ? Math.PI : 0);
      const swing = Math.sin(phase);
      pole.mesh.visible = holding(hand.handedness, 'poles');
      if (!pole.mesh.visible) continue;
      pole.mesh.position
        .copy(this.head)
        .addScaledVector(this.right, side * 0.3)
        .addScaledVector(this.dir, 0.42 + swing * 0.12)
        .setY(this.head.y - 0.55 + Math.max(0, Math.cos(phase)) * 0.06);
      this.tip
        .copy(pole.mesh.position)
        .addScaledVector(this.dir, 0.1 - swing * 0.45)
        .addScaledVector(this.right, side * 0.08);
      this.tip.y = groundHeight(this.tip.x, this.tip.z) - 0.1;
      this.dir.subVectors(this.tip, pole.mesh.position).normalize();
      pole.mesh.quaternion.setFromUnitVectors(Z_AXIS, this.dir);
      yawForward(yaw, this.dir);
      // crunch as each pole swings through the bottom of its arc
      const wasPlanted = pole.planted;
      pole.planted = speed > 0.5 && Math.cos(phase) > 0.92;
      if (pole.planted && !wasPlanted) {
        audio.crunch(0.6);
        this.marks.add(this.tip.x, this.tip.z, groundHeight);
        sceneRefs.puffs?.emit(this.tip.setY(this.tip.y + 0.1), 5, 0.7);
      }
    }
  }

  /** Keep the player on the route and glue their feet to the snow. */
  private constrainToTrail(dt: number): void {
    const rig = this.player;
    rig.updateMatrixWorld(true);
    getHeadWorld(this.world, this.head);
    currentLevel().constrainWalk(this.head, rig, game.velocity, dt);
    if (game.phase.peek() !== Phase.Poling) return;
    rig.updateMatrixWorld(true);
    getHeadWorld(this.world, this.head);
    const floor = groundHeight(this.head.x, this.head.z);
    rig.position.y += (floor - rig.position.y) * Math.min(1, dt * 12);
  }

}
