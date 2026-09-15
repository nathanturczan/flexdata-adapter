// batcher.js — generic, observable coalescing layer.
//
// Collects mapper outputs and commits ONE merged patch per window (default
// 50 ms). Knows nothing about MIDI, rooms, or Firebase: it receives plain
// field patches and calls `commit(patch, entries)` when the window closes.
//
// Observability contract: every accepted field is logged with its arrival
// offset inside the window, and the commit log names everything that went
// out together — so timing weirdness is attributable to MIDI vs Athan vs
// Firestore vs adapter. Identical consecutive values are suppressed and
// logged as such.

export function createBatcher({ commit, windowMs = 50, onLog = () => {}, now = () => Date.now() } = {}) {
  let pending = null; // { patch, entries, windowStart, timer }
  let lastCommitted = {}; // field → last value committed (duplicate suppression)
  let timerFn = null;

  function flush() {
    if (!pending) return;
    const { patch, entries, windowStart } = pending;
    pending = null;
    const t = now();
    onLog({
      type: "commit",
      t,
      windowStart,
      fields: Object.keys(patch),
      msg: `committed together at t0+${t - windowStart}ms: ${Object.keys(patch).join(", ")}`,
    });
    for (const [field, value] of Object.entries(patch)) lastCommitted[field] = JSON.stringify(value);
    commit(patch, entries);
  }

  function push(fields, source) {
    const t = now();
    const accepted = {};
    for (const [field, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      const ser = JSON.stringify(value);
      if (lastCommitted[field] === ser && (!pending || !(field in pending.patch))) {
        onLog({ type: "duplicate", t, field, value, msg: `duplicate ${field}=${ser}, suppressed` });
        continue;
      }
      accepted[field] = value;
    }
    if (!Object.keys(accepted).length) return false;

    if (!pending) {
      pending = { patch: {}, entries: [], windowStart: t, timer: null };
      pending.timer = (timerFn || setTimeout)(flush, windowMs);
      onLog({ type: "window-open", t, msg: `batch window opened (${windowMs}ms)` });
    }
    const offset = t - pending.windowStart;
    Object.assign(pending.patch, accepted);
    pending.entries.push({ t, offset, fields: accepted, source });
    onLog({
      type: "received",
      t,
      offset,
      fields: Object.keys(accepted),
      msg: `received ${Object.keys(accepted).join(", ")} at t0+${offset}ms`,
    });
    return true;
  }

  return {
    push,
    flushNow: flush,
    setWindowMs(ms) {
      windowMs = ms;
    },
    // Test hook: replace the timer scheduler (e.g. manual flushing).
    _setTimerFn(fn) {
      timerFn = fn;
    },
    resetDuplicateSuppression() {
      lastCommitted = {};
    },
  };
}
