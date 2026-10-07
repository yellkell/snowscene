/** Messages between the terrain streamer and its worker (types only). */

export type WorkerRequest =
  | { t: 'tile'; id: number; level: number; x: number; z: number; buf: ArrayBuffer }
  | { t: 'far' }
  | { t: 'backdrop' };

export type WorkerResponse =
  | { t: 'tile'; id: number; buf: ArrayBuffer; ms: number }
  | { t: 'far' | 'backdrop'; positions: Float32Array; normals: Int16Array; indices: Uint32Array; ms: number };
