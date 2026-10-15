// GPU-compressed twins of the big baked textures (KTX2 / Basis Universal), for Quest 3's memory:
//   node art/scripts/ktx2.mjs [filter]
// Writes <name>.ktx2 next to each <name>.webp and public/ktx2.json mapping one to the other; the runtime
// (src/game/baked/loaders.ts) loads the twin when it is listed. Everything goes ETC1S (about a tenth of
// the WebP on disk once transcoded, an eighth of RGBA8 on the GPU): albedo perceptual / sRGB, light and sky
// data linear at the top quality. 'smooth' opts a file into UASTC (+zstd) if its gradients band.
// Compressed textures can't be flipped on upload: anything the runtime samples with three's default
// flipY = true is flipped here instead (`flip`).

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { encodeToKTX2 } from 'ktx2-encoder';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/u, '$1')), '..', '..');
const PUB = path.join(ROOT, 'public');
const filter = process.argv[2] ?? '';

// [path relative to public/, kind, flip]
const ATLASES = ['wall', 'bands', 'bluff', 'deck', 'hut', 'props', 'rim', 'party', 'lake'];
const JOBS = [
  ['tutorial/ground_light.webp', 'data', true],
  ['tutorial/ground_albedo.webp', 'color', true],
  ['tutorial/trail_light.webp', 'data', true],
  ['tutorial/trail_albedo.webp', 'color', true],
  ['tutorial/vista_sunset.webp', 'data', true],
  ...ATLASES.flatMap((a) => [
    [`tutorial/${a}_albedo.webp`, 'color', false],
    [`tutorial/${a}_light.webp`, 'data', false],
  ]),
  ['survivors/ground_light.webp', 'data', true],
  ['survivors/props_albedo.webp', 'color', false],
  ['survivors/props_light.webp', 'data', false],
  ['survivors/trees_sun.webp', 'data', true],
  ['survivors/trees_sky.webp', 'data', true],
  ...['sunset', 'dusk1', 'dusk2', 'night'].map((s) => [`survivors/sky_${s}.webp`, 'data', true]),
  ['textures/spray.webp', 'color', false],
  // the horde's atlas: albedo + gloss (alpha) ETC1S; normals / AO / emission UASTC (ETC1S blocks wreck normals)
  ['survivors/creatures/creatures_albedo.webp', 'color', false],
  ['survivors/creatures/creatures_data.webp', 'smooth', false],
];

// The wasm encoder takes at most ~12.6 Mpix: bigger images are resampled to fit (block-aligned). Every
// texture here is addressed by normalised UVs, so nothing downstream changes.
const MAX_TEXELS = 12_500_000;
const decode = async (buf) => {
  let img = sharp(buf);
  const { width, height } = await img.metadata();
  // block formats (BC / ETC / ASTC) need the base level in whole 4x4 blocks
  const k = Math.min(1, Math.sqrt(MAX_TEXELS / (width * height)));
  const w = Math.floor((width * k) / 4) * 4;
  const h = Math.floor((height * k) / 4) * 4;
  if (w !== width || h !== height) img = img.resize(w, h, { kernel: 'lanczos3', fit: 'fill' });
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
};

const mapPath = path.join(PUB, 'ktx2.json');
const map = fs.existsSync(mapPath) ? JSON.parse(fs.readFileSync(mapPath, 'utf8')) : {};
for (const [rel, kind, flip] of JOBS) {
  if (filter && !rel.includes(filter)) continue;
  const src = path.join(PUB, rel);
  if (!fs.existsSync(src)) continue;
  const dstAbs = path.join(PUB, rel.replace(/\.webp$/u, '.ktx2'));
  // up to date: skip (encode.py runs this after every encode)
  if (fs.existsSync(dstAbs) && fs.statSync(dstAbs).mtimeMs >= fs.statSync(src).mtimeMs && map[rel]) continue;
  const t0 = Date.now();
  const color = kind === 'color';
  const out = await encodeToKTX2(new Uint8Array(fs.readFileSync(src)), {
    imageDecoder: decode,
    isUASTC: kind === 'smooth',
    isKTX2File: true,
    generateMipmap: true,
    isYFlip: flip,
    isPerceptual: color,
    isSetKTX2SRGBTransferFunc: color,
    // ETC1S
    qualityLevel: color ? 230 : 255,
    compressionLevel: 2,
    // UASTC
    needSupercompression: true,
  });
  const dst = rel.replace(/\.webp$/u, '.ktx2');
  fs.writeFileSync(path.join(PUB, dst), out);
  map[rel] = dst;
  const mb = (n) => (n / 1e6).toFixed(2);
  console.log(`${rel} -> ${dst} ${mb(fs.statSync(src).size)} -> ${mb(out.length)} MB (${kind}${flip ? ', flipped' : ''}) ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  fs.writeFileSync(mapPath, JSON.stringify(map, null, 1));
}
