/**
 * Footsteps from head travel, voiced by surface: crisp packed snow in the
 * valley, soft powder under the pines, gravelly scrape on the moraine,
 * crunchy firn on the glacier, squeaky bitter-cold snow on the night ridge,
 * a hollow log on the bridge and ringing rungs on the crevasse ladder.
 * Quieter than the pole crunch they accompany.
 */

import { clamp } from '../exp-route.js';
import { StepClock, surfaceAt, type Surface } from './sound-plan.js';
import { filter, gainNode, grainShot, type Kit, noiseShot, stereo, toneShot } from './synth.js';
import type { SoundFrame } from './frame.js';

export class Footsteps {
  private readonly clock = new StepClock();
  private readonly left: AudioNode;
  private readonly right: AudioNode;

  constructor(private readonly kit: Kit, dest: AudioNode) {
    const ctx = kit.ctx;
    // A gentle low-mid body so steps feel underfoot rather than in the ears.
    const bus = filter(ctx, 'peaking', 260, 0.8, 3);
    bus.connect(dest);
    const send = gainNode(ctx, 0.05);
    bus.connect(send).connect(kit.reverb);
    this.left = stereo(ctx, -0.18);
    this.right = stereo(ctx, 0.18);
    this.left.connect(bus);
    this.right.connect(bus);
  }

  reset(): void {
    this.clock.reset();
  }

  tick(f: SoundFrame): void {
    if (!f.walking) {
      this.clock.reset();
      return;
    }
    const side = this.clock.advance(f.moved, f.dt, f.speed);
    if (side === 0) return;
    const surface = surfaceAt(f.s, f.hx, f.hz, f.daylight);
    const vol = clamp(0.5 + f.speed * 0.25, 0.5, 1.1);
    // A little ahead so the envelope never starts in the past.
    this.step(surface, f.now + 0.01, vol, side < 0 ? this.left : this.right);
  }

  step(surface: Surface, t: number, vol: number, dest: AudioNode): void {
    const kit = this.kit;
    const rng = kit.rng;
    const v = vol * (0.85 + rng() * 0.3);
    switch (surface) {
      case 'packed':
        grainShot(kit, kit.white, dest, t, 'bandpass', 1150 + rng() * 450, 0.9, 5, 0.07, 0.15 * v, 0.012);
        noiseShot(kit, kit.pink, dest, t, 'lowpass', 300, 0.7, 0.005, 0.09, 0.12 * v);
        break;
      case 'powder':
        noiseShot(kit, kit.pink, dest, t, 'lowpass', 600 + rng() * 150, 0.7, 0.03, 0.22, 0.2 * v);
        grainShot(kit, kit.white, dest, t + 0.02, 'bandpass', 900, 1, 3, 0.12, 0.05 * v, 0.02);
        break;
      case 'gravel':
        grainShot(kit, kit.white, dest, t, 'bandpass', 2400 + rng() * 800, 0.9, 10, 0.14, 0.11 * v, 0.008);
        noiseShot(kit, kit.pink, dest, t, 'lowpass', 350, 0.7, 0.004, 0.08, 0.09 * v);
        toneShot(kit, dest, t + 0.02 + rng() * 0.06, 'triangle', 1300 + rng() * 1300, 0.001, 0.025, 0.035 * v);
        if (rng() < 0.5) {
          toneShot(kit, dest, t + 0.06 + rng() * 0.07, 'triangle', 1700 + rng() * 1100, 0.001, 0.02, 0.025 * v);
        }
        break;
      case 'firn':
        grainShot(kit, kit.white, dest, t, 'bandpass', 1700 + rng() * 400, 1.3, 6, 0.09, 0.2 * v, 0.01);
        grainShot(kit, kit.white, dest, t + 0.005, 'highpass', 4500, 0.7, 4, 0.08, 0.045 * v, 0.006);
        noiseShot(kit, kit.pink, dest, t, 'lowpass', 320, 0.7, 0.004, 0.07, 0.1 * v);
        break;
      case 'squeak': {
        grainShot(kit, kit.white, dest, t, 'bandpass', 1300 + rng() * 300, 1, 4, 0.06, 0.11 * v, 0.01);
        noiseShot(kit, kit.pink, dest, t, 'lowpass', 300, 0.7, 0.004, 0.08, 0.08 * v);
        // The squeal of snow too cold to melt under the boot.
        const ctx = kit.ctx;
        const f0 = 700 + rng() * 300;
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(f0, t + 0.02);
        osc.frequency.exponentialRampToValueAtTime(f0 * 1.25, t + 0.12);
        const bp = filter(ctx, 'bandpass', f0 * 2.2, 6);
        const g = gainNode(ctx, 0);
        g.gain.setValueAtTime(0, t + 0.02);
        g.gain.linearRampToValueAtTime(0.03 * v, t + 0.04);
        g.gain.linearRampToValueAtTime(0.02 * v, t + 0.09);
        g.gain.linearRampToValueAtTime(0, t + 0.14);
        osc.connect(bp).connect(g).connect(dest);
        osc.start(t + 0.02);
        osc.stop(t + 0.16);
        break;
      }
      case 'wood':
        toneShot(kit, dest, t, 'sine', 125, 0.003, 0.15, 0.18 * v, 92);
        toneShot(kit, dest, t, 'triangle', 250, 0.002, 0.07, 0.045 * v);
        noiseShot(kit, kit.pink, dest, t, 'lowpass', 520, 0.8, 0.003, 0.06, 0.1 * v);
        break;
      case 'metal':
        toneShot(kit, dest, t, 'triangle', 640, 0.001, 0.3, 0.03 * v);
        toneShot(kit, dest, t, 'sine', 1712, 0.001, 0.22, 0.018 * v);
        noiseShot(kit, kit.white, dest, t, 'highpass', 3000, 0.7, 0.001, 0.015, 0.05 * v);
        break;
    }
  }
}
