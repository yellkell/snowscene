/**
 * The walk gate: the furthest arc length the player may walk to right now.
 *
 * Contract (DESIGN.md): the level's `constrainWalk` clamps the player's
 * route progress `s` to `walkGate.blockS` and shows `walkGate.reason`
 * (e.g. on the guide panel / wrist HUD) while the player is held there.
 * `Infinity` means no gate. Only the mechanics systems write it.
 *
 * Plain object, mutated in place, no Three.js: safe to import anywhere.
 */
export const walkGate = { blockS: Infinity, reason: '' };

/** Clear the gate (no limit). */
export function openWalkGate(): void {
  walkGate.blockS = Infinity;
  walkGate.reason = '';
}
