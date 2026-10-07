/**
 * GPU side of the expedition terrain: land materials extended for slot
 * batches and the far-mesh sink, the per-level tile batch (one draw call per
 * LOD level), and the far mesh / backdrop meshes.
 *
 * A TileBatch is one Mesh whose geometry holds SLOTS_PER_LEVEL tiles of one
 * level back to back. The x/z grid is a static attribute; heights, normals
 * and cliff-warp offsets are written per slot with update ranges (one tile
 * = one bufferSubData per attribute). The vertex shader finds its slot from
 * gl_VertexID, adds the slot origin from a uniform, sinks vertices that lie
 * inside any finer level's rectangle and collapses hidden slots to a point.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Mesh,
  type MeshStandardMaterial,
  Sphere,
  Vector3,
  Vector4,
  type WebGLRenderer,
} from '@iwsdk/core';
import { FAR_LAYER_ORDER } from '../../far-layer.js';
import { createLandMaterial, type LandMaterialOptions } from '../../land-material.js';
import { EXP_CLOUD_DECK_Y } from '../exp-layout.js';
import type { MeshData } from './far-builder.js';
import { FAR_SINK, HOLE_SINK, LEVEL_COUNT, SLOTS_PER_LEVEL, type TileLevelSpec, tileIndexCount, tileVertexCount } from './terrain-config.js';
import { payloadViews, tileIndexPattern, tileLocalPositions } from './tile-builder.js';
import type { TileSink } from './tile-scheduler.js';

/** Shared knobs other expedition modules may tune (sky/weather). */
export const terrainUniforms = {
  /** Haze where land meets the cloud deck (follows the scene fog colour). */
  uExpMistColor: { value: new Color(0.88, 0.9, 0.94) },
  uExpMistStrength: { value: 0.7 },
  uExpMistY: { value: EXP_CLOUD_DECK_Y },
};

type CompileHook = MeshStandardMaterial['onBeforeCompile'];
type Shader = Parameters<CompileHook>[0];

/** Run `edit` after the land material's own shader patch; extend the cache key. */
function chain(material: MeshStandardMaterial, key: string, edit: (shader: Shader) => void): void {
  const base = material.onBeforeCompile;
  const baseKey = material.customProgramCacheKey();
  material.onBeforeCompile = (shader: Shader, renderer: WebGLRenderer) => {
    base.call(material, shader, renderer);
    edit(shader);
  };
  material.customProgramCacheKey = () => `${baseKey}|${key}`;
}

function replaceOnce(source: string, find: string, replacement: string): string {
  if (!source.includes(find)) throw new Error(`terrain shader: missing ${find}`);
  return source.replace(find, replacement);
}

/** Cloud-deck haze on distant land, from whichever side the viewer is on. */
function addMist(material: MeshStandardMaterial): void {
  chain(material, 'expmist', (shader) => {
    shader.uniforms.uExpMistColor = terrainUniforms.uExpMistColor;
    shader.uniforms.uExpMistStrength = terrainUniforms.uExpMistStrength;
    shader.uniforms.uExpMistY = terrainUniforms.uExpMistY;
    shader.fragmentShader = replaceOnce(
      shader.fragmentShader,
      '#include <common>',
      `#include <common>
      uniform vec3 uExpMistColor;
      uniform float uExpMistStrength;
      uniform float uExpMistY;`,
    );
    shader.fragmentShader = replaceOnce(
      shader.fragmentShader,
      '#include <fog_fragment>',
      `#include <fog_fragment>
      {
        float expBand = cameraPosition.y > uExpMistY
          ? 1.0 - smoothstep(uExpMistY - 15.0, uExpMistY + 280.0, vLandWorld.y)
          : smoothstep(uExpMistY - 280.0, uExpMistY + 15.0, vLandWorld.y);
        float expFar = smoothstep(150.0, 700.0, distance(cameraPosition, vLandWorld));
        gl_FragColor.rgb = mix(gl_FragColor.rgb, uExpMistColor, expBand * expFar * uExpMistStrength);
      }`,
    );
  });
}

// ------------------------------------------------------------ tile batch --

const EMPTY_RECT = 1e9;
/** Rectangles shrink by this much so vertices exactly on an edge stay up. */
const HOLE_TOLERANCE = 0.05;

function tileMaterial(fine: boolean, warp: boolean, slots: Vector4[], holes: Vector4[], vps: number, spacing: number): MeshStandardMaterial {
  const opts: LandMaterialOptions = fine
    ? { sparkle: true, rockScale: 5, snowCling: 0.04 }
    : { rockScale: 5, snowCling: 0.04 };
  const material = createLandMaterial(opts);
  const uniforms = {
    uTileSlots: { value: slots },
    uTileHoles: { value: holes },
    uTileVps: { value: vps },
    uTileSpacing: { value: spacing },
  };
  chain(material, `exptile:${warp ? 1 : 0}`, (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = replaceOnce(
      shader.vertexShader,
      '#include <common>',
      `#include <common>
      ${warp ? '#define EXP_TILE_WARP' : ''}
      attribute float aHeight;
      #ifdef EXP_TILE_WARP
      attribute vec2 aWarp;
      #endif
      uniform vec4 uTileSlots[${SLOTS_PER_LEVEL}];
      uniform vec4 uTileHoles[${LEVEL_COUNT}];
      uniform int uTileVps;
      uniform float uTileSpacing;`,
    );
    shader.vertexShader = replaceOnce(
      shader.vertexShader,
      '#include <begin_vertex>',
      `#include <begin_vertex>
      {
        vec4 tileS = uTileSlots[gl_VertexID / uTileVps];
        transformed = vec3(tileS.x + position.x, aHeight + position.y, tileS.y + position.z);
        // Inside a finer level's block: drop out of sight under it.
        for (int k = 0; k < ${LEVEL_COUNT}; k++) {
          vec4 R = uTileHoles[k];
          if (transformed.x > R.x && transformed.x < R.z && transformed.z > R.y && transformed.z < R.w) {
            transformed.y -= ${HOLE_SINK.toFixed(1)};
            break;
          }
        }
        #ifdef EXP_TILE_WARP
        transformed.xz += aWarp * uTileSpacing;
        #endif
        // Hidden slot: every vertex at one point, so nothing rasterises.
        if (tileS.z < 0.5) transformed = vec3(0.0, -1.0e5, 0.0);
      }`,
    );
  });
  if (!fine) addMist(material);
  return material;
}

export class TileBatch implements TileSink {
  readonly mesh: Mesh;
  readonly vertsPerSlot: number;
  readonly indicesPerSlot: number;
  private readonly heights: BufferAttribute;
  private readonly normals: BufferAttribute;
  private readonly warp: BufferAttribute | null;
  private readonly slots: Vector4[] = [];
  private readonly holes: Vector4[] = [];
  private written = 0;
  private uploaded = 0;
  /** A full re-upload is queued: stop adding ranges until it happens. */
  private full = false;

  constructor(
    readonly spec: TileLevelSpec,
    name: string,
  ) {
    const v = tileVertexCount(spec.quads);
    const ni = tileIndexCount(spec.quads);
    this.vertsPerSlot = v;
    this.indicesPerSlot = ni;
    const local = tileLocalPositions(spec);
    const pattern = tileIndexPattern(spec.quads);
    const positions = new Float32Array(SLOTS_PER_LEVEL * v * 3);
    const indices = new Uint32Array(SLOTS_PER_LEVEL * ni);
    for (let s = 0; s < SLOTS_PER_LEVEL; s++) {
      positions.set(local, s * v * 3);
      const base = s * v;
      const o = s * ni;
      for (let i = 0; i < ni; i++) indices[o + i] = pattern[i] + base;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    this.heights = new BufferAttribute(new Float32Array(SLOTS_PER_LEVEL * v), 1).setUsage(DynamicDrawUsage);
    this.normals = new BufferAttribute(new Int16Array(SLOTS_PER_LEVEL * v * 3), 3, true).setUsage(DynamicDrawUsage);
    geometry.setAttribute('aHeight', this.heights);
    geometry.setAttribute('normal', this.normals);
    this.warp = spec.warp
      ? new BufferAttribute(new Int16Array(SLOTS_PER_LEVEL * v * 2), 2, true).setUsage(DynamicDrawUsage)
      : null;
    if (this.warp) geometry.setAttribute('aWarp', this.warp);
    geometry.setIndex(new BufferAttribute(indices, 1));
    geometry.setDrawRange(0, 0);
    // Positions are placed in the shader; this sphere only feeds draw sorting.
    geometry.boundingSphere = new Sphere(new Vector3(), 1e6);
    // Uploads are confirmed when three pushes the buffer to the GPU.
    // (A first upload sends whole buffers and leaves queued ranges behind:
    // drop them so they aren't sent again.)
    this.heights.onUpload(() => {
      this.heights.clearUpdateRanges();
      this.uploaded = this.written;
      this.full = false;
    });
    this.normals.onUpload(() => this.normals.clearUpdateRanges());
    this.warp?.onUpload(() => this.warp?.clearUpdateRanges());

    for (let s = 0; s < SLOTS_PER_LEVEL; s++) this.slots.push(new Vector4(0, 0, 0, 0));
    for (let k = 0; k < LEVEL_COUNT; k++) this.holes.push(new Vector4(EMPTY_RECT, EMPTY_RECT, -EMPTY_RECT, -EMPTY_RECT));
    const material = tileMaterial(spec.fine, spec.warp, this.slots, this.holes, v, spec.tile / spec.quads);
    this.mesh = new Mesh(geometry, material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = spec.fine;
  }

  private touch(attribute: BufferAttribute, start: number, count: number): void {
    if (!this.full) attribute.addUpdateRange(start, count);
    attribute.needsUpdate = true;
  }

  private dirty(slot: number): number {
    const v = this.vertsPerSlot;
    // Many queued ranges (e.g. while the root is hidden) go up as one
    // full upload instead.
    if (!this.full && this.heights.updateRanges.length >= 8) {
      this.full = true;
      this.heights.clearUpdateRanges();
      this.normals.clearUpdateRanges();
      this.warp?.clearUpdateRanges();
    }
    this.touch(this.heights, slot * v, v);
    this.touch(this.normals, slot * v * 3, v * 3);
    if (this.warp) this.touch(this.warp, slot * v * 2, v * 2);
    return ++this.written;
  }

  write(slot: number, originX: number, originZ: number, payload: ArrayBuffer): number {
    const v = this.vertsPerSlot;
    const p = payloadViews(this.spec, payload);
    (this.heights.array as Float32Array).set(p.heights, slot * v);
    (this.normals.array as Int16Array).set(p.normals, slot * v * 3);
    if (this.warp && p.offsets) (this.warp.array as Int16Array).set(p.offsets, slot * v * 2);
    this.slots[slot].set(originX, originZ, 0, 0);
    return this.dirty(slot);
  }

  copy(from: number, to: number): number {
    const v = this.vertsPerSlot;
    (this.heights.array as Float32Array).copyWithin(to * v, from * v, (from + 1) * v);
    (this.normals.array as Int16Array).copyWithin(to * v * 3, from * v * 3, (from + 1) * v * 3);
    if (this.warp) (this.warp.array as Int16Array).copyWithin(to * v * 2, from * v * 2, (from + 1) * v * 2);
    this.slots[to].set(this.slots[from].x, this.slots[from].y, 0, 0);
    return this.dirty(to);
  }

  uploadedVersion(): number {
    return this.uploaded;
  }

  setShown(slot: number, shown: boolean): void {
    this.slots[slot].z = shown ? 1 : 0;
  }

  setDrawSlots(count: number): void {
    // The mesh stays visible even at zero count: three uploads buffers of
    // visible meshes only, and tiles must reach the GPU before they show.
    this.mesh.geometry.setDrawRange(0, count * this.indicesPerSlot);
  }

  setHoles(rects: Float64Array): void {
    for (let k = 0; k < LEVEL_COUNT; k++) {
      const o = k * 4;
      if (Number.isNaN(rects[o])) this.holes[k].set(EMPTY_RECT, EMPTY_RECT, -EMPTY_RECT, -EMPTY_RECT);
      else {
        this.holes[k].set(
          rects[o] + HOLE_TOLERANCE,
          rects[o + 1] + HOLE_TOLERANCE,
          rects[o + 2] - HOLE_TOLERANCE,
          rects[o + 3] - HOLE_TOLERANCE,
        );
      }
    }
  }
}

// ------------------------------------------------------------ far meshes --

/** Shown near-block rectangles, as the far mesh sees them. */
const farRects: Vector4[] = [];
for (let k = 0; k < LEVEL_COUNT; k++) farRects.push(new Vector4(EMPTY_RECT, EMPTY_RECT, -EMPTY_RECT, -EMPTY_RECT));
const farSink = { value: new Vector3(FAR_SINK.margin, FAR_SINK.ramp, FAR_SINK.depth) };

/** Mirror the scheduler's shown rectangles into the far-mesh sink. */
export function setFarRects(rects: Float64Array): void {
  for (let k = 0; k < LEVEL_COUNT; k++) {
    const o = k * 4;
    if (Number.isNaN(rects[o])) farRects[k].set(EMPTY_RECT, EMPTY_RECT, -EMPTY_RECT, -EMPTY_RECT);
    else farRects[k].set(rects[o], rects[o + 1], rects[o + 2], rects[o + 3]);
  }
}

function meshFromData(data: MeshData, name: string, material: MeshStandardMaterial): Mesh {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(data.normals, 3, true));
  geometry.setIndex(new BufferAttribute(data.indices, 1));
  geometry.computeBoundingSphere();
  const mesh = new Mesh(geometry, material);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.renderOrder = FAR_LAYER_ORDER;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

/**
 * The whole mountain out to FAR_OUTER_R in the far depth layer. Wherever the
 * near tiles are up it sinks out of sight (they always draw over the far
 * layer), keeping a margin unsunk at their edge so no gap opens there.
 */
export function buildFarMeshObject(data: MeshData): Mesh {
  const material = createLandMaterial({ farLayer: true, rockScale: 24, snowScale: 14, snowCling: 0.02 });
  chain(material, 'expfar', (shader) => {
    shader.uniforms.uFarRects = { value: farRects };
    shader.uniforms.uFarSink = farSink;
    shader.vertexShader = replaceOnce(
      shader.vertexShader,
      '#include <common>',
      `#include <common>
      uniform vec4 uFarRects[${LEVEL_COUNT}];
      uniform vec3 uFarSink;`,
    );
    shader.vertexShader = replaceOnce(
      shader.vertexShader,
      '#include <begin_vertex>',
      `#include <begin_vertex>
      {
        // Depth inside the near terrain (max over the shown blocks).
        float farIn = -1.0e9;
        for (int k = 0; k < ${LEVEL_COUNT}; k++) {
          vec4 R = uFarRects[k];
          farIn = max(farIn, min(min(transformed.x - R.x, R.z - transformed.x), min(transformed.z - R.y, R.w - transformed.z)));
        }
        transformed.y -= uFarSink.z * smoothstep(uFarSink.x, uFarSink.x + uFarSink.y, farIn);
      }`,
    );
  });
  addMist(material);
  return meshFromData(data, 'ExpeditionFarMesh', material);
}

/** The surrounding ranges, far depth layer. */
export function buildBackdropObject(data: MeshData): Mesh {
  const material = createLandMaterial({ farLayer: true, rockScale: 60, snowScale: 40, snowCling: 0.26 });
  addMist(material);
  return meshFromData(data, 'ExpeditionBackdrop', material);
}
