// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  // Ignore patterns
  {
    ignores: [
      'dist/**',
      'release/**',
      'node_modules/**',
      '*.config.js',
      '*.config.mjs',
      '*.config.ts',
      'scripts/**',
      'src/__tests__/**',
      'src/web/utils/serviceWorker.ts', // Service worker has special globals
      'src/web/public/**', // Service worker and static assets
    ],
  },

  // Base ESLint recommended rules
  eslint.configs.recommended,

  // TypeScript ESLint recommended rules
  ...tseslint.configs.recommended,

  // Main configuration for all TypeScript files
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2020,
      },
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
    },
    rules: {
      // TypeScript-specific rules
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      // TODO: Change to 'warn' after reducing ~304 existing uses
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-require-imports': 'off', // Used in main process

      // React rules
      'react/jsx-uses-react': 'error',
      'react/jsx-uses-vars': 'error',
      'react/prop-types': 'off', // Using TypeScript for prop types
      'react/react-in-jsx-scope': 'off', // Not needed with new JSX transform

      // React Hooks rules
      'react-hooks/rules-of-hooks': 'error',
      // TODO: Change to 'error' after fixing ~74 existing violations
      'react-hooks/exhaustive-deps': 'warn',

      // General rules
      'no-console': 'off', // Console is used throughout
      'no-undef': 'off', // TypeScript handles this
      'no-control-regex': 'off', // Intentionally used for terminal escape sequences
      'no-useless-escape': 'off', // Sometimes needed for clarity in regexes
      'prefer-const': 'warn',
      'no-var': 'error',
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
  },
);
