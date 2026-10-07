/**
 * Spatial chunks of world content. Everything placed on the mountain lands
 * in a chunk keyed by (section, layer, 220 m cell); each chunk merges its
 * content into one mesh per material (plus one InstancedMesh per instanced
 * geometry), and the world system shows or hides whole chunks by distance.
 *
 * Layers: 'detail' (props, flags, signs: hidden beyond DETAIL_RADIUS) and
 * 'large' (trees, boulders, seracs, faces, river: LARGE_RADIUS, with a
 * high/low detail swap at LOD_RADIUS).
 */

import { type BufferGeometry, Group, type Material, type Object3D, Vector3 } from '@iwsdk/core';
import { Batch, InstanceList } from './batch.js';
import {
  barkMaterial,
  clothMaterial,
  decalMaterial,
  faceRockMaterial,
  iceFacetMaterial,
  iceSmoothMaterial,
  propsMaterial,
  rockMaterial,
  seamMaterial,
  snowMaterial,
} from './materials.js';

/** Small props disappear beyond this distance (m, from the chunk's bounds). */
export const DETAIL_RADIUS = 300;
/** Trees, boulders, ice and faces disappear beyond this distance. */
export const LARGE_RADIUS = 620;
/** Large chunks show their high-detail meshes while the viewer is within this distance of the chunk's centre. */
export const LOD_RADIUS = 170;
export const CELL = 220;

export type Layer = 'detail' | 'large';

export type BatchKind =
  | 'props'
  | 'cloth'
  | 'bark'
  | 'rock'
  | 'decal'
  | 'sign'
  | 'ice'
  | 'iceFacet'
  | 'seam'
  | 'snow'
  | 'faceRock';

interface BatchSpec {
  fx: string | null;
  uv: boolean;
  shadows: boolean;
  material: () => Material;
}

const BATCH_SPECS: Record<Exclude<BatchKind, 'sign'>, BatchSpec> = {
  props: { fx: 'aFx', uv: false, shadows: true, material: propsMaterial },
  cloth: { fx: 'aFlap', uv: false, shadows: false, material: clothMaterial },
  bark: { fx: null, uv: true, shadows: true, material: barkMaterial },
  rock: { fx: null, uv: false, shadows: true, material: rockMaterial },
  decal: { fx: null, uv: false, shadows: false, material: decalMaterial },
  ice: { fx: null, uv: true, shadows: true, material: iceSmoothMaterial },
  iceFacet: { fx: null, uv: false, shadows: true, material: iceFacetMaterial },
  seam: { fx: null, uv: false, shadows: false, material: seamMaterial },
  snow: { fx: null, uv: false, shadows: true, material: snowMaterial },
  faceRock: { fx: null, uv: false, shadows: true, material: faceRockMaterial },
};

/** An instanced geometry slot: high and (optional) low detail versions. */
export interface InstanceSlot {
  list: InstanceList;
  hi: BufferGeometry;
  lo: BufferGeometry | null;
  material: Material;
  shadows: boolean;
  tinted: boolean;
}

export class Chunk {
  readonly group = new Group();
  /** High / low detail children of large chunks. */
  readonly hi = new Group();
  readonly lo = new Group();
  readonly batches = new Map<BatchKind, Batch>();
  readonly instances = new Map<string, InstanceSlot>();
  readonly extras: Object3D[] = [];
  origin: Vector3 | null = null;
  readonly min = new Vector3(Infinity, Infinity, Infinity);
  readonly max = new Vector3(-Infinity, -Infinity, -Infinity);
  readonly centre = new Vector3();
  radius = 0;
  built = false;
  visible = false;
  lodHi = true;
  hasLod = false;

  constructor(
    readonly key: string,
    readonly layer: Layer,
    private readonly signMaterial: () => Material,
  ) {
    this.group.name = `ExpWorld:${key}`;
    this.hi.name = 'hi';
    this.lo.name = 'lo';
    this.group.add(this.hi, this.lo);
    this.group.visible = false;
  }

  /** Grow the chunk's bounds to include a sphere. */
  extend(x: number, y: number, z: number, r = 0): void {
    if (!this.origin) this.origin = new Vector3(Math.round(x), Math.round(y), Math.round(z));
    this.min.set(Math.min(this.min.x, x - r), Math.min(this.min.y, y - r), Math.min(this.min.z, z - r));
    this.max.set(Math.max(this.max.x, x + r), Math.max(this.max.y, y + r), Math.max(this.max.z, z + r));
  }

  batch(kind: BatchKind): Batch {
    let b = this.batches.get(kind);
    if (!b) {
      b = kind === 'sign' ? new Batch(null, true) : new Batch(BATCH_SPECS[kind].fx, BATCH_SPECS[kind].uv);
      this.batches.set(kind, b);
    }
    return b;
  }

  inst(name: string, hi: BufferGeometry, lo: BufferGeometry | null, material: Material, shadows = true, tinted = true): InstanceList {
    let slot = this.instances.get(name);
    if (!slot) {
      slot = { list: new InstanceList(), hi, lo, material, shadows, tinted };
      this.instances.set(name, slot);
    }
    return slot.list;
  }

  /** Turn accumulated geometry into meshes (yields between meshes). */
  *finishSteps(): Generator<void, void, unknown> {
    if (this.built) return;
    this.built = true;
    const origin = this.origin ?? new Vector3();
    for (const [kind, b] of this.batches) {
      const material = kind === 'sign' ? this.signMaterial() : BATCH_SPECS[kind].material();
      const shadows = kind === 'sign' ? true : BATCH_SPECS[kind].shadows;
      const mesh = b.mesh(origin, material, `${this.key}:${kind}`, shadows);
      if (mesh) this.group.add(mesh);
      yield;
    }
    this.batches.clear();
    for (const [name, slot] of this.instances) {
      const hi = slot.list.mesh(origin, slot.hi, slot.material, `${this.key}:${name}`, slot.shadows, slot.tinted);
      if (!hi) continue;
      if (slot.lo) {
        const lo = slot.list.mesh(origin, slot.lo, slot.material, `${this.key}:${name}:lo`, slot.shadows, slot.tinted);
        this.hi.add(hi);
        if (lo) this.lo.add(lo);
        this.hasLod = true;
      } else this.group.add(hi);
      yield;
    }
    this.instances.clear();
    for (const extra of this.extras) this.group.add(extra);
    this.centre.addVectors(this.min, this.max).multiplyScalar(0.5);
    this.radius = this.min.distanceTo(this.max) / 2;
    this.lo.visible = false;
  }

  finish(): void {
    const g = this.finishSteps();
    while (!g.next().done);
  }
}

export class ChunkGrid {
  readonly chunks = new Map<string, Chunk>();

  constructor(private readonly signMaterial: () => Material) {}

  /** The chunk (of a build pass `pass`) containing (x, z). */
  at(pass: string, layer: Layer, x: number, z: number): Chunk {
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    const key = `${pass}:${layer}:${cx}:${cz}`;
    let c = this.chunks.get(key);
    if (!c) {
      c = new Chunk(key, layer, this.signMaterial);
      this.chunks.set(key, c);
    }
    return c;
  }

  /** Chunks of a pass that have not been finished yet. */
  pending(pass: string): Chunk[] {
    const out: Chunk[] = [];
    for (const c of this.chunks.values()) if (!c.built && c.key.startsWith(`${pass}:`)) out.push(c);
    return out;
  }
}
