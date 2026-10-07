/**
 * Wrist watch: turn the inside of your LEFT wrist toward your face and look
 * at it, and a small watch face appears there with the time of day, your
 * altitude, a warmth bar, the section name and an arrow pointing up the
 * route. (Palm UP opens the backpack instead, so the two never clash.)
 *
 * Desktop: T toggles the watch in the corner of the view.
 *
 * The face is a canvas texture redrawn at most 4 times a second, and only
 * when something on it changed; the route arrow is its own little mesh so
 * it can turn smoothly every frame.
 */

import {
  CanvasTexture,
  CircleGeometry,
  createSystem,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  Shape,
  ShapeGeometry,
  SRGBColorSpace,
  Vector3,
} from '@iwsdk/core';
import { hands } from '../../hand-input.js';
import { getHeadWorld, getHeadYaw, wrapAngle } from '../../rig.js';
import { game, Phase } from '../../state.js';
import { route, type SectionId } from '../exp-route.js';
import { SECTION_NAMES } from '../exp-layout.js';
import { exp, expFrame } from '../exp-state.js';
import { formatClock, pointAt, type RoutePos, yawOf } from './route-math.js';

const RADIUS = 0.042;
const CANVAS = 256;
/** Pose thresholds: palm toward the eyes, gaze on the wrist (open / stay). */
const OPEN_FACING = 0.6;
const STAY_FACING = 0.35;
const OPEN_GAZE_COS = Math.cos((28 * Math.PI) / 180);
const STAY_GAZE_COS = Math.cos((42 * Math.PI) / 180);
/** Palm pointing this much upward is the backpack gesture, not the watch. */
const PACK_UP = 0.6;
const OPEN_HOLD = 0.15;
const CLOSE_HOLD = 0.35;
const REDRAW_INTERVAL = 0.25;
/** Arrow centre on the face, in canvas pixels. */
const ARROW_CX = 82;
const ARROW_CY = 160;

export class WristHudSystem extends createSystem({}) {
  private root!: Group;
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private texture!: CanvasTexture;
  private arrow!: Mesh;
  private shown = false;
  private scale = 0;
  private poseFor = 0;
  private lostFor = 0;
  private desktopOn = false;
  private redrawTimer = 0;
  private lastKey = '';
  private readonly head = new Vector3();
  private readonly gaze = new Vector3();
  private readonly toHand = new Vector3();
  private readonly toHead = new Vector3();
  private readonly wristDir = new Vector3();
  private readonly ahead: RoutePos = { x: 0, z: 0, elev: 0 };

  init(): void {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = CANVAS;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;

    this.root = new Group();
    this.root.name = 'WristWatch';
    this.root.visible = false;
    const face = new Mesh(
      new CircleGeometry(RADIUS, 48),
      new MeshBasicMaterial({ map: this.texture, toneMapped: false, fog: false }),
    );
    face.renderOrder = 40;
    this.root.add(face);
    const bezel = new Mesh(
      new RingGeometry(RADIUS, RADIUS * 1.12, 48),
      new MeshBasicMaterial({ color: 0x8a96a6, toneMapped: false, fog: false, side: DoubleSide }),
    );
    bezel.renderOrder = 40;
    this.root.add(bezel);

    const shape = new Shape();
    shape.moveTo(0, 0.0115);
    shape.lineTo(0.0065, -0.0075);
    shape.lineTo(0, -0.004);
    shape.lineTo(-0.0065, -0.0075);
    shape.closePath();
    this.arrow = new Mesh(
      new ShapeGeometry(shape),
      new MeshBasicMaterial({ color: 0xff9a3c, toneMapped: false, fog: false }),
    );
    this.arrow.position.set(
      (ARROW_CX / CANVAS - 0.5) * 2 * RADIUS,
      (0.5 - ARROW_CY / CANVAS) * 2 * RADIUS,
      0.0008,
    );
    this.arrow.renderOrder = 41;
    this.root.add(this.arrow);
    this.world.createTransformEntity(this.root, { persistent: true });
  }

  update(delta: number): void {
    const dt = Math.min(delta, 0.1);
    const presenting = this.world.renderer.xr.isPresenting;
    const allowed =
      exp.active.peek() && !game.packOpen.peek() && game.phase.peek() !== Phase.Gliding && game.fade < 0.9;
    getHeadWorld(this.world, this.head);

    let want = false;
    if (!allowed) {
      this.poseFor = 0;
    } else if (presenting) {
      want = this.updateGesture(dt);
    } else {
      if (this.input.keyboard.getKeyDown('KeyT')) this.desktopOn = !this.desktopOn;
      want = this.desktopOn;
    }
    this.shown = want;
    this.scale = Math.min(1, Math.max(0, this.scale + (want ? dt : -dt) / 0.12));
    this.root.visible = this.scale > 0;
    if (!this.root.visible) return;

    this.place(presenting);
    this.root.scale.setScalar(Math.max(0.001, this.scale) * (presenting ? 1 : 1.25));
    this.aimArrow();
    this.redrawTimer -= dt;
    if (this.redrawTimer <= 0) {
      this.redrawTimer = REDRAW_INTERVAL;
      this.redraw();
    }
  }

  /** Inside of the left wrist turned toward the eyes, and looked at. */
  private updateGesture(dt: number): boolean {
    const h = hands.left;
    this.player.head.getWorldDirection(this.gaze).negate();
    this.toHand.subVectors(h.position, this.head).normalize();
    this.toHead.copy(this.toHand).negate();
    const facing = h.palmNormal.dot(this.toHead);
    const look = this.gaze.dot(this.toHand);
    const ok = h.tracked && !h.grip && h.palmNormal.y < PACK_UP;
    const holding = this.shown
      ? ok && facing > STAY_FACING && look > STAY_GAZE_COS
      : ok && facing > OPEN_FACING && look > OPEN_GAZE_COS;
    if (holding) {
      this.poseFor += dt;
      this.lostFor = 0;
    } else {
      this.lostFor += dt;
      this.poseFor = 0;
    }
    if (!this.shown) return this.poseFor >= OPEN_HOLD;
    return this.lostFor < CLOSE_HOLD;
  }

  private place(presenting: boolean): void {
    const root = this.root;
    if (presenting) {
      const h = hands.left;
      // From the fingertips back toward the wrist, lifted off the skin.
      this.wristDir.subVectors(h.position, h.indexTip);
      const len = this.wristDir.length();
      if (len > 1e-4) this.wristDir.multiplyScalar(1 / len);
      root.position.copy(h.position).addScaledVector(this.wristDir, 0.06).addScaledVector(h.palmNormal, 0.025);
    } else {
      const yaw = getHeadYaw(this.world);
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      // Low and to the left of the view.
      root.position.set(this.head.x + fx * 0.36 + fz * 0.15, this.head.y - 0.13, this.head.z + fz * 0.36 - fx * 0.15);
    }
    root.lookAt(this.head);
  }

  /** Point the arrow up the route, relative to the direction you look at the watch. */
  private aimArrow(): void {
    const s = Math.min(route.length, expFrame.s + 25);
    pointAt(s, this.ahead);
    const target = yawOf(this.ahead.x - this.head.x, this.ahead.z - this.head.z);
    const view = yawOf(this.root.position.x - this.head.x, this.root.position.z - this.head.z);
    this.arrow.rotation.z = wrapAngle(target - view);
  }

  private redraw(): void {
    const clock = formatClock(expFrame.timeOfDay);
    const altitude = Math.max(0, Math.round(this.player.position.y));
    const warmth = Math.round(game.warmth.peek() * 100);
    const section: SectionId = exp.section.peek();
    const night = expFrame.daylight < 0.5;
    const key = `${clock}|${altitude}|${warmth}|${section}|${night}`;
    if (key === this.lastKey) return;
    this.lastKey = key;

    const ctx = this.ctx;
    const c = CANVAS / 2;
    const g = ctx.createRadialGradient(c, c * 0.8, 10, c, c, c);
    g.addColorStop(0, night ? '#1d2a44' : '#24344f');
    g.addColorStop(1, '#0c1220');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, CANVAS, CANVAS);
    // Minute ticks round the rim.
    ctx.strokeStyle = 'rgba(200, 215, 235, 0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      ctx.moveTo(c + Math.sin(a) * 116, c - Math.cos(a) * 116);
      ctx.lineTo(c + Math.sin(a) * 124, c - Math.cos(a) * 124);
    }
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#f4f7fc';
    ctx.font = '700 54px Inter, Helvetica, Arial, sans-serif';
    ctx.fillText(clock, c, 82);
    ctx.fillStyle = night ? '#9fb6ff' : '#ffd27a';
    ctx.font = '600 17px Inter, Helvetica, Arial, sans-serif';
    ctx.fillText(SECTION_NAMES[section], c, 108);

    // Route compass ring (the arrow mesh turns inside it).
    ctx.strokeStyle = 'rgba(255, 154, 60, 0.6)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(ARROW_CX, ARROW_CY, 27, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(200, 215, 235, 0.7)';
    ctx.font = '600 11px Inter, Helvetica, Arial, sans-serif';
    ctx.fillText('ROUTE', ARROW_CX, ARROW_CY + 44);

    // Altitude.
    ctx.fillStyle = '#f4f7fc';
    ctx.font = '700 34px Inter, Helvetica, Arial, sans-serif';
    const alt = altitude >= 1000 ? `${Math.floor(altitude / 1000)},${String(altitude % 1000).padStart(3, '0')}` : String(altitude);
    ctx.fillText(alt, 172, 166);
    ctx.fillStyle = 'rgba(200, 215, 235, 0.7)';
    ctx.font = '600 11px Inter, Helvetica, Arial, sans-serif';
    ctx.fillText('ALTITUDE · M', 172, 186);

    // Warmth bar: blue when cold, amber when warm.
    const w = warmth / 100;
    const bx = c - 70;
    const by = 206;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.beginPath();
    ctx.roundRect(bx, by, 140, 12, 6);
    ctx.fill();
    const r = Math.round(90 + 165 * w);
    const gr = Math.round(150 + 40 * w);
    const b = Math.round(255 - 195 * w);
    ctx.fillStyle = `rgb(${r}, ${gr}, ${b})`;
    ctx.beginPath();
    ctx.roundRect(bx, by, Math.max(12, 140 * w), 12, 6);
    ctx.fill();
    ctx.fillStyle = w < 0.25 ? '#8fc3ff' : 'rgba(200, 215, 235, 0.7)';
    ctx.font = '600 11px Inter, Helvetica, Arial, sans-serif';
    ctx.fillText(`WARMTH ${warmth}%`, c, by + 28);

    this.texture.needsUpdate = true;
  }
}
