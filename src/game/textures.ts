/**
 * Procedurally generated, tileable textures (no image downloads): snow
 * micro-relief normals, layered rock albedo + normals, a noise map for
 * large-scale variation, spruce bark and snowy spruce branch cards.
 */

import {
  CanvasTexture,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  type Texture,
  UnsignedByteType,
} from '@iwsdk/core';
import { mulberry32 } from './terrain.js';

// ---------------------------------------------------- tileable noise -------

function hash(ix: number, iy: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

/** Value noise in [0, 1] that tiles with the given integer period. */
function tileNoise(x: number, y: number, period: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const x0 = ((ix % period) + period) % period;
  const y0 = ((iy % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const y1 = (y0 + 1) % period;
  const a = hash(x0, y0, seed);
  const b = hash(x1, y0, seed);
  const c = hash(x0, y1, seed);
  const d = hash(x1, y1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function tileFbm(u: number, v: number, basePeriod: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let period = basePeriod;
  for (let i = 0; i < octaves; i++) {
    sum += tileNoise(u * period, v * period, period, seed + i * 31) * amp;
    norm += amp;
    amp *= 0.5;
    period *= 2;
  }
  return sum / norm;
}

function makeDataTexture(data: Uint8Array, size: number, srgb: boolean): DataTexture {
  const texture = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  if (srgb) texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** Encode a tileable height field as a tangent-space normal map. */
function normalsFromHeight(height: Float32Array, size: number, strength: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = height[y * size + ((x - 1 + size) % size)];
      const r = height[y * size + ((x + 1) % size)];
      const d = height[((y - 1 + size) % size) * size + x];
      const u = height[((y + 1) % size) * size + x];
      let nx = (l - r) * strength;
      let ny = (d - u) * strength;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      const k = (y * size + x) * 4;
      out[k] = (nx * 0.5 + 0.5) * 255;
      out[k + 1] = (ny * 0.5 + 0.5) * 255;
      out[k + 2] = (nz * 0.5 + 0.5) * 255;
      out[k + 3] = 255;
    }
  }
  return out;
}

// ------------------------------------------------------------- maps --------

export interface LandTextures {
  snowNormal: Texture;
  rockAlbedo: Texture;
  rockNormal: Texture;
  noise: Texture;
}

function buildSnowNormal(size = 512): Texture {
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      // Soft wind ripples (sastrugi) on top of fine granular noise.
      const warp = tileFbm(u, v, 4, 3, 7) * 2.0;
      const ripple = Math.sin((v * 6 + warp) * Math.PI * 2) * 0.5 + 0.5;
      const grain = tileFbm(u, v, 32, 3, 11);
      const drift = tileFbm(u, v, 8, 4, 3);
      height[y * size + x] = ripple * 0.35 + drift * 0.45 + grain * 0.2;
    }
  }
  return makeDataTexture(normalsFromHeight(height, size, 6), size, false);
}

function buildRock(size = 512): { albedo: Texture; normal: Texture } {
  const height = new Float32Array(size * size);
  const albedo = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const warp = tileFbm(u, v, 4, 4, 21);
      // Sedimentary strata, broken up by fractures and weathering.
      const strata = Math.sin((v * 9 + warp * 1.6) * Math.PI * 2) * 0.5 + 0.5;
      const ridge = 1 - Math.abs(tileFbm(u, v, 8, 5, 5) * 2 - 1);
      const fine = tileFbm(u, v, 32, 3, 9);
      const h = strata * 0.12 + ridge * 0.6 + fine * 0.28;
      height[y * size + x] = h;
      const tone = 0.5 + 0.5 * (ridge * 0.65 + fine * 0.35);
      const warm = Math.max(0, tileFbm(u, v, 4, 3, 41) - 0.45) * 2;
      const k = (y * size + x) * 4;
      // granite greys with occasional rusty staining
      const r = (0.36 + warm * 0.08) * tone - strata * 0.025;
      const g = (0.36 + warm * 0.03) * tone - strata * 0.025;
      const b = (0.38 - warm * 0.02) * tone - strata * 0.02;
      albedo[k] = Math.max(0, Math.min(1, r)) * 255;
      albedo[k + 1] = Math.max(0, Math.min(1, g)) * 255;
      albedo[k + 2] = Math.max(0, Math.min(1, b)) * 255;
      albedo[k + 3] = 255;
    }
  }
  return {
    albedo: makeDataTexture(albedo, size, true),
    normal: makeDataTexture(normalsFromHeight(height, size, 9), size, false),
  };
}

function buildNoise(size = 256): Texture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const k = (y * size + x) * 4;
      data[k] = tileFbm(u, v, 4, 5, 1) * 255;
      data[k + 1] = tileFbm(u, v, 8, 4, 2) * 255;
      data[k + 2] = tileFbm(u, v, 16, 3, 3) * 255;
      data[k + 3] = 255;
    }
  }
  return makeDataTexture(data, size, false);
}

let land: LandTextures | null = null;

export function landTextures(): LandTextures {
  if (!land) {
    const rock = buildRock();
    land = {
      snowNormal: buildSnowNormal(),
      rockAlbedo: rock.albedo,
      rockNormal: rock.normal,
      noise: buildNoise(),
    };
  }
  return land;
}

// -------------------------------------------------------------- trees ------

/** Spruce bark: vertical fissures in grey-brown. */
export function buildBarkTexture(): Texture {
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const fissure = Math.abs(tileFbm(u, v * 0.25, 8, 4, 13) * 2 - 1);
      const t = 0.45 + 0.55 * Math.min(1, fissure * 2.2);
      const k = (y * size + x) * 4;
      data[k] = 0.36 * t * 255;
      data[k + 1] = 0.27 * t * 255;
      data[k + 2] = 0.2 * t * 255;
      data[k + 3] = 255;
    }
  }
  return makeDataTexture(data, size, true);
}

/**
 * Alpha-tested spruce branch card: a twig running along +u with dense
 * needle sprays, dusted with snow along the upper edge. The trunk end is
 * at u = 0.
 */
export function buildBranchTexture(): Texture {
  const w = 256;
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);
  const rand = mulberry32(17);
  const mid = h * 0.52;

  const needle = (x: number, y: number, angle: number, len: number, color: string) => {
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(angle) * len, y + Math.sin(angle) * len);
    ctx.stroke();
  };

  // twig and side shoots
  ctx.lineCap = 'round';
  const shoots: Array<[number, number, number, number]> = [];
  for (let i = 0; i < 9; i++) {
    const x0 = 12 + i * 26;
    const side = i % 2 === 0 ? -1 : 1;
    const len = (1 - i / 10) * 70 + 20;
    shoots.push([x0, mid, -0.55 * side + 0.2, len]);
  }
  // needles: dark underside first, then mid and light greens
  const greens = ['#0f2a1d', '#163a27', '#1f4a31', '#2b5a3b'];
  ctx.lineWidth = 2;
  for (let pass = 0; pass < greens.length; pass++) {
    for (let x = 6; x < w - 10; x += 2.2) {
      const taper = 1 - x / w;
      const spread = 48 * taper + 14;
      for (let k = 0; k < 2; k++) {
        const y = mid + (rand() - 0.5) * spread * 1.6;
        const a = (y < mid ? -1 : 1) * (0.6 + rand() * 0.8) + 0.35;
        needle(x, y, a, 6 + rand() * 7, greens[pass]);
      }
    }
    for (const [x0, y0, a0, len] of shoots) {
      for (let t = 0; t < len; t += 3) {
        const x = x0 + Math.cos(a0) * t;
        const y = y0 + Math.sin(a0) * t;
        needle(x, y, a0 + (rand() - 0.5) * 2.4, 5 + rand() * 6, greens[pass]);
      }
    }
  }
  // main twig
  ctx.strokeStyle = '#3d2b1d';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.quadraticCurveTo(w * 0.5, mid + 4, w - 8, mid - 2);
  ctx.stroke();
  // snow clumps resting on the upper half
  for (let i = 0; i < 70; i++) {
    const x = 8 + rand() * (w - 30);
    const taper = 1 - x / w;
    const y = mid - rand() * (30 * taper + 6);
    const r = 3 + rand() * 7 * taper + 2;
    const g = ctx.createRadialGradient(x, y - r * 0.3, 0, x, y, r);
    g.addColorStop(0, 'rgba(250,252,255,0.98)');
    g.addColorStop(0.7, 'rgba(225,233,245,0.9)');
    g.addColorStop(1, 'rgba(200,210,230,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}
