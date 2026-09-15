// room.js — room attachment. The ONLY module that touches room lifecycle or
// Firebase; ingestion (flexdata/compat/mapper/batcher) knows nothing about
// rooms. Conceptually the adapter is a PRODUCER that ATTACHES to a room —
// not the owner of a special room kind.
//
// MVP reality (documented constraint, not the architecture): Firestore
// rules require hostId == auth.uid for writes, so this anonymous identity
// can only write rooms it hosts. `attach()` therefore reuses/creates the
// saved private rehearsal room via the exact same path rehearse uses
// (ensureRehearsalRoom). Passing an explicit roomId attaches to that room
// instead — it will only be writable if this uid happens to host it.

import { ensureGuestAuth, ensureRehearsalRoom, updateEnsembleState, db } from "./firebase.js";

export async function attach(roomId = null) {
  const user = await ensureGuestAuth();

  if (!roomId) {
    ({ roomId } = await ensureRehearsalRoom(user));
  } else {
    const snap = await db.collection("rooms").doc(roomId).get();
    if (!snap.exists) throw new Error(`room "${roomId}" does not exist`);
    if (snap.data().hostId !== user.uid) {
      throw new Error(
        `room "${roomId}" is hosted by another identity — Firestore rules (hostId == auth.uid) ` +
          `will reject writes from this adapter (uid ${user.uid})`
      );
    }
  }

  let lastBassPc; // undefined = never written this session

  /**
   * write(patch): the SAME semantic write path rehearse uses.
   * patch: { bpm?, chordKey?, scaleKey?, externalBassPc? } where chordKey /
   * scaleKey may be explicit null (clear) and externalBassPc may be null.
   */
  async function write(patch) {
    const { externalBassPc, ...semantic } = patch;
    if ("bpm" in semantic || "chordKey" in semantic || "scaleKey" in semantic) {
      await updateEnsembleState({ roomId, ...semantic });
    }
    // externalBassPc: harmless EXTRA field on the room doc (receivers read a
    // fixed field list, verified — no receiver/model change). Written via a
    // separate tiny update because updateEnsembleState's contract is
    // deliberately left untouched (copied verbatim from rehearse).
    if (externalBassPc !== undefined && externalBassPc !== lastBassPc) {
      await db.collection("rooms").doc(roomId).update({ externalBassPc });
      lastBassPc = externalBassPc;
    }
  }

  return { roomId, uid: user.uid, write };
}
