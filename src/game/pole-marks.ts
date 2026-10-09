/**
 * Pole holes in the snow: every time a pole tip plants, it leaves a little
 * crater (a dark hole with a pushed-up rim) lying on the slope, so your
 * strides leave a trail behind you. One instanced draw; the oldest holes are
 * reused once the trail is long enough.
 */

import {
  CanvasTexture,
  CircleGeometry,
  Color,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  SRGBColorSpace,
  Vector3,
} from '@iwsdk/core';

/** How many holes the trail keeps (about 150 strides). */
const MAX_MARKS = 320;
const RADIUS = 0.085;

function holeTexture(): CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const c = size / 2;
  // A soft blue-grey shadowed rim fading out into the snow, a darker hole.
  const rim = ctx.createRadialGradient(c, c, 0, c, c, c);
  rim.addColorStop(0, 'rgba(48,62,92,1)');
  rim.addColorStop(0.3, 'rgba(66,82,116,0.95)');
  rim.addColorStop(0.45, 'rgba(120,140,175,0.8)');
  rim.addColorStop(0.7, 'rgba(190,205,228,0.5)');
  rim.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = rim;
  ctx.fillRect(0, 0, size, size);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

export class PoleMarks {
  readonly mesh: InstancedMesh;
  private next = 0;
  private count = 0;
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly spin = new Quaternion();
  private readonly n = new Vector3();
  private readonly p = new Vector3();
  private readonly s = new Vector3();
  private readonly up = new Vector3(0, 0, 1);
  private readonly tint = new Color();

  constructor() {
    const material = new MeshStandardMaterial({
      map: holeTexture(),
      transparent: true,
      depthWrite: false,
      roughness: 1,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.mesh = new InstancedMesh(new CircleGeometry(RADIUS, 16), material, MAX_MARKS);
    this.mesh.name = 'PoleMarks';
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  /**
   * Leave a hole at (x, z) on the ground, lying on the slope there.
   * `groundAt` gives the walkable height used for the slope.
   */
  add(x: number, z: number, groundAt: (x: number, z: number) => number): void {
    const e = 0.3;
    const y = groundAt(x, z);
    const dx = groundAt(x + e, z) - groundAt(x - e, z);
    const dz = groundAt(x, z + e) - groundAt(x, z - e);
    this.n.set(-dx, 2 * e, -dz).normalize();
    // The circle faces +Z: turn it to face up the slope normal, with a random twist.
    this.q.setFromUnitVectors(this.up, this.n);
    this.spin.setFromAxisAngle(this.up, Math.random() * Math.PI * 2);
    this.q.multiply(this.spin);
    this.p.set(x, y + 0.02, z);
    const size = 0.8 + Math.random() * 0.45;
    this.s.set(size, size * (0.85 + Math.random() * 0.3), 1);
    this.m.compose(this.p, this.q, this.s);
    this.mesh.setMatrixAt(this.next, this.m);
    this.tint.setScalar(0.92 + Math.random() * 0.08);
    this.mesh.setColorAt(this.next, this.tint);
    this.next = (this.next + 1) % MAX_MARKS;
    this.count = Math.min(MAX_MARKS, this.count + 1);
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Wipe the trail (restart, or a new mountain). */
  clear(): void {
    this.next = 0;
    this.count = 0;
    this.mesh.count = 0;
  }
}
