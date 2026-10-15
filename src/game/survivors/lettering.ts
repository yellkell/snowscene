/**
 * Snow Survivors' lettering, cut to match the upgrade cards: chunky Lilita
 * One capitals (bundled in public/fonts, SIL Open Font License) with a
 * thick outline in the cards' deep night blue, a hard shadow under it, an
 * edge of the message's colour inside the outline, a soft glow of it all
 * round, and a face that runs from white into that colour. It needs no
 * panel behind it: the outline carries it against bright snow and dark sky
 * alike.
 */

const FAMILY = 'Lilita One';
/** The display face, falling back to the heaviest system faces while it loads. */
export const DISPLAY_FONT = `'${FAMILY}', 'Arial Black', system-ui, sans-serif`;

/** The cards' night blues: the outline, and the shadow under it. */
const NIGHT = '#0c1834';
const NIGHT_DEEP = '#040a1a';

let loading: Promise<void> | null = null;

/** Start loading the display face (once); resolves when it is ready to draw with. */
export function loadDisplayFont(): Promise<void> {
  if (loading) return loading;
  if (typeof FontFace === 'undefined' || typeof document === 'undefined') {
    loading = Promise.resolve();
    return loading;
  }
  const face = new FontFace(FAMILY, `url(${import.meta.env.BASE_URL}fonts/LilitaOne-Regular.woff2)`);
  loading = face
    .load()
    .then((f) => {
      document.fonts.add(f);
    })
    .catch(() => {
      // Offline or blocked: the fallback faces still draw the same style.
    });
  return loading;
}

/** The canvas font string for the display face at `size` pixels. */
export function displayFont(size: number): string {
  return `${Math.round(size)}px ${DISPLAY_FONT}`;
}

export function setSpacing(ctx: CanvasRenderingContext2D, px: number): void {
  // Chromium (the Quest browser) supports it; elsewhere the text just sets tighter.
  (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${px}px`;
}

/** Mix a #rrggbb colour toward white (k > 0) or black (k < 0). */
export function tint(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (shift: number) => {
    const v = (n >> shift) & 255;
    return Math.round(k >= 0 ? v + (255 - v) * k : v * (1 + k));
  };
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

/** Letter spacing for the display face at `size` (sub lines are spaced wider). */
export function spacingFor(size: number, sub = false): number {
  return Math.round(size * (sub ? 0.09 : 0.035));
}

/**
 * Largest size (from `max` down to `min`) at which `text` fits in `width`.
 * Leaves the font set to it.
 */
export function fitLettering(ctx: CanvasRenderingContext2D, text: string, width: number, max: number, min: number, sub = false): number {
  let size = max;
  for (;;) {
    ctx.font = displayFont(size);
    setSpacing(ctx, spacingFor(size, sub));
    if (ctx.measureText(text).width <= width || size <= min) return size;
    size -= 2;
  }
}

/**
 * Draw `text` in the lettering at (x, baseline y), aligned by the context's
 * textAlign. `sub` is the smaller line style: wider spaced, a lighter face,
 * a gentler glow.
 */
export function drawLettering(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  accent: string,
  sub = false,
): void {
  if (!text) return;
  ctx.save();
  ctx.font = displayFont(size);
  setSpacing(ctx, spacingFor(size, sub));
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  const outline = size * (sub ? 0.24 : 0.19);
  const drop = size * (sub ? 0.05 : 0.075);

  // A soft glow of the colour all round.
  ctx.shadowColor = accent;
  ctx.shadowBlur = size * (sub ? 0.22 : 0.42);
  ctx.strokeStyle = NIGHT;
  ctx.lineWidth = outline;
  ctx.strokeText(text, x, y);
  ctx.shadowBlur = 0;
  ctx.shadowColor = 'transparent';

  // A hard shadow under it, then the outline itself.
  ctx.fillStyle = NIGHT_DEEP;
  ctx.strokeStyle = NIGHT_DEEP;
  ctx.fillText(text, x, y + drop);
  ctx.strokeText(text, x, y + drop);
  ctx.strokeStyle = NIGHT;
  ctx.strokeText(text, x, y);

  // An edge of the colour just inside the outline.
  ctx.strokeStyle = tint(accent, -0.2);
  ctx.lineWidth = size * (sub ? 0.07 : 0.065);
  ctx.strokeText(text, x, y);

  // The face: white at the top, running into the colour.
  const face = ctx.createLinearGradient(0, y - size * 0.74, 0, y + size * 0.04);
  if (sub) {
    face.addColorStop(0, tint(accent, 0.85));
    face.addColorStop(1, tint(accent, 0.5));
  } else {
    face.addColorStop(0, '#ffffff');
    face.addColorStop(0.42, tint(accent, 0.72));
    face.addColorStop(1, tint(accent, 0.18));
  }
  ctx.fillStyle = face;
  ctx.fillText(text, x, y);
  ctx.restore();
}
