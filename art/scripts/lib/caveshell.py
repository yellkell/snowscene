"""The ice cave's shell: the game's procedural outline (cave-build.ts buildShell, exported as a vertex
grid) upsampled and sculpted into a glacier cavity: a lumpy, meltwater-fluted ice wall, frozen
waterfalls poured down it, tilted sediment bands, a gravel and bedrock foot at the pool, a throat up to
daylight at the top; icicles on every overhang the works leave room for.

Everything that moves the wall inward is clamped against the works' swept volumes (exported by
export_cave_ref.mjs), and the wall is pulled out to swallow every beam that is anchored in it.

Game (x, y, z) = Blender (x, -z, y).
"""
import bpy, bmesh, math, random
import numpy as np
from mathutils import Vector
from mathutils.kdtree import KDTree
from mathutils.bvhtree import BVHTree
from . import cavemats as CM


# ---------------------------------------------------------------- noise
def _hash3(i, j, k, seed):
    M = np.uint64(0xFFFFFFFF)
    i = i.astype(np.int64).astype(np.uint64)
    j = j.astype(np.int64).astype(np.uint64)
    k = k.astype(np.int64).astype(np.uint64)
    n = (i * np.uint64(374761393) + j * np.uint64(668265263) + k * np.uint64(2147483647) + np.uint64(seed * 2246822519 % 4294967296)) & M
    n = ((n ^ (n >> np.uint64(13))) * np.uint64(1274126177)) & M
    return ((n ^ (n >> np.uint64(16))) & np.uint64(0xFFFF)).astype(np.float64) / 65535.0 * 2 - 1


def vnoise3(p, seed=1):
    """Value noise in [-1, 1] at points p (N, 3)."""
    fl = np.floor(p)
    f = p - fl
    i, j, k = fl[:, 0], fl[:, 1], fl[:, 2]
    u = f * f * (3 - 2 * f)
    acc = 0
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                w = (u[:, 0] if dx else 1 - u[:, 0]) * (u[:, 1] if dy else 1 - u[:, 1]) * (u[:, 2] if dz else 1 - u[:, 2])
                acc = acc + w * _hash3(i + dx, j + dy, k + dz, seed)
    return acc


def fbm3(p, octaves=4, seed=1, lac=2.03, gain=0.5):
    s, a, tot, f = 0.0, 1.0, 0.0, 1.0
    for o in range(octaves):
        s = s + a * vnoise3(p * f, seed + o * 31)
        tot += a
        a *= gain
        f *= lac
    return s / tot


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


# ---------------------------------------------------------------- clearance against the works
class Clearance:
    """Point-to-box distance against every platform's swept frame boxes (game space)."""

    def __init__(self, L):
        boxes = []
        for p in L['platforms']:
            b = np.array(p['swept'], np.float64).reshape(-1, 6)
            boxes.append(b)
        for k in L['keep']:
            boxes.append(np.array([k['min'] + k['max']], np.float64))
        B = np.concatenate(boxes)
        # merge exact duplicates (stations repeat one pose)
        self.B = np.unique(np.round(B, 3), axis=0)
        self.lo = self.B[:, :3].min(0)
        self.hi = self.B[:, 3:].max(0)

    def dist(self, P, reach=3.0):
        """Distance from each point (N,3) to the nearest box; capped at `reach`."""
        d = np.full(len(P), reach)
        near = np.all((P > self.lo - reach) & (P < self.hi + reach), axis=1)
        idx = np.nonzero(near)[0]
        if len(idx) == 0:
            return d
        Q = P[idx]
        out = np.full(len(idx), reach)
        for b in self.B:
            lo, hi = b[:3], b[3:]
            m = np.all((Q > lo - reach) & (Q < hi + reach), axis=1)
            if not m.any():
                continue
            q = Q[m]
            dd = np.maximum(np.maximum(lo - q, q - hi), 0)
            out[m] = np.minimum(out[m], np.sqrt((dd * dd).sum(1)))
        d[idx] = out
        return d

    def segment_clear(self, a, b, margin):
        n = max(2, int(np.linalg.norm(np.array(b) - np.array(a)) / 0.1) + 1)
        P = np.linspace(np.array(a, np.float64), np.array(b, np.float64), n)
        return bool(np.all(self.dist(P, margin + 0.01) > margin))


# ---------------------------------------------------------------- upsampling
def _cr(p0, p1, p2, p3, t):
    t2, t3 = t * t, t * t * t
    return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)


def up_axis(m, f, ax, periodic):
    m = np.moveaxis(m, ax, 0)
    n = m.shape[0]
    if periodic:
        idx = np.arange(n * f) / f
        i = idx.astype(int)
        t = (idx - i).reshape(-1, *([1] * (m.ndim - 1)))
        g = lambda k: m[(i + k) % n]
    else:
        idx = np.arange((n - 1) * f + 1) / f
        i = np.clip(idx.astype(int), 0, n - 2)
        t = (idx - i).reshape(-1, *([1] * (m.ndim - 1)))
        g = lambda k: m[np.clip(i + k, 0, n - 1)]
    return np.moveaxis(_cr(g(-1), g(0), g(1), g(2), t), 0, ax)


def grid_normals(V, periodic_x=True):
    """Per-vertex normals of a (ny, nx, 3) grid, pointing into the cave (toward the axis)."""
    dx = np.roll(V, -1, 1) - np.roll(V, 1, 1)
    dy = np.empty_like(V)
    dy[1:-1] = V[2:] - V[:-2]
    dy[0] = V[1] - V[0]
    dy[-1] = V[-1] - V[-2]
    n = np.cross(dx, dy)
    n /= np.linalg.norm(n, axis=-1, keepdims=True) + 1e-12
    return n


# ---------------------------------------------------------------- the shell
def shell_grid(L, fy=5, fx=12, throat=2.6):
    """Upsampled game-space shell grid (ny, nx, 3) and the frame table, with a throat added at the top."""
    S = L['shell']
    P = np.array(S['points'][:S['rings'] * S['segs']], np.float64).reshape(S['rings'], S['segs'], 3)[:, :-1]
    # a throat: the chimney goes on up a little and opens to the sky
    top = P[-1]
    c = top.mean(0)
    extra = []
    for k in range(1, 5):
        f = k / 4
        ring = c + (top - c) * (1 - 0.12 * f) + np.array([0, throat * f, 0])
        extra.append(ring)
    P = np.concatenate([P, np.array(extra)], 0)
    V = up_axis(up_axis(P, fy, 0, False), fx, 1, True)
    return V


def sculpt(L, V, clear, rng):
    """Displace the wall (game space). Returns (V, attrs) with attributes thin / rock / dirt per vertex."""
    ny, nx, _ = V.shape
    n = grid_normals(V)
    # orient normals into the cave: toward the vertical axis through the ring's centre
    ctr = V.mean(1, keepdims=True)
    to_axis = ctr - V
    to_axis[..., 1] = 0
    flip = (n * to_axis).sum(-1) < 0
    n[flip] *= -1
    P = V.reshape(-1, 3)
    N = n.reshape(-1, 3)
    y = P[:, 1]
    floor_y = L['shellConst']['floorY']
    top_y = L['shellConst']['top']
    from .glacier import glacier
    d, attrs = glacier(P, N, top_y, floor_y, L['poolY'], rng)
    # frozen waterfalls: lobes poured down the wall from up high, fluted, bulging into the cave
    falls = []
    for k in range(9):
        th = rng.uniform(-math.pi, math.pi)
        y1 = rng.uniform(9, 26)
        y0 = rng.uniform(-0.6, 0.4)
        w = rng.uniform(0.9, 2.2)
        amp = rng.uniform(0.35, 0.9)
        falls.append((th, y0, y1, w, amp))
    ang2 = np.arctan2(P[:, 2] - (-9.4), P[:, 0] - (-0.2))
    fall = np.zeros(len(P))
    for (th, y0, y1, w, amp) in falls:
        da = np.angle(np.exp(1j * (ang2 - th)))
        r = np.hypot(P[:, 0] + 0.2, P[:, 2] + 9.4)
        s = da * r                      # metres round the wall
        along = smoothstep(y1 + 1.0, y1 - 1.5, y) * smoothstep(y0 - 0.5, y0 + 0.8, y)
        wid = w * (0.6 + 0.4 * smoothstep(y1, y0, y))        # widens as it falls
        prof = np.exp(-(s / wid) ** 2)
        # drapery: folds of uneven width (25-70 cm) that wander and merge down the fall, never a comb
        wv = fbm3(P * np.array([0.35, 0.05, 0.35]), 3, 77)
        period = 0.45 + 0.25 * fbm3(P * np.array([0.2, 0.04, 0.2]), 2, 78)
        flute = 1 + 0.22 * np.sin(s / period * 2 * np.pi + wv * 5) * (0.5 + 0.5 * fbm3(P * 0.3, 2, 79))
        bulb = 1 + 0.4 * smoothstep(y0 + 2.0, y0, y)         # it spreads where it meets the pool
        fall = np.maximum(fall, amp * prof * along * flute * bulb)
    d = d - fall * smoothstep(top_y + 2.0, top_y - 1.0, y)
    # ---- clamp inward moves against the works: never crowd a machine (or closer than the game's own wall)
    Pn = P + N * (-d)[:, None]
    dist = clear.dist(Pn, 1.0)
    bad = (dist < 0.45) & (d < 0)
    dmin = np.full(len(d), -1e9)
    dmin[bad] = d[bad] * np.clip((dist[bad] - 0.25) / 0.2, 0, 1)
    d = np.maximum(d, dmin)
    # ease the clamped patches into their surroundings (only there: the relief elsewhere stays crisp)
    near = bad.reshape(ny, nx)
    for _ in range(3):
        near = near | np.roll(near, 1, 0) | np.roll(near, -1, 0) | np.roll(near, 1, 1) | np.roll(near, -1, 1)
    D = d.reshape(ny, nx)
    S_ = D.copy()
    for _ in range(3):
        S_ = 0.5 * S_ + 0.125 * (np.roll(S_, 1, 0) + np.roll(S_, -1, 0) + np.roll(S_, 1, 1) + np.roll(S_, -1, 1))
    d = np.maximum(np.where(near, S_, D).reshape(-1), dmin)
    Pn = P + N * (-d)[:, None]
    # daylight through thin ice: higher up and toward the throat, in patches; brightest where the ice is
    # thinnest (in the cracks, up the moulin, on the falls); never through rock or debris
    patch = smoothstep(0.4, 0.75, 0.5 + 0.5 * fbm3(P * np.array([0.09, 0.05, 0.09]), 4, 99))
    thin = smoothstep(4, 24, y) * (0.05 + 1.1 * patch * patch)
    thin += 0.6 * smoothstep(0.1, 0.5, fall) * smoothstep(1, 12, y)
    thin += 0.45 * attrs['crack'] * smoothstep(6, 18, y) + 0.5 * attrs['moulin'] * smoothstep(8, 22, y)
    thin = np.clip(thin, 0, 1.0) * (1 - attrs['rock']) * (1 - smoothstep(0.3, 0.8, attrs['dirt']))
    thin = np.where(y > top_y - 0.5, 0.0, thin)
    attrs['thin'] = thin
    attrs['fall'] = fall
    return Pn.reshape(ny, nx, 3), attrs, N


def embed(L, V, anchors, falloff=1.1, depth=0.12):
    """Pull the wall out (into the cave) round each anchor point so the beam's end is buried in ice."""
    ny, nx, _ = V.shape
    n = grid_normals(V)
    ctr = V.mean(1, keepdims=True)
    to_axis = ctr - V
    to_axis[..., 1] = 0
    n[(n * to_axis).sum(-1) < 0] *= -1
    P = V.reshape(-1, 3).copy()
    N = n.reshape(-1, 3)
    for a in anchors:
        a = np.asarray(a, np.float64)
        dv = a[None] - P
        dist = np.linalg.norm(dv, axis=1)
        m = dist < falloff * 2.2
        if not m.any():
            continue
        s = (dv[m] * N[m]).sum(1)                 # > 0: the anchor stands in the cave in front of this vertex
        tang = np.sqrt(np.maximum(dist[m] ** 2 - s ** 2, 0))
        w = smoothstep(falloff, falloff * 0.25, tang)
        push = np.maximum(0, s + depth) * w
        P[m] += N[m] * push[:, None]
    return P.reshape(ny, nx, 3)


def to_mesh(name, V, attrs, coll, mat, cap=True):
    """(ny, nx, 3) game-space grid -> Blender mesh (periodic in x), faces toward the cave."""
    ny, nx, _ = V.shape
    B = np.stack([V[..., 0], -V[..., 2], V[..., 1]], -1).reshape(-1, 3)
    I, J = np.meshgrid(np.arange(nx), np.arange(ny - 1))
    a = (J * nx + I).ravel()
    b = (J * nx + (I + 1) % nx).ravel()
    quads = np.stack([a, b, b + nx, a + nx], 1)
    verts = B
    if cap:
        c = V[0].mean(0)
        verts = np.concatenate([B, [[c[0], -c[2], c[1] - 0.3]]])
        ci = len(B)
    me = bpy.data.meshes.new(name)
    me.vertices.add(len(verts))
    me.vertices.foreach_set('co', verts.astype(np.float32).ravel())
    faces = [list(q) for q in quads]
    if cap:
        faces += [[ci, (i + 1) % nx, i] for i in range(nx)]
    loops = np.concatenate([np.array(f) for f in faces])
    me.loops.add(len(loops))
    me.loops.foreach_set('vertex_index', loops.astype(np.int32))
    counts = np.array([len(f) for f in faces], np.int32)
    me.polygons.add(len(faces))
    starts = np.concatenate([[0], np.cumsum(counts)[:-1]]).astype(np.int32)
    me.polygons.foreach_set('loop_start', starts)
    me.polygons.foreach_set('loop_total', counts)
    me.update(calc_edges=True)
    me.polygons.foreach_set('use_smooth', np.ones(len(faces), bool))
    # ShellUV: the wall unrolled round the cave in two halves, one above the other. Per-loop, so the seams
    # need no split vertices.
    h = nx // 2
    ci_, cj_ = I.ravel(), J.ravel()
    lc = np.stack([ci_, ci_ + 1, ci_ + 1, ci_], 1)
    lr = np.stack([cj_, cj_, cj_ + 1, cj_ + 1], 1)
    left = (ci_ < h)[:, None]
    u = np.where(left, lc / h, (lc - h) / (nx - h))
    v = lr / (ny - 1) * 0.495 + np.where(left, 0.0, 0.505)
    uv = np.stack([u, v], -1).reshape(-1, 2)
    if cap:
        uv = np.concatenate([uv, np.full((nx * 3, 2), 0.001)])
    me.uv_layers.new(name='ShellUV').data.foreach_set('uv', uv.astype(np.float32).ravel())
    for k, arr in attrs.items():
        at = me.attributes.new(k, 'FLOAT', 'POINT')
        vals = np.asarray(arr, np.float32).ravel()
        if cap:
            vals = np.concatenate([vals, [vals[:nx].mean()]]).astype(np.float32)
        at.data.foreach_set('value', vals)
    me.validate()
    ob = bpy.data.objects.new(name, me)
    coll.objects.link(ob)
    me.materials.append(mat)
    # faces must look into the cave: test one mid-wall face against the direction to the axis
    me.update()
    k = (ny // 3) * nx
    f = me.polygons[k]
    c = f.center
    ax = Vector((V[ny // 3].mean(0)[0], -V[ny // 3].mean(0)[2], c.z))
    if f.normal.dot(ax - c) < 0:
        me.flip_normals()
    return ob
