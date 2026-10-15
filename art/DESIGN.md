# Snow Scene — photoreal rebuild

Goal: every pixel of the tutorial and Snow Survivors at the standard set by `blendercyber` (procedural
Blender scenes at real construction detail, CC0 photoscans at true scale, Cycles-baked light, one GLB per
region), running on Quest 3 at 72–90 Hz with up to 3000 enemies on screen. The expedition is gone.

## 1. Pipeline (same shape as blendercyber)

```
art/scripts/fetch_polyhaven.py      CC0 scans -> art/assets/polyhaven (gitignored)
art/scripts/export_heights.mjs      gameplay heightfields (terrain.ts / survivors-level.ts) -> art/work/*.bin
art/scripts/lib/*.py                core builders, scan materials, bake + glTF export plumbing
art/scripts/<region>.py             builds HIGH (Cycles) + LOW (bake proxy) for one region
art/scripts/bake.py                 HIGH -> LOW atlases, light channels, impostors, Draco GLB -> public/gltf/
```

Gameplay geometry stays authoritative in TypeScript (`terrainHeight`, `duneHeight`, hold layout, cave
berths). Blender reads it, never the other way round, so the visible world can't drift from what you walk on.

As built (the names above were the plan):

```
art/scripts/{survivors,tutorial,vista}_build.py   HIGH scenes -> art/work/*.blend
art/scripts/{survivors,tutorial}_bake.py          stages -> art/work/bake_<region>/ (float .npy + Draco GLB)
art/scripts/{gear,figure}_bake.py                 held/moving things -> public/gear/ (albedo + AO/rough, metal in vertex colour)
art/scripts/encode.py <region>                    -> public/<region>/ (webp + manifest), then ktx2.mjs
art/scripts/ktx2.mjs                              KTX2/Basis twins of the big textures + public/ktx2.json
art/scripts/serve_dist.py                         no-cache local server for dist/ (launch config "snow-dist")
```

Atlas rules learned the hard way (`lib/regions.py atlas_region`):
- **Unwrap per piece, pack once.** A joint smart-project over hundreds of decimated rocks made ~26 000
  islands and filled ~1% of the atlas (rocks rendered black once mipped). Each piece is unwrapped alone —
  scans keep their own UV layout (`keep_uv`) — then `average_islands_scale` + `pack_islands`: 55–60% fill.
- **Fill the gutters.** encode.py push-pull fills every empty texel from the nearest islands, so mips never
  pull black in.
- **Orientation.** encode.py writes atlases top row first (v = 1), the glTF convention: everything sampled
  through glTF UVs uses `flipY = false` (atlases, gear, the spray card). Ground regions, skies and impostors
  compute their own UVs with three's default flip. KTX2 twins can't flip on upload, so ktx2.mjs pre-flips
  exactly the second group.
- **Quest memory.** Everything big ships as ETC1S KTX2 (~1/8 of RGBA8 on the GPU, about the WebP's size on
  disk); the wasm encoder caps at 12.5 Mpix, so 4096² maps are resampled to 3456² for the twin.
- **Emissive things stay out of the light bake** (festoon bulbs are deleted before the party bake; they glow
  at runtime) — an emitter in the sun/sky passes gets rescaled by the sun colour and crushes the encoding.
- The bonfire lights everything baked or moving through one analytic term (`fireLight` in baked/light.ts,
  `bakedLight.uFire`), dimmed on atlases by the sky channel as a stand-in for occlusion.

## 2. Light: baked, but re-lightable

Weather and time change at runtime (blizzard → clear dusk in the tutorial; golden hour → blue hour over a
survivors run), so a single baked "beauty" lightmap is not enough. Light is linear, so each region bakes
**separate irradiance channels** and the runtime recombines them:

| channel | Cycles bake | runtime |
|---|---|---|
| R  sun   | sun lamp only, world black, full GI | `× sunColor × sunStrength` (0 in the blizzard) |
| G  sky   | uniform white sky only, sun off, full GI | `× skyColor` (grey storm, blue dusk, deep blue night) |
| B  local | lanterns / fires / beacon only | `× fireColor × flicker` (beacon channel off until lit) |

Stored sqrt-encoded in one RGB texture per atlas. Albedo comes either from a baked atlas (hard-surface:
timber, cabins, the cave) or from tiling photoscans at true scale (snow, rock), whose normal maps modulate
the baked sun term (`dot(Nd, L) / dot(Ng, L)`, clamped) so wind crust and sastrugi catch the low sun.
Everything tone-maps through three's AgX at runtime (the same view transform the Blender reference renders
use), replacing the toon ramp and custom grade.

Moving things (enemies, cave machines, glider, held items) are lit by the **same three terms** evaluated
analytically, plus a baked **light volume** (a coarse 3D grid of ambient cubes) where the environment matters
(the cave), so a gondola darkens as it passes under the wheel and warms beside a lantern.

## 3. Snow Survivors

- **Arena**: the long swells stay, wind-sculpted sastrugi and drift tails in the scan normals, a
  **raised hill in the north-east quarter** (≈14 m, ≈50 m across, gentle enough to pole up, a broken rock
  crest on its windward side) crowned by **one old, wind-bent spruce** — the arena's landmark and
  vantage point. Height comes from `duneHeight`, so the horde, pickups and fire all climb it for free.
- **Forest**: scanned fir/pine baked to hemi-octahedral impostors (albedo+alpha, normal, snow loading
  painted in Blender), a real-geometry LOD for the nearest trees, dead trunks, stumps and half-buried
  boulders on the plain.
- **Sky**: Blender Nishita sky + distant ranges rendered to a horizon panorama per time of day; the run
  slides from golden hour into blue hour, so the last minutes and the bosses are fought by firelight.
- **Horde**: Blender-modelled creatures (frost-crusted chitin, translucent ice sacs, glowing cores) that keep
  the existing rigid part rig (`aRig`/`aPivot`, shader gait) so animation stays free. Three LODs per kind
  (~1200 / ~300 / ~70 tris) chosen per frame by distance with fixed budgets per band (≈150 / 800 / rest),
  object-space normal + AO + albedo atlas, blob contact shadows (one instanced draw). Budget ≈400k tris.
- **FX**: fire, ice and impacts re-done as flipbooks rendered in Blender (smoke, flame, ice burst), soft
  particles, no extra lights.

## 4. Tutorial

Trail, cliff and holds (chalked real rock jugs instead of glowing balls), summit, bluff and portal, cabins,
the lake party, the glider and its kit, poles and pack — each rebuilt at real construction detail and baked by
region. The blizzard gets real whiteout: height fog, wind streaks, ground spindrift.

## 5. VOIDSTEP — the timber works in the ice cave

The section the whole tutorial hinges on, and the hardest to make real: a room-scale ride on 15 moving
machines and 13 fixed stations, everything within arm's reach, in an enclosed space lit only by lanterns and
a shaft of daylight from the chimney.

**What it should feel like.** An abandoned 19th-century ice mine inside a glacier: hand-adzed larch timbers
black with age and frost, forged iron straps and bolts, tarred hemp rope, oil lanterns. The ice is the
spectacle: scalloped blue walls glowing where daylight leaks through them, frozen waterfalls, icicle curtains,
a black meltwater pool that mirrors the lanterns. Warm against cold everywhere you look.

**How it is built.**
- *Static shell + works* (cave, icicles, pool, every fixed timber, the 13 stations, rack posts, brazier):
  one baked region with full GI, light channels = lanterns + chimney daylight (always) and beacon/brazier
  (comes up when you light it — the cave warms from the top down).
- *Machines* (rafts, hoists, incline cart, swings, gondolas, skip, ropeway, trolley, the mill wheel): each
  modelled once in its own frame, AO + albedo + normals baked to a shared machines atlas, lit at runtime from
  the cave light volume so they pick up the light of wherever they are on their timetable.
- *Ropes*: one instanced rope mesh with a tiled tarred-hemp texture whose UVs stretch with length.
- The timetable, berths, tile grid and deck sizes in `cave-score.ts` are untouched: the art fits the score.

**Readability is safety here.** A photoreal cave must not hide the signals the player steps by:
- The green / amber / red **signal lamps** become railway lamps with coloured glass lenses on every deck,
  with a soft glow card each so they read through the gloom and the ice glare.
- Every deck edge gets a pale worn-timber nosing with an iron strip, so the edge of the void is unmistakable
  in peripheral vision, and the gap below stays dark (no fog filling it).
- The next deck keeps a marker, but as warm lantern light pooled on its boards rather than a floating torus.
- Machines start and stop with a creak and a brake clank (audio), never a jump.

**Performance.** The cave never shares the screen with the outdoor world, so it gets the whole budget:
one static draw for the shell + works, ~15 machine draws, one each for decks, lamps, ropes and glows.

## 6. Quest 3 budget (as built)

Target: under ~500k triangles and ~110 draws in any view (Quest 3 copes with ~750k-1M), and no pixel
shaded twice for nothing. Measure with `node art/scripts/profile_views.mjs` (per view: totals, the heaviest
layers, draws by family) against the dist server; check stand-ins with `node art/scripts/lod_compare.mjs`
(each view forced to full detail / stand-ins / auto, in art/renders/lod/).

- **Chunks.** `blender -b -P art/scripts/lod_build.py` splits every atlas layer (tutorial props, rim,
  bands, wall, bluff, hut, party; cave shell, works, debris; survivors props) into ground-grid chunks
  (whole boulders stay in one chunk; the rim in pie slices round the bowl) -> `<name>_lod.glb` +
  `lod.json`. The runtime frustum-culls each chunk, hides it past 1.6x the fog distance, and the
  procedural terrain is split the same way at load (quadtree, `splitMesh`).
- **Stand-ins are made at load, not in Blender.** meshoptimizer simplifies each decoded chunk into a
  second index buffer over the same vertices, within ~1.5 Quest pixels at its switch distance, sliding
  atlas seams together and locking the chunk border. Blender's decimate can't do this: welded, it drags
  faces across atlas islands (a yellow sign went white); with seams locked, per-piece unwraps barely
  decimate. Cost: ~0.3 s at load on desktop for ~740k triangles in.
- **Dancers** past 45 m: one simplified body+arms mesh (gear/figure<k>_far.glb) instead of three draws.
- **Climb holds' glows** are drawn only while poling and climbing.
- **Sky last.** The baked sky dome draws after every opaque thing at the far plane, so only open sky pays
  for its shader; the far-layer depth clear is skipped once the bake is in.
- **Cave ice.** The triplanar fine-ice fetches are skipped past 12 m, the scallop normals and lantern
  glints where the ice is dry (most of it).
- **Horde.** LOD budgets 70k / 80k triangles for the near bands; LOD2 counts unchanged (the mass stays).

## 7. Fixes from the first headset play (2026-10-15)

- **Flicker in the cave** was z-fighting: 730 pairs of coplanar faces between pieces (rails overlapping at
  their joins, handrails flush with posts), and Draco quantising positions to a 2.4 mm grid over the 40 m
  works, which snapped near-flush faces into one plane. `cavekit.separate_pieces` (run twice in the works and
  machines bakes) moves every piece out along its normals by 1-6 mm, pieces that share a plane in the same
  place always on different levels; the cave exports at 20-bit positions. `art/scripts/zfight_scan.py` counts
  what is left (106 pairs, sub-millimetre, none visible in a 1 mm camera-nudge flicker test).
- **Snow caps** were metaball sheets at 1.5 cm decimated to 1-2 %: shredded into black gaps and slivers. Now
  meshed at 3 cm, 500 triangles a rock, and `regions.drop_slivers` strips loose bits after decimation.
- **Scanned cliff bands either side of the wall** (L1, R1, LE, RE) are open shells. Standing taller than the
  summit they showed their open tops and backs up there (see-through rock, black slivers by the flag).
  `tutorial_build.under_summit` lowers each until every part of it behind the face line is under the snow.
  (Solidifying the scans doesn't work: before decimation the thin shell folds into itself, after it the back
  skin has nothing in the HIGH to bake from and comes out black.)
- **The cornice** is worn back to a thin crust where the climb tops out (`build_cornice(exit_x=...)`), so the
  two lip holds stand clear of the snow.
