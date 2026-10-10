/**
 * Summit assembly: put together a half-size hang glider kit.
 *
 * The parts you recovered in the cave are in your backpack: open it (left
 * palm up) and take one out with your right hand, and it comes out ready to
 * carry to the frame. Parts not in the pack wait on their crates.
 *
 * Close a hand anywhere on a loose part to pick it up (parts glow when your
 * hand is close enough). A part out of reach can be pulled in: reach toward
 * it so it glows, then close your hand. Carry it to its glowing outline on
 * the frame and open your hand to fit it; the part stays pinned to the spot
 * you grabbed it by while it turns to match the frame. Parts dropped away
 * from the kit float back to where they were resting. When every part is
 * fitted the kit "becomes" a full-size glider for the launch.
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
import { consume, equipment, GLIDER_PART_ITEMS, type ItemId, packCount, removeFromPack } from './equipment.js';
import { GliderPart, GliderPartIds } from './game-components.js';
import { buildGhost, buildGlider, type GliderPartId } from './glider-model.js';
import { HANDS, type Handedness } from './hand-input.js';
import { sceneRefs } from './scene-system.js';
import { fadeThen, game, PART_COUNT, Phase, setPhase, toast, WORKBENCH_POS } from './state.js';
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
const GRAB_MARGIN = 0.15;
/** Parts glow when a hand is within this distance of them. */
const HOVER_MARGIN = 0.25;
/** Reaching toward a part (head -> hand ray) within this angle pulls it in. */
const AIM_COS = Math.cos(0.33);
/** ... from no further away than this. */
const AIM_RANGE = 3.2;
/** Seconds for a pulled part to fly into the hand. */
const PULL_TIME = 0.3;
/** Fit when the part's centre is this close to its outline. */
const SNAP_RADIUS = 0.75;
/** A hand that drops out of tracking keeps its part this long. */
const LOST_GRACE = 0.5;
const KEEL_Y = 2.3; // keel height in glider model space

interface PartInfo {
  entity: Entity;
  /** Its backpack item, and whether it is still packed away. */
  item: ItemId;
  inPack: boolean;
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

/** How a hand holds its part. */
interface Hold {
  part: PartInfo | null;
  /** The grabbed point in the part's (rotated, scaled) frame, from its origin. */
  readonly local: Vector3;
  readonly fromQuat: Quaternion;
  /** Where a pulled part's grab point started, and the pull's progress 0..1. */
  readonly pullFrom: Vector3;
  pull: number;
  lost: number;
}

const newHold = (): Hold => ({
  part: null,
  local: new Vector3(),
  fromQuat: new Quaternion(),
  pullFrom: new Vector3(),
  pull: 1,
  lost: 0,
});

export class GliderBuildSystem extends createSystem({
  parts: { required: [GliderPart] },
}) {
  private kitRoot!: Group;
  private parts = new Map<GliderPartId, PartInfo>();
  private readonly holds: Record<Handedness, Hold> = { left: newHold(), right: newHold() };
  /** The part each hand is reaching toward (glows; closing the hand pulls it in). */
  private readonly aimed: Record<Handedness, PartInfo | null> = { left: null, right: null };
  private completeTimer = -1;
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly head = new Vector3();
  private readonly inv = new Quaternion();

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
        item: GLIDER_PART_ITEMS[id],
        inPack: false,
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
        if (phase === Phase.Building) {
          this.completeTimer = -1;
          this.syncPack();
        }
        // The parts only reach the bench once you bring them down from the cave.
        const away =
          phase === Phase.Poling ||
          phase === Phase.Climbing ||
          phase === Phase.Cave ||
          phase === Phase.Beacon ||
          phase === Phase.Sliding;
        for (const part of this.parts.values()) {
          if (!part.entity.getValue(GliderPart, 'placed')) part.group.visible = !away && !part.inPack;
        }
        if (phase === Phase.Building && [...this.parts.values()].some((p) => p.inPack)) {
          toast(
            this.world.renderer.xr.isPresenting
              ? 'Take the glider parts you collected out of your backpack and assemble them here.'
              : 'The glider parts you collected are in your backpack: press E to fit each one here.',
            7,
          );
        }
      }),
    );
  }

  /** Which parts are still in the backpack (or in a hand, fresh out of it). */
  private syncPack(): void {
    for (const part of this.parts.values()) {
      if (part.entity.getValue(GliderPart, 'placed')) continue;
      part.inPack =
        packCount(part.item) > 0 || equipment.inHand.left === part.item || equipment.inHand.right === part.item;
    }
  }

  private reset(): void {
    this.kitRoot.visible = true;
    this.holds.left.part = null;
    this.holds.right.part = null;
    this.aimed.left = null;
    this.aimed.right = null;
    this.completeTimer = -1;
    for (const part of this.parts.values()) {
      part.entity.setValue(GliderPart, 'placed', false);
      part.group.visible = true;
      part.group.position.copy(part.restPos);
      part.group.quaternion.copy(part.restQuat);
      part.ghost.visible = true;
      part.anim = null;
      part.inPack = false;
    }
    game.partsPlaced.value = 0;
  }

  update(delta: number, time: number): void {
    const dt = Math.min(delta, 0.1);
    for (const part of this.parts.values()) this.animate(part, dt);
    if (game.phase.peek() !== Phase.Building) return;

    if (this.world.renderer.xr.isPresenting) this.updateHands(dt);
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
    return this.holds.left.part === part || this.holds.right.part === part;
  }

  private isFree(part: PartInfo): boolean {
    return !part.inPack && !part.entity.getValue(GliderPart, 'placed') && !this.isCarried(part);
  }

  /** A part just taken out of the backpack into this hand becomes the real part, carried. */
  private unpackInto(side: Handedness, hand: Vector3): boolean {
    const item = equipment.inHand[side];
    if (!item) return false;
    for (const part of this.parts.values()) {
      if (part.item !== item || !part.inPack) continue;
      consume(side);
      part.inPack = false;
      part.anim = null;
      part.group.visible = true;
      part.group.quaternion.copy(part.restQuat);
      part.group.position.copy(hand);
      const hold = this.holds[side];
      hold.part = part;
      hold.lost = 0;
      hold.pull = 1;
      hold.fromQuat.copy(part.restQuat);
      hold.local.set(0, 0, 0);
      return true;
    }
    return false;
  }

  /** Distance from a point to the part's current world bounding box. */
  private distanceToPart(part: PartInfo, point: Vector3): number {
    part.bounds.setFromObject(part.group);
    return part.bounds.distanceToPoint(point);
  }

  private updateHands(dt: number): void {
    this.world.camera.getWorldPosition(this.head);
    for (const hand of HANDS) {
      const side = hand.handedness;
      const hold = this.holds[side];
      const carried = hold.part;
      if (carried) {
        if (!hand.grip) {
          hold.part = null;
          this.drop(carried);
          continue;
        }
        // A flicker in tracking shouldn't throw the part back to its crate.
        if (!hand.tracked) {
          hold.lost += dt;
          if (hold.lost > LOST_GRACE) {
            hold.part = null;
            this.drop(carried);
          }
          continue;
        }
        hold.lost = 0;
        this.carry(carried, hold, hand.position, dt);
        continue;
      }
      if (hand.tracked && hand.grip && this.unpackInto(side, hand.position)) {
        this.aimed[side] = null;
        continue;
      }
      this.aimed[side] = hand.tracked ? this.aimTarget(hand.position) : null;
      if (!hand.gripDown) continue;
      // Touching a part beats reaching toward one.
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
      const pulled = !best;
      best ??= this.aimed[side];
      if (!best) continue;
      best.anim = null;
      hold.part = best;
      hold.lost = 0;
      hold.fromQuat.copy(best.group.quaternion);
      // Hold it by the point you touched, or the near side of one you pulled in.
      const grabPoint = pulled ? best.bounds.clampPoint(hand.position, this.tmp) : this.tmp.copy(hand.position);
      hold.pullFrom.copy(grabPoint);
      hold.pull = pulled ? 0 : 1;
      this.inv.copy(best.group.quaternion).invert();
      hold.local.subVectors(grabPoint, best.group.position).applyQuaternion(this.inv);
      this.aimed[side] = null;
      audio.clack();
    }
  }

  /** The free part a hand is reaching toward, if any (head -> hand ray). */
  private aimTarget(hand: Vector3): PartInfo | null {
    const dir = this.tmp2.subVectors(hand, this.head);
    if (dir.lengthSq() < 0.09) return null; // arm not reaching out
    dir.normalize();
    let best: PartInfo | null = null;
    let bestCos = AIM_COS;
    for (const part of this.parts.values()) {
      if (!this.isFree(part)) continue;
      part.bounds.setFromObject(part.group);
      const centre = part.bounds.getCenter(this.tmp);
      const dist = centre.distanceTo(hand);
      if (dist > AIM_RANGE) continue;
      const cos = centre.sub(hand).normalize().dot(dir);
      if (cos > bestCos) {
        bestCos = cos;
        best = part;
      }
    }
    return best;
  }

  /** Keep the grabbed point on the hand while the part eases toward its slot pose. */
  private carry(part: PartInfo, hold: Hold, hand: Vector3, dt: number): void {
    const target = this.tmp;
    if (hold.pull < 1) {
      hold.pull = Math.min(1, hold.pull + dt / PULL_TIME);
      const e = 1 - Math.pow(1 - hold.pull, 3);
      target.lerpVectors(hold.pullFrom, hand, e);
    } else {
      target.copy(hand);
    }
    const d = part.group.position.distanceTo(part.slotPos);
    const t = 1 - Math.min(1, Math.max(0, (d - 0.15) / 0.9));
    part.group.quaternion.slerpQuaternions(hold.fromQuat, part.slotQuat, t);
    part.group.position.copy(hold.local).applyQuaternion(part.group.quaternion);
    part.group.position.subVectors(target, part.group.position);
  }

  /** Glow parts within reach, and pulse the outline of a carried part. */
  private updateFeedback(part: PartInfo, dt: number, time: number): void {
    let target = 0;
    if (this.isCarried(part)) {
      target = 0.25;
    } else if (this.isFree(part) && this.world.renderer.xr.isPresenting) {
      if (this.aimed.left === part || this.aimed.right === part) target = 0.3;
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
        if (part.inPack) {
          // Desktop: straight out of the pack (or the hand it was taken into).
          if (equipment.inHand.left === part.item) consume('left');
          else if (equipment.inHand.right === part.item) consume('right');
          else if (packCount(part.item) > 0) removeFromPack(part.item);
          part.inPack = false;
          part.group.visible = true;
        }
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
