// The renderer has no type checking and esbuild treats a bare identifier as a
// global, so an unimported JSX component builds green and crashes at render
// with a ReferenceError (a <Pencil> without its lucide-react import did
// exactly that). This config exists to catch that class of bug — undefined
// identifiers — not to enforce style.
//
// Core no-undef never sees JSX names (eslint-scope doesn't count
// JSXIdentifier as a reference), which is why eslint-plugin-react is here:
// jsx-no-undef flags the unimported component, jsx-uses-vars stops
// no-unused-vars from flagging imports that are only used as JSX.
import js from "@eslint/js";
import react from "eslint-plugin-react";
import globals from "globals";

export default [
  {
    files: ["renderer/src/**/*.{js,jsx}"],
    plugins: { react },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    settings: { react: { version: "detect" } },
    rules: {
      ...js.configs.recommended.rules,
      "react/jsx-no-undef": "error",
      "react/jsx-uses-vars": "error",
      // Dead code, not broken code — not worth failing the build over. The
      // shadcn-scaffolded ui/ files import React out of classic-runtime
      // habit; the automatic runtime makes that unused, and editing
      // generated files to appease a linter isn't worth the diff.
      "no-unused-vars": [
        "warn",
        { args: "none", caughtErrors: "none", varsIgnorePattern: "^React$" },
      ],
      "no-empty": ["warn", { allowEmptyCatch: true }],
    },
  },
];
