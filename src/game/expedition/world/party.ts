/**
 * Base Camp's partygoers: every dancer (and the welcoming committee waving
 * gliders in) is one merged mesh animated entirely in the vertex shader —
 * bobbing, swaying and throwing their arms up — so the whole party is a
 * single draw call with no per-frame CPU work.
 */

import {
  BufferGeometry,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  Float32BufferAttribute,
  IcosahedronGeometry,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Sphere,
  Vector3,
} from '@iwsdk/core';
import { Batch, type Fx } from './batch.js';
import type { DancerSpec } from './layout-camps.js';
import { worldUniforms } from './materials.js';

const JACKETS = [0xd8452b, 0x2f6fb5, 0xe8b13a, 0x3f9a5a, 0xb53f8f, 0xf06a2a, 0x22a3a3].map((h) => new Color(h));
const HATS = [0xf2f2f2, 0xc9302c, 0x1d3b6e, 0xe0b23a, 0x2e2e2e].map((h) => new Color(h));
const SKINS = [0xf1c7a5, 0xd9a47a, 0xa86f4a, 0x7a4b2e, 0xe6b991].map((h) => new Color(h));
const TROUSERS = new Color(0x23262d);
const BOOTS = new Color(0x3a2418);
const MITTS = new Color(0x1a1a1a);

let material: MeshStandardMaterial | null = null;

function dancerMaterial(): MeshStandardMaterial {
  if (material) return material;
  const m = new MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = worldUniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec4 aRoot;
        attribute vec4 aAnim;
        uniform float uTime;
        mat3 dRotY(float a) { float c = cos(a); float s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
        mat3 dRotZ(float a) { float c = cos(a); float s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `float dT = uTime * aAnim.y + aAnim.x;
        float dSide = aAnim.z < 1.5 ? -1.0 : 1.0;
        bool dWave = aAnim.w > 0.5;
        float dArm = 0.0;
        if (aAnim.z > 0.5) {
          float raise = dWave ? 1.0 : 0.5 + 0.5 * sin(dT * 0.5 + aAnim.x);
          float ang = dWave ? 2.55 + sin(dT * 3.2 + dSide * 1.3) * 0.42 : 0.3 + raise * 2.4 + sin(dT * 2.0 + dSide) * 0.2;
          dArm = dSide * ang;
        }
        mat3 dArmM = dRotZ(dArm);
        float dYaw = aRoot.w + (dWave ? sin(dT * 0.4) * 0.12 : sin(dT * 0.5) * 0.35);
        float dRoll = dWave ? sin(dT * 1.6) * 0.04 : sin(dT) * 0.08;
        mat3 dBody = dRotY(dYaw) * dRotZ(dRoll);
        float dBob = dWave ? abs(sin(dT * 1.6)) * 0.05 : abs(sin(dT)) * 0.12;
        vec3 objectNormal = dBody * (dArmM * normal);`,
      )
      .replace(
        '#include <begin_vertex>',
        `vec3 dP = position;
        if (aAnim.z > 0.5) {
          vec3 piv = vec3(dSide * 0.3, 1.45, 0.0);
          dP = piv + dArmM * (dP - piv);
        }
        vec3 transformed = dBody * dP + aRoot.xyz + vec3(0.0, dBob, 0.0);`,
      );
  };
  m.customProgramCacheKey = () => 'exp-dancers';
  material = m;
  return m;
}

/** Body-part templates, built once and reused for every partygoer. */
let parts: Record<string, BufferGeometry> | null = null;
function partGeometries(): Record<string, BufferGeometry> {
  if (parts) return parts;
  const arm = new CapsuleGeometry(0.07, 0.5, 2, 5);
  arm.translate(0, -0.3, 0);
  const raw: Record<string, BufferGeometry> = {
    legs: new CapsuleGeometry(0.15, 0.6, 2, 6),
    body: new CapsuleGeometry(0.24, 0.5, 3, 8),
    scarf: new CylinderGeometry(0.12, 0.15, 0.09, 8),
    head: new IcosahedronGeometry(0.13, 1),
    hat: new IcosahedronGeometry(0.137, 1),
    pompom: new IcosahedronGeometry(0.045, 0),
    arm,
    mitt: new IcosahedronGeometry(0.065, 0),
  };
  parts = {};
  for (const [k, g] of Object.entries(raw)) {
    parts[k] = g.index ? g.toNonIndexed() : g;
    if (parts[k] !== g) g.dispose();
  }
  return parts;
}

const at = (x: number, y: number, z: number, sx = 1, sy = sx, sz = sx) =>
  new Matrix4().makeScale(sx, sy, sz).setPosition(x, y, z);

/** One merged, shader-animated mesh for a set of partygoers (positioned at `origin`). */
export function* buildPartygoers(dancers: DancerSpec[], origin: Vector3): Generator<void, Mesh | null, unknown> {
  if (!dancers.length) return null;
  const b = new Batch('aAnim');
  const roots: number[] = [];
  for (const d of dancers) {
    const before = b.vertexCount;
    const jacket = JACKETS[d.look % JACKETS.length];
    const hat = HATS[(d.look * 3 + 1) % HATS.length];
    const skin = SKINS[(d.look * 7 + 2) % SKINS.length];
    const body: Fx = [d.phase, d.speed, 0, d.mode];
    const P = partGeometries();
    b.add(P.legs, at(0, 0.46, 0, 1.15, 1, 0.9), (_p, _n, out, l) => {
      out.copy(l.y < -0.3 ? BOOTS : TROUSERS);
    }, body, 1, true);
    b.add(P.body, at(0, 1.2, 0), jacket, body, 1, true);
    b.add(P.scarf, at(0, 1.56, 0), hat, body, 1, true);
    b.add(P.head, at(0, 1.72, 0), skin, body, 1, true);
    b.add(P.hat, at(0, 1.79, 0, 1, 0.75, 1), hat, body, 1, true);
    b.add(P.pompom, at(0, 1.91, 0), HATS[(d.look + 2) % HATS.length], body, 1, true);
    for (const side of [-1, 1]) {
      const arm: Fx = [d.phase, d.speed, side < 0 ? 1 : 2, d.mode];
      b.add(P.arm, at(side * 0.3, 1.45, 0), jacket, arm, 1, true);
      b.add(P.mitt, at(side * 0.3, 1.45 - 0.66, 0), MITTS, arm, 1, true);
    }
    const count = b.vertexCount - before;
    for (let i = 0; i < count; i++) roots.push(d.x - origin.x, d.y - origin.y, d.z - origin.z, d.yaw);
    if (roots.length % 4 === 0 && dancers.indexOf(d) % 4 === 3) yield;
  }
  const g: BufferGeometry = b.build(new Vector3());
  g.setAttribute('aRoot', new Float32BufferAttribute(roots, 4));
  // Positions are dancer-local; bound the whole party instead.
  let r = 0;
  const c = new Vector3();
  for (const d of dancers) c.add(new Vector3(d.x - origin.x, d.y - origin.y, d.z - origin.z));
  c.divideScalar(dancers.length);
  for (const d of dancers) r = Math.max(r, c.distanceTo(new Vector3(d.x - origin.x, d.y - origin.y, d.z - origin.z)));
  g.boundingSphere = new Sphere(c.add(new Vector3(0, 1, 0)), r + 3);
  const mesh = new Mesh(g, dancerMaterial());
  mesh.position.copy(origin);
  mesh.name = 'Partygoers';
  // The depth pass would not see the vertex animation: no shadows.
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}

export function partyMaterial(): MeshStandardMaterial {
  return dancerMaterial();
}

export function bulbGeometry(): BufferGeometry {
  return new IcosahedronGeometry(0.08, 0);
}
