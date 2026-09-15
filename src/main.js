// main.js — adapter console: UI + wiring.
//
// Pipeline: UMP words (WS from ump-listen.py, or injected JSON)
//   → decodeFlexDataSpec (strict spec)      [flexdata.js]
//   → interpretKeySignature (compat shim)   [compat.js]
//   → createMapper (SN mapping policy)      [mapper.js]
//   → createBatcher (coalescing)            [batcher.js]
//   → attach().write (rehearse's semantic write path) [room.js]
//
// The three-column log (raw UMP | decoded semantics | resolved SN state +
// write status) is the audit trail: it shows exactly where the MIDI
// standard ends and our model begins.

import { decodeFlexDataSpec } from "./flexdata.js";
import { interpretKeySignature } from "./compat.js";
import { createMapper } from "./mapper.js";
import { createBatcher } from "./batcher.js";
import { attach } from "./room.js";
import { createLocalSink } from "./localsink.js";
import ScaleData from "./data/ScaleData.js";
import chordDict from "./data/chords_no_supersets.json";

const $ = (id) => document.getElementById(id);
const logBody = $("log");
const MAX_ROWS = 500;

const mapper = createMapper({ scaleData: ScaleData, chordDict });

// ------------------------------------------------------------------- state
let room = null; // { roomId, uid, write }
let ws = null;
let wsWanted = false;
let wsRetryTimer = null;
const counters = { flex: 0, otherMt: 0, writes: 0, localWrites: 0, suppressed: 0, unrepresentable: 0 };

// Local (offline) output — POSTs room-vocabulary patches to the LALORK
// Bridge on loopback. Independent of the Firestore room: either, both, or
// neither may be active.
const localSink = createLocalSink({ url: $("localUrl").value.trim() });
$("localUrl").addEventListener("change", () => localSink.setUrl($("localUrl").value.trim()));

function setLocalStatus(ok, text) {
  $("localDot").className = "dot " + (ok ? "ok" : "bad");
  $("localStatus").textContent = text;
}

// -------------------------------------------------------------------- log UI
function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function addRow(rawHtml, decodedHtml, resolvedHtml) {
  const tr = document.createElement("tr");
  tr.innerHTML = `<td>${rawHtml}</td><td>${decodedHtml}</td><td>${resolvedHtml}</td>`;
  logBody.prepend(tr);
  while (logBody.children.length > MAX_ROWS) logBody.lastChild.remove();
  return tr;
}

function setResolved(tr, html) {
  tr.children[2].innerHTML = html;
}

function updateCounters() {
  $("counters").textContent =
    `flex:${counters.flex} other-MT:${counters.otherMt} writes:${counters.writes} ` +
    `local:${counters.localWrites} suppressed:${counters.suppressed} unrepresentable:${counters.unrepresentable}`;
}

function showBanner(text, kind = "error") {
  const b = $("banner");
  b.textContent = text;
  b.className = kind === "divergence" ? "divergence" : "";
  b.style.display = "block";
}
function clearBanner() {
  $("banner").style.display = "none";
}

// ----------------------------------------------------------------- batcher
const batcher = createBatcher({
  windowMs: Number($("windowMs").value) || 50,
  onLog(e) {
    if (e.type === "duplicate") {
      counters.suppressed++;
      updateCounters();
      addRow(`<span class="muted">batcher</span>`, `<span class="muted">${esc(e.msg)}</span>`, "");
    }
  },
  commit(patch, entries) {
    const desc = Object.entries(patch)
      .map(([k, v]) => `${k}=${v === null ? "null" : esc(JSON.stringify(v))}`)
      .join("  ");
    const timing = entries.map((en) => `+${en.offset}ms`).join(", ");
    const tr = addRow(
      `<span class="muted">batcher</span>`,
      `<span class="muted">commit (${entries.length} msg${entries.length === 1 ? "" : "s"} @ ${esc(timing)})</span>`,
      `<span class="keytok">${desc}</span> <span class="muted">→ writing…</span>`
    );

    // Independent sinks: local bridge (offline path) and Firestore room.
    const statuses = [];
    const render = () => setResolved(tr, `<span class="keytok">${desc}</span> ${statuses.join(" ")}`);

    const localOn = $("localToggle").checked;
    if (localOn) {
      const i = statuses.push(`<span class="muted">local…</span>`) - 1;
      localSink
        .write(patch)
        .then(() => {
          counters.localWrites++;
          updateCounters();
          statuses[i] = `<span class="okw">✓ local bridge</span>`;
          setLocalStatus(true, "ok");
          render();
        })
        .catch((err) => {
          statuses[i] = `<span class="err">LOCAL FAILED: ${esc(err.message)}</span>`;
          setLocalStatus(false, err.message);
          render();
        });
    }

    if (room) {
      const i = statuses.push(`<span class="muted">room…</span>`) - 1;
      room
        .write(patch)
        .then(() => {
          counters.writes++;
          updateCounters();
          statuses[i] = `<span class="okw">✓ rooms/${esc(room.roomId)}</span>`;
          render();
        })
        .catch((err) => {
          statuses[i] = `<span class="err">WRITE FAILED: ${esc(err.message)}</span>`;
          render();
        });
    }

    if (!localOn && !room) {
      setResolved(tr, `<span class="keytok">${desc}</span> <span class="err">DROPPED — local out off and no room attached</span>`);
      return;
    }
    render();
  },
});
$("windowMs").addEventListener("change", () => batcher.setWindowMs(Number($("windowMs").value) || 50));

// ------------------------------------------------------------ UMP handling
function rawCol(decoded, source) {
  const hexes = (decoded.rawHex || (decoded.raw || []).map((w) => "0x" + (w >>> 0).toString(16).padStart(8, "0")))
    .map((h) => `<span class="hexw">${h}</span>`)
    .join("<br>");
  return `${hexes}<br><span class="muted">${esc(source)}</span>`;
}

function warnLines(warnings) {
  return (warnings || []).map((w) => `<br><span class="warn">⚠ ${esc(w)}</span>`).join("");
}

function lossLines(meta) {
  return (meta.losses || []).map((l) => `<br><span class="loss">loss: ${esc(l)}</span>`).join("");
}

export function handleUmp(words, source) {
  const decoded = decodeFlexDataSpec(words);

  if (decoded.kind === "error") {
    addRow(
      `<span class="hexw">${esc(JSON.stringify(decoded.raw))}</span><br><span class="muted">${esc(source)}</span>`,
      `<span class="err">malformed: ${esc(decoded.reason)}</span>`,
      `<span class="muted">no action</span>`
    );
    return;
  }
  if (decoded.kind === "ignored") {
    counters.otherMt++;
    updateCounters();
    addRow(rawCol(decoded, source), `<span class="muted">${esc(decoded.reason)}</span>`, `<span class="muted">ignored</span>`);
    return;
  }
  if (decoded.kind === "otherFlex") {
    counters.flex++;
    updateCounters();
    addRow(
      rawCol(decoded, source),
      `<span class="kind">Flex Data</span> ${esc(decoded.reason)}`,
      `<span class="muted">not mapped (out of scope)</span>`
    );
    return;
  }

  counters.flex++;
  updateCounters();

  if (decoded.kind === "tempo") {
    const { bpm, meta } = mapper.mapTempo(decoded);
    const tr = addRow(
      rawCol(decoded, source),
      `<span class="kind">Set Tempo</span> ${decoded.bpm.toFixed(3)} bpm (${decoded.tenNsPerQuarter} ×10ns/QN)${warnLines(decoded.warnings)}`,
      `bpm → <span class="keytok">${bpm}</span>${lossLines(meta)}`
    );
    queue(tr, { bpm }, source);
    return;
  }

  if (decoded.kind === "keySignature") {
    const interp = interpretKeySignature(decoded, { shimEnabled: $("shimToggle").checked });
    const { scaleKey, meta } = mapper.mapKeySignature(interp);

    let decHtml =
      `<span class="kind">Set Key Signature</span> sf=${decoded.sharpsFlats >= 0 ? "+" : ""}${decoded.sharpsFlats}, ` +
      `tonic letter ${esc(decoded.tonicLetter ?? "—")}` +
      warnLines(decoded.warnings);
    decHtml += `<br>spec: ${esc(interp.spec ? interp.spec.tonicName : "—")} · compat: ${esc(interp.compat ? interp.compat.tonicName : "—")} · used: <b>${esc(interp.used)}</b>`;
    for (const n of interp.notes) decHtml += `<br><span class="warn">⚠ ${esc(n)}</span>`;

    if (interp.divergence) {
      showBanner(`KEY SIGNATURE INTERPRETATIONS DIVERGE — ${interp.divergence.reason}`, "divergence");
    }

    if (!scaleKey) {
      counters.unrepresentable++;
      updateCounters();
      addRow(rawCol(decoded, source), decHtml, `<span class="err">UNRESOLVABLE — no scale written: ${esc(meta.unrepresentable.reason)}</span>`);
      return;
    }
    const tr = addRow(
      rawCol(decoded, source),
      decHtml,
      `scale → <span class="keytok">${esc(scaleKey)}</span> <span class="muted">(policy: best available SN interpretation)</span>${lossLines(meta)}`
    );
    queue(tr, { scaleKey }, source);
    return;
  }

  if (decoded.kind === "chordName") {
    const { chordKey, chordInfo, meta } = mapper.mapChord(decoded);
    const altStr = decoded.alterations.length
      ? " alts[" + decoded.alterations.map((a) => `${a.op ?? "?"}${a.degree}`).join(",") + "]"
      : "";
    const decHtml =
      `<span class="kind">Set Chord Name</span> ${esc(decoded.tonic ? decoded.tonic.name : "—")} ` +
      `${esc(decoded.chordTypeName ?? "type 0x" + decoded.chordType.toString(16))}` +
      (decoded.bass ? ` / ${esc(decoded.bass.name)}` : "") +
      esc(altStr) +
      warnLines(decoded.warnings);

    if (meta.cleared) {
      const tr = addRow(rawCol(decoded, source), decHtml, `chord → <span class="keytok">null</span> <span class="muted">(explicit clear)</span>`);
      clearBanner();
      queue(tr, { chordKey: null, chordInfo: null, externalBassPc: null }, source);
      return;
    }

    const exactHtml = chordInfo
      ? `<br>exact → <span class="keytok">${esc(chordInfo.id)}</span> <span class="muted">[${chordInfo.voicing.join(" ")}] → local bridge</span>`
      : "";

    if (meta.unrepresentable) {
      counters.unrepresentable++;
      updateCounters();
      if (chordInfo) {
        // The SN dataset can't say it, but the exact tones can: the room
        // stays deliberately frozen (loud), while the local bridge gets the
        // verbatim voicing (e.g. Power chords have no SN candidates).
        showBanner(`EXTERNAL HARMONY NOT SN-REPRESENTABLE — room holds last state; local bridge gets the exact voicing. ${meta.unrepresentable.reason}`);
        const tr = addRow(
          rawCol(decoded, source),
          decHtml,
          `<span class="err">no SN key — room deliberately frozen: ${esc(meta.unrepresentable.reason)}</span>${exactHtml}${lossLines(meta)}`
        );
        queue(tr, { chordInfo, externalBassPc: meta.externalBassPc ?? null }, source);
        return;
      }
      // Deliberate freeze: never let unsupported harmony pose as current
      // harmony, and never silently keep the old one either — the loss is
      // loud. Distinct from "no new message".
      showBanner(`EXTERNAL HARMONY NOT REPRESENTABLE — room holds last state. ${meta.unrepresentable.reason}`);
      addRow(rawCol(decoded, source), decHtml, `<span class="err">UNREPRESENTABLE — room deliberately frozen: ${esc(meta.unrepresentable.reason)}</span>`);
      return;
    }

    clearBanner();
    const fields = { chordKey, chordInfo, externalBassPc: meta.externalBassPc ?? null };
    const tr = addRow(
      rawCol(decoded, source),
      decHtml,
      `chord → <span class="keytok">${esc(chordKey)}</span>${meta.approximated ? ' <span class="loss">(approx)</span>' : ""}${exactHtml}${lossLines(meta)}`
    );
    queue(tr, fields, source);
  }
}

function queue(tr, fields, source) {
  const pushed = batcher.push(fields, source);
  if (!pushed) {
    tr.children[2].innerHTML += ` <span class="muted">— duplicate, suppressed</span>`;
  }
}

// ------------------------------------------------------------------- room
$("attachBtn").addEventListener("click", async () => {
  $("attachBtn").disabled = true;
  try {
    room = await attach();
    $("roomId").textContent = room.roomId;
    addRow(
      `<span class="muted">room</span>`,
      `<span class="muted">attached as anonymous uid ${esc(room.uid)}</span>`,
      `<span class="okw">✓ rooms/${esc(room.roomId)}</span>`
    );
  } catch (err) {
    $("roomId").textContent = "attach failed";
    addRow(`<span class="muted">room</span>`, `<span class="err">${esc(err.message)}</span>`, "");
    $("attachBtn").disabled = false;
  }
});
$("roomId").addEventListener("click", () => {
  if (room) navigator.clipboard?.writeText(room.roomId);
});

// --------------------------------------------------------------------- WS
function setWsStatus(ok, text) {
  $("wsDot").className = "dot " + (ok ? "ok" : "bad");
  $("wsStatus").textContent = text;
}

function wsConnect() {
  const url = $("wsUrl").value.trim();
  setWsStatus(false, "connecting…");
  try {
    ws = new WebSocket(url);
  } catch (err) {
    setWsStatus(false, "bad URL");
    return;
  }
  ws.onopen = () => setWsStatus(true, "connected");
  ws.onmessage = (ev) => {
    let words;
    try {
      const data = JSON.parse(ev.data);
      words = Array.isArray(data) ? data : data.ump;
    } catch {
      return;
    }
    if (Array.isArray(words)) handleUmp(words, "ws");
  };
  ws.onclose = () => {
    setWsStatus(false, wsWanted ? "disconnected — retrying in 2s" : "disconnected");
    ws = null;
    if (wsWanted) wsRetryTimer = setTimeout(wsConnect, 2000);
  };
  ws.onerror = () => {};
}

$("wsToggle").addEventListener("click", () => {
  if (wsWanted) {
    wsWanted = false;
    clearTimeout(wsRetryTimer);
    ws?.close();
    ws = null;
    setWsStatus(false, "disconnected");
    $("wsToggle").textContent = "Connect";
  } else {
    wsWanted = true;
    $("wsToggle").textContent = "Disconnect";
    wsConnect();
  }
});

// ----------------------------------------------------------------- inject
$("injectBtn").addEventListener("click", () => {
  const lines = $("inject").value.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    let words;
    try {
      words = JSON.parse(line);
    } catch {
      addRow(`<span class="hexw">${esc(line)}</span><br><span class="muted">inject</span>`, `<span class="err">not valid JSON</span>`, "");
      continue;
    }
    handleUmp(words, "inject");
  }
});

updateCounters();
setWsStatus(false, "disconnected");

// Exposed for Playwright-driven verification.
window.__flexAdapter = { handleUmp, mapper, getRoom: () => room };
