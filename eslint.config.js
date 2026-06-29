// Flat ESLint config.
//
// Goal: catch *real* bugs, not style. Formatting is deferred to a dedicated
// tool, so this config enables no stylistic/layout rules — the `@eslint/js` and
// `typescript-eslint` "recommended" presets are logic-only (ESLint moved all
// formatting rules out to `@stylistic`, which we don't add).
//
// The base presets run *without* type information (fast, and `pnpm run
// typecheck` already does whole-program type analysis). One rule is the
// exception: `local/no-floating-cleanup` is type-aware, so a second config
// block scoped to our source turns on the typescript-eslint project service
// just for it.

import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'
import noFloatingCleanup from './eslint-rules/no-floating-cleanup.js'

export default tseslint.config(
  {
    // Generated types and vendored output are never linted.
    ignores: [
      'node_modules/**',
      'assets/**',
      'img/**',
      '.claude/**', // editor state + nested git worktrees, not this project's source
      'eslint-rules/**', // vendored upstream rule, kept verbatim
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts', '**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // TypeScript already resolves identifiers; `no-undef` only produces
      // false positives on type-only globals here.
      'no-undef': 'off',

      // A documented `// @ts-nocheck` is allowed (e.g. verbatim ported data
      // tables with intentional duplicate keys); ts-ignore/expect-error still
      // require a description.
      '@typescript-eslint/ban-ts-comment': ['error', {
        'ts-nocheck': 'allow-with-description',
        'ts-ignore': 'allow-with-description',
        'ts-expect-error': 'allow-with-description',
      }],

      // Irregular whitespace in code is a real bug; in comments it's sometimes
      // deliberate (e.g. a zero-width space breaking up `*/` inside a glob doc).
      'no-irregular-whitespace': ['error', { skipComments: true }],

      // Only nudge to `const` when *every* binding in a declaration can be —
      // mixed destructuring like `let {start, end}` where one half is
      // reassigned can't, and isn't worth splitting.
      'prefer-const': ['error', { destructuring: 'all' }],

      // node-gtk's bindings are pervasively typed `any` (GObject, GIR, vfunc
      // signatures). Flagging it is pure noise, not a real-issue signal.
      '@typescript-eslint/no-explicit-any': 'off',

      // Catch genuinely-dead bindings, but allow intentional `_`-prefixed
      // placeholders — common in GObject vfunc/signal signatures where the
      // arg position matters but the value is unused.
      '@typescript-eslint/no-unused-vars': ['warn', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
    },
  },

  // Type-aware block — only our source is in the TS program, and only here do
  // we pay for type information. Hosts `local/no-floating-cleanup`: discarding a
  // returned cleanup/unsubscribe function leaks a subscription (especially the
  // `eventKit` Disposables this codebase leans on). Opt out per call with
  // `void expr`, same convention as `@typescript-eslint/no-floating-promises`.
  {
    files: ['src/**/*.ts', 'plugins/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      local: { rules: { 'no-floating-cleanup': noFloatingCleanup } },
    },
    rules: {
      'local/no-floating-cleanup': 'error',
    },
  },
)
