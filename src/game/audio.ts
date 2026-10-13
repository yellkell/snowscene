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
  /** Whole-score level (expedition hands over to its generative pad). */
  private musicBus: GainNode | null = null;
  private musicLevel = 1;
  /** Expedition scaling of the weather wind bed and storm howl. */
  private bedWind = 1;
  private bedHowl = 1;

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
      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = this.musicLevel;
      this.musicBus.connect(this.master);
      const length = this.ctx.sampleRate * 2;
      this.noise = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
      this.startWind();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    this.applyMusic();
  }

  /** Sound is actually playing (the browser has let the context run). */
  running(): boolean {
    return this.ctx?.state === 'running';
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
      this.ctx.createMediaElementSource(element).connect(gain).connect(this.musicBus ?? this.master);
      entry = { element, gain };
      this.music.set(track, entry);
    }
    return entry;
  }

  private applyMusic(): void {
    if (!this.ctx || this.musicLevel <= 0 || this.currentTrack === this.wantedTrack) return;
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

  /**
   * Scale the whole score 0..1 over `seconds`. At 0 the playing track pauses
   * once faded (so it stops decoding), and raising the level restarts the
   * wanted track (By the River from the top). Used by the expedition.
   */
  setMusicLevel(level: number, seconds = 6): void {
    const target = Math.max(0, Math.min(1, level));
    if (target === this.musicLevel) return;
    this.musicLevel = target;
    if (!this.ctx || !this.musicBus) return;
    const t = this.ctx.currentTime;
    const bus = this.musicBus.gain;
    bus.cancelScheduledValues(t);
    bus.setValueAtTime(bus.value, t);
    bus.linearRampToValueAtTime(target, t + Math.max(0.05, seconds));
    if (target > 0) {
      this.applyMusic();
      return;
    }
    window.setTimeout(() => {
      if (this.musicLevel > 0 || !this.currentTrack || !this.ctx) return;
      const entry = this.music.get(this.currentTrack);
      if (entry) {
        entry.element.pause();
        entry.gain.gain.cancelScheduledValues(this.ctx.currentTime);
        entry.gain.gain.setValueAtTime(0, this.ctx.currentTime);
      }
      this.currentTrack = null;
    }, Math.max(0.05, seconds) * 1000 + 150);
  }

  /** Scale the weather wind bed and storm howl (1 = unchanged). Used by the expedition. */
  setWeatherBedScale(wind: number, howl = 1): void {
    this.bedWind = wind;
    this.bedHowl = howl;
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
    this.howlGain.gain.setTargetAtTime(level * level * (0.35 + 0.65 * gust) * 0.55 * this.bedHowl, t, 0.4);
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
    this.windGain.gain.setTargetAtTime((0.04 + level * 0.32) * this.bedWind, t, 0.3);
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

  /**
   * A crystal picked up: a glassy blip that climbs a pentatonic scale while
   * pickups keep coming (`step`), so a stream of them sings upward.
   */
  gem(step: number, big = false): void {
    const penta = [0, 2, 4, 7, 9];
    const f = 880 * Math.pow(2, (penta[step % 5] + 12 * Math.min(2, Math.floor(step / 5))) / 12);
    this.tone(f, 0.09, 0.05, 'sine');
    this.tone(f * 2, 0.05, 0.015, 'triangle');
    // A worthy crystal rings out under it.
    if (big) {
      this.tone(f / 2, 0.35, 0.06, 'sine');
      this.tone(f * 1.5, 0.25, 0.03, 'sine', 0.03);
    }
  }

  /** Lightning: a dry electric snap. */
  zap(): void {
    this.burst(4200, 1.2, 0.06, 0.22, 'highpass');
    this.tone(90 + Math.random() * 40, 0.08, 0.06, 'sawtooth');
  }

  /** Level up: a bright arpeggio rushing upward over a soft swell. */
  levelUp(): void {
    [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => this.tone(f, 0.5, 0.12, 'triangle', i * 0.045));
    this.burst(2400, 0.6, 0.4, 0.08, 'highpass');
  }

  /** A boss arrives: a deep growl under a rumble. */
  roar(): void {
    this.tone(55, 1.6, 0.35, 'sawtooth');
    this.tone(82, 1.3, 0.2, 'sawtooth', 0.1);
    this.burst(90, 0.7, 1.8, 0.6, 'lowpass');
  }

  /** An evolution: a long, swelling major chord. */
  evolve(): void {
    [261.63, 329.63, 392, 523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(f, 2.4, 0.1, i % 2 ? 'sine' : 'triangle', i * 0.06));
    this.burst(600, 0.5, 1.4, 0.25, 'lowpass');
  }

  /** A bloater bursting: a wet, deep pop with a crackle of ember. */
  boom(strength = 1): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(160 + Math.random() * 40, t);
    osc.frequency.exponentialRampToValueAtTime(38, t + 0.35);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.42 * strength, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    osc.connect(gain).connect(this.master!);
    osc.start(t);
    osc.stop(t + 0.5);
    this.burst(240, 0.8, 0.35, 0.45 * strength, 'lowpass');
    this.burst(3600, 1.5, 0.12, 0.16 * strength, 'highpass');
  }

  /** A lunger's tell: a short rising hiss-snarl. */
  growl(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(90, t);
    osc.frequency.exponentialRampToValueAtTime(240, t + 0.55);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 700;
    filter.Q.value = 2;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.12, t + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    osc.connect(filter).connect(gain).connect(this.master!);
    osc.start(t);
    osc.stop(t + 0.65);
    this.burst(2400, 2, 0.4, 0.06, 'bandpass');
  }

  /** A disc thrown: a short, bright swish. */
  swish(): void {
    this.burst(2600, 2.5, 0.16, 0.12, 'bandpass');
    this.tone(1400, 0.08, 0.025, 'triangle');
  }

  /** Ice spikes bursting up: a glassy crack. */
  spike(): void {
    this.burst(4200, 3, 0.07, 0.16, 'bandpass');
    this.tone(1900 + Math.random() * 600, 0.12, 0.04, 'triangle');
  }

  /** A glitterback turning up: a run of glassy twinkles. */
  sparkle(): void {
    [2093, 2637, 3136, 2637, 3520, 4186].forEach((f, i) => this.tone(f, 0.25, 0.04, 'sine', i * 0.06));
  }

  /** A fountain of crystals: a long, glittering cascade of clinks. */
  coins(): void {
    for (let i = 0; i < 14; i++) {
      const f = 1800 + Math.random() * 2400;
      this.tone(f, 0.12, 0.035, 'triangle', i * 0.045 + Math.random() * 0.02);
    }
    this.burst(5000, 1, 0.6, 0.05, 'highpass');
  }

  /** A streak of crystals paying out: a bright chord, higher every time. */
  gemChord(level: number): void {
    const root = 523.25 * Math.pow(2, (Math.min(level, 8) * 2) / 12);
    [1, 1.25, 1.5, 2].forEach((m, i) => this.tone(root * m, 0.6, 0.07, 'sine', i * 0.035));
    this.tone(root * 4, 0.3, 0.025, 'triangle', 0.12);
  }

  /** Time stopping: everything drops away in a falling, muffled whoomp. */
  timeStop(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(420, t);
    osc.frequency.exponentialRampToValueAtTime(55, t + 0.5);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.28, t + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    osc.connect(gain).connect(this.master!);
    osc.start(t);
    osc.stop(t + 0.65);
    this.burst(500, 0.6, 0.5, 0.18, 'lowpass');
  }

  /** Upgrade cards fanning out: a rising shimmer of glass. */
  cards(): void {
    [784, 987.77, 1174.66, 1567.98].forEach((f, i) => this.tone(f, 0.4, 0.07, 'triangle', i * 0.055));
    this.burst(3200, 0.7, 0.4, 0.06, 'highpass');
  }

  /** A card lighting up under a fingertip: a soft glassy tick. */
  tick(): void {
    this.tone(1760, 0.06, 0.05, 'sine');
    this.burst(5200, 4, 0.025, 0.05, 'highpass');
  }

  /** A card taken: a bright bell with a soft thump under it. */
  pick(): void {
    this.tone(1046.5, 0.9, 0.13, 'sine');
    this.tone(1567.98, 0.7, 0.08, 'sine', 0.03);
    this.tone(2093, 0.5, 0.05, 'triangle', 0.06);
    this.burst(180, 1.2, 0.22, 0.3, 'lowpass');
  }

  /** The last seconds of a run: a hard clock tick, the last one higher. */
  countdown(secondsLeft: number): void {
    const last = secondsLeft <= 1;
    this.burst(2600, 6, 0.04, 0.22, 'bandpass');
    this.tone(last ? 1320 : 880, last ? 0.4 : 0.12, 0.12, 'square');
  }

  /** You survived: a long fanfare climbing over a swelling chord. */
  victory(): void {
    [523.25, 659.25, 783.99, 1046.5, 1318.5, 1567.98].forEach((f, i) => this.tone(f, 1.8, 0.12, 'triangle', i * 0.13));
    [261.63, 392, 523.25].forEach((f) => this.tone(f, 3, 0.08, 'sine', 0.75));
    this.burst(800, 0.4, 2, 0.2, 'lowpass');
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

  /** Sliding down an iced chute: a continuous rumble while it lasts. */
  slideRumble(speed: number): void {
    if (speed <= 0.05) return;
    this.burst(260 + speed * 30, 0.9, 0.12, 0.05 + 0.02 * speed, 'lowpass');
  }
}

export const audio = new SnowAudio();
