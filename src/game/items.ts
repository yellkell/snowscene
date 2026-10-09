/**
 * Procedural models for the gear in your backpack: ice axes, carabiner,
 * headlamp, thermos, hand warmer, map, flare and the packed glider, plus the
 * open backpack itself. Each model's origin is the point you hold it by,
 * with its "up" along -Z of the hand's grip space (the thumb side), so it
 * can be parented straight onto a grip pose.
 */

import {
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SRGBColorSpace,
  TorusGeometry,
  BoxGeometry,
  Vector3,
} from '@iwsdk/core';
import type { ItemId } from './equipment.js';
import { GeometryBuilder, segmentMatrix } from './mesh-utils.js';
import { buildPole } from './world-builders.js';

const metal = new MeshStandardMaterial({ color: 0xb9bec7, metalness: 0.85, roughness: 0.3 });
const rubber = new MeshStandardMaterial({ color: 0x18191c, roughness: 0.85 });

function tube(builder: GeometryBuilder, a: Vector3, b: Vector3, r: number, color: Color) {
  builder.add(new CylinderGeometry(r, r, 1, 10), segmentMatrix(a, b, new Matrix4()), color);
}

/** Technical ice axe: grip at origin, shaft up along -Z, head with pick and adze. */
export function buildIceAxe(): Group {
  const group = new Group();
  group.name = 'IceAxe';
  const b = new GeometryBuilder();
  const shaft = new Color(0.95, 0.42, 0.12);
  const grip = new Color(0.08, 0.08, 0.09);
  const steel = new Color(0.72, 0.75, 0.8);
  // curved shaft from below the hand up to the head
  const pts = [
    new Vector3(0, 0, 0.1),
    new Vector3(0, 0.01, -0.05),
    new Vector3(0, 0.03, -0.2),
    new Vector3(0, 0.035, -0.36),
    new Vector3(0, 0.02, -0.46),
  ];
  for (let i = 0; i < pts.length - 1; i++) tube(b, pts[i], pts[i + 1], 0.014, i === 0 ? grip : shaft);
  tube(b, new Vector3(0, 0, 0.1), new Vector3(0, 0, -0.08), 0.019, grip);
  // spike at the bottom
  b.add(new ConeGeometry(0.012, 0.05, 6), new Matrix4().makeRotationX(Math.PI / 2).setPosition(0, 0, 0.13), steel);
  // head: a pick curving down/forward (+Y is "forward" off the thumb) and an adze behind
  const head = new Vector3(0, 0.02, -0.47);
  tube(b, head.clone().add(new Vector3(0, -0.07, 0)), head.clone().add(new Vector3(0, 0.05, 0)), 0.016, steel);
  const pick = [
    head.clone().add(new Vector3(0, 0.04, 0)),
    head.clone().add(new Vector3(0, 0.11, 0.02)),
    head.clone().add(new Vector3(0, 0.17, 0.06)),
  ];
  tube(b, pick[0], pick[1], 0.009, steel);
  tube(b, pick[1], pick[2], 0.006, steel);
  b.add(new BoxGeometry(0.03, 0.05, 0.012), new Matrix4().setPosition(head.x, head.y - 0.09, head.z), steel);
  const mesh = new Mesh(b.build(), new MeshStandardMaterial({ vertexColors: true, metalness: 0.4, roughness: 0.45 }));
  mesh.castShadow = true;
  group.add(mesh);
  return group;
}

export function buildCarabiner(): Group {
  const group = new Group();
  group.name = 'Carabiner';
  const ring = new Mesh(new TorusGeometry(0.035, 0.006, 8, 24), metal);
  ring.scale.set(1, 1.45, 1);
  ring.rotation.y = Math.PI / 2;
  const gate = new Mesh(new CylinderGeometry(0.004, 0.004, 0.05, 6), new MeshStandardMaterial({ color: 0xe0a020, metalness: 0.7, roughness: 0.3 }));
  gate.position.set(0, 0, -0.035);
  group.add(ring, gate);
  // a short sling to the harness
  const sling = new Mesh(new CylinderGeometry(0.008, 0.008, 0.18, 6), new MeshStandardMaterial({ color: 0x3b7bd4, roughness: 0.8 }));
  sling.rotation.x = Math.PI / 2;
  sling.position.z = 0.1;
  group.add(sling);
  return group;
}

export function buildHeadlamp(): Group {
  const group = new Group();
  group.name = 'Headlamp';
  const band = new Mesh(new TorusGeometry(0.085, 0.009, 6, 28), new MeshStandardMaterial({ color: 0x2b2f38, roughness: 0.8 }));
  band.rotation.x = Math.PI / 2;
  const lamp = new Mesh(new BoxGeometry(0.05, 0.035, 0.03), new MeshStandardMaterial({ color: 0xd94a2a, roughness: 0.5 }));
  lamp.position.set(0, 0, -0.09);
  const lens = new Mesh(new CylinderGeometry(0.012, 0.012, 0.006, 16), new MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2cc, emissiveIntensity: 0.6 }));
  lens.rotation.x = Math.PI / 2;
  lens.position.set(0, 0, -0.106);
  group.add(band, lamp, lens);
  return group;
}

export function buildThermos(): Group {
  const group = new Group();
  group.name = 'Thermos';
  const body = new Mesh(new CylinderGeometry(0.036, 0.036, 0.24, 20), new MeshStandardMaterial({ color: 0x2d6a4f, metalness: 0.5, roughness: 0.35 }));
  body.rotation.x = Math.PI / 2;
  const cap = new Mesh(new CylinderGeometry(0.04, 0.04, 0.06, 20), metal);
  cap.rotation.x = Math.PI / 2;
  cap.position.z = -0.14;
  group.add(body, cap);
  return group;
}

export function buildWarmer(): Group {
  const group = new Group();
  group.name = 'HandWarmer';
  const pouch = new Mesh(new BoxGeometry(0.07, 0.02, 0.09), new MeshStandardMaterial({ color: 0xf28c28, roughness: 0.7 }));
  group.add(pouch);
  return group;
}

function mapTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#efe6d2';
  ctx.fillRect(0, 0, 256, 256);
  ctx.strokeStyle = 'rgba(120,90,60,0.35)';
  for (let r = 20; r < 180; r += 16) {
    ctx.beginPath();
    ctx.ellipse(150, 110, r, r * 0.8, 0.3, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.strokeStyle = '#c0392b';
  ctx.lineWidth = 3;
  ctx.setLineDash([6, 5]);
  ctx.beginPath();
  ctx.moveTo(30, 230);
  ctx.bezierCurveTo(80, 160, 200, 200, 150, 110);
  ctx.stroke();
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** Folded map for the pack slot (the open map is drawn live elsewhere). */
export function buildFoldedMap(): Group {
  const group = new Group();
  group.name = 'Map';
  const paper = new Mesh(new BoxGeometry(0.1, 0.012, 0.14), new MeshStandardMaterial({ map: mapTexture(), roughness: 0.9 }));
  group.add(paper);
  return group;
}

export function buildFlare(): Group {
  const group = new Group();
  group.name = 'Flare';
  const tubeMesh = new Mesh(new CylinderGeometry(0.018, 0.018, 0.22, 12), new MeshStandardMaterial({ color: 0xd62828, roughness: 0.6 }));
  tubeMesh.rotation.x = Math.PI / 2;
  const capMesh = new Mesh(new CylinderGeometry(0.02, 0.02, 0.03, 12), rubber);
  capMesh.rotation.x = Math.PI / 2;
  capMesh.position.z = -0.12;
  group.add(tubeMesh, capMesh);
  return group;
}

export function buildPackedGlider(): Group {
  const group = new Group();
  group.name = 'PackedGlider';
  const bag = new Mesh(new CylinderGeometry(0.06, 0.06, 0.5, 14), new MeshStandardMaterial({ color: 0xe8573a, roughness: 0.7 }));
  bag.rotation.z = Math.PI / 2;
  const strap = new Mesh(new TorusGeometry(0.062, 0.006, 6, 18), rubber);
  strap.rotation.y = Math.PI / 2;
  const strap2 = strap.clone();
  strap.position.x = -0.15;
  strap2.position.x = 0.15;
  group.add(bag, strap, strap2);
  return group;
}

function buildPolePair(): Group {
  const group = new Group();
  group.name = 'PolePair';
  for (const side of [-1, 1]) {
    const pole = buildPole();
    pole.scale.setScalar(0.32);
    pole.position.x = side * 0.015;
    pole.rotation.x = Math.PI / 2;
    pole.position.y = 0.18;
    group.add(pole);
  }
  return group;
}

function buildAxePair(): Group {
  const group = new Group();
  for (const side of [-1, 1]) {
    const axe = buildIceAxe();
    axe.scale.setScalar(0.45);
    axe.rotation.x = -Math.PI / 2;
    axe.position.x = side * 0.025;
    group.add(axe);
  }
  return group;
}

/** Full-size model held in a hand. */
export function buildHeldItem(item: ItemId): Object3D | null {
  switch (item) {
    case 'axes':
      return buildIceAxe();
    case 'carabiner':
      return buildCarabiner();
    case 'headlamp':
      return buildHeadlamp();
    case 'thermos':
      return buildThermos();
    case 'warmer':
      return buildWarmer();
    case 'map':
      return null; // the open map is drawn by the backpack system
    case 'flare':
      return buildFlare();
    case 'glider':
      return buildPackedGlider();
    case 'poles':
    default:
      return null; // poles are drawn by the pole system
  }
}

/** Small icon model for a backpack slot (roughly 8-10 cm across). */
export function buildSlotIcon(item: ItemId): Object3D {
  let icon: Object3D;
  switch (item) {
    case 'poles':
      icon = buildPolePair();
      break;
    case 'axes':
      icon = buildAxePair();
      break;
    case 'carabiner':
      icon = buildCarabiner();
      icon.scale.setScalar(1.2);
      break;
    case 'headlamp':
      icon = buildHeadlamp();
      icon.scale.setScalar(0.55);
      break;
    case 'thermos':
      icon = buildThermos();
      icon.rotation.x = -Math.PI / 2;
      icon.scale.setScalar(0.45);
      break;
    case 'warmer':
      icon = buildWarmer();
      icon.rotation.x = Math.PI / 2.5;
      break;
    case 'map':
      icon = buildFoldedMap();
      icon.rotation.x = Math.PI / 2.4;
      break;
    case 'flare':
      icon = buildFlare();
      icon.rotation.x = -Math.PI / 2;
      icon.scale.setScalar(0.5);
      break;
    case 'glider':
    default:
      icon = buildPackedGlider();
      icon.scale.setScalar(0.22);
      break;
  }
  const holder = new Group();
  holder.add(icon);
  return holder;
}

/** The open backpack: a rucksack body with its lid flipped back. */
export function disposeIcon(object: Object3D): void {
  object.traverse((child) => {
    const mesh = child as Mesh;
    if (mesh.isMesh) (mesh.geometry as BufferGeometry).dispose();
  });
}
