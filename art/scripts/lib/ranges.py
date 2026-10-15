"""The great ranges round the tutorial (far-ranges.ts farHeight via art/work/heights_ranges.*): the ring
mesh and its kilometre-scale winter material. The rim (r < PANO_MIN_R) is real geometry in the game; the
rest is the vista panorama (vista_build.py)."""
import bpy, os, json, math
import numpy as np
from . import snowmats as SM
from .nodes import NB

WORK = os.path.join(SM.ART, 'work')
META = json.load(open(os.path.join(WORK, 'heights_ranges.json')))
HD_ALL = np.fromfile(os.path.join(WORK, 'heights_ranges.bin'), dtype=np.float32).reshape(len(META['radii']), META['na'])
WORLD_ROT = 0.0
SKY_EXR = os.path.join(WORK, 'sky_qwantani_sunset_puresky_nosun.exr')

PANO_MIN_R = 2800.0  # nearer than this the rim is real (baked) geometry in the game: parallax


def erosion(HD, R, A, fade_r=(1500.0, 2500.0)):
    """Mid-scale relief the smooth height function lacks, for the near ranges: ribs and gullies running
    down the fall line (ridged noise stretched along the slope, so it reads as water- and avalanche-cut
    rock), a few metres to ~25 m deep, scaled by how steep the mountain is there, fading out before the
    panorama takes over so the two still meet."""
    from .cliff import fbm
    dr = np.gradient(HD, axis=0) / np.maximum(np.gradient(R, axis=0), 1e-3)
    da = np.gradient(HD, axis=1) / np.maximum(R * (2 * math.pi / HD.shape[1]), 1e-3)
    slope = np.sqrt(dr * dr + da * da)
    arc = A * R                                              # around the ring, metres
    # mostly radial fall lines: fine across the slope, long down it
    u, v = arc / 38.0, R / 210.0
    rib = 1 - np.abs(fbm(u, v, 4, 91))                       # ridged: sharp crests, broad troughs
    rib = rib * rib
    gully = np.abs(fbm(arc / 95.0 + 13.0, R / 420.0, 3, 97))
    shelf = fbm(arc / 300.0, R / 60.0, 3, 103)               # benches across the slope
    amp = np.clip(slope, 0.0, 1.6) * 16.0 + 2.0
    fade = 1 - np.clip((R - fade_r[0]) / (fade_r[1] - fade_r[0]), 0, 1)
    fade = fade * np.clip((R - 358.0) / 45.0, 0, 1)            # meet the bowl's own terrain where it starts
    return HD + (rib * 1.0 - gully * 0.6 + shelf * 0.25) * amp * fade


def ranges_mesh(min_r=PANO_MIN_R, max_r=1e9, name='RANGES', coll=None, step=1, erode=False, ground=None,
                blend=(355.0, 470.0)):
    """`ground(x, y)` (Blender coords): the bowl's own terrain; the rim's inner rings ease from it up to the
    ranges, so the mountains rise out of the bowl instead of starting as a sheet hanging in the air."""
    r_all = np.array(META['radii'])
    keep = (r_all >= min_r) & (r_all <= max_r)
    radii = r_all[keep]
    HD = HD_ALL[keep][:, ::step]
    na = META['na'] // step
    cx, cz = META['center']
    a = np.arange(na) / na * 2 * math.pi
    R, A = np.meshgrid(radii, a, indexing='ij')
    if ground is not None:
        inner = R < blend[1]
        gx_, gz_ = cx + np.cos(A[inner]) * R[inner], cz + np.sin(A[inner]) * R[inner]
        hg = np.array([ground(x, -z) for x, z in zip(gx_, gz_)])
        tt = np.clip((R[inner] - blend[0]) / (blend[1] - blend[0]), 0, 1)
        tt = tt * tt * (3 - 2 * tt)
        HD = HD.copy()
        HD[inner] = hg + (HD[inner] - hg) * tt
    if erode:
        HD = erosion(HD, R, A)
    gx = cx + np.cos(A) * R
    gz = cz + np.sin(A) * R
    verts = np.stack([gx, -gz, HD], -1).reshape(-1, 3)
    nr = len(radii)
    I, J = np.meshgrid(np.arange(na), np.arange(nr - 1))
    a0 = J * na + I
    a1 = J * na + (I + 1) % na
    quads = np.stack([a0, a1, a1 + na, a0 + na], -1).reshape(-1, 4)
    me = bpy.data.meshes.new('ranges')
    me.vertices.add(len(verts))
    me.vertices.foreach_set('co', verts.astype(np.float32).ravel())
    me.loops.add(quads.size)
    me.loops.foreach_set('vertex_index', quads.astype(np.int32).ravel())
    me.polygons.add(len(quads))
    me.polygons.foreach_set('loop_start', (np.arange(len(quads)) * 4).astype(np.int32))
    me.polygons.foreach_set('loop_total', np.full(len(quads), 4, np.int32))
    me.update(calc_edges=True)
    me.polygons.foreach_set('use_smooth', np.ones(len(quads), bool))
    me.validate()
    if me.polygons[len(quads) // 2].normal.z < 0:
        me.flip_normals()
    ob = bpy.data.objects.new(name, me)
    (coll or bpy.context.scene.collection).objects.link(ob)
    me.materials.append(mountain_material())
    return ob


def mountain_material():
    """Kilometre-scale alpine rock and snow: aerial scans for both, snow wherever it can lie (and
    corniced on the ridges), rock on faces too steep for it, a rock band texture on the giants' walls."""
    m = SM.new('mountain')
    nb = NB(m)
    pos = nb.pos()
    rock = SM.texset('aerial_rocks_02')
    snow = SM.texset('snow_field_aerial')
    big = nb.n('ShaderNodeTexImage', image=rock['diff'], projection='BOX', projection_blend=0.3,
               ins={'Vector': nb.vmath('SCALE', pos, s=1 / (rock['size'] * 4))}).outputs['Color']
    fine = nb.n('ShaderNodeTexImage', image=rock['diff'], projection='BOX', projection_blend=0.3,
                ins={'Vector': nb.vmath('SCALE', nb.vmath('ADD', pos, (311.0, 97.0, 13.0)), s=1 / (rock['size'] * 0.6))}).outputs['Color']
    # and the walls up close (the rim is 400 m away): a cliff scan at ~20 m, on the steep faces
    cliff = SM.texset('marble_cliff_02')
    near = nb.n('ShaderNodeTexImage', image=cliff['diff'], projection='BOX', projection_blend=0.35,
                ins={'Vector': nb.vmath('SCALE', nb.vmath('ADD', pos, (53.0, 17.0, 29.0)), s=1 / (cliff['size'] * 3.0))}).outputs['Color']
    rcol = nb.hsv(nb.mix(0.38, nb.mix(0.5, big, fine), near), 0.55, 0.12, 0.32)
    scol = nb.n('ShaderNodeTexImage', image=snow['diff'], projection='BOX', projection_blend=0.3,
                ins={'Vector': nb.vmath('SCALE', pos, s=1 / (snow['size'] * 2))}).outputs['Color']
    lum = nb.n('ShaderNodeRGBToBW', ins={'Color': scol}).outputs[0]
    scol = nb.mix(1.0, nb.comb(*(nb.mrange(lum, 0.2, 0.9, 0.82, 1.0),) * 3), SM.SNOW_ALBEDO, blend='MULTIPLY')
    _, _, nz = nb.sep(nb.n('ShaderNodeNewGeometry').outputs['Normal'])
    hgt = nb.n('ShaderNodeTexImage', image=rock['disp'], projection='BOX', projection_blend=0.3,
               ins={'Vector': nb.vmath('SCALE', pos, s=1 / (rock['size'] * 1.5))}).outputs['Color']
    # snow lies below ~50 degrees, and fills the hollows a little steeper than that
    # winter: snow clings to everything gentler than ~60 degrees, rock shows on the walls and aretes
    lie = nb.mrange(nz, 0.18, 0.34, 0.0, 1.0)
    lie = nb.math('ADD', lie, nb.math('MULTIPLY', nb.mrange(hgt, 0.5, 0.3, 0.0, 0.45), nb.mrange(nz, 0.25, 0.4, 0.0, 1.0)), clamp=True)
    # Steep faces: dark rock threaded with snow-filled couloirs (vertical streaks) and ledges.
    x, y, z = nb.sep(pos)
    streak = nb.noise(nb.comb(nb.math('MULTIPLY', x, 1 / 90.0), nb.math('MULTIPLY', y, 1 / 90.0), nb.math('MULTIPLY', z, 1 / 900.0)), 1.0, detail=5.0, rough=0.6)
    ledge = nb.noise(nb.comb(nb.math('MULTIPLY', x, 1 / 400.0), nb.math('MULTIPLY', y, 1 / 400.0), nb.math('MULTIPLY', z, 1 / 35.0)), 1.0, detail=4.0, rough=0.6)
    gully = nb.math('MAXIMUM', nb.mrange(streak, 0.52, 0.6, 0.0, 1.0), nb.mrange(ledge, 0.6, 0.66, 0.0, 0.9))
    lie = nb.math('MAXIMUM', lie, nb.math('MULTIPLY', gully, nb.mrange(nz, -0.1, 0.25, 0.0, 1.0)))
    nrm = nb.bump(nb.math('ADD', hgt, nb.math('MULTIPLY', nb.noise(pos, 0.01, detail=8.0, rough=0.6), 2.0)), strength=0.6, dist=8.0)
    col = nb.mix(lie, rcol, scol)
    p = nb.bsdf(col, rough=nb.mixf(lie, 0.85, 0.55), normal=nrm, out=False)
    # Aerial perspective: light from the surface fades with distance and the air between glows with the
    # horizon's own colour (transmittance exp(-d / 18 km)).
    dist = nb.n('ShaderNodeCameraData').outputs['View Distance']
    fog = nb.math('SUBTRACT', 1.0, nb.math('EXPONENT', nb.math('DIVIDE', dist, -32000.0)))
    # the air takes the colour of the sky behind it: look the photographed sky up along the view
    # direction, flattened to just above the horizon (same turn as the world mapping)
    inc = nb.n('ShaderNodeNewGeometry').outputs['Incoming']
    ix, iy, iz = nb.sep(inc)
    hdir = nb.vmath('NORMALIZE', nb.comb(nb.math('MULTIPLY', ix, -1.0), nb.math('MULTIPLY', iy, -1.0), 0.03))
    mp = nb.n('ShaderNodeMapping', ins={'Vector': hdir, 'Rotation': (0, 0, WORLD_ROT)})
    env = nb.n('ShaderNodeTexEnvironment', image=bpy.data.images.load(SKY_EXR, check_existing=True),
               ins={'Vector': mp.outputs[0]}).outputs['Color']
    em = nb.n('ShaderNodeEmission', ins={'Color': env, 'Strength': 1.0})
    mx = nb.n('ShaderNodeMixShader')
    nb.link(fog, mx.inputs[0]); nb.link(p.outputs[0], mx.inputs[1]); nb.link(em.outputs[0], mx.inputs[2])
    nb.link(mx.outputs[0], nb.out.inputs['Surface'])
    return m


