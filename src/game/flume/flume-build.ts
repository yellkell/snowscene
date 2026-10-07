/**
 * The Needle on the summit shoulder (the rock column the ice cave runs up
 * inside), the mine portal at its foot, the beacon deck on top and the log
 * flume spiralling down around it, hung with hazards to lean past.
 */

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  RepeatWrapping,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
} from '@iwsdk/core';
import { plankTexture } from '../cave/cave-build.js';
import { createLandMaterial } from '../land-material.js';
import { GeometryBuilder, placed, segmentMatrix } from '../mesh-utils.js';
import { fbm, terrainHeight, valueNoise } from '../terrain.js';
import {
  FlumePath,
  flumePath,
  type Hazard,
  INNER_LIP,
  LANE_X,
  NEEDLE,
  needleRadius,
  OUTER_LIP,
  TRACK_WIDTH,
} from './flume-path.js';

const WOOD = new Color(0.5, 0.33, 0.19);
const WOOD_DARK = new Color(0.3, 0.2, 0.12);
const IRON = new Color(0.16, 0.16, 0.17);
const ICE = new Color(0.78, 0.9, 1.0);

const box = (b: GeometryBuilder, w: number, h: number, d: number, m: Matrix4, color: Color) =>
  b.add(new BoxGeometry(w, h, d), m, color);
const rod = (b: GeometryBuilder, a: Vector3, c: Vector3, r: number, color: Color, sides = 6) =>
  b.add(new CylinderGeometry(r, r, 1, sides), segmentMatrix(a, c, new Matrix4()), color);

/** The rock column, its snowcap and the timber deck on top. */
function buildNeedle(): Group {
  const group = new Group();
  group.name = 'Needle';
  const rings = 48;
  const segs = 64;
  const positions: number[] = [];
  for (let j = 0; j <= rings; j++) {
    const y = NEEDLE.base + ((NEEDLE.top - 0.2 - NEEDLE.base) * j) / rings;
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const r =
        needleRadius(y) *
        (1 + fbm(Math.cos(a) * 2 + 5, y * 0.12, 4) * 0.16 + valueNoise(a * 6, y * 0.6) * 0.035);
      positions.push(NEEDLE.x + Math.cos(a) * r, y, NEEDLE.z + Math.sin(a) * r);
    }
  }
  const indices: number[] = [];
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < segs; i++) {
      const a = j * (segs + 1) + i;
      const b = a + segs + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  // Rounded snowy cap.
  const cap = positions.length / 3;
  positions.push(NEEDLE.x, NEEDLE.top + 0.25, NEEDLE.z);
  const last = rings * (segs + 1);
  for (let i = 0; i < segs; i++) indices.push(cap, last + i + 1, last + i);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const rock = new Mesh(geometry, createLandMaterial({ rockScale: 4.5, snowScale: 1.5 }));
  rock.name = 'NeedleRock';
  rock.castShadow = true;
  rock.receiveShadow = true;
  group.add(rock);

  // The beacon deck: a ring of planks on the summit of the needle.
  const b = new GeometryBuilder();
  const deckY = NEEDLE.top + 0.05;
  for (let k = 0; k < 18; k++) {
    const a = (k / 18) * Math.PI * 2;
    const m = new Matrix4().makeRotationY(-a).setPosition(NEEDLE.x + Math.cos(a) * 2.6, deckY - 0.06, NEEDLE.z + Math.sin(a) * 2.6);
    box(b, 4.4, 0.1, 0.62, m, k % 2 ? WOOD : WOOD_DARK);
  }
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    const p = new Vector3(NEEDLE.x + Math.cos(a) * 4.6, deckY, NEEDLE.z + Math.sin(a) * 4.6);
    rod(b, p, p.clone().setY(deckY + 1.0), 0.05, WOOD_DARK);
  }
  // The beacon's iron basket on a tall tripod.
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    rod(b, new Vector3(NEEDLE.x + Math.cos(a) * 1.1, deckY, NEEDLE.z + Math.sin(a) * 1.1), new Vector3(NEEDLE.x, deckY + 2.4, NEEDLE.z), 0.07, IRON);
  }
  b.add(new CylinderGeometry(0.9, 0.5, 0.6, 12, 1, true), placed(NEEDLE.x, deckY + 2.5, NEEDLE.z), IRON);
  const deck = new Mesh(b.build(), new MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true }));
  deck.castShadow = true;
  group.add(deck);
  return group;
}

/** A timbered mine adit in the needle's south face. */
function buildPortal(): Group {
  const group = new Group();
  group.name = 'CavePortal';
  const r = needleRadius(NEEDLE.base + 3) * 0.93;
  const x = NEEDLE.x;
  const z = NEEDLE.z + r;
  const y = terrainHeight(x, z);
  const b = new GeometryBuilder();
  for (const s of [-1, 1]) box(b, 0.3, 3.1, 0.3, placed(x + s * 1.25, y + 1.55, z + 0.15), WOOD_DARK);
  box(b, 3.2, 0.36, 0.4, placed(x, y + 3.2, z + 0.15), WOOD_DARK);
  box(b, 3.4, 0.14, 0.6, placed(x, y + 3.44, z + 0.15), WOOD);
  // A weathered sign board: THE OLD TIMBER WORKS.
  box(b, 1.9, 0.42, 0.06, placed(x, y + 3.75, z + 0.4), WOOD);
  // Rails running in, and a lantern.
  for (const s of [-1, 1]) box(b, 0.06, 0.06, 3.2, placed(x + s * 0.4, y + 0.03, z + 1.2), IRON);
  for (let k = 0; k < 6; k++) box(b, 1.1, 0.06, 0.16, placed(x, y + 0.01, z + 0.2 + k * 0.55), WOOD_DARK);
  b.add(new SphereGeometry(0.09, 8, 6), placed(x + 1.0, y + 2.6, z + 0.45), new Color(3, 1.9, 0.8));
  const timbers = new Mesh(b.build(), new MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true }));
  timbers.castShadow = true;
  group.add(timbers);
  // The dark mouth.
  const mouth = new Mesh(new PlaneGeometry(2.2, 3.0), new MeshBasicMaterial({ color: 0x07090c }));
  mouth.position.set(x, y + 1.5, z + 0.02);
  group.add(mouth);
  // Sign lettering.
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 56;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#6b4a2c';
  ctx.fillRect(0, 0, 256, 56);
  ctx.fillStyle = '#f1e2c4';
  ctx.font = '700 24px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.fillText('OLD TIMBER WORKS', 128, 36);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  const sign = new Mesh(new PlaneGeometry(1.84, 0.38), new MeshStandardMaterial({ map: tex, roughness: 0.9 }));
  sign.position.set(x, y + 3.75, z + 0.44);
  group.add(sign);
  return group;
}

/** The flume trough: bed, lips and the timber that carries it. */
function buildTrough(): Mesh {
  const path = flumePath;
  const sample = FlumePath.makeSample();
  const half = TRACK_WIDTH / 2;
  // Cross-section, (lateral, height): outer lip down, across the bed, inner lip up.
  const profile: [number, number][] = [
    [-half - 0.08, OUTER_LIP],
    [-half, OUTER_LIP],
    [-half, 0],
    [half, 0],
    [half, INNER_LIP],
    [half + 0.08, INNER_LIP],
    [half + 0.08, -0.16],
    [-half - 0.08, -0.16],
  ];
  const step = 0.5;
  const rows = Math.ceil(path.totalLength / step) + 1;
  const cols = profile.length + 1;
  const positions = new Float32Array(rows * cols * 3);
  const uvs = new Float32Array(rows * cols * 2);
  const colors = new Float32Array(rows * cols * 3);
  for (let r = 0; r < rows; r++) {
    const s = Math.min(path.totalLength, r * step);
    path.sample(s, sample);
    for (let c = 0; c < cols; c++) {
      const [lat, h] = profile[c % profile.length];
      const k = (r * cols + c) * 3;
      positions[k] = sample.position.x + sample.right.x * lat;
      positions[k + 1] = sample.position.y + h;
      positions[k + 2] = sample.position.z + sample.right.z * lat;
      uvs[(r * cols + c) * 2] = c / 3;
      uvs[(r * cols + c) * 2 + 1] = s / 1.5;
      // The bed is glazed with ice; the walls are bare boards.
      const bed = c === 2 || c === 3;
      const col = bed ? ICE : new Color(1, 1, 1);
      colors[k] = col.r;
      colors[k + 1] = col.g;
      colors[k + 2] = col.b;
    }
  }
  const indices: number[] = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + cols;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const texture = plankTexture();
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  const mesh = new Mesh(
    geometry,
    new MeshStandardMaterial({ map: texture, vertexColors: true, roughness: 0.55, side: DoubleSide }),
  );
  mesh.name = 'FlumeTrough';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Cantilever beams into the rock and posts down to the snow. */
function buildSupports(): Mesh {
  const b = new GeometryBuilder();
  const sample = FlumePath.makeSample();
  const half = TRACK_WIDTH / 2;
  for (let s = 1; s < flumePath.totalLength; s += 3.2) {
    flumePath.sample(s, sample);
    const p = sample.position;
    const inward = new Vector3(NEEDLE.x - p.x, 0, NEEDLE.z - p.z).normalize();
    const y = p.y - 0.2;
    const rock = needleRadius(y) * 0.92;
    const inner = new Vector3(NEEDLE.x - inward.x * rock, y, NEEDLE.z - inward.z * rock);
    const outer = p.clone().addScaledVector(inward, -(half + 0.25)).setY(y);
    rod(b, inner, outer, 0.09, WOOD_DARK, 4);
    // Raking strut back to the rock below.
    const below = new Vector3(NEEDLE.x - inward.x * needleRadius(y - 2.2) * 0.92, y - 2.2, NEEDLE.z - inward.z * needleRadius(y - 2.2) * 0.92);
    rod(b, outer.clone().addScaledVector(inward, 0.5), below, 0.06, WOOD_DARK, 4);
    // Outer post to the ground on the lower turns.
    const ground = terrainHeight(outer.x, outer.z);
    if (y - ground < 14) rod(b, outer, outer.clone().setY(ground - 0.3), 0.08, WOOD_DARK, 4);
  }
  const mesh = new Mesh(b.build(), new MeshStandardMaterial({ vertexColors: true, roughness: 0.92, flatShading: true }));
  mesh.name = 'FlumeSupports';
  mesh.castShadow = true;
  return mesh;
}

/** Overhead gantries across the flume with their hanging hazards. */
function buildHazards(hazards: Hazard[]): Mesh {
  const b = new GeometryBuilder();
  const sample = FlumePath.makeSample();
  const half = TRACK_WIDTH / 2;
  const done = new Set<number>();
  for (const hz of hazards) {
    flumePath.sample(hz.s, sample);
    const p = sample.position;
    const r = sample.right;
    const frame = new Matrix4().makeRotationY(sample.yaw);
    const at = (lat: number, h: number) => new Vector3(p.x + r.x * lat, p.y + h, p.z + r.z * lat);
    if (!done.has(hz.s)) {
      done.add(hz.s);
      rod(b, at(-half - 0.15, 0), at(-half - 0.15, 2.7), 0.07, WOOD_DARK, 4);
      rod(b, at(half + 0.15, 0), at(half + 0.15, 2.7), 0.07, WOOD_DARK, 4);
      rod(b, at(-half - 0.3, 2.7), at(half + 0.3, 2.7), 0.09, WOOD_DARK, 4);
    }
    const lat = LANE_X[hz.lane];
    const top = at(lat, 2.65);
    if (hz.kind === 'board') {
      rod(b, top, at(lat, 2.25), 0.015, IRON);
      box(b, 0.46, 1.15, 0.07, frame.clone().setPosition(at(lat, 1.65)), WOOD);
      box(b, 0.48, 0.08, 0.08, frame.clone().setPosition(at(lat, 2.2)), WOOD_DARK);
      box(b, 0.48, 0.08, 0.08, frame.clone().setPosition(at(lat, 1.12)), WOOD_DARK);
    } else if (hz.kind === 'icicles') {
      box(b, 0.5, 0.12, 0.16, frame.clone().setPosition(at(lat, 2.4)), WOOD_DARK);
      for (let k = 0; k < 6; k++) {
        const len = 0.9 + ((k * 37) % 5) * 0.12;
        const m = new Matrix4().makeRotationX(Math.PI).premultiply(frame).setPosition(at(lat - 0.2 + k * 0.08, 2.35 - len / 2));
        b.add(new ConeGeometry(0.05, len, 6), m, ICE);
      }
    } else {
      rod(b, top, at(lat, 2.0), 0.02, IRON);
      b.add(new CylinderGeometry(0.24, 0.18, 0.55, 10), frame.clone().setPosition(at(lat, 1.65)), new Color(0.42, 0.3, 0.2));
      b.add(new CylinderGeometry(0.25, 0.25, 0.05, 10), frame.clone().setPosition(at(lat, 1.88)), IRON);
      b.add(new CylinderGeometry(0.19, 0.19, 0.05, 10), frame.clone().setPosition(at(lat, 1.42)), IRON);
    }
  }
  const mesh = new Mesh(b.build(), new MeshStandardMaterial({ vertexColors: true, roughness: 0.6, flatShading: true }));
  mesh.name = 'FlumeHazards';
  mesh.castShadow = true;
  return mesh;
}

export function buildFlumeWorld(hazards: Hazard[]): Group {
  const group = new Group();
  group.name = 'NeedleAndFlume';
  group.add(buildNeedle());
  group.add(buildPortal());
  group.add(buildTrough());
  group.add(buildSupports());
  group.add(buildHazards(hazards));
  return group;
}

export const BEACON_TOP = new Vector3(NEEDLE.x, NEEDLE.top + 2.6, NEEDLE.z);
