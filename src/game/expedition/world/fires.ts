/**
 * Camp fires on the expedition: the tutorial's Bonfire (animated flames,
 * sparks, smoke, beacon glow) with `light: false`, its log stack and stone
 * ring merged from ~20-40 meshes down to one per material so a camp fire
 * costs ~9 draw calls instead of ~35.
 */

import {
  BufferGeometry,
  Float32BufferAttribute,
  type Group,
  type Material,
  Matrix3,
  Mesh,
  Vector3,
} from '@iwsdk/core';
import { Bonfire } from '../../campfire.js';

/** Merge a group's child meshes into one mesh per material (same group transform). */
export function compactGroup(group: Group): void {
  const byMaterial = new Map<Material, Mesh[]>();
  for (const child of group.children) {
    const mesh = child as Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material)) continue;
    const list = byMaterial.get(mesh.material) ?? [];
    list.push(mesh);
    byMaterial.set(mesh.material, list);
  }
  const p = new Vector3();
  const n = new Vector3();
  const nm = new Matrix3();
  const merged: Mesh[] = [];
  for (const [material, meshes] of byMaterial) {
    const pos: number[] = [];
    const nor: number[] = [];
    const uv: number[] = [];
    for (const mesh of meshes) {
      mesh.updateMatrix();
      nm.getNormalMatrix(mesh.matrix);
      const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
      const pa = g.getAttribute('position');
      const na = g.getAttribute('normal');
      const ua = g.getAttribute('uv');
      for (let i = 0; i < pa.count; i++) {
        p.fromBufferAttribute(pa, i).applyMatrix4(mesh.matrix);
        n.fromBufferAttribute(na, i).applyMatrix3(nm).normalize();
        pos.push(p.x, p.y, p.z);
        nor.push(n.x, n.y, n.z);
        if (ua) uv.push(ua.getX(i), ua.getY(i));
        else uv.push(0, 0);
      }
      if (g !== mesh.geometry) g.dispose();
      mesh.geometry.dispose();
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new Float32BufferAttribute(nor, 3));
    geo.setAttribute('uv', new Float32BufferAttribute(uv, 2));
    geo.computeBoundingSphere();
    const m = new Mesh(geo, material);
    m.castShadow = true;
    m.receiveShadow = true;
    merged.push(m);
  }
  for (const list of byMaterial.values()) for (const mesh of list) group.remove(mesh);
  for (const m of merged) group.add(m);
}

/** A camp fire (no point light) with its log stack merged. */
export function createCampFire(x: number, y: number, z: number, scale: number): Bonfire {
  const fire = new Bonfire(new Vector3(x, y, z), { scale, party: false, light: false });
  const logs = fire.objects[0] as Group;
  if (logs && logs.name === 'Bonfire') compactGroup(logs);
  return fire;
}
