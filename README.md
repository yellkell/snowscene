# Snow Scene

A golden-hour alpine experience for WebXR hand tracking, built with the
[Immersive Web SDK](https://iwsdk.dev):

1. **Pole up the trail.** Make a fist to grip each walking pole. Plant the tip
   in the snow and pull your hand back to push yourself up the mountain;
   momentum carries you between strokes.
2. **Climb the cliff.** Reach for a glowing hold, close your hand to grab it
   and pull down to lift yourself. Go hand over hand and haul yourself over the
   summit lip.
3. **Build a glider.** Carry each loose part (two wings and the control bar)
   to its glowing outline on the workbench kit.
4. **Glide home.** Close both hands on the control bar to launch. Tilt the bar
   like a steering wheel to turn; pull it in to dive, push it out to float.
   Land in the valley. Thanks for playing!

## Input

| Mode            | Grip                          | Glide                      |
| --------------- | ----------------------------- | -------------------------- |
| Hand tracking   | Fist (a firm pinch also works) | Hands on the bar           |
| Controllers     | Squeeze or trigger            | Bar, or thumbstick         |
| Desktop browser | W to pole/climb, E to fit parts, Space to launch | A/D steer, W dive, S float |

Drag the mouse to look around on desktop.

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
- `src/game/hand-input.ts`: fist/pinch/controller grip detection
- `src/game/pole-system.ts`: walking-pole locomotion
- `src/game/climb-system.ts`: hold grabbing, pulling and mantling
- `src/game/glider-build-system.ts`: summit kit assembly
- `src/game/glide-system.ts`: launch, flight and landing
- `src/game/guide-system.ts`: guide panel (`public/ui/guide.uikitml`)
- Tuning constants (pole gain, grab radii, glide speeds) sit at the top of
  each system file.
