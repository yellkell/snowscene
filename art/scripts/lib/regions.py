"""Generic bake regions (shared by the region bake scripts).

ground_region: a rectangle of a heightfield ground mesh, top-down UVs, baked to sun/sky irradiance
               (+ albedo) — re-lightable channels (see bakekit.light_mode).
atlas_region:  any set of objects (instances are realised), each decimated keeping its own materials,
               joined, given an atlas UV, baked to albedo + sun + sky, exported as one GLB.
Outputs are float arrays (.npy) + GLBs in `out`; encode.py turns them into runtime textures.
"""
import bpy, bmesh, os, math
import numpy as np
from . import bakekit as BK


def save(out, name, arr):
    np.save(os.path.join(out, name + '.npy'), arr.astype(np.float32))


def coll(name):
    sc = bpy.context.scene
    c = bpy.data.collections.get(name) or bpy.data.collections.new(name)
    if c.name not in sc.collection.children:
        sc.collection.children.link(c)
    return c


def stale_lod(path):
    """A layer just re-exported: its chunks (lod_build.py) are of the old mesh, so drop its lod.json entry
    and the runtime falls back to this mesh until lod_build runs again."""
    lj = os.path.join(os.path.dirname(path), 'lod.json')
    if not os.path.exists(lj):
        return
    import json
    meta = json.load(open(lj))
    stem = os.path.splitext(os.path.basename(path))[0]
    if stem in meta:
        del meta[stem]
        json.dump(meta, open(lj, 'w'), indent=1)
        print(f'lod.json: dropped stale {stem} (re-run lod_build.py)', flush=True)


def export_glb(objs, path, colors=False, pos_bits=14):
    """`pos_bits`: Draco's position grid over the whole mesh. 14 bits over the cave's 40 m of timber is a 2.4 mm
    grid, which snapped pieces held a millimetre apart back into one plane (they flickered): the cave uses 20."""
    stale_lod(path)
    BK.select_only(objs[0], objs[1:])
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=True,
                              export_texcoords=True, export_normals=True, export_materials='NONE',
                              export_vertex_color='ACTIVE' if colors else 'NONE', export_attributes=False,
                              export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=7,
                              export_draco_position_quantization=pos_bits, export_draco_normal_quantization=10,
                              export_draco_texcoord_quantization=12, export_draco_color_quantization=10,
                              export_yup=True, export_extras=True)


def ground_region(src, name, out, bounds, res, samples, albedo_res=0):
    """bounds = (x0, x1, y0, y1) in Blender XY. Bakes `src` (kept materials) inside the rectangle."""
    x0, x1, y0, y1 = bounds
    me = src.data.copy()
    o = bpy.data.objects.new(src.name + '_' + name, me)
    coll('BAKE').objects.link(o)
    bm = bmesh.new()
    bm.from_mesh(me)
    kill = [f for f in bm.faces if any(v.co.x < x0 - 1 or v.co.x > x1 + 1 or v.co.y < y0 - 1 or v.co.y > y1 + 1 for v in f.verts)]
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    bm.to_mesh(me)
    bm.free()
    uv = me.uv_layers.new(name='LM')
    co = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    lv = np.empty(len(me.loops), np.int32)
    me.loops.foreach_get('vertex_index', lv)
    uvs = np.stack([(co[lv, 0] - x0) / (x1 - x0), (co[lv, 1] - y0) / (y1 - y0)], -1)
    uv.data.foreach_set('uv', uvs.astype(np.float32).ravel())
    src.hide_render = True
    result = {}
    for mode in ('sun', 'sky'):
        BK.light_mode(mode)
        img = bpy.data.images.new(f'{name}_{mode}', res, res, float_buffer=True)
        BK.bake(o, img, 'DIFFUSE', {'DIRECT', 'INDIRECT'}, samples, margin=4, uv='LM', keep_materials=True)
        result[mode] = BK.lum(BK.denoise(img, out))
        save(out, f'{name}_{mode}', result[mode])
        BK.log(f'  {name} {mode} median', float(np.median(result[mode])))
    BK.light_mode('beauty')
    if albedo_res:
        alb = bpy.data.images.new(f'{name}_alb', albedo_res, albedo_res, float_buffer=True)
        BK.bake(o, alb, 'DIFFUSE', {'COLOR'}, 4, margin=4, uv='LM', keep_materials=True)
        save(out, f'{name}_albedo', BK.pixels(alb)[..., :3])
    src.hide_render = False
    bpy.data.objects.remove(o)
    return {'bounds_blender': list(bounds), 'res': res, 'albedo_res': albedo_res}


def realize(objs, dest):
    """Realise collection instances (recursively one level) into plain objects sharing their meshes."""
    out = []
    for inst in objs:
        if inst.type == 'MESH':
            o = bpy.data.objects.new('R_' + inst.name, inst.data)
            o.matrix_world = inst.matrix_world
            dest.objects.link(o)
            out.append(o)
        elif inst.instance_type == 'COLLECTION' and inst.instance_collection:
            for s in inst.instance_collection.all_objects:
                if s.type != 'MESH':
                    continue
                o = bpy.data.objects.new(f'R_{inst.name}_{s.name}', s.data)
                o.matrix_world = inst.matrix_world @ s.matrix_world
                dest.objects.link(o)
                out.append(o)
    return out


def drop_slivers(me, keep=0.05):
    """After decimation: drop collapsed faces and loose bits (islands under `keep` of the biggest), which
    otherwise hang in the air as dark slivers off a snow cap."""
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.calc_area() < 1e-7], context='FACES')
    seen, islands = set(), []
    for f in bm.faces:
        if f in seen:
            continue
        stack, isl = [f], []
        seen.add(f)
        while stack:
            g = stack.pop()
            isl.append(g)
            for e in g.edges:
                for k in e.link_faces:
                    if k not in seen:
                        seen.add(k)
                        stack.append(k)
        islands.append((sum(g.calc_area() for g in isl), isl))
    if islands:
        big = max(a for a, _ in islands)
        bmesh.ops.delete(bm, geom=[g for a, isl in islands if a < keep * big for g in isl], context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    bm.to_mesh(me)
    bm.free()


def solid_back(me, thickness):
    """Close an open scan (only the face the camera saw) into a slab: a back skin `thickness` behind its
    face and the rim between them, so from behind it is rock, not a see-through shell edged with slivers.
    Done on the decimated piece (solidifying the dense scan first, decimation folded the thin shell into
    itself)."""
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.solidify(bm, geom=bm.faces[:], thickness=-thickness)
    bm.to_mesh(me)
    bm.free()


def atlas_region(name, objs, out, albedo_res, light_res, samples, budget=lambda o, tris: tris, hide=(),
                 local=None, keep_uv=lambda o: False, solid=lambda o: 0.0):
    """Bake `objs` into one atlas-mapped mesh. `budget(obj, tris)` -> target tris for each piece.
    `hide`: objects/collections to hide from rendering while baking (e.g. the originals).
    `local`: a world matrix whose inverse is applied before export (to export in an instance's space).
    `keep_uv(obj)`: pieces whose own UVs (a scan's) seed the atlas instead of a fresh unwrap. Each piece is
    unwrapped on its own, then all islands are scaled to one texel density and packed together (a
    joint smart-project of hundreds of rocks makes tens of thousands of islands and fills ~1% of the atlas)."""
    BK.log('atlas', name)
    stage = coll('BAKE_' + name)
    pieces = realize(objs, stage)
    hidden = []
    for h in list(hide) + list(objs):
        if getattr(h, 'hide_render', None) is False:
            h.hide_render = True
            hidden.append(h)
    lows = []
    for h in pieces:
        tris = sum(len(p.vertices) - 2 for p in h.data.polygons)
        target = max(12, int(budget(h, tris)))
        o = bpy.data.objects.new('D_' + h.name, h.data)
        o.matrix_world = h.matrix_world
        stage.objects.link(o)
        if target < tris:
            o.modifiers.new('weld', 'WELD').merge_threshold = 0.001
            m = o.modifiers.new('dec', 'DECIMATE')
            m.ratio = target / max(tris, 1)
        dg = bpy.context.evaluated_depsgraph_get()
        dg.update()
        me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
        bpy.data.objects.remove(o)
        if target < tris and ('snowcap' in h.name or h.name.startswith('BAND_')):
            drop_slivers(me)
        t = solid(h)
        if t > 0:
            # in the piece's own units (its matrix carries the instance's scale)
            solid_back(me, t / max(1e-6, h.matrix_world.to_scale().x))
        lo = bpy.data.objects.new('L_' + h.name, me)
        lo.matrix_world = h.matrix_world
        stage.objects.link(lo)
        scan_uv = keep_uv(h) and len(me.uv_layers) > 0
        if not me.uv_layers:
            me.uv_layers.new(name='UVMap')
        me.uv_layers[0].name = 'UVMap'
        while len(me.uv_layers) > 1:
            me.uv_layers.remove(me.uv_layers[1])
        bake_uv = me.uv_layers.new(name='BakeUV')
        if scan_uv:
            a = np.zeros(len(me.loops) * 2, np.float32)
            me.uv_layers['UVMap'].data.foreach_get('uv', a)
            bake_uv.data.foreach_set('uv', a)
        else:
            me.uv_layers.active = bake_uv
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
    low.name = name.upper() + '_LOW'
    me = low.data
    me.uv_layers.active = me.uv_layers['BakeUV']
    me.uv_layers['UVMap'].active_render = True
    BK.select_only(low)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.select_all(action='SELECT')
    bpy.ops.uv.average_islands_scale()
    # ~3 texels of gutter at the light map's resolution
    bpy.ops.uv.pack_islands(rotate=True, margin_method='FRACTION', margin=3.0 / light_res)
    bpy.ops.object.mode_set(mode='OBJECT')
    tris = sum(len(p.vertices) - 2 for p in me.polygons)
    BK.log(f'  {name} low tris', tris)
    alb = bpy.data.images.new(f'{name}_alb', albedo_res, albedo_res, float_buffer=True)
    BK.bake(low, alb, 'DIFFUSE', {'COLOR'}, 4, margin=6, keep_materials=True)
    save(out, f'{name}_albedo', BK.pixels(alb)[..., :3])
    for mode in ('sun', 'sky'):
        BK.light_mode(mode)
        img = bpy.data.images.new(f'{name}_{mode}', light_res, light_res, float_buffer=True)
        BK.bake(low, img, 'DIFFUSE', {'DIRECT', 'INDIRECT'}, samples, margin=6, keep_materials=True)
        save(out, f'{name}_{mode}', BK.lum(BK.denoise(img, out)))
    BK.light_mode('beauty')
    me.uv_layers.remove(me.uv_layers['UVMap'])
    low.data.materials.clear()
    if local is not None:
        low.matrix_world = local.inverted() @ low.matrix_world
    export_glb([low], os.path.join(out, f'{name}.glb'))
    for h in hidden:
        h.hide_render = False
    bpy.data.objects.remove(low)
    return {'mesh': f'{name}.glb', 'tris': tris, 'albedo_res': albedo_res, 'light_res': light_res}
