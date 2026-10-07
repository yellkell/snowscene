/**
 * Hand-over-hand grip on a line (the fixed rope, the ladder's hand lines).
 *
 * Close a fist on the line to grab it. While held, the grabbed point is
 * locked to the hand along the line's direction only: pull your hand back
 * and you slide forward along the line (like the climbing holds, but on a
 * rail), never sideways or up. Push your hand forward and the fist slides
 * along the line (a ratchet), so walking or reaching on never drags you back. The most recent grab drives, so you can go
 * hand over hand; let go and a little of the pull carries on as momentum.
 *
 * A fist only grabs if it closed near the line within GRAB_WINDOW seconds,
 * so a hand already clenched around a pole doesn't snag lines it brushes.
 */

import { Vector3, type Object3D } from '@iwsdk/core';
import type { Handedness, HandState } from '../../hand-input.js';
import { GRAB_WINDOW } from './rope-rules.js';

/** Hard cap on how fast a pull may move you (rejects tracking glitches). */
const MAX_PULL_SPEED = 2.6;
/** If the hand ends up this far from where it grabbed, the grip is released. */
const SLIP_DISTANCE = 0.45;

export interface GripHand {
  held: boolean;
  /** World point grabbed (horizontal motion along the line keeps the hand on it). */
  readonly anchor: Vector3;
  /** Line parameter at the grab (route arc length or along-offset). */
  u: number;
  /** Seconds since this hand's fist closed (Infinity while open). */
  closedFor: number;
}

export class LineGrip {
  readonly hands: Record<Handedness, GripHand> = {
    left: { held: false, anchor: new Vector3(), u: 0, closedFor: Infinity },
    right: { held: false, anchor: new Vector3(), u: 0, closedFor: Infinity },
  };
  /** The hand that drives movement. */
  active: Handedness | null = null;
  /** Smoothed pull speed along the line (m/s, + = along dir). */
  speed = 0;
  /** Set for one frame when a hand grabs (for sounds / anchor passing). */
  grabbedNow: Handedness | null = null;

  /** Track fist timing; call every frame for both hands before tryGrab. */
  trackFist(hand: HandState, dt: number): void {
    const g = this.hands[hand.handedness];
    if (hand.tracked && hand.grip) g.closedFor = hand.gripDown ? 0 : g.closedFor + dt;
    else g.closedFor = Infinity;
  }

  /** Could this hand grab now (fist freshly closed, not already holding)? */
  canGrab(hand: HandState): boolean {
    const g = this.hands[hand.handedness];
    return !g.held && hand.tracked && hand.grip && g.closedFor <= GRAB_WINDOW;
  }

  grab(hand: HandState, u: number): void {
    const g = this.hands[hand.handedness];
    g.held = true;
    g.u = u;
    g.anchor.copy(hand.position);
    this.active = hand.handedness;
    this.grabbedNow = hand.handedness;
  }

  /** Release hands that opened, lost tracking or slipped. Returns true if any released. */
  releaseOpen(left: HandState, right: HandState): boolean {
    const a = this.releaseIfOpen(left, left, right);
    const b = this.releaseIfOpen(right, left, right);
    return a || b;
  }

  private releaseIfOpen(hand: HandState, left: HandState, right: HandState): boolean {
    const g = this.hands[hand.handedness];
    if (!g.held) return false;
    if (hand.tracked && hand.grip && hand.position.distanceTo(g.anchor) <= SLIP_DISTANCE) return false;
    this.release(hand.handedness, left, right);
    return true;
  }

  release(side: Handedness, left: HandState, right: HandState): void {
    const g = this.hands[side];
    if (!g.held) return;
    g.held = false;
    if (this.active === side) {
      const other: Handedness = side === 'left' ? 'right' : 'left';
      const og = this.hands[other];
      this.active = og.held ? other : null;
      // Re-anchor the remaining hand so there is no jump.
      if (og.held) og.anchor.copy(other === 'left' ? left.position : right.position);
    }
  }

  releaseAll(): void {
    this.hands.left.held = false;
    this.hands.right.held = false;
    this.active = null;
  }

  get holding(): boolean {
    return this.hands.left.held || this.hands.right.held;
  }

  count(): number {
    return (this.hands.left.held ? 1 : 0) + (this.hands.right.held ? 1 : 0);
  }

  /**
   * Move the rig so the active hand stays on its grabbed point, along the
   * horizontal unit direction (dx, dz) only. Returns the distance moved.
   *
   * With `ratchet` the grip only ever pulls you forward (+dir): if your hand
   * gets ahead of where it grabbed (you walked or leaned forward), it slides
   * along the line instead of dragging you back, as a loose fist on a rope
   * would. Sliding also advances `u`.
   */
  pull(
    hand: HandState,
    rig: Object3D,
    dx: number,
    dz: number,
    dt: number,
    maxSpeed = MAX_PULL_SPEED,
    ratchet = true,
  ): number {
    const g = this.hands[hand.handedness];
    const ex = g.anchor.x - hand.position.x;
    const ez = g.anchor.z - hand.position.z;
    let along = ex * dx + ez * dz;
    if (ratchet && along < 0) {
      g.anchor.x -= dx * along;
      g.anchor.z -= dz * along;
      g.u -= along;
      along = 0;
    }
    const cap = Math.min(maxSpeed, MAX_PULL_SPEED) * dt;
    if (along > cap) along = cap;
    else if (along < -cap) along = -cap;
    rig.position.x += dx * along;
    rig.position.z += dz * along;
    const v = along / Math.max(dt, 1e-3);
    this.speed += (v - this.speed) * (1 - Math.exp(-12 * dt));
    return along;
  }

  /** Keep the momentum estimate decaying while nothing is held. */
  coast(dt: number): void {
    this.speed *= Math.exp(-6 * dt);
  }
}
