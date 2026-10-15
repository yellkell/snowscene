"""Chunks and distance LODs for the atlas-baked layers, for Quest 3 (no re-bake: the atlas UVs carry over).

    blender -b -P art/scripts/lod_build.py [-- tutorial/props cave/debris ...]

Each baked layer is one mesh, so the headset draws all of it from anywhere (frustum culling is per
object). This splits it on a ground grid into chunks the frustum can drop, and gives each chunk a
simplified stand-in for distance:
  - faces are grouped into whole parts first (a boulder, a sign): vertices that share a position belong
    together, so a rock goes to one chunk and is never cut; a part bigger than the cell (the wall, the
    rim's sheets) is split face by face instead;
  - each chunk is exported exactly as baked (node c<k>_l0). Its distance stand-in is made at load time
(baked/lod.ts): meshoptimizer simplifies the decoded chunk into a second index buffer over the same
vertices, sliding UV seams together and locking the chunk's open border, within an error that stays
under ~1.5 Quest pixels at `switch` metres. (Blender's decimate can't: welded, it drags faces across
atlas islands; with the seams locked, per-piece unwraps barely decimate at all.)
Writes public/<dir>/<name>_lod.glb and merges {name: {mesh, switch, ratio}} into public/<dir>/lod.json,
which the runtime reads (optional: without it the single mesh is used). `ratio`: the stand-in's floor.
"""
import bpy, bmesh, json, math, os, sys, time
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PUB = os.path.join(ROOT, 'public')

# dir/name: cell (m, on the ground plane), stand-in floor ratio (None: no stand-in), switch distance (m, to the
# chunk's bounding sphere)
JOBS = {
    'tutorial/props': dict(cell=40, ratio=0.22, switch=45),
    # the rim is a ring round the bowl (centre game (0, -10) = Blender (0, 10)): pie slices, not squares
    'tutorial/rim': dict(cell=0, sectors=14, centre=(0.0, 10.0), ratio=None, switch=0),
    'tutorial/bands': dict(cell=36, ratio=0.4, switch=90),
    'tutorial/wall': dict(cell=20, ratio=0.4, switch=70),
    'tutorial/bluff': dict(cell=28, ratio=0.4, switch=80),
    'tutorial/hut': dict(cell=0, ratio=0.2, switch=55),
    'tutorial/party': dict(cell=0, ratio=0.3, switch=70),
    'cave/debris': dict(cell=10, ratio=0.3, switch=10),
    'cave/works': dict(cell=10, ratio=0.5, switch=14),
    'cave/shell': dict(cell=14, ratio=0.45, switch=16),
    'survivors/props': dict(cell=45, ratio=0.3, switch=45),
}


def log(*a):
    print('[lod]', *a, flush=True)


def clear():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_glb(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path, merge_vertices=False)
    objs = [o for o in bpy.data.objects if o not in before and o.type == 'MESH']
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return o


def cell_of_faces(o, cell):
    """Per face: its chunk key. Whole parts (welded by shared position) go to their centre's cell."""
    me = o.data
    n = len(me.vertices)
    co = [v.co.copy() for v in me.vertices]
    # union-find over vertices: by shared position, and by the faces themselves
    parent = list(range(n))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    seen = {}
    for i, c in enumerate(co):
        k = (round(c.x * 2e4), round(c.y * 2e4), round(c.z * 2e4))
        j = seen.get(k)
        if j is None:
            seen[k] = i
        else:
            union(i, j)
    for p in me.polygons:
        vs = p.vertices
        for a in vs[1:]:
            union(vs[0], a)
    lo = {}
    hi = {}
    for i, c in enumerate(co):
        r = find(i)
        if r in lo:
            l, h = lo[r], hi[r]
            l[0] = min(l[0], c.x); l[1] = min(l[1], c.y)
            h[0] = max(h[0], c.x); h[1] = max(h[1], c.y)
        else:
            lo[r] = [c.x, c.y]
            hi[r] = [c.x, c.y]
    key = lambda x, y: (math.floor(x / cell), math.floor(y / cell))
    out = []
    big = 0
    for p in me.polygons:
        r = find(p.vertices[0])
        l, h = lo[r], hi[r]
        if max(h[0] - l[0], h[1] - l[1]) > cell * 0.75:
            c = p.center
            out.append(key(c.x, c.y))
            big += 1
        else:
            out.append(key((l[0] + h[0]) / 2, (l[1] + h[1]) / 2))
    log(f'  {len(set(find(i) for i in range(n)))} parts, {big} faces split by face')
    return out


def extract(o, faces, name):
    """A new object holding only `faces` (indices into o's polygons)."""
    keep = set(faces)
    me = o.data.copy()
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.index not in keep], context='FACES')
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def tris(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


def export(objs, path, colors):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=True,
                              export_texcoords=True, export_normals=True, export_materials='NONE',
                              export_vertex_color='ACTIVE' if colors else 'NONE', export_attributes=False,
                              export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=7,
                              export_draco_position_quantization=14, export_draco_normal_quantization=10,
                              export_draco_texcoord_quantization=12, export_draco_color_quantization=10,
                              export_yup=True, export_extras=False)


def mesh_file(d, name):
    """The layer's GLB as its manifest names it."""
    man = json.load(open(os.path.join(PUB, d, 'manifest.json')))
    if d == 'tutorial':
        return man['atlases'][name]['mesh']
    if d == 'survivors':
        return man[name]['mesh']
    return man[name]['mesh']


def run(job, cfg):
    d, name = job.split('/')
    t0 = time.time()
    clear()
    src = os.path.join(PUB, d, mesh_file(d, name))
    o = import_glb(src)
    colors = len(o.data.color_attributes) > 0
    total = tris(o)
    log(job, f'{total} tris, uv maps {[u.name for u in o.data.uv_layers]}, colors {colors}')
    if cfg.get('sectors'):
        cx, cy = cfg['centre']
        n = cfg['sectors']
        keys = [math.floor((math.atan2(p.center.y - cy, p.center.x - cx) + math.pi) / math.tau * n) % n for p in o.data.polygons]
        groups = defaultdict(list)
        for i, k in enumerate(keys):
            groups[k].append(i)
    elif cfg['cell']:
        keys = cell_of_faces(o, cfg['cell'])
        groups = defaultdict(list)
        for i, k in enumerate(keys):
            groups[k].append(i)
    else:
        groups = {(0, 0): list(range(len(o.data.polygons)))}
    out = []
    for idx, (k, faces) in enumerate(sorted(groups.items())):
        l0 = extract(o, faces, f'c{idx}_l0') if len(groups) > 1 else o
        l0.name = f'c{idx}_l0'
        out.append(l0)
    if len(groups) > 1:
        bpy.data.objects.remove(o)
    file = f'{name}_lod.glb'
    export(out, os.path.join(PUB, d, file), colors)
    lj = os.path.join(PUB, d, 'lod.json')
    meta = json.load(open(lj)) if os.path.exists(lj) else {}
    meta[name] = {'mesh': file, 'switch': cfg['switch'], 'ratio': cfg['ratio'], 'chunks': len(groups), 'tris': total}
    json.dump(meta, open(lj, 'w'), indent=1)
    log(f'  -> {file}: {len(groups)} chunks, {os.path.getsize(os.path.join(PUB, d, file)) // 1024} KB, {time.time() - t0:.0f}s')


def figure_far(k):
    """A dancer's stand-in for distance: body and both arms (hanging, at the shoulder pivots) as one mesh,
    so a far partygoer is one draw, not three (gear/figure<k>_far.glb; the runtime simplifies it)."""
    clear()
    gear = os.path.join(PUB, 'gear')
    man = json.load(open(os.path.join(gear, 'manifest.json')))
    parts = []
    for part, dx in (('body', 0.0), ('larm', -0.235), ('rarm', 0.235)):
        o = import_glb(os.path.join(gear, man[f'figure{k}_{part}']['mesh']))
        # pilot/game space (x, y up, z) is Blender (x, -z, y): the pivot is at game (dx, 1.42, 0)
        o.location = (dx, 0.0, 1.42) if part != 'body' else (0, 0, 0)
        bpy.ops.object.transform_apply(location=True)
        parts.append(o)
    bpy.ops.object.select_all(action='DESELECT')
    for o in parts:
        o.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    whole = bpy.context.view_layer.objects.active
    far = whole
    far.name = f'figure{k}_far'
    file = f'figure{k}_far.glb'
    export([far], os.path.join(gear, file), len(far.data.color_attributes) > 0)
    body = man[f'figure{k}_body']
    man[f'figure{k}_far'] = {'mesh': file, 'albedo': body['albedo'], 'orm': body['orm'], 'tris': tris(far)}
    json.dump(man, open(os.path.join(gear, 'manifest.json'), 'w'), indent=1)
    log(f'figure{k}: {tris(far)} tris')


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    for job in (argv or [*JOBS, 'figures']):
        if job == 'figures':
            for k in range(6):
                figure_far(k)
        else:
            run(job, JOBS[job])
