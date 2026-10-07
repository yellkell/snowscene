/**
 * Rules of the fixed-rope traverse that both the system and node checks
 * use. Pure (no Three.js).
 */

import { ROPE_START_S } from '../exp-layout.js';

/** Unclipped, the player may not walk past this arc length. */
export const ROPE_GATE_S = ROPE_START_S - 1.5;
/** Clipped, the head may get this far past the anchor that stops the clip
 * (about where the sling goes taut). */
export const ANCHOR_OVERRUN = 0.8;
/** A rope grab this far beyond the blocking anchor moves the clip across it. */
export const ANCHOR_PASS_MARGIN = 0.06;
/** Distance (m) from the carabiner to the rope that clips it on. */
export const CLIP_RADIUS = 0.1;
/** Distance (m) from the palm centre to the rope / a hand line to grab it. */
export const GRAB_RADIUS = 0.14;
/** A fist only grabs if it closed this recently (s), so a hand already
 * clenched around a pole doesn't snag lines it passes. */
export const GRAB_WINDOW = 0.3;
/** Harness sits this far below the eyes. */
export const HARNESS_DROP = 0.55;
/** Sling length from harness to clip (m). */
export const SLING_LENGTH = 1.05;
/** Clipped, the head can't get further than this toward the drop
 * (metres outward of the path centre; the lip is at ~2.6). */
export const CLIPPED_MAX_OUT = 0.55;
/** After this long stuck at an anchor, the clip passes it by itself. */
export const ANCHOR_AUTO_PASS = 10;

export const GATE_REASON_XR =
  'Clip in: take the carabiner from your pack and touch it to the rope';
export const GATE_REASON_DESKTOP = 'Clip in: press C to clip your carabiner to the rope';
export const ANCHOR_REASON_XR = 'Anchor: reach past it and grab the rope to move your clip across';
export const ANCHOR_REASON_DESKTOP = 'Anchor: keep walking (or press C) to move your clip across';
