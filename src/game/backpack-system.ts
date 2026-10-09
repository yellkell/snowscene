/**
 * The backpack, a wooden tackle-box tray after gamblefish's: turn either
 * palm up and look at it (or press A / X on a controller) and the tray comes
 * up in front of you at waist height, tipped toward you, lid open with your
 * notes on it and your gear lying in its felt-lined slots. Reach in with
 * either hand and close it on an item to take it; let go of a held item over
 * the tray to put it back in its slot. The tray travels with you while it is
 * open. Palm up again, A / X, or look well away from it and it folds away.
 * (The palm-up pose must be held briefly to open, so a hand passing palm-up
 * mid-stride doesn't flash it open; from the FIRE FIGHT FLUX wrist panel.)
 *
 * Items in hand also work here:
 *   thermos   bring it to your mouth to sip (warms you)
 *   warmer    squeeze it for a second to crack it (warms you)
 *   headlamp  touch it to your forehead to put it on
 *   map       hold it up to read it
 *   flare     raise it above your head and squeeze to fire it
 *   glider    drop it on the summit to unpack it
 *
 * RECENTRE: a big brass push button on a bracket off the tray's near-left
 * corner. Touch its cap with any fingertip (or your palm) to re-centre: back to the middle of the deck
 * you're on in the cave, your lean on the chute, facing up the trail, back
 * at the workbench, or facing the fire once you've landed.
 *
 * Desktop: B toggles the pack, 1-9 take items, U uses, Q stows, R recentres.
 */

import {
  Box3,
  CanvasTexture,
  BoxGeometry,
  CircleGeometry,
  createSystem,
  CylinderGeometry,
  Group,
  InputComponent,
  Matrix4,
  MeshStandardMaterial,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  PointLight,
  Quaternion,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  TorusGeometry,
  Vector3,
} from '@iwsdk/core';
import { audio } from './audio.js';
import {
  consume,
  equipment,
  ITEM_LABELS,
  ItemIds,
  type ItemId,
  packCount,
  PAIRED,
  PART_ITEMS,
  stow,
  take,
} from './equipment.js';
import { headlamp } from './expedition/sky/headlamp.js';
import { HANDS, hands, type Handedness } from './hand-input.js';
import { buildHeldItem, buildSlotIcon } from './items.js';
import { buildPackTray, CELL, cellCentre, COLS, type PackTray, ROWS, TRAY_H, TRAY_TILT, TRAY_W } from './pack-tray.js';
import { currentLevel } from './level.js';
import { sceneRefs } from './scene-system.js';
import { FIRE_POS } from './campfire.js';
import { faceYaw, getHeadWorld, getHeadYaw, placeHeadAt } from './rig.js';
import { BUILD_STAND } from './cave-bluff.js';
import { addWarmth, game, Phase, requestRecentre, toast } from './state.js';

/** Gesture thresholds (from FLUX): palm-normal·up and gaze cone, open/stay. */
const OPEN_UP = 0.65;
const STAY_UP = 0.35;
const OPEN_GAZE_COS = Math.cos((25 * Math.PI) / 180);
const OPEN_HOLD = 0.2;
/** Look this far away from the open tray for CLOSE_HOLD seconds and it folds away. */
const AWAY_COS = Math.cos((70 * Math.PI) / 180);
const CLOSE_HOLD = 1.0;
/** Every slot icon is scaled to fit this size (metres). */
const ICON_SIZE = 0.078;
const SLOT_REACH = 0.08;
/** The recentre button's cap radius and the height of its top (button axis frame). */
const BUTTON_R = 0.034;
const BUTTON_TOP = 0.045;

type SlotId = ItemId | 'headlamp-worn';

interface Slot {
  id: SlotId;
  root: Group;
  label: Sprite;
  labelCanvas: HTMLCanvasElement;
  labelTexture: CanvasTexture;
  hover: number;
  lastText: string;
}

const tmpA = new Vector3();
const tmpB = new Vector3();

/** The pack's root while it's open (the guide notes rest on its lid in XR). */
export const packRefs = {
  root: null as Group | null,
  /** Where the notes rest: in front of the tray's open lid. */
  notes: null as Object3D | null,
};

export class BackpackSystem extends createSystem({}) {
  private root = new Group();
  private tray!: PackTray;
  /** The tray's pose relative to the rig while it is open (it travels with you). */
  private readonly localPos = new Vector3();
  private readonly localQuat = new Quaternion();
  private readonly palmWasUp: Record<Handedness, boolean> = { left: false, right: false };
  private slots = new Map<SlotId, Slot>();
  private held: Record<Handedness, { item: ItemId | null; model: Object3D | null }> = {
    left: { item: null, model: null },
    right: { item: null, model: null },
  };
  private mapBoard!: Mesh;
  private mapCanvas!: HTMLCanvasElement;
  private mapTexture!: CanvasTexture;
  private mapTimer = 0;
  private flareLight!: PointLight;
  private flareTime = -1;
  private readonly poseFor: Record<Handedness, number> = { left: 0, right: 0 };
  private clock = 0;
  private lostFor = 0;
  private scale = 0;
  private desktopOpen = false;
  private takeCooldown = 0;
  private sipCooldown = 0;
  private squeezeTime = 0;
  private builtVersion = -1;
  private button!: Group;
  private buttonCap!: Group;
  private buttonAxis!: Group;
  private buttonRing!: Mesh;
  private buttonArmed = true;
  private buttonPush = 0;
  private readonly head = new Vector3();
  private readonly gaze = new Vector3();
  private readonly want = new Vector3();
  private readonly quat = new Quaternion();

  init(): void {
    packRefs.root = this.root;
    this.root.name = 'BackpackUI';
    this.tray = buildPackTray();
    this.root.add(this.tray.group);
    packRefs.notes = this.tray.notes;
    this.button = this.buildButton();
    this.button.position.copy(this.tray.sideButton);
    this.root.add(this.button);
    this.root.visible = false;
    this.world.createTransformEntity(this.root, { persistent: true });

    // The open map, held flat-ish above the hand.
    this.mapCanvas = document.createElement('canvas');
    this.mapCanvas.width = this.mapCanvas.height = 512;
    this.mapTexture = new CanvasTexture(this.mapCanvas);
    this.mapTexture.colorSpace = SRGBColorSpace;
    this.mapBoard = new Mesh(
      new PlaneGeometry(0.32, 0.32),
      new MeshBasicMaterial({ map: this.mapTexture, toneMapped: false }),
    );
    this.mapBoard.name = 'HeldMap';
    this.mapBoard.visible = false;
    this.world.createTransformEntity(this.mapBoard, { persistent: true });

    // Headlamp: a spotlight that follows your gaze once you put it on. It is
    // created once and toggled by intensity (see expedition/sky/headlamp.ts).
    headlamp.attach(this.world);

    this.flareLight = new PointLight(0xff3b1f, 0, 60, 2);
    this.flareLight.name = 'FlareLight';
    this.world.createTransformEntity(this.flareLight, { persistent: true });

    this.cleanupFuncs.push(
      equipment.headlampOn.subscribe((on) => {
        headlamp.setOn(on);
      }),
      game.recentre.subscribe((n) => {
        if (n > 0) this.recentreGeneric();
      }),
    );
  }

  /**
   * The recentre button: a big brass push button in a wooden housing on a
   * bracket off the tray's near-left corner, tipped up to face you, with a
   * ring that glows as a finger comes near and a name plate beneath.
   */
  private buildButton(): Group {
    const group = new Group();
    group.name = 'RecentreButton';
    const wood = new MeshStandardMaterial({ color: 0x4a3020, roughness: 0.8 });
    const brass = new MeshStandardMaterial({ color: 0xc9a040, roughness: 0.35, metalness: 0.7 });
    // The bracket out from the rim.
    const bracket = new Mesh(new BoxGeometry(0.07, 0.014, 0.08), wood);
    bracket.position.set(0.02, 0.006, 0);
    group.add(bracket);
    // Everything above sits on an axis tipped up toward your eyes.
    const axis = new Group();
    axis.rotation.x = -(Math.PI / 2 - TRAY_TILT) * 0.55;
    axis.position.y = 0.014;
    group.add(axis);
    this.buttonAxis = axis;
    const housing = new Mesh(new CylinderGeometry(BUTTON_R + 0.012, BUTTON_R + 0.016, 0.026, 28), wood);
    housing.position.y = 0.013;
    axis.add(housing);
    this.buttonRing = new Mesh(
      new TorusGeometry(BUTTON_R + 0.004, 0.0045, 8, 36),
      new MeshBasicMaterial({ color: 0x3a2a12, toneMapped: false }),
    );
    this.buttonRing.rotation.x = Math.PI / 2;
    this.buttonRing.position.y = 0.027;
    axis.add(this.buttonRing);
    // The cap: a brass drum with the circling-arrow face on top.
    const cap = new Group();
    cap.position.y = BUTTON_TOP - 0.009;
    const drum = new Mesh(new CylinderGeometry(BUTTON_R, BUTTON_R, 0.018, 28), brass);
    cap.add(drum);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#e2bd4c';
    ctx.beginPath();
    ctx.arc(64, 64, 63, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#2b2116';
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.arc(64, 66, 34, -0.35, Math.PI * 1.6);
    ctx.stroke();
    ctx.fillStyle = '#2b2116';
    ctx.beginPath();
    ctx.moveTo(104, 40);
    ctx.lineTo(104, 76);
    ctx.lineTo(72, 56);
    ctx.closePath();
    ctx.fill();
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    const face = new Mesh(new CircleGeometry(BUTTON_R * 0.96, 32), new MeshBasicMaterial({ map: texture }));
    face.rotation.x = -Math.PI / 2;
    // Turned so the arrow reads upright from where you stand.
    face.rotation.z = Math.PI;
    face.position.y = 0.0095;
    cap.add(face);
    axis.add(cap);
    this.buttonCap = cap;
    // Name plate on the bracket's near edge.
    const plateCanvas = document.createElement('canvas');
    plateCanvas.width = 256;
    plateCanvas.height = 64;
    const pc = plateCanvas.getContext('2d')!;
    pc.fillStyle = '#c9a040';
    pc.fillRect(0, 0, 256, 64);
    pc.fillStyle = '#2b2116';
    pc.font = '700 38px Georgia, serif';
    pc.textAlign = 'center';
    pc.textBaseline = 'middle';
    pc.fillText('RECENTRE', 128, 34);
    const plateTexture = new CanvasTexture(plateCanvas);
    plateTexture.colorSpace = SRGBColorSpace;
    const plate = new Mesh(new PlaneGeometry(0.068, 0.017), new MeshBasicMaterial({ map: plateTexture }));
    plate.rotation.x = -Math.PI / 2 + 0.6;
    plate.position.set(0.02, 0.016, 0.048);
    group.add(plate);
    return group;
  }

  /** Any fingertip or palm touching the cap presses it. */
  private updateButton(dt: number, presenting: boolean): void {
    this.buttonPush = Math.max(0, this.buttonPush - dt * 3);
    this.buttonCap.position.y = BUTTON_TOP - 0.009 - 0.012 * this.buttonPush;
    let near = 0;
    let touching = false;
    let clear = true;
    if (presenting && this.scale >= 1) {
      this.buttonAxis.updateWorldMatrix(true, false);
      for (const hand of HANDS) {
        if (!hand.tracked) continue;
        for (const p of [hand.indexTip, hand.position]) {
          tmpA.copy(p);
          this.buttonAxis.worldToLocal(tmpA);
          const radial = Math.hypot(tmpA.x, tmpA.z);
          const above = tmpA.y - BUTTON_TOP;
          if (radial < BUTTON_R + 0.025 && above < 0.025 && above > -0.04) touching = true;
          if (radial < BUTTON_R + 0.05 && above < 0.07 && above > -0.05) clear = false;
          const d = Math.hypot(radial, Math.max(0, above));
          near = Math.max(near, 1 - Math.min(1, d / 0.12));
        }
      }
    }
    if (this.buttonArmed && touching) {
      this.buttonArmed = false;
      this.pressButton();
    } else if (!this.buttonArmed && clear) {
      this.buttonArmed = true;
    }
    // Ring: dark at rest, amber as a finger comes near, green as it fires.
    const ring = this.buttonRing.material as MeshBasicMaterial;
    if (this.buttonPush > 0.05) ring.color.setRGB(0.3, 1.6 * this.buttonPush + 0.3, 0.4);
    else ring.color.setRGB(0.23 + 1.3 * near, 0.16 + 0.75 * near, 0.07 + 0.1 * near);
  }

  private pressButton(): void {
    this.buttonPush = 1;
    audio.clack();
    requestRecentre();
  }

  /** Re-centring outside the cave and the chute (they handle their own). */
  private recentreGeneric(): void {
    const world = this.world;
    switch (game.phase.peek()) {
      case Phase.Poling: {
        getHeadWorld(world, this.head);
        currentLevel().walkDirection(this.head.x, this.head.z, tmpA);
        faceYaw(world, Math.atan2(-tmpA.x, -tmpA.z));
        toast('Facing up the trail.', 2);
        break;
      }
      case Phase.Building:
        faceYaw(world, 0);
        placeHeadAt(world, BUILD_STAND.x, BUILD_STAND.z, BUILD_STAND.y);
        toast('Back at the workbench.', 2);
        break;
      case Phase.Landed:
        getHeadWorld(world, this.head);
        faceYaw(world, Math.atan2(-(FIRE_POS.x - this.head.x), -(FIRE_POS.z - this.head.z)));
        toast('Facing the fire.', 2);
        break;
      case Phase.Climbing:
      case Phase.Launch:
      case Phase.Gliding:
        toast("Can't recentre right now. Hold on!", 2);
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------- slots -----

  private slotIds(): SlotId[] {
    const ids: SlotId[] = [];
    for (const item of ItemIds) if (packCount(item) > 0) ids.push(item);
    if (equipment.headlampOn.peek()) ids.push('headlamp-worn');
    return ids;
  }

  private ensureSlot(id: SlotId): Slot {
    let slot = this.slots.get(id);
    if (slot) return slot;
    const root = new Group();
    root.name = `PackSlot-${id}`;
    const icon = buildSlotIcon(id === 'headlamp-worn' ? 'headlamp' : id);
    const size = new Box3().setFromObject(icon).getSize(new Vector3());
    icon.scale.multiplyScalar(ICON_SIZE / Math.max(size.x, size.y, size.z, 1e-3));
    root.add(icon);
    const labelCanvas = document.createElement('canvas');
    labelCanvas.width = 256;
    labelCanvas.height = 64;
    const labelTexture = new CanvasTexture(labelCanvas);
    labelTexture.colorSpace = SRGBColorSpace;
    const label = new Sprite(new SpriteMaterial({ map: labelTexture, depthTest: false, transparent: true }));
    // A small name tag along the near edge of the slot.
    label.scale.set(0.1, 0.025, 1);
    label.position.set(0, 0.012, CELL * 0.36);
    label.renderOrder = 30;
    root.add(label);
    this.root.add(root);
    slot = { id, root, label, labelCanvas, labelTexture, hover: 0, lastText: '' };
    this.slots.set(id, slot);
    return slot;
  }

  private labelFor(id: SlotId): string {
    if (id === 'headlamp-worn') return 'Lamp: ON';
    const n = packCount(id);
    const name = ITEM_LABELS[id];
    if (id === 'thermos') return `${name} ${game.thermosSips}/4`;
    return n > 1 ? `${name} x${n}` : name;
  }

  private drawLabel(slot: Slot, text: string, hover: boolean): void {
    const key = `${text}|${hover}`;
    if (slot.lastText === key) return;
    slot.lastText = key;
    const ctx = slot.labelCanvas.getContext('2d')!;
    ctx.clearRect(0, 0, 256, 64);
    ctx.fillStyle = hover ? 'rgba(255,214,120,0.92)' : 'rgba(18,24,34,0.78)';
    ctx.beginPath();
    ctx.roundRect(4, 8, 248, 48, 22);
    ctx.fill();
    ctx.fillStyle = hover ? '#1b1b1b' : '#f2f5fb';
    ctx.font = '600 24px Inter, Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 33);
    slot.labelTexture.needsUpdate = true;
  }

  private layoutSlots(): void {
    const ids = this.slotIds();
    const key = equipment.version.peek() * 31 + (equipment.headlampOn.peek() ? 1 : 0) + game.thermosSips * 7;
    if (key !== this.builtVersion) {
      this.builtVersion = key;
      for (const [id, slot] of this.slots) slot.root.visible = ids.includes(id);
    }
    const building = game.phase.peek() === Phase.Building;
    // One item per slot, filling the grid row by row from the far side;
    // the one under your hand lifts out of its slot.
    ids.forEach((id, i) => {
      const slot = this.ensureSlot(id);
      slot.root.visible = i < COLS * ROWS;
      cellCentre(i % COLS, Math.floor(i / COLS), slot.root.position, 0.006 + slot.hover * 0.03);
      // While you build, the glider parts pulse in their slots.
      const beat = building && id !== 'headlamp-worn' && PART_ITEMS.has(id) ? 0.08 * (0.5 + 0.5 * Math.sin(this.clock * 4.2)) : 0;
      slot.root.scale.setScalar(1 + slot.hover * 0.25 + beat);
      this.drawLabel(slot, this.labelFor(id), slot.hover > 0.5);
    });
  }

  // ----------------------------------------------------------- update ------

  update(delta: number, time: number): void {
    const dt = Math.min(delta, 0.1);
    this.clock = time;
    getHeadWorld(this.world, this.head);
    const presenting = this.world.renderer.xr.isPresenting;
    this.takeCooldown = Math.max(0, this.takeCooldown - dt);
    this.sipCooldown = Math.max(0, this.sipCooldown - dt);

    if (presenting) this.updateGesture(dt);
    else this.updateDesktop();

    const open = game.packOpen.peek();
    this.scale = Math.min(1, Math.max(0, this.scale + (open ? dt : -dt) / 0.15));
    this.root.visible = this.scale > 0;
    if (this.root.visible) {
      this.placePack(presenting);
      this.layoutSlots();
      if (presenting && this.scale >= 1) this.updateReach(dt);
      this.updateButton(dt, presenting);
    }

    this.updateHeldModels();
    if (presenting) this.updateItemUse(dt);
    this.updateMap(dt);
    this.updateHeadlamp();
    this.updateFlare(dt, time);
  }

  private updateGesture(dt: number): void {
    this.viewDirection(this.gaze);
    // Either palm up (held briefly, while you look at it) toggles the tray;
    // so does A or X on a controller. Once a toggle fires, every palm that is
    // up has to come down again before it counts, so both palms up at once
    // only toggle it once.
    let toggle = false;
    for (const h of HANDS) {
      const side = h.handedness;
      tmpA.subVectors(h.position, this.head).normalize();
      const palmUp = h.tracked && !h.grip && h.palmNormal.y > OPEN_UP && this.gaze.dot(tmpA) > OPEN_GAZE_COS;
      this.poseFor[side] = palmUp ? this.poseFor[side] + dt : 0;
      if (this.poseFor[side] >= OPEN_HOLD && !this.palmWasUp[side]) toggle = true;
      if (!palmUp && h.palmNormal.y < STAY_UP) this.palmWasUp[side] = false;
    }
    if (toggle) {
      for (const h of HANDS) if (this.poseFor[h.handedness] > 0) this.palmWasUp[h.handedness] = true;
    }
    const pads = this.input.xr.gamepads;
    if (pads.right?.getButtonDown(InputComponent.A_Button) || pads.left?.getButtonDown(InputComponent.X_Button)) toggle = true;
    const open = game.packOpen.peek();
    if (toggle) {
      this.setOpen(!open);
      return;
    }
    if (!open) return;
    // Look well away from the open tray for a moment and it folds away.
    this.root.getWorldPosition(tmpB);
    tmpA.subVectors(tmpB, this.head);
    const far = tmpA.length() > 1.6;
    const away = far || this.gaze.dot(tmpA.normalize()) < AWAY_COS;
    this.lostFor = away ? this.lostFor + dt : 0;
    if (this.lostFor >= CLOSE_HOLD) this.setOpen(false);
  }

  private setOpen(open: boolean): void {
    game.packOpen.value = open;
    this.lostFor = 0;
    audio.zip();
    if (open) this.present();
  }

  /**
   * Bring the tray up in front of the viewer: waist height, tipped toward
   * them. The pose is kept relative to the rig, so it travels with you.
   */
  private present(): void {
    getHeadWorld(this.world, this.head);
    const d = this.viewDirection(this.gaze);
    d.y = 0;
    if (d.lengthSq() < 1e-6) d.set(0, 0, -1);
    d.normalize();
    const up = tmpA.set(0, 1, 0);
    const X = new Vector3().crossVectors(d, up).normalize();
    const Y = up.clone().multiplyScalar(Math.cos(TRAY_TILT)).addScaledVector(d, -Math.sin(TRAY_TILT));
    const Z = new Vector3().crossVectors(X, Y);
    const desktop = !this.world.renderer.xr.isPresenting;
    this.want.copy(this.head).addScaledVector(d, (desktop ? 0.62 : 0.42) + TRAY_H * 0.2);
    this.want.y -= desktop ? 0.42 : 0.5;
    this.quat.setFromRotationMatrix(new Matrix4().makeBasis(X, Y, Z));
    const rig = this.player;
    rig.updateMatrixWorld(true);
    this.localPos.copy(this.want);
    rig.worldToLocal(this.localPos);
    rig.getWorldQuaternion(this.localQuat).invert().multiply(this.quat);
  }

  /** Unit vector the viewer is looking along. */
  private viewDirection(out: Vector3): Vector3 {
    if (this.world.renderer.xr.isPresenting) {
      // Object3D.getWorldDirection gives +Z; the head looks down -Z.
      return this.player.head.getWorldDirection(out).negate();
    }
    return this.world.camera.getWorldDirection(out);
  }

  private updateDesktop(): void {
    const kb = this.input.keyboard;
    if (kb.getKeyDown('KeyB')) {
      this.desktopOpen = !this.desktopOpen;
      game.packOpen.value = this.desktopOpen;
      audio.zip();
    }
    const digits = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9'];
    if (game.packOpen.peek()) {
      const ids = this.slotIds();
      digits.forEach((code, i) => {
        if (kb.getKeyDown(code) && ids[i]) this.takeSlot(ids[i], 'right');
      });
    }
    if (kb.getKeyDown('KeyQ')) this.stowHand('right');
    if (kb.getKeyDown('KeyU')) this.useRightItemDesktop();
    if (kb.getKeyDown('KeyR')) this.pressButton();
  }

  private placePack(presenting: boolean): void {
    // Desktop: the tray stays low in front of the camera as you look round.
    if (!presenting) this.present();
    const rig = this.player;
    this.root.position.copy(this.localPos);
    rig.localToWorld(this.root.position);
    rig.getWorldQuaternion(this.root.quaternion).multiply(this.localQuat);
    // It rises into place as it opens and sinks as it folds away.
    const e = this.scale * this.scale * (3 - 2 * this.scale);
    this.root.position.y -= (1 - e) * 0.18;
    this.root.scale.setScalar(Math.max(0.001, 0.4 + 0.6 * e) * (presenting ? 1 : 1.35));
  }

  /** Hands reaching into the open tray: hover, take, put back. */
  private updateReach(dt: number): void {
    let hovered: Slot | null = null;
    let hoverHand: Handedness = 'right';
    let best = SLOT_REACH;
    for (const hand of HANDS) {
      if (!hand.tracked || equipment.inHand[hand.handedness]) continue;
      for (const slot of this.slots.values()) {
        if (!slot.root.visible) continue;
        slot.root.getWorldPosition(tmpA);
        const d = Math.min(tmpA.distanceTo(hand.position), tmpA.distanceTo(hand.indexTip));
        if (d < best) {
          best = d;
          hovered = slot;
          hoverHand = hand.handedness;
        }
      }
    }
    for (const slot of this.slots.values()) {
      const target = slot === hovered ? 1 : 0;
      slot.hover += (target - slot.hover) * Math.min(1, dt * 14);
    }
    if (hovered && hands[hoverHand].gripDown && this.takeCooldown <= 0) {
      this.takeSlot(hovered.id, hoverHand);
      return;
    }
    // Put back: let go of a held item over the tray.
    for (const hand of HANDS) {
      const side = hand.handedness;
      if (!equipment.inHand[side] || !hand.gripUp || this.takeCooldown > 0) continue;
      tmpB.copy(hand.position);
      this.root.worldToLocal(tmpB);
      if (Math.abs(tmpB.x) < TRAY_W / 2 + 0.06 && Math.abs(tmpB.z) < TRAY_H / 2 + 0.06 && tmpB.y > -0.05 && tmpB.y < 0.25) {
        this.stowHand(side);
      }
    }
  }

  private takeSlot(id: SlotId, side: Handedness): void {
    if (id === 'headlamp-worn') {
      equipment.headlampOn.value = false;
      equipment.pack.set('headlamp', packCount('headlamp') + 1);
      take('headlamp', side);
    } else if (!take(id, side)) {
      return;
    }
    audio.zip();
    this.takeCooldown = 0.7;
    if (id === 'thermos') toast('Bring it to your mouth to sip');
    else if (id === 'warmer') toast('Squeeze to crack it');
    else if (id === 'headlamp') toast('Touch it to your forehead');
    else if (id === 'flare') toast('Raise it high and squeeze');
    else if (id === 'glider') toast('Drop it at the launch to unpack');
    else if (id === 'carabiner') toast('Touch the rope to clip in');
    else if (id !== 'headlamp-worn' && PART_ITEMS.has(id)) {
      toast(game.phase.peek() === Phase.Building ? 'Carry it to its outline on the frame' : 'Keep it for the build up top');
    }
  }

  private stowHand(side: Handedness): void {
    const item = equipment.inHand[side];
    if (!item) return;
    stow(side);
    if (PAIRED.has(item)) {
      const other: Handedness = side === 'left' ? 'right' : 'left';
      if (equipment.inHand[other] === item) stow(other);
    }
    audio.zip();
  }

  // ------------------------------------------------------- held items ------

  private updateHeldModels(): void {
    for (const hand of HANDS) {
      const side = hand.handedness;
      const item = equipment.inHand[side];
      const slot = this.held[side];
      if (slot.item !== item) {
        if (slot.model) {
          slot.model.removeFromParent();
          slot.model = null;
        }
        slot.item = item;
        const model = item ? buildHeldItem(item) : null;
        if (model) {
          this.world.createTransformEntity(model, { persistent: true });
          slot.model = model;
        }
      }
      if (slot.model) {
        const visible = hand.tracked || !this.world.renderer.xr.isPresenting;
        slot.model.visible = visible;
        if (this.world.renderer.xr.isPresenting) {
          slot.model.position.copy(hand.position);
          slot.model.quaternion.copy(hand.quaternion);
        } else {
          // Desktop: show the held item low in the corner of the view.
          const yaw = getHeadYaw(this.world);
          const sideSign = side === 'right' ? 1 : -1;
          slot.model.position.set(
            this.head.x - Math.sin(yaw) * 0.45 + Math.cos(yaw) * 0.22 * sideSign,
            this.head.y - 0.28,
            this.head.z - Math.cos(yaw) * 0.45 - Math.sin(yaw) * 0.22 * sideSign,
          );
          this.quat.setFromAxisAngle(tmpA.set(0, 1, 0), yaw);
          slot.model.quaternion.copy(this.quat);
          slot.model.rotateX(-0.9);
        }
      }
    }
  }

  private updateItemUse(dt: number): void {
    for (const hand of HANDS) {
      const side = hand.handedness;
      const item = equipment.inHand[side];
      if (!item || !hand.tracked) continue;
      const toHead = hand.position.distanceTo(this.head);
      switch (item) {
        case 'thermos':
          // Mouth sits a little below the eyes.
          tmpA.copy(this.head);
          tmpA.y -= 0.1;
          if (hand.position.distanceTo(tmpA) < 0.17 && this.sipCooldown <= 0) this.sip();
          break;
        case 'warmer':
          this.squeezeTime = hand.grip ? this.squeezeTime + dt : 0;
          if (this.squeezeTime > 1) {
            this.squeezeTime = 0;
            consume(side);
            addWarmth(0.3);
            audio.crackle(0.6);
            toast('Warm hands. +30% warmth');
          }
          break;
        case 'headlamp':
          if (toHead < 0.16 && hand.position.y > this.head.y - 0.02) this.wearHeadlamp(side);
          break;
        case 'flare':
          if (hand.position.y > this.head.y + 0.12 && hand.gripDown) this.fireFlare(side);
          break;
        case 'glider':
          if (hand.gripUp && !game.packOpen.peek()) this.deployGlider(side);
          break;
        default:
          break;
      }
    }
  }

  private useRightItemDesktop(): void {
    const item = equipment.inHand.right;
    switch (item) {
      case 'thermos':
        this.sip();
        break;
      case 'warmer':
        consume('right');
        addWarmth(0.3);
        toast('Warm hands. +30% warmth');
        break;
      case 'headlamp':
        this.wearHeadlamp('right');
        break;
      case 'flare':
        this.fireFlare('right');
        break;
      case 'glider':
        this.deployGlider('right');
        break;
      default:
        break;
    }
  }

  private sip(): void {
    this.sipCooldown = 1.4;
    if (game.thermosSips <= 0) {
      toast('Thermos is empty. Refill at a camp');
      return;
    }
    game.thermosSips--;
    addWarmth(0.15);
    audio.sip();
    toast(`Hot tea. ${game.thermosSips} sips left`);
  }

  private wearHeadlamp(side: Handedness): void {
    consume(side);
    equipment.headlampOn.value = true;
    audio.clack();
    toast('Headlamp on');
  }

  private fireFlare(side: Handedness): void {
    consume(side);
    this.flareTime = 0;
    this.flareLight.position.copy(hands[side].position);
    audio.crack();
    toast(currentLevel().onFlare?.() ?? 'Your flare lights up the sky');
  }

  private deployGlider(side: Handedness): void {
    const lvl = currentLevel();
    const blocker = lvl.gliderDeployBlocker ? lvl.gliderDeployBlocker(this.head) : 'Not here';
    if (blocker) {
      toast(blocker);
      return;
    }
    consume(side);
    audio.whoosh();
    lvl.deployGlider?.();
  }

  // --------------------------------------------------- map / lamp / flare --

  private updateMap(dt: number): void {
    const leftMap = equipment.inHand.left === 'map';
    const rightMap = equipment.inHand.right === 'map';
    const presenting = this.world.renderer.xr.isPresenting;
    this.mapBoard.visible = leftMap || rightMap;
    if (!this.mapBoard.visible) return;
    if (presenting) {
      const hand = rightMap ? hands.right : hands.left;
      this.mapBoard.position.copy(hand.position);
      this.mapBoard.position.y += 0.12;
      tmpA.subVectors(this.head, this.mapBoard.position);
      this.mapBoard.lookAt(tmpA.add(this.mapBoard.position));
    } else {
      const yaw = getHeadYaw(this.world);
      this.mapBoard.position.set(this.head.x - Math.sin(yaw) * 0.5, this.head.y - 0.12, this.head.z - Math.cos(yaw) * 0.5);
      this.mapBoard.lookAt(this.head);
    }
    this.mapTimer -= dt;
    if (this.mapTimer <= 0) {
      this.mapTimer = 0.5;
      const ctx = this.mapCanvas.getContext('2d')!;
      ctx.fillStyle = '#efe6d2';
      ctx.fillRect(0, 0, 512, 512);
      const draw = currentLevel().drawMap;
      if (draw) draw(ctx, 512, this.head, getHeadYaw(this.world));
      ctx.strokeStyle = '#6b4a2f';
      ctx.lineWidth = 10;
      ctx.strokeRect(5, 5, 502, 502);
      this.mapTexture.needsUpdate = true;
    }
  }

  private updateHeadlamp(): void {
    if (!headlamp.isOn()) return;
    const yaw = getHeadYaw(this.world);
    this.viewDirection(tmpA);
    if (!Number.isFinite(tmpA.x)) tmpA.set(-Math.sin(yaw), -0.2, -Math.cos(yaw));
    headlamp.aim(this.head, tmpA);
  }

  private updateFlare(dt: number, time: number): void {
    if (this.flareTime < 0) {
      this.flareLight.intensity = 0;
      return;
    }
    this.flareTime += dt;
    // The flare arcs up and burns bright red, then fades.
    this.flareLight.position.y += dt * Math.max(0, 22 - this.flareTime * 9);
    const burn = Math.max(0, 1 - this.flareTime / 6);
    this.flareLight.intensity = 2200 * burn * (0.8 + 0.2 * Math.sin(time * 40));
    if (Math.random() < 0.6) sceneRefs.puffs?.emit(this.flareLight.position, 1, 0.3);
    if (burn <= 0) this.flareTime = -1;
  }
}
