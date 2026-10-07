/**
 * The generative ambient pad that takes over from the recorded score on the
 * long stretches. Two layers of four-note chords (pairs of slightly detuned
 * saws plus a soft sub) crossfade on each chord change, so a retune only
 * ever happens on a silent layer; slow low-pass sweeps keep it breathing,
 * and sparse bell "glints" drift over the top into the reverb.
 */

import { DAY_PALETTE, midiToHz, nextChord, nextGlint, NIGHT_PALETTE, type Palette } from './harmony.js';
import { filter, Gate, gainNode, glide, type Kit } from './synth.js';

/** Per-oscillator level; eight saws + sub land around -32 dBFS RMS. */
const OSC_LEVEL = 0.017;
const SUB_LEVEL = 0.014;
/** Layer crossfade time constant (a chord change takes ~6 s). */
const XFADE_TC = 2;
/** A layer must have been silent this long before it is retuned. */
const RETUNE_QUIET = 7.5;

class PadLayer {
  readonly saws: OscillatorNode[] = [];
  readonly sub: OscillatorNode;
  readonly filter: BiquadFilterNode;
  readonly gate: Gate;
  /** When this layer last started fading out. */
  fadedAt = -1e9;
  readonly last = [-1];

  constructor(kit: Kit, dest: AudioNode, spread: number) {
    const ctx = kit.ctx;
    this.gate = new Gate(ctx, dest, XFADE_TC);
    this.filter = filter(ctx, 'lowpass', 800, 0.9);
    this.filter.connect(this.gate.node);
    const sum = gainNode(ctx, OSC_LEVEL);
    sum.connect(this.filter);
    for (let i = 0; i < 8; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      // Each layer beats at its own slightly different rate.
      osc.detune.value = (i % 2 === 0 ? -1 : 1) * (5 + i * 0.7 + spread);
      osc.connect(sum);
      osc.start();
      this.saws.push(osc);
    }
    this.sub = ctx.createOscillator();
    const subGain = gainNode(ctx, SUB_LEVEL);
    this.sub.connect(subGain).connect(this.gate.node);
    this.sub.start();
  }

  retune(chord: number[], t: number): void {
    for (let i = 0; i < 8; i++) {
      this.saws[i].frequency.setValueAtTime(midiToHz(chord[i >> 1]), t);
    }
    this.sub.frequency.setValueAtTime(midiToHz(chord[0] - 12), t);
  }
}

export class Pad {
  private readonly layers: [PadLayer, PadLayer];
  private readonly out: GainNode;
  private readonly glintBus: GainNode;
  private palette: Palette | null = null;
  private active = 0;
  private chord = 0;
  private nextChange = 0;
  private glintIndex = 3;
  private nextGlint = 0;
  private sweepPhase = 0;
  /** True once the active layer is sounding. */
  private sounding = false;
  /** The next chord change starts the (new) palette's tonic. */
  private toTonic = false;

  constructor(private readonly kit: Kit, dest: AudioNode) {
    const ctx = kit.ctx;
    this.out = gainNode(ctx, 1);
    this.out.connect(dest);
    const send = gainNode(ctx, 0.55);
    this.out.connect(send).connect(kit.reverb);
    this.layers = [new PadLayer(kit, this.out, 0), new PadLayer(kit, this.out, 1.6)];
    this.glintBus = gainNode(ctx, 0.35);
    this.glintBus.connect(dest);
    const glintSend = gainNode(ctx, 0.9);
    this.glintBus.connect(glintSend).connect(kit.reverb);
    this.sweepPhase = kit.rng() * 10;
  }

  get playing(): boolean {
    return this.palette !== null;
  }

  /** Choose the day or night palette, or null to fade the pad out. */
  setPalette(id: 'day' | 'night' | null, now: number): void {
    const next = id === 'day' ? DAY_PALETTE : id === 'night' ? NIGHT_PALETTE : null;
    if (next === this.palette) return;
    this.palette = next;
    if (!next) {
      if (this.sounding) this.layers[this.active].fadedAt = now;
      this.sounding = false;
      return;
    }
    // Start (or move to the new palette) on its tonic, via the quiet layer.
    this.toTonic = true;
    this.nextChange = now;
    this.nextGlint = now + 8 + this.kit.rng() * 6;
  }

  /** brightness 0..1 scales the filter (storms and whiteouts darken it). */
  tick(now: number, dt: number, brightness: number, level: number): void {
    const p = this.palette;
    const [a, b] = this.layers;
    if (!p) {
      a.gate.set(0, now, 3);
      b.gate.set(0, now, 3);
      return;
    }
    // Chord change: retune the silent layer, then crossfade to it.
    if (now >= this.nextChange) {
      const idle = this.sounding ? 1 - this.active : this.active;
      const target = this.layers[idle];
      const other = this.layers[1 - idle];
      const quietLongEnough = now - target.fadedAt > RETUNE_QUIET || !target.gate.open;
      if (quietLongEnough) {
        this.chord = this.toTonic ? 0 : nextChord(p, this.chord, this.kit.rng);
        this.toTonic = false;
        target.retune(p.chords[this.chord], now);
        if (this.sounding) other.fadedAt = now;
        this.active = idle;
        this.sounding = true;
        this.nextChange = now + p.chordMin + this.kit.rng() * (p.chordMax - p.chordMin);
      }
    }
    this.sweepPhase += dt;
    for (let i = 0; i < 2; i++) {
      const layer = this.layers[i];
      const on = this.sounding && i === this.active;
      layer.gate.set(on ? level : 0, now, on ? XFADE_TC * 1.4 : XFADE_TC);
      const sweep = 0.5 + 0.5 * Math.sin(this.sweepPhase * ((Math.PI * 2) / 29) + i * 1.9);
      const cutoff = p.cutoff * (0.55 + 0.9 * sweep) * (0.45 + 0.55 * brightness);
      glide(layer.filter.frequency, cutoff, now, 0.8, layer.last, 0, 5);
    }
    if (this.sounding && now >= this.nextGlint && level > 0.05) {
      this.nextGlint = now + p.glintMin + this.kit.rng() * p.glintRand;
      this.glintIndex = nextGlint(p, this.glintIndex, this.kit.rng);
      this.glint(midiToHz(p.glints[this.glintIndex]), now + 0.02, level);
      // Now and then a second note answers.
      if (this.kit.rng() < 0.3) {
        this.glintIndex = nextGlint(p, this.glintIndex, this.kit.rng);
        this.glint(midiToHz(p.glints[this.glintIndex]), now + 0.5 + this.kit.rng() * 0.4, level * 0.7);
      }
    }
  }

  /** A soft bell: sine plus a quiet octave, long decay. */
  private glint(freq: number, t: number, level: number): void {
    const ctx = this.kit.ctx;
    const g = gainNode(ctx, 0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.05 * level, t + 0.012);
    g.gain.setTargetAtTime(0, t + 0.012, 0.7);
    g.connect(this.glintBus);
    const o1 = ctx.createOscillator();
    o1.frequency.value = freq;
    const o2 = ctx.createOscillator();
    o2.frequency.value = freq * 2.001;
    const o2g = gainNode(ctx, 0.22);
    o1.connect(g);
    o2.connect(o2g).connect(g);
    o1.start(t);
    o2.start(t);
    o1.stop(t + 4);
    o2.stop(t + 4);
  }

  sleep(now: number): void {
    this.palette = null;
    this.sounding = false;
    for (const layer of this.layers) {
      layer.gate.close(now);
      layer.fadedAt = -1e9;
    }
  }
}
