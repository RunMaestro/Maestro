/**
 * E2E Tests: seeded app shell coverage.
 *
 * These tests exercise deterministic workbench surfaces without launching a live
 * AI process.
 */
import { test, expect, helpers } from './fixtures/electron-app';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

function runGit(cwd: string, args: string[], env: Record<string, string> = {}) {
	execFileSync('git', args, {
		cwd,
		stdio: 'ignore',
		env: {
			...process.env,
			...env,
		},
	});
}

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

	runGit(projectDir, ['init']);
	runGit(projectDir, ['checkout', '-B', 'main']);
	runGit(projectDir, ['config', 'user.name', 'E2E Bot']);
	runGit(projectDir, ['config', 'user.email', 'e2e@example.com']);
	runGit(projectDir, ['add', '.']);
	runGit(projectDir, ['commit', '-m', 'chore: seed initial fixture'], {
		GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z',
		GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z',
	});
	fs.appendFileSync(notesFilePath, '\nGit log committed sentinel.\n', 'utf-8');
	runGit(projectDir, ['add', 'NOTES.md']);
	runGit(projectDir, ['commit', '-m', 'docs: add git log fixture'], {
		GIT_AUTHOR_DATE: '2026-01-02T03:05:05Z',
		GIT_COMMITTER_DATE: '2026-01-02T03:05:05Z',
	});
	fs.appendFileSync(previewFilePath, '\nWorking tree diff sentinel for Git Diff E2E.\n', 'utf-8');
	fs.appendFileSync(mermaidFilePath, '\nGit diff mermaid sentinel.\n', 'utf-8');

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
				isGitRepo: true,
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

async function openSshSettings(window: Page) {
	const settingsDialog = await openSettings(window);
	await settingsDialog.locator('button[title="SSH Hosts"]').click();
	await expect(settingsDialog.getByText('SSH Remote Hosts')).toBeVisible();
	return settingsDialog;
}

async function openSettingsTab(window: Page, tabTitle: string, expectedText: string) {
	const settingsDialog = await openSettings(window);
	await settingsDialog.locator(`button[title="${tabTitle}"]`).click();
	await expect(settingsDialog.getByText(expectedText).first()).toBeVisible();
	return settingsDialog;
}

async function scrollSettingsToText(settingsDialog: Locator, text: string) {
	await settingsDialog
		.locator('.scrollbar-thin')
		.first()
		.evaluate((scroller, targetText) => {
			const elements = Array.from(scroller.querySelectorAll<HTMLElement>('*'));
			const target =
				elements.find((candidate) =>
					Array.from(candidate.childNodes).some(
						(node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim() === targetText
					)
				) ?? elements.find((candidate) => candidate.textContent?.includes(targetText));
			if (target) scroller.scrollTop = Math.max(0, target.offsetTop - 120);
		}, text);
}

async function openGlobalEnvironmentSettings(window: Page) {
	const quickActionsDialog = await openQuickActions(window);
	await quickActionsDialog
		.getByPlaceholder('Type a command or jump to agent...')
		.fill('Configure Global Environment Variables');
	await quickActionsDialog
		.getByRole('button', { name: /Configure Global Environment Variables/ })
		.click();

	await expect(quickActionsDialog).toBeHidden();
	const settingsDialog = window.getByRole('dialog', { name: 'Settings' });
	await settingsDialog.getByRole('button', { name: 'Shell Configuration' }).click();
	await scrollSettingsToText(settingsDialog, 'Global Environment Variables');
	await expect(
		settingsDialog.locator('strong').filter({ hasText: /^Global Environment Variables$/ })
	).toBeVisible();
	return settingsDialog;
}

async function openQuickActions(window: Page) {
	const quickActionsDialog = window.getByRole('dialog', { name: 'Quick Actions' });
	for (let attempt = 0; attempt < 3; attempt++) {
		if (await quickActionsDialog.isVisible().catch(() => false)) break;
		await window.bringToFront();
		await window.keyboard.press('Meta+K');
		await quickActionsDialog.waitFor({ state: 'visible', timeout: 1000 }).catch(() => undefined);
	}
	await expect(quickActionsDialog).toBeVisible();
	await expect(
		quickActionsDialog.getByPlaceholder('Type a command or jump to agent...')
	).toBeVisible();
	return quickActionsDialog;
}

async function openUsageDashboard(window: Page) {
	const quickActionsDialog = await openQuickActions(window);
	await quickActionsDialog
		.getByPlaceholder('Type a command or jump to agent...')
		.fill('Usage Dashboard');
	await quickActionsDialog.getByRole('button', { name: /Usage Dashboard/ }).click();

	await expect(quickActionsDialog).toBeHidden();
	const usageDashboard = window.getByRole('dialog', { name: 'Usage Dashboard' });
	await expect(usageDashboard).toBeVisible();
	return usageDashboard;
}

async function openSystemLogViewer(window: Page) {
	const quickActionsDialog = await openQuickActions(window);
	await quickActionsDialog
		.getByPlaceholder('Type a command or jump to agent...')
		.fill('View System Logs');
	await quickActionsDialog.getByRole('button', { name: /View System Logs/ }).click();

	await expect(quickActionsDialog).toBeHidden();
	const logViewer = window.getByRole('dialog', { name: 'System Log Viewer' });
	await expect(logViewer).toBeVisible();
	return logViewer;
}

async function openProcessMonitor(window: Page) {
	const quickActionsDialog = await openQuickActions(window);
	await quickActionsDialog
		.getByPlaceholder('Type a command or jump to agent...')
		.fill('View System Processes');
	await quickActionsDialog.getByRole('button', { name: /View System Processes/ }).click();

	await expect(quickActionsDialog).toBeHidden();
	const processMonitor = window.getByRole('dialog', { name: 'System Processes' });
	await expect(processMonitor).toBeVisible();
	return processMonitor;
}

async function openGitDiffFromQuickActions(window: Page) {
	const quickActionsDialog = await openQuickActions(window);
	await quickActionsDialog
		.getByPlaceholder('Type a command or jump to agent...')
		.fill('View Git Diff');
	await quickActionsDialog.getByRole('button', { name: /View Git Diff/ }).click();

	await expect(quickActionsDialog).toBeHidden();
	const gitDiffDialog = window.getByRole('dialog', { name: 'Git Diff Preview' });
	await expect(gitDiffDialog).toBeVisible();
	return gitDiffDialog;
}

async function openGitLogFromQuickActions(window: Page) {
	const quickActionsDialog = await openQuickActions(window);
	await quickActionsDialog
		.getByPlaceholder('Type a command or jump to agent...')
		.fill('View Git Log');
	await quickActionsDialog.getByRole('button', { name: /View Git Log/ }).click();

	await expect(quickActionsDialog).toBeHidden();
	const gitLogDialog = window.getByRole('dialog', { name: 'Git Log Viewer' });
	await expect(gitLogDialog).toBeVisible();
	return gitLogDialog;
}

async function openRepositoryInBrowserFromQuickActions(window: Page) {
	const quickActionsDialog = await openQuickActions(window);
	await quickActionsDialog
		.getByPlaceholder('Type a command or jump to agent...')
		.fill('Open Repository in Browser');
	await quickActionsDialog.getByRole('button', { name: /Open Repository in Browser/ }).click();
	await expect(quickActionsDialog).toBeHidden();
}

async function openCreateNewAgentFromQuickActions(window: Page) {
	const quickActionsDialog = await openQuickActions(window);
	await quickActionsDialog
		.getByPlaceholder('Type a command or jump to agent...')
		.fill('Create New Agent');
	await quickActionsDialog.getByRole('button', { name: /Create New Agent/ }).click();
	await expect(quickActionsDialog).toBeHidden();
	const createAgentDialog = window.getByRole('dialog', { name: 'Create New Agent' });
	await expect(createAgentDialog).toBeVisible();
	return createAgentDialog;
}

async function getHeaderGitStatusButton(window: Page) {
	const gitStatusButton = window
		.locator('button[title^="+"]')
		.filter({ has: window.locator('.header-git-status-full') })
		.first();
	await expect(gitStatusButton).toBeVisible({ timeout: 15000 });
	return gitStatusButton;
}

async function openHeaderGitStatusTooltip(window: Page) {
	const gitStatusButton = await getHeaderGitStatusButton(window);
	await gitStatusButton.hover();

	const changedFilesHeading = window.getByText(/Changed Files \(/).last();
	await expect(changedFilesHeading).toBeVisible({ timeout: 5000 });
	const tooltip = changedFilesHeading.locator(
		'xpath=ancestor::div[contains(@class, "absolute")][1]'
	);
	return { gitStatusButton, tooltip };
}

function modalRootByHeading(window: Page, heading: string) {
	return window
		.getByText(heading, { exact: true })
		.locator('xpath=ancestor::div[contains(@class, "fixed")][1]');
}

async function openSessionContextMenu(window: Page, sessionName: string, expectedAction: string) {
	const sessionList = window.locator('[data-tour="session-list"]');
	await sessionList.getByText(sessionName, { exact: true }).first().click({ button: 'right' });
	const contextMenu = window
		.locator('.fixed')
		.filter({
			has: window.getByRole('button', { name: expectedAction, exact: true }),
		})
		.last();
	await expect(
		contextMenu.getByRole('button', { name: expectedAction, exact: true })
	).toBeVisible();
	return contextMenu;
}

async function openWorktreeConfigFromContext(window: Page) {
	const contextMenu = await openSessionContextMenu(window, 'E2E Workbench', 'Configure Worktrees');
	await contextMenu.getByRole('button', { name: 'Configure Worktrees', exact: true }).click();
	const worktreeModal = modalRootByHeading(window, 'Worktree Configuration');
	await expect(worktreeModal).toBeVisible();
	await expect(worktreeModal.getByText('Worktree Directory')).toBeVisible();
	return worktreeModal;
}

async function saveDefaultWorktreeConfig(
	window: Page,
	seeded: ReturnType<typeof createSeededWorkbench>
) {
	const worktreeModal = await openWorktreeConfigFromContext(window);
	const directoryInput = worktreeModal.getByPlaceholder('/path/to/worktrees');
	await expect(directoryInput).toHaveValue(seeded.homeDir);
	await worktreeModal.getByRole('button', { name: 'Save Configuration' }).click();
	await expect(worktreeModal).toBeHidden();
}

async function createLocalWorktreeSession(
	window: Page,
	seeded: ReturnType<typeof createSeededWorkbench>,
	branchName: string
) {
	const sessionList = window.locator('[data-tour="session-list"]');
	await saveDefaultWorktreeConfig(window, seeded);

	const contextMenu = await openSessionContextMenu(window, 'E2E Workbench', 'Create Worktree');
	await contextMenu.getByRole('button', { name: 'Create Worktree', exact: true }).click();

	const createModal = modalRootByHeading(window, 'Create New Worktree');
	await createModal.getByPlaceholder('feature-xyz').fill(branchName);
	await createModal.getByRole('button', { name: 'Create', exact: true }).click();
	await expect(createModal).toBeHidden({ timeout: 15000 });
	await expect(sessionList.getByText(branchName, { exact: true })).toBeVisible({
		timeout: 15000,
	});
}

async function seedUsageDashboardStats(window: Page) {
	await window.evaluate(async () => {
		const now = Date.now();
		const projectPath = '/tmp/maestro-e2e-usage-dashboard';
		const sessionId = 'session-shell-codex-usage-dashboard';

		await window.maestro.stats.recordQuery({
			sessionId,
			agentType: 'codex',
			source: 'user',
			startTime: now - 1000 * 60 * 60 * 3,
			duration: 120_000,
			projectPath,
			tabId: 'usage-main',
			isRemote: false,
		});

		await window.maestro.stats.recordQuery({
			sessionId,
			agentType: 'codex',
			source: 'auto',
			startTime: now - 1000 * 60 * 60,
			duration: 240_000,
			projectPath,
			tabId: 'usage-auto',
			isRemote: true,
		});

		await window.maestro.stats.recordSessionCreated({
			sessionId,
			agentType: 'codex',
			projectPath,
			createdAt: now - 1000 * 60 * 60 * 4,
			isRemote: false,
		});
		await window.maestro.stats.recordSessionClosed(sessionId, now - 1000 * 60 * 15);

		const autoRunSessionId = await window.maestro.stats.startAutoRun({
			sessionId,
			agentType: 'codex',
			documentPath: 'Auto Run Docs/Phase 1.md',
			startTime: now - 1000 * 60 * 45,
			tasksTotal: 5,
			projectPath,
		});

		if (autoRunSessionId) {
			await window.maestro.stats.recordAutoTask({
				autoRunSessionId,
				sessionId,
				agentType: 'codex',
				taskIndex: 0,
				taskContent: 'Seed Usage Dashboard task',
				startTime: now - 1000 * 60 * 40,
				duration: 60_000,
				success: true,
			});
			await window.maestro.stats.endAutoRun(autoRunSessionId, 600_000, 4);
		}
	});
}

async function seedSystemLogs(window: Page) {
	await window.evaluate(async () => {
		await window.maestro.logger.clearLogs();
		await window.maestro.logger.log('info', 'E2E info sentinel', 'E2ELog', {
			marker: 'system-log-data',
		});
		await window.maestro.logger.log('error', 'E2E error sentinel', 'E2ELog', {
			marker: 'system-log-error',
		});
		await window.maestro.logger.log('warn', 'E2E warn sentinel', 'E2ELog', {
			marker: 'system-log-warn',
		});
	});
}

async function stubProcessMonitorProcesses(
	electronApp: ElectronApplication,
	seeded: ReturnType<typeof createSeededWorkbench>
) {
	const codexSession = seeded.sessions[0];
	const terminalSession = seeded.sessions[1];

	await electronApp.evaluate(
		({ ipcMain }, payload) => {
			ipcMain.removeHandler('process:getActiveProcesses');
			ipcMain.handle('process:getActiveProcesses', async () => [
				{
					sessionId: `${payload.codexSessionId}-ai`,
					toolType: 'codex',
					pid: 41001,
					cwd: payload.codexCwd,
					isTerminal: false,
					isBatchMode: false,
					startTime: Date.now() - 90_000,
					command: 'codex',
					args: ['--model', 'gpt-5-codex'],
				},
				{
					sessionId: `${payload.terminalSessionId}-terminal`,
					toolType: 'terminal',
					pid: 41002,
					cwd: payload.terminalCwd,
					isTerminal: true,
					isBatchMode: false,
					startTime: Date.now() - 45_000,
					command: 'zsh',
					args: ['-l'],
				},
			]);

			ipcMain.removeHandler('process:kill');
			ipcMain.handle('process:kill', async () => true);
		},
		{
			codexSessionId: codexSession.id,
			codexCwd: codexSession.cwd,
			terminalSessionId: terminalSession.id,
			terminalCwd: terminalSession.cwd,
		}
	);
}

async function stubSshConfigHosts(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		ipcMain.removeHandler('ssh-remote:getSshConfigHosts');
		ipcMain.handle('ssh-remote:getSshConfigHosts', async () => ({
			success: true,
			hosts: [
				{
					host: 'e2e-prod',
					hostName: 'prod.internal',
					port: 2222,
					user: 'deploy',
				},
				{
					host: 'e2e-build',
					hostName: 'build.internal',
					port: 2200,
					user: 'builder',
				},
			],
			configPath: '/tmp/e2e-ssh-config',
		}));
	});
}

async function stubGistPublishing(
	electronApp: ElectronApplication,
	window: Page,
	result: { success: boolean; gistUrl?: string; error?: string }
) {
	await electronApp.evaluate(({ ipcMain }, payload) => {
		ipcMain.removeHandler('git:checkGhCli');
		ipcMain.handle('git:checkGhCli', async () => ({ installed: true, authenticated: true }));
		ipcMain.removeHandler('git:createGist');
		ipcMain.handle('git:createGist', async () => payload);
	}, result);
	await window.reload({ waitUntil: 'domcontentloaded' });
	await window.waitForTimeout(500);
	await expect(window.getByText('File Preview Surface')).toBeVisible();
}

async function stubOpenExternal(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eOpenExternalUrl?: string;
		};
		state.__maestroE2eOpenExternalUrl = undefined;
		ipcMain.removeHandler('shell:openExternal');
		ipcMain.handle('shell:openExternal', async (_event, url: string) => {
			state.__maestroE2eOpenExternalUrl = url;
		});
	});
}

async function getStubbedOpenExternalUrl(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eOpenExternalUrl?: string;
		};
		return state.__maestroE2eOpenExternalUrl ?? null;
	});
}

async function stubUpdateCheckForModal(
	electronApp: ElectronApplication,
	mode: 'available' | 'error'
) {
	await electronApp.evaluate(
		({ ipcMain, BrowserWindow }, payload: { mode: 'available' | 'error' }) => {
			const state = globalThis as typeof globalThis & {
				__maestroE2eUpdateState?: {
					checks: boolean[];
					downloads: number;
					installs: number;
					lastAllowPrerelease?: boolean;
				};
			};
			state.__maestroE2eUpdateState = { checks: [], downloads: 0, installs: 0 };

			ipcMain.removeHandler('updates:check');
			ipcMain.handle('updates:check', async (_event, includePrerelease: boolean = false) => {
				state.__maestroE2eUpdateState!.checks.push(includePrerelease);
				if (payload.mode === 'error') throw new Error('GitHub API unavailable for E2E');
				return {
					currentVersion: '0.15.3',
					latestVersion: '0.16.0',
					updateAvailable: true,
					versionsBehind: 1,
					assetsReady: true,
					releasesUrl: 'https://github.com/RunMaestro/Maestro/releases',
					releases: [
						{
							tag_name: 'v0.16.0',
							name: 'v0.16.0 | Update Modal E2E',
							body: '### Deterministic release notes\n\n- Adds update modal E2E coverage.',
							html_url: 'https://github.com/RunMaestro/Maestro/releases/tag/v0.16.0',
							published_at: '2026-05-29T12:00:00.000Z',
						},
					],
				};
			});
			ipcMain.removeHandler('updates:download');
			ipcMain.handle('updates:download', async () => {
				state.__maestroE2eUpdateState!.downloads += 1;
				const appWindow = BrowserWindow.getAllWindows()[0];
				appWindow?.webContents.send('updates:status', {
					status: 'downloading',
					progress: {
						percent: 64,
						bytesPerSecond: 2048,
						total: 4096,
						transferred: 2048,
					},
				});
				appWindow?.webContents.send('updates:status', {
					status: 'downloaded',
					info: { version: '0.16.0' },
				});
				return { success: true };
			});
			ipcMain.removeHandler('updates:install');
			ipcMain.handle('updates:install', async () => {
				state.__maestroE2eUpdateState!.installs += 1;
			});
			ipcMain.removeHandler('updates:getStatus');
			ipcMain.handle('updates:getStatus', async () => ({ status: 'idle' }));
			ipcMain.removeHandler('updates:setAllowPrerelease');
			ipcMain.handle('updates:setAllowPrerelease', async (_event, allow: boolean) => {
				state.__maestroE2eUpdateState!.lastAllowPrerelease = allow;
			});
		},
		{ mode }
	);
}

async function getStubbedUpdateState(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eUpdateState?: {
				checks: boolean[];
				downloads: number;
				installs: number;
				lastAllowPrerelease?: boolean;
			};
		};
		return state.__maestroE2eUpdateState ?? null;
	});
}

async function stubPullRequestCreation(
	electronApp: ElectronApplication,
	status: { installed: boolean; authenticated: boolean },
	result: { success: boolean; prUrl?: string; error?: string }
) {
	await electronApp.evaluate(
		({ ipcMain }, payload) => {
			const state = globalThis as typeof globalThis & {
				__maestroE2eCreatePRRequest?: {
					worktreePath: string;
					targetBranch: string;
					title: string;
					description: string;
				} | null;
			};
			state.__maestroE2eCreatePRRequest = null;

			ipcMain.removeHandler('git:checkGhCli');
			ipcMain.handle('git:checkGhCli', async () => payload.status);
			ipcMain.removeHandler('git:createPR');
			ipcMain.handle(
				'git:createPR',
				async (
					_event,
					worktreePath: string,
					targetBranch: string,
					title: string,
					description: string
				) => {
					state.__maestroE2eCreatePRRequest = {
						worktreePath,
						targetBranch,
						title,
						description,
					};
					return payload.result;
				}
			);
		},
		{ status, result }
	);
}

async function getStubbedCreatePRRequest(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eCreatePRRequest?: {
				worktreePath: string;
				targetBranch: string;
				title: string;
				description: string;
			} | null;
		};
		return state.__maestroE2eCreatePRRequest ?? null;
	});
}

async function stubAgentDetectionForNewAgent(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		const capabilities = { supportsBatchMode: true, supportsModelSelection: false };
		const agents = [
			{
				id: 'codex',
				name: 'Codex',
				binaryName: 'codex',
				command: 'codex',
				args: [],
				available: true,
				path: '/usr/local/bin/codex',
				capabilities,
			},
			{
				id: 'claude-code',
				name: 'Claude Code',
				binaryName: 'claude',
				command: 'claude',
				args: [],
				available: false,
				capabilities,
			},
			{
				id: 'opencode',
				name: 'OpenCode',
				binaryName: 'opencode',
				command: 'opencode',
				args: [],
				available: false,
				capabilities,
			},
			{
				id: 'factory-droid',
				name: 'Factory Droid',
				binaryName: 'factory',
				command: 'factory',
				args: [],
				available: false,
				capabilities,
			},
			{
				id: 'gemini-cli',
				name: 'Gemini CLI',
				binaryName: 'gemini',
				command: 'gemini',
				args: [],
				available: false,
				capabilities,
			},
		];

		ipcMain.removeHandler('agents:detect');
		ipcMain.handle('agents:detect', async () => agents);
		ipcMain.removeHandler('agents:refresh');
		ipcMain.handle('agents:refresh', async (_event, agentId: string) =>
			agents.find((agent) => agent.id === agentId)
		);
		ipcMain.removeHandler('agents:getConfig');
		ipcMain.handle('agents:getConfig', async () => ({}));
		ipcMain.removeHandler('agents:setConfig');
		ipcMain.handle('agents:setConfig', async () => true);
		ipcMain.removeHandler('agents:getModels');
		ipcMain.handle('agents:getModels', async () => []);
	});
}

async function stubMarketplaceForPlaybookExchange(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		const manifest = {
			lastUpdated: '2026-05-29',
			playbooks: [
				{
					id: 'issue-triage',
					title: 'Issue Triage',
					description: 'Classify incoming GitHub issues and prepare a response queue.',
					category: 'Security',
					subcategory: 'Reviews',
					author: 'RunMaestro',
					authorLink: 'https://github.com/RunMaestro',
					tags: ['triage', 'security', 'github'],
					lastUpdated: '2026-05-28',
					path: 'security/issue-triage',
					documents: [
						{ filename: 'triage-plan', resetOnCompletion: true },
						{ filename: 'response-checklist', resetOnCompletion: false },
					],
					loopEnabled: true,
					maxLoops: 2,
					prompt: 'Review every issue before moving to the next document.',
					source: 'official',
				},
				{
					id: 'release-checklist',
					title: 'Release Checklist',
					description: 'Prepare release notes and validation steps.',
					category: 'Release',
					author: 'RunMaestro',
					tags: ['release'],
					lastUpdated: '2026-05-27',
					path: 'release/checklist',
					documents: [{ filename: 'release-plan', resetOnCompletion: true }],
					loopEnabled: false,
					maxLoops: null,
					prompt: null,
					source: 'local',
				},
			],
		};
		const readmes: Record<string, string> = {
			'security/issue-triage': '# README for issue triage\n\nUse this playbook to route issues.',
			'release/checklist': '# Release checklist\n\nPrepare the release.',
		};
		const documents: Record<string, string> = {
			'security/issue-triage/triage-plan': '# Triage Plan\n\nTriage plan body for E2E.',
			'security/issue-triage/response-checklist':
				'# Response Checklist\n\nResponse checklist body.',
			'release/checklist/release-plan': '# Release Plan\n\nRelease plan body.',
		};
		const state = globalThis as typeof globalThis & {
			__maestroE2eMarketplaceImportRequest?: {
				playbookId: string;
				targetFolderName: string;
				autoRunFolderPath: string;
				sessionId: string;
				sshRemoteId?: string;
			} | null;
		};
		state.__maestroE2eMarketplaceImportRequest = null;

		ipcMain.removeHandler('marketplace:getManifest');
		ipcMain.handle('marketplace:getManifest', async () => ({
			success: true,
			manifest,
			fromCache: true,
			cacheAge: 120_000,
		}));
		ipcMain.removeHandler('marketplace:refreshManifest');
		ipcMain.handle('marketplace:refreshManifest', async () => ({
			success: true,
			manifest,
			fromCache: false,
			cacheAge: 0,
		}));
		ipcMain.removeHandler('marketplace:getReadme');
		ipcMain.handle('marketplace:getReadme', async (_event, playbookPath: string) => ({
			success: true,
			content: readmes[playbookPath] ?? null,
		}));
		ipcMain.removeHandler('marketplace:getDocument');
		ipcMain.handle(
			'marketplace:getDocument',
			async (_event, playbookPath: string, filename: string) => ({
				success: true,
				content: documents[`${playbookPath}/${filename}`] ?? null,
			})
		);
		ipcMain.removeHandler('marketplace:importPlaybook');
		ipcMain.handle(
			'marketplace:importPlaybook',
			async (
				_event,
				playbookId: string,
				targetFolderName: string,
				autoRunFolderPath: string,
				sessionId: string,
				sshRemoteId?: string
			) => {
				state.__maestroE2eMarketplaceImportRequest = {
					playbookId,
					targetFolderName,
					autoRunFolderPath,
					sessionId,
					sshRemoteId,
				};
				return { success: true };
			}
		);
	});
}

async function getStubbedMarketplaceImportRequest(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eMarketplaceImportRequest?: {
				playbookId: string;
				targetFolderName: string;
				autoRunFolderPath: string;
				sessionId: string;
				sshRemoteId?: string;
			} | null;
		};
		return state.__maestroE2eMarketplaceImportRequest ?? null;
	});
}

async function stubSpecKitAndOpenSpecCommands(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		const makeMetadata = (sourceVersion: string, sourceUrl: string) => ({
			lastRefreshed: '2026-05-29T12:00:00.000Z',
			commitSha: 'e2e1234',
			sourceVersion,
			sourceUrl,
		});
		const specDefaults: Record<string, string> = {
			specify: 'Bundled specify prompt for {{CWD}}.',
		};
		const openDefaults: Record<string, string> = {
			proposal: 'Bundled proposal prompt for {{AGENT_NAME}}.',
		};
		let specCommands = [
			{
				id: 'specify',
				command: '/speckit.specify',
				description: 'Create a new product specification.',
				prompt: specDefaults.specify,
				isCustom: false,
				isModified: false,
			},
		];
		let openCommands = [
			{
				id: 'proposal',
				command: '/openspec.proposal',
				description: 'Draft a structured change proposal.',
				prompt: openDefaults.proposal,
				isCustom: false,
				isModified: false,
			},
		];

		ipcMain.removeHandler('speckit:getMetadata');
		ipcMain.handle('speckit:getMetadata', async () => ({
			success: true,
			metadata: makeMetadata('v1.2.3', 'https://github.com/github/spec-kit'),
		}));
		ipcMain.removeHandler('speckit:getPrompts');
		ipcMain.handle('speckit:getPrompts', async () => ({ success: true, commands: specCommands }));
		ipcMain.removeHandler('speckit:savePrompt');
		ipcMain.handle('speckit:savePrompt', async (_event, id: string, prompt: string) => {
			specCommands = specCommands.map((cmd) =>
				cmd.id === id ? { ...cmd, prompt, isModified: true } : cmd
			);
			return { success: true };
		});
		ipcMain.removeHandler('speckit:resetPrompt');
		ipcMain.handle('speckit:resetPrompt', async (_event, id: string) => {
			const prompt = specDefaults[id] ?? '';
			specCommands = specCommands.map((cmd) =>
				cmd.id === id ? { ...cmd, prompt, isModified: false } : cmd
			);
			return { success: true, prompt };
		});
		ipcMain.removeHandler('speckit:refresh');
		ipcMain.handle('speckit:refresh', async () => ({
			success: true,
			metadata: makeMetadata('v1.2.4', 'https://github.com/github/spec-kit'),
		}));

		ipcMain.removeHandler('openspec:getMetadata');
		ipcMain.handle('openspec:getMetadata', async () => ({
			success: true,
			metadata: makeMetadata('v2.0.1', 'https://github.com/Fission-AI/OpenSpec'),
		}));
		ipcMain.removeHandler('openspec:getPrompts');
		ipcMain.handle('openspec:getPrompts', async () => ({ success: true, commands: openCommands }));
		ipcMain.removeHandler('openspec:savePrompt');
		ipcMain.handle('openspec:savePrompt', async (_event, id: string, prompt: string) => {
			openCommands = openCommands.map((cmd) =>
				cmd.id === id ? { ...cmd, prompt, isModified: true } : cmd
			);
			return { success: true };
		});
		ipcMain.removeHandler('openspec:resetPrompt');
		ipcMain.handle('openspec:resetPrompt', async (_event, id: string) => {
			const prompt = openDefaults[id] ?? '';
			openCommands = openCommands.map((cmd) =>
				cmd.id === id ? { ...cmd, prompt, isModified: false } : cmd
			);
			return { success: true, prompt };
		});
		ipcMain.removeHandler('openspec:refresh');
		ipcMain.handle('openspec:refresh', async () => ({
			success: true,
			metadata: makeMetadata('v2.0.2', 'https://github.com/Fission-AI/OpenSpec'),
		}));
	});
}

async function stubSymphonyForModal(electronApp: ElectronApplication, sessionId: string) {
	await electronApp.evaluate(
		({ ipcMain }, payload: { sessionId: string }) => {
			const now = new Date('2026-05-29T12:00:00.000Z').toISOString();
			const stats = {
				totalContributions: 2,
				totalMerged: 1,
				totalIssuesResolved: 1,
				totalDocumentsProcessed: 5,
				totalTasksCompleted: 24,
				totalTokensUsed: 1_500_000,
				totalTimeSpent: 7_200_000,
				estimatedCostDonated: 12.34,
				repositoriesContributed: ['RunMaestro/Maestro', 'RunMaestro/docs'],
				uniqueMaintainersHelped: 2,
				currentStreak: 2,
				longestStreak: 7,
				firstContributionAt: '2026-05-01T12:00:00.000Z',
				lastContributionAt: now,
			};
			const registry = {
				schemaVersion: '1.0',
				lastUpdated: now,
				repositories: [
					{
						slug: 'RunMaestro/Maestro',
						name: 'Maestro Core',
						description: 'Electron workspace for orchestrating coding agents.',
						url: 'https://github.com/RunMaestro/Maestro',
						category: 'developer-tools',
						tags: ['electron', 'codex', 'testing'],
						maintainer: {
							name: 'RunMaestro',
							url: 'https://github.com/RunMaestro',
						},
						isActive: true,
						featured: true,
						addedAt: '2026-05-01T12:00:00.000Z',
						stars: 1234,
					},
					{
						slug: 'RunMaestro/docs',
						name: 'Documentation Hub',
						description: 'Public documentation for Maestro.',
						url: 'https://github.com/RunMaestro/docs',
						category: 'documentation',
						tags: ['docs'],
						maintainer: { name: 'RunMaestro' },
						isActive: true,
						addedAt: '2026-05-02T12:00:00.000Z',
						stars: 321,
					},
				],
			};
			const issues = {
				'RunMaestro/Maestro': [
					{
						number: 42,
						title: 'Add deterministic E2E coverage',
						body: 'Please run the attached Auto Run document.',
						url: 'https://api.github.com/repos/RunMaestro/Maestro/issues/42',
						htmlUrl: 'https://github.com/RunMaestro/Maestro/issues/42',
						author: 'maintainer',
						createdAt: '2026-05-20T12:00:00.000Z',
						updatedAt: now,
						documentPaths: [
							{
								name: 'e2e-plan.md',
								path: 'https://example.com/symphony/e2e-plan.md',
								isExternal: true,
							},
							{
								name: 'local-checklist.md',
								path: 'docs/local-checklist.md',
								isExternal: false,
							},
						],
						labels: [{ name: 'good first issue', color: '0e8a16' }],
						status: 'available',
					},
					{
						number: 43,
						title: 'Blocked dependency upgrade',
						body: 'Wait for upstream release before working.',
						url: 'https://api.github.com/repos/RunMaestro/Maestro/issues/43',
						htmlUrl: 'https://github.com/RunMaestro/Maestro/issues/43',
						author: 'maintainer',
						createdAt: '2026-05-21T12:00:00.000Z',
						updatedAt: now,
						documentPaths: [
							{
								name: 'blocked-plan.md',
								path: 'https://example.com/symphony/blocked-plan.md',
								isExternal: true,
							},
						],
						labels: [{ name: 'blocking', color: 'cc0000' }],
						status: 'available',
					},
					{
						number: 44,
						title: 'Already claimed contribution',
						body: 'Another contributor is handling this issue.',
						url: 'https://api.github.com/repos/RunMaestro/Maestro/issues/44',
						htmlUrl: 'https://github.com/RunMaestro/Maestro/issues/44',
						author: 'maintainer',
						createdAt: '2026-05-22T12:00:00.000Z',
						updatedAt: now,
						documentPaths: [
							{
								name: 'claimed-plan.md',
								path: 'https://example.com/symphony/claimed-plan.md',
								isExternal: true,
							},
						],
						labels: [{ name: 'enhancement', color: '1d76db' }],
						status: 'in_progress',
						claimedByPr: {
							number: 77,
							url: 'https://github.com/RunMaestro/Maestro/pull/77',
							author: 'codex-user',
							isDraft: true,
						},
					},
				],
				'RunMaestro/docs': [],
			};
			const activeContribution = {
				id: 'symphony-active-e2e',
				repoSlug: 'RunMaestro/Maestro',
				repoName: 'Maestro Core',
				issueNumber: 42,
				issueTitle: 'Add deterministic E2E coverage',
				localPath: '/tmp/maestro-symphony-e2e',
				branchName: 'symphony/issue-42-e2e',
				draftPrNumber: 77,
				draftPrUrl: 'https://github.com/RunMaestro/Maestro/pull/77',
				startedAt: '2026-05-29T10:00:00.000Z',
				status: 'ready_for_review',
				progress: {
					totalDocuments: 2,
					completedDocuments: 2,
					currentDocument: 'e2e-plan.md',
					totalTasks: 6,
					completedTasks: 6,
				},
				tokenUsage: {
					inputTokens: 120_000,
					outputTokens: 42_000,
					estimatedCost: 3.21,
				},
				timeSpent: 3_600_000,
				sessionId: payload.sessionId,
				agentType: 'codex',
			};
			const completedContribution = {
				id: 'symphony-completed-e2e',
				repoSlug: 'RunMaestro/docs',
				repoName: 'Documentation Hub',
				issueNumber: 12,
				issueTitle: 'Document mobile bridge setup',
				startedAt: '2026-05-28T10:00:00.000Z',
				completedAt: '2026-05-28T12:00:00.000Z',
				prUrl: 'https://github.com/RunMaestro/docs/pull/12',
				prNumber: 12,
				tokenUsage: {
					inputTokens: 300_000,
					outputTokens: 80_000,
					totalCost: 4.56,
				},
				timeSpent: 7_200_000,
				documentsProcessed: 3,
				tasksCompleted: 18,
				wasMerged: true,
				mergedAt: '2026-05-28T14:00:00.000Z',
			};
			const state = {
				active: [activeContribution],
				history: [completedContribution],
				stats,
			};

			ipcMain.removeHandler('symphony:getRegistry');
			ipcMain.handle('symphony:getRegistry', async () => ({
				registry,
				fromCache: true,
				cacheAge: 300_000,
			}));
			ipcMain.removeHandler('symphony:getIssueCounts');
			ipcMain.handle('symphony:getIssueCounts', async () => ({
				counts: {
					'RunMaestro/Maestro': 3,
					'RunMaestro/docs': 0,
				},
				fromCache: true,
				cacheAge: 60_000,
			}));
			ipcMain.removeHandler('symphony:getIssues');
			ipcMain.handle('symphony:getIssues', async (_event, repoSlug: string) => ({
				issues: issues[repoSlug as keyof typeof issues] ?? [],
				fromCache: true,
				cacheAge: 60_000,
			}));
			ipcMain.removeHandler('symphony:getState');
			ipcMain.handle('symphony:getState', async () => ({ state }));
			ipcMain.removeHandler('symphony:getActive');
			ipcMain.handle('symphony:getActive', async () => ({ contributions: state.active }));
			ipcMain.removeHandler('symphony:getCompleted');
			ipcMain.handle('symphony:getCompleted', async (_event, limit?: number) => ({
				contributions: state.history.slice(0, limit ?? state.history.length),
			}));
			ipcMain.removeHandler('symphony:getStats');
			ipcMain.handle('symphony:getStats', async () => ({ stats }));
			ipcMain.removeHandler('symphony:checkPRStatuses');
			ipcMain.handle('symphony:checkPRStatuses', async () => ({
				checked: 1,
				merged: 1,
				closed: 0,
			}));
			ipcMain.removeHandler('symphony:syncContribution');
			ipcMain.handle('symphony:syncContribution', async () => ({
				success: true,
				message: 'Contribution status synced',
			}));
			ipcMain.removeHandler('symphony:fetchDocumentContent');
			ipcMain.handle('symphony:fetchDocumentContent', async () => ({
				success: true,
				content: '# External Symphony Doc\n\nDocument preview body for E2E.',
			}));
			ipcMain.removeHandler('git:checkGhCli');
			ipcMain.handle('git:checkGhCli', async () => ({ installed: false, authenticated: false }));
		},
		{ sessionId }
	);
}

async function openSymphonyFromQuickActions(window: Page) {
	const quickActionsDialog = await openQuickActions(window);
	await quickActionsDialog
		.getByPlaceholder('Type a command or jump to agent...')
		.fill('Maestro Symphony');
	await quickActionsDialog.getByRole('button', { name: /Maestro Symphony/ }).click();
	await expect(quickActionsDialog).toBeHidden();
	const symphonyDialog = window.getByRole('dialog').first();
	await expect(symphonyDialog).toBeVisible();
	await expect(symphonyDialog.getByText('Maestro Symphony').first()).toBeVisible();
	return symphonyDialog;
}

async function openUpdateCheckFromQuickActions(window: Page) {
	const quickActionsDialog = await openQuickActions(window);
	await quickActionsDialog
		.getByPlaceholder('Type a command or jump to agent...')
		.fill('Check for Updates');
	await quickActionsDialog.getByRole('button', { name: /Check for Updates/ }).click();
	await expect(quickActionsDialog).toBeHidden();
	const updateDialog = window.getByRole('dialog', { name: 'Check for Updates' });
	await expect(updateDialog).toBeVisible();
	return updateDialog;
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
	let seededWorkbench: ReturnType<typeof createSeededWorkbench>;

	test.beforeEach(async () => {
		seededWorkbench = createSeededWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seededWorkbench.homeDir,
			sessions: seededWorkbench.sessions,
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
		await seedHistoryEntries(
			window,
			seededWorkbench.sessions[0].cwd,
			seededWorkbench.sessions[0].id
		);
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

	test('browses and previews Playbook Exchange with stubbed marketplace data', async () => {
		await stubMarketplaceForPlaybookExchange(electronApp);

		await helpers.openRightPanelTab(window, 'Auto Run');
		await window.getByTitle('Browse PlayBooks - discover and share community playbooks').click();
		const marketplaceDialog = window.getByRole('dialog').first();
		await expect(marketplaceDialog).toBeVisible();
		await expect(marketplaceDialog.getByText('Playbook Exchange')).toBeVisible();
		await expect(marketplaceDialog.getByText(/Cached 2m ago|Cached/)).toBeVisible();

		await expect(marketplaceDialog.getByRole('button', { name: 'Security(1)' })).toBeVisible();
		await expect(marketplaceDialog.getByRole('button', { name: 'Release(1)' })).toBeVisible();
		await marketplaceDialog.getByPlaceholder('Search playbooks...').fill('triage');
		await expect(marketplaceDialog.getByRole('button', { name: /Issue Triage/ })).toBeVisible();
		await expect(marketplaceDialog.getByText('Release Checklist')).toBeHidden();

		await marketplaceDialog.getByRole('button', { name: /Issue Triage/ }).click();
		await expect(
			marketplaceDialog.getByRole('heading', { name: 'Issue Triage', exact: true })
		).toBeVisible();
		await expect(marketplaceDialog.getByText('README for issue triage')).toBeVisible();
		await expect(marketplaceDialog.getByText('Loop: Yes (max 2)')).toBeVisible();

		await marketplaceDialog.getByRole('button', { name: /triage-plan\.md/ }).click();
		await expect(marketplaceDialog.getByText('Triage plan body for E2E.')).toBeVisible();

		await window.keyboard.press('Escape');
		await expect(marketplaceDialog.getByPlaceholder('Search playbooks...')).toBeVisible();
	});

	test('imports a marketplace playbook into the Auto Run folder with a deterministic stub', async () => {
		await stubMarketplaceForPlaybookExchange(electronApp);

		await helpers.openRightPanelTab(window, 'Auto Run');
		await window.getByTitle('Browse PlayBooks - discover and share community playbooks').click();
		const marketplaceDialog = window.getByRole('dialog').first();
		await expect(marketplaceDialog.getByText('Playbook Exchange')).toBeVisible();
		await marketplaceDialog.getByRole('button', { name: /Issue Triage/ }).click();
		await expect(marketplaceDialog.getByText('README for issue triage')).toBeVisible();

		await marketplaceDialog.getByRole('button', { name: 'Import Playbook' }).click();
		await expect(marketplaceDialog).toBeHidden();
		await expect(window.getByText('Playbook Imported')).toBeVisible();

		await expect
			.poll(async () => getStubbedMarketplaceImportRequest(electronApp))
			.toMatchObject({
				playbookId: 'issue-triage',
				targetFolderName: 'security/issue-triage',
				autoRunFolderPath: seededWorkbench.sessions[0].autoRunFolderPath,
				sessionId: seededWorkbench.sessions[0].id,
			});
	});

	test('browses Symphony projects issues and GitHub CLI preflight states', async () => {
		await stubSymphonyForModal(electronApp, seededWorkbench.sessions[0].id);

		const symphonyDialog = await openSymphonyFromQuickActions(window);
		await expect(symphonyDialog.getByText(/Cached 5m ago|Cached/)).toBeVisible();
		await symphonyDialog.getByPlaceholder('Search repositories...').fill('electron');
		await expect(symphonyDialog.getByRole('button', { name: /Maestro Core/ })).toBeVisible();
		await expect(symphonyDialog.getByText('Documentation Hub')).toBeHidden();

		await symphonyDialog.getByRole('button', { name: /Maestro Core/ }).click();
		await expect(symphonyDialog.getByText('Maestro Symphony: Maestro Core')).toBeVisible();
		await expect(symphonyDialog.getByText('Available Issues (1)')).toBeVisible();
		await expect(symphonyDialog.getByText('In Progress (1)')).toBeVisible();
		await expect(symphonyDialog.getByText('Blocked (1)')).toBeVisible();

		await symphonyDialog.getByRole('button', { name: /Add deterministic E2E coverage/ }).click();
		await expect(symphonyDialog.getByText('Document preview body for E2E.')).toBeVisible();
		await symphonyDialog.getByRole('button', { name: 'Start Symphony' }).click();
		await expect(window.getByText('GitHub CLI Required')).toBeVisible();
		await window.getByRole('button', { name: 'Close' }).last().click();

		await symphonyDialog.getByRole('button', { name: /Blocked dependency upgrade/ }).click();
		await expect(symphonyDialog.getByRole('button', { name: 'Start Symphony' })).toBeDisabled();
	});

	test('shows Symphony active history stats and achievement states', async () => {
		await stubSymphonyForModal(electronApp, seededWorkbench.sessions[0].id);

		const symphonyDialog = await openSymphonyFromQuickActions(window);
		await symphonyDialog.getByRole('button', { name: /Active \(1\)/ }).click();
		await expect(symphonyDialog.getByText('Add deterministic E2E coverage')).toBeVisible();
		await expect(symphonyDialog.getByText('Ready for Review')).toBeVisible();
		await expect(symphonyDialog.getByText('Draft PR #77')).toBeVisible();
		await expect(symphonyDialog.getByText('2 / 2 documents')).toBeVisible();

		await symphonyDialog.getByTitle('Sync status with GitHub').click();
		await expect(symphonyDialog.getByText('Contribution status synced')).toBeVisible();
		await symphonyDialog.getByTitle('Check for merged or closed PRs').click();
		await expect(symphonyDialog.getByText('1 PR merged')).toBeVisible();

		await symphonyDialog.getByRole('button', { name: 'History' }).click();
		await expect(symphonyDialog.getByText('Document mobile bridge setup')).toBeVisible();
		await expect(symphonyDialog.getByText('Merged').last()).toBeVisible();
		await expect(symphonyDialog.getByText('PR #12')).toBeVisible();

		await symphonyDialog.getByRole('button', { name: 'Stats' }).click();
		await expect(symphonyDialog.getByText('Tokens Donated')).toBeVisible();
		await expect(symphonyDialog.getByText('1.5M')).toBeVisible();
		await expect(symphonyDialog.getByText('First Steps')).toBeVisible();
		await expect(symphonyDialog.getByText('Merged Melody')).toBeVisible();
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

	test('checks for updates and downloads an available release from Quick Actions', async () => {
		await stubUpdateCheckForModal(electronApp, 'available');

		const updateDialog = await openUpdateCheckFromQuickActions(window);
		await expect(updateDialog.getByText('Update Available!')).toBeVisible();
		await expect(updateDialog.getByText(/Current: v0\.15\.3.*Latest: v0\.16\.0/)).toBeVisible();
		await expect(
			updateDialog.getByRole('button', { name: /v0\.16\.0 - Update Modal E2E/ })
		).toBeVisible();
		await expect(updateDialog.getByText('Deterministic release notes')).toBeVisible();

		const stateBeforeDownload = await getStubbedUpdateState(electronApp);
		expect(stateBeforeDownload?.checks).toEqual([false]);

		await updateDialog.getByRole('button', { name: /Download and Install Update/ }).click();
		await expect(updateDialog.getByRole('button', { name: 'Restart to Update' })).toBeVisible();
		await updateDialog.getByRole('button', { name: 'Restart to Update' }).click();

		const stateAfterInstall = await getStubbedUpdateState(electronApp);
		expect(stateAfterInstall?.downloads).toBe(1);
		expect(stateAfterInstall?.installs).toBe(1);
	});

	test('shows update check errors and opens the manual releases page', async () => {
		await stubUpdateCheckForModal(electronApp, 'error');
		await stubOpenExternal(electronApp);

		const updateDialog = await openUpdateCheckFromQuickActions(window);
		await expect(updateDialog.getByText('GitHub API unavailable for E2E')).toBeVisible();
		await updateDialog.getByRole('button', { name: 'Check releases manually' }).click();

		await expect
			.poll(() => getStubbedOpenExternalUrl(electronApp))
			.toBe('https://github.com/RunMaestro/Maestro/releases');
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
		const createAgentDialog = await openCreateNewAgentFromQuickActions(window);
		await expect(createAgentDialog.getByLabel('Agent Name')).toBeVisible();
		await expect(createAgentDialog.getByText('Agent Provider')).toBeVisible();
		await expect(createAgentDialog.getByRole('button', { name: 'Create Agent' })).toBeDisabled();
	});

	test('shows available unavailable and coming-soon providers in Create New Agent', async () => {
		await stubAgentDetectionForNewAgent(electronApp);

		const createAgentDialog = await openCreateNewAgentFromQuickActions(window);

		await expect(createAgentDialog.getByRole('option', { name: /Codex/ })).toContainText(
			'Available'
		);
		await expect(createAgentDialog.getByRole('option', { name: /Claude Code/ })).toContainText(
			'Not Found'
		);
		await expect(createAgentDialog.getByRole('option', { name: /OpenCode/ })).toContainText('Beta');
		await expect(createAgentDialog.getByRole('option', { name: /Factory Droid/ })).toContainText(
			'Beta'
		);
		await expect(createAgentDialog.getByRole('option', { name: /Gemini CLI/ })).toContainText(
			'Coming Soon'
		);

		await createAgentDialog.getByRole('option', { name: /OpenCode/ }).click();
		await expect(createAgentDialog.getByPlaceholder('/path/to/opencode')).toBeVisible();
		await expect(createAgentDialog.getByText('MAESTRO_SESSION_RESUMED').first()).toBeVisible();
	});

	test('creates an unavailable non-Codex agent using static custom configuration', async () => {
		const staticProjectDir = path.join(seededWorkbench.homeDir, 'opencode-static-project');
		fs.mkdirSync(staticProjectDir, { recursive: true });
		await stubAgentDetectionForNewAgent(electronApp);

		const createAgentDialog = await openCreateNewAgentFromQuickActions(window);
		await createAgentDialog.getByRole('option', { name: /OpenCode/ }).click();
		await createAgentDialog.getByLabel('Agent Name').fill('OpenCode Static Agent');
		await createAgentDialog.getByLabel('Working Directory').fill(staticProjectDir);
		await createAgentDialog
			.getByPlaceholder('/path/to/opencode')
			.fill('/usr/local/bin/opencode-e2e');
		await createAgentDialog
			.getByPlaceholder('--flag value --another-flag')
			.fill('--model static-e2e');
		await createAgentDialog.getByRole('button', { name: 'Add Variable' }).click();
		await createAgentDialog.getByPlaceholder('VARIABLE_NAME').fill('OPENCODE_E2E');
		await createAgentDialog.getByPlaceholder('value', { exact: true }).fill('1');

		await expect(createAgentDialog.getByRole('button', { name: 'Create Agent' })).toBeEnabled();
		await createAgentDialog.getByRole('button', { name: 'Create Agent' }).click();

		await expect(createAgentDialog).toBeHidden();
		await expect(
			window
				.locator('[data-tour="session-list"]')
				.getByText('OpenCode Static Agent', { exact: true })
		).toBeVisible();
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

	test('surfaces local Git actions for the active repository', async () => {
		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog.getByPlaceholder('Type a command or jump to agent...').fill('Git');

		await expect(quickActionsDialog.getByRole('button', { name: /View Git Diff/ })).toBeVisible();
		await expect(quickActionsDialog.getByRole('button', { name: /View Git Log/ })).toBeVisible();
		await expect(
			quickActionsDialog.getByRole('button', { name: /Refresh Files, Git, History/ })
		).toBeVisible();

		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Repository');
		await expect(
			quickActionsDialog.getByRole('button', { name: /Open Repository in Browser/ })
		).toBeVisible();

		await closeQuickActions(window, quickActionsDialog);
	});

	test('opens Git Diff from Quick Actions for deterministic working tree changes', async () => {
		const gitDiffDialog = await openGitDiffFromQuickActions(window);

		await expect(gitDiffDialog.getByText('2 files changed')).toBeVisible();
		await expect(gitDiffDialog.getByRole('button', { name: /README\.md/ })).toBeVisible();
		await expect(gitDiffDialog.getByRole('button', { name: /FLOW\.md/ })).toBeVisible();
		await expect(gitDiffDialog.getByText('Git diff mermaid sentinel.')).toBeVisible();

		await gitDiffDialog.getByRole('button', { name: /README\.md/ }).click();
		await expect(
			gitDiffDialog.getByText('Working tree diff sentinel for Git Diff E2E.')
		).toBeVisible();

		await gitDiffDialog.getByRole('button', { name: 'Close (Esc)' }).click();
		await expect(gitDiffDialog).toBeHidden();
	});

	test('opens Git Log from Quick Actions and navigates committed history', async () => {
		const gitLogDialog = await openGitLogFromQuickActions(window);

		await expect(gitLogDialog.getByText('2 commits')).toBeVisible({ timeout: 15000 });
		await expect(gitLogDialog.getByText('docs: add git log fixture').first()).toBeVisible();
		await expect(gitLogDialog.getByText('E2E Bot').first()).toBeVisible();
		await expect(gitLogDialog.getByText('NOTES.md').first()).toBeVisible({ timeout: 15000 });
		await expect(gitLogDialog.getByText('Git log committed sentinel.')).toBeVisible({
			timeout: 15000,
		});

		await window.keyboard.press('ArrowDown');
		await expect(gitLogDialog.getByText('Commit 2 of 2')).toBeVisible();
		await expect(gitLogDialog.getByText('chore: seed initial fixture').first()).toBeVisible();

		await gitLogDialog.getByRole('button', { name: 'Close (Esc)' }).click();
		await expect(gitLogDialog).toBeHidden();
	});

	test('shows header Git status details and opens the diff from the widget', async () => {
		const { gitStatusButton, tooltip } = await openHeaderGitStatusTooltip(window);

		await expect(gitStatusButton).toHaveAttribute('title', /\+4/);
		await expect(gitStatusButton).toHaveAttribute('title', /~2/);
		await expect(tooltip.getByText('README.md')).toBeVisible();
		await expect(tooltip.getByText('FLOW.md')).toBeVisible();

		await tooltip.getByRole('button', { name: 'View Full Diff' }).click();
		const gitDiffDialog = window.getByRole('dialog', { name: 'Git Diff Preview' });
		await expect(gitDiffDialog).toBeVisible();
		await expect(gitDiffDialog.getByText('2 files changed')).toBeVisible();
		await gitDiffDialog.getByRole('button', { name: 'Close (Esc)' }).click();
		await expect(gitDiffDialog).toBeHidden();
	});

	test('opens Git Log from the header Git status widget tooltip', async () => {
		const { tooltip } = await openHeaderGitStatusTooltip(window);

		await tooltip.getByRole('button', { name: 'View Git Log' }).click();
		const gitLogDialog = window.getByRole('dialog', { name: 'Git Log Viewer' });
		await expect(gitLogDialog.getByText('2 commits')).toBeVisible({ timeout: 15000 });
		await expect(gitLogDialog.getByText('docs: add git log fixture').first()).toBeVisible();
		await gitLogDialog.getByRole('button', { name: 'Close (Esc)' }).click();
		await expect(gitLogDialog).toBeHidden();
	});

	test('shows a Git remote error when opening a repository without origin', async () => {
		await openRepositoryInBrowserFromQuickActions(window);

		await expect(window.getByText('No Remote URL')).toBeVisible();
		await expect(window.getByText('Could not find a remote URL for this repository')).toBeVisible();
	});

	test('opens the browser URL for a configured Git remote from Quick Actions', async () => {
		await stubOpenExternal(electronApp);
		runGit(seededWorkbench.sessions[0].cwd, [
			'remote',
			'add',
			'origin',
			'git@github.com:RunMaestro/Maestro.git',
		]);

		await openRepositoryInBrowserFromQuickActions(window);

		await expect
			.poll(() => getStubbedOpenExternalUrl(electronApp))
			.toBe('https://github.com/RunMaestro/Maestro');
	});

	test('configures Git worktree directory from the Left Bar context menu', async () => {
		const worktreeModal = await openWorktreeConfigFromContext(window);
		const directoryInput = worktreeModal.getByPlaceholder('/path/to/worktrees');

		await expect(directoryInput).toHaveValue(seededWorkbench.homeDir);
		await expect(worktreeModal.getByText('Watch for new worktrees')).toBeVisible();
		await expect(worktreeModal.getByRole('button', { name: 'Disable' })).toBeDisabled();

		await worktreeModal.getByRole('button', { name: 'Save Configuration' }).click();
		await expect(worktreeModal).toBeHidden();

		const contextMenu = await openSessionContextMenu(window, 'E2E Workbench', 'Create Worktree');
		await expect(
			contextMenu.getByRole('button', { name: 'Configure Worktrees', exact: true })
		).toBeVisible();
		await window.keyboard.press('Escape');
		await expect(contextMenu).toBeHidden();
	});

	test('validates quick Git worktree branch names before creation', async () => {
		await saveDefaultWorktreeConfig(window, seededWorkbench);
		const contextMenu = await openSessionContextMenu(window, 'E2E Workbench', 'Create Worktree');
		await contextMenu.getByRole('button', { name: 'Create Worktree', exact: true }).click();

		const createModal = modalRootByHeading(window, 'Create New Worktree');
		await expect(createModal).toBeVisible();
		await createModal.getByPlaceholder('feature-xyz').fill('bad branch name!');
		await createModal.getByRole('button', { name: 'Create', exact: true }).click();

		await expect(createModal.getByText('Invalid branch name')).toBeVisible();
		await createModal.getByRole('button', { name: 'Cancel' }).click();
		await expect(createModal).toBeHidden();
	});

	test('creates and removes a local Git worktree session from the Left Bar context menu', async () => {
		const branchName = 'e2e-worktree-branch';
		const sessionList = window.locator('[data-tour="session-list"]');
		await saveDefaultWorktreeConfig(window, seededWorkbench);

		let contextMenu = await openSessionContextMenu(window, 'E2E Workbench', 'Create Worktree');
		await contextMenu.getByRole('button', { name: 'Create Worktree', exact: true }).click();

		const createModal = modalRootByHeading(window, 'Create New Worktree');
		await createModal.getByPlaceholder('feature-xyz').fill(branchName);
		await createModal.getByRole('button', { name: 'Create', exact: true }).click();
		await expect(createModal).toBeHidden({ timeout: 15000 });
		await expect(sessionList.getByText(branchName, { exact: true })).toBeVisible({
			timeout: 15000,
		});

		contextMenu = await openSessionContextMenu(window, branchName, 'Remove Worktree');
		await contextMenu.getByRole('button', { name: 'Remove Worktree', exact: true }).click();

		const deleteModal = modalRootByHeading(window, 'Delete Worktree');
		await expect(deleteModal.getByText('Delete worktree session')).toBeVisible();
		await expect(deleteModal.getByText(branchName).first()).toBeVisible();
		await deleteModal.getByRole('button', { name: 'Remove', exact: true }).click();

		await expect(deleteModal).toBeHidden();
		await expect(sessionList.getByText(branchName, { exact: true })).toBeHidden();
	});

	test('shows GitHub CLI authentication guidance in the Create PR modal', async () => {
		const branchName = 'feat-e2e-pr-auth';
		await stubPullRequestCreation(
			electronApp,
			{ installed: true, authenticated: false },
			{ success: false, error: 'not authenticated' }
		);
		await createLocalWorktreeSession(window, seededWorkbench, branchName);

		const contextMenu = await openSessionContextMenu(window, branchName, 'Create Pull Request');
		await contextMenu.getByRole('button', { name: 'Create Pull Request', exact: true }).click();

		const prModal = modalRootByHeading(window, 'Create Pull Request');
		await expect(prModal.getByText('GitHub CLI not authenticated')).toBeVisible();
		await expect(prModal.getByText('gh auth login')).toBeVisible();
		await expect(prModal.getByRole('button', { name: 'Create PR' })).toBeDisabled();
		await prModal.getByRole('button', { name: 'Cancel' }).click();
		await expect(prModal).toBeHidden();
	});

	test('creates a pull request from a worktree child with a stubbed GitHub CLI', async () => {
		const branchName = 'feat-e2e-pr-success';
		const prUrl = 'https://github.com/RunMaestro/Maestro/pull/42';
		await stubPullRequestCreation(
			electronApp,
			{ installed: true, authenticated: true },
			{ success: true, prUrl }
		);
		await createLocalWorktreeSession(window, seededWorkbench, branchName);

		const contextMenu = await openSessionContextMenu(window, branchName, 'Create Pull Request');
		await contextMenu.getByRole('button', { name: 'Create Pull Request', exact: true }).click();

		const prModal = modalRootByHeading(window, 'Create Pull Request');
		await expect(prModal.getByText(branchName).first()).toBeVisible();
		await expect(prModal.getByRole('button', { name: 'Create PR' })).toBeEnabled({
			timeout: 5000,
		});
		await prModal.getByPlaceholder('PR title...').fill('E2E PR title');
		await prModal.getByPlaceholder('Add a description...').fill('E2E PR body');
		await prModal.getByRole('button', { name: 'Create PR' }).click();

		await expect
			.poll(async () => (await getStubbedCreatePRRequest(electronApp))?.title ?? null)
			.toBe('E2E PR title');
		const request = await getStubbedCreatePRRequest(electronApp);
		expect(request).toMatchObject({
			targetBranch: 'main',
			title: 'E2E PR title',
			description: 'E2E PR body',
		});
		expect(request?.worktreePath).toContain(branchName);
		await expect(prModal).toBeHidden({ timeout: 5000 });
		await expect(window.getByText('Pull Request Created')).toBeVisible();
	});

	test('validates the Git worktree configuration directory before saving', async () => {
		const worktreeModal = await openWorktreeConfigFromContext(window);
		const missingDirectory = path.join(seededWorkbench.homeDir, 'missing-worktrees');

		await worktreeModal.getByPlaceholder('/path/to/worktrees').fill(missingDirectory);
		await worktreeModal.getByRole('button', { name: 'Save Configuration' }).click();

		await expect(worktreeModal.getByText('Directory not found')).toBeVisible();
		await worktreeModal.getByRole('button', { name: 'Cancel' }).click();
		await expect(worktreeModal).toBeHidden();
	});

	test('disables a saved Git worktree configuration from the context menu modal', async () => {
		await saveDefaultWorktreeConfig(window, seededWorkbench);
		const worktreeModal = await openWorktreeConfigFromContext(window);

		await expect(worktreeModal.getByRole('button', { name: 'Disable' })).toBeEnabled();
		await worktreeModal.getByRole('button', { name: 'Disable' }).click();
		await expect(worktreeModal).toBeHidden();

		const contextMenu = await openSessionContextMenu(
			window,
			'E2E Workbench',
			'Configure Worktrees'
		);
		await expect(
			contextMenu.getByRole('button', { name: 'Create Worktree', exact: true })
		).toHaveCount(0);
		await window.keyboard.press('Escape');
		await expect(contextMenu).toBeHidden();
	});

	test('creates a Git worktree from configuration and removes it from disk', async () => {
		const branchName = 'e2e-config-worktree';
		const worktreePath = path.join(seededWorkbench.homeDir, branchName);
		const sessionList = window.locator('[data-tour="session-list"]');
		const worktreeModal = await openWorktreeConfigFromContext(window);

		await worktreeModal.getByPlaceholder('feature-xyz').fill(branchName);
		await worktreeModal.getByRole('button', { name: 'Create', exact: true }).click();
		await expect(worktreeModal.getByPlaceholder('feature-xyz')).toHaveValue('', {
			timeout: 15000,
		});
		await worktreeModal.getByRole('button', { name: 'Cancel' }).click();
		await expect(worktreeModal).toBeHidden();
		await expect(sessionList.getByText(branchName, { exact: true })).toBeVisible({
			timeout: 15000,
		});

		const contextMenu = await openSessionContextMenu(window, branchName, 'Remove Worktree');
		await contextMenu.getByRole('button', { name: 'Remove Worktree', exact: true }).click();

		const deleteModal = modalRootByHeading(window, 'Delete Worktree');
		await deleteModal.getByRole('button', { name: 'Remove and Delete', exact: true }).click();

		await expect(deleteModal).toBeHidden({ timeout: 15000 });
		await expect(sessionList.getByText(branchName, { exact: true })).toBeHidden();
		await expect.poll(() => fs.existsSync(worktreePath)).toBe(false);
	});

	test('publishes the active file preview as a secret GitHub Gist with stubbed gh CLI', async () => {
		const gistUrl = 'https://gist.github.com/e2e/file-preview-secret';
		await stubGistPublishing(electronApp, window, { success: true, gistUrl });

		await window.getByTitle('Publish as GitHub Gist').click();
		const publishModal = window.getByRole('dialog', { name: 'Publish as GitHub Gist' });
		await expect(publishModal.getByText('README.md')).toBeVisible();
		await publishModal.getByRole('button', { name: 'Publish Secret' }).click();

		await expect(publishModal).toBeHidden({ timeout: 10000 });
		await expect(window.getByText('Gist Published')).toBeVisible();
		await expect(window.getByTitle('View published gist')).toBeVisible();

		await window.getByTitle('View published gist').click();
		const publishedModal = window.getByRole('dialog', { name: 'Published Gist' });
		await expect(publishedModal.locator('input')).toHaveValue(gistUrl);
		await expect(publishedModal.getByText('secret gist')).toBeVisible();

		await publishedModal.getByRole('button', { name: 'Re-publish' }).click();
		const republishModal = window.getByRole('dialog', { name: 'Re-publish as GitHub Gist' });
		await expect(republishModal.getByText('This will create a new gist')).toBeVisible();
		await republishModal.getByRole('button', { name: 'Back' }).click();
		await expect(window.getByRole('dialog', { name: 'Published Gist' })).toBeVisible();
		await window
			.getByRole('dialog', { name: 'Published Gist' })
			.getByRole('button', { name: 'Close', exact: true })
			.click();
		await expect(window.getByRole('dialog', { name: 'Published Gist' })).toBeHidden();
	});

	test('keeps the GitHub Gist publish modal open when publishing fails', async () => {
		await stubGistPublishing(electronApp, window, {
			success: false,
			error: 'E2E gist publish failure',
		});

		await window.getByTitle('Publish as GitHub Gist').click();
		const publishModal = window.getByRole('dialog', { name: 'Publish as GitHub Gist' });
		await publishModal.getByRole('button', { name: 'Publish Public' }).click();

		await expect(publishModal.getByText('E2E gist publish failure')).toBeVisible();
		await expect(publishModal).toBeVisible();
		await publishModal.getByRole('button', { name: 'Cancel' }).click();
		await expect(publishModal).toBeHidden();
	});

	test('opens the System Log Viewer from Quick Actions', async () => {
		const logViewer = await openSystemLogViewer(window);
		await expect(logViewer.getByText('Maestro System Logs')).toBeVisible();
		await expect(logViewer.getByRole('button', { name: 'ALL', exact: true })).toBeVisible();

		await logViewer.getByTitle('Close log viewer').click();
		await expect(logViewer).toBeHidden();
	});

	test('searches and filters System Log Viewer entries', async () => {
		await seedSystemLogs(window);
		const logViewer = await openSystemLogViewer(window);

		await expect(logViewer.getByText('E2E info sentinel')).toBeVisible();
		await expect(logViewer.getByText('E2E error sentinel')).toBeVisible();
		await expect(logViewer.getByText('E2E warn sentinel')).toBeVisible();

		await logViewer.evaluate((element) => {
			element.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true })
			);
		});
		const searchInput = logViewer.getByPlaceholder('Search logs...');
		await expect(searchInput).toBeVisible();
		await searchInput.fill('error sentinel');
		await expect(logViewer.getByText('E2E error sentinel')).toBeVisible();
		await expect(logViewer.getByText('E2E info sentinel')).toBeHidden();

		await window.keyboard.press('Escape');
		await expect(searchInput).toBeHidden();
		await expect(logViewer.getByText('E2E info sentinel')).toBeVisible();

		await logViewer.locator('button').filter({ hasText: 'INFO' }).click();
		await expect(logViewer.getByText('E2E info sentinel')).toBeHidden();
		await expect(logViewer.getByText('E2E error sentinel')).toBeVisible();
	});

	test('expands structured System Log Viewer data and clears logs after confirmation', async () => {
		await seedSystemLogs(window);
		const logViewer = await openSystemLogViewer(window);

		await logViewer.getByTitle('Expand all').click();
		await expect(logViewer.getByText('system-log-data')).toBeVisible();
		await expect(logViewer.getByText('system-log-error')).toBeVisible();

		await logViewer.getByTitle('Clear logs').click();
		const confirmDialog = window.getByRole('dialog', { name: 'Confirm' });
		await expect(confirmDialog).toBeVisible();
		await expect(confirmDialog.getByText('clear all Maestro system logs')).toBeVisible();
		await confirmDialog.getByRole('button', { name: 'Confirm' }).click();

		await expect(logViewer.getByText('No logs yet')).toBeVisible();
	});

	test('opens the System Processes monitor from Quick Actions', async () => {
		const processMonitor = await openProcessMonitor(window);
		await expect(processMonitor.getByText('System Processes')).toBeVisible();
		await expect(processMonitor.getByTitle('Refresh (R)')).toBeVisible();
		await expect(processMonitor.getByText(/2 sessions.*0 groups/)).toBeVisible();

		await processMonitor.getByTitle('Close (Esc)').click();
		await expect(processMonitor).toBeHidden();
	});

	test('opens Process Monitor details for stubbed active processes', async () => {
		await stubProcessMonitorProcesses(electronApp, seededWorkbench);
		const processMonitor = await openProcessMonitor(window);

		await expect(processMonitor.getByText('2 active')).toBeVisible();
		await expect(processMonitor.getByText('UNGROUPED AGENTS')).toBeVisible();
		await expect(processMonitor.getByText('E2E Workbench - AI Agent (codex)')).toBeVisible();
		await expect(processMonitor.getByText('E2E Terminal - Terminal Shell')).toBeVisible();

		await processMonitor.getByText('E2E Workbench - AI Agent (codex)').dblclick();
		const details = window.getByRole('dialog', { name: 'Process Details' });
		await expect(details).toBeVisible();
		await expect(details.getByText('Process Details')).toBeVisible();
		await expect(details.getByText('Process Session ID')).toBeVisible();
		await expect(details.getByText('gpt-5-codex')).toBeVisible();
		await expect(details.getByText('Tool Type')).toBeVisible();
		await expect(
			details
				.locator('span')
				.filter({ hasText: /^codex$/ })
				.first()
		).toBeVisible();

		await details.getByTitle('Back (Esc)').click();
		await expect(window.getByRole('dialog', { name: 'System Processes' })).toBeVisible();
	});

	test('opens and cancels the Process Monitor kill confirmation', async () => {
		await stubProcessMonitorProcesses(electronApp, seededWorkbench);
		const processMonitor = await openProcessMonitor(window);

		await expect(processMonitor.getByText('E2E Terminal - Terminal Shell')).toBeVisible();
		await processMonitor.getByTitle('Kill process').first().click({ force: true });

		await expect(window.getByText('Kill Process?')).toBeVisible();
		await window.getByRole('button', { name: 'Cancel' }).click();
		await expect(window.getByText('Kill Process?')).toBeHidden();
	});

	test('opens the Usage Dashboard from Quick Actions', async () => {
		const usageDashboard = await openUsageDashboard(window);
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

	test('renders populated Usage Dashboard overview metrics and chart sections', async () => {
		await seedUsageDashboardStats(window);
		const usageDashboard = await openUsageDashboard(window);

		await expect(usageDashboard.getByTestId('usage-dashboard-content')).toBeVisible();
		await expect(usageDashboard.getByTestId('summary-cards')).toBeVisible();
		await expect(usageDashboard.getByText('Total Queries')).toBeVisible();
		await expect(usageDashboard.getByText('Top Agent')).toBeVisible();
		await expect(usageDashboard.getByTestId('summary-cards').getByText('codex')).toBeVisible();
		await expect(usageDashboard.getByTestId('section-agent-comparison')).toBeVisible();
		await expect(usageDashboard.getByTestId('section-source-distribution')).toBeVisible();
		await expect(usageDashboard.getByTestId('section-location-distribution')).toBeVisible();
		await expect(usageDashboard.getByTestId('database-size-indicator')).toBeVisible();
		await expect(usageDashboard.getByText('Showing this week data')).toBeVisible();
	});

	test('shows Activity and Auto Run Usage Dashboard sections for seeded stats', async () => {
		await seedUsageDashboardStats(window);
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Activity' }).click();
		await expect(usageDashboard.getByRole('tab', { name: 'Activity' })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await expect(usageDashboard.getByTestId('section-activity-heatmap')).toBeVisible();
		await expect(usageDashboard.getByTestId('section-weekday-comparison')).toBeVisible();
		await expect(usageDashboard.getByTestId('section-duration-trends')).toBeVisible();

		await usageDashboard.getByRole('tab', { name: 'Auto Run' }).click();
		await expect(usageDashboard.getByRole('tab', { name: 'Auto Run' })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await expect(usageDashboard.getByTestId('section-autorun-stats')).toBeVisible();
		await expect(usageDashboard.getByTestId('autorun-stats')).toBeVisible();
		await expect(usageDashboard.getByText('Total Sessions')).toBeVisible();
		await expect(usageDashboard.getByText('Tasks Done')).toBeVisible();
		await expect(usageDashboard.getByTestId('section-longest-autoruns')).toBeVisible();
		await expect(usageDashboard.getByText(/Top \d+ Longest Auto Runs/)).toBeVisible();
	});

	test('supports keyboard navigation inside the Usage Dashboard', async () => {
		await seedUsageDashboardStats(window);
		const usageDashboard = await openUsageDashboard(window);
		const tabList = usageDashboard.getByTestId('view-mode-tabs');

		await tabList.focus();
		await expect(tabList).toBeFocused();
		await window.keyboard.press('ArrowRight');
		await expect(usageDashboard.getByRole('tab', { name: 'Agents' })).toHaveAttribute(
			'aria-selected',
			'true'
		);

		await window.keyboard.press('Tab');
		await expect(usageDashboard.getByTestId('section-session-stats')).toBeFocused();

		await window.keyboard.press('ArrowDown');
		await expect(usageDashboard.getByTestId('section-agent-efficiency')).toBeFocused();

		await window.keyboard.press('End');
		await expect(usageDashboard.getByTestId('section-agent-usage')).toBeFocused();
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

	test('persists General Settings defaults for history, thinking, and auto-scroll', async () => {
		const settingsDialog = await openSettings(window);

		await settingsDialog.getByText('Enable "History" by default for new tabs').click();
		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					return await window.maestro.settings.get('defaultSaveToHistory');
				});
			})
			.toBe(false);

		await settingsDialog.getByRole('button', { name: 'Sticky' }).click();
		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					return await window.maestro.settings.get('defaultShowThinking');
				});
			})
			.toBe('sticky');

		await settingsDialog.getByRole('button', { name: 'Auto-scroll AI output' }).click();
		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					return await window.maestro.settings.get('autoScrollAiMode');
				});
			})
			.toBe(true);
	});

	test('persists Display Settings for Bionify reading mode', async () => {
		const settingsDialog = await openSettings(window);
		await settingsDialog.locator('button[title="Display"]').click();

		await settingsDialog.getByRole('button', { name: 'Bionify' }).click();
		await settingsDialog.getByRole('button', { name: 'Strong' }).click();

		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					return {
						readingMode: await window.maestro.settings.get('bionifyReadingMode'),
						intensity: await window.maestro.settings.get('bionifyIntensity'),
					};
				});
			})
			.toEqual({ readingMode: true, intensity: 1.35 });
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

	test('persists global Settings environment variables', async () => {
		const settingsDialog = await openGlobalEnvironmentSettings(window);

		await settingsDialog.getByRole('button', { name: 'Add Variable' }).click();
		const keyInput = settingsDialog.getByPlaceholder('VARIABLE').last();
		const valueInput = settingsDialog.getByPlaceholder('value').last();

		await keyInput.fill('MAESTRO_E2E_ENV');
		await valueInput.fill('stable');
		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					return await window.maestro.settings.get('shellEnvVars');
				});
			})
			.toEqual({ MAESTRO_E2E_ENV: 'stable' });

		await valueInput.fill('"stable$value"');
		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					return await window.maestro.settings.get('shellEnvVars');
				});
			})
			.toEqual({ MAESTRO_E2E_ENV: '"stable$value"' });

		await settingsDialog.getByTitle('Remove variable').click();
		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					return await window.maestro.settings.get('shellEnvVars');
				});
			})
			.toEqual({});
	});

	test('creates defaults edits and deletes SSH remote settings', async () => {
		const settingsDialog = await openSshSettings(window);
		await expect(settingsDialog.getByText('No SSH remotes configured')).toBeVisible();

		await settingsDialog.getByRole('button', { name: 'Add SSH Remote' }).click();
		const sshModal = window.getByRole('dialog', { name: 'Add SSH Remote' });
		await expect(sshModal).toBeVisible();
		await expect(sshModal.getByRole('button', { name: 'Save' })).toBeDisabled();

		await sshModal.getByLabel('Display Name').fill('E2E Remote');
		await sshModal.getByLabel('Host', { exact: true }).fill('example.internal');
		await sshModal.getByLabel('Port').fill('2200');
		await sshModal.getByLabel('Username (optional)').fill('codex');
		await sshModal.getByRole('button', { name: 'Add Variable' }).click();
		await sshModal.getByPlaceholder('VARIABLE').fill('MAESTRO_REMOTE_MODE');
		await sshModal.getByPlaceholder('value').fill('e2e');
		await sshModal.getByRole('button', { name: 'Save' }).click();

		await expect(sshModal).toBeHidden();
		await expect(settingsDialog.getByText('E2E Remote')).toBeVisible();
		await expect(settingsDialog.getByText('codex@example.internal:2200')).toBeVisible();
		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					const result = await window.maestro.sshRemote.getConfigs();
					const config = result.configs?.[0];
					return config
						? {
								name: config.name,
								host: config.host,
								port: config.port,
								username: config.username,
								privateKeyPath: config.privateKeyPath,
								remoteEnv: config.remoteEnv,
							}
						: null;
				});
			})
			.toEqual({
				name: 'E2E Remote',
				host: 'example.internal',
				port: 2200,
				username: 'codex',
				privateKeyPath: '',
				remoteEnv: { MAESTRO_REMOTE_MODE: 'e2e' },
			});

		const remoteId = await window.evaluate(async () => {
			const result = await window.maestro.sshRemote.getConfigs();
			return result.configs?.[0]?.id;
		});
		await settingsDialog.getByTitle('Set as default').click();
		await expect(settingsDialog.locator('span').filter({ hasText: /^Default$/ })).toBeVisible();
		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					const result = await window.maestro.sshRemote.getDefaultId();
					return result.id;
				});
			})
			.toBe(remoteId);

		await settingsDialog.getByTitle('Edit').click();
		const editModal = window.getByRole('dialog', { name: 'Edit SSH Remote' });
		await editModal.getByLabel('Display Name').fill('E2E Remote Updated');
		await editModal.getByRole('button', { name: 'Save' }).click();
		await expect(editModal).toBeHidden();
		await expect(settingsDialog.getByText('E2E Remote Updated')).toBeVisible();

		await settingsDialog.getByTitle('Delete').click();
		await expect(settingsDialog.getByText('No SSH remotes configured')).toBeVisible();
		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					const result = await window.maestro.sshRemote.getConfigs();
					return result.configs?.length ?? 0;
				});
			})
			.toBe(0);
	});

	test('imports SSH remote settings from a parsed SSH config host', async () => {
		await stubSshConfigHosts(electronApp);
		const settingsDialog = await openSshSettings(window);

		await settingsDialog.getByRole('button', { name: 'Add SSH Remote' }).click();
		const sshModal = window.getByRole('dialog', { name: 'Add SSH Remote' });
		await expect(sshModal.getByText('Import from SSH Config')).toBeVisible();
		await sshModal.getByRole('button', { name: /Select a host to import/ }).click();
		await sshModal.getByPlaceholder('Type to filter...').fill('build');
		await sshModal.getByRole('button', { name: /e2e-build/ }).click();

		await expect(sshModal.getByText('Imported from:')).toBeVisible();
		await expect(sshModal.getByText('e2e-build')).toBeVisible();
		await expect(sshModal.getByLabel('Display Name')).toHaveValue('e2e-build');
		await expect(sshModal.getByLabel('Host', { exact: true })).toHaveValue('e2e-build');
		await expect(sshModal.getByLabel('Port')).toHaveValue('2200');
		await expect(sshModal.getByLabel('Username (optional)')).toHaveValue('builder');
		await expect(sshModal.getByLabel('Private Key Path (optional)')).toHaveValue('');

		await sshModal.getByRole('button', { name: 'Save' }).click();
		await expect(sshModal).toBeHidden();
		await expect(settingsDialog.getByText('builder@e2e-build:2200')).toBeVisible();
		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					const result = await window.maestro.sshRemote.getConfigs();
					const config = result.configs?.[0];
					return config
						? {
								name: config.name,
								host: config.host,
								port: config.port,
								username: config.username,
								privateKeyPath: config.privateKeyPath,
								useSshConfig: config.useSshConfig,
								sshConfigHost: config.sshConfigHost,
							}
						: null;
				});
			})
			.toEqual({
				name: 'e2e-build',
				host: 'e2e-build',
				port: 2200,
				username: 'builder',
				privateKeyPath: '',
				useSshConfig: true,
				sshConfigHost: 'e2e-build',
			});
	});

	test('persists notification Settings toggles command and toast duration', async () => {
		const settingsDialog = await openSettingsTab(
			window,
			'Notifications',
			'Operating System Notifications'
		);

		await settingsDialog.getByRole('button', { name: /Enable OS Notifications/ }).click();
		await settingsDialog.getByRole('button', { name: /Enable Custom Notification/ }).click();
		await settingsDialog.getByPlaceholder('say').fill('printf maestro-e2e');
		await settingsDialog.getByRole('button', { name: '5s' }).click();

		await expect
			.poll(async () => {
				return await window.evaluate(async () => ({
					osNotificationsEnabled: await window.maestro.settings.get('osNotificationsEnabled'),
					audioFeedbackEnabled: await window.maestro.settings.get('audioFeedbackEnabled'),
					audioFeedbackCommand: await window.maestro.settings.get('audioFeedbackCommand'),
					toastDuration: await window.maestro.settings.get('toastDuration'),
				}));
			})
			.toEqual({
				osNotificationsEnabled: false,
				audioFeedbackEnabled: true,
				audioFeedbackCommand: 'printf maestro-e2e',
				toastDuration: 5,
			});

		await settingsDialog.getByRole('button', { name: 'Never' }).click();
		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					return await window.maestro.settings.get('toastDuration');
				});
			})
			.toBe(0);
	});

	test('creates edits and deletes custom AI command settings', async () => {
		const settingsDialog = await openSettingsTab(window, 'AI Commands', 'Custom AI Commands');

		await settingsDialog.getByRole('button', { name: /Template Variables/ }).click();
		await expect(settingsDialog.getByText('{{CWD}}')).toBeVisible();

		await settingsDialog.getByRole('button', { name: 'Add Command' }).click();
		const createButton = settingsDialog.getByRole('button', { name: 'Create' }).first();
		await expect(createButton).toBeDisabled();

		await settingsDialog.getByPlaceholder('/mycommand').fill('/e2e-check');
		await settingsDialog
			.getByPlaceholder('Short description for autocomplete')
			.fill('E2E command description');
		await settingsDialog
			.getByPlaceholder(/The actual prompt sent to the AI agent/)
			.fill('Review {{CWD}} for E2E coverage gaps.');
		await createButton.click();

		await expect(settingsDialog.getByText('/e2e-check')).toBeVisible();
		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					const commands = await window.maestro.settings.get('customAICommands');
					return Array.isArray(commands)
						? commands.find((command) => command.command === '/e2e-check')
						: undefined;
				});
			})
			.toMatchObject({
				command: '/e2e-check',
				description: 'E2E command description',
				prompt: 'Review {{CWD}} for E2E coverage gaps.',
				isBuiltIn: false,
			});

		await settingsDialog.getByRole('button', { name: /\/e2e-check/ }).click();
		await settingsDialog.getByTitle('Edit command').click();
		const editForm = settingsDialog
			.getByText('/e2e-check')
			.first()
			.locator('xpath=ancestor::div[contains(@class, "space-y-3")][1]');
		await editForm.locator('input').nth(1).fill('Updated E2E command');
		await editForm.locator('textarea').fill('Updated prompt for {{AGENT_NAME}}.');
		await editForm.getByRole('button', { name: 'Save' }).click();
		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					const commands = await window.maestro.settings.get('customAICommands');
					return Array.isArray(commands)
						? commands.find((command) => command.command === '/e2e-check')
						: undefined;
				});
			})
			.toMatchObject({
				description: 'Updated E2E command',
				prompt: 'Updated prompt for {{AGENT_NAME}}.',
			});

		await settingsDialog.getByTitle('Delete command').click();
		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					const commands = await window.maestro.settings.get('customAICommands');
					return Array.isArray(commands)
						? commands.some((command) => command.command === '/e2e-check')
						: true;
				});
			})
			.toBe(false);
	});

	test('edits and resets bundled Spec Kit and OpenSpec command prompts in Settings', async () => {
		await stubSpecKitAndOpenSpecCommands(electronApp);
		const settingsDialog = await openSettingsTab(window, 'AI Commands', 'Custom AI Commands');

		await expect(settingsDialog.getByText('Spec Kit Commands')).toBeVisible();
		await expect(settingsDialog.getByText('OpenSpec Commands')).toBeVisible();
		await expect(settingsDialog.getByText('v1.2.3')).toBeVisible();
		await expect(settingsDialog.getByText('v2.0.1')).toBeVisible();

		await settingsDialog.getByRole('button', { name: /\/speckit\.specify/ }).click();
		const specKitPanel = settingsDialog
			.getByText('/speckit.specify')
			.first()
			.locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]');
		await expect(specKitPanel.getByText('Bundled specify prompt for {{CWD}}.')).toBeVisible();
		await specKitPanel.getByTitle('Edit prompt').click();
		await specKitPanel.locator('textarea').fill('Updated Spec Kit prompt for {{CWD}}.');
		await specKitPanel.getByRole('button', { name: 'Save' }).click();
		await expect(specKitPanel.getByText('Modified')).toBeVisible();
		await expect(specKitPanel.getByText('Updated Spec Kit prompt for {{CWD}}.')).toBeVisible();
		await specKitPanel.getByTitle('Reset to bundled default').click();
		await expect(specKitPanel.getByText('Modified')).toBeHidden();
		await expect(specKitPanel.getByText('Bundled specify prompt for {{CWD}}.')).toBeVisible();

		await settingsDialog.getByRole('button', { name: /\/openspec\.proposal/ }).click();
		const openSpecPanel = settingsDialog
			.getByText('/openspec.proposal')
			.first()
			.locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]');
		await expect(
			openSpecPanel.getByText('Bundled proposal prompt for {{AGENT_NAME}}.')
		).toBeVisible();
		await openSpecPanel.getByTitle('Edit prompt').click();
		await openSpecPanel.locator('textarea').fill('Updated OpenSpec prompt for {{AGENT_NAME}}.');
		await openSpecPanel.getByRole('button', { name: 'Save' }).click();
		await expect(openSpecPanel.getByText('Modified')).toBeVisible();
		await expect(
			openSpecPanel.getByText('Updated OpenSpec prompt for {{AGENT_NAME}}.')
		).toBeVisible();
		await openSpecPanel.getByTitle('Reset to bundled default').click();
		await expect(openSpecPanel.getByText('Modified')).toBeHidden();
		await expect(
			openSpecPanel.getByText('Bundled proposal prompt for {{AGENT_NAME}}.')
		).toBeVisible();
	});
});
