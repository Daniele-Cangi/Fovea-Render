import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  server: { port: 5174 },
  resolve: {
    alias: {
      "@fovea-render/gaze-mediapipe": resolve(__dirname, "../../packages/gaze-mediapipe/src/index.ts")
    }
  }
});

