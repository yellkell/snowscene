"""Snow Survivors arena -> art/work/survivors.blend (HIGH scene for Cycles renders and bakes).

blender -b --factory-startup --python art/scripts/survivors_build.py

Coordinates: arena-relative, Blender Z up. Game (x, y, z) = Blender (x, z, -y).
Ground comes from art/work/heights_survivors.* (exported from the game's duneHeight), so what you see is
what you walk on. Every placement is written to art/work/survivors_layout.json for the runtime.
"""
import bpy, bmesh, sys, os, json, math, random
import numpy as np
from mathutils import Vector, Matrix, Euler

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from lib import snowmats as SM, spruce, rocks  # noqa: E402

ART = os.path.dirname(HERE)
WORK = os.path.join(ART, 'work')
H = json.load(open(os.path.join(WORK, 'heights_survivors.json')))
HD = np.fromfile(os.path.join(WORK, 'heights_survivors.bin'), dtype=np.float32).reshape(H['nz'], H['nx'])
RADIUS = H['radius']
HILL = H['hill']
HILL_TREE = H['hillTree']
RNG = random.Random(2026)

# The sun for the arena: the game's evening sun, a little higher so the swells aren't all in shade.
SUN_AZIM = math.degrees(math.atan2(-0.68, -0.72))  # toward the sun, Blender XY (south-west)
SUN_ELEV = 7.0


def height(x, y):
    """Ground height at Blender (x, y) = game (x, -y), bilinear from the exported grid."""
    gx = (x - H['x0']) / H['step']
    gz = (-y - H['z0']) / H['step']
    i = min(max(int(gx), 0), H['nx'] - 2)
    j = min(max(int(gz), 0), H['nz'] - 2)
    fx, fz = gx - i, gz - j
    a = HD[j, i] * (1 - fx) + HD[j, i + 1] * fx
    b = HD[j + 1, i] * (1 - fx) + HD[j + 1, i + 1] * fx
    return float(a * (1 - fz) + b * fz)


def slope(x, y, d=1.0):
    return math.hypot(height(x + d, y) - height(x - d, y), height(x, y + d) - height(x, y - d)) / (2 * d)


def coll(name, parent=None):
    c = bpy.data.collections.get(name) or bpy.data.collections.new(name)
    if c.name not in [x.name for x in (parent or bpy.context.scene.collection).children]:
        (parent or bpy.context.scene.collection).children.link(c)
    return c


# ---------------------------------------------------------------- ground
def build_ground(extent=420.0, step=1.0):
    """1 m grid (HIGH) over the arena and its forest; metric WorldUV for the scans."""
    stride = int(round(step / H['step']))
    sub = HD[::stride, ::stride]
    nz, nx = sub.shape
    xs = H['x0'] + np.arange(nx) * step
    zs = H['z0'] + np.arange(nz) * step
    X, Zg = np.meshgrid(xs, zs)
    verts = np.stack([X, -Zg, sub], axis=-1).reshape(-1, 3)
    i = np.arange(nx - 1)
    j = np.arange(nz - 1)
    I, J = np.meshgrid(i, j)
    a = (J * nx + I).ravel()
    quads = np.stack([a, a + 1, a + 1 + nx, a + nx], axis=1)
    me = bpy.data.meshes.new('ground_high')
    me.vertices.add(len(verts))
    me.vertices.foreach_set('co', verts.astype(np.float32).ravel())
    me.loops.add(quads.size)
    me.loops.foreach_set('vertex_index', quads.astype(np.int32).ravel())
    me.polygons.add(len(quads))
    me.polygons.foreach_set('loop_start', (np.arange(len(quads)) * 4).astype(np.int32))
    me.polygons.foreach_set('loop_total', np.full(len(quads), 4, np.int32))
    me.update(calc_edges=True)
    # Quads have their winding set so normals face up (Blender y = -game z flips the grid).
    me.flip_normals()
    uv = me.uv_layers.new(name='WorldUV')
    co = verts[quads.astype(np.int64).ravel()]
    uv.data.foreach_set('uv', co[:, :2].astype(np.float32).ravel())
    me.polygons.foreach_set('use_smooth', np.ones(len(quads), bool))
    ob = bpy.data.objects.new('GROUND', me)
    coll('HIGH').objects.link(ob)
    me.materials.append(SM.snow_ground())
    return ob


# ---------------------------------------------------------------- scanned assets
SRC = None


def import_model(mid):
    """Import a Poly Haven model once into the hidden SRC collection; returns its mesh objects."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(SM.MODELS, mid, f'{mid}_2k.gltf'))
    new = [o for o in bpy.data.objects if o not in before]
    for o in new:
        for c in list(o.users_collection):
            c.objects.unlink(o)
        SRC.objects.link(o)
    meshes = [o for o in new if o.type == 'MESH']
    for o in meshes:
        # bake parenting/transforms into the object so each variant stands alone
        mw = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = mw
    return meshes


def variant_collection(ob, name):
    """Move a variant so its trunk base sits at the origin and wrap it in an instanceable collection."""
    bb = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
    # trunk base: centroid of the lowest 2% of vertices, not the bbox (crowns are lopsided)
    me = ob.data
    co = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    mw = np.array(ob.matrix_world)
    w = co @ mw[:3, :3].T + mw[:3, 3]
    zmin = w[:, 2].min()
    low = w[w[:, 2] < zmin + max(0.15, (w[:, 2].max() - zmin) * 0.02)]
    base = Vector((low[:, 0].mean(), low[:, 1].mean(), zmin))
    ob.matrix_world = Matrix.Translation(-base) @ ob.matrix_world
    c = bpy.data.collections.new(name)
    SRC.children.link(c)
    for uc in list(ob.users_collection):
        uc.objects.unlink(ob)
    c.objects.link(ob)
    height = max(v.z for v in bb) - min(v.z for v in bb)
    return c, height


def snowify_model(objs, **kw):
    seen = set()
    for o in objs:
        for m in o.data.materials:
            if m and m.name not in seen and m.use_nodes:
                seen.add(m.name)
                name = m.name.lower()
                if 'twig' in name or 'branches' in name and 'dead' not in name:
                    # needle cards: snow on the upper faces of the sprays, generous
                    SM.snowify(m, threshold=0.25, softness=0.3, noise_scale=1.4, bias=0.05)
                elif 'bark' in name or 'trunk' in name or 'dead' in name:
                    SM.snowify(m, threshold=0.7, softness=0.12, noise_scale=6.0)
                else:
                    SM.snowify(m, **kw)
                m.blend_method = 'HASHED' if hasattr(m, 'blend_method') else None


def instance(c, name, loc, rot_z=0.0, scale=1.0, tilt=(0.0, 0.0), parent_coll=None):
    o = bpy.data.objects.new(name, None)
    o.instance_type = 'COLLECTION'
    o.instance_collection = c
    o.location = loc
    o.rotation_euler = Euler((tilt[0], tilt[1], rot_z))
    o.scale = (scale,) * 3
    (parent_coll or coll('HIGH')).objects.link(o)
    return o


# ---------------------------------------------------------------- composition
def make_spruce_variants():
    from lib.forest import VARIANTS
    cols = {}
    for key, (h, cr, sd, flag) in VARIANTS.items():
        c = bpy.data.collections.new('V_' + key)
        SRC.children.link(c)
        o = spruce.build(key, c, H=h, seed=sd, snow=1.0, lod=0, crown=cr, flag=flag)
        cols[key] = (c, h)
        print('  ', key, 'tris', len(o.data.polygons), flush=True)
    return cols


def plant_forest(variants, layout):
    """Dense ring of forest past the arena wall, clumps on the plain, the lone spruce on the hill."""
    trees = coll('TREES', coll('HIGH'))
    tall = [k for k in variants if k.startswith('spruce_')]
    young = [k for k in variants if k.startswith('young_')]
    placed = []

    def free(x, y, r):
        return all((x - px) ** 2 + (y - py) ** 2 > (r + pr) ** 2 for px, py, pr in placed)

    def plant(kind, x, y, s, rz=None, tilt=(0.0, 0.0), sink=0.08, reach=None):
        # Trees keep their authored heading: their light (impostors, vertex light) is baked against the
        # arena's fixed sun, so a turned tree would be lit from the wrong side. Variety comes from the
        # variants and their scale.
        c, h = variants[kind]
        z = height(x, y) - sink
        rz = 0.0
        instance(c, f'T_{kind}_{len(layout["trees"])}', (x, y, z), rz, s, tilt, trees)
        layout['trees'].append({'kind': kind, 'x': round(x, 3), 'y': round(z, 3), 'z': round(-y, 3),
                                'rot': round(rz, 4), 's': round(s, 3)})
        placed.append((x, y, (reach if reach is not None else h * 0.2) * s))

    # The lone spruce on the crown: the oldest tree here, flagged by the westerly. It is not rotated:
    # its stunted side must face into the wind.
    hx, hy = HILL_TREE['x'], -HILL_TREE['z']
    plant('hill_spruce', hx, hy, 1.0, rz=0.0, sink=0.1)
    # Forest ring: a dense band past the arena wall. Tall trees first, young ones filling the edge.
    n = tries = 0
    while n < 1500 and tries < 40000:
        tries += 1
        a = RNG.uniform(0, math.tau)
        r = RADIUS + 3 + (RNG.random() ** 0.75) * 110
        x, y = math.cos(a) * r, math.sin(a) * r
        kind = RNG.choice(tall)
        s = RNG.uniform(0.85, 1.15)
        if not free(x, y, variants[kind][1] * 0.16 * s):
            continue
        plant(kind, x, y, s)
        n += 1
    for _ in range(500):
        a = RNG.uniform(0, math.tau)
        r = RADIUS - 6 + RNG.random() * 14
        x, y = math.cos(a) * r, math.sin(a) * r
        if free(x, y, 0.6):
            plant(RNG.choice(young), x, y, RNG.uniform(0.8, 1.25), sink=0.15)
    # Clumps on the plain: never in the middle where a run starts, never on the hill.
    clumps = 0
    while clumps < 24:
        a = RNG.uniform(0, math.tau)
        r = 45 + math.sqrt(RNG.random()) * (RADIUS - 70)
        cx, cy = math.cos(a) * r, math.sin(a) * r
        if height(cx, cy) > 1.2:
            continue
        clumps += 1
        for k in range(RNG.randint(2, 6)):
            x, y = cx + RNG.gauss(0, 5), cy + RNG.gauss(0, 5)
            kind = RNG.choice(tall[:5])
            s = RNG.uniform(0.8, 1.1)
            if height(x, y) < 1.2 and free(x, y, variants[kind][1] * 0.16 * s):
                plant(kind, x, y, s)
        for k in range(RNG.randint(1, 5)):
            x, y = cx + RNG.gauss(0, 7), cy + RNG.gauss(0, 7)
            if height(x, y) < 1.2 and free(x, y, 0.5):
                plant(RNG.choice(young), x, y, RNG.uniform(0.7, 1.3), sink=0.2)
    return placed


def scatter_props(models, layout, placed):
    """Saplings at clump edges and along the forest, buried boulders, the crest outcrop, logs, stumps."""
    props = coll('PROPS', coll('HIGH'))

    def put(kind, x, y, s, rz=None, sink=0.0, tilt=(0.0, 0.0)):
        c = models[kind]
        z = height(x, y) - sink
        rz = RNG.uniform(0, math.tau) if rz is None else rz
        instance(c, f'P_{kind}_{len(layout["props"])}', (x, y, z), rz, s, tilt, props)
        layout['props'].append({'kind': kind, 'x': round(x, 3), 'y': round(z, 3), 'z': round(-y, 3),
                                'rot': round(rz, 4), 's': round(s, 3), 'tilt': [round(t, 4) for t in tilt]})

    # Crest outcrop: frost-shattered rock breaking through the windward shoulder of the hill.
    hx, hy = HILL['x'], -HILL['z']
    ang = -HILL['angle']  # ridge heading in Blender XY
    ux, uy = math.cos(ang), math.sin(ang)
    vx, vy = -uy, ux
    # A granite tor on the crest: a few big blocks shouldering out of the windward slope.
    for k, (along, across, s, kind) in enumerate([(-8, -5, 3.6, 'namaqualand_boulder_04'),
                                                    (-4, -7, 2.8, 'namaqualand_boulder_03'),
                                                    (1, -6.5, 3.2, 'namaqualand_boulder_04'),
                                                    (6, -4, 2.2, 'namaqualand_boulder_02'),
                                                    (-12, -2, 1.8, 'boulder_01'),
                                                    (3, -10, 1.6, 'namaqualand_boulder_06'),
                                                    (-6, -11, 1.4, 'boulder_01'),
                                                    (10, -8, 1.5, 'namaqualand_boulder_05')]):
        x = hx + ux * along + vx * across
        y = hy + uy * along + vy * across
        put(kind, x, y, s, sink=0.45 * s, tilt=(RNG.uniform(-0.15, 0.15), RNG.uniform(-0.15, 0.15)))
    # Half-buried boulders across the plain.
    for _ in range(34):
        a = RNG.uniform(0, math.tau)
        r = 30 + math.sqrt(RNG.random()) * (RADIUS - 30)
        x, y = math.cos(a) * r, math.sin(a) * r
        kind = RNG.choice(['boulder_01', 'namaqualand_boulder_02', 'namaqualand_boulder_04', 'namaqualand_boulder_05'])
        s = RNG.uniform(0.6, 1.4)
        put(kind, x, y, s, sink=0.35 * s, tilt=(RNG.uniform(-0.3, 0.3), RNG.uniform(-0.3, 0.3)))
    # Windfall logs and stumps near the clumps.
    for _ in range(26):
        px, py, pr = RNG.choice(placed[1:])
        a = RNG.uniform(0, math.tau)
        x, y = px + math.cos(a) * (pr + 2), py + math.sin(a) * (pr + 2)
        if math.hypot(x, y) < 25:
            continue
        if RNG.random() < 0.5:
            put('dead_tree_trunk', x, y, RNG.uniform(1.4, 2.4), sink=0.12)
        else:
            put(RNG.choice(['tree_stump_01', 'tree_stump_02']), x, y, RNG.uniform(0.8, 1.2), sink=0.15)


def main():
    global SRC
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    SRC = coll('SRC')
    for c in (coll('HIGH'),):
        pass
    print('ground', flush=True)
    build_ground()

    print('spruce', flush=True)
    variants = make_spruce_variants()
    print('models', flush=True)
    models = {}
    for mid in ('dead_tree_trunk', 'tree_stump_01', 'tree_stump_02', 'boulder_01', 'namaqualand_boulder_02',
                'namaqualand_boulder_03', 'namaqualand_boulder_04', 'namaqualand_boulder_05', 'namaqualand_boulder_06'):
        objs = import_model(mid)
        is_rock = 'boulder' in mid
        for o in objs:
            for m in o.data.materials:
                if is_rock and m and not m.get('regraded'):
                    # Desert sandstone and mossy granite -> cold alpine granite.
                    rocks.regrade(m, sat=0.18 if mid.startswith('namaqualand') else 0.5, val=0.78)
                    m['regraded'] = True
        snowify_model(objs, threshold=0.75, softness=0.1, noise_scale=2.5)
        for o in objs:
            key = mid if is_rock else o.name.replace('_LOD0', '')
            c, _ = variant_collection(o, 'V_' + key)
            models[key] = c
            cap = rocks.snow_cap(o, c, seed=len(models), depth=0.16 if is_rock else 0.06,
                                 min_nz=0.62 if is_rock else 0.7, spacing=0.07 if is_rock else 0.05)
    SRC.hide_render = True
    SRC.hide_viewport = True

    layout = {'sun': {'azim_deg': SUN_AZIM, 'elev_deg': SUN_ELEV}, 'trees': [], 'props': [],
              'variants': {k: {'height': h} for k, (c, h) in variants.items()}}
    print('forest', flush=True)
    placed = plant_forest(variants, layout)
    print('props', flush=True)
    scatter_props(models, layout, placed)

    # Light: the photographed sunset sky with its sun painted out, and the sun as a lamp measured from it.
    from lib import sky
    meta = sky.world('qwantani_sunset_puresky', SUN_AZIM, strength=1.0)
    sky.sun_lamp(meta, SUN_AZIM, SUN_ELEV)
    layout['sky'] = meta

    # Cameras at eye height (1.65 m above the snow).
    def cam(name, x, y, tx, ty, lens=18, up=1.65, tz=None):
        cd = bpy.data.cameras.new(name)
        cd.lens = lens
        cd.clip_end = 3000
        o = bpy.data.objects.new(name, cd)
        o.location = (x, y, height(x, y) + up)
        tgt = Vector((tx, ty, (height(tx, ty) + up) if tz is None else tz))
        o.rotation_euler = (tgt - o.location).to_track_quat('-Z', 'Y').to_euler()
        sc.collection.objects.link(o)
        return o

    hx, hy = HILL_TREE['x'], -HILL_TREE['z']
    cam('CAM_center', 0, 0, hx, hy, tz=height(hx, hy) + 5)
    cam('CAM_crest', hx + 7, hy + 7, 0, -40, lens=16)
    cam('CAM_hillside', 40, 30, hx, hy, lens=24, tz=height(hx, hy) + 6)
    cam('CAM_edge', -200, 120, -260, 170, lens=20, tz=height(-200, 120) + 4)
    cam('CAM_tree', hx - 6, hy - 14, hx, hy, lens=16, tz=height(hx, hy) + 7)
    sc.camera = bpy.data.objects['CAM_center']

    sc.render.engine = 'CYCLES'
    sc.view_settings.view_transform = 'AgX'
    sc.view_settings.look = 'AgX - Base Contrast' if 'AgX - Base Contrast' in [l for l in []] else 'None'
    json.dump(layout, open(os.path.join(WORK, 'survivors_layout.json'), 'w'), indent=1)
    out = os.path.join(WORK, 'survivors.blend')
    bpy.ops.wm.save_as_mainfile(filepath=out, compress=False)
    print('saved', out, len(layout['trees']), 'trees', len(layout['props']), 'props', flush=True)


main()
