/**
 * Shared state of the Summit Chute, for the level (where the glider may be
 * deployed and launched), the director's hints and the guide copy.
 */

import { signal } from '@iwsdk/core';

export const chuteState = {
  /** Reached the deck at the bottom: unpack the glider here. */
  arrived: signal(false),
  /** On the chute right now (counting in or riding). */
  riding: signal(false),
};
