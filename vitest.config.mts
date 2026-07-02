import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

// Directories excluded from the default unit-test run (have their own configs).
const sharedExclude = [
	'node_modules',
	'dist',
	'release',
	'src/__tests__/integration/**',
	'src/__tests__/e2e/**',
	'src/__tests__/performance/**',
];

// Test files that live under an otherwise node-only path but still require a DOM
// (renderer/web UI, plus a handful that pull in a browser global transitively).
// These stay on the jsdom project; everything else backend runs on the much
// faster `node` environment (no jsdom setup cost).
const jsdomOnlyTs = [
	'src/__tests__/renderer/**/*.{test,spec}.ts',
	'src/__tests__/web/**/*.{test,spec}.ts',
	'src/renderer/**/*.{test,spec}.ts',
	'src/__tests__/main/stats/integration.test.ts',
];

export default defineConfig({
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	plugins: [react() as any],
	test: {
		globals: true,
		// forks (not threads): suites mutate process.platform / process.env (shared
		// under threads), and native addons loaded from multiple worker threads in
		// one process can segfault the whole run.
		pool: 'forks',
		maxWorkers: 4,
		setupFiles: ['./src/__tests__/setup.ts'],
		testTimeout: 10000,
		hookTimeout: 10000,
		teardownTimeout: 5000,
		// Split into two projects so the ~360 backend suites skip the expensive
		// jsdom environment and run under plain node (dramatically faster); only
		// DOM-dependent suites pay for jsdom.
		projects: [
			{
				extends: true,
				test: {
					name: 'jsdom',
					environment: 'jsdom',
					// NOTE: stays on the forks pool. threads is ~19% faster here but
					// intermittently SEGFAULTS the run (native addons loaded from
					// multiple worker threads in one process are not context-aware).
					include: ['src/**/*.{test,spec}.tsx', ...jsdomOnlyTs],
					exclude: sharedExclude,
				},
			},
			{
				extends: true,
				test: {
					name: 'node',
					environment: 'node',
					// include matches .ts only, so .tsx files can never land here.
					include: ['src/**/*.{test,spec}.ts'],
					exclude: [...sharedExclude, ...jsdomOnlyTs],
				},
			},
		],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'text-summary', 'json', 'html'],
			reportsDirectory: './coverage',
			include: ['src/**/*.{ts,tsx}'],
			exclude: [
				'node_modules',
				'dist',
				'src/__tests__/**',
				'**/*.d.ts',
				'src/main/preload.ts', // Electron preload script
			],
		},
	},
	resolve: {
		alias: {
			'@': path.resolve(__dirname, './src'),
		},
	},
});
