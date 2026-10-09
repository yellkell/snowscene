/**
 * Realistic snow-laden spruce forest. Each tree is a tapered barked trunk
 * plus whorls of drooping branch cards (one flat, one upright per branch for
 * volume) textured with procedural needle sprays and snow. Foliage normals
 * point outward from the trunk for soft, volumetric lighting. Trunk and
 * foliage are instanced, cast shadows, and use alpha-to-coverage for crisp
 * edges under MSAA.
 */

import {
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from '@iwsdk/core';
import { chunkInstanced } from './fog-cull.js';
import {
  LAKE_CENTER_X,
  LAKE_CENTER_Z,
  LAKE_RADIUS_X,
  LAKE_RADIUS_Z,
  mulberry32,
  pathX,
  terrainHeight,
  terrainSlope,
  TUTORIAL_CENTER_X,
  TUTORIAL_CENTER_Z,
  TUTORIAL_TERRAIN_RADIUS,
  valueNoise,
  CLIFF_CENTER_X,
  WALL_S,
  WALL_Z,
} from './terrain.js';
import { buildBarkTexture, buildBranchTexture } from './textures.js';

/** Unit-height spruce foliage (trunk at the origin, top at y = 1). */
function buildFoliageGeometry(): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const rand = mulberry32(5);
  const quad = (
    a: Vector3,
    b: Vector3,
    c: Vector3,
    d: Vector3,
    n: Vector3,
  ) => {
    // a-b along the trunk end (u = 0), c-d at the tip (u = 1)
    const verts = [a, d, c, a, c, b];
    const uv = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
      [1, 1],
      [0, 1],
    ];
    verts.forEach((v, i) => {
      positions.push(v.x, v.y, v.z);
      normals.push(n.x, n.y, n.z);
      uvs.push(uv[i][0], uv[i][1]);
    });
  };

  const whorls = 11;
  const golden = 2.39996;
  let azimuth = 0;
  for (let w = 0; w < whorls; w++) {
    const t = w / whorls;
    const y = 0.1 + t * 0.84;
    const length = 0.27 * Math.pow(1 - t, 0.85) + 0.035;
    const branches = w > whorls - 3 ? 5 : 8;
    for (let b = 0; b < branches; b++) {
      azimuth += golden;
      const dir = new Vector3(Math.cos(azimuth), 0, Math.sin(azimuth));
      const side = new Vector3(-dir.z, 0, dir.x);
      const droop = length * (0.32 + rand() * 0.18);
      const root = new Vector3(0, y, 0);
      const tip = root.clone().addScaledVector(dir, length);
      tip.y -= droop;
      const width = length * 0.78;
      // outward-and-up normal for soft foliage lighting
      const n = new Vector3(dir.x, 0.55, dir.z).normalize();
      // flat card (seen from above / below)
      quad(
        root.clone().addScaledVector(side, -width * 0.25),
        root.clone().addScaledVector(side, width * 0.25),
        tip.clone().addScaledVector(side, width * 0.5),
        tip.clone().addScaledVector(side, -width * 0.5),
        n,
      );
      // upright card (seen from the side)
      quad(
        root.clone().add(new Vector3(0, -width * 0.2, 0)),
        root.clone().add(new Vector3(0, width * 0.2, 0)),
        tip.clone().add(new Vector3(0, width * 0.4, 0)),
        tip.clone().add(new Vector3(0, -width * 0.4, 0)),
        n,
      );
    }
  }
  // leader: two crossed cards at the crown
  for (const a of [0, Math.PI / 2]) {
    const side = new Vector3(Math.cos(a), 0, Math.sin(a));
    const n = new Vector3(side.x, 0.8, side.z).normalize();
    quad(
      new Vector3(0, 0.88, 0).addScaledVector(side, -0.05),
      new Vector3(0, 0.88, 0).addScaledVector(side, 0.05),
      new Vector3(0, 1.02, 0).addScaledVector(side, 0.01),
      new Vector3(0, 1.02, 0).addScaledVector(side, -0.01),
      n,
    );
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.computeBoundingSphere();
  return geometry;
}

function buildTrunkGeometry(): BufferGeometry {
  const trunk = new CylinderGeometry(0.003, 0.016, 1, 7, 1, true);
  trunk.translate(0, 0.5, 0);
  return trunk;
}

/** Where a tree may grow. */
function canGrow(x: number, z: number): boolean {
  const y = terrainHeight(x, z);
  const s = -z;
  const d = Math.abs(x - pathX(z));
  if (y > 18 + valueNoise(x * 0.05, z * 0.05) * 3) return false; // tree line
  if (y < -40) return false; // lip of the cloud sea drop-off
  if (terrainSlope(x, z) > 0.8) return false;
  if (s > -12 && s < WALL_S + 6 && d < 7.5) return false; // keep the trail open
  if (s > -14 && s < 25 && d < 11) return false; // view up the trail from the start
  if (Math.hypot(x, z) < 12) return false;
  if (Math.hypot(x + 9.5, z - 4.5) < 7) return false; // base camp cabin
  const lx = (x - LAKE_CENTER_X) / LAKE_RADIUS_X;
  const lz = (z - LAKE_CENTER_Z) / LAKE_RADIUS_Z;
  if (lx * lx + lz * lz < 1.3) return false;
  if (s > 60 && s < 95 && d < 14) return false; // cliff + summit
  if (s > 40 && s < WALL_S && d < 16) return false; // keep the launch vista open
  // Stay inside the playable terrain (the great ranges draw behind it).
  if (Math.hypot(x - TUTORIAL_CENTER_X, z - TUTORIAL_CENTER_Z) > TUTORIAL_TERRAIN_RADIUS - 6) return false;
  // Keep the glide corridor from the summit to the lake party clear of trees.
  if (z > WALL_Z - 10 && z < LAKE_CENTER_Z + 40) {
    const t = (z - WALL_Z) / (LAKE_CENTER_Z - WALL_Z);
    const cx = CLIFF_CENTER_X + (LAKE_CENTER_X - CLIFF_CENTER_X) * Math.min(1, Math.max(0, t));
    if (Math.abs(x - cx) < 36 + 14 * Math.min(1, Math.max(0, t))) return false;
  }
  return true;
}

/** Forest chunk size (m). */
const FOREST_CELL = 100;

export function buildForest(count = 520): Group {
  const rand = mulberry32(42);
  const matrices: Matrix4[] = [];
  const tints: Color[] = [];
  const q = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const pos = new Vector3();
  const scale = new Vector3();
  let attempts = 0;
  while (matrices.length < count && attempts < 40000) {
    attempts++;
    const nearTrail = rand() < 0.4;
    const x = nearTrail ? (rand() * 2 - 1) * 50 : (rand() * 2 - 1) * 260;
    const z = nearTrail ? 35 - rand() * 100 : 300 - rand() * 510;
    if (!canGrow(x, z)) continue;
    // Clumped distribution reads more natural than uniform scatter.
    if (valueNoise(x * 0.03, z * 0.03) < -0.25 && rand() < 0.7) continue;
    // Trees grow shorter toward the tree line.
    const ground = terrainHeight(x, z);
    const height = (6 + rand() * 9) * (1 - 0.55 * Math.min(1, Math.max(0, (ground - 4) / 14)));
    pos.set(x, ground - 0.2, z);
    q.setFromAxisAngle(up, rand() * Math.PI * 2);
    const girth = height * (0.85 + rand() * 0.3);
    scale.set(girth, height, girth);
    matrices.push(new Matrix4().compose(pos, q, scale));
    const shade = 0.82 + rand() * 0.22;
    tints.push(new Color(shade, shade * (0.97 + rand() * 0.06), shade));
  }

  const branchTexture = buildBranchTexture();
  const foliage = new InstancedMesh(
    buildFoliageGeometry(),
    new MeshStandardMaterial({
      map: branchTexture,
      alphaTest: 0.38,
      alphaToCoverage: true,
      side: DoubleSide,
      roughness: 0.92,
      metalness: 0,
    }),
    matrices.length,
  );
  const trunk = new InstancedMesh(
    buildTrunkGeometry(),
    new MeshStandardMaterial({ map: buildBarkTexture(), roughness: 0.95 }),
    matrices.length,
  );
  // Shadows come from a cheap solid cone per tree instead of the
  // alpha-tested cards; it never draws to the screen.
  const shadowCone = new ConeGeometry(0.26, 0.92, 7, 1, true);
  shadowCone.translate(0, 0.52, 0);
  const shadowCaster = new InstancedMesh(
    shadowCone,
    new MeshBasicMaterial({ colorWrite: false, depthWrite: false }),
    matrices.length,
  );
  matrices.forEach((m, i) => {
    foliage.setMatrixAt(i, m);
    foliage.setColorAt(i, tints[i]);
    trunk.setMatrixAt(i, m);
    shadowCaster.setMatrixAt(i, m);
  });
  for (const mesh of [foliage, trunk, shadowCaster]) {
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }
  foliage.receiveShadow = true;
  trunk.receiveShadow = true;
  shadowCaster.castShadow = true;
  shadowCaster.name = 'ForestShadowCaster';
  if (foliage.instanceColor) foliage.instanceColor.needsUpdate = true;
  foliage.name = 'ForestFoliage';
  trunk.name = 'ForestTrunks';
  // In chunks, so the frustum and the fog can skip the trees you can't see.
  return chunkInstanced([foliage, trunk, shadowCaster], FOREST_CELL, 'Forest');
}
