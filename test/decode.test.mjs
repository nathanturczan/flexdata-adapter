// decode.test.mjs — node --test suite for the Flex Data adapter's pure
// stages: strict spec decode (flexdata.js), Athan compat shim (compat.js),
// SN mapping policy (mapper.js), coalescing (batcher.js), hostile input.
// No Firebase, no CoreMIDI, no DOM.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { decodeFlexDataSpec } from "../src/flexdata.js";
import { interpretKeySignature } from "../src/compat.js";
import { createMapper } from "../src/mapper.js";
import { createBatcher } from "../src/batcher.js";
import ScaleData from "../src/data/ScaleData.js";

const here = dirname(fileURLToPath(import.meta.url));
const chordDict = JSON.parse(readFileSync(join(here, "../src/data/chords_no_supersets.json"), "utf8"));
const mapper = createMapper({ scaleData: ScaleData, chordDict });

// ---- UMP construction helpers (mirror the spec layouts) -------------------
const flexHeader = (status, bank = 0x00, format = 0, group = 0) =>
  (((0xd << 28) | (group << 24) | (format << 22) | (bank << 8) | status) >>> 0);
// Set Chord Name word 1: sf(4) tonic(4) type(8) alt1(8) alt2(8)
const chordW1 = (sf, tonic, type, a1 = 0, a2 = 0) =>
  (((sf & 0xf) << 28) | ((tonic & 0xf) << 24) | ((type & 0xff) << 16) | ((a1 & 0xff) << 8) | (a2 & 0xff)) >>> 0;
const bassW3 = (sf, note, type = 0x01, b1 = 0, b2 = 0) =>
  (((sf & 0xf) << 28) | ((note & 0xf) << 24) | ((type & 0xff) << 16) | ((b1 & 0xff) << 8) | (b2 & 0xff)) >>> 0;
const keySigW1 = (sfNibble, tonicNibble) => (((sfNibble & 0xf) << 28) | ((tonicNibble & 0xf) << 24)) >>> 0;
// Note letter enum: A=1 .. G=7
const N = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7 };

// ============================================================ 1. spec decode
test("spec: C Major chord", () => {
  const d = decodeFlexDataSpec([flexHeader(0x06), chordW1(0, N.C, 0x01), 0, 0]);
  assert.equal(d.kind, "chordName");
  assert.equal(d.tonic.letter, "C");
  assert.equal(d.tonic.pc, 0);
  assert.equal(d.chordType, 0x01);
  assert.equal(d.chordTypeName, "Major");
  assert.equal(d.bass, null);
  assert.deepEqual(d.alterations, []);
  assert.deepEqual(d.warnings, []);
});

test("spec: C#7/G — dominant with slash bass in word 3", () => {
  const d = decodeFlexDataSpec([flexHeader(0x06), chordW1(1, N.C, 0x0d), 0, bassW3(0, N.G)]);
  assert.equal(d.kind, "chordName");
  assert.equal(d.tonic.name, "C♯");
  assert.equal(d.tonic.pc, 1);
  assert.equal(d.chordTypeName, "Dominant");
  assert.ok(d.bass);
  assert.equal(d.bass.letter, "G");
  assert.equal(d.bass.pc, 7);
});

test("spec: F# major key signature (sf=+6) is legal, tonic implied F♯", () => {
  const d = decodeFlexDataSpec([flexHeader(0x05), keySigW1(6, N.F), 0, 0]);
  assert.equal(d.kind, "keySignature");
  assert.equal(d.sharpsFlats, 6);
  assert.equal(d.tonicLetter, "F");
  assert.equal(d.majorTonic, "F♯");
  assert.equal(d.majorTonicPc, 6);
  assert.deepEqual(d.warnings, []);
});

test("spec: Set Tempo 120 bpm (word1 = 10ns units per quarter)", () => {
  const d = decodeFlexDataSpec([flexHeader(0x00), 6e9 / 120, 0, 0]);
  assert.equal(d.kind, "tempo");
  assert.equal(d.bpm, 120);
});

test("spec: alteration bytes decode (add 9, lower 5)", () => {
  const d = decodeFlexDataSpec([flexHeader(0x06), chordW1(0, N.C, 0x0d, 0x19, 0x45), 0, 0]);
  assert.equal(d.alterations.length, 2);
  assert.deepEqual(d.alterations[0], { raw: 0x19, op: "add", degree: 9, valid: true });
  assert.deepEqual(d.alterations[1], { raw: 0x45, op: "lower", degree: 5, valid: true });
});

// ======================================================== 2. compat shim
const decodeKs = (sf, letter) => decodeFlexDataSpec([flexHeader(0x05), keySigW1(sf, letter), 0, 0]);

test("compat: Athan-style F# (sf=1=accidental) — spec illegal, shim fires with logged reason", () => {
  const i = interpretKeySignature(decodeKs(1, N.F), { shimEnabled: true });
  assert.equal(i.specLegal, false);
  assert.equal(i.shimFired, true);
  assert.equal(i.used, "compat");
  assert.equal(i.tonicPc, 6);
  assert.equal(i.tonicName, "F♯");
  assert.ok(i.divergence, "divergence must be reported");
  assert.match(i.divergence.reason, /not a legal circle-of-fifths/);
});

test("compat: D major Athan-style (sf=0) — both readings agree, shim not needed", () => {
  const i = interpretKeySignature(decodeKs(0, N.D), { shimEnabled: true });
  assert.equal(i.shimFired, false);
  assert.equal(i.used, "agree");
  assert.equal(i.tonicPc, 2);
  assert.equal(i.divergence, null);
});

test("compat: true-spec F# (sf=+6) — spec used, no shim, no divergence", () => {
  const i = interpretKeySignature(decodeKs(6, N.F), { shimEnabled: true });
  assert.equal(i.used, "spec");
  assert.equal(i.shimFired, false);
  assert.equal(i.tonicPc, 6);
  assert.equal(i.divergence, null); // sf=6 is not a valid accidental → no compat reading
});

test("compat: LEGAL spec reading that still diverges from the Athan reading is logged (reviewer tweak)", () => {
  // (letter D, sf=+2): spec = D major (legal). Athan reading: sf=2 → D𝄪 = E.
  const i = interpretKeySignature(decodeKs(2, N.D), { shimEnabled: true });
  assert.equal(i.specLegal, true);
  assert.equal(i.used, "spec"); // spec wins when legal…
  assert.equal(i.tonicPc, 2);
  assert.ok(i.divergence, "…but the divergence must still be reported");
  assert.match(i.divergence.reason, /LEGAL but/);
  assert.equal(i.divergence.compat.tonicPc, 4);
});

test("compat: shim disabled — illegal combo falls back to natural letter, divergence still reported", () => {
  const i = interpretKeySignature(decodeKs(1, N.F), { shimEnabled: false });
  assert.equal(i.shimFired, false);
  assert.equal(i.used, "letter-fallback");
  assert.equal(i.tonicPc, 5); // F natural
  assert.ok(i.divergence);
});

// ============================================================== 3. mapper
test("mapper: Dominant on C# resolves to a real cs_7-* key (lowest voicing id = canonical)", () => {
  const d = decodeFlexDataSpec([flexHeader(0x06), chordW1(1, N.C, 0x0d), 0, 0]);
  const { chordKey, meta } = mapper.mapChord(d);
  assert.equal(chordKey, "cs_7-17"); // dataset has cs_7-17 and cs_7-51
  assert.ok(chordKey in chordDict, "must be a real dataset key");
  assert.equal(meta.approximated, false);
  assert.equal(meta.unrepresentable, null);
});

test("mapper: canonical key is the lowest voicing id (c_dim-21 among 21,37,54,80,102,…)", () => {
  const d = decodeFlexDataSpec([flexHeader(0x06), chordW1(0, N.C, 0x14), 0, 0]); // Diminished 7th
  const { chordKey } = mapper.mapChord(d);
  assert.equal(chordKey, "c_dim-21");
});

test("mapper: unknown chord type enum → explicit unrepresentable, chordKey null", () => {
  const d = decodeFlexDataSpec([flexHeader(0x06), chordW1(0, N.C, 0x1f), 0, 0]);
  assert.ok(d.warnings.some((w) => /reserved\/unknown/.test(w)));
  const { chordKey, meta } = mapper.mapChord(d);
  assert.equal(chordKey, null);
  assert.ok(meta.unrepresentable);
  assert.notEqual(meta.cleared, true, "unrepresentable must be distinct from an explicit clear");
});

test("mapper: type with no SN candidates (Power) → unrepresentable with reason", () => {
  const d = decodeFlexDataSpec([flexHeader(0x06), chordW1(0, N.C, 0x18), 0, 0]);
  const { chordKey, meta } = mapper.mapChord(d);
  assert.equal(chordKey, null);
  assert.ok(meta.unrepresentable);
  assert.match(meta.unrepresentable.reason, /Power/);
});

test("mapper: explicit clear (type 0x00) → chordKey null, cleared, NOT unrepresentable", () => {
  const d = decodeFlexDataSpec([flexHeader(0x06), chordW1(0, 0, 0x00), 0, 0]);
  const { chordKey, meta } = mapper.mapChord(d);
  assert.equal(chordKey, null);
  assert.equal(meta.cleared, true);
  assert.equal(meta.unrepresentable, null);
});

test("mapper: slash bass carried as meta.externalBassPc, loss made visible", () => {
  const d = decodeFlexDataSpec([flexHeader(0x06), chordW1(1, N.C, 0x0d), 0, bassW3(0, N.G)]);
  const { chordKey, meta } = mapper.mapChord(d);
  assert.equal(chordKey, "cs_7-17");
  assert.equal(meta.externalBassPc, 7);
  assert.ok(meta.losses.some((l) => /externalBassPc/.test(l)));
});

test("mapper: plain Major triad approximates (dataset has no plain triads) and says so", () => {
  const d = decodeFlexDataSpec([flexHeader(0x06), chordW1(0, N.C, 0x01), 0, 0]);
  const { chordKey, meta } = mapper.mapChord(d);
  assert.ok(chordKey, "Major must map to something");
  assert.ok(chordKey in chordDict);
  assert.equal(meta.approximated, true);
  assert.ok(meta.losses.some((l) => /no exact SN token/.test(l)));
});

test("mapper: alterations are decoded, dropped from the key, and logged as loss", () => {
  const d = decodeFlexDataSpec([flexHeader(0x06), chordW1(0, N.C, 0x0d, 0x19), 0, 0]); // C7 add 9
  const { chordKey, meta } = mapper.mapChord(d);
  assert.equal(chordKey, "c_7-17");
  assert.ok(meta.alterations);
  assert.ok(meta.losses.some((l) => /alterations dropped/.test(l)));
});

// -------------------------------------------- 3b. exact chordInfo (payload v2)
test("mapper: chordInfo carries the exact rendering alongside the Boyd key", () => {
  const d = decodeFlexDataSpec([flexHeader(0x06), chordW1(0, N.C, 0x0d), 0, 0]); // C7
  const { chordKey, chordInfo } = mapper.mapChord(d);
  assert.equal(chordKey, "c_7-17");
  assert.deepEqual(chordInfo, { id: "C7", root: 0, voicing: [48, 52, 55, 58] });
});

test("mapper: chordInfo applies alterations exactly (C7add9; C7#5 replaces the natural 5th)", () => {
  const add9 = mapper.mapChord(decodeFlexDataSpec([flexHeader(0x06), chordW1(0, N.C, 0x0d, 0x19), 0, 0]));
  assert.deepEqual(add9.chordInfo, { id: "C7add9", root: 0, voicing: [48, 52, 55, 58, 62] });

  const sharp5 = mapper.mapChord(decodeFlexDataSpec([flexHeader(0x06), chordW1(0, N.C, 0x0d, 0x35), 0, 0]));
  assert.deepEqual(sharp5.chordInfo, { id: "C7#5", root: 0, voicing: [48, 52, 56, 58] });
});

test("mapper: chordInfo id carries accidental and slash bass (C#7/G)", () => {
  const d = decodeFlexDataSpec([flexHeader(0x06), chordW1(1, N.C, 0x0d), 0, bassW3(0, N.G)]);
  const { chordInfo, meta } = mapper.mapChord(d);
  assert.deepEqual(chordInfo, { id: "C#7/G", root: 1, voicing: [49, 53, 56, 59] });
  assert.equal(meta.externalBassPc, 7);
});

test("mapper: SN-unrepresentable type with a formula (Power) still yields chordInfo", () => {
  const d = decodeFlexDataSpec([flexHeader(0x06), chordW1(0, N.C, 0x18), 0, 0]);
  const { chordKey, chordInfo, meta } = mapper.mapChord(d);
  assert.equal(chordKey, null);
  assert.ok(meta.unrepresentable);
  assert.deepEqual(chordInfo, { id: "C5", root: 0, voicing: [48, 55] });
});

test("mapper: chordInfo is null on clear and on reserved/unknown types", () => {
  const cleared = mapper.mapChord(decodeFlexDataSpec([flexHeader(0x06), chordW1(0, 0, 0x00), 0, 0]));
  assert.equal(cleared.chordInfo, null);
  const reserved = mapper.mapChord(decodeFlexDataSpec([flexHeader(0x06), chordW1(0, N.C, 0x1f), 0, 0]));
  assert.equal(reserved.chordInfo, null);
});

test("mapper: key signature → ${root}_diatonic policy (F#→fs_diatonic), loss recorded", () => {
  const i = interpretKeySignature(decodeKs(6, N.F), { shimEnabled: true });
  const { scaleKey, meta } = mapper.mapKeySignature(i);
  assert.equal(scaleKey, "fs_diatonic");
  assert.ok(scaleKey in ScaleData, "must be a real ScaleData key");
  assert.ok(meta.losses.length > 0, "policy mismatch must be recorded as loss");
});

test("mapper: tempo rounds and sanity-clamps with warning", () => {
  assert.equal(mapper.mapTempo({ bpm: 119.7 }).bpm, 120);
  const wild = mapper.mapTempo({ bpm: 1200 });
  assert.equal(wild.bpm, 400);
  assert.ok(wild.meta.losses.some((l) => /clamped/.test(l)));
});

// ========================================================= 4. hostile input
test("hostile: wrong word count → structured error, never a throw", () => {
  const d = decodeFlexDataSpec([flexHeader(0x06)]);
  assert.equal(d.kind, "error");
  assert.match(d.reason, /exactly 4 words/);
});

test("hostile: non-Flex MT → ignored with reason", () => {
  const d = decodeFlexDataSpec([0x20903c40]); // MIDI 1.0 note-on UMP
  assert.equal(d.kind, "ignored");
  assert.match(d.reason, /MT 0x2/);
});

test("hostile: other Flex bank (lyrics, bank 0x02) → otherFlex, not mapped", () => {
  const d = decodeFlexDataSpec([flexHeader(0x01, 0x02), 0x48656c6c, 0x6f000000, 0]);
  assert.equal(d.kind, "otherFlex");
  assert.equal(d.bank, 0x02);
});

test("hostile: garbage input shapes → structured errors", () => {
  assert.equal(decodeFlexDataSpec(null).kind, "error");
  assert.equal(decodeFlexDataSpec([]).kind, "error");
  assert.equal(decodeFlexDataSpec(["x", 1, 2, 3]).kind, "error");
  assert.equal(decodeFlexDataSpec([1.5, 0, 0, 0]).kind, "error");
  assert.equal(decodeFlexDataSpec([-1, 0, 0, 0]).kind, "error");
});

test("hostile: Set Tempo of 0 → structured error (no division by zero)", () => {
  const d = decodeFlexDataSpec([flexHeader(0x00), 0, 0, 0]);
  assert.equal(d.kind, "error");
});

test("hostile: chord without key signature / key without chord map independently", () => {
  const chordOnly = mapper.mapChord(decodeFlexDataSpec([flexHeader(0x06), chordW1(0, N.C, 0x0d), 0, 0]));
  assert.equal(chordOnly.chordKey, "c_7-17");
  const keyOnly = mapper.mapKeySignature(interpretKeySignature(decodeKs(0, N.C), { shimEnabled: true }));
  assert.equal(keyOnly.scaleKey, "c_diatonic");
});

test("hostile: reserved tonic nibble / no tonic → warnings + unrepresentable chord", () => {
  const d = decodeFlexDataSpec([flexHeader(0x06), chordW1(0, 0x9, 0x0d), 0, 0]);
  assert.ok(d.warnings.length > 0);
  const { chordKey, meta } = mapper.mapChord(d);
  assert.equal(chordKey, null);
  assert.ok(meta.unrepresentable);
});

// ============================================================== 5. batcher
test("batcher: coalesces into one commit per window; duplicates suppressed and logged", () => {
  const commits = [];
  const logs = [];
  let t = 1000;
  const b = createBatcher({
    commit: (patch, entries) => commits.push({ patch, entries }),
    windowMs: 50,
    onLog: (e) => logs.push(e),
    now: () => t,
  });
  b._setTimerFn(() => null); // manual flush

  assert.equal(b.push({ chordKey: "c_7-17" }, "test"), true);
  t += 10;
  assert.equal(b.push({ bpm: 120 }, "test"), true);
  b.flushNow();

  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0].patch, { chordKey: "c_7-17", bpm: 120 });
  assert.deepEqual(commits[0].entries.map((e) => e.offset), [0, 10]);
  assert.ok(logs.some((l) => l.type === "commit"));

  // identical consecutive value → suppressed, no new window
  assert.equal(b.push({ chordKey: "c_7-17" }, "test"), false);
  assert.ok(logs.some((l) => l.type === "duplicate"));
  b.flushNow();
  assert.equal(commits.length, 1, "suppressed duplicate must not produce a commit");

  // changed value → new commit
  assert.equal(b.push({ chordKey: "cs_7-17" }, "test"), true);
  b.flushNow();
  assert.equal(commits.length, 2);
  assert.deepEqual(commits[1].patch, { chordKey: "cs_7-17" });
});

test("batcher: explicit null is a value, not a duplicate of undefined", () => {
  const commits = [];
  const b = createBatcher({ commit: (p) => commits.push(p), windowMs: 50, onLog: () => {} });
  b._setTimerFn(() => null);
  b.push({ chordKey: null }, "test");
  b.flushNow();
  assert.deepEqual(commits, [{ chordKey: null }]);
});
