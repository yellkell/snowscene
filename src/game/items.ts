/**
 * Procedural models for the gear in your backpack: ice axes, carabiner,
 * headlamp, thermos, hand warmer, map, flare and the packed glider, plus
 * how each lies in its slot. Each model's origin is the point you hold it
 * by, with its long axis along -Z of the hand's grip space (the thumb
 * side), so it can be parented straight onto a grip pose.
 *
 * They are built from turned profiles (lathes), bevelled outlines and swept
 * tubes rather than stock boxes, in the game's own colours: enamel and
 * brushed steel, anodised alloy, printed card and waxed canvas.
 */

import {
  Box3,
  BoxGeometry,
  type BufferGeometry,
  CanvasTexture,
  CapsuleGeometry,
  CatmullRomCurve3,
  Color,
  ConeGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Shape,
  SRGBColorSpace,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
} from '@iwsdk/core';
import type { ItemId } from './equipment.js';
import { buildGlider, type GliderPartId } from './glider-model.js';
import { GeometryBuilder, segmentMatrix } from './mesh-utils.js';
import { buildPole } from './world-builders.js';

// ------------------------------------------------------------ materials ---

const mat = (color: number, roughness: number, metalness = 0) => new MeshStandardMaterial({ color, roughness, metalness });
const STEEL = mat(0xc4c9d1, 0.32, 0.85);
const DARK_STEEL = mat(0x5d636e, 0.4, 0.8);
const RUBBER = mat(0x1d1f24, 0.85);
const BRASS = mat(0xc9a04a, 0.35, 0.8);
const ENAMEL_GREEN = mat(0x1f5c45, 0.38, 0.15);
const FLARE_RED = mat(0xc8242a, 0.55);
const LAMP_ORANGE = mat(0xe8662a, 0.5);
const STRAP = mat(0x2a2e38, 0.85);
const STRAP_STRIPE = mat(0xf0a23c, 0.7);
const ANODISED = mat(0xe0a12e, 0.3, 0.7);
const AXE_SHAFT = mat(0xe8662a, 0.35, 0.45);
const CANVAS_RED = mat(0xc8402e, 0.85);
const CANVAS_DARK = mat(0x7a2a20, 0.85);
const WEBBING = mat(0x2c2f36, 0.8);

const vertexMat = () => new MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.35 });

function mesh(geometry: BufferGeometry, material: MeshStandardMaterial, name?: string): Mesh {
  const m = new Mesh(geometry, material);
  if (name) m.name = name;
  return m;
}

/** A turned profile ([radius, height] pairs, bottom to top) lathed round Y, then laid along -Z. */
function turned(profile: [number, number][], segments = 28): BufferGeometry {
  const pts = profile.map(([r, y]) => new Vector2(r, y));
  return new LatheGeometry(pts, segments).rotateX(-Math.PI / 2);
}

/** A rounded rectangle outline (w x h), centred. */
function roundedRect(w: number, h: number, r: number): Shape {
  const s = new Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/** A soft slab from an outline: `depth` thick plus a rounded bevel all round, centred on z = 0. */
function slab(shape: Shape, depth: number, bevel: number): BufferGeometry {
  const g = new ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 10 });
  g.translate(0, 0, -depth / 2);
  return g;
}

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext('2d')!);
  const t = new CanvasTexture(canvas);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// ------------------------------------------------------------- thermos ---

/** A green enamel flask: steel base ring, a cream band, and a brushed cup-cap with grip rings. */
export function buildThermos(): Group {
  const group = new Group();
  group.name = 'Thermos';
  // Held a third of the way up.
  const base = -0.09;
  const body = mesh(
    turned([
      [0, base],
      [0.033, base],
      [0.037, base + 0.006],
      [0.037, base + 0.168],
      [0.034, base + 0.184],
      [0.027, base + 0.194],
      [0.027, base + 0.2],
    ]),
    ENAMEL_GREEN,
    'Body',
  );
  const foot = mesh(new CylinderGeometry(0.0378, 0.0378, 0.016, 28).rotateX(-Math.PI / 2).translate(0, 0, -(base + 0.01)), STEEL, 'Foot');
  const band = mesh(new CylinderGeometry(0.0374, 0.0374, 0.03, 28).rotateX(-Math.PI / 2).translate(0, 0, -(base + 0.11)), mat(0xeae0c8, 0.6), 'Band');
  const cap = mesh(
    turned([
      [0, base + 0.198],
      [0.031, base + 0.198],
      [0.039, base + 0.204],
      [0.039, base + 0.262],
      [0.035, base + 0.27],
      [0, base + 0.272],
    ]),
    STEEL,
    'Cap',
  );
  group.add(body, foot, band, cap);
  for (let k = 0; k < 3; k++) {
    const ring = mesh(new TorusGeometry(0.0392, 0.0022, 6, 28), RUBBER);
    ring.position.z = -(base + 0.215 + k * 0.016);
    group.add(ring);
  }
  return group;
}

// --------------------------------------------------------------- flare ---

const flareLabel = () =>
  canvasTexture(256, 64, (ctx) => {
    ctx.fillStyle = '#efe6cf';
    ctx.fillRect(0, 0, 256, 64);
    ctx.fillStyle = '#c8242a';
    for (let x = -64; x < 256; x += 28) {
      ctx.beginPath();
      ctx.moveTo(x, 64);
      ctx.lineTo(x + 14, 64);
      ctx.lineTo(x + 46, 0);
      ctx.lineTo(x + 32, 0);
      ctx.fill();
    }
    ctx.fillStyle = '#efe6cf';
    ctx.fillRect(70, 14, 116, 36);
    ctx.fillStyle = '#1d1f24';
    ctx.font = '900 30px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('FLARE', 128, 33);
  });

/** A signal flare: red tube, a printed label, a ribbed striker cap and a brass end. */
export function buildFlare(): Group {
  const group = new Group();
  group.name = 'Flare';
  const tubeMesh = mesh(
    turned([
      [0, -0.1],
      [0.016, -0.1],
      [0.018, -0.096],
      [0.018, 0.07],
      [0.016, 0.075],
    ], 20),
    FLARE_RED,
    'Tube',
  );
  const label = mesh(new CylinderGeometry(0.0183, 0.0183, 0.07, 24, 1, true).rotateX(-Math.PI / 2).translate(0, 0, 0.0), new MeshStandardMaterial({ map: flareLabel(), roughness: 0.7 }), 'Label');
  const cap = mesh(
    turned([
      [0, 0.072],
      [0.02, 0.072],
      [0.021, 0.078],
      [0.021, 0.1],
      [0.017, 0.106],
      [0, 0.107],
    ], 20),
    RUBBER,
    'Striker',
  );
  const end = mesh(new CylinderGeometry(0.0172, 0.0172, 0.008, 20).rotateX(-Math.PI / 2).translate(0, 0, 0.1), BRASS, 'End');
  group.add(tubeMesh, label, cap, end);
  for (let k = 0; k < 2; k++) {
    const rib = mesh(new TorusGeometry(0.021, 0.0016, 5, 20), DARK_STEEL);
    rib.position.z = -(0.082 + k * 0.01);
    group.add(rib);
  }
  return group;
}

// -------------------------------------------------------------- warmer ---

const warmerLabel = () =>
  canvasTexture(128, 160, (ctx) => {
    ctx.fillStyle = '#f6efe0';
    ctx.beginPath();
    ctx.roundRect(4, 4, 120, 152, 16);
    ctx.fill();
    // A flame.
    const g = ctx.createLinearGradient(0, 110, 0, 20);
    g.addColorStop(0, '#e8462a');
    g.addColorStop(1, '#ffb347');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(64, 18);
    ctx.bezierCurveTo(88, 50, 98, 70, 90, 92);
    ctx.bezierCurveTo(84, 112, 44, 112, 38, 92);
    ctx.bezierCurveTo(32, 72, 50, 58, 54, 40);
    ctx.bezierCurveTo(60, 56, 66, 50, 64, 18);
    ctx.fill();
    ctx.fillStyle = '#c8242a';
    ctx.font = '900 30px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('HOT', 64, 142);
  });

/** A hand warmer: a soft, puffy orange pouch with a printed label on its face. */
export function buildWarmer(): Group {
  const group = new Group();
  group.name = 'HandWarmer';
  // Flat in the hand's XZ plane, face up (+Y).
  const pouch = mesh(slab(roundedRect(0.064, 0.084, 0.014), 0.006, 0.007).rotateX(-Math.PI / 2), mat(0xe8742a, 0.75), 'Pouch');
  const label = mesh(new PlaneGeometry(0.044, 0.056).rotateX(-Math.PI / 2), new MeshStandardMaterial({ map: warmerLabel(), roughness: 0.8, transparent: true }), 'Label');
  label.position.y = 0.0102;
  group.add(pouch, label);
  return group;
}

// ----------------------------------------------------------------- map ---

function mapTexture(): CanvasTexture {
  return canvasTexture(384, 256, (ctx) => {
    ctx.fillStyle = '#efe6d2';
    ctx.fillRect(0, 0, 384, 256);
    // Green valleys and contour lines round a peak.
    ctx.fillStyle = 'rgba(120,170,110,0.35)';
    ctx.beginPath();
    ctx.ellipse(70, 200, 90, 60, 0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(140,100,60,0.45)';
    ctx.lineWidth = 1.5;
    for (let r = 14; r < 200; r += 15) {
      ctx.beginPath();
      ctx.ellipse(250, 110, r, r * 0.75, 0.35, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(80,140,210,0.5)';
    ctx.beginPath();
    ctx.ellipse(110, 70, 34, 18, -0.3, 0, Math.PI * 2);
    ctx.fill();
    // The route, dashed red, to a flag on the summit.
    ctx.strokeStyle = '#c0392b';
    ctx.lineWidth = 4;
    ctx.setLineDash([9, 7]);
    ctx.beginPath();
    ctx.moveTo(24, 236);
    ctx.bezierCurveTo(110, 170, 300, 210, 250, 110);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#c0392b';
    ctx.beginPath();
    ctx.moveTo(252, 110);
    ctx.lineTo(252, 84);
    ctx.lineTo(272, 92);
    ctx.lineTo(254, 100);
    ctx.fill();
    // Fold creases.
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 2;
    for (const x of [128, 256]) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 256);
      ctx.stroke();
    }
  });
}

/** A map folded concertina-style in three panels, its printed face up. */
export function buildFoldedMap(): Group {
  const group = new Group();
  group.name = 'Map';
  const tex = mapTexture();
  const material = new MeshStandardMaterial({ map: tex, roughness: 0.9 });
  const panel = 0.05;
  const tilt = 0.32;
  for (let k = 0; k < 3; k++) {
    const g = new PlaneGeometry(panel, 0.11);
    // This panel's third of the printed sheet.
    const uv = g.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setX(i, (k + uv.getX(i)) / 3);
    const m = mesh(g.rotateX(-Math.PI / 2), material, `Panel${k}`);
    // Zig-zag: each panel tipped the other way, edges meeting.
    const dir = k % 2 === 0 ? 1 : -1;
    m.rotation.z = dir * tilt;
    m.position.set((k - 1) * panel * Math.cos(tilt), 0, 0);
    group.add(m);
  }
  return group;
}

// ------------------------------------------------------------ headlamp ---

/** A ribbon round the Y axis: radius r, `width` tall, `thick` through. */
function ribbon(r: number, width: number, thick: number, segments = 48): BufferGeometry {
  const pts = [
    new Vector2(r - thick / 2, -width / 2),
    new Vector2(r + thick / 2, -width / 2),
    new Vector2(r + thick / 2, width / 2),
    new Vector2(r - thick / 2, width / 2),
    new Vector2(r - thick / 2, -width / 2),
  ];
  return new LatheGeometry(pts, segments);
}

/**
 * A headlamp: an elastic strap (charcoal with an orange stripe) in a loop
 * round Y, the lamp housing at the front (-Z) with a glowing lens in a
 * steel bezel, and the battery box at the back. `R` is the loop's radius
 * (cinched up small when it lies in the pack).
 */
export function buildHeadlamp(R = 0.085): Group {
  const group = new Group();
  group.name = 'Headlamp';
  group.add(mesh(ribbon(R, 0.024, 0.004), STRAP, 'Strap'));
  group.add(mesh(ribbon(R + 0.0006, 0.006, 0.004), STRAP_STRIPE, 'Stripe'));
  const housing = mesh(slab(roundedRect(0.054, 0.036, 0.01), 0.016, 0.005), LAMP_ORANGE, 'Housing');
  housing.position.z = -R - 0.012;
  const bezel = mesh(new TorusGeometry(0.0125, 0.0028, 8, 24), STEEL, 'Bezel');
  bezel.position.z = -R - 0.026;
  const lens = mesh(
    new CylinderGeometry(0.0118, 0.0118, 0.004, 24).rotateX(Math.PI / 2),
    new MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff0c8, emissiveIntensity: 0.9, roughness: 0.2 }),
    'Lens',
  );
  lens.position.z = -R - 0.0265;
  const button = mesh(new CylinderGeometry(0.004, 0.004, 0.004, 12), RUBBER, 'Button');
  button.position.set(0.016, 0.02, -R - 0.012);
  const battery = mesh(slab(roundedRect(0.044, 0.028, 0.008), 0.012, 0.004), STRAP, 'Battery');
  battery.position.z = R + 0.009;
  group.add(housing, bezel, lens, button, battery);
  return group;
}

// ----------------------------------------------------------- carabiner ---

/**
 * A screw-gate carabiner in anodised gold: a D swept as one round bar, its
 * straight spine along the long axis (Z), a steel gate across the open
 * side and a knurled locking sleeve on the gate.
 */
export function buildCarabiner(): Group {
  const group = new Group();
  group.name = 'Carabiner';
  // In the YZ plane (x = 0), from the top of the gate round to its foot.
  const p = (y: number, z: number) => new Vector3(0, y, z);
  const body = new CatmullRomCurve3([
    p(0.022, -0.03),
    p(0.019, -0.044),
    p(0.008, -0.054),
    p(-0.006, -0.055),
    p(-0.017, -0.046),
    p(-0.021, -0.03),
    p(-0.021, 0.0),
    p(-0.021, 0.03),
    p(-0.017, 0.046),
    p(-0.006, 0.055),
    p(0.008, 0.054),
    p(0.019, 0.044),
    p(0.025, 0.03),
  ]);
  group.add(mesh(new TubeGeometry(body, 64, 0.0058, 10, false), ANODISED, 'Body'));
  const gate = mesh(new CylinderGeometry(0.0042, 0.0042, 1, 10), STEEL, 'Gate');
  gate.applyMatrix4(segmentMatrix(p(0.025, 0.03), p(0.022, -0.03), new Matrix4()));
  const sleeve = mesh(new CylinderGeometry(0.0072, 0.0072, 1, 14), DARK_STEEL, 'Sleeve');
  sleeve.applyMatrix4(segmentMatrix(p(0.0246, 0.026), p(0.0236, 0.006), new Matrix4()));
  group.add(gate, sleeve);
  return group;
}

// ------------------------------------------------------------- ice axe ---

/** The axe head's outline (x forward along the pick, y up the shaft): pick, adze and the block between. */
function axeHeadShape(): Shape {
  const s = new Shape();
  s.moveTo(-0.012, 0.016);
  // The adze, out the back, flaring to a flat edge.
  s.lineTo(-0.05, 0.012);
  s.lineTo(-0.074, 0.004);
  s.lineTo(-0.078, -0.012);
  s.lineTo(-0.05, -0.008);
  s.lineTo(-0.012, -0.014);
  // Down the block, then the pick's toothed underside to its tip.
  s.lineTo(0.012, -0.016);
  for (let k = 0; k < 5; k++) {
    const x = 0.03 + k * 0.022;
    s.lineTo(x, -0.02 - k * 0.008);
    s.lineTo(x + 0.008, -0.03 - k * 0.008);
  }
  s.lineTo(0.15, -0.066);
  s.lineTo(0.158, -0.062);
  // Back along the top of the pick.
  s.quadraticCurveTo(0.1, -0.02, 0.012, 0.016);
  s.lineTo(-0.012, 0.016);
  return s;
}

/**
 * A technical ice axe: rubber grip with a finger guard at the hand, a
 * gently curved orange alloy shaft, and a forged steel head (pick forward,
 * adze behind) at the top; a steel spike below the hand.
 */
export function buildIceAxe(): Group {
  const group = new Group();
  group.name = 'IceAxe';
  const b = new GeometryBuilder();
  const shaftC = new Color(0.91, 0.4, 0.16);
  const grip = new Color(0.1, 0.1, 0.11);
  const steel = new Color(0.72, 0.75, 0.8);
  const pts = [
    new Vector3(0, 0, 0.11),
    new Vector3(0, 0.004, 0.0),
    new Vector3(0, 0.018, -0.16),
    new Vector3(0, 0.03, -0.3),
    new Vector3(0, 0.022, -0.44),
    new Vector3(0, 0.012, -0.47),
  ];
  for (let i = 0; i < pts.length - 1; i++) {
    const r = i === 0 ? 0.017 : 0.0135;
    b.add(new CylinderGeometry(r, r, 1, 12).scale(0.75, 1, 1), segmentMatrix(pts[i], pts[i + 1], new Matrix4()), i === 0 ? grip : shaftC);
  }
  // Grip ribs and a finger guard just above the hand.
  for (let k = 0; k < 4; k++) b.add(new TorusGeometry(0.0165, 0.0025, 6, 14), new Matrix4().setPosition(0, 0.001, 0.09 - k * 0.022), grip);
  b.add(new TorusGeometry(0.02, 0.004, 6, 16).scale(1, 1.4, 1), new Matrix4().setPosition(0, 0.006, -0.02), grip);
  // The spike.
  b.add(new ConeGeometry(0.012, 0.05, 8).rotateX(Math.PI / 2), new Matrix4().setPosition(0, 0, 0.135), steel);
  const mesh0 = new Mesh(b.build(), vertexMat());
  mesh0.name = 'Shaft';
  group.add(mesh0);
  // The head: the outline extruded thin, the pick along +Y, up the shaft along -Z.
  const head = slab(axeHeadShape(), 0.006, 0.0015);
  head.applyMatrix4(new Matrix4().makeBasis(new Vector3(0, 1, 0), new Vector3(0, 0, -1), new Vector3(-1, 0, 0)).setPosition(0, 0.012, -0.48));
  group.add(mesh(head, STEEL, 'Head'));
  return group;
}

// ------------------------------------------------------------- glider ---

/**
 * The packed glider: a long red canvas duffel with darker ends, two
 * webbing straps round it, a carry handle on top and a zip down its back.
 */
export function buildPackedGlider(): Group {
  const group = new Group();
  group.name = 'PackedGlider';
  const bag = mesh(new CapsuleGeometry(0.062, 0.38, 8, 20).rotateZ(Math.PI / 2), CANVAS_RED, 'Bag');
  group.add(bag);
  for (const x of [-0.23, 0.23]) {
    const end = mesh(new CylinderGeometry(0.0635, 0.0635, 0.03, 20).rotateZ(Math.PI / 2), CANVAS_DARK, 'End');
    end.position.x = x;
    group.add(end);
  }
  for (const x of [-0.12, 0.12]) {
    const strap = mesh(new TorusGeometry(0.0645, 0.005, 6, 28).rotateY(Math.PI / 2), WEBBING, 'Strap');
    strap.scale.set(1, 1, 1);
    strap.position.x = x;
    group.add(strap);
    const buckle = mesh(new BoxGeometry(0.018, 0.006, 0.016), STEEL, 'Buckle');
    buckle.position.set(x, -0.068, 0);
    group.add(buckle);
  }
  const handle = mesh(new TorusGeometry(0.035, 0.006, 6, 16, Math.PI), WEBBING, 'Handle');
  handle.position.y = 0.062;
  group.add(handle);
  const zip = mesh(new BoxGeometry(0.4, 0.003, 0.006), DARK_STEEL, 'Zip');
  zip.position.set(0, 0.044, -0.045);
  zip.rotation.x = -0.8;
  group.add(zip);
  return group;
}

// -------------------------------------------------------------- pairs ---

function buildPolePair(): Group {
  const group = new Group();
  group.name = 'PolePair';
  // Side by side, a little apart, baskets level.
  for (const side of [-1, 1]) {
    const pole = buildPole();
    pole.position.x = side * 0.03;
    group.add(pole);
  }
  return group;
}

function buildAxePair(): Group {
  const group = new Group();
  group.name = 'AxePair';
  // Crossed, lying flat with the picks out to either side; drawn a little
  // stockier than life so the shafts read at slot size.
  for (const side of [-1, 1]) {
    const axe = buildIceAxe();
    axe.rotation.set(0, side * 0.42, side > 0 ? -Math.PI / 2 : Math.PI / 2, 'YXZ');
    axe.scale.set(1.9, 1.9, 1);
    group.add(axe);
  }
  return group;
}

/** Full-size model held in a hand. */
export function buildHeldItem(item: ItemId): Object3D | null {
  switch (item) {
    case 'axes':
      return buildIceAxe();
    case 'carabiner':
      return buildCarabiner();
    case 'headlamp':
      return buildHeadlamp();
    case 'thermos':
      return buildThermos();
    case 'warmer':
      return buildWarmer();
    case 'map':
      return null; // the open map is drawn by the backpack system
    case 'flare':
      return buildFlare();
    case 'glider':
      return buildPackedGlider();
    case 'leftWing':
      return buildGliderPart('LeftWing', 0.5);
    case 'rightWing':
      return buildGliderPart('RightWing', 0.5);
    case 'controlBar':
      return buildGliderPart('ControlBar', 0.5);
    case 'poles':
    default:
      return null; // poles are drawn by the pole system
  }
}

/** One part of the tutorial glider on its own, at `scale`. */
function buildGliderPart(id: GliderPartId, scale: number): Object3D {
  const part = buildGlider().parts[id];
  part.removeFromParent();
  part.position.set(0, 0, 0);
  const holder = new Group();
  holder.add(part);
  holder.scale.setScalar(scale);
  return holder;
}

/**
 * How each piece lies in its slot (slot frame: X across the tray, Y up out
 * of it toward you, Z down the tray toward you). Long things lie along the
 * slot's diagonal, faces and labels up; the icon is scaled to the slot by
 * the backpack afterwards.
 */
export function buildSlotIcon(item: ItemId): Object3D {
  let icon: Object3D;
  const diagonal = Math.PI / 4;
  switch (item) {
    case 'poles':
      icon = buildPolePair();
      icon.rotation.y = diagonal;
      break;
    case 'axes':
      icon = buildAxePair();
      // Heads to the far side of the slot.
      icon.rotation.y = Math.PI;
      break;
    case 'carabiner':
      icon = buildCarabiner();
      // Laid flat, gate up the slot.
      icon.rotation.set(0, diagonal, Math.PI / 2, 'YXZ');
      break;
    case 'headlamp':
      // Its strap cinched up, the lamp toward you and tipped to look at you.
      icon = buildHeadlamp(0.034);
      icon.rotation.set(-0.45, Math.PI, 0, 'YXZ');
      break;
    case 'thermos':
      icon = buildThermos();
      icon.rotation.y = diagonal;
      break;
    case 'warmer':
      icon = buildWarmer();
      icon.rotation.y = -0.25;
      break;
    case 'map':
      icon = buildFoldedMap();
      icon.rotation.y = 0.15;
      break;
    case 'flare':
      icon = buildFlare();
      icon.rotation.y = -diagonal;
      break;
    case 'leftWing':
    case 'rightWing':
      // Lying flat in the slot, so you see the wing's shape from above.
      icon = buildGliderPart(item === 'leftWing' ? 'LeftWing' : 'RightWing', 1);
      icon.position.y = 0.01;
      break;
    case 'controlBar':
      icon = buildGliderPart('ControlBar', 1);
      break;
    case 'glider':
    default:
      icon = buildPackedGlider();
      icon.rotation.y = diagonal;
      break;
  }
  // Centred in the slot, resting on its floor.
  const holder = new Group();
  holder.add(icon);
  icon.updateMatrixWorld(true);
  const box = new Box3().setFromObject(icon);
  const c = box.getCenter(new Vector3());
  icon.position.x -= c.x;
  icon.position.z -= c.z;
  icon.position.y -= box.min.y;
  return holder;
}

export function disposeIcon(object: Object3D): void {
  object.traverse((child) => {
    const m = child as Mesh;
    if (m.isMesh) (m.geometry as BufferGeometry).dispose();
  });
}
