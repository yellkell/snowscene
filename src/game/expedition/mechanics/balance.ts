/**
 * Balance on a narrow crossing, as a damped (and, when you're careless,
 * unstable) pendulum. Pure math so it can be simulated in a node check.
 *
 * b is the signed lean (+ = toppling to the left of travel); |b| >= 1 means
 * balance is lost. Its "drive" comes from what the player does: standing
 * off the centre line, rolling the head, holding the hands lopsided,
 * swaying, and pushing harder than the crossing allows. Random wobble grows
 * with effort, quick head movement and wind. Steadying contacts (a fist on
 * each hand line, arms spread like a tightrope walker, Shift on desktop)
 * damp it and pull it back to centre.
 *
 * Tuned so a careful player hovers around |b| ~ 0.1-0.3, a sloppy one
 * wobbles visibly (0.5-0.8) and only a reckless one (charging, leaning,
 * twisting, in wind, hands-free) topples.
 */

export interface BalanceParams {
  /** Gains on the player's inputs (per metre / radian / m/s). */
  lateralGain: number;
  rollGain: number;
  asymGain: number;
  swayGain: number;
  /** Dead zones (so normal posture noise doesn't count). */
  lateralDead: number;
  rollDead: number;
  asymDead: number;
  /** Comfortable speed; effort above it adds wobble. */
  comfortSpeed: number;
  /** Random wobble amplitude: base, per m/s of excess effort, per m/s of head speed over 0.5, per storm. */
  noiseBase: number;
  noiseEffort: number;
  noiseHead: number;
  noiseStorm: number;
  /** Gravity amplifies a lean; the body's reflexes restore it (restore > instability = self-righting). */
  instability: number;
  restore: number;
  damping: number;
  /** Extra restoring force and damping at full steadying (2 contacts). */
  holdRestore: number;
  holdDamping: number;
}

export const LADDER_BALANCE: BalanceParams = {
  lateralGain: 1.7,
  rollGain: 1.5,
  asymGain: 0.9,
  swayGain: 0.55,
  lateralDead: 0.08,
  rollDead: 0.1,
  asymDead: 0.15,
  comfortSpeed: 0.55,
  noiseBase: 0.05,
  noiseEffort: 0.55,
  noiseHead: 0.45,
  noiseStorm: 0.22,
  instability: 0.9,
  restore: 1.45,
  damping: 1.7,
  holdRestore: 4.5,
  holdDamping: 4.0,
};

/** The log is wide and wooden: far more forgiving. */
export const LOG_BALANCE: BalanceParams = {
  lateralGain: 1.05,
  rollGain: 0.95,
  asymGain: 0.4,
  swayGain: 0.35,
  lateralDead: 0.18,
  rollDead: 0.14,
  asymDead: 0.2,
  comfortSpeed: 1.0,
  noiseBase: 0.03,
  noiseEffort: 0.5,
  noiseHead: 0.3,
  noiseStorm: 0.08,
  instability: 0.7,
  restore: 1.5,
  damping: 1.8,
  holdRestore: 3.5,
  holdDamping: 3.0,
};

export interface BalanceInputs {
  /** Head offset from the centre line (m, + = left). */
  lateral: number;
  /** Head roll (rad, + = tilted toward the left of travel). */
  roll: number;
  /** Left hand height minus right hand height (m): + tips you right... see sign note. */
  handAsym: number;
  /** Head lateral velocity (m/s, + = left). */
  sway: number;
  /** Speed the player is trying to move at (m/s). */
  effort: number;
  /** Head speed (m/s), physical + rig. */
  headSpeed: number;
  /** Wind 0..1. */
  storm: number;
  /** Steadying contacts, 0..2. */
  holds: number;
}

export interface BalanceState {
  b: number;
  v: number;
  /** Current random disturbance and where it's heading. */
  kick: number;
  kickTarget: number;
  kickTimer: number;
}

export function createBalance(): BalanceState {
  return { b: 0, v: 0, kick: 0, kickTarget: 0, kickTimer: 0 };
}

export function resetBalance(st: BalanceState): void {
  st.b = 0;
  st.v = 0;
  st.kick = 0;
  st.kickTarget = 0;
  st.kickTimer = 0;
}

function dead(x: number, zone: number): number {
  return x > zone ? x - zone : x < -zone ? x + zone : 0;
}

/**
 * Advance the balance by dt. `rand` returns uniform [0, 1). Sign note: a
 * raised left hand (handAsym > 0) shifts weight to the right, so it drives
 * b negative.
 */
export function stepBalance(
  st: BalanceState,
  p: BalanceParams,
  inp: BalanceInputs,
  dt: number,
  rand: () => number,
): void {
  const steady = Math.min(2, Math.max(0, inp.holds)) / 2;
  // Random wobble: a new target every ~0.3 s, eased toward (frame-rate independent).
  const excess = Math.max(0, inp.effort - p.comfortSpeed);
  const sigma =
    p.noiseBase +
    p.noiseEffort * excess +
    p.noiseHead * Math.max(0, inp.headSpeed - 0.5) +
    p.noiseStorm * inp.storm;
  st.kickTimer -= dt;
  if (st.kickTimer <= 0) {
    st.kickTimer = 0.22 + rand() * 0.2;
    st.kickTarget = (rand() * 2 - 1) * sigma * 1.7;
  }
  st.kick += (st.kickTarget - st.kick) * (1 - Math.exp(-5 * dt));

  const drive =
    p.lateralGain * dead(inp.lateral, p.lateralDead) +
    p.rollGain * dead(inp.roll, p.rollDead) -
    p.asymGain * dead(inp.handAsym, p.asymDead) +
    p.swayGain * inp.sway +
    st.kick;
  const restore = p.restore + p.holdRestore * steady - p.instability;
  const damping = p.damping + p.holdDamping * steady;
  const acc = drive * (1 - 0.75 * steady) - restore * st.b - damping * st.v;
  st.v += acc * dt;
  st.b += st.v * dt;
}
