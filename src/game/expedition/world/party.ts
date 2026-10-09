/**
 * Base Camp's partygoers: every dancer (and the welcoming committee waving
 * gliders in) is one merged mesh animated entirely in the vertex shader —
 * bobbing, swaying and throwing their arms up — so the whole party is a
 * single draw call with no per-frame CPU work.
 */

import {
  BufferGeometry,
  Float32BufferAttribute,
  IcosahedronGeometry,
  Mesh,
  MeshStandardMaterial,
  Sphere,
  Vector3,
} from '@iwsdk/core';
import { Batch, type Fx } from './batch.js';
import type { DancerSpec } from './layout-camps.js';
import { worldUniforms } from './materials.js';
import { ARM_PIVOT, figureLook, figureParts } from '../../figure.js';

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
          vec3 piv = vec3(dSide * ${ARM_PIVOT.x.toFixed(3)}, ${ARM_PIVOT.y.toFixed(3)}, 0.0);
          dP = piv + dArmM * (dP - piv);
        }
        vec3 transformed = dBody * dP + aRoot.xyz + vec3(0.0, dBob, 0.0);`,
      );
  };
  m.customProgramCacheKey = () => 'exp-dancers';
  material = m;
  return m;
}

/** One merged, shader-animated mesh for a set of partygoers (positioned at `origin`). */
export function* buildPartygoers(dancers: DancerSpec[], origin: Vector3): Generator<void, Mesh | null, unknown> {
  if (!dancers.length) return null;
  const b = new Batch('aAnim');
  const roots: number[] = [];
  for (const d of dancers) {
    const before = b.vertexCount;
    for (const part of figureParts(figureLook(d.look))) {
      const fx: Fx = [d.phase, d.speed, part.limb, d.mode];
      b.add(part.geometry, part.matrix, part.color, fx, 1, true);
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
