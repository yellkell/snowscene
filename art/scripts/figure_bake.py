"""Bake the lake party's people: blender -b --factory-startup --python art/scripts/figure_bake.py

Six mountaineers (lib/figure.py). Each is built whole (body and both arms hanging at the shoulders, so the
ambient occlusion sees the arms against the parka), atlas-mapped and baked like the held gear (albedo +
AO / roughness, metalness in a vertex colour), then split into body + left arm + right arm — the arms in
shoulder-pivot space — and added to public/gear/manifest.json as figure{k}_body / _larm / _rarm, all
three sharing the variant's textures.
"""
import bpy, bmesh, sys, os, json, math
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from lib import figure, bakekit as BK, regions as RGN, core  # noqa: E402
import gear_bake as GB  # noqa: E402

OUT = GB.OUT
RES = 512
METAL = ('_lens',)


def build(k):
    C = core.get_coll(f'FIG{k}')
    parts = [(figure.body(f'fig{k}_body', C, k), 0, None)]
    for limb, side in ((1, -1), (2, 1)):
        ob = figure.arm(f'fig{k}_arm{limb}', C, k, side)
        piv = figure.G(side * figure.SHOULDER[0], figure.SHOULDER[1], figure.SHOULDER[2])
        ob.data.transform(__import__('mathutils').Matrix.Translation(piv))
        parts.append((ob, limb, piv))
    for ob, limb, _ in parts:
        a = ob.data.attributes.new('limb', 'INT', 'FACE')
        a.data.foreach_set('value', np.full(len(ob.data.polygons), limb, np.int32))
    BK.select_only(parts[0][0], [p[0] for p in parts[1:]])
    bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = f'fig{k}'
    return ob, {limb: piv for _, limb, piv in parts}


def bake(k):
    ob, pivots = build(k)
    # sixteen of them dance at once: halve them (the limbs are separate shells, so the split survives)
    dec = ob.modifiers.new('dec', 'DECIMATE')
    dec.ratio = 0.5
    BK.select_only(ob)
    bpy.ops.object.modifier_apply(modifier=dec.name)
    me = ob.data
    # metalness per face -> corner colour (r); no translucent fabric here (g)
    mt = np.array([1.0 if any(s in me.materials[p.material_index].name for s in METAL) else 0.0 for p in me.polygons], np.float32)
    lt = np.empty(len(me.polygons), np.int32)
    me.polygons.foreach_get('loop_total', lt)
    col = np.repeat(mt, lt)
    a = me.color_attributes.new('COL', 'FLOAT_COLOR', 'CORNER')
    a.data.foreach_set('color', np.stack([col, np.zeros_like(col), np.zeros_like(col), np.ones_like(col)], -1).ravel())
    me.color_attributes.active_color = a
    uv = me.uv_layers.new(name='BakeUV')
    me.uv_layers.active = uv
    BK.select_only(ob)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.0)
    bpy.ops.uv.select_all(action='SELECT')
    bpy.ops.uv.average_islands_scale()
    bpy.ops.uv.pack_islands(rotate=True, margin_method='FRACTION', margin=3.0 / RES)
    bpy.ops.object.mode_set(mode='OBJECT')
    out = {}
    for kind, typ, passes, samples in (('albedo', 'DIFFUSE', {'COLOR'}, 8), ('ao', 'AO', None, 128), ('rough', 'ROUGHNESS', None, 4)):
        img = bpy.data.images.new(f'fig{k}_{kind}', RES * 2, RES * 2, float_buffer=True)
        BK.bake(ob, img, typ, passes, samples, margin=8, uv='BakeUV', keep_materials=True)
        px = BK.pixels(img)[..., :3]
        out[kind] = px.reshape(RES, 2, RES, 2, 3).mean((1, 3))     # supersampled
    GB.save_png(out['albedo'], os.path.join(OUT, f'fig{k}_albedo.webp'), True)
    orm = np.stack([out['ao'][..., 0], out['rough'][..., 0], np.zeros_like(out['ao'][..., 0])], -1)
    GB.save_png(orm, os.path.join(OUT, f'fig{k}_orm.webp'), False)
    for u in [u.name for u in me.uv_layers if u.name != 'BakeUV']:
        me.uv_layers.remove(me.uv_layers[u])
    me.materials.clear()
    entries = {}
    for limb, tag in ((0, 'body'), (1, 'larm'), (2, 'rarm')):
        part = ob.copy()
        part.data = me.copy()
        bpy.context.scene.collection.objects.link(part)
        bm = bmesh.new()
        bm.from_mesh(part.data)
        lay = bm.faces.layers.int['limb']
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if f[lay] != limb], context='FACES')
        bm.to_mesh(part.data)
        bm.free()
        part.data.attributes.remove(part.data.attributes['limb'])
        if pivots[limb] is not None:
            part.data.transform(__import__('mathutils').Matrix.Translation(-pivots[limb]))
        name = f'figure{k}_{tag}'
        RGN.export_glb([part], os.path.join(OUT, f'{name}.glb'), colors=True)
        entries[name] = {'mesh': f'{name}.glb', 'albedo': f'fig{k}_albedo.webp', 'orm': f'fig{k}_orm.webp',
                         'tris': sum(len(p.vertices) - 2 for p in part.data.polygons)}
        bpy.data.objects.remove(part)
        bpy.context.view_layer.update()
    return entries


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    BK.gpu(bpy.context.scene)
    bpy.context.scene.world = bpy.data.worlds.new('W')
    only = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ks = [int(x) for x in only] or list(range(len(figure.VARIANTS)))
    mp = os.path.join(OUT, 'manifest.json')
    man = json.load(open(mp))
    for k in ks:
        man.update(bake(k))
        # its far stand-in (lod_build.py figures) is of the old figure: the runtime keeps three draws until rebuilt
        if man.pop(f'figure{k}_far', None):
            print(f'figure{k}_far dropped (re-run lod_build.py -- figures)', flush=True)
        json.dump(man, open(mp, 'w'), indent=1)
        print('figure', k, {n: e['tris'] for n, e in man.items() if n.startswith(f'figure{k}_')}, flush=True)


main()
