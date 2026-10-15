"""Creature materials (Cycles) with the runtime channels the realtime shader is baked from.

Every material here renders its full look in Cycles (Principled, SSS, transmission, scans...) and also
registers three hidden Emission nodes, RT_albedo, RT_gloss and RT_emit, carrying what the game's shader
needs: the diffuse colour as it should read under the game's analytic light, a 0..1 gloss, and an emission
mask (emission strength / EMIT_MAX, in the kind's accent colour). `channel(ch)` routes one of them (or the
beauty shader) to every creature material's output, so a plain EMIT bake writes it into the atlas.

Masks come from mesh attributes written by lib/critter.py (Attribute nodes read 0 when a piece lacks one):
  eye   compound eyes / ocelli         tip   horn, fang or spine tips (accent material)
  glow  emissive zone                  groove  crevices of the modelled relief (frost settles there)
  crack rock fissures (magma shows)    ice   ice crust / rime zone           plate  sclerites on a membrane
"""
import bpy
from .nodes import NB, c4
from . import snowmats as SM

EMIT_MAX = 8.0
RIME = (0.80, 0.85, 0.92)
MATS = []


def _col(v):
    if isinstance(v, (int, float)):
        return (v, v, v, 1.0)
    return c4(v)


def _link(nb, v, sock):
    if isinstance(v, (int, float)) and sock.type == 'RGBA':
        sock.default_value = _col(v)
    else:
        nb.link(v, sock)


def rt(nb, beauty, albedo, gloss, emit, volume=None):
    for k, v in (('albedo', albedo), ('gloss', gloss), ('emit', emit)):
        e = nb.n('ShaderNodeEmission')
        e.name = 'RT_' + k
        _link(nb, v, e.inputs['Color'])
        e.inputs['Strength'].default_value = 1.0
    # gloss and emission share one bake: R gloss, G emission
    ge = nb.n('ShaderNodeCombineColor')
    _link(nb, gloss, ge.inputs[0])
    _link(nb, emit, ge.inputs[1])
    e = nb.n('ShaderNodeEmission')
    e.name = 'RT_ge'
    nb.link(ge.outputs[0], e.inputs['Color'])
    r = nb.n('NodeReroute')
    r.name = 'RT_beauty'
    nb.link(beauty, r.inputs[0])
    nb.link(r.outputs[0], nb.out.inputs['Surface'])
    if volume is not None:
        nb.link(volume, nb.out.inputs['Volume'])
    MATS.append(nb.mat)


def channel(ch):
    """'beauty', 'albedo', 'gloss', 'emit' or 'ge' (gloss in R, emission in G) on every creature material."""
    for m in MATS:
        nt = m.node_tree
        out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
        src = nt.nodes['RT_beauty'] if ch == 'beauty' else nt.nodes['RT_' + ch]
        nt.links.new(src.outputs[0], out.inputs['Surface'])
        # volumes only belong to the beauty look
        vol = nt.nodes.get('RT_volume')
        if vol is not None:
            if ch == 'beauty':
                nt.links.new(vol.outputs[0], out.inputs['Volume'])
            else:
                for l in list(out.inputs['Volume'].links):
                    nt.links.remove(l)


def attr(nb, name):
    return nb.attr(name)


def clamp01(nb, v):
    return nb.math('MAXIMUM', nb.math('MINIMUM', v, 1.0), 0.0)


def frost(nb, col, rough, nrm, amount=1.0, crev=0.06, up=0.55, scale=1.0, extra=None, groove_w=0.3):
    """Hoarfrost: feathery rime settling in crevices (short-range AO), in the modelled grooves and on surfaces
    facing up, broken up so it reads as grown, not painted. Returns (col, rough, normal, mask)."""
    if amount <= 0:
        return col, rough, nrm, 0.0
    pos = nb.texco('Object')
    ao = nb.ao(dist=crev, samples=16)
    cav = nb.mrange(ao, 0.45, 0.92, 1.0, 0.0)
    _, _, nz = nb.sep(nb.n('ShaderNodeNewGeometry').outputs['Normal'])
    upf = nb.mrange(nz, up, 1.0, 0.0, 1.0)
    groove = attr(nb, 'groove')
    brk = nb.noise(pos, 9.0 * scale, detail=6.0, rough=0.68)
    brk2 = nb.noise(pos, 40.0 * scale, detail=3.0, rough=0.5)
    s = nb.math('ADD', nb.math('MULTIPLY', cav, 0.42), nb.math('MULTIPLY', groove, groove_w))
    s = nb.math('ADD', s, nb.math('MULTIPLY', upf, 0.62))
    if extra is not None:
        s = nb.math('ADD', s, extra)
    s = nb.math('ADD', s, nb.math('MULTIPLY', nb.math('SUBTRACT', brk, 0.5), 1.5))
    s = nb.math('ADD', s, nb.math('MULTIPLY', nb.math('SUBTRACT', brk2, 0.5), 0.6))
    m = nb.mrange(s, 0.62, 0.95, 0.0, 1.0)
    m = nb.math('MULTIPLY', m, amount, clamp=True)
    # a fine powder of hoarfrost on everything facing the sky, thinner than the rime
    pw = nb.math('MULTIPLY', nb.mrange(nz, 0.15, 0.9, 0.0, 1.0), nb.mrange(brk2, 0.35, 0.75, 0.0, 1.0))
    pw = nb.math('MULTIPLY', pw, 0.2 * amount)
    col = nb.mix(pw, col, RIME)
    # rime is crystalline: tiny facets (bump) and a faint blue in its depth
    vor = nb.n('ShaderNodeTexVoronoi', feature='F1', ins={'Vector': pos, 'Scale': 900.0 * scale})
    hrime = nb.math('ADD', nb.math('MULTIPLY', vor.outputs['Distance'], 0.6), nb.math('MULTIPLY', brk2, 0.4))
    rc = nb.mix(nb.mrange(brk2, 0.3, 0.7, 0.0, 1.0), (0.70, 0.78, 0.88), RIME)
    col = nb.mix(m, col, rc)
    rough = nb.mixf(m, rough, 0.72)
    nrm = nb.bump(nb.math('MULTIPLY', hrime, m), strength=0.5, dist=0.002, normal=nrm)
    return col, rough, nrm, m


def chitin(name, **kw):
    """Arthropod cuticle: dark mottled sclerite, wax-glossy, pitted, paler and duller where edges are worn, frost
    in the relief. Zones by attribute: eyes (glossy black, faint eyeshine), tips (horn / fang / spine), glow."""
    m = SM.new(name)
    nb = NB(m)
    c = _chitin(nb, **kw)
    rt(nb, *c)
    return m


def _chitin(nb, base, alt, edge, gloss=0.6, frost_amt=0.8, scale=1.0, pits=1.0, film=None, metallic=0.0,
            tip_col=None, tip_gloss=0.7, tip_emit=0.0, glow_str=0.0, accent=(1, 1, 1), eye_emit=0.25,
            sss=0.0, wear=1.0, membrane=(0.05, 0.047, 0.045), frost_groove=0.3, powder=1.0):
    pos = nb.texco('Object')
    geo = nb.n('ShaderNodeNewGeometry')
    mott = nb.noise(pos, 5.0 * scale, detail=5.0, rough=0.6)
    mott2 = nb.noise(pos, 23.0 * scale, detail=3.0, rough=0.5)
    col = nb.mix(nb.mrange(mott, 0.35, 0.68, 0.0, 1.0), base, alt)
    col = nb.mix(nb.math('MULTIPLY', nb.mrange(mott2, 0.4, 0.7, 0.0, 1.0), 0.35), col, nb.hsv(col, 0.5, 0.9, 0.8))
    groove = attr(nb, 'groove')
    # articulations: soft, matte, paler membrane between the plates
    col = nb.mix(nb.math('MULTIPLY', groove, 0.85), col, membrane)
    # worn edges: convex rims scuffed paler and matte
    pt = nb.mrange(geo.outputs['Pointiness'], 0.505, 0.56, 0.0, 1.0)
    wn = nb.mrange(nb.noise(pos, 30.0 * scale, detail=4.0), 0.4, 0.62, 0.2, 1.0)
    wearm = nb.math('MULTIPLY', nb.math('MULTIPLY', pt, wn), wear, clamp=True)
    col = nb.mix(wearm, col, edge)
    rough = nb.math('ADD', 0.14 + 0.36 * (1 - gloss), nb.math('MULTIPLY', nb.mrange(mott2, 0.2, 0.8, 0.0, 1.0), 0.12))
    rough = nb.mixf(wearm, rough, 0.6)
    rough = nb.mixf(groove, rough, 0.75)
    # relief: shallow setal pits, growth wrinkles, orange-peel wax
    vor = nb.n('ShaderNodeTexVoronoi', feature='F1', ins={'Vector': pos, 'Scale': 160.0 * scale})
    pit = nb.mrange(vor.outputs['Distance'], 0.0, 0.22, 0.0, 1.0)
    wr = nb.noise(nb.vmath('MULTIPLY', pos, (1.0, 1.0, 4.0)), 45.0 * scale, detail=4.0, rough=0.6)
    peel = nb.noise(pos, 420.0 * scale, detail=2.0)
    fuzz = nb.noise(pos, 1400.0 * scale, detail=1.0)
    h = nb.math('ADD', nb.math('MULTIPLY', pit, 0.5 * pits), nb.math('MULTIPLY', wr, 0.35))
    h = nb.math('ADD', h, nb.math('MULTIPLY', peel, 0.12))
    h = nb.math('ADD', h, nb.math('MULTIPLY', fuzz, 0.1))
    nrm = nb.bump(h, strength=0.45, dist=0.004)
    gl = nb.math('SUBTRACT', 1.0, nb.math('MAXIMUM', wearm, groove))
    gl = nb.math('MULTIPLY', gl, gloss)
    emit = 0.0
    estr = 0.0
    # tips: horn, fangs, spines
    if tip_col is not None:
        tip = attr(nb, 'tip')
        col = nb.mix(tip, col, tip_col)
        rough = nb.mixf(tip, rough, 0.18 + 0.4 * (1 - tip_gloss))
        gl = nb.mixf(tip, gl, tip_gloss)
        if tip_emit:
            estr = nb.math('MULTIPLY', nb.math('POWER', tip, 2.0), tip_emit)
    if glow_str:
        g = nb.math('MULTIPLY', attr(nb, 'glow'), glow_str)
        estr = g if estr == 0.0 else nb.math('ADD', estr, g)
    col, rough, nrm, fm = frost(nb, col, rough, nrm, frost_amt, scale=scale, groove_w=frost_groove)
    if frost_amt > 0:
        gl = nb.math('MULTIPLY', gl, nb.math('SUBTRACT', 1.0, fm))
    # eyes last: frost does not sit on a living eye
    eye = attr(nb, 'eye')
    col = nb.mix(eye, col, (0.008, 0.009, 0.012))
    rough = nb.mixf(eye, rough, 0.04)
    gl = nb.mixf(eye, gl, 1.0)
    es = nb.math('MULTIPLY', nb.math('POWER', eye, 3.0), eye_emit)
    estr = es if estr == 0.0 else nb.math('ADD', estr, es)
    p = nb.bsdf(col, rough=rough, metal=metallic, normal=nrm, ecol=accent, estr=estr, coat=nb.math('MULTIPLY', gl, 0.35),
                coat_rough=0.12, out=False, sss=sss)
    if sss:
        p.inputs['Subsurface Radius'].default_value = (0.4, 0.2, 0.12)
        p.inputs['Subsurface Scale'].default_value = 0.01
    if film is not None:
        nb.link(film, p.inputs['Thin Film Thickness'])
        p.inputs['Thin Film IOR'].default_value = 1.56
    return p.outputs[0], col, gl, (nb.math('DIVIDE', estr, EMIT_MAX) if estr != 0.0 else 0.0)


def ice(name, **kw):
    """Clear blue ice with fractures, frosted where the air touches it in hollows and on tops."""
    m = SM.new(name)
    nb = NB(m)
    c = _ice(nb, **kw)
    rt(nb, *c)
    return m


def chitin_ice(name, chitin_kw, ice_kw):
    """Cuticle crusted with ice where the 'ice' attribute says (the crust is modelled; the body shows through)."""
    m = SM.new(name)
    nb = NB(m)
    a = _chitin(nb, **chitin_kw)
    b = _ice(nb, **ice_kw)
    k = attr(nb, 'ice')
    mix = nb.n('ShaderNodeMixShader')
    nb.link(k, mix.inputs[0]); nb.link(a[0], mix.inputs[1]); nb.link(b[0], mix.inputs[2])
    alb = nb.mix(k, a[1], b[1])
    gl = nb.mixf(k, a[2], b[2])
    e = nb.mixf(k, a[3], b[3])
    rt(nb, mix.outputs[0], alb, gl, e, volume=b[4])
    return m


def _ice(nb, tint=(0.82, 0.93, 1.0), absorb=(0.45, 0.72, 1.0), density=5.0, rough=0.06, frost_amt=0.7,
         rt_albedo=(0.30, 0.40, 0.48), accent=(1, 1, 1), glow_str=0.0, scale=1.0, ior=1.31):
    pos = nb.texco('Object')
    n1 = nb.noise(pos, 14.0 * scale, detail=5.0, rough=0.6)
    vor = nb.n('ShaderNodeTexVoronoi', feature='DISTANCE_TO_EDGE', ins={'Vector': pos, 'Scale': 9.0 * scale})
    frac = nb.mrange(vor.outputs['Distance'], 0.0, 0.03, 1.0, 0.0)
    r = nb.math('ADD', rough, nb.math('MULTIPLY', nb.mrange(n1, 0.3, 0.7, 0.0, 1.0), 0.18))
    h = nb.math('ADD', nb.math('MULTIPLY', n1, 0.3), nb.math('MULTIPLY', frac, 0.2))
    nrm = nb.bump(h, strength=0.25, dist=0.004)
    col = nb.mix(frac, tint, (0.95, 0.98, 1.0))
    alb = nb.mix(frac, rt_albedo, (0.62, 0.70, 0.78))
    alb, r2, nrm2, fm = frost(nb, alb, r, nrm, frost_amt, crev=0.05, up=0.5, scale=scale)
    glass = nb.bsdf(col, rough=r, normal=nrm, ior=ior, trans=1.0, out=False)
    rime = nb.bsdf(alb, rough=0.75, normal=nrm2, out=False)
    mix = nb.n('ShaderNodeMixShader')
    nb.link(fm, mix.inputs[0])
    nb.link(glass.outputs[0], mix.inputs[1])
    nb.link(rime.outputs[0], mix.inputs[2])
    shader = mix.outputs[0]
    estr = 0.0
    if glow_str:
        estr = nb.math('MULTIPLY', attr(nb, 'glow'), glow_str)
        em = nb.n('ShaderNodeEmission', ins={'Color': accent, 'Strength': estr})
        add = nb.n('ShaderNodeAddShader')
        nb.link(shader, add.inputs[0])
        nb.link(em.outputs[0], add.inputs[1])
        shader = add.outputs[0]
    va = nb.n('ShaderNodeVolumeAbsorption', ins={'Color': absorb, 'Density': density})
    va.name = 'RT_volume'
    gl = nb.math('MULTIPLY', nb.math('SUBTRACT', 1.0, fm), 0.92)
    return shader, alb, gl, (nb.math('DIVIDE', estr, EMIT_MAX) if estr != 0.0 else 0.0), va.outputs[0]


def rock(name, tid, tint=(1, 1, 1), sat=0.35, val=0.8, scale=1.0, snow=0.6, accent=(1, 0.6, 0.2), crack_str=0.0,
         frost_amt=0.6):
    """Scanned rock at true scale (box-projected in object space), regraded cold, snow on its ledges, rime in its
    cracks; where `crack` says so, the creature's furnace shows through as glowing fissures."""
    m = SM.new(name)
    nb = NB(m)
    ts = SM.texset(tid)
    vec = nb.n('ShaderNodeMapping', ins={'Vector': nb.texco('Object'), 'Scale': (1 / (ts['size'] * scale),) * 3}).outputs[0]

    def box(img):
        t = nb.img(img, vec)
        t.projection = 'BOX'
        t.projection_blend = 0.3
        return t.outputs['Color']
    d = box(ts['diff'])
    r = box(ts['rough']) if 'rough' in ts else 0.7
    disp = box(ts['disp']) if 'disp' in ts else 0.5
    ao = box(ts['ao']) if 'ao' in ts else 1.0
    col = nb.hsv(d, 0.5, sat, val)
    col = nb.mix(1.0, col, tint, blend='MULTIPLY')
    col = nb.mix(0.5, col, nb.mix(1.0, col, ao, blend='MULTIPLY'))
    pos = nb.texco('Object')
    big = nb.noise(pos, 1.5, detail=3.0)
    col = nb.mix(nb.math('MULTIPLY', nb.mrange(big, 0.4, 0.7, 0.0, 1.0), 0.5), col, nb.hsv(col, 0.52, 0.7, 0.7))
    groove = attr(nb, 'groove')
    col = nb.mix(nb.math('MULTIPLY', groove, 0.7), col, nb.hsv(col, 0.5, 1.0, 0.4))
    h = nb.math('ADD', nb.math('MULTIPLY', nb.n('ShaderNodeRGBToBW', ins={'Color': disp}).outputs[0], 1.0),
                nb.math('MULTIPLY', nb.noise(pos, 60.0, detail=4.0), 0.15))
    nrm = nb.bump(h, strength=0.7, dist=0.02)
    rough = nb.math('ADD', nb.math('MULTIPLY', nb.n('ShaderNodeRGBToBW', ins={'Color': r}).outputs[0], 0.4), 0.5)
    col, rough, nrm, fm = frost(nb, col, rough, nrm, frost_amt, crev=0.12, up=0.65, scale=0.5)
    # lying snow on the tops
    _, _, nz = nb.sep(nb.n('ShaderNodeNewGeometry').outputs['Normal'])
    sm = SM.snow_cover_mask(nb, nz, 0.62, 0.12, 2.5)
    sm = nb.math('MULTIPLY', sm, snow, clamp=True)
    col = nb.mix(sm, col, SM.SNOW_ALBEDO)
    rough = nb.mixf(sm, rough, 0.6)
    estr = 0.0
    if crack_str:
        ck = attr(nb, 'crack')
        # only some fissures run deep enough to show the furnace
        deep = nb.mrange(nb.noise(pos, 1.3, detail=2.0), 0.54, 0.64, 0.0, 1.0)
        hot = nb.math('MULTIPLY', nb.math('POWER', ck, 2.0), nb.math('MAXIMUM', deep, attr(nb, 'hot')))
        flick = nb.mrange(nb.noise(pos, 4.0, detail=2.0), 0.3, 0.7, 0.55, 1.0)
        estr = nb.math('MULTIPLY', nb.math('MULTIPLY', hot, flick), crack_str)
        col = nb.mix(nb.math('MULTIPLY', ck, 0.8), col, (0.025, 0.022, 0.02))
    p = nb.bsdf(col, rough=rough, normal=nrm, ecol=accent, estr=estr, out=False)
    gl = nb.math('MULTIPLY', nb.math('SUBTRACT', 1.0, rough), 0.35)
    rt(nb, p.outputs[0], col, gl, nb.math('DIVIDE', estr, EMIT_MAX) if estr != 0.0 else 0.0)
    return m


def magma(name, accent, strength=6.0, crust=(0.035, 0.03, 0.028)):
    """The furnace inside a titan: a slow glowing melt under a cracked dark crust."""
    m = SM.new(name)
    nb = NB(m)
    pos = nb.texco('Object')
    n = nb.noise(pos, 2.2, detail=6.0, rough=0.62)
    fis = nb.mrange(nb.math('ABSOLUTE', nb.math('SUBTRACT', nb.noise(pos, 1.6, detail=3.0), 0.5)), 0.0, 0.035, 1.0, 0.0)
    hot = nb.math('MAXIMUM', fis, nb.mrange(n, 0.56, 0.72, 0.0, 1.0))
    col = nb.mix(hot, crust, (0.25, 0.08, 0.02))
    estr = nb.math('MULTIPLY', hot, strength)
    nrm = nb.bump(nb.math('SUBTRACT', 1.0, hot), strength=0.6, dist=0.02)
    p = nb.bsdf(col, rough=0.75, normal=nrm, ecol=accent, estr=estr, out=False)
    rt(nb, p.outputs[0], col, 0.1, nb.math('DIVIDE', estr, EMIT_MAX))
    return m


def membrane(name, base, vein, plate, accent, glow_str=3.0, scale=1.0, eggs=False):
    """A stretched, translucent, glowing sac: veins branching over it, sclerite plates riding on it, wet.
    `eggs`: the light comes from clutches of eggs packed inside (cellular), not a smooth melt."""
    m = SM.new(name)
    nb = NB(m)
    pos = nb.texco('Object')
    warp = nb.vmath('ADD', pos, nb.vmath('SCALE', nb.n('ShaderNodeTexNoise', ins={'Vector': pos, 'Scale': 3.0 * scale, 'Detail': 3.0}).outputs['Color'], s=0.06 / scale))
    # veins: contour lines of warped noise meander and fork like vessels (cells would read as cracked glass)
    n1 = nb.noise(warp, 3.0 * scale, detail=4.0, rough=0.55)
    n2 = nb.noise(warp, 8.5 * scale, detail=3.0, rough=0.5)
    v1 = nb.mrange(nb.math('ABSOLUTE', nb.math('SUBTRACT', n1, 0.5)), 0.0, 0.022, 1.0, 0.0)
    v2 = nb.mrange(nb.math('ABSOLUTE', nb.math('SUBTRACT', n2, 0.5)), 0.0, 0.014, 1.0, 0.0)
    vm = nb.math('MAXIMUM', v1, nb.math('MULTIPLY', v2, 0.6))
    pl = attr(nb, 'plate')
    n = nb.noise(pos, 7.0 * scale, detail=4.0)
    if eggs:
        # the clutch is modelled (bulges); 'glow' marks each egg's lit heart
        inner = nb.math('MULTIPLY', nb.math('ADD', 0.15, nb.math('MULTIPLY', attr(nb, 'glow'), 0.85)), nb.mrange(n, 0.3, 0.7, 0.7, 1.0))
    else:
        inner = nb.mrange(n, 0.25, 0.75, 0.45, 1.0)
    lit = nb.math('MULTIPLY', nb.math('MULTIPLY', inner, nb.math('SUBTRACT', 1.0, vm)), nb.math('SUBTRACT', 1.0, pl))
    col = nb.mix(vm, base, vein)
    col = nb.mix(pl, col, plate)
    h = nb.math('ADD', nb.math('MULTIPLY', vm, 0.6), nb.math('MULTIPLY', pl, 0.5))
    h = nb.math('ADD', h, nb.math('MULTIPLY', nb.noise(pos, 80.0 * scale, detail=3.0), 0.15))
    nrm = nb.bump(h, strength=0.4, dist=0.006)
    estr = nb.math('MULTIPLY', lit, glow_str)
    rough = nb.mixf(pl, 0.22, 0.4)
    p = nb.bsdf(col, rough=rough, normal=nrm, ecol=accent, estr=estr, coat=nb.math('SUBTRACT', 1.0, pl), coat_rough=0.05,
                sss=nb.math('SUBTRACT', 1.0, pl), out=False)
    p.inputs['Subsurface Radius'].default_value = (1.0, 0.45, 0.2)
    p.inputs['Subsurface Scale'].default_value = 0.05
    gl = nb.mixf(pl, 0.9, 0.5)
    rt(nb, p.outputs[0], col, gl, nb.math('DIVIDE', estr, EMIT_MAX))
    return m


def crystal(name, tint, accent, glow_str=1.5, ior=1.55, rt_albedo=None, frost_amt=0.3):
    """Gem crystal (citrine, amethyst): clear, faceted, with inner fractures that catch and throw the glow."""
    m = SM.new(name)
    nb = NB(m)
    pos = nb.texco('Object')
    vor = nb.n('ShaderNodeTexVoronoi', feature='DISTANCE_TO_EDGE', ins={'Vector': pos, 'Scale': 18.0})
    frac = nb.mrange(vor.outputs['Distance'], 0.0, 0.025, 1.0, 0.0)
    n = nb.noise(pos, 30.0, detail=4.0)
    nrm = nb.bump(nb.math('ADD', nb.math('MULTIPLY', n, 0.2), nb.math('MULTIPLY', frac, 0.1)), strength=0.15, dist=0.002)
    lw = nb.n('ShaderNodeLayerWeight', ins={'Blend': 0.35})
    core = nb.math('SUBTRACT', 1.0, lw.outputs['Facing'])
    glass = nb.bsdf(tint, rough=nb.math('MULTIPLY', n, 0.06), normal=nrm, ior=ior, trans=1.0, out=False)
    estr = nb.math('MULTIPLY', nb.math('ADD', nb.math('MULTIPLY', core, 0.6), nb.math('ADD', 0.25, nb.math('MULTIPLY', frac, 1.2))), glow_str)
    em = nb.n('ShaderNodeEmission', ins={'Color': accent, 'Strength': estr})
    add = nb.n('ShaderNodeAddShader')
    nb.link(glass.outputs[0], add.inputs[0])
    nb.link(em.outputs[0], add.inputs[1])
    alb = rt_albedo or tuple(c * 0.55 for c in tint[:3])
    alb = nb.mix(frac, alb, (0.9, 0.9, 0.85))
    rt_e = nb.math('MULTIPLY', nb.math('ADD', 0.55, nb.math('MULTIPLY', frac, 0.45)), glow_str)
    rt(nb, add.outputs[0], alb, 0.95, nb.math('DIVIDE', rt_e, EMIT_MAX))
    return m
