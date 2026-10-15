"""Gear you hold: the trekking poles (and, later, the glider parts and the torch).

Held things move, so they are not light-baked: they get albedo and an AO / metal / roughness map baked
from their Cycles materials, and the runtime lights them with dynamicLight plus a sky-reflection specular.

The pole is built in the game's pole frame: grip at the origin, the shaft running to the tip at
POLE_TIP_DISTANCE (1.22 m) along local +Z; in Blender that is -Y (glTF export turns Blender -Y into +Z).
"""
import bpy, math
from mathutils import Vector, Matrix
from . import core, snowmats as SM
from .nodes import NB

_M = {}


def mats():
    if _M:
        return _M
    def anod(name, col, rough=0.32, metal=1.0):
        m = SM.new(name)
        nb = NB(m)
        brushed = nb.noise(nb.comb(*nb.sep(nb.vmath('MULTIPLY', nb.pos(), (900.0, 4.0, 900.0)))), 1.0, detail=3.0)
        nb.bsdf(col, rough=nb.mrange(brushed, 0.3, 0.7, rough - 0.06, rough + 0.06), metal=metal)
        return m
    _M['upper'] = anod('pole_upper', (0.05, 0.11, 0.2), 0.3)
    _M['mid'] = anod('pole_mid', (0.42, 0.44, 0.47), 0.28)
    _M['lower'] = anod('pole_lower', (0.55, 0.57, 0.6), 0.25)
    m = SM.new('pole_plastic')
    nb = NB(m)
    nb.bsdf((0.025, 0.025, 0.028), rough=0.45, normal=nb.bump(nb.noise(nb.pos(), 400.0, detail=2.0), strength=0.1, dist=0.0005))
    _M['plastic'] = m
    m = SM.new('pole_cork')
    nb = NB(m)
    pos = nb.pos()
    grain = nb.n('ShaderNodeTexVoronoi', ins={'Vector': pos, 'Scale': 900.0}).outputs['Distance']
    speck = nb.noise(pos, 300.0, detail=4.0)
    col = nb.mix(nb.mrange(speck, 0.35, 0.7, 0, 1), (0.36, 0.22, 0.12), (0.62, 0.45, 0.28))
    col = nb.mix(nb.mrange(grain, 0.0, 0.2, 0.5, 0.0), col, (0.2, 0.12, 0.07))
    nb.bsdf(col, rough=0.8, normal=nb.bump(grain, strength=0.5, dist=0.001))
    _M['cork'] = m
    m = SM.new('pole_foam')
    nb = NB(m)
    nb.bsdf((0.03, 0.03, 0.035), rough=0.85, normal=nb.bump(nb.noise(nb.pos(), 1500.0, detail=2.0), strength=0.3, dist=0.0004))
    _M['foam'] = m
    m = SM.new('pole_strap')
    nb = NB(m)
    weave = nb.n('ShaderNodeTexWave', wave_type='BANDS', ins={'Vector': nb.pos(), 'Scale': 2200.0}).outputs['Fac']
    nb.bsdf(nb.mix(nb.math('MULTIPLY', weave, 0.3), (0.06, 0.06, 0.07), (0.6, 0.12, 0.05)), rough=0.7)
    _M['strap'] = m
    m = SM.new('pole_carbide')
    nb = NB(m)
    nb.bsdf((0.35, 0.35, 0.36), rough=0.35, metal=1.0)
    _M['carbide'] = m
    m = SM.new('pole_logo')
    nb = NB(m)
    nb.bsdf((0.85, 0.32, 0.06), rough=0.35)
    _M['accent'] = m
    return _M


def build_pole(name, coll):
    M = mats()
    b = core.Builder(name, coll, smooth_angle=50)
    # Blender: the pole runs down -Y from the grip (origin) to the tip
    P = lambda z: Vector((0, -z, 0))
    # top knob and the grip: cork upper, EVA extension below
    b.lathe([(0.0, 0.0), (0.016, 0.004), (0.02, 0.014), (0.019, 0.03)], P(-0.12), Vector((0, -1, 0)), M['plastic'], seg=20, cap0=False)
    prof = [(0.019, 0.0), (0.0205, 0.02), (0.022, 0.06), (0.0215, 0.1), (0.0195, 0.13), (0.0185, 0.15), (0.019, 0.16)]
    b.lathe(prof, P(-0.09), Vector((0, -1, 0)), M['cork'], seg=24)
    b.lathe([(0.017, 0.0), (0.0175, 0.01), (0.0175, 0.12), (0.016, 0.13)], P(0.07), Vector((0, -1, 0)), M['foam'], seg=20)
    # shaft: three telescoping sections, each with its flick-lock clamp
    sections = [(0.2, 0.62, 0.0095, M['upper']), (0.6, 0.98, 0.0083, M['mid']), (0.96, 1.17, 0.0072, M['lower'])]
    for z0, z1, r, mat in sections:
        b.cyl(P(z0), P(z1), r, mat, sides=16, caps=False)
    for zc, r in ((0.6, 0.0125), (0.96, 0.0112)):
        b.cyl(P(zc - 0.012), P(zc + 0.018), r, M['plastic'], sides=16)
        # the lever
        b.cbox(P(zc + 0.003) + Vector((r + 0.003, 0, 0)), (0.006, 0.04, 0.012), M['plastic'], bev=0.002)
        b.cyl(P(zc), P(zc) + Vector((r + 0.007, 0, 0)), 0.0025, M['carbide'], sides=6)
    # a little branding on the upper section
    b.cyl(P(0.3), P(0.34), 0.0097, M['accent'], sides=16, caps=False)
    # powder basket: a snowflake-shaped dish
    base = P(1.08)
    b.lathe([(0.009, -0.006), (0.012, -0.004), (0.012, 0.004)], base, Vector((0, -1, 0)), M['plastic'], seg=16)
    for k in range(6):
        a = k / 6 * math.tau
        d = Vector((math.cos(a), 0, math.sin(a)))
        b.cbox(base + d * 0.03, (0.04, 0.003, 0.016), M['plastic'], bev=0.0015,
               R_=Matrix.Rotation(-a, 3, 'Y'))
    b.lathe([(0.044, -0.001), (0.046, 0.0015), (0.043, 0.004), (0.041, 0.002)], base, Vector((0, -1, 0)), M['plastic'], seg=36)
    # ferrule and carbide tip
    b.cyl(P(1.17), P(1.205), 0.0068, M['plastic'], sides=12, r1=0.005)
    b.cyl(P(1.205), P(1.22), 0.0035, M['carbide'], sides=10, r1=0.001)
    # wrist strap: a loop of webbing from the top of the grip
    loop = []
    for k in range(25):
        t = k / 24 * math.tau
        loop.append(P(-0.06) + Vector((0.0, 0.05 + 0.05 * math.cos(t), 0)) + Vector((-0.045 * math.sin(t) - 0.02, 0, 0.03 * math.sin(2 * t))))
    b.sweep(loop, [(-0.0012, -0.011), (0.0012, -0.011), (0.0012, 0.011), (-0.0012, 0.011)], M['strap'], closed=True)
    return b.finish(merge=False)


def build_bench(name, coll, seed=12):
    """The kit's bench on the beacon deck (world-builders.ts buildWorkbench, bench-local game space):
    plank crates for the wings and the bar, a timber stand that cradles the keel."""
    import random
    from . import cabin as CB
    R = random.Random(seed)
    HM = CB.mats()
    b = core.Builder(name, coll, smooth_angle=35)
    G = lambda x, y, z: Vector((x, -z, y))

    def crate(x, z, size):
        c = G(x, 0, z)
        t, gap = 0.022, 0.012
        n = max(3, int(size / 0.13))
        w = (size - gap * (n - 1)) / n
        for k in range(n):                       # side boards, horizontal
            zz = 0.03 + k * (w + gap) + w / 2
            for (ox, oy, sx, sy) in ((0, size / 2, size, t), (0, -size / 2, size, t), (size / 2, 0, t, size), (-size / 2, 0, t, size)):
                b.element()
                b.cbox(c + Vector((ox, oy, zz)), (sx + R.uniform(-0.004, 0.004), sy, w), HM['timber'], bev=0.003)
        for (ox, oy) in ((1, 1), (1, -1), (-1, 1), (-1, -1)):   # corner posts and iron angles
            b.element()
            b.cbox(c + Vector((ox * (size / 2 - 0.02), oy * (size / 2 - 0.02), size / 2)), (0.045, 0.045, size), HM['timber'], bev=0.004)
            b.cbox(c + Vector((ox * (size / 2 + 0.012), oy * (size / 2 + 0.012), size - 0.05)), (0.006, 0.06, 0.08), HM['iron'], bev=0.001)
        b.element()
        b.cbox(c + Vector((0, 0, 0.012)), (size, size, 0.024), HM['timber'], bev=0.003)
        for ox in (-1, 1):                        # rope handles
            pts = [c + Vector((ox * (size / 2 + 0.03), -0.09 + 0.18 * q / 8, size * 0.62 - 0.05 * math.sin(math.pi * q / 8))) for q in range(9)]
            b.tube(pts, 0.008, mats()['strap'], sides=6)
        b.element()
        b.cbox(c + Vector((0, 0, size + 0.03)), (size * 0.92, size * 0.92, 0.05), HM['snow'], bev=0.02, seg=2)

    crate(-1.6, 1.05, 0.66)
    crate(1.6, 1.05, 0.66)
    crate(-0.85, 0.75, 0.42)
    # keel stand: cross feet, a post, a padded cradle
    for rot in (0, math.pi / 2):
        b.element()
        b.cbox(G(0, 0.04, 0), (0.62, 0.08, 0.09), HM['timber'], bev=0.006, R_=Matrix.Rotation(rot, 3, 'Z'))
    b.element()
    b.cbox(G(0, 0.6, 0), (0.08, 0.08, 1.12), HM['timber'], bev=0.008)
    for s in (-1, 1):
        b.element()
        b.cbox(G(s * 0.07, 1.2, 0), (0.03, 0.06, 0.12), HM['timber'], bev=0.004,
               R_=Matrix.Rotation(s * 0.35, 3, 'Y'))
    b.element()
    b.cbox(G(0, 1.17, 0), (0.2, 0.09, 0.04), mats()['foam'], bev=0.01)
    return b.finish(merge=False)


def _pack_mats():
    if 'pack_oak' in _M:
        return _M
    def wood(name, tid, hue, sat, val, coat, scale):
        m = SM.new(name)
        nb = NB(m)
        ts = SM.texset(tid)
        d, r, a, n, h = SM.scan(nb, ts, SM.metric_uv(nb, ts['size'], scale=scale, uvname='UVMap'), 0.6, uvname='UVMap')
        nb.bsdf(nb.hsv(d, hue, sat, val), rough=0.45, normal=n, coat=coat, coat_rough=0.15)
        _M[name] = m
    wood('pack_oak', 'worn_planks', 0.5, 0.9, 0.75, 0.35, 0.25)
    wood('pack_birch', 'wood_planks_grey', 0.53, 0.5, 1.5, 0.0, 0.2)
    m = SM.new('pack_brass')
    nb = NB(m)
    nb.bsdf(nb.mix(nb.mrange(nb.noise(nb.pos(), 300.0, detail=4.0), 0.4, 0.7, 0, 0.6), (0.85, 0.64, 0.3), (0.45, 0.33, 0.15)), rough=0.3, metal=1.0)
    _M['pack_brass'] = m
    m = SM.new('pack_leather')
    nb = NB(m)
    g = nb.noise(nb.pos(), 900.0, detail=5.0)
    nb.bsdf(nb.mix(nb.mrange(g, 0.3, 0.7, 0, 1), (0.22, 0.11, 0.05), (0.36, 0.2, 0.11)), rough=0.55, normal=nb.bump(g, strength=0.25, dist=0.0003))
    _M['pack_leather'] = m
    return _M


def build_pack(name, coll):
    """The pack tray (pack-tray.ts buildPackTray, tray-local game space): a varnished oak box with a 3 x 3
    grid of slots on a pale birch slat floor, brass corners, a leather strap and buckle, and the lid standing
    open on brass hinges."""
    M = _pack_mats()
    b = core.Builder(name, coll, smooth_angle=35)
    G = lambda x, y, z: Vector((x, -z, y))
    CELL, COLS, ROWS, RIM, DEPTH = 0.11, 3, 3, 0.035, 0.045
    w, h = COLS * CELL, ROWS * CELL
    LID_OPEN, LID_H = math.radians(105), 0.3
    # floor slats
    for k in range(7):
        x = -w / 2 + (k + 0.5) * w / 7
        b.element()
        b.cbox(G(x, -0.005, 0), (w / 7 - 0.002, h, 0.01), M['pack_birch'], bev=0.0015)
    # walls with finger joints at the corners
    for (x, z, sx, sz) in ((0, -h / 2 - RIM / 2, w + RIM * 2, RIM), (0, h / 2 + RIM / 2, w + RIM * 2, RIM),
                           (-w / 2 - RIM / 2, 0, RIM, h), (w / 2 + RIM / 2, 0, RIM, h)):
        b.element()
        b.cbox(G(x, DEPTH / 2 - 0.01, z), (sx, sz, DEPTH), M['pack_oak'], bev=0.003, seg=2)
    for c in range(1, COLS):
        b.element()
        b.cbox(G(-w / 2 + c * CELL, 0.005, 0), (0.005, h, 0.016), M['pack_oak'], bev=0.0015)
    for r in range(1, ROWS):
        b.element()
        b.cbox(G(0, 0.005, -h / 2 + r * CELL), (w, 0.005, 0.016), M['pack_oak'], bev=0.0015)
    b.element()
    b.cbox(G(0, -0.02, 0), (w + RIM * 2, h + RIM * 2, 0.02), M['pack_oak'], bev=0.003)
    for sx in (-1, 1):
        for sz in (-1, 1):
            b.element()
            b.cbox(G(sx * (w / 2 + RIM / 2), DEPTH / 2 - 0.008, sz * (h / 2 + RIM / 2)), (RIM + 0.008, RIM + 0.008, DEPTH + 0.01), M['pack_brass'], bev=0.003)
    # strap and buckle on the front
    b.element()
    b.cbox(G(0, DEPTH / 2 - 0.01, h / 2 + RIM + 0.003), (0.045, 0.006, DEPTH + 0.004), M['pack_leather'], bev=0.001)
    b.element()
    b.cbox(G(0, DEPTH / 2 - 0.005, h / 2 + RIM + 0.007), (0.055, 0.004, 0.026), M['pack_brass'], bev=0.0015)
    # the lid: a framed panel standing open, hinged on the far rim
    hinge = G(0, DEPTH - 0.01, -h / 2 - RIM)
    rot = Matrix.Rotation(-(LID_OPEN - math.pi / 2), 3, 'X')
    def lid(bw, bh, bd, x, y, z, mat):
        # (x, y, z) in the lid frame: y up its face from the hinge, z out of its face (game axes)
        local = Vector((x, -z, y))
        p = hinge + rot @ local
        b.element()
        b.cbox(p, (bw, bd, bh), mat, bev=0.002, R_=rot)
    lid(w + RIM * 2, LID_H, 0.012, 0, LID_H / 2, -0.006, M['pack_oak'])
    lid(w + RIM * 2, 0.025, 0.02, 0, LID_H - 0.0125, 0.006, M['pack_oak'])
    lid(w + RIM * 2, 0.025, 0.02, 0, 0.0125, 0.006, M['pack_oak'])
    lid(0.025, LID_H, 0.02, -w / 2 - RIM + 0.0125, LID_H / 2, 0.006, M['pack_oak'])
    lid(0.025, LID_H, 0.02, w / 2 + RIM - 0.0125, LID_H / 2, 0.006, M['pack_oak'])
    for sx in (-1, 1):
        b.cyl(hinge + Vector((sx * w * 0.32 - 0.025, 0, 0)), hinge + Vector((sx * w * 0.32 + 0.025, 0, 0)), 0.008, M['pack_brass'], sides=10)
    return b.finish(merge=False)
