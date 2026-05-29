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
	const idSuffix = `${now}-${Math.random().toString(36).slice(2)}`;
	const codexSessionId = `session-shell-codex-${idSuffix}`;
	const terminalSessionId = `session-shell-terminal-${idSuffix}`;
	const aiTabId = `ai-tab-shell-${idSuffix}`;
	const fileTabId = `file-tab-shell-${idSuffix}`;
	const terminalTabId = `terminal-tab-shell-${idSuffix}`;

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
				id: codexSessionId,
				name: 'E2E Workbench',
				toolType: 'codex',
				state: 'idle',
				cwd: projectDir,
				fullPath: projectDir,
				projectRoot: projectDir,
				createdAt: now,
				aiLogs: [
					{
						id: `ai-log-shell-${idSuffix}`,
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
						id: aiTabId,
						agentSessionId: null,
						name: 'Main',
						starred: false,
						logs: [
							{
								id: `ai-tab-log-shell-${idSuffix}`,
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
				activeTabId: aiTabId,
				closedTabHistory: [],
				filePreviewTabs: [
					{
						id: fileTabId,
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
				activeFileTabId: fileTabId,
				unifiedTabOrder: [
					{ type: 'ai', id: aiTabId },
					{ type: 'file', id: fileTabId },
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
				id: terminalSessionId,
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
						id: `shell-log-terminal-${idSuffix}`,
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
						id: terminalTabId,
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
				activeTabId: terminalTabId,
				closedTabHistory: [],
				filePreviewTabs: [],
				activeFileTabId: null,
				unifiedTabOrder: [{ type: 'ai', id: terminalTabId }],
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

async function openQuickActions(window: Page) {
	await window.keyboard.press('Meta+K');
	const quickActionsDialog = window.getByRole('dialog', { name: 'Quick Actions' });
	await expect(quickActionsDialog).toBeVisible();
	await expect(
		quickActionsDialog.getByPlaceholder('Type a command or jump to agent...')
	).toBeVisible();
	return quickActionsDialog;
}

async function seedHistoryEntries(window: Page, projectPath: string, sessionId: string) {
	const now = Date.now();

	await window.evaluate(
		async ({ projectPath, sessionId, now }) => {
			const existingEntries = await window.maestro.history.getAll(undefined, sessionId);
			for (const entry of existingEntries) {
				await window.maestro.history.delete(entry.id, sessionId);
			}

			const entries = [
				{
					id: 'history-auto-failure',
					type: 'AUTO' as const,
					timestamp: now - 120_000,
					summary: 'Failed generated docs sync',
					fullResponse:
						'Detailed failure transcript includes a recoverable generated docs sync error.',
					projectPath,
					sessionId,
					sessionName: 'E2E Workbench',
					agentSessionId: 'codex-history-failure',
					success: false,
					elapsedTimeMs: 42_000,
				},
				{
					id: 'history-auto-success',
					type: 'AUTO' as const,
					timestamp: now - 60_000,
					summary: 'Completed Auto Run setup checklist',
					fullResponse: 'Detailed Auto Run transcript mentions Phase 1.md and setup validation.',
					projectPath,
					sessionId,
					sessionName: 'E2E Workbench',
					agentSessionId: 'codex-history-success',
					success: true,
					validated: false,
					elapsedTimeMs: 62_000,
					usageStats: {
						inputTokens: 1200,
						outputTokens: 450,
						cacheReadInputTokens: 100,
						cacheCreationInputTokens: 50,
						totalCostUsd: 0.03,
						contextWindow: 128000,
					},
				},
				{
					id: 'history-user-note',
					type: 'USER' as const,
					timestamp: now,
					summary: 'Manual note captured for project review',
					fullResponse: 'Manual detail includes NOTES.md and a follow-up checklist.',
					projectPath,
					sessionId,
					sessionName: 'E2E Workbench',
					agentSessionId: 'codex-history-user',
				},
			];

			for (const entry of entries) {
				await window.maestro.history.add(entry);
			}
		},
		{ projectPath, sessionId, now }
	);
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
		await seedHistoryEntries(window, seeded.sessions[0].cwd, seeded.sessions[0].id);
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

	test('renders seeded History entries and type filters', async () => {
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');

		await expect(historyPanel.getByText('Manual note captured for project review')).toBeVisible();
		await expect(historyPanel.getByText('Completed Auto Run setup checklist')).toBeVisible();
		await expect(historyPanel.getByText('Failed generated docs sync')).toBeVisible();

		await historyPanel.getByRole('button', { name: /AUTO/ }).click();
		await expect(historyPanel.getByText('Completed Auto Run setup checklist')).toBeHidden();
		await expect(historyPanel.getByText('Manual note captured for project review')).toBeVisible();

		await historyPanel.getByRole('button', { name: /USER/ }).click();
		await expect(historyPanel.getByText('No entries match the selected filters.')).toBeVisible();
	});

	test('searches History entries with the keyboard filter', async () => {
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');
		await expect(historyPanel.getByText('Manual note captured for project review')).toBeVisible();

		await historyPanel.locator('[tabindex="0"]').focus();
		await window.keyboard.press('Control+f');
		const historyFilter = historyPanel.getByPlaceholder('Filter history...');
		await expect(historyFilter).toBeVisible();

		await historyFilter.fill('manual');
		await expect(historyPanel.getByText('1 result')).toBeVisible();
		await expect(historyPanel.getByText('Manual note captured for project review')).toBeVisible();
		await expect(historyPanel.getByText('Completed Auto Run setup checklist')).toBeHidden();

		await historyFilter.press('Escape');
		await expect(historyFilter).toBeHidden();
	});

	test('opens History detail and toggles validation state', async () => {
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');
		await historyPanel.getByText('Completed Auto Run setup checklist').first().click();

		await expect(window.getByText(/Detailed Auto Run transcript/)).toBeVisible();
		await expect(window.getByTitle('Mark as human-validated')).toBeVisible();

		await window.getByTitle('Mark as human-validated').click();
		await expect(window.getByTitle('Mark as not validated')).toBeVisible();
		await expect(window.getByText('$0.03').last()).toBeVisible();

		await window.getByRole('button', { name: 'Close', exact: true }).click();
		await expect(window.getByText(/Detailed Auto Run transcript/)).toBeHidden();
	});

	test('opens and closes the History panel guide', async () => {
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');

		await historyPanel.getByTitle('History panel help').click();
		const guideDialog = window.getByRole('dialog', { name: 'History Panel Guide' });
		await expect(guideDialog).toBeVisible();
		await expect(guideDialog.getByText('Entry Types')).toBeVisible();

		await guideDialog.getByRole('button', { name: 'Got it' }).click();
		await expect(guideDialog).toBeHidden();
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

	test('filters Quick Actions and opens Shortcuts Help', async () => {
		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('View Shortcuts');
		await quickActionsDialog.getByRole('button', { name: /View Shortcuts/ }).click();

		await expect(quickActionsDialog).toBeHidden();
		const shortcutsDialog = window.getByRole('dialog', { name: 'Keyboard Shortcuts' });
		await expect(shortcutsDialog).toBeVisible();
		const shortcutSearch = shortcutsDialog.getByPlaceholder('Search shortcuts...');
		await shortcutSearch.fill('tab');
		await expect(shortcutsDialog.getByText(/\d+ \/ \d+/).first()).toBeVisible();
		await expect(shortcutsDialog.getByText('Tab Switcher')).toBeVisible();
	});

	test('opens About Maestro from Quick Actions', async () => {
		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('About Maestro');
		await quickActionsDialog.getByRole('button', { name: /About Maestro/ }).click();

		await expect(quickActionsDialog).toBeHidden();
		const aboutDialog = window.getByRole('dialog', { name: 'About Maestro' });
		await expect(aboutDialog).toBeVisible();
		await expect(aboutDialog.getByRole('heading', { name: 'About Maestro' })).toBeVisible();
		await expect(aboutDialog.getByTitle('Documentation')).toBeVisible();
	});

	test('opens the Tab Switcher from Quick Actions', async () => {
		await window.getByText('Main', { exact: true }).click();
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Tab Switcher');
		await quickActionsDialog.getByRole('button', { name: /Tab Switcher/ }).click();

		await expect(quickActionsDialog).toBeHidden();
		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		await expect(switcher).toBeVisible();
		await switcher.getByPlaceholder('Search open tabs...').fill('README');
		await expect(switcher.getByRole('button', { name: /README/ })).toBeVisible();
	});

	test('opens Settings from Quick Actions', async () => {
		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Settings');
		await quickActionsDialog.getByRole('button', { name: /Settings/ }).click();

		await expect(quickActionsDialog).toBeHidden();
		const settingsDialog = window.getByRole('dialog', { name: 'Settings' });
		await expect(settingsDialog).toBeVisible();
		await expect(settingsDialog.locator('button[title="General"]')).toBeVisible();
	});

	test('opens the System Log Viewer from Quick Actions', async () => {
		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('View System Logs');
		await quickActionsDialog.getByRole('button', { name: /View System Logs/ }).click();

		await expect(quickActionsDialog).toBeHidden();
		const logViewer = window.getByRole('dialog', { name: 'System Log Viewer' });
		await expect(logViewer).toBeVisible();
		await expect(logViewer.getByText('Maestro System Logs')).toBeVisible();
		await expect(logViewer.getByRole('button', { name: 'ALL', exact: true })).toBeVisible();

		await logViewer.getByTitle('Close log viewer').click();
		await expect(logViewer).toBeHidden();
	});

	test('opens the System Processes monitor from Quick Actions', async () => {
		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('View System Processes');
		await quickActionsDialog.getByRole('button', { name: /View System Processes/ }).click();

		await expect(quickActionsDialog).toBeHidden();
		const processMonitor = window.getByRole('dialog', { name: 'System Processes' });
		await expect(processMonitor).toBeVisible();
		await expect(processMonitor.getByText('System Processes')).toBeVisible();
		await expect(processMonitor.getByTitle('Refresh (R)')).toBeVisible();
		await expect(processMonitor.getByText(/2 sessions.*0 groups/)).toBeVisible();

		await processMonitor.getByTitle('Close (Esc)').click();
		await expect(processMonitor).toBeHidden();
	});

	test('shows an empty state for unmatched Quick Actions searches', async () => {
		const quickActionsDialog = await openQuickActions(window);
		const commandSearch = quickActionsDialog.getByPlaceholder('Type a command or jump to agent...');

		await commandSearch.fill('definitely missing command');
		await expect(quickActionsDialog.getByText('No actions found')).toBeVisible();

		await window.keyboard.press('Escape');
		await expect(quickActionsDialog).toBeHidden();
	});

	test('expands and collapses folders in the File Explorer', async () => {
		await helpers.openRightPanelTab(window, 'Files');
		await expect(window.getByText('NOTES.md')).toBeVisible();
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
