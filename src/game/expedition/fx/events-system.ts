/**
 * ExpeditionEventsSystem: fires the set pieces from the player's progress
 * (`expFrame.s`) while the expedition is active, each once per attempt:
 *
 *   avalanche  (AVALANCHE.triggerS)   moraine
 *   serac      (SERAC.triggerS)       glacier
 *   rockfall   (ROCKFALL.triggerS)    night ridge
 *   eagles     (always, lower mountain; formation during the summit glide)
 *   fireworks  (exp.finished becomes true: landed at Base Camp)
 *
 * An event triggers when the player walks forward across its trigger arc
 * length (never by being placed beyond it). A respawn (a jump of more than
 * 15 m in s while walking) re-arms every event ahead of the new position
 * and clears its debris; `expeditionEvents.rearmFrom(s)` does the same on
 * request.
 *
 * No camera motion anywhere (VR comfort). Threat is carried by positional
 * audio, controller rumble, a powder haze around the head and, when caught,
 * a whiteout before `expHooks.respawn(reason)`.
 */

import {
  BackSide,
  Color,
  createSystem,
  Group,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  Vector3,
} from '@iwsdk/core';
import { level } from '../../level.js';
import { getHeadWorld, getHeadYaw } from '../../rig.js';
import { game, Phase } from '../../state.js';
import { AVALANCHE, CAMPS, campCentre, ROCKFALL, SERAC } from '../exp-layout.js';
import { SUMMIT_X, SUMMIT_Z } from '../exp-route.js';
import { exp, expFrame, expHooks, expRefs } from '../exp-state.js';
import { expeditionHeight } from '../exp-terrain.js';
import { Avalanche } from './avalanche.js';
import { EagleFlock } from './eagle.js';
import { expeditionEvents, type FxContext } from './fx-context.js';
import { setListener } from './fx-audio.js';
import { FireworksShow } from './fireworks.js';
import { PowderCloud } from './powder-cloud.js';
import { Rockfall } from './rockfall.js';
import { SeracCollapse } from './serac.js';

/** Live powder puffs shared by all events (with 1800 + 96 sparks: < 3000). */
const POWDER_CAPACITY = 640;
/** A jump in s bigger than this in one frame is a respawn/teleport. */
const TELEPORT_JUMP = 15;

type EngulfPhase = 'none' | 'rising' | 'waiting' | 'falling';

interface Haptics {
  pulse?: (value: number, duration: number) => void;
}

/** Walked forward across a trigger this frame (not placed beyond it). */
function crossed(prev: number, s: number, trigger: number): boolean {
  return prev < trigger && s >= trigger && s < trigger + 40;
}

const groundAt = (x: number, z: number): number => {
  const l = level.peek();
  return l && l.id === 'expedition' ? l.groundAt(x, z) : expeditionHeight(x, z);
};

export class ExpeditionEventsSystem extends createSystem({}) {
  private built = false;
  private group!: Group;
  private powder!: PowderCloud;
  private avalanche!: Avalanche;
  private serac!: SeracCollapse;
  private rockfall!: Rockfall;
  private eagles!: EagleFlock;
  private fireworks!: FireworksShow;
  private whiteout!: Mesh;
  private whiteMat!: MeshBasicMaterial;
  private readonly head = new Vector3();
  private readonly right = new Vector3();
  private readonly tmp = new Vector3();
  private prevS = Number.NaN;
  private hiddenWhileInactive = true;
  private haze = 0;
  // Engulf / whiteout sequence.
  private engulfPhase: EngulfPhase = 'none';
  private engulfReason = '';
  private engulfRate = 2;
  private engulfTimer = 0;
  private white = 0;
  private teleported = false;
  private hapticUntil = 0;
  private hapticLevel = 0;
  private time = 0;
  private pendingFireworks = false;
  private ctx!: FxContext;

  init(): void {
    const self = this;
    this.ctx = {
      head: this.head,
      right: this.right,
      floorY: 0,
      s: 0,
      d: 0,
      dt: 0,
      time: 0,
      get powder() {
        return self.powder;
      },
      haptic: (lvl: number, ms = 100) => this.haptic(lvl, ms),
      engulf: (reason: string, seconds = 0.6) => this.engulf(reason, seconds),
      get dying() {
        return self.engulfPhase !== 'none';
      },
      toast: (text: string, seconds?: number) => expHooks.toast(text, seconds),
    } as FxContext;

    expeditionEvents.rearmFrom = (s: number) => this.rearmFrom(s);
    expeditionEvents.resetAll = () => this.resetAll();
    expeditionEvents.trigger = (name) => this.forceTrigger(name);

    this.cleanupFuncs.push(
      exp.active.subscribe((active) => {
        if (!active) this.resetAll();
      }),
      exp.finished.subscribe((finished) => {
        if (finished) this.pendingFireworks = true;
        else if (this.built) this.fireworks.stop();
      }),
      game.resetCount.subscribe(() => this.resetAll()),
    );
  }

  private build(): void {
    const root = expRefs.root;
    if (!root) return;
    this.group = new Group();
    this.group.name = 'ExpeditionEvents';
    this.world.createTransformEntity(this.group, { parent: root, persistent: true });
    this.powder = new PowderCloud(POWDER_CAPACITY);
    this.avalanche = new Avalanche(groundAt);
    this.serac = new SeracCollapse(groundAt);
    this.rockfall = new Rockfall(groundAt);
    this.eagles = new EagleFlock(groundAt);
    this.fireworks = new FireworksShow(groundAt);
    this.whiteMat = new MeshBasicMaterial({
      color: new Color(0.96, 0.97, 1),
      side: BackSide,
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
    this.whiteout = new Mesh(new SphereGeometry(0.3, 16, 12), this.whiteMat);
    this.whiteout.name = 'PowderWhiteout';
    this.whiteout.renderOrder = 9990;
    this.whiteout.frustumCulled = false;
    this.whiteout.visible = false;
    this.group.add(
      this.avalanche.group,
      this.serac.group,
      this.rockfall.group,
      this.eagles.mesh,
      this.fireworks.sparks.points,
      this.powder.mesh,
      this.whiteout,
    );
    this.built = true;
  }

  // ------------------------------------------------------------ control --

  private resetAll(): void {
    if (!this.built) return;
    this.avalanche.reset();
    this.serac.reset();
    this.rockfall.reset();
    this.eagles.reset();
    this.fireworks.stop();
    this.powder.clear();
    this.prevS = Number.NaN;
    this.engulfPhase = 'none';
    this.white = 0;
    this.haze = 0;
    this.whiteout.visible = false;
  }

  /** Re-arm every event whose trigger lies at or ahead of s. */
  private rearmFrom(s: number): void {
    if (!this.built) return;
    if (AVALANCHE.triggerS >= s - 5) this.avalanche.reset();
    if (SERAC.triggerS >= s - 5) this.serac.reset();
    if (ROCKFALL.triggerS >= s - 5) this.rockfall.reset();
    this.powder.clear();
    this.prevS = s;
  }

  private forceTrigger(name: 'avalanche' | 'serac' | 'rockfall' | 'fireworks' | 'eaglePass'): void {
    if (!this.built) return;
    switch (name) {
      case 'avalanche':
        this.avalanche.reset();
        this.avalanche.trigger(this.ctx);
        break;
      case 'serac':
        this.serac.reset();
        this.serac.trigger(this.ctx);
        break;
      case 'rockfall':
        this.rockfall.reset();
        this.rockfall.trigger(this.ctx);
        break;
      case 'fireworks':
        this.pendingFireworks = true;
        break;
      case 'eaglePass':
        this.eagles.forcePass(this.head);
        break;
    }
  }

  private startFireworks(): void {
    const c = campCentre(CAMPS[0]);
    const ox = c.x - SUMMIT_X;
    const oz = c.z - SUMMIT_Z;
    this.tmp.set(c.x, groundAt(c.x, c.z), c.z);
    this.fireworks.start(this.tmp, ox, oz);
  }

  private haptic(lvl: number, ms: number): void {
    // Throttle: a new pulse only when the last has run out or this is stronger.
    if (this.time < this.hapticUntil && lvl <= this.hapticLevel) return;
    this.hapticUntil = this.time + ms / 1000;
    this.hapticLevel = lvl;
    const v = Math.max(0, Math.min(1, lvl));
    const pads = this.input.xr.gamepads;
    (pads.left?.gamepad?.hapticActuators?.[0] as Haptics | undefined)?.pulse?.(v, ms);
    (pads.right?.gamepad?.hapticActuators?.[0] as Haptics | undefined)?.pulse?.(v, ms);
  }

  private engulf(reason: string, seconds: number): void {
    if (this.engulfPhase !== 'none') return;
    this.engulfPhase = 'rising';
    this.engulfReason = reason;
    this.engulfRate = 1 / Math.max(0.1, seconds);
    this.engulfTimer = 0;
    this.teleported = false;
  }

  // ------------------------------------------------------------- update --

  update(delta: number, time: number): void {
    this.time = time;
    if (!exp.active.peek()) {
      if (this.built && !this.hiddenWhileInactive) {
        this.group.visible = false;
        this.hiddenWhileInactive = true;
      }
      return;
    }
    if (!this.built) {
      this.build();
      if (!this.built) return;
    }
    if (this.hiddenWhileInactive) {
      this.group.visible = true;
      this.hiddenWhileInactive = false;
    }
    const dt = Math.min(delta, 0.05);
    const ctx = this.ctx;
    getHeadWorld(this.world, this.head);
    const yaw = getHeadYaw(this.world);
    this.right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    setListener(this.head, this.right);
    ctx.floorY = groundAt(this.head.x, this.head.z);
    ctx.dt = dt;
    ctx.time = time;
    const s = expFrame.s;
    ctx.s = s;
    ctx.d = expFrame.d;

    const phase = game.phase.peek();
    const walking = phase === Phase.Poling || phase === Phase.Climbing;
    const prev = this.prevS;
    if (walking && !Number.isNaN(prev) && Math.abs(s - prev) > TELEPORT_JUMP) {
      // Respawned (or moved by the director): replay what lies ahead.
      this.teleported = true;
      this.rearmFrom(s);
    } else if (walking && !Number.isNaN(prev) && this.engulfPhase === 'none') {
      if (this.avalanche.state === 'armed' && crossed(prev, s, AVALANCHE.triggerS)) this.avalanche.trigger(ctx);
      if (this.serac.state === 'armed' && crossed(prev, s, SERAC.triggerS)) this.serac.trigger(ctx);
      if (this.rockfall.state === 'armed' && crossed(prev, s, ROCKFALL.triggerS)) this.rockfall.trigger(ctx);
    }
    this.prevS = walking ? s : Number.NaN;

    if (this.pendingFireworks) {
      this.pendingFireworks = false;
      this.startFireworks();
    }

    // Light for the powder: the sun by day, the moon by night.
    const daylight = expFrame.daylight;
    this.powder.setLight(daylight > 0.15 ? expFrame.sunDirection : expFrame.moonDirection, daylight);

    const onMountain = !exp.summited.peek() || phase !== Phase.Gliding;
    this.avalanche.setNearby(onMountain && s > 2450 && s < 4300);
    this.serac.setNearby(onMountain && s > 4500 && s < 5750);
    this.rockfall.setNearby(onMountain && s > 6500 && s < 7450);
    this.avalanche.update(ctx);
    this.serac.update(ctx);
    this.rockfall.update(ctx);
    this.eagles.update(dt, time, this.head);
    if (this.fireworks.active) this.fireworks.update(dt, time);
    this.powder.update(dt, this.head);

    this.updateWhiteout(dt);
  }

  private updateWhiteout(dt: number): void {
    // Haze from powder puffs around the head (sprites fade near the eye).
    const hazeTarget = Math.min(0.85, this.powder.densityAtHead * 0.9);
    this.haze += (hazeTarget - this.haze) * Math.min(1, dt * 3);
    switch (this.engulfPhase) {
      case 'rising':
        this.white = Math.min(1, this.white + dt * this.engulfRate);
        if (this.white >= 1) {
          this.engulfPhase = 'waiting';
          this.engulfTimer = 0;
          expHooks.respawn(this.engulfReason);
        }
        break;
      case 'waiting':
        this.engulfTimer += dt;
        if (this.teleported || this.engulfTimer > 3.5) {
          this.engulfPhase = 'falling';
          this.powder.clear();
          this.haze = 0;
        }
        break;
      case 'falling':
        this.white = Math.max(0, this.white - dt / 0.9);
        if (this.white <= 0) this.engulfPhase = 'none';
        break;
      default:
        this.white = 0;
    }
    const opacity = Math.max(this.white, this.haze);
    this.whiteout.visible = opacity > 0.005;
    if (this.whiteout.visible) {
      this.whiteMat.opacity = opacity;
      this.whiteout.position.copy(this.head);
    }
  }
}
