/**
 * Turns tracked hands (or controllers) into a simple "is this hand closed?"
 * signal plus a world-space pose, which every mechanic in the experience
 * builds on:
 *
 *  - Hand tracking: a fist is detected from finger curl (fingertip-to-wrist
 *    distance relative to knuckle-to-wrist distance). A firm pinch also
 *    counts, which keeps the experience usable in the IWER emulator.
 *  - Controllers: squeeze (grip) or trigger.
 */

import {
  createSystem,
  InputComponent,
  Matrix4,
  Quaternion,
  Vector3,
  XRHandVisualAdapter,
} from '@iwsdk/core';

export type Handedness = 'left' | 'right';

export interface HandState {
  readonly handedness: Handedness;
  /** A hand or controller is currently tracked. */
  tracked: boolean;
  /** True when the source is an articulated hand rather than a controller. */
  isHand: boolean;
  /** Closed / gripping. Hysteresis is applied so it doesn't flicker. */
  grip: boolean;
  /** Grip started this frame. */
  gripDown: boolean;
  /** Grip ended this frame. */
  gripUp: boolean;
  /** 0 (open) .. 1 (closed). */
  closure: number;
  /** World-space grip pose (palm centre for hands). */
  readonly position: Vector3;
  readonly quaternion: Quaternion;
  /** World-space unit vector pointing out of the palm. */
  readonly palmNormal: Vector3;
  /** World-space index fingertip (falls back to just ahead of the grip). */
  readonly indexTip: Vector3;
}

function createHandState(handedness: Handedness): HandState {
  return {
    handedness,
    tracked: false,
    isHand: false,
    grip: false,
    gripDown: false,
    gripUp: false,
    closure: 0,
    position: new Vector3(),
    quaternion: new Quaternion(),
    palmNormal: new Vector3(0, -1, 0),
    indexTip: new Vector3(),
  };
}

export const hands: Record<Handedness, HandState> = {
  left: createHandState('left'),
  right: createHandState('right'),
};
export const HANDS: readonly HandState[] = [hands.left, hands.right];

const GRIP_ON = 0.6;
const GRIP_OFF = 0.35;
/** A grip must stay open this long before it counts as released. */
const RELEASE_GRACE = 0.12;
/** Low-pass rate for the raw closure signal (per second). */
const CLOSURE_SMOOTHING = 30;

const CURL_FINGERS = ['index-finger', 'middle-finger', 'ring-finger'] as const;

interface JointLookup {
  adapter: XRHandVisualAdapter;
  wrist: number;
  indexTip: number;
  proximal: number[];
  tips: number[];
}

export class HandInputSystem extends createSystem({}) {
  private lookups: Record<Handedness, JointLookup | null> = {
    left: null,
    right: null,
  };
  private openTime: Record<Handedness, number> = { left: 0, right: 0 };

  update(delta: number): void {
    const dt = Math.min(delta, 0.1);
    for (const state of HANDS) this.updateHand(state, dt);
  }

  private updateHand(state: HandState, dt: number): void {
    const side = state.handedness;
    const adapter = this.input.xr.visualAdapters[side].peek();
    const wasGrip = state.grip;
    state.gripDown = false;
    state.gripUp = false;

    if (!this.world.renderer.xr.isPresenting || !adapter?.connected) {
      state.tracked = false;
      state.isHand = false;
      state.closure = 0;
      state.grip = false;
      state.gripUp = wasGrip;
      return;
    }

    state.tracked = true;
    const grip = this.player.gripSpaces[side];
    grip.updateWorldMatrix(true, false);
    grip.matrixWorld.decompose(state.position, state.quaternion, tmpScale);

    let closure = 0;
    if (adapter instanceof XRHandVisualAdapter) {
      state.isHand = true;
      closure = Math.max(this.fingerCurl(side, adapter), adapter.getPinchStrength());
      this.updatePalm(state, adapter, grip.matrixWorld);
    } else {
      state.isHand = false;
      // Controllers: the grip's X axis is perpendicular to the palm; it points
      // out of the back of the right hand and out of the palm of the left.
      tmpVec.set(side === 'left' ? 1 : -1, 0, 0).applyQuaternion(state.quaternion);
      state.palmNormal.copy(tmpVec);
      state.indexTip.set(0, 0, -0.08).applyQuaternion(state.quaternion).add(state.position);
      const pad = this.input.xr.gamepads[side];
      if (pad) {
        closure = Math.max(
          pad.getButtonValue(InputComponent.Squeeze) ?? 0,
          pad.getButtonValue(InputComponent.Trigger) ?? 0,
        );
      }
    }
    // Tracking noise makes raw finger curl twitchy; smooth it, then apply
    // hysteresis plus a short grace period before a grip counts as released.
    state.closure += (closure - state.closure) * (1 - Math.exp(-CLOSURE_SMOOTHING * dt));
    if (wasGrip) {
      this.openTime[side] = state.closure < GRIP_OFF ? this.openTime[side] + dt : 0;
      state.grip = this.openTime[side] < RELEASE_GRACE;
    } else {
      state.grip = state.closure > GRIP_ON;
      this.openTime[side] = 0;
    }
    state.gripDown = state.grip && !wasGrip;
    state.gripUp = !state.grip && wasGrip;
  }

  /** Palm normal (wrist joint -Y) and index fingertip, in world space. */
  private updatePalm(state: HandState, adapter: XRHandVisualAdapter, gripWorld: Matrix4): void {
    const transforms = adapter.jointTransforms;
    if (!transforms || adapter.jointSpaces.length === 0) return;
    let lookup = this.lookups[state.handedness];
    if (!lookup || lookup.adapter !== adapter) {
      lookup = this.buildLookup(adapter);
      this.lookups[state.handedness] = lookup;
    }
    if (lookup.wrist < 0) return;
    // Joint transforms are relative to the grip space.
    tmpMat.fromArray(transforms, lookup.wrist * 16).premultiply(gripWorld);
    const e = tmpMat.elements;
    state.palmNormal.set(-e[4], -e[5], -e[6]).normalize();
    if (lookup.indexTip >= 0) {
      const k = lookup.indexTip * 16 + 12;
      state.indexTip.set(transforms[k], transforms[k + 1], transforms[k + 2]).applyMatrix4(gripWorld);
    }
  }

  private fingerCurl(side: Handedness, adapter: XRHandVisualAdapter): number {
    const transforms = adapter.jointTransforms;
    if (!transforms || adapter.jointSpaces.length === 0) return 0;
    let lookup = this.lookups[side];
    if (!lookup || lookup.adapter !== adapter || lookup.wrist < 0) {
      lookup = this.buildLookup(adapter);
      this.lookups[side] = lookup;
      if (lookup.wrist < 0) return 0;
    }
    let total = 0;
    let count = 0;
    for (let i = 0; i < lookup.tips.length; i++) {
      const tip = lookup.tips[i];
      const prox = lookup.proximal[i];
      if (tip < 0 || prox < 0) continue;
      const tipDist = jointDistance(transforms, tip, lookup.wrist);
      const proxDist = jointDistance(transforms, prox, lookup.wrist);
      if (proxDist < 1e-4) continue;
      const ratio = tipDist / proxDist;
      // ~1.75 for a straight finger, ~1.0 when curled into a fist.
      total += Math.min(1, Math.max(0, (1.6 - ratio) / 0.5));
      count++;
    }
    return count > 0 ? total / count : 0;
  }

  private buildLookup(adapter: XRHandVisualAdapter): JointLookup {
    const indexOf = (name: string) =>
      adapter.jointSpaces.findIndex((joint) => joint.jointName === name);
    return {
      adapter,
      wrist: indexOf('wrist'),
      indexTip: indexOf('index-finger-tip'),
      proximal: CURL_FINGERS.map((f) => indexOf(`${f}-phalanx-proximal`)),
      tips: CURL_FINGERS.map((f) => indexOf(`${f}-tip`)),
    };
  }
}

const tmpScale = new Vector3();
const tmpVec = new Vector3();
const tmpMat = new Matrix4();

function jointDistance(transforms: Float32Array, a: number, b: number): number {
  const ia = a * 16 + 12;
  const ib = b * 16 + 12;
  const dx = transforms[ia] - transforms[ib];
  const dy = transforms[ia + 1] - transforms[ib + 1];
  const dz = transforms[ia + 2] - transforms[ib + 2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
