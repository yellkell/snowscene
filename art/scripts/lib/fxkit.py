"""Helpers for the FX flipbook scripts (art/scripts/fx_*.py): scene reset, GPU Cycles, orthographic
cameras, renders straight to numpy. Frames are cached as float16 .npy in art/work/fx/ and packed into
runtime atlases by art/scripts/fx_pack.py (system Python, PIL).
"""
import bpy, os, math
import numpy as np
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ART = os.path.dirname(os.path.dirname(HERE))
ROOT = os.path.dirname(ART)
WORK = os.path.join(ART, 'work', 'fx')
RENDERS = os.path.join(ART, 'renders')
os.makedirs(WORK, exist_ok=True)


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.fps = 24
    return sc


def gpu(samples=64, transparent=True, denoise=True):
    sc = bpy.context.scene
    prefs = bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type = 'OPTIX'
    prefs.get_devices()
    for d in prefs.devices:
        d.use = d.type == 'OPTIX'
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'GPU'
    sc.cycles.samples = samples
    sc.cycles.use_denoising = denoise
    sc.cycles.denoiser = 'OPTIX'
    sc.cycles.max_bounces = 6
    sc.cycles.volume_bounces = 2
    sc.cycles.transparent_max_bounces = 16
    sc.render.film_transparent = transparent
    sc.view_settings.view_transform = 'Standard'
    sc.view_settings.look = 'None'
    sc.render.resolution_percentage = 100
    return sc


def look_agx():
    sc = bpy.context.scene
    sc.view_settings.view_transform = 'AgX'
    sc.view_settings.look = 'None'


def ortho_cam(center, scale, w, h, direction=(0, 1, 0), name='CAM'):
    """Orthographic camera looking along `direction` at `center`, `scale` metres across the wider side."""
    sc = bpy.context.scene
    cam = bpy.data.objects.get(name)
    if cam is None:
        cam = bpy.data.objects.new(name, bpy.data.cameras.new(name))
        sc.collection.objects.link(cam)
    cam.data.type = 'ORTHO'
    cam.data.ortho_scale = scale
    cam.data.clip_start = 0.01
    cam.data.clip_end = 200
    d = Vector(direction).normalized()
    cam.location = Vector(center) - d * 20
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    sc.camera = cam
    sc.render.resolution_x, sc.render.resolution_y = w, h
    return cam


def persp_cam(loc, target, lens=50, w=1280, h=720, name='CAM'):
    sc = bpy.context.scene
    cam = bpy.data.objects.get(name)
    if cam is None:
        cam = bpy.data.objects.new(name, bpy.data.cameras.new(name))
        sc.collection.objects.link(cam)
    cam.data.type = 'PERSP'
    cam.data.lens = lens
    cam.data.clip_start = 0.02
    cam.data.clip_end = 2000
    cam.location = Vector(loc)
    cam.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    sc.camera = cam
    sc.render.resolution_x, sc.render.resolution_y = w, h
    return cam


def render_np(tag='frame'):
    """Render the scene; float RGBA (rows bottom-up, like Blender images)."""
    sc = bpy.context.scene
    sc.render.image_settings.file_format = 'OPEN_EXR'
    sc.render.image_settings.color_depth = '32'
    sc.render.image_settings.color_mode = 'RGBA'
    path = os.path.join(WORK, f'_tmp_{tag}.exr')
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    im = bpy.data.images.load(path)
    w, h = im.size
    a = np.empty(w * h * 4, np.float32)
    im.pixels.foreach_get(a)
    bpy.data.images.remove(im)
    return a.reshape(h, w, 4)


def render_png(path):
    sc = bpy.context.scene
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_depth = '8'
    sc.render.image_settings.color_mode = 'RGB'
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print('wrote', path, flush=True)


def world_color(rgb, strength=1.0):
    w = bpy.context.scene.world or bpy.data.worlds.new('World')
    bpy.context.scene.world = w
    w.use_nodes = True
    nt = w.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    bg = nt.nodes.new('ShaderNodeBackground')
    bg.inputs['Color'].default_value = (*rgb, 1)
    bg.inputs['Strength'].default_value = strength
    out = nt.nodes.new('ShaderNodeOutputWorld')
    nt.links.new(bg.outputs[0], out.inputs[0])
    return bg


def world_gradient(top, bottom, strength=1.0):
    """A sky that is `top` overhead falling to `bottom` below the horizon (snow bounce)."""
    w = bpy.context.scene.world or bpy.data.worlds.new('World')
    bpy.context.scene.world = w
    w.use_nodes = True
    nt = w.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    tc = nt.nodes.new('ShaderNodeTexCoord')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    mr = nt.nodes.new('ShaderNodeMapRange')
    mr.inputs[1].default_value = -0.3
    mr.inputs[2].default_value = 0.6
    mix = nt.nodes.new('ShaderNodeMix')
    mix.data_type = 'RGBA'
    mix.inputs[6].default_value = (*bottom, 1)
    mix.inputs[7].default_value = (*top, 1)
    bg = nt.nodes.new('ShaderNodeBackground')
    bg.inputs['Strength'].default_value = strength
    out = nt.nodes.new('ShaderNodeOutputWorld')
    nt.links.new(tc.outputs['Generated'], sep.inputs[0])
    nt.links.new(sep.outputs[2], mr.inputs[0])
    nt.links.new(mr.outputs[0], mix.inputs[0])
    nt.links.new(mix.outputs[2], bg.inputs[0])
    nt.links.new(bg.outputs[0], out.inputs[0])
    return bg


def sun(direction_to_sun, strength, color=(1, 1, 1), angle_deg=0.53, name='SUN'):
    ob = bpy.data.objects.get(name)
    if ob is None:
        ob = bpy.data.objects.new(name, bpy.data.lights.new(name, 'SUN'))
        bpy.context.scene.collection.objects.link(ob)
    ob.data.energy = strength
    ob.data.color = color
    ob.data.angle = math.radians(angle_deg)
    ob.rotation_euler = Vector(direction_to_sun).normalized().to_track_quat('Z', 'Y').to_euler()
    return ob


def lum(a):
    return a[..., 0] * 0.2126 + a[..., 1] * 0.7152 + a[..., 2] * 0.0722
