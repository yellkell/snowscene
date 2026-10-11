/**
 * Snow Survivors' upgrades. Everything you pick up makes you stronger at
 * once: no menu, no pause (it is VR; you are busy). Level-ups, orbs dropped
 * by elites and treasure chests all draw from the same pool, weighted
 * toward levelling what you already have.
 */

export type WeaponId = 'icicles' | 'blades' | 'compass' | 'nova' | 'lightning';

export const WEAPONS: Record<WeaponId, { name: string; color: string; blurb: string }> = {
  icicles: { name: 'Icicle Volley', color: '#8fe3ff', blurb: 'Shards at the nearest' },
  blades: { name: 'Orbit Blades', color: '#ffe066', blurb: 'Swords spin round you' },
  compass: { name: 'Compass Shards', color: '#7dffb2', blurb: 'Fires every way at once' },
  nova: { name: 'Frost Nova', color: '#b9a4ff', blurb: 'A blast ring all round' },
  lightning: { name: 'Chain Lightning', color: '#fff27a', blurb: 'Leaps through the crowd' },
};

export const MAX_WEAPON_LEVEL = 8;
const MAX_PASSIVE = 6;

export interface Stats {
  weapons: Record<WeaponId, number>;
  /** Damage, cooldowns, area and extra projectiles (multipliers / counts). */
  might: number;
  haste: number;
  area: number;
  amount: number;
  /** Crystal pull radius (m). */
  magnet: number;
  maxHp: number;
  regen: number;
  /** Share of bite damage that gets through. */
  armor: number;
  /** Movement levels: pole power and glide wax. */
  pole: number;
  glide: number;
  /** Passive levels, for the caps and the HUD. */
  levels: Record<string, number>;
}

export function freshStats(): Stats {
  return {
    weapons: { icicles: 1, blades: 0, compass: 0, nova: 0, lightning: 0 },
    might: 1,
    haste: 1,
    area: 1,
    amount: 0,
    magnet: 3.6,
    maxHp: 100,
    regen: 0,
    armor: 1,
    pole: 0,
    glide: 0,
    levels: {},
  };
}

export interface Upgrade {
  id: string;
  name: string;
  color: string;
  /** Applies it; returns the line to announce. */
  apply: (s: Stats, heal: (hp: number) => void) => string;
}

const passive = (
  id: string,
  name: string,
  color: string,
  max: number,
  apply: (s: Stats, heal: (hp: number) => void) => void,
  line: string,
): Upgrade & { max: number } => ({
  id,
  name,
  color,
  max,
  apply: (s, heal) => {
    s.levels[id] = (s.levels[id] ?? 0) + 1;
    apply(s, heal);
    return `${name} ${s.levels[id]}: ${line}`;
  },
});

const PASSIVES = [
  passive('might', 'Might', '#ff6b6b', MAX_PASSIVE, (s) => (s.might *= 1.3), '+30% damage'),
  passive('haste', 'Haste', '#ffd166', MAX_PASSIVE, (s) => (s.haste *= 0.85), 'weapons fire faster'),
  passive('area', 'Area', '#c3a6ff', MAX_PASSIVE, (s) => (s.area *= 1.22), 'bigger blades, blasts and bolts'),
  passive('amount', 'Multishot', '#7de2ff', 3, (s) => (s.amount += 1), '+1 projectile everywhere'),
  passive('magnet', 'Magnet', '#9be564', 4, (s) => (s.magnet *= 1.6), 'crystals fly to you from further'),
  passive('vitality', 'Vitality', '#ff8fab', MAX_PASSIVE, (s, heal) => {
    s.maxHp += 30;
    heal(30);
  }, '+30 health'),
  passive('regen', 'Regen', '#70e0a0', 5, (s) => (s.regen += 1.2), 'heal over time'),
  passive('armor', 'Armour', '#b0bec5', 5, (s) => (s.armor *= 0.82), 'bites hurt less'),
  passive('pole', 'Pole Power', '#4dd2ff', 5, (s) => (s.pole += 1), 'every stroke flings you further'),
  passive('glide', 'Glide Wax', '#5cf0e6', 5, (s) => (s.glide += 1), 'faster, longer glides'),
];

function weaponUpgrade(id: WeaponId): Upgrade {
  const w = WEAPONS[id];
  return {
    id,
    name: w.name,
    color: w.color,
    apply: (s) => {
      s.weapons[id] = Math.min(MAX_WEAPON_LEVEL, s.weapons[id] + 1);
      return s.weapons[id] === 1 ? `NEW: ${w.name}! ${w.blurb}` : `${w.name} level ${s.weapons[id]}`;
    },
  };
}

/** A heart: heal, not an upgrade (only ever dropped, never rolled). */
export const HEART: Upgrade = {
  id: 'heart',
  name: 'Heart',
  color: '#ff4d6d',
  apply: (s, heal) => {
    heal(s.maxHp * 0.35);
    return 'Healed!';
  },
};

/** Roll an upgrade you can still take, weighted toward what you already have. */
export function rollUpgrade(s: Stats): Upgrade {
  const pool: { u: Upgrade; w: number }[] = [];
  const owned = (Object.keys(s.weapons) as WeaponId[]).filter((id) => s.weapons[id] > 0);
  for (const id of Object.keys(WEAPONS) as WeaponId[]) {
    const lvl = s.weapons[id];
    if (lvl === 0) pool.push({ u: weaponUpgrade(id), w: owned.length < 5 ? 2.2 : 0 });
    else if (lvl < MAX_WEAPON_LEVEL) pool.push({ u: weaponUpgrade(id), w: 3 });
  }
  for (const p of PASSIVES) {
    const lvl = s.levels[p.id] ?? 0;
    if (lvl < p.max) pool.push({ u: p, w: p.id === 'pole' || p.id === 'glide' ? 1.8 : 1.4 });
  }
  const total = pool.reduce((a, b) => a + b.w, 0);
  if (total <= 0) return HEART;
  let r = Math.random() * total;
  for (const e of pool) {
    r -= e.w;
    if (r <= 0) return e.u;
  }
  return pool[pool.length - 1].u;
}
