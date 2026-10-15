// Node stand-in for @iwsdk/core so the game's layout modules can run in the art pipeline: three.js plus
// inert versions of the ECS/runtime helpers (nothing here renders or ticks).
export * from 'three';
export function signal(v) {
  return { value: v, peek() { return this.value; }, subscribe() { return () => {}; } };
}
export const Types = new Proxy({}, { get: (_, k) => String(k) });
export const createComponent = (name) => ({ name });
export const defineComponents = (c) => c;
export const defineAssets = (a) => a;
export const createSystem = () => class { constructor() { this.queries = {}; this.cleanupFuncs = []; } };
export const AssetType = new Proxy({}, { get: (_, k) => String(k) });
export const InputComponent = new Proxy({}, { get: (_, k) => String(k) });
export const VisibilityState = new Proxy({}, { get: (_, k) => String(k) });
export class World {}
export class Entity {}
export class XRHandVisualAdapter {}
export const UIKit = {};
export const UIKitMLAsset = {};
