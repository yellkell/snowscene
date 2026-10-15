"""VOIDSTEP: the ice mine inside the glacier -> art/work/cave.blend (HIGH scene for Cycles look-dev and bakes).

    node art/scripts/export_cave_ref.mjs          (the game's layout -> art/work/cave_ref/cave_layout.json)
    blender -b --factory-startup --python art/scripts/cave_build.py

Course space (the cave root sits at CAVE_ORIGIN in the game). Game (x, y, z) = Blender (x, -z, y).

Collections:
  SHELL     the glacier cavity (CAVE_SHELL), icicles (CAVE_ICICLES), the pool (CAVE_POOL), the sky disc
  WORKS     every fixed timber: statics (head frames, tracks, trestles, swing beams, cables, the wheel's
            tower), the 13 stations (with their deck tiles), racks, plinth, brazier, lanterns
  MACHINES  the 15 machines and the mill wheel, each an object at its bar-0 pose, built in its own frame
  ROPES     the runtime ropes at bar 0 (look-dev only)
  LIGHTS    lantern / beacon / daylight emitters, each tagged with its channel
"""
import bpy, sys, os, json, math, random
import numpy as np
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from lib import core, scene as S, snowmats as SM, cavemats as CM, cavekit as K, caveshell as SH  # noqa: E402

ART = os.path.dirname(HERE)
WORK = os.path.join(ART, 'work')
L = K.layout()
RNG = random.Random(17)
POOL_Y = L['poolY']
GRID = L['grid']


def mats():
    return {
        'timber': CM.timber('cave_timber', val=0.42),
        'timber_dark': CM.timber('cave_timber_dark', val=0.32, sat=0.5),
        'rail': CM.timber('cave_rail', val=0.42, pale=True),
        'deck': CM.timber('cave_deck', val=0.62, sat=0.62, frost=0.12, tint=(0.2, 0.16, 0.12, 0.45)),
        'nosing': CM.timber('cave_nosing', val=0.55, pale=True, frost=0.08, tint=(0.5, 0.44, 0.34, 0.85)),
        'endgrain': CM.endgrain(),
        'iron': CM.iron(),
        'brass': CM.brass(),
        'steel': CM.steel(),
        'rope': CM.rope(),
        'wire': CM.wire_rope(),
        'stone': CM.stone(),
        'coals': CM.coals(),
        'soot': CM.soot(),
        'lantern_glass': CM.glass_lit('cave_lantern_glass', 'lantern', strength=10.0),
        'lantern_flame': CM.flame('cave_lantern_flame', 'lantern', strength=80.0),
        'beacon_flame': CM.flame('cave_beacon_flame', 'beacon', color=(1.0, 0.45, 0.12), strength=40.0),
        'ice': CM.ice_shell(glow=0.022),
        'icicle': CM.clear_ice(),
        'water': CM.water(),
    }


def group_parts(name):
    return [p for p in L['parts'] if p['group'] == name]


def platform(pid):
    return next(p for p in L['platforms'] if p['id'] == pid)


def anchor(pid):
    """A platform's anchor at bar 0 (course space, list)."""
    return L['groups']['platform:' + pid]


def seed_of(s):
    return sum(ord(ch) * (i + 1) for i, ch in enumerate(s)) % 10007


# ---------------------------------------------------------------- shell
def wall_anchors():
    """Ends of the station cantilevers and struts that the game runs into the ice wall (course space)."""
    out = []
    for p in L['parts']:
        g = p['group']
        if not g.startswith('platform:') or p['type'] != 'CylinderGeometry' or not p['mat'].startswith('wood'):
            continue
        pl = platform(g.split(':', 1)[1])
        if pl['kind'] != 'station':
            continue
        c, x, y, z = K.m3(p['matrix'])
        hh = p['params']['height'] * y.length / 2
        if hh < 0.8:
            continue
        a = Vector(anchor(pl['id']))
        for e in (c - y.normalized() * hh, c + y.normalized() * hh):
            if Vector((e.x, 0, e.z)).length > 1.0:     # the wall end, not the end under the deck
                out.append([a.x + e.x, a.y + e.y, a.z + e.z])
    return out


def reach_wall(V):
    """Carry each station cantilever and strut that stops short of the sculpted wall on into it (15 cm deep).
    The wall used to be pulled out to meet the timber instead: where that was a metre or more, the ice was
    drawn out into a long torn tent round the beam's end."""
    from mathutils.bvhtree import BVHTree
    ny, nx, _ = V.shape
    verts = [Vector(v) for v in V.reshape(-1, 3)]
    polys = [(j * nx + i, j * nx + (i + 1) % nx, (j + 1) * nx + (i + 1) % nx, (j + 1) * nx + i) for j in range(ny - 1) for i in range(nx)]
    tree = BVHTree.FromPolygons(verts, polys)
    n = 0
    for p in L['parts']:
        g = p['group']
        if not g.startswith('platform:') or p['type'] != 'CylinderGeometry' or not p['mat'].startswith('wood'):
            continue
        pl = platform(g.split(':', 1)[1])
        if pl['kind'] != 'station':
            continue
        c, x, y, z = K.m3(p['matrix'])
        hh = p['params']['height'] * y.length / 2
        if hh < 0.8:
            continue
        a = Vector(anchor(pl['id']))
        d = y.normalized()
        for sgn in (-1, 1):
            e = c + d * (hh * sgn)
            if Vector((e.x, 0, e.z)).length <= 1.0:
                continue
            out = d * sgn
            hit = tree.ray_cast(a + e, out, 4.0)
            if hit[0] is None or hit[3] < 0.02:
                continue
            ext = hit[3] + 0.15
            m = p['matrix']
            k = (2 * hh + ext) / (2 * hh)
            for i in (4, 5, 6):
                m[i] *= k
            for i, v in zip((12, 13, 14), out * (ext / 2)):
                m[i] += v
            hh += ext / 2
            c = c + out * (ext / 2)
            n += 1
            print('  cantilever carried', round(hit[3], 2), 'm on into the wall', flush=True)
    return n


def build_shell(coll, M, clear):
    V = SH.shell_grid(L, fy=8, fx=20)
    V, attrs, N = SH.sculpt(L, V, clear, random.Random(5))
    reach_wall(V)
    anchors = wall_anchors()
    V = SH.embed(L, V, anchors)
    V = SH.unfold(V)
    keys = ('thin', 'rock', 'dirt', 'fall', 'milky', 'cusp', 'notch', 'crack', 'moulin', 'rim', 'layer')
    ob = SH.to_mesh('CAVE_SHELL', V, {k: attrs[k] for k in keys}, coll, M['ice'])
    # the runtime's wall: every third ring and segment of the same grid (so its unrolled UVs are exact),
    # from just under the waterline up; the bake carries the full wall's shading onto it
    ny = V.shape[0]
    rows = list(range(0, ny, 4))
    if rows[-1] != ny - 1:
        rows.append(ny - 1)
    first = max(0, next(i for i, r in enumerate(rows) if V[r, :, 1].max() > L['poolY'] - 0.45) - 1)
    lowV = V[rows[first:]][:, ::5]
    low = SH.to_mesh('CAVE_SHELL_LOW', lowV, {}, coll, M['ice'], cap=False)
    low.hide_render = True
    low.hide_set(True)
    print('shell', len(ob.data.vertices), 'verts; low', len(low.data.vertices), ';', len(anchors), 'anchors', flush=True)
    return ob, V, attrs


def build_pool(coll, M, V):
    """The meltwater's surface: the shell's outline at the waterline, filled."""
    ny, nx, _ = V.shape
    ring = []
    for i in range(nx):
        col = V[:, i]
        k = int(np.argmax(col[:, 1] > POOL_Y))
        a, c = col[max(k - 1, 0)], col[k]
        f = (POOL_Y - a[1]) / max(c[1] - a[1], 1e-6)
        p = a + (c - a) * f
        ring.append(Vector((p[0], -p[2], POOL_Y)))
    ring = ring[::4]
    cen = sum(ring, Vector()) / len(ring)
    b = core.Builder('CAVE_POOL', coll)
    for i in range(len(ring)):
        j = (i + 1) % len(ring)
        # push the rim a little into the wall so no seam shows
        a = ring[i] + (ring[i] - cen).normalized() * 0.15
        c = ring[j] + (ring[j] - cen).normalized() * 0.15
        b.poly([cen, a, c], M['water'])
    ob = b.finish()
    if ob.data.polygons[0].normal.z < 0:
        ob.data.flip_normals()
    return ob


def icicle(b, root, length, r0, mat, rng, seg=8):
    """A carrot of ice from `root` (game space, already 3 cm into the ice) hanging down: fat where it
    froze onto the lip, rippled where each drip refroze, a needle at the tip. Round enough (8 sides, 7
    rings) not to read as a paper cone up close."""
    tip = root - np.array([rng.gauss(0, 0.012 * length), length, rng.gauss(0, 0.012 * length)])
    a = K.gv(root)
    c = K.gv(tip)
    ph = rng.uniform(0, 6)
    prof = []
    n = 7
    for s in range(n):
        f = s / (n - 1)
        rr = r0 * (1 - f) ** 1.35 * (1 + 0.12 * math.sin(f * 21 + ph) * (1 - f)) * (1.3 if s == 0 else 1.0)
        prof.append((max(rr, 0.0005), f * length))
    b.element()
    b.lathe(prof + [(0.0, length + 0.003)], a, (c - a).normalized(), mat, seg=seg, smooth=True, cap0=True)


def build_icicles(coll, M, V, clear, rng, curtains=125):
    """Icicles on the drip lines: the lips where an overhang's roof turns down into the wall below it
    (and, sparser, anywhere on a roof), hung in curtains that follow the lip from one grid column to the
    next, rooted 3 cm into the ice so each one grows out of the lip; clear of everything that moves."""
    ny, nx, _ = V.shape
    n = SH.grid_normals(V)
    ctr = V.mean(1, keepdims=True)
    ta = ctr - V
    ta[..., 1] = 0
    n[(n * ta).sum(-1) < 0] *= -1
    ny_ = n[..., 1]
    top = L['shellConst']['top']
    below = np.roll(ny_, 1, axis=0)                      # the vertex one ring lower
    lip = (ny_ < -0.3) & (below > -0.05)
    lip[0] = False
    roof = (ny_ < -0.55) & ~lip
    yy = V[..., 1]
    ok = (yy > L['poolY'] + 0.35) & (yy < top - 0.6)
    lip &= ok
    roof &= ok
    lips = np.argwhere(lip)
    roofs = np.argwhere(roof)
    b = K.CB('CAVE_ICICLES', coll, smooth_angle=60)
    made = 0
    for c in range(curtains):
        use_lip = rng.random() < 0.85 and len(lips)
        j, i = (lips if use_lip else roofs)[rng.randrange(len(lips) if use_lip else len(roofs))]
        k = rng.choice((1, 2, 3, 4, 6, 9, 13)) if use_lip else rng.choice((1, 1, 2))
        base = (rng.random() ** 2.2) * 1.6 + 0.08
        di = rng.choice((-1, 1))
        for m in range(k):
            ii = (i + di * m * rng.choice((1, 1, 2))) % nx
            # follow the lip up or down a ring as it wanders
            jj = j
            for dj in (0, 1, -1):
                if 0 < j + dj < ny and lip[j + dj, ii]:
                    jj = j + dj
                    break
            p = V[jj, ii] - n[jj, ii] * 0.03
            Lc = base * rng.uniform(0.3, 1.1) * (1 - 0.6 * abs(m - k / 2) / (k / 2 + 1))
            if not clear.segment_clear(p + np.array([0, 0.03, 0]), p - np.array([0, Lc, 0]), 0.45):
                continue
            icicle(b, p, Lc, max(0.006, Lc * rng.uniform(0.05, 0.09)), M['icicle'], rng)
            made += 1
    print('icicles', made, flush=True)
    return b.finish(merge=False)


def timber_drips(coll, M, parts, clear, rng, count=150):
    """Frozen drips under the fixed beams: where meltwater ran along a timber and froze off its underside."""
    beams = []
    for p in parts:
        if not p['mat'].startswith('wood'):
            continue
        c, x, y, z = K.m3(p['matrix'])
        prm = p['params']
        if p['type'] == 'BoxGeometry':
            ax = [x * prm['width'] / 2, y * prm['height'] / 2, z * prm['depth'] / 2]
            k = max(range(3), key=lambda i: ax[i].length)
            a_ = ax[k]
            hh = min(v.length for v in ax)
        elif p['type'] == 'CylinderGeometry':
            a_ = y * prm['height'] / 2
            hh = prm['radiusTop'] * x.length * 0.85
        else:
            continue
        if a_.length > 0.5 and abs(a_.normalized().y) < 0.35:
            beams.append((c - a_, c + a_, hh))
    b = K.CB('TIMBER_DRIPS', coll, smooth_angle=60)
    made = 0
    for _ in range(count * 4):
        if made >= count or not beams:
            break
        a_, c_, hh = beams[rng.randrange(len(beams))]
        q = a_.lerp(c_, rng.uniform(0.1, 0.9))
        root = np.array([q.x, q.y - hh + 0.01, q.z])
        Lc = (rng.random() ** 2) * 0.22 + 0.03
        if root[1] < L['poolY'] + 0.4 or not clear.segment_clear(root, root - np.array([0, Lc, 0]), 0.3):
            continue
        for m in range(rng.choice((1, 2, 3))):
            off = np.array([rng.uniform(-0.04, 0.04), 0, rng.uniform(-0.04, 0.04)])
            icicle(b, root + off, Lc * rng.uniform(0.5, 1.0), max(0.004, Lc * 0.07), M['icicle'], rng, seg=6)
        made += 1
    print('timber drips', made, flush=True)
    return b.finish(merge=False)


def build_debris(coll, M, V, attrs, clear, rng):
    """Real rocks in the ice: scanned boulders frozen half-in, half-out of the dirty layers, and ice-polished
    boulders and slabs along the waterline. Returns the instances (collection DEBRIS)."""
    from lib import rocks as RK
    models = []
    for mid in ('boulder_01', 'namaqualand_boulder_02', 'namaqualand_boulder_03', 'namaqualand_boulder_04',
                'namaqualand_boulder_05', 'namaqualand_boulder_06'):
        objs = S.import_model(mid)
        for o in objs:
            for m in o.data.materials:
                if m and not m.get('regraded'):
                    RK.regrade(m, sat=0.2, val=0.62)
                    SM.snowify(m, threshold=0.72, softness=0.12, noise_scale=7.0, bias=-0.15)
                    m['regraded'] = True
        size = max(objs[0].dimensions)
        models.append((S.variant_collection(objs[0], 'V_' + mid), size))
    ny, nx, _ = V.shape
    n = SH.grid_normals(V)
    ctr = V.mean(1, keepdims=True)
    ta = ctr - V
    ta[..., 1] = 0
    n[(n * ta).sum(-1) < 0] *= -1
    P = V.reshape(-1, 3)
    Nn = n.reshape(-1, 3)
    dirt = attrs['dirt']
    rock = attrs['rock']
    out = []

    def place(i, size, sink, name, flat=1.0):
        mc, ms = models[rng.randrange(len(models))]
        c = P[i] - Nn[i] * sink * size
        if clear.dist(c[None], 2.0)[0] < size * 0.6 + 0.35:
            return False
        s = size / ms
        inst = S.instance(mc, name, K.gv(c), rng.uniform(0, math.tau), (s, s, s * flat),
                          (rng.uniform(-0.6, 0.6), rng.uniform(-0.6, 0.6)), parent_coll=coll)
        out.append(inst)
        return True

    cand = np.nonzero((dirt > 0.55) & (P[:, 1] > 0.6) & (P[:, 1] < L['shellConst']['top'] - 1.5))[0]
    made = 0
    for _ in range(900):
        if made >= 140 or not len(cand):
            break
        i = int(cand[rng.randrange(len(cand))])
        if place(i, 0.06 + rng.random() ** 2.5 * 0.42, 0.2, f'DEBRIS_{made}'):
            made += 1
    shore = np.nonzero((rock > 0.5) & (P[:, 1] > L['poolY'] - 0.3) & (P[:, 1] < L['poolY'] + 0.6))[0]
    boulders = 0
    for _ in range(400):
        if boulders >= 34 or not len(shore):
            break
        i = int(shore[rng.randrange(len(shore))])
        slab = rng.random() < 0.35
        if place(i, rng.uniform(0.35, 1.3) * (1.6 if slab else 1.0), -0.15, f'SHORE_{boulders}', 0.35 if slab else 1.0):
            boulders += 1
    print('debris', made, 'shore rocks', boulders, flush=True)
    return out


# ---------------------------------------------------------------- works
def seg_part(a, b, r, mat, group='statics', sides=4):
    """A recorded-style rod (three CylinderGeometry, unit height, along a -> b; game space)."""
    a, b = np.array(a, float), np.array(b, float)
    d = b - a
    ln = float(np.linalg.norm(d))
    yv = d / ln
    ref = np.array([0.0, 0.0, 1.0]) if abs(yv[2]) < 0.9 else np.array([1.0, 0.0, 0.0])
    xv = np.cross(yv, ref)
    xv /= np.linalg.norm(xv)
    zv = np.cross(xv, yv)
    c = (a + b) / 2
    m = list(xv) + [0] + list(yv * ln) + [0] + list(zv) + [0] + list(c) + [1]
    return {'group': group, 'type': 'CylinderGeometry', 'mat': mat, 'matrix': [float(v) for v in m],
            'params': {'radiusTop': r, 'radiusBottom': r, 'height': 1, 'radialSegments': sides}}


def structure(parts, shell, clear):
    """Make the game's works stand up: tie rods that stop in mid-air are run on up into the ice and
    anchored there, guide posts that end in mid-air are carried down into the pool, and the long beams
    out to the wall get props down to the water wherever nothing passes. Returns the parts, amended."""
    from mathutils.bvhtree import BVHTree
    dg = bpy.context.evaluated_depsgraph_get()
    tree = BVHTree.FromObject(shell, dg)
    out = []
    plates = []
    floor = -0.9
    added = 0
    segs = []
    for p in parts:
        if not p['mat'].startswith('wood'):
            continue
        c, x, y, z = K.m3(p['matrix'])
        prm = p['params']
        if p['type'] == 'BoxGeometry':
            ax = [x * prm['width'] / 2, y * prm['height'] / 2, z * prm['depth'] / 2]
            a_ = max(ax, key=lambda v: v.length)
        elif p['type'] == 'CylinderGeometry':
            a_ = y * prm['height'] / 2
        else:
            continue
        if a_.length > 0.5:
            segs.append((c - a_, c + a_))
    for p in parts:
        typ, mat, prm = p['type'], p['mat'], p['params']
        c, x, y, z = K.m3(p['matrix'])
        if p['group'] == 'statics' and typ == 'CylinderGeometry' and mat == 'iron' and y.length * prm['height'] > 5:
            a_ = y * prm['height'] / 2
            lo, hi = (c - a_, c + a_) if a_.y > 0 else (c + a_, c - a_)
            d = (hi - lo).normalized()
            hit = tree.ray_cast(K.g2b(hi), K.g2b(d), 25.0)
            if hit[0] is not None:
                end = hit[0]
                ge = Vector((end.x, end.z, -end.y)) + d * 0.12
                if clear.segment_clear(list(hi), list(ge), 0.12):
                    out.append(seg_part(list(lo), list(ge), prm['radiusTop'] * x.length, 'iron', sides=6))
                    plates.append((ge - d * 0.12, d))
                    added += 1
                    print('  tie rod run up', round((ge - hi).length, 1), 'm into the ice', flush=True)
                    continue
            # up the chimney: carried on out of sight, past the sky in its mouth, to the surface
            top_y = L['shellConst']['top']
            if hi.y > top_y - 2.0:
                ge = hi + d * ((top_y + 3.0 - hi.y) / max(d.y, 0.2))
                if clear.segment_clear(list(hi), list(ge), 0.12):
                    out.append(seg_part(list(lo), list(ge), prm['radiusTop'] * x.length, 'iron', sides=6))
                    added += 1
                    print('  tie rod run up the chimney', round((ge - hi).length, 1), 'm', flush=True)
                    continue
            # or carried on straight up from its top
            hit = tree.ray_cast(K.g2b(hi), Vector((0, 0, 1)), 25.0)
            if hit[0] is not None:
                ge = Vector((hi.x, hit[0].z + 0.12, hi.z))
                if clear.segment_clear(list(hi), list(ge), 0.12):
                    out.append(p)
                    out.append(seg_part(list(hi), list(ge), prm['radiusTop'] * x.length * 0.8, 'iron', sides=6))
                    plates.append((ge - Vector((0, 0.12, 0)), Vector((0, 1, 0))))
                    added += 1
                    print('  tie rod hung from above', round(ge.y - hi.y, 1), 'm', flush=True)
                    continue
        if p['group'] == 'statics' and typ == 'BoxGeometry' and mat.startswith('wood'):
            ax = [x * prm['width'] / 2, y * prm['height'] / 2, z * prm['depth'] / 2]
            k = max(range(3), key=lambda i: ax[i].length)
            a_ = ax[k]
            if a_.length > 1.5 and abs(a_.normalized().y) > 0.97:
                lo = c - a_ if a_.y > 0 else c + a_
                if lo.y > floor + 0.5:
                    below = Vector((lo.x, floor, lo.z))
                    w = sorted(v.length for v in ax)[1]
                    if not clear.segment_clear([lo.x, lo.y - 0.05, lo.z], list(below), w + 0.06):
                        strut = brace_to(lo, segs, clear)
                        if strut:
                            out.append(p)
                            out.append(seg_part(list(lo), list(strut), 0.06, 'wood_dark'))
                            added += 1
                            print('  post braced', round((strut - lo).length, 1), 'm', flush=True)
                            continue
                        print('  post blocked at', [round(v, 1) for v in lo], flush=True)
                    else:
                        out.append(p)
                        out.append({**seg_part(list(lo + Vector((0, 0.02, 0))), list(below), w * 1.0, mat), 'type': 'CylinderGeometry'})
                        added += 1
                        print('  post carried down', round(lo.y - floor, 1), 'm', flush=True)
                        continue
        out.append(p)
    print('structure: amended', added, flush=True)
    return out, plates


def brace_to(p, segs, clear, reach=4.0):
    """A strut from a free post foot down (or across) to the nearest timber that can take it."""
    best, bd = None, reach
    for a, b in segs:
        ab = b - a
        t = max(0.0, min(1.0, (p - a).dot(ab) / max(ab.length_squared, 1e-9)))
        q = a + ab * t
        d = (q - p).length
        if 0.3 < d < bd and q.y <= p.y + 0.05 and clear.segment_clear(list(p), list(q), 0.1):
            best, bd = q, d
    return best


def wall_props(clear):
    """Props under the long beams the stations throw out to the wall: a post down into the pool every few
    metres where nothing passes (game space parts)."""
    out = []
    for p in L['parts']:
        g = p['group']
        if not g.startswith('platform:') or p['type'] != 'CylinderGeometry' or not p['mat'].startswith('wood'):
            continue
        pl = platform(g.split(':', 1)[1])
        if pl['kind'] != 'station':
            continue
        c, x, y, z = K.m3(p['matrix'])
        hh = p['params']['height'] * y.length / 2
        # under the level cantilevers only: a strut sloping down to the wall beneath one got a second row
        # of props hung from it, each stopping at the strut just beside one that went on up to the beam
        if hh * 2 < 6 or abs(y.normalized().y) > 0.05:
            continue
        a = Vector(anchor(pl['id']))
        p0, p1 = a + c - y.normalized() * hh, a + c + y.normalized() * hh
        n = int((p1 - p0).length / 4.0)
        for i in range(1, n + 1):
            q = p0.lerp(p1, i / (n + 1)) - Vector((0, 0.12, 0))
            bot = Vector((q.x, -0.9, q.z))
            if q.y > 0.5 and clear.segment_clear(list(q), list(bot), 0.16):
                out.append(seg_part(list(q), list(bot), 0.09, 'wood_dark'))
    print('wall props', len(out), flush=True)
    return out


def anchor_plates(coll, M, plates):
    b = K.CB('TIE_ANCHORS', coll)
    for at, d in plates:
        pb = K.gv(at)
        n = -K.g2b(d)
        R = Matrix((n.orthogonal().normalized(), n.cross(n.orthogonal()).normalized(), n)).transposed()
        b.cbox(pb, (0.16, 0.16, 0.02), M['iron'], bev=0.003, R_=R)
        K.bolt(b, pb + n * 0.01, n, M['iron'], size=0.02, washer=False)
    b.finish(merge=False)


def build_group(name, parts, at, coll, M, rng, protect=None):
    b = K.CB(name, coll, smooth_angle=35)
    w = K.Works(b, rng, M)
    for p in parts:
        w.part(p)
    nb = w.joints(M['iron'], protect)
    ob = b.finish(merge=False)
    ob.location = K.gv(at)
    return ob, nb


def build_wheel(coll, M, rng):
    """The mill wheel (6 m): an iron hub on its shaft, eight hewn spokes, a rim of curved felloes with an
    iron tyre, four bronze crank pins the gondolas hang from. Built about its hub (Blender: shaft on X)."""
    R = L['wheel']['r']
    b = K.CB('MC_wheel', coll, smooth_angle=35)
    w = K.Works(b, rng, M)
    X = Vector((1, 0, 0))
    # hub and shaft
    b.lathe([(0.0, -0.32), (0.09, -0.32), (0.09, -0.22), (0.27, -0.2), (0.3, -0.16), (0.3, 0.16), (0.27, 0.2), (0.09, 0.22), (0.09, 0.42), (0.0, 0.42)],
            Vector((0, 0, 0)), X, M['iron'], seg=20, smooth=True)
    for k in range(8):
        a = k / 8 * math.tau
        d = Vector((0, math.cos(a), math.sin(a)))
        side = Vector((1, 0, 0))
        # tenoned into the hub and through into the felloe (its centre is at R - 0.02)
        w.timber(d * 0.24, d * (R - 0.04), 0.11, 0.13, side=side, mat='timber_dark', seat=False)
        # iron straps where the spokes enter the hub and the rim
        K.strap(b, d * 0.42, d, Vector((1, 0, 0)), 0.22, 0.06, M['iron'], bolts=2)
        K.strap(b, d * 0.42, d, Vector((-1, 0, 0)), 0.22, 0.06, M['iron'], bolts=0)
    # felloes: 16 curved segments, each hewn in one piece along its arc, butted tight (a hairline at
    # each joint) under a fish plate
    nseg = 16
    for k in range(nseg):
        a0, a1 = k / nseg * math.tau + 0.0004, (k + 1) / nseg * math.tau - 0.0004
        pts = [Vector((0, math.cos(a0 + (a1 - a0) * t / 10), math.sin(a0 + (a1 - a0) * t / 10))) * (R - 0.02) for t in range(11)]
        K.hewn_path(b, pts, 0.14, 0.16, rng, M['timber'], M['endgrain'], Vector((1, 0, 0)))
        am = (a0 + a1) / 2 + math.pi / nseg
        dd = Vector((0, math.cos(am), math.sin(am)))
        tg = Vector((0, -math.sin(am), math.cos(am)))
        K.strap(b, dd * (R - 0.02) + Vector((0.071, 0, 0)), tg, Vector((1, 0, 0)), 0.2, 0.1, M['iron'], bolts=2)
        K.strap(b, dd * (R - 0.02) + Vector((-0.071, 0, 0)), tg, Vector((-1, 0, 0)), 0.2, 0.1, M['iron'], bolts=2)
    # iron tyre round the rim
    for k in range(8):
        ring = [Vector((0, math.cos((k * 8 + t) / 64 * math.tau), math.sin((k * 8 + t) / 64 * math.tau))) * (R + 0.065) for t in range(9)]
        K.tube(b, ring, 0.012, M['iron'], sides=6)
    # crank pins: bronze, out of the wheel's west face to the gondola hangers, a bearing block behind
    for k in range(4):
        a = k / 4 * math.tau
        d = Vector((0, math.cos(a), math.sin(a))) * R
        K.cylinder(b, d + Vector((-0.63, 0, 0)), d + Vector((0.03, 0, 0)), 0.045, M['brass'], sides=14)
        K.cylinder(b, d + Vector((-0.63, 0, 0)), d + Vector((-0.6, 0, 0)), 0.065, M['iron'], sides=14)
        K.box_iron(b, d + Vector((-0.1, 0, 0)), [Vector((0.03, 0, 0)), Vector((0, 0.12, 0)), Vector((0, 0, 0.12))], M['iron'])
    w.flush()
    ob = b.finish(merge=False)
    ob.location = K.gv(L['wheel']['hub'])
    return ob


def build_brazier(coll, M, rng):
    """The beacon: a dressed granite drum, a forged tripod and a basket of iron straps full of split
    pine, on the top deck's plinth (brazier-local, base at 0)."""
    at = L['groups']['brazier']
    b = K.CB('BRAZIER', coll, smooth_angle=40)
    Z = Vector((0, 0, 1))
    b.lathe([(0.0, 0.0), (0.4, 0.0), (0.42, 0.04), (0.41, 0.46), (0.36, 0.5), (0.0, 0.5)], Vector((0, 0, 0)), Z, M['stone'], seg=24)
    for k in range(3):
        a = k / 3 * math.tau + 0.4
        foot = Vector((math.cos(a) * 0.29, math.sin(a) * 0.29, 0.5))
        top = Vector((math.cos(a) * 0.17, math.sin(a) * 0.17, 1.02))
        K.cylinder(b, foot, top, 0.018, M['iron'], sides=8)
        b.cbox(foot + Vector((0, 0, 0.01)), (0.08, 0.08, 0.02), M['iron'], bev=0.004)
    # the basket: a ring at the rim, one at the bottom, curved straps between
    for z, r in ((1.0, 0.16), (1.3, 0.31)):
        for k in range(4):
            K.tube(b, [Vector((math.cos((k * 8 + t) / 32 * math.tau) * r, math.sin((k * 8 + t) / 32 * math.tau) * r, z)) for t in range(9)], 0.012, M['iron'], sides=6)
    for k in range(12):
        a = k / 12 * math.tau
        pts = [Vector((math.cos(a) * (0.16 + 0.15 * f ** 0.7), math.sin(a) * (0.16 + 0.15 * f ** 0.7), 1.0 + 0.3 * f)) for f in (0, 0.25, 0.5, 0.75, 1.0)]
        K.tube(b, pts, 0.008, M['iron'], sides=5)
    b.lathe([(0.0, 0.995), (0.165, 0.995), (0.165, 1.005), (0.0, 1.005)], Vector((0, 0, 0)), Z, M['iron'], seg=20)
    # split pine laid crosswise, charred
    for k in range(9):
        a = rng.uniform(0, math.pi)
        z = 1.05 + (k // 3) * 0.06
        d = Vector((math.cos(a), math.sin(a), 0)) * (0.17 + 0.04 * (k // 3))
        K.log(b, Vector((0, 0, z)) - d, Vector((0, 0, z)) + d, rng.uniform(0.025, 0.04), rng, M['soot'], M['coals'])
    ob = b.finish(merge=False)
    ob.location = K.gv(at)
    return ob


def build_decks(coll, src_coll, M):
    """The deck tile, and a copy of it on every square at bar 0 (stations in WORKS, machines in MACHINES)."""
    tile = K.deck_tile('DECK_TILE', src_coll, M)
    out = []
    for p in L['platforms']:
        a = anchor(p['id'])
        for sq in p['claim']:
            x, z = a[0] + sq[0] * GRID['pitch'], a[2] + sq[1] * GRID['pitch']
            o = bpy.data.objects.new(f'DECK_{p["id"]}_{sq[0]}_{sq[1]}', tile.data)
            o.location = K.gvec(x, a[1], z)
            o['platform'] = p['id']
            out.append(o)
            (coll['works'] if p['kind'] == 'station' else coll['machines']).objects.link(o)
    return tile, out


def build_ropes(coll, M):
    for i, r in enumerate(L['ropes']):
        if r['platform'] >= 0:
            a = anchor(L['platforms'][r['platform']]['id'])
            near = [a[0] + r['local'][0], a[1] + r['local'][1], a[2] + r['local'][2]]
        else:
            near = r['local']
        b = K.CB(f'ROPE_{i}', coll)
        K.tube(b, [K.gv(near), K.gv(r['far'])], 0.016, M['rope'], sides=8)
        b.finish(merge=False)


def hung_lantern_spots(clear, taken, want=14, spacing=3.6):
    """More oil lanterns, hung on iron brackets off the fixed posts (head frames, the wheel's tower, the
    trestles), wherever nothing that moves comes near, spread out so warm light reaches every level.
    Returns [(lantern centre, bracket root on the post face, outward dir)] in course space."""
    cands = []
    for p in L['parts']:
        if p['group'] != 'statics' or not p['mat'].startswith('wood'):
            continue
        c, x, y, z = K.m3(p['matrix'])
        prm = p['params']
        if p['type'] == 'BoxGeometry':
            ax = [x * prm['width'] / 2, y * prm['height'] / 2, z * prm['depth'] / 2]
            k = max(range(3), key=lambda i: ax[i].length)
            half = sorted(a_.length for a_ in ax)[1]
            a_ = ax[k]
        elif p['type'] == 'CylinderGeometry':
            a_ = y * prm['height'] / 2
            half = prm['radiusTop'] * x.length * 0.85
        else:
            continue
        if a_.length < 1.5 or abs(a_.normalized().y) < 0.97:
            continue                               # upright posts only
        lo, hi = c - a_, c + a_
        if lo.y > hi.y:
            lo, hi = hi, lo
        hgt = max(lo.y, -0.1) + 1.2
        while hgt < min(hi.y - 0.4, 29.0):
            for d in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                out = Vector((d[0], 0, d[1]))
                root = Vector((lo.x, hgt, lo.z)) + out * half
                at = root + out * 0.3 - Vector((0, 0.32, 0))
                cands.append((at, root, out))
            hgt += 1.6
    P = np.array([[c[0].x, c[0].y, c[0].z] for c in cands])
    ok = (clear.dist(P, 1.0) > 0.55) & (clear.dist(P + np.array([0, 0.35, 0]), 1.0) > 0.45)
    cands = [c for c, k in zip(cands, ok) if k]
    chosen = []
    pts = [Vector(t) for t in taken]
    while len(chosen) < want and cands:
        best, bd = None, -1
        for c in cands:
            d = min((c[0] - q).length for q in pts) if pts else 1e9
            if d > bd:
                best, bd = c, d
        if bd < spacing:
            break
        chosen.append(best)
        pts.append(best[0])
        cands.remove(best)
    return chosen


def lanterns(coll, lights, M, clear):
    """Every lantern: the game's (on the stations' corner posts) and the hung ones. Writes the extra ones'
    flame positions to art/work/cave_ref/lanterns_extra.json for the encoder."""
    src, flame_z = K.lantern_src(M)
    out = []
    taken = []
    for i, ln in enumerate(L['lanterns']):
        g = ln['group']
        base = L['groups'][g]
        p = [base[0] + ln['at'][0], base[1] + ln['at'][1] - 0.1, base[2] + ln['at'][2]]
        loc = K.gv(p)
        inst = S.instance(src, f'LANTERN_{i}', loc, RNG.uniform(0, math.tau), 1.0, parent_coll=coll)
        K.point_light(f'LAMP_{i}', loc + Vector((0, 0, flame_z)), 12.0, (1.0, 0.56, 0.24), 0.02, lights, 'lantern')
        out.append(inst)
        taken.append([p[0], p[1] + 0.15, p[2]])
    extra = []
    b = K.CB('LANTERN_BRACKETS', coll, smooth_angle=40)
    for j, (at, root, outd) in enumerate(hung_lantern_spots(clear, taken)):
        base = at - Vector((0, 0.15, 0))               # the lantern stands 29 cm tall; its bail at the top
        loc = K.gv(base)
        S.instance(src, f'LANTERN_H{j}', loc, RNG.uniform(0, math.tau), 1.0, parent_coll=coll)
        K.point_light(f'LAMP_H{j}', loc + Vector((0, 0, flame_z)), 12.0, (1.0, 0.56, 0.24), 0.02, lights, 'lantern')
        # a forged bracket: a plate on the post, an arm out with a stay under it, a hook at its end
        r = K.gv(root)
        top = K.gv(at + Vector((0, 0.42, 0)))
        o = K.gvec(outd.x, 0, outd.z)
        K.box_iron(b, r + Vector((0, 0, 0.42 - 0.32 + 0.0)), [o * 0.006, o.cross(Vector((0, 0, 1))).normalized() * 0.03, Vector((0, 0, 0.12))], M['iron'])
        arm0 = r + Vector((0, 0, 0.42 - 0.32 + 0.08))
        K.cylinder(b, arm0, top + Vector((0, 0, 0.0)), 0.009, M['iron'], sides=6)
        K.cylinder(b, r + Vector((0, 0, 0.42 - 0.32 - 0.09)), arm0 + o * 0.22, 0.006, M['iron'], sides=6)
        K.cylinder(b, top, top - Vector((0, 0, 0.12)), 0.004, M['iron'], sides=5)
        extra.append([round(at.x, 3), round(at.y + 0.02, 3), round(at.z, 3)])
    b.finish(merge=False)
    json.dump(extra, open(os.path.join(K.REF, 'lanterns_extra.json'), 'w'))
    print('lanterns', len(out), '+ hung', len(extra), flush=True)
    return out


def daylight(coll, V):
    """The chimney's daylight: a disc of pale sky over the throat (the only way light gets in; the world
    outside the glacier is black) and a broad soft source just above it for the shaft."""
    sc = bpy.context.scene
    w = bpy.data.worlds.new('CaveDark')
    sc.world = w
    w.use_nodes = True
    bg = next(n for n in w.node_tree.nodes if n.type == 'BACKGROUND')
    bg.inputs['Color'].default_value = (0, 0, 0, 1)
    bg.inputs['Strength'].default_value = 0.0
    # the sky disc closes the throat's top ring
    ring = V[-1]
    m = bpy.data.materials.new('cave_sky')
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs['Color'].default_value = (0.66, 0.78, 1.0, 1)
    em.inputs['Strength'].default_value = 0.5
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(em.outputs[0], out.inputs[0])
    CM.emitter('day', em.inputs['Strength'], 0.5)
    b = core.Builder('SKY_DISC', coll)
    cen = K.gv(ring.mean(0)) + Vector((0, 0, 0.02))
    pts = [K.gv(p) + Vector((0, 0, 0.02)) for p in ring[::6]]
    for i in range(len(pts)):
        b.poly([cen, pts[(i + 1) % len(pts)], pts[i]], m)
    disc = b.finish()
    if disc.data.polygons[0].normal.z > 0:
        disc.data.flip_normals()
    top = L['frame'][-1]
    ld = bpy.data.lights.new('DAY_AREA', 'AREA')
    ld.shape = 'ELLIPSE'
    ld.size = top[3] * 1.5
    ld.size_y = top[4] * 1.5
    ld.energy = 60.0
    ld.color = (0.78, 0.86, 1.0)
    ld.spread = math.radians(60)
    o = bpy.data.objects.new('DAY_AREA', ld)
    o.location = K.gv(ring.mean(0)) - Vector((0, 0, 0.3))
    o['channel'] = 'day'
    o['power'] = ld.energy
    coll.objects.link(o)
    return o


def cameras():
    """The player's eye on several decks (1.65 m), looking where the route goes next."""
    def cam(name, at, look, lens=16):
        S.camera('CAM_' + name, K.gv(at), K.gv(look), lens)
    P = {p['id']: anchor(p['id']) for p in L['platforms']}
    eye = lambda pid, dx=0.0, dz=0.0, up=1.65: [P[pid][0] + dx, P[pid][1] + up, P[pid][2] + dz]
    cam('jetty', eye('jetty', 0, 0.66), [5.4, 1.6, -2.5])
    cam('jetty_up', eye('jetty', 0, 0.66), [1.0, 9.0, -9.0])
    cam('loft', eye('loft'), [4.0, 4.6, -7.0])
    cam('ledge', eye('ledge'), [0.0, 5.5, -7.0])
    cam('wingrack', eye('wing-rack', 0, 0.66), [0.8, 10.5, -12.0])
    cam('wheel', eye('wheel-landing'), [-5.4, 12.6, -13.0])
    cam('skip', eye('skip-landing', 0, 0.66), [-5.4, 13.5, -19.5])
    cam('chimney', eye('chimney-foot'), [-3.0, 30.0, -14.0], lens=14)
    cam('bar', eye('bar-rack'), [0.6, 24.0, -13.0])
    cam('beacon', eye('beacon', 0.3, 0.3), [-1.0, 10.0, -6.0], lens=14)
    cam('overview', [6.5, 15.0, -1.0], [-1.0, 9.0, -12.0], lens=14)
    cam('feet', eye('jetty', 0, 0.66), [0.0, 0.0, -1.2], lens=18)
    cam('lantern', [0.25, 1.75, 1.0], [-0.93, 1.1, 0.2], lens=24)
    cam('wall', eye('jetty', 0, 0.66), [-4.0, 1.0, 5.0], lens=20)
    cam('wall2', eye('ledge', 0.66), [9.0, 5.0, -6.5], lens=20)


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    M = mats()
    clear = SH.Clearance(L)
    shell_c = S.coll('SHELL')
    works_c = S.coll('WORKS')
    mach_c = S.coll('MACHINES')
    rope_c = S.coll('ROPES')
    light_c = S.coll('LIGHTS')
    src = S.src_coll()
    print('shell', flush=True)
    shell, V, sattrs = build_shell(shell_c, M, clear)
    build_pool(shell_c, M, V)
    debris_c = S.coll('DEBRIS')
    build_icicles(debris_c, M, V, clear, random.Random(23))
    build_debris(debris_c, M, V, sattrs, clear, random.Random(29))
    print('works', flush=True)
    nb = 0
    statics, plates = structure(group_parts('statics'), shell, clear)
    statics += wall_props(clear)
    anchor_plates(works_c, M, plates)
    ob, n_ = build_group('WORKS_STATICS', statics, [0, 0, 0], works_c, M, random.Random(1))
    timber_drips(debris_c, M, statics, clear, random.Random(31))
    nb += n_
    for p in L['platforms']:
        g = 'platform:' + p['id']
        coll = works_c if p['kind'] == 'station' else mach_c
        ob, n_ = build_group(('ST_' if p['kind'] == 'station' else 'MC_') + p['id'], group_parts(g), anchor(p['id']), coll, M,
                             random.Random(seed_of(p['id'])))
        ob['platform'] = p['id']
        nb += n_
    for g in ('rack:LeftWing', 'rack:RightWing', 'rack:ControlBar', 'plinth'):
        build_group('WORKS_' + g.replace(':', '_'), group_parts(g), [0, 0, 0], works_c, M, random.Random(7))
    print('bolts', nb, flush=True)
    build_wheel(mach_c, M, random.Random(9))
    build_brazier(works_c, M, random.Random(11))
    tile, decks = build_decks({'works': works_c, 'machines': mach_c}, src, M)
    build_ropes(rope_c, M)
    lanterns(works_c, light_c, M, clear)
    bz = L['brazier']
    K.point_light('BEACON_FIRE', K.gv([bz[0], bz[1] - 0.15, bz[2]]), 220.0, (1.0, 0.5, 0.18), 0.25, light_c, 'beacon')
    daylight(light_c, V)
    cameras()
    sc.camera = bpy.data.objects['CAM_jetty']
    sc.render.engine = 'CYCLES'
    sc.view_settings.view_transform = 'AgX'
    sc.view_settings.exposure = 4.0
    K.separate_pieces([o for c in (works_c, mach_c) for o in c.all_objects])
    out = os.environ.get('CAVE_BLEND_OUT') or os.path.join(WORK, 'cave.blend')
    bpy.ops.wm.save_as_mainfile(filepath=out, compress=False)
    print('saved', out, flush=True)
    if os.environ.get('JOINERY_DUMP'):
        json.dump(K.Works.dump, open(os.environ['JOINERY_DUMP'], 'w'))


main()
