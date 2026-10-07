/**
 * Synthesised sounds for the crossings, built on the shared audio context
 * (`audio.context()` / `output()` / `noiseBuffer()`): aluminium ladder
 * creaks and clanks, wooden log groans, the carabiner gate snapping shut,
 * the sling going taut, wind gusts on the ledge, a slip and a splash.
 *
 * Each call creates a handful of short-lived nodes (events only, never per
 * frame). Silent until audio is unlocked.
 */

import { audio } from '../../audio.js';

function env(ctx: AudioContext, gain: GainNode, t: number, attack: number, peak: number, decay: number): void {
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

function noise(
  ctx: AudioContext,
  out: AudioNode,
  type: BiquadFilterType,
  freq: number,
  q: number,
  t: number,
  attack: number,
  peak: number,
  decay: number,
  rate = 1,
): BiquadFilterNode | null {
  const buffer = audio.noiseBuffer();
  if (!buffer) return null;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = rate;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.setValueAtTime(freq, t);
  filter.Q.value = q;
  const gain = ctx.createGain();
  env(ctx, gain, t, attack, peak, decay);
  src.connect(filter).connect(gain).connect(out);
  src.start(t, Math.random() * 1.4, attack + decay + 0.05);
  return filter;
}

function partial(
  ctx: AudioContext,
  out: AudioNode,
  type: OscillatorType,
  freq: number,
  t: number,
  attack: number,
  peak: number,
  decay: number,
  glideTo = 0,
): void {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (glideTo > 0) osc.frequency.exponentialRampToValueAtTime(glideTo, t + attack + decay);
  const gain = ctx.createGain();
  env(ctx, gain, t, attack, peak, decay);
  osc.connect(gain).connect(out);
  osc.start(t);
  osc.stop(t + attack + decay + 0.05);
}

/** Stick-slip groan: a buzzy low tone through a resonant band. */
function groan(
  ctx: AudioContext,
  out: AudioNode,
  t: number,
  f0: number,
  f1: number,
  band: number,
  q: number,
  peak: number,
  length: number,
): void {
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.exponentialRampToValueAtTime(f1, t + length);
  // A little irregularity in the friction: vibrato at a few Hz.
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 7 + Math.random() * 9;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = f0 * 0.12;
  lfo.connect(lfoGain).connect(osc.frequency);
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = band;
  filter.Q.value = q;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + length * 0.25);
  gain.gain.exponentialRampToValueAtTime(peak * 0.6, t + length * 0.7);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
  osc.connect(filter).connect(gain).connect(out);
  osc.start(t);
  lfo.start(t);
  osc.stop(t + length + 0.05);
  lfo.stop(t + length + 0.05);
}

function ready(): { ctx: AudioContext; out: GainNode } | null {
  const ctx = audio.context();
  const out = audio.output();
  if (!ctx || !out || ctx.state !== 'running') return null;
  return { ctx, out };
}

export const mechAudio = {
  /** Aluminium ladder creak; intensity 0..1 (louder, higher, longer when you wobble). */
  ladderCreak(intensity: number): void {
    const a = ready();
    if (!a) return;
    const { ctx, out } = a;
    const t = ctx.currentTime;
    const k = Math.min(1, Math.max(0.1, intensity));
    const f0 = 46 + Math.random() * 30 + k * 30;
    groan(ctx, out, t, f0, f0 * (0.7 + Math.random() * 0.2), 1300 + Math.random() * 900, 7, 0.05 + 0.14 * k, 0.22 + 0.35 * k);
    // the metal sings a little
    if (Math.random() < 0.5 + k * 0.5) {
      const ring = 1700 + Math.random() * 600;
      partial(ctx, out, 'sine', ring, t + 0.02, 0.005, 0.02 + 0.04 * k, 0.35);
      partial(ctx, out, 'sine', ring * 1.63, t + 0.02, 0.005, 0.012 + 0.02 * k, 0.25);
    }
  },

  /** A boot on an aluminium rung: hollow clank. */
  ladderClank(intensity = 0.6): void {
    const a = ready();
    if (!a) return;
    const { ctx, out } = a;
    const t = ctx.currentTime;
    const base = 520 + Math.random() * 120;
    const v = 0.05 + 0.1 * intensity;
    partial(ctx, out, 'sine', base, t, 0.003, v, 0.32);
    partial(ctx, out, 'sine', base * 1.58, t, 0.003, v * 0.6, 0.24);
    partial(ctx, out, 'sine', base * 2.71, t, 0.003, v * 0.35, 0.16);
    noise(ctx, out, 'bandpass', 2600, 2, t, 0.002, v * 1.2, 0.04);
  },

  /** Wooden log groan (lower, softer than the ladder). */
  logCreak(intensity: number): void {
    const a = ready();
    if (!a) return;
    const { ctx, out } = a;
    const t = ctx.currentTime;
    const k = Math.min(1, Math.max(0.1, intensity));
    const f0 = 26 + Math.random() * 14;
    groan(ctx, out, t, f0, f0 * 0.8, 420 + Math.random() * 260, 4, 0.05 + 0.12 * k, 0.4 + 0.4 * k);
  },

  /** Carabiner gate opening on the rope and snapping shut. */
  snap(): void {
    const a = ready();
    if (!a) return;
    const { ctx, out } = a;
    const t = ctx.currentTime;
    noise(ctx, out, 'highpass', 3500, 0.8, t, 0.002, 0.25, 0.025);
    partial(ctx, out, 'triangle', 2900, t, 0.002, 0.05, 0.05);
    // gate closes
    noise(ctx, out, 'highpass', 4200, 0.8, t + 0.075, 0.002, 0.35, 0.03);
    partial(ctx, out, 'triangle', 3400 + Math.random() * 200, t + 0.075, 0.002, 0.08, 0.09);
    partial(ctx, out, 'sine', 5100, t + 0.075, 0.002, 0.03, 0.18);
  },

  /** The clip hopping across an anchor: a metallic clack and a zip of rope. */
  anchorPass(): void {
    const a = ready();
    if (!a) return;
    const { ctx, out } = a;
    const t = ctx.currentTime;
    partial(ctx, out, 'triangle', 1500 + Math.random() * 200, t, 0.002, 0.09, 0.12);
    noise(ctx, out, 'bandpass', 2200, 3, t, 0.002, 0.25, 0.05);
    this.snap();
  },

  /** The sling or rope going taut: a low twang and creak. */
  tug(strength = 1): void {
    const a = ready();
    if (!a) return;
    const { ctx, out } = a;
    const t = ctx.currentTime;
    partial(ctx, out, 'triangle', 150 + Math.random() * 30, t, 0.004, 0.12 * strength, 0.18, 95);
    noise(ctx, out, 'lowpass', 500, 1, t, 0.004, 0.18 * strength, 0.12);
  },

  /** A gust of wind sweeping across the ledge (~2 s). */
  gust(strength: number): void {
    const a = ready();
    if (!a) return;
    const { ctx, out } = a;
    const t = ctx.currentTime;
    const buffer = audio.noiseBuffer();
    if (!buffer) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 1.4;
    filter.frequency.setValueAtTime(260, t);
    filter.frequency.exponentialRampToValueAtTime(900 + 500 * strength, t + 0.9);
    filter.frequency.exponentialRampToValueAtTime(320, t + 2.3);
    const gain = ctx.createGain();
    const peak = 0.12 + 0.3 * Math.min(1, strength);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + 0.8);
    gain.gain.exponentialRampToValueAtTime(peak * 0.7, t + 1.4);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
    src.connect(filter).connect(gain).connect(out);
    src.start(t, Math.random());
    src.stop(t + 2.5);
  },

  /** Losing your footing: a scrape and a falling groan. */
  slip(): void {
    const a = ready();
    if (!a) return;
    const { ctx, out } = a;
    const t = ctx.currentTime;
    noise(ctx, out, 'bandpass', 2400, 2.5, t, 0.01, 0.3, 0.35, 1.3);
    groan(ctx, out, t, 90, 38, 900, 5, 0.18, 0.7);
    partial(ctx, out, 'sine', 2100, t + 0.05, 0.004, 0.06, 0.6, 1400);
  },

  /** Falling into the river. */
  splash(): void {
    const a = ready();
    if (!a) return;
    const { ctx, out } = a;
    const t = ctx.currentTime;
    const f = noise(ctx, out, 'lowpass', 3000, 0.7, t, 0.01, 0.55, 1.1);
    f?.frequency.exponentialRampToValueAtTime(380, t + 1.0);
    noise(ctx, out, 'bandpass', 900, 1.2, t, 0.005, 0.3, 0.25);
    for (let i = 0; i < 6; i++) {
      const start = t + 0.15 + Math.random() * 0.7;
      const f0 = 350 + Math.random() * 500;
      partial(ctx, out, 'sine', f0, start, 0.004, 0.04, 0.07, f0 * 2.2);
    }
  },
};
