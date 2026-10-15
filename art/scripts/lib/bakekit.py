"""Bake plumbing shared by every region's bake script (after blendercyber v2 bake_v2.py).

Light is baked in separate, re-lightable channels: `light_mode('sun')` = the sun lamp alone at unit white
strength, world black; `light_mode('sky')` = the sky alone. Results are float arrays (numpy) that
art/scripts/encode.py turns into compact runtime textures.
"""
import bpy, os, time
import numpy as np

T0 = time.time()


def log(*a):
    print(f"[{time.time() - T0:7.1f}s]", *a, flush=True)


def gpu(sc=None):
    sc = sc or bpy.context.scene
    prefs = bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type = 'OPTIX'
    prefs.get_devices()
    for d in prefs.devices:
        d.use = d.type == 'OPTIX'
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'GPU'
    sc.cycles.max_bounces = 8
    sc.cycles.transparent_max_bounces = 24
    sc.cycles.sample_clamp_indirect = 6.0
    sc.render.bake.margin_type = 'EXTEND'


_saved = {}


def light_mode(mode, sun_name='SUN'):
    """'sun': unit white sun, black world. 'sky': world only. 'beauty': as authored."""
    sc = bpy.context.scene
    sun = bpy.data.objects[sun_name]
    bg = next(n for n in sc.world.node_tree.nodes if n.type == 'BACKGROUND')
    if not _saved:
        _saved.update(energy=sun.data.energy, color=tuple(sun.data.color), strength=bg.inputs['Strength'].default_value)
    if mode == 'sun':
        sun.hide_render = False
        sun.data.energy = 1.0
        sun.data.color = (1, 1, 1)
        bg.inputs['Strength'].default_value = 0.0
    elif mode == 'sky':
        # strength, not hide_render: Cycles' persistent data (used for impostor renders) tracks light
        # parameters but not visibility toggles
        sun.hide_render = False
        sun.data.energy = 0.0
        bg.inputs['Strength'].default_value = _saved['strength']
    else:
        sun.hide_render = False
        sun.data.energy = _saved['energy']
        sun.data.color = _saved['color']
        bg.inputs['Strength'].default_value = _saved['strength']


def select_only(active, others=()):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in others:
        o.select_set(True)
    active.select_set(True)
    bpy.context.view_layer.objects.active = active


def set_target(o, img):
    """Give `o` a single receiver material whose active node is the bake image."""
    me = o.data
    tm = bpy.data.materials.get('BAKE_RECEIVER') or bpy.data.materials.new('BAKE_RECEIVER')
    tm.use_nodes = True
    n = tm.node_tree.nodes.get('BAKE_TARGET') or tm.node_tree.nodes.new('ShaderNodeTexImage')
    n.name = 'BAKE_TARGET'
    n.image = img
    tm.node_tree.nodes.active = n
    me.materials.clear()
    me.materials.append(tm)
    for p in me.polygons:
        p.material_index = 0


def target_on_materials(o, img):
    """Bake onto `o` keeping its own materials: add the target image as the active node in each."""
    for m in o.data.materials:
        nt = m.node_tree
        n = nt.nodes.get('BAKE_TARGET') or nt.nodes.new('ShaderNodeTexImage')
        n.name = 'BAKE_TARGET'
        n.image = img
        nt.nodes.active = n


def bake(o, img, type_, passes, samples, margin=8, uv='BakeUV', high=(), extrusion=0.06, maxdist=0.12,
         keep_materials=False, target='IMAGE_TEXTURES'):
    sc = bpy.context.scene
    if target == 'IMAGE_TEXTURES':
        (target_on_materials if keep_materials else set_target)(o, img)
    select_only(o, high)
    sc.cycles.samples = samples
    kw = dict(type=type_, margin=margin, use_clear=True, use_selected_to_active=bool(high),
              cage_extrusion=extrusion, max_ray_distance=maxdist, target=target)
    if target == 'IMAGE_TEXTURES':
        kw['uv_layer'] = uv
    if passes:
        kw['pass_filter'] = passes
    bpy.ops.object.bake(**kw)


def pixels(img):
    a = np.empty(img.size[0] * img.size[1] * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(img.size[1], img.size[0], 4)


_dn = {}


def denoise(img, work):
    """OIDN through the compositor (Blender 5 node-group compositor)."""
    w, h = img.size
    if not _dn:
        dsc = bpy.data.scenes.new('DENOISE')
        ng = bpy.data.node_groups.new('DN', 'CompositorNodeTree')
        ng.interface.new_socket('Image', in_out='OUTPUT', socket_type='NodeSocketColor')
        ni = ng.nodes.new('CompositorNodeImage')
        dn = ng.nodes.new('CompositorNodeDenoise')
        go = ng.nodes.new('NodeGroupOutput')
        ng.links.new(ni.outputs['Image'], dn.inputs['Image'])
        ng.links.new(dn.outputs[0], go.inputs[0])
        dsc.compositing_node_group = ng
        dsc.render.use_compositing = True
        dsc.render.image_settings.file_format = 'OPEN_EXR'
        dsc.render.image_settings.color_depth = '32'
        _dn.update(scene=dsc, img=ni)
    dsc = _dn['scene']
    dsc.render.resolution_x, dsc.render.resolution_y, dsc.render.resolution_percentage = w, h, 100
    _dn['img'].image = img
    bpy.ops.render.render(scene=dsc.name)
    path = os.path.join(work, img.name + '_dn.exr')
    bpy.data.images['Render Result'].save_render(path, scene=dsc)
    out = bpy.data.images.load(path)
    p = pixels(out)
    bpy.data.images.remove(out)
    return p


def lum(a):
    return a[..., 0] * 0.2126 + a[..., 1] * 0.7152 + a[..., 2] * 0.0722


def dilate(rgb, mask, iters=16):
    """Push colour outward from covered pixels into uncovered ones (avoids dark mip fringes)."""
    rgb = rgb.copy()
    m = mask.astype(bool).copy()
    for _ in range(iters):
        if m.all():
            break
        acc = np.zeros_like(rgb)
        cnt = np.zeros(m.shape, np.float32)
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            sm = np.roll(m, (dy, dx), (0, 1))
            sr = np.roll(rgb, (dy, dx), (0, 1))
            add = sm & ~m
            acc[add] += sr[add]
            cnt[add] += 1
        grow = cnt > 0
        rgb[grow] = acc[grow] / cnt[grow][:, None]
        m |= grow
    return rgb
