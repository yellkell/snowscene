"""The people at the lake party: mountaineers at a cold camp, properly proportioned (1.78 m: chin 1.55, eyes
1.665, crown 1.78, shoulders 1.45), dressed for it — down parkas with their baffles in the silhouette, hoods
up with fur ruffs, or beanies; buffs pulled up over the nose and goggles on, so the face is covered as it
would be; insulated trousers, gaiters, double boots, mitts.

Built in the game's figure space (src/game/figure.ts: feet on y = 0, facing +Z), Blender (x, -z, y). The
arms are separate objects in shoulder-pivot space (SHOULDER, mirrored), so the runtime can swing them.
"""
import math, random
from mathutils import Vector
from . import core, snowmats as SM
from .nodes import NB

G = lambda x, y, z: Vector((x, -z, y))
SHOULDER = (0.235, 1.42, 0.0)    # figure.ts BAKED_ARM_PIVOT
TAU = math.tau
HEAD = Vector((0.0, 1.665, 0.012))
HEAD_R = (0.079, 0.116, 0.098)

LENSES = [(0.9, 0.42, 0.08), (0.15, 0.35, 0.9), (0.62, 0.63, 0.66), (0.85, 0.22, 0.5), (0.2, 0.7, 0.4), (0.95, 0.72, 0.12)]
VARIANTS = [
    dict(jacket=(0.62, 0.06, 0.04), down=True, hood=True, trousers=(0.03, 0.03, 0.035), boots=(0.75, 0.6, 0.05), knit=None, buff=(0.12, 0.13, 0.15), mitt=(0.03, 0.03, 0.03)),
    dict(jacket=(0.85, 0.55, 0.03), down=False, hood=False, trousers=(0.05, 0.06, 0.09), boots=(0.08, 0.08, 0.08), knit=(0.06, 0.16, 0.42), buff=(0.5, 0.08, 0.06), mitt=(0.45, 0.05, 0.03)),
    dict(jacket=(0.04, 0.17, 0.5), down=True, hood=False, trousers=(0.12, 0.12, 0.13), boots=(0.55, 0.06, 0.04), knit=(0.6, 0.06, 0.05), buff=(0.35, 0.35, 0.36), mitt=(0.03, 0.03, 0.03)),
    dict(jacket=(0.06, 0.3, 0.12), down=True, hood=True, trousers=(0.62, 0.2, 0.03), boots=(0.08, 0.08, 0.08), knit=None, buff=(0.04, 0.04, 0.05), mitt=(0.6, 0.25, 0.03)),
    dict(jacket=(0.8, 0.22, 0.02), down=False, hood=True, trousers=(0.8, 0.22, 0.02), boots=(0.75, 0.6, 0.05), knit=None, buff=(0.1, 0.1, 0.11), mitt=(0.03, 0.03, 0.03)),
    dict(jacket=(0.28, 0.08, 0.4), down=True, hood=False, trousers=(0.03, 0.03, 0.035), boots=(0.08, 0.08, 0.08), knit=(0.75, 0.72, 0.66), buff=(0.08, 0.2, 0.32), mitt=(0.03, 0.03, 0.03)),
]


def mats(v, k):
    """Materials for variant k (names carry k so each variant bakes its own colours)."""
    M = {}

    def fabric(name, col, rough, weave=600.0, sheen=0.0, bump=0.04):
        m = SM.new(f'fig{k}_{name}')
        nb = NB(m)
        w = nb.n('ShaderNodeTexWave', wave_type='BANDS', ins={'Vector': nb.pos(), 'Scale': weave}).outputs['Fac']
        p = nb.bsdf(col, rough=rough, normal=nb.bump(w, strength=bump, dist=0.0004), out=False)
        if sheen:
            p.inputs['Sheen Weight'].default_value = sheen
        nb.link(p.outputs[0], nb.out.inputs['Surface'])
        return m

    M['jacket'] = fabric('jacket', v['jacket'], 0.32 if v['down'] else 0.5, sheen=0.3)
    M['trousers'] = fabric('trousers', v['trousers'], 0.7, weave=400.0)
    M['gaiter'] = fabric('gaiter', (0.025, 0.025, 0.03), 0.55)
    M['boot'] = fabric('boot', v['boots'], 0.4, weave=200.0, bump=0.02)
    M['sole'] = fabric('sole', (0.02, 0.02, 0.02), 0.85, weave=60.0, bump=0.2)
    M['buff'] = fabric('buff', v['buff'], 0.75, weave=900.0)
    M['mitt'] = fabric('mitt', v['mitt'], 0.6, weave=300.0)
    M['strap'] = fabric('strap', (0.02, 0.02, 0.025), 0.6, weave=1200.0)
    M['zip'] = fabric('zip', (0.02, 0.02, 0.02), 0.35)
    if v['knit']:
        m = SM.new(f'fig{k}_knit')
        nb = NB(m)
        rib = nb.n('ShaderNodeTexWave', wave_type='BANDS', bands_direction='X', ins={'Vector': nb.pos(), 'Scale': 260.0, 'Distortion': 0.4}).outputs['Fac']
        nb.bsdf(nb.mix(nb.math('MULTIPLY', rib, 0.3), v['knit'], tuple(c * 0.65 for c in v['knit'])), rough=0.95,
                normal=nb.bump(rib, strength=0.5, dist=0.002))
        M['knit'] = m
    m = SM.new(f'fig{k}_fur')
    nb = NB(m)
    g = nb.noise(nb.pos(), 160.0, detail=8.0)
    nb.bsdf(nb.mix(nb.mrange(g, 0.35, 0.7, 0, 1), (0.22, 0.17, 0.12), (0.62, 0.58, 0.52)), rough=0.9,
            normal=nb.bump(g, strength=0.8, dist=0.004))
    M['fur'] = m
    m = SM.new(f'fig{k}_lens')
    NB(m).bsdf(LENSES[k % len(LENSES)], rough=0.08, metal=1.0)
    M['lens'] = m
    return M


# ------------------------------------------------------------------ lofting
def ring(c, rx, rz, n, u=Vector((1, 0, 0)), w=Vector((0, 0, 1)), ex=2.0, fn=None):
    """n points round c (game space) in the plane (u, w), a superellipse of exponent ex."""
    out = []
    for i in range(n):
        a = i / n * TAU
        ca, sa = math.cos(a), math.sin(a)
        x = math.copysign(abs(ca) ** (2 / ex), ca) * rx
        z = math.copysign(abs(sa) ** (2 / ex), sa) * rz
        s = fn(a) if fn else 1.0
        out.append(c + u * (x * s) + w * (z * s))
    return out


def loft(b, rings, mat, cap0=False, cap1=False):
    vs = [[b.bm.verts.new(G(*p)) for p in r] for r in rings]
    n = len(rings[0])
    for j in range(len(vs) - 1):
        for i in range(n):
            i2 = (i + 1) % n
            b._face((vs[j][i], vs[j][i2], vs[j + 1][i2], vs[j + 1][i]), mat, smooth=True)
    for cap, r, flip in ((cap0, vs[0], True), (cap1, vs[-1], False)):
        if cap:
            cv = b.bm.verts.new(sum((v.co for v in r), Vector()) / n)
            for i in range(n):
                b._face((r[(i + 1) % n], r[i], cv) if flip else (r[i], r[(i + 1) % n], cv), mat, smooth=True)


def ellipsoid(b, c, r, mat, lat0=-math.pi / 2, lat1=math.pi / 2, n_lat=12, n_lon=20, grow=0.0, fn=None):
    """A (partial) ellipsoid as a loft of horizontal rings; fn(lat, lon) scales the radius."""
    rings = []
    for i in range(n_lat + 1):
        lat = lat0 + (lat1 - lat0) * i / n_lat
        cl, sl = math.cos(lat), math.sin(lat)
        rings.append([c + Vector((math.sin(lon) * cl * (r[0] + grow), sl * (r[1] + grow), math.cos(lon) * cl * (r[2] + grow))) *
                      1.0 for lon in (j / n_lon * TAU for j in range(n_lon))])
        if fn:
            rings[-1] = [c + (p - c) * fn(lat, j / n_lon * TAU) for j, p in enumerate(rings[-1])]
    loft(b, rings, mat, cap0=lat0 <= -math.pi / 2 + 1e-6, cap1=lat1 >= math.pi / 2 - 1e-6)


def baffle(t, period, depth):
    """Down baffles: puffed between stitch lines."""
    return 1 + depth * (abs(math.sin(math.pi * t / period)) ** 0.55 - 0.6)


def lerp_prof(prof, y):
    j = max(i for i in range(len(prof)) if prof[i][0] <= y + 1e-9)
    j = min(j, len(prof) - 2)
    t = (y - prof[j][0]) / (prof[j + 1][0] - prof[j][0])
    return [prof[j][q] + (prof[j + 1][q] - prof[j][q]) * t for q in range(1, len(prof[0]))]


# ------------------------------------------------------------------ the figure
def body(name, coll, k, seed=0):
    v = VARIANTS[k]
    M = mats(v, k)
    R = random.Random(seed * 31 + k)
    b = core.Builder(name, coll, smooth_angle=60)
    V = Vector
    for s in (-1, 1):
        x = s * 0.105
        # double boot: a lugged sole, a chunky rounded upper, a shaft under the gaiter
        b.cbox(G(x, 0.017, 0.045), (0.12, 0.034, 0.315), M['sole'], bev=0.014, seg=2)
        prof = [(0.0, 0.08, 0.13), (0.15, 0.1, 0.13), (0.45, 0.112, 0.11), (0.75, 0.108, 0.088), (0.9, 0.096, 0.075), (0.97, 0.07, 0.058), (1.0, 0.03, 0.03)]
        rings = []
        for i in range(17):
            t = i / 16
            w, h = lerp_prof(prof, t)
            rings.append(ring(V((x, 0.032 + h / 2, -0.1 + t * 0.3)), w / 2, h / 2, 16, u=V((1, 0, 0)), w=V((0, 1, 0)), ex=3.0))
        loft(b, rings, M['boot'], cap0=True, cap1=True)
        loft(b, [ring(V((x, y, -0.035)), 0.06, 0.068, 16, ex=2.4) for y in (0.1, 0.16, 0.22)], M['boot'])
        # gaiter over the shaft, then the trouser leg up to the hip
        loft(b, [ring(V((x, y, -0.01)), r, r * 1.08, 16) for y, r in ((0.17, 0.07), (0.25, 0.073), (0.36, 0.075), (0.44, 0.072))], M['gaiter'])
        legs = [(0.42, 0.068), (0.52, 0.07), (0.62, 0.077), (0.74, 0.088), (0.88, 0.1)]
        loft(b, [ring(V((x * (1 - 0.12 * (y - 0.42)), y, 0.0)), r, r * 1.08, 16) for y, r in legs], M['trousers'])
    # the parka: hem over the hips, baffled if down; level shoulders that round off into the collar
    hem = 0.7 if v['down'] else 0.78
    prof = [(hem, 0.21, 0.155), (0.82, 0.2, 0.148), (0.95, 0.19, 0.14), (1.06, 0.182, 0.134), (1.2, 0.19, 0.142),
            (1.32, 0.198, 0.148), (1.41, 0.2, 0.14), (1.455, 0.185, 0.122), (1.49, 0.13, 0.1), (1.51, 0.085, 0.082)]
    ys = [hem + i * 0.014 for i in range(int((1.51 - hem) / 0.014) + 1)]
    rings = []
    for y in ys:
        rx, rz = lerp_prof(prof, y)
        f = baffle(y - hem, 0.1, 0.06) if v['down'] and y < 1.44 else 1 + 0.008 * math.sin(y * 37 + k)
        wob = lambda a, y=y: 1 + 0.01 * math.sin(3 * a + y * 23 + k)
        rings.append(ring(V((0, y, 0.0)), rx * f, rz * f, 28, ex=2.5, fn=wob))
    loft(b, rings, M['jacket'], cap0=True)
    # front zip and two hand-warmer pocket zips
    zline = [G(*(max(r, key=lambda p: p.z) + V((0, 0, 0.004)))) for r in rings]
    b.tube(zline, 0.006, M['zip'], sides=4)
    for s in (-1, 1):
        pts = []
        for q in range(6):
            t = q / 5
            y = 0.86 + 0.16 * t
            rx, rz = lerp_prof(prof, y)
            a = math.pi / 2 - s * (0.55 + 0.25 * t)
            pts.append(G(math.cos(a) * rx * 1.04, y, math.sin(a) * rz * 1.06))
        b.tube(pts, 0.005, M['zip'], sides=4)
    # neck and head: under the buff to the nose, goggles at the eyes, then the hood or a beanie
    loft(b, [ring(V((0, y, 0.004)), r, r, 18) for y, r in ((1.47, 0.07), (1.53, 0.064), (1.58, 0.066))], M['buff'])
    ellipsoid(b, HEAD, HEAD_R, M['buff'], lat0=-math.pi / 2, lat1=-0.1, n_lat=8, grow=0.004,
              fn=lambda lat, lon: 1 + 0.12 * max(0.0, math.cos(lon)) ** 8 * math.exp(-((lat + 0.25) / 0.2) ** 2))  # the nose under the buff
    ellipsoid(b, HEAD, HEAD_R, M['buff'] if v['hood'] else M['strap'], lat0=-0.1, lat1=math.pi / 2, n_lat=8)
    gy = HEAD.y + 0.004
    arc = [V((math.sin(a) * (HEAD_R[0] + 0.012), gy, HEAD.z + math.cos(a) * (HEAD_R[2] + 0.014))) for a in (-1.3 + 2.6 * j / 18 for j in range(19))]
    # a thick foam frame proud of the face, the lens set into it
    for lo, hi, off, m in ((-0.028, 0.028, 0.004, M['strap']), (-0.022, 0.022, 0.016, M['strap']), (-0.019, 0.019, 0.018, M['lens'])):
        rows = [[G(*(p + V((0, y, 0)) + (V((p.x, 0, p.z - HEAD.z))).normalized() * off)) for p in arc] for y in (lo, hi)]
        vv = [[b.bm.verts.new(p) for p in r] for r in rows]
        for j in range(18):
            b._face((vv[0][j], vv[0][j + 1], vv[1][j + 1], vv[1][j]), m, smooth=True)
    loft(b, [ring(V((0, gy + dy, HEAD.z)), HEAD_R[0] + 0.009, HEAD_R[2] + 0.009, 22) for dy in (-0.011, 0.011)], M['strap'])
    if v['hood']:
        hc = HEAD + V((0, 0.012, -0.02))
        hr = (0.122, 0.148, 0.14)
        n_lat, n_lon = 12, 30
        rows = []
        for i in range(n_lat + 1):
            lat = -0.62 + (math.pi / 2 + 0.62) * i / n_lat
            row = []
            for j in range(n_lon):
                lon = j / n_lon * TAU
                d = V((math.cos(lat) * math.sin(lon), math.sin(lat), math.cos(lat) * math.cos(lon)))
                puff = 1 + 0.035 * math.sin(lon * 3 + i) * (1 - abs(d.z))
                row.append((hc + V((d.x * hr[0], d.y * hr[1], d.z * hr[2])) * puff, d.z > 0.58 and lat > -0.42))
            rows.append(row)
        vs = [[b.bm.verts.new(G(*p)) for p, _ in row] for row in rows]
        for i in range(n_lat):
            for j in range(n_lon):
                j2 = (j + 1) % n_lon
                if rows[i][j][1] and rows[i][j2][1] and rows[i + 1][j][1] and rows[i + 1][j2][1]:
                    continue
                b._face((vs[i][j], vs[i][j2], vs[i + 1][j2], vs[i + 1][j]), M['jacket'], smooth=True)
        # the ruff: a shaggy tube round the opening, its radius ragged like fur
        cz = hc.z + hr[2] * 0.8
        ring_c = [V((math.cos(j / 48 * TAU) * 0.1, hc.y + math.sin(j / 48 * TAU) * 0.122, cz)) for j in range(48)]
        rows = []
        for c in ring_c:
            outw = V((c.x, c.y - hc.y, 0)).normalized()
            rows.append([c + outw * (math.cos(q / 10 * TAU) * r) + V((0, 0, 1)) * (math.sin(q / 10 * TAU) * r * 0.8)
                         for q, r in ((q, 0.032 * (0.75 + 0.5 * R.random())) for q in range(10))])
        rows.append(rows[0])
        loft(b, rows, M['fur'])
    else:
        # collar up round the buff, a beanie with its cuff turned up, a bobble on some
        loft(b, [ring(V((0, y, 0.004)), r, r * 1.04, 22) for y, r in ((1.49, 0.1), (1.54, 0.084), (1.585, 0.08))], M['jacket'])
        ellipsoid(b, HEAD + V((0, 0.002, 0)), HEAD_R, M['knit'], lat0=0.32, lat1=math.pi / 2, n_lat=8, grow=0.014,
                  fn=lambda lat, lon: 1 + 0.06 * math.sin(lat) ** 6)
        loft(b, [ring(V((0, HEAD.y + y, HEAD.z)), HEAD_R[0] * math.cos(0.3) + 0.022, HEAD_R[2] * math.cos(0.3) + 0.024, 24)
                 for y in (0.028, 0.045, 0.062, 0.072)], M['knit'])
        if k % 2 == 0:
            ellipsoid(b, HEAD + V((0, HEAD_R[1] + 0.045, -0.005)), (0.042, 0.038, 0.042), M['knit'], n_lat=8, n_lon=14,
                      fn=lambda lat, lon: 1 + 0.18 * R.random())
    return b.finish(merge=False)


def arm(name, coll, k, side):
    """One arm in shoulder-pivot space, hanging just clear of the parka: a puffed shoulder, the upper arm, a
    little bend at the elbow, the cuff, and a mitt with its thumb (palm to the thigh)."""
    v = VARIANTS[k]
    M = mats(v, k)
    b = core.Builder(name, coll, smooth_angle=60)
    V = Vector
    sx = side
    ellipsoid(b, V((sx * 0.004, -0.005, 0.0)), (0.072, 0.064, 0.076), M['jacket'], n_lat=8, n_lon=16)
    pts = [(0.012, -0.02, 0.0, 0.074), (0.03, -0.16, 0.0, 0.068), (0.045, -0.3, 0.008, 0.061),
           (0.052, -0.42, 0.045, 0.057), (0.056, -0.53, 0.08, 0.053)]
    rings = []
    for i in range(36):
        t = i / 35
        p = lerp_prof([(q / (len(pts) - 1),) + pts[q] for q in range(len(pts))], t)
        r = p[3] * (baffle(t * 0.53, 0.088, 0.08) if v['down'] else 1 + 0.03 * math.sin(t * 19 + k))
        rings.append(ring(V((sx * p[0], p[1], p[2])), r, r, 14))
    loft(b, rings, M['jacket'], cap0=True)
    wr = V((sx * 0.056, -0.53, 0.08))
    # gauntlet over the cuff
    loft(b, [ring(wr + V((0, dy, dz)), r, r * 1.05, 14) for dy, dz, r in ((0.035, -0.012, 0.058), (-0.035, 0.008, 0.064), (-0.06, 0.014, 0.05))],
         M['mitt'], cap0=True)
    # the mitt: thin across (x), broad front to back (z), a blunt rounded end
    hand = []
    for i in range(11):
        t = i / 10
        r = (1 - t ** 4) ** 0.25
        hand.append(ring(wr + V((0, -0.065 - t * 0.15, 0.016 + t * 0.012)), 0.026 * r + 0.002, 0.05 * r + 0.002, 14))
    loft(b, hand, M['mitt'], cap1=True)
    # thumb, on the front
    th = []
    for i in range(7):
        t = i / 6
        r = (1 - t ** 4) ** 0.25
        th.append(ring(wr + V((sx * -0.004, -0.085 - t * 0.07, 0.06 + t * 0.012)), 0.017 * r + 0.002, 0.019 * r + 0.002, 10))
    loft(b, th, M['mitt'], cap1=True)
    return b.finish(merge=False)
