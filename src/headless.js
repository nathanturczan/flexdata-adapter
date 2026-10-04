// headless.js — the adapter console's semantic pipeline with no DOM, no
// Firebase, no WebSocket: UMP words in, LALORK bridge POSTs out.
//
// This is the embeddable form of main.js's handleUmp() for the Music China
// booth build, where ug-flex-player.html hosts the pipeline in-process
// (player → decode → map → batch → http://127.0.0.1:8767/harmony).
// The mapping policy is main.js's, minus the room sink:
//   * tempo        → { bpm }
//   * keySignature → { scaleKey } (compat shim on by default; silently
//                    dropped when unresolvable — no room to freeze)
//   * chordName    → { chordKey, chordInfo, externalBassPc }, explicit
//                    clears forwarded as nulls; when not SN-representable
//                    but exact tones exist, the voicing still goes local
//                    (same as main.js's "room frozen, bridge gets exact").
//
// Build: npx vite build --config vite.headless.config.js
//   → dist-headless/flexdata-headless.js (IIFE, global FlexDataHeadless)

import { decodeFlexDataSpec } from "./flexdata.js";
import { interpretKeySignature } from "./compat.js";
import { createMapper } from "./mapper.js";
import { createBatcher } from "./batcher.js";
import { createLocalSink } from "./localsink.js";
import ScaleData from "./data/ScaleData.js";
import chordDict from "./data/chords_no_supersets.json";

export function createHeadlessAdapter({
  url = "http://127.0.0.1:8767/harmony",
  windowMs = 50,
  shimEnabled = true,
  onStatus = () => {},   // (ok, detail) after every bridge POST
  onEvent = () => {},    // ({ kind, msg }) decode/map notes, for a debug log
} = {}) {
  const mapper = createMapper({ scaleData: ScaleData, chordDict });
  const sink = createLocalSink({ url });

  // Full harmony state, merged from every commit. After the bridge drops
  // (Ableton restarted, device reloaded) the first write back — or the 2s
  // retry — carries the COMPLETE state, so a reconnected bridge never sits
  // on stale harmony waiting for fields that were duplicate-suppressed.
  const state = {};
  let online = true;
  let retryTimer = null;

  function write(patch) {
    sink
      .write(patch)
      .then((body) => {
        online = true;
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        onStatus(true, body);
      })
      .catch((err) => {
        online = false;
        onStatus(false, err.message);
        if (!retryTimer) {
          retryTimer = setTimeout(() => {
            retryTimer = null;
            if (!online && Object.keys(state).length) write({ ...state });
          }, 2000);
        }
      });
  }

  const batcher = createBatcher({
    windowMs,
    commit(patch) {
      Object.assign(state, patch);
      write(online ? patch : { ...state });
    },
  });

  function handleUmp(words, source = "player") {
    const decoded = decodeFlexDataSpec(words);

    if (decoded.kind === "error") {
      onEvent({ kind: "error", msg: `malformed: ${decoded.reason}` });
      return decoded;
    }
    if (decoded.kind === "ignored" || decoded.kind === "otherFlex") {
      return decoded;
    }

    if (decoded.kind === "tempo") {
      const { bpm } = mapper.mapTempo(decoded);
      batcher.push({ bpm }, source);
      return decoded;
    }

    if (decoded.kind === "keySignature") {
      const interp = interpretKeySignature(decoded, { shimEnabled });
      const { scaleKey, meta } = mapper.mapKeySignature(interp);
      if (interp.divergence) onEvent({ kind: "divergence", msg: interp.divergence.reason });
      if (!scaleKey) {
        onEvent({ kind: "unrepresentable", msg: meta.unrepresentable.reason });
        return decoded;
      }
      batcher.push({ scaleKey }, source);
      return decoded;
    }

    if (decoded.kind === "chordName") {
      const { chordKey, chordInfo, meta } = mapper.mapChord(decoded);
      // A chord and its slash bass are one statement: clear duplicate
      // suppression so chordData, chordInfo and externalBassPc always
      // travel in the same patch (C/E → Am/E must not lose the E).
      batcher.resetDuplicateSuppression();
      if (meta.cleared) {
        batcher.push({ chordKey: null, chordInfo: null, externalBassPc: null }, source);
        return decoded;
      }
      if (meta.unrepresentable) {
        onEvent({ kind: "unrepresentable", msg: meta.unrepresentable.reason });
        if (chordInfo) {
          // SN dataset can't name it but the exact tones can still play.
          batcher.push({ chordInfo, externalBassPc: meta.externalBassPc ?? null }, source);
        }
        return decoded;
      }
      batcher.push({ chordKey, chordInfo, externalBassPc: meta.externalBassPc ?? null }, source);
      return decoded;
    }

    return decoded;
  }

  return {
    handleUmp,
    setUrl: (u) => sink.setUrl(u),
    getUrl: () => sink.getUrl(),
    flushNow: () => batcher.flushNow(),
    resetDuplicateSuppression: () => batcher.resetDuplicateSuppression(),
  };
}
