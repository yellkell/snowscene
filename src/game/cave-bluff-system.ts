/**
 * The bluff at the back of the summit shoulder: its face with the cave mouth,
 * and the beacon deck on top, which only appears once you come up out of the
 * cave (from the top of the climb you see nothing but the cave). The beacon
 * fire burns on the deck once it is lit, seen from the lake party below.
 */

import { createSystem, type Mesh } from '@iwsdk/core';
import { Bonfire, fires } from './campfire.js';
import { BEACON_TOP, buildBluffWorld } from './cave-bluff.js';
import { sceneRefs } from './scene-system.js';
import { game, Phase } from './state.js';

/** Phases after the cave, when the deck on top is in use. */
export function bluffTopInUse(phase: Phase): boolean {
  return phase === Phase.Building || phase === Phase.Launch || phase === Phase.Gliding || phase === Phase.Landed;
}

export class CaveBluffSystem extends createSystem({}) {
  private beacon!: Bonfire;
  private deck!: Mesh;

  init(): void {
    const parent = sceneRefs.tutorialRoot ?? undefined;
    const bluff = buildBluffWorld();
    this.deck = bluff.deck;
    this.world.createTransformEntity(bluff.root, { parent, persistent: true });

    this.beacon = new Bonfire(BEACON_TOP, { scale: 0.32, party: false, light: false });
    for (const object of this.beacon.objects) this.world.createTransformEntity(object, { parent, persistent: true });
    fires.push(this.beacon);
    this.beacon.setVisible(false);
    const refresh = () => {
      this.deck.visible = game.beaconLit.peek() || bluffTopInUse(game.phase.peek());
    };
    refresh();
    this.cleanupFuncs.push(
      game.beaconLit.subscribe((lit) => {
        this.beacon.setVisible(lit);
        refresh();
      }),
      game.phase.subscribe(refresh),
    );
  }
}
