/**
 * The Snow Survivors arena: one wide snowfield and low-poly spruce, a few
 * scattered across the open plain and a dense ring of forest round its
 * edge. Three draws: the ground, the trees, their trunks are part of the
 * same spruce mesh.
 */

import {
  CircleGeometry,
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
import { ARENA_RADIUS, ARENA_X, ARENA_Z } from './survivors-level.js';

const OPEN_TREES = 220;
const EDGE_TREES = 700;

export function buildSurvivorsWorld(): Group {
  const group = new Group();
  group.name = 'SurvivorsArena';
  group.position.set(ARENA_X, 0, ARENA_Z);

  const ground = new Mesh(new CircleGeometry(ARENA_RADIUS + 900, 64).rotateX(-Math.PI / 2), createLandMaterial({ snowScale: 2.6, sparkle: true }));
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
    q.setFromAxisAngle(up, rand() * Math.PI * 2);
    s.set(h * (0.85 + rand() * 0.3), h, h * (0.85 + rand() * 0.3));
    p.set(x, -0.05, z);
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
