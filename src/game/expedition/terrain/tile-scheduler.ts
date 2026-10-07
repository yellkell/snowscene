/**
 * Near-terrain streaming logic: which tiles each LOD level wants, build
 * requests (nearest and in view first), GPU slot allocation with an LRU
 * cache, rate-limited uploads, atomic block switches and slot
 * defragmentation. Pure TS: GPU work goes through `TileSink`, builds through
 * `TileBackend`, so the node check can drive it with fakes.
 *
 * A level only switches to a new 3x3 block once all nine of its tiles are on
 * the GPU; until then the previous block stays up. Because finer levels
 * punch holes in coarser ones (see terrain-config.ts), any mix of shown
 * blocks is gap- and overlap-free, so levels switch independently.
 *
 * Nothing here allocates per frame in the steady state: records, slot
 * tables and payload buffers are pooled; maps only grow when a tile is first
 * requested.
 */

import {
  FEATURE_LEVEL,
  FEATURE_TILES,
  FIRST_REGULAR_LEVEL,
  LEVEL_COUNT,
  LEVELS,
  RECENTRE_HYSTERESIS,
  SLOTS_PER_LEVEL,
  tilePayloadBytes,
} from './terrain-config.js';

/** GPU side of one level (implemented by TileBatch). */
export interface TileSink {
  /** Copy a payload into a slot and place it at an origin; returns a write version. */
  write(slot: number, originX: number, originZ: number, payload: ArrayBuffer): number;
  /** Duplicate one slot into another (for defragmentation); returns a write version. */
  copy(from: number, to: number): number;
  /** Highest write version known to be on the GPU. */
  uploadedVersion(): number;
  setShown(slot: number, shown: boolean): void;
  /** Draw only slots [0, count). */
  setDrawSlots(count: number): void;
  /** Rectangles (minX, minZ, maxX, maxZ) of levels finer than this one; empty = NaN. */
  setHoles(rects: Float64Array): void;
}

/** Tile builder (worker or synchronous fallback). */
export interface TileBackend {
  request(id: number, level: number, x: number, z: number, buf: ArrayBuffer): void;
}

const REQUESTED = 1;
const ARRIVED = 2;
const RESIDENT = 3;

interface Rec {
  id: number;
  level: number;
  ix: number;
  iz: number;
  key: number;
  x: number;
  z: number;
  state: number;
  slot: number;
  /** Defrag target slot, or -1. */
  moveTo: number;
  moveVersion: number;
  version: number;
  buf: ArrayBuffer | null;
  shown: boolean;
  lastUsed: number;
  /** Index in LevelState.list. */
  li: number;
}

const tileKey = (ix: number, iz: number) => (ix + 32768) * 65536 + (iz + 32768);

class LevelState {
  readonly tile: number;
  /** Desired block centre (tile indices). */
  cx = NaN;
  cz = NaN;
  /** Anticipated block centre (where the player is heading). */
  ax = NaN;
  az = NaN;
  /** Shown block centre (NaN until the first block is up). */
  sx = NaN;
  sz = NaN;
  readonly recs = new Map<number, Rec>();
  /** The same records as an array, for allocation-free iteration. */
  readonly list: Rec[] = [];
  readonly slots: Array<Rec | null> = new Array(SLOTS_PER_LEVEL).fill(null);
  readonly pool: ArrayBuffer[] = [];
  readonly bytes: number;
  drawSlots = 0;

  constructor(
    readonly index: number,
    readonly sink: TileSink,
  ) {
    this.tile = LEVELS[index].tile;
    this.bytes = tilePayloadBytes(LEVELS[index]);
  }
}

export interface SchedulerStats {
  requested: number;
  built: number;
  uploaded: number;
  switches: number;
  moves: number;
  dropped: number;
  buildMs: number;
  maxBuildMs: number;
}

export class TileScheduler {
  readonly levels: LevelState[];
  /** Rectangles of the shown blocks per level (minX, minZ, maxX, maxZ); NaN if none. */
  readonly rects = new Float64Array(LEVEL_COUNT * 4).fill(NaN);
  /** Called whenever `rects` changes (the far mesh sink follows it). */
  onRectsChanged: (rects: Float64Array) => void = () => {};
  /** Max builds in flight (keeps priorities fresh). */
  maxInFlight = 2;
  /** When the meshes aren't rendered (hidden root), count writes as uploaded. */
  assumeUploaded = false;
  readonly stats: SchedulerStats = {
    requested: 0,
    built: 0,
    uploaded: 0,
    switches: 0,
    moves: 0,
    dropped: 0,
    buildMs: 0,
    maxBuildMs: 0,
  };

  private readonly byId = new Map<number, Rec>();
  private readonly free: Rec[] = [];
  private readonly holes = new Float64Array(LEVEL_COUNT * 4);
  private inFlight = 0;
  private nextId = 1;
  private frame = 0;
  private fx = 0;
  private fz = 0;
  private vx = 0;
  private vz = -1;
  private focused = false;

  constructor(
    sinks: TileSink[],
    private readonly backend: TileBackend,
  ) {
    this.levels = sinks.map((sink, i) => new LevelState(i, sink));
  }

  get pending(): number {
    return this.inFlight;
  }

  /**
   * Per frame: `focus` is where detail is centred, `view` the horizontal
   * view direction (unit), `ahead` the anticipated focus a few seconds out.
   * `uploads` caps how many tiles may be copied to the GPU this frame.
   */
  update(fx: number, fz: number, vx: number, vz: number, aheadX: number, aheadZ: number, uploads: number): void {
    this.frame++;
    this.fx = fx;
    this.fz = fz;
    this.vx = vx;
    this.vz = vz;
    this.focused = true;
    for (let L = FIRST_REGULAR_LEVEL; L < LEVEL_COUNT; L++) {
      const lv = this.levels[L];
      const T = lv.tile;
      const h = RECENTRE_HYSTERESIS;
      if (!(fx >= (lv.cx - h) * T && fx < (lv.cx + 1 + h) * T)) lv.cx = Math.floor(fx / T);
      if (!(fz >= (lv.cz - h) * T && fz < (lv.cz + 1 + h) * T)) lv.cz = Math.floor(fz / T);
      lv.ax = Math.floor(aheadX / T);
      lv.az = Math.floor(aheadZ / T);
    }
    this.pump();
    let budget = uploads;
    budget -= this.uploadArrived(budget);
    for (let L = FIRST_REGULAR_LEVEL; L < LEVEL_COUNT; L++) this.trySwitch(this.levels[L]);
    this.updateFeatures();
    for (let L = 0; L < LEVEL_COUNT; L++) {
      const lv = this.levels[L];
      this.finishMoves(lv);
      if (budget > 0 && this.defrag(lv)) budget--;
    }
  }

  /** A build finished (worker message or fallback). */
  onBuilt(id: number, buf: ArrayBuffer, ms: number): void {
    this.inFlight--;
    this.stats.built++;
    this.stats.buildMs += ms;
    this.stats.maxBuildMs = Math.max(this.stats.maxBuildMs, ms);
    const rec = this.byId.get(id);
    this.byId.delete(id);
    if (!rec) return;
    const lv = this.levels[rec.level];
    if (!this.isWanted(lv, rec)) {
      lv.pool.push(buf);
      this.release(lv, rec);
      this.stats.dropped++;
    } else {
      rec.buf = buf;
      rec.state = ARRIVED;
    }
    if (this.focused) this.pump();
  }

  /**
   * True when every level shows the block wanted for the current focus,
   * the shown blocks contain (x, z) with a margin, and nearby feature tiles
   * are up. Call with the focus already at (x, z).
   */
  isReady(x: number, z: number, radius: number): boolean {
    if (!this.focused) return false;
    for (let L = FIRST_REGULAR_LEVEL; L < LEVEL_COUNT; L++) {
      const lv = this.levels[L];
      if (lv.sx !== lv.cx || lv.sz !== lv.cz) return false;
      const margin = Math.min(radius, 0.8 * lv.tile);
      const o = L * 4;
      const r = this.rects;
      if (x - margin < r[o] || z - margin < r[o + 1] || x + margin > r[o + 2] || z + margin > r[o + 3]) return false;
    }
    // Draw ranges compacted (no hidden slots drawn), so the first frames
    // after a respawn don't carry twice the vertex load.
    for (let L = 0; L < LEVEL_COUNT; L++) if (this.levels[L].drawSlots !== this.shownCount(L)) return false;
    const fl = this.levels[FEATURE_LEVEL];
    for (let i = 0; i < FEATURE_TILES.length; i++) {
      const f = FEATURE_TILES[i];
      const size = fl.tile;
      if (Math.hypot(f.x + size / 2 - x, f.z + size / 2 - z) < f.showRadius && this.featureFits(i)) {
        const rec = fl.recs.get(tileKey(i, 0));
        if (!rec || !rec.shown) return false;
      }
    }
    return true;
  }

  /** Triangles drawn by the near tiles right now. */
  drawnTriangles(): number {
    let n = 0;
    for (let L = 0; L < LEVEL_COUNT; L++) {
      const lv = this.levels[L];
      const q = LEVELS[L].quads;
      n += lv.drawSlots * (2 * q * q + 8 * q);
    }
    return n;
  }

  /** Shown tile count per level (debug / checks). */
  shownCount(level: number): number {
    const lv = this.levels[level];
    let n = 0;
    for (let s = 0; s < SLOTS_PER_LEVEL; s++) {
      const rec = lv.slots[s];
      if (rec && rec.shown && rec.slot === s) n++;
    }
    return n;
  }

  // ----------------------------------------------------------- requests --

  private isDesired(lv: LevelState, rec: Rec): boolean {
    if (lv.index === FEATURE_LEVEL) {
      const f = FEATURE_TILES[rec.ix];
      return Math.hypot(f.x + lv.tile / 2 - this.fx, f.z + lv.tile / 2 - this.fz) < f.loadRadius;
    }
    return Math.abs(rec.ix - lv.cx) <= 1 && Math.abs(rec.iz - lv.cz) <= 1;
  }

  private isWanted(lv: LevelState, rec: Rec): boolean {
    if (rec.shown || this.isDesired(lv, rec)) return true;
    return lv.index !== FEATURE_LEVEL && Math.abs(rec.ix - lv.ax) <= 1 && Math.abs(rec.iz - lv.az) <= 1;
  }

  /** Slots a level could still fill without evicting anything shown or desired. */
  private spare(lv: LevelState): number {
    let busy = 0;
    for (let i = 0; i < lv.list.length; i++) {
      const rec = lv.list[i];
      if (rec.shown || rec.state !== RESIDENT || this.isDesired(lv, rec)) busy++;
    }
    return SLOTS_PER_LEVEL - busy;
  }

  private bestL = -1;
  private bestX = 0;
  private bestZ = 0;
  private bestScore = Infinity;

  private consider(L: number, ix: number, iz: number, score: number): void {
    if (score >= this.bestScore) return;
    if (this.levels[L].recs.has(tileKey(ix, iz))) return;
    this.bestScore = score;
    this.bestL = L;
    this.bestX = ix;
    this.bestZ = iz;
  }

  /** Score a tile: finer levels first, then the centre tile, then tiles in view. */
  private scoreTile(order: number, L: number, ix: number, iz: number, ring: number): number {
    const T = this.levels[L].tile;
    const dx = (ix + 0.5) * T - this.fx;
    const dz = (iz + 0.5) * T - this.fz;
    const len = Math.hypot(dx, dz) || 1;
    const facing = 0.5 * (1 - (dx * this.vx + dz * this.vz) / len);
    return order * 4 + ring + facing;
  }

  /** Send the most urgent missing tiles to the builder. */
  pump(): void {
    while (this.inFlight < this.maxInFlight) {
      this.bestScore = Infinity;
      this.bestL = -1;
      // Feature tiles rank just after L0.
      const fl = this.levels[FEATURE_LEVEL];
      for (let i = 0; i < FEATURE_TILES.length; i++) {
        const f = FEATURE_TILES[i];
        if (Math.hypot(f.x + fl.tile / 2 - this.fx, f.z + fl.tile / 2 - this.fz) < f.loadRadius) {
          this.consider(FEATURE_LEVEL, i, 0, 4);
        }
      }
      for (let L = FIRST_REGULAR_LEVEL; L < LEVEL_COUNT; L++) {
        const lv = this.levels[L];
        const order = L === FIRST_REGULAR_LEVEL ? 0 : L;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const ix = lv.cx + dx;
            const iz = lv.cz + dz;
            this.consider(L, ix, iz, this.scoreTile(order, L, ix, iz, Math.max(Math.abs(dx), Math.abs(dz))));
          }
        }
      }
      // Nothing current is missing: prefetch where the player is heading.
      if (this.bestL < 0) {
        for (let L = FIRST_REGULAR_LEVEL; L < LEVEL_COUNT; L++) {
          const lv = this.levels[L];
          if (lv.ax === lv.cx && lv.az === lv.cz) continue;
          if (this.spare(lv) <= 0) continue;
          for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
              const ix = lv.ax + dx;
              const iz = lv.az + dz;
              this.consider(L, ix, iz, 100 + this.scoreTile(L, L, ix, iz, 0));
            }
          }
        }
      }
      if (this.bestL < 0) return;
      this.send(this.bestL, this.bestX, this.bestZ);
    }
  }

  private send(L: number, ix: number, iz: number): void {
    const lv = this.levels[L];
    const rec = this.free.pop() ?? ({} as Rec);
    rec.id = this.nextId++;
    rec.level = L;
    rec.ix = ix;
    rec.iz = iz;
    rec.key = tileKey(ix, iz);
    if (L === FEATURE_LEVEL) {
      rec.x = FEATURE_TILES[ix].x;
      rec.z = FEATURE_TILES[ix].z;
    } else {
      rec.x = ix * lv.tile;
      rec.z = iz * lv.tile;
    }
    rec.state = REQUESTED;
    rec.slot = -1;
    rec.moveTo = -1;
    rec.moveVersion = 0;
    rec.version = 0;
    rec.buf = null;
    rec.shown = false;
    rec.lastUsed = this.frame;
    lv.recs.set(rec.key, rec);
    rec.li = lv.list.length;
    lv.list.push(rec);
    this.byId.set(rec.id, rec);
    const buf = lv.pool.pop() ?? new ArrayBuffer(lv.bytes);
    this.inFlight++;
    this.stats.requested++;
    this.backend.request(rec.id, L, rec.x, rec.z, buf);
  }

  private release(lv: LevelState, rec: Rec): void {
    lv.recs.delete(rec.key);
    const last = lv.list.pop() as Rec;
    if (last !== rec) {
      lv.list[rec.li] = last;
      last.li = rec.li;
    }
    if (rec.slot >= 0 && lv.slots[rec.slot] === rec) lv.slots[rec.slot] = null;
    if (rec.moveTo >= 0 && lv.slots[rec.moveTo] === rec) lv.slots[rec.moveTo] = null;
    rec.slot = -1;
    rec.moveTo = -1;
    rec.buf = null;
    this.free.push(rec);
  }

  // ------------------------------------------------------------ uploads --

  private uploaded(lv: LevelState, version: number): boolean {
    return this.assumeUploaded || lv.sink.uploadedVersion() >= version;
  }

  /**
   * A slot that may be (re)written: free, or a cached tile nobody needs (LRU).
   * Tiles about to be shown take the lowest free slot; prefetched ones the
   * highest, so the draw range (0 .. highest shown slot) stays tight.
   */
  private takeSlot(lv: LevelState, below = SLOTS_PER_LEVEL, high = false): number {
    if (high) {
      for (let s = below - 1; s >= 0; s--) if (!lv.slots[s]) return s;
    }
    let victim = -1;
    let oldest = Infinity;
    for (let s = 0; s < below; s++) {
      const rec = lv.slots[s];
      if (!rec) return s;
      if (rec.shown || rec.slot !== s || rec.moveTo >= 0 || this.isWanted(lv, rec)) continue;
      if (rec.lastUsed < oldest) {
        oldest = rec.lastUsed;
        victim = s;
      }
    }
    if (victim >= 0) this.release(lv, lv.slots[victim] as Rec);
    return victim;
  }

  private uploadArrived(budget: number): number {
    let used = 0;
    // Finest levels first; within a level, desired before anticipated.
    for (let pass = 0; pass < 2 && used < budget; pass++) {
      for (let L = 0; L < LEVEL_COUNT && used < budget; L++) {
        const lv = this.levels[L];
        for (let i = lv.list.length - 1; i >= 0 && used < budget; i--) {
          const rec = lv.list[i];
          if (rec.state !== ARRIVED) continue;
          if (pass === 0 && !this.isDesired(lv, rec)) continue;
          if (!this.isWanted(lv, rec)) {
            lv.pool.push(rec.buf as ArrayBuffer);
            this.release(lv, rec);
            this.stats.dropped++;
            continue;
          }
          const slot = this.takeSlot(lv, SLOTS_PER_LEVEL, pass === 1);
          if (slot < 0) continue;
          rec.version = lv.sink.write(slot, rec.x, rec.z, rec.buf as ArrayBuffer);
          lv.pool.push(rec.buf as ArrayBuffer);
          rec.buf = null;
          rec.slot = slot;
          rec.state = RESIDENT;
          rec.lastUsed = this.frame;
          lv.slots[slot] = rec;
          used++;
          this.stats.uploaded++;
        }
      }
    }
    return used;
  }

  // ----------------------------------------------------------- switches --

  private trySwitch(lv: LevelState): void {
    if (lv.sx === lv.cx && lv.sz === lv.cz) return;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const rec = lv.recs.get(tileKey(lv.cx + dx, lv.cz + dz));
        if (!rec || rec.state !== RESIDENT || !this.uploaded(lv, rec.version)) return;
      }
    }
    // Hide what leaves, show what enters: one frame, no gap.
    for (let i = 0; i < lv.list.length; i++) {
      const rec = lv.list[i];
      if (!rec.shown) continue;
      if (Math.abs(rec.ix - lv.cx) <= 1 && Math.abs(rec.iz - lv.cz) <= 1) continue;
      this.hide(lv, rec);
    }
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const rec = lv.recs.get(tileKey(lv.cx + dx, lv.cz + dz)) as Rec;
        rec.lastUsed = this.frame;
        if (!rec.shown) {
          rec.shown = true;
          lv.sink.setShown(rec.slot, true);
        }
      }
    }
    lv.sx = lv.cx;
    lv.sz = lv.cz;
    const T = lv.tile;
    this.setRect(lv.index, (lv.cx - 1) * T, (lv.cz - 1) * T, (lv.cx + 2) * T, (lv.cz + 2) * T);
    this.updateDrawSlots(lv);
    this.stats.switches++;
  }

  private hide(lv: LevelState, rec: Rec): void {
    rec.shown = false;
    rec.lastUsed = this.frame;
    lv.sink.setShown(rec.slot, false);
    if (rec.moveTo >= 0) {
      if (lv.slots[rec.moveTo] === rec) lv.slots[rec.moveTo] = null;
      rec.moveTo = -1;
    }
  }

  private featureFits(i: number): boolean {
    const f = FEATURE_TILES[i];
    const size = this.levels[FEATURE_LEVEL].tile;
    const o = FIRST_REGULAR_LEVEL * 4;
    const r = this.rects;
    return f.x >= r[o] && f.z >= r[o + 1] && f.x + size <= r[o + 2] && f.z + size <= r[o + 3];
  }

  private updateFeatures(): void {
    const fl = this.levels[FEATURE_LEVEL];
    let shownIndex = -1;
    for (let i = 0; i < FEATURE_TILES.length; i++) {
      const rec = fl.recs.get(tileKey(i, 0));
      if (!rec) continue;
      const f = FEATURE_TILES[i];
      const near = Math.hypot(f.x + fl.tile / 2 - this.fx, f.z + fl.tile / 2 - this.fz) < f.showRadius;
      // Only one feature can hold the feature rectangle at a time.
      const want =
        shownIndex < 0 &&
        near &&
        rec.state === RESIDENT &&
        this.uploaded(fl, rec.version) &&
        this.featureFits(i);
      if (want) {
        shownIndex = i;
        rec.lastUsed = this.frame;
        if (!rec.shown) {
          rec.shown = true;
          fl.sink.setShown(rec.slot, true);
          this.updateDrawSlots(fl);
        }
      } else if (rec.shown) {
        this.hide(fl, rec);
        this.updateDrawSlots(fl);
      }
    }
    const o = FEATURE_LEVEL * 4;
    if (shownIndex >= 0) {
      const f = FEATURE_TILES[shownIndex];
      if (this.rects[o] !== f.x || this.rects[o + 1] !== f.z) this.setRect(FEATURE_LEVEL, f.x, f.z, f.x + fl.tile, f.z + fl.tile);
    } else if (!Number.isNaN(this.rects[o])) {
      this.setRect(FEATURE_LEVEL, NaN, NaN, NaN, NaN);
    }
  }

  private setRect(L: number, x0: number, z0: number, x1: number, z1: number): void {
    const o = L * 4;
    this.rects[o] = x0;
    this.rects[o + 1] = z0;
    this.rects[o + 2] = x1;
    this.rects[o + 3] = z1;
    // Each level's holes are the rectangles of every finer level.
    for (let k = 0; k < LEVEL_COUNT; k++) {
      this.holes.fill(NaN);
      for (let j = 0; j < k * 4; j++) this.holes[j] = this.rects[j];
      this.levels[k].sink.setHoles(this.holes);
    }
    this.onRectsChanged(this.rects);
  }

  private updateDrawSlots(lv: LevelState): void {
    let n = 0;
    for (let s = 0; s < SLOTS_PER_LEVEL; s++) {
      const rec = lv.slots[s];
      if (rec && rec.shown && rec.slot === s) n = s + 1;
    }
    if (n !== lv.drawSlots) {
      lv.drawSlots = n;
      lv.sink.setDrawSlots(n);
    }
  }

  // ------------------------------------------------------------- defrag --

  /** Move the highest shown tile into a lower free slot so the draw range stays tight. */
  private defrag(lv: LevelState): boolean {
    let hi = -1;
    for (let s = SLOTS_PER_LEVEL - 1; s >= 0; s--) {
      const rec = lv.slots[s];
      if (rec && rec.shown && rec.slot === s) {
        hi = s;
        break;
      }
    }
    if (hi < 0) return false;
    const rec = lv.slots[hi] as Rec;
    if (rec.moveTo >= 0) return false;
    let shown = 0;
    for (let s = 0; s < SLOTS_PER_LEVEL; s++) {
      const r = lv.slots[s];
      if (r && r.shown && r.slot === s) shown++;
    }
    // Already compact enough when every slot below the top one is shown.
    if (hi < shown) return false;
    const lo = this.takeSlot(lv, hi);
    if (lo < 0) return false;
    rec.moveVersion = lv.sink.copy(hi, lo);
    rec.moveTo = lo;
    lv.slots[lo] = rec;
    this.stats.moves++;
    return true;
  }

  private finishMoves(lv: LevelState): void {
    for (let s = 0; s < SLOTS_PER_LEVEL; s++) {
      const rec = lv.slots[s];
      if (!rec || rec.slot !== s || rec.moveTo < 0) continue;
      if (!this.uploaded(lv, rec.moveVersion)) continue;
      const to = rec.moveTo;
      rec.moveTo = -1;
      if (rec.shown) {
        lv.sink.setShown(to, true);
        lv.sink.setShown(s, false);
      }
      lv.slots[s] = null;
      rec.slot = to;
      this.updateDrawSlots(lv);
    }
  }
}
