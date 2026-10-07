/**
 * Small helpers shared by the mechanics systems: toasts that work with or
 * without the director, and controller haptics.
 */

import { expHooks } from '../exp-state.js';
import { toast } from '../../state.js';
import type { Handedness } from '../../hand-input.js';

const defaultToast = expHooks.toast;

/** Show a short message (the director's toast if installed, else the guide panel). */
export function say(text: string, seconds = 4): void {
  if (expHooks.toast !== defaultToast) expHooks.toast(text, seconds);
  else toast(text, seconds);
}

interface HapticPad {
  gamepad?: { hapticActuators?: ReadonlyArray<unknown> } | null;
}

/** A haptic pulse on a controller (no-op for hands and browsers without it). */
export function pulse(
  gamepads: Partial<Record<Handedness, HapticPad | undefined>>,
  side: Handedness,
  value: number,
  ms: number,
): void {
  const actuator = gamepads[side]?.gamepad?.hapticActuators?.[0] as
    | { pulse?: (value: number, duration: number) => void }
    | undefined;
  actuator?.pulse?.(Math.min(1, Math.max(0, value)), ms);
}
