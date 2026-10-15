/**
 * What's in each hand and what's in the backpack. Pure state: the backpack
 * system moves items between pack and hands, and mechanics read it (poles
 * plant only when held, holds need a free hand).
 */

import { signal } from '@iwsdk/core';
import type { Handedness } from './hand-input.js';

export const ItemIds = [
  'poles',
  // The tutorial glider's parts, recovered from the cave.
  'leftWing',
  'rightWing',
  'controlBar',
] as const;
export type ItemId = (typeof ItemIds)[number];

/** Items that come as a pair, one per hand. */
export const PAIRED: ReadonlySet<ItemId> = new Set(['poles']);

export const ITEM_LABELS: Record<ItemId, string> = {
  poles: 'Poles',
  leftWing: 'Left wing',
  rightWing: 'Right wing',
  controlBar: 'Control bar',
};

/** The pack item for each glider part (see glider-model.ts). */
export const PART_ITEM = {
  LeftWing: 'leftWing',
  RightWing: 'rightWing',
  ControlBar: 'controlBar',
} as const satisfies Record<string, ItemId>;
export type PartItem = (typeof PART_ITEM)[keyof typeof PART_ITEM];
export const PART_ITEMS: ReadonlySet<ItemId> = new Set(Object.values(PART_ITEM));

export const equipment = {
  inHand: { left: null as ItemId | null, right: null as ItemId | null },
  /** How many of each item are in the pack (excluding what's in hand). */
  pack: new Map<ItemId, number>(),
  /** Bumped on any change so UI can refresh. */
  version: signal(0),
  /** Items that stay in your hands: you can't put them in the pack (the tutorial's poles). */
  locked: new Set<ItemId>(),
};

function changed(): void {
  equipment.version.value = equipment.version.peek() + 1;
}

export function packCount(item: ItemId): number {
  return equipment.pack.get(item) ?? 0;
}

/** Put an item straight into the pack (found on the way, not from a hand). */
export function addToPack(item: ItemId, count = 1): void {
  equipment.pack.set(item, packCount(item) + count);
  changed();
}

/** Take an item out of the pack without putting it in a hand (used up in place). */
export function removeFromPack(item: ItemId): boolean {
  const n = packCount(item);
  if (n <= 0) return false;
  if (n > 1) equipment.pack.set(item, n - 1);
  else equipment.pack.delete(item);
  changed();
  return true;
}

/** A new kit: the pack holds `contents`, and nothing is locked in hand. */
export function setPack(contents: Partial<Record<ItemId, number>>): void {
  equipment.pack.clear();
  equipment.locked.clear();
  for (const [item, count] of Object.entries(contents)) {
    if (count && count > 0) equipment.pack.set(item as ItemId, count);
  }
  changed();
}

export function holding(side: Handedness, item: ItemId): boolean {
  return equipment.inHand[side] === item;
}

/** Put whatever is in a hand back into the pack. */
export function stow(side: Handedness): void {
  const item = equipment.inHand[side];
  if (!item) return;
  equipment.inHand[side] = null;
  // A pair goes back only when both halves are home.
  const other: Handedness = side === 'left' ? 'right' : 'left';
  if (PAIRED.has(item)) {
    if (equipment.inHand[other] === item) {
      changed();
      return;
    }
  }
  equipment.pack.set(item, packCount(item) + 1);
  changed();
}

export function stowAll(): void {
  stow('left');
  stow('right');
}

/**
 * Take an item out of the pack. Paired tools fill both hands (stowing what
 * was there); single items go into `side`.
 */
export function take(item: ItemId, side: Handedness): boolean {
  if (packCount(item) <= 0) return false;
  const count = packCount(item) - 1;
  if (count > 0) equipment.pack.set(item, count);
  else equipment.pack.delete(item);
  if (PAIRED.has(item)) {
    stow('left');
    stow('right');
    equipment.inHand.left = item;
    equipment.inHand.right = item;
  } else {
    stow(side);
    equipment.inHand[side] = item;
  }
  changed();
  return true;
}

/** Empty both hands without packing anything (set down, left behind). */
export function clearHands(): void {
  equipment.inHand.left = null;
  equipment.inHand.right = null;
  changed();
}

/** Use up a single item held in a hand (a glider part fitted to the frame). */
export function consume(side: Handedness): void {
  equipment.inHand[side] = null;
  changed();
}

/** Force a pair into both hands (tutorial start, Snow Survivors start). */
export function equipPair(item: ItemId): void {
  stowAll();
  if (packCount(item) > 0) take(item, 'right');
  else {
    equipment.inHand.left = item;
    equipment.inHand.right = item;
    changed();
  }
}
