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
import { GeometryBuilder, identity, placed, segmentMatrix } from './mesh-utils.js';
import {
  CLIFF_BASE_Y,
  CLIFF_CENTER_X,
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
  valueNoise,
  WALL_S,
  WALL_Z,
} from './terrain.js';

/** Direction the sunlight comes from (low, golden, over the valley). */
export const SUN_DIRECTION = new Vector3(-0.38, 0.27, 0.88).normalize();
export const FOG_COLOR = new Color(0.78, 0.8, 0.9);

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
  const indices = new Uint32Array((nx - 1) * (nz - 1) * 6);
  let t = 0;
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      // counter-clockwise when seen from above (+Y)
      indices[t++] = a;
      indices[t++] = c;
      indices[t++] = b;
      indices[t++] = b;
      indices[t++] = c;
      indices[t++] = d;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(new Uint32BufferAttribute(indices, 1));
  geometry.computeVertexNormals();

  const normals = geometry.getAttribute('normal');
  const colors = new Float32Array(nx * nz * 3);
  const snow = new Color(0.88, 0.91, 0.98);
  const snowShade = new Color(0.7, 0.78, 0.94);
  const packed = new Color(0.72, 0.77, 0.9);
  const rock = new Color(0.27, 0.26, 0.3);
  const rockWarm = new Color(0.46, 0.4, 0.38);
  const c = new Color();
  const r = new Color();
  for (let v = 0; v < nx * nz; v++) {
    const x = positions[v * 3];
    const y = positions[v * 3 + 1];
    const z = positions[v * 3 + 2];
    const ny = normals.getY(v);
    const n = fbm(x * 0.07, z * 0.07, 3);
    c.copy(snow).lerp(snowShade, 0.25 + 0.35 * n);
    // A slightly packed, bluish path so the trail reads from a distance.
    const s = -z;
    const d = Math.abs(x - pathX(z));
    if (s > -6 && s < WALL_S + 0.5) {
      c.lerp(packed, 0.6 * (1 - smoothstep(0.6, 2.2, d)));
    }
    // Exposed rock on steep faces and high on the peak.
    const steep = smoothstep(0.8, 0.58, ny) + smoothstep(55, 95, y) * smoothstep(0.92, 0.75, ny);
    if (steep > 0) {
      r.copy(rock).lerp(rockWarm, 0.5 + 0.5 * valueNoise(x * 0.3, y * 0.5));
      c.lerp(r, Math.min(1, steep));
    }
    colors[v * 3] = c.r;
    colors[v * 3 + 1] = c.g;
    colors[v * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();

  const mesh = new Mesh(
    geometry,
    new MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 }),
  );
  mesh.name = 'Terrain';
  return mesh;
}

// ------------------------------------------------------- distant peaks -----

export function buildDistantPeaks(): Mesh {
  const rand = mulberry32(7);
  const builder = new GeometryBuilder();
  const snow = new Color(0.93, 0.95, 1);
  const rock = new Color(0.36, 0.4, 0.5);
  const count = 30;
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + rand() * 0.15;
    const radius = 470 + rand() * 180;
    const height = 140 + rand() * 210;
    const base = 120 + rand() * 120;
    const cx = Math.sin(angle) * radius;
    const cz = -40 + Math.cos(angle) * radius;
    const cone = new ConeGeometry(base, height, 9, 6);
    const pos = cone.getAttribute('position');
    const seed = rand() * 100;
    for (let v = 0; v < pos.count; v++) {
      const px = pos.getX(v);
      const py = pos.getY(v);
      const pz = pos.getZ(v);
      const f = 1 + 0.28 * valueNoise(px * 0.02 + seed, pz * 0.02 + py * 0.02);
      pos.setXYZ(v, px * f, py, pz * f);
    }
    const snowLine = 0.15 + rand() * 0.25;
    builder.add(cone, placed(cx, height / 2 - 30, cz, rand() * 6), (p, n, out) => {
      const h = (p.y + 30) / height;
      const t = smoothstep(snowLine - 0.08, snowLine + 0.1, h + n.y * 0.25);
      out.copy(rock).lerp(snow, t);
    });
  }
  const material = new MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 1,
  });
  const mesh = new Mesh(builder.build(), material);
  mesh.name = 'DistantPeaks';
  return mesh;
}

// --------------------------------------------------------------- trees -----

function buildTreeGeometry(): BufferGeometry {
  const builder = new GeometryBuilder();
  const trunk = new Color(0.33, 0.22, 0.14);
  const needles = new Color(0.1, 0.24, 0.18);
  const needlesDark = new Color(0.06, 0.16, 0.13);
  const snow = new Color(0.95, 0.97, 1);
  builder.add(new CylinderGeometry(0.12, 0.18, 1.4, 6), placed(0, 0.7, 0), trunk);
  const tiers = [
    { y: 1.0, r: 1.5, h: 2.2 },
    { y: 2.1, r: 1.15, h: 1.9 },
    { y: 3.1, r: 0.8, h: 1.6 },
    { y: 4.0, r: 0.45, h: 1.2 },
  ];
  for (const tier of tiers) {
    const cone = new ConeGeometry(tier.r, tier.h, 8, 2);
    builder.add(cone, placed(0, tier.y + tier.h / 2, 0), (p, n, out) => {
      const local = (p.y - tier.y) / tier.h;
      const flake = valueNoise(p.x * 6 + tier.y, p.z * 6) * 0.25;
      const snowy = smoothstep(0.32, 0.62, local + flake + n.y * 0.2);
      out.copy(needlesDark).lerp(needles, local).lerp(snow, snowy * 0.9);
    });
  }
  return builder.build();
}

export function buildForest(): InstancedMesh {
  const rand = mulberry32(42);
  const matrices: Matrix4[] = [];
  const tints: Color[] = [];
  const q = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const pos = new Vector3();
  const scale = new Vector3();
  let attempts = 0;
  while (matrices.length < 900 && attempts < 30000) {
    attempts++;
    // Bias sampling toward the play area so the trail feels forested.
    const nearTrail = rand() < 0.35;
    const x = nearTrail ? (rand() * 2 - 1) * 45 : (rand() * 2 - 1) * 230;
    const z = nearTrail ? 30 - rand() * 95 : 240 - rand() * 430;
    const y = terrainHeight(x, z);
    const s = -z;
    const d = Math.abs(x - pathX(z));
    if (y > 17.5 + valueNoise(x * 0.05, z * 0.05) * 3) continue; // tree line
    if (terrainSlope(x, z) > 0.85) continue;
    if (s > -12 && s < WALL_S + 6 && d < 7.5) continue; // keep the trail open
    if (s > -14 && s < 25 && d < 11) continue; // open view up the trail from the start
    if (Math.hypot(x, z) < 12) continue; // start area
    if (Math.hypot(x + 9, z - 4) < 6) continue; // base camp cabin
    const lx = (x - LAKE_CENTER_X) / LAKE_RADIUS_X;
    const lz = (z - LAKE_CENTER_Z) / LAKE_RADIUS_Z;
    if (lx * lx + lz * lz < 1.3) continue;
    if (s > 60 && s < 95 && d < 14) continue; // cliff + summit
    const size = 0.75 + rand() * 0.95;
    pos.set(x, y - 0.15, z);
    q.setFromAxisAngle(up, rand() * Math.PI * 2);
    scale.set(size * (0.85 + rand() * 0.3), size, size * (0.85 + rand() * 0.3));
    matrices.push(new Matrix4().compose(pos, q, scale));
    const shade = 0.8 + rand() * 0.25;
    tints.push(new Color(shade, shade + rand() * 0.05, shade));
  }
  const mesh = new InstancedMesh(
    buildTreeGeometry(),
    new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95 }),
    matrices.length,
  );
  matrices.forEach((m, i) => {
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, tints[i]);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.name = 'Forest';
  return mesh;
}

// --------------------------------------------------------------- rocks -----

function buildRockGeometry(seed: number): BufferGeometry {
  const geo = new DodecahedronGeometry(1, 1);
  const pos = geo.getAttribute('position');
  for (let v = 0; v < pos.count; v++) {
    const x = pos.getX(v);
    const y = pos.getY(v);
    const z = pos.getZ(v);
    const f = 1 + 0.22 * valueNoise(x * 2.1 + seed, z * 2.1 + y * 1.7);
    pos.setXYZ(v, x * f, y * f * 0.75, z * f);
  }
  geo.computeVertexNormals();
  const builder = new GeometryBuilder();
  const rock = new Color(0.33, 0.32, 0.35);
  const snow = new Color(0.93, 0.95, 1);
  builder.add(geo, identity(), (p, n, out) => {
    out.copy(rock).lerp(snow, smoothstep(0.35, 0.7, n.y + p.y * 0.2));
  });
  return builder.build();
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
    new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95 }),
    placements.length,
  );
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
  const rough = fbm(lx * 0.45 + 11, y * 0.45, 4) * 0.7 + fbm(lx * 1.8, y * 1.8, 2) * 0.12;
  // Keep the climbing lane nearly flat so holds sit cleanly on the face.
  const lane = smoothstep(1.3, 3.2, Math.abs(lx));
  const flare = smoothstep(4, CLIFF_WIDTH / 2, Math.abs(lx)) * 0.9;
  return Math.max(0, rough * (0.3 + 0.7 * lane) + 0.12 + flare);
}

export function buildCliff(): Group {
  const group = new Group();
  group.name = 'Cliff';
  const bottom = CLIFF_BASE_Y - 1.2;
  const top = SUMMIT_Y + 0.12;
  const height = top - bottom;
  const plane = new PlaneGeometry(CLIFF_WIDTH, height, 68, 40);
  const pos = plane.getAttribute('position');
  for (let v = 0; v < pos.count; v++) {
    const x = pos.getX(v) + CLIFF_CENTER_X;
    const y = pos.getY(v) + bottom + height / 2;
    pos.setXYZ(v, x, y, CLIFF_FACE_Z + cliffDisplacement(x, y));
  }
  plane.computeVertexNormals();
  const builder = new GeometryBuilder();
  const rockDark = new Color(0.16, 0.15, 0.18);
  const rockLight = new Color(0.42, 0.36, 0.33);
  const snow = new Color(0.93, 0.95, 1);
  builder.add(plane, identity(), (p, n, out) => {
    const streak = valueNoise(p.x * 1.4, p.y * 0.25) * 0.5 + 0.5;
    const grain = valueNoise(p.x * 9, p.y * 9) * 0.5 + 0.5;
    out.copy(rockDark).lerp(rockLight, streak * 0.75 + grain * 0.25);
    out.lerp(snow, smoothstep(0.25, 0.6, n.y) * 0.9);
  });
  const face = new Mesh(
    builder.build(),
    new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 }),
  );
  face.name = 'CliffFace';
  group.add(face);

  // A snow cornice softens the summit lip.
  const cornice = new Mesh(
    new CylinderGeometry(0.26, 0.26, CLIFF_WIDTH + 1, 12, 1),
    new MeshStandardMaterial({ color: 0xf2f5fc, roughness: 0.85 }),
  );
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
  for (const side of [-1, 1]) {
    holds.push({
      position: new Vector3(CLIFF_CENTER_X + side * 0.38, SUMMIT_Y + 0.08, WALL_Z - 0.12),
      lip: true,
    });
  }
  return holds;
}

export function buildHoldMesh(seed: number): Mesh {
  const geo = new IcosahedronGeometry(0.075, 1);
  const pos = geo.getAttribute('position');
  for (let v = 0; v < pos.count; v++) {
    const x = pos.getX(v);
    const y = pos.getY(v);
    const z = pos.getZ(v);
    const f = 1 + 0.18 * valueNoise(x * 30 + seed, y * 30 + z * 20);
    pos.setXYZ(v, x * f * 1.35, y * f * 0.8, z * f * 0.95);
  }
  geo.computeVertexNormals();
  const mesh = new Mesh(
    geo,
    new MeshStandardMaterial({
      color: 0xc99a62,
      roughness: 0.75,
      flatShading: true,
      emissive: new Color(1, 0.62, 0.25),
      emissiveIntensity: 0.18,
    }),
  );
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

export function buildCabin(x: number, z: number, rotY: number): Group {
  const group = new Group();
  group.name = 'Cabin';
  const y = terrainHeight(x, z);
  group.position.set(x, y - 0.1, z);
  group.rotation.y = rotY;
  const builder = new GeometryBuilder();
  const log = new Color(0.45, 0.28, 0.16);
  const logDark = new Color(0.33, 0.2, 0.11);
  const snow = new Color(0.95, 0.97, 1);
  const stone = new Color(0.45, 0.44, 0.46);
  // stacked logs
  for (let i = 0; i < 9; i++) {
    const c = i % 2 === 0 ? log : logDark;
    builder.add(new BoxGeometry(4.2, 0.26, 3.2), placed(0, 0.13 + i * 0.26, 0), c);
  }
  // roof: two slabs, each with a snow layer offset along the slab normal
  const roofPitch = 0.62;
  for (const side of [-1, 1]) {
    const m = new Matrix4()
      .makeRotationZ(side * -roofPitch)
      .setPosition(side * 1.15, 2.95, 0);
    builder.add(new BoxGeometry(2.75, 0.18, 3.9), m, logDark);
    const ms = m.clone().multiply(new Matrix4().makeTranslation(-side * 0.02, 0.15, 0));
    builder.add(new BoxGeometry(2.85, 0.12, 4.0), ms, snow);
  }
  // gable fill
  builder.add(new BoxGeometry(3.4, 0.9, 3.0), placed(0, 2.6, 0), log);
  // chimney
  builder.add(new BoxGeometry(0.5, 1.6, 0.5), placed(1.2, 3.4, -0.6), stone);
  builder.add(new BoxGeometry(0.6, 0.12, 0.6), placed(1.2, 4.26, -0.6), snow);
  // door
  builder.add(new BoxGeometry(0.8, 1.6, 0.08), placed(-0.9, 0.95, 1.64), logDark);
  // snow drift around the base
  builder.add(new BoxGeometry(4.7, 0.2, 3.7), placed(0, 0.03, 0), snow);
  const body = new Mesh(
    builder.build(),
    new MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true }),
  );
  group.add(body);

  const glow = new MeshBasicMaterial({ color: new Color(1.0, 0.72, 0.36) });
  for (const wx of [0.7, 1.55]) {
    const win = new Mesh(new PlaneGeometry(0.55, 0.6), glow);
    win.position.set(wx, 1.35, 1.65);
    group.add(win);
  }
  const sideWin = new Mesh(new PlaneGeometry(0.6, 0.6), glow);
  sideWin.position.set(2.14, 1.35, 0);
  sideWin.rotation.y = Math.PI / 2;
  group.add(sideWin);
  return group;
}

// ---------------------------------------------------------------- lake -----

export function buildLake(): Mesh {
  const lake = new Mesh(
    new CircleGeometry(1, 72),
    new MeshStandardMaterial({
      color: new Color(0.62, 0.78, 0.9),
      roughness: 0.12,
      metalness: 0.15,
    }),
  );
  lake.rotation.x = -Math.PI / 2;
  lake.scale.set(LAKE_RADIUS_X * 0.88, LAKE_RADIUS_Z * 0.88, 1);
  lake.position.set(LAKE_CENTER_X, LAKE_Y, LAKE_CENTER_Z);
  lake.name = 'FrozenLake';
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

// ------------------------------------------------------------- sky bits ----

export function buildSun(): Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, 'rgba(255,250,235,1)');
  g.addColorStop(0.12, 'rgba(255,236,190,0.95)');
  g.addColorStop(0.3, 'rgba(255,190,130,0.35)');
  g.addColorStop(1, 'rgba(255,160,110,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const sprite = new Sprite(
    new SpriteMaterial({
      map: texture,
      blending: AdditiveBlending,
      depthWrite: false,
      fog: false,
      transparent: true,
    }),
  );
  sprite.scale.setScalar(220);
  sprite.position.copy(SUN_DIRECTION).multiplyScalar(900);
  sprite.name = 'Sun';
  return sprite;
}

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
