/**
 * Wall climbing, for any wall the active level provides.
 *
 * Holds mode: reach a glowing hold, close your hand to grab it, then pull:
 * the world is locked to the grabbing hand, so pulling down lifts your body.
 *
 * Axes mode (ice): with ice axes in hand, swing a pick into the ice anywhere
 * on the face. A swing that hits the ice moving fast enough bites and holds
 * like a hold until you open your hand.
 *
 * The most recent grab drives movement, so you can go hand over hand. Let go
 * of everything and you slide gently back down. Once your head is over the
 * lip you are hauled up onto the top.
 *
 * Desktop fallback: hold W / ArrowUp to climb.
 */

import { createSystem, Entity, Mesh, MeshStandardMaterial, Vector3 } from '@iwsdk/core';
import { audio } from './audio.js';
import { holding, stowAll } from './equipment.js';
import { ClimbHold } from './game-components.js';
import { HANDS, hands, type Handedness } from './hand-input.js';
import { currentLevel, type ClimbWall } from './level.js';
import { getHeadWorld, placeHeadAt } from './rig.js';
import { sceneRefs } from './scene-system.js';
import { game, Phase } from './state.js';
import { clamp } from './terrain.js';

/** Close a hand this close to a hold to take it (or reach in with it already closed). */
const GRAB_RADIUS = 0.24;
const CATCH_RADIUS = 0.16;
const HIGHLIGHT_RADIUS = 0.5;
/** Pulling down lifts you a little more than your hand moves: less arm work. */
const PULL_GAIN = 1.2;
/** Let go of everything and you hang on for this long before sliding... */
const HANG_GRACE = 0.9;
/** ...and then slide down no faster than this (m/s). */
const MAX_SLIDE = 1.3;
/** Distance from the hand to the pick of a held ice axe. */
const AXE_REACH = 0.42;
/** Minimum swing speed toward the ice for a pick to bite (m/s). */
const AXE_BITE_SPEED = 0.7;

interface Grab {
  /** The hold grabbed, or null for an axe placement. */
  hold: Entity | null;
  active: boolean;
  readonly anchor: Vector3;
}

type Tween = {
  t: number;
  duration: number;
  from: Vector3;
  to: Vector3;
  lift: number;
  done: () => void;
};

/** Hooks other systems can listen to (ice chips, hints). */
export const climbEvents = {
  onAxeBite: null as ((at: Vector3) => void) | null,
  onNeedTool: null as ((tool: 'axes' | 'free-hands') => void) | null,
};

export class ClimbSystem extends createSystem({
  holds: { required: [ClimbHold] },
}) {
  private grabs!: Record<Handedness, Grab>;
  private active: Handedness | null = null;
  private wall: ClimbWall | null = null;
  private readonly tangent = new Vector3();
  private airTime = 0;
  private fallSpeed = 0;
  private tween: Tween | null = null;
  private readonly head = new Vector3();
  private readonly delta = new Vector3();
  private readonly holdPos = new Vector3();
  private readonly rel = new Vector3();
  private readonly pick = new Vector3();
  private readonly prevHand: Record<Handedness, Vector3> = {
    left: new Vector3(),
    right: new Vector3(),
  };
  private readonly handVel: Record<Handedness, Vector3> = {
    left: new Vector3(),
    right: new Vector3(),
  };
  private needToolTimer = 0;

  init(): void {
    this.grabs = {
      left: { hold: null, active: false, anchor: new Vector3() },
      right: { hold: null, active: false, anchor: new Vector3() },
    };
    this.cleanupFuncs.push(
      game.phase.subscribe((phase) => {
        this.releaseAll();
        this.tween = null;
        if (phase === Phase.Climbing) {
          this.wall = currentLevel().currentWall();
          if (this.wall) {
            this.tangent.set(0, 1, 0).cross(this.wall.normal).normalize();
            // The tutorial puts the poles away for you.
            if (currentLevel().id === 'tutorial') stowAll();
            this.startApproach();
          }
        }
      }),
    );
  }

  private pulse(side: Handedness, value: number, ms: number): void {
    const actuator = this.input.xr.gamepads[side]?.gamepad?.hapticActuators?.[0] as
      | { pulse?: (value: number, duration: number) => void }
      | undefined;
    actuator?.pulse?.(value, ms);
  }

  private releaseAll(): void {
    for (const grab of [this.grabs.left, this.grabs.right]) {
      grab.hold = null;
      grab.active = false;
    }
    this.active = null;
    this.airTime = 0;
    this.fallSpeed = 0;
    this.needToolTimer = 0;
  }

  /** Distance out from the face (`out`) and offset along the lane (`along`). */
  private wallOut(p: Vector3): number {
    return this.rel.subVectors(p, this.wall!.base).dot(this.wall!.normal);
  }

  private wallAlong(p: Vector3): number {
    return this.rel.subVectors(p, this.wall!.base).dot(this.tangent);
  }

  /** Glide the player up to the foot of the wall, centred on the lane. */
  private startApproach(): void {
    const wall = this.wall!;
    const rig = this.player;
    getHeadWorld(this.world, this.head);
    const from = rig.position.clone();
    const to = from.clone();
    const reach = wall.standoff + 0.4;
    to.x += wall.base.x + wall.normal.x * reach - this.head.x;
    to.z += wall.base.z + wall.normal.z * reach - this.head.z;
    to.y = wall.baseY;
    this.tween = { t: 0, duration: 1.4, from, to, lift: 0, done: () => {} };
  }

  update(delta: number): void {
    const dt = Math.max(1e-3, Math.min(delta, 0.1));
    const phase = game.phase.peek();
    for (const hand of HANDS) {
      const side = hand.handedness;
      const v = this.handVel[side];
      this.delta.subVectors(hand.position, this.prevHand[side]).divideScalar(dt);
      v.lerp(this.delta, 0.5);
      this.prevHand[side].copy(hand.position);
    }
    if (phase !== Phase.Climbing || !this.wall) {
      if (phase === Phase.Poling) this.updateHoldGlow(dt, false);
      return;
    }
    this.updateHoldGlow(dt, this.wall.mode === 'holds');

    if (this.tween) {
      this.runTween(dt);
      return;
    }

    const rig = this.player;
    if (this.world.renderer.xr.isPresenting) {
      this.updateGrabs(dt);
    } else {
      const keyboard = this.input.keyboard;
      if (keyboard.getKeyPressed('KeyW') || keyboard.getKeyPressed('ArrowUp')) {
        rig.position.y += 1.1 * dt;
        this.airTime = 0;
        this.fallSpeed = 0;
        if (Math.random() < dt * 2.5) {
          if (this.wall.mode === 'axes') audio.axeBite();
          else audio.clack();
        }
      } else {
        this.airTime += dt;
      }
    }

    // Hanging on nothing: after a short grace period, slide down gently.
    const ground = this.wall.baseY;
    if (!this.active && this.airTime > HANG_GRACE && rig.position.y > ground) {
      this.fallSpeed = Math.min(MAX_SLIDE, this.fallSpeed + dt * 2.5);
      rig.position.y = Math.max(ground, rig.position.y - this.fallSpeed * dt);
    }
    if (rig.position.y <= ground) this.fallSpeed = 0;

    this.keepOffWall();

    // Hauled over the lip?
    const top = this.wall.topY;
    const lipGrabbed = this.isLipHeld();
    if (rig.position.y >= top - 1.0 || (lipGrabbed && rig.position.y >= top - 1.45)) {
      this.startMantle();
    }
  }

  private updateGrabs(dt: number): void {
    const wall = this.wall!;
    for (const hand of HANDS) {
      const side = hand.handedness;
      const grab = this.grabs[side];
      if (!hand.grip || !hand.tracked) {
        if (grab.active) {
          grab.active = false;
          grab.hold = null;
          if (this.active === side) {
            const other: Handedness = side === 'left' ? 'right' : 'left';
            this.active = this.grabs[other].active ? other : null;
            // Re-anchor the remaining hand so there is no jump.
            if (this.active) this.grabs[other].anchor.copy(hands[other].position);
          }
        }
        continue;
      }
      if (grab.active) continue;

      if (wall.mode === 'holds') {
        // Close the hand on a hold, or reach onto one with it already closed.
        const hold = hand.gripDown
          ? this.nearestHold(hand.position, GRAB_RADIUS)
          : this.nearestHold(hand.position, CATCH_RADIUS);
        if (!hold) continue;
        grab.hold = hold;
        grab.active = true;
        grab.anchor.copy(hand.position);
        this.active = side;
        hold.setValue(ClimbHold, 'glow', 1);
        audio.clack();
        this.pulse(side, 0.45, 35);
        const mesh = hold.object3D as Mesh;
        sceneRefs.puffs?.emit(mesh.getWorldPosition(this.holdPos), 3, 0.4);
        continue;
      }

      // Ice axes: the pick sits above the thumb (grip -Z).
      if (!holding(side, 'axes')) {
        this.needToolTimer += dt;
        if (this.needToolTimer > 4) {
          climbEvents.onNeedTool?.('axes');
          this.needToolTimer = -20;
        }
        continue;
      }
      this.pick.set(0, 0, -AXE_REACH).applyQuaternion(hand.quaternion).add(hand.position);
      const out = this.wallOut(this.pick);
      const along = this.wallAlong(this.pick);
      const towardWall = -this.handVel[side].dot(wall.normal);
      const onFace = Math.abs(along) < wall.laneWidth / 2 + 0.5 && this.pick.y < wall.topY + 0.3;
      if (onFace && out < 0.12 && out > -0.35 && towardWall > AXE_BITE_SPEED) {
        grab.hold = null;
        grab.active = true;
        grab.anchor.copy(hand.position);
        this.active = side;
        audio.axeBite();
        this.pulse(side, 0.7, 50);
        climbEvents.onAxeBite?.(this.pick);
        sceneRefs.puffs?.emit(this.pick, 5, 0.5);
      }
    }

    if (this.active) {
      const grab = this.grabs[this.active];
      this.delta.subVectors(grab.anchor, hands[this.active].position);
      // Hauling yourself up goes a little further than the pull itself. The
      // hand rides up with the body by that extra too, so move the anchor
      // with it (otherwise the next frame would pull you back down).
      if (this.delta.y > 0) {
        const extra = this.delta.y * (PULL_GAIN - 1);
        this.delta.y += extra;
        grab.anchor.y += extra;
      }
      this.player.position.add(this.delta);
      this.player.updateMatrixWorld(true);
      this.airTime = 0;
      this.fallSpeed = 0;
    } else {
      this.airTime += dt;
    }
  }

  private nearestHold(point: Vector3, radius: number): Entity | null {
    let best: Entity | null = null;
    let bestDist = radius;
    for (const entity of this.queries.holds.entities) {
      const object = entity.object3D;
      if (!object || !this.onWall(object.position)) continue;
      const d = object.position.distanceTo(point);
      if (d < bestDist) {
        bestDist = d;
        best = entity;
      }
    }
    return best;
  }

  /** Holds belong to the current wall when they sit on its lane. */
  private onWall(p: Vector3): boolean {
    const wall = this.wall;
    if (!wall) return false;
    return (
      Math.abs(this.wallOut(p)) < 1.2 &&
      Math.abs(this.wallAlong(p)) < wall.laneWidth / 2 + 1.5 &&
      p.y > wall.baseY - 1 &&
      p.y < wall.topY + 1
    );
  }

  private isLipHeld(): boolean {
    for (const grab of [this.grabs.left, this.grabs.right]) {
      if (grab.active && grab.hold && grab.hold.getValue(ClimbHold, 'lip')) return true;
    }
    return false;
  }

  private keepOffWall(): void {
    const wall = this.wall!;
    const rig = this.player;
    rig.updateMatrixWorld(true);
    getHeadWorld(this.world, this.head);
    const out = this.wallOut(this.head);
    if (out < wall.standoff) {
      rig.position.addScaledVector(wall.normal, wall.standoff - out);
    }
    const along = this.wallAlong(this.head);
    const half = wall.laneWidth / 2;
    const clamped = clamp(along, -half, half);
    if (clamped !== along) rig.position.addScaledVector(this.tangent, clamped - along);
    if (rig.position.y < wall.baseY) rig.position.y = wall.baseY;
  }

  private startMantle(): void {
    const wall = this.wall!;
    this.releaseAll();
    const rig = this.player;
    getHeadWorld(this.world, this.head);
    const from = rig.position.clone();
    const to = from.clone();
    to.x += wall.topStand.x - this.head.x;
    to.z += wall.topStand.z - this.head.z;
    to.y = wall.topStand.y;
    audio.whoosh();
    this.tween = {
      t: 0,
      duration: 1.1,
      from,
      to,
      lift: 0.35,
      done: () => {
        placeHeadAt(this.world, wall.topStand.x, wall.topStand.z, wall.topStand.y);
        wall.onTop();
      },
    };
  }

  private runTween(dt: number): void {
    const tween = this.tween!;
    tween.t = Math.min(1, tween.t + dt / tween.duration);
    const e = tween.t * tween.t * (3 - 2 * tween.t);
    const rig = this.player;
    rig.position.lerpVectors(tween.from, tween.to, e);
    rig.position.y += Math.sin(Math.PI * e) * tween.lift;
    rig.updateMatrixWorld(true);
    if (tween.t >= 1) {
      this.tween = null;
      tween.done();
    }
  }

  private updateHoldGlow(dt: number, climbing: boolean): void {
    const time = performance.now() / 1000;
    for (const entity of this.queries.holds.entities) {
      const mesh = entity.object3D as Mesh | undefined;
      if (!mesh || !mesh.visible) continue;
      let glow = entity.getValue(ClimbHold, 'glow') ?? 0;
      if (glow > 0) {
        glow = Math.max(0, glow - dt * 1.5);
        entity.setValue(ClimbHold, 'glow', glow);
      }
      let near = 0;
      if (climbing) {
        for (const hand of HANDS) {
          if (!hand.tracked) continue;
          const d = mesh.position.distanceTo(hand.position);
          if (d < HIGHLIGHT_RADIUS) near = Math.max(near, 1 - d / HIGHLIGHT_RADIUS);
        }
      }
      const held =
        this.grabs.left.hold === entity || this.grabs.right.hold === entity ? 1 : 0;
      const pulse = climbing ? 0.22 + 0.12 * Math.sin(time * 3 + mesh.position.y * 2) : 0.12;
      const material = mesh.material as MeshStandardMaterial;
      material.emissiveIntensity = pulse + near * 1.1 + glow * 0.8 + held * 0.5;
    }
  }
}
