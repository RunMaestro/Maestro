/**
 * @file vitest.integration.config.ts
 * @description Vitest configuration for integration tests.
 *
 * Integration tests require real agents and exercise the full flow.
 * These tests are meant to be run manually or in dedicated CI jobs.
 *
 * Run with: npm run test:integration
 */

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    include: [
      'src/__tests__/integration/**/*.integration.test.ts',
      'src/__tests__/integration/**/provider-integration.test.ts',
      'src/__tests__/integration/**/*.test.tsx', // Include React component integration tests
    ],
    environment: 'jsdom', // Required for React component tests
    setupFiles: ['./src/__tests__/setup.ts'],
    testTimeout: 180000, // 3 minutes per test
    hookTimeout: 60000, // 1 minute for setup/teardown
    pool: 'forks', // Use forks instead of threads for process isolation
    poolOptions: {
      forks: {
        singleFork: true, // Run tests sequentially to avoid agent conflicts
      },
    },
    bail: 1, // Stop on first failure
    globals: true,
    reporters: ['verbose'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
