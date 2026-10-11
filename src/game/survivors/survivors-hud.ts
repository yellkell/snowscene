/**
 * Snow Survivors' heads-up display, with nothing parked in front of your
 * face:
 *
 * - Health and experience are two glowing rings on the snow round your
 *   feet (red inside, blue outside), filling clockwise from where you face.
 *   Glance down at your poles and they are there.
 * - Low on health, the edge of your view pulses red; a bite flashes it.
 * - Announcements (upgrades, combos, stampedes, bosses) are big words that
 *   appear in the world a few metres ahead, drift up and fade.
 * - A boss carries its own health bar over its head.
 * - The rest (clock, kills, level, combo, speed bonus, your weapons) is on
 *   a watch on your LEFT wrist: turn the inside of the wrist toward your
 *   face and look at it (hand open). On a desktop it sits small in the
 *   corner of the view.
 */

import {
  BackSide,
  CanvasTexture,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  RingGeometry,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
} from '@iwsdk/core';
import { hands } from '../hand-input.js';
import { duneHeight } from './survivors-level.js';

export interface HudState {
  hp: number;
  maxHp: number;
  level: number;
  xp: number;
  xpNext: number;
  time: number;
  kills: number;
  weapons: string;
  /** Kills in the current streak, and how much of its window is left (0..1). */
  combo: number;
  comboLeft: number;
  /** Damage multiplier from your speed (1 = standing still). */
  speedMul: number;
  /** The boss on the field ('' for none), its health (0..1) and where its head is. */
  boss: string;
  bossHp: number;
  bossX: number;
  bossY: number;
  bossZ: number;
}

/** What the system tells the HUD about you this frame. */
export interface HudView {
  head: Vector3;
  yaw: number;
  /** Unit vector the eyes look along. */
  gaze: Vector3;
  presenting: boolean;
}

// ----------------------------------------------------------- foot rings ---

const RING_VERT = /* glsl */ `
varying vec2 vP;
void main() {
  vP = position.xz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const RING_FRAG = /* glsl */ `
uniform float uFrac;
uniform vec3 uColor;
uniform float uFlash;
uniform float uAlpha;
varying vec2 vP;
void main() {
  // 0 straight ahead (-z), growing clockwise seen from above.
  float a = atan(vP.x, -vP.y) / 6.28318;
  if (a < 0.0) a += 1.0;
  float on = step(a, uFrac);
  vec3 col = mix(vec3(0.75, 0.82, 0.95), uColor, on);
  col = mix(col, vec3(1.0), uFlash);
  gl_FragColor = vec4(col, uAlpha * mix(0.18, 0.95, max(on, uFlash)));
}
`;

function footRing(inner: number, outer: number, color: number): Mesh {
  const mesh = new Mesh(
    new RingGeometry(inner, outer, 72).rotateX(-Math.PI / 2),
    new ShaderMaterial({
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      uniforms: {
        uFrac: { value: 0 },
        uColor: { value: new Color(color) },
        uFlash: { value: 0 },
        uAlpha: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
  );
  mesh.renderOrder = 5;
  return mesh;
}

function canvasPlane(w: number, h: number, cw: number, ch: number): { mesh: Mesh; ctx: CanvasRenderingContext2D; texture: CanvasTexture } {
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d')!;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const mesh = new Mesh(
    new PlaneGeometry(w, h),
    new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false, fog: false }),
  );
  return { mesh, ctx, texture };
}

// ---------------------------------------------------------------- wrist ---

const WATCH_W = 0.12;
const WATCH_H = 0.075;
const WATCH_CW = 512;
const WATCH_CH = 320;
const OPEN_FACING = 0.6;
const STAY_FACING = 0.35;
const OPEN_GAZE_COS = Math.cos((28 * Math.PI) / 180);
const STAY_GAZE_COS = Math.cos((42 * Math.PI) / 180);
const PACK_UP = 0.6;

// --------------------------------------------------------------- banner ---

const BANNER_CW = 1024;
const BANNER_CH = 160;
const BANNER_W = 2.6;
const BANNER_DIST = 3.0;

export class SurvivorsHud {
  /** Everything world-placed (rings, banner, watch, boss bar). */
  readonly root = new Group();
  /** The red shell round your head (bites, low health). */
  readonly hurt: Mesh;

  private readonly hpRing = footRing(0.42, 0.5, 0xff4d6d);
  private readonly xpRing = footRing(0.56, 0.62, 0x4dc3ff);
  private readonly rings = new Group();

  private readonly banner = canvasPlane(BANNER_W, (BANNER_W * BANNER_CH) / BANNER_CW, BANNER_CW, BANNER_CH);
  private bannerAge = 0;
  private bannerLife = 0;
  private placeBanner = false;

  private readonly watch = canvasPlane(WATCH_W, WATCH_H, WATCH_CW, WATCH_CH);
  private watchShown = false;
  private watchScale = 0;
  private poseFor = 0;
  private lostFor = 0;
  private watchRedraw = 0;

  private readonly bossBar = canvasPlane(4, 0.5, 512, 64);
  private bossKey = '';

  private hurtLevel = 0;
  private xpFlash = 0;
  private lastLevel = 1;
  private clock = 0;
  private readonly toHand = new Vector3();
  private readonly toHead = new Vector3();
  private readonly wristDir = new Vector3();

  constructor() {
    this.root.name = 'SurvivorsHud';
    this.root.visible = false;
    this.rings.add(this.hpRing, this.xpRing);
    this.rings.name = 'SurvivorsFootRings';
    this.root.add(this.rings);
    this.banner.mesh.name = 'SurvivorsBanner';
    this.banner.mesh.renderOrder = 40;
    this.banner.mesh.visible = false;
    this.root.add(this.banner.mesh);
    this.watch.mesh.name = 'SurvivorsWatch';
    this.watch.mesh.renderOrder = 41;
    (this.watch.mesh.material as MeshBasicMaterial).depthTest = false;
    this.watch.mesh.visible = false;
    this.root.add(this.watch.mesh);
    this.bossBar.mesh.name = 'SurvivorsBossBar';
    this.bossBar.mesh.renderOrder = 39;
    this.bossBar.mesh.visible = false;
    this.root.add(this.bossBar.mesh);
    this.hurt = new Mesh(
      new SphereGeometry(0.25, 16, 12),
      new MeshBasicMaterial({ color: new Color(0.9, 0.02, 0.02), transparent: true, opacity: 0, side: BackSide, depthTest: false, depthWrite: false }),
    );
    this.hurt.renderOrder = 39;
    this.hurt.name = 'SurvivorsHurt';
    this.hurt.visible = false;
  }

  /** Words in the world ahead of you, drifting up and fading. */
  announce(text: string, color: string, seconds = 3): void {
    const ctx = this.banner.ctx;
    ctx.clearRect(0, 0, BANNER_CW, BANNER_CH);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let size = 76;
    ctx.font = `900 ${size}px system-ui, sans-serif`;
    while (ctx.measureText(text).width > BANNER_CW - 60 && size > 30) {
      size -= 4;
      ctx.font = `900 ${size}px system-ui, sans-serif`;
    }
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(8, size * 0.16);
    ctx.strokeStyle = 'rgba(6, 10, 22, 0.85)';
    ctx.strokeText(text, BANNER_CW / 2, BANNER_CH / 2);
    ctx.fillStyle = color;
    ctx.fillText(text, BANNER_CW / 2, BANNER_CH / 2);
    this.banner.texture.needsUpdate = true;
    this.bannerLife = seconds;
    this.bannerAge = 0;
    this.placeBanner = true;
  }

  bitten(amount: number): void {
    this.hurtLevel = Math.min(0.45, this.hurtLevel + amount);
  }

  /** No announcement showing (so a hint can have the stage). */
  idle(): boolean {
    return this.bannerAge >= this.bannerLife;
  }

  hide(): void {
    this.root.visible = false;
    this.hurt.visible = false;
    this.hurtLevel = 0;
    this.bannerAge = this.bannerLife = 0;
    this.banner.mesh.visible = false;
    this.watchShown = false;
    this.watchScale = 0;
    this.lastLevel = 1;
  }

  update(dt: number, view: HudView, state: HudState): void {
    this.root.visible = true;
    this.clock += dt;
    const head = view.head;
    this.updateRings(dt, head, view.yaw, state);
    this.updateBanner(dt, view);
    this.updateWatch(dt, view, state);
    this.updateBossBar(head, state);

    // Red at the edge of sight: a bite flashes it; low health pulses it.
    this.hurtLevel = Math.max(0, this.hurtLevel - dt * 0.9);
    const f = state.hp / state.maxHp;
    const low = f < 0.35 ? ((0.35 - f) / 0.35) * 0.28 * (0.6 + 0.4 * Math.sin(this.clock * 6)) : 0;
    const red = Math.max(this.hurtLevel, low);
    this.hurt.visible = red > 0.01;
    this.hurt.position.copy(head);
    (this.hurt.material as MeshBasicMaterial).opacity = red;
  }

  private updateRings(dt: number, head: Vector3, yaw: number, s: HudState): void {
    this.rings.position.set(head.x, duneHeight(head.x, head.z) + 0.04, head.z);
    this.rings.rotation.y = yaw;
    if (s.level > this.lastLevel) this.xpFlash = 1;
    this.lastLevel = s.level;
    this.xpFlash = Math.max(0, this.xpFlash - dt * 2.5);
    const hp = (this.hpRing.material as ShaderMaterial).uniforms;
    hp.uFrac.value = Math.max(0, Math.min(1, s.hp / s.maxHp));
    hp.uFlash.value = this.hurtLevel > 0.2 ? 0.25 : 0;
    const xp = (this.xpRing.material as ShaderMaterial).uniforms;
    xp.uFrac.value = Math.max(0, Math.min(1, s.xp / s.xpNext));
    xp.uFlash.value = this.xpFlash;
  }

  private updateBanner(dt: number, view: HudView): void {
    const mesh = this.banner.mesh;
    if (this.bannerAge >= this.bannerLife) {
      mesh.visible = false;
      return;
    }
    const head = view.head;
    // Placed out in the world where you are looking when it fires; a new
    // line while you still face the old spot reuses it.
    if (this.placeBanner) {
      this.placeBanner = false;
      const fx = -Math.sin(view.yaw);
      const fz = -Math.cos(view.yaw);
      const dx = mesh.position.x - head.x;
      const dz = mesh.position.z - head.z;
      const d = Math.hypot(dx, dz) || 1;
      const facing = mesh.visible ? (dx * fx + dz * fz) / d : -1;
      if (facing < 0.85) mesh.position.set(head.x + fx * BANNER_DIST, head.y + 0.45, head.z + fz * BANNER_DIST);
    }
    this.bannerAge += dt;
    mesh.visible = true;
    mesh.position.y += dt * 0.08;
    mesh.lookAt(head);
    const fadeIn = Math.min(1, this.bannerAge / 0.15);
    const fadeOut = Math.min(1, (this.bannerLife - this.bannerAge) / 0.6);
    const pop = 1 + 0.15 * Math.max(0, 1 - this.bannerAge / 0.2);
    mesh.scale.setScalar(pop);
    (mesh.material as MeshBasicMaterial).opacity = Math.max(0, Math.min(fadeIn, fadeOut));
  }

  /** The left-wrist watch (or the desktop corner readout). */
  private updateWatch(dt: number, view: HudView, s: HudState): void {
    const mesh = this.watch.mesh;
    let want: boolean;
    if (view.presenting) {
      const h = hands.left;
      this.toHand.subVectors(h.position, view.head).normalize();
      this.toHead.copy(this.toHand).negate();
      const facing = h.palmNormal.dot(this.toHead);
      const look = view.gaze.dot(this.toHand);
      const ok = h.tracked && !h.grip && h.palmNormal.y < PACK_UP;
      const holding = this.watchShown
        ? ok && facing > STAY_FACING && look > STAY_GAZE_COS
        : ok && facing > OPEN_FACING && look > OPEN_GAZE_COS;
      if (holding) {
        this.poseFor += dt;
        this.lostFor = 0;
      } else {
        this.lostFor += dt;
        this.poseFor = 0;
      }
      want = this.watchShown ? this.lostFor < 0.35 : this.poseFor >= 0.12;
    } else {
      want = true;
    }
    this.watchShown = want;
    this.watchScale = Math.min(1, Math.max(0, this.watchScale + (want ? dt : -dt) / 0.12));
    mesh.visible = this.watchScale > 0;
    if (!mesh.visible) return;
    const head = view.head;
    if (view.presenting) {
      const h = hands.left;
      this.wristDir.subVectors(h.position, h.indexTip);
      const len = this.wristDir.length();
      if (len > 1e-4) this.wristDir.multiplyScalar(1 / len);
      mesh.position.copy(h.position).addScaledVector(this.wristDir, 0.06).addScaledVector(h.palmNormal, 0.025);
      mesh.scale.setScalar(Math.max(0.001, this.watchScale));
    } else {
      // Small, low in the left corner of the view.
      const fx = -Math.sin(view.yaw);
      const fz = -Math.cos(view.yaw);
      mesh.position.set(head.x + fx * 0.36 + fz * 0.17, head.y - 0.15, head.z + fz * 0.36 - fx * 0.17);
      mesh.scale.setScalar(1.15);
    }
    mesh.lookAt(head);
    this.watchRedraw -= dt;
    if (this.watchRedraw > 0) return;
    this.watchRedraw = 0.2;
    this.drawWatch(s);
  }

  private drawWatch(s: HudState): void {
    const ctx = this.watch.ctx;
    const W = WATCH_CW;
    const H = WATCH_CH;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(10, 16, 30, 0.9)';
    ctx.beginPath();
    ctx.roundRect(4, 4, W - 8, H - 8, 40);
    ctx.fill();
    ctx.strokeStyle = 'rgba(160, 180, 210, 0.6)';
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.textBaseline = 'middle';
    // Clock and kills.
    const mm = Math.floor(s.time / 60);
    const ss = Math.floor(s.time % 60);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 72px system-ui, sans-serif';
    ctx.fillText(`${mm}:${ss.toString().padStart(2, '0')}`, 32, 66);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ffd166';
    ctx.font = '800 48px system-ui, sans-serif';
    ctx.fillText(`${s.kills.toLocaleString()}`, W - 32, 56);
    ctx.font = '600 22px system-ui, sans-serif';
    ctx.fillText('KILLS', W - 32, 94);
    // Level (with the XP fill) and health.
    const bar = (y: number, frac: number, color: string, label: string) => {
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.beginPath();
      ctx.roundRect(32, y, W - 64, 34, 17);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(32, y, Math.max(34, (W - 64) * Math.max(0, Math.min(1, frac))), 34, 17);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.font = '700 22px system-ui, sans-serif';
      ctx.fillText(label, 48, y + 18);
    };
    bar(124, s.hp / s.maxHp, s.hp / s.maxHp < 0.3 ? '#ff3b4e' : '#ff6b81', `${Math.ceil(s.hp)} / ${Math.round(s.maxHp)}`);
    bar(168, s.xp / s.xpNext, '#4dc3ff', `LEVEL ${s.level}`);
    // Combo and speed.
    ctx.font = '800 30px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = s.combo >= 10 ? (s.combo >= 500 ? '#ff6b6b' : '#ffb347') : 'rgba(200,215,235,0.5)';
    ctx.fillText(s.combo >= 10 ? `${s.combo.toLocaleString()} COMBO` : 'NO COMBO', 32, 236);
    ctx.textAlign = 'right';
    ctx.fillStyle = s.speedMul >= 1.05 ? '#7fe9ff' : 'rgba(200,215,235,0.5)';
    ctx.fillText(`SPEED ×${s.speedMul.toFixed(1)}`, W - 32, 236);
    // Weapons, small.
    ctx.textAlign = 'center';
    ctx.fillStyle = '#c9d6ee';
    let size = 22;
    ctx.font = `600 ${size}px system-ui, sans-serif`;
    while (ctx.measureText(s.weapons).width > W - 56 && size > 13) {
      size -= 1;
      ctx.font = `600 ${size}px system-ui, sans-serif`;
    }
    ctx.fillText(s.weapons, W / 2, 284);
    this.watch.texture.needsUpdate = true;
  }

  /** A boss's own health bar, floating over its head and facing you. */
  private updateBossBar(head: Vector3, s: HudState): void {
    const mesh = this.bossBar.mesh;
    mesh.visible = !!s.boss;
    if (!s.boss) {
      this.bossKey = '';
      return;
    }
    mesh.position.set(s.bossX, s.bossY, s.bossZ);
    mesh.lookAt(head);
    const key = `${s.boss}|${Math.round(s.bossHp * 200)}`;
    if (key === this.bossKey) return;
    this.bossKey = key;
    const ctx = this.bossBar.ctx;
    ctx.clearRect(0, 0, 512, 64);
    ctx.fillStyle = 'rgba(30, 6, 12, 0.85)';
    ctx.beginPath();
    ctx.roundRect(2, 2, 508, 60, 18);
    ctx.fill();
    ctx.fillStyle = '#ff4d6d';
    ctx.beginPath();
    ctx.roundRect(8, 8, Math.max(16, 496 * Math.max(0, Math.min(1, s.bossHp))), 48, 14);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '800 26px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(s.boss, 256, 33);
    this.bossBar.texture.needsUpdate = true;
  }
}
