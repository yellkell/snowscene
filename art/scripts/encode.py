"""Turn a region's float bakes into runtime textures + manifest.  python art/scripts/encode.py survivors

Light channels are stored sqrt-encoded against a per-channel maximum (recorded in the manifest), so the
runtime decodes  L = tex^2 * max  and recombines  albedo * (sunColor * Ls + skyTint * Lk).
Rows: float arrays come from Blender bottom-up; images are written top-down (np.flipud), so three's default
flipY puts uv (0,0) at the first Blender row.
"""
import json, os, sys, shutil
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
REGION = sys.argv[1] if len(sys.argv) > 1 else 'survivors'
SRC = os.path.join(ROOT, 'art', 'work', f'bake_{REGION}')
DST = os.path.join(ROOT, 'public', REGION)
os.makedirs(DST, exist_ok=True)
BAKE = json.load(open(os.path.join(SRC, 'bake.json')))
LAYOUT = json.load(open(os.path.join(ROOT, 'art', 'work', f'{REGION}_layout.json')))
ATLASES = ('wall', 'bands', 'bluff', 'deck', 'hut', 'props', 'rim', 'party', 'lake')
GROUNDS = ('ground', 'trail')
MAN = {'version': 1}


def load(name):
    p = os.path.join(SRC, name + '.npy')
    return np.load(p) if os.path.exists(p) else None


def srgb(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def enc(x, mx):
    return np.sqrt(np.clip(x / mx, 0, 1))


def u8(a):
    return (np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)


def write(name, arr, quality=92, lossless=False):
    arr = np.flipud(arr)
    mode = 'RGBA' if arr.shape[-1] == 4 else 'RGB'
    im = Image.fromarray(u8(arr), mode)
    path = os.path.join(DST, name)
    if name.endswith('.webp'):
        im.save(path, 'WEBP', quality=quality, lossless=lossless, method=6, exact=True)
    elif name.endswith('.png'):
        im.save(path, 'PNG', optimize=True)
    else:
        im.save(path, 'JPEG', quality=quality, subsampling=0)
    print(f'  {name} {im.size} {os.path.getsize(path) / 1e6:.2f} MB')
    return name


def dilate(rgb, mask, iters=16):
    """Push colour outward from covered pixels into uncovered ones (avoids dark mip fringes)."""
    rgb = rgb.copy()
    m = mask.astype(bool).copy()
    for _ in range(iters):
        if m.all():
            break
        acc = np.zeros_like(rgb)
        cnt = np.zeros(m.shape, np.float32)
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            sm = np.roll(m, (dy, dx), (0, 1))
            sr = np.roll(rgb, (dy, dx), (0, 1))
            add = sm & ~m
            acc[add] += sr[add]
            cnt[add] += 1
        grow = cnt > 0
        rgb[grow] = acc[grow] / cnt[grow][:, None]
        m |= grow
    return rgb


def mode(a, bins=400):
    """Most common value: what open, level, unshadowed snow gets (the bulk of the arena)."""
    h, e = np.histogram(a, bins=bins, range=(0, float(np.percentile(a, 99.5))))
    i = int(np.argmax(h))
    return float((e[i] + e[i + 1]) / 2)


def fill(arr, mask):
    """Push-pull: every uncovered texel takes the average of the nearest covered ones, at whatever
    scale finds some, so an atlas's empty space never mips black into its islands."""
    a = arr if arr.ndim == 3 else arr[..., None]
    m = mask.astype(np.float32)[..., None]
    levels = [(a * m, m)]
    while min(levels[-1][1].shape[:2]) > 1:
        s, w = levels[-1]
        h, wd = (s.shape[0] // 2) * 2, (s.shape[1] // 2) * 2
        s, w = s[:h, :wd], w[:h, :wd]
        s2 = s[0::2, 0::2] + s[1::2, 0::2] + s[0::2, 1::2] + s[1::2, 1::2]
        w2 = w[0::2, 0::2] + w[1::2, 0::2] + w[0::2, 1::2] + w[1::2, 1::2]
        levels.append((s2, w2))
    col = levels[-1][0] / np.maximum(levels[-1][1], 1e-8)
    for s, w in reversed(levels[:-1]):
        up = np.repeat(np.repeat(col, 2, 0), 2, 1)
        up = np.pad(up, ((0, s.shape[0] - up.shape[0]), (0, s.shape[1] - up.shape[1]), (0, 0)), mode='edge')
        have = w > 0
        col = np.where(have, s / np.maximum(w, 1e-8), up)
    out = np.where(m > 0, a, col)
    return out if arr.ndim == 3 else out[..., 0]


def ktx2_twins(region):
    """Refresh the GPU-compressed twins of whatever this encode rewrote (art/scripts/ktx2.mjs)."""
    import subprocess
    subprocess.run(['node', os.path.join(ROOT, 'art', 'scripts', 'ktx2.mjs'), region + '/'], cwd=ROOT, check=False)


def pmax(a, q=99.95, k=1.08):
    return float(np.percentile(a, q) * k) or 1.0


# ---------------------------------------------------------------- generic regions (tutorial)
if REGION != 'survivors':
    MAN['grounds'] = {}
    for g in GROUNDS:
        sn, sk_, al = load(f'{g}_sun'), load(f'{g}_sky'), load(f'{g}_albedo')
        if sn is None or g not in BAKE:
            continue
        smax, kmax = pmax(sn), pmax(sk_)
        x0, x1, y0, y1 = BAKE[g]['bounds_blender']
        # game space: x as is, z = -blender y; v runs along blender +y = game -z
        MAN['grounds'][g] = {'light': write(f'{g}_light.webp', np.stack([enc(sn, smax), enc(sk_, kmax), np.zeros_like(sn)], -1), 94),
                             'albedo': write(f'{g}_albedo.webp', srgb(al), 92) if al is not None else None,
                             'x0': x0, 'x1': x1, 'z0': -y1, 'z1': -y0, 'sun_max': smax, 'sky_max': kmax,
                             'open_sun': mode(sn[sn > 0.25 * np.median(sn[sn > 1e-4])]),
                             # the open snow, not the bowl's shadowed / unbaked texels (a plain mode of the
                             # whole region landed on ~0 and lit everything that moves black)
                             'open_sky': mode(sk_[sk_ > 0.5 * np.median(sk_[sk_ > 1e-4])])}
    MAN['atlases'] = {}
    for a_ in ATLASES:
        al, sn, sk_ = load(f'{a_}_albedo'), load(f'{a_}_sun'), load(f'{a_}_sky')
        if al is None or not os.path.exists(os.path.join(SRC, f'{a_}.glb')):
            continue
        smax, kmax = pmax(sn), pmax(sk_)
        al = fill(al, al.max(-1) > 0)
        lm = sk_ > 0
        sn, sk_ = fill(sn, lm), fill(sk_, lm)
        MAN['atlases'][a_] = {'mesh': f'{a_}.glb', 'albedo': write(f'{a_}_albedo.webp', srgb(al), 92),
                              'light': write(f'{a_}_light.webp', np.stack([enc(sn, smax), enc(sk_, kmax), np.zeros_like(sn)], -1), 92),
                              'sun_max': smax, 'sky_max': kmax, 'tris': BAKE[a_].get('tris')}
        shutil.copy(os.path.join(SRC, f'{a_}.glb'), os.path.join(DST, f'{a_}.glb'))
    MAN['cabins'] = BAKE.get('cabins')
    MAN['trees'] = {'shared': '../survivors/manifest.json',
                    'instances': [[t['kind'], t['x'], t['y'], t['z'], t['s']] for t in LAYOUT['trees']]}
    # the vista: sky + the great ranges + the sea of clouds, as one panorama
    vp = os.path.join(ROOT, 'art', 'work', 'vista_sunset.npy')
    if os.path.exists(vp):
        v = np.load(vp)
        h = v.shape[0]
        band = v[int((90 - 40) / 180 * h):]                     # from 40 degrees below the horizon up
        kx = pmax(band, 99.0, 1.05)
        horizon = np.median(v[int(90 / 180 * h):int(94 / 180 * h)].reshape(-1, 3), axis=0)
        MAN['vista'] = {'texture': write('vista_sunset.webp', enc(band, kx), 95), 'max': kx, 'lat_min_deg': -40.0,
                        'horizon_rgb': [float(x) for x in horizon], 'roll': BAKE.get('vista_roll', 0.0)}
    MAN['sun'] = BAKE.get('sun')
    MAN['sky'] = BAKE.get('sky')
    json.dump(MAN, open(os.path.join(DST, 'manifest.json'), 'w'), indent=1)
    print('manifest ->', os.path.join(DST, 'manifest.json'))
    ktx2_twins(REGION)
    sys.exit(0)

# ---------------------------------------------------------------- ground
sun, sky, alb = load('ground_sun'), load('ground_sky'), load('ground_albedo')
if sun is not None:
    smax, kmax = pmax(sun), pmax(sky)
    a = alb.mean(-1)
    from PIL import Image as _I
    a_full = np.asarray(_I.fromarray((np.clip(a, 0, 1) * 65535).astype(np.uint16)).resize(sun.shape[::-1], _I.BILINEAR), np.float32) / 65535 if a.shape != sun.shape else a
    # B: albedo relative to fresh snow (0.9): 1 = clean snow, lower = thin/scoured snow.
    rgb = np.stack([enc(sun, smax), enc(sky, kmax), np.clip(a_full / 0.9, 0, 1)], -1)
    MAN['ground'] = {'lightmap': write('ground_light.webp', rgb, quality=94), 'extent': BAKE['ground']['extent'],
                     'sun_max': smax, 'sky_max': kmax,
                     # open, flat, unshadowed snow: the brightest common values, for moving things
                     'open_sun': mode(sun[sun > 0.25 * np.median(sun[sun > 1e-4])]), 'open_sky': mode(sky[sky > 0.5 * np.median(sky[sky > 1e-4])]),
                     'albedo_tint': [float(x) for x in (alb.reshape(-1, 3).mean(0) / max(alb.reshape(-1, 3).mean(0).max(), 1e-6))]}

# ---------------------------------------------------------------- props
pa, ps, pk = load('props_albedo'), load('props_sun'), load('props_sky')
if pa is not None and os.path.exists(os.path.join(SRC, 'props.glb')):
    smax, kmax = pmax(ps), pmax(pk)
    pa = fill(pa, pa.max(-1) > 0)
    ps, pk = fill(ps, pk > 0), fill(pk, pk > 0)
    MAN['props'] = {'mesh': 'props.glb', 'albedo': write('props_albedo.webp', srgb(pa), 90),
                    'light': write('props_light.webp', np.stack([enc(ps, smax), enc(pk, kmax), np.zeros_like(ps)], -1), 92),
                    'sun_max': smax, 'sky_max': kmax}
    shutil.copy(os.path.join(SRC, 'props.glb'), os.path.join(DST, 'props.glb'))

# ---------------------------------------------------------------- trees: LOD meshes + one impostor atlas
trees = BAKE.get('trees', {})
if trees:
    frames = {}
    for key, info in trees.items():
        s, k = load(f'imp_{key}_sun'), load(f'imp_{key}_sky')
        if s is None:
            continue
        frames[key] = (s, k, info)
    # shared light maxima over all impostors (colour channels)
    smax = max(pmax(f[0][..., :3][f[0][..., 3] > 0.5]) for f in frames.values())
    kmax = max(pmax(f[1][..., :3][f[1][..., 3] > 0.5]) for f in frames.values())
    # shelf-pack the variant blocks into a 4096-wide atlas, tallest first
    W = 4096
    order = sorted(frames, key=lambda k: -frames[k][0].shape[0])
    x = y = shelf = 0
    rects = {}
    for key in order:
        h, w = frames[key][0].shape[:2]
        if x + w > W:
            x, y, shelf = 0, y + shelf, 0
        rects[key] = (x, y, w, h)
        x += w
        shelf = max(shelf, h)
    Ht = y + shelf
    A_sun = np.zeros((Ht, W, 4), np.float32)
    A_sky = np.zeros((Ht, W, 3), np.float32)
    from_top = {}
    for key, (x, y, w, h) in rects.items():
        s, k, info = frames[key]
        # premultiplied by alpha in the render; un-premultiply, then bleed colour into empty texels
        a = s[..., 3:4]
        cs = np.where(a > 1e-3, s[..., :3] / np.maximum(a, 1e-3), 0)
        ck = np.where(a > 1e-3, k[..., :3] / np.maximum(a, 1e-3), 0)
        m = a[..., 0] > 0.02
        cs, ck = dilate(cs, m, 6), dilate(ck, m, 6)
        # Blender rows are bottom-up within the block: place the block so that after the final flip the
        # block's top-left is at (x, y) from the top of the image.
        Y0 = Ht - y - h
        A_sun[Y0:Y0 + h, x:x + w, :3] = enc(cs, smax)
        A_sun[Y0:Y0 + h, x:x + w, 3] = a[..., 0]
        A_sky[Y0:Y0 + h, x:x + w] = enc(ck, kmax)
        from_top[key] = {'x': x, 'y': y, 'w': w, 'h': h}
    MAN['trees'] = {
        'atlas_sun': write('trees_sun.webp', A_sun, 92), 'atlas_sky': write('trees_sky.webp', A_sky, 90),
        'atlas_size': [W, Ht], 'sun_max': smax, 'sky_max': kmax, 'variants': {},
    }
    for key, (s, k, info) in frames.items():
        shutil.copy(os.path.join(SRC, f'tree_{key}.glb'), os.path.join(DST, f'tree_{key}.glb'))
        MAN['trees']['variants'][key] = {'mesh': f'tree_{key}.glb', 'rect': from_top[key], **{
            kk: info[kk] for kk in ('frame', 'yaws', 'elevs', 'width', 'height', 'centre_y', 'ortho', 'tris', 'light_max')}}
    MAN['trees']['instances'] = [[t['kind'], t['x'], t['y'], t['z'], t['s']] for t in LAYOUT['trees']]

# ---------------------------------------------------------------- skies (the evening: sunset -> night)
skies = BAKE.get('skies', {'sunset': {}})
MAN['skies'] = {}
# The photographs are each exposed for themselves (the night shot is as bright as the dusk), so their
# true relative brightness is imposed here: sky light on a level surface, as a fraction of the sunset's.
EVENING_BRIGHTNESS = {'sunset': 1.0, 'dusk1': 0.25, 'dusk2': 0.07, 'night': 0.012}
lumE = lambda e: e[0] * 0.2126 + e[1] * 0.7152 + e[2] * 0.0722
ref = lumE(skies['sunset']['irradiance_rgb']) if 'irradiance_rgb' in skies.get('sunset', {}) else 1.0
for name, meta in skies.items():
    sk = load(f'sky_{name}')
    if sk is None:
        continue
    if 'irradiance_rgb' in meta:
        k = EVENING_BRIGHTNESS.get(name, 1.0) * ref / lumE(meta['irradiance_rgb'])
        sk = sk * k
        meta = {**meta, 'irradiance_rgb': [x * k for x in meta['irradiance_rgb']], 'scale': k}
    h = sk.shape[0]
    # keep from 6 degrees below the horizon to the zenith (rows are bottom-up: lat -90 at row 0)
    band = sk[int((90 - 6) / 180 * h):]
    # the sun's aureole is drawn analytically; keep the 8-bit range for the sky itself (no banding)
    kx = pmax(band, 98.5, 1.05)
    # Horizon radiance (0-4 degrees up, all the way round): the colour of the air at distance.
    horizon = np.median(sk[int(90 / 180 * h):int(94 / 180 * h)].reshape(-1, 3), axis=0)
    MAN['skies'][name] = {'texture': write(f'sky_{name}.webp', enc(band, kx), 96), 'max': kx, 'lat_min_deg': -6.0,
                          'horizon_rgb': [float(x) for x in horizon], **meta}
if 'sunset' in MAN['skies']:
    MAN['sky'] = {**MAN['skies']['sunset'], **BAKE.get('sky', {})}

MAN['sun'] = LAYOUT['sun']
json.dump(MAN, open(os.path.join(DST, 'manifest.json'), 'w'), indent=1)
print('manifest ->', os.path.join(DST, 'manifest.json'))

# ---------------------------------------------------------------- shared runtime textures (once)
TEXD = os.path.join(ROOT, 'public', 'textures')
os.makedirs(TEXD, exist_ok=True)
W_ = os.path.join(ROOT, 'art', 'work')
if not os.path.exists(os.path.join(TEXD, 'spray.webp')):
    d = Image.open(os.path.join(W_, 'spray_diff.png')).convert('RGB').resize((1024, 1024), Image.LANCZOS)
    a = Image.open(os.path.join(W_, 'spray_alpha.png')).convert('L').resize((1024, 1024), Image.LANCZOS)
    d.putalpha(a)
    d.save(os.path.join(TEXD, 'spray.webp'), 'WEBP', quality=90, method=6, exact=True)
    print('  textures/spray.webp')
if not os.path.exists(os.path.join(TEXD, 'snow_detail_nor.webp')):
    n = Image.open(os.path.join(ROOT, 'art', 'assets', 'polyhaven', 'textures', 'snow_02', 'snow_02_nor_gl_2k.jpg')).convert('RGB')
    n.resize((1024, 1024), Image.LANCZOS).save(os.path.join(TEXD, 'snow_detail_nor.webp'), 'WEBP', quality=92, method=6)
    print('  textures/snow_detail_nor.webp')
ktx2_twins('survivors')
ktx2_twins('textures')
