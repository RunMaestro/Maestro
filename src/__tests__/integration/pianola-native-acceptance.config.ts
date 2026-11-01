import { defineConfig } from 'vitest/config';

// This config collects only the isolated Pianola candidate harness. It excludes
// provider integration tests and the renderer's global jsdom setup.
export default defineConfig({
	test: {
		include: ['src/__tests__/integration/pianola-native-acceptance.integration.test.ts'],
		environment: 'node',
		pool: 'forks',
		maxWorkers: 1,
		minWorkers: 1,
		fileParallelism: false,
		testTimeout: 10_000,
		hookTimeout: 10_000,
		bail: 0,
	},
});
