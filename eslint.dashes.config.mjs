// @ts-check
//
// A second, deliberately tiny ESLint pass that runs ONLY the em/en-dash rule,
// over the directories the main config puts in its global `ignores` block:
// `src/__tests__/**` and `scripts/**`.
//
// Why a separate config rather than widening eslint.config.mjs: a flat-config
// object whose only key is `ignores` is a GLOBAL ignore, and no later config
// entry can re-enable a path it excludes. Un-ignoring the tests would therefore
// mean scoping every recommended rule set away from them by hand, which changes
// lint semantics for thousands of files to gain one rule. This keeps the main
// config untouched.
//
// Worth guarding: when the dash cleanup measured the drift between `main` and
// `rc`, 250 of the 634 files that differed by dash characters alone lived under
// `src/__tests__/`. Tests are roughly 40% of the surface the rule exists to
// protect, and they were the part nothing was watching.
//
// Chained after the main pass in the `lint:eslint` npm script, which CI runs.

import tseslint from 'typescript-eslint';
import maestroPlugin from './eslint-rules/no-em-dash-in-comments.mjs';

export default tseslint.config({
	// `scripts/` is mostly .mjs but holds a .js too (notarize.js), so match every
	// JS flavour ESLint can parse. The .ps1 / .sh helpers in there are out of
	// reach for any ESLint rule.
	files: [
		'src/__tests__/**/*.ts',
		'src/__tests__/**/*.tsx',
		'scripts/**/*.mjs',
		'scripts/**/*.js',
		'scripts/**/*.cjs',
	],
	languageOptions: {
		parser: tseslint.parser,
		ecmaVersion: 2022,
		sourceType: 'module',
		parserOptions: {
			ecmaFeatures: { jsx: true },
			// Pin this repo. Sibling git worktrees otherwise look like extra
			// TSConfig roots and the parser refuses to guess.
			tsconfigRootDir: import.meta.dirname,
		},
	},
	// The typescript-eslint plugin is registered but none of its rules are
	// enabled. Test files carry inline `eslint-disable-next-line
	// @typescript-eslint/...` comments, and a directive naming a rule ESLint
	// cannot resolve is itself an error ("Definition for rule ... was not
	// found"). Registering the plugin makes those names resolve to a no-op
	// instead, so this pass reports dashes and nothing else.
	plugins: { maestro: maestroPlugin, '@typescript-eslint': tseslint.plugin },
	linterOptions: {
		// Every disable directive in these files targets a rule this pass leaves
		// off, so all of them would otherwise be reported as unused.
		reportUnusedDisableDirectives: 'off',
	},
	// Only this rule. Everything else about these files is intentionally
	// unlinted, exactly as before.
	rules: { 'maestro/no-em-dash-in-comments': 'error' },
});
