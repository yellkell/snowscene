/**
 * Snow Survivors' titles, shared by the announcements and the heading over
 * the upgrade cards: the headline in the run's lettering (lettering.ts:
 * chunky capitals outlined in the cards' night blue, glowing in the
 * message's colour), a smaller spaced line under it, and a pair of the
 * cards' diamond pips either side. No ribbon or panel behind it.
 */

import { drawLettering, fitLettering, tint } from './lettering.js';

/** Break `text` in two at the space nearest its middle. */
function split(text: string): string[] {
  let best = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ' ' && (best < 0 || Math.abs(i - text.length / 2) < Math.abs(best - text.length / 2))) best = i;
  }
  return best > 0 ? [text.slice(0, best), text.slice(best + 1)] : [text];
}

/** One of the cards' level pips: a diamond, outlined, in the colour. */
function pip(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, accent: string): void {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r * 0.78, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r * 0.78, y);
  ctx.closePath();
  ctx.shadowColor = accent;
  ctx.shadowBlur = r * 1.6;
  ctx.lineWidth = r * 0.55;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#0c1834';
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = tint(accent, 0.45);
  ctx.fill();
  ctx.restore();
}

/**
 * Draw a title into the whole canvas (W x H), centred. `maxTitle` is the
 * headline's largest size in pixels; it shrinks (and breaks in two) to fit.
 */
export function drawTitle(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  title: string,
  sub: string,
  accent: string,
  maxTitle = 96,
): void {
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.textAlign = 'center';
  const head = title.toUpperCase();
  // Room either side for the pips, the outline and the glow.
  const width = W * 0.74;

  // Fit the headline: one line if it will go, else two.
  let lines = [head];
  let size = fitLettering(ctx, head, width, maxTitle, maxTitle * 0.7);
  if (ctx.measureText(head).width > width && head.includes(' ')) {
    lines = split(head);
    const longest = lines.reduce((a, b) => (b.length > a.length ? b : a));
    size = fitLettering(ctx, longest, width, maxTitle * 0.8, 28);
  } else if (ctx.measureText(head).width > width) {
    size = fitLettering(ctx, head, width, size, 28);
  }
  const lineH = size * 0.98;

  const subText = sub.toUpperCase();
  let subSize = 0;
  if (subText) subSize = fitLettering(ctx, subText, W * 0.86, Math.round(Math.max(26, Math.min(42, size * 0.4))), 18, true);
  const gap = subText ? subSize * 0.55 : 0;
  // Cap height is about 0.72 of the size; centre the whole block.
  const block = lineH * (lines.length - 1) + size * 0.72 + (subText ? gap + subSize * 0.72 : 0);
  const top = (H - block) / 2;

  lines.forEach((l, n) => {
    const base = top + size * 0.72 + lineH * n;
    drawLettering(ctx, l, W / 2, base, size, accent);
    if (n === 0) {
      // The cards' pips either side of the first line.
      const reach = Math.min(W / 2 - size * 0.16, size * 0.34 + measureLine(ctx, l, size) / 2);
      const py = base - size * 0.36;
      pip(ctx, W / 2 - reach, py, size * 0.11, accent);
      pip(ctx, W / 2 + reach, py, size * 0.11, accent);
    }
  });

  if (subText) {
    const base = top + size * 0.72 + lineH * (lines.length - 1) + gap + subSize * 0.72;
    drawLettering(ctx, subText, W / 2, base, subSize, accent, true);
  }
  ctx.restore();
}

/** Width of a headline line in the lettering at `size`. */
function measureLine(ctx: CanvasRenderingContext2D, text: string, size: number): number {
  fitLettering(ctx, text, Infinity, size, size);
  return ctx.measureText(text).width;
}
