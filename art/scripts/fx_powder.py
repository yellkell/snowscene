"""Snow-powder burst flipbook (16 frames), a procedural volume: a puff of kicked snow that billows out,
thins and sags as the grains fall out of it. Rendered twice per frame (lit by a sky dome, lit by a sun)
so the runtime can re-light it.

  blender -b --factory-startup --python art/scripts/fx_powder.py -- [render|lookdev]
-> art/work/fx/powder_frames.npy (2, 16, h, w, 4), packed by art/scripts/fx_pack.py powder.
"""
import bpy, os, sys, math
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import fxkit as FX
from lib.nodes import NB

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
STAGE = argv[0] if argv else 'render'
N = 16
SIZE = 2.6


def build():
    FX.reset()
    import bmesh
    me = bpy.data.meshes.new('PUFF')
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=SIZE)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new('PUFF', me)
    bpy.context.scene.collection.objects.link(ob)
    m = bpy.data.materials.new('POWDER')
    nb = NB(m)
    p = nb.texco('Object')
    ctr = nb.n('ShaderNodeCombineXYZ', ins={0: 0.0, 1: 0.0, 2: 0.0})
    ctr.name = 'CTR'
    rad = nb.n('ShaderNodeValue')
    rad.name = 'RAD'
    w = nb.n('ShaderNodeValue')
    w.name = 'W'
    amp = nb.n('ShaderNodeValue')
    amp.name = 'AMP'
    q = nb.vmath('SUBTRACT', p, ctr.outputs[0])
    q = nb.vmath('MULTIPLY', q, (1.0, 1.0, 1.25))
    d = nb.math('DIVIDE', nb.vmath('LENGTH', q), rad.outputs[0])
    big = nb.n('ShaderNodeTexNoise', noise_dimensions='4D',
               ins={'Vector': p, 'W': w.outputs[0], 'Scale': 1.6, 'Detail': 6.0, 'Roughness': 0.62, 'Distortion': 0.5})
    fine = nb.n('ShaderNodeTexNoise', noise_dimensions='4D',
                ins={'Vector': p, 'W': nb.math('MULTIPLY', w.outputs[0], 1.7), 'Scale': 6.5, 'Detail': 4.0, 'Roughness': 0.6})
    edge = nb.math('ADD', d, nb.math('MULTIPLY', nb.math('SUBTRACT', big.outputs['Fac'], 0.5), 2.0))
    shell = nb.n('ShaderNodeMapRange', interpolation_type='SMOOTHSTEP', ins={0: edge, 1: 1.0, 2: 0.3, 3: 0.0, 4: 1.0})
    clump = nb.mrange(fine.outputs['Fac'], 0.38, 0.66, 0.05, 1.6)
    dens = nb.math('MULTIPLY', nb.math('MULTIPLY', shell.outputs[0], clump), amp.outputs[0])
    pv = nb.n('ShaderNodeVolumePrincipled')
    nb.link((0.93, 0.95, 0.98), pv.inputs['Color'])
    nb.link(dens, pv.inputs['Density'])
    nb.link(0.45, pv.inputs['Anisotropy'])
    pv.inputs['Density Attribute'].default_value = ''
    nb.link(pv.outputs[0], nb.out.inputs['Volume'])
    me.materials.append(m)
    return m.node_tree


def set_frame(nt, k):
    t = k / (N - 1)
    R = 0.16 + 0.95 * (1 - math.exp(-3.2 * t))
    nt.nodes['RAD'].outputs[0].default_value = R
    nt.nodes['W'].outputs[0].default_value = 0.2 + t * 1.3
    nt.nodes['CTR'].inputs[2].default_value = -0.45 * t * t + 0.1 * t
    # The grains settle out: optical depth falls as it spreads (and thins faster near the end).
    nt.nodes['AMP'].outputs[0].default_value = 70.0 * (0.25 / R) ** 1.2 * (1 - t) ** 1.6 + 2.0 * (1 - t) ** 2


def render():
    nt = build()
    sc = FX.gpu(samples=64, transparent=True)
    sc.cycles.volume_step_rate = 0.5
    sc.cycles.volume_bounces = 12  # snow grains barely absorb: the light that gets in comes back out
    FX.ortho_cam((0, 0, 0), SIZE, 256, 256, direction=(0, 1, 0))
    out = np.zeros((2, N, 256, 256, 4), np.float16)
    sunob = FX.sun((-0.35, -0.6, 0.72), 0.0)
    for pi, mode in enumerate(('sky', 'sun')):
        if mode == 'sky':
            FX.world_gradient((1.0, 1.0, 1.0), (0.35, 0.35, 0.35), 1.0)
            sunob.data.energy = 0.0
        else:
            FX.world_color((0, 0, 0), 0.0)
            sunob.data.energy = math.pi
        for k in range(N):
            set_frame(nt, k)
            px = FX.render_np('powder')
            out[pi, k] = px.astype(np.float16)
            print(f'powder {mode} {k}: alpha {float(px[..., 3].mean()):.3f}', flush=True)
    np.save(os.path.join(FX.WORK, 'powder_frames.npy'), out)


def lookdev():
    from lib import snowmats as SM, sky, core
    nt = build()
    sc = FX.gpu(samples=128, transparent=False)
    sc.cycles.volume_bounces = 12
    FX.look_agx()
    meta = sky.world('qwantani_sunset_puresky', -136.6, strength=1.0)
    sky.sun_lamp(meta, -136.6, 7.0)
    b = core.Builder('GROUND', bpy.context.scene.collection)
    b.quad([(-12, -12, 0), (12, -12, 0), (12, 12, 0), (-12, 12, 0)], SM.snow_ground('snow', with_sparkle=True))
    b.finish()
    puff = bpy.data.objects['PUFF']
    puff.location = (0, 0, 1.0)
    puff.scale = (0.6, 0.6, 0.6)
    set_frame(nt, 4)
    FX.persp_cam((2.2, -3.6, 1.3), (0, 0, 0.9), lens=40, w=960, h=720)
    FX.render_png(os.path.join(FX.RENDERS, 'fx_powder_lookdev.png'))


{'render': render, 'lookdev': lookdev}[STAGE]()
