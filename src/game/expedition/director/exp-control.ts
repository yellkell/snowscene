/**
 * What the guide panel (and keys) can ask of the expedition director, plus
 * the bits of director state the panel shows. The director installs the
 * actions in its init(); defaults are harmless no-ops so the guide never
 * needs to import the director system itself.
 */

import { signal } from '@iwsdk/core';

export const expControl = {
  /** Leave the tutorial and start the expedition at Base Camp. */
  start: () => {},
  /** Start the expedition again from Base Camp. */
  restart: () => {},
  /** Leave the expedition and play the tutorial again. */
  toTutorial: () => {},
  /** From a camp: fade and move on to the next camp. */
  skipAhead: () => {},
  /** Short status line for the guide panel ("1.2 km to Camp 1"). */
  hint: signal(''),
  /** Index into CAMPS of the camp you're standing in, or -1. */
  camp: signal(-1),
  /** Which band is being climbed (guide copy). */
  wall: signal<'ice' | 'rock' | null>(null),
};
