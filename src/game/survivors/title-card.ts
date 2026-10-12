/**
 * Snow Survivors' title type, shared by the announcements and the upgrade
 * menu's heading: a headline in clean, spaced capitals with a glow in the
 * message's colour, a smaller line under it, on a dark ribbon that fades
 * out at both ends (so it reads against bright sky and snow alike), edged
 * with hairlines in the same colour and a small diamond at the top.
 */

/** Lighten a #rrggbb colour toward white by `k` (0..1). */
function tint(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (shift: number) => Math.round(((n >> shift) & 255) * (1 - k) + 255 * k);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

function setSpacing(ctx: CanvasRenderingContext2D, px: number): void {
  // Chromium (the Quest browser) supports it; elsewhere the text just sets tighter.
  (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${px}px`;
}

/** Break `text` in two at the space nearest its middle. */
function split(text: string): string[] {
  let best = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ' ' && (best < 0 || Math.abs(i - text.length / 2) < Math.abs(best - text.length / 2))) best = i;
  }
  return best > 0 ? [text.slice(0, best), text.slice(best + 1)] : [text];
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
  ctx.textBaseline = 'alphabetic';
  const head = title.toUpperCase();
  const margin = W * 0.12;

  // Fit the headline: one line if it will go, else two.
  let lines = [head];
  let size = maxTitle;
  const spacing = (s: number) => Math.round(s * 0.08);
  const fits = (ls: string[], s: number) => {
    ctx.font = `800 ${s}px system-ui, sans-serif`;
    setSpacing(ctx, spacing(s));
    return Math.max(...ls.map((l) => ctx.measureText(l).width)) <= W - margin * 2;
  };
  while (!fits(lines, size) && size > maxTitle * 0.7) size -= 2;
  if (!fits(lines, size) && head.includes(' ')) {
    lines = split(head);
    size = maxTitle * 0.82;
  }
  while (!fits(lines, size) && size > 28) size -= 2;
  const lineH = size * 1.02;

  const subSize = Math.round(Math.max(26, Math.min(40, size * 0.42)));
  const subText = sub.toUpperCase();
  let subFont = subSize;
  if (subText) {
    ctx.font = `600 ${subFont}px system-ui, sans-serif`;
    setSpacing(ctx, 4);
    while (ctx.measureText(subText).width > W - margin * 2 && subFont > 18) {
      subFont -= 1;
      ctx.font = `600 ${subFont}px system-ui, sans-serif`;
    }
  }
  const gap = subText ? subFont * 0.75 : 0;
  const block = lineH * lines.length + (subText ? gap + subFont : 0);
  const pad = 30;
  const top = Math.max(pad + 6, (H - block) / 2);
  const bandTop = top - pad;
  const bandBot = top + block + pad * 0.8;

  // The ribbon, fading out at both ends.
  const band = ctx.createLinearGradient(0, 0, W, 0);
  band.addColorStop(0, 'rgba(5, 12, 30, 0)');
  band.addColorStop(0.2, 'rgba(5, 12, 30, 0.66)');
  band.addColorStop(0.8, 'rgba(5, 12, 30, 0.66)');
  band.addColorStop(1, 'rgba(5, 12, 30, 0)');
  ctx.fillStyle = band;
  ctx.fillRect(0, bandTop, W, bandBot - bandTop);
  // Hairlines in the accent, and a diamond on the top one.
  const rule = ctx.createLinearGradient(0, 0, W, 0);
  rule.addColorStop(0.08, 'rgba(255,255,255,0)');
  rule.addColorStop(0.5, accent);
  rule.addColorStop(0.92, 'rgba(255,255,255,0)');
  ctx.fillStyle = rule;
  ctx.fillRect(0, bandTop, W, 3);
  ctx.fillRect(0, bandBot - 2, W, 2);
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.moveTo(W / 2, bandTop - 9);
  ctx.lineTo(W / 2 + 9, bandTop + 1.5);
  ctx.lineTo(W / 2, bandTop + 12);
  ctx.lineTo(W / 2 - 9, bandTop + 1.5);
  ctx.closePath();
  ctx.fill();

  // The headline: white with a glow of its colour, then crisp on top.
  ctx.font = `800 ${size}px system-ui, sans-serif`;
  setSpacing(ctx, spacing(size));
  lines.forEach((l, n) => {
    const base = top + lineH * (n + 1) - size * 0.14;
    ctx.shadowColor = accent;
    ctx.shadowBlur = size * 0.35;
    ctx.fillStyle = tint(accent, 0.55);
    ctx.fillText(l, W / 2, base);
    ctx.shadowBlur = 0;
    const face = ctx.createLinearGradient(0, base - size * 0.75, 0, base);
    face.addColorStop(0, '#ffffff');
    face.addColorStop(1, tint(accent, 0.72));
    ctx.fillStyle = face;
    ctx.fillText(l, W / 2, base);
  });

  // The line under it, smaller and spaced, in a light tint of the colour.
  if (subText) {
    ctx.font = `600 ${subFont}px system-ui, sans-serif`;
    setSpacing(ctx, 4);
    ctx.fillStyle = tint(accent, 0.35);
    ctx.fillText(subText, W / 2, top + lineH * lines.length + gap + subFont * 0.78);
  }
  ctx.restore();
}
