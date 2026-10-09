/**
 * Assembly on the beacon deck: put together a half-size hang glider kit.
 *
 * The parts you recovered in the cave are in your pack. Open it, take a part
 * out (it comes up in your hand), carry it to its glowing outline on the
 * frame and open your hand to fit it. Let go of it anywhere else and it goes
 * back in your pack. When every part is fitted the kit "becomes" a
 * full-size glider for the launch.
 *
 * Desktop fallback: press E to fit the next part from your pack.
 */

import {
  Color,
  createSystem,
  Entity,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Vector3,
} from '@iwsdk/core';
import { audio } from './audio.js';
import { consume, equipment, type ItemId, PART_ITEM, PART_ITEMS, removeFromPack, stow } from './equipment.js';
import { GliderPart, GliderPartIds } from './game-components.js';
import { buildGhost, buildGlider, type GliderPartId } from './glider-model.js';
import { HANDS, type Handedness } from './hand-input.js';
import { sceneRefs } from './scene-system.js';
import { WORKBENCH_POS } from './cave-bluff.js';
import { bluffTopInUse } from './cave-bluff-system.js';
import { fadeThen, game, PART_COUNT, Phase, setPhase, toast } from './state.js';
import {
  BAR_CRATE_X,
  BAR_CRATE_Z,
  buildWorkbench,
  KIT_KEEL_HEIGHT,
  WING_CRATE_X,
  WING_CRATE_Z,
} from './world-builders.js';

const KIT_SCALE = 0.5;
/** Open your hand this close to a part's outline to fit it. */
const SNAP_RADIUS = 0.6;
const KEEL_Y = 2.3; // keel height in glider model space

interface PartInfo {
  entity: Entity;
  group: Group;
  ghost: Group;
  materials: MeshStandardMaterial[];
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
  private completeTimer = -1;
  private readonly tmp = new Vector3();
  private bench!: Object3D;
  /** The kit has "become" the full-size glider. */
  private built = false;

  init(): void {
    const base = WORKBENCH_POS.clone();
    this.bench = buildWorkbench(base);
    this.world.createTransformEntity(this.bench, { parent: sceneRefs.tutorialRoot ?? undefined, persistent: true });

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
        this.applyVisibility(phase);
      }),
    );
    this.applyVisibility(game.phase.peek());
  }

  /**
   * The bench and kit sit on the deck on top of the bluff, which only
   * appears once you come up out of the cave with the parts; a part shows on
   * the frame once it is fitted.
   */
  private applyVisibility(phase: Phase): void {
    const top = bluffTopInUse(phase);
    this.bench.visible = top;
    this.kitRoot.visible = top && !this.built;
    for (const part of this.parts.values()) part.group.visible = top && !this.built && this.isPlaced(part);
  }

  private reset(): void {
    this.built = false;
    this.carrying.left = null;
    this.carrying.right = null;
    this.completeTimer = -1;
    for (const part of this.parts.values()) {
      part.entity.setValue(GliderPart, 'placed', false);
      part.group.position.copy(part.restPos);
      part.group.quaternion.copy(part.restQuat);
      part.group.scale.setScalar(KIT_SCALE);
      part.ghost.visible = true;
      part.anim = null;
    }
    game.partsPlaced.value = 0;
    this.applyVisibility(game.phase.peek());
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
          this.built = true;
          this.applyVisibility(game.phase.peek());
          setPhase(Phase.Launch);
        });
      }
    }
  }

  private isPlaced(part: PartInfo): boolean {
    return !!part.entity.getValue(GliderPart, 'placed');
  }

  private isCarried(part: PartInfo): boolean {
    return this.carrying.left === part || this.carrying.right === part;
  }

  /** A part out of the pack in a hand: open the hand by its outline to fit it. */
  private updateHands(): void {
    for (const hand of HANDS) {
      const side = hand.handedness;
      const item = equipment.inHand[side];
      const part = item ? this.partForItem(item) : null;
      this.carrying[side] = part && !this.isPlaced(part) ? part : null;
      const carried = this.carrying[side];
      if (!carried || !hand.tracked || hand.grip) continue;
      if (hand.position.distanceTo(carried.slotPos) < SNAP_RADIUS) {
        consume(side);
        this.carrying[side] = null;
        // It leaves your hand where it is and settles onto the frame.
        carried.group.position.copy(hand.position);
        carried.group.quaternion.copy(carried.slotQuat);
        this.fit(carried);
      } else {
        stow(side);
        this.carrying[side] = null;
        audio.zip();
        toast('Back in your pack. Carry it to its outline on the frame.', 3);
      }
    }
  }

  private partForItem(item: ItemId): PartInfo | null {
    if (!PART_ITEMS.has(item)) return null;
    for (const [id, part] of this.parts) if (PART_ITEM[id] === item) return part;
    return null;
  }

  /** The outlines pulse; the one for a part in your hand brightest. */
  private updateFeedback(part: PartInfo, dt: number, time: number): void {
    const target = this.isCarried(part) ? 0.25 : 0;
    part.glow += (target - part.glow) * (1 - Math.exp(-12 * dt));
    for (const material of part.materials) material.emissiveIntensity = part.glow;
    if (part.ghost.visible) {
      const mat = (part.ghost.children[0] as Mesh | undefined)?.material as
        | MeshBasicMaterial
        | undefined;
      if (mat) mat.opacity = (this.isCarried(part) ? 0.5 : 0.22) + (this.isCarried(part) ? 0.2 : 0.1) * Math.sin(time * 4.2);
    }
  }

  private fit(part: PartInfo): void {
    part.entity.setValue(GliderPart, 'placed', true);
    part.ghost.visible = false;
    part.group.scale.setScalar(KIT_SCALE);
    part.group.visible = true;
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

  /** Desktop: the next part out of the pack (or a hand) and onto the frame. */
  private placeNext(): void {
    for (const [id, part] of this.parts) {
      if (this.isPlaced(part)) continue;
      const item = PART_ITEM[id];
      if (removeFromPack(item)) {
        // From the bench in front of you up onto the frame.
        part.group.position.copy(part.restPos);
        part.group.quaternion.copy(part.restQuat);
      } else {
        const side = equipment.inHand.right === item ? 'right' : equipment.inHand.left === item ? 'left' : null;
        if (!side) continue;
        consume(side);
        part.group.position.copy(part.restPos);
        part.group.quaternion.copy(part.restQuat);
      }
      this.fit(part);
      return;
    }
    toast('No glider parts left in your pack.', 2.5);
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
