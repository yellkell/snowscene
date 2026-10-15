"""Fetch the CC0 Poly Haven sources the snow pipeline builds from.

python art/scripts/fetch_polyhaven.py [--res 2k]

Textures land in art/assets/polyhaven/textures/<id>/<id>_<map>_<res>.<ext> with _meta.json holding each
scan's real-world size (mm), so materials can sit at true physical scale. Models land as glTF
(art/assets/polyhaven/models/<id>/<id>_<res>.gltf + textures/).
"""
import json, os, sys, urllib.request, concurrent.futures as cf

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(os.path.dirname(HERE), 'assets', 'polyhaven')
RES = sys.argv[sys.argv.index('--res') + 1] if '--res' in sys.argv else '2k'

TEXTURES = [
    # snow
    'snow_01', 'snow_02', 'snow_03', 'snow_04', 'snow_field_aerial',
    # rock
    'rock_face', 'rock_face_03', 'cliff_side', 'rocky_trail', 'rock_boulder_cracked', 'lichen_rock',
    'granite_wall', 'worn_rock_natural_01', 'aerial_rocks_02', 'marble_cliff_02',
    # wood: bark, timber works, decks
    'pine_bark', 'knotted_pine_bark', 'weathered_planks', 'old_planks_02', 'wood_planks_grey',
    'raw_plank_wall', 'weathered_brown_planks', 'wooden_rough_planks', 'worn_planks', 'medieval_wood',
    'weathered_peeling_timber',
]
MODELS = [
    'fir_tree_01', 'pine_tree_01', 'fir_sapling', 'fir_sapling_medium', 'pine_sapling_small', 'pine_sapling_medium',
    'dead_tree_trunk', 'dead_tree_trunk_02', 'tree_stump_01', 'tree_stump_02', 'dry_branches_medium_01', 'pine_roots',
    'boulder_01', 'namaqualand_boulder_02', 'namaqualand_boulder_03', 'namaqualand_boulder_04',
    'namaqualand_boulder_05', 'namaqualand_boulder_06', 'namaqualand_cliff_01', 'namaqualand_cliff_02', 'mountainside',
    'rock_moss_set_01', 'stone_fire_pit', 'wooden_lantern_01', 'Lantern_01', 'wooden_barrels_01', 'wine_barrel_01',
    'hatchet', 'wooden_axe',
]
# Pure skies (no ground): the Qwantani series is one place through an evening, sunset -> night.
HDRIS = {
    'qwantani_sunset_puresky': ['4k', '8k'], 'qwantani_dusk_1_puresky': ['4k', '8k'],
    'qwantani_dusk_2_puresky': ['4k', '8k'], 'qwantani_night_puresky': ['4k', '8k'],
    'belfast_sunset_puresky': ['4k'], 'kloppenheim_06_puresky': ['4k'], 'rosendal_park_sunset_puresky': ['4k'],
    'kloppenheim_01_puresky': ['4k'],
}
TEX_MAPS = {'Diffuse': 'diff', 'nor_gl': 'nor_gl', 'Rough': 'rough', 'Displacement': 'disp', 'AO': 'ao'}


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'snowscene-art-pipeline'})) as r:
        return r.read()


def save(url, path):
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    data = get(url)
    with open(path + '.part', 'wb') as f:
        f.write(data)
    os.replace(path + '.part', path)


def jobs():
    meta_path = os.path.join(ROOT, 'textures', '_meta.json')
    meta = json.load(open(meta_path, encoding='utf8')) if os.path.exists(meta_path) else {}
    info = json.loads(get('https://api.polyhaven.com/assets?t=textures').decode('utf8'))
    for tid in TEXTURES:
        files = json.loads(get(f'https://api.polyhaven.com/files/{tid}').decode('utf8'))
        meta[tid] = {'size_mm': info[tid].get('dimensions'), 'categories': info[tid].get('categories'),
                     'authors': list(info[tid].get('authors', {}).keys())}
        for key, short in TEX_MAPS.items():
            if key not in files:
                continue
            res = RES if RES in files[key] else sorted(files[key])[0]
            fmt = 'png' if short == 'disp' and 'png' in files[key][res] else 'jpg'
            yield files[key][res][fmt]['url'], os.path.join(ROOT, 'textures', tid, f'{tid}_{short}_{RES}.{fmt}')
    os.makedirs(os.path.dirname(meta_path), exist_ok=True)
    json.dump(meta, open(meta_path, 'w', encoding='utf8'), indent=1)
    minfo = json.loads(get('https://api.polyhaven.com/assets?t=models').decode('utf8'))
    mmeta = {}
    for mid in MODELS:
        files = json.loads(get(f'https://api.polyhaven.com/files/{mid}').decode('utf8'))
        g = files['gltf'][RES]['gltf']
        d = os.path.join(ROOT, 'models', mid)
        mmeta[mid] = {'dimensions_mm': minfo[mid].get('dimensions'), 'authors': list(minfo[mid].get('authors', {}).keys())}
        yield g['url'], os.path.join(d, f'{mid}_{RES}.gltf')
        for rel, inc in g.get('include', {}).items():
            yield inc['url'], os.path.join(d, rel)
    json.dump(mmeta, open(os.path.join(ROOT, 'models', '_meta.json'), 'w', encoding='utf8'), indent=1)
    for hid, resl in HDRIS.items():
        files = json.loads(get(f'https://api.polyhaven.com/files/{hid}').decode('utf8'))
        for r in resl:
            f = files['hdri'][r]['exr' if r == '4k' else 'hdr']
            yield f['url'], os.path.join(ROOT, 'hdris', f'{hid}_{r}.' + ('exr' if r == '4k' else 'hdr'))


if __name__ == '__main__':
    todo = list(jobs())
    print(len(todo), 'files', flush=True)
    with cf.ThreadPoolExecutor(12) as ex:
        for i, _ in enumerate(ex.map(lambda j: save(*j), todo)):
            if i % 25 == 0:
                print(i, flush=True)
    print('done')
