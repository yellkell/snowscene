/**
 * Who dealt a blow, and that weapon's colour. An enemy's hit flash, the
 * rim of light round it as it is hit and the shards it shatters into all
 * take the colour of the weapon that hit it, so in a crowd of thousands you
 * can still see which of your weapons is carving into which part of it.
 * The colours are the weapons' own (their upgrade cards').
 */

export const SRC = {
  /** Not one of your weapons: a level-up blast, a bloater going up. */
  none: 0,
  icicles: 1,
  compass: 2,
  blades: 3,
  nova: 4,
  lightning: 5,
  fireworks: 6,
  breath: 7,
  trail: 8,
  comet: 9,
  /** Ramming through them at speed. */
  ram: 10,
} as const;

/** A blow that should leave the colour of whatever hit it before (a burn ticking down). */
export const SRC_KEEP = 255;

export const SOURCE_COLORS: readonly number[] = [
  0xfff4e6, // none: a warm white
  0x8fe3ff, // icicles
  0x7dffb2, // compass
  0xffd36a, // blades
  0xb9a4ff, // nova
  0xfff27a, // lightning
  0xff7ad9, // fireworks
  0xff8a3d, // breath
  0xffb347, // trail
  0xff5a2e, // comet
  0x7fe9ff, // ram
];
