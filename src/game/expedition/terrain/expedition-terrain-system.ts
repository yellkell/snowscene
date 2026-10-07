/**
 * Expedition terrain: streams near LOD tiles around the player (built in a
 * worker), shows the static far mesh of the whole mountain and the backdrop
 * ranges in the far depth layer, and answers `expHooks.terrainReady`.
 *
 * Draw calls: one per LOD level (5) + far mesh + backdrop = 7.
 * Triangles (steady state): ~222 k near (+9 k by the crevasse), ~52 k far,
 * ~33 k backdrop.
 *
 * Runs only while `exp.active` is true, or while the director is waiting on
 * `terrainReady` (prefetch: tiles are built around the requested point even
 * before the expedition starts).
 */

import { createSystem, type Entity, Group, type Mesh, type Object3D, Vector3 } from '@iwsdk/core';
import { getHeadWorld, getHeadYaw } from '../../rig.js';
import { exp, expHooks, expRefs } from '../exp-state.js';
import type { MeshData } from './far-builder.js';
import { TerrainBackend } from './terrain-backend.js';
import { LEVELS } from './terrain-config.js';
import { buildBackdropObject, buildFarMeshObject, setFarRects, terrainUniforms, TileBatch } from './terrain-meshes.js';
import { TileScheduler } from './tile-scheduler.js';

/** Tile uploads per frame while the terrain is on screen. */
const UPLOADS_PER_FRAME = 2;
/** While hidden (nothing reaches the GPU yet) CPU copies are all that's spent. */
const UPLOADS_PER_FRAME_HIDDEN = 6;
/** How long a terrainReady call keeps the focus on its point once the expedition runs (ms). */
const PREFETCH_HOLD_MS = 1500;
/** Anticipation: request tiles where the player will be this many seconds ahead. */
const LOOKAHEAD_S = 4;
const LOOKAHEAD_MAX = 300;

export interface TerrainStats {
  drawCalls: number;
  triangles: number;
  tilesBuilt: number;
  avgBuildMs: number;
  maxBuildMs: number;
  inFlight: number;
  worker: boolean;
}

/** Live numbers for profiling overlays / dev checks. */
export const expTerrainStats: TerrainStats = {
  drawCalls: 0,
  triangles: 0,
  tilesBuilt: 0,
  avgBuildMs: 0,
  maxBuildMs: 0,
  inFlight: 0,
  worker: false,
};

export class ExpeditionTerrainSystem extends createSystem({}) {
  private backend!: TerrainBackend;
  private scheduler!: TileScheduler;
  private batches: TileBatch[] = [];
  private group: Group | null = null;
  private groupEntity: Entity | null = null;
  private farData: MeshData | null = null;
  private backdropData: MeshData | null = null;
  private farMesh: Mesh | null = null;
  private backdropMesh: Mesh | null = null;
  /** Meshes waiting to join the scene: one per frame, so first uploads spread out. */
  private readonly pendingAttach: Mesh[] = [];
  private framesSinceAttach = 0;

  private readonly head = new Vector3();
  private readonly local = new Vector3();
  private hasPrefetch = false;
  private prefetchX = 0;
  private prefetchZ = 0;
  private prefetchAt = -Infinity;
  private lastFX = NaN;
  private lastFZ = NaN;
  private velX = 0;
  private velZ = 0;
  private focusX = NaN;
  private focusZ = NaN;

  init(): void {
    this.batches = LEVELS.map((spec) => new TileBatch(spec, `ExpTerrain${spec.name}`));
    this.backend = new TerrainBackend();
    this.scheduler = new TileScheduler(this.batches, this.backend);
    this.scheduler.onRectsChanged = setFarRects;
    this.backend.onTile = (id, buf, ms) => this.scheduler.onBuilt(id, buf, ms);
    this.backend.onMesh = (kind, data) => {
      if (kind === 'far') this.farData = data;
      else this.backdropData = data;
      this.attachFarMeshes();
    };
    // The far geometry builds in the background while the tutorial plays.
    this.backend.requestMesh('far');
    this.backend.requestMesh('backdrop');
    expHooks.terrainReady = (x, z, radius) => this.terrainReady(x, z, radius);
    this.attach();
  }

  update(delta: number): void {
    this.backend.tick();
    this.attach();
    const next = this.pendingAttach.shift();
    if (next && this.groupEntity) {
      this.world.createTransformEntity(next, { parent: this.groupEntity, persistent: true });
      this.framesSinceAttach = 0;
    } else {
      this.framesSinceAttach++;
    }
    const active = exp.active.peek();
    const now = performance.now();
    const prefetching = this.hasPrefetch && (!active || now - this.prefetchAt < PREFETCH_HOLD_MS);
    if (!active && !prefetching) return;

    // Focus: the requested point while prefetching, else the head (root-local).
    let fx: number;
    let fz: number;
    if (prefetching) {
      this.toLocal(this.local.set(this.prefetchX, 0, this.prefetchZ));
      fx = this.local.x;
      fz = this.local.z;
    } else {
      getHeadWorld(this.world, this.head);
      this.toLocal(this.local.copy(this.head));
      fx = this.local.x;
      fz = this.local.z;
    }
    // Smoothed ground velocity for anticipation; teleports reset it.
    const dt = Math.max(delta, 1e-3);
    if (Number.isFinite(this.lastFX)) {
      const mx = fx - this.lastFX;
      const mz = fz - this.lastFZ;
      if (mx * mx + mz * mz > 60 * 60) {
        this.velX = 0;
        this.velZ = 0;
      } else {
        const k = Math.min(1, dt * 1.5);
        this.velX += (mx / dt - this.velX) * k;
        this.velZ += (mz / dt - this.velZ) * k;
      }
    }
    this.lastFX = fx;
    this.lastFZ = fz;
    let ax = this.velX * LOOKAHEAD_S;
    let az = this.velZ * LOOKAHEAD_S;
    const al = Math.hypot(ax, az);
    if (al > LOOKAHEAD_MAX) {
      ax *= LOOKAHEAD_MAX / al;
      az *= LOOKAHEAD_MAX / al;
    }
    const yaw = getHeadYaw(this.world);
    const visible = this.onScreen();
    this.scheduler.assumeUploaded = !visible;
    this.scheduler.update(
      fx,
      fz,
      -Math.sin(yaw),
      -Math.cos(yaw),
      fx + ax,
      fz + az,
      visible ? UPLOADS_PER_FRAME : UPLOADS_PER_FRAME_HIDDEN,
    );
    this.focusX = fx;
    this.focusZ = fz;

    const fog = this.world.scene.fog;
    if (fog) terrainUniforms.uExpMistColor.value.copy(fog.color);

    const st = this.scheduler.stats;
    let draws = (this.farMesh ? 1 : 0) + (this.backdropMesh ? 1 : 0);
    for (let i = 0; i < this.batches.length; i++) if (this.batches[i].mesh.geometry.drawRange.count > 0) draws++;
    expTerrainStats.drawCalls = draws;
    expTerrainStats.triangles =
      this.scheduler.drawnTriangles() +
      (this.farMesh ? (this.farMesh.geometry.index?.count ?? 0) / 3 : 0) +
      (this.backdropMesh ? (this.backdropMesh.geometry.index?.count ?? 0) / 3 : 0);
    expTerrainStats.tilesBuilt = st.built;
    expTerrainStats.avgBuildMs = st.built ? st.buildMs / st.built : 0;
    expTerrainStats.maxBuildMs = st.maxBuildMs;
    expTerrainStats.inFlight = this.scheduler.pending;
    expTerrainStats.worker = this.backend.usingWorker;
  }

  /**
   * The director's hook: start building around (x, z) (world) and report
   * whether the terrain there is complete — every LOD block in place, on
   * the GPU when the expedition root is visible, and the far meshes built.
   */
  private terrainReady(x: number, z: number, radius: number): boolean {
    this.hasPrefetch = true;
    this.prefetchX = x;
    this.prefetchZ = z;
    this.prefetchAt = performance.now();
    // Everything built and in the scene for at least a frame (first upload done).
    if (!this.farMesh || !this.backdropMesh || this.pendingAttach.length > 0 || this.framesSinceAttach < 2) return false;
    this.toLocal(this.local.set(x, 0, z));
    // The scheduler must have run with this focus (it does on the next update).
    if (Math.abs(this.focusX - this.local.x) > 0.5 || Math.abs(this.focusZ - this.local.z) > 0.5) return false;
    return this.scheduler.isReady(this.local.x, this.local.z, radius);
  }

  private toLocal(v: Vector3): Vector3 {
    const root = expRefs.root?.object3D;
    if (root) {
      root.updateWorldMatrix(true, false);
      root.worldToLocal(v);
    }
    return v;
  }

  /** True when the terrain group is in the scene graph and visible all the way up. */
  private onScreen(): boolean {
    let o: Object3D | null = this.group;
    if (!o) return false;
    while (o) {
      if (!o.visible) return false;
      if (o === this.world.scene) return true;
      o = o.parent;
    }
    return false;
  }

  /** Parent everything under the expedition root as soon as it exists. */
  private attach(): void {
    if (this.group) return;
    const root = expRefs.root;
    if (!root) return;
    this.group = new Group();
    this.group.name = 'ExpeditionTerrain';
    this.groupEntity = this.world.createTransformEntity(this.group, { parent: root, persistent: true });
    for (const batch of this.batches) this.pendingAttach.push(batch.mesh);
    this.attachFarMeshes();
  }

  private attachFarMeshes(): void {
    if (!this.groupEntity) return;
    if (this.farData && !this.farMesh) {
      this.farMesh = buildFarMeshObject(this.farData);
      this.pendingAttach.push(this.farMesh);
    }
    if (this.backdropData && !this.backdropMesh) {
      this.backdropMesh = buildBackdropObject(this.backdropData);
      this.pendingAttach.push(this.backdropMesh);
    }
  }
}
