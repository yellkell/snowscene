"""Materials for the ice mine (VOIDSTEP): an abandoned 19th-century working inside a glacier.

Timber is hand-adzed larch gone black with age, damp and frost; iron is forged and scaled with rust;
rope is tarred hemp; the shell is glacier ice (scalloped, blue, banded with sediment) over a wet rock
floor; the pool is black meltwater.

Light channels (see cave_bake.py): every emitter here registers in EMITTERS under a channel name
('day' = the chimney's daylight and the glacier glowing with it, 'lantern', 'beacon') so a bake can switch
the channels on one at a time.
"""
import bpy, math
from .nodes import NB
from . import snowmats as SM

_M = {}
# channel -> list of (node input socket, value when on)
EMITTERS = {'day': [], 'lantern': [], 'beacon': []}

WOOD_TILE = 'wood_planks_grey'      # 1.5 m tile, five 30 cm planks (seams every 0.2 in u)
DECK_TILE = 'weathered_planks'      # 2 m tile, planks ~22 cm
PLANKS_GREY = [(0.0, 0.2), (0.2, 0.4), (0.4, 0.6), (0.6, 0.8), (0.8, 1.0)]


def emitter(channel, socket, value):
    EMITTERS[channel].append((socket, value))
    return socket


def set_channels(on):
    """Switch the emissive materials: `on` is a set of channel names (or 'all')."""
    for ch, items in EMITTERS.items():
        for sock, val in items:
            sock.default_value = val if (on == 'all' or ch in on) else 0.0


def frost_mask(nb, amount=0.6, scale=9.0):
    """Hoarfrost on surfaces that face up, patchy, plus a little on the arrises."""
    geo = nb.n('ShaderNodeNewGeometry')
    _, _, nz = nb.sep(geo.outputs['Normal'])
    up = nb.mrange(nz, 0.35, 0.85, 0.0, 1.0)
    patch = nb.mrange(nb.noise(nb.pos(), scale, detail=5.0, rough=0.65), 0.42, 0.62, 0.0, 1.0)
    fine = nb.mrange(nb.noise(nb.pos(), 160.0, detail=3.0), 0.3, 0.7, 0.4, 1.0)
    # the cold comes down the chimney: frost thickens toward the top of the works
    _, _, pz = nb.sep(nb.pos())
    high = nb.mrange(pz, 2.0, 24.0, 0.25, 1.0)
    m = nb.math('MULTIPLY', nb.math('MULTIPLY', up, patch), nb.math('MULTIPLY', fine, amount))
    return nb.math('MULTIPLY', m, high, clamp=True)


def timber(name='cave_timber', val=0.42, sat=0.55, pale=False, frost=None, tint=None):
    """Hand-adzed larch black with age. 'WoodUV' maps one plank of the scan along each face (grain along v)."""
    if name in _M:
        return _M[name]
    m = SM.new(name)
    nb = NB(m)
    ts = SM.texset(WOOD_TILE)
    vec = nb.uv('WoodUV')
    d, r, a, n, h = SM.scan(nb, ts, vec, 1.4, uvname='WoodUV')
    rnd = nb.attr('rand', 'GEOMETRY')
    pos = nb.pos()
    # grade: the grey scan pushed toward old, damp, smoke-dark larch; boards vary
    col = nb.hsv(d, 0.53, sat, val)
    warm = nb.mix(1.0, col, (0.62, 0.48, 0.36), blend='MULTIPLY')
    col = nb.mix(nb.mrange(rnd, 0.0, 1.0, 0.15, 0.85), col, warm)
    col = nb.mix(nb.mrange(nb.noise(pos, 0.7, detail=2.0), 0.3, 0.7, 0.0, 0.5), col, nb.hsv(col, 0.5, 1.0, 0.72))
    col = nb.mix(0.6, col, nb.mix(1.0, col, a, blend='MULTIPLY'))
    if pale:
        # handrails and nosings: worn pale and smooth by hands and boots
        col = nb.hsv(col, 0.49, 0.45, 1.9)
    if tint is not None:
        # keep the scan's grain, move its tone
        lum = nb.n('ShaderNodeRGBToBW', ins={'Color': col}).outputs[0]
        grain = nb.mrange(lum, 0.0, 0.25, 0.55, 1.25)
        col = nb.mix(tint[3], col, nb.mix(1.0, nb.comb(grain, grain, grain), tint[:3], blend='MULTIPLY'))
    # damp: darker and glossier toward the pool
    _, _, pz = nb.sep(pos)
    wet = nb.mrange(pz, 1.2, -0.3, 0.0, 1.0)
    col = nb.mix(nb.math('MULTIPLY', wet, 0.45), col, nb.hsv(col, 0.5, 1.1, 0.55))
    rough = nb.math('ADD', nb.math('MULTIPLY', r, 0.35), 0.58 if not pale else 0.42)
    rough = nb.mixf(nb.math('MULTIPLY', wet, 0.6), rough, 0.3)
    fr = frost_mask(nb, frost if frost is not None else (0.28 if not pale else 0.15))
    col = nb.mix(fr, col, (0.44, 0.48, 0.52))
    rough = nb.mixf(fr, rough, 0.75)
    nrm = nb.bump(h, strength=0.35, dist=0.004, normal=n)
    nb.bsdf(col, rough=rough, normal=nrm, spec=0.4)
    _M[name] = m
    return m


def endgrain(name='cave_endgrain'):
    if name in _M:
        return _M[name]
    m = SM.new(name)
    nb = NB(m)
    pos = nb.pos()
    rings = nb.n('ShaderNodeTexWave', wave_type='RINGS', ins={'Vector': nb.vmath('ADD', pos, nb.vmath('SCALE', nb.noise(pos, 2.0), s=0.03)),
                                                              'Scale': 22.0, 'Distortion': 4.0, 'Detail': 3.0})
    ch = nb.noise(pos, 60.0, detail=4.0)
    # end grain drinks the light: darker than the weathered faces round it, greyed with age, so a cut end
    # reads as the end of a timber and not as a pale hole in the join
    col = nb.mix(nb.math('MULTIPLY', rings.outputs['Fac'], 0.6), (0.04, 0.035, 0.03), (0.075, 0.062, 0.05))
    col = nb.mix(nb.mrange(ch, 0.3, 0.7, 0.0, 0.3), col, (0.03, 0.026, 0.022))
    # radial checks (drying splits)
    fr = frost_mask(nb, 0.3)
    col = nb.mix(fr, col, (0.7, 0.76, 0.82))
    nb.bsdf(col, rough=0.85, normal=nb.bump(nb.math('ADD', rings.outputs['Fac'], ch), strength=0.2, dist=0.003))
    _M[name] = m
    return m


def iron(name='cave_iron'):
    """Forged iron, black scale broken by rust that runs down from bolts and edges."""
    if name in _M:
        return _M[name]
    m = SM.new(name)
    nb = NB(m)
    pos = nb.pos()
    x, y, z = nb.sep(pos)
    blot = nb.noise(pos, 26.0, detail=6.0, rough=0.6)
    runs = nb.noise(nb.comb(nb.math('MULTIPLY', x, 40.0), nb.math('MULTIPLY', y, 40.0), nb.math('MULTIPLY', z, 3.0)), 1.0, detail=4.0)
    rust = nb.math('MAXIMUM', nb.mrange(blot, 0.5, 0.68, 0.0, 1.0), nb.mrange(runs, 0.6, 0.75, 0.0, 0.8))
    rcol = nb.mix(nb.noise(pos, 90.0), (0.16, 0.06, 0.025), (0.3, 0.13, 0.05))
    base = nb.mix(nb.noise(pos, 50.0, detail=3.0), (0.035, 0.034, 0.036), (0.07, 0.068, 0.07))
    col = nb.mix(rust, base, rcol)
    fr = frost_mask(nb, 0.15, scale=14.0)
    col = nb.mix(fr, col, (0.45, 0.48, 0.52))
    rough = nb.mixf(rust, 0.48, 0.92)
    nrm = nb.bump(nb.math('ADD', nb.math('MULTIPLY', rust, 0.4), nb.math('MULTIPLY', nb.noise(pos, 120.0, detail=4.0), 0.3)), strength=0.25, dist=0.002)
    nb.bsdf(col, rough=rough, metal=nb.mixf(rust, 0.25, 0.0), normal=nrm)
    _M[name] = m
    return m


def brass(name='cave_brass'):
    if name in _M:
        return _M[name]
    m = SM.new(name)
    nb = NB(m)
    pos = nb.pos()
    patina = nb.mrange(nb.noise(pos, 18.0, detail=5.0), 0.45, 0.65, 0.0, 1.0)
    col = nb.mix(patina, (0.33, 0.22, 0.09), (0.12, 0.16, 0.12))
    nb.bsdf(col, rough=nb.mixf(patina, 0.35, 0.8), metal=nb.mixf(patina, 0.6, 0.0))
    _M[name] = m
    return m


def steel(name='cave_steel'):
    """Rail steel: dark, rusty on the web and foot, the running top rubbed bright."""
    if name in _M:
        return _M[name]
    m = SM.new(name)
    nb = NB(m)
    pos = nb.pos()
    _, _, nz = nb.sep(nb.n('ShaderNodeNewGeometry').outputs['Normal'])
    top = nb.mrange(nz, 0.8, 0.95, 0.0, 1.0)
    rust = nb.mrange(nb.noise(pos, 20.0, detail=6.0), 0.45, 0.62, 0.2, 1.0)
    side = nb.mix(rust, (0.05, 0.048, 0.05), (0.22, 0.1, 0.045))
    col = nb.mix(top, side, (0.32, 0.31, 0.3))
    nb.bsdf(col, rough=nb.mixf(top, 0.85, 0.32), metal=nb.mixf(top, 0.1, 0.6))
    _M[name] = m
    return m


def rope(name='cave_rope', tar=1.0):
    """Tarred hemp, three strands: UVMap u runs round the rope (0..1), v along it in metres."""
    if name in _M:
        return _M[name]
    m = SM.new(name)
    nb = NB(m)
    uv = nb.uv('UVMap')
    u, v, _ = nb.sep(uv)
    lay = 0.11   # one strand's turn along the rope (m) for a ~3 cm rope
    ph = nb.math('ADD', nb.math('MULTIPLY', u, 3.0), nb.math('DIVIDE', v, lay))
    band = nb.math('FRACT', ph)
    groove = nb.math('POWER', nb.math('SINE', nb.math('MULTIPLY', band, math.pi)), 0.6)
    fib = nb.noise(nb.comb(nb.math('MULTIPLY', ph, 40.0), nb.math('MULTIPLY', v, 8.0), 0.0), 1.0, detail=5.0, rough=0.7)
    col = nb.mix(nb.mrange(fib, 0.3, 0.75, 0.0, 1.0), (0.07, 0.05, 0.032), (0.17, 0.125, 0.075))
    col = nb.mix(nb.math('SUBTRACT', 1.0, groove), col, (0.02, 0.015, 0.01))
    col = nb.mix(0.0 if tar < 0.5 else 0.25, col, (0.04, 0.03, 0.02))
    fr = frost_mask(nb, 0.35, scale=20.0)
    col = nb.mix(fr, col, (0.66, 0.7, 0.75))
    h = nb.math('ADD', groove, nb.math('MULTIPLY', fib, 0.25))
    nb.bsdf(col, rough=nb.mixf(nb.mrange(fib, 0.6, 0.8, 0.0, 1.0), 0.5, 0.9), normal=nb.bump(h, strength=0.6, dist=0.004))
    _M[name] = m
    return m


def wire_rope(name='cave_wire'):
    if name in _M:
        return _M[name]
    m = SM.new(name)
    nb = NB(m)
    u, v, _ = nb.sep(nb.uv('UVMap'))
    ph = nb.math('ADD', nb.math('MULTIPLY', u, 6.0), nb.math('DIVIDE', v, 0.08))
    groove = nb.math('POWER', nb.math('SINE', nb.math('MULTIPLY', nb.math('FRACT', ph), math.pi)), 0.5)
    rust = nb.mrange(nb.noise(nb.pos(), 12.0, detail=4.0), 0.5, 0.7, 0.0, 1.0)
    col = nb.mix(rust, (0.06, 0.06, 0.062), (0.2, 0.09, 0.04))
    col = nb.mix(nb.math('SUBTRACT', 1.0, groove), col, (0.015, 0.015, 0.015))
    nb.bsdf(col, rough=0.5, metal=nb.mixf(rust, 0.6, 0.0), normal=nb.bump(groove, strength=0.5, dist=0.002))
    _M[name] = m
    return m


def stone(name='cave_stone'):
    """Dressed granite (the brazier's plinth)."""
    if name in _M:
        return _M[name]
    m = SM.new(name)
    nb = NB(m)
    d, r, n, h = SM.rock_box(nb, nb.vmath('SCALE', nb.pos(), s=1.8), tint_sat=0.2, tint_val=0.55)
    p = nb.bsdf(d, rough=r, normal=n)
    _M[name] = m
    return m


def soot(name='cave_soot'):
    if name in _M:
        return _M[name]
    m = SM.new(name)
    nb = NB(m)
    nb.bsdf(nb.mix(nb.noise(nb.pos(), 40.0), (0.02, 0.018, 0.016), (0.06, 0.05, 0.045)), rough=0.9)
    _M[name] = m
    return m


def glass_lit(name, channel, color=(1.0, 0.62, 0.28), strength=14.0, tint=(0.9, 0.85, 0.75)):
    """Lantern glass: a little transmission-looking gloss over the light inside (emission per channel)."""
    if name in _M:
        return _M[name]
    m = SM.new(name)
    nb = NB(m)
    pos = nb.pos()
    soot_ = nb.mrange(nb.noise(pos, 30.0, detail=3.0), 0.4, 0.7, 0.0, 0.5)
    em = nb.n('ShaderNodeEmission', ins={'Color': color, 'Strength': strength})
    emitter(channel, em.inputs['Strength'], strength)
    g = nb.n('ShaderNodeBsdfGlossy', ins={'Roughness': 0.08, 'Color': tint})
    add = nb.n('ShaderNodeAddShader')
    nb.link(em.outputs[0], add.inputs[0]); nb.link(g.outputs[0], add.inputs[1])
    mx = nb.n('ShaderNodeMixShader')
    dark = nb.bsdf((0.03, 0.025, 0.02), rough=0.6, out=False)
    nb.link(soot_, mx.inputs[0]); nb.link(add.outputs[0], mx.inputs[1]); nb.link(dark.outputs[0], mx.inputs[2])
    nb.link(see_through(nb, mx.outputs[0]), nb.out.inputs['Surface'])
    _M[name] = m
    return m


def flame(name, channel, color=(1.0, 0.55, 0.18), strength=60.0):
    if name in _M:
        return _M[name]
    m = SM.new(name)
    nb = NB(m)
    em = nb.n('ShaderNodeEmission', ins={'Color': color, 'Strength': strength})
    emitter(channel, em.inputs['Strength'], strength)
    nb.link(see_through(nb, em.outputs[0]), nb.out.inputs['Surface'])
    _M[name] = m
    return m


def see_through(nb, shader):
    """Glass and flames don't shadow the lamp inside them (in every copy, baked or rendered)."""
    lp = nb.n('ShaderNodeLightPath')
    tr = nb.n('ShaderNodeBsdfTransparent')
    mx = nb.n('ShaderNodeMixShader')
    nb.link(lp.outputs['Is Shadow Ray'], mx.inputs[0])
    nb.link(shader, mx.inputs[1])
    nb.link(tr.outputs[0], mx.inputs[2])
    return mx.outputs[0]


def coals(name='cave_coals'):
    """Charred wood in the brazier: black, glowing in the cracks when the beacon burns."""
    if name in _M:
        return _M[name]
    m = SM.new(name)
    nb = NB(m)
    pos = nb.pos()
    v = nb.n('ShaderNodeTexVoronoi', feature='DISTANCE_TO_EDGE', ins={'Vector': pos, 'Scale': 30.0})
    crack = nb.mrange(v.outputs['Distance'], 0.0, 0.06, 1.0, 0.0)
    p = nb.bsdf((0.025, 0.022, 0.02), rough=0.9, out=False)
    em = nb.n('ShaderNodeEmission', ins={'Color': (1.0, 0.32, 0.06), 'Strength': 30.0})
    emitter('beacon', em.inputs['Strength'], 30.0)
    mx = nb.n('ShaderNodeMixShader')
    nb.link(crack, mx.inputs[0]); nb.link(p.outputs[0], mx.inputs[1]); nb.link(em.outputs[0], mx.inputs[2])
    nb.link(mx.outputs[0], nb.out.inputs['Surface'])
    _M[name] = m
    return m


# ---------------------------------------------------------------- the glacier
GLOW_COLOR = (0.18, 0.5, 1.0)


def ice_shell(name='cave_ice', glow=6.0):
    """Glacier ice from inside, layered over the structure modelled into the shell (lib/glacier.py):
    clear blue where it is dense and old, white and bubbly in the refrozen veins and milky layers, dark
    silt in the dirty layers, ice-polished bedrock and shore ice at the waterline; hoarfrost feathers
    on every ledge that faces up and hanging from the roofs; wet glaze low down; daylight glowing through
    where the glacier is thin. Attributes (per vertex, from the build): thin, rock, dirt, fall, milky, cusp,
    notch, crack, moulin, rim, layer."""
    if name in _M:
        return _M[name]
    m = SM.new(name)
    nb = NB(m)
    pos = nb.pos()
    x, y, z = nb.sep(pos)
    A = lambda k: nb.attr(k, 'GEOMETRY')
    thin, rock, dirt, milky_a, cusp = A('thin'), A('rock'), A('dirt'), A('milky'), A('cusp')
    notch, crack, moulin, rim, layer = A('notch'), A('crack'), A('moulin'), A('rim'), A('layer')
    fall = nb.mrange(A('fall'), 0.05, 0.4, 0.0, 1.0)
    geo = nb.n('ShaderNodeNewGeometry')
    _, _, nz = nb.sep(geo.outputs['Normal'])
    # per-layer variation: each layer its own shade of blue, its own density of bubbles
    lay_h = nb.n('ShaderNodeTexWhiteNoise', noise_dimensions='1D', ins={'W': nb.math('MULTIPLY', layer, 97.0)}).outputs['Value']
    lay_v = nb.mrange(lay_h, 0.0, 1.0, -1.0, 1.0)
    # bubble foliation within the layers (fine, broken), and a coarser milky haze
    fol_n = nb.noise(nb.comb(nb.math('MULTIPLY', x, 0.5), nb.math('MULTIPLY', y, 0.5), nb.math('MULTIPLY', z, 5.0)), 1.0, detail=4.0, rough=0.5)
    foliation = nb.math('MULTIPLY', nb.mrange(fol_n, 0.58, 0.72, 0.0, 0.3), nb.mrange(nb.noise(pos, 0.6, detail=2.0), 0.48, 0.64, 0.0, 1.0))
    bubbles = nb.mrange(nb.noise(pos, 55.0, detail=2.0), 0.6, 0.72, 0.0, 1.0)
    milky = nb.math('MAXIMUM', milky_a, nb.math('MAXIMUM', foliation, nb.math('MULTIPLY', bubbles, 0.25)))
    # clear glacier ice: deep blue, a little lighter or darker per layer; deeper still in the cracks and
    # undercuts, where you look into thicker ice
    base = nb.mix(nb.mrange(lay_v, -1.0, 1.0, 0.0, 1.0), (0.05, 0.16, 0.33), (0.11, 0.29, 0.46))
    ice_col = nb.mix(nb.math('MULTIPLY', cusp, 0.35), base, (0.24, 0.4, 0.54))
    ice_col = nb.mix(nb.math('MAXIMUM', nb.math('MULTIPLY', notch, 1.5), crack), ice_col, (0.02, 0.09, 0.22))
    ice_col = nb.mix(milky, ice_col, (0.5, 0.6, 0.67))
    ice_col = nb.mix(nb.math('MULTIPLY', fall, 0.6), ice_col, (0.3, 0.48, 0.62))
    ice_col = nb.mix(nb.math('MULTIPLY', moulin, 0.5), ice_col, (0.1, 0.3, 0.5))
    # silt: grey-black grit, smeared along the layer, stones frozen in (the big ones are real rocks)
    grit = nb.noise(pos, 16.0, detail=6.0, rough=0.7)
    smear = nb.noise(nb.comb(nb.math('MULTIPLY', x, 3.0), nb.math('MULTIPLY', y, 14.0), nb.math('MULTIPLY', z, 3.0)), 1.0, detail=3.0)
    dcol = nb.mix(nb.mrange(grit, 0.35, 0.65, 0.0, 1.0), (0.03, 0.034, 0.04), (0.12, 0.12, 0.125))
    dk = nb.math('MULTIPLY', dirt, nb.mrange(nb.math('ADD', grit, nb.math('MULTIPLY', smear, 0.5)), 0.35, 0.8, 0.2, 1.0), clamp=True)
    col = nb.mix(dk, ice_col, dcol)
    # shore ice: white, rough-frozen
    col = nb.mix(rim, col, (0.58, 0.66, 0.72))
    # bedrock at the waterline: ice-polished, dark, wet; gravel in its hollows
    gts = SM.texset('rocky_trail')
    gvec = nb.vmath('SCALE', pos, s=1 / gts['size'])
    gdiff = nb.n('ShaderNodeTexImage', image=gts['diff'], projection='BOX', projection_blend=0.3, ins={'Vector': gvec}).outputs['Color']
    gdisp = nb.n('ShaderNodeTexImage', image=gts['disp'], projection='BOX', projection_blend=0.3, ins={'Vector': gvec}).outputs['Color']
    rts = SM.texset('rock_face_03')
    rvec = nb.vmath('SCALE', pos, s=1 / rts['size'])
    rdiff = nb.n('ShaderNodeTexImage', image=rts['diff'], projection='BOX', projection_blend=0.3, ins={'Vector': rvec}).outputs['Color']
    bed = nb.mix(nb.mrange(nb.noise(pos, 1.5, detail=2.0), 0.4, 0.6, 0.0, 1.0), nb.hsv(rdiff, 0.5, 0.25, 0.35), nb.hsv(gdiff, 0.5, 0.3, 0.38))
    col = nb.mix(rock, col, bed)
    wet = nb.mrange(z, 0.7, -0.3, 0.0, 1.0)
    col = nb.mix(nb.math('MULTIPLY', wet, nb.math('MAXIMUM', rock, 0.3)), col, nb.hsv(col, 0.5, 1.1, 0.55))
    # hoarfrost: feathers on every shelf that faces up, and hanging in tufts from the roofs
    up = nb.mrange(nz, 0.5, 0.85, 0.0, 1.0)
    roof = nb.mrange(nz, -0.55, -0.85, 0.0, 1.0)
    feather = nb.noise(nb.comb(nb.math('MULTIPLY', x, 40.0), nb.math('MULTIPLY', y, 40.0), nb.math('MULTIPLY', z, 12.0)), 1.0, detail=3.0)
    patch = nb.mrange(nb.noise(pos, 2.5, detail=3.0), 0.4, 0.62, 0.0, 1.0)
    hoar = nb.math('MULTIPLY', nb.math('MAXIMUM', up, nb.math('MULTIPLY', roof, 0.7)), nb.math('MULTIPLY', patch, nb.mrange(feather, 0.35, 0.65, 0.3, 1.0)))
    hoar = nb.math('MULTIPLY', hoar, nb.math('SUBTRACT', 1.0, nb.math('MULTIPLY', wet, 0.9)), clamp=True)
    col = nb.mix(hoar, col, (0.68, 0.74, 0.8))
    # surface: wet, polished ice; frost and silt rough; rock as wet as its height says
    rough = nb.mrange(cusp, 0.0, 1.0, 0.05, 0.14)
    rough = nb.mixf(dk, rough, 0.6)
    rough = nb.mixf(hoar, rough, 0.75)
    rough = nb.mixf(rock, rough, nb.mixf(wet, 0.65, 0.22))
    # fine relief the grid doesn't carry: little scallops in the big ones, grit, feathers, the bed's grain
    v1 = nb.n('ShaderNodeTexVoronoi', feature='F1', ins={'Vector': nb.vmath('ADD', pos, nb.vmath('SCALE', nb.noise(pos, 0.8), s=0.2)), 'Scale': 9.0, 'Randomness': 0.9})
    fine = nb.math('MULTIPLY', nb.math('POWER', v1.outputs['Distance'], 2.0), nb.math('SUBTRACT', 1.0, rock))
    h = nb.math('ADD', fine, nb.math('MULTIPLY', nb.math('ADD', grit, feather), nb.math('MAXIMUM', nb.math('MULTIPLY', dk, 0.15), nb.math('MULTIPLY', hoar, 0.1))))
    nrm = nb.bump(h, strength=0.35, dist=0.02)
    nrm = nb.n('ShaderNodeBump', ins={'Strength': nb.math('MULTIPLY', rock, 0.8), 'Distance': 0.04, 'Height': gdisp, 'Normal': nrm}).outputs[0]
    p = nb.bsdf(col, rough=rough, normal=nrm, ior=1.31, out=False, spec=0.55)
    # daylight through the glacier where it is thin: cold cyan, whiter in the bubbly ice
    gl = nb.math('MULTIPLY', thin, nb.mixf(milky, 1.0, 1.2))
    gl = nb.math('MULTIPLY', gl, nb.math('SUBTRACT', 1.0, nb.math('MAXIMUM', nb.math('MAXIMUM', rock, dk), hoar)))
    em_col = nb.mix(nb.math('MULTIPLY', milky, 0.6), GLOW_COLOR, (0.5, 0.75, 1.0))
    em = nb.n('ShaderNodeEmission', ins={'Color': em_col})
    val = nb.n('ShaderNodeValue')
    val.outputs[0].default_value = 1.0
    val.name = 'GLOW_SWITCH'
    emitter('day', val.outputs[0], 1.0)
    nb.link(nb.math('MULTIPLY', nb.math('MULTIPLY', gl, glow), val.outputs[0]), em.inputs['Strength'])
    add = nb.n('ShaderNodeAddShader')
    nb.link(p.outputs[0], add.inputs[0]); nb.link(em.outputs[0], add.inputs[1])
    nb.link(add.outputs[0], nb.out.inputs['Surface'])
    m['glow'] = glow
    _M[name] = m
    return m


def clear_ice(name='cave_icicle'):
    """Icicles and icefall drips: clear, wet, a little milky at the root."""
    if name in _M:
        return _M[name]
    m = SM.new(name)
    nb = NB(m)
    pos = nb.pos()
    rip = nb.noise(nb.comb(*[nb.math('MULTIPLY', c, k) for c, k in zip(nb.sep(pos), (30.0, 30.0, 6.0))]), 1.0, detail=4.0)
    # clear ice: mostly what's behind it and what it reflects; milky where it froze fast (the root)
    col = nb.mix(nb.mrange(rip, 0.4, 0.7, 0.0, 1.0), (0.36, 0.52, 0.64), (0.55, 0.68, 0.76))
    p = nb.bsdf(col, rough=0.05, normal=nb.bump(rip, strength=0.3, dist=0.004), ior=1.31, out=False, spec=0.7)
    nb.link(p.outputs[0], nb.out.inputs['Surface'])
    _M[name] = m
    return m


def water(name='cave_water'):
    """Black meltwater: almost no diffuse, a clean mirror with a faint shiver."""
    if name in _M:
        return _M[name]
    m = SM.new(name)
    nb = NB(m)
    pos = nb.pos()
    rip = nb.noise(pos, 3.0, detail=3.0)
    p = nb.bsdf((0.004, 0.006, 0.008), rough=0.015, normal=nb.bump(rip, strength=0.05, dist=0.02), ior=1.33, spec=0.5)
    _M[name] = m
    return m
