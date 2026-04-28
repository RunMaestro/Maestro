/**
 * Playwright configuration for Maestro E2E testing
 *
 * Two projects:
 * - `electron` — launches the packaged Electron app via test fixtures
 * - `web` — drives the standalone web/mobile interface in Chromium against
 *   the Vite dev server (port 5174). Used for desktop↔web parity verification.
 */
import { defineConfig, devices } from '@playwright/test';
import path from 'path';

const WEB_DEV_PORT = 5174;

/**
 * See https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
	// Test directory
	testDir: './e2e',

	// Test file patterns
	testMatch: '**/*.spec.ts',

	// Run tests in files in parallel
	fullyParallel: false, // Electron tests should run sequentially to avoid conflicts

	// Fail the build on CI if you accidentally left test.only in the source code
	forbidOnly: !!process.env.CI,

	// Retry on CI only
	retries: process.env.CI ? 2 : 0,

	// Opt out of parallel tests for Electron
	workers: 1,

	// Reporter to use
	reporter: process.env.CI
		? [['github'], ['html', { open: 'never' }]]
		: [['list'], ['html', { open: 'on-failure' }]],

	// Shared settings for all the projects below
	use: {
		// Base URL to use in actions like `await page.goto('/')`
		// For Electron, this is handled differently - we use app.evaluate()

		// Collect trace when retrying the failed test
		trace: 'on-first-retry',

		// Capture screenshot on failure
		screenshot: 'only-on-failure',

		// Record video on failure
		video: 'on-first-retry',

		// Timeout for each action
		actionTimeout: 10000,
	},

	// Configure projects
	projects: [
		{
			name: 'electron',
			testDir: './e2e',
			testIgnore: '**/web/**',
			use: {
				// Electron-specific settings will be configured in test fixtures
			},
		},
		{
			// Drives the Vite dev server in Chromium with a mobile viewport.
			// We use Pixel 5 (Chromium) rather than iPhone 13 (WebKit) so this
			// project runs on the same browser already installed for other Playwright
			// flows; the dimensions are still phone-sized for parity verification.
			name: 'web',
			testDir: './e2e/web',
			use: {
				...devices['Pixel 5'],
				baseURL: `http://localhost:${WEB_DEV_PORT}`,
			},
		},
	],

	// Global test timeout
	timeout: 60000,

	// Expect timeout
	expect: {
		timeout: 10000,
	},

	// Output directory for test artifacts
	outputDir: 'e2e-results/',

	// Local servers Playwright spins up before tests run.
	// Electron tests build and launch the app inside their fixtures, so they
	// don't need a webServer entry. The web project drives the Vite dev server.
	webServer:
		process.env.PLAYWRIGHT_PROJECT === 'electron'
			? undefined
			: {
					command: `npm run dev:web`,
					url: `http://localhost:${WEB_DEV_PORT}`,
					timeout: 60_000,
					reuseExistingServer: !process.env.CI,
					stdout: 'ignore',
					stderr: 'pipe',
				},
});
