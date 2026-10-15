"""Mantaflow gas sims rendered to flipbook frames for the Snow Survivors FX.

  blender -b --factory-startup --python art/scripts/fx_sims.py -- <sim> <stage>

sims:
  fire      a steady fire on a patch of fuel (looping 64 frames: emission + smoke)
  fireball  a burst of fuel that balloons, rolls up and leaves smoke (16 frames)
  powder    a burst of snow powder kicked up by a hit (16 frames, lit by sky and sun separately)
stages:
  bake      build the sim scene, bake the cache (CPU), save art/work/fx/<sim>.blend
  render    render the flipbook frames (GPU) -> art/work/fx/<sim>_frames.npy (float16 RGBA per pass)
  lookdev   a Cycles still of the sim in the snowfield at dusk -> art/renders/fx_<sim>_lookdev.png

Fire frames: RGB = emitted radiance (blackbody, flame-driven), A = smoke opacity, world black so the
smoke contributes only by absorbing. Powder frames: pass 0 lit by a sky dome, pass 1 by a sun from
above-front; A = opacity.
"""
import bpy, os, sys, math
import numpy as np
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import fxkit as FX
from lib.nodes import NB

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
SIM = argv[0] if argv else 'fire'
STAGE = argv[1] if len(argv) > 1 else 'bake'
BLEND = os.path.join(FX.WORK, f'{SIM}.blend')
CACHE = os.path.join(FX.WORK, f'cache_{SIM}')

CFG = {
    'fire': dict(size=(1.3, 1.3, 2.6), centre=(0, 0, 1.3), res=80, frames=(1, 168), out=(256, 512),
                 render=list(range(88, 168))),
    'fireball': dict(size=(2.8, 2.8, 2.8), centre=(0, 0, 1.25), res=80, frames=(1, 48), out=(256, 256),
                     render=[3 + 2 * k for k in range(16)]),
    'powder': dict(size=(3.0, 3.0, 3.0), centre=(0, 0, 1.2), res=80, frames=(1, 48), out=(256, 256),
                   render=[2 + 2 * k for k in range(16)]),
}[SIM]


def cube(name, size, centre):
    me = bpy.data.meshes.new(name)
    import bmesh
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = centre
    return ob


def disc(name, r, z, depth=0.05, seg=32):
    import bmesh
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r, radius2=r, depth=depth)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = (0, 0, z)
    return ob


def ball(name, r, z, sub=3):
    import bmesh
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=r)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = (0, 0, z)
    return ob


def build():
    sc = FX.reset()
    sc.frame_start, sc.frame_end = CFG['frames']
    dom = cube('DOMAIN', CFG['size'], CFG['centre'])
    m = dom.modifiers.new('Fluid', 'FLUID')
    m.fluid_type = 'DOMAIN'
    d = m.domain_settings
    d.domain_type = 'GAS'
    d.resolution_max = CFG['res']
    d.cache_directory = CACHE
    d.cache_type = 'ALL'
    d.cache_frame_start, d.cache_frame_end = CFG['frames']
    d.cache_data_format = 'OPENVDB'
    d.use_collision_border_bottom = True
    for k in ('front', 'back', 'left', 'right', 'top'):
        setattr(d, f'use_collision_border_{k}', False)
    d.use_noise = True
    d.noise_scale = 2
    d.noise_strength = 1.0
    if SIM == 'fire':
        d.vorticity = 0.22
        d.alpha = 0.6
        d.beta = 1.4
        d.burning_rate = 0.62
        d.flame_smoke = 1.2
        d.flame_vorticity = 1.1
        d.flame_ignition = 1.25
        d.flame_max_temp = 2.6
        d.flame_smoke_color = (0.25, 0.24, 0.23)
        d.use_dissolve_smoke = True
        d.dissolve_speed = 34
        # A patchy bed of fuel (three lumps, unequal), so the flame splits into tongues that come and go.
        for k, (x, y, r, z, fuel) in enumerate(((0.0, 0.0, 0.24, 0.13, 1.7), (0.14, 0.08, 0.14, 0.15, 1.4),
                                                (-0.13, -0.07, 0.13, 0.14, 1.5))):
            src = disc(f'FUEL{k}', r, z)
            src.location.x, src.location.y = x, y
            f = src.modifiers.new('Fluid', 'FLUID')
            f.fluid_type = 'FLOW'
            fs = f.flow_settings
            fs.flow_type = 'BOTH'
            fs.flow_behavior = 'INFLOW'
            fs.flow_source = 'MESH'
            fs.surface_distance = 0.08
            fs.fuel_amount = fuel
            fs.density = 0.25
            fs.temperature = 1.0
            fs.subframes = 1
            fs.use_initial_velocity = True
            fs.velocity_coord = (0, 0, 0.5)
            src.hide_render = True
    elif SIM == 'fireball':
        d.vorticity = 0.25
        d.alpha = 0.4
        d.beta = 1.2
        d.burning_rate = 1.3
        d.flame_smoke = 1.6
        d.flame_vorticity = 0.9
        d.flame_ignition = 1.0
        d.flame_max_temp = 3.0
        d.flame_smoke_color = (0.22, 0.21, 0.2)
        d.use_dissolve_smoke = True
        d.dissolve_speed = 38
        src = ball('FUEL', 0.24, 0.55)
        f = src.modifiers.new('Fluid', 'FLUID')
        f.fluid_type = 'FLOW'
        fs = f.flow_settings
        fs.flow_type = 'BOTH'
        fs.flow_behavior = 'INFLOW'
        fs.flow_source = 'MESH'
        fs.surface_distance = 0.12
        fs.volume_density = 1.0
        fs.fuel_amount = 2.4
        fs.density = 0.6
        fs.temperature = 2.0
        fs.use_initial_velocity = True
        fs.velocity_normal = 4.2
        fs.velocity_coord = (0, 0, 1.2)
        fs.use_inflow = True
        fs.keyframe_insert('use_inflow', frame=1)
        fs.keyframe_insert('use_inflow', frame=4)
        fs.use_inflow = False
        fs.keyframe_insert('use_inflow', frame=5)
        tex = bpy.data.textures.new('fuelnoise', 'CLOUDS')
        tex.noise_scale = 0.12
        tex.contrast = 1.4
        fs.use_texture = False
        fs.noise_texture = tex
        fs.texture_map_type = 'AUTO'
    else:  # powder
        d.vorticity = 0.35
        d.alpha = -0.35
        d.beta = 0.0
        d.use_dissolve_smoke = True
        d.use_dissolve_smoke_log = True
        d.dissolve_speed = 30
        src = ball('KICK', 0.2, 0.32)
        f = src.modifiers.new('Fluid', 'FLUID')
        f.fluid_type = 'FLOW'
        fs = f.flow_settings
        fs.flow_type = 'SMOKE'
        fs.flow_behavior = 'INFLOW'
        fs.flow_source = 'MESH'
        fs.surface_distance = 0.1
        fs.volume_density = 1.0
        fs.density = 2.5
        fs.temperature = 0.0
        fs.use_initial_velocity = True
        fs.velocity_normal = 5.5
        fs.velocity_coord = (0, 0, 2.0)
        fs.use_inflow = True
        fs.keyframe_insert('use_inflow', frame=1)
        fs.keyframe_insert('use_inflow', frame=3)
        fs.use_inflow = False
        fs.keyframe_insert('use_inflow', frame=4)
        tex = bpy.data.textures.new('kicknoise', 'CLOUDS')
        tex.noise_scale = 0.08
        tex.contrast = 1.8
        fs.use_texture = False
        fs.noise_texture = tex
        fs.texture_map_type = 'AUTO'
    src.hide_render = True
    gas_material(dom)
    return dom


def gas_material(dom):
    m = bpy.data.materials.new('GAS')
    nb = NB(m)
    dens = nb.attr('density', 'GEOMETRY', 'Fac')
    if SIM == 'powder':
        pv = nb.n('ShaderNodeVolumePrincipled')
        nb.link((0.92, 0.94, 0.97), pv.inputs['Color'])
        nb.link(nb.math('MULTIPLY', dens, 9.0), pv.inputs['Density'])
        nb.link(0.35, pv.inputs['Anisotropy'])
        pv.inputs['Density Attribute'].default_value = ''
        nb.link(pv.outputs[0], nb.out.inputs['Volume'])
    else:
        flame = nb.attr('flame', 'GEOMETRY', 'Fac')
        smoke = nb.n('ShaderNodeVolumePrincipled')
        nb.link((0.2, 0.19, 0.18), smoke.inputs['Color'])
        nb.link((0.0, 0.0, 0.0), smoke.inputs['Absorption Color'])
        nb.link(nb.math('MULTIPLY', dens, 7.0), smoke.inputs['Density'])
        smoke.inputs['Density Attribute'].default_value = ''
        smoke.inputs['Blackbody Intensity'].default_value = 0.0
        # Blackbody: the flame sheet is hottest (~2100 K), tongues cool through orange to a dull red.
        fl = nb.math('MULTIPLY', flame, 1.6, clamp=True)
        temp = nb.math('ADD', nb.math('MULTIPLY', nb.math('POWER', fl, 0.6), 1400.0), 800.0)
        bb = nb.n('ShaderNodeBlackbody', ins={'Temperature': temp})
        strength = nb.math('MULTIPLY', nb.math('POWER', fl, 1.5), 22.0)
        em = nb.n('ShaderNodeEmission', ins={'Color': bb.outputs[0], 'Strength': strength})
        add = nb.n('ShaderNodeAddShader')
        nb.link(smoke.outputs[0], add.inputs[0])
        nb.link(em.outputs[0], add.inputs[1])
        nb.link(add.outputs[0], nb.out.inputs['Volume'])
    dom.data.materials.append(m)


def bake():
    dom = build()
    os.makedirs(CACHE, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=BLEND)
    bpy.context.view_layer.objects.active = dom
    dom.select_set(True)
    with bpy.context.temp_override(object=dom, active_object=dom, selected_objects=[dom]):
        bpy.ops.fluid.bake_all()
    bpy.ops.wm.save_as_mainfile(filepath=BLEND)
    print('baked', SIM, flush=True)


def render():
    bpy.ops.wm.open_mainfile(filepath=BLEND)
    sc = FX.gpu(samples=48, transparent=True)
    sc.cycles.volume_step_rate = 0.5
    w, h = CFG['out']
    c = Vector(CFG['centre'])
    FX.ortho_cam(c, max(CFG['size']), w, h, direction=(0, 1, 0))
    passes = []
    if SIM == 'powder':
        passes = ['sky', 'sun']
    else:
        passes = ['fire']
    out = np.zeros((len(passes), len(CFG['render']), h, w, 4), np.float16)
    for pi, p in enumerate(passes):
        if p == 'fire':
            FX.world_color((0, 0, 0), 0.0)
        elif p == 'sky':
            FX.world_gradient((1.0, 1.0, 1.0), (0.35, 0.35, 0.35), 1.0)
            s = bpy.data.objects.get('SUN')
            if s:
                s.hide_render = True
        else:
            FX.world_color((0, 0, 0), 0.0)
            s = FX.sun((-0.35, -0.6, 0.72), 3.14159)
            s.hide_render = False
        for k, fr in enumerate(CFG['render']):
            sc.frame_set(fr)
            px = FX.render_np(f'{SIM}_{p}')
            out[pi, k] = px.astype(np.float16)
            print(f'{SIM} {p} frame {fr}: max {float(px[..., :3].max()):.2f} alpha {float(px[..., 3].mean()):.3f}', flush=True)
    np.save(os.path.join(FX.WORK, f'{SIM}_frames.npy'), out)
    print('frames', out.shape, flush=True)


def lookdev():
    """The sim standing in the snowfield at dusk, as Cycles sees it (the look the runtime is chasing)."""
    bpy.ops.wm.open_mainfile(filepath=BLEND)
    from lib import snowmats as SM, sky, core
    sc = FX.gpu(samples=128, transparent=False)
    FX.look_agx()
    meta = sky.world('qwantani_dusk_2_puresky', -136.6, strength=1.0)
    sc.view_settings.exposure = float(argv[2]) if len(argv) > 2 else 2.5
    b = core.Builder('GROUND', bpy.context.scene.collection)
    b.quad([(-12, -12, 0), (12, -12, 0), (12, 12, 0), (-12, 12, 0)], SM.snow_ground('snow', with_sparkle=True))
    g = b.finish()



    if SIM == 'fire':
        sc.frame_set(120)
        FX.persp_cam((2.6, -4.4, 1.5), (0, 0, 0.8), lens=40, w=960, h=720)
    elif SIM == 'fireball':
        sc.frame_set(11)
        FX.persp_cam((3.5, -6.0, 1.6), (0, 0, 1.2), lens=40, w=960, h=720)
    else:
        sc.frame_set(10)
        meta = sky.world('qwantani_sunset_puresky', -136.6, strength=1.0)
        sky.sun_lamp(meta, -136.6, 7.0)
        sc.view_settings.exposure = 0.0
        FX.persp_cam((3.5, -6.0, 1.4), (0, 0, 0.9), lens=40, w=960, h=720)
    FX.render_png(os.path.join(FX.RENDERS, f'fx_{SIM}_lookdev.png'))


{'bake': bake, 'render': render, 'lookdev': lookdev}[STAGE]()
