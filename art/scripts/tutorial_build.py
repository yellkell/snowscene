"""The tutorial mountain -> art/work/tutorial.blend (HIGH scene for Cycles renders and bakes).

blender -b --factory-startup --python art/scripts/tutorial_build.py

Built over the game's own layout (art/work/heights_tutorial.*, art/work/tutorial_ref/ from
export_heights.mjs and export_tutorial_ref.mjs): the ground is groundAt, the holds sit where the climb
system looks for them, trees and rocks stand where the game planted them.

Game (x, y, z) = Blender (x, -z, y).
"""
import bpy, sys, os, json, math, random
import numpy as np
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from lib import scene as S, snowmats as SM, sky as SKY, cliff as CL, cabin as CB, trailkit as TK, bluff as BL, ranges as RG, party as PT  # noqa: E402

ART = os.path.dirname(HERE)
WORK = os.path.join(ART, 'work')
REF = os.path.join(WORK, 'tutorial_ref')
LAYOUT = json.load(open(os.path.join(REF, 'layout.json')))
H = S.Heights('tutorial')
C = H.meta['constants']
RNG = random.Random(7)
# The game's sun: very low in the south-west, the last light after the storm.
SUN_DIR_GAME = Vector((-0.72, 0.065, 0.68)).normalized()
SUN_AZIM = math.degrees(math.atan2(-SUN_DIR_GAME.z, SUN_DIR_GAME.x))
SUN_ELEV = math.degrees(math.asin(SUN_DIR_GAME.y))


def path_x(z):
    s = min(max(-z, -40.0), C['WALL_S'] + 30.0)
    return 4.5 * math.sin(s * 0.05)


def game_to_blender(p):
    return Vector((p[0], -p[2], p[1]))


def mat_from_game(m16):
    """Column-major three.js Matrix4 (game space) -> Blender world matrix."""
    M = Matrix([[m16[0], m16[4], m16[8], m16[12]], [m16[1], m16[5], m16[9], m16[13]],
                [m16[2], m16[6], m16[10], m16[14]], [0, 0, 0, 1]])
    G2B = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
    return G2B @ M @ G2B.inverted()


def build_ground():
    g = S.Heights('tutorial').grid_mesh('GROUND', step=1.0, coll=S.coll('HIGH'))
    me = g.data
    # trail mask: 1 on the path's centre line, fading out over its walkable half-width
    co = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    z = -co[:, 1]
    s = -z
    px = 4.5 * np.sin(np.clip(s, -40, C['WALL_S'] + 30) * 0.05)
    d = np.abs(co[:, 0] - px)
    along = np.clip((s + 6) / 3, 0, 1) * np.clip((C['WALL_S'] - 0.5 - s) / 1.5, 0, 1)
    trail = np.clip(1 - (d - 0.6) / 1.4, 0, 1) * along
    a = me.attributes.new('trail', 'FLOAT', 'POINT')
    a.data.foreach_set('value', trail.astype(np.float32))
    me.materials.append(SM.snow_ground())
    return g


def plant_forest(variants):
    """The game's own 520 tree spots, each given the spruce variant nearest its height."""
    trees = S.coll('TREES', S.coll('HIGH'))
    tall = sorted(((h, k) for k, (c, h) in variants.items() if k.startswith('spruce_')))
    out = []
    for i, m16 in enumerate(LAYOUT['trees']):
        M = mat_from_game(m16)
        loc, rot, sca = M.decompose()
        # game trees are 6-15 m; their instance scale is their height over a unit tree
        target = max(sca.z, 1.0)
        h, key = min(tall, key=lambda hk: abs(hk[0] - target * 1.0))
        s = target / h if target > 4 else 1.0
        z = H(loc.x, loc.y) - 0.1
        S.instance(variants[key][0], f'T_{i}', (loc.x, loc.y, z), 0.0, s, parent_coll=trees)
        out.append({'kind': key, 'x': round(loc.x, 3), 'y': round(z, 3), 'z': round(-loc.y, 3), 's': round(s, 3)})
    return out


def under_summit(inst, x, margin=0.35):
    """The scans either side of the wall are open shells (only the face toward the bowl). Standing taller
    than the summit, they showed their open tops and backs from up there: you looked through them, their
    ragged edges black slivers in the air. Lower one until its top is under the summit snow beside it; from
    the bowl it still shoulders the wall. Every part of it behind the line of the face (the summit side) is
    checked against the snow right above it: a wide scan's corner poked up where the summit dips."""
    bpy.context.view_layer.update()
    face_y = -LAYOUT['cliff']['faceZ']
    sink = 0.0
    for o in inst.instance_collection.all_objects:
        if o.type != 'MESH':
            continue
        mw = inst.matrix_world @ o.matrix_world
        for i, v in enumerate(o.data.vertices):
            if i % 5:
                continue
            p = mw @ v.co
            if p.y > face_y + 0.5:
                sink = max(sink, p.z - (H(p.x, p.y) - margin))
    if sink > 0:
        inst.location.z -= sink
        print('band', inst.name, 'lowered', round(sink, 2), flush=True)
    bpy.context.view_layer.update()


def place_rocks(models):
    """The game's talus and trail boulders as half-buried, snow-capped granite."""
    props = S.coll('PROPS', S.coll('HIGH'))
    kinds = [k for k in models if 'boulder' in k]
    out = []
    for i, m16 in enumerate(LAYOUT.get('rocks', [])):
        M = mat_from_game(m16)
        loc, rot, sca = M.decompose()
        r = max(sca.x, sca.y, sca.z)        # the game's rocks are unit icospheres scaled to their radius
        kind = kinds[i % len(kinds)]
        s = r * 0.9
        z = H(loc.x, loc.y) - 0.35 * s
        S.instance(models[kind], f'R_{i}', (loc.x, loc.y, z), RNG.uniform(0, math.tau), s,
                   (RNG.uniform(-0.25, 0.25), RNG.uniform(-0.25, 0.25)), props)
        out.append({'kind': kind, 'x': loc.x, 'z': -loc.y, 's': s})
    return out


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    S.coll('HIGH')
    print('ground', flush=True)
    build_ground()
    print('spruce', flush=True)
    variants = S.spruce_variants([k for k in ('spruce_0', 'spruce_1', 'spruce_2', 'spruce_3', 'spruce_4', 'spruce_5', 'spruce_6', 'spruce_7')])
    print('forest', flush=True)
    layout = {'trees': plant_forest(variants)}
    print('rocks', flush=True)
    models = S.scanned_props(S.ROCK_MODELS)
    layout['rocks'] = place_rocks(models)
    print('cliff', flush=True)
    cc = S.coll('CLIFF', S.coll('HIGH'))
    face, info = CL.build_face(cc, holds=LAYOUT['holds'])
    CL.build_icicles(cc, info)
    lips = [h['p'][0] for h in LAYOUT['holds'] if h.get('lip')]
    CL.build_cornice(cc, info, exit_x=(min(lips), max(lips)) if lips else None)
    # The wall is the climbable heart of a band of rock across the couloir: scanned cliff faces
    # (re-graded to the same cold granite) shoulder it on both sides and step up the slopes.
    from lib import rocks as RK
    bands = {}
    for mid in ('mountainside', 'namaqualand_cliff_01'):
        objs = S.import_model(mid)
        for o in objs:
            for m in o.data.materials:
                if m and not m.get('regraded'):
                    RK.regrade(m, sat=0.16, val=0.7)
                    m['regraded'] = True
        S.snowify(objs, threshold=0.62, softness=0.1, noise_scale=1.5)
        bands[mid] = S.variant_collection(objs[0], 'V_' + mid)
    cx, fy = info['cx'], -info['face_z']
    base = C['CLIFF_BASE_Y']
    for name, mid, dx, dy, dz, sc_, rz in (
            ('L1', 'mountainside', -13.2, 1.2, -2.2, 1.0, 0.12),
            # (namaqualand_cliff_02's thin overhanging flakes, seen from the summit against the sky, read as
            # black chips hanging in the air: the mountainside scan, turned, stands here instead)
            ('R1', 'mountainside', 18.0, 1.6, -1.8, 0.9, -0.3),
            ('L2', 'namaqualand_cliff_01', -24.0, 4.5, 1.5, 1.3, 0.3),
            ('R2', 'mountainside', 30.0, 5.0, 2.5, 1.1, -0.35)):
        x = cx + dx
        inst = S.instance(bands[mid], f'BAND_{name}', (x, fy + dy, max(base + dz, H(x, fy + dy) - 1.5)), rz, sc_, parent_coll=cc)
        if name in ('L1', 'R1'):
            under_summit(inst, x)
    # Buttresses that take the wall's edges into the mountain: without them the face's straight sides
    # stand bare in the snow and it reads as a block. Each overlaps the outer 1.8 m of the face (the holds
    # are in the middle), stands a little proud of it and roots a metre below its foot.
    from mathutils import Vector as _V
    # (against the game's rectangle: the face mesh itself now rolls on past it into the mountain)
    f_x0, f_x1 = info['cx'] - info['half'], info['cx'] + info['half']
    f_y0 = -info['face_z']
    f_z0 = info['bottom']

    def fit(inst, x0=None, x1=None):
        bpy.context.view_layer.update()
        pts = [inst.matrix_world @ s.matrix_world @ _V(c) for s in inst.instance_collection.all_objects
               if s.type == 'MESH' for c in s.bound_box]
        bx0, bx1 = min(p.x for p in pts), max(p.x for p in pts)
        by0, bz0 = min(p.y for p in pts), min(p.z for p in pts)
        dx = (x1 - bx1) if x1 is not None else (x0 - bx0)
        # root it a metre below the face's foot, or below the snow where the bank rises higher
        cx_ = (bx0 + bx1) / 2 + dx
        zmin = max(f_z0 - 1.0, H(cx_, f_y0 + 2.0) - 2.5)
        inst.location += _V((dx, (f_y0 - 0.6) - by0, zmin - bz0))
    for name, mid, rz, sc_, side in (('LE', 'mountainside', 0.18, 1.45, -1), ('RE', 'mountainside', math.pi - 0.22, 1.4, 1)):
        inst = S.instance(bands[mid], f'BAND_{name}', (f_x0 if side < 0 else f_x1, f_y0, f_z0), rz, sc_, parent_coll=cc)
        fit(inst, x1=f_x0 - 1.2) if side < 0 else fit(inst, x0=f_x1 + 1.2)
        under_summit(inst, inst.location.x)
    # Crags along the broken skyline outside the lane, set back into the summit snow, and a talus apron of
    # blocks that have come off the band, lying in the snow at its foot (clear of the climb's start).
    rocks_big = [k for k in ('namaqualand_boulder_04', 'namaqualand_boulder_03', 'namaqualand_boulder_06', 'boulder_01') if k in models]
    for i, (lx, s_) in enumerate(((-6.3, 2.2), (-3.4, 1.35), (4.4, 2.5), (7.6, 1.7), (-8.9, 1.5))):
        x = info['cx'] + lx
        z = float(info['topline'](x)) - 0.45 * s_
        S.instance(models[rocks_big[i % len(rocks_big)]], f'BAND_CRAG_{i}', (x, f_y0 + 0.5 + 0.35 * s_, z),
                   RNG.uniform(0, math.tau), s_, (RNG.uniform(-0.2, 0.2), RNG.uniform(-0.2, 0.2)), cc)
    for i in range(11):
        side_ = -1 if i % 2 else 1
        lx = side_ * RNG.uniform(2.9, 9.0)
        dist = RNG.uniform(0.5, 3.4)
        s_ = RNG.uniform(0.28, 0.85) * (1.2 if dist < 1.2 else 1.0)
        x, y = info['cx'] + lx, f_y0 - dist
        S.instance(models[rocks_big[i % len(rocks_big)]], f'BAND_TALUS_{i}', (x, y, H(x, y) - 0.35 * s_),
                   RNG.uniform(0, math.tau), s_, (RNG.uniform(-0.3, 0.3), RNG.uniform(-0.3, 0.3)), cc)
    print('bluff', flush=True)
    bc = S.coll('BLUFF', S.coll('HIGH'))
    face_z = -(C['BLUFF_FACE_S'] - 0.3)
    mz = face_z + 0.15
    mouth = (C['BLUFF_X'], H(C['BLUFF_X'], -(mz + 1)), mz)
    bf = BL.build_face(bc, C, mouth)
    # talus at the bluff's foot (clear of the adit approach), baked with the props
    vs = np.array([bf.matrix_world @ v.co for v in bf.data.vertices])
    bins = {}
    for v in vs:
        k = int(v[0] // 1.0)
        if k not in bins or v[2] < bins[k][2]:
            bins[k] = v
    base = [v for k, v in sorted(bins.items()) if abs(v[0] - mouth[0]) > 3.5]
    rk = [k for k in models if 'boulder' in k]
    pc_ = S.coll('PROPS', S.coll('HIGH'))
    for i in range(min(9, len(base))):
        v = base[RNG.randrange(len(base))]
        s_ = RNG.uniform(0.4, 1.2)
        x, y = float(v[0]), float(v[1]) - RNG.uniform(0.6, 2.6)
        S.instance(models[rk[i % len(rk)]], f'R_BT_{i}', (x, y, H(x, y) - 0.35 * s_), RNG.uniform(0, math.tau), s_,
                   (RNG.uniform(-0.3, 0.3), RNG.uniform(-0.3, 0.3)), pc_)
    # the terrain steps up to the shelf just behind the face: carve it out of the tunnel's volume
    g = bpy.data.objects['GROUND']
    import bmesh as _bm
    bm = _bm.new()
    bm.from_mesh(g.data)
    floor = mouth[1]
    def in_tunnel(f):
        c = f.calc_center_median()
        return (abs(c.x - mouth[0]) < 1.7 and -mz - 0.3 < c.y < -mz + 9.0
                and min(v.co.z for v in f.verts) < floor + 3.6 and max(v.co.z for v in f.verts) > floor - 0.2)
    kill = [f for f in bm.faces if in_tunnel(f)]
    _bm.ops.delete(bm, geom=kill, context='FACES')
    bm.to_mesh(g.data)
    bm.free()
    BL.build_adit(bc, mouth)
    deck_c = S.coll('BEACON_DECK', S.coll('HIGH'))
    BL.build_deck(deck_c, LAYOUT['points']['BLUFF_TOP_Y'], C['BLUFF_FACE_S'], LAYOUT['points']['BEACON_TOP'], C['BLUFF_X'])
    print('trail', flush=True)
    tk = S.coll('TRAIL', S.coll('HIGH'))
    side = 1
    s_ = 5.0
    k = 0
    while s_ < C['TRAIL_END_S'] - 1:
        z = -s_
        x = path_x(z) + side * 2.5
        pole = TK.snow_pole(f'POLE_{k}', tk, seed=k)
        pole.location = (x, -z, H(x, -z) - 0.02)
        side, s_, k = -side, s_ + 6, k + 1
    sx, sz = path_x(-6) + 3.1, -6.0
    sign = TK.trail_sign('TRAIL_SIGN', tk)
    for o in [sign] + [o for o in tk.objects if o.name.startswith('TRAIL_SIGN_t')]:
        o.matrix_world = Matrix.Translation((sx, -sz, H(sx, -sz))) @ Matrix.Rotation(-0.35 + math.pi, 4, 'Z') @ o.matrix_world
    px, pz = LAYOUT['cliff']['centerX'] - 2.9, C['WALL_Z'] - 3.7
    plaque = TK.summit_plaque('SUMMIT_SIGN', tk)
    for o in [plaque] + [o for o in tk.objects if o.name.startswith('SUMMIT_SIGN_t')]:
        o.matrix_world = Matrix.Translation((px, -pz, H(px, -pz))) @ Matrix.Rotation(0.9, 4, 'Z') @ o.matrix_world
    print('cabins', flush=True)
    hut = bpy.data.collections.new('V_hut')
    S.src_coll().children.link(hut)
    CB.build('hut', hut)
    CB.drifts('hut_drifts', hut)
    cabins = S.coll('CABINS', S.coll('HIGH'))
    for i, (x, z, r) in enumerate(LAYOUT['cabins']):
        S.instance(hut, f'CABIN_{i}', (x, -z, H(x, -z) - 0.08), r, 1.0, parent_coll=cabins)
    print('party', flush=True)
    fx, fy, fz = LAYOUT['points']['FIRE_POS']
    pc = S.coll('PARTY', S.coll('HIGH'))
    party = PT.build(pc)
    party.location = (fx, -fz, fy)
    PT.lake_ice(S.coll('LAKE', S.coll('HIGH')), (C['LAKE_CENTER_X'], C['LAKE_CENTER_Z']), (C['LAKE_RADIUS_X'], C['LAKE_RADIUS_Z']), C['LAKE_Y'])
    print('rim', flush=True)
    # The ring of ranges round the bowl, out to where the vista panorama takes over.
    meta0 = SKY.prep('qwantani_sunset_puresky')
    RG.WORLD_ROT = math.radians(360.0 * (0.5 - meta0['u']) - SUN_AZIM)
    RG.ranges_mesh(min_r=355.0, max_r=RG.PANO_MIN_R + 200.0, name='RIM', coll=S.coll('HIGH'), step=2, erode=True, ground=H)
    # light: the clear evening after the storm
    meta = SKY.world('qwantani_sunset_puresky', SUN_AZIM, strength=1.0)
    SKY.sun_lamp(meta, SUN_AZIM, SUN_ELEV)
    layout['sky'] = meta
    layout['sun'] = {'azim_deg': SUN_AZIM, 'elev_deg': SUN_ELEV}
    # cameras along the journey (eye height 1.65 m)
    def eye(x, z, tx, tz, up=1.65, lens=18, tup=None):
        loc = (x, -z, H(x, -z) + up)
        tgt = (tx, -tz, (H(tx, -tz) + (tup if tup is not None else up)))
        return S.camera(f'CAM_{len([o for o in bpy.data.objects if o.type == "CAMERA"])}', loc, tgt, lens)
    cams = {
        'start': ((0, 0.4), (path_x(-20), -20)),
        'trail30': ((path_x(-30), -30), (path_x(-60), -60)),
        'cliff': ((path_x(-66), -66), (C['CLIFF_CENTER_X'] if 'CLIFF_CENTER_X' in C else -2, -72)),
        'back': ((path_x(-40), -40), (0, 120)),
    }
    for name, ((x, z), (tx, tz)) in cams.items():
        cam = eye(x, z, tx, tz, tup=6.0 if name == 'cliff' else None)
        cam.name = 'CAM_' + name
    # hanging on the wall mid-climb, and close to it from the foot
    cx = LAYOUT['cliff']['centerX']
    fz = LAYOUT['cliff']['faceZ']
    S.camera('CAM_wall', (cx + 0.15, -(fz + 0.75), 22.6), (cx - 0.1, -(fz), 23.4), lens=16).name = 'CAM_wall'
    S.camera('CAM_foot', (cx + 2.5, -(fz + 4.0), 21.2), (cx - 0.5, -fz, 24.0), lens=18).name = 'CAM_foot'
    S.camera('CAM_hut', (-3.5, 3.0, H(-3.5, 3.0) + 1.65), (-9.5, -4.5, H(-9.5, -4.5) + 1.6), lens=24).name = 'CAM_hut'
    S.camera('CAM_sign', (1.2, 4.0, H(1.2, 4.0) + 1.65), (path_x(-6) + 3.1, 6.0, H(4.4, 6.0) + 1.5), lens=28).name = 'CAM_sign'
    S.camera('CAM_adit', (1.5, 84.5, H(1.5, 84.5) + 1.65), (-3.0, 95.5, H(-3.0, 95.0) + 2.2), lens=20).name = 'CAM_adit'
    S.camera('CAM_deck', (-3.0, 99.6, LAYOUT['points']['BLUFF_TOP_Y'] + 1.65), (-1.0, 106.0, LAYOUT['points']['BLUFF_TOP_Y'] + 1.4), lens=18).name = 'CAM_deck'
    fx, fy, fz = LAYOUT['points']['FIRE_POS']
    S.camera('CAM_party', (fx - 2, -(fz - 24), fy + 1.65), (fx, -fz, fy + 1.4), lens=22).name = 'CAM_party'
    sc.camera = bpy.data.objects['CAM_start']
    sc.render.engine = 'CYCLES'
    sc.view_settings.view_transform = 'AgX'
    json.dump(layout, open(os.path.join(WORK, 'tutorial_layout.json'), 'w'), indent=1)
    out = os.path.join(WORK, 'tutorial.blend')
    bpy.ops.wm.save_as_mainfile(filepath=out, compress=False)
    print('saved', out, len(layout['trees']), 'trees', len(layout['rocks']), 'rocks', flush=True)


main()
