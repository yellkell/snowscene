"""The hang glider, as its four parts (glider-model.ts: LeftWing, RightWing, ControlBar, Keel), built in
the game's pilot space (-Z forward, floor at y = 0; Blender: x, -z, y) so the runtime can drop each baked
part into its existing group (which is centred on the part's centroid).
"""
import bpy, math
from mathutils import Vector, Matrix
from . import core, snowmats as SM
from .nodes import NB

G = lambda x, y, z: Vector((x, -z, y))
NOSE = G(0, 2.25, -1.65)
TAIL = G(0, 2.32, 1.35)
TIP = (3.6, 2.55, 0.95)
APEX = G(0, 2.22, -0.25)
BAR_Y, BAR_Z, BAR_HALF = 1.12, -0.55, 0.62
# dyed sailcloth (linear): a deep signal orange, a saffron, an off-white that has seen weather
ORANGE, YELLOW, WHITE = (0.72, 0.1, 0.018), (0.8, 0.46, 0.025), (0.74, 0.73, 0.69)
_M = {}


def mats():
    if _M:
        return _M
    m = SM.new('sail')
    nb = NB(m)
    pos = nb.pos()
    x, y, z = nb.sep(pos)
    span = nb.math('DIVIDE', nb.math('ABSOLUTE', x), TIP[0])
    band = nb.math('FLOOR', nb.math('MULTIPLY', span, 6.0))
    col = nb.mix(nb.math('COMPARE', band, 2.0), ORANGE, WHITE)
    col = nb.mix(nb.math('COMPARE', band, 4.0), col, YELLOW)
    # Dacron that has flown: a little mottled, dyed panels not quite even
    mot = nb.noise(pos, 3.5, detail=6.0, rough=0.6)
    col = nb.mix(nb.mrange(mot, 0.3, 0.7, 0.0, 0.22), col, nb.mix(1.0, col, (0.8, 0.78, 0.74), blend='MULTIPLY'))
    # seams between the panels: a felled seam, two rows of stitching either side
    fr = nb.math('ABSOLUTE', nb.math('SUBTRACT', nb.math('FRACT', nb.math('MULTIPLY', span, 6.0)), 0.5))
    seam = nb.mrange(fr, 0.485, 0.5, 0.0, 1.0)
    stitch = nb.math('MULTIPLY', nb.mrange(fr, 0.47, 0.475, 0.0, 1.0), nb.mrange(fr, 0.48, 0.475, 0.0, 1.0))
    col = nb.mix(nb.math('MULTIPLY', seam, 0.35), col, nb.mix(1.0, col, (0.6, 0.6, 0.6), blend='MULTIPLY'))
    col = nb.mix(nb.math('MULTIPLY', stitch, 0.7), col, (0.12, 0.12, 0.13))
    # reinforcement at the tips (a doubled panel) and grime along the leading edge and the keel pocket
    tipdbl = nb.mrange(span, 0.88, 0.9, 0.0, 1.0)
    col = nb.mix(nb.math('MULTIPLY', tipdbl, 0.25), col, nb.mix(1.0, col, (0.7, 0.7, 0.7), blend='MULTIPLY'))
    grime = nb.math('MULTIPLY', nb.mrange(y, 0.4, 1.6, 0.0, 1.0), nb.mrange(nb.noise(pos, 9.0, detail=5.0), 0.35, 0.7, 0.2, 0.75))
    col = nb.mix(grime, col, nb.mix(1.0, col, (0.55, 0.52, 0.47), blend='MULTIPLY'))
    weave = nb.n('ShaderNodeTexWave', wave_type='BANDS', ins={'Vector': pos, 'Scale': 700.0}).outputs['Fac']
    p = nb.bsdf(col, rough=0.5, normal=nb.bump(weave, strength=0.08, dist=0.0003), out=False)
    tr = nb.n('ShaderNodeBsdfTranslucent', ins={'Color': col})
    mx = nb.n('ShaderNodeMixShader')
    nb.link(0.35, mx.inputs[0]); nb.link(p.outputs[0], mx.inputs[1]); nb.link(tr.outputs[0], mx.inputs[2])
    nb.link(mx.outputs[0], nb.out.inputs['Surface'])
    _M['sail'] = m
    m = SM.new('mylar')
    NB(m).bsdf((0.12, 0.12, 0.13), rough=0.25)
    _M['mylar'] = m
    def metal(name, col, rough):
        mm = SM.new(name)
        NB(mm).bsdf(col, rough=rough, metal=1.0)
        return mm
    _M['alu'] = metal('glider_alu', (0.72, 0.74, 0.77), 0.3)
    _M['black'] = metal('glider_black', (0.05, 0.05, 0.06), 0.35)
    _M['wire'] = metal('glider_wire', (0.8, 0.81, 0.83), 0.25)
    m = SM.new('glider_foam')
    NB(m).bsdf((0.03, 0.03, 0.035), rough=0.85)
    _M['foam'] = m
    m = SM.new('glider_nose')
    NB(m).bsdf((0.85, 0.18, 0.08), rough=0.35)
    _M['nose'] = m
    return _M


def wing(name, coll, side):
    M = mats()
    b = core.Builder(name, coll, smooth_angle=50)
    tip = G(TIP[0] * side, TIP[1], TIP[2])
    n = 36
    rows = []
    for i in range(n + 1):
        u = i / n
        row = []
        for j in range(i + 1):
            v = 0 if i == 0 else j / i
            p = NOSE.lerp(TAIL, u * (1 - v)) + (tip - NOSE) * (u * v)
            billow = math.sin(math.pi * v) * math.sin(math.pi * min(1, u * 1.1)) * 0.22
            # the trailing edge scallops up between the battens
            if i == n:
                pass
            p.z -= billow
            row.append(p)
        rows.append(row)
    # scallop the trailing edge (last row) between battens at v = 1/4, 1/2, 3/4
    last = rows[-1]
    for j, p in enumerate(last):
        v = j / (len(last) - 1)
        p.z += 0.05 * abs(math.sin(math.pi * 4 * v)) * math.sin(math.pi * v)
    vs = [[b.bm.verts.new(p) for p in row] for row in rows]
    for i in range(n):
        for j in range(i + 1):
            a, bb, d = vs[i][j], vs[i + 1][j], vs[i + 1][j + 1]
            tri = (a, bb, d) if side > 0 else (a, d, bb)
            b._face(tri, M['sail'], smooth=True)
            if j < i:
                e = vs[i][j + 1]
                tri = (a, d, e) if side > 0 else (a, e, d)
                b._face(tri, M['sail'], smooth=True)
    # leading edge tube in its mylar pocket
    b.cyl(NOSE, tip, 0.03, M['black'], sides=12)
    b.cyl(NOSE.lerp(tip, 0.02), tip, 0.042, M['mylar'], sides=12, caps=False)
    b.cyl(tip, tip + (tip - NOSE).normalized() * 0.06, 0.02, M['nose'], sides=10, r1=0.012)
    # batten pockets: chordwise lines on the billowed sail, at fixed span fractions
    for k in range(1, 8):
        v = k / 8
        pts = []
        for q in range(12):
            u = 0.12 + 0.88 * q / 11
            p = NOSE.lerp(TAIL, u * (1 - v)) + (tip - NOSE) * (u * v)
            p.z -= math.sin(math.pi * v) * math.sin(math.pi * min(1, u * 1.1)) * 0.22 - 0.004
            pts.append(p)
        b.tube(pts, 0.0055, M['mylar'], sides=4)
    return b.finish(merge=False)


def keel(name, coll):
    M = mats()
    b = core.Builder(name, coll, smooth_angle=50)
    b.cyl(NOSE, TAIL, 0.035, M['alu'], sides=14)
    king_top, king_base = G(0, 2.85, 0.05), G(0, 2.3, 0.05)
    b.cyl(king_base, king_top, 0.02, M['alu'], sides=10)
    b.lathe([(0.0, -0.08), (0.05, -0.05), (0.06, 0.0), (0.05, 0.03), (0.0, 0.04)], NOSE, (NOSE - TAIL).normalized(), M['nose'], seg=16)
    b.cyl(G(-0.35, 2.31, 0.15), G(0.35, 2.31, 0.15), 0.028, M['alu'], sides=12)
    for end in (NOSE, TAIL, G(-0.35, 2.31, 0.15), G(0.35, 2.31, 0.15)):
        b.cyl(king_top, end, 0.0035, M['wire'], sides=5)
    # hang point strap
    b.cyl(G(0, 2.27, -0.1), G(0, 1.95, -0.1), 0.012, M['foam'], sides=6)
    return b.finish(merge=False)


def control_bar(name, coll):
    M = mats()
    b = core.Builder(name, coll, smooth_angle=45)
    left, right = G(-BAR_HALF, BAR_Y, BAR_Z), G(BAR_HALF, BAR_Y, BAR_Z)
    # streamlined downtubes: an aerofoil section swept from the apex to the corners
    prof = [(0.022 * math.cos(a), 0.011 * math.sin(a) + (0.004 if math.sin(a) > 0 else 0)) for a in (k / 10 * math.tau for k in range(10))]
    for c in (left, right):
        b.sweep([APEX, c], prof, M['alu'], closed=False)
    # the base bar: bare aluminium (only the grips are black foam), so it reads as a glider part in
    # front of you, not as a black bar across the view
    b.cyl(left, right, 0.024, M['alu'], sides=14)
    for s in (-1, 1):
        b.cyl(G(s * 0.45, BAR_Y, BAR_Z), G(s * 0.12, BAR_Y, BAR_Z), 0.03, M['foam'], sides=14)
        # corner fittings and the side wires up to the leading edges
        c = G(s * BAR_HALF, BAR_Y, BAR_Z)
        b.lathe([(0.0, -0.03), (0.032, -0.02), (0.032, 0.02), (0.0, 0.03)], c, Vector((1, 0, 0)), M['black'], seg=12)
        tip = G(s * TIP[0] * 0.6, 2.4, 0.3)
        b.cyl(c, tip, 0.003, M['wire'], sides=5)
    return b.finish(merge=False)
