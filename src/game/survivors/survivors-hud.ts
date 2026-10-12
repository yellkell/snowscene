/**
 * Snow Survivors' heads-up display, built as things in the world rather
 * than panels floating in front of you:
 *
 * - Health and experience are two glowing rings on the snow round your
 *   feet (red inside, blue outside), filling clockwise from where you face.
 *   Glance down at your poles and they are there.
 * - Low on health, the edge of your view pulses red; a bite flashes it.
 * - Announcements (upgrades, combos, stampedes, bosses) are TITLE CARDS
 *   (title-card.ts): spaced capitals with a glow in the message's colour on
 *   a dark ribbon, a few metres ahead and high over the horde's heads where
 *   nothing hides them. They settle in, drift round to stay where you look,
 *   then lift away and fade. A headline can carry a smaller line under it.
 *   Big news (a boss, an evolution, the clock) cuts in; smaller news waits
 *   its turn.
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
import { PoleScreens } from './pole-screens.js';
import { duneHeight } from './survivors-level.js';
import { drawTitle } from './title-card.js';

export interface HudState {
  hp: number;
  maxHp: number;
  level: number;
  xp: number;
  xpNext: number;
  time: number;
  /** Seconds left in the run. */
  timeLeft: number;
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
const SIGN_CH = 320;
const SIGN_W = 4.8;
const SIGN_H = (SIGN_W * SIGN_CH) / SIGN_CW;
/** How far ahead the letters stand, and how far above your eyes their foot is. */
const SIGN_DIST = 8;
const SIGN_LIFT = 0.6;
/** Seconds to settle in, and to lift away. */
const RISE = 0.32;
const CRUMBLE = 0.4;
/** Lines waiting for the stage, at most. */
const QUEUE = 4;

interface Line {
  text: string;
  color: string;
  seconds: number;
  priority: number;
  sub: string;
}

export class SurvivorsHud {
  /** Everything world-placed (rings, letters, the pole screens). */
  readonly root = new Group();
  /** The red shell round your head (bites, low health). */
  readonly hurt: Mesh;

  private readonly hpRing = lightRing(0.42, 0.5, 0xff4d6d);
  private readonly xpRing = lightRing(0.56, 0.62, 0x4dc3ff);
  private readonly rings = new Group();
  private readonly bossRing = lightRing(0.86, 1, 0xff3048);

  private readonly signTex = canvasTexture(SIGN_CW, SIGN_CH);
  private readonly sign: Mesh;
  private signAge = 0;
  private signLife = 0;
  private signPriority = 0;
  private placeSign = false;
  private signYaw = 0;
  /** Bearing of the letters from you (yaw), eased round after your gaze. */
  private signBearing = 0;
  private readonly queue: Line[] = [];
  /** While true (an upgrade choice is up), lines wait. */
  held = false;

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
      // Drawn over everything: high above the horde, nothing should hide it.
      new MeshBasicMaterial({
        map: this.signTex.texture,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        toneMapped: false,
        side: DoubleSide,
      }),
    );
    this.sign.name = 'SurvivorsFrostLetters';
    this.sign.renderOrder = 38;
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

  /**
   * Frost letters: up into the air ahead of you, then crumbling to ice.
   * `priority` decides who waits: a line cuts in over one of the same or
   * lower priority, and otherwise queues behind it. `sub` is a smaller
   * second line under the headline.
   */
  announce(text: string, color: string, seconds = 3, priority = 1, sub = ''): void {
    const line: Line = { text, color, seconds, priority, sub };
    if (!this.held && (this.idle() || priority >= this.signPriority)) {
      this.show(line);
      return;
    }
    this.queue.push(line);
    // Keep the most important; among equals, the newest.
    this.queue.sort((x, y) => y.priority - x.priority);
    if (this.queue.length > QUEUE) this.queue.length = QUEUE;
  }

  private show(line: Line): void {
    drawTitle(this.signTex.ctx, SIGN_CW, SIGN_CH, line.text, line.sub, line.color);
    this.signTex.texture.needsUpdate = true;
    this.signLife = Math.max(line.seconds, RISE + CRUMBLE + 0.8);
    this.signAge = 0;
    this.signPriority = line.priority;
    this.placeSign = true;
  }

  /** Send whatever stands now away (an upgrade choice wants the stage). */
  clearSign(): void {
    if (this.signAge < this.signLife) this.signAge = Math.max(this.signAge, this.signLife - CRUMBLE);
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
    this.queue.length = 0;
    this.held = false;
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
    if (this.signAge >= this.signLife && this.queue.length > 0 && !this.held) this.show(this.queue.shift()!);
    if (this.signAge >= this.signLife) {
      mesh.visible = false;
      return;
    }
    const head = view.head;
    // Up where you are looking when it fires (a new line while the old one
    // still stands keeps its place), then eased round after your gaze.
    if (this.placeSign) {
      this.placeSign = false;
      let diff = view.yaw - this.signBearing;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      if (!mesh.visible || Math.abs(diff) > 0.5) this.signBearing = view.yaw;
    }
    let diff = view.yaw - this.signBearing;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    // Lazy: small glances leave it be, a real turn brings it round.
    const lag = Math.abs(diff) > 0.35 ? 3 : 0.6;
    this.signBearing += diff * Math.min(1, dt * lag);
    const x = head.x - Math.sin(this.signBearing) * SIGN_DIST;
    const z = head.z - Math.cos(this.signBearing) * SIGN_DIST;
    this.signAge += dt;
    mesh.visible = true;
    const material = mesh.material as MeshBasicMaterial;
    const left = this.signLife - this.signAge;
    let lift = 0;
    if (this.signAge < RISE) {
      // Settling in: down a touch from a little larger, fading up.
      const t = this.signAge / RISE;
      const e = 1 - Math.pow(1 - t, 3);
      const k = 1.12 - 0.12 * e;
      mesh.scale.set(k, k, 1);
      lift = 0.12 * (1 - e);
      material.opacity = e;
    } else if (left < CRUMBLE) {
      // Lifting away and fading, stretching a little wider as it goes.
      const t = 1 - left / CRUMBLE;
      const e = t * t;
      mesh.scale.set(1 + 0.06 * e, 1 - 0.05 * e, 1);
      lift = 0.3 * e;
      material.opacity = 1 - e;
    } else {
      mesh.scale.set(1, 1, 1);
      material.opacity = 1;
    }
    mesh.position.set(x, head.y + SIGN_LIFT + lift, z);
    // Upright, turned to face you, tipped back a touch (it is above you).
    this.signYaw = Math.atan2(head.x - x, head.z - z);
    mesh.rotation.set(0.14, this.signYaw, 0, 'YXZ');
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
