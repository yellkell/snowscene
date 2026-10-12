/**
 * Snow Survivors: shared state for the run (read by the guide panel and the
 * HUD), and the actions the guide panel's buttons call. The survivors system
 * installs the actions in its init(); the defaults are harmless no-ops so
 * the guide never imports the system itself.
 */

import { signal } from '@iwsdk/core';

export const survivors = {
  /** The mode is running (the arena is up instead of the mountain). */
  active: signal(false),
  /** The run is over, fallen or survived (the panel offers another go). */
  dead: signal(false),
  /** ...and it ended with the clock run out: you survived. */
  won: signal(false),
  /** Seconds survived, kills, level: for the panel's end-of-run line. */
  time: signal(0),
  kills: signal(0),
  level: signal(1),
  /** Best kill streak and bosses felled, for the same line. */
  bestCombo: signal(0),
  bosses: signal(0),
};

export const survivorsControl = {
  /** Leave the mountain (or a finished run) and start a fresh run. */
  start: () => {},
  /** Leave the arena and go back to the mountain. */
  exit: () => {},
};
