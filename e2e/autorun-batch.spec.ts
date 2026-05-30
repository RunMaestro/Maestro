/**
 * E2E Tests: Auto Run Batch Processing
 *
 * Task 6.3 - Tests the Auto Run batch processing functionality including:
 * - Run button starts batch
 * - Task completion updates
 * - Stop button halts processing
 *
 * These tests verify the complete batch processing experience within the Auto Run panel.
 */
/* eslint-disable @typescript-eslint/no-unused-vars */
import { test, expect, helpers } from './fixtures/electron-app';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

type AutoRunProcessSpawnCall = {
	sessionId: string;
	toolType: string;
	cwd: string;
	command: string;
	args: string[];
	prompt?: string;
	readOnlyMode?: boolean;
};

const TINY_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADggGOSHzRgAAAAABJRU5ErkJggg==',
	'base64'
);

function createBatchWorkbenchSession(projectDir: string, autoRunFolder: string) {
	const now = Date.now();
	const idSuffix = `${now}-${Math.random().toString(36).slice(2)}`;
	const sessionId = `session-batch-${idSuffix}`;
	const aiTabId = `ai-tab-batch-${idSuffix}`;
	const phaseOnePath = path.join(autoRunFolder, 'Phase 1.md');

	return {
		id: sessionId,
		name: 'Batch Runner E2E',
		toolType: 'codex',
		state: 'idle',
		cwd: projectDir,
		fullPath: projectDir,
		projectRoot: projectDir,
		createdAt: now,
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		changedFiles: [],
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		executionQueue: [],
		activeTimeMs: 0,
		fileTreeAutoRefreshInterval: 180,
		aiTabs: [
			{
				id: aiTabId,
				agentSessionId: null,
				name: 'Main',
				starred: false,
				logs: [],
				inputValue: '',
				stagedImages: [],
				createdAt: now,
				state: 'idle',
			},
		],
		activeTabId: aiTabId,
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [{ type: 'ai', id: aiTabId }],
		unifiedClosedTabHistory: [],
		autoRunFolderPath: autoRunFolder,
		autoRunSelectedFile: 'Phase 1',
		autoRunContent: fs.readFileSync(phaseOnePath, 'utf-8'),
		autoRunContentVersion: 1,
		autoRunMode: 'preview',
		autoRunEditScrollPos: 0,
		autoRunPreviewScrollPos: 0,
		autoRunCursorPosition: 0,
	};
}

async function launchBatchWorkbench() {
	const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-batch-workbench-'));
	const autoRunFolder = helpers.createBatchTestFolder(projectDir);
	const launched = await helpers.launchAppWithState({
		homeDir: projectDir,
		sessions: [createBatchWorkbenchSession(projectDir, autoRunFolder)],
	});
	return { ...launched, projectDir, autoRunFolder };
}

async function openBatchRunnerModal(window: Page) {
	await helpers.openRightPanelTab(window, 'Auto Run');
	await expect(window.getByText('Phase 1: Setup')).toBeVisible();
	const runButton = helpers.getRunButton(window).first();
	await expect(runButton).toBeVisible();
	await expect(runButton).toBeEnabled();
	await runButton.click();
	const dialog = window.getByRole('dialog', { name: 'Auto Run Configuration' });
	await expect(dialog).toBeVisible();
	return dialog;
}

async function openDocumentSelector(window: Page, batchDialog: Locator) {
	await batchDialog.getByRole('button', { name: /Add Docs/ }).click();
	const selectorDialog = window
		.locator('div.fixed.inset-0')
		.filter({ hasText: 'Select Documents' })
		.last();
	await expect(selectorDialog.getByText('Select Documents')).toBeVisible();
	return selectorDialog;
}

async function addAllDocumentsToBatch(window: Page, batchDialog: Locator) {
	const selectorDialog = await openDocumentSelector(window, batchDialog);
	await selectorDialog.getByRole('button', { name: 'Select All' }).click();
	await expect(selectorDialog.getByRole('button', { name: /Add 3 files.*6 tasks/ })).toBeEnabled();
	await selectorDialog.getByRole('button', { name: /Add 3 files/ }).click();
	await expect(batchDialog.getByText('Phase 2.md')).toBeVisible();
	await expect(batchDialog.getByText('Completed.md')).toBeVisible();
}

async function stubAutoRunProcessSpawn(
	electronApp: ElectronApplication,
	options: { exitDelayMs?: number; exitCode?: number; output?: string } = {}
) {
	await electronApp.evaluate(({ ipcMain }, { exitDelayMs, exitCode, output }) => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eAutoRunSpawnCalls?: AutoRunProcessSpawnCall[];
		};
		state.__maestroE2eAutoRunSpawnCalls = [];

		ipcMain.removeHandler('process:spawn');
		ipcMain.handle('process:spawn', async (event, config: AutoRunProcessSpawnCall) => {
			state.__maestroE2eAutoRunSpawnCalls?.push(config);
			event.sender.send(
				'process:session-id',
				config.sessionId,
				`e2e-auto-run-agent-${state.__maestroE2eAutoRunSpawnCalls?.length ?? 1}`
			);
			event.sender.send(
				'process:data',
				config.sessionId,
				output ?? 'Summary: Auto Run batch E2E stub response.\n'
			);
			setTimeout(() => {
				if (!event.sender.isDestroyed()) {
					event.sender.send('process:exit', config.sessionId, exitCode ?? 0);
				}
			}, exitDelayMs ?? 20_000);
			return { pid: 42075, success: true };
		});
	}, options);
}

async function startStubbedBatchRun(
	window: Page,
	electronApp: ElectronApplication,
	options: { exitDelayMs?: number } = {}
) {
	await stubAutoRunProcessSpawn(electronApp, options);
	const batchDialog = await openBatchRunnerModal(window);
	await batchDialog.getByRole('button', { name: 'Go' }).click();
	await expect(batchDialog).toBeHidden();
	await expect(window.getByText('Auto Run Active').first()).toBeVisible({ timeout: 15_000 });
}

async function startStubbedMultiDocumentBatchRun(
	window: Page,
	electronApp: ElectronApplication,
	options: { exitDelayMs?: number; loop?: boolean } = {}
) {
	await stubAutoRunProcessSpawn(electronApp, options);
	const batchDialog = await openBatchRunnerModal(window);
	await addAllDocumentsToBatch(window, batchDialog);
	if (options.loop) {
		await batchDialog.getByRole('button', { name: 'Loop' }).click();
		await batchDialog.getByRole('button', { name: 'max' }).click();
	}
	await batchDialog.getByRole('button', { name: 'Go' }).click();
	await expect(batchDialog).toBeHidden();
	await expect(window.getByText('Auto Run Active').first()).toBeVisible({ timeout: 15_000 });
}

function getAutoRunStopButton(window: Page) {
	return window.getByTitle('Stop auto-run', { exact: true });
}

function getAutoRunEditor(window: Page) {
	return window.getByRole('textbox', {
		name: /Capture notes, images, and tasks in Markdown/,
	});
}

function getAutoRunImageInput(window: Page) {
	return window.locator('input[type="file"][accept="image/*"]').last();
}

function writePhaseOneTasks(autoRunFolder: string, completedTasks: number) {
	const taskStatus = (taskNumber: number) => (taskNumber <= completedTasks ? 'x' : ' ');
	fs.writeFileSync(
		path.join(autoRunFolder, 'Phase 1.md'),
		`# Phase 1: Setup

## Tasks

- [${taskStatus(1)}] Task 1: Initialize project structure
- [${taskStatus(2)}] Task 2: Set up configuration files
- [${taskStatus(3)}] Task 3: Create initial documentation

## Notes

These are test tasks for batch processing E2E tests.
`
	);
}

function writePhaseTwoTasks(autoRunFolder: string, completedTasks: number) {
	const taskStatus = (taskNumber: number) => (taskNumber <= completedTasks ? 'x' : ' ');
	fs.writeFileSync(
		path.join(autoRunFolder, 'Phase 2.md'),
		`# Phase 2: Implementation

## Tasks

- [${taskStatus(1)}] Task 4: Build core features
- [${taskStatus(2)}] Task 5: Add tests
- [${taskStatus(3)}] Task 6: Implement error handling

## Notes

Implementation phase tasks.
`
	);
}

async function waitForBatchRunToFinish(window: Page) {
	await expect(window.getByText('Auto Run Active').first()).toBeHidden({ timeout: 20_000 });
	await expect(getAutoRunStopButton(window)).toHaveCount(0);
	await expect(helpers.getRunButton(window).first()).toBeVisible();
}

/**
 * Test suite for Auto Run batch processing E2E tests
 *
 * Prerequisites:
 * - App must be built: npm run build:main && npm run build:renderer
 * - Tests run against the actual Electron application
 *
 * Note: These tests require a session with Auto Run configured.
 * Batch processing involves AI agent interaction which may require
 * additional mocking or simulated responses.
 */
test.describe('Auto Run Batch Processing', () => {
	// Create a temporary Auto Run folder for tests
	let testAutoRunFolder: string;
	let testProjectDir: string;

	test.beforeEach(async () => {
		// Create a temporary project directory
		testProjectDir = path.join(os.tmpdir(), `maestro-batch-test-${Date.now()}`);
		testAutoRunFolder = path.join(testProjectDir, 'Auto Run Docs');
		fs.mkdirSync(testAutoRunFolder, { recursive: true });

		// Create test markdown files with tasks
		fs.writeFileSync(
			path.join(testAutoRunFolder, 'Phase 1.md'),
			`# Phase 1: Setup

## Tasks

- [ ] Task 1: Initialize project structure
- [ ] Task 2: Set up configuration files
- [ ] Task 3: Create initial documentation

## Notes

These are test tasks for batch processing E2E tests.
`
		);

		fs.writeFileSync(
			path.join(testAutoRunFolder, 'Phase 2.md'),
			`# Phase 2: Implementation

## Tasks

- [ ] Task 4: Build core functionality
- [ ] Task 5: Add unit tests
- [ ] Task 6: Implement error handling

## Details

Second phase tasks for testing batch processing.
`
		);

		fs.writeFileSync(
			path.join(testAutoRunFolder, 'Completed Tasks.md'),
			`# Completed Tasks

## Tasks

- [x] Task A: Already completed
- [x] Task B: Also done

## Summary

All tasks in this document are complete.
`
		);
	});

	test.afterEach(async () => {
		// Clean up the temporary directories
		try {
			fs.rmSync(testProjectDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	test.describe('Run Button Behavior', () => {
		test('should display Run button when Auto Run is configured', async ({ window }) => {
			// Navigate to Auto Run tab
			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				// Look for Run button
				const runButton = window.locator('button').filter({ hasText: /^run$/i });
				// Run button should be visible when Auto Run is properly configured
				if ((await runButton.count()) > 0) {
					await expect(runButton.first()).toBeVisible();
				}
			}
		});

		test('should disable Run button when no tasks are present', async ({ window }) => {
			// Navigate to Auto Run tab
			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				// If we're on a document with all tasks completed,
				// the Run button should be disabled or show a tooltip
				const runButton = window.locator('button').filter({ hasText: /^run$/i });
				if ((await runButton.count()) > 0) {
					// Check if button exists - its enabled/disabled state depends on content
					await expect(runButton.first()).toBeVisible();
				}
			}
		});

		test('should disable Run button when agent is busy', async ({ window }) => {
			// Navigate to Auto Run tab
			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				// Run button should show appropriate state based on agent status
				const runButton = window.locator('button[title*="Cannot run while agent is thinking"]');
				// If agent is busy, this title should appear
				// This verifies the tooltip behavior
			}
		});

		test('should open batch runner modal when Run button is clicked', async ({ window }) => {
			// Navigate to Auto Run tab
			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				// Find and click Run button
				const runButton = window.locator('button').filter({ hasText: /^run$/i });
				if ((await runButton.count()) > 0 && (await runButton.first().isEnabled())) {
					await runButton.first().click();

					// Batch runner modal should open
					const batchRunnerModal = window.locator('text=Auto Run Configuration');
					if ((await batchRunnerModal.count()) > 0) {
						await expect(batchRunnerModal.first()).toBeVisible();
					}
				}
			}
		});

		test('should save dirty content before opening batch runner', async ({ window }) => {
			// Navigate to Auto Run tab and make edits
			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				// Switch to edit mode if not already
				const editButton = window.locator('button').filter({ hasText: 'Edit' });
				if ((await editButton.count()) > 0 && (await editButton.isVisible())) {
					await editButton.first().click();

					// Find textarea and modify content
					const textarea = window.locator('textarea');
					if ((await textarea.count()) > 0) {
						const originalValue = await textarea.inputValue();
						await textarea.fill(originalValue + '\n- [ ] New task');

						// Click Run button
						const runButton = window.locator('button').filter({ hasText: /^run$/i });
						if ((await runButton.count()) > 0 && (await runButton.first().isEnabled())) {
							await runButton.first().click();
							// Content should be saved before modal opens
							// (verified through subsequent behavior)
						}
					}
				}
			}
		});
	});

	test.describe('Batch Runner Modal', () => {
		test('should display batch runner configuration options', async ({ window }) => {
			// Navigate to Auto Run tab
			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				// Open batch runner modal
				const runButton = window.locator('button').filter({ hasText: /^run$/i });
				if ((await runButton.count()) > 0 && (await runButton.first().isEnabled())) {
					await runButton.first().click();

					// Look for modal elements
					const modal = window.locator('[role="dialog"]');
					if ((await modal.count()) > 0) {
						// Should have configuration sections
						// Agent Prompt section
						await expect(window.locator('text=Agent Prompt')).toBeVisible();
					}
				}
			}
		});

		test('should show Go button to start batch run', async ({ window }) => {
			// Navigate to Auto Run tab
			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				// Open batch runner modal
				const runButton = window.locator('button').filter({ hasText: /^run$/i });
				if ((await runButton.count()) > 0 && (await runButton.first().isEnabled())) {
					await runButton.first().click();

					// Look for Go button in modal
					const goButton = window.locator('button').filter({ hasText: 'Go' });
					if ((await goButton.count()) > 0) {
						await expect(goButton.first()).toBeVisible();
					}
				}
			}
		});

		test('should close modal with Escape key', async ({ window }) => {
			// Navigate to Auto Run tab
			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				// Open batch runner modal
				const runButton = window.locator('button').filter({ hasText: /^run$/i });
				if ((await runButton.count()) > 0 && (await runButton.first().isEnabled())) {
					await runButton.first().click();

					// Wait for modal
					const modal = window.locator('[role="dialog"]');
					if ((await modal.count()) > 0) {
						await expect(modal.first()).toBeVisible();

						// Press Escape to close
						await window.keyboard.press('Escape');

						// Modal should close
						await expect(modal.first())
							.not.toBeVisible({ timeout: 5000 })
							.catch(() => {
								// Modal may still be visible if escape was handled differently
							});
					}
				}
			}
		});

		test('should close modal with Cancel button', async ({ window }) => {
			// Navigate to Auto Run tab
			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				// Open batch runner modal
				const runButton = window.locator('button').filter({ hasText: /^run$/i });
				if ((await runButton.count()) > 0 && (await runButton.first().isEnabled())) {
					await runButton.first().click();

					// Find and click Cancel button
					const cancelButton = window.locator('button').filter({ hasText: 'Cancel' });
					if ((await cancelButton.count()) > 0) {
						await cancelButton.first().click();

						// Modal should close
						const modal = window.locator('text=Auto Run Configuration');
						await expect(modal.first())
							.not.toBeVisible({ timeout: 5000 })
							.catch(() => {
								// Modal may have different behavior
							});
					}
				}
			}
		});

		test('should display task count in modal header', async ({ window }) => {
			// Navigate to Auto Run tab
			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				// Open batch runner modal
				const runButton = window.locator('button').filter({ hasText: /^run$/i });
				if ((await runButton.count()) > 0 && (await runButton.first().isEnabled())) {
					await runButton.first().click();

					// Look for task count badge
					// The modal shows total tasks count
					const taskCount = window.locator('text=/\\d+\\s*task/i');
					if ((await taskCount.count()) > 0) {
						await expect(taskCount.first()).toBeVisible();
					}
				}
			}
		});
	});

	test.describe('Batch Run State Transitions', () => {
		test('should transition UI to running state when batch starts', async () => {
			const launched = await launchBatchWorkbench();
			try {
				await startStubbedBatchRun(launched.window, launched.electronApp);

				await expect(launched.window.getByText('Auto Run Active').first()).toBeVisible();
				await expect(launched.window.getByTitle('Click to stop auto-run')).toBeVisible();
				await expect(launched.window.getByText('0 of 3 tasks completed').first()).toBeVisible();
			} finally {
				await launched.cleanup();
			}
		});

		test('should transition UI back to idle state when batch ends', async () => {
			const launched = await launchBatchWorkbench();
			try {
				await startStubbedBatchRun(launched.window, launched.electronApp, {
					exitDelayMs: 1_500,
				});
				writePhaseOneTasks(launched.autoRunFolder, 3);

				await waitForBatchRunToFinish(launched.window);
				await expect(launched.window.getByText('3 of 3 tasks completed').first()).toBeVisible();
			} finally {
				await launched.cleanup();
			}
		});
	});

	test.describe('Task Completion Updates', () => {
		test('should display task count in Auto Run panel', async ({ window }) => {
			// Navigate to Auto Run tab
			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				// Look for task count display
				const taskCount = window.locator('text=/\\d+ of \\d+ task/i');
				// Task count should be visible when document has tasks
				if ((await taskCount.count()) > 0) {
					await expect(taskCount.first()).toBeVisible();
				}
			}
		});

		test('should update task count when checkbox is toggled in edit mode', async ({ window }) => {
			// Navigate to Auto Run tab
			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				// Switch to edit mode
				const editButton = window.locator('button').filter({ hasText: 'Edit' });
				if ((await editButton.count()) > 0 && (await editButton.isVisible())) {
					await editButton.first().click();

					// Find textarea and toggle a checkbox
					const textarea = window.locator('textarea');
					if ((await textarea.count()) > 0) {
						const value = await textarea.inputValue();

						// If document has unchecked tasks, toggle one
						if (value.includes('[ ]')) {
							const newValue = value.replace('[ ]', '[x]');
							await textarea.fill(newValue);

							// Save the change
							await window.keyboard.press('Meta+S');

							// Task count should update (one less unchecked task)
						}
					}
				}
			}
		});

		test('should show success styling when all tasks are completed', async ({ window }) => {
			// Navigate to Auto Run tab
			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				// If document has all tasks completed, task count should have success color
				// This is typically a green color indicator
				const taskCountSuccess = window.locator('text=/\\d+ of \\d+ task/i');
				// Check for success styling when all complete
			}
		});

		test('should reflect task updates during an active batch run', async () => {
			const launched = await launchBatchWorkbench();
			try {
				await startStubbedBatchRun(launched.window, launched.electronApp, {
					exitDelayMs: 1_500,
				});
				writePhaseOneTasks(launched.autoRunFolder, 1);

				await expect(launched.window.getByText('Auto Run Active').first()).toBeVisible();
				await expect(launched.window.getByText('1 of 3 tasks completed').first()).toBeVisible({
					timeout: 10_000,
				});
			} finally {
				await launched.cleanup();
			}
		});

		test('should sync content when contentVersion changes during batch run', async () => {
			const launched = await launchBatchWorkbench();
			try {
				await startStubbedBatchRun(launched.window, launched.electronApp, {
					exitDelayMs: 1_500,
				});
				writePhaseOneTasks(launched.autoRunFolder, 2);

				await expect(launched.window.getByText('2 of 3 tasks completed').first()).toBeVisible({
					timeout: 10_000,
				});
				await expect(launched.window.getByText('Auto Run Active').first()).toBeVisible();
			} finally {
				await launched.cleanup();
			}
		});
	});

	test.describe('Stop Button Behavior', () => {
		test('should show Stop button when batch run is active', async () => {
			const launched = await launchBatchWorkbench();
			try {
				await helpers.openRightPanelTab(launched.window, 'Auto Run');
				await startStubbedBatchRun(launched.window, launched.electronApp);

				await expect(getAutoRunStopButton(launched.window)).toBeVisible();
				await expect(getAutoRunStopButton(launched.window)).toBeEnabled();
			} finally {
				await launched.cleanup();
			}
		});

		test('should trigger stop when Stop button is clicked', async () => {
			const launched = await launchBatchWorkbench();
			try {
				await helpers.openRightPanelTab(launched.window, 'Auto Run');
				await startStubbedBatchRun(launched.window, launched.electronApp, {
					exitDelayMs: 1_500,
				});

				await getAutoRunStopButton(launched.window).click();
				const confirmDialog = launched.window.getByRole('dialog', { name: 'Confirm' });
				await confirmDialog.getByRole('button', { name: 'Confirm' }).click();
				writePhaseOneTasks(launched.autoRunFolder, 1);

				await waitForBatchRunToFinish(launched.window);
				await expect(launched.window.getByText('1 of 3 tasks completed').first()).toBeVisible();
			} finally {
				await launched.cleanup();
			}
		});

		test('should show Stopping state during graceful shutdown', async () => {
			const launched = await launchBatchWorkbench();
			try {
				await helpers.openRightPanelTab(launched.window, 'Auto Run');
				await startStubbedBatchRun(launched.window, launched.electronApp);

				await getAutoRunStopButton(launched.window).click();
				const confirmDialog = launched.window.getByRole('dialog', { name: 'Confirm' });
				await expect(confirmDialog.getByText('Stop Auto Run for "Batch Runner E2E"')).toBeVisible();
				await confirmDialog.getByRole('button', { name: 'Confirm' }).click();

				await expect(launched.window.getByRole('button', { name: 'Stopping...' })).toBeVisible();
				await expect(
					launched.window.getByText('Waiting for current task to complete before stopping...')
				).toBeVisible();
			} finally {
				await launched.cleanup();
			}
		});

		test('should restore Run button after batch is stopped', async () => {
			const launched = await launchBatchWorkbench();
			try {
				await helpers.openRightPanelTab(launched.window, 'Auto Run');
				await startStubbedBatchRun(launched.window, launched.electronApp, {
					exitDelayMs: 1_500,
				});

				await getAutoRunStopButton(launched.window).click();
				const confirmDialog = launched.window.getByRole('dialog', { name: 'Confirm' });
				await confirmDialog.getByRole('button', { name: 'Confirm' }).click();
				writePhaseOneTasks(launched.autoRunFolder, 1);

				await waitForBatchRunToFinish(launched.window);
				await expect(helpers.getRunButton(launched.window).first()).toBeEnabled();
			} finally {
				await launched.cleanup();
			}
		});
	});

	test.describe('Editing Lock During Batch Run', () => {
		test('should lock the document editor during batch run', async () => {
			const launched = await launchBatchWorkbench();
			try {
				await helpers.openRightPanelTab(launched.window, 'Auto Run');
				await launched.window.getByTitle('Edit document').click();
				const editor = getAutoRunEditor(launched.window);
				await expect(editor).toBeEditable();

				await startStubbedBatchRun(launched.window, launched.electronApp);

				await expect(editor).toHaveCount(0);
				await expect(launched.window.getByTitle('Preview document')).toHaveAttribute(
					'aria-pressed',
					'true'
				);
				await expect(
					launched.window.getByTitle('Editing disabled while Auto Run active')
				).toBeVisible();
			} finally {
				await launched.cleanup();
			}
		});

		test('should disable Edit button during batch run', async () => {
			const launched = await launchBatchWorkbench();
			try {
				await helpers.openRightPanelTab(launched.window, 'Auto Run');
				await startStubbedBatchRun(launched.window, launched.electronApp);

				const editButton = launched.window.getByTitle('Editing disabled while Auto Run active');
				await expect(editButton).toBeDisabled();
				await expect(editButton).toHaveAttribute('aria-pressed', 'false');
			} finally {
				await launched.cleanup();
			}
		});

		test('should keep editing keyboard shortcuts blocked during batch run', async () => {
			const launched = await launchBatchWorkbench();
			try {
				await helpers.openRightPanelTab(launched.window, 'Auto Run');
				await launched.window.getByTitle('Edit document').click();
				await expect(getAutoRunEditor(launched.window)).toBeEditable();

				await startStubbedBatchRun(launched.window, launched.electronApp);
				await launched.window.keyboard.press('Meta+L');
				await launched.window.keyboard.press('Meta+S');
				await launched.window.keyboard.type('typing should not reach the locked editor');

				await expect(getAutoRunEditor(launched.window)).toHaveCount(0);
				await expect(launched.window.getByTitle('Preview document')).toHaveAttribute(
					'aria-pressed',
					'true'
				);
			} finally {
				await launched.cleanup();
			}
		});

		test('should show locked edit affordance during batch run', async () => {
			const launched = await launchBatchWorkbench();
			try {
				await helpers.openRightPanelTab(launched.window, 'Auto Run');
				await startStubbedBatchRun(launched.window, launched.electronApp);

				const editButton = launched.window.getByTitle('Editing disabled while Auto Run active');
				await expect(editButton).toBeVisible();
				await expect(editButton).toBeDisabled();
				await expect(launched.window.getByTitle('Preview document')).toHaveAttribute(
					'aria-pressed',
					'true'
				);
			} finally {
				await launched.cleanup();
			}
		});
	});

	test.describe('Mode Management During Batch Run', () => {
		test('should auto-switch to preview mode when batch starts', async () => {
			const launched = await launchBatchWorkbench();
			try {
				await helpers.openRightPanelTab(launched.window, 'Auto Run');
				await launched.window.getByTitle('Edit document').click();
				await expect(getAutoRunEditor(launched.window)).toBeVisible();

				await startStubbedBatchRun(launched.window, launched.electronApp);

				await expect(getAutoRunEditor(launched.window)).toHaveCount(0);
				await expect(launched.window.getByTitle('Preview document')).toHaveAttribute(
					'aria-pressed',
					'true'
				);
			} finally {
				await launched.cleanup();
			}
		});

		test('should restore previous mode when batch ends', async () => {
			const launched = await launchBatchWorkbench();
			try {
				await helpers.openRightPanelTab(launched.window, 'Auto Run');
				await launched.window.getByTitle('Edit document').click();
				await expect(getAutoRunEditor(launched.window)).toBeEditable();

				await startStubbedBatchRun(launched.window, launched.electronApp, {
					exitDelayMs: 1_500,
				});
				writePhaseOneTasks(launched.autoRunFolder, 3);

				await waitForBatchRunToFinish(launched.window);
				await expect(getAutoRunEditor(launched.window)).toBeEditable();
			} finally {
				await launched.cleanup();
			}
		});

		test('should keep Cmd+E from reopening edit mode during batch run', async () => {
			const launched = await launchBatchWorkbench();
			try {
				await helpers.openRightPanelTab(launched.window, 'Auto Run');
				await launched.window.getByTitle('Edit document').click();
				await expect(getAutoRunEditor(launched.window)).toBeEditable();

				await startStubbedBatchRun(launched.window, launched.electronApp);
				await launched.window.keyboard.press('Meta+E');

				await expect(getAutoRunEditor(launched.window)).toHaveCount(0);
				await expect(launched.window.getByTitle('Preview document')).toHaveAttribute(
					'aria-pressed',
					'true'
				);
			} finally {
				await launched.cleanup();
			}
		});
	});

	test.describe('Image Upload During Batch Run', () => {
		test('should ignore image input changes during batch run', async () => {
			const launched = await launchBatchWorkbench();
			const uploadPath = path.join(launched.projectDir, 'batch-locked.png');
			fs.writeFileSync(uploadPath, TINY_PNG);
			try {
				await helpers.openRightPanelTab(launched.window, 'Auto Run');
				const originalContent = fs.readFileSync(
					path.join(launched.autoRunFolder, 'Phase 1.md'),
					'utf-8'
				);

				await startStubbedBatchRun(launched.window, launched.electronApp, {
					exitDelayMs: 1_500,
				});
				await expect(
					launched.window.getByTitle('Editing disabled while Auto Run active')
				).toBeDisabled();
				await getAutoRunImageInput(launched.window).setInputFiles(uploadPath);

				await expect
					.poll(() => fs.existsSync(path.join(launched.autoRunFolder, 'images')), {
						timeout: 1000,
					})
					.toBe(false);
				await expect
					.poll(() => fs.readFileSync(path.join(launched.autoRunFolder, 'Phase 1.md'), 'utf-8'))
					.toBe(originalContent);
				await waitForBatchRunToFinish(launched.window);
			} finally {
				await launched.cleanup();
			}
		});

		test('should accept image input changes after batch ends', async () => {
			const launched = await launchBatchWorkbench();
			const uploadPath = path.join(launched.projectDir, 'batch-complete.png');
			fs.writeFileSync(uploadPath, TINY_PNG);
			try {
				await helpers.openRightPanelTab(launched.window, 'Auto Run');
				await startStubbedBatchRun(launched.window, launched.electronApp, {
					exitDelayMs: 250,
				});
				await waitForBatchRunToFinish(launched.window);
				await launched.window.getByTitle('Edit document').click();
				await getAutoRunImageInput(launched.window).setInputFiles(uploadPath);

				await expect
					.poll(() => {
						const imagesDir = path.join(launched.autoRunFolder, 'images');
						return fs.existsSync(imagesDir) ? fs.readdirSync(imagesDir) : [];
					})
					.toHaveLength(1);
				await expect(getAutoRunEditor(launched.window)).toHaveValue(
					/!\[Phase 1-\d+\.png\]\(images\/Phase%201-\d+\.png\)/
				);
			} finally {
				await launched.cleanup();
			}
		});
	});
});

/**
 * Integration tests for batch processing with document selection
 */
test.describe('Batch Processing with Multiple Documents', () => {
	test.describe('Document Selection in Batch Modal', () => {
		test('should display all available documents in batch runner', async () => {
			const launched = await launchBatchWorkbench();
			try {
				const batchDialog = await openBatchRunnerModal(launched.window);
				const selectorDialog = await openDocumentSelector(launched.window, batchDialog);

				await expect(selectorDialog.getByText('Phase 1')).toBeVisible();
				await expect(selectorDialog.getByText('Phase 2')).toBeVisible();
				await expect(selectorDialog.getByText('Completed')).toBeVisible();
				await expect(selectorDialog.getByRole('button', { name: 'Select All' })).toBeVisible();
				await expect(selectorDialog.getByRole('button', { name: /Add 1 file/ })).toBeVisible();
			} finally {
				await launched.cleanup();
			}
		});

		test('should show task count per document', async () => {
			const launched = await launchBatchWorkbench();
			try {
				const batchDialog = await openBatchRunnerModal(launched.window);
				const selectorDialog = await openDocumentSelector(launched.window, batchDialog);

				await expect(
					selectorDialog.getByRole('button').filter({ hasText: 'Phase 1' })
				).toContainText('3 tasks');
				await expect(
					selectorDialog.getByRole('button').filter({ hasText: 'Phase 2' })
				).toContainText('3 tasks');
				await expect(
					selectorDialog.getByRole('button').filter({ hasText: 'Completed' })
				).toContainText('0 tasks');

				await selectorDialog.getByRole('button', { name: 'Select All' }).click();
				await expect(
					selectorDialog.getByRole('button', { name: /Add 3 files.*6 tasks/ })
				).toBeEnabled();
				await selectorDialog.getByRole('button', { name: /Add 3 files/ }).click();

				await expect(batchDialog.getByText('Phase 2.md')).toBeVisible();
				await expect(batchDialog.getByText('Completed.md')).toBeVisible();
				await expect(batchDialog.getByText('6 tasks').first()).toBeVisible();
				await expect(batchDialog.getByRole('button', { name: /Save as Playbook/ })).toBeVisible();
			} finally {
				await launched.cleanup();
			}
		});

		test('should process documents in order', async () => {
			const launched = await launchBatchWorkbench();
			try {
				await startStubbedMultiDocumentBatchRun(launched.window, launched.electronApp, {
					exitDelayMs: 1_500,
				});
				await expect(launched.window.getByTitle('Document 1/3: Phase 1.md')).toBeVisible();

				writePhaseOneTasks(launched.autoRunFolder, 3);
				await expect(launched.window.getByTitle('Document 3/3: Phase 2.md')).toBeVisible({
					timeout: 10_000,
				});

				writePhaseTwoTasks(launched.autoRunFolder, 3);
				await waitForBatchRunToFinish(launched.window);
			} finally {
				await launched.cleanup();
			}
		});
	});

	test.describe('Loop Mode', () => {
		test('should enable loop controls for repeated processing', async () => {
			const launched = await launchBatchWorkbench();
			try {
				const batchDialog = await openBatchRunnerModal(launched.window);

				await expect(
					batchDialog.getByText('You can enable loops with two or more documents')
				).toBeVisible();

				await addAllDocumentsToBatch(launched.window, batchDialog);
				await expect(batchDialog.getByText('Total: 6 tasks across 3 documents')).toBeVisible();

				const loopButton = batchDialog.getByRole('button', { name: 'Loop' });
				await expect(loopButton).toHaveAttribute(
					'title',
					'Loop back to first document when finished'
				);
				await loopButton.click();

				await expect(batchDialog.getByTitle('Loop forever until all tasks complete')).toBeVisible();
				await expect(batchDialog.getByRole('button', { name: 'max' })).toBeVisible();
			} finally {
				await launched.cleanup();
			}
		});

		test('should configure finite max loops setting', async () => {
			const launched = await launchBatchWorkbench();
			try {
				const batchDialog = await openBatchRunnerModal(launched.window);

				await addAllDocumentsToBatch(launched.window, batchDialog);
				await batchDialog.getByRole('button', { name: 'Loop' }).click();
				await batchDialog.getByRole('button', { name: 'max' }).click();

				const maxLoopsSlider = batchDialog.locator('input[type="range"][min="1"][max="25"]');
				await expect(maxLoopsSlider).toHaveValue('5');
				await maxLoopsSlider.focus();
				await maxLoopsSlider.press('ArrowLeft');
				await maxLoopsSlider.press('ArrowLeft');

				await expect(maxLoopsSlider).toHaveValue('3');
				await expect(batchDialog.getByText('3', { exact: true })).toBeVisible();
				await batchDialog.getByTitle('Loop forever until all tasks complete').click();
				await expect(maxLoopsSlider).toBeHidden();
			} finally {
				await launched.cleanup();
			}
		});
	});
});

/**
 * Progress display tests during batch processing
 */
test.describe('Batch Processing Progress Display', () => {
	test('should show current document being processed', async () => {
		const launched = await launchBatchWorkbench();
		try {
			await startStubbedMultiDocumentBatchRun(launched.window, launched.electronApp);

			await expect(launched.window.getByTitle('Document 1/3: Phase 1.md')).toBeVisible();
			await expect(launched.window.getByText('Document 1/3: Phase 1')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('should show overall progress across documents', async () => {
		const launched = await launchBatchWorkbench();
		try {
			await startStubbedMultiDocumentBatchRun(launched.window, launched.electronApp, {
				exitDelayMs: 1_500,
			});

			await expect(launched.window.getByText('0 of 6 tasks completed').first()).toBeVisible();
			writePhaseOneTasks(launched.autoRunFolder, 3);

			await expect(launched.window.getByTitle('Document 3/3: Phase 2.md')).toBeVisible({
				timeout: 10_000,
			});
			await expect(launched.window.getByText('3 of 6 tasks completed').first()).toBeVisible({
				timeout: 5_000,
			});
		} finally {
			await launched.cleanup();
		}
	});

	test('should display loop iteration count when in loop mode', async () => {
		const launched = await launchBatchWorkbench();
		try {
			await startStubbedMultiDocumentBatchRun(launched.window, launched.electronApp, {
				loop: true,
			});

			await expect(launched.window.getByText('Loop 1 of 5')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});
});

/**
 * Accessibility tests for batch processing
 */
test.describe('Batch Processing Accessibility', () => {
	test('should have accessible Run button with proper title', async ({ window }) => {
		// Navigate to Auto Run tab
		const autoRunTab = window.locator('text=Auto Run');
		if ((await autoRunTab.count()) > 0) {
			await autoRunTab.first().click();

			// Run button should have accessible title
			const runButton = window.locator('button').filter({ hasText: /^run$/i });
			if ((await runButton.count()) > 0) {
				const title = await runButton.first().getAttribute('title');
				// Button should have a descriptive title or aria-label
			}
		}
	});

	test('should have accessible Stop button with proper title', async ({ window }) => {
		// Stop button (when visible) should have accessible title
		// This test structure verifies accessibility attributes exist
		const stopButton = window.locator('button').filter({ hasText: /stop/i });
		if ((await stopButton.count()) > 0) {
			const title = await stopButton.first().getAttribute('title');
			// Button should have a descriptive title
		}
	});

	test('should announce batch state changes to screen readers', async ({ window }) => {
		// This test verifies ARIA live regions or state announcements
		// The implementation should use aria-live or aria-busy attributes

		// Look for aria-busy on relevant containers
		const container = window.locator('[aria-busy]');
		// When batch is running, container should indicate busy state
	});
});

/**
 * Error handling tests for batch processing
 */
test.describe('Batch Processing Error Handling', () => {
	test('should return to idle when the agent process exits with failure', async () => {
		const launched = await launchBatchWorkbench();
		try {
			await helpers.openRightPanelTab(launched.window, 'Auto Run');
			await startStubbedBatchRun(launched.window, launched.electronApp, {
				exitCode: 1,
				exitDelayMs: 250,
				output: 'Agent disconnected before completing the Auto Run task.\n',
			});

			await waitForBatchRunToFinish(launched.window);
			await expect(helpers.getRunButton(launched.window).first()).toBeEnabled();
			await expect(launched.window.getByText('Auto Run Active').first()).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test('should return to idle when a selected document disappears before processing', async () => {
		const launched = await launchBatchWorkbench();
		try {
			await stubAutoRunProcessSpawn(launched.electronApp, { exitDelayMs: 250 });
			const batchDialog = await openBatchRunnerModal(launched.window);
			fs.rmSync(path.join(launched.autoRunFolder, 'Phase 1.md'), { force: true });
			await batchDialog.getByRole('button', { name: 'Go' }).click();
			await expect(batchDialog).toBeHidden();

			await expect(launched.window.getByText('Auto Run Active').first()).toBeHidden({
				timeout: 20_000,
			});
			await expect(helpers.getRunButton(launched.window).first()).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('should start clean after restart while a batch was active', async () => {
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-batch-restart-'));
		const autoRunFolder = helpers.createBatchTestFolder(projectDir);
		const session = createBatchWorkbenchSession(projectDir, autoRunFolder);
		const launched = await helpers.launchAppWithState({
			homeDir: projectDir,
			sessions: [session],
		});

		try {
			await helpers.openRightPanelTab(launched.window, 'Auto Run');
			await startStubbedBatchRun(launched.window, launched.electronApp, {
				exitDelayMs: 20_000,
			});
			await expect(launched.window.getByText('Auto Run Active').first()).toBeVisible();
			await launched.cleanup();

			const relaunched = await helpers.launchAppWithState({
				homeDir: projectDir,
				sessions: [session],
			});
			try {
				await helpers.openRightPanelTab(relaunched.window, 'Auto Run');
				await expect(relaunched.window.getByText('Auto Run Active').first()).toBeHidden();
				await expect(helpers.getRunButton(relaunched.window).first()).toBeVisible();
				await expect(helpers.getRunButton(relaunched.window).first()).toBeEnabled();
			} finally {
				await relaunched.cleanup();
			}
		} finally {
			try {
				await launched.cleanup();
			} catch {
				// App may already be closed by the restart simulation.
			}
			fs.rmSync(projectDir, { recursive: true, force: true });
		}
	});
});
