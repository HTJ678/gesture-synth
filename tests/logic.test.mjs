import test from "node:test";
import assert from "node:assert/strict";
import {
  PENTATONIC,
  MAJOR_SCALE,
  KEYS,
  CHORD_DEGREES,
  countExtendedFingers,
  extendedFingers,
  fingerMask,
  maskToFlags,
  fingerMidi,
  BitStabilizer,
  matchGesture,
  fingersToDegree,
  fingersToMidi,
  fingersToFreq,
  diatonicTriad,
  chordVoicing,
  chordSymbol,
  scaleNote,
  solfaName,
  midiToFreq,
  midiToName,
  octaveFromY,
  volumeFromX,
  ema,
  Stabilizer,
} from "../src/logic.mjs";

// Build a fake 21-landmark hand. Fingers that are "extended" reach away from
// the wrist; folded ones curl back toward it.
const FINGERS = {
  thumb: [1, 2, 3, 4],
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  pinky: [17, 18, 19, 20],
};
const EXTENDED_Y = [0.85, 0.75, 0.65, 0.55];
const FOLDED_Y = [0.85, 0.80, 0.82, 0.87];

function makeHand(extended = []) {
  const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.7 }));
  lm[0] = { x: 0.5, y: 0.9 }; // wrist
  for (const [name, idxs] of Object.entries(FINGERS)) {
    const ys = extended.includes(name) ? EXTENDED_Y : FOLDED_Y;
    idxs.forEach((i, k) => {
      lm[i] = { x: 0.5 + k * 0.01, y: ys[k] };
    });
  }
  return lm;
}

test("midiToFreq: A4 = 440, C4 ≈ 261.63", () => {
  assert.equal(midiToFreq(69), 440);
  assert.ok(Math.abs(midiToFreq(60) - 261.6255653) < 1e-6);
});

test("midiToName: 60 -> C4, 69 -> A4", () => {
  assert.equal(midiToName(60), "C4");
  assert.equal(midiToName(69), "A4");
  assert.equal(midiToName(61), "C#4");
});

test("countExtendedFingers: fist = 0", () => {
  assert.equal(countExtendedFingers(makeHand([])), 0);
});

test("countExtendedFingers: one, four and five fingers", () => {
  assert.equal(countExtendedFingers(makeHand(["index"])), 1);
  assert.equal(
    countExtendedFingers(makeHand(["index", "middle", "ring", "pinky"])),
    4,
  );
  assert.equal(
    countExtendedFingers(
      makeHand(["thumb", "index", "middle", "ring", "pinky"]),
    ),
    5,
  );
});

test("countExtendedFingers: includeThumb=false ignores the thumb", () => {
  const hand = makeHand(["thumb", "index"]);
  assert.equal(countExtendedFingers(hand), 2);
  assert.equal(countExtendedFingers(hand, { includeThumb: false }), 1);
});

test("countExtendedFingers: garbage input is 0, never throws", () => {
  assert.equal(countExtendedFingers(null), 0);
  assert.equal(countExtendedFingers([]), 0);
});

test("fingersToDegree: 0 fingers = silence, 1..5 = steps 0..4", () => {
  assert.equal(fingersToDegree(0), null);
  assert.equal(fingersToDegree(1), 0);
  assert.equal(fingersToDegree(5), 4);
  assert.equal(fingersToDegree(5, { includeThumb: false }), 3);
  assert.equal(fingersToDegree(9), 4); // clamped
});

test("fingersToMidi: pentatonic steps on C4, with octave offset", () => {
  const expected = PENTATONIC.map((s) => 60 + s);
  [1, 2, 3, 4, 5].forEach((f, i) => assert.equal(fingersToMidi(f), expected[i]));
  assert.equal(fingersToMidi(0), null);
  assert.equal(fingersToMidi(1, 1), 72);
  assert.equal(fingersToMidi(1, -1), 48);
});

test("fingersToFreq: 1 finger, +1 octave = C5", () => {
  assert.ok(Math.abs(fingersToFreq(1, 1) - 523.2511306) < 1e-4);
  assert.equal(fingersToFreq(0), null);
});

test("octaveFromY: three zones", () => {
  assert.equal(octaveFromY(0.1), 1);
  assert.equal(octaveFromY(0.5), 0);
  assert.equal(octaveFromY(0.9), -1);
});

test("volumeFromX: clamped to [min, max]", () => {
  assert.equal(volumeFromX(0), 0.12);
  assert.equal(volumeFromX(1), 0.75);
  assert.ok(volumeFromX(0.5) > 0.12 && volumeFromX(0.5) < 0.75);
});

test("ema: first sample passes through, then smooths", () => {
  assert.equal(ema(null, 0.5, 0.3), 0.5);
  assert.ok(Math.abs(ema(0.5, 1.0, 0.5) - 0.75) < 1e-9);
});

test("Stabilizer: waits for stableMs, ignores flicker", () => {
  const s = new Stabilizer(200);
  assert.equal(s.update(3, 0), null);
  assert.equal(s.update(3, 100), null);
  assert.equal(s.update(3, 250), 3); // committed after 200ms
  assert.equal(s.update(5, 300), 3); // new candidate, not committed yet
  assert.equal(s.update(3, 320), 3); // flicker back -> stays
  assert.equal(s.update(5, 400), 3); // candidate restarted
  assert.equal(s.update(5, 640), 5); // now it commits
});

test("scaleNote: walks a scale and wraps into the next octave", () => {
  assert.equal(scaleNote(0), 60);
  assert.equal(scaleNote(4), 69); // la, still in octave 4
  assert.equal(scaleNote(5), 72); // wraps to do of octave 5
  assert.equal(scaleNote(0, 60, MAJOR_SCALE), 60);
  assert.equal(scaleNote(3, 60, MAJOR_SCALE), 65); // fa
  assert.equal(scaleNote(6, 60, MAJOR_SCALE), 71); // si
  assert.equal(scaleNote(7, 60, MAJOR_SCALE), 72); // do'
});

test("fingersToMidi: major scale puts fa on four fingers", () => {
  const opts = { scale: MAJOR_SCALE };
  assert.equal(fingersToMidi(1, 0, opts), 60);
  assert.equal(fingersToMidi(4, 0, opts), 65); // F4 — differs from pentatonic's G4
  assert.equal(fingersToMidi(4, 0), 67); // pentatonic default unchanged
});

test("fingersToMidi: key selector shifts everything", () => {
  const g = KEYS.find((k) => k.label === "G");
  assert.equal(fingersToMidi(1, 0, { rootMidi: g.root }), 67);
  assert.equal(fingersToMidi(5, 0, { rootMidi: g.root }), 76); // la in G pentatonic
});

test("diatonicTriad: C major I IV V vi ii", () => {
  assert.deepEqual(diatonicTriad(0), [60, 64, 67]); // C  E  G
  assert.deepEqual(diatonicTriad(3), [65, 69, 72]); // F  A  C
  assert.deepEqual(diatonicTriad(4), [67, 71, 74]); // G  B  D
  assert.deepEqual(diatonicTriad(5), [69, 72, 76]); // A  C  E
  assert.deepEqual(diatonicTriad(1), [62, 65, 69]); // D  F  A
});

test("chordSymbol: major / minor / dim", () => {
  assert.equal(chordSymbol([60, 64, 67]), "C");
  assert.equal(chordSymbol([62, 65, 69]), "Dm");
  assert.equal(chordSymbol([71, 74, 77]), "Bdim");
  assert.equal(chordSymbol([60]), "—");
});

test("CHORD_DEGREES + chordSymbol cover a usable palette", () => {
  const palette = CHORD_DEGREES.map((d) => chordSymbol(diatonicTriad(d)));
  assert.deepEqual(palette, ["C", "F", "G", "Am", "Dm"]);
});

test("chordVoicing: low root plus the triad an octave up", () => {
  assert.deepEqual(chordVoicing(0), [48, 72, 76, 79]); // C3 + C5 E5 G5
  assert.equal(chordVoicing(0).length, 4);
  // the root of the voicing is always the bass note
  assert.ok(chordVoicing(4)[0] < chordVoicing(4)[1]);
});

test("chordVoicing + chordSymbol agree from C through B", () => {
  KEYS.forEach((k) => {
    const bass = chordVoicing(0, k.root)[0];
    assert.equal(bass, k.root - 12);
  });
});

test("solfaName: penta skips fa/si, major includes them", () => {
  assert.equal(solfaName(0), "do");
  assert.equal(solfaName(3), "so"); // pentatonic 4th step
  assert.equal(solfaName(3, MAJOR_SCALE), "fa");
  assert.equal(solfaName(6, MAJOR_SCALE), "si");
});

test("extendedFingers: flags in thumb..pinky order", () => {
  assert.deepEqual(extendedFingers(makeHand(["index"])), [false, true, false, false, false]);
  assert.deepEqual(extendedFingers(makeHand(["thumb", "pinky"])), [true, false, false, false, true]);
  assert.equal(fingerMask(extendedFingers(makeHand(["index", "middle"]))), "01100");
  assert.deepEqual(maskToFlags("10001"), [true, false, false, false, true]);
  assert.equal(countExtendedFingers(makeHand(["index", "middle"])), 2);
});

test("fingerMidi: fixed finger -> note, right hand then left hand", () => {  const o = { scale: MAJOR_SCALE };
  assert.equal(fingerMidi(0, "right", 0, o), 60); // thumb  -> do
  assert.equal(fingerMidi(1, "right", 0, o), 62); // index  -> re
  assert.equal(fingerMidi(4, "right", 0, o), 67); // pinky  -> so
  assert.equal(fingerMidi(0, "left", 0, o), 69); // thumb  -> la
  assert.equal(fingerMidi(1, "left", 0, o), 71); // index  -> si
  assert.equal(fingerMidi(2, "left", 0, o), 72); // middle -> do'
  assert.equal(fingerMidi(1, "right", 1, o), 74); // +1 octave
  // pentatonic: the left hand simply continues into the next octave
  assert.equal(fingerMidi(0, "left", 0), 72);
});

const GESTURES = [
  { mask: "01000", name: "index" }, // ☝️
  { mask: "01001", name: "rock" }, // 🤘
  { mask: "10001", name: "shaka" }, // 🤙
  { mask: "01100", name: "peace" }, // ✌️
  { mask: "10000", name: "thumb" }, // 👍
  { mask: "11111", name: "open" }, // 🖐
];

test("BitStabilizer: settles after stableMs, ignores a one-frame twitch", () => {
  const b = new BitStabilizer(100);
  b.update([true, true, false, false, false], 0);
  assert.equal(b.mask, "00000"); // nothing flips instantly
  b.update([true, true, false, false, false], 150);
  assert.equal(b.mask, "11000");
  // thumb blinks off for a single frame — must NOT rewrite the gesture
  b.update([false, true, false, false, false], 160);
  b.update([true, true, false, false, false], 170);
  assert.equal(b.mask, "11000");
  // thumb genuinely off for longer than stableMs — now it flips
  b.update([false, true, false, false, false], 400);
  b.update([false, true, false, false, false], 520);
  assert.equal(b.mask, "01000");
});

test("matchGesture: tolerates exactly one wrong bit", () => {
  assert.equal(matchGesture("11110", GESTURES).name, "open"); // pinky slightly curled
  assert.equal(matchGesture("01111", GESTURES).name, "open"); // thumb missed
  assert.equal(matchGesture("01001", GESTURES).name, "rock");
  assert.equal(matchGesture("01000", GESTURES).name, "index");
});

test("matchGesture: refuses ambiguous readings instead of guessing", () => {
  assert.equal(matchGesture("11000", GESTURES), null); // index or thumb down?
  assert.equal(matchGesture("00000", GESTURES), null); // all bits off
  assert.equal(matchGesture("00111", GESTURES), null); // matches nothing well
});
