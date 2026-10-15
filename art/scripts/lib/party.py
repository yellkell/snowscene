"""The party on the frozen lake, where the glide ends: the bonfire's log stack and stone ring, log benches,
dome tents round the edge (the approach side open), festoon lights swagged between timber poles — the
layout of campfire.ts (buildLogStack, buildCampEdge, buildFestoonLights) — and the lake's ice itself.

Built in party space (origin at FIRE_POS, Blender Z up, game +Z = Blender -Y); the lake ice in world space.
"""
import bpy, bmesh, math, random
import numpy as np
from mathutils import Vector, Matrix
from . import core, snowmats as SM, cabin as CB
from .nodes import NB

PARTY_RADIUS = 16.0
FABRICS = [(0.85, 0.27, 0.17), (0.91, 0.69, 0.23), (0.18, 0.44, 0.71), (0.25, 0.6, 0.35), (0.71, 0.25, 0.56)]
BULBS = [(1, 0.75, 0.3), (1, 0.3, 0.25), (0.35, 0.9, 0.45), (0.35, 0.6, 1), (1, 0.45, 0.85)]
_M = {}


def mats():
    if _M:
        return _M
    m = SM.new('log_bark')
    nb = NB(m)
    ts = SM.texset('pine_bark')
    d, r, a, n, h = SM.scan(nb, ts, SM.metric_uv(nb, ts['size'], scale=0.5, uvname='UVMap'), 1.2, uvname='UVMap')
    nb.bsdf(nb.hsv(d, 0.5, 0.9, 0.8), rough=0.85, normal=n)
    _M['bark'] = m
    m = SM.new('log_char')
    nb = NB(m)
    g = nb.noise(nb.pos(), 30.0, detail=6.0)
    nb.bsdf(nb.mix(nb.mrange(g, 0.4, 0.7, 0, 1), (0.015, 0.012, 0.01), (0.06, 0.04, 0.03)), rough=0.9,
            normal=nb.bump(nb.n('ShaderNodeTexVoronoi', ins={'Vector': nb.pos(), 'Scale': 25.0}).outputs['Distance'], strength=0.6, dist=0.01))
    _M['char'] = m
    for i, c in enumerate(FABRICS):
        m = SM.new(f'tent_{i}')
        nb = NB(m)
        pos = nb.pos()
        # ripstop: a fine grid, slightly sheeny, a little translucent
        grid = nb.n('ShaderNodeTexWave', wave_type='BANDS', ins={'Vector': pos, 'Scale': 220.0, 'Distortion': 0.0}).outputs['Fac']
        col = nb.mix(nb.math('MULTIPLY', grid, 0.06), c, (c[0] * 0.7, c[1] * 0.7, c[2] * 0.7))
        p = nb.bsdf(col, rough=0.45, out=False)
        p.inputs['Subsurface Weight'].default_value = 0.0
        tr = nb.n('ShaderNodeBsdfTranslucent', ins={'Color': c})
        mx = nb.n('ShaderNodeMixShader')
        nb.link(0.2, mx.inputs[0]); nb.link(p.outputs[0], mx.inputs[1]); nb.link(tr.outputs[0], mx.inputs[2])
        _, _, nz = nb.sep(nb.n('ShaderNodeNewGeometry').outputs['Normal'])
        sm_ = SM.snow_cover_mask(nb, nz, 0.75, 0.1, 8.0, -0.1)
        mx2 = nb.n('ShaderNodeMixShader')
        nb.link(sm_, mx2.inputs[0]); nb.link(mx.outputs[0], mx2.inputs[1]); nb.link(SM.snow_shader(nb), mx2.inputs[2])
        nb.link(mx2.outputs[0], nb.out.inputs['Surface'])
        _M[f'tent_{i}'] = m
    m = SM.new('guyline')
    NB(m).bsdf((0.75, 0.72, 0.6), rough=0.6)
    _M['guy'] = m
    m = SM.new('alu')
    NB(m).bsdf((0.6, 0.6, 0.62), rough=0.3, metal=1.0)
    _M['alu'] = m
    for i, c in enumerate(BULBS):
        m = SM.new(f'bulb_{i}')
        nb = NB(m)
        nb.link(nb.n('ShaderNodeEmission', ins={'Color': c, 'Strength': 30.0}).outputs[0], nb.out.inputs['Surface'])
        _M[f'bulb_{i}'] = m
    m = SM.new('wire')
    NB(m).bsdf((0.02, 0.02, 0.02), rough=0.4)
    _M['wire'] = m
    return _M


def build(coll, seed=9, approach_yaw=-math.pi / 2):
    """Everything round the fire, in party space (Blender: game x, -game z, up)."""
    R = random.Random(seed)
    M = mats()
    HM = CB.mats()
    b = core.Builder('PARTY', coll, smooth_angle=40)
    V = Vector
    g2b = lambda x, y, z: V((x, -z, y))
    # --- the bonfire: a teepee of split logs over a charred bed, a ring of granite round it
    for i in range(10):
        a = i / 10 * math.tau + R.uniform(-0.1, 0.1)
        base = V((math.cos(a) * 1.15, math.sin(a) * 1.15, 0.0))
        top = V((math.cos(a) * 0.15, math.sin(a) * 0.15, 3.2 + R.uniform(-0.2, 0.3)))
        r = R.uniform(0.17, 0.25)
        b.element()
        b.cyl(base, top, r, M['bark'] if i % 3 else M['char'], sides=9, r1=r * 0.8)
        b.cyl(top, top + (top - base).normalized() * 0.01, r * 0.8, HM['endgrain'], sides=9)
    for i in range(30):
        a = i / 30 * math.tau
        b.element()
        b.cbox(V((math.cos(a) * 3.5, math.sin(a) * 3.5, 0.08)), (R.uniform(0.35, 0.55), R.uniform(0.3, 0.45), R.uniform(0.22, 0.35)),
               HM['stone'], bev=0.08, seg=2, R_=Matrix.Rotation(a + R.uniform(-0.3, 0.3), 3, 'Z'))
    # charred, melted ground inside the ring
    b.lathe([(0.0, 0.0), (3.3, 0.0)], V((0, 0, 0.015)), V((0, 0, 1)), M['char'], seg=40)
    # --- log benches on stumps in a ring at 10 m
    for i in range(8):
        a = i / 8 * math.tau + 0.2
        c = V((math.cos(a) * 10, math.sin(a) * 10, 0))
        t = V((-math.sin(a), math.cos(a), 0))
        for s in (-1, 1):
            b.element()
            b.cyl(c + t * s * 1.0 - V((0, 0, 0.1)), c + t * s * 1.0 + V((0, 0, 0.32)), 0.17, M['bark'], sides=10)
        b.element()
        b.cyl(c - t * 1.4 + V((0, 0, 0.45)), c + t * 1.4 + V((0, 0, 0.45)), 0.21, M['bark'], sides=12)
        b.element()
        b.cbox(c + V((0, 0, 0.6)), (0.32, 2.7, 0.06), HM['timber'], bev=0.01, R_=Matrix.Rotation(a, 3, 'Z'))
    # --- dome tents round the edge, the approach side open
    for i in range(5):
        a_game = approach_yaw + 0.9 + (i / 4) * (math.pi * 2 - 1.8)
        # game angle measured in xz; to Blender XY: (cos a, -sin a)
        c = V((math.cos(a_game) * PARTY_RADIUS, -math.sin(a_game) * PARTY_RADIUS, 0))
        facing = -c.normalized()
        _dome_tent(b, M, c, facing, M[f'tent_{i}'], R)
    # --- festoon lights: timber poles, sagging wires, glass bulbs
    poles, radius, height, per = 10, 12.5, 4.2, 14
    pts = []
    for i in range(poles):
        a = i / poles * math.tau
        p = V((math.cos(a) * radius, math.sin(a) * radius, 0))
        b.element()
        b.cyl(p - V((0, 0, 0.4)), p + V((0, 0, height)), 0.07, HM['timber'], sides=8, r1=0.06)
        pts.append(p + V((0, 0, height - 0.1)))
    for i in range(poles):
        a, c = pts[i], pts[(i + 1) % poles]
        wire = []
        for j in range(per + 1):
            t = j / per
            wire.append(a.lerp(c, t) - V((0, 0, math.sin(math.pi * t) * 0.9)))
        b.tube(wire, 0.008, M['wire'], sides=4)
        for j in range(per):
            q = wire[j] - V((0, 0, 0.12))
            b.cyl(wire[j], q, 0.004, M['wire'], sides=4)
            b.lathe([(0.0, -0.1), (0.05, -0.06), (0.055, -0.02), (0.035, 0.02), (0.0, 0.03)], q, V((0, 0, 1)),
                    M[f'bulb_{(i * 3 + j) % 5}'], seg=8)
    return b.finish(merge=False)


def _dome_tent(b, M, c, facing, fabric, R):
    """A two-pole dome tent, as pitched: a rounded-square floor, steep walls and a flat crown (the poles
    are bent into tall arcs, not a hemisphere), the fly pulled taut and drawn in between the pole sleeves,
    a pointed vestibule staked out in front with its door zipped half open, guys, pegs, and snow banked
    round the skirt."""
    up = Vector((0, 0, 1))
    f = facing.normalized()
    s = up.cross(f).normalized()
    W, L, H = 1.45, 2.1, 1.12
    SQ = 3.2          # plan superellipse: a rounded square
    PR = 2.6          # profile exponent: steep walls, flat crown
    VEST = 0.85       # vestibule reach beyond the inner wall
    n_u, n_v = 40, 14
    HM = CB.mats()
    se = lambda a, n: math.copysign(abs(a) ** (2 / n), a)

    def shell(az, v, out=1.0):
        """Point on the fly: az round the plan, v up the profile (0 base, 1 crown)."""
        ca, sa = math.cos(az), math.sin(az)
        rr = (1 - v ** PR) ** (1 / PR)              # superellipse profile radius
        z = v * H
        # the fabric draws in between the pole lines (which run on the diagonals), most at mid-height
        pull = 1 - 0.085 * (1 - abs(math.sin(2 * az))) * math.sin(math.pi * min(1, v * 1.25))
        x = se(ca, SQ) * L / 2 * rr * pull * out
        y = se(sa, SQ) * W / 2 * rr * pull * out
        # the vestibule: a wedge pulled forward to a staked point, its ridge falling from the front pole
        if ca > 0:
            wedge = max(0.0, 1 - (y / (W / 2 * rr + 1e-6)) ** 2) ** 1.4 * ca ** 3
            x += VEST * wedge * max(0.0, 1 - v / 0.82) ** 1.15
        return c + f * x + s * y + up * (z - 0.04)

    rows = [[b.bm.verts.new(shell(i / n_u * math.tau, j / n_v)) for i in range(n_u)] for j in range(n_v)]
    crown = b.bm.verts.new(c + up * (H - 0.04))
    for j in range(n_v - 1):
        for i in range(n_u):
            i2 = (i + 1) % n_u
            b._face((rows[j][i], rows[j][i2], rows[j + 1][i2], rows[j + 1][i]), fabric, smooth=True)
    for i in range(n_u):
        b._face((rows[-1][i], rows[-1][(i + 1) % n_u], crown), fabric, smooth=True)
    # pole sleeves: two crossed arches on the diagonals, a hair proud of the fly
    for az0 in (math.pi / 4, 3 * math.pi / 4):
        arc = []
        for k in range(25):
            t = k / 24
            az = az0 if t < 0.5 else az0 + math.pi
            v = 1 - abs(1 - 2 * t)
            p = shell(az, min(v, 0.995), 1.012)
            arc.append(p)
        b.tube(arc, 0.011, fabric, sides=6)
    # the door: a zipped arch on the vestibule
    door = [shell(math.atan2(math.sin(t) * 0.42, 1.0), 0.04 + 0.62 * math.cos(t) ** 0.7, 1.004) for t in
            (k / 12 * math.pi - math.pi / 2 for k in range(13))]
    b.tube(door, 0.012, M['wire'], sides=4)
    # guys from the sleeves' mid-height out to pegs, and the vestibule's own stake
    for az in (math.pi / 4, 3 * math.pi / 4, 5 * math.pi / 4, 7 * math.pi / 4):
        top = shell(az, 0.62, 1.01)
        peg = c + f * math.cos(az) * L * 1.15 + s * math.sin(az) * W * 1.25
        b.tube([top, peg + up * 0.03], 0.0025, M['guy'], sides=3)
        b.cyl(peg - up * 0.12, peg + up * 0.05, 0.01, M['alu'], sides=5)
    tip = shell(0.0, 0.0)
    b.cyl(tip + f * 0.12 - up * 0.12, tip + f * 0.12 + up * 0.05, 0.01, M['alu'], sides=5)
    b.tube([tip, tip + f * 0.12 + up * 0.03], 0.003, M['guy'], sides=3)
    # snow banked against the skirt (dug out at the door)
    ring = []
    for i in range(n_u + 1):
        az = i / n_u * math.tau
        door_gap = 1 - 0.85 * max(0.0, math.cos(az)) ** 6
        h = (0.1 + 0.05 * R.random()) * door_gap
        ring.append((az, h))
    for i in range(n_u):
        (a0, h0), (a1, h1) = ring[i], ring[i + 1]
        in0, in1 = shell(a0, 0.0, 0.99), shell(a1, 0.0, 0.99)
        out0, out1 = shell(a0, 0.0, 1.0) + (shell(a0, 0.0) - c).normalized() * 0.35, shell(a1, 0.0, 1.0) + (shell(a1, 0.0) - c).normalized() * 0.35
        mid0 = in0.lerp(out0, 0.3) + up * h0
        mid1 = in1.lerp(out1, 0.3) + up * h1
        vs = [b.bm.verts.new(p) for p in (in0 + up * h0 * 1.3, mid0, out0 - up * 0.03, in1 + up * h1 * 1.3, mid1, out1 - up * 0.03)]
        b._face((vs[0], vs[1], vs[4], vs[3]), HM['snow'], smooth=True)
        b._face((vs[1], vs[2], vs[5], vs[4]), HM['snow'], smooth=True)


def lake_ice(coll, center, radii, y, seed=3):
    """The frozen lake: clear black ice scoured clean by the wind in sweeps, cracked, bubbles frozen in,
    drifted snow over the rest. An ellipse at the game's LAKE_Y (0.88 x the lake radii, like buildLake)."""
    me = bpy.data.meshes.new('lake_ice')
    bm = bmesh.new()
    rx, rz = radii[0] * 0.88, radii[1] * 0.88
    rings, segs = 24, 96
    verts = [[bm.verts.new((center[0], -center[1], y))]]
    for j in range(1, rings + 1):
        t = j / rings
        verts.append([bm.verts.new((center[0] + math.cos(a) * rx * t, -(center[1] + math.sin(a) * rz * t), y))
                      for a in (i / segs * math.tau for i in range(segs))])
    for i in range(segs):
        bm.faces.new((verts[0][0], verts[1][(i + 1) % segs], verts[1][i]))
    for j in range(1, rings):
        for i in range(segs):
            i2 = (i + 1) % segs
            bm.faces.new((verts[j][i], verts[j][i2], verts[j + 1][i2], verts[j + 1][i]))
    bm.normal_update()
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        if p.normal.z < 0:
            pass
    me.flip_normals() if me.polygons[5].normal.z < 0 else None
    uv = me.uv_layers.new(name='WorldUV')
    for l in me.loops:
        v = me.vertices[l.vertex_index].co
        uv.data[l.index].uv = (v.x, v.y)
    m = SM.new('lake_ice')
    nb = NB(m)
    pos = nb.pos()
    # where the wind has swept it clean: long sweeps across the lake
    x, yy, _ = nb.sep(pos)
    sweep = nb.noise(nb.comb(nb.math('MULTIPLY', x, 0.04), nb.math('MULTIPLY', yy, 0.012), 0.0), 1.0, detail=5.0, rough=0.6)
    clean = nb.mrange(sweep, 0.5, 0.62, 0.0, 1.0)
    # black ice: deep dark with a glossy skin, white cracks and trapped bubbles
    cracks = nb.n('ShaderNodeTexVoronoi', feature='DISTANCE_TO_EDGE', ins={'Vector': pos, 'Scale': 0.35}).outputs['Distance']
    crack = nb.mrange(cracks, 0.0, 0.015, 1.0, 0.0)
    bub = nb.n('ShaderNodeTexVoronoi', ins={'Vector': nb.vmath('MULTIPLY', pos, (1.0, 1.0, 1.0)), 'Scale': 22.0}).outputs['Distance']
    bubbles = nb.math('MULTIPLY', nb.mrange(bub, 0.08, 0.02, 0.0, 0.6), nb.mrange(nb.noise(pos, 0.3, detail=2.0), 0.5, 0.7, 0.0, 1.0))
    icecol = nb.mix(nb.math('MAXIMUM', crack, bubbles), (0.012, 0.02, 0.028), (0.75, 0.82, 0.88))
    ice = nb.bsdf(icecol, rough=nb.mixf(crack, 0.03, 0.4), spec=0.5, out=False)
    snow = SM.snow_shader(nb)
    mx = nb.n('ShaderNodeMixShader')
    nb.link(clean, mx.inputs[0]); nb.link(snow, mx.inputs[1]); nb.link(ice.outputs[0], mx.inputs[2])
    nb.link(mx.outputs[0], nb.out.inputs['Surface'])
    me.materials.append(m)
    ob = bpy.data.objects.new('LAKE_ICE', me)
    coll.objects.link(ob)
    return ob
