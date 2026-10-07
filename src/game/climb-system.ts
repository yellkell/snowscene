/**
 * Cliff climbing.
 *
 * Reach a glowing hold, close your hand to grab it, then pull: the world is
 * locked to the grabbing hand, so pulling down lifts your body. The most
 * recent grab drives movement, so you can go hand over hand. Let go of
 * everything and you slide gently back to the ground. Once your head is
 * over the summit lip you are hauled up onto the top.
 *
 * Desktop fallback: hold W / ArrowUp to climb.
 */

import { createSystem, Entity, Mesh, MeshStandardMaterial, Vector3 } from '@iwsdk/core';
import { audio } from './audio.js';
import { ClimbHold } from './game-components.js';
import { HANDS, type Handedness } from './hand-input.js';
import { getHeadWorld, placeHeadAt } from './rig.js';
import { sceneRefs } from './scene-system.js';
import { game, Phase, setPhase, SUMMIT_STAND } from './state.js';
import { CLIFF_BASE_Y, CLIFF_CENTER_X, clamp, SUMMIT_Y, terrainHeight, WALL_Z } from './terrain.js';

const GRAB_RADIUS = 0.17;
const HIGHLIGHT_RADIUS = 0.35;
/** Head stays at least this far in front of the wall face. */
const WALL_STANDOFF = 0.45;
/** Where the approach glide parks the player's head. */
const CLIMB_START_Z = WALL_Z + 0.85;

interface Grab {
  hold: Entity | null;
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

export class ClimbSystem extends createSystem({
  holds: { required: [ClimbHold] },
}) {
  private grabs!: Record<Handedness, Grab>;
  private active: Handedness | null = null;
  private airTime = 0;
  private fallSpeed = 0;
  private tween: Tween | null = null;
  private readonly head = new Vector3();
  private readonly delta = new Vector3();
  private readonly holdPos = new Vector3();

  init(): void {
    this.grabs = {
      left: { hold: null, anchor: new Vector3() },
      right: { hold: null, anchor: new Vector3() },
    };
    this.cleanupFuncs.push(
      game.phase.subscribe((phase) => {
        this.releaseAll();
        this.tween = null;
        if (phase === Phase.Climbing) this.startApproach();
      }),
    );
  }

  private releaseAll(): void {
    this.grabs.left.hold = null;
    this.grabs.right.hold = null;
    this.active = null;
    this.airTime = 0;
    this.fallSpeed = 0;
  }

  /** Glide the player up to the foot of the wall, centred on the holds. */
  private startApproach(): void {
    const rig = this.player;
    getHeadWorld(this.world, this.head);
    const from = rig.position.clone();
    const to = from.clone();
    to.x += CLIFF_CENTER_X - this.head.x;
    to.z += CLIMB_START_Z - this.head.z;
    to.y = CLIFF_BASE_Y;
    this.tween = { t: 0, duration: 1.4, from, to, lift: 0, done: () => {} };
  }

  update(delta: number): void {
    const dt = Math.min(delta, 0.1);
    const phase = game.phase.peek();
    if (phase !== Phase.Climbing) {
      if (phase === Phase.Poling) this.updateHoldGlow(dt, false);
      return;
    }
    this.updateHoldGlow(dt, true);

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
        if (Math.random() < dt * 2.5) audio.clack();
      } else {
        this.airTime += dt;
      }
    }

    // Hanging on nothing: after a short grace period, slide down gently.
    const ground = CLIFF_BASE_Y;
    if (!this.active && this.airTime > 0.45 && rig.position.y > ground) {
      this.fallSpeed = Math.min(2.2, this.fallSpeed + dt * 4);
      rig.position.y = Math.max(ground, rig.position.y - this.fallSpeed * dt);
    }
    if (rig.position.y <= ground) this.fallSpeed = 0;

    this.keepOffWall();

    // Hauled over the lip?
    const lipGrabbed = this.isLipHeld();
    if (rig.position.y >= SUMMIT_Y - 1.0 || (lipGrabbed && rig.position.y >= SUMMIT_Y - 1.45)) {
      this.startMantle();
    }
  }

  private updateGrabs(dt: number): void {
    for (const hand of HANDS) {
      const grab = this.grabs[hand.handedness];
      if (!hand.grip || !hand.tracked) {
        if (grab.hold) {
          grab.hold = null;
          if (this.active === hand.handedness) {
            const other: Handedness = hand.handedness === 'left' ? 'right' : 'left';
            this.active = this.grabs[other].hold ? other : null;
            // Re-anchor the remaining hand so there is no jump.
            if (this.active) this.grabs[other].anchor.copy(this.handPos(other));
          }
        }
        continue;
      }
      if (hand.gripDown && !grab.hold) {
        const hold = this.nearestHold(hand.position, GRAB_RADIUS);
        if (hold) {
          grab.hold = hold;
          grab.anchor.copy(hand.position);
          this.active = hand.handedness;
          hold.setValue(ClimbHold, 'glow', 1);
          audio.clack();
          const mesh = hold.object3D as Mesh;
          sceneRefs.puffs?.emit(mesh.getWorldPosition(this.holdPos), 3, 0.4);
        }
      }
    }

    if (this.active) {
      const grab = this.grabs[this.active];
      this.delta.subVectors(grab.anchor, this.handPos(this.active));
      this.player.position.add(this.delta);
      this.player.updateMatrixWorld(true);
      this.airTime = 0;
      this.fallSpeed = 0;
    } else {
      this.airTime += dt;
    }
  }

  private handPos(side: Handedness): Vector3 {
    return HANDS[side === 'left' ? 0 : 1].position;
  }

  private nearestHold(point: Vector3, radius: number): Entity | null {
    let best: Entity | null = null;
    let bestDist = radius;
    for (const entity of this.queries.holds.entities) {
      const object = entity.object3D;
      if (!object) continue;
      const d = object.position.distanceTo(point);
      if (d < bestDist) {
        bestDist = d;
        best = entity;
      }
    }
    return best;
  }

  private isLipHeld(): boolean {
    for (const grab of [this.grabs.left, this.grabs.right]) {
      if (grab.hold && grab.hold.getValue(ClimbHold, 'lip')) return true;
    }
    return false;
  }

  private keepOffWall(): void {
    const rig = this.player;
    rig.updateMatrixWorld(true);
    getHeadWorld(this.world, this.head);
    const minZ = WALL_Z + WALL_STANDOFF;
    if (this.head.z < minZ) rig.position.z += minZ - this.head.z;
    const lateral = this.head.x - CLIFF_CENTER_X;
    const clamped = clamp(lateral, -2.4, 2.4);
    if (clamped !== lateral) rig.position.x += clamped - lateral;
    const floor = Math.max(CLIFF_BASE_Y, terrainHeight(this.head.x, Math.max(this.head.z, minZ)));
    if (rig.position.y < floor) rig.position.y = floor;
  }

  private startMantle(): void {
    this.releaseAll();
    const rig = this.player;
    getHeadWorld(this.world, this.head);
    const from = rig.position.clone();
    const to = from.clone();
    to.x += SUMMIT_STAND.x - this.head.x;
    to.z += SUMMIT_STAND.z - this.head.z;
    to.y = SUMMIT_Y;
    audio.whoosh();
    this.tween = {
      t: 0,
      duration: 1.1,
      from,
      to,
      lift: 0.35,
      done: () => {
        placeHeadAt(this.world, SUMMIT_STAND.x, SUMMIT_STAND.z, SUMMIT_Y);
        audio.fanfare();
        setPhase(Phase.Building);
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
      if (!mesh) continue;
      let glow = entity.getValue(ClimbHold, 'glow') ?? 0;
      glow = Math.max(0, glow - dt * 1.5);
      entity.setValue(ClimbHold, 'glow', glow);
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
      material.emissiveIntensity = pulse + near * 0.7 + glow * 0.6 + held * 0.5;
    }
  }
}
