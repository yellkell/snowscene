"""The glacier the cave is cut into: its structure modelled into the shell, not painted on it.

Everything here is a displacement of the shell grid along its inward normal (metres; + = the wall melts
back, - = it stands out into the cave), plus per-vertex attributes for the material:

  layers    annual layers and foliation folded by the glacier's flow (bent, pinched, overturned, never
            parallel), each layer hashed on its index: clean or dirty, rib or slot, milky or clear
  melt      differential melt along the layers: dirty layers stand proud as ribs or rot back into slots,
            so the wall steps, and every step's top is a little shelf for hoarfrost and grit
  scallops  three scales: ~0.3 m ablation scallops everywhere, ~1.6 m flutes stretched down the flow of
            the meltwater, and the 4-8 m bulges of the old cavity
  notches   the old waterlines over the pool, undercut into overhangs with a sharp lip (drip lines)
  cracks    crevasse cracks cutting across the layers, staggered layer by layer, and refrozen veins of
            milky bubbly ice; a moulin shaft pouring down the east wall as the landmark
  shore     ice-polished bedrock slabs at the waterline and a shore-ice rim along the pool's edge

All of it stays outside the works' swept volumes (the caller clamps the inward moves), so every platform,
berth and rope path stays exactly where the game puts it.
"""
import math
import numpy as np
from .caveshell import fbm3, vnoise3, smoothstep, _hash3


def hash1(i, seed):
    """A hash of integer array i into [0, 1)."""
    i = np.asarray(i, np.int64)
    return (_hash3(i, i * 0 + seed, i * 0 + 7, seed) + 1) * 0.5


def voronoi(P, cell, seed, stretch=(1.0, 1.0, 1.0), jitter=0.9):
    """F1, F2 (in cell units) and the nearest cell's id for points P (N, 3), on a jittered grid."""
    Q = P / (cell * np.asarray(stretch))
    base = np.floor(Q)
    f1 = np.full(len(P), 9.0)
    f2 = np.full(len(P), 9.0)
    cid = np.zeros(len(P), np.int64)
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dz in (-1, 0, 1):
                c = base + np.array([dx, dy, dz])
                ci, cj, ck = (c[:, a].astype(np.int64) for a in range(3))
                j = np.stack([_hash3(ci, cj, ck, seed + s) for s in (0, 1, 2)], 1) * 0.5 * jitter
                fp = c + 0.5 + j
                d = np.sqrt(((Q - fp) ** 2).sum(1))
                closer = d < f1
                f2 = np.where(closer, f1, np.minimum(f2, d))
                cid = np.where(closer, (ci * 73856093) ^ (cj * 19349663) ^ (ck * 83492791), cid)
                f1 = np.where(closer, d, f1)
    return f1, f2, cid


def glacier(P, N, top_y, floor_y, pool_y, rng):
    """Displacement d (m, + = back into the ice) and attributes for shell points P with inward normals N."""
    y = P[:, 1]
    out = {}
    # ---- the flow: the glacier moves roughly toward +x, a little south; its layers fold as it goes
    fdir = np.array([math.cos(0.45), 0.0, math.sin(0.45)])
    cdir = np.array([-fdir[2], 0.0, fdir[0]])
    xf = P @ fdir
    zf = P @ cdir
    # stratigraphic height: layers bent into broad folds, tightened (pinched) on their limbs, and
    # overturned where a recumbent fold drags the upper layers over the lower ones
    fold = 1.9 * np.sin(0.31 * xf + 0.9 * np.sin(0.19 * zf + 0.23 * y) + 0.6)
    fold *= 0.55 + 0.45 * (0.5 + 0.5 * fbm3(P * 0.04 + 3.0, 2, 301))
    recumbent = 2.4 * np.exp(-((y - 13.0) / 4.5) ** 2) * np.tanh(0.35 * (xf - 1.5 + 2.0 * fbm3(P * 0.06, 2, 302)))
    phi = y + fold + recumbent + 0.9 * fbm3(P * np.array([0.07, 0.03, 0.07]), 3, 303) + 0.22 * fbm3(P * 0.3, 2, 304)
    # layer thicknesses vary (0.25 - 1.4 m): a monotone warp of phi before cutting it into layers
    t = phi / 0.75 + 0.42 * np.sin(phi * 1.3 + 0.7) + 0.25 * np.sin(phi * 3.1)
    layer = np.floor(t).astype(np.int64)
    f = t - layer
    # ragged layer boundaries
    f_r = f + 0.07 * fbm3(P * np.array([1.1, 2.4, 1.1]), 2, 305)
    edge = smoothstep(0.0, 0.1, f_r) * smoothstep(1.0, 0.9, f_r)
    h_dirty = hash1(layer, 401)
    h_rib = hash1(layer, 402)
    h_amp = hash1(layer, 403)
    h_milk = hash1(layer, 404)
    # dirty layers come and go along their length (lenses of debris)
    lens = smoothstep(-0.25, 0.15, fbm3(np.stack([xf * 0.12, phi * 0.6, zf * 0.12], 1), 2, 406) + (h_dirty - 0.5) * 0.6)
    dirty = (h_dirty < 0.38) * lens
    rib = np.where(h_rib < 0.55, -1.0, 1.0)            # -1: stands out (debris armours it); +1: melts back
    amp = 0.05 + 0.11 * h_amp
    melt = (dirty * rib * amp + (1 - dirty) * (h_amp - 0.5) * 0.05) * edge
    out['dirt'] = dirty * edge
    # a few layers of bubbly ice, in lenses that pinch out along their length
    mlens = smoothstep(0.1, 0.45, fbm3(np.stack([xf * 0.09, phi * 0.5, zf * 0.09], 1), 2, 407) + (h_milk - 0.85) * 2.0)
    out['milky'] = np.clip((h_milk > 0.86) * edge * mlens * 0.7, 0, 1)
    out['layer'] = (layer % 97).astype(np.float64) / 97.0
    # ---- scallops at three scales
    s1, s1b, _ = voronoi(P, 0.32, 501, stretch=(1.0, 0.8, 1.0))
    scal = 0.032 * np.clip(1 - (s1 / 0.8) ** 2, 0, 1)
    s2, s2b, _ = voronoi(P, 1.6, 511, stretch=(1.0, 2.6, 1.0))
    flute = 0.17 * np.clip(1 - (s2 / 0.85) ** 2, 0, 1) ** 1.3
    bulge = 0.32 * fbm3(P * np.array([0.12, 0.06, 0.12]), 3, 521)
    out['cusp'] = smoothstep(0.08, 0.0, s1b - s1)       # the sharp rims between scallops
    # ---- old waterlines over the pool, undercut: a recess with a sharp, overhanging lip above it
    notch = np.zeros(len(P))
    for k, (yk, depth) in enumerate(((pool_y + 0.55, 0.5), (2.9, 0.34), (6.6, 0.26))):
        wob = yk + 0.25 * fbm3(P * 0.15 + k, 2, 600 + k)
        on = smoothstep(0.25, 0.55, 0.5 + 0.5 * fbm3(P * 0.09 + 3 * k, 2, 610 + k))
        below = smoothstep(wob - 0.7, wob - 0.1, y)
        lip = 1 - smoothstep(wob, wob + 0.06, y)           # the roof closes sharply: an overhang
        notch = np.maximum(notch, depth * on * below * lip)
    out['notch'] = notch
    # ---- crevasse cracks: steep planes across the layers, live in some layers and not others
    crack = np.zeros(len(P))
    vein = np.zeros(len(P))
    for k in range(16):
        ang = rng.uniform(0, math.pi)
        nrm = np.array([math.cos(ang), rng.uniform(-0.25, 0.25), math.sin(ang)])
        nrm /= np.linalg.norm(nrm)
        c = rng.uniform(-14, 14)
        dist = P @ nrm - c + 0.3 * fbm3(P * 0.25, 2, 700 + k)
        live = hash1(layer * 13 + k, 710 + k) < (0.45 if k < 10 else 0.25)
        span = smoothstep(rng.uniform(-2, 4), rng.uniform(5, 9), y) * smoothstep(rng.uniform(16, 28), rng.uniform(10, 15), y)
        if k < 10:
            w = rng.uniform(0.04, 0.09)
            crack = np.maximum(crack, rng.uniform(0.18, 0.4) * np.exp(-(dist / w) ** 2) * live * span)
        else:
            w = rng.uniform(0.06, 0.16)
            vein = np.maximum(vein, 0.75 * np.exp(-(dist / w) ** 2) * span * live)
    out['crack'] = smoothstep(0.03, 0.15, crack)
    out['milky'] = np.maximum(out['milky'], vein)
    # ---- the moulin: a round shaft of meltwater pouring down the east wall, spiral-fluted
    mang = math.atan2(-9.0 + 9.4, 9.0 + 0.2)
    ang = np.arctan2(P[:, 2] + 9.4, P[:, 0] + 0.2)
    rr = np.hypot(P[:, 0] + 0.2, P[:, 2] + 9.4)
    s_m = np.angle(np.exp(1j * (ang - mang))) * rr
    shaft = smoothstep(3.5, 6.0, y) * smoothstep(24.0, 18.0, y)
    spiral = 1 + 0.25 * np.cos(s_m / 0.35 * 2 * math.pi + y * 2.2)
    moulin = 1.3 * np.exp(-(s_m / 1.15) ** 2) * shaft * spiral
    out['moulin'] = smoothstep(0.05, 0.6, moulin)
    # ---- the shore: ice-polished bedrock slabs at the waterline and a rim of shore ice over the pool
    slab = np.floor((y - pool_y) / 0.35 + fbm3(P * 0.3, 2, 801) * 0.8)
    slabs = 0.12 * hash1(slab.astype(np.int64) * 31 + np.floor(xf / 1.7).astype(np.int64), 802)
    rock = smoothstep(pool_y + 0.55, pool_y + 0.05, y + 0.35 * fbm3(P * 0.5, 2, 803))
    rim_band = smoothstep(pool_y - 0.12, pool_y - 0.04, y) * (1 - smoothstep(pool_y + 0.03, pool_y + 0.07, y))
    rim = 0.3 * (0.6 + 0.4 * (0.5 + 0.5 * fbm3(P * 0.7, 2, 804))) * rim_band * (1 - rock * 0.6)
    out['rock'] = rock
    out['rim'] = smoothstep(0.02, 0.1, rim)
    # ---- together
    d = bulge + flute + scal + melt + notch + crack + moulin + slabs * rock - rim
    # the bowl's floor stays a floor; the throat opens clean to the sky
    d *= smoothstep(floor_y - 0.3, floor_y + 1.8, y)
    d *= smoothstep(top_y + 2.0, top_y - 1.0, y)
    return d, out
