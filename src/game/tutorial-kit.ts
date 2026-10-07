/**
 * What you carry in the tutorial: poles already in hand, plus a few things
 * in the backpack to discover (palm up to open it).
 */

import { equipPair, setPack } from './equipment.js';

export function startTutorialKit(): void {
  setPack({ poles: 1, thermos: 1, warmer: 2, map: 1, headlamp: 1 });
  equipPair('poles');
}
