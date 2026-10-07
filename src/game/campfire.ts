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
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CapsuleGeometry,
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
  PlaneGeometry,
  PointLight,
  Points,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector3,
} from '@iwsdk/core';
import { audio } from './audio.js';
import { getHeadWorld } from './rig.js';
import { sceneRefs } from './scene-system.js';
import { LAKE_CENTER_X, LAKE_CENTER_Z, LAKE_Y } from './terrain.js';
import { segmentMatrix } from './mesh-utils.js';
import { buildBarkTexture } from './textures.js';

/** Base of the bonfire, on the lake ice. */
export const FIRE_POS = new Vector3(LAKE_CENTER_X + 2, LAKE_Y + 0.02, LAKE_CENTER_Z - 2);
/** Radius of the party (dancers, lights, tents) around the fire. */
export const PARTY_RADIUS = 16;

const flameUniforms = { uTime: { value: 0 } };

function flameMaterial(seed: number): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uTime: flameUniforms.uTime, uSeed: { value: seed } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uSeed;
      varying vec2 vUv;
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
        float t = uTime * 1.7 + uSeed * 13.0;
        float n = fbm(vec2(uv.x * 4.0 + uSeed * 5.0, uv.y * 3.0 - t));
        float n2 = fbm(vec2(uv.x * 9.0 - uSeed, uv.y * 6.0 - t * 1.6));
        // Tongues of flame: wide at the base, licking up to a ragged tip.
        float sway = (n - 0.5) * 0.35 * uv.y;
        float width = mix(0.42, 0.03, pow(uv.y, 0.75));
        float dx = abs(uv.x - 0.5 + sway);
        float body = smoothstep(width, width * 0.25, dx);
        body *= smoothstep(1.0, 0.2, uv.y + (n2 - 0.5) * 0.55);
        body *= smoothstep(0.0, 0.05, uv.y);
        float heat = clamp(body * (1.25 - uv.y) + (n2 - 0.5) * 0.2, 0.0, 1.0);
        vec3 col = mix(vec3(0.9, 0.18, 0.02), vec3(1.0, 0.62, 0.15), smoothstep(0.15, 0.55, heat));
        col = mix(col, vec3(1.0, 0.95, 0.75), smoothstep(0.6, 0.95, heat));
        gl_FragColor = vec4(col * 2.2, clamp(body * 1.4, 0.0, 1.0));
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
  const bark = new MeshStandardMaterial({ map: buildBarkTexture(), roughness: 0.9 });
  const charred = new MeshStandardMaterial({ color: 0x1c1410, roughness: 1 });
  const stone = new MeshStandardMaterial({ color: 0x5a5856, roughness: 0.95 });
  // A teepee of logs over a charred core.
  const logs = scale > 0.6 ? 10 : 7;
  for (let i = 0; i < logs; i++) {
    const a = (i / logs) * Math.PI * 2;
    const log = new Mesh(
      new CylinderGeometry(0.2 * scale + 0.03, 0.28 * scale + 0.04, 4.6 * scale, 8),
      i % 2 ? bark : charred,
    );
    log.position.set(Math.cos(a) * 1.1 * scale, 1.8 * scale, Math.sin(a) * 1.1 * scale);
    // lean the tops in toward the centre
    log.rotation.set(-Math.sin(a) * 0.45, 0, Math.cos(a) * 0.45);
    log.castShadow = true;
    fire.add(log);
  }
  // Ring of stones.
  const stones = Math.round(14 + 12 * scale);
  for (let i = 0; i < stones; i++) {
    const a = (i / stones) * Math.PI * 2;
    const rock = new Mesh(new IcosahedronGeometry(0.2 + 0.18 * scale, 1), stone);
    rock.position.set(Math.cos(a) * 3.6 * scale, 0.12, Math.sin(a) * 3.6 * scale);
    rock.scale.set(1.2, 0.7, 1);
    rock.rotation.y = a * 3;
    fire.add(rock);
  }
  return fire;
}

function buildCampEdge(approachYaw: number): Group {
  const camp = new Group();
  camp.name = 'Camp';
  const bark = new MeshStandardMaterial({ map: buildBarkTexture(), roughness: 0.9 });
  // Log benches in a wide ring.
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.2;
    const bench = new Mesh(new CylinderGeometry(0.24, 0.24, 2.8, 10), bark);
    bench.position.set(Math.cos(a) * 10, 0.24, Math.sin(a) * 10);
    bench.rotation.set(0, -a, Math.PI / 2);
    bench.castShadow = true;
    bench.receiveShadow = true;
    camp.add(bench);
  }
  // Expedition tents around the edge (leaving the approach side open).
  const fabrics = [0xd8452b, 0xe8b13a, 0x2f6fb5, 0x3f9a5a, 0xb53f8f];
  for (let i = 0; i < 5; i++) {
    const a = approachYaw + 0.9 + (i / 4) * (Math.PI * 2 - 1.8);
    const tent = new Mesh(
      new ConeGeometry(1.7, 2.3, 4, 1),
      new MeshStandardMaterial({ color: fabrics[i], roughness: 0.75, side: DoubleSide }),
    );
    tent.position.set(Math.cos(a) * PARTY_RADIUS, 1.15, Math.sin(a) * PARTY_RADIUS);
    tent.rotation.y = a + Math.PI / 4;
    tent.castShadow = true;
    tent.receiveShadow = true;
    camp.add(tent);
  }
  return camp;
}

/** Strings of coloured bulbs swagged between poles around the party. */
function buildFestoonLights(): Group {
  const group = new Group();
  group.name = 'FestoonLights';
  const poleMat = new MeshStandardMaterial({ color: 0x3a2a1c, roughness: 0.9 });
  const wireMat = new MeshStandardMaterial({ color: 0x111111, roughness: 0.8 });
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
  for (let i = 0; i < poles; i++) {
    const ang = (i / poles) * Math.PI * 2;
    const pole = new Mesh(new CylinderGeometry(0.06, 0.08, height, 6), poleMat);
    pole.position.set(Math.cos(ang) * radius, height / 2, Math.sin(ang) * radius);
    pole.castShadow = true;
    group.add(pole);
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
      const seg = new Mesh(new CylinderGeometry(0.012, 0.012, 1, 4), wireMat);
      seg.matrixAutoUpdate = false;
      seg.matrix.copy(segmentMatrix(wirePts[j], wirePts[j + 1]));
      group.add(seg);
    }
  }
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
function buildDancer(jacket: number, hat: number, skin: number): { root: Group; arms: Mesh[] } {
  const root = new Group();
  const jacketMat = new MeshStandardMaterial({ color: jacket, roughness: 0.8 });
  const trousers = new MeshStandardMaterial({ color: 0x23262d, roughness: 0.9 });
  const skinMat = new MeshStandardMaterial({ color: skin, roughness: 0.7 });
  const hatMat = new MeshStandardMaterial({ color: hat, roughness: 0.9 });
  const legs = new Mesh(new CapsuleGeometry(0.16, 0.6, 4, 8), trousers);
  legs.position.y = 0.46;
  legs.scale.set(1.15, 1, 0.9);
  const body = new Mesh(new CapsuleGeometry(0.24, 0.5, 4, 10), jacketMat);
  body.position.y = 1.2;
  const head = new Mesh(new IcosahedronGeometry(0.13, 2), skinMat);
  head.position.y = 1.72;
  const beanie = new Mesh(new IcosahedronGeometry(0.135, 2), hatMat);
  beanie.position.y = 1.78;
  beanie.scale.set(1, 0.75, 1);
  const arms: Mesh[] = [];
  for (const side of [-1, 1]) {
    const arm = new Mesh(new CapsuleGeometry(0.07, 0.5, 4, 6), jacketMat);
    arm.geometry.translate(0, -0.3, 0); // pivot at the shoulder
    arm.position.set(side * 0.3, 1.45, 0);
    arms.push(arm);
    root.add(arm);
  }
  for (const part of [legs, body, head, beanie]) {
    part.castShadow = true;
    root.add(part);
  }
  return { root, arms };
}

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
      const jackets = [0xd8452b, 0x2f6fb5, 0xe8b13a, 0x3f9a5a, 0xb53f8f, 0xf06a2a, 0x22a3a3];
      const hats = [0xf2f2f2, 0xc9302c, 0x1d3b6e, 0xe0b23a, 0x2e2e2e];
      const skins = [0xf1c7a5, 0xd9a47a, 0xa86f4a, 0x7a4b2e, 0xe6b991];
      const count = 16;
      for (let i = 0; i < count; i++) {
        const ang = approach + 0.6 + (i / (count - 1)) * (Math.PI * 2 - 1.2);
        const r = 6.2 + (((i * 37) % 10) / 10) * 1.8;
        const { root, arms } = buildDancer(
          jackets[i % jackets.length],
          hats[i % hats.length],
          skins[i % skins.length],
        );
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
    const planes = scale > 0.6 ? 5 : 3;
    for (let i = 0; i < planes; i++) {
      const plane = new Mesh(new PlaneGeometry(7.5 * scale, this.flameHeight), flameMaterial(i * 0.37 + position.x));
      plane.position.y = this.flameHeight / 2 + 0.1 * scale;
      plane.rotation.y = (i / planes) * Math.PI;
      plane.scale.x = i % 2 ? 0.75 : 1;
      flames.add(plane);
    }
    place(flames);

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
      Math.round(90 * scale) + 20,
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
      (t) => Math.min(1, t * 5) * (1 - t) * 0.6,
      (t) => (2.2 + t * 16) * Math.sqrt(scale),
      new Color(0.16, 0.15, 0.15),
      false,
    );
    this.objects.push(this.smoke.points);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    for (const object of this.objects) object.visible = visible;
  }

  /** Returns the fire's audible level at the viewer (0..1). */
  update(dt: number, time: number, viewer: Vector3, flicker: number): number {
    if (!this.visible) return 0;
    const scale = this.options.scale;
    if (this.light) this.light.intensity = 3500 * scale * scale * flicker;
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
    (this.glow.material as SpriteMaterial).opacity = beacon * (0.8 + 0.2 * flicker);
    this.glow.scale.setScalar((12 + beacon * 18) * scale * (0.9 + 0.1 * flicker));
    return Math.pow(Math.max(0, 1 - dist / (90 * Math.max(0.4, scale))), 1.5);
  }
}

/** Every fire in the world; the campfire system animates them all. */
export const fires: Bonfire[] = [];

export class CampfireSystem extends createSystem({}) {
  private readonly head = new Vector3();

  init(): void {
    // The tutorial's party on the frozen lake.
    const party = new Bonfire(FIRE_POS, { scale: 1, party: true, light: true });
    this.addFire(party, sceneRefs.tutorialRoot ?? undefined);
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
    // Crackle and roar from the nearest fire.
    audio.setFire(level);
    if (level > 0.02 && Math.random() < dt * 14 * level) audio.crackle(level);
  }
}
