/**
 * SNOW SURVIVORS — first-person Vampire Survivors on a snowfield.
 *
 * You pole about an open plain of low-poly spruce while the horde comes out
 * of the mist from every side, more of them and tougher every minute, up to
 * thousands at once (Factory Fight's swarm: see horde.ts and swarm-mesh.ts).
 * Your weapons fire by themselves. Everything you kill drops an experience
 * crystal that flies to you once you are close; filling the bar levels you
 * up, and every level is an instant upgrade. Elites and the odd ghoul drop
 * glowing upgrade orbs, and treasure chests turn up under pillars of light:
 * walk into them for an upgrade, or three. Movement upgrades turn the poles
 * into a sling: each stroke flings you further, and you glide on.
 *
 * Weapons: Icicle Volley (at the nearest), Orbit Blades (swords spinning
 * round you), Compass Shards (every way at once), Frost Nova (a blast ring
 * that freezes and throws them back) and Chain Lightning.
 *
 * Started from the guide panel ("Snow Survivors") or with ?survivors.
 */

import { createSystem, type Fog, Group, Vector3 } from '@iwsdk/core';
import { audio } from '../audio.js';
import { equipPair, setPack } from '../equipment.js';
import { exp } from '../expedition/exp-state.js';
import { HANDS, type Handedness } from '../hand-input.js';
import { level } from '../level.js';
import { poleTuning } from '../pole-system.js';
import { faceYaw, getHeadWorld, getHeadYaw, placeHeadAt } from '../rig.js';
import { sceneRefs } from '../scene-system.js';
import { fadeThen, game, Phase, requestRestart, setPhase, toast } from '../state.js';
import { WALL_Z } from '../terrain.js';
import { startTutorialKit } from '../tutorial-kit.js';
import { tutorialLevel } from '../tutorial-level.js';
import { CAP, Horde, KINDS } from './horde.js';
import { Blades, Bolts, Chests, Gems, Novas, Orbs, Zaps } from './survivors-fx.js';
import { SurvivorsHud } from './survivors-hud.js';
import { ARENA_X, ARENA_Z, survivorsLevel, survivorsView } from './survivors-level.js';
import { survivors, survivorsControl } from './survivors-state.js';
import { buildSurvivorsWorld } from './survivors-world.js';
import { Shards, SwarmMesh } from './swarm-mesh.js';
import { freshStats, HEART, rollUpgrade, type Stats, type Upgrade, WEAPONS, type WeaponId } from './upgrades.js';

const GHOUL = 0;
const BRUTE = 1;
const TITAN = 2;

/** Enemies come up out of the snow this far from you... */
const SPAWN_NEAR = 24;
const SPAWN_FAR = 34;
/** ...and any that fall this far behind are brought round in front again. */
const RECYCLE = 58;
/** Walk this close to an orb or a chest to take it (m). */
const TAKE_REACH = 1.3;

export class SurvivorsSystem extends createSystem({}) {
  private built = false;
  private root!: Group;
  private horde = new Horde();
  private swarm!: SwarmMesh;
  private shards!: Shards;
  private bolts!: Bolts;
  private blades!: Blades;
  private novas!: Novas;
  private zaps!: Zaps;
  private gems!: Gems;
  private orbs!: Orbs;
  private chests!: Chests;
  private hud = new SurvivorsHud();

  private stats: Stats = freshStats();
  private hp = 100;
  private xp = 0;
  private xpNext = 6;
  private lvl = 1;
  private time = 0;
  private kills = 0;
  private dead = false;
  private busy = false;
  private pendingUrlStart = false;

  private readonly cd: Record<WeaponId, number> = { icicles: 0, blades: 0, compass: 0, nova: 0, lightning: 0 };
  private bladeAngle = 0;
  private compassTurn = 0;
  private spawnAcc = 0;
  private nextChest = 30;
  private nextTitan = 75;
  private nextSurge = 60;
  private killSounds = 0;
  private biteSound = 0;

  private readonly head = new Vector3();
  private readonly near = new Int32Array(512);
  private readonly hitSet = new Set<number>();
  private readonly lastHead = new Vector3();
  private readonly moveDir = new Vector3(0, 0, -1);

  init(): void {
    survivorsControl.start = () => this.start();
    survivorsControl.exit = () => this.exit();
    if (new URLSearchParams(window.location.search).has('survivors')) {
      this.pendingUrlStart = true;
      game.fade = 1;
      game.fadeTarget = 1;
    }
  }

  /** Build the arena and its pools the first time it is needed. */
  private build(): void {
    if (this.built) return;
    this.built = true;
    this.root = new Group();
    this.root.name = 'SnowSurvivors';
    this.root.add(buildSurvivorsWorld());
    this.swarm = new SwarmMesh(this.root);
    this.shards = new Shards(this.root);
    this.bolts = new Bolts(this.root);
    this.blades = new Blades(this.root);
    this.novas = new Novas(this.root);
    this.zaps = new Zaps(this.root);
    this.gems = new Gems(this.root);
    this.orbs = new Orbs(this.root);
    this.chests = new Chests(this.root);
    this.root.visible = false;
    this.world.createTransformEntity(this.root, { persistent: true });
    this.world.createTransformEntity(this.hud.card, { persistent: true });
    this.world.createTransformEntity(this.hud.hurt, { persistent: true });
  }

  // ---------------------------------------------------------- the run ---

  private start(): void {
    if (this.busy || exp.active.peek()) return;
    this.busy = true;
    fadeThen(() => {
      this.build();
      const tutorial = sceneRefs.tutorialRoot?.object3D;
      if (tutorial) tutorial.visible = false;
      requestRestart();
      level.value = survivorsLevel;
      survivors.active.value = true;
      this.resetRun();
      this.root.visible = true;
      setPack({ poles: 1 });
      equipPair('poles');
      const rig = this.player;
      rig.rotation.set(0, 0, 0);
      rig.updateMatrixWorld(true);
      faceYaw(this.world, 0);
      placeHeadAt(this.world, ARENA_X, ARENA_Z, 0);
      game.velocity.set(0, 0, 0);
      setPhase(Phase.Poling);
      audio.setMusic('night');
      toast('Snow Survivors! Pole about. Your weapons fire by themselves; walk over what they drop.', 6);
      this.busy = false;
    });
  }

  private exit(): void {
    if (this.busy || !survivors.active.peek()) return;
    this.busy = true;
    fadeThen(() => {
      survivors.active.value = false;
      survivors.dead.value = false;
      this.root.visible = false;
      this.hud.hide();
      this.horde.clear();
      this.resetTuning();
      const tutorial = sceneRefs.tutorialRoot?.object3D;
      if (tutorial) tutorial.visible = true;
      level.value = tutorialLevel;
      const rig = this.player;
      rig.rotation.set(0, 0, 0);
      rig.position.set(0, 0, 0);
      rig.updateMatrixWorld(true);
      faceYaw(this.world, 0);
      placeHeadAt(this.world, 0, 0.3, 0);
      game.velocity.set(0, 0, 0);
      game.distanceToCliff.value = Math.round(-WALL_Z);
      requestRestart();
      startTutorialKit();
      setPhase(Phase.Poling);
      this.busy = false;
    });
  }

  private resetRun(): void {
    this.stats = freshStats();
    this.hp = this.stats.maxHp;
    this.xp = 0;
    this.lvl = 1;
    this.xpNext = 6;
    this.time = 0;
    this.kills = 0;
    this.dead = false;
    this.spawnAcc = 0;
    this.nextChest = 30;
    this.nextTitan = 75;
    this.nextSurge = 60;
    for (const id of Object.keys(this.cd) as WeaponId[]) this.cd[id] = 0.5;
    this.horde.clear();
    this.bolts.n = 0;
    this.gems.n = 0;
    this.orbs.clear();
    this.chests.clear();
    survivors.dead.value = false;
    survivors.time.value = 0;
    survivors.kills.value = 0;
    survivors.level.value = 1;
    this.applyTuning();
  }

  /** Movement upgrades turn up the poles. */
  private applyTuning(): void {
    poleTuning.gain = 1 + 0.45 * this.stats.pole;
    poleTuning.maxSpeed = 1 + 0.35 * this.stats.pole + 0.3 * this.stats.glide;
    poleTuning.glide = 1 + 0.55 * this.stats.glide;
  }

  private resetTuning(): void {
    poleTuning.gain = 1;
    poleTuning.maxSpeed = 1;
    poleTuning.glide = 1;
  }

  // ------------------------------------------------------------ update ---

  update(delta: number, time: number): void {
    if (this.pendingUrlStart && this.world.renderer) {
      this.pendingUrlStart = false;
      this.start();
    }
    if (!survivors.active.peek() || !this.built) return;
    const dt = Math.min(delta, 0.05);
    getHeadWorld(this.world, this.head);
    const yaw = getHeadYaw(this.world);
    survivorsView.yaw = yaw;
    const px = this.head.x;
    const pz = this.head.z;
    // Which way you're travelling (for spawning ahead of you).
    const mvx = px - this.lastHead.x;
    const mvz = pz - this.lastHead.z;
    if (mvx * mvx + mvz * mvz > 1e-6) this.moveDir.set(mvx, 0, mvz).normalize();
    this.lastHead.copy(this.head);

    if (!this.dead) {
      this.time += dt;
      this.spawn(dt, px, pz);
      const speedScale = 1 + Math.min(0.55, this.time / 540);
      const dps = this.horde.step(dt, px, pz, speedScale);
      this.hurt(dps * this.stats.armor * dt, dt);
      this.hp = Math.min(this.stats.maxHp, this.hp + this.stats.regen * dt);
      this.fireWeapons(dt, time, px, pz);
      this.moveBolts(dt);
      this.collect(dt, px, pz);
      this.recycle(px, pz);
      this.horde.sweep();
    } else {
      this.blades.mesh.count = 0;
    }

    this.swarm.update(this.horde, time, this.scene.fog as Fog | null);
    this.shards.tick(dt);
    this.bolts.draw();
    this.novas.tick(dt);
    this.zaps.tick(dt);
    this.gems.draw(time);
    this.orbs.tick(dt, time);
    this.chests.tick(dt, time);
    this.killSounds = Math.max(0, this.killSounds - dt * 14);
    this.biteSound = Math.max(0, this.biteSound - dt);

    this.hud.update(dt, this.head, yaw, {
      hp: this.hp,
      maxHp: this.stats.maxHp,
      level: this.lvl,
      xp: this.xp,
      xpNext: this.xpNext,
      time: this.time,
      kills: this.kills,
      weapons: (Object.keys(WEAPONS) as WeaponId[])
        .filter((id) => this.stats.weapons[id] > 0)
        .map((id) => `${WEAPONS[id].name} ${this.stats.weapons[id]}`)
        .join('  ·  '),
    });
    if (Math.floor(this.time) !== survivors.time.peek()) survivors.time.value = Math.floor(this.time);
  }

  // ----------------------------------------------------------- the horde ---

  /** Health, toughness and numbers all climb with the clock. */
  private hpScale(): number {
    const m = this.time / 60;
    return 1 + m * 0.6 + m * m * 0.15;
  }

  private spawn(dt: number, px: number, pz: number): void {
    const t = this.time;
    const m = t / 60;
    // Thousands by the third minute (up to the cap), and a steady flood in.
    const want = Math.min(CAP - 250, Math.floor(60 + t * 8 + m * m * 120));
    this.spawnAcc += dt * (10 + t * 0.9);
    while (this.spawnAcc >= 1 && this.horde.n < want) {
      this.spawnAcc -= 1;
      const brute = Math.random() < Math.min(0.32, Math.max(0, (t - 40) / 260));
      this.spawnOne(brute ? BRUTE : GHOUL, px, pz, 1);
    }
    if (this.spawnAcc > 8) this.spawnAcc = 8;
    // Elites, more often as the run goes on: each one carries an upgrade.
    if (t >= this.nextTitan) {
      this.nextTitan = t + Math.max(14, 42 - m * 4);
      const i = this.spawnOne(TITAN, px, pz, 1 + Math.min(0.5, m * 0.05));
      if (i >= 0) this.horde.carrier[i] = 1;
    }
    // Every minute, a ring of them all round you at once.
    if (t >= this.nextSurge) {
      this.nextSurge = t + 60;
      const count = Math.min(CAP - this.horde.n - 50, Math.floor(80 + m * 60));
      const r = 20;
      for (let k = 0; k < count; k++) {
        const a = (k / count) * Math.PI * 2;
        const i = this.horde.spawn(m > 3 && k % 6 === 0 ? BRUTE : GHOUL, px + Math.cos(a) * r, pz + Math.sin(a) * r, this.hpScale());
        if (i >= 0) this.horde.pace[i] *= 1.15;
      }
      this.hud.announce('They are surrounding you!', '#ff6b6b', 3);
      audio.whoosh();
    }
    // Treasure: a chest under a pillar of light, not too close.
    if (t >= this.nextChest) {
      this.nextChest = t + 40 + Math.random() * 15;
      const a = Math.random() * Math.PI * 2;
      const r = 16 + Math.random() * 10;
      if (this.chests.place(px + Math.cos(a) * r, pz + Math.sin(a) * r)) {
        this.hud.announce('A treasure chest! Follow the light.', '#ffd166', 4);
      }
    }
  }

  /** One enemy, up out of the snow in a ring round you (more often ahead of where you're going). */
  private spawnOne(kind: number, px: number, pz: number, scale: number): number {
    let a = Math.random() * Math.PI * 2;
    if (Math.random() < 0.45) a = Math.atan2(this.moveDir.z, this.moveDir.x) + (Math.random() - 0.5) * 1.6;
    const r = SPAWN_NEAR + Math.random() * (SPAWN_FAR - SPAWN_NEAR);
    return this.horde.spawn(kind, px + Math.cos(a) * r, pz + Math.sin(a) * r, this.hpScale(), scale);
  }

  /** Anything left far behind comes round in front again (VS's endless field). */
  private recycle(px: number, pz: number): void {
    const h = this.horde;
    for (let i = 0; i < h.n; i++) {
      if (h.dead[i]) continue;
      const dx = h.x[i] - px;
      const dz = h.z[i] - pz;
      if (dx * dx + dz * dz < RECYCLE * RECYCLE) continue;
      const a = Math.atan2(this.moveDir.z, this.moveDir.x) + (Math.random() - 0.5) * 2;
      const r = SPAWN_NEAR + Math.random() * 6;
      h.x[i] = px + Math.cos(a) * r;
      h.z[i] = pz + Math.sin(a) * r;
      h.rise[i] = 0;
    }
  }

  private hit(i: number, dmg: number, kx: number, kz: number, knock: number, freeze = 0): void {
    const h = this.horde;
    if (h.dead[i]) return;
    h.hp[i] -= dmg;
    h.flash[i] = 0.1;
    if (freeze > 0) h.burn[i] = Math.max(h.burn[i], freeze);
    if (knock > 0) {
      const d = Math.hypot(kx, kz) || 1;
      const heavy = h.kind[i] === TITAN ? 0.25 : h.kind[i] === BRUTE ? 0.6 : 1;
      h.kvx[i] = (kx / d) * knock * heavy;
      h.kvz[i] = (kz / d) * knock * heavy;
      h.kT[i] = 0.18;
    }
    if (h.hp[i] <= 0) this.kill(i);
  }

  private kill(i: number): void {
    const h = this.horde;
    h.dead[i] = 1;
    this.kills++;
    const kind = h.kind[i];
    const k = KINDS[kind];
    const r = h.radius(i);
    // A few shards each: with a hundred kills a second, more would bury the view.
    this.shards.burst(h.x[i], r * 0.6, h.z[i], kind === TITAN ? 22 : kind === BRUTE ? 4 : 2, k.accent, r * 0.16, 1.5 + r, 1.5 + r * 0.8);
    this.gems.drop(h.x[i], h.z[i], k.xp);
    if (kind === TITAN) {
      for (let g = 0; g < 6; g++) this.gems.drop(h.x[i] + (Math.random() - 0.5) * 2, h.z[i] + (Math.random() - 0.5) * 2, 4);
    }
    // Drops: elites always carry an upgrade; the rest now and then.
    const roll = Math.random();
    if (h.carrier[i] || (kind === BRUTE && roll < 0.035) || (kind === GHOUL && roll < 0.006)) {
      this.dropOrb(h.x[i], h.z[i], rollUpgrade(this.stats));
    } else if (roll > 0.995) {
      this.dropOrb(h.x[i], h.z[i], HEART);
    }
    if (this.killSounds < 3) {
      this.killSounds += 1;
      if (kind === GHOUL) audio.clack();
      else audio.thud();
    }
    if (this.kills % 100 === 0) survivors.kills.value = this.kills;
  }

  private dropOrb(x: number, z: number, u: Upgrade): void {
    this.orbs.drop(x, z, u.id, u.name, u.color);
    this.orbUpgrades.set(u.id, u);
  }

  private readonly orbUpgrades = new Map<string, Upgrade>();

  // ------------------------------------------------------------- you ---

  private hurt(amount: number, dt: number): void {
    if (amount <= 0) return;
    this.hp -= amount;
    this.hud.bitten(amount * 0.04 + dt * 0.6);
    if (this.biteSound <= 0) {
      this.biteSound = 0.35;
      audio.thud();
      for (const hand of HANDS) this.pulse(hand.handedness, 0.5, 40);
    }
    if (this.hp <= 0) this.die();
  }

  private die(): void {
    this.hp = 0;
    this.dead = true;
    survivors.dead.value = true;
    survivors.time.value = Math.floor(this.time);
    survivors.kills.value = this.kills;
    survivors.level.value = this.lvl;
    this.resetTuning();
    poleTuning.gain = 0;
    game.velocity.set(0, 0, 0);
    this.shards.burst(this.head.x, 1, this.head.z, 60, 0xff3355, 0.18, 6, 5);
    audio.fanfare();
    const mm = Math.floor(this.time / 60);
    const ss = Math.floor(this.time % 60).toString().padStart(2, '0');
    this.hud.announce(`You fell at ${mm}:${ss} with ${this.kills.toLocaleString()} kills`, '#ff6b6b', 30);
  }

  private heal(amount: number): void {
    this.hp = Math.min(this.stats.maxHp, this.hp + amount);
  }

  private pulse(side: Handedness, value: number, ms: number): void {
    const actuator = this.input.xr.gamepads[side]?.gamepad?.hapticActuators?.[0] as
      | { pulse?: (value: number, duration: number) => void }
      | undefined;
    actuator?.pulse?.(value, ms);
  }

  private grant(u: Upgrade, flourish: boolean): string {
    const line = u.apply(this.stats, (hp) => this.heal(hp));
    if (u.id === 'pole' || u.id === 'glide') this.applyTuning();
    if (flourish) {
      this.hud.announce(line, u.color, 3.5);
      this.novas.burst(this.head.x, this.head.z, 3, parseInt(u.color.slice(1), 16));
      audio.chime();
      for (const hand of HANDS) this.pulse(hand.handedness, 0.8, 80);
    }
    return line;
  }

  // --------------------------------------------------------- pickups ---

  private collect(dt: number, px: number, pz: number): void {
    const g = this.gems;
    const magnet = this.stats.magnet;
    for (let i = g.n - 1; i >= 0; i--) {
      const dx = px - g.x[i];
      const dz = pz - g.z[i];
      const d = Math.hypot(dx, dz);
      if (!g.pulled[i] && d < magnet) g.pulled[i] = 1;
      if (!g.pulled[i]) continue;
      if (d < 0.6) {
        this.gainXp(g.value[i]);
        g.remove(i);
        continue;
      }
      const v = Math.max(9, d * 7) * dt;
      g.x[i] += (dx / d) * Math.min(v, d);
      g.z[i] += (dz / d) * Math.min(v, d);
      g.y[i] += (this.head.y - 0.7 - g.y[i]) * Math.min(1, dt * 6);
    }
    for (const orb of this.orbs.list) {
      if (!orb.active) continue;
      if (Math.hypot(px - orb.x, pz - orb.z) > TAKE_REACH) continue;
      this.orbs.take(orb);
      const u = this.orbUpgrades.get(orb.upgradeId) ?? HEART;
      this.grant(u, true);
    }
    for (const chest of this.chests.list) {
      if (!chest.active) continue;
      if (Math.hypot(px - chest.x, pz - chest.z) > TAKE_REACH + 0.3) continue;
      this.chests.open(chest);
      const names: string[] = [];
      for (let k = 0; k < 3; k++) {
        const u = rollUpgrade(this.stats);
        this.grant(u, false);
        names.push(u.name);
      }
      this.hud.announce(`TREASURE! ${names.join(' + ')}`, '#ffd166', 5);
      this.novas.burst(chest.x, chest.z, 6, 0xffd166);
      this.shards.burst(chest.x, 0.6, chest.z, 50, 0xffc94a, 0.12, 4, 6);
      audio.fanfare();
      for (const hand of HANDS) this.pulse(hand.handedness, 1, 150);
    }
  }

  private gainXp(value: number): void {
    this.xp += value;
    while (this.xp >= this.xpNext) {
      this.xp -= this.xpNext;
      this.lvl++;
      this.xpNext = Math.floor(8 + this.lvl * 7 + 0.75 * this.lvl * this.lvl);
      survivors.level.value = this.lvl;
      const u = rollUpgrade(this.stats);
      const line = this.grant(u, true);
      this.hud.announce(`LEVEL ${this.lvl}!  ${line}`, u.color, 3.5);
    }
  }

  // --------------------------------------------------------- weapons ---

  private fireWeapons(dt: number, time: number, px: number, pz: number): void {
    const s = this.stats;
    const w = s.weapons;
    const y = this.head.y - 0.55;
    for (const id of Object.keys(this.cd) as WeaponId[]) this.cd[id] -= dt;

    // Icicle Volley: at the nearest few, a different one each.
    if (w.icicles > 0 && this.cd.icicles <= 0) {
      const L = w.icicles;
      this.cd.icicles = (1.05 - 0.06 * L) * s.haste;
      const count = 1 + Math.floor((L + 1) / 3) + s.amount;
      this.hitSet.clear();
      for (let k = 0; k < count; k++) {
        const t = this.horde.nearest(px, pz, 26, this.hitSet);
        if (t < 0) break;
        this.hitSet.add(t);
        const dx = this.horde.x[t] - px;
        const dz = this.horde.z[t] - pz;
        const d = Math.hypot(dx, dz) || 1;
        this.bolts.fire(px, y, pz, dx / d, dz / d, 24, (7 + 3.5 * L) * s.might, 0.35 * s.area, L >= 7 ? 4 : L >= 4 ? 2 : 0, 1.3, 0x8fe3ff);
      }
    }

    // Compass Shards: every way at once, the spread turning each volley.
    if (w.compass > 0 && this.cd.compass <= 0) {
      const L = w.compass;
      this.cd.compass = 1.45 * (1 - 0.04 * L) * s.haste;
      const dirs = Math.min(24, 4 + 2 * (L - 1) + 2 * s.amount);
      this.compassTurn += 2.39996;
      for (let k = 0; k < dirs; k++) {
        const a = this.compassTurn + (k / dirs) * Math.PI * 2;
        this.bolts.fire(px, y, pz, Math.sin(a), Math.cos(a), 17, (6 + 3 * L) * s.might, 0.3 * s.area, 1, 1.15, 0x7dffb2);
      }
    }

    // Orbit Blades: swords spinning round you, each pass one hit.
    const blades = w.blades > 0 ? Math.min(12, 1 + w.blades + s.amount) : 0;
    if (blades > 0) {
      const L = w.blades;
      const radius = (1.7 + 0.08 * L) * s.area;
      const size = 0.9 + 0.08 * L * s.area;
      this.bladeAngle += dt * (3.3 + 0.25 * L);
      this.blades.draw(blades, px, y + 0.15, pz, radius, this.bladeAngle, size);
      const dmg = (10 + 4.5 * L) * s.might;
      for (let k = 0; k < blades; k++) {
        const a = this.bladeAngle + (k / blades) * Math.PI * 2;
        const bx = px + Math.sin(a) * radius * 0.72;
        const bz = pz + Math.cos(a) * radius * 0.72;
        const n = this.horde.gather(bx, bz, radius * 0.35, this.near);
        for (let j = 0; j < n; j++) {
          const i = this.near[j];
          if (this.horde.bladeCd[i] > 0) continue;
          this.horde.bladeCd[i] = 0.32;
          this.hit(i, dmg, this.horde.x[i] - px, this.horde.z[i] - pz, 4);
        }
      }
    } else {
      this.blades.mesh.count = 0;
    }

    // Frost Nova: a blast ring that throws them back and slows them.
    if (w.nova > 0 && this.cd.nova <= 0) {
      const L = w.nova;
      this.cd.nova = (3.6 - 0.22 * L) * s.haste;
      const radius = (4.2 + 0.65 * L) * s.area;
      this.novas.burst(px, pz, radius, 0xb9a4ff);
      const n = this.horde.gather(px, pz, radius, this.near);
      const dmg = (14 + 8 * L) * s.might;
      for (let j = 0; j < n; j++) {
        const i = this.near[j];
        this.hit(i, dmg, this.horde.x[i] - px, this.horde.z[i] - pz, 9, 2);
      }
      audio.whoosh();
    }

    // Chain Lightning: to the nearest, then leaping on through the crowd.
    if (w.lightning > 0 && this.cd.lightning <= 0) {
      const L = w.lightning;
      this.cd.lightning = (1.5 - 0.08 * L) * s.haste;
      const chains = 2 + L + s.amount;
      const dmg = (12 + 6 * L) * s.might;
      this.hitSet.clear();
      let fx = px;
      let fy = y + 0.3;
      let fz = pz;
      let t = this.horde.nearest(px, pz, 15, this.hitSet);
      for (let c = 0; c < chains && t >= 0; c++) {
        this.hitSet.add(t);
        const tx = this.horde.x[t];
        const tz = this.horde.z[t];
        const ty = this.horde.radius(t) * 0.8;
        this.zaps.zap(fx, fy, fz, tx, ty, tz);
        this.hit(t, dmg, tx - fx, tz - fz, 1.5);
        fx = tx;
        fy = ty;
        fz = tz;
        t = this.horde.nearest(tx, tz, 5, this.hitSet);
      }
      if (this.hitSet.size > 0) audio.clack();
    }
    void time;
  }

  private moveBolts(dt: number): void {
    const b = this.bolts;
    for (let i = b.n - 1; i >= 0; i--) {
      b.life[i] -= dt;
      if (b.life[i] <= 0) {
        b.remove(i);
        continue;
      }
      b.x[i] += b.vx[i] * dt;
      b.z[i] += b.vz[i] * dt;
      if (b.cool[i] > 0) {
        b.cool[i] -= dt;
        continue;
      }
      const n = this.horde.gather(b.x[i], b.z[i], b.radius[i], this.near);
      if (n === 0) continue;
      const e = this.near[0];
      this.hit(e, b.dmg[i], b.vx[i], b.vz[i], 2.5);
      if (b.pierce[i] > 0) {
        b.pierce[i]--;
        b.cool[i] = 0.07;
      } else {
        b.remove(i);
      }
    }
  }
}
