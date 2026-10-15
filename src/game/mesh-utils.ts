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

export interface GeometryBuilderOptions {
  /**
   * Grow every piece by a hair (0.5 to 2.9 mm, a different amount for each
   * of seven pieces in turn) so faces meant to sit flush (a rail over its
   * post, a crossbar on its upright, overlapping footing stones) never
   * share a plane. Shared planes z-fight: in a headset they shimmer and
   * crawl as you move your head.
   */
  separate?: boolean;
}

/** World-space growth steps for `separate` pieces (metres). */
const SEPARATE_STEPS = [0.0005, 0.0009, 0.0013, 0.0017, 0.0021, 0.0025, 0.0029];

export class GeometryBuilder {
  private positions: number[] = [];
  private normals: number[] = [];
  private colors: number[] = [];
  private readonly p = new Vector3();
  private readonly n = new Vector3();
  private readonly c = new Color();
  private readonly normalMatrix = new Matrix4();
  private readonly separate: boolean;
  private pieces = 0;
  private readonly grown = new Matrix4();
  private readonly grow = new Matrix4();
  private readonly centre = new Vector3();
  private readonly half = new Vector3();
  private readonly axis = new Vector3();

  constructor(options: GeometryBuilderOptions = {}) {
    this.separate = options.separate ?? false;
  }

  /**
   * `matrix` with the piece grown about its own centre by this piece's
   * separation step, in world units whatever the matrix's scale (and never
   * by more than a tenth of the piece's thickness).
   */
  private separated(geometry: BufferGeometry, matrix: Matrix4): Matrix4 {
    const step = SEPARATE_STEPS[(this.pieces++ * 3) % SEPARATE_STEPS.length];
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    box.getCenter(this.centre);
    box.getSize(this.half).multiplyScalar(0.5);
    const e = matrix.elements;
    const scale = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const h = this.half.getComponent(k);
      const world = this.axis.set(e[k * 4], e[k * 4 + 1], e[k * 4 + 2]).length();
      // Flat pieces (a plane) stay flat; everything else grows outward.
      scale[k] = h > 1e-5 && world > 1e-9 ? 1 + Math.min(step / world, h * 0.1) / h : 1;
    }
    this.grow
      .makeTranslation(-this.centre.x, -this.centre.y, -this.centre.z)
      .premultiply(this.grown.makeScale(scale[0], scale[1], scale[2]))
      .premultiply(this.grown.makeTranslation(this.centre.x, this.centre.y, this.centre.z));
    return this.grown.copy(matrix).multiply(this.grow);
  }

  /**
   * Append a geometry transformed by `matrix`, coloured either uniformly or
   * per vertex via a callback that receives the transformed position/normal.
   */
  add(geometry: BufferGeometry, matrix: Matrix4, color: Color | ColorFn): this {
    if (this.separate) matrix = this.separated(geometry, matrix);
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
