/**
 * Snow Survivors' upgrade icons, drawn as vector shapes on the cards'
 * canvases (no font glyphs or emoji, which differ from browser to browser).
 * Every icon is drawn white with a dark outline, centred on (cx, cy) and
 * fitting a circle of radius r.
 */

type Ctx = CanvasRenderingContext2D;

/** A path, filled white and outlined dark. */
function ink(ctx: Ctx, r: number, path: () => void, stroke = true): void {
  ctx.beginPath();
  path();
  if (stroke) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = r * 0.12;
    ctx.strokeStyle = 'rgba(8, 16, 36, 0.75)';
    ctx.stroke();
  }
  ctx.fillStyle = '#ffffff';
  ctx.fill();
}

/** A stroked line or curve in white over a dark outline. */
function line(ctx: Ctx, width: number, path: () => void): void {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  path();
  ctx.strokeStyle = 'rgba(8, 16, 36, 0.75)';
  ctx.lineWidth = width * 1.7;
  ctx.stroke();
  ctx.beginPath();
  path();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = width;
  ctx.stroke();
}

function star(ctx: Ctx, cx: number, cy: number, points: number, outer: number, inner: number, turn = -Math.PI / 2): void {
  for (let k = 0; k < points * 2; k++) {
    const a = turn + (k * Math.PI) / points;
    const rr = k % 2 ? inner : outer;
    if (k === 0) ctx.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    else ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  ctx.closePath();
}

function heart(ctx: Ctx, cx: number, cy: number, r: number): void {
  ctx.moveTo(cx, cy + r * 0.85);
  ctx.bezierCurveTo(cx - r * 1.25, cy + r * 0.05, cx - r * 0.75, cy - r * 0.95, cx, cy - r * 0.35);
  ctx.bezierCurveTo(cx + r * 0.75, cy - r * 0.95, cx + r * 1.25, cy + r * 0.05, cx, cy + r * 0.85);
  ctx.closePath();
}

export function drawIcon(ctx: Ctx, id: string, cx: number, cy: number, r: number): void {
  ctx.save();
  switch (id) {
    case 'icicles':
      // Three icicles hanging from a ledge of ice.
      ink(ctx, r, () => {
        ctx.moveTo(cx - r * 0.85, cy - r * 0.7);
        ctx.lineTo(cx + r * 0.85, cy - r * 0.7);
        ctx.lineTo(cx + r * 0.62, cy - r * 0.45);
        ctx.lineTo(cx + r * 0.45, cy + r * 0.35);
        ctx.lineTo(cx + r * 0.28, cy - r * 0.45);
        ctx.lineTo(cx + r * 0.16, cy - r * 0.45);
        ctx.lineTo(cx, cy + r * 0.9);
        ctx.lineTo(cx - r * 0.16, cy - r * 0.45);
        ctx.lineTo(cx - r * 0.28, cy - r * 0.45);
        ctx.lineTo(cx - r * 0.45, cy + r * 0.15);
        ctx.lineTo(cx - r * 0.62, cy - r * 0.45);
        ctx.closePath();
      });
      break;
    case 'blades':
      // Two crossed swords.
      for (const s of [-1, 1]) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate((s * Math.PI) / 4);
        ink(ctx, r, () => {
          ctx.moveTo(0, -r * 0.95);
          ctx.lineTo(r * 0.11, -r * 0.75);
          ctx.lineTo(r * 0.11, r * 0.35);
          ctx.lineTo(r * 0.36, r * 0.35);
          ctx.lineTo(r * 0.36, r * 0.47);
          ctx.lineTo(r * 0.08, r * 0.47);
          ctx.lineTo(r * 0.08, r * 0.8);
          ctx.lineTo(-r * 0.08, r * 0.8);
          ctx.lineTo(-r * 0.08, r * 0.47);
          ctx.lineTo(-r * 0.36, r * 0.47);
          ctx.lineTo(-r * 0.36, r * 0.35);
          ctx.lineTo(-r * 0.11, r * 0.35);
          ctx.lineTo(-r * 0.11, -r * 0.75);
          ctx.closePath();
        });
        ctx.restore();
      }
      break;
    case 'compass':
      ink(ctx, r, () => star(ctx, cx, cy, 8, r * 0.95, r * 0.36));
      break;
    case 'nova':
      // A ring with sparks flying off it.
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        line(ctx, r * 0.12, () => {
          ctx.moveTo(cx + Math.cos(a) * r * 0.62, cy + Math.sin(a) * r * 0.62);
          ctx.lineTo(cx + Math.cos(a) * r * 0.95, cy + Math.sin(a) * r * 0.95);
        });
      }
      line(ctx, r * 0.16, () => ctx.arc(cx, cy, r * 0.42, 0, Math.PI * 2));
      break;
    case 'lightning':
      ink(ctx, r, () => {
        ctx.moveTo(cx + r * 0.2, cy - r * 0.95);
        ctx.lineTo(cx - r * 0.5, cy + r * 0.1);
        ctx.lineTo(cx - r * 0.02, cy + r * 0.1);
        ctx.lineTo(cx - r * 0.25, cy + r * 0.95);
        ctx.lineTo(cx + r * 0.55, cy - r * 0.2);
        ctx.lineTo(cx + r * 0.06, cy - r * 0.2);
        ctx.closePath();
      });
      break;
    case 'might':
      // A spiked burst: harder hits.
      ink(ctx, r, () => star(ctx, cx, cy, 10, r * 0.95, r * 0.5));
      break;
    case 'haste':
      for (const dx of [-0.32, 0.22]) {
        ink(ctx, r, () => {
          ctx.moveTo(cx + r * (dx - 0.3), cy - r * 0.7);
          ctx.lineTo(cx + r * (dx + 0.08), cy - r * 0.7);
          ctx.lineTo(cx + r * (dx + 0.5), cy);
          ctx.lineTo(cx + r * (dx + 0.08), cy + r * 0.7);
          ctx.lineTo(cx + r * (dx - 0.3), cy + r * 0.7);
          ctx.lineTo(cx + r * (dx + 0.12), cy);
          ctx.closePath();
        });
      }
      break;
    case 'area':
      line(ctx, r * 0.1, () => ctx.arc(cx, cy, r * 0.88, 0, Math.PI * 2));
      line(ctx, r * 0.12, () => ctx.arc(cx, cy, r * 0.55, 0, Math.PI * 2));
      ink(ctx, r, () => ctx.arc(cx, cy, r * 0.2, 0, Math.PI * 2));
      break;
    case 'amount':
      // Three arrows fanning out.
      for (const a of [-0.45, 0, 0.45]) {
        ctx.save();
        ctx.translate(cx, cy + r * 0.75);
        ctx.rotate(a);
        line(ctx, r * 0.11, () => {
          ctx.moveTo(0, 0);
          ctx.lineTo(0, -r * 1.35);
        });
        ink(ctx, r, () => {
          ctx.moveTo(0, -r * 1.6);
          ctx.lineTo(r * 0.2, -r * 1.25);
          ctx.lineTo(-r * 0.2, -r * 1.25);
          ctx.closePath();
        });
        ctx.restore();
      }
      break;
    case 'magnet':
      // A horseshoe magnet, its poles banded.
      line(ctx, r * 0.36, () => ctx.arc(cx, cy - r * 0.05, r * 0.5, Math.PI, 0, true));
      for (const s of [-1, 1]) {
        line(ctx, r * 0.36, () => {
          ctx.moveTo(cx + s * r * 0.5, cy - r * 0.05);
          ctx.lineTo(cx + s * r * 0.5, cy - r * 0.55);
        });
        ctx.fillStyle = 'rgba(8, 16, 36, 0.75)';
        ctx.fillRect(cx + s * r * 0.5 - r * 0.2, cy - r * 0.45, r * 0.4, r * 0.08);
      }
      break;
    case 'vitality':
    case 'heart':
      ink(ctx, r, () => heart(ctx, cx, cy, r * 0.95));
      break;
    case 'regen':
      ink(ctx, r, () => heart(ctx, cx, cy, r * 0.95));
      ctx.fillStyle = 'rgba(8, 16, 36, 0.8)';
      ctx.fillRect(cx - r * 0.1, cy - r * 0.42, r * 0.2, r * 0.7);
      ctx.fillRect(cx - r * 0.35, cy - r * 0.17, r * 0.7, r * 0.2);
      break;
    case 'armor':
      ink(ctx, r, () => {
        ctx.moveTo(cx, cy - r * 0.95);
        ctx.quadraticCurveTo(cx + r * 0.45, cy - r * 0.65, cx + r * 0.8, cy - r * 0.7);
        ctx.quadraticCurveTo(cx + r * 0.85, cy + r * 0.45, cx, cy + r * 0.95);
        ctx.quadraticCurveTo(cx - r * 0.85, cy + r * 0.45, cx - r * 0.8, cy - r * 0.7);
        ctx.quadraticCurveTo(cx - r * 0.45, cy - r * 0.65, cx, cy - r * 0.95);
        ctx.closePath();
      });
      ctx.fillStyle = 'rgba(8, 16, 36, 0.35)';
      ctx.beginPath();
      ctx.moveTo(cx, cy - r * 0.95);
      ctx.lineTo(cx, cy + r * 0.95);
      ctx.quadraticCurveTo(cx + r * 0.85, cy + r * 0.45, cx + r * 0.8, cy - r * 0.7);
      ctx.quadraticCurveTo(cx + r * 0.45, cy - r * 0.65, cx, cy - r * 0.95);
      ctx.fill();
      break;
    case 'pole':
      // A ski pole planted on a slant, its basket in the snow, and a speed line.
      line(ctx, r * 0.12, () => {
        ctx.moveTo(cx - r * 0.55, cy - r * 0.85);
        ctx.lineTo(cx + r * 0.45, cy + r * 0.85);
      });
      line(ctx, r * 0.24, () => {
        ctx.moveTo(cx - r * 0.6, cy - r * 0.95);
        ctx.lineTo(cx - r * 0.42, cy - r * 0.62);
      });
      line(ctx, r * 0.08, () => ctx.ellipse(cx + r * 0.3, cy + r * 0.6, r * 0.28, r * 0.1, 0.5, 0, Math.PI * 2));
      for (const k of [0, 1]) {
        line(ctx, r * 0.08, () => {
          ctx.moveTo(cx - r * (0.95 - k * 0.1), cy + r * (0.05 + k * 0.32));
          ctx.lineTo(cx - r * (0.35 - k * 0.1), cy + r * (0.05 + k * 0.32));
        });
      }
      break;
    case 'glide':
      for (const dy of [-0.45, 0, 0.45]) {
        line(ctx, r * 0.13, () => {
          ctx.moveTo(cx - r * 0.85, cy + r * dy);
          ctx.bezierCurveTo(cx - r * 0.4, cy + r * (dy - 0.3), cx, cy + r * (dy + 0.3), cx + r * 0.45, cy + r * dy);
          ctx.quadraticCurveTo(cx + r * 0.75, cy + r * (dy - 0.2), cx + r * 0.85, cy + r * (dy - 0.05));
        });
      }
      break;
    case 'mortar':
      // A snowball at the top of its arc, the arc dotted behind it.
      for (let k = 0; k < 4; k++) {
        const t = k / 4;
        ink(ctx, r, () => ctx.arc(cx - r * 0.85 + t * r * 0.7, cy + r * 0.75 - Math.sin(t * Math.PI * 0.5) * r * 0.9, r * (0.06 + 0.03 * k), 0, Math.PI * 2), false);
      }
      ink(ctx, r, () => ctx.arc(cx + r * 0.25, cy - r * 0.2, r * 0.55, 0, Math.PI * 2));
      ctx.fillStyle = 'rgba(8, 16, 36, 0.25)';
      ctx.beginPath();
      ctx.arc(cx + r * 0.38, cy - r * 0.05, r * 0.36, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'aura':
      // A whirl of blizzard.
      line(ctx, r * 0.12, () => {
        for (let k = 0; k <= 40; k++) {
          const t = k / 40;
          const a = t * Math.PI * 3.2;
          const rr = r * (0.12 + 0.8 * t);
          if (k === 0) ctx.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
          else ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
        }
      });
      break;
    case 'discs':
      // A toothed disc with a hole, and a swoosh round it.
      ink(ctx, r, () => star(ctx, cx, cy, 6, r * 0.8, r * 0.58, 0));
      ctx.fillStyle = 'rgba(8, 16, 36, 0.8)';
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.2, 0, Math.PI * 2);
      ctx.fill();
      line(ctx, r * 0.07, () => ctx.arc(cx, cy, r * 0.98, -2.6, -1.2));
      break;
    case 'spikes':
      // Crystals bursting up out of the ground.
      line(ctx, r * 0.1, () => {
        ctx.moveTo(cx - r * 0.95, cy + r * 0.7);
        ctx.lineTo(cx + r * 0.95, cy + r * 0.7);
      });
      for (const [dx, h, w] of [
        [0, 1.6, 0.26],
        [-0.48, 1.05, 0.2],
        [0.48, 1.15, 0.2],
      ]) {
        ink(ctx, r, () => {
          ctx.moveTo(cx + r * (dx - w), cy + r * 0.66);
          ctx.lineTo(cx + r * dx, cy + r * (0.66 - h));
          ctx.lineTo(cx + r * (dx + w), cy + r * 0.66);
          ctx.closePath();
        });
      }
      break;
    default:
      // Evolutions and anything else: a great star.
      ink(ctx, r, () => star(ctx, cx, cy, 5, r * 0.98, r * 0.42));
      break;
  }
  ctx.restore();
}
