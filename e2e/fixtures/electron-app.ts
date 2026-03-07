/**
 * Electron Application Fixture for E2E Testing
 *
 * This fixture handles launching and managing the Electron application
 * for Playwright E2E tests. It provides utilities for interacting with
 * the app's main window and IPC communication.
 */
import {
	test as base,
	_electron as electron,
	type ElectronApplication,
	type Page,
} from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Interface for our extended test fixtures
interface ElectronTestFixtures {
	electronApp: ElectronApplication;
	window: Page;
	appPath: string;
	testDataDir: string;
}

/**
 * Get the path to the main entry point
 */
function getMainPath(): string {
	return path.join(__dirname, '../../dist/main/index.js');
}

/**
 * Create a unique test data directory for isolation
 */
function createTestDataDir(): string {
	const testDir = path.join(
		os.tmpdir(),
		`maestro-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
	fs.mkdirSync(testDir, { recursive: true });
	return testDir;
}

/**
 * Extended test with Electron fixtures
 *
 * Usage:
 * ```typescript
 * import { test, expect } from './fixtures/electron-app';
 *
 * test('should launch the app', async ({ electronApp, window }) => {
 *   await expect(window.locator('h1')).toBeVisible();
 * });
 * ```
 */
export const test = base.extend<ElectronTestFixtures>({
	// Test data directory for isolation
	// eslint-disable-next-line no-empty-pattern
	testDataDir: async ({}, use) => {
		const dir = createTestDataDir();
		await use(dir);
		// Cleanup after test
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	},

	// Path to the main entry point
	// eslint-disable-next-line no-empty-pattern
	appPath: async ({}, use) => {
		const mainPath = getMainPath();

		// Check if the app is built
		if (!fs.existsSync(mainPath)) {
			throw new Error(
				`Electron main process not built. Run 'npm run build:main && npm run build:renderer' first.\n` +
					`Expected path: ${mainPath}`
			);
		}

		await use(mainPath);
	},

	// Launch Electron application
	electronApp: async ({ appPath, testDataDir }, use) => {
		// Launch the Electron app
		const app = await electron.launch({
			args: [appPath],
			env: {
				...process.env,
				// Use isolated data directory for tests
				MAESTRO_DATA_DIR: testDataDir,
				// Disable hardware acceleration for CI
				ELECTRON_DISABLE_GPU: '1',
				// Set NODE_ENV to test
				NODE_ENV: 'test',
				// Ensure we're in a testing context
				MAESTRO_E2E_TEST: 'true',
			},
			// Increase timeout for slow CI environments
			timeout: 30000,
		});

		await use(app);

		// Close the application after test
		await app.close();
	},

	// Get the main window
	window: async ({ electronApp }, use) => {
		// Wait for the first window to be available
		const window = await electronApp.firstWindow();

		// Wait for the app to be ready (DOM loaded)
		await window.waitForLoadState('domcontentloaded');

		// Give the app a moment to initialize React
		await window.waitForTimeout(500);

		await use(window);
	},
});

export { expect } from '@playwright/test';

/**
 * Helper utilities for E2E tests
 */
export const helpers = {
	/**
	 * Wait for the wizard to be visible
	 */
	async waitForWizard(window: Page): Promise<void> {
		// The wizard modal should have a specific structure
		// Looking for the wizard container or title
		await window.waitForSelector('text=Create a Maestro Agent', { timeout: 10000 });
	},

	/**
	 * Open the wizard via keyboard shortcut
	 */
	async openWizardViaShortcut(window: Page): Promise<void> {
		// Cmd+Shift+N opens the wizard
		await window.keyboard.press('Meta+Shift+N');
		await helpers.waitForWizard(window);
	},

	/**
	 * Select an agent in the wizard
	 */
	async selectAgent(window: Page, agentName: string): Promise<void> {
		// Find and click the agent tile
		const agentTile = window.locator(`text=${agentName}`).first();
		await agentTile.click();
	},

	/**
	 * Enter a project name in the wizard
	 */
	async enterProjectName(window: Page, name: string): Promise<void> {
		// Find the Name input field
		const nameInput = window
			.locator('input[placeholder*="Project"]')
			.or(window.locator('input[placeholder*="Name"]'));
		await nameInput.fill(name);
	},

	/**
	 * Click the Next button in the wizard
	 */
	async clickNext(window: Page): Promise<void> {
		const nextButton = window
			.locator('button:has-text("Next")')
			.or(window.locator('button:has-text("Continue")'));
		await nextButton.click();
	},

	/**
	 * Click the Back button in the wizard
	 */
	async clickBack(window: Page): Promise<void> {
		const backButton = window.locator('button:has-text("Back")');
		await backButton.click();
	},

	/**
	 * Select a directory in the wizard
	 * Note: This requires mocking the native dialog or using a pre-configured directory
	 */
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	async selectDirectory(_window: Page, _dirPath: string): Promise<void> {
		// The directory selection involves a native dialog
		// For E2E tests, we might need to:
		// 1. Mock the dialog result via IPC
		// 2. Use a pre-selected directory
		// 3. Set up the directory state before the test

		// For now, we'll look for the directory input and interact with it
		// This may need to be adjusted based on actual implementation
		throw new Error(
			'Directory selection requires dialog mocking - implement based on app specifics'
		);
	},

	/**
	 * Wait for the wizard to close
	 */
	async waitForWizardClose(window: Page): Promise<void> {
		// Wait for the wizard title to disappear
		await window.waitForSelector('text=Create a Maestro Agent', {
			state: 'hidden',
			timeout: 10000,
		});
	},

	/**
	 * Check if the app is showing the main UI
	 */
	async waitForMainUI(window: Page): Promise<void> {
		// Wait for key elements of the main UI to be visible
		// Adjust these selectors based on actual UI structure
		await window.waitForSelector('[data-tour]', { timeout: 10000 }).catch(() => {
			// data-tour attributes might not exist, try another approach
		});
	},

	/**
	 * Create a temporary test directory structure
	 */
	createTestDirectory(basePath: string, structure: Record<string, string | null>): void {
		for (const [relativePath, content] of Object.entries(structure)) {
			const fullPath = path.join(basePath, relativePath);
			const dir = path.dirname(fullPath);

			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}

			if (content !== null) {
				fs.writeFileSync(fullPath, content, 'utf-8');
			}
		}
	},

	/**
	 * Clean up test directory
	 */
	cleanupTestDirectory(dirPath: string): void {
		try {
			fs.rmSync(dirPath, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	},

	// ============================================
	// Auto Run Helpers
	// ============================================

	/**
	 * Navigate to the Auto Run tab in the right panel
	 */
	async navigateToAutoRunTab(window: Page): Promise<boolean> {
		const autoRunTab = window.locator('text=Auto Run');
		if ((await autoRunTab.count()) > 0) {
			await autoRunTab.first().click();
			return true;
		}
		return false;
	},

	/**
	 * Switch Auto Run to edit mode
	 */
	async switchToEditMode(window: Page): Promise<boolean> {
		const editButton = window.locator('button').filter({ hasText: 'Edit' });
		if ((await editButton.count()) > 0 && (await editButton.isVisible())) {
			await editButton.first().click();
			return true;
		}
		return false;
	},

	/**
	 * Switch Auto Run to preview mode
	 */
	async switchToPreviewMode(window: Page): Promise<boolean> {
		const previewButton = window.locator('button').filter({ hasText: 'Preview' });
		if ((await previewButton.count()) > 0 && (await previewButton.isVisible())) {
			await previewButton.first().click();
			return true;
		}
		return false;
	},

	/**
	 * Get the Auto Run textarea element
	 */
	getAutoRunTextarea(window: Page) {
		return window.locator('textarea');
	},

	/**
	 * Type content into the Auto Run editor
	 */
	async typeInAutoRunEditor(window: Page, content: string): Promise<boolean> {
		const textarea = window.locator('textarea');
		if ((await textarea.count()) > 0) {
			await textarea.fill(content);
			return true;
		}
		return false;
	},

	/**
	 * Get current content from Auto Run editor
	 */
	async getAutoRunContent(window: Page): Promise<string | null> {
		const textarea = window.locator('textarea');
		if ((await textarea.count()) > 0) {
			return await textarea.inputValue();
		}
		return null;
	},

	/**
	 * Open the Auto Run expanded modal
	 */
	async openExpandedModal(window: Page): Promise<boolean> {
		const expandButton = window
			.locator('button[title*="Expand"]')
			.or(window.locator('button[title*="full screen"]'));
		if ((await expandButton.count()) > 0) {
			await expandButton.first().click();
			return true;
		}
		return false;
	},

	/**
	 * Check if Auto Run is in edit mode
	 */
	async isInEditMode(window: Page): Promise<boolean> {
		const textarea = window.locator('textarea');
		return (await textarea.count()) > 0 && (await textarea.isVisible());
	},

	/**
	 * Open search in Auto Run
	 */
	async openAutoRunSearch(window: Page): Promise<void> {
		await window.keyboard.press('Meta+F');
	},

	/**
	 * Create an Auto Run test folder with sample documents
	 */
	createAutoRunTestFolder(basePath: string): string {
		const autoRunFolder = path.join(basePath, '.maestro/playbooks');
		fs.mkdirSync(autoRunFolder, { recursive: true });

		// Create sample documents
		fs.writeFileSync(
			path.join(autoRunFolder, 'Phase 1.md'),
			`# Phase 1: Setup

## Tasks

- [ ] Task 1: Initialize project
- [ ] Task 2: Configure environment
- [x] Task 3: Review documentation

## Notes

Sample content for testing Auto Run editing.
`
		);

		fs.writeFileSync(
			path.join(autoRunFolder, 'Phase 2.md'),
			`# Phase 2: Implementation

## Tasks

- [ ] Build feature A
- [ ] Build feature B
- [ ] Write tests

## Details

More content for the second phase.
`
		);

		return autoRunFolder;
	},

	// ============================================
	// Batch Processing Helpers
	// ============================================

	/**
	 * Get the Run button for batch processing
	 */
	getRunButton(window: Page) {
		return window.locator('button').filter({ hasText: /^run$/i });
	},

	/**
	 * Get the Stop button for batch processing
	 */
	getStopButton(window: Page) {
		return window.locator('button').filter({ hasText: /stop/i });
	},

	/**
	 * Click the Run button to open batch runner modal
	 */
	async clickRunButton(window: Page): Promise<boolean> {
		const runButton = window.locator('button').filter({ hasText: /^run$/i });
		if ((await runButton.count()) > 0 && (await runButton.first().isEnabled())) {
			await runButton.first().click();
			return true;
		}
		return false;
	},

	/**
	 * Click the Stop button to halt batch processing
	 */
	async clickStopButton(window: Page): Promise<boolean> {
		const stopButton = window.locator('button').filter({ hasText: /stop/i });
		if ((await stopButton.count()) > 0 && (await stopButton.first().isEnabled())) {
			await stopButton.first().click();
			return true;
		}
		return false;
	},

	/**
	 * Wait for batch runner modal to be visible
	 */
	async waitForBatchRunnerModal(window: Page): Promise<void> {
		await window.waitForSelector('text=Auto Run Configuration', { timeout: 5000 });
	},

	/**
	 * Click the Go button in batch runner modal to start processing
	 */
	async clickGoButton(window: Page): Promise<boolean> {
		const goButton = window.locator('button').filter({ hasText: 'Go' });
		if ((await goButton.count()) > 0 && (await goButton.first().isEnabled())) {
			await goButton.first().click();
			return true;
		}
		return false;
	},

	/**
	 * Check if batch run is currently active
	 */
	async isBatchRunActive(window: Page): Promise<boolean> {
		// If Stop button is visible, batch run is active
		const stopButton = window.locator('button').filter({ hasText: /stop/i });
		return (await stopButton.count()) > 0 && (await stopButton.first().isVisible());
	},

	/**
	 * Check if textarea is in locked (readonly) state
	 */
	async isTextareaLocked(window: Page): Promise<boolean> {
		const textarea = window.locator('textarea');
		if ((await textarea.count()) > 0) {
			const readonly = await textarea.first().getAttribute('readonly');
			return readonly !== null;
		}
		return false;
	},

	/**
	 * Get task count text from Auto Run panel
	 */
	async getTaskCountText(window: Page): Promise<string | null> {
		const taskCount = window.locator('text=/\\d+ of \\d+ task/i');
		if ((await taskCount.count()) > 0) {
			return await taskCount.first().textContent();
		}
		return null;
	},

	/**
	 * Create an Auto Run test folder with batch processing test documents
	 */
	createBatchTestFolder(basePath: string): string {
		const autoRunFolder = path.join(basePath, '.maestro/playbooks');
		fs.mkdirSync(autoRunFolder, { recursive: true });

		// Create documents with varying task counts
		fs.writeFileSync(
			path.join(autoRunFolder, 'Phase 1.md'),
			`# Phase 1: Setup

## Tasks

- [ ] Task 1: Initialize project structure
- [ ] Task 2: Set up configuration files
- [ ] Task 3: Create initial documentation

## Notes

Test document for batch processing.
`
		);

		fs.writeFileSync(
			path.join(autoRunFolder, 'Phase 2.md'),
			`# Phase 2: Implementation

## Tasks

- [ ] Task 4: Build core functionality
- [ ] Task 5: Add unit tests
- [ ] Task 6: Implement error handling

## Details

Second phase document.
`
		);

		fs.writeFileSync(
			path.join(autoRunFolder, 'Completed.md'),
			`# Completed Tasks

## Tasks

- [x] Done task 1
- [x] Done task 2

## Summary

All tasks complete in this document.
`
		);

		return autoRunFolder;
	},

	// ============================================
	// Session Switching Helpers
	// ============================================

	/**
	 * Get all session items in the session list
	 */
	getSessionItems(window: Page) {
		return window.locator('[data-testid="session-item"]');
	},

	/**
	 * Get the session list container
	 */
	getSessionList(window: Page) {
		return window.locator('[data-testid="session-list"]').or(window.locator('aside').first());
	},

	/**
	 * Click on a session by index in the session list
	 */
	async clickSessionByIndex(window: Page, index: number): Promise<boolean> {
		const sessionItems = window.locator('[data-testid="session-item"]');
		const count = await sessionItems.count();
		if (index < count) {
			await sessionItems.nth(index).click();
			return true;
		}
		return false;
	},

	/**
	 * Click on a session by name in the session list
	 */
	async clickSessionByName(window: Page, name: string): Promise<boolean> {
		const sessionItem = window.locator(`[data-testid="session-item"]:has-text("${name}")`);
		if ((await sessionItem.count()) > 0) {
			await sessionItem.first().click();
			return true;
		}
		// Try finding by text directly
		const sessionByText = window.locator(`text="${name}"`);
		if ((await sessionByText.count()) > 0) {
			await sessionByText.first().click();
			return true;
		}
		return false;
	},

	/**
	 * Get the currently active session (highlighted in session list)
	 */
	async getActiveSessionName(window: Page): Promise<string | null> {
		const activeSession = window
			.locator('[data-testid="session-item"].active')
			.or(window.locator('[data-testid="session-item"][aria-selected="true"]'));
		if ((await activeSession.count()) > 0) {
			return await activeSession.first().textContent();
		}
		return null;
	},

	/**
	 * Get session count in the session list
	 */
	async getSessionCount(window: Page): Promise<number> {
		const sessionItems = window.locator('[data-testid="session-item"]');
		return await sessionItems.count();
	},

	/**
	 * Wait for Auto Run content to change after session switch
	 */
	async waitForAutoRunContentChange(
		window: Page,
		previousContent: string,
		timeout = 5000
	): Promise<boolean> {
		try {
			await window.waitForFunction(
				(args) => {
					const ta = document.querySelector('textarea');
					return ta && ta.value !== args.prev;
				},
				{ prev: previousContent },
				{ timeout }
			);
			return true;
		} catch {
			return false;
		}
	},

	/**
	 * Create test folders for multiple sessions with unique content
	 */
	createMultiSessionTestFolders(basePath: string): { session1: string; session2: string } {
		const session1Path = path.join(basePath, 'session1', '.maestro/playbooks');
		const session2Path = path.join(basePath, 'session2', '.maestro/playbooks');

		fs.mkdirSync(session1Path, { recursive: true });
		fs.mkdirSync(session2Path, { recursive: true });

		// Session 1 documents
		fs.writeFileSync(
			path.join(session1Path, 'Session 1 Doc.md'),
			`# Session 1 Document

## Tasks

- [ ] Session 1 Task A
- [ ] Session 1 Task B
- [x] Session 1 Completed Task

## Content

Unique content for Session 1.
`
		);

		// Session 2 documents
		fs.writeFileSync(
			path.join(session2Path, 'Session 2 Doc.md'),
			`# Session 2 Document

## Tasks

- [ ] Session 2 Task X
- [ ] Session 2 Task Y
- [ ] Session 2 Task Z

## Content

Unique content for Session 2.
`
		);

		return { session1: session1Path, session2: session2Path };
	},

	/**
	 * Verify Auto Run shows content specific to a session
	 */
	async verifyAutoRunSessionContent(
		window: Page,
		expectedSessionIdentifier: string
	): Promise<boolean> {
		const textarea = window.locator('textarea');
		if ((await textarea.count()) > 0) {
			const content = await textarea.inputValue();
			return content.includes(expectedSessionIdentifier);
		}
		return false;
	},

	/**
	 * Get dirty state indicator (Save/Revert buttons visible)
	 */
	async isDirty(window: Page): Promise<boolean> {
		const saveButton = window.locator('button').filter({ hasText: 'Save' });
		const revertButton = window.locator('button').filter({ hasText: 'Revert' });
		const saveVisible = (await saveButton.count()) > 0 && (await saveButton.first().isVisible());
		const revertVisible =
			(await revertButton.count()) > 0 && (await revertButton.first().isVisible());
		return saveVisible || revertVisible;
	},

	/**
	 * Save current Auto Run content
	 */
	async saveAutoRunContent(window: Page): Promise<boolean> {
		const saveButton = window.locator('button').filter({ hasText: 'Save' });
		if ((await saveButton.count()) > 0 && (await saveButton.first().isVisible())) {
			await saveButton.first().click();
			return true;
		}
		// Try keyboard shortcut
		await window.keyboard.press('Meta+S');
		return true;
	},

	/**
	 * Revert Auto Run content to saved state
	 */
	async revertAutoRunContent(window: Page): Promise<boolean> {
		const revertButton = window.locator('button').filter({ hasText: 'Revert' });
		if ((await revertButton.count()) > 0 && (await revertButton.first().isVisible())) {
			await revertButton.first().click();
			return true;
		}
		return false;
	},
};
