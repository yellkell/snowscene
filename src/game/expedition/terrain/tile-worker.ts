/**
 * Terrain worker: builds near tiles and the static far geometry off the main
 * thread. Tile payload buffers are owned by the main thread's pool and
 * travel here and back as transferables, so steady-state streaming does not
 * allocate.
 *
 * Messages in:  { t: 'tile', id, level, x, z, buf }   (buf transferred)
 *               { t: 'far' } | { t: 'backdrop' }
 * Messages out: { t: 'tile', id, buf, ms }
 *               { t: 'far' | 'backdrop', positions, normals, indices, ms }
 */

import { buildBackdrop, buildFarMesh } from './far-builder.js';
import { LEVELS } from './terrain-config.js';
import { buildTile, payloadViews, tileScratchSize } from './tile-builder.js';
import type { WorkerRequest, WorkerResponse } from './worker-protocol.js';

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer: Transferable[]): void;
};

const scratch = new Float64Array(Math.max(...LEVELS.map(tileScratchSize)));

scope.onmessage = (e) => {
  const msg = e.data;
  const t0 = performance.now();
  if (msg.t === 'tile') {
    const spec = LEVELS[msg.level];
    buildTile(spec, msg.x, msg.z, payloadViews(spec, msg.buf), scratch);
    scope.postMessage({ t: 'tile', id: msg.id, buf: msg.buf, ms: performance.now() - t0 }, [msg.buf]);
    return;
  }
  const mesh = msg.t === 'far' ? buildFarMesh() : buildBackdrop();
  scope.postMessage(
    { t: msg.t, positions: mesh.positions, normals: mesh.normals, indices: mesh.indices, ms: performance.now() - t0 },
    [mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer],
  );
};
