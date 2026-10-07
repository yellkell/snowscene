/**
 * Outside VR, drag on the canvas to look around. The browser camera is a
 * child of the player rig, so rig motion (walking, gliding, turning) still
 * carries the view along.
 */

import { createSystem } from '@iwsdk/core';
import { game, Phase } from './state.js';

/** Comfortable default pitch for each phase when viewing on a flat screen. */
const PHASE_PITCH: Partial<Record<Phase, number>> = {
  [Phase.Climbing]: 0.45,
  [Phase.Cave]: -0.12,
  [Phase.Beacon]: -0.15,
  [Phase.Sliding]: -0.12,
  [Phase.Building]: -0.42,
  [Phase.Launch]: -0.32,
  [Phase.Gliding]: -0.28,
  [Phase.Landed]: 0.05,
};

export class DesktopLookSystem extends createSystem({}) {
  private yaw = 0;
  private pitch = 0;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;

  init(): void {
    const camera = this.world.camera;
    camera.rotation.order = 'YXZ';
    this.yaw = camera.rotation.y;
    this.pitch = camera.rotation.x;
    const canvas = this.world.renderer.domElement;
    const down = (e: PointerEvent) => {
      if (this.world.renderer.xr.isPresenting) return;
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    };
    const move = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.yaw -= (e.clientX - this.lastX) * 0.004;
      this.pitch -= (e.clientY - this.lastY) * 0.004;
      this.pitch = Math.max(-1.2, Math.min(1.2, this.pitch));
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    };
    const up = () => {
      this.dragging = false;
    };
    canvas.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    const initialPitch = this.pitch;
    this.cleanupFuncs.push(
      game.phase.subscribe((phase) => {
        this.pitch = PHASE_PITCH[phase] ?? initialPitch;
        if (phase === Phase.Poling || phase === Phase.Cave || phase === Phase.Sliding || phase === Phase.Building) this.yaw = 0;
      }),
      () => canvas.removeEventListener('pointerdown', down),
      () => window.removeEventListener('pointermove', move),
      () => window.removeEventListener('pointerup', up),
    );
  }

  update(): void {
    if (this.world.renderer.xr.isPresenting) return;
    const camera = this.world.camera;
    camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }
}
