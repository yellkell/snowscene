/**
 * Summit assembly: put together a half-size hang glider kit.
 *
 * Close a hand anywhere on a loose part to pick it up (parts glow when your
 * hand is close enough), carry it to its glowing outline on the frame and
 * open your hand to fit it. Parts dropped away from their outline float back
 * to where they were resting. When every part is fitted the kit "becomes" a
 * full-size glider for the launch.
 *
 * Desktop fallback: press E to fit the next part.
 */

import {
  Box3,
  Color,
  createSystem,
  Entity,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from '@iwsdk/core';
import { audio } from './audio.js';
import { GliderPart, GliderPartIds } from './game-components.js';
import { buildGhost, buildGlider, type GliderPartId } from './glider-model.js';
import { HANDS, type Handedness } from './hand-input.js';
import { sceneRefs } from './scene-system.js';
import { fadeThen, game, PART_COUNT, Phase, setPhase, WORKBENCH_POS } from './state.js';
import { SUMMIT_Y } from './terrain.js';
import {
  BAR_CRATE_X,
  BAR_CRATE_Z,
  buildWorkbench,
  KIT_KEEL_HEIGHT,
  WING_CRATE_X,
  WING_CRATE_Z,
} from './world-builders.js';

const KIT_SCALE = 0.5;
/** Grab when the hand is within this distance of a part's bounding box. */
const GRAB_MARGIN = 0.1;
/** Parts glow when a hand is within this distance of them. */
const HOVER_MARGIN = 0.22;
/** Fit when the part's centre is this close to its outline. */
const SNAP_RADIUS = 0.45;
const KEEL_Y = 2.3; // keel height in glider model space

interface PartInfo {
  entity: Entity;
  group: Group;
  ghost: Group;
  materials: MeshStandardMaterial[];
  bounds: Box3;
  restPos: Vector3;
  restQuat: Quaternion;
  slotPos: Vector3;
  slotQuat: Quaternion;
  glow: number;
  /** Active animation toward a target pose. */
  anim: { t: number; fromPos: Vector3; fromQuat: Quaternion; toPos: Vector3; toQuat: Quaternion } | null;
}

const HOVER_COLOR = new Color(1, 0.86, 0.55);

export class GliderBuildSystem extends createSystem({
  parts: { required: [GliderPart] },
}) {
  private kitRoot!: Group;
  private parts = new Map<GliderPartId, PartInfo>();
  private carrying: Record<Handedness, PartInfo | null> = { left: null, right: null };
  private readonly offsets: Record<Handedness, Vector3> = {
    left: new Vector3(),
    right: new Vector3(),
  };
  private completeTimer = -1;
  private readonly tmp = new Vector3();

  init(): void {
    const base = new Vector3(WORKBENCH_POS.x, SUMMIT_Y, WORKBENCH_POS.z);
    this.world.createTransformEntity(buildWorkbench(base), { parent: sceneRefs.tutorialRoot ?? undefined, persistent: true });

    const kit = buildGlider();
    this.kitRoot = kit.root;
    this.kitRoot.name = 'GliderKit';
    this.kitRoot.scale.setScalar(KIT_SCALE);
    // Keel rests on the stand, nose pointing back toward the player.
    this.kitRoot.position.set(base.x, base.y + KIT_KEEL_HEIGHT - KEEL_Y * KIT_SCALE + 0.03, base.z);
    this.kitRoot.rotation.y = Math.PI;
    this.kitRoot.traverse((child) => {
      child.castShadow = true;
    });
    this.world.createTransformEntity(this.kitRoot, { parent: sceneRefs.tutorialRoot ?? undefined, persistent: true });
    this.kitRoot.updateMatrixWorld(true);
    const kitQuat = this.kitRoot.getWorldQuaternion(new Quaternion());
    const yawed = (angle: number) =>
      kitQuat.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), angle));

    // The kit is turned 180 degrees, so its left wing slots on the player's right.
    const rest: Record<GliderPartId, { pos: Vector3; quat: Quaternion }> = {
      LeftWing: {
        pos: new Vector3(base.x + WING_CRATE_X + 0.15, base.y + 0.8, base.z + WING_CRATE_Z),
        quat: yawed(0.35),
      },
      RightWing: {
        pos: new Vector3(base.x - WING_CRATE_X - 0.15, base.y + 0.8, base.z + WING_CRATE_Z),
        quat: yawed(-0.35),
      },
      ControlBar: {
        pos: new Vector3(base.x + BAR_CRATE_X, base.y + 0.62, base.z + BAR_CRATE_Z),
        quat: kitQuat.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -1.2)),
      },
    };

    for (const id of Object.values(GliderPartIds)) {
      const group = kit.parts[id];
      // Ghost stays on the kit frame as the "fit me here" hint.
      const ghost = buildGhost(group);
      ghost.position.copy(kit.slots[id]);
      this.kitRoot.add(ghost);
      const slotPos = this.kitRoot.localToWorld(kit.slots[id].clone());

      // Loose parts get their own materials so they can glow individually.
      const materials: MeshStandardMaterial[] = [];
      group.traverse((child) => {
        const mesh = child as Mesh;
        if (!mesh.isMesh) return;
        const material = (mesh.material as MeshStandardMaterial).clone();
        material.emissive.copy(HOVER_COLOR);
        material.emissiveIntensity = 0;
        mesh.material = material;
        materials.push(material);
      });

      // Loose parts live in world space as their own entities.
      this.kitRoot.remove(group);
      group.scale.setScalar(KIT_SCALE);
      group.position.copy(rest[id].pos);
      group.quaternion.copy(rest[id].quat);
      const entity = this.world.createTransformEntity(group, { parent: sceneRefs.tutorialRoot ?? undefined, persistent: true });
      entity.addComponent(GliderPart, { partId: id, placed: false });
      this.parts.set(id, {
        entity,
        group,
        ghost,
        materials,
        bounds: new Box3(),
        restPos: rest[id].pos.clone(),
        restQuat: rest[id].quat.clone(),
        slotPos,
        slotQuat: kitQuat.clone(),
        glow: 0,
        anim: null,
      });
    }

    this.cleanupFuncs.push(
      game.resetCount.subscribe(() => this.reset()),
      game.phase.subscribe((phase) => {
        if (phase === Phase.Building) this.completeTimer = -1;
      }),
    );
  }

  private reset(): void {
    this.kitRoot.visible = true;
    this.carrying.left = null;
    this.carrying.right = null;
    this.completeTimer = -1;
    for (const part of this.parts.values()) {
      part.entity.setValue(GliderPart, 'placed', false);
      part.group.visible = true;
      part.group.position.copy(part.restPos);
      part.group.quaternion.copy(part.restQuat);
      part.ghost.visible = true;
      part.anim = null;
    }
    game.partsPlaced.value = 0;
  }

  update(delta: number, time: number): void {
    const dt = Math.min(delta, 0.1);
    for (const part of this.parts.values()) this.animate(part, dt);
    if (game.phase.peek() !== Phase.Building) return;

    if (this.world.renderer.xr.isPresenting) this.updateHands();
    else if (this.input.keyboard.getKeyDown('KeyE')) this.placeNext();

    for (const part of this.parts.values()) this.updateFeedback(part, dt, time);

    if (this.completeTimer >= 0) {
      this.completeTimer += dt;
      if (this.completeTimer > 1.2) {
        this.completeTimer = -1;
        // The kit "grows" into the real glider behind a short white-out.
        fadeThen(() => {
          this.kitRoot.visible = false;
          for (const part of this.parts.values()) part.group.visible = false;
          setPhase(Phase.Launch);
        });
      }
    }
  }

  private isCarried(part: PartInfo): boolean {
    return this.carrying.left === part || this.carrying.right === part;
  }

  private isFree(part: PartInfo): boolean {
    return !part.entity.getValue(GliderPart, 'placed') && !this.isCarried(part);
  }

  /** Distance from a point to the part's current world bounding box. */
  private distanceToPart(part: PartInfo, point: Vector3): number {
    part.bounds.setFromObject(part.group);
    return part.bounds.distanceToPoint(point);
  }

  private updateHands(): void {
    for (const hand of HANDS) {
      const side = hand.handedness;
      const carried = this.carrying[side];
      if (carried) {
        if (!hand.grip || !hand.tracked) {
          this.carrying[side] = null;
          this.drop(carried);
          continue;
        }
        carried.group.position.copy(hand.position).add(this.offsets[side]);
        // Ease the part into its slot orientation as it nears the frame.
        const d = carried.group.position.distanceTo(carried.slotPos);
        const t = 1 - Math.min(1, Math.max(0, (d - 0.15) / 0.8));
        carried.group.quaternion.slerpQuaternions(carried.restQuat, carried.slotQuat, t);
        continue;
      }
      if (!hand.gripDown) continue;
      let best: PartInfo | null = null;
      let bestDist = GRAB_MARGIN;
      for (const part of this.parts.values()) {
        if (!this.isFree(part)) continue;
        const dist = this.distanceToPart(part, hand.position);
        if (dist <= bestDist) {
          bestDist = dist;
          best = part;
        }
      }
      if (best) {
        best.anim = null;
        this.carrying[side] = best;
        this.offsets[side].subVectors(best.group.position, hand.position);
        audio.clack();
      }
    }
  }

  /** Glow parts within reach, and pulse the outline of a carried part. */
  private updateFeedback(part: PartInfo, dt: number, time: number): void {
    let target = 0;
    if (this.isCarried(part)) {
      target = 0.25;
    } else if (this.isFree(part) && this.world.renderer.xr.isPresenting) {
      for (const hand of HANDS) {
        if (!hand.tracked) continue;
        if (this.distanceToPart(part, hand.position) < HOVER_MARGIN) target = 0.45;
      }
    }
    part.glow += (target - part.glow) * (1 - Math.exp(-12 * dt));
    for (const material of part.materials) material.emissiveIntensity = part.glow;

    if (part.ghost.visible) {
      const mat = (part.ghost.children[0] as Mesh | undefined)?.material as
        | MeshBasicMaterial
        | undefined;
      if (mat) mat.opacity = (this.isCarried(part) ? 0.45 : 0.22) + 0.1 * Math.sin(time * 4);
    }
  }

  private drop(part: PartInfo): void {
    if (part.group.position.distanceTo(part.slotPos) < SNAP_RADIUS) {
      this.fit(part);
    } else {
      this.startAnim(part, part.restPos, part.restQuat);
    }
  }

  private fit(part: PartInfo): void {
    part.entity.setValue(GliderPart, 'placed', true);
    part.ghost.visible = false;
    this.startAnim(part, part.slotPos, part.slotQuat);
    audio.chime();
    sceneRefs.puffs?.emit(this.tmp.copy(part.slotPos), 6, 0.35);
    const placed = game.partsPlaced.peek() + 1;
    game.partsPlaced.value = placed;
    if (placed >= PART_COUNT) {
      this.completeTimer = 0;
      audio.fanfare();
    }
  }

  private placeNext(): void {
    for (const part of this.parts.values()) {
      if (!part.entity.getValue(GliderPart, 'placed')) {
        this.fit(part);
        return;
      }
    }
  }

  private startAnim(part: PartInfo, toPos: Vector3, toQuat: Quaternion): void {
    part.anim = {
      t: 0,
      fromPos: part.group.position.clone(),
      fromQuat: part.group.quaternion.clone(),
      toPos,
      toQuat,
    };
  }

  private animate(part: PartInfo, dt: number): void {
    const anim = part.anim;
    if (!anim) return;
    anim.t = Math.min(1, anim.t + dt * 2.5);
    const e = 1 - Math.pow(1 - anim.t, 3);
    part.group.position.lerpVectors(anim.fromPos, anim.toPos, e);
    part.group.position.y += Math.sin(Math.PI * anim.t) * 0.12;
    part.group.quaternion.slerpQuaternions(anim.fromQuat, anim.toQuat, e);
    if (anim.t >= 1) part.anim = null;
  }
}
