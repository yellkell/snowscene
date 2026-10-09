/**
 * The fixed-rope traverse along the exposed night ledge.
 *
 * 1. The walk gate holds you just before the rope until you clip in: take
 *    the carabiner out of your pack and touch it to the rope (within
 *    ~10 cm). Snap! The gate opens.
 * 2. Clipped, a sling runs from your harness to the carabiner, which slides
 *    along the rope with you. Close a free hand on the rope and pull: you
 *    glide along it hand over hand (the grabbed point stays locked to your
 *    hand along the rope). Poles still work in the other hand.
 * 3. Every ~12 m the clip stops at an anchor. Reach past the anchor and grab
 *    the next span: the clip hops across with a clack. (Hand over hand you
 *    do this without thinking; walking with a pole you stop and reach.)
 * 4. Gusts sweep the ledge. Hold the rope and they can't touch you; clipped
 *    but hands-off, the sling catches you short of the drop; unclipped (at
 *    the gate) they shove you toward the edge, and stepping off it is a
 *    fall.
 * 5. At the last anchor you unclip automatically; the carabiner goes back
 *    in the pack and your poles come back to hand.
 *
 * Desktop: W walks; C clips in near the start (and hops an anchor); the
 * clip also hops anchors by itself while you hold W; Shift braces against
 * gusts.
 *
 * Priority 9 (before PoleSystem = 10): rope pulls and gusts move the rig,
 * then the pole system applies the level's walk constraint (which clamps
 * progress to `walkGate.blockS`) and glues the feet to the ground.
 */

import { createSystem, Group, Mesh, MeshStandardMaterial, Quaternion, Vector3 } from '@iwsdk/core';
import { audio } from '../../audio.js';
import { consume, equipment, equipPair, holding, handsFree, packCount } from '../../equipment.js';
import { HANDS, hands, type Handedness, type HandState } from '../../hand-input.js';
import { getHeadWorld } from '../../rig.js';
import { sceneRefs } from '../../scene-system.js';
import { game, Phase } from '../../state.js';
import { project, type Projection } from '../exp-route.js';
import { exp, expFrame, expHooks, expRefs } from '../exp-state.js';
import { expeditionHeight } from '../exp-terrain.js';
import { LineGrip } from './line-grip.js';
import { mechanics } from './mechanics-state.js';
import {
  buildGrabHint,
  buildRope,
  buildRopeClip,
  buildSlingSegment,
  mechanicsVisuals,
  slingMaterial,
} from './mech-visuals.js';
import { mechAudio } from './mech-audio.js';
import { pulse, say } from './mech-util.js';
import {
  nearestOnRope,
  ROPE_FIRST_S,
  ROPE_LAST_S,
  ropeData,
  ropePointAt,
  ropeSpanAt,
  type RopeHit,
} from './rope-geometry.js';
import {
  ANCHOR_AUTO_PASS,
  ANCHOR_OVERRUN,
  ANCHOR_PASS_MARGIN,
  ANCHOR_REASON_DESKTOP,
  ANCHOR_REASON_XR,
  CLIP_RADIUS,
  CLIPPED_MAX_OUT,
  GATE_REASON_DESKTOP,
  GATE_REASON_XR,
  GRAB_RADIUS,
  HARNESS_DROP,
  ROPE_GATE_S,
  SLING_LENGTH,
} from './rope-rules.js';
import { openWalkGate, walkGate } from './walk-gate.js';

/** Carabiner sits on the thumb side of the grip (held model's gate is at -Z). */
const CARABINER_OFFSET = new Vector3(0, 0, -0.02);
/** Free hands show a grab hint within this distance of the rope. */
const HINT_RADIUS = 0.32;
/** Gusts blow on this stretch (arc length). */
const GUST_START_S = ROPE_GATE_S - 30;
const GUST_END_S = ROPE_LAST_S + 15;
const GUST_WARN = 0.7;
const GUST_PUSH = 1.5;
/** Peak outward shove of a full-strength gust (m/s). */
const GUST_SPEED = 0.42;
/** Unclipped, the head over ground this far below the path means you fell. */
const FALL_DROP = 2.0;
/** Momentum kept when you let go of the rope mid-pull. */
const PULL_CARRY = 0.6;

type GustPhase = 'calm' | 'warn' | 'push';

const Y_AXIS = new Vector3(0, 1, 0);
const Z_AXIS = new Vector3(0, 0, 1);

export class RopeSystem extends createSystem({}) {
  private readonly grip = new LineGrip();
  private readonly head = new Vector3();
  private readonly prevHead = new Vector3();
  private prevHeadValid = false;
  private readonly proj: Projection = { s: 0, d: 0, dist: Infinity, elev: 0 };
  private readonly hit: RopeHit = { dist: Infinity, u: 0, x: 0, y: 0, z: 0, tx: 0, tz: 1 };
  private readonly tmp = new Vector3();
  private readonly tmpB = new Vector3();
  private readonly tmpC = new Vector3();
  private readonly quat = new Quaternion();
  private readonly clipPos = { x: 0, y: 0, z: 0 };

  /** Sign of route `d` on the outward (drop) side of the ledge. */
  private outward = 1;

  // clip state
  private clipped = false;
  private carabinerTaken = false;
  private span = 0;
  private clipU = 0;
  private stuckFor = 0;
  private anchorHints = 0;
  private slingTaut = false;
  private wasHolding = false;
  private clipToastShown = false;
  private gateToastShown = false;

  // gusts
  private gustPhase: GustPhase = 'calm';
  private gustTimer = 4;
  private gustT = 0;
  private gustStrength = 0;
  private gustWarned = false;
  private bracePraised = false;

  private fallCooldown = 0;

  // visuals (created lazily once expRefs.root exists)
  private group: Group | null = null;
  private ropeMaterial: MeshStandardMaterial | null = null;
  private sling: [Mesh, Mesh] | null = null;
  private clip: Group | null = null;
  private hints: Record<Handedness, Mesh> | null = null;

  init(): void {
    const r = ropeData();
    this.outward = -r.side[Math.floor(r.count / 2)];
    this.cleanupFuncs.push(
      exp.active.subscribe((active) => {
        if (!active) this.reset(false);
      }),
      game.phase.subscribe((phase) => {
        if (phase !== Phase.Poling) this.grip.releaseAll();
      }),
    );
  }

  // ----------------------------------------------------------- visuals ----

  private ensureVisuals(): void {
    if (this.group || !expRefs.root) return;
    const group = new Group();
    group.name = 'FixedRopeMechanics';
    if (mechanicsVisuals.rope) {
      const { rope, stakes, material } = buildRope();
      group.add(rope, stakes);
      this.ropeMaterial = material;
    }
    const mat = slingMaterial();
    this.sling = [buildSlingSegment(mat), buildSlingSegment(mat)];
    this.clip = buildRopeClip();
    this.hints = { left: buildGrabHint(), right: buildGrabHint() };
    group.add(this.sling[0], this.sling[1], this.clip, this.hints.left, this.hints.right);
    group.visible = false;
    this.world.createTransformEntity(group, { parent: expRefs.root });
    this.group = group;
  }

  // ------------------------------------------------------------ update ----

  update(delta: number, time: number): void {
    const dt = Math.max(1e-3, Math.min(delta, 0.1));
    if (!exp.active.peek()) return;
    this.ensureVisuals();
    getHeadWorld(this.world, this.head);
    project(this.head.x, this.head.z, this.proj);
    const s = this.proj.s;
    const nearRoute = this.proj.dist < 25;

    // Teleported (respawn, checkpoint, restart)?
    if (this.prevHeadValid) {
      const jump = Math.hypot(this.head.x - this.prevHead.x, this.head.z - this.prevHead.z);
      if (jump > 6) this.onTeleport(s, nearRoute);
    }
    this.prevHead.copy(this.head);
    this.prevHeadValid = true;
    this.fallCooldown = Math.max(0, this.fallCooldown - dt);

    const visibleRange = nearRoute && s > ROPE_FIRST_S - 150 && s < ROPE_LAST_S + 150;
    if (this.group) this.group.visible = visibleRange;

    const inZone = nearRoute && s > ROPE_FIRST_S - 60 && s < ROPE_LAST_S + 30;
    if (!inZone || game.phase.peek() !== Phase.Poling) {
      if (!inZone && this.clipped) this.unclip(true, true);
      this.grip.releaseAll();
      this.wasHolding = false;
      this.hideHints();
      if (!inZone) {
        openWalkGate();
        this.gustPhase = 'calm';
      }
      return;
    }

    const presenting = this.world.renderer.xr.isPresenting;
    const kb = this.input.keyboard;
    const r = ropeData();

    // ---- hands: clip, grab, release --------------------------------------
    for (const hand of HANDS) this.grip.trackFist(hand, dt);
    this.grip.grabbedNow = null;
    if (presenting) {
      this.grip.releaseOpen(hands.left, hands.right);
      this.updateHand(hands.left);
      this.updateHand(hands.right);
    } else {
      this.grip.releaseAll();
      if (kb.getKeyDown('KeyC')) {
        if (!this.clipped && s > ROPE_FIRST_S - 8 && s < ROPE_GATE_S + 2) this.clipIn(null, Math.max(s, ROPE_FIRST_S + 0.3));
        else if (this.clipped && this.atAnchor(s)) this.passAnchor(null);
      }
    }

    // ---- clip progress along the rope -----------------------------------
    if (this.clipped) this.updateClipProgress(s, dt, presenting);

    // ---- walk gate ---------------------------------------------------------
    if (this.clipped) {
      const last = r.anchorS.length - 1;
      if (this.span + 1 >= last) {
        walkGate.blockS = Infinity;
        walkGate.reason = '';
      } else {
        walkGate.blockS = r.anchorS[this.span + 1] + ANCHOR_OVERRUN;
        walkGate.reason = presenting ? ANCHOR_REASON_XR : ANCHOR_REASON_DESKTOP;
      }
    } else if (s < ROPE_GATE_S + 2) {
      walkGate.blockS = ROPE_GATE_S;
      walkGate.reason = presenting ? GATE_REASON_XR : GATE_REASON_DESKTOP;
      if (!this.gateToastShown && s > ROPE_GATE_S - 25) {
        this.gateToastShown = true;
        say(
          presenting
            ? 'Exposed ledge ahead. Clip in: open your pack (palm up), take the carabiner and touch it to the rope'
            : 'Exposed ledge ahead. Press C at the rope to clip in',
          7,
        );
      }
    } else {
      openWalkGate();
    }

    // ---- pull along the rope ----------------------------------------------
    const active = this.grip.active;
    if (active) {
      const hand = hands[active];
      const i = this.ropeIndex(this.grip.hands[active].u);
      this.grip.pull(hand, this.player, r.tx[i], r.tz[i], dt);
      // The rope is the only thing moving you while you hold it.
      game.velocity.x = 0;
      game.velocity.z = 0;
      this.wasHolding = true;
    } else {
      if (this.wasHolding) {
        const i = this.ropeIndex(s);
        game.velocity.x = r.tx[i] * this.grip.speed * PULL_CARRY;
        game.velocity.z = r.tz[i] * this.grip.speed * PULL_CARRY;
        this.wasHolding = false;
      }
      this.grip.coast(dt);
    }

    // ---- wind and the drop -------------------------------------------------
    const braced = this.isBraced(presenting);
    this.updateGusts(s, dt, braced, presenting);
    this.keepOnLedge(s);

    // ---- visuals -------------------------------------------------------------
    this.updateSling();
    if (this.ropeMaterial) {
      const waiting = !this.clipped && s > ROPE_GATE_S - 10 && s < ROPE_GATE_S + 2;
      const lure = waiting && (holding('left', 'carabiner') || holding('right', 'carabiner') || !presenting);
      this.ropeMaterial.emissiveIntensity = lure ? 0.35 + 0.25 * Math.sin(time * 4) : 0.12;
    }
  }

  // ------------------------------------------------------------- hands ----

  private updateHand(hand: HandState): void {
    const side = hand.handedness;
    const hint = this.hints?.[side];
    if (!hand.tracked) {
      if (hint) hint.visible = false;
      return;
    }
    // Carabiner in hand: touch it to the rope to clip in.
    if (holding(side, 'carabiner')) {
      if (hint) hint.visible = false;
      if (this.clipped) return;
      this.tmp.copy(CARABINER_OFFSET).applyQuaternion(hand.quaternion).add(hand.position);
      nearestOnRope(this.tmp.x, this.tmp.y, this.tmp.z, this.hit);
      if (this.hit.dist < CLIP_RADIUS) this.clipIn(side, this.hit.u);
      else if (this.hit.dist < HINT_RADIUS && hint) this.showHint(hint, this.hit, 1 - this.hit.dist / HINT_RADIUS);
      return;
    }
    const g = this.grip.hands[side];
    if (g.held) {
      if (hint) {
        ropePointAt(g.u, this.clipPos);
        this.hit.x = this.clipPos.x;
        this.hit.y = this.clipPos.y;
        this.hit.z = this.clipPos.z;
        const i = this.ropeIndex(g.u);
        this.hit.tx = ropeData().tx[i];
        this.hit.tz = ropeData().tz[i];
        this.showHint(hint, this.hit, 1.3);
      }
      return;
    }
    // Only a free hand closes on the rope (a pole hand would also plant).
    if (!handsFree(side)) {
      if (hint) hint.visible = false;
      return;
    }
    nearestOnRope(hand.position.x, hand.position.y, hand.position.z, this.hit);
    if (this.hit.dist < GRAB_RADIUS && this.grip.canGrab(hand)) {
      this.grip.grab(hand, this.hit.u);
      mechAudio.tug(0.35);
      pulse(this.input.xr.gamepads, side, 0.3, 25);
      // No carabiner at all (lost somehow)? A firm grip at the start clips you in.
      if (!this.clipped && !this.hasCarabiner() && this.hit.u < ROPE_GATE_S + 2) this.clipIn(null, this.hit.u);
      // Grabbing past the anchor that holds the clip moves it across.
      if (this.clipped) this.maybePassOnGrab(side);
    }
    if (hint) {
      if (this.hit.dist < HINT_RADIUS && !g.held) this.showHint(hint, this.hit, 1 - this.hit.dist / HINT_RADIUS);
      else hint.visible = g.held;
    }
  }

  private showHint(hint: Mesh, at: RopeHit, strength: number): void {
    hint.visible = true;
    hint.position.set(at.x, at.y, at.z);
    // ring around the rope: its axis along the rope
    this.tmp.set(at.tx, 0, at.tz);
    hint.quaternion.setFromUnitVectors(Z_AXIS, this.tmp);
    hint.scale.setScalar(0.8 + 0.6 * Math.min(1.3, Math.max(0, strength)));
  }

  private hideHints(): void {
    if (!this.hints) return;
    this.hints.left.visible = false;
    this.hints.right.visible = false;
  }

  private hasCarabiner(): boolean {
    return packCount('carabiner') > 0 || holding('left', 'carabiner') || holding('right', 'carabiner');
  }

  private ropeIndex(u: number): number {
    const r = ropeData();
    const i = Math.round((u - r.s0) / r.h);
    return i < 0 ? 0 : i >= r.count ? r.count - 1 : i;
  }

  // -------------------------------------------------------------- clip ----

  private clipIn(side: Handedness | null, u: number): void {
    const r = ropeData();
    this.carabinerTaken = false;
    if (side && holding(side, 'carabiner')) {
      consume(side);
      this.carabinerTaken = true;
    } else {
      // Desktop / fallback: use the one in a hand or the pack if there is one.
      const inHand: Handedness | null = holding('right', 'carabiner')
        ? 'right'
        : holding('left', 'carabiner')
          ? 'left'
          : null;
      if (inHand) {
        consume(inHand);
        this.carabinerTaken = true;
      } else if (packCount('carabiner') > 0) {
        const n = packCount('carabiner') - 1;
        if (n > 0) equipment.pack.set('carabiner', n);
        else equipment.pack.delete('carabiner');
        equipment.version.value = equipment.version.peek() + 1;
        this.carabinerTaken = true;
      }
    }
    this.clipped = true;
    this.span = ropeSpanAt(u);
    this.clipU = Math.min(r.anchorS[this.span + 1] - 0.08, Math.max(r.anchorS[this.span] + 0.08, u));
    this.stuckFor = 0;
    this.slingTaut = false;
    if (!exp.ropeClipped.peek()) exp.ropeClipped.value = true;
    if (!equipment.clipped.peek()) equipment.clipped.value = true;
    mechAudio.snap();
    audio.zip();
    if (side) pulse(this.input.xr.gamepads, side, 0.7, 60);
    if (!this.clipToastShown) {
      this.clipToastShown = true;
      say(
        this.world.renderer.xr.isPresenting
          ? 'Clipped in! Close your free hand on the rope and pull yourself along. Reach past each anchor to move your clip'
          : 'Clipped in! Walk on (W); the clip hops each anchor',
        7,
      );
    }
  }

  /** Remove the clip; optionally put the carabiner back in the pack. */
  private unclip(stow: boolean, silent: boolean): void {
    if (!this.clipped) return;
    this.clipped = false;
    if (exp.ropeClipped.peek()) exp.ropeClipped.value = false;
    if (equipment.clipped.peek()) equipment.clipped.value = false;
    if (stow && this.carabinerTaken) {
      equipment.pack.set('carabiner', packCount('carabiner') + 1);
      equipment.version.value = equipment.version.peek() + 1;
    }
    this.carabinerTaken = false;
    if (this.sling) {
      this.sling[0].visible = false;
      this.sling[1].visible = false;
    }
    if (this.clip) this.clip.visible = false;
    if (!silent) {
      mechAudio.snap();
      audio.zip();
    }
  }

  private finish(): void {
    this.unclip(true, false);
    openWalkGate();
    this.grip.releaseAll();
    // Poles back in hand if your hands are free for them.
    const l = equipment.inHand.left;
    const r = equipment.inHand.right;
    const free = (l === null || l === 'poles') && (r === null || r === 'poles');
    const havePoles = packCount('poles') > 0 || l === 'poles' || r === 'poles';
    if (free && havePoles && !(l === 'poles' && r === 'poles')) equipPair('poles');
    say('Off the ledge. Unclipped: carabiner back in your pack', 5);
  }

  private atAnchor(s: number): boolean {
    const r = ropeData();
    return this.span + 1 < r.anchorS.length - 1 && s >= r.anchorS[this.span + 1] + ANCHOR_OVERRUN - 0.25;
  }

  private maybePassOnGrab(side: Handedness): void {
    const r = ropeData();
    const next = this.span + 1;
    if (next >= r.anchorS.length - 1) return;
    if (this.grip.hands[side].u > r.anchorS[next] + ANCHOR_PASS_MARGIN) this.passAnchor(side);
  }

  private passAnchor(side: Handedness | null): void {
    const r = ropeData();
    if (this.span + 1 >= r.anchorS.length - 1) return;
    this.span++;
    this.clipU = r.anchorS[this.span] + 0.1;
    this.stuckFor = 0;
    this.slingTaut = false;
    mechAudio.anchorPass();
    if (side) pulse(this.input.xr.gamepads, side, 0.5, 40);
  }

  private updateClipProgress(s: number, dt: number, presenting: boolean): void {
    const r = ropeData();
    const last = r.anchorS.length - 1;
    // Any held hand already beyond the blocking anchor moves the clip on
    // (e.g. you grabbed far ahead before the clip caught up).
    if (presenting) {
      for (const hand of HANDS) {
        const g = this.grip.hands[hand.handedness];
        if (g.held && this.span + 1 < last && g.u > r.anchorS[this.span + 1] + ANCHOR_PASS_MARGIN) {
          this.passAnchor(hand.handedness);
        }
      }
    }
    // Walked back past the anchor behind you: the clip follows.
    if (this.span > 0 && s < r.anchorS[this.span] - 0.5) {
      this.span--;
      mechAudio.anchorPass();
    }
    // Backed right off the start of the rope: unclip.
    if (s < ROPE_FIRST_S - 6) {
      this.unclip(true, false);
      say('Unclipped from the rope', 3);
      return;
    }
    // The end.
    if (this.span + 1 >= last && s >= ROPE_LAST_S - 0.6) {
      this.finish();
      return;
    }
    // Stopped at an anchor?
    if (this.atAnchor(s)) {
      this.stuckFor += dt;
      const kb = this.input.keyboard;
      const walking = !presenting && (kb.getKeyPressed('KeyW') || kb.getKeyPressed('ArrowUp'));
      if (walking && this.stuckFor > 0.4) this.passAnchor(null);
      else if (this.stuckFor > ANCHOR_AUTO_PASS) this.passAnchor(null);
      else if (presenting) {
        const before = this.stuckFor - dt;
        const first = before < 1.2 && this.stuckFor >= 1.2 && this.anchorHints < 3;
        const again = before < 5 && this.stuckFor >= 5;
        if (first || again) {
          this.anchorHints++;
          say('Anchor: reach forward and grab the rope beyond it to move your clip across', 4);
        }
      }
    } else {
      this.stuckFor = 0;
    }
    // Slide the clip along with you, stopping at the anchors.
    const lo = r.anchorS[this.span] + 0.08;
    const hi = r.anchorS[Math.min(last, this.span + 1)] - 0.08;
    const target = Math.min(hi, Math.max(lo, s - 0.1));
    this.clipU += (target - this.clipU) * (1 - Math.exp(-10 * dt));
    if (this.clipU < lo) this.clipU = lo;
    if (this.clipU > hi) this.clipU = hi;
  }

  // ------------------------------------------------------- wind / ledge ----

  /** Holding the rope (or any fist on it, poles included), or Shift on desktop. */
  private isBraced(presenting: boolean): boolean {
    if (!presenting) {
      const kb = this.input.keyboard;
      return kb.getKeyPressed('ShiftLeft') || kb.getKeyPressed('ShiftRight');
    }
    if (this.grip.holding) return true;
    for (const hand of HANDS) {
      if (!hand.tracked || !hand.grip) continue;
      nearestOnRope(hand.position.x, hand.position.y, hand.position.z, this.hit);
      if (this.hit.dist < GRAB_RADIUS * 1.3) return true;
    }
    return false;
  }

  private updateGusts(s: number, dt: number, braced: boolean, presenting: boolean): void {
    if (s < GUST_START_S || s > GUST_END_S) {
      this.gustPhase = 'calm';
      return;
    }
    this.gustTimer -= dt;
    if (this.gustPhase === 'calm') {
      if (this.gustTimer <= 0) {
        this.gustPhase = 'warn';
        this.gustT = 0;
        this.gustStrength = 0.35 + 0.65 * Math.min(1, Math.max(0, expFrame.storm));
        mechAudio.gust(this.gustStrength);
        if (!this.gustWarned) {
          this.gustWarned = true;
          say(presenting ? 'Wind! Grab the rope to brace yourself' : 'Wind! Hold Shift to brace yourself', 3.5);
        }
      }
      return;
    }
    this.gustT += dt;
    if (this.gustPhase === 'warn') {
      if (this.gustT >= GUST_WARN) {
        this.gustPhase = 'push';
        this.gustT = 0;
        if (braced && !this.bracePraised) {
          this.bracePraised = true;
          say('Good: holding the rope, the wind can\'t move you', 3);
        }
      }
      return;
    }
    // push
    const k = this.gustT / GUST_PUSH;
    if (k >= 1) {
      this.gustPhase = 'calm';
      this.gustTimer = 7 + Math.random() * 6;
      return;
    }
    if (braced) return;
    const speed = GUST_SPEED * this.gustStrength * Math.sin(Math.PI * k);
    const r = ropeData();
    const i = this.ropeIndex(s);
    // outward = the left normal times the outward sign
    const nx = r.tz[i] * this.outward;
    const nz = -r.tx[i] * this.outward;
    this.player.position.x += nx * speed * dt;
    this.player.position.z += nz * speed * dt;
    if (Math.random() < dt * 6 && sceneRefs.puffs) {
      this.tmp.set(this.head.x + nx * 0.6, this.head.y - 1.2, this.head.z + nz * 0.6);
      sceneRefs.puffs.emit(this.tmp, 2, 0.5);
    }
  }

  /** Clipped: the sling won't let you near the drop. Unclipped: step off and you fall. */
  private keepOnLedge(s: number): void {
    if (this.fallCooldown > 0) return;
    const out = this.proj.d * this.outward;
    if (this.clipped) {
      if (out > CLIPPED_MAX_OUT) {
        const r = ropeData();
        const i = this.ropeIndex(s);
        const excess = out - CLIPPED_MAX_OUT;
        this.player.position.x -= r.tz[i] * this.outward * excess;
        this.player.position.z -= -r.tx[i] * this.outward * excess;
        if (!this.slingTaut) {
          this.slingTaut = true;
          mechAudio.tug(1);
          pulse(this.input.xr.gamepads, 'left', 0.5, 50);
          pulse(this.input.xr.gamepads, 'right', 0.5, 50);
        }
      }
      return;
    }
    if (s < ROPE_FIRST_S - 40 || s > ROPE_LAST_S + 40 || out < 1.5) return;
    if (expeditionHeight(this.head.x, this.head.z) < this.proj.elev - FALL_DROP) {
      this.fallCooldown = 5;
      this.grip.releaseAll();
      mechAudio.slip();
      expHooks.respawn('You fell from the ledge');
    }
  }

  // ------------------------------------------------------------- sling ----

  private updateSling(): void {
    if (!this.sling || !this.clip) return;
    if (!this.clipped) {
      this.sling[0].visible = false;
      this.sling[1].visible = false;
      this.clip.visible = false;
      return;
    }
    ropePointAt(this.clipU, this.clipPos);
    const harness = this.tmp.set(this.head.x, this.head.y - HARNESS_DROP, this.head.z);
    const clip = this.tmpB.set(this.clipPos.x, this.clipPos.y, this.clipPos.z);
    const dist = harness.distanceTo(clip);
    const slack = Math.max(0, SLING_LENGTH - dist);
    const mid = this.tmpC.addVectors(harness, clip).multiplyScalar(0.5);
    mid.y -= slack * 0.55;
    this.placeSegment(this.sling[0], harness, mid);
    this.placeSegment(this.sling[1], mid, clip);
    // taut sling: a tug as it snaps tight (stopped at an anchor, or caught by it)
    const taut = dist > SLING_LENGTH * 0.97;
    if (taut && !this.slingTaut) {
      this.slingTaut = true;
      mechAudio.tug(0.7);
    } else if (!taut && dist < SLING_LENGTH * 0.85) {
      this.slingTaut = false;
    }
    // the carabiner rides the rope, its gate facing you
    this.clip.visible = true;
    this.clip.position.copy(clip);
    const r = ropeData();
    const i = this.ropeIndex(this.clipU);
    this.clip.quaternion.setFromAxisAngle(Y_AXIS, Math.atan2(r.tx[i], r.tz[i]));
  }

  private placeSegment(mesh: Mesh, a: Vector3, b: Vector3): void {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    mesh.visible = len > 1e-3;
    if (!mesh.visible) return;
    mesh.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    this.quat.setFromUnitVectors(Y_AXIS, this.tmp.set(dx / len, dy / len, dz / len));
    mesh.quaternion.copy(this.quat);
    mesh.scale.set(1, len, 1);
  }

  // ------------------------------------------------------------- reset ----

  private onTeleport(s: number, nearRoute: boolean): void {
    this.grip.releaseAll();
    this.wasHolding = false;
    this.gustPhase = 'calm';
    this.gustTimer = 4;
    this.stuckFor = 0;
    this.fallCooldown = 0;
    game.velocity.set(0, 0, 0);
    const onRope = nearRoute && s > ROPE_FIRST_S - 2 && s < ROPE_LAST_S;
    if (this.clipped && !onRope) this.unclip(true, true);
  }

  private reset(stow: boolean): void {
    this.unclip(stow, true);
    this.grip.releaseAll();
    this.wasHolding = false;
    this.gustPhase = 'calm';
    this.gustTimer = 4;
    this.gateToastShown = false;
    this.clipToastShown = false;
    this.gustWarned = false;
    this.bracePraised = false;
    this.anchorHints = 0;
    this.prevHeadValid = false;
    openWalkGate();
    mechanics.limits.rope = Infinity;
    this.hideHints();
    if (this.group) this.group.visible = false;
  }
}
