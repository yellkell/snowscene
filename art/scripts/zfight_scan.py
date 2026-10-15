"""Find z-fighting in a baked GLB: faces of *different* pieces lying in the same plane, facing the same
way, overlapping. Those flicker in the headset (the depth test flips between them frame to frame).

    blender -b -P art/scripts/zfight_scan.py -- public/cave/works.glb [more.glb ...]

A piece is a welded loose part (a beam, a rail, a board). Faces are bucketed by plane (normal to 0.5 deg,
offset to 0.3 mm); within a bucket, faces of different pieces whose projections overlap (a triangle's
centroid inside another's, either way) are reported, clustered by place (game coordinates: x, y up, z).
"""
import bpy, bmesh, math, sys, os
from collections import defaultdict
from mathutils import Vector
from mathutils.geometry import intersect_point_tri_2d

PLANE_D = 0.0003      # m: faces closer than this in offset are "the same plane"
ANG = 0.008           # normal quantisation (~0.5 deg)


def load(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path, merge_vertices=True)
    objs = [o for o in bpy.data.objects if o not in before and o.type == 'MESH']
    bm = bmesh.new()
    for o in objs:
        tmp = bmesh.new()
        tmp.from_mesh(o.data)
        tmp.transform(o.matrix_world)
        me = bpy.data.meshes.new('t')
        tmp.to_mesh(me)
        tmp.free()
        bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bm.faces.ensure_lookup_table()
    return bm


def pieces(bm):
    part = {}
    k = 0
    for f in bm.faces:
        if f.index in part:
            continue
        stack = [f]
        part[f.index] = k
        while stack:
            g = stack.pop()
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in part:
                        part[h.index] = k
                        stack.append(h)
        k += 1
    return part, k


def scan(path):
    bm = load(path)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.faces.ensure_lookup_table()
    part, npart = pieces(bm)
    buckets = defaultdict(list)
    for f in bm.faces:
        if f.calc_area() < 1e-7:
            continue
        n = f.normal
        d = n.dot(f.verts[0].co)
        key = (round(n.x / ANG), round(n.y / ANG), round(n.z / ANG), round(d / PLANE_D))
        buckets[key].append(f)
    hits = []
    for key, fs in buckets.items():
        if len({part[f.index] for f in fs}) < 2:
            continue
        n = fs[0].normal
        # a 2D frame in the plane
        u = n.orthogonal().normalized()
        v = n.cross(u)
        tri2 = [[Vector((p.co.dot(u), p.co.dot(v))) for p in f.verts] for f in fs]
        cen = [sum(t, Vector((0, 0))) / 3 for t in tri2]
        for i in range(len(fs)):
            for j in range(i + 1, len(fs)):
                if part[fs[i].index] == part[fs[j].index]:
                    continue
                if intersect_point_tri_2d(cen[i], *tri2[j]) or intersect_point_tri_2d(cen[j], *tri2[i]):
                    c = fs[i].calc_center_median()
                    hits.append((c, fs[i].calc_area() + fs[j].calc_area()))
    # cluster by 0.5 m cells, in game coordinates (Blender x, z, -y)
    cells = defaultdict(lambda: [0, 0.0, None])
    for c, a in hits:
        k = (math.floor(c.x / 0.5), math.floor(c.z / 0.5), math.floor(-c.y / 0.5))
        cells[k][0] += 1
        cells[k][1] += a
        cells[k][2] = (round(c.x, 2), round(c.z, 2), round(-c.y, 2))
    print(f'[zf] {os.path.basename(path)}: {npart} pieces, {len(hits)} overlapping coplanar pairs in {len(cells)} places', flush=True)
    for k, (cnt, area, at) in sorted(cells.items(), key=lambda kv: -kv[1][1])[:25]:
        print(f'[zf]   at {at}: {cnt} pairs, {area * 1e4:.0f} cm2', flush=True)
    bm.free()


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:]
    for p in argv:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        scan(p)
