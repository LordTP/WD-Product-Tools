import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // Only our source tests — never the traced copies in the build output.
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules", ".next", "dist"],
  },
});
