"""Bake the ice mine for Quest 3 (art/work/cave.blend -> art/work/bake_cave/; cave_encode.py -> public/cave/).

    blender -b art/work/cave.blend --python art/scripts/cave_bake.py -- [--samples 256] [--only shell,works,...]

Light is baked in three re-lightable channels (art/DESIGN.md §2, the cave's version):
  day      the chimney's daylight: the sky disc over the throat, the soft source above it, and the glacier
           glowing with it where it is thin
  lantern  every oil lantern (point light + its lit globe)
  beacon   the brazier at the top, burning (it is dark until you light it)

Stages:
  shell     the glacier cavity + icicles: a decimated LOW baked from the HIGH (selected to active):
            albedo (+ the glacier's glow in alpha), day / lantern / beacon irradiance
  works     every fixed timber, station, rack, the brazier and the lanterns: albedo (+ emission mask in
            alpha), the three channels; the wood's plank UV goes along as a second UV set for runtime detail
  machines  the 15 machines, the mill wheel and the deck tile, each in its own frame, sharing one atlas:
            albedo + ambient occlusion (they are lit at runtime from the light volume)
  rope      a three-strand tarred hemp rope baked onto a unit cylinder: albedo + AO, normal
  volume    the light volume: a grid of tiny probe cubes through the space the machines sweep, each face's
            irradiance per channel (an ambient cube per probe)
"""
import bpy, bmesh, sys, os, json, math, time
import numpy as np
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from lib import bakekit as BK, regions as RGN, cavekit as K  # noqa: E402

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
opt = lambda n, d: argv[argv.index(n) + 1] if n in argv else d
SAMPLES = int(opt('--samples', 256))
ALL = 'shell,works,debris,machines,deck,rope,volume'
ONLY = set(opt('--only', ALL).split(','))
SCALE = float(opt('--res', 1.0))
ART = os.path.dirname(HERE)
OUT = os.path.join(ART, 'work', 'bake_cave')
os.makedirs(OUT, exist_ok=True)
MAN_P = os.path.join(OUT, 'bake.json')
MAN = json.load(open(MAN_P)) if os.path.exists(MAN_P) else {}
L = K.layout()
sc = bpy.context.scene
BK.gpu(sc)
sc.cycles.max_bounces = 8
sc.cycles.diffuse_bounces = 6
sc.cycles.sample_clamp_indirect = 4.0
O = bpy.data.objects
CH = ('day', 'lantern', 'beacon')


def res(n):
    return max(64, int(n * SCALE))


def save(name, arr):
    np.save(os.path.join(OUT, name + '.npy'), arr.astype(np.float32))


def coll_objs(name):
    c = bpy.data.collections.get(name)
    return list(c.all_objects) if c else []


# ---------------------------------------------------------------- light channels
def _emitters():
    """Every emissive input in the scene, by channel (by material name; the glacier's glow switch)."""
    out = {ch: [] for ch in CH}
    for m in bpy.data.materials:
        if not m.node_tree:
            continue
        for n in m.node_tree.nodes:
            if n.type == 'VALUE' and n.name.startswith('GLOW_SWITCH'):
                out['day'].append((n.outputs[0], 1.0))
            elif n.type == 'EMISSION' and not n.inputs['Strength'].is_linked:
                v = n.inputs['Strength'].default_value or n.get('on', 0.0)
                n['on'] = v
                if m.name == 'cave_sky':
                    out['day'].append((n.inputs['Strength'], v))
                elif 'beacon' in m.name or 'coals' in m.name:
                    out['beacon'].append((n.inputs['Strength'], v))
                else:
                    out['lantern'].append((n.inputs['Strength'], v))
    return out


EMIT = _emitters()


def channel(on):
    """Light only the channels in `on` (a set of names, or 'all')."""
    for ch, items in EMIT.items():
        for sock, v in items:
            sock.default_value = v if (on == 'all' or ch in on) else 0.0
    for o in O:
        if o.type == 'LIGHT' and o.get('channel') in CH:
            o.data.energy = o['power'] if (on == 'all' or o['channel'] in on) else 0.0
            o.hide_render = False


def hide(objs, flag=True):
    for o in objs:
        o.hide_render = flag


def moving():
    """Everything that moves (machines, their decks, the ropes): never in a static bake."""
    return [o for o in coll_objs('MACHINES') + coll_objs('ROPES')]


# ---------------------------------------------------------------- helpers
def piece_budget(o, tris):
    """The scanned lantern is far too fine for a deck post: a few hundred triangles is plenty."""
    if 'Lantern' in o.name or 'lantern' in o.name:
        return 450 if 'glass' not in o.name.lower() else 160
    return tris


def realize_join(name, objs, budget=None):
    """Copies of `objs` (collection instances realised) joined into one object, materials kept."""
    stage = RGN.coll('BAKE_' + name)
    pieces = RGN.realize(objs, stage)
    lows = []
    for h in pieces:
        me = h.data.copy()
        lo = bpy.data.objects.new('L_' + h.name, me)
        lo.matrix_world = h.matrix_world
        stage.objects.link(lo)
        t = sum(len(p.vertices) - 2 for p in me.polygons)
        cap = piece_budget(h, t)
        if cap < t:
            m = lo.modifiers.new('dec', 'DECIMATE')
            m.ratio = cap / t
            BK.select_only(lo)
            bpy.ops.object.modifier_apply(modifier='dec')
        lows.append(lo)
    for h in pieces:
        bpy.data.objects.remove(h)
    BK.select_only(lows[0], lows[1:])
    bpy.ops.object.join()
    low = bpy.context.view_layer.objects.active
    low.name = name.upper() + '_LOW'
    if budget:
        tris = sum(len(p.vertices) - 2 for p in low.data.polygons)
        if tris > budget:
            m = low.modifiers.new('dec', 'DECIMATE')
            m.ratio = budget / tris
            BK.select_only(low)
            bpy.ops.object.modifier_apply(modifier='dec')
    return low


def small_mask(me):
    sm = np.zeros(len(me.polygons), np.float32)
    if 'small' in me.attributes:
        me.attributes['small'].data.foreach_get('value', sm)
    return sm > 0.5


def atlas_uv(objs, margin=0.002, angle=60):
    """One packed atlas (BakeUV) over `objs`: smart-projected and packed, except the small fittings
    (bolts, nuts, nail heads), which take no room of their own but borrow the UV of the surface they sit
    on (see borrow_uv)."""
    objs = list(objs) if isinstance(objs, (list, tuple)) else [objs]
    for o in objs:
        me = o.data
        drop_uvs(me, ('UVMap', 'WoodUV'))
        me.uv_layers.active = me.uv_layers.new(name='BakeUV')
        me.polygons.foreach_set('select', ~small_mask(me))
    BK.select_only(objs[0], objs[1:])
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.hide(unselected=True)
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(angle), island_margin=margin, area_weight=0.0)
    bpy.ops.uv.select_all(action='SELECT')
    bpy.ops.uv.pack_islands(rotate=True, shape_method='AABB', margin_method='FRACTION', margin=margin)
    bpy.ops.mesh.reveal(select=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    for o in objs:
        borrow_uv(o)
        if 'UVMap' in o.data.uv_layers:
            o.data.uv_layers['UVMap'].active_render = True


def borrow_uv(o):
    from mathutils.geometry import barycentric_transform
    me = o.data
    sm = small_mask(me)
    if not sm.any():
        return
    me.calc_loop_triangles()
    uv = me.uv_layers['BakeUV'].data
    verts = [v.co.copy() for v in me.vertices]
    tris, tloops = [], []
    for t in me.loop_triangles:
        if not sm[t.polygon_index]:
            tris.append(tuple(t.vertices))
            tloops.append(tuple(t.loops))
    if not tris:
        return
    tree = BVHTree.FromPolygons(verts, tris)
    for p in me.polygons:
        if not sm[p.index]:
            continue
        loc, nrm, ti, d = tree.find_nearest(p.center)
        if ti is None:
            continue
        a, b, c = (verts[i] for i in tris[ti])
        la, lb, lc = tloops[ti]
        ua, ub, uc = (Vector((uv[l].uv[0], uv[l].uv[1], 0)) for l in (la, lb, lc))
        w = barycentric_transform(loc, a, b, c, ua, ub, uc)
        for li in p.loop_indices:
            uv[li].uv = (w.x, w.y)


def drop_uvs(me, keep):
    for nm in [uv.name for uv in me.uv_layers]:
        if nm not in keep and nm in me.uv_layers:
            me.uv_layers.remove(me.uv_layers[nm])


def export(low, path, keep_wood=False, local=None):
    me = low.data
    drop_uvs(me, ('BakeUV', 'WoodUV') if keep_wood else ('BakeUV',))
    # BakeUV must be TEXCOORD_0
    if keep_wood and 'WoodUV' in me.uv_layers and me.uv_layers[0].name != 'BakeUV':
        wuv = np.empty(len(me.loops) * 2, np.float32)
        me.uv_layers['WoodUV'].data.foreach_get('uv', wuv)
        me.uv_layers.remove(me.uv_layers['WoodUV'])
        n = me.uv_layers.new(name='WoodUV')
        n.data.foreach_set('uv', wuv)
    low.data.materials.clear()
    if local is not None:
        low.matrix_world = local.inverted() @ low.matrix_world
    RGN.export_glb([low], path)


def lit_bakes(name, low, light_res, high=(), extrusion=0.08, maxdist=0.2, keep=True):
    for ch in CH:
        channel({ch})
        img = bpy.data.images.new(f'{name}_{ch}', light_res, light_res, float_buffer=True)
        t = time.time()
        BK.bake(low, img, 'DIFFUSE', {'DIRECT', 'INDIRECT'}, SAMPLES, margin=6, high=high, extrusion=extrusion,
                maxdist=maxdist, keep_materials=keep)
        save(f'{name}_{ch}', BK.lum(BK.denoise(img, OUT)))
        BK.log(f'  {name} {ch} {time.time() - t:.0f}s')
    channel('all')


def receiver(low):
    """A plain receiving material for selected-to-active bakes (the HIGH's materials do the shading)."""
    m = bpy.data.materials.get('BAKE_LOW') or bpy.data.materials.new('BAKE_LOW')
    m.use_nodes = True
    low.data.materials.clear()
    low.data.materials.append(m)


# ---------------------------------------------------------------- stages
def stage_shell():
    """The wall: the build's low grid (exactly unrolled UVs, from just below the waterline up), baked from
    the HIGH wall (icicles, rocks and drips are the debris region's)."""
    hi = [O['CAVE_SHELL']]
    src = O['CAVE_SHELL_LOW']
    low = bpy.data.objects.new('SHELL_LOW', src.data.copy())
    low.matrix_world = src.matrix_world
    RGN.coll('BAKE_shell').objects.link(low)
    drop_uvs(low.data, ('ShellUV',))
    low.data.uv_layers['ShellUV'].name = 'BakeUV'
    tris = sum(len(p.vertices) - 2 for p in low.data.polygons)
    BK.log('shell low tris', tris)
    receiver(low)
    # the LOW sits on the HIGH: hide it from the light while the HIGH does the shading
    low.visible_shadow = low.visible_diffuse = low.visible_glossy = low.visible_transmission = False
    hide(moving())
    ar, lr = res(2048), res(2048)
    alb = bpy.data.images.new('shell_alb', ar, ar, float_buffer=True)
    channel(set())
    BK.bake(low, alb, 'DIFFUSE', {'COLOR'}, 4, margin=6, high=hi, extrusion=0.1, maxdist=0.25)
    save('shell_albedo', BK.pixels(alb)[..., :3])
    channel({'day'})
    em = bpy.data.images.new('shell_emit', ar, ar, float_buffer=True)
    BK.bake(low, em, 'EMIT', None, 4, margin=6, high=hi, extrusion=0.1, maxdist=0.25)
    save('shell_emit', BK.pixels(em)[..., :3])
    lit_bakes('shell', low, lr, high=hi, keep=False, extrusion=0.1, maxdist=0.25)
    hide(moving(), False)
    export(low, os.path.join(OUT, 'shell.glb'))
    bpy.data.objects.remove(low)
    return {'mesh': 'shell.glb', 'tris': tris, 'albedo_res': ar, 'light_res': lr}


def works_objects():
    out = []
    for o in coll_objs('WORKS'):
        if o.name.startswith('DECK_'):
            continue
        if o.type == 'MESH' or (o.type == 'EMPTY' and o.instance_type == 'COLLECTION'):
            out.append(o)
    return out


def stage_works():
    objs = works_objects()
    low = realize_join('works', objs)
    tris = sum(len(p.vertices) - 2 for p in low.data.polygons)
    BK.log('works tris', tris)
    atlas_uv(low, margin=0.0005, angle=60)
    hidden = [o for o in objs if not o.hide_render]
    hide(hidden)
    hide(moving())
    ar, lr = res(4096), res(2048)
    alb = bpy.data.images.new('works_alb', ar, ar, float_buffer=True)
    channel(set())
    BK.bake(low, alb, 'DIFFUSE', {'COLOR'}, 4, margin=8, keep_materials=True)
    save('works_albedo', BK.pixels(alb)[..., :3])
    channel({'lantern'})
    em = bpy.data.images.new('works_emit', lr, lr, float_buffer=True)
    BK.bake(low, em, 'EMIT', None, 4, margin=8, keep_materials=True)
    save('works_emit', BK.pixels(em)[..., :3])
    lit_bakes('works', low, lr, keep=True)
    hide(hidden, False)
    hide(moving(), False)
    export(low, os.path.join(OUT, 'works.glb'), keep_wood=True)
    bpy.data.objects.remove(low)
    return {'mesh': 'works.glb', 'tris': tris, 'albedo_res': ar, 'light_res': lr}


def stage_debris():
    """Icicles, the rocks frozen into the ice and lying at the waterline, and the drips under the beams:
    each piece unwrapped on its own (the scanned rocks keep their scan's UVs), every island scaled to one
    texel density and packed together (as lib/regions.atlas_region), then the three light channels."""
    from mathutils import Matrix as _M
    objs = coll_objs('DEBRIS')
    stage = RGN.coll('BAKE_debris')
    pieces = RGN.realize([o for o in objs if o.type == 'MESH' or (o.type == 'EMPTY' and o.instance_type == 'COLLECTION')], stage)
    lows = []
    for h in pieces:
        me = h.data.copy()
        lo = bpy.data.objects.new('L_' + h.name, me)
        lo.matrix_world = h.matrix_world
        stage.objects.link(lo)
        t = sum(len(p.vertices) - 2 for p in me.polygons)
        rock = 'boulder' in h.name
        if rock:
            size = max(lo.dimensions)
            # the waterline boulders are seen from a metre or two: keep their silhouettes round
            cap = int(min(1100, max(140, 180 + 950 * size)))
            if cap < t:
                m = lo.modifiers.new('weld', 'WELD')
                m.merge_threshold = 0.0005
                m = lo.modifiers.new('dec', 'DECIMATE')
                m.ratio = cap / t
                BK.select_only(lo)
                bpy.ops.object.modifier_apply(modifier='weld')
                bpy.ops.object.modifier_apply(modifier='dec')
        me = lo.data
        scan = rock and len(me.uv_layers) > 0
        keep = me.uv_layers[0].name if scan else None
        drop_uvs(me, (keep,) if keep else ())
        bu = me.uv_layers.new(name='BakeUV')
        if scan:
            a = np.zeros(len(me.loops) * 2, np.float32)
            me.uv_layers[keep].data.foreach_get('uv', a)
            bu.data.foreach_set('uv', a)
            me.uv_layers.remove(me.uv_layers[keep])
        else:
            me.uv_layers.active = bu
            BK.select_only(lo)
            bpy.ops.object.mode_set(mode='EDIT')
            bpy.ops.mesh.select_all(action='SELECT')
            bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.0, area_weight=0.0)
            bpy.ops.object.mode_set(mode='OBJECT')
        lows.append(lo)
    for h in pieces:
        bpy.data.objects.remove(h)
    BK.select_only(lows[0], lows[1:])
    bpy.ops.object.join()
    low = bpy.context.view_layer.objects.active
    low.name = 'DEBRIS_LOW'
    me = low.data
    me.uv_layers.active = me.uv_layers['BakeUV']
    lr = res(2048)
    BK.select_only(low)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.select_all(action='SELECT')
    bpy.ops.uv.average_islands_scale()
    bpy.ops.uv.pack_islands(rotate=True, shape_method='AABB', margin_method='FRACTION', margin=3.0 / lr)
    bpy.ops.object.mode_set(mode='OBJECT')
    tris = sum(len(p.vertices) - 2 for p in me.polygons)
    BK.log('debris tris', tris)
    hidden = [o for o in objs if not o.hide_render]
    hide(hidden)
    hide(moving())
    ar = res(4096)
    alb = bpy.data.images.new('debris_alb', ar, ar, float_buffer=True)
    channel(set())
    BK.bake(low, alb, 'DIFFUSE', {'COLOR'}, 4, margin=8, keep_materials=True)
    save('debris_albedo', BK.pixels(alb)[..., :3])
    lit_bakes('debris', low, lr, keep=True)
    hide(hidden, False)
    hide(moving(), False)
    export(low, os.path.join(OUT, 'debris.glb'))
    bpy.data.objects.remove(low)
    return {'mesh': 'debris.glb', 'tris': tris, 'albedo_res': ar, 'light_res': lr}


def machine_objects():
    return [o for o in coll_objs('MACHINES') if o.type == 'MESH' and not o.name.startswith('DECK_')]


def stage_deck():
    """The deck tile (seen a step away the whole climb) gets an atlas of its own."""
    return stage_machines([O['DECK_TILE']], 'deck', 1024)


def stage_machines(src=None, name='machines', size=2048):
    """One atlas for every machine (in its own frame) and the mill wheel: albedo + AO."""
    src = src or machine_objects()
    stage = RGN.coll('BAKE_' + name)
    copies = []
    for i, o in enumerate(src):
        me = o.data.copy()
        c = bpy.data.objects.new('M_' + o.name, me)
        stage.objects.link(c)
        # each alone, far from everything (AO is its own); the wheel is big
        c.matrix_world = Matrix.Translation((i * 9.0, 400.0, -200.0)) @ Matrix.Rotation(0, 4, 'Z')
        c['src'] = o.name
        copies.append(c)
    atlas_uv(copies, margin=0.001, angle=60)
    ar = res(size)
    alb = bpy.data.images.new(name + '_alb', ar, ar, float_buffer=True)
    ao = bpy.data.images.new(name + '_ao', ar, ar, float_buffer=True)
    channel(set())
    for c in copies:
        BK.target_on_materials(c, alb)
    BK.select_only(copies[0], copies[1:])
    sc.cycles.samples = 4
    bpy.ops.object.bake(type='DIFFUSE', pass_filter={'COLOR'}, margin=6, use_clear=True, uv_layer='BakeUV', target='IMAGE_TEXTURES')
    save(name + '_albedo', BK.pixels(alb)[..., :3])
    for c in copies:
        BK.target_on_materials(c, ao)
    sc.cycles.samples = 128
    sc.world.light_settings.distance = 0.6
    bpy.ops.object.bake(type='AO', margin=6, use_clear=True, uv_layer='BakeUV', target='IMAGE_TEXTURES')
    save(name + '_ao', BK.lum(BK.pixels(ao)))
    channel('all')
    info = {}
    for c in copies:
        tris = sum(len(p.vertices) - 2 for p in c.data.polygons)
        name = c['src']
        export(c, os.path.join(OUT, f'm_{name}.glb'), keep_wood=True, local=c.matrix_world.copy())
        info[name] = {'mesh': f'm_{name}.glb', 'tris': tris}
        bpy.data.objects.remove(c)
    return {'albedo_res': ar, 'objects': info}


def stage_rope():
    """Tarred hemp: three strands laid up right-handed round a core, baked onto a cylinder whose UV goes
    once round (u) and along one lay (v): albedo, AO and a tangent-space normal."""
    from lib import cavemats as CM
    stage = RGN.coll('BAKE_rope')
    R, lay, n = 0.016, 0.1, 3
    hb = K.CB('ROPE_HIGH', stage)
    M = CM.rope('cave_rope_hi', tar=1.0)
    for k in range(n):
        pts = []
        for i in range(161):
            t = i / 160 * 3 - 1           # three lays, centred on the baked one
            a = 2 * math.pi * (t + k / n)
            pts.append(Vector((math.cos(a) * R * 0.56, math.sin(a) * R * 0.56, t * lay)))
        K.tube(hb, pts, R * 0.47, M, sides=12)
    K.cylinder(hb, Vector((0, 0, -lay * 1.5)), Vector((0, 0, lay * 1.5)), R * 0.3, M, sides=8)
    hi = hb.finish(merge=False)
    lo_b = K.CB('ROPE_LOW', stage)
    K.cylinder(lo_b, Vector((0, 0, 0)), Vector((0, 0, lay)), R * 1.08, M, sides=24, caps=False)
    lo = lo_b.finish(merge=False)
    me = lo.data
    # UV: u round (0..1), v along (0..1 over one lay)
    uv = me.uv_layers['UVMap']
    for poly in me.polygons:
        for li in poly.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            u = (math.atan2(co.y, co.x) / (2 * math.pi)) % 1.0
            uv.data[li].uv = (u, co.z / lay)
    # fix the seam: faces straddling u=0
    for poly in me.polygons:
        us = [uv.data[li].uv[0] for li in poly.loop_indices]
        if max(us) - min(us) > 0.5:
            for li in poly.loop_indices:
                if uv.data[li].uv[0] < 0.5:
                    uv.data[li].uv = (uv.data[li].uv[0] + 1.0, uv.data[li].uv[1])
    me.uv_layers.new(name='BakeUV').data.foreach_set('uv', np.array([d.uv[:] for d in uv.data], np.float32).ravel())
    hide([o for o in O if o not in (hi, lo)])
    out = {}
    for kind, typ, passes in (('albedo', 'DIFFUSE', {'COLOR'}), ('normal', 'NORMAL', None), ('ao', 'AO', None)):
        img = bpy.data.images.new(f'rope_{kind}', 128, 512, float_buffer=True)
        BK.bake(lo, img, typ, passes, 64 if kind == 'ao' else 4, margin=4, high=[hi], extrusion=0.03, maxdist=0.06)
        px = BK.pixels(img)
        save(f'rope_{kind}', px[..., :3] if kind != 'ao' else BK.lum(px))
    hide([o for o in O if o not in (hi, lo)], False)
    bpy.data.objects.remove(hi)
    bpy.data.objects.remove(lo)
    return {'lay': lay, 'radius': R}


def volume_grid():
    """The space the machines sweep (and their ropes reach), plus a margin, on a 0.5 m grid."""
    lo = np.array([1e9] * 3)
    hi = np.array([-1e9] * 3)
    for p in L['platforms']:
        lo = np.minimum(lo, p['sweptMin'])
        hi = np.maximum(hi, p['sweptMax'])
    lo -= 0.75
    hi += 0.75
    step = 0.5
    n = np.ceil((hi - lo) / step).astype(int) + 1
    return lo, step, n


def stage_volume():
    lo, step, n = volume_grid()
    nx, ny, nz = (int(v) for v in n)
    count = nx * ny * nz
    BK.log('volume', nx, ny, nz, count, 'probes')
    # probe cubes, one mesh; face f of probe i gets texels [2c, 2c+2) of a 2x2 cell
    faces_n = count * 6
    cols = 1024
    rows = int(math.ceil(faces_n / cols))
    W, H = cols * 2, rows * 2
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new('BakeUV')
    s = 0.03
    dirs = [Vector((1, 0, 0)), Vector((-1, 0, 0)), Vector((0, 1, 0)), Vector((0, -1, 0)), Vector((0, 0, 1)), Vector((0, 0, -1))]
    # game axes for the six faces: +x, -x, +y(up), -y(down), +z, -z  ->  Blender (x, -z, y)
    gdirs = [K.gvec(1, 0, 0), K.gvec(-1, 0, 0), K.gvec(0, 1, 0), K.gvec(0, -1, 0), K.gvec(0, 0, 1), K.gvec(0, 0, -1)]
    f = 0
    centres = []
    for k in range(nz):
        for j in range(ny):
            for i in range(nx):
                g = lo + np.array([i, j, k]) * step
                c = K.gvec(*g)
                centres.append(c)
                for d in gdirs:
                    t = d.orthogonal().normalized()
                    u = d.cross(t)
                    q = c + d * s
                    vs = [bm.verts.new(q + (t * a + u * b) * s) for a, b in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
                    face = bm.faces.new(vs)
                    if face.normal.dot(d) < 0:
                        face.normal_flip()
                    cx, cy = (f % cols) * 2, (f // cols) * 2
                    for l in face.loops:
                        # map the quad onto its 2x2 texels, inset so each texel centre is inside
                        lv = l.vert.co - q
                        a = (lv.dot(t) / s + 1) / 2
                        b = (lv.dot(u) / s + 1) / 2
                        l[uvl].uv = ((cx + 0.5 + a) / W, (cy + 0.5 + b) / H)
                    f += 1
    me = bpy.data.meshes.new('PROBES')
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new('PROBES', me)
    RGN.coll('BAKE_volume').objects.link(ob)
    ob.visible_shadow = ob.visible_diffuse = ob.visible_glossy = ob.visible_transmission = ob.visible_volume_scatter = False
    receiver(ob)
    hide(moving())
    for ch in CH:
        channel({ch})
        img = bpy.data.images.new(f'vol_{ch}', W, H, float_buffer=True)
        t = time.time()
        BK.bake(ob, img, 'DIFFUSE', {'DIRECT', 'INDIRECT'}, SAMPLES, margin=0, uv='BakeUV', keep_materials=True)
        px = BK.lum(BK.pixels(img))
        # average each face's 2x2 texels
        cell = px[:rows * 2, :cols * 2].reshape(rows, 2, cols, 2).mean((1, 3)).reshape(-1)[:faces_n]
        save(f'volume_{ch}', cell.reshape(count, 6))
        BK.log(f'  volume {ch} {time.time() - t:.0f}s')
    channel('all')
    hide(moving(), False)
    # probes buried in timber, rock or outside the cave: rays from them mostly hit back faces
    valid = probe_validity(centres)
    save('volume_valid', valid.astype(np.float32))
    bpy.data.objects.remove(ob)
    return {'origin': lo.tolist(), 'step': step, 'dims': [nx, ny, nz], 'faces': ['+x', '-x', '+y', '-y', '+z', '-z']}


def probe_validity(centres):
    dg = bpy.context.evaluated_depsgraph_get()
    objs = [o for o in coll_objs('SHELL') + coll_objs('WORKS') if o.type == 'MESH' and not o.name.startswith('SKY')]
    verts, polys = [], []
    for o in objs:
        me = o.evaluated_get(dg).to_mesh()
        off = len(verts)
        mw = o.matrix_world
        verts += [mw @ v.co for v in me.vertices]
        polys += [[off + i for i in p.vertices] for p in me.polygons]
        o.evaluated_get(dg).to_mesh_clear()
    tree = BVHTree.FromPolygons(verts, polys)
    dirs = [Vector(d).normalized() for d in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1),
                                              (1, 1, 1), (-1, -1, 1), (1, -1, -1), (-1, 1, -1))]
    out = np.ones(len(centres), bool)
    for i, c in enumerate(centres):
        back = 0
        for d in dirs:
            hit = tree.ray_cast(c, d, 60.0)
            if hit[0] is not None and hit[1].dot(d) > 0:
                back += 1
        out[i] = back < 4
    return out


STAGES = {'shell': stage_shell, 'works': stage_works, 'debris': stage_debris, 'machines': stage_machines, 'deck': stage_deck, 'rope': stage_rope, 'volume': stage_volume}
for st in ALL.split(','):
    if st in ONLY:
        BK.log('stage', st)
        MAN[st] = STAGES[st]()
        json.dump(MAN, open(MAN_P, 'w'), indent=1)
BK.log('done')
