"""Shader node-tree builder (from blendercyber v2 mats.py)."""
import bpy

def c4(v):
    return (v[0], v[1], v[2], 1.0) if len(v) == 3 else tuple(v)


# ---------------------------------------------------------------- node helper
class NB:
    def __init__(self, mat):
        mat.use_nodes = True
        self.mat = mat
        self.nt = mat.node_tree
        for n in list(self.nt.nodes):
            self.nt.nodes.remove(n)
        self.out = self.nt.nodes.new('ShaderNodeOutputMaterial')

    def link(self, v, sock):
        if v is None:
            return
        if isinstance(v, bpy.types.NodeSocket):
            self.nt.links.new(v, sock)
        elif isinstance(v, bpy.types.Node):
            self.nt.links.new(v.outputs[0], sock)
        elif isinstance(v, (tuple, list)):
            sock.default_value = c4(v) if sock.type == 'RGBA' else v
        else:
            sock.default_value = v

    def n(self, t, ins=None, **props):
        node = self.nt.nodes.new(t)
        for k, v in props.items():
            setattr(node, k, v)
        for k, v in (ins or {}).items():
            self.link(v, node.inputs[k])
        return node

    def uv(self, name='UVMap'):
        return self.n('ShaderNodeUVMap', uv_map=name).outputs[0]

    def pos(self):
        return self.n('ShaderNodeNewGeometry').outputs['Position']

    def texco(self, kind='Object'):
        return self.n('ShaderNodeTexCoord').outputs[kind]

    def attr(self, name, kind='GEOMETRY', out='Fac'):
        return self.n('ShaderNodeAttribute', attribute_type=kind, attribute_name=name).outputs[out]

    def img(self, image, vec, interp='Linear', ext='REPEAT'):
        return self.n('ShaderNodeTexImage', image=image, interpolation=interp, extension=ext, ins={'Vector': vec})

    def noise(self, vec, scale, detail=4.0, rough=0.55, dist=0.0, dims='3D'):
        return self.n('ShaderNodeTexNoise', noise_dimensions=dims,
                      ins={'Vector': vec, 'Scale': scale, 'Detail': detail, 'Roughness': rough, 'Distortion': dist})

    def ramp(self, fac, stops, interp='LINEAR'):
        r = self.n('ShaderNodeValToRGB')
        self.link(fac, r.inputs[0])
        cr = r.color_ramp
        cr.interpolation = interp
        cr.elements[0].position, cr.elements[0].color = stops[0][0], c4(stops[0][1])
        cr.elements[1].position, cr.elements[1].color = stops[-1][0], c4(stops[-1][1])
        for p, c in stops[1:-1]:
            e = cr.elements.new(p)
            e.color = c4(c)
        return r.outputs['Color']

    def mix(self, fac, a, b, blend='MIX', clamp=True):
        m = self.n('ShaderNodeMix', data_type='RGBA', blend_type=blend, clamp_result=clamp)
        self.link(fac, m.inputs[0]); self.link(a, m.inputs[6]); self.link(b, m.inputs[7])
        return m.outputs[2]

    def mixf(self, fac, a, b):
        m = self.n('ShaderNodeMix', data_type='FLOAT')
        self.link(fac, m.inputs[0]); self.link(a, m.inputs[2]); self.link(b, m.inputs[3])
        return m.outputs[0]

    def mixv(self, fac, a, b):
        m = self.n('ShaderNodeMix', data_type='VECTOR')
        self.link(fac, m.inputs[0]); self.link(a, m.inputs[4]); self.link(b, m.inputs[5])
        return m.outputs[1]

    def math(self, op, a, b=None, clamp=False):
        m = self.n('ShaderNodeMath', operation=op, use_clamp=clamp)
        self.link(a, m.inputs[0])
        if b is not None:
            self.link(b, m.inputs[1])
        return m.outputs[0]

    def vmath(self, op, a, b=None, s=None):
        m = self.n('ShaderNodeVectorMath', operation=op)
        self.link(a, m.inputs[0])
        if b is not None:
            self.link(b, m.inputs[1])
        if s is not None:
            self.link(s, m.inputs['Scale'])
        return m.outputs[1] if op in ('DOT_PRODUCT', 'LENGTH', 'DISTANCE') else m.outputs[0]

    def mrange(self, v, a, b, c, d, clamp=True):
        m = self.n('ShaderNodeMapRange', clamp=clamp)
        self.link(v, m.inputs[0])
        for i, x in zip((1, 2, 3, 4), (a, b, c, d)):
            self.link(x, m.inputs[i])
        return m.outputs[0]

    def sep(self, vec):
        s = self.n('ShaderNodeSeparateXYZ'); self.link(vec, s.inputs[0])
        return s.outputs[0], s.outputs[1], s.outputs[2]

    def sepc(self, col):
        s = self.n('ShaderNodeSeparateColor'); self.link(col, s.inputs[0])
        return s.outputs[0], s.outputs[1], s.outputs[2]

    def comb(self, x, y, z):
        c = self.n('ShaderNodeCombineXYZ')
        for i, v in enumerate((x, y, z)):
            self.link(v, c.inputs[i])
        return c.outputs[0]

    def hsv(self, col, h=0.5, s=1.0, v=1.0):
        return self.n('ShaderNodeHueSaturation', ins={'Color': col, 'Hue': h, 'Saturation': s, 'Value': v}).outputs[0]

    def bump(self, h, strength=0.2, dist=0.02, normal=None):
        return self.n('ShaderNodeBump', ins={'Strength': strength, 'Distance': dist, 'Height': h, 'Normal': normal}).outputs[0]

    def ao(self, dist=0.35, samples=12, inside=False):
        a = self.n('ShaderNodeAmbientOcclusion', samples=samples, inside=inside, only_local=False, ins={'Distance': dist})
        return a.outputs['AO']

    def bsdf(self, base, rough=0.5, metal=0.0, spec=0.5, normal=None, ecol=None, estr=0.0, alpha=None, coat=0.0,
             coat_rough=0.05, thin=None, trans=0.0, ior=1.45, sss=0.0, out=True):
        p = self.n('ShaderNodeBsdfPrincipled')
        self.link(base, p.inputs['Base Color'])
        self.link(rough, p.inputs['Roughness'])
        self.link(metal, p.inputs['Metallic'])
        self.link(spec, p.inputs['Specular IOR Level'])
        self.link(ior, p.inputs['IOR'])
        if normal is not None:
            self.link(normal, p.inputs['Normal'])
        if ecol is not None:
            self.link(ecol, p.inputs['Emission Color'])
            self.link(estr, p.inputs['Emission Strength'])
        if alpha is not None:
            self.link(alpha, p.inputs['Alpha'])
        if coat:
            self.link(coat, p.inputs['Coat Weight'])
            self.link(coat_rough, p.inputs['Coat Roughness'])
        if thin is not None:
            self.link(thin, p.inputs['Thin Film Thickness'])
            p.inputs['Thin Film IOR'].default_value = 1.45
        if trans:
            self.link(trans, p.inputs['Transmission Weight'])
        if sss:
            self.link(sss, p.inputs['Subsurface Weight'])
        if out:
            self.link(p.outputs[0], self.out.inputs['Surface'])
        return p


