/**
 * Positional ambiences (HRTF panners, our own distance curves):
 *
 *  - the river: rushing water from the nearest point of its channel, with
 *    bubbles up close;
 *  - camps: a murmur of voices (formant-filtered syllables), tent flaps in
 *    the gusts and, at Base Camp, a guitarist fingerpicking by the fire;
 *  - meltwater trickling beside the glacier path on sunny afternoons;
 *  - one-shot critters and ice placed around the listener: birdsong by day
 *    and an owl at dusk in the trees, groans and creaks in the glacier,
 *    stones clattering on the moraine, distant cracks in the night;
 *  - a soft high shimmer while the aurora is strong.
 */

import { valueNoise } from '../../terrain.js';
import { clamp, smoothstep } from '../exp-route.js';
import { routeFrame, type RouteFrame } from '../exp-layout.js';
import { bird, bubble, crack, creak, flap, groan, impact, owl, pluck, rocks, rumble } from './critters.js';
import { GUITAR_EIGHTH, GUITAR_PHRASE, guitarStep, guitarStepSeconds } from './harmony.js';
import {
  airCutoff,
  CAMP_POINTS,
  chance,
  falloff,
  nearestCamp,
  nearestRiverPoint,
  type Point3,
} from './sound-plan.js';
import { Emitter, filter, Gate, gainNode, glide, type Kit, loopSource, stereo } from './synth.js';
import type { SoundFrame } from './frame.js';

/** Look-ahead for scheduled syllables and plucks (seconds). */
const LOOKAHEAD = 0.2;

export type EventKind = 'crack' | 'rumble' | 'impact' | 'groan' | 'creak';

class Talker {
  readonly osc: OscillatorNode;
  readonly formant: BiquadFilterNode;
  readonly env: GainNode;
  next = 0;
  left = 0;
  index = 0;
  phrasePitch = 0;
  laughing = false;

  constructor(ctx: AudioContext, dest: AudioNode, breath: AudioNode, readonly base: number) {
    this.osc = ctx.createOscillator();
    this.osc.type = 'sawtooth';
    this.osc.frequency.value = base;
    this.formant = filter(ctx, 'bandpass', 600, 4.5);
    this.env = gainNode(ctx, 0);
    this.osc.connect(this.formant);
    breath.connect(this.formant);
    this.formant.connect(this.env).connect(dest);
    this.osc.start();
  }

  /** Schedule syllables up to `until`. `chatter` 0..1 shortens the pauses. */
  schedule(now: number, until: number, rng: () => number, chatter: number, laughChance: number): void {
    if (this.next < now) this.next = now + rng() * 0.6;
    while (this.next < until) {
      const t = this.next;
      if (this.left <= 0) {
        this.laughing = rng() < laughChance;
        this.left = this.laughing ? 4 + Math.floor(rng() * 3) : 2 + Math.floor(rng() * 9);
        this.index = 0;
        this.phrasePitch = this.base * (0.94 + rng() * 0.16);
      }
      const dur = this.laughing ? 0.1 + rng() * 0.04 : 0.12 + rng() * 0.2;
      const pitch = this.laughing
        ? this.phrasePitch * (1.45 - this.index * 0.04)
        : this.phrasePitch * (1 + 0.14 * (rng() - 0.5)) * (1 - 0.035 * this.index);
      const vowel = this.laughing ? 750 : 320 + Math.floor(rng() * 5) * 150;
      const peak = (this.laughing ? 0.16 : 0.2) * (0.6 + 0.4 * rng());
      this.env.gain.setTargetAtTime(peak, t, 0.02);
      this.env.gain.setTargetAtTime(0, t + dur * 0.72, 0.035);
      this.osc.frequency.setTargetAtTime(pitch, t, 0.03);
      this.formant.frequency.setTargetAtTime(vowel, t, 0.03);
      this.left--;
      this.index++;
      this.next = t + dur + rng() * 0.06;
      if (this.left <= 0) this.next += 0.5 + rng() * (0.8 + 3.5 * (1 - chatter));
    }
  }

  hush(now: number): void {
    this.next = 0;
    this.left = 0;
    this.env.gain.cancelScheduledValues(now);
    this.env.gain.setTargetAtTime(0, now, 0.05);
  }
}

export class Ambience {
  // River.
  private readonly riverEm: Emitter;
  private readonly riverGate: Gate;
  private readonly riverLP: BiquadFilterNode;
  private readonly riverPt: Point3 = { x: 0, y: 0, z: 0 };
  private riverNear = 0;
  // Meltwater.
  private readonly trickleEm: Emitter;
  private readonly trickleGate: Gate;
  private readonly trickleFrame = {} as RouteFrame;
  private trickleAnchor = -1e9;
  private trickleSide = 1;
  private trickleNear = 0;
  // Camp.
  private readonly campEm: Emitter;
  private readonly campGate: Gate;
  private readonly campLP: BiquadFilterNode;
  private readonly campBus: GainNode;
  private readonly murmurGate: Gate;
  private readonly guitarGate: Gate;
  private readonly guitarBus: GainNode;
  private readonly talkers: Talker[] = [];
  private readonly campDist = [0];
  private camp = -1;
  private campNear = 0;
  private talking = false;
  private guitarStepIndex = 0;
  private guitarNext = 0;
  private guitarRest = 0;
  private readonly notes = [0, 0, 0, 0];
  private readonly vel = [0];
  // One-shots.
  private readonly spots: Emitter[];
  private readonly fxEm: Emitter;
  private fxBusyUntil = 0;
  // Aurora shimmer.
  private readonly shimmerGate: Gate;
  private readonly shimmerOsc: OscillatorNode[] = [];
  private readonly shimmerAmp: GainNode[] = [];
  // Event clocks (seconds since each kind last played).
  private sinceBird = 99;
  private sinceOwl = 0;
  private sinceGroan = 0;
  private sinceCreak = 0;
  private sinceCrack = 0;
  private sinceRocks = 0;
  private sinceFlap = 0;
  private readonly last = new Array<number>(16).fill(-1);

  /** Base Camp guitarist plays (the engine allows it while no track plays). */
  guitarAllowed = false;
  /** The finale party: livelier chatter at Base Camp. */
  finale = false;

  constructor(private readonly kit: Kit, dest: AudioNode) {
    const ctx = kit.ctx;
    const wet = gainNode(ctx, 1);
    wet.connect(kit.reverb);
    const emit = (send: number) => {
      const out = gainNode(ctx, 1);
      out.connect(dest);
      if (send > 0) out.connect(gainNode(ctx, send)).connect(wet);
      return new Emitter(ctx, out);
    };

    // River: pink body + bright spray, with an irregular burble.
    this.riverEm = emit(0.08);
    this.riverGate = new Gate(ctx, this.riverEm.input, 0.4);
    this.riverLP = filter(ctx, 'lowpass', 6000, 0.5);
    this.riverLP.connect(this.riverGate.node);
    const burble = gainNode(ctx, 0.86);
    burble.connect(this.riverLP);
    for (const [rate, depth] of [
      [1.7, 0.07],
      [3.9, 0.06],
    ]) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = rate;
      lfo.connect(gainNode(ctx, depth)).connect(burble.gain);
      lfo.start();
    }
    loopSource(kit, kit.pink, 1, 0.4)
      .connect(filter(ctx, 'lowpass', 1500, 0.5))
      .connect(filter(ctx, 'highpass', 140, 0.6))
      .connect(burble);
    loopSource(kit, kit.white, 1.1, 2.2)
      .connect(filter(ctx, 'bandpass', 3200, 0.6))
      .connect(gainNode(ctx, 0.22))
      .connect(burble);

    // Meltwater trickle: a bright band with a fast irregular flutter.
    this.trickleEm = emit(0.1);
    this.trickleGate = new Gate(ctx, this.trickleEm.input, 0.6);
    const flutter = gainNode(ctx, 0.45);
    for (const rate of [6.1, 9.7]) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = rate;
      lfo.connect(gainNode(ctx, 0.24)).connect(flutter.gain);
      lfo.start();
    }
    loopSource(kit, kit.white, 0.93, 3.3)
      .connect(filter(ctx, 'bandpass', 2400, 1.8))
      .connect(flutter)
      .connect(this.trickleGate.node);

    // Camp: voices, flaps and guitar share one emitter at the camp centre.
    this.campEm = emit(0.18);
    this.campGate = new Gate(ctx, this.campEm.input, 0.5);
    this.campLP = filter(ctx, 'lowpass', 6000, 0.5);
    this.campLP.connect(this.campGate.node);
    this.campBus = gainNode(ctx, 1);
    this.campBus.connect(this.campLP);
    const murmurLP = filter(ctx, 'lowpass', 1300, 0.6);
    this.murmurGate = new Gate(ctx, this.campBus, 0.8);
    murmurLP.connect(this.murmurGate.node);
    const breath = gainNode(ctx, 0.5);
    loopSource(kit, kit.white, 1, 1.1).connect(breath);
    for (const base of [112, 146, 205]) this.talkers.push(new Talker(ctx, murmurLP, breath, base));
    this.guitarBus = gainNode(ctx, 1);
    this.guitarGate = new Gate(ctx, this.campBus, 1.2);
    this.guitarBus
      .connect(filter(ctx, 'peaking', 220, 1, 4))
      .connect(filter(ctx, 'lowpass', 3500, 0.6))
      .connect(this.guitarGate.node);

    // Spots for placed one-shots, and one reserved for director/FX events.
    this.spots = [emit(0), emit(0), emit(0)];
    this.fxEm = emit(0);

    // Aurora shimmer: four high sines (E6 A6 B6 E7), slowly swelling.
    const shimmerOut = gainNode(ctx, 1);
    shimmerOut.connect(dest);
    shimmerOut.connect(gainNode(ctx, 0.9)).connect(wet);
    this.shimmerGate = new Gate(ctx, shimmerOut, 1.5);
    const freqs = [1318.51, 1760, 1975.53, 2637.02];
    const pans = [-0.6, -0.2, 0.25, 0.65];
    for (let i = 0; i < freqs.length; i++) {
      const osc = ctx.createOscillator();
      osc.frequency.value = freqs[i];
      const amp = gainNode(ctx, 0);
      osc.connect(amp).connect(stereo(ctx, pans[i])).connect(this.shimmerGate.node);
      osc.start();
      this.shimmerOsc.push(osc);
      this.shimmerAmp.push(amp);
    }
  }

  tick(f: SoundFrame): void {
    const now = f.now;
    const dt = f.dt;
    const rng = this.kit.rng;
    const z = f.zones;
    const still = 1 - smoothstep(0.3, 0.75, f.storm);
    const hush = 1 - 0.35 * f.danger;

    // ---- river
    const dRiver = nearestRiverPoint(f.hx, f.hy, f.hz, this.riverPt);
    this.riverNear = falloff(dRiver, 14, 1.25, 450, 650);
    if (this.riverNear > 0) this.riverEm.setPosition(this.riverPt.x, this.riverPt.y, this.riverPt.z);
    glide(this.riverLP.frequency, airCutoff(dRiver, 9000), now, 0.3, this.last, 0, 50);
    this.riverGate.set(this.riverNear * 0.32, now, 0.5);
    if (dRiver < 45 && chance(6 * this.riverNear, dt, rng)) {
      bubble(this.kit, this.riverEm.input, now + rng() * 0.03, 0.02 * this.riverNear, 300, 900);
    }

    // ---- meltwater beside the glacier path (sunny, not stormy)
    const melt = f.flying ? 0 : z.glacier * smoothstep(0.5, 0.9, f.daylight) * (1 - smoothstep(0.25, 0.6, f.storm));
    if (melt > 0 && Math.abs(f.s - this.trickleAnchor) > 35) {
      // Move the runnel ahead, alternating sides of the path.
      this.trickleAnchor = f.s + 14;
      this.trickleSide = -this.trickleSide;
      const fr = routeFrame(this.trickleAnchor, this.trickleFrame);
      this.trickleEm.setPosition(fr.x + fr.nx * 6 * this.trickleSide, fr.elev - 0.3, fr.z + fr.nz * 6 * this.trickleSide);
    }
    if (melt > 0) {
      const fr = this.trickleFrame;
      const tx = fr.x + fr.nx * 6 * this.trickleSide;
      const tz = fr.z + fr.nz * 6 * this.trickleSide;
      this.trickleNear = falloff(Math.hypot(f.hx - tx, f.hy - fr.elev, f.hz - tz), 5, 1.3, 40, 60) * melt;
    } else {
      this.trickleNear = 0;
    }
    this.trickleGate.set(this.trickleNear * 0.25, now, 0.8);
    if (chance(3 * this.trickleNear, dt, rng)) {
      bubble(this.kit, this.trickleEm.input, now + rng() * 0.03, 0.03 * this.trickleNear, 900, 2400);
    }

    // ---- camps
    const ci = nearestCamp(f.hx, f.hy, f.hz, this.campDist);
    const dCamp = this.campDist[0];
    const camp = CAMP_POINTS[ci];
    if (ci !== this.camp) {
      this.camp = ci;
      this.campEm.setPosition(camp.x, camp.y, camp.z);
    }
    this.campNear = falloff(dCamp, 11, 1.4, 140, 200);
    glide(this.campLP.frequency, airCutoff(dCamp, 8000), now, 0.3, this.last, 1, 50);
    this.campGate.set(this.campNear * hush, now, 0.6);
    const lively = camp.party ? (this.finale ? 1 : 0.6) : 0.25;
    const voices = camp.party ? 3 : 2;
    const talk = this.campNear > 0.004;
    this.murmurGate.set(talk ? (camp.party ? 1 : 0.5) : 0, now, 0.8);
    if (talk) {
      const until = now + LOOKAHEAD;
      for (let i = 0; i < this.talkers.length; i++) {
        if (i < voices) this.talkers[i].schedule(now, until, rng, lively, camp.party ? 0.12 * lively : 0);
        else if (this.talkers[i].next !== 0) this.talkers[i].hush(now);
      }
      this.talking = true;
    } else if (this.talking) {
      for (const talker of this.talkers) talker.hush(now);
      this.talking = false;
    }
    // Tent flaps in the gusts.
    this.sinceFlap += dt;
    const flapRate = dCamp < 60 ? 0.04 + 0.35 * f.gust * clamp(f.storm * 1.5 + 0.1, 0, 1) : 0;
    if (this.sinceFlap > 1.2 && chance(flapRate, dt, rng)) {
      this.sinceFlap = 0;
      flap(this.kit, this.campBus, now + 0.02, 0.4 * (0.5 + 0.5 * f.gust));
    }
    // The Base Camp guitarist.
    const guitar = this.guitarAllowed && camp.party && this.campNear > 0.002;
    this.guitarGate.set(guitar ? 1 : 0, now, 1.2);
    if (guitar) this.scheduleGuitar(now, now + LOOKAHEAD);
    else this.guitarNext = 0;

    // ---- placed one-shots
    this.sinceBird += dt;
    this.sinceOwl += dt;
    this.sinceGroan += dt;
    this.sinceCreak += dt;
    this.sinceCrack += dt;
    this.sinceRocks += dt;
    if (!f.flying) {
      const day = smoothstep(0.35, 0.8, f.daylight);
      const dusk = 1 - smoothstep(0.25, 0.7, f.daylight);
      const trees = z.forest + z.valley * 0.5;
      const calm = still * hush;
      if (this.sinceBird > 2.5 && chance(trees * day * calm * 0.16, dt, rng)) {
        this.place(rng, 15 + rng() * 40, 4, 14, 4, 0.12, (dest, t, g) => bird(this.kit, dest, t, 0.035 * g));
        this.sinceBird = 0;
      }
      if (this.sinceOwl > 18 && chance(trees * dusk * calm * 0.035, dt, rng)) {
        this.place(rng, 40 + rng() * 80, 6, 18, 4.5, 0.35, (dest, t, g) => owl(this.kit, dest, t, 0.06 * g));
        this.sinceOwl = 0;
      }
      const ice = z.glacier;
      if (this.sinceGroan > 8 && chance(ice * 0.05 * hush, dt, rng)) {
        this.place(rng, 20 + rng() * 60, -14, -4, 4.5, 0.3, (dest, t, g) => groan(this.kit, dest, t, 0.06 * g));
        this.sinceGroan = 0;
      }
      if (this.sinceCreak > 3 && chance(ice * 0.08, dt, rng)) {
        this.place(rng, 5 + rng() * 22, -3, 0, 1.3, 0.15, (dest, t, g) => creak(this.kit, dest, t, 1.4 * g));
        this.sinceCreak = 0;
      }
      if (this.sinceCrack > 22 && chance(z.ridge * 0.03 + ice * 0.012 + z.summit * 0.008, dt, rng)) {
        this.place(rng, 220 + rng() * 480, -60, 40, 2.6, 0.7, (dest, t, g) => crack(this.kit, dest, t, 0.5 * g));
        this.sinceCrack = 0;
      }
      if (this.sinceRocks > 12 && chance(z.moraine * 0.045, dt, rng)) {
        this.place(rng, 60 + rng() * 140, 25, 80, 2, 0.4, (dest, t, g) => rocks(this.kit, dest, t, 0.12 * g));
        this.sinceRocks = 0;
      }
    }

    // ---- aurora shimmer
    const aurora = f.flying ? 0 : smoothstep(0.2, 0.8, f.aurora) * (z.ridge + z.summit * 0.5);
    this.shimmerGate.set(aurora * 0.006 * hush, now, 2);
    if (this.shimmerGate.open) {
      for (let i = 0; i < 4; i++) {
        const swell = 0.5 + 0.5 * valueNoise(f.time * 0.21 + i * 7.3, i * 3.1);
        glide(this.shimmerAmp[i].gain, 0.15 + 0.85 * swell * swell, now, 0.25, this.last, 4 + i, 0.02);
        glide(this.shimmerOsc[i].detune, valueNoise(f.time * 0.13, i * 5.7 + 2) * 7, now, 0.4, this.last, 8 + i, 0.3);
      }
    }
  }

  private scheduleGuitar(now: number, until: number): void {
    if (this.guitarNext < now - 0.3) this.guitarNext = now + 0.15;
    while (this.guitarNext < until) {
      const t = this.guitarNext;
      if (this.guitarRest > 0) {
        this.guitarRest--;
        this.guitarNext += GUITAR_EIGHTH;
        continue;
      }
      const step = this.guitarStepIndex;
      const n = guitarStep(step, this.notes, this.vel);
      const jitter = (this.kit.rng() - 0.5) * 0.02;
      for (let k = 0; k < n; k++) {
        pluck(this.kit, this.guitarBus, t + jitter + k * 0.028, this.notes[k], this.vel[0] * (0.85 + this.kit.rng() * 0.25));
      }
      this.guitarStepIndex++;
      this.guitarNext += guitarStepSeconds(step);
      // Between phrases the guitarist pauses (a sip, a joke, a retune).
      if (this.guitarStepIndex % GUITAR_PHRASE === 0) this.guitarRest = 16 + Math.floor(this.kit.rng() * 32);
    }
  }

  /**
   * Play a one-shot on a free spot emitter around the listener: `range` m
   * away, dy metres up/down, with air absorption, distance gain and reverb.
   */
  private place(
    rng: () => number,
    range: number,
    dyMin: number,
    dyMax: number,
    duration: number,
    wet: number,
    voice: (dest: AudioNode, t: number, gain: number) => void,
  ): void {
    const now = this.kit.ctx.currentTime;
    let spot: Emitter | null = null;
    for (const s of this.spots) {
      if (s.busyUntil <= now) {
        spot = s;
        break;
      }
    }
    if (!spot) return;
    const angle = rng() * Math.PI * 2;
    const dy = dyMin + rng() * (dyMax - dyMin);
    spot.setPosition(this.hx + Math.cos(angle) * range, this.hy + dy, this.hz + Math.sin(angle) * range);
    spot.busyUntil = now + duration + 0.5;
    const d = Math.hypot(range, dy);
    voice(this.chain(spot, d, wet), now + 0.03, falloff(d, 18, 1, 1e9, 2e9) * 1.5);
  }

  private hx = 0;
  private hy = 0;
  private hz = 0;

  setListener(x: number, y: number, z: number): void {
    this.hx = x;
    this.hy = y;
    this.hz = z;
  }

  /** air-absorption low-pass → emitter (dry) and → reverb (wet). */
  private chain(em: Emitter, d: number, wet: number): AudioNode {
    const ctx = this.kit.ctx;
    const lp = filter(ctx, 'lowpass', airCutoff(d), 0.5);
    lp.connect(em.input);
    if (wet > 0) lp.connect(gainNode(ctx, wet)).connect(this.kit.reverb);
    return lp;
  }

  /** Director / FX: a positional event sound at a world point. */
  eventAt(kind: EventKind, x: number, y: number, z: number, intensity: number): void {
    const now = this.kit.ctx.currentTime;
    const d = Math.hypot(x - this.hx, y - this.hy, z - this.hz);
    // Rumbles re-trigger often; keep them from piling up.
    if (kind === 'rumble' && now < this.fxBusyUntil) return;
    this.fxEm.setPosition(x, y, z);
    const gain = falloff(d, 40, 1, 2500, 4000) * clamp(intensity, 0, 2) * 2;
    if (gain <= 0.001) return;
    const dest = this.chain(this.fxEm, d, 0.45);
    const t = now + 0.02;
    let length = 0;
    switch (kind) {
      case 'crack':
        length = crack(this.kit, dest, t, 0.3 * gain);
        break;
      case 'rumble':
        length = rumble(this.kit, dest, t, 0.35 * gain);
        break;
      case 'impact':
        length = impact(this.kit, dest, t, 0.35 * gain);
        break;
      case 'groan':
        length = groan(this.kit, dest, t, 0.08 * gain);
        break;
      case 'creak':
        length = creak(this.kit, dest, t, 1.6 * gain);
        break;
    }
    if (kind === 'rumble') this.fxBusyUntil = now + length * 0.45;
  }

  sleep(now: number): void {
    this.riverGate.close(now);
    this.trickleGate.close(now);
    this.campGate.close(now);
    this.murmurGate.close(now);
    this.guitarGate.close(now);
    this.shimmerGate.close(now);
    for (const talker of this.talkers) talker.hush(now);
    this.talking = false;
    this.guitarNext = 0;
    this.camp = -1;
    this.trickleAnchor = -1e9;
  }
}
