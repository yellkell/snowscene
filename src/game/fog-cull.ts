/**
 * Culling scenery that the fog has swallowed. Big instanced scatters (the
 * forest, the boulders) are split into spatial chunks so the frustum can
 * skip the ones behind you, and the weather hides any chunk lying wholly
 * beyond the fog's far distance (in the tutorial's blizzard that is almost
 * all of them).
 */

import { Group, InstancedBufferAttribute, InstancedMesh, type Object3D, Vector3 } from '@iwsdk/core';

export interface FogCullable {
  object: Object3D;
  center: Vector3;
  radius: number;
}

/** Everything the weather may hide when the fog closes in. */
export const fogCullables: FogCullable[] = [];

/**
 * Split instanced meshes that share their instance transforms (e.g. a tree's
 * trunk, foliage and shadow caster) into chunks of `cell` metres. Returns a
 * group of chunk groups; each chunk is registered for fog culling.
 */
export function chunkInstanced(meshes: InstancedMesh[], cell: number, name: string): Group {
  const first = meshes[0];
  const cells = new Map<string, number[]>();
  const src = first.instanceMatrix.array;
  for (let i = 0; i < first.count; i++) {
    // An instance's translation is elements 12..14 of its 16-float matrix.
    const key = `${Math.floor(src[i * 16 + 12] / cell)},${Math.floor(src[i * 16 + 14] / cell)}`;
    let list = cells.get(key);
    if (!list) cells.set(key, (list = []));
    list.push(i);
  }
  const root = new Group();
  root.name = name;
  for (const [key, list] of cells) {
    const chunk = new Group();
    chunk.name = `${name}-${key}`;
    for (const source of meshes) {
      const part = new InstancedMesh(source.geometry, source.material, list.length);
      part.name = `${source.name}-${key}`;
      part.castShadow = source.castShadow;
      part.receiveShadow = source.receiveShadow;
      const matrices = part.instanceMatrix.array;
      const colors = source.instanceColor ? new Float32Array(list.length * 3) : null;
      list.forEach((index, j) => {
        for (let e = 0; e < 16; e++) matrices[j * 16 + e] = source.instanceMatrix.array[index * 16 + e];
        if (colors && source.instanceColor) {
          for (let e = 0; e < 3; e++) colors[j * 3 + e] = source.instanceColor.array[index * 3 + e];
        }
      });
      if (colors) part.instanceColor = new InstancedBufferAttribute(colors, 3);
      part.instanceMatrix.needsUpdate = true;
      part.computeBoundingSphere();
      chunk.add(part);
    }
    root.add(chunk);
    const sphere = (chunk.children[0] as InstancedMesh).boundingSphere;
    if (sphere) fogCullables.push({ object: chunk, center: sphere.center.clone(), radius: sphere.radius });
  }
  return root;
}
