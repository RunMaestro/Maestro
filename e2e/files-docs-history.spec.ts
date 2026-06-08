/**
 * E2E Tests: files, docs, and history coverage tranche.
 *
 * This file intentionally keeps the first recovery tranche small and matrix-backed.
 * It seeds deterministic local state and does not launch live agent processes.
 */
import { test, expect, helpers } from './fixtures/electron-app';
import type { Page } from '@playwright/test';
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

	fs.mkdirSync(docsDir, { recursive: true });
	fs.mkdirSync(draftsDir, { recursive: true });
	fs.writeFileSync(
		readmePath,
		`# Files Docs History Matrix

Preview prose for the files docs history tranche.

[Runbook](docs/runbook.md)

- [ ] Active tranche item
- [x] Completed tranche item

| Scenario | State |
| --- | --- |
| Preview | Active |

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

	return {
		homeDir,
		projectDir,
		readmePath,
		runbookPath,
		archivePath,
		plainTextPath,
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

test.describe(`Files docs history first tranche (${activeScenarioMatrix.length} active, ${skippedScenarioMatrix.length} skipped, ${envGatedScenarioMatrix.length} env-gated)`, () => {
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
		await expect(
			window.locator('[data-file-index]').filter({ hasText: 'archive.md' })
		).toBeHidden();

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
		await expect(window.getByText('Preview')).toBeVisible();
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
		await expect(window.getByTitle('Task completed successfully')).toBeVisible();
		await expect(window.getByTitle('Copy session ID: codex-history-render')).toBeVisible();
		await expect(window.getByText('1m 10s')).toBeVisible();
		await expect(window.getByText('$0.04')).toBeVisible();
	});

	for (const scenario of skippedScenarioMatrix) {
		test.skip(`${scenario.id} ${scenario.title} [skipped product gap]`, async () => {
			void scenario.reason;
		});
	}

	for (const scenario of envGatedScenarioMatrix) {
		test.skip(`${scenario.id} ${scenario.title} [env-gated]`, async () => {
			void scenario.reason;
		});
	}
});
