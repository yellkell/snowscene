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
 * - The rest (clock, kills, level, combo, speed bonus) is on the SURVIVOR'S
 *   BRACER strapped to your left wrist: a padded cuff with brass rims and a
 *   little steel-cased screen on the inside of the wrist. It is always
 *   there; turn the inside of the wrist toward your face (hand open) and
 *   look at it, and the screen lights up. On a desktop the bracer hangs low
 *   in the corner of the view.
 */

import {
  BackSide,
  BoxGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  Vector3,
} from '@iwsdk/core';
import { hands } from '../hand-input.js';
import { sceneRefs } from '../scene-system.js';
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
  /** Unit vector the eyes look along. */
  gaze: Vector3;
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

// --------------------------------------------------------------- bracer ---

/** The wrist, in the left grip's frame: behind the hand, along +Z. */
const WRIST_Z = 0.08;
const CUFF_R = 0.036;
/** The screen, on the inside of the wrist (+X is out of the left palm). */
const SCREEN_W = 0.04;
const SCREEN_H = 0.054;
const SCREEN_CW = 320;
const SCREEN_CH = 432;
const OPEN_FACING = 0.55;
const STAY_FACING = 0.3;
const OPEN_GAZE_COS = Math.cos((30 * Math.PI) / 180);
const STAY_GAZE_COS = Math.cos((45 * Math.PI) / 180);
const PACK_UP = 0.6;

/**
 * The Survivor's Bracer, in the left grip's local frame (-Z toward the
 * fingers, +X out of the palm): a padded cuff round the wrist with a brass
 * rim at each end, a steel case on the inside of the wrist with the screen
 * set into it, and a status light at the finger end.
 */
function buildBracer(screenMap: CanvasTexture): { group: Group; screen: Mesh; led: Mesh } {
  const group = new Group();
  group.name = 'SurvivorsBracer';
  const cloth = new MeshStandardMaterial({ color: 0x2a3550, roughness: 0.95, metalness: 0 });
  const brass = new MeshStandardMaterial({ color: 0xc9a04a, roughness: 0.35, metalness: 0.75 });
  const steel = new MeshStandardMaterial({ color: 0x8d99aa, roughness: 0.4, metalness: 0.6 });

  const cuff = new Mesh(new CylinderGeometry(CUFF_R, CUFF_R * 1.08, 0.075, 18, 1, true).rotateX(Math.PI / 2), cloth);
  (cuff.material as MeshStandardMaterial).side = DoubleSide;
  cuff.position.z = WRIST_Z;
  group.add(cuff);
  for (const dz of [-0.036, 0.036]) {
    const rim = new Mesh(new TorusGeometry(CUFF_R * (dz < 0 ? 1.02 : 1.1), 0.0035, 6, 24), brass);
    rim.position.z = WRIST_Z + dz;
    group.add(rim);
  }
  // A couple of stitched straps across the cuff, on the back of the wrist.
  for (const dz of [-0.016, 0.016]) {
    const strap = new Mesh(new BoxGeometry(0.004, 0.022, 0.009), brass);
    strap.position.set(-CUFF_R - 0.002, 0, WRIST_Z + dz);
    group.add(strap);
  }

  // The case: a steel block on the inside of the wrist, a brass bezel, the screen.
  const caseMesh = new Mesh(new BoxGeometry(0.012, SCREEN_W + 0.012, SCREEN_H + 0.014), steel);
  caseMesh.position.set(CUFF_R + 0.004, 0, WRIST_Z);
  group.add(caseMesh);
  const bezelT = 0.003;
  const bx = CUFF_R + 0.0105;
  for (const [y, z, h, d] of [
    [(SCREEN_W + bezelT) / 2, 0, bezelT, SCREEN_H + bezelT * 2],
    [-(SCREEN_W + bezelT) / 2, 0, bezelT, SCREEN_H + bezelT * 2],
    [0, (SCREEN_H + bezelT) / 2, SCREEN_W, bezelT],
    [0, -(SCREEN_H + bezelT) / 2, SCREEN_W, bezelT],
  ] as const) {
    const edge = new Mesh(new BoxGeometry(0.003, h, d), brass);
    edge.position.set(bx, y, WRIST_Z + z);
    group.add(edge);
  }
  // The screen faces +X; its "up" is toward the fingers (-Z) and its right
  // is -Y, so it reads upright when you turn the inside of the wrist to you.
  const screen = new Mesh(
    new PlaneGeometry(SCREEN_W, SCREEN_H).applyMatrix4(
      new Matrix4().makeBasis(new Vector3(0, -1, 0), new Vector3(0, 0, -1), new Vector3(1, 0, 0)),
    ),
    new MeshBasicMaterial({ map: screenMap, toneMapped: false }),
  );
  screen.position.set(bx + 0.0005, 0, WRIST_Z);
  group.add(screen);
  const led = new Mesh(new SphereGeometry(0.0028, 8, 6), new MeshBasicMaterial({ color: 0x66ff99, toneMapped: false }));
  led.position.set(CUFF_R + 0.0095, 0, WRIST_Z - SCREEN_H / 2 - 0.0085);
  group.add(led);
  return { group, screen, led };
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
  /** Everything world-placed (rings, letters, bracer). */
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

  private readonly screenTex = canvasTexture(SCREEN_CW, SCREEN_CH);
  private readonly bracer: Group;
  private readonly screen: Mesh;
  private readonly led: Mesh;
  private lit = false;
  private glow = 0;
  private poseFor = 0;
  private lostFor = 0;
  private screenRedraw = 0;

  private hurtLevel = 0;
  private xpFlash = 0;
  private lastLevel = 1;
  private clock = 0;
  private readonly toHand = new Vector3();
  private readonly toHead = new Vector3();
  private readonly bx = new Vector3();
  private readonly by = new Vector3();
  private readonly bz = new Vector3();
  private readonly basis = new Matrix4();
  private readonly q = new Quaternion();
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

    const bracer = buildBracer(this.screenTex.texture);
    this.bracer = bracer.group;
    this.screen = bracer.screen;
    this.led = bracer.led;
    this.bracer.visible = false;
    this.root.add(this.bracer);

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
    this.lit = false;
    this.glow = 0;
    this.lastLevel = 1;
  }

  update(dt: number, view: HudView, state: HudState): void {
    this.root.visible = true;
    this.clock += dt;
    const head = view.head;
    this.updateRings(dt, head, view.yaw, state);
    this.updateSign(dt, view);
    this.updateBracer(dt, view, state);
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

  /** The bracer on the left wrist (or hanging in the desktop view's corner). */
  private updateBracer(dt: number, view: HudView, s: HudState): void {
    const g = this.bracer;
    const head = view.head;
    const h = hands.left;
    let look = false;
    if (view.presenting) {
      g.visible = h.tracked;
      if (!g.visible) return;
      g.position.copy(h.position);
      g.quaternion.copy(h.quaternion);
      // Lit while you turn the inside of the wrist to your face and look at it.
      this.toHand.subVectors(h.position, head).normalize();
      this.toHead.copy(this.toHand).negate();
      const facing = h.palmNormal.dot(this.toHead);
      const gaze = view.gaze.dot(this.toHand);
      const ok = !h.grip && h.palmNormal.y < PACK_UP;
      const holding = this.lit ? ok && facing > STAY_FACING && gaze > STAY_GAZE_COS : ok && facing > OPEN_FACING && gaze > OPEN_GAZE_COS;
      if (holding) {
        this.poseFor += dt;
        this.lostFor = 0;
      } else {
        this.lostFor += dt;
        this.poseFor = 0;
      }
      look = this.lit ? this.lostFor < 0.35 : this.poseFor >= 0.1;
    } else {
      // Desktop: low in the left corner, screen turned to the eyes.
      g.visible = true;
      const fx = -Math.sin(view.yaw);
      const fz = -Math.cos(view.yaw);
      g.position.set(head.x + fx * 0.3 + fz * 0.14, head.y - 0.14, head.z + fz * 0.3 - fx * 0.14);
      // Grip +X (the screen) toward the eyes, grip -Z (toward the fingers) up.
      this.bx.subVectors(head, g.position).normalize();
      this.bz.set(0, -1, 0).addScaledVector(this.bx, this.bx.y).normalize();
      this.by.crossVectors(this.bz, this.bx);
      this.basis.makeBasis(this.bx, this.by, this.bz);
      g.quaternion.setFromRotationMatrix(this.basis);
      // Shift so the screen (not the grip) sits at that spot, and enlarge it.
      this.tmp.set(0, 0, WRIST_Z).applyQuaternion(g.quaternion);
      g.position.sub(this.tmp);
      look = true;
    }
    this.lit = look;
    this.glow += ((look ? 1 : 0.22) - this.glow) * Math.min(1, dt * 10);
    (this.screen.material as MeshBasicMaterial).color.setScalar(this.glow);
    // Status light: green when healthy, amber, then a red blink.
    const f = s.hp / s.maxHp;
    const led = (this.led.material as MeshBasicMaterial).color;
    if (f > 0.6) led.setRGB(0.3, 1.4, 0.6);
    else if (f > 0.3) led.setRGB(1.5, 0.9, 0.2);
    else led.setRGB(Math.sin(this.clock * 10) > 0 ? 1.8 : 0.3, 0.1, 0.1);
    this.screenRedraw -= dt;
    if (this.screenRedraw > 0) return;
    this.screenRedraw = look ? 0.2 : 0.6;
    this.drawScreen(s);
  }

  private drawScreen(s: HudState): void {
    const ctx = this.screenTex.ctx;
    const W = SCREEN_CW;
    const H = SCREEN_CH;
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#16233a');
    bg.addColorStop(1, '#0a111f');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    // Clock.
    const mm = Math.floor(s.time / 60);
    const ss = Math.floor(s.time % 60);
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 76px system-ui, sans-serif';
    ctx.fillText(`${mm}:${ss.toString().padStart(2, '0')}`, W / 2, 58);
    // Kills.
    ctx.fillStyle = '#ffd166';
    ctx.font = '800 46px system-ui, sans-serif';
    ctx.fillText(s.kills.toLocaleString(), W / 2, 124);
    ctx.font = '700 18px system-ui, sans-serif';
    ctx.fillText('KILLS', W / 2, 156);
    // Health and level bars.
    const bar = (y: number, frac: number, color: string, label: string) => {
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.beginPath();
      ctx.roundRect(22, y, W - 44, 40, 20);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(22, y, Math.max(40, (W - 44) * Math.max(0, Math.min(1, frac))), 40, 20);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '800 24px system-ui, sans-serif';
      ctx.fillText(label, W / 2, y + 21);
    };
    bar(184, s.hp / s.maxHp, s.hp / s.maxHp < 0.3 ? '#ff3b4e' : '#ff6b81', `${Math.ceil(s.hp)} / ${Math.round(s.maxHp)}`);
    bar(236, s.xp / s.xpNext, '#4dc3ff', `LEVEL ${s.level}`);
    // Combo and speed.
    ctx.font = '800 34px system-ui, sans-serif';
    ctx.fillStyle = s.combo >= 10 ? (s.combo >= 500 ? '#ff6b6b' : '#ffb347') : 'rgba(200,215,235,0.45)';
    ctx.fillText(s.combo >= 10 ? `${s.combo.toLocaleString()} COMBO` : 'NO COMBO', W / 2, 318);
    ctx.fillStyle = s.speedMul >= 1.05 ? '#7fe9ff' : 'rgba(200,215,235,0.45)';
    ctx.fillText(`SPEED ×${s.speedMul.toFixed(1)}`, W / 2, 372);
    // Scanline sheen, so it reads as a little screen.
    ctx.fillStyle = 'rgba(255,255,255,0.035)';
    for (let y = 0; y < H; y += 6) ctx.fillRect(0, y, W, 2);
    this.screenTex.texture.needsUpdate = true;
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
