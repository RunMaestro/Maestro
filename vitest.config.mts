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
//
// If a backend .ts test fails under the node project with something like
// "ReferenceError: document/window is not defined", it needs a DOM: add its
// path here (or move the DOM dependency behind a mock). Everything matched
// here runs under jsdom and nowhere else - the node project excludes this list.
const jsdomOnlyTs = [
	'src/__tests__/renderer/**/*.{test,spec}.ts',
	'src/__tests__/web/**/*.{test,spec}.ts',
	'src/renderer/**/*.{test,spec}.ts',
	'src/__tests__/main/stats/integration.test.ts',
	// The web-desktop electron shim constructs a BridgeClient and reads
	// `window`/`document` at module load, so its suites need a DOM.
	'src/__tests__/web-desktop/**/*.{test,spec}.ts',
	// The agent-flow overlay panel is a standalone HTML document evaluated into
	// jsdom by its test (the plugin's sandbox test next to it stays on node).
	'src/__tests__/plugins/agent-flow-panel.test.ts',
];

// Variables that tell git WHERE the repository is. Git exports them to hooks and
// to `rebase --exec`, so a suite launched from either inherits them, and a test
// that runs `git init` / `git commit` in a temp directory then operates on the
// host repository instead (see the note in .husky/pre-push for what that cost).
// Dropped here, in the main process before any worker is forked, so no launch
// path can hand them to a test. Mirrors `git rev-parse --local-env-vars`.
const GIT_REPOSITORY_ENV_VARS = [
	'GIT_DIR',
	'GIT_WORK_TREE',
	'GIT_INDEX_FILE',
	'GIT_COMMON_DIR',
	'GIT_OBJECT_DIRECTORY',
	'GIT_ALTERNATE_OBJECT_DIRECTORIES',
	'GIT_NAMESPACE',
	'GIT_PREFIX',
	'GIT_CONFIG',
	'GIT_CONFIG_PARAMETERS',
	'GIT_CONFIG_COUNT',
	'GIT_GRAFT_FILE',
	'GIT_SHALLOW_FILE',
	'GIT_IMPLICIT_WORK_TREE',
	'GIT_REPLACE_REF_BASE',
	'GIT_NO_REPLACE_OBJECTS',
	'GIT_INTERNAL_SUPER_PREFIX',
];
for (const name of GIT_REPOSITORY_ENV_VARS) {
	delete process.env[name];
}

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
					setupFiles: ['./src/__tests__/setup.ts'],
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
