"""Pack the rendered FX frames into runtime atlases (public/survivors/fx/*.webp) and review sheets.

  python art/scripts/fx_pack.py fire|fireball|powder|misc|all

Gas atlases (fire, fireball), RGB, no alpha channel (browsers premultiply WebP alpha, which would wipe
the emission wherever the smoke is clear):
  R = sqrt(emitted luminance / max)   G = heat 0..1 (chroma of the blackbody, see HEAT_RAMP)
  B = smoke opacity
Powder atlas: R = opacity, G = sky-lit shading, B = sun-lit shading (both as a white diffuse 1.0).
Frames are laid out row-major from the top-left. Constants the runtime needs are printed and written to
art/work/fx/pack.json (they are mirrored by hand in src/game/survivors/fx-assets.ts).
"""
import json, os, sys
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WORK = os.path.join(ROOT, 'art', 'work', 'fx')
DST = os.path.join(ROOT, 'public', 'survivors', 'fx')
REN = os.path.join(ROOT, 'art', 'renders')
os.makedirs(DST, exist_ok=True)
PACK_P = os.path.join(WORK, 'pack.json')
PACK = json.load(open(PACK_P)) if os.path.exists(PACK_P) else {}

LUMW = np.array([0.2126, 0.7152, 0.0722], np.float32)


def u8(a):
    return (np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)


def save_webp(name, arr, quality=90):
    im = Image.fromarray(u8(arr), 'RGB')
    p = os.path.join(DST, name)
    im.save(p, 'WEBP', quality=quality, method=6)
    print(f'  {name} {im.size} {os.path.getsize(p) / 1e3:.0f} kB')


def down2(a):
    h, w = a.shape[:2]
    return a[:h // 2 * 2, :w // 2 * 2].reshape(h // 2, 2, w // 2, 2, -1).mean((1, 3))


def edge_window(h, w, top=0.12, side=0.07, bottom=0.0):
    """1 inside, falling smoothly to 0 at the frame edges (rows top-down)."""
    y = (np.arange(h) + 0.5) / h
    x = (np.arange(w) + 0.5) / w
    s = lambda t: t * t * (3 - 2 * t)
    fy = np.ones(h, np.float32)
    if top:
        fy *= s(np.clip(y / top, 0, 1))
    if bottom:
        fy *= s(np.clip((1 - y) / bottom, 0, 1))
    fx = s(np.clip(x / side, 0, 1)) * s(np.clip((1 - x) / side, 0, 1))
    return (fy[:, None] * fx[None, :]).astype(np.float32)


def atlas(frames, cols):
    n, h, w, c = frames.shape
    rows = (n + cols - 1) // cols
    out = np.zeros((rows * h, cols * w, c), np.float32)
    for k in range(n):
        r, cc = divmod(k, cols)
        out[r * h:(r + 1) * h, cc * w:(cc + 1) * w] = frames[k]
    return out


def gas_encode(frames, name, cols):
    """frames: (n, h, w, 4) top-down, premultiplied emission + smoke alpha."""
    E = frames[..., :3]
    A = np.clip(frames[..., 3], 0, 1)
    L = E @ LUMW
    lmax = float(np.percentile(L[L > 1e-4], 99.7) * 1.05)
    # Heat from the blackbody's chroma: green/red rises from ~0.1 (dull red) to ~0.75 (yellow-white).
    r = np.maximum(E[..., 0], 1e-5)
    gr = np.clip(E[..., 1] / r, 0, 1.2)
    w = L > lmax * 0.01
    lo, hi = np.percentile(gr[w], 1), np.percentile(gr[w], 99.5)
    heat = np.clip((gr - lo) / (hi - lo), 0, 1)
    heat = np.where(w, heat, 0)
    # The runtime tint ramp: mean chroma (rgb / luminance) of the pixels at each heat.
    ramp = []
    for h in (0.0, 0.25, 0.5, 0.75, 1.0):
        sel = w & (np.abs(heat - h) < 0.08)
        c = (E[sel] / np.maximum(L[sel][:, None], 1e-6)).mean(0) if sel.any() else np.ones(3)
        ramp.append([round(float(v), 4) for v in c])
    enc = np.stack([np.sqrt(np.clip(L / lmax, 0, 1)), heat, A], -1)
    save_webp(f'{name}.webp', atlas(enc, cols))
    PACK[name] = dict(lmax=lmax, gr=[float(lo), float(hi)], ramp=ramp, frames=int(frames.shape[0]), cols=cols,
                      frame=[int(frames.shape[2]), int(frames.shape[1])])
    print(name, json.dumps(PACK[name]))
    return enc


def preview_gas(enc, info, name, cols, expo=(1.0, 6.0)):
    """Decode as the runtime will and composite over a dusk sky and a night sky, AgX-ish (filmic)."""
    L = enc[..., 0] ** 2 * info['lmax']
    heat = enc[..., 1]
    A = enc[..., 2]
    ramp = np.array(info['ramp'], np.float32)
    x = heat * 4
    i = np.clip(x.astype(int), 0, 3)
    f = (x - i)[..., None]
    tint = ramp[i] * (1 - f) + ramp[i + 1] * f
    E = tint * L[..., None]
    sheets = []
    for e, bg in zip(expo, ((0.42, 0.42, 0.5), (0.02, 0.025, 0.05))):
        smoke = np.array([0.05, 0.05, 0.055]) * (1 if e < 2 else 0.2)
        rgb = E + smoke * A[..., None] + np.array(bg) * (1 - A[..., None])
        rgb = rgb * e
        rgb = rgb / (1 + rgb)  # Reinhard, just for a review sheet
        rgb = rgb ** (1 / 2.2)
        sheets.append(atlas(rgb, cols))
    im = Image.fromarray(u8(np.concatenate(sheets, 1)), 'RGB')
    p = os.path.join(REN, f'fx_{name}_sheet.png')
    im.save(p)
    print('  sheet', p)


def fire():
    a = np.load(os.path.join(WORK, 'fire_frames.npy')).astype(np.float32)[0]  # (80, h, w, 4) bottom-up
    a = a[:, ::-1]
    N = 16
    out = []
    for k in range(64):
        f = a[N + k]
        if k >= 64 - N:
            w = (k - (64 - N) + 1) / (N + 1)
            f = (1 - w) * f + w * a[k - (64 - N)]
        out.append(down2(f))
    fr = np.stack(out)
    win = edge_window(fr.shape[1], fr.shape[2], top=0.14, side=0.08)
    fr = fr * win[None, :, :, None]
    enc = gas_encode(fr, 'fire', 8)
    preview_gas(enc[:16], PACK['fire'], 'fire', 8)


def autocrop(a, pad=6):
    """Square crop (same for every frame) round everything that shows, resized back to the frame size."""
    vis = (a[..., 3] > 0.01) | ((a[..., :3] @ LUMW) > 0.01)
    ys, xs = np.nonzero(vis.any(0))
    h, w = a.shape[1:3]
    cy, cx = (ys.min() + ys.max()) / 2, (xs.min() + xs.max()) / 2
    half = max(ys.max() - ys.min(), xs.max() - xs.min()) / 2 + pad
    y0, x0 = int(max(0, cy - half)), int(max(0, cx - half))
    y1, x1 = int(min(h, cy + half)), int(min(w, cx + half))
    out = []
    for f in a:
        c = f[y0:y1, x0:x1]
        chans = [np.asarray(Image.fromarray(c[..., k].astype(np.float32), 'F').resize((w, h), Image.BICUBIC)) for k in range(4)]
        out.append(np.stack(chans, -1))
    print(f'  crop {x1 - x0}x{y1 - y0} of {w}x{h}')
    return np.clip(np.stack(out), 0, None)


def fireball():
    a = np.load(os.path.join(WORK, 'fireball_frames.npy')).astype(np.float32)[0][:, ::-1]
    a = autocrop(a)
    win = edge_window(a.shape[1], a.shape[2], top=0.08, side=0.08, bottom=0.08)
    fr = a * win[None, :, :, None]
    enc = gas_encode(fr, 'fireball', 4)
    preview_gas(enc, PACK['fireball'], 'fireball', 4)


def powder():
    a = np.load(os.path.join(WORK, 'powder_frames.npy')).astype(np.float32)[:, :, ::-1]  # (2, 16, h, w, 4)
    sky, sun = a[0], a[1]
    A = np.clip(sky[..., 3], 0, 1)
    win = edge_window(A.shape[1], A.shape[2], top=0.08, side=0.08, bottom=0.08)
    A = A * win[None]
    sh_sky = (sky[..., :3] @ LUMW) / np.maximum(sky[..., 3], 1e-3)
    sh_sun = (sun[..., :3] @ LUMW) / np.maximum(sun[..., 3], 1e-3)
    # Push shading into the clear pixels too, so the bilinear filter at the edges does not darken.
    sh_sky = np.where(sky[..., 3] > 0.01, sh_sky, 0.8)
    sh_sun = np.where(sun[..., 3] > 0.01, sh_sun, 0.5)
    enc = np.stack([A, np.clip(sh_sky, 0, 1), np.clip(sh_sun, 0, 1)], -1)
    save_webp('powder.webp', atlas(enc, 4))
    PACK['powder'] = dict(frames=16, cols=4, frame=[int(A.shape[2]), int(A.shape[1])])
    # Review: lit by a golden-hour sun from the right, over the snowfield's grey-blue.
    bg = np.array([0.33, 0.36, 0.45])
    col = np.array([0.86, 0.89, 0.93]) * (np.array([0.55, 0.62, 0.8]) * enc[..., 1:2] + np.array([1.0, 0.55, 0.3]) * enc[..., 2:3])
    rgb = col * enc[..., :1] + bg * (1 - enc[..., :1])
    rgb = (rgb / (1 + rgb) * 1.6) ** (1 / 2.2)
    Image.fromarray(u8(atlas(rgb, 4)), 'RGB').save(os.path.join(REN, 'fx_powder_sheet.png'))
    print('  sheet fx_powder_sheet.png')


def srgb(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def tile_noise(n, beta, seed):
    """Tileable fractal noise (1/f^beta spectrum), 0..1."""
    rng = np.random.default_rng(seed)
    f = np.fft.fftfreq(n)
    k = np.sqrt(f[:, None] ** 2 + f[None, :] ** 2)
    k[0, 0] = 1
    spec = np.fft.fft2(rng.standard_normal((n, n))) / k ** (beta / 2)
    spec[0, 0] = 0
    a = np.real(np.fft.ifft2(spec))
    a = (a - a.mean()) / (a.std() * 4) + 0.5
    return np.clip(a, 0, 1)


def misc():
    """misc.webp 1024x512: left the scorch multiply decal (display-space ratio), right tileable noise
    (R billows, G fine billows, B grain)."""
    ratio = np.load(os.path.join(WORK, 'scorch.npy'))[::-1]
    h, w = ratio.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    r = np.hypot((xx + 0.5) / w - 0.5, (yy + 0.5) / h - 0.5) * 2
    fade = np.clip((0.98 - r) / 0.12, 0, 1)[..., None]
    dec = np.clip(ratio, 0, 1.05) ** (1 / 2.2)
    dec = dec * fade + (1 - fade)
    dec = dec / 1.05
    n = 512
    noise = np.stack([tile_noise(n, 2.4, 1), tile_noise(n, 1.8, 2), tile_noise(n, 0.6, 3)], -1)
    img = np.concatenate([dec, noise], 1)
    save_webp('misc.webp', img, quality=88)
    PACK['misc'] = dict(scorch_scale=1.05)


def props():
    for name, alb, aop, size in (('chest', 'chest_albedo', 0.7, None), ('rock', 'rock_albedo', 0.6, None),
                                 ('blade', 'blade_albedo', 0.6, None)):
        a = np.load(os.path.join(WORK, alb + '.npy'))[::-1]
        c = a[..., :3] * np.clip(a[..., 3:4], 0, 1) ** aop
        save_webp(f'{name}.webp', srgb(c), quality=88)
    nm = np.load(os.path.join(WORK, 'rock_normal.npy'))[::-1]
    save_webp('rock_n.webp', np.clip(nm, 0, 1), quality=92)


if __name__ == '__main__':
    what = sys.argv[1] if len(sys.argv) > 1 else 'all'
    for k, fn in (('fire', fire), ('fireball', fireball), ('powder', powder)):
        if what in (k, 'all') and os.path.exists(os.path.join(WORK, f'{k}_frames.npy')):
            fn()
    if what in ('misc', 'all'):
        misc()
    if what in ('props', 'all'):
        props()
    json.dump(PACK, open(PACK_P, 'w'), indent=1)
