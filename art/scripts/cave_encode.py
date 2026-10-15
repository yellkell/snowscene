"""The ice mine's bakes -> runtime textures, meshes and manifest.   python art/scripts/cave_encode.py

art/work/bake_cave/*.npy|glb  ->  public/cave/

Light channels (day = the chimney's daylight, lantern, beacon) are stored sqrt-encoded against a maximum
each (L = t^2 * max), one channel per colour of a single RGB texture per region, so the runtime decodes
    albedo * (Ld * dayColour + Ll * lanternColour * flicker + Lb * beaconColour * beacon)
Region albedos carry a fourth channel: the glacier's own glow (shell) or the lantern globes' emission
(works), sqrt-encoded against their own maximum. The machine and deck atlases carry ambient occlusion in
alpha. The light volume is one RGBA8 3D texture: width x height x (6 faces * depth), RGB = the three
channels' irradiance onto that face (sqrt-encoded), A = 1 where the probe stood in the open.
Rows: float arrays come from Blender bottom-up; images are written top-down, so three's flipY puts
uv (0, 0) at the first Blender row.
"""
import json, os, shutil
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, 'art', 'work', 'bake_cave')
DST = os.path.join(ROOT, 'public', 'cave')
os.makedirs(DST, exist_ok=True)
BAKE = json.load(open(os.path.join(SRC, 'bake.json')))
LAYOUT = json.load(open(os.path.join(ROOT, 'art', 'work', 'cave_ref', 'cave_layout.json')))
MAN = {'version': 1}
CH = ('day', 'lantern', 'beacon')
ALB_MAX = 2048


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


def pmax(a, q=99.5, k=1.1):
    v = float(np.percentile(a[a > 0] if (a > 0).any() else a, q) * k)
    return v if v > 0 else 1.0


def write(name, arr, quality=92, lossless=False):
    arr = np.flipud(arr)
    mode = 'RGBA' if arr.shape[-1] == 4 else 'RGB'
    im = Image.fromarray(u8(arr), mode)
    path = os.path.join(DST, name)
    im.save(path, 'WEBP', quality=quality, lossless=lossless, method=6, exact=True, alpha_quality=95)
    print(f'  {name} {im.size} {os.path.getsize(path) / 1e6:.2f} MB')
    return name


def dilate(rgb, mask, iters=12):
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


def lum(a):
    return a[..., 0] * 0.2126 + a[..., 1] * 0.7152 + a[..., 2] * 0.0722


def resize(a, shape):
    if a.shape[:2] == shape:
        return a
    ch = a.shape[2] if a.ndim == 3 else 1
    out = []
    for c in range(ch):
        x = a[..., c] if a.ndim == 3 else a
        out.append(np.asarray(Image.fromarray(x.astype(np.float32), 'F').resize(shape[::-1], Image.BILINEAR)))
    return np.stack(out, -1) if a.ndim == 3 else out[0]


def lit_region(name, extra_name, extra_ch_from):
    """albedo(+extra in alpha) and the three light channels of an atlas region."""
    alb = load(f'{name}_albedo')
    lights = [load(f'{name}_{c}') for c in CH]
    if alb is None or any(l is None for l in lights):
        return None
    mx = [pmax(l) for l in lights]
    light = np.stack([enc(l, m) for l, m in zip(lights, mx)], -1)
    emit = load(f'{name}_emit')
    e = lum(emit) if emit is not None else np.zeros(alb.shape[:2], np.float32)
    e = resize(e, alb.shape[:2])
    emax = pmax(e, 99.95, 1.0) if (e > 1e-6).any() else 1.0
    # albedo dilated into the gutters so mips and bilinear never fetch black
    cover = alb.max(-1) > 1e-4
    a = dilate(alb, cover)
    # Quest memory: 2048 at most (the wood's grain comes back from the detail texture)
    if a.shape[0] > ALB_MAX:
        a = resize(a, (ALB_MAX, ALB_MAX))
        e = resize(e, (ALB_MAX, ALB_MAX))
    rgba = np.concatenate([srgb(a), enc(e, emax)[..., None]], -1)
    info = {'mesh': f'{name}.glb', 'albedo': write(f'{name}_albedo.webp', rgba, 92),
            'light': write(f'{name}_light.webp', light, 94), 'max': mx, extra_name: emax,
            'tris': BAKE.get(name, {}).get('tris')}
    shutil.copy(os.path.join(SRC, f'{name}.glb'), os.path.join(DST, f'{name}.glb'))
    return info


print('shell')
MAN['shell'] = lit_region('shell', 'glow_max', 'day')
print('works')
MAN['works'] = lit_region('works', 'emit_max', 'lantern')
print('debris')
MAN['debris'] = lit_region('debris', 'emit_max', 'lantern')


def ao_atlas(name):
    alb, ao = load(f'{name}_albedo'), load(f'{name}_ao')
    if alb is None:
        return None
    cover = alb.max(-1) > 1e-4
    a = dilate(alb, cover)
    o = dilate(ao[..., None], cover)[..., 0] if ao is not None else np.ones(alb.shape[:2])
    return write(f'{name}_albedo.webp', np.concatenate([srgb(a), np.clip(o, 0, 1)[..., None]], -1), 92)


print('machines')
mb = BAKE.get('machines')
if mb:
    MAN['machines'] = {'albedo': ao_atlas('machines'), 'objects': {}}
    for k, v in mb['objects'].items():
        shutil.copy(os.path.join(SRC, v['mesh']), os.path.join(DST, v['mesh']))
        MAN['machines']['objects'][k] = v
db = BAKE.get('deck')
if db:
    MAN['deck'] = {'albedo': ao_atlas('deck'), 'mesh': db['objects']['DECK_TILE']['mesh'], 'tris': db['objects']['DECK_TILE']['tris']}
    shutil.copy(os.path.join(SRC, MAN['deck']['mesh']), os.path.join(DST, MAN['deck']['mesh']))

print('rope')
ra, rn, ro = load('rope_albedo'), load('rope_normal'), load('rope_ao')
if ra is not None:
    MAN['rope'] = {'albedo': write('rope_albedo.webp', np.concatenate([srgb(ra), np.clip(ro, 0, 1)[..., None]], -1), 92),
                   'normal': write('rope_normal.webp', np.clip(rn, 0, 1), 95), **BAKE['rope']}

print('volume')
vb = BAKE.get('volume')
if vb:
    nx, ny, nz = vb['dims']
    vols = [load(f'volume_{c}') for c in CH]          # (count, 6) each, count = x fastest, then y, then z
    valid = load('volume_valid') > 0.5
    mx = [pmax(v[valid], 99.5, 1.1) for v in vols]
    V = np.stack(vols, -1).reshape(nz, ny, nx, 6, 3)    # [k, j, i, face, ch]
    ok = valid.reshape(nz, ny, nx)
    # probes buried in timber or ice: fill from their open neighbours
    filled = ok.copy()
    for _ in range(12):
        if filled.all():
            break
        acc = np.zeros_like(V)
        cnt = np.zeros(filled.shape, np.float32)
        for ax in range(3):
            for d in (-1, 1):
                sm = np.roll(filled, d, ax)
                sv = np.roll(V, d, ax)
                # no wrap-around across the grid's edges
                edge = [slice(None)] * 3
                edge[ax] = 0 if d == 1 else -1
                sm[tuple(edge)] = False
                add = sm & ~filled
                acc[add] += sv[add]
                cnt[add] += 1
        grow = cnt > 0
        V[grow] = acc[grow] / cnt[grow][:, None, None]
        filled |= grow
    out = np.zeros((6, nz, ny, nx, 4), np.uint8)       # depth = face * nz + k
    for c in range(3):
        out[..., c] = u8(enc(np.moveaxis(V[..., c], 3, 0), mx[c]))
    out[..., 3] = u8(ok.astype(np.float32))[None]
    out.tofile(os.path.join(DST, 'volume.bin'))
    MAN['volume'] = {'file': 'volume.bin', 'dims': [nx, ny, nz], 'origin': vb['origin'], 'step': vb['step'], 'max': mx,
                     'faces': vb['faces'], 'valid': float(ok.mean())}
    print(f'  volume.bin {out.nbytes / 1e6:.2f} MB, {ok.mean() * 100:.0f}% open')

# ---------------------------------------------------------------- detail textures
print('detail')
from PIL import ImageFilter
TEXD = os.path.join(ROOT, 'art', 'assets', 'polyhaven', 'textures', 'wood_planks_grey', 'wood_planks_grey_diff_2k.jpg')
g = Image.open(TEXD).convert('L')
lo = g.filter(ImageFilter.GaussianBlur(24))
ratio = np.asarray(g, np.float32) / np.maximum(np.asarray(lo, np.float32), 1.0)
ratio = np.clip(ratio * 0.5, 0, 1)
wd = Image.fromarray(u8(ratio)).resize((1024, 1024), Image.LANCZOS).convert('RGB')
# sampled at the glTF's WoodUV with flipY off: rows as in the scan (Blender's v=0 is its bottom row)
wd.save(os.path.join(DST, 'wood_detail.webp'), 'WEBP', quality=90, method=6)
# scallops: dish-shaped melt hollows on a tileable jittered grid (one tile = 1.6 m at runtime)
N, C = 512, 7
rng = np.random.default_rng(3)
pts = (np.stack(np.meshgrid(np.arange(C), np.arange(C)), -1).reshape(-1, 2) + 0.15 + rng.random((C * C, 2)) * 0.7) / C
yy, xx = np.mgrid[0:N, 0:N] / N
d1 = np.full((N, N), 9.0)
for p in pts:
    for ox in (-1, 0, 1):
        for oy in (-1, 0, 1):
            dx = xx - (p[0] + ox)
            dy = yy - (p[1] + oy)
            d1 = np.minimum(d1, dx * dx + dy * dy)
h = np.sqrt(d1) * C
h = h * h
gy, gx = np.gradient(h)
k = 6.0
nrm = np.stack([-gx * k * N / C, -gy * k * N / C, np.ones_like(h)], -1)
nrm /= np.linalg.norm(nrm, axis=-1, keepdims=True)
ice = np.concatenate([nrm[..., :2] * 0.5 + 0.5, np.clip(h, 0, 1)[..., None]], -1)
Image.fromarray(u8(ice)).save(os.path.join(DST, 'ice_detail.webp'), 'WEBP', quality=92, method=6)
MAN['detail'] = {'wood': 'wood_detail.webp', 'ice': 'ice_detail.webp'}

# where the light comes from, for the runtime's glints and the pool's reflections (course space, game axes)
lan = []
for ln in LAYOUT['lanterns']:
    g = LAYOUT['groups'][ln['group']]
    lan.append([round(g[0] + ln['at'][0], 3), round(g[1] + ln['at'][1] + 0.02, 3), round(g[2] + ln['at'][2], 3)])
xp = os.path.join(ROOT, 'art', 'work', 'cave_ref', 'lanterns_extra.json')
if os.path.exists(xp):
    lan += json.load(open(xp))
MAN['lanterns'] = lan
MAN['beacon'] = LAYOUT['brazier']
MAN['chimney'] = LAYOUT['frame'][-1]
json.dump(MAN, open(os.path.join(DST, 'manifest.json'), 'w'), indent=1)
print('manifest ->', os.path.join(DST, 'manifest.json'))
