"""Rocks in snow: re-grade scanned boulders to cold alpine granite, and give each a real snow cap.

The cap is modelled, not painted: fused metaball snow laid over the rock's upward faces, thickest on the
flattest tops, so it overhangs a little at the edges the way a settled cap does.
"""
import bpy, bmesh, math, random
import numpy as np
from mathutils import Vector
from . import snowmats as SM


def regrade(mat, sat=0.22, val=0.82, hue=0.5, cool=(0.93, 0.97, 1.04)):
    """Insert a hue/saturation step (and a cool tint) after whatever feeds the Principled base colour."""
    nt = mat.node_tree
    p = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if p is None or not p.inputs['Base Color'].links:
        return
    src = p.inputs['Base Color'].links[0].from_socket
    hsv = nt.nodes.new('ShaderNodeHueSaturation')
    hsv.inputs['Hue'].default_value = hue
    hsv.inputs['Saturation'].default_value = sat
    hsv.inputs['Value'].default_value = val
    mul = nt.nodes.new('ShaderNodeMix')
    mul.data_type = 'RGBA'
    mul.blend_type = 'MULTIPLY'
    mul.inputs[0].default_value = 1.0
    mul.inputs[7].default_value = (*cool, 1.0)
    nt.links.new(src, hsv.inputs['Color'])
    nt.links.new(hsv.outputs[0], mul.inputs[6])
    nt.links.new(mul.outputs[2], p.inputs['Base Color'])


def snow_cap(ob, coll, seed=1, depth=0.12, min_nz=0.42, spacing=0.12, mat=None):
    """Fused snow over the upward faces of `ob` (world space as it stands). Returns the cap object."""
    R = random.Random(seed)
    me = ob.data
    mw = ob.matrix_world
    nmat = mw.to_3x3().inverted().transposed()
    cands = []
    for p in me.polygons:
        n = (nmat @ p.normal).normalized()
        if n.z < min_nz:
            continue
        c = mw @ p.center
        a = p.area * mw.to_scale().x * mw.to_scale().y
        cands.append((c, n, a))
    if not cands:
        return None
    areas = np.array([c[2] for c in cands])
    total = areas.sum()
    count = int(min(900, max(6, total / (spacing * spacing))))
    pick = np.random.default_rng(seed).choice(len(cands), size=count, p=areas / total)
    mb = bpy.data.metaballs.new(ob.name + '_cap')
    # not finer than the bake keeps: a cap meshed at 1.5 cm came out at tens of thousands of triangles and the
    # atlas bake's decimation (to a few hundred) shredded it into gaps and loose slivers
    mb.resolution = mb.render_resolution = max(0.03, spacing * 0.5)
    mb.threshold = 0.9
    for k in pick:
        c, n, _ = cands[k]
        flat = (n.z - min_nz) / (1 - min_nz)
        thick = depth * (0.15 + 0.85 * flat ** 0.7) * R.uniform(0.85, 1.1)
        e = mb.elements.new(type='ELLIPSOID')
        e.co = c + Vector((0, 0, thick * 0.2))
        e.radius = spacing * 2.4
        e.stiffness = 2.0
        e.size_x = e.size_y = 1.0
        e.size_z = max(0.2, thick / (spacing * 2.4))
    mo = bpy.data.objects.new(ob.name + '_capmb', mb)
    # evaluate in the scene root: metaballs in a hidden collection evaluate to nothing
    bpy.context.scene.collection.objects.link(mo)
    dg = bpy.context.evaluated_depsgraph_get()
    dg.update()
    cm = bpy.data.meshes.new_from_object(mo.evaluated_get(dg))
    bpy.data.objects.remove(mo)
    bpy.data.metaballs.remove(mb)
    # Snow lies in continuous caps; a lone up-facing facet on a steep side only seeds a ball or two, which
    # read as polka dots. Drop every island much smaller than the main cap.
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(cm)
    seen, islands = set(), []
    for f in bm.faces:
        if f.index in seen:
            continue
        stack, isl = [f], []
        seen.add(f.index)
        while stack:
            g = stack.pop()
            isl.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in seen:
                        seen.add(h.index)
                        stack.append(h)
        islands.append((sum(g.calc_area() for g in isl), isl))
    if islands:
        biggest = max(a for a, _ in islands)
        drop = [g for a, isl in islands if a < max(0.12 * biggest, (spacing * 6) ** 2) for g in isl]
        bmesh.ops.delete(bm, geom=drop, context='FACES')
        bm.to_mesh(cm)
    bm.free()
    for p in cm.polygons:
        p.use_smooth = True
    cm.materials.append(mat or snow_cap_material())
    cap = bpy.data.objects.new(ob.name + '_snowcap', cm)
    coll.objects.link(cap)
    return cap


_cap_mat = None


def snow_cap_material():
    global _cap_mat
    if _cap_mat is None:
        from .nodes import NB
        m = SM.new('snow_cap')
        nb = NB(m)
        pos = nb.pos()
        h = nb.math('ADD', nb.noise(pos, 14.0, detail=6.0, rough=0.62), nb.math('MULTIPLY', nb.noise(pos, 70.0, detail=2.0), 0.35))
        nb.link(SM.snow_shader(nb, normal=nb.bump(h, strength=0.4, dist=0.008)), nb.out.inputs['Surface'])
        _cap_mat = m
    return _cap_mat
