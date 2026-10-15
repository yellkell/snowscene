"""Scene-building helpers shared by the region builds (survivors, tutorial).

Coordinates: game (x, y, z) = Blender (x, -z, y) i.e. Blender y = -game z, Blender z = game y.
"""
import bpy, os, json, math, random
import numpy as np
from mathutils import Vector, Matrix, Euler
from . import snowmats as SM, spruce, rocks
from .forest import VARIANTS

ART = SM.ART
WORK = os.path.join(ART, 'work')


class Heights:
    """Bilinear lookup into a heightfield exported by art/scripts/export_heights.mjs."""

    def __init__(self, name):
        self.meta = json.load(open(os.path.join(WORK, f'heights_{name}.json')))
        m = self.meta
        self.d = np.fromfile(os.path.join(WORK, f'heights_{name}.bin'), dtype=np.float32).reshape(m['nz'], m['nx'])

    def __call__(self, x, y):
        """Ground height at Blender (x, y) = game (x, -y)."""
        m = self.meta
        gx = (x - m['x0']) / m['step']
        gz = (-y - m['z0']) / m['step']
        i = min(max(int(gx), 0), m['nx'] - 2)
        j = min(max(int(gz), 0), m['nz'] - 2)
        fx, fz = gx - i, gz - j
        a = self.d[j, i] * (1 - fx) + self.d[j, i + 1] * fx
        b = self.d[j + 1, i] * (1 - fx) + self.d[j + 1, i + 1] * fx
        return float(a * (1 - fz) + b * fz)

    def slope(self, x, y, d=1.0):
        return math.hypot(self(x + d, y) - self(x - d, y), self(x, y + d) - self(x, y - d)) / (2 * d)

    def grid_mesh(self, name, step=1.0, bounds=None, coll=None):
        """Quad grid over the heightfield (or a sub-rectangle in game x/z), metric WorldUV."""
        m = self.meta
        stride = max(1, int(round(step / m['step'])))
        d = self.d
        xs = m['x0'] + np.arange(m['nx']) * m['step']
        zs = m['z0'] + np.arange(m['nz']) * m['step']
        ix = np.arange(0, m['nx'], stride)
        iz = np.arange(0, m['nz'], stride)
        if bounds:
            x0, x1, z0, z1 = bounds
            ix = ix[(xs[ix] >= x0) & (xs[ix] <= x1)]
            iz = iz[(zs[iz] >= z0) & (zs[iz] <= z1)]
        sub = d[np.ix_(iz, ix)]
        nz, nx = sub.shape
        X, Zg = np.meshgrid(xs[ix], zs[iz])
        verts = np.stack([X, -Zg, sub], axis=-1).reshape(-1, 3)
        I, J = np.meshgrid(np.arange(nx - 1), np.arange(nz - 1))
        a = (J * nx + I).ravel()
        quads = np.stack([a, a + 1, a + 1 + nx, a + nx], axis=1)
        me = bpy.data.meshes.new(name)
        me.vertices.add(len(verts))
        me.vertices.foreach_set('co', verts.astype(np.float32).ravel())
        me.loops.add(quads.size)
        me.loops.foreach_set('vertex_index', quads.astype(np.int32).ravel())
        me.polygons.add(len(quads))
        me.polygons.foreach_set('loop_start', (np.arange(len(quads)) * 4).astype(np.int32))
        me.polygons.foreach_set('loop_total', np.full(len(quads), 4, np.int32))
        me.update(calc_edges=True)
        me.flip_normals()
        uv = me.uv_layers.new(name='WorldUV')
        lv = np.empty(len(me.loops), np.int32)
        me.loops.foreach_get('vertex_index', lv)
        uv.data.foreach_set('uv', verts[lv, :2].astype(np.float32).ravel())
        me.polygons.foreach_set('use_smooth', np.ones(len(quads), bool))
        ob = bpy.data.objects.new(name, me)
        (coll or bpy.context.scene.collection).objects.link(ob)
        return ob


def coll(name, parent=None):
    c = bpy.data.collections.get(name) or bpy.data.collections.new(name)
    par = parent or bpy.context.scene.collection
    if c.name not in [x.name for x in par.children]:
        par.children.link(c)
    return c


def src_coll():
    c = coll('SRC')
    c.hide_render = True
    c.hide_viewport = True
    return c


def import_model(mid):
    """Import a Poly Haven model into the hidden SRC collection; returns its mesh objects (unparented)."""
    src = src_coll()
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(SM.MODELS, mid, f'{mid}_2k.gltf'))
    new = [o for o in bpy.data.objects if o not in before]
    for o in new:
        for c in list(o.users_collection):
            c.objects.unlink(o)
        src.objects.link(o)
    meshes = [o for o in new if o.type == 'MESH']
    for o in meshes:
        mw = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = mw
    return meshes


def variant_collection(ob, name):
    """Move a variant so its base sits at the origin and wrap it in an instanceable collection."""
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
    src_coll().children.link(c)
    for uc in list(ob.users_collection):
        uc.objects.unlink(ob)
    c.objects.link(ob)
    return c


def instance(c, name, loc, rot_z=0.0, scale=1.0, tilt=(0.0, 0.0), parent_coll=None):
    o = bpy.data.objects.new(name, None)
    o.instance_type = 'COLLECTION'
    o.instance_collection = c
    o.location = loc
    o.rotation_euler = Euler((tilt[0], tilt[1], rot_z))
    o.scale = (scale,) * 3 if isinstance(scale, (int, float)) else scale
    (parent_coll or coll('HIGH')).objects.link(o)
    return o


def spruce_variants(keys=None):
    """Build the spruce variants (lib/forest.py) into SRC collections: key -> (collection, height)."""
    out = {}
    for key, (h, cr, sd, flag) in VARIANTS.items():
        if keys and key not in keys:
            continue
        c = bpy.data.collections.new('V_' + key)
        src_coll().children.link(c)
        spruce.build(key, c, H=h, seed=sd, snow=1.0, lod=0, crown=cr, flag=flag)
        out[key] = (c, h)
    return out


ROCK_MODELS = ('boulder_01', 'namaqualand_boulder_02', 'namaqualand_boulder_03', 'namaqualand_boulder_04',
               'namaqualand_boulder_05', 'namaqualand_boulder_06')
WOOD_MODELS = ('dead_tree_trunk', 'tree_stump_01', 'tree_stump_02')


def scanned_props(ids=ROCK_MODELS + WOOD_MODELS):
    """Rocks re-graded to cold granite, windfall wood; each with a modelled snow cap. id -> collection."""
    models = {}
    for mid in ids:
        objs = import_model(mid)
        is_rock = 'boulder' in mid
        for o in objs:
            for m in o.data.materials:
                if is_rock and m and not m.get('regraded'):
                    rocks.regrade(m, sat=0.18 if mid.startswith('namaqualand') else 0.5, val=0.78)
                    m['regraded'] = True
        snowify(objs, threshold=0.75, softness=0.1, noise_scale=2.5)
        for o in objs:
            key = mid if is_rock else o.name.replace('_LOD0', '')
            c = variant_collection(o, 'V_' + key)
            models[key] = c
            rocks.snow_cap(o, c, seed=len(models), depth=0.16 if is_rock else 0.06,
                           min_nz=0.86 if is_rock else 0.85, spacing=0.06 if is_rock else 0.045)
    return models


def snowify(objs, **kw):
    seen = set()
    for o in objs:
        for m in o.data.materials:
            if m and m.name not in seen and m.node_tree:
                seen.add(m.name)
                SM.snowify(m, **kw)


def camera(name, loc, target, lens=18):
    sc = bpy.context.scene
    cd = bpy.data.cameras.new(name)
    cd.lens = lens
    cd.clip_end = 6000
    o = bpy.data.objects.new(name, cd)
    o.location = loc
    o.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    sc.collection.objects.link(o)
    return o
