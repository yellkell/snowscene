/**
 * The build passes that turn the pure layouts into chunked meshes. Each
 * pass is a generator so the world system can spread the work (terrain
 * sampling, geometry merging) over frames, nearest content first.
 */

import { Color, type Group, Matrix4, Quaternion, Vector3, type BufferGeometry } from '@iwsdk/core';
import { mulberry32 } from '../../terrain.js';
import { CAMPS, CREVASSE_S, ICE_WALL, RIVER_S, ROCK_BAND, ROPE_START_S, SERAC, SUMMIT_S } from '../exp-layout.js';
import { tiltedYaw } from './batch.js';
import { type Chunk, type ChunkGrid, type Layer } from './chunks.js';
import {
  addBridge,
  addCrevasse,
  addFace,
  addLedgeWall,
  addSeam,
  buildCollapseSerac,
  buildHolds,
  type HoldMeshes,
  riverMeshes,
} from './feature-meshes.js';
import { campLayout, type CampLayout, summitLayout } from './layout-camps.js';
import {
  BRIDGE_FRAME,
  CREVASSE_FRAME,
  faceGrid,
  ICE_FACE,
  ledgeWallGrid,
  riverRows,
  ROCK_FACE,
  rockHolds,
} from './layout-features.js';
import {
  forestTrees,
  glacierSeams,
  moraineBoulders,
  ridgeRocks,
  seracField,
  seracTower,
  valleyBoulders,
} from './layout-nature.js';
import { hairpinCairns, sectionSigns, type SignSpec, wandLayout } from './layout-route.js';
import { type Gen, type Item, SpacingGrid } from './layout-util.js';
import { iceFacetMaterial, rockMaterial, treeMaterial } from './materials.js';
import { boulderGeometry, seracColor, seracGeometry, spruceGeometry } from './nature-meshes.js';
import { bulbGeometry, buildPartygoers } from './party.js';
import {
  addBarrel,
  addBench,
  addCairn,
  addChorten,
  addCrate,
  addDecal,
  addFestoon,
  addFlagLine,
  addMarker,
  addMast,
  addMessTent,
  addPole,
  addSign,
  addStake,
  addTent,
  addWand,
  addWindsock,
} from './props.js';
import type { SignAtlas } from './sign-atlas.js';

export interface BuildHooks {
  /** A camp fire to create (Bonfire entities are owned by the system). */
  fire(x: number, y: number, z: number, scale: number, base: boolean): void;
  /** The rock band's holds were built (mesh goes into `chunk`). */
  holds(h: HoldMeshes, chunk: Chunk): void;
  /** The collapsing serac tower was built. */
  serac(group: Group): void;
  /** A chunk finished: give it an entity under the expedition root. */
  chunkDone(chunk: Chunk): void;
}

export interface Pass {
  name: string;
  /** Route arc length the pass is centred on (build priority). */
  s: number;
  run: () => Gen<void>;
}

// Shared instanced geometries (built once).
let shared: { treeHi: BufferGeometry; treeLo: BufferGeometry; rockHi: BufferGeometry; rockLo: BufferGeometry; bulb: BufferGeometry } | null = null;
function geometries() {
  shared ??= {
    treeHi: spruceGeometry('hi'),
    treeLo: spruceGeometry('lo'),
    rockHi: boulderGeometry(1, 3),
    rockLo: boulderGeometry(0, 3),
    bulb: bulbGeometry(),
  };
  return shared;
}

const q = new Quaternion();
const tint = new Color();

export function makePasses(grid: ChunkGrid, atlas: SignAtlas, hooks: BuildHooks): Pass[] {
  const chunkAt = (pass: string, layer: Layer, x: number, z: number) => grid.at(pass, layer, x, z);

  function* finish(pass: string): Gen<void> {
    for (const chunk of grid.pending(pass)) {
      yield* chunk.finishSteps();
      hooks.chunkDone(chunk);
      yield;
    }
  }

  function addItem(pass: string, it: Item): void {
    const g = geometries();
    switch (it.kind) {
      case 'tree': {
        const c = chunkAt(pass, 'large', it.x, it.z);
        const rand = mulberry32(it.seed);
        const girth = 0.86 + rand() * 0.14;
        const shade = 0.82 + rand() * 0.26;
        tint.setRGB(shade, shade * (0.96 + rand() * 0.08), shade * (0.95 + rand() * 0.06));
        c.inst('tree', g.treeHi, g.treeLo, treeMaterial()).push(it.x, it.y, it.z, tiltedYaw(it.yaw, 0, 0, q), it.size * girth, it.size, it.size * girth, tint);
        c.extend(it.x, it.y + it.size / 2, it.z, it.size * 0.6);
        return;
      }
      case 'boulder': {
        const c = chunkAt(pass, 'large', it.x, it.z);
        const rand = mulberry32(it.seed);
        const sx = 0.8 + rand() * 0.15;
        const sy = 0.7 + rand() * 0.35;
        const sz = 0.8 + rand() * 0.15;
        tint.setRGB(1, 1, 1);
        c.inst('boulder', g.rockHi, g.rockLo, rockMaterial(), true, false).push(
          it.x,
          it.y + 0.4 * it.size * sy,
          it.z,
          tiltedYaw(it.yaw, (rand() - 0.5) * 0.5, (rand() - 0.5) * 0.5, q),
          it.size * sx,
          it.size * sy,
          it.size * sz,
        );
        c.extend(it.x, it.y, it.z, it.size * 1.3);
        return;
      }
      case 'serac': {
        const c = chunkAt(pass, 'large', it.x, it.z);
        const geo = seracGeometry(it.seed * 0.37, it.size * 0.55, it.size, it.size * 0.5);
        c.batch('iceFacet').add(geo, new Matrix4().makeRotationY(it.yaw).setPosition(it.x, it.y, it.z), seracColor(it.y, it.size));
        c.extend(it.x, it.y + it.size / 2, it.z, it.size);
        return;
      }
      case 'fire':
        return;
      default:
        break;
    }
    const c = chunkAt(pass, 'detail', it.x, it.z);
    switch (it.kind) {
      case 'tent':
        addTent(c, it);
        break;
      case 'mess-tent':
        addMessTent(c, it);
        break;
      case 'crate':
        addCrate(c, it);
        break;
      case 'barrel':
        addBarrel(c, it);
        break;
      case 'cairn':
        addCairn(c, it);
        break;
      case 'wand':
        addWand(c, it);
        break;
      case 'marker':
        addMarker(c, it);
        break;
      case 'pole':
        addPole(c, it);
        break;
      case 'mast':
        addMast(c, it);
        break;
      case 'stake':
        addStake(c, it);
        break;
      case 'chorten':
        addChorten(c, it);
        break;
      case 'bench':
        addBench(c, it);
        break;
      default:
        break;
    }
  }

  /** Add items, yielding every few so no frame does too much. */
  function* addItems(pass: string, items: Item[], per = 24): Gen<void> {
    let n = 0;
    for (const it of items) {
      addItem(pass, it);
      if (++n % per === 0) yield;
    }
  }

  const addSignTo = (pass: string, s: SignSpec) => addSign(chunkAt(pass, 'detail', s.x, s.z), s, atlas);

  function* buildCamp(pass: string, layout: CampLayout): Gen<void> {
    yield* addItems(pass, layout.items, 8);
    for (const line of layout.flagLines) addFlagLine(chunkAt(pass, 'detail', (line.a.x + line.b.x) / 2, (line.a.z + line.b.z) / 2), line);
    yield;
    for (const line of layout.festoon) addFestoon(chunkAt(pass, 'detail', line.a.x, line.a.z), line, geometries().bulb);
    yield;
    for (const d of layout.decals) {
      addDecal(chunkAt(pass, 'detail', d.x, d.z), d);
      yield;
    }
    for (const w of layout.windsocks) addWindsock(chunkAt(pass, 'detail', w.x, w.z), w);
    for (const s of layout.signs) addSignTo(pass, s);
    yield;
    if (layout.dancers.length) {
      const c = chunkAt(pass, 'detail', layout.centre.x, layout.centre.z);
      const origin = new Vector3(Math.round(layout.centre.x), Math.round(layout.centre.y), Math.round(layout.centre.z));
      const party = yield* buildPartygoers(layout.dancers, origin);
      if (party) {
        c.extras.push(party);
        c.extend(layout.centre.x, layout.centre.y, layout.centre.z, 36);
      }
    }
    hooks.fire(layout.fire.x, layout.fire.y, layout.fire.z, layout.fire.scale, layout.index === 0);
    yield* finish(pass);
  }

  const passes: Pass[] = [
    {
      name: 'route',
      s: -1e9,
      run: function* () {
        yield* addItems('route', yield* wandLayout());
        yield* addItems('route', yield* hairpinCairns(), 4);
        for (const s of yield* sectionSigns()) addSignTo('route', s);
        yield* finish('route');
      },
    },
  ];
  CAMPS.forEach((camp, i) => {
    passes.push({
      name: `camp${i}`,
      s: camp.s,
      run: function* () {
        yield* buildCamp(`camp${i}`, campLayout(i));
      },
    });
  });
  passes.push(
    {
      name: 'river',
      s: RIVER_S,
      run: function* () {
        addBridge(chunkAt('river', 'large', BRIDGE_FRAME.x, BRIDGE_FRAME.z));
        yield;
        const rows = yield* riverRows();
        const seg = 60;
        for (let a = 0; a < rows.length - 1; a += seg) {
          const b = Math.min(rows.length - 1, a + seg);
          const mid = rows[(a + b) >> 1];
          const meshes = riverMeshes(rows, a, b);
          if (meshes.length) {
            const c = chunkAt('river', 'large', mid.x, mid.z);
            for (const mesh of meshes) c.extras.push(mesh);
            c.extend(mid.x, mid.y, mid.z, (seg * 3) / 2 + 10);
          }
          yield;
        }
        yield* finish('river');
      },
    },
    {
      name: 'lowlands',
      s: 1300,
      run: function* () {
        const spacing = new SpacingGrid(16);
        yield* addItems('valley-rocks', yield* valleyBoulders(spacing), 60);
        yield* finish('valley-rocks');
        yield* addItems('forest', yield* forestTrees(spacing), 120);
        yield* finish('forest');
        yield* addItems('moraine', yield* moraineBoulders(spacing), 60);
        yield* finish('moraine');
      },
    },
    {
      name: 'glacier',
      s: (CREVASSE_S + SERAC.s) / 2,
      run: function* () {
        yield* addCrevasse(chunkAt('glacier', 'large', CREVASSE_FRAME.x, CREVASSE_FRAME.z));
        let n = 0;
        for (const seam of yield* glacierSeams()) {
          addSeam(chunkAt('glacier', 'large', seam.x[0], seam.z[0]), seam);
          if (++n % 8 === 0) yield;
        }
        yield* addItems('glacier', yield* seracField(new SpacingGrid(24)), 6);
        hooks.serac(buildCollapseSerac(seracTower()));
        yield* finish('glacier');
      },
    },
    {
      name: 'icewall',
      s: ICE_WALL.s,
      run: function* () {
        const g = yield* faceGrid(ICE_FACE);
        yield* addFace(chunkAt('icewall', 'large', ICE_WALL.baseX, ICE_WALL.baseZ), g);
        yield* finish('icewall');
      },
    },
    {
      name: 'ridge',
      s: ROPE_START_S + 100,
      run: function* () {
        const ledge = yield* ledgeWallGrid();
        const mid = Math.floor(ledge.cols / 2) * ledge.rows;
        addLedgeWall(chunkAt('ridge', 'large', ledge.x[mid], ledge.z[mid]), ledge);
        yield;
        yield* addItems('ridge', yield* ridgeRocks(new SpacingGrid(16)), 60);
        yield* finish('ridge');
      },
    },
    {
      name: 'rockband',
      s: ROCK_BAND.s,
      run: function* () {
        const g = yield* faceGrid(ROCK_FACE);
        const c = chunkAt('rockband', 'large', ROCK_BAND.baseX, ROCK_BAND.baseZ);
        yield* addFace(c, g);
        const holds = buildHolds(rockHolds(g), new Vector3(ROCK_BAND.nx, 0, ROCK_BAND.nz));
        hooks.holds(holds, c);
        yield* finish('rockband');
      },
    },
    {
      name: 'summit',
      s: SUMMIT_S,
      run: function* () {
        const layout = yield* summitLayout();
        yield* addItems('summit', layout.items, 12);
        for (const line of layout.flagLines) addFlagLine(chunkAt('summit', 'detail', line.a.x, line.a.z), line);
        for (const d of layout.decals) addDecal(chunkAt('summit', 'detail', d.x, d.z), d);
        for (const w of layout.windsocks) addWindsock(chunkAt('summit', 'detail', w.x, w.z), w);
        for (const s of layout.signs) addSignTo('summit', s);
        yield* finish('summit');
      },
    },
  );
  return passes;
}

