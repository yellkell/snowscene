/**
 * The bluff at the back of the summit shoulder. From the top of the climb
 * all you see is its rock face and the timbered cave mouth in it (the way
 * into the timber works). Its flat top, where the cave's chimney comes out,
 * holds the beacon deck: once the beacon is lit you come out up there,
 * build the glider and launch off the front edge toward the lake.
 */

import {
  BoxGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
} from '@iwsdk/core';
import { createLandMaterial } from './land-material.js';
import { GeometryBuilder, placed, segmentMatrix } from './mesh-utils.js';
import {
  BLUFF_FACE_S,
  BLUFF_HALF_WIDTH,
  BLUFF_HEIGHT,
  BLUFF_X,
  fbm,
  smoothstep,
  SUMMIT_Y,
  terrainHeight,
  valueNoise,
} from './terrain.js';

/** Floor height on top of the bluff. */
export const BLUFF_TOP_Y = SUMMIT_Y + BLUFF_HEIGHT;
/** The face stands just in front of the terrain's step. */
const FACE_Z = -(BLUFF_FACE_S - 0.3);
/** The beacon's fire, in its basket at the back of the deck. */
export const BEACON_TOP = new Vector3(BLUFF_X, BLUFF_TOP_Y + 2.6, -(BLUFF_FACE_S + 10));
/** Where you stand to build the glider, facing north (into the mountain). */
export const BUILD_STAND = new Vector3(BLUFF_X, BLUFF_TOP_Y, -(BLUFF_FACE_S + 3.6));
/** Root of the glider kit (deck level), between you and the beacon. */
export const WORKBENCH_POS = new Vector3(BLUFF_X, BLUFF_TOP_Y, -(BLUFF_FACE_S + 4.95));
/** Take-off: the open front edge of the deck, facing the lake. */
export const LAUNCH_EDGE = new Vector3(BLUFF_X, BLUFF_TOP_Y, -(BLUFF_FACE_S + 1.9));
/** The deck's extent (s = -z) on the shelf. */
const DECK_FRONT_S = BLUFF_FACE_S + 1.7;
const DECK_BACK_S = BLUFF_FACE_S + 12;
const DECK_HALF = 4.4;

const WOOD = new Color(0.5, 0.33, 0.19);
const WOOD_DARK = new Color(0.3, 0.2, 0.12);
const IRON = new Color(0.16, 0.16, 0.17);

const box = (b: GeometryBuilder, w: number, h: number, d: number, m: Matrix4, color: Color) =>
  b.add(new BoxGeometry(w, h, d), m, color);
const rod = (b: GeometryBuilder, a: Vector3, c: Vector3, r: number, color: Color, sides = 6) =>
  b.add(new CylinderGeometry(r, r, 1, sides), segmentMatrix(a, c, new Matrix4()), color);

/** Height of the face's top edge across it (it tapers into the side slopes). */
function faceTop(x: number): number {
  const side = smoothstep(BLUFF_HALF_WIDTH + 7, BLUFF_HALF_WIDTH, Math.abs(x - BLUFF_X));
  return SUMMIT_Y + BLUFF_HEIGHT * side;
}

/** Outward relief of the rock face; flat around the cave mouth. */
function faceRelief(x: number, y: number): number {
  const lx = x - BLUFF_X;
  const rough = (fbm(x * 0.35 + 11, y * 0.35, 4) * 0.5 + 0.5) * 1.3;
  const ledges = Math.max(0, valueNoise(x * 0.12, y * 1.1)) * 0.5;
  const mouth = smoothstep(2.4, 3.4, Math.abs(lx)) + smoothstep(SUMMIT_Y + 4.4, SUMMIT_Y + 5.4, y);
  return 0.15 + (rough + ledges) * Math.min(1, mouth);
}

/** The rock face, curling over onto the shelf at the top so there is no gap. */
function buildFace(): Mesh {
  const halfW = BLUFF_HALF_WIDTH + 7.5;
  const cols = 90;
  const rows = 40;
  const bottom = SUMMIT_Y - 1.5;
  const geometry = new PlaneGeometry(1, 1, cols, rows);
  const pos = geometry.getAttribute('position');
  for (let v = 0; v < pos.count; v++) {
    const u = pos.getX(v) + 0.5;
    const t = pos.getY(v) + 0.5;
    const x = BLUFF_X - halfW + u * halfW * 2;
    const top = faceTop(x);
    const lip = Math.max(0, (t - 0.94) / 0.06);
    const y = bottom + (top + 0.25 - bottom) * Math.min(1, t / 0.94);
    // The last rows roll back over the edge onto the shelf.
    const z = FACE_Z + faceRelief(x, y) * (1 - lip) - lip * 1.9;
    pos.setXYZ(v, x, lip > 0 ? top + 0.25 - lip * 0.3 : y, z);
  }
  geometry.computeVertexNormals();
  const face = new Mesh(geometry, createLandMaterial({ rockScale: 4.5, snowScale: 1.5, lite: true }));
  face.name = 'BluffFace';
  face.castShadow = true;
  face.receiveShadow = true;
  return face;
}

/** The beacon deck on the shelf: planks, rails, and the beacon on its tripod. */
function buildDeck(): Mesh {
  const b = new GeometryBuilder();
  const y = BLUFF_TOP_Y;
  const planks = Math.round((DECK_BACK_S - DECK_FRONT_S) / 0.62);
  for (let k = 0; k < planks; k++) {
    const s = DECK_FRONT_S + 0.31 + k * 0.62;
    box(b, DECK_HALF * 2, 0.1, 0.6, placed(BLUFF_X, y - 0.04, -s), k % 2 ? WOOD : WOOD_DARK);
  }
  // Rails down the sides and across the back; the front edge stays open.
  const post = (x: number, s: number) => rod(b, new Vector3(x, y, -s), new Vector3(x, y + 1.0, -s), 0.05, WOOD_DARK);
  for (let s = DECK_FRONT_S + 0.6; s <= DECK_BACK_S; s += 2.2) {
    post(BLUFF_X - DECK_HALF, s);
    post(BLUFF_X + DECK_HALF, s);
  }
  for (const side of [-1, 1]) {
    const x = BLUFF_X + side * DECK_HALF;
    rod(b, new Vector3(x, y + 1.0, -(DECK_FRONT_S + 0.6)), new Vector3(x, y + 1.0, -DECK_BACK_S), 0.04, WOOD);
  }
  for (let x = BLUFF_X - DECK_HALF + 2.2; x < BLUFF_X + DECK_HALF; x += 2.2) post(x, DECK_BACK_S);
  rod(b, new Vector3(BLUFF_X - DECK_HALF, y + 1.0, -DECK_BACK_S), new Vector3(BLUFF_X + DECK_HALF, y + 1.0, -DECK_BACK_S), 0.04, WOOD);
  // The cave's chimney mouth beside the beacon: a timber collar round a dark hole.
  const hole = new Vector3(BLUFF_X + 2.4, y, BEACON_TOP.z + 0.4);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    box(b, 0.9, 0.18, 0.2, new Matrix4().makeRotationY(-a + Math.PI / 2).setPosition(hole.x + Math.cos(a) * 0.95, y + 0.05, hole.z + Math.sin(a) * 0.95), WOOD_DARK);
  }
  b.add(new CylinderGeometry(0.95, 0.95, 0.04, 16), placed(hole.x, y + 0.02, hole.z), new Color(0.03, 0.035, 0.045));
  // The beacon's iron basket on a tall tripod.
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    rod(b, new Vector3(BLUFF_X + Math.cos(a) * 1.1, y, BEACON_TOP.z + Math.sin(a) * 1.1), new Vector3(BLUFF_X, y + 2.4, BEACON_TOP.z), 0.07, IRON);
  }
  b.add(new CylinderGeometry(0.9, 0.5, 0.6, 12, 1, true), placed(BLUFF_X, y + 2.5, BEACON_TOP.z), IRON);
  const deck = new Mesh(b.build(), new MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true }));
  deck.name = 'BeaconDeck';
  deck.castShadow = true;
  return deck;
}

/** A timbered mine adit in the bluff's face: the way into the cave. */
function buildPortal(x: number, y: number, z: number): Group {
  const group = new Group();
  group.name = 'CavePortal';
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


export interface BluffWorld {
  root: Group;
  /** Shown once you come up out of the cave. */
  deck: Mesh;
}

export function buildBluffWorld(): BluffWorld {
  const root = new Group();
  root.name = 'CaveBluff';
  root.add(buildFace());
  const mz = FACE_Z + 0.15;
  root.add(buildPortal(BLUFF_X, terrainHeight(BLUFF_X, mz + 1), mz));
  const deck = buildDeck();
  root.add(deck);
  return { root, deck };
}
