// compat.js — Athan compatibility shims (post-decode normalizers).
//
// Athan's encoder (ug-flex-player.html encodeSetKeySignature) puts the
// tonic's ACCIDENTAL in the key signature's sharps/flats nibble; the spec
// puts the sharps/flats COUNT there. His tempo and chord encodings are
// spec-correct (verified against ug-flex-player.html:31600–31702), so the
// key signature is the only thing shimmed.
//
// Policy (locked + reviewer tweak 2026-08-19):
//   * The shim APPLIES only when the spec interpretation is an illegal
//     circle-of-fifths (letter, count) combination — and only when enabled.
//   * BUT both interpretations are always computed, and whenever they
//     DIFFER a divergence record is produced — even when the spec reading
//     is technically legal. This catches Athan-style accidental encodings
//     that happen to land on a legal but wrong spec key signature.
//
// Pure functions; no Scale Navigator concepts, no transport.

import { LETTER_PC } from "./flexdata.js";

// sf nibble reinterpreted as tonic accidental (Athan's encoding):
// 0 natural, 1 ♯, 2 ♯♯, 0xF ♭, 0xE ♭♭.
const ACCIDENTALS = { 0: 0, 1: 1, 2: 2, 0xf: -1, 0xe: -2 };
const ACC_NAMES = { "-2": "𝄫", "-1": "♭", 0: "", 1: "♯", 2: "𝄪" };

/**
 * interpretKeySignature(decoded, { shimEnabled }) — resolve a decoded
 * "keySignature" message (from decodeFlexDataSpec) to a tonic pitch class.
 *
 * Returns {
 *   tonicPc,            // resolved pc 0..11, or null when unresolvable
 *   tonicName,          // display name of the resolved tonic
 *   used,               // "spec" | "compat" | "letter-fallback" | "none"
 *   specLegal,          // was (letter, count) a legal major pair?
 *   spec:   { tonicPc, tonicName } | null,   // spec interpretation
 *   compat: { tonicPc, tonicName } | null,   // Athan interpretation
 *   divergence,         // null, or { spec, compat, reason } whenever the
 *                       //   two interpretations differ (ALWAYS reported,
 *                       //   even if the spec reading is legal)
 *   shimFired,          // true when the compat reading actually drove tonicPc
 *   notes: []           // human-readable log lines
 * }
 */
export function interpretKeySignature(decoded, { shimEnabled = true } = {}) {
  const notes = [];
  const out = {
    tonicPc: null,
    tonicName: null,
    used: "none",
    specLegal: false,
    spec: null,
    compat: null,
    divergence: null,
    shimFired: false,
    notes,
  };
  if (!decoded || decoded.kind !== "keySignature") {
    notes.push("interpretKeySignature called on a non-keySignature message");
    return out;
  }
  if (!decoded.tonicLetter) {
    notes.push("no tonic letter (0x0 or reserved) — key signature carries no tonic to resolve");
    return out;
  }

  const letterPc = LETTER_PC[decoded.tonicLetter];
  const count = decoded.sharpsFlats;
  const countStr = (count >= 0 ? "+" : "") + count;

  // --- Spec interpretation: sf = sharps/flats count; tonic accidental is
  // implied when (letter, count) is a legal major pair; otherwise the best
  // spec-faithful reading left is the natural letter.
  const specLegal = decoded.majorTonicPc !== null;
  out.specLegal = specLegal;
  out.spec = specLegal
    ? { tonicPc: decoded.majorTonicPc, tonicName: decoded.majorTonic }
    : { tonicPc: letterPc, tonicName: decoded.tonicLetter + " (letter taken as natural; combination illegal)" };

  // --- Compat interpretation: sf = tonic ACCIDENTAL (Athan's encoder).
  const acc = ACCIDENTALS[decoded.sfNibble];
  if (acc !== undefined) {
    const pc = ((letterPc + acc) % 12 + 12) % 12;
    out.compat = { tonicPc: pc, tonicName: decoded.tonicLetter + ACC_NAMES[acc] };
  } else {
    notes.push(
      `compat: sf nibble 0x${decoded.sfNibble.toString(16)} is not a valid accidental either — no Athan interpretation`
    );
  }

  // --- Divergence: ALWAYS reported when both interpretations exist and
  // disagree, regardless of spec legality (reviewer tweak: never silently
  // choose a wrong key just because malformed data landed on a legal one).
  if (out.compat && out.spec.tonicPc !== out.compat.tonicPc) {
    out.divergence = {
      spec: out.spec,
      compat: out.compat,
      reason: specLegal
        ? `spec reading (tonic ${decoded.tonicLetter}, count ${countStr} → ${out.spec.tonicName}) is LEGAL but ` +
          `differs from the Athan accidental reading (${out.compat.tonicName}) — if the sender is Athan's ` +
          `encoder, the spec reading is legal-but-wrong; verify the source`
        : `spec reading (tonic ${decoded.tonicLetter}, count ${countStr}) is not a legal circle-of-fifths ` +
          `combination; Athan's encoder puts the tonic accidental in the sf nibble → ${out.compat.tonicName}`,
    };
    notes.push(`interpretations differ: spec=${out.spec.tonicName} vs compat=${out.compat.tonicName}`);
  }

  // --- Resolution policy: spec wins whenever it is legal; the shim only
  // rescues ILLEGAL spec combinations (and only when enabled).
  if (specLegal) {
    out.tonicPc = out.spec.tonicPc;
    out.tonicName = out.spec.tonicName;
    out.used = "spec";
  } else if (out.compat && out.compat.tonicPc === letterPc) {
    // Illegal spec combo, but the accidental reading agrees with the natural
    // letter (e.g. Athan's "D": sf=0 reads the same both ways) — nothing to
    // correct, so the shim does not count as fired.
    out.tonicPc = letterPc;
    out.tonicName = decoded.tonicLetter;
    out.used = "agree";
    notes.push(`spec combination illegal but both readings agree on ${decoded.tonicLetter} — shim not needed`);
  } else if (shimEnabled && out.compat) {
    out.tonicPc = out.compat.tonicPc;
    out.tonicName = out.compat.tonicName;
    out.used = "compat";
    out.shimFired = true;
    notes.push(`compat shim fired: using ${out.compat.tonicName} (spec combination illegal)`);
  } else {
    out.tonicPc = letterPc;
    out.tonicName = decoded.tonicLetter;
    out.used = "letter-fallback";
    notes.push(
      shimEnabled
        ? `no valid compat reading; falling back to natural letter ${decoded.tonicLetter}`
        : `compat shim disabled; falling back to natural letter ${decoded.tonicLetter}`
    );
  }

  return out;
}
