/**
 * The expedition director: the brain of "The Expedition".
 *
 *  - Creates the expedition root (hidden until the expedition starts).
 *  - Runs the transition from the tutorial (guide button / desktop E), the
 *    restart and the way back to the tutorial, and `?expedition` /
 *    `?expedition&s=5000` direct starts for testing.
 *  - Checkpoints (camps, wall feet and tops, the rope, the summit), saved to
 *    localStorage; respawns and rescues fade you back to the last one.
 *  - Per frame: time of day and daylight from progress, storm = baseline +
 *    squalls on a real-time schedule, cold and warmth.
 *  - Section, camp, summit and finale moments; the guide's status line.
 *
 * Register it before the other expedition systems (it creates
 * `expRefs.root` in init) and before the pole system (priority 5).
 */

import { createSystem, Group, Vector3 } from '@iwsdk/core';
import { audio } from '../../audio.js';
import { equipment, equipPair, type ItemId, setPack } from '../../equipment.js';
import { HANDS } from '../../hand-input.js';
import { level } from '../../level.js';
import { faceYaw, getHeadWorld, placeHeadAt } from '../../rig.js';
import { sceneRefs } from '../../scene-system.js';
import { addWarmth, fadeThen, game, Phase, requestRestart, setPhase, toast } from '../../state.js';
import { WALL_Z } from '../../terrain.js';
import { startTutorialKit } from '../../tutorial-kit.js';
import { tutorialLevel } from '../../tutorial-level.js';
import { clamp, route, SECTION_ORDER, smoothstep, SUMMIT_ELEV } from '../exp-route.js';
import {
  baseStormAt,
  CAMPS,
  campCentre,
  EXP_CLOUD_DECK_Y,
  ICE_WALL,
  ROCK_BAND,
  ROPE_START_S,
  SECTION_NAMES,
  SUMMIT_S,
  timeOfDayAt,
} from '../exp-layout.js';
import { exp, expFrame, expHooks, expRefs } from '../exp-state.js';
import {
  expeditionLevel,
  expeditionWall,
  expInput,
  expLevelHooks,
  resetClimb,
  trackProgress,
} from '../expedition-level.js';
import {
  type Checkpoint,
  checkpointAtOrBefore,
  checkpointIndex,
  CHECKPOINTS,
  lastCampAtOrBefore,
  skipTarget,
} from './checkpoints.js';
import { coldAt, daylightAt, SQUALL, squallEnvelope, squallGap, WARMTH_DRAIN_AT_FULL_COLD } from './climate.js';
import { expSound } from '../audio/expedition-sound-system.js';
import { expControl } from './exp-control.js';
import { formatAltitude, formatDistance, pointAt, type RoutePos, routeYaw, yawOf } from './route-math.js';
import { prepareTopo, warmTopo } from './topo-map.js';
import type { WallId } from './walk-rules.js';

/** What you carry on the expedition. */
const EXPEDITION_KIT: Partial<Record<ItemId, number>> = {
  poles: 1,
  axes: 1,
  carabiner: 1,
  headlamp: 1,
  thermos: 1,
  warmer: 3,
  map: 1,
  flare: 2,
  glider: 1,
};

const SAVE_KEY = 'snowscene.expedition.checkpoint';
/** Longest we hold the white-out waiting for terrain tiles (s). */
const TERRAIN_TIMEOUT = 20;
/** Shortest white-out after a teleport, so streaming gets a few frames (s). */
const MIN_WHITE = 0.35;
/** Landing within this distance of Base Camp counts as making it home. */
const HOME_RADIUS = 260;

interface Milestone {
  s: number;
  name: string;
}

/** What the status line counts down to. */
const MILESTONES: Milestone[] = [
  ...CAMPS.slice(1).map((c) => ({ s: c.s, name: c.name.replace(/ · .*/u, '') })),
  { s: ICE_WALL.s, name: 'the Ice Wall' },
  { s: ROPE_START_S, name: 'the fixed rope' },
  { s: ROCK_BAND.s, name: 'the rock band' },
  { s: SUMMIT_S, name: 'the summit' },
].sort((a, b) => a.s - b.s);

const CAMP_CENTRES = CAMPS.map((camp) => campCentre(camp));

interface TerrainWait {
  x: number;
  z: number;
  started: number;
  then: () => void;
}

export class ExpeditionDirectorSystem extends createSystem({}) {
  private root!: Group;
  private readonly head = new Vector3();
  private readonly tmpPos: RoutePos = { x: 0, z: 0, elev: 0 };

  /** A teleport / start / restart is in flight. */
  private busy = false;
  private busyIdle = 0;
  private queuedFade: (() => void) | null = null;
  private wait: TerrainWait | null = null;
  private pendingUrlStart: { s?: number; resume?: boolean } | null = null;
  private readonly toastQueue: Array<{ text: string; seconds: number }> = [];

  private timeSnap = true;
  private summitClock = -1;
  private squallTimer = squallGap(Math.random());
  private squallT = -1;
  private squallDuration = 60;
  private squallPeak = 0.4;
  private squallFade = 1;

  private warmthAccum = 0;
  private warnedLow = false;
  private warnedFreezing = false;
  private warmingToasted = false;
  private frostApplied = 0;

  private camp = -1;
  private brokeOut = false;
  private maxSection = -1;
  private hintTimer = 0;
  private rescueTimer = -1;
  private landingTimer = -1;
  private landingRelaunch = false;
  private topoWarm = false;

  init(): void {
    this.root = new Group();
    this.root.name = 'ExpeditionRoot';
    this.root.visible = false;
    expRefs.root = this.world.createTransformEntity(this.root, { persistent: true });

    expHooks.toast = (text: string, seconds = 4) => this.queueToast(text, seconds);
    expHooks.respawn = (reason: string) => this.respawn(reason, false);
    expControl.start = () => this.startExpedition({ fresh: true });
    expControl.restart = () => this.startExpedition({ fresh: true });
    expControl.toTutorial = () => this.backToTutorial();
    expControl.skipAhead = () => this.skipAhead();
    expLevelHooks.wallTopped = (id: WallId) => this.onWallTopped(id);
    expLevelHooks.flare = () => this.onFlare();

    this.cleanupFuncs.push(
      game.phase.subscribe((phase) => this.onPhase(phase)),
      exp.active.subscribe((active) => {
        this.root.visible = active;
      }),
    );

    // Testing: ?expedition (resume the saved checkpoint, or &fresh), ?expedition&s=5000.
    const params = new URLSearchParams(window.location.search);
    if (params.has('expedition')) {
      const raw = params.get('s');
      const s = raw !== null && raw !== '' ? Number(raw) : NaN;
      this.pendingUrlStart = Number.isFinite(s) ? { s } : { resume: !params.has('fresh') };
      // Start white so the tutorial never flashes up.
      game.fade = 1;
      game.fadeTarget = 1;
    }

    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__exp = {
        exp,
        expFrame,
        checkpoints: CHECKPOINTS,
        start: (s?: number) => this.startExpedition(s === undefined ? { fresh: true } : { s }),
        goTo: (s: number) => this.startExpedition({ s }),
        respawn: (reason = 'Debug respawn') => this.respawn(reason, false),
        squall: () => {
          this.squallTimer = 0;
        },
        warmth: (w: number) => {
          game.warmth.value = clamp(w, 0, 1);
        },
      };
    }
  }

  // ------------------------------------------------------------ update ----

  update(delta: number, time: number): void {
    const dt = Math.min(delta, 0.1);
    this.updateKeys();
    this.updateToasts();

    if (this.pendingUrlStart && sceneRefs.tutorialRoot) {
      const opts = this.pendingUrlStart;
      this.pendingUrlStart = null;
      this.startExpedition(opts);
    }
    if (this.queuedFade && !game.pendingFadeAction && !this.wait) {
      const action = this.queuedFade;
      this.queuedFade = null;
      fadeThen(action);
    }

    // Watchdog: another system's fadeThen can replace ours before it runs.
    const inFlight = this.queuedFade !== null || game.pendingFadeAction !== null || this.wait !== null;
    this.busyIdle = this.busy && !inFlight ? this.busyIdle + dt : 0;
    if (this.busyIdle > 2) this.busy = false;

    if (!exp.active.peek()) return;

    getHeadWorld(this.world, this.head);
    trackProgress(this.head.x, this.head.y, this.head.z);
    this.updateClimate(dt);

    if (this.wait) {
      this.updateWait();
      return;
    }
    if (!this.topoWarm) this.topoWarm = warmTopo(6);
    if (this.busy) return;

    const phase = game.phase.peek();
    this.updateCamp(dt, phase);
    this.updateWarmth(dt, phase, time);
    this.updateProgress(phase);
    this.updateHint(dt, phase);
    this.updateTimers(dt);
  }

  private updateKeys(): void {
    if (this.world.renderer.xr.isPresenting) {
      expInput.sprint = false;
      return;
    }
    const kb = this.input.keyboard;
    expInput.sprint = kb.getKeyPressed('ShiftLeft') || kb.getKeyPressed('ShiftRight');
    if (kb.getKeyDown('KeyE') && !exp.active.peek() && game.phase.peek() === Phase.Landed) {
      expControl.start();
    }
    if (kb.getKeyDown('KeyK') && exp.active.peek() && this.camp >= 0) expControl.skipAhead();
  }

  // ------------------------------------------------------------ toasts ----

  private queueToast(text: string, seconds = 4): void {
    if (this.toastQueue.length >= 5) this.toastQueue.shift();
    this.toastQueue.push({ text, seconds });
  }

  private updateToasts(): void {
    if (this.toastQueue.length === 0) return;
    const current = game.toast.peek();
    if (current && current.until > performance.now() / 1000) return;
    const next = this.toastQueue.shift()!;
    toast(next.text, next.seconds);
  }

  // ------------------------------------------------- fades and teleports ----

  private requestFade(action: () => void): void {
    if (game.pendingFadeAction || this.wait) this.queuedFade = action;
    else fadeThen(action);
  }

  /** Hold the white-out until the terrain around (x, z) is streamed in. */
  private awaitTerrain(x: number, z: number, then: () => void): void {
    this.wait = { x, z, started: performance.now() / 1000, then };
  }

  private updateWait(): void {
    const wait = this.wait!;
    game.fadeTarget = 1;
    const elapsed = performance.now() / 1000 - wait.started;
    if (elapsed < MIN_WHITE) return;
    const ready = elapsed > TERRAIN_TIMEOUT || expHooks.terrainReady(wait.x, wait.z, 160);
    if (!ready) return;
    this.wait = null;
    game.fadeTarget = 0;
    wait.then();
  }

  /** Stand the player at (x, z) facing `yaw`, on foot. Call while faded out. */
  private placeAt(x: number, z: number, yaw: number): void {
    const changed = game.phase.peek() !== Phase.Poling;
    setPhase(Phase.Poling);
    // DesktopLook resets its yaw on entering Poling; match it before facing.
    if (changed && !this.world.renderer.xr.isPresenting) {
      this.world.camera.rotation.y = 0;
      this.world.camera.updateMatrixWorld(true);
    }
    game.velocity.set(0, 0, 0);
    faceYaw(this.world, yaw);
    placeHeadAt(this.world, x, z, expeditionLevel.groundAt(x, z));
    this.timeSnap = true;
    getHeadWorld(this.world, this.head);
    trackProgress(this.head.x, this.head.y, this.head.z);
  }

  private teleportToCheckpoint(index: number, then?: () => void, beforePlace?: () => void): void {
    if (this.busy) return;
    this.busy = true;
    this.rescueTimer = -1;
    this.requestFade(() => {
      resetClimb();
      equipPair('poles');
      beforePlace?.();
      const cp = CHECKPOINTS[index];
      this.setCheckpoint(index, false);
      this.placeAt(cp.x, cp.z, cp.yaw);
      this.awaitTerrain(cp.x, cp.z, () => {
        this.busy = false;
        then?.();
      });
    });
  }

  // ------------------------------------------------------- checkpoints ----

  private setCheckpoint(index: number, announce: boolean): void {
    const i = clamp(Math.round(index), 0, CHECKPOINTS.length - 1);
    if (exp.checkpoint.peek() !== i) exp.checkpoint.value = i;
    try {
      window.localStorage.setItem(SAVE_KEY, String(i));
    } catch {
      /* storage unavailable: checkpoints still work for this session */
    }
    if (announce) this.queueToast(`Checkpoint · ${CHECKPOINTS[i].name}`, 3);
  }

  private loadCheckpoint(): number {
    try {
      const raw = window.localStorage.getItem(SAVE_KEY);
      const i = raw === null ? 0 : Number(raw);
      return Number.isInteger(i) && i >= 0 && i < CHECKPOINTS.length ? i : 0;
    } catch {
      return 0;
    }
  }

  private clearSave(): void {
    try {
      window.localStorage.removeItem(SAVE_KEY);
    } catch {
      /* ignore */
    }
  }

  // -------------------------------------------------- start / restart ----

  private resetExpeditionState(): void {
    if (exp.summited.peek()) exp.summited.value = false;
    if (exp.finished.peek()) exp.finished.value = false;
    if (exp.ropeClipped.peek()) exp.ropeClipped.value = false;
    if (equipment.clipped.peek()) equipment.clipped.value = false;
    if (equipment.headlampOn.peek()) equipment.headlampOn.value = false;
    game.warmth.value = 1;
    game.thermosSips = 4;
    resetClimb();
    this.summitClock = -1;
    this.squallT = -1;
    this.squallTimer = squallGap(Math.random());
    expFrame.squall = 0;
    this.warmthAccum = 0;
    this.warnedLow = false;
    this.warnedFreezing = false;
    this.camp = -1;
    expControl.camp.value = -1;
    expControl.hint.value = '';
    this.maxSection = -1;
    this.rescueTimer = -1;
    this.landingTimer = -1;
    this.toastQueue.length = 0;
    game.toast.value = null;
    this.timeSnap = true;
  }

  /**
   * Leave whatever is going on (tutorial or expedition) and start the
   * expedition: at Base Camp (`fresh`), at a saved checkpoint (`resume`) or
   * at arc length `s` (testing).
   */
  private startExpedition(opts: { fresh?: boolean; resume?: boolean; s?: number }): void {
    if (this.busy) return;
    this.busy = true;
    this.requestFade(() => {
      const tutorial = sceneRefs.tutorialRoot?.object3D;
      if (tutorial) tutorial.visible = false;
      requestRestart();
      level.value = expeditionLevel;
      exp.active.value = true;
      this.resetExpeditionState();
      setPack(EXPEDITION_KIT);
      equipPair('poles');

      let s: number | null = null;
      let index = 0;
      if (opts.s !== undefined) {
        s = clamp(opts.s, 0, route.length - 1);
        index = checkpointAtOrBefore(s);
      } else if (opts.resume) {
        index = this.loadCheckpoint();
      }
      this.setCheckpoint(index, false);
      if (opts.fresh) this.setCheckpoint(0, false);
      const progress = s ?? CHECKPOINTS[index].s;
      if (progress >= SUMMIT_S - 4) this.markSummit(false);

      let x: number;
      let z: number;
      if (s !== null) {
        pointAt(s, this.tmpPos);
        x = this.tmpPos.x;
        z = this.tmpPos.z;
        this.placeAt(x, z, routeYaw(s));
      } else {
        const cp = CHECKPOINTS[index];
        x = cp.x;
        z = cp.z;
        this.placeAt(x, z, cp.yaw);
      }
      // Sections already behind you don't announce themselves.
      this.maxSection = SECTION_ORDER.indexOf(exp.section.peek()) - 1;
      // Build the map sheet while the screen is white.
      prepareTopo();
      this.topoWarm = true;
      this.awaitTerrain(x, z, () => {
        this.busy = false;
      });
    });
  }

  private backToTutorial(): void {
    if (this.busy) return;
    this.busy = true;
    this.requestFade(() => {
      exp.active.value = false;
      const tutorial = sceneRefs.tutorialRoot?.object3D;
      if (tutorial) tutorial.visible = true;
      this.resetExpeditionState();
      level.value = tutorialLevel;
      const rig = this.player;
      rig.rotation.y = 0;
      rig.position.set(0, 0, 0);
      rig.updateMatrixWorld(true);
      setPhase(Phase.Poling);
      if (!this.world.renderer.xr.isPresenting) {
        this.world.camera.rotation.y = 0;
        this.world.camera.updateMatrixWorld(true);
      }
      faceYaw(this.world, 0);
      placeHeadAt(this.world, 0, 0.3, 0);
      game.velocity.set(0, 0, 0);
      game.distanceToCliff.value = Math.round(-WALL_Z);
      requestRestart();
      startTutorialKit();
      this.busy = false;
    });
  }

  private skipAhead(): void {
    if (!exp.active.peek() || this.busy || this.camp < 0) return;
    if (game.phase.peek() !== Phase.Poling) return;
    const target = skipTarget(this.camp);
    if (target < 0) return;
    const name = CHECKPOINTS[target].name;
    this.teleportToCheckpoint(target, () => this.queueToast(`Skipped ahead to ${name}`, 4));
  }

  /** Return to the last checkpoint (or the last camp when cold). */
  private respawn(reason: string, toCamp: boolean): void {
    if (!exp.active.peek() || this.busy) return;
    const phase = game.phase.peek();
    if (phase === Phase.Launch || phase === Phase.Gliding || phase === Phase.Landed) return;
    const current = exp.checkpoint.peek();
    const index = toCamp ? lastCampAtOrBefore(current) : current;
    const cp = CHECKPOINTS[index];
    this.teleportToCheckpoint(
      index,
      () => this.queueToast(`${reason}. Back at ${cp.name}`, 5),
      toCamp
        ? () => {
            game.warmth.value = 0.85;
            this.warnedLow = false;
            this.warnedFreezing = false;
          }
        : undefined,
    );
  }

  // ------------------------------------------------------------ events ----

  private onPhase(phase: Phase): void {
    if (!exp.active.peek()) return;
    if (phase === Phase.Climbing) this.squallFade = Math.min(this.squallFade, 0.999);
    if (phase === Phase.Landed && exp.summited.peek() && !exp.finished.peek()) this.onLanded();
  }

  private onLanded(): void {
    getHeadWorld(this.world, this.head);
    const home = CAMP_CENTRES[0];
    const d = Math.hypot(this.head.x - home.x, this.head.z - home.z);
    if (d < HOME_RADIUS) {
      this.finish();
      return;
    }
    if (this.player.position.y > home.elev + 120) {
      // Flew into the mountain: back up to the launch for another go.
      this.queueToast('Crash landing! Back to the summit to try again', 4);
      this.landingRelaunch = true;
    } else {
      // Came down somewhere else in the valley: the camp team brings you home.
      this.queueToast('Rough landing! The camp team comes to fetch you', 4);
      this.landingRelaunch = false;
    }
    this.landingTimer = 2.5;
  }

  private relaunch(): void {
    this.busy = true;
    this.requestFade(() => {
      setPhase(Phase.Launch);
      const site = expeditionLevel.launch();
      this.awaitTerrain(site.x, site.z, () => {
        this.busy = false;
      });
    });
  }

  private rescueHome(): void {
    this.busy = true;
    this.requestFade(() => {
      if (game.flyingGlider) game.flyingGlider.visible = false;
      const home = CAMP_CENTRES[0];
      pointAt(CAMPS[0].s, this.tmpPos);
      const ox = this.tmpPos.x - home.x;
      const oz = this.tmpPos.z - home.z;
      const len = Math.hypot(ox, oz) || 1;
      const x = home.x + (ox / len) * 12;
      const z = home.z + (oz / len) * 12;
      faceYaw(this.world, yawOf(-ox, -oz));
      placeHeadAt(this.world, x, z, expeditionLevel.groundAt(x, z));
      this.awaitTerrain(x, z, () => {
        this.busy = false;
        this.finish();
      });
    });
  }

  private finish(): void {
    if (!exp.finished.peek()) exp.finished.value = true;
    this.clearSave();
    this.queueToast('Welcome home. Thanks for playing!', 6);
    expSound.sting('finale');
  }

  private markSummit(announce: boolean): void {
    if (!exp.summited.peek()) exp.summited.value = true;
    this.summitClock = 0;
    audio.setMusic('night');
    const index = checkpointIndex('summit');
    if (index > exp.checkpoint.peek()) this.setCheckpoint(index, false);
    if (announce) {
      audio.fanfare();
      expSound.sting('summit');
      this.queueToast(`Summit · ${formatAltitude(SUMMIT_ELEV)}`, 6);
      this.queueToast('Take the glider from your pack and drop it', 6);
    }
  }

  private onWallTopped(id: WallId): void {
    const index = checkpointIndex(id === 'ice' ? 'icetop' : 'rocktop');
    if (index > exp.checkpoint.peek()) this.setCheckpoint(index, false);
    // Desktop only: turn to face up the route (no snap-turns in a headset).
    if (!this.world.renderer.xr.isPresenting) {
      this.world.camera.rotation.y = 0;
      this.world.camera.updateMatrixWorld(true);
      faceYaw(this.world, CHECKPOINTS[index].yaw);
    }
    const top = id === 'ice' ? ICE_WALL.topY : ROCK_BAND.topY;
    this.queueToast(
      id === 'ice' ? `Top of the Ice Wall · ${formatAltitude(Math.round(top / 10) * 10)}` : 'Over the rock band. The summit is close',
      4,
    );
  }

  private onFlare(): string {
    const phase = game.phase.peek();
    if (!exp.active.peek() || (phase !== Phase.Poling && phase !== Phase.Climbing)) {
      return 'Your flare lights up the sky';
    }
    if (exp.summited.peek()) return 'Your flare lights up the summit';
    this.rescueTimer = 5;
    return 'Flare away! A rescue team is coming';
  }

  private updateTimers(dt: number): void {
    if (this.rescueTimer > 0) {
      this.rescueTimer -= dt;
      if (this.rescueTimer <= 0) {
        this.rescueTimer = -1;
        this.respawn('A rescue team found you', false);
      }
    }
    if (this.landingTimer > 0) {
      this.landingTimer -= dt;
      if (this.landingTimer <= 0) {
        this.landingTimer = -1;
        if (this.landingRelaunch) this.relaunch();
        else this.rescueHome();
      }
    }
  }

  // ------------------------------------------------------------ climate ----

  private updateClimate(dt: number): void {
    const phase = game.phase.peek();
    // Time of day follows progress; after the summit the sun keeps rising.
    let target: number;
    if (this.summitClock >= 0) {
      this.summitClock += dt;
      target = timeOfDayAt(route.length) + Math.min(1.6, this.summitClock / 150);
    } else {
      target = timeOfDayAt(expFrame.s);
    }
    if (this.timeSnap) {
      expFrame.timeOfDay = target;
      this.timeSnap = false;
    } else {
      expFrame.timeOfDay += (target - expFrame.timeOfDay) * (1 - Math.exp(-dt / 2.5));
    }
    expFrame.daylight = daylightAt(expFrame.timeOfDay);

    // Squalls: a real-time schedule on top of the baseline, never on a climb.
    const canSquall =
      phase === Phase.Poling && !this.busy && !this.wait && this.camp < 0 && !exp.summited.peek();
    if (this.squallT >= 0) {
      this.squallT += dt;
      if (!canSquall) this.squallFade = Math.min(this.squallFade, 0.999);
      if (this.squallFade < 1) this.squallFade = Math.max(0, this.squallFade - dt / 6);
      expFrame.squall = squallEnvelope(this.squallT, this.squallDuration, this.squallPeak) * this.squallFade;
      if (this.squallT > this.squallDuration || this.squallFade <= 0) {
        this.squallT = -1;
        expFrame.squall = 0;
        this.squallTimer = squallGap(Math.random());
      }
    } else {
      expFrame.squall = 0;
      if (canSquall) {
        this.squallTimer -= dt;
        if (this.squallTimer <= 0) {
          this.squallT = 0;
          this.squallFade = 1;
          this.squallDuration = SQUALL.minDuration + (SQUALL.maxDuration - SQUALL.minDuration) * Math.random();
          this.squallPeak = SQUALL.minPeak + (SQUALL.maxPeak - SQUALL.minPeak) * Math.random();
          this.queueToast('A squall is coming in', 4);
        }
      }
    }

    let baseline: number;
    if (phase === Phase.Launch || phase === Phase.Gliding) baseline = 0.04;
    else if (phase === Phase.Landed) baseline = 0.08;
    else baseline = baseStormAt(expFrame.s);
    expFrame.storm = clamp(baseline + expFrame.squall, 0, 1);
    expFrame.cold = coldAt(this.player.position.y, expFrame.daylight, expFrame.storm);
  }

  // ------------------------------------------------------- camps / warmth ----

  private updateCamp(dt: number, phase: Phase): void {
    let inCamp = -1;
    for (let i = 0; i < CAMPS.length; i++) {
      const c = CAMP_CENTRES[i];
      const d = Math.hypot(this.head.x - c.x, this.head.z - c.z);
      if (d < CAMPS[i].radius + (this.camp === i ? 6 : 1)) inCamp = i;
    }
    if (inCamp !== this.camp) {
      this.camp = inCamp;
      expControl.camp.value = inCamp;
      this.warmingToasted = false;
      if (inCamp > 0 && phase === Phase.Poling && !exp.summited.peek()) {
        this.queueToast(CAMPS[inCamp].name, 3);
        expSound.sting('camp');
        this.queueToast('Rest by the fire: hold your hands to it to warm up', 5);
        if (game.thermosSips < 4) {
          game.thermosSips = 4;
          this.queueToast('Thermos refilled', 3);
        }
        const index = CHECKPOINTS.findIndex((c: Checkpoint) => c.campIndex === inCamp);
        if (index > exp.checkpoint.peek()) this.setCheckpoint(index, false);
      }
    }
    if (this.camp < 0) return;
    // Sheltered in camp; much warmer with your hands held to the fire.
    const fire = CAMP_CENTRES[this.camp];
    let rate = 0.012;
    if (this.world.renderer.xr.isPresenting) {
      for (const hand of HANDS) {
        if (!hand.tracked) continue;
        const dh = Math.hypot(hand.position.x - fire.x, hand.position.z - fire.z);
        if (dh < 2.4 && hand.position.y < fire.elev + 2.6) rate = 0.09;
      }
    } else if (Math.hypot(this.head.x - fire.x, this.head.z - fire.z) < 7) {
      rate = 0.07;
    }
    if (rate > 0.05 && !this.warmingToasted && game.warmth.peek() < 0.95) {
      this.warmingToasted = true;
      this.queueToast('Warming up…', 2.5);
    }
    this.warmthAccum += rate * dt;
  }

  private updateWarmth(dt: number, phase: Phase, time: number): void {
    const onFoot = phase === Phase.Poling || phase === Phase.Climbing;
    if (onFoot && this.camp < 0) {
      this.warmthAccum -= expFrame.cold * WARMTH_DRAIN_AT_FULL_COLD * (phase === Phase.Climbing ? 0.8 : 1) * dt;
    }
    if (Math.abs(this.warmthAccum) >= 0.004) {
      addWarmth(this.warmthAccum);
      this.warmthAccum = 0;
    }
    const w = game.warmth.peek();
    if (w > 0.5) {
      this.warnedLow = false;
      this.warnedFreezing = false;
    }
    if (onFoot && w < 0.35 && !this.warnedLow) {
      this.warnedLow = true;
      this.queueToast("You're getting cold. Tea or a hand warmer will help", 5);
    }
    if (onFoot && w < 0.15 && !this.warnedFreezing) {
      this.warnedFreezing = true;
      this.queueToast('Freezing! Warm up now', 4);
    }
    // Frost creeping in at the edge of your vision.
    let frost = 0;
    if (onFoot && w < 0.2) frost = 0.5 * (1 - smoothstep(0, 0.2, w)) * (0.82 + 0.18 * Math.sin(time * 1.7));
    if (!game.pendingFadeAction && (frost > 0.001 || this.frostApplied > 0)) {
      game.fadeTarget = frost;
      this.frostApplied = frost;
    }
    if (onFoot && w <= 0.001) {
      this.frostApplied = 0;
      this.respawn('Too cold. You turned back to warm up', true);
    }
  }

  // ----------------------------------------------------------- progress ----

  private updateProgress(phase: Phase): void {
    const s = expFrame.s;
    // Section entry.
    const sectionIndex = SECTION_ORDER.indexOf(exp.section.peek());
    if (sectionIndex > this.maxSection && (phase === Phase.Poling || phase === Phase.Climbing)) {
      this.maxSection = sectionIndex;
      const alt = Math.round(this.player.position.y / 10) * 10;
      this.queueToast(`${SECTION_NAMES[exp.section.peek()]} · ${formatAltitude(alt)}`, 4);
    }
    if (phase !== Phase.Poling) return;
    // Checkpoints reached on foot.
    let index = exp.checkpoint.peek();
    const before = index;
    while (index + 1 < CHECKPOINTS.length && CHECKPOINTS[index + 1].s <= s + 0.5) index++;
    if (index !== before && Math.abs(expFrame.d) < 40) {
      this.setCheckpoint(index, !CHECKPOINTS[index].camp && CHECKPOINTS[index].id !== 'summit');
    }
    // Breaking out above the sea of clouds.
    if (!this.brokeOut && this.player.position.y > EXP_CLOUD_DECK_Y + 40 && s < ICE_WALL.s) {
      this.brokeOut = true;
      expSound.sting('breakout');
      this.queueToast('Above the clouds', 4);
    } else if (this.player.position.y < EXP_CLOUD_DECK_Y - 40) {
      this.brokeOut = false;
    }
    // The summit.
    if (!exp.summited.peek() && s >= SUMMIT_S - 2 && this.player.position.y > ROCK_BAND.topY) {
      this.markSummit(true);
    }
  }

  private updateHint(dt: number, phase: Phase): void {
    this.hintTimer -= dt;
    if (this.hintTimer > 0) return;
    this.hintTimer = 0.5;
    let text = '';
    if (exp.finished.peek() || phase === Phase.Gliding || phase === Phase.Launch) {
      text = '';
    } else if (phase === Phase.Climbing) {
      const wall = expeditionWall();
      if (wall) {
        const top = wall === 'ice' ? ICE_WALL.topY : ROCK_BAND.topY;
        const left = Math.max(0, Math.round(top - this.player.position.y));
        text = `${left} m to the top`;
      }
    } else if (exp.summited.peek()) {
      text = this.world.renderer.xr.isPresenting ? 'Palm up for your pack' : 'B: pack · pick the glider · U: drop it';
    } else if (this.camp >= 0) {
      text = this.world.renderer.xr.isPresenting ? 'Rest here, or skip ahead' : 'Rest here, or press K to skip ahead';
    } else {
      const s = expFrame.s;
      const next = MILESTONES.find((m) => m.s > s + 5);
      if (next) text = `${formatDistance(next.s - s)} to ${next.name}`;
    }
    if (expControl.hint.peek() !== text) expControl.hint.value = text;
  }
}
