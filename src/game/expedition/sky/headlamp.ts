/**
 * The headlamp: one SpotLight, created once and then only ever toggled by
 * intensity. Adding, removing or hiding a light changes the light count
 * every lit shader is compiled for, so each toggle used to recompile the
 * whole scene (a long hitch on Quest). Now the light is created the first
 * time it is needed (when the expedition starts, behind the fade, or the
 * first time it is worn in the tutorial) and stays in the scene for good.
 *
 * The backpack owns *when* it is on and where it points; the expedition sky
 * sets `gain` so it stays a pleasant pool of light as exposure opens up at
 * night.
 */

import { SpotLight, type Vector3, type World } from '@iwsdk/core';

const COLOR = 0xfff2d8;
const BASE_INTENSITY = 260;
const RANGE = 45;
const ANGLE = 0.42;
const PENUMBRA = 0.45;
const DECAY = 1.6;

class Headlamp {
  private world: World | null = null;
  private light: SpotLight | null = null;
  private on = false;
  /** Brightness multiplier (1 = the tutorial's lamp). */
  gain = 1;

  /** Remember the world so the light can be created later. */
  attach(world: World): void {
    this.world = world;
  }

  /**
   * Create the light now (at intensity 0) if it doesn't exist yet. Call it
   * while the screen is faded: it triggers a one-off shader recompile.
   */
  ensure(): SpotLight | null {
    if (this.light || !this.world) return this.light;
    const light = new SpotLight(COLOR, 0, RANGE, ANGLE, PENUMBRA, DECAY);
    light.name = 'Headlamp';
    this.world.createTransformEntity(light, { persistent: true });
    this.world.createTransformEntity(light.target, { persistent: true });
    this.light = light;
    return light;
  }

  setOn(on: boolean): void {
    this.on = on;
    if (on) this.ensure();
    this.apply();
  }

  isOn(): boolean {
    return this.on;
  }

  /** Point the lamp from `position` along unit `direction`. */
  aim(position: Vector3, direction: Vector3): void {
    const light = this.light;
    if (!light) return;
    light.position.copy(position);
    light.target.position.copy(position).addScaledVector(direction, 10);
    light.target.updateMatrixWorld();
    this.apply();
  }

  private apply(): void {
    if (this.light) this.light.intensity = this.on ? BASE_INTENSITY * this.gain : 0;
  }
}

export const headlamp = new Headlamp();
