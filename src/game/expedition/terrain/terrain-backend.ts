/**
 * Runs terrain builds in the tile worker, or — if a worker can't be created
 * or dies — on the main thread at one tile per frame.
 */

import { buildBackdrop, buildFarMesh, type MeshData } from './far-builder.js';
import { LEVELS, tilePayloadBytes } from './terrain-config.js';
import { buildTile, payloadViews, tileScratchSize } from './tile-builder.js';
import type { TileBackend } from './tile-scheduler.js';
import type { WorkerRequest, WorkerResponse } from './worker-protocol.js';

type MeshKind = 'far' | 'backdrop';

interface PendingTile {
  id: number;
  level: number;
  x: number;
  z: number;
  buf: ArrayBuffer;
}

export class TerrainBackend implements TileBackend {
  /** Tile finished: (id, payload buffer, build ms). */
  onTile: (id: number, buf: ArrayBuffer, ms: number) => void = () => {};
  /** Far mesh or backdrop finished. */
  onMesh: (kind: MeshKind, data: MeshData, ms: number) => void = () => {};

  private worker: Worker | null = null;
  /** Requests sent to the worker and not yet answered (for failover). */
  private readonly inWorker = new Map<number, PendingTile>();
  private readonly meshesInWorker = new Set<MeshKind>();
  /** Main-thread fallback queue. */
  private readonly queue: PendingTile[] = [];
  private readonly meshQueue: MeshKind[] = [];
  private scratch: Float64Array | null = null;

  constructor() {
    try {
      this.worker = new Worker(new URL('./tile-worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.receive(e.data);
      this.worker.onerror = (e) => {
        console.warn('[terrain] worker failed, building on the main thread', e.message);
        this.failover();
      };
    } catch (err) {
      console.warn('[terrain] no worker, building on the main thread', err);
      this.worker = null;
    }
  }

  get usingWorker(): boolean {
    return this.worker !== null;
  }

  request(id: number, level: number, x: number, z: number, buf: ArrayBuffer): void {
    if (this.worker) {
      this.inWorker.set(id, { id, level, x, z, buf });
      const msg: WorkerRequest = { t: 'tile', id, level, x, z, buf };
      this.worker.postMessage(msg, [buf]);
    } else {
      this.queue.push({ id, level, x, z, buf });
    }
  }

  requestMesh(kind: MeshKind): void {
    if (this.worker) {
      this.meshesInWorker.add(kind);
      const msg: WorkerRequest = { t: kind };
      this.worker.postMessage(msg);
    } else {
      this.meshQueue.push(kind);
    }
  }

  /** Main-thread fallback: at most one build per frame. */
  tick(): void {
    if (this.worker) return;
    const kind = this.meshQueue.shift();
    if (kind) {
      const t0 = performance.now();
      const data = kind === 'far' ? buildFarMesh() : buildBackdrop();
      this.onMesh(kind, data, performance.now() - t0);
      return;
    }
    const job = this.queue.shift();
    if (!job) return;
    const spec = LEVELS[job.level];
    if (!this.scratch) this.scratch = new Float64Array(Math.max(...LEVELS.map(tileScratchSize)));
    const t0 = performance.now();
    buildTile(spec, job.x, job.z, payloadViews(spec, job.buf), this.scratch);
    this.onTile(job.id, job.buf, performance.now() - t0);
  }

  private receive(msg: WorkerResponse): void {
    if (msg.t === 'tile') {
      this.inWorker.delete(msg.id);
      this.onTile(msg.id, msg.buf, msg.ms);
    } else {
      this.meshesInWorker.delete(msg.t);
      this.onMesh(msg.t, { positions: msg.positions, normals: msg.normals, indices: msg.indices }, msg.ms);
    }
  }

  private failover(): void {
    this.worker?.terminate();
    this.worker = null;
    // Buffers sent to the dead worker are gone: rebuild into fresh ones.
    for (const job of this.inWorker.values()) {
      this.queue.push({ ...job, buf: new ArrayBuffer(tilePayloadBytes(LEVELS[job.level])) });
    }
    this.inWorker.clear();
    for (const kind of this.meshesInWorker) this.meshQueue.push(kind);
    this.meshesInWorker.clear();
  }
}
