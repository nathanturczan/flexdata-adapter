// localsink.js — offline local output: POSTs normalized harmony patches to
// the LA Laptop Orchestra Bridge's loopback HTTP endpoint
// (default http://127.0.0.1:8767/harmony).
//
// Boundary translation (mapper vocabulary → LALORK room vocabulary):
//   scaleKey → scaleData, chordKey → chordData; bpm and externalBassPc pass
//   through unchanged. Only fields present on the patch are sent; explicit
//   nulls (clears) are forwarded as JSON null. The mapper's internal names
//   never leave this boundary — the bridge accepts only room vocabulary.
//
// Exact voicing (Harmony Payload v2): a non-null chordInfo rides along
// verbatim, and because the bridge requires chordData === chordInfo.id, the
// display id REPLACES the Boyd dataset key as chordData on the local wire.
// (The Firestore room path never sees chordInfo — room.js/updateEnsembleState
// write only their named fields.)
//
// Pure module: no DOM, no Firebase. Uses global fetch (browser + Node 18+).

const FIELD_MAP = {
  bpm: "bpm",
  scaleKey: "scaleData",
  chordKey: "chordData",
  externalBassPc: "externalBassPc",
};

// Translate a batcher patch into the bridge's wire vocabulary.
export function translatePatch(patch) {
  const out = {};
  for (const [from, to] of Object.entries(FIELD_MAP)) {
    if (from in patch) out[to] = patch[from];
  }
  if (patch.chordInfo != null) {
    out.chordData = patch.chordInfo.id; // bridge invariant: chordData === chordInfo.id
    out.chordInfo = patch.chordInfo;
  }
  return out;
}

export function createLocalSink({ url = "http://127.0.0.1:8767/harmony" } = {}) {
  let target = url;
  return {
    setUrl(u) {
      target = u;
    },
    getUrl() {
      return target;
    },
    // Resolves with the translated body on 200; throws on network failure or
    // any non-2xx status (bridge's error text included when available).
    async write(patch) {
      const body = translatePatch(patch);
      const res = await fetch(target, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          const j = await res.json();
          if (j && j.error) msg += `: ${j.error}`;
        } catch {
          // non-JSON error body — status alone is the message
        }
        throw new Error(msg);
      }
      return body;
    },
  };
}
