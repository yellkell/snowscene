"""The bluff behind the summit: its granite face with the mine adit into the ice cave, and the beacon deck
on its top. Traced over cave-bluff.ts: the face is the game's own grid (it rolls back over the top onto
the shelf), the adit sits where buildPortal puts it, the deck where buildDeck does.

The adit is a real opening: timber sets every 1.3 m receding into darkness, lagging boards over them,
rails on sleepers running in, a lantern by the entrance and a carved sign over it.
Game (x, y, z) = Blender (x, -z, y).
"""
import bpy, bmesh, math, os, random
import numpy as np
from mathutils import Vector, Matrix
from . import core, snowmats as SM, cliff as CL, cabin as CB, trailkit as TK
from .nodes import NB

REF = CL.REF


def read_grid(path, count, nx, ny):
    vs = []
    with open(path) as f:
        for line in f:
            if line.startswith('v '):
                vs.append([float(t) for t in line.split()[1:4]])
                if len(vs) == count:
                    break
    return np.array(vs, np.float64).reshape(ny, nx, 3)


def build_face(coll, c, mouth):
    """mouth = (x, floor_y, face_z) of the adit, game coords."""
    G = read_grid(os.path.join(REF, 'bluff.obj'), 91 * 41, 91, 41)
    f = 8
    X = CL.upsample(G[..., 0], f, f)
    Y = CL.upsample(G[..., 1], f, f)
    Z = CL.upsample(G[..., 2], f, f)
    ny, nx = X.shape
    rows = np.linspace(1, 0, ny)[:, None] * np.ones((1, nx))      # PlaneGeometry rows run top -> bottom
    lip = np.clip((rows - 0.94) / 0.06, 0, 1)
    mx, my, mz = mouth
    lx = X - mx
    near_mouth = np.clip(1 - np.maximum(np.abs(lx) - 2.2, 0) / 1.2, 0, 1) * np.clip(1 - np.maximum(Y - (my + 4.0), 0) / 1.4, 0, 1)
    relief = CL.granite_relief(lx, Y, np.zeros_like(X, bool)) * 1.8
    # the same granite band as the climbing wall: bedding ledges holding snow, staggered joints, bays
    geo = CL.geology(lx, Y, float(Y.max()), float(Y.min()), float(np.abs(lx).max()), wall=False)
    Z = Z + (relief + geo) * (1 - lip) * (1 - near_mouth * 0.9)
    verts = np.stack([X, -Z, Y], -1).reshape(-1, 3)
    I, J = np.meshgrid(np.arange(nx - 1), np.arange(ny - 1))
    a = (J * nx + I).ravel()
    quads = np.stack([a, a + nx, a + nx + 1, a + 1], 1)
    # cut the adit's opening out of the face
    cx = (X[:-1, :-1] + X[1:, 1:]) / 2
    cy = (Y[:-1, :-1] + Y[1:, 1:]) / 2
    keep = ~((np.abs(cx - mx) < 1.05) & (cy > my - 0.5) & (cy < my + 2.95)).ravel()
    quads = quads[keep]
    me = bpy.data.meshes.new('bluff_face')
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
    if me.polygons[len(quads) // 3].normal.y > 0:
        me.flip_normals()
    ob = bpy.data.objects.new('BLUFF_FACE', me)
    coll.objects.link(ob)
    me.materials.append(CL.cliff_material())
    return ob


def build_adit(coll, mouth, depth=8.0, seed=3):
    """The mine adit: timber sets receding into the dark, lagging, rails, lantern, sign."""
    R = random.Random(seed)
    M = CB.mats()
    rock = CL.cliff_material()
    b = core.Builder('ADIT', coll, smooth_angle=35)
    mx, my, mz = mouth
    base = Vector((mx, -mz, my))          # Blender: front of the opening, floor level
    into = Vector((0, 1, 0))              # into the hill (game -z)
    W, H = 2.3, 3.0
    # rock walls of the tunnel, roughly hewn, slightly wider than the sets
    n = 18
    for k in range(n):
        y0 = k * depth / n
        y1 = (k + 1) * depth / n
        for (x0, x1, z0, z1) in ((-W / 2 - 0.25, -W / 2 - 0.25, -0.1, H + 0.3), (W / 2 + 0.25, W / 2 + 0.25, -0.1, H + 0.3)):
            jit = R.uniform(-0.06, 0.06)
            b.quad([base + Vector((x0 + jit, y0, z0)), base + Vector((x0 + jit, y1, z0)), base + Vector((x0 + jit, y1, z1)), base + Vector((x0 + jit, y0, z1))], rock)
        b.quad([base + Vector((-W / 2 - 0.3, y0, H + 0.3)), base + Vector((-W / 2 - 0.3, y1, H + 0.3)), base + Vector((W / 2 + 0.3, y1, H + 0.3)), base + Vector((W / 2 + 0.3, y0, H + 0.3))], rock)
        b.quad([base + Vector((-W / 2 - 0.3, y0, -0.02)), base + Vector((W / 2 + 0.3, y0, -0.02)), base + Vector((W / 2 + 0.3, y1, -0.02)), base + Vector((-W / 2 - 0.3, y1, -0.02))], CB.mats()['snow'] if k < 2 else rock)
    # the dark: a black back wall so the tunnel ends in nothing
    dark = SM.new('adit_dark')
    nbk = NB(dark)
    nbk.bsdf((0.004, 0.004, 0.005), rough=1.0)
    b.panel(base + into * (depth - 0.05) + Vector((0, 0, H / 2)), -into, W + 0.8, H + 0.6, dark)
    # timber sets: two posts and a cap, every 1.3 m; lagging boards over the caps
    y = 0.15
    while y < depth - 0.4:
        lean = R.uniform(-0.02, 0.02)
        for sx in (-1, 1):
            b.element()
            b.cbox(base + Vector((sx * (W / 2 - 0.12), y, H / 2)), (0.24, 0.24, H), M['timber'], bev=0.02,
                   R_=Matrix.Rotation(lean * sx, 3, 'Y'))
        b.element()
        b.cbox(base + Vector((0, y, H + 0.12)), (W + 0.2, 0.26, 0.28), M['timber'], bev=0.02)
        y += 1.3
    for k in range(int(depth / 0.22)):
        b.element()
        b.cbox(base + Vector((R.uniform(-0.02, 0.02), 0.1 + k * 0.22, H + 0.3)), (W + 0.5, 0.2, 0.05), M['timber'], bev=0.006)
    # heavy front set with a header beam, a little proud of the face
    for sx in (-1, 1):
        b.element()
        b.cbox(base + Vector((sx * 1.25, -0.15, 1.55)), (0.32, 0.32, 3.1), M['timber'], bev=0.025, seg=2)
    b.element()
    b.cbox(base + Vector((0, -0.15, 3.2)), (3.3, 0.4, 0.38), M['timber'], bev=0.025, seg=2)
    b.element()
    b.cbox(base + Vector((0, -0.15, 3.43)), (3.45, 0.62, 0.12), M['timber'], bev=0.015)
    b.element()
    b.cbox(base + Vector((0, -0.18, 3.55)), (3.5, 0.66, 0.14), M['snow'], bev=0.06, seg=3)
    # icicles off the header
    ice = CL.ice_material()
    for i in range(30):
        x = R.uniform(-1.7, 1.7)
        L = R.uniform(0.05, 0.6) ** 1.5 + 0.03
        top = base + Vector((x, -0.42, 3.0))
        b.cyl(top, top - Vector((0, 0, L)), L * 0.08, ice, sides=6, r1=0.002)
    # rails on sleepers running in, a little snow drifted onto the first metres
    rail = SM.new('rail_steel')
    nbr = NB(rail)
    rust = nbr.noise(nbr.pos(), 20.0, detail=5.0)
    nbr.bsdf(nbr.mix(nbr.mrange(rust, 0.4, 0.7, 0, 1), (0.08, 0.08, 0.085), (0.22, 0.1, 0.04)), rough=0.55, metal=0.9)
    for k in range(int((depth + 1.5) / 0.6)):
        b.element()
        b.cbox(base + Vector((R.uniform(-0.03, 0.03), -1.2 + k * 0.6, 0.04)), (1.15, 0.16, 0.09), M['timber'], bev=0.01)
    for sx in (-1, 1):
        a = base + Vector((sx * 0.38, -1.4, 0.13))
        c = base + Vector((sx * 0.38, depth - 0.2, 0.13))
        b.element()
        b.cbox((a + c) / 2, (0.055, (c - a).length, 0.075), rail, bev=0.006)
    # lantern on a bracket by the entrance
    lamp = base + Vector((1.05, -0.45, 2.6))
    b.cyl(lamp + Vector((0, 0.3, 0.22)), lamp + Vector((0, 0, 0.22)), 0.015, M['iron'], sides=6)
    b.lathe([(0.0, -0.12), (0.08, -0.1), (0.085, 0.12), (0.055, 0.16), (0.0, 0.2)], lamp, Vector((0, 0, 1)), M['iron'], seg=8)
    b.lathe([(0.0, -0.08), (0.06, -0.06), (0.06, 0.08), (0.0, 0.1)], lamp, Vector((0, 0, 1)), M['lamp'], seg=8)
    # the sign board, carved lettering
    b.element()
    b.cbox(base + Vector((0, -0.42, 3.78)), (1.95, 0.06, 0.44), TK.mats()['wood'], bev=0.012)
    ob = b.finish(merge=False)
    me = TK.text_mesh('OLD TIMBER WORKS', 0.17, 0.006, font=TK.FONT_SERIF)
    me.materials.append(TK.mats()['cream'])
    t = bpy.data.objects.new('ADIT_SIGN_TEXT', me)
    coll.objects.link(t)
    t.matrix_world = Matrix.Translation(base + Vector((0, -0.455, 3.78))) @ Matrix.Rotation(math.pi / 2, 4, 'X')
    return ob


def build_deck(coll, top_y, face_s, beacon, bluff_x=-3.0, seed=4):
    """The beacon deck on the bluff's shelf: weathered planks, posts and rails (front open), the cave
    chimney's timber collar, and the beacon's iron basket on its tripod."""
    R = random.Random(seed)
    M = CB.mats()
    b = core.Builder('BEACON_DECK', coll, smooth_angle=35)
    front, back, half = face_s + 1.7, face_s + 12, 4.4
    y = top_y
    k = 0
    s = front
    while s < back - 0.05:
        b.element()
        b.cbox((bluff_x + R.uniform(-0.03, 0.03), s + 0.31, y - 0.04), (half * 2 + R.uniform(-0.05, 0.08), 0.6, 0.1), M['timber'], bev=0.012)
        s += 0.62
        k += 1
    for jx in (-half + 0.4, 0, half - 0.4):
        b.element()
        b.cbox((bluff_x + jx, (front + back) / 2, y - 0.17), (0.18, back - front, 0.16), M['timber'], bev=0.01)
    s = front + 0.6
    posts = []
    while s <= back:
        posts += [(bluff_x - half, s), (bluff_x + half, s)]
        s += 2.2
    x = bluff_x - half + 2.2
    while x < bluff_x + half:
        posts.append((x, back))
        x += 2.2
    for (px, ps) in posts:
        b.element()
        b.cbox((px, ps, y + 0.5), (0.12, 0.12, 1.0), M['timber'], bev=0.01)
        b.element()
        b.cbox((px, ps, y + 1.02), (0.16, 0.16, 0.06), M['snow'], bev=0.03, seg=2)
    for sx in (-1, 1):
        b.element()
        b.cbox((bluff_x + sx * half, (front + 0.6 + back) / 2, y + 1.0), (0.1, back - front - 0.6, 0.08), M['timber'], bev=0.01)
    b.element()
    b.cbox((bluff_x, back, y + 1.0), (half * 2, 0.1, 0.08), M['timber'], bev=0.01)
    # chimney collar round the dark hole (the cave's top), beside the beacon
    hx, hs = bluff_x + 2.4, -(beacon[2] + 0.4)
    for k in range(8):
        a = k / 8 * math.tau
        b.element()
        b.cbox((hx + math.cos(a) * 0.95, hs + math.sin(a) * 0.95, y + 0.05), (0.9, 0.22, 0.2), M['timber'], bev=0.012,
               R_=Matrix.Rotation(a + math.pi / 2, 3, 'Z'))
    dark = bpy.data.materials.get('adit_dark')
    b.lathe([(0.0, 0.0), (0.95, 0.0)], Vector((hx, hs, y + 0.03)), Vector((0, 0, 1)), dark, seg=24)
    # tripod and basket
    bz, bs = beacon[1], -beacon[2]
    for k in range(3):
        a = k / 3 * math.tau
        b.cyl(Vector((bluff_x + math.cos(a) * 1.1, bs + math.sin(a) * 1.1, y)), Vector((bluff_x, bs, y + 2.4)), 0.06, M['iron'], sides=8)
    for k in range(14):
        a = k / 14 * math.tau
        b.cyl(Vector((bluff_x + math.cos(a) * 0.5, bs + math.sin(a) * 0.5, y + 2.2)), Vector((bluff_x + math.cos(a) * 0.9, bs + math.sin(a) * 0.9, y + 2.8)), 0.022, M['iron'], sides=6)
    for zr, rr in ((2.2, 0.5), (2.5, 0.7), (2.8, 0.9)):
        b.tube([Vector((bluff_x + math.cos(t / 24 * math.tau) * rr, bs + math.sin(t / 24 * math.tau) * rr, y + zr)) for t in range(25)], 0.025, M['iron'], sides=6)
    return b.finish(merge=False)
