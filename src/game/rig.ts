/**
 * Helpers for moving the player rig (XROrigin). The rig's origin is the
 * centre of the user's play space on the floor; the head can be anywhere
 * inside it, so gameplay positions are expressed in terms of the head.
 */

import { Quaternion, Vector3, type World } from '@iwsdk/core';

const tmpQuat = new Quaternion();
const tmpVec = new Vector3();
const yAxis = new Vector3(0, 1, 0);

/** World-space eye position (falls back to the browser camera outside XR). */
export function getHeadWorld(world: World, out: Vector3): Vector3 {
  if (world.renderer.xr.isPresenting) {
    world.player.head.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(world.player.head.matrixWorld);
  }
  world.camera.updateWorldMatrix(true, false);
  return out.setFromMatrixPosition(world.camera.matrixWorld);
}

/** World-space yaw of the viewer, where yaw 0 faces -Z. */
export function getHeadYaw(world: World): number {
  const source = world.renderer.xr.isPresenting ? world.player.head : world.camera;
  source.updateWorldMatrix(true, false);
  source.getWorldQuaternion(tmpQuat);
  tmpVec.set(0, 0, -1).applyQuaternion(tmpQuat);
  return Math.atan2(-tmpVec.x, -tmpVec.z);
}

/** Unit horizontal vector for a yaw angle (yaw 0 = -Z). */
export function yawForward(yaw: number, out: Vector3): Vector3 {
  return out.set(-Math.sin(yaw), 0, -Math.cos(yaw));
}

/** Rotate the rig about the vertical axis through the viewer's head. */
export function rotateRigAroundHead(world: World, angle: number, head: Vector3): void {
  const rig = world.player;
  tmpVec.copy(rig.position).sub(head);
  tmpVec.y = 0;
  tmpVec.applyAxisAngle(yAxis, angle);
  rig.position.x = head.x + tmpVec.x;
  rig.position.z = head.z + tmpVec.z;
  rig.rotation.y += angle;
  rig.updateMatrixWorld(true);
}

/** Translate the rig so the head ends up above (x, z) and the floor at y. */
export function placeHeadAt(world: World, x: number, z: number, floorY: number): void {
  const head = getHeadWorld(world, tmpVec);
  const rig = world.player;
  rig.position.x += x - head.x;
  rig.position.z += z - head.z;
  rig.position.y = floorY;
  rig.updateMatrixWorld(true);
}

/** Rotate the rig so the viewer faces `yaw` in the world (about the head). */
export function faceYaw(world: World, yaw: number): void {
  const head = getHeadWorld(world, new Vector3());
  rotateRigAroundHead(world, wrapAngle(yaw - getHeadYaw(world)), head);
}

export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
