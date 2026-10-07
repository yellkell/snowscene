/**
 * Runs after locomotion (priority 10.5: after PoleSystem = 10, before
 * ClimbSystem = 11) and makes the crossing rules hold whatever moved the
 * rig this frame:
 *
 *  - records the speed the player *tried* to move at (`game.velocity`
 *    before any cap) for the balance model;
 *  - enforces `mechanicsSpeedLimit()` on the rig's horizontal displacement
 *    since the early mechanics ran (a fallback: if the pole system already
 *    applies the limit, this does nothing);
 *  - keeps the head inside the lateral funnel onto the ladder / log;
 *  - holds the rig below the floor while falling (so the pole system's
 *    ground glue doesn't pop you back up before the fade).
 */

import { createSystem, Vector3 } from '@iwsdk/core';
import { getHeadWorld } from '../../rig.js';
import { game, Phase } from '../../state.js';
import { exp } from '../exp-state.js';
import { mechanics, mechanicsSpeedLimit } from './mechanics-state.js';

/** Displacements bigger than this in one frame are teleports, not walking. */
const TELEPORT = 2;

export class CrossingGuardSystem extends createSystem({}) {
  private readonly head = new Vector3();

  update(delta: number): void {
    const dt = Math.max(1e-3, Math.min(delta, 0.1));
    if (!exp.active.peek() || game.phase.peek() !== Phase.Poling) {
      mechanics.attemptedSpeed = 0;
      return;
    }
    const rig = this.player;
    const v = Math.hypot(game.velocity.x, game.velocity.z);
    mechanics.attemptedSpeed += (v - mechanics.attemptedSpeed) * (1 - Math.exp(-10 * dt));

    // Something teleported the rig since the early mechanics ran (a respawn)?
    const mark = mechanics.rigMark;
    const teleported =
      mark.valid && Math.hypot(rig.position.x - mark.x, rig.position.z - mark.z) >= TELEPORT;

    const limit = mechanicsSpeedLimit();
    if (limit < Infinity && !teleported) {
      if (v > limit) {
        const k = limit / v;
        game.velocity.x *= k;
        game.velocity.z *= k;
      }
      if (mark.valid) {
        const dx = rig.position.x - mark.x;
        const dz = rig.position.z - mark.z;
        const d = Math.hypot(dx, dz);
        const allowed = limit * dt * 1.05;
        if (d > allowed) {
          const k = allowed / d;
          rig.position.x = mark.x + dx * k;
          rig.position.z = mark.z + dz * k;
        }
      }
    }

    const f = mechanics.funnel;
    if (f.active && f.halfWidth < Infinity && !teleported) {
      rig.updateMatrixWorld(true);
      getHeadWorld(this.world, this.head);
      const l = (this.head.x - f.x) * f.nx + (this.head.z - f.z) * f.nz;
      const w = f.halfWidth;
      if (l > w || l < -w) {
        const excess = l > w ? l - w : l + w;
        rig.position.x -= f.nx * excess;
        rig.position.z -= f.nz * excess;
        // Velocity into the edge is lost.
        const vn = game.velocity.x * f.nx + game.velocity.z * f.nz;
        if (vn * excess > 0) {
          game.velocity.x -= f.nx * vn;
          game.velocity.z -= f.nz * vn;
        }
      }
    }

    if (mechanics.sinking && !teleported) {
      rig.position.y = mechanics.sinkFloor - mechanics.sink;
    }
    rig.updateMatrixWorld(true);
  }
}
