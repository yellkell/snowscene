/**
 * The expedition sound engine: builds the whole WebAudio graph once (when
 * the AudioContext exists), then each tick feeds the wind, ambiences,
 * footsteps, pad and danger bed and runs the score plan (recorded tracks
 * via audio.ts, handing over to the generative pad on long stretches).
 *
 *   wind ─┐
 *   amb  ─┤                ┌─> audio.output() (master)
 *   pad  ─┼─> expedition ──┘
 *   sfx  ─┤      bus
 *   reverb return (convolver, fed by sends) ─┘
 */

import { audio } from '../../audio.js';
import { Ambience } from './ambience.js';
import { Footsteps } from './footsteps.js';
import type { SoundFrame } from './frame.js';
import { Pad } from './pad.js';
import { type ScoreContext, type ScoreMode, ScorePlanner } from './sound-plan.js';
import { DangerBed, STING_LENGTH, type StingId, Stings } from './stings.js';
import { gainNode, type Kit, makeMountainIR, makeNoise } from './synth.js';
import { WindLayers } from './wind.js';

/** Pad loudness relative to its built-in level (the recorded tracks sit above it). */
const PAD_LEVEL = 1;
/** Seconds for the recorded score to fade out when the pad takes over. */
const MUSIC_FADE_OUT = 9;
const MUSIC_FADE_IN = 4;

export class SoundEngine {
  readonly kit: Kit;
  readonly ambience: Ambience;
  private readonly bus: GainNode;
  private readonly wind: WindLayers;
  private readonly footsteps: Footsteps;
  private readonly pad: Pad;
  private readonly stings: Stings;
  private readonly danger: DangerBed;
  private readonly planner = new ScorePlanner();
  private readonly scoreContext: ScoreContext = { s: 0, flying: false, summited: false, sinceStart: 0 };
  private readonly lastSting = new Map<StingId, number>();
  /** Current score mode (after planning). */
  mode: ScoreMode = 'intro';
  awake = false;
  private connected = false;
  private sleepAt = -1;
  private musicPlan = 0;
  private sentMusic = -1;
  private stingDuckUntil = 0;
  /** Pad palette waiting for the recorded track to thin out first. */
  private padPending: 'day' | 'night' | null = null;
  private padStartAt = 0;
  private assertedAt = -1e9;

  constructor(ctx: AudioContext, private readonly output: AudioNode) {
    const noise = makeNoise(ctx);
    const convolver = ctx.createConvolver();
    convolver.buffer = makeMountainIR(ctx);
    const reverbIn = gainNode(ctx, 1);
    reverbIn.connect(convolver);
    this.kit = { ctx, ...noise, reverb: reverbIn, rng: Math.random };

    this.bus = gainNode(ctx, 0);
    convolver.connect(gainNode(ctx, 0.75)).connect(this.bus);
    const windBus = gainNode(ctx, 1);
    const ambBus = gainNode(ctx, 1);
    const padBus = gainNode(ctx, 1);
    const sfxBus = gainNode(ctx, 1);
    for (const b of [windBus, ambBus, padBus, sfxBus]) b.connect(this.bus);

    this.wind = new WindLayers(this.kit, windBus);
    this.ambience = new Ambience(this.kit, ambBus);
    this.footsteps = new Footsteps(this.kit, sfxBus);
    this.pad = new Pad(this.kit, padBus);
    this.stings = new Stings(this.kit, sfxBus);
    this.danger = new DangerBed(this.kit, sfxBus);
  }

  /** The expedition started (or audio just unlocked during it). */
  wake(): void {
    const now = this.kit.ctx.currentTime;
    if (!this.connected) {
      this.bus.connect(this.output);
      this.connected = true;
    }
    const g = this.bus.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(1, now + 3);
    this.awake = true;
    this.sleepAt = -1;
    this.planner.reset();
    this.mode = 'intro';
    this.musicPlan = 0;
    this.sentMusic = -1;
    this.padPending = null;
    this.footsteps.reset();
  }

  /** The expedition ended: fade out, then drop the whole graph from rendering. */
  sleep(): void {
    if (!this.awake) return;
    const now = this.kit.ctx.currentTime;
    this.awake = false;
    const g = this.bus.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + 1.2);
    this.sleepAt = now + 1.5;
    this.wind.sleep(now);
    this.pad.setPalette(null, now);
    audio.setMusicLevel(1, 3);
  }

  /** Called while inactive: finishes a pending sleep. */
  idle(): void {
    if (this.sleepAt < 0 || this.kit.ctx.currentTime < this.sleepAt) return;
    const now = this.kit.ctx.currentTime;
    this.sleepAt = -1;
    this.ambience.sleep(now);
    this.pad.sleep(now);
    this.danger.sleep(now);
    if (this.connected) {
      this.bus.disconnect();
      this.connected = false;
    }
  }

  sting(id: StingId): void {
    if (!this.awake) return;
    const now = this.kit.ctx.currentTime;
    const last = this.lastSting.get(id) ?? -1e9;
    if (now - last < 4) return;
    this.lastSting.set(id, now);
    this.stings.play(id);
    this.stingDuckUntil = Math.max(this.stingDuckUntil, now + STING_LENGTH[id]);
  }

  tick(f: SoundFrame, sinceStart: number, summited: boolean, override: ScoreMode | null): void {
    const now = f.now;
    this.ambience.setListener(f.hx, f.hy, f.hz);
    this.wind.tick(f);
    this.ambience.tick(f);
    this.footsteps.tick(f);
    this.danger.tick(now, f.danger);

    // ---- score
    const c = this.scoreContext;
    c.s = f.s;
    c.flying = f.flying || this.ambience.finale;
    c.summited = summited;
    c.sinceStart = sinceStart;
    const mode = this.planner.update(c, f.dt, override);
    if (mode !== this.mode) this.enter(mode, now);
    // Keep asserting the track (cheap when unchanged) in case anything else picked one.
    if (now - this.assertedAt > 1) this.reassertMusic();

    const ducked = now < this.stingDuckUntil;
    const music = this.musicPlan * (1 - 0.3 * f.danger) * (ducked ? 0.55 : 1);
    const changed = Math.abs(music - this.sentMusic) > 0.015 || (music === 0) !== (this.sentMusic === 0);
    if (changed) {
      const seconds = music === 0 ? MUSIC_FADE_OUT : this.sentMusic <= 0 ? MUSIC_FADE_IN : 0.6;
      audio.setMusicLevel(music, seconds);
      this.sentMusic = music;
    }
    if (this.padPending && now >= this.padStartAt) {
      this.pad.setPalette(this.padPending, now);
      this.padPending = null;
    }
    const padLevel = PAD_LEVEL * (1 - 0.5 * f.danger) * (ducked ? 0.6 : 1);
    this.pad.tick(now, f.dt, 1 - 0.6 * f.storm, padLevel);
    this.ambience.guitarAllowed = this.musicPlan === 0 && !this.pad.playing;
  }

  /**
   * Re-select our track. The guide system picks music on phase changes; the
   * sound system calls this straight after (same task), so its choice never
   * becomes audible during the expedition.
   */
  reassertMusic(): void {
    if (!this.awake) return;
    this.assertedAt = this.kit.ctx.currentTime;
    if (this.mode === 'river' || this.mode === 'night') audio.setMusic(this.mode);
  }

  private enter(mode: ScoreMode, now: number): void {
    this.mode = mode;
    const trackWasOn = this.musicPlan > 0;
    this.padPending = null;
    switch (mode) {
      case 'river':
      case 'night':
        audio.setMusic(mode);
        this.musicPlan = 1;
        this.pad.setPalette(null, now);
        break;
      case 'pad':
      case 'padNight':
        this.musicPlan = 0;
        // Let a recorded track get most of the way out before the pad rises.
        this.padPending = mode === 'pad' ? 'day' : 'night';
        this.padStartAt = now + (trackWasOn ? 5 : 0);
        break;
      default:
        this.musicPlan = 0;
        this.pad.setPalette(null, now);
    }
  }
}
