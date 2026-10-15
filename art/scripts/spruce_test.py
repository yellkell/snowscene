"""Spruce look-dev bench: blender -b --factory-startup --python art/scripts/spruce_test.py -- [--snow 1.0] [--lod 0]"""
import bpy, sys, os, math, time
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from lib import spruce, sky, snowmats as SM, core
from mathutils import Vector
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
opt = lambda n, d: argv[argv.index(n) + 1] if n in argv else d
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
C = core.get_coll('HIGH')
t0 = time.time()
for i, (H, x) in enumerate([(15, 0), (9, 7), (5, -5)]):
    o = spruce.build(f'spruce_{i}', C, H=H, seed=11 + i, snow=float(opt('--snow', 1.0)), lod=int(opt('--lod', 0)))
    o.location = (x, i * 3.0, 0)
    print('tree', i, 'tris', sum(len(p.vertices) - 2 for p in o.data.polygons), 'cards', o['cards'], flush=True)
print('built in', time.time() - t0)
bpy.ops.mesh.primitive_plane_add(size=200)
g = bpy.context.object
me = g.data
uv = me.uv_layers.new(name='WorldUV')
for l in me.loops:
    v = me.vertices[l.vertex_index].co
    uv.data[l.index].uv = (v.x, v.y)
me.materials.append(SM.snow_ground())
AZ, EL = math.degrees(math.atan2(-0.68, -0.72)), 7.0
meta = sky.world('qwantani_sunset_puresky', AZ, strength=1.0)
sky.sun_lamp(meta, AZ, EL)
cd = bpy.data.cameras.new('CAM_front'); cd.lens = 24
cam = bpy.data.objects.new('CAM_front', cd); sc.collection.objects.link(cam)
cam.location = (-14, -14, 1.65)
cam.rotation_euler = (Vector((0, 2, 6)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
cd2 = bpy.data.cameras.new('CAM_back'); cd2.lens = 24
cam2 = bpy.data.objects.new('CAM_back', cd2); sc.collection.objects.link(cam2)
cam2.location = (13, 15, 1.65)
cam2.rotation_euler = (Vector((0, 2, 6)) - cam2.location).to_track_quat('-Z', 'Y').to_euler()
cd3 = bpy.data.cameras.new('CAM_close'); cd3.lens = 28
cam3 = bpy.data.objects.new('CAM_close', cd3); sc.collection.objects.link(cam3)
cam3.location = (-3.2, -3.5, 1.65)
cam3.rotation_euler = (Vector((0, 0, 2.2)) - cam3.location).to_track_quat('-Z', 'Y').to_euler()
sc.camera = cam
sc.view_settings.view_transform = 'AgX'
sc.render.engine = 'CYCLES'
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(SM.ART, 'work', 'spruce_test.blend'), compress=False)
