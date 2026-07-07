import { defineConfig } from 'vitest/config';

// Scoped, self-contained config for @maestro/plugin-sdk. The repo root config
// only globs src/**, so this package owns its own test run. root is pinned to
// this directory so the run works from either the package dir or the worktree
// root (with --config). Pure unit tests, no DOM and no shared setup file: the
// SDK is a dependency-free type facade.
export default defineConfig({
	root: import.meta.dirname,
	test: {
		globals: true,
		environment: 'node',
		include: ['src/**/*.{test,spec}.ts'],
		// Compile-time shape-parity guard (drift.test-d.ts): caught only when tsc
		// runs, so wire vitest typecheck with the test-only tsconfig that may reach
		// into the host sources. A normal `vitest run` then runs both.
		typecheck: {
			enabled: true,
			tsconfig: './tsconfig.test.json',
			include: ['src/**/*.test-d.ts'],
		},
	},
});
