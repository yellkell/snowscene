# The Expedition — design contract

The tutorial (pole 70 m up a couloir, climb a 6.6 m cliff, build a glider,
glide to a lake party) is level 1. The expedition is the real mountain, ~50x
the scale: a 7.8 km route from Base Camp (elev 0) to a 1,300 m summit, with
long walks, switchbacks, two climbs, set-piece events, a full day/night
cycle and weather that comes and goes. You end by gliding ~3 km from the
summit, down through the sea of clouds, to a party at Base Camp.

Several agents build this at once. **Read this whole file first.** It is
the contract between the modules; when in doubt, follow it and note what
you'd change in your report rather than changing someone else's files.

## Player flow

1. Tutorial ends (Phase.Landed at the lake party). The guide panel offers
   **Start the Expedition**. Fade to white; the tutorial root is hidden, the
   expedition root shown, `level.value = expeditionLevel`, the player is
   placed at Base Camp (`START_S`), the expedition kit goes in the pack, and
   the phase goes back to `Phase.Poling`.
2. Pole along the route. Sections, in order (arc lengths in `exp-layout.ts`):
   - **The Long Valley** (0-1710): dawn, a 1.7 km walk in. River with a log
     bridge at s=650. Eagles circle.
   - **Pine Switchbacks** (1006-2378): forest, light snow. Camp 1 at 2440.
   - **The Moraine** (2378-4137): boulders, switchbacks, midday. **Avalanche**
     triggered at s=3240 crosses the path at s=3330: get through (or back) in
     time, or be buried and respawn at the checkpoint. Camp 2 at 4200.
   - **Glacier & Cloud Sea** (4137-5753): afternoon. The route climbs
     *through the cloud deck at y=650* (whiteout around s 4450-4750), then
     breaks out above a sea of clouds. **Crevasse** at s=4500 crossed on a
     ladder (balance). **Serac field** 4880-5260 with a collapse at s=5060.
     Camp 3 at 5650.
   - **The Ice Wall** (~5760): 45 m of vertical ice at dusk in a blizzard,
     climbed with **ice axes** (climb wall `mode: 'axes'`).
   - **The Night Ridge** (5788-7477): clear night above the clouds, stars,
     moon, **aurora**, meteors. Headlamp. **Fixed rope traverse** on an
     exposed ledge 6450-6650 (clip the carabiner or you can't go on).
     **Rockfall** at s=6990. High Camp at 7300.
   - **Summit Rock Band** (~7495): 35 m of rock with holds (`mode: 'holds'`).
   - **The Summit** (7505-7788): pre-dawn to sunrise. Summit marker at
     s=7770. Take the packed glider out of the backpack and drop it to
     deploy; launch; glide ~3 km to the Base Camp party through the clouds.
3. Landing at Base Camp: fireworks, "thanks for playing", option to restart.

Time of day and baseline storm are **functions of progress**
(`timeOfDayAt(s)`, `baseStormAt(s)`) so night always falls on the ridge.
The director adds squalls on a real-time schedule on top ("weather
intervals").

## Coordinates and shared pure modules (already written; do not change
without telling the integrator)

- `exp-route.ts`: summit at (0, 1300, -9000). Radial profile `profile(r)`,
  cliff bands at r=720 (ice) and r=300 (rock), the route (`route`,
  `routePoint(s)`, `routeTangent(s)`, `sectionAt(s)`, `project(x, z, out)`
  giving arc length `s`, signed lateral `d` (+ = left of travel), `dist`,
  `elev`). Pure TS, no Three.js: safe in a web worker.
- `exp-terrain.ts`: `expeditionHeight(x, z)` is **the** ground height
  (natural relief + walkable bench along the route + camp pads + river
  channel + crevasse slot + rope ledge drop). `naturalHeight`,
  `expeditionSlope`. Worker-safe. ~0.7 us per sample.
- `exp-layout.ts`: camps (`CAMPS`, `campCentre`), feature arc lengths
  (river, crevasse, rope, avalanche, serac, rockfall), `routeFrame(s)`
  (position, tangent, left normal), `outwardSide(s)`, the two climbing
  bands (`ICE_WALL`, `ROCK_BAND`: foot point, outward normal, base/top
  heights, top stand point), `timeOfDayAt(s)`, `baseStormAt(s)`,
  `SECTION_NAMES`, walkable overrides `bridgeHeight(x, z)` and
  `ladderHeight(x, z)`.
- `exp-state.ts`: `exp` signals (active, section, checkpoint, summited,
  finished, ropeClipped), `expFrame` per-frame values (s, d, head,
  timeOfDay, daylight, sunDirection, moonDirection, squall, storm, aurora,
  cold), `expRefs.root` (the expedition root entity), `expHooks`
  (respawn, toast, terrainReady — installed by owners, no-ops by default).

The tutorial lives around the origin; the expedition sits around
(0, 0, -6000)…(0, 1300, -9000). Both exist in one scene; only one root is
visible at a time.

## Rendering rules (Quest 3 / Quest 2 at 72-90 fps)

- **Two depth layers** (`src/game/far-layer.ts`). The far layer (render
  order `FAR_LAYER_ORDER`) draws first with its own log depth (land
  material option `farLayer: true`, or `FAR_VERTEX_DEPTH` / fragment
  `farLayerDepth`), then `buildDepthClear()` clears depth, then the near
  layer draws normally (camera near 0.06, far 6000). **Near-layer geometry
  must never be behind far-layer geometry**: keep near content inside the
  streamed near-terrain disc around the player; the far mesh is sunk
  wherever near tiles exist.
- Budget for the whole expedition view: ≤ 160 draw calls, ≤ 700 k
  triangles, one DirectionalLight (sun/moon) with shadows + at most one
  SpotLight (headlamp, created once, toggled by intensity — never add or
  remove lights at runtime: it recompiles every shader). No other dynamic
  lights. Fake fire glow with emissive/additive sprites.
- Prefer merged static geometry (`GeometryBuilder` in `mesh-utils.ts`) and
  `InstancedMesh`. Avoid alpha-tested or transparent overdraw near the
  camera. Keep fragment shaders short; the land material is already heavy.
- Content far from the player must be hidden (group `visible = false`) or
  culled; build per-section groups.
- Never allocate in `update()`. Use `signal.peek()` in `update()`.
- Import Three only from `@iwsdk/core`.

## Existing systems you can rely on

- `Level` interface (`src/game/level.ts`): pole, climb, glide and weather
  systems ask `currentLevel()` for ground, walking rules, the climb wall,
  launch site, glide target, storm target and cloud deck.
- Phases (`src/game/state.ts`): Poling, Climbing, Building, Launch,
  Gliding, Landed. The expedition reuses Poling / Climbing / Launch /
  Gliding / Landed.
- Climbing (`climb-system.ts`): generic wall from `level.currentWall()`;
  `holds` mode uses `ClimbHold` entities (filtered to the wall's lane),
  `axes` mode needs the axes in both hands.
- Equipment + backpack (`equipment.ts`, `backpack-system.ts`, `items.ts`):
  turn a palm up to open the pack; items: poles, axes, carabiner, headlamp,
  thermos, warmer, map, flare, glider. `level.gliderDeployBlocker`,
  `level.deployGlider`, `level.onFlare`, `level.drawMap`.
- Fires: `Bonfire` + `CampfireSystem.addFire` (`campfire.ts`). Use
  `light: false` on the expedition.
- Audio: `audio` (`audio.ts`) has rumble, crack, impact, eagleCry, axeBite,
  crunch, zip, whoosh, chime, fanfare, setWind/setStorm/setFire, music
  ('river', 'night'), plus `context()`, `output()`, `noiseBuffer()` for new
  sound modules.
- Weather (`weather-system.ts`): storm level follows
  `currentLevel().stormTarget(head)`; snow, spindrift, fog, sky storm.
- Land material (`land-material.ts`): `createLandMaterial({...})`.

## Module ownership (one agent each; stay in your folder)

| Area | Folder / files | Exports for integration |
| --- | --- | --- |
| Terrain streaming | `expedition/terrain/` | `ExpeditionTerrainSystem`; sets `expHooks.terrainReady` |
| World content | `expedition/world/` | `ExpeditionWorldSystem` (creates `expRefs.root` children per section, ClimbHold entities for the rock band, ice-wall and rock-band meshes matching `ICE_WALL` / `ROCK_BAND`) |
| Mechanics | `expedition/mechanics/` | `RopeSystem`, `LadderSystem` (+ log bridge balance); `walkGate` (see below) |
| Director + level | `expedition/expedition-level.ts`, `expedition/director/` | `expeditionLevel`, `ExpeditionDirectorSystem`, wrist HUD; guide copy + Start button; installs `expHooks.respawn/toast`; creates `expRefs.root` |
| Sky, time, weather | `expedition/sky/` | `ExpeditionSkySystem` (day/night, moon, stars, aurora, meteors, cloud deck from both sides, squalls) |
| Events FX | `expedition/fx/` | `ExpeditionEventsSystem` (avalanche, serac collapse, rockfall, eagles, finale fireworks) |
| Soundscape | `expedition/audio/` | `ExpeditionSoundSystem` |

`expRefs.root` is created by the director **before** other expedition
systems' `init()` runs: register the director first (it creates the root in
its constructor-time `init`). If you need the root and it is null, create
your groups lazily in `update()` the first frame it exists.

**Walk gate** (`expedition/mechanics/walk-gate.ts`, owned by mechanics):
`export const walkGate = { blockS: Infinity, reason: '' }` — the furthest
arc length the player may walk to right now. The level clamps progress to
`blockS` and shows `reason`. Mechanics sets it before the rope until
clipped.

## Shared files

Shared files outside your folder (`state.ts`, `guide-system.ts`,
`audio.ts`, `sky.ts`, `weather-system.ts`, `scene-system.ts`, `index.ts`,
`level.ts`) may get **small, additive** edits only (a new export, a hook,
an optional parameter). List every such edit in your report. Don't
reformat or restructure them.

`src/index.ts` registration is done by the integrator; tell us your
systems, their priorities and dependencies.

## Verification

Each agent: `npx tsc --noEmit -p .` clean and `npx vite build` succeeds.
Write a node check (bundle with `npx esbuild <file> --bundle
--platform=node`) for anything pure. Don't run the IWSDK dev server or a
browser: several agents share the machine. The integrator runs the
browser/XR tests after merging.
