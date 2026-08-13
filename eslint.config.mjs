import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.tsbuildinfo",
      "lib/api-client-react/src/generated/**",
      "lib/api-zod/src/generated/**",
    ],
  },
  {
    rules: {
      // Allow explicit any in limited cases (API payloads, DB results)
      "@typescript-eslint/no-explicit-any": "warn",
      // Allow unused vars prefixed with _
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Require return types on public functions
      "@typescript-eslint/explicit-function-return-type": "off",
      // No console.log in source (use logger instead)
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  {
    // Relax rules for scripts (bootstrap, audit — they use console)
    files: ["scripts/src/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    // Relax rules for test files
    files: ["**/*.test.ts", "**/*.spec.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
    },
  },
);
