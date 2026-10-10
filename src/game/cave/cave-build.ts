/**
 * The ice cave inside the Needle and the timber works that climb it.
 *
 * Everything here is built once in course space (the root sits at
 * CAVE_ORIGIN, far below the mountain, so the cave has its own air) and is
 * then animated by CaveSystem: each platform is a Group moved to its anchor,
 * and the parts that read the floor's state (deck tiles, signal lamps, edge
 * strips) are shared instanced banks so the whole works costs a handful of
 * draws.
 */

import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  HemisphereLight,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  RepeatWrapping,
  SphereGeometry,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  TorusGeometry,
  Vector3,
} from '@iwsdk/core';
import { buildGlider, type GliderPartId } from '../glider-model.js';
import { GeometryBuilder, placed, segmentMatrix } from '../mesh-utils.js';
import { fbm, mulberry32, valueNoise } from '../terrain.js';
import {
  anchorAt,
  BOARDINGS,
  berthsOf,
  GRID,
  INDEX,
  type Kind,
  PLATFORMS,
  ROUTE,
  type PlatformSpec,
  type Sq,
  sqOffset,
  SWING_1,
  SWING_2,
  type V3,
  WHEEL_C,
  WHEEL_R,
} from './cave-score.js';

/** Where the cave lives in the world: well below the mountain. */
export const CAVE_ORIGIN = new Vector3(0, -700, -93);
/** Surface of the meltwater pool, course space. */
export const POOL_Y = -0.32;
const FLOOR_Y = -2.2;
/** How far a gondola hangs below its pin on the wheel rim. */
export const GONDOLA_HANG = 2.3;
/** The wheel rim stands this far east of the gondola decks. */
const WHEEL_X = WHEEL_C.x + GRID.pitch + 0.62;
/** Height of a hoist's head frame above its upper berth. */
const HEADFRAME = 3.1;
/** Height of the ropeway cable above its deck. */
const CABLE_H = 2.5;

const TILE = GRID.tile;
const HALF = TILE / 2;
/** Cart track: rail centre below the deck, and the clearance the level chassis needs. */
const RAIL_DROP = 0.42;
const CHASSIS_CLEAR = 0.4;
const CART_HALF = 0.33;
/** Track that would have to dip further than this to clear the cart is left out. */
const MAX_DIP = 0.32;
/** Cart track is laid in straight lengths this long (m). */
const TRACK_STEP = 0.2;
/** Swing chain splay to the rock above (x, z), widest first. */
const CHAIN_SPREADS: [number, number][] = [
  [2.2, 1.4],
  [1.6, 1.3],
  [1.1, 1.15],
  [0.7, 1.0],
  [0.4, 0.85],
];

export const LAMP = {
  go: new Color(0.25, 1.4, 0.45),
  goDim: new Color(0.08, 0.34, 0.14),
  warn: new Color(1.6, 0.85, 0.15),
  stop: new Color(1.6, 0.16, 0.1),
  stopDim: new Color(0.45, 0.05, 0.03),
  off: new Color(0.06, 0.045, 0.035),
};

const WOOD = new Color(0.5, 0.33, 0.19);
const WOOD_DARK = new Color(0.31, 0.2, 0.12);
const WOOD_PALE = new Color(0.66, 0.48, 0.3);
const IRON = new Color(0.16, 0.16, 0.17);
const ROPE = new Color(0.55, 0.45, 0.3);
const BRASS = new Color(0.75, 0.55, 0.22);

const EDGES = ['N', 'E', 'S', 'W'] as const;
type Edge = (typeof EDGES)[number];
const EDGE_DIR: Record<Edge, Sq> = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };
const CORNERS: [number, number][] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

export interface PlatformVisual {
  spec: PlatformSpec;
  /** Moved to the platform's anchor every frame. */
  group: Group;
  /** Deck tile instances in the shared deck bank. */
  deckFirst: number;
  /** Lamp instances (4 per tile, machines only), -1 for stations. */
  lampFirst: number;
  /** Edge-strip instances (4 per tile, machines only). */
  stripFirst: number;
}

export interface RopeSpec {
  /** Platform whose anchor the near end rides with, or -1 for a fixed rope. */
  platform: number;
  /** Near end, relative to that platform's anchor (or course space if fixed). */
  local: Vector3;
  /** Far end in course space. */
  far: Vector3;
}

export interface CaveVisuals {
  root: Group;
  platforms: PlatformVisual[];
  decks: InstancedMesh;
  lamps: InstancedMesh;
  strips: InstancedMesh;
  ropes: InstancedMesh;
  ropeSpecs: RopeSpec[];
  /** Rotating part of the mill wheel (rim and spokes). */
  wheel: Group;
  /** Rings that mark the deck to step onto next. */
  marker: Mesh;
  /** The parts waiting on racks, by id. */
  parts: Record<GliderPartId, Group>;
  partGlow: Record<GliderPartId, Sprite>;
  /** "Pick up the glider part" sign over the first rack on the route. */
  partLabel: Sprite;
  partLabelHome: Vector3;
  /** The torch on its hook at the beacon and its flame. */
  torch: Group;
  torchFlame: Sprite;
  torchHome: Vector3;
  /** Where the torch must touch to light the beacon (course space). */
  brazier: Vector3;
  /** Light and fire effects for the lit beacon. */
  beaconGlow: Sprite;
  lights: Object3D[];
  /** The ice walls' material: it warms when the beacon is lit (no real lights). */
  shell: MeshStandardMaterial;
  /** The column of daylight from the chimney. */
  shaft: Mesh;
}

// ------------------------------------------------------------- textures ---

export function plankTexture(): CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rand = mulberry32(77);
  const planks = 5;
  const w = size / planks;
  for (let i = 0; i < planks; i++) {
    const tone = 0.78 + rand() * 0.3;
    ctx.fillStyle = `rgb(${Math.round(150 * tone)},${Math.round(104 * tone)},${Math.round(64 * tone)})`;
    ctx.fillRect(i * w, 0, w, size);
    // Grain: long wavy streaks along the plank.
    for (let g = 0; g < 18; g++) {
      const x0 = i * w + rand() * w;
      ctx.strokeStyle = `rgba(60,36,18,${0.12 + rand() * 0.18})`;
      ctx.lineWidth = 0.6 + rand() * 1.4;
      ctx.beginPath();
      for (let y = 0; y <= size; y += 8) {
        const x = x0 + Math.sin(y * 0.03 + g) * 2.5 + valueNoise(x0 * 0.1, y * 0.05) * 3;
        if (y === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // A knot or two.
    if (rand() < 0.7) {
      const kx = i * w + w * (0.3 + rand() * 0.4);
      const ky = rand() * size;
      ctx.fillStyle = 'rgba(55,32,16,0.55)';
      ctx.beginPath();
      ctx.ellipse(kx, ky, 3 + rand() * 3, 6 + rand() * 4, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // Dark seam and nail heads.
    ctx.fillStyle = 'rgba(28,16,8,0.85)';
    ctx.fillRect(i * w, 0, 2, size);
    ctx.fillStyle = 'rgba(30,30,32,0.9)';
    for (const y of [size * 0.12, size * 0.88]) {
      ctx.fillRect(i * w + w * 0.25, y, 3, 3);
      ctx.fillRect(i * w + w * 0.7, y, 3, 3);
    }
  }
  // Frost creeping in from the edges.
  const frost = ctx.createRadialGradient(size / 2, size / 2, size * 0.35, size / 2, size / 2, size * 0.75);
  frost.addColorStop(0, 'rgba(220,235,255,0)');
  frost.addColorStop(1, 'rgba(220,235,255,0.35)');
  ctx.fillStyle = frost;
  ctx.fillRect(0, 0, size, size);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

export function glowTexture(inner: string, outer: string): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, inner);
  g.addColorStop(0.35, outer);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** A flat sign that always faces you: a dark rounded card with bold text. */
export function labelSprite(lines: string[], width: number): Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(18,14,10,0.86)';
  ctx.beginPath();
  ctx.roundRect(8, 8, 1008, 240, 48);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,200,110,0.95)';
  ctx.lineWidth = 8;
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((line, i) => {
    let size = i === 0 ? 92 : 58;
    ctx.font = `800 ${size}px system-ui, sans-serif`;
    while (ctx.measureText(line).width > 940 && size > 20) {
      size -= 4;
      ctx.font = `800 ${size}px system-ui, sans-serif`;
    }
    ctx.fillStyle = i === 0 ? '#ffe4a8' : '#f4efe6';
    ctx.fillText(line, 512, lines.length === 1 ? 128 : 92 + i * 92);
  });
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const sprite = new Sprite(new SpriteMaterial({ map: texture, transparent: true, depthWrite: false, fog: false }));
  sprite.scale.set(width, width / 4, 1);
  sprite.renderOrder = 2;
  return sprite;
}

export function glowSprite(texture: CanvasTexture, size: number, opacity = 1): Sprite {
  const sprite = new Sprite(
    new SpriteMaterial({
      map: texture,
      transparent: true,
      opacity,
      blending: AdditiveBlending,
      depthWrite: false,
      fog: false,
    }),
  );
  sprite.scale.setScalar(size);
  return sprite;
}

// ------------------------------------------------------------- the cave ---

/** The cavern's horizontal centre and radius scale at height y (course space). */
function shellFrame(y: number): { cx: number; cz: number; rx: number; rz: number } {
  const t = Math.min(1, Math.max(0, (y - 12) / 19));
  const narrow = 1 - 0.58 * t * t * (3 - 2 * t);
  return {
    cx: -0.2 * (1 - t) + -0.9 * t,
    cz: -9.4 * (1 - t) + -13.3 * t,
    rx: 11.4 * narrow,
    rz: 15.6 * narrow,
  };
}

const SHELL_TOP = 31.5;

function buildShell(): Mesh {
  const rings = 64;
  const segs = 96;
  const positions: number[] = [];
  const colors: number[] = [];
  const c = new Color();
  const deep = new Color(0.02, 0.06, 0.13);
  const ice = new Color(0.16, 0.38, 0.62);
  const rock = new Color(0.1, 0.1, 0.12);
  const light = new Color(0.55, 0.7, 0.92);
  for (let j = 0; j <= rings; j++) {
    const v = j / rings;
    const y = FLOOR_Y + (SHELL_TOP - FLOOR_Y) * v;
    const f = shellFrame(y);
    // A rounded floor: the first rings pull in toward the middle.
    const bowl = Math.sqrt(Math.min(1, (y - FLOOR_Y) / 2.2 + 0.08));
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const n =
        fbm(ca * 2.2 + 7, y * 0.16, 4) * 0.16 +
        fbm(sa * 3.1 - 2, y * 0.42 + 4, 3) * 0.07 +
        Math.max(0, valueNoise(a * 5, y * 0.08)) * 0.08;
      const r = (1 + n) * bowl;
      positions.push(f.cx + ca * f.rx * r, y, f.cz + sa * f.rz * r);
      const iceAmt = Math.min(1, Math.max(0, 0.55 + fbm(ca * 4, y * 0.3 + sa * 2, 3) * 1.6));
      c.copy(rock).lerp(ice, iceAmt);
      // Deep blue below, daylight spilling down from the chimney above.
      c.lerp(deep, Math.max(0, 1 - (y - FLOOR_Y) / 10) * 0.7);
      c.lerp(light, Math.pow(Math.max(0, (y - 20) / 11.5), 2) * 0.75);
      colors.push(c.r, c.g, c.b);
    }
  }
  // Wound to face inward: the cave is seen from inside.
  const indices: number[] = [];
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < segs; i++) {
      const a = j * (segs + 1) + i;
      const b = a + segs + 1;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  // Floor cap.
  const centre = positions.length / 3;
  const f0 = shellFrame(FLOOR_Y);
  positions.push(f0.cx, FLOOR_Y - 0.4, f0.cz);
  colors.push(deep.r, deep.g, deep.b);
  for (let i = 0; i < segs; i++) indices.push(centre, i + 1, i);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new Mesh(
    geometry,
    new MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.85,
      metalness: 0,
      envMapIntensity: 0.15,
      emissive: new Color(0.025, 0.08, 0.16),
      emissiveIntensity: 1,
      flatShading: true,
    }),
  );
  mesh.name = 'CaveShell';
  mesh.receiveShadow = false;
  return mesh;
}

/** Icicles fringing the walls and glowing ice crystals on the floor. */
function buildIce(): Group {
  const group = new Group();
  const rand = mulberry32(911);
  const icicles = new InstancedMesh(
    new ConeGeometry(0.09, 1, 6, 1),
    new MeshStandardMaterial({
      color: 0xbfe3ff,
      roughness: 0.15,
      metalness: 0,
      emissive: 0x2b6ea8,
      emissiveIntensity: 0.55,
      transparent: true,
      opacity: 0.9,
    }),
    260,
  );
  const m = new Matrix4();
  const q = new Matrix4();
  for (let i = 0; i < 260; i++) {
    const y = 2 + rand() * 27;
    const f = shellFrame(y);
    const a = rand() * Math.PI * 2;
    const r = 0.86 + rand() * 0.06;
    const len = 0.4 + rand() * rand() * 2.6;
    const w = 0.6 + rand() * 1.2;
    m.makeScale(w, len, w);
    q.makeRotationX(Math.PI); // point down
    m.premultiply(q);
    m.setPosition(f.cx + Math.cos(a) * f.rx * r, y - len / 2, f.cz + Math.sin(a) * f.rz * r);
    icicles.setMatrixAt(i, m);
  }
  icicles.name = 'Icicles';
  group.add(icicles);

  const crystals = new InstancedMesh(
    new IcosahedronGeometry(0.5, 0),
    new MeshBasicMaterial({ color: new Color(0.35, 0.85, 1.4), toneMapped: false }),
    70,
  );
  for (let i = 0; i < 70; i++) {
    const y = FLOOR_Y + 1.2 + rand() * 1.4;
    const f = shellFrame(y);
    const a = rand() * Math.PI * 2;
    const r = 0.74 + rand() * 0.14;
    const s = 0.25 + rand() * 0.8;
    m.makeRotationY(rand() * 6);
    m.multiply(q.makeRotationZ((rand() - 0.5) * 0.9));
    m.multiply(q.makeScale(s * 0.5, s * 1.8, s * 0.5));
    m.setPosition(f.cx + Math.cos(a) * f.rx * r, y, f.cz + Math.sin(a) * f.rz * r);
    crystals.setMatrixAt(i, m);
  }
  crystals.name = 'IceCrystals';
  group.add(crystals);

  const pool = new Mesh(
    new PlaneGeometry(40, 40),
    new MeshStandardMaterial({
      color: 0x0a1a28,
      roughness: 0.06,
      metalness: 0.2,
      emissive: 0x041522,
      transparent: true,
      opacity: 0.92,
    }),
  );
  pool.rotation.x = -Math.PI / 2;
  pool.position.set(0, POOL_Y, -9);
  pool.name = 'MeltwaterPool';
  group.add(pool);

  // The sky through the chimney mouth, and the light falling from it.
  const top = shellFrame(SHELL_TOP);
  const sky = new Mesh(
    new SphereGeometry(4, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2),
    new MeshBasicMaterial({ color: new Color(0.55, 0.62, 0.9), side: BackSide, fog: false }),
  );
  sky.scale.set(top.rx / 3.6, 0.8, top.rz / 3.6);
  sky.position.set(top.cx, SHELL_TOP - 0.2, top.cz);
  sky.name = 'ChimneySky';
  group.add(sky);
  return group;
}

function buildShaft(): Mesh {
  const top = shellFrame(SHELL_TOP);
  const geometry = new CylinderGeometry(3.2, 7.5, 33, 24, 1, true);
  const material = new MeshBasicMaterial({
    color: new Color(0.16, 0.2, 0.3),
    transparent: true,
    opacity: 0.08,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
    fog: false,
  });
  const shaft = new Mesh(geometry, material);
  shaft.position.set(top.cx, SHELL_TOP - 16.5, top.cz);
  shaft.name = 'Lightshaft';
  return shaft;
}

// ------------------------------------------------------------ platforms ---

/** Which tile edges are left open for stepping across (no rail). */
function gapEdges(): Map<number, Set<string>> {
  const gaps = new Map<number, Set<string>>();
  const open = (platform: number, sq: Sq, edge: Edge) => {
    if (!gaps.has(platform)) gaps.set(platform, new Set());
    gaps.get(platform)!.add(`${sq[0]},${sq[1]},${edge}`);
  };
  const edgeToward = (from: Sq, to: Sq): Edge =>
    to[0] > from[0] ? 'E' : to[0] < from[0] ? 'W' : to[1] > from[1] ? 'S' : 'N';
  for (let i = 1; i < ROUTE.length; i++) {
    const b = BOARDINGS[i];
    if (!b) continue;
    for (const id of ROUTE[i - 1]) open(INDEX[id], b.from, edgeToward(b.from, b.to));
    for (const id of ROUTE[i]) open(INDEX[id], b.to, edgeToward(b.to, b.from));
  }
  return gaps;
}

function railEdges(spec: PlatformSpec, gaps: Set<string> | undefined): { sq: Sq; edge: Edge }[] {
  const out: { sq: Sq; edge: Edge }[] = [];
  const has = (c: number, r: number) => spec.claim.some((s) => s[0] === c && s[1] === r);
  for (const sq of spec.claim) {
    for (const edge of EDGES) {
      const d = EDGE_DIR[edge];
      if (has(sq[0] + d[0], sq[1] + d[1])) continue;
      if (gaps?.has(`${sq[0]},${sq[1]},${edge}`)) continue;
      out.push({ sq, edge });
    }
  }
  return out;
}

const box = (b: GeometryBuilder, w: number, h: number, d: number, x: number, y: number, z: number, color: Color) =>
  b.add(new BoxGeometry(w, h, d), placed(x, y, z), color);

const rod = (b: GeometryBuilder, a: Vector3, c: Vector3, r: number, color: Color, sides = 6) =>
  b.add(new CylinderGeometry(r, r, 1, sides), segmentMatrix(a, c, new Matrix4()), color);

// ----------------------------------------------------------- clearances ---

/** How far each kind of platform's frame reaches above and below its deck. */
const REACH: Record<Kind, { up: number; down: number }> = {
  station: { up: 1.6, down: 0.33 },
  raft: { up: 1.45, down: 0.33 },
  hoist: { up: 2.4, down: 0.32 },
  incline: { up: 0.75, down: 0.47 },
  skip: { up: 0.9, down: 0.47 },
  corner: { up: 0.75, down: 0.47 },
  swing: { up: 0.95, down: 0.27 },
  gondola: { up: 2.4, down: 0.28 },
  ropeway: { up: 2.7, down: 0.28 },
};
/** Half-width of a deck square with its framing. */
const FOOTPRINT = 0.34;

interface Swept {
  min: Vector3;
  max: Vector3;
  /** minX, minY, minZ, maxX, maxY, maxZ per pose and square. */
  boxes: Float32Array;
}
let swept: Swept[] | null = null;

/** Every platform's frame over its whole cycle, as boxes (course space). */
function sweptVolumes(): Swept[] {
  if (swept) return swept;
  const a = { x: 0, y: 0, z: 0 };
  swept = PLATFORMS.map((spec) => {
    const steps = spec.loopBars ? spec.loopBars * 16 : 1;
    const boxes = new Float32Array(steps * spec.claim.length * 6);
    const min = new Vector3(Infinity, Infinity, Infinity);
    const max = new Vector3(-Infinity, -Infinity, -Infinity);
    const reach = REACH[spec.kind];
    let n = 0;
    for (let k = 0; k < steps; k++) {
      anchorAt(spec, spec.keys[0].bar + k / 16, a);
      for (const sq of spec.claim) {
        const o = sqOffset(sq);
        const x = a.x + o.x;
        const z = a.z + o.z;
        boxes[n++] = x - FOOTPRINT;
        boxes[n++] = a.y - reach.down;
        boxes[n++] = z - FOOTPRINT;
        boxes[n++] = x + FOOTPRINT;
        boxes[n++] = a.y + reach.up;
        boxes[n++] = z + FOOTPRINT;
        min.set(Math.min(min.x, x - FOOTPRINT), Math.min(min.y, a.y - reach.down), Math.min(min.z, z - FOOTPRINT));
        max.set(Math.max(max.x, x + FOOTPRINT), Math.max(max.y, a.y + reach.up), Math.max(max.z, z + FOOTPRINT));
      }
    }
    return { min, max, boxes };
  });
  return swept;
}

/** Fixed things the frame must also stay out of: the mill wheel's disc and hub. */
const KEEP_OUT: Swept[] = [];
function keepOuts(): Swept[] {
  if (KEEP_OUT.length === 0) {
    const r = WHEEL_R + 0.25;
    const min = new Vector3(WHEEL_X - 0.75, WHEEL_C.y + GONDOLA_HANG - r, WHEEL_C.z - r);
    const max = new Vector3(WHEEL_X + 0.55, WHEEL_C.y + GONDOLA_HANG + r, WHEEL_C.z + r);
    KEEP_OUT.push({ min, max, boxes: new Float32Array([min.x, min.y, min.z, max.x, max.y, max.z]) });
  }
  return KEEP_OUT;
}

/**
 * Does a rod from `a` to `b` (radius r) stay clear of every platform's travel
 * (except platform `skip`, usually the machine the rod belongs to)? With
 * `wheel`, the mill wheel counts too.
 */
function clearOfMachines(a: Vector3, b: Vector3, r: number, skip = -1, wheel = false): boolean {
  const n = Math.max(1, Math.ceil(a.distanceTo(b) / 0.08));
  const volumes = sweptVolumes();
  const check = (v: Swept): boolean => {
    if (
      Math.max(a.x, b.x) + r < v.min.x || Math.min(a.x, b.x) - r > v.max.x ||
      Math.max(a.y, b.y) + r < v.min.y || Math.min(a.y, b.y) - r > v.max.y ||
      Math.max(a.z, b.z) + r < v.min.z || Math.min(a.z, b.z) - r > v.max.z
    ) {
      return true;
    }
    const bx = v.boxes;
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      const z = a.z + (b.z - a.z) * t;
      for (let j = 0; j < bx.length; j += 6) {
        if (
          x + r > bx[j] && x - r < bx[j + 3] &&
          y + r > bx[j + 1] && y - r < bx[j + 4] &&
          z + r > bx[j + 2] && z - r < bx[j + 5]
        ) {
          return false;
        }
      }
    }
    return true;
  };
  for (let i = 0; i < volumes.length; i++) if (i !== skip && !check(volumes[i])) return false;
  if (wheel) for (const v of keepOuts()) if (!check(v)) return false;
  return true;
}

/** Low rails along the open edges of a deck. */
function addRails(b: GeometryBuilder, spec: PlatformSpec, gaps: Set<string> | undefined, height: number, color: Color) {
  for (const { sq, edge } of railEdges(spec, gaps)) {
    const o = sqOffset(sq);
    const d = EDGE_DIR[edge];
    const ex = o.x + d[0] * (HALF - 0.02);
    const ez = o.z + d[1] * (HALF - 0.02);
    const along = d[0] === 0;
    for (const s of [-1, 1]) {
      const px = ex + (along ? s * (HALF - 0.03) : 0);
      const pz = ez + (along ? 0 : s * (HALF - 0.03));
      box(b, 0.05, height, 0.05, px, height / 2, pz, color);
    }
    const len = TILE - 0.02;
    box(b, along ? len : 0.05, 0.05, along ? 0.05 : len, ex, height, ez, color);
    box(b, along ? len : 0.035, 0.035, along ? 0.035 : len, ex, height * 0.5, ez, color);
  }
}

function frameMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({ vertexColors: true, roughness: 0.88, flatShading: true });
}

/** A lantern sitting on a post top: iron cage with a warm glow and a ring to carry it by. */
function addLantern(b: GeometryBuilder, x: number, y: number, z: number) {
  box(b, 0.12, 0.02, 0.12, x, y - 0.1, z, IRON);
  box(b, 0.14, 0.02, 0.14, x, y + 0.1, z, IRON);
  for (const [cx, cz] of CORNERS) box(b, 0.012, 0.2, 0.012, x + cx * 0.06, y, z + cz * 0.06, IRON);
  b.add(new SphereGeometry(0.05, 8, 6), placed(x, y, z), new Color(3.2, 2.0, 0.8));
  b.add(new TorusGeometry(0.035, 0.008, 4, 10), placed(x, y + 0.145, z), IRON);
}

/** A frame that follows its platform: rails, cages, keels, hangers. */
function buildMachineFrame(spec: PlatformSpec, gaps: Set<string> | undefined): GeometryBuilder {
  const b = new GeometryBuilder();
  const claim = spec.claim;
  // Joists under every tile.
  for (const sq of claim) {
    const o = sqOffset(sq);
    box(b, 0.07, 0.07, TILE, o.x - 0.2, -0.12, o.z, WOOD_DARK);
    box(b, 0.07, 0.07, TILE, o.x + 0.2, -0.12, o.z, WOOD_DARK);
  }
  switch (spec.kind) {
    case 'raft':
      for (const sq of claim) {
        const o = sqOffset(sq);
        for (let k = -2; k <= 2; k++) {
          b.add(
            new CylinderGeometry(0.075, 0.075, TILE + 0.06, 8),
            new Matrix4().makeRotationZ(Math.PI / 2).setPosition(o.x, -0.24, o.z + k * 0.13),
            k % 2 ? WOOD : WOOD_DARK,
          );
        }
      }
      // Bollards the ferry rope runs through.
      for (const x of [-GRID.pitch - 0.25, GRID.pitch + 0.25]) {
        box(b, 0.1, 1.4, 0.1, x, 0.6, -GRID.pitch - 0.22, WOOD_DARK);
        b.add(new CylinderGeometry(0.06, 0.06, 0.12, 8), placed(x, 1.3, -GRID.pitch - 0.22), IRON);
      }
      addRails(b, spec, gaps, 0.6, WOOD_PALE);
      break;
    case 'hoist': {
      // A cage: corner posts, a crown and a shackle for the rope.
      const o = sqOffset(claim[0]);
      for (const [cx, cz] of CORNERS) box(b, 0.06, 2.2, 0.06, o.x + cx * 0.27, 1.1, o.z + cz * 0.27, WOOD_DARK);
      for (const edge of EDGES) {
        const d = EDGE_DIR[edge];
        const along = d[0] === 0;
        box(b, along ? 0.6 : 0.06, 0.08, along ? 0.06 : 0.6, o.x + d[0] * 0.27, 2.2, o.z + d[1] * 0.27, WOOD_DARK);
      }
      box(b, 0.6, 0.06, 0.06, o.x, 2.2, o.z, IRON);
      box(b, 0.06, 0.06, 0.6, o.x, 2.2, o.z, IRON);
      b.add(new TorusGeometry(0.06, 0.015, 6, 10), placed(o.x, 2.3, o.z), IRON);
      box(b, 0.62, 0.12, 0.62, o.x, -0.24, o.z, WOOD_DARK);
      addRails(b, spec, gaps, 1.0, WOOD_PALE);
      break;
    }
    case 'incline':
    case 'skip':
    case 'corner': {
      // A cart: chassis, iron wheels and a tub lip.
      const o = sqOffset(claim[0]);
      box(b, 0.62, 0.16, 0.62, o.x, -0.24, o.z, WOOD_DARK);
      for (const [cx, cz] of CORNERS) {
        b.add(
          new CylinderGeometry(0.09, 0.09, 0.05, 10),
          new Matrix4().makeRotationZ(Math.PI / 2).setPosition(o.x + cx * 0.2, -0.36, o.z + cz * 0.22),
          IRON,
        );
      }
      addRails(b, spec, gaps, spec.kind === 'skip' ? 0.85 : 0.7, WOOD_PALE);
      break;
    }
    case 'swing': {
      const o = sqOffset(claim[0]);
      box(b, 0.64, 0.1, 0.64, o.x, -0.2, o.z, WOOD_DARK);
      addRails(b, spec, gaps, 0.9, ROPE);
      break;
    }
    case 'gondola': {
      // A basket hung level from a pin on the wheel's rim.
      const o = sqOffset(claim[0]);
      box(b, 0.64, 0.12, 0.64, o.x, -0.2, o.z, WOOD_DARK);
      addRails(b, spec, gaps, 0.95, WOOD);
      const pin = new Vector3(o.x + 0.62, GONDOLA_HANG, o.z);
      for (const s of [-1, 1]) {
        rod(b, new Vector3(o.x + 0.3, 0.95, o.z + s * 0.28), pin, 0.022, IRON);
        rod(b, new Vector3(o.x - 0.3, 0.95, o.z + s * 0.28), new Vector3(o.x, GONDOLA_HANG - 0.2, o.z), 0.018, IRON);
      }
      box(b, 0.62, 0.05, 0.05, o.x + 0.31, GONDOLA_HANG - 0.2, o.z, IRON);
      b.add(new CylinderGeometry(0.05, 0.05, 0.12, 8), new Matrix4().makeRotationZ(Math.PI / 2).setPosition(pin.x, pin.y, pin.z), BRASS);
      break;
    }
    case 'ropeway': {
      // A car slung from a carriage on the cable.
      const o = sqOffset(claim[0]);
      box(b, 0.64, 0.12, 0.64, o.x, -0.2, o.z, WOOD_DARK);
      addRails(b, spec, gaps, 1.0, WOOD);
      for (const s of [-1, 1]) rod(b, new Vector3(o.x + s * 0.3, 1.0, o.z), new Vector3(o.x, CABLE_H - 0.15, o.z), 0.02, IRON);
      box(b, 0.12, 0.16, 0.5, o.x, CABLE_H - 0.08, o.z, IRON);
      for (const s of [-1, 1]) {
        b.add(
          new CylinderGeometry(0.07, 0.07, 0.04, 12),
          new Matrix4().makeRotationZ(Math.PI / 2).setPosition(o.x, CABLE_H + 0.02, o.z + s * 0.17),
          BRASS,
        );
      }
      break;
    }
    default:
      break;
  }
  return b;
}

/** A station: rails, lanterns, and the timber that holds it up. */
function buildStationFrame(spec: PlatformSpec, index: number, gaps: Set<string> | undefined): GeometryBuilder {
  const support = supportFor(index);
  const b = new GeometryBuilder();
  for (const sq of spec.claim) {
    const o = sqOffset(sq);
    box(b, 0.66, 0.1, 0.66, o.x, -0.13, o.z, WOOD_DARK);
    box(b, 0.08, 0.14, 0.66, o.x - 0.29, -0.24, o.z, WOOD_DARK);
    box(b, 0.08, 0.14, 0.66, o.x + 0.29, -0.24, o.z, WOOD_DARK);
  }
  addRails(b, spec, gaps, 1.0, WOOD);
  // One stout post under the centre square, braced, down to the floor or
  // to the station below (stations stack into towers).
  const len = -0.3 - support.post;
  if (support.wall) {
    // A cantilever beam out to the ice wall, with a raking strut under it.
    const at = spec.keys[0].a;
    const f = shellFrame(at.y);
    let dx = (at.x - f.cx) / f.rx;
    let dz = (at.z - f.cz) / f.rz;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    const wall = new Vector3(f.cx + dx * f.rx * 0.9 - at.x, -0.25, f.cz + dz * f.rz * 0.9 - at.z);
    rod(b, new Vector3(0, -0.25, 0), wall, 0.1, WOOD_DARK, 4);
    rod(b, new Vector3(dx * 0.3, -0.3, dz * 0.3), wall.clone().setY(-2.6), 0.07, WOOD_DARK, 4);
  } else if (len > 0.1) {
    box(b, 0.2, len, 0.2, 0, -0.3 - len / 2, 0, WOOD_DARK);
    const brace = Math.min(1.4, len * 0.6);
    for (const [cx, cz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      rod(b, new Vector3(cx * 0.28, -0.3, cz * 0.28), new Vector3(0, -0.3 - brace, 0), 0.04, WOOD_DARK, 4);
    }
  }
  // A lantern on top of a rail corner post: a corner railed on both sides,
  // so it is never on the way across, and clear of every passing machine.
  const corner = lanternCorner(spec, index, gaps);
  if (corner) {
    const { x, z } = corner;
    box(b, 0.07, 1.25, 0.07, x, 0.625, z, WOOD_DARK);
    box(b, 0.13, 0.03, 0.13, x, 1.265, z, WOOD_DARK);
    addLantern(b, x, 1.39, z);
  }
  return b;
}

/** An outer corner of a station (rails on both its sides) where a lantern post fits. */
function lanternCorner(spec: PlatformSpec, index: number, gaps: Set<string> | undefined): { x: number; z: number } | null {
  const at = spec.keys[0].a;
  const rails = new Set(railEdges(spec, gaps).map((r) => `${r.sq[0]},${r.sq[1]},${r.edge}`));
  const options: { x: number; z: number }[] = [];
  for (const sq of spec.claim) {
    for (const [cx, cz] of CORNERS) {
      const ew = cx > 0 ? 'E' : 'W';
      const ns = cz > 0 ? 'S' : 'N';
      if (!rails.has(`${sq[0]},${sq[1]},${ew}`) || !rails.has(`${sq[0]},${sq[1]},${ns}`)) continue;
      const o = sqOffset(sq);
      options.push({ x: o.x + cx * (HALF - 0.03), z: o.z + cz * (HALF - 0.03) });
    }
  }
  for (let k = 0; k < options.length; k++) {
    const c = options[(k + index) % options.length];
    tmpA.set(at.x + c.x, at.y + 0.9, at.z + c.z);
    tmpB.set(at.x + c.x, at.y + 1.55, at.z + c.z);
    if (clearOfMachines(tmpA, tmpB, 0.08, index)) return c;
  }
  return null;
}

/** Fixed works: hoist head frames, rails, the wheel's tower, cables. */
function buildStatics(ropes: RopeSpec[]): { mesh: Mesh; wheel: Group } {
  const b = new GeometryBuilder();
  const v = (p: V3, dx = 0, dy = 0, dz = 0) => new Vector3(p.x + dx, p.y + dy, p.z + dz);

  for (let i = 0; i < PLATFORMS.length; i++) {
    const spec = PLATFORMS[i];
    const o = sqOffset(spec.claim[0]);
    const berths = berthsOf(spec);
    if (spec.kind === 'hoist') {
      const lo = berths.reduce((m, a) => (a.y < m.y ? a : m));
      const hi = berths.reduce((m, a) => (a.y > m.y ? a : m));
      const x = lo.x + o.x;
      const z = lo.z + o.z;
      const top = hi.y + 2.2 + HEADFRAME;
      // Guide posts either side of the cage, pushed out wherever another
      // machine passes close by, and a pulley beam across their tops.
      const side = Math.abs(o.x) > 0 ? 'z' : 'x';
      const reach: number[] = [];
      for (const s of [-1, 1]) {
        let d = 0.42;
        for (const tryD of [0.42, 0.62, 0.82, 1.02, 1.12, 1.25]) {
          d = tryD;
          tmpA.set(x + (side === 'x' ? s * d : 0), lo.y - 1.2, z + (side === 'z' ? s * d : 0));
          tmpB.set(tmpA.x, top, tmpA.z);
          if (clearOfMachines(tmpA, tmpB, 0.07)) break;
        }
        reach.push(d);
        const px = x + (side === 'x' ? s * d : 0);
        const pz = z + (side === 'z' ? s * d : 0);
        box(b, 0.12, top - (lo.y - 1.2), 0.12, px, (top + lo.y - 1.2) / 2, pz, WOOD_DARK);
      }
      const span = reach[0] + reach[1] + 0.16;
      const mid = (reach[1] - reach[0]) / 2;
      box(
        b,
        side === 'x' ? span : 0.16,
        0.18,
        side === 'z' ? span : 0.16,
        x + (side === 'x' ? mid : 0),
        top,
        z + (side === 'z' ? mid : 0),
        WOOD_DARK,
      );
      b.add(
        new CylinderGeometry(0.22, 0.22, 0.08, 16),
        new Matrix4()
          .makeRotationZ(Math.PI / 2)
          .premultiply(new Matrix4().makeRotationY(side === 'x' ? Math.PI / 2 : 0))
          .setPosition(x, top - 0.25, z),
        IRON,
      );
      ropes.push({ platform: i, local: new Vector3(o.x, 2.32, o.z), far: new Vector3(x, top - 0.25, z) });
      // The counterweight's rope falls back down beside the cage.
      ropes.push({
        platform: -1,
        local: new Vector3(x + (side === 'x' ? 0.22 : 0), top - 0.25, z + (side === 'z' ? 0.22 : 0)),
        far: new Vector3(x + (side === 'x' ? 0.22 : 0), lo.y + 0.4, z + (side === 'z' ? 0.22 : 0)),
      });
    } else if (spec.kind === 'incline' || spec.kind === 'skip' || spec.kind === 'corner') {
      // Rails along the cart's whole path, on trestle bents. The cart rides
      // level, so on a slope the track drops away under it: wherever the cart
      // covers a point its chassis stays above the rail. Over the trolley's
      // lift shaft (and wherever another machine crosses) there is no track.
      const loop = spec.loopBars ?? 8;
      const t0 = spec.keys[0].bar;
      // Every pose of the cart, then track points every TRACK_STEP along the run.
      const poses: Vector3[] = [];
      const a = { x: 0, y: 0, z: 0 };
      for (let k = 0; k <= 256; k++) {
        anchorAt(spec, t0 + (k / 256) * (loop / 2), a);
        poses.push(new Vector3(a.x + o.x, a.y, a.z + o.z));
      }
      const path: Vector3[] = [poses[0]];
      let run = 0;
      for (let k = 1; k < poses.length; k++) {
        run += Math.hypot(poses[k].x - poses[k - 1].x, poses[k].z - poses[k - 1].z);
        if (run >= TRACK_STEP || k === poses.length - 1) {
          path.push(poses[k]);
          run = 0;
        }
      }
      const N = path.length - 1;
      const railY = path.map((p) => {
        let y = p.y - RAIL_DROP;
        for (const q of poses) {
          if (Math.abs(q.x - p.x) < CART_HALF && Math.abs(q.z - p.z) < CART_HALF) y = Math.min(y, q.y - CHASSIS_CLEAR);
        }
        return y;
      });
      const onTrack = (k: number) => path[k].y - RAIL_DROP - railY[k] < MAX_DIP;
      const ra = new Vector3();
      const rb = new Vector3();
      for (let k = 0; k < N; k++) {
        const p = path[k];
        const q = path[k + 1];
        const dx = q.x - p.x;
        const dz = q.z - p.z;
        const len = Math.hypot(dx, dz);
        // Vertical run (the trolley's lift): guide posts, no rails.
        if (len < 1e-4 || Math.abs(q.y - p.y) > len || !onTrack(k) || !onTrack(k + 1)) continue;
        const sx = (-dz / len) * 0.22;
        const sz = (dx / len) * 0.22;
        const ya = railY[k];
        const yb = railY[k + 1];
        let clear = true;
        for (const s of [-1, 1]) {
          ra.set(p.x + s * sx, ya, p.z + s * sz);
          rb.set(q.x + s * sx, yb, q.z + s * sz);
          if (!clearOfMachines(ra, rb, 0.03, i, true)) clear = false;
        }
        const mx = (p.x + q.x) / 2;
        const mz = (p.z + q.z) / 2;
        const my = (ya + yb) / 2 - 0.07;
        ra.set(mx - (sx / 0.22) * 0.28, my, mz - (sz / 0.22) * 0.28);
        rb.set(mx + (sx / 0.22) * 0.28, my, mz + (sz / 0.22) * 0.28);
        if (!clear || !clearOfMachines(ra, rb, 0.04, i, true)) continue;
        for (const s of [-1, 1]) {
          rod(b, ra.set(p.x + s * sx, ya, p.z + s * sz), rb.set(q.x + s * sx, yb, q.z + s * sz), 0.03, IRON, 4);
        }
        // A sleeper across every other stretch of track.
        if (k % 2 === 0) b.add(new BoxGeometry(0.56, 0.05, 0.1), placed(mx, my, mz, Math.atan2(dx, dz)), WOOD_DARK);
      }
      // Bents under the rails every metre or so, where nothing runs past.
      for (let k = 0; k <= N; k += 5) {
        const p = path[k];
        const topY = railY[k] - 0.1;
        if (topY - FLOOR_Y < 0.5 || !onTrack(k)) continue;
        ra.set(p.x, topY, p.z);
        rb.set(p.x, FLOOR_Y, p.z);
        if (!clearOfMachines(ra, rb, 0.07, -1, true)) continue;
        box(b, 0.12, topY - FLOOR_Y, 0.12, p.x, (topY + FLOOR_Y) / 2, p.z, WOOD_DARK);
      }
      if (spec.kind === 'corner') {
        // The lift half of the trolley's run rides up between guide posts.
        const lo = path[0];
        const hi = path.find((p) => Math.abs(p.y - path[N].y) < 1e-3) ?? path[N];
        for (const s of [-1, 1]) box(b, 0.1, hi.y - lo.y + 3.2, 0.1, lo.x + 0.42, (hi.y + lo.y) / 2 + 1.2, lo.z + s * 0.32, WOOD_DARK);
      }
    } else if (spec.kind === 'swing') {
      const pivot = spec.id === 'swing-1' ? SWING_1 : SWING_2;
      const pz = pivot.z + o.z;
      // A short beam at the pivot, slung from the rock above on chains.
      box(b, 0.22, 0.22, 1.6, pivot.x, pivot.y + 0.1, pz, WOOD_DARK);
      box(b, 0.12, 0.12, 0.6, pivot.x, pivot.y - 0.05, pz, IRON);
      // Chains splayed as wide as the machines around (and the wheel) allow.
      let spread = CHAIN_SPREADS[CHAIN_SPREADS.length - 1];
      for (const sp of CHAIN_SPREADS) {
        let clear = true;
        for (const s of [-1, 1]) {
          for (const t of [-1, 1]) {
            tmpA.set(pivot.x, pivot.y + 0.2, pz + s * 0.7);
            tmpB.set(pivot.x + t * sp[0], pivot.y + 9, pz + s * sp[1]);
            if (!clearOfMachines(tmpA, tmpB, 0.04, -1, true)) clear = false;
          }
        }
        spread = sp;
        if (clear) break;
      }
      for (const s of [-1, 1]) {
        for (const t of [-1, 1]) {
          rod(b, new Vector3(pivot.x, pivot.y + 0.2, pz + s * 0.7), new Vector3(pivot.x + t * spread[0], pivot.y + 9, pz + s * spread[1]), 0.025, IRON, 4);
        }
      }
      for (const [cx, cz] of CORNERS) {
        ropes.push({
          platform: i,
          local: new Vector3(o.x + cx * 0.27, 0.9, o.z + cz * 0.27),
          far: new Vector3(pivot.x + cx * 0.06, pivot.y - 0.1, pz + cz * 0.25),
        });
      }
    } else if (spec.kind === 'ropeway' || spec.kind === 'raft') {
      const ends = berths.map((a) => new Vector3(a.x + o.x, a.y + (spec.kind === 'raft' ? 1.3 : CABLE_H + 0.06), a.z + (spec.kind === 'raft' ? o.z - 0.22 : o.z)));
      // Extend the cable past both berths to anchor posts, beyond where
      // anything (the raft itself included) ever passes.
      const dir = ends[1].clone().sub(ends[0]).normalize();
      const post = (end: Vector3, sign: number): Vector3 => {
        const p = end.clone();
        for (const ext of [1.2, 1.6, 2.0, 2.4, 2.8, 3.2]) {
          p.copy(end).addScaledVector(dir, sign * ext);
          tmpA.set(p.x, p.y + 0.3, p.z);
          tmpB.set(p.x, FLOOR_Y, p.z);
          if (clearOfMachines(tmpA, tmpB, 0.12)) break;
        }
        return p;
      };
      const p0 = post(ends[0], -1);
      const p1 = post(ends[1], 1);
      rod(b, p0, p1, 0.022, ROPE, 5);
      for (const p of [p0, p1]) {
        box(b, 0.2, p.y + 0.3 - FLOOR_Y, 0.2, p.x, (p.y + 0.3 + FLOOR_Y) / 2, p.z, WOOD_DARK);
      }
    }
  }

  // The mill wheel's A-frame tower on the east side of the gondolas.
  const hub = new Vector3(WHEEL_X, WHEEL_C.y + GONDOLA_HANG, WHEEL_C.z);
  // Legs splayed as wide as the swings and hoists passing by allow.
  let foot = 1.6;
  for (const tryFoot of [3.4, 3.0, 2.6, 2.2, 1.9, 1.6]) {
    foot = tryFoot;
    let clear = true;
    for (const s of [-1, 1]) {
      tmpA.set(WHEEL_X + 0.35, FLOOR_Y, WHEEL_C.z + s * foot);
      if (!clearOfMachines(tmpA, tmpB.copy(hub).setX(WHEEL_X + 0.35), 0.18)) clear = false;
    }
    if (clear) break;
  }
  for (const s of [-1, 1]) {
    rod(b, new Vector3(WHEEL_X + 0.35, FLOOR_Y, WHEEL_C.z + s * foot), hub.clone().setX(WHEEL_X + 0.35), 0.16, WOOD_DARK, 6);
  }
  box(b, 0.3, 0.3, 0.5, WHEEL_X + 0.3, hub.y, hub.z, IRON);

  const mesh = new Mesh(b.build(), frameMaterial());
  mesh.name = 'TimberWorks';

  // The rotating rim, spokes and pins.
  const wb = new GeometryBuilder();
  const rim = new TorusGeometry(WHEEL_R, 0.09, 6, 48);
  wb.add(rim, new Matrix4().makeRotationY(Math.PI / 2), WOOD);
  wb.add(new TorusGeometry(WHEEL_R - 0.35, 0.05, 5, 48), new Matrix4().makeRotationY(Math.PI / 2), WOOD_DARK);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    rod(wb, new Vector3(0, 0, 0), new Vector3(0, Math.sin(a) * WHEEL_R, Math.cos(a) * WHEEL_R), 0.06, WOOD_DARK, 5);
  }
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2;
    wb.add(
      new CylinderGeometry(0.06, 0.06, 0.66, 8),
      new Matrix4().makeRotationZ(Math.PI / 2).setPosition(-0.3, Math.sin(a) * WHEEL_R, Math.cos(a) * WHEEL_R),
      BRASS,
    );
  }
  wb.add(new CylinderGeometry(0.28, 0.28, 0.4, 14), new Matrix4().makeRotationZ(Math.PI / 2), IRON);
  const wheelMesh = new Mesh(wb.build(), frameMaterial());
  const wheel = new Group();
  wheel.name = 'MillWheel';
  wheel.position.copy(hub);
  wheel.add(wheelMesh);
  return { mesh, wheel };
}

/** Is a point right on another machine's line (so a bent there would block it)? */
function isNearPath(p: Vector3, self: number): boolean {
  const a = { x: 0, y: 0, z: 0 };
  for (let j = 0; j < PLATFORMS.length; j++) {
    if (j === self) continue;
    const spec = PLATFORMS[j];
    const span = spec.loopBars ?? 1;
    for (let t = 0; t < span; t += 0.25) {
      anchorAt(spec, spec.keys[0].bar + t, a);
      if (a.y > p.y) continue;
      for (const sq of spec.claim) {
        const o = sqOffset(sq);
        if (Math.abs(a.x + o.x - p.x) < 0.45 && Math.abs(a.z + o.z - p.z) < 0.45) return true;
      }
    }
  }
  return false;
}

/**
 * How a station is held up: a centre post down to the floor or onto the
 * station stacked below it, or, when a machine runs underneath, a beam out
 * to the cave wall instead.
 */
function supportFor(index: number): { post: number; wall: boolean } {
  const at = PLATFORMS[index].keys[0].a;
  let rest = FLOOR_Y;
  const a = { x: 0, y: 0, z: 0 };
  for (let j = 0; j < PLATFORMS.length; j++) {
    if (j === index) continue;
    const other = PLATFORMS[j];
    const span = other.loopBars ?? 1;
    for (let t = 0; t < span; t += 0.125) {
      anchorAt(other, other.keys[0].bar + t, a);
      if (a.y >= at.y - 0.2) continue;
      for (const sq of other.claim) {
        const o = sqOffset(sq);
        if (Math.abs(a.x + o.x - at.x) >= 0.45 || Math.abs(a.z + o.z - at.z) >= 0.45) continue;
        if (other.kind !== 'station') return { post: 0, wall: true };
        rest = Math.max(rest, a.y);
      }
    }
  }
  return { post: rest - at.y, wall: false };
}

// --------------------------------------------------------- the beacon ----

function buildBrazier(): Group {
  const b = new GeometryBuilder();
  // Stone plinth, iron tripod and basket.
  b.add(new CylinderGeometry(0.34, 0.42, 0.5, 8), placed(0, 0.25, 0), new Color(0.32, 0.31, 0.33));
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    rod(b, new Vector3(Math.cos(a) * 0.3, 0.5, Math.sin(a) * 0.3), new Vector3(Math.cos(a) * 0.16, 1.05, Math.sin(a) * 0.16), 0.03, IRON);
  }
  b.add(new CylinderGeometry(0.3, 0.18, 0.28, 10, 1, true), placed(0, 1.15, 0), IRON);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    b.add(new CylinderGeometry(0.035, 0.04, 0.42, 5), new Matrix4().makeRotationZ(0.5).premultiply(new Matrix4().makeRotationY(a)).setPosition(Math.cos(a) * 0.08, 1.2, Math.sin(a) * 0.08), WOOD_DARK);
  }
  const mesh = new Mesh(b.build(), frameMaterial());
  const group = new Group();
  group.name = 'Brazier';
  group.add(mesh);
  return group;
}

function buildTorch(): Group {
  const b = new GeometryBuilder();
  b.add(new CylinderGeometry(0.022, 0.028, 0.5, 8), placed(0, 0, 0), WOOD);
  b.add(new CylinderGeometry(0.045, 0.035, 0.12, 8), placed(0, 0.28, 0), new Color(0.2, 0.15, 0.1));
  const group = new Group();
  group.name = 'Torch';
  group.add(new Mesh(b.build(), frameMaterial()));
  return group;
}

// ---------------------------------------------------------------- build ---

export function buildCave(): CaveVisuals {
  const root = new Group();
  root.name = 'IceCave';
  root.position.copy(CAVE_ORIGIN);
  root.visible = false;

  const shellMesh = buildShell();
  root.add(shellMesh);
  root.add(buildIce());
  const shaft = buildShaft();
  root.add(shaft);

  const gaps = gapEdges();
  const ropeSpecs: RopeSpec[] = [];
  const statics = buildStatics(ropeSpecs);
  root.add(statics.mesh);
  root.add(statics.wheel);

  // Shared banks.
  let tileCount = 0;
  let machineTiles = 0;
  for (const spec of PLATFORMS) {
    tileCount += spec.claim.length;
    if (spec.kind !== 'station') machineTiles += spec.claim.length;
  }
  const plank = plankTexture();
  plank.wrapS = RepeatWrapping;
  plank.wrapT = RepeatWrapping;
  const decks = new InstancedMesh(
    new BoxGeometry(TILE, 0.08, TILE),
    new MeshStandardMaterial({ map: plank, roughness: 0.82, color: 0xffffff }),
    tileCount,
  );
  decks.name = 'Decks';
  decks.frustumCulled = false;
  const lamps = new InstancedMesh(
    new SphereGeometry(0.035, 8, 6),
    new MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
    machineTiles * 4,
  );
  lamps.name = 'SignalLamps';
  lamps.frustumCulled = false;
  const strips = new InstancedMesh(
    new BoxGeometry(1, 1, 1),
    new MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
    machineTiles * 4,
  );
  strips.name = 'EdgeStrips';
  strips.frustumCulled = false;
  root.add(decks, lamps, strips);

  const frameMat = frameMaterial();
  const platforms: PlatformVisual[] = [];
  let deck = 0;
  let lamp = 0;
  for (let i = 0; i < PLATFORMS.length; i++) {
    const spec = PLATFORMS[i];
    const group = new Group();
    group.name = `Platform-${spec.id}`;
    const builder =
      spec.kind === 'station'
        ? buildStationFrame(spec, i, gaps.get(i))
        : buildMachineFrame(spec, gaps.get(i));
    const mesh = new Mesh(builder.build(), frameMat);
    group.add(mesh);
    root.add(group);
    platforms.push({
      spec,
      group,
      deckFirst: deck,
      lampFirst: spec.kind === 'station' ? -1 : lamp,
      stripFirst: spec.kind === 'station' ? -1 : lamp,
    });
    deck += spec.claim.length;
    if (spec.kind !== 'station') lamp += spec.claim.length * 4;
  }
  const white = new Color(1, 1, 1);
  for (let k = 0; k < tileCount; k++) decks.setColorAt(k, white);
  for (let k = 0; k < machineTiles * 4; k++) {
    lamps.setColorAt(k, LAMP.off);
    strips.setColorAt(k, LAMP.off);
  }

  const ropes = new InstancedMesh(
    new CylinderGeometry(0.016, 0.016, 1, 5),
    new MeshStandardMaterial({ color: 0x8a6e48, roughness: 1 }),
    ropeSpecs.length,
  );
  ropes.name = 'Ropes';
  ropes.frustumCulled = false;
  root.add(ropes);

  // The next-step marker: a pulsing green ring on the deck to step onto.
  const marker = new Mesh(
    new TorusGeometry(0.22, 0.025, 6, 32),
    new MeshBasicMaterial({ color: new Color(0.3, 1.5, 0.5), toneMapped: false, transparent: true }),
  );
  marker.rotation.x = -Math.PI / 2;
  marker.name = 'StepMarker';
  marker.visible = false;
  root.add(marker);

  // Glider parts on their racks, at half scale like the summit kit.
  const glider = buildGlider();
  const partGlowTex = glowTexture('rgba(255,240,190,0.9)', 'rgba(255,190,90,0.35)');
  const parts = {} as Record<GliderPartId, Group>;
  const partGlow = {} as Record<GliderPartId, Sprite>;
  for (let i = 0; i < PLATFORMS.length; i++) {
    const spec = PLATFORMS[i];
    if (!spec.part) continue;
    const at = spec.keys[0].a;
    const rack = rackSpot(spec, gaps.get(i));
    const part = glider.parts[spec.part];
    glider.root.remove(part);
    part.position.set(0, 0, 0);
    part.scale.setScalar(0.5);
    const holder = new Group();
    holder.name = `Rack-${spec.part}`;
    holder.position.set(at.x + rack.x, at.y + 1.05, at.z + rack.z);
    // Wings lie along the rack; the bar stands up.
    holder.rotation.y = rack.yaw;
    if (spec.part === 'ControlBar') part.rotation.set(-1.2, 0, 0);
    else part.rotation.set(0, spec.part === 'LeftWing' ? -Math.PI / 2 : Math.PI / 2, 0);
    holder.add(part);
    root.add(holder);
    const rackB = new GeometryBuilder();
    box(rackB, 0.08, 1.0, 0.08, at.x + rack.x, at.y + 0.5, at.z + rack.z, WOOD_DARK);
    box(rackB, Math.abs(Math.sin(rack.yaw)) > 0.5 ? 0.08 : 0.7, 0.06, Math.abs(Math.sin(rack.yaw)) > 0.5 ? 0.7 : 0.08, at.x + rack.x, at.y + 0.98, at.z + rack.z, WOOD);
    root.add(new Mesh(rackB.build(), frameMat));
    const glow = glowSprite(partGlowTex, 1.1, 0.6);
    glow.position.copy(holder.position);
    root.add(glow);
    parts[spec.part] = holder;
    partGlow[spec.part] = glow;
  }

  // The first rack on the route says what to do with it.
  const firstPart = PLATFORMS.find((p) => p.part)!.part!;
  const partLabel = labelSprite(['Pick up the glider part', 'Close your hand on it'], 0.9);
  const partLabelHome = parts[firstPart].position.clone().add(new Vector3(0, 0.62, 0));
  partLabel.position.copy(partLabelHome);
  partLabel.name = 'PartLabel';
  root.add(partLabel);

  // The beacon: brazier on the top deck's east side, torch on a hook.
  const top = PLATFORMS.find((p) => p.beacon)!;
  const topAt = top.keys[0].a;
  const brazierGroup = buildBrazier();
  brazierGroup.position.set(topAt.x + GRID.pitch * 2 + 0.1, topAt.y - 0.1, topAt.z + GRID.pitch * 0.5);
  root.add(brazierGroup);
  const brazier = brazierGroup.position.clone().add(new Vector3(0, 1.3, 0));
  const plinth = new GeometryBuilder();
  box(plinth, 0.9, 0.12, 1.4, brazierGroup.position.x, topAt.y - 0.16, brazierGroup.position.z, WOOD_DARK);
  // The torch hook on a post north of the centre square.
  const hook = new Vector3(topAt.x - 0.05, topAt.y + 1.1, topAt.z - HALF - 0.22);
  box(plinth, 0.08, 1.4, 0.08, hook.x, topAt.y + 0.55, hook.z - 0.06, WOOD_DARK);
  box(plinth, 0.04, 0.04, 0.14, hook.x, hook.y + 0.1, hook.z - 0.02, IRON);
  root.add(new Mesh(plinth.build(), frameMat));
  const torch = buildTorch();
  torch.position.copy(hook);
  root.add(torch);
  const flameTex = glowTexture('rgba(255,236,170,1)', 'rgba(255,140,40,0.6)');
  const torchFlame = glowSprite(flameTex, 0.28, 0.9);
  torchFlame.position.set(0, 0.36, 0);
  torch.add(torchFlame);
  const beaconGlow = glowSprite(flameTex, 3.2, 0);
  beaconGlow.position.copy(brazier).add(new Vector3(0, 0.4, 0));
  root.add(beaconGlow);

  // One cheap fill light; lanterns, lamps, crystals and the beacon glow are
  // emissive, so no light costs a pixel more than this (Quest budget).
  const hemi = new HemisphereLight(0x9cc0ee, 0x4a3420, 1.7);
  hemi.position.set(0, 20, -9);
  const lights: Object3D[] = [hemi];
  for (const light of lights) {
    light.visible = false;
    root.add(light);
  }

  return {
    root,
    platforms,
    decks,
    lamps,
    strips,
    ropes,
    ropeSpecs,
    wheel: statics.wheel,
    marker,
    parts,
    partGlow,
    partLabel,
    partLabelHome,
    torch,
    torchFlame,
    torchHome: hook.clone(),
    brazier,
    beaconGlow,
    lights,
    shell: shellMesh.material as MeshStandardMaterial,
    shaft,
  };
}

/** A free side of a part station for the rack: offset from the anchor and facing. */
function rackSpot(spec: PlatformSpec, gaps: Set<string> | undefined): { x: number; z: number; yaw: number } {
  const rails = railEdges(spec, gaps).filter((r) => r.sq[0] === 0 && r.sq[1] === 0);
  const pick = rails.find((r) => r.edge === 'S') ?? rails[0] ?? { sq: [0, 0] as Sq, edge: 'S' as Edge };
  const d = EDGE_DIR[pick.edge];
  return { x: d[0] * (HALF + 0.22), z: d[1] * (HALF + 0.22), yaw: d[0] === 0 ? 0 : Math.PI / 2 };
}

const tmpM = new Matrix4();
const tmpA = new Vector3();
const tmpB = new Vector3();

/** Place a rope instance between two course-space points. */
export function setRope(ropes: InstancedMesh, index: number, a: Vector3, b: Vector3): void {
  tmpA.copy(a);
  tmpB.copy(b);
  if (tmpA.distanceToSquared(tmpB) < 1e-6) tmpB.y += 1e-3;
  ropes.setMatrixAt(index, segmentMatrix(tmpA, tmpB, tmpM));
}

export { CORNERS as TILE_CORNERS, EDGES as TILE_EDGES, EDGE_DIR, HALF as TILE_HALF };
