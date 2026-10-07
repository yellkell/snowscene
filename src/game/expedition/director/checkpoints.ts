/**
 * The expedition's checkpoints, in route order: every camp, the foot and
 * top of each climb, the start of the fixed rope and the summit. Respawns
 * (avalanche, falls, cold, rescue flare) return you to the last one reached.
 * Pure data + math (node-checkable).
 */

import { project, type Projection, route } from '../exp-route.js';
import {
  type BandCrossing,
  CAMPS,
  ICE_WALL,
  ROCK_BAND,
  ROPE_START_S,
  START_S,
  SUMMIT_S,
} from '../exp-layout.js';
import { pointAt, type RoutePos, routeYaw } from './route-math.js';

export interface Checkpoint {
  id: string;
  /** Shown in toasts ("Back at Camp 2"). */
  name: string;
  /** Arc length; reaching it (walking) records the checkpoint. */
  s: number;
  /** A camp: cold respawns return to the last one of these. */
  camp: boolean;
  /** Index into CAMPS, or -1. */
  campIndex: number;
  /** Where the head goes on respawn, and the yaw to face. */
  x: number;
  z: number;
  yaw: number;
}

/** Signed distance of (x, z) out from a climbing band's face plane. */
export function wallOut(band: BandCrossing, x: number, z: number): number {
  return (x - band.baseX) * band.nx + (z - band.baseZ) * band.nz;
}

const tmp: RoutePos = { x: 0, z: 0, elev: 0 };

function onRoute(id: string, name: string, s: number, camp = -1): Checkpoint {
  pointAt(s, tmp);
  return { id, name, s, camp: camp >= 0, campIndex: camp, x: tmp.x, z: tmp.z, yaw: routeYaw(s) };
}

/** A stand point this far out from the face, before the climb trigger. */
function footOf(band: BandCrossing, standOut: number): number {
  for (let s = band.s - 80; s < band.s; s += 0.5) {
    pointAt(s, tmp);
    if (wallOut(band, tmp.x, tmp.z) < standOut) return s;
  }
  return band.s - 10;
}

function topOf(id: string, name: string, band: BandCrossing): Checkpoint {
  const p: Projection = { s: 0, d: 0, dist: 0, elev: 0 };
  project(band.topX, band.topZ, p);
  return { id, name, s: p.s, camp: false, campIndex: -1, x: band.topX, z: band.topZ, yaw: routeYaw(p.s + 12) };
}

function build(): Checkpoint[] {
  const list: Checkpoint[] = [];
  // Camps stand you a few metres short of the camp so it's in view ahead.
  CAMPS.forEach((camp, i) => {
    const s = i === 0 ? START_S : camp.s - 6;
    list.push(onRoute(camp.id, camp.name, s, i));
  });
  list.push(onRoute('icefoot', 'the foot of the Ice Wall', footOf(ICE_WALL, 7)));
  list.push(topOf('icetop', 'the top of the Ice Wall', ICE_WALL));
  list.push(onRoute('rope', 'the fixed rope', ROPE_START_S - 18));
  list.push(onRoute('rockfoot', 'the foot of the rock band', footOf(ROCK_BAND, 6)));
  list.push(topOf('rocktop', 'the top of the rock band', ROCK_BAND));
  list.push(onRoute('summit', 'the summit', Math.min(SUMMIT_S - 4, route.length - 1)));
  list.sort((a, b) => a.s - b.s);
  return list;
}

export const CHECKPOINTS: readonly Checkpoint[] = build();

export function checkpointIndex(id: string): number {
  return CHECKPOINTS.findIndex((c) => c.id === id);
}

/** The last checkpoint at or before arc length s. */
export function checkpointAtOrBefore(s: number): number {
  let best = 0;
  for (let i = 0; i < CHECKPOINTS.length; i++) if (CHECKPOINTS[i].s <= s + 0.5) best = i;
  return best;
}

/** The last camp checkpoint at or before checkpoint index `index`. */
export function lastCampAtOrBefore(index: number): number {
  for (let i = Math.min(index, CHECKPOINTS.length - 1); i >= 0; i--) if (CHECKPOINTS[i].camp) return i;
  return 0;
}

/** Where "Skip ahead" from a camp takes you: the next camp, or the summit from High Camp. */
export function skipTarget(campIndex: number): number {
  const from = CHECKPOINTS.findIndex((c) => c.campIndex === campIndex);
  if (from < 0) return -1;
  for (let i = from + 1; i < CHECKPOINTS.length; i++) if (CHECKPOINTS[i].camp) return i;
  return checkpointIndex('rocktop');
}
