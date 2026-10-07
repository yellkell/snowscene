/**
 * One canvas texture holding every sign board on the mountain (2 columns x
 * 8 rows of 512 x 128 cells), so all signs share a material and merge into
 * one mesh per chunk. Cells are painted on demand.
 */

import { CanvasTexture, SRGBColorSpace } from '@iwsdk/core';

const W = 1024;
const H = 1024;
const CW = 512;
const CH = 128;
const COLS = W / CW;
const ROWS = H / CH;

export class SignAtlas {
  readonly texture: CanvasTexture;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly cells = new Map<string, number>();

  constructor() {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    this.ctx = canvas.getContext('2d')!;
    this.ctx.fillStyle = '#6b4a2f';
    this.ctx.fillRect(0, 0, W, H);
    this.texture = new CanvasTexture(canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.anisotropy = 8;
  }

  /** UV rectangle [u0, v0, u1, v1] of the board showing these lines. */
  rect(lines: readonly [string, string]): [number, number, number, number] {
    const key = lines.join('\n');
    let index = this.cells.get(key);
    if (index === undefined) {
      index = Math.min(this.cells.size, COLS * ROWS - 1);
      this.cells.set(key, index);
      this.paint(index, lines);
    }
    const cx = index % COLS;
    const cy = Math.floor(index / COLS);
    const inset = 2;
    const u0 = (cx * CW + inset) / W;
    const u1 = ((cx + 1) * CW - inset) / W;
    // Canvas rows go down; texture v goes up (flipY).
    const v1 = 1 - (cy * CH + inset) / H;
    const v0 = 1 - ((cy + 1) * CH - inset) / H;
    return [u0, v0, u1, v1];
  }

  private paint(index: number, lines: readonly [string, string]): void {
    const ctx = this.ctx;
    const x0 = (index % COLS) * CW;
    const y0 = Math.floor(index / COLS) * CH;
    ctx.save();
    ctx.translate(x0, y0);
    // Weathered wood with grain.
    const g = ctx.createLinearGradient(0, 0, 0, CH);
    g.addColorStop(0, '#80593a');
    g.addColorStop(1, '#6a472b');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, CW, CH);
    ctx.strokeStyle = 'rgba(30,16,6,0.22)';
    ctx.lineWidth = 2;
    for (let y = 10; y < CH; y += 13) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(CW * 0.3, y + 4, CW * 0.6, y - 5, CW, y + 2);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(40,22,8,0.75)';
    ctx.lineWidth = 7;
    ctx.strokeRect(4, 4, CW - 8, CH - 8);
    ctx.fillStyle = '#fff4dc';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const fit = (text: string, size: number, weight: number): void => {
      let s = size;
      ctx.font = `${weight} ${s}px Georgia, 'Times New Roman', serif`;
      while (ctx.measureText(text).width > CW * 0.9 && s > 10) {
        s -= 2;
        ctx.font = `${weight} ${s}px Georgia, 'Times New Roman', serif`;
      }
    };
    fit(lines[0], 50, 700);
    ctx.fillText(lines[0], CW / 2, CH * 0.38);
    fit(lines[1], 26, 600);
    ctx.fillStyle = '#f3e3c2';
    ctx.fillText(lines[1], CW / 2, CH * 0.76);
    ctx.restore();
    this.texture.needsUpdate = true;
  }
}
