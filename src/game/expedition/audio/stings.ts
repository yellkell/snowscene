/**
 * Short musical stings the director can request at moments, and the low
 * danger bed (a heartbeat pulse over a dark minor-second drone) the FX
 * agent raises during avalanches and rockfall.
 *
 * Stings lean on open fifths, octaves and bells so they sit reasonably over
 * either recorded track; the engine also ducks the score under them.
 */

import { midiToHz } from './harmony.js';
import { filter, Gate, gainNode, glide, type Kit, noiseShot, toneShot } from './synth.js';

export type StingId = 'summit' | 'camp' | 'danger' | 'breakout' | 'aurora' | 'checkpoint' | 'finale';

/** How long each sting ducks the score (seconds). */
export const STING_LENGTH: Record<StingId, number> = {
  summit: 5,
  camp: 3,
  danger: 3,
  breakout: 5,
  aurora: 5,
  checkpoint: 2,
  finale: 6,
};

export class Stings {
  private readonly out: GainNode;

  constructor(private readonly kit: Kit, dest: AudioNode) {
    this.out = gainNode(kit.ctx, 1);
    this.out.connect(dest);
    this.out.connect(gainNode(kit.ctx, 0.5)).connect(kit.reverb);
  }

  play(id: StingId): void {
    const t = this.kit.ctx.currentTime + 0.03;
    switch (id) {
      case 'summit':
        this.swell(t, [50, 57, 62, 69, 74], 4.5, 0.035, 'sawtooth', 350, 2400);
        this.bells(t + 0.6, [74, 78, 81, 86], 0.19, 0.05);
        break;
      case 'finale':
        this.swell(t, [38, 50, 57, 62, 69, 74, 81], 6, 0.04, 'sawtooth', 300, 3200);
        this.bells(t + 0.4, [74, 78, 81, 86, 90, 93], 0.16, 0.05);
        this.bells(t + 2.4, [86, 81, 78, 74], 0.24, 0.035);
        break;
      case 'camp':
        this.swell(t, [43, 55, 62, 67], 2.8, 0.03, 'triangle', 500, 1600);
        this.bells(t + 0.35, [74, 79], 0.28, 0.04);
        break;
      case 'checkpoint':
        this.bells(t, [79, 86], 0.16, 0.035);
        break;
      case 'breakout':
        this.swell(t, [57, 64, 69], 4.5, 0.025, 'triangle', 600, 2000);
        this.bells(t + 0.2, [69, 76, 81, 85, 88], 0.13, 0.03);
        break;
      case 'aurora':
        this.swell(t, [76, 83, 88, 95], 5, 0.009, 'sine', 4000, 6000);
        break;
      case 'danger':
        this.swell(t, [38, 39, 45], 2.6, 0.05, 'sawtooth', 120, 900);
        toneShot(this.kit, this.out, t, 'sine', 72, 0.005, 1.3, 0.22, 38);
        noiseShot(this.kit, this.kit.white, this.out, t, 'bandpass', 2200, 0.5, 0.8, 0.12, 0.035);
        break;
    }
  }

  /** A chord that swells in and opens its filter, then fades. */
  private swell(
    t: number,
    notes: number[],
    dur: number,
    peak: number,
    type: OscillatorType,
    cutFrom: number,
    cutTo: number,
  ): void {
    const ctx = this.kit.ctx;
    const lp = filter(ctx, 'lowpass', cutFrom, 0.8);
    lp.frequency.setValueAtTime(cutFrom, t);
    lp.frequency.exponentialRampToValueAtTime(cutTo, t + dur * 0.4);
    lp.frequency.exponentialRampToValueAtTime(Math.max(200, cutFrom), t + dur);
    const g = gainNode(ctx, 0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + dur * 0.3);
    g.gain.setTargetAtTime(0, t + dur * 0.45, dur * 0.18);
    lp.connect(g).connect(this.out);
    for (let i = 0; i < notes.length; i++) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = midiToHz(notes[i]);
      osc.detune.value = (i % 2 === 0 ? -4 : 4) + i;
      osc.connect(lp);
      osc.start(t);
      osc.stop(t + dur * 1.4);
    }
  }

  /** Bell arpeggio: sine + octave partial, long ring. */
  private bells(t: number, notes: number[], spacing: number, peak: number): void {
    for (let i = 0; i < notes.length; i++) {
      const f = midiToHz(notes[i]);
      const at = t + i * spacing;
      toneShot(this.kit, this.out, at, 'sine', f, 0.006, 2.6, peak);
      toneShot(this.kit, this.out, at, 'sine', f * 2.001, 0.004, 1.2, peak * 0.2);
    }
  }
}

/** Low pulse + drone, 0..1. Built once; gated off when calm. */
export class DangerBed {
  private readonly gate: Gate;
  private readonly pulse: GainNode;
  private readonly droneLP: BiquadFilterNode;
  private readonly droneAmt: GainNode;
  private nextBeat = 0;
  private readonly last = [-1, -1];

  constructor(private readonly kit: Kit, dest: AudioNode) {
    const ctx = kit.ctx;
    this.gate = new Gate(ctx, dest, 0.5);
    // Heartbeat: a low sine with harmonics so small speakers still carry it.
    this.pulse = gainNode(ctx, 0);
    const pulseLP = filter(ctx, 'lowpass', 300, 0.7);
    this.pulse.connect(pulseLP).connect(this.gate.node);
    for (const [freq, type, level] of [
      [55, 'sine', 1],
      [110, 'triangle', 0.6],
      [165, 'sine', 0.35],
    ] as Array<[number, OscillatorType, number]>) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      osc.connect(gainNode(ctx, level * 0.12)).connect(this.pulse);
      osc.start();
    }
    // Drone: A1 against B-flat1, slowly opening with the danger.
    this.droneLP = filter(ctx, 'lowpass', 140, 2);
    this.droneAmt = gainNode(ctx, 0);
    this.droneLP.connect(this.droneAmt).connect(this.gate.node);
    for (const freq of [55, 58.27]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      osc.connect(this.droneLP);
      osc.start();
    }
  }

  tick(now: number, danger: number): void {
    this.gate.set(danger > 0.01 ? Math.min(1, danger * 1.2) : 0, now, 0.4);
    if (!this.gate.open) {
      this.nextBeat = 0;
      return;
    }
    glide(this.droneLP.frequency, 130 + 380 * danger, now, 0.5, this.last, 0, 4);
    glide(this.droneAmt.gain, 0.05 * Math.pow(danger, 1.5), now, 0.4, this.last, 1, 0.002);
    // Lub-dub, quicker as it gets worse; scheduled a little ahead.
    if (this.nextBeat < now) this.nextBeat = now + 0.05;
    const until = now + 0.2;
    const p = this.pulse.gain;
    while (this.nextBeat < until && danger > 0.01) {
      const t = this.nextBeat;
      const interval = 1 / (0.9 + 1.5 * danger);
      p.setTargetAtTime(1, t, 0.008);
      p.setTargetAtTime(0, t + 0.06, 0.07);
      p.setTargetAtTime(0.65, t + 0.22, 0.008);
      p.setTargetAtTime(0, t + 0.28, 0.08);
      this.nextBeat = t + Math.max(0.42, interval);
    }
  }

  sleep(now: number): void {
    this.gate.close(now);
    this.nextBeat = 0;
  }
}
