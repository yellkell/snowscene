"""The tutorial's vista: the great ranges and the sea of clouds, rendered as a 360-degree panorama.

blender -b --factory-startup --python art/scripts/vista_build.py -- [--res 8192] [--samples 128] [--render]

The ranges are the game's own (far-ranges.ts farHeight, exported to art/work/heights_ranges.*), the
cloud sea sits at the game's CLOUD_SEA_Y; the sky and sun are the tutorial's (lib/sky.py, same as
tutorial_build.py). Output art/work/vista_<name>.exr (+ mist pass) -> encoded by encode.py.
Game (x, y, z) = Blender (x, -z, y).
"""
import bpy, sys, os, json, math
import numpy as np
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from lib import snowmats as SM, sky as SKY, bakekit as BK  # noqa: E402
from lib.nodes import NB  # noqa: E402

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
opt = lambda n, d: argv[argv.index(n) + 1] if n in argv else d
RES = int(opt('--res', 8192))
SAMPLES = int(opt('--samples', 128))
ART = os.path.dirname(HERE)
WORK = os.path.join(ART, 'work')
META = json.load(open(os.path.join(WORK, 'heights_ranges.json')))
HD = np.fromfile(os.path.join(WORK, 'heights_ranges.bin'), dtype=np.float32).reshape(len(META['radii']), META['na'])
CLOUD_Y = META['cloudY']
SUN_DIR_GAME = Vector((-0.72, 0.065, 0.68)).normalized()
SUN_AZIM = math.degrees(math.atan2(-SUN_DIR_GAME.z, SUN_DIR_GAME.x))
SUN_ELEV = math.degrees(math.asin(SUN_DIR_GAME.y))
EYE = Vector((0.0, 10.0, 25.0))   # Blender: game (0, 25, -10), mid-way between trail, summit and bluff


from lib import ranges as RG  # noqa: E402
from lib.ranges import ranges_mesh, mountain_material, PANO_MIN_R  # noqa: E402


def cloud_sea():
    """A sea of cloud: a slab of volume whose top billows up out of a flat base, densest below."""
    me = bpy.data.meshes.new('cloudbox')
    s, z0, z1 = 26000.0, CLOUD_Y - 260.0, CLOUD_Y + 60.0
    vs = [(-s, -s, z0), (s, -s, z0), (s, s, z0), (-s, s, z0), (-s, -s, z1), (s, -s, z1), (s, s, z1), (-s, s, z1)]
    fs = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    me.from_pydata(vs, [], fs)
    ob = bpy.data.objects.new('CLOUDS', me)
    bpy.context.scene.collection.objects.link(ob)
    m = SM.new('cloud_sea')
    nb = NB(m)
    pos = nb.pos()
    x, y, z = nb.sep(pos)
    # billow height field: the top surface undulates 60 m, with towers here and there
    billow = nb.noise(nb.vmath('SCALE', pos, s=1.0), 0.0025, detail=7.0, rough=0.6, dims='2D')
    towers = nb.mrange(nb.noise(pos, 0.00035, detail=2.0, dims='2D'), 0.55, 0.75, 0.0, 1.0)
    top = nb.math('ADD', CLOUD_Y - 110.0, nb.math('ADD', nb.math('MULTIPLY', billow, 170.0), nb.math('MULTIPLY', towers, 120.0)))
    fill = nb.mrange(nb.math('SUBTRACT', top, z), -4.0, 18.0, 0.0, 1.0)
    wisp = nb.noise(pos, 0.004, detail=6.0, rough=0.6)
    dens = nb.math('MULTIPLY', fill, nb.mrange(wisp, 0.3, 0.6, 0.35, 1.0))
    vol = nb.n('ShaderNodeVolumePrincipled', ins={'Color': (1.0, 1.0, 1.0), 'Density': nb.math('MULTIPLY', dens, 0.035), 'Anisotropy': 0.55})
    nb.link(vol.outputs[0], nb.out.inputs['Volume'])
    me.materials.append(m)
    return ob


HORIZON = (0.5, 0.55, 0.65, 1.0)
WORLD_ROT = 0.0


def horizon_colour(hid):
    im = bpy.data.images.load(os.path.join(WORK, f'sky_{hid}_nosun.exr'), check_existing=True)
    w, h = im.size
    px = np.empty(w * h * 4, np.float32)
    im.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)[int(h * 0.5):int(h * 0.52), :, :3].reshape(-1, 3)
    return tuple(float(x) for x in np.median(px, 0)) + (1.0,)


def main():
    global HORIZON, WORLD_ROT
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    BK.gpu(sc)
    meta0 = SKY.prep('qwantani_sunset_puresky')
    WORLD_ROT = math.radians(360.0 * (0.5 - meta0['u']) - SUN_AZIM)
    RG.WORLD_ROT = WORLD_ROT
    HORIZON = horizon_colour('qwantani_sunset_puresky')
    print('horizon', HORIZON, flush=True)
    ranges_mesh()
    cloud_sea()
    meta = SKY.world('qwantani_sunset_puresky', SUN_AZIM, strength=1.0)
    SKY.sun_lamp(meta, SUN_AZIM, SUN_ELEV)
    cd = bpy.data.cameras.new('PANO')
    cd.type = 'PANO'
    if hasattr(cd, 'panorama_type'):
        cd.panorama_type = 'EQUIRECTANGULAR'
    else:
        cd.cycles.panorama_type = 'EQUIRECTANGULAR'
    cd.clip_start = 50
    cd.clip_end = 60000
    cam = bpy.data.objects.new('PANO', cd)
    cam.location = EYE
    cam.rotation_euler = (math.pi / 2, 0, -math.pi / 2)   # looking along +X (equirect centre)
    sc.collection.objects.link(cam)
    sc.camera = cam
    sc.render.resolution_x, sc.render.resolution_y = RES, RES // 2
    sc.render.resolution_percentage = 100
    sc.cycles.samples = SAMPLES
    sc.cycles.use_denoising = True
    sc.cycles.volume_step_rate = 4.0
    sc.cycles.volume_max_steps = 256
    sc.cycles.max_bounces = 6
    sc.cycles.volume_bounces = 2
    sc.view_settings.view_transform = 'Standard'
    sc.render.image_settings.file_format = 'OPEN_EXR'
    sc.render.image_settings.color_depth = '32'
    out = os.path.join(WORK, 'vista.blend')
    bpy.ops.wm.save_as_mainfile(filepath=out, compress=False)
    print('saved', out, flush=True)
    if '--render' in argv:
        sc.render.filepath = os.path.join(WORK, 'vista_sunset.exr')
        bpy.ops.render.render(write_still=True)
        print('rendered', sc.render.filepath, flush=True)
        # float panorama for encode.py (rows bottom-up, u = 0.5 - phi / 2pi: the world-equirect convention,
        # verified with beacons, so no roll is needed)
        im = bpy.data.images.load(sc.render.filepath)
        w, h = im.size
        px = np.empty(w * h * 4, np.float32)
        im.pixels.foreach_get(px)
        np.save(os.path.join(WORK, 'vista_sunset.npy'), px.reshape(h, w, 4)[..., :3])
        print('saved npy', flush=True)


main()
