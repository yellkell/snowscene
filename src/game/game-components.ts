/**
 * Component declarations for the snow scene. Kept free of systems, DOM and
 * renderer imports so the editor can load them via src/components.ts.
 */

import { createComponent, Types } from '@iwsdk/core';

/** A rock hold on the cliff that a closed hand can latch on to. */
export const ClimbHold = createComponent('ClimbHold', {
  /** True for holds on the summit lip; grabbing one helps the mantle. */
  lip: { type: Types.Boolean, default: false },
  /** Seconds of highlight remaining after the hold was grabbed. */
  glow: { type: Types.Float32, default: 0 },
});

export const GliderPartIds = {
  LeftWing: 'LeftWing',
  RightWing: 'RightWing',
  ControlBar: 'ControlBar',
} as const;

/** One loose piece of the glider kit on the summit workbench. */
export const GliderPart = createComponent('GliderPart', {
  partId: {
    type: Types.Enum,
    enum: GliderPartIds,
    default: GliderPartIds.LeftWing,
  },
  placed: { type: Types.Boolean, default: false },
});
