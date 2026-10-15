/**
 * Snow Scene: pole up a mountain trail, climb the final cliff, ride the old
 * timber works up the ice cave inside the Needle to recover the glider parts
 * and light the beacon, then build the hang glider on top of the rock the cave
 * runs up inside and glide straight down to the valley. Snow Survivors, a
 * horde-survival arena, is offered from the guide panel. Designed for WebXR
 * hand tracking, with controller and desktop fallbacks.
 */

import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { audio } from './game/audio.js';
import { BackpackSystem } from './game/backpack-system.js';
import { CaveSystem } from './game/cave/cave-system.js';
import { SurvivorsSystem } from './game/survivors/survivors-system.js';
import { survivorsControl } from './game/survivors/survivors-state.js';
import { CampfireSystem } from './game/campfire.js';
import { ClimbSystem } from './game/climb-system.js';
import { DesktopLookSystem } from './game/desktop-look-system.js';
import { GlideSystem } from './game/glide-system.js';
import { GlideMistSystem } from './game/glide-mist.js';
import { GliderBuildSystem } from './game/glider-build-system.js';
import { GuideSystem } from './game/guide-system.js';
import { HandInputSystem, hands } from './game/hand-input.js';
import { CaveBluffSystem } from './game/cave-bluff-system.js';
import { PoleSystem } from './game/pole-system.js';
import { SceneSetupSystem } from './game/scene-system.js';
import { WeatherSystem } from './game/weather-system.js';
import { game, Phase, setPhase } from './game/state.js';
import { bakedView } from './game/baked/light.js';
import { lodDebug } from './game/fog-cull.js';
import { lodStats } from './game/baked/lod.js';
import { preloadGear } from './game/baked/dynamic.js';
import { initCompressedTextures, loadTexture } from './game/baked/loaders.js';
import { level } from './game/level.js';
import { addToPack, equipment } from './game/equipment.js';
import { startTutorialKit } from './game/tutorial-kit.js';
import { tutorialLevel } from './game/tutorial-level.js';
import { installToonStyle } from './game/toon-style.js';

// Debug: surface uncaught errors in the console (tools that read it don't see them otherwise).
if (import.meta.env.DEV || new URLSearchParams(window.location.search).has('debug')) {
  window.addEventListener('error', (e) => console.error('[uncaught]', e.message, e.error?.stack ?? ''));
  window.addEventListener('unhandledrejection', (e) =>
    console.error('[uncaught]', String((e.reason as Error)?.stack ?? e.reason)),
  );
}

// The stylised shading must be in place before any material compiles.
installToonStyle();

// The tutorial is the starting level.
level.value = tutorialLevel;
startTutorialKit();

// Baked gear (poles, glider parts) loads first: the builders use it synchronously.
void preloadGear().then(() =>
World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  initCompressedTextures(world.renderer);
  world
    .registerSystem(SceneSetupSystem, { priority: 20 })
    .registerSystem(GlideMistSystem, { priority: 20.5 })
    .registerSystem(WeatherSystem, { priority: 21 })
    .registerSystem(CampfireSystem, { priority: 22 })
    .registerSystem(HandInputSystem, { priority: 0 })
    .registerSystem(DesktopLookSystem, { priority: 1 })
    .registerSystem(BackpackSystem, { priority: 2 })
    .registerSystem(PoleSystem, { priority: 10 })
    .registerSystem(ClimbSystem, { priority: 11 })
    .registerSystem(GliderBuildSystem, { priority: 12 })
    .registerSystem(GlideSystem, { priority: 13 })
    .registerSystem(CaveSystem, { priority: 14 })
    .registerSystem(SurvivorsSystem, { priority: 16 })
    .registerSystem(CaveBluffSystem, { priority: 15 })
    .registerSystem(GuideSystem, { priority: 30 });

  // Dev-only handle for automated checks and quick phase skipping.
  if (import.meta.env.DEV || new URLSearchParams(window.location.search).has('debug')) {
    (globalThis as unknown as Record<string, unknown>).__snow = {
      world,
      game,
      hands,
      audio,
      Phase,
      setPhase,
      cave: world.getSystem(CaveSystem),
      equipment,
      addToPack,
      survivors: world.getSystem(SurvivorsSystem),
      survivorsControl,
      bakedView,
      loadTexture,
      lodDebug,
      lodStats,
      look: world.getSystem(DesktopLookSystem),
    };
    // Debug bridge for tools that can only navigate and read the console: #js=<code> evaluates
    // <code> (with `s` = this handle) and logs the result.
    const run = () => {
      const m = /^#js=(.*)$/s.exec(decodeURIComponent(window.location.hash));
      if (!m) return;
      try {
        // eslint-disable-next-line no-new-func
        const out = new Function('s', `return (${m[1]});`)((globalThis as Record<string, unknown>).__snow);
        Promise.resolve(out).then((v) => console.log('[js]', typeof v === 'string' ? v : JSON.stringify(v)));
      } catch (e) {
        console.log('[js] error', String(e));
      }
    };
    window.addEventListener('hashchange', run);
    run();
  }
}),
);
