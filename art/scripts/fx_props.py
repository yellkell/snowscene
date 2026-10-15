"""Solid things for the Snow Survivors FX: modelled, baked, exported, and look-dev stills.

  blender -b --factory-startup --python art/scripts/fx_props.py -- <what> [<what> ...]

  scorch   melted, sooty snow where fire has burned: a top-down render of the burned snow over the
           clean snow -> a multiply decal (art/work/fx/scorch.npy, packed by fx_pack.py misc)
  chest    weathered plank chest with forged iron straps, snow on the lid: body + lid (hinged) ->
           public/survivors/fx/chest.glb, albedo*AO atlas art/work/fx/chest_albedo.npy
  rock     boulder_01 scan, frosted, decimated -> public/survivors/fx/rock.glb + albedo/normal npy
  blade    a forged sword (blade along +Z from the guard, 1.06 long) -> blade.glb + albedo npy
  gem      the experience crystal and the upgrade crystal -> gem.glb, orb.glb (geometry only)
  lookdev  Cycles stills of the baked, low-poly results in the snowfield (art/renders/fx_*.png)

Runtime vertex colour (COLOR_0) on chest/blade: R = metal mask, G = roughness.
"""
import bpy, bmesh, os, sys, math, json, random
import numpy as np
from mathutils import Vector, Matrix

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import fxkit as FX, core, snowmats as SM, bakekit as BK, rocks, sky as SKY
from lib.nodes import NB

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = os.path.join(FX.ROOT, 'public', 'survivors', 'fx')
os.makedirs(OUT, exist_ok=True)


def save(name, arr):
    np.save(os.path.join(FX.WORK, name + '.npy'), arr.astype(np.float32))


def export_glb(objs, path, colors=False):
    BK.select_only(objs[0], objs[1:])
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=True,
                              export_texcoords=True, export_normals=True, export_materials='NONE',
                              export_vertex_color='ACTIVE' if colors else 'NONE', export_attributes=False,
                              export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=7,
                              export_draco_position_quantization=14, export_draco_normal_quantization=10,
                              export_draco_texcoord_quantization=12, export_draco_color_quantization=8,
                              export_yup=True, export_extras=False)
    print('exported', path, os.path.getsize(path), flush=True)


def tris(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


def unwrap(o, margin=0.01, angle=60):
    me = o.data
    uv = me.uv_layers.get('BakeUV') or me.uv_layers.new(name='BakeUV')
    me.uv_layers.active = uv
    BK.select_only(o)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(angle), island_margin=margin, area_weight=0.0)
    bpy.ops.object.mode_set(mode='OBJECT')
    return uv


def keep_only_uv(o, name='BakeUV'):
    me = o.data
    for nm in [l.name for l in me.uv_layers]:
        if nm != name and nm in me.uv_layers:
            me.uv_layers.remove(me.uv_layers[nm])


def bake_albedo_ao(o, w, h, samples=64, ao=True):
    # A metal has no diffuse colour, so its base colour would bake black: bake everything as a dielectric.
    for m in o.data.materials:
        for n in m.node_tree.nodes:
            if n.type == 'BSDF_PRINCIPLED':
                for l in list(n.inputs['Metallic'].links):
                    m.node_tree.links.remove(l)
                n.inputs['Metallic'].default_value = 0.0
    alb = bpy.data.images.new(o.name + '_alb', w, h, float_buffer=True)
    BK.bake(o, alb, 'DIFFUSE', {'COLOR'}, 4, margin=8, uv='BakeUV', keep_materials=True)
    a = BK.pixels(alb)[..., :3]
    if ao:
        img = bpy.data.images.new(o.name + '_ao', w, h, float_buffer=True)
        BK.bake(o, img, 'AO', None, samples, margin=8, uv='BakeUV', keep_materials=True)
        a = np.concatenate([a, BK.pixels(img)[..., :1]], -1)
    return a


def metal_colors(o, iron_mats, rough=None):
    """COLOR_0: R = metal (faces of the iron materials), G = roughness."""
    me = o.data
    ca = me.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER')  # linear: no sRGB conversion on export
    names = [m.name for m in me.materials]
    cols = np.zeros((len(me.loops), 4), np.float32)
    for p in me.polygons:
        mname = names[p.material_index] if p.material_index < len(names) else ''
        metal = 1.0 if mname in iron_mats else 0.0
        r = (rough or {}).get(mname, 0.8)
        for li in p.loop_indices:
            cols[li] = (metal, r, 0, 1)
    ca.data.foreach_set('color', cols.ravel())
    me.color_attributes.active_color = ca


# ------------------------------------------------------------------ materials
def iron_mat(name='iron'):
    m = SM.new(name)
    nb = NB(m)
    pos = nb.pos()
    rust = nb.mrange(nb.noise(pos, 9.0, detail=8.0, rough=0.65), 0.5, 0.68, 0.0, 1.0)
    pit = nb.noise(pos, 80.0, detail=3.0)
    base = nb.mix(nb.mrange(pit, 0.3, 0.7, 0.0, 1.0), (0.035, 0.034, 0.033), (0.075, 0.07, 0.066))
    col = nb.mix(rust, base, (0.2, 0.085, 0.035))
    rough = nb.mixf(rust, 0.5, 0.92)
    metal = nb.mixf(rust, 0.85, 0.1)
    nb.bsdf(col, rough=rough, metal=metal, normal=nb.bump(pit, 0.25, 0.002))
    return m


def wood_mat(name='chest_wood'):
    m = SM.new(name)
    nb = NB(m)
    ts = SM.texset('weathered_brown_planks')
    vec = SM.metric_uv(nb, ts['size'], scale=1.04)
    d, r, a, n, h = SM.scan(nb, ts, vec, 1.0)
    # Old larch gone grey-brown in the weather.
    d = nb.hsv(d, 0.5, 0.95, 0.62)
    d = nb.mix(1.0, d, a, blend='MULTIPLY')
    p = nb.bsdf(d, rough=nb.math('ADD', nb.math('MULTIPLY', r, 0.3), 0.62), normal=n, out=False)
    nb.link(p.outputs[0], nb.out.inputs['Surface'])
    SM.snowify(m, threshold=0.78, softness=0.08, noise_scale=7.0, bias=-0.15)
    return m


# ------------------------------------------------------------------ scorch
def fbm(x, y, oct=5, seed=0):
    rng = np.random.default_rng(seed)
    out = np.zeros_like(x)
    amp, f = 0.5, 1.0
    for _ in range(oct):
        g = rng.random((64, 64)).astype(np.float32)
        xi, yi = x * f, y * f
        i0 = np.floor(xi).astype(int)
        j0 = np.floor(yi).astype(int)
        fx, fy = xi - i0, yi - j0
        fx, fy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
        a = g[i0 % 64, j0 % 64]
        b = g[(i0 + 1) % 64, j0 % 64]
        c = g[i0 % 64, (j0 + 1) % 64]
        d = g[(i0 + 1) % 64, (j0 + 1) % 64]
        out += amp * ((a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy)
        amp *= 0.5
        f *= 2.03
    return out


def scorch():
    FX.reset()
    sc = FX.gpu(samples=96, transparent=False)
    FX.world_gradient((1.0, 1.0, 1.0), (0.45, 0.45, 0.45), 1.0)
    objs = []
    for burned in (False, True):
        bm = bmesh.new()
        bmesh.ops.create_grid(bm, x_segments=260, y_segments=260, size=1.5)
        me = bpy.data.meshes.new('S' if burned else 'C')
        bm.to_mesh(me)
        bm.free()
        co = np.empty(len(me.vertices) * 3, np.float32)
        me.vertices.foreach_get('co', co)
        co = co.reshape(-1, 3)
        x, y = co[:, 0], co[:, 1]
        r = np.hypot(x, y)
        warp = fbm(x * 1.6 + 5, y * 1.6 + 5, 5, 1) - 0.5
        rr = r / 0.92 + warp * 0.55
        burn = np.clip((1.0 - rr) / 0.22, 0, 1)
        burn = burn * burn * (3 - 2 * burn)
        wet = np.clip((1.12 - rr) / 0.2, 0, 1)
        soot_n = fbm(x * 4 + 11, y * 4 + 3, 5, 2)
        soot = np.clip((soot_n - 0.42) / 0.16, 0, 1) * np.clip((0.95 - rr) / 0.4, 0, 1)
        melt = fbm(x * 7 + 2, y * 7 + 9, 4, 3)
        if burned:
            # Melted into a shallow bowl, the edge a crisp lip of wet crust.
            lip = np.exp(-((rr - 1.0) / 0.07) ** 2)
            co[:, 2] = -0.05 * burn * (0.7 + 0.6 * melt) + 0.012 * lip
            me.vertices.foreach_set('co', co.ravel())
            for nm, v in (('burn', burn), ('soot', soot), ('wet', wet)):
                at = me.attributes.new(nm, 'FLOAT', 'POINT')
                at.data.foreach_set('value', v.astype(np.float32))
        uv = me.uv_layers.new(name='UVMap')
        wuv = me.uv_layers.new(name='WorldUV')
        lv = np.empty(len(me.loops), np.int32)
        me.loops.foreach_get('vertex_index', lv)
        wuv.data.foreach_set('uv', co[lv, :2].ravel())
        uv.data.foreach_set('uv', co[lv, :2].ravel())
        me.polygons.foreach_set('use_smooth', np.ones(len(me.polygons), bool))
        ob = bpy.data.objects.new(me.name, me)
        sc.collection.objects.link(ob)
        mat = SM.snow_ground('snow_' + me.name, with_sparkle=False)
        if burned:
            nt = mat.node_tree
            out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
            src = out.inputs['Surface'].links[0].from_socket
            nb = NB.__new__(NB)
            nb.mat, nb.nt, nb.out = mat, nt, out
            b = nb.attr('burn')
            s = nb.attr('soot')
            w = nb.attr('wet')
            pos = nb.pos()
            grain = nb.noise(pos, 60.0, detail=4.0)
            # Slush: grey, glassy, the meltwater pooled darker in the bottom.
            slush = nb.bsdf(nb.mix(grain, (0.36, 0.39, 0.43), (0.5, 0.53, 0.57)), rough=0.22, sss=0.3, out=False)
            # Soot and charred litter: near-black, dry.
            sootb = nb.bsdf(nb.mix(grain, (0.022, 0.02, 0.018), (0.07, 0.062, 0.055)), rough=0.85, out=False)
            # Wet snow at the rim: soaked, a step darker than dry snow.
            wets = nb.bsdf((0.62, 0.66, 0.72), rough=0.35, sss=0.6, out=False)
            m1 = nb.n('ShaderNodeMixShader')
            nb.link(nb.math('MULTIPLY', w, 0.85), m1.inputs[0]); nb.link(src, m1.inputs[1]); nb.link(wets.outputs[0], m1.inputs[2])
            m2 = nb.n('ShaderNodeMixShader')
            nb.link(b, m2.inputs[0]); nb.link(m1.outputs[0], m2.inputs[1]); nb.link(slush.outputs[0], m2.inputs[2])
            m3 = nb.n('ShaderNodeMixShader')
            nb.link(nb.math('MULTIPLY', s, 0.92), m3.inputs[0]); nb.link(m2.outputs[0], m3.inputs[1]); nb.link(sootb.outputs[0], m3.inputs[2])
            nb.link(m3.outputs[0], out.inputs['Surface'])
        me.materials.append(mat)
        objs.append(ob)
    FX.ortho_cam((0, 0, 0), 3.0, 512, 512, direction=(0, 0, -1))
    res = []
    for k, ob in enumerate(objs):
        for o in objs:
            o.hide_render = o is not ob
        res.append(FX.render_np(f'scorch{k}')[..., :3])
    clean, burned = res
    ratio = burned / np.maximum(clean, 1e-4)
    save('scorch', ratio)
    print('scorch ratio range', float(ratio.min()), float(np.median(ratio)), flush=True)
    # A look-dev still: the burned snow at golden hour, perspective.
    FX.look_agx()
    meta = SKY.world('qwantani_sunset_puresky', -136.6, strength=1.0)
    SKY.sun_lamp(meta, -136.6, 7.0)
    objs[0].hide_render = True
    objs[1].hide_render = False
    FX.persp_cam((1.6, -2.2, 1.5), (0, 0, 0), lens=35, w=960, h=640)
    sc.cycles.samples = 64
    FX.render_png(os.path.join(FX.RENDERS, 'fx_scorch_lookdev.png'))


# ------------------------------------------------------------------ chest
W, D, HB, RL = 0.9, 0.6, 0.55, 0.3   # width (x), depth (y), body height, lid radius


def chest():
    FX.reset()
    core.seed(7)
    wood = wood_mat()
    iron = iron_mat()
    col = bpy.context.scene.collection
    body = core.Builder('ChestBody', col, smooth_angle=30)
    lid = core.Builder('ChestLid', col, smooth_angle=30)
    t = 0.022           # board thickness
    gap = 0.004
    nb_ = 4
    ph = (HB - 0.03) / nb_
    # Front and back boards, horizontal.
    for side in (-1, 1):
        y = side * (D / 2 - t / 2)
        for k in range(nb_):
            z0 = 0.03 + k * ph
            body.element()
            body.cbox((0, y, z0 + ph / 2), (W - 0.06, t, ph - gap), wood, bev=0.004, seg=1)
    # End boards.
    for side in (-1, 1):
        x = side * (W / 2 - t / 2)
        for k in range(nb_):
            z0 = 0.03 + k * ph
            body.element()
            body.cbox((x, 0, z0 + ph / 2), (t, D - 0.06, ph - gap), wood, bev=0.004, seg=1)
    # Corner posts and the floor and the skids it stands on.
    for sx in (-1, 1):
        for sy in (-1, 1):
            body.element()
            body.cbox((sx * (W / 2 - 0.028), sy * (D / 2 - 0.028), HB / 2 + 0.01), (0.056, 0.056, HB - 0.02), wood, bev=0.006)
    body.element()
    body.cbox((0, 0, 0.045), (W - 0.04, D - 0.04, 0.02), wood, bev=0.003)
    for sy in (-1, 1):
        body.element()
        body.cbox((0, sy * (D / 2 - 0.07), 0.015), (W - 0.02, 0.07, 0.03), wood, bev=0.006)
    # Iron: two straps round the body, rivets, corner brackets, the lock plate and side handles.
    it = 0.006
    for sx in (-0.27, 0.27):
        for sy in (-1, 1):
            body.cbox((sx, sy * (D / 2 + it / 2), HB / 2 + 0.005), (0.055, it, HB - 0.02), iron, bev=0.0015)
        body.cbox((sx, 0, 0.0 - it / 2 + 0.002), (0.055, D + 2 * it, it), iron, bev=0.0015)
        for sy in (-1, 1):
            for k in range(4):
                z = 0.07 + k * 0.13
                body.cyl((sx, sy * (D / 2 + it), z), (sx, sy * (D / 2 + it + 0.006), z), 0.008, iron, sides=6, r1=0.005)
    for sx in (-1, 1):
        for sy in (-1, 1):
            for z in (0.0, HB - 0.07):
                xx = sx * (W / 2 + it / 2)
                body.cbox((xx, sy * (D / 2 - 0.05), z + 0.04), (it, 0.1, 0.08), iron, bev=0.0015)
                body.cbox((sx * (W / 2 - 0.05), sy * (D / 2 + it / 2), z + 0.04), (0.1, it, 0.08), iron, bev=0.0015)
    body.cbox((0, -(D / 2 + it), HB - 0.09), (0.12, it * 1.6, 0.14), iron, bev=0.003)
    body.cbox((0, -(D / 2 + it * 2.2), HB - 0.11), (0.02, 0.004, 0.035), wood, bev=0.001)  # keyhole (dark)
    for sx in (-1, 1):
        x = sx * (W / 2 + it)
        body.cbox((x, 0, HB * 0.62), (it, 0.16, 0.05), iron, bev=0.002)
        pts = [(x + sx * (0.012 + 0.045 * math.sin(a)), -0.07 * math.cos(a), HB * 0.62 - 0.05 * math.sin(a) - 0.01)
               for a in np.linspace(0, math.pi, 10)]
        body.tube(pts, 0.009, iron, sides=6)
    # Lid: staves round a half barrel, end caps, straps over it, the hasp.
    hinge = Vector((0, D / 2, HB))
    nst = 7
    for k in range(nst):
        a0 = math.pi * k / nst
        a1 = math.pi * (k + 1) / nst
        am = (a0 + a1) / 2
        rmid = RL - t / 2
        c = Vector((0, -math.cos(am) * rmid, HB + math.sin(am) * rmid))
        chord = 2 * RL * math.sin((a1 - a0) / 2) - gap
        Rm = Matrix.Rotation(-(am - math.pi / 2), 3, 'X')
        lid.element()
        lid.cbox(c, (W - 0.03, chord, t), wood, bev=0.004, R_=Rm)
    for sx in (-1, 1):
        half = [(math.cos(a) * (RL - 0.004), math.sin(a) * (RL - 0.004)) for a in np.linspace(0, math.pi, 14)]
        # local x -> world y, local y -> world z, extrusion (local z) -> world x
        M = Matrix.Translation((sx * (W / 2 - 0.015) - 0.011, 0, HB)) @ Matrix(((0, 0, 1, 0), (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
        lid.element()
        lid.prism(half, 0.022, M, wood)
    for sx in (-0.27, 0.27):
        pts = [(sx, -math.cos(a) * (RL + it / 2), HB + math.sin(a) * (RL + it / 2)) for a in np.linspace(0, math.pi, 16)]
        lid.sweep(pts, [(-it / 2, -0.0275), (it / 2, -0.0275), (it / 2, 0.0275), (-it / 2, 0.0275)], iron, up=(1, 0, 0))
        for a in np.linspace(0.15, math.pi - 0.15, 6):
            p = Vector((sx, -math.cos(a) * (RL + it), HB + math.sin(a) * (RL + it)))
            n = Vector((0, -math.cos(a), math.sin(a)))
            lid.cyl(p, p + n * 0.006, 0.008, iron, sides=6, r1=0.005)
    # The hasp hangs over the lock plate.
    lid.cbox((0, -(RL + it * 1.2), HB + 0.02), (0.05, it, 0.12), iron, bev=0.002)
    lid.cbox((0, -(RL + it * 2.4), HB - 0.035), (0.03, it * 1.4, 0.03), iron, bev=0.002)
    bo = body.finish()
    lo = lid.finish()
    # The lid's origin on the hinge line (back edge, top of the body).
    lo.data.transform(Matrix.Translation(-hinge))
    lo.location = hinge
    for o in (bo, lo):
        o.modifiers.new('wn', 'WEIGHTED_NORMAL').keep_sharp = True
    print('chest tris body', tris(bo), 'lid', tris(lo), flush=True)
    sc = FX.gpu(samples=64, transparent=False)
    FX.world_color((1, 1, 1), 1.0)
    # Bake each to its own 512 half of a 1024x512 atlas.
    out = []
    for o in (bo, lo):
        unwrap(o, margin=0.012)
        out.append(bake_albedo_ao(o, 512, 512, samples=96))
    atlas = np.concatenate(out, axis=1)  # (512, 1024, 4) bottom-up
    save('chest_albedo', atlas)
    for o, off in ((bo, 0.0), (lo, 0.5)):
        uv = o.data.uv_layers['BakeUV']
        a = np.empty(len(uv.data) * 2, np.float32)
        uv.data.foreach_get('uv', a)
        a = a.reshape(-1, 2)
        a[:, 0] = a[:, 0] * 0.5 + off
        uv.data.foreach_set('uv', a.ravel())
        metal_colors(o, {'iron'}, {'iron': 0.5, 'chest_wood': 0.85})
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(FX.WORK, 'chest.blend'))
    for o in (bo, lo):
        keep_only_uv(o)
        o.data.materials.clear()
    export_glb([bo, lo], os.path.join(OUT, 'chest.glb'), colors=True)


# ------------------------------------------------------------------ rock
def rock():
    FX.reset()
    from lib.scene import import_model
    meshes = import_model('boulder_01')
    src = meshes[0]
    if len(meshes) > 1:
        BK.select_only(meshes[0], meshes[1:])
        bpy.ops.object.join()
        src = bpy.context.view_layer.objects.active
    for c in list(src.users_collection):
        c.objects.unlink(src)
    bpy.context.scene.collection.objects.link(src)
    bpy.context.view_layer.update()
    BK.select_only(src)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    co = np.array([v.co[:] for v in src.data.vertices])
    centre = (co.max(0) + co.min(0)) / 2
    size = (co.max(0) - co.min(0)).max()
    # Unit: ~0.62 m across, centred (the runtime scales it per throw).
    s = 0.62 / size
    src.data.transform(Matrix.Scale(s, 4) @ Matrix.Translation(-Vector(centre)))
    print('rock src tris', tris(src), 'size', size, flush=True)
    # Frost: rime and old snow caught in its hollows, clear ice glaze on the faces.
    mat = src.data.materials[0]
    rocks.regrade(mat, sat=0.3, val=0.62)
    nt = mat.node_tree
    out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
    srcs = out.inputs['Surface'].links[0].from_socket
    nb = NB.__new__(NB)
    nb.mat, nb.nt, nb.out = mat, nt, out
    pos = nb.pos()
    ao = nb.ao(0.05, 16)
    frost_n = nb.noise(pos, 22.0, detail=6.0, rough=0.6)
    frost = nb.math('MULTIPLY', nb.mrange(frost_n, 0.45, 0.6, 0.0, 1.0), nb.mrange(ao, 0.92, 0.6, 0.0, 0.9), clamp=True)
    rime = nb.bsdf((0.8, 0.84, 0.9), rough=0.6, sss=0.5, out=False)
    mx = nb.n('ShaderNodeMixShader')
    nb.link(frost, mx.inputs[0]); nb.link(srcs, mx.inputs[1]); nb.link(rime.outputs[0], mx.inputs[2])
    nb.link(mx.outputs[0], out.inputs['Surface'])
    low = bpy.data.objects.new('Rock', src.data.copy())
    bpy.context.scene.collection.objects.link(low)
    low.modifiers.new('weld', 'WELD').merge_threshold = 0.002
    dec = low.modifiers.new('dec', 'DECIMATE')
    dec.ratio = min(1.0, 640 / max(1, tris(src)))
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(low.evaluated_get(dg))
    low.modifiers.clear()
    low.data = me
    for p in me.polygons:
        p.use_smooth = True
    print('rock low tris', tris(low), flush=True)
    unwrap(low, margin=0.02, angle=66)
    sc = FX.gpu(samples=64, transparent=False)
    FX.world_color((1, 1, 1), 1.0)
    # Albedo and normals from the full scan onto the low mesh (a few thousand tris: selected-to-active is fine).
    src.hide_render = False
    alb = bpy.data.images.new('rock_alb', 512, 512, float_buffer=True)
    BK.bake(low, alb, 'DIFFUSE', {'COLOR'}, 4, margin=8, uv='BakeUV', high=[src], extrusion=0.03, maxdist=0.06)
    nrm = bpy.data.images.new('rock_nrm', 512, 512, float_buffer=True)
    BK.bake(low, nrm, 'NORMAL', None, 4, margin=8, uv='BakeUV', high=[src], extrusion=0.03, maxdist=0.06)
    aoi = bpy.data.images.new('rock_ao', 512, 512, float_buffer=True)
    BK.bake(low, aoi, 'AO', None, 96, margin=8, uv='BakeUV', high=[src], extrusion=0.03, maxdist=0.06)
    a = BK.pixels(alb)[..., :3]
    save('rock_albedo', np.concatenate([a, BK.pixels(aoi)[..., :1]], -1))
    save('rock_normal', BK.pixels(nrm)[..., :3])
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(FX.WORK, 'rock.blend'))
    keep_only_uv(low)
    low.data.materials.clear()
    export_glb([low], os.path.join(OUT, 'rock.glb'))


# ------------------------------------------------------------------ blade
def blade():
    FX.reset()
    col = bpy.context.scene.collection
    steel = SM.new('steel')
    nb = NB(steel)
    pos = nb.pos()
    hammer = nb.n('ShaderNodeTexVoronoi', feature='F1', ins={'Vector': pos, 'Scale': 60.0})
    marks = nb.mrange(hammer.outputs['Distance'], 0.0, 0.5, 0.0, 1.0)
    tone = nb.noise(pos, 14.0, detail=6.0, rough=0.6)
    c = nb.mix(nb.mrange(tone, 0.35, 0.65, 0.0, 1.0), (0.48, 0.49, 0.5), (0.66, 0.67, 0.68))
    nb.bsdf(c, rough=nb.mrange(tone, 0.3, 0.7, 0.18, 0.34), metal=1.0, normal=nb.bump(marks, 0.08, 0.001))
    darkiron = iron_mat('guard_iron')
    leather = SM.new('leather')
    nb = NB(leather)
    pos = nb.pos()
    x, y, z = nb.sep(pos)
    wrap = nb.math('SINE', nb.math('MULTIPLY', nb.math('ADD', z, nb.math('MULTIPLY', nb.math('ARCTAN2', y, x), 0.004)), 260.0))
    lc = nb.mix(nb.mrange(wrap, -1, 1, 0, 1), (0.05, 0.028, 0.016), (0.11, 0.065, 0.035))
    nb.bsdf(lc, rough=0.7, normal=nb.bump(wrap, 0.5, 0.002))
    b = core.Builder('Blade', col, smooth_angle=25)
    # Blade: a lenticular section with a fuller, from the guard (z=0.02) to the tip (z=1.06).
    L0, L1 = 0.02, 1.06
    n = 14
    rings = []
    for k in range(n + 1):
        f = k / n
        z = L0 + (L1 - L0) * f
        half = 0.036 * (1 - 0.35 * f) * (1 if f < 0.86 else max(0.0, (1 - f) / 0.14) ** 0.8)
        th = 0.009 * (1 - 0.6 * f) + 0.0015
        rings.append((z, max(half, 0.0005), th))
    prof = lambda hw, th: [(hw, 0), (hw * 0.55, th * 0.75), (0.0, th * 0.55), (-hw * 0.55, th * 0.75), (-hw, 0),
                           (-hw * 0.55, -th * 0.75), (0.0, -th * 0.55), (hw * 0.55, -th * 0.75)]
    verts = []
    for z, hw, th in rings:
        verts.append([b.bm.verts.new((px, py, z)) for px, py in prof(hw, th)])
    for k in range(n):
        for j in range(8):
            j2 = (j + 1) % 8
            b._face((verts[k][j], verts[k][j2], verts[k + 1][j2], verts[k + 1][j]), steel, smooth=False)
    b._face(list(reversed(verts[0])), steel)
    # Crossguard, slightly swept, grip, pommel.
    b.cbox((0, 0, 0.0), (0.24, 0.032, 0.03), darkiron, bev=0.006, seg=2)
    for sx in (-1, 1):
        b.lathe([(0.0, 0.0), (0.018, 0.006), (0.02, 0.016), (0.012, 0.03), (0.0, 0.034)], (sx * 0.12, 0, 0), (sx, 0, 0), darkiron, seg=8)
    b.lathe([(0.016, 0.0), (0.019, 0.04), (0.02, 0.08), (0.019, 0.12), (0.016, 0.16)], (0, 0, -0.015), (0, 0, -1), leather, seg=8)
    b.lathe([(0.0, 0.0), (0.02, 0.004), (0.03, 0.02), (0.027, 0.042), (0.0, 0.05)], (0, 0, -0.175), (0, 0, -1), darkiron, seg=10)
    bo = b.finish()
    print('blade tris', tris(bo), flush=True)
    FX.gpu(samples=64, transparent=False)
    FX.world_color((1, 1, 1), 1.0)
    unwrap(bo, margin=0.02, angle=50)
    a = bake_albedo_ao(bo, 256, 256, samples=64)
    save('blade_albedo', a)
    metal_colors(bo, {'steel', 'guard_iron'}, {'steel': 0.25, 'guard_iron': 0.5, 'leather': 0.75})
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(FX.WORK, 'blade.blend'))
    keep_only_uv(bo)
    bo.data.materials.clear()
    export_glb([bo], os.path.join(OUT, 'blade.glb'), colors=True)


# ------------------------------------------------------------------ crystals
def crystal_mesh(name, seed, n_cr, base_r, length, tilt):
    """A cluster of hexagonal quartz-like crystals: six-sided prisms with pyramidal terminations."""
    R = random.Random(seed)
    b = core.Builder(name, bpy.context.scene.collection, smooth_angle=5)
    mat = SM.new('gem')
    for k in range(n_cr):
        r = base_r * (1.0 if k == 0 else R.uniform(0.45, 0.7))
        L = length * (1.0 if k == 0 else R.uniform(0.45, 0.75))
        ax = Vector((0, 0, 1)) if k == 0 else Vector((R.uniform(-1, 1), R.uniform(-1, 1), 0)).normalized() * math.sin(tilt) + Vector((0, 0, math.cos(tilt)))
        ax.normalize()
        u, v = core.basis_from_dir(ax)
        base = -ax * (L * 0.45 if k == 0 else L * 0.15)
        ph = R.uniform(0, 1)
        ring0 = [base + (u * math.cos(2 * math.pi * (i + ph) / 6) + v * math.sin(2 * math.pi * (i + ph) / 6)) * r * R.uniform(0.85, 1.1) for i in range(6)]
        ring1 = [p + ax * L * 0.62 for p in ring0]
        tip = base + ax * L + (u * R.uniform(-0.2, 0.2) + v * R.uniform(-0.2, 0.2)) * r
        bot = base - ax * L * (0.28 if k == 0 else 0.05)
        v0 = [b.bm.verts.new(p) for p in ring0]
        v1 = [b.bm.verts.new(p) for p in ring1]
        vt = b.bm.verts.new(tip)
        vb = b.bm.verts.new(bot)
        for i in range(6):
            j = (i + 1) % 6
            b._face((v0[i], v0[j], v1[j], v1[i]), mat)
            b._face((v1[i], v1[j], vt), mat)
            b._face((v0[j], v0[i], vb), mat)
    o = b.finish(merge=False)
    return o


def gem():
    FX.reset()
    g = crystal_mesh('Gem', 3, 1, 0.045, 0.24, 0.0)
    o = crystal_mesh('Orb', 11, 5, 0.085, 0.5, 0.55)
    for x in (g, o):
        x.data.uv_layers.clear() if hasattr(x.data.uv_layers, 'clear') else None
        print(x.name, 'tris', tris(x), flush=True)
        export_glb([x], os.path.join(OUT, x.name.lower() + '.glb'))
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(FX.WORK, 'gems.blend'))


# ------------------------------------------------------------------ lookdev
def np_image(name, arr, noncolor=False):
    """A float image from a (h, w, 3|4) bottom-up array, via an EXR on disk (generated images are flaky)."""
    h, w = arr.shape[:2]
    if arr.shape[-1] == 3:
        arr = np.concatenate([arr, np.ones((h, w, 1))], -1)
    im = bpy.data.images.new(name, w, h, float_buffer=True)
    im.pixels.foreach_set(arr.astype(np.float32).ravel())
    path = os.path.join(FX.WORK, f'_ld_{name}.exr')
    im.filepath_raw = path
    im.file_format = 'OPEN_EXR'
    im.save()
    bpy.data.images.remove(im)
    im = bpy.data.images.load(path)
    im.colorspace_settings.name = 'Non-Color' if noncolor else 'Linear Rec.709'
    return im


def baked_material(name, npy, uvname='UVMap', metal_from_color=False, normal_npy=None):
    a = np.load(os.path.join(FX.WORK, npy + '.npy'))
    alb = a[..., :3] * (a[..., 3:4] ** 0.8 if a.shape[-1] > 3 else 1)
    im = np_image(name + '_tex', alb)
    m = bpy.data.materials.new(name)
    nb = NB(m)
    t = nb.img(im, nb.uv(uvname))
    metal = 0.0
    rough = 0.75
    if metal_from_color:
        ca = nb.n('ShaderNodeVertexColor', layer_name='Col')
        r, g, _ = nb.sepc(ca.outputs['Color'])
        metal, rough = r, g
    nrm = None
    if normal_npy:
        ni = np_image(name + '_nrm', np.load(os.path.join(FX.WORK, normal_npy + '.npy')), noncolor=True)
        nrm = nb.n('ShaderNodeNormalMap', uv_map=uvname, ins={'Color': nb.img(ni, nb.uv(uvname)).outputs[0]}).outputs[0]
    nb.bsdf(t.outputs[0], rough=rough, metal=metal, normal=nrm)
    return m


def assign(o, m):
    o.data.materials.clear()
    o.data.materials.append(m)
    if o.data.color_attributes:
        o.data.color_attributes[0].name = 'Col'


def lookdev_scene(exposure=0.0, hdri='qwantani_sunset_puresky', sun=True):
    FX.reset()
    SM._imgs.clear()
    SM.M.clear()
    sc = FX.gpu(samples=128, transparent=False)
    FX.look_agx()
    sc.view_settings.exposure = exposure
    meta = SKY.world(hdri, -136.6, strength=1.0)
    if sun:
        SKY.sun_lamp(meta, -136.6, 7.0)
    b = core.Builder('GROUND', sc.collection)
    b.quad([(-30, -30, 0), (30, -30, 0), (30, 30, 0), (-30, 30, 0)], SM.snow_ground('snow', with_sparkle=True))
    b.finish()
    return sc


def import_glb(name):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(OUT, name + '.glb'))
    return [o for o in bpy.data.objects if o not in before and o.type == 'MESH']


def lookdev():
    # Chest: two of them, one lid open, golden hour from behind-left.
    lookdev_scene(0.0)
    objs = import_glb('chest')
    m = baked_material('chest_baked', 'chest_albedo', uvname='UVMap', metal_from_color=True)
    for o in objs:
        assign(o, m)
    FX.persp_cam((1.5, -1.9, 0.95), (0, 0, 0.35), lens=40, w=960, h=720)
    FX.render_png(os.path.join(FX.RENDERS, 'fx_chest_lookdev.png'))
    # Rock and blades and gems on the snow together.
    lookdev_scene(0.0)
    r = import_glb('rock')[0]
    assign(r, baked_material('rock_baked', 'rock_albedo', normal_npy='rock_normal'))
    r.location = (0, 0, 0.27)
    r2 = r.copy(); r2.data = r.data; bpy.context.scene.collection.objects.link(r2)
    r2.location = (0.75, 0.6, 0.45); r2.scale = (1.6,) * 3; r2.rotation_euler = (0.7, 0.3, 1.2)
    bl = import_glb('blade')[0]
    assign(bl, baked_material('blade_baked', 'blade_albedo', metal_from_color=True))
    bl.rotation_euler = (math.radians(-90), 0, math.radians(35))
    bl.location = (-0.55, -0.1, 0.03)
    gm = import_glb('gem')[0]
    glass = bpy.data.materials.new('gemglass')
    nb = NB(glass)
    p = nb.bsdf((0.3, 0.75, 1.0), rough=0.04, trans=1.0, ior=1.6, ecol=(0.25, 0.7, 1.0), estr=1.5, out=True)
    assign(gm, glass)
    for k, (x, y) in enumerate(((-0.2, -0.45), (0.15, -0.55), (0.35, -0.3))):
        g = gm.copy(); g.data = gm.data; bpy.context.scene.collection.objects.link(g)
        g.location = (x, y, 0.12)
        g.rotation_euler = (0.3 * k, 0.2, k)
    gm.hide_render = True
    FX.persp_cam((0.6, -2.4, 0.85), (0.05, 0, 0.25), lens=40, w=960, h=720)
    FX.render_png(os.path.join(FX.RENDERS, 'fx_props_lookdev.png'))


for what in argv or ['scorch']:
    {'scorch': scorch, 'chest': chest, 'rock': rock, 'blade': blade, 'gem': gem, 'lookdev': lookdev}[what]()
