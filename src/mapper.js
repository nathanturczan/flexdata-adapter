// mapper.js — mapping POLICY from decoded Flex Data semantics into Scale
// Navigator vocabulary. Explicitly a translation policy ("best available SN
// interpretation"), NOT an ontological equivalence: every loss is recorded
// in `meta` so the UI can make it visible.
//
// Pure functions over injected data (no transport deps, no Firebase):
//   const mapper = createMapper({ scaleData, chordDict });
//   mapper.mapChord(decodedChord)          → { chordKey|null, chordInfo|null, meta }
//   mapper.mapKeySignature(interpretedKs)  → { scaleKey|null, meta }
//   mapper.mapTempo(decodedTempo)          → { bpm|null, meta }
//
// chordKey is the best-available Boyd dataset key (the Firestore room path's
// vocabulary — approximation losses recorded in meta). chordInfo is the
// chord's EXACT rendering { id, root, voicing } computed from the Flex type
// + alterations, independent of the dataset — the local bridge plays this
// verbatim (LALORK "Harmony Payload v2"). Interval formulas and alteration
// semantics are mirrored from the SENDER's own tables (ug-flex-player.html
// INTERVALS / DEG_SEMI / applyAlt), so what LALORK plays matches what the
// arranger keyboard itself sounds.
//
// Data shapes: scaleData = ScaleData.js export (keys like "cs_diatonic");
// chordDict = chords_no_supersets.json (keys like "cs_7-17" =
// `${rootToken}_${typeToken}-${voicingId}`).

// Root token → pitch class (the dataset spells all roots with sharps).
const ROOT_TOKEN_PC = {
  c: 0, cs: 1, d: 2, ds: 3, e: 4, f: 5, fs: 6, g: 7, gs: 8, a: 9, as: 10, b: 11,
};

// Flex Data ChordType enum → ordered candidate SN chord-type tokens.
// `exact`: tokens considered a faithful rendering of the Flex type;
// `approx`: best-available stand-ins (resolving from here is a logged loss).
// Tokens are the literal strings used in chords_no_supersets.json keys
// (note the unicode ♭). Empty exact+approx ⇒ unrepresentable in the dataset.
export const CHORD_TYPE_CANDIDATES = {
  0x01: { exact: ["M", "maj"], approx: ["6", "M7"] }, // dataset has no plain major triad
  0x02: { exact: ["6"], approx: ["6/9"] },
  0x03: { exact: ["M7", "maj7"], approx: ["M9"] },
  0x04: { exact: ["M9"], approx: ["M7"] },
  0x05: { exact: ["M11"], approx: ["M9", "M7"] },
  0x06: { exact: ["M13"], approx: ["M9(add6)", "M9"] },
  0x07: { exact: ["m", "min"], approx: ["m7", "m6"] }, // no plain minor triad either
  0x08: { exact: ["m6"], approx: ["m6/9"] },
  0x09: { exact: ["m7"], approx: ["m9"] },
  0x0a: { exact: ["m9"], approx: ["m7"] },
  0x0b: { exact: ["m11"], approx: ["m9"] },
  0x0c: { exact: ["m13"], approx: ["m9(add6)", "m11"] },
  0x0d: { exact: ["7"], approx: ["9"] },
  0x0e: { exact: ["9"], approx: ["7"] },
  0x0f: { exact: ["11", "9/11"], approx: ["9"] },
  0x10: { exact: ["13"], approx: ["9"] },
  0x11: { exact: ["aug", "+"], approx: ["7#5"] },
  0x12: { exact: ["7#5", "aug7"], approx: ["9#5"] },
  0x13: { exact: ["dim", "o"], approx: ["m7♭5"] }, // dataset "dim" keys carry dim7 content
  0x14: { exact: ["dim", "o7"], approx: [] },
  0x15: { exact: ["m7♭5", "m7b5"], approx: ["m11♭5"] },
  0x16: { exact: ["m(Maj7)", "mM7"], approx: ["m6(Maj7)"] },
  0x17: { exact: [], approx: [] }, // Pedal — no harmony content to map
  0x18: { exact: [], approx: [] }, // Power — no 5-chords in the dataset
  0x19: { exact: ["sus2"], approx: [] },
  0x1a: { exact: ["sus4", "sus"], approx: [] },
  0x1b: { exact: ["7sus4"], approx: ["9/11"] }, // 11-chord voicing ≈ 7sus4 (jazz practice)
};

// ---------------------------------------------------------------------------
// Exact chord tones (chordInfo) — mirrored from the sender
// ---------------------------------------------------------------------------

// Flex ChordType → semitone intervals above the tonic. Same content as the
// player's INTERVALS table keyed by symbol; keep the two in sync.
export const CHORD_TYPE_INTERVALS = {
  0x01: [0, 4, 7],
  0x02: [0, 4, 7, 9],
  0x03: [0, 4, 7, 11],
  0x04: [0, 4, 7, 11, 14],
  0x05: [0, 4, 7, 11, 17],
  0x06: [0, 4, 7, 11, 21],
  0x07: [0, 3, 7],
  0x08: [0, 3, 7, 9],
  0x09: [0, 3, 7, 10],
  0x0a: [0, 3, 7, 10, 14],
  0x0b: [0, 3, 7, 10, 17],
  0x0c: [0, 3, 7, 10, 21],
  0x0d: [0, 4, 7, 10],
  0x0e: [0, 4, 7, 10, 14],
  0x0f: [0, 4, 7, 10, 17],
  0x10: [0, 4, 7, 10, 21],
  0x11: [0, 4, 8],
  0x12: [0, 4, 8, 10],
  0x13: [0, 3, 6],
  0x14: [0, 3, 6, 9],
  0x15: [0, 3, 6, 10],
  0x16: [0, 3, 7, 11],
  0x17: [0], // Pedal: tonic only
  0x18: [0, 7], // Power
  0x19: [0, 2, 7],
  0x1a: [0, 5, 7],
  0x1b: [0, 5, 7, 10],
};

// Scale degree → semitones (player's DEG_SEMI). Degrees absent here (1, 3,
// 8, 10, 12, 14, 15) are skipped by the SENDER's own voicing logic too —
// skipping them keeps the two ends identical.
const DEG_SEMI = { 2: 2, 4: 5, 5: 7, 6: 9, 7: 11, 9: 14, 11: 17, 13: 21 };

// Flex ChordType → display suffix for the chordInfo id / bridge display.
const CHORD_TYPE_SUFFIX = {
  0x01: "", 0x02: "6", 0x03: "maj7", 0x04: "maj9", 0x05: "maj11", 0x06: "maj13",
  0x07: "m", 0x08: "m6", 0x09: "m7", 0x0a: "m9", 0x0b: "m11", 0x0c: "m13",
  0x0d: "7", 0x0e: "9", 0x0f: "11", 0x10: "13", 0x11: "aug", 0x12: "aug7",
  0x13: "dim", 0x14: "dim7", 0x15: "m7b5", 0x16: "mM7", 0x17: "ped", 0x18: "5",
  0x19: "sus2", 0x1a: "sus4", 0x1b: "7sus4",
};

// ASCII accidentals for the display id (Max textboxes; no unicode risk).
const ACC_ASCII = { "-2": "bb", "-1": "b", 0: "", 1: "#", 2: "##" };
const noteAscii = (n) => n.letter + (ACC_ASCII[String(n.accidental)] ?? "");
const ALT_ASCII = { add: (d) => `add${d}`, subtract: (d) => `omit${d}`, raise: (d) => `#${d}`, lower: (d) => `b${d}` };

// Player-mirrored alteration application (applyAlt in ug-flex-player.html):
// subtract removes the degree's pitch class; raise/lower shift the degree by
// a semitone (an altered 5th replaces the natural 5th, other altered/added
// tones replace their natural degree); add inserts the natural degree.
function applyAlterations(intervals, alterations) {
  let s = intervals.slice();
  const skipped = [];
  for (const a of alterations) {
    const base = DEG_SEMI[a.degree];
    if (!a.valid || a.op === null || base === undefined) {
      skipped.push(a);
      continue;
    }
    if (a.op === "subtract") {
      s = s.filter((x) => x % 12 !== base % 12);
      continue;
    }
    const semi = a.op === "raise" ? base + 1 : a.op === "lower" ? base - 1 : base;
    if (a.degree === 5) s = s.filter((x) => x !== 7);
    else s = s.filter((x) => x !== base);
    s.push(semi);
  }
  return { intervals: [...new Set(s)].sort((x, y) => x - y), skipped };
}

/**
 * Exact chordInfo { id, root, voicing } from a decoded Set Chord Name, or
 * null when the Flex type has no interval formula (reserved/unknown enums).
 * `id` is a display symbol ("G", "E7#9", "Am/G"); the local bridge requires
 * chordData === chordInfo.id, so the id doubles as the wire chordData.
 * Also returns the alterations the formula skipped (mirrors the sender).
 */
export function buildExactChord(decoded) {
  const base = CHORD_TYPE_INTERVALS[decoded.chordType];
  if (!base || !decoded.tonic) return { chordInfo: null, skipped: [] };
  const { intervals, skipped } = applyAlterations(base, decoded.alterations || []);
  const rootPc = decoded.tonic.pc;
  const rootMidi = 48 + rootPc; // C3-B3 root; register is cosmetic (bridge palettes use pitch classes)
  const voicing = (intervals.length ? intervals : [0]).map((iv) => rootMidi + iv);
  let id = noteAscii(decoded.tonic) + CHORD_TYPE_SUFFIX[decoded.chordType];
  for (const a of decoded.alterations || []) {
    if (skipped.includes(a)) continue;
    id += ALT_ASCII[a.op](a.degree);
  }
  if (decoded.bass) id += "/" + noteAscii(decoded.bass);
  return { chordInfo: { id, root: rootPc, voicing }, skipped };
}

export function createMapper({ scaleData, chordDict }) {
  // ---- indexes built once by probing the datasets (handles enharmonics:
  // pc 1 resolves to whatever token the data actually uses, i.e. "cs").

  // pc → root token, from chord keys.
  const chordRootByPc = {};
  // `${rootToken}_${typeToken}` → lowest (canonical) full key.
  const canonicalKeyByPrefix = {};
  for (const key of Object.keys(chordDict)) {
    if (key.startsWith("_")) continue; // provenance/meta keys
    const us = key.indexOf("_");
    const dash = key.lastIndexOf("-");
    if (us <= 0 || dash <= us) continue;
    const root = key.slice(0, us);
    const prefix = key.slice(0, dash);
    const id = Number(key.slice(dash + 1));
    const pc = ROOT_TOKEN_PC[root];
    if (pc === undefined || Number.isNaN(id)) continue;
    if (!(pc in chordRootByPc)) chordRootByPc[pc] = root;
    const cur = canonicalKeyByPrefix[prefix];
    if (cur === undefined || id < Number(cur.slice(cur.lastIndexOf("-") + 1))) {
      canonicalKeyByPrefix[prefix] = key;
    }
  }

  // pc → root token for scales (probing `${token}_diatonic` existence).
  const scaleRootByPc = {};
  for (const [token, pc] of Object.entries(ROOT_TOKEN_PC)) {
    if (scaleData[`${token}_diatonic`]) scaleRootByPc[pc] = token;
  }

  function mapChord(decoded) {
    const meta = {
      kind: "chord",
      flexType: decoded.chordType,
      flexTypeName: decoded.chordTypeName,
      losses: [],
      unrepresentable: null,
      cleared: false,
      approximated: false,
      externalBassPc: null,
      alterations: null,
    };

    // Explicit clear (type 0x00): a representable "no chord" state —
    // deliberately distinct from "unrepresentable".
    if (decoded.chordType === 0x00) {
      meta.cleared = true;
      return { chordKey: null, chordInfo: null, meta };
    }

    if (!decoded.tonic) {
      meta.unrepresentable = { reason: "chord has no tonic (nibble 0x0 or reserved)", raw: decoded.raw };
      return { chordKey: null, chordInfo: null, meta };
    }

    // Exact rendering — independent of the Boyd dataset. Alterations the
    // sender's own voicing logic skips are skipped here too (and logged).
    const exact = buildExactChord(decoded);
    const chordInfo = exact.chordInfo;
    for (const a of exact.skipped) {
      meta.losses.push(
        `alteration ${a.op ?? "?"} ${a.degree} has no interval mapping — skipped in the exact voicing (sender skips it too)`
      );
    }

    // Slash bass: decoded and carried as metadata — NOT representable inside
    // an SN chord key. Loss made visible.
    if (decoded.bass && decoded.bass.pc !== undefined && decoded.bass.pc !== null) {
      meta.externalBassPc = decoded.bass.pc;
      meta.losses.push(
        `slash bass ${decoded.bass.name} carried as externalBassPc metadata — not representable in an SN chord key`
      );
    }

    // Alterations: decoded and logged as loss; base ChordType is what maps.
    if (decoded.alterations && decoded.alterations.length) {
      meta.alterations = decoded.alterations;
      meta.losses.push(
        "chord alterations dropped from the mapped key (out of MVP scope): " +
          decoded.alterations.map((a) => `${a.op ?? "?"} ${a.degree}`).join(", ")
      );
    }

    const candidates = CHORD_TYPE_CANDIDATES[decoded.chordType];
    if (!candidates) {
      meta.unrepresentable = {
        reason: `unknown/reserved Flex chord type 0x${decoded.chordType.toString(16).padStart(2, "0")}`,
        raw: decoded.raw,
      };
      return { chordKey: null, chordInfo, meta };
    }

    const rootToken = chordRootByPc[decoded.tonic.pc];
    if (rootToken === undefined) {
      meta.unrepresentable = { reason: `no chord root token for pitch class ${decoded.tonic.pc}`, raw: decoded.raw };
      return { chordKey: null, chordInfo, meta };
    }

    for (const phase of ["exact", "approx"]) {
      for (const typeToken of candidates[phase]) {
        const key = canonicalKeyByPrefix[`${rootToken}_${typeToken}`];
        if (key) {
          if (phase === "approx") {
            meta.approximated = true;
            meta.losses.push(
              `Flex type "${decoded.chordTypeName}" has no exact SN token — approximated as "${typeToken}"` +
                (chordInfo ? " (room path only; the local bridge gets the exact voicing)" : "")
            );
          }
          meta.resolvedType = typeToken;
          return { chordKey: key, chordInfo, meta };
        }
      }
    }

    meta.unrepresentable = {
      reason:
        `Flex type "${decoded.chordTypeName ?? "0x" + decoded.chordType.toString(16)}" on root ` +
        `${decoded.tonic.name}: no matching chord key in the dataset ` +
        `(tried ${[...candidates.exact, ...candidates.approx].map((t) => `${rootToken}_${t}-*`).join(", ") || "nothing — type has no SN candidates"})`,
      raw: decoded.raw,
    };
    return { chordKey: null, chordInfo, meta };
  }

  // Key signature → best available SN interpretation: `${root}_diatonic`.
  // POLICY, not equivalence: a MIDI key signature names a tonic + accidental
  // count; SN's `x_diatonic` is a scale COLLECTION whose root is only a
  // disambiguator. The mismatch is itself a finding; recorded in meta.
  function mapKeySignature(interpreted) {
    const meta = {
      kind: "keySignature",
      policy: "MIDI key signature → `${root}_diatonic` (best available SN interpretation)",
      losses: [],
      unrepresentable: null,
      interpretation: interpreted.used,
      divergence: interpreted.divergence || null,
    };
    if (interpreted.tonicPc === null || interpreted.tonicPc === undefined) {
      meta.unrepresentable = { reason: "key signature carries no resolvable tonic" };
      return { scaleKey: null, meta };
    }
    const rootToken = scaleRootByPc[interpreted.tonicPc];
    if (rootToken === undefined) {
      meta.unrepresentable = { reason: `no diatonic scale for pitch class ${interpreted.tonicPc}` };
      return { scaleKey: null, meta };
    }
    meta.losses.push(
      `key signature "${interpreted.tonicName}" mapped to the ${rootToken}_diatonic collection — ` +
        "mode/quality information (if any) is not represented"
    );
    return { scaleKey: `${rootToken}_diatonic`, meta };
  }

  function mapTempo(decoded) {
    const meta = { kind: "tempo", losses: [] };
    let bpm = Math.round(decoded.bpm);
    if (bpm < 20 || bpm > 400) {
      const clamped = Math.min(400, Math.max(20, bpm));
      meta.losses.push(`tempo ${bpm} bpm outside sanity range 20–400 — clamped to ${clamped}`);
      bpm = clamped;
    }
    return { bpm, meta };
  }

  return { mapChord, mapKeySignature, mapTempo, _indexes: { chordRootByPc, scaleRootByPc } };
}
