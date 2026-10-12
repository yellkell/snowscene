/**
 * What you carry in the tutorial: just the poles in your hands, and they
 * stay there (they never go in the pack; at the cliff you lean them
 * against the rock). The pack starts empty and fills with what you find.
 */

import { equipment, equipPair, setPack } from './equipment.js';

export function startTutorialKit(): void {
  setPack({});
  equipPair('poles');
  equipment.locked.add('poles');
}
