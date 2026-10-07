/**
 * The expedition map: a north-up topographic sheet of the whole mountain,
 * drawn once into an offscreen canvas (hill-shaded relief, 50 m contours
 * with 250 m index lines, the sea-of-clouds line, river, route, climbs,
 * fixed rope, camps, section names, north arrow and scale bar). Each draw
 * then only blits that sheet and adds "you".
 *
 * The height grid is sampled from `expeditionHeight` a few rows at a time
 * (`warmTopo`, called by the director every frame) so opening the map never
 * hitches; `drawExpeditionMap` finishes any remaining rows if needed.
 */

import { route, type SectionId, SECTION_ORDER, SUMMIT_ELEV } from '../exp-route.js';
import {
  CAMPS,
  campCentre,
  CREVASSE_HALF_LENGTH,
  CREVASSE_S,
  EXP_CLOUD_DECK_Y,
  ICE_WALL,
  outwardSide,
  RIVER_S,
  ROCK_BAND,
  ROPE_END_S,
  ROPE_START_S,
  routeFrame,
  SECTION_NAMES,
  SUMMIT_S,
  type BandCrossing,
} from '../exp-layout.js';
import { expeditionHeight } from '../exp-terrain.js';
import { formatAltitude } from './route-math.js';

const GRID = 129;
const MARGIN = 260;
const CONTOUR_STEP = 50;
const INDEX_STEP = 250;

interface Sheet {
  cx: number;
  cz: number;
  /** Half extent in metres (square). */
  half: number;
}

let sheet: Sheet | null = null;
let heights: Float32Array | null = null;
let rowsDone = 0;
let base: HTMLCanvasElement | null = null;
let baseSize = 0;

function ensureSheet(): Sheet {
  if (sheet) return sheet;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < route.count; i++) {
    minX = Math.min(minX, route.x[i]);
    maxX = Math.max(maxX, route.x[i]);
    minZ = Math.min(minZ, route.z[i]);
    maxZ = Math.max(maxZ, route.z[i]);
  }
  for (const camp of CAMPS) {
    const c = campCentre(camp);
    minX = Math.min(minX, c.x);
    maxX = Math.max(maxX, c.x);
    minZ = Math.min(minZ, c.z);
    maxZ = Math.max(maxZ, c.z);
  }
  sheet = {
    cx: (minX + maxX) / 2,
    cz: (minZ + maxZ) / 2,
    half: Math.max(maxX - minX, maxZ - minZ) / 2 + MARGIN,
  };
  return sheet;
}

/** World position of grid sample (i, j). */
function gridX(i: number): number {
  const s = ensureSheet();
  return s.cx - s.half + ((i + 0.5) / GRID) * 2 * s.half;
}

function gridZ(j: number): number {
  const s = ensureSheet();
  return s.cz - s.half + ((j + 0.5) / GRID) * 2 * s.half;
}

/** Sample up to `rows` more rows of the height grid. Returns true once complete. */
export function warmTopo(rows: number): boolean {
  if (!heights) heights = new Float32Array(GRID * GRID);
  const end = Math.min(GRID, rowsDone + rows);
  for (let j = rowsDone; j < end; j++) {
    const z = gridZ(j);
    for (let i = 0; i < GRID; i++) heights[j * GRID + i] = expeditionHeight(gridX(i), z);
  }
  rowsDone = end;
  return rowsDone >= GRID;
}

// ------------------------------------------------------------- colours ----

const TINT: Array<[number, number, number, number]> = [
  [0, 196, 207, 181],
  [160, 172, 190, 156],
  [420, 214, 220, 208],
  [650, 236, 239, 240],
  [900, 222, 233, 244],
  [1300, 248, 249, 251],
];

function tint(h: number, out: number[]): void {
  let k = 1;
  while (k < TINT.length - 1 && h > TINT[k][0]) k++;
  const a = TINT[k - 1];
  const b = TINT[k];
  const t = Math.max(0, Math.min(1, (h - a[0]) / (b[0] - a[0])));
  out[0] = a[1] + (b[1] - a[1]) * t;
  out[1] = a[2] + (b[2] - a[2]) * t;
  out[2] = a[3] + (b[3] - a[3]) * t;
}

// --------------------------------------------------------------- sheet ----

function buildBase(size: number): HTMLCanvasElement {
  while (!warmTopo(GRID)) {
    /* finish sampling */
  }
  const h = heights!;
  const s = ensureSheet();
  const scale = size / (2 * s.half);
  const px = (x: number) => (x - (s.cx - s.half)) * scale;
  const pz = (z: number) => (z - (s.cz - s.half)) * scale;
  const cell = (2 * s.half) / GRID;

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  // Relief: hypsometric tint with a north-west hillshade, one pixel per sample.
  const relief = document.createElement('canvas');
  relief.width = relief.height = GRID;
  const rctx = relief.getContext('2d')!;
  const image = rctx.createImageData(GRID, GRID);
  const rgb = [0, 0, 0];
  const at = (i: number, j: number) =>
    h[Math.max(0, Math.min(GRID - 1, j)) * GRID + Math.max(0, Math.min(GRID - 1, i))];
  // Light from the north-west, 40 degrees up.
  const lx = -0.54;
  const lz = -0.54;
  const ly = 0.64;
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const gx = (at(i + 1, j) - at(i - 1, j)) / (2 * cell);
      const gz = (at(i, j + 1) - at(i, j - 1)) / (2 * cell);
      const inv = 1 / Math.hypot(gx, 1, gz);
      const lit = Math.max(0, (-gx * lx + ly - gz * lz) * inv);
      const shade = 0.94 + 0.55 * (lit - ly);
      tint(at(i, j), rgb);
      const o = (j * GRID + i) * 4;
      image.data[o] = Math.min(255, rgb[0] * shade);
      image.data[o + 1] = Math.min(255, rgb[1] * shade);
      image.data[o + 2] = Math.min(255, rgb[2] * shade);
      image.data[o + 3] = 255;
    }
  }
  rctx.putImageData(image, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.globalAlpha = 0.9;
  ctx.drawImage(relief, 0, 0, size, size);
  ctx.globalAlpha = 1;

  // Contours (marching squares on the sample grid).
  const step = size / GRID;
  const cpx = (i: number) => (i + 0.5) * step;
  const contour = (level: number) => {
    for (let j = 0; j < GRID - 1; j++) {
      for (let i = 0; i < GRID - 1; i++) {
        const a = h[j * GRID + i];
        const b = h[j * GRID + i + 1];
        const c = h[(j + 1) * GRID + i + 1];
        const d = h[(j + 1) * GRID + i];
        const code = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (c > level ? 2 : 0) | (d > level ? 1 : 0);
        if (code === 0 || code === 15) continue;
        const x0 = cpx(i);
        const y0 = cpx(j);
        // Edge crossings: top (a-b), right (b-c), bottom (d-c), left (a-d).
        const top = () => [x0 + ((level - a) / (b - a)) * step, y0] as const;
        const right = () => [x0 + step, y0 + ((level - b) / (c - b)) * step] as const;
        const bottom = () => [x0 + ((level - d) / (c - d)) * step, y0 + step] as const;
        const left = () => [x0, y0 + ((level - a) / (d - a)) * step] as const;
        const seg = (p: readonly [number, number], q: readonly [number, number]) => {
          ctx.moveTo(p[0], p[1]);
          ctx.lineTo(q[0], q[1]);
        };
        switch (code) {
          case 1:
          case 14:
            seg(left(), bottom());
            break;
          case 2:
          case 13:
            seg(bottom(), right());
            break;
          case 3:
          case 12:
            seg(left(), right());
            break;
          case 4:
          case 11:
            seg(top(), right());
            break;
          case 6:
          case 9:
            seg(top(), bottom());
            break;
          case 7:
          case 8:
            seg(left(), top());
            break;
          case 5:
            seg(left(), top());
            seg(bottom(), right());
            break;
          case 10:
            seg(top(), right());
            seg(left(), bottom());
            break;
          default:
            break;
        }
      }
    }
  };
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(128, 92, 58, 0.42)';
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  for (let level = CONTOUR_STEP; level < SUMMIT_ELEV + 450; level += CONTOUR_STEP) {
    if (level % INDEX_STEP !== 0 && level !== EXP_CLOUD_DECK_Y) contour(level);
  }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(112, 74, 42, 0.75)';
  ctx.lineWidth = 1.7;
  ctx.beginPath();
  for (let level = INDEX_STEP; level < SUMMIT_ELEV + 450; level += INDEX_STEP) contour(level);
  ctx.stroke();
  // The sea of clouds: a dashed blue line at the cloud deck.
  ctx.strokeStyle = 'rgba(70, 120, 190, 0.85)';
  ctx.lineWidth = 1.6;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  contour(EXP_CLOUD_DECK_Y);
  ctx.stroke();
  ctx.setLineDash([]);

  // River across the valley, and the crevasse slot.
  const river = routeFrame(RIVER_S);
  ctx.strokeStyle = 'rgba(60, 120, 200, 0.9)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(px(river.x - river.nx * 900), pz(river.z - river.nz * 900));
  ctx.lineTo(px(river.x + river.nx * 900), pz(river.z + river.nz * 900));
  ctx.stroke();
  const crev = routeFrame(CREVASSE_S);
  ctx.strokeStyle = 'rgba(40, 90, 170, 0.9)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(px(crev.x - crev.nx * CREVASSE_HALF_LENGTH), pz(crev.z - crev.nz * CREVASSE_HALF_LENGTH));
  ctx.lineTo(px(crev.x + crev.nx * CREVASSE_HALF_LENGTH), pz(crev.z + crev.nz * CREVASSE_HALF_LENGTH));
  ctx.stroke();

  // The route: a white casing under a red dashed line.
  const traceRoute = (from: number, to: number) => {
    ctx.beginPath();
    const i0 = Math.max(0, Math.floor(from / 4));
    const i1 = Math.min(route.count - 1, Math.ceil(to / 4));
    for (let i = i0; i <= i1; i += 2) {
      if (i === i0) ctx.moveTo(px(route.x[i]), pz(route.z[i]));
      else ctx.lineTo(px(route.x[i]), pz(route.z[i]));
    }
    ctx.stroke();
  };
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.lineWidth = 6;
  traceRoute(0, route.length);
  ctx.strokeStyle = '#b8402c';
  ctx.lineWidth = 3;
  ctx.setLineDash([9, 6]);
  traceRoute(0, route.length);
  ctx.setLineDash([]);
  // Fixed rope: solid black over the dashes.
  ctx.strokeStyle = '#1f1d1b';
  ctx.lineWidth = 3.4;
  traceRoute(ROPE_START_S, ROPE_END_S);

  // Climbs: a hatched cliff bar across the route at each band.
  const cliff = (band: BandCrossing, label: string) => {
    const tx = -band.nz;
    const tz = band.nx;
    const half = 45;
    ctx.strokeStyle = '#2e2a26';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(px(band.baseX - tx * half), pz(band.baseZ - tz * half));
    ctx.lineTo(px(band.baseX + tx * half), pz(band.baseZ + tz * half));
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let k = -half; k <= half; k += 9) {
      const bx = band.baseX + tx * k;
      const bz = band.baseZ + tz * k;
      ctx.moveTo(px(bx), pz(bz));
      ctx.lineTo(px(bx - band.nx * 14), pz(bz - band.nz * 14));
    }
    ctx.stroke();
    ctx.font = '600 13px Georgia, serif';
    ctx.fillStyle = '#2e2a26';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, px(band.baseX + tx * half) + 6, pz(band.baseZ + tz * half));
  };
  cliff(ICE_WALL, 'Ice Wall');
  cliff(ROCK_BAND, 'Rock Band');

  // Section names, set off the route on the downhill side.
  ctx.font = 'italic 15px Georgia, serif';
  ctx.fillStyle = 'rgba(70, 50, 34, 0.9)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const skip: SectionId[] = ['icewall', 'rockband', 'summit'];
  for (let k = 0; k < SECTION_ORDER.length; k++) {
    const id = SECTION_ORDER[k];
    if (skip.includes(id)) continue;
    const a = route.sectionStart[id];
    const b = k + 1 < SECTION_ORDER.length ? route.sectionStart[SECTION_ORDER[k + 1]] : route.length;
    const mid = (a + b) / 2;
    const f = routeFrame(mid);
    const side = outwardSide(mid);
    const off = 120;
    ctx.fillText(SECTION_NAMES[id], px(f.x + f.nx * side * off), pz(f.z + f.nz * side * off));
  }

  // Camps: little tents with names.
  CAMPS.forEach((camp, i) => {
    const c = campCentre(camp);
    const x = px(c.x);
    const y = pz(c.z);
    const r = i === 0 ? 9 : 7;
    ctx.fillStyle = i === 0 ? '#c4552d' : '#6b4a2f';
    ctx.strokeStyle = '#fff8ec';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y + r * 0.75);
    ctx.lineTo(x - r, y + r * 0.75);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.font = i === 0 ? '700 15px Georgia, serif' : '600 13px Georgia, serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const name = camp.name.replace(/^Camp (\d) · /u, 'C$1 ');
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255, 250, 240, 0.8)';
    ctx.strokeText(name, x + r + 4, y);
    ctx.fillStyle = '#3b2a1e';
    ctx.fillText(name, x + r + 4, y);
  });

  // Summit.
  {
    const f = routeFrame(SUMMIT_S);
    const x = px(f.x);
    const y = pz(f.z);
    ctx.fillStyle = '#1f1d1b';
    ctx.beginPath();
    ctx.moveTo(x, y - 9);
    ctx.lineTo(x + 8, y + 6);
    ctx.lineTo(x - 8, y + 6);
    ctx.closePath();
    ctx.fill();
    ctx.font = '700 15px Georgia, serif';
    ctx.textAlign = 'left';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255, 250, 240, 0.8)';
    const label = `Summit ${formatAltitude(SUMMIT_ELEV)}`;
    ctx.strokeText(label, x + 11, y - 2);
    ctx.fillStyle = '#1f1d1b';
    ctx.fillText(label, x + 11, y - 2);
  }

  // Title cartouche, north arrow, scale bar, cloud legend.
  ctx.fillStyle = 'rgba(250, 244, 230, 0.88)';
  ctx.fillRect(16, 16, 176, 46);
  ctx.strokeStyle = '#6b4a2f';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(16, 16, 176, 46);
  ctx.fillStyle = '#3b2a1e';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '700 17px Georgia, serif';
  ctx.fillText('THE EXPEDITION', 26, 37);
  ctx.font = 'italic 12px Georgia, serif';
  ctx.fillText('Contours 50 m · route in red', 26, 54);

  const nx = size - 40;
  const ny = 46;
  ctx.fillStyle = '#3b2a1e';
  ctx.beginPath();
  ctx.moveTo(nx, ny - 22);
  ctx.lineTo(nx + 9, ny + 8);
  ctx.lineTo(nx, ny + 2);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#3b2a1e';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(nx, ny - 22);
  ctx.lineTo(nx - 9, ny + 8);
  ctx.lineTo(nx, ny + 2);
  ctx.closePath();
  ctx.stroke();
  ctx.font = '700 15px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.fillText('N', nx, ny + 24);

  const km = 1000 * scale;
  const sx = 22;
  const sy = size - 26;
  ctx.fillStyle = 'rgba(250, 244, 230, 0.85)';
  ctx.fillRect(sx - 8, sy - 22, km + 40, 34);
  ctx.fillStyle = '#3b2a1e';
  ctx.fillRect(sx, sy, km / 2, 5);
  ctx.strokeStyle = '#3b2a1e';
  ctx.lineWidth = 1.2;
  ctx.strokeRect(sx, sy, km, 5);
  ctx.font = '600 12px Georgia, serif';
  ctx.textAlign = 'left';
  ctx.fillText('0', sx - 3, sy - 6);
  ctx.fillText('1 km', sx + km - 12, sy - 6);
  ctx.fillStyle = 'rgba(70, 120, 190, 0.95)';
  ctx.font = 'italic 12px Georgia, serif';
  ctx.textAlign = 'right';
  ctx.fillText(`- - sea of clouds ${EXP_CLOUD_DECK_Y} m`, size - 18, size - 20);

  return canvas;
}

/** Make sure the sheet exists (call while the screen is faded out). */
export function prepareTopo(size = 512): void {
  if (!base || baseSize !== size) {
    base = buildBase(size);
    baseSize = size;
  }
}

/** Level.drawMap for the expedition. */
export function drawExpeditionMap(
  ctx: CanvasRenderingContext2D,
  size: number,
  you: { x: number; z: number },
  yaw: number,
): void {
  prepareTopo(size);
  ctx.drawImage(base!, 0, 0, size, size);
  const s = ensureSheet();
  const scale = size / (2 * s.half);
  const inset = 18;
  const x = Math.max(inset, Math.min(size - inset, (you.x - (s.cx - s.half)) * scale));
  const y = Math.max(inset, Math.min(size - inset, (you.z - (s.cz - s.half)) * scale));
  // Heading wedge, then the dot.
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  ctx.fillStyle = 'rgba(29, 95, 209, 0.35)';
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + (fx * 30 - fz * 12), y + (fz * 30 + fx * 12));
  ctx.lineTo(x + (fx * 30 + fz * 12), y + (fz * 30 - fx * 12));
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(x, y, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1d5fd1';
  ctx.beginPath();
  ctx.arc(x, y, 7, 0, Math.PI * 2);
  ctx.fill();
}
