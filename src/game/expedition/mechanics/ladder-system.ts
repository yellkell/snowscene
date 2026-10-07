/**
 * Balance crossings: the aluminium ladder over the crevasse and the log
 * bridge over the river.
 *
 * Step onto either and you go into careful mode: the speed cap eases down
 * to a slow walk (0.5 m/s on the ladder, ~1 m/s on the log) and a balance
 * value starts to drift. What tips you: standing off the centre line,
 * tilting your head, holding your hands lopsided, swaying, pushing harder
 * than the crossing allows, and the wind. You feel it as the ladder rolling
 * under your feet, aluminium creaking and groaning, and (on controllers)
 * haptics; the camera itself never rolls.
 *
 * What steadies you: on the ladder, close your fists on the two yellow hand
 * lines (each hand counts; you can also pull yourself along them hand over
 * hand); on either crossing, arms spread wide like a tightrope walker. On
 * desktop, hold Shift.
 *
 * Lose it over the gap and the ladder lurches in a scary wobble for about a
 * second: grab a hand line (or spread your arms / press Shift) to save
 * yourself. Otherwise you slip into the crevasse (`expHooks.respawn`), or
 * on the log you splash into the river and are put back on the bank just
 * before the bridge. Careful players essentially never fall (see the
 * balance simulations in mechanics.check.ts).
 *
 * A lateral "funnel" eases a player approaching off-centre onto the
 * crossing so you can't wander off the side into the slot.
 *
 * Priority 9.5 (after RopeSystem = 9, before PoleSystem = 10): hand-line
 * pulls move the rig while hand poses match the rig. `CrossingGuardSystem`
 * (10.5) then enforces the speed cap, the funnel and the fall.
 */

import { createSystem, Group, Mesh, Quaternion, Vector3 } from '@iwsdk/core';
import { HANDS, hands, type HandState } from '../../hand-input.js';
import { currentLevel } from '../../level.js';
import { faceYaw, getHeadWorld, placeHeadAt } from '../../rig.js';
import { addWarmth, fadeThen, game, Phase } from '../../state.js';
import { routeFrame } from '../exp-layout.js';
import { exp, expFrame, expHooks, expRefs } from '../exp-state.js';
import {
  type BalanceInputs,
  type BalanceParams,
  createBalance,
  LADDER_BALANCE,
  LOG_BALANCE,
  resetBalance,
  stepBalance,
} from './balance.js';
import {
  type Crossing,
  funnelHalfWidth,
  type HandLineHit,
  inCarefulZone,
  LADDER,
  LADDER_FLOOR_Y,
  type Local,
  LOG,
  logFloorY,
  nearestHandLine,
  onFootprint,
  overOpenCrevasse,
  speedCapAt,
  toLocal,
} from './crossing-geometry.js';
import { LineGrip } from './line-grip.js';
import { mechanics } from './mechanics-state.js';
import { mechAudio } from './mech-audio.js';
import { pulse, say } from './mech-util.js';
import { buildHandLines, buildLadder, mechanicsVisuals } from './mech-visuals.js';
import { GRAB_RADIUS } from './rope-rules.js';

/** Seconds of wobble after losing balance before you fall. */
const TEETER_LADDER = 1.0;
const TEETER_LOG = 1.25;
/** How far you sink before the fade takes you (m). */
const SINK_LADDER = 3.5;
const SINK_LOG = 1.0;
/** Give up waiting for a respawn after this long (no director installed). */
const FALL_TIMEOUT = 3.5;
/** Hands spread at least this far apart (horizontally) count as arms out. */
const ARMS_OUT = 1.0;
/** Visual roll of the ladder deck at |balance| = 1 (radians). */
const DECK_ROLL = 0.2;
/** Distance between rungs (clank per rung). */
const RUNG = 0.3;

const X_AXIS = new Vector3(1, 0, 0);
const NEG_Z = new Vector3(0, 0, -1);

export class LadderSystem extends createSystem({}) {
  private readonly bal = createBalance();
  private readonly inputs: BalanceInputs = {
    lateral: 0,
    roll: 0,
    handAsym: 0,
    sway: 0,
    effort: 0,
    headSpeed: 0,
    storm: 0,
    holds: 0,
  };
  private readonly grip = new LineGrip();
  private readonly lineHit: HandLineHit = { side: 0, dist: Infinity, a: 0 };
  private readonly lad: Local = { a: 0, l: 0 };
  private readonly logLoc: Local = { a: 0, l: 0 };
  private readonly tmpLocal: Local = { a: 0, l: 0 };
  private readonly head = new Vector3();
  private readonly prevHead = new Vector3();
  private prevHeadValid = false;
  private readonly tmp = new Vector3();
  private readonly tmpB = new Vector3();
  private readonly quat = new Quaternion();

  private current: Crossing | null = null;
  private params: BalanceParams = LADDER_BALANCE;
  private prevL = 0;
  private prevA = 0;
  private sway = 0;
  private headSpeed = 0;
  private teeterT = 0;
  private fallT = 0;
  private fallCrossing: Crossing | null = null;
  private wasHolding = false;
  private rungTravel = 0;
  private creakTimer = 0;
  private hapticTimer = 0;
  private enterShown = false;
  private warnShown = false;
  private roll = 0;

  private ladderGroup: Group | null = null;
  private deck: Mesh | null = null;
  private lineGroup: Group | null = null;

  init(): void {
    this.cleanupFuncs.push(
      exp.active.subscribe((active) => {
        if (!active) this.leave();
      }),
      game.phase.subscribe((phase) => {
        if (phase !== Phase.Poling) this.leave();
      }),
    );
  }

  private ensureVisuals(): void {
    if (this.ladderGroup || !expRefs.root) return;
    const group = new Group();
    group.name = 'CrevasseCrossing';
    if (mechanicsVisuals.ladder) {
      const { group: ladder, deck } = buildLadder();
      group.add(ladder);
      this.deck = deck;
    }
    if (mechanicsVisuals.handLines) {
      this.lineGroup = buildHandLines();
      group.add(this.lineGroup);
    }
    group.visible = false;
    this.world.createTransformEntity(group, { parent: expRefs.root });
    this.ladderGroup = group;
  }

  update(delta: number, time: number): void {
    const dt = Math.max(1e-3, Math.min(delta, 0.1));
    mechanics.rigMark.valid = false;
    if (!exp.active.peek()) return;
    this.ensureVisuals();
    getHeadWorld(this.world, this.head);
    if (this.prevHeadValid) {
      const jump = Math.hypot(this.head.x - this.prevHead.x, this.head.z - this.prevHead.z);
      if (jump > 6) this.onTeleport();
      else this.headSpeed += (jump / dt - this.headSpeed) * (1 - Math.exp(-8 * dt));
    }
    this.prevHead.copy(this.head);
    this.prevHeadValid = true;

    toLocal(LADDER, this.head.x, this.head.z, this.lad);
    if (this.ladderGroup) {
      this.ladderGroup.visible = Math.abs(this.lad.a) < 250 && Math.abs(this.lad.l) < 250;
    }
    if (game.phase.peek() !== Phase.Poling) {
      this.settleDeck(dt);
      return;
    }

    if (this.fallCrossing) {
      this.updateFall(dt);
      this.markRig();
      return;
    }
    // Walked off the side of the ladder over the open slot (only possible if
    // something put you there: the funnel keeps you on the ladder).
    if (overOpenCrevasse(this.lad)) {
      this.startFall(LADDER, 'You fell into the crevasse');
      this.markRig();
      return;
    }

    toLocal(LOG, this.head.x, this.head.z, this.logLoc);
    const c = inCarefulZone(LADDER, this.lad) ? LADDER : inCarefulZone(LOG, this.logLoc) ? LOG : null;
    if (c !== this.current) {
      this.leave();
      if (c) this.enter(c);
    }
    if (!c) {
      // Re-arm the intro message once you're well clear of both crossings.
      if (Math.abs(this.lad.a) > 40 && Math.abs(this.logLoc.a) > 40) this.enterShown = false;
      this.settleDeck(dt);
      return;
    }
    const loc = c === LADDER ? this.lad : this.logLoc;
    const presenting = this.world.renderer.xr.isPresenting;

    // ---- limits and funnel ---------------------------------------------
    const cap = speedCapAt(c, loc);
    if (c === LADDER) mechanics.limits.ladder = cap;
    else mechanics.limits.log = cap;
    const f = mechanics.funnel;
    f.active = true;
    f.halfWidth = funnelHalfWidth(c, loc.a);
    f.x = c.x;
    f.z = c.z;
    f.nx = c.nx;
    f.nz = c.nz;

    const onDeck = onFootprint(c, loc);
    const overGap = onDeck && Math.abs(loc.a) < c.gapHalf;

    // ---- steadying contacts and hand-line pulls ------------------------
    let holds = 0;
    if (presenting) {
      if (c === LADDER) holds += this.updateHandLines(dt, cap);
      if (this.armsOut()) holds = Math.max(holds, 1);
    } else {
      this.grip.releaseAll();
      const kb = this.input.keyboard;
      if (kb.getKeyPressed('ShiftLeft') || kb.getKeyPressed('ShiftRight')) holds = 2;
    }

    // ---- balance inputs ----------------------------------------------------
    const inp = this.inputs;
    inp.lateral = loc.l;
    this.sway += ((loc.l - this.prevL) / dt - this.sway) * (1 - Math.exp(-10 * dt));
    this.prevL = loc.l;
    inp.sway = this.sway;
    if (presenting) {
      // Head roll in the body frame, signed toward the left of travel.
      this.player.head.getWorldQuaternion(this.quat);
      const right = this.tmp.copy(X_AXIS).applyQuaternion(this.quat);
      const fwd = this.tmpB.copy(NEG_Z).applyQuaternion(this.quat);
      const fl = Math.hypot(fwd.x, fwd.z) || 1;
      const facing = (fwd.x * c.tx + fwd.z * c.tz) / fl;
      inp.roll = Math.asin(Math.max(-1, Math.min(1, right.y))) * facing;
      inp.handAsym =
        hands.left.tracked && hands.right.tracked && holds === 0
          ? (hands.left.position.y - hands.right.position.y) * facing
          : 0;
    } else {
      inp.roll = 0;
      inp.handAsym = 0;
    }
    inp.effort = mechanics.attemptedSpeed;
    inp.headSpeed = this.headSpeed;
    inp.storm = Math.min(1, Math.max(0, expFrame.storm));
    inp.holds = holds;
    mechanics.steadying = holds;

    if (onDeck) {
      stepBalance(this.bal, this.params, inp, dt, Math.random);
    } else {
      // On solid snow your balance comes back.
      this.bal.b *= Math.exp(-3 * dt);
      this.bal.v *= Math.exp(-3 * dt);
    }

    // ---- losing it ------------------------------------------------------------
    if (mechanics.mode === 'teeter') {
      this.teeterT -= dt;
      const sign = this.bal.b >= 0 ? 1 : -1;
      if (holds > 0) {
        // Saved!
        this.bal.b = 0.6 * sign;
        this.bal.v = -0.4 * sign;
        mechanics.mode = 'careful';
        mechAudio.tug(0.8);
        say('Close one. Keep it slow', 2.5);
      } else if (!onDeck) {
        // Stepped off the end onto solid snow: safe.
        mechanics.mode = 'careful';
      } else if (this.teeterT <= 0) {
        if (overGap) {
          this.startFall(c, 'You slipped into the crevasse');
          this.markRig();
          return;
        }
        mechanics.mode = 'careful';
      } else {
        this.bal.b = sign;
        this.bal.v = 0;
      }
    } else if (Math.abs(this.bal.b) >= 1) {
      if (overGap) {
        mechanics.mode = 'teeter';
        this.teeterT = c === LADDER ? TEETER_LADDER : TEETER_LOG;
        mechAudio.slip();
        if (c === LADDER) mechAudio.ladderCreak(1);
        else mechAudio.logCreak(1);
        this.buzz(0.9, 120);
        say(
          presenting
            ? c === LADDER
              ? 'Whoa! Grab the hand lines!'
              : 'Whoa! Arms out!'
            : 'Whoa! Hold Shift!',
          2,
        );
      } else {
        // Over solid ground you just stumble.
        this.bal.b = Math.sign(this.bal.b) * 0.95;
        this.bal.v = 0;
      }
    } else if (!this.warnShown && Math.abs(this.bal.b) > 0.65 && onDeck) {
      this.warnShown = true;
      say(
        presenting
          ? c === LADDER
            ? 'Steady! Close your fists on the yellow hand lines'
            : 'Steady! Spread your arms for balance'
          : 'Steady! Hold Shift',
        3,
      );
    }
    mechanics.balance = this.bal.b;

    // ---- feedback -----------------------------------------------------------
    const teeter = mechanics.mode === 'teeter';
    const target = (onDeck ? this.bal.b * DECK_ROLL : 0) + (teeter ? 0.1 * Math.sin(time * 19) : 0);
    this.roll += (target - this.roll) * (1 - Math.exp(-(teeter ? 30 : 10) * dt));
    mechanics.deckRoll = this.roll;
    if (this.deck && c === LADDER) {
      this.deck.rotation.x = -this.roll;
      // the ladder sags a little under you in the middle of the span
      const k = overGap ? 1 - (loc.a / c.gapHalf) ** 2 : 0;
      this.deck.position.y = -0.03 * k + (teeter ? 0.015 * Math.sin(time * 23) : 0);
    }
    if (onDeck) this.sounds(c, loc, dt, teeter);
    else this.rungTravel = 0;
    this.prevA = loc.a;
    this.markRig();
  }

  // ------------------------------------------------------- hand lines ----

  /** Track fists on the hand lines; pull along them. Returns steadying contacts (0..2). */
  private updateHandLines(dt: number, cap: number): number {
    for (const hand of HANDS) this.grip.trackFist(hand, dt);
    this.grip.grabbedNow = null;
    this.grip.releaseOpen(hands.left, hands.right);
    let holds = 0;
    holds += this.handOnLine(hands.left);
    holds += this.handOnLine(hands.right);
    const active = this.grip.active;
    if (active) {
      this.grip.pull(hands[active], this.player, LADDER.tx, LADDER.tz, dt, Math.min(cap, 1.2) * 1.1);
      game.velocity.x = 0;
      game.velocity.z = 0;
      this.wasHolding = true;
    } else {
      if (this.wasHolding) {
        game.velocity.x = LADDER.tx * this.grip.speed * 0.4;
        game.velocity.z = LADDER.tz * this.grip.speed * 0.4;
        this.wasHolding = false;
      }
      this.grip.coast(dt);
    }
    return holds;
  }

  private handOnLine(hand: HandState): number {
    if (!hand.tracked) return 0;
    const g = this.grip.hands[hand.handedness];
    if (g.held) return 1;
    nearestHandLine(hand.position.x, hand.position.y, hand.position.z, 0, this.lineHit);
    if (this.lineHit.dist > GRAB_RADIUS + 0.03) return 0;
    if (this.grip.canGrab(hand)) {
      this.grip.grab(hand, this.lineHit.a);
      mechAudio.tug(0.3);
      pulse(this.input.xr.gamepads, hand.handedness, 0.3, 25);
      return 1;
    }
    // A fist that was already closed (around a pole, say) still steadies you.
    return hand.grip ? 1 : 0;
  }

  private armsOut(): boolean {
    const l = hands.left;
    const r = hands.right;
    if (!l.tracked || !r.tracked) return false;
    const spread = Math.hypot(l.position.x - r.position.x, l.position.z - r.position.z);
    return spread > ARMS_OUT && l.position.y > this.head.y - 0.8 && r.position.y > this.head.y - 0.8;
  }

  // ------------------------------------------------------------ sounds ----

  private sounds(c: Crossing, loc: Local, dt: number, teeter: boolean): void {
    const intensity = Math.min(1, Math.abs(this.bal.v) * 1.2 + Math.abs(this.bal.b) * 0.7 + this.headSpeed * 0.25);
    this.creakTimer -= dt * (0.5 + 2.5 * intensity + (teeter ? 6 : 0));
    if (this.creakTimer <= 0) {
      this.creakTimer = 0.6 + Math.random() * 0.9;
      if (c === LADDER) mechAudio.ladderCreak(teeter ? 1 : intensity);
      else mechAudio.logCreak(teeter ? 1 : intensity);
    }
    // a clank for each rung you step across (ladder); a soft knock on the log
    this.rungTravel += Math.abs(loc.a - this.prevA);
    const step = c === LADDER ? RUNG : 0.7;
    if (this.rungTravel > step) {
      this.rungTravel = 0;
      if (c === LADDER) mechAudio.ladderClank(0.4 + intensity * 0.5);
      else if (Math.random() < 0.4) mechAudio.logCreak(0.2);
    }
    if (Math.abs(this.bal.b) > 0.55 || teeter) {
      this.hapticTimer -= dt;
      if (this.hapticTimer <= 0) {
        this.hapticTimer = teeter ? 0.12 : 0.3;
        this.buzz(0.2 + 0.5 * Math.min(1, Math.abs(this.bal.b)), 40);
      }
    }
  }

  private buzz(value: number, ms: number): void {
    pulse(this.input.xr.gamepads, 'left', value, ms);
    pulse(this.input.xr.gamepads, 'right', value, ms);
  }

  // ------------------------------------------------------------- falls ----

  /** `reason` is shown by the director's respawn (crevasse); the river handles itself. */
  private startFall(c: Crossing, reason: string): void {
    this.fallCrossing = c;
    this.fallT = 0;
    mechanics.mode = 'falling';
    this.grip.releaseAll();
    game.velocity.set(0, 0, 0);
    mechanics.limits.ladder = 0;
    mechanics.limits.log = 0;
    mechanics.funnel.active = false;
    mechanics.sinking = true;
    mechanics.sink = 0;
    this.buzz(1, 200);
    if (c === LADDER) {
      mechanics.sinkFloor = LADDER_FLOOR_Y;
      mechAudio.slip();
      expHooks.respawn(reason);
    } else {
      toLocal(LOG, this.head.x, this.head.z, this.logLoc);
      mechanics.sinkFloor = logFloorY(Math.max(-LOG.halfLength, Math.min(LOG.halfLength, this.logLoc.a)));
      mechAudio.slip();
      fadeThen(() => this.backOnTheBank());
    }
  }

  private updateFall(dt: number): void {
    const c = this.fallCrossing!;
    const before = this.fallT;
    this.fallT += dt;
    mechanics.sink = Math.min(c === LADDER ? SINK_LADDER : SINK_LOG, 4.9 * this.fallT * this.fallT);
    if (c === LOG && before < 0.3 && this.fallT >= 0.3) mechAudio.splash();
    if (this.fallT > FALL_TIMEOUT) this.endFall();
  }

  private endFall(): void {
    this.fallCrossing = null;
    mechanics.sinking = false;
    mechanics.sink = 0;
    mechanics.mode = 'none';
    resetBalance(this.bal);
    this.leave();
  }

  /** After a splash: back on the near bank, facing the bridge. */
  private backOnTheBank(): void {
    const f = routeFrame(LOG.s - LOG.halfLength - 2.5);
    placeHeadAt(this.world, f.x, f.z, currentLevel().groundAt(f.x, f.z));
    faceYaw(this.world, Math.atan2(-f.tx, -f.tz));
    game.velocity.set(0, 0, 0);
    addWarmth(-0.12);
    this.endFall();
    say('Brrr! Soaked and cold. Take the log slowly, arms out for balance', 5);
  }

  // ----------------------------------------------------- enter / leave ----

  private enter(c: Crossing): void {
    this.current = c;
    this.params = c === LADDER ? LADDER_BALANCE : LOG_BALANCE;
    mechanics.crossing = c.id;
    mechanics.mode = 'careful';
    resetBalance(this.bal);
    toLocal(c, this.head.x, this.head.z, this.tmpLocal);
    this.prevL = this.tmpLocal.l;
    this.prevA = this.tmpLocal.a;
    this.sway = 0;
    this.rungTravel = 0;
    this.warnShown = false;
    if (!this.enterShown) {
      this.enterShown = true;
      const xr = this.world.renderer.xr.isPresenting;
      if (c === LADDER) {
        say(
          xr
            ? 'Crevasse ladder. Slow and steady: close your fists on the yellow hand lines and pull yourself across'
            : 'Crevasse ladder. Slowly now: hold Shift to steady yourself',
          6,
        );
      } else {
        say(xr ? 'Log bridge. Take it slowly, arms out for balance' : 'Log bridge. Slowly: hold Shift to steady yourself', 5);
      }
    }
  }

  /** Off any crossing: clear limits, funnel and balance. */
  private leave(): void {
    this.current = null;
    if (!this.fallCrossing) {
      mechanics.crossing = null;
      mechanics.mode = 'none';
      mechanics.limits.ladder = Infinity;
      mechanics.limits.log = Infinity;
      mechanics.funnel.active = false;
      mechanics.funnel.halfWidth = Infinity;
      mechanics.balance = 0;
      mechanics.steadying = 0;
    }
    this.grip.releaseAll();
    this.wasHolding = false;
    resetBalance(this.bal);
  }

  private settleDeck(dt: number): void {
    this.roll *= Math.exp(-6 * dt);
    mechanics.deckRoll = this.roll;
    if (this.deck) {
      this.deck.rotation.x = -this.roll;
      this.deck.position.y *= Math.exp(-6 * dt);
    }
  }

  private onTeleport(): void {
    this.headSpeed = 0;
    if (this.fallCrossing) this.endFall();
    else this.leave();
  }

  private markRig(): void {
    const m = mechanics.rigMark;
    m.x = this.player.position.x;
    m.z = this.player.position.z;
    m.valid = true;
  }
}
