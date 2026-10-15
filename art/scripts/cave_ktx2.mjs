// GPU-compressed twins of the ice mine's textures (KTX2 / Basis Universal), for Quest 3's memory:
//   node art/scripts/cave_ktx2.mjs          (after cave_encode.py)
// Same scheme as art/scripts/ktx2.mjs, whose public/ktx2.json map the runtime reads (loaders.ts): albedos go
// ETC1S (sRGB), but the light maps go UASTC: their three colour channels are three independent light
// channels (day / lantern / beacon), which ETC1S's shared endpoints would bleed into one another. The cave
// samples every atlas unflipped (glTF UVs), so nothing is flipped here.

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { encodeToKTX2 } from 'ktx2-encoder';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/u, '$1')), '..', '..');
const PUB = path.join(ROOT, 'public');
const JOBS = [
  ['cave/shell_albedo.webp', 'color'],
  ['cave/shell_light.webp', 'light'],
  ['cave/works_albedo.webp', 'color'],
  ['cave/works_light.webp', 'light'],
  ['cave/debris_albedo.webp', 'color'],
  ['cave/debris_light.webp', 'light'],
  ['cave/machines_albedo.webp', 'color'],
  ['cave/deck_albedo.webp', 'color'],
  ['cave/wood_detail.webp', 'light'],
];

const decode = async (buf) => {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
};

const done = {};
for (const [rel, kind] of JOBS) {
  const src = path.join(PUB, rel);
  if (!fs.existsSync(src)) continue;
  const dst = rel.replace(/\.webp$/u, '.ktx2');
  const t0 = Date.now();
  const color = kind === 'color';
  const out = await encodeToKTX2(new Uint8Array(fs.readFileSync(src)), {
    imageDecoder: decode,
    isUASTC: !color,
    isKTX2File: true,
    generateMipmap: true,
    isYFlip: false,
    isPerceptual: color,
    isSetKTX2SRGBTransferFunc: color,
    qualityLevel: 230,
    compressionLevel: 2,
    needSupercompression: true,
  });
  fs.writeFileSync(path.join(PUB, dst), out);
  done[rel] = dst;
  console.log(`${rel} -> ${dst} ${(fs.statSync(src).size / 1e6).toFixed(2)} -> ${(out.length / 1e6).toFixed(2)} MB ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
// merge into the shared map (read it fresh: the other bakes write it too)
const mapPath = path.join(PUB, 'ktx2.json');
const map = fs.existsSync(mapPath) ? JSON.parse(fs.readFileSync(mapPath, 'utf8')) : {};
Object.assign(map, done);
fs.writeFileSync(mapPath, JSON.stringify(map, null, 1));
