/**
 * One-shot voices of the mountain: birds, an owl, ice groans and creaks,
 * distant cracks, rock trickles, water bubbles, tent flaps, the campfire
 * guitarist's plucks and positional event sounds (rumble, impact). Each
 * call builds a handful of short-lived nodes into `dest` and returns the
 * sound's length in seconds.
 */

import { midiToHz } from './harmony.js';
import { filter, gainNode, grainShot, type Kit, noiseShot, toneShot } from './synth.js';

/** A songbird phrase: one sine voice with a slight warble. */
export function bird(kit: Kit, dest: AudioNode, t: number, peak: number): number {
  const ctx = kit.ctx;
  const rng = kit.rng;
  const osc = ctx.createOscillator();
  const vib = ctx.createOscillator();
  vib.frequency.value = 30 + rng() * 55;
  const vibAmt = gainNode(ctx, 0);
  vib.connect(vibAmt).connect(osc.frequency);
  const g = gainNode(ctx, 0);
  osc.connect(g).connect(dest);
  let at = t;
  const note = (f0: number, f1: number, dur: number, level: number) => {
    osc.frequency.setValueAtTime(f0, at);
    osc.frequency.exponentialRampToValueAtTime(f1, at + dur);
    vibAmt.gain.setValueAtTime(f0 * 0.012, at);
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(level, at + Math.min(0.01, dur * 0.3));
    g.gain.linearRampToValueAtTime(level * 0.6, at + dur * 0.8);
    g.gain.linearRampToValueAtTime(0, at + dur);
    at += dur;
  };
  const pitch = 0.85 + rng() * 0.3;
  const species = Math.floor(rng() * 3);
  if (species === 0) {
    // "Tee-chu, tee-chu": a two-note see-saw.
    const reps = 2 + Math.floor(rng() * 3);
    for (let i = 0; i < reps; i++) {
      note(4300 * pitch, 3900 * pitch, 0.07, peak);
      at += 0.05;
      note(3000 * pitch, 2800 * pitch, 0.09, peak * 0.85);
      at += 0.12 + rng() * 0.04;
    }
  } else if (species === 1) {
    // Descending trill with a flourish.
    const n = 7 + Math.floor(rng() * 6);
    for (let i = 0; i < n; i++) {
      const f = (4800 - (1200 * i) / n) * pitch;
      note(f, f * 0.85, 0.035, peak * (0.7 + 0.3 * (i / n)));
      at += 0.028 - (0.01 * i) / n;
    }
    at += 0.04;
    note(3200 * pitch, 4200 * pitch, 0.12, peak);
  } else {
    // A wandering whistled phrase.
    const n = 4 + Math.floor(rng() * 4);
    for (let i = 0; i < n; i++) {
      const f = (2400 + rng() * 2800) * pitch;
      const sweep = rng() < 0.5 ? 0.78 + rng() * 0.15 : 1.1 + rng() * 0.2;
      note(f, f * sweep, 0.06 + rng() * 0.09, peak * (0.6 + 0.4 * rng()));
      at += 0.04 + rng() * 0.08;
    }
  }
  osc.start(t);
  vib.start(t);
  osc.stop(at + 0.05);
  vib.stop(at + 0.05);
  return at - t;
}

/** A tawny owl: a long hoot, a pause, then "hu... hoooo" with a tremolo. */
export function owl(kit: Kit, dest: AudioNode, t: number, peak: number): number {
  const ctx = kit.ctx;
  const f = 360 + kit.rng() * 60;
  const osc = ctx.createOscillator();
  const h2 = ctx.createOscillator();
  const h2g = gainNode(ctx, 0.1);
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 7.5;
  const lfoAmt = gainNode(ctx, 0);
  lfo.connect(lfoAmt).connect(osc.frequency);
  const lp = filter(ctx, 'lowpass', 1100, 0.7);
  const g = gainNode(ctx, 0);
  osc.connect(lp);
  h2.connect(h2g).connect(lp);
  lp.connect(g).connect(dest);
  const hoot = (at: number, dur: number, f0: number, f1: number, level: number) => {
    osc.frequency.setValueAtTime(f0, at);
    osc.frequency.linearRampToValueAtTime(f1, at + dur);
    h2.frequency.setValueAtTime(f0 * 2, at);
    h2.frequency.linearRampToValueAtTime(f1 * 2, at + dur);
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(level, at + Math.min(0.09, dur * 0.3));
    g.gain.linearRampToValueAtTime(level * 0.75, at + dur * 0.75);
    g.gain.linearRampToValueAtTime(0, at + dur);
  };
  hoot(t, 0.7, f * 1.05, f * 0.97, peak);
  const t2 = t + 0.7 + 1.6 + kit.rng() * 0.8;
  hoot(t2, 0.14, f * 1.02, f, peak * 0.6);
  const t3 = t2 + 0.38;
  hoot(t3, 1.15, f, f * 0.93, peak * 0.9);
  lfoAmt.gain.setValueAtTime(0, t3 + 0.25);
  lfoAmt.gain.linearRampToValueAtTime(f * 0.03, t3 + 0.6);
  const end = t3 + 1.2;
  for (const o of [osc, h2, lfo]) {
    o.start(t);
    o.stop(end);
  }
  return end - t;
}

/** A deep groan from inside the glacier. */
export function groan(kit: Kit, dest: AudioNode, t: number, peak: number): number {
  const ctx = kit.ctx;
  const rng = kit.rng;
  const dur = 2.2 + rng() * 2;
  const f0 = 38 + rng() * 26;
  const lp = filter(ctx, 'lowpass', 150, 4);
  lp.frequency.setValueAtTime(140, t);
  lp.frequency.linearRampToValueAtTime(300 + rng() * 80, t + dur * 0.5);
  lp.frequency.linearRampToValueAtTime(120, t + dur);
  const g = gainNode(ctx, 0);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + dur * 0.35);
  g.gain.linearRampToValueAtTime(peak * 0.8, t + dur * 0.6);
  g.gain.linearRampToValueAtTime(0, t + dur);
  lp.connect(g).connect(dest);
  for (const detune of [1, 1.007]) {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(f0 * detune, t);
    osc.frequency.linearRampToValueAtTime(f0 * detune * (1.12 + rng() * 0.25), t + dur * 0.55);
    osc.frequency.linearRampToValueAtTime(f0 * detune * (0.85 + rng() * 0.1), t + dur);
    osc.connect(lp);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }
  // Grinding underneath.
  noiseShot(kit, kit.brown, dest, t + dur * 0.15, 'lowpass', 180, 0.8, dur * 0.3, dur * 0.6, peak * 1.6);
  return dur;
}

/** Ice (or a tent pole, or a ladder) creaking: a slow click train ringing a resonance. */
export function creak(kit: Kit, dest: AudioNode, t: number, peak: number, body = 0): number {
  const ctx = kit.ctx;
  const rng = kit.rng;
  const dur = 0.35 + rng() * 0.8;
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  const r0 = 16 + rng() * 22;
  osc.frequency.setValueAtTime(r0, t);
  osc.frequency.exponentialRampToValueAtTime(r0 * (0.7 + rng() * 0.9), t + dur);
  const bp = filter(ctx, 'bandpass', body || 700 + rng() * 1200, 9);
  const g = gainNode(ctx, 0);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + 0.04);
  g.gain.linearRampToValueAtTime(peak * (0.5 + rng() * 0.5), t + dur * 0.7);
  g.gain.linearRampToValueAtTime(0, t + dur);
  osc.connect(bp).connect(g).connect(dest);
  osc.start(t);
  osc.stop(t + dur + 0.05);
  return dur;
}

/** A sharp ice crack and its long rolling tail. */
export function crack(kit: Kit, dest: AudioNode, t: number, peak: number): number {
  noiseShot(kit, kit.white, dest, t, 'bandpass', 1800, 0.7, 0.002, 0.06, peak * 0.6);
  noiseShot(kit, kit.white, dest, t + 0.004, 'bandpass', 900, 1, 0.002, 0.25, peak * 0.35);
  noiseShot(kit, kit.brown, dest, t + 0.01, 'lowpass', 240, 0.7, 0.03, 2.2, peak * 1.3, 90);
  return 2.4;
}

/** A few stones clattering down a distant slope. */
export function rocks(kit: Kit, dest: AudioNode, t: number, peak: number): number {
  const rng = kit.rng;
  const n = 3 + Math.floor(rng() * 5);
  let at = t;
  for (let i = 0; i < n; i++) {
    const level = peak * (1 - (0.6 * i) / n) * (0.6 + 0.4 * rng());
    toneShot(kit, dest, at, 'triangle', 1100 + rng() * 1500, 0.001, 0.03 + rng() * 0.03, level * 0.7);
    noiseShot(kit, kit.white, dest, at, 'bandpass', 2600 + rng() * 1200, 1.5, 0.001, 0.025, level * 0.8);
    at += 0.07 + rng() * 0.2 * (1 + i / n);
  }
  noiseShot(kit, kit.pink, dest, t, 'lowpass', 900, 0.7, 0.08, at - t + 0.4, peak * 0.25);
  return at - t + 0.4;
}

/** A water bubble: a tiny rising sine blip. */
export function bubble(kit: Kit, dest: AudioNode, t: number, peak: number, lo: number, hi: number): void {
  const f = lo + kit.rng() * (hi - lo);
  toneShot(kit, dest, t, 'sine', f, 0.004, 0.02 + kit.rng() * 0.04, peak, f * (1.4 + kit.rng() * 0.5));
}

/** Tent fabric slapping in a gust. */
export function flap(kit: Kit, dest: AudioNode, t: number, peak: number): void {
  const rng = kit.rng;
  grainShot(kit, kit.brown, dest, t, 'bandpass', 420 + rng() * 300, 0.9, 3 + Math.floor(rng() * 4), 0.35, peak, 0.05);
}

/** A plucked nylon-ish string. */
export function pluck(kit: Kit, dest: AudioNode, t: number, midi: number, vel: number): void {
  const ctx = kit.ctx;
  const f = midiToHz(midi);
  const tri = ctx.createOscillator();
  tri.type = 'triangle';
  tri.frequency.value = f;
  const saw = ctx.createOscillator();
  saw.type = 'sawtooth';
  saw.frequency.value = f * 1.003;
  const sawAmt = gainNode(ctx, 0.3);
  const lp = filter(ctx, 'lowpass', Math.min(7000, f * 10), 1.1);
  lp.frequency.setValueAtTime(Math.min(7000, f * 10), t);
  lp.frequency.exponentialRampToValueAtTime(Math.max(300, f * 1.8), t + 0.35);
  const g = gainNode(ctx, 0);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vel * 0.11, t + 0.003);
  g.gain.setTargetAtTime(0, t + 0.003, 0.3 + 60 / (f + 60));
  tri.connect(lp);
  saw.connect(sawAmt).connect(lp);
  lp.connect(g).connect(dest);
  const end = t + 1.9;
  tri.start(t);
  saw.start(t);
  tri.stop(end);
  saw.stop(end);
}

/** A long low rumble (avalanche, serac fall); call again while it lasts. */
export function rumble(kit: Kit, dest: AudioNode, t: number, peak: number): number {
  const rng = kit.rng;
  const dur = 1.1 + rng() * 0.6;
  noiseShot(kit, kit.brown, dest, t, 'lowpass', 140 + rng() * 80, 0.7, 0.2, dur, peak);
  noiseShot(kit, kit.pink, dest, t + 0.05, 'lowpass', 520, 0.7, 0.15, dur * 0.8, peak * 0.3);
  return dur;
}

/** A rock or ice block hitting the ground. */
export function impact(kit: Kit, dest: AudioNode, t: number, peak: number): number {
  noiseShot(kit, kit.pink, dest, t, 'lowpass', 320, 0.8, 0.003, 0.28, peak);
  toneShot(kit, dest, t, 'sine', 95, 0.003, 0.32, peak * 0.5, 48);
  noiseShot(kit, kit.white, dest, t, 'bandpass', 1600, 1, 0.002, 0.05, peak * 0.4);
  return 0.4;
}
