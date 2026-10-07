# Snow Scene

A realistic golden-hour alpine experience for WebXR hand tracking, built with
the [Immersive Web SDK](https://iwsdk.dev). A physically based sunset sky,
shadowed snow and granite, a snow-laden spruce forest and a horizon of
8,000 m-class giants rising from a sea of clouds frame the journey:

1. **Pole up the trail.** Make a fist to grip each walking pole. Plant the tip
   in the snow and pull your hand back to push yourself up the mountain;
   momentum carries you between strokes.
2. **Climb the cliff.** Reach for a glowing hold, close your hand to grab it
   and pull down to lift yourself. Go hand over hand and haul yourself over the
   summit lip.
3. **Ride the timber works.** The glider kit on the summit is empty: its
   parts are up in the old timber works, an ice cave inside the Needle (the
   rock column behind the summit). The works are a 28-platform room-scale
   course in the spirit of ff2's VOIDSTEP: log rafts on a meltwater pool,
   rope hoists, an incline cart, rope swings, a mill wheel with level-hung
   gondolas, an ore skip, a ropeway and a chimney trolley, climbing 26 m on
   their own clock. Step onto a deck when its signal lamps are green; amber
   lamps go out one per beat before it leaves, and red means it is moving.
   No room to walk? Reach over the green deck and close your hand to be
   carried onto it. Take the left wing, right wing and control bar from their
   racks on the way up (a deck leaving a rack waits until you have).
4. **Light the beacon.** At the top of the chimney, take the torch off its
   hook and hold it to the brazier. The beacon on top of the Needle tells the
   party on the lake that you are on your way.
5. **Ride the flume.** An old log flume spirals down the outside of the
   Needle in two runs, HELTER style. Lean (or duck) into the open lane to
   get past the boards, icicles and ore buckets hanging from the gantries;
   clip one and that run starts again.
6. **Build a glider.** At the foot of the Needle, carry each part you
   recovered to its glowing outline on the workbench kit.
7. **Glide home.** Close both hands on the control bar to launch. Tilt the bar
   like a steering wheel to turn; pull it in to dive, push it out to float.
   Land in the valley. Thanks for playing!

Music: "By the River" accompanies the ascent and crossfades into "Night
Catch" when the beacon is lit (`public/audio/`).

The weather follows the journey: you pole up through a proper blizzard
(driving, wind-streaked snow, whiteout and howling gusts) that peaks on the
cliff. As you haul over the top the storm breaks into a dusk sky, revealing a
party bonfire on the frozen lake far below. Glide down to join it; a gentle
approach assist lines you up to land at the edge of the party.

## Input

| Mode            | Grip                          | Glide                      |
| --------------- | ----------------------------- | -------------------------- |
| Hand tracking   | Fist (a firm pinch also works) | Hands on the bar           |
| Controllers     | Squeeze or trigger            | Bar, or thumbstick         |
| Desktop browser | W to pole/climb/step across, E to take or fit parts and light the beacon, A/D to lean on the flume, Space to launch | A/D steer, W dive, S float |

Drag the mouse to look around on desktop.

Lost your bearings, or drifted towards the edge of your room? Open the
backpack (left palm up) and poke the brass **recentre** button on its front
with your right index finger (R on desktop). In the cave it puts you back on
the middle of the deck you're standing on; on the flume it makes where you
stand the middle lane; on the trail it turns you up the trail; at the
workbench it stands you back at the bench; after landing it faces you to the
fire.

## Develop

```sh
npm install
npm run dev        # managed dev server + IWER XR emulator
npm run typecheck
npm run build      # static site in dist/
```

Pushes to `main` deploy to GitHub Pages via
`.github/workflows/deploy-pages.yml` (Pages source: GitHub Actions). WebXR
needs HTTPS, which Pages provides; open the site in the Meta Quest browser
and press **Enter VR**.

## Layout

- `src/game/terrain.ts`: analytic heightfield shared by rendering and gameplay
- `src/game/world-builders.ts`, `glider-model.ts`: procedural meshes
- `src/game/land-material.ts`, `textures.ts`: snow/rock material and
  procedurally generated textures
- `src/game/sky.ts`, `far-ranges.ts`, `trees.ts`: sky, sea of clouds, great
  ranges and spruce forest
- `src/game/hand-input.ts`: fist/pinch/controller grip detection
- `src/game/pole-system.ts`: walking-pole locomotion
- `src/game/climb-system.ts`: hold grabbing, pulling and mantling
- `src/game/cave/`: the timber works in the ice cave. `cave-score.ts` is the
  platform timetable and its validator (every route step shares a berth,
  nothing collides over the whole cycle), `cave-build.ts` the cave and
  machines, `cave-system.ts` the moving frame of reference, parts and beacon
- `src/game/flume/`: the Needle, its portal and the log flume (`flume-path.ts`
  is the spiral by arc length, `flume-system.ts` the ride and hazards)
- `src/game/glider-build-system.ts`: summit kit assembly
- `src/game/glide-system.ts`: launch, flight and landing
- `src/game/weather-system.ts`: blizzard snowfall, spindrift, fog and wind
- `src/game/campfire.ts`: the bonfire party on the lake
- `src/game/guide-system.ts`: guide panel (`public/ui/guide.uikitml`)
- Tuning constants (pole gain, grab radii, glide speeds) sit at the top of
  each system file.
