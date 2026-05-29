/**
 * E2E Tests: seeded app shell coverage.
 *
 * These tests exercise deterministic workbench surfaces without launching a live
 * AI process.
 */
import { test, expect, helpers } from './fixtures/electron-app';
import type { Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';

function createSeededWorkbench() {
	const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-e2e-shell-'));
	const projectDir = path.join(homeDir, 'project');
	const autoRunDir = path.join(projectDir, 'Auto Run Docs');
	const previewFilePath = path.join(projectDir, 'README.md');
	const notesFilePath = path.join(projectDir, 'NOTES.md');
	const autoRunFilePath = path.join(autoRunDir, 'Phase 1.md');
	const now = Date.now();

	fs.mkdirSync(autoRunDir, { recursive: true });
	fs.writeFileSync(
		previewFilePath,
		`# File Preview Surface

Preview prose for app shell E2E coverage.
`,
		'utf-8'
	);
	fs.writeFileSync(
		notesFilePath,
		`# Notes Preview Surface

Searchable note body for file explorer coverage.
`,
		'utf-8'
	);
	fs.writeFileSync(
		autoRunFilePath,
		`# Auto Run Surface

- [ ] Auto run checklist item for shell coverage
- [x] Completed setup item
`,
		'utf-8'
	);

	return {
		homeDir,
		sessions: [
			{
				id: 'session-shell-codex',
				name: 'E2E Workbench',
				toolType: 'codex',
				state: 'idle',
				cwd: projectDir,
				fullPath: projectDir,
				projectRoot: projectDir,
				createdAt: now,
				aiLogs: [
					{
						id: 'ai-log-shell',
						timestamp: now,
						source: 'stdout',
						text: '# AI Terminal\n\nCodex seeded response is visible.',
					},
				],
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
						id: 'ai-tab-shell',
						agentSessionId: null,
						name: 'Main',
						starred: false,
						logs: [
							{
								id: 'ai-tab-log-shell',
								timestamp: now,
								source: 'stdout',
								text: '# AI Terminal\n\nCodex seeded response is visible.',
							},
						],
						inputValue: '',
						stagedImages: [],
						createdAt: now,
						state: 'idle',
					},
				],
				activeTabId: 'ai-tab-shell',
				closedTabHistory: [],
				filePreviewTabs: [
					{
						id: 'file-tab-shell',
						path: previewFilePath,
						name: 'README',
						extension: '.md',
						content: fs.readFileSync(previewFilePath, 'utf-8'),
						scrollTop: 0,
						searchQuery: '',
						editMode: false,
						createdAt: now,
						lastModified: now,
					},
				],
				activeFileTabId: 'file-tab-shell',
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-tab-shell' },
					{ type: 'file', id: 'file-tab-shell' },
				],
				unifiedClosedTabHistory: [],
				autoRunFolderPath: autoRunDir,
				autoRunSelectedFile: 'Phase 1',
				autoRunContent: fs.readFileSync(autoRunFilePath, 'utf-8'),
				autoRunContentVersion: 1,
				autoRunMode: 'preview',
				autoRunEditScrollPos: 0,
				autoRunPreviewScrollPos: 0,
				autoRunCursorPosition: 0,
			},
			{
				id: 'session-shell-terminal',
				name: 'E2E Terminal',
				toolType: 'terminal',
				state: 'idle',
				cwd: projectDir,
				fullPath: projectDir,
				projectRoot: projectDir,
				createdAt: now + 1,
				aiLogs: [],
				shellLogs: [
					{
						id: 'shell-log-terminal',
						timestamp: now,
						source: 'system',
						text: 'terminal seeded output is visible',
					},
				],
				workLog: [],
				contextUsage: 0,
				inputMode: 'terminal',
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
						id: 'terminal-tab-shell',
						agentSessionId: null,
						name: 'Terminal',
						starred: false,
						logs: [],
						inputValue: '',
						stagedImages: [],
						createdAt: now,
						state: 'idle',
					},
				],
				activeTabId: 'terminal-tab-shell',
				closedTabHistory: [],
				filePreviewTabs: [],
				activeFileTabId: null,
				unifiedTabOrder: [{ type: 'ai', id: 'terminal-tab-shell' }],
				unifiedClosedTabHistory: [],
			},
		],
	};
}

async function openSettings(window: Page) {
	await window.keyboard.press('Meta+,');
	const settingsDialog = window.getByRole('dialog', { name: 'Settings' });
	await expect(settingsDialog).toBeVisible();
	return settingsDialog;
}

test.describe('App shell seeded workbench', () => {
	let window: Page;
	let cleanupApp: (() => Promise<void>) | undefined;

	test.beforeEach(async () => {
		const seeded = createSeededWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});
		window = launched.window;
		cleanupApp = launched.cleanup;
	});

	test.afterEach(async () => {
		await cleanupApp?.();
		cleanupApp = undefined;
	});

	test('renders the persisted workbench regions', async () => {
		await expect(window.getByText('E2E Workbench').first()).toBeVisible();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
		await expect(window.locator('[data-tour="files-tab"]')).toBeVisible();
		await expect(window.locator('[data-tour="history-tab"]')).toBeVisible();
		await expect(window.locator('[data-tour="autorun-tab"]')).toBeVisible();
		await expect(window.locator('[data-tour="files-panel"]')).toBeVisible();
		await expect(window.getByTitle(/Show dotfiles|Hide dotfiles/)).toBeVisible();
		await expect(window.getByTitle(/Auto-refresh every|Refresh file tree/)).toBeVisible();
		await expect(window.getByTitle('Expand all folders')).toBeVisible();
		await expect(window.getByTitle('Collapse all folders')).toBeVisible();
	});

	test('switches right-panel tabs while keeping the active file preview visible', async () => {
		await helpers.openRightPanelTab(window, 'History');
		await expect(window.locator('[data-tour="history-panel"]')).toBeVisible();

		await helpers.openRightPanelTab(window, 'Auto Run');
		await expect(window.getByText('Auto Run Surface')).toBeVisible();
		await expect(window.getByText('Auto run checklist item for shell coverage')).toBeVisible();
		await expect(window.locator('button[title^="Expand to full screen"]')).toBeVisible();
		await expect(window.getByTitle('Edit document')).toBeVisible();
		await expect(window.getByTitle('Preview document')).toBeVisible();
		await expect(window.getByRole('button', { name: /^Run$/ })).toBeVisible();
		await expect(window.getByTitle('Launch In-Tab Wizard')).toBeVisible();

		await helpers.openRightPanelTab(window, 'Files');
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('opens and closes settings and Auto Run guide modals', async () => {
		await window.keyboard.press('Meta+,');
		const settingsDialog = window.getByRole('dialog', { name: 'Settings' });
		await expect(settingsDialog).toBeVisible();
		await expect(settingsDialog.locator('button[title="General"]')).toBeVisible();
		await expect(settingsDialog.locator('button[title="Display"]')).toBeVisible();
		await window.keyboard.press('Escape');
		await expect(settingsDialog).toBeHidden();

		await helpers.openRightPanelTab(window, 'Auto Run');
		await window.getByTitle('Learn about Auto Runner').click();
		const guideDialog = window.getByRole('dialog', { name: 'Auto Run Guide' });
		await expect(guideDialog).toBeVisible();
		await expect(guideDialog.getByText('Document Format')).toBeVisible();
		await guideDialog.getByRole('button', { name: 'Got it' }).click();
		await expect(guideDialog).toBeHidden();
	});

	test('toggles the markdown file preview between preview and edit modes', async () => {
		await expect(window.getByText('Preview prose for app shell E2E coverage.')).toBeVisible();
		await window.locator('button[title^="Edit file"]').click();
		await expect(window.locator('textarea').first()).toHaveValue(/Preview prose for app shell E2E/);

		await window.locator('button[title^="Show preview"]').click();
		await expect(window.getByText('Preview prose for app shell E2E coverage.')).toBeVisible();
	});

	test('switches between seeded Codex and Terminal agents from the Left Bar', async () => {
		await window.getByText('E2E Terminal').click();
		await expect(window.getByText('terminal seeded output is visible')).toBeVisible();

		await window.getByText('E2E Workbench').click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
		await expect(window.getByText('Preview prose for app shell E2E coverage.')).toBeVisible();
	});

	test('switches between AI and file tabs in the TabBar', async () => {
		await window.getByText('Main', { exact: true }).click();
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();

		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('filters and selects a file tab from the Tab Switcher', async () => {
		await window.getByText('Main', { exact: true }).click();
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();

		await window.getByTitle(/Search tabs/).click();
		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		await expect(switcher).toBeVisible();
		await expect(switcher.getByRole('button', { name: /Open Tabs \(2\)/ })).toBeVisible();

		await switcher.getByPlaceholder('Search open tabs...').fill('README');
		await switcher.getByRole('button', { name: /README/ }).click();

		await expect(switcher).toBeHidden();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('expands and collapses folders in the File Explorer', async () => {
		await helpers.openRightPanelTab(window, 'Files');
		await window.getByTitle('Expand all folders').click();
		await expect(window.getByText('Phase 1.md')).toBeVisible();

		await window.getByTitle('Collapse all folders').click();
		await expect(window.getByText('Phase 1.md')).toBeHidden();
	});

	test('opens a markdown file from the File Explorer into preview', async () => {
		await helpers.openRightPanelTab(window, 'Files');
		await window.getByText('NOTES.md').dblclick();

		await expect(window.getByText('Notes Preview Surface')).toBeVisible();
		await expect(
			window.getByText('Searchable note body for file explorer coverage.')
		).toBeVisible();
	});

	test('searches within the active file preview and closes search with Escape', async () => {
		await window.getByTestId('file-preview-root').press('Control+f');
		const searchInput = window.getByPlaceholder(/Search in file/);
		await expect(searchInput).toBeVisible();

		await searchInput.fill('Preview prose');
		await expect(window.getByText('1/1')).toBeVisible();
		await expect(window.getByTitle('Next match (Enter)')).toBeVisible();

		await searchInput.press('Escape');
		await expect(searchInput).toBeHidden();
	});

	test('navigates core Settings tabs', async () => {
		const settingsDialog = await openSettings(window);

		await settingsDialog.locator('button[title="Display"]').click();
		await expect(settingsDialog.getByText('Font Size')).toBeVisible();

		await settingsDialog.locator('button[title="Shortcuts"]').click();
		await expect(settingsDialog.getByPlaceholder('Filter shortcuts...')).toBeVisible();

		await settingsDialog.locator('button[title="Themes"]').click();
		await expect(settingsDialog.getByRole('group', { name: 'Theme picker' })).toBeVisible();

		await settingsDialog.locator('button[title="Encore Features"]').click();
		await expect(settingsDialog.getByText("Director's Notes")).toBeVisible();
	});

	test('filters shortcuts inside Settings', async () => {
		const settingsDialog = await openSettings(window);
		await settingsDialog.locator('button[title="Shortcuts"]').click();

		const shortcutFilter = settingsDialog.getByPlaceholder('Filter shortcuts...');
		await shortcutFilter.fill('tab');

		await expect(settingsDialog.getByText('AI Tab')).toBeVisible();
		await expect(settingsDialog.getByText(/\d+ \/ \d+/)).toBeVisible();
	});

	test('persists the file explorer icon theme setting from Display settings', async () => {
		const settingsDialog = await openSettings(window);
		await settingsDialog.locator('button[title="Display"]').click();

		await settingsDialog.getByRole('button', { name: 'Rich' }).click();
		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					return await window.maestro.settings.get('fileExplorerIconTheme');
				});
			})
			.toBe('rich');
	});
});
