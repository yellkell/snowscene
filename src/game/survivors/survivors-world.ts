/**
 * The Snow Survivors arena: one wide snowfield of long, low swells and
 * low-poly spruce, a few scattered across the open plain and a dense ring of
 * forest round its edge. Two draws: the ground and the trees (their trunks
 * are part of the same spruce mesh). The snow is the valley's own land
 * material, so it reads as more of the same mountain.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from '@iwsdk/core';
import { spruceGeometry } from '../expedition/world/nature-meshes.js';
import { createLandMaterial } from '../land-material.js';
import { mulberry32 } from '../terrain.js';
import { ARENA_RADIUS, ARENA_X, ARENA_Z, duneHeight } from './survivors-level.js';

const OPEN_TREES = 220;
const EDGE_TREES = 700;

export function buildSurvivorsWorld(): Group {
  const group = new Group();
  group.name = 'SurvivorsArena';
  group.position.set(ARENA_X, 0, ARENA_Z);

  const ground = new Mesh(groundGeometry(), createLandMaterial({ sparkle: true, lite: true }));
  ground.receiveShadow = true;
  ground.name = 'SurvivorsGround';
  group.add(ground);

  // Low-poly spruce: a scatter across the plain (never right in the middle,
  // where a run starts), and a dense dark ring of forest round the edge.
  const rand = mulberry32(2024);
  const trees = new InstancedMesh(
    spruceGeometry('lo'),
    new MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, flatShading: true }),
    OPEN_TREES + EDGE_TREES,
  );
  const m = new Matrix4();
  const q = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const s = new Vector3();
  const p = new Vector3();
  const tint = new Color();
  let n = 0;
  const plant = (x: number, z: number, h: number) => {
    const y = duneHeight(ARENA_X + x, ARENA_Z + z);
    q.setFromAxisAngle(up, rand() * Math.PI * 2);
    s.set(h * (0.85 + rand() * 0.3), h, h * (0.85 + rand() * 0.3));
    p.set(x, y - 0.05, z);
    trees.setMatrixAt(n, m.compose(p, q, s));
    tint.setHSL(0.36 + rand() * 0.06, 0.25 + rand() * 0.2, 0.75 + rand() * 0.35);
    trees.setColorAt(n, tint);
    n++;
  };
  for (let i = 0; i < OPEN_TREES; i++) {
    const a = rand() * Math.PI * 2;
    const r = 18 + Math.sqrt(rand()) * (ARENA_RADIUS - 30);
    plant(Math.cos(a) * r, Math.sin(a) * r, 4 + rand() * 6);
  }
  for (let i = 0; i < EDGE_TREES; i++) {
    const a = rand() * Math.PI * 2;
    const r = ARENA_RADIUS + 6 + rand() * 70;
    plant(Math.cos(a) * r, Math.sin(a) * r, 7 + rand() * 9);
  }
  trees.count = n;
  trees.instanceMatrix.needsUpdate = true;
  if (trees.instanceColor) trees.instanceColor.needsUpdate = true;
  trees.castShadow = true;
  trees.computeBoundingSphere();
  trees.name = 'SurvivorsTrees';
  group.add(trees);
  return group;
}

/**
 * The snowfield: a polar grid round the arena's middle, about 3 m apart out
 * to the forest so the swells are smooth, then spreading out to the horizon
 * where the ground is flat.
 */
function groundGeometry(): BufferGeometry {
  const SEGMENTS = 160;
  const radii: number[] = [];
  for (let r = 0; r <= 300; r += 3) radii.push(r);
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
