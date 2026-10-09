/**
 * The backpack as a thing you can hold (after gamblefish's tackle-box tray):
 * a wooden box with a felt lining and a grid of slots, its lid standing
 * open at the back. It comes up in front of you at waist height, tipped
 * toward you, with your gear lying in the slots.
 *
 * Tray-local frame: X across (columns), Y out of the tray (up at you), Z
 * down the tray toward you (rows). Cell (c, r) is centred at
 * ((c + 1/2 - COLS/2) * CELL, 0, (r + 1/2 - ROWS/2) * CELL).
 */

import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Vector3,
} from '@iwsdk/core';
import { GeometryBuilder, placed } from './mesh-utils.js';

/** One slot's size (m); 4 x 3 slots make a 0.44 x 0.33 m tray. */
export const CELL = 0.11;
export const COLS = 4;
export const ROWS = 3;
export const TRAY_W = COLS * CELL;
export const TRAY_H = ROWS * CELL;
/** How far the tray tips toward you. */
export const TRAY_TILT = (35 * Math.PI) / 180;
const RIM = 0.035;
const DEPTH = 0.045;
/** The lid stands this far back past upright, hinged on the far rim. */
const LID_OPEN = (105 * Math.PI) / 180;
const LID_H = 0.3;

const WOOD = new Color(0.4, 0.26, 0.15);
const WOOD_DARK = new Color(0.22, 0.14, 0.08);
const BRASS = new Color(0.78, 0.6, 0.25);
const FELT = new Color(0.11, 0.23, 0.2);
const LEATHER = new Color(0.36, 0.2, 0.11);

export interface PackTray {
  group: Group;
  /** Stands in front of the open lid: where the guide notes rest. */
  notes: Object3D;
  /** Where the side buttons stand, off the tray's left rim (tray-local). */
  sideButton: Vector3;
}

/** Tray-local position of a cell's centre. */
export function cellCentre(c: number, r: number, out: Vector3, lift = 0): Vector3 {
  return out.set((c + 0.5 - COLS / 2) * CELL, lift, (r + 0.5 - ROWS / 2) * CELL);
}

export function buildPackTray(): PackTray {
  const group = new Group();
  group.name = 'PackTray';
  const w = TRAY_W;
  const h = TRAY_H;

  // The felt lining on the floor of the box.
  const felt = new Mesh(new BoxGeometry(w, 0.01, h), new MeshStandardMaterial({ color: FELT, roughness: 1 }));
  felt.position.y = -0.005;
  felt.name = 'PackFelt';
  group.add(felt);

  const b = new GeometryBuilder();
  // Outer walls.
  b.add(new BoxGeometry(w + RIM * 2, DEPTH, RIM), placed(0, DEPTH / 2 - 0.01, -h / 2 - RIM / 2), WOOD);
  b.add(new BoxGeometry(w + RIM * 2, DEPTH, RIM), placed(0, DEPTH / 2 - 0.01, h / 2 + RIM / 2), WOOD);
  b.add(new BoxGeometry(RIM, DEPTH, h), placed(-w / 2 - RIM / 2, DEPTH / 2 - 0.01, 0), WOOD);
  b.add(new BoxGeometry(RIM, DEPTH, h), placed(w / 2 + RIM / 2, DEPTH / 2 - 0.01, 0), WOOD);
  // Slot dividers: thin and low.
  for (let c = 1; c < COLS; c++) b.add(new BoxGeometry(0.004, 0.014, h), placed(-w / 2 + c * CELL, 0.005, 0), WOOD_DARK);
  for (let r = 1; r < ROWS; r++) b.add(new BoxGeometry(w, 0.014, 0.004), placed(0, 0.005, -h / 2 + r * CELL), WOOD_DARK);
  // A bottom under it all.
  b.add(new BoxGeometry(w + RIM * 2, 0.02, h + RIM * 2), placed(0, -0.02, 0), WOOD_DARK);
  // Brass corner caps.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.add(new BoxGeometry(RIM + 0.008, DEPTH + 0.01, RIM + 0.008), placed(sx * (w / 2 + RIM / 2), DEPTH / 2 - 0.008, sz * (h / 2 + RIM / 2)), BRASS);
    }
  }
  // Leather carry strap across the front, with a brass buckle.
  b.add(new BoxGeometry(0.045, DEPTH + 0.004, 0.006), placed(0, DEPTH / 2 - 0.01, h / 2 + RIM + 0.003), LEATHER);
  b.add(new BoxGeometry(0.055, 0.026, 0.008), placed(0, DEPTH / 2 - 0.005, h / 2 + RIM + 0.006), BRASS);

  // The lid, hinged on the far rim and standing open: a framed board.
  const hingeZ = -h / 2 - RIM;
  // Closed, the lid lies along +Z over the slots; open, it swings up and back.
  const lidBasis = new Matrix4().makeRotationX(-(LID_OPEN - Math.PI / 2));
  const lid = (bw: number, bh: number, bd: number, x: number, y: number, z: number, color: Color) => {
    // (x, y, z) in the lid's own frame: y up its face from the hinge, z out of its face.
    const m = new Matrix4().makeTranslation(x, y, z).premultiply(lidBasis);
    m.setPosition(new Vector3().setFromMatrixPosition(m).add(new Vector3(0, DEPTH - 0.01, hingeZ)));
    b.add(new BoxGeometry(bw, bh, bd), m, color);
  };
  lid(w + RIM * 2, LID_H, 0.012, 0, LID_H / 2, -0.006, WOOD_DARK);
  lid(w + RIM * 2, 0.025, 0.02, 0, LID_H - 0.0125, 0.006, WOOD);
  lid(w + RIM * 2, 0.025, 0.02, 0, 0.0125, 0.006, WOOD);
  lid(0.025, LID_H, 0.02, -w / 2 - RIM + 0.0125, LID_H / 2, 0.006, WOOD);
  lid(0.025, LID_H, 0.02, w / 2 + RIM - 0.0125, LID_H / 2, 0.006, WOOD);
  for (const sx of [-1, 1]) {
    b.add(new CylinderGeometry(0.008, 0.008, 0.05, 8), new Matrix4().makeRotationZ(Math.PI / 2).setPosition(sx * w * 0.32, DEPTH - 0.01, hingeZ), BRASS);
  }

  const body = new Mesh(b.build(), new MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.05 }));
  body.name = 'PackBox';
  group.add(body);

  // The notes rest against the open lid, a little proud of it.
  const notes = new Object3D();
  notes.name = 'PackNotesAnchor';
  const centre = new Vector3(0, LID_H * 0.55, 0.05).applyMatrix4(lidBasis).add(new Vector3(0, DEPTH, hingeZ));
  notes.position.copy(centre);
  group.add(notes);

  return {
    group,
    notes,
    sideButton: new Vector3(-w / 2 - RIM - 0.055, 0.03, h / 2 - 0.05),
  };
}
