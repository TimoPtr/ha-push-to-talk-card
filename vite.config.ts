import { defineConfig } from "vitest/config";
import { waitEndpoint } from "./dev/wait-plugin";

export default defineConfig({
  plugins: [waitEndpoint()],
  build: {
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: () => "ha-push-to-talk-card.js",
    },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
    restoreMocks: true,
  },
});
