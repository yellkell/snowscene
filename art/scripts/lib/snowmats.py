"""Snow-world material library: Poly Haven CC0 scans at true physical scale, plus snow loading.

Tiling materials sample a metric UV layer ('WorldUV', metres) scaled by each scan's real size, so a 2 m
snow scan covers 2 m of ground whatever the mesh. `snowify` adds snow to any imported material (rocks,
bark, needles): snow settles on up-facing surfaces, broken by noise, thicker in hollows.
"""
import bpy, os, json, math
from .nodes import NB, c4

HERE = os.path.dirname(os.path.abspath(__file__))
ART = os.path.dirname(os.path.dirname(HERE))
TEX = os.path.join(ART, 'assets', 'polyhaven', 'textures')
MODELS = os.path.join(ART, 'assets', 'polyhaven', 'models')
META = json.load(open(os.path.join(TEX, '_meta.json'), encoding='utf8'))
M = {}

# Fresh snow is one of the brightest natural surfaces (albedo ~0.85-0.9); the scans are exposed for
# texture work and run darker, so their albedo is lifted toward this.
SNOW_ALBEDO = (0.86, 0.89, 0.93)
# Snow's subsurface glows blue: red is absorbed within a couple of centimetres, blue travels further.
SNOW_SSS_RADIUS = (0.6, 0.9, 1.6)
# The prevailing wind, from the west (Blender +X is east): sastrugi ridges run across it.
WIND_DIR = (1.0, 0.18)


def new(name):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    M[name] = m
    return m


_imgs = {}


def load(path, noncolor):
    key = (path, noncolor)
    if key not in _imgs:
        im = bpy.data.images.load(path, check_existing=True)
        im.colorspace_settings.name = 'Non-Color' if noncolor else 'sRGB'
        _imgs[key] = im
    return _imgs[key]


def texset(tid, res='2k'):
    d = os.path.join(TEX, tid)
    f = lambda k: os.path.join(d, f'{tid}_{k}_{res}.' + ('png' if k == 'disp' and os.path.exists(os.path.join(d, f'{tid}_disp_{res}.png')) else 'jpg'))
    size = META[tid]['size_mm'][0] / 1000.0
    out = dict(size=size)
    for k, nc in (('diff', False), ('nor_gl', True), ('rough', True), ('ao', True), ('disp', True)):
        p = f(k)
        if os.path.exists(p):
            out[k] = load(p, nc)
    return out


def metric_uv(nb, size, scale=1.0, rot=0.0, offset=(0, 0), uvname='WorldUV'):
    uvw = nb.uv(uvname)
    m = nb.n('ShaderNodeMapping', ins={'Vector': uvw, 'Scale': (1 / (size * scale),) * 3, 'Rotation': (0, 0, rot),
                                        'Location': (offset[0], offset[1], 0)})
    return m.outputs[0]


def scan(nb, ts, vec, nstr=1.0, uvname='WorldUV'):
    """(albedo, rough, ao, normal, height) sockets for a scan at `vec`."""
    d = nb.img(ts['diff'], vec).outputs['Color']
    r = nb.img(ts['rough'], vec).outputs['Color'] if 'rough' in ts else 0.6
    a = nb.img(ts['ao'], vec).outputs['Color'] if 'ao' in ts else 1.0
    h = nb.img(ts['disp'], vec).outputs['Color'] if 'disp' in ts else 0.5
    n = nb.img(ts['nor_gl'], vec).outputs['Color']
    nm = nb.n('ShaderNodeNormalMap', uv_map=uvname, ins={'Color': n, 'Strength': nstr}).outputs['Normal']
    return d, r, a, nm, h


def lift(nb, col, target, amount=1.0):
    """Push a scan's albedo toward a target mean, keeping its relative detail."""
    gain = nb.n('ShaderNodeMix', data_type='RGBA', blend_type='MULTIPLY', clamp_result=False)
    nb.link(amount, gain.inputs[0])
    nb.link(col, gain.inputs[6])
    nb.link(target, gain.inputs[7])
    return gain.outputs[2]


def sparkle(nb, scale=900.0, density=0.035):
    """Ice-crystal glints: rare voronoi cells whose normals point every which way, near-mirror smooth."""
    pos = nb.pos()
    v = nb.n('ShaderNodeTexVoronoi', feature='F1', ins={'Vector': pos, 'Scale': scale})
    pick = nb.math('LESS_THAN', v.outputs['Color'], density)  # Color is per-cell random; R channel as scalar
    rnd = nb.vmath('SUBTRACT', v.outputs['Color'], (0.5, 0.5, 0.5))
    return nb.math('GREATER_THAN', pick, 0.5), rnd


def snow_ground(name='snow_ground', with_sparkle=True):
    """The snowfield. Pristine snow is almost uniform in colour, so the albedo is fresh-snow white
    modulated by a clamped (debris-free) few percent of the snow_02 scan; its relief comes from the
    scan's normals, wind ridges across the westerly, and tens-of-metres drift from the aerial scan.
    Steep slopes facing the wind are scoured to thin patchy snow (snow_03). SSS and ice glints."""
    m = new(name)
    nb = NB(m)
    a = texset('snow_02')
    big = texset('snow_field_aerial')
    va = metric_uv(nb, a['size'])
    va2 = metric_uv(nb, a['size'], scale=2.7, rot=1.1, offset=(0.37, 0.61))
    vbig = metric_uv(nb, big['size'], scale=0.5)
    da, ra, aa, na, ha = scan(nb, a, va, 0.7)
    _, _, _, na2, ha2 = scan(nb, a, va2, 0.5)
    dbig = nb.img(big['diff'], vbig).outputs['Color']
    pos = nb.pos()
    # Tonal detail: +-3 %, the scan's dark debris clamped away.
    lum = nb.n('ShaderNodeRGBToBW', ins={'Color': da}).outputs[0]
    det = nb.mrange(lum, 0.45, 0.8, 0.95, 1.03)
    biglum = nb.n('ShaderNodeRGBToBW', ins={'Color': dbig}).outputs[0]
    drift = nb.mrange(biglum, 0.2, 0.8, 0.94, 1.03)
    patch = nb.noise(pos, 0.035, detail=3.0, rough=0.5)
    pk = nb.mrange(patch, 0.45, 0.62, 0.0, 1.0)
    shade = nb.math('MULTIPLY', det, drift)
    col = nb.mix(1.0, nb.comb(shade, shade, shade), SNOW_ALBEDO, blend='MULTIPLY')
    rough = nb.math('ADD', nb.math('MULTIPLY', ra, 0.5), 0.3)
    nrm = nb.mixv(pk, na, na2)
    ha = nb.mixf(pk, ha, ha2)
    hb = ha
    # Sastrugi: long ridges across the wind, 0.4-1.5 m apart, a few cm high.
    x, y, _ = nb.sep(pos)
    along = nb.math('ADD', nb.math('MULTIPLY', x, WIND_DIR[0]), nb.math('MULTIPLY', y, WIND_DIR[1]))
    across = nb.math('ADD', nb.math('MULTIPLY', x, -WIND_DIR[1]), nb.math('MULTIPLY', y, WIND_DIR[0]))
    # Anisotropic noise stretched along the wind: long, broken, overlapping ridges, never a ladder.
    aniso = nb.comb(nb.math('MULTIPLY', along, 0.22), nb.math('MULTIPLY', across, 2.4), 0)
    warp = nb.noise(nb.comb(nb.math('MULTIPLY', along, 0.05), nb.math('MULTIPLY', across, 0.3), 0), 1.0, detail=2.0)
    ridge = nb.noise(nb.vmath('ADD', aniso, nb.comb(0, nb.math('MULTIPLY', warp, 2.5), 0)), 1.0, detail=4.0, rough=0.55)
    ridge = nb.math('POWER', nb.mrange(ridge, 0.35, 0.75, 0.0, 1.0), 1.8)

    class _W:
        outputs = {'Fac': ridge}
    wave = _W()
    sast_mask = nb.mrange(nb.noise(pos, 0.04, detail=2.0), 0.4, 0.62, 0.0, 1.0)
    h = nb.math('ADD', nb.math('MULTIPLY', nb.mixf(pk, ha, hb), 0.6),
                nb.math('MULTIPLY', wave.outputs['Fac'], nb.math('MULTIPLY', sast_mask, 0.12)))
    nrm = nb.bump(h, strength=0.35, dist=0.04, normal=nrm)
    rough = nb.math('MULTIPLY', rough, 0.85)
    # Wind scour: on steep slopes facing the westerly, the snow is stripped thin and rock and frozen
    # gravel show through in tongues along the wind.
    gn = nb.n('ShaderNodeNewGeometry').outputs['Normal']
    gx, gy, gz = nb.sep(gn)
    steep = nb.mrange(nb.math('SUBTRACT', 1.0, gz), 0.1, 0.25, 0.0, 1.0)
    into = nb.mrange(nb.math('ADD', nb.math('MULTIPLY', gx, -WIND_DIR[0]), nb.math('MULTIPLY', gy, -WIND_DIR[1])), 0.05, 0.35, 0.0, 1.0)
    tongues = nb.noise(nb.comb(nb.math('MULTIPLY', along, 0.08), nb.math('MULTIPLY', across, 0.5), 0), 1.0, detail=5.0, rough=0.6)
    scour = nb.math('MULTIPLY', nb.math('MULTIPLY', steep, into), nb.mrange(tongues, 0.56, 0.68, 0.0, 1.0))
    rk = texset('snow_03')
    vr = metric_uv(nb, rk['size'])
    dr, rr, ar, nr, hr = scan(nb, rk, vr, 1.0)
    dr = nb.mix(0.55, nb.hsv(dr, 0.5, 0.5, 1.0), SNOW_ALBEDO)
    # thin snow lingers in the hollows of the gravel
    thin = nb.math('MULTIPLY', scour, 0.6, clamp=True)
    col = nb.mix(thin, col, dr)
    rough = nb.mixf(thin, rough, rr)
    nrm = nb.mixv(thin, nrm, nr)
    # The trodden trail (vertex attribute 'trail', 0..1 across the path): packed, footprinted snow.
    trail = nb.attr('trail', 'GEOMETRY')
    tr_ts = texset('snow_01')
    vt = metric_uv(nb, tr_ts['size'], rot=0.0)
    dt_, rt_, at_, nt_, ht_ = scan(nb, tr_ts, vt, 1.0)
    tl = nb.n('ShaderNodeRGBToBW', ins={'Color': dt_}).outputs[0]
    tcol = nb.mix(1.0, nb.comb(*(nb.mrange(tl, 0.3, 0.85, 0.82, 1.0),) * 3), SNOW_ALBEDO, blend='MULTIPLY')
    col = nb.mix(trail, col, tcol)
    nrm = nb.mixv(trail, nrm, nt_)
    rough = nb.mixf(trail, rough, nb.math('MULTIPLY', rt_, 0.8))
    # Slopes too steep for snow to lie on (> ~40 deg): bare rock, snow kept in its cracks and on ledges.
    cliffy = nb.mrange(gz, 0.66, 0.54, 0.0, 1.0)
    cliffy = nb.math('MULTIPLY', cliffy, nb.mrange(nb.noise(pos, 0.15, detail=5.0), 0.4, 0.6, 0.0, 1.0))
    # Box-projected (the ground's UVs are top-down and would smear down a cliff), at two scales blended by
    # noise so no tile repeats; cliff_side carries the big structure, rock_face the close grain.
    drf, rrf, nrf, hrf = rock_box(nb, pos, tint_sat=0.18, tint_val=0.62)
    held = nb.math('MULTIPLY', cliffy, nb.mrange(hrf, 0.55, 0.3, 1.0, 0.0))
    col = nb.mix(held, col, drf)
    rough = nb.mixf(held, rough, rrf)
    nrm = nb.mixv(held, nrm, nrf)
    thin = nb.math('MAXIMUM', thin, held)
    p = nb.bsdf(col, rough=rough, normal=nrm, sss=nb.math('SUBTRACT', 1.0, thin), out=False)
    p.inputs['Subsurface Radius'].default_value = SNOW_SSS_RADIUS
    p.inputs['Subsurface Scale'].default_value = 0.012
    shader = p.outputs[0]
    if with_sparkle:
        on, rnd = sparkle(nb)
        gl = nb.n('ShaderNodeBsdfGlossy', ins={'Roughness': 0.02,
                                               'Normal': nb.vmath('NORMALIZE', nb.vmath('ADD', nb.n('ShaderNodeNewGeometry').outputs['Normal'], nb.vmath('SCALE', rnd, s=1.6)))})
        mixs = nb.n('ShaderNodeMixShader')
        nb.link(nb.math('MULTIPLY', on, 0.85), mixs.inputs[0])
        nb.link(shader, mixs.inputs[1])
        nb.link(gl.outputs[0], mixs.inputs[2])
        shader = mixs.outputs[0]
    nb.link(shader, nb.out.inputs['Surface'])
    return m


def _box(nb, image, vec, blend=0.25, noncolor=False):
    n = nb.n('ShaderNodeTexImage', image=image, projection='BOX', projection_blend=blend, interpolation='Linear',
             extension='REPEAT', ins={'Vector': vec})
    return n.outputs['Color']


def rock_box(nb, pos, tint_sat=0.35, tint_val=0.7):
    """Cold granite on any slope: two box-projected scans at different scales, blended by noise.
    Returns (albedo, roughness, normal, height)."""
    big = texset('marble_cliff_02')
    fine = texset('rock_face')
    vb = nb.vmath('SCALE', pos, s=1 / (big['size'] * 1.0))
    vf = nb.vmath('SCALE', nb.vmath('ADD', pos, (13.7, 5.1, 2.3)), s=1 / (fine['size'] * 1.1))
    m = nb.mrange(nb.noise(pos, 0.12, detail=3.0), 0.35, 0.65, 0.0, 1.0)
    d = nb.mix(m, _box(nb, big['diff'], vb), _box(nb, fine['diff'], vf))
    r = nb.mixf(m, _box(nb, big['rough'], vb), _box(nb, fine['rough'], vf))
    h = nb.mixf(m, _box(nb, big['disp'], vb), _box(nb, fine['disp'], vf))
    # height-derived bump (box-projected normal maps would need per-axis tangents)
    nrm = nb.bump(nb.math('ADD', h, nb.math('MULTIPLY', nb.noise(pos, 3.0, detail=6.0), 0.3)), strength=0.8, dist=0.05)
    d = nb.hsv(d, 0.5, tint_sat, tint_val)
    return d, r, nrm, h


def snow_cover_mask(nb, normal_z, threshold=0.55, softness=0.18, noise_scale=3.0, bias=0.0):
    """0..1 snow cover on up-facing surfaces, its edge broken up by noise. Noise only moves the edge
    and thins the cover where the surface already faces up; a vertical face never gets speckled."""
    facing = nb.mrange(normal_z, threshold - softness - 0.15, threshold + softness, 0.0, 1.0)
    nn = nb.noise(nb.pos(), noise_scale, detail=4.0, rough=0.6)
    edge = nb.math('ADD', nb.mrange(normal_z, threshold - softness, threshold + softness, 0.0, 1.0),
                   nb.math('ADD', nb.mrange(nn, 0.35, 0.65, -0.35, 0.35), bias))
    return nb.math('MULTIPLY', nb.math('MINIMUM', nb.math('MAXIMUM', edge, 0.0), 1.0), facing, clamp=True)


def snow_shader(nb, normal=None):
    p = nb.bsdf(SNOW_ALBEDO, rough=0.55, normal=normal, sss=1.0, out=False)
    p.inputs['Subsurface Radius'].default_value = SNOW_SSS_RADIUS
    p.inputs['Subsurface Scale'].default_value = 0.01
    return p.outputs[0]


def snowify(mat, threshold=0.5, softness=0.15, noise_scale=3.0, bias=0.0, use_true_normal=True):
    """Lay snow over an existing (imported) material: surfaces facing up get snow, broken by noise.

    The original surface output is mixed with a snow BSDF; alpha (needle cards) is preserved because
    the mix happens before any alpha handling only when the original output is a Principled BSDF.
    """
    nt = mat.node_tree
    out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL' and n.is_active_output)
    src = out.inputs['Surface'].links[0].from_socket
    nb = NB.__new__(NB)
    nb.mat, nb.nt, nb.out = mat, nt, out
    geo = nb.n('ShaderNodeNewGeometry')
    ncomp = geo.outputs['True Normal' if use_true_normal else 'Normal']
    _, _, nz = nb.sep(ncomp)
    mask = snow_cover_mask(nb, nz, threshold, softness, noise_scale, bias)
    snow = snow_shader(nb)
    alpha = None
    bsdf = src.node if src.node.type == 'BSDF_PRINCIPLED' else None
    if bsdf is not None and bsdf.inputs['Alpha'].links:
        alpha = bsdf.inputs['Alpha'].links[0].from_socket
    mix = nb.n('ShaderNodeMixShader')
    nb.link(mask, mix.inputs[0])
    nb.link(src, mix.inputs[1])
    nb.link(snow, mix.inputs[2])
    final = mix.outputs[0]
    if alpha is not None:
        tr = nb.n('ShaderNodeBsdfTransparent')
        mx2 = nb.n('ShaderNodeMixShader')
        nb.link(alpha, mx2.inputs[0])
        nb.link(tr.outputs[0], mx2.inputs[1])
        nb.link(final, mx2.inputs[2])
        final = mx2.outputs[0]
        # The cut-out is now explicit; the needles' own alpha must not cut twice.
        bsdf.inputs['Alpha'].default_value = 1.0
        nt.links.remove(bsdf.inputs['Alpha'].links[0])
    nt.links.new(final, out.inputs['Surface'])
    return mask


def rock_snowy(name, tid, scale=1.0, snow_threshold=0.62, tint=(1, 1, 1)):
    """Bare rock scan at true scale with snow lying on its ledges and tops."""
    m = new(name)
    nb = NB(m)
    ts = texset(tid)
    vec = nb.n('ShaderNodeMapping', ins={'Vector': nb.texco('Object'), 'Scale': (1 / (ts['size'] * scale),) * 3}).outputs[0]
    d, r, a, n, h = (nb.img(ts['diff'], vec, ).outputs['Color'], nb.img(ts['rough'], vec).outputs['Color'],
                     nb.img(ts['ao'], vec).outputs['Color'], None, nb.img(ts['disp'], vec).outputs['Color'])
    col = nb.mix(1.0, d, tint, blend='MULTIPLY')
    col = nb.mix(0.6, col, nb.mix(1.0, col, a, blend='MULTIPLY'))
    nrm = nb.bump(h, strength=0.6, dist=0.03)
    rock = nb.bsdf(col, rough=r, normal=nrm, out=False).outputs[0]
    _, _, nz = nb.sep(nb.n('ShaderNodeNewGeometry').outputs['Normal'])
    mask = snow_cover_mask(nb, nz, snow_threshold, 0.12, 2.0)
    snow = snow_shader(nb)
    mix = nb.n('ShaderNodeMixShader')
    nb.link(mask, mix.inputs[0]); nb.link(rock, mix.inputs[1]); nb.link(snow, mix.inputs[2])
    nb.link(mix.outputs[0], nb.out.inputs['Surface'])
    return m


def world_sky(sun_elev_deg, sun_azim_deg, strength=1.0, air=1.0, dust=2.5, ozone=1.0, disc=False):
    """Nishita sky without its sun disc (the sun is a separate lamp so it can be baked on its own)."""
    w = bpy.context.scene.world or bpy.data.worlds.new('World')
    bpy.context.scene.world = w
    w.use_nodes = True
    nt = w.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    sky = nt.nodes.new('ShaderNodeTexSky')
    sky.sky_type = 'NISHITA' if hasattr(sky, 'sky_type') and 'NISHITA' in [e.identifier for e in sky.bl_rna.properties['sky_type'].enum_items] else sky.sky_type
    for k, v in (('sun_disc', disc), ('sun_elevation', math.radians(sun_elev_deg)),
                 ('sun_rotation', math.radians(sun_azim_deg)), ('air_density', air), ('dust_density', dust),
                 ('ozone_density', ozone), ('altitude', 1800.0)):
        if hasattr(sky, k):
            setattr(sky, k, v)
    bg = nt.nodes.new('ShaderNodeBackground')
    bg.inputs['Strength'].default_value = strength
    out = nt.nodes.new('ShaderNodeOutputWorld')
    nt.links.new(sky.outputs[0], bg.inputs[0])
    nt.links.new(bg.outputs[0], out.inputs[0])
    return w, sky, bg
