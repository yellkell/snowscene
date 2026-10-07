/**
 * Tiny synthesized soundscape (no audio files): snow crunches for pole
 * plants, rock clacks for holds, chimes for glider parts and a wind bed whose
 * level follows the glide speed.
 */

class SnowAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;

  /** Create/resume the audio context; call from a user gesture or XR start. */
  unlock(): void {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.8;
      this.master.connect(this.ctx.destination);
      const length = this.ctx.sampleRate * 2;
      this.noise = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
      this.startWind();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private startWind(): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 400;
    this.windFilter.Q.value = 0.7;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0.04;
    src.connect(this.windFilter).connect(this.windGain).connect(this.master!);
    src.start();
  }

  /** 0 = calm alpine breeze, 1 = rushing air while gliding fast. */
  setWind(level: number): void {
    if (!this.ctx || !this.windGain || !this.windFilter) return;
    const t = this.ctx.currentTime;
    this.windGain.gain.setTargetAtTime(0.04 + level * 0.32, t, 0.3);
    this.windFilter.frequency.setTargetAtTime(380 + level * 1400, t, 0.3);
  }

  private burst(freq: number, q: number, duration: number, volume: number, type: BiquadFilterType = 'bandpass') {
    if (!this.ctx || !this.noise) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    src.connect(filter).connect(gain).connect(this.master!);
    src.start(t, Math.random() * 1.5, duration + 0.05);
  }

  crunch(strength = 1): void {
    this.burst(900 + Math.random() * 500, 0.9, 0.18, 0.35 * strength);
    this.burst(3200, 0.6, 0.08, 0.12 * strength, 'highpass');
  }

  clack(): void {
    this.burst(1800, 3, 0.07, 0.4);
    this.tone(220 + Math.random() * 40, 0.09, 0.15, 'triangle');
  }

  private tone(freq: number, duration: number, volume: number, type: OscillatorType = 'sine', delay = 0) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(gain).connect(this.master!);
    osc.start(t);
    osc.stop(t + duration + 0.05);
  }

  chime(): void {
    [659.25, 783.99, 987.77].forEach((f, i) => this.tone(f, 0.7, 0.16, 'sine', i * 0.07));
  }

  fanfare(): void {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(f, 1.4, 0.14, 'triangle', i * 0.12));
  }

  whoosh(): void {
    this.burst(600, 0.5, 1.2, 0.3, 'lowpass');
  }
}

export const audio = new SnowAudio();
