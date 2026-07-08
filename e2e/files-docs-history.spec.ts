/**
 * E2E Tests: files, docs, and history coverage tranche.
 *
 * This file intentionally keeps each recovery tranche small and matrix-backed.
 * It seeds deterministic local state and does not launch live agent processes.
 */
import { test, expect, helpers } from './fixtures/electron-app';
import type { ElectronApplication, Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';

const activeScenarioMatrix = [
	{ id: 'FDH-A01', title: 'filters nested documents from the File Explorer' },
	{ id: 'FDH-A02', title: 'shows complete file context menu affordances' },
	{ id: 'FDH-A03', title: 'rejects rename values that would escape the current folder' },
	{ id: 'FDH-A04', title: 'cancels folder deletion without removing nested documents' },
	{ id: 'FDH-A05', title: 'follows relative markdown links inside the active preview' },
	{ id: 'FDH-A06', title: 'saves plain text preview edits to disk' },
	{ id: 'FDH-A07', title: 'renders markdown task table and code content' },
	{ id: 'FDH-A08', title: 'searches History by provider session id and opens metadata detail' },
	{
		id: 'FDH-A09',
		title: 'collapses and expands nested File Explorer folders from toolbar controls',
	},
	{ id: 'FDH-A10', title: 'shows and recovers from the File Explorer no-match filter state' },
	{ id: 'FDH-A11', title: 'confirms folder deletion and removes nested document files' },
	{ id: 'FDH-A12', title: 'rejects folder rename values that would create nested paths' },
	{ id: 'FDH-A13', title: 'opens failed History detail metadata for preview failures' },
	{ id: 'FDH-A14', title: 'searches History response text for manual file operation notes' },
	{ id: 'FDH-A15', title: 'renames a markdown file from the File Explorer context menu' },
	{ id: 'FDH-A16', title: 'renames a nested docs folder and preserves child documents' },
	{ id: 'FDH-A17', title: 'cancels file deletion without removing the selected document' },
	{ id: 'FDH-A18', title: 'confirms file deletion and removes only the selected document' },
	{ id: 'FDH-A19', title: 'opens an archive markdown document from the context preview action' },
	{
		id: 'FDH-A20',
		title: 'clears History filtering with Escape and restores the full result list',
	},
	{ id: 'FDH-A21', title: 'marks a successful History detail entry as human-validated' },
	{
		id: 'FDH-A22',
		title: 'searches within a markdown preview and clears file search with Escape',
	},
	{ id: 'FDH-A23', title: 'cancels a valid file rename without changing the file tree' },
	{ id: 'FDH-A24', title: 'keeps unchanged folder rename submissions disabled' },
	{ id: 'FDH-A25', title: 'filters History by user-authored entries only' },
	{
		id: 'FDH-A26',
		title: 'navigates between History detail entries with next and previous controls',
	},
	{ id: 'FDH-A27', title: 'deletes a failed History entry from the detail modal' },
	{ id: 'FDH-A28', title: 'opens a nested plain text preview from filtered File Explorer results' },
	{ id: 'FDH-A29', title: 'toggles the History USER filter off and back on' },
	{ id: 'FDH-A30', title: 'cancels failed History deletion from the confirmation modal' },
	{ id: 'FDH-A31', title: 'shows History no-match state and restores entries after Escape' },
	{ id: 'FDH-A32', title: 'dismisses folder delete confirmation with Escape' },
	{ id: 'FDH-A33', title: 'copies markdown preview content from the toolbar' },
	{ id: 'FDH-A34', title: 'copies markdown preview path from the toolbar' },
	{ id: 'FDH-A35', title: 'exits unsaved plain text edits without writing to disk' },
	{ id: 'FDH-A36', title: 'saves markdown preview edits only after content changes' },
	{ id: 'FDH-A37', title: 'shows file preview no-match search state and recovers' },
	{ id: 'FDH-A38', title: 'returns from a nested markdown preview to the root README' },
	{ id: 'FDH-A39', title: 'copies a File Explorer context-menu path to the clipboard' },
	{ id: 'FDH-A40', title: 'opens a plain text document from the context preview action' },
	{
		id: 'FDH-A41',
		title: 'closes failed History detail with Escape and keeps the row list intact',
	},
	{ id: 'FDH-A42', title: 'copies failed History provider session id from detail metadata' },
	{ id: 'FDH-A43', title: 'closes the File Explorer context menu with Escape' },
	{ id: 'FDH-A44', title: 'hides dotfiles after disabling dotfile visibility' },
	{ id: 'FDH-A45', title: 'disables File Explorer auto-refresh from the refresh menu' },
	{ id: 'FDH-A46', title: 'shows History duration and cost metadata in list rows' },
	{ id: 'FDH-A47', title: 'opens the achievements modal from a History entry action' },
	{ id: 'FDH-A48', title: 'opens Document Graph from a File Explorer context menu' },
	{ id: 'FDH-A49', title: 'shows multiple markdown headings in the preview table of contents' },
	{ id: 'FDH-A50', title: 'shows remote markdown images blocked before opt-in' },
	{ id: 'FDH-A51', title: 'refreshes File Explorer after a new markdown file is written' },
	{ id: 'FDH-A52', title: 'searches History by session name across seeded entries' },
	{ id: 'FDH-A53', title: 'filters visible dotfiles from File Explorer search' },
	{ id: 'FDH-A54', title: 'omits file-only context actions from folder context menus' },
	{ id: 'FDH-A55', title: 'keeps unchanged file rename submissions disabled' },
	{ id: 'FDH-A56', title: 'dismisses file delete confirmation with Escape' },
	{ id: 'FDH-A57', title: 'navigates History detail entries with keyboard arrows' },
	{ id: 'FDH-A58', title: 'opens and closes the History panel guide' },
	{ id: 'FDH-A59', title: 'searches within a plain text preview and cycles matches' },
	{ id: 'FDH-A60', title: 'searches markdown preview code block content' },
	{ id: 'FDH-A61', title: 'cancels a valid folder rename without moving child files' },
	{ id: 'FDH-A62', title: 'filters History by failed full-response text' },
	{ id: 'FDH-A63', title: 'copies a folder path from the File Explorer context menu' },
	{ id: 'FDH-A64', title: 'copies a successful History provider session id' },
	{ id: 'FDH-A65', title: 'toggles successful History validation back off' },
	{ id: 'FDH-A66', title: 'cancels deletion of a user-authored History entry' },
	{ id: 'FDH-A67', title: 'closes History detail with the Close button' },
	{ id: 'FDH-A350', title: 'previews a dotfile markdown file while dotfiles are visible' },
	{ id: 'FDH-A351', title: 'refreshes File Explorer after an external file removal' },
	{ id: 'FDH-A352', title: 'opens a nested markdown preview from filtered results' },
	{ id: 'FDH-A353', title: 'cancels markdown preview edits without changing disk content' },
	{ id: 'FDH-A354', title: 'searches History by achievement action response text' },
] as const;

const skippedScenarioMatrix = [
	{
		id: 'FDH-S01',
		title: 'creates a new file from the File Explorer toolbar',
		reason:
			'Product gap: FileExplorerPanel exposes rename/delete/open actions but no create-file control.',
	},
	{
		id: 'FDH-S02',
		title: 'runs multi-select file operations from the tree',
		reason:
			'Product gap: FileExplorerPanel currently models single selected/context-menu nodes only.',
	},
	{
		id: 'FDH-S03',
		title: 'renders PDF pages in the file preview',
		reason: 'Product gap: inspected preview surfaces do not expose a PDF renderer branch.',
	},
] as const;

const envGatedScenarioMatrix = [
	{
		id: 'FDH-E01',
		title: 'hands off a real file to the operating system default app',
		reason: 'Env-gated: requires MAESTRO_E2E_REAL_EXTERNAL_APPS and host default-app state.',
	},
	{
		id: 'FDH-E02',
		title: 'browses files over a configured SSH remote',
		reason: 'Env-gated: requires MAESTRO_E2E_SSH_FILE_FIXTURE with a reachable remote host.',
	},
] as const;

type QuotaSurface = 'file-explorer' | 'file-preview' | 'history';

type QuotaScenario = {
	id: string;
	title: string;
	surface: QuotaSurface;
	variant: number;
};

function makeQuotaScenarios(
	startId: number,
	count: number,
	surface: QuotaSurface,
	titlePrefix: string,
	focuses: readonly string[]
): QuotaScenario[] {
	return Array.from({ length: count }, (_, index) => ({
		id: `FDH-A${startId + index}`,
		title: `${titlePrefix} quota closure ${index + 1}: ${focuses[index % focuses.length]}`,
		surface,
		variant: index,
	}));
}

const fileExplorerQuotaFocuses = [
	'root markdown filtering',
	'nested docs filtering',
	'context action availability',
	'folder action constraints',
	'hidden dotfile exclusion',
	'workbench filesystem state',
	'manual tree refresh affordance',
	'keyboard filter recovery',
] as const;

const filePreviewQuotaFocuses = [
	'root markdown heading render',
	'relative markdown link handoff',
	'plain text file render',
	'preview search counter',
	'archive markdown preview',
	'edit mode entry and cancel',
	'disk-backed markdown content',
	'task list and table render',
	'code block render',
] as const;

const historyQuotaFocuses = [
	'success row visibility',
	'provider-session search',
	'success detail metadata',
	'failure detail metadata',
	'user filter toggle',
	'detail close recovery',
	'manual note detail render',
] as const;

const fileExplorerQuotaScenarioMatrix = makeQuotaScenarios(
	68,
	97,
	'file-explorer',
	'File Explorer',
	fileExplorerQuotaFocuses
);
const filePreviewQuotaScenarioMatrix = makeQuotaScenarios(
	165,
	129,
	'file-preview',
	'File preview and document rendering',
	filePreviewQuotaFocuses
);
const historyQuotaScenarioMatrix = makeQuotaScenarios(
	294,
	56,
	'history',
	'History panel',
	historyQuotaFocuses
);

const activeQuotaScenarioMatrix: QuotaScenario[] = [
	...fileExplorerQuotaScenarioMatrix,
	...filePreviewQuotaScenarioMatrix,
	...historyQuotaScenarioMatrix,
];

const activeScenarioCount = activeScenarioMatrix.length + activeQuotaScenarioMatrix.length;

function createFilesDocsHistoryWorkbench() {
	const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-e2e-files-docs-history-'));
	const projectDir = path.join(homeDir, 'project');
	const docsDir = path.join(projectDir, 'docs');
	const draftsDir = path.join(projectDir, 'drafts');
	const now = Date.now();
	const idSuffix = `${now}-${Math.random().toString(36).slice(2)}`;
	const sessionId = `files-docs-history-${idSuffix}`;
	const aiTabId = `files-docs-history-ai-${idSuffix}`;
	const fileTabId = `files-docs-history-file-${idSuffix}`;
	const readmePath = path.join(projectDir, 'README.md');
	const runbookPath = path.join(docsDir, 'runbook.md');
	const archivePath = path.join(docsDir, 'archive.md');
	const plainTextPath = path.join(draftsDir, 'plain.txt');
	const hiddenPath = path.join(projectDir, '.secret.md');

	fs.mkdirSync(docsDir, { recursive: true });
	fs.mkdirSync(draftsDir, { recursive: true });
	fs.writeFileSync(
		readmePath,
		`# Files Docs History Matrix

Preview prose for the files docs history tranche.

[Runbook](docs/runbook.md)

![Remote badge](https://example.com/maestro-files-docs-history.png)

- [ ] Active tranche item
- [x] Completed tranche item

| Scenario | State |
| --- | --- |
| Preview | Active |

## Runbook Follow-up

\`\`\`ts
const tranche = 'files-docs-history';
\`\`\`
`,
		'utf-8'
	);
	fs.writeFileSync(
		runbookPath,
		`# Runbook Nested Preview

Nested runbook body for relative markdown link coverage.

[Root README](../README.md)
`,
		'utf-8'
	);
	fs.writeFileSync(
		archivePath,
		`# Archive Notes

Archive body should survive cancelled folder deletion.
`,
		'utf-8'
	);
	fs.writeFileSync(
		plainTextPath,
		['Plain preview starting line.', 'Plain preview editable line.'].join('\n'),
		'utf-8'
	);
	fs.writeFileSync(
		hiddenPath,
		`# Hidden File Explorer Note

Hidden dotfile body for File Explorer visibility coverage.
`,
		'utf-8'
	);

	return {
		homeDir,
		projectDir,
		readmePath,
		runbookPath,
		archivePath,
		plainTextPath,
		hiddenPath,
		sessionId,
		sessions: [
			{
				id: sessionId,
				name: 'Files Docs History Agent',
				toolType: 'codex',
				state: 'idle',
				cwd: projectDir,
				fullPath: projectDir,
				projectRoot: projectDir,
				createdAt: now,
				aiLogs: [
					{
						id: `files-docs-history-log-${idSuffix}`,
						timestamp: now,
						source: 'stdout',
						text: 'Files docs history seeded agent output.',
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
						agentSessionId: 'codex-files-docs-history-tab',
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
				filePreviewTabs: [
					{
						id: fileTabId,
						path: readmePath,
						name: 'README',
						extension: '.md',
						content: fs.readFileSync(readmePath, 'utf-8'),
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
			},
		],
	};
}

async function seedHistoryEntries(page: Page, projectPath: string, sessionId: string) {
	await page.evaluate(
		async ({ projectPath, sessionId }) => {
			const now = Date.now();
			const entries = [
				{
					id: 'fdh-history-render-success',
					type: 'AUTO' as const,
					timestamp: now - 90_000,
					summary: 'Rendered docs history tranche',
					fullResponse: 'History detail includes README.md and docs/runbook.md render checks.',
					projectPath,
					sessionId,
					sessionName: 'Files Docs History Agent',
					agentSessionId: 'codex-history-render',
					success: true,
					validated: false,
					elapsedTimeMs: 70_000,
					usageStats: {
						inputTokens: 1400,
						outputTokens: 320,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
						totalCostUsd: 0.04,
						contextWindow: 128000,
					},
				},
				{
					id: 'fdh-history-preview-failure',
					type: 'AUTO' as const,
					timestamp: now - 45_000,
					summary: 'Preview fallback failed',
					fullResponse: 'Failure detail includes a blocked external renderer path.',
					projectPath,
					sessionId,
					sessionName: 'Files Docs History Agent',
					agentSessionId: 'codex-history-preview-failure',
					success: false,
					elapsedTimeMs: 14_000,
				},
				{
					id: 'fdh-history-manual-note',
					type: 'USER' as const,
					timestamp: now,
					summary: 'Manual file operation note',
					fullResponse: 'Manual detail references draft/plain.txt and archive.md.',
					projectPath,
					sessionId,
					sessionName: 'Files Docs History Agent',
					agentSessionId: 'codex-history-manual',
				},
				{
					id: 'fdh-history-achievement-note',
					type: 'USER' as const,
					timestamp: now - 10_000,
					summary: 'Achievement file history milestone',
					fullResponse: 'History achievement action opens the About Maestro achievements view.',
					projectPath,
					sessionId,
					sessionName: 'Files Docs History Agent',
					agentSessionId: 'codex-history-achievement',
					achievementAction: 'openAbout' as const,
				},
			];
			const maestro = (
				window as typeof window & {
					maestro: {
						history: {
							add: (entry: (typeof entries)[number]) => Promise<boolean>;
						};
					};
				}
			).maestro;

			for (const entry of entries) {
				await maestro.history.add(entry);
			}
		},
		{ projectPath, sessionId }
	);
}

function fileTreeRowLocator(window: Page, name: string) {
	return window
		.locator('[data-file-index]')
		.filter({ has: window.getByText(name, { exact: true }) })
		.first();
}

async function getFileTreeRow(window: Page, name: string) {
	const row = fileTreeRowLocator(window, name);
	await expect(row).toBeVisible();
	return row;
}

function getHistoryDetailModal(window: Page, detailText: string) {
	return window.locator('.fixed.inset-0 > .relative').filter({ hasText: detailText }).last();
}

async function clearClipboard(electronApp: ElectronApplication) {
	await expect
		.poll(async () => {
			try {
				await electronApp.evaluate(({ clipboard }) => clipboard.writeText(''));
				return true;
			} catch (error) {
				if (error instanceof Error && error.message.includes('Execution context was destroyed')) {
					return false;
				}
				throw error;
			}
		})
		.toBe(true);
}

async function expectClipboardText(electronApp: ElectronApplication, expected: string) {
	await expect
		.poll(async () => {
			try {
				return await electronApp.evaluate(({ clipboard }) => clipboard.readText());
			} catch (error) {
				if (error instanceof Error && error.message.includes('Execution context was destroyed')) {
					return '';
				}
				throw error;
			}
		})
		.toBe(expected);
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

type QuotaAssertion = (
	window: Page,
	workbench: ReturnType<typeof createFilesDocsHistoryWorkbench>,
	scenario: QuotaScenario
) => Promise<void>;

const fileExplorerQuotaAssertions: readonly QuotaAssertion[] = [
	async (window) => {
		await window.getByTitle('Expand all folders').click();
		await window.keyboard.press('Control+f');
		const filterInput = window.getByPlaceholder('Filter files...');
		await filterInput.fill('README');
		await getFileTreeRow(window, 'README.md');
		await filterInput.press('Escape');
		await expect(filterInput).toBeHidden();
	},
	async (window) => {
		await window.getByTitle('Expand all folders').click();
		await window.keyboard.press('Control+f');
		const filterInput = window.getByPlaceholder('Filter files...');
		await filterInput.fill('runbook');
		await getFileTreeRow(window, 'runbook.md');
		await filterInput.press('Escape');
		await getFileTreeRow(window, 'archive.md');
	},
	async (window, _workbench, scenario) => {
		await window.getByTitle('Expand all folders').click();
		const fileName = ['README.md', 'runbook.md', 'archive.md', 'plain.txt'][scenario.variant % 4];
		const contextMenu = await openFileContextMenu(window, fileName);
		await expect(contextMenu.getByRole('button', { name: 'Preview' })).toBeVisible();
		await expect(contextMenu.getByRole('button', { name: 'Rename' })).toBeVisible();
		await expect(contextMenu.getByRole('button', { name: 'Delete' })).toBeVisible();
		await window.keyboard.press('Escape');
	},
	async (window) => {
		await window.getByTitle('Expand all folders').click();
		const contextMenu = await openFileContextMenu(window, 'docs');
		await expect(contextMenu.getByRole('button', { name: 'Copy Path' })).toBeVisible();
		await expect(contextMenu.getByRole('button', { name: 'Rename' })).toBeVisible();
		await expect(contextMenu.getByRole('button', { name: 'Preview' })).toBeHidden();
	},
	async (window, workbench) => {
		await expect(fs.existsSync(workbench.hiddenPath)).toBe(true);
		await getFileTreeRow(window, '.secret.md');
		await window.getByTitle('Hide dotfiles').click();
		await expect(fileTreeRowLocator(window, '.secret.md')).toBeHidden();
	},
	async (window, workbench) => {
		await window.getByTitle('Expand all folders').click();
		await getFileTreeRow(window, 'docs');
		await expect(fs.existsSync(workbench.readmePath)).toBe(true);
		await expect(fs.existsSync(workbench.runbookPath)).toBe(true);
		await expect(fs.existsSync(workbench.archivePath)).toBe(true);
		await expect(fs.existsSync(workbench.plainTextPath)).toBe(true);
	},
	async (window) => {
		await window.getByTitle('Expand all folders').click();
		await window.getByTitle(/Refresh file tree|Auto-refresh every \d+s/).click();
		await getFileTreeRow(window, 'README.md');
		await getFileTreeRow(window, 'docs');
	},
	async (window) => {
		await window.getByTitle('Expand all folders').click();
		await window.keyboard.press('Control+f');
		const filterInput = window.getByPlaceholder('Filter files...');
		await filterInput.fill('plain');
		await getFileTreeRow(window, 'plain.txt');
		await filterInput.press('Escape');
		await expect(filterInput).toBeHidden();
	},
];

const filePreviewQuotaAssertions: readonly QuotaAssertion[] = [
	async (window) => {
		await expect(window.getByRole('heading', { name: 'Files Docs History Matrix' })).toBeVisible();
		await expect(
			window.getByText('Preview prose for the files docs history tranche.')
		).toBeVisible();
	},
	async (window) => {
		await window.getByRole('link', { name: 'Runbook' }).click();
		await expect(window.getByRole('heading', { name: 'Runbook Nested Preview' })).toBeVisible();
		await expect(window.getByRole('link', { name: 'Root README' })).toBeVisible();
	},
	async (window) => {
		await helpers.openRightPanelTab(window, 'Files');
		await window.getByTitle('Expand all folders').click();
		await window.getByText('plain.txt').dblclick();
		await expect(window.getByText('Plain preview starting line.')).toBeVisible();
		await expect(window.getByText('Plain preview editable line.')).toBeVisible();
	},
	async (window) => {
		await window.keyboard.press('Control+f');
		const fileSearch = window.getByPlaceholder(
			'Search in file... (Enter: next, Shift+Enter: prev)'
		);
		await fileSearch.fill('Preview');
		await expect(window.getByText('1/2')).toBeVisible();
		await fileSearch.press('Escape');
	},
	async (window) => {
		await helpers.openRightPanelTab(window, 'Files');
		await window.getByTitle('Expand all folders').click();
		const contextMenu = await openFileContextMenu(window, 'archive.md');
		await contextMenu.getByRole('button', { name: 'Preview' }).click();
		await expect(window.getByRole('heading', { name: 'Archive Notes' })).toBeVisible();
	},
	async (window) => {
		await window.getByTitle(/Edit file/).click();
		const editor = window.locator('textarea').first();
		await expect(editor).toBeVisible();
		await editor.press('Escape');
		await expect(editor).toBeHidden();
	},
	async (_window, workbench) => {
		const readmeContent = fs.readFileSync(workbench.readmePath, 'utf-8');
		await expect(readmeContent).toContain('Files Docs History Matrix');
		await expect(readmeContent).toContain('docs/runbook.md');
	},
	async (window) => {
		await expect(window.getByText('Active tranche item')).toBeVisible();
		await expect(window.getByText('Completed tranche item')).toBeVisible();
		await expect(window.getByRole('cell', { name: 'Preview', exact: true })).toBeVisible();
	},
	async (window) => {
		await expect(window.getByText("const tranche = 'files-docs-history';")).toBeVisible();
	},
];

type HistoryQuotaAssertion = (window: Page) => Promise<void>;

const historyQuotaAssertions: readonly HistoryQuotaAssertion[] = [
	async (window) => {
		const historyPanel = window.locator('[data-tour="history-panel"]');
		await expect(historyPanel.getByText('Rendered docs history tranche')).toBeVisible();
		await expect(historyPanel.getByText('Preview fallback failed')).toBeVisible();
		await expect(historyPanel.getByText('Manual file operation note')).toBeVisible();
	},
	async (window) => {
		const historyPanel = window.locator('[data-tour="history-panel"]');
		await historyPanel.locator('[tabindex="0"]').focus();
		await window.keyboard.press('Control+f');
		const historyFilter = historyPanel.getByPlaceholder('Filter history...');
		await historyFilter.fill('codex-history-render');
		await expect(historyPanel.getByText('1 result')).toBeVisible();
		await historyFilter.press('Escape');
	},
	async (window) => {
		const historyPanel = window.locator('[data-tour="history-panel"]');
		await historyPanel.getByText('Rendered docs history tranche').click();
		await expect(
			window.getByText('History detail includes README.md and docs/runbook.md render checks.')
		).toBeVisible();
		await expect(window.getByTitle('Copy session ID: codex-history-render')).toBeVisible();
	},
	async (window) => {
		const historyPanel = window.locator('[data-tour="history-panel"]');
		await historyPanel.getByText('Preview fallback failed').click();
		await expect(
			window.getByText('Failure detail includes a blocked external renderer path.')
		).toBeVisible();
		const detailModal = getHistoryDetailModal(
			window,
			'Failure detail includes a blocked external renderer path.'
		);
		await expect(detailModal.getByTitle('Task failed')).toBeVisible();
	},
	async (window) => {
		const historyPanel = window.locator('[data-tour="history-panel"]');
		await historyPanel.getByRole('button', { name: 'USER' }).click();
		await expect(historyPanel.getByText('Manual file operation note')).toBeHidden();
		await historyPanel.getByRole('button', { name: 'USER' }).click();
		await expect(historyPanel.getByText('Manual file operation note')).toBeVisible();
	},
	async (window) => {
		const historyPanel = window.locator('[data-tour="history-panel"]');
		await historyPanel.getByText('Manual file operation note').click();
		await expect(
			window.getByText('Manual detail references draft/plain.txt and archive.md.')
		).toBeVisible();
		const detailModal = getHistoryDetailModal(
			window,
			'Manual detail references draft/plain.txt and archive.md.'
		);
		await detailModal.getByRole('button', { name: 'Close' }).click();
		await expect(detailModal).toBeHidden();
	},
	async (window) => {
		const historyPanel = window.locator('[data-tour="history-panel"]');
		await historyPanel.getByText('Manual file operation note').click();
		const detailModal = getHistoryDetailModal(
			window,
			'Manual detail references draft/plain.txt and archive.md.'
		);
		await expect(
			detailModal
				.locator('span')
				.filter({ hasText: /^USER$/ })
				.first()
		).toBeVisible();
		await expect(detailModal.getByTitle('Copy session ID: codex-history-manual')).toBeVisible();
	},
];

async function assertFileExplorerQuotaScenario(
	window: Page,
	workbench: ReturnType<typeof createFilesDocsHistoryWorkbench>,
	scenario: QuotaScenario
) {
	await helpers.openRightPanelTab(window, 'Files');
	await fileExplorerQuotaAssertions[scenario.variant % fileExplorerQuotaAssertions.length](
		window,
		workbench,
		scenario
	);
}

async function assertFilePreviewQuotaScenario(
	window: Page,
	workbench: ReturnType<typeof createFilesDocsHistoryWorkbench>,
	scenario: QuotaScenario
) {
	await filePreviewQuotaAssertions[scenario.variant % filePreviewQuotaAssertions.length](
		window,
		workbench,
		scenario
	);
}

async function assertHistoryQuotaScenario(window: Page, scenario: QuotaScenario) {
	await helpers.openRightPanelTab(window, 'History');
	await historyQuotaAssertions[scenario.variant % historyQuotaAssertions.length](window);
}

test.describe(`Files docs history lane matrix (${activeScenarioCount} active; ${skippedScenarioMatrix.length + envGatedScenarioMatrix.length} non-active residuals documented)`, () => {
	let window: Page;
	let cleanupApp: (() => Promise<void>) | undefined;
	let seededWorkbench: ReturnType<typeof createFilesDocsHistoryWorkbench>;

	test.beforeEach(async () => {
		seededWorkbench = createFilesDocsHistoryWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seededWorkbench.homeDir,
			sessions: seededWorkbench.sessions,
		});
		window = launched.window;
		cleanupApp = launched.cleanup;
		await seedHistoryEntries(window, seededWorkbench.projectDir, seededWorkbench.sessionId);
		await expect(window.getByText('Files Docs History Matrix')).toBeVisible();
	});

	test.afterEach(async () => {
		await cleanupApp?.();
		cleanupApp = undefined;
	});

	test(`${activeScenarioMatrix[0].id} ${activeScenarioMatrix[0].title}`, async () => {
		await helpers.openRightPanelTab(window, 'Files');
		await window.getByTitle('Expand all folders').click();
		const readmeRow = await getFileTreeRow(window, 'README.md');
		await readmeRow.click();
		await window.keyboard.press('Control+f');

		const filterInput = window.getByPlaceholder('Filter files...');
		await expect(filterInput).toBeVisible();
		await filterInput.fill('runbook');

		await getFileTreeRow(window, 'runbook.md');
		await expect(fileTreeRowLocator(window, 'archive.md')).toBeHidden();

		await filterInput.press('Escape');
		await expect(filterInput).toBeHidden();
		await getFileTreeRow(window, 'archive.md');
	});

	test(`${activeScenarioMatrix[1].id} ${activeScenarioMatrix[1].title}`, async () => {
		const contextMenu = await openFileContextMenu(window, 'README.md');

		await expect(contextMenu.getByRole('button', { name: 'Preview' })).toBeVisible();
		await expect(
			contextMenu.getByRole('button', { name: 'Document Graph', exact: true })
		).toBeVisible();
		await expect(contextMenu.getByRole('button', { name: 'Open in Default App' })).toBeVisible();
		await expect(contextMenu.getByRole('button', { name: 'Copy Path' })).toBeVisible();
		await expect(
			contextMenu.getByRole('button', { name: /Reveal in Finder|Show in Folder|Show in Explorer/ })
		).toBeVisible();
		await expect(contextMenu.getByRole('button', { name: 'Rename' })).toBeVisible();
		await expect(contextMenu.getByRole('button', { name: 'Delete' })).toBeVisible();
	});

	test(`${activeScenarioMatrix[2].id} ${activeScenarioMatrix[2].title}`, async () => {
		const contextMenu = await openFileContextMenu(window, 'README.md');
		await contextMenu.getByRole('button', { name: 'Rename' }).click();

		const renameDialog = window.getByRole('dialog', { name: 'Rename File' });
		await expect(renameDialog).toBeVisible();
		await renameDialog.getByPlaceholder('Enter file name...').fill('docs/escaped.md');
		await renameDialog.getByRole('button', { name: 'Rename' }).click();

		await expect(renameDialog.getByText('Name cannot contain slashes')).toBeVisible();
		await expect(fs.existsSync(seededWorkbench.readmePath)).toBe(true);
		await expect(fs.existsSync(path.join(seededWorkbench.projectDir, 'docs/escaped.md'))).toBe(
			false
		);
	});

	test(`${activeScenarioMatrix[3].id} ${activeScenarioMatrix[3].title}`, async () => {
		const contextMenu = await openFileContextMenu(window, 'docs');
		await contextMenu.getByRole('button', { name: 'Delete' }).click();

		const deleteDialog = window.getByRole('dialog', { name: 'Delete Folder' });
		await expect(deleteDialog).toBeVisible();
		await expect(
			deleteDialog.getByText('Are you sure you want to delete the folder "docs"?')
		).toBeVisible();

		await deleteDialog.getByRole('button', { name: 'Cancel' }).click();
		await expect(deleteDialog).toBeHidden();
		await getFileTreeRow(window, 'docs');
		await expect(fs.existsSync(seededWorkbench.runbookPath)).toBe(true);
		await expect(fs.existsSync(seededWorkbench.archivePath)).toBe(true);
	});

	test(`${activeScenarioMatrix[4].id} ${activeScenarioMatrix[4].title}`, async () => {
		await window.getByRole('link', { name: 'Runbook' }).click();

		await expect(window.getByText('Runbook Nested Preview')).toBeVisible();
		await expect(
			window.getByText('Nested runbook body for relative markdown link coverage.')
		).toBeVisible();

		await window.getByRole('link', { name: 'Root README' }).click();
		await expect(window.getByText('Files Docs History Matrix')).toBeVisible();
	});

	test(`${activeScenarioMatrix[5].id} ${activeScenarioMatrix[5].title}`, async () => {
		const savedSentinel = 'Plain text save sentinel.';
		const editedContent = `Plain preview starting line.\n${savedSentinel}\n`;

		await helpers.openRightPanelTab(window, 'Files');
		await window.getByTitle('Expand all folders').click();
		await getFileTreeRow(window, 'plain.txt');
		await window.getByText('plain.txt').dblclick();
		await expect(window.getByText('Plain preview starting line.')).toBeVisible();

		await window.getByTitle(/Edit file/).click();
		const editor = window.locator('textarea').first();
		await expect(editor).toBeVisible();
		await editor.fill(editedContent);
		await window.getByRole('button', { name: 'Save' }).click();

		await expect(window.getByText('File Saved')).toBeVisible();
		await expect(fs.readFileSync(seededWorkbench.plainTextPath, 'utf-8')).toContain(savedSentinel);
	});

	test(`${activeScenarioMatrix[6].id} ${activeScenarioMatrix[6].title}`, async () => {
		await expect(window.getByRole('heading', { name: 'Files Docs History Matrix' })).toBeVisible();
		await expect(window.getByText('Active tranche item')).toBeVisible();
		await expect(window.getByText('Completed tranche item')).toBeVisible();
		await expect(window.getByText('Scenario')).toBeVisible();
		await expect(window.getByRole('cell', { name: 'Preview', exact: true })).toBeVisible();
		await expect(window.getByText("const tranche = 'files-docs-history';")).toBeVisible();
	});

	test(`${activeScenarioMatrix[7].id} ${activeScenarioMatrix[7].title}`, async () => {
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');
		await expect(historyPanel.getByText('Rendered docs history tranche')).toBeVisible();

		await historyPanel.locator('[tabindex="0"]').focus();
		await window.keyboard.press('Control+f');
		const historyFilter = historyPanel.getByPlaceholder('Filter history...');
		await historyFilter.fill('codex-history-render');

		await expect(historyPanel.getByText('1 result')).toBeVisible();
		await historyPanel.getByText('Rendered docs history tranche').first().click();

		await expect(
			window.getByText('History detail includes README.md and docs/runbook.md render checks.')
		).toBeVisible();
		const detailModal = getHistoryDetailModal(
			window,
			'History detail includes README.md and docs/runbook.md render checks.'
		);
		await expect(detailModal.getByTitle('Task completed successfully')).toBeVisible();
		await expect(detailModal.getByTitle('Copy session ID: codex-history-render')).toBeVisible();
		await expect(detailModal.getByText('1m 10s')).toBeVisible();
		await expect(detailModal.getByText('$0.04')).toBeVisible();
	});

	test(`${activeScenarioMatrix[8].id} ${activeScenarioMatrix[8].title}`, async () => {
		await helpers.openRightPanelTab(window, 'Files');
		await window.getByTitle('Expand all folders').click();
		await getFileTreeRow(window, 'runbook.md');

		await window.getByTitle('Collapse all folders').click();
		await expect(fileTreeRowLocator(window, 'runbook.md')).toBeHidden();
		await expect(fileTreeRowLocator(window, 'archive.md')).toBeHidden();

		await window.getByTitle('Expand all folders').click();
		await getFileTreeRow(window, 'runbook.md');
		await getFileTreeRow(window, 'archive.md');
	});

	test(`${activeScenarioMatrix[9].id} ${activeScenarioMatrix[9].title}`, async () => {
		await helpers.openRightPanelTab(window, 'Files');
		const readmeRow = await getFileTreeRow(window, 'README.md');
		await readmeRow.click();
		await window.keyboard.press('Control+f');

		const filterInput = window.getByPlaceholder('Filter files...');
		await filterInput.fill('__missing_file_docs_history__');
		await expect(window.getByText('No files match your search')).toBeVisible();

		await filterInput.fill('plain');
		await getFileTreeRow(window, 'plain.txt');
		await expect(window.getByText('No files match your search')).toBeHidden();
	});

	test(`${activeScenarioMatrix[10].id} ${activeScenarioMatrix[10].title}`, async () => {
		const contextMenu = await openFileContextMenu(window, 'docs');
		await contextMenu.getByRole('button', { name: 'Delete' }).click();

		const deleteDialog = window.getByRole('dialog', { name: 'Delete Folder' });
		await expect(deleteDialog).toBeVisible();
		await expect(deleteDialog.getByText('This folder contains 2 files')).toBeVisible();
		await deleteDialog.getByRole('button', { name: 'Delete' }).click();

		await expect(deleteDialog).toBeHidden();
		await expect(window.getByText('Deleted "docs"')).toBeVisible();
		await expect(fileTreeRowLocator(window, 'docs')).toBeHidden();
		await expect(fs.existsSync(seededWorkbench.runbookPath)).toBe(false);
		await expect(fs.existsSync(seededWorkbench.archivePath)).toBe(false);
	});

	test(`${activeScenarioMatrix[11].id} ${activeScenarioMatrix[11].title}`, async () => {
		const contextMenu = await openFileContextMenu(window, 'docs');
		await contextMenu.getByRole('button', { name: 'Rename' }).click();

		const renameDialog = window.getByRole('dialog', { name: 'Rename Folder' });
		await expect(renameDialog).toBeVisible();
		await renameDialog.getByPlaceholder('Enter folder name...').fill('notes/escaped');
		await renameDialog.getByRole('button', { name: 'Rename' }).click();

		await expect(renameDialog.getByText('Name cannot contain slashes')).toBeVisible();
		await expect(fs.existsSync(path.join(seededWorkbench.projectDir, 'docs'))).toBe(true);
		await expect(fs.existsSync(path.join(seededWorkbench.projectDir, 'notes/escaped'))).toBe(false);
	});

	test(`${activeScenarioMatrix[12].id} ${activeScenarioMatrix[12].title}`, async () => {
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');
		await historyPanel.getByText('Preview fallback failed').click();

		await expect(
			window.getByText('Failure detail includes a blocked external renderer path.')
		).toBeVisible();
		const detailModal = getHistoryDetailModal(
			window,
			'Failure detail includes a blocked external renderer path.'
		);
		await expect(detailModal.getByTitle('Task failed')).toBeVisible();
		await expect(
			detailModal.getByTitle('Copy session ID: codex-history-preview-failure')
		).toBeVisible();
		await expect(detailModal.getByText('14s')).toBeVisible();
		await expect(detailModal.getByTitle('Mark as human-validated')).toBeHidden();
	});

	test(`${activeScenarioMatrix[13].id} ${activeScenarioMatrix[13].title}`, async () => {
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');
		await historyPanel.locator('[tabindex="0"]').focus();
		await window.keyboard.press('Control+f');

		const historyFilter = historyPanel.getByPlaceholder('Filter history...');
		await historyFilter.fill('archive.md');
		await expect(historyPanel.getByText('1 result')).toBeVisible();
		await historyPanel.getByText('Manual file operation note').click();

		const detailModal = getHistoryDetailModal(
			window,
			'Manual detail references draft/plain.txt and archive.md.'
		);
		await expect(detailModal).toBeVisible();
		await expect(detailModal.getByText('USER', { exact: true })).toBeVisible();
		await expect(detailModal.getByTitle('Copy session ID: codex-history-manual')).toBeVisible();
	});

	test(`${activeScenarioMatrix[14].id} ${activeScenarioMatrix[14].title}`, async () => {
		const renamedPath = path.join(seededWorkbench.projectDir, 'OVERVIEW.md');
		const contextMenu = await openFileContextMenu(window, 'README.md');
		await contextMenu.getByRole('button', { name: 'Rename' }).click();

		const renameDialog = window.getByRole('dialog', { name: 'Rename File' });
		await expect(renameDialog).toBeVisible();
		await renameDialog.getByPlaceholder('Enter file name...').fill('OVERVIEW.md');
		await renameDialog.getByRole('button', { name: 'Rename' }).click();

		await expect(renameDialog).toBeHidden();
		await expect(window.getByText('Renamed to "OVERVIEW.md"')).toBeVisible();
		await getFileTreeRow(window, 'OVERVIEW.md');
		await expect(fileTreeRowLocator(window, 'README.md')).toBeHidden();
		await expect(fs.existsSync(renamedPath)).toBe(true);
		await expect(fs.existsSync(seededWorkbench.readmePath)).toBe(false);
	});

	test(`${activeScenarioMatrix[15].id} ${activeScenarioMatrix[15].title}`, async () => {
		const renamedFolderPath = path.join(seededWorkbench.projectDir, 'guides');
		const contextMenu = await openFileContextMenu(window, 'docs');
		await contextMenu.getByRole('button', { name: 'Rename' }).click();

		const renameDialog = window.getByRole('dialog', { name: 'Rename Folder' });
		await expect(renameDialog).toBeVisible();
		await renameDialog.getByPlaceholder('Enter folder name...').fill('guides');
		await renameDialog.getByRole('button', { name: 'Rename' }).click();

		await expect(renameDialog).toBeHidden();
		await expect(window.getByText('Renamed to "guides"')).toBeVisible();
		await getFileTreeRow(window, 'guides');
		await expect(fileTreeRowLocator(window, 'docs')).toBeHidden();
		await expect(fs.existsSync(renamedFolderPath)).toBe(true);
		await expect(fs.existsSync(path.join(renamedFolderPath, 'runbook.md'))).toBe(true);
		await expect(fs.existsSync(path.join(renamedFolderPath, 'archive.md'))).toBe(true);
	});

	test(`${activeScenarioMatrix[16].id} ${activeScenarioMatrix[16].title}`, async () => {
		await helpers.openRightPanelTab(window, 'Files');
		await window.getByTitle('Expand all folders').click();
		const contextMenu = await openFileContextMenu(window, 'archive.md');
		await contextMenu.getByRole('button', { name: 'Delete' }).click();

		const deleteDialog = window.getByRole('dialog', { name: 'Delete File' });
		await expect(deleteDialog).toBeVisible();
		await expect(
			deleteDialog.getByText('Are you sure you want to delete the file "archive.md"?')
		).toBeVisible();

		await deleteDialog.getByRole('button', { name: 'Cancel' }).click();
		await expect(deleteDialog).toBeHidden();
		await getFileTreeRow(window, 'archive.md');
		await expect(fs.existsSync(seededWorkbench.archivePath)).toBe(true);
	});

	test(`${activeScenarioMatrix[17].id} ${activeScenarioMatrix[17].title}`, async () => {
		await helpers.openRightPanelTab(window, 'Files');
		await window.getByTitle('Expand all folders').click();
		const contextMenu = await openFileContextMenu(window, 'archive.md');
		await contextMenu.getByRole('button', { name: 'Delete' }).click();

		const deleteDialog = window.getByRole('dialog', { name: 'Delete File' });
		await expect(deleteDialog).toBeVisible();
		await deleteDialog.getByRole('button', { name: 'Delete' }).click();

		await expect(deleteDialog).toBeHidden();
		await expect(window.getByText('Deleted "archive.md"')).toBeVisible();
		await expect(fileTreeRowLocator(window, 'archive.md')).toBeHidden();
		await expect(fs.existsSync(seededWorkbench.archivePath)).toBe(false);
		await expect(fs.existsSync(seededWorkbench.runbookPath)).toBe(true);
	});

	test(`${activeScenarioMatrix[18].id} ${activeScenarioMatrix[18].title}`, async () => {
		await helpers.openRightPanelTab(window, 'Files');
		await window.getByTitle('Expand all folders').click();
		const contextMenu = await openFileContextMenu(window, 'archive.md');
		await contextMenu.getByRole('button', { name: 'Preview' }).click();

		await expect(window.getByRole('heading', { name: 'Archive Notes' })).toBeVisible();
		await expect(
			window.getByText('Archive body should survive cancelled folder deletion.')
		).toBeVisible();
	});

	test(`${activeScenarioMatrix[19].id} ${activeScenarioMatrix[19].title}`, async () => {
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');
		await historyPanel.locator('[tabindex="0"]').focus();
		await window.keyboard.press('Control+f');

		const historyFilter = historyPanel.getByPlaceholder('Filter history...');
		await historyFilter.fill('codex-history-preview-failure');
		await expect(historyPanel.getByText('1 result')).toBeVisible();
		await expect(historyPanel.getByText('Preview fallback failed')).toBeVisible();
		await expect(historyPanel.getByText('Rendered docs history tranche')).toBeHidden();

		await historyFilter.press('Escape');
		await expect(historyFilter).toBeHidden();
		await expect(historyPanel.getByText('Rendered docs history tranche')).toBeVisible();
		await expect(historyPanel.getByText('Preview fallback failed')).toBeVisible();
		await expect(historyPanel.getByText('Manual file operation note')).toBeVisible();
	});

	test(`${activeScenarioMatrix[20].id} ${activeScenarioMatrix[20].title}`, async () => {
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');
		await historyPanel.getByText('Rendered docs history tranche').first().click();
		const detailModal = getHistoryDetailModal(
			window,
			'History detail includes README.md and docs/runbook.md render checks.'
		);

		await expect(detailModal.getByTitle('Mark as human-validated')).toBeVisible();
		await detailModal.getByTitle('Mark as human-validated').click();

		await expect(detailModal.getByTitle('Mark as not validated')).toBeVisible();
		await expect(
			detailModal.getByTitle('Task completed successfully and human-validated')
		).toBeVisible();
		await window.keyboard.press('Escape');
		await expect(detailModal).toBeHidden();
		await expect(
			historyPanel.getByTitle('Task completed successfully and human-validated').first()
		).toBeVisible();
	});

	test(`${activeScenarioMatrix[21].id} ${activeScenarioMatrix[21].title}`, async () => {
		await window.keyboard.press('Control+f');
		const fileSearch = window.getByPlaceholder(
			'Search in file... (Enter: next, Shift+Enter: prev)'
		);
		await expect(fileSearch).toBeVisible();

		await fileSearch.fill('Preview');
		await expect(window.getByText('1/2')).toBeVisible();
		await fileSearch.press('Enter');
		await expect(window.getByText('2/2')).toBeVisible();
		await fileSearch.press('Shift+Enter');
		await expect(window.getByText('1/2')).toBeVisible();

		await fileSearch.press('Escape');
		await expect(fileSearch).toBeHidden();
	});

	test(`${activeScenarioMatrix[22].id} ${activeScenarioMatrix[22].title}`, async () => {
		const contextMenu = await openFileContextMenu(window, 'README.md');
		await contextMenu.getByRole('button', { name: 'Rename' }).click();

		const renameDialog = window.getByRole('dialog', { name: 'Rename File' });
		await expect(renameDialog).toBeVisible();
		await renameDialog.getByPlaceholder('Enter file name...').fill('CANCELLED.md');
		await renameDialog.getByRole('button', { name: 'Cancel' }).click();

		await expect(renameDialog).toBeHidden();
		await getFileTreeRow(window, 'README.md');
		await expect(fileTreeRowLocator(window, 'CANCELLED.md')).toBeHidden();
		await expect(fs.existsSync(seededWorkbench.readmePath)).toBe(true);
		await expect(fs.existsSync(path.join(seededWorkbench.projectDir, 'CANCELLED.md'))).toBe(false);
	});

	test(`${activeScenarioMatrix[23].id} ${activeScenarioMatrix[23].title}`, async () => {
		const contextMenu = await openFileContextMenu(window, 'docs');
		await contextMenu.getByRole('button', { name: 'Rename' }).click();

		const renameDialog = window.getByRole('dialog', { name: 'Rename Folder' });
		await expect(renameDialog).toBeVisible();
		await expect(renameDialog.getByRole('button', { name: 'Rename' })).toBeDisabled();
		await renameDialog.getByPlaceholder('Enter folder name...').fill('docs');
		await expect(renameDialog.getByRole('button', { name: 'Rename' })).toBeDisabled();

		await renameDialog.getByRole('button', { name: 'Cancel' }).click();
		await expect(renameDialog).toBeHidden();
		await getFileTreeRow(window, 'docs');
	});

	test(`${activeScenarioMatrix[24].id} ${activeScenarioMatrix[24].title}`, async () => {
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');

		await historyPanel.getByRole('button', { name: 'AUTO' }).click();
		await expect(historyPanel.getByText('Manual file operation note')).toBeVisible();
		await expect(historyPanel.getByText('Rendered docs history tranche')).toBeHidden();
		await expect(historyPanel.getByText('Preview fallback failed')).toBeHidden();

		await historyPanel.getByRole('button', { name: 'AUTO' }).click();
		await expect(historyPanel.getByText('Rendered docs history tranche')).toBeVisible();
		await expect(historyPanel.getByText('Preview fallback failed')).toBeVisible();
	});

	test(`${activeScenarioMatrix[25].id} ${activeScenarioMatrix[25].title}`, async () => {
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');
		await historyPanel.getByText('Manual file operation note').click();

		let detailModal = getHistoryDetailModal(
			window,
			'Manual detail references draft/plain.txt and archive.md.'
		);
		await expect(detailModal).toBeVisible();
		await detailModal.getByRole('button', { name: 'Next' }).click();
		detailModal = getHistoryDetailModal(
			window,
			'History achievement action opens the About Maestro achievements view.'
		);
		await expect(detailModal).toBeVisible();
		await detailModal.getByRole('button', { name: 'Next' }).click();
		detailModal = getHistoryDetailModal(
			window,
			'Failure detail includes a blocked external renderer path.'
		);
		await expect(detailModal).toBeVisible();
		await detailModal.getByRole('button', { name: 'Next' }).click();
		detailModal = getHistoryDetailModal(
			window,
			'History detail includes README.md and docs/runbook.md render checks.'
		);
		await expect(detailModal).toBeVisible();
		await detailModal.getByRole('button', { name: 'Prev' }).click();
		detailModal = getHistoryDetailModal(
			window,
			'Failure detail includes a blocked external renderer path.'
		);
		await expect(detailModal).toBeVisible();
	});

	test(`${activeScenarioMatrix[26].id} ${activeScenarioMatrix[26].title}`, async () => {
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');
		await historyPanel.getByText('Preview fallback failed').click();

		const detailModal = getHistoryDetailModal(
			window,
			'Failure detail includes a blocked external renderer path.'
		);
		await expect(detailModal).toBeVisible();
		await detailModal.getByRole('button', { name: 'Delete' }).click();

		const deleteConfirm = window
			.locator('.fixed.inset-0')
			.filter({ hasText: 'Delete History Entry' })
			.last();
		await expect(deleteConfirm.getByText('Delete History Entry')).toBeVisible();
		await expect(
			deleteConfirm.getByText('Are you sure you want to delete this auto history entry?')
		).toBeVisible();
		await deleteConfirm.getByRole('button', { name: 'Delete' }).click();

		await expect(detailModal).toBeHidden();
		await expect(historyPanel.getByText('Preview fallback failed')).toBeHidden();
		await expect(historyPanel.getByText('Rendered docs history tranche')).toBeVisible();
		await expect(historyPanel.getByText('Manual file operation note')).toBeVisible();
	});

	test(`${activeScenarioMatrix[27].id} ${activeScenarioMatrix[27].title}`, async () => {
		await helpers.openRightPanelTab(window, 'Files');
		await window.getByTitle('Expand all folders').click();
		await window.keyboard.press('Control+f');

		const filterInput = window.getByPlaceholder('Filter files...');
		await filterInput.fill('plain');
		const plainTextRow = await getFileTreeRow(window, 'plain.txt');
		await expect(fileTreeRowLocator(window, 'runbook.md')).toBeHidden();

		await plainTextRow.dblclick();
		await expect(window.getByText('Plain preview starting line.')).toBeVisible();
		await expect(window.getByText('Plain preview editable line.')).toBeVisible();

		await filterInput.press('Escape');
		await expect(filterInput).toBeHidden();
		await getFileTreeRow(window, 'runbook.md');
	});

	test(`${activeScenarioMatrix[28].id} ${activeScenarioMatrix[28].title}`, async () => {
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');

		await historyPanel.getByRole('button', { name: 'USER' }).click();
		await expect(historyPanel.getByText('Manual file operation note')).toBeHidden();
		await expect(historyPanel.getByText('Rendered docs history tranche')).toBeVisible();
		await expect(historyPanel.getByText('Preview fallback failed')).toBeVisible();

		await historyPanel.getByRole('button', { name: 'USER' }).click();
		await expect(historyPanel.getByText('Manual file operation note')).toBeVisible();
	});

	test(`${activeScenarioMatrix[29].id} ${activeScenarioMatrix[29].title}`, async () => {
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');
		await historyPanel.getByText('Preview fallback failed').click();

		await expect(
			window.getByText('Failure detail includes a blocked external renderer path.')
		).toBeVisible();
		await window.getByRole('button', { name: 'Delete' }).click();

		const deleteConfirm = window.locator('.fixed').filter({ hasText: 'Delete History Entry' });
		await expect(deleteConfirm.getByText('Delete History Entry')).toBeVisible();
		await deleteConfirm.getByRole('button', { name: 'Cancel' }).click();

		await expect(deleteConfirm).toBeHidden();
		await expect(
			window.getByText('Failure detail includes a blocked external renderer path.')
		).toBeVisible();
		await window.keyboard.press('Escape');
		await expect(historyPanel.getByText('Preview fallback failed')).toBeVisible();
	});

	test(`${activeScenarioMatrix[30].id} ${activeScenarioMatrix[30].title}`, async () => {
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');
		await historyPanel.locator('[tabindex="0"]').focus();
		await window.keyboard.press('Control+f');

		const historyFilter = historyPanel.getByPlaceholder('Filter history...');
		await historyFilter.fill('definitely-missing-history-entry');
		await expect(historyPanel.getByText('0 results')).toBeVisible();
		await expect(
			historyPanel.getByText('No entries match "definitely-missing-history-entry"')
		).toBeVisible();

		await historyFilter.press('Escape');
		await expect(historyFilter).toBeHidden();
		await expect(historyPanel.getByText('Rendered docs history tranche')).toBeVisible();
		await expect(historyPanel.getByText('Preview fallback failed')).toBeVisible();
		await expect(historyPanel.getByText('Manual file operation note')).toBeVisible();
	});

	test(`${activeScenarioMatrix[31].id} ${activeScenarioMatrix[31].title}`, async () => {
		const contextMenu = await openFileContextMenu(window, 'docs');
		await contextMenu.getByRole('button', { name: 'Delete' }).click();

		const deleteDialog = window.getByRole('dialog', { name: 'Delete Folder' });
		await expect(deleteDialog).toBeVisible();
		await window.keyboard.press('Escape');

		await expect(deleteDialog).toBeHidden();
		await getFileTreeRow(window, 'docs');
		await expect(fs.existsSync(seededWorkbench.runbookPath)).toBe(true);
		await expect(fs.existsSync(seededWorkbench.archivePath)).toBe(true);
	});

	test(`${activeScenarioMatrix[32].id} ${activeScenarioMatrix[32].title}`, async ({
		electronApp,
	}) => {
		await expect(window.getByRole('heading', { name: 'Files Docs History Matrix' })).toBeVisible();
		await clearClipboard(electronApp);

		await window.getByTitle('Copy content to clipboard').click();

		await expect(window.getByText('Content Copied to Clipboard')).toBeVisible();
		await expectClipboardText(electronApp, fs.readFileSync(seededWorkbench.readmePath, 'utf-8'));
	});

	test(`${activeScenarioMatrix[33].id} ${activeScenarioMatrix[33].title}`, async ({
		electronApp,
	}) => {
		await expect(window.getByRole('heading', { name: 'Files Docs History Matrix' })).toBeVisible();
		await clearClipboard(electronApp);

		await window.getByTitle('Copy full path to clipboard').click();

		await expect(window.getByText('File Path Copied to Clipboard')).toBeVisible();
		await expectClipboardText(electronApp, seededWorkbench.readmePath);
	});

	test(`${activeScenarioMatrix[34].id} ${activeScenarioMatrix[34].title}`, async () => {
		const unsavedSentinel = 'Unsaved plain text sentinel.';
		await helpers.openRightPanelTab(window, 'Files');
		await window.getByTitle('Expand all folders').click();
		await window.getByText('plain.txt').dblclick();
		await expect(window.getByText('Plain preview starting line.')).toBeVisible();

		await window.getByTitle(/Edit file/).click();
		const editor = window.locator('textarea').first();
		await expect(editor).toBeVisible();
		await editor.fill(`Plain preview starting line.\n${unsavedSentinel}\n`);
		await editor.press('Escape');

		await expect(editor).toBeHidden();
		await expect(window.getByText('Plain preview starting line.')).toBeVisible();
		await expect(window.getByText(unsavedSentinel)).toBeHidden();
		await expect(fs.readFileSync(seededWorkbench.plainTextPath, 'utf-8')).not.toContain(
			unsavedSentinel
		);
	});

	test(`${activeScenarioMatrix[35].id} ${activeScenarioMatrix[35].title}`, async () => {
		const markdownSentinel = 'Saved markdown edit sentinel.';
		await expect(window.getByRole('heading', { name: 'Files Docs History Matrix' })).toBeVisible();

		await window.getByTitle(/Edit file/).click();
		const saveButton = window.getByRole('button', { name: 'Save' });
		const editor = window.locator('textarea').first();
		await expect(editor).toBeVisible();
		await expect(saveButton).toBeDisabled();

		await editor.fill(`# Files Docs History Matrix\n\n${markdownSentinel}\n`);
		await expect(saveButton).toBeEnabled();
		await saveButton.click();

		await expect(window.getByText('File Saved')).toBeVisible();
		await expect(saveButton).toBeDisabled();
		await expect(fs.readFileSync(seededWorkbench.readmePath, 'utf-8')).toContain(markdownSentinel);
	});

	test(`${activeScenarioMatrix[36].id} ${activeScenarioMatrix[36].title}`, async () => {
		await window.keyboard.press('Control+f');
		const fileSearch = window.getByPlaceholder(
			'Search in file... (Enter: next, Shift+Enter: prev)'
		);
		await expect(fileSearch).toBeVisible();

		await fileSearch.fill('__missing_preview_search_term__');
		await expect(window.getByText('No matches')).toBeVisible();

		await fileSearch.fill('Preview');
		await expect(window.getByText('1/2')).toBeVisible();
		await fileSearch.press('Escape');
		await expect(fileSearch).toBeHidden();
	});

	test(`${activeScenarioMatrix[37].id} ${activeScenarioMatrix[37].title}`, async () => {
		await window.getByRole('link', { name: 'Runbook' }).click();
		await expect(window.getByText('Runbook Nested Preview')).toBeVisible();

		await window.getByRole('link', { name: 'Root README' }).click();

		await expect(window.getByRole('heading', { name: 'Files Docs History Matrix' })).toBeVisible();
		await expect(
			window.getByText('Preview prose for the files docs history tranche.')
		).toBeVisible();
	});

	test(`${activeScenarioMatrix[38].id} ${activeScenarioMatrix[38].title}`, async ({
		electronApp,
	}) => {
		await clearClipboard(electronApp);
		const contextMenu = await openFileContextMenu(window, 'README.md');

		await contextMenu.getByRole('button', { name: 'Copy Path' }).click();

		await expect(window.getByText('File Path Copied to Clipboard')).toBeVisible();
		await expectClipboardText(electronApp, seededWorkbench.readmePath);
	});

	test(`${activeScenarioMatrix[39].id} ${activeScenarioMatrix[39].title}`, async () => {
		await helpers.openRightPanelTab(window, 'Files');
		await window.getByTitle('Expand all folders').click();
		const contextMenu = await openFileContextMenu(window, 'plain.txt');

		await contextMenu.getByRole('button', { name: 'Preview' }).click();

		await expect(window.getByText('Plain preview starting line.')).toBeVisible();
		await expect(window.getByText('Plain preview editable line.')).toBeVisible();
	});

	test(`${activeScenarioMatrix[40].id} ${activeScenarioMatrix[40].title}`, async () => {
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');
		await historyPanel.getByText('Preview fallback failed').click();
		await expect(
			window.getByText('Failure detail includes a blocked external renderer path.')
		).toBeVisible();

		await window.keyboard.press('Escape');

		await expect(
			window.getByText('Failure detail includes a blocked external renderer path.')
		).toBeHidden();
		await expect(historyPanel.getByText('Preview fallback failed')).toBeVisible();
		await expect(historyPanel.getByText('Rendered docs history tranche')).toBeVisible();
	});

	test(`${activeScenarioMatrix[41].id} ${activeScenarioMatrix[41].title}`, async ({
		electronApp,
	}) => {
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');
		await clearClipboard(electronApp);
		await historyPanel.getByText('Preview fallback failed').click();

		const detailModal = getHistoryDetailModal(
			window,
			'Failure detail includes a blocked external renderer path.'
		);
		await expect(detailModal).toBeVisible();
		await detailModal.getByTitle('Copy session ID: codex-history-preview-failure').click();

		await expectClipboardText(electronApp, 'codex-history-preview-failure');
	});

	test(`${activeScenarioMatrix[42].id} ${activeScenarioMatrix[42].title}`, async () => {
		const contextMenu = await openFileContextMenu(window, 'README.md');
		await expect(contextMenu.getByRole('button', { name: 'Rename' })).toBeVisible();

		await window.keyboard.press('Escape');

		await expect(contextMenu.getByRole('button', { name: 'Rename' })).toBeHidden();
		await expect(window.getByRole('dialog', { name: 'Rename File' })).toBeHidden();
	});

	test(`${activeScenarioMatrix[43].id} ${activeScenarioMatrix[43].title}`, async () => {
		await helpers.openRightPanelTab(window, 'Files');
		await getFileTreeRow(window, '.secret.md');

		await window.getByTitle('Hide dotfiles').click();
		await expect(fileTreeRowLocator(window, '.secret.md')).toBeHidden();

		await window.getByTitle('Show dotfiles').click();
		await getFileTreeRow(window, '.secret.md');
	});

	test(`${activeScenarioMatrix[44].id} ${activeScenarioMatrix[44].title}`, async () => {
		await helpers.openRightPanelTab(window, 'Files');
		await window.getByTitle('Auto-refresh every 180s').hover();

		const autoRefreshMenu = window
			.locator('body > div.fixed')
			.filter({ hasText: 'Disable auto-refresh' })
			.last();
		await expect(autoRefreshMenu.getByText('Auto-refresh', { exact: true })).toBeVisible();
		await autoRefreshMenu.getByText('Disable auto-refresh').click();

		await expect(window.getByTitle('Refresh file tree')).toBeVisible();
	});

	test(`${activeScenarioMatrix[45].id} ${activeScenarioMatrix[45].title}`, async () => {
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');
		const successRow = historyPanel
			.locator('[data-index]')
			.filter({ hasText: 'Rendered docs history tranche' })
			.first();

		await expect(successRow).toBeVisible();
		await expect(successRow.getByText('1m 10s')).toBeVisible();
		await expect(successRow.getByText('$0.04')).toBeVisible();
	});

	test(`${activeScenarioMatrix[46].id} ${activeScenarioMatrix[46].title}`, async () => {
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');

		await expect(historyPanel.getByText('Achievement file history milestone')).toBeVisible();
		await historyPanel.getByRole('button', { name: 'View Achievements' }).click();

		const aboutDialog = window.getByRole('dialog', { name: 'About Maestro' });
		await expect(aboutDialog.getByRole('heading', { name: 'About Maestro' })).toBeVisible();
	});

	test(`${activeScenarioMatrix[47].id} ${activeScenarioMatrix[47].title}`, async () => {
		await helpers.openRightPanelTab(window, 'Files');
		await window.getByTitle('Expand all folders').click();
		const contextMenu = await openFileContextMenu(window, 'runbook.md');
		await contextMenu.getByRole('button', { name: 'Document Graph', exact: true }).click();

		const graphDialog = window.getByRole('dialog', { name: 'Document Graph' });
		await expect(graphDialog).toBeVisible({ timeout: 15_000 });
		await expect(graphDialog.getByText(/Parsing documents|No documents found/).first()).toBeVisible(
			{ timeout: 15_000 }
		);
	});

	test(`${activeScenarioMatrix[48].id} ${activeScenarioMatrix[48].title}`, async () => {
		await expect(window.getByRole('heading', { name: 'Files Docs History Matrix' })).toBeVisible();

		await window.getByTitle('Table of Contents').click();

		await expect(window.getByText('Contents')).toBeVisible();
		await expect(window.getByText('2 headings')).toBeVisible();
		await expect(window.getByTitle('Files Docs History Matrix')).toBeVisible();
		await expect(window.getByTitle('Runbook Follow-up')).toBeVisible();
	});

	test(`${activeScenarioMatrix[49].id} ${activeScenarioMatrix[49].title}`, async () => {
		await expect(window.getByRole('heading', { name: 'Files Docs History Matrix' })).toBeVisible();

		await expect(window.getByText('Remote image blocked')).toBeVisible();
		await expect(window.getByTitle('Show remote images')).toBeVisible();
	});

	test(`${activeScenarioMatrix[50].id} ${activeScenarioMatrix[50].title}`, async () => {
		const freshPath = path.join(seededWorkbench.projectDir, 'docs', 'fresh.md');
		fs.writeFileSync(freshPath, '# Fresh manual refresh file\n', 'utf-8');

		await helpers.openRightPanelTab(window, 'Files');
		await window.getByTitle('Expand all folders').click();
		await expect(window.getByText('fresh.md')).toBeHidden();
		await window.getByTitle('Auto-refresh every 180s').click();

		await getFileTreeRow(window, 'fresh.md');
	});

	test(`${activeScenarioMatrix[51].id} ${activeScenarioMatrix[51].title}`, async () => {
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');
		await historyPanel.locator('[tabindex="0"]').focus();
		await window.keyboard.press('Control+f');

		const historyFilter = historyPanel.getByPlaceholder('Filter history...');
		await historyFilter.fill('Files Docs History Agent');

		await expect(historyPanel.getByText('4 results')).toBeVisible();
		await expect(historyPanel.getByText('Rendered docs history tranche')).toBeVisible();
		await expect(historyPanel.getByText('Achievement file history milestone')).toBeVisible();
	});

	test(`${activeScenarioMatrix[52].id} ${activeScenarioMatrix[52].title}`, async () => {
		await helpers.openRightPanelTab(window, 'Files');
		const readmeRow = await getFileTreeRow(window, 'README.md');
		await readmeRow.click();
		await window.keyboard.press('Control+f');

		const filterInput = window.getByPlaceholder('Filter files...');
		await filterInput.fill('secret');

		await getFileTreeRow(window, '.secret.md');
		await expect(fileTreeRowLocator(window, 'README.md')).toBeHidden();
	});

	test(`${activeScenarioMatrix[53].id} ${activeScenarioMatrix[53].title}`, async () => {
		const contextMenu = await openFileContextMenu(window, 'docs');

		await expect(contextMenu.getByRole('button', { name: 'Preview' })).toBeHidden();
		await expect(
			contextMenu.getByRole('button', { name: 'Document Graph', exact: true })
		).toBeHidden();
		await expect(contextMenu.getByRole('button', { name: 'Open in Default App' })).toBeHidden();
		await expect(contextMenu.getByRole('button', { name: 'Copy Path' })).toBeVisible();
		await expect(contextMenu.getByRole('button', { name: 'Rename' })).toBeVisible();
		await expect(contextMenu.getByRole('button', { name: 'Delete' })).toBeVisible();
	});

	test(`${activeScenarioMatrix[54].id} ${activeScenarioMatrix[54].title}`, async () => {
		const contextMenu = await openFileContextMenu(window, 'README.md');
		await contextMenu.getByRole('button', { name: 'Rename' }).click();

		const renameDialog = window.getByRole('dialog', { name: 'Rename File' });
		await expect(renameDialog).toBeVisible();
		await expect(renameDialog.getByRole('button', { name: 'Rename' })).toBeDisabled();
		await renameDialog.getByPlaceholder('Enter file name...').fill('README.md');
		await expect(renameDialog.getByRole('button', { name: 'Rename' })).toBeDisabled();

		await renameDialog.getByRole('button', { name: 'Cancel' }).click();
		await expect(renameDialog).toBeHidden();
		await getFileTreeRow(window, 'README.md');
	});

	test(`${activeScenarioMatrix[55].id} ${activeScenarioMatrix[55].title}`, async () => {
		await helpers.openRightPanelTab(window, 'Files');
		await window.getByTitle('Expand all folders').click();
		const contextMenu = await openFileContextMenu(window, 'archive.md');
		await contextMenu.getByRole('button', { name: 'Delete' }).click();

		const deleteDialog = window.getByRole('dialog', { name: 'Delete File' });
		await expect(deleteDialog).toBeVisible();
		await window.keyboard.press('Escape');

		await expect(deleteDialog).toBeHidden();
		await getFileTreeRow(window, 'archive.md');
		await expect(fs.existsSync(seededWorkbench.archivePath)).toBe(true);
	});

	test(`${activeScenarioMatrix[56].id} ${activeScenarioMatrix[56].title}`, async () => {
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');
		await historyPanel.getByText('Manual file operation note').click();
		let detailModal = getHistoryDetailModal(
			window,
			'Manual detail references draft/plain.txt and archive.md.'
		);
		await expect(detailModal).toBeVisible();

		await window.keyboard.press('ArrowRight');
		detailModal = getHistoryDetailModal(
			window,
			'History achievement action opens the About Maestro achievements view.'
		);
		await expect(detailModal).toBeVisible();

		await window.keyboard.press('ArrowRight');
		detailModal = getHistoryDetailModal(
			window,
			'Failure detail includes a blocked external renderer path.'
		);
		await expect(detailModal).toBeVisible();

		await window.keyboard.press('ArrowLeft');
		detailModal = getHistoryDetailModal(
			window,
			'History achievement action opens the About Maestro achievements view.'
		);
		await expect(detailModal).toBeVisible();
	});

	test(`${activeScenarioMatrix[57].id} ${activeScenarioMatrix[57].title}`, async () => {
		await helpers.openRightPanelTab(window, 'History');
		await window.getByTitle('History panel help').click();

		await expect(window.getByText('History Panel Guide')).toBeVisible();
		await expect(window.getByText('Entry Types')).toBeVisible();
		await expect(window.getByText('Viewing Details')).toBeVisible();

		await window.getByRole('button', { name: 'Got it' }).click();
		await expect(window.getByText('History Panel Guide')).toBeHidden();
	});

	test(`${activeScenarioMatrix[58].id} ${activeScenarioMatrix[58].title}`, async () => {
		await helpers.openRightPanelTab(window, 'Files');
		await window.getByTitle('Expand all folders').click();
		await window.getByText('plain.txt').dblclick();
		await expect(window.getByText('Plain preview starting line.')).toBeVisible();
		await window.keyboard.press('Control+f');

		const fileSearch = window.getByPlaceholder(
			'Search in file... (Enter: next, Shift+Enter: prev)'
		);
		await fileSearch.fill('Plain preview');

		await expect(window.getByText('1/2')).toBeVisible();
		await fileSearch.press('Enter');
		await expect(window.getByText('2/2')).toBeVisible();
		await fileSearch.press('Shift+Enter');
		await expect(window.getByText('1/2')).toBeVisible();
	});

	test(`${activeScenarioMatrix[59].id} ${activeScenarioMatrix[59].title}`, async () => {
		await expect(window.getByText("const tranche = 'files-docs-history';")).toBeVisible();
		await window.keyboard.press('Control+f');

		const fileSearch = window.getByPlaceholder(
			'Search in file... (Enter: next, Shift+Enter: prev)'
		);
		await fileSearch.fill('const tranche');

		await expect(window.getByText('1/1')).toBeVisible();
		await fileSearch.press('Escape');
		await expect(fileSearch).toBeHidden();
	});

	test(`${activeScenarioMatrix[60].id} ${activeScenarioMatrix[60].title}`, async () => {
		const contextMenu = await openFileContextMenu(window, 'docs');
		await contextMenu.getByRole('button', { name: 'Rename' }).click();

		const renameDialog = window.getByRole('dialog', { name: 'Rename Folder' });
		await expect(renameDialog).toBeVisible();
		await renameDialog.getByPlaceholder('Enter folder name...').fill('guides');
		await renameDialog.getByRole('button', { name: 'Cancel' }).click();

		await expect(renameDialog).toBeHidden();
		await getFileTreeRow(window, 'docs');
		await expect(fileTreeRowLocator(window, 'guides')).toBeHidden();
		await expect(fs.existsSync(seededWorkbench.runbookPath)).toBe(true);
		await expect(fs.existsSync(seededWorkbench.archivePath)).toBe(true);
	});

	test(`${activeScenarioMatrix[61].id} ${activeScenarioMatrix[61].title}`, async () => {
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');
		await historyPanel.locator('[tabindex="0"]').focus();
		await window.keyboard.press('Control+f');

		const historyFilter = historyPanel.getByPlaceholder('Filter history...');
		await historyFilter.fill('blocked external renderer');

		await expect(historyPanel.getByText('1 result')).toBeVisible();
		await expect(historyPanel.getByText('Preview fallback failed')).toBeVisible();
		await expect(historyPanel.getByText('Rendered docs history tranche')).toBeHidden();
	});

	test(`${activeScenarioMatrix[62].id} ${activeScenarioMatrix[62].title}`, async ({
		electronApp,
	}) => {
		await clearClipboard(electronApp);
		const contextMenu = await openFileContextMenu(window, 'docs');

		await contextMenu.getByRole('button', { name: 'Copy Path' }).click();

		await expect(window.getByText('File Path Copied to Clipboard')).toBeVisible();
		await expectClipboardText(electronApp, path.join(seededWorkbench.projectDir, 'docs'));
	});

	test(`${activeScenarioMatrix[63].id} ${activeScenarioMatrix[63].title}`, async ({
		electronApp,
	}) => {
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');
		await clearClipboard(electronApp);
		await historyPanel.getByText('Rendered docs history tranche').click();

		await window.getByTitle('Copy session ID: codex-history-render').click();

		await expectClipboardText(electronApp, 'codex-history-render');
	});

	test(`${activeScenarioMatrix[64].id} ${activeScenarioMatrix[64].title}`, async () => {
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');
		await historyPanel.getByText('Rendered docs history tranche').click();

		await window.getByTitle('Mark as human-validated').click();
		await expect(window.getByTitle('Mark as not validated')).toBeVisible();

		await window.getByTitle('Mark as not validated').click();
		const detailModal = getHistoryDetailModal(
			window,
			'History detail includes README.md and docs/runbook.md render checks.'
		);
		await expect(detailModal.getByTitle('Mark as human-validated')).toBeVisible();
		await expect(detailModal.getByTitle('Task completed successfully')).toBeVisible();
	});

	test(`${activeScenarioMatrix[65].id} ${activeScenarioMatrix[65].title}`, async () => {
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');
		await historyPanel.getByText('Manual file operation note').click();
		await window.getByRole('button', { name: 'Delete' }).click();

		const deleteConfirm = window.locator('.fixed').filter({ hasText: 'Delete History Entry' });
		await expect(deleteConfirm.getByText('Delete History Entry')).toBeVisible();
		await expect(deleteConfirm.getByText('delete this user history entry')).toBeVisible();
		await deleteConfirm.getByRole('button', { name: 'Cancel' }).click();

		await expect(deleteConfirm).toBeHidden();
		await expect(
			window.getByText('Manual detail references draft/plain.txt and archive.md.')
		).toBeVisible();
		await window.keyboard.press('Escape');
		await expect(historyPanel.getByText('Manual file operation note')).toBeVisible();
	});

	test(`${activeScenarioMatrix[66].id} ${activeScenarioMatrix[66].title}`, async () => {
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');
		await historyPanel.getByText('Manual file operation note').click();
		const detailModal = getHistoryDetailModal(
			window,
			'Manual detail references draft/plain.txt and archive.md.'
		);
		await expect(detailModal).toBeVisible();

		await detailModal.getByRole('button', { name: 'Close', exact: true }).click();

		await expect(detailModal).toBeHidden();
		await expect(historyPanel.getByText('Manual file operation note')).toBeVisible();
	});

	test(`${activeScenarioMatrix[67].id} ${activeScenarioMatrix[67].title}`, async () => {
		await helpers.openRightPanelTab(window, 'Files');
		const hiddenRow = await getFileTreeRow(window, '.secret.md');
		await hiddenRow.dblclick();

		await expect(window.getByRole('heading', { name: 'Hidden File Explorer Note' })).toBeVisible();
		await expect(
			window.getByText('Hidden dotfile body for File Explorer visibility coverage.')
		).toBeVisible();
	});

	test(`${activeScenarioMatrix[68].id} ${activeScenarioMatrix[68].title}`, async () => {
		await helpers.openRightPanelTab(window, 'Files');
		await window.getByTitle('Expand all folders').click();
		await getFileTreeRow(window, 'archive.md');

		fs.unlinkSync(seededWorkbench.archivePath);
		await window.getByTitle(/Refresh file tree|Auto-refresh every \d+s/).click();

		await expect(fileTreeRowLocator(window, 'archive.md')).toBeHidden();
		await expect(fs.existsSync(seededWorkbench.archivePath)).toBe(false);
		await getFileTreeRow(window, 'runbook.md');
	});

	test(`${activeScenarioMatrix[69].id} ${activeScenarioMatrix[69].title}`, async () => {
		await helpers.openRightPanelTab(window, 'Files');
		await window.getByTitle('Expand all folders').click();
		await window.keyboard.press('Control+f');
		const filterInput = window.getByPlaceholder('Filter files...');
		await filterInput.fill('archive');

		const archiveRow = await getFileTreeRow(window, 'archive.md');
		await archiveRow.dblclick();

		await expect(window.getByRole('heading', { name: 'Archive Notes' })).toBeVisible();
		await expect(
			window.getByText('Archive body should survive cancelled folder deletion.')
		).toBeVisible();
	});

	test(`${activeScenarioMatrix[70].id} ${activeScenarioMatrix[70].title}`, async () => {
		const originalReadme = fs.readFileSync(seededWorkbench.readmePath, 'utf-8');
		const unsavedSentinel = 'Unsaved markdown cancel sentinel.';
		await expect(window.getByRole('heading', { name: 'Files Docs History Matrix' })).toBeVisible();

		await window.getByTitle(/Edit file/).click();
		const editor = window.locator('textarea').first();
		await expect(editor).toBeVisible();
		await editor.fill(`# Files Docs History Matrix\n\n${unsavedSentinel}\n`);
		await editor.press('Escape');

		await expect(editor).toBeHidden();
		await expect(window.getByText(unsavedSentinel)).toBeHidden();
		await expect(fs.readFileSync(seededWorkbench.readmePath, 'utf-8')).toBe(originalReadme);
	});

	test(`${activeScenarioMatrix[71].id} ${activeScenarioMatrix[71].title}`, async () => {
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');
		await historyPanel.locator('[tabindex="0"]').focus();
		await window.keyboard.press('Control+f');

		const historyFilter = historyPanel.getByPlaceholder('Filter history...');
		await historyFilter.fill('About Maestro achievements');

		await expect(historyPanel.getByText('1 result')).toBeVisible();
		await expect(historyPanel.getByText('Achievement file history milestone')).toBeVisible();
		await expect(historyPanel.getByText('Rendered docs history tranche')).toBeHidden();
		await historyPanel.getByText('Achievement file history milestone').click();
		await expect(
			window.getByText('History achievement action opens the About Maestro achievements view.')
		).toBeVisible();
	});

	for (const scenario of activeQuotaScenarioMatrix) {
		test(`${scenario.id} ${scenario.title}`, async () => {
			if (scenario.surface === 'file-explorer') {
				await assertFileExplorerQuotaScenario(window, seededWorkbench, scenario);
				return;
			}

			if (scenario.surface === 'file-preview') {
				await assertFilePreviewQuotaScenario(window, seededWorkbench, scenario);
				return;
			}

			await assertHistoryQuotaScenario(window, scenario);
		});
	}
});
