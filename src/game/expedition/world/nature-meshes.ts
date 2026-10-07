/**
 * Geometry for the natural scatter: stylised snow-laden spruces (solid
 * tiers with crisp snow caps: no alpha-tested cards, cheap to overdraw),
 * lumpy boulders, and faceted serac towers.
 */

import {
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Float32BufferAttribute,
  IcosahedronGeometry,
  Vector3,
} from '@iwsdk/core';
import { mulberry32, valueNoise } from '../../terrain.js';

// ------------------------------------------------------------- spruce -----

const SNOW = new Color(0.9, 0.93, 0.98);
const NEEDLE_LIGHT = new Color(0.12, 0.22, 0.15);
const NEEDLE_DARK = new Color(0.045, 0.1, 0.065);
const UNDER = new Color(0.03, 0.06, 0.04);
const BARK = new Color(0.2, 0.13, 0.09);

class TriBuilder {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly col: number[] = [];
  private readonly e1 = new Vector3();
  private readonly e2 = new Vector3();
  private readonly fn = new Vector3();

  /** Triangle whose winding is fixed to face `facing`; vertex normals given. */
  tri(
    a: Vector3, b: Vector3, c: Vector3,
    na: Vector3, nb: Vector3, nc: Vector3,
    ca: Color, cb: Color, cc: Color,
    facing: Vector3,
  ): void {
    this.e1.subVectors(b, a);
    this.e2.subVectors(c, a);
    this.fn.crossVectors(this.e1, this.e2);
    if (this.fn.dot(facing) < 0) {
      [b, c] = [c, b];
      [nb, nc] = [nc, nb];
      [cb, cc] = [cc, cb];
    }
    for (const [p, n, col] of [
      [a, na, ca],
      [b, nb, cb],
      [c, nc, cc],
    ] as const) {
      this.pos.push(p.x, p.y, p.z);
      this.nor.push(n.x, n.y, n.z);
      this.col.push(col.r, col.g, col.b);
    }
  }

  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    return g;
  }
}

/** Unit-height spruce (base at the origin, crown at y = 1). */
export function spruceGeometry(lod: 'hi' | 'lo'): BufferGeometry {
  const tb = new TriBuilder();
  const segs = lod === 'hi' ? 6 : 5;
  const tiers =
    lod === 'hi'
      ? [
          { R: 0.3, yb: 0.1, yt: 0.5 },
          { R: 0.245, yb: 0.3, yt: 0.66 },
          { R: 0.185, yb: 0.48, yt: 0.82 },
          { R: 0.12, yb: 0.66, yt: 1.0 },
        ]
      : [
          { R: 0.29, yb: 0.1, yt: 0.58 },
          { R: 0.21, yb: 0.38, yt: 0.8 },
          { R: 0.13, yb: 0.62, yt: 1.0 },
        ];
  const up = new Vector3(0, 1, 0);
  const down = new Vector3(0, -1, 0);
  tiers.forEach((t, k) => {
    const apex = new Vector3(0, t.yt, 0);
    const snowY = t.yt - 0.5 * (t.yt - t.yb);
    const s: Vector3[] = [];
    const r: Vector3[] = [];
    const ns: Vector3[] = [];
    const nr: Vector3[] = [];
    const out: Vector3[] = [];
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2 + k * 0.9;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      const jag = i % 2 ? 0.82 : 1;
      s.push(new Vector3(c * t.R * 0.52, snowY + (i % 2 ? 0.012 : -0.01), sn * t.R * 0.52));
      r.push(new Vector3(c * t.R * jag, t.yb + (i % 2 ? 0.035 : 0), sn * t.R * jag));
      ns.push(new Vector3(c * 0.55, 1, sn * 0.55).normalize());
      nr.push(new Vector3(c, 0.5, sn).normalize());
      out.push(new Vector3(c, 0.6, sn));
    }
    const cUnder = new Vector3(0, t.yb + 0.05, 0);
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % segs;
      const mid = new Vector3().addVectors(out[i], out[j]);
      // Snow cap.
      tb.tri(apex, s[i], s[j], up, ns[i], ns[j], SNOW, SNOW, SNOW, mid.clone().setY(2));
      // Needle band.
      tb.tri(s[i], r[i], r[j], nr[i], nr[i], nr[j], NEEDLE_LIGHT, NEEDLE_DARK, NEEDLE_DARK, mid);
      tb.tri(s[i], r[j], s[j], nr[i], nr[j], nr[j], NEEDLE_LIGHT, NEEDLE_DARK, NEEDLE_LIGHT, mid);
      // Shadowy underside.
      if (lod === 'hi') tb.tri(r[i], r[j], cUnder, down, down, down, UNDER, UNDER, UNDER, down);
    }
  });
  if (lod === 'hi') {
    const trunk = new CylinderGeometry(0.011, 0.026, 0.42, 5, 1, true).toNonIndexed();
    trunk.translate(0, 0.16, 0);
    const p = trunk.getAttribute('position');
    const n = trunk.getAttribute('normal');
    const tmp = [new Vector3(), new Vector3(), new Vector3()];
    const tn = [new Vector3(), new Vector3(), new Vector3()];
    for (let i = 0; i < p.count; i += 3) {
      for (let k = 0; k < 3; k++) {
        tmp[k].fromBufferAttribute(p, i + k);
        tn[k].fromBufferAttribute(n, i + k);
      }
      const facing = new Vector3().addVectors(tn[0], tn[1]).add(tn[2]);
      tb.tri(tmp[0], tmp[1], tmp[2], tn[0], tn[1], tn[2], BARK, BARK, BARK, facing);
    }
    trunk.dispose();
  }
  return tb.geometry();
}

// ------------------------------------------------------------- rocks ------

/** Weathered boulder of unit radius (squashed), as world-builders' rocks. */
export function boulderGeometry(detail: number, seed: number): BufferGeometry {
  const geo = new IcosahedronGeometry(1, detail);
  const pos = geo.getAttribute('position');
  const nor = geo.getAttribute('normal');
  for (let v = 0; v < pos.count; v++) {
    const x = pos.getX(v);
    const y = pos.getY(v);
    const z = pos.getZ(v);
    const lump = 0.22 * valueNoise(x * 1.6 + seed, z * 1.6 + y * 1.3);
    const facet = 0.1 * Math.abs(valueNoise(x * 4.1 - seed, y * 4.3 + z * 2.2));
    const f = 1 + lump - facet;
    pos.setXYZ(v, x * f, y * f * 0.72, z * f);
    const len = Math.hypot(x, y / 0.72, z);
    nor.setXYZ(v, x / len, y / 0.72 / len, z / len);
  }
  geo.computeBoundingSphere();
  return geo;
}

// ------------------------------------------------------------- seracs -----

/**
 * A faceted ice tower, base at y = 0: a tapering block with a broken crown,
 * leaning slightly. Non-indexed so it shades flat.
 */
export function seracGeometry(seed: number, width: number, height: number, depth: number): BufferGeometry {
  const rand = mulberry32(Math.floor(seed * 1000) + 7);
  const box = new BoxGeometry(width, height, depth, 2, 4, 2);
  box.translate(0, height / 2, 0);
  const pos = box.getAttribute('position');
  const lean = (rand() - 0.5) * 0.18;
  const crown = rand() * 10;
  for (let v = 0; v < pos.count; v++) {
    const x = pos.getX(v);
    const y = pos.getY(v);
    const z = pos.getZ(v);
    const t = y / height;
    const nx = valueNoise(x * 0.7 + seed, y * 0.35 + z * 0.4);
    const nz = valueNoise(z * 0.7 - seed, y * 0.35 + x * 0.4 + 9);
    const taper = 1 - 0.28 * t;
    let yy = y;
    if (t > 0.99) yy += (valueNoise(x * 0.9 + crown, z * 0.9) * 0.5 - 0.1) * height * 0.28;
    pos.setXYZ(v, (x + nx * width * 0.16) * taper + lean * y, yy, (z + nz * depth * 0.16) * taper);
  }
  const flat = box.toNonIndexed();
  box.dispose();
  flat.deleteAttribute('uv');
  flat.computeVertexNormals();
  return flat;
}

const ICE_TOP = new Color(0.92, 0.95, 0.99);
const ICE_HI = new Color(0.6, 0.8, 0.93);
const ICE_LO = new Color(0.36, 0.6, 0.82);
const ICE_STREAK = new Color(0.22, 0.46, 0.72);

/** Vertex colour for serac ice: snow on top facets, blue sides darkening down. */
export function seracColor(baseY: number, height: number) {
  return (p: Vector3, n: Vector3, out: Color): void => {
    if (n.y > 0.55) {
      out.copy(ICE_TOP);
      return;
    }
    const t = Math.max(0, Math.min(1, (p.y - baseY) / height));
    out.copy(ICE_LO).lerp(ICE_HI, t);
    const streak = valueNoise(p.x * 0.35 + p.z * 0.35, p.y * 0.05);
    if (streak > 0.45) out.lerp(ICE_STREAK, Math.min(1, (streak - 0.45) * 3));
  };
}
