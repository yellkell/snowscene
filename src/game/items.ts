/**
 * Procedural models for the gear in your backpack (the walking poles and the
 * tutorial glider's parts), plus how each lies in its slot. Each held
 * model's origin is the point you hold it by, so it can be placed straight
 * onto a grip pose.
 */

import { Box3, type BufferGeometry, Group, Mesh, Object3D, Vector3 } from '@iwsdk/core';
import type { ItemId } from './equipment.js';
import { buildGlider, type GliderPartId } from './glider-model.js';
import { buildPole } from './world-builders.js';
import { upgradeMesh } from './baked/dynamic.js';

// -------------------------------------------------------------- pairs ---

function buildPolePair(): Group {
  const group = new Group();
  group.name = 'PolePair';
  // Side by side, a little apart, baskets level.
  for (const side of [-1, 1]) {
    const pole = buildPole();
    upgradeMesh(pole, 'pole');
    pole.position.x = side * 0.03;
    group.add(pole);
  }
  return group;
}

/** Full-size model held in a hand. */
export function buildHeldItem(item: ItemId): Object3D | null {
  switch (item) {
    case 'leftWing':
      return buildGliderPart('LeftWing', 0.5);
    case 'rightWing':
      return buildGliderPart('RightWing', 0.5);
    case 'controlBar':
      return buildGliderPart('ControlBar', 0.5);
    case 'poles':
    default:
      return null; // poles are drawn by the pole system
  }
}

/** One part of the tutorial glider on its own, at `scale`. */
function buildGliderPart(id: GliderPartId, scale: number): Object3D {
  const part = buildGlider().parts[id];
  part.removeFromParent();
  part.position.set(0, 0, 0);
  const holder = new Group();
  holder.add(part);
  holder.scale.setScalar(scale);
  return holder;
}

/**
 * How each piece lies in its slot (slot frame: X across the tray, Y up out
 * of it toward you, Z down the tray toward you). Long things lie along the
 * slot's diagonal, faces and labels up; the icon is scaled to the slot by
 * the backpack afterwards.
 */
export function buildSlotIcon(item: ItemId): Object3D {
  let icon: Object3D;
  const diagonal = Math.PI / 4;
  switch (item) {
    case 'poles':
      icon = buildPolePair();
      icon.rotation.y = diagonal;
      break;
    case 'leftWing':
    case 'rightWing':
      // Lying flat in the slot, so you see the wing's shape from above.
      icon = buildGliderPart(item === 'leftWing' ? 'LeftWing' : 'RightWing', 1);
      icon.position.y = 0.01;
      break;
    case 'controlBar':
    default:
      icon = buildGliderPart('ControlBar', 1);
      break;
  }
  // Centred in the slot, resting on its floor.
  const holder = new Group();
  holder.add(icon);
  icon.updateMatrixWorld(true);
  const box = new Box3().setFromObject(icon);
  const c = box.getCenter(new Vector3());
  icon.position.x -= c.x;
  icon.position.z -= c.z;
  icon.position.y -= box.min.y;
  return holder;
}

export function disposeIcon(object: Object3D): void {
  object.traverse((child) => {
    const m = child as Mesh;
    if (m.isMesh) (m.geometry as BufferGeometry).dispose();
  });
}
