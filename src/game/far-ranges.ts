/**
 * The great ranges: one vast ring of ridged mountains surrounding the play
 * area out to the horizon. Behind and beside the trail they rise into
 * towering walls; ahead (toward the sunset glide) the land sinks beneath the
 * sea of clouds, with a few colossal 8,000 m-style giants piercing it.
 * Valleys between the ranges fall below the cloud deck.
 */

import { BufferAttribute, BufferGeometry, Mesh, Uint32BufferAttribute } from '@iwsdk/core';
import { createLandMaterial } from './land-material.js';
import { clamp, CLOUD_SEA_Y, smoothstep, valueNoise } from './terrain.js';

const CENTER_X = 0;
const CENTER_Z = -10;
const INNER_RADIUS = 380;
const OUTER_RADIUS = 17000;

/** Ridged multifractal: sharp aretes with eroded detail in the valleys. */
function ridged(x: number, z: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let weight = 1;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(valueNoise(x * freq + i * 13.7, z * freq - i * 7.3));
    n *= n;
    n *= weight;
    weight = clamp(n * 1.8, 0, 1);
    sum += n * amp;
    freq *= 2.07;
    amp *= 0.5;
  }
  return sum;
}

interface Giant {
  x: number;
  z: number;
  height: number;
  radius: number;
}

/** The named giants: two walls behind the trail and three peaks in the sunset. */
const GIANTS: Giant[] = [
  { x: 400, z: -2600, height: 2800, radius: 900 },
  { x: -1700, z: -2100, height: 2100, radius: 750 },
  { x: -2700, z: -500, height: 1500, radius: 700 },
  { x: 2600, z: 200, height: 1800, radius: 800 },
  { x: 2200, z: -1500, height: 1400, radius: 650 },
  { x: -2100, z: 5600, height: 3300, radius: 1000 },
  { x: 2500, z: 7400, height: 4200, radius: 1200 },
  { x: 200, z: 10500, height: 5200, radius: 1500 },
];

export function farHeight(x: number, z: number): number {
  const dx = x - CENTER_X;
  const dz = z - CENTER_Z;
  const r = Math.hypot(dx, dz);
  // Near ring: rugged foothills a little above the local rim.
  const near = 110 + ridged(x / 650, z / 650, 5) * 300;
  // Far ranges: big ridged massifs whose valleys drop below the clouds.
  const range = CLOUD_SEA_Y - 160 + ridged(x / 2800, z / 2800, 7) * 2400;
  let h = near + (range - near) * smoothstep(500, 2600, r);

  // The sunset opening ahead (+Z) sinks below the cloud sea.
  const angle = Math.atan2(dx, dz); // 0 = +Z
  const open = 1 - smoothstep(0.32, 0.8, Math.abs(angle));
  const lowlands = open * (1 - smoothstep(5500, 8000, r));
  h = h + (CLOUD_SEA_Y - 250 - h) * lowlands;

  for (const g of GIANTS) {
    const gx = (x - g.x) / g.radius;
    const gz = (z - g.z) / g.radius;
    const d2 = gx * gx + gz * gz;
    if (d2 > 9) continue;
    // Pyramidal summit with craggy ridges carved by noise.
    const cone = Math.max(0, 1 - Math.sqrt(d2) / 2.6);
    // Steep pyramid with knife-edge aretes and a sharp summit.
    const crag = 0.62 + 0.7 * ridged(x / 750 + g.x, z / 750, 5);
    const summit = Math.pow(cone, 1.7) * crag + Math.pow(cone, 6) * 0.25;
    h = Math.max(h, CLOUD_SEA_Y - 200 + g.height * summit);
  }
  return h;
}

export function buildFarRanges(): Mesh {
  const rings = 170;
  const segments = 480;
  const positions = new Float32Array((rings + 1) * segments * 3);
  // Geometric ring spacing: dense near the play area, sparse at the horizon.
  const ratio = Math.pow(OUTER_RADIUS / INNER_RADIUS, 1 / rings);
  for (let i = 0; i <= rings; i++) {
    const r = INNER_RADIUS * Math.pow(ratio, i);
    for (let j = 0; j < segments; j++) {
      const a = (j / segments) * Math.PI * 2;
      const x = CENTER_X + Math.sin(a) * r;
      const z = CENTER_Z + Math.cos(a) * r;
      const k = (i * segments + j) * 3;
      positions[k] = x;
      positions[k + 1] = farHeight(x, z);
      positions[k + 2] = z;
    }
  }
  const indices = new Uint32Array(rings * segments * 6);
  let t = 0;
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * segments + j;
      const b = i * segments + ((j + 1) % segments);
      const c = a + segments;
      const d = b + segments;
      // counter-clockwise seen from above so normals face up
      indices[t++] = a;
      indices[t++] = c;
      indices[t++] = b;
      indices[t++] = b;
      indices[t++] = c;
      indices[t++] = d;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(new Uint32BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const mesh = new Mesh(geometry, createLandMaterial({ rockScale: 60, snowScale: 40, snowCling: 0.28, cloudMist: true }));
  mesh.name = 'GreatRanges';
  mesh.receiveShadow = false;
  return mesh;
}
