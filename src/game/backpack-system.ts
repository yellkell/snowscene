/**
 * The backpack: turn your LEFT palm up and look at it, and your pack opens
 * just above your palm with your gear floating in a ring of slots. Reach in
 * with your RIGHT hand and close it on an item to take it; drop a held item
 * back over the open pack to stow it. Turn the palm over or look away and it
 * closes. (Gesture adapted from the FIRE FIGHT FLUX wrist panel: the pose
 * must be held briefly to open, with looser limits to stay open, so a hand
 * passing palm-up mid-stride doesn't flash it open.)
 *
 * Items in hand also work here:
 *   thermos   bring it to your mouth to sip (warms you)
 *   warmer    squeeze it for a second to crack it (warms you)
 *   headlamp  touch it to your forehead to put it on
 *   map       hold it up to read it
 *   flare     raise it above your head and squeeze to fire it
 *   glider    drop it on the summit to unpack it
 *
 * RECENTRE: a brass button on the front of the open pack. Poke it with your
 * right index finger to re-centre yourself: back to the middle of the deck
 * you're on in the cave, your lean on the flume, facing up the trail, back
 * at the workbench, or facing the fire once you've landed.
 *
 * Desktop: B toggles the pack, 1-9 take items, U uses, Q stows, R recentres.
 */

import {
  Box3,
  CanvasTexture,
  createSystem,
  Group,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  PointLight,
  Quaternion,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
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
  stow,
  take,
} from './equipment.js';
import { headlamp } from './expedition/sky/headlamp.js';
import { HANDS, hands, type Handedness } from './hand-input.js';
import { buildBackpack, buildHeldItem, buildSlotIcon } from './items.js';
import { currentLevel } from './level.js';
import { sceneRefs } from './scene-system.js';
import { FIRE_POS } from './campfire.js';
import { faceYaw, getHeadWorld, getHeadYaw, placeHeadAt } from './rig.js';
import { addWarmth, game, Phase, requestRecentre, SUMMIT_STAND, toast } from './state.js';
import { SUMMIT_Y } from './terrain.js';

/** Gesture thresholds (from FLUX): palm-normal·up and gaze cone, open/stay. */
const OPEN_UP = 0.65;
const STAY_UP = 0.35;
const OPEN_GAZE_COS = Math.cos((25 * Math.PI) / 180);
const STAY_GAZE_COS = Math.cos((40 * Math.PI) / 180);
const OPEN_HOLD = 0.2;
const CLOSE_HOLD = 0.3;
/** Pack floats this far above the palm. */
const LIFT = 0.12;
const SLOT_RADIUS = 0.24;
/** Every slot icon is scaled to fit this size (metres). */
const ICON_SIZE = 0.07;
const SLOT_REACH = 0.075;
const STOW_REACH = 0.13;
/** The recentre button: where it sits on the pack's front, and poke radii. */
const BUTTON_POS = new Vector3(0, -0.055, 0.1);
const BUTTON_PRESS = 0.028;
const BUTTON_REARM = 0.06;

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

/** The pack's root while it's open (the guide panel rides on it in XR). */
export const packRefs = {
  root: null as Group | null,
};

export class BackpackSystem extends createSystem({}) {
  private root = new Group();
  private pack!: Group;
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
  private poseFor = 0;
  private lostFor = 0;
  private scale = 0;
  private desktopOpen = false;
  private takeCooldown = 0;
  private sipCooldown = 0;
  private squeezeTime = 0;
  private builtVersion = -1;
  private button!: Group;
  private buttonCap!: Mesh;
  private buttonArmed = true;
  private buttonPush = 0;
  private readonly head = new Vector3();
  private readonly gaze = new Vector3();
  private readonly want = new Vector3();
  private readonly quat = new Quaternion();

  init(): void {
    packRefs.root = this.root;
    this.root.name = 'BackpackUI';
    this.pack = buildBackpack();
    this.root.add(this.pack);
    this.button = this.buildButton();
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

  /** A round brass button with a circling-arrow face. */
  private buildButton(): Group {
    const group = new Group();
    group.name = 'RecentreButton';
    group.position.copy(BUTTON_POS);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#d8b23a';
    ctx.beginPath();
    ctx.arc(64, 64, 62, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#2b2116';
    ctx.lineWidth = 11;
    ctx.beginPath();
    ctx.arc(64, 60, 30, -0.4, Math.PI * 1.55);
    ctx.stroke();
    ctx.fillStyle = '#2b2116';
    ctx.beginPath();
    ctx.moveTo(98, 34);
    ctx.lineTo(98, 66);
    ctx.lineTo(70, 50);
    ctx.closePath();
    ctx.fill();
    ctx.font = '700 17px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('RECENTRE', 64, 118);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    this.buttonCap = new Mesh(
      new PlaneGeometry(0.056, 0.056),
      new MeshBasicMaterial({ map: texture, transparent: true, alphaTest: 0.5 }),
    );
    group.add(this.buttonCap);
    return group;
  }

  /** Right index fingertip poking the recentre button. */
  private updateButton(dt: number, presenting: boolean): void {
    this.buttonPush = Math.max(0, this.buttonPush - dt * 4);
    this.buttonCap.position.z = -0.008 * this.buttonPush;
    if (!presenting || this.scale < 1) return;
    const tip = hands.right.indexTip;
    if (!hands.right.tracked) return;
    this.buttonCap.getWorldPosition(tmpA);
    const d = tmpA.distanceTo(tip);
    if (this.buttonArmed && d < BUTTON_PRESS) {
      this.buttonArmed = false;
      this.pressButton();
    } else if (!this.buttonArmed && d > BUTTON_REARM) {
      this.buttonArmed = true;
    }
  }

  private pressButton(): void {
    this.buttonPush = 1;
    audio.clack();
    requestRecentre();
  }

  /** Re-centring outside the cave and the flume (they handle their own). */
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
        placeHeadAt(world, SUMMIT_STAND.x, SUMMIT_STAND.z, SUMMIT_Y);
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
    label.scale.set(0.1, 0.025, 1);
    label.position.y = -0.055;
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
    ctx.font = '600 26px Inter, Helvetica, Arial, sans-serif';
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
    // An arc of slots behind and above the pack mouth, facing you (+Z).
    const n = ids.length;
    const spread = Math.min(2.6, 0.48 * Math.max(1, n - 1));
    ids.forEach((id, i) => {
      const slot = this.ensureSlot(id);
      slot.root.visible = true;
      const t = n === 1 ? 0 : i / (n - 1) - 0.5;
      const a = t * spread;
      slot.root.position.set(Math.sin(a) * SLOT_RADIUS, 0.07 + Math.cos(a) * 0.04, -Math.cos(a) * SLOT_RADIUS * 0.45);
      const s = 1 + slot.hover * 0.3;
      slot.root.scale.setScalar(s);
      this.drawLabel(slot, this.labelFor(id), slot.hover > 0.5);
    });
  }

  // ----------------------------------------------------------- update ------

  update(delta: number, time: number): void {
    const dt = Math.min(delta, 0.1);
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
      this.placePack(dt, presenting);
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
    const h = hands.left;
    this.viewDirection(this.gaze);
    tmpA.subVectors(h.position, this.head).normalize();
    const up = h.palmNormal.y;
    const look = this.gaze.dot(tmpA);
    const ok = h.tracked && !h.grip;
    const open = game.packOpen.peek();
    const holding = open ? ok && up > STAY_UP && look > STAY_GAZE_COS : ok && up > OPEN_UP && look > OPEN_GAZE_COS;
    if (holding) {
      this.poseFor += dt;
      this.lostFor = 0;
    } else {
      this.lostFor += dt;
      this.poseFor = 0;
    }
    if (!open && this.poseFor >= OPEN_HOLD) {
      game.packOpen.value = true;
      audio.zip();
      this.root.position.copy(h.position).y += LIFT;
    } else if (open && this.lostFor >= CLOSE_HOLD) {
      game.packOpen.value = false;
      audio.zip();
    }
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

  private placePack(dt: number, presenting: boolean): void {
    if (presenting) {
      const h = hands.left;
      if (h.tracked) {
        this.want.copy(h.position);
        this.want.y += LIFT;
        this.root.position.lerp(this.want, Math.min(1, dt * 12));
      }
    } else {
      // Desktop: float the pack low in front of the camera.
      const yaw = getHeadYaw(this.world);
      this.root.position.set(
        this.head.x - Math.sin(yaw) * 0.7,
        this.head.y - 0.2,
        this.head.z - Math.cos(yaw) * 0.7,
      );
    }
    tmpA.copy(this.head);
    tmpA.y = this.root.position.y + 0.05;
    this.root.lookAt(tmpA);
    this.root.scale.setScalar(Math.max(0.001, this.scale) * (presenting ? 1 : 1.5));
  }

  /** Right hand reaching into the open pack: hover, take, stow. */
  private updateReach(dt: number): void {
    const right = hands.right;
    if (!right.tracked) return;
    let hovered: Slot | null = null;
    let best = SLOT_REACH;
    for (const slot of this.slots.values()) {
      if (!slot.root.visible) continue;
      slot.root.getWorldPosition(tmpA);
      const d = Math.min(tmpA.distanceTo(right.position), tmpA.distanceTo(right.indexTip));
      if (d < best) {
        best = d;
        hovered = slot;
      }
    }
    for (const slot of this.slots.values()) {
      const target = slot === hovered ? 1 : 0;
      slot.hover += (target - slot.hover) * Math.min(1, dt * 14);
    }
    if (hovered && right.gripDown && this.takeCooldown <= 0) {
      this.takeSlot(hovered.id, 'right');
      return;
    }
    // Stow: let go of a held item over the pack mouth.
    const item = equipment.inHand.right;
    if (item && right.gripUp && this.takeCooldown <= 0) {
      this.pack.getWorldPosition(tmpB);
      if (tmpB.distanceTo(right.position) < STOW_REACH) this.stowHand('right');
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
    else if (id === 'leftWing' || id === 'rightWing' || id === 'controlBar') {
      toast(game.phase.peek() === Phase.Building ? 'Fit it to its glowing outline on the frame' : 'Save it for the summit workbench');
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
