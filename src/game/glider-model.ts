/**
 * Procedural hang glider. The model is built in "pilot space": forward is
 * -Z, the pilot's floor is y = 0 and the control bar sits at chest height,
 * so the full-size glider can be posed directly around the player.
 *
 * Each detachable part is a Group whose origin is the part's centroid, which
 * makes carrying and snapping parts on the summit workbench straightforward.
 */

import {
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SphereGeometry,
  Vector3,
} from '@iwsdk/core';
import { GliderPartIds } from './game-components.js';
import { GeometryBuilder, segmentMatrix } from './mesh-utils.js';

export type GliderPartId = (typeof GliderPartIds)[keyof typeof GliderPartIds];

export const NOSE = new Vector3(0, 2.25, -1.65);
export const TAIL = new Vector3(0, 2.32, 1.35);
const TIP = new Vector3(3.6, 2.55, 0.95);
const APEX = new Vector3(0, 2.22, -0.25);
/** Control bar height and depth in pilot space. */
export const BAR_Y = 1.12;
export const BAR_Z = -0.55;
export const BAR_HALF_WIDTH = 0.62;
/** Distance from the pilot's eyes down to the control bar. */
export const BAR_BELOW_EYES = 0.42;

const tubeColor = new Color(0.62, 0.65, 0.7);
const sailOrange = new Color(1.0, 0.36, 0.16);
const sailYellow = new Color(1.0, 0.78, 0.2);
const sailWhite = new Color(0.97, 0.97, 0.98);
const grip = new Color(0.08, 0.08, 0.09);

function tube(builder: GeometryBuilder, a: Vector3, b: Vector3, r: number, color: Color) {
  builder.add(new CylinderGeometry(r, r, 1, 8), segmentMatrix(a, b, new Matrix4()), color);
}

/** Billowed triangular sail between the nose, a wing tip and the tail. */
function sailGeometry(side: 1 | -1): BufferGeometry {
  const tip = TIP.clone().setX(TIP.x * side);
  const n = 10;
  const verts: Vector3[] = [];
  const index = (i: number, j: number) => (i * (i + 1)) / 2 + j;
  // barycentric rows from the nose (i = 0) to the trailing edge (i = n)
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= i; j++) {
      const u = i / n; // distance away from the nose
      const v = i === 0 ? 0 : j / i; // 0 = tail side, 1 = tip side
      const p = new Vector3()
        .copy(NOSE)
        .lerp(TAIL, u * (1 - v))
        .add(tip.clone().sub(NOSE).multiplyScalar(u * v));
      const billow = Math.sin(Math.PI * v) * Math.sin(Math.PI * Math.min(1, u * 1.1)) * 0.22;
      p.y -= billow;
      verts.push(p);
    }
  }
  const positions: number[] = [];
  const colors: number[] = [];
  const c = new Color();
  const push = (p: Vector3) => {
    positions.push(p.x, p.y, p.z);
    const span = Math.abs(p.x) / TIP.x;
    const band = Math.floor(span * 6);
    if (band === 2) c.copy(sailWhite);
    else if (band === 4) c.copy(sailYellow);
    else c.copy(sailOrange);
    colors.push(c.r, c.g, c.b);
  };
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      const a = verts[index(i, j)];
      const b = verts[index(i + 1, j)];
      const d = verts[index(i + 1, j + 1)];
      if (side > 0) [a, b, d].forEach(push);
      else [a, d, b].forEach(push);
      if (j < i) {
        const e = verts[index(i, j + 1)];
        if (side > 0) [a, d, e].forEach(push);
        else [a, e, d].forEach(push);
      }
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

const sailMaterial = new MeshStandardMaterial({
  vertexColors: true,
  side: DoubleSide,
  roughness: 0.6,
});
const frameMaterial = new MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.35,
  metalness: 0.55,
});

function centredPart(name: string, meshes: Mesh[]): Group {
  const group = new Group();
  group.name = name;
  const centroid = new Vector3();
  let count = 0;
  for (const mesh of meshes) {
    mesh.geometry.computeBoundingBox();
    const box = mesh.geometry.boundingBox!;
    centroid.add(box.getCenter(new Vector3()));
    count++;
  }
  centroid.divideScalar(Math.max(1, count));
  for (const mesh of meshes) {
    mesh.position.sub(centroid);
    group.add(mesh);
  }
  group.position.copy(centroid);
  return group;
}

function buildWing(side: 1 | -1): Group {
  const sail = new Mesh(sailGeometry(side), sailMaterial);
  const builder = new GeometryBuilder();
  const tip = TIP.clone().setX(TIP.x * side);
  tube(builder, NOSE, tip, 0.03, tubeColor);
  // battens give the sail some structure
  for (let k = 1; k <= 3; k++) {
    const t = k / 4;
    const le = new Vector3().lerpVectors(NOSE, tip, t);
    const te = new Vector3().lerpVectors(TAIL, tip, t);
    le.y -= 0.02;
    te.y -= 0.02;
    tube(builder, le, te, 0.008, new Color(0.15, 0.15, 0.18));
  }
  const frame = new Mesh(builder.build(), frameMaterial);
  return centredPart(side > 0 ? 'RightWing' : 'LeftWing', [sail, frame]);
}

function buildKeel(): Group {
  const builder = new GeometryBuilder();
  tube(builder, NOSE, TAIL, 0.035, tubeColor);
  const kingTop = new Vector3(0, 2.85, 0.05);
  const kingBase = new Vector3(0, 2.3, 0.05);
  tube(builder, kingBase, kingTop, 0.02, tubeColor);
  // nose cone
  builder.add(new SphereGeometry(0.06, 10, 8), new Matrix4().setPosition(NOSE), new Color(0.9, 0.2, 0.12));
  // crossbar stubs that the wings key into
  tube(builder, new Vector3(-0.35, 2.31, 0.15), new Vector3(0.35, 2.31, 0.15), 0.028, tubeColor);
  // wires from the kingpost
  const wire = new Color(0.8, 0.8, 0.85);
  tube(builder, kingTop, NOSE, 0.004, wire);
  tube(builder, kingTop, TAIL, 0.004, wire);
  return centredPart('Keel', [new Mesh(builder.build(), frameMaterial)]);
}

function buildControlBar(): Group {
  const builder = new GeometryBuilder();
  const left = new Vector3(-BAR_HALF_WIDTH, BAR_Y, BAR_Z);
  const right = new Vector3(BAR_HALF_WIDTH, BAR_Y, BAR_Z);
  tube(builder, APEX, left, 0.022, tubeColor);
  tube(builder, APEX, right, 0.022, tubeColor);
  tube(builder, left, right, 0.024, tubeColor);
  // rubber grips where the hands go
  tube(builder, new Vector3(-0.45, BAR_Y, BAR_Z), new Vector3(-0.12, BAR_Y, BAR_Z), 0.03, grip);
  tube(builder, new Vector3(0.12, BAR_Y, BAR_Z), new Vector3(0.45, BAR_Y, BAR_Z), 0.03, grip);
  return centredPart('ControlBar', [new Mesh(builder.build(), frameMaterial)]);
}

export interface GliderModel {
  root: Group;
  keel: Group;
  parts: Record<GliderPartId, Group>;
  /** Slot position for each part, in root-local coordinates. */
  slots: Record<GliderPartId, Vector3>;
}

export function buildGlider(): GliderModel {
  const root = new Group();
  root.name = 'Glider';
  const keel = buildKeel();
  root.add(keel);
  const parts: Record<GliderPartId, Group> = {
    LeftWing: buildWing(-1),
    RightWing: buildWing(1),
    ControlBar: buildControlBar(),
  };
  const slots = {} as Record<GliderPartId, Vector3>;
  for (const id of Object.values(GliderPartIds)) {
    slots[id] = parts[id].position.clone();
    root.add(parts[id]);
  }
  return { root, keel, parts, slots };
}

/** Translucent copy of a part used as the "place it here" hint. */
export function buildGhost(part: Group): Group {
  const ghost = part.clone(true);
  const material = new MeshBasicMaterial({
    color: 0x8fe8ff,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
    side: DoubleSide,
  });
  ghost.traverse((child) => {
    const mesh = child as Mesh;
    if (mesh.isMesh) mesh.material = material;
  });
  ghost.name = `${part.name}Ghost`;
  return ghost;
}
