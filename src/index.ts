/**
 * Snow Scene: pole up a mountain trail, climb the final cliff, build a hang
 * glider on the summit and glide back down to the valley. Designed for
 * WebXR hand tracking, with controller and desktop fallbacks.
 */

import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { audio } from './game/audio.js';
import { BackpackSystem } from './game/backpack-system.js';
import { CampfireSystem } from './game/campfire.js';
import { ClimbSystem } from './game/climb-system.js';
import { DesktopLookSystem } from './game/desktop-look-system.js';
import { ExpeditionDirectorSystem } from './game/expedition/director/director-system.js';
import { WristHudSystem } from './game/expedition/director/wrist-hud.js';
import { CrossingGuardSystem } from './game/expedition/mechanics/crossing-guard-system.js';
import { LadderSystem } from './game/expedition/mechanics/ladder-system.js';
import { RopeSystem } from './game/expedition/mechanics/rope-system.js';
import { GlideSystem } from './game/glide-system.js';
import { GliderBuildSystem } from './game/glider-build-system.js';
import { GuideSystem } from './game/guide-system.js';
import { HandInputSystem, hands } from './game/hand-input.js';
import { PoleSystem } from './game/pole-system.js';
import { SceneSetupSystem } from './game/scene-system.js';
import { WeatherSystem } from './game/weather-system.js';
import { game, Phase, setPhase } from './game/state.js';
import { level } from './game/level.js';
import { startTutorialKit } from './game/tutorial-kit.js';
import { tutorialLevel } from './game/tutorial-level.js';

// The tutorial is the starting level; the expedition follows it.
level.value = tutorialLevel;
startTutorialKit();

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  world
    .registerSystem(SceneSetupSystem, { priority: 20 })
    .registerSystem(WeatherSystem, { priority: 21 })
    .registerSystem(CampfireSystem, { priority: 22 })
    .registerSystem(HandInputSystem, { priority: 0 })
    .registerSystem(DesktopLookSystem, { priority: 1 })
    .registerSystem(BackpackSystem, { priority: 2 })
    .registerSystem(PoleSystem, { priority: 10 })
    .registerSystem(ClimbSystem, { priority: 11 })
    .registerSystem(GliderBuildSystem, { priority: 12 })
    .registerSystem(GlideSystem, { priority: 13 })
    .registerSystem(GuideSystem, { priority: 30 })
    // The expedition (?expedition / ?expedition&s=5000 start it directly).
    // The director must be registered before other expedition systems.
    .registerSystem(ExpeditionDirectorSystem, { priority: 5 })
    .registerSystem(WristHudSystem, { priority: 31 })
    // Expedition crossings: Rope < Ladder < Pole (10) < Guard < Climb (11).
    .registerSystem(RopeSystem, { priority: 9 })
    .registerSystem(LadderSystem, { priority: 9.5 })
    .registerSystem(CrossingGuardSystem, { priority: 10.5 });

  // Dev-only handle for automated checks and quick phase skipping.
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__snow = { world, game, hands, audio, Phase, setPhase };
  }
});
