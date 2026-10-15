"""Procedural snow-laden spruce (Picea), built like the real thing.

A tapered trunk; whorls of branches every 0.3-0.5 m whose length follows a narrow conical crown; each
branch rises a little off the trunk then droops under its load, lower branches more, tips curling back
up. Along each branch, photographic needle sprays (Poly Haven CC0 fir scan, keyed to alpha) fan out to both
sides, with pendulous branchlets hanging from the middle branches. On top of every branch a modelled snow
pillow rides the curve, lumpy and thickest just out from the trunk, and the crown carries a cap.

`build(name, coll, H, seed, snow=1.0, lod=0)` returns the object. lod 0 is the Cycles/impostor source
(~100k tris); lod 1 is a realtime near-LOD from the same seed (fewer, larger sprays; simpler snow).
"""
import bpy, math, random, os, json
from mathutils import Vector, Matrix
from . import core
from .nodes import NB
from . import snowmats as SM

WORK = os.path.join(SM.ART, 'work')
_RECTS = None
_MATS = {}


def spray_rects():
    """Spray cards in the keyed atlas as (u0, v0, u1, v1) with the stem at v0 (bottom)."""
    global _RECTS
    if _RECTS is None:
        raw = json.load(open(os.path.join(WORK, 'spray_rects.json')))
        _RECTS = []
        for x0, y0, x1, y1, n in raw:
            if x1 <= 360 or n < 150:
                continue
            _RECTS.append((x0 / 2048, 1 - y1 / 2048, x1 / 2048, 1 - y0 / 2048, n))
        _RECTS.sort(key=lambda r: -r[4])
    return _RECTS


def materials():
    if _MATS:
        return _MATS
    # Needles: photographic spray with alpha, a little translucency (backlit needles glow), frost on top.
    m = SM.new('spruce_needles')
    nb = NB(m)
    uv = nb.uv('UVMap')
    diff = nb.img(SM.load(os.path.join(WORK, 'spray_diff.png'), False), uv).outputs['Color']
    alpha = nb.img(SM.load(os.path.join(WORK, 'spray_alpha.png'), True), uv).outputs['Color']
    nrm_img = SM.load(os.path.join(SM.MODELS, 'fir_sapling_medium', 'textures', 'fir_sapling_medium_twigs_nor_gl_2k.jpg'), True)
    nrm = nb.n('ShaderNodeNormalMap', uv_map='UVMap', ins={'Color': nb.img(nrm_img, uv).outputs['Color'], 'Strength': 0.8}).outputs['Normal']
    # Spruce in winter is darker and bluer than the summer scan; per-tree tint comes in via 'rand'.
    rnd = nb.attr('rand', 'GEOMETRY')
    col = nb.hsv(diff, 0.5 + 0.025, 0.9, 0.42)
    col = nb.mix(nb.math('MULTIPLY', rnd, 0.35), col, nb.hsv(col, 0.47, 0.8, 0.8))
    p = nb.bsdf(col, rough=0.55, normal=nrm, out=False)
    tr = nb.n('ShaderNodeBsdfTranslucent', ins={'Color': nb.hsv(col, 0.5, 1.2, 0.9)})
    leaf = nb.n('ShaderNodeMixShader')
    nb.link(0.25, leaf.inputs[0]); nb.link(p.outputs[0], leaf.inputs[1]); nb.link(tr.outputs[0], leaf.inputs[2])
    # Snow held in the sprays: on the upper face only (green from below), where needles are dense,
    # more on cards the generator loaded (outer, upper, well-lit tiers: 'snow' face attribute).
    geo = nb.n('ShaderNodeNewGeometry')
    _, _, nz = nb.sep(geo.outputs['True Normal'])
    front = nb.math('SUBTRACT', 1.0, geo.outputs['Backfacing'])
    load = nb.attr('snow', 'GEOMETRY')
    dens = nb.n('ShaderNodeRGBToBW', ins={'Color': diff}).outputs[0]
    speck = nb.noise(nb.pos(), 38.0, detail=3.0, rough=0.7)
    held = nb.math('MULTIPLY', nb.mrange(nz, 0.25, 0.75, 0.0, 1.0), front)
    held = nb.math('MULTIPLY', held, nb.mrange(nb.math('ADD', load, nb.math('MULTIPLY', speck, 0.6)), 0.55, 0.95, 0.0, 1.0))
    held = nb.math('MULTIPLY', held, nb.mrange(dens, 0.05, 0.25, 0.4, 1.0), clamp=True)
    sn = SM.snow_shader(nb)
    mx = nb.n('ShaderNodeMixShader')
    nb.link(held, mx.inputs[0]); nb.link(leaf.outputs[0], mx.inputs[1]); nb.link(sn, mx.inputs[2])
    cut = nb.n('ShaderNodeMixShader')
    nb.link(alpha, cut.inputs[0]); nb.link(nb.n('ShaderNodeBsdfTransparent').outputs[0], cut.inputs[1]); nb.link(mx.outputs[0], cut.inputs[2])
    nb.link(cut.outputs[0], nb.out.inputs['Surface'])
    _MATS['needles'] = m

    # Bark: the scanned fir bark at true scale (~1 m tile on a trunk), darkened by damp.
    m = SM.new('spruce_bark')
    nb = NB(m)
    tex = os.path.join(SM.MODELS, 'fir_tree_01', 'textures', 'fir_tree_01_bark_')
    vec = nb.n('ShaderNodeMapping', ins={'Vector': nb.uv('UVMap'), 'Scale': (1 / 0.6, 1 / 0.6, 1)}).outputs[0]
    d = nb.img(SM.load(tex + 'diff_2k.jpg', False), vec).outputs['Color']
    n = nb.n('ShaderNodeNormalMap', uv_map='UVMap', ins={'Color': nb.img(SM.load(tex + 'nor_gl_2k.jpg', True), vec).outputs['Color']}).outputs['Normal']
    bark = nb.bsdf(nb.hsv(d, 0.5, 0.8, 0.7), rough=0.8, normal=n, out=False).outputs[0]
    _, _, nz = nb.sep(nb.n('ShaderNodeNewGeometry').outputs['Normal'])
    mask = SM.snow_cover_mask(nb, nz, 0.6, 0.12, 5.0)
    mx = nb.n('ShaderNodeMixShader')
    nb.link(mask, mx.inputs[0]); nb.link(bark, mx.inputs[1]); nb.link(SM.snow_shader(nb), mx.inputs[2])
    nb.link(mx.outputs[0], nb.out.inputs['Surface'])
    _MATS['bark'] = m

    # Snow load: settled, slightly wind-packed snow; a fine bump keeps it from looking like plaster.
    m = SM.new('spruce_snow')
    nb = NB(m)
    pos = nb.pos()
    h = nb.math('ADD', nb.noise(pos, 22.0, detail=6.0, rough=0.65), nb.math('MULTIPLY', nb.noise(pos, 90.0, detail=2.0), 0.3))
    nrm = nb.bump(h, strength=0.45, dist=0.006)
    nb.link(SM.snow_shader(nb, normal=nrm), nb.out.inputs['Surface'])
    _MATS['snow'] = m
    return _MATS


def _rot_to(fwd, up):
    """Matrix columns (side, fwd, normal) for a card whose stem->tip runs along fwd."""
    f = fwd.normalized()
    n = up - f * up.dot(f)
    if n.length < 1e-5:
        n = f.orthogonal()
    n.normalize()
    s = f.cross(n)
    return s, f, n


def _snow_layer(b):
    lay = b.bm.faces.layers.float.get('snow')
    return lay if lay is not None else b.bm.faces.layers.float.new('snow')


def card(b, mat, base, fwd, up, length, rect, rand, bend=0.18, load=0.0, flat=False):
    """A needle spray: two-segment bent quad from the stem at `base` along `fwd`, facing `up`."""
    s, f, n = _rot_to(fwd, up)
    u0, v0, u1, v1, _ = rect
    aspect = (u1 - u0) / max(v1 - v0, 1e-4)
    w = length * aspect * 0.5
    mid = base + f * (length * 0.5)
    tip = base + f * length - n * (length * bend)
    pts = [base - s * w * 0.6, base + s * w * 0.6, mid + s * w, mid - s * w]
    vm = (v0 + v1) * 0.5
    lay = _snow_layer(b)
    if flat:
        tipf = base + f * length - n * (length * bend * 0.5)
        q = [base - s * w * 0.6, base + s * w * 0.6, tipf + s * w * 0.8, tipf - s * w * 0.8]
        f1 = b._face([b.bm.verts.new(p) for p in q], mat, uvs=[(u0, v0), (u1, v0), (u1, v1), (u0, v1)], rand=rand)
        if f1 is not None:
            f1[lay] = load
        return
    f1 = b._face([b.bm.verts.new(p) for p in pts], mat, uvs=[(u0, v0), (u1, v0), (u1, vm), (u0, vm)], rand=rand)
    pts2 = [mid - s * w, mid + s * w, tip + s * w * 0.8, tip - s * w * 0.8]
    f2 = b._face([b.bm.verts.new(p) for p in pts2], mat, uvs=[(u0, vm), (u1, vm), (u1, v1), (u0, v1)], rand=rand)
    for f in (f1, f2):
        if f is not None:
            f[lay] = load


def build(name, coll, H=14.0, seed=1, snow=1.0, lod=0, crown=0.24, flag=0.0, wind=(1.0, 0.18)):
    R = random.Random(seed)
    mats = materials()
    b = core.Builder(name, coll, smooth_angle=60)
    rects = spray_rects()
    big = rects[:4]
    small = rects[4:] or rects
    tree_rand = R.random()
    b.element(rand=tree_rand, uvo=(R.uniform(0, 5), R.uniform(0, 5)))

    # Trunk: slight lean and wander, flaring at the root.
    r0 = H * 0.017
    wv = Vector((wind[0], wind[1], 0)).normalized()
    lean = (Vector((R.gauss(0, 0.012), R.gauss(0, 0.012), 1)) + wv * (0.035 * flag)).normalized()
    pts, prof = [], []
    nseg = 14 if lod == 0 else 6
    for i in range(nseg + 1):
        t = i / nseg
        p = lean * (t * H) + Vector((math.sin(t * 7 + seed) * 0.03, math.cos(t * 5 + seed) * 0.03, 0)) * H * 0.02
        pts.append(p)
    trunk_r = lambda t: r0 * (1 - t) ** 1.1 + 0.012 + (r0 * 0.6 * max(0, 1 - t * 18))
    for i in range(nseg):
        t0, t1 = i / nseg, (i + 1) / nseg
        b.cyl(pts[i], pts[i + 1], trunk_r(t0), mats['bark'], sides=10 if lod == 0 else 6, caps=False, r1=trunk_r(t1))

    def trunk_at(z):
        t = min(max(z / H, 0), 1)
        return lean * (t * H)

    # Whorls.
    # Every LOD draws the same random numbers in the same order, so the realtime tree is the same tree
    # as the Cycles/impostor one; LODs differ only in what they emit.
    spacing = 0.38 * (H / 14) ** 0.4
    z = 0.12 + R.uniform(0, 0.1)
    widx = 0
    cards = 0
    blobs = []
    while z < H - 0.35:
        t = z / H
        # Narrow cone; the lowest skirt a touch shorter, very top short and stiff.
        Lmax = crown * H * (1 - t) ** 0.92 * (0.82 if t < 0.03 else 1.0) + 0.25
        nb_ = R.randint(5, 7)
        for k in range(nb_):
            az = widx * 2.39996 + k * math.tau / nb_ + R.uniform(-0.3, 0.3)
            L = Lmax * R.uniform(0.8, 1.08)
            if flag:
                # wind-flagged: stunted to windward, worst high up where the wind is strongest
                into = max(0.0, -(math.cos(az) * wv.x + math.sin(az) * wv.y))
                L *= 1 - flag * into * (0.35 + 0.45 * t)
            if L < 0.25:
                continue
            d = Vector((math.cos(az), math.sin(az), 0))
            # Upper branches angle up; lower ones start level and droop hard under the snow.
            e0 = math.radians(28 - 40 * min(1, (1 - t) * 1.2)) + R.uniform(-0.06, 0.06)
            droop = (0.10 + 0.32 * (1 - t) ** 1.5) * (0.7 + 0.5 * snow)
            curl = 0.05 + 0.06 * (1 - t)
            base = trunk_at(z)
            npts = 7
            bpts = []
            for i in range(npts + 1):
                s = i / npts
                horiz = d * (s * L * math.cos(e0))
                vert = s * L * math.sin(e0) - droop * L * s * s + curl * L * max(0, s - 0.75) ** 2 * 16
                bpts.append(base + horiz + Vector((0, 0, vert)))
            # Branch wood.
            if lod == 0:
                br = max(0.006, r0 * 0.35 * (L / (crown * H)))
                for i in range(npts):
                    b.cyl(bpts[i], bpts[i + 1], br * (1 - i / npts * 0.8), mats['bark'], sides=5, caps=False,
                          r1=br * (1 - (i + 1) / npts * 0.8))
            # Needle sprays along the branch, both sides, plus pendulous branchlets.
            step = 0.075
            ci = 0
            s = 0.18 + R.uniform(0, step)
            side = 1
            while s < 1.0:
                i = min(int(s * npts), npts - 1)
                fr = s * npts - i
                p = bpts[i].lerp(bpts[i + 1], fr)
                tan = (bpts[i + 1] - bpts[i]).normalized()
                lat = tan.cross(Vector((0, 0, 1))).normalized() * side
                ln = (0.45 + 0.35 * (1 - s)) * min(1.0, L / 1.4 + 0.4) * R.uniform(0.85, 1.2)
                fwd = (tan * 0.55 + lat * 0.85 + Vector((0, 0, R.uniform(-0.25, 0.1)))).normalized()
                up = Vector((R.uniform(-0.25, 0.25), R.uniform(-0.25, 0.25), 1)).normalized()
                ld = snow * (0.35 + 0.5 * s) * R.uniform(0.6, 1.2)
                rect = R.choice(big if ln > 0.4 else small)
                # lod 1 keeps every third spray, half again as big, to fill the same volume
                if lod == 0 or ci % 3 == 0:
                    card(b, mats['needles'], p, fwd, up, ln * (1.0 if lod == 0 else 1.55), rect, tree_rand, load=ld, flat=lod > 0)
                    cards += 1
                ci += 1
                if 0.12 < t < 0.75 and R.random() < 0.45:
                    hang = (Vector((0, 0, -1)) + tan * 0.25 + lat * 0.2).normalized()
                    rect2 = R.choice(small + big[2:])
                    if lod == 0:
                        card(b, mats['needles'], p + lat * 0.05, hang, lat, ln * 0.8, rect2, tree_rand, bend=-0.1, load=0.0)
                        cards += 1
                s += step * R.uniform(0.7, 1.2) / max(L, 0.6) * 1.2
                side = -side
            # Terminal spray.
            tan = (bpts[-1] - bpts[-2]).normalized()
            card(b, mats['needles'], bpts[-1] - tan * 0.05, tan, Vector((0, 0, 1)), 0.4 * (1.0 if lod == 0 else 1.3), big[0], tree_rand)
            # Snow lying along the top of the branch: overlapping elongated blobs that fuse into a
            # ridge (metaballs, lod 0), broken where the branch dips or the load slid off.
            if snow > 0.05 and L > 0.45:
                s_ = 0.05 + R.uniform(0, 0.06)
                while s_ < 0.78:
                    i = min(int(s_ * npts), npts - 1)
                    p = bpts[i].lerp(bpts[i + 1], s_ * npts - i)
                    tan = (bpts[i + 1] - bpts[i]).normalized()
                    lat = tan.cross(Vector((0, 0, 1))).normalized()
                    size = (0.05 + 0.07 * (1 - s_)) * R.uniform(0.75, 1.2) * min(1.2, L / 1.5 + 0.5) * (0.6 + 0.4 * snow)
                    if R.random() < 0.82:
                        c = p + lat * R.gauss(0, 0.03 + 0.05 * s_) + Vector((0, 0, 0.035 + size * 0.2))
                        stretch, flat = R.uniform(2.2, 3.2), R.uniform(0.42, 0.58)
                        if lod == 0:
                            blobs.append((c, tan, size, stretch, flat))
                        elif len(blobs) % 5 == 0:
                            # a simple elongated lump in place of each pair of fused blobs
                            _clump(b, mats['snow'], c, tan, size * 1.9, random.Random(len(blobs)), lod)
                            blobs.append(None)
                        else:
                            blobs.append(None)
                    s_ += size * R.uniform(1.4, 2.2) / max(L, 0.5)
        z += spacing * R.uniform(0.85, 1.15)
        widx += 1

    # Leader: a spire of upright sprays, and the crown cap of snow.
    top = trunk_at(H)
    for k in range(6 if lod == 0 else 3):
        az = k * math.tau / 6
        fwd = Vector((math.cos(az) * 0.25, math.sin(az) * 0.25, 1)).normalized()
        card(b, mats['needles'], top - Vector((0, 0, 0.55)), fwd, Vector((math.cos(az), math.sin(az), 0)), 0.65, big[1], tree_rand, bend=0.05)
    if snow > 0.05:
        cap = []
        for i in range(5):
            zz = H - 0.9 - i * 0.55
            cap.append((trunk_at(zz), crown * H * (1 - zz / H) * 0.75 + 0.1))
        for c, rr in cap:
            b.lathe([(0.0, 0.22 * snow), (rr * 0.6, 0.12 * snow), (rr, 0.0)], c + Vector((0, 0, 0.05)), Vector((0, 0, 1)),
                    mats['snow'], seg=10 if lod == 0 else 6, smooth=True)
    ob = b.finish(merge=False)
    blobs = [x for x in blobs if x is not None]
    if blobs:
        _metaball_snow(ob, blobs, mats['snow'], name)
    ob['cards'] = cards
    ob['height'] = H
    return ob


def _pillow(b, mat, pts, scales, lod):
    """Sweep a flattened, round-topped snow profile along `pts` with per-point (width, thickness)."""
    n = 7 if lod == 0 else 4
    rings = []
    for i, p in enumerate(pts):
        if i == 0:
            t = (pts[1] - pts[0]).normalized()
        elif i == len(pts) - 1:
            t = (pts[-1] - pts[-2]).normalized()
        else:
            t = (pts[i + 1] - pts[i - 1]).normalized()
        side = t.cross(Vector((0, 0, 1))).normalized()
        up = side.cross(t).normalized()
        w, h = scales[i]
        ring = []
        for k in range(n + 1):
            a = math.pi * k / n
            x = math.cos(a) * w
            y = math.sin(a) ** 0.8 * h
            ring.append(b.bm.verts.new(p + side * x + up * y - up * 0.02))
        rings.append(ring)
    for i in range(len(rings) - 1):
        for k in range(n):
            b._face((rings[i][k], rings[i + 1][k], rings[i + 1][k + 1], rings[i][k + 1]), mat, smooth=True)
    # Round the ends down onto the branch.
    for ring, end in ((rings[0], pts[0]), (rings[-1], pts[-1])):
        c = b.bm.verts.new(end + Vector((0, 0, 0.0)))
        for k in range(n):
            b._face((ring[k], ring[k + 1], c) if ring is rings[-1] else (ring[k + 1], ring[k], c), mat, smooth=True)


def _clump(b, mat, c, tan, size, R, lod):
    """A soft, lumpy, flattened lump of snow lying along `tan`."""
    seg, rings = (10, 7) if lod == 0 else (5, 3)
    side = tan.cross(Vector((0, 0, 1))).normalized()
    ax = (size * R.uniform(1.0, 1.6), size * R.uniform(0.75, 1.0), size * R.uniform(0.6, 0.85))
    ph = R.uniform(0, 6.28)
    vs = []
    top = b.bm.verts.new(c + Vector((0, 0, ax[2])))
    for j in range(1, rings):
        el = math.pi / 2 - math.pi * j / rings
        row = []
        for i in range(seg):
            az = math.tau * i / seg
            n = 1 + 0.16 * math.sin(az * 3 + ph) * math.cos(el * 2) + 0.09 * math.sin(az * 5 - ph * 2) + 0.08 * math.sin(el * 5 + az * 2 + ph)
            local = tan * (math.cos(el) * math.cos(az) * ax[0] * n) + side * (math.cos(el) * math.sin(az) * ax[1] * n)
            z = math.sin(el) * ax[2] * (1.0 if el > 0 else 0.35)
            row.append(b.bm.verts.new(c + local + Vector((0, 0, z))))
        vs.append(row)
    bot = b.bm.verts.new(c - Vector((0, 0, ax[2] * 0.35)))
    for i in range(seg):
        i2 = (i + 1) % seg
        b._face((top, vs[0][i], vs[0][i2]), mat, smooth=True)
        for j in range(len(vs) - 1):
            b._face((vs[j][i], vs[j + 1][i], vs[j + 1][i2], vs[j][i2]), mat, smooth=True)
        b._face((vs[-1][i2], vs[-1][i], bot), mat, smooth=True)


def _metaball_snow(ob, blobs, mat, name):
    """Fuse the branch clumps into continuous lumpy snow (metaballs), convert to mesh, join into `ob`."""
    mb = bpy.data.metaballs.new(name + '_snowmb')
    mb.resolution = 0.022
    mb.render_resolution = 0.022
    mb.threshold = 0.6
    for c, tan, size, stretch, flat in blobs:
        e = mb.elements.new(type='ELLIPSOID')
        e.co = c
        e.radius = size * 1.25
        e.stiffness = 2.0
        e.size_x, e.size_y, e.size_z = stretch, 1.0, flat
        e.rotation = tan.to_track_quat('X', 'Z')
    mo = bpy.data.objects.new(name + '_snowmb', mb)
    # evaluate in the scene root: metaballs in a hidden collection evaluate to nothing
    bpy.context.scene.collection.objects.link(mo)
    dg = bpy.context.evaluated_depsgraph_get()
    dg.update()
    me = bpy.data.meshes.new_from_object(mo.evaluated_get(dg))
    bpy.data.objects.remove(mo)
    bpy.data.metaballs.remove(mb)
    me.materials.clear()
    me.materials.append(mat)
    for p in me.polygons:
        p.use_smooth = True
    # join: append geometry into the tree mesh with the snow material slot
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    slot = list(ob.data.materials).index(mat) if mat.name in ob.data.materials else None
    if slot is None:
        ob.data.materials.append(mat)
        slot = len(ob.data.materials) - 1
    off = len(bm.faces)
    bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    for f in bm.faces[off:]:
        f.material_index = slot
    bm.to_mesh(ob.data)
    bm.free()
    bpy.data.meshes.remove(me)
