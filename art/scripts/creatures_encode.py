"""Creature atlas bakes -> runtime textures + manifest.   python art/scripts/creatures_encode.py

Reads art/work/creatures/{albedo,gloss,emit,normal,ao,coverage}.npy and meta.json (art/scripts/creatures.py --bake)
and writes public/survivors/creatures/:
  creatures_albedo.webp  RGB albedo (sRGB), A gloss            lossy (alpha lossless)
  creatures_data.webp    RG object-space normal (octahedral, game frame), B AO, A emission mask   lossless
  manifest.json
Rows: Blender float arrays are bottom-up; images are written top-down and the GLB's uv.y is 1 - v (glTF), so the
runtime samples them with flipY = false.  The empty atlas between islands is filled by push-pull so mips do
not bleed black into the edges of far LODs.
"""
import json, os
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WORK = os.path.join(ROOT, 'art', 'work', 'creatures')
OUT = os.path.join(ROOT, 'public', 'survivors', 'creatures')


def load(n):
    return np.load(os.path.join(WORK, n + '.npy')).astype(np.float32)


def push_pull(img, mask):
    """Fill uncovered texels from a mask-weighted pyramid (smooth, complete, fast)."""
    m = mask.astype(np.float32)[..., None]
    levels = [(img * m, m)]
    while levels[-1][0].shape[0] > 1:
        c, w = levels[-1]
        h2, w2 = c.shape[0] // 2, c.shape[1] // 2
        c = c[:h2 * 2, :w2 * 2].reshape(h2, 2, w2, 2, -1).sum((1, 3))
        w = w[:h2 * 2, :w2 * 2].reshape(h2, 2, w2, 2, -1).sum((1, 3))
        levels.append((c, w))
    c, w = levels[-1]
    fill = c / np.maximum(w, 1e-8)
    for c, w in reversed(levels[:-1]):
        up = np.repeat(np.repeat(fill, 2, 0), 2, 1)[:c.shape[0], :c.shape[1]]
        have = w > 1e-8
        fill = np.where(have, c / np.maximum(w, 1e-8), up)
    return np.where(m > 0, img, fill)


def srgb(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def oct_encode(n):
    n = n / np.maximum(np.abs(n).sum(-1, keepdims=True), 1e-8)
    x, y, z = n[..., 0], n[..., 1], n[..., 2]
    ox = np.where(z >= 0, x, (1 - np.abs(y)) * np.where(x >= 0, 1, -1))
    oy = np.where(z >= 0, y, (1 - np.abs(x)) * np.where(y >= 0, 1, -1))
    return np.stack([ox, oy], -1) * 0.5 + 0.5


def u8(a):
    return (np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)


def main():
    meta = json.load(open(os.path.join(WORK, 'meta.json')))
    cov = np.load(os.path.join(WORK, 'coverage.npy')).astype(bool)
    alb = load('albedo')[..., :3]
    gloss = load('gloss')[..., 0]
    emit = load('emit')[..., 0]
    nrm = load('normal')[..., :3] * 2 - 1
    ao = load('ao')[..., 0]
    # Blender object space (x, y, z) -> game creature frame (x, z, -y)
    nrm = np.stack([nrm[..., 0], nrm[..., 2], -nrm[..., 1]], -1)
    nrm = push_pull(nrm, cov)
    nrm /= np.maximum(np.linalg.norm(nrm, axis=-1, keepdims=True), 1e-6)
    rest = push_pull(np.concatenate([alb, gloss[..., None], emit[..., None], ao[..., None]], -1), cov)
    alb, gloss, emit, ao = rest[..., :3], rest[..., 3], rest[..., 4], rest[..., 5]
    print('albedo mean', alb[cov].mean(0), 'gloss', gloss[cov].mean(), 'ao', ao[cov].mean(), 'emit>0.05',
          (emit[cov] > 0.05).mean())
    A = np.concatenate([srgb(alb), gloss[..., None]], -1)
    D = np.concatenate([oct_encode(nrm), ao[..., None], emit[..., None]], -1)
    os.makedirs(OUT, exist_ok=True)
    pa = os.path.join(OUT, 'creatures_albedo.webp')
    pd = os.path.join(OUT, 'creatures_data.webp')
    Image.fromarray(u8(np.flipud(A)), 'RGBA').save(pa, 'WEBP', quality=90, alpha_quality=100, method=6, exact=True)
    Image.fromarray(u8(np.flipud(D)), 'RGBA').save(pd, 'WEBP', lossless=True, quality=100, method=6, exact=True)
    for p in (pa, pd):
        print(f'  {os.path.basename(p)} {os.path.getsize(p) / 1e6:.2f} MB')
    # previews for the look-dev check (Blender-space normal, linear albedo, emission)
    nb = np.stack([nrm[..., 0], -nrm[..., 2], nrm[..., 1]], -1) * 0.5 + 0.5
    Image.fromarray(u8(np.flipud(nb)), 'RGB').save(os.path.join(WORK, 'check_normal.png'))
    Image.fromarray(u8(np.flipud(srgb(alb))), 'RGB').save(os.path.join(WORK, 'check_albedo.png'))
    Image.fromarray(u8(np.flipud(np.stack([emit, ao, gloss], -1))), 'RGB').save(os.path.join(WORK, 'check_eag.png'))
    man = {
        'version': 1,
        'glb': 'creatures.glb',
        'albedo': 'creatures_albedo.webp',
        'data': 'creatures_data.webp',
        'atlas': meta['atlas'],
        'emit_max': meta['emit_max'],
        'kinds': meta['kinds'],
    }
    json.dump(man, open(os.path.join(OUT, 'manifest.json'), 'w'), indent=1)
    print('wrote manifest')


main()
