"""Bake the Snow Survivors arena for Quest 3.

blender -b art/work/survivors.blend --python art/scripts/survivors_bake.py -- [--samples 256] [--only ground,props,trees,sky]

Writes float arrays + meshes into art/work/bake_survivors/; art/scripts/encode.py turns them into the runtime
files under public/survivors/ with a manifest.

  ground   lightmap over the arena (sun, sky irradiance; separate, re-lightable) + a low-res albedo map
  props    rocks, logs, stumps with their snow caps: decimated LOW mesh, smart-UV atlas, albedo + light
  trees    per spruce variant: realtime near-LOD mesh with per-vertex sun/sky light, and impostor frames
           (16 headings x 3 elevations) rendered lit by the sun alone and by the sky alone
  sky      the sunset sky (sun painted out) rotated to the arena, as an equirect panorama
"""
import bpy, bmesh, sys, os, json, math
import numpy as np
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from lib import bakekit as BK, spruce, sky as SKY, snowmats as SM, regions as RGN  # noqa: E402
from lib.forest import VARIANTS  # noqa: E402

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
opt = lambda n, d: argv[argv.index(n) + 1] if n in argv else d
SAMPLES = int(opt('--samples', 256))
ONLY = set(opt('--only', 'ground,props,trees,sky').split(','))
ART = os.path.dirname(HERE)
OUT = os.path.join(ART, 'work', 'bake_survivors')
os.makedirs(OUT, exist_ok=True)
LAYOUT = json.load(open(os.path.join(ART, 'work', 'survivors_layout.json')))
LM = 330.0          # lightmap half-extent (m), arena-relative
sc = bpy.context.scene
BK.gpu(sc)
MAN_P = os.path.join(OUT, 'bake.json')
MAN = json.load(open(MAN_P)) if os.path.exists(MAN_P) else {}


def save(name, arr):
    np.save(os.path.join(OUT, name + '.npy'), arr.astype(np.float32))


def coll(name):
    c = bpy.data.collections.get(name) or bpy.data.collections.new(name)
    if c.name not in sc.collection.children:
        sc.collection.children.link(c)
    return c


def export_glb(objs, path, colors=False):
    RGN.stale_lod(path)
    BK.select_only(objs[0], objs[1:])
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=True,
                              export_texcoords=True, export_normals=True, export_materials='NONE',
                              export_vertex_color='ACTIVE' if colors else 'NONE', export_attributes=False,
                              export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=7,
                              export_draco_position_quantization=14, export_draco_normal_quantization=10,
                              export_draco_texcoord_quantization=12, export_draco_color_quantization=10,
                              export_yup=True, export_extras=True)


# ---------------------------------------------------------------- ground
def bake_ground():
    BK.log('ground')
    src = bpy.data.objects['GROUND']
    me = src.data.copy()
    o = bpy.data.objects.new('GROUND_LM', me)
    coll('BAKE').objects.link(o)
    bm = bmesh.new()
    bm.from_mesh(me)
    kill = [f for f in bm.faces if any(abs(v.co.x) > LM + 1 or abs(v.co.y) > LM + 1 for v in f.verts)]
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    bm.to_mesh(me)
    bm.free()
    uv = me.uv_layers.new(name='LM')
    co = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    lv = np.empty(len(me.loops), np.int32)
    me.loops.foreach_get('vertex_index', lv)
    uvs = (co[lv, :2] + LM) / (2 * LM)
    uv.data.foreach_set('uv', uvs.astype(np.float32).ravel())
    src.hide_render = True          # the crop stands in for it (coincident surfaces would self-shadow)
    res = int(opt('--ground-res', 4096))
    out = {}
    for mode in ('sun', 'sky'):
        BK.light_mode(mode)
        img = bpy.data.images.new(f'ground_{mode}', res, res, float_buffer=True)
        BK.bake(o, img, 'DIFFUSE', {'DIRECT', 'INDIRECT'}, SAMPLES, margin=4, uv='LM', keep_materials=True)
        out[mode] = BK.lum(BK.denoise(img, OUT))
        BK.log('  ground', mode, 'p50', float(np.median(out[mode])), 'p99.9', float(np.percentile(out[mode], 99.9)))
    BK.light_mode('beauty')
    alb = bpy.data.images.new('ground_alb', 2048, 2048, float_buffer=True)
    BK.bake(o, alb, 'DIFFUSE', {'COLOR'}, 4, margin=4, uv='LM', keep_materials=True)
    A = BK.pixels(alb)[..., :3]
    # Image rows run bottom-up in Blender = Blender -Y first = game +Z... store as-is, document in manifest.
    save('ground_sun', out['sun'])
    save('ground_sky', out['sky'])
    save('ground_albedo', A)
    MAN['ground'] = {'extent': LM, 'res': res, 'rows': 'v = (blender_y + extent) / (2 extent) = (extent - game_z) / (2 extent), row 0 at v=0'}
    src.hide_render = False
    bpy.data.objects.remove(o)


# ---------------------------------------------------------------- props
def realize(coll_name, dest):
    out = []
    for inst in bpy.data.collections[coll_name].objects:
        if inst.instance_type != 'COLLECTION':
            continue
        for s in inst.instance_collection.all_objects:
            if s.type != 'MESH':
                continue
            o = bpy.data.objects.new(f'R_{inst.name}_{s.name}', s.data)
            o.matrix_world = inst.matrix_world @ s.matrix_world
            dest.objects.link(o)
            out.append(o)
    return out


def bake_props():
    """Rocks, logs and stumps with their snow caps, through the shared atlas path (lib/regions.py): each
    piece decimated keeping its own materials, the scans keeping their own UV layouts, everything packed
    at one texel density into one atlas, and baked directly."""
    objs = [o for o in bpy.data.collections['PROPS'].objects if o.instance_type == 'COLLECTION']
    caps = lambda o: not o.data.uv_layers
    info = RGN.atlas_region('props', objs, OUT, 2048, 1024, SAMPLES,
                            budget=lambda o, t: (260 if caps(o) else 520) * min(2.2, max(0.6, max(o.dimensions) / 1.6)),
                            keep_uv=lambda o: not caps(o))
    MAN['props'] = {'tris': info['tris']}


# ---------------------------------------------------------------- trees
YAWS = 16
ELEVS = (-8.0, 6.0, 22.0)


def isolate_tree_scene():
    """Hide the arena; a clean snow plane (invisible to camera) gives the trees their ground bounce."""
    for c in ('HIGH',):
        bpy.data.collections[c].hide_render = True
    tb = coll('TREEBAKE')
    if 'TB_GROUND' not in bpy.data.objects:
        bpy.ops.mesh.primitive_plane_add(size=400)
        g = bpy.context.object
        for c in list(g.users_collection):
            c.objects.unlink(g)
        tb.objects.link(g)
        g.name = 'TB_GROUND'
        uv = g.data.uv_layers.new(name='WorldUV')
        for l in g.data.loops:
            v = g.data.vertices[l.vertex_index].co
            uv.data[l.index].uv = (v.x * 200, v.y * 200)
        g.data.materials.append(bpy.data.materials['snow_ground'])
        g.visible_camera = False
    return tb


def tree_lod(key, tb):
    H, cr, sd, flag = VARIANTS[key]
    o = spruce.build(f'lod1_{key}', tb, H=H, seed=sd, snow=1.0, lod=1, crown=cr, flag=flag)
    me = o.data
    # per-corner light, baked to vertex colours (one pass per channel)
    vals = {}
    for mode in ('sun', 'sky'):
        BK.light_mode(mode)
        a = me.color_attributes.new(f'l_{mode}', 'FLOAT_COLOR', 'CORNER')
        me.color_attributes.active_color = a
        me.color_attributes.render_color_index = list(me.color_attributes).index(a)
        BK.select_only(o)
        sc.cycles.samples = max(64, SAMPLES // 2)
        bpy.ops.object.bake(type='DIFFUSE', pass_filter={'DIRECT', 'INDIRECT'}, target='VERTEX_COLORS',
                            use_clear=True)
        c = np.empty(len(me.loops) * 4, np.float32)
        a.data.foreach_get('color', c)
        vals[mode] = BK.lum(c.reshape(-1, 4))
    BK.light_mode('beauty')
    # kind per face from material; snow load per face
    kinds = {'spruce_needles': 0.0, 'spruce_bark': 1.0, 'spruce_snow': 2.0}
    fk = np.array([kinds.get(me.materials[p.material_index].name, 2.0) for p in me.polygons], np.float32)
    load = np.zeros(len(me.polygons), np.float32)
    if 'snow' in me.attributes:
        me.attributes['snow'].data.foreach_get('value', load)
    lt = np.empty(len(me.polygons), np.int32)
    me.polygons.foreach_get('loop_total', lt)
    corner_kind = np.repeat(fk, lt)
    corner_load = np.repeat(load, lt)
    MAX = {'sun': 1.0, 'sky': 3.0}
    packed = np.stack([np.sqrt(np.clip(vals['sun'] / MAX['sun'], 0, 1)), np.sqrt(np.clip(vals['sky'] / MAX['sky'], 0, 1)),
                       corner_load, corner_kind / 2.0], axis=1)
    out = me.color_attributes.new('COL', 'FLOAT_COLOR', 'CORNER')
    out.data.foreach_set('color', packed.astype(np.float32).ravel())
    me.color_attributes.active_color = out
    for n in [a.name for a in me.color_attributes if a.name != 'COL']:
        me.color_attributes.remove(me.color_attributes[n])
    for u in [u.name for u in me.uv_layers if u.name != 'UVMap']:
        me.uv_layers.remove(me.uv_layers[u])
    for p in me.polygons:
        p.material_index = 0
    me.materials.clear()
    export_glb([o], os.path.join(OUT, f'tree_{key}.glb'), colors=True)
    tris = sum(len(p.vertices) - 2 for p in me.polygons)
    bpy.data.objects.remove(o)
    return {'tris': tris, 'light_max': MAX, 'sun_mean': float(vals['sun'].mean()), 'sky_mean': float(vals['sky'].mean()), 'sun_max': float(vals['sun'].max()), 'sky_max': float(vals['sky'].max())}


def impostor(key, tb):
    """Render the HIGH variant from YAWS headings x ELEVS elevations, lit by the sun alone and the sky alone."""
    H = VARIANTS[key][0]
    src = bpy.data.collections['V_' + key]
    inst = bpy.data.objects.new('IMP_' + key, None)
    inst.instance_type = 'COLLECTION'
    inst.instance_collection = src
    tb.objects.link(inst)
    # bounds of the variant
    pts = []
    for o in src.all_objects:
        if o.type == 'MESH':
            pts += [o.matrix_world @ Vector(c) for c in o.bound_box]
    rx = max(max(abs(p.x), abs(p.y)) for p in pts)
    zmax = max(p.z for p in pts)
    W = 2 * rx * 1.04
    Hh = zmax * 1.04
    small = H < 6
    fw, fh = (64, 96) if small else (96, 192)
    cam_d = bpy.data.cameras.new('IMPCAM')
    cam_d.type = 'ORTHO'
    cam = bpy.data.objects.new('IMPCAM', cam_d)
    tb.objects.link(cam)
    sc.camera = cam
    sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = fw, fh, 100
    sc.render.film_transparent = True
    sc.render.use_persistent_data = True
    sc.cycles.samples = 96
    sc.cycles.use_denoising = True
    sc.render.image_settings.file_format = 'OPEN_EXR'
    sc.render.image_settings.color_depth = '32'
    sc.render.image_settings.color_mode = 'RGBA'
    sc.view_settings.view_transform = 'Standard'
    atlas = {m: np.zeros((len(ELEVS) * fh, YAWS * fw, 4), np.float32) for m in ('sun', 'sky')}
    tmp = os.path.join(OUT, '_imp.exr')
    scales = []
    for ei, el in enumerate(ELEVS):
        # ortho frame must contain the tree's tilted silhouette
        e = math.radians(el)
        span_v = Hh * math.cos(e) + W * abs(math.sin(e))
        # Portrait frames: ortho_scale is the frame's world height; its width is ortho_scale * fw / fh.
        cam_d.ortho_scale = max(span_v, W * fh / fw)
        scales.append(cam_d.ortho_scale)
        for yi in range(YAWS):
            az = 2 * math.pi * yi / YAWS
            # camera on a circle around the tree, looking at mid-height; heading az (Blender XY angle) is
            # the direction FROM the tree TO the camera.
            d = Vector((math.cos(e) * math.cos(az), math.cos(e) * math.sin(az), math.sin(e)))
            centre = Vector((0, 0, zmax * 0.5))
            cam.location = centre + d * (zmax * 3 + 20)
            cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
            for mode in ('sun', 'sky'):
                BK.light_mode(mode)
                sc.render.filepath = tmp
                bpy.ops.render.render(write_still=True)
                im = bpy.data.images.load(tmp)
                px = BK.pixels(im)
                bpy.data.images.remove(im)
                atlas[mode][ei * fh:(ei + 1) * fh, yi * fw:(yi + 1) * fw] = px
    BK.light_mode('beauty')
    sc.view_settings.view_transform = 'AgX'
    # persistent data keeps Cycles' scene between renders; later bakes must see a fresh sync
    sc.render.use_persistent_data = False
    bpy.data.objects.remove(inst)
    bpy.data.objects.remove(cam)
    for m in ('sun', 'sky'):
        save(f'imp_{key}_{m}', atlas[m])
    # Each frame is centred on (0, zmax / 2, 0) of the tree, `ortho[row]` metres tall.
    return {'frame': [fw, fh], 'yaws': YAWS, 'elevs': list(ELEVS), 'width': W, 'height': Hh, 'centre_y': zmax * 0.5,
            'ortho': scales}


def bake_trees():
    BK.log('trees')
    tb = isolate_tree_scene()
    MAN.setdefault('trees', {})
    keys = [k for k in VARIANTS if (opt('--tree', '') in ('', k))]
    for key in keys:
        info = tree_lod(key, tb)
        BK.log('  lod', key, info)
        info.update(impostor(key, tb))
        BK.log('  impostor', key)
        MAN['trees'][key] = info
        json.dump(MAN, open(MAN_P, 'w'), indent=1)
    bpy.data.collections['HIGH'].hide_render = False


# ---------------------------------------------------------------- sky
SKIES = [('sunset', 'qwantani_sunset_puresky', True), ('dusk1', 'qwantani_dusk_1_puresky', True),
         ('dusk2', 'qwantani_dusk_2_puresky', True), ('night', 'qwantani_night_puresky', False)]


def bake_sky():
    """The evening, one place: sunset (sun painted out, it becomes the lamp), two dusks and the night (the
    moon left in). All four were shot from the same spot, so the sunset's turn aligns them all."""
    BK.log('sky')
    rot = LAYOUT['sky']['world_rot_rad']
    MAN['skies'] = {}
    for name, hid, paint in SKIES:
        meta = SKY.prep(hid, paint=paint)
        im = bpy.data.images.load(os.path.join(ART, 'work', f"sky_{hid}_nosun.exr"))
        px = BK.pixels(im)[..., :3]
        bpy.data.images.remove(im)
        h, w = px.shape[:2]
        # The world mapping rotates lookup vectors by `rot` about Z; in the equirect that is a column roll.
        shift = int(round(-rot / (2 * math.pi) * w))
        px = np.roll(px, -shift, axis=1)
        save(f'sky_{name}', px)
        lat = (np.arange(h) + 0.5) / h * math.pi - math.pi / 2
        dA = (2 * math.pi / w) * (math.pi / h) * np.cos(lat) * np.maximum(np.sin(lat), 0)
        E = (px * dA[:, None, None]).sum((0, 1))
        MAN['skies'][name] = {'hid': hid, 'irradiance_rgb': E.tolist(), 'sun': bool(meta.get('sun')) and paint,
                              'sun_irradiance': meta.get('irradiance', 0) if paint else 0.0,
                              'sun_color': meta.get('color', [1, 1, 1])}
        BK.log('  sky', name, 'E', [round(float(x), 4) for x in E])
    s = MAN['skies']['sunset']
    MAN['sky'] = {'hid': s['hid'], 'irradiance_rgb': s['irradiance_rgb'], 'sun_irradiance': s['sun_irradiance'],
                  'sun_color': s['sun_color'], 'sun_azim_deg': LAYOUT['sun']['azim_deg'],
                  'sun_elev_deg': LAYOUT['sun']['elev_deg']}


for stage, fn in (('sky', bake_sky), ('ground', bake_ground), ('props', bake_props), ('trees', bake_trees)):
    if stage in ONLY:
        fn()
        json.dump(MAN, open(MAN_P, 'w'), indent=1)
json.dump(MAN, open(MAN_P, 'w'), indent=1)
BK.log('done')
