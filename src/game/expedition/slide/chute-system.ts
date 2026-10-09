/**
 * The ride down the Summit Chute (DOWN's slides, down a real mountainside).
 *
 * After the summit, walk into the start gate by the launch flags. The rig
 * rides the chute by arc length facing straight down it, so "lean left /
 * right" is always your own left and right: lean (or step) into an open lane
 * to slip past the barriers. Speed follows the slope: a quick run across the
 * summit dome, then the plunge over the rock band and down the ridge face.
 * Clip a barrier and you go back to the last arch for another go. The ride
 * stops on the deck above the ice cliff, where you unpack the glider.
 *
 * Desktop: A / D (or the arrow keys) lean.
 */

import { createSystem, type Group, Vector3 } from '@iwsdk/core';
import { audio } from '../../audio.js';
import { stowAll } from '../../equipment.js';
import { getHeadWorld } from '../../rig.js';
import { sceneRefs } from '../../scene-system.js';
import { fadeThen, game, Phase, setPhase, toast } from '../../state.js';
import { exp, expRefs } from '../exp-state.js';
import { buildChute } from './chute-build.js';
import { chute, type ChuteSample, chuteSample, chuteSpeed, LANE_X } from './chute-path.js';
import { chuteState } from './chute-state.js';

/** Seconds of 3-2-1 before each run. */
const COUNT_IN = 3;
/** Ease-in to speed, for comfort (s). */
const LAUNCH_TIME = 1.4;
/** Braking onto the deck (m/s^2). */
const BRAKE = 15;
/** A barrier catches the head this close to its lane centre. */
const HIT_HALF_WIDTH = 0.34;
/** Desktop lean (m). */
const LEAN = 0.6;
/** Walk within this of the gate (plan metres) to start. */
const GATE_RADIUS = 1.6;
/** Show the chute within this of its middle. */
const SHOW_RADIUS = 1400;

type Mode = 'idle' | 'countin' | 'riding' | 'crashed' | 'braking' | 'arrived';

export class ChuteSystem extends createSystem({}) {
  private group: Group | null = null;
  private mode: Mode = 'idle';
  private s = 0;
  private prevS = 0;
  private speed = 0;
  private elapsed = 0;
  private countIn = 0;
  private lastCount = -1;
  private rumbleTimer = 0;
  private lean = 0;
  private starting = false;
  private readonly calib = new Vector3();
  private readonly head = new Vector3();
  private readonly local = new Vector3();
  private readonly mid = new Vector3();
  private readonly sample: ChuteSample = { x: 0, y: 0, z: 0, slope: 0, lift: 0 };

  init(): void {
    const c = chute();
    const m = Math.floor(c.u.length / 2);
    this.mid.set(c.x[m], c.y[m], c.z[m]);
    this.cleanupFuncs.push(
      game.phase.subscribe((phase) => {
        if (phase !== Phase.Sliding) this.halt();
      }),
      game.resetCount.subscribe(() => this.reset()),
      exp.active.subscribe((active) => {
        if (!active) this.reset();
      }),
      game.recentre.subscribe((n) => {
        if (n > 0 && game.phase.peek() === Phase.Sliding && (this.mode === 'countin' || this.mode === 'arrived')) this.recentre();
      }),
    );
  }

  private reset(): void {
    this.halt();
    this.mode = 'idle';
    this.starting = false;
    if (chuteState.arrived.peek()) chuteState.arrived.value = false;
  }

  private halt(): void {
    if (this.mode !== 'arrived') this.mode = 'idle';
    this.speed = 0;
    if (chuteState.riding.peek()) chuteState.riding.value = false;
    if (game.phase.peek() !== Phase.Gliding) game.airspeed = 0;
  }

  /** Under the fade: stand at a restart arch, centred in the middle lane. */
  private begin(checkpoint: number): void {
    const c = chute();
    this.s = c.checkpoints[checkpoint];
    this.prevS = this.s;
    this.speed = 0;
    this.lean = 0;
    this.mode = 'countin';
    this.countIn = COUNT_IN;
    this.lastCount = -1;
    if (!chuteState.riding.peek()) chuteState.riding.value = true;
    this.centre();
  }

  /** Take wherever the head is now as the middle lane. */
  private centre(): void {
    this.calib.set(0, 0, 0);
    this.place();
    getHeadWorld(this.world, this.head);
    this.local.copy(this.head);
    this.player.worldToLocal(this.local);
    this.calib.set(this.local.x, 0, this.local.z);
    this.place();
  }

  private recentre(): void {
    this.centre();
    toast(this.mode === 'arrived' ? 'Recentred on the deck.' : 'Recentred: you are in the middle lane.', 2);
  }

  /** Put the rig on the chute at the current arc length. */
  private place(): void {
    const c = chute();
    chuteSample(this.s, this.sample);
    const yaw = c.yaw;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    // Rotate the calibration offset into the world (yaw about +Y).
    const ox = this.calib.x * cy + this.calib.z * sy;
    const oz = -this.calib.x * sy + this.calib.z * cy;
    const rig = this.player;
    rig.rotation.set(0, yaw, 0);
    rig.position.set(
      this.sample.x + c.rightX * this.lean - ox,
      this.sample.y,
      this.sample.z + c.rightZ * this.lean - oz,
    );
    rig.updateMatrixWorld(true);
  }

  update(delta: number): void {
    const root = expRefs.root?.object3D;
    if (!this.group && root) {
      this.group = buildChute().group;
      this.world.createTransformEntity(this.group, { parent: expRefs.root!, persistent: true });
    }
    if (!exp.active.peek()) {
      if (this.group) this.group.visible = false;
      return;
    }
    getHeadWorld(this.world, this.head);
    if (this.group) this.group.visible = this.head.distanceTo(this.mid) < SHOW_RADIUS;

    const dt = Math.min(delta, 0.1);
    const phase = game.phase.peek();
    if (phase === Phase.Poling) {
      this.checkGate();
      return;
    }
    if (phase !== Phase.Sliding) return;

    if (!this.world.renderer.xr.isPresenting) {
      const k = this.input.keyboard;
      const left = k.getKeyPressed('KeyA') || k.getKeyPressed('ArrowLeft');
      const right = k.getKeyPressed('KeyD') || k.getKeyPressed('ArrowRight');
      const target = left === right ? 0 : left ? -LEAN : LEAN;
      this.lean += (target - this.lean) * Math.min(1, dt * 10);
    } else this.lean = 0;

    switch (this.mode) {
      case 'countin':
        this.countIn -= dt;
        {
          const n = Math.ceil(this.countIn);
          if (n !== this.lastCount && n > 0) {
            this.lastCount = n;
            audio.tock(n);
          }
        }
        if (this.countIn < 0) {
          this.mode = 'riding';
          this.elapsed = 0;
          audio.whoosh();
        }
        this.place();
        return;
      case 'riding':
      case 'braking':
        this.ride(dt);
        return;
      default:
        return;
    }
  }

  /** Walk into the start gate (once the summit is reached) to begin. */
  private checkGate(): void {
    if (!exp.summited.peek() || chuteState.arrived.peek() || this.starting) return;
    const c = chute();
    if (Math.hypot(this.head.x - c.x[0], this.head.z - c.z[0]) > GATE_RADIUS) return;
    if (Math.abs(this.head.y - c.y[0]) > 3) return;
    this.starting = true;
    game.velocity.set(0, 0, 0);
    fadeThen(() => {
      this.starting = false;
      stowAll();
      setPhase(Phase.Sliding);
      this.begin(0);
      toast(this.world.renderer.xr.isPresenting ? 'Lean left or right past the barriers!' : 'A / D to lean past the barriers!', 5);
    });
  }

  private ride(dt: number): void {
    const c = chute();
    this.elapsed += dt;
    chuteSample(this.s, this.sample);
    // Steeper is faster; ease in at the start, brake onto the deck.
    const launch = Math.min(1, this.elapsed / LAUNCH_TIME);
    const target = chuteSpeed(this.sample.slope) * launch * launch;
    this.speed += (target - this.speed) * Math.min(1, dt * (launch < 1 ? 8 : 1.6));
    const left = c.length - 0.6 - this.s;
    const cap = Math.sqrt(2 * BRAKE * Math.max(0, left)) + 0.4;
    if (this.speed > cap) {
      this.speed = cap;
      this.mode = 'braking';
    }
    game.airspeed = this.speed;
    this.prevS = this.s;
    this.s = Math.min(c.length - 0.6, this.s + this.speed * dt);
    this.place();

    this.rumbleTimer -= dt;
    if (this.rumbleTimer <= 0) {
      this.rumbleTimer = 0.11;
      audio.slideRumble(Math.min(this.speed, 14) * 0.6);
    }
    if (this.checkBarriers()) return;
    if (this.s >= c.length - 0.61) this.arrive();
  }

  /** True if the rider clipped a barrier this frame (back to the last arch). */
  private checkBarriers(): boolean {
    const c = chute();
    getHeadWorld(this.world, this.head);
    chuteSample(this.s, this.sample);
    const lateral = (this.head.x - this.sample.x) * c.rightX + (this.head.z - this.sample.z) * c.rightZ;
    for (const bar of c.barriers) {
      if (bar.s <= this.prevS || bar.s > this.s) continue;
      if (Math.abs(lateral - LANE_X[bar.lane]) > HIT_HALF_WIDTH) continue;
      this.mode = 'crashed';
      this.speed = 0;
      game.airspeed = 0;
      audio.impact(1);
      audio.thud();
      sceneRefs.puffs?.emit(this.head.clone(), 22, 1.6);
      const what = bar.kind === 'ice' ? 'an ice block' : bar.kind === 'rock' ? 'a rock' : 'a slalom board';
      let checkpoint = 0;
      for (let i = 0; i < c.checkpoints.length; i++) if (c.checkpoints[i] <= this.s) checkpoint = i;
      toast(`Clipped ${what}! Back to the last arch.`, 3);
      fadeThen(() => {
        if (game.phase.peek() === Phase.Sliding) this.begin(checkpoint);
      });
      return true;
    }
    return false;
  }

  private arrive(): void {
    this.mode = 'arrived';
    this.speed = 0;
    game.airspeed = 0;
    if (chuteState.riding.peek()) chuteState.riding.value = false;
    audio.impact(0.6);
    getHeadWorld(this.world, this.head);
    sceneRefs.puffs?.emit(this.head.clone().setY(this.player.position.y), 16, 1.3);
    chuteState.arrived.value = true;
    toast('Down! Unpack the glider and launch off the deck.', 6);
  }
}
