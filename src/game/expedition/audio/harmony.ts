/**
 * Musical material for the expedition's generative layers: the ambient pad
 * palettes (day in D major, night in A minor), melodic "glint" choice and
 * the campfire guitarist's fingerpicking pattern. Pure data + logic, no
 * WebAudio, so it can be checked in node.
 */

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export interface Palette {
  id: 'day' | 'night';
  /** Four-note voicings (MIDI), kept in a soft mid register. */
  chords: number[][];
  /** For each chord, the chords that may follow it. */
  next: number[][];
  /** Notes a sparse melodic glint may use (pentatonic, safe over every chord). */
  glints: number[];
  /** Base low-pass cutoff of the pad (Hz) before the slow sweep. */
  cutoff: number;
  /** Chord length range (seconds). */
  chordMin: number;
  chordMax: number;
  /** Seconds between glints (min, extra random). */
  glintMin: number;
  glintRand: number;
}

/** Moraine / whiteout / rest stretches: open, hopeful, unhurried. */
export const DAY_PALETTE: Palette = {
  id: 'day',
  chords: [
    [50, 57, 64, 66], // Dadd9   D3 A3 E4 F#4
    [43, 54, 59, 69], // Gmaj9   G2 F#3 B3 A4
    [47, 54, 62, 69], // Bm7     B2 F#3 D4 A4
    [45, 52, 59, 64], // Asus2   A2 E3 B3 E4
    [52, 55, 62, 66], // Em9     E3 G3 D4 F#4
  ],
  next: [
    [1, 2, 4],
    [0, 2, 3],
    [1, 3, 4],
    [0, 1],
    [3, 1],
  ],
  glints: [74, 76, 78, 81, 83, 86, 88], // D major pentatonic, D5..E6
  cutoff: 900,
  chordMin: 15,
  chordMax: 23,
  glintMin: 6,
  glintRand: 9,
};

/** The night ridge under the aurora: minor, darker, slower. */
export const NIGHT_PALETTE: Palette = {
  id: 'night',
  chords: [
    [45, 52, 60, 71], // Am9       A2 E3 C4 B4
    [41, 52, 57, 59], // Fmaj7#11  F2 E3 A3 B3
    [48, 55, 59, 64], // Cmaj7     C3 G3 B3 E4
    [40, 50, 55, 59], // Em7       E2 D3 G3 B3
    [50, 53, 60, 64], // Dm9       D3 F3 C4 E4
  ],
  next: [
    [1, 4, 3],
    [2, 0, 3],
    [3, 1, 0],
    [0, 1],
    [0, 3, 1],
  ],
  glints: [69, 72, 74, 76, 79, 81, 84], // A minor pentatonic, A4..C6
  cutoff: 620,
  chordMin: 18,
  chordMax: 28,
  glintMin: 7,
  glintRand: 11,
};

/** Next chord index for a palette (never repeats the current chord). */
export function nextChord(p: Palette, current: number, rng: () => number): number {
  const options = p.next[current] ?? p.next[0];
  return options[Math.min(options.length - 1, Math.floor(rng() * options.length))];
}

/**
 * Next glint note index: a small random walk over the glint scale that
 * favours steps and leans back toward the middle.
 */
export function nextGlint(p: Palette, current: number, rng: () => number): number {
  const n = p.glints.length;
  const r = rng();
  let step = r < 0.35 ? -1 : r < 0.7 ? 1 : r < 0.85 ? -2 : 2;
  const mid = (n - 1) / 2;
  if (Math.abs(current + step - mid) > mid) step = -step;
  return Math.max(0, Math.min(n - 1, current + step));
}

// --------------------------------------------------------- the guitarist ---

/** Eighth-note length at 84 bpm. */
export const GUITAR_EIGHTH = 60 / 84 / 2;
/** Long-short swing on eighth pairs (fraction of an eighth). */
export const GUITAR_SWING = 0.12;
/** Eighths per phrase (4 bars of G Em C D, played twice). */
export const GUITAR_PHRASE = 64;

interface GuitarChord {
  bass: [number, number];
  treble: [number, number, number];
}

const GUITAR_CHORDS: GuitarChord[] = [
  { bass: [43, 50], treble: [59, 62, 67] }, // G
  { bass: [40, 47], treble: [55, 59, 64] }, // Em
  { bass: [48, 43], treble: [55, 60, 64] }, // C
  { bass: [50, 45], treble: [57, 62, 66] }, // D
];

/** Travis-style picking: alternating bass on the beats, treble between. */
const PATTERN: Array<['b' | 't', number]> = [
  ['b', 0],
  ['t', 1],
  ['b', 1],
  ['t', 0],
  ['b', 0],
  ['t', 2],
  ['b', 1],
  ['t', 1],
];

/**
 * Notes for one eighth-note step of the guitar loop. Writes MIDI notes into
 * `out` and returns how many (a bar's first beat of each phrase is a soft
 * strum). Velocity of the step is written to `vel[0]`.
 */
export function guitarStep(step: number, out: number[], vel: number[]): number {
  const s = ((step % GUITAR_PHRASE) + GUITAR_PHRASE) % GUITAR_PHRASE;
  const bar = Math.floor(s / 8) % GUITAR_CHORDS.length;
  const chord = GUITAR_CHORDS[bar];
  const [kind, index] = PATTERN[s % 8];
  if (s % 32 === 0) {
    // Strum to open each pass of the progression.
    out[0] = chord.bass[0];
    out[1] = chord.treble[0];
    out[2] = chord.treble[1];
    out[3] = chord.treble[2];
    vel[0] = 0.85;
    return 4;
  }
  out[0] = kind === 'b' ? chord.bass[index] : chord.treble[index];
  // Downbeats a touch stronger; the last bar of a phrase relaxes.
  vel[0] = (s % 2 === 0 ? 0.8 : 0.6) * (s >= GUITAR_PHRASE - 8 ? 0.8 : 1);
  return 1;
}

/** Duration of a step in seconds, including swing. */
export function guitarStepSeconds(step: number): number {
  return GUITAR_EIGHTH * (step % 2 === 0 ? 1 + GUITAR_SWING : 1 - GUITAR_SWING);
}
