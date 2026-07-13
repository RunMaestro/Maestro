import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		setupFiles: ['../../src/__tests__/setup.ts'],
		include: ['src/__tests__/**/*.test.ts', 'src/__tests__/**/*.test.tsx'],
		environment: 'jsdom',
	},
});
