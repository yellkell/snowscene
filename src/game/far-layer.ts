/**
 * Two depth layers so distant scenery never z-fights.
 *
 * A single hyperbolic depth buffer spanning 8 cm to tens of kilometres has
 * almost no precision left past a few kilometres, so far ridges shimmer
 * through each other in the headset. Instead:
 *
 *  1. The far layer (great ranges, cloud sea) is drawn first with its own
 *     logarithmic depth over the whole buffer, ignoring the camera far plane.
 *  2. A tiny marker object then clears the depth buffer.
 *  3. Everything else (the near layer) draws normally with a short camera
 *     range, always in front of the far layer.
 *
 * Near-layer geometry must therefore never sit behind far-layer geometry:
 * the ranges start where the playable terrain ends.
 */

import { BufferAttribute, BufferGeometry, Mesh, MeshBasicMaterial, type WebGLRenderer } from '@iwsdk/core';

/** Render orders: sky (-1e9) < far layer < depth clear < everything else. */
export const FAR_LAYER_ORDER = -1000;
export const FAR_CLEAR_ORDER = -900;

const FAR_NEAR = 10;
const FAR_FAR = 120000;

/** GLSL helper: view depth (metres in front of the eye) to 0..1 log depth. */
export const FAR_DEPTH_GLSL = /* glsl */ `
float farLayerDepth(float viewZ) {
  return clamp(log(max(viewZ, ${FAR_NEAR.toFixed(1)}) / ${FAR_NEAR.toFixed(1)}) / ${Math.log(FAR_FAR / FAR_NEAR).toFixed(6)}, 0.0, 1.0);
}
`;

/**
 * Vertex statement (after gl_Position and mvPosition exist): replace the
 * projected depth with the far layer's log depth.
 */
export const FAR_VERTEX_DEPTH = /* glsl */ `
gl_Position.z = (farLayerDepth(-mvPosition.z) * 2.0 - 1.0) * gl_Position.w;
`;

/** Invisible object whose only job is to clear depth between the layers. */
export function buildDepthClear(): Mesh {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
  const mesh = new Mesh(
    geometry,
    new MeshBasicMaterial({ colorWrite: false, depthWrite: true, depthTest: false }),
  );
  mesh.name = 'FarLayerDepthClear';
  mesh.frustumCulled = false;
  mesh.renderOrder = FAR_CLEAR_ORDER;
  mesh.onAfterRender = (renderer: WebGLRenderer) => {
    renderer.state.buffers.depth.setMask(true);
    renderer.clearDepth();
  };
  return mesh;
}
