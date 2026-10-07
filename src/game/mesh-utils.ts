/**
 * Small helpers for building merged, vertex-coloured procedural geometry
 * without pulling in three/addons (which would duplicate the Three.js
 * instance IWSDK re-exports).
 */

import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Matrix4,
  Quaternion,
  Vector3,
} from '@iwsdk/core';

export type ColorFn = (position: Vector3, normal: Vector3, out: Color) => void;

export class GeometryBuilder {
  private positions: number[] = [];
  private normals: number[] = [];
  private colors: number[] = [];
  private readonly p = new Vector3();
  private readonly n = new Vector3();
  private readonly c = new Color();
  private readonly normalMatrix = new Matrix4();

  /**
   * Append a geometry transformed by `matrix`, coloured either uniformly or
   * per vertex via a callback that receives the transformed position/normal.
   */
  add(geometry: BufferGeometry, matrix: Matrix4, color: Color | ColorFn): this {
    const geo = geometry.index ? geometry.toNonIndexed() : geometry;
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    const pos = geo.getAttribute('position');
    const nor = geo.getAttribute('normal');
    this.normalMatrix.copy(matrix).invert().transpose();
    for (let i = 0; i < pos.count; i++) {
      this.p.fromBufferAttribute(pos, i).applyMatrix4(matrix);
      this.n.fromBufferAttribute(nor, i).transformDirection(this.normalMatrix);
      this.positions.push(this.p.x, this.p.y, this.p.z);
      this.normals.push(this.n.x, this.n.y, this.n.z);
      if (typeof color === 'function') color(this.p, this.n, this.c);
      else this.c.copy(color);
      this.colors.push(this.c.r, this.c.g, this.c.b);
    }
    if (geo !== geometry) geo.dispose();
    geometry.dispose();
    return this;
  }

  build(): BufferGeometry {
    const out = new BufferGeometry();
    out.setAttribute('position', new Float32BufferAttribute(this.positions, 3));
    out.setAttribute('normal', new Float32BufferAttribute(this.normals, 3));
    out.setAttribute('color', new Float32BufferAttribute(this.colors, 3));
    out.computeBoundingSphere();
    return out;
  }
}

const IDENTITY = new Matrix4();
const tmpMatrix = new Matrix4();
const tmpUp = new Vector3();
const tmpDir = new Vector3();
const tmpQuat = new Quaternion();

export function identity(): Matrix4 {
  return IDENTITY;
}

/** Translation (+ optional uniform/axis scale and Y rotation) matrix. */
export function placed(
  x: number,
  y: number,
  z: number,
  rotY = 0,
  sx = 1,
  sy = sx,
  sz = sx,
): Matrix4 {
  return new Matrix4()
    .makeRotationY(rotY)
    .scale(new Vector3(sx, sy, sz))
    .setPosition(x, y, z);
}

/**
 * Matrix that maps a unit-height Y-aligned cylinder centred at the origin
 * onto the segment from `a` to `b`.
 */
export function segmentMatrix(a: Vector3, b: Vector3, out = new Matrix4()): Matrix4 {
  tmpDir.subVectors(b, a);
  const length = tmpDir.length();
  tmpDir.normalize();
  tmpUp.set(0, 1, 0);
  tmpQuat.setFromUnitVectors(tmpUp, tmpDir);
  out.makeRotationFromQuaternion(tmpQuat);
  tmpMatrix.makeScale(1, length, 1);
  out.multiply(tmpMatrix);
  out.setPosition((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return out;
}
