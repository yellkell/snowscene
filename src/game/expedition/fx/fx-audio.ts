/**
 * Positional one-shot sounds for the set pieces, synthesised on the shared
 * audio context (`audio.context()` / `output()` / `noiseBuffer()`).
 *
 * Each sound is placed in the world: loudness falls with distance, distant
 * sounds lose their highs and arrive late (speed of sound), and a stereo
 * pan from the listener's right vector says where to look. That direction
 * cue matters for fairness (rockfall, avalanche).
 */

import type { Vector3 } from '@iwsdk/core';
import { audio } from '../../audio.js';

const SPEED_OF_SOUND = 343;

/** Listener pose, written once per frame by the events system. */
const listener = { x: 0, y: 0, z: 0, rx: 1, rz: 0 };

export function setListener(head: Vector3, right: Vector3): void {
  listener.x = head.x;
  listener.y = head.y;
  listener.z = head.z;
  const l = Math.hypot(right.x, right.z) || 1;
  listener.rx = right.x / l;
  listener.rz = right.z / l;
}

export function listenerDistance(x: number, y: number, z: number): number {
  return Math.hypot(x - listener.x, y - listener.y, z - listener.z);
}

interface Placement {
  gain: number;
  pan: number;
  delay: number;
  cutoff: number;
}
const placement: Placement = { gain: 0, pan: 0, delay: 0, cutoff: 0 };

/**
 * Loudness/pan/delay for a source. `ref` is the distance at which the
 * sound is at half its close-up volume.
 */
function place(x: number, y: number, z: number, ref: number, delayScale = 1): Placement {
  const dx = x - listener.x;
  const dy = y - listener.y;
  const dz = z - listener.z;
  const d = Math.hypot(dx, dy, dz);
  const h = Math.hypot(dx, dz) || 1;
  placement.gain = 1 / (1 + d / ref);
  placement.pan = Math.max(-0.85, Math.min(0.85, ((dx * listener.rx + dz * listener.rz) / h) * 0.85 * Math.min(1, d / 3)));
  placement.delay = (d / SPEED_OF_SOUND) * delayScale;
  placement.cutoff = Math.max(320, 16000 * Math.exp(-d / 260));
  return placement;
}

function chain(ctx: AudioContext, p: Placement): AudioNode | null {
  const out = audio.output();
  if (!out) return null;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = p.cutoff;
  const pan = ctx.createStereoPanner();
  pan.pan.value = p.pan;
  lp.connect(pan).connect(out);
  return lp;
}

/** Filtered noise burst at a world position. */
export function noiseAt(
  x: number,
  y: number,
  z: number,
  freq: number,
  q: number,
  duration: number,
  volume: number,
  type: BiquadFilterType = 'bandpass',
  ref = 25,
  extraDelay = 0,
  attack = 0.01,
): void {
  const ctx = audio.context();
  const noise = audio.noiseBuffer();
  if (!ctx || !noise) return;
  const p = place(x, y, z, ref);
  const v = volume * p.gain;
  if (v < 0.004) return;
  const dest = chain(ctx, p);
  if (!dest) return;
  const t = ctx.currentTime + p.delay + extraDelay;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.playbackRate.value = 0.8 + Math.random() * 0.4;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = q;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(v, t + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  src.connect(filter).connect(gain).connect(dest);
  src.start(t, Math.random() * 1.5, duration + 0.1);
}

/** Pitched tone (optionally sweeping) at a world position. */
export function toneAt(
  x: number,
  y: number,
  z: number,
  freq: number,
  endFreq: number,
  duration: number,
  volume: number,
  type: OscillatorType = 'sine',
  ref = 25,
  extraDelay = 0,
  attack = 0.01,
): void {
  const ctx = audio.context();
  if (!ctx) return;
  const p = place(x, y, z, ref);
  const v = volume * p.gain;
  if (v < 0.004) return;
  const dest = chain(ctx, p);
  if (!dest) return;
  const t = ctx.currentTime + p.delay + extraDelay;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (endFreq !== freq) osc.frequency.exponentialRampToValueAtTime(endFreq, t + duration);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(v, t + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.connect(gain).connect(dest);
  osc.start(t);
  osc.stop(t + duration + 0.05);
}

/** A slab or ice fracture: sharp crack with a booming body and echoes. */
export function crackAt(x: number, y: number, z: number, volume = 1, echoes = 0): void {
  noiseAt(x, y, z, 2400, 0.8, 0.09, 0.9 * volume, 'highpass', 60);
  noiseAt(x, y, z, 150, 1.4, 0.7, 0.8 * volume, 'lowpass', 60);
  toneAt(x, y, z, 95, 45, 0.6, 0.45 * volume, 'sine', 60);
  for (let i = 1; i <= echoes; i++) {
    // Echoes off the valley walls: later, duller, quieter.
    noiseAt(x, y, z, 900 / i, 0.9, 0.5, (0.5 * volume) / (i + 0.5), 'lowpass', 60, 0.55 * i + 0.25 * i * i);
  }
}

/** Deep explosion-like thump (serac impact, firework burst). */
export function boomAt(x: number, y: number, z: number, volume = 1, ref = 60): void {
  toneAt(x, y, z, 70, 32, 1.1, 0.75 * volume, 'sine', ref, 0, 0.005);
  noiseAt(x, y, z, 260, 0.8, 1.3, 0.9 * volume, 'lowpass', ref, 0, 0.004);
  noiseAt(x, y, z, 1800, 0.7, 0.12, 0.35 * volume, 'highpass', ref * 0.6);
}

/** Rock striking rock or frozen ground. `size` ~ radius in metres. */
export function clatterAt(x: number, y: number, z: number, size: number, volume = 1): void {
  const big = Math.min(1, size / 0.6);
  noiseAt(x, y, z, 1400 + Math.random() * 1600 - big * 600, 3.5, 0.06 + big * 0.04, 0.8 * volume, 'bandpass', 22);
  toneAt(x, y, z, 260 + Math.random() * 180 - big * 120, 160, 0.12, 0.35 * volume, 'triangle', 22);
  noiseAt(x, y, z, 180 + big * 60, 1.2, 0.25 + big * 0.2, 0.55 * volume * (0.4 + big), 'lowpass', 22);
}

/** Ice blocks smashing: glassy crunch plus a few ringing shards. */
export function shatterAt(x: number, y: number, z: number, volume = 1): void {
  noiseAt(x, y, z, 3800, 1.5, 0.35, 0.6 * volume, 'bandpass', 40);
  noiseAt(x, y, z, 900, 1, 0.5, 0.5 * volume, 'bandpass', 40);
  for (let i = 0; i < 4; i++) {
    toneAt(x, y, z, 2400 + Math.random() * 2600, 1800, 0.25 + Math.random() * 0.3, 0.05 * volume, 'sine', 40, Math.random() * 0.35);
  }
}

/** A fast object hissing past close by. */
export function whooshAt(x: number, y: number, z: number, volume = 1): void {
  noiseAt(x, y, z, 700, 0.8, 0.35, 0.5 * volume, 'bandpass', 4, 0, 0.12);
}

/** Firework shell climbing: a rising whistle. */
export function whistleAt(x: number, y: number, z: number, duration: number, volume = 1): void {
  toneAt(x, y, z, 900 + Math.random() * 300, 2600 + Math.random() * 900, duration, 0.06 * volume, 'sine', 70, 0, 0.3);
  noiseAt(x, y, z, 3000, 2, duration * 0.8, 0.12 * volume, 'bandpass', 70, 0, 0.2);
}

/** Firework crackle: dozens of tiny pops spread over ~a second. */
export function crackleAt(x: number, y: number, z: number, volume = 1, pops = 18): void {
  for (let i = 0; i < pops; i++) {
    noiseAt(x, y, z, 2500 + Math.random() * 4000, 2, 0.025, 0.35 * volume, 'bandpass', 80, 0.15 + Math.random() * 1.1, 0.002);
  }
}

/**
 * Continuous low roar (avalanche, collapsing ice). Created on start and
 * torn down on stop; set() is cheap (parameter automation only).
 */
export class Roar {
  private src: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private pan: StereoPannerNode | null = null;

  get running(): boolean {
    return this.src !== null;
  }

  start(): void {
    const ctx = audio.context();
    const noise = audio.noiseBuffer();
    const out = audio.output();
    if (!ctx || !noise || !out || this.src) return;
    this.src = ctx.createBufferSource();
    this.src.buffer = noise;
    this.src.loop = true;
    this.src.playbackRate.value = 0.6;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 120;
    this.filter.Q.value = 1.1;
    const body = ctx.createBiquadFilter();
    body.type = 'peaking';
    body.frequency.value = 70;
    body.gain.value = 9;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.pan = ctx.createStereoPanner();
    this.src.connect(this.filter).connect(body).connect(this.gain).connect(this.pan).connect(out);
    this.src.start();
  }

  /** level 0..1 (already distance-weighted by the caller); position for the pan. */
  set(level: number, x: number, y: number, z: number): void {
    const ctx = audio.context();
    if (!ctx || !this.gain || !this.filter || !this.pan) return;
    const t = ctx.currentTime;
    const p = place(x, y, z, 1e9);
    this.gain.gain.setTargetAtTime(Math.min(1, level) * 0.9, t, 0.25);
    this.filter.frequency.setTargetAtTime(90 + 520 * level * level, t, 0.3);
    this.pan.pan.setTargetAtTime(p.pan * 0.7, t, 0.3);
  }

  stop(fade = 1.5): void {
    const ctx = audio.context();
    const src = this.src;
    if (!ctx || !src || !this.gain) {
      this.src = null;
      return;
    }
    const t = ctx.currentTime;
    this.gain.gain.cancelScheduledValues(t);
    this.gain.gain.setValueAtTime(this.gain.gain.value, t);
    this.gain.gain.linearRampToValueAtTime(0, t + fade);
    src.stop(t + fade + 0.1);
    this.src = null;
    this.gain = null;
    this.filter = null;
    this.pan = null;
  }
}
