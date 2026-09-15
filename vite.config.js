import { defineConfig } from "vite";

// Port 5173 ON PURPOSE (vite's default, same as lalork-rehearse's dev server):
// Firebase anonymous auth and the copied firebase.js's localStorage room id
// ("rehearse_room_id") are keyed by browser origin. Running this console on
// http://localhost:5173 means it shares the SAME anonymous uid and the SAME
// private rehearsal room as the rehearse app — which is what makes
// acceptance test A ("Rehearse drives the same room afterward") possible
// under the current Firestore rules (hostId == auth.uid). Run one at a time
// on 5173; if you deliberately want a separate identity/room, use --port.
export default defineConfig({
  server: { port: 5173, strictPort: false },
});
