/**
 * Snow Survivors' weapons and pickups, drawn: pooled and instanced so a
 * screen full of bolts, swords, crystals and lightning costs a handful of
 * draws. The survivors system owns the rules; these only hold state that
 * moves on its own (a bolt's flight, a crystal's bob) and draw it.
 */

import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  type Group,
  IcosahedronGeometry,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  OctahedronGeometry,
  Quaternion,
  RingGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector3,
} from '@iwsdk/core';
import { GeometryBuilder, placed } from '../mesh-utils.js';
import { duneHeight } from './survivors-level.js';

const tmpM = new Matrix4();
const tmpQ = new Quaternion();
const tmpS = new Vector3();
const tmpP = new Vector3();
const UP = new Vector3(0, 1, 0);
const tmpC = new Color();

// ------------------------------------------------------------- bolts ---

export const BOLT_CAP = 700;

/** Flying projectiles: icicles at the nearest, compass shards every way. */
export class Bolts {
  readonly mesh: InstancedMesh;
  n = 0;
  readonly x = new Float32Array(BOLT_CAP);
  readonly y = new Float32Array(BOLT_CAP);
  readonly z = new Float32Array(BOLT_CAP);
  readonly vx = new Float32Array(BOLT_CAP);
  readonly vz = new Float32Array(BOLT_CAP);
  readonly life = new Float32Array(BOLT_CAP);
  readonly dmg = new Float32Array(BOLT_CAP);
  readonly radius = new Float32Array(BOLT_CAP);
  readonly pierce = new Int16Array(BOLT_CAP);
  /** Seconds before it can hit again (it passes through what it just hit). */
  readonly cool = new Float32Array(BOLT_CAP);
  readonly color = new Uint32Array(BOLT_CAP);

  constructor(parent: Group) {
    const geo = new ConeGeometry(0.07, 0.75, 5).rotateX(Math.PI / 2);
    this.mesh = new InstancedMesh(geo, new MeshBasicMaterial({ toneMapped: false }), BOLT_CAP);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.setColorAt(0, tmpC.set(0xffffff));
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'Bolts';
    parent.add(this.mesh);
  }

  fire(x: number, y: number, z: number, dirX: number, dirZ: number, speed: number, dmg: number, radius: number, pierce: number, life: number, color: number): void {
    if (this.n >= BOLT_CAP) return;
    const i = this.n++;
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = z;
    this.vx[i] = dirX * speed;
    this.vz[i] = dirZ * speed;
    this.life[i] = life;
    this.dmg[i] = dmg;
    this.radius[i] = radius;
    this.pierce[i] = pierce;
    this.cool[i] = 0;
    this.color[i] = color;
  }

  /** Remove bolt i (swap the last one into its place). */
  remove(i: number): void {
    const j = --this.n;
    if (i === j) return;
    this.x[i] = this.x[j];
    this.y[i] = this.y[j];
    this.z[i] = this.z[j];
    this.vx[i] = this.vx[j];
    this.vz[i] = this.vz[j];
    this.life[i] = this.life[j];
    this.dmg[i] = this.dmg[j];
    this.radius[i] = this.radius[j];
    this.pierce[i] = this.pierce[j];
    this.cool[i] = this.cool[j];
    this.color[i] = this.color[j];
  }

  draw(): void {
    for (let i = 0; i < this.n; i++) {
      tmpP.set(this.x[i], this.y[i], this.z[i]);
      tmpQ.setFromAxisAngle(UP, Math.atan2(this.vx[i], this.vz[i]));
      const s = this.radius[i] / 0.35;
      tmpS.set(s, s, s);
      this.mesh.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS));
      this.mesh.setColorAt(i, tmpC.set(this.color[i]).multiplyScalar(1.6));
    }
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

// ------------------------------------------------------------ blades ---

export const BLADE_CAP = 14;

/** Swords that spin round you: a blade, a guard and a grip, glowing gold. */
export class Blades {
  readonly mesh: InstancedMesh;

  constructor(parent: Group) {
    const b = new GeometryBuilder();
    b.add(new BoxGeometry(0.07, 0.02, 0.9), placed(0, 0, 0.45), new Color(1.6, 1.5, 1.2));
    b.add(new ConeGeometry(0.05, 0.16, 4).rotateX(Math.PI / 2), placed(0, 0, 0.98), new Color(1.6, 1.5, 1.2));
    b.add(new BoxGeometry(0.3, 0.04, 0.05), placed(0, 0, 0), new Color(1.5, 1.0, 0.2));
    b.add(new CylinderGeometry(0.025, 0.025, 0.2, 6).rotateX(Math.PI / 2), placed(0, 0, -0.12), new Color(0.35, 0.18, 0.08));
    this.mesh = new InstancedMesh(b.build(), new MeshBasicMaterial({ vertexColors: true, toneMapped: false, side: DoubleSide }), BLADE_CAP);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'OrbitBlades';
    parent.add(this.mesh);
  }

  /** Lay out `count` swords on a circle round (x, y, z), pointing outward, spun to `angle`. */
  draw(count: number, x: number, y: number, z: number, radius: number, angle: number, size: number): void {
    for (let k = 0; k < count; k++) {
      const a = angle + (k / count) * Math.PI * 2;
      const dx = Math.sin(a);
      const dz = Math.cos(a);
      tmpP.set(x + dx * radius * 0.35, y, z + dz * radius * 0.35);
      tmpQ.setFromAxisAngle(UP, a);
      tmpS.set(size, size, size * (radius * 0.75));
      this.mesh.setMatrixAt(k, tmpM.compose(tmpP, tmpQ, tmpS));
    }
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// -------------------------------------------------------------- novas ---

/** Expanding rings of frost on the snow. */
export class Novas {
  private readonly rings: { mesh: Mesh; t: number; r: number }[] = [];

  constructor(parent: Group) {
    for (let k = 0; k < 6; k++) {
      const mesh = new Mesh(
        new RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2),
        new MeshBasicMaterial({ color: new Color(0.7, 0.6, 1.6), transparent: true, blending: AdditiveBlending, depthWrite: false, side: DoubleSide, toneMapped: false }),
      );
      mesh.visible = false;
      mesh.name = 'Nova';
      parent.add(mesh);
      this.rings.push({ mesh, t: 1, r: 1 });
    }
  }

  burst(x: number, z: number, radius: number, color: number): void {
    const ring = this.rings.find((r) => r.t >= 1) ?? this.rings[0];
    ring.t = 0;
    ring.r = radius;
    ring.mesh.position.set(x, 0.08 + duneHeight(x, z), z);
    (ring.mesh.material as MeshBasicMaterial).color.set(color).multiplyScalar(1.5);
    ring.mesh.visible = true;
  }

  tick(dt: number): void {
    for (const ring of this.rings) {
      if (ring.t >= 1) continue;
      ring.t = Math.min(1, ring.t + dt / 0.45);
      const e = 1 - Math.pow(1 - ring.t, 3);
      ring.mesh.scale.setScalar(Math.max(0.01, ring.r * e));
      (ring.mesh.material as MeshBasicMaterial).opacity = 1 - ring.t;
      if (ring.t >= 1) ring.mesh.visible = false;
    }
  }
}

// ------------------------------------------------------------ lightning ---

const ZAP_CAP = 96;

/** Jagged bolts between enemies, flickering out in a blink. */
export class Zaps {
  private readonly lines: LineSegments;
  private readonly pos = new Float32Array(ZAP_CAP * 2 * 3 * 4);
  private readonly age = new Float32Array(ZAP_CAP);
  private readonly seg = new Float32Array(ZAP_CAP * 6);
  private n = 0;

  constructor(parent: Group) {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage));
    this.lines = new LineSegments(geo, new LineBasicMaterial({ color: new Color(2.2, 2.1, 1.1), transparent: true, blending: AdditiveBlending, depthWrite: false, toneMapped: false }));
    this.lines.frustumCulled = false;
    this.lines.name = 'Lightning';
    parent.add(this.lines);
  }

  zap(ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
    const i = this.n < ZAP_CAP ? this.n++ : Math.floor(Math.random() * ZAP_CAP);
    this.seg.set([ax, ay, az, bx, by, bz], i * 6);
    this.age[i] = 0;
  }

  tick(dt: number): void {
    let w = 0;
    let v = 0;
    for (let i = 0; i < this.n; i++) {
      this.age[i] += dt;
      if (this.age[i] > 0.16) continue;
      if (w !== i) {
        this.seg.copyWithin(w * 6, i * 6, i * 6 + 6);
        this.age[w] = this.age[i];
      }
      // Four jagged pieces per bolt.
      const o = w * 6;
      let px = this.seg[o];
      let py = this.seg[o + 1];
      let pz = this.seg[o + 2];
      for (let k = 1; k <= 4; k++) {
        const t = k / 4;
        const j = k < 4 ? 0.35 : 0;
        const qx = this.seg[o] + (this.seg[o + 3] - this.seg[o]) * t + (Math.random() - 0.5) * j;
        const qy = this.seg[o + 1] + (this.seg[o + 4] - this.seg[o + 1]) * t + (Math.random() - 0.5) * j;
        const qz = this.seg[o + 2] + (this.seg[o + 5] - this.seg[o + 2]) * t + (Math.random() - 0.5) * j;
        this.pos.set([px, py, pz, qx, qy, qz], v);
        v += 6;
        px = qx;
        py = qy;
        pz = qz;
      }
      w++;
    }
    this.n = w;
    const geo = this.lines.geometry;
    geo.setDrawRange(0, v / 3);
    (geo.getAttribute('position') as BufferAttribute).needsUpdate = true;
    this.lines.visible = v > 0;
  }
}

// ------------------------------------------------------------ crystals ---

export const GEM_CAP = 1800;

/** Experience crystals on the snow: blue, green, red by worth. Pulled to you inside the magnet. */
export class Gems {
  readonly mesh: InstancedMesh;
  n = 0;
  readonly x = new Float32Array(GEM_CAP);
  readonly z = new Float32Array(GEM_CAP);
  readonly y = new Float32Array(GEM_CAP);
  readonly value = new Float32Array(GEM_CAP);
  /** Flying to you (once inside the magnet it never lets go). */
  readonly pulled = new Uint8Array(GEM_CAP);

  constructor(parent: Group) {
    this.mesh = new InstancedMesh(new OctahedronGeometry(0.11, 0), new MeshBasicMaterial({ toneMapped: false }), GEM_CAP);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.setColorAt(0, tmpC.set(0xffffff));
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'Crystals';
    parent.add(this.mesh);
  }

  drop(x: number, z: number, value: number): void {
    if (this.n >= GEM_CAP) {
      // Full: fold it into the oldest crystal instead of losing it.
      this.value[0] += value;
      return;
    }
    const i = this.n++;
    this.x[i] = x + (Math.random() - 0.5) * 0.4;
    this.z[i] = z + (Math.random() - 0.5) * 0.4;
    this.y[i] = 0.35 + duneHeight(this.x[i], this.z[i]);
    this.value[i] = value;
    this.pulled[i] = 0;
  }

  remove(i: number): void {
    const j = --this.n;
    if (i === j) return;
    this.x[i] = this.x[j];
    this.z[i] = this.z[j];
    this.y[i] = this.y[j];
    this.value[i] = this.value[j];
    this.pulled[i] = this.pulled[j];
  }

  draw(time: number): void {
    for (let i = 0; i < this.n; i++) {
      const v = this.value[i];
      const s = v >= 20 ? 2.1 : v >= 4 ? 1.5 : 1;
      tmpP.set(this.x[i], this.y[i] + Math.sin(time * 3 + i) * 0.06, this.z[i]);
      tmpQ.setFromAxisAngle(UP, time * 2 + i);
      tmpS.set(s, s * 1.4, s);
      this.mesh.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS));
      this.mesh.setColorAt(i, tmpC.set(v >= 20 ? 0xff4060 : v >= 4 ? 0x40ff90 : 0x40b8ff).multiplyScalar(1.5));
    }
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

// --------------------------------------------------------- upgrade orbs ---

/** A floating label: the upgrade's name on a dark pill, always facing you. */
function labelSprite(text: string, color: string): Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(10,14,28,0.82)';
  ctx.beginPath();
  ctx.roundRect(6, 14, 500, 100, 50);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let size = 60;
  ctx.font = `800 ${size}px system-ui, sans-serif`;
  while (ctx.measureText(text).width > 450 && size > 24) {
    size -= 4;
    ctx.font = `800 ${size}px system-ui, sans-serif`;
  }
  ctx.fillText(text, 256, 66);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const sprite = new Sprite(new SpriteMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false }));
  sprite.scale.set(1.2, 0.3, 1);
  return sprite;
}

export interface Orb {
  root: Object3D;
  gem: Mesh;
  label: Sprite;
  x: number;
  z: number;
  upgradeId: string;
  active: boolean;
  age: number;
}

/** Glowing upgrade orbs on the snow, each named, waiting for you to walk into them. */
export class Orbs {
  readonly list: Orb[] = [];
  private readonly parent: Group;
  private readonly geo = new IcosahedronGeometry(0.28, 0);

  constructor(parent: Group) {
    this.parent = parent;
  }

  drop(x: number, z: number, upgradeId: string, name: string, color: string): void {
    let orb = this.list.find((o) => !o.active);
    if (!orb) {
      const root = new Object3D();
      const gem = new Mesh(this.geo, new MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 1.4, roughness: 0.3, flatShading: true }));
      root.add(gem);
      const label = labelSprite('', '#fff');
      root.add(label);
      this.parent.add(root);
      orb = { root, gem, label, x, z, upgradeId, active: true, age: 0 };
      this.list.push(orb);
    }
    // A fresh label for this upgrade.
    const old = orb.label;
    orb.root.remove(old);
    old.material.map?.dispose();
    old.material.dispose();
    orb.label = labelSprite(name, color);
    orb.label.position.y = 0.7;
    orb.root.add(orb.label);
    (orb.gem.material as MeshStandardMaterial).color.set(color);
    (orb.gem.material as MeshStandardMaterial).emissive.set(color);
    orb.x = x;
    orb.z = z;
    orb.upgradeId = upgradeId;
    orb.active = true;
    orb.age = 0;
    orb.root.visible = true;
    orb.root.position.set(x, 0.8 + duneHeight(x, z), z);
  }

  tick(dt: number, time: number): void {
    for (const orb of this.list) {
      if (!orb.active) continue;
      orb.age += dt;
      orb.root.position.set(orb.x, 0.8 + duneHeight(orb.x, orb.z) + Math.sin(time * 2.4 + orb.x) * 0.12, orb.z);
      orb.gem.rotation.y = time * 1.6;
      orb.gem.rotation.x = time * 0.9;
      orb.gem.scale.setScalar(Math.min(1, orb.age * 3) * (1 + 0.1 * Math.sin(time * 6)));
    }
  }

  take(orb: Orb): void {
    orb.active = false;
    orb.root.visible = false;
  }

  clear(): void {
    for (const orb of this.list) this.take(orb);
  }
}

// --------------------------------------------------------------- chests ---

export interface Chest {
  root: Object3D;
  lid: Object3D;
  beam: Mesh;
  x: number;
  z: number;
  active: boolean;
  opening: number;
  /** Snow height where it stands. */
  ground: number;
}

/** Treasure chests with a pillar of light over them: walk into one for a burst of upgrades. */
export class Chests {
  readonly list: Chest[] = [];

  constructor(parent: Group) {
    for (let k = 0; k < 3; k++) {
      const root = new Object3D();
      const wood = new MeshStandardMaterial({ color: 0x7a4a26, roughness: 0.8 });
      const gold = new MeshStandardMaterial({ color: 0xffc94a, emissive: 0xffaa00, emissiveIntensity: 0.6, metalness: 0.6, roughness: 0.35 });
      const body = new Mesh(new BoxGeometry(0.9, 0.55, 0.6), wood);
      body.position.y = 0.275;
      root.add(body);
      const band = new Mesh(new BoxGeometry(0.94, 0.08, 0.64), gold);
      band.position.y = 0.4;
      root.add(band);
      const lid = new Object3D();
      lid.position.set(0, 0.55, -0.3);
      const lidMesh = new Mesh(new CylinderGeometry(0.3, 0.3, 0.9, 10, 1, false, 0, Math.PI).rotateZ(Math.PI / 2), wood);
      lidMesh.position.z = 0.3;
      lid.add(lidMesh);
      const lock = new Mesh(new BoxGeometry(0.12, 0.16, 0.06), gold);
      lock.position.set(0, 0.05, 0.62);
      lid.add(lock);
      root.add(lid);
      const beam = new Mesh(
        new CylinderGeometry(0.35, 0.9, 40, 16, 1, true),
        new MeshBasicMaterial({ color: new Color(1.4, 1.1, 0.4), transparent: true, opacity: 0.22, blending: AdditiveBlending, depthWrite: false, side: DoubleSide, toneMapped: false, fog: false }),
      );
      beam.position.y = 20;
      root.add(beam);
      root.visible = false;
      root.name = 'Chest';
      parent.add(root);
      this.list.push({ root, lid, beam, x: 0, z: 0, active: false, opening: -1, ground: 0 });
    }
  }

  place(x: number, z: number): boolean {
    const chest = this.list.find((c) => !c.active && c.opening < 0);
    if (!chest) return false;
    chest.x = x;
    chest.z = z;
    chest.active = true;
    chest.opening = -1;
    chest.ground = duneHeight(x, z);
    chest.root.position.set(x, chest.ground, z);
    chest.root.rotation.y = Math.random() * Math.PI * 2;
    chest.lid.rotation.x = 0;
    chest.beam.visible = true;
    chest.root.visible = true;
    return true;
  }

  tick(dt: number, time: number): void {
    for (const chest of this.list) {
      if (!chest.root.visible) continue;
      (chest.beam.material as MeshBasicMaterial).opacity = 0.16 + 0.08 * Math.sin(time * 3);
      if (chest.opening >= 0) {
        // The lid flies open, then the chest sinks away.
        chest.opening += dt;
        chest.lid.rotation.x = -Math.min(1.9, chest.opening * 7);
        chest.beam.visible = false;
        if (chest.opening > 1.6) {
          chest.root.position.y = chest.ground - (chest.opening - 1.6) * 1.5;
          if (chest.opening > 2.4) {
            chest.root.visible = false;
            chest.opening = -1;
          }
        }
      }
    }
  }

  open(chest: Chest): void {
    chest.active = false;
    chest.opening = 0;
  }

  clear(): void {
    for (const chest of this.list) {
      chest.active = false;
      chest.opening = -1;
      chest.root.visible = false;
    }
  }
}
