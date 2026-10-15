"""Look-dev for held gear: blender -b --factory-startup --python art/scripts/gear_test.py"""
import bpy, sys, os, math
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from lib import gear, sky, snowmats as SM, core
from mathutils import Vector, Euler
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
C = core.get_coll('G')
p = gear.build_pole('pole', C)
p.location = (0, 0, 1.05); p.rotation_euler = Euler((math.radians(-62), 0, math.radians(20)))
bpy.ops.mesh.primitive_plane_add(size=50)
g = bpy.context.object
uv = g.data.uv_layers.new(name='WorldUV')
for l in g.data.loops:
    v = g.data.vertices[l.vertex_index].co; uv.data[l.index].uv = (v.x, v.y)
g.data.materials.append(SM.snow_ground())
AZ, EL = math.degrees(math.atan2(-0.68, -0.72)), 7.0
meta = sky.world('qwantani_sunset_puresky', AZ); sky.sun_lamp(meta, AZ, EL)
for name, loc, tgt, lens in (('CAM_grip', (0.35, -0.45, 1.25), (0, 0.05, 1.0), 50), ('CAM_pole', (0.9, -1.3, 1.4), (0, 0.3, 0.6), 35)):
    cd = bpy.data.cameras.new(name); cd.lens = lens
    o = bpy.data.objects.new(name, cd); sc.collection.objects.link(o)
    o.location = loc; o.rotation_euler = (Vector(tgt) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
sc.camera = bpy.data.objects['CAM_grip']
sc.view_settings.view_transform = 'AgX'
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(SM.ART, 'work', 'gear_test.blend'), compress=False)
