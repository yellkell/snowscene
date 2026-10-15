"""The ice's fine albedo detail (tileable): python art/scripts/ice_fine.py -> public/cave/ice_fine.webp

What glacier ice shows at arm's length that a baked atlas can't hold: trapped air bubbles (fine, in drifts),
hairline fractures catching the light, and faint growth layering. Stored as an albedo multiplier around 1
(0.5 = x1). The cave shader lays it on triplanar at ~0.6 m, fading with distance.
"""
import os
import numpy as np
from PIL import Image

N = 1024
rng = np.random.default_rng(11)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def tile_noise(scale, octaves=4, seed=0):
    """Periodic value noise (sum of random-phase cosines on the torus)."""
    r = np.random.default_rng(seed)
    y, x = np.mgrid[0:N, 0:N] / N * 2 * np.pi
    out = np.zeros((N, N))
    amp = 1.0
    for o in range(octaves):
        f = scale * 2 ** o
        for _ in range(6):
            kx, ky = r.integers(-f, f + 1, 2)
            if kx == 0 and ky == 0:
                continue
            out += amp * np.cos(kx * x + ky * y + r.uniform(0, 2 * np.pi))
        amp *= 0.55
    return (out - out.min()) / (out.max() - out.min())


m = np.zeros((N, N))
# faint growth layering: soft bands, slightly wavy
y, x = np.mgrid[0:N, 0:N] / N
warp = tile_noise(2, 3, 1) * 0.08
layers = 0.5 + 0.5 * np.sin((y + warp) * 2 * np.pi * 9)
m += (layers - 0.5) * 0.06
# bubbles: small bright dots, dense in drifts and sparse elsewhere
drift = tile_noise(3, 3, 2)
nb = 9000
px = rng.integers(0, N, nb)
py = rng.integers(0, N, nb)
keep = rng.random(nb) < (drift[py, px] ** 2.2)
px, py = px[keep], py[keep]
yy, xx = np.mgrid[-4:5, -4:5]
for cx, cy in zip(px, py):
    r = rng.uniform(0.7, 2.6)
    k = np.exp(-(xx * xx + yy * yy) / (2 * r * r)) * rng.uniform(0.08, 0.22)
    m[(cy + yy) % N, (cx + xx) % N] += k
# hairline fractures: thin bright lines along level sets of a smooth noise (wrap-safe)
crack_f = tile_noise(4, 3, 3)
for lvl in (0.31, 0.47, 0.66):
    d = np.abs(crack_f - lvl)
    line = np.exp(-(d / 0.0035) ** 2) * (tile_noise(6, 2, int(lvl * 100)) > 0.55)
    m += line * 0.16
# a little overall mottle so it never reads as flat
m += (tile_noise(8, 3, 4) - 0.5) * 0.05
img = np.clip(0.5 + m * 0.5, 0, 1)        # 0.5 = x1
out = os.path.join(ROOT, 'public', 'cave', 'ice_fine.webp')
Image.fromarray((img * 255 + 0.5).astype(np.uint8), 'L').convert('RGB').save(out, 'WEBP', quality=92, method=6)
print('wrote', out, img.mean(), img.min(), img.max())
