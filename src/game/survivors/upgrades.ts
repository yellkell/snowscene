/**
 * Snow Survivors' upgrades. Every level-up, every upgrade orb an elite drops
 * and every treasure chest stops the clock and offers a choice: three cards
 * (four from a chest) float in front of you and you poke the one you want
 * (see upgrade-menu.ts). The offer is drawn from one pool, weighted toward
 * levelling what you already have and toward finishing an evolution.
 *
 * Evolutions are the long game: take a weapon to level EVOLVE_LEVEL while
 * holding its partner passive, then open a treasure chest, and the weapon
 * becomes something else entirely (Vampire Survivors' best trick). The
 * movement upgrades evolve too: enough Pole Power and Glide Wax turns you
 * into the Avalanche Rider, ploughing through the horde at speed.
 */

export type WeaponId = 'icicles' | 'blades' | 'compass' | 'nova' | 'lightning' | 'fireworks' | 'breath' | 'trail' | 'comet';

export const WEAPONS: Record<WeaponId, { name: string; color: string; blurb: string }> = {
  icicles: { name: 'Icicle Volley', color: '#8fe3ff', blurb: 'Shards at the nearest' },
  blades: { name: 'Orbit Blades', color: '#ffe066', blurb: 'Swords spin round you' },
  compass: { name: 'Compass Shards', color: '#7dffb2', blurb: 'Fires every way at once' },
  nova: { name: 'Frost Nova', color: '#b9a4ff', blurb: 'A blast ring all round' },
  lightning: { name: 'Chain Lightning', color: '#fff27a', blurb: 'Leaps through the crowd' },
  fireworks: { name: 'Fireworks', color: '#ff7ad9', blurb: 'Rockets that dive on them and burst' },
  breath: { name: 'Fire Breath', color: '#ff8a3d', blurb: 'A jet of flame wherever you look' },
  trail: { name: 'Ember Trail', color: '#ffb347', blurb: 'You leave the snow burning behind you' },
  comet: { name: 'Comet', color: '#ff5a2e', blurb: 'A burning rock on the toughest of them' },
};

/** Weapons you can carry at once. */
export const WEAPON_SLOTS = 6;

export const MAX_WEAPON_LEVEL = 8;
/** A weapon this level (with its partner passive) evolves from the next chest. */
export const EVOLVE_LEVEL = 6;

export type EvolutionId = WeaponId | 'rider';

export interface Evolution {
  id: EvolutionId;
  name: string;
  color: string;
  blurb: string;
  /** The passive it needs (and how many levels of it). */
  passive: string;
  passiveLevel: number;
  passiveName: string;
}

export const EVOLUTIONS: Evolution[] = [
  { id: 'icicles', name: 'Hailstorm', color: '#bff4ff', blurb: 'icicles rip through everything', passive: 'amount', passiveLevel: 1, passiveName: 'Multishot' },
  { id: 'blades', name: 'Blizzard Blades', color: '#fff3a0', blurb: 'a second storm of swords', passive: 'area', passiveLevel: 1, passiveName: 'Area' },
  { id: 'compass', name: 'Starfall', color: '#a8ffd0', blurb: 'shards every way, twice as fast', passive: 'haste', passiveLevel: 1, passiveName: 'Haste' },
  { id: 'nova', name: 'Absolute Zero', color: '#d8ccff', blurb: 'freezes the horde solid', passive: 'armor', passiveLevel: 1, passiveName: 'Armour' },
  { id: 'lightning', name: 'Thunderhead', color: '#fffbb0', blurb: 'every strike forks', passive: 'might', passiveLevel: 1, passiveName: 'Might' },
  { id: 'rider', name: 'Avalanche Rider', color: '#7fe9ff', blurb: 'plough through them at speed', passive: 'glide', passiveLevel: 2, passiveName: 'Glide Wax' },
  { id: 'fireworks', name: 'Grand Finale', color: '#ffa8ec', blurb: 'every burst throws four more', passive: 'vitality', passiveLevel: 1, passiveName: 'Vitality' },
  { id: 'breath', name: "Dragon's Breath", color: '#ffb36b', blurb: 'a longer, wider, endless roar', passive: 'regen', passiveLevel: 1, passiveName: 'Regen' },
  { id: 'trail', name: 'Wildfire', color: '#ffd27a', blurb: 'a trail twice as wide that will not go out', passive: 'pole', passiveLevel: 1, passiveName: 'Pole Power' },
  { id: 'comet', name: 'Meteor Shower', color: '#ff8a5c', blurb: 'three more rocks on the rest of them', passive: 'magnet', passiveLevel: 1, passiveName: 'Magnet' },
];

/** Pole Power the Avalanche Rider needs (it stands in for a weapon level). */
const RIDER_POLE = 3;
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
  /** Evolutions taken. */
  evolved: Partial<Record<EvolutionId, boolean>>;
}

export function freshStats(): Stats {
  return {
    weapons: { icicles: 1, blades: 0, compass: 0, nova: 0, lightning: 0, fireworks: 0, breath: 0, trail: 0, comet: 0 },
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
    evolved: {},
  };
}

/** Has this evolution's base reached its level (whatever the passive)? */
export function evolutionBaseReady(s: Stats, e: Evolution): boolean {
  return e.id === 'rider' ? s.pole >= RIDER_POLE : s.weapons[e.id] >= EVOLVE_LEVEL;
}

/** The first evolution waiting for a chest, if any. */
export function readyEvolution(s: Stats): Evolution | null {
  for (const e of EVOLUTIONS) {
    if (s.evolved[e.id]) continue;
    if (evolutionBaseReady(s, e) && (s.levels[e.passive] ?? 0) >= e.passiveLevel) return e;
  }
  return null;
}

export function evolutionUpgrade(e: Evolution): Upgrade {
  return {
    id: `evolve-${e.id}`,
    name: e.name,
    color: e.color,
    blurb: e.blurb.charAt(0).toUpperCase() + e.blurb.slice(1),
    kind: 'evolution',
    apply: (s) => {
      s.evolved[e.id] = true;
      return `EVOLVED: ${e.name}! ${e.blurb}`;
    },
  };
}

export interface Upgrade {
  id: string;
  name: string;
  color: string;
  /** What it does, for its card. */
  blurb?: string;
  /** Its level now (0 = not taken), and its top level, for the card's pips. */
  level?: (s: Stats) => number;
  max?: number;
  /** What sort of thing it is, for the card's ribbon. */
  kind?: 'weapon' | 'passive' | 'evolution' | 'heal' | 'bonus';
  /** The card's emblem, if not its own id's. */
  icon?: string;
  /** The card's ribbon, if not its kind's. */
  ribbon?: string;
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
  blurb: line.charAt(0).toUpperCase() + line.slice(1),
  level: (s) => s.levels[id] ?? 0,
  kind: 'passive',
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
    blurb: w.blurb,
    level: (s) => s.weapons[id],
    max: MAX_WEAPON_LEVEL,
    kind: 'weapon',
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
  blurb: 'Heal a third of your health',
  kind: 'heal',
  apply: (s, heal) => {
    heal(s.maxHp * 0.35);
    return 'Healed!';
  },
};

/** Vacuum: every crystal on the field flies to you at once. */
export const VACUUM: Upgrade = {
  id: 'vacuum',
  name: 'Snow Globe',
  color: '#7fdcff',
  blurb: 'Every crystal on the field flies to you',
  kind: 'bonus',
  icon: 'magnet',
  apply: () => 'SNOW GLOBE! Every crystal comes to you',
};

/** A bonus that stacks without limit, for when everything else is maxed. */
const bonus = (
  id: string,
  name: string,
  color: string,
  icon: string,
  blurb: string,
  apply: (s: Stats, heal: (hp: number) => void) => void,
  line: string,
): Upgrade => ({
  id,
  name,
  color,
  icon,
  blurb,
  kind: 'bonus',
  apply: (s, heal) => {
    apply(s, heal);
    return `${name}: ${line}`;
  },
});

/**
 * Cards that never run out. Late in a run nearly everything is maxed (six
 * weapons at level 8 and every passive capped is about a hundred picks),
 * so these make up the numbers: a choice is always a full hand of cards.
 */
const BONUSES: Upgrade[] = [
  bonus('bonus-might', 'Overpower', '#ff6b6b', 'might', '+15% damage, and it stacks', (s) => (s.might *= 1.15), '+15% damage'),
  bonus('bonus-haste', 'Frenzy', '#ffd166', 'haste', 'Every weapon fires 10% faster', (s) => (s.haste = Math.max(0.2, s.haste * 0.9)), 'weapons fire faster'),
  bonus('bonus-area', 'Wide Reach', '#c3a6ff', 'area', '+12% to every blast, blade and bolt', (s) => (s.area = Math.min(4, s.area * 1.12)), 'everything hits wider'),
  bonus('bonus-hp', 'Thick Furs', '#ff8fab', 'vitality', '+25 health, and healed now', (s, heal) => {
    s.maxHp += 25;
    heal(25);
  }, '+25 health'),
  bonus('bonus-heal', 'Hot Cocoa', '#ff4d6d', 'heart', 'Heal half your health', (s, heal) => heal(s.maxHp * 0.5), 'healed!'),
  VACUUM,
];

/** An upgrade orb: walk into it and choose what it becomes. */
export const CHOICE: Upgrade = {
  id: 'choice',
  name: 'Upgrade!',
  color: '#ffd166',
  apply: () => '',
};

/** Everything you can still take, weighted toward what you already have. */
function upgradePool(s: Stats): { u: Upgrade; w: number }[] {
  const pool: { u: Upgrade; w: number }[] = [];
  const owned = (Object.keys(s.weapons) as WeaponId[]).filter((id) => s.weapons[id] > 0);
  for (const id of Object.keys(WEAPONS) as WeaponId[]) {
    const lvl = s.weapons[id];
    if (lvl === 0) pool.push({ u: weaponUpgrade(id), w: owned.length < WEAPON_SLOTS ? 2.2 : 0 });
    else if (lvl < MAX_WEAPON_LEVEL) pool.push({ u: weaponUpgrade(id), w: 3 });
  }
  for (const p of PASSIVES) {
    const lvl = s.levels[p.id] ?? 0;
    if (lvl >= p.max) continue;
    let w = p.id === 'pole' || p.id === 'glide' ? 1.8 : 1.4;
    // A passive that would complete an evolution you are building toward
    // turns up far more often.
    if (evolvesWith(s, p.id)) w += 2.5;
    pool.push({ u: p, w });
  }
  return pool.filter((e) => e.w > 0);
}

/** The evolution a passive would unlock (its base well on the way), if any. */
export function evolvesWith(s: Stats, passiveId: string): Evolution | null {
  const lvl = s.levels[passiveId] ?? 0;
  for (const e of EVOLUTIONS) {
    if (e.passive !== passiveId || s.evolved[e.id] || lvl >= e.passiveLevel) continue;
    const base = e.id === 'rider' ? s.pole : s.weapons[e.id];
    if (base >= 3) return e;
  }
  return null;
}

/** Roll an upgrade you can still take, weighted toward what you already have. */
export function rollUpgrade(s: Stats): Upgrade {
  return offerUpgrades(s, 1)[0];
}

/**
 * `count` different upgrades to choose between, drawn from the weighted
 * pool. With almost everything maxed, bonuses make up the numbers.
 */
export function offerUpgrades(s: Stats, count: number): Upgrade[] {
  const pool = upgradePool(s);
  const out: Upgrade[] = [];
  while (out.length < count && pool.length > 0) {
    const total = pool.reduce((a, b) => a + b.w, 0);
    let r = Math.random() * total;
    let k = 0;
    for (; k < pool.length - 1; k++) {
      r -= pool[k].w;
      if (r <= 0) break;
    }
    out.push(pool[k].u);
    pool.splice(k, 1);
  }
  const spare = BONUSES.slice();
  while (out.length < count && spare.length > 0) out.push(spare.splice(Math.floor(Math.random() * spare.length), 1)[0]);
  return out;
}

/** The end of a run: two more cards to poke, another go or home. */
export const END_AGAIN: Upgrade = {
  id: 'end-again',
  name: 'Run It Back',
  color: '#ffd166',
  blurb: 'Another eight minutes in the snow',
  kind: 'bonus',
  ribbon: 'NEW RUN',
  icon: 'blades',
  apply: () => '',
};
export const END_LEAVE: Upgrade = {
  id: 'end-leave',
  name: 'Head Home',
  color: '#7fdcff',
  blurb: 'Back to the valley and the mountain trail',
  kind: 'bonus',
  ribbon: 'THE VALLEY',
  icon: 'compass',
  apply: () => '',
};
