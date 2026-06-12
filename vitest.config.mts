import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	plugins: [react() as any],
	test: {
		globals: true,
		environment: 'jsdom',
		pool: 'forks',
		maxWorkers: 4,
		setupFiles: ['./src/__tests__/setup.ts'],
		include: ['src/**/*.{test,spec}.{ts,tsx}'],
		exclude: [
			'node_modules',
			'dist',
			'release',
			'src/__tests__/integration/**',
			'src/__tests__/e2e/**',
			'src/__tests__/performance/**',
		],
		testTimeout: 10000,
		hookTimeout: 10000,
		teardownTimeout: 5000,
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
