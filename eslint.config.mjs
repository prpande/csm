// Type-aware ESLint for the CSM Electron shell. Bounded ruleset: js/ts
// `recommended` (syntactic) plus the two TYPE-AWARE promise rules
// (no-floating-promises / no-misused-promises) on the async IPC + app-lifecycle
// code, where a floating promise is a real bug class — NOT the full
// `recommendedTypeChecked` preset.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "dist-test/**",
      "node_modules/**",
      "public/**",
      "eslint.config.mjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.eslint.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // TS reports undefined identifiers; no-undef double-reports Node/Electron
      // globals and is off per typescript-eslint guidance for typed code.
      "no-undef": "off",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    // node:test registers tests by CALLING test(), returning promises the runner
    // owns and you never await; async test callbacks are likewise the runner's
    // contract. Both typed promise rules fire on correct test idiom, not bugs —
    // relax for test files only. Must be LAST so it overrides the src rules.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises": "off",
    },
  },
);
