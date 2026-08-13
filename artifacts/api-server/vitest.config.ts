import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json"],
      include: ["src/**/*.ts"],
    },
  },
  resolve: {
    // Mirror the tsconfig bundler module resolution
    conditions: ["workspace", "import", "module", "default"],
  },
});
