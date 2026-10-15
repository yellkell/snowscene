"""Check the realtime creatures: the exported LODs with the baked atlas, under the same sky and sun as look-dev.

  blender -b --factory-startup --python art/scripts/creatures_lodcheck.py -- [--kinds ghoul,titan] [--samples 32]

Imports public/survivors/creatures/creatures.glb, gives every LOD a material made only of what the game has
(albedo, gloss, object-space normal, AO, emission x accent from the atlas previews creatures_encode.py writes),
and renders LOD0 / LOD1 / LOD2 side by side per kind to art/renders/creature_<kind>_lods.png.
"""
import bpy, sys, os, json, math
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from lib import sky, snowmats as SM
from lib.nodes import NB
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
opt = lambda n, d: argv[argv.index(n) + 1] if n in argv else d
ROOT = os.path.dirname(os.path.dirname(HERE))
WORK = os.path.join(ROOT, 'art', 'work', 'creatures')
PUB = os.path.join(ROOT, 'public', 'survivors', 'creatures')
man = json.load(open(os.path.join(PUB, 'manifest.json')))
kinds = opt('--kinds', ','.join(man['kinds'])).split(',')

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
import struct
import numpy as np


def read_glb(path):
    """The LODs straight from the GLB (our own plain layout): name -> (positions, uv, triangles)."""
    raw = open(path, 'rb').read()
    jl = struct.unpack_from('<I', raw, 12)[0]
    gl = json.loads(raw[20:20 + jl])
    bin_ = raw[20 + jl + 8:]
    def acc(i):
        a = gl['accessors'][i]
        v = gl['bufferViews'][a['bufferView']]
        dt = {5126: np.float32, 5123: np.uint16, 5125: np.uint32}[a['componentType']]
        n = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3}[a['type']]
        return np.frombuffer(bin_, dt, a['count'] * n, v['byteOffset']).reshape(a['count'], n)
    out = {}
    for m in gl['meshes']:
        pr = m['primitives'][0]
        out[m['name']] = (acc(pr['attributes']['POSITION']), acc(pr['attributes']['TEXCOORD_0']), acc(pr['indices']).reshape(-1, 3))
    return out


for name, (P, UV, T) in read_glb(os.path.join(PUB, man['glb'])).items():
    me = bpy.data.meshes.new(name)
    B = np.stack([P[:, 0], -P[:, 2], P[:, 1]], -1)  # game -> Blender
    me.from_pydata(B.tolist(), [], T.tolist())
    lv = np.empty(len(me.loops), np.int64)
    me.loops.foreach_get('vertex_index', lv)
    uvl = me.uv_layers.new(name='UVMap')
    uvl.data.foreach_set('uv', np.stack([UV[:, 0], 1.0 - UV[:, 1]], -1)[lv].astype(np.float32).ravel())
    ob = bpy.data.objects.new(name, me)
    sc.collection.objects.link(ob)
img = lambda n, nc: bpy.data.images.load(os.path.join(WORK, n), check_existing=True)
alb_i, nrm_i, eag_i = img('check_albedo.png', False), img('check_normal.png', True), img('check_eag.png', True)
nrm_i.colorspace_settings.name = 'Non-Color'
eag_i.colorspace_settings.name = 'Non-Color'


def material(name, accent):
    m = bpy.data.materials.new(name)
    nb = NB(m)
    uv = nb.uv('UVMap')
    a = nb.img(alb_i, uv, ext='EXTEND').outputs['Color']
    n = nb.img(nrm_i, uv, ext='EXTEND').outputs['Color']
    e = nb.img(eag_i, uv, ext='EXTEND').outputs['Color']
    em, ao, gl = nb.sepc(e)
    nm = nb.n('ShaderNodeNormalMap', space='OBJECT', ins={'Color': n, 'Strength': 1.0}).outputs['Normal']
    base = nb.mix(1.0, a, nb.comb(ao, ao, ao), blend='MULTIPLY')
    base = nb.mix(0.5, a, base)
    rough = nb.math('SUBTRACT', 1.0, nb.math('MULTIPLY', gl, 0.85))
    nb.bsdf(base, rough=rough, normal=nm, ecol=accent, estr=nb.math('MULTIPLY', em, man['emit_max']))
    return m


bpy.ops.mesh.primitive_plane_add(size=1)
g = bpy.context.object
g.scale = (400, 400, 1)
bpy.ops.object.transform_apply(scale=True)
g.location.z = 0.012
uv = g.data.uv_layers.new(name='WorldUV')
for l in g.data.loops:
    v = g.data.vertices[l.vertex_index].co
    uv.data[l.index].uv = (v.x, v.y)
g.data.materials.append(SM.snow_ground())
AZ, EL = math.degrees(math.atan2(-0.68, -0.72)), 7.0
meta = sky.world('qwantani_sunset_puresky', AZ, strength=1.0)
sky.sun_lamp(meta, AZ, EL)
objs = {o.name: o for o in bpy.data.objects if o.type == 'MESH' and '_lod' in o.name}
for i, k in enumerate(kinds):
    info = man['kinds'][k]
    R = info['radius']
    mat = material(f'{k}_rt', info['accent_linear'])
    oy = i * 40.0
    for l in range(3):
        o = objs.get(f'{k}_lod{l}')
        if o is None:
            continue
        o.data.materials.clear()
        o.data.materials.append(mat)
        for p in o.data.polygons:
            p.use_smooth = True
        o.rotation_euler = (0, 0, 0)
        o.scale = (R, R, R)
        o.location = ((l - 1) * R * 4.2, oy, 0)
    cd = bpy.data.cameras.new(f'CAM_{k}')
    cd.lens = 32
    cam = bpy.data.objects.new(f'CAM_{k}', cd)
    sc.collection.objects.link(cam)
    d = Vector((0.35, -1.0, 0)).normalized() * R * 11.0
    cam.location = Vector((0, oy, 0)) + d + Vector((0, 0, max(1.4, R * 2.2)))
    cam.rotation_euler = (Vector((0, oy, R * 0.5)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
sc.view_settings.view_transform = 'AgX'
prefs = bpy.context.preferences.addons['cycles'].preferences
prefs.compute_device_type = 'OPTIX'
prefs.get_devices()
for dv in prefs.devices:
    dv.use = dv.type == 'OPTIX'
sc.render.engine = 'CYCLES'
sc.cycles.device = 'GPU'
sc.cycles.samples = int(opt('--samples', 32))
sc.cycles.use_denoising = True
sc.render.resolution_x, sc.render.resolution_y = 1280, 540
for k in kinds:
    sc.camera = bpy.data.objects[f'CAM_{k}']
    sc.render.filepath = os.path.join(ROOT, 'art', 'renders', f'creature_{k}_lods.png')
    bpy.ops.render.render(write_still=True)
    print('wrote', sc.render.filepath, flush=True)
