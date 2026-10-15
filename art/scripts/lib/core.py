"""v2 geometry core: builders, facade frames, lathe/sweep/prism/chamfer primitives, text.

Conventions: Blender Z-up metres. Every Builder writes two UV layers:
  UVMap   - element-local UVs (0..1 panels, metre box UVs, lathe u/v)
  WorldUV - metric cube projection computed at finish(), used by tiling PBR materials
plus face attributes 'rand' (0..1 per element) for shader variation.
"""
import bpy, bmesh, math, random
import numpy as np
from mathutils import Vector, Matrix

Z = Vector((0, 0, 1))
X = Vector((1, 0, 0))
Y = Vector((0, 1, 0))
UV01 = ((0, 0), (1, 0), (1, 1), (0, 1))
FONT_JP = r"C:\Windows\Fonts\YuGothB.ttc"
FONT_JP_M = r"C:\Windows\Fonts\YuGothM.ttc"
FONT_MIN = r"C:\Windows\Fonts\msgothic.ttc"
FONT_EN = r"C:\Windows\Fonts\bahnschrift.ttf"
FONT_IMPACT = r"C:\Windows\Fonts\impact.ttf"
FONT_ARIALB = r"C:\Windows\Fonts\arialbd.ttf"

R = random.Random(1)


def seed(s):
    R.seed(s)


def V(*a):
    return Vector(a[0] if len(a) == 1 else a)


def get_coll(name, parent=None):
    c = bpy.data.collections.get(name)
    if c is None:
        c = bpy.data.collections.new(name)
        (parent or bpy.context.scene.collection).children.link(c)
    return c


def frame(p, normal, up=None):
    """4x4: local XY plane -> plane at p facing normal; local +X = viewer's right, +Y = up."""
    n = Vector(normal).normalized()
    upv = Vector(up) if up is not None else Z
    t = upv.cross(n)
    if t.length < 1e-6:
        t = X.copy() if abs(n.x) < 0.9 else Y.copy()
        t = (t - n * t.dot(n))
    t.normalize()
    y = n.cross(t)
    return Matrix(((t.x, y.x, n.x, p[0]), (t.y, y.y, n.y, p[1]), (t.z, y.z, n.z, p[2]), (0, 0, 0, 1)))


def basis_from_dir(d):
    d = Vector(d).normalized()
    t = Z if abs(d.z) < 0.95 else X
    u = d.cross(t).normalized()
    v = d.cross(u)
    return u, v


def catenary(p0, p1, sag, n=16):
    p0, p1 = Vector(p0), Vector(p1)
    return [p0.lerp(p1, i / n) - Z * (4 * sag * (i / n) * (1 - i / n)) for i in range(n + 1)]


def bezier_pts(p0, p1, p2, p3, n=12):
    p0, p1, p2, p3 = map(Vector, (p0, p1, p2, p3))
    out = []
    for i in range(n + 1):
        t = i / n
        a = 1 - t
        out.append(p0 * a ** 3 + p1 * 3 * a * a * t + p2 * 3 * a * t * t + p3 * t ** 3)
    return out


# ---------------------------------------------------------------- builder
CUBE_V = [(-1, -1, -1), (1, -1, -1), (1, 1, -1), (-1, 1, -1), (-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)]
CUBE_F = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
CUBE_UV = [(0, 1, 1), (0, 1, 1), (0, 1, 2), (1, 1, 2), (0, -1, 2), (1, -1, 2)]
_bevel_cache = {}


class Builder:
    def __init__(self, name, coll, smooth_angle=35.0):
        self.name, self.coll = name, coll
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new("UVMap")
        self.rnd = self.bm.faces.layers.float.new("rand")
        self.uox = self.bm.faces.layers.float.new("uvo_x")
        self.uoy = self.bm.faces.layers.float.new("uvo_y")
        self.mats = []
        self.rand = None      # sticky element rand (None -> fresh per call)
        self.uvo = (0.0, 0.0)  # sticky WorldUV offset (metres)
        self.smooth_angle = smooth_angle

    # -- sticky element state
    def element(self, rand=None, uvo=None):
        self.rand = R.random() if rand is None else rand
        self.uvo = uvo if uvo is not None else (R.uniform(0, 7), R.uniform(0, 7))
        return self

    def mi(self, mat):
        if mat not in self.mats:
            self.mats.append(mat)
        return self.mats.index(mat)

    def _face(self, verts, mat, uvs=None, rand=None, smooth=False):
        try:
            f = self.bm.faces.new(verts)
        except ValueError:
            return None
        f.material_index = self.mi(mat)
        f[self.rnd] = (self.rand if self.rand is not None else 0.5) if rand is None else rand
        f[self.uox], f[self.uoy] = self.uvo
        f.smooth = smooth
        if uvs:
            for l, uv in zip(f.loops, uvs):
                l[self.uv].uv = uv
        return f

    def poly(self, pts, mat, uvs=None, rand=None, smooth=False):
        vs = [self.bm.verts.new(Vector(p)) for p in pts]
        return self._face(vs, mat, uvs, rand, smooth)

    def quad(self, pts, mat, uvs=UV01, rand=None):
        return self.poly(pts, mat, uvs, rand)

    def panel(self, c, n, w, h, mat, up=None, uvs=UV01, rand=None):
        Mt = frame(c, n, up)
        pts = [Mt @ Vector((x, y, 0)) for x, y in ((-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2))]
        return self.quad(pts, mat, uvs, rand)

    def box(self, c, s, mat, R_=None, rand=None, skip=(), unit_uv=False):
        h = (s[0] / 2, s[1] / 2, s[2] / 2)
        loc = [Vector((x * h[0], y * h[1], z * h[2])) for x, y, z in CUBE_V]
        c = Vector(c)
        world = [c + ((R_ @ v) if R_ is not None else v) for v in loc]
        for fi, (idx, (ua, us, va)) in enumerate(zip(CUBE_F, CUBE_UV)):
            if fi in skip:
                continue
            if unit_uv:
                uvs = [((loc[i][ua] * us / (2 * h[ua]) + 0.5) if h[ua] else 0.5, loc[i][va] / (2 * h[va]) + 0.5) for i in idx]
            else:
                uvs = [(loc[i][ua] * us, loc[i][va]) for i in idx]
            self.poly([world[i] for i in idx], mat, uvs, rand)

    def boxmm(self, mn, mx, mat, **kw):
        c = [(a + b) / 2 for a, b in zip(mn, mx)]
        s = [max(abs(b - a), 1e-4) for a, b in zip(mn, mx)]
        self.box(c, s, mat, **kw)

    def cbox(self, c, s, mat, bev=0.01, seg=1, R_=None, rand=None):
        """Chamfered/rounded box (edges catch light)."""
        key = (round(s[0], 3), round(s[1], 3), round(s[2], 3), round(bev, 4), seg)
        src = _bevel_cache.get(key)
        if src is None:
            src = bmesh.new()
            bmesh.ops.create_cube(src, size=1.0)
            for v in src.verts:
                v.co = Vector((v.co.x * s[0], v.co.y * s[1], v.co.z * s[2]))
            b = min(bev, min(s) * 0.45)
            bmesh.ops.bevel(src, geom=list(src.edges) + list(src.verts), offset=b, segments=seg, affect='EDGES',
                            profile=0.5, clamp_overlap=True)
            _bevel_cache[key] = src
        M = Matrix.Translation(Vector(c)) @ (R_.to_4x4() if R_ is not None else Matrix.Identity(4))
        self.add_bm(src, M, mat, rand=rand, smooth=seg > 1, box_uv=s)

    def cyl(self, p0, p1, r, mat, sides=8, caps=True, r1=None, rand=None, smooth=True):
        p0, p1 = Vector(p0), Vector(p1)
        u, v = basis_from_dir(p1 - p0)
        r1 = r if r1 is None else r1
        angs = [2 * math.pi * i / sides for i in range(sides)]
        ring0 = [self.bm.verts.new(p0 + (u * math.cos(a) + v * math.sin(a)) * r) for a in angs]
        ring1 = [self.bm.verts.new(p1 + (u * math.cos(a) + v * math.sin(a)) * r1) for a in angs]
        L = (p1 - p0).length
        circ = 2 * math.pi * max(r, r1)
        for i in range(sides):
            j = (i + 1) % sides
            self._face((ring0[i], ring0[j], ring1[j], ring1[i]), mat,
                       uvs=((circ * i / sides, 0), (circ * (i + 1) / sides, 0), (circ * (i + 1) / sides, L), (circ * i / sides, L)),
                       rand=rand, smooth=smooth)
        if caps:
            self._face(list(reversed(ring0)), mat, rand=rand)
            if r1 > 1e-5:
                self._face(ring1, mat, rand=rand)

    def lathe(self, prof, base, axis, mat, seg=16, rand=None, smooth=True, cap0=False, cap1=False, phase=0.0):
        """prof: list of (radius, height) along axis from base. Revolve around axis."""
        base, axis = Vector(base), Vector(axis).normalized()
        u, v = basis_from_dir(axis)
        rings = []
        acc = [0.0]
        for a, b in zip(prof[:-1], prof[1:]):
            acc.append(acc[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
        tot = max(acc[-1], 1e-6)
        for (r, h) in prof:
            ring = []
            for i in range(seg):
                ang = 2 * math.pi * i / seg + phase
                ring.append(self.bm.verts.new(base + axis * h + (u * math.cos(ang) + v * math.sin(ang)) * r))
            rings.append(ring)
        for k in range(len(prof) - 1):
            for i in range(seg):
                j = (i + 1) % seg
                self._face((rings[k][i], rings[k][j], rings[k + 1][j], rings[k + 1][i]), mat,
                           uvs=((i / seg, acc[k] / tot), ((i + 1) / seg, acc[k] / tot), ((i + 1) / seg, acc[k + 1] / tot), (i / seg, acc[k + 1] / tot)),
                           rand=rand, smooth=smooth)
        if cap0 and prof[0][0] > 1e-5:
            self._face(list(reversed(rings[0])), mat, rand=rand)
        if cap1 and prof[-1][0] > 1e-5:
            self._face(rings[-1], mat, rand=rand)

    def sweep(self, pts, prof, mat, closed=False, closed_prof=True, rand=None, smooth=True, up=None):
        """Sweep 2D profile [(x,y)...] (x along normal, y along binormal) along polyline."""
        pts = [Vector(p) for p in pts]
        if closed:
            pts = pts + [pts[0]]
        n = len(pts)
        tang = []
        for i in range(n):
            if closed and i in (0, n - 1):
                t = pts[1] - pts[-2]
            elif i == 0:
                t = pts[1] - pts[0]
            elif i == n - 1:
                t = pts[-1] - pts[-2]
            else:
                t = (pts[i + 1] - pts[i]).normalized() + (pts[i] - pts[i - 1]).normalized()
            tang.append(t.normalized())
        ref = Vector(up) if up is not None else (Z if abs(tang[0].z) < 0.9 else X)
        nrm = tang[0].cross(ref).normalized()
        rings = []
        acc = 0.0
        vcoord = []
        for i in range(n):
            t = tang[i]
            nrm = nrm - t * nrm.dot(t)
            if nrm.length < 1e-6:
                nrm = t.orthogonal()
            nrm.normalize()
            b = t.cross(nrm)
            # miter scale at corners
            sc = 1.0
            if 0 < i < n - 1 or closed:
                a = (pts[i] - pts[i - 1]).normalized() if i > 0 else (pts[-1] - pts[-2]).normalized()
                cosh = max(0.3, a.dot(t))
                sc = 1.0 / cosh
            if i > 0:
                acc += (pts[i] - pts[i - 1]).length
            vcoord.append(acc)
            rings.append([self.bm.verts.new(pts[i] + nrm * (x * sc) + b * y) for x, y in prof])
        m = len(prof)
        per = 0.0
        pacc = [0.0]
        for k in range(m - (0 if closed_prof else 1)):
            a, bb = prof[k], prof[(k + 1) % m]
            pacc.append(pacc[-1] + math.hypot(bb[0] - a[0], bb[1] - a[1]))
        for i in range(n - 1):
            for k in range(m - (0 if closed_prof else 1)):
                k2 = (k + 1) % m
                self._face((rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]), mat,
                           uvs=((pacc[k], vcoord[i]), (pacc[k + 1], vcoord[i]), (pacc[k + 1], vcoord[i + 1]), (pacc[k], vcoord[i + 1])),
                           rand=rand, smooth=smooth)
        return rings

    def tube(self, pts, r, mat, sides=6, closed=False, rand=None):
        prof = [(r * math.cos(2 * math.pi * k / sides), r * math.sin(2 * math.pi * k / sides)) for k in range(sides)]
        return self.sweep(pts, prof, mat, closed=closed, rand=rand)

    def prism(self, poly2d, depth, M, mat, rand=None, caps=True, side_mat=None):
        """Extrude CCW polygon in local XY by +depth (local Z), transform by M."""
        bot = [self.bm.verts.new(M @ Vector((x, y, 0))) for x, y in poly2d]
        top = [self.bm.verts.new(M @ Vector((x, y, depth))) for x, y in poly2d]
        n = len(poly2d)
        acc = 0
        for i in range(n):
            j = (i + 1) % n
            L = math.dist(poly2d[i], poly2d[j])
            self._face((bot[i], bot[j], top[j], top[i]), side_mat or mat,
                       uvs=((acc, 0), (acc + L, 0), (acc + L, depth), (acc, depth)), rand=rand)
            acc += L
        if caps:
            self._face(list(reversed(bot)), mat, uvs=[(x, y) for x, y in reversed(poly2d)], rand=rand)
            self._face(top, mat, uvs=[(x, y) for x, y in poly2d], rand=rand)

    def add_mesh(self, me, M, mat, rand=None, smooth=False, mat_map=None):
        vs = [self.bm.verts.new(M @ v.co) for v in me.vertices]
        uvl = me.uv_layers.active.data if me.uv_layers else None
        for p in me.polygons:
            uvs = [tuple(uvl[li].uv) for li in p.loop_indices] if uvl else None
            m = mat_map[p.material_index] if mat_map else mat
            self._face([vs[i] for i in p.vertices], m, uvs=uvs, rand=rand, smooth=smooth or p.use_smooth)

    def add_bm(self, src, M, mat, rand=None, smooth=True, box_uv=None):
        vmap = {v: self.bm.verts.new(M @ v.co) for v in src.verts}
        uvl = src.loops.layers.uv.active
        for f in src.faces:
            uvs = None
            if uvl is not None:
                uvs = [tuple(l[uvl].uv) for l in f.loops]
            elif box_uv is not None:  # metre planar uvs by dominant normal
                n = f.normal
                ax = max(range(3), key=lambda k: abs(n[k]))
                a, b = [(1, 2), (0, 2), (0, 1)][ax]
                uvs = [(l.vert.co[a], l.vert.co[b]) for l in f.loops]
            self._face([vmap[v] for v in f.verts], mat, uvs=uvs, rand=rand, smooth=smooth)

    def finish(self, merge=True):
        bm = self.bm
        if merge and len(bm.verts):
            bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
        me = bpy.data.meshes.new(self.name)
        bm.to_mesh(me)
        bm.free()
        for m in self.mats:
            me.materials.append(m)
        _world_uv(me)
        if self.smooth_angle and len(me.polygons):
            try:
                me.set_sharp_from_angle(angle=math.radians(self.smooth_angle))
            except Exception:
                pass
        ob = bpy.data.objects.new(self.name, me)
        self.coll.objects.link(ob)
        return ob


def _world_uv(me):
    """Metric cube-projection UVs (tangent-consistent: v = up on walls) + per-face offset."""
    nl = len(me.loops)
    if nl == 0:
        return
    wuv = me.uv_layers.new(name="WorldUV")
    co = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    lv = np.empty(nl, np.int32)
    me.loops.foreach_get('vertex_index', lv)
    fn = np.empty(len(me.polygons) * 3, np.float32)
    me.polygons.foreach_get('normal', fn)
    fn = fn.reshape(-1, 3)
    ls = np.empty(len(me.polygons), np.int32)
    me.polygons.foreach_get('loop_start', ls)
    lt = np.empty(len(me.polygons), np.int32)
    me.polygons.foreach_get('loop_total', lt)
    face_of_loop = np.repeat(np.arange(len(me.polygons)), lt)
    n = fn[face_of_loop]
    p = co[lv]
    uo = np.zeros(len(me.polygons), np.float32)
    vo = np.zeros(len(me.polygons), np.float32)
    if 'uvo_x' in me.attributes:
        me.attributes['uvo_x'].data.foreach_get('value', uo)
        me.attributes['uvo_y'].data.foreach_get('value', vo)
    uo, vo = uo[face_of_loop], vo[face_of_loop]
    vertical = np.abs(n[:, 2]) < 0.7
    # tangent t = Z x n (horizontal), normalised
    tx, ty = -n[:, 1], n[:, 0]
    tl = np.sqrt(tx * tx + ty * ty) + 1e-9
    tx, ty = tx / tl, ty / tl
    u = np.where(vertical, p[:, 0] * tx + p[:, 1] * ty, np.where(n[:, 2] >= 0, p[:, 0], -p[:, 0]))
    v = np.where(vertical, p[:, 2], p[:, 1])
    uv = np.stack([u + uo, v + vo], axis=1).astype(np.float32).ravel()
    wuv.data.foreach_set('uv', uv)
    me.uv_layers.active = me.uv_layers['UVMap']


# ---------------------------------------------------------------- facade frame
class Fac:
    """Vertical plane. u -> viewer's right, z up, o -> out of the wall (along n)."""

    def __init__(self, origin, n):
        self.O = Vector(origin)
        self.n = Vector(n).normalized()
        self.t = Z.cross(self.n).normalized()

    def P(self, u, z, o=0.0):
        return self.O + self.t * u + self.n * o + Z * z

    def u_of(self, p):
        return (Vector(p) - self.O).dot(self.t)

    def o_of(self, p):
        return (Vector(p) - self.O).dot(self.n)

    def box(self, b, ua, ub, za, zb, oa, ob, mat, **kw):
        p1, p2 = self.P(ua, za, oa), self.P(ub, zb, ob)
        b.boxmm([min(a, c) for a, c in zip(p1, p2)], [max(a, c) for a, c in zip(p1, p2)], mat, **kw)

    def cbox(self, b, ua, ub, za, zb, oa, ob, mat, bev=0.01, seg=1, **kw):
        p1, p2 = self.P(ua, za, oa), self.P(ub, zb, ob)
        c = (p1 + p2) / 2
        s = [abs(a - c_) for a, c_ in zip(p1, p2)]
        b.cbox(c, s, mat, bev=bev, seg=seg, **kw)

    def quad(self, b, ua, ub, za, zb, o, mat, uvs=UV01, rand=None):
        return b.quad([self.P(ua, za, o), self.P(ub, za, o), self.P(ub, zb, o), self.P(ua, zb, o)], mat, uvs, rand)

    def quad2(self, b, ua, ub, z1, o1, z2, o2, mat, uvs=UV01, rand=None):
        return b.quad([self.P(ua, z1, o1), self.P(ub, z1, o1), self.P(ub, z2, o2), self.P(ua, z2, o2)], mat, uvs, rand)

    def M(self, u, z, o, normal=None):
        return frame(self.P(u, z, o), self.n if normal is None else normal)

    def disc(self, b, u, z, o, r, mat, seg=12, rand=None):
        pts = [self.P(u + r * math.cos(2 * math.pi * i / seg), z + r * math.sin(2 * math.pi * i / seg), o) for i in range(seg)]
        uvs = [(0.5 + 0.5 * math.cos(2 * math.pi * i / seg), 0.5 + 0.5 * math.sin(2 * math.pi * i / seg)) for i in range(seg)]
        return b.poly(pts, mat, uvs, rand)

    def rot_box(self, b, u, z, o, len_u, h, dep, angle, mat):
        size = [0, 0, h]
        for ax in range(2):
            size[ax] = abs(self.t[ax]) * len_u + abs(self.n[ax]) * dep
        b.box(self.P(u, z, o), size, mat, R_=Matrix.Rotation(angle, 3, self.n))

    def wall_with_holes(self, b, ua, ub, za, zb, o, holes, mat, rand=None):
        """Front wall plane with rectangular openings [(u0,u1,z0,z1)], merged into horizontal strips."""
        us = sorted({ua, ub} | {h[0] for h in holes} | {h[1] for h in holes})
        zs = sorted({za, zb} | {h[2] for h in holes} | {h[3] for h in holes})
        us = [u for u in us if ua - 1e-6 <= u <= ub + 1e-6]
        zs = [z for z in zs if za - 1e-6 <= z <= zb + 1e-6]
        for zi in range(len(zs) - 1):
            z0, z1 = zs[zi], zs[zi + 1]
            run = None
            for ui in range(len(us) - 1):
                u0, u1 = us[ui], us[ui + 1]
                cu, cz = (u0 + u1) / 2, (z0 + z1) / 2
                inside = any(h[0] < cu < h[1] and h[2] < cz < h[3] for h in holes)
                if not inside:
                    run = (run[0], u1) if run else (u0, u1)
                else:
                    if run:
                        self.quad(b, run[0], run[1], z0, z1, o, mat, uvs=None, rand=rand)
                    run = None
            if run:
                self.quad(b, run[0], run[1], z0, z1, o, mat, uvs=None, rand=rand)

    def reveal(self, b, u0, u1, z0, z1, o_front, depth, mat, sill_mat=None, rand=None):
        """Four inner faces of an opening from the wall front to depth (into the wall)."""
        ob = o_front - depth
        b.quad([self.P(u0, z0, o_front), self.P(u1, z0, o_front), self.P(u1, z0, ob), self.P(u0, z0, ob)], sill_mat or mat, None, rand)  # bottom, faces up
        b.quad([self.P(u0, z1, ob), self.P(u1, z1, ob), self.P(u1, z1, o_front), self.P(u0, z1, o_front)], mat, None, rand)  # soffit, faces down
        b.quad([self.P(u0, z0, o_front), self.P(u0, z0, ob), self.P(u0, z1, ob), self.P(u0, z1, o_front)], mat, None, rand)  # left side faces +t
        b.quad([self.P(u1, z0, ob), self.P(u1, z0, o_front), self.P(u1, z1, o_front), self.P(u1, z1, ob)], mat, None, rand)  # right


# ---------------------------------------------------------------- text
_text_cache = {}


def font(path):
    return bpy.data.fonts.load(path, check_existing=True)


def text_mesh(text, fpath, res=3, extrude=0.0, line=1.0, bevel=0.0):
    key = (text, fpath, res, extrude, line, bevel)
    if key in _text_cache:
        return _text_cache[key]
    cu = bpy.data.curves.new("txt", 'FONT')
    cu.body = text
    cu.font = font(fpath)
    cu.size = 1.0
    cu.extrude = extrude
    cu.bevel_depth = bevel
    cu.bevel_resolution = 1
    cu.align_x = 'CENTER'
    cu.resolution_u = res
    cu.space_line = line
    ob = bpy.data.objects.new("txt", cu)
    bpy.context.scene.collection.objects.link(ob)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    bpy.data.objects.remove(ob)
    bpy.data.curves.remove(cu)
    co = np.array([v.co[:] for v in me.vertices]) if len(me.vertices) else np.zeros((1, 3))
    bb = (co[:, 0].min(), co[:, 0].max(), co[:, 1].min(), co[:, 1].max(), co[:, 2].min(), co[:, 2].max())
    _text_cache[key] = (me, bb)
    return me, bb


def place_text(b, text, fpath, M, w, h, mat, extrude=0.0, vertical=False, res=2, rand=None, align='C', bevel=0.0):
    if vertical:
        text = "\n".join(text.replace("ー", "｜"))
    me, (x0, x1, y0, y1, z0, z1) = text_mesh(text, fpath, res, extrude, 0.92 if vertical else 1.0, bevel)
    tw, th = max(x1 - x0, 1e-3), max(y1 - y0, 1e-3)
    s = min(w / tw, h / th)
    cx = (x0 + x1) / 2
    if align == 'L':
        cx = x0 + w / s / 2
    T = Matrix.Translation((-cx, -(y0 + y1) / 2, -z0))
    b.add_mesh(me, M @ Matrix.Scale(s, 4) @ T, mat, rand=rand)
    return tw * s, th * s


def text_outline_polys(text, fpath, res=6):
    """Glyph outlines as closed 2D polylines (font curve splines), unit size, centred."""
    cu = bpy.data.curves.new("txt", 'FONT')
    cu.body = text
    cu.font = font(fpath)
    cu.size = 1.0
    cu.align_x = 'CENTER'
    cu.resolution_u = res
    ob = bpy.data.objects.new("txt", cu)
    bpy.context.scene.collection.objects.link(ob)
    dg = bpy.context.evaluated_depsgraph_get()
    cev = ob.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(cev)
    bpy.data.objects.remove(ob)
    bpy.data.curves.remove(cu)
    return me
