"""Photographic skies split into sun + sky, so each can be baked (and re-lit at runtime) on its own.

`prep(hid)` measures the sun disc in a Poly Haven pure-sky HDRI (irradiance, colour, direction), paints it
out of the image and caches the sun-less sky as art/work/sky_<hid>_nosun.exr with a json of the sun.
`world(hid, sun_azim_deg)` sets that sky as the world, rotated so its sun stands at the arena's azimuth,
and returns the matching sun lamp parameters.

Cycles' equirect lookup: u = (pi - atan2(d.y, d.x)) / 2pi, v = asin(d.z) / pi + 0.5 (rows bottom-up).
So a direction with azimuth phi (atan2(y, x)) sits at u = 0.5 - phi / 2pi (mod 1).
"""
import bpy, os, json, math
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ART = os.path.dirname(os.path.dirname(HERE))
HDRI = os.path.join(ART, 'assets', 'polyhaven', 'hdris')
WORK = os.path.join(ART, 'work')


def _load(path):
    im = bpy.data.images.load(path, check_existing=True)
    w, h = im.size
    px = np.empty(w * h * 4, np.float32)
    im.pixels.foreach_get(px)
    return im, px.reshape(h, w, 4)


def prep(hid, res='4k', thresh_rel=0.02, paint=True):
    meta_p = os.path.join(WORK, f'sky_{hid}.json')
    out_p = os.path.join(WORK, f'sky_{hid}_nosun.exr')
    if os.path.exists(meta_p) and os.path.exists(out_p):
        return json.load(open(meta_p))
    im, px = _load(os.path.join(HDRI, f'{hid}_{res}.exr'))
    h, w = px.shape[:2]
    rgb = px[:, :, :3]
    lum = rgb @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    j0, i0 = np.unravel_index(np.argmax(lum), lum.shape)
    peak = float(lum[j0, i0])
    # Solid angle of each pixel row (equirect): (2pi/w) * (pi/h) * cos(lat).
    lat = (np.arange(h) + 0.5) / h * math.pi - math.pi / 2
    dA = (2 * math.pi / w) * (math.pi / h) * np.cos(lat)
    meta = {'hid': hid, 'u': (i0 + 0.5) / w, 'elev_deg': math.degrees(lat[j0]), 'peak': peak}
    # A sun disc is thousands of times brighter than the sky beside it; dusk skies have none.
    ring = lum[max(0, j0 - 60):j0 + 60, max(0, i0 - 60):i0 + 60]
    if not paint or peak < 500 or peak < 50 * float(np.median(ring)):
        meta.update(sun=False, irradiance=0.0, color=[1, 1, 1])
    else:
        r = 40
        jj, ii = np.mgrid[max(0, j0 - r):j0 + r, max(0, i0 - r):i0 + r]
        win = lum[jj, ii]
        bg = float(np.percentile(win, 50))
        disc = win > max(bg * 8, peak * thresh_rel)
        # Dilate the disc a little so the limb's glow goes with it.
        meta['sun'] = True
        sel_j, sel_i = jj[disc], ii[disc]
        excess = rgb[sel_j, sel_i] - bg * np.array([1, 0.9, 0.8], np.float32)
        excess = np.maximum(excess, 0)
        E = (excess * dA[sel_j, None]).sum(0)  # irradiance on a plane facing the sun, per channel
        lumE = float(E @ np.array([0.2126, 0.7152, 0.0722], np.float32))
        meta.update(irradiance=lumE, color=(E / max(E.max(), 1e-6)).tolist(), pixels=int(disc.sum()))
        # Paint the disc out with the surrounding sky.
        ring_px = rgb[jj[~disc], ii[~disc]]
        fill = ring_px[np.argsort(ring_px @ np.array([0.2126, 0.7152, 0.0722], np.float32))[int(len(ring_px) * 0.9)]]
        rgb[sel_j, sel_i] = fill
        px[:, :, :3] = rgb
    out = bpy.data.images.new(f'sky_{hid}_nosun', w, h, float_buffer=True)
    out.pixels.foreach_set(px.ravel())
    out.filepath_raw = out_p
    out.file_format = 'OPEN_EXR'
    out.save()
    bpy.data.images.remove(im)
    json.dump(meta, open(meta_p, 'w'), indent=1)
    return meta


def world(hid, sun_azim_deg, strength=1.0, res='4k'):
    """Sun-less sky as the world, turned so its sun azimuth matches `sun_azim_deg`. Returns sun meta."""
    meta = prep(hid, res)
    phi_hdri = 360.0 * (0.5 - meta['u'])
    rot = math.radians(phi_hdri - sun_azim_deg)  # rotate lookup vectors so target azimuth -> hdri azimuth
    w = bpy.context.scene.world or bpy.data.worlds.new('World')
    bpy.context.scene.world = w
    nt = w.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    tc = nt.nodes.new('ShaderNodeTexCoord')
    mp = nt.nodes.new('ShaderNodeMapping')
    mp.inputs['Rotation'].default_value = (0, 0, rot)
    env = nt.nodes.new('ShaderNodeTexEnvironment')
    env.image = bpy.data.images.load(os.path.join(WORK, f'sky_{hid}_nosun.exr'), check_existing=True)
    bg = nt.nodes.new('ShaderNodeBackground')
    bg.inputs['Strength'].default_value = strength
    out = nt.nodes.new('ShaderNodeOutputWorld')
    nt.links.new(tc.outputs['Generated'], mp.inputs['Vector'])
    nt.links.new(mp.outputs[0], env.inputs['Vector'])
    nt.links.new(env.outputs[0], bg.inputs[0])
    nt.links.new(bg.outputs[0], out.inputs[0])
    meta['world_rot_rad'] = rot
    meta['strength'] = strength
    return meta


def sun_lamp(meta, azim_deg, elev_deg, scale=1.0, name='SUN'):
    from mathutils import Vector
    ob = bpy.data.objects.get(name)
    if ob is None:
        ob = bpy.data.objects.new(name, bpy.data.lights.new(name, 'SUN'))
        bpy.context.scene.collection.objects.link(ob)
    ob.data.energy = meta.get('irradiance', 0.0) * scale * meta.get('strength', 1.0)
    ob.data.color = meta.get('color', [1, 1, 1])
    ob.data.angle = math.radians(0.53)
    az, el = math.radians(azim_deg), math.radians(elev_deg)
    d = Vector((math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el)))
    ob.rotation_euler = d.to_track_quat('Z', 'Y').to_euler()
    return ob
