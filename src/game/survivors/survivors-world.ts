/**
 * The Snow Survivors arena: the game's own ground mesh (duneHeight, so it is
 * exactly what you walk and fight on) dressed by the Blender bake in
 * public/survivors/ (see baked/survivors-arena.ts): lightmapped snow, the
 * spruce forest as impostors with real geometry close to, rocks and windfall,
 * and the photographed sunset sky.
 *
 * The bake streams in after the arena first opens; until then (or if it is
 * missing) the ground shows in the plain land material.
 */

import { BufferAttribute, BufferGeometry, Group, type Material, Mesh, type Object3D, Vector3 } from '@iwsdk/core';
import { loadSurvivorsArena, type BakedArena } from '../baked/survivors-arena.js';
import { createLandMaterial } from '../land-material.js';
import { ARENA_RADIUS, ARENA_X, ARENA_Z, duneHeight } from './survivors-level.js';

export interface SurvivorsWorld {
  /** Arena-relative content; sits at the arena origin. */
  group: Group;
  /** Call every frame with the head position (world). */
  update(dt: number, head: Vector3, progress: number): void;
}

export function buildSurvivorsWorld(addWorldSpace: (o: Object3D) => void): SurvivorsWorld {
  const group = new Group();
  group.name = 'SurvivorsArena';
  group.position.set(ARENA_X, 0, ARENA_Z);
  const ground = new Mesh<BufferGeometry, Material>(groundGeometry(), createLandMaterial({ sparkle: true, lite: true }));
  ground.name = 'SurvivorsGround';
  group.add(ground);

  let arena: BakedArena | null = null;
  loadSurvivorsArena(ARENA_X, ARENA_Z)
    .then((a) => {
      arena = a;
      if (a.groundMaterial) ground.material = a.groundMaterial;
      group.add(a.group);
      if (a.sky) addWorldSpace(a.sky);
    })
    .catch((e) => console.error('Snow Survivors bake failed to load', e));

  return {
    group,
    update(dt: number, head: Vector3, progress: number) {
      if (!arena) return;
      arena.sky?.position.copy(head);
      arena.update(dt, head, progress);
    },
  };
}

/**
 * The snowfield: a polar grid round the arena's middle, about 2.5 m apart out
 * to the forest so the swells and the hill keep their shape, then spreading
 * out to the horizon where the ground is flat.
 */
function groundGeometry(): BufferGeometry {
  const SEGMENTS = 256;
  const radii: number[] = [];
  for (let r = 0; r <= 300; r += 2.5) radii.push(r);
  for (let r = 330; r < ARENA_RADIUS + 900; r *= 1.18) radii.push(r);
  radii.push(ARENA_RADIUS + 900);
  const positions = new Float32Array((1 + (radii.length - 1) * SEGMENTS) * 3);
  positions[1] = duneHeight(ARENA_X, ARENA_Z);
  let v = 1;
  for (let j = 1; j < radii.length; j++) {
    for (let i = 0; i < SEGMENTS; i++) {
      const a = (i / SEGMENTS) * Math.PI * 2;
      const x = Math.cos(a) * radii[j];
      const z = Math.sin(a) * radii[j];
      positions[v * 3] = x;
      positions[v * 3 + 1] = duneHeight(ARENA_X + x, ARENA_Z + z);
      positions[v * 3 + 2] = z;
      v++;
    }
  }
  const ring = (j: number, i: number) => 1 + (j - 1) * SEGMENTS + (i % SEGMENTS);
  const index: number[] = [];
  for (let i = 0; i < SEGMENTS; i++) index.push(0, ring(1, i + 1), ring(1, i));
  for (let j = 1; j < radii.length - 1; j++) {
    for (let i = 0; i < SEGMENTS; i++) {
      const a = ring(j, i);
      const b = ring(j, i + 1);
      const c = ring(j + 1, i);
      const d = ring(j + 1, i + 1);
      index.push(a, b, c, b, d, c);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

