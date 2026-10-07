/**
 * Merge builders: many primitives into one BufferGeometry (one draw call),
 * or many copies of one geometry into one InstancedMesh.
 *
 * Geometry is accumulated in world coordinates (doubles) and written out
 * relative to a local origin, so vertices stay small and precise even at
 * z ~ -9000 (the mesh is then positioned at that origin).
 */

import {
  BufferGeometry,
  Color,
  Euler,
  Float32BufferAttribute,
  InstancedMesh,
  type Material,
  Matrix4,
  Mesh,
  Quaternion,
  Vector3,
} from '@iwsdk/core';

/** Vertex colour from the world position, world normal and the geometry-local position. */
export type ColorFn = (p: Vector3, n: Vector3, out: Color, local: Vector3) => void;
/** Per-vertex extra attribute (vec4): meaning depends on the material. */
export type Fx = readonly [number, number, number, number];
export type FxFn = (p: Vector3, n: Vector3, local: Vector3, out: number[]) => void;

export const NO_FX: Fx = [0, 0, 0, 0];

const p = new Vector3();
const n = new Vector3();
const lp = new Vector3();
const c = new Color();
const nm = new Matrix4();
const fxOut = [0, 0, 0, 0];

export class Batch {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly col: number[] = [];
  readonly uv: number[] = [];
  readonly fx: number[] = [];

  constructor(
    /** Name of the extra vec4 attribute ('aFx', 'aFlap'), or null for none. */
    readonly fxName: string | null = 'aFx',
    readonly withUv = false,
  ) {}

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  /**
   * Append `geometry` transformed by `matrix`. UVs (if kept) are scaled by
   * `uvScale`. The geometry is disposed afterwards unless `keep` is set
   * (for shared templates).
   */
  add(geometry: BufferGeometry, matrix: Matrix4, color: Color | ColorFn, fx: Fx | FxFn = NO_FX, uvScale = 1, keep = false): this {
    const geo = geometry.index ? geometry.toNonIndexed() : geometry;
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    const pa = geo.getAttribute('position');
    const na = geo.getAttribute('normal');
    const ua = geo.getAttribute('uv');
    nm.copy(matrix).invert().transpose();
    for (let i = 0; i < pa.count; i++) {
      lp.fromBufferAttribute(pa, i);
      p.copy(lp).applyMatrix4(matrix);
      n.fromBufferAttribute(na, i).transformDirection(nm);
      this.pos.push(p.x, p.y, p.z);
      this.nor.push(n.x, n.y, n.z);
      if (typeof color === 'function') color(p, n, c, lp);
      else c.copy(color);
      this.col.push(c.r, c.g, c.b);
      if (this.withUv) {
        if (ua) this.uv.push(ua.getX(i) * uvScale, ua.getY(i) * uvScale);
        else this.uv.push(p.x * uvScale, p.y * uvScale);
      }
      if (this.fxName) {
        if (typeof fx === 'function') {
          fx(p, n, lp, fxOut);
          this.fx.push(fxOut[0], fxOut[1], fxOut[2], fxOut[3]);
        } else this.fx.push(fx[0], fx[1], fx[2], fx[3]);
      }
    }
    if (geo !== geometry) geo.dispose();
    if (!keep) geometry.dispose();
    return this;
  }

  /** Append one triangle with explicit data (flat normal if none given). */
  tri(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    color: Color,
    fx: Fx = NO_FX,
    uvs?: readonly [number, number, number, number, number, number],
  ): void {
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    this.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    for (let k = 0; k < 3; k++) {
      this.nor.push(nx, ny, nz);
      this.col.push(color.r, color.g, color.b);
      if (this.fxName) this.fx.push(fx[0], fx[1], fx[2], fx[3]);
    }
    if (this.withUv) {
      if (uvs) this.uv.push(...uvs);
      else this.uv.push(ax, az, bx, bz, cx, cz);
    }
  }

  /** Append one vertex with explicit attributes (call in threes). */
  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, color: Color, fx: Fx = NO_FX, u = 0, v = 0): void {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.col.push(color.r, color.g, color.b);
    if (this.withUv) this.uv.push(u, v);
    if (this.fxName) this.fx.push(fx[0], fx[1], fx[2], fx[3]);
  }

  /** Build a geometry with positions relative to `origin`. */
  build(origin: Vector3): BufferGeometry {
    const count = this.pos.length / 3;
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = this.pos[i * 3] - origin.x;
      pos[i * 3 + 1] = this.pos[i * 3 + 1] - origin.y;
      pos[i * 3 + 2] = this.pos[i * 3 + 2] - origin.z;
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new Float32BufferAttribute(this.col, 3));
    if (this.withUv) g.setAttribute('uv', new Float32BufferAttribute(this.uv, 2));
    if (this.fxName) g.setAttribute(this.fxName, new Float32BufferAttribute(this.fx, 4));
    g.computeBoundingSphere();
    return g;
  }

  /** A mesh at `origin`, or null when empty. */
  mesh(origin: Vector3, material: Material, name: string, shadows = true): Mesh | null {
    if (this.pos.length === 0) return null;
    const mesh = new Mesh(this.build(origin), material);
    mesh.position.copy(origin);
    mesh.name = name;
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return mesh;
  }
}

const tq = new Quaternion();
const tv = new Vector3();
const ts = new Vector3();
const tm = new Matrix4();

/** Instances of one geometry (world transforms, written relative to an origin). */
export class InstanceList {
  readonly matrices: Matrix4[] = [];
  readonly colors: Color[] = [];

  push(x: number, y: number, z: number, q: Quaternion, sx: number, sy: number, sz: number, color?: Color): void {
    this.matrices.push(new Matrix4().compose(tv.set(x, y, z), q, ts.set(sx, sy, sz)));
    this.colors.push(color ? color.clone() : new Color(1, 1, 1));
  }

  get count(): number {
    return this.matrices.length;
  }

  mesh(origin: Vector3, geometry: BufferGeometry, material: Material, name: string, shadows = true, tinted = true): InstancedMesh | null {
    if (this.matrices.length === 0) return null;
    const mesh = new InstancedMesh(geometry, material, this.matrices.length);
    for (let i = 0; i < this.matrices.length; i++) {
      tm.copy(this.matrices[i]);
      tm.elements[12] -= origin.x;
      tm.elements[13] -= origin.y;
      tm.elements[14] -= origin.z;
      mesh.setMatrixAt(i, tm);
      if (tinted) mesh.setColorAt(i, this.colors[i]);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.position.copy(origin);
    mesh.computeBoundingSphere();
    mesh.name = name;
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return mesh;
  }
}

/** Random-ish rotation from a yaw plus a small tilt. */
const te = new Euler();
export function tiltedYaw(yaw: number, tiltX: number, tiltZ: number, out = tq): Quaternion {
  return out.setFromEuler(te.set(tiltX, yaw, tiltZ, 'YXZ'));
}
