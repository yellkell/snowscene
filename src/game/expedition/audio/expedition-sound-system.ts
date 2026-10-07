/**
 * ExpeditionSoundSystem: the expedition's soundscape and score.
 *
 * Active only while `exp.active` is true. Audio unlocks on the first user
 * gesture, so the graph is built lazily the first tick an AudioContext
 * exists (and is running). Runs at ~30 Hz: keeps the WebAudio listener on
 * the head pose, then drives wind, positional ambiences, footsteps, the
 * generative pad and the score plan (By the River / pad / Night Catch).
 *
 * `expSound` is the API for the director and FX agents: stings, a danger
 * bed, score overrides and positional event sounds.
 */

import { createSystem, Quaternion, Vector3 } from '@iwsdk/core';
import { audio } from '../../audio.js';
import { game, Phase } from '../../state.js';
import { valueNoise } from '../../terrain.js';
import { CAMPS } from '../exp-layout.js';
import { exp, expFrame } from '../exp-state.js';
import { SoundEngine } from './engine.js';
import type { EventKind } from './ambience.js';
import { makeFrame } from './frame.js';
import { type ScoreMode, silentZones, valleyZones, zoneWeights } from './sound-plan.js';
import type { StingId } from './stings.js';

export type { EventKind } from './ambience.js';
export type { ScoreMode } from './sound-plan.js';
export type { StingId } from './stings.js';

/** Update interval (seconds). */
const TICK = 1 / 30;

let engine: SoundEngine | null = null;

const requests = {
  danger: 0,
  /** AudioContext time at which a timed danger request releases. */
  dangerUntil: Infinity,
  dangerSeconds: 0,
  score: null as ScoreMode | null,
};

/** API for the director and FX: safe to call any time (no-ops when silent). */
export const expSound = {
  /** A short musical sting for a moment (ignored if the same one played < 4 s ago). */
  sting(id: StingId): void {
    if (exp.active.peek()) engine?.sting(id);
  },
  /**
   * Raise the danger bed (low heartbeat pulse + drone), 0..1. It holds until
   * changed; pass `seconds` to have it release on its own after that long.
   */
  setDanger(level: number, seconds?: number): void {
    requests.danger = Math.max(0, Math.min(1, level));
    requests.dangerSeconds = seconds ?? 0;
    requests.dangerUntil = Infinity;
    if (seconds !== undefined && engine) requests.dangerUntil = engine.kit.ctx.currentTime + seconds;
  },
  /** Force a score mode ('river', 'pad', 'padNight', 'night', 'silence', ...), or null for automatic. */
  setScore(mode: ScoreMode | null): void {
    requests.score = mode;
  },
  /** The score mode currently playing. */
  get score(): ScoreMode {
    return engine?.mode ?? 'intro';
  },
  /**
   * A positional one-shot at a world point, with distance, air absorption
   * and echo: 'crack' | 'rumble' | 'impact' | 'groan' | 'creak'. Rumbles may
   * be called every frame while an avalanche runs (they self-limit).
   */
  eventAt(kind: EventKind, x: number, y: number, z: number, intensity = 1): void {
    if (exp.active.peek() && engine?.awake) engine.ambience.eventAt(kind, x, y, z, intensity);
  },
};

export class ExpeditionSoundSystem extends createSystem({}) {
  private readonly frame = makeFrame();
  private readonly head = new Vector3();
  private readonly quat = new Quaternion();
  private readonly fwd = new Vector3();
  private readonly up = new Vector3();
  private acc = 0;
  private sinceStart = 0;
  private storm = -1;
  private danger = 0;
  private hasPrev = false;
  private prevX = 0;
  private prevZ = 0;

  init(): void {
    // The guide system re-picks music when the phase changes; take it back
    // straight away (before any audio renders) while the expedition runs.
    const reassert = () => {
      if (exp.active.peek()) queueMicrotask(() => engine?.reassertMusic());
    };
    this.cleanupFuncs.push(game.phase.subscribe(reassert), game.partsPlaced.subscribe(reassert));
  }

  update(delta: number, time: number): void {
    if (!exp.active.peek()) {
      if (engine?.awake) {
        engine.sleep();
        requests.danger = 0;
        requests.score = null;
      }
      engine?.idle();
      this.sinceStart = 0;
      return;
    }
    this.sinceStart += Math.min(delta, 0.1);
    const ctx = audio.context();
    const output = audio.output();
    if (!ctx || !output || ctx.state !== 'running') return;
    if (!engine) engine = new SoundEngine(ctx, output);
    if (!engine.awake) {
      engine.wake();
      this.hasPrev = false;
      this.storm = -1;
      this.danger = 0;
      if (requests.dangerSeconds > 0 && requests.dangerUntil === Infinity) {
        requests.dangerUntil = ctx.currentTime + requests.dangerSeconds;
      }
    }
    this.acc += delta;
    if (this.acc < TICK - 1e-4) return;
    const dt = Math.min(this.acc, 0.25);
    this.acc = 0;
    this.fill(ctx, dt, time);
    engine.tick(this.frame, this.sinceStart, exp.summited.peek() || exp.finished.peek(), requests.score);
  }

  private fill(ctx: AudioContext, dt: number, time: number): void {
    const f = this.frame;
    f.now = ctx.currentTime;
    f.dt = dt;
    f.time = time;

    // Head pose → listener.
    const xr = this.world.renderer.xr.isPresenting;
    const source = xr ? this.player.head : this.world.camera;
    source.updateWorldMatrix(true, false);
    this.head.setFromMatrixPosition(source.matrixWorld);
    source.getWorldQuaternion(this.quat);
    this.fwd.set(0, 0, -1).applyQuaternion(this.quat);
    this.up.set(0, 1, 0).applyQuaternion(this.quat);
    setListener(ctx.listener, this.head, this.fwd, this.up);
    f.hx = this.head.x;
    f.hy = this.head.y;
    f.hz = this.head.z;
    const flat = Math.hypot(this.fwd.x, this.fwd.z) || 1;
    f.rx = -this.fwd.z / flat;
    f.rz = this.fwd.x / flat;

    // Travel (ignore teleports: respawns, fades, launches).
    let moved = 0;
    if (this.hasPrev) {
      moved = Math.hypot(f.hx - this.prevX, f.hz - this.prevZ);
      if (moved > 6) moved = 0;
    }
    this.hasPrev = true;
    this.prevX = f.hx;
    this.prevZ = f.hz;
    f.moved = moved;
    f.speed += (moved / dt - f.speed) * Math.min(1, dt * 6);

    // Journey and weather.
    const phase = game.phase.peek();
    f.flying = phase === Phase.Launch || phase === Phase.Gliding;
    const finale = phase === Phase.Landed || exp.finished.peek();
    f.walking = phase === Phase.Poling || phase === Phase.Landed;
    f.airspeed = game.airspeed;
    // At the finale party we are back at Base Camp whatever s was last.
    f.s = finale ? CAMPS[0].s : expFrame.s;
    f.daylight = expFrame.daylight;
    f.aurora = expFrame.aurora;
    f.squall = expFrame.squall;
    if (f.flying) silentZones(f.zones);
    else if (finale) valleyZones(f.zones);
    else zoneWeights(f.s, f.zones);
    engine!.ambience.finale = finale;
    // Same smoothing, gusts and wind direction as the weather system.
    const target = game.stormOverride ?? expFrame.storm;
    this.storm = this.storm < 0 ? target : this.storm + (target - this.storm) * (1 - Math.exp(-dt / 3.2));
    f.storm = this.storm;
    f.gust = 0.5 + 0.5 * valueNoise(time * 0.35, 3.1);
    const windYaw = 0.6 + valueNoise(time * 0.04, 9.7) * 1.3;
    f.windX = Math.cos(windYaw);
    f.windZ = Math.sin(windYaw);

    // Danger: quick to rise, slow to settle.
    if (f.now >= requests.dangerUntil) {
      requests.danger = 0;
      requests.dangerUntil = Infinity;
      requests.dangerSeconds = 0;
    }
    const want = requests.danger;
    const k = 1 - Math.exp(-dt / (want > this.danger ? 0.3 : 1.6));
    this.danger += (want - this.danger) * k;
    if (this.danger < 0.002 && want === 0) this.danger = 0;
    f.danger = this.danger;
  }
}

function setListener(l: AudioListener, p: Vector3, fwd: Vector3, up: Vector3): void {
  if (l.positionX) {
    l.positionX.value = p.x;
    l.positionY.value = p.y;
    l.positionZ.value = p.z;
    l.forwardX.value = fwd.x;
    l.forwardY.value = fwd.y;
    l.forwardZ.value = fwd.z;
    l.upX.value = up.x;
    l.upY.value = up.y;
    l.upZ.value = up.z;
  } else {
    const legacy = l as unknown as {
      setPosition(x: number, y: number, z: number): void;
      setOrientation(x: number, y: number, z: number, ux: number, uy: number, uz: number): void;
    };
    legacy.setPosition(p.x, p.y, p.z);
    legacy.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
  }
}
