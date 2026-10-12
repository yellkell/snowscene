/**
 * Snow Survivors' upgrade choice: time stops (the world beyond arm's reach
 * dims behind a veil, the horde freezes mid-stride, the music drops), and
 * three cards (four from a treasure chest) fan out in an arc at chest
 * height, within reach. Poke the one you want with a fingertip, or a
 * controller, or the pole handle in your fist: push it through its face and
 * it is yours. On a desktop the keys 1-4 pick.
 *
 * The cards are things you can touch: a face on a thin plate with a lit
 * edge. A fingertip coming near casts a ring on the face that tightens to a
 * dot as you close in (so you can judge depth), the card lifts toward you,
 * tilts after your finger and catches a sweep of light, and its neighbours
 * dim back. Pushing in, it gives under your finger until it takes.
 *
 * Each card shows what it is on a ribbon (new weapon, weapon, passive,
 * evolution, heal), an emblem with its icon (card-icons.ts), its name, its
 * level as pips (the one you'd gain glowing), what it does, and a star when
 * it would unlock an evolution.
 */

import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
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
import { drawIcon } from './card-icons.js';
import { drawTitle } from './title-card.js';
import { type Evolution, evolvesWith, type Stats, type Upgrade } from './upgrades.js';

/** Card size (m), and how far round you (m from the head) the arc sits. */
const CARD_W = 0.15;
const CARD_H = 0.21;
const GAP = 0.024;
const REACH_XR = 0.46;
const REACH_DESKTOP = 0.62;
/** A poke counts once the fingertip is this far through the face (m). */
const PRESS_DEPTH = 0.008;
/** ...having first been at least this far in front of it. */
const ARM_DEPTH = 0.018;
/** A fingertip within this of the face (m) hovers it. */
const HOVER_RANGE = 0.1;
/** Seconds before the cards will take a poke (a hand already there can't pick by accident). */
const ARM_DELAY = 0.55;
/** How far a hovered card lifts toward you (m). */
const LIFT = 0.012;
const CPX_W = 384;
const CPX_H = 538;
const HEAD_W = 1024;
const HEAD_H = 256;
/** The veil: how far out it hangs round your head, and how dark it gets. */
const VEIL_R = 0.95;
const VEIL_ALPHA = 0.58;

const KIND_LABEL = {
  weapon: 'WEAPON',
  passive: 'PASSIVE',
  evolution: 'EVOLUTION',
  heal: 'HEAL',
} as const;

interface Card {
  group: Group;
  /** Plate, face and sheen: lifts, tilts and gives under a finger. */
  body: Group;
  face: Mesh;
  plate: Mesh;
  sheen: Mesh;
  glow: Mesh;
  /** Where a fingertip would land: a ring closing to a dot. */
  cursor: Mesh;
  ctx: CanvasRenderingContext2D;
  texture: CanvasTexture;
  upgrade: Upgrade | null;
  hover: number;
  /** Another card is hovered: this one steps back (0..1). */
  dim: number;
  armed: boolean;
  /** How far a fingertip is pushing it in (m). */
  push: number;
  /** Where the nearest fingertip is over the face (local, m). */
  fx: number;
  fy: number;
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

/** A card's outline: a rectangle with its corners cut. */
function chamfer(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: number): void {
  ctx.beginPath();
  ctx.moveTo(x + c, y);
  ctx.lineTo(x + w - c, y);
  ctx.lineTo(x + w, y + c);
  ctx.lineTo(x + w, y + h - c);
  ctx.lineTo(x + w - c, y + h);
  ctx.lineTo(x + c, y + h);
  ctx.lineTo(x, y + h - c);
  ctx.lineTo(x, y + c);
  ctx.closePath();
}

function setSpacing(ctx: CanvasRenderingContext2D, px: number): void {
  (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${px}px`;
}

/** Mix a colour toward white (k > 0) or black (k < 0), as an rgba string. */
function shade(c: Color, k: number, a = 1): string {
  const f = (v: number) => Math.round(255 * Math.max(0, Math.min(1, k >= 0 ? v + (1 - v) * k : v * (1 + k))));
  return `rgba(${f(c.r)},${f(c.g)},${f(c.b)},${a})`;
}

// A diagonal band of light that sweeps across a hovered card.
const SHEEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const SHEEN_FRAG = /* glsl */ `
uniform float uT;
uniform float uAlpha;
uniform vec3 uColor;
varying vec2 vUv;
void main() {
  float d = vUv.x + vUv.y * 0.55 - uT;
  float band = exp(-d * d * 90.0) + 0.35 * exp(-(d + 0.12) * (d + 0.12) * 400.0);
  // Keep inside the cut corners.
  vec2 e = min(vUv, 1.0 - vUv);
  float inside = step(0.055, e.x + e.y * 0.72);
  gl_FragColor = vec4(uColor, band * uAlpha * inside);
}
`;

export class UpgradeMenu {
  readonly root = new Group();
  private readonly cards: Card[] = [];
  private readonly header: Mesh;
  private readonly headerCanvas = canvas(HEAD_W, HEAD_H);
  /** Dims the world beyond arm's reach while time is stopped. */
  private readonly veil: Mesh;
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
  private readonly toward = new Vector3();

  constructor() {
    this.root.name = 'SurvivorsUpgradeMenu';
    this.root.visible = false;
    for (let i = 0; i < 4; i++) this.cards.push(this.buildCard(i));
    const { texture } = this.headerCanvas;
    this.header = new Mesh(
      new PlaneGeometry(0.56, (0.56 * HEAD_H) / HEAD_W),
      new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false, side: DoubleSide }),
    );
    this.header.renderOrder = 41;
    this.header.name = 'UpgradeMenuHeader';
    this.root.add(this.header);
    // Drawn over the world but behind anything nearer than it (cards,
    // hands, poles), so only what is out of reach goes dark.
    this.veil = new Mesh(
      new SphereGeometry(VEIL_R, 32, 16),
      new MeshBasicMaterial({
        color: new Color(0.02, 0.05, 0.13),
        transparent: true,
        opacity: 0,
        side: BackSide,
        depthWrite: false,
        toneMapped: false,
        fog: false,
      }),
    );
    this.veil.renderOrder = 35;
    this.veil.name = 'TimeStopVeil';
    this.root.add(this.veil);
  }

  private buildCard(i: number): Card {
    const group = new Group();
    group.name = `UpgradeCard-${i}`;
    const body = new Group();
    const { ctx, texture } = canvas(CPX_W, CPX_H);
    // The plate: a thin slab a touch bigger than the face, its edge lit in
    // the card's colour.
    const plate = new Mesh(
      new BoxGeometry(CARD_W * 1.03, CARD_H * 1.025, 0.004),
      new MeshBasicMaterial({ color: 0x223355, toneMapped: false }),
    );
    plate.position.z = -0.0025;
    plate.renderOrder = 41;
    const face = new Mesh(
      new PlaneGeometry(CARD_W, CARD_H),
      new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false }),
    );
    face.renderOrder = 42;
    const sheen = new Mesh(
      new PlaneGeometry(CARD_W, CARD_H),
      new ShaderMaterial({
        vertexShader: SHEEN_VERT,
        fragmentShader: SHEEN_FRAG,
        uniforms: { uT: { value: -1 }, uAlpha: { value: 0 }, uColor: { value: new Color(1, 1, 1) } },
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        toneMapped: false,
      }),
    );
    sheen.position.z = 0.0006;
    sheen.renderOrder = 43;
    body.add(plate, face, sheen);
    // A soft halo in the card's colour behind it, brighter under your finger.
    const glow = new Mesh(
      new PlaneGeometry(CARD_W * 1.6, CARD_H * 1.4),
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
    glow.position.z = -0.006;
    glow.renderOrder = 40;
    // The poke cursor rides just off the face, in the card's frame.
    const cursor = new Mesh(
      new RingGeometry(0.72, 1, 32),
      new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, toneMapped: false }),
    );
    cursor.renderOrder = 44;
    cursor.visible = false;
    group.add(glow, body, cursor);
    this.root.add(group);
    return {
      group,
      body,
      face,
      plate,
      sheen,
      glow,
      cursor,
      ctx,
      texture,
      upgrade: null,
      hover: 0,
      dim: 0,
      armed: false,
      push: 0,
      fx: 0,
      fy: 0,
    };
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
   * `title` heads the arc ("LEVEL 7"), with `sub` (if any) under it.
   */
  open(
    title: string,
    color: string,
    offers: Upgrade[],
    stats: Stats,
    head: Vector3,
    yaw: number,
    presenting: boolean,
    sub = '',
  ): void {
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
      const u = offers[i];
      card.upgrade = u;
      card.hover = 0;
      card.dim = 0;
      card.armed = false;
      card.push = 0;
      this.drawCard(card, u, stats, i);
      const a = yaw + ((this.count - 1) / 2 - i) * step;
      card.group.position.set(head.x - Math.sin(a) * reach, y, head.z - Math.cos(a) * reach);
      // Face the eyes, tipped back a little.
      this.look.set(head.x, head.y + 0.05, head.z);
      card.group.lookAt(this.look);
      card.group.scale.setScalar(0.001);
      card.body.position.set(0, 0, 0);
      card.body.rotation.set(0, 0, 0);
      const c = new Color(u.color);
      (card.face.material as MeshBasicMaterial).opacity = 1;
      (card.face.material as MeshBasicMaterial).color.setRGB(1, 1, 1);
      (card.plate.material as MeshBasicMaterial).color.copy(c).multiplyScalar(0.55);
      (card.glow.material as MeshBasicMaterial).color.copy(c);
      (card.cursor.material as MeshBasicMaterial).color.copy(c).lerp(new Color(1, 1, 1), 0.55);
      const sheen = (card.sheen.material as ShaderMaterial).uniforms;
      sheen.uColor.value.copy(c).lerp(new Color(1, 1, 1), 0.6);
      sheen.uAlpha.value = 0;
    }
    this.drawHeader(title, color, sub);
    this.header.position.set(head.x - Math.sin(yaw) * reach, y + CARD_H / 2 + 0.075, head.z - Math.cos(yaw) * reach);
    this.veil.position.copy(head);
    (this.veil.material as MeshBasicMaterial).opacity = 0;
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
      let anyHover = -1;
      for (let i = 0; i < this.count; i++) if (this.cards[i].hover > 0.5) anyHover = i;
      for (let i = 0; i < this.count; i++) {
        const card = this.cards[i];
        // Fan out one after another, overshooting a touch.
        const t = Math.min(1, Math.max(0, (this.age - i * 0.07) / 0.3));
        const pop = t < 1 ? 1 + 2.4 * Math.pow(t - 1, 3) + 1.4 * Math.pow(t - 1, 2) : 1;
        let near = Infinity;
        let inside = false;
        card.group.updateMatrixWorld();
        for (const tip of tips) {
          this.local.copy(tip);
          card.group.worldToLocal(this.local);
          const lateral = Math.abs(this.local.x) < CARD_W / 2 + 0.015 && Math.abs(this.local.y) < CARD_H / 2 + 0.015;
          if (!lateral) continue;
          if (this.local.z > -0.06 && this.local.z < near) {
            near = this.local.z;
            card.fx = this.local.x;
            card.fy = this.local.y;
          }
          inside = true;
        }
        const hovering = inside && near < HOVER_RANGE;
        if (hovering && card.hover < 0.5 && this.age > ARM_DELAY) this.onHover?.();
        const k = Math.min(1, dt * 14);
        card.hover += ((hovering ? 1 : 0) - card.hover) * k;
        card.dim += ((anyHover >= 0 && anyHover !== i ? 1 : 0) - card.dim) * k;
        if (near > ARM_DEPTH && this.age > ARM_DELAY) card.armed = true;
        if (!inside) card.armed = false;
        card.push = inside && near < LIFT ? Math.min(0.03, LIFT - near) : card.push * Math.max(0, 1 - dt * 12);
        if (card.armed && inside && near < -PRESS_DEPTH && chosen === null) chosen = this.pick(i);

        card.group.scale.setScalar(Math.max(0.001, pop * (1 + 0.05 * card.hover - 0.04 * card.dim)));
        // Lifts toward you, gives under the finger, tilts after it.
        card.body.position.z = LIFT * card.hover - card.push;
        card.body.rotation.y = (card.fx / CARD_W) * 0.35 * card.hover;
        card.body.rotation.x = (-card.fy / CARD_H) * 0.3 * card.hover;
        const faceMat = card.face.material as MeshBasicMaterial;
        const lit = 1 - 0.35 * card.dim + 0.12 * card.hover;
        faceMat.color.setRGB(lit, lit, lit);
        (card.glow.material as MeshBasicMaterial).opacity =
          (0.28 + 0.8 * card.hover + 0.1 * Math.sin(this.age * 4 + i * 1.7)) * (1 - 0.7 * card.dim);
        const sheen = (card.sheen.material as ShaderMaterial).uniforms;
        sheen.uAlpha.value = 0.12 + 0.5 * card.hover;
        sheen.uT.value = -0.4 + (((this.age * (0.35 + 0.5 * card.hover) + i * 0.37) % 1.6));
        this.placeCursor(card, inside ? near : Infinity);
      }
      if (key >= 0 && key < this.count && chosen === null && this.age > 0.25) chosen = this.pick(key);
      const h = Math.min(1, this.age / 0.25);
      this.header.scale.setScalar(Math.max(0.001, h));
      (this.veil.material as MeshBasicMaterial).opacity = VEIL_ALPHA * Math.min(1, this.age / 0.3);
    } else {
      // The pick flares white and rushes to you; the rest fall away.
      this.outro += dt;
      const t = Math.min(1, this.outro / 0.5);
      for (let i = 0; i < this.count; i++) {
        const card = this.cards[i];
        card.cursor.visible = false;
        const mat = card.face.material as MeshBasicMaterial;
        const glow = card.glow.material as MeshBasicMaterial;
        const sheen = (card.sheen.material as ShaderMaterial).uniforms;
        if (i === this.picked) {
          const flash = Math.max(0, 1 - t * 3);
          mat.color.setRGB(1 + 1.5 * flash, 1 + 1.5 * flash, 1 + 1.5 * flash);
          card.group.scale.setScalar(1.08 + 0.25 * t);
          // Toward your chest.
          card.group.position.lerp(this.toward, Math.min(1, dt * 7 * t));
          glow.opacity = 1.6 * (1 - t);
          sheen.uAlpha.value = 0.8 * (1 - t);
          mat.opacity = 1 - t * t;
        } else {
          card.group.scale.setScalar(Math.max(0.001, 1 - t));
          card.body.rotation.x += dt * 2.5;
          card.group.position.y -= dt * 0.35;
          glow.opacity = 0.2 * (1 - t);
          sheen.uAlpha.value = 0;
          mat.opacity = 1 - t;
        }
      }
      this.header.scale.setScalar(Math.max(0.001, 1 - t));
      // Time starts again as the veil lifts.
      (this.veil.material as MeshBasicMaterial).opacity = VEIL_ALPHA * (1 - t) * (1 - t);
      if (t >= 1) this.close();
    }
    return chosen;
  }

  /** The poke cursor: a ring over the face under the fingertip, closing to a dot at contact. */
  private placeCursor(card: Card, near: number): void {
    const cursor = card.cursor;
    if (near > HOVER_RANGE || this.age <= ARM_DELAY) {
      cursor.visible = false;
      return;
    }
    const d = Math.max(0, near);
    const k = d / HOVER_RANGE;
    cursor.visible = true;
    cursor.position.set(card.fx, card.fy, card.body.position.z + 0.0012);
    cursor.scale.setScalar(0.0045 + 0.022 * k);
    (cursor.material as MeshBasicMaterial).opacity = 0.95 * (1 - k * 0.6);
  }

  /** Where the picked card is (world), where the system bursts effects. */
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
    // It flies to a point just below the middle of the arc, toward you.
    this.toward.copy(this.veil.position);
    this.toward.y -= 0.45;
    this.toward.lerp(this.cards[i].group.position, 0.35);
    return u;
  }

  // ---------------------------------------------------------- drawing ---

  private drawHeader(title: string, color: string, sub: string): void {
    const { ctx, texture } = this.headerCanvas;
    const how = this.desktop ? `press 1–${this.count}` : 'poke a card';
    drawTitle(ctx, HEAD_W, HEAD_H, title, sub ? `${sub} · ${how}` : `Time stopped · ${how}`, color, 104);
    texture.needsUpdate = true;
  }

  private drawCard(card: Card, u: Upgrade, s: Stats, index: number): void {
    const ctx = card.ctx;
    const W = CPX_W;
    const H = CPX_H;
    const col = new Color(u.color);
    const kind = u.kind ?? (u.id.startsWith('evolve-') ? 'evolution' : 'passive');
    const evolution = kind === 'evolution';
    const lvl = u.level ? u.level(s) : -1;
    const isNew = kind === 'weapon' && lvl === 0;
    const gold = '#ffd166';
    const C = 30; // corner cut
    ctx.clearRect(0, 0, W, H);
    ctx.save();

    // The face: deep night-blue, lit from the emblem in the card's colour.
    chamfer(ctx, 4, 4, W - 8, H - 8, C);
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#1a2a4a');
    bg.addColorStop(0.55, '#0e1830');
    bg.addColorStop(1, '#080f20');
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.save();
    ctx.clip();
    const glow = ctx.createRadialGradient(W / 2, 168, 10, W / 2, 168, 250);
    glow.addColorStop(0, shade(col, 0, 0.55));
    glow.addColorStop(0.6, shade(col, -0.3, 0.12));
    glow.addColorStop(1, shade(col, -0.5, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
    // Faint rays behind the emblem (bright gold ones on an evolution).
    ctx.translate(W / 2, 168);
    for (let k = 0; k < 16; k++) {
      ctx.rotate(Math.PI / 8);
      ctx.fillStyle = evolution ? 'rgba(255, 220, 140, 0.13)' : shade(col, 0.4, 0.05);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-16, -320);
      ctx.lineTo(16, -320);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // Frame: a bright outer line in the colour (gold for an evolution) and
    // a hairline inset inside it.
    ctx.lineJoin = 'miter';
    chamfer(ctx, 5, 5, W - 10, H - 10, C);
    ctx.lineWidth = 6;
    ctx.strokeStyle = evolution ? gold : u.color;
    ctx.stroke();
    chamfer(ctx, 16, 16, W - 32, H - 32, C - 8);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = evolution ? 'rgba(255, 220, 140, 0.6)' : shade(col, 0.3, 0.35);
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // The ribbon: what sort of thing it is.
    const label = isNew ? 'NEW WEAPON' : KIND_LABEL[kind];
    ctx.font = '800 21px system-ui, sans-serif';
    setSpacing(ctx, 4);
    const lw = ctx.measureText(label).width + 48;
    ctx.fillStyle = isNew || evolution ? gold : shade(col, -0.45, 0.95);
    ctx.beginPath();
    ctx.moveTo(W / 2 - lw / 2, 30);
    ctx.lineTo(W / 2 + lw / 2, 30);
    ctx.lineTo(W / 2 + lw / 2 - 12, 48);
    ctx.lineTo(W / 2 + lw / 2, 66);
    ctx.lineTo(W / 2 - lw / 2, 66);
    ctx.lineTo(W / 2 - lw / 2 + 12, 48);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = isNew || evolution ? '#1a1206' : shade(col, 0.75);
    ctx.fillText(label, W / 2 + 2, 49);
    setSpacing(ctx, 0);

    // The emblem: a hexagonal medallion with its icon.
    const ey = 168;
    const er = 74;
    ctx.save();
    ctx.shadowColor = u.color;
    ctx.shadowBlur = 30;
    ctx.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = Math.PI / 6 + (k * Math.PI) / 3;
      const x = W / 2 + Math.cos(a) * er;
      const y = ey + Math.sin(a) * er;
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    const disc = ctx.createLinearGradient(0, ey - er, 0, ey + er);
    disc.addColorStop(0, shade(col, 0.15));
    disc.addColorStop(1, shade(col, -0.45));
    ctx.fillStyle = disc;
    ctx.fill();
    ctx.restore();
    ctx.lineWidth = 4;
    ctx.strokeStyle = evolution ? gold : shade(col, 0.55);
    ctx.stroke();
    drawIcon(ctx, evolution ? 'evolution' : u.id, W / 2, ey, 44);

    // Its name, as big as fits.
    let size = 44;
    ctx.font = `800 ${size}px system-ui, sans-serif`;
    while (ctx.measureText(u.name).width > W - 56 && size > 24) {
      size -= 2;
      ctx.font = `800 ${size}px system-ui, sans-serif`;
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillText(u.name, W / 2, 288);

    // Its level as pips: the ones you have, the one you'd gain glowing,
    // the rest empty.
    const max = u.max ?? 0;
    let textTop = 328;
    if (max > 0 && lvl >= 0) {
      const pip = 13;
      const gap = 7;
      const total = max * pip + (max - 1) * gap;
      const x0 = W / 2 - total / 2;
      const py = 322;
      for (let k = 0; k < max; k++) {
        const x = x0 + k * (pip + gap);
        ctx.beginPath();
        ctx.moveTo(x + pip / 2, py - pip / 2);
        ctx.lineTo(x + pip, py);
        ctx.lineTo(x + pip / 2, py + pip / 2);
        ctx.lineTo(x, py);
        ctx.closePath();
        if (k < lvl) {
          ctx.fillStyle = u.color;
          ctx.fill();
        } else if (k === lvl) {
          ctx.save();
          ctx.shadowColor = '#ffffff';
          ctx.shadowBlur = 12;
          ctx.fillStyle = '#ffffff';
          ctx.fill();
          ctx.restore();
        } else {
          ctx.lineWidth = 2;
          ctx.strokeStyle = 'rgba(200, 220, 255, 0.35)';
          ctx.stroke();
        }
      }
      textTop = 350;
    } else {
      // A thin rule under the name instead.
      const rule = ctx.createLinearGradient(W * 0.2, 0, W * 0.8, 0);
      rule.addColorStop(0, 'rgba(255,255,255,0)');
      rule.addColorStop(0.5, evolution ? gold : u.color);
      rule.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = rule;
      ctx.fillRect(W * 0.2, 318, W * 0.6, 2);
      textTop = 344;
    }

    // What it does.
    ctx.font = '500 27px system-ui, sans-serif';
    ctx.fillStyle = '#d4e3f7';
    const lines = wrap(ctx, u.blurb ?? '', W - 64).slice(0, 3);
    lines.forEach((l, k) => ctx.fillText(l, W / 2, textTop + 16 + k * 34));

    // A star when it completes an evolution.
    const evo: Evolution | null = evolution ? null : evolvesWith(s, u.id);
    if (evo) {
      ctx.font = '700 22px system-ui, sans-serif';
      const text = `★ UNLOCKS ${evo.name.toUpperCase()}`;
      setSpacing(ctx, 2);
      const tw = ctx.measureText(text).width + 30;
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(W / 2 - tw / 2, H - 92, tw, 36);
      ctx.fillStyle = evo.color;
      ctx.fillText(text, W / 2, H - 73);
      setSpacing(ctx, 0);
    }
    // The key on a desktop: a little keycap in the bottom corner.
    if (this.desktop) {
      const kx = W - 58;
      const ky = H - 58;
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(kx - 20, ky - 20, 40, 40, 8);
      ctx.fill();
      ctx.stroke();
      ctx.font = '800 24px system-ui, sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(`${index + 1}`, kx, ky + 1);
    }
    ctx.restore();
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
