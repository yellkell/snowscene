/**
 * What you carry in the tutorial: just the poles in your hands. The pack
 * starts empty (it fills with whatever you stow in it).
 */

import { equipPair, setPack } from './equipment.js';

export function startTutorialKit(): void {
  setPack({});
  equipPair('poles');
}
