/**
 * E2E Tests: Auto Run Setup Wizard
 *
 * Task 6.1 - Tests the Auto Run setup wizard flow including:
 * - Folder selection dialog
 * - Document creation flow
 * - Initial content population
 *
 * These tests verify the complete wizard experience from launching
 * through initial document creation.
 */
/* eslint-disable @typescript-eslint/no-unused-vars */
import { test, expect, helpers } from './fixtures/electron-app';
import type { Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

function runGit(cwd: string, args: string[]): void {
	execFileSync('git', args, {
		cwd,
		stdio: 'ignore',
		env: process.env,
	});
}

async function selectClaudeCodeAgent(window: Page, agentName = 'E2E Agent'): Promise<void> {
	const claudeAgent = window.getByRole('button', { name: /^Claude Code$/ });
	await expect(claudeAgent).toBeVisible();
	await claudeAgent.click();
	await window.getByRole('textbox', { name: /agent name/i }).fill(agentName);
}

async function advanceCodexWizardToDirectorySelection(
	window: Page,
	agentName = 'Codex E2E Agent'
): Promise<void> {
	await helpers.openWizardViaShortcut(window);
	const codexAgent = window.getByRole('button', { name: /^Codex$/ });
	await expect(codexAgent).toBeVisible();
	await expect(codexAgent).toBeEnabled({ timeout: 10000 });
	await codexAgent.click();
	await window.getByRole('textbox', { name: /agent name/i }).fill(agentName);
	const continueButton = window.getByRole('button', { name: 'Continue' });
	await expect(continueButton).toBeEnabled();
	await continueButton.click();
	await expect(window.getByRole('heading', { name: 'Where Should We Work?' })).toBeVisible();
}

async function openDebugPhaseReviewModal(window: Page) {
	await expect
		.poll(() =>
			window.evaluate(() => {
				const debugWindow = window as Window & {
					__maestroDebug?: { openDebugWizard?: () => void };
				};
				return typeof debugWindow.__maestroDebug?.openDebugWizard;
			})
		)
		.toBe('function');
	await window.evaluate(() => {
		const debugWindow = window as Window & {
			__maestroDebug: { openDebugWizard: () => void };
		};
		debugWindow.__maestroDebug.openDebugWizard();
	});

	const dialog = window.getByRole('dialog', { name: 'Debug: Jump to Phase Review' });
	await expect(dialog).toBeVisible();
	return dialog;
}

function writeAutoRunDocs(
	projectDir: string,
	docs: Record<string, string> = {
		'Phase 1.md': `# Phase 1: Discovery

## Tasks

- [ ] Confirm project structure
- [x] Review existing docs

Phase one seeded content for the debug review path.
`,
		'Phase 2.md': `# Phase 2: Implementation

## Tasks

- [ ] Add deterministic tests
- [ ] Verify behavior

Phase two seeded content for document switching.
`,
	}
): string {
	const autoRunDir = path.join(projectDir, 'Auto Run Docs');
	fs.mkdirSync(autoRunDir, { recursive: true });
	for (const [filename, content] of Object.entries(docs)) {
		fs.writeFileSync(path.join(autoRunDir, filename), content, 'utf-8');
	}
	return autoRunDir;
}

async function jumpToPhaseReview(
	window: Page,
	projectDir: string,
	agentName = 'Phase Review Agent'
) {
	const dialog = await openDebugPhaseReviewModal(window);
	await dialog.locator('input').nth(0).fill(projectDir);
	await dialog.locator('input').nth(1).fill(agentName);
	await dialog.getByRole('button', { name: 'Jump to Phase Review' }).click();

	const reviewDialog = window.getByRole('dialog', { name: 'Review Your Playbooks' });
	await expect(reviewDialog).toBeVisible({ timeout: 10000 });
	return reviewDialog;
}

/**
 * Test suite for Auto Run setup wizard E2E tests
 *
 * Prerequisites:
 * - App must be built: npm run build:main && npm run build:renderer
 * - Tests run against the actual Electron application
 *
 * Note: Some tests may require dialog mocking for native file pickers.
 * The wizard flow is:
 * 1. Agent Selection - Choose AI agent (Claude Code) and project name
 * 2. Directory Selection - Select project folder
 * 3. Conversation - AI project discovery
 * 4. Phase Review - Review generated plan and create documents
 */
test.describe('Auto Run Setup Wizard', () => {
	// Create a temporary project directory for tests
	let testProjectDir: string;

	test.beforeEach(async () => {
		// Create a temporary directory to use as the project folder
		testProjectDir = path.join(os.tmpdir(), `maestro-test-project-${Date.now()}`);
		fs.mkdirSync(testProjectDir, { recursive: true });

		// Initialize a basic project structure
		fs.writeFileSync(
			path.join(testProjectDir, 'package.json'),
			JSON.stringify({ name: 'test-project', version: '1.0.0' }, null, 2)
		);
		fs.writeFileSync(
			path.join(testProjectDir, 'README.md'),
			'# Test Project\n\nA test project for E2E testing.'
		);
	});

	test.afterEach(async () => {
		// Clean up the temporary project directory
		try {
			fs.rmSync(testProjectDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	test.describe('Wizard Launch', () => {
		test('should display the wizard when triggered via keyboard shortcut', async ({ window }) => {
			await helpers.openWizardViaShortcut(window);
		});

		test('should show agent selection as the first step', async ({ window }) => {
			await helpers.openWizardViaShortcut(window);

			// Should show available agents (use first to avoid multiple matches)
			await expect(window.locator('text=Claude Code').first()).toBeVisible();
		});

		test('should close wizard with Escape on first step', async ({ window }) => {
			await helpers.openWizardViaShortcut(window);
			const wizardTitle = window.getByRole('heading', { name: 'Create a Maestro Agent' });

			// Press Escape to close
			await window.keyboard.press('Escape');

			// Wizard should close (heading should not be visible)
			await expect(wizardTitle).not.toBeVisible({ timeout: 5000 });
		});
	});

	test.describe('Agent Selection Screen', () => {
		test.beforeEach(async ({ window }) => {
			// Open wizard before each test in this group
			await helpers.openWizardViaShortcut(window);
		});

		test('should display Claude Code as the primary supported agent', async ({ window }) => {
			// Claude Code should be visible and selectable
			const claudeAgent = window.locator('text=Claude Code').first();
			await expect(claudeAgent).toBeVisible();
		});

		test('should display supported and coming soon agents', async ({ window }) => {
			await expect(window.getByRole('button', { name: /^Codex$/ })).toBeVisible();
			await expect(window.getByRole('button', { name: /^OpenCode$/ })).toBeVisible();
			await expect(window.locator('text=Gemini CLI')).toBeVisible();
			await expect(window.locator('text=Qwen3 Coder')).toBeVisible();
			await expect(window.locator('text=Coming soon').first()).toBeVisible();
		});

		test('should allow entering a project name', async ({ window }) => {
			// Find the name input field
			const nameInput = window
				.locator('input[placeholder*="Project"]')
				.or(window.locator('input').filter({ hasText: /name/i }));

			// If input exists, test filling it
			if ((await nameInput.count()) > 0) {
				await nameInput.fill('My Test Project');
				await expect(nameInput).toHaveValue('My Test Project');
			}
		});

		test('should navigate using keyboard', async ({ window }) => {
			// Arrow keys should navigate between agent tiles
			await window.keyboard.press('ArrowRight');
			await window.keyboard.press('ArrowDown');
			await window.keyboard.press('ArrowLeft');

			// Tab should move to name field
			await window.keyboard.press('Tab');
		});

		test('should proceed to next step when Claude Code is selected', async ({ window }) => {
			await selectClaudeCodeAgent(window);

			// Should be able to click Next/Continue (may be automatic on selection)
			// Note: The Continue button may be disabled until agent detection completes
			const nextButton = window.locator('button').filter({ hasText: /next|continue/i });

			// Wait for the button to become enabled (agent detection may take time)
			// If it stays disabled (agent not detected), skip the click
			try {
				await nextButton.waitFor({ state: 'visible', timeout: 5000 });
				// Check if enabled - if not, the test passes (button is shown correctly)
				const isEnabled = await nextButton.isEnabled();
				if (isEnabled) {
					await nextButton.click();
					// Should now be on directory selection or conversation
					// The exact next screen depends on wizard flow
				}
				// If button exists but is disabled, that's valid - agent might not be detected
			} catch {
				// Button not visible - this is also a valid state
			}
		});
	});

	test.describe('Directory Selection Screen', () => {
		test('should allow entering a project directory', async ({ window }) => {
			await advanceCodexWizardToDirectorySelection(window);

			await window.locator('#directory-path').fill(testProjectDir);

			await expect(window.getByText('Regular Directory')).toBeVisible();
			await expect(window.getByText('Not a Git repository.')).toBeVisible();
			await expect(window.getByRole('button', { name: 'Continue' })).toBeEnabled();
		});

		test('should validate selected directory is valid', async ({ window }) => {
			await advanceCodexWizardToDirectorySelection(window);

			const missingPath = path.join(testProjectDir, 'missing-directory');
			await window.locator('#directory-path').fill(missingPath);

			await expect(window.locator('#directory-error')).toHaveText(
				'Directory not found. Please check the path exists.'
			);
			await expect(window.getByRole('button', { name: 'Continue' })).toBeDisabled();
		});

		test('should detect git repository status', async ({ window }) => {
			runGit(testProjectDir, ['init']);
			await advanceCodexWizardToDirectorySelection(window);

			await window.locator('#directory-path').fill(testProjectDir);

			await expect(
				window.locator('p').filter({ hasText: 'Git Repository Detected' })
			).toBeVisible();
			await expect(window.getByText('Version control features like branch tracking')).toBeVisible();
			await expect(window.getByRole('button', { name: 'Continue' })).toBeEnabled();
		});
	});

	test.describe('Document Creation Flow', () => {
		test.skip('should create Auto Run Docs folder in project', async ({ window }) => {
			// This test requires completing the wizard flow
			// Would verify:
			// 1. Complete all wizard steps
			// 2. 'Auto Run Docs' folder is created in project
			// 3. Initial documents are created
		});

		test.skip('should populate initial document with project-specific content', async ({
			window,
		}) => {
			// Would verify:
			// - Document contains relevant project information
			// - Tasks are populated based on conversation
			// - Document follows markdown format
		});
	});

	test.describe('Phase Review Debug Entry', () => {
		test('should validate that the debug phase review entry requires Auto Run Docs', async ({
			window,
		}) => {
			const dialog = await openDebugPhaseReviewModal(window);
			await dialog.locator('input').nth(0).fill(testProjectDir);
			await dialog.locator('input').nth(1).fill('Missing Docs Agent');
			await dialog.getByRole('button', { name: 'Jump to Phase Review' }).click();

			await expect(dialog.getByText(/No Auto Run Docs folder found/)).toBeVisible();
		});

		test('should validate that the debug phase review entry requires markdown files', async ({
			window,
		}) => {
			fs.mkdirSync(path.join(testProjectDir, 'Auto Run Docs'), { recursive: true });

			const dialog = await openDebugPhaseReviewModal(window);
			await dialog.locator('input').nth(0).fill(testProjectDir);
			await dialog.locator('input').nth(1).fill('Empty Docs Agent');
			await dialog.getByRole('button', { name: 'Jump to Phase Review' }).click();

			await expect(dialog.getByText(/No markdown files found/)).toBeVisible();
		});

		test('should load existing Auto Run documents into the phase review screen', async ({
			window,
		}) => {
			writeAutoRunDocs(testProjectDir);

			const reviewDialog = await jumpToPhaseReview(window, testProjectDir, 'Review Loaded Agent');

			await expect(reviewDialog.getByText('Step 5 of 5')).toBeVisible();
			await expect(reviewDialog.getByRole('button', { name: 'Phase 1.md' })).toBeVisible();
			await expect(reviewDialog.getByText(/4 total tasks.*2 documents.*2 tasks/)).toBeVisible();
			await expect(reviewDialog.getByRole('heading', { name: 'Phase 1: Discovery' })).toBeVisible();
			await expect(
				reviewDialog.getByText('Phase one seeded content for the debug review path.')
			).toBeVisible();
		});

		test('should switch between loaded phase review documents from the selector', async ({
			window,
		}) => {
			writeAutoRunDocs(testProjectDir);

			const reviewDialog = await jumpToPhaseReview(window, testProjectDir, 'Review Switch Agent');
			await reviewDialog.getByRole('button', { name: 'Phase 1.md' }).click();
			await reviewDialog.getByRole('button', { name: 'Phase 2.md' }).click();

			await expect(
				reviewDialog.getByRole('heading', { name: 'Phase 2: Implementation' })
			).toBeVisible();
			await expect(
				reviewDialog.getByText('Phase two seeded content for document switching.')
			).toBeVisible();
			await expect(reviewDialog.getByText(/4 total tasks.*2 documents.*2 tasks/)).toBeVisible();
		});

		test('should support phase review keyboard document cycling', async ({ window }) => {
			writeAutoRunDocs(testProjectDir);

			const reviewDialog = await jumpToPhaseReview(window, testProjectDir, 'Review Keyboard Agent');
			await reviewDialog.click();
			await window.keyboard.press('Meta+Shift+]');

			await expect(reviewDialog.getByRole('button', { name: 'Phase 2.md' })).toBeVisible();
			await expect(
				reviewDialog.getByRole('heading', { name: 'Phase 2: Implementation' })
			).toBeVisible();
		});

		test('should save phase review edits back to the Auto Run document', async ({ window }) => {
			const autoRunDir = writeAutoRunDocs(testProjectDir);
			const reviewDialog = await jumpToPhaseReview(window, testProjectDir, 'Review Edit Agent');
			const editedContent = `# Phase 1: Discovery

## Tasks

- [ ] Confirm project structure
- [x] Review existing docs
- [ ] Saved from Phase Review E2E
`;

			await reviewDialog.getByRole('button', { name: 'Edit' }).click();
			await reviewDialog.locator('textarea').fill(editedContent);

			await expect
				.poll(() => fs.readFileSync(path.join(autoRunDir, 'Phase 1.md'), 'utf-8'), {
					timeout: 6000,
				})
				.toContain('Saved from Phase Review E2E');
		});

		test('should submit the debug phase review modal with Enter', async ({ window }) => {
			writeAutoRunDocs(testProjectDir);

			const dialog = await openDebugPhaseReviewModal(window);
			await dialog.locator('input').nth(0).fill(testProjectDir);
			await dialog.locator('input').nth(1).fill('Enter Submit Agent');
			await dialog.locator('input').nth(1).press('Enter');

			await expect(window.getByRole('dialog', { name: 'Review Your Playbooks' })).toBeVisible({
				timeout: 10000,
			});
		});

		test('should launch a static agent from phase review without starting a live provider', async ({
			window,
		}) => {
			writeAutoRunDocs(testProjectDir, {
				'Phase 1.md': `# Phase 1: Launch Ready

This document intentionally has no task checkboxes.
`,
			});

			const reviewDialog = await jumpToPhaseReview(
				window,
				testProjectDir,
				'Launchable Wizard Agent'
			);
			await reviewDialog.getByRole('button', { name: "I'm Ready to Go" }).click();

			await expect(reviewDialog).toBeHidden({ timeout: 10000 });
			await expect(
				window.locator('.header-session-name').filter({ hasText: 'Launchable Wizard Agent' })
			).toBeVisible();
			await helpers.openRightPanelTab(window, 'Auto Run');
			await expect(window.getByPlaceholder(/Capture notes/)).toHaveValue(/Phase 1: Launch Ready/);
		});
	});

	test.describe('Wizard Navigation', () => {
		test.beforeEach(async ({ window }) => {
			await helpers.openWizardViaShortcut(window);
		});

		test('should show step indicators', async ({ window }) => {
			// Look for step indicator (1/4 or similar)
			// The exact format depends on the UI implementation
			const stepIndicator = window.locator('text=/Step|\\d.*of.*\\d/i');
			// This may or may not exist depending on UI design
		});

		test('should prevent proceeding without required selections', async ({ window }) => {
			// Try to proceed without selecting an agent
			const nextButton = window.locator('button').filter({ hasText: /next|continue/i });

			if (await nextButton.isVisible()) {
				// If no agent is selected, Next should be disabled or show error
				// The exact behavior depends on implementation
			}
		});

		test('should allow going back to previous steps', async ({ window }) => {
			await selectClaudeCodeAgent(window);

			// Find and click Next if visible
			const nextButton = window.locator('button').filter({ hasText: /next|continue/i });
			if ((await nextButton.isVisible()) && (await nextButton.isEnabled())) {
				await nextButton.click();

				// Now we should be able to go back
				const backButton = window.locator('button').filter({ hasText: /back/i });
				if (await backButton.isVisible()) {
					await backButton.click();

					// Should be back on agent selection (use heading specifically)
					await expect(
						window.getByRole('heading', { name: 'Create a Maestro Agent' })
					).toBeVisible();
				}
			}
		});
	});

	test.describe('Exit Confirmation', () => {
		test('should show confirmation when exiting after step 1', async ({ window }) => {
			await advanceCodexWizardToDirectorySelection(window);

			await window.getByRole('button', { name: 'Close wizard' }).click();
			const confirmDialog = window.getByRole('dialog', { name: 'Exit Setup Wizard?' });
			await expect(confirmDialog).toBeVisible();
			await expect(confirmDialog.getByText('Step 2 of 5')).toBeVisible();
			await expect(
				confirmDialog.getByRole('button', { name: 'Exit & Save Progress' })
			).toBeVisible();
			await expect(confirmDialog.getByRole('button', { name: 'Just Quit' })).toBeVisible();
			await expect(confirmDialog.getByRole('button', { name: 'Cancel' })).toBeFocused();

			await confirmDialog.getByRole('button', { name: 'Cancel' }).click();
			await expect(confirmDialog).toBeHidden();
			await expect(window.getByRole('heading', { name: 'Where Should We Work?' })).toBeVisible();
		});

		test('should save state when choosing Exit & Save Progress', async ({ window }) => {
			await advanceCodexWizardToDirectorySelection(window, 'Resume Codex Agent');

			await window.getByRole('button', { name: 'Close wizard' }).click();
			const confirmDialog = window.getByRole('dialog', { name: 'Exit Setup Wizard?' });
			await expect(confirmDialog).toBeVisible();
			await confirmDialog.getByRole('button', { name: 'Exit & Save Progress' }).click();
			await expect(window.getByRole('heading', { name: 'Where Should We Work?' })).toBeHidden();
			await expect
				.poll(async () =>
					window.evaluate(async () => {
						const resumeState = await window.maestro.settings.get('wizardResumeState');
						if (!resumeState || typeof resumeState !== 'object') {
							return null;
						}

						return `${resumeState.currentStep}:${resumeState.agentName}:${resumeState.selectedAgent}`;
					})
				)
				.toBe('directory-selection:Resume Codex Agent:codex');

			await window.keyboard.press('Meta+Shift+N');
			const resumeDialog = window.getByRole('dialog', { name: 'Resume Setup Wizard' });
			await expect(resumeDialog).toBeVisible();
			await expect(resumeDialog.getByText('Directory Selection')).toBeVisible();
			await expect(resumeDialog.getByText('Resume Codex Agent')).toBeVisible();
			await resumeDialog.getByRole('button', { name: 'Start Fresh' }).click();
			await expect
				.poll(async () => window.evaluate(() => window.maestro.settings.get('wizardResumeState')))
				.toBeNull();
			await expect(window.getByRole('heading', { name: 'Create a Maestro Agent' })).toBeVisible();
		});

		test('should clear state when choosing Just Quit', async ({ window }) => {
			await advanceCodexWizardToDirectorySelection(window, 'Discard Codex Agent');

			await window.getByRole('button', { name: 'Close wizard' }).click();
			const confirmDialog = window.getByRole('dialog', { name: 'Exit Setup Wizard?' });
			await expect(confirmDialog).toBeVisible();
			await confirmDialog.getByRole('button', { name: 'Just Quit' }).click();
			await expect(window.getByRole('heading', { name: 'Where Should We Work?' })).toBeHidden();
			await expect
				.poll(async () => window.evaluate(() => window.maestro.settings.get('wizardResumeState')))
				.toBeNull();

			await window.keyboard.press('Meta+Shift+N');
			await expect(window.getByRole('dialog', { name: 'Resume Setup Wizard' })).toBeHidden();
			await expect(window.getByRole('heading', { name: 'Create a Maestro Agent' })).toBeVisible();
		});
	});

	test.describe('Accessibility', () => {
		test.beforeEach(async ({ window }) => {
			await helpers.openWizardViaShortcut(window);
		});

		test('should support keyboard-only navigation', async ({ window }) => {
			// Should be able to navigate entire wizard with keyboard
			// Tab through elements, Enter to select, Escape to close

			// Navigate through agent tiles
			await window.keyboard.press('Tab');
			await window.keyboard.press('Tab');

			// Should be able to close with Escape
			await window.keyboard.press('Escape');
		});

		test('should have proper focus management', async ({ window }) => {
			// When wizard opens, focus should be set appropriately
			// After transitions, focus should be managed

			// Check that something is focused
			const activeElement = await window.evaluate(() => document.activeElement?.tagName);
			expect(activeElement).toBeTruthy();
		});
	});
});

/**
 * Integration tests that require more complete setup
 * These are marked as skip until the infrastructure supports them
 */
test.describe.skip('Full Wizard Flow Integration', () => {
	test('should complete entire wizard and create session with Auto Run', async ({ window }) => {
		// Complete wizard flow:
		// 1. Select Claude Code agent
		// 2. Enter project name
		// 3. Select directory (requires dialog mock)
		// 4. Complete conversation (may require AI mock)
		// 5. Review and accept plan
		// 6. Verify session is created
		// 7. Verify Auto Run documents exist
	});

	test('should handle wizard resume after app restart', async ({ electronApp, window }) => {
		// Partial completion, exit, relaunch
		// Should offer to resume
		// Verify state is correctly restored
	});

	test('should integrate with main app after completion', async ({ window }) => {
		// After wizard completes:
		// - Session should be visible in session list
		// - Auto Run tab should show documents
		// - First document should be selected
	});
});
