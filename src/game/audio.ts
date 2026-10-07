/**
 * Soundscape: synthesized snow crunches for pole plants, rock clacks for
 * holds, chimes for glider parts and a wind bed, plus the music score
 * ("By the River" for the ascent, crossfading into "Night Catch" once the
 * glider is built).
 */

export type MusicTrack = 'river' | 'night';

const MUSIC_FILES: Record<MusicTrack, string> = {
  river: 'audio/by-the-river.mp3',
  night: 'audio/night-catch.ogg',
};
const MUSIC_VOLUME = 0.42;
const CROSSFADE_SECONDS = 4;

class SnowAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private howlGain: GainNode | null = null;
  private howlFilter: BiquadFilterNode | null = null;
  private fireGain: GainNode | null = null;
  private music = new Map<MusicTrack, { element: HTMLAudioElement; gain: GainNode }>();
  private wantedTrack: MusicTrack = 'river';
  private currentTrack: MusicTrack | null = null;

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
    this.applyMusic();
  }

  /** The audio context once unlocked (null before the first gesture). */
  context(): AudioContext | null {
    return this.ctx;
  }

  /** Master output node that extra sound modules should connect to. */
  output(): GainNode | null {
    return this.master;
  }

  /** Shared 2 s white-noise buffer for synthesising wind, water, snow. */
  noiseBuffer(): AudioBuffer | null {
    return this.noise;
  }

  /** Choose the score; crossfades if audio is already running. */
  setMusic(track: MusicTrack): void {
    this.wantedTrack = track;
    this.applyMusic();
  }

  private musicFor(track: MusicTrack) {
    let entry = this.music.get(track);
    if (!entry && this.ctx && this.master) {
      const element = new Audio(`${import.meta.env.BASE_URL}${MUSIC_FILES[track]}`);
      element.loop = true;
      element.preload = 'auto';
      element.crossOrigin = 'anonymous';
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      this.ctx.createMediaElementSource(element).connect(gain).connect(this.master);
      entry = { element, gain };
      this.music.set(track, entry);
    }
    return entry;
  }

  private applyMusic(): void {
    if (!this.ctx || this.currentTrack === this.wantedTrack) return;
    const t = this.ctx.currentTime;
    const previous = this.currentTrack ? this.music.get(this.currentTrack) : undefined;
    if (previous) {
      previous.gain.gain.cancelScheduledValues(t);
      previous.gain.gain.setValueAtTime(previous.gain.gain.value, t);
      previous.gain.gain.linearRampToValueAtTime(0, t + CROSSFADE_SECONDS);
      const fadingTrack = this.currentTrack;
      window.setTimeout(() => {
        // Stop decoding once faded out, unless it has been chosen again.
        if (this.currentTrack !== fadingTrack) previous.element.pause();
      }, CROSSFADE_SECONDS * 1000 + 100);
    }
    const next = this.musicFor(this.wantedTrack);
    if (!next) return;
    this.currentTrack = this.wantedTrack;
    // Restarting the ascent theme begins it from the top.
    if (next.element.paused) {
      if (this.wantedTrack === 'river' || next.element.ended) next.element.currentTime = 0;
      void next.element.play().catch(() => {
        // Autoplay was refused; the next user gesture calls unlock() again.
        this.currentTrack = null;
      });
    }
    next.gain.gain.cancelScheduledValues(t);
    next.gain.gain.setValueAtTime(next.gain.gain.value, t);
    next.gain.gain.linearRampToValueAtTime(MUSIC_VOLUME, t + (previous ? CROSSFADE_SECONDS : 2));
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

    // Storm howl: resonant band of noise whose pitch rides the gusts.
    const howl = ctx.createBufferSource();
    howl.buffer = this.noise;
    howl.loop = true;
    this.howlFilter = ctx.createBiquadFilter();
    this.howlFilter.type = 'bandpass';
    this.howlFilter.frequency.value = 500;
    this.howlFilter.Q.value = 9;
    this.howlGain = ctx.createGain();
    this.howlGain.gain.value = 0;
    howl.connect(this.howlFilter).connect(this.howlGain).connect(this.master!);
    howl.start(0, 0.7);

    // Fire bed: low roar under the crackles.
    const roar = ctx.createBufferSource();
    roar.buffer = this.noise;
    roar.loop = true;
    const roarFilter = ctx.createBiquadFilter();
    roarFilter.type = 'lowpass';
    roarFilter.frequency.value = 260;
    this.fireGain = ctx.createGain();
    this.fireGain.gain.value = 0;
    roar.connect(roarFilter).connect(this.fireGain).connect(this.master!);
    roar.start(0, 1.3);
  }

  /** Blizzard howl, 0 (calm) .. 1 (full storm); gust 0..1 bends the pitch. */
  setStorm(level: number, gust: number): void {
    if (!this.ctx || !this.howlGain || !this.howlFilter) return;
    const t = this.ctx.currentTime;
    this.howlGain.gain.setTargetAtTime(level * level * (0.35 + 0.65 * gust) * 0.55, t, 0.4);
    this.howlFilter.frequency.setTargetAtTime(320 + gust * 520 + level * 120, t, 0.6);
  }

  /** Campfire loudness by proximity, 0..1. */
  setFire(level: number): void {
    if (!this.ctx || !this.fireGain) return;
    this.fireGain.gain.setTargetAtTime(level * 0.35, this.ctx.currentTime, 0.3);
  }

  crackle(level: number): void {
    this.burst(2500 + Math.random() * 3000, 1.5, 0.03 + Math.random() * 0.05, 0.25 * level, 'highpass');
    if (Math.random() < 0.3) this.burst(180 + Math.random() * 120, 2, 0.08, 0.2 * level);
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

  /** An ice axe pick biting into hard ice. */
  axeBite(): void {
    this.burst(3800, 2.5, 0.05, 0.45, 'bandpass');
    this.tone(1400 + Math.random() * 300, 0.12, 0.12, 'triangle');
    this.burst(420, 1.2, 0.12, 0.25);
  }

  /** Deep avalanche / serac rumble; call repeatedly while it lasts. */
  rumble(intensity: number): void {
    if (!this.ctx || intensity <= 0.02) return;
    this.burst(60 + Math.random() * 40, 0.7, 0.6 + Math.random() * 0.4, 0.5 * intensity, 'lowpass');
  }

  /** A sharp crack (slab release, ice fracture). */
  crack(): void {
    this.burst(2200, 0.8, 0.08, 0.6, 'highpass');
    this.burst(140, 1.5, 0.5, 0.5, 'lowpass');
  }

  /** Rock or ice impact thud, louder when close. */
  impact(intensity: number): void {
    this.burst(220 + Math.random() * 200, 1.2, 0.18, 0.4 * intensity, 'lowpass');
    this.burst(1600, 1, 0.05, 0.2 * intensity, 'bandpass');
  }

  /** A distant raptor's cry: a falling, slightly rough whistle. */
  eagleCry(volume = 0.12): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      const start = t + i * 0.32;
      osc.frequency.setValueAtTime(2600 - i * 120, start);
      osc.frequency.exponentialRampToValueAtTime(1500, start + 0.28);
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 2200;
      filter.Q.value = 4;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(volume, start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.3);
      osc.connect(filter).connect(gain).connect(this.master!);
      osc.start(start);
      osc.stop(start + 0.35);
    }
  }

  /** A sip from the thermos / zip of the pack. */
  sip(): void {
    this.burst(700, 2, 0.25, 0.18, 'bandpass');
    this.tone(260, 0.2, 0.05, 'sine', 0.1);
  }

  zip(): void {
    for (let i = 0; i < 6; i++) this.burst(2600 + i * 200, 3, 0.03, 0.12, 'bandpass');
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

  /** A deck counting out its dwell: a wood-block tock, higher as it runs out. */
  tock(beatsLeft: number): void {
    const urgency = 1 - Math.min(3, Math.max(0, beatsLeft - 1)) / 3;
    this.burst(1500 + urgency * 900, 6, 0.04, 0.12 + 0.18 * urgency, 'bandpass');
    this.tone(520 + (4 - Math.min(4, beatsLeft)) * 130, 0.08, 0.06 + 0.06 * urgency, 'triangle');
  }

  /** A clean step onto a deck: a marimba note climbing a pentatonic scale. */
  marimba(step: number): void {
    const penta = [0, 2, 4, 7, 9];
    const f = 330 * Math.pow(2, (penta[step % 5] + 12 * (Math.floor(step / 5) % 2)) / 12);
    this.tone(f, 0.45, 0.16, 'sine');
    this.tone(f * 4, 0.08, 0.04, 'sine');
  }

  /** The ground went without you. */
  thud(): void {
    this.burst(160, 1.4, 0.32, 0.55, 'lowpass');
    this.burst(900, 2, 0.06, 0.15, 'bandpass');
  }

  /** A machine taking up its rope: ratchet clunk and creak. */
  clunk(volume = 1): void {
    this.burst(300, 3, 0.09, 0.2 * volume, 'bandpass');
    this.burst(120, 2, 0.18, 0.18 * volume, 'lowpass');
    this.tone(95, 0.25, 0.05 * volume, 'sawtooth', 0.04);
  }

  /** The beacon catches: a rush of flame. */
  ignite(): void {
    this.burst(400, 0.4, 1.6, 0.45, 'lowpass');
    this.burst(2400, 0.8, 0.5, 0.2, 'highpass');
  }

  /** Sliding along the iced flume: a continuous rumble while it lasts. */
  slideRumble(speed: number): void {
    if (speed <= 0.05) return;
    this.burst(260 + speed * 30, 0.9, 0.12, 0.05 + 0.02 * speed, 'lowpass');
  }
}

export const audio = new SnowAudio();
