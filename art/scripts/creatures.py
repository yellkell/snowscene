"""The horde, modelled: seven creatures of the frozen world, HIGH for look-dev and baking, three realtime LODs each.

  blender -b --factory-startup --python art/scripts/creatures.py -- [--kinds ghoul,brute] [--bake] [--samples 64]

Builds art/work/creatures/creature.blend (every kind on snow at golden hour, one camera CAM_<kind> each, so
`blender -b art/work/creatures/creature.blend --python art/scripts/render.py -- CAM_ghoul ...` writes
art/renders/creature_<kind>.png), writes the LODs to public/survivors/creatures/creatures.glb, and with --bake
bakes the shared atlas (albedo, gloss, emission, object-space normal, AO) from the HIGH meshes into
art/work/creatures/*.npy for art/scripts/creatures_encode.py.

Every piece is a lib/critter.py Piece: one parametric surface sampled densely for HIGH and sparsely for each
LOD, sharing its atlas rectangle, so a LOD reads exactly the texels of the surface it stands for. Each piece
hangs off one rigid part of the game's shader rig (swarm-mesh.ts): BODY 0, LEG 1, HEAD 2, JAW 3, ARM 4, CORE 5,
with a gait beat and a pivot in the creature frame (unit body radius, y up, +z forward).
"""
import bpy, sys, os, math, json, time
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from lib import critter as K, crittermats as CM, snowmats as SM, sky, bakekit as BK
from lib.critter import Piece, Spine, Frame, knots, caps, superellipse, polygon, smoothstep, fbm, ridged, worley, TAU

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
opt = lambda n, d: argv[argv.index(n) + 1] if n in argv else d
ROOT = os.path.dirname(os.path.dirname(HERE))
WORK = os.path.join(ROOT, 'art', 'work', 'creatures')
OUT = os.path.join(ROOT, 'public', 'survivors', 'creatures')
os.makedirs(WORK, exist_ok=True)
os.makedirs(OUT, exist_ok=True)
T0 = time.time()


def log(*a):
    print(f'[{time.time() - T0:7.1f}s]', *a, flush=True)


def lin(hexv):
    """sRGB hex -> linear rgb tuple."""
    c = [((hexv >> s) & 255) / 255.0 for s in (16, 8, 0)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


# game KINDS (src/game/survivors/horde.ts): name, radius, body, accent
KINDS = [('ghoul', 0.42, 0x2c3652, 0xc4e8ff), ('brute', 0.7, 0x4a3830, 0xf0dfc0), ('titan', 1.45, 0x2a2833, 0xffb54a),
         ('bloater', 0.62, 0x3b2a36, 0xff8a3d), ('lunger', 0.5, 0x3a1f28, 0xff5470), ('splitter', 0.78, 0x2a2440, 0xc39bff),
         ('glitterback', 0.55, 0x3d321e, 0xffd166)]
SPACING = 60.0
DENSITY = dict(ghoul=3.0, brute=1.7, titan=1.0, bloater=1.8, lunger=3.0, splitter=1.45, glitterback=2.2)
ATLAS = int(opt('--atlas', 2048))


# ---------------------------------------------------------------- feature helpers
def total(*fs):
    fs = [f for f in fs if f is not None]

    def d(P, N, t, a, high):
        out = np.zeros(P.shape[:-1])
        for f in fs:
            out = out + f(P, N, t, a, high)
        return out
    return d


def noise_d(amp, scale, octaves=4, seed=0, big=False, kind='fbm'):
    fn = {'fbm': fbm, 'ridged': ridged}[kind]

    def d(P, N, t, a, high):
        if not (big or high):
            return 0.0
        oc = octaves if high else max(1, min(2, octaves))
        v = fn(P, scale, oc, seed=seed)
        return amp * (v - (0.5 if kind == 'ridged' else 0.0))
    return d


def bands_d(ts, depth, width, big=False):
    ts = np.asarray(ts, float)

    def g(t):
        return np.clip(sum(np.exp(-((t - tk) / width) ** 2) for tk in ts), 0, 1)

    def d(P, N, t, a, high):
        if not (big or high):
            return 0.0
        return -depth * g(t)
    d.mask = g
    return d


def bumps(piece, spots):
    """Domed bumps (eyes, warts) at (t, a, radius m, height m) on the piece's base surface.
    Returns (disp, mask) callables."""
    t0 = np.array([s[0] for s in spots])
    a0 = np.array([s[1] for s in spots])
    C = np.array([piece.surface(np.array([t]), np.array([a]))[0][0, 0] for t, a in zip(t0, a0)])
    rr = np.array([s[2] for s in spots])
    hh = np.array([s[3] for s in spots])

    def field(P):
        dm = np.zeros(P.shape[:-1])
        mk = np.zeros(P.shape[:-1])
        for c, r, h in zip(C, rr, hh):
            dist = np.linalg.norm(P - c, axis=-1)
            u = np.clip(1 - (dist / r) ** 2, 0, 1)
            dm = np.maximum(dm, h * np.sqrt(u))
            mk = np.maximum(mk, smoothstep(r * 1.02, r * 0.8, dist))
        return dm, mk

    def d(P, N, t, a, high):
        return field(P)[0]
    return d, (lambda P: field(P)[1])


def leg_frame_up(H, Fo, Kn):
    """Section 'up' for a leg: in the plane of the leg, on the outside of its bend (the leg's back)."""
    B = np.cross(Fo - H, np.array([0.0, 0.0, 1.0]))
    B /= np.linalg.norm(B)
    T = Kn - H
    T /= np.linalg.norm(T)
    sgn = 1.0 if np.cross(T, B)[2] >= 0 else -1.0
    return lambda p, T: np.cross(T, B) * sgn


# ---------------------------------------------------------------- piece builders
class Kind:
    def __init__(self, idx):
        name, R, body, accent = KINDS[idx]
        self.idx, self.name, self.R = idx, name, R
        self.body, self.accent = lin(body), lin(accent)
        self.F = Frame(R)
        self.pieces = []
        self.neck = (0, 0.5, 0.5)
        self.origin = (idx * SPACING, 0.0, 0.0)
        # texel density per kind (relative): the small kinds are seen closest and most often
        self.density = DENSITY[name]
        self.rock_scale, self.rock_ext = 1.0, 0.0

    def add(self, p):
        p.density *= self.density
        p.kind = self
        self.pieces.append(p)
        return p

    def loft(self, name, pts, w, up, down, mat, e=2.0, k0=0.1, k1=0.1, p0=0.5, p1=0.5, res=(96, 120),
             lods=((8, 8), (6, 5), (4, 3)), rig=('BODY', 0, (0, 0, 0)), side=None, upv=(0, 0, 1), cluster=0.5,
             glow=0.0, high_only=False, disp=None, masks=None):
        """A lofted segment: game-unit spine points, profile knots (callables of t, in game units)."""
        F = self.F
        sp = Spine([F(*p) for p in pts], up=upv)
        cap = lambda t: caps(t, k0, k1, p0, p1)
        W = lambda t: w(t) * self.R * cap(t)
        U = lambda t: up(t) * self.R * cap(t)
        D = lambda t: down(t) * self.R * cap(t)
        p = Piece(f'{self.name}_{name}', sp, superellipse(W, U, D, e, side), res, list(lods), mat, disp=disp,
                  masks=masks, rig=rig, glow=glow, cluster=cluster, high_only=high_only)
        return self.add(p)

    def limb(self, name, pts, radii, mat, rig, res=(24, 140), lod_n=(5, 4, 3), joints=None, knob=0.22, pinch=0.2,
             bulge=0.12, tip=0.35, flat=0.92, up=None, spines=0, spine_len=0.07, high_only=False, glow=0.0,
             disp=None, masks=None, tipmask=0.0):
        """A jointed limb through game-unit points `pts` with radii at each point (unit). Joints are the inner
        points: a knob before each, a pinched articulation after, each segment swelling in its middle."""
        F = self.F
        P = [F(*p) for p in pts]
        upf = up or leg_frame_up(P[0], P[-1], P[len(P) // 2])
        sp = Spine(P, up=upf, per=48)
        # t of each control point along the spine
        tj = []
        for q in P:
            k = int(np.argmin(np.linalg.norm(sp.D - q, axis=1)))
            tj.append(sp.s[k] / sp.L)
        tj[0], tj[-1] = 0.0, 1.0
        rk = knots(*[(t, r * self.R) for t, r in zip(tj, radii)])
        inner = tj[1:-1]
        tipk = (1 - tj[-2]) * tip

        def radius(t):
            r = rk(t)
            # swell mid-segment
            seg = np.searchsorted(tj, t, side='right') - 1
            seg = np.clip(seg, 0, len(tj) - 2)
            t0 = np.asarray(tj)[seg]
            t1 = np.asarray(tj)[seg + 1]
            u = (t - t0) / np.maximum(t1 - t0, 1e-6)
            r = r * (1 + bulge * np.sin(np.pi * np.clip(u, 0, 1)))
            for j in inner:
                w = 0.012
                r = r * (1 + knob * np.exp(-((t - (j - 0.6 * w)) / w) ** 2) - pinch * np.exp(-((t - (j + 1.4 * w)) / (0.8 * w)) ** 2))
            return r * caps(t, 0.02, tipk, 0.5, 0.9)
        ridge = lambda t, a: 1 + 0.05 * np.exp(-((a - np.pi) / 0.4) ** 2)
        sec = superellipse(radius, lambda t: radius(t) * 1.0, lambda t: radius(t) * flat, 2.15, ridge)
        segl = [tj[i + 1] - tj[i] for i in range(len(tj) - 1)]
        longest = sorted(range(len(segl)), key=lambda i: -segl[i])[:2]
        mids = [(tj[i] + tj[i + 1]) / 2 for i in longest]
        ts0 = sorted(set([0.0] + tj[1:-1] + mids + [1.0]))
        ts1 = sorted(set([0.0] + [tj[i] for i in range(1, len(tj) - 1) if not (i == 1 and len(tj) >= 5)] + [1.0]))
        if len(ts1) < 3:
            ts1 = [0.0, tj[len(tj) // 2], 1.0]
        kn = int(np.argmax([np.dot(F(*pts[i]), [0, 0, 1]) for i in range(len(pts))]))
        ts2 = [0.0, tj[kn] if 0 < kn < len(tj) - 1 else tj[1], 1.0]
        lods = [(lod_n[0], ts0), (lod_n[1], ts1), (lod_n[2], ts2) if lod_n[2] else None]

        def groove_mask(Pp, N, t, a, d):
            g = np.zeros_like(t)
            for j in inner:
                g = np.maximum(g, np.exp(-((t - (j + 0.012)) / 0.012) ** 2))
            out = {'groove': g}
            if tipmask:
                out['tip'] = smoothstep(1 - tipmask, 1 - tipmask * 0.3, t)
            if masks is not None:
                out.update(masks(Pp, N, t, a, d))
            return out
        p = Piece(f'{self.name}_{name}', sp, sec, res, lods, mat, disp=disp, masks=groove_mask, rig=rig, glow=glow,
                  cluster=0.15, high_only=high_only)
        p.joints = tj
        self.add(p)
        if spines:
            self.spines_on(p, spines, spine_len, mat, tj)
        return p

    def spines_on(self, p, count, length, mat, tj, a_span=1.3, seed=0):
        rng = np.random.default_rng(hash(p.name) & 0xFFFF)
        t0, t1 = tj[1] + 0.03, tj[-2]
        for k in range(count):
            t = t0 + (t1 - t0) * (k + rng.uniform(0.2, 0.8)) / count
            a = np.pi + rng.uniform(-a_span, a_span)
            S, C, T = p.surface(np.array([t]), np.array([a]))
            base = S[0, 0]
            nrm = base - C[0]
            nrm /= np.linalg.norm(nrm)
            L = length * self.R * rng.uniform(0.7, 1.2)
            dirv = nrm * 0.75 + T[0] * 0.65
            dirv /= np.linalg.norm(dirv)
            tipp = base + dirv * L
            mid = base + (nrm * 0.9 + T[0] * 0.3) / np.linalg.norm(nrm * 0.9 + T[0] * 0.3) * L * 0.45
            r0 = L * 0.09
            sp = Spine([base - nrm * r0, mid, tipp], up=lambda q, Tt: np.cross(Tt, np.cross(nrm, Tt) + 1e-6))
            rf = lambda t, r0=r0: r0 * (1 - t) ** 0.85 * caps(t, 0.05, 0.0)
            self.add(Piece(f'{p.name}_sp{k}', sp, superellipse(rf, rf, rf), (10, 16), [None, None, None], mat,
                           high_only=True))

    def crystal(self, name, base, dirv, r, length, sides, mat, rig=('BODY', 0, (0, 0, 0)), lods=(True, True, False),
                glow=1.0, phase=0.0, shoulder=0.72, tilt=None):
        """A gem/ice crystal: prism with a pyramidal termination, base buried. `base`, `dirv`: Blender metres."""
        base = np.asarray(base, float)
        dirv = np.asarray(dirv, float) / np.linalg.norm(dirv)
        sp = Spine([base - dirv * r * 0.6, base + dirv * length], up=lambda q, T: np.cross(T, [0.31, 0.53, 0.79]))

        def rf(t):
            t = np.asarray(t, float)
            body = np.where(t < shoulder, 0.88 + 0.12 * t / shoulder, np.clip((1 - t) / (1 - shoulder), 0, 1))
            return r * body * np.clip(t / 0.02, 0, 1) ** 0.5
        ts = [0.0, 0.02, shoulder, 1.0]
        lod = [(sides, ts) if lods[0] else None, (max(3, sides - 1), ts) if lods[1] else None,
               (3, [0.0, shoulder, 1.0]) if lods[2] else None]
        p = Piece(f'{self.name}_{name}', sp, polygon(rf, sides, phase), (sides * 8, 40), lod, mat, rig=rig, glow=glow,
                  cluster=0.0)
        p.flatish = True
        return self.add(p)

    def blob(self, name, c, radii, mat, rig=('BODY', 0, (0, 0, 0)), res=(64, 48), lods=((8, 7), (6, 5), (4, 3)),
             axis=(0, 0, 1), disp=None, masks=None, glow=0.0, e=2.0, high_only=False):
        """An ellipsoid-ish closed body round game-unit centre c, radii (x, y, z) game units, spine along game z."""
        cx, cy, cz = c
        rx, ry, rz = radii
        pts = [(cx, cy, cz - rz), (cx, cy, cz + rz)]
        return self.loft(name, pts, lambda t: np.full_like(t, rx), lambda t: np.full_like(t, ry),
                         lambda t: np.full_like(t, ry), mat, e=e, k0=0.5, k1=0.5, res=res, lods=lods, rig=rig,
                         disp=disp, masks=masks, glow=glow, high_only=high_only, cluster=0.0)

    def surface_point(self, p, t, a, out=0.0):
        S, C, T = p.surface(np.array([t]), np.array([a]))
        n = S[0, 0] - C[0]
        n /= max(np.linalg.norm(n), 1e-9)
        return S[0, 0] + n * out, n, T[0]


# ---------------------------------------------------------------- the ghoul
def ghoul():
    k = Kind(0)
    F, R = k.F, k.R
    acc = k.accent
    chit = dict(base=(0.022, 0.026, 0.036), alt=(0.045, 0.05, 0.066), edge=(0.13, 0.135, 0.15),
                frost_amt=0.9, scale=1.0 / R * 0.42, tip_col=(0.2, 0.28, 0.36), tip_gloss=0.95, tip_emit=0.35,
                accent=acc, eye_emit=0.1, glow_str=1.0, gloss=0.5)
    icek = dict(tint=(0.88, 0.96, 1.0), absorb=(0.3, 0.62, 1.0), density=16.0, rough=0.04, frost_amt=0.22,
                rt_albedo=(0.13, 0.24, 0.36), accent=acc, glow_str=0.9, scale=2.0)
    m_chit = CM.chitin('ghoul_chitin', **chit)
    m_crust = CM.chitin_ice('ghoul_crust', chit, icek)
    m_ice = CM.ice('ghoul_shard', **dict(icek, glow_str=1.6))
    k.neck = (0, 0.58, 0.44)

    # abdomen (opisthosoma): a bulbous sac under a crust of plated blue ice
    ab_pts = [(0, 0.57, -0.08), (0, 0.67, -0.5), (0, 0.63, -1.0), (0, 0.5, -1.4)]
    ab_w = knots((0, 0.16), (0.12, 0.36), (0.45, 0.5), (0.78, 0.42), (1, 0.2))
    ab_u = knots((0, 0.12), (0.12, 0.32), (0.45, 0.4), (0.78, 0.32), (1, 0.14))
    ab_d = knots((0, 0.12), (0.12, 0.25), (0.45, 0.31), (0.78, 0.25), (1, 0.1))

    def crust_zone(P, t, a):
        edge = np.cos(a - np.pi) - 0.05 + 0.45 * fbm(P, 3.2 / R * 0.42, 3, seed=3)
        return smoothstep(-0.12, 0.18, edge) * smoothstep(0.1, 0.24, t) * smoothstep(0.98, 0.86, t)

    def cells(P):
        warp = np.stack([fbm(P, 4.0, 3, seed=s_) for s_ in (11, 12, 13)], -1) * 0.05
        Pw = P + warp
        F1, F2, ID = worley(Pw, 8.0 / R * 0.42, seed=5)
        G1, G2, _ = worley(Pw, 21.0 / R * 0.42, seed=6)
        crk = np.maximum(1 - smoothstep(0.0, 0.06, F2 - F1), 0.5 * (1 - smoothstep(0.0, 0.05, G2 - G1)))
        return crk, ID

    def crust(P, N, t, a, high):
        z = crust_zone(P, t, a)
        thick = 0.075 * R
        if not high:
            return thick * 0.72 * z
        crk, ID = cells(P)
        h = thick * z * (0.45 + 0.55 * ID) * (1 - 0.7 * crk)
        h += 0.015 * R * z * fbm(P, 25.0, 4, seed=6)
        return h

    bands = bands_d([0.2, 0.32, 0.45, 0.58, 0.7, 0.82], 0.012 * R, 0.018)

    def ab_masks(P, N, t, a, d):
        Pb = P - N * d[..., None]
        z = crust_zone(Pb, t, a)
        crk, ID = cells(Pb)
        deep = smoothstep(0.55, 0.9, z) * smoothstep(0.1, 0.5, fbm(Pb, 5.0, 2, seed=9))
        return {'ice': smoothstep(0.25, 0.55, z), 'groove': np.maximum(bands.mask(t) * (1 - z), crk * z * 0.6),
                'glow': crk * deep}
    ab = k.loft('abdomen', ab_pts, ab_w, ab_u, ab_d, m_crust, e=2.0, k0=0.1, k1=0.16, res=(128, 150),
                lods=((12, 13), (7, 6), (5, 4)), disp=total(crust, bands, noise_d(0.006 * R, 7.0, 3, seed=2)),
                masks=ab_masks)
    # what the crust is seen through
    k.loft('abdomen_core', ab_pts, lambda t: ab_w(t) * 0.97, lambda t: ab_u(t) * 0.97, lambda t: ab_d(t) * 0.97,
           m_chit, k0=0.1, k1=0.16, res=(96, 100), high_only=True, disp=total(bands), lods=(None, None, None),
           masks=lambda P, N, t, a, d: {'groove': bands.mask(t)})
    # ice shards growing out of the crust along the spine
    shards = [(0.34, np.pi + 0.15, 0.07, 0.42, (0.1, 1.0, -0.35)), (0.47, np.pi - 0.35, 0.06, 0.34, (-0.45, 1.0, -0.2)),
              (0.5, np.pi + 0.45, 0.055, 0.3, (0.5, 1.0, -0.25)), (0.62, np.pi + 0.05, 0.075, 0.46, (0.0, 1.0, -0.55)),
              (0.74, np.pi - 0.3, 0.05, 0.26, (-0.35, 0.9, -0.6)), (0.8, np.pi + 0.35, 0.045, 0.22, (0.35, 0.9, -0.7))]
    for i, (t, a, r, L, dv) in enumerate(shards):
        base, n, T = k.surface_point(ab, t, a, out=0.03 * R)
        dvb = np.array([dv[0], -dv[2], dv[1]], float)
        k.crystal(f'shard{i}', base, dvb, r * R, L * R, 5, m_ice, lods=(True, i in (0, 3, 1), i == 3),
                  glow=1.0, phase=i * 0.7)

    # cephalothorax (prosoma): a low domed shield the legs root under
    th_w = knots((0, 0.24), (0.4, 0.33), (1, 0.25))
    th_u = knots((0, 0.15), (0.45, 0.2), (1, 0.15))
    th_d = knots((0, 0.14), (1, 0.14))
    fov = lambda P, N, t, a, high: (-0.012 * R * np.exp(-((t - 0.42) / 0.07) ** 2) * np.exp(-((a - np.pi) / 0.18) ** 2)) if high else 0.0
    furrow = lambda P, N, t, a, high: (-0.006 * R * np.clip(np.cos((a - np.pi) * 5.0) ** 8, 0, 1) * smoothstep(0.1, 0.4, t) * (np.cos(a - np.pi) > 0.2)) if high else 0.0
    k.loft('thorax', [(0, 0.6, -0.14), (0, 0.64, 0.16), (0, 0.6, 0.47)], th_w, th_u, th_d, m_chit, e=2.4, k0=0.22,
           k1=0.25, res=(96, 80), lods=((10, 7), (6, 4), (4, 3)), disp=total(fov, furrow, noise_d(0.004 * R, 10.0, 4, seed=4)),
           masks=lambda P, N, t, a, d: {'groove': np.clip(-d / (0.008 * R), 0, 1)})

    # head: eye turret over the chelicerae; eight eyes
    head = k.loft('head', [(0, 0.6, 0.38), (0, 0.62, 0.68), (0, 0.53, 0.98)], knots((0, 0.24), (0.5, 0.21), (1, 0.1)),
                  knots((0, 0.17), (0.45, 0.16), (1, 0.07)), knots((0, 0.15), (1, 0.08)), m_chit, e=2.2, k0=0.25,
                  k1=0.35, res=(112, 100), lods=((10, 7), (6, 4), (4, 3)), rig=('HEAD', 0, k.neck))
    eyes = [(0.62, np.pi - 0.28, 0.052, 0.034), (0.62, np.pi + 0.28, 0.052, 0.034),
            (0.66, np.pi - 0.75, 0.034, 0.02), (0.66, np.pi + 0.75, 0.034, 0.02),
            (0.42, np.pi - 0.2, 0.03, 0.018), (0.42, np.pi + 0.2, 0.03, 0.018),
            (0.46, np.pi - 0.95, 0.028, 0.016), (0.46, np.pi + 0.95, 0.028, 0.016)]
    ed, em = bumps(head, [(t, a, r * R, h * R) for t, a, r, h in eyes])
    head.disp = total(ed, noise_d(0.003 * R, 14.0, 3, seed=8))
    head.masks = lambda P, N, t, a, d: {'eye': em(P - N * d[..., None])}

    # chelicerae: a pair of heavy pincers, ice-glass fangs
    for sx in (-1, 1):
        base = (sx * 0.1, 0.5, 0.86)
        k.limb(f'chelicera{"LR"[sx > 0]}', [base, (sx * 0.15, 0.47, 1.06), (sx * 0.09, 0.41, 1.24), (sx * 0.02, 0.34, 1.33)],
               [0.075, 0.065, 0.04, 0.008], m_chit, ('JAW', 0, base), res=(24, 80), lod_n=(5, 4, None), knob=0.1,
               pinch=0.08, bulge=0.2, tip=0.8, tipmask=0.45)
    # pedipalps: feelers out ahead and up
    for sx in (-1, 1):
        k.limb(f'palp{"LR"[sx > 0]}', [(sx * 0.14, 0.52, 0.8), (sx * 0.3, 0.66, 0.98), (sx * 0.43, 0.82, 1.15),
                                       (sx * 0.52, 0.88, 1.33)],
               [0.045, 0.04, 0.034, 0.026], m_chit, ('HEAD', 0, k.neck), res=(20, 90), lod_n=(4, 3, None), tip=0.25,
               spines=4, spine_len=0.05)
    # eight legs (alternating tetrapod: L1 R2 L3 R4 | R1 L2 R3 L4), knees high over the back
    legs = [(0.32, (0.75, 1.0, 0.75), (1.15, 0, 1.38)), (0.2, (0.98, 1.1, 0.28), (1.68, 0, 0.42)),
            (0.08, (0.95, 1.06, -0.3), (1.6, 0, -0.62)), (-0.04, (0.72, 0.98, -0.62), (1.18, 0, -1.3))]
    for i, (z, kn, ft) in enumerate(legs):
        for sx in (-1, 1):
            hip = (sx * 0.24, 0.57, z)
            beat = 0 if ((i % 2 == 0) == (sx < 0)) else 1
            K_ = (sx * kn[0], kn[1], kn[2])
            Fo = (sx * ft[0], ft[1], ft[2])
            cox = (hip[0] + sx * 0.12, 0.62, z + (kn[2] - z) * 0.1)
            ank = tuple(np.array(K_) + (np.array(Fo) - np.array(K_)) * 0.5 + np.array([sx * 0.07, 0.07, 0.0]))
            tar = tuple(np.array(ank) + (np.array(Fo) - np.array(ank)) * 0.62 + np.array([sx * 0.02, 0.02, 0.0]))
            k.limb(f'leg{i}{"LR"[sx > 0]}', [hip, cox, K_, ank, tar, Fo], [0.07, 0.068, 0.056, 0.036, 0.024, 0.01],
                   m_chit, ('LEG', beat, hip), res=(24, 170), lod_n=(5, 4, 3), spines=18, spine_len=0.1)
    return k


def icicle(k, name, base, L, r, mat, rig=('BODY', 0, (0, 0, 0)), lod=True, seed=0):
    """An icicle hanging from `base` (Blender metres): tapering, a little lumpy, a drip bead at its tip."""
    base = np.asarray(base, float)
    rng = np.random.default_rng(seed)
    bend = np.array([rng.uniform(-0.15, 0.15), rng.uniform(-0.15, 0.15), 0]) * L
    sp = Spine([base + [0, 0, r * 0.8], base - [0, 0, L * 0.5] + bend * 0.5, base - [0, 0, L] + bend],
               up=(1, 0, 0))
    rf = lambda t: r * ((1 - t) ** 1.15 * (1 + 0.12 * np.sin(t * 37.0 + seed)) + 0.06 * np.exp(-((t - 0.97) / 0.03) ** 2)) * caps(t, 0.08, 0.02, 0.5, 1.0)
    p = Piece(f'{k.name}_{name}', sp, superellipse(rf, rf, rf), (16, 40),
              [(4, [0.0, 0.08, 0.5, 1.0]) if lod else None, None, None], mat, rig=rig, cluster=0.0,
              disp=noise_d(0.08 * r, 60.0, 3, seed=seed),
              masks=lambda P, N, t, a, d: {'ice': np.ones_like(t)})
    return k.add(p)


def beetle(idx, stretch=(1, 1, 1), chit=None, horn_tip=None, mandible_tip=None, extras=None):
    """The beetle body plan (brute, splitter, glitterback): domed elytra scored with striae, a shield of a
    pronotum, a broad head with compound eyes, a horn, sickle mandibles, six thick digging legs."""
    k = Kind(idx)
    F, R = k.F, k.R
    sx_, sy_, sz_ = stretch
    S = lambda x, y, z: (x * sx_, y * sy_, z * sz_)
    rs = (sx_ * sy_ * sz_) ** (1 / 3)
    m_chit = CM.chitin(f'{k.name}_chitin', **chit)
    k.neck = S(0, 0.5, 0.72)

    # elytra over the abdomen: one domed shell, split down the middle, striae with rows of punctures
    el_pts = [S(0, 0.43, 0.36), S(0, 0.46, -0.25), S(0, 0.44, -0.8), S(0, 0.42, -1.18)]
    ew = knots((0, 0.7), (0.3, 0.88), (0.62, 0.8), (0.88, 0.52), (1, 0.24))
    eu = knots((0, 0.36), (0.3, 0.45), (0.6, 0.42), (0.88, 0.28), (1, 0.1))
    ed = knots((0, 0.26), (0.3, 0.29), (0.6, 0.26), (0.9, 0.16), (1, 0.08))

    def striae(P, N, t, a, high):
        if not high:
            return 0.0
        da = a - np.pi
        dorsal = smoothstep(1.55, 1.25, np.abs(da))
        ph = (np.abs(da) / 0.19) % 1.0
        g = np.exp(-((ph - 0.5) / 0.1) ** 2) * dorsal * smoothstep(0.02, 0.1, t) * smoothstep(0.99, 0.9, t)
        suture = np.exp(-(da / 0.025) ** 2) * smoothstep(0.03, 0.1, t)
        F1, _, _ = worley(P, 70.0 / R, seed=21)
        pits = smoothstep(0.32, 0.0, F1) * g
        rim = np.exp(-((np.abs(da) - 1.5) / 0.05) ** 2)
        return (-0.012 * g - 0.014 * suture - 0.005 * pits + 0.01 * rim) * R + 0.004 * R * fbm(P, 12.0, 3, seed=22)

    def el_masks(P, N, t, a, d):
        da = a - np.pi
        dorsal = smoothstep(1.55, 1.25, np.abs(da))
        ph = (np.abs(da) / 0.19) % 1.0
        g = np.exp(-((ph - 0.5) / 0.12) ** 2) * dorsal
        suture = np.exp(-(da / 0.04) ** 2)
        return {'groove': np.clip(g * 0.7 + suture, 0, 1)}
    humps = lambda P, N, t, a, high: 0.03 * R * np.exp(-((t - 0.12) / 0.08) ** 2) * np.exp(-((np.abs(a - np.pi) - 0.9) / 0.3) ** 2)
    el = k.loft('elytra', el_pts, lambda t: ew(t) * sx_, lambda t: eu(t) * sy_, lambda t: ed(t) * sy_, m_chit, e=2.6,
                k0=0.06, k1=0.14, res=(160, 140), lods=((14, 12), (8, 6), (5, 4)), disp=total(striae, humps),
                masks=el_masks)
    k.elytra = el
    # pronotum: the shield, punctured, with a margin and a midline
    def pro_d(P, N, t, a, high):
        if not high:
            return 0.0
        F1, _, _ = worley(P, 45.0 / R, seed=23)
        mid = np.exp(-((a - np.pi) / 0.04) ** 2) * smoothstep(0.1, 0.3, t)
        return (-0.004 * smoothstep(0.3, 0.0, F1) - 0.006 * mid) * R + 0.003 * R * fbm(P, 9.0, 3, seed=24)
    k.loft('pronotum', [S(0, 0.6, 0.86), S(0, 0.64, 0.5), S(0, 0.58, 0.14)],
           lambda t: knots((0, 0.48), (0.35, 0.66), (1, 0.72))(t) * sx_, lambda t: knots((0, 0.2), (0.5, 0.33), (1, 0.28))(t) * sy_,
           lambda t: knots((0, 0.18), (1, 0.2))(t) * sy_, m_chit, e=2.6, k0=0.22, k1=0.1, res=(128, 90),
           lods=((12, 8), (6, 5), (5, 3)), disp=pro_d,
           masks=lambda P, N, t, a, d: {'groove': np.exp(-((a - np.pi) / 0.05) ** 2) * smoothstep(0.1, 0.3, t)})
    # head, with big compound eyes on its shoulders
    head = k.loft('head', [S(0, 0.48, 0.66), S(0, 0.48, 0.88), S(0, 0.42, 1.1)], lambda t: knots((0, 0.38), (0.5, 0.36), (1, 0.22))(t) * sx_,
                  lambda t: knots((0, 0.18), (1, 0.1))(t) * sy_, lambda t: knots((0, 0.14), (1, 0.08))(t) * sy_, m_chit, e=2.3,
                  k0=0.2, k1=0.3, res=(112, 80), lods=((10, 6), (6, 4), (4, 3)), rig=('HEAD', 0, k.neck))
    ed_, em_ = bumps(head, [(0.42, np.pi - 1.25, 0.1 * R * rs, 0.055 * R * rs), (0.42, np.pi + 1.25, 0.1 * R * rs, 0.055 * R * rs)])
    head.disp = total(ed_, noise_d(0.003 * R, 14.0, 3, seed=25))
    head.masks = lambda P, N, t, a, d: {'eye': em_(P - N * d[..., None])}
    # the horn, curving up off the brow
    horn_pts = [S(0, 0.52, 0.86), S(0, 0.78, 1.04), S(0, 1.02, 1.12), S(0, 1.1, 1.06)]
    k.limb('horn', horn_pts, [0.11 * rs, 0.075 * rs, 0.04 * rs, 0.008], m_chit, ('HEAD', 0, k.neck), res=(28, 80),
           lod_n=(6, 4, None), knob=0.0, pinch=0.0, bulge=0.05, tip=0.5, tipmask=0.85 if horn_tip else 0.0, up=lambda p, T: np.cross(T, [1, 0, 0]))
    # mandibles: out, then hooked in, teeth on the inner edge
    for sx in (-1, 1):
        base = S(sx * 0.22, 0.42, 1.0)
        pts = [base, S(sx * 0.4, 0.43, 1.24), S(sx * 0.36, 0.41, 1.44), S(sx * 0.13, 0.39, 1.58)]
        k.limb(f'mandible{"LR"[sx > 0]}', pts, [0.09 * rs, 0.075 * rs, 0.05 * rs, 0.006], m_chit, ('JAW', 0, base),
               res=(24, 90), lod_n=(5, 4, None), knob=0.05, pinch=0.05, bulge=0.15, tip=0.6, flat=0.65,
               tipmask=0.6 if mandible_tip else 0.0, up=lambda p, T: np.cross(T, [0, 0, 1]) * 0 + np.array([0, 0, 1.0]))
        # clubbed antennae
        ab = S(sx * 0.26, 0.5, 1.0)
        k.limb(f'antenna{"LR"[sx > 0]}', [ab, S(sx * 0.42, 0.62, 1.08), S(sx * 0.52, 0.66, 1.2), S(sx * 0.56, 0.64, 1.28)],
               [0.03 * rs, 0.022 * rs, 0.022 * rs, 0.04 * rs], m_chit, ('HEAD', 0, k.neck), res=(16, 60),
               lod_n=(4, 3, None), knob=0.25, pinch=0.2, bulge=0.1, tip=0.4)
    # six digging legs: thick femora, toothed tibiae, segmented tarsi with claws
    legs = [(0.3, (0.92, 0.62, 0.62), (1.18, 0, 0.98)), (-0.05, (1.06, 0.66, -0.02), (1.38, 0, 0.06)),
            (-0.4, (0.96, 0.62, -0.62), (1.22, 0, -1.02))]
    for i, (z, kn, ft) in enumerate(legs):
        for sx in (-1, 1):
            hip = S(sx * 0.48, 0.34, z)
            beat = 0 if ((i % 2 == 0) == (sx < 0)) else 1
            K_ = np.array(S(sx * kn[0], kn[1], kn[2]))
            Fo = np.array(S(sx * ft[0], ft[1], ft[2]))
            H = np.array(hip)
            cox = H + (K_ - H) * 0.18 + np.array([0, -0.04, 0])
            tib = K_ + (Fo - K_) * 0.72 + np.array([sx * 0.05, 0.02, 0])
            k.limb(f'leg{i}{"LR"[sx > 0]}', [hip, tuple(cox), tuple(K_), tuple(tib), tuple(Fo)],
                   [0.1 * rs, 0.095 * rs, 0.07 * rs, 0.05 * rs, 0.012], m_chit, ('LEG', beat, hip), res=(28, 150),
                   lod_n=(5, 4, 3), knob=0.18, pinch=0.25, bulge=0.28, flat=0.62, spines=9, spine_len=0.12)
    if extras:
        extras(k, el, S, rs)
    return k


def brute():
    acc = lin(0xf0dfc0)
    chit = dict(base=(0.026, 0.018, 0.013), alt=(0.05, 0.034, 0.024), edge=(0.2, 0.15, 0.11), gloss=0.7, frost_amt=1.0, frost_groove=0.9,
                tip_col=(0.62, 0.54, 0.4), tip_gloss=0.6, accent=acc, eye_emit=0.05, membrane=(0.07, 0.055, 0.045))

    def ice_hang(k, el, S, rs):
        m_ice = CM.ice('brute_ice', tint=(0.85, 0.94, 1.0), rt_albedo=(0.2, 0.27, 0.34), frost_amt=0.4, scale=2.0)
        rng = np.random.default_rng(4)
        for j, (t, side) in enumerate([(0.55, -1), (0.66, 1), (0.74, -1), (0.8, 1), (0.88, -1), (0.47, 1), (0.92, 1)]):
            a = np.pi + side * 1.5
            base, n, T = k.surface_point(el, t, a, out=-0.01 * k.R)
            icicle(k, f'icicle{j}', base, k.R * rng.uniform(0.12, 0.28), k.R * rng.uniform(0.025, 0.04), m_ice,
                   lod=j < 5, seed=j)
    return beetle(1, (1, 1, 1), chit, horn_tip=True, mandible_tip=True, extras=ice_hang)


def splitter():
    acc = lin(0xc39bff)
    chit = dict(base=(0.022, 0.016, 0.03), alt=(0.04, 0.028, 0.055), edge=(0.15, 0.12, 0.18), gloss=0.7, frost_amt=0.85, frost_groove=0.8,
                tip_col=(0.18, 0.12, 0.22), tip_gloss=0.8, accent=acc, eye_emit=0.08, membrane=(0.06, 0.045, 0.07))

    def sacs(k, el, S, rs):
        m_sac = CM.membrane('splitter_sac', base=(0.32, 0.16, 0.5), vein=(0.08, 0.025, 0.1), plate=(0.04, 0.03, 0.05),
                            accent=acc, glow_str=3.0, scale=1.6, eggs=True)
        for j, (x, z, r) in enumerate([(-0.3, -0.22, 0.29), (0.3, -0.22, 0.29), (0, -0.68, 0.32)]):
            c = S(x, 0.9, z)
            sc_ = 4.2 / (k.R * r)

            def egg_d(P, N, t, a, high, j=j, sc_=sc_, r=r):
                F1, F2, ID = worley(P, sc_, seed=31 + j)
                bulge = 0.09 * r * k.R * np.clip(1 - (F1 / 0.62) ** 2, 0, 1) ** 0.5 - 0.03 * r * k.R * (1 - smoothstep(0.0, 0.1, F2 - F1))
                return bulge if high else 0.025 * r * k.R

            def egg_m(P, N, t, a, d, j=j, sc_=sc_):
                F1, F2, ID = worley(P - N * d[..., None], sc_, seed=31 + j)
                return {'glow': smoothstep(0.58, 0.05, F1) * (0.55 + 0.45 * ID)}
            k.blob(f'sac{j}', c, (r * 0.95, r * 0.82, r), m_sac, rig=('CORE', 0, (0, 0, 0)), res=(96, 72),
                   lods=((9, 7), (6, 5), (4, 3)), disp=egg_d, masks=egg_m, glow=1.0)
    return beetle(5, (1.12, 1.15, 1.05), chit, extras=sacs)


def glitterback():
    acc = lin(0xffd166)
    chit = dict(base=(0.05, 0.04, 0.012), alt=(0.09, 0.07, 0.02), edge=(0.25, 0.2, 0.1), gloss=0.85, frost_amt=0.6,
                metallic=0.7, film=520.0, tip_col=(0.08, 0.06, 0.02), accent=acc, eye_emit=0.05,
                membrane=(0.05, 0.04, 0.02))

    def gems(k, el, S, rs):
        m_gem = CM.crystal('glitter_gem', tint=(1.0, 0.78, 0.32), accent=acc, glow_str=3.0, ior=1.55,
                           rt_albedo=(0.55, 0.38, 0.12))
        rng = np.random.default_rng(9)
        mains = [(0.38, np.pi, 0.2, 0.75), (0.55, np.pi - 0.6, 0.15, 0.55), (0.55, np.pi + 0.6, 0.15, 0.55),
                 (0.2, np.pi - 0.45, 0.13, 0.45), (0.2, np.pi + 0.45, 0.13, 0.5), (0.78, np.pi, 0.14, 0.45)]
        for j, (t, a, r, L) in enumerate(mains):
            base, n, T = k.surface_point(el, t, a, out=0.0)
            up = np.array([0, 0, 1.0])
            dv = n * 0.5 + up * 0.8 - T * 0.15
            k.crystal(f'gem{j}', base, dv, r * k.R * 0.9, L * k.R * 0.9, 6, m_gem, lods=(True, True, j < 3),
                      glow=1.0, phase=rng.uniform(0, 1))
            for s in range(2):
                off = rng.uniform(-0.25, 0.25, 3)
                dv2 = dv / np.linalg.norm(dv) + off + n * 0.4
                k.crystal(f'gem{j}_{s}', base + (rng.uniform(-1, 1, 3) * [1, 1, 0]) * r * k.R * 0.6, dv2,
                          r * k.R * rng.uniform(0.35, 0.55), L * k.R * rng.uniform(0.35, 0.6), 5, m_gem,
                          lods=(True, False, False), glow=1.0, phase=rng.uniform(0, 1))
    return beetle(6, (0.9, 0.9, 0.9), chit, extras=gems)


def rock_d(center, size, seed, cuts=11, amp=1.0, crack_scale=1.5):
    """Fractured boulder: a blob sliced by random planes (flat cleaved faces), weathered noise, cracks.
    `center` Blender metres, `size` metres (mean radius)."""
    rng = np.random.default_rng(seed)
    nrm = rng.normal(size=(cuts, 3))
    nrm /= np.linalg.norm(nrm, axis=1, keepdims=True)
    off = rng.uniform(0.42, 0.7, cuts) * size

    def cut(P, N):
        Q = P - center
        d = np.zeros(P.shape[:-1])
        for n_, o in zip(nrm, off):
            qn = Q @ n_
            nn = np.maximum(N @ n_, 0.25)
            d = np.minimum(d, np.where(qn > o, (o - qn) / nn, 0.0))
        return np.maximum(d, -0.45 * size)

    def d(P, N, t, a, high):
        base = cut(P, N) + 0.06 * size * fbm(P, 1.6 / size, 2, seed=seed)
        if not high:
            return base
        fine = 0.035 * size * ridged(P, 4.0 / size, 5, seed=seed + 1) + 0.008 * size * fbm(P, 25.0 / size, 3, seed=seed + 2)
        F1, F2, _ = worley(P, crack_scale / size, seed=seed + 3)
        crk = 1 - smoothstep(0.0, 0.035, F2 - F1)
        return base + amp * (fine - 0.03 * size * crk)

    def masks(P, N, t, a, dd):
        Pb = P - N * dd[..., None]
        F1, F2, _ = worley(Pb, crack_scale / size, seed=seed + 3)
        crk = 1 - smoothstep(0.0, 0.05, F2 - F1)
        return {'crack': crk, 'groove': crk, 'hot': np.zeros_like(crk)}
    return d, masks


def rockpiece(k, name, p, q, r0, r1, mat, rig, seed, lods=((10, 8), (6, 5), (4, 3)), res=(96, 80), glow=0.0,
              cracks=True, flat=1.0):
    """A boulder from p to q (game units) with radii r0 -> r1 (game units)."""
    F, R = k.F, k.R
    r0, r1 = r0 * k.rock_scale, r1 * k.rock_scale
    P0, P1 = F(*p), F(*q)
    # run each stone past its joints so neighbours overlap and fuse instead of stringing like beads
    ext = (P1 - P0) * k.rock_ext
    P0, P1 = P0 - ext, P1 + ext
    mid = (P0 + P1) / 2
    size = (np.linalg.norm(P1 - P0) / 2 + (r0 + r1) / 2 * R) / 2
    d, mk = rock_d(mid, size, seed)
    rk = knots((0, r0 * R), (1, r1 * R))
    W = lambda t: rk(t) * caps(t, 0.5, 0.5, 0.5, 0.5)
    sp = Spine([P0 - (P1 - P0) * 0.0, P1], up=lambda pp, T: np.cross(T, [0.3, 0.2, 1.0]) if abs(T[2]) > 0.9 else np.cross(np.cross(T, [0, 0, 1]), T))
    piece = Piece(f'{k.name}_{name}', sp, superellipse(W, lambda t: W(t) * flat, lambda t: W(t) * flat, 2.8), res,
                  list(lods), mat, disp=d, masks=mk if cracks else None, rig=rig, glow=glow, cluster=0.0)
    return k.add(piece)


def titan():
    k = Kind(2)
    k.rock_scale = 1.22
    k.rock_ext = 0.16
    F, R = k.F, k.R
    acc = k.accent
    m_rock = CM.rock('titan_rock', 'rock_boulder_cracked', tint=(0.8, 0.84, 0.92), sat=0.3, val=0.42, scale=1.0,
                     snow=0.6, accent=acc, crack_str=5.0, frost_amt=0.45)
    m_ice = CM.ice('titan_ice', tint=(0.85, 0.95, 1.0), absorb=(0.35, 0.65, 1.0), density=4.0, rough=0.05,
                   frost_amt=0.35, rt_albedo=(0.2, 0.3, 0.4), scale=0.8)
    m_core = CM.magma('titan_core', acc, strength=8.0)
    k.neck = (0, 0.92, 0.62)
    body = ('BODY', 0, (0, 0, 0))
    # the furnace inside, showing in every gap between the stones
    k.blob('core', (0, 0.98, -0.08), (0.56, 0.44, 0.78), m_core, rig=('CORE', 0, (0, 0, 0)), res=(64, 48),
           lods=((8, 6), (6, 4), (4, 3)), glow=1.0, disp=noise_d(0.03 * R, 2.0, 3, seed=40, big=True))
    # torso: a chest boulder, three cleaved slabs over the back, a hip stone, the shoulders
    torso = [('chest', (0, 0.76, 0.78), (0, 0.92, -0.1), 0.66, 0.68, 41), ('slab0', (0, 1.24, 0.78), (0, 1.38, 0.0), 0.66, 0.6, 42),
             ('slab1', (0, 1.4, 0.2), (0, 1.36, -0.55), 0.64, 0.58, 43), ('slab2', (0, 1.26, -0.36), (0, 1.08, -1.02), 0.56, 0.46, 44),
             ('hip', (0, 0.84, -0.36), (0, 0.8, -1.0), 0.56, 0.5, 45), ('flankL', (-0.55, 0.88, 0.3), (-0.55, 0.95, -0.5), 0.34, 0.34, 46),
             ('flankR', (0.55, 0.88, 0.3), (0.55, 0.95, -0.5), 0.34, 0.34, 47)]
    for name, p, q, r0, r1, sd in torso:
        rockpiece(k, name, p, q, r0, r1, m_rock, body, sd, flat=0.62 if 'slab' in name else 0.9,
                  lods=((10, 8), (6, 5), (5, 3) if name in ('chest', 'slab1', 'hip') else None))
    for sx in (-1, 1):
        rockpiece(k, f'shoulder{"LR"[sx > 0]}', (sx * 0.6, 1.24, 0.6), (sx * 0.82, 1.2, 0.26), 0.4, 0.38, m_rock, body,
                  50 + sx, lods=((10, 7), (6, 4), (4, 3)))
    # ice spires grown out of the back, where the old spikes stood
    spires = [((-0.46, 1.5, 0.36), (-0.78, 1.98, 0.1), 0.12), ((0.46, 1.5, 0.36), (0.78, 1.98, 0.1), 0.12),
              ((0, 1.62, -0.12), (0, 2.12, -0.46), 0.14), ((0, 1.44, -0.64), (0, 1.82, -0.98), 0.1),
              ((0.05, 1.56, 0.42), (0.02, 1.9, 0.2), 0.09), ((-0.3, 1.55, -0.3), (-0.55, 1.9, -0.55), 0.08),
              ((0.32, 1.52, -0.32), (0.6, 1.85, -0.6), 0.08), ((-0.15, 1.6, 0.0), (-0.22, 1.85, -0.12), 0.06)]
    for j, (p, q, r) in enumerate(spires):
        P0, P1 = F(*p), F(*q)
        dv = P1 - P0
        k.crystal(f'spire{j}', P0 - dv * 0.25, dv, r * R, np.linalg.norm(dv) * 1.25, 6, m_ice,
                  lods=(True, j < 5, j < 2), glow=0.0, phase=j * 0.4)
    # head: a stone skull sunk under the mantle, eyes burning in deep sockets
    head = rockpiece(k, 'head', (0, 0.86, 0.66), (0, 0.78, 1.08), 0.34, 0.3, m_rock, ('HEAD', 0, k.neck), 55,
                     lods=((10, 8), (6, 5), (4, 3)))
    hd0 = head.disp
    eyes_c = [k.surface_point(head, 0.72, np.pi + s * 0.75)[0] for s in (-1, 1)]

    def head_d(P, N, t, a, high):
        d = hd0(P, N, t, a, high)
        for c in eyes_c:
            dist = np.linalg.norm(P - c, axis=-1)
            d = d - 0.06 * R * np.clip(1 - (dist / (0.1 * R)) ** 2, 0, 1)
        brow = np.exp(-((t - 0.62) / 0.06) ** 2) * np.exp(-((a - np.pi) / 0.9) ** 2)
        return d + 0.04 * R * brow
    head.disp = head_d
    hm0 = head.masks

    def head_m(P, N, t, a, d):
        out = hm0(P, N, t, a, d)
        Pb = P - N * d[..., None]
        g = np.zeros(P.shape[:-1])
        for c in eyes_c:
            g = np.maximum(g, smoothstep(0.075 * R, 0.02 * R, np.linalg.norm(Pb - c, axis=-1)))
        out['crack'] = np.maximum(out['crack'], g)
        return out
    head.masks = head_m
    # ice tusks
    for sx in (-1, 1):
        base = (sx * 0.18, 0.68, 1.0)
        k.limb(f'tusk{"LR"[sx > 0]}', [base, (sx * 0.2, 0.5, 1.22), (sx * 0.12, 0.4, 1.38), (sx * 0.05, 0.42, 1.48)],
               [0.075, 0.06, 0.035, 0.005], m_ice, ('JAW', 0, base), res=(24, 60), lod_n=(5, 4, None), knob=0.0,
               pinch=0.0, bulge=0.05, tip=0.6, masks=lambda P, N, t, a, d: {'ice': np.ones_like(t)})
    # forelimbs it knuckle-walks on: upper arm, forearm, a fist of stones, ice knuckles on the floor
    for sx in (-1, 1):
        sh = (sx * 0.72, 1.05, 0.42)
        el = (sx * 1.18, 0.86, 0.74)
        wr = (sx * 1.06, 0.3, 1.28)
        rig = ('ARM', 1 if sx < 0 else 0, sh)
        rockpiece(k, f'uparm{"LR"[sx > 0]}', sh, el, 0.3, 0.26, m_rock, rig, 60 + sx, lods=((9, 7), (6, 4), None))
        rockpiece(k, f'forearm{"LR"[sx > 0]}', (sx * 1.2, 0.92, 0.7), (sx * 1.08, 0.36, 1.24), 0.3, 0.32, m_rock, rig,
                  62 + sx, lods=((9, 7), (6, 4), (4, 3)))
        rockpiece(k, f'fist{"LR"[sx > 0]}', (sx * 1.05, 0.34, 1.16), (sx * 1.06, 0.18, 1.5), 0.3, 0.26, m_rock, rig,
                  64 + sx, lods=((9, 7), (6, 4), None))
        for j, (a_, b_) in enumerate([((sx * 1.16, 0.25, 1.38), (sx * 1.26, 0.02, 1.72)), ((sx * 0.96, 0.25, 1.38), (sx * 0.82, 0.03, 1.68))]):
            P0, P1 = F(*a_), F(*b_)
            k.crystal(f'knuckle{"LR"[sx > 0]}{j}', P0, P1 - P0, 0.07 * R, np.linalg.norm(P1 - P0), 5, m_ice, rig=rig,
                      lods=(True, True, False), glow=0.0)
    # four legs: stone pillars, knees up, feet broad
    legs = [((0.5, 0.75, -0.1), (1.16, 1.14, -0.05), (1.3, 0, 0.12), 0), ((0.45, 0.75, -0.55), (1.06, 1.1, -0.76), (1.26, 0, -1.06), 1)]
    for j, (hip, kn, ft, beat) in enumerate(legs):
        for sx in (-1, 1):
            h = (sx * hip[0], hip[1], hip[2])
            kk = (sx * kn[0], kn[1], kn[2])
            f = (sx * ft[0], ft[1] + 0.12, ft[2])
            rig = ('LEG', beat if sx < 0 else 1 - beat, h)
            rockpiece(k, f'thigh{j}{"LR"[sx > 0]}', h, kk, 0.3, 0.27, m_rock, rig, 70 + j * 2 + sx, lods=((9, 7), (6, 4), (4, 3)))
            rockpiece(k, f'shin{j}{"LR"[sx > 0]}', kk, f, 0.24, 0.3, m_rock, rig, 80 + j * 2 + sx, lods=((9, 7), (6, 4), None))
            rockpiece(k, f'foot{j}{"LR"[sx > 0]}', (sx * ft[0], 0.14, ft[2] - 0.16), (sx * ft[0], 0.12, ft[2] + 0.22), 0.26, 0.22,
                      m_rock, rig, 90 + j * 2 + sx, lods=((8, 6), (5, 4), None), flat=0.6)
    return k


def bloater():
    k = Kind(3)
    F, R = k.F, k.R
    acc = k.accent
    chit = dict(base=(0.03, 0.02, 0.022), alt=(0.055, 0.035, 0.035), edge=(0.17, 0.12, 0.1), gloss=0.6, frost_amt=0.8,
                tip_col=(0.5, 0.2, 0.08), tip_gloss=0.8, accent=acc, eye_emit=0.1, membrane=(0.09, 0.05, 0.045))
    m_chit = CM.chitin('bloater_chitin', **chit)
    m_sac = CM.membrane('bloater_sac', base=(0.8, 0.3, 0.08), vein=(0.16, 0.035, 0.02), plate=(0.035, 0.024, 0.022),
                        accent=acc, glow_str=2.2, scale=1.0 / R * 0.62)
    k.neck = (0, 0.95, 0.66)
    sac_c = (0, 1.08, -0.16)

    def sac_d(P, N, t, a, high):
        big = 0.03 * R * fbm(P, 1.4, 2, seed=50)
        if not high:
            return big
        pl = plates(P, t, a)
        return big + 0.006 * R * fbm(P, 9.0, 4, seed=51) + 0.012 * R * pl

    def plates(P, t, a):
        # sclerites left stranded on the stretched membrane, along the top
        F1, F2, ID = worley(P, 3.2 / R * 0.62, seed=52)
        top = smoothstep(-0.2, 0.5, np.cos(a - np.pi))
        return smoothstep(0.32, 0.22, F1) * (ID > 0.45) * top
    k.blob('sac', sac_c, (0.8, 0.74, 0.94), m_sac, rig=('CORE', 0, (0, 0, 0)), res=(128, 110),
           lods=((14, 11), (8, 6), (6, 4)), disp=sac_d, glow=1.0,
           masks=lambda P, N, t, a, d: {'plate': plates(P - N * d[..., None], t, a)})
    # ribs: the tergites, pulled apart, still arching over the swollen sac
    for j, z in enumerate((-0.62, -0.16, 0.32)):
        zz = z
        pts = [(-0.8, 0.8, zz), (-0.62, 1.42, zz * 0.95), (0, 1.86, zz * 0.85), (0.62, 1.42, zz * 0.95), (0.8, 0.8, zz)]
        k.limb(f'rib{j}', pts, [0.06, 0.075, 0.08, 0.075, 0.06], m_chit, ('BODY', 0, (0, 0, 0)), res=(20, 120),
               lod_n=(4, 3, 3 if j == 1 else None), knob=0.0, pinch=0.0, bulge=0.05, tip=0.05, flat=0.45,
               up=lambda p, T: p - np.array(F(*sac_c)) + np.array([k.origin[0] * 0, 0, 0]))
    # studs down the spine
    for j, z in enumerate((-0.52, 0.0, 0.42)):
        P0 = F(0, 1.74 + 0.04 * (1 - abs(z)), z)
        dv = np.array(F(0, 2.05, z - 0.12)) - P0
        k.crystal(f'stud{j}', P0, dv, 0.055 * R, np.linalg.norm(dv), 5, m_chit, lods=(True, False, False), glow=0.0)
    # the ventral body the legs hang from, the neck, the little head
    k.loft('sternum', [(0, 0.66, 0.62), (0, 0.6, 0.0), (0, 0.66, -0.62)], knots((0, 0.4), (0.5, 0.64), (1, 0.4)),
           knots((0, 0.16), (1, 0.16)), knots((0, 0.12), (1, 0.12)), m_chit, e=2.4, k0=0.2, k1=0.2, res=(80, 80),
           lods=((8, 6), (6, 4), (4, 3)))
    k.limb('neck', [(0, 1.0, 0.5), (0, 0.98, 0.7), (0, 0.95, 0.86)], [0.21, 0.19, 0.17], m_chit, ('BODY', 0, (0, 0, 0)),
           res=(32, 40), lod_n=(6, 4, None), knob=0.1, pinch=0.15, tip=0.0, up=lambda p, T: np.array([0, 0, 1.0]))
    head = k.loft('head', [(0, 0.96, 0.8), (0, 0.97, 1.0), (0, 0.9, 1.2)], knots((0, 0.24), (0.5, 0.26), (1, 0.14)),
                  knots((0, 0.18), (1, 0.1)), knots((0, 0.15), (1, 0.09)), m_chit, e=2.2, k0=0.25, k1=0.35,
                  res=(96, 70), lods=((9, 6), (6, 4), (4, 3)), rig=('HEAD', 0, k.neck))
    ed_, em_ = bumps(head, [(0.5, np.pi - 1.0, 0.055 * R, 0.035 * R), (0.5, np.pi + 1.0, 0.055 * R, 0.035 * R),
                            (0.6, np.pi - 0.45, 0.035 * R, 0.022 * R), (0.6, np.pi + 0.45, 0.035 * R, 0.022 * R)])
    head.disp = total(ed_, noise_d(0.003 * R, 14.0, 3, seed=53))
    head.masks = lambda P, N, t, a, d: {'eye': em_(P - N * d[..., None])}
    for sx in (-1, 1):
        base = (sx * 0.12, 0.84, 1.14)
        k.limb(f'mandible{"LR"[sx > 0]}', [base, (sx * 0.15, 0.8, 1.3), (sx * 0.05, 0.74, 1.44)], [0.055, 0.04, 0.006],
               m_chit, ('JAW', 0, base), res=(20, 50), lod_n=(4, 3, None), tip=0.6, tipmask=0.5)
    # six thin legs straining under the weight
    legs = [(0.45, (1.05, 1.0, 0.8), (1.3, 0, 1.15)), (0.0, (1.2, 1.05, 0.05), (1.55, 0, 0.1)), (-0.5, (1.05, 1.0, -0.75), (1.3, 0, -1.15))]
    for i, (z, kn, ft) in enumerate(legs):
        for sx in (-1, 1):
            hip = (sx * 0.6, 0.62, z)
            beat = 0 if ((i % 2 == 0) == (sx < 0)) else 1
            K_ = np.array((sx * kn[0], kn[1], kn[2]))
            Fo = np.array((sx * ft[0], ft[1], ft[2]))
            H = np.array(hip)
            cox = H + (K_ - H) * 0.15
            ank = K_ + (Fo - K_) * 0.55 + np.array([sx * 0.06, 0.06, 0])
            k.limb(f'leg{i}{"LR"[sx > 0]}', [hip, tuple(cox), tuple(K_), tuple(ank), tuple(Fo)],
                   [0.075, 0.07, 0.055, 0.035, 0.01], m_chit, ('LEG', beat, hip), res=(24, 150), lod_n=(5, 4, 3),
                   spines=8, spine_len=0.08)
    return k


def lunger():
    """A long-legged harvestman built to charge: a fused, armoured, spined body slung between eight
    stilt legs, and raptorial pedipalps folded under its face to strike with."""
    k = Kind(4)
    F, R = k.F, k.R
    acc = k.accent
    st = (0.86, 0.88, 1.42)
    S = lambda x, y, z: (x * st[0], y * st[1], z * st[2])
    chit = dict(base=(0.03, 0.012, 0.014), alt=(0.06, 0.022, 0.025), edge=(0.2, 0.1, 0.09), gloss=0.6, frost_amt=0.85,
                tip_col=(0.7, 0.08, 0.12), tip_gloss=0.9, tip_emit=1.6, accent=acc, eye_emit=0.25,
                membrane=(0.07, 0.035, 0.035), frost_groove=0.6)
    m_chit = CM.chitin('lunger_chitin', **chit)
    k.neck = S(0, 0.58, 0.44)
    bands = bands_d([0.3, 0.42, 0.54, 0.66, 0.78, 0.88], 0.012 * R, 0.016)
    body = k.loft('body', [S(0, 0.6, 0.46), S(0, 0.66, 0.0), S(0, 0.62, -0.7), S(0, 0.5, -1.3)],
                  lambda t: knots((0, 0.3), (0.3, 0.42), (0.6, 0.44), (0.9, 0.3), (1, 0.15))(t) * st[0],
                  lambda t: knots((0, 0.2), (0.3, 0.28), (0.6, 0.3), (1, 0.12))(t) * st[1],
                  lambda t: knots((0, 0.18), (0.5, 0.24), (1, 0.1))(t) * st[1], m_chit, e=2.3, k0=0.15, k1=0.18,
                  res=(128, 150), lods=((12, 12), (7, 6), (5, 4)),
                  disp=total(bands, noise_d(0.004 * R, 10.0, 4, seed=60)),
                  masks=lambda P, N, t, a, d: {'groove': bands.mask(t)})
    # the eye turret (ocularium), two eyes looking sideways
    tur = k.loft('turret', [S(0, 0.78, 0.22), S(0, 0.95, 0.24)], knots((0, 0.1), (1, 0.06)), knots((0, 0.1), (1, 0.06)),
                 knots((0, 0.1), (1, 0.06)), m_chit, k0=0.0, k1=0.4, res=(48, 30), lods=((6, 4), (4, 3), None))
    ed_, em_ = bumps(tur, [(0.6, np.pi * 0.5, 0.045 * R, 0.03 * R), (0.6, np.pi * 1.5, 0.045 * R, 0.03 * R)])
    tur.disp = ed_
    tur.masks = lambda P, N, t, a, d: {'eye': em_(P - N * d[..., None])}
    # dorsal spines, swept back, crimson at the tips
    for j, (z, L) in enumerate([(-0.05, 0.5), (-0.4, 0.62), (-0.72, 0.7), (-1.0, 0.55), (-1.2, 0.4)]):
        for sx in ((-1, 1) if j in (1, 2) else (0,)):
            p0 = S(sx * 0.12, 0.72 - 0.05 * j * 0 , z)
            p1 = S(sx * 0.22, 0.72 + L * 0.55, z - L * 0.25)
            p2 = S(sx * 0.26, 0.72 + L * 0.8, z - L * 0.65)
            k.limb(f'spine{j}{"LMR"[sx + 1]}', [p0, p1, p2], [0.07, 0.035, 0.004], m_chit, ('BODY', 0, (0, 0, 0)),
                   res=(16, 60), lod_n=(4, 3, 3 if j == 2 else None), knob=0.0, pinch=0.0, bulge=0.0, tip=0.7,
                   tipmask=0.45, up=lambda p, T: np.cross(T, [1, 0, 0]))
    head = k.loft('head', [S(0, 0.6, 0.38), S(0, 0.6, 0.7), S(0, 0.52, 0.98)], knots((0, 0.22), (1, 0.12)),
                  knots((0, 0.15), (1, 0.08)), knots((0, 0.13), (1, 0.08)), m_chit, e=2.2, k0=0.25, k1=0.35,
                  res=(96, 70), lods=((9, 6), (6, 4), (4, 3)), rig=('HEAD', 0, k.neck))
    # raptorial pedipalps: spined, folded, the lunge's weapon
    for sx in (-1, 1):
        base = S(sx * 0.12, 0.5, 0.85)
        k.limb(f'palp{"LR"[sx > 0]}', [base, S(sx * 0.3, 0.66, 1.0), S(sx * 0.28, 0.56, 1.2), S(sx * 0.1, 0.42, 1.3)],
               [0.06, 0.055, 0.04, 0.01], m_chit, ('JAW', 0, base), res=(20, 80), lod_n=(5, 4, None), tip=0.5,
               spines=8, spine_len=0.09, tipmask=0.25)
    # eight stilt legs
    legs = [(0.32, (0.8, 1.15, 0.75), (1.3, 0, 1.45)), (0.2, (1.05, 1.28, 0.28), (1.95, 0, 0.42)),
            (0.08, (1.0, 1.22, -0.3), (1.85, 0, -0.62)), (-0.04, (0.78, 1.12, -0.62), (1.3, 0, -1.25))]
    for i, (z, kn, ft) in enumerate(legs):
        for sx in (-1, 1):
            hip = S(sx * 0.24, 0.57, z)
            beat = 0 if ((i % 2 == 0) == (sx < 0)) else 1
            K_ = np.array(S(sx * kn[0], kn[1], kn[2]))
            Fo = np.array(S(sx * ft[0], ft[1], ft[2]))
            H = np.array(hip)
            cox = H + (K_ - H) * 0.12
            ank = K_ + (Fo - K_) * 0.5 + np.array([sx * 0.06, 0.08, 0])
            tar = ank + (Fo - ank) * 0.65 + np.array([sx * 0.02, 0.02, 0])
            k.limb(f'leg{i}{"LR"[sx > 0]}', [hip, tuple(cox), tuple(K_), tuple(ank), tuple(tar), tuple(Fo)],
                   [0.055, 0.05, 0.04, 0.026, 0.017, 0.007], m_chit, ('LEG', beat, hip), res=(20, 170),
                   lod_n=(5, 4, 3), spines=10, spine_len=0.06)
    return k


BUILDERS = {'ghoul': ghoul, 'brute': brute, 'titan': titan, 'bloater': bloater, 'lunger': lunger, 'splitter': splitter,
            'glitterback': glitterback}


# ---------------------------------------------------------------- scene
def build_scene(kinds):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    CM.MATS.clear()
    built = []
    for name in kinds:
        log('building', name)
        built.append(BUILDERS[name]())
    pieces = [p for k in built for p in k.pieces if not p.high_only]
    tpm = K.atlas(pieces, ATLAS, margin_px=8)
    log(f'atlas: {tpm:.0f} texels per metre at density 1')
    for k in built:
        share = sum(p.rect[2] * p.rect[3] for p in k.pieces if not p.high_only)
        log(f'  {k.name}: {share * 100:.1f}% of the atlas, {tpm * k.density:.0f} texels/m')
    for k in built:
        coll = bpy.data.collections.new(k.name)
        sc.collection.children.link(coll)
        k.objects = []
        for p in k.pieces:
            if p.high_only:
                p.rect = (0, 0, 0, 0, False)
            ob = K.to_blender(p, coll, k.origin)
            ob['high_only'] = p.high_only
            k.objects.append(ob)
        tris = sum(len(o.data.polygons) for o in k.objects)
        log(f'{k.name}: {len(k.objects)} HIGH objects, {tris} faces')
    return built


def stage(built):
    sc = bpy.context.scene
    # ground: the game's snow at true scale
    bpy.ops.mesh.primitive_plane_add(size=1)
    g = bpy.context.object
    g.name = 'GROUND'
    g.scale = (len(KINDS) * SPACING + 200, 400, 1)
    g.location = ((len(KINDS) - 1) * SPACING / 2, 0, 0.012)
    bpy.ops.object.transform_apply(scale=True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.subdivide(number_cuts=40)
    bpy.ops.object.mode_set(mode='OBJECT')
    me = g.data
    uv = me.uv_layers.new(name='WorldUV')
    for l in me.loops:
        v = me.vertices[l.vertex_index].co
        uv.data[l.index].uv = (v.x + g.location.x, v.y)
    me.materials.append(SM.snow_ground())
    AZ, EL = math.degrees(math.atan2(-0.68, -0.72)), 7.0
    meta = sky.world('qwantani_sunset_puresky', AZ, strength=1.0)
    sky.sun_lamp(meta, AZ, EL)
    for k in built:
        ox = k.origin[0]
        R = k.R
        # a three-quarter front view from standing height, side-lit by the low sun
        reach = {'titan': 1.55, 'bloater': 1.5}.get(k.name, 1.35)
        dist = max(2.6, R * 4.6 * reach)
        d = np.array([0.62, -0.78])
        d /= np.linalg.norm(d)
        cam_loc = (ox + d[0] * dist, d[1] * dist, 1.62)
        target = np.array([ox, -0.1 * R, R * 0.55])
        cd = bpy.data.cameras.new(f'CAM_{k.name}')
        cd.lens = 40
        cam = bpy.data.objects.new(f'CAM_{k.name}', cd)
        sc.collection.objects.link(cam)
        cam.location = cam_loc
        from mathutils import Vector
        cam.rotation_euler = (Vector(target) - Vector(cam_loc)).to_track_quat('-Z', 'Y').to_euler()
        # and one against the light (rim)
        cd2 = bpy.data.cameras.new(f'CAM_{k.name}_rim')
        cd2.lens = 40
        cam2 = bpy.data.objects.new(f'CAM_{k.name}_rim', cd2)
        sc.collection.objects.link(cam2)
        d2 = np.array([0.55, 0.83])
        loc2 = (ox + d2[0] * dist, d2[1] * dist, 1.5)
        cam2.location = loc2
        cam2.rotation_euler = (Vector(target) - Vector(loc2)).to_track_quat('-Z', 'Y').to_euler()
        sc.camera = cam
    sc.view_settings.view_transform = 'AgX'
    sc.render.engine = 'CYCLES'
    return g


# ---------------------------------------------------------------- export
def export_lods(built):
    meshes = []
    meta = {}
    for k in built:
        info = {'radius': k.R, 'neck': list(k.neck), 'lods': []}
        for lvl in range(3):
            pos, uv, rig, piv, glow, idx = [], [], [], [], [], []
            base = 0
            for p in k.pieces:
                if p.high_only:
                    continue
                arr = K.lod_arrays(p, lvl, k.R)
                if arr is None:
                    continue
                V, U, T = arr
                part, beat, pv = p.rig
                pos.append(V)
                uv.append(U)
                rig.append(np.tile([K.PART[part], beat], (len(V), 1)))
                piv.append(np.tile(pv, (len(V), 1)))
                glow.append(np.full(len(V), p.glow))
                idx.append(T + base)
                base += len(V)
            V = np.concatenate(pos)
            attrs = {'POSITION': V, 'TEXCOORD_0': np.concatenate(uv), '_RIG': np.concatenate(rig).astype(np.float32),
                     '_PIVOT': np.concatenate(piv).astype(np.float32), '_GLOW': np.concatenate(glow).astype(np.float32)}
            I = np.concatenate(idx)
            meshes.append((f'{k.name}_lod{lvl}', attrs, I))
            info['lods'].append({'tris': int(len(I)), 'verts': int(len(V))})
            log(f'{k.name} LOD{lvl}: {len(I)} tris, {len(V)} verts')
        meta[k.name] = info
    path = os.path.join(OUT, 'creatures.glb')
    K.write_glb(path, meshes)
    log('wrote', path, os.path.getsize(path) // 1024, 'KB')
    return meta


# ---------------------------------------------------------------- bake
def bake_all(built, samples):
    BK.gpu()
    sc = bpy.context.scene
    sc.render.bake.margin = 6
    sc.render.bake.margin_type = 'EXTEND'
    sc.world.light_settings.distance = 0.35
    sc.render.use_persistent_data = False
    g = bpy.data.objects['GROUND']
    g.hide_render = True
    g.location.z -= 500.0
    sun = bpy.data.objects['SUN']
    sun_e = sun.data.energy
    sun.data.energy = 0.0
    objs = [o for k in built for o in k.objects if not o.get('high_only')]
    # high-only details still cast AO; they are not targets
    imgs = {}

    def run(ch, type_, n, passes=None, space=None):
        im = bpy.data.images.new(f'bake_{ch}', ATLAS, ATLAS, float_buffer=True, alpha=False)
        im.colorspace_settings.name = 'Non-Color'
        for m in CM.MATS:
            nt = m.node_tree
            t = nt.nodes.get('BAKE_TARGET') or nt.nodes.new('ShaderNodeTexImage')
            t.name = 'BAKE_TARGET'
            t.image = im
            nt.nodes.active = t
        BK.select_only(objs[0], objs[1:])
        sc.cycles.samples = n
        kw = dict(type=type_, margin=6, use_clear=True, target='IMAGE_TEXTURES', uv_layer='UVMap')
        if passes:
            kw['pass_filter'] = passes
        if space:
            kw['normal_space'] = space
        t0 = time.time()
        bpy.ops.object.bake(**kw)
        log(f'baked {ch} in {time.time() - t0:.0f}s')
        px = BK.pixels(im)
        np.save(os.path.join(WORK, f'{ch}.npy'), px.astype(np.float16 if ch != 'normal' else np.float32))
        imgs[ch] = px

    for ch in ('albedo', 'ge'):
        CM.channel(ch)
        run(ch, 'EMIT', 16)
    ge = imgs['ge']
    for i, ch in enumerate(('gloss', 'emit')):
        px = np.repeat(ge[..., i:i + 1], 4, axis=-1)
        np.save(os.path.join(WORK, f'{ch}.npy'), px.astype(np.float16))
    CM.channel('beauty')
    run('normal', 'NORMAL', 16, space='OBJECT')
    run('ao', 'AO', samples)
    g.hide_render = False
    g.location.z += 500.0
    sun.data.energy = sun_e
    return imgs


def coverage(built):
    """Texel coverage of the atlas from the LOD0 rectangles (exact: islands are rectangles)."""
    cov = np.zeros((ATLAS, ATLAS), np.uint8)
    for k in built:
        for p in k.pieces:
            if p.high_only:
                continue
            x, y, w, h, rot = p.rect
            x0, y0 = int(math.floor(x * ATLAS)), int(math.floor(y * ATLAS))
            x1, y1 = int(math.ceil((x + w) * ATLAS)), int(math.ceil((y + h) * ATLAS))
            cov[y0:y1, x0:x1] = 1
    return cov


def main():
    names = opt('--kinds', ','.join(BUILDERS)).split(',')
    built = build_scene(names)
    stage(built)
    meta = export_lods(built)
    blend = os.path.join(WORK, 'creature.blend')
    bpy.ops.wm.save_as_mainfile(filepath=blend, compress=False)
    log('saved', blend)
    if '--bake' in argv:
        bake_all(built, int(opt('--samples', 64)))
        np.save(os.path.join(WORK, 'coverage.npy'), coverage(built))
        CM.channel('beauty')
        bpy.ops.wm.save_as_mainfile(filepath=blend, compress=False)
    accents = {k.name: list(k.accent) for k in built}
    for k in built:
        meta[k.name]['accent_linear'] = accents[k.name]
    json.dump({'atlas': ATLAS, 'emit_max': CM.EMIT_MAX, 'kinds': meta}, open(os.path.join(WORK, 'meta.json'), 'w'), indent=1)
    log('done')


main()
