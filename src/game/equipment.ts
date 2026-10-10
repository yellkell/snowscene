/**
 * What's in each hand and what's in the backpack. Pure state: the backpack
 * system moves items between pack and hands, and mechanics read it (poles
 * plant only when held, ice axes bite only when held, holds need a free
 * hand).
 */

import { signal } from '@iwsdk/core';
import type { Handedness } from './hand-input.js';

export const ItemIds = [
  'poles',
  'axes',
  'carabiner',
  'headlamp',
  'thermos',
  'warmer',
  'map',
  'flare',
  'glider',
  // The tutorial's glider kit, recovered in the cave and assembled on the summit.
  'leftWing',
  'rightWing',
  'controlBar',
] as const;
export type ItemId = (typeof ItemIds)[number];

/** Items that come as a pair, one per hand. */
export const PAIRED: ReadonlySet<ItemId> = new Set(['poles', 'axes']);

export const ITEM_LABELS: Record<ItemId, string> = {
  poles: 'Poles',
  axes: 'Ice axes',
  carabiner: 'Carabiner',
  headlamp: 'Headlamp',
  thermos: 'Thermos',
  warmer: 'Hand warmer',
  map: 'Map',
  flare: 'Flare',
  glider: 'Glider',
  leftWing: 'Left wing',
  rightWing: 'Right wing',
  controlBar: 'Control bar',
};

export const equipment = {
  inHand: { left: null as ItemId | null, right: null as ItemId | null },
  /** How many of each item are in the pack (excluding what's in hand). */
  pack: new Map<ItemId, number>(),
  /** Headlamp is worn rather than held. */
  headlampOn: signal(false),
  /** Clipped to a fixed rope with the carabiner. */
  clipped: signal(false),
  /** Bumped on any change so UI can refresh. */
  version: signal(0),
};

function changed(): void {
  equipment.version.value = equipment.version.peek() + 1;
}

export function packCount(item: ItemId): number {
  return equipment.pack.get(item) ?? 0;
}

export function setPack(contents: Partial<Record<ItemId, number>>): void {
  equipment.pack.clear();
  for (const [item, count] of Object.entries(contents)) {
    if (count && count > 0) equipment.pack.set(item as ItemId, count);
  }
  changed();
}

export function holding(side: Handedness, item: ItemId): boolean {
  return equipment.inHand[side] === item;
}

export function handsFree(side: Handedness): boolean {
  return equipment.inHand[side] === null;
}

/** The backpack item each recovered glider part becomes. */
export const GLIDER_PART_ITEMS = {
  LeftWing: 'leftWing',
  RightWing: 'rightWing',
  ControlBar: 'controlBar',
} as const satisfies Record<string, ItemId>;

/** Put one more of an item into the pack. */
export function addToPack(item: ItemId): void {
  equipment.pack.set(item, packCount(item) + 1);
  changed();
}

/** Take one of an item out of the pack without putting it in a hand. */
export function removeFromPack(item: ItemId): void {
  const count = packCount(item) - 1;
  if (count > 0) equipment.pack.set(item, count);
  else equipment.pack.delete(item);
  changed();
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

/** Use up a single item held in a hand (thermos sip, warmer, flare). */
export function consume(side: Handedness): void {
  equipment.inHand[side] = null;
  changed();
}

/** Force a pair into both hands (tutorial start, respawn). */
export function equipPair(item: ItemId): void {
  stowAll();
  if (packCount(item) > 0) take(item, 'right');
  else {
    equipment.inHand.left = item;
    equipment.inHand.right = item;
    changed();
  }
}
