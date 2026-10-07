/**
 * The ride down: HELTER's slide on the Needle's log flume.
 *
 * The rig rides the spiral by arc length with an eased launch and a constant
 * speed, yawing to keep facing down the flume so "lean left / right" always
 * means your own left and right. Gantries hang hazards (boards, icicles,
 * ore buckets) in one or two of the three lanes: lean, or duck, into the
 * open lane. Clip one and you go back to the start of that run. The flume
 * stops dead at the holding bay halfway down, counts you out again, and
 * finally sets you down at the Needle's foot beside the glider workbench.
 *
 * Desktop: A / D (or the arrow keys) lean.
 */

import { createSystem, Vector3 } from '@iwsdk/core';
import { audio } from '../audio.js';
import { Bonfire, fires } from '../campfire.js';
import { faceYaw, getHeadWorld, placeHeadAt } from '../rig.js';
import { sceneRefs } from '../scene-system.js';
import { fadeThen, game, Phase, setPhase, SUMMIT_STAND, toast } from '../state.js';
import { SUMMIT_Y } from '../terrain.js';
import { BEACON_TOP, buildFlumeWorld } from './flume-build.js';
import {
  FlumePath,
  flumePath,
  type Hazard,
  LANE_X,
  layoutHazards,
  SLIDE_ACCEL_TIME,
  SLIDE_SPEED,
} from './flume-path.js';

/** Seconds of 3-2-1 before each run launches. */
const COUNT_IN = 3;
/** A hazard catches the head if it is this close to the hazard's lane centre... */
const HIT_HALF_WIDTH = 0.33;
/** ...and the head is higher than this above the bed (duck under to pass). */
const DUCK_HEIGHT = 1.0;
const LEAN = 0.55;

export class FlumeSystem extends createSystem({}) {
  private hazards: Hazard[] = layoutHazards();
  private beacon!: Bonfire;
  private tier = 0;
  private s = 0;
  private prevS = 0;
  private endS = 0;
  private speed = 0;
  private elapsed = 0;
  private sliding = false;
  private countIn = -1;
  private lastCount = -1;
  private finishTimer = -1;
  private rumbleTimer = 0;
  private lean = 0;
  private readonly calib = new Vector3();
  private readonly head = new Vector3();
  private readonly local = new Vector3();
  private readonly sample = FlumePath.makeSample();

  init(): void {
    const parent = sceneRefs.tutorialRoot ?? undefined;
    this.world.createTransformEntity(buildFlumeWorld(this.hazards), { parent, persistent: true });

    // The beacon fire on top of the Needle, seen from the lake once lit.
    this.beacon = new Bonfire(BEACON_TOP, { scale: 0.32, party: false, light: false });
    for (const object of this.beacon.objects) this.world.createTransformEntity(object, { parent, persistent: true });
    fires.push(this.beacon);
    this.beacon.setVisible(false);

    this.cleanupFuncs.push(
      game.beaconLit.subscribe((lit) => this.beacon.setVisible(lit)),
      game.phase.subscribe((phase) => {
        if (phase === Phase.Sliding) this.launchRide();
        else this.halt();
      }),
      game.resetCount.subscribe(() => this.halt()),
    );
  }

  private halt(): void {
    this.sliding = false;
    this.countIn = -1;
    this.finishTimer = -1;
    game.airspeed = 0;
  }

  /** Runs under the fade: stand on the beacon deck at the top of the flume. */
  private launchRide(): void {
    this.lean = 0;
    toast(this.world.renderer.xr.isPresenting ? 'Lean or duck to dodge the hazards!' : 'A / D to lean past the hazards.', 5);
    this.beginTier(0);
  }

  private beginTier(index: number): void {
    const tier = flumePath.tiers[index];
    this.tier = index;
    this.s = tier.s0;
    this.prevS = tier.s0;
    this.endS = tier.s1;
    this.speed = 0;
    this.sliding = false;
    this.countIn = COUNT_IN;
    this.lastCount = -1;
    // Centre whoever is riding on the flume's middle lane.
    this.calib.set(0, 0, 0);
    this.place();
    getHeadWorld(this.world, this.head);
    this.local.copy(this.head);
    this.player.worldToLocal(this.local);
    this.calib.set(this.local.x, 0, this.local.z);
    this.place();
  }

  /** Put the rig on the flume at the current arc length. */
  private place(): void {
    flumePath.sample(this.s, this.sample);
    const rig = this.player;
    const p = this.sample.position;
    const yaw = this.sample.yaw;
    const c = Math.cos(yaw);
    const sn = Math.sin(yaw);
    // Rotate the calibration offset into the world (yaw about +Y).
    const ox = this.calib.x * c + this.calib.z * sn;
    const oz = -this.calib.x * sn + this.calib.z * c;
    rig.rotation.set(0, yaw, 0);
    rig.position.set(p.x + this.sample.right.x * this.lean - ox, p.y, p.z + this.sample.right.z * this.lean - oz);
    rig.updateMatrixWorld(true);
  }

  update(delta: number): void {
    if (game.phase.peek() !== Phase.Sliding) return;
    const dt = Math.min(delta, 0.1);

    if (!this.world.renderer.xr.isPresenting) {
      const k = this.input.keyboard;
      const left = k.getKeyPressed('KeyA') || k.getKeyPressed('ArrowLeft');
      const right = k.getKeyPressed('KeyD') || k.getKeyPressed('ArrowRight');
      const target = left === right ? 0 : left ? -LEAN : LEAN;
      this.lean += (target - this.lean) * Math.min(1, dt * 10);
    } else this.lean = 0;

    if (this.finishTimer >= 0) {
      this.finishTimer += dt;
      if (this.finishTimer > 1.4) {
        this.finishTimer = -1;
        fadeThen(() => this.arrive());
      }
      return;
    }

    if (this.countIn >= 0) {
      this.countIn -= dt;
      const n = Math.ceil(this.countIn);
      if (n !== this.lastCount && n > 0) {
        this.lastCount = n;
        audio.tock(n);
      }
      if (this.countIn < 0) {
        this.sliding = true;
        this.elapsed = 0;
        audio.whoosh();
      }
      this.place();
      return;
    }
    if (!this.sliding) return;

    this.elapsed += dt;
    const launch = Math.min(1, this.elapsed / SLIDE_ACCEL_TIME);
    this.speed = SLIDE_SPEED * launch * launch;
    game.airspeed = this.speed;
    this.prevS = this.s;
    this.s = Math.min(this.endS, this.s + this.speed * dt);
    this.place();

    this.rumbleTimer -= dt;
    if (this.rumbleTimer <= 0) {
      this.rumbleTimer = 0.11;
      audio.slideRumble(this.speed);
    }

    if (this.checkHazards()) return;

    if (this.s >= this.endS - 1e-3) {
      // Hard stop on the bay, a puff of snow off the boards.
      this.sliding = false;
      this.speed = 0;
      game.airspeed = 0;
      audio.impact(0.6);
      getHeadWorld(this.world, this.head);
      sceneRefs.puffs?.emit(this.head.clone().setY(this.player.position.y), 14, 1.2);
      if (this.tier + 1 < flumePath.tiers.length) {
        toast('Halfway. Catch your breath...', 3);
        this.beginTier(this.tier + 1);
        this.countIn = COUNT_IN + 0.6;
      } else {
        this.finishTimer = 0;
        toast('Down! The glider kit is just round the Needle.', 3);
      }
    }
  }

  /** True if the rider clipped a hazard this frame (the run restarts). */
  private checkHazards(): boolean {
    getHeadWorld(this.world, this.head);
    const p = this.sample.position;
    const lateral = (this.head.x - p.x) * this.sample.right.x + (this.head.z - p.z) * this.sample.right.z;
    const height = this.head.y - p.y;
    for (const hz of this.hazards) {
      if (hz.s <= this.prevS || hz.s > this.s) continue;
      if (Math.abs(lateral - LANE_X[hz.lane]) > HIT_HALF_WIDTH || height < DUCK_HEIGHT) {
        audio.clack();
        continue;
      }
      this.sliding = false;
      game.airspeed = 0;
      audio.impact(1);
      audio.thud();
      sceneRefs.puffs?.emit(this.head.clone(), 20, 1.6);
      const what = hz.kind === 'board' ? 'a board' : hz.kind === 'icicles' ? 'the icicles' : 'an ore bucket';
      toast(`Clipped ${what}! Back to the top of this run.`, 3);
      fadeThen(() => this.beginTier(this.tier));
      return true;
    }
    return false;
  }

  /** Under the fade: stand at the workbench, facing the kit. */
  private arrive(): void {
    const rig = this.player;
    rig.rotation.set(0, 0, 0);
    rig.updateMatrixWorld(true);
    faceYaw(this.world, 0);
    placeHeadAt(this.world, SUMMIT_STAND.x, SUMMIT_STAND.z, SUMMIT_Y);
    game.velocity.set(0, 0, 0);
    setPhase(Phase.Building);
  }
}
