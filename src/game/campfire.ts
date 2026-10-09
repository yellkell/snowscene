/**
 * The party on the frozen lake: a towering bonfire you spot from the summit
 * once the storm breaks, and where the glide ends.
 *
 * Flames are crossed billboards with an animated noise shader; sparks and a
 * smoke column are small CPU particle pools; a flickering warm point light
 * lights the ice and snow, and a glow keeps it visible as a beacon from the
 * summit. Partygoers sway around the fire under strings of festoon lights,
 * with benches and tents around the edge; the crackle and roar rise as you
 * get close.
 */

import {
  Euler,
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  createSystem,
  type Entity,
  CylinderGeometry,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  NormalBlending,
  Object3D,
  PointLight,
  Points,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector3,
  CircleGeometry,
  MeshBasicMaterial,
} from '@iwsdk/core';
import { audio } from './audio.js';
import { landUniforms } from './land-material.js';
import { getHeadWorld } from './rig.js';
import { sceneRefs } from './scene-system.js';
import { game, PART_COUNT, Phase } from './state.js';
import { LAKE_CENTER_X, LAKE_CENTER_Z, LAKE_Y } from './terrain.js';
import { GeometryBuilder, placed, segmentMatrix } from './mesh-utils.js';
import { ARM_PIVOT, figureLook, figureParts, type FigureLook } from './figure.js';

/** Base of the bonfire, on the lake ice. */
export const FIRE_POS = new Vector3(LAKE_CENTER_X + 2, LAKE_Y + 0.02, LAKE_CENTER_Z - 2);
/** Radius of the party (dancers, lights, tents) around the fire. */
export const PARTY_RADIUS = 16;

const flameUniforms = { uTime: { value: 0 } };

/**
 * Flame sheets: tongues that lick up from a blue root through a white-hot
 * core, orange and yellow, to deep red ragged tips, with a warped, turbulent
 * body. Each sheet carries its own seed (vertex attribute), so a whole fire's
 * crossed sheets are one draw.
 */
function flameMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uTime: flameUniforms.uTime },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      varying vec2 vUv;
      varying float vSeed;
      void main() {
        vUv = uv;
        vSeed = aSeed;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec2 vUv;
      varying float vSeed;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
      }
      float fbm(vec2 p) {
        float s = 0.0; float a = 0.5;
        for (int i = 0; i < 4; i++) { s += noise(p) * a; p *= 2.1; a *= 0.5; }
        return s;
      }
      void main() {
        vec2 uv = vUv;
        float t = uTime * 1.6 + vSeed * 13.0;
        // Domain-warped turbulence rising through the sheet.
        vec2 q = vec2(uv.x * 3.0 + vSeed * 5.0, uv.y * 2.2 - t);
        float w = fbm(q + vec2(fbm(q * 1.7 + t * 0.3), 0.0));
        float n2 = fbm(vec2(uv.x * 8.0 - vSeed, uv.y * 5.0 - t * 1.7));
        float sway = (w - 0.5) * 0.45 * uv.y;
        // Separate tongues along the top edge.
        float lobes = 0.5 + 0.5 * sin((uv.x + sway) * 17.0 + vSeed * 7.0 + t * 1.3);
        float width = mix(0.44, 0.02, pow(uv.y, 0.7));
        float dx = abs(uv.x - 0.5 + sway);
        float body = smoothstep(width, width * 0.5, dx);
        float top = 0.62 + 0.38 * lobes;
        body *= smoothstep(top, top * 0.6, uv.y + (n2 - 0.5) * 0.5);
        body *= smoothstep(0.0, 0.06, uv.y);
        float heat = clamp(body * (1.3 - uv.y * 1.1) + (n2 - 0.5) * 0.25, 0.0, 1.0);
        vec3 col = mix(vec3(0.5, 0.05, 0.01), vec3(1.0, 0.36, 0.04), smoothstep(0.05, 0.4, heat));
        col = mix(col, vec3(1.0, 0.76, 0.28), smoothstep(0.4, 0.75, heat));
        col = mix(col, vec3(1.0, 0.97, 0.86), smoothstep(0.8, 1.0, heat));
        // A blue root where the gas first catches.
        col += vec3(0.08, 0.22, 0.9) * smoothstep(0.14, 0.0, uv.y) * body * 0.7;
        float a = clamp(body * 1.6, 0.0, 1.0) * smoothstep(0.0, 0.25, heat + 0.15);
        if (a < 0.01) discard;
        gl_FragColor = vec4(col * 1.7, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    // Normal blending keeps the fire readable even against bright snow and sky.
    side: DoubleSide,
    fog: false,
  });
}

/** `count` crossed flame sheets merged into one geometry, each with its own seed. */
function flameSheets(count: number, width: number, height: number, seed0: number): BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const seeds: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI;
    const w = (i % 2 ? 0.75 : 1) * width * 0.5;
    const ca = Math.cos(a) * w;
    const sa = Math.sin(a) * w;
    const base = positions.length / 3;
    // Corners: bottom-left, bottom-right, top-right, top-left (uv 0..1).
    for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      const k = u * 2 - 1;
      positions.push(k * ca, v * height, -k * sa);
      uvs.push(u, v);
      seeds.push(seed0 + i * 0.37);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  g.setAttribute('aSeed', new BufferAttribute(new Float32Array(seeds), 1));
  g.setIndex(indices);
  g.computeBoundingSphere();
  return g;
}

/** A glowing bed of embers and coals under the logs (two draws). */
function buildEmbers(scale: number): Group {
  const group = new Group();
  group.name = 'Embers';
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const c = size / 2;
  const g = ctx.createRadialGradient(c, c, 0, c, c, c);
  g.addColorStop(0, 'rgba(255,190,90,1)');
  g.addColorStop(0.35, 'rgba(255,90,20,0.85)');
  g.addColorStop(0.7, 'rgba(120,20,5,0.35)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  // Hot spots in the bed.
  for (let i = 0; i < 60; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * c * 0.6;
    ctx.fillStyle = `rgba(255,${180 + Math.random() * 60},${60 + Math.random() * 80},${0.3 + Math.random() * 0.5})`;
    ctx.beginPath();
    ctx.arc(c + Math.cos(a) * r, c + Math.sin(a) * r, 1 + Math.random() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const bed = new Mesh(
    new CircleGeometry(2.3 * scale, 24).rotateX(-Math.PI / 2),
    new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false }),
  );
  bed.position.y = 0.06 * scale + 0.02;
  bed.name = 'EmberBed';
  group.add(bed);
  // Coals glowing among the ash.
  const coals = new GeometryBuilder();
  const m = new Matrix4();
  for (let i = 0; i < 40; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * 1.6 * scale;
    const sz = (0.08 + Math.random() * 0.14) * Math.max(0.4, scale);
    m.makeRotationY(Math.random() * 6).scale(new Vector3(1.3, 0.6, 1)).setPosition(Math.cos(a) * r, sz * 0.3, Math.sin(a) * r);
    const hot = Math.random();
    coals.add(new IcosahedronGeometry(sz, 0), m, new Color(1.6 * hot + 0.25, 0.35 * hot * hot + 0.04, 0.02));
  }
  const coalMesh = new Mesh(coals.build(), new MeshBasicMaterial({ vertexColors: true, toneMapped: false }));
  coalMesh.name = 'Coals';
  group.add(coalMesh);
  return group;
}

/** Simple rising particle pool (sparks or smoke). */
class Plume {
  readonly points: Points;
  private readonly pos: Float32Array;
  private readonly alpha: Float32Array;
  private readonly size: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;

  constructor(
    private readonly count: number,
    private readonly spawn: (i: number, p: Float32Array, v: Float32Array) => number,
    private readonly step: (dt: number, i: number, p: Float32Array, v: Float32Array, t: number) => void,
    private readonly fade: (t: number) => number,
    private readonly grow: (t: number) => number,
    color: Color,
    additive: boolean,
  ) {
    this.pos = new Float32Array(count * 3);
    this.alpha = new Float32Array(count);
    this.size = new Float32Array(count);
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.maxLife = new Float32Array(count);
    for (let i = 0; i < count; i++) this.life[i] = -Math.random() * 3;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(this.pos, 3));
    geometry.setAttribute('aAlpha', new BufferAttribute(this.alpha, 1));
    geometry.setAttribute('aSize', new BufferAttribute(this.size, 1));
    this.points = new Points(
      geometry,
      new ShaderMaterial({
        uniforms: { uColor: { value: color } },
        vertexShader: /* glsl */ `
          attribute float aAlpha;
          attribute float aSize;
          varying float vAlpha;
          void main() {
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_Position = projectionMatrix * mv;
            gl_PointSize = min(aSize * 900.0 / max(-mv.z, 0.1), 256.0);
            vAlpha = aAlpha;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor;
          varying float vAlpha;
          void main() {
            float a = smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5)) * vAlpha;
            if (a < 0.01) discard;
            gl_FragColor = vec4(uColor, a);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }
        `,
        transparent: true,
        depthWrite: false,
        blending: additive ? AdditiveBlending : NormalBlending,
      }),
    );
    this.points.frustumCulled = false;
  }

  update(dt: number): void {
    for (let i = 0; i < this.count; i++) {
      this.life[i] += dt;
      if (this.life[i] < 0) {
        this.alpha[i] = 0;
        continue;
      }
      if (this.life[i] >= this.maxLife[i]) {
        this.maxLife[i] = this.spawn(i, this.pos, this.vel);
        this.life[i] = 0;
      }
      const t = this.life[i] / Math.max(this.maxLife[i], 1e-3);
      this.step(dt, i, this.pos, this.vel, t);
      this.alpha[i] = this.fade(t);
      this.size[i] = this.grow(t);
    }
    const geo = this.points.geometry;
    geo.getAttribute('position').needsUpdate = true;
    geo.getAttribute('aAlpha').needsUpdate = true;
    geo.getAttribute('aSize').needsUpdate = true;
  }
}

function glowTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,225,150,1)');
  g.addColorStop(0.2, 'rgba(255,150,50,0.7)');
  g.addColorStop(1, 'rgba(255,90,20,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

export interface BonfireOptions {
  /** 1 = the towering party bonfire; ~0.3 = a camp fire. */
  scale: number;
  /** Dancers, festoon lights, benches and tents around it. */
  party: boolean;
  /** Cast real firelight (a point light). Keep to one or two in view. */
  light: boolean;
  /** Direction (yaw) visitors approach from; the party leaves it open. */
  approachYaw?: number;
}

function buildLogStack(scale: number): Group {
  const fire = new Group();
  fire.name = 'Bonfire';
  // Logs and stones in one draw (vertex-coloured; the flames hide the bark).
  const bark = new Color(0.36, 0.25, 0.16);
  const charred = new Color(0.07, 0.05, 0.04);
  const stone = new Color(0.36, 0.35, 0.34);
  const b = new GeometryBuilder();
  // A teepee of logs over a charred core.
  const logs = scale > 0.6 ? 10 : 7;
  const m = new Matrix4();
  for (let i = 0; i < logs; i++) {
    const a = (i / logs) * Math.PI * 2;
    // lean the tops in toward the centre
    m.makeRotationFromEuler(new Euler(-Math.sin(a) * 0.45, 0, Math.cos(a) * 0.45)).setPosition(Math.cos(a) * 1.1 * scale, 1.8 * scale, Math.sin(a) * 1.1 * scale);
    b.add(new CylinderGeometry(0.2 * scale + 0.03, 0.28 * scale + 0.04, 4.6 * scale, 8), m, i % 2 ? bark : charred);
  }
  // Ring of stones.
  const stones = Math.round(14 + 12 * scale);
  for (let i = 0; i < stones; i++) {
    const a = (i / stones) * Math.PI * 2;
    m.makeRotationY(a * 3).scale(new Vector3(1.2, 0.7, 1)).setPosition(Math.cos(a) * 3.6 * scale, 0.12, Math.sin(a) * 3.6 * scale);
    b.add(new IcosahedronGeometry(0.2 + 0.18 * scale, 1), m, stone);
  }
  const mesh = new Mesh(b.build(), new MeshStandardMaterial({ vertexColors: true, roughness: 0.92 }));
  mesh.castShadow = true;
  fire.add(mesh);
  return fire;
}

function buildCampEdge(approachYaw: number): Group {
  const camp = new Group();
  camp.name = 'Camp';
  const m = new Matrix4();
  // Log benches in a wide ring (one draw).
  const benches = new GeometryBuilder();
  const bark = new Color(0.36, 0.25, 0.16);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.2;
    m.makeRotationFromEuler(new Euler(0, -a, Math.PI / 2)).setPosition(Math.cos(a) * 10, 0.24, Math.sin(a) * 10);
    benches.add(new CylinderGeometry(0.24, 0.24, 2.8, 10), m, bark);
  }
  const benchMesh = new Mesh(benches.build(), new MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }));
  benchMesh.castShadow = true;
  benchMesh.receiveShadow = true;
  camp.add(benchMesh);
  // Expedition tents around the edge, leaving the approach side open (one draw).
  const fabrics = [0xd8452b, 0xe8b13a, 0x2f6fb5, 0x3f9a5a, 0xb53f8f];
  const tents = new GeometryBuilder();
  for (let i = 0; i < 5; i++) {
    const a = approachYaw + 0.9 + (i / 4) * (Math.PI * 2 - 1.8);
    m.makeRotationY(a + Math.PI / 4).setPosition(Math.cos(a) * PARTY_RADIUS, 1.15, Math.sin(a) * PARTY_RADIUS);
    tents.add(new ConeGeometry(1.7, 2.3, 4, 1), m, new Color(fabrics[i]));
  }
  const tentMesh = new Mesh(tents.build(), new MeshStandardMaterial({ vertexColors: true, roughness: 0.75, side: DoubleSide }));
  tentMesh.castShadow = true;
  tentMesh.receiveShadow = true;
  camp.add(tentMesh);
  return camp;
}

/** Strings of coloured bulbs swagged between poles around the party. */
function buildFestoonLights(): Group {
  const group = new Group();
  group.name = 'FestoonLights';
  const poles = 10;
  const radius = 12.5;
  const height = 4.2;
  const bulbsPerSpan = 14;
  const bulbs = new InstancedMesh(
    new IcosahedronGeometry(0.09, 1),
    new MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 2.2 }),
    poles * bulbsPerSpan,
  );
  const palette = [
    new Color(1, 0.75, 0.3),
    new Color(1, 0.3, 0.25),
    new Color(0.35, 0.9, 0.45),
    new Color(0.35, 0.6, 1),
    new Color(1, 0.45, 0.85),
  ];
  const m = new Matrix4();
  const a = new Vector3();
  const b = new Vector3();
  const p = new Vector3();
  let k = 0;
  // Poles and wires in one draw.
  const frame = new GeometryBuilder();
  const poleColor = new Color(0x3a2a1c);
  const wireColor = new Color(0x111111);
  for (let i = 0; i < poles; i++) {
    const ang = (i / poles) * Math.PI * 2;
    frame.add(new CylinderGeometry(0.06, 0.08, height, 6), placed(Math.cos(ang) * radius, height / 2, Math.sin(ang) * radius), poleColor);
    const next = ((i + 1) / poles) * Math.PI * 2;
    a.set(Math.cos(ang) * radius, height - 0.1, Math.sin(ang) * radius);
    b.set(Math.cos(next) * radius, height - 0.1, Math.sin(next) * radius);
    // sagging wire
    const wirePts: Vector3[] = [];
    for (let j = 0; j <= bulbsPerSpan; j++) {
      const t = j / bulbsPerSpan;
      p.lerpVectors(a, b, t);
      p.y -= Math.sin(Math.PI * t) * 0.9;
      wirePts.push(p.clone());
      if (j < bulbsPerSpan) {
        m.makeTranslation(p.x, p.y - 0.12, p.z);
        bulbs.setMatrixAt(k, m);
        bulbs.setColorAt(k, palette[(i * 3 + j) % palette.length]);
        k++;
      }
    }
    for (let j = 0; j < wirePts.length - 1; j++) {
      frame.add(new CylinderGeometry(0.012, 0.012, 1, 4), segmentMatrix(wirePts[j], wirePts[j + 1]), wireColor);
    }
  }
  const frameMesh = new Mesh(frame.build(), new MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }));
  frameMesh.castShadow = true;
  group.add(frameMesh);
  bulbs.instanceMatrix.needsUpdate = true;
  if (bulbs.instanceColor) bulbs.instanceColor.needsUpdate = true;
  group.add(bulbs);
  return group;
}

interface Dancer {
  root: Group;
  phase: number;
  speed: number;
  baseYaw: number;
  arms: Mesh[];
  baseY: number;
}

/** A simple partygoer in a winter jacket and beanie. */
function buildDancer(look: FigureLook): { root: Group; arms: Mesh[] } {
  const root = new Group();
  // Body, head and hat in one draw; only the arms move on their own.
  const fig = new GeometryBuilder();
  const armB = [new GeometryBuilder(), new GeometryBuilder()];
  const toPivot = [new Matrix4().makeTranslation(ARM_PIVOT.x, -ARM_PIVOT.y, 0), new Matrix4().makeTranslation(-ARM_PIVOT.x, -ARM_PIVOT.y, 0)];
  for (const part of figureParts(look)) {
    if (part.limb === 0) fig.add(part.geometry, part.matrix, part.color);
    else armB[part.limb - 1].add(part.geometry, part.matrix.clone().premultiply(toPivot[part.limb - 1]), part.color);
  }
  const material = dancerMaterial();
  const figure = new Mesh(fig.build(), material);
  const arms: Mesh[] = [];
  for (const side of [-1, 1]) {
    const arm = new Mesh(armB[side < 0 ? 0 : 1].build(), material);
    arm.position.set(side * ARM_PIVOT.x, ARM_PIVOT.y, 0);
    arms.push(arm);
    root.add(arm);
  }
  figure.castShadow = true;
  root.add(figure);
  return { root, arms };
}

let sharedDancerMaterial: MeshStandardMaterial | null = null;
function dancerMaterial(): MeshStandardMaterial {
  return (sharedDancerMaterial ??= new MeshStandardMaterial({ vertexColors: true, roughness: 0.75 }));
}

/** How long a fire takes to grow from embers to a full blaze. */
const IGNITE_SECONDS = 3.5;

/**
 * One fire (optionally with a party around it). Build it with a parent
 * entity creator, then call `update` every frame.
 */
export class Bonfire {
  readonly position: Vector3;
  readonly options: BonfireOptions;
  private light: PointLight | null = null;
  private glow: Sprite;
  private sparks: Plume;
  private smoke: Plume;
  private dancers: Dancer[] = [];
  private readonly flameHeight: number;
  private flames!: Group;
  private embers!: Group;
  /** Seconds since ignite() (Infinity = fully lit). */
  private igniteAge = Infinity;
  visible = true;
  readonly objects: Object3D[] = [];

  constructor(position: Vector3, options: BonfireOptions) {
    this.position = position.clone();
    this.options = options;
    const scale = options.scale;
    this.flameHeight = 10 * scale;
    const approach = options.approachYaw ?? -Math.PI / 2;
    const place = (object: Object3D) => {
      object.position.add(this.position);
      this.objects.push(object);
    };

    place(buildLogStack(scale));
    if (options.party) {
      place(buildCampEdge(approach));
      place(buildFestoonLights());
      // Partygoers in a loose ring, facing the fire, gap on the approach side.
      const count = 16;
      for (let i = 0; i < count; i++) {
        const ang = approach + 0.6 + (i / (count - 1)) * (Math.PI * 2 - 1.2);
        const r = 6.2 + (((i * 37) % 10) / 10) * 1.8;
        const { root, arms } = buildDancer(figureLook(i));
        root.position.set(Math.cos(ang) * r, 0, Math.sin(ang) * r);
        const baseYaw = Math.atan2(-Math.cos(ang), -Math.sin(ang));
        root.rotation.y = baseYaw;
        root.name = `Partygoer${i}`;
        place(root);
        this.dancers.push({ root, arms, phase: i * 1.7, speed: 2.4 + (i % 4) * 0.35, baseYaw, baseY: this.position.y });
      }
    }

    const flames = new Group();
    flames.name = 'Flames';
    const sheets = new Mesh(flameSheets(scale > 0.6 ? 6 : 4, 7.5 * scale, this.flameHeight, position.x), flameMaterial());
    sheets.position.y = 0.1 * scale;
    flames.add(sheets);
    place(flames);
    this.flames = flames;
    this.embers = buildEmbers(scale);
    place(this.embers);

    if (options.light) {
      this.light = new PointLight(new Color(1, 0.55, 0.22), 3500 * scale * scale, 160 * scale, 2);
      this.light.position.set(0, 4 * scale, 0);
      this.light.name = 'Firelight';
      place(this.light);
    }

    // From afar a warm halo marks the fire as a beacon.
    this.glow = new Sprite(
      new SpriteMaterial({
        map: glowTexture(),
        depthWrite: false,
        transparent: true,
        fog: false,
        opacity: 0,
      }),
    );
    this.glow.position.set(0, 4 * scale, 0);
    place(this.glow);

    const fx = this.position.x;
    const fy = this.position.y;
    const fz = this.position.z;
    const fh = this.flameHeight;
    this.sparks = new Plume(
      Math.round(320 * scale) + 40,
      (i, p, v) => {
        p[i * 3] = fx + (Math.random() - 0.5) * 2.5 * scale;
        p[i * 3 + 1] = fy + (1.5 + Math.random() * 2) * scale;
        p[i * 3 + 2] = fz + (Math.random() - 0.5) * 2.5 * scale;
        v[i * 3] = (Math.random() - 0.5) * 2 * scale;
        v[i * 3 + 1] = (4 + Math.random() * 7) * Math.sqrt(scale);
        v[i * 3 + 2] = (Math.random() - 0.5) * 2 * scale;
        return 1.5 + Math.random() * 2.5;
      },
      (dt, i, p, v, t) => {
        v[i * 3] += Math.sin(t * 20 + i) * dt * 4;
        v[i * 3 + 1] -= dt * 1.2;
        p[i * 3] += v[i * 3] * dt;
        p[i * 3 + 1] += v[i * 3 + 1] * dt;
        p[i * 3 + 2] += v[i * 3 + 2] * dt;
      },
      (t) => (1 - t) * (0.7 + 0.3 * Math.sin(t * 40)),
      () => 0.06,
      new Color(1.6, 0.6, 0.15),
      true,
    );
    this.objects.push(this.sparks.points);

    this.smoke = new Plume(
      Math.round(42 * scale) + 10,
      (i, p, v) => {
        p[i * 3] = fx + (Math.random() - 0.5) * 1.5 * scale;
        p[i * 3 + 1] = fy + fh * 0.75;
        p[i * 3 + 2] = fz + (Math.random() - 0.5) * 1.5 * scale;
        v[i * 3] = 0.5 + Math.random() * 0.5;
        v[i * 3 + 1] = (3.5 + Math.random() * 1.5) * Math.sqrt(scale);
        v[i * 3 + 2] = (Math.random() - 0.5) * 0.5;
        return 18 + Math.random() * 6;
      },
      (dt, i, p, v) => {
        p[i * 3] += v[i * 3] * dt;
        p[i * 3 + 1] += v[i * 3 + 1] * dt;
        p[i * 3 + 2] += v[i * 3 + 2] * dt;
      },
      (t) => Math.min(1, t * 5) * (1 - t) * 0.32,
      (t) => (2 + t * 11) * Math.sqrt(scale),
      new Color(0.42, 0.41, 0.42),
      false,
    );
    this.objects.push(this.smoke.points);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    for (const object of this.objects) object.visible = visible;
  }

  /** Show the fire and grow it from embers to a roaring blaze. */
  ignite(): void {
    this.setVisible(true);
    this.igniteAge = 0;
  }

  /** 0..1 how lit the fire is (ramps up after ignite()). */
  get blaze(): number {
    if (!this.visible) return 0;
    const t = Math.min(1, this.igniteAge / IGNITE_SECONDS);
    return 1 - (1 - t) * (1 - t) * (1 - t);
  }

  /** Returns the fire's audible level at the viewer (0..1). */
  update(dt: number, time: number, viewer: Vector3, flicker: number): number {
    if (!this.visible) return 0;
    const scale = this.options.scale;
    if (this.igniteAge < IGNITE_SECONDS) {
      this.igniteAge += dt;
      this.flames.scale.setScalar(0.08 + 0.92 * this.blaze);
    }
    if (this.light) this.light.intensity = 3500 * scale * scale * flicker;
    // The ember bed breathes with the flames.
    const bed = this.embers.children[0] as Mesh;
    (bed.material as MeshBasicMaterial).opacity = (0.75 + 0.25 * flicker) * (0.3 + 0.7 * this.blaze);
    this.sparks.update(dt);
    this.smoke.update(dt);

    // Dancers bob, sway and throw their arms up.
    for (const d of this.dancers) {
      const t = time * d.speed + d.phase;
      d.root.position.y = d.baseY + Math.abs(Math.sin(t)) * 0.12;
      d.root.rotation.y = d.baseYaw + Math.sin(t * 0.5) * 0.35;
      d.root.rotation.z = Math.sin(t) * 0.08;
      const raise = 0.5 + 0.5 * Math.sin(t * 0.5 + d.phase);
      d.arms[0].rotation.z = -(0.3 + raise * 2.4) + Math.sin(t * 2) * 0.2;
      d.arms[1].rotation.z = 0.3 + raise * 2.4 + Math.sin(t * 2 + 1) * 0.2;
    }

    const dist = viewer.distanceTo(this.position);
    const beacon = Math.min(1, Math.max(0, (dist - 30 * scale) / (70 * scale)));
    (this.glow.material as SpriteMaterial).opacity = beacon * (0.8 + 0.2 * flicker) * this.blaze;
    this.glow.scale.setScalar((12 + beacon * 18) * scale * (0.9 + 0.1 * flicker));
    return Math.pow(Math.max(0, 1 - dist / (90 * Math.max(0.4, scale))), 1.5);
  }
}

/** Every fire in the world; the campfire system animates them all. */
export const fires: Bonfire[] = [];

export class CampfireSystem extends createSystem({}) {
  private readonly head = new Vector3();
  private party!: Bonfire;

  init(): void {
    // The tutorial's party on the frozen lake. It stays dark until the
    // glider is built, then lights up in the distance: that's where you fly.
    // Its light is faked in the land/lake shaders (uFireGlow): a real
    // PointLight costs every lit pixel on the headset.
    this.party = new Bonfire(FIRE_POS, { scale: 1, party: true, light: false });
    this.addFire(this.party, sceneRefs.tutorialRoot ?? undefined);
    this.party.setVisible(false);
    landUniforms.uFireGlow.value.set(FIRE_POS.x, FIRE_POS.y, FIRE_POS.z, 0);
    const updateParty = () => {
      const phase = game.phase.peek();
      const built =
        game.partsPlaced.peek() >= PART_COUNT ||
        phase === Phase.Launch ||
        phase === Phase.Gliding ||
        phase === Phase.Landed;
      if (built && !this.party.visible) {
        this.party.ignite();
        audio.whoosh();
      } else if (!built && this.party.visible) {
        this.party.setVisible(false);
      }
    };
    updateParty();
    this.cleanupFuncs.push(game.phase.subscribe(updateParty), game.partsPlaced.subscribe(updateParty));
  }

  /** Create entities for a fire and start animating it. */
  addFire(fire: Bonfire, parent?: Entity): Bonfire {
    for (const object of fire.objects) {
      this.world.createTransformEntity(object, { parent, persistent: true });
    }
    fires.push(fire);
    return fire;
  }

  update(delta: number, time: number): void {
    const dt = Math.min(delta, 0.1);
    flameUniforms.uTime.value = time;
    const flicker =
      0.8 + 0.2 * Math.sin(time * 13.1) * Math.sin(time * 7.3 + 1.7) + 0.08 * Math.sin(time * 31);
    getHeadWorld(this.world, this.head);
    let level = 0;
    for (const fire of fires) level = Math.max(level, fire.update(dt, time, this.head, flicker));
    landUniforms.uFireGlow.value.w = this.party.visible ? 2.2 * flicker * this.party.blaze : 0;
    // Crackle and roar from the nearest fire.
    audio.setFire(level);
    if (level > 0.02 && Math.random() < dt * 14 * level) audio.crackle(level);
  }
}
