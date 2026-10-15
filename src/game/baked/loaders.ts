/** glTF (Draco, decoder shipped in public/draco) and texture loading for baked assets. */

import { LinearMipmapLinearFilter, SRGBColorSpace, NoColorSpace, type Texture, TextureLoader, type WebGLRenderer } from '@iwsdk/core';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';

const base = import.meta.env.BASE_URL;
let gltf: GLTFLoader | null = null;
const textures = new TextureLoader();

export function assetUrl(path: string): string {
  return `${base}${path.replace(/^\/+/u, '')}?v=${__ASSET_STAMP__}`;
}

export function loadGLTF(path: string): Promise<GLTF> {
  if (!gltf) {
    const draco = new DRACOLoader().setDecoderPath(`${base}draco/`);
    gltf = new GLTFLoader().setDRACOLoader(draco);
  }
  return gltf.loadAsync(assetUrl(path));
}

// GPU-compressed twins (art/scripts/ktx2.mjs): public/ktx2.json maps a texture to its .ktx2, which is
// loaded instead once the renderer has said what it can transcode to (ASTC / ETC2 on Quest, BC7 on desktop).
let ktx2: KTX2Loader | null = null;
let ktx2Map: Promise<Record<string, string>> = Promise.resolve({});

/** Enable the compressed twins; call once the renderer exists, before the baked levels load. */
export function initCompressedTextures(renderer: WebGLRenderer): void {
  ktx2 = new KTX2Loader().setTranscoderPath(`${base}basis/`).detectSupport(renderer);
  ktx2Map = loadJSON<Record<string, string>>('ktx2.json').catch(() => ({}));
}

/** The GPU-compressed twin of `path`, if ktx2.json lists one and the renderer can use it; else null. */
export async function loadCompressed(path: string, color: boolean, anisotropy = 4): Promise<Texture | null> {
  const twin = ktx2 ? (await ktx2Map)[path] : undefined;
  if (!twin || !ktx2) return null;
  const t = await ktx2.loadAsync(assetUrl(twin));
  t.colorSpace = color ? SRGBColorSpace : NoColorSpace;
  t.minFilter = LinearMipmapLinearFilter;
  t.anisotropy = anisotropy;
  return t;
}

/** A texture; `color` textures are sRGB, data (light, normals) are linear. */
export async function loadTexture(path: string, color: boolean, anisotropy = 4): Promise<Texture> {
  const twin = ktx2 ? (await ktx2Map)[path] : undefined;
  // compressed twins are stored the way they're sampled (pre-flipped where the runtime flips)
  const t = twin && ktx2 ? await ktx2.loadAsync(assetUrl(twin)) : await textures.loadAsync(assetUrl(path));
  t.colorSpace = color ? SRGBColorSpace : NoColorSpace;
  t.minFilter = LinearMipmapLinearFilter;
  t.anisotropy = anisotropy;
  return t;
}

export async function loadJSON<T>(path: string): Promise<T> {
  const r = await fetch(assetUrl(path));
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return (await r.json()) as T;
}
