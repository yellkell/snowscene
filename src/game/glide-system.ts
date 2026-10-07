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

import { createSystem, InputComponent, Vector3 } from '@iwsdk/core';
import { audio } from './audio.js';
import { BAR_BELOW_EYES, BAR_HALF_WIDTH, BAR_Y, BAR_Z, buildGlider } from './glider-model.js';
import { hands, HANDS } from './hand-input.js';
import { faceYaw, getHeadWorld, placeHeadAt, rotateRigAroundHead, yawForward } from './rig.js';
import { sceneRefs } from './scene-system.js';
import { fadeThen, game, Phase, setPhase } from './state.js';
import {
  CLIFF_CENTER_X,
  clamp,
  LAKE_CENTER_X,
  LAKE_CENTER_Z,
  LAKE_RADIUS_X,
  LAKE_RADIUS_Z,
  LAKE_Y,
  SUMMIT_Y,
  terrainHeight,
  WALL_Z,
} from './terrain.js';

const BAR_REACH = 0.2;
const MAX_TURN_RATE = 0.55; // rad/s
const LAUNCH_HOLD_TIME = 0.35;

function groundAt(x: number, z: number): number {
  const lx = (x - LAKE_CENTER_X) / (LAKE_RADIUS_X * 0.88);
  const lz = (z - LAKE_CENTER_Z) / (LAKE_RADIUS_Z * 0.88);
  const h = terrainHeight(x, z);
  return lx * lx + lz * lz < 1 ? Math.max(h, LAKE_Y) : h;
}

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
  private landedStopped = false;
  private readonly head = new Vector3();
  private readonly fwd = new Vector3();
  private readonly barA = new Vector3();
  private readonly barB = new Vector3();
  private readonly tmp = new Vector3();
  private readonly avg = new Vector3();

  init(): void {
    this.glider.root.visible = false;
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
    faceYaw(this.world, Math.PI);
    placeHeadAt(this.world, CLIFF_CENTER_X, WALL_Z - 0.55, SUMMIT_Y);
    this.gliderYawOffset = Math.PI - this.player.rotation.y;
    this.glider.root.visible = true;
    this.speed = 0;
    this.steer = 0;
    this.pitch = 0;
    this.barTimer = 0;
    game.barHeld.value = false;
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

  private poseGlider(): void {
    getHeadWorld(this.world, this.head);
    const root = this.glider.root;
    root.position.set(this.head.x, this.head.y - BAR_BELOW_EYES - BAR_Y, this.head.z);
    root.rotation.set(this.pitch * 0.14, this.gliderYaw, -this.steer * 0.32, 'YXZ');
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
    this.poseGlider();
    const held = this.world.renderer.xr.isPresenting
      ? this.bothHandsOnBar()
      : this.input.keyboard.getKeyPressed('Space') || this.input.keyboard.getKeyPressed('KeyW');
    if (game.barHeld.peek() !== held) game.barHeld.value = held;
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
    const targetSpeed = 9 - 2.2 * this.pitch;
    const sink = this.pitch < 0 ? 1.45 - this.pitch * 2.8 : 1.45 - this.pitch * 0.55;
    this.speed += (targetSpeed - this.speed) * Math.min(1, dt * 0.8);
    game.airspeed = this.speed;

    const rig = this.player;
    rig.position.addScaledVector(this.fwd, this.speed * dt);
    rig.position.y -= sink * dt;
    const turn = -this.steer * MAX_TURN_RATE * dt;
    if (turn !== 0) rotateRigAroundHead(this.world, turn, this.head);
    rig.updateMatrixWorld(true);
    this.poseGlider();

    getHeadWorld(this.world, this.head);
    const ground = groundAt(this.head.x, this.head.z);
    if (this.runOff > 0) {
      // Running off the edge: stay on the snow until it drops away beneath us.
      this.runOff -= dt;
      if (rig.position.y < ground) rig.position.y = ground;
      return;
    }
    if (rig.position.y <= ground + 0.05) {
      rig.position.y = ground;
      setPhase(Phase.Landed);
    }
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
    this.poseGlider();
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
    const x = this.head.x + this.fwd.x * 4 - this.fwd.z * 2.4;
    const z = this.head.z + this.fwd.z * 4 + this.fwd.x * 2.4;
    root.position.set(x, groundAt(x, z) - 0.95, z);
    root.rotation.set(-0.12, this.gliderYaw + 2.2, 0.28, 'YXZ');
    root.updateMatrixWorld(true);
  }

}
