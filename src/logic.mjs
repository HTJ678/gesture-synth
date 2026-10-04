// gesture-synth — pure logic layer.
// No DOM, no Web Audio in here, so it can be unit-tested with plain Node.

/** Pentatonic scale degrees (semitones from the root): do re mi so la. */
export const PENTATONIC = [0, 2, 4, 7, 9];

/** Major scale degrees: do re mi fa so la si. */
export const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];

/** MIDI note number of the root note. 60 = C4. */
export const ROOT_MIDI = 60;

/** Hand-height thresholds (normalized y, 0 = top of frame). */
export const OCTAVE_HIGH_Y = 0.38; // wrist above this  -> +1 octave
export const OCTAVE_LOW_Y = 0.62; // wrist below this  -> -1 octave

/** Selectable major keys, root at octave 4. */
export const KEYS = [
  { label: "C", root: 60 },
  { label: "D", root: 62 },
  { label: "E", root: 64 },
  { label: "F", root: 65 },
  { label: "G", root: 67 },
  { label: "A", root: 69 },
  { label: "B", root: 71 },
];

/** Which scale degree each finger count triggers in chord mode: I IV V vi ii. */
export const CHORD_DEGREES = [0, 3, 4, 5, 1];
export const CHORD_ROMANS = ["I", "IV", "V", "vi", "ii"];

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const SOLFA_PENTA = ["do", "re", "mi", "so", "la"];
const SOLFA_MAJOR = ["do", "re", "mi", "fa", "so", "la", "si"];

export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function midiToName(midi) {
  return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

export function solfaName(degreeIndex, scale = PENTATONIC) {
  const names = scale.length >= 7 ? SOLFA_MAJOR : SOLFA_PENTA;
  return names[((degreeIndex % names.length) + names.length) % names.length];
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** How straight is the chain A-B-C? 1 = perfectly straight, 0 = right angle. */
function straightness(a, b, c) {
  const v1 = { x: b.x - a.x, y: b.y - a.y };
  const v2 = { x: c.x - b.x, y: c.y - b.y };
  const d = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y);
  if (d === 0) return 0;
  return (v1.x * v2.x + v1.y * v2.y) / d;
}

/**
 * Which fingers are extended, as a flag per finger in the order
 * [thumb, index, middle, ring, pinky].
 *
 * Orientation-agnostic rule: a finger counts as extended when its tip is
 * farther from the wrist than its middle joint.
 *
 * The thumb needs a different test, and getting it wrong is what made a fist
 * read as "one finger". A folded thumb lies across the palm, so its tip ends
 * up closer to the pinky knuckle (17) than the IP joint (3) is; an extended
 * thumb points away from the palm, so the opposite holds. We also require the
 * thumb to be fairly straight at the IP joint.
 */
export function extendedFingers(landmarks, opts = {}) {
  const { includeThumb = true } = opts;
  const out = [false, false, false, false, false];
  if (!Array.isArray(landmarks) || landmarks.length < 21) return out;
  const wrist = landmarks[0];

  // The pinky and ring finger often stay slightly curled on a "straight" hand,
  // so they get a little slack. A closed fist is nowhere near these ratios,
  // so this cannot turn a fist into an open hand.
  for (const [i, tip, pip, bias] of [
    [1, 8, 6, 1.0],
    [2, 12, 10, 1.0],
    [3, 16, 14, 0.97],
    [4, 20, 18, 0.93],
  ]) {
    out[i] = dist(landmarks[tip], wrist) > dist(landmarks[pip], wrist) * bias;
  }
  if (includeThumb) {
    const pinkyKnuckle = landmarks[17];
    const reachesOut = dist(landmarks[4], pinkyKnuckle) > dist(landmarks[3], pinkyKnuckle) * 1.15;
    const straight = straightness(landmarks[2], landmarks[3], landmarks[4]) > 0.2;
    out[0] = reachesOut && straight;
  }
  return out;
}

/** How many fingers are extended. */
export function countExtendedFingers(landmarks, opts = {}) {
  return extendedFingers(landmarks, opts).filter(Boolean).length;
}

/** "10100"-style bitmask, handy as a stabilizer key. */
export function fingerMask(flags) {
  return flags.map((b) => (b ? "1" : "0")).join("");
}

export function maskToFlags(mask) {
  return String(mask ?? "00000").split("").map((c) => c === "1");
}

/**
 * Debounce a finger bitmask finger by finger, not as a whole.
 *
 * A bit only flips once the raw reading has held steady for `stableMs`. That
 * matters because a twitchy thumb must not be able to rewrite the whole
 * gesture for a single frame — which is what made chords tremble.
 */
export class BitStabilizer {
  constructor(stableMs = 110, bits = 5) {
    this.stableMs = stableMs;
    this.size = bits;
    this.state = new Array(bits).fill(false);
    this.raw = new Array(bits).fill(false);
    this.since = new Array(bits).fill(0);
  }

  get mask() {
    return this.state.map((b) => (b ? "1" : "0")).join("");
  }

  update(flags, nowMs) {
    for (let i = 0; i < this.size; i++) {
      const next = Boolean(flags?.[i]);
      if (next !== this.raw[i]) {
        this.raw[i] = next;
        this.since[i] = nowMs;
        continue;
      }
      if (this.state[i] !== next && nowMs - this.since[i] >= this.stableMs) {
        this.state[i] = next;
      }
    }
    return this.state.slice();
  }

  reset() {
    this.state.fill(false);
    this.raw.fill(false);
  }
}

/**
 * Find the gesture that best matches an observed mask.
 *
 * Exact matching is too brittle: a slightly curled pinky or a thumb the
 * tracker misses would void the whole gesture. Instead we allow one wrong bit,
 * but only if exactly one gesture claims the win — a genuinely ambiguous
 * reading returns null rather than guessing a chord.
 */
export function matchGesture(mask, gestures, minScore = 4) {
  let best = null;
  let bestScore = -1;
  let second = -1;
  for (const g of gestures) {
    let score = 0;
    for (let i = 0; i < 5; i++) if (mask[i] === g.mask[i]) score++;
    if (score > bestScore) {
      second = bestScore;
      bestScore = score;
      best = g;
    } else if (score > second) {
      second = score;
    }
  }
  if (!best || bestScore < minScore || bestScore <= second) return null;
  return best;
}

/**
 * Fixed finger -> note mapping.
 *
 * Each finger is its own "key": extending one finger sounds its note,
 * extending several sounds them together (intervals, chords).
 *
 *   right hand: thumb..pinky -> scale steps 0..4
 *   left  hand: thumb..pinky -> scale steps 5..9 (continues up the scale)
 */
export function fingerMidi(fingerIndex, hand = "right", octaveOffset = 0, opts = {}) {
  const { scale = PENTATONIC, rootMidi = ROOT_MIDI } = opts;
  const base = hand === "left" ? 5 : 0;
  return scaleNote(base + fingerIndex, rootMidi + octaveOffset * 12, scale);
}

/** Which scale step does this finger count land on? null = silence. */
export function fingersToDegree(fingers, opts = {}) {
  const { includeThumb = true } = opts;
  const max = includeThumb ? 5 : 4;
  if (!Number.isFinite(fingers) || fingers <= 0) return null;
  return Math.min(Math.floor(fingers), max) - 1;
}

/** Step number `index` of a scale, wrapping up through the octaves. */
export function scaleNote(index, rootMidi = ROOT_MIDI, scale = PENTATONIC) {
  const n = scale.length;
  const octave = Math.floor(index / n);
  const step = ((index % n) + n) % n;
  return rootMidi + octave * 12 + scale[step];
}

/** Finger count + octave offset -> MIDI note. null = silence. */
export function fingersToMidi(fingers, octaveOffset = 0, opts = {}) {
  const { includeThumb = true, scale = PENTATONIC, rootMidi = ROOT_MIDI } = opts;
  const degree = fingersToDegree(fingers, { includeThumb });
  if (degree === null) return null;
  return scaleNote(degree, rootMidi + octaveOffset * 12, scale);
}

/** Finger count + octave offset -> frequency in Hz. null = silence. */
export function fingersToFreq(fingers, octaveOffset = 0, opts = {}) {
  const midi = fingersToMidi(fingers, octaveOffset, opts);
  return midi === null ? null : midiToFreq(midi);
}

/** Diatonic triad (1-3-5) built on a zero-based scale degree of the major scale. */
export function diatonicTriad(degreeIndex, rootMidi = ROOT_MIDI) {
  return [0, 2, 4].map((step) => scaleNote(degreeIndex + step, rootMidi, MAJOR_SCALE));
}

/**
 * Accompaniment voicing: a low root note plus the triad voiced an octave up.
 * Stacking C4-E4-G4 in a synth is muddy; spreading it out is what makes a
 * chord sit under a voice instead of fighting it.
 */
export function chordVoicing(degreeIndex, rootMidi = ROOT_MIDI) {
  return [scaleNote(degreeIndex, rootMidi - 12, MAJOR_SCALE), ...diatonicTriad(degreeIndex, rootMidi + 12)];
}

/** "C" / "Am" / "Bdim" — enough for a chord readout. */
export function chordSymbol(pitches) {
  if (!Array.isArray(pitches) || pitches.length < 3) return "—";
  const [a, b, c] = pitches;
  const third = b - a;
  const fifth = c - a;
  const name = midiToName(a).replace(/-?\d+$/, "");
  if (third === 4 && fifth === 7) return name;
  if (third === 3 && fifth === 7) return name + "m";
  if (third === 3 && fifth === 6) return name + "dim";
  if (third === 4 && fifth === 8) return name + "aug";
  return name;
}

/** Hand height (normalized y of the wrist) -> octave offset (-1 / 0 / +1). */
export function octaveFromY(y) {
  if (y < OCTAVE_HIGH_Y) return 1;
  if (y > OCTAVE_LOW_Y) return -1;
  return 0;
}

/** Hand horizontal position -> output gain, clamped to [min, max]. */
export function volumeFromX(x, min = 0.12, max = 0.75) {
  const t = Math.min(1, Math.max(0, (x - 0.15) / 0.7));
  return min + t * (max - min);
}

/** Exponential moving average. */
export function ema(prev, next, alpha) {
  if (prev === null || prev === undefined) return next;
  return prev + alpha * (next - prev);
}

/**
 * Debounce a noisy signal: a new value only becomes "the" value after it has
 * been reported consistently for `stableMs`. Kills jitter at the cost of a
 * tiny, deliberate latency.
 */
export class Stabilizer {
  constructor(stableMs = 160) {
    this.stableMs = stableMs;
    this.value = null;
    this.candidate = null;
    this.since = 0;
  }

  update(next, nowMs) {
    if (next === this.value) {
      this.candidate = next;
      this.since = nowMs;
      return this.value;
    }
    if (next !== this.candidate) {
      this.candidate = next;
      this.since = nowMs;
      return this.value;
    }
    if (nowMs - this.since >= this.stableMs) this.value = next;
    return this.value;
  }
}
