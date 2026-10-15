"""Bake held gear for the runtime: blender -b --factory-startup --python art/scripts/gear_bake.py

Each item: smart-UV atlas, albedo + AO + roughness baked from its Cycles materials, metalness per
material into a vertex colour; GLB + textures into public/gear/ (via numpy arrays encoded here with
Blender's own image writer, since these are small).
"""
import bpy, sys, os, json, math
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from lib import gear, glider, bakekit as BK, regions as RGN, core  # noqa: E402

ART = os.path.dirname(HERE)
OUT = os.path.join(os.path.dirname(ART), 'public', 'gear')
WORK = os.path.join(ART, 'work', 'bake_gear')
os.makedirs(OUT, exist_ok=True)
os.makedirs(WORK, exist_ok=True)
TRANSLUCENT = {'sail': 0.35}
METAL = {'pole_upper': 1, 'pole_mid': 1, 'pole_lower': 1, 'pole_carbide': 1, 'glider_alu': 1, 'glider_black': 1, 'glider_wire': 1, 'hut_iron': 1, 'pack_brass': 1}


def save_png(arr, path, srgb):
    h, w = arr.shape[:2]
    if srgb:   # encode explicitly; the image itself stores raw values
        arr = np.where(arr <= 0.0031308, arr * 12.92, 1.055 * np.power(np.maximum(arr, 0), 1 / 2.4) - 0.055)
    img = bpy.data.images.new(os.path.basename(path), w, h, float_buffer=False)
    img.colorspace_settings.name = 'Non-Color'
    rgba = np.concatenate([arr, np.ones((h, w, 1), np.float32)], -1) if arr.shape[-1] == 3 else arr
    img.pixels.foreach_set(np.clip(rgba, 0, 1).astype(np.float32).ravel())
    img.filepath_raw = path
    img.file_format = 'WEBP'
    bpy.context.scene.render.image_settings.quality = 92
    img.save()


def bake_item(name, ob, res=1024):
    sc = bpy.context.scene
    me = ob.data
    # metalness per face (from its material) -> per-corner colour
    mt = np.array([METAL.get(me.materials[p.material_index].name, 0) for p in me.polygons], np.float32)
    lt = np.empty(len(me.polygons), np.int32)
    me.polygons.foreach_get('loop_total', lt)
    col = np.repeat(mt, lt)
    tl = np.repeat(np.array([TRANSLUCENT.get(me.materials[p.material_index].name, 0) for p in me.polygons], np.float32), lt)
    a = me.color_attributes.new('COL', 'FLOAT_COLOR', 'CORNER')
    a.data.foreach_set('color', np.stack([col, tl, np.zeros_like(col), np.ones_like(col)], -1).ravel())
    me.color_attributes.active_color = a
    uv = me.uv_layers.new(name='BakeUV')
    me.uv_layers.active = uv
    if 'UVMap' in me.uv_layers:
        me.uv_layers['UVMap'].active_render = True
    BK.select_only(ob)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(55), island_margin=0.006)
    bpy.ops.object.mode_set(mode='OBJECT')
    out = {}
    for kind, typ, passes, samples in (('albedo', 'DIFFUSE', {'COLOR'}, 8), ('ao', 'AO', None, 128), ('rough', 'ROUGHNESS', None, 4)):
        img = bpy.data.images.new(f'{name}_{kind}', res, res, float_buffer=True)
        BK.bake(ob, img, typ, passes, samples, margin=8, uv='BakeUV', keep_materials=True)
        out[kind] = BK.pixels(img)[..., :3]
    save_png(out['albedo'], os.path.join(OUT, f'{name}_albedo.webp'), True)
    orm = np.stack([out['ao'][..., 0], out['rough'][..., 0], np.zeros_like(out['ao'][..., 0])], -1)
    save_png(orm, os.path.join(OUT, f'{name}_orm.webp'), False)
    for u in [u.name for u in me.uv_layers if u.name != 'BakeUV']:
        me.uv_layers.remove(me.uv_layers[u])
    me.materials.clear()
    RGN.export_glb([ob], os.path.join(OUT, f'{name}.glb'), colors=True)
    return {'mesh': f'{name}.glb', 'albedo': f'{name}_albedo.webp', 'orm': f'{name}_orm.webp',
            'tris': sum(len(p.vertices) - 2 for p in me.polygons)}


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    BK.gpu(bpy.context.scene)
    bpy.context.scene.world = bpy.data.worlds.new('W')
    C = core.get_coll('GEAR')
    # merge: other bakes (figure_bake.py) keep their entries in the same manifest
    mp = os.path.join(OUT, 'manifest.json')
    man = json.load(open(mp)) if os.path.exists(mp) else {}
    only = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    if not only or 'pole' in only:
        man['pole'] = bake_item('pole', gear.build_pole('pole', C), 1024)
    if not only or 'glider_left' in only:
        man['glider_left'] = bake_item('glider_left', glider.wing('glider_left', C, -1), 2048)
    if not only or 'glider_right' in only:
        man['glider_right'] = bake_item('glider_right', glider.wing('glider_right', C, 1), 2048)
    if not only or 'glider_keel' in only:
        man['glider_keel'] = bake_item('glider_keel', glider.keel('glider_keel', C), 1024)
    if not only or 'glider_bar' in only:
        man['glider_bar'] = bake_item('glider_bar', glider.control_bar('glider_bar', C), 1024)
    if not only or 'bench' in only:
        man['bench'] = bake_item('bench', gear.build_bench('bench', C), 2048)
    if not only or 'pack' in only:
        man['pack'] = bake_item('pack', gear.build_pack('pack', C), 1024)
    json.dump(man, open(mp, 'w'), indent=1)
    print('gear', man, flush=True)


if __name__ == '__main__' and 'gear_bake' in ' '.join(sys.argv):
    main()
