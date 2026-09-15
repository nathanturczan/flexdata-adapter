// localsink.test.mjs — node --test suite for the local (offline) output:
// boundary translation to LALORK room vocabulary, HTTP behavior against a
// real loopback stub server, failure/recovery, and the full known-good-song
// fixture through decode → compat → map → batch → sink.
// No Firebase, no network beyond 127.0.0.1.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createLocalSink, translatePatch } from "../src/localsink.js";
import { decodeFlexDataSpec } from "../src/flexdata.js";
import { interpretKeySignature } from "../src/compat.js";
import { createMapper } from "../src/mapper.js";
import { createBatcher } from "../src/batcher.js";
import ScaleData from "../src/data/ScaleData.js";

const here = dirname(fileURLToPath(import.meta.url));
const chordDict = JSON.parse(readFileSync(join(here, "../src/data/chords_no_supersets.json"), "utf8"));

// ---- loopback stub server (stands in for the LALORK Bridge) ---------------
function startStub({ status = 200, body = { ok: true, source: "local" } } = {}) {
  const received = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      received.push({
        method: req.method,
        url: req.url,
        contentType: req.headers["content-type"],
        raw,
      });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        received,
        port,
        url: `http://127.0.0.1:${port}/harmony`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// ========================================================= 1. translation
test("translate: mapper vocabulary → room vocabulary at the boundary", () => {
  assert.deepEqual(
    translatePatch({ bpm: 120, scaleKey: "c_diatonic", chordKey: "c_7-17", externalBassPc: 7 }),
    { bpm: 120, scaleData: "c_diatonic", chordData: "c_7-17", externalBassPc: 7 }
  );
});

test("translate: only fields present on the patch are sent", () => {
  assert.deepEqual(translatePatch({ bpm: 96 }), { bpm: 96 });
  assert.deepEqual(translatePatch({ scaleKey: "d_diatonic" }), { scaleData: "d_diatonic" });
});

test("translate: explicit nulls (clears) are forwarded as null", () => {
  assert.deepEqual(translatePatch({ chordKey: null, externalBassPc: null }), {
    chordData: null,
    externalBassPc: null,
  });
});

test("translate: internal field names never leak to the wire", () => {
  const out = translatePatch({ chordKey: "c_7-17", meta: { losses: [] }, source: "ws" });
  assert.deepEqual(out, { chordData: "c_7-17" });
  assert.ok(!("chordKey" in out) && !("scaleKey" in out));
});

test("translate: chordInfo rides along and its id replaces the Boyd key as chordData", () => {
  const chordInfo = { id: "C7", root: 0, voicing: [48, 52, 55, 58] };
  const out = translatePatch({ chordKey: "c_7-17", chordInfo, externalBassPc: null });
  assert.deepEqual(out, { chordData: "C7", externalBassPc: null, chordInfo });
  assert.equal(out.chordData, out.chordInfo.id, "bridge invariant: chordData === chordInfo.id");
});

test("translate: chordInfo-only patch (SN-unrepresentable local exact) still names chordData", () => {
  const chordInfo = { id: "C5", root: 0, voicing: [48, 55] };
  assert.deepEqual(translatePatch({ chordInfo }), { chordData: "C5", chordInfo });
});

test("translate: null chordInfo is not sent (clear stays a bare chordData null)", () => {
  assert.deepEqual(translatePatch({ chordKey: null, chordInfo: null, externalBassPc: null }), {
    chordData: null,
    externalBassPc: null,
  });
});

// ======================================================== 2. HTTP behavior
test("write: POSTs application/json to the configured URL with exact wire body", async () => {
  const stub = await startStub();
  const sink = createLocalSink({ url: stub.url });
  await sink.write({ bpm: 120, scaleKey: "c_diatonic", chordKey: "c_7-17" });
  await stub.close();

  assert.equal(stub.received.length, 1);
  const r = stub.received[0];
  assert.equal(r.method, "POST");
  assert.equal(r.url, "/harmony");
  assert.equal(r.contentType, "application/json");
  // Byte-exact wire contract the bridge validates against.
  assert.equal(r.raw, '{"bpm":120,"scaleData":"c_diatonic","chordData":"c_7-17"}');
});

test("write: non-2xx response throws with the bridge's error text", async () => {
  const stub = await startStub({ status: 400, body: { ok: false, error: "unknown field(s): nope" } });
  const sink = createLocalSink({ url: stub.url });
  await assert.rejects(() => sink.write({ bpm: 120 }), /HTTP 400: unknown field\(s\): nope/);
  await stub.close();
});

test("write: connection refused fails cleanly, next write recovers (sender restart)", async () => {
  // Reserve a port, then close it so nothing is listening.
  const probe = await startStub();
  const deadUrl = probe.url;
  await probe.close();

  const sink = createLocalSink({ url: deadUrl });
  await assert.rejects(() => sink.write({ bpm: 120 }));

  // "Bridge restarts" on a fresh port; sink retargets and succeeds.
  const revived = await startStub();
  sink.setUrl(revived.url);
  await sink.write({ bpm: 121 });
  assert.equal(revived.received.length, 1);
  assert.equal(revived.received[0].raw, '{"bpm":121}');
  await revived.close();
});

// ==================================== 3. known-good song fixture, end to end
test("fixture: known-good song → decode → map → batch → local sink wire bodies", async () => {
  const fixture = JSON.parse(readFileSync(join(here, "fixtures/known-good-song.json"), "utf8"));
  const stub = await startStub();
  const sink = createLocalSink({ url: stub.url });
  const mapper = createMapper({ scaleData: ScaleData, chordDict });

  // Mirror main.js's queue() field shapes exactly; manual window flushing.
  const commits = [];
  const batcher = createBatcher({
    windowMs: 50,
    commit: (patch) => commits.push(patch),
  });
  batcher._setTimerFn(() => null);

  for (const ev of fixture.events) {
    const decoded = decodeFlexDataSpec(ev.ump);
    assert.notEqual(decoded.kind, "error", `${ev.label}: decoded`);
    if (decoded.kind === "tempo") {
      const { bpm } = mapper.mapTempo(decoded);
      batcher.push({ bpm }, "fixture");
    } else if (decoded.kind === "keySignature") {
      const interp = interpretKeySignature(decoded, { shimEnabled: true });
      const { scaleKey } = mapper.mapKeySignature(interp);
      assert.ok(scaleKey, `${ev.label}: resolvable`);
      batcher.push({ scaleKey }, "fixture");
    } else if (decoded.kind === "chordName") {
      const { chordKey, chordInfo, meta } = mapper.mapChord(decoded);
      if (meta.cleared) batcher.push({ chordKey: null, chordInfo: null, externalBassPc: null }, "fixture");
      else {
        assert.ok(chordKey, `${ev.label}: representable`);
        batcher.push({ chordKey, chordInfo, externalBassPc: meta.externalBassPc ?? null }, "fixture");
      }
    }
    batcher.flushNow(); // one window per fixture event (deterministic)
  }

  const C7 = { id: "C7", root: 0, voicing: [48, 52, 55, 58] };
  const Dm7 = { id: "Dm7", root: 2, voicing: [50, 53, 57, 60] };
  const G7 = { id: "G7", root: 7, voicing: [55, 59, 62, 65] };
  assert.deepEqual(commits, [
    { bpm: 120 },
    { scaleKey: "c_diatonic" },
    { chordKey: "c_7-17", chordInfo: C7, externalBassPc: null },
    // externalBassPc null is duplicate-suppressed after the first chord.
    { chordKey: "d_m7-13", chordInfo: Dm7 },
    { chordKey: "g_7-17", chordInfo: G7 },
    { chordKey: null, chordInfo: null }, // explicit clear is a value, committed
    { chordKey: "c_7-17", chordInfo: C7 }, // NOT a duplicate: the clear reset the last value
  ]);

  // Ship every committed patch through the sink; assert exact wire bodies.
  for (const patch of commits) await sink.write(patch);
  await stub.close();

  assert.deepEqual(
    stub.received.map((r) => r.raw),
    [
      '{"bpm":120}',
      '{"scaleData":"c_diatonic"}',
      '{"chordData":"C7","externalBassPc":null,"chordInfo":{"id":"C7","root":0,"voicing":[48,52,55,58]}}',
      '{"chordData":"Dm7","chordInfo":{"id":"Dm7","root":2,"voicing":[50,53,57,60]}}',
      '{"chordData":"G7","chordInfo":{"id":"G7","root":7,"voicing":[55,59,62,65]}}',
      '{"chordData":null}',
      '{"chordData":"C7","chordInfo":{"id":"C7","root":0,"voicing":[48,52,55,58]}}',
    ]
  );
});
