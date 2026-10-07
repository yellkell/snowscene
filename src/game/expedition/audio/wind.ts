/**
 * Expedition wind, layered over the shared wind bed and storm howl in
 * audio.ts (which the weather system keeps driving). We add what they lack
 * and scale them rather than doubling them:
 *
 *  - whistle: two narrow resonant bands that rise in pitch and presence
 *    with altitude (thin air over ridges and cornices), and sing in the
 *    rigging while gliding;
 *  - buffet: a low, fluttering roar on the hood in squalls, from the
 *    upwind side;
 *  - pines: soft wide "shhh" swells through the forest canopy.
 *
 * On the clear night ridge everything, including the shared bed, drops to
 * near silence so the aurora is eerily quiet.
 */

import { valueNoise } from '../../terrain.js';
import { audio } from '../../audio.js';
import { clamp, smoothstep } from '../exp-route.js';
import { filter, Gate, gainNode, glide, type Kit, loopSource, stereo } from './synth.js';
import type { SoundFrame } from './frame.js';

export class WindLayers {
  private readonly whistleGate: Gate;
  private readonly whistleA: BiquadFilterNode;
  private readonly whistleB: BiquadFilterNode;
  private readonly whistlePan: StereoPannerNode;
  private readonly buffetGate: Gate;
  private readonly buffetLP: BiquadFilterNode;
  private readonly flutter: OscillatorNode;
  private readonly flutterDepth: GainNode;
  private readonly buffetPan: StereoPannerNode;
  private readonly pineL: Gate;
  private readonly pineR: Gate;
  private readonly last = new Array<number>(8).fill(-1);
  private bedWind = -1;
  private bedHowl = -1;

  constructor(private readonly kit: Kit, dest: AudioNode) {
    const ctx = kit.ctx;

    // Whistle: white noise through two high-Q bands a wide fifth apart.
    this.whistlePan = stereo(ctx, 0);
    this.whistlePan.connect(dest);
    this.whistleGate = new Gate(ctx, this.whistlePan, 0.25);
    const whistleSrc = loopSource(kit, kit.white, 1, 0.3);
    this.whistleA = filter(ctx, 'bandpass', 1100, 24);
    this.whistleB = filter(ctx, 'bandpass', 1650, 30);
    whistleSrc.connect(this.whistleA).connect(this.whistleGate.node);
    whistleSrc.connect(this.whistleB).connect(this.whistleGate.node);

    // Buffet: low pink roar with a flutter LFO on its level.
    this.buffetPan = stereo(ctx, 0);
    this.buffetPan.connect(dest);
    this.buffetGate = new Gate(ctx, this.buffetPan, 0.3);
    const buffetSrc = loopSource(kit, kit.pink, 0.9, 1.7);
    this.buffetLP = filter(ctx, 'lowpass', 400, 0.8);
    const flutterAmp = gainNode(ctx, 0.7);
    this.flutter = ctx.createOscillator();
    this.flutter.frequency.value = 8;
    this.flutterDepth = gainNode(ctx, 0);
    this.flutter.connect(this.flutterDepth).connect(flutterAmp.gain);
    this.flutter.start();
    buffetSrc.connect(this.buffetLP).connect(flutterAmp).connect(this.buffetGate.node);

    // Pines: two decorrelated soft bands, panned wide.
    const pine = (rate: number, offset: number, freq: number, pan: number) => {
      const p = stereo(ctx, pan);
      p.connect(dest);
      const gate = new Gate(ctx, p, 0.35);
      loopSource(kit, kit.white, rate, offset)
        .connect(filter(ctx, 'bandpass', freq, 0.6))
        .connect(filter(ctx, 'lowpass', 3800, 0.5))
        .connect(gate.node);
      return gate;
    };
    this.pineL = pine(0.97, 1.3, 1250, -0.6);
    this.pineR = pine(1.03, 2.9, 1850, 0.6);
  }

  tick(f: SoundFrame): void {
    const now = f.now;
    const z = f.zones;
    const storm = f.storm;
    const gust = f.gust;
    const alt = smoothstep(220, 1150, f.hy);
    // Clear night on the ridge (and the calm pre-dawn summit): hush.
    const calm = 1 - smoothstep(0.04, 0.3, storm);
    const nightCalm = f.flying ? 0 : clamp((z.ridge + z.summit * 0.55) * calm, 0, 1);
    const windiness = clamp(0.08 + storm * 1.1 + f.squall * 0.5, 0, 1) * (0.45 + 0.55 * gust);

    // Shared bed: hush it at night, shelter it under the trees.
    const bedWind = f.flying ? 1 : (1 - 0.88 * nightCalm) * (1 - 0.3 * z.forest);
    const bedHowl = f.flying ? 1 : 1 - 0.6 * nightCalm;
    if (Math.abs(bedWind - this.bedWind) > 0.01 || Math.abs(bedHowl - this.bedHowl) > 0.01) {
      this.bedWind = bedWind;
      this.bedHowl = bedHowl;
      audio.setWeatherBedScale(bedWind, bedHowl);
    }

    // Wind arrives from upwind: pan toward that ear.
    const pan = clamp(-(f.windX * f.rx + f.windZ * f.rz) * 0.55, -0.7, 0.7);

    // Whistle: altitude and wind, or the glider's rigging at speed.
    const wander = valueNoise(f.time * 0.07, 4.2);
    const whistleFreq = 640 + 950 * alt + 260 * gust + 110 * wander + (f.flying ? f.airspeed * 22 : 0);
    glide(this.whistleA.frequency, whistleFreq, now, 0.35, this.last, 0, 4);
    glide(this.whistleB.frequency, whistleFreq * 1.51 + 35, now, 0.4, this.last, 1, 6);
    glide(this.whistlePan.pan, pan * 0.7, now, 0.4, this.last, 2, 0.02);
    const rigging = f.flying ? smoothstep(6, 20, f.airspeed) * 0.5 : 0;
    const whistle = Math.max(Math.pow(alt, 1.2) * windiness * (1 - 0.94 * nightCalm), rigging) * 0.22;
    this.whistleGate.set(whistle, now);

    // Buffet: only when the weather really blows.
    const squally = clamp(smoothstep(0.32, 0.92, storm) * Math.max(0.3, gust) + 0.6 * f.squall * gust, 0, 1);
    glide(this.buffetLP.frequency, 220 + 520 * gust + 260 * squally, now, 0.3, this.last, 3, 8);
    glide(this.flutter.frequency, 6.5 + 4.5 * valueNoise(f.time * 0.3, 7.7), now, 0.5, this.last, 4, 0.2);
    glide(this.flutterDepth.gain, 0.28 * gust * squally, now, 0.3, this.last, 5, 0.01);
    glide(this.buffetPan.pan, pan, now, 0.5, this.last, 6, 0.02);
    this.buffetGate.set(squally * 0.34 * (f.flying ? 0.4 : 1), now);

    // Pines: canopy swells in the forest (a few trees edge the valley too).
    const trees = f.flying ? 0 : z.forest + z.valley * 0.25 * smoothstep(500, 1000, f.s);
    const pineWind = trees * (0.35 + 0.65 * windiness);
    const swellL = 0.5 + 0.5 * valueNoise(f.time * 0.11, 1.9);
    const swellR = 0.5 + 0.5 * valueNoise(f.time * 0.09 + 13.3, 5.1);
    this.pineL.set(pineWind * (0.15 + 0.85 * swellL * swellL) * 0.075, now, 0.4);
    this.pineR.set(pineWind * (0.15 + 0.85 * swellR * swellR) * 0.075, now, 0.4);
  }

  sleep(now: number): void {
    this.whistleGate.close(now);
    this.buffetGate.close(now);
    this.pineL.close(now);
    this.pineR.close(now);
    this.bedWind = this.bedHowl = -1;
    audio.setWeatherBedScale(1, 1);
  }
}
