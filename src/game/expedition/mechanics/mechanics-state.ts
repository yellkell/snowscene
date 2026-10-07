/**
 * Shared state of the crossing mechanics (fixed rope, crevasse ladder, log
 * bridge), plus the speed limit other systems should respect.
 *
 * `mechanicsSpeedLimit()` is the integration point for locomotion: the
 * maximum horizontal speed (m/s) the player may move at right now, or
 * `Infinity` when nothing constrains them. The pole system (or the level's
 * `constrainWalk`) should clamp `game.velocity` to it each frame, e.g.
 *
 *     const cap = Math.min(MAX_SPEED, mechanicsSpeedLimit());
 *     if (v > cap) game.velocity.multiplyScalar(cap / v);
 *
 * The mechanics also enforce it themselves as a fallback (the late
 * `CrossingGuardSystem` scales back any rig displacement above the cap), so
 * integrating it is about smoothness, not correctness.
 *
 * Pure module (no Three.js), safe for node checks.
 */

export type CrossingId = 'ladder' | 'log';

export type CrossingMode =
  /** Not on a crossing. */
  | 'none'
  /** On the crossing, careful mode. */
  | 'careful'
  /** Lost balance: a scary wobble; grab something to save yourself. */
  | 'teeter'
  /** Falling: the respawn has been requested. */
  | 'falling';

export const mechanics = {
  /** Per-mechanic speed caps (m/s); the effective limit is the minimum. */
  limits: { rope: Infinity, ladder: Infinity, log: Infinity },

  /** Which crossing the player is on (or approaching), if any. */
  crossing: null as CrossingId | null,
  mode: 'none' as CrossingMode,
  /** Signed balance, -1..1 (+ = toppling to the left of travel); |b| >= 1 loses it. */
  balance: 0,
  /** Number of steadying contacts (hands on hand lines, arms out, Shift). */
  steadying: 0,
  /**
   * How far the walking surface should visibly roll right now (radians,
   * + = the left side dips). The mechanics roll their own ladder deck by it;
   * a world-built log or ladder can do the same.
   */
  deckRoll: 0,

  /** Speed the player tried to move at last frame before any cap (m/s). */
  attemptedSpeed: 0,
  /**
   * Lateral funnel toward the crossing: the head may be at most `halfWidth`
   * metres from the crossing's centre line (Infinity = no funnel). Written
   * by the ladder system, enforced after locomotion by the guard system.
   */
  funnel: {
    active: false,
    halfWidth: Infinity,
    /** Centre-line origin and left normal of the crossing (horizontal). */
    x: 0,
    z: 0,
    nx: 0,
    nz: 0,
  },
  /** Downward offset applied to the floor while falling (m). */
  sink: 0,
  /** Floor height the sink is measured from. */
  sinkFloor: 0,
  /** True while the guard should hold the rig's height (falling). */
  sinking: false,

  /** Rig position after the early mechanics ran (for the speed guard). */
  rigMark: { x: 0, z: 0, valid: false },
};

/**
 * The maximum horizontal speed (m/s) the player may move at right now;
 * `Infinity` when unconstrained. See the module comment for how to apply it.
 */
export function mechanicsSpeedLimit(): number {
  const l = mechanics.limits;
  return Math.min(l.rope, l.ladder, l.log);
}
