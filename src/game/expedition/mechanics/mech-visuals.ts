/**
 * Cheap visuals for the crossing mechanics: the fixed rope with its anchor
 * stakes, the crevasse ladder with its two hand lines and pickets, the
 * sling + carabiner while clipped, and small grab-hint rings. Merged static
 * geometry (one draw call per material), no lights, nothing transparent.
 *
 * Each builder returns an object positioned in world space with geometry
 * relative to a local origin (keeps float precision at z ~ -8700).
 *
 * `mechanicsVisuals` lets the integrator switch off a piece if the world
 * builder already draws it (so nothing is drawn twice).
 */

import {
  BoxGeometry,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  TorusGeometry,
  TubeGeometry,
  Vector3,
} from '@iwsdk/core';
import { GeometryBuilder, segmentMatrix } from '../../mesh-utils.js';
import { expeditionHeight } from '../exp-terrain.js';
import {
  HANDLINE,
  handLineHeight,
  LADDER,
  LADDER_FLOOR_Y,
} from './crossing-geometry.js';
import { ropeData } from './rope-geometry.js';

export const mechanicsVisuals = {
  /** Draw the fixed rope and its anchor stakes. */
  rope: true,
  /** Draw the crevasse ladder. */
  ladder: true,
  /** Draw the ladder's hand lines and pickets (the mechanic needs them visible). */
  handLines: true,
};

const ROPE_COLOR = new Color(0.92, 0.3, 0.08);
const STEEL = new Color(0.62, 0.64, 0.68);
const ALU = new Color(0.8, 0.82, 0.86);
const LINE_COLOR = new Color(0.98, 0.78, 0.12);

/** Fixed rope tube (orange, faint emissive so it reads at night). */
export function buildRope(): { rope: Mesh; stakes: Mesh; material: MeshStandardMaterial } {
  const r = ropeData();
  const ox = r.x[0];
  const oy = r.y[0];
  const oz = r.z[0];
  const pts: Vector3[] = [];
  for (let i = 0; i < r.count; i++) pts.push(new Vector3(r.x[i] - ox, r.y[i] - oy, r.z[i] - oz));
  const curve = new CatmullRomCurve3(pts, false, 'centripetal');
  const tube = new TubeGeometry(curve, r.count - 1, 0.011, 5, false);
  const material = new MeshStandardMaterial({
    color: ROPE_COLOR,
    roughness: 0.8,
    emissive: new Color(0.9, 0.25, 0.05),
    emissiveIntensity: 0.12,
  });
  const rope = new Mesh(tube, material);
  rope.name = 'FixedRope';
  rope.position.set(ox, oy, oz);
  rope.castShadow = true;

  // Anchor stakes: a steel post from the ledge up to the rope with an eye.
  const b = new GeometryBuilder();
  const m = new Matrix4();
  const a = new Vector3();
  const c = new Vector3();
  for (const i of r.anchorIndex) {
    const x = r.x[i] - ox;
    const z = r.z[i] - oz;
    const ground = r.ground[i] - oy;
    const top = r.y[i] - oy;
    a.set(x, ground - 0.15, z);
    c.set(x, top + 0.03, z);
    b.add(new CylinderGeometry(0.018, 0.022, 1, 7), segmentMatrix(a, c, m), STEEL);
    // eye ring the rope passes through, facing along the rope
    const yaw = Math.atan2(r.tx[i], r.tz[i]);
    m.makeRotationY(yaw).setPosition(x, top, z);
    b.add(new TorusGeometry(0.028, 0.006, 5, 12), m, STEEL);
    // a little base plate
    m.makeRotationY(yaw).setPosition(x, ground + 0.01, z);
    b.add(new BoxGeometry(0.09, 0.02, 0.09), m, STEEL);
  }
  const stakes = new Mesh(b.build(), new MeshStandardMaterial({ vertexColors: true, metalness: 0.6, roughness: 0.4 }));
  stakes.name = 'FixedRopeAnchors';
  stakes.position.set(ox, oy, oz);
  stakes.castShadow = true;
  return { rope, stakes, material };
}

/**
 * Basis for the ladder group: local +X along travel, +Y up, +Z to the
 * right (so the left of travel is local -Z).
 */
function ladderBasis(group: Group): void {
  const t = new Vector3(LADDER.tx, 0, LADDER.tz);
  const up = new Vector3(0, 1, 0);
  const right = new Vector3(-LADDER.nx, 0, -LADDER.nz);
  group.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(t, up, right));
}

/**
 * The crevasse ladder. Returns the group (positioned at the ladder floor
 * centre) and the inner mesh that rolls when you wobble (rotate it about
 * local X; + rolls the left rail down).
 */
export function buildLadder(): { group: Group; deck: Mesh } {
  const group = new Group();
  group.name = 'CrevasseLadder';
  group.position.set(LADDER.x, LADDER_FLOOR_Y, LADDER.z);
  ladderBasis(group);
  const b = new GeometryBuilder();
  const m = new Matrix4();
  const len = LADDER.halfLength * 2;
  for (const side of [-1, 1]) {
    // box-section rail, its top flush with the walking surface
    m.makeScale(len, 0.075, 0.035).setPosition(0, -0.0375, side * 0.24);
    b.add(new BoxGeometry(1, 1, 1), m, ALU);
    // end caps
    for (const end of [-1, 1]) {
      m.makeScale(0.05, 0.08, 0.04).setPosition(end * (len / 2), -0.04, side * 0.24);
      b.add(new BoxGeometry(1, 1, 1), m, STEEL);
    }
  }
  const a = new Vector3();
  const c = new Vector3();
  for (let x = -len / 2 + 0.15; x <= len / 2 - 0.1; x += 0.3) {
    a.set(x, -0.02, -0.24);
    c.set(x, -0.02, 0.24);
    b.add(new CylinderGeometry(0.016, 0.016, 1, 8), segmentMatrix(a, c, m), ALU);
  }
  const deck = new Mesh(b.build(), new MeshStandardMaterial({ vertexColors: true, metalness: 0.7, roughness: 0.32 }));
  deck.name = 'CrevasseLadderDeck';
  deck.castShadow = true;
  group.add(deck);
  return { group, deck };
}

/** The two hand lines and their pickets, in the same frame as the ladder. */
export function buildHandLines(): Group {
  const group = new Group();
  group.name = 'CrevasseHandLines';
  group.position.set(LADDER.x, LADDER_FLOOR_Y, LADDER.z);
  ladderBasis(group);
  const b = new GeometryBuilder();
  const m = new Matrix4();
  const a = new Vector3();
  const c = new Vector3();
  for (const side of [-1, 1]) {
    // local z is to the right, so the left line (side +1) sits at z = -lateral
    const zl = -side * HANDLINE.lateral;
    const pts: Vector3[] = [];
    for (let k = 0; k <= 16; k++) {
      const x = -HANDLINE.stakeA + (2 * HANDLINE.stakeA * k) / 16;
      pts.push(new Vector3(x, handLineHeight(x), zl));
    }
    b.add(new TubeGeometry(new CatmullRomCurve3(pts), 32, 0.009, 5, false), m.identity(), LINE_COLOR);
    for (const end of [-1, 1]) {
      const x = end * HANDLINE.stakeA;
      // pickets stand in the snow; find the snow height under each
      const wx = LADDER.x + LADDER.tx * x + LADDER.nx * side * HANDLINE.lateral;
      const wz = LADDER.z + LADDER.tz * x + LADDER.nz * side * HANDLINE.lateral;
      const ground = expeditionHeight(wx, wz) - LADDER_FLOOR_Y;
      a.set(x, ground - 0.3, zl);
      c.set(x, HANDLINE.height + 0.06, zl);
      b.add(new BoxGeometry(0.035, 1, 0.035), segmentMatrix(a, c, m), STEEL);
    }
  }
  const mesh = new Mesh(b.build(), new MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.3, emissive: new Color(0.25, 0.18, 0.02), emissiveIntensity: 0.4 }));
  mesh.name = 'CrevasseHandLineMesh';
  mesh.castShadow = true;
  group.add(mesh);
  return group;
}

/** A unit cylinder along +Y for a sling segment (scale.y = length). */
export function buildSlingSegment(material: MeshStandardMaterial): Mesh {
  const geo = new CylinderGeometry(0.009, 0.009, 1, 6);
  const mesh = new Mesh(geo, material);
  mesh.name = 'SlingSegment';
  mesh.visible = false;
  mesh.frustumCulled = false;
  return mesh;
}

export function slingMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({ color: 0x3b7bd4, roughness: 0.8 });
}

/** The carabiner riding on the rope (ring + gold gate). */
export function buildRopeClip(): Group {
  const group = new Group();
  group.name = 'RopeClip';
  const b = new GeometryBuilder();
  const m = new Matrix4().makeScale(1, 1.45, 1);
  b.add(new TorusGeometry(0.03, 0.0055, 6, 18), m, STEEL);
  const a = new Vector3(0.029, -0.02, 0);
  const c = new Vector3(0.029, 0.02, 0);
  b.add(new CylinderGeometry(0.004, 0.004, 1, 6), segmentMatrix(a, c, m), new Color(0.88, 0.62, 0.12));
  group.add(new Mesh(b.build(), new MeshStandardMaterial({ vertexColors: true, metalness: 0.8, roughness: 0.3 })));
  group.visible = false;
  return group;
}

/** Small glowing ring showing where a reaching hand would grab. */
export function buildGrabHint(): Mesh {
  const mesh = new Mesh(
    new TorusGeometry(0.03, 0.005, 5, 16),
    new MeshBasicMaterial({ color: new Color(1, 0.86, 0.35) }),
  );
  mesh.name = 'GrabHint';
  mesh.visible = false;
  return mesh;
}
