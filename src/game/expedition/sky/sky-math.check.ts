/**
 * Node check for the pure sky maths (not part of the app bundle):
 *   npx esbuild src/game/expedition/sky/sky-math.check.ts --bundle --platform=node --outfile=/tmp/sky-check.js && node /tmp/sky-check.js
 * Sun path over the expedition (sunset ~19:30, sunrise ~05:30), moon,
 * aurora window, and smooth lighting along the whole route.
 */
import {
  auroraWindow,
  computePalette,
  createPalette,
  daylightFrom,
  meteorRate,
  moonDirectionAt,
  moonIllumination,
  sunDirectionAt,
} from './sky-math.js';
import { timeOfDayAt, SECTION_NAMES } from '../exp-layout.js';
import { sectionAt } from '../exp-route.js';

let failures = 0;
function check(ok: boolean, msg: string): void {
  if (!ok) {
    failures++;
    console.log('FAIL', msg);
  }
}
const deg = (r: number) => (r * 180) / Math.PI;
const sun = { x: 0, y: 0, z: 0 };
const moon = { x: 0, y: 0, z: 0 };
const alt = (v: { y: number }) => deg(Math.asin(v.y));
const az = (v: { x: number; z: number }) => (deg(Math.atan2(v.x, -v.z)) + 360) % 360; // from north toward east
const clock = (h: number) => {
  const d = ((h % 24) + 24) % 24;
  return `${String(Math.floor(d)).padStart(2, '0')}:${String(Math.round((d % 1) * 60) % 60).padStart(2, '0')}`;
};

// 1. Sun path over the expedition's 6.6 h -> 30.2 h: find sunset / sunrise crossings.
let prev = 0;
const events: string[] = [];
for (let h = 6.6; h <= 30.2001; h += 1 / 120) {
  sunDirectionAt(h, sun);
  const y = sun.y;
  check(Math.abs(Math.hypot(sun.x, sun.y, sun.z) - 1) < 1e-9, `sun not unit at ${h}`);
  if (h > 6.6 && prev > 0 && y <= 0) events.push(`sunset ${clock(h)} (h=${h.toFixed(2)}) az ${az(sun).toFixed(0)}`);
  if (h > 6.6 && prev < 0 && y >= 0) events.push(`sunrise ${clock(h)} (h=${h.toFixed(2)}) az ${az(sun).toFixed(0)}`);
  prev = y;
}
console.log(events.join('\n'));
const sunset = events.find((e) => e.startsWith('sunset'));
const sunrise = events.find((e) => e.startsWith('sunrise'));
check(!!sunset && Math.abs(parseFloat(sunset.split('h=')[1]) - 19.5) < 0.25, 'sunset ~19:30');
check(!!sunrise && Math.abs(parseFloat(sunrise.split('h=')[1]) - 29.5) < 0.25, 'sunrise ~05:30 next day');
sunDirectionAt(12.5, sun);
check(Math.abs(alt(sun) - 60) < 0.5 && Math.abs(az(sun) - 180) < 1, 'noon: 60 deg up due south');
sunDirectionAt(6.6, sun);
check(az(sun) > 45 && az(sun) < 110 && sun.x > 0, 'morning sun in the east');
sunDirectionAt(19.0, sun);
check(sun.x < 0, 'evening sun in the west');
sunDirectionAt(24.5, sun);
check(Math.abs(alt(sun) + 30) < 0.5 && Math.abs(az(sun)) < 1, 'midnight: 30 deg below the north horizon');

// 2. Moon rise / set / phase.
let mprev = 0;
const mevents: string[] = [];
for (let h = 12; h <= 32; h += 1 / 60) {
  moonDirectionAt(h, moon);
  if (h > 12 && mprev < 0 && moon.y >= 0) mevents.push(`moonrise ${clock(h)} az ${az(moon).toFixed(0)}`);
  if (h > 12 && mprev > 0 && moon.y <= 0) mevents.push(`moonset ${clock(h)} az ${az(moon).toFixed(0)}`);
  mprev = moon.y;
}
sunDirectionAt(22.5, sun);
moonDirectionAt(22.5, moon);
console.log(mevents.join('\n'), `| moon at 22:30 alt ${alt(moon).toFixed(1)} az ${az(moon).toFixed(0)} lit ${(moonIllumination(sun, moon) * 100).toFixed(0)}%`);
check(alt(moon) > 25 && Math.abs(az(moon) - 180) < 5, 'moon high in the south at 22:30');

// 3. Aurora window.
const aw = (h: number) => auroraWindow(h);
check(aw(20) === 0 && aw(4) === 0 && aw(12) === 0, 'aurora off outside the window');
check(aw(22.5) === 1 && aw(24.5) === 1 && aw(26) === 1 && aw(1) === 1, 'aurora full 22:00-02:24');
check(aw(21) > 0 && aw(21) < 1 && aw(27) > 0 && aw(27) < 1, 'aurora ramps at 21:00 and 03:00');

// 4. Along the route: time, sun, light, exposure; continuity and swap at zero.
const pal = createPalette();
let last: { e: number; i: number; dx: number; dy: number; dz: number } | null = null;
let maxDE = 0;
let maxDI = 0;
let maxTurn = 0;
let lastSection = '';
console.log('\n     s  section             time   sunAlt  moonAlt day  aurora  meteors/s  light  exposure');
for (let s = 0; s <= 7788; s += 2) {
  const h = timeOfDayAt(s);
  sunDirectionAt(h, sun);
  moonDirectionAt(h, moon);
  computePalette(pal, sun, moon, 0);
  const day = daylightFrom(sun.y);
  for (const v of [pal.exposure, pal.lightIntensity, pal.clearFog.r, pal.clearFog.b, pal.horizon.g, pal.ground.r, day])
    check(Number.isFinite(v), `non-finite palette at s=${s}`);
  if (last) {
    maxDE = Math.max(maxDE, Math.abs(pal.exposure - last.e));
    maxDI = Math.max(maxDI, Math.abs(pal.lightIntensity - last.i));
    const dot = pal.lightDir.x * last.dx + pal.lightDir.y * last.dy + pal.lightDir.z * last.dz;
    // The light may only jump direction (sun <-> moon) while it is (nearly) off.
    if (dot < 0.999) {
      maxTurn = Math.max(maxTurn, Math.min(pal.lightIntensity, last.i));
    }
  }
  last = { e: pal.exposure, i: pal.lightIntensity, dx: pal.lightDir.x, dy: pal.lightDir.y, dz: pal.lightDir.z };
  const sec = SECTION_NAMES[sectionAt(s)];
  if (s % 400 === 0 || sec !== lastSection) {
    const a = auroraWindow(h) * (1 - day);
    console.log(
      `${String(s).padStart(6)}  ${sec.padEnd(19)} ${clock(h)}  ${alt(sun).toFixed(1).padStart(6)}  ${alt(moon).toFixed(1).padStart(6)}  ${day.toFixed(2)}  ${a.toFixed(2)}    ${meteorRate(h, 1 - day).toFixed(3)}     ${pal.lightIntensity.toFixed(2)}   ${pal.exposure.toFixed(2)}`,
    );
  }
  lastSection = sec;
}
console.log(`max step (2 m of route): exposure ${maxDE.toFixed(4)}, light ${maxDI.toFixed(4)}; light on while direction jumped: ${maxTurn.toFixed(4)}`);
check(maxDE < 0.02 && maxDI < 0.1, 'lighting changes smoothly along the route');
check(maxTurn < 0.02, 'sun/moon swap happens with the light off');

// Night ridge is dark with aurora and the summit gets its sunrise.
const ridgeH = timeOfDayAt(6600);
sunDirectionAt(ridgeH, sun);
check(alt(sun) < -18 && auroraWindow(ridgeH) === 1, 'rope traverse under a dark aurora sky');
sunDirectionAt(timeOfDayAt(7770), sun);
check(alt(sun) > 2 && alt(sun) < 10 && sun.x > 0, 'summit marker: the sun just up in the east');

if (failures) throw new Error(`${failures} sky check(s) failed`);
console.log('\nall sky checks passed');
