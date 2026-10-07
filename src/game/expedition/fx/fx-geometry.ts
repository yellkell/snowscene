/**
 * Small procedural shapes for the set pieces: lumpy faceted blocks (snow
 * debris, ice blocks, rocks) and a palette-coloured version for merging.
 */

import { BufferGeometry, Color, Float32BufferAttribute, IcosahedronGeometry, Matrix4, Vector3 } from '@iwsdk/core';
import { mulberry32 } from '../../terrain.js';

/**
 * A faceted lump: an icosahedron with its corners pushed in and out
 * (coincident corners move together so the faces stay closed) and squashed.
 */
export function lumpGeometry(
  seed: number,
  jitter = 0.28,
  sx = 1,
  sy = 0.8,
  sz = 1,
  detail = 0,
): BufferGeometry {
  const geo = new IcosahedronGeometry(1, detail);
  const pos = geo.getAttribute('position');
  const rand = mulberry32(seed);
  const offsets = new Map<string, number>();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const key = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
    let k = offsets.get(key);
    if (k === undefined) {
      k = 1 + (rand() - 0.5) * 2 * jitter;
      offsets.set(key, k);
    }
    pos.setXYZ(i, x * k * sx, y * k * sy, z * k * sz);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Bake a per-vertex colour (with gentle variation) into a geometry. */
export function colourGeometry(geo: BufferGeometry, base: Color, variation: number, seed: number): BufferGeometry {
  const rand = mulberry32(seed);
  const n = geo.getAttribute('position').count;
  const colors = new Float32Array(n * 3);
  // One shade per triangle keeps the faceted look.
  for (let i = 0; i < n; i += 3) {
    const k = 1 + (rand() - 0.5) * 2 * variation;
    for (let j = 0; j < 3 && i + j < n; j++) {
      colors[(i + j) * 3] = base.r * k;
      colors[(i + j) * 3 + 1] = base.g * k;
      colors[(i + j) * 3 + 2] = base.b * k;
    }
  }
  geo.setAttribute('color', new Float32BufferAttribute(colors, 3));
  return geo;
}

const tmpV = new Vector3();

/** Merge non-indexed geometries (position, normal, color) under matrices. */
export function mergeGeometries(parts: Array<{ geo: BufferGeometry; matrix: Matrix4 }>): BufferGeometry {
  let total = 0;
  for (const p of parts) total += p.geo.getAttribute('position').count;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  let o = 0;
  const normalMatrix = new Matrix4();
  for (const p of parts) {
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
    const pa = g.getAttribute('position');
    const na = g.getAttribute('normal');
    const ca = g.getAttribute('color');
    normalMatrix.copy(p.matrix).invert().transpose();
    for (let i = 0; i < pa.count; i++, o++) {
      tmpV.fromBufferAttribute(pa, i).applyMatrix4(p.matrix);
      pos[o * 3] = tmpV.x;
      pos[o * 3 + 1] = tmpV.y;
      pos[o * 3 + 2] = tmpV.z;
      tmpV.fromBufferAttribute(na, i).transformDirection(normalMatrix);
      nor[o * 3] = tmpV.x;
      nor[o * 3 + 1] = tmpV.y;
      nor[o * 3 + 2] = tmpV.z;
      col[o * 3] = ca ? ca.getX(i) : 1;
      col[o * 3 + 1] = ca ? ca.getY(i) : 1;
      col[o * 3 + 2] = ca ? ca.getZ(i) : 1;
    }
    if (g !== p.geo) g.dispose();
    p.geo.dispose();
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new Float32BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}
