"""Close-up QA of timber joints: blender -b <cave>.blend --python art/scripts/joint_review.py -- <dump.json> <out.png> [n]

Renders a contact sheet of n joints (from cave_build.py's JOINERY_DUMP), each from about a metre away on a
clear line of sight, lit by a fill light at the camera so the join itself is readable.
"""
import bpy, sys, os, json, math, random
import numpy as np
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from lib import bakekit as BK  # noqa: E402

argv = sys.argv[sys.argv.index('--') + 1:]
dump, out = argv[0], argv[1]
N = int(argv[2]) if len(argv) > 2 else 12
J = json.load(open(dump))
R = random.Random(5)
# prefer joints the solver actually closed, spread over the groups
by_group = {}
for j in J:
    by_group.setdefault(j['group'], []).append(j)
picks = []
groups = sorted(by_group, key=lambda g: -len(by_group[g]))
while len(picks) < N and any(by_group.values()):
    for g in groups:
        lst = [j for j in by_group[g] if j['ext'] > 0.01] or by_group[g]
        if lst and len(picks) < N:
            j = R.choice(lst)
            by_group[g].remove(j)
            picks.append(j)

sc = bpy.context.scene
BK.gpu(sc)
sc.cycles.samples = 48
sc.cycles.use_denoising = True
sc.render.resolution_x, sc.render.resolution_y = 480, 320
cam = bpy.data.objects.new('QA_CAM', bpy.data.cameras.new('QA_CAM'))
sc.collection.objects.link(cam)
cam.data.lens = 30
sc.camera = cam
lamp = bpy.data.objects.new('QA_FILL', bpy.data.lights.new('QA_FILL', 'POINT'))
lamp.data.energy = float(os.environ.get("QA_FILL", "0"))
lamp.data.shadow_soft_size = 0.4
sc.collection.objects.link(lamp)
dg = bpy.context.evaluated_depsgraph_get()
tiles = []
for k, j in enumerate(picks):
    ob = bpy.data.objects.get(j['group'])
    mw = ob.matrix_world if ob else None
    P = (mw @ Vector(j['p'])) if mw else Vector(j['p'])
    d = Vector(j['d'])
    if mw:
        d = (mw.to_3x3() @ d).normalized()
    side = d.cross(Vector((0, 0, 1)))
    if side.length < 0.1:
        side = d.cross(Vector((1, 0, 0)))
    side.normalize()
    cand = [(side * 0.9 + Vector((0, 0, 0.35)) - d * 0.3), (-side * 0.9 + Vector((0, 0, 0.35)) - d * 0.3),
            (side * 0.7 - Vector((0, 0, 0.5))), (-side * 0.7 - Vector((0, 0, 0.5))), (-d * 1.0 + Vector((0, 0, 0.4)))]
    pos = None
    for c in cand:
        q = P + c
        hit, *_ = sc.ray_cast(dg, P + c.normalized() * 0.12, c.normalized(), distance=c.length)
        if not hit:
            pos = q
            break
    pos = pos or P + cand[0]
    cam.location = pos
    cam.rotation_euler = (P - pos).to_track_quat('-Z', 'Y').to_euler()
    lamp.location = P + (pos - P) * 0.5 + Vector((0, 0, 1.2)) + side * 0.6   # raking, off the view axis
    path = os.path.join(os.path.dirname(out), f'_qa_{k}.png')
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    tiles.append((path, j))
    print('QA', k, j['group'], round(j['ext'], 3), flush=True)

# contact sheet (Blender's own image API: no PIL inside Blender)
cols = 4
rows = math.ceil(len(tiles) / cols)
W, H = 480, 320
sheet = np.zeros((rows * H, cols * W, 4), np.float32)
for i, (p, j) in enumerate(tiles):
    im = bpy.data.images.load(p)
    a = np.array(im.pixels[:], np.float32).reshape(H, W, 4)
    r, c = i // cols, i % cols
    sheet[(rows - 1 - r) * H:(rows - r) * H, c * W:(c + 1) * W] = a
    bpy.data.images.remove(im)
    os.remove(p)
img = bpy.data.images.new('qa_sheet', cols * W, rows * H, alpha=True)
img.pixels.foreach_set(sheet.ravel())
img.filepath_raw = out
img.file_format = 'PNG'
img.save()
print('sheet', out, flush=True)
