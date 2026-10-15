"""An alpine hut (Blockbau): squared larch timbers stacked with dovetailed corners on a granite plinth,
a steep shake roof under a thick slab of snow with icicles at the eaves, a stone chimney, a plank door
with iron straps and a lantern, four-pane windows glowing warm from inside, red shutters, a woodpile and
drifts banked against the walls.

Same footprint and openings as the game's cabin (world-builders.ts buildCabin): 4.2 x 3.2 m, door front-
left, windows front-right and on both ends, chimney at the back. Built in Blender local space with the
front toward -Y (game +Z), floor at z = 0.
"""
import bpy, math, random
from mathutils import Vector, Matrix
from . import core, snowmats as SM
from .nodes import NB

W, D = 4.2, 3.2
BASE = 0.35
COURSE = 0.17
COURSES = 14
WALL_TOP = BASE + COURSE * COURSES
PITCH = math.radians(33)
OVER_EAVE = 0.65
OVER_GABLE = 0.55
_M = {}


def mats():
    if _M:
        return _M
    # Sun-blackened larch: the scanned planks, darkened and warmed, end grain paler.
    m = SM.new('hut_timber')
    nb = NB(m)
    ts = SM.texset('weathered_planks')
    vec = SM.metric_uv(nb, ts['size'], scale=0.9)
    d, r, a, n, h = SM.scan(nb, ts, vec, 1.2)
    rnd = nb.attr('rand', 'GEOMETRY')
    col = nb.hsv(d, 0.5 + 0.03, 0.75, 0.5)
    col = nb.mix(nb.math('MULTIPLY', rnd, 0.5), col, nb.hsv(col, 0.48, 0.6, 1.25))
    col = nb.mix(0.5, col, nb.mix(1.0, col, a, blend='MULTIPLY'))
    p = nb.bsdf(col, rough=nb.math('ADD', nb.math('MULTIPLY', r, 0.5), 0.45), normal=n, out=False)
    _snow_over(nb, p.outputs[0], 0.7)
    _M['timber'] = m
    m = SM.new('hut_endgrain')
    nb = NB(m)
    pos = nb.pos()
    rings = nb.n('ShaderNodeTexWave', wave_type='RINGS', ins={'Vector': pos, 'Scale': 18.0, 'Distortion': 6.0, 'Detail': 3.0})
    # decades out in the weather: the cut ends greyed and darkened, a shade under the logs' faces (pale
    # fresh-cut ends read as gaps in the corner joints)
    col = nb.mix(nb.math('MULTIPLY', rings.outputs['Fac'], 0.5), (0.075, 0.062, 0.05), (0.13, 0.105, 0.08))
    nb.bsdf(col, rough=0.85, normal=nb.bump(rings.outputs['Fac'], strength=0.15, dist=0.004))
    _M['endgrain'] = m
    # Granite plinth and chimney.
    m = SM.new('hut_stone')
    nb = NB(m)
    d, r, n, h = SM.rock_box(nb, nb.vmath('SCALE', nb.pos(), s=1.6), tint_sat=0.3, tint_val=0.75)
    p = nb.bsdf(d, rough=r, normal=n, out=False)
    _snow_over(nb, p.outputs[0], 0.6)
    _M['stone'] = m
    # Shakes under the snow (seen at the eaves and gables).
    m = SM.new('hut_shake')
    nb = NB(m)
    ts = SM.texset('wooden_rough_planks')
    vec = SM.metric_uv(nb, ts['size'], scale=0.5)
    d, r, a, n, h = SM.scan(nb, ts, vec, 1.0)
    nb.bsdf(nb.hsv(d, 0.5, 0.5, 0.45), rough=0.9, normal=n)
    _M['shake'] = m
    # Snow on the roof and in drifts.
    m = SM.new('hut_snow')
    nb = NB(m)
    pos = nb.pos()
    hgt = nb.math('ADD', nb.noise(pos, 9.0, detail=6.0, rough=0.6), nb.math('MULTIPLY', nb.noise(pos, 45.0, detail=2.0), 0.3))
    nb.link(SM.snow_shader(nb, normal=nb.bump(hgt, strength=0.3, dist=0.01)), nb.out.inputs['Surface'])
    _M['snow'] = m
    # Forged iron: hinges, straps, lantern.
    m = SM.new('hut_iron')
    nb = NB(m)
    rust = nb.noise(nb.pos(), 30.0, detail=6.0)
    nb.bsdf(nb.mix(nb.mrange(rust, 0.45, 0.7, 0, 1), (0.05, 0.05, 0.055), (0.18, 0.08, 0.035)), rough=0.6, metal=0.85)
    _M['iron'] = m
    # Old red paint on the shutters, worn through to the wood at the edges.
    m = SM.new('hut_paint')
    nb = NB(m)
    ts = SM.texset('weathered_planks')
    vec = SM.metric_uv(nb, ts['size'], scale=0.6)
    d, r, a, n, h = SM.scan(nb, ts, vec, 1.0)
    worn = nb.mrange(nb.noise(nb.pos(), 14.0, detail=6.0, rough=0.7), 0.5, 0.62, 0.0, 1.0)
    col = nb.mix(worn, (0.38, 0.05, 0.04), nb.hsv(d, 0.5, 0.6, 0.5))
    nb.bsdf(col, rough=0.7, normal=n)
    _M['paint'] = m
    # Old window glass over a warm, lit room.
    m = SM.new('hut_glass')
    nb = NB(m)
    p = nb.bsdf((0.6, 0.62, 0.6), rough=0.05, out=False)
    em = nb.n('ShaderNodeEmission', ins={'Color': (1.0, 0.55, 0.22), 'Strength': 6.0})
    fres = nb.n('ShaderNodeFresnel', ins={'IOR': 1.5})
    mx = nb.n('ShaderNodeMixShader')
    nb.link(fres.outputs[0], mx.inputs[0]); nb.link(em.outputs[0], mx.inputs[1]); nb.link(p.outputs[0], mx.inputs[2])
    nb.link(mx.outputs[0], nb.out.inputs['Surface'])
    _M['glass'] = m
    m = SM.new('hut_lamp')
    nb = NB(m)
    nb.link(nb.n('ShaderNodeEmission', ins={'Color': (1.0, 0.6, 0.25), 'Strength': 40.0}).outputs[0], nb.out.inputs['Surface'])
    _M['lamp'] = m
    return _M


def _snow_over(nb, shader, threshold):
    _, _, nz = nb.sep(nb.n('ShaderNodeNewGeometry').outputs['Normal'])
    mask = SM.snow_cover_mask(nb, nz, threshold, 0.08, 6.0, -0.05)
    mx = nb.n('ShaderNodeMixShader')
    nb.link(mask, mx.inputs[0]); nb.link(shader, mx.inputs[1]); nb.link(SM.snow_shader(nb), mx.inputs[2])
    nb.link(mx.outputs[0], nb.out.inputs['Surface'])


def build(name, coll, seed=1):
    R = random.Random(seed)
    M = mats()
    b = core.Builder(name, coll, smooth_angle=40)
    V = Vector
    # ---- granite plinth: rough-dressed blocks round the footprint
    x = -W / 2 - 0.05
    while x < W / 2:
        w = R.uniform(0.35, 0.6)
        for y in (-D / 2, D / 2):
            b.element()
            b.cbox((min(x + w / 2, W / 2), y, BASE / 2), (w - 0.02, 0.36, BASE + R.uniform(-0.03, 0.04)), M['stone'], bev=0.04, seg=2)
        x += w
    y = -D / 2 + 0.2
    while y < D / 2 - 0.2:
        w = R.uniform(0.35, 0.6)
        for xx in (-W / 2, W / 2):
            b.element()
            b.cbox((xx, min(y + w / 2, D / 2 - 0.2), BASE / 2), (0.36, w - 0.02, BASE + R.uniform(-0.03, 0.04)), M['stone'], bev=0.04, seg=2)
        y += w
    # ---- walls: squared timbers, front/back and the ends interleaved half a course, dovetails proud
    th, tw = COURSE - 0.008, 0.15
    door = (-0.95, 0.95, BASE + 1.95)          # x centre, width, head height
    win_front = (1.0, 0.75, BASE + 0.95, BASE + 1.75)
    win_r = (-0.1, 0.75, BASE + 0.95, BASE + 1.75)
    win_l = (-0.6, 0.75, BASE + 0.95, BASE + 1.75)

    def beam_x(y0, z, x0, x1):
        b.element()
        b.cbox(((x0 + x1) / 2, y0, z), (x1 - x0, tw, th), M['timber'], bev=0.012, seg=1)

    def beam_y(x0, z, y0, y1):
        b.element()
        b.cbox((x0, (y0 + y1) / 2, z), (tw, y1 - y0, th), M['timber'], bev=0.012, seg=1)

    for i in range(COURSES):
        z = BASE + th / 2 + i * COURSE
        for sy in (-1, 1):
            y0 = sy * (D / 2 - tw / 2)
            segs = [(-W / 2 - 0.18, W / 2 + 0.18)]
            if sy < 0:
                # front: door and window openings
                if z < door[2]:
                    segs = [(a, c) for (a, c) in segs for (a, c) in [(a, door[0] - door[1] / 2), (door[0] + door[1] / 2, c)]]
                if win_front[2] < z < win_front[3]:
                    out = []
                    for a, c in segs:
                        lo, hi = win_front[0] - win_front[1] / 2, win_front[0] + win_front[1] / 2
                        if c <= lo or a >= hi:
                            out.append((a, c))
                        else:
                            if a < lo:
                                out.append((a, lo))
                            if c > hi:
                                out.append((hi, c))
                    segs = out
            for a, c in segs:
                if c - a > 0.05:
                    beam_x(y0, z, a, c)
            # end grain on the dovetails
            for sx in (-1, 1):
                b.element()
                b.box((sx * (W / 2 + 0.181), y0, z), (0.004, tw * 0.95, th * 0.95), M['endgrain'])
        zz = z + COURSE / 2
        if zz < WALL_TOP:
            for sx, win in ((1, win_r), (-1, win_l)):
                x0 = sx * (W / 2 - tw / 2)
                segs = [(-D / 2 - 0.18, D / 2 + 0.18)]
                if win[2] < zz < win[3]:
                    lo, hi = win[0] - win[1] / 2, win[0] + win[1] / 2
                    segs = [(-D / 2 - 0.18, lo), (hi, D / 2 + 0.18)]
                for a, c in segs:
                    beam_y(x0, zz, a, c)
    # ---- gables: vertical boards with battens, up to the ridge (ridge along X)
    ridge_z = WALL_TOP + math.tan(PITCH) * (D / 2 + 0.05)
    for sx in (-1, 1):
        y = -D / 2
        while y < D / 2:
            w = R.uniform(0.18, 0.26)
            yc = min(y + w / 2, D / 2)
            top = WALL_TOP + math.tan(PITCH) * (D / 2 - abs(yc)) + 0.02
            b.element()
            b.cbox((sx * (W / 2 - 0.02), yc, (WALL_TOP + top) / 2), (0.03, w - 0.008, top - WALL_TOP), M['timber'], bev=0.004)
            y += w
    # ---- roof: rafters showing under the eaves, shake sheathing, a thick slab of snow
    run = D / 2 + OVER_EAVE
    L = run / math.cos(PITCH)
    for k in range(9):
        x = -W / 2 - OVER_GABLE + 0.1 + k * (W + 2 * OVER_GABLE - 0.2) / 8
        for sy in (-1, 1):
            a = V((x, 0, ridge_z - 0.08))
            c = V((x, sy * run, ridge_z - 0.08 - math.tan(PITCH) * run))
            b.element()
            b.cyl(a, c, 0.06, M['timber'], sides=6)
    for sy in (-1, 1):
        n = V((0, sy * math.sin(PITCH), math.cos(PITCH)))
        mid_y = sy * run / 2
        mid_z = ridge_z - math.tan(PITCH) * run / 2
        Rm = Matrix.Rotation(-sy * PITCH, 3, 'X')
        b.element()
        b.cbox((0, mid_y, mid_z), (W + 2 * OVER_GABLE, L, 0.05), M['shake'], bev=0.01, R_=Rm)
        # snow slab: thick, rounded at the eave lip and the verges, softly lumpy
        snow_t = 0.36
        sn = V((0, mid_y, mid_z)) + n * (0.025 + snow_t / 2)
        b.element()
        b.cbox(sn, (W + 2 * OVER_GABLE + 0.08, L + 0.12, snow_t), M['snow'], bev=0.16, seg=4, R_=Rm)
        # icicles off the eave
        eave = V((0, sy * (run + 0.06), ridge_z - math.tan(PITCH) * run - 0.02))
        for i in range(int(W * 7)):
            x = -W / 2 - OVER_GABLE + 0.1 + R.random() * (W + 2 * OVER_GABLE - 0.2)
            Lc = R.uniform(0.05, 0.55) ** 1.4 + 0.03
            top = V((x, eave.y, eave.z))
            b.element()
            b.cyl(top, top - V((0, 0, Lc)), Lc * 0.09, _ice(), sides=6, r1=0.002)
    # ridge cap of snow
    b.element()
    b.lathe([(0.0, -0.05), (0.22, 0.0), (0.18, 0.12), (0.0, 0.16)], V((-W / 2 - OVER_GABLE - 0.04, 0, ridge_z + 0.15)), V((1, 0, 0)),
            M['snow'], seg=10)
    # ---- chimney: stone stack through the back slope, snow cap, a dark flue
    cxy = V((1.15, 0.75))
    for k in range(9):
        b.element()
        z0 = WALL_TOP - 0.3 + k * 0.3
        b.cbox((cxy.x, cxy.y, z0), (0.62 - (k % 2) * 0.04, 0.62 - ((k + 1) % 2) * 0.04, 0.29), M['stone'], bev=0.03, seg=2)
    ztop = WALL_TOP - 0.3 + 9 * 0.3 - 0.15
    b.element()
    b.cbox((cxy.x, cxy.y, ztop + 0.05), (0.7, 0.7, 0.08), M['stone'], bev=0.02)
    b.element()
    b.cbox((cxy.x, cxy.y, ztop + 0.12), (0.74, 0.74, 0.1), M['snow'], bev=0.05, seg=3)
    # ---- door: planks, frame, iron straps and ring, a step, a lantern
    fy = -D / 2 - 0.005
    dx = door[0]
    for k in range(5):
        b.element()
        b.cbox((dx - 0.38 + k * 0.19, fy, BASE + 0.92), (0.185, 0.06, 1.84), M['timber'], bev=0.006)
    for zz in (BASE + 0.3, BASE + 1.55):
        b.element()
        b.cbox((dx - 0.1, fy - 0.035, zz), (0.7, 0.012, 0.05), M['iron'], bev=0.003)
    b.element()
    b.lathe([(0.04, 0.0), (0.045, 0.006), (0.04, 0.012)], V((dx + 0.3, fy - 0.05, BASE + 0.95)), V((0, 1, 0)), M['iron'], seg=10)
    for sx in (-1, 1):
        b.element()
        b.cbox((dx + sx * 0.52, fy - 0.01, BASE + 0.99), (0.1, 0.12, 2.0), M['timber'], bev=0.01)
    b.element()
    b.cbox((dx, fy - 0.01, BASE + 2.02), (1.16, 0.14, 0.12), M['timber'], bev=0.01)
    b.element()
    b.cbox((dx, fy - 0.35, 0.1), (1.2, 0.55, 0.2), M['stone'], bev=0.04, seg=2)
    lamp = V((dx + 0.72, fy - 0.2, BASE + 1.85))
    b.element()
    b.cyl(lamp + V((0, 0.17, 0.2)), lamp + V((0, 0, 0.2)), 0.012, M['iron'], sides=6)
    b.element()
    b.lathe([(0.0, -0.1), (0.07, -0.08), (0.075, 0.1), (0.05, 0.14), (0.0, 0.17)], lamp, V((0, 0, 1)), M['iron'], seg=8)
    b.element()
    b.lathe([(0.0, -0.06), (0.05, -0.05), (0.05, 0.07), (0.0, 0.08)], lamp, V((0, 0, 1)), M['lamp'], seg=8)
    # ---- windows: frame, four panes over a lit room, sill with snow, red shutters
    def window(origin, nrm, width=0.75):
        t = V((0, 0, 1)).cross(nrm).normalized()
        h = 0.8
        o = origin + nrm * 0.01
        b.element()
        b.panel(o + nrm * 0.0, nrm, width - 0.08, h - 0.08, M['glass'])
        for (u, v, sw, sh) in ((0, h / 2, width, 0.07), (0, -h / 2, width, 0.07), (-width / 2, 0, 0.07, h), (width / 2, 0, 0.07, h), (0, 0, 0.035, h), (0, 0, width, 0.035)):
            c = o + t * u + V((0, 0, v)) + nrm * 0.03
            Rm = Matrix((t, nrm, V((0, 0, 1)))).transposed()
            b.element()
            b.cbox(c, (sw, 0.05, sh), M['timber'], bev=0.006, R_=Rm)
        sill = o + V((0, 0, -h / 2 - 0.05)) + nrm * 0.08
        Rm = Matrix((t, nrm, V((0, 0, 1)))).transposed()
        b.element()
        b.cbox(sill, (width + 0.12, 0.2, 0.05), M['timber'], bev=0.008, R_=Rm)
        b.element()
        b.cbox(sill + V((0, 0, 0.06)), (width + 0.1, 0.18, 0.08), M['snow'], bev=0.035, seg=3, R_=Rm)
        for side in (-1, 1):
            c = o + t * side * (width / 2 + 0.2) + nrm * 0.03
            b.element()
            b.cbox(c, (0.36, 0.035, h + 0.06), M['paint'], bev=0.006, R_=Rm)
    window(V((win_front[0], -D / 2 - 0.0, (win_front[2] + win_front[3]) / 2)), V((0, -1, 0)))
    window(V((W / 2 + 0.0, win_r[0], (win_r[2] + win_r[3]) / 2)), V((1, 0, 0)))
    window(V((-W / 2 - 0.0, win_l[0], (win_l[2] + win_l[3]) / 2)), V((-1, 0, 0)))
    # ---- woodpile against the left wall, split logs end-out, snow on top
    for row in range(4):
        for k in range(7 - row):
            y = 1.05 - (k + row * 0.5) * 0.26
            z = 0.12 + row * 0.21
            r = R.uniform(0.085, 0.11)
            b.element()
            b.cyl(V((-W / 2 - 0.2, y, z)), V((-W / 2 - 0.82, y, z)), r, M['timber'], sides=7)
            b.element()
            b.cyl(V((-W / 2 - 0.82, y, z)), V((-W / 2 - 0.825, y, z)), r * 0.97, M['endgrain'], sides=7)
    b.element()
    b.cbox((-W / 2 - 0.5, 0.25, 0.92), (0.75, 1.7, 0.12), M['snow'], bev=0.05, seg=3)
    ob = b.finish(merge=False)
    return ob


_ice_m = None


def _ice():
    global _ice_m
    if _ice_m is None:
        from . import cliff
        _ice_m = cliff.ice_material()
    return _ice_m


def drifts(name, coll, seed=1):
    """Snow banked against the walls: a swept skirt round the footprint that rises up the wall and runs
    out smoothly into the ground, deepest on the windward (west, -X) end, the door kept clear."""
    R = random.Random(seed)
    b = core.Builder(name, coll, smooth_angle=80)
    M = mats()
    # perimeter, counter-clockwise from the front-left corner, slightly outside the plinth
    hw, hd, rr = W / 2 + 0.2, D / 2 + 0.2, 0.5
    pts = []
    corners = [(-hw, -hd), (hw, -hd), (hw, hd), (-hw, hd)]
    for i, (cx, cy) in enumerate(corners):
        nx_, ny_ = corners[(i + 1) % 4]
        n = int(max(abs(nx_ - cx), abs(ny_ - cy)) / 0.15)
        for k in range(n):
            t = k / n
            pts.append(Vector((cx + (nx_ - cx) * t, cy + (ny_ - cy) * t, 0)))

    def depth(p):
        h = 0.32 + 0.45 * max(0.0, -p.x / hw)            # windward end deepest
        if p.y < -hd + 0.01 and abs(p.x + 0.95) < 0.75:   # the doorway
            h *= 0.15
        return h * (0.85 + 0.3 * math.sin(p.x * 3.1 + p.y * 2.3 + seed))

    rings = []
    for i, p in enumerate(pts):
        q = pts[(i + 1) % len(pts)] - pts[i - 1]
        out = Vector((q.y, -q.x, 0)).normalized()
        h = depth(p)
        reach = 0.6 + h * 2.6
        prof = [(0.0, h), (0.12 * reach, h * 0.92), (0.4 * reach, h * 0.5), (0.75 * reach, h * 0.05), (reach, -0.45)]
        rings.append([b.bm.verts.new(p - out * 0.12 + out * d + Vector((0, 0, z))) for d, z in prof])
    n = len(rings)
    for i in range(n):
        a, c = rings[i], rings[(i + 1) % n]
        for k in range(len(a) - 1):
            b._face((a[k], c[k], c[k + 1], a[k + 1]), M['snow'], smooth=True)
    return b.finish(merge=True)
