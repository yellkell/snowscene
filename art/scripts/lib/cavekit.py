"""Geometry for the ice mine: the game's recorded works (art/work/cave_ref/cave_layout.json) rebuilt as
real construction, plus the pieces the game only implies (lanterns, bolts, deck planking).

Every recorded primitive keeps its place and never grows past its recorded envelope, so the clearances
the game's cave-build.ts worked out still hold: timbers become hewn larch with chamfered arrises and
end grain, iron rods become forged tie bars with eyes, rope rods become tarred hemp, rails get a real
flat-bottom profile.

Game (x, y, z) = Blender (x, -z, y). Group-local parts are built in their group's own frame.
"""
import bpy, bmesh, math, os, json, random
import numpy as np
from mathutils import Vector, Matrix
from mathutils.kdtree import KDTree
from . import core, cavemats as CM, snowmats as SM

ART = SM.ART
REF = os.path.join(ART, 'work', 'cave_ref')
WOOD_TILE_M = 1.5            # wood_planks_grey covers 1.5 m
DECK_TILE_M = 2.0


def layout():
    return json.load(open(os.path.join(REF, 'cave_layout.json')))


def gv(p):
    return Vector((p[0], -p[2], p[1]))


def gvec(x, y, z):
    return Vector((x, -z, y))


def m3(m16):
    """three.js column-major matrix -> (centre, col0, col1, col2) as game-space Vectors."""
    e = m16
    return (Vector((e[12], e[13], e[14])), Vector((e[0], e[1], e[2])), Vector((e[4], e[5], e[6])), Vector((e[8], e[9], e[10])))


def g2b(v):
    return Vector((v.x, -v.z, v.y))


# ---------------------------------------------------------------- builder with a wood UV layer
NO_WOOD = (-20.0, -20.0)      # WoodUV of a face that takes no wood detail at runtime
SMALL_IRON = (-30.0, -30.0)   # ... of a bolt, nut or nail head: drawn as iron, lit from what it's on


def _is_wood(mat):
    """Timber-like materials (the cave's larch, deck boards, rails, nosing)."""
    n = mat.name
    return any(k in n for k in ('timber', 'cave_deck', 'cave_rail', 'cave_nosing'))


class CB(core.Builder):
    """A Builder with a 'WoodUV' loop layer (one plank strip of the scan per timber face; NO_WOOD
    elsewhere) and a 'small' face flag for fittings too small for their own place in an atlas."""

    def __init__(self, name, coll, smooth_angle=30.0):
        super().__init__(name, coll, smooth_angle)
        self.wuv = self.bm.loops.layers.uv.new('WoodUV')
        self.sml = self.bm.faces.layers.float.new('small')
        self.small = 0.0

    def _face(self, verts, mat, uvs=None, rand=None, smooth=False):
        f = super()._face(verts, mat, uvs=uvs, rand=rand, smooth=smooth)
        if f is not None:
            f[self.sml] = self.small
            if not self.small and mat is not None and _is_wood(mat):
                self._grain(f)
            else:
                w = SMALL_IRON if self.small else NO_WOOD
                for l in f.loops:
                    l[self.wuv].uv = w
        return f

    def _grain(self, f):
        """Wood faces built from plain boxes (boards, cleats, the raft) get grain too: a plank strip of
        the scan laid along the face's longest edge, metric, a random strip and offset per face. (Hewn
        timbers lay their own, per face of the section, and overwrite this.)"""
        co = [l.vert.co for l in f.loops]
        n = f.normal
        t = max(((co[(i + 1) % len(co)] - co[i]) for i in range(len(co))), key=lambda e: e.length)
        if t.length < 1e-6:
            for l in f.loops:
                l[self.wuv].uv = NO_WOOD
            return
        t = (t - n * t.dot(n)).normalized()
        s = n.cross(t).normalized()
        c = sum(co, Vector()) / len(co)
        h = hash((round(c.x, 2), round(c.y, 2), round(c.z, 2)))
        u0, u1 = CM.PLANKS_GREY[h % 5]
        um, span = (u0 + u1) / 2, (u1 - u0) * 0.8
        voff = (h >> 3) % 997 / 997.0
        for l in f.loops:
            p = l.vert.co - c
            across = max(-span / 2, min(span / 2, p.dot(s) / WOOD_TILE_M))
            l[self.wuv].uv = (um + across, voff + p.dot(t) / WOOD_TILE_M)

    def wface(self, verts, mat, wuvs=None, uvs=None, smooth=False, flip=False):
        if flip:
            verts = list(verts)[::-1]
            uvs = list(uvs)[::-1] if uvs else uvs
            wuvs = list(wuvs)[::-1] if wuvs else wuvs
        f = self._face(verts, mat, uvs=uvs, smooth=smooth)
        if f is not None and wuvs:
            for l, uv in zip(f.loops, wuvs):
                l[self.wuv].uv = uv
        return f


def _frame_for(axis):
    """Side and up vectors for a timber along `axis` (Blender): one face looks up when it lies flat."""
    t = axis.normalized()
    ref = Vector((0, 0, 1)) if abs(t.z) < 0.92 else Vector((1, 0, 0))
    s = t.cross(ref).normalized()
    u = s.cross(t).normalized()
    return t, s, u


def hewn(b, p0, p1, w, h, rng, mat, mat_end, side=None, chamfer=None, plank=True, jitter=0.004, ends=(True, True),
         wear=0.0):
    """A hewn timber from p0 to p1 (Blender), cross-section w (along `side`) x h. Eight-sided (arrises
    chamfered), a little irregular along its length, grain along it (WoodUV: one plank strip per face)."""
    p0, p1 = Vector(p0), Vector(p1)
    axis = p1 - p0
    L = axis.length
    if L < 1e-4:
        return
    t, s, u = _frame_for(axis)
    if side is not None:
        s = (Vector(side) - t * Vector(side).dot(t)).normalized()
        u = s.cross(t).normalized()
    c = chamfer if chamfer is not None else min(w, h) * rng.uniform(0.08, 0.16)
    c = min(c, min(w, h) * 0.3)
    hw, hh = w / 2, h / 2
    prof = [(-hw + c, -hh), (hw - c, -hh), (hw, -hh + c), (hw, hh - c), (hw - c, hh), (-hw + c, hh), (-hw, hh - c), (-hw, -hh + c)]
    # face widths for UV (metres)
    nseg = max(1, int(L / 0.9))
    rings = []
    tw = rng.uniform(-0.01, 0.01)
    for i in range(nseg + 1):
        f = i / nseg
        pc = p0 + axis * f
        j = jitter if 0 < i < nseg else jitter * 0.5
        ox, oy = rng.uniform(-j, j), rng.uniform(-j, j)
        sc = 1 + rng.uniform(-0.025, 0.025)
        ang = tw * f
        ca, sa = math.cos(ang), math.sin(ang)
        ring = []
        for (x, y) in prof:
            x2, y2 = (x * ca - y * sa) * sc + ox, (x * sa + y * ca) * sc + oy
            ring.append(b.bm.verts.new(pc + s * x2 + u * y2))
        rings.append(ring)
    n = len(prof)
    # each face: a random plank strip of the scan, v along the timber
    for k in range(n):
        k2 = (k + 1) % n
        a, c2 = prof[k], prof[k2]
        fw = math.hypot(c2[0] - a[0], c2[1] - a[1])
        strip = rng.randrange(5)
        u0, u1 = CM.PLANKS_GREY[strip]
        um = (u0 + u1) / 2
        span = (u1 - u0) * 0.8
        fu = min(fw / WOOD_TILE_M, span)
        voff = rng.uniform(0, 1)
        ua, ub = um - fu / 2, um + fu / 2
        for i in range(nseg):
            va = voff + (L * i / nseg) / WOOD_TILE_M
            vb = voff + (L * (i + 1) / nseg) / WOOD_TILE_M
            b.wface((rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]), mat,
                    wuvs=((ua, va), (ub, va), (ub, vb), (ua, vb)),
                    uvs=((0, va), (1, va), (1, vb), (0, vb)), flip=True)
    if ends[0]:
        b.wface(list(reversed(rings[0])), mat_end, flip=True)
    if ends[1]:
        b.wface(rings[-1], mat_end, flip=True)


def hewn_path(b, pts, w, h, rng, mat, mat_end, side, chamfer=None, ends=(True, True)):
    """A hewn timber swept along a polyline (a curved felloe, a bent rail): one continuous piece, its
    cross-section turned with the curve, so a bend never opens a wedge the way butted straight pieces do."""
    pts = [Vector(p) for p in pts]
    if len(pts) < 2:
        return
    c = chamfer if chamfer is not None else min(w, h) * rng.uniform(0.08, 0.16)
    c = min(c, min(w, h) * 0.3)
    hw, hh = w / 2, h / 2
    prof = [(-hw + c, -hh), (hw - c, -hh), (hw, -hh + c), (hw, hh - c), (hw - c, hh), (-hw + c, hh), (-hw, hh - c), (-hw, -hh + c)]
    rings, dist = [], [0.0]
    for i, p in enumerate(pts):
        tn = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        s = (Vector(side) - tn * Vector(side).dot(tn)).normalized()
        u = s.cross(tn).normalized()
        sc = 1 + rng.uniform(-0.015, 0.015)
        rings.append([b.bm.verts.new(p + s * (x * sc) + u * (y * sc)) for (x, y) in prof])
        if i:
            dist.append(dist[-1] + (p - pts[i - 1]).length)
    n = len(prof)
    for k in range(n):
        k2 = (k + 1) % n
        a, c2 = prof[k], prof[k2]
        fw = math.hypot(c2[0] - a[0], c2[1] - a[1])
        u0, u1 = CM.PLANKS_GREY[rng.randrange(5)]
        um, span = (u0 + u1) / 2, (u1 - u0) * 0.8
        fu = min(fw / WOOD_TILE_M, span)
        voff = rng.uniform(0, 1)
        ua, ub = um - fu / 2, um + fu / 2
        for i in range(len(pts) - 1):
            va, vb = voff + dist[i] / WOOD_TILE_M, voff + dist[i + 1] / WOOD_TILE_M
            b.wface((rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]), mat,
                    wuvs=((ua, va), (ub, va), (ub, vb), (ua, vb)), uvs=((0, va), (1, va), (1, vb), (0, vb)), flip=True)
    if ends[0]:
        b.wface(list(reversed(rings[0])), mat_end, flip=True)
    if ends[1]:
        b.wface(rings[-1], mat_end, flip=True)


def board(b, p0, p1, w, h, rng, mat, mat_end, side=None):
    hewn(b, p0, p1, w, h, rng, mat, mat_end, side=side, chamfer=min(w, h) * 0.12, jitter=0.002)


def cylinder(b, p0, p1, r, mat, sides=10, r1=None, caps=True, smooth=True, uv_len=True):
    """Round bar/tube with UVMap u round it (0..1) and v along it in metres."""
    p0, p1 = Vector(p0), Vector(p1)
    ax = p1 - p0
    L = ax.length
    if L < 1e-5:
        return
    t, s, u = _frame_for(ax)
    r1 = r if r1 is None else r1
    ring0 = [b.bm.verts.new(p0 + (s * math.cos(2 * math.pi * i / sides) + u * math.sin(2 * math.pi * i / sides)) * r) for i in range(sides)]
    ring1 = [b.bm.verts.new(p1 + (s * math.cos(2 * math.pi * i / sides) + u * math.sin(2 * math.pi * i / sides)) * r1) for i in range(sides)]
    for i in range(sides):
        j = (i + 1) % sides
        b.wface((ring0[i], ring0[j], ring1[j], ring1[i]), mat,
                uvs=((i / sides, 0), ((i + 1) / sides, 0), ((i + 1) / sides, L), (i / sides, L)), smooth=smooth, flip=True)
    if caps:
        b.wface(list(reversed(ring0)), mat, flip=True)
        if r1 > 1e-5:
            b.wface(ring1, mat, flip=True)


def tube(b, pts, r, mat, sides=8, smooth=True):
    """A tube along a polyline, UVMap u round (0..1), v along in metres (rope/cable)."""
    pts = [Vector(p) for p in pts]
    n = len(pts)
    if n < 2:
        return
    tang = []
    for i in range(n):
        if i == 0:
            tv = pts[1] - pts[0]
        elif i == n - 1:
            tv = pts[-1] - pts[-2]
        else:
            tv = (pts[i + 1] - pts[i]).normalized() + (pts[i] - pts[i - 1]).normalized()
        tang.append(tv.normalized())
    ref = Vector((0, 0, 1)) if abs(tang[0].z) < 0.9 else Vector((1, 0, 0))
    nrm = tang[0].cross(ref).normalized()
    rings, acc = [], 0.0
    vs = []
    for i in range(n):
        tv = tang[i]
        nrm = (nrm - tv * nrm.dot(tv)).normalized()
        bn = tv.cross(nrm)
        if i:
            acc += (pts[i] - pts[i - 1]).length
        vs.append(acc)
        rings.append([b.bm.verts.new(pts[i] + (nrm * math.cos(2 * math.pi * k / sides) + bn * math.sin(2 * math.pi * k / sides)) * r) for k in range(sides)])
    for i in range(n - 1):
        for k in range(sides):
            k2 = (k + 1) % sides
            b.wface((rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]), mat,
                    uvs=((k / sides, vs[i]), ((k + 1) / sides, vs[i]), ((k + 1) / sides, vs[i + 1]), (k / sides, vs[i + 1])), smooth=smooth)
    b.wface(list(reversed(rings[0])), mat)
    b.wface(rings[-1], mat)


def box_iron(b, c, axes, mat, bev=0.004):
    """An iron block: centre + three half-axis vectors (Blender)."""
    c = Vector(c)
    a0, a1, a2 = (Vector(a) for a in axes)
    R = Matrix((a0.normalized(), a1.normalized(), a2.normalized())).transposed()
    b.cbox(c, (a0.length * 2, a1.length * 2, a2.length * 2), mat, bev=min(bev, a0.length * 0.4, a1.length * 0.4, a2.length * 0.4), R_=R)


def bolt(b, p, n, mat, size=0.022, washer=True, nut=False):
    """A square-headed bolt (or a square nut) on a square washer, on a face at p with outward normal n.
    Kept to two plain blocks: there are a thousand of them."""
    small, b.small = b.small, 1.0
    n = Vector(n).normalized()
    s = n.orthogonal().normalized()
    u = n.cross(s)
    k = 0.0
    if washer:
        R = Matrix((s, u, n)).transposed() @ Matrix.Rotation(0.15, 3, 'Z')
        b.box(Vector(p) + n * 0.003, (size * 2.4, size * 2.4, 0.006), mat, R_=R, skip=(0,))
        k = 0.006
    R = Matrix((s, u, n)).transposed() @ Matrix.Rotation(0.785 if nut else 0.3, 3, 'Z')
    b.box(Vector(p) + n * (k + size * 0.32), (size * 1.3, size * 1.3, size * 0.64), mat, R_=R, skip=(0,))
    b.small = small


def strap(b, center, axis_along, normal, length, width, mat, thick=0.006, bolts=2):
    """A flat forged strap lying on a face, with bolts through it."""
    t = Vector(axis_along).normalized()
    n = Vector(normal).normalized()
    s = n.cross(t).normalized()
    R = Matrix((t, s, n)).transposed()
    b.cbox(Vector(center) + n * thick / 2, (length, width, thick), mat, bev=0.0015, R_=R)
    for k in range(bolts):
        f = (k + 0.5) / bolts - 0.5
        bolt(b, Vector(center) + t * f * length * 0.8 + n * thick, n, mat, size=0.016, washer=False)


# ---------------------------------------------------------------- shapes for the recorded primitives
def mine_wheel(b, c, axis, r, w, mat):
    """A flanged cast-iron mine-car wheel: tread, flange on the inside, dished web, hub."""
    ax = Vector(axis).normalized()
    base = Vector(c) - ax * w / 2
    prof = [(r * 0.25, 0.0), (r * 0.98, 0.0), (r, w * 0.15), (r, w * 0.8), (r * 1.18, w * 0.85), (r * 1.18, w), (r * 0.9, w),
            (r * 0.7, w * 0.7), (r * 0.3, w * 0.75), (r * 0.25, w * 1.3), (0.0, w * 1.3)]
    b.lathe(prof, base, ax, mat, seg=16, smooth=True, cap0=True)


def sheave(b, c, axis, r, w, mat):
    """A grooved pulley sheave with a dished web and a boss."""
    ax = Vector(axis).normalized()
    base = Vector(c) - ax * w / 2
    prof = [(r * 0.2, -w * 0.3), (r * 0.2, 0.0), (r * 0.8, w * 0.25), (r * 0.97, 0.0), (r * 1.0, 0.0), (r * 1.0, w * 0.15),
            (r * 0.86, w * 0.5), (r * 1.0, w * 0.85), (r * 1.0, w), (r * 0.97, w), (r * 0.8, w * 0.75), (r * 0.2, w), (r * 0.2, w * 1.3), (0, w * 1.3)]
    b.lathe(prof, base, ax, mat, seg=20, smooth=True, cap0=True)


def log(b, p0, p1, r, rng, mat, mat_end):
    """A barked-off round log, a little tapered and knobbly, end grain at both ends."""
    p0, p1 = Vector(p0), Vector(p1)
    ax = p1 - p0
    L = ax.length
    t, s, u = _frame_for(ax)
    n, sides = max(2, int(L / 0.2) + 1), 12
    rings = []
    taper = rng.uniform(0.85, 0.95)
    for i in range(n):
        f = i / (n - 1)
        rr = r * (1 + (taper - 1) * f)
        ring = []
        for k in range(sides):
            a = 2 * math.pi * k / sides
            wob = 1 + 0.035 * math.sin(a * 3 + i * 1.7 + r * 50) + rng.uniform(-0.015, 0.015)
            ring.append(b.bm.verts.new(p0 + ax * f + (s * math.cos(a) + u * math.sin(a)) * rr * wob))
        rings.append(ring)
    for i in range(n - 1):
        for k in range(sides):
            k2 = (k + 1) % sides
            va, vb = L * i / (n - 1) / WOOD_TILE_M, L * (i + 1) / (n - 1) / WOOD_TILE_M
            ua, ub = 0.2 + 0.18 * k / sides, 0.2 + 0.18 * (k + 1) / sides
            b.wface((rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]), mat, wuvs=((ua, va), (ub, va), (ub, vb), (ua, vb)), smooth=True, flip=True)
    b.wface(list(reversed(rings[0])), mat_end, flip=True)
    b.wface(rings[-1], mat_end, flip=True)


def rail_profile(b, p0, p1, up, mat, scale=1.0):
    """A flat-bottom (Vignoles) rail along p0 -> p1, centred on the recorded bar."""
    p0, p1 = Vector(p0), Vector(p1)
    t = (p1 - p0).normalized()
    up = (Vector(up) - t * Vector(up).dot(t)).normalized()
    s = t.cross(up).normalized()
    k = scale
    prof = [(-0.026, -0.022), (0.026, -0.022), (0.026, -0.017), (0.006, -0.012), (0.005, 0.012), (0.014, 0.015),
            (0.014, 0.023), (-0.014, 0.023), (-0.014, 0.015), (-0.005, 0.012), (-0.006, -0.012), (-0.026, -0.017)]
    rings = [[b.bm.verts.new(p + s * x * k + up * y * k) for (x, y) in prof] for p in (p0, p1)]
    L = (p1 - p0).length
    n = len(prof)
    for kk in range(n):
        k2 = (kk + 1) % n
        b.wface((rings[0][kk], rings[0][k2], rings[1][k2], rings[1][kk]), mat, uvs=((0, 0), (1, 0), (1, L), (0, L)), flip=True)
    b.wface(list(reversed(rings[0])), mat, flip=True)
    b.wface(rings[1], mat, flip=True)


class Works:
    """Turns recorded primitives into construction. `timbers` collects every hewn piece for jointing."""
    dump = []      # debug: solved joints (JOINERY_DUMP)

    def __init__(self, b, rng, M):
        self.b, self.rng, self.M = b, rng, M
        self.timbers = []     # (p0, p1, half_w, half_h, side, up) - bolted where they bear on another
        self.pending = []     # every member, built by flush() once its joints are solved

    def timber(self, p0, p1, w, h, side=None, mat='timber', joint=True, seat=True):
        """Record a hewn member; flush() seats its ends into whatever it meets, then builds it."""
        self.pending.append(dict(p0=Vector(p0), p1=Vector(p1), w=w, h=h, side=side, mat=mat, joint=joint, seat=seat))

    def flush(self):
        """Joinery. The game's primitives end where its boxes ended, a few centimetres shy of what they
        bear on, and the hewing (chamfers, a few per cent of swell, jitter) opens that further: every end
        that comes near another member's body is carried into it - to that member's centreline, so it
        reads as housed, mortised or notched over - and ends that meet end to end are butted tight."""
        P = self.pending
        if not P:
            return 0
        segs = []
        for q in P:
            a, c = q['p0'], q['p1']
            L = (c - a).length
            if L < 1e-4:
                segs.append(None)
                continue
            segs.append((a.copy(), c.copy(), (c - a) / L, max(q['w'], q['h']) / 2, min(q['w'], q['h']) / 2))
        n_pts = sum(max(2, int((s[1] - s[0]).length / 0.04) + 1) for s in segs if s)
        kd = KDTree(max(1, n_pts))
        owner = []
        k = 0
        for i, s in enumerate(segs):
            if not s:
                continue
            n = max(2, int((s[1] - s[0]).length / 0.04) + 1)
            for j in range(n):
                kd.insert(s[0].lerp(s[1], j / (n - 1)), k)
                owner.append(i)
                k += 1
        kd.balance()
        moved = 0
        REACH = 0.32
        for i, (q, s) in enumerate(zip(P, segs)):
            if not s or not q['seat']:
                continue
            a, c, d, big, small = s
            for end_i, (E, out) in enumerate(((a, -d), (c, d))):
                best = None
                seen = set()
                for (co, idx, dist) in kd.find_range(E, REACH + 0.25):
                    j = owner[idx]
                    if j == i or j in seen:
                        continue
                    seen.add(j)
                    a2, c2, d2, big2, small2 = segs[j]
                    # closest point on member j to the ray from this end outward
                    w0 = E - a2
                    bb = out.dot(d2)
                    dd_, ee = out.dot(w0), d2.dot(w0)
                    L2 = (c2 - a2).length
                    den = 1 - bb * bb
                    if den < 1e-4:
                        # parallel: butt end to end if they're on one line
                        near = a2 if (a2 - E).length < (c2 - E).length else c2
                        off = near - E
                        along = off.dot(out)
                        lateral = (off - out * along).length
                        if -0.01 < along < 0.12 and lateral < small * 0.6:
                            ext = along
                        else:
                            continue
                    else:
                        # where the two axes pass closest (infinite lines)
                        tr_l = (bb * ee - dd_) / den
                        tj_l = (ee - bb * dd_) / den
                        if -0.02 <= tj_l <= L2 + 0.02:
                            # a T: our end runs into its span - bear on it, to its centreline
                            tj = min(max(tj_l, 0.0), L2)
                            Q = a2 + d2 * tj
                            tr = (Q - E).dot(out)
                            lateral = (Q - (E + out * tr)).length
                            if lateral > big2 + small * 0.5 or tr < -(big2 + 0.02) or tr > REACH:
                                continue
                            ext = tr
                        else:
                            # a corner: both ends near each other at an angle (a bent rail, a frame
                            # corner) - carry ours to where the axes cross, a little past, so the
                            # outside of the bend closes instead of opening a wedge
                            nearB = a2 if abs(tj_l) < abs(tj_l - L2) else c2
                            if (nearB - E).length > max(big, big2) * 2 + 0.06 or abs(bb) > 0.985:
                                continue
                            X_ = E + out * tr_l
                            Y_ = a2 + d2 * tj_l
                            if (X_ - Y_).length > big2 + small or not (-0.02 < tr_l < 0.3):
                                continue
                            ext = tr_l + small * 0.6
                    if best is None or abs(ext) < abs(best):
                        best = ext
                if best is not None and best > 0.003:
                    if end_i == 0:
                        q['p0'] = a + (-d) * best
                    else:
                        q['p1'] = c + d * best
                    moved += 1
                if best is not None and os.environ.get('JOINERY_DUMP'):
                    J = (q['p0'] if end_i == 0 else q['p1'])
                    Works.dump.append({'p': list(J), 'd': list(out), 'w': q['w'], 'group': getattr(self.b, 'name', ''),
                                       'ext': float(best)})
        if os.environ.get('JOINERY_REPORT'):
            self._report(P)
        M = self.M
        for q in P:
            hewn(self.b, q['p0'], q['p1'], q['w'], q['h'], self.rng, M[q['mat']], M['endgrain'], side=q['side'])
            if q['joint'] and (q['p1'] - q['p0']).length > 0.25:
                t_, s_, u_ = _frame_for(q['p1'] - q['p0'])
                if q['side'] is not None:
                    s_ = (Vector(q['side']) - t_ * Vector(q['side']).dot(t_)).normalized()
                    u_ = s_.cross(t_).normalized()
                self.timbers.append((q['p0'], q['p1'], q['w'] / 2, q['h'] / 2, s_, u_))
        self.pending = []
        return moved

    def part(self, p, skip_wood_torus=True):
        M, b, rng = self.M, self.b, self.rng
        typ, mat, prm = p['type'], p['mat'], p['params']
        c, x, y, z = m3(p['matrix'])
        cb = g2b(c)
        wood = mat.startswith('wood')
        if typ == 'BoxGeometry':
            ax = [x * prm['width'] / 2, y * prm['height'] / 2, z * prm['depth'] / 2]
            lens = [a.length for a in ax]
            order = sorted(range(3), key=lambda i: -lens[i])
            L, A, B = order
            a_l = g2b(ax[L])
            upright = abs(a_l.normalized().z) > 0.8
            if wood or (mat == 'rope' and upright):
                # a flat, wide piece (a deck slab, the plinth) is planked
                if lens[B] < 0.07 and lens[A] > 0.25 and lens[L] > 0.25:
                    self.planked(cb, [g2b(a) for a in ax], order)
                    return
                kind = 'rail' if mat in ('wood_pale', 'rope') else ('timber_dark' if mat == 'wood_dark' else 'timber')
                self.timber(cb - a_l, cb + a_l, lens[A] * 2, lens[B] * 2, side=g2b(ax[A]), mat=kind)
            elif mat == 'rope':
                # a rope rail, hung between its posts with a little sag
                p0, p1 = cb - a_l, cb + a_l
                sag = min(0.03, (p1 - p0).length * 0.04)
                pts = [p0.lerp(p1, i / 8) - Vector((0, 0, 4 * sag * (i / 8) * (1 - i / 8))) for i in range(9)]
                tube(b, pts, min(lens[A], lens[B]) * 0.7, M['rope'], sides=8)
            elif mat == 'steel':
                # run each length a few centimetres on, so where the track bends the rail stays whole
                ov = a_l.normalized() * 0.035
                rail_profile(b, cb - a_l - ov, cb + a_l + ov, Vector((0, 0, 1)), M['steel'])
            else:
                box_iron(b, cb, [g2b(a) for a in ax], M['iron'])
        elif typ == 'CylinderGeometry':
            r = prm['radiusTop'] * x.length
            hh = prm['height'] * y.length / 2
            a_ = g2b(y.normalized() * hh)
            p0, p1 = cb - a_, cb + a_
            segs = prm['radialSegments']
            long_ = hh * 2 > r * 3
            if wood:
                if segs >= 8:
                    log(b, p0, p1, r, rng, M['timber'], M['endgrain'])
                else:
                    side = r * 2 * 0.85
                    self.timber(p0, p1, side, side, mat='timber_dark' if mat == 'wood_dark' else 'timber')
            elif mat == 'rope':
                if cb.z > 2.0:
                    tube(b, [p0, p1], r * 0.9, M['wire'], sides=8)
                else:
                    pts = [p0.lerp(p1, i / 24) - Vector((0, 0, 0.12 * 4 * (i / 24) * (1 - i / 24))) for i in range(25)]
                    tube(b, pts, r, M['rope'], sides=8)
            elif mat in ('iron', 'brass'):
                mm = M['iron'] if mat == 'iron' else M['brass']
                if long_ and segs <= 6:
                    cylinder(b, p0, p1, r * 0.7, mm, sides=8)
                elif r > 0.15:
                    sheave(b, cb, p1 - p0, r, hh * 2, mm)
                elif r > 0.07 and hh < r:
                    mine_wheel(b, cb, p1 - p0, r * 0.92, hh * 2, mm)
                else:
                    cylinder(b, p0, p1, r, mm, sides=12)
            # 'other' (torch bits) are drawn by their own builders
        elif typ == 'TorusGeometry':
            if wood and skip_wood_torus:
                return
            R, tr = prm['radius'], prm['tube']
            sc = x.length
            nrm = g2b(z).normalized()
            s_ = g2b(x).normalized()
            u_ = nrm.cross(s_)
            pts = [cb + (s_ * math.cos(2 * math.pi * i / 16) + u_ * math.sin(2 * math.pi * i / 16)) * R * sc for i in range(17)]
            tube(b, pts, tr * sc * 0.9, M['iron'], sides=6)

    def _report(self, P):
        """Debug: every end still short of its nearest member (surface to surface, 5 mm - 40 cm)."""
        def seg_dist(p, a, c):
            ab = c - a
            t_ = max(0.0, min(1.0, (p - a).dot(ab) / max(ab.dot(ab), 1e-9)))
            return (a + ab * t_ - p).length
        bad = 0
        for i, q in enumerate(P):
            if not q['seat']:
                continue
            for E in (q['p0'], q['p1']):
                best = 9.0
                for j, r in enumerate(P):
                    if j == i:
                        continue
                    d = seg_dist(E, r['p0'], r['p1']) - max(r['w'], r['h']) / 2
                    best = min(best, d)
                gap = best - min(q['w'], q['h']) / 2
                if 0.005 < gap < 0.4:
                    bad += 1
                    if bad <= 40:
                        print(f'GAP {self.b.name if hasattr(self.b, "name") else ""} {gap:.3f} m at {tuple(round(v, 2) for v in E)} w{q["w"]:.2f} {q["mat"]}', flush=True)
        print(f'GAPS {bad} of {2 * len(P)} ends', flush=True)

    def planked(self, c, ax, order):
        """A flat slab as boards laid side by side (along its longer side), a finger's gap between."""
        L, A, T = order
        along, across, thick = ax[L], ax[A], ax[T]
        n = max(2, int(round(across.length * 2 / 0.15)))
        w = across.length * 2 / n
        for i in range(n):
            f = (i + 0.5) / n * 2 - 1
            cc = c + across * f
            self.timber(cc - along, cc + along, w - 0.012, thick.length * 2, side=across, mat='timber_dark', joint=False, seat=False)

    def joints(self, mat, protect=None):
        """Bolts where timbers meet: near each end of a timber that bears on another, a through-bolt with a
        washer and head on one face and a nut on the other. `protect(p)` -> False skips a spot."""
        self.flush()
        T = self.timbers
        if not T:
            return 0
        total = sum(max(2, int((t[1] - t[0]).length / 0.05) + 1) for t in T)
        kd = KDTree(total)
        owner = []
        idx = 0
        for ti, (p0, p1, hw, hh, s, u) in enumerate(T):
            n = max(2, int((p1 - p0).length / 0.05) + 1)
            for k in range(n):
                kd.insert(p0.lerp(p1, k / (n - 1)), idx)
                owner.append(ti)
                idx += 1
        kd.balance()
        count = 0
        for ti, (p0, p1, hw, hh, s, u) in enumerate(T):
            L = (p1 - p0).length
            tdir = (p1 - p0).normalized()
            for end, sign in ((p0, 1), (p1, -1)):
                q = end + tdir * sign * min(L * 0.3, max(hw, hh) + 0.04)
                hit = None
                for (co, i, d) in kd.find_range(q, max(hw, hh) + 0.1):
                    if owner[i] != ti:
                        hit = owner[i]
                        break
                if hit is None:
                    continue
                if protect is not None and not protect(q):
                    continue
                n_ = s if hw <= hh else u
                half = hw if hw <= hh else hh
                bolt(self.b, q + n_ * half, n_, mat, size=0.018)
                bolt(self.b, q - n_ * half, -n_, mat, size=0.018, nut=True)
                count += 1
        return count


# ---------------------------------------------------------------- the pieces the game only implies
def deck_tile(name, coll, M, seed=3, tile=0.6):
    """One deck square (game tile 0.6 m, top at 0): five weathered boards across two bearers, a pale worn
    oak nosing round the edge with an iron angle strip on it, nail heads. Built centred at the origin."""
    rng = random.Random(seed)
    b = CB(name, coll, smooth_angle=35)
    h = tile / 2
    thick = 0.045
    nose = 0.045
    inner = h - nose
    n = 5
    w = inner * 2 / n
    for i in range(n):
        y0 = -inner + w * (i + 0.5)
        dz = rng.uniform(-0.003, 0.0)
        hewn(b, Vector((-inner + 0.002, y0, -thick / 2 + dz)), Vector((inner - 0.002, y0, -thick / 2 + dz)), w - 0.008, thick,
             rng, M['deck'], M['endgrain'], side=Vector((0, 1, 0)), chamfer=0.004, jitter=0.0015)
        for x in (-inner + 0.06, inner - 0.06):
            for yy in (y0 - w * 0.25, y0 + w * 0.25):
                b.small = 1.0
                cylinder(b, Vector((x, yy, dz - 0.0005)), Vector((x, yy, dz + 0.002)), 0.0045, M['iron'], sides=5, caps=False)
                b.small = 0.0
    # nosing: four pale rails mitred at the corners (as overlapping boards)
    for (a, c, side) in (((-h, -h + nose / 2), (h, -h + nose / 2), (0, 1, 0)), ((-h, h - nose / 2), (h, h - nose / 2), (0, 1, 0)),
                         ((-h + nose / 2, -h + nose), (-h + nose / 2, h - nose), (1, 0, 0)), ((h - nose / 2, -h + nose), (h - nose / 2, h - nose), (1, 0, 0))):
        hewn(b, Vector((a[0], a[1], -0.03)), Vector((c[0], c[1], -0.03)), nose - 0.002, 0.06, rng, M['nosing'], M['endgrain'],
             side=Vector(side), chamfer=0.008, jitter=0.001)
    # iron angle strip on the outer arris of the nosing, countersunk screws
    for k in range(4):
        ang = k * math.pi / 2
        R = Matrix.Rotation(ang, 3, 'Z')
        p0 = R @ Vector((-h, -h - 0.002, -0.012))
        p1 = R @ Vector((h, -h - 0.002, -0.012))
        box_iron(b, (p0 + p1) / 2, [(p1 - p0) / 2, R @ Vector((0, 0.002, 0)), Vector((0, 0, 0.012))], M['iron'], bev=0.001)
        top = R @ Vector((0, -h + 0.009, 0.0015))
        box_iron(b, top, [(p1 - p0) / 2 * 0.985, R @ Vector((0, 0.011, 0)), Vector((0, 0, 0.0015))], M['iron'], bev=0.0008)
        for f in (-0.38, 0.0, 0.38):
            q = R @ Vector((f * tile, -h + 0.009, 0.0032))
            b.small = 1.0
            cylinder(b, q - Vector((0, 0, 0.0005)), q + Vector((0, 0, 0.0008)), 0.0038, M['iron'], sides=5, caps=False)
            b.small = 0.0
    # bearers under the boards
    for x in (-h * 0.62, h * 0.62):
        hewn(b, Vector((x, -h + 0.02, -0.075)), Vector((x, h - 0.02, -0.075)), 0.06, 0.06, rng, M['timber_dark'], M['endgrain'],
             side=Vector((1, 0, 0)))
    return b.finish(merge=False)


def lantern_src(M):
    """The Poly Haven hurricane lantern (12 x 29 cm), its brass tarnished black-brown, its globe our lit
    glass, a flame inside. Returns (collection, flame height above its base)."""
    from . import scene as S
    c = bpy.data.collections.get('V_lantern')
    if c:
        return c, c['flame_z']
    objs = S.import_model('Lantern_01')
    body = next((o for o in objs if 'glass' not in o.name.lower()), objs[0])
    others = [o for o in objs if o is not body]
    before = body.matrix_world.copy()
    c = S.variant_collection(body, 'V_lantern')
    T = body.matrix_world @ before.inverted()
    for o in others:
        for uc in list(o.users_collection):
            uc.objects.unlink(o)
        o.matrix_world = T @ o.matrix_world
        c.objects.link(o)
    flame_z = 0.1
    for o in objs:
        if 'glass' in o.name.lower():
            o.data.materials.clear()
            o.data.materials.append(M['lantern_glass'])
            # the globe glows but lets its flame's light out
            o.visible_shadow = False
            zs = [(o.matrix_world @ v.co).z for v in o.data.vertices]
            flame_z = min(zs) + (max(zs) - min(zs)) * 0.4
        else:
            for m in o.data.materials:
                if m and m.node_tree and not m.get('graded'):
                    _tarnish(m)
                    m['graded'] = True
    # the flame: a small teardrop of light
    fb = CB('lantern_flame', c)
    fb.lathe([(0.0, 0.0), (0.006, 0.004), (0.007, 0.012), (0.004, 0.022), (0.0, 0.032)], Vector((0, 0, flame_z - 0.016)), Vector((0, 0, 1)),
             M['lantern_flame'], seg=8)
    fl = fb.finish(merge=True)
    fl.visible_shadow = False
    c['flame_z'] = flame_z
    return c, flame_z


def _tarnish(m):
    """Push an imported brass material toward old, smoked, rusty tin-plate."""
    nt = m.node_tree
    bsdf = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if bsdf is None:
        return
    src = bsdf.inputs['Base Color'].links[0].from_socket if bsdf.inputs['Base Color'].links else None
    hsv = nt.nodes.new('ShaderNodeHueSaturation')
    hsv.inputs['Saturation'].default_value = 0.55
    hsv.inputs['Value'].default_value = 0.45
    if src is not None:
        nt.links.new(src, hsv.inputs['Color'])
    else:
        hsv.inputs['Color'].default_value = bsdf.inputs['Base Color'].default_value
    nt.links.new(hsv.outputs[0], bsdf.inputs['Base Color'])
    if bsdf.inputs['Metallic'].links:
        nt.links.remove(bsdf.inputs['Metallic'].links[0])
    bsdf.inputs['Metallic'].default_value = 0.35
    if bsdf.inputs['Roughness'].links:
        nt.links.remove(bsdf.inputs['Roughness'].links[0])
    bsdf.inputs['Roughness'].default_value = 0.55


def point_light(name, at, power, color, radius, coll, channel):
    ld = bpy.data.lights.new(name, 'POINT')
    ld.energy = power
    ld.color = color
    ld.shadow_soft_size = radius
    o = bpy.data.objects.new(name, ld)
    o.location = at
    o['channel'] = channel
    o['power'] = power
    coll.objects.link(o)
    return o


def separate_pieces(objs):
    """Two pieces' faces in one plane flicker in the headset (the depth test flips between them frame to
    frame): rails overlapping at their joins, a handrail flush with the post it meets, a cleat on a beam.
    Every piece (loose part) grows by a hair along its vertex normals, one of six levels, 1 to 6 mm; pieces
    that have faces in a common plane in the same place (the only ones that can fight) always get different
    levels (a greedy colouring of that graph), so flush faces end at least a millimetre apart, well inside
    what the depth buffer resolves (zfight_scan.py checks)."""
    import bmesh
    from collections import defaultdict
    LEVELS = [0.001 * (k + 1) for k in range(6)]
    ANG, PLANE, CELL = 0.01, 0.0006, 1.0
    parts = []          # list of vertex lists
    owner = {}          # (object index, vertex index) -> part
    meshes = []
    buckets = defaultdict(set)
    for oi, ob in enumerate(objs):
        if ob.type != 'MESH':
            continue
        bm = bmesh.new()
        bm.from_mesh(ob.data)
        bm.normal_update()
        meshes.append((ob, bm))
        seen = set()
        for v0 in bm.verts:
            if v0.index in seen:
                continue
            stack, part = [v0], []
            seen.add(v0.index)
            while stack:
                v = stack.pop()
                part.append(v)
                owner[(oi, v.index)] = len(parts)
                for e in v.link_edges:
                    w = e.other_vert(v)
                    if w.index not in seen:
                        seen.add(w.index)
                        stack.append(w)
            parts.append(part)
        mw = ob.matrix_world
        nm = mw.to_3x3().inverted().transposed()
        for f in bm.faces:
            if f.calc_area() < 1e-8:
                continue
            n = (nm @ f.normal).normalized()
            c = mw @ f.calc_center_median()
            d = n.dot(c)
            key = (round(n.x / ANG), round(n.y / ANG), round(n.z / ANG), round(d / PLANE),
                   int(c.x // CELL), int(c.y // CELL), int(c.z // CELL))
            buckets[key].add(owner[(oi, f.verts[0].index)])
    nbr = defaultdict(set)
    for ps in buckets.values():
        if len(ps) > 1:
            for a in ps:
                nbr[a] |= ps - {a}
    level = [-1] * len(parts)
    short = 0
    for i in sorted(range(len(parts)), key=lambda i: -len(nbr[i])):
        used = {level[j] for j in nbr[i] if level[j] >= 0}
        free = [k for k in range(len(LEVELS)) if k not in used]
        if not free:
            short += 1
        level[i] = free[0] if free else i % len(LEVELS)
    for part, lv in zip(parts, level):
        h = LEVELS[lv]
        for v in part:
            v.co += v.normal * h
    for ob, bm in meshes:
        bm.to_mesh(ob.data)
        bm.free()
    print('flush faces separated:', len(parts), 'pieces,', sum(1 for i in nbr if nbr[i]), 'in contact;', short, 'ran out of levels', flush=True)
