/**
 * Chunked, distance-LOD'd baked layers (art/scripts/lod_build.py -> public/<dir>/<name>_lod.glb and
 * lod.json). A baked layer drawn as one mesh costs all its triangles from anywhere; as chunks the frustum
 * drops the ones out of view, the fog the ones it has swallowed, and past `switch` metres each chunk draws
 * its stand-in. Every chunk shares the layer's one material.
 *
 * The stand-ins are made here, at load: meshoptimizer simplifies each decoded chunk into a second index
 * buffer over the very same vertices (no extra vertex memory or download). Split vertices at one position
 * are an atlas seam to it, which it slides along consistently, so no face is dragged into another island;
 * the chunk's open border is locked, so a stand-in meets a full-detail neighbour vertex for vertex.
 */

import { BufferAttribute, BufferGeometry, type Box3, Group, type Material, Mesh, type Object3D, Uint16BufferAttribute, Uint32BufferAttribute, Vector3 } from '@iwsdk/core';
import { MeshoptSimplifier } from 'meshoptimizer';
import { fogCullables } from '../fog-cull.js';
import { loadGLTF, loadJSON } from './loaders.js';

export interface LodInfo {
  mesh: string;
  switch: number;
  /** The stand-in's floor (fraction of the triangles); null: chunks only. */
  ratio: number | null;
  chunks: number;
}

/** A stand-in may move the surface by this fraction of its switch distance: ~0.075 deg, ~1.5 px on Quest 3. */
const SCREEN_ERROR = 0.0013;
/** Stand-ins that keep more than this of the triangles aren't worth a draw of their own. */
const WORTH = 0.85;

/**
 * `geo` simplified for viewing from `distance` metres on: the same attributes under a new index, or null
 * when it can't lose enough to be worth it.
 */
export async function standIn(geo: BufferGeometry, distance: number, floor: number): Promise<BufferGeometry | null> {
  await MeshoptSimplifier.ready;
  const pos = geo.attributes.position;
  if (!geo.index || pos.itemSize !== 3 || !(pos.array instanceof Float32Array) || (pos as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute) return null;
  const idx = Uint32Array.from(geo.index.array);
  const target = Math.floor((idx.length * floor) / 3) * 3;
  const [out] = MeshoptSimplifier.simplify(idx, pos.array, 3, target, distance * SCREEN_ERROR, ['LockBorder', 'ErrorAbsolute']);
  if (out.length > idx.length * WORTH) return null;
  const g = new BufferGeometry();
  for (const name of Object.keys(geo.attributes)) g.setAttribute(name, geo.attributes[name]);
  g.setIndex(pos.count < 65536 ? new Uint16BufferAttribute(Uint16Array.from(out), 1) : new Uint32BufferAttribute(out, 1));
  g.boundingSphere = geo.boundingSphere?.clone() ?? null;
  return g;
}

/** Load-time cost and savings of the stand-ins (read by the profiler). */
export const lodStats = { ms: 0, tris: 0, standInTris: 0 };

const indexes = new Map<string, Promise<Record<string, LodInfo>>>();

/** The layers of `dir` that have chunks (empty when lod.json is missing). */
export function lodIndex(dir: string): Promise<Record<string, LodInfo>> {
  let p = indexes.get(dir);
  if (!p) {
    p = loadJSON<Record<string, LodInfo>>(`${dir}lod.json`).catch(() => ({}));
    indexes.set(dir, p);
  }
  return p;
}

export interface Chunked {
  group: Group;
  /** Every chunk's full-detail geometry, for callers that also need the layer whole (none so far). */
  meshes: Mesh[];
}

/**
 * The layer `name` of `dir` as chunks under one group, or null when it has none. The chunks' centres
 * follow the group wherever it is placed (the cave and the party move theirs).
 */
/**
 * Drop every triangle of an indexed geometry that lies wholly inside one of `boxes` (positions in the
 * geometry's own space): for taking a piece out of a bake without rebaking it.
 */
export function cutTriangles(geo: BufferGeometry, boxes: readonly Box3[]): void {
  if (!boxes.length || !geo.index) return;
  const index = geo.index.array;
  const pos = geo.attributes.position;
  const p = new Vector3();
  const inside = (v: number, box: Box3) => box.containsPoint(p.fromBufferAttribute(pos, v));
  const keep: number[] = [];
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t];
    const b = index[t + 1];
    const c = index[t + 2];
    if (boxes.some((box) => inside(a, box) && inside(b, box) && inside(c, box))) continue;
    keep.push(a, b, c);
  }
  if (keep.length === index.length) return;
  geo.setIndex(pos.count > 65535 ? new Uint32BufferAttribute(keep, 1) : new Uint16BufferAttribute(keep, 1));
}

export async function loadChunked(
  dir: string,
  name: string,
  material: Material,
  opts: { label?: string; cut?: readonly Box3[] } = {},
): Promise<Chunked | null> {
  const info = (await lodIndex(dir))[name];
  if (!info) return null;
  const gltf = await loadGLTF(dir + info.mesh);
  const parts = new Map<string, BufferGeometry>();
  gltf.scene.traverse((o: Object3D) => {
    const m = o as Mesh;
    const hit = /^c(\d+)_l0/u.exec(o.name);
    if (m.isMesh && hit) parts.set(hit[1], m.geometry);
  });
  const group = new Group();
  group.name = opts.label ?? `Baked_${name}`;
  const meshes: Mesh[] = [];
  const t0 = performance.now();
  for (const [k, geo] of parts) {
    if (opts.cut) cutTriangles(geo, opts.cut);
    const chunk = new Group();
    chunk.name = `${group.name}-${k}`;
    const near = new Mesh(geo, material);
    near.name = `${group.name}-${k}-l0`;
    chunk.add(near);
    meshes.push(near);
    geo.computeBoundingSphere();
    let far: Mesh | null = null;
    const lo = info.ratio ? await standIn(geo, info.switch, info.ratio) : null;
    if (lo) {
      far = new Mesh(lo, material);
      far.name = `${group.name}-${k}-l1`;
      far.visible = false;
      chunk.add(far);
      lodStats.tris += (geo.index?.count ?? 0) / 3;
      lodStats.standInTris += (lo.index?.count ?? 0) / 3;
    }
    group.add(chunk);
    const s = geo.boundingSphere!;
    fogCullables.push({
      object: chunk,
      center: s.center.clone(),
      radius: s.radius,
      fogScale: 1.6,
      ownLod: true,
      local: { world: new Vector3() },
      lod: far ? { near: [near], far, distance: info.switch } : undefined,
    });
  }
  lodStats.ms += performance.now() - t0;
  return { group, meshes };
}

/**
 * Split a (static, indexed) mesh into chunks on a quadtree over the ground plane, so dense parts become
 * small chunks and sparse ones stay few: leaves hold at most `maxTris` triangles (or are `minSize` m
 * across). For meshes the game builds itself (the tutorial's terrain); every chunk shares `material`.
 */
export function splitMesh(geo: BufferGeometry, material: Material, name: string, maxTris = 6000, minSize = 30): Group {
  const index = geo.index!.array;
  const pos = geo.attributes.position.array;
  const n = index.length / 3;
  const cx = new Float32Array(n);
  const cz = new Float32Array(n);
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (let t = 0; t < n; t++) {
    const a = index[t * 3] * 3;
    const b = index[t * 3 + 1] * 3;
    const c = index[t * 3 + 2] * 3;
    cx[t] = (pos[a] + pos[b] + pos[c]) / 3;
    cz[t] = (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3;
    x0 = Math.min(x0, cx[t]);
    x1 = Math.max(x1, cx[t]);
    z0 = Math.min(z0, cz[t]);
    z1 = Math.max(z1, cz[t]);
  }
  const leaves: number[][] = [];
  const split = (tris: number[], ax: number, az: number, bx: number, bz: number) => {
    if (!tris.length) return;
    if (tris.length <= maxTris || Math.max(bx - ax, bz - az) <= minSize) {
      leaves.push(tris);
      return;
    }
    const mx = (ax + bx) / 2;
    const mz = (az + bz) / 2;
    const q: number[][] = [[], [], [], []];
    for (const t of tris) q[(cx[t] >= mx ? 1 : 0) + (cz[t] >= mz ? 2 : 0)].push(t);
    split(q[0], ax, az, mx, mz);
    split(q[1], mx, az, bx, mz);
    split(q[2], ax, mz, mx, bz);
    split(q[3], mx, mz, bx, bz);
  };
  split(Array.from({ length: n }, (_, i) => i), x0, z0, x1 + 1e-3, z1 + 1e-3);
  const group = new Group();
  group.name = name;
  const names = Object.keys(geo.attributes);
  leaves.forEach((tris, k) => {
    const remap = new Map<number, number>();
    const idx = new Uint32Array(tris.length * 3);
    tris.forEach((t, j) => {
      for (let e = 0; e < 3; e++) {
        const v = index[t * 3 + e];
        let r = remap.get(v);
        if (r === undefined) remap.set(v, (r = remap.size));
        idx[j * 3 + e] = r;
      }
    });
    const g = new BufferGeometry();
    for (const an of names) {
      const src = geo.attributes[an] as BufferAttribute;
      const size = src.itemSize;
      const arr = new (src.array.constructor as Float32ArrayConstructor)(remap.size * size);
      for (const [v, r] of remap) for (let e = 0; e < size; e++) arr[r * size + e] = src.array[v * size + e];
      g.setAttribute(an, new BufferAttribute(arr, size, src.normalized));
    }
    g.setIndex(new BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    const mesh = new Mesh(g, material);
    mesh.name = `${name}-${k}`;
    group.add(mesh);
    const s = g.boundingSphere!;
    fogCullables.push({ object: mesh, center: s.center.clone(), radius: s.radius, fogScale: 1.6, local: { world: new Vector3() } });
  });
  return group;
}
