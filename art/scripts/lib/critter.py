"""Creature kit for the horde (art/scripts/creatures.py).

Every piece of a creature is a parametric surface P(t, a): a section swept round a spine (t along it, 0..1;
a round it, 0..2pi, a = 0 on the underside so the UV seam hides there). The Cycles HIGH mesh and the three
realtime LODs are the SAME surface sampled at different densities, and all of them share one UV
parameterisation, (a, t) -> the piece's rectangle in the shared atlas. So the HIGH mesh bakes straight into
its own UVs (no cage, no ray misses, no projection between parts that touch) and every LOD reads the texels
of the surface point it stands for, whatever its density. Displacement is split into a large part (shape:
every LOD gets it, so silhouettes agree) and a fine part (HIGH only: it lives on in the baked normals).

Frames: pieces are authored in the game's creature frame (unit body radius, y up, +z forward) and built in
Blender metres:  G(x, y, z) = R * (x, -z, y).  Export divides back by R.
"""
import bpy, math, json, struct
import numpy as np

TAU = 2 * math.pi


# ---------------------------------------------------------------- numpy noise
def _perm(seed):
    return np.random.default_rng(seed).permutation(256).astype(np.int64)


_PERM = np.concatenate([_perm(7), _perm(7)])
_GRAD = np.array([(1, 1, 0), (-1, 1, 0), (1, -1, 0), (-1, -1, 0), (1, 0, 1), (-1, 0, 1), (1, 0, -1), (-1, 0, -1),
                  (0, 1, 1), (0, -1, 1), (0, 1, -1), (0, -1, -1), (1, 1, 0), (0, -1, 1), (-1, 1, 0), (0, -1, -1)], float)


def perlin(p):
    """Improved Perlin noise, vectorised. p: (..., 3). Returns (...) in about [-1, 1]."""
    p = np.asarray(p, float)
    pi = np.floor(p)
    f = p - pi
    i = pi.astype(np.int64) & 255
    u = f * f * f * (f * (f * 6 - 15) + 10)
    P = _PERM
    X, Y, Zc = i[..., 0], i[..., 1], i[..., 2]
    A = P[X] + Y
    AA, AB = P[A] + Zc, P[A + 1] + Zc
    B = P[X + 1] + Y
    BA, BB = P[B] + Zc, P[B + 1] + Zc

    def g(h, x, y, z):
        gr = _GRAD[P[h] & 15]
        return gr[..., 0] * x + gr[..., 1] * y + gr[..., 2] * z

    x, y, z = f[..., 0], f[..., 1], f[..., 2]
    l = lambda a, b, t: a + t * (b - a)
    return l(l(l(g(AA, x, y, z), g(BA, x - 1, y, z), u[..., 0]), l(g(AB, x, y - 1, z), g(BB, x - 1, y - 1, z), u[..., 0]), u[..., 1]),
             l(l(g(AA + 1, x, y, z - 1), g(BA + 1, x - 1, y, z - 1), u[..., 0]), l(g(AB + 1, x, y - 1, z - 1), g(BB + 1, x - 1, y - 1, z - 1), u[..., 0]), u[..., 1]),
             u[..., 2])


def fbm(p, scale=1.0, octaves=4, gain=0.5, lac=2.03, seed=0):
    p = np.asarray(p, float) * scale + np.array([seed * 17.13, seed * 5.71, seed * 11.37])
    out = np.zeros(p.shape[:-1])
    amp, norm = 1.0, 0.0
    for k in range(octaves):
        out += amp * perlin(p)
        norm += amp
        amp *= gain
        p = p * lac + 3.17
    return out / norm


def ridged(p, scale=1.0, octaves=4, seed=0):
    p = np.asarray(p, float) * scale + seed * 9.1
    out = np.zeros(p.shape[:-1])
    amp, norm = 1.0, 0.0
    for k in range(octaves):
        out += amp * (1 - np.abs(perlin(p)))
        norm += amp
        amp *= 0.5
        p = p * 2.07 + 1.3
    return out / norm


def _hash3(c, seed):
    c = c.astype(np.int64)
    h = (c[..., 0] * 73856093) ^ (c[..., 1] * 19349663) ^ (c[..., 2] * 83492791) ^ (seed * 2654435761)
    h = h & 0xFFFFFFFF
    h = (h ^ (h >> 13)) * 1274126177 & 0xFFFFFFFF
    h = h ^ (h >> 16)
    return h


def _rand(h, k):
    h2 = (h * (2654435761 + 97 * k) + 0x9E3779B9 * (k + 1)) & 0xFFFFFFFF
    h2 = (h2 ^ (h2 >> 15)) * 2246822519 & 0xFFFFFFFF
    h2 = h2 ^ (h2 >> 13)
    return (h2 & 0xFFFFFF) / float(0xFFFFFF)


def worley(p, scale=1.0, seed=0, jitter=0.9):
    """Cellular noise: (F1, F2, id of the nearest cell in 0..1)."""
    p = np.asarray(p, float) * scale
    cell = np.floor(p)
    F1 = np.full(p.shape[:-1], 9.0)
    F2 = np.full(p.shape[:-1], 9.0)
    ID = np.zeros(p.shape[:-1])
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dz in (-1, 0, 1):
                c = cell + np.array([dx, dy, dz])
                h = _hash3(c, seed)
                fp = c + 0.5 + (np.stack([_rand(h, 0), _rand(h, 1), _rand(h, 2)], -1) - 0.5) * jitter
                d = np.linalg.norm(p - fp, axis=-1)
                closer = d < F1
                F2 = np.where(closer, F1, np.minimum(F2, d))
                ID = np.where(closer, _rand(h, 3), ID)
                F1 = np.where(closer, d, F1)
    return F1, F2, ID


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


# ---------------------------------------------------------------- frames
class Frame:
    """Game creature frame -> Blender metres for a body radius R."""

    def __init__(self, R):
        self.R = R

    def __call__(self, x, y, z):
        return np.array((x * self.R, -z * self.R, y * self.R))

    def pts(self, *ps):
        return [self(*p) for p in ps]


def catmull(P, per=24):
    """Centripetal Catmull-Rom through the points (no loops or overshoot at tight joints)."""
    P = np.asarray(P, float)
    if len(P) == 2:
        return np.linspace(P[0], P[1], per + 1)
    ext = np.vstack([2 * P[0] - P[1], P, 2 * P[-1] - P[-2]])
    out = []
    for i in range(1, len(ext) - 2):
        p0, p1, p2, p3 = ext[i - 1:i + 3]
        t0 = 0.0
        t1 = t0 + max(np.linalg.norm(p1 - p0), 1e-6) ** 0.5
        t2 = t1 + max(np.linalg.norm(p2 - p1), 1e-6) ** 0.5
        t3 = t2 + max(np.linalg.norm(p3 - p2), 1e-6) ** 0.5
        for t in np.linspace(t1, t2, per, endpoint=False):
            a1 = (t1 - t) / (t1 - t0) * p0 + (t - t0) / (t1 - t0) * p1
            a2 = (t2 - t) / (t2 - t1) * p1 + (t - t1) / (t2 - t1) * p2
            a3 = (t3 - t) / (t3 - t2) * p2 + (t - t2) / (t3 - t2) * p3
            b1 = (t2 - t) / (t2 - t0) * a1 + (t - t0) / (t2 - t0) * a2
            b2 = (t3 - t) / (t3 - t1) * a2 + (t - t1) / (t3 - t1) * a3
            out.append((t2 - t) / (t2 - t1) * b1 + (t - t1) / (t2 - t1) * b2)
    out.append(P[-1])
    return np.array(out)


def _unit(v):
    n = np.linalg.norm(v, axis=-1, keepdims=True)
    return v / np.maximum(n, 1e-12)


class Spine:
    """Arc-length parameterised curve through control points with a twist-free frame.

    `up` is the hint for the section's +y: a vector, or a callable (point, tangent) -> vector (e.g. "away from the
    body" for legs, so a leg's back stays its back as it bends down to the foot)."""

    def __init__(self, pts, up=(0, 0, 1), per=40):
        D = catmull(pts, per)
        seg = np.linalg.norm(np.diff(D, axis=0), axis=1)
        keep = np.concatenate([[True], seg > 1e-9])
        D = D[keep]
        seg = np.linalg.norm(np.diff(D, axis=0), axis=1)
        self.D = D
        self.s = np.concatenate([[0.0], np.cumsum(seg)])
        self.L = float(self.s[-1])
        T = _unit(np.gradient(D, axis=0))
        U = np.zeros_like(D)
        prev = None
        for k in range(len(D)):
            h = np.array(up(D[k], T[k]) if callable(up) else up, float)
            u = h - T[k] * np.dot(h, T[k])
            if np.linalg.norm(u) < 0.25 * np.linalg.norm(h) and prev is not None:
                u = prev - T[k] * np.dot(prev, T[k])
            if np.linalg.norm(u) < 1e-6:
                u = np.cross(T[k], [1, 0, 0]) if abs(T[k][0]) < 0.9 else np.cross(T[k], [0, 1, 0])
            u = u / np.linalg.norm(u)
            U[k] = u
            prev = u
        self.T, self.U = T, U

    def at(self, t):
        t = np.asarray(t, float)
        s = np.clip(t, 0, 1) * self.L
        C = np.stack([np.interp(s, self.s, self.D[:, k]) for k in range(3)], -1)
        T = _unit(np.stack([np.interp(s, self.s, self.T[:, k]) for k in range(3)], -1))
        U = np.stack([np.interp(s, self.s, self.U[:, k]) for k in range(3)], -1)
        U = _unit(U - T * np.sum(U * T, -1, keepdims=True))
        S = np.cross(T, U)
        return C, T, U, S


# ---------------------------------------------------------------- profiles
def knots(*kn):
    """Piecewise-smooth profile through (t, value) knots (monotone cubic, so no ringing)."""
    ts = np.array([k[0] for k in kn], float)
    vs = np.array([k[1] for k in kn], float)

    def f(t):
        t = np.clip(np.asarray(t, float), ts[0], ts[-1])
        i = np.clip(np.searchsorted(ts, t, side='right') - 1, 0, len(ts) - 2)
        u = (t - ts[i]) / np.maximum(ts[i + 1] - ts[i], 1e-9)
        u = u * u * (3 - 2 * u)
        return vs[i] + (vs[i + 1] - vs[i]) * u
    return f


def caps(t, k0=0.08, k1=0.08, p0=0.5, p1=0.5):
    """Rounded ends: radius scale rising from 0 at t=0 / t=1 like a quarter ellipse (p=0.5) or a cone (p=1)."""
    t = np.asarray(t, float)
    a = np.clip(t / max(k0, 1e-6), 0, 1) if k0 > 0 else np.ones_like(t)
    b = np.clip((1 - t) / max(k1, 1e-6), 0, 1) if k1 > 0 else np.ones_like(t)
    fa = (1 - (1 - a) ** 2) ** p0 if k0 > 0 else 1.0
    fb = (1 - (1 - b) ** 2) ** p1 if k1 > 0 else 1.0
    return fa * fb


def superellipse(w, up, down, e=2.0, side=None):
    """Section: half-width w(t), top up(t), bottom down(t), squareness e(t) (2 = ellipse). Callables or numbers.
    `side`, optional callable (t, a) -> extra radial scale (for keels, grooves, flats)."""
    W, Up, Dn, E = [(v if callable(v) else (lambda t, v=v: np.full_like(np.asarray(t, float), v))) for v in (w, up, down, e)]

    def sec(t, a):
        sa, ca = np.sin(a), -np.cos(a)  # a = 0 at the bottom, pi at the top
        ex = 2.0 / E(t)
        x = W(t) * np.sign(sa) * np.abs(sa) ** ex
        h = np.where(ca > 0, Up(t), Dn(t))
        y = h * np.sign(ca) * np.abs(ca) ** ex
        if side is not None:
            s = side(t, a)
            x, y = x * s, y * s
        return x, y
    return sec


def polygon(r, sides, phase=0.0, round_=0.0):
    """Regular polygon section (crystals): radius r(t) to the corners."""
    R_ = r if callable(r) else (lambda t: np.full_like(np.asarray(t, float), r))

    def sec(t, a):
        k = TAU / sides
        aa = (a - phase) % k - k / 2
        rr = np.cos(k / 2) / np.cos(aa)
        if round_:
            rr = rr * (1 - round_) + round_
        x, y = np.sin(a) * rr, -np.cos(a) * rr
        return x * R_(t), y * R_(t)
    return sec


# ---------------------------------------------------------------- pieces
PART = dict(BODY=0, LEG=1, HEAD=2, JAW=3, ARM=4, CORE=5)


class Piece:
    """One parametric part.

    sec(t, a) -> (x, y) in the (side, up) plane of the spine frame.
    disp(P, N, t, a, high) -> metres along the normal (`high` False = the LOD's coarse share only).
    masks(P, N, t, a, d) -> {name: array}: vertex attributes on the HIGH mesh for the material.
    res: (around, along) for HIGH. lods: [(around, along) | None] * 3.
    rig: (part, beat, pivot in game creature units). glow: emission weight carried to the runtime."""

    def __init__(self, name, spine, sec, res, lods, mat, disp=None, masks=None, rig=('BODY', 0, (0, 0, 0)),
                 glow=0.0, flat=False, cluster=0.5, density=1.0, high_only=False, lod_disp=True):
        self.name, self.spine, self.sec = name, spine, sec
        self.res, self.lods, self.mat = res, lods, mat
        self.disp, self.masks = disp, masks
        self.rig, self.glow = rig, glow
        self.flat, self.cluster, self.density = flat, cluster, density
        self.high_only, self.lod_disp = high_only, lod_disp
        self.rect = None  # atlas rectangle (x, y, w, h, rotated) in 0..1
        self.sign = 1.0

    def _ts(self, m):
        u = np.linspace(0, 1, m)
        c = 0.5 - 0.5 * np.cos(np.pi * u)
        return (1 - self.cluster) * u + self.cluster * c

    def surface(self, t, a):
        C, T, U, S = self.spine.at(t)
        x, y = self.sec(t[:, None], a[None, :])
        return C[:, None, :] + S[:, None, :] * x[..., None] + U[:, None, :] * y[..., None], C, T

    def grid(self, n, m, high):
        if np.ndim(m):
            t = np.asarray(m, float)
            m = len(t)
        else:
            t = self._ts(m)
        a = np.linspace(0, TAU, n + 1)
        P, C, T = self.surface(t, a)
        et, ea = 1e-4, 1e-4
        Pt1, _, _ = self.surface(np.clip(t + et, 0, 1), a)
        Pt0, _, _ = self.surface(np.clip(t - et, 0, 1), a)
        Pa1, _, _ = self.surface(t, a + ea)
        Pa0, _, _ = self.surface(t, a - ea)
        N = np.cross(Pa1 - Pa0, Pt1 - Pt0)
        ln = np.linalg.norm(N, axis=-1, keepdims=True)
        # outward: away from the spine
        out = P - C[:, None, :]
        s = np.sign(np.sum(np.sum(N * out, -1)))
        self.sign = s if s != 0 else 1.0
        N = N * self.sign
        bad = (ln[..., 0] < 1e-10)
        N = _unit(N)
        tip = np.where(t[:, None] < 0.5, -1.0, 1.0)[..., None] * T[:, None, :]
        N = np.where(bad[..., None], np.broadcast_to(tip, N.shape), N)
        tt = np.broadcast_to(t[:, None], P.shape[:2])
        aa = np.broadcast_to(a[None, :], P.shape[:2])
        d = np.zeros(P.shape[:2])
        if self.disp is not None and (high or self.lod_disp):
            d = np.broadcast_to(np.asarray(self.disp(P, N, tt, aa, high), float), P.shape[:2]).copy()
            P = P + N * d[..., None]
        return P, N, tt, aa, d

    def faces(self, m, n):
        n1 = n + 1
        i, j = np.meshgrid(np.arange(m - 1), np.arange(n), indexing='ij')
        v00 = i * n1 + j
        v01 = v00 + 1
        v10 = v00 + n1
        v11 = v10 + 1
        return np.stack([v00, v01, v11, v10], -1).reshape(-1, 4)

    def tris(self, P, m, n):
        """Triangles, dropping the degenerate halves of pole quads."""
        q = self.faces(m, n)
        V = P.reshape(-1, 3)
        t1 = q[:, [0, 1, 2]]
        t2 = q[:, [0, 2, 3]]
        T = np.concatenate([t1, t2])
        A = np.linalg.norm(np.cross(V[T[:, 1]] - V[T[:, 0]], V[T[:, 2]] - V[T[:, 0]]), axis=1)
        T = T[A > 1e-12]
        return T

    def uv(self, tt, aa):
        u = aa / TAU
        v = tt
        if self.rect is None:
            return np.stack([u, v], -1)
        x, y, w, h, rot = self.rect
        if rot:
            return np.stack([x + v * w, y + u * h], -1)
        return np.stack([x + u * w, y + v * h], -1)

    def footprint(self):
        """(around, along) metres of the surface: mean circumference and mean meridian length."""
        P, _, _, _, _ = self.grid(32, 48, False)
        circ = np.linalg.norm(np.diff(P, axis=1), axis=-1).sum(1)
        mer = np.linalg.norm(np.diff(P, axis=0), axis=-1).sum(0)
        return float(np.mean(circ)), float(np.mean(mer))


def flip_if_inward(P, F):
    V = P.reshape(-1, 3)
    V = V - V.mean(0)
    a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    vol = np.sum(np.einsum('ij,ij->i', a, np.cross(b, c)))
    return F[:, ::-1].copy() if vol < 0 else F


def to_blender(piece, coll, origin=(0, 0, 0)):
    """The HIGH mesh as a Blender object, with UVMap (atlas), Param (a, t) and the masks as attributes."""
    n, m = piece.res
    P, N, tt, aa, d = piece.grid(n, m, True)
    # Welded topology (the seam column and each pole are one vertex, so smooth normals have no seam);
    # UVs are per loop, from the grid corner each loop stands for.
    pole0 = np.ptp(P[0], axis=0).max() < 1e-7
    pole1 = np.ptp(P[-1], axis=0).max() < 1e-7
    vid = np.zeros((m, n + 1), np.int64)
    cnt = 0
    for i in range(m):
        if (i == 0 and pole0) or (i == m - 1 and pole1):
            vid[i, :] = cnt
            cnt += 1
        else:
            vid[i, :n] = np.arange(cnt, cnt + n)
            vid[i, n] = cnt
            cnt += n
    V = np.zeros((cnt, 3))
    V[vid[:, :n].ravel()] = P[:, :n].reshape(-1, 3)
    q = piece.faces(m, n)  # grid-corner indices
    gi = q // (n + 1)
    gj = q % (n + 1)
    vq = vid[gi, gj]
    polys, corners = [], []
    for f in range(len(q)):
        c = vq[f]
        if c[0] == c[1]:      # pole row on top of the quad
            polys.append([c[0], c[2], c[3]]); corners.append([q[f][0], q[f][2], q[f][3]])
        elif c[2] == c[3]:    # pole row below
            polys.append([c[0], c[1], c[2]]); corners.append([q[f][0], q[f][1], q[f][2]])
        else:
            polys.append(list(c)); corners.append(list(q[f]))
    # orientation: signed volume over the full fan of every polygon (closed surface, so origin-independent;
    # centred anyway for precision)
    tri = np.array([[p[0], p[k], p[k + 1]] for p in polys for k in range(1, len(p) - 1)])
    Vc = V - V.mean(0)
    a_, b_, c_ = Vc[tri[:, 0]], Vc[tri[:, 1]], Vc[tri[:, 2]]
    if np.sum(np.einsum('ij,ij->i', a_, np.cross(b_, c_))) < 0:
        polys = [p[::-1] for p in polys]
        corners = [c[::-1] for c in corners]
    me = bpy.data.meshes.new(piece.name)
    me.from_pydata(V.tolist(), [], polys)
    if len(me.polygons) != len(polys):
        raise RuntimeError(f'{piece.name}: polygons lost')
    lc = np.array([c for cs in corners for c in cs], np.int64)
    uvs = piece.uv(tt.reshape(-1), aa.reshape(-1))
    par = np.stack([aa.reshape(-1) / TAU, tt.reshape(-1)], -1)
    for name, arr in (('UVMap', uvs), ('Param', par)):
        layer = me.uv_layers.new(name=name)
        layer.data.foreach_set('uv', arr[lc].astype(np.float32).ravel())
    me.uv_layers.active = me.uv_layers['UVMap']
    attrs = {'disp': d}
    if piece.masks is not None:
        for k, v in piece.masks(P, N, tt, aa, d).items():
            attrs[k] = np.broadcast_to(v, tt.shape)
    for k, v in attrs.items():
        vals = np.zeros(cnt, np.float32)
        vals[vid[:, :n].ravel()] = np.asarray(v)[:, :n].reshape(-1)
        at = me.attributes.new(k, 'FLOAT', 'POINT')
        at.data.foreach_set('value', vals)
    me.polygons.foreach_set('use_smooth', [not piece.flat] * len(me.polygons))
    if piece.flat:
        pass
    me.materials.append(piece.mat)
    ob = bpy.data.objects.new(piece.name, me)
    ob.location = origin
    coll.objects.link(ob)
    return ob


def lod_arrays(piece, level, R):
    """One LOD of a piece in game creature units: positions, uv (glTF: v flipped), triangles."""
    spec = piece.lods[level]
    if spec is None:
        return None
    n, m = spec
    P, N, tt, aa, d = piece.grid(n, m, False)
    m = P.shape[0]
    T = piece.tris(P, m, n)
    T = flip_if_inward(P, T)
    V = P.reshape(-1, 3)
    uv = piece.uv(tt.reshape(-1), aa.reshape(-1))
    # drop unreferenced vertices
    used = np.zeros(len(V), bool)
    used[T.ravel()] = True
    remap = -np.ones(len(V), np.int64)
    remap[used] = np.arange(used.sum())
    V, uv, T = V[used], uv[used], remap[T]
    game = np.stack([V[:, 0], V[:, 2], -V[:, 1]], -1) / R
    uv = np.stack([uv[:, 0], 1.0 - uv[:, 1]], -1)
    return game.astype(np.float32), uv.astype(np.float32), T.astype(np.int64)


# ---------------------------------------------------------------- atlas packing
def pack(rects, size, margin_px=6):
    """Skyline bottom-left packing of (w, h) rectangles (pixels, rotation allowed) into a size x size square.
    Returns [(x, y, rot)] or None if they do not fit."""
    order = sorted(range(len(rects)), key=lambda i: -(max(rects[i]) * 4 + min(rects[i])))
    sky = [[0, 0, size]]  # segments: x, y, width
    out = [None] * len(rects)

    def fit(idx, w):
        x = sky[idx][0]
        if x + w > size:
            return None
        y, rem, j = 0, w, idx
        while rem > 0:
            if j >= len(sky):
                return None
            y = max(y, sky[j][1])
            rem -= sky[j][2]
            j += 1
        return y

    for i in order:
        best = None
        for rot in (False, True):
            w, h = rects[i]
            if rot:
                w, h = h, w
            w, h = int(math.ceil(w + margin_px)), int(math.ceil(h + margin_px))
            for idx in range(len(sky)):
                y = fit(idx, w)
                if y is None or y + h > size:
                    continue
                key = (y + h, sky[idx][0])
                if best is None or key < best[0]:
                    best = (key, idx, y, w, h, rot)
        if best is None:
            return None
        _, idx, y, w, h, rot = best
        x = sky[idx][0]
        out[i] = (x + margin_px / 2, y + margin_px / 2, rot)
        # update the skyline
        new = [x, y + h, w]
        rest = []
        for seg in sky:
            sx, sy, sw = seg
            if sx + sw <= x or sx >= x + w:
                rest.append(seg)
                continue
            if sx < x:
                rest.append([sx, sy, x - sx])
            if sx + sw > x + w:
                rest.append([x + w, sy, sx + sw - (x + w)])
        rest.append(new)
        rest.sort(key=lambda q: q[0])
        merged = []
        for seg in rest:
            if merged and merged[-1][1] == seg[1] and merged[-1][0] + merged[-1][2] == seg[0]:
                merged[-1][2] += seg[2]
            else:
                merged.append(seg)
        sky[:] = merged
    return out


def atlas(pieces, size, margin_px=6):
    """Give every (non-HIGH-only) piece a rectangle; texel density per metre is uniform times piece.density."""
    fp = [p.footprint() for p in pieces]
    lo, hi = 1.0, 20000.0
    best = None
    for _ in range(22):
        mid = (lo + hi) / 2
        rects = [(max(6, c * mid * p.density), max(6, l * mid * p.density)) for p, (c, l) in zip(pieces, fp)]
        res = pack(rects, size, margin_px)
        if res is None:
            hi = mid
        else:
            lo, best = mid, (mid, rects, res)
    tpm, rects, res = best
    for p, (w, h), (x, y, rot) in zip(pieces, rects, res):
        p.rect = (x / size, y / size, (h if rot else w) / size, (w if rot else h) / size, rot)
    return tpm


# ---------------------------------------------------------------- glTF
def write_glb(path, meshes):
    """meshes: [(name, {'POSITION': f32 (n,3), 'TEXCOORD_0': f32 (n,2), '_RIG': f32 (n,2), ...}, idx (k,3))].
    Plain glTF 2.0, one node per mesh, custom attributes as float accessors (no Draco: the LODs are tiny)."""
    bin_ = bytearray()
    views, accs, gmeshes, nodes = [], [], [], []

    def add(arr, target, comp, typ, minmax=False):
        nonlocal bin_
        while len(bin_) % 4:
            bin_ += b'\0'
        data = np.ascontiguousarray(arr).tobytes()
        views.append({'buffer': 0, 'byteOffset': len(bin_), 'byteLength': len(data), 'target': target})
        bin_ += data
        acc = {'bufferView': len(views) - 1, 'componentType': comp, 'count': int(arr.shape[0]), 'type': typ}
        if minmax:
            acc['min'] = arr.min(0).tolist()
            acc['max'] = arr.max(0).tolist()
        accs.append(acc)
        return len(accs) - 1

    types = {1: 'SCALAR', 2: 'VEC2', 3: 'VEC3', 4: 'VEC4'}
    for name, attrs, idx in meshes:
        prim = {'attributes': {}, 'mode': 4}
        for k, v in attrs.items():
            v = np.asarray(v, np.float32)
            if v.ndim == 1:
                v = v[:, None]
            prim['attributes'][k] = add(v, 34962, 5126, types[v.shape[1]], minmax=(k == 'POSITION'))
        nv = len(attrs['POSITION'])
        ii = np.asarray(idx, np.uint16 if nv < 65536 else np.uint32).reshape(-1)
        prim['indices'] = add(ii[:, None], 34963, 5123 if nv < 65536 else 5125, 'SCALAR')
        gmeshes.append({'name': name, 'primitives': [prim]})
        nodes.append({'name': name, 'mesh': len(gmeshes) - 1})
    while len(bin_) % 4:
        bin_ += b'\0'
    gl = {'asset': {'version': '2.0', 'generator': 'snow art/scripts/creatures.py'},
          'scene': 0, 'scenes': [{'nodes': list(range(len(nodes)))}], 'nodes': nodes, 'meshes': gmeshes,
          'accessors': accs, 'bufferViews': views, 'buffers': [{'byteLength': len(bin_)}]}
    js = json.dumps(gl, separators=(',', ':')).encode()
    while len(js) % 4:
        js += b' '
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(bin_)))
        f.write(struct.pack('<II', len(js), 0x4E4F534A))
        f.write(js)
        f.write(struct.pack('<II', len(bin_), 0x004E4942))
        f.write(bin_)
