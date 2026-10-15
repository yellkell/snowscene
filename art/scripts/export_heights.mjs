/**
 * Sample the game's own ground functions into float32 grids for Blender, so the
 * visible ground is built from exactly what the player walks on.
 *
 *   node art/scripts/export_heights.mjs
 *
 * Writes art/work/heights_<name>.bin (float32, row-major, z rows of x samples)
 * and art/work/heights_<name>.json ({ x0, z0, step, nx, nz, ...constants }).
 * Coordinates are game space (Y up, -Z north); Blender maps (x, z) -> (x, -y).
 */
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORK = join(ROOT, 'art', 'work');
mkdirSync(WORK, { recursive: true });

async function load(entry) {
  const out = join(WORK, `_${entry.replace(/[\/]/g, '_')}.mjs`);
  await build({
    entryPoints: [join(ROOT, entry)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: out,
    alias: { '@iwsdk/core': join(ROOT, 'art', 'scripts', 'iwsdk-shim.mjs') },
    logLevel: 'error',
  });
  return import(pathToFileURL(out).href);
}

function grid(name, fn, x0, z0, step, nx, nz, extra) {
  const data = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) data[j * nx + i] = fn(x0 + i * step, z0 + j * step);
  writeFileSync(join(WORK, `heights_${name}.bin`), Buffer.from(data.buffer));
  writeFileSync(join(WORK, `heights_${name}.json`), JSON.stringify({ x0, z0, step, nx, nz, ...extra }, null, 1));
  console.log(name, nx, 'x', nz, 'step', step);
}

const sv = await load('src/game/survivors/survivors-level.ts');
// The arena out past the forest ring, every 0.5 m (arena-relative coordinates).
{
  const R = 420;
  const step = 0.5;
  const n = Math.round((2 * R) / step) + 1;
  grid('survivors', (x, z) => sv.duneHeight(sv.ARENA_X + x, sv.ARENA_Z + z), -R, -R, step, n, n, {
    arena: [sv.ARENA_X, sv.ARENA_Z],
    radius: sv.ARENA_RADIUS,
    hill: sv.HILL,
    hillTree: sv.HILL_TREE,
  });
}

const tr = await load('src/game/terrain.ts');
// The tutorial mountain: what you walk on, every 0.5 m. Mirrors tutorial-level.ts groundAt: the
// terrain, raised to the ice inside the frozen lake.
{
  const groundAt = (x, z) => {
    const lx = (x - tr.LAKE_CENTER_X) / (tr.LAKE_RADIUS_X * 0.88);
    const lz = (z - tr.LAKE_CENTER_Z) / (tr.LAKE_RADIUS_Z * 0.88);
    const h = tr.terrainHeight(x, z);
    return lx * lx + lz * lz < 1 ? Math.max(h, tr.LAKE_Y) : h;
  };
  const step = 0.5;
  const x0 = -400, x1 = 400, z0 = -420, z1 = 400;
  const nx = Math.round((x1 - x0) / step) + 1;
  const nz = Math.round((z1 - z0) / step) + 1;
  const c = {};
  for (const k of Object.keys(tr)) if (typeof tr[k] === 'number') c[k] = tr[k];
  grid('tutorial', groundAt, x0, z0, step, nx, nz, { constants: c });
}

// The great ranges round the tutorial (far-ranges.ts farHeight), on a polar grid: log-spaced rings
// from just inside the playable terrain's edge out to 25 km, every quarter degree.
{
  const fr = await load('src/game/far-ranges.ts');
  const tr2 = await load('src/game/terrain.ts');
  const NA = 1440;
  const radii = [];
  for (let r = 360; r < 25000; r *= 1.0075) radii.push(r);
  const data = new Float32Array(radii.length * NA);
  for (let j = 0; j < radii.length; j++) {
    for (let i = 0; i < NA; i++) {
      const a = (i / NA) * Math.PI * 2;
      const x = tr2.TUTORIAL_CENTER_X + Math.cos(a) * radii[j];
      const z = tr2.TUTORIAL_CENTER_Z + Math.sin(a) * radii[j];
      data[j * NA + i] = fr.farHeight(x, z);
    }
  }
  writeFileSync(join(WORK, 'heights_ranges.bin'), Buffer.from(data.buffer));
  writeFileSync(join(WORK, 'heights_ranges.json'), JSON.stringify({ radii, na: NA, center: [tr2.TUTORIAL_CENTER_X, tr2.TUTORIAL_CENTER_Z], cloudY: tr2.CLOUD_SEA_Y }, null, 0));
  console.log('ranges', radii.length, 'rings x', NA);
}
