"""Trail furniture: snow poles, the trailhead sign, the summit plaque.

- Snow poles: black fibreglass stakes with an orange reflective top band, leaning a little, rime grown on
  their windward side. Positions follow world-builders.ts buildTrailMarkers exactly.
- Trailhead sign: a Swiss-style yellow enamelled arrow blade, black lettering, on a galvanised post.
- Summit plaque: a larch board with letters carved in and painted, on a timber post.
Lettering is real geometry (Blender text, extruded), so it reads in VR at any angle.
"""
import bpy, math, random
from mathutils import Vector, Matrix
from . import core, snowmats as SM
from .nodes import NB

FONT_BOLD = r"C:\Windows\Fonts\arialbd.ttf"
FONT_SERIF = r"C:\Windows\Fonts\georgiab.ttf"
_M = {}


def mats():
    if _M:
        return _M
    def plain(name, col, rough, metal=0.0, coat=0.0):
        m = SM.new(name)
        nb = NB(m)
        g = nb.noise(nb.pos(), 60.0, detail=4.0)
        nb.bsdf(nb.mix(nb.mrange(g, 0.3, 0.7, 0, 0.15), col, (0.0, 0.0, 0.0)), rough=rough, metal=metal, coat=coat)
        return m
    _M['fibre'] = plain('pole_fibre', (0.02, 0.02, 0.022), 0.35, coat=0.3)
    _M['orange'] = plain('pole_orange', (0.95, 0.22, 0.02), 0.4, coat=0.5)
    _M['yellow'] = plain('sign_yellow', (0.92, 0.66, 0.02), 0.3, coat=0.6)
    _M['ink'] = plain('sign_ink', (0.015, 0.015, 0.015), 0.4)
    _M['galv'] = plain('galvanised', (0.55, 0.57, 0.58), 0.35, metal=1.0)
    _M['cream'] = plain('carve_paint', (0.85, 0.8, 0.68), 0.6)
    # Larch board for the summit plaque: the scanned planks, warm and weathered.
    m = SM.new('plaque_wood')
    nb = NB(m)
    ts = SM.texset('weathered_planks')
    vec = SM.metric_uv(nb, ts['size'], scale=0.4)
    d, r, a, n, h = SM.scan(nb, ts, vec, 1.0)
    nb.bsdf(nb.hsv(d, 0.52, 0.85, 0.65), rough=0.8, normal=n)
    _M['wood'] = m
    rime = SM.new('rime')
    nb = NB(rime)
    nb.link(SM.snow_shader(nb, normal=nb.bump(nb.noise(nb.pos(), 120.0, detail=3.0), strength=0.5, dist=0.002)), nb.out.inputs['Surface'])
    _M['rime'] = rime
    return _M


def text_mesh(body, size, depth, font=FONT_BOLD, align='CENTER'):
    """Extruded lettering as a mesh in the XY plane (extruded along +Z), centred."""
    cu = bpy.data.curves.new('txt', 'FONT')
    cu.body = body
    cu.font = bpy.data.fonts.load(font, check_existing=True)
    cu.size = size
    cu.extrude = depth / 2
    cu.align_x = align
    cu.align_y = 'CENTER'
    cu.resolution_u = 4
    ob = bpy.data.objects.new('txt', cu)
    bpy.context.scene.collection.objects.link(ob)
    dg = bpy.context.evaluated_depsgraph_get()
    dg.update()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    bpy.data.objects.remove(ob)
    bpy.data.curves.remove(cu)
    return me


def snow_pole(name, coll, seed):
    R = random.Random(seed)
    M = mats()
    b = core.Builder(name, coll)
    lean = Vector((R.gauss(0, 0.03), R.gauss(0, 0.03), 1)).normalized()
    top = lean * 1.85
    b.cyl(Vector((0, 0, -0.35)), top, 0.016, M['fibre'], sides=10, r1=0.013)
    b.cyl(lean * 1.45, lean * 1.75, 0.0172, M['orange'], sides=10)
    b.cyl(lean * 1.62, lean * 1.66, 0.0175, M['galv'], sides=10)
    # rime: feathers of frost grown into the wind (from the west, -X) on the upper stake
    for k in range(26):
        t = 0.35 + 1.45 * R.random()
        p = lean * t
        L = R.uniform(0.008, 0.035)
        b.cyl(p + Vector((-0.012, 0, 0)), p + Vector((-0.012 - L, R.gauss(0, 0.006), R.gauss(0, 0.006))), 0.005, M['rime'], sides=4, r1=0.0015)
    return b.finish(merge=False)


def trail_sign(name, coll, lines=('SUMMIT TRAIL', 'Cliff  70 m', 'Glider launch')):
    """Yellow arrow blade on a galvanised post; the arrow points along local +X."""
    M = mats()
    b = core.Builder(name, coll)
    b.cyl(Vector((0, 0, -0.4)), Vector((0, 0, 2.35)), 0.03, M['galv'], sides=12)
    b.lathe([(0.032, 0.0), (0.036, 0.01), (0.0, 0.02)], Vector((0, 0, 2.35)), Vector((0, 0, 1)), M['galv'], seg=12)
    W_, H_, T = 1.05, 0.34, 0.012
    tip = 0.17
    poly = [(-0.05, -H_ / 2), (W_ - tip, -H_ / 2), (W_, 0), (W_ - tip, H_ / 2), (-0.05, H_ / 2)]
    for zc, row in ((1.95, 0),):
        Mx = Matrix.Translation((0, -0.04, zc)) @ Matrix.Rotation(math.pi / 2, 4, 'X')
        b.prism(poly, T, Mx, M['yellow'])
    # clamps
    for zc in (1.88, 2.02):
        b.cyl(Vector((0, -0.02, zc)), Vector((0, -0.06, zc)), 0.012, M['galv'], sides=8)
    ob = b.finish(merge=False)
    # lettering on both faces
    for side in (1, -1):
        for i, (txt, size) in enumerate(zip(lines, (0.085, 0.06, 0.06))):
            me = text_mesh(txt, size, 0.0015)
            t = bpy.data.objects.new(f'{name}_t{side}{i}', me)
            coll.objects.link(t)
            y = -0.04 - (T / 2 + 0.001) * side * -1 if side > 0 else -0.04 + T + 0.001
            t.matrix_world = Matrix.Translation((0.45, -0.04 - 0.0075 if side > 0 else -0.04 + T + 0.0075, 1.95 + 0.095 - i * 0.09)) @ \
                Matrix.Rotation(math.pi / 2, 4, 'X') @ (Matrix.Rotation(math.pi, 4, 'Y') if side < 0 else Matrix.Identity(4))
            me.materials.append(M['ink'])
    return ob


def summit_plaque(name, coll, lines=('SUMMIT', 'Elevation 2,640 m')):
    """A larch board, letters carved in and painted cream, on a squared post. Faces local -Y."""
    M = mats()
    b = core.Builder(name, coll)
    b.cbox((0, 0, 0.6), (0.11, 0.11, 1.9), M['wood'], bev=0.012, seg=1)
    b.cbox((0, -0.08, 1.35), (1.02, 0.05, 0.44), M['wood'], bev=0.015, seg=2)
    b.cbox((0, -0.06, 1.6), (1.1, 0.12, 0.05), M['rime'], bev=0.02, seg=2)
    ob = b.finish(merge=False)
    for i, (txt, size) in enumerate(zip(lines, (0.14, 0.07))):
        me = text_mesh(txt, size, 0.004, font=FONT_SERIF)
        me.materials.append(M['cream'])
        t = bpy.data.objects.new(f'{name}_t{i}', me)
        coll.objects.link(t)
        t.matrix_world = Matrix.Translation((0, -0.104, 1.42 - i * 0.14)) @ Matrix.Rotation(math.pi / 2, 4, 'X')
    return ob
