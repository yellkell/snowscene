/**
 * Snow Survivors' upgrade choice: the clock stops, and three cards (four
 * from a treasure chest) fan out in an arc at chest height, within reach.
 * Poke the one you want with a fingertip, or a controller, or the pole
 * handle in your fist: push it through its face and it is yours. On a
 * desktop the keys 1-4 pick.
 *
 * A card shows what it is (a weapon, a passive, an evolution), its level
 * now and next ("NEW!" for a weapon you don't have yet), what it does, and
 * a star when it would unlock an evolution.
 */

import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Vector3,
} from '@iwsdk/core';
import { type Evolution, evolvesWith, type Stats, type Upgrade } from './upgrades.js';

/** Card size (m), and how far round you (m from the head) the arc sits. */
const CARD_W = 0.15;
const CARD_H = 0.21;
const GAP = 0.022;
const REACH_XR = 0.46;
const REACH_DESKTOP = 0.62;
/** A poke counts once the fingertip is this far through the face (m). */
const PRESS_DEPTH = 0.008;
/** ...having first been at least this far in front of it. */
const ARM_DEPTH = 0.018;
/** Seconds before the cards will take a poke (a hand already there can't pick by accident). */
const ARM_DELAY = 0.55;
const CPX_W = 320;
const CPX_H = 448;

const ICONS: Record<string, string> = {
  icicles: '❄',
  blades: '⚔',
  compass: '✷',
  nova: '✺',
  lightning: '⚡',
  might: '✊',
  haste: '»',
  area: '◎',
  amount: '⁂',
  magnet: '∪',
  vitality: '♥',
  regen: '✚',
  armor: '⛨',
  pole: '➶',
  glide: '≈',
  heart: '♥',
};

interface Card {
  group: Group;
  face: Mesh;
  glow: Mesh;
  ctx: CanvasRenderingContext2D;
  texture: CanvasTexture;
  upgrade: Upgrade | null;
  hover: number;
  armed: boolean;
  /** How far a fingertip is pushing it in (m). */
  push: number;
}

function canvas(w: number, h: number): { ctx: CanvasRenderingContext2D; texture: CanvasTexture } {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const texture = new CanvasTexture(c);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return { ctx: c.getContext('2d')!, texture };
}

/** Wrap `text` into lines no wider than `width` at the current font. */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width > width && line) {
      lines.push(line);
      line = w;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export class UpgradeMenu {
  readonly root = new Group();
  private readonly cards: Card[] = [];
  private readonly header: Mesh;
  private readonly headerCanvas = canvas(768, 150);
  private count = 0;
  private age = 0;
  /** -1 while choosing; the card picked while the others fall away. */
  private picked = -1;
  private outro = 0;
  private open_ = false;
  private desktop = false;
  /** Called when a card starts to glow under a fingertip (for a tick). */
  onHover: (() => void) | null = null;

  private readonly local = new Vector3();
  private readonly look = new Vector3();

  constructor() {
    this.root.name = 'SurvivorsUpgradeMenu';
    this.root.visible = false;
    for (let i = 0; i < 4; i++) this.cards.push(this.buildCard(i));
    const { texture } = this.headerCanvas;
    this.header = new Mesh(
      new PlaneGeometry(0.5, (0.5 * 150) / 768),
      new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false, side: DoubleSide }),
    );
    this.header.renderOrder = 41;
    this.header.name = 'UpgradeMenuHeader';
    this.root.add(this.header);
  }

  private buildCard(i: number): Card {
    const group = new Group();
    group.name = `UpgradeCard-${i}`;
    const { ctx, texture } = canvas(CPX_W, CPX_H);
    const face = new Mesh(
      new PlaneGeometry(CARD_W, CARD_H),
      new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false, side: DoubleSide }),
    );
    face.renderOrder = 42;
    // A soft halo in the card's colour behind it, brighter under your finger.
    const glow = new Mesh(
      new PlaneGeometry(CARD_W * 1.5, CARD_H * 1.35),
      new MeshBasicMaterial({
        map: haloTexture(),
        color: 0xffffff,
        transparent: true,
        opacity: 0.4,
        blending: AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    glow.position.z = -0.004;
    glow.renderOrder = 40;
    group.add(glow, face);
    this.root.add(group);
    return { group, face, glow, ctx, texture, upgrade: null, hover: 0, armed: false, push: 0 };
  }

  /** Is the choice up (including its fall-away once picked)? */
  get active(): boolean {
    return this.open_;
  }

  /** Still waiting for a pick (the clock stays stopped). */
  get choosing(): boolean {
    return this.open_ && this.picked < 0;
  }

  /**
   * Fan the cards out round you, facing `yaw`, at chest height below `head`.
   * `title` heads the arc ("LEVEL 7").
   */
  open(title: string, color: string, offers: Upgrade[], stats: Stats, head: Vector3, yaw: number, presenting: boolean): void {
    this.count = Math.min(this.cards.length, offers.length);
    this.age = 0;
    this.picked = -1;
    this.outro = 0;
    this.open_ = true;
    this.desktop = !presenting;
    this.root.visible = true;
    const reach = presenting ? REACH_XR : REACH_DESKTOP;
    const y = head.y - (presenting ? 0.32 : 0.12);
    const step = (CARD_W + GAP) / reach;
    for (let i = 0; i < this.cards.length; i++) {
      const card = this.cards[i];
      card.group.visible = i < this.count;
      if (i >= this.count) continue;
      card.upgrade = offers[i];
      card.hover = 0;
      card.armed = false;
      card.push = 0;
      this.drawCard(card, offers[i], stats, i);
      const a = yaw + ((this.count - 1) / 2 - i) * step;
      card.group.position.set(head.x - Math.sin(a) * reach, y, head.z - Math.cos(a) * reach);
      // Face the eyes, tipped back a little.
      this.look.set(head.x, head.y + 0.05, head.z);
      card.group.lookAt(this.look);
      card.group.scale.setScalar(0.001);
      (card.face.material as MeshBasicMaterial).opacity = 1;
      (card.glow.material as MeshBasicMaterial).color.set(offers[i].color);
    }
    this.drawHeader(title, color);
    this.header.position.set(head.x - Math.sin(yaw) * reach, y + CARD_H / 2 + 0.06, head.z - Math.cos(yaw) * reach);
    this.look.set(head.x, head.y, head.z);
    this.header.lookAt(this.look);
    this.header.scale.setScalar(0.001);
  }

  /**
   * Animate, and look for a poke from any of `tips` (world fingertips), or
   * a key (`key` = card index, -1 for none). Returns the upgrade picked
   * this frame, if any.
   */
  update(dt: number, tips: readonly Vector3[], key: number): Upgrade | null {
    if (!this.open_) return null;
    this.age += dt;
    let chosen: Upgrade | null = null;
    if (this.picked < 0) {
      for (let i = 0; i < this.count; i++) {
        const card = this.cards[i];
        // Fan out one after another, overshooting a touch.
        const t = Math.min(1, Math.max(0, (this.age - i * 0.06) / 0.28));
        const pop = t < 1 ? 1 + 2.4 * Math.pow(t - 1, 3) + 1.4 * Math.pow(t - 1, 2) : 1;
        let near = Infinity;
        let inside = false;
        card.group.updateMatrixWorld();
        for (const tip of tips) {
          this.local.copy(tip);
          card.group.worldToLocal(this.local);
          const lateral = Math.abs(this.local.x) < CARD_W / 2 + 0.015 && Math.abs(this.local.y) < CARD_H / 2 + 0.015;
          if (!lateral) continue;
          if (this.local.z > -0.06 && this.local.z < near) near = this.local.z;
          inside = true;
        }
        const hovering = inside && near < 0.09;
        if (hovering && card.hover < 0.5 && this.age > ARM_DELAY) this.onHover?.();
        card.hover += ((hovering ? 1 : 0) - card.hover) * Math.min(1, dt * 16);
        if (near > ARM_DEPTH && this.age > ARM_DELAY) card.armed = true;
        if (!inside) card.armed = false;
        card.push = inside && near < 0.02 ? Math.min(0.03, 0.02 - near) : card.push * Math.max(0, 1 - dt * 12);
        if (card.armed && inside && near < -PRESS_DEPTH && chosen === null) chosen = this.pick(i);
        card.group.scale.setScalar(Math.max(0.001, pop * (1 + 0.07 * card.hover)));
        card.face.position.z = -card.push;
        (card.glow.material as MeshBasicMaterial).opacity = 0.3 + 0.7 * card.hover + 0.15 * Math.sin(this.age * 5 + i);
      }
      if (key >= 0 && key < this.count && chosen === null && this.age > 0.25) chosen = this.pick(key);
      const h = Math.min(1, this.age / 0.25);
      this.header.scale.setScalar(Math.max(0.001, h));
    } else {
      // The pick flares and lifts toward you; the rest drop away.
      this.outro += dt;
      const t = Math.min(1, this.outro / 0.45);
      for (let i = 0; i < this.count; i++) {
        const card = this.cards[i];
        const mat = card.face.material as MeshBasicMaterial;
        const glow = card.glow.material as MeshBasicMaterial;
        if (i === this.picked) {
          card.group.scale.setScalar(1.12 + 0.4 * t);
          card.group.position.y += dt * 0.25;
          glow.opacity = 1.4 * (1 - t);
          mat.opacity = 1 - t * t;
        } else {
          card.group.scale.setScalar(Math.max(0.001, 1 - t));
          card.group.position.y -= dt * 0.4;
          glow.opacity = 0.3 * (1 - t);
          mat.opacity = 1 - t;
        }
      }
      this.header.scale.setScalar(Math.max(0.001, 1 - t));
      if (t >= 1) this.close();
    }
    return chosen;
  }

  /** The middle of the arc (world), where the system bursts effects. */
  pickedPosition(out: Vector3): Vector3 {
    const card = this.cards[Math.max(0, this.picked)];
    return out.copy(card.group.position);
  }

  close(): void {
    this.open_ = false;
    this.picked = -1;
    this.root.visible = false;
  }

  private pick(i: number): Upgrade | null {
    const u = this.cards[i].upgrade;
    if (!u) return null;
    this.picked = i;
    this.outro = 0;
    return u;
  }

  // ---------------------------------------------------------- drawing ---

  private drawHeader(title: string, color: string): void {
    const { ctx, texture } = this.headerCanvas;
    const W = 768;
    const H = 150;
    ctx.clearRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.font = '900 76px system-ui, sans-serif';
    ctx.lineWidth = 14;
    ctx.strokeStyle = 'rgba(10, 22, 48, 0.92)';
    ctx.strokeText(title, W / 2, 86);
    ctx.fillStyle = color;
    ctx.fillText(title, W / 2, 86);
    const sub = this.desktop ? `Press 1–${this.count} to choose` : 'Poke one to choose';
    ctx.font = '700 34px system-ui, sans-serif';
    ctx.lineWidth = 9;
    ctx.strokeText(sub, W / 2, 136);
    ctx.fillStyle = '#e6f3ff';
    ctx.fillText(sub, W / 2, 136);
    texture.needsUpdate = true;
  }

  private drawCard(card: Card, u: Upgrade, s: Stats, index: number): void {
    const ctx = card.ctx;
    const W = CPX_W;
    const H = CPX_H;
    const col = new Color(u.color);
    const rgb = (k: number, a = 1) =>
      `rgba(${Math.round(col.r * 255 * k)},${Math.round(col.g * 255 * k)},${Math.round(col.b * 255 * k)},${a})`;
    ctx.clearRect(0, 0, W, H);
    // The card: deep navy ice, tinted by its colour, with a bright rim.
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(6, 6, W - 12, H - 12, 26);
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#1d2f52');
    bg.addColorStop(0.5, '#101b33');
    bg.addColorStop(1, '#0a1122');
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.clip();
    const tint = ctx.createRadialGradient(W / 2, 120, 10, W / 2, 120, 220);
    tint.addColorStop(0, rgb(1, 0.5));
    tint.addColorStop(1, rgb(1, 0));
    ctx.fillStyle = tint;
    ctx.fillRect(0, 0, W, H);
    // Frost streaks across the top.
    ctx.strokeStyle = 'rgba(220,240,255,0.08)';
    ctx.lineWidth = 2;
    for (let k = 0; k < 7; k++) {
      ctx.beginPath();
      ctx.moveTo(-20 + k * 60, 0);
      ctx.lineTo(60 + k * 60, 220);
      ctx.stroke();
    }
    ctx.restore();
    ctx.lineWidth = 6;
    ctx.strokeStyle = u.color;
    ctx.beginPath();
    ctx.roundRect(6, 6, W - 12, H - 12, 26);
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // What it is, and its level now and next.
    const evolution = u.id.startsWith('evolve-');
    const lvl = u.level ? u.level(s) : -1;
    let tag = '';
    if (evolution) tag = 'EVOLUTION';
    else if (u.id === 'heart') tag = 'HEAL';
    else if (lvl === 0) tag = 'NEW!';
    else if (lvl > 0) tag = `LV ${lvl}  →  ${lvl + 1}`;
    ctx.font = '800 26px system-ui, sans-serif';
    const tagW = ctx.measureText(tag).width + 34;
    ctx.fillStyle = lvl === 0 || evolution ? '#ffd166' : 'rgba(255,255,255,0.14)';
    ctx.beginPath();
    ctx.roundRect(W / 2 - tagW / 2, 24, tagW, 40, 20);
    ctx.fill();
    ctx.fillStyle = lvl === 0 || evolution ? '#1a1206' : '#ffffff';
    ctx.fillText(tag, W / 2, 45);

    // The emblem: a glowing disc with its icon.
    const icon = ICONS[evolution ? '' : u.id] ?? '★';
    const disc = ctx.createRadialGradient(W / 2, 140, 8, W / 2, 140, 66);
    disc.addColorStop(0, rgb(1.25, 0.95));
    disc.addColorStop(0.7, rgb(0.8, 0.55));
    disc.addColorStop(1, rgb(0.6, 0));
    ctx.fillStyle = disc;
    ctx.beginPath();
    ctx.arc(W / 2, 140, 66, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = '900 72px system-ui, sans-serif';
    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(10,20,40,0.55)';
    ctx.strokeText(icon, W / 2, 144);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(icon, W / 2, 144);

    // Its name, as big as fits.
    let size = 40;
    ctx.font = `900 ${size}px system-ui, sans-serif`;
    while (ctx.measureText(u.name).width > W - 40 && size > 22) {
      size -= 2;
      ctx.font = `900 ${size}px system-ui, sans-serif`;
    }
    ctx.fillStyle = u.color;
    ctx.fillText(u.name, W / 2, 248);

    // What it does.
    ctx.font = '600 25px system-ui, sans-serif';
    ctx.fillStyle = '#dce9fb';
    const lines = wrap(ctx, u.blurb ?? '', W - 52).slice(0, 3);
    lines.forEach((l, k) => ctx.fillText(l, W / 2, 298 + k * 31));

    // A star when it completes an evolution.
    const evo: Evolution | null = evolution ? null : evolvesWith(s, u.id);
    if (evo) {
      ctx.font = '800 22px system-ui, sans-serif';
      ctx.fillStyle = evo.color;
      ctx.fillText(`★ unlocks ${evo.name}`, W / 2, H - 52);
    }
    if (this.desktop) {
      ctx.font = '900 26px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillText(`[ ${index + 1} ]`, W / 2, H - 24);
    }
    card.texture.needsUpdate = true;
  }
}

let halo: CanvasTexture | null = null;
function haloTexture(): CanvasTexture {
  if (halo) return halo;
  const { ctx, texture } = canvas(128, 128);
  const g = ctx.createRadialGradient(64, 64, 20, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  halo = texture;
  return texture;
}
