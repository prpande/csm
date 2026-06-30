// Type-aware ESLint for CSM. Two domains: the Node/Electron main+preload
// (src/*.ts) and the React renderer (src/renderer/**). Bounded ruleset: js/ts
// `recommended` plus the two type-aware promise rules everywhere, and react-hooks
// (at error) + react-refresh for the renderer.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "dist-test/**",
      "node_modules/**",
      "eslint.config.mjs",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Type-aware project spanning every linted TS/TSX file.
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.eslint.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // TS reports undefined identifiers; no-undef double-reports globals and is
      // off per typescript-eslint guidance for typed code.
      "no-undef": "off",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  // React in a browser context — renderer source + renderer tests. react-hooks
  // applies to both (hooks can appear in test render helpers).
  {
    files: ["src/renderer/**/*.{ts,tsx}", "test/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  // react-refresh enforces Fast Refresh constraints — relevant only to renderer
  // SOURCE modules, not tests (which legitimately export helpers/multiple values).
  {
    files: ["src/renderer/**/*.{ts,tsx}"],
    plugins: { "react-refresh": reactRefresh },
    rules: {
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },
  // Test + e2e override — MUST be last so it wins. vitest/node:test register tests
  // by calling functions whose promises the runner owns; the typed promise rules
  // fire on correct test idiom, not bugs.
  {
    files: ["test/**/*.{ts,tsx}", "e2e/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises": "off",
    },
  },
);
