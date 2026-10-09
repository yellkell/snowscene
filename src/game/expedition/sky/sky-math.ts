/**
 * Pure maths for the expedition sky: where the sun and moon are at a given
 * time of day, how much daylight there is, when the aurora is out, and the
 * whole lighting palette (sun/moon light, exposure, fog, night sky, cloud
 * deck colours, IBL ground) as a function of the sky state.
 *
 * No Three.js here so it can be checked in node. Directions use the scene
 * convention: +X east, +Y up, -Z north (the route climbs north).
 *
 * The palette is calibrated against a JS port of the Preetham sky shader in
 * `src/game/sky.ts` and three's ACES filmic tone mapping, so the fog (which
 * three mixes in *after* tone mapping, i.e. in display space) matches the
 * horizon of the sky you actually see at every hour.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

const DEG = Math.PI / 180;

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function smooth(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

function rgb(r = 0, g = 0, b = 0): RGB {
  return { r, g, b };
}

function setRGB(o: RGB, r: number, g: number, b: number): RGB {
  o.r = r;
  o.g = g;
  o.b = b;
  return o;
}

function copyRGB(o: RGB, a: RGB): RGB {
  o.r = a.r;
  o.g = a.g;
  o.b = a.b;
  return o;
}

function addScaledRGB(o: RGB, a: RGB, s: number): RGB {
  o.r += a.r * s;
  o.g += a.g * s;
  o.b += a.b * s;
  return o;
}

// ---------------------------------------------------------- astronomy -----

/**
 * A mid-latitude mountain in early summer: latitude 45 N, solar
 * declination +15 degrees, solar noon at 12:30 (summer time). Sunrise
 * 05:28 in the ENE, sunset 19:32 in the WNW, the sun 60 degrees up at noon
 * and 30 degrees below the northern horizon at midnight, so the ridge gets
 * a properly dark night for the stars and aurora.
 */
export const SKY_LATITUDE = 45 * DEG;
export const SUN_DECLINATION = 15 * DEG;
export const SOLAR_NOON = 12.5;
/**
 * A waxing gibbous moon (about 150 degrees from the sun, 93% lit) runs
 * 10 h behind the sun, low through the southern sky: rises ~17:20 in the
 * ESE, highest (33 degrees, due south, behind you on the ridge) at 22:30,
 * sets ~03:40 in the WSW before the summit dawn.
 */
export const MOON_LAG_HOURS = 10;
export const MOON_DECLINATION = -12 * DEG;

const SIN_LAT = Math.sin(SKY_LATITUDE);
const COS_LAT = Math.cos(SKY_LATITUDE);

function celestial(hourAngle: number, declination: number, out: Vec3): Vec3 {
  const cd = Math.cos(declination);
  const sd = Math.sin(declination);
  const ch = Math.cos(hourAngle);
  const east = -cd * Math.sin(hourAngle);
  const north = sd * COS_LAT - cd * ch * SIN_LAT;
  const up = sd * SIN_LAT + cd * ch * COS_LAT;
  out.x = east;
  out.y = up;
  out.z = -north;
  return out;
}

/** Unit vector toward the sun at `hours` (may exceed 24). */
export function sunDirectionAt(hours: number, out: Vec3): Vec3 {
  return celestial((hours - SOLAR_NOON) * 15 * DEG, SUN_DECLINATION, out);
}

/** Unit vector toward the moon at `hours`. */
export function moonDirectionAt(hours: number, out: Vec3): Vec3 {
  return celestial((hours - SOLAR_NOON - MOON_LAG_HOURS) * 15 * DEG, MOON_DECLINATION, out);
}

/** Lit fraction of the moon's disc for sun and moon directions. */
export function moonIllumination(sun: Vec3, moon: Vec3): number {
  const c = sun.x * moon.x + sun.y * moon.y + sun.z * moon.z;
  return (1 - c) * 0.5;
}

/** Sidereal rotation of the star field (radians) at `hours`. */
export function siderealAngle(hours: number): number {
  return (hours * 1.0027379 * 15 + 40) * DEG;
}

/** Celestial pole (north, at the latitude's altitude): the stars wheel around it. */
export const CELESTIAL_POLE: Vec3 = { x: 0, y: SIN_LAT, z: -COS_LAT };

/** 0 at night, 1 in full day, smooth through civil twilight. */
export function daylightFrom(sunY: number): number {
  return smooth(Math.sin(-8 * DEG), Math.sin(5 * DEG), sunY);
}

/** Aurora window: strong 21:00-03:00, ramping in from 20:40 and out by 03:40. */
export function auroraWindow(hours: number): number {
  const d = ((hours % 24) + 24) % 24;
  const x = d < 12 ? d + 24 : d;
  return smooth(20.6, 22.0, x) * (1 - smooth(26.4, 27.6, x));
}

/**
 * How many meteors per second to expect: a few through any dark night, a
 * proper shower on the ridge between 22:00 and 02:30.
 */
export function meteorRate(hours: number, darkness: number): number {
  const d = ((hours % 24) + 24) % 24;
  const x = d < 12 ? d + 24 : d;
  const shower = smooth(21.5, 22.5, x) * (1 - smooth(26.0, 27.0, x));
  return darkness * (0.025 + 0.16 * shower);
}

// ------------------------------------------------------- tone mapping -----

/** three.js ACESFilmicToneMapping followed by the sRGB transfer (display value). */
export function displayFromScene(c: RGB, exposure: number, out: RGB): RGB {
  const k = exposure / 0.6;
  const r = c.r * k;
  const g = c.g * k;
  const b = c.b * k;
  // ACESInputMat (column-major in GLSL; rows written out here)
  let ir = 0.59719 * r + 0.35458 * g + 0.04823 * b;
  let ig = 0.076 * r + 0.90834 * g + 0.01566 * b;
  let ib = 0.0284 * r + 0.13383 * g + 0.83777 * b;
  ir = rrt(ir);
  ig = rrt(ig);
  ib = rrt(ib);
  const or = 1.60475 * ir - 0.53108 * ig - 0.07367 * ib;
  const og = -0.10208 * ir + 1.10813 * ig - 0.00605 * ib;
  const ob = -0.00327 * ir - 0.07276 * ig + 1.07602 * ib;
  out.r = srgb(clamp01(or));
  out.g = srgb(clamp01(og));
  out.b = srgb(clamp01(ob));
  return out;
}

function rrt(v: number): number {
  const a = v * (v + 0.0245786) - 0.000090537;
  const b = v * (0.983729 * v + 0.432951) + 0.238081;
  return a / b;
}

function srgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : Math.pow(v, 0.41666) * 1.055 - 0.055;
}

// --------------------------------------------------- Preetham sky port ----

const TOTAL_RAYLEIGH = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const MIE_CONST = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
const CUTOFF = 1.6110731556870734;
const STEEPNESS = 1.5;
const EE = 1000;
/** Same as skyUniforms in src/game/sky.ts (the expedition leaves them alone). */
const SKY_TURBIDITY = 2.4;
const SKY_RAYLEIGH = 2.2;
const SKY_MIE = 0.004;
const SKY_MIE_G = 0.82;

interface SkyParams {
  /** Sun direction fed to the sky shader (never far below the horizon). */
  sun: Vec3;
  /** Daytime sky gain (sky shader uSkyGain). */
  gain: number;
  /** Overcast blend (sky uStorm) and its colour. */
  storm: number;
  stormColor: RGB;
  nightZenith: RGB;
  nightHorizon: RGB;
  twilightGlow: RGB;
}

const betaR = [0, 0, 0];
const betaM = [0, 0, 0];
const ch = [0, 0, 0];

/**
 * Scene-linear (pre tone mapping) radiance of the sky shader in direction
 * (dx, dy, dz), matching SKY_VERTEX / SKY_FRAGMENT in `src/game/sky.ts`
 * (without the sun disc).
 */
export function skyRadiance(p: SkyParams, dx: number, dy: number, dz: number, out: RGB): RGB {
  const turbidity = SKY_TURBIDITY;
  const rayleigh = SKY_RAYLEIGH;
  const mieCoefficient = SKY_MIE;
  const mieDirectionalG = SKY_MIE_G;
  const s = p.sun;
  const zen = Math.acos(Math.max(-1, Math.min(1, s.y)));
  const sunE = EE * Math.max(0, 1 - Math.exp(-((CUTOFF - zen) / STEEPNESS)));
  const sunfade = 1 - clamp01(1 - Math.exp(s.y));
  const rc = rayleigh - (1 - sunfade);
  const mie = 0.434 * (0.2 * turbidity * 10e-18);
  for (let i = 0; i < 3; i++) {
    betaR[i] = TOTAL_RAYLEIGH[i] * rc;
    betaM[i] = mie * MIE_CONST[i] * mieCoefficient;
  }
  const zenithAngle = Math.acos(Math.max(0, dy));
  const inv = 1 / (Math.cos(zenithAngle) + 0.15 * Math.pow(93.885 - (zenithAngle * 180) / Math.PI, -1.253));
  const sR = 8.4e3 * inv;
  const sM = 1.25e3 * inv;
  const cosTheta = dx * s.x + dy * s.y + dz * s.z;
  const rp = (3 / (16 * Math.PI)) * (1 + Math.pow(cosTheta * 0.5 + 0.5, 2));
  const g = mieDirectionalG;
  const g2 = g * g;
  const mp = (1 / (4 * Math.PI)) * ((1 - g2) / Math.pow(1 - 2 * g * cosTheta + g2, 1.5));
  const horizonMix = clamp01(Math.pow(1 - s.y, 5));
  const gamma = 1 / (1.2 + 1.2 * sunfade);
  for (let i = 0; i < 3; i++) {
    const fex = Math.exp(-(betaR[i] * sR + betaM[i] * sM));
    const ratio = (betaR[i] * rp + betaM[i] * mp) / (betaR[i] + betaM[i]);
    let lin = Math.pow(Math.max(0, sunE * ratio * (1 - fex)), 1.5);
    lin *= 1 + (Math.pow(Math.max(0, sunE * ratio * fex), 0.5) - 1) * horizonMix;
    const l0 = 0.1 * fex;
    const tex = (lin + l0) * 0.04 + (i === 0 ? 0 : i === 1 ? 0.0003 : 0.00075);
    ch[i] = Math.pow(tex, gamma) * p.gain;
  }
  // Night and twilight terms (added in the sky shader hook).
  const up = clamp01(dy);
  const sq = Math.sqrt(up);
  const hl = Math.hypot(dx, dz) || 1;
  const sl = Math.hypot(s.x, s.z) || 1;
  const toSun = Math.max(0, ((dx / hl) * (s.x / sl) + (dz / hl) * (s.z / sl)) * 0.5 + 0.5);
  const glow = toSun * toSun * toSun * (1 - smooth(0, 0.3, up));
  ch[0] += p.nightHorizon.r + (p.nightZenith.r - p.nightHorizon.r) * sq + p.twilightGlow.r * glow;
  ch[1] += p.nightHorizon.g + (p.nightZenith.g - p.nightHorizon.g) * sq + p.twilightGlow.g * glow;
  ch[2] += p.nightHorizon.b + (p.nightZenith.b - p.nightHorizon.b) * sq + p.twilightGlow.b * glow;
  // Overcast.
  const horizon = 1 - smooth(0, 0.5, dy);
  const oc = 0.75 + 0.35 * horizon;
  out.r = ch[0] + (p.stormColor.r * oc - ch[0]) * p.storm;
  out.g = ch[1] + (p.stormColor.g * oc - ch[1]) * p.storm;
  out.b = ch[2] + (p.stormColor.b * oc - ch[2]) * p.storm;
  return out;
}

// ------------------------------------------------------------ palette -----

/** Piecewise-linear table over sun altitude in degrees. */
type Table = ReadonlyArray<readonly [number, number, number, number]>;

function sample(table: Table, x: number, out: RGB): RGB {
  if (x <= table[0][0]) return setRGB(out, table[0][1], table[0][2], table[0][3]);
  for (let i = 1; i < table.length; i++) {
    const b = table[i];
    if (x <= b[0]) {
      const a = table[i - 1];
      const t = (x - a[0]) / (b[0] - a[0]);
      return setRGB(out, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t);
    }
  }
  const l = table[table.length - 1];
  return setRGB(out, l[1], l[2], l[3]);
}

function sample1(table: ReadonlyArray<readonly [number, number]>, x: number): number {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    const b = table[i];
    if (x <= b[0]) {
      const a = table[i - 1];
      return a[1] + (b[1] - a[1]) * ((x - a[0]) / (b[0] - a[0]));
    }
  }
  return table[table.length - 1][1];
}

/** Sunlight colour by solar altitude: deep orange at the horizon, white at noon. */
const SUN_COLOR: Table = [
  [-2, 1.0, 0.36, 0.14],
  [0, 1.0, 0.46, 0.22],
  [2, 1.0, 0.64, 0.4],
  [3.7, 1.0, 0.8, 0.6],
  [8, 1.0, 0.87, 0.72],
  [15, 1.0, 0.92, 0.82],
  [30, 1.0, 0.96, 0.9],
  [60, 1.0, 0.98, 0.95],
];
const SUN_INTENSITY: ReadonlyArray<readonly [number, number]> = [
  [-1.5, 0],
  [0, 0.9],
  [2, 2.3],
  [3.7, 3.2],
  [12, 3.3],
  [60, 3.1],
];
/** Tone mapping exposure: the tutorial's 0.56 at a low sun, opened up at night. */
const EXPOSURE: ReadonlyArray<readonly [number, number]> = [
  [-16, 1.75],
  [-10, 1.6],
  [-5, 1.3],
  [-2, 1.02],
  [1, 0.74],
  [3.7, 0.56],
  [12, 0.54],
  [30, 0.52],
  [60, 0.5],
];
/** Overcast sky colour (sky uStormColor), scene-linear. */
const STORM_SKY: Table = [
  [-16, 0.014, 0.018, 0.032],
  [-8, 0.03, 0.036, 0.06],
  [-3, 0.1, 0.1, 0.13],
  [0, 0.3, 0.27, 0.3],
  [3.7, 0.62, 0.6, 0.64],
  [10, 0.76, 0.79, 0.85],
  [60, 0.82, 0.85, 0.9],
];
/** Cloud-sea shadow colour (between billows). */
const CLOUD_SHADOW: Table = [
  [-12, 0.32, 0.42, 0.72],
  [-3, 0.42, 0.4, 0.62],
  [1, 0.58, 0.44, 0.58],
  [4, 0.54, 0.54, 0.7],
  [12, 0.52, 0.58, 0.72],
  [60, 0.55, 0.62, 0.76],
];
/** Cloud-sea brightness/tint (multiplies the shaded deck). */
const CLOUD_TINT: Table = [
  [-16, 0.022, 0.03, 0.05],
  [-8, 0.04, 0.045, 0.07],
  [-4, 0.11, 0.09, 0.12],
  [-1, 0.32, 0.22, 0.24],
  [1.5, 0.74, 0.5, 0.42],
  [3.7, 0.95, 0.82, 0.72],
  [8, 1.0, 0.93, 0.86],
  [20, 1.0, 0.99, 0.97],
  [60, 1.03, 1.03, 1.03],
];
/** Underside of the cloud deck, scene-linear (diffuse light soaking through). */
const UNDER_COLOR: Table = [
  [-16, 0.006, 0.008, 0.014],
  [-6, 0.02, 0.022, 0.034],
  [-2, 0.07, 0.065, 0.08],
  [1, 0.18, 0.16, 0.18],
  [4, 0.32, 0.32, 0.36],
  [12, 0.42, 0.45, 0.52],
  [60, 0.5, 0.54, 0.62],
];

export interface SkyPalette {
  /** Sun altitude in degrees. */
  sunAltitude: number;
  daylight: number;
  /** 1 once the sky is properly dark (sun below ~-12 degrees). */
  night: number;
  /** Moonlight strength 0..1 (moon up, sky dark, phase). */
  moonlight: number;
  /** The one DirectionalLight: toward the sun by day, the moon by night. */
  lightDir: Vec3;
  lightColor: RGB;
  lightIntensity: number;
  exposure: number;
  /** Extra environment (IBL) intensity at night so shade stays readable. */
  envBoost: number;
  /** Sun direction for the sky shader (the true sun). */
  skySun: Vec3;
  /** Fades the Preetham daylight sky out through twilight (sky uSkyGain). */
  skyGain: number;
  /** Sky shader hook uniforms (scene-linear). */
  nightZenith: RGB;
  nightHorizon: RGB;
  twilightGlow: RGB;
  stormSky: RGB;
  /** Average clear-sky radiance a few degrees above the horizon (scene-linear). */
  horizon: RGB;
  /** Fog colours (display space: three mixes fog after tone mapping). */
  clearFog: RGB;
  stormFog: RGB;
  /** Cloud deck. */
  cloudSun: RGB;
  cloudShadow: RGB;
  cloudTint: RGB;
  underColor: RGB;
  underGlow: RGB;
  /** Snow hemisphere colour for the IBL bake (scene-linear). */
  ground: RGB;
}

export function createPalette(): SkyPalette {
  return {
    sunAltitude: 0,
    daylight: 1,
    night: 0,
    moonlight: 0,
    lightDir: { x: 0, y: 1, z: 0 },
    lightColor: rgb(1, 1, 1),
    lightIntensity: 3.2,
    exposure: 0.56,
    envBoost: 1,
    skySun: { x: 0, y: 1, z: 0 },
    skyGain: 1,
    nightZenith: rgb(),
    nightHorizon: rgb(),
    twilightGlow: rgb(),
    stormSky: rgb(0.78, 0.81, 0.87),
    horizon: rgb(),
    clearFog: rgb(0.55, 0.6, 0.72),
    stormFog: rgb(0.7, 0.72, 0.77),
    cloudSun: rgb(1, 0.78, 0.58),
    cloudShadow: rgb(0.52, 0.58, 0.72),
    cloudTint: rgb(1, 1, 1),
    underColor: rgb(0.4, 0.43, 0.5),
    underGlow: rgb(),
    ground: rgb(0.55, 0.6, 0.7),
  };
}

const MOON_COLOR = rgb(0.58, 0.7, 1.0);
const MOON_LIGHT = 0.3;
/** Clear-sky fog is pulled this far toward the measured horizon (rest: tutorial look). */
const FOG_FROM_SKY = 0.5;
/** The tutorial's fog colours, display space. */
const TUTORIAL_FOG = rgb(0.5, 0.58, 0.74);
const TUTORIAL_STORM_FOG = rgb(0.62, 0.67, 0.76);
/** The tutorial's IBL ground colour (sky.ts bakeSkyEnvironment). */
const TUTORIAL_GROUND = rgb(0.55, 0.6, 0.7);
/** Calibrated so the expedition at the tutorial's sun height matches its fog. */
let fogCalib: RGB | null = null;
let stormFogCalib: RGB | null = null;
let groundCalib: RGB | null = null;

const tA = rgb();
const tB = rgb();
const tC = rgb();
const params: SkyParams = {
  sun: { x: 0, y: 1, z: 0 },
  gain: 1,
  storm: 0,
  stormColor: rgb(),
  nightZenith: rgb(),
  nightHorizon: rgb(),
  twilightGlow: rgb(),
};

/** Average clear-sky radiance at 3 degrees elevation over 8 azimuths. */
function horizonAverage(p: SkyParams, out: RGB): RGB {
  setRGB(out, 0, 0, 0);
  const ce = Math.cos(3 * DEG);
  const se = Math.sin(3 * DEG);
  for (let i = 0; i < 8; i++) {
    const az = (i / 8) * Math.PI * 2 + 0.2;
    skyRadiance(p, Math.cos(az) * ce, se, Math.sin(az) * ce, tC);
    addScaledRGB(out, tC, 1 / 8);
  }
  return out;
}

function luma(c: RGB): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

function calibrate(): void {
  // The tutorial sun (SUN_DIRECTION in world-builders.ts), clear and stormy.
  const sun = { x: -0.72, y: 0.065, z: 0.68 };
  const l = Math.hypot(sun.x, sun.y, sun.z);
  const tmp = createPalette();
  fogCalib = rgb(1, 1, 1);
  stormFogCalib = rgb(1, 1, 1);
  groundCalib = rgb(1, 1, 1);
  computePalette(tmp, { x: sun.x / l, y: sun.y / l, z: sun.z / l }, { x: 0, y: -1, z: 0 }, 0);
  fogCalib = setRGB(rgb(), TUTORIAL_FOG.r / tmp.clearFog.r, TUTORIAL_FOG.g / tmp.clearFog.g, TUTORIAL_FOG.b / tmp.clearFog.b);
  stormFogCalib = setRGB(
    rgb(),
    TUTORIAL_STORM_FOG.r / tmp.stormFog.r,
    TUTORIAL_STORM_FOG.g / tmp.stormFog.g,
    TUTORIAL_STORM_FOG.b / tmp.stormFog.b,
  );
  // One scalar: keep the physically coloured bounce, match the tutorial's level.
  const k = luma(TUTORIAL_GROUND) / luma(tmp.ground);
  groundCalib = setRGB(rgb(), k, k, k);
}

/**
 * Fill `out` for a sun and moon direction (unit vectors) and an overcast
 * level 0..1 (only the moonlight depends on it here; the weather blends
 * clear and storm values itself). No allocation.
 */
export function computePalette(out: SkyPalette, sun: Vec3, moon: Vec3, overcast: number): SkyPalette {
  if (!fogCalib) calibrate();
  const a = Math.asin(Math.max(-1, Math.min(1, sun.y))) / DEG;
  const m = Math.asin(Math.max(-1, Math.min(1, moon.y))) / DEG;
  out.sunAltitude = a;
  out.daylight = daylightFrom(sun.y);
  const night = 1 - smooth(-14, -4, a);
  out.night = 1 - smooth(-16, -10, a);
  const illum = moonIllumination(sun, moon);
  const moonUp = smooth(-1, 9, m);
  out.moonlight = night * moonUp * (0.35 + 0.65 * illum) * (1 - 0.85 * overcast);

  // --- direct light: the sun by day, the moon by night (both pass through
  // ~zero intensity in twilight, so the direction can swap unseen).
  const sunI = sample1(SUN_INTENSITY, a);
  if (sunI > 0.001) {
    out.lightDir.x = sun.x;
    out.lightDir.y = sun.y;
    out.lightDir.z = sun.z;
    sample(SUN_COLOR, a, out.lightColor);
    out.lightIntensity = sunI;
  } else {
    out.lightDir.x = moon.x;
    out.lightDir.y = moon.y;
    out.lightDir.z = moon.z;
    copyRGB(out.lightColor, MOON_COLOR);
    out.lightIntensity = MOON_LIGHT * out.moonlight;
  }
  out.exposure = sample1(EXPOSURE, a);
  out.envBoost = 1 + 0.7 * night;

  // --- sky: the Preetham daylight sky (true sun, so the disc is only ever
  // where the sun really is) fades out through twilight, taking its grey
  // night floor with it; a blue-hour gradient and an ember band toward the
  // sun take over, then the moonlit / starlit night sky.
  out.skySun.x = sun.x;
  out.skySun.y = sun.y;
  out.skySun.z = sun.z;
  // By day the gain also deepens the high-sun sky: thin mountain air reads
  // as a saturated blue above bright snow instead of a pale wash.
  out.skyGain = a >= -1 ? 1 - 0.3 * smooth(6, 45, a) : Math.pow(smooth(-9, -1, a), 1.4);
  const mb = moonUp * illum * night;
  const base = 1 - smooth(-6, 0, a);
  setRGB(out.nightZenith, (0.0038 + 0.0024 * mb) * base, (0.0068 + 0.0042 * mb) * base, (0.0155 + 0.008 * mb) * base);
  setRGB(out.nightHorizon, (0.0095 + 0.0035 * mb) * base, (0.0135 + 0.0045 * mb) * base, (0.024 + 0.007 * mb) * base);
  const tw = smooth(-15, -6, a) * (1 - smooth(-3, 1.5, a));
  const deep = smooth(-10, -3, a);
  out.nightZenith.r += 0.005 * tw;
  out.nightZenith.g += 0.014 * tw;
  out.nightZenith.b += 0.045 * tw;
  out.nightHorizon.r += 0.016 * tw;
  out.nightHorizon.g += 0.02 * tw;
  out.nightHorizon.b += 0.042 * tw;
  setRGB(out.twilightGlow, (0.02 + 0.09 * deep) * tw, (0.008 + 0.028 * deep) * tw, (0.012 + 0.006 * deep) * tw);

  sample(STORM_SKY, a, out.stormSky);

  // --- measured horizon -> fog.
  params.sun.x = out.skySun.x;
  params.sun.y = out.skySun.y;
  params.sun.z = out.skySun.z;
  params.gain = out.skyGain;
  params.storm = 0;
  copyRGB(params.stormColor, out.stormSky);
  copyRGB(params.nightZenith, out.nightZenith);
  copyRGB(params.nightHorizon, out.nightHorizon);
  copyRGB(params.twilightGlow, out.twilightGlow);
  horizonAverage(params, out.horizon);
  displayFromScene(out.horizon, out.exposure, tA);
  const fc = fogCalib as RGB;
  // Away from the tutorial's sun height, trust the measured sky more.
  setRGB(
    out.clearFog,
    tA.r * (1 + (fc.r - 1) * FOG_FROM_SKY),
    tA.g * (1 + (fc.g - 1) * FOG_FROM_SKY),
    tA.b * (1 + (fc.b - 1) * FOG_FROM_SKY),
  );
  // Overcast horizon: uStormColor * 1.1 (see the sky shader).
  setRGB(tB, out.stormSky.r * 1.1, out.stormSky.g * 1.1, out.stormSky.b * 1.1);
  displayFromScene(tB, out.exposure, tA);
  const sc = stormFogCalib as RGB;
  setRGB(out.stormFog, tA.r * sc.r, tA.g * sc.g, tA.b * sc.b);

  // --- cloud deck.
  copyRGB(out.cloudSun, out.lightIntensity > 0 ? out.lightColor : MOON_COLOR);
  sample(CLOUD_SHADOW, a, out.cloudShadow);
  sample(CLOUD_TINT, a, out.cloudTint);
  // Moonlit tops: silver-blue, scaled by the moon.
  const ml = out.moonlight;
  out.cloudTint.r += 0.022 * ml;
  out.cloudTint.g += 0.032 * ml;
  out.cloudTint.b += 0.058 * ml;
  sample(UNDER_COLOR, a, out.underColor);
  // Low sun lights the cloud base from beneath toward the sun (sunrise pink, sunset gold).
  const low = smooth(-3, 0.5, a) * (1 - smooth(5, 16, a));
  // Pink right at sunrise (the morning sun is in the east), gold otherwise.
  const pink = (sun.x > 0 ? 1 : 0) * (1 - smooth(1, 6, a));
  setRGB(out.underGlow, 0.95 * low, (0.42 - 0.1 * pink) * low, (0.22 + 0.2 * pink) * low);

  // --- IBL ground: snow lit by the sky and the direct light.
  const lit = out.lightIntensity * Math.max(0, out.lightDir.y) * 0.26;
  const gc = groundCalib as RGB;
  setRGB(
    out.ground,
    Math.min(1.5, (out.horizon.r * 0.6 + out.lightColor.r * lit) * gc.r),
    Math.min(1.5, (out.horizon.g * 0.6 + out.lightColor.g * lit) * gc.g),
    Math.min(1.5, (out.horizon.b * 0.6 + out.lightColor.b * lit) * gc.b),
  );
  return out;
}
