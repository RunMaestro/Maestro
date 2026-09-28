// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';
import maestroPlugin from './eslint-rules/no-em-dash-in-comments.mjs';
import fontSizesPlugin from './eslint-rules/no-arbitrary-font-sizes.mjs';

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
			'src/renderer/public/**', // Static browser scripts (splash, devtools)
			'.cue-migration-backup-*/**', // Git-ignored migration backup snapshots
		],
	},

	// Base ESLint recommended rules
	eslint.configs.recommended,

	// TypeScript ESLint recommended rules
	...tseslint.configs.recommended,

	{
		languageOptions: {
			parserOptions: {
				// Pin this repo. Sibling git worktrees otherwise look like extra
				// TSConfig roots and the parser refuses to guess.
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},

	// Prettier config - disables ESLint rules that conflict with Prettier
	prettierConfig,

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
			maestro: maestroPlugin,
			'font-sizes': fontSizesPlugin,
		},
		rules: {
			// TypeScript-specific rules
			'@typescript-eslint/no-unused-vars': [
				'warn',
				{
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_',
				},
			],
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
			// NOTE: exhaustive-deps is intentionally 'off' - this codebase uses refs and
			// stable state setters intentionally without listing them as dependencies.
			// The pattern is to use refs to access latest values without causing re-renders.
			'react-hooks/exhaustive-deps': 'off',

			// General rules
			'no-console': 'off', // Console is used throughout
			'no-undef': 'off', // TypeScript handles this
			'no-control-regex': 'off', // Intentionally used for terminal escape sequences
			'no-useless-escape': 'off', // Sometimes needed for clarity in regexes
			'prefer-const': 'warn',
			'no-var': 'error',

			// House style, and a merge-conflict guard: em/en-dashes in comments are
			// what made 603 files differ between main and rc while being otherwise
			// identical. Autofixable via `eslint --fix`. See the rule for why this
			// covers comments only and not string literals.
			'maestro/no-em-dash-in-comments': 'error',

			// Font-size sweep: prevent regression of hard-pixel font classes that freeze
			// when users change root font-size. Named classes (text-3xs, text-2xs,
			// text-xs-plus, text-xs) and .row-hover are the correct replacements.
			'font-sizes/no-arbitrary-font-sizes': 'error',
		},
		settings: {
			react: {
				version: 'detect',
			},
		},
	}
);
