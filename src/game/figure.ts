/**
 * The game's people: chunky cartoon mountaineers in puffy parkas, with a
 * big round head, dot eyes and rosy cheeks, a knitted scarf, a bobble hat,
 * mittens and boots. Built from a handful of primitives with vertex colours
 * so a whole crowd merges into one draw.
 *
 * Figure space: feet on y = 0, facing +Z. Arms hang from ARM_PIVOT (x mirrored
 * per side) and are tagged limb 1 (left, -X) and 2 (right, +X) so callers can
 * swing them; everything else is limb 0.
 */

import {
  type BufferGeometry,
  CapsuleGeometry,
  Color,
  Matrix4,
  SphereGeometry,
  TorusGeometry,
  BoxGeometry,
  Vector3,
} from '@iwsdk/core';

/** The shoulder joint: inside the parka's shoulder, so a raised arm stays attached. */
export const ARM_PIVOT = new Vector3(0.25, 1.34, 0);

export interface FigureLook {
  jacket: Color;
  /** Scarf, cuffs and the hat's brim. */
  knit: Color;
  hat: Color;
  pom: Color;
  skin: Color;
}

export interface FigurePart {
  geometry: BufferGeometry;
  matrix: Matrix4;
  color: Color;
  limb: 0 | 1 | 2;
}

export const JACKETS = [0xe0482e, 0x2f78c8, 0xf0b532, 0x3ea865, 0xc2449a, 0xf5762a, 0x24afb0, 0x7a52c8].map((h) => new Color(h));
export const KNITS = [0xf4f1ea, 0xe8443a, 0x2a4f9a, 0xf2c53d, 0x7a3fb0, 0x3fb38a, 0xff8fb1].map((h) => new Color(h));
export const SKINS = [0xf6cfae, 0xe0a982, 0xb57a52, 0x83522f, 0xedc19c].map((h) => new Color(h));
const TROUSERS = new Color(0x2c3246);
const BOOTS = new Color(0x5b3721);
const SOLE = new Color(0x2a1a12);
const EYES = new Color(0x1a1a26);
const BLUSH = new Color(0xff6f6f);

/** A look from a seed (stable per index). */
export function figureLook(seed: number): FigureLook {
  const i = Math.abs(Math.floor(seed));
  return {
    jacket: JACKETS[i % JACKETS.length],
    knit: KNITS[(i * 3 + 1) % KNITS.length],
    hat: KNITS[(i * 5 + 2) % KNITS.length],
    pom: KNITS[(i * 2 + 4) % KNITS.length],
    skin: SKINS[(i * 7 + 2) % SKINS.length],
  };
}

type Templates = Record<
  'boot' | 'leg' | 'body' | 'hem' | 'placket' | 'scarf' | 'tail' | 'head' | 'eye' | 'nose' | 'cheek' | 'hat' | 'brim' | 'pom' | 'shoulder' | 'sleeve' | 'cuff' | 'mitt',
  BufferGeometry
>;
let templates: Templates | null = null;

function shapes(): Templates {
  if (templates) return templates;
  const ring = (r: number, tube: number, seg: number) => new TorusGeometry(r, tube, 5, seg).rotateX(Math.PI / 2);
  templates = {
    boot: new SphereGeometry(0.1, 8, 4),
    leg: new CapsuleGeometry(0.095, 0.36, 2, 6),
    body: new CapsuleGeometry(0.27, 0.42, 3, 10),
    hem: ring(0.25, 0.05, 12),
    placket: new BoxGeometry(0.04, 0.5, 0.03),
    scarf: ring(0.155, 0.065, 12),
    tail: new BoxGeometry(0.1, 0.28, 0.045),
    head: new SphereGeometry(0.2, 12, 9),
    eye: new SphereGeometry(0.027, 6, 4),
    nose: new SphereGeometry(0.042, 6, 4),
    cheek: new SphereGeometry(0.036, 6, 3),
    hat: new SphereGeometry(0.214, 12, 4, 0, Math.PI * 2, 0, Math.PI / 2),
    brim: ring(0.2, 0.055, 12),
    pom: new SphereGeometry(0.078, 7, 5),
    shoulder: new SphereGeometry(0.105, 8, 6),
    sleeve: new CapsuleGeometry(0.082, 0.36, 2, 6),
    cuff: ring(0.078, 0.032, 8),
    mitt: new SphereGeometry(0.088, 7, 5),
  };
  return templates;
}

const m = (x: number, y: number, z: number, sx = 1, sy = sx, sz = sx, rz = 0) =>
  new Matrix4().makeRotationZ(rz).premultiply(new Matrix4().makeScale(sx, sy, sz)).setPosition(x, y, z);

/** The parts of one figure, in figure space. Geometries are shared templates: don't dispose them. */
export function figureParts(look: FigureLook): FigurePart[] {
  const S = shapes();
  const out: FigurePart[] = [];
  const add = (geometry: BufferGeometry, matrix: Matrix4, color: Color, limb: 0 | 1 | 2 = 0) =>
    out.push({ geometry, matrix, color, limb });
  const hem = look.jacket.clone().multiplyScalar(0.72);
  const nose = look.skin.clone().lerp(BLUSH, 0.25);
  const cheek = look.skin.clone().lerp(BLUSH, 0.55);
  for (const side of [-1, 1]) {
    add(S.boot, m(side * 0.12, 0.075, 0.045, 1, 0.75, 1.45), BOOTS);
    add(S.boot, m(side * 0.12, 0.02, 0.045, 1.05, 0.25, 1.5), SOLE);
    add(S.leg, m(side * 0.12, 0.38, 0), TROUSERS);
  }
  // A puffy parka, a bit flattened front to back.
  add(S.body, m(0, 1.0, 0, 1, 1, 0.86), look.jacket);
  add(S.hem, m(0, 0.6, 0, 1.04, 1, 0.9), hem);
  add(S.placket, m(0, 1.08, 0.222), hem);
  // Scarf and its loose end.
  add(S.scarf, m(0, 1.47, 0), look.knit);
  add(S.tail, m(0.09, 1.31, 0.19, 1, 1, 1, 0.18), look.knit);
  // Big head, dot eyes, rosy cheeks and nose.
  add(S.head, m(0, 1.7, 0), look.skin);
  for (const side of [-1, 1]) {
    add(S.eye, m(side * 0.072, 1.725, 0.181, 1, 1.35, 0.6), EYES);
    add(S.cheek, m(side * 0.115, 1.655, 0.158, 1, 0.7, 0.45), cheek);
  }
  add(S.nose, m(0, 1.675, 0.198), nose);
  // Bobble hat.
  add(S.hat, m(0, 1.75, 0, 1, 1.15, 1), look.hat);
  add(S.brim, m(0, 1.77, 0), look.knit);
  add(S.pom, m(0, 2.02, 0), look.pom);
  // Arms: sleeve, knitted cuff and a mitten, hanging from the shoulder.
  for (const side of [-1, 1]) {
    const limb = side < 0 ? 1 : 2;
    const x = side * ARM_PIVOT.x;
    // A puffy shoulder centred on the joint: it turns in place, so the
    // seam to the body stays hidden however high the arm goes.
    add(S.shoulder, m(x, ARM_PIVOT.y, 0), look.jacket, limb);
    add(S.sleeve, m(x, ARM_PIVOT.y - 0.24, 0), look.jacket, limb);
    add(S.cuff, m(x, ARM_PIVOT.y - 0.47, 0), look.knit, limb);
    add(S.mitt, m(x, ARM_PIVOT.y - 0.56, 0.01, 1, 1.15, 0.9), look.knit, limb);
  }
  return out;
}
