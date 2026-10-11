/**
 * Snow Survivors' heads-up display: a card that floats low in front of you
 * (it eases after your gaze rather than sticking to it), with your health,
 * level and experience, the clock and your kills, and a banner line that
 * announces every upgrade as you take it. Redrawn a few times a second.
 *
 * Also the red flash when something bites you: a dim red shell round your
 * head that pulses up and fades.
 */

import {
  BackSide,
  CanvasTexture,
  Color,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SphereGeometry,
  SRGBColorSpace,
  type Vector3,
} from '@iwsdk/core';

export interface HudState {
  hp: number;
  maxHp: number;
  level: number;
  xp: number;
  xpNext: number;
  time: number;
  kills: number;
  weapons: string;
}

const W = 1024;
const H = 300;

export class SurvivorsHud {
  readonly card: Mesh;
  readonly hurt: Mesh;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: CanvasTexture;
  private redraw = 0;
  private banner = '';
  private bannerColor = '#fff';
  private bannerUntil = 0;
  private placed = false;
  private hurtLevel = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.card = new Mesh(
      new PlaneGeometry(0.56, (0.56 * H) / W),
      new MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }),
    );
    this.card.renderOrder = 40;
    this.card.name = 'SurvivorsHud';
    this.card.visible = false;
    this.hurt = new Mesh(
      new SphereGeometry(0.25, 16, 12),
      new MeshBasicMaterial({ color: new Color(0.9, 0.02, 0.02), transparent: true, opacity: 0, side: BackSide, depthTest: false, depthWrite: false }),
    );
    this.hurt.renderOrder = 39;
    this.hurt.name = 'SurvivorsHurt';
    this.hurt.visible = false;
  }

  announce(text: string, color: string, seconds = 3): void {
    this.banner = text;
    this.bannerColor = color;
    this.bannerUntil = performance.now() / 1000 + seconds;
    this.redraw = 0;
  }

  bitten(amount: number): void {
    this.hurtLevel = Math.min(0.45, this.hurtLevel + amount);
  }

  hide(): void {
    this.card.visible = false;
    this.hurt.visible = false;
    this.placed = false;
    this.hurtLevel = 0;
  }

  /** Float in front of (and a little below) the eyes, facing them. */
  update(dt: number, head: Vector3, yaw: number, state: HudState): void {
    const card = this.card;
    card.visible = true;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const tx = head.x + fx * 0.85;
    const ty = head.y - 0.38;
    const tz = head.z + fz * 0.85;
    const k = this.placed ? 1 - Math.exp(-5 * dt) : 1;
    this.placed = true;
    card.position.set(card.position.x + (tx - card.position.x) * k, card.position.y + (ty - card.position.y) * k, card.position.z + (tz - card.position.z) * k);
    card.lookAt(head.x, head.y, head.z);

    this.hurtLevel = Math.max(0, this.hurtLevel - dt * 0.9);
    this.hurt.visible = this.hurtLevel > 0.01;
    this.hurt.position.copy(head);
    (this.hurt.material as MeshBasicMaterial).opacity = this.hurtLevel;

    this.redraw -= dt;
    if (this.redraw > 0) return;
    this.redraw = 0.15;
    this.draw(state);
  }

  private draw(s: HudState): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(8,12,24,0.72)';
    ctx.beginPath();
    ctx.roundRect(6, 70, W - 12, H - 76, 36);
    ctx.fill();
    // Banner: the upgrade you just took.
    const now = performance.now() / 1000;
    if (this.banner && now < this.bannerUntil) {
      ctx.globalAlpha = Math.min(1, (this.bannerUntil - now) * 2);
      ctx.fillStyle = 'rgba(8,12,24,0.85)';
      ctx.beginPath();
      ctx.roundRect(40, 0, W - 80, 64, 30);
      ctx.fill();
      ctx.fillStyle = this.bannerColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      let size = 44;
      ctx.font = `800 ${size}px system-ui, sans-serif`;
      while (ctx.measureText(this.banner).width > W - 120 && size > 20) {
        size -= 2;
        ctx.font = `800 ${size}px system-ui, sans-serif`;
      }
      ctx.fillText(this.banner, W / 2, 33);
      ctx.globalAlpha = 1;
    }
    // Health.
    const bar = (y: number, frac: number, fill: string, back: string) => {
      ctx.fillStyle = back;
      ctx.beginPath();
      ctx.roundRect(30, y, W - 60, 30, 15);
      ctx.fill();
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.roundRect(30, y, Math.max(30, (W - 60) * Math.max(0, Math.min(1, frac))), 30, 15);
      ctx.fill();
    };
    bar(92, s.hp / s.maxHp, s.hp / s.maxHp < 0.3 ? '#ff3b4e' : '#ff6b81', 'rgba(255,255,255,0.12)');
    bar(134, s.xp / s.xpNext, '#4dc3ff', 'rgba(255,255,255,0.12)');
    ctx.textBaseline = 'middle';
    ctx.font = '700 24px system-ui, sans-serif';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.fillText(`${Math.ceil(s.hp)} / ${Math.round(s.maxHp)}`, 46, 108);
    ctx.fillText(`LEVEL ${s.level}`, 46, 150);
    // Clock and kills.
    const mm = Math.floor(s.time / 60);
    const ss = Math.floor(s.time % 60);
    ctx.font = '800 54px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(`${mm}:${ss.toString().padStart(2, '0')}`, 36, 214);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ffd166';
    ctx.fillText(`${s.kills.toLocaleString()} kills`, W - 36, 214);
    // Weapons owned.
    ctx.font = '600 24px system-ui, sans-serif';
    ctx.fillStyle = '#c9d6ee';
    ctx.textAlign = 'center';
    ctx.fillText(s.weapons, W / 2, 268);
    this.texture.needsUpdate = true;
  }
}
