/**
 * Walking-stick locomotion.
 *
 * Close a hand to grip its pole. When the tip of a gripped pole touches the
 * snow it plants; while planted, moving your hand back pushes your body
 * forward (as if levering yourself along the pole), and a little momentum
 * carries you between strokes. Open the hand or lift the pole to unplant.
 *
 * In the desktop browser (no headset) hold W / ArrowUp to stride and watch
 * the simulated poles swing.
 */

import { createSystem, Mesh, Quaternion, Vector3 } from '@iwsdk/core';
import { audio } from './audio.js';
import { hands, HANDS, type HandState } from './hand-input.js';
import { getHeadWorld, getHeadYaw, yawForward } from './rig.js';
import { sceneRefs } from './scene-system.js';
import { CLIMB_TRIGGER_S, game, Phase, setPhase } from './state.js';
import {
  clamp,
  pathX,
  terrainHeight,
  TRAIL_HALF_WIDTH,
  WALL_S,
} from './terrain.js';
import { buildPole, POLE_TIP_DISTANCE } from './world-builders.js';

/** Body travel per metre of planted-hand travel. */
const POLE_GAIN = 1.3;
const MAX_SPEED = 3.2;
const DESKTOP_SPEED = 2.4;

interface PoleState {
  mesh: Mesh;
  planted: boolean;
  /** Where the tip went into the snow (world). */
  readonly anchor: Vector3;
  /** Planted tip position in rig-local space last frame. */
  readonly prevLocal: Vector3;
  /** Smoothed orientation used while the pole dangles from the wrist. */
  readonly hangQuat: Quaternion;
}

const Z_AXIS = new Vector3(0, 0, 1);
const DOWN = new Vector3(0, -1, 0);

export class PoleSystem extends createSystem({}) {
  private poles!: Record<'left' | 'right', PoleState>;
  private readonly head = new Vector3();
  private readonly tip = new Vector3();
  private readonly local = new Vector3();
  private readonly move = new Vector3();
  private readonly dir = new Vector3();
  private readonly fwd = new Vector3();
  private readonly right = new Vector3();
  private readonly quat = new Quaternion();
  private readonly hangTarget = new Quaternion().setFromUnitVectors(Z_AXIS, DOWN);
  private strideClock = 0;

  init(): void {
    const makePole = (): PoleState => {
      const mesh = buildPole();
      mesh.visible = false;
      this.world.createTransformEntity(mesh, { persistent: true });
      return {
        mesh,
        planted: false,
        anchor: new Vector3(),
        prevLocal: new Vector3(),
        hangQuat: new Quaternion().copy(this.hangTarget),
      };
    };
    this.poles = { left: makePole(), right: makePole() };

    this.cleanupFuncs.push(
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
    const dt = Math.min(delta, 0.1);
    const rig = this.player;

    this.move.set(0, 0, 0);
    let pushing = 0;

    if (this.world.renderer.xr.isPresenting) {
      for (const hand of HANDS) {
        if (this.updatePole(hand, this.poles[hand.handedness])) pushing++;
      }
    } else {
      this.updateDesktop(dt);
      this.constrainToTrail(dt);
      return;
    }

    this.move.multiplyScalar(pushing > 0 ? POLE_GAIN / pushing : 0);
    const pushSpeed = Math.hypot(this.move.x, this.move.z) / dt;
    const coastSpeed = Math.hypot(game.velocity.x, game.velocity.z);
    if (pushing > 0 && pushSpeed >= coastSpeed) {
      // A pole stroke faster than our glide drives us and sets the momentum.
      rig.position.x += this.move.x;
      rig.position.z += this.move.z;
      game.velocity.x += (this.move.x / dt - game.velocity.x) * 0.5;
      game.velocity.z += (this.move.z / dt - game.velocity.z) * 0.5;
    } else {
      // Coast on the snow; a planted pole never acts as a brake.
      rig.position.x += game.velocity.x * dt;
      rig.position.z += game.velocity.z * dt;
      getHeadWorld(this.world, this.head);
      const ahead = terrainHeight(
        this.head.x + game.velocity.x * 0.25,
        this.head.z + game.velocity.z * 0.25,
      );
      const uphill = Math.max(0, ahead - terrainHeight(this.head.x, this.head.z));
      const drag = 1.5 + uphill * 6;
      game.velocity.multiplyScalar(Math.exp(-drag * dt));
    }
    const speed = Math.hypot(game.velocity.x, game.velocity.z);
    if (speed > MAX_SPEED) game.velocity.multiplyScalar(MAX_SPEED / speed);

    this.constrainToTrail(dt);
  }

  /** Returns true if this pole is planted and contributed a push. */
  private updatePole(hand: HandState, pole: PoleState): boolean {
    if (!hand.tracked) {
      pole.mesh.visible = false;
      pole.planted = false;
      return false;
    }
    pole.mesh.visible = true;
    pole.mesh.position.copy(hand.position);

    if (hand.grip) {
      // The shaft runs out of the pinky side of the fist (grip +Z).
      this.quat.copy(hand.quaternion);
      if (pole.planted) {
        // Pivot visually about the planted tip.
        this.dir.subVectors(pole.anchor, hand.position).normalize();
        this.quat.setFromUnitVectors(Z_AXIS, this.dir);
      }
      pole.mesh.quaternion.copy(this.quat);
      pole.hangQuat.copy(this.quat);
    } else {
      pole.hangQuat.slerp(this.hangTarget, 0.15);
      pole.mesh.quaternion.copy(pole.hangQuat);
      pole.planted = false;
    }

    this.tip.copy(Z_AXIS).applyQuaternion(pole.mesh.quaternion);
    this.tip.multiplyScalar(POLE_TIP_DISTANCE).add(hand.position);
    const ground = terrainHeight(this.tip.x, this.tip.z);

    if (hand.grip && !pole.planted && this.tip.y < ground + 0.03) {
      pole.planted = true;
      pole.anchor.set(this.tip.x, ground, this.tip.z);
      this.player.worldToLocal(this.local.copy(this.tip));
      pole.prevLocal.copy(this.local);
      audio.crunch(hand.isHand ? 1 : 0.8);
      sceneRefs.puffs?.emit(pole.anchor, 7);
      return false;
    }

    if (pole.planted) {
      // Use the un-pivoted grip direction for tip tracking so the push
      // follows the real hand rather than the visual.
      this.tip.copy(Z_AXIS).applyQuaternion(hand.quaternion);
      this.tip.multiplyScalar(POLE_TIP_DISTANCE).add(hand.position);
      const lifted = this.tip.y > terrainHeight(this.tip.x, this.tip.z) + 0.2;
      const overreached = hand.position.distanceTo(pole.anchor) > POLE_TIP_DISTANCE + 0.45;
      if (lifted || overreached) {
        pole.planted = false;
        return false;
      }
      this.player.worldToLocal(this.local.copy(this.tip));
      const dxLocal = this.local.x - pole.prevLocal.x;
      const dzLocal = this.local.z - pole.prevLocal.z;
      pole.prevLocal.copy(this.local);
      // Hand moved back relative to the body => body moves forward.
      const yaw = this.player.rotation.y;
      const cos = Math.cos(yaw);
      const sin = Math.sin(yaw);
      this.move.x -= dxLocal * cos + dzLocal * sin;
      this.move.z -= -dxLocal * sin + dzLocal * cos;
      return true;
    }
    return false;
  }

  private updateDesktop(dt: number): void {
    const keyboard = this.input.keyboard;
    const forward = keyboard.getKeyPressed('KeyW') || keyboard.getKeyPressed('ArrowUp');
    const back = keyboard.getKeyPressed('KeyS') || keyboard.getKeyPressed('ArrowDown');
    getHeadWorld(this.world, this.head);
    // Follow the trail's direction so W always heads uphill along it.
    const z = this.head.z;
    this.fwd.set(pathX(z - 1) - pathX(z), 0, -1).normalize();
    // gently steer back to the centre line
    this.fwd.x += clamp((pathX(z) - this.head.x) * 0.15, -0.3, 0.3);
    this.fwd.normalize();
    const target = forward ? DESKTOP_SPEED : back ? -1.2 : 0;
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
      pole.mesh.visible = true;
      pole.mesh.position
        .copy(this.head)
        .addScaledVector(this.right, side * 0.3)
        .addScaledVector(this.dir, 0.42 + swing * 0.12)
        .setY(this.head.y - 0.55 + Math.max(0, Math.cos(phase)) * 0.06);
      this.tip
        .copy(pole.mesh.position)
        .addScaledVector(this.dir, 0.1 - swing * 0.45)
        .addScaledVector(this.right, side * 0.08);
      this.tip.y = terrainHeight(this.tip.x, this.tip.z) - 0.1;
      this.dir.subVectors(this.tip, pole.mesh.position).normalize();
      pole.mesh.quaternion.setFromUnitVectors(Z_AXIS, this.dir);
      yawForward(yaw, this.dir);
      // crunch as each pole swings through the bottom of its arc
      const wasPlanted = pole.planted;
      pole.planted = speed > 0.5 && Math.cos(phase) > 0.92;
      if (pole.planted && !wasPlanted) {
        audio.crunch(0.6);
        sceneRefs.puffs?.emit(this.tip.setY(this.tip.y + 0.1), 5, 0.7);
      }
    }
  }

  /** Keep the player on the trail corridor and glue their feet to the snow. */
  private constrainToTrail(dt: number): void {
    const rig = this.player;
    rig.updateMatrixWorld(true);
    getHeadWorld(this.world, this.head);
    let s = -this.head.z;
    const centre = pathX(this.head.z);
    const lateral = this.head.x - centre;
    const clampedLateral = clamp(lateral, -TRAIL_HALF_WIDTH, TRAIL_HALF_WIDTH);
    if (clampedLateral !== lateral) {
      rig.position.x += clampedLateral - lateral;
      game.velocity.x *= 0.5;
    }
    const clampedS = clamp(s, -6, WALL_S - 0.6);
    if (clampedS !== s) {
      rig.position.z -= clampedS - s;
      game.velocity.z = 0;
      s = clampedS;
    }
    const ground = terrainHeight(this.head.x, this.head.z);
    rig.position.y += (ground - rig.position.y) * Math.min(1, dt * 12);

    const remaining = Math.max(0, Math.round(WALL_S - s));
    if (game.distanceToCliff.peek() !== remaining) game.distanceToCliff.value = remaining;

    if (s >= CLIMB_TRIGGER_S) {
      game.velocity.set(0, 0, 0);
      setPhase(Phase.Climbing);
    }
  }
}
