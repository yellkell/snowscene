"""The tutorial's climbing wall, built over the game's own relief.

The game's wall (world-builders.ts buildCliff) is a 17 m plane displaced by cliffDisplacement on a
97 x 57 grid, and every hold sits 5 cm proud of that surface. Here that grid (read from the reference
OBJ) is upsampled to a few centimetres and given real granite: fracture planes, cracks, small ledges with
snow on them, ice glaze below the ledges and icicles hanging off the overhangs — all held to a couple of
centimetres inside the climbing lane so the holds stay seated, wilder outside it.
The holds become real rock jugs with chalk on their tops; the lip gets a wind-sculpted cornice.

Game (x, y, z) = Blender (x, -z, y).
"""
import bpy, bmesh, math, os, random
import numpy as np
from mathutils import Vector, Matrix
from . import snowmats as SM, core
from .nodes import NB

REF = os.path.join(SM.ART, 'work', 'tutorial_ref')


def read_face(path=os.path.join(REF, 'cliff.obj'), nx=97, ny=57):
    """The CliffFace grid from the OBJ: rows top -> bottom, columns left -> right (game coords)."""
    vs = []
    with open(path) as f:
        for line in f:
            if line.startswith('v '):
                vs.append([float(t) for t in line.split()[1:4]])
                if len(vs) == nx * ny:
                    break
    return np.array(vs, np.float64).reshape(ny, nx, 3)


def _cr(p0, p1, p2, p3, t):
    t2, t3 = t * t, t * t * t
    return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)


def upsample(a, fx, fy):
    """Separable Catmull-Rom upsampling of a 2D grid by integer factors."""
    def axis(m, f, ax):
        m = np.moveaxis(m, ax, 0)
        n = m.shape[0]
        idx = np.arange((n - 1) * f + 1) / f
        i = np.clip(idx.astype(int), 0, n - 2)
        t = (idx - i).reshape(-1, *([1] * (m.ndim - 1)))
        g = lambda k: m[np.clip(i + k, 0, n - 1)]
        return np.moveaxis(_cr(g(-1), g(0), g(1), g(2), t), 0, ax)
    return axis(axis(a, fy, 0), fx, 1)


def _vnoise(x, y, seed):
    xi, yi = np.floor(x).astype(np.int64), np.floor(y).astype(np.int64)
    xf, yf = x - xi, y - yi
    M = np.uint64(0xFFFFFFFF)

    def h(i, j):
        i = i.astype(np.uint64)
        j = j.astype(np.uint64)
        n = (i * np.uint64(374761393) + j * np.uint64(668265263) + np.uint64(seed * 2246822519 % 4294967296)) & M
        n = ((n ^ (n >> np.uint64(13))) * np.uint64(1274126177)) & M
        return ((n ^ (n >> np.uint64(16))) & np.uint64(0xFFFF)).astype(np.float64) / 65535.0 * 2 - 1
    u, v = xf * xf * (3 - 2 * xf), yf * yf * (3 - 2 * yf)
    a, b, c, d = h(xi, yi), h(xi + 1, yi), h(xi, yi + 1), h(xi + 1, yi + 1)
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v


def fbm(x, y, oct=5, seed=1):
    s, amp, f, tot = 0.0, 1.0, 1.0, 0.0
    for o in range(oct):
        s = s + amp * _vnoise(x * f, y * f, seed + o * 17)
        tot += amp
        amp *= 0.5
        f *= 2.03
    return s / tot


def granite_relief(x, y, lane):
    """Extra rock relief (m, toward the climber) at face point x (lateral, from the lane centre), y.
    Fracture planes: blocky steps from a few tilted ridged noises; small cracks; bounded in the lane."""
    blocks = np.abs(fbm(x * 0.9 + 3.1, y * 1.6, 3, 5)) * 0.12
    fract = (np.floor(fbm(x * 0.35, y * 0.5, 2, 9) * 3) / 3) * 0.08
    grain = fbm(x * 6, y * 6, 4, 13) * 0.025
    crack = -np.exp(-np.abs(fbm(x * 0.6 + 7, y * 0.25, 3, 21)) * 60) * 0.05
    r = blocks + fract + grain + crack
    return np.where(lane, np.clip(r * 0.3, -0.025, 0.025), r)


def _smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def geology(lx, y, top, bottom, half, wall=True):
    """The band's large-scale structure (m toward the climber), for everything outside the lane:
    bedding planes dipping gently across the face, each bed jutting at its foot so the bed below carries a
    snow shelf; deep vertical joints; a buttress leaning out on one side and a recess on the other; a bulge
    under the lip that roofs over (the icicles find it)."""
    # bedding: beds 0.6-1.6 m thick, dipping ~10 degrees, wavy. Within a bed the face stands out and leans
    # back a little as it rises; at the next bedding plane it steps back over a short tread (~9 cm, resolved
    # by the 3 cm grid so the ledge edge doesn't stair-step) - an upward-facing shelf that holds snow.
    s = (y - bottom + 0.18 * lx) / 1.1 + fbm(lx * 0.12 + 4, y * 0.1, 2, 31) * 1.1 + 0.18 * np.sin(y * 1.9 + lx * 0.2)
    bed = np.floor(s)
    f = s - bed
    amp = 0.12 + 0.22 * (0.5 + 0.5 * fbm(lx * 0.22, bed * 1.7, 2, 37))
    rise = np.clip(f / 0.12, 0, 1) ** 0.6 * (1 - 0.25 * f)
    tread = _smooth(0.9, 1.0, f)                    # the last tenth of the bed eases back to the plane
    beds = amp * rise * (1 - tread)
    # joints: one master joint through the band, the rest short and staggered bed by bed, as real jointing is
    joints = -0.4 * np.exp(-((lx - (-4.3 + 0.35 * fbm(y * 0.3, 1.0, 2, 41))) / 0.15) ** 2)
    for k in range(3):
        xj = 9.0 * fbm(bed * 3.71 + k * 11.3, np.full_like(bed, k * 5.3), 1, 61 + k)
        live = (fbm(bed * 2.13 + k * 7.7, np.full_like(bed, 3.1 + k), 1, 71 + k) > -0.1)
        joints -= live * (0.18 + 0.1 * k) * np.exp(-((lx - xj) / (0.09 + 0.03 * k)) ** 2)
    if not wall:
        # a bigger face: broad buttresses and bays instead of the wall's composed ones
        return beds + joints + 0.9 * fbm(lx * 0.07 + 2.0, y * 0.05, 3, 83)
    # a buttress on the right leaning out as it rises, a recess on the left
    hgt = np.clip((y - bottom) / max(top - bottom, 1e-3), 0, 1)
    lean = 0.75 * np.exp(-((lx - 5.2) / 2.1) ** 2) * (0.45 + 0.55 * hgt) - 0.5 * np.exp(-((lx + 5.8) / 2.4) ** 2)
    # a bulge under the lip on the left that roofs over
    roof = 0.45 * np.exp(-((lx + 3.4) / 1.3) ** 2 - ((y - (top - 1.3)) / 0.45) ** 2)
    return beds + joints + lean + roof


def topline(lx, top, seed=7):
    """The skyline of the band: the lane's lip is the game's; outside it the top breaks down unevenly."""
    lx = np.asarray(lx, np.float64)
    w = _smooth(1.6, 3.2, np.abs(lx))
    drop = (0.35 + 0.45 * (0.5 + 0.5 * fbm(lx * 0.45, np.zeros_like(lx) + 2.0, 3, seed))) * w
    return top - drop * (1.0 + 0.6 * _smooth(5.0, 8.5, np.abs(lx)))


def build_face(coll, cell=0.03, holds=None):
    G = read_face()
    gx = G[0, :, 0]
    gy = G[:, 0, 1]
    face_z = float(G[..., 2].min())
    disp = G[..., 2] - face_z
    fx = max(1, int(round((gx[1] - gx[0]) / cell)))
    fy = max(1, int(round(abs(gy[1] - gy[0]) / cell)))
    D = upsample(disp, fx, fy)
    X = upsample(np.tile(gx, (len(gy), 1)), fx, fy)
    Y = upsample(np.tile(gy[:, None], (1, len(gx))), fx, fy)
    cx = float(gx.mean())
    top, bottom = float(gy.max()), float(gy.min())
    half = (gx.max() - gx.min()) / 2
    # Extend past the game's rectangle so the rock can roll back into the mountain at the sides and the
    # foot instead of ending in straight cuts (rows still run top -> bottom).
    dxc = (X[0, 1] - X[0, 0])
    dyc = (Y[1, 0] - Y[0, 0])
    pc, pr = int(round(3.6 / abs(dxc))), int(round(1.4 / abs(dyc)))
    xs = np.concatenate([X[0, 0] - dxc * np.arange(pc, 0, -1), X[0, :], X[0, -1] + dxc * np.arange(1, pc + 1)])
    ys = np.concatenate([Y[:, 0], Y[-1, 0] + dyc * np.arange(1, pr + 1)])
    X = np.tile(xs[None, :], (len(ys), 1))
    Y = np.tile(ys[:, None], (1, len(xs)))
    D = np.pad(D, ((0, pr), (pc, pc)), mode='edge')
    lx = X - cx
    out_x = np.maximum(0, np.abs(lx) - half)
    out_y = np.maximum(0, bottom - Y)
    D = D - 0.6 * out_x ** 1.35 - 0.45 * out_y ** 1.25
    lane = np.abs(lx) < 1.35
    D = D + granite_relief(lx, Y, lane)
    # the band's structure, faded out across the lane edge so the holds keep the game's surface
    wgeo = _smooth(1.35, 2.6, np.abs(lx))
    D = D + wgeo * geology(lx, Y, top, bottom, half)
    # The holds, carved into the face: each a flake that steps out to a flat, slightly incut top edge
    # just above its gameplay point (which sits 5 cm proud of the game's surface), so the hand finds rock.
    hold_id = np.full(D.shape, -1.0)
    chalk = np.zeros(D.shape)
    for k, h in enumerate(holds or []):
        hx, hy, hz = h['p']
        s = 1.5 if h['lip'] else 1.0 + 0.15 * math.sin(k * 2.3)
        w, up, down = 0.15 * s, 0.035 * s, 0.11 * s
        dx = (X - hx) / w
        dyv = Y - (hy + 0.01)
        prof = np.where(dyv > 0, np.clip(1 - dyv / up, 0, 1) ** 0.35, np.clip(1 + dyv / down, 0, 1) ** 1.6)
        bump = prof * np.clip(1 - dx * dx, 0, 1) ** 0.7
        height = (hz - face_z) + 0.025 * s - D           # how far the flake must stand out here
        add = np.maximum(0, height) * bump
        D = D + add
        m = bump > 0.25
        hold_id[m] = k
        chalk = np.maximum(chalk, bump * np.clip(1 - np.abs(dyv - 0.01) / (0.06 * s), 0, 1))
    ny, nx = D.shape
    verts = np.stack([X, -(face_z + D), Y], -1).reshape(-1, 3)
    I, J = np.meshgrid(np.arange(nx - 1), np.arange(ny - 1))
    a = (J * nx + I).ravel()
    quads = np.stack([a, a + nx, a + nx + 1, a + 1], 1)
    # a ragged outline: the sides reach out unevenly (less near the top, where the band rounds over) and
    # the skyline breaks down outside the lane
    side = half + 3.6 * (0.42 + 0.58 * (0.5 + 0.5 * fbm(Y * 0.55, np.full_like(Y, 5.0), 3, 51)))         * (1 - 0.7 * _smooth(top - 2.2, top, Y))
    keep_v = (np.abs(lx) < side) & (Y <= topline(lx, top) + 1e-6)
    kv = keep_v.ravel()
    quads = quads[kv[quads].all(1)]
    me = bpy.data.meshes.new('cliff_face')
    me.vertices.add(len(verts))
    me.vertices.foreach_set('co', verts.astype(np.float32).ravel())
    me.loops.add(quads.size)
    me.loops.foreach_set('vertex_index', quads.astype(np.int32).ravel())
    me.polygons.add(len(quads))
    me.polygons.foreach_set('loop_start', (np.arange(len(quads)) * 4).astype(np.int32))
    me.polygons.foreach_set('loop_total', np.full(len(quads), 4, np.int32))
    me.update(calc_edges=True)
    me.polygons.foreach_set('use_smooth', np.ones(len(quads), bool))
    # make faces point toward the climber (+game z = -Blender y)
    me.validate()
    if me.polygons[len(quads) // 2].normal.y > 0:
        me.flip_normals()
    for name, arr in (('hold', hold_id), ('chalk', chalk)):
        at = me.attributes.new(name, 'FLOAT', 'POINT')
        at.data.foreach_set('value', arr.astype(np.float32).ravel())
    ob = bpy.data.objects.new('CLIFF_FACE', me)
    coll.objects.link(ob)
    me.materials.append(cliff_material())
    me.validate()
    return ob, {'face_z': face_z, 'cx': cx, 'top': top, 'bottom': bottom, 'half': half, 'X': X, 'Y': Y, 'D': D,
                'topline': lambda x: topline(np.asarray(x) - cx, top)}


_mat = None


def cliff_material():
    """Cold granite, snow lying on every ledge, a glaze of verglas in the streaks below them."""
    global _mat
    if _mat:
        return _mat
    m = SM.new('cliff_rock')
    nb = NB(m)
    pos = nb.pos()
    d, r, n, h = SM.rock_box(nb, pos, tint_sat=0.3, tint_val=0.72)
    geo = nb.n('ShaderNodeNewGeometry')
    _, _, nz = nb.sep(geo.outputs['Normal'])
    x, y, z = nb.sep(pos)
    # Lichen in patches on the open rock: map lichen (sulphur-green) and rock tripe (near black).
    l1 = nb.mrange(nb.noise(pos, 1.6, detail=6.0, rough=0.65), 0.63, 0.68, 0.0, 0.85)
    l2 = nb.mrange(nb.noise(pos, 2.9, detail=5.0, rough=0.6), 0.66, 0.7, 0.0, 0.8)
    d = nb.mix(l1, d, (0.34, 0.35, 0.13))
    d = nb.mix(l2, d, (0.035, 0.03, 0.028))
    # Dark streaks where meltwater runs down the face in the thaw.
    wet = nb.noise(nb.comb(nb.math('MULTIPLY', x, 2.2), nb.math('MULTIPLY', y, 2.2), nb.math('MULTIPLY', z, 0.12)), 1.0, detail=4.0)
    d = nb.mix(nb.mrange(wet, 0.58, 0.7, 0.0, 0.5), d, nb.mix(1.0, d, (0.42, 0.42, 0.42), blend='MULTIPLY'))
    # Rime feathering the edges and arêtes.
    rime = nb.mrange(geo.outputs['Pointiness'], 0.53, 0.61, 0.0, 0.75)
    d = nb.mix(rime, d, (0.8, 0.83, 0.87))
    rock = nb.bsdf(d, rough=r, normal=n, out=False).outputs[0]
    # Verglas: thin clear ice where meltwater ran down and froze, streaking below ledges.
    streak = nb.noise(nb.comb(nb.math('MULTIPLY', x, 3.0), nb.math('MULTIPLY', y, 3.0), nb.math('MULTIPLY', z, 0.25)), 1.0, detail=3.0)
    glaze = nb.math('MULTIPLY', nb.mrange(streak, 0.66, 0.78, 0.0, 0.55), nb.mrange(nz, -0.3, 0.2, 1.0, 0.0))
    ice = nb.n('ShaderNodeBsdfGlossy', ins={'Roughness': 0.08, 'Color': (0.45, 0.5, 0.55), 'Normal': n})
    mix_i = nb.n('ShaderNodeMixShader')
    nb.link(glaze, mix_i.inputs[0]); nb.link(rock, mix_i.inputs[1]); nb.link(ice.outputs[0], mix_i.inputs[2])
    # Snow on ledges and in the cracks that face up.
    snow = SM.snow_cover_mask(nb, nz, 0.62, 0.1, 7.0, -0.1)
    # chalk on the holds: white powder on their tops, smeared below
    chalk = nb.math('MULTIPLY', nb.attr('chalk', 'GEOMETRY'), nb.mrange(nb.noise(pos, 30.0, detail=5.0, rough=0.7), 0.35, 0.6, 0.3, 1.0))
    ch = nb.bsdf((0.86, 0.86, 0.84), rough=0.95, out=False).outputs[0]
    mix_c = nb.n('ShaderNodeMixShader')
    nb.link(chalk, mix_c.inputs[0]); nb.link(mix_i.outputs[0], mix_c.inputs[1]); nb.link(ch, mix_c.inputs[2])
    mix_s = nb.n('ShaderNodeMixShader')
    nb.link(snow, mix_s.inputs[0]); nb.link(mix_c.outputs[0], mix_s.inputs[1]); nb.link(SM.snow_shader(nb), mix_s.inputs[2])
    nb.link(mix_s.outputs[0], nb.out.inputs['Surface'])
    _mat = m
    return m


def hold_material():
    m = bpy.data.materials.get('cliff_hold')
    if m:
        return m
    m = SM.new('cliff_hold')
    nb = NB(m)
    pos = nb.pos()
    d, r, n, h = SM.rock_box(nb, nb.vmath('SCALE', pos, s=2.0), tint_sat=0.28, tint_val=0.8)
    rock = nb.bsdf(d, rough=r, normal=n, out=False).outputs[0]
    # Chalk: white powder on the tops and where fingers go, smeared and patchy.
    _, _, nz = nb.sep(nb.n('ShaderNodeNewGeometry').outputs['Normal'])
    patch = nb.noise(pos, 28.0, detail=5.0, rough=0.7)
    chalk = nb.math('MULTIPLY', nb.mrange(nz, -0.1, 0.6, 0.2, 1.0), nb.mrange(patch, 0.42, 0.6, 0.0, 0.85))
    ch = nb.bsdf((0.88, 0.88, 0.86), rough=0.95, out=False).outputs[0]
    mx = nb.n('ShaderNodeMixShader')
    nb.link(chalk, mx.inputs[0]); nb.link(rock, mx.inputs[1]); nb.link(ch, mx.inputs[2])
    nb.link(mx.outputs[0], nb.out.inputs['Surface'])
    return m


def build_holds(coll, holds, seed=5):
    """Each hold a granite jug: a rounded, flattened lump with a positive lip on top, sunk into the face
    behind its gameplay point. One object; per-vertex 'hold' attribute = hold index (for runtime glow)."""
    R = random.Random(seed)
    b = core.Builder('CLIFF_HOLDS', coll, smooth_angle=50)
    mat = hold_material()
    idx_layer = b.bm.verts.layers.float.new('hold')
    for k, h in enumerate(holds):
        p = Vector((h['p'][0], -h['p'][2], h['p'][1]))   # game -> Blender
        s = 1.55 if h['lip'] else R.uniform(0.85, 1.15)
        w, t, hh = 0.13 * s, 0.085 * s, 0.07 * s
        seg, rings = 12, 7
        top = []
        rows = []
        for j in range(rings + 1):
            el = -math.pi / 2 + math.pi * j / rings
            row = []
            for i in range(seg):
                az = math.tau * i / seg
                n = 1 + 0.12 * math.sin(az * 3 + k) + 0.08 * math.sin(el * 4 + az * 2 + k * 1.7)
                lx = math.cos(el) * math.cos(az) * w * n
                ly = math.sin(el) * hh * n
                lz = math.cos(el) * math.sin(az) * t * n
                # a jug: the top lip overhangs toward the climber, the bottom tucks in
                lz += 0.03 * s * max(0.0, math.sin(el)) ** 2
                # (x along the face, y up, z out of the face toward the climber -> Blender -y)
                v = b.bm.verts.new(p + Vector((lx, -(lz - 0.03 * s), ly)))
                v[idx_layer] = k
                row.append(v)
            rows.append(row)
        for j in range(rings):
            for i in range(seg):
                i2 = (i + 1) % seg
                b._face((rows[j][i], rows[j][i2], rows[j + 1][i2], rows[j + 1][i]), mat, smooth=True)
    return b.finish(merge=False)


def build_icicles(coll, info, count=90, seed=11):
    """Icicles hanging from the overhangs, outside the climbing lane."""
    R = random.Random(seed)
    X, Y, D = info['X'], info['Y'], info['D']
    dDdy = np.gradient(D, axis=0)        # rows run top->bottom; positive = surface steps out going down
    cand = np.argwhere((dDdy < -0.004) & (np.abs(X - info['cx']) > 1.8) & (Y < info['top'] - 0.4))
    b = core.Builder('CLIFF_ICICLES', coll, smooth_angle=60)
    mat = ice_material()
    if len(cand) == 0:
        return None
    for _ in range(count):
        j, i = cand[R.randrange(len(cand))]
        x, y, d = X[j, i], Y[j, i], D[j, i]
        L = R.uniform(0.06, 0.45) ** 1.3 + 0.04
        r0 = L * R.uniform(0.07, 0.12)
        top = Vector((x, -(info['face_z'] + d - 0.01), y))
        b.cyl(top, top - Vector((R.gauss(0, 0.01), R.gauss(0, 0.01), L)), r0, mat, sides=7, caps=True, r1=0.002)
    return b.finish(merge=False)


def ice_material():
    m = bpy.data.materials.get('clear_ice')
    if m:
        return m
    m = SM.new('clear_ice')
    nb = NB(m)
    pos = nb.pos()
    bumpn = nb.bump(nb.noise(pos, 40.0, detail=4.0), strength=0.15, dist=0.003)
    p = nb.bsdf((0.92, 0.97, 1.0), rough=0.04, normal=bumpn, trans=1.0, ior=1.31, out=False)
    nb.link(p.outputs[0], nb.out.inputs['Surface'])
    return m


def build_cornice(coll, info, width=20.5):
    """The summit lip: snow blown over the edge into a curled, overhanging cornice with a crisp edge."""
    b = core.Builder('CORNICE', coll, smooth_angle=70)
    mat = SM.new('cornice_snow') if 'cornice_snow' in bpy.data.materials else None
    if mat is None or not mat.node_tree:
        mat = SM.new('cornice_snow')
        nb = NB(mat)
        pos = nb.pos()
        h = nb.math('ADD', nb.noise(pos, 6.0, detail=6.0, rough=0.6), nb.math('MULTIPLY', nb.noise(pos, 40.0, detail=2.0), 0.3))
        nb.link(SM.snow_shader(nb, normal=nb.bump(h, strength=0.3, dist=0.01)), nb.out.inputs['Surface'])
    cx, top, fz = info['cx'], info['top'], info['face_z']
    n = 120
    pts = [Vector((cx - width / 2 + width * i / n, 0, 0)) for i in range(n + 1)]
    prof_base = [(0.0, -0.05), (0.35, 0.05), (0.55, 0.22), (0.35, 0.34), (-0.1, 0.36), (-1.6, 0.18), (-1.9, 0.0)]
    rings = []
    for i, p in enumerate(pts):
        u = i / n
        over = 0.2 + 0.25 * (0.5 + 0.5 * math.sin(u * 23 + 1.3)) * (0.6 + 0.4 * math.sin(u * 7.1))
        # the drift thins out at both ends (over the buttresses) instead of stopping square
        sm = lambda e: e * e * (3 - 2 * e)
        taper = 0.12 + 0.88 * sm(min(1.0, u / 0.16)) * sm(min(1.0, (1 - u) / 0.16))
        swell = 1 + 0.35 * math.sin(u * 11.3 + 0.7) * math.sin(u * 3.1 + 2.0)
        # sit on the rock as it actually is here: the broken skyline, and the face's relief at the lip
        tl = float(info['topline'](p.x)) if 'topline' in info else top
        if 'X' in info:
            col = int(np.argmin(np.abs(info['X'][0] - p.x)))
            row = int(np.argmin(np.abs(info['Y'][:, col] - (tl - 0.05))))
            d_lip = float(info['D'][row, col])
        else:
            d_lip = 0.0
        ring = []
        for (dz, dy) in prof_base:
            # dz: out from the face (+toward climber), dy: up
            dz2 = (dz * (1 + over) if dz > 0 else dz) * (taper if dz > 0 else 1.0)
            ring.append(b.bm.verts.new(Vector((p.x, -(fz + d_lip - 0.02 + dz2 * 0.9), tl - 0.08 + dy * (0.9 + over * 0.6) * taper * swell))))
        rings.append(ring)
    m = len(prof_base)
    for i in range(n):
        for k in range(m - 1):
            b._face((rings[i][k], rings[i + 1][k], rings[i + 1][k + 1], rings[i][k + 1]), mat, smooth=True)
    return b.finish(merge=False)
