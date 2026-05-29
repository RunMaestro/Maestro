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
		],
	};
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
});
