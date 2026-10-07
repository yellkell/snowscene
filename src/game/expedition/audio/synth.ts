/**
 * WebAudio building blocks for the expedition soundscape: seamless noise
 * buffers (white / pink / brown), a synthetic mountain reverb, a gate that
 * keeps idle layers out of the render graph, HRTF emitters and one-shot
 * envelopes. Everything persistent is built once; one-shots create a few
 * short-lived nodes and stop themselves.
 */

/** Shared resources every sound module gets. */
export interface Kit {
  ctx: AudioContext;
  white: AudioBuffer;
  pink: AudioBuffer;
  brown: AudioBuffer;
  /** Reverb send input (a convolver behind it). */
  reverb: AudioNode;
  rng: () => number;
}

// ------------------------------------------------------------ buffers -----

/** Mono buffer of `seconds` whose end flows seamlessly into its start. */
function seamless(ctx: AudioContext, seconds: number, fill: (out: Float32Array) => void, rms: number): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * seconds);
  const fade = Math.floor(ctx.sampleRate * 0.05);
  const raw = new Float32Array(n + fade);
  fill(raw);
  // Normalise to the target RMS.
  let sum = 0;
  for (let i = 0; i < n; i++) sum += raw[i] * raw[i];
  const scale = rms / Math.sqrt(sum / n || 1);
  const buffer = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = raw[i] * scale;
  // Equal-power crossfade of the overhang into the head of the loop.
  for (let i = 0; i < fade; i++) {
    const w = (i / fade) * Math.PI * 0.5;
    data[i] = raw[i] * scale * Math.sin(w) + raw[n + i] * scale * Math.cos(w);
  }
  return buffer;
}

export function makeNoise(ctx: AudioContext): { white: AudioBuffer; pink: AudioBuffer; brown: AudioBuffer } {
  const white = seamless(
    ctx,
    4.7,
    (out) => {
      for (let i = 0; i < out.length; i++) out[i] = Math.random() * 2 - 1;
    },
    0.577,
  );
  const pink = seamless(
    ctx,
    6.1,
    (out) => {
      // Paul Kellet's refined pink filter.
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < out.length; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
        b6 = w * 0.115926;
      }
    },
    0.2,
  );
  const brown = seamless(
    ctx,
    5.3,
    (out) => {
      let b = 0;
      for (let i = 0; i < out.length; i++) {
        b = (b + 0.02 * (Math.random() * 2 - 1)) / 1.02;
        out[i] = b;
      }
    },
    0.2,
  );
  return { white, pink, brown };
}

/**
 * Stereo impulse response for big open mountain air: a soft early cluster,
 * a long darkening tail and two faint smeared echoes off distant walls.
 */
export function makeMountainIR(ctx: AudioContext, seconds = 2.6): AudioBuffer {
  const rate = ctx.sampleRate;
  const n = Math.floor(rate * seconds);
  const ir = ctx.createBuffer(2, n, rate);
  const echoes = [
    { t: 0.43, g: 0.22 },
    { t: 1.02, g: 0.1 },
  ];
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    let lp = 0;
    const pre = Math.floor(rate * (0.018 + ch * 0.007));
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / rate;
      const env = Math.exp(-t / (seconds / 6.9)) * Math.min(1, t / 0.012);
      // The tail darkens as it decays (air absorbs the highs first).
      const a = 0.85 * Math.exp(-t * 1.6) + 0.08;
      lp += a * (Math.random() * 2 - 1 - lp);
      let v = lp * env;
      for (const e of echoes) {
        const de = (t - e.t + ch * 0.011) / 0.03;
        if (de > -3 && de < 3) v += (Math.random() * 2 - 1) * e.g * Math.exp(-de * de) * 0.5;
      }
      data[i] = v;
    }
  }
  return ir;
}

// --------------------------------------------------------------- gate -----

/**
 * A level control at the end of a layer's chain. While the target is
 * (near) zero for long enough it disconnects, so nothing upstream is pulled
 * by the renderer and an idle layer costs nothing.
 */
export class Gate {
  readonly node: GainNode;
  private connected = false;
  private target = 0;
  private quietSince = -1;

  constructor(
    private readonly ctx: AudioContext,
    private readonly dest: AudioNode,
    private readonly tc = 0.08,
  ) {
    this.node = ctx.createGain();
    this.node.gain.value = 0;
  }

  get level(): number {
    return this.target;
  }

  get open(): boolean {
    return this.connected;
  }

  set(level: number, now: number, tc = this.tc): void {
    if (level > 1e-4) {
      if (!this.connected) {
        this.node.connect(this.dest);
        this.connected = true;
      }
      this.quietSince = -1;
    } else {
      level = 0;
      if (this.connected) {
        if (this.quietSince < 0) this.quietSince = now;
        else if (now - this.quietSince > tc * 9 + 0.1) {
          this.node.disconnect();
          this.connected = false;
        }
      }
    }
    const delta = Math.abs(level - this.target);
    if (delta > Math.max(1e-5, 0.01 * this.target) || (level === 0 && this.target !== 0)) {
      this.node.gain.setTargetAtTime(level, now, tc);
      this.target = level;
    }
  }

  /** Drop out immediately (used when the whole soundscape sleeps). */
  close(now: number): void {
    this.node.gain.cancelScheduledValues(now);
    this.node.gain.setValueAtTime(0, now);
    this.target = 0;
    this.quietSince = -1;
    if (this.connected) {
      this.node.disconnect();
      this.connected = false;
    }
  }
}

// ----------------------------------------------------------- sources ------

export function loopSource(kit: Kit, buffer: AudioBuffer, rate = 1, offset = 0): AudioBufferSourceNode {
  const src = kit.ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  src.playbackRate.value = rate;
  src.start(0, offset % buffer.duration);
  return src;
}

export function filter(ctx: AudioContext, type: BiquadFilterType, freq: number, q = 0.7, gain = 0): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  if (gain) f.gain.value = gain;
  return f;
}

export function gainNode(ctx: AudioContext, value: number): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

export function stereo(ctx: AudioContext, pan: number): StereoPannerNode {
  const p = ctx.createStereoPanner();
  p.pan.value = pan;
  return p;
}

/** Glide an AudioParam toward v (only when it moved enough to matter). */
export function glide(param: AudioParam, v: number, now: number, tc: number, last: number[], i: number, eps: number): void {
  if (Math.abs(v - last[i]) <= eps) return;
  last[i] = v;
  param.setTargetAtTime(v, now, tc);
}

// ---------------------------------------------------------- emitters ------

/** A positional emitter: HRTF panner with our own distance handling. */
export class Emitter {
  readonly input: GainNode;
  readonly panner: PannerNode;
  /** Until when a one-shot owns this emitter's position. */
  busyUntil = 0;

  constructor(ctx: AudioContext, dest: AudioNode) {
    this.panner = ctx.createPanner();
    this.panner.panningModel = 'HRTF';
    this.panner.distanceModel = 'linear';
    this.panner.rolloffFactor = 0;
    this.panner.refDistance = 1;
    this.panner.maxDistance = 100000;
    this.input = gainNode(ctx, 1);
    this.input.connect(this.panner).connect(dest);
  }

  setPosition(x: number, y: number, z: number): void {
    const p = this.panner;
    if (p.positionX) {
      p.positionX.value = x;
      p.positionY.value = y;
      p.positionZ.value = z;
    } else {
      (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, y, z);
    }
  }
}

// ---------------------------------------------------------- one-shots -----

/** A filtered noise hit with a linear attack and exponential-ish decay. */
export function noiseShot(
  kit: Kit,
  buffer: AudioBuffer,
  dest: AudioNode,
  t: number,
  type: BiquadFilterType,
  freq: number,
  q: number,
  attack: number,
  decay: number,
  peak: number,
  freqEnd = 0,
  rate = 1,
): GainNode {
  const ctx = kit.ctx;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = rate;
  const f = filter(ctx, type, freq, q);
  if (freqEnd > 0) {
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(freqEnd, t + attack + decay);
  }
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.setTargetAtTime(0, t + attack, decay / 5);
  src.connect(f).connect(g).connect(dest);
  const length = attack + decay + 0.05;
  src.start(t, kit.rng() * Math.max(0, buffer.duration - length * rate - 0.1));
  src.stop(t + length);
  return g;
}

/** An oscillator blip with an optional exponential pitch glide. */
export function toneShot(
  kit: Kit,
  dest: AudioNode,
  t: number,
  type: OscillatorType,
  freq: number,
  attack: number,
  decay: number,
  peak: number,
  freqEnd = 0,
): GainNode {
  const ctx = kit.ctx;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (freqEnd > 0) osc.frequency.exponentialRampToValueAtTime(freqEnd, t + attack + decay * 0.6);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.setTargetAtTime(0, t + attack, decay / 5);
  osc.connect(g).connect(dest);
  osc.start(t);
  osc.stop(t + attack + decay + 0.05);
  return g;
}

/**
 * A burst of short grains on a gain param (crunching snow, gravel, flutter):
 * each grain jumps up and decays exponentially before the next.
 */
export function grains(
  param: AudioParam,
  t: number,
  count: number,
  span: number,
  peak: number,
  grainLength: number,
  rng: () => number,
): number {
  param.setValueAtTime(0, t);
  let at = t;
  for (let k = 0; k < count; k++) {
    const level = peak * (0.45 + 0.55 * rng()) * (1 - (0.5 * k) / count);
    param.setValueAtTime(level, at);
    param.exponentialRampToValueAtTime(level * 0.04 + 1e-5, at + grainLength);
    at += grainLength + (span / count) * (0.3 + rng() * 0.9);
  }
  param.setValueAtTime(0, at + 0.005);
  return at + 0.01;
}

/** A noise source through a filter into a grain envelope. */
export function grainShot(
  kit: Kit,
  buffer: AudioBuffer,
  dest: AudioNode,
  t: number,
  type: BiquadFilterType,
  freq: number,
  q: number,
  count: number,
  span: number,
  peak: number,
  grainLength: number,
): void {
  const ctx = kit.ctx;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = 0.85 + kit.rng() * 0.3;
  const f = filter(ctx, type, freq, q);
  const g = ctx.createGain();
  const end = grains(g.gain, t, count, span, peak, grainLength, kit.rng);
  src.connect(f).connect(g).connect(dest);
  src.start(t, kit.rng() * (buffer.duration - 1));
  src.stop(end + 0.02);
}
