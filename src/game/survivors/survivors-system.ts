/**
 * SNOW SURVIVORS — first-person Vampire Survivors on a snowfield.
 *
 * You pole about an open plain of low-poly spruce while the horde comes out
 * of the mist from every side, more of them and tougher every minute, up to
 * thousands at once (Factory Fight's swarm: see horde.ts and swarm-mesh.ts).
 * Survive eight minutes and you win. Your weapons fire by themselves.
 * Everything you kill drops an experience crystal that flies to you once you
 * are close; filling the bar levels you up, and every level stops the clock
 * and offers three upgrade cards to poke (upgrade-menu.ts). Elites and the
 * odd ghoul drop glowing upgrade orbs (another choice), and treasure chests
 * turn up under pillars of light: an evolution if one is ready, and a pick
 * of four. Movement upgrades turn the poles into a sling: each stroke flings
 * you further, and you glide on.
 *
 * Weapons: Icicle Volley (at the nearest), Orbit Blades (swords spinning
 * round you), Compass Shards (every way at once), Frost Nova (a blast ring
 * that freezes and throws them back) and Chain Lightning. Each evolves (see
 * upgrades.ts) once it is levelled up alongside its partner passive: the
 * next treasure chest turns it into something else entirely.
 *
 * Speed is power: every metre a second you are moving adds to all your
 * damage, and moving fast you ram straight through them, throwing them
 * aside (Pole Power makes it lethal; the Avalanche Rider evolution makes it
 * a weapon of its own). Kills chain into a combo that pays out in bonus
 * experience and a blast at every milestone.
 *
 * The horde's shape changes as it grows: rings that close round you,
 * stampedes from one side, walls of brutes across your path, and every
 * two and a half minutes a boss titan with its own health bar that drops a
 * treasure chest when it falls; the last, the Winter King, comes for the
 * final minute.
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
import { Blades, Bolts, Chests, Gems, Hurls, Novas, Orbs, Zaps } from './survivors-fx.js';
import { SurvivorsHud } from './survivors-hud.js';
import { ARENA_X, ARENA_Z, duneHeight, survivorsLevel, survivorsView } from './survivors-level.js';
import { survivors, survivorsControl } from './survivors-state.js';
import { buildSurvivorsWorld } from './survivors-world.js';
import { Shards, SwarmMesh } from './swarm-mesh.js';
import { UpgradeMenu } from './upgrade-menu.js';
import {
  CHOICE,
  EVOLUTIONS,
  type Evolution,
  type EvolutionId,
  evolutionBaseReady,
  evolutionUpgrade,
  freshStats,
  HEART,
  offerUpgrades,
  readyEvolution,
  type Stats,
  type Upgrade,
  VACUUM,
  WEAPONS,
  type WeaponId,
} from './upgrades.js';

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
/** Seconds between kills before a combo breaks. */
const COMBO_WINDOW = 2.2;
/** Combo milestones: each one blasts the crowd back and is announced. */
const MILESTONES = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000];
/** Faster than this (m/s) you ram through them (slower as the Avalanche Rider). */
const RAM_SPEED = 2.8;
const RIDER_RAM_SPEED = 1.8;
/** A run lasts this long (s): hold out to the end and you win. */
export const RUN_SECONDS = 480;
/** The bosses, and when each comes: the last one for the final minute. */
const BOSS_TIMES = [150, 300, 420];
const BOSS_NAMES = ['THE FROST TITAN', 'THE ELDER TITAN', 'THE WINTER KING'];
/** Warnings as the clock runs down (seconds left). */
const WARNINGS: [number, string][] = [
  [180, 'THREE MINUTES LEFT'],
  [60, 'ONE MINUTE LEFT!'],
  [30, '30 SECONDS!'],
];
const DIGITS = ['Digit1', 'Digit2', 'Digit3', 'Digit4'];
/** Seconds of warning before a boss. */
const BOSS_WARNING = 8;

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
  private hurls!: Hurls;
  private hud = new SurvivorsHud();
  private menu = new UpgradeMenu();
  /** Upgrade choices waiting their turn (a burst of levels queues several). */
  private readonly choices: { title: string; color: string; cards: number; sub: string }[] = [];
  private readonly tips: Vector3[] = [];
  private warning = 0;
  private lastSecond = -1;

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
  private nextEvent = 45;
  private eventIndex = 0;
  private bossIndex = 0;
  private bosses = 0;
  private bossName = '';
  /** Bosses heralded so far. */
  private bossWarned = 0;
  /** The run's own clock for animation: it stops while you choose. */
  private simClock = 0;
  private nextOrb = 8;
  private nextVacuum = 80;
  private nextHeart = 20;
  private killSounds = 0;
  private biteSound = 0;

  // Game feel.
  private combo = 0;
  private comboT = 0;
  /** Damage taken during this combo: too much and it breaks. */
  private comboHurt = 0;
  private bestCombo = 0;
  private milestone = 0;
  private gemStep = 0;
  private gemT = 0;
  private gemBudget = 0;
  private killPulse = 0;
  private hapticT = 0;
  private speed = 0;
  private speedMul = 1;
  private puffT = 0;
  private wakeT = 0;
  private levelBlast = false;
  /** Evolution hints already given, and one waiting for a quiet banner. */
  private readonly hinted = new Set<string>();
  private pendingHint: { text: string; color: string } | null = null;

  private readonly head = new Vector3();
  private readonly near = new Int32Array(512);
  private readonly hitSet = new Set<number>();
  private readonly lastHead = new Vector3();
  private readonly moveDir = new Vector3(0, 0, -1);
  private readonly puffAt = new Vector3();
  private readonly gaze = new Vector3();
  private readonly headUp = new Vector3();
  private readonly bossAt = new Vector3();
  private readonly pickAt = new Vector3();

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
    this.hurls = new Hurls(this.root);
    this.root.visible = false;
    this.world.createTransformEntity(this.root, { persistent: true });
    this.world.createTransformEntity(this.hud.root, { persistent: true });
    this.world.createTransformEntity(this.hud.hurt, { persistent: true });
    this.world.createTransformEntity(this.menu.root, { persistent: true });
    this.menu.onHover = () => audio.tick();
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
      toast('Snow Survivors! Hold out for 8 minutes. Your weapons fire by themselves; walk over what they drop.', 6);
      this.pendingHint = this.world.renderer.xr.isPresenting
        ? { text: 'Your stats are on your pole handles', color: '#c9e8ff' }
        : { text: 'Your stats are in the bottom corners', color: '#c9e8ff' };
      this.busy = false;
    });
  }

  private exit(): void {
    if (this.busy || !survivors.active.peek()) return;
    this.busy = true;
    fadeThen(() => {
      survivors.active.value = false;
      survivors.dead.value = false;
      survivors.won.value = false;
      this.root.visible = false;
      this.hud.hide();
      this.menu.close();
      this.choices.length = 0;
      audio.setMusicLevel(1, 0.5);
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
    this.warning = 0;
    this.lastSecond = -1;
    this.menu.close();
    this.choices.length = 0;
    audio.setMusicLevel(1, 0.5);
    this.spawnAcc = 0;
    this.nextChest = 30;
    this.nextTitan = 75;
    this.nextEvent = 45;
    this.eventIndex = 0;
    this.bossIndex = 0;
    this.bossWarned = 0;
    this.bosses = 0;
    this.bossName = '';
    this.nextOrb = 8;
    this.nextVacuum = 80;
    this.nextHeart = 20;
    this.combo = 0;
    this.comboT = 0;
    this.bestCombo = 0;
    this.milestone = 0;
    this.gemStep = 0;
    this.gemT = 0;
    this.killPulse = 0;
    this.speedMul = 1;
    this.hinted.clear();
    this.pendingHint = null;
    for (const id of Object.keys(this.cd) as WeaponId[]) this.cd[id] = 0.5;
    this.horde.clear();
    this.bolts.n = 0;
    this.gems.n = 0;
    this.hurls.n = 0;
    this.orbs.clear();
    this.chests.clear();
    survivors.dead.value = false;
    survivors.won.value = false;
    survivors.time.value = 0;
    survivors.kills.value = 0;
    survivors.level.value = 1;
    survivors.bestCombo.value = 0;
    survivors.bosses.value = 0;
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

    // An upgrade choice stops time: the horde, their bolts and boulders,
    // the crystals and every effect freeze where they are (only the cards
    // and your hands move) until you poke one.
    const choosing = !this.dead && this.updateChoice(dt);
    this.hud.held = this.menu.choosing;
    const simDt = choosing ? 0 : dt;
    this.simClock += simDt;
    const clock = this.simClock;
    if (!this.dead && !choosing) {
      this.time += dt;
      this.levelBlast = false;
      // Speed is power: every m/s adds to all your damage.
      this.speed = Math.hypot(game.velocity.x, game.velocity.z);
      const rider = !!this.stats.evolved.rider;
      this.speedMul = 1 + (rider ? 0.13 : 0.08) * Math.max(0, this.speed - 1);
      this.spawn(dt, px, pz);
      // The horde quickens: by six minutes the ghouls outrun a lazy pole.
      const speedScale = 1 + Math.min(0.8, this.time / 360);
      const dps = this.horde.step(dt, px, pz, speedScale);
      this.hurt(dps * this.stats.armor * dt, dt);
      this.hp = Math.min(this.stats.maxHp, this.hp + this.stats.regen * dt);
      this.ram(dt, px, pz);
      this.hurl(dt, px, pz);
      this.fireWeapons(dt, clock, px, pz);
      this.moveBolts(dt);
      this.collect(dt, px, pz);
      this.recycle(px, pz);
      this.horde.sweep();
      this.feel(dt);
      this.clock();
    } else if (this.dead) {
      this.blades.mesh.count = 0;
    }

    this.swarm.update(this.horde, clock, this.scene.fog as Fog | null);
    this.shards.tick(simDt);
    this.bolts.draw();
    this.novas.tick(simDt);
    this.zaps.tick(simDt);
    this.gems.draw(clock);
    this.hurls.draw(clock);
    this.orbs.tick(simDt, clock);
    this.chests.tick(simDt, clock);
    void time;
    this.killSounds = Math.max(0, this.killSounds - dt * 14);
    this.biteSound = Math.max(0, this.biteSound - dt);

    this.player.head.getWorldDirection(this.gaze).negate();
    this.headUp.set(0, 1, 0).transformDirection(this.player.head.matrixWorld);
    const bossHp = this.bossHealth();
    this.hud.update(
      dt,
      { head: this.head, yaw, gaze: this.gaze, up: this.headUp, presenting: this.world.renderer.xr.isPresenting },
      {
        hp: this.hp,
        maxHp: this.stats.maxHp,
        level: this.lvl,
        xp: this.xp,
        xpNext: this.xpNext,
        time: this.time,
        timeLeft: Math.max(0, RUN_SECONDS - this.time),
        kills: this.kills,
        weapons: this.weaponLine(),
        combo: this.combo,
        comboLeft: Math.max(0, this.comboT / COMBO_WINDOW),
        speedMul: this.speedMul,
        boss: this.bossName,
        bossHp,
        bossX: this.bossAt.x,
        bossZ: this.bossAt.z,
        bossR: this.bossAt.y,
      },
    );
    if (Math.floor(this.time) !== survivors.time.peek()) survivors.time.value = Math.floor(this.time);
  }

  // ----------------------------------------------------------- the horde ---

  /**
   * Health, toughness and numbers all climb with the clock, and a little
   * with your level too, so a strong build meets a tougher horde.
   */
  private hpScale(): number {
    const m = this.time / 60;
    return (1 + m * 0.6 + m * m * 0.3) * (1 + 0.04 * this.lvl);
  }

  private spawn(dt: number, px: number, pz: number): void {
    const t = this.time;
    const m = t / 60;
    // A trickle to start, a flood by the third minute (up to the cap). The
    // flood keeps coming however fast you cut it down: the fewer there are
    // than there should be, the faster they pour in (eased in over the first
    // two minutes, so the opening is something you can learn on).
    const want = Math.min(CAP - 250, Math.floor(15 + t * 4 + m * m * 220));
    const flow = 0.8 + 0.03 * t + 0.002 * t * t;
    const ease = Math.min(1, t / 120);
    this.spawnAcc += dt * Math.max(flow, (want - this.horde.n) * 1.2 * ease * ease);
    while (this.spawnAcc >= 1 && this.horde.n < want) {
      this.spawnAcc -= 1;
      const brute = Math.random() < Math.min(0.32, Math.max(0, (t - 40) / 260));
      this.spawnOne(brute ? BRUTE : GHOUL, px, pz, 1);
    }
    if (this.spawnAcc > 20) this.spawnAcc = 20;
    // Elites, more often as the run goes on: each one carries an upgrade.
    if (t >= this.nextTitan) {
      this.nextTitan = t + Math.max(14, 42 - m * 4);
      const i = this.spawnOne(TITAN, px, pz, 1 + Math.min(0.5, m * 0.05));
      if (i >= 0) this.horde.carrier[i] = 1;
    }
    // Something different every 45 s: a ring closing round you, a
    // stampede from one side, a wall of brutes across your path.
    if (t >= this.nextEvent) {
      this.nextEvent = t + 45;
      this.waveEvent(this.eventIndex++ % 3, px, pz);
    }
    // The bosses, at 2:30, 5:00 and for the final minute, each heralded a
    // few seconds ahead. A boss always comes: if the field is full, the
    // furthest straggler makes way (and it tries again next frame if not).
    if (this.bossIndex < BOSS_TIMES.length) {
      const due = BOSS_TIMES[this.bossIndex];
      if (this.bossWarned <= this.bossIndex && t >= due - BOSS_WARNING) {
        this.bossWarned = this.bossIndex + 1;
        this.hud.announce('SOMETHING HUGE IS COMING', '#ff4d6d', 3.5, 3, 'The ground is shaking');
        audio.rumble(1);
        for (const hand of HANDS) this.pulse(hand.handedness, 0.5, 300);
      }
      if (t >= due && this.spawnBoss(this.bossIndex, px, pz)) this.bossIndex++;
    }
    // Treasure: a chest under a pillar of light, not too close.
    if (t >= this.nextChest) {
      this.nextChest = t + (readyEvolution(this.stats) ? 22 : 40) + Math.random() * 15;
      const a = Math.random() * Math.PI * 2;
      const r = 16 + Math.random() * 10;
      if (this.chests.place(px + Math.cos(a) * r, pz + Math.sin(a) * r)) {
        this.hud.announce('TREASURE CHEST!', '#ffd166', 3.5, 1, 'Follow the pillar of light');
      }
    }
  }

  /** One enemy, up out of the snow in a ring round you (more often ahead of where you're going). */
  private spawnOne(kind: number, px: number, pz: number, scale: number): number {
    let a = Math.random() * Math.PI * 2;
    if (Math.random() < 0.45) a = Math.atan2(this.moveDir.z, this.moveDir.x) + (Math.random() - 0.5) * 1.6;
    const r = SPAWN_NEAR + Math.random() * (SPAWN_FAR - SPAWN_NEAR);
    // As the run goes on they come bigger (and, being bigger, tougher).
    const grow = 1 + Math.random() * Math.min(0.5, this.time / 600);
    return this.horde.spawn(kind, px + Math.cos(a) * r, pz + Math.sin(a) * r, this.hpScale(), scale * grow);
  }

  private waveEvent(kind: number, px: number, pz: number): void {
    const m = this.time / 60;
    const h = this.horde;
    const room = CAP - h.n - 60;
    if (room <= 0) return;
    if (kind === 0) {
      // A ring of them all round you at once.
      const count = Math.min(room, Math.floor(40 + m * 70));
      const r = 20;
      for (let k = 0; k < count; k++) {
        const a = (k / count) * Math.PI * 2;
        const i = h.spawn(m > 3 && k % 6 === 0 ? BRUTE : GHOUL, px + Math.cos(a) * r, pz + Math.sin(a) * r, this.hpScale());
        if (i >= 0) h.pace[i] *= 1.15;
      }
      this.hud.announce('SURROUNDED!', '#ff6b6b', 3, 2, 'Break out before the ring closes');
      audio.whoosh();
    } else if (kind === 1) {
      // A stampede: a dense, fast pack charging in from one side.
      const yaw = getHeadYaw(this.world);
      const side = Math.floor(Math.random() * 4);
      const a = Math.atan2(-Math.cos(yaw), -Math.sin(yaw)) + side * (Math.PI / 2);
      const cx = px + Math.cos(a) * 30;
      const cz = pz + Math.sin(a) * 30;
      const count = Math.min(room, Math.floor(50 + m * 30));
      for (let k = 0; k < count; k++) {
        const i = h.spawn(GHOUL, cx + (Math.random() - 0.5) * 9, cz + (Math.random() - 0.5) * 9, this.hpScale());
        if (i >= 0) {
          h.pace[i] = 2.1 + Math.random() * 0.3;
          h.veer[i] = 0;
        }
      }
      const where = ['AHEAD', 'ON YOUR RIGHT', 'BEHIND YOU', 'ON YOUR LEFT'][side];
      this.hud.announce('STAMPEDE!', '#ffb347', 3, 2, `Coming ${where.toLowerCase()}`);
      audio.rumble(1);
      audio.whoosh();
    } else {
      // A wall of brutes across the way you are going.
      const fx = this.moveDir.x;
      const fz = this.moveDir.z;
      const count = Math.min(room, Math.floor(10 + m * 5));
      for (let k = 0; k < count; k++) {
        const off = (k - (count - 1) / 2) * 1.6;
        h.spawn(BRUTE, px + fx * 24 - fz * off, pz + fz * 24 + fx * off, this.hpScale(), 1.1);
      }
      this.hud.announce('WALL OF BRUTES!', '#e0c8a0', 3.5, 2, 'Ram through or go round');
      audio.thud();
    }
  }

  /** Boss number `no` (0, 1, 2) comes out of the snow ahead of you. Returns whether it did. */
  private spawnBoss(no: number, px: number, pz: number): boolean {
    const h = this.horde;
    if (h.n >= CAP) this.makeRoom(px, pz);
    const a = Math.atan2(this.moveDir.z, this.moveDir.x) + (Math.random() - 0.5) * 1.2;
    const final = no === BOSS_TIMES.length - 1;
    const scale = final ? 3.8 : 2.4 + 0.5 * no;
    const i = h.spawn(TITAN, px + Math.cos(a) * 28, pz + Math.sin(a) * 28, 1, scale);
    if (i < 0) return false;
    h.hp[i] = KINDS[TITAN].hp * this.hpScale() * (10 + 9 * no);
    h.maxHp[i] = h.hp[i];
    h.bossNo[i] = no;
    h.pace[i] = 1.05;
    h.veer[i] = 0;
    h.carrier[i] = 2;
    const name = BOSS_NAMES[Math.min(no, BOSS_NAMES.length - 1)];
    this.hud.announce(name, '#ff4d6d', 4, 3, final ? 'The last of them. Hold on!' : 'Its hoard holds two upgrades');
    this.novas.burst(h.x[i], h.z[i], 8, 0xff4d6d);
    audio.roar();
    for (const hand of HANDS) this.pulse(hand.handedness, 1, 600);
    return true;
  }

  /** A full field: the straggler furthest from you (never an elite) goes back under the snow. */
  private makeRoom(px: number, pz: number): void {
    const h = this.horde;
    let far = -1;
    let best = -1;
    for (let i = 0; i < h.n; i++) {
      if (h.dead[i] || h.carrier[i]) continue;
      const d = (h.x[i] - px) ** 2 + (h.z[i] - pz) ** 2;
      if (d > best) {
        best = d;
        far = i;
      }
    }
    if (far < 0) return;
    h.dead[far] = 1;
    h.sweep();
  }

  /**
   * The nearest boss on the field: its health (0..1), and where its ring
   * goes (bossAt) and its name (bossName). 0 and no name when there is none.
   */
  private bossHealth(): number {
    const h = this.horde;
    let pick = -1;
    let best = Infinity;
    for (let i = 0; i < h.n; i++) {
      if (h.carrier[i] !== 2 || h.dead[i]) continue;
      const d = (h.x[i] - this.head.x) ** 2 + (h.z[i] - this.head.z) ** 2;
      if (d < best) {
        best = d;
        pick = i;
      }
    }
    if (pick < 0) {
      this.bossName = '';
      return 0;
    }
    // (x, radius, z): the ring on the snow round it.
    this.bossAt.set(h.x[pick], h.radius(pick), h.z[pick]);
    this.bossName = BOSS_NAMES[Math.min(h.bossNo[pick], BOSS_NAMES.length - 1)];
    return h.hp[pick] / (h.maxHp[pick] || 1);
  }

  /**
   * The big ones fight back: titans (and, from the third minute, one brute
   * in five) lob ice boulders on a high arc at where you are heading, and a
   * boss throws a spread of three. Each lands on a red ring: be elsewhere.
   */
  private hurl(dt: number, px: number, pz: number): void {
    const h = this.horde;
    const t = this.time;
    const m = t / 60;
    const vx = game.velocity.x;
    const vz = game.velocity.z;
    for (let i = 0; i < h.n; i++) {
      const kind = h.kind[i];
      if (h.dead[i] || h.rise[i] < 1 || h.ice[i] > 0) continue;
      if (kind === GHOUL || (kind === BRUTE && (t < 180 || i % 5 !== 0))) continue;
      h.throwT[i] -= dt;
      if (h.throwT[i] > 0) continue;
      const dx = px - h.x[i];
      const dz = pz - h.z[i];
      const d = Math.hypot(dx, dz);
      if (d > 34 || d < 3) {
        h.throwT[i] = 0.5;
        continue;
      }
      const boss = h.carrier[i] === 2;
      h.throwT[i] = boss ? 2.6 : kind === TITAN ? 3.5 + Math.random() * 2 : 7 + Math.random() * 5;
      const flight = 1.1 + d / 14;
      // Aimed at where you will be if you keep going (half the lead, so
      // turning is how you dodge).
      const ax = px + vx * flight * 0.6;
      const az = pz + vz * flight * 0.6;
      const r = h.radius(i);
      const dmg = (boss ? 24 : kind === TITAN ? 16 : 12) + 3.5 * m;
      const shots = boss ? 3 : 1;
      for (let k = 0; k < shots; k++) {
        const spread = shots > 1 ? (k - 1) * 2.4 : 0;
        const ox = (-dz / d) * spread;
        const oz = (dx / d) * spread;
        this.hurls.throw(h.x[i], duneHeight(h.x[i], h.z[i]) + r * 1.4, h.z[i], ax + ox, az + oz, flight, dmg, boss ? 1.6 : kind === TITAN ? 1.2 : 0.85);
      }
    }
    // Fly them, and see what comes down on you.
    const hu = this.hurls;
    hu.move(dt);
    for (let i = hu.n - 1; i >= 0; i--) {
      if (hu.age[i] < hu.flight[i]) continue;
      const x = hu.tx[i];
      const z = hu.tz[i];
      const reach = 0.75 + 0.35 * hu.size[i];
      const gy = duneHeight(x, z);
      this.shards.burst(x, gy + 0.2, z, 10, 0xff7a4a, 0.09 * hu.size[i], 3, 3);
      if (Math.hypot(px - x, pz - z) < reach) {
        this.hurt(hu.dmg[i] * this.stats.armor, 0.3);
        this.hud.bitten(0.35);
        audio.impact(1);
        for (const hand of HANDS) this.pulse(hand.handedness, 1, 120);
      } else if (Math.hypot(px - x, pz - z) < 12) {
        audio.impact(0.4);
      }
      hu.remove(i);
    }
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

  /** Damage enemy i (your speed adds to it), shove it along (kx, kz), chill or freeze it. */
  private hit(i: number, dmg: number, kx: number, kz: number, knock: number, chill = 0, ice = 0): void {
    const h = this.horde;
    if (h.dead[i]) return;
    const boss = h.carrier[i] === 2;
    h.hp[i] -= dmg * this.speedMul;
    h.flash[i] = 0.1;
    if (chill > 0) h.chill[i] = Math.max(h.chill[i], chill);
    if (ice > 0) h.ice[i] = Math.max(h.ice[i], boss ? ice * 0.3 : ice);
    if (knock > 0) {
      const d = Math.hypot(kx, kz) || 1;
      const heavy = boss ? 0.04 : h.kind[i] === TITAN ? 0.25 : h.kind[i] === BRUTE ? 0.6 : 1;
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
    this.killPulse++;
    const kind = h.kind[i];
    const k = KINDS[kind];
    const r = h.radius(i);
    const x = h.x[i];
    const z = h.z[i];
    // The combo: kills in quick succession, paying out in bonus experience.
    if (this.combo === 0) this.comboHurt = 0;
    this.combo++;
    this.comboT = COMBO_WINDOW;
    if (this.combo > this.bestCombo) this.bestCombo = this.combo;
    if (this.milestone < MILESTONES.length && this.combo >= MILESTONES[this.milestone]) this.comboMilestone(MILESTONES[this.milestone++]);
    const frenzy = 1 + Math.min(0.5, this.combo / 2000);
    if (h.carrier[i] === 2) {
      this.bossDown(x, z, r);
      return;
    }
    // A few shards each: with a hundred kills a second, more would bury the view.
    this.shards.burst(x, r * 0.6, z, kind === TITAN ? 22 : kind === BRUTE ? 4 : 2, k.accent, r * 0.16, 1.5 + r, 1.5 + r * 0.8);
    this.gems.drop(x, z, k.xp * frenzy);
    if (kind === TITAN) {
      for (let g = 0; g < 6; g++) this.gems.drop(x + (Math.random() - 0.5) * 2, z + (Math.random() - 0.5) * 2, 4 * frenzy);
    }
    // Drops: elites always carry an upgrade; otherwise one now and then
    // (by the clock, not the kill count, or a big fight would rain them),
    // a heart when you are hurt, and a Snow Globe every minute or so.
    const t = this.time;
    if (h.carrier[i]) {
      this.dropOrb(x, z, CHOICE);
    } else if (kind === BRUTE && t >= this.nextVacuum) {
      this.nextVacuum = t + 70 + Math.random() * 30;
      this.dropOrb(x, z, VACUUM);
    } else if (t >= this.nextHeart && this.hp < this.stats.maxHp * 0.6) {
      this.nextHeart = t + 18 + Math.random() * 12;
      this.dropOrb(x, z, HEART);
    } else if (t >= this.nextOrb && (kind === BRUTE || Math.random() < 0.05)) {
      this.nextOrb = t + 7 + Math.random() * 5;
      this.dropOrb(x, z, CHOICE);
    }
    if (this.killSounds < 3) {
      this.killSounds += 1;
      if (kind === GHOUL) audio.crunch(0.7);
      else audio.thud();
    }
    if (this.kills % 100 === 0) survivors.kills.value = this.kills;
  }

  private comboMilestone(m: number): void {
    const color = m >= 1000 ? '#ff6b6b' : m >= 250 ? '#ffb347' : '#ffd166';
    this.hud.announce(`${m.toLocaleString()} COMBO!`, color, 2.5, 1, m >= 1000 ? 'UNSTOPPABLE' : m >= 250 ? 'Keep it going!' : '');
    this.blast(this.head.x, this.head.z, 5 + Math.min(5, m / 500), 10 + m * 0.05, parseInt(color.slice(1), 16));
    audio.levelUp();
    for (const hand of HANDS) this.pulse(hand.handedness, 0.9, 120);
  }

  private bossDown(x: number, z: number, r: number): void {
    this.bosses++;
    survivors.bosses.value = this.bosses;
    this.bossName = '';
    this.shards.burst(x, r * 0.6, z, 140, KINDS[TITAN].accent, 0.3, 7, 8);
    this.shards.burst(x, r * 0.6, z, 60, 0xffffff, 0.2, 5, 10);
    this.novas.burst(x, z, 10, 0xffb54a);
    this.novas.burst(x, z, 16, 0xff4d6d);
    for (let g = 0; g < 40; g++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.random() * 4;
      this.gems.drop(x + Math.cos(a) * d, z + Math.sin(a) * d, 12);
    }
    // Its hoard: a big chest where it fell with two upgrades in it (opened
    // on the spot if every chest is out).
    if (!this.chests.place(x, z, 2)) this.openTreasure(x, z, 2);
    this.hud.announce('BOSS DOWN!', '#ffd166', 4.5, 3, 'Its hoard holds two upgrades');
    audio.fanfare();
    audio.crack();
    for (const hand of HANDS) this.pulse(hand.handedness, 1, 500);
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
    this.comboHurt += amount;
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
    this.bossName = '';
    this.menu.close();
    this.choices.length = 0;
    this.hud.held = false;
    audio.setMusicLevel(1, 0.5);
    // The tallies first: the guide panel reads them as soon as `dead` flips.
    survivors.time.value = Math.floor(this.time);
    survivors.kills.value = this.kills;
    survivors.level.value = this.lvl;
    survivors.bestCombo.value = this.bestCombo;
    survivors.bosses.value = this.bosses;
    survivors.dead.value = true;
    this.resetTuning();
    poleTuning.gain = 0;
    game.velocity.set(0, 0, 0);
    this.shards.burst(this.head.x, 1, this.head.z, 60, 0xff3355, 0.18, 6, 5);
    audio.fanfare();
    const mm = Math.floor(this.time / 60);
    const ss = Math.floor(this.time % 60).toString().padStart(2, '0');
    this.hud.announce('YOU FELL', '#ff6b6b', 30, 9, `at ${mm}:${ss} with ${this.kills.toLocaleString()} kills`);
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
    if (u.id === 'pole' || u.id === 'glide' || u.id === 'evolve-rider') this.applyTuning();
    if (u.id === 'vacuum') this.vacuum();
    this.evolutionHints();
    if (flourish) {
      const colon = line.indexOf(': ');
      const bang = line.indexOf('! ');
      if (colon > 0) this.hud.announce(line.slice(0, colon), u.color, 3, 1, line.slice(colon + 2));
      else if (bang > 0) this.hud.announce(line.slice(0, bang + 1), u.color, 3, 1, line.slice(bang + 2));
      else this.hud.announce(line, u.color, 3);
      this.novas.burst(this.head.x, this.head.z, 3, parseInt(u.color.slice(1), 16));
      audio.chime();
      for (const hand of HANDS) this.pulse(hand.handedness, 0.8, 80);
    }
    return line;
  }

  // ---------------------------------------------------------- choices ---

  /** Offer an upgrade choice as soon as the one before it is done. */
  private queueChoice(title: string, color: string, cards: number, sub = ''): void {
    this.choices.push({ title, color, cards, sub });
  }

  /**
   * Open the next waiting choice, and run the one that is up: the clock is
   * stopped (and the poles do nothing) until a card is poked. Returns
   * whether the run is paused this frame.
   */
  private updateChoice(dt: number): boolean {
    if (!this.menu.active && this.choices.length > 0) {
      const next = this.choices.shift()!;
      const offers = offerUpgrades(this.stats, next.cards);
      const presenting = this.world.renderer.xr.isPresenting;
      this.menu.open(next.title, next.color, offers, this.stats, this.head, getHeadYaw(this.world), presenting, next.sub);
      poleTuning.gain = 0;
      this.hud.clearSign();
      audio.setMusicLevel(0.3, 0.3);
      audio.timeStop();
      audio.cards();
      for (const hand of HANDS) this.pulse(hand.handedness, 0.4, 60);
    }
    if (!this.menu.active) return false;
    const choosing = this.menu.choosing;
    if (choosing) game.velocity.set(0, 0, 0);
    this.tips.length = 0;
    for (const hand of HANDS) if (hand.tracked) this.tips.push(hand.indexTip);
    let key = -1;
    const kb = this.input.keyboard;
    for (let k = 0; k < DIGITS.length; k++) if (kb.getKeyDown(DIGITS[k])) key = k;
    const picked = this.menu.update(dt, this.tips, key);
    if (picked) {
      this.grant(picked, true);
      this.applyTuning();
      if (this.choices.length === 0) audio.setMusicLevel(1, 0.8);
      audio.pick();
      const at = this.menu.pickedPosition(this.pickAt);
      this.shards.burst(at.x, at.y, at.z, 16, parseInt(picked.color.slice(1), 16), 0.011, 0.9, 0.8);
      for (const hand of HANDS) this.pulse(hand.handedness, 0.9, 90);
    }
    return choosing;
  }

  // ------------------------------------------------------------ clock ---

  /** Warnings as the time runs down, a tick for each of the last ten seconds, and the win. */
  private clock(): void {
    const left = RUN_SECONDS - this.time;
    if (left <= 0) {
      this.win();
      return;
    }
    if (this.warning < WARNINGS.length && left <= WARNINGS[this.warning][0]) {
      const [secs, text] = WARNINGS[this.warning++];
      this.hud.announce(text, secs <= 60 ? '#ff8a5c' : '#ffd166', 3, 3, secs <= 60 ? 'Hold on!' : '');
      audio.chime();
    }
    const whole = Math.ceil(left);
    if (whole <= 10 && whole !== this.lastSecond) {
      this.lastSecond = whole;
      audio.countdown(whole);
    }
  }

  /** Eight minutes: the horde shatters, wave on wave outward from you. */
  private win(): void {
    this.dead = true;
    this.bossName = '';
    this.menu.close();
    this.choices.length = 0;
    this.hud.held = false;
    audio.setMusicLevel(1, 0.5);
    survivors.time.value = RUN_SECONDS;
    survivors.kills.value = this.kills;
    survivors.level.value = this.lvl;
    survivors.bestCombo.value = this.bestCombo;
    survivors.bosses.value = this.bosses;
    survivors.won.value = true;
    survivors.dead.value = true;
    const h = this.horde;
    const px = this.head.x;
    const pz = this.head.z;
    let burst = 0;
    for (let i = 0; i < h.n; i++) {
      if (h.dead[i]) continue;
      h.dead[i] = 1;
      // Not every one shatters on screen (there can be thousands).
      if (burst < 220 && Math.hypot(h.x[i] - px, h.z[i] - pz) < 30) {
        burst++;
        const r = h.radius(i);
        this.shards.burst(h.x[i], r * 0.6, h.z[i], 3, KINDS[h.kind[i]].accent, r * 0.16, 2.5, 3);
      }
    }
    h.sweep();
    for (let k = 1; k <= 4; k++) this.novas.burst(px, pz, 6 * k, k % 2 ? 0xffe066 : 0x7fdcff);
    this.shards.burst(px, this.head.y + 1.5, pz, 120, 0xffe066, 0.08, 6, 7);
    this.hud.announce('YOU SURVIVED!', '#ffe066', 30, 9, `${this.kills.toLocaleString()} kills · level ${this.lvl} · best combo ${this.bestCombo.toLocaleString()}`);
    audio.victory();
    for (const hand of HANDS) this.pulse(hand.handedness, 1, 500);
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
        // Each pickup a note, climbing while they keep coming.
        this.gemStep = this.gemT > 0 ? this.gemStep + 1 : 0;
        this.gemT = 0.45;
        if (this.gemBudget < 1) {
          this.gemBudget += 0.08;
          audio.gem(this.gemStep);
        }
        continue;
      }
      const v = Math.max(9, Math.min(d * 7, 30 + d * 0.5)) * dt;
      g.x[i] += (dx / d) * Math.min(v, d);
      g.z[i] += (dz / d) * Math.min(v, d);
      g.y[i] += (this.head.y - 0.7 - g.y[i]) * Math.min(1, dt * 6);
    }
    for (const orb of this.orbs.list) {
      if (!orb.active) continue;
      if (Math.hypot(px - orb.x, pz - orb.z) > TAKE_REACH) continue;
      this.orbs.take(orb);
      const u = this.orbUpgrades.get(orb.upgradeId) ?? HEART;
      if (u.id === CHOICE.id) this.queueChoice('UPGRADE!', CHOICE.color, 3);
      else this.grant(u, true);
    }
    for (const chest of this.chests.list) {
      if (!chest.active) continue;
      if (Math.hypot(px - chest.x, pz - chest.z) > TAKE_REACH + 0.3) continue;
      this.chests.open(chest);
      this.openTreasure(chest.x, chest.z, chest.picks);
    }
  }

  /**
   * A treasure chest's haul: an evolution if one is ready, then `picks`
   * upgrade choices of four cards each (two from a boss's hoard).
   */
  private openTreasure(x: number, z: number, picks = 1): void {
    const evo = readyEvolution(this.stats);
    if (evo) this.grant(evolutionUpgrade(evo), false);
    for (let k = 0; k < picks; k++) {
      // The first heading tells of the evolution (the cards take the stage at once).
      if (k === 0 && evo) this.queueChoice('EVOLUTION!', evo.color, 4, `${evo.name}: ${evo.blurb}`);
      else this.queueChoice(picks > 1 ? `BOSS HOARD ${k + 1} OF ${picks}` : 'TREASURE!', '#ffd166', 4);
    }
    if (evo) {
      this.novas.burst(x, z, 14, parseInt(evo.color.slice(1), 16));
      this.shards.burst(x, 0.8, z, 90, parseInt(evo.color.slice(1), 16), 0.14, 5, 9);
      audio.evolve();
      for (const hand of HANDS) this.pulse(hand.handedness, 1, 400);
    } else {
      audio.fanfare();
      for (const hand of HANDS) this.pulse(hand.handedness, 1, 150);
    }
    this.novas.burst(x, z, 6, 0xffd166);
    this.shards.burst(x, 0.6, z, 50, 0xffc94a, 0.12, 4, 6);
  }

  private gainXp(value: number): void {
    this.xp += value;
    while (this.xp >= this.xpNext) {
      this.xp -= this.xpNext;
      this.lvl++;
      this.xpNext = Math.floor(8 + this.lvl * 10 + 1.5 * this.lvl * this.lvl);
      survivors.level.value = this.lvl;
      this.queueChoice(`LEVEL ${this.lvl}!`, '#ffe066', 3);
      // Levelling up throws the crowd back off you (once a frame).
      if (!this.levelBlast) {
        this.levelBlast = true;
        this.blast(this.head.x, this.head.z, 6.5, 20 + this.lvl * 2, 0xffe066);
        audio.levelUp();
      }
    }
  }

  /** A shock ring from (x, z): damage and a hard shove outward. */
  private blast(x: number, z: number, radius: number, dmg: number, color: number): void {
    this.novas.burst(x, z, radius, color);
    const n = this.horde.gather(x, z, radius, this.near);
    for (let j = 0; j < n; j++) {
      const i = this.near[j];
      this.hit(i, dmg * this.stats.might, this.horde.x[i] - x, this.horde.z[i] - z, 11);
    }
  }

  /** Snow Globe: every crystal on the field streams in. */
  private vacuum(): void {
    const g = this.gems;
    for (let i = 0; i < g.n; i++) g.pulled[i] = 1;
    this.novas.burst(this.head.x, this.head.z, 30, 0x7fdcff);
    audio.whoosh();
  }

  /** Tell the player what an evolution needs, and when one is ready. */
  private evolutionHints(): void {
    const s = this.stats;
    for (const e of EVOLUTIONS) {
      if (s.evolved[e.id] || !evolutionBaseReady(s, e)) continue;
      const ready = (s.levels[e.passive] ?? 0) >= e.passiveLevel;
      const key = `${e.id}:${ready ? 'ready' : 'need'}`;
      if (this.hinted.has(key)) continue;
      this.hinted.add(key);
      this.pendingHint = ready
        ? { text: `${e.name} is ready! Open a treasure chest to evolve`, color: e.color }
        : { text: `${this.baseName(e)} can evolve: find ${e.passiveName}`, color: e.color };
      if (ready) this.nextChest = Math.min(this.nextChest, this.time + 8);
      return;
    }
  }

  private baseName(e: Evolution): string {
    return e.id === 'rider' ? 'Pole Power' : WEAPONS[e.id as WeaponId].name;
  }

  private weaponLine(): string {
    const s = this.stats;
    const parts: string[] = [];
    for (const id of Object.keys(WEAPONS) as WeaponId[]) {
      if (s.weapons[id] <= 0) continue;
      const evo = s.evolved[id as EvolutionId] ? EVOLUTIONS.find((e) => e.id === id) : null;
      parts.push(evo ? `★ ${evo.name}` : `${WEAPONS[id].name} ${s.weapons[id]}`);
    }
    if (s.evolved.rider) parts.push('★ Avalanche Rider');
    return parts.join('  ·  ');
  }

  // ------------------------------------------------------------- feel ---

  /** Combo window, pickup notes, and a buzz in the hands for every kill. */
  private feel(dt: number): void {
    this.comboT -= dt;
    // A streak lasts while the kills keep coming and you are not being
    // eaten: a fifth of your health lost in one combo breaks it.
    if (this.combo > 0 && this.comboHurt > this.stats.maxHp * 0.2) this.comboT = 0;
    if (this.comboT <= 0 && this.combo > 0) {
      this.combo = 0;
      this.milestone = 0;
    }
    this.gemT -= dt;
    this.gemBudget = Math.max(0, this.gemBudget - dt);
    this.hapticT -= dt;
    if (this.killPulse > 0 && this.hapticT <= 0) {
      const v = Math.min(0.7, 0.12 + 0.025 * this.killPulse);
      for (const hand of HANDS) this.pulse(hand.handedness, v, 16);
      this.killPulse = 0;
      this.hapticT = 0.07;
    }
    if (this.pendingHint && this.hud.idle()) {
      this.hud.announce(this.pendingHint.text, this.pendingHint.color, 4);
      this.pendingHint = null;
    }
  }

  /**
   * Ramming: moving fast, whatever is in front of you is thrown aside and
   * hurt by how fast you hit it. Pole Power makes it deadly; the Avalanche
   * Rider makes it wide and leaves a wake of frost behind you.
   */
  private ram(dt: number, px: number, pz: number): void {
    const s = this.stats;
    const rider = !!s.evolved.rider;
    const speed = this.speed;
    this.puffT -= dt;
    this.wakeT -= dt;
    if (speed < (rider ? RIDER_RAM_SPEED : RAM_SPEED)) return;
    const vx = game.velocity.x / speed;
    const vz = game.velocity.z / speed;
    const fx = px + vx * 0.7;
    const fz = pz + vz * 0.7;
    const radius = (0.9 + 0.07 * speed) * (rider ? 1.9 : 1);
    const dmg = (2 + 3 * s.pole) * speed * s.might * (rider ? 3 : 1);
    const n = this.horde.gather(fx, fz, radius, this.near);
    let rammed = 0;
    for (let j = 0; j < n; j++) {
      const i = this.near[j];
      if (this.horde.kT[i] > 0) continue;
      // Thrown off to the side you hit them on, and forward with you.
      const ox = this.horde.x[i] - px;
      const oz = this.horde.z[i] - pz;
      const side = ox * -vz + oz * vx >= 0 ? 1 : -1;
      this.hit(i, dmg, -vz * side + vx * 0.7, vx * side + vz * 0.7, 5 + speed * 1.3);
      rammed++;
    }
    if (rammed > 0) {
      this.killPulse += rammed;
      if (this.puffT <= 0) {
        this.puffT = 0.08;
        this.puffAt.set(fx, this.head.y - 1.5, fz);
        sceneRefs.puffs?.emit(this.puffAt, 6, 1.4);
        if (this.killSounds < 3) {
          this.killSounds += 1;
          audio.crunch(1.2);
        }
      }
    }
    // The Avalanche Rider's wake: a ring of frost every few metres.
    if (rider && this.wakeT <= 0) {
      this.wakeT = 0.3;
      const wake = 2.6 * s.area;
      this.novas.burst(px, pz, wake, 0x7fe9ff);
      const m = this.horde.gather(px, pz, wake, this.near);
      for (let j = 0; j < m; j++) {
        const i = this.near[j];
        this.hit(i, dmg * 0.5, this.horde.x[i] - px, this.horde.z[i] - pz, 3, 1.5);
      }
    }
  }

  // --------------------------------------------------------- weapons ---

  private fireWeapons(dt: number, time: number, px: number, pz: number): void {
    const s = this.stats;
    const w = s.weapons;
    const evo = s.evolved;
    const y = this.head.y - 0.55;
    for (const id of Object.keys(this.cd) as WeaponId[]) this.cd[id] -= dt;

    // Icicle Volley: at the nearest few, a different one each.
    // Hailstorm: twice as often, three more, bigger, and through everything.
    if (w.icicles > 0 && this.cd.icicles <= 0) {
      const L = w.icicles;
      const hail = !!evo.icicles;
      this.cd.icicles = (1.05 - 0.06 * L) * s.haste * (hail ? 0.5 : 1);
      const count = 1 + Math.floor((L + 1) / 3) + s.amount + (hail ? 3 : 0);
      this.hitSet.clear();
      for (let k = 0; k < count; k++) {
        const t = this.horde.nearest(px, pz, hail ? 32 : 26, this.hitSet);
        if (t < 0) break;
        this.hitSet.add(t);
        const dx = this.horde.x[t] - px;
        const dz = this.horde.z[t] - pz;
        const d = Math.hypot(dx, dz) || 1;
        const pierce = hail ? 99 : L >= 7 ? 4 : L >= 4 ? 2 : 0;
        this.bolts.fire(px, y, pz, dx / d, dz / d, hail ? 30 : 24, (7 + 3.5 * L) * s.might, (hail ? 0.5 : 0.35) * s.area, pierce, 1.3, hail ? 0xbff4ff : 0x8fe3ff);
      }
    }

    // Compass Shards: every way at once, the spread turning each volley.
    // Starfall: twice the directions, twice as often, each shard piercing.
    if (w.compass > 0 && this.cd.compass <= 0) {
      const L = w.compass;
      const star = !!evo.compass;
      this.cd.compass = 1.45 * (1 - 0.04 * L) * s.haste * (star ? 0.5 : 1);
      const dirs = Math.min(star ? 48 : 24, (4 + 2 * (L - 1) + 2 * s.amount) * (star ? 2 : 1));
      this.compassTurn += 2.39996;
      for (let k = 0; k < dirs; k++) {
        const a = this.compassTurn + (k / dirs) * Math.PI * 2;
        this.bolts.fire(px, y, pz, Math.sin(a), Math.cos(a), star ? 20 : 17, (6 + 3 * L) * s.might, 0.3 * s.area, star ? 3 : 1, 1.15, star ? 0xa8ffd0 : 0x7dffb2);
      }
    }

    // Orbit Blades: swords spinning round you, each pass one hit.
    // Blizzard Blades: a second, wider ring spinning the other way.
    const blades = w.blades > 0 ? Math.min(12, 1 + w.blades + s.amount) : 0;
    if (blades > 0) {
      const L = w.blades;
      const storm = !!evo.blades;
      const radius = (1.7 + 0.08 * L) * s.area;
      const size = 0.9 + 0.08 * L * s.area;
      this.bladeAngle += dt * (3.3 + 0.25 * L);
      const dmg = (10 + 4.5 * L) * s.might * (storm ? 1.5 : 1);
      const used = this.blades.draw(blades, px, y + 0.15, pz, radius, this.bladeAngle, size);
      this.bladeRing(blades, px, pz, radius, this.bladeAngle, dmg);
      if (storm) {
        const outer = radius * 1.9;
        this.blades.draw(blades + 2, px, y + 0.05, pz, outer, -this.bladeAngle * 0.8, size * 1.2, used);
        this.bladeRing(blades + 2, px, pz, outer, -this.bladeAngle * 0.8, dmg);
      }
    } else {
      this.blades.mesh.count = 0;
    }

    // Frost Nova: a blast ring that throws them back and slows them.
    // Absolute Zero: wider, more often, and everything in it freezes solid.
    if (w.nova > 0 && this.cd.nova <= 0) {
      const L = w.nova;
      const zero = !!evo.nova;
      this.cd.nova = (3.6 - 0.22 * L) * s.haste * (zero ? 0.75 : 1);
      const radius = (4.2 + 0.65 * L) * s.area * (zero ? 1.4 : 1);
      this.novas.burst(px, pz, radius, zero ? 0xd8ccff : 0xb9a4ff);
      const n = this.horde.gather(px, pz, radius, this.near);
      const dmg = (14 + 8 * L) * s.might * (zero ? 1.5 : 1);
      for (let j = 0; j < n; j++) {
        const i = this.near[j];
        this.hit(i, dmg, this.horde.x[i] - px, this.horde.z[i] - pz, zero ? 4 : 9, 2, zero ? 2.5 : 0);
      }
      audio.whoosh();
    }

    // Chain Lightning: to the nearest, then leaping on through the crowd.
    // Thunderhead: half again as many leaps, more often, and every strike forks.
    if (w.lightning > 0 && this.cd.lightning <= 0) {
      const L = w.lightning;
      const thunder = !!evo.lightning;
      this.cd.lightning = (1.5 - 0.08 * L) * s.haste * (thunder ? 0.6 : 1);
      const chains = Math.floor((2 + L + s.amount) * (thunder ? 1.5 : 1));
      const dmg = (12 + 6 * L) * s.might * (thunder ? 1.3 : 1);
      this.hitSet.clear();
      let fx = px;
      let fy = y + 0.3;
      let fz = pz;
      let t = this.horde.nearest(px, pz, thunder ? 20 : 15, this.hitSet);
      for (let c = 0; c < chains && t >= 0; c++) {
        this.hitSet.add(t);
        const tx = this.horde.x[t];
        const tz = this.horde.z[t];
        const ty = this.horde.radius(t) * 0.8;
        this.zaps.zap(fx, fy, fz, tx, ty, tz);
        this.hit(t, dmg, tx - fx, tz - fz, 1.5);
        if (thunder) {
          const f = this.horde.nearest(tx, tz, 5, this.hitSet);
          if (f >= 0) {
            this.hitSet.add(f);
            this.zaps.zap(tx, ty, tz, this.horde.x[f], this.horde.radius(f) * 0.8, this.horde.z[f]);
            this.hit(f, dmg, this.horde.x[f] - tx, this.horde.z[f] - tz, 1.5);
          }
        }
        fx = tx;
        fy = ty;
        fz = tz;
        t = this.horde.nearest(tx, tz, 5, this.hitSet);
      }
      if (this.hitSet.size > 0) audio.zap();
    }
    void time;
  }

  /** One ring of blades: each sword hits what it passes through, once a pass. */
  private bladeRing(count: number, px: number, pz: number, radius: number, angle: number, dmg: number): void {
    for (let k = 0; k < count; k++) {
      const a = angle + (k / count) * Math.PI * 2;
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
