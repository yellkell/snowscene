"""Bake the tutorial mountain for Quest 3.

blender -b art/work/tutorial.blend --python art/scripts/tutorial_bake.py -- [--samples 256] [--only a,b,...]

Regions (see lib/regions.py), all re-lightable (sun / sky channels):
  ground       the whole bowl, 4096 light / 2048 albedo
  trail        the trail corridor and summit shoulder at ~5 cm (footprints, every shadow crisp)
  wall         the climbing wall, cornice and icicles (you hang half a metre from it)
  bands        the scanned cliff bands either side of the wall
  bluff        the bluff face, the adit and its sign
  deck         the beacon deck (hidden until you come up the chimney)
  hut          the base-camp hut (exported in its own space; the game instances it three times)
  props        boulders, snow poles, trail sign, summit plaque
  rim          the ring of ranges round the bowl, out to the vista panorama
Trees reuse the Snow Survivors spruce bake (same variants). Writes art/work/bake_tutorial/.
"""
import bpy, sys, os, json, math
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from lib import bakekit as BK, regions as RGN  # noqa: E402

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
opt = lambda n, d: argv[argv.index(n) + 1] if n in argv else d
SAMPLES = int(opt('--samples', 256))
ALL = 'ground,trail,wall,bands,bluff,deck,hut,props,rim,party,lake'
ONLY = set(opt('--only', ALL).split(','))
ART = os.path.dirname(HERE)
OUT = os.path.join(ART, 'work', 'bake_tutorial')
os.makedirs(OUT, exist_ok=True)
MAN_P = os.path.join(OUT, 'bake.json')
MAN = json.load(open(MAN_P)) if os.path.exists(MAN_P) else {}
sc = bpy.context.scene
BK.gpu(sc)
O = bpy.data.objects
coll_objs = lambda name: list(bpy.data.collections[name].objects) if name in bpy.data.collections else []


def size_of(o):
    return max(o.dimensions) if o.dimensions else 1.0


def rock_budget(o, tris):
    # a snow cap needs enough triangles to stay one closed sheet over its rock (at 240 they shredded; its
    # metaball mesh is coarse enough now that 500 keeps it whole)
    cap = 'snowcap' in o.name or o.data.name.startswith('Mesh')
    return (500 if cap else 480) * min(2.2, max(0.6, size_of(o) / 1.6))


def dark_bulbs():
    """The festoon bulbs glow at runtime (campfire.ts draws them): take them out of the party's bake, so
    neither their light nor their dark glass ends up in it."""
    import bmesh
    me = O['PARTY'].data
    bulb = {i for i, m in enumerate(me.materials) if m and m.name.startswith('bulb_')}
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.material_index in bulb], context='FACES')
    bm.to_mesh(me)
    bm.free()


STAGES = {
    'ground': lambda: RGN.ground_region(O['GROUND'], 'ground', OUT, (-400, 400, -400, 420), 4096, SAMPLES, 2048),
    'trail': lambda: RGN.ground_region(O['GROUND'], 'trail', OUT, (-50, 50, -20, 115), 2048, SAMPLES, 2048),
    'wall': lambda: RGN.atlas_region('wall', [O['CLIFF_FACE'], O['CLIFF_ICICLES'], O['CORNICE']], OUT, 4096, 2048, SAMPLES,
                                     budget=lambda o, t: 42000 if 'FACE' in o.name else (t if 'ICICLE' in o.name else 3000)),
    'bands': lambda: RGN.atlas_region('bands', [o for o in coll_objs('CLIFF') if o.name.startswith('BAND_')], OUT, 2048, 1024,
                                      SAMPLES, budget=lambda o, t: rock_budget(o, t) * 1.5 if ('CRAG' in o.name or 'TALUS' in o.name) else 6000,
                                      keep_uv=lambda o: ('CRAG' in o.name or 'TALUS' in o.name) and 'snowcap' not in o.name),
    'bluff': lambda: RGN.atlas_region('bluff', [O['BLUFF_FACE'], O['ADIT'], O['ADIT_SIGN_TEXT']], OUT, 4096, 2048, SAMPLES,
                                      budget=lambda o, t: 26000 if 'FACE' in o.name else t),
    'deck': lambda: RGN.atlas_region('deck', [O['BEACON_DECK']], OUT, 2048, 1024, SAMPLES),
    'hut': lambda: RGN.atlas_region('hut', [O['CABIN_0']], OUT, 2048, 1024, SAMPLES, budget=lambda o, t: min(t, 30000),
                                    local=O['CABIN_0'].matrix_world.copy()),
    'props': lambda: RGN.atlas_region('props', coll_objs('PROPS') + coll_objs('TRAIL'), OUT, 4096, 2048, SAMPLES,
                                      budget=lambda o, t: rock_budget(o, t) if ('boulder' in o.name or 'R_' in o.name and 'POLE' not in o.name and 'SIGN' not in o.name) else t,
                                      keep_uv=lambda o: 'boulder' in o.name and 'snowcap' not in o.name),
    # the party (shown when the fire is lit), in party space; the lake's ice
    'party': lambda: (dark_bulbs(), RGN.atlas_region('party', [O['PARTY']], OUT, 2048, 1024, SAMPLES, local=O['PARTY'].matrix_world.copy()))[1],
    'lake': lambda: RGN.atlas_region('lake', [O['LAKE_ICE']], OUT, 2048, 1024, SAMPLES),
    'rim': lambda: RGN.atlas_region('rim', [O['RIM']], OUT, 2048, 1024, max(64, SAMPLES // 2), budget=lambda o, t: 70000),
}

for stage in ALL.split(','):
    if stage in ONLY:
        MAN[stage] = STAGES[stage]()
        json.dump(MAN, open(MAN_P, 'w'), indent=1)
# what the runtime needs to place things
lay = json.load(open(os.path.join(ART, 'work', 'tutorial_layout.json')))
ref = json.load(open(os.path.join(ART, 'work', 'tutorial_ref', 'layout.json')))
MAN['cabins'] = ref['cabins']
MAN['sun'] = lay.get('sun')
MAN['sky'] = lay.get('sky')
json.dump(MAN, open(MAN_P, 'w'), indent=1)
BK.log('done')
