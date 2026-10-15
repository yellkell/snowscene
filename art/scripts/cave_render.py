"""Cycles look-dev stills of the ice mine.

    blender -b art/work/cave.blend --python art/scripts/cave_render.py -- [--cams jetty,loft] [--w 960] [--samples 96]
                                                                         [--beacon 0|1] [--machines 1] [--tag x]
Writes art/renders/cave_<cam>[_tag].png.
"""
import bpy, sys, os

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from lib import bakekit as BK, cavemats as CM  # noqa: E402

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
opt = lambda n, d: argv[argv.index(n) + 1] if n in argv else d
CAMS = opt('--cams', 'jetty,loft,wingrack,chimney,beacon').split(',')
W = int(opt('--w', 960))
SAMPLES = int(opt('--samples', 96))
BEACON = opt('--beacon', '0') == '1'
TAG = opt('--tag', '')
EXPO = float(opt('--exposure', 'nan'))
ART = os.path.dirname(HERE)
OUT = os.path.join(ART, 'renders')

sc = bpy.context.scene
BK.gpu(sc)
sc.cycles.samples = SAMPLES
sc.cycles.use_denoising = True
sc.cycles.max_bounces = 6
sc.render.resolution_x = W
sc.render.resolution_y = W * 9 // 16
sc.render.resolution_percentage = 100
sc.render.image_settings.file_format = 'PNG'
if EXPO == EXPO:
    sc.view_settings.exposure = EXPO

# re-register the emitters (they live in node trees; rebuild the channel table from the materials)
def emitters():
    out = {'day': [], 'lantern': [], 'beacon': []}
    for m in bpy.data.materials:
        if not m.node_tree:
            continue
        for n in m.node_tree.nodes:
            if n.type == 'EMISSION' and not n.inputs['Strength'].is_linked:
                ch = 'beacon' if 'beacon' in m.name or 'coals' in m.name else 'lantern'
                out[ch].append(n.inputs['Strength'])
    return out


em = emitters()
for ch, socks in em.items():
    for s in socks:
        if ch == 'beacon' and not BEACON:
            s.default_value = 0.0
for o in bpy.data.objects:
    if o.type == 'LIGHT' and o.get('channel') == 'beacon':
        o.hide_render = not BEACON
# coals glow in the beacon channel
for m in bpy.data.materials:
    if m.name == 'cave_coals' and m.node_tree:
        for n in m.node_tree.nodes:
            if n.type == 'EMISSION':
                n.inputs['Strength'].default_value = 30.0 if BEACON else 0.0

for cam in CAMS:
    ob = bpy.data.objects.get('CAM_' + cam)
    if ob is None:
        print('no camera', cam)
        continue
    sc.camera = ob
    sc.render.filepath = os.path.join(OUT, f'cave_{cam}{"_" + TAG if TAG else ""}.png')
    bpy.ops.render.render(write_still=True)
    BK.log('rendered', sc.render.filepath)
