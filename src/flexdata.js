// flexdata.js — PURE strict-spec MIDI 2.0 Flex Data decoder.
//
// Decodes UMP Flex Data messages (Message Type 0xD) per the MIDI 2.0 UMP
// spec (M2-104-UM §7.5): Set Tempo, Set Key Signature, Set Chord Name.
//
// STRICT SPEC ONLY. No Scale Navigator concepts, no Athan special cases —
// Athan-compatibility normalization lives in compat.js, mapping policy in
// mapper.js. This module never throws into the pipeline: malformed input
// produces { kind: "error", ... } or warnings on a decoded result.

// ---------------------------------------------------------------- constants

export const MT_FLEX = 0xd;

export const FLEX_BANK_SETUP = 0x00; // "Setup and Performance" bank
export const ST_SET_TEMPO = 0x00;
export const ST_SET_TIME_SIGNATURE = 0x01;
export const ST_SET_KEY_SIGNATURE = 0x05;
export const ST_SET_CHORD_NAME = 0x06;

// Tonic / bass note letter enum (shared by Set Key Signature + Set Chord
// Name): 0x0 = unknown/none, 0x1..0x7 = A..G, 0x8..0xF = reserved.
const NOTE_LETTERS = [null, "A", "B", "C", "D", "E", "F", "G"];

// Natural pitch class of each letter (C = 0).
export const LETTER_PC = { A: 9, B: 11, C: 0, D: 2, E: 4, F: 5, G: 7 };

// Sharps/flats nibble as ACCIDENTAL (Set Chord Name tonic + bass, per spec):
// 0x0 natural, 0x1 ♯, 0x2 ♯♯, 0xF (-1) ♭, 0xE (-2) ♭♭. Other values reserved.
const ACCIDENTALS = { 0: 0, 1: 1, 2: 2, 0xf: -1, 0xe: -2 };
const ACC_NAMES = { "-2": "𝄫", "-1": "♭", 0: "", 1: "♯", 2: "𝄪" };

// Set Chord Name chord type enum (0x00–0x1B).
export const CHORD_TYPE_NAMES = {
  0x00: "Clear Chord (no chord)",
  0x01: "Major",
  0x02: "Major 6th",
  0x03: "Major 7th",
  0x04: "Major 9th",
  0x05: "Major 11th",
  0x06: "Major 13th",
  0x07: "Minor",
  0x08: "Minor 6th",
  0x09: "Minor 7th",
  0x0a: "Minor 9th",
  0x0b: "Minor 11th",
  0x0c: "Minor 13th",
  0x0d: "Dominant",
  0x0e: "Dominant 9th",
  0x0f: "Dominant 11th",
  0x10: "Dominant 13th",
  0x11: "Augmented",
  0x12: "Augmented 7th",
  0x13: "Diminished",
  0x14: "Diminished 7th",
  0x15: "Half Diminished",
  0x16: "Major Minor (minor-major 7th)",
  0x17: "Pedal",
  0x18: "Power",
  0x19: "Suspended 2nd",
  0x1a: "Suspended 4th",
  0x1b: "Seven Suspended 4th",
};

// Alteration byte: hi nibble operation, lo nibble scale degree.
const ALTERATION_OPS = { 1: "add", 2: "subtract", 3: "raise", 4: "lower" };

// ------------------------------------------------------------------ helpers

// 4-bit two's complement → -8..+7
function nibbleSigned(n) {
  return n >= 8 ? n - 16 : n;
}

function hex(w) {
  return "0x" + (w >>> 0).toString(16).padStart(8, "0");
}

function err(reason, words) {
  return { kind: "error", reason, raw: Array.isArray(words) ? words.slice() : words };
}

// Decode one alteration byte. 0x00 = "no alteration" (slot unused).
function decodeAlteration(byte) {
  if (byte === 0) return null;
  const opNibble = (byte >> 4) & 0xf;
  const degree = byte & 0xf;
  const op = ALTERATION_OPS[opNibble] || null;
  return {
    raw: byte,
    op, // null when the operation nibble is reserved/invalid
    degree,
    valid: op !== null && degree > 0,
  };
}

// Decode a tonic/bass "sf + note" pair where sf is an ACCIDENTAL nibble
// (Set Chord Name semantics). Returns { letter, accidental, pc, name } with
// warnings pushed onto `warnings`.
function decodeAccidentalNote(sfNibble, noteNibble, label, warnings) {
  const letter = noteNibble <= 7 ? NOTE_LETTERS[noteNibble] : undefined;
  if (letter === undefined) {
    warnings.push(`${label}: note nibble 0x${noteNibble.toString(16)} is reserved (valid: 0x0–0x7)`);
    return null;
  }
  if (letter === null) return null; // 0x0 = no note (e.g. no bass)
  const accidental = ACCIDENTALS[sfNibble];
  if (accidental === undefined) {
    warnings.push(
      `${label}: sharps/flats nibble 0x${sfNibble.toString(16)} is not a valid accidental ` +
        `(valid: 0 natural, 1 ♯, 2 ♯♯, 0xF ♭, 0xE ♭♭); treating note as natural`
    );
    return { letter, accidental: null, pc: LETTER_PC[letter], name: letter + "?" };
  }
  const pc = ((LETTER_PC[letter] + accidental) % 12 + 12) % 12;
  return { letter, accidental, pc, name: letter + ACC_NAMES[accidental] };
}

// ------------------------------------------------------------ main decoder

/**
 * decodeFlexDataSpec(words) — strict MIDI 2.0 spec interpretation of one UMP
 * message given as an array of 32-bit words.
 *
 * Returns one of:
 *   { kind: "error", reason, raw }                      — malformed input
 *   { kind: "ignored", reason, raw, mt }                — valid UMP, not Flex Data
 *   { kind: "otherFlex", bank, status, ... }            — Flex Data, bank/status we don't handle
 *   { kind: "tempo" | "keySignature" | "chordName", ... semantics, warnings[] }
 */
export function decodeFlexDataSpec(words) {
  if (!Array.isArray(words) || words.length === 0) {
    return err("input is not a non-empty array of words", words);
  }
  if (!words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffffffff)) {
    return err("words must be integers in 0..0xFFFFFFFF", words);
  }

  const w0 = words[0] >>> 0;
  const mt = (w0 >>> 28) & 0xf;
  if (mt !== MT_FLEX) {
    return { kind: "ignored", reason: `not Flex Data (MT 0x${mt.toString(16)}, expected 0xD)`, mt, raw: words.slice() };
  }
  if (words.length !== 4) {
    return err(`Flex Data messages are exactly 4 words; got ${words.length}`, words);
  }

  const group = (w0 >>> 24) & 0xf;
  const format = (w0 >>> 22) & 0x3;
  const address = (w0 >>> 20) & 0x3;
  const channel = (w0 >>> 16) & 0xf;
  const bank = (w0 >>> 8) & 0xff;
  const status = w0 & 0xff;

  const header = { group, format, address, channel, bank, status };
  const raw = words.slice();
  const rawHex = words.map(hex);

  if (bank !== FLEX_BANK_SETUP) {
    return { kind: "otherFlex", ...header, raw, rawHex, reason: `Flex Data bank 0x${bank.toString(16).padStart(2, "0")} (not Setup/Performance 0x00)` };
  }

  const warnings = [];
  // Setup-bank messages are single-packet: format must be 0 (complete).
  if (format !== 0) {
    warnings.push(`format ${format} on a Setup/Performance-bank message (spec: 0 = complete single packet)`);
  }

  switch (status) {
    case ST_SET_TEMPO: {
      const tenNsPerQuarter = words[1] >>> 0;
      if (tenNsPerQuarter === 0) {
        return err("Set Tempo with 0 ×10ns per quarter note (division by zero)", words);
      }
      const bpm = 6e9 / tenNsPerQuarter;
      return { kind: "tempo", ...header, tenNsPerQuarter, bpm, raw, rawHex, warnings };
    }

    case ST_SET_KEY_SIGNATURE: {
      const w1 = words[1] >>> 0;
      const sfNibble = (w1 >>> 28) & 0xf;
      const tonicNibble = (w1 >>> 24) & 0xf;

      // Spec: sf nibble = COUNT of sharps (+) / flats (−), two's complement
      // −7..+7 (−8 is out of range). Tonic nibble = letter only; its
      // accidental is IMPLIED by the count when (letter, count) form a legal
      // circle-of-fifths pair.
      const sharpsFlats = nibbleSigned(sfNibble);
      if (sharpsFlats === -8) {
        warnings.push("sharps/flats count 0x8 (−8) is out of the legal −7..+7 range");
      }

      let tonicLetter = null;
      if (tonicNibble > 7) {
        warnings.push(`tonic nibble 0x${tonicNibble.toString(16)} is reserved (valid: 0x0–0x7)`);
      } else {
        tonicLetter = NOTE_LETTERS[tonicNibble]; // null when 0x0 (non-standard/no tonic)
        if (tonicLetter === null) warnings.push("tonic 0x0: no tonic / non-standard key");
      }

      // Legal major-key pairs: count −7..+7 ↔ tonic C♭ G♭ D♭ A♭ E♭ B♭ F C G
      // D A E B F♯ C♯. If (letter, count) is one of these, the implied tonic
      // pitch class follows; otherwise the combination is spec-illegal and
      // majorTonicPc is null (compat.js decides what to do about it).
      let majorTonic = null;
      let majorTonicPc = null;
      if (tonicLetter && sharpsFlats >= -7 && sharpsFlats <= 7) {
        // Tonic of the major key with `count` sharps: pc = (count * 7) mod 12
        // relative to C. Letter: C G D A E B F + accidental cycle.
        const MAJOR_TONICS = {
          "-7": "C♭", "-6": "G♭", "-5": "D♭", "-4": "A♭", "-3": "E♭", "-2": "B♭",
          "-1": "F", 0: "C", 1: "G", 2: "D", 3: "A", 4: "E", 5: "B", 6: "F♯", 7: "C♯",
        };
        const name = MAJOR_TONICS[String(sharpsFlats)];
        if (name[0] === tonicLetter) {
          majorTonic = name;
          majorTonicPc = ((sharpsFlats * 7) % 12 + 12) % 12;
        }
      }
      if (tonicLetter && majorTonicPc === null) {
        warnings.push(
          `(tonic ${tonicLetter}, ${sharpsFlats >= 0 ? "+" : ""}${sharpsFlats}) is not a legal ` +
            `major circle-of-fifths combination`
        );
      }

      return {
        kind: "keySignature",
        ...header,
        sharpsFlats, // spec: signed count of sharps/flats
        sfNibble, // raw nibble (compat.js reinterprets this as an accidental)
        tonicLetter, // "A".."G" or null
        tonicLetterPc: tonicLetter ? LETTER_PC[tonicLetter] : null,
        majorTonic, // e.g. "F♯" when (letter, count) is legal, else null
        majorTonicPc, // implied tonic pc under the legal major reading, else null
        raw,
        rawHex,
        warnings,
      };
    }

    case ST_SET_CHORD_NAME: {
      const w1 = words[1] >>> 0;
      const w2 = words[2] >>> 0;
      const w3 = words[3] >>> 0;

      const tonic = decodeAccidentalNote((w1 >>> 28) & 0xf, (w1 >>> 24) & 0xf, "chord tonic", warnings);
      const chordType = (w1 >>> 16) & 0xff;
      const chordTypeName = CHORD_TYPE_NAMES[chordType];
      if (chordTypeName === undefined) {
        warnings.push(`chord type 0x${chordType.toString(16).padStart(2, "0")} is reserved/unknown (valid: 0x00–0x1B)`);
      }

      const alterations = [
        decodeAlteration((w1 >>> 8) & 0xff),
        decodeAlteration(w1 & 0xff),
        decodeAlteration((w2 >>> 24) & 0xff),
        decodeAlteration((w2 >>> 16) & 0xff),
      ].filter(Boolean);
      for (const a of alterations) {
        if (!a.valid) warnings.push(`chord alteration byte 0x${a.raw.toString(16).padStart(2, "0")} has a reserved operation or degree 0`);
      }

      // Word 3: bass note. All-zero = no explicit bass (bass = chord tonic).
      let bass = null;
      let bassAlterations = [];
      if (w3 !== 0) {
        bass = decodeAccidentalNote((w3 >>> 28) & 0xf, (w3 >>> 24) & 0xf, "bass note", warnings);
        const bassType = (w3 >>> 16) & 0xff;
        bassAlterations = [decodeAlteration((w3 >>> 8) & 0xff), decodeAlteration(w3 & 0xff)].filter(Boolean);
        if (bass) bass.chordType = bassType;
      }

      return {
        kind: "chordName",
        ...header,
        tonic, // { letter, accidental, pc, name } | null
        chordType,
        chordTypeName: chordTypeName ?? null,
        alterations,
        bass, // { letter, accidental, pc, name, chordType } | null
        bassAlterations,
        raw,
        rawHex,
        warnings,
      };
    }

    case ST_SET_TIME_SIGNATURE:
      return { kind: "otherFlex", ...header, raw, rawHex, reason: "Set Time Signature (decoded elsewhere? out of MVP scope)" };

    default:
      return { kind: "otherFlex", ...header, raw, rawHex, reason: `Setup/Performance-bank status 0x${status.toString(16).padStart(2, "0")} not handled` };
  }
}
