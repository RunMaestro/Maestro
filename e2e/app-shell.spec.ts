/**
 * E2E Tests: seeded app shell coverage.
 *
 * These tests exercise deterministic workbench surfaces without launching a live
 * AI process.
 */
import { test, expect, helpers } from './fixtures/electron-app';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';

function createSeededWorkbench() {
	const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-e2e-shell-'));
	const projectDir = path.join(homeDir, 'project');
	const autoRunDir = path.join(projectDir, 'Auto Run Docs');
	const previewFilePath = path.join(projectDir, 'README.md');
	const notesFilePath = path.join(projectDir, 'NOTES.md');
	const metricsFilePath = path.join(projectDir, 'metrics.csv');
	const binaryFilePath = path.join(projectDir, 'artifact.bin');
	const imageFilePath = path.join(projectDir, 'diagram.png');
	const mermaidFilePath = path.join(projectDir, 'FLOW.md');
	const largeFilePath = path.join(projectDir, 'large-log.txt');
	const hiddenFilePath = path.join(projectDir, '.env.example');
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

See [[NOTES]] and [Phase 1](Auto Run Docs/Phase 1.md).
External reference: https://example.com/maestro-graph

- [ ] Graph task still open
- [x] Graph task already complete
`,
		'utf-8'
	);
	fs.writeFileSync(
		notesFilePath,
		`# Notes Preview Surface

Searchable note body for file explorer coverage.

Backlink to [[README]] for document graph coverage.
`,
		'utf-8'
	);
	fs.writeFileSync(
		metricsFilePath,
		`scenario,duration,passed
app shell,2.4,true
prompt composer,2.3,true
`,
		'utf-8'
	);
	fs.writeFileSync(binaryFilePath, Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]));
	fs.writeFileSync(
		imageFilePath,
		Buffer.from(
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
			'base64'
		)
	);
	fs.writeFileSync(
		mermaidFilePath,
		`# Mermaid Preview Surface

\`\`\`mermaid
flowchart TD
    Start([Start]) --> Review{Review}
    Review -->|pass| Finish([Finish])
\`\`\`
`,
		'utf-8'
	);
	fs.writeFileSync(
		largeFilePath,
		[
			'large file head marker',
			...Array.from(
				{ length: 3500 },
				(_, index) => `line-${String(index).padStart(4, '0')} file preview truncation coverage`
			),
			'large file tail marker',
		].join('\n'),
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
	fs.writeFileSync(hiddenFilePath, 'MAESTRO_E2E_HIDDEN_FILE=true\n', 'utf-8');

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
						agentSessionId: 'thread_e2e_tab_seed',
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
					{
						id: `shell-log-user-${idSuffix}`,
						timestamp: now + 1,
						source: 'user',
						text: 'printf "terminal filter needle\\nterminal filter haystack\\n"',
					},
					{
						id: `shell-log-stdout-${idSuffix}`,
						timestamp: now + 2,
						source: 'stdout',
						text: 'terminal filter needle\nterminal filter haystack\nterminal search sentinel',
					},
					{
						id: `shell-log-stderr-${idSuffix}`,
						timestamp: now + 3,
						source: 'stderr',
						text: 'terminal stderr sentinel',
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
				shellCommandHistory: [
					'git status --short',
					'npm test -- --runInBand',
					'echo terminal history sentinel',
				],
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

async function closeQuickActions(window: Page, quickActionsDialog: Locator) {
	for (let attempt = 0; attempt < 5; attempt++) {
		if (!(await quickActionsDialog.isVisible().catch(() => false))) return;
		await window.keyboard.press('Escape');
		await window.waitForTimeout(100);
	}

	await expect(quickActionsDialog).toBeHidden();
}

async function getFileTreeRow(window: Page, name: string) {
	const row = window.locator('[data-file-index]').filter({ hasText: name }).first();
	await expect(row).toBeVisible();
	return row;
}

async function openFileContextMenu(window: Page, name: string) {
	await helpers.openRightPanelTab(window, 'Files');
	const row = await getFileTreeRow(window, name);
	await row.click({ button: 'right' });
	const contextMenu = window.locator('.fixed').filter({
		has: window.getByRole('button', { name: 'Copy Path' }),
	});
	await expect(contextMenu.getByRole('button', { name: 'Copy Path' })).toBeVisible();
	return contextMenu;
}

async function openSeededTerminalAgent(window: Page) {
	await window.getByText('E2E Terminal').click();
	await expect(window.getByLabel('Terminal output')).toBeVisible();
	return window.getByPlaceholder('Run shell command...');
}

async function openDocumentGraphFromPreview(window: Page) {
	await window.getByTitle('View in Document Graph (⌘ ⇧ G)').click();
	const graphDialog = window.getByRole('dialog', { name: 'Document Graph' });
	await expect(graphDialog).toBeVisible({ timeout: 15000 });
	await expect(graphDialog.getByText(/2 documents/)).toBeVisible({ timeout: 15000 });
	return graphDialog;
}

async function openDirectorNotesFromQuickActions(window: Page) {
	const quickActionsDialog = await openQuickActions(window);
	await quickActionsDialog
		.getByPlaceholder('Type a command or jump to agent...')
		.fill("Director's Notes");
	await quickActionsDialog.getByRole('button', { name: /Director's Notes/ }).click();

	await expect(quickActionsDialog).toBeHidden();
	const directorNotesDialog = window.getByRole('dialog', { name: "Director's Notes" });
	await expect(directorNotesDialog).toBeVisible();
	return directorNotesDialog;
}

async function openPromptComposer(window: Page) {
	await window.getByText('Main', { exact: true }).click();
	await expect(window.getByTitle('Send message')).toBeVisible();
	await window.getByTitle(/Open Prompt Composer/).click();
	await expect(window.getByText('Prompt Composer')).toBeVisible();
	const composerInput = window.getByPlaceholder(/Write your prompt here/);
	await expect(composerInput).toBeVisible();
	return composerInput;
}

async function stubDirectorNotesSynopsis(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		ipcMain.removeHandler('director-notes:generateSynopsis');
		ipcMain.handle('director-notes:generateSynopsis', async () => ({
			success: true,
			synopsis:
				'# Seeded Director Synopsis\n\nCodex-only deterministic synopsis for seeded history entries.',
			generatedAt: Date.now(),
			stats: {
				agentCount: 1,
				entryCount: 3,
				durationMs: 0,
			},
		}));
	});
}

async function closeDocumentGraph(window: Page) {
	await window
		.getByRole('dialog', { name: 'Document Graph' })
		.getByTitle('Close (Esc)')
		.first()
		.click();
	const closeDialog = window.getByRole('dialog', { name: 'Close Document Graph?' });
	await expect(closeDialog).toBeVisible();
	await closeDialog.getByRole('button', { name: 'Close Graph' }).click();
	await expect(window.getByRole('dialog', { name: 'Document Graph' })).toBeHidden();
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
	let electronApp: ElectronApplication;
	let cleanupApp: (() => Promise<void>) | undefined;

	test.beforeEach(async () => {
		const seeded = createSeededWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
			settings: {
				encoreFeatures: {
					directorNotes: true,
				},
				directorNotesSettings: {
					provider: '__maestro-e2e-disabled__',
					defaultLookbackDays: 7,
				},
			},
		});
		window = launched.window;
		electronApp = launched.electronApp;
		cleanupApp = launched.cleanup;
		await stubDirectorNotesSynopsis(electronApp);
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

	test('navigates History detail entries with Prev and Next controls', async () => {
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');
		await historyPanel.getByText('Completed Auto Run setup checklist').first().click();

		await expect(window.getByText(/Detailed Auto Run transcript/)).toBeVisible();
		await window.getByRole('button', { name: 'Prev' }).click();
		await expect(window.getByText(/Manual detail includes NOTES.md/)).toBeVisible();

		await window.getByRole('button', { name: 'Next' }).click();
		await expect(window.getByText(/Detailed Auto Run transcript/)).toBeVisible();
	});

	test('deletes a History entry from the detail modal after confirmation', async () => {
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');
		await historyPanel.getByText('Failed generated docs sync').first().click();

		await expect(window.getByText(/Detailed failure transcript/)).toBeVisible();
		await window.getByTitle('Delete this history entry').click();
		const cancelConfirm = window
			.locator('.fixed')
			.filter({ hasText: 'Delete History Entry' })
			.last();
		await expect(cancelConfirm.getByText('Delete History Entry')).toBeVisible();

		await cancelConfirm.getByRole('button', { name: 'Cancel' }).click();
		await expect(window.getByText(/Detailed failure transcript/)).toBeVisible();

		await window.getByTitle('Delete this history entry').click();
		const deleteConfirm = window
			.locator('.fixed')
			.filter({ hasText: 'Delete History Entry' })
			.last();
		await deleteConfirm.getByRole('button', { name: 'Delete' }).click();

		await expect(window.getByText(/Detailed failure transcript/)).toBeHidden();
		await expect(historyPanel.getByText('Failed generated docs sync')).toBeHidden();
	});

	test('changes the History activity graph lookback from its context menu', async () => {
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');
		const activityGraph = historyPanel.locator('[title*="All time"]').first();

		await expect(activityGraph).toBeVisible();
		await activityGraph.click({ button: 'right' });
		await expect(window.getByText('Lookback Period')).toBeVisible();

		await window.getByRole('button', { name: '24 hours' }).click();
		await expect(historyPanel.locator('[title*="24 hours: 2 auto, 1 user"]')).toBeVisible();
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
		await openSeededTerminalAgent(window);
		await expect(window.getByText('terminal seeded output is visible')).toBeVisible();

		await window.getByText('E2E Workbench').click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
		await expect(window.getByText('Preview prose for app shell E2E coverage.')).toBeVisible();
	});

	test('renders seeded command terminal transcript and input chrome', async () => {
		const terminalInput = await openSeededTerminalAgent(window);

		await expect(window.getByText('terminal seeded output is visible')).toBeVisible();
		await expect(window.getByText('terminal search sentinel')).toBeVisible();
		await expect(window.getByText('terminal stderr sentinel')).toBeVisible();
		await expect(terminalInput).toBeVisible();
		await expect(window.getByTitle('Run command (Enter)')).toBeVisible();
	});

	test('searches command terminal output with the output search overlay', async () => {
		await openSeededTerminalAgent(window);
		await window.getByLabel('Terminal output').press('Control+f');

		const searchInput = window.getByPlaceholder('Search output... (Esc to close)');
		await expect(searchInput).toBeVisible();
		await searchInput.fill('stderr sentinel');
		await expect(window.locator('[data-log-index="3"]').getByText(/stderr sentinel/)).toBeVisible();
		await expect(window.getByText('terminal search sentinel')).toBeHidden();

		await searchInput.press('Escape');
		await expect(searchInput).toBeHidden();
	});

	test('filters a single command terminal output block', async () => {
		await openSeededTerminalAgent(window);

		const outputBlock = window.locator('[data-log-index="2"]');
		await outputBlock.hover();
		await outputBlock.getByTitle('Filter this output').click();
		await outputBlock.getByPlaceholder('Include by keyword').fill('needle');

		await expect(outputBlock.getByText('terminal filter needle')).toBeVisible();
		await expect(outputBlock.getByText('terminal filter haystack')).toBeHidden();
	});

	test('selects command history entries from the terminal input', async () => {
		const terminalInput = await openSeededTerminalAgent(window);

		await terminalInput.focus();
		await terminalInput.press('ArrowUp');
		const historyFilter = window.getByPlaceholder('Filter commands...');
		await expect(historyFilter).toBeVisible();
		await expect(window.getByText('echo terminal history sentinel')).toBeVisible();

		await historyFilter.fill('status');
		await expect(window.getByText('git status --short')).toBeVisible();
		await expect(window.getByText('npm test -- --runInBand')).toBeHidden();
		await historyFilter.press('Enter');
		await expect(historyFilter).toBeHidden();
		await expect(terminalInput).toHaveValue('git status --short');
	});

	test('switches between AI and file tabs in the TabBar', async () => {
		await window.getByText('Main', { exact: true }).click();
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();

		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('shows file tab hover actions from the TabBar overlay', async () => {
		const readmeTab = window.locator('[data-tab-id]').filter({ hasText: 'README' }).first();

		await readmeTab.hover();
		await expect(window.getByText('Copy File Name')).toBeVisible({ timeout: 2000 });
		await expect(window.getByText('Open in Default App')).toBeVisible();
		await expect(window.getByRole('button', { name: 'Close Tab', exact: true })).toBeVisible();

		await window.getByText('Copy File Name').click();
		await expect(window.getByText('Copied!')).toBeVisible();
	});

	test('closes and reopens a file tab with keyboard shortcuts', async () => {
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		await window.keyboard.press('Meta+W');
		await expect(window.getByText('File Preview Surface')).toBeHidden();
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();

		await window.keyboard.press('Meta+Shift+T');
		await expect(window.getByText('File Preview Surface')).toBeVisible();
		await expect(window.getByText('README', { exact: true })).toBeVisible();
	});

	test('shows AI tab hover session actions and toggles tab status', async () => {
		const mainTab = window.locator('[data-tab-id]').filter({ hasText: 'Main' }).first();

		await mainTab.hover();
		await expect(window.getByText('Copy Session ID')).toBeVisible();
		await expect(window.getByText('Star Session')).toBeVisible();
		await expect(window.getByText('Rename Tab')).toBeVisible();
		await expect(window.getByText('Mark as Unread')).toBeVisible();

		await window.getByText('Copy Session ID').click();
		await expect(window.getByText('Copied!')).toBeVisible();

		await window.getByText('Star Session').click();
		await expect(window.getByText('Unstar Session')).toBeVisible();

		await window.getByText('Mark as Unread').click();
		await expect(window.getByTitle('New messages')).toBeVisible();
	});

	test('renames an AI tab from the TabBar hover overlay', async () => {
		const mainTab = window.locator('[data-tab-id]').filter({ hasText: 'Main' }).first();

		await mainTab.hover();
		await window.getByText('Rename Tab').click();

		const renameDialog = window.getByRole('dialog', { name: 'Rename Tab' });
		await expect(renameDialog).toBeVisible();
		await renameDialog.locator('input').fill('Renamed Main');
		await renameDialog.getByRole('button', { name: 'Rename' }).click();

		await expect(renameDialog).toBeHidden();
		await expect(
			window.locator('[data-tab-id]').filter({ hasText: 'Renamed Main' }).first()
		).toBeVisible();
	});

	test('creates and closes a new AI tab from the TabBar', async () => {
		const tabRows = window.locator('[data-tab-id]');
		const initialTabCount = await tabRows.count();

		await window.getByTitle(/New tab/).click();
		await expect(tabRows).toHaveCount(initialTabCount + 1);
		await expect(
			window.locator('[data-tab-id]').filter({ hasText: 'New Session' }).first()
		).toBeVisible();

		await window.keyboard.press('Meta+W');
		await expect(tabRows).toHaveCount(initialTabCount);
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

	test('opens targeted Settings sections from Quick Actions', async () => {
		let quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Change Theme');
		await quickActionsDialog.getByRole('button', { name: /Change Theme/ }).click();

		let settingsDialog = window.getByRole('dialog', { name: 'Settings' });
		await expect(settingsDialog).toBeVisible();
		await expect(settingsDialog.getByRole('group', { name: 'Theme picker' })).toBeVisible();
		await window.keyboard.press('Escape');
		await expect(settingsDialog).toBeHidden();

		quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Configure Global Environment Variables');
		await quickActionsDialog
			.getByRole('button', { name: /Configure Global Environment Variables/ })
			.click();

		settingsDialog = window.getByRole('dialog', { name: 'Settings' });
		await expect(settingsDialog).toBeVisible();
		await expect(settingsDialog.getByText('Global Environment Variables')).toBeVisible();
		await expect(settingsDialog.getByText('System Log Level')).toBeVisible();
	});

	test('creates a group from Quick Actions', async () => {
		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Create New Group');
		await quickActionsDialog.getByRole('button', { name: /Create New Group/ }).click();

		await expect(quickActionsDialog).toBeHidden();
		const createGroupDialog = window.getByRole('dialog', { name: 'Create New Group' });
		await expect(createGroupDialog).toBeVisible();
		await createGroupDialog.getByLabel('Group Name').fill('review lane');
		await createGroupDialog.getByRole('button', { name: 'Create' }).click();

		await expect(createGroupDialog).toBeHidden();
		await expect(window.getByText('REVIEW LANE')).toBeVisible();
	});

	test('opens fuzzy file search from Quick Actions and selects a markdown file', async () => {
		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Fuzzy File Search');
		await quickActionsDialog.getByRole('button', { name: /Fuzzy File Search/ }).click();

		await expect(quickActionsDialog).toBeHidden();
		const fileSearchDialog = window.getByRole('dialog', { name: 'Fuzzy File Search' });
		await expect(fileSearchDialog).toBeVisible();
		await fileSearchDialog.getByPlaceholder('Search files...').fill('notes');
		await expect(fileSearchDialog.getByText('NOTES.md')).toBeVisible();
		await fileSearchDialog.getByText('NOTES.md').click();

		await expect(fileSearchDialog).toBeHidden();
		await expect(window.getByText('Notes Preview Surface')).toBeVisible();
	});

	test('navigates Right Bar tabs from Quick Actions', async () => {
		let quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Go to Auto Run Tab');
		await quickActionsDialog.getByRole('button', { name: /Go to Auto Run Tab/ }).click();

		await expect(quickActionsDialog).toBeHidden();
		await expect(window.getByText('Auto Run Surface')).toBeVisible();

		quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Go to History Tab');
		await quickActionsDialog.getByRole('button', { name: /Go to History Tab/ }).click();

		await expect(quickActionsDialog).toBeHidden();
		await expect(window.locator('[data-tour="history-panel"]')).toBeVisible();

		quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Go to Files Tab');
		await quickActionsDialog.getByRole('button', { name: /Go to Files Tab/ }).click();

		await expect(quickActionsDialog).toBeHidden();
		await expect(window.locator('[data-tour="files-panel"]')).toBeVisible();
	});

	test('opens Create New Agent from Quick Actions', async () => {
		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Create New Agent');
		await quickActionsDialog.getByRole('button', { name: /Create New Agent/ }).click();

		await expect(quickActionsDialog).toBeHidden();
		const createAgentDialog = window.getByRole('dialog', { name: 'Create New Agent' });
		await expect(createAgentDialog).toBeVisible();
		await expect(createAgentDialog.getByLabel('Agent Name')).toBeVisible();
		await expect(createAgentDialog.getByText('Agent Provider')).toBeVisible();
		await expect(createAgentDialog.getByRole('button', { name: 'Create Agent' })).toBeDisabled();
	});

	test('opens Edit Agent from Quick Actions for the active Codex agent', async () => {
		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Edit Agent');
		await quickActionsDialog.getByRole('button', { name: /Edit Agent: E2E Workbench/ }).click();

		await expect(quickActionsDialog).toBeHidden();
		const editAgentDialog = window.getByRole('dialog', { name: 'Edit Agent: E2E Workbench' });
		await expect(editAgentDialog).toBeVisible();
		await expect(editAgentDialog.getByLabel('Agent Name')).toHaveValue('E2E Workbench');
		await expect(editAgentDialog.getByText('Agent Provider')).toBeVisible();
		await expect(editAgentDialog.getByText('Working Directory')).toBeVisible();
	});

	test('renames the active agent from Quick Actions', async () => {
		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Rename Agent');
		await quickActionsDialog.getByRole('button', { name: /Rename Agent: E2E Workbench/ }).click();

		await expect(quickActionsDialog).toBeHidden();
		const renameDialog = window.getByRole('dialog', { name: 'Rename Agent' });
		await expect(renameDialog).toBeVisible();
		await renameDialog.getByPlaceholder('Enter agent name...').fill('Renamed Workbench');
		await renameDialog.getByRole('button', { name: 'Rename' }).click();

		await expect(renameDialog).toBeHidden();
		await expect(window.getByText('Renamed Workbench').first()).toBeVisible();
	});

	test('toggles bookmark state for the active agent from Quick Actions', async () => {
		let quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Bookmark');
		await quickActionsDialog.getByRole('button', { name: /Bookmark: E2E Workbench/ }).click();
		await expect(quickActionsDialog).toBeHidden();

		quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Unbookmark');
		await expect(
			quickActionsDialog.getByRole('button', { name: /Unbookmark: E2E Workbench/ })
		).toBeVisible();
	});

	test('switches the active agent between AI and shell mode from Quick Actions', async () => {
		await window.getByText('Main', { exact: true }).click();
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();
		await expect(window.getByTitle('Send message')).toBeVisible();

		let quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Switch AI/Shell Mode');
		await quickActionsDialog.getByRole('button', { name: /Switch AI\/Shell Mode/ }).click();
		await expect(quickActionsDialog).toBeHidden();
		await expect(window.getByTitle('Run command (Enter)')).toBeVisible();

		quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Switch AI/Shell Mode');
		await quickActionsDialog.getByRole('button', { name: /Switch AI\/Shell Mode/ }).click();
		await expect(quickActionsDialog).toBeHidden();
		await expect(window.getByTitle('Send message')).toBeVisible();
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

	test('opens the Usage Dashboard from Quick Actions', async () => {
		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Usage Dashboard');
		await quickActionsDialog.getByRole('button', { name: /Usage Dashboard/ }).click();

		await expect(quickActionsDialog).toBeHidden();
		const usageDashboard = window.getByRole('dialog', { name: 'Usage Dashboard' });
		await expect(usageDashboard).toBeVisible();
		await expect(usageDashboard.getByRole('tab', { name: 'Overview' })).toBeVisible();
		await expect(usageDashboard.getByRole('tab', { name: 'Agents' })).toBeVisible();
		await expect(usageDashboard.getByRole('tab', { name: 'Activity' })).toBeVisible();
		await expect(usageDashboard.getByRole('tab', { name: 'Auto Run' })).toBeVisible();

		await usageDashboard.getByRole('tab', { name: 'Agents' }).click();
		await expect(usageDashboard.getByRole('tab', { name: 'Agents' })).toHaveAttribute(
			'aria-selected',
			'true'
		);

		const timeRange = usageDashboard.locator('select').first();
		await timeRange.selectOption('all');
		await expect(timeRange).toHaveValue('all');

		await usageDashboard.getByTitle('Close (Esc)').click();
		await expect(usageDashboard).toBeHidden();
	});

	test('opens Agent Sessions from Quick Actions for the active Codex agent', async () => {
		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('View Agent Sessions');
		await quickActionsDialog.getByRole('button', { name: /View Agent Sessions/ }).click();

		await expect(quickActionsDialog).toBeHidden();
		await expect(window.getByText('Agent Sessions for E2E Workbench')).toBeVisible();
		await expect(window.getByRole('button', { name: 'New Session' })).toBeVisible();
		await expect(window.getByPlaceholder('Search all content...')).toBeVisible();
		await expect(window.getByRole('checkbox', { name: 'Named' })).toBeVisible();
		await expect(window.getByRole('checkbox', { name: 'Show All' })).toBeVisible();
		await expect(window.getByText('No agent sessions found for this project')).toBeVisible();
	});

	test('shows an empty state for unmatched Quick Actions searches', async () => {
		const quickActionsDialog = await openQuickActions(window);
		const commandSearch = quickActionsDialog.getByPlaceholder('Type a command or jump to agent...');

		await commandSearch.fill('definitely missing command');
		await expect(quickActionsDialog.getByText('No actions found')).toBeVisible();

		await closeQuickActions(window, quickActionsDialog);
	});

	test('expands and collapses folders in the File Explorer', async () => {
		await helpers.openRightPanelTab(window, 'Files');
		await expect(window.getByText('NOTES.md')).toBeVisible();
		await window.getByTitle('Expand all folders').click();
		await expect(window.getByText('Phase 1.md', { exact: true })).toBeVisible();

		await window.getByTitle('Collapse all folders').click();
		await expect(window.getByText('Phase 1.md', { exact: true })).toBeHidden();
	});

	test('opens a markdown file from the File Explorer into preview', async () => {
		await helpers.openRightPanelTab(window, 'Files');
		await window.getByText('NOTES.md').dblclick();

		await expect(window.getByText('Notes Preview Surface')).toBeVisible();
		await expect(
			window.getByText('Searchable note body for file explorer coverage.')
		).toBeVisible();
	});

	test('filters files from the File Explorer and clears the filter with Escape', async () => {
		await helpers.openRightPanelTab(window, 'Files');
		const readmeRow = await getFileTreeRow(window, 'README.md');
		await readmeRow.click();

		await window.keyboard.press('Control+f');
		const filterInput = window.getByPlaceholder('Filter files...');
		await expect(filterInput).toBeVisible();

		await filterInput.fill('phase');
		await getFileTreeRow(window, 'Phase 1.md');
		await expect(
			window.locator('[data-file-index]').filter({ hasText: 'metrics.csv' })
		).toBeHidden();

		await filterInput.press('Escape');
		await expect(filterInput).toBeHidden();
		await getFileTreeRow(window, 'metrics.csv');
	});

	test('toggles dotfiles in the File Explorer', async () => {
		await helpers.openRightPanelTab(window, 'Files');
		const hiddenRow = window.locator('[data-file-index]').filter({ hasText: '.env.example' });
		await expect(hiddenRow).toBeVisible();

		await window.getByTitle('Hide dotfiles').click();
		await expect(hiddenRow).toBeHidden();

		await window.getByTitle('Show dotfiles').click();
		await expect(hiddenRow).toBeVisible();
	});

	test('previews a file from the File Explorer context menu', async () => {
		const contextMenu = await openFileContextMenu(window, 'NOTES.md');
		await expect(contextMenu.getByRole('button', { name: 'Preview' })).toBeVisible();
		await expect(
			contextMenu.getByRole('button', { name: 'Document Graph', exact: true })
		).toBeVisible();
		await expect(contextMenu.getByRole('button', { name: 'Open in Default App' })).toBeVisible();

		await contextMenu.getByRole('button', { name: 'Preview' }).click();
		await expect(window.getByText('Notes Preview Surface')).toBeVisible();
	});

	test('renames a file from the File Explorer context menu', async () => {
		const contextMenu = await openFileContextMenu(window, 'NOTES.md');
		await contextMenu.getByRole('button', { name: 'Rename' }).click();

		const renameDialog = window.getByRole('dialog', { name: 'Rename File' });
		await expect(renameDialog).toBeVisible();
		await renameDialog.getByPlaceholder('Enter file name...').fill('GUIDE.md');
		await renameDialog.getByRole('button', { name: 'Rename' }).click();

		await expect(renameDialog).toBeHidden();
		await getFileTreeRow(window, 'GUIDE.md');
		await expect(window.locator('[data-file-index]').filter({ hasText: 'NOTES.md' })).toBeHidden();
	});

	test('deletes a file from the File Explorer context menu after confirmation', async () => {
		const contextMenu = await openFileContextMenu(window, 'metrics.csv');
		await contextMenu.getByRole('button', { name: 'Delete' }).click();

		const deleteDialog = window.getByRole('dialog', { name: 'Delete File' });
		await expect(deleteDialog).toBeVisible();
		await expect(
			deleteDialog.getByText('Are you sure you want to delete the file "metrics.csv"?')
		).toBeVisible();
		await deleteDialog.getByRole('button', { name: 'Delete' }).click();

		await expect(deleteDialog).toBeHidden();
		await expect(
			window.locator('[data-file-index]').filter({ hasText: 'metrics.csv' })
		).toBeHidden();
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

	test('renders CSV file preview and filters table rows through file search', async () => {
		await helpers.openRightPanelTab(window, 'Files');
		await window.getByText('metrics.csv').dblclick();

		await expect(window.getByText('scenario')).toBeVisible();
		await expect(window.getByText('duration')).toBeVisible();
		await expect(window.getByText('2 rows')).toBeVisible();
		await expect(window.getByText(/3 columns/)).toBeVisible();

		await window.getByTestId('file-preview-root').press('Control+f');
		const searchInput = window.getByPlaceholder(/Search in file/);
		await searchInput.fill('prompt composer');
		await expect(window.getByText('1/1')).toBeVisible();
		await expect(window.getByText('1 of 2 rows match')).toBeVisible();
		await expect(window.getByText('prompt composer')).toBeVisible();
	});

	test('prompts before opening a binary file in the default app', async () => {
		await helpers.openRightPanelTab(window, 'Files');
		await window.getByText('artifact.bin').dblclick();

		const confirmDialog = window.getByRole('dialog', { name: 'Confirm' });
		await expect(confirmDialog).toBeVisible();
		await expect(
			confirmDialog.getByText('Open "artifact.bin" in external application?')
		).toBeVisible();
		await confirmDialog.getByRole('button', { name: 'Cancel' }).click();
		await expect(confirmDialog).toBeHidden();
	});

	test('renders image files inside the file preview tab', async () => {
		await helpers.openRightPanelTab(window, 'Files');
		await window.getByText('diagram.png').dblclick();

		await expect(window.getByText('diagram.png').first()).toBeVisible();
		await expect(window.getByRole('img', { name: 'diagram.png' })).toBeVisible();
		await expect(window.getByTitle('Copy image to clipboard')).toBeVisible();
		await expect(window.getByTitle('Copy full path to clipboard')).toBeVisible();
	});

	test('renders Mermaid diagrams from markdown file previews', async () => {
		await helpers.openRightPanelTab(window, 'Files');
		await window.getByText('FLOW.md').dblclick();

		await expect(window.getByText('Mermaid Preview Surface')).toBeVisible();
		await expect(window.locator('.mermaid-container svg')).toBeVisible({ timeout: 15000 });
		await expect(window.getByText('Failed to render Mermaid diagram')).toBeHidden();
	});

	test('truncates large text previews and loads the full file on demand', async () => {
		await helpers.openRightPanelTab(window, 'Files');
		await window.getByText('large-log.txt').dblclick();

		await expect(window.getByText('large file head marker')).toBeVisible();
		await expect(window.getByText('Large file preview truncated.')).toBeVisible();
		await expect(window.getByText('large file tail marker')).toBeHidden();

		await window.getByRole('button', { name: 'Load full file' }).click();
		await expect(window.getByText('Large file preview truncated.')).toBeHidden();
		await expect(window.getByText('large file tail marker')).toBeVisible();
	});

	test('opens Document Graph from file preview and uses core graph controls', async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await graphDialog.getByLabel('Search documents in graph').fill('NOTES');
		await expect(graphDialog.getByText('1 of 2 matching')).toBeVisible();
		await graphDialog.getByLabel('Clear search').click();
		await expect(graphDialog.getByText(/2 documents/)).toBeVisible();

		await graphDialog.getByTitle('Layout: Mind Map').click();
		await graphDialog.getByRole('button', { name: /Radial/ }).click();
		await expect(graphDialog.getByTitle('Layout: Radial')).toBeVisible();

		await graphDialog.getByTitle('Showing 2 levels of neighbors').click();
		await graphDialog.locator('input[type="range"][min="0"][max="5"]').fill('1');
		await expect(graphDialog.getByTitle('Showing 1 level of neighbors')).toBeVisible();
		await window.keyboard.press('Escape');
		await expect(graphDialog.getByText('Neighbor Depth')).toBeHidden();

		await graphDialog.getByTitle('Show external links').click();
		await expect(graphDialog.getByTitle('Hide external links')).toBeVisible();

		await graphDialog.getByTitle('Open help panel').click();
		await expect(graphDialog.getByRole('region', { name: 'Help panel' })).toBeVisible();
		await expect(graphDialog.getByText('Node Types')).toBeVisible();
		await expect(graphDialog.getByText('External Link').first()).toBeVisible();

		await closeDocumentGraph(window);
	});

	test('reopens the last Document Graph from Quick Actions', async () => {
		await openDocumentGraphFromPreview(window);
		await closeDocumentGraph(window);

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Open Last Document Graph');
		await quickActionsDialog.getByRole('button', { name: /Open Last Document Graph/ }).click();

		const graphDialog = window.getByRole('dialog', { name: 'Document Graph' });
		await expect(graphDialog).toBeVisible({ timeout: 15000 });
		await expect(graphDialog.getByText(/2 documents/)).toBeVisible({ timeout: 15000 });
		await closeDocumentGraph(window);
	});

	test("toggles Director's Notes in Encore settings and updates Quick Actions", async () => {
		let settingsDialog = await openSettings(window);
		await settingsDialog.locator('button[title="Encore Features"]').click();
		await expect(settingsDialog.getByText('Default Lookback Period: 7 days')).toBeVisible();

		await settingsDialog.getByRole('button', { name: /Director's Notes/ }).click();
		await expect(settingsDialog.getByText('Default Lookback Period: 7 days')).toBeHidden();
		await window.keyboard.press('Escape');
		await expect(settingsDialog).toBeHidden();

		let quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill("Director's Notes");
		await expect(quickActionsDialog.getByText('No actions found')).toBeVisible();
		await closeQuickActions(window, quickActionsDialog);

		settingsDialog = await openSettings(window);
		await settingsDialog.locator('button[title="Encore Features"]').click();
		await settingsDialog.getByRole('button', { name: /Director's Notes/ }).click();
		await expect(settingsDialog.getByText('Default Lookback Period: 7 days')).toBeVisible();
		await window.keyboard.press('Escape');
		await expect(settingsDialog).toBeHidden();

		quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill("Director's Notes");
		await expect(
			quickActionsDialog.getByRole('button', { name: /Director's Notes/ })
		).toBeVisible();
	});

	test("opens Director's Notes unified history and filters seeded entries", async () => {
		const directorNotesDialog = await openDirectorNotesFromQuickActions(window);

		await expect(
			directorNotesDialog.getByText('Manual note captured for project review')
		).toBeVisible();
		await expect(directorNotesDialog.getByText('Completed Auto Run setup checklist')).toBeVisible();
		await expect(directorNotesDialog.getByText('Failed generated docs sync')).toBeVisible();

		await directorNotesDialog.getByRole('button', { name: /AUTO/ }).click();
		await expect(directorNotesDialog.getByText('Completed Auto Run setup checklist')).toBeHidden();
		await expect(directorNotesDialog.getByText('Failed generated docs sync')).toBeHidden();
		await expect(
			directorNotesDialog.getByText('Manual note captured for project review')
		).toBeVisible();

		await directorNotesDialog.getByRole('button', { name: /USER/ }).click();
		await expect(
			directorNotesDialog.getByText('No entries match the current filters.')
		).toBeVisible();
	});

	test("searches Director's Notes history and opens a detail modal", async () => {
		const directorNotesDialog = await openDirectorNotesFromQuickActions(window);

		await directorNotesDialog.getByTitle('Search entries (⌘F)').click();
		const directorSearch = directorNotesDialog.getByPlaceholder(
			'Filter by summary or agent name...'
		);
		await expect(directorSearch).toBeVisible();

		await directorSearch.fill('manual');
		await expect(
			directorNotesDialog.getByText('Manual note captured for project review')
		).toBeVisible();
		await expect(directorNotesDialog.getByText('Completed Auto Run setup checklist')).toBeHidden();

		await directorNotesDialog.getByText('Manual note captured for project review').click();
		await expect(
			window.getByText('Manual detail includes NOTES.md and a follow-up checklist.')
		).toBeVisible();
		await expect(window.getByText('E2E Workbench').last()).toBeVisible();

		await window.getByRole('button', { name: 'Close', exact: true }).click();
		await expect(
			window.getByText('Manual detail includes NOTES.md and a follow-up checklist.')
		).toBeHidden();
	});

	test("opens Director's Notes help and deterministic AI overview tabs", async () => {
		const directorNotesDialog = await openDirectorNotesFromQuickActions(window);

		await directorNotesDialog.getByRole('button', { name: 'Help' }).click();
		await expect(directorNotesDialog.getByText("What are Director's Notes?")).toBeVisible();
		await expect(directorNotesDialog.getByText('Keyboard Shortcuts')).toBeVisible();

		const aiOverviewTab = directorNotesDialog.getByRole('button', { name: 'AI Overview' });
		await expect(aiOverviewTab).toBeEnabled({ timeout: 15000 });
		await aiOverviewTab.click();
		await expect(directorNotesDialog.getByText('Seeded Director Synopsis')).toBeVisible();
		await expect(directorNotesDialog.getByText('3 history entries')).toBeVisible();

		await window.keyboard.press('Escape');
		await expect(directorNotesDialog).toBeHidden();
	});

	test('opens Prompt Composer and edits a draft without sending', async () => {
		const composerInput = await openPromptComposer(window);

		await composerInput.fill('Draft prompt line one\nDraft prompt line two');
		await composerInput.press('Tab');
		await expect(composerInput).toHaveValue(/Draft prompt line two\t$/);
		await expect(window.getByText(/characters/).last()).toBeVisible();

		await window.keyboard.press('Escape');
		await expect(window.getByText('Prompt Composer')).toBeHidden();
	});

	test('opens Prompt Composer from the keyboard shortcut', async () => {
		await window.getByText('Main', { exact: true }).click();
		await expect(window.getByTitle('Send message')).toBeVisible();
		await window.keyboard.press('Meta+Shift+P');
		await expect(window.getByText('Prompt Composer')).toBeVisible();
		const composerInput = window.getByPlaceholder(/Write your prompt here/);

		await composerInput.fill('Keyboard-opened prompt draft');
		await expect(composerInput).toHaveValue('Keyboard-opened prompt draft');
		await window.keyboard.press('Escape');
		await expect(window.getByText('Prompt Composer')).toBeHidden();
	});

	test('shows Prompt Composer controls without sending a live prompt', async () => {
		const composerInput = await openPromptComposer(window);
		const composerDialog = window
			.getByText('Prompt Composer')
			.locator('xpath=ancestor::div[contains(@class, "z-10")][1]');

		const historyToggle = composerDialog.getByTitle(/Save to History/);
		await expect(historyToggle).toBeVisible();
		await historyToggle.click();
		const readOnlyToggle = composerDialog.getByTitle(/Toggle Read-Only mode/);
		await expect(readOnlyToggle).toBeVisible();
		await readOnlyToggle.click();
		await expect(composerDialog.getByText('Read-Only')).toBeVisible();

		await expect(composerDialog.getByTitle(/Enter/)).toBeVisible();
		await expect(composerDialog.getByRole('button', { name: 'Send' })).toBeDisabled();
		await composerInput.fill('Prepared prompt that is not sent');
		await expect(composerDialog.getByRole('button', { name: 'Send' })).toBeEnabled();

		await window.keyboard.press('Escape');
		await expect(window.getByText('Prompt Composer')).toBeHidden();
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
