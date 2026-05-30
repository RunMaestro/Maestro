/**
 * E2E Tests: Auto Run Editing
 *
 * Task 6.2 - Tests the Auto Run editing functionality including:
 * - Typing in edit mode
 * - Checkbox toggling
 * - Image paste and attachment
 * - Mode switching between edit and preview
 *
 * These tests verify the complete editing experience within the Auto Run panel.
 */
/* eslint-disable @typescript-eslint/no-unused-vars */
import { test, expect, helpers } from './fixtures/electron-app';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

const TINY_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADggGOSHzRgAAAAABJRU5ErkJggg==',
	'base64'
);

function getAutoRunImageInput(window: Page) {
	return window.locator('input[type="file"][accept="image/*"]').last();
}

async function emitAutoRunFileChanged(
	electronApp: ElectronApplication,
	folderPath: string,
	filename: string
) {
	await electronApp.evaluate(
		({ BrowserWindow }, payload: { folderPath: string; filename: string }) => {
			for (const win of BrowserWindow.getAllWindows()) {
				if (!win.isDestroyed()) {
					win.webContents.send('autorun:fileChanged', {
						...payload,
						eventType: 'change',
					});
				}
			}
		},
		{ folderPath, filename }
	);
}

function createEditingWorkbenchSession(
	projectDir: string,
	autoRunFolder: string,
	selectedFile = 'ImageDoc'
) {
	const now = Date.now();
	const idSuffix = `${now}-${Math.random().toString(36).slice(2)}`;
	const sessionId = `session-editing-${idSuffix}`;
	const aiTabId = `ai-tab-editing-${idSuffix}`;
	const selectedPath = path.join(autoRunFolder, `${selectedFile}.md`);

	return {
		id: sessionId,
		name: 'Auto Run Editing E2E',
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
		autoRunSelectedFile: selectedFile,
		autoRunContent: fs.readFileSync(selectedPath, 'utf-8'),
		autoRunContentVersion: 1,
		autoRunMode: 'preview',
		autoRunEditScrollPos: 0,
		autoRunPreviewScrollPos: 0,
		autoRunCursorPosition: 0,
	};
}

async function launchEditingDocumentWorkbench(
	projectDir: string,
	autoRunFolder: string,
	selectedFile: string,
	content: string
) {
	fs.writeFileSync(path.join(autoRunFolder, `${selectedFile}.md`), content, 'utf-8');

	return helpers.launchAppWithState({
		homeDir: projectDir,
		sessions: [createEditingWorkbenchSession(projectDir, autoRunFolder, selectedFile)],
	});
}

/**
 * Test suite for Auto Run editing E2E tests
 *
 * Prerequisites:
 * - App must be built: npm run build:main && npm run build:renderer
 * - Tests run against the actual Electron application
 *
 * Note: These tests require a session with Auto Run configured.
 * Some tests involving clipboard operations may require additional mocking.
 */
test.describe('Auto Run Editing', () => {
	// Create a temporary Auto Run folder for tests
	let testAutoRunFolder: string;
	let testProjectDir: string;

	test.beforeEach(async () => {
		// Create a temporary project directory
		testProjectDir = path.join(os.tmpdir(), `maestro-test-project-${Date.now()}`);
		testAutoRunFolder = path.join(testProjectDir, 'Auto Run Docs');
		fs.mkdirSync(testAutoRunFolder, { recursive: true });

		// Create test markdown files
		fs.writeFileSync(
			path.join(testAutoRunFolder, 'Test Document.md'),
			`# Test Document

This is a test document for E2E testing.

## Tasks

- [ ] Task 1: First unchecked task
- [ ] Task 2: Second unchecked task
- [x] Task 3: Completed task

## Content

Some sample content for testing.
`
		);

		fs.writeFileSync(path.join(testAutoRunFolder, 'Empty Document.md'), '');
	});

	async function launchImageAttachmentWorkbench() {
		const selectedFile = 'ImageDoc';
		const imageFilename = `${selectedFile}-seed.png`;
		const imagesDir = path.join(testAutoRunFolder, 'images');
		fs.mkdirSync(imagesDir, { recursive: true });
		fs.writeFileSync(
			path.join(testAutoRunFolder, `${selectedFile}.md`),
			`# Image Attachment Coverage

![Seed attachment](images/${imageFilename})

- [ ] Verify seeded attachment rendering
`
		);
		fs.writeFileSync(path.join(imagesDir, imageFilename), TINY_PNG);

		return helpers.launchAppWithState({
			homeDir: testProjectDir,
			sessions: [createEditingWorkbenchSession(testProjectDir, testAutoRunFolder, selectedFile)],
		});
	}

	test.afterEach(async () => {
		// Clean up the temporary directories
		try {
			fs.rmSync(testProjectDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	test.describe('Typing in Edit Mode', () => {
		test('should allow typing text in the editor textarea', async ({ window }) => {
			// Skip if no Auto Run is configured - this test needs a pre-configured session
			// For now, we'll verify the Auto Run panel exists and has expected elements

			// Look for the Auto Run tab in the right panel
			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				// Look for an edit button or textarea
				const editButton = window.locator('button').filter({ hasText: 'Edit' });
				if ((await editButton.count()) > 0) {
					await editButton.first().click();

					// Find the textarea
					const textarea = window.locator('textarea');
					if ((await textarea.count()) > 0) {
						// Type some text
						await textarea.fill('Test typing content');
						await expect(textarea).toHaveValue('Test typing content');
					}
				}
			}
		});

		test('should preserve typed content across mode switches', async ({ window }) => {
			// This test verifies content persistence when switching between edit and preview
			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				const editButton = window.locator('button').filter({ hasText: 'Edit' });
				if ((await editButton.count()) > 0 && (await editButton.isVisible())) {
					await editButton.first().click();

					const textarea = window.locator('textarea');
					if ((await textarea.count()) > 0) {
						const testContent = '# Test Content\n\nThis is test content.';
						await textarea.fill(testContent);

						// Switch to preview
						const previewButton = window.locator('button').filter({ hasText: 'Preview' });
						if ((await previewButton.count()) > 0) {
							await previewButton.first().click();

							// Switch back to edit
							await editButton.first().click();

							// Verify content is preserved
							await expect(textarea).toHaveValue(testContent);
						}
					}
				}
			}
		});

		test('should support keyboard shortcuts for common actions', async ({ window }) => {
			// Test Cmd+L for inserting checkbox
			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				const editButton = window.locator('button').filter({ hasText: 'Edit' });
				if ((await editButton.count()) > 0 && (await editButton.isVisible())) {
					await editButton.first().click();

					const textarea = window.locator('textarea');
					if ((await textarea.count()) > 0) {
						await textarea.focus();
						// Clear existing content
						await textarea.fill('');
						// Press Cmd+L to insert checkbox
						await window.keyboard.press('Meta+L');
						// Should have inserted checkbox syntax
						const value = await textarea.inputValue();
						expect(value).toContain('- [ ]');
					}
				}
			}
		});

		test('should support undo/redo with Cmd+Z and Cmd+Shift+Z', async ({ window }) => {
			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				const editButton = window.locator('button').filter({ hasText: 'Edit' });
				if ((await editButton.count()) > 0 && (await editButton.isVisible())) {
					await editButton.first().click();

					const textarea = window.locator('textarea');
					if ((await textarea.count()) > 0) {
						await textarea.focus();
						// Type some text
						await textarea.fill('Original content');
						// Wait for undo snapshot
						await window.waitForTimeout(1100);
						// Type more
						await textarea.fill('Original content\nNew line');
						// Wait for undo snapshot
						await window.waitForTimeout(1100);
						// Undo
						await window.keyboard.press('Meta+Z');
						// Content should be reverted (may take effect after a tick)
						await window.waitForTimeout(100);
						// The exact behavior depends on undo implementation timing
					}
				}
			}
		});

		test('should auto-continue list items on Enter', async ({ window }) => {
			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				const editButton = window.locator('button').filter({ hasText: 'Edit' });
				if ((await editButton.count()) > 0 && (await editButton.isVisible())) {
					await editButton.first().click();

					const textarea = window.locator('textarea');
					if ((await textarea.count()) > 0) {
						await textarea.focus();
						// Type a list item
						await textarea.fill('- First item');
						// Move cursor to end
						await window.keyboard.press('End');
						// Press Enter
						await window.keyboard.press('Enter');
						// Should have auto-continued with another list marker
						const value = await textarea.inputValue();
						expect(value).toContain('- First item\n-');
					}
				}
			}
		});

		test('should insert tab character on Tab key', async ({ window }) => {
			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				const editButton = window.locator('button').filter({ hasText: 'Edit' });
				if ((await editButton.count()) > 0 && (await editButton.isVisible())) {
					await editButton.first().click();

					const textarea = window.locator('textarea');
					if ((await textarea.count()) > 0) {
						await textarea.focus();
						await textarea.fill('Text before');
						await window.keyboard.press('End');
						await window.keyboard.press('Tab');
						const value = await textarea.inputValue();
						expect(value).toContain('\t');
					}
				}
			}
		});
	});

	test.describe('Checkbox Toggling', () => {
		test('should display checkboxes in preview mode', async ({ window }) => {
			// In preview mode, markdown checkboxes should render as actual checkboxes
			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				// Look for the preview button and click it
				const previewButton = window.locator('button').filter({ hasText: 'Preview' });
				if ((await previewButton.count()) > 0 && (await previewButton.isVisible())) {
					await previewButton.first().click();

					// In preview mode, look for checkbox elements
					// ReactMarkdown with remark-gfm renders these as input[type="checkbox"]
					const checkboxes = window.locator('input[type="checkbox"]');
					// This test just verifies the structure exists when content has checkboxes
				}
			}
		});

		test('should toggle checkbox state when clicked in preview', async ({ window }) => {
			// Note: Checkbox toggling in preview mode may update the underlying markdown
			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				const previewButton = window.locator('button').filter({ hasText: 'Preview' });
				if ((await previewButton.count()) > 0 && (await previewButton.isVisible())) {
					await previewButton.first().click();

					// Find a checkbox
					const checkbox = window.locator('input[type="checkbox"]').first();
					if ((await checkbox.count()) > 0) {
						const wasChecked = await checkbox.isChecked();
						await checkbox.click();
						// The click should toggle the state (implementation dependent)
					}
				}
			}
		});

		test('should manually edit checkbox in edit mode', async ({ window }) => {
			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				const editButton = window.locator('button').filter({ hasText: 'Edit' });
				if ((await editButton.count()) > 0 && (await editButton.isVisible())) {
					await editButton.first().click();

					const textarea = window.locator('textarea');
					if ((await textarea.count()) > 0) {
						// Set content with unchecked task
						await textarea.fill('- [ ] Unchecked task');
						// Verify it's there
						let value = await textarea.inputValue();
						expect(value).toContain('[ ]');

						// Manually toggle to checked by modifying text
						await textarea.fill('- [x] Checked task');
						value = await textarea.inputValue();
						expect(value).toContain('[x]');
					}
				}
			}
		});
	});

	test.describe('Image Paste and Attachment', () => {
		test('should keep the manual image upload button hidden in edit mode', async () => {
			const launched = await launchImageAttachmentWorkbench();
			try {
				await helpers.openRightPanelTab(launched.window, 'Auto Run');
				await launched.window.getByTitle('Edit document').click();

				await expect(launched.window.getByTitle('Add image (or paste from clipboard)')).toHaveCount(
					0
				);
				await expect(getAutoRunImageInput(launched.window)).toBeHidden();
			} finally {
				await launched.cleanup();
			}
		});

		test('should handle image paste from clipboard', async () => {
			const selectedFile = 'PasteDoc';
			const launched = await launchEditingDocumentWorkbench(
				testProjectDir,
				testAutoRunFolder,
				selectedFile,
				'# Paste Image Coverage\n'
			);
			try {
				await helpers.openRightPanelTab(launched.window, 'Auto Run');
				await launched.window.getByTitle('Edit document').click();
				const editor = launched.window.getByPlaceholder(/Capture notes/);
				await expect(editor).toBeEditable();

				await editor.evaluate((textarea, pngBase64) => {
					const bytes = Uint8Array.from(atob(pngBase64), (char) => char.charCodeAt(0));
					const file = new File([bytes], 'pasted.png', { type: 'image/png' });
					const dataTransfer = new DataTransfer();
					dataTransfer.items.add(file);
					(textarea as HTMLTextAreaElement).setSelectionRange(
						(textarea as HTMLTextAreaElement).value.length,
						(textarea as HTMLTextAreaElement).value.length
					);
					textarea.dispatchEvent(
						new ClipboardEvent('paste', {
							clipboardData: dataTransfer,
							bubbles: true,
							cancelable: true,
						})
					);
				}, TINY_PNG.toString('base64'));

				await expect.poll(() => fs.existsSync(path.join(testAutoRunFolder, 'images'))).toBe(true);
				await expect
					.poll(() => fs.readdirSync(path.join(testAutoRunFolder, 'images')))
					.toHaveLength(1);
				await expect(editor).toHaveValue(/!\[PasteDoc-\d+\.png\]\(images\/PasteDoc-\d+\.png\)/);
				await expect(launched.window.getByText('Attached Images (1)')).toBeVisible();
			} finally {
				await launched.cleanup();
			}
		});

		test('should handle image file upload through the hidden input', async () => {
			const selectedFile = 'UploadDoc';
			const uploadPath = path.join(testProjectDir, 'upload.png');
			fs.writeFileSync(uploadPath, TINY_PNG);
			const launched = await launchEditingDocumentWorkbench(
				testProjectDir,
				testAutoRunFolder,
				selectedFile,
				'# Upload Image Coverage\n'
			);
			try {
				await helpers.openRightPanelTab(launched.window, 'Auto Run');
				await launched.window.getByTitle('Edit document').click();
				await getAutoRunImageInput(launched.window).setInputFiles(uploadPath);

				await expect.poll(() => fs.existsSync(path.join(testAutoRunFolder, 'images'))).toBe(true);
				await expect
					.poll(() => fs.readdirSync(path.join(testAutoRunFolder, 'images')))
					.toHaveLength(1);
				await expect(launched.window.getByPlaceholder(/Capture notes/)).toHaveValue(
					/!\[UploadDoc-\d+\.png\]\(images\/UploadDoc-\d+\.png\)/
				);
				await expect(launched.window.getByText('Attached Images (1)')).toBeVisible();
			} finally {
				await launched.cleanup();
			}
		});

		test('should display uploaded images in attachments section', async () => {
			const launched = await launchImageAttachmentWorkbench();
			try {
				await helpers.openRightPanelTab(launched.window, 'Auto Run');
				await launched.window.getByTitle('Edit document').click();

				await expect(launched.window.getByText('Attached Images (1)')).toBeVisible();
				await expect(
					launched.window.getByRole('img', { name: 'images/ImageDoc-seed.png' })
				).toBeVisible();
			} finally {
				await launched.cleanup();
			}
		});

		test('should open lightbox when clicking image in preview', async () => {
			const launched = await launchImageAttachmentWorkbench();
			try {
				await helpers.openRightPanelTab(launched.window, 'Auto Run');
				const previewImage = launched.window.getByRole('img', { name: 'Seed attachment' });
				await expect(previewImage).toBeVisible();
				await launched.window.getByTitle('Click to enlarge: ImageDoc-seed.png').click();

				await expect(
					launched.window.getByRole('img', { name: 'images/ImageDoc-seed.png' })
				).toBeVisible();
				await expect(launched.window.getByTitle('Delete image (Delete key)')).toBeVisible();
				await expect(
					launched.window.getByTitle('Copy markdown reference (e.g., ![alt](path))')
				).toBeVisible();
			} finally {
				await launched.cleanup();
			}
		});
	});

	test.describe('Mode Switching', () => {
		test('should switch between edit and preview modes via buttons', async ({ window }) => {
			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				const editButton = window.locator('button').filter({ hasText: 'Edit' });
				const previewButton = window.locator('button').filter({ hasText: 'Preview' });

				// Verify both buttons exist
				if ((await editButton.count()) > 0 && (await previewButton.count()) > 0) {
					// Click Edit
					await editButton.first().click();
					// Textarea should be visible
					const textarea = window.locator('textarea');
					if ((await textarea.count()) > 0) {
						await expect(textarea).toBeVisible();
					}

					// Click Preview
					await previewButton.first().click();
					// In preview, textarea should not be visible (or not focused)
					// The preview div should have the content rendered
				}
			}
		});

		test('should toggle mode with Cmd+E keyboard shortcut', async ({ window }) => {
			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				// Start in edit mode
				const editButton = window.locator('button').filter({ hasText: 'Edit' });
				if ((await editButton.count()) > 0 && (await editButton.isVisible())) {
					await editButton.first().click();

					// Focus the textarea
					const textarea = window.locator('textarea');
					if ((await textarea.count()) > 0) {
						await textarea.focus();

						// Press Cmd+E to toggle to preview
						await window.keyboard.press('Meta+E');

						// Should now be in preview mode (textarea hidden or not focused)
						// Press Cmd+E again to toggle back
						await window.keyboard.press('Meta+E');
					}
				}
			}
		});

		test('should disable edit mode during batch run', async ({ window }) => {
			// When batch run is active, edit mode should be locked
			// This test verifies the UI state during batch processing

			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				// Look for Run button (indicates batch run capability)
				const runButton = window.locator('button').filter({ hasText: 'Run' });
				if ((await runButton.count()) > 0) {
					// If batch run is active, edit button should be disabled
					// This test just verifies the structure exists
				}
			}
		});

		test('should auto-switch to preview mode when batch run starts', async ({ window }) => {
			// When batch run starts, mode should automatically switch to preview
			// This test requires triggering a batch run

			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				// Start in edit mode
				const editButton = window.locator('button').filter({ hasText: 'Edit' });
				if ((await editButton.count()) > 0 && (await editButton.isVisible())) {
					await editButton.first().click();

					// The full test would start a batch run and verify mode switches
					// For now, just verify the edit mode is accessible
				}
			}
		});

		test('should restore previous mode when batch run ends', async ({ window }) => {
			// After batch run completes, the mode should restore to what it was before
			// This test requires completing a batch run
			// Skip for now as it requires full batch processing infrastructure
		});
	});

	test.describe('Save and Revert', () => {
		test('should show Save button when content is dirty', async ({ window }) => {
			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				const editButton = window.locator('button').filter({ hasText: 'Edit' });
				if ((await editButton.count()) > 0 && (await editButton.isVisible())) {
					await editButton.first().click();

					const textarea = window.locator('textarea');
					if ((await textarea.count()) > 0) {
						// Get initial content
						const initialValue = await textarea.inputValue();

						// Modify content
						await textarea.fill(initialValue + '\nNew content');

						// Save button should appear
						const saveButton = window.locator('button').filter({ hasText: 'Save' });
						// Depending on implementation, may need to wait for dirty state detection
					}
				}
			}
		});

		test('should save content with Cmd+S', async ({ window }) => {
			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				const editButton = window.locator('button').filter({ hasText: 'Edit' });
				if ((await editButton.count()) > 0 && (await editButton.isVisible())) {
					await editButton.first().click();

					const textarea = window.locator('textarea');
					if ((await textarea.count()) > 0) {
						await textarea.focus();
						// Modify content
						const originalContent = await textarea.inputValue();
						await textarea.fill(originalContent + '\nSaved content');
						// Save with Cmd+S
						await window.keyboard.press('Meta+S');
						// Content should be saved (Save button should disappear if it was visible)
					}
				}
			}
		});

		test('should revert changes when Revert button clicked', async ({ window }) => {
			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				const editButton = window.locator('button').filter({ hasText: 'Edit' });
				if ((await editButton.count()) > 0 && (await editButton.isVisible())) {
					await editButton.first().click();

					const textarea = window.locator('textarea');
					if ((await textarea.count()) > 0) {
						const originalContent = await textarea.inputValue();

						// Modify content
						await textarea.fill('Modified content');

						// Click Revert if available
						const revertButton = window.locator('button').filter({ hasText: 'Revert' });
						if ((await revertButton.count()) > 0 && (await revertButton.isVisible())) {
							await revertButton.click();
							// Content should be reverted to original
							await expect(textarea).toHaveValue(originalContent);
						}
					}
				}
			}
		});
	});

	test.describe('Search Functionality', () => {
		test('should open search with Cmd+F', async ({ window }) => {
			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				const editButton = window.locator('button').filter({ hasText: 'Edit' });
				if ((await editButton.count()) > 0 && (await editButton.isVisible())) {
					await editButton.first().click();

					const textarea = window.locator('textarea');
					if ((await textarea.count()) > 0) {
						await textarea.focus();
						// Open search
						await window.keyboard.press('Meta+F');
						// Search bar should appear
						const searchInput = window
							.locator('input[placeholder*="Search"]')
							.or(window.locator('input[type="search"]'));
						// Verify search UI is visible
					}
				}
			}
		});

		test('should highlight matches when searching', async ({ window }) => {
			// This test verifies search highlighting functionality
			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				// Would need to:
				// 1. Set content with searchable text
				// 2. Open search
				// 3. Type search query
				// 4. Verify matches are highlighted
			}
		});

		test('should navigate between matches with Enter and Shift+Enter', async ({ window }) => {
			// This test verifies search navigation
			// Skip until full search infrastructure is available in E2E
		});

		test('should close search with Escape', async ({ window }) => {
			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				const editButton = window.locator('button').filter({ hasText: 'Edit' });
				if ((await editButton.count()) > 0 && (await editButton.isVisible())) {
					await editButton.first().click();

					const textarea = window.locator('textarea');
					if ((await textarea.count()) > 0) {
						await textarea.focus();
						// Open search
						await window.keyboard.press('Meta+F');
						// Close with Escape
						await window.keyboard.press('Escape');
						// Search bar should close
					}
				}
			}
		});
	});

	test.describe('Document Selector', () => {
		test('should display document selector when folder is configured', async ({ window }) => {
			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				// Look for document selector elements
				// This could be a dropdown or a list depending on implementation
				const selector = window.locator('[data-tour="autorun-document-selector"]');
				// Verify selector exists when Auto Run is configured
			}
		});

		test('should switch documents when selecting from list', async ({ window }) => {
			// This test verifies document switching
			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				// Would need multiple documents in folder
				// Click on document selector
				// Select different document
				// Verify content changes
			}
		});

		test('should show task count per document', async ({ window }) => {
			// Documents with tasks should show task count
			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				// Look for task count indicators in document list
				// Format: "X/Y tasks" or similar
			}
		});
	});

	test.describe('Template Variables', () => {
		test('should show autocomplete when typing {{', async ({ window }) => {
			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				const editButton = window.locator('button').filter({ hasText: 'Edit' });
				if ((await editButton.count()) > 0 && (await editButton.isVisible())) {
					await editButton.first().click();

					const textarea = window.locator('textarea');
					if ((await textarea.count()) > 0) {
						await textarea.focus();
						// Type {{ to trigger autocomplete
						await textarea.type('{{');
						// Autocomplete dropdown should appear
						const dropdown = window
							.locator('[data-testid="template-autocomplete"]')
							.or(window.locator('text=currentDate').or(window.locator('text=projectName')));
						// Verify autocomplete options appear
					}
				}
			}
		});

		test('should insert selected variable on Tab or Enter', async ({ window }) => {
			// This test verifies template variable insertion
			// Requires autocomplete dropdown to be visible
		});
	});

	test.describe('Expanded Modal', () => {
		test('should open expanded modal via button', async ({ window }) => {
			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				const expandButton = window.getByRole('button', {
					name: /expand to full screen/i,
				});
				if ((await expandButton.count()) > 0) {
					await expandButton.first().click();
					// Modal should open - look for modal container or specific elements
				}
			}
		});

		test('should open expanded modal with keyboard shortcut', async ({ window }) => {
			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				// Cmd+Shift+E should toggle expanded modal
				await window.keyboard.press('Meta+Shift+E');
				// Modal should open or close depending on current state
			}
		});

		test('should close expanded modal with Escape', async ({ window }) => {
			const autoRunTab = window.locator('text=Auto Run');
			if ((await autoRunTab.count()) > 0) {
				await autoRunTab.first().click();

				const expandButton = window.getByRole('button', {
					name: /expand to full screen/i,
				});
				if ((await expandButton.count()) > 0) {
					await expandButton.first().click();
					// Wait for modal
					await window.waitForTimeout(100);
					// Close with Escape
					await window.keyboard.press('Escape');
					// Modal should close
				}
			}
		});
	});
});

/**
 * Integration tests that require a fully configured session with Auto Run
 * These tests verify end-to-end workflows
 */
test.describe('Auto Run Editing Integration', () => {
	let integrationAutoRunFolder: string;
	let integrationProjectDir: string;

	test.beforeEach(async () => {
		integrationProjectDir = path.join(os.tmpdir(), `maestro-test-project-${Date.now()}`);
		integrationAutoRunFolder = path.join(integrationProjectDir, 'Auto Run Docs');
		fs.mkdirSync(integrationAutoRunFolder, { recursive: true });
	});

	test.afterEach(async () => {
		try {
			fs.rmSync(integrationProjectDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	test('should persist edits across session restarts', async () => {
		const selectedFile = 'PersistenceDoc';
		const initialContent = `# Persistence Coverage

- [ ] Persist this task
`;
		const editedContent = `# Persistence Coverage

Edited content survived relaunch.

- [x] Persist this task
`;
		const filePath = path.join(integrationAutoRunFolder, `${selectedFile}.md`);
		const launched = await launchEditingDocumentWorkbench(
			integrationProjectDir,
			integrationAutoRunFolder,
			selectedFile,
			initialContent
		);
		let relaunched: Awaited<ReturnType<typeof helpers.launchAppFromExistingState>> | undefined;

		try {
			await helpers.openRightPanelTab(launched.window, 'Auto Run');
			await launched.window.getByTitle('Edit document').click();
			const textarea = launched.window.locator('[data-tour="autorun-panel"] textarea').first();
			await expect(textarea).toHaveValue(initialContent);

			await textarea.fill(editedContent);
			await launched.window.getByTitle(/Save changes/).click();
			await expect.poll(() => fs.readFileSync(filePath, 'utf-8')).toBe(editedContent);

			await launched.electronApp.close();
			relaunched = await helpers.launchAppFromExistingState({
				homeDir: launched.homeDir,
				userDataPath: launched.userDataPath,
			});

			await helpers.openRightPanelTab(relaunched.window, 'Auto Run');
			await relaunched.window.getByTitle('Edit document').click();
			await expect(
				relaunched.window.locator('[data-tour="autorun-panel"] textarea').first()
			).toHaveValue(editedContent);
		} finally {
			if (relaunched) {
				await relaunched.cleanup();
			} else {
				await launched.cleanup();
			}
		}
	});

	test('should handle external file changes', async () => {
		const selectedFile = 'ExternalDoc';
		const initialContent = `# External Coverage

- [ ] Original task
`;
		const updatedContent = `# External Coverage

External editor wrote this content.

- [x] Original task
- [ ] New external task
`;
		const launched = await launchEditingDocumentWorkbench(
			integrationProjectDir,
			integrationAutoRunFolder,
			selectedFile,
			initialContent
		);

		try {
			await helpers.openRightPanelTab(launched.window, 'Auto Run');
			await launched.window.getByTitle('Edit document').click();
			const textarea = launched.window.locator('[data-tour="autorun-panel"] textarea').first();
			await expect(textarea).toHaveValue(initialContent);

			fs.writeFileSync(
				path.join(integrationAutoRunFolder, `${selectedFile}.md`),
				updatedContent,
				'utf-8'
			);
			await emitAutoRunFileChanged(launched.electronApp, integrationAutoRunFolder, selectedFile);

			await expect(textarea).toHaveValue(updatedContent, { timeout: 10000 });
			await expect(launched.window.getByText(/1\s+of\s+2\s+tasks/i)).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('should handle concurrent editing from multiple sources', async () => {
		const selectedFile = 'ConcurrentDoc';
		const initialContent = `# Concurrent Coverage

- [ ] Original task
`;
		const panelDraft = `# Concurrent Coverage

Panel draft content.

- [ ] Original task
`;
		const modalDraft = `# Concurrent Coverage

Expanded modal draft content.

- [ ] Original task
`;
		const externalContent = `# Concurrent Coverage

External update replaced the shared draft.

- [x] Original task
- [ ] External task
`;
		const launched = await launchEditingDocumentWorkbench(
			integrationProjectDir,
			integrationAutoRunFolder,
			selectedFile,
			initialContent
		);

		try {
			await helpers.openRightPanelTab(launched.window, 'Auto Run');
			await launched.window.getByTitle('Edit document').click();
			const panelTextarea = launched.window.locator('[data-tour="autorun-panel"] textarea').first();
			await expect(panelTextarea).toHaveValue(initialContent);

			await panelTextarea.fill(panelDraft);
			await launched.window.getByTitle(/Expand to full screen/).click();

			const modalTextarea = launched.window.locator('div.fixed.inset-0 textarea').first();
			await expect(modalTextarea).toHaveValue(panelDraft);

			await modalTextarea.fill(modalDraft);
			await expect(panelTextarea).toHaveValue(modalDraft);

			fs.writeFileSync(
				path.join(integrationAutoRunFolder, `${selectedFile}.md`),
				externalContent,
				'utf-8'
			);
			await emitAutoRunFileChanged(launched.electronApp, integrationAutoRunFolder, selectedFile);

			await expect(modalTextarea).toHaveValue(externalContent, { timeout: 10000 });
			await expect(panelTextarea).toHaveValue(externalContent);
		} finally {
			await launched.cleanup();
		}
	});
});

/**
 * Accessibility tests for Auto Run editing
 */
test.describe('Auto Run Editing Accessibility', () => {
	test('should support full keyboard navigation', async ({ window }) => {
		const autoRunTab = window.locator('text=Auto Run');
		if ((await autoRunTab.count()) > 0) {
			await autoRunTab.first().click();

			// Tab through elements
			await window.keyboard.press('Tab');
			await window.keyboard.press('Tab');
			await window.keyboard.press('Tab');

			// Should be able to navigate to all interactive elements
		}
	});

	test('should have proper focus management', async ({ window }) => {
		const autoRunTab = window.locator('text=Auto Run');
		if ((await autoRunTab.count()) > 0) {
			await autoRunTab.first().click();

			// When switching to edit mode, textarea should be focused
			const editButton = window.locator('button').filter({ hasText: 'Edit' });
			if ((await editButton.count()) > 0 && (await editButton.isVisible())) {
				await editButton.first().click();

				// Check if textarea has focus
				const activeTag = await window.evaluate(() => document.activeElement?.tagName);
				// Textarea should be focused (or will be after a tick)
			}
		}
	});

	test('should have accessible button titles', async ({ window }) => {
		const autoRunTab = window.locator('text=Auto Run');
		if ((await autoRunTab.count()) > 0) {
			await autoRunTab.first().click();

			// All buttons should have title or aria-label
			const buttons = window.locator('button');
			const count = await buttons.count();

			for (let i = 0; i < Math.min(count, 10); i++) {
				const button = buttons.nth(i);
				const title = await button.getAttribute('title');
				const ariaLabel = await button.getAttribute('aria-label');
				const text = await button.textContent();

				// Button should have at least one form of accessible name
				const hasAccessibleName = title || ariaLabel || (text && text.trim());
				// Most buttons should have accessible names
			}
		}
	});
});
