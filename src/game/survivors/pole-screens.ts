/**
 * Snow Survivors' stats, built into the poles: each handle's top cap
 * carries a round screen in a steel pommel with a brass bezel. With the
 * tips in the snow ahead, the top of each handle points back up at you, so
 * a glance down at your hands reads them:
 *
 * - LEFT pole: health. A red dial round the rim drains as you are hurt,
 *   your health in the middle, and your level with a blue experience arc
 *   inside the dial.
 * - RIGHT pole: the run. The time left (a ring round the rim runs down
 *   with it, and both turn red for the last minute), your kills, and your
 *   combo and speed bonus underneath.
 *
 * The screen turns in its bezel so the writing always reads upright to
 * your eyes, however the pole is rolled. On a desktop they ride the
 * handles too whenever the handles are in view; where the poles
 * swing below the view, the two pommels sit in the bottom corners instead.
 */

import {
  type Camera,
  CanvasTexture,
  CircleGeometry,
  CylinderGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SRGBColorSpace,
  TorusGeometry,
  Vector3,
} from '@iwsdk/core';
import type { Handedness } from '../hand-input.js';
import { poleMeshes } from '../pole-system.js';
import type { HudState } from './survivors-hud.js';

/** The pommel's face radius (m) and where it sits up the pole's -Z end. */
const FACE_R = 0.034;
const TOP_Z = -0.096;
const PX = 256;

interface Pommel {
  side: Handedness;
  group: Group;
  ctx: CanvasRenderingContext2D;
  texture: CanvasTexture;
}

/** Steel housing, brass bezel and the screen, built facing +Z. */
function buildPommel(side: Handedness): Pommel {
  const group = new Group();
  group.name = `PoleScreen-${side}`;
  const steel = new MeshStandardMaterial({ color: 0x7f8a99, roughness: 0.38, metalness: 0.65 });
  const brass = new MeshStandardMaterial({ color: 0xc9a04a, roughness: 0.32, metalness: 0.8 });
  // A short neck off the rubber cap, then the puck.
  const neck = new Mesh(new CylinderGeometry(0.013, 0.017, 0.012, 12).rotateX(Math.PI / 2), steel);
  neck.position.z = -0.006;
  const puck = new Mesh(new CylinderGeometry(FACE_R + 0.004, FACE_R + 0.002, 0.014, 28).rotateX(Math.PI / 2), steel);
  puck.position.z = 0.007;
  const bezel = new Mesh(new TorusGeometry(FACE_R + 0.0025, 0.0028, 8, 32), brass);
  bezel.position.z = 0.0142;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = PX;
  const ctx = canvas.getContext('2d')!;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const screen = new Mesh(new CircleGeometry(FACE_R, 40), new MeshBasicMaterial({ map: texture, toneMapped: false }));
  screen.position.z = 0.0145;
  group.add(neck, puck, bezel, screen);
  group.visible = false;
  return { side, group, ctx, texture };
}

export class PoleScreens {
  readonly root = new Group();
  private readonly pommels: Pommel[] = [buildPommel('left'), buildPommel('right')];
  private redraw = 0;
  private clock = 0;
  private readonly top = new Vector3();
  private readonly ndc = new Vector3();
  private readonly n = new Vector3();
  private readonly u = new Vector3();
  private readonly r = new Vector3();
  private readonly basis = new Matrix4();

  constructor() {
    this.root.name = 'PoleScreens';
    for (const p of this.pommels) this.root.add(p.group);
  }

  hide(): void {
    for (const p of this.pommels) p.group.visible = false;
  }

  /**
   * Seat each pommel on its pole's top cap, turned so the writing reads
   * upright from `head` (with `up` the head's up direction).
   */
  update(dt: number, head: Vector3, up: Vector3, yaw: number, presenting: boolean, s: HudState, camera?: Camera): void {
    this.clock += dt;
    for (const p of this.pommels) {
      const pole: Mesh | undefined = poleMeshes[p.side];
      const g = p.group;
      // On the handle: always in a headset, and on a desktop while the
      // handle's top is on screen.
      let onPole = presenting;
      if (!presenting && pole?.visible && camera) {
        pole.updateWorldMatrix(true, false);
        this.ndc.set(0, 0, TOP_Z).applyMatrix4(pole.matrixWorld).project(camera);
        onPole = this.ndc.z < 1 && Math.abs(this.ndc.x) < 0.88 && this.ndc.y > -0.88 && this.ndc.y < 0.9;
      }
      if (onPole) {
        g.visible = !!pole?.visible;
        if (!g.visible || !pole) continue;
        pole.updateWorldMatrix(true, false);
        this.top.set(0, 0, TOP_Z).applyMatrix4(pole.matrixWorld);
        // Out of the cap: the pole's -Z.
        this.n.set(0, 0, -1).transformDirection(pole.matrixWorld);
      } else {
        // Desktop: low in the bottom corners, faces to the eyes.
        g.visible = true;
        const fx = -Math.sin(yaw);
        const fz = -Math.cos(yaw);
        const side = p.side === 'left' ? -1 : 1;
        this.top.set(head.x + fx * 0.32 - fz * 0.13 * side, head.y - 0.15, head.z + fz * 0.32 + fx * 0.13 * side);
        this.n.subVectors(head, this.top).normalize();
      }
      // Upright to the eyes: the head's up, flattened onto the face.
      this.u.copy(up).addScaledVector(this.n, -up.dot(this.n));
      if (this.u.lengthSq() < 1e-4) {
        // Looking straight down the pole: the far side of the face is "up".
        this.u.subVectors(this.top, head);
        this.u.addScaledVector(this.n, -this.u.dot(this.n));
      }
      this.u.normalize();
      this.r.crossVectors(this.u, this.n);
      this.basis.makeBasis(this.r, this.u, this.n);
      g.position.copy(this.top);
      g.quaternion.setFromRotationMatrix(this.basis);
      g.scale.setScalar(onPole ? 1 : 1.25);
    }
    this.redraw -= dt;
    if (this.redraw > 0) return;
    this.redraw = 0.15;
    this.drawHealth(this.pommels[0], s);
    this.drawRun(this.pommels[1], s);
  }

  private face(ctx: CanvasRenderingContext2D): void {
    const c = PX / 2;
    const bg = ctx.createRadialGradient(c, c * 0.8, 10, c, c, c);
    bg.addColorStop(0, '#1b2a44');
    bg.addColorStop(1, '#090f1c');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, PX, PX);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
  }

  private arc(ctx: CanvasRenderingContext2D, r: number, w: number, frac: number, color: string): void {
    const c = PX / 2;
    ctx.lineCap = 'round';
    ctx.lineWidth = w;
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.stroke();
    const f = Math.max(0, Math.min(1, frac));
    if (f <= 0) return;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(c, c, r, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2);
    ctx.stroke();
  }

  private drawHealth(p: Pommel, s: HudState): void {
    const ctx = p.ctx;
    const c = PX / 2;
    this.face(ctx);
    const f = s.hp / s.maxHp;
    const low = f < 0.3;
    const pulse = low ? 0.6 + 0.4 * Math.sin(this.clock * 9) : 1;
    this.arc(ctx, 112, 18, f, low ? `rgba(255,59,78,${pulse})` : '#ff5c76');
    this.arc(ctx, 88, 9, s.xp / s.xpNext, '#4dc3ff');
    ctx.fillStyle = low ? '#ff8a96' : '#ffffff';
    ctx.font = '800 64px system-ui, sans-serif';
    ctx.fillText(`${Math.ceil(Math.max(0, s.hp))}`, c, c - 8);
    ctx.fillStyle = '#9fd6ff';
    ctx.font = '800 26px system-ui, sans-serif';
    ctx.fillText(`LEVEL ${s.level}`, c, c + 42);
    p.texture.needsUpdate = true;
  }

  private drawRun(p: Pommel, s: HudState): void {
    const ctx = p.ctx;
    const c = PX / 2;
    this.face(ctx);
    // The run's clock round the rim, and the combo window inside it.
    const last = s.timeLeft <= 60;
    const blink = last && s.timeLeft > 0 ? 0.65 + 0.35 * Math.sin(this.clock * 8) : 1;
    this.arc(ctx, 118, 8, s.timeLeft / (s.time + s.timeLeft || 1), last ? `rgba(255,107,107,${blink})` : '#9fd6ff');
    this.arc(ctx, 104, 6, s.combo >= 10 ? s.comboLeft : 0, s.combo >= 500 ? '#ff6b6b' : '#ffb347');
    const left = Math.ceil(s.timeLeft);
    const mm = Math.floor(left / 60);
    const ss = left % 60;
    ctx.fillStyle = last ? '#ff8a8a' : '#ffffff';
    ctx.font = '800 58px system-ui, sans-serif';
    ctx.fillText(`${mm}:${ss.toString().padStart(2, '0')}`, c, c - 46);
    ctx.fillStyle = '#ffd166';
    let size = 44;
    const kills = s.kills.toLocaleString();
    ctx.font = `800 ${size}px system-ui, sans-serif`;
    while (ctx.measureText(kills).width > 170 && size > 24) {
      size -= 2;
      ctx.font = `800 ${size}px system-ui, sans-serif`;
    }
    ctx.fillText(kills, c, c + 8);
    ctx.font = '700 16px system-ui, sans-serif';
    ctx.fillText('KILLS', c, c + 36);
    ctx.font = '800 22px system-ui, sans-serif';
    ctx.fillStyle = s.combo >= 10 ? '#ffb347' : 'rgba(200,215,235,0.45)';
    ctx.fillText(s.combo >= 10 ? `${s.combo.toLocaleString()} COMBO` : '', c, c + 66);
    ctx.fillStyle = s.speedMul >= 1.05 ? '#7fe9ff' : 'rgba(200,215,235,0.45)';
    ctx.fillText(s.speedMul >= 1.05 ? `SPEED ×${s.speedMul.toFixed(1)}` : '', c, c + 92);
    p.texture.needsUpdate = true;
  }
}
