/**
 * The timber works in the ice cave: the moving frame of reference, the
 * countdown grammar, the glider parts and the signal beacon.
 *
 * The frame (ff2's VOIDSTEP, after Eye of the Temple): one platform is
 * TRACKED at a time and the rig rides it, so whatever you stand on is still
 * under your real feet. Tracking passes to another platform only when its
 * anchor already agrees with the rig, so the switch itself moves nothing:
 * you step across, and the next deck carries you. Standing on a deck that
 * is leaving without having taken it over is a SLIP: the deck goes, the
 * frame holds, and you wait for the next one. Nothing ever slides the world
 * under you to correct a miss.
 *
 * The floor talks like a railway signal. Green lamps: docked, step on.
 * Amber, going out one per beat: leaving within the bar. Red: moving, or
 * held until you have taken the part from this station's rack.
 *
 * Without room to walk (or without a headset) you can still cross: reach
 * over the green deck and close your hand, or press W, and you are carried
 * one square onto it.
 */

import { Box3, Color, createSystem, Matrix4, Vector3 } from '@iwsdk/core';
import { audio } from '../audio.js';
import { addToPack, PART_ITEM } from '../equipment.js';
import { Bonfire, fires } from '../campfire.js';
import { HANDS, type Handedness } from '../hand-input.js';
import { BUILD_STAND } from '../cave-bluff.js';
import { faceYaw, getHeadWorld, placeHeadAt } from '../rig.js';
import { sceneRefs } from '../scene-system.js';
import { fadeThen, game, Phase, setPhase, toast } from '../state.js';
import {
  BEACON_INDEX,
  BOARDINGS,
  dwellInfo,
  anchorAt,
  BAR_SEC,
  GRID,
  INDEX,
  PLATFORMS,
  RIG,
  ROUTE,
  ROUTE_STEP,
  sqOffset,
  START_INDEX,
  type V3,
  validateScore,
  wheelTurns,
} from './cave-score.js';
import { buildCave, CAVE_ORIGIN, type CaveVisuals, LAMP, setRope, TILE_CORNERS, TILE_EDGES, EDGE_DIR, TILE_HALF } from './cave-build.js';
import type { GliderPartId } from '../glider-model.js';

interface PlatformState {
  anchor: V3;
  moving: boolean;
  departIn: number;
  aligned: boolean;
  /** Held at its berth until the part on the previous station is taken. */
  locked: boolean;
  wasMoving: boolean;
}

const PART_LABEL: Record<GliderPartId, string> = {
  LeftWing: 'Left wing',
  RightWing: 'Right wing',
  ControlBar: 'Control bar',
};
/** Seconds of summit view before the fade into the cave. */
const PREROLL = 3.4;
/** Close a hand within this of the torch to take it. */
const TAKE_RADIUS = 0.3;
/** A closed hand within this of a glider part (its bounds) takes it. */
const PART_REACH = 0.28;
/** How close the torch's head must come to the brazier. */
const LIGHT_RADIUS = 0.42;
/** A missed step burns the deck that left without you for this long. */
const SLIP_FLASH = 0.6;
/** The ice walls' own glow, and how warm it turns once the beacon burns. */
const ICE_GLOW = new Color(0.025, 0.08, 0.16);
const FIRE_GLOW = new Color(0.2, 0.1, 0.05);
/** Seconds after the beacon catches before you come out on top of the bluff. */
const BEACON_HOLD = 4.5;

export class CaveSystem extends createSystem({}) {
  private v!: CaveVisuals;
  private caveFire!: Bonfire;
  private inside = false;
  private preroll = -1;
  private bars = 0;
  private lastBeat = -1;
  private tracked = START_INDEX;
  private readonly off = new Vector3();
  private states: PlatformState[] = [];
  private lockPart: (GliderPartId | null)[] = [];
  private readonly collected = new Set<GliderPartId>();
  private candidate = -1;
  private candidateFrames = 0;
  private slipped = -1;
  private slipAt = -1;
  private slipFlash = 0;
  private flow = 0;
  private torchHand: Handedness | null = null;
  private beaconTimer = -1;
  private waitHintAt = 0;

  private readonly head = new Vector3();
  private readonly p = new Vector3();
  private readonly look = { x: 0, y: 0, z: 0 };
  private readonly lookRig = { x: 0, y: 0, z: 0 };
  private readonly dwell = { moving: false, departIn: Infinity };
  private readonly m = new Vector3();
  private readonly n = new Vector3();
  private readonly color = new Color();
  private readonly matrix = new Matrix4();
  /** World bounds of each part on its rack (they never move there). */
  private readonly partBounds = new Map<GliderPartId, Box3>();

  init(): void {
    if (import.meta.env.DEV) validateScore();
    this.v = buildCave();
    this.world.createTransformEntity(this.v.root, { persistent: true });
    this.v.root.updateMatrixWorld(true);
    for (const id of Object.keys(this.v.parts) as GliderPartId[]) {
      this.partBounds.set(id, new Box3().setFromObject(this.v.parts[id]));
    }
    this.states = PLATFORMS.map(() => ({
      anchor: { x: 0, y: 0, z: 0 },
      moving: false,
      departIn: Infinity,
      aligned: false,
      locked: false,
      wasMoving: false,
    }));
    // A machine leaving a part station waits until the part has been taken.
    this.lockPart = PLATFORMS.map((_, i) => {
      const step = ROUTE_STEP[i];
      if (step <= 0) return null;
      const prev = PLATFORMS[INDEX[ROUTE[step - 1][0]]];
      return prev.part ?? null;
    });

    // The beacon's fire in its brazier (lit later).
    this.caveFire = new Bonfire(this.v.brazier.clone().add(CAVE_ORIGIN).add(new Vector3(0, -0.15, 0)), {
      scale: 0.07,
      party: false,
      light: false,
    });
    for (const object of this.caveFire.objects) this.world.createTransformEntity(object, { persistent: true });
    fires.push(this.caveFire);
    this.caveFire.setVisible(false);

    this.cleanupFuncs.push(
      game.phase.subscribe((phase) => {
        if (phase === Phase.Cave && !this.inside && this.preroll < 0) {
          this.preroll = PREROLL;
          toast('The glider parts are somewhere in the old works inside this cave.', PREROLL + 1);
        }
      }),
      game.resetCount.subscribe(() => this.reset()),
      game.recentre.subscribe((n) => {
        if (n > 0 && this.inside) this.recentre();
      }),
    );
  }

  private reset(): void {
    if (this.inside) this.exit();
    this.preroll = -1;
    this.collected.clear();
    for (const id of Object.keys(this.v.parts) as GliderPartId[]) {
      this.v.parts[id].visible = true;
      this.v.partGlow[id].visible = true;
    }
    this.torchHand = null;
    this.v.torch.position.copy(this.v.torchHome);
    this.v.torch.quaternion.identity();
    this.v.torch.visible = true;
    this.v.beaconGlow.material.opacity = 0;
    this.v.shell.emissive.copy(ICE_GLOW);
    this.caveFire.setVisible(false);
    this.beaconTimer = -1;
    game.partsFound.value = 0;
    game.beaconLit.value = false;
  }

  /** Under the fade: hide the mountain, show the cave, stand on the jetty. */
  private enter(): void {
    this.inside = true;
    game.indoors = 1;
    this.v.root.visible = true;
    for (const light of this.v.lights) light.visible = true;
    if (sceneRefs.tutorialRoot) sceneRefs.tutorialRoot.object3D!.visible = false;
    if (sceneRefs.sunLight) sceneRefs.sunLight.visible = false;
    if (this.collected.size === 0) this.caveFire.setVisible(false);

    const rig = this.player;
    rig.rotation.set(0, 0, 0);
    rig.updateMatrixWorld(true);
    game.velocity.set(0, 0, 0);
    this.bars = 0;
    this.lastBeat = -1;
    this.tracked = START_INDEX;
    this.candidate = -1;
    this.candidateFrames = 0;
    this.slipped = -1;
    this.flow = 0;
    this.evaluate();
    // Put the head over the centre of the jetty's first square.
    getHeadWorld(this.world, this.head);
    this.off.set(rig.position.x - this.head.x, 0, rig.position.z - this.head.z);
    this.placeRig();
    if (game.phase.peek() !== Phase.Cave) setPhase(Phase.Cave);
    toast(this.world.renderer.xr.isPresenting ? 'Step onto decks with green lamps.' : 'W steps across when the lamps are green.', 5);
  }

  /** Put the head back on the centre of the square you're standing on. */
  private recentre(): void {
    const rig = this.states[this.tracked].anchor;
    getHeadWorld(this.world, this.head);
    const px = this.head.x - CAVE_ORIGIN.x - rig.x;
    const pz = this.head.z - CAVE_ORIGIN.z - rig.z;
    let best = PLATFORMS[this.tracked].claim[0];
    let bestD = Infinity;
    for (const sq of PLATFORMS[this.tracked].claim) {
      const o = sqOffset(sq);
      const d = (o.x - px) ** 2 + (o.z - pz) ** 2;
      if (d < bestD) {
        bestD = d;
        best = sq;
      }
    }
    const o = sqOffset(best);
    this.off.x += o.x - px;
    this.off.z += o.z - pz;
    this.placeRig();
    toast('Recentred on this deck.', 2);
  }

  private exit(): void {
    this.inside = false;
    game.indoors = 0;
    this.v.root.visible = false;
    this.v.marker.visible = false;
    for (const light of this.v.lights) light.visible = false;
    if (sceneRefs.tutorialRoot) sceneRefs.tutorialRoot.object3D!.visible = true;
    if (sceneRefs.sunLight) sceneRefs.sunLight.visible = true;
    this.caveFire.setVisible(false);
  }

  private evaluate(): void {
    for (let i = 0; i < PLATFORMS.length; i++) {
      const st = this.states[i];
      anchorAt(PLATFORMS[i], this.bars, st.anchor);
      dwellInfo(PLATFORMS[i], this.bars, this.dwell);
      st.wasMoving = st.moving;
      st.moving = this.dwell.moving;
      st.departIn = this.dwell.departIn;
      const part = this.lockPart[i];
      st.locked = part !== null && !this.collected.has(part);
    }
  }

  private placeRig(): void {
    const a = this.states[this.tracked].anchor;
    const rig = this.player;
    rig.position.set(CAVE_ORIGIN.x + a.x + this.off.x, CAVE_ORIGIN.y + a.y, CAVE_ORIGIN.z + a.z + this.off.z);
    rig.updateMatrixWorld(true);
  }

  update(delta: number, time: number): void {
    const dt = Math.min(delta, 0.1);
    if (this.preroll >= 0) {
      this.preroll -= dt;
      if (this.preroll < 0) fadeThen(() => this.enter());
      return;
    }
    if (!this.inside) return;
    const phase = game.phase.peek();
    if (phase !== Phase.Cave && phase !== Phase.Beacon) return;

    this.bars += dt / BAR_SEC;
    this.evaluate();
    this.placeRig();
    const rig = this.states[this.tracked].anchor;
    for (const st of this.states) {
      st.aligned =
        Math.hypot(st.anchor.x - rig.x, st.anchor.z - rig.z) < RIG.alignEps &&
        Math.abs(st.anchor.y - rig.y) < RIG.alignEpsY;
    }

    // Head in play-space coordinates, relative to the tracked anchor.
    getHeadWorld(this.world, this.head);
    this.p.set(this.head.x - CAVE_ORIGIN.x - rig.x, 0, this.head.z - CAVE_ORIGIN.z - rig.z);

    const used = this.updateBeacon(dt) || this.updateParts();
    if (!used) this.updateAssistStep();
    this.updateOwnership();
    this.updateBeats();
    if (this.slipFlash > 0) this.slipFlash = Math.max(0, this.slipFlash - dt);

    if (this.tracked === BEACON_INDEX && phase === Phase.Cave) setPhase(Phase.Beacon);
    this.updateVisuals(time);
  }

  // ------------------------------------------------------------ the frame ---

  private updateOwnership(): void {
    const rig = this.states[this.tracked].anchor;
    let owner = -1;
    let ownerDist = Infinity;
    for (let i = 0; i < PLATFORMS.length; i++) {
      const st = this.states[i];
      if (Math.abs(st.anchor.y - rig.y) > 1.2) continue; // a storey away is not ground
      const half = GRID.tile / 2 + (i === this.tracked ? RIG.trackedOutset : -RIG.tileInset);
      const ox = st.anchor.x - rig.x;
      const oz = st.anchor.z - rig.z;
      for (const sq of PLATFORMS[i].claim) {
        const o = sqOffset(sq);
        const dx = this.p.x - (ox + o.x);
        const dz = this.p.z - (oz + o.z);
        if (Math.abs(dx) > half || Math.abs(dz) > half) continue;
        if (i === this.tracked) {
          owner = i;
          ownerDist = -1;
        } else if (ownerDist >= 0 && dx * dx + dz * dz < ownerDist) {
          owner = i;
          ownerDist = dx * dx + dz * dz;
        }
      }
    }
    if (owner !== this.slipped) this.slipped = -1;
    if (owner === this.tracked || owner === -1) {
      this.candidate = -1;
      this.candidateFrames = 0;
      return;
    }
    if (owner === this.candidate) this.candidateFrames++;
    else {
      this.candidate = owner;
      this.candidateFrames = 1;
    }
    if (this.candidateFrames < 3) return;

    const cand = this.states[owner];
    if (cand.aligned && !cand.locked) {
      this.handover(owner);
      return;
    }
    if (cand.locked) return;
    // Unaligned ground underfoot: arriving (wait for it) or leaving (a slip)?
    const now = Math.hypot(cand.anchor.x - rig.x, cand.anchor.z - rig.z) + Math.abs(cand.anchor.y - rig.y);
    anchorAt(PLATFORMS[owner], this.bars + 0.25, this.look);
    anchorAt(PLATFORMS[this.tracked], this.bars + 0.25, this.lookRig);
    const soon =
      Math.hypot(this.look.x - this.lookRig.x, this.look.z - this.lookRig.z) + Math.abs(this.look.y - this.lookRig.y);
    if (soon < now) return;
    if (this.slipped !== owner) {
      this.slipped = owner;
      this.flow = 0;
      this.slipAt = owner;
      this.slipFlash = SLIP_FLASH;
      audio.thud();
    }
  }

  private handover(to: number): void {
    this.tracked = to;
    this.flow++;
    this.candidate = -1;
    this.candidateFrames = 0;
    audio.marimba(this.flow);
  }

  /** The next route step's deck docked here, if any, and the square to step onto. */
  private nextDeck(): { index: number; sq: readonly [number, number] } | null {
    const step = ROUTE_STEP[this.tracked];
    if (step < 0 || step + 1 >= ROUTE.length) return null;
    const boarding = BOARDINGS[step + 1];
    if (!boarding) return null;
    for (const id of ROUTE[step + 1]) {
      const i = INDEX[id];
      const st = this.states[i];
      if (st.aligned && !st.moving && !st.locked && st.departIn > 0.15) return { index: i, sq: boarding.to };
    }
    return null;
  }

  /** Reach-and-grab or W: be carried one square onto the next deck. */
  private updateAssistStep(): void {
    const xr = this.world.renderer.xr.isPresenting;
    const keyboard = this.input.keyboard;
    const pressed = !xr && (keyboard.getKeyDown('KeyW') || keyboard.getKeyDown('ArrowUp'));
    let reached = false;
    const next = this.nextDeck();
    if (xr && next) {
      const st = this.states[next.index];
      const o = sqOffset(next.sq);
      const tx = CAVE_ORIGIN.x + st.anchor.x + o.x;
      const tz = CAVE_ORIGIN.z + st.anchor.z + o.z;
      const ty = CAVE_ORIGIN.y + st.anchor.y;
      for (const hand of HANDS) {
        if (!hand.gripDown) continue;
        const h = hand.position;
        if (Math.hypot(h.x - tx, h.z - tz) < 0.46 && h.y > ty + 0.15 && h.y < ty + 1.8) reached = true;
      }
    }
    if (!pressed && !reached) return;
    if (!next) {
      const now = performance.now() / 1000;
      if (pressed && now > this.waitHintAt) {
        this.waitHintAt = now + 2.5;
        const st = this.states[this.tracked];
        toast(st.locked || this.partHere() ? 'Take the part first (E).' : 'Wait for green lamps on the next deck.', 2.4);
      }
      return;
    }
    const rig = this.states[this.tracked].anchor;
    const st = this.states[next.index];
    const o = sqOffset(next.sq);
    this.off.x += st.anchor.x - rig.x + o.x - this.p.x;
    this.off.z += st.anchor.z - rig.z + o.z - this.p.z;
    this.handover(next.index);
    this.placeRig();
  }

  // ------------------------------------------------------------ the parts ---

  private partHere(): GliderPartId | null {
    const part = PLATFORMS[this.tracked].part;
    return part && !this.collected.has(part) ? part : null;
  }

  private updateParts(): boolean {
    const part = this.partHere();
    if (!part) return false;
    const holder = this.v.parts[part];
    let take = false;
    if (this.world.renderer.xr.isPresenting) {
      // Anywhere on the part counts, and a hand that is already closed takes
      // it as it reaches in: no need to time the grab.
      const bounds = this.partBounds.get(part)!;
      for (const hand of HANDS) {
        if (!hand.tracked || !hand.grip) continue;
        if (bounds.distanceToPoint(hand.position) < PART_REACH) take = true;
      }
    } else {
      const k = this.input.keyboard;
      take = k.getKeyDown('KeyE') || k.getKeyDown('KeyW') || k.getKeyDown('ArrowUp');
    }
    if (!take) return false;
    this.collected.add(part);
    holder.visible = false;
    this.v.partGlow[part].visible = false;
    // Into the pack it goes, to come out again on top for the build.
    addToPack(PART_ITEM[part]);
    game.partsFound.value = this.collected.size;
    audio.chime();
    audio.zip();
    toast(`${PART_LABEL[part]} into your pack: ${this.collected.size} of 3`, 3.5);
    return true;
  }

  // ----------------------------------------------------------- the beacon ---

  private updateBeacon(dt: number): boolean {
    if (this.tracked !== BEACON_INDEX && this.torchHand === null) return false;
    if (game.beaconLit.peek()) {
      if (this.beaconTimer >= 0) {
        this.beaconTimer += dt;
        // Firelight on the ice: the walls warm as the beacon takes.
        this.v.shell.emissive.copy(ICE_GLOW).lerp(FIRE_GLOW, Math.min(1, this.beaconTimer / 2));
        this.v.beaconGlow.material.opacity = Math.min(0.85, this.beaconTimer);
        if (this.beaconTimer > BEACON_HOLD) {
          this.beaconTimer = -1;
          fadeThen(() => this.arriveOnTop());
        }
      }
      return false;
    }
    const torch = this.v.torch;
    if (!this.world.renderer.xr.isPresenting) {
      const k = this.input.keyboard;
      if (k.getKeyDown('KeyE') || k.getKeyDown('KeyW') || k.getKeyDown('ArrowUp')) {
        this.light();
        return true;
      }
      return false;
    }
    torch.getWorldPosition(this.m);
    if (this.torchHand === null) {
      for (const hand of HANDS) {
        if (hand.gripDown && hand.position.distanceTo(this.m) < TAKE_RADIUS) {
          this.torchHand = hand.handedness;
          audio.clack();
          return true;
        }
      }
      return false;
    }
    const hand = HANDS.find((h) => h.handedness === this.torchHand)!;
    if (!hand.tracked || !hand.grip) {
      this.torchHand = null;
      torch.position.copy(this.v.torchHome);
      torch.quaternion.identity();
      return false;
    }
    // Held upright in the fist; its head is what lights the beacon.
    torch.position.copy(hand.position).sub(CAVE_ORIGIN);
    torch.quaternion.identity();
    this.n.set(0, 0.32, 0).add(torch.position);
    if (this.n.distanceTo(this.v.brazier) < LIGHT_RADIUS) this.light();
    return true;
  }

  /** Under the fade: out of the chimney onto the beacon deck, facing the kit. */
  private arriveOnTop(): void {
    this.exit();
    const rig = this.player;
    rig.rotation.set(0, 0, 0);
    rig.updateMatrixWorld(true);
    faceYaw(this.world, 0);
    placeHeadAt(this.world, BUILD_STAND.x, BUILD_STAND.z, BUILD_STAND.y);
    game.velocity.set(0, 0, 0);
    setPhase(Phase.Building);
    toast('Out on top! Take the glider parts from your pack and fit them to the frame.', 5);
  }

  private light(): void {
    if (game.beaconLit.peek()) return;
    game.beaconLit.value = true;
    this.torchHand = null;
    this.v.torch.position.copy(this.v.torchHome);
    this.v.torch.quaternion.identity();
    this.caveFire.setVisible(true);
    this.beaconTimer = 0;
    audio.ignite();
    audio.fanfare();
    toast('The beacon is lit. The party below can see you coming!', BEACON_HOLD);
  }

  // --------------------------------------------------------------- sounds ---

  private updateBeats(): void {
    const beat = Math.floor(this.bars * 4);
    const next = this.nextCandidate();
    for (const i of [this.tracked, next]) {
      if (i < 0) continue;
      const st = this.states[i];
      if (st.moving && !st.wasMoving) audio.clunk(i === this.tracked ? 1 : 0.6);
    }
    if (beat === this.lastBeat) return;
    this.lastBeat = beat;
    for (const i of [this.tracked, next]) {
      if (i < 0) continue;
      const st = this.states[i];
      if (!st.moving && !st.locked && st.departIn <= 1 && st.aligned) {
        audio.tock(Math.ceil(st.departIn * 4));
        break;
      }
    }
  }

  /** The next route step's platform nearest to docking here (for sound and marker). */
  private nextCandidate(): number {
    const step = ROUTE_STEP[this.tracked];
    if (step < 0 || step + 1 >= ROUTE.length) return -1;
    let best = -1;
    let bestD = Infinity;
    const rig = this.states[this.tracked].anchor;
    for (const id of ROUTE[step + 1]) {
      const i = INDEX[id];
      const a = this.states[i].anchor;
      const d = Math.hypot(a.x - rig.x, a.y - rig.y, a.z - rig.z);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  // -------------------------------------------------------------- visuals ---

  private updateVisuals(time: number): void {
    const v = this.v;
    const beatPhase = (this.bars * 4) % 1;
    const pulse = 0.75 + 0.25 * Math.cos(beatPhase * Math.PI * 2);
    let deck = 0;
    const mat = this.matrix;
    for (let i = 0; i < PLATFORMS.length; i++) {
      const spec = PLATFORMS[i];
      const st = this.states[i];
      const pv = v.platforms[i];
      pv.group.position.set(st.anchor.x, st.anchor.y, st.anchor.z);
      const burn = this.slipAt === i ? this.slipFlash / SLIP_FLASH : 0;
      // Signal colour for machines.
      let lit = 4;
      let lampColor = LAMP.off;
      if (spec.kind !== 'station') {
        if (st.locked) lampColor = LAMP.stopDim;
        else if (st.moving) lampColor = LAMP.stop;
        else if (st.departIn <= 1) {
          lampColor = LAMP.warn;
          lit = Math.ceil(st.departIn * 4);
        } else lampColor = st.aligned ? LAMP.go : LAMP.goDim;
      }
      for (let t = 0; t < spec.claim.length; t++) {
        const o = sqOffset(spec.claim[t]);
        const x = st.anchor.x + o.x;
        const y = st.anchor.y;
        const z = st.anchor.z + o.z;
        mat.makeTranslation(x, y - 0.04, z);
        v.decks.setMatrixAt(deck, mat);
        this.color.setRGB(1, 1, 1);
        if (burn > 0) this.color.lerp(LAMP.stop, burn * 0.7);
        v.decks.setColorAt(deck, this.color);
        deck++;
        if (pv.lampFirst < 0) continue;
        for (let k = 0; k < 4; k++) {
          const [cx, cz] = TILE_CORNERS[k];
          mat.makeTranslation(x + cx * (TILE_HALF - 0.04), y + 0.03, z + cz * (TILE_HALF - 0.04));
          const idx = pv.lampFirst + t * 4 + k;
          v.lamps.setMatrixAt(idx, mat);
          this.color.copy(k < lit ? lampColor : LAMP.off);
          if (lampColor === LAMP.go) this.color.multiplyScalar(pulse);
          v.lamps.setColorAt(idx, this.color);
          // Inlaid edge strip, one per side.
          const edge = TILE_EDGES[k];
          const d = EDGE_DIR[edge];
          const along = d[0] === 0;
          mat.makeScale(along ? 0.46 : 0.025, 0.012, along ? 0.025 : 0.46);
          mat.setPosition(x + d[0] * (TILE_HALF - 0.035), y + 0.002, z + d[1] * (TILE_HALF - 0.035));
          v.strips.setMatrixAt(idx, mat);
          this.color.copy(lampColor).multiplyScalar(lampColor === LAMP.off ? 1 : 0.55);
          if (burn > 0) this.color.lerp(LAMP.stop, burn);
          v.strips.setColorAt(idx, this.color);
        }
      }
    }
    v.decks.instanceMatrix.needsUpdate = true;
    if (v.decks.instanceColor) v.decks.instanceColor.needsUpdate = true;
    v.lamps.instanceMatrix.needsUpdate = true;
    if (v.lamps.instanceColor) v.lamps.instanceColor.needsUpdate = true;
    v.strips.instanceMatrix.needsUpdate = true;
    if (v.strips.instanceColor) v.strips.instanceColor.needsUpdate = true;

    // Ropes follow their machines.
    for (let r = 0; r < v.ropeSpecs.length; r++) {
      const rope = v.ropeSpecs[r];
      if (rope.platform >= 0) {
        const a = this.states[rope.platform].anchor;
        this.m.set(a.x + rope.local.x, a.y + rope.local.y, a.z + rope.local.z);
      } else this.m.copy(rope.local);
      setRope(v.ropes, r, this.m, rope.far);
    }
    v.ropes.instanceMatrix.needsUpdate = true;

    v.wheel.rotation.x = (-wheelTurns(this.bars) * Math.PI) / 2;

    // Marker on the deck to step onto next.
    const next = this.nextDeck();
    v.marker.visible = !!next;
    if (next) {
      const st = this.states[next.index];
      const o = sqOffset(next.sq);
      v.marker.position.set(st.anchor.x + o.x, st.anchor.y + 0.035, st.anchor.z + o.z);
      v.marker.scale.setScalar(0.85 + 0.15 * pulse);
    }

    // Parts still on their racks pulse; the one waiting for you most of all.
    const part = this.partHere();
    const beat = 0.5 + 0.5 * Math.sin(time * 4);
    for (const id of Object.keys(v.partGlow) as GliderPartId[]) {
      const here = id === part;
      v.partGlow[id].material.opacity = here ? 0.5 + 0.45 * beat : 0.3 + 0.2 * beat;
      v.partGlow[id].scale.setScalar(here ? 1.1 + 0.5 * beat : 1.1);
      v.parts[id].scale.setScalar(1 + (here ? 0.1 : 0.04) * beat);
    }
    v.torchFlame.visible = !game.beaconLit.peek();

    const shaft = v.shaft.material as { opacity: number };
    shaft.opacity = 0.07 + 0.02 * Math.sin(time * 0.6);
  }
}
