/**
 * Procedural builders for the mountain scene. Each returns plain Three.js
 * objects; SceneSetupSystem wraps them in entities.
 */

import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  TorusGeometry,
  Uint32BufferAttribute,
  Vector3,
} from '@iwsdk/core';
import { applyFireGlow, createLandMaterial } from './land-material.js';
import { GeometryBuilder, placed } from './mesh-utils.js';
import {
  CLIFF_BASE_Y,
  CLIFF_CENTER_X,
  CLOUD_SEA_Y,
  fbm,
  LAKE_CENTER_X,
  LAKE_CENTER_Z,
  LAKE_RADIUS_X,
  LAKE_RADIUS_Z,
  LAKE_Y,
  mulberry32,
  pathX,
  smoothstep,
  SUMMIT_Y,
  terrainHeight,
  terrainSlope,
  TRAIL_END_S,
  TUTORIAL_CENTER_X,
  TUTORIAL_CENTER_Z,
  TUTORIAL_TERRAIN_RADIUS,
  valueNoise,
  WALL_S,
  WALL_Z,
} from './terrain.js';

/** Direction the sunlight comes from (low, golden, over the valley). */
/**
 * Direction the sunlight comes from: a low dusk sun off to the west of the
 * glide line, so the campfire ahead never sits in its glare.
 */
export const SUN_DIRECTION = new Vector3(-0.72, 0.065, 0.68).normalize();
/** Clear-weather aerial haze colour (linear). */
export const FOG_COLOR = new Color(0.5, 0.58, 0.74);

// ------------------------------------------------------------- terrain -----

/**
 * Grid coordinates: uniform spacing in the core play area, growing
 * geometrically outward so the far terrain stays cheap.
 */
function axisSamples(
  coreMin: number,
  coreMax: number,
  step: number,
  outerMin: number,
  outerMax: number,
  outerSegs: number,
): number[] {
  const grow = (length: number): number[] => {
    let lo = 1.0001;
    let hi = 3;
    for (let i = 0; i < 80; i++) {
      const r = (lo + hi) / 2;
      const sum = (step * r * (Math.pow(r, outerSegs) - 1)) / (r - 1);
      if (sum > length) hi = r;
      else lo = r;
    }
    const r = lo;
    const offsets: number[] = [];
    let acc = 0;
    for (let k = 1; k <= outerSegs; k++) {
      acc += step * Math.pow(r, k);
      offsets.push(acc);
    }
    const scale = length / acc;
    return offsets.map((o) => o * scale);
  };
  const out: number[] = [];
  const lower = grow(coreMin - outerMin);
  for (let i = lower.length - 1; i >= 0; i--) out.push(coreMin - lower[i]);
  const n = Math.round((coreMax - coreMin) / step);
  for (let i = 0; i <= n; i++) out.push(coreMin + ((coreMax - coreMin) * i) / n);
  for (const o of grow(outerMax - coreMax)) out.push(coreMax + o);
  return out;
}

export function buildTerrain(): Mesh {
  const xs = axisSamples(-45, 45, 1, -360, 360, 46);
  const zs = axisSamples(-100, 30, 1, -380, 360, 46);
  const nx = xs.length;
  const nz = zs.length;
  const positions = new Float32Array(nx * nz * 3);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = (j * nx + i) * 3;
      positions[k] = xs[i];
      positions[k + 1] = terrainHeight(xs[i], zs[j]);
      positions[k + 2] = zs[j];
    }
  }
  // The great ranges (far depth layer) begin where this terrain ends, so
  // drop anything outside that radius, and anything sunk in the clouds.
  const keep = new Uint8Array(nx * nz);
  for (let v = 0; v < nx * nz; v++) {
    const x = positions[v * 3];
    const y = positions[v * 3 + 1];
    const z = positions[v * 3 + 2];
    const inside = Math.hypot(x - TUTORIAL_CENTER_X, z - TUTORIAL_CENTER_Z) <= TUTORIAL_TERRAIN_RADIUS;
    keep[v] = inside ? (y > CLOUD_SEA_Y - 4 ? 2 : 1) : 0;
  }
  const tri = (p: number, q: number, r: number) =>
    keep[p] && keep[q] && keep[r] && (keep[p] === 2 || keep[q] === 2 || keep[r] === 2);
  const indexList: number[] = [];
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      // counter-clockwise when seen from above (+Y)
      if (tri(a, c, b)) indexList.push(a, c, b);
      if (tri(b, c, d)) indexList.push(b, c, d);
    }
  }
  const indices = new Uint32Array(indexList);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(new Uint32BufferAttribute(indices, 1));
  geometry.computeVertexNormals();

  // Vertex colours only tint the packed trail; snow and rock come from the
  // land material.
  const colors = new Float32Array(nx * nz * 3);
  const packed = new Color(0.8, 0.84, 0.92);
  const white = new Color(1, 1, 1);
  const c = new Color();
  for (let v = 0; v < nx * nz; v++) {
    const x = positions[v * 3];
    const z = positions[v * 3 + 2];
    const s = -z;
    const d = Math.abs(x - pathX(z));
    c.copy(white);
    if (s > -6 && s < WALL_S + 0.5) c.lerp(packed, 0.7 * (1 - smoothstep(0.5, 2.0, d)));
    colors[v * 3] = c.r;
    colors[v * 3 + 1] = c.g;
    colors[v * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();

  const mesh = new Mesh(geometry, createLandMaterial({ sparkle: true, vertexColors: true, cloudMist: true }));
  mesh.name = 'Terrain';
  mesh.receiveShadow = true;
  return mesh;
}

// --------------------------------------------------------------- rocks -----

function buildRockGeometry(seed: number): BufferGeometry {
  const geo = new IcosahedronGeometry(1, 3);
  const pos = geo.getAttribute('position');
  const nor = geo.getAttribute('normal');
  for (let v = 0; v < pos.count; v++) {
    const x = pos.getX(v);
    const y = pos.getY(v);
    const z = pos.getZ(v);
    // Weathered boulder: broad lumps plus a few fracture facets.
    const lump = 0.22 * valueNoise(x * 1.6 + seed, z * 1.6 + y * 1.3);
    const facet = 0.08 * Math.abs(valueNoise(x * 4.1 - seed, y * 4.3 + z * 2.2));
    const f = 1 + lump - facet;
    pos.setXYZ(v, x * f, y * f * 0.72, z * f);
    // Smooth normals from the sphere direction; detail comes from the normal maps.
    const len = Math.hypot(x, y / 0.72, z);
    nor.setXYZ(v, x / len, y / 0.72 / len, z / len);
  }
  geo.computeBoundingSphere();
  return geo;
}

export function buildRocks(): InstancedMesh {
  const rand = mulberry32(99);
  const placements: Matrix4[] = [];
  const q = new Quaternion();
  const pos = new Vector3();
  const scale = new Vector3();
  const euler = new Vector3();
  const add = (x: number, z: number, size: number, sink = 0.35) => {
    const y = terrainHeight(x, z);
    euler.set(rand() * 0.6, rand() * Math.PI * 2, rand() * 0.6);
    q.setFromAxisAngle(euler.clone().normalize(), euler.length());
    pos.set(x, y - size * sink, z);
    scale.set(size * (0.8 + rand() * 0.5), size * (0.7 + rand() * 0.4), size);
    placements.push(new Matrix4().compose(pos, q, scale));
  };
  // Boulders flanking the trail.
  for (let s = 6; s < TRAIL_END_S; s += 4 + rand() * 5) {
    const side = rand() < 0.5 ? -1 : 1;
    const z = -s;
    add(pathX(z) + side * (3.4 + rand() * 4), z, 0.35 + rand() * 0.9);
  }
  // Talus around the foot of the cliff and the summit shoulder.
  for (let i = 0; i < 26; i++) {
    const side = rand() < 0.5 ? -1 : 1;
    const z = WALL_Z + 0.8 + rand() * 6;
    add(CLIFF_CENTER_X + side * (2.6 + rand() * 7), z, 0.3 + rand() * 1.0);
  }
  for (let i = 0; i < 18; i++) {
    const side = rand() < 0.5 ? -1 : 1;
    const z = WALL_Z - 4 - rand() * 14;
    add(CLIFF_CENTER_X + side * (3.5 + rand() * 9), z, 0.4 + rand() * 1.3);
  }
  // Scattered across the wider slopes.
  for (let i = 0; i < 120; i++) {
    const x = (rand() * 2 - 1) * 140;
    const z = 120 - rand() * 280;
    if (Math.abs(x - pathX(z)) < 6 && z < 15 && z > -80) continue;
    const lx = (x - LAKE_CENTER_X) / LAKE_RADIUS_X;
    const lz = (z - LAKE_CENTER_Z) / LAKE_RADIUS_Z;
    if (lx * lx + lz * lz < 1.4) continue;
    add(x, z, 0.6 + rand() * 2.5, 0.45);
  }
  const mesh = new InstancedMesh(
    buildRockGeometry(3),
    createLandMaterial({ rockBias: 1, rockScale: 1.6, snowScale: 1.5 }),
    placements.length,
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  placements.forEach((m, i) => mesh.setMatrixAt(i, m));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.name = 'Rocks';
  return mesh;
}

// --------------------------------------------------------------- cliff -----

export const CLIFF_WIDTH = 17;
/** World z of the climbable face (holds sit slightly in front of it). */
export const CLIFF_FACE_Z = WALL_Z + 0.06;

/** Displacement of the rock face toward the player (+z) at a face point. */
function cliffDisplacement(x: number, y: number): number {
  const lx = x - CLIFF_CENTER_X;
  const rough = fbm(lx * 0.45 + 11, y * 0.45, 4) * 0.7 + fbm(lx * 1.8, y * 1.8, 3) * 0.14;
  // Vertical cracks and buttresses give the wall real relief.
  const cracks = Math.abs(valueNoise(lx * 0.9 + 3.3, y * 0.12)) * 0.45;
  const ledges = Math.max(0, Math.sin(y * 1.9 + valueNoise(lx * 0.4, y * 0.3) * 2.5)) * 0.12;
  // Keep the climbing lane gently textured so holds sit cleanly on the face.
  const lane = smoothstep(1.2, 3.0, Math.abs(lx));
  const flare = smoothstep(4, CLIFF_WIDTH / 2, Math.abs(lx)) * 1.1;
  const relief = rough * (0.35 + 0.9 * lane) + (cracks + ledges) * lane;
  return Math.max(0, relief + 0.14 + flare);
}

export function buildCliff(): Group {
  const group = new Group();
  group.name = 'Cliff';
  const bottom = CLIFF_BASE_Y - 1.2;
  const top = SUMMIT_Y + 0.12;
  const height = top - bottom;
  const plane = new PlaneGeometry(CLIFF_WIDTH, height, 96, 56);
  const pos = plane.getAttribute('position');
  for (let v = 0; v < pos.count; v++) {
    const x = pos.getX(v) + CLIFF_CENTER_X;
    const y = pos.getY(v) + bottom + height / 2;
    pos.setXYZ(v, x, y, CLIFF_FACE_Z + cliffDisplacement(x, y));
  }
  plane.computeVertexNormals();
  // The wall fills your whole view while you climb: the lite land shader and
  // no shadow lookups keep those pixels cheap (its relief is in the mesh).
  const face = new Mesh(plane, createLandMaterial({ rockScale: 4.5, snowScale: 1.5, lite: true }));
  face.castShadow = true;
  face.receiveShadow = false;
  face.name = 'CliffFace';
  group.add(face);

  // A snow cornice softens the summit lip.
  const cornice = new Mesh(
    new CylinderGeometry(0.26, 0.26, CLIFF_WIDTH + 1, 16, 1),
    createLandMaterial({ snowScale: 1.2 }),
  );
  cornice.castShadow = true;
  cornice.receiveShadow = true;
  cornice.rotation.z = Math.PI / 2;
  cornice.scale.set(0.55, 1, 1);
  cornice.position.set(CLIFF_CENTER_X, SUMMIT_Y + 0.02, WALL_Z + 0.02);
  group.add(cornice);
  return group;
}

export interface HoldPlacement {
  position: Vector3;
  lip: boolean;
}

/** Hold layout: two staggered columns in the lane plus a pair on the lip. */
export function holdLayout(): HoldPlacement[] {
  const rand = mulberry32(5);
  const holds: HoldPlacement[] = [];
  const start = CLIFF_BASE_Y + 1.15;
  const end = SUMMIT_Y - 0.3;
  let row = 0;
  for (let y = start; y <= end; y += 0.46) {
    const offset = row % 2 === 0 ? 0 : 0.23;
    for (const side of [-1, 1]) {
      const hy = y + (side > 0 ? offset : 0) + (rand() - 0.5) * 0.08;
      if (hy > end + 0.1) continue;
      const hx = CLIFF_CENTER_X + side * (0.3 + rand() * 0.12);
      holds.push({
        position: new Vector3(hx, hy, CLIFF_FACE_Z + cliffDisplacement(hx, hy) + 0.05),
        lip: false,
      });
    }
    row++;
  }
  // A few wider holds to make the wall look natural and allow traversing.
  for (let i = 0; i < 6; i++) {
    const hy = start + 0.3 + rand() * (end - start - 0.5);
    const hx = CLIFF_CENTER_X + (rand() < 0.5 ? -1 : 1) * (0.75 + rand() * 0.4);
    holds.push({
      position: new Vector3(hx, hy, CLIFF_FACE_Z + cliffDisplacement(hx, hy) + 0.05),
      lip: false,
    });
  }
  // The two final jugs sit on top of the snow cornice so they're easy to see.
  for (const side of [-1, 1]) {
    holds.push({
      position: new Vector3(CLIFF_CENTER_X + side * 0.38, SUMMIT_Y + 0.22, WALL_Z + 0.06),
      lip: true,
    });
  }
  return holds;
}

/** A chalk-dusted rock hold; a faint warm glow keeps it findable in the storm. */
export function buildHoldMesh(seed: number): Mesh {
  const geo = new IcosahedronGeometry(0.075, 2);
  const pos = geo.getAttribute('position');
  const nor = geo.getAttribute('normal');
  for (let v = 0; v < pos.count; v++) {
    const x = pos.getX(v);
    const y = pos.getY(v);
    const z = pos.getZ(v);
    const f = 1 + 0.15 * valueNoise(x * 30 + seed, y * 30 + z * 20);
    pos.setXYZ(v, x * f * 1.35, y * f * 0.8, z * f * 0.95);
    const len = Math.hypot(x / 1.35, y / 0.8, z / 0.95);
    nor.setXYZ(v, x / 1.35 / len, y / 0.8 / len, z / 0.95 / len);
  }
  const mesh = new Mesh(
    geo,
    new MeshStandardMaterial({
      color: 0xb8a58e,
      roughness: 0.85,
      emissive: new Color(1, 0.7, 0.4),
      emissiveIntensity: 0.18,
    }),
  );
  mesh.castShadow = true;
  return mesh;
}

// -------------------------------------------------------- trail markers ----

export function buildTrailMarkers(): Mesh {
  const builder = new GeometryBuilder();
  const poleColor = new Color(0.12, 0.12, 0.14);
  const orange = new Color(1, 0.38, 0.08);
  let side = 1;
  for (let s = 5; s < TRAIL_END_S - 1; s += 6) {
    const z = -s;
    const x = pathX(z) + side * 2.5;
    const y = terrainHeight(x, z);
    builder.add(new CylinderGeometry(0.025, 0.03, 1.8, 6), placed(x, y + 0.6, z), poleColor);
    builder.add(new CylinderGeometry(0.032, 0.032, 0.35, 6), placed(x, y + 1.38, z), orange);
    side = -side;
  }
  const mesh = new Mesh(
    builder.build(),
    new MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }),
  );
  mesh.name = 'TrailMarkers';
  return mesh;
}

function makeTextTexture(lines: string[], width: number, height: number, bg: string, fg: string): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);
  // wood grain
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 3;
  for (let y = height / 6; y < height; y += height / 6) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(width * 0.3, y + 6, width * 0.6, y - 6, width, y + 2);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(40,24,10,0.6)';
  ctx.lineWidth = 10;
  ctx.strokeRect(5, 5, width - 10, height - 10);
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const rowHeight = height / lines.length;
  lines.forEach((line, i) => {
    // Shrink each line until it fits inside the board with a margin.
    let size = Math.floor(rowHeight * (i === 0 ? 0.62 : 0.48));
    ctx.font = `700 ${size}px Georgia, 'Times New Roman', serif`;
    while (ctx.measureText(line).width > width * 0.86 && size > 10) {
      size -= 2;
      ctx.font = `700 ${size}px Georgia, 'Times New Roman', serif`;
    }
    ctx.fillText(line, width / 2, rowHeight * (i + 0.55));
  });
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function buildSignBoard(lines: string[], width: number, height: number): Mesh {
  const wood = new MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.9 });
  const face = new MeshStandardMaterial({
    map: makeTextTexture(lines, 1024, Math.round((1024 * height) / width), '#7a5534', '#fff4dc'),
    roughness: 0.8,
  });
  // BoxGeometry material order: +x, -x, +y, -y, +z (front), -z
  return new Mesh(new BoxGeometry(width, height, 0.05), [wood, wood, wood, wood, face, wood]);
}

export function buildTrailSign(): Group {
  const group = new Group();
  group.name = 'TrailSign';
  const x = pathX(-6) + 3.1;
  const z = -6;
  group.position.set(x, terrainHeight(x, z), z);
  group.rotation.y = -0.35;
  const wood = new MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.9 });
  const post = new Mesh(new BoxGeometry(0.1, 1.8, 0.1), wood);
  post.position.y = 0.9;
  group.add(post);
  const board = buildSignBoard(['SUMMIT TRAIL', 'Cliff 70 m  /  Glider launch'], 1.2, 0.5);
  board.position.set(0, 1.5, 0.08);
  group.add(board);
  return group;
}

/** Wooden marker on the summit shoulder, facing the top of the climb. */
export function buildSummitSign(): Group {
  const group = new Group();
  group.name = 'SummitSign';
  const x = CLIFF_CENTER_X - 2.9;
  const z = WALL_Z - 3.7;
  group.position.set(x, terrainHeight(x, z), z);
  group.rotation.y = 0.9; // faces the player standing at the top of the climb
  const wood = new MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.9 });
  const post = new Mesh(new BoxGeometry(0.1, 1.6, 0.1), wood);
  post.position.y = 0.8;
  group.add(post);
  const board = buildSignBoard(['SUMMIT', 'Elevation 2,640 m'], 1.0, 0.42);
  board.position.set(0, 1.35, 0.08);
  group.add(board);
  return group;
}

// --------------------------------------------------------------- cabin -----

/**
 * A snowed-in log cabin: round logs with notched, overhanging corners on a
 * stone footing, log gables under a pitched roof with a thick snow cap and
 * icicles, a stone chimney, a framed door with a lantern, shuttered windows
 * glowing warm, a woodpile and drifts against the walls. Two draws.
 */
export function buildCabin(x: number, z: number, rotY: number): Group {
  const group = new Group();
  group.name = 'Cabin';
  const y = terrainHeight(x, z);
  group.position.set(x, y - 0.1, z);
  group.rotation.y = rotY;
  const rand = mulberry32(Math.round(x * 31 + z * 17));
  const b = new GeometryBuilder();
  const glow = new GeometryBuilder();
  const logTone = (k: number) => new Color(0.42, 0.27, 0.15).multiplyScalar(0.82 + 0.3 * k);
  const logEnd = new Color(0.62, 0.46, 0.3);
  const darkWood = new Color(0.22, 0.14, 0.08);
  const trim = new Color(0.72, 0.62, 0.48);
  const snow = new Color(0.93, 0.96, 1.0);
  const iron = new Color(0.12, 0.12, 0.13);
  const shutter = new Color(0.36, 0.12, 0.1);
  const stoneTone = () => new Color(0.4, 0.39, 0.4).multiplyScalar(0.8 + 0.4 * rand());
  const W = 4.2;
  const D = 3.2;
  const R = 0.14;
  const COURSES = 9;
  const PITCH = 0.27;
  const BASE = 0.3;
  const wallTop = BASE + COURSES * PITCH;
  const alongX = (len: number, px: number, py: number, pz: number, r: number, c: Color) =>
    b.add(new CylinderGeometry(r, r, len, 8), new Matrix4().makeRotationZ(Math.PI / 2).setPosition(px, py, pz), c);
  const alongZ = (len: number, px: number, py: number, pz: number, r: number, c: Color) =>
    b.add(new CylinderGeometry(r, r, len, 8), new Matrix4().makeRotationX(Math.PI / 2).setPosition(px, py, pz), c);

  // Stone footing.
  for (let i = 0; i < 18; i++) {
    const t = i / 18;
    const px = t < 0.5 ? -W / 2 + t * 2 * W : W / 2 - (t - 0.5) * 2 * W;
    const pz = t < 0.5 ? D / 2 - 0.05 : -D / 2 + 0.05;
    b.add(new BoxGeometry(0.5, BASE, 0.32), placed(px, BASE / 2, pz), stoneTone());
  }
  b.add(new BoxGeometry(0.32, BASE, D), placed(-W / 2 + 0.05, BASE / 2, 0), stoneTone());
  b.add(new BoxGeometry(0.32, BASE, D), placed(W / 2 - 0.05, BASE / 2, 0), stoneTone());
  // Log courses: front and back logs, then side logs half a course up, each
  // running past the corners like a notched cabin.
  for (let i = 0; i < COURSES; i++) {
    const yy = BASE + R + i * PITCH;
    for (const sz of [-1, 1]) alongX(W + 0.5, 0, yy, sz * (D / 2 - R), R, logTone(rand()));
    for (const sx of [-1, 1]) alongZ(D + 0.5, sx * (W / 2 - R), yy + PITCH / 2, 0, R, logTone(rand()));
    // Pale sawn ends at the corners.
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        b.add(new CylinderGeometry(R * 0.9, R * 0.9, 0.02, 8), new Matrix4().makeRotationZ(Math.PI / 2).setPosition(sx * (W / 2 + 0.25), yy, sz * (D / 2 - R)), logEnd);
      }
    }
  }
  // Gables front and back: shortening logs up to the ridge.
  const roofPitch = 0.62;
  const ridgeY = wallTop + Math.tan(roofPitch) * (W / 2);
  for (const sz of [-1, 1]) {
    for (let k = 0; ; k++) {
      const yy = wallTop + R + k * PITCH;
      const half = (ridgeY - yy) / Math.tan(roofPitch);
      if (half < 0.3) break;
      alongX(half * 2, 0, yy, sz * (D / 2 - R), R * 0.95, logTone(rand()));
    }
  }
  // Roof: slabs with an overhang, a deep snow cap, a rounded snow lip on the
  // eaves and a ridge cap.
  const slope = (W / 2 + 0.35) / Math.cos(roofPitch);
  for (const side of [-1, 1]) {
    const m = new Matrix4()
      .makeRotationZ(side * -roofPitch)
      .setPosition(side * (slope / 2) * Math.cos(roofPitch), ridgeY - (slope / 2) * Math.sin(roofPitch) + 0.1, 0);
    b.add(new BoxGeometry(slope, 0.16, D + 0.9), m, darkWood);
    b.add(new BoxGeometry(slope + 0.06, 0.24, D + 1.0), m.clone().multiply(new Matrix4().makeTranslation(0, 0.19, 0)), snow);
    const eaveX = side * (W / 2 + 0.35);
    const eaveY = ridgeY - Math.tan(roofPitch) * (W / 2 + 0.35) + 0.22;
    alongZ(D + 1.0, eaveX, eaveY, 0, 0.13, snow);
    // Icicles hanging from the eaves.
    for (let k = 0; k < 9; k++) {
      const len = 0.15 + rand() * 0.45;
      const iz = -D / 2 - 0.4 + (k + rand() * 0.6) * ((D + 0.8) / 9);
      b.add(new ConeGeometry(0.035, len, 5), new Matrix4().makeRotationX(Math.PI).setPosition(eaveX, eaveY - 0.12 - len / 2, iz), new Color(0.8, 0.9, 1.0));
    }
  }
  alongZ(D + 1.0, 0, ridgeY + 0.3, 0, 0.16, snow);
  // Stone chimney through the back of the roof, capped with snow.
  for (let k = 0; k < 7; k++) {
    b.add(new BoxGeometry(0.62 - (k % 2) * 0.04, 0.32, 0.62 - ((k + 1) % 2) * 0.04), placed(1.15, 2.6 + k * 0.32, -0.75), stoneTone());
  }
  b.add(new BoxGeometry(0.72, 0.14, 0.72), placed(1.15, 2.6 + 7 * 0.32 - 0.08, -0.75), snow);
  b.add(new BoxGeometry(0.4, 0.06, 0.4), placed(1.15, 2.6 + 7 * 0.32 - 0.14, -0.75), new Color(0.05, 0.05, 0.05));
  // Door: frame, planks, handle, a step and a lantern.
  const front = D / 2 + 0.01;
  const dx = -0.95;
  b.add(new BoxGeometry(0.95, 1.85, 0.06), placed(dx, BASE + 0.92, front + 0.02), darkWood);
  for (let k = -1; k <= 1; k++) b.add(new BoxGeometry(0.02, 1.8, 0.07), placed(dx + k * 0.26, BASE + 0.92, front + 0.03), new Color(0.15, 0.09, 0.05));
  b.add(new BoxGeometry(0.08, 2.0, 0.1), placed(dx - 0.52, BASE + 0.98, front + 0.04), trim);
  b.add(new BoxGeometry(0.08, 2.0, 0.1), placed(dx + 0.52, BASE + 0.98, front + 0.04), trim);
  b.add(new BoxGeometry(1.12, 0.1, 0.12), placed(dx, BASE + 1.93, front + 0.04), trim);
  b.add(new SphereGeometry(0.035, 6, 4), placed(dx + 0.33, BASE + 0.9, front + 0.08), new Color(0.75, 0.58, 0.25));
  b.add(new BoxGeometry(1.2, 0.16, 0.5), placed(dx, 0.08, front + 0.3), darkWood);
  b.add(new BoxGeometry(1.25, 0.08, 0.52), placed(dx, 0.2, front + 0.3), snow);
  // Lantern by the door.
  b.add(new BoxGeometry(0.04, 0.3, 0.04), placed(dx + 0.7, BASE + 2.0, front + 0.12), iron);
  b.add(new BoxGeometry(0.16, 0.02, 0.16), placed(dx + 0.7, BASE + 1.88, front + 0.2), iron);
  glow.add(new SphereGeometry(0.06, 8, 6), placed(dx + 0.7, BASE + 1.78, front + 0.2), new Color(1, 0.7, 0.35));
  // Windows: frame, cross mullions, a snowy sill, shutters, a warm pane.
  const windowAt = (m: Matrix4) => {
    const at = (px: number, py: number, pz: number) => m.clone().multiply(new Matrix4().makeTranslation(px, py, pz));
    glow.add(new PlaneGeometry(0.66, 0.72), at(0, 0, 0.005), new Color(1, 0.72, 0.38));
    b.add(new BoxGeometry(0.8, 0.07, 0.08), at(0, 0.39, 0.03), trim);
    b.add(new BoxGeometry(0.8, 0.07, 0.08), at(0, -0.39, 0.03), trim);
    b.add(new BoxGeometry(0.07, 0.84, 0.08), at(-0.37, 0, 0.03), trim);
    b.add(new BoxGeometry(0.07, 0.84, 0.08), at(0.37, 0, 0.03), trim);
    b.add(new BoxGeometry(0.04, 0.72, 0.05), at(0, 0, 0.03), trim);
    b.add(new BoxGeometry(0.66, 0.04, 0.05), at(0, 0, 0.03), trim);
    b.add(new BoxGeometry(0.92, 0.07, 0.2), at(0, -0.45, 0.08), snow);
    for (const side of [-1, 1]) b.add(new BoxGeometry(0.34, 0.86, 0.05), at(side * 0.6, 0, 0.04), shutter);
  };
  windowAt(new Matrix4().makeTranslation(1.0, BASE + 1.35, front));
  windowAt(new Matrix4().makeRotationY(Math.PI / 2).setPosition(W / 2 + 0.01, BASE + 1.35, 0.1));
  windowAt(new Matrix4().makeRotationY(-Math.PI / 2).setPosition(-W / 2 - 0.01, BASE + 1.35, 0.6));
  // Woodpile against the left wall.
  for (let row = 0; row < 3; row++) {
    for (let k = 0; k < 6 - row; k++) {
      const pz = -1.2 + (k + row * 0.5) * 0.26;
      alongX(0.6, -W / 2 - 0.45, 0.12 + row * 0.22, pz, 0.11, logTone(rand()));
      b.add(new CylinderGeometry(0.1, 0.1, 0.02, 8), new Matrix4().makeRotationZ(Math.PI / 2).setPosition(-W / 2 - 0.76, 0.12 + row * 0.22, pz), logEnd);
    }
  }
  b.add(new BoxGeometry(0.66, 0.08, 1.5), placed(-W / 2 - 0.45, 0.72, -0.6), snow);
  // Drifts banked against the walls.
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2;
    const r = 1 + 0.4 * rand();
    const px = Math.cos(a) * (W / 2 + 0.2);
    const pz = Math.sin(a) * (D / 2 + 0.2);
    if (pz > D / 2 && Math.abs(px - dx) < 0.9) continue; // keep the door clear
    b.add(new SphereGeometry(0.7, 10, 6), new Matrix4().makeScale(r * 1.4, 0.45, r).setPosition(px, 0.02, pz), snow);
  }
  const body = new Mesh(b.build(), new MeshStandardMaterial({ vertexColors: true, roughness: 0.88 }));
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);
  const lights = new Mesh(glow.build(), new MeshBasicMaterial({ vertexColors: true, toneMapped: false }));
  lights.name = 'CabinWindows';
  group.add(lights);
  return group;
}

// ---------------------------------------------------------------- lake -----

export function buildLake(): Mesh {
  const iceMaterial = new MeshStandardMaterial({
    color: new Color(0.62, 0.78, 0.9),
    roughness: 0.12,
    metalness: 0.15,
  });
  applyFireGlow(iceMaterial);
  const lake = new Mesh(new CircleGeometry(1, 72), iceMaterial);
  lake.rotation.x = -Math.PI / 2;
  lake.scale.set(LAKE_RADIUS_X * 0.88, LAKE_RADIUS_Z * 0.88, 1);
  lake.position.set(LAKE_CENTER_X, LAKE_Y, LAKE_CENTER_Z);
  lake.name = 'FrozenLake';
  lake.receiveShadow = true;
  return lake;
}

// ------------------------------------------------------------- summit ------

export function buildSummitFlag(): { group: Group; cloth: Mesh } {
  const group = new Group();
  group.name = 'SummitFlag';
  const x = CLIFF_CENTER_X + 3.2;
  const z = WALL_Z - 3.5;
  group.position.set(x, terrainHeight(x, z), z);
  const pole = new Mesh(
    new CylinderGeometry(0.03, 0.035, 3, 8),
    new MeshStandardMaterial({ color: 0xd8dde6, metalness: 0.6, roughness: 0.35 }),
  );
  pole.position.y = 1.5;
  group.add(pole);
  const cloth = new Mesh(
    new PlaneGeometry(1.1, 0.7, 12, 4),
    new MeshStandardMaterial({ color: 0xe8432e, side: DoubleSide, roughness: 0.7 }),
  );
  cloth.geometry.translate(0.55, 0, 0);
  cloth.position.set(0.03, 2.6, 0);
  group.add(cloth);
  return { group, cloth };
}

/** Wobble the flag cloth; call every frame. */
export function waveFlag(cloth: Mesh, time: number): void {
  const pos = cloth.geometry.getAttribute('position');
  for (let v = 0; v < pos.count; v++) {
    const x = pos.getX(v);
    const y = pos.getY(v);
    pos.setZ(v, Math.sin(x * 5 - time * 6 + y * 1.5) * 0.08 * x);
  }
  pos.needsUpdate = true;
}

/** Summit assembly area, positioned at the kit root (floor level). */
export function buildWorkbench(position: Vector3): Group {
  const group = new Group();
  group.name = 'Workbench';
  group.position.copy(position);
  const builder = new GeometryBuilder();
  const wood = new Color(0.55, 0.37, 0.21);
  const woodDark = new Color(0.38, 0.25, 0.14);
  const snow = new Color(0.95, 0.97, 1);
  const crate = (x: number, z: number, size: number, color: Color) => {
    builder.add(new BoxGeometry(size, size, size), placed(x, size / 2, z), color);
    // slats
    builder.add(new BoxGeometry(size + 0.02, 0.05, size + 0.02), placed(x, size * 0.3, z), woodDark);
    builder.add(new BoxGeometry(size + 0.02, 0.05, size + 0.02), placed(x, size * 0.75, z), woodDark);
    builder.add(new BoxGeometry(size * 0.9, 0.04, size * 0.9), placed(x, size + 0.02, z), snow);
  };
  // crates either side of the player hold the wings, a small one the bar
  crate(-WING_CRATE_X, WING_CRATE_Z, 0.66, wood);
  crate(WING_CRATE_X, WING_CRATE_Z, 0.66, wood);
  crate(BAR_CRATE_X, BAR_CRATE_Z, 0.42, woodDark);
  // a sturdy stand that supports the glider keel
  builder.add(new CylinderGeometry(0.04, 0.05, KIT_KEEL_HEIGHT, 8), placed(0, KIT_KEEL_HEIGHT / 2, 0), woodDark);
  builder.add(new BoxGeometry(0.6, 0.06, 0.08), placed(0, 0.03, 0), woodDark);
  builder.add(new BoxGeometry(0.08, 0.06, 0.6), placed(0, 0.03, 0), woodDark);
  builder.add(new BoxGeometry(0.22, 0.05, 0.12), placed(0, KIT_KEEL_HEIGHT, 0), wood);
  const mesh = new Mesh(
    builder.build(),
    new MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true }),
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return group;
}

/** Layout of the summit assembly area relative to the kit root. */
export const KIT_KEEL_HEIGHT = 1.2;
export const WING_CRATE_X = 1.6;
export const WING_CRATE_Z = 1.05;
export const BAR_CRATE_X = -0.85;
export const BAR_CRATE_Z = 0.75;

// ----------------------------------------------------------- walking pole --

/** A trekking pole with its long axis along local +Z (grip at the origin). */
export function buildPole(): Mesh {
  const builder = new GeometryBuilder();
  const shaft = new Color(0.2, 0.42, 0.78);
  const lower = new Color(0.72, 0.74, 0.78);
  const cork = new Color(0.55, 0.38, 0.22);
  const rubber = new Color(0.08, 0.08, 0.09);
  const toZ = new Matrix4().makeRotationX(Math.PI / 2);
  const along = (z: number) => new Matrix4().makeTranslation(0, 0, z).multiply(toZ);
  builder.add(new CylinderGeometry(0.021, 0.019, 0.16, 10), along(0), cork);
  builder.add(new CylinderGeometry(0.025, 0.025, 0.02, 10), along(-0.085), rubber);
  builder.add(new CylinderGeometry(0.011, 0.011, 0.62, 8), along(0.39), shaft);
  builder.add(new CylinderGeometry(0.008, 0.008, 0.5, 8), along(0.94), lower);
  builder.add(new CylinderGeometry(0.045, 0.045, 0.012, 14), along(1.08), rubber);
  builder.add(new ConeGeometry(0.008, 0.05, 6), along(1.2), rubber);
  // wrist strap loop
  const strap = new TorusGeometry(0.04, 0.006, 6, 14);
  builder.add(strap, new Matrix4().makeRotationY(Math.PI / 2).setPosition(0, 0.03, -0.06), rubber);
  const mesh = new Mesh(
    builder.build(),
    new MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.35 }),
  );
  mesh.name = 'WalkingPole';
  return mesh;
}

/** Length from the grip (origin) to the tip of the pole. */
export const POLE_TIP_DISTANCE = 1.22;

/** White sphere around the head used for comfortable scene transitions. */
export function buildFadeSphere(): Mesh {
  const mesh = new Mesh(
    new SphereGeometry(0.4, 16, 12),
    new MeshBasicMaterial({
      color: 0xf5f8ff,
      side: BackSide,
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
      fog: false,
    }),
  );
  mesh.renderOrder = 10000;
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.name = 'FadeSphere';
  return mesh;
}
