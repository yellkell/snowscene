"""Cycles review stills: blender -b <scene>.blend --python art/scripts/render.py -- CAM_a CAM_b [--samples 128] [--res 1280x720] [--tag x]"""
import bpy, sys, os

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
opt = lambda n, d: argv[argv.index(n) + 1] if n in argv else d
cams = [a for i, a in enumerate(argv) if a.startswith('CAM_') and (i == 0 or not argv[i - 1].startswith('--'))]
samples = int(opt('--samples', 128))
w, h = map(int, opt('--res', '1280x720').split('x'))
tag = opt('--tag', '')
sc = bpy.context.scene
prefs = bpy.context.preferences.addons['cycles'].preferences
prefs.compute_device_type = 'OPTIX'
prefs.get_devices()
for d in prefs.devices:
    d.use = d.type == 'OPTIX'
sc.render.engine = 'CYCLES'
sc.cycles.device = 'GPU'
sc.cycles.samples = samples
sc.cycles.use_denoising = True
sc.cycles.denoiser = 'OPTIX'
sc.cycles.max_bounces = 8
sc.cycles.transparent_max_bounces = 24
sc.cycles.sample_clamp_indirect = 8.0
sc.render.resolution_x, sc.render.resolution_y = w, h
sc.render.resolution_percentage = 100
sc.render.image_settings.file_format = 'PNG'
out = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'art', 'renders')
os.makedirs(out, exist_ok=True)
base = os.path.splitext(os.path.basename(bpy.data.filepath))[0]
for c in cams or [sc.camera.name]:
    sc.camera = bpy.data.objects[c]
    sc.render.filepath = os.path.join(out, f'{base}_{c[4:]}{tag}.png')
    bpy.ops.render.render(write_still=True)
    print('wrote', sc.render.filepath, flush=True)
