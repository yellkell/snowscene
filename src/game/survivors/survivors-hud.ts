/**
 * Snow Survivors' heads-up display, built as things in the world rather
 * than panels floating in front of you:
 *
 * - Health and experience are two glowing rings on the snow round your
 *   feet (red inside, blue outside), filling clockwise from where you face.
 *   Glance down at your poles and they are there.
 * - Low on health, the edge of your view pulses red; a bite flashes it.
 * - Announcements (upgrades, combos, stampedes, bosses) are FROST LETTERS:
 *   they burst up out of the snow a few steps ahead, stand there a moment,
 *   then crumble into ice.
 * - A boss has a red ring of light on the snow round it that drains as it
 *   takes damage (the same language as your own rings).
 * - The rest is built into the poles: a round screen in a steel pommel on
 *   top of each handle (health on the left, the run on the right; see
 *   pole-screens.ts). Glance down at your hands to read them.
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
import { sceneRefs } from '../scene-system.js';
import { PoleScreens } from './pole-screens.js';
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
  /** The boss on the field ('' for none), its health (0..1), where it stands and its radius. */
  boss: string;
  bossHp: number;
  bossX: number;
  bossZ: number;
  bossR: number;
}

/** What the system tells the HUD about you this frame. */
export interface HudView {
  head: Vector3;
  yaw: number;
  /** Unit vectors the eyes look along, and the head's up. */
  gaze: Vector3;
  up: Vector3;
  presenting: boolean;
}

// ---------------------------------------------------------- rings of light ---

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

function lightRing(inner: number, outer: number, color: number): Mesh {
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

function canvasTexture(cw: number, ch: number): { ctx: CanvasRenderingContext2D; texture: CanvasTexture } {
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return { ctx: canvas.getContext('2d')!, texture };
}

// -------------------------------------------------------- frost letters ---

const SIGN_CW = 1024;
const SIGN_CH = 280;
const SIGN_W = 7;
const SIGN_H = (SIGN_W * SIGN_CH) / SIGN_CW;
const SIGN_DIST = 6.5;
const RISE = 0.35;
const CRUMBLE = 0.4;

export class SurvivorsHud {
  /** Everything world-placed (rings, letters, the pole screens). */
  readonly root = new Group();
  /** The red shell round your head (bites, low health). */
  readonly hurt: Mesh;
  /** Called as frost letters crumble (x, y, z, width, facing yaw) so the system can burst ice. */
  onCrumble: ((x: number, y: number, z: number, width: number, yaw: number) => void) | null = null;

  private readonly hpRing = lightRing(0.42, 0.5, 0xff4d6d);
  private readonly xpRing = lightRing(0.56, 0.62, 0x4dc3ff);
  private readonly rings = new Group();
  private readonly bossRing = lightRing(0.86, 1, 0xff3048);

  private readonly signTex = canvasTexture(SIGN_CW, SIGN_CH);
  private readonly sign: Mesh;
  private signAge = 0;
  private signLife = 0;
  private placeSign = false;
  private crumbled = false;
  private signYaw = 0;

  private readonly poleScreens = new PoleScreens();

  private hurtLevel = 0;
  private xpFlash = 0;
  private lastLevel = 1;
  private clock = 0;
  private readonly tmp = new Vector3();

  constructor() {
    this.root.name = 'SurvivorsHud';
    this.root.visible = false;
    this.rings.add(this.hpRing, this.xpRing);
    this.rings.name = 'SurvivorsFootRings';
    this.root.add(this.rings);
    this.bossRing.name = 'SurvivorsBossRing';
    this.bossRing.visible = false;
    this.root.add(this.bossRing);

    this.sign = new Mesh(
      new PlaneGeometry(SIGN_W, SIGN_H).translate(0, SIGN_H / 2, 0),
      new MeshBasicMaterial({ map: this.signTex.texture, transparent: true, depthWrite: false, toneMapped: false, side: DoubleSide }),
    );
    this.sign.name = 'SurvivorsFrostLetters';
    this.sign.renderOrder = 30;
    this.sign.visible = false;
    this.root.add(this.sign);

    this.root.add(this.poleScreens.root);

    this.hurt = new Mesh(
      new SphereGeometry(0.25, 16, 12),
      new MeshBasicMaterial({ color: new Color(0.9, 0.02, 0.02), transparent: true, opacity: 0, side: BackSide, depthTest: false, depthWrite: false }),
    );
    this.hurt.renderOrder = 39;
    this.hurt.name = 'SurvivorsHurt';
    this.hurt.visible = false;
  }

  /** Frost letters: up out of the snow ahead of you, then crumbling to ice. */
  announce(text: string, color: string, seconds = 3): void {
    const ctx = this.signTex.ctx;
    ctx.clearRect(0, 0, SIGN_CW, SIGN_CH);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    // Long lines break in two at the space nearest the middle.
    const lines = [text];
    if (text.length > 24) {
      let best = -1;
      for (let i = 0; i < text.length; i++) {
        if (text[i] === ' ' && (best < 0 || Math.abs(i - text.length / 2) < Math.abs(best - text.length / 2))) best = i;
      }
      if (best > 0) lines.splice(0, 1, text.slice(0, best), text.slice(best + 1));
    }
    let size = lines.length > 1 ? 112 : 128;
    const widest = () => Math.max(...lines.map((l) => ctx.measureText(l).width));
    ctx.font = `900 ${size}px system-ui, sans-serif`;
    while (widest() > SIGN_CW - 50 && size > 40) {
      size -= 4;
      ctx.font = `900 ${size}px system-ui, sans-serif`;
    }
    ctx.lineJoin = 'round';
    const lineH = size * 1.08;
    lines.forEach((line, n) => {
      const base = SIGN_CH - 24 - (lines.length - 1 - n) * lineH;
      // A dark rim, the message's colour as a glow line inside it, then
      // ice: white at the top shading to pale blue.
      ctx.lineWidth = Math.max(10, size * 0.18);
      ctx.strokeStyle = 'rgba(14, 30, 64, 0.9)';
      ctx.strokeText(line, SIGN_CW / 2, base);
      ctx.lineWidth = Math.max(4, size * 0.07);
      ctx.strokeStyle = color;
      ctx.strokeText(line, SIGN_CW / 2, base);
      const ice = ctx.createLinearGradient(0, base - size, 0, base);
      ice.addColorStop(0, '#ffffff');
      ice.addColorStop(0.55, '#e6f6ff');
      ice.addColorStop(1, '#9fd2f2');
      ctx.fillStyle = ice;
      ctx.fillText(line, SIGN_CW / 2, base);
      // Frost glints on the letters.
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      const w = ctx.measureText(line).width;
      for (let k = 0; k < 12; k++) ctx.fillRect(SIGN_CW / 2 - w / 2 + Math.random() * w, base - Math.random() * size * 0.7, 3, 3);
    });
    this.signTex.texture.needsUpdate = true;
    this.signLife = Math.max(seconds, RISE + CRUMBLE + 0.6);
    this.signAge = 0;
    this.crumbled = false;
    this.placeSign = true;
  }

  bitten(amount: number): void {
    this.hurtLevel = Math.min(0.45, this.hurtLevel + amount);
  }

  /** No letters standing (so a hint can have the stage). */
  idle(): boolean {
    return this.signAge >= this.signLife;
  }

  hide(): void {
    this.root.visible = false;
    this.hurt.visible = false;
    this.hurtLevel = 0;
    this.signAge = this.signLife = 0;
    this.sign.visible = false;
    this.poleScreens.hide();
    this.lastLevel = 1;
  }

  update(dt: number, view: HudView, state: HudState): void {
    this.root.visible = true;
    this.clock += dt;
    const head = view.head;
    this.updateRings(dt, head, view.yaw, state);
    this.updateSign(dt, view);
    this.poleScreens.update(dt, head, view.up, view.yaw, view.presenting, state);
    this.updateBossRing(head, state);

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

  private updateSign(dt: number, view: HudView): void {
    const mesh = this.sign;
    if (this.signAge >= this.signLife) {
      mesh.visible = false;
      return;
    }
    const head = view.head;
    // Planted where you are looking when it fires; a new line while you
    // still face the old spot comes up in the same place.
    if (this.placeSign) {
      this.placeSign = false;
      const fx = -Math.sin(view.yaw);
      const fz = -Math.cos(view.yaw);
      const dx = mesh.position.x - head.x;
      const dz = mesh.position.z - head.z;
      const d = Math.hypot(dx, dz) || 1;
      const facing = mesh.visible ? (dx * fx + dz * fz) / d : -1;
      if (facing < 0.85 || d < 3) {
        const x = head.x + fx * SIGN_DIST;
        const z = head.z + fz * SIGN_DIST;
        mesh.position.set(x, duneHeight(x, z) - 0.04, z);
      }
      this.tmp.set(mesh.position.x, mesh.position.y + 0.05, mesh.position.z);
      sceneRefs.puffs?.emit(this.tmp, 14, 1.6);
    }
    this.signAge += dt;
    mesh.visible = true;
    // Upright, turned to face you.
    this.signYaw = Math.atan2(head.x - mesh.position.x, head.z - mesh.position.z);
    mesh.rotation.set(0, this.signYaw, 0);
    const material = mesh.material as MeshBasicMaterial;
    const left = this.signLife - this.signAge;
    if (this.signAge < RISE) {
      // Bursting up out of the snow, overshooting a little.
      const t = this.signAge / RISE;
      const back = 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);
      mesh.scale.set(1, Math.max(0.01, back), 1);
      material.opacity = Math.min(1, t * 3);
    } else if (left < CRUMBLE) {
      if (!this.crumbled) {
        this.crumbled = true;
        this.onCrumble?.(mesh.position.x, mesh.position.y + SIGN_H * 0.45, mesh.position.z, SIGN_W * 0.8, this.signYaw);
      }
      const t = 1 - left / CRUMBLE;
      mesh.scale.set(1, Math.max(0.01, 1 - t * t), 1);
      material.opacity = 1 - t;
    } else {
      mesh.scale.set(1, 1, 1);
      material.opacity = 1;
    }
  }

  /** A boss's health: a red ring of light on the snow round it, draining clockwise. */
  private updateBossRing(head: Vector3, s: HudState): void {
    const ring = this.bossRing;
    ring.visible = !!s.boss;
    if (!s.boss) return;
    ring.position.set(s.bossX, duneHeight(s.bossX, s.bossZ) + 0.06, s.bossZ);
    ring.scale.setScalar(s.bossR * 1.45);
    // Full end of the ring toward you, so you see it drain.
    ring.rotation.y = Math.atan2(s.bossX - head.x, s.bossZ - head.z);
    (ring.material as ShaderMaterial).uniforms.uFrac.value = Math.max(0, Math.min(1, s.bossHp));
  }
}
