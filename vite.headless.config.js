// Builds the headless pipeline (src/headless.js) as a single IIFE for
// inlining into ug-flex-player.html (see PDF2PDF repo's build_adapter.py).
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: "src/headless.js",
      name: "FlexDataHeadless",
      formats: ["iife"],
      fileName: () => "flexdata-headless.js",
    },
    outDir: "dist-headless",
    minify: false, // stays reviewable inside the player's single file
  },
});
