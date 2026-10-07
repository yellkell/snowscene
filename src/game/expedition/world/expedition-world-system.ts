/**
 * ExpeditionWorldSystem: everything placed on the expedition mountain except
 * the terrain itself (camps and the Base Camp party, route dressing, river
 * and log bridge, forest, moraine boulders, glacier seracs and seams, the
 * crevasse walls, the ice wall and rock band faces with the rock band's
 * holds, the rock wall above the rope ledge, and the summit).
 *
 * Content is built lazily under `expRefs.root` the first frames the
 * expedition is active, nearest passes first, a few milliseconds per frame.
 * It lives in ~220 m chunks (one mesh per material each) that are shown
 * only near the player, with a high/low detail swap for trees and boulders.
 * The system does nothing while the expedition is inactive.
 *
 * Register after the director (which creates `expRefs.root`), e.g.
 * priority 24. `expRefs.root` must stay untransformed (world origin).
 */

import { createSystem, type Entity, type Group, type InstancedBufferAttribute, Vector3 } from '@iwsdk/core';
import { type Bonfire, fires } from '../../campfire.js';
import { ClimbHold } from '../../game-components.js';
import { HANDS } from '../../hand-input.js';
import { getHeadWorld } from '../../rig.js';
import { game, Phase } from '../../state.js';
import { project, type Projection } from '../exp-route.js';
import { exp, expFrame, expRefs } from '../exp-state.js';
import { ROCK_BAND } from '../exp-layout.js';
import { type Chunk, ChunkGrid, DETAIL_RADIUS, LARGE_RADIUS, LOD_RADIUS } from './chunks.js';
import { createCampFire } from './fires.js';
import { signMaterial, worldUniforms } from './materials.js';
import { SignAtlas } from './sign-atlas.js';
import { makePasses, type Pass } from './world-build.js';

/** Hysteresis on chunk visibility (m). */
const HYSTERESIS = 15;
/** Camp fires are drawn within this distance (Base Camp's from the whole glide after the summit). */
const FIRE_RANGE = 650;
const FINALE_FIRE_RANGE = 4200;
/** Build budget per frame (ms); the first active frame builds the player's surroundings. */
const FRAME_BUDGET_MS = 3;
const FIRST_FRAME_BUDGET_MS = 60;
const FADED_BUDGET_MS = 25;

// ------------------------------------------------- collapsing serac -----

let seracGroup: Group | null = null;
let seracWanted = true;
let seracNear = false;

function applySerac(): void {
  if (seracGroup) seracGroup.visible = seracWanted && seracNear;
}

/**
 * Show or hide the serac tower that collapses at SERAC.s (for the events
 * agent: `fxHooks.setSeracVisible = setCollapsingSeracVisible`).
 */
export function setCollapsingSeracVisible(visible: boolean): void {
  seracWanted = visible;
  applySerac();
}

/**
 * The collapsing tower's group (null until built): origin at the pivot
 * (downhill foot edge, see `seracTower()` in layout-nature.ts), local +Z =
 * fall direction. Rotate about local X to topple it.
 */
export function getCollapsingSerac(): Group | null {
  return seracGroup;
}

// ----------------------------------------------------------- system -----

interface FireEntry {
  fire: Bonfire;
  base: boolean;
  shown: boolean;
}

interface HoldState {
  glow: InstancedBufferAttribute;
  entities: Entity[];
  positions: Vector3[];
}

export class ExpeditionWorldSystem extends createSystem({}) {
  private grid: ChunkGrid | null = null;
  private atlas: SignAtlas | null = null;
  private root: Entity | null = null;
  private passes: Pass[] = [];
  private job: Generator<void, void, unknown> | null = null;
  private readonly chunks: Chunk[] = [];
  private readonly fireList: FireEntry[] = [];
  private holdState: HoldState | null = null;
  private readonly head = new Vector3();
  private readonly proj: Projection = { s: 0, d: 0, dist: 0, elev: 0 };
  private firstFrame = true;
  private hidden = true;
  private readonly rockBase = new Vector3(ROCK_BAND.baseX, ROCK_BAND.baseY, ROCK_BAND.baseZ);

  init(): void {
    this.cleanupFuncs.push(
      exp.active.subscribe((active) => {
        if (!active) this.hideAll();
      }),
    );
  }

  update(delta: number, time: number): void {
    if (!exp.active.peek()) return;
    const root = expRefs.root;
    if (!root) return;
    if (!this.grid) this.start(root);
    getHeadWorld(this.world, this.head);
    this.hidden = false;

    // Build faster while the screen is faded out (start, respawns).
    if (this.job) this.runJob(this.firstFrame ? FIRST_FRAME_BUDGET_MS : game.fade > 0.6 ? FADED_BUDGET_MS : FRAME_BUDGET_MS);
    this.firstFrame = false;

    const dt = Math.min(delta, 0.1);
    worldUniforms.uTime.value = time;
    const storm = Math.max(0, Math.min(1, expFrame.storm));
    worldUniforms.uWind.value += (0.22 + 0.78 * storm - worldUniforms.uWind.value) * Math.min(1, dt * 0.5);
    worldUniforms.uNight.value = 1 - Math.max(0, Math.min(1, expFrame.daylight));
    worldUniforms.uIceGlow.value = 0.3 + 0.7 * Math.max(0, Math.min(1, expFrame.daylight));

    this.updateVisibility();
    this.updateFires();
    this.updateHolds(dt, time);
  }

  // ---------------------------------------------------------- building --

  private start(root: Entity): void {
    this.root = root;
    this.atlas = new SignAtlas();
    const atlas = this.atlas;
    this.grid = new ChunkGrid(() => signMaterial(atlas.texture));
    this.passes = makePasses(this.grid, atlas, {
      fire: (x, y, z, scale, base) => this.addFire(x, y, z, scale, base),
      holds: (h, chunk) => {
        chunk.extras.push(h.mesh);
        const entities = h.proxies.map((proxy, i) =>
          this.world
            .createTransformEntity(proxy, { parent: root, persistent: true })
            .addComponent(ClimbHold, { lip: h.lips[i], glow: 0 }),
        );
        this.holdState = { glow: h.glow, entities, positions: h.proxies.map((p) => p.position.clone()) };
      },
      serac: (group) => {
        group.visible = false;
        seracGroup = group;
        this.world.createTransformEntity(group, { parent: root, persistent: true });
        applySerac();
      },
      chunkDone: (chunk) => {
        this.world.createTransformEntity(chunk.group, { parent: root, persistent: true });
        this.chunks.push(chunk);
        this.precompile(chunk);
      },
    });
    // Nearest content first, then the route dressing, then outward.
    const s = this.playerS();
    const routePass = this.passes.find((p) => p.name === 'route');
    const rest = this.passes.filter((p) => p !== routePass).sort((a, b) => Math.abs(a.s - s) - Math.abs(b.s - s));
    this.passes = routePass ? [rest[0], routePass, ...rest.slice(1)] : rest;
    this.job = this.buildAll();
  }

  private playerS(): number {
    getHeadWorld(this.world, this.head);
    project(this.head.x, this.head.z, this.proj);
    return this.proj.dist < Infinity ? this.proj.s : expFrame.s;
  }

  private *buildAll(): Generator<void, void, unknown> {
    for (const pass of this.passes) yield* pass.run();
  }

  private runJob(budgetMs: number): void {
    const start = performance.now();
    while (this.job && performance.now() - start < budgetMs) {
      if (this.job.next().done) this.job = null;
    }
  }

  /** Compile a new chunk's shaders in the background so it doesn't hitch when it appears. */
  private precompile(chunk: Chunk): void {
    this.world.renderer.compileAsync(chunk.group, this.world.camera, this.world.scene).catch(() => {});
  }

  private addFire(x: number, y: number, z: number, scale: number, base: boolean): void {
    const fire = createCampFire(x, y, z, scale);
    for (const object of fire.objects) this.world.createTransformEntity(object, { parent: this.root!, persistent: true });
    fire.setVisible(false);
    fires.push(fire);
    this.fireList.push({ fire, base, shown: false });
  }

  // -------------------------------------------------------- visibility --

  private updateVisibility(): void {
    const h = this.head;
    for (const c of this.chunks) {
      const d = h.distanceTo(c.centre) - c.radius;
      const range = c.layer === 'detail' ? DETAIL_RADIUS : LARGE_RADIUS;
      const show = c.visible ? d < range + HYSTERESIS : d < range;
      if (show !== c.visible) {
        c.visible = show;
        c.group.visible = show;
      }
      if (show && c.hasLod) {
        const dc = d + c.radius;
        const hi = c.lodHi ? dc < LOD_RADIUS + HYSTERESIS : dc < LOD_RADIUS;
        if (hi !== c.lodHi) {
          c.lodHi = hi;
          c.hi.visible = hi;
          c.lo.visible = !hi;
        }
      }
    }
    if (seracGroup) {
      const near = h.distanceTo(seracGroup.position) < LARGE_RADIUS;
      if (near !== seracNear) {
        seracNear = near;
        applySerac();
      }
    }
  }

  private updateFires(): void {
    const finale = exp.summited.peek();
    for (const f of this.fireList) {
      const range = f.base && finale ? FINALE_FIRE_RANGE : FIRE_RANGE;
      const show = this.head.distanceTo(f.fire.position) < range;
      if (show !== f.shown) {
        f.shown = show;
        f.fire.setVisible(show);
      }
    }
  }

  /** Holds glow like the tutorial's (pulse, nearby hands, just grabbed). */
  private updateHolds(dt: number, time: number): void {
    const hs = this.holdState;
    if (!hs) return;
    if (this.head.distanceTo(this.rockBase) > 60) return;
    const climbing = game.phase.peek() === Phase.Climbing;
    const arr = hs.glow.array as Float32Array;
    for (let i = 0; i < hs.entities.length; i++) {
      const e = hs.entities[i];
      let glow = e.getValue(ClimbHold, 'glow') ?? 0;
      if (glow > 0) {
        glow = Math.max(0, glow - dt * 1.5);
        e.setValue(ClimbHold, 'glow', glow);
      }
      const p = hs.positions[i];
      let near = 0;
      if (climbing) {
        for (const hand of HANDS) {
          if (!hand.tracked) continue;
          const d = p.distanceTo(hand.position);
          if (d < 0.35) near = Math.max(near, 1 - d / 0.35);
        }
      }
      const pulse = climbing ? 0.22 + 0.12 * Math.sin(time * 3 + p.y * 2) : 0.12;
      arr[i] = pulse + near * 0.7 + glow * 0.6;
    }
    hs.glow.needsUpdate = true;
  }

  private hideAll(): void {
    if (this.hidden) return;
    this.hidden = true;
    for (const c of this.chunks) {
      c.visible = false;
      c.group.visible = false;
    }
    for (const f of this.fireList) {
      f.shown = false;
      f.fire.setVisible(false);
    }
    seracNear = false;
    applySerac();
  }
}
