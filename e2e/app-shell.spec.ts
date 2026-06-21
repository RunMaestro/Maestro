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

function setFutureMtime(filePath: string) {
	const future = new Date(Date.now() + 10_000);
	fs.utimesSync(filePath, future, future);
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
	const codexAiLogs = [
		{
			id: `ai-tab-log-shell-${idSuffix}`,
			timestamp: now,
			source: 'stdout',
			text: '# AI Terminal\n\nCodex seeded response is visible.',
		},
		{
			id: `ai-tab-user-log-shell-${idSuffix}`,
			timestamp: now + 1,
			source: 'user',
			text: 'Review README for Codex user-message action coverage',
			delivered: true,
		},
		{
			id: `ai-tab-response-log-shell-${idSuffix}`,
			timestamp: now + 2,
			source: 'stdout',
			text: 'Codex paired response for user-message action coverage.',
		},
	];

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
				aiLogs: codexAiLogs,
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
						logs: codexAiLogs,
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

function createFileExplorerStateWorkbench(variant: 'empty' | 'error' | 'retry') {
	const seeded = createSeededWorkbench();
	const rootDir = path.join(
		seeded.homeDir,
		variant === 'empty' ? 'empty-project' : 'missing-project'
	);
	if (variant === 'empty') {
		fs.mkdirSync(rootDir, { recursive: true });
	}
	const baseSession = seeded.sessions[0];

	return {
		homeDir: seeded.homeDir,
		sessions: [
			{
				...baseSession,
				cwd: rootDir,
				fullPath: rootDir,
				projectRoot: rootDir,
				isGitRepo: false,
				fileTree: [],
				fileTreeError:
					variant === 'error' || variant === 'retry' ? 'E2E file tree error sentinel' : undefined,
				fileTreeLoading: false,
				fileTreeRetryAt: variant === 'retry' ? Date.now() + 60_000 : undefined,
				filePreviewTabs: [],
				activeFileTabId: null,
				unifiedTabOrder: [{ type: 'ai', id: baseSession.activeTabId }],
			},
		],
	};
}

function createQueuedCodexWorkbench() {
	const seeded = createSeededWorkbench();
	const session = seeded.sessions[0]!;
	const activeTab = session.aiTabs[0]!;
	session.executionQueue = [
		{
			id: 'e2e-queued-codex-message',
			timestamp: Date.now() - 1_000,
			tabId: activeTab.id,
			type: 'message',
			text: 'Queued Codex prompt sentinel',
			tabName: activeTab.name || 'Main',
			readOnlyMode: true,
		},
		{
			id: 'e2e-queued-codex-command',
			timestamp: Date.now() - 500,
			tabId: activeTab.id,
			type: 'command',
			command: '/commit queued command sentinel',
			commandDescription: 'Queued commit command sentinel',
			tabName: activeTab.name || 'Main',
		},
	];

	return seeded;
}

function createScrollableTerminalWorkbench() {
	const seeded = createSeededWorkbench();
	const terminalSession = seeded.sessions[1]!;
	const timestamp = Date.now();
	terminalSession.shellLogs.push({
		id: `shell-log-scroll-${timestamp}`,
		timestamp,
		source: 'stdout',
		text: Array.from(
			{ length: 140 },
			(_, index) =>
				`terminal scroll line ${String(index + 1).padStart(3, '0')} e2e output navigation sentinel`
		).join('\n'),
	});
	return seeded;
}

function createCodexNetworkAgentError(sessionId: string) {
	return {
		type: 'network_error' as const,
		message: 'Codex active recoverable network error sentinel',
		recoverable: true,
		agentId: 'codex',
		sessionId,
		timestamp: Date.now(),
		raw: {
			exitCode: 7,
			stderr: 'synthetic active network stderr',
		},
		parsedJson: {
			code: 'codex_active_network_e2e',
			retryable: true,
		},
	};
}

function createActiveCodexErrorWorkbench(
	options: { message?: string; recoverable?: boolean } = {}
) {
	const seeded = createSeededWorkbench();
	const session = seeded.sessions[0]!;
	const activeTab = session.aiTabs[0]!;
	const agentError = {
		...createCodexNetworkAgentError(session.id),
		...options,
	};

	session.state = 'error';
	session.agentError = agentError;
	session.agentErrorTabId = activeTab.id;
	session.agentErrorPaused = true;
	activeTab.agentError = agentError;

	return seeded;
}

function appendCodexStaticSurfaceLogs(seeded: ReturnType<typeof createSeededWorkbench>) {
	const session = seeded.sessions[0];
	const logs = session.aiLogs;
	const baseTimestamp = session.createdAt + 10;
	const errorTimestamp = baseTimestamp + 4;
	const extraLogs = [
		{
			id: `ai-tab-thinking-static-${baseTimestamp}`,
			timestamp: baseTimestamp,
			source: 'thinking' as const,
			text: 'Codex static thinking sentinel about safe terminal coverage.',
		},
		{
			id: `ai-tab-tool-running-static-${baseTimestamp}`,
			timestamp: baseTimestamp + 1,
			source: 'tool' as const,
			text: 'shell',
			metadata: {
				toolState: {
					status: 'running' as const,
					input: {
						cmd: 'npm run lint -- --watch=false',
					},
				},
			},
		},
		{
			id: `ai-tab-tool-completed-static-${baseTimestamp}`,
			timestamp: baseTimestamp + 2,
			source: 'tool' as const,
			text: 'read',
			metadata: {
				toolState: {
					status: 'completed' as const,
					input: {
						path: 'src/renderer/App.tsx',
					},
				},
			},
		},
		{
			id: `ai-tab-tool-error-static-${baseTimestamp}`,
			timestamp: baseTimestamp + 3,
			source: 'tool' as const,
			text: 'apply_patch',
			metadata: {
				toolState: {
					status: 'error' as const,
					input: {
						description: 'failed patch sentinel',
					},
				},
			},
		},
		{
			id: `ai-tab-error-static-${baseTimestamp}`,
			timestamp: errorTimestamp,
			source: 'error' as const,
			text: 'Codex static error sentinel: command failed before retry.',
			agentError: {
				type: 'agent_crashed' as const,
				message: 'Codex historical error detail sentinel',
				recoverable: true,
				agentId: 'codex',
				sessionId: session.id,
				timestamp: errorTimestamp,
				raw: {
					exitCode: 1,
					stderr: 'synthetic static error stderr',
				},
				parsedJson: {
					code: 'synthetic_e2e_static_error',
					phase: 'tool-rendering',
				},
			},
		},
	];

	logs.push(...extraLogs);
	const activeTabLogs = session.aiTabs[0]?.logs;
	if (activeTabLogs && activeTabLogs !== logs) {
		activeTabLogs.push(...extraLogs);
	}
}

type EstablishedAiTabSeed = {
	id: string;
	agentSessionId: string;
	name: string;
	logText: string;
};

function addEstablishedAiTabs(
	seeded: ReturnType<typeof createSeededWorkbench>,
	extraTabs: EstablishedAiTabSeed[]
) {
	const session = seeded.sessions[0];
	const now = Date.now();

	for (const [index, extraTab] of extraTabs.entries()) {
		session.aiTabs.push({
			id: extraTab.id,
			agentSessionId: extraTab.agentSessionId,
			name: extraTab.name,
			starred: false,
			logs: [
				{
					id: `${extraTab.id}-log`,
					timestamp: now + index,
					source: 'stdout' as const,
					text: extraTab.logText,
				},
			],
			inputValue: '',
			stagedImages: [],
			createdAt: now + index,
			state: 'idle' as const,
		});
		session.unifiedTabOrder.push({ type: 'ai', id: extraTab.id });
	}
}

async function dismissTabHoverOverlay(window: Page) {
	await window.mouse.move(0, 0);
	await expect(window.getByRole('button', { name: 'Close Tab', exact: true })).toBeHidden({
		timeout: 2000,
	});
}

async function openTabHoverOverlay(window: Page, tab: Locator, marker = 'Copy Session ID') {
	const overlay = window.locator('div.fixed').filter({ hasText: marker }).first();
	let lastError: unknown;

	for (let attempt = 0; attempt < 3; attempt++) {
		await tab.scrollIntoViewIfNeeded();
		await tab.hover();

		try {
			await expect(overlay).toBeVisible({ timeout: 3000 });
			return overlay;
		} catch (error) {
			lastError = error;
			await window.mouse.move(0, 0);
			await window.waitForTimeout(150);
		}
	}

	throw lastError ?? new Error(`Tab hover overlay did not open for ${marker}`);
}

const E2E_SSH_REMOTE_ID = 'e2e-ssh-remote';
const E2E_SSH_REMOTE_BASE_CWD = '/srv/maestro-e2e/base';
const E2E_SSH_REMOTE_CURRENT_CWD = '/srv/maestro-e2e/current';

function enableTerminalSshRemote(seeded: ReturnType<typeof createSeededWorkbench>) {
	const terminalSession = seeded.sessions[1] as (typeof seeded.sessions)[number] & {
		remoteCwd?: string;
		sessionSshRemoteConfig?: {
			enabled: boolean;
			remoteId: string | null;
			workingDirOverride?: string;
		};
	};
	terminalSession.remoteCwd = E2E_SSH_REMOTE_CURRENT_CWD;
	terminalSession.sessionSshRemoteConfig = {
		enabled: true,
		remoteId: E2E_SSH_REMOTE_ID,
		workingDirOverride: E2E_SSH_REMOTE_BASE_CWD,
	};
}

async function seedSshRemoteConfig(window: Page) {
	await window.evaluate(
		async ({ remoteId }) => {
			await window.maestro.sshRemote.saveConfig({
				id: remoteId,
				name: 'E2E SSH Remote',
				host: 'e2e.example.internal',
				port: 2200,
				username: 'codex',
				privateKeyPath: '',
				enabled: true,
			});
		},
		{ remoteId: E2E_SSH_REMOTE_ID }
	);
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

async function getCustomAICommand(window: Page, commandName: string) {
	return await window.evaluate(async (targetCommand) => {
		const commands = await window.maestro.settings.get('customAICommands');
		return Array.isArray(commands)
			? (commands.find((command) => command.command === targetCommand) ?? null)
			: null;
	}, commandName);
}

async function getCustomAICommandCount(window: Page, commandName: string) {
	return await window.evaluate(async (targetCommand) => {
		const commands = await window.maestro.settings.get('customAICommands');
		return Array.isArray(commands)
			? commands.filter((command) => command.command === targetCommand).length
			: 0;
	}, commandName);
}

function settingsShortcutButton(settingsDialog: Locator, label: string) {
	return settingsDialog
		.getByText(label, { exact: true })
		.locator('xpath=ancestor::div[contains(@class, "border")][1]')
		.getByRole('button')
		.first();
}

async function openThemeSettings(window: Page) {
	const settingsDialog = await openSettings(window);
	await settingsDialog.locator('button[title="Themes"]').click();
	await expect(settingsDialog.getByRole('group', { name: 'Theme picker' })).toBeVisible();
	return settingsDialog;
}

function customThemeBuilder(settingsDialog: Locator) {
	return settingsDialog.locator('[data-theme-id="custom"]');
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

function getRightPanelFrame(window: Page) {
	return window
		.getByRole('button', { name: 'Files' })
		.locator('xpath=ancestor::div[contains(@class, "border-l")][1]');
}

async function expectRightPanelCollapsed(window: Page) {
	const rightPanelFrame = getRightPanelFrame(window);
	await expect(window.getByTitle(/Show right panel/)).toBeVisible();
	await expect(rightPanelFrame).toHaveClass(/w-0/);
	await expect(rightPanelFrame).toHaveCSS('opacity', '0');
}

async function expectAutoRunPanelOpen(window: Page) {
	await expect(window.locator('[data-tour="autorun-panel"]')).toBeVisible();
	await expect(window.getByRole('button', { name: /^Run$/ })).toBeVisible();
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

async function openAgentSessions(window: Page) {
	const quickActionsDialog = await openQuickActions(window);
	await quickActionsDialog
		.getByPlaceholder('Type a command or jump to agent...')
		.fill('View Agent Sessions');
	await quickActionsDialog.getByRole('button', { name: /View Agent Sessions/ }).click();

	await expect(quickActionsDialog).toBeHidden();
	await expect(window.getByText('Agent Sessions for E2E Workbench')).toBeVisible();
	return window;
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

async function stubSelectFolderDialog(electronApp: ElectronApplication, folderPath: string) {
	await electronApp.evaluate(({ ipcMain }, selectedFolder: string) => {
		ipcMain.removeHandler('dialog:selectFolder');
		ipcMain.handle('dialog:selectFolder', async () => selectedFolder);
	}, folderPath);
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

async function stubUsageDashboardCsvSave(electronApp: ElectronApplication, filePath: string) {
	await electronApp.evaluate(({ ipcMain }, exportPath) => {
		ipcMain.removeHandler('dialog:saveFile');
		ipcMain.handle('dialog:saveFile', async () => exportPath);
	}, filePath);
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

type StubbedProcessMonitorProcess = {
	sessionId: string;
	toolType: string;
	pid: number;
	cwd: string;
	isTerminal: boolean;
	isBatchMode: boolean;
	startTime: number;
	command: string;
	args: string[];
};

async function stubProcessMonitorProcesses(
	electronApp: ElectronApplication,
	seeded: ReturnType<typeof createSeededWorkbench>
) {
	const codexSession = seeded.sessions[0];
	const terminalSession = seeded.sessions[1];

	await electronApp.evaluate(
		({ ipcMain }, payload) => {
			const state = globalThis as typeof globalThis & {
				__maestroE2eProcessMonitorProcesses?: StubbedProcessMonitorProcess[];
				__maestroE2eKilledProcessIds?: string[];
				__maestroE2eActiveProcessFetchCount?: number;
				__maestroE2eTerminalCommandResolvers?: Record<string, (code: number) => void>;
			};
			state.__maestroE2eProcessMonitorProcesses = [
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
			];
			state.__maestroE2eKilledProcessIds = [];
			state.__maestroE2eActiveProcessFetchCount = 0;

			ipcMain.removeHandler('process:getActiveProcesses');
			ipcMain.handle('process:getActiveProcesses', async () => {
				state.__maestroE2eActiveProcessFetchCount =
					(state.__maestroE2eActiveProcessFetchCount || 0) + 1;
				return state.__maestroE2eProcessMonitorProcesses || [];
			});

			ipcMain.removeHandler('process:kill');
			ipcMain.handle('process:kill', async (_event, sessionId: string) => {
				state.__maestroE2eKilledProcessIds?.push(sessionId);
				state.__maestroE2eProcessMonitorProcesses =
					state.__maestroE2eProcessMonitorProcesses?.filter(
						(process) => process.sessionId !== sessionId
					) || [];
				const commandSessionId = sessionId.endsWith('-terminal')
					? sessionId.slice(0, -'-terminal'.length)
					: sessionId;
				state.__maestroE2eTerminalCommandResolvers?.[commandSessionId]?.(137);
				return true;
			});
		},
		{
			codexSessionId: codexSession.id,
			codexCwd: codexSession.cwd,
			terminalSessionId: terminalSession.id,
			terminalCwd: terminalSession.cwd,
		}
	);
}

async function stubProcessMonitorWizardProcesses(
	electronApp: ElectronApplication,
	seeded: ReturnType<typeof createSeededWorkbench>
) {
	await stubProcessMonitorProcesses(electronApp, seeded);
	await electronApp.evaluate(
		(_electron, payload) => {
			const state = globalThis as typeof globalThis & {
				__maestroE2eProcessMonitorProcesses?: StubbedProcessMonitorProcess[];
			};
			state.__maestroE2eProcessMonitorProcesses = [
				...(state.__maestroE2eProcessMonitorProcesses || []),
				{
					sessionId: 'inline-wizard-1780097000000-e2e',
					toolType: 'codex',
					pid: 41003,
					cwd: payload.cwd,
					isTerminal: false,
					isBatchMode: false,
					startTime: Date.now() - 30_000,
					command: 'codex',
					args: ['--wizard-conversation'],
				},
				{
					sessionId: 'inline-wizard-gen-1780097000000-e2e',
					toolType: 'codex',
					pid: 41004,
					cwd: payload.cwd,
					isTerminal: false,
					isBatchMode: false,
					startTime: Date.now() - 15_000,
					command: 'codex',
					args: ['--generate-playbook'],
				},
			];
		},
		{ cwd: seeded.sessions[0].cwd }
	);
}

async function getStubbedKilledProcessIds(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eKilledProcessIds?: string[];
		};
		return state.__maestroE2eKilledProcessIds || [];
	});
}

async function getStubbedActiveProcessFetchCount(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eActiveProcessFetchCount?: number;
		};
		return state.__maestroE2eActiveProcessFetchCount || 0;
	});
}

type StubbedAgentSessionUpdate =
	| { type: 'starred'; sessionId: string; starred: boolean }
	| { type: 'name'; sessionId: string; name: string | null };

type StubbedAgentSessionReadCall = {
	sessionId: string;
	offset: number;
	limit?: number;
};

async function stubCodexAgentSessions(
	electronApp: ElectronApplication,
	seeded: ReturnType<typeof createSeededWorkbench>,
	options: { includeHiddenAgentSession?: boolean; paginatedReviewMessages?: boolean } = {}
) {
	await electronApp.evaluate(
		({ ipcMain }, payload) => {
			const state = globalThis as typeof globalThis & {
				__maestroE2eAgentSessionUpdates?: StubbedAgentSessionUpdate[];
				__maestroE2eAgentSessionReadCalls?: StubbedAgentSessionReadCall[];
				__maestroE2eAgentSessionSearchCalls?: Array<{
					agentId: string;
					projectPath: string;
					query: string;
					mode: string;
				}>;
			};
			const now = Date.now();
			const sessions = [
				{
					sessionId: 'codex-review-session',
					projectPath: payload.projectPath,
					timestamp: new Date(now - 120_000).toISOString(),
					modifiedAt: new Date(now - 30_000).toISOString(),
					firstMessage: 'Review README and summarize deterministic risks',
					messageCount: 4,
					sizeBytes: 4096,
					costUsd: 0.12,
					inputTokens: 1200,
					outputTokens: 450,
					cacheReadTokens: 200,
					cacheCreationTokens: 100,
					durationSeconds: 84,
					origin: 'user' as const,
					sessionName: 'Review Checkpoint',
					starred: true,
				},
				{
					sessionId: 'codex-implementation-session',
					projectPath: payload.projectPath,
					timestamp: new Date(now - 90_000).toISOString(),
					modifiedAt: new Date(now - 60_000).toISOString(),
					firstMessage: 'Need final implementation details',
					messageCount: 3,
					sizeBytes: 2048,
					costUsd: 0.04,
					inputTokens: 700,
					outputTokens: 300,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
					durationSeconds: 42,
					origin: 'auto' as const,
					sessionName: 'Implementation Draft',
					starred: false,
				},
				{
					sessionId: 'codex-cli-session',
					projectPath: payload.projectPath,
					timestamp: new Date(now - 180_000).toISOString(),
					modifiedAt: new Date(now - 150_000).toISOString(),
					firstMessage: 'Unnamed CLI sentinel session',
					messageCount: 2,
					sizeBytes: 1024,
					costUsd: 0,
					inputTokens: 200,
					outputTokens: 100,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
					durationSeconds: 12,
					origin: undefined,
					sessionName: undefined,
					starred: false,
				},
			];
			if (payload.includeHiddenAgentSession) {
				sessions.push({
					sessionId: 'agent-codex-hidden-session',
					projectPath: payload.projectPath,
					timestamp: new Date(now - 240_000).toISOString(),
					modifiedAt: new Date(now - 210_000).toISOString(),
					firstMessage: 'Hidden automation sentinel session',
					messageCount: 1,
					sizeBytes: 512,
					costUsd: 0.01,
					inputTokens: 100,
					outputTokens: 40,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
					durationSeconds: 8,
					origin: 'auto' as const,
					sessionName: 'Hidden Agent Run',
					starred: false,
				});
			}
			const messagesBySession = {
				'codex-review-session': [
					{
						type: 'user',
						content: 'Please review deterministic risk coverage.',
						timestamp: new Date(now - 120_000).toISOString(),
						uuid: 'review-user-message',
					},
					{
						type: 'assistant',
						content: 'Refactor response sentinel: keep fixtures local and deterministic.',
						timestamp: new Date(now - 110_000).toISOString(),
						uuid: 'review-assistant-message',
					},
				],
				'codex-implementation-session': [
					{
						type: 'user',
						content: 'Need final implementation details.',
						timestamp: new Date(now - 90_000).toISOString(),
						uuid: 'implementation-user-message',
					},
					{
						type: 'assistant',
						content: 'Implementation response sentinel with scoped assertions.',
						timestamp: new Date(now - 80_000).toISOString(),
						uuid: 'implementation-assistant-message',
					},
				],
				'codex-cli-session': [
					{
						type: 'user',
						content: 'Unnamed CLI message sentinel.',
						timestamp: new Date(now - 180_000).toISOString(),
						uuid: 'cli-user-message',
					},
				],
			};
			const origins = {
				'codex-review-session': {
					origin: 'user' as const,
					sessionName: 'Review Checkpoint',
					starred: true,
				},
				'codex-implementation-session': {
					origin: 'auto' as const,
					sessionName: 'Implementation Draft',
					starred: false,
				},
			};
			state.__maestroE2eAgentSessionUpdates = [];
			state.__maestroE2eAgentSessionReadCalls = [];
			state.__maestroE2eAgentSessionSearchCalls = [];

			ipcMain.removeHandler('agentSessions:getOrigins');
			ipcMain.handle('agentSessions:getOrigins', async () => origins);

			ipcMain.removeHandler('agentSessions:listPaginated');
			ipcMain.handle('agentSessions:listPaginated', async () => ({
				sessions,
				hasMore: false,
				totalCount: sessions.length,
				nextCursor: null,
			}));

			ipcMain.removeHandler('agentSessions:read');
			ipcMain.handle(
				'agentSessions:read',
				async (_event, _agentId, _projectPath, sessionId, readOptions) => {
					const offset = Number(readOptions?.offset ?? 0);
					const limit = Number(readOptions?.limit ?? 20);
					state.__maestroE2eAgentSessionReadCalls?.push({ sessionId, offset, limit });

					if (payload.paginatedReviewMessages && sessionId === 'codex-review-session') {
						const paginatedMessages = [
							{
								type: 'user',
								content: 'Earlier planning sentinel before the visible page.',
								timestamp: new Date(now - 140_000).toISOString(),
								uuid: 'review-earlier-user-message',
							},
							{
								type: 'assistant',
								content: 'Earlier assistant sentinel before the visible page.',
								timestamp: new Date(now - 130_000).toISOString(),
								uuid: 'review-earlier-assistant-message',
							},
							...messagesBySession['codex-review-session'],
						];
						const page = offset === 0 ? paginatedMessages.slice(2) : paginatedMessages.slice(0, 2);
						return {
							messages: page,
							total: paginatedMessages.length,
							hasMore: offset + page.length < paginatedMessages.length,
						};
					}

					const messages = messagesBySession[sessionId as keyof typeof messagesBySession] || [];
					return {
						messages,
						total: messages.length,
						hasMore: false,
					};
				}
			);

			ipcMain.removeHandler('agentSessions:search');
			ipcMain.handle('agentSessions:search', async (_event, agentId, projectPath, query, mode) => {
				state.__maestroE2eAgentSessionSearchCalls?.push({
					agentId,
					projectPath,
					query,
					mode,
				});
				const normalizedQuery = String(query).toLowerCase();
				if (mode === 'user' && normalizedQuery.includes('review')) {
					return [
						{
							sessionId: 'codex-review-session',
							matchType: 'user',
							matchPreview: 'Please review deterministic risk coverage',
							matchCount: 1,
						},
					];
				}
				if (mode === 'assistant' && normalizedQuery.includes('implementation')) {
					return [
						{
							sessionId: 'codex-implementation-session',
							matchType: 'assistant',
							matchPreview: 'Implementation response sentinel',
							matchCount: 1,
						},
					];
				}
				if (normalizedQuery.includes('refactor')) {
					return [
						{
							sessionId: 'codex-review-session',
							matchType: 'assistant',
							matchPreview: 'Refactor response sentinel',
							matchCount: 2,
						},
					];
				}
				return [];
			});

			ipcMain.removeHandler('agentSessions:setSessionStarred');
			ipcMain.handle(
				'agentSessions:setSessionStarred',
				async (_event, _agentId, _projectPath, sessionId, starred) => {
					state.__maestroE2eAgentSessionUpdates?.push({
						type: 'starred',
						sessionId,
						starred,
					});
					return true;
				}
			);

			ipcMain.removeHandler('agentSessions:setSessionName');
			ipcMain.handle(
				'agentSessions:setSessionName',
				async (_event, _agentId, _projectPath, sessionId, name) => {
					state.__maestroE2eAgentSessionUpdates?.push({
						type: 'name',
						sessionId,
						name,
					});
					return true;
				}
			);
		},
		{ projectPath: seeded.sessions[0].projectRoot, ...options }
	);
}

async function getStubbedAgentSessionUpdates(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eAgentSessionUpdates?: StubbedAgentSessionUpdate[];
		};
		return state.__maestroE2eAgentSessionUpdates || [];
	});
}

async function getStubbedAgentSessionReadCalls(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eAgentSessionReadCalls?: StubbedAgentSessionReadCall[];
		};
		return state.__maestroE2eAgentSessionReadCalls || [];
	});
}

async function getStubbedAgentSessionSearchCalls(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eAgentSessionSearchCalls?: Array<{
				agentId: string;
				projectPath: string;
				query: string;
				mode: string;
			}>;
		};
		return state.__maestroE2eAgentSessionSearchCalls || [];
	});
}

type TerminalRunCommandCall = {
	sessionId: string;
	command: string;
	cwd: string;
	sessionSshRemoteConfig?: {
		enabled: boolean;
		remoteId: string | null;
		workingDirOverride?: string;
	};
};

type ProcessResizeCall = {
	sessionId: string;
	cols: number;
	rows: number;
};

type CodexProcessSpawnCall = {
	sessionId: string;
	toolType: string;
	cwd: string;
	command: string;
	args: string[];
	prompt?: string;
	images?: string[];
	agentSessionId?: string;
	readOnlyMode?: boolean;
	sendPromptViaStdin?: boolean;
	sendPromptViaStdinRaw?: boolean;
};

async function stubCodexProcessSpawn(
	electronApp: ElectronApplication,
	options: { exitDelayMs?: number } = {}
) {
	await electronApp.evaluate(({ ipcMain }, { exitDelayMs }) => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eCodexSpawnCalls?: CodexProcessSpawnCall[];
		};
		state.__maestroE2eCodexSpawnCalls = [];

		ipcMain.removeHandler('process:spawn');
		ipcMain.handle('process:spawn', async (event, config: CodexProcessSpawnCall) => {
			state.__maestroE2eCodexSpawnCalls?.push(config);
			event.sender.send(
				'process:data',
				config.sessionId,
				'Codex stubbed spawn response sentinel\n'
			);
			setTimeout(() => {
				if (!event.sender.isDestroyed()) {
					event.sender.send('process:exit', config.sessionId, 0);
				}
			}, exitDelayMs ?? 150);
			return { pid: 41006, success: true };
		});
	}, options);
}

async function getStubbedCodexProcessSpawnCalls(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eCodexSpawnCalls?: CodexProcessSpawnCall[];
		};
		return state.__maestroE2eCodexSpawnCalls || [];
	});
}

async function stubProcessInterrupt(
	electronApp: ElectronApplication,
	options: { fail?: boolean } = {}
) {
	await electronApp.evaluate(({ ipcMain }, { fail }) => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eProcessInterruptCalls?: string[];
			__maestroE2eTerminalCommandResolvers?: Record<string, (code: number) => void>;
		};
		state.__maestroE2eProcessInterruptCalls = [];

		ipcMain.removeHandler('process:interrupt');
		ipcMain.handle('process:interrupt', async (_event, sessionId: string) => {
			state.__maestroE2eProcessInterruptCalls?.push(sessionId);
			if (fail) {
				throw new Error('terminal interrupt failure sentinel');
			}
			const commandSessionId = sessionId.endsWith('-terminal')
				? sessionId.slice(0, -'-terminal'.length)
				: sessionId;
			state.__maestroE2eTerminalCommandResolvers?.[commandSessionId]?.(130);
			return true;
		});
	}, options);
}

async function getStubbedProcessInterruptCalls(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eProcessInterruptCalls?: string[];
		};
		return state.__maestroE2eProcessInterruptCalls || [];
	});
}

async function stubTerminalRunCommand(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eRunCommandCalls?: TerminalRunCommandCall[];
			__maestroE2eProcessMonitorProcesses?: StubbedProcessMonitorProcess[];
			__maestroE2eTerminalCommandResolvers?: Record<string, (code: number) => void>;
		};
		state.__maestroE2eRunCommandCalls = [];

		ipcMain.removeHandler('process:runCommand');
		ipcMain.handle(
			'process:runCommand',
			async (
				event,
				config: {
					sessionId: string;
					command: string;
					cwd: string;
					sessionSshRemoteConfig?: {
						enabled: boolean;
						remoteId: string | null;
						workingDirOverride?: string;
					};
				}
			) => {
				state.__maestroE2eRunCommandCalls?.push({
					sessionId: config.sessionId,
					command: config.command,
					cwd: config.cwd,
					sessionSshRemoteConfig: config.sessionSshRemoteConfig,
				});

				const sendExit = (code: number) => {
					event.sender.send('process:command-exit', config.sessionId, code);
					return { exitCode: code };
				};

				if (config.command.includes('terminal live stdout sentinel')) {
					await new Promise((resolve) => setTimeout(resolve, 500));
					event.sender.send('process:data', config.sessionId, 'terminal live stdout sentinel\n');
					return sendExit(0);
				}

				if (config.command.includes('terminal interrupt hold sentinel')) {
					event.sender.send(
						'process:data',
						config.sessionId,
						'terminal interrupt hold sentinel started\n'
					);
					return new Promise<{ exitCode: number }>((resolve) => {
						state.__maestroE2eTerminalCommandResolvers = {
							...(state.__maestroE2eTerminalCommandResolvers || {}),
							[config.sessionId]: (code: number) => {
								if (!event.sender.isDestroyed()) {
									event.sender.send(
										'process:data',
										config.sessionId,
										`terminal interrupt hold sentinel stopped ${code}\n`
									);
									event.sender.send('process:command-exit', config.sessionId, code);
								}
								delete state.__maestroE2eTerminalCommandResolvers?.[config.sessionId];
								resolve({ exitCode: code });
							},
						};
					});
				}

				if (config.command.includes('terminal monitored process sentinel')) {
					const processSessionId = `${config.sessionId}-terminal`;
					const originalProcess = state.__maestroE2eProcessMonitorProcesses?.find(
						(process) => process.sessionId === processSessionId
					);
					state.__maestroE2eProcessMonitorProcesses = [
						...(state.__maestroE2eProcessMonitorProcesses || []).filter(
							(process) => process.sessionId !== processSessionId
						),
						{
							sessionId: processSessionId,
							toolType: 'terminal',
							pid: 41005,
							cwd: config.cwd,
							isTerminal: true,
							isBatchMode: false,
							startTime: Date.now(),
							command: 'zsh',
							args: ['-lc', config.command],
						},
					];
					event.sender.send(
						'process:data',
						config.sessionId,
						'terminal monitored process started\n'
					);
					await new Promise((resolve) => setTimeout(resolve, 8_000));
					state.__maestroE2eProcessMonitorProcesses = (
						state.__maestroE2eProcessMonitorProcesses || []
					).filter((process) => process.sessionId !== processSessionId);
					if (originalProcess) {
						state.__maestroE2eProcessMonitorProcesses.push(originalProcess);
					}
					event.sender.send('process:data', config.sessionId, 'terminal monitored process done\n');
					return sendExit(0);
				}

				if (config.command.includes('terminal live failure sentinel')) {
					event.sender.send('process:stderr', config.sessionId, 'terminal live stderr sentinel\n');
					return sendExit(7);
				}

				if (config.command.includes('terminal setup failure sentinel')) {
					await new Promise((resolve) => setTimeout(resolve, 100));
					throw new Error('shell setup sentinel');
				}

				if (config.command.trim() === 'pwd') {
					event.sender.send('process:data', config.sessionId, `${config.cwd}\n`);
					return sendExit(0);
				}

				return sendExit(0);
			}
		);
	});
}

async function getStubbedTerminalRunCommandCalls(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eRunCommandCalls?: TerminalRunCommandCall[];
		};
		return state.__maestroE2eRunCommandCalls || [];
	});
}

async function stubProcessResize(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eProcessResizeCalls?: ProcessResizeCall[];
		};
		state.__maestroE2eProcessResizeCalls = [];

		ipcMain.removeHandler('process:resize');
		ipcMain.handle(
			'process:resize',
			async (_event, sessionId: string, cols: number, rows: number) => {
				state.__maestroE2eProcessResizeCalls?.push({ sessionId, cols, rows });
				return true;
			}
		);
	});
}

async function getStubbedProcessResizeCalls(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eProcessResizeCalls?: ProcessResizeCall[];
		};
		return state.__maestroE2eProcessResizeCalls || [];
	});
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

type StubbedShellPathCall = {
	type: 'openPath' | 'showItemInFolder';
	itemPath: string;
};

async function stubShellPathHandlers(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eShellPathCalls?: StubbedShellPathCall[];
		};
		state.__maestroE2eShellPathCalls = [];
		ipcMain.removeHandler('shell:openPath');
		ipcMain.handle('shell:openPath', async (_event, itemPath: string) => {
			state.__maestroE2eShellPathCalls?.push({ type: 'openPath', itemPath });
			return '';
		});
		ipcMain.removeHandler('shell:showItemInFolder');
		ipcMain.handle('shell:showItemInFolder', async (_event, itemPath: string) => {
			state.__maestroE2eShellPathCalls?.push({ type: 'showItemInFolder', itemPath });
		});
	});
}

async function getStubbedShellPathCalls(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eShellPathCalls?: StubbedShellPathCall[];
		};
		return state.__maestroE2eShellPathCalls ?? [];
	});
}

async function stubShellDetection(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		ipcMain.removeHandler('shells:detect');
		ipcMain.handle('shells:detect', async () => [
			{ id: 'zsh', name: 'Zsh', path: '/bin/zsh', available: true },
			{ id: 'fish', name: 'Fish', path: '/opt/e2e/fish', available: true },
			{ id: 'nu', name: 'Nushell', available: false },
		]);
	});
}

async function stubFontDetection(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		ipcMain.removeHandler('fonts:detect');
		ipcMain.handle('fonts:detect', async () => ['Menlo', 'JetBrains Mono', 'E2E System Mono']);
	});
}

async function stubWakaTimeHandlers(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		ipcMain.removeHandler('wakatime:checkCli');
		ipcMain.handle('wakatime:checkCli', async () => ({
			available: true,
			version: 'wakatime-cli 99.0.0-e2e',
		}));
		ipcMain.removeHandler('wakatime:validateApiKey');
		ipcMain.handle('wakatime:validateApiKey', async (_event, key: string) => ({
			valid: key.startsWith('waka_'),
		}));
	});
}

async function stubStatsDataManagement(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eStatsClearDays?: number[];
			__maestroE2eStatsDbSize?: number;
		};
		state.__maestroE2eStatsClearDays = [];
		state.__maestroE2eStatsDbSize = 2 * 1024 * 1024;

		ipcMain.removeHandler('stats:get-database-size');
		ipcMain.handle('stats:get-database-size', async () => state.__maestroE2eStatsDbSize);
		ipcMain.removeHandler('stats:get-earliest-timestamp');
		ipcMain.handle('stats:get-earliest-timestamp', async () => Date.UTC(2026, 0, 2));
		ipcMain.removeHandler('stats:clear-old-data');
		ipcMain.handle('stats:clear-old-data', async (_event, olderThanDays: number) => {
			state.__maestroE2eStatsClearDays?.push(olderThanDays);
			state.__maestroE2eStatsDbSize = 1024 * 1024;
			return {
				success: true,
				deletedQueryEvents: 2,
				deletedAutoRunSessions: 1,
				deletedAutoRunTasks: 3,
			};
		});
	});
}

async function getStubbedStatsClearDays(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eStatsClearDays?: number[];
		};
		return state.__maestroE2eStatsClearDays ?? [];
	});
}

async function stubStorageSyncHandlers(electronApp: ElectronApplication, selectedFolder: string) {
	await electronApp.evaluate(
		({ ipcMain }, payload: { selectedFolder: string; defaultPath: string }) => {
			const state = globalThis as typeof globalThis & {
				__maestroE2eCustomSyncPath?: string;
			};
			state.__maestroE2eCustomSyncPath = undefined;

			ipcMain.removeHandler('sync:getDefaultPath');
			ipcMain.handle('sync:getDefaultPath', async () => payload.defaultPath);
			ipcMain.removeHandler('sync:getSettings');
			ipcMain.handle('sync:getSettings', async () => ({
				customSyncPath: state.__maestroE2eCustomSyncPath,
			}));
			ipcMain.removeHandler('sync:getCurrentStoragePath');
			ipcMain.handle(
				'sync:getCurrentStoragePath',
				async () => state.__maestroE2eCustomSyncPath ?? payload.defaultPath
			);
			ipcMain.removeHandler('sync:selectSyncFolder');
			ipcMain.handle('sync:selectSyncFolder', async () => payload.selectedFolder);
			ipcMain.removeHandler('sync:setCustomPath');
			ipcMain.handle('sync:setCustomPath', async (_event, customPath: string | null) => {
				state.__maestroE2eCustomSyncPath = customPath ?? undefined;
				return { success: true, migrated: customPath ? 3 : 2 };
			});
		},
		{
			selectedFolder,
			defaultPath: '/tmp/maestro-e2e-default-storage',
		}
	);
}

async function stubNotificationHandlers(
	electronApp: ElectronApplication,
	mode: 'success' | 'error' = 'success'
) {
	await electronApp.evaluate(
		({ ipcMain }, payload: { mode: 'success' | 'error' }) => {
			const state = globalThis as typeof globalThis & {
				__maestroE2eNotificationCalls?: {
					shows: Array<{ title: string; body: string }>;
					speaks: Array<{ text: string; command: string }>;
					stops: number[];
				};
			};
			state.__maestroE2eNotificationCalls = { shows: [], speaks: [], stops: [] };

			ipcMain.removeHandler('notification:show');
			ipcMain.handle('notification:show', async (_event, title: string, body: string) => {
				state.__maestroE2eNotificationCalls!.shows.push({ title, body });
				return { success: true };
			});
			ipcMain.removeHandler('notification:speak');
			ipcMain.handle('notification:speak', async (_event, text: string, command: string) => {
				state.__maestroE2eNotificationCalls!.speaks.push({ text, command });
				if (payload.mode === 'error') {
					return { success: false, error: 'E2E notification command failed' };
				}
				return { success: true, notificationId: 7001 };
			});
			ipcMain.removeHandler('notification:stopSpeak');
			ipcMain.handle('notification:stopSpeak', async (_event, notificationId: number) => {
				state.__maestroE2eNotificationCalls!.stops.push(notificationId);
				return { success: true };
			});
		},
		{ mode }
	);
}

async function getStubbedNotificationCalls(electronApp: ElectronApplication) {
	return await electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eNotificationCalls?: {
				shows: Array<{ title: string; body: string }>;
				speaks: Array<{ text: string; command: string }>;
				stops: number[];
			};
		};
		return state.__maestroE2eNotificationCalls ?? { shows: [], speaks: [], stops: [] };
	});
}

async function emitNotificationCommandCompleted(
	electronApp: ElectronApplication,
	notificationId: number
) {
	await electronApp.evaluate(({ BrowserWindow }, completedId: number) => {
		const appWindow = BrowserWindow.getAllWindows()[0];
		appWindow?.webContents.send('notification:commandCompleted', completedId);
	}, notificationId);
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

async function stubAgentDetectionForNewAgent(
	electronApp: ElectronApplication,
	options: { refreshedAgentId?: string; refreshedPath?: string } = {}
) {
	await electronApp.evaluate(({ ipcMain }, refreshOptions) => {
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
		ipcMain.handle('agents:refresh', async (_event, agentId: string) => {
			const refreshedAgents =
				refreshOptions.refreshedAgentId === agentId
					? agents.map((candidate) =>
							candidate.id === agentId
								? {
										...candidate,
										available: true,
										path: refreshOptions.refreshedPath ?? `/opt/e2e/bin/${candidate.binaryName}`,
									}
								: candidate
						)
					: agents;
			const agent = refreshedAgents.find((candidate) => candidate.id === agentId);
			return {
				agents: refreshedAgents,
				debugInfo: agentId
					? {
							agentId,
							available: agent?.available || false,
							path: agent?.path || null,
							binaryName: agent?.binaryName || agentId,
							envPath: '/opt/e2e/bin:/usr/bin',
							homeDir: '/Users/e2e',
							platform: 'darwin',
							whichCommand: 'which',
							error: agent?.available
								? null
								: `which ${agent?.binaryName || agentId} failed (exit code 1): e2e binary missing`,
						}
					: null,
			};
		});
		ipcMain.removeHandler('agents:getConfig');
		ipcMain.handle('agents:getConfig', async () => ({}));
		ipcMain.removeHandler('agents:setConfig');
		ipcMain.handle('agents:setConfig', async () => true);
		ipcMain.removeHandler('agents:getModels');
		ipcMain.handle('agents:getModels', async () => []);
	}, options);
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

async function stubEmptySpecKitAndOpenSpecCommands(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		const makeMetadata = (sourceVersion: string, sourceUrl: string) => ({
			lastRefreshed: '2026-05-29T12:00:00.000Z',
			commitSha: sourceVersion,
			sourceVersion,
			sourceUrl,
		});

		ipcMain.removeHandler('speckit:getMetadata');
		ipcMain.handle('speckit:getMetadata', async () => ({
			success: true,
			metadata: makeMetadata('empty-spec-kit', 'https://github.com/github/spec-kit'),
		}));
		ipcMain.removeHandler('speckit:getPrompts');
		ipcMain.handle('speckit:getPrompts', async () => ({ success: true, commands: [] }));
		ipcMain.removeHandler('openspec:getMetadata');
		ipcMain.handle('openspec:getMetadata', async () => ({
			success: true,
			metadata: makeMetadata('empty-openspec', 'https://github.com/Fission-AI/OpenSpec'),
		}));
		ipcMain.removeHandler('openspec:getPrompts');
		ipcMain.handle('openspec:getPrompts', async () => ({ success: true, commands: [] }));
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

async function getTerminalOutputScrollState(window: Page) {
	return window.getByLabel('Terminal output').evaluate((region) => {
		const scroller = Array.from(region.querySelectorAll<HTMLElement>('div')).find((element) => {
			const style = window.getComputedStyle(element);
			return style.overflowY === 'auto' && element.scrollHeight > element.clientHeight;
		});
		if (!scroller) {
			return {
				scrollTop: 0,
				scrollHeight: 0,
				clientHeight: 0,
				maxScrollTop: 0,
			};
		}
		return {
			scrollTop: scroller.scrollTop,
			scrollHeight: scroller.scrollHeight,
			clientHeight: scroller.clientHeight,
			maxScrollTop: Math.max(0, scroller.scrollHeight - scroller.clientHeight),
		};
	});
}

async function openSeededCodexAiTerminal(window: Page) {
	await window
		.locator('[data-tour="session-list"]')
		.getByText('E2E Workbench', { exact: true })
		.first()
		.click();
	await window.getByText('Main', { exact: true }).click();
	await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();
	const promptInput = window.getByPlaceholder(/Talking to E2E Workbench powered by Codex/);
	await expect(promptInput).toBeVisible();
	return promptInput;
}

async function openDocumentGraphFromPreview(window: Page) {
	await window.getByTitle('View in Document Graph (⌘ ⇧ G)').click();
	const graphDialog = window.getByRole('dialog', { name: 'Document Graph' });
	await expect(graphDialog).toBeVisible({ timeout: 15000 });
	await expect(graphDialog.getByText(/2 documents/)).toBeVisible({ timeout: 15000 });
	return graphDialog;
}

async function focusDocumentGraphMindMap(graphDialog: Locator) {
	await graphDialog.locator('canvas').evaluate((canvas) => {
		(canvas.parentElement as HTMLElement | null)?.focus();
	});
}

async function openDocumentGraphCenterNodeContextMenu(window: Page, graphDialog: Locator) {
	const canvas = graphDialog.locator('canvas');
	await expect(canvas).toBeVisible();
	await focusDocumentGraphMindMap(graphDialog);

	const box = await canvas.boundingBox();

	if (!box) {
		throw new Error('Document Graph canvas is not visible');
	}

	const contextMenu = window.locator('.fixed').filter({
		has: window.getByRole('button', { name: 'Copy Path' }),
	});
	const candidates = [
		[0, 0],
		[0, -36],
		[-80, -36],
		[80, -36],
		[-80, 24],
		[80, 24],
		[0, 48],
	];
	let lastError: unknown;

	for (const [index, [offsetX, offsetY]] of candidates.entries()) {
		if (index > 0) {
			await window.keyboard.press('Escape');
			await window.waitForTimeout(100);
		}
		await window.mouse.move(box.x + box.width / 2 + offsetX, box.y + box.height / 2 + offsetY);
		await window.mouse.click(box.x + box.width / 2 + offsetX, box.y + box.height / 2 + offsetY, {
			button: 'right',
		});

		try {
			await expect(contextMenu.getByRole('button', { name: 'Open' })).toBeVisible({
				timeout: 1500,
			});
			await expect(contextMenu.getByRole('button', { name: 'Copy Path' })).toBeVisible({
				timeout: 1500,
			});
			await expect(contextMenu.getByRole('button', { name: 'Focus' })).toBeVisible({
				timeout: 1500,
			});
			return contextMenu;
		} catch (error) {
			lastError = error;
		}
	}

	throw lastError ?? new Error('Document Graph node context menu did not open');
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

function promptComposerDialog(window: Page) {
	return window
		.getByText('Prompt Composer')
		.locator('xpath=ancestor::div[contains(@class, "z-10")][1]');
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

async function stubEncoreCodexAgent(
	electronApp: ElectronApplication,
	initialConfig: Record<string, unknown> = {}
) {
	await electronApp.evaluate(({ ipcMain }, config) => {
		const configs: Record<string, Record<string, unknown>> = {
			codex: { ...config },
		};
		const codexAgent = {
			id: 'codex',
			name: 'Codex',
			binaryName: 'codex',
			command: 'codex',
			args: [],
			available: true,
			hidden: false,
			path: '/usr/local/bin/codex',
			capabilities: {
				supportsBatchMode: true,
				supportsModelSelection: true,
			},
			configOptions: [
				{
					key: 'model',
					type: 'text',
					label: 'Model',
					description: 'Model override for E2E coverage.',
					default: '',
				},
				{
					key: 'contextWindow',
					type: 'number',
					label: 'Context Window Size',
					description: 'Maximum context window size in tokens.',
					default: 400000,
				},
			],
		};

		ipcMain.removeHandler('agents:detect');
		ipcMain.handle('agents:detect', async () => [codexAgent]);
		ipcMain.removeHandler('agents:refresh');
		ipcMain.handle('agents:refresh', async () => codexAgent);
		ipcMain.removeHandler('agents:getConfig');
		ipcMain.handle('agents:getConfig', async (_event, agentId: string) => configs[agentId] || {});
		ipcMain.removeHandler('agents:setConfig');
		ipcMain.handle(
			'agents:setConfig',
			async (_event, agentId: string, nextConfig: Record<string, unknown>) => {
				configs[agentId] = { ...nextConfig };
				return true;
			}
		);
		ipcMain.removeHandler('agents:getModels');
		ipcMain.handle('agents:getModels', async () => ['gpt-5.3-codex', 'o3']);
	}, initialConfig);
}

async function stubNoEncoreAgents(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		ipcMain.removeHandler('agents:detect');
		ipcMain.handle('agents:detect', async () => []);
		ipcMain.removeHandler('agents:refresh');
		ipcMain.handle('agents:refresh', async () => undefined);
		ipcMain.removeHandler('agents:getConfig');
		ipcMain.handle('agents:getConfig', async () => ({}));
		ipcMain.removeHandler('agents:setConfig');
		ipcMain.handle('agents:setConfig', async () => true);
		ipcMain.removeHandler('agents:getModels');
		ipcMain.handle('agents:getModels', async () => []);
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

async function clearHistoryEntries(window: Page, sessionId: string) {
	await window.evaluate(
		async ({ sessionId }) => {
			const existingEntries = await window.maestro.history.getAll(undefined, sessionId);
			for (const entry of existingEntries) {
				await window.maestro.history.delete(entry.id, sessionId);
			}
		},
		{ sessionId }
	);
}

async function seedHistoryEntries(
	window: Page,
	projectPath: string,
	sessionId: string,
	now = Date.now()
) {
	await clearHistoryEntries(window, sessionId);

	await window.evaluate(
		async ({ projectPath, sessionId, now }) => {
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

	async function launchSeededWorkbench() {
		const launched = await helpers.launchAppWithState({
			homeDir: seededWorkbench.homeDir,
			sessions: seededWorkbench.sessions,
			settings: {
				encoreFeatures: {
					directorNotes: true,
				},
				directorNotesSettings: {
					provider: 'codex',
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
	}

	async function relaunchWithEstablishedAiTabs(extraTabs: EstablishedAiTabSeed[]) {
		await cleanupApp?.();
		cleanupApp = undefined;
		seededWorkbench = createSeededWorkbench();
		addEstablishedAiTabs(seededWorkbench, extraTabs);
		await launchSeededWorkbench();
	}

	test.beforeEach(async () => {
		seededWorkbench = createSeededWorkbench();
		await launchSeededWorkbench();
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

	test('toggles shell side panels from shortcuts and panel controls', async () => {
		await expect(window.locator('[data-tour="session-list"]')).toBeVisible();
		await expect(window.locator('[data-tour="files-panel"]')).toBeVisible();

		await window.keyboard.press('Alt+Meta+ArrowLeft');
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();
		await expect(window.getByTitle(/Expand Sidebar/)).toBeVisible();

		await window.keyboard.press('Alt+Meta+ArrowLeft');
		await expect(window.locator('[data-tour="session-list"]')).toBeVisible();

		await window.getByTitle(/Collapse Right Panel/).click();
		await expectRightPanelCollapsed(window);
		await expect(window.getByTitle(/Expand Right Panel/)).toBeVisible();

		await window.getByTitle(/Show right panel/).click();
		await expect(window.getByTitle(/Collapse Right Panel/)).toBeVisible();
		await expect(window.locator('[data-tour="files-panel"]')).toBeVisible();
	});

	test('toggles shell chrome from Quick Actions without changing the active preview', async () => {
		await expect(window.locator('[data-tour="session-list"]')).toBeVisible();
		await expect(window.locator('[data-tour="files-panel"]')).toBeVisible();
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		let quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Toggle Sidebar');
		await quickActionsDialog.getByRole('button', { name: /Toggle Sidebar/ }).click();

		await expect(quickActionsDialog).toBeHidden();
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Toggle Sidebar');
		await quickActionsDialog.getByRole('button', { name: /Toggle Sidebar/ }).click();

		await expect(window.locator('[data-tour="session-list"]')).toBeVisible();

		quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Toggle Right Panel');
		await quickActionsDialog.getByRole('button', { name: /Toggle Right Panel/ }).click();

		await expect(quickActionsDialog).toBeHidden();
		await expectRightPanelCollapsed(window);
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('opens the agent filter from Quick Actions after the Left Bar is collapsed', async () => {
		await window.keyboard.press('Alt+Meta+ArrowLeft');
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Search: Agents');
		await quickActionsDialog.getByRole('button', { name: /Search: Agents/ }).click();

		const filterInput = window.getByPlaceholder('Filter agents...');
		await expect(quickActionsDialog).toBeHidden();
		await expect(window.locator('[data-tour="session-list"]')).toBeVisible();
		await expect(filterInput).toBeFocused();

		await filterInput.fill('Terminal');
		const sessionList = window.locator('[data-tour="session-list"]');
		await expect(sessionList.getByText('E2E Terminal')).toBeVisible();
		await expect(sessionList.getByText('E2E Workbench')).toBeHidden();

		await filterInput.press('Escape');
		await expect(filterInput).toBeHidden();
	});

	test('restores right-panel tabs from global shortcuts after collapsing the shell chrome', async () => {
		await helpers.openRightPanelTab(window, 'History');
		await expect(window.locator('[data-tour="history-panel"]')).toBeVisible();

		await window.keyboard.press('Alt+Meta+ArrowRight');
		await expectRightPanelCollapsed(window);

		await window.keyboard.press('Alt+Meta+ArrowRight');
		await expect(window.locator('[data-tour="history-panel"]')).toBeVisible();

		await window.keyboard.press('Meta+Shift+1');
		await expect(window.getByText('Auto Run Surface')).toBeVisible();
		await expect(window.getByRole('button', { name: /^Run$/ })).toBeVisible();

		await window.keyboard.press('Meta+Shift+F');
		await expect(window.locator('[data-tour="files-panel"]')).toBeVisible();
		await expect(window.locator('[data-tour="files-panel"]').getByTitle('README.md')).toBeVisible();

		await window.keyboard.press('Meta+Shift+H');
		await expect(window.locator('[data-tour="history-panel"]')).toBeVisible();
	});

	test('cycles shell agents with global shortcuts while preserving each workspace surface', async () => {
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		await window.keyboard.press('Meta+]');
		await expect(window.getByLabel('Terminal output')).toBeVisible();
		await expect(window.getByText('terminal seeded output is visible')).toBeVisible();

		await window.keyboard.press('Meta+[');
		await expect(window.getByText('File Preview Surface')).toBeVisible();
		await expect(window.getByText('Preview prose for app shell E2E coverage.')).toBeVisible();
	});

	test('focuses the Left Bar shortcut and opens the agent filter', async () => {
		await window.keyboard.press('Alt+Meta+ArrowLeft');
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();

		await window.keyboard.press('Meta+Shift+A');
		await expect(window.locator('[data-tour="session-list"]')).toBeVisible();

		await window.keyboard.press('Meta+f');
		await expect(window.getByPlaceholder('Filter agents...')).toBeVisible();
	});

	test('restores the Files panel shortcut after cycling agents with the right panel collapsed', async () => {
		await helpers.openRightPanelTab(window, 'History');
		await expect(window.locator('[data-tour="history-panel"]')).toBeVisible();

		await window.keyboard.press('Alt+Meta+ArrowRight');
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();

		await window.keyboard.press('Meta+]');
		await expect(window.getByLabel('Terminal output')).toBeVisible();
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();

		await window.keyboard.press('Meta+Shift+F');
		await expect(window.locator('[data-tour="files-panel"]')).toBeVisible();
		await expect(window.getByLabel('Terminal output')).toBeVisible();
	});

	test('restores both shell sidebars from shortcuts while preserving a terminal draft', async () => {
		const terminalInput = await openSeededTerminalAgent(window);
		await terminalInput.fill('draft survives shell restore sentinel');

		await window.keyboard.press('Alt+Meta+ArrowLeft');
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();
		await window.keyboard.press('Alt+Meta+ArrowRight');
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();

		await window.keyboard.press('Meta+Shift+A');
		await expect(window.locator('[data-tour="session-list"]')).toBeVisible();
		await window.keyboard.press('Meta+Shift+F');
		await expect(window.locator('[data-tour="files-panel"]')).toBeVisible();
		await expect(window.getByLabel('Terminal output')).toBeVisible();
		await expect(terminalInput).toHaveValue('draft survives shell restore sentinel');
	});

	test('restores the History panel shortcut after Quick Actions collapses the right panel', async () => {
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Toggle Right Panel');
		await quickActionsDialog.getByRole('button', { name: /Toggle Right Panel/ }).click();

		await expect(quickActionsDialog).toBeHidden();
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();

		await window.keyboard.press('Meta+Shift+H');
		await expect(window.locator('[data-tour="history-panel"]')).toBeVisible();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('keeps the terminal agent active when the Auto Run shortcut restores the right panel', async () => {
		const terminalInput = await openSeededTerminalAgent(window);
		await terminalInput.fill('terminal draft before autorun shortcut sentinel');

		await window.keyboard.press('Alt+Meta+ArrowRight');
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();

		await window.keyboard.press('Meta+Shift+1');
		await expectAutoRunPanelOpen(window);
		await expect(window.getByLabel('Terminal output')).toBeVisible();
		await expect(terminalInput).toHaveValue('terminal draft before autorun shortcut sentinel');
	});

	test('preserves a terminal draft while switching right-panel tabs from shortcuts', async () => {
		const terminalInput = await openSeededTerminalAgent(window);
		await terminalInput.fill('terminal draft across right panel shortcuts sentinel');

		await window.keyboard.press('Meta+Shift+F');
		await expect(window.locator('[data-tour="files-panel"]')).toBeVisible();
		await expect(terminalInput).toHaveValue('terminal draft across right panel shortcuts sentinel');

		await window.keyboard.press('Meta+Shift+H');
		await expect(window.locator('[data-tour="history-panel"]')).toBeVisible();
		await expect(terminalInput).toHaveValue('terminal draft across right panel shortcuts sentinel');

		await window.keyboard.press('Meta+Shift+1');
		await expectAutoRunPanelOpen(window);
		await expect(terminalInput).toHaveValue('terminal draft across right panel shortcuts sentinel');
	});

	test('opens agent search from Quick Actions without changing the active file preview', async () => {
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Search: Agents');
		await quickActionsDialog.getByRole('button', { name: /Search: Agents/ }).click();

		const filterInput = window.getByPlaceholder('Filter agents...');
		await expect(quickActionsDialog).toBeHidden();
		await expect(filterInput).toBeFocused();
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		await filterInput.press('Escape');
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('restores both shell sidebars from Quick Actions while preserving the active preview', async () => {
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		let quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Toggle Sidebar');
		await quickActionsDialog.getByRole('button', { name: /Toggle Sidebar/ }).click();
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();

		quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Toggle Right Panel');
		await quickActionsDialog.getByRole('button', { name: /Toggle Right Panel/ }).click();
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();

		quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Toggle Sidebar');
		await quickActionsDialog.getByRole('button', { name: /Toggle Sidebar/ }).click();
		await expect(window.locator('[data-tour="session-list"]')).toBeVisible();

		quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Toggle Right Panel');
		await quickActionsDialog.getByRole('button', { name: /Toggle Right Panel/ }).click();
		await expect(window.locator('[data-tour="files-panel"]')).toBeVisible();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('restores the selected right-panel tab from the panel collapse control', async () => {
		await helpers.openRightPanelTab(window, 'History');
		await expect(window.locator('[data-tour="history-panel"]')).toBeVisible();

		await window.getByTitle(/Collapse Right Panel/).click();
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();

		await window.getByTitle(/Show right panel/).click();
		await expect(window.locator('[data-tour="history-panel"]')).toBeVisible();
		await expect(window.locator('[data-tour="files-panel"]')).toBeHidden();
	});

	test('jumps to the terminal agent from Quick Actions while the Left Bar is collapsed', async () => {
		await window.keyboard.press('Alt+Meta+ArrowLeft');
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('E2E Terminal');
		await quickActionsDialog.getByRole('button', { name: /E2E Terminal/ }).click();

		await expect(quickActionsDialog).toBeHidden();
		await expect(window.getByLabel('Terminal output')).toBeVisible();
		await expect(window.getByText('terminal seeded output is visible')).toBeVisible();
	});

	test('opens file search from Quick Actions on the terminal agent without losing its draft', async () => {
		const terminalInput = await openSeededTerminalAgent(window);
		await terminalInput.fill('terminal draft before file search sentinel');

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Search: Files');
		await quickActionsDialog.getByRole('button', { name: /Search: Files/ }).click();

		await expect(quickActionsDialog).toBeHidden();
		await expect(window.locator('[data-tour="files-panel"]')).toBeVisible();
		await expect(window.getByPlaceholder('Filter files...')).toBeFocused();
		await expect(window.getByLabel('Terminal output')).toBeVisible();
		await expect(terminalInput).toHaveValue('terminal draft before file search sentinel');
	});

	test('opens shell search targets from Quick Actions', async () => {
		let quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Search: Agents');
		await quickActionsDialog.getByRole('button', { name: /Search: Agents/ }).click();
		await expect(window.getByPlaceholder('Filter agents...')).toBeVisible();
		await window.getByPlaceholder('Filter agents...').press('Escape');
		await window.getByText('Main', { exact: true }).click();

		quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Search: Files');
		await quickActionsDialog.getByRole('button', { name: /Search: Files/ }).click();
		await expect(window.locator('[data-tour="files-panel"]')).toBeVisible();
		await expect(window.getByPlaceholder('Filter files...')).toBeVisible();
		await window.getByPlaceholder('Filter files...').press('Escape');
		await window.getByText('Main', { exact: true }).click();

		quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Search: History');
		await quickActionsDialog.getByRole('button', { name: /Search: History/ }).click();
		await expect(window.locator('[data-tour="history-panel"]')).toBeVisible();
		await expect(window.getByPlaceholder('Filter history...')).toBeVisible();
	});

	test('closes Quick Actions with Escape after focusing the command input', async () => {
		const quickActionsDialog = await openQuickActions(window);
		const commandInput = quickActionsDialog.getByPlaceholder('Type a command or jump to agent...');

		await expect(commandInput).toBeFocused();
		await commandInput.fill('Settings');
		await expect(quickActionsDialog.getByRole('button', { name: /Settings/ })).toBeVisible();

		await commandInput.focus();
		await expect(commandInput).toBeFocused();
		await commandInput.press('Escape');
		if (await quickActionsDialog.isVisible({ timeout: 500 }).catch(() => false)) {
			await commandInput.evaluate((input) => {
				input.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'Escape',
						code: 'Escape',
						keyCode: 27,
						which: 27,
						bubbles: true,
						cancelable: true,
					})
				);
			});
		}
		await expect(quickActionsDialog).toBeHidden();
	});

	test('preserves the Auto Run panel while collapsing and restoring the Left Bar', async () => {
		await helpers.openRightPanelTab(window, 'Auto Run');
		await expect(window.getByText('Auto Run Surface')).toBeVisible();

		await window.keyboard.press('Alt+Meta+ArrowLeft');
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();
		await expect(window.getByText('Auto Run Surface')).toBeVisible();

		await window.keyboard.press('Meta+Shift+A');
		await expect(window.locator('[data-tour="session-list"]')).toBeVisible();
		await expect(window.getByText('Auto Run Surface')).toBeVisible();
	});

	test('recovers Left Bar agent filter results after an unmatched query', async () => {
		await window.keyboard.press('Meta+Shift+A');
		await window.keyboard.press('Meta+f');
		const filterInput = window.getByPlaceholder('Filter agents...');

		await filterInput.fill('missing-agent-filter-sentinel');
		await expect(
			window.locator('[data-tour="session-list"]').getByText('E2E Workbench')
		).toBeHidden();
		await expect(
			window.locator('[data-tour="session-list"]').getByText('E2E Terminal')
		).toBeHidden();

		await filterInput.fill('Terminal');
		await expect(
			window.locator('[data-tour="session-list"]').getByText('E2E Terminal')
		).toBeVisible();
		await expect(
			window.locator('[data-tour="session-list"]').getByText('E2E Workbench')
		).toBeHidden();

		await filterInput.press('Escape');
		await expect(filterInput).toBeHidden();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('keeps the terminal workspace active while opening Shortcuts Help from collapsed chrome', async () => {
		const terminalInput = await openSeededTerminalAgent(window);
		await terminalInput.fill('draft before shortcuts help sentinel');

		await window.keyboard.press('Alt+Meta+ArrowLeft');
		await window.keyboard.press('Alt+Meta+ArrowRight');
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('View Shortcuts');
		await quickActionsDialog.getByRole('button', { name: /View Shortcuts/ }).click();

		await expect(quickActionsDialog).toBeHidden();
		await expect(window.getByRole('dialog', { name: 'Keyboard Shortcuts' })).toBeVisible();
		await expect(window.getByLabel('Terminal output')).toBeVisible();
		await expect(terminalInput).toHaveValue('draft before shortcuts help sentinel');
	});

	test('restores the active file preview after opening and canceling Quick Actions from hidden chrome', async () => {
		await expect(window.getByText('File Preview Surface')).toBeVisible();
		await window.keyboard.press('Alt+Meta+ArrowLeft');
		await window.keyboard.press('Alt+Meta+ArrowRight');

		const quickActionsDialog = await openQuickActions(window);
		const commandInput = quickActionsDialog.getByPlaceholder('Type a command or jump to agent...');
		await commandInput.fill('Search: History');
		await expect(quickActionsDialog.getByRole('button', { name: /Search: History/ })).toBeVisible();

		await commandInput.press('Escape');
		if (await quickActionsDialog.isVisible({ timeout: 500 }).catch(() => false)) {
			await commandInput.evaluate((input) => {
				input.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 'Escape',
						code: 'Escape',
						keyCode: 27,
						which: 27,
						bubbles: true,
						cancelable: true,
					})
				);
			});
		}
		await expect(quickActionsDialog).toBeHidden();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();
	});

	test('restores Files panel focus after agent cycling from collapsed right chrome', async () => {
		await window.keyboard.press('Alt+Meta+ArrowRight');
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();

		await window.keyboard.press('Meta+]');
		await expect(window.getByLabel('Terminal output')).toBeVisible();
		await window.keyboard.press('Meta+[');
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		await window.keyboard.press('Meta+Shift+F');
		await expect(window.locator('[data-tour="files-panel"]')).toBeVisible();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('cancels filtered Quick Actions shell toggle without changing sidebars', async () => {
		await expect(window.locator('[data-tour="session-list"]')).toBeVisible();
		await expect(window.locator('[data-tour="files-panel"]')).toBeVisible();
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Toggle Right Panel');
		await expect(
			quickActionsDialog.getByRole('button', { name: /Toggle Right Panel/ })
		).toBeVisible();

		await closeQuickActions(window, quickActionsDialog);

		await expect(window.locator('[data-tour="session-list"]')).toBeVisible();
		await expect(window.locator('[data-tour="files-panel"]')).toBeVisible();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('restores the History panel shortcut after Quick Actions hides right chrome', async () => {
		const terminalInput = await openSeededTerminalAgent(window);
		await terminalInput.fill('terminal draft before history restore sentinel');

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Toggle Right Panel');
		await quickActionsDialog.getByRole('button', { name: /Toggle Right Panel/ }).click();
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();

		await window.keyboard.press('Meta+Shift+H');

		await expect(window.locator('[data-tour="history-panel"]')).toBeVisible();
		await expect(window.getByLabel('Terminal output')).toBeVisible();
		await expect(terminalInput).toHaveValue('terminal draft before history restore sentinel');
	});

	test('keeps terminal drafts while cycling agents from collapsed Left Bar', async () => {
		const terminalInput = await openSeededTerminalAgent(window);
		await terminalInput.fill('terminal draft across collapsed agent cycle sentinel');

		await window.keyboard.press('Alt+Meta+ArrowLeft');
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();

		await window.keyboard.press('Meta+[');
		await expect(window.getByText('File Preview Surface')).toBeVisible();
		await window.keyboard.press('Meta+]');

		await expect(window.getByLabel('Terminal output')).toBeVisible();
		await expect(terminalInput).toHaveValue('terminal draft across collapsed agent cycle sentinel');
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();
	});

	test('restores Left Bar search after Quick Actions collapses the sidebar', async () => {
		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Toggle Sidebar');
		await quickActionsDialog.getByRole('button', { name: /Toggle Sidebar/ }).click();
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();

		await window.keyboard.press('Meta+Shift+A');
		await expect(window.locator('[data-tour="session-list"]')).toBeVisible();
		await window.keyboard.press('Meta+f');

		const filterInput = window.getByPlaceholder('Filter agents...');
		await expect(filterInput).toBeFocused();
		await filterInput.fill('Terminal');
		await expect(
			window.locator('[data-tour="session-list"]').getByText('E2E Terminal')
		).toBeVisible();
		await expect(
			window.locator('[data-tour="session-list"]').getByText('E2E Workbench')
		).toBeHidden();
	});

	test('keeps History selected while canceling the Left Bar filter', async () => {
		await helpers.openRightPanelTab(window, 'History');
		await expect(window.locator('[data-tour="history-panel"]')).toBeVisible();

		await window.keyboard.press('Meta+Shift+A');
		await window.keyboard.press('Meta+f');
		const filterInput = window.getByPlaceholder('Filter agents...');
		await filterInput.fill('Terminal');
		await expect(
			window.locator('[data-tour="session-list"]').getByText('E2E Terminal')
		).toBeVisible();

		await filterInput.press('Escape');

		await expect(filterInput).toBeHidden();
		await expect(window.locator('[data-tour="history-panel"]')).toBeVisible();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('restores Files panel from shortcut after Quick Actions opens Auto Run', async () => {
		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Go to Auto Run Tab');
		await quickActionsDialog.getByRole('button', { name: /Go to Auto Run Tab/ }).click();
		await expect(window.getByText('Auto Run Surface')).toBeVisible();

		await window.keyboard.press('Meta+Shift+F');

		await expect(window.locator('[data-tour="files-panel"]')).toBeVisible();
		await expect(window.locator('[data-tour="autorun-panel"]')).toBeHidden();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('closes Shortcuts Help over hidden chrome without restoring sidebars', async () => {
		const terminalInput = await openSeededTerminalAgent(window);
		await terminalInput.fill('terminal draft under shortcuts help sentinel');

		await window.keyboard.press('Alt+Meta+ArrowLeft');
		await window.keyboard.press('Alt+Meta+ArrowRight');
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('View Shortcuts');
		await quickActionsDialog.getByRole('button', { name: /View Shortcuts/ }).click();

		const shortcutsDialog = window.getByRole('dialog', { name: 'Keyboard Shortcuts' });
		await expect(shortcutsDialog).toBeVisible();
		await window.keyboard.press('Escape');

		await expect(shortcutsDialog).toBeHidden();
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();
		await expect(window.getByLabel('Terminal output')).toBeVisible();
		await expect(terminalInput).toHaveValue('terminal draft under shortcuts help sentinel');
	});

	test('restores Auto Run selection from the right-panel collapse control', async () => {
		await helpers.openRightPanelTab(window, 'Auto Run');
		await expect(window.getByText('Auto Run Surface')).toBeVisible();

		await window.getByTitle(/Collapse Right Panel/).click();
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();

		await window.getByTitle(/Show right panel/).click();

		await expect(window.getByText('Auto Run Surface')).toBeVisible();
		await expect(window.locator('[data-tour="files-panel"]')).toBeHidden();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('restores History from Quick Actions after both shell sidebars are hidden', async () => {
		await window.keyboard.press('Alt+Meta+ArrowLeft');
		await window.keyboard.press('Alt+Meta+ArrowRight');
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Go to History Tab');
		await quickActionsDialog.getByRole('button', { name: /Go to History Tab/ }).click();

		await expect(quickActionsDialog).toBeHidden();
		await expect(window.locator('[data-tour="history-panel"]')).toBeVisible();
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('restores Files from Quick Actions after hidden right chrome while preserving terminal draft', async () => {
		const terminalInput = await openSeededTerminalAgent(window);
		await terminalInput.fill('terminal draft before files restore sentinel');
		await window.keyboard.press('Alt+Meta+ArrowRight');
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Go to Files Tab');
		await quickActionsDialog.getByRole('button', { name: /Go to Files Tab/ }).click();

		await expect(quickActionsDialog).toBeHidden();
		await expect(window.locator('[data-tour="files-panel"]')).toBeVisible();
		await expect(window.getByLabel('Terminal output')).toBeVisible();
		await expect(terminalInput).toHaveValue('terminal draft before files restore sentinel');
	});

	test('keeps Auto Run selected while canceling a no-match Left Bar filter', async () => {
		await helpers.openRightPanelTab(window, 'Auto Run');
		await expect(window.getByText('Auto Run Surface')).toBeVisible();

		await window.keyboard.press('Meta+Shift+A');
		await window.keyboard.press('Meta+f');
		const filterInput = window.getByPlaceholder('Filter agents...');
		await filterInput.fill('missing-auto-run-agent-filter-sentinel');
		await expect(
			window.locator('[data-tour="session-list"]').getByText('E2E Workbench')
		).toBeHidden();

		await filterInput.press('Escape');

		await expect(filterInput).toBeHidden();
		await expect(window.getByText('Auto Run Surface')).toBeVisible();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('selects the terminal agent after recovering a no-match Left Bar filter', async () => {
		await window.keyboard.press('Meta+Shift+A');
		await window.keyboard.press('Meta+f');
		const filterInput = window.getByPlaceholder('Filter agents...');
		await filterInput.fill('missing-terminal-agent-filter-sentinel');
		await expect(
			window.locator('[data-tour="session-list"]').getByText('E2E Terminal')
		).toBeHidden();

		await filterInput.fill('Terminal');
		await window.locator('[data-tour="session-list"]').getByText('E2E Terminal').click();

		await expect(filterInput).toBeVisible();
		await expect(filterInput).toHaveValue('Terminal');
		await expect(window.getByLabel('Terminal output')).toBeVisible();
		await expect(window.getByText('terminal seeded output is visible')).toBeVisible();
	});

	test('restores Files shortcut after closing Shortcuts Help over collapsed right chrome', async () => {
		await window.keyboard.press('Alt+Meta+ArrowRight');
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('View Shortcuts');
		await quickActionsDialog.getByRole('button', { name: /View Shortcuts/ }).click();

		const shortcutsDialog = window.getByRole('dialog', { name: 'Keyboard Shortcuts' });
		await expect(shortcutsDialog).toBeVisible();
		await window.keyboard.press('Escape');
		await expect(shortcutsDialog).toBeHidden();
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();

		await window.keyboard.press('Meta+Shift+F');

		await expect(window.locator('[data-tour="files-panel"]')).toBeVisible();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('restores the active workbench after canceling Quick Actions from a filtered terminal jump', async () => {
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('E2E Terminal');
		await expect(quickActionsDialog.getByRole('button', { name: /E2E Terminal/ })).toBeVisible();

		await closeQuickActions(window, quickActionsDialog);

		await expect(quickActionsDialog).toBeHidden();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
		await expect(window.getByLabel('Terminal output')).toBeHidden();
	});

	test('preserves History while restoring the Left Bar from its expand control', async () => {
		await helpers.openRightPanelTab(window, 'History');
		await expect(window.locator('[data-tour="history-panel"]')).toBeVisible();

		await window.keyboard.press('Alt+Meta+ArrowLeft');
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();
		await window.getByTitle(/Expand Sidebar/).click();

		await expect(window.locator('[data-tour="session-list"]')).toBeVisible();
		await expect(window.locator('[data-tour="history-panel"]')).toBeVisible();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('preserves Auto Run while Quick Actions toggles the Left Bar closed and open', async () => {
		await helpers.openRightPanelTab(window, 'Auto Run');
		await expect(window.getByText('Auto Run Surface')).toBeVisible();

		let quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Toggle Sidebar');
		await quickActionsDialog.getByRole('button', { name: /Toggle Sidebar/ }).click();
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();
		await expect(window.getByText('Auto Run Surface')).toBeVisible();

		quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Toggle Sidebar');
		await quickActionsDialog.getByRole('button', { name: /Toggle Sidebar/ }).click();

		await expect(window.locator('[data-tour="session-list"]')).toBeVisible();
		await expect(window.getByText('Auto Run Surface')).toBeVisible();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('keeps Files selected while canceling Quick Actions after a right-panel toggle query', async () => {
		await expect(window.locator('[data-tour="files-panel"]')).toBeVisible();

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Toggle Right Panel');
		await expect(
			quickActionsDialog.getByRole('button', { name: /Toggle Right Panel/ })
		).toBeVisible();

		await closeQuickActions(window, quickActionsDialog);

		await expect(window.locator('[data-tour="files-panel"]')).toBeVisible();
		await expect(window.locator('[data-tour="session-list"]')).toBeVisible();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('keeps History selected while canceling Quick Actions after a sidebar toggle query', async () => {
		await helpers.openRightPanelTab(window, 'History');
		await expect(window.locator('[data-tour="history-panel"]')).toBeVisible();

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Toggle Sidebar');
		await expect(quickActionsDialog.getByRole('button', { name: /Toggle Sidebar/ })).toBeVisible();

		await closeQuickActions(window, quickActionsDialog);

		await expect(window.locator('[data-tour="history-panel"]')).toBeVisible();
		await expect(window.locator('[data-tour="session-list"]')).toBeVisible();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('keeps Auto Run selected while canceling Quick Actions after an agent-search query', async () => {
		await helpers.openRightPanelTab(window, 'Auto Run');
		await expect(window.getByText('Auto Run Surface')).toBeVisible();

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Search: Agents');
		await expect(quickActionsDialog.getByRole('button', { name: /Search: Agents/ })).toBeVisible();

		await closeQuickActions(window, quickActionsDialog);

		await expect(window.getByPlaceholder('Filter agents...')).toBeHidden();
		await expect(window.getByText('Auto Run Surface')).toBeVisible();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('restores Files from shortcut after both sidebars are hidden and Quick Actions is canceled', async () => {
		await window.keyboard.press('Alt+Meta+ArrowLeft');
		await window.keyboard.press('Alt+Meta+ArrowRight');
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('E2E Terminal');
		await expect(quickActionsDialog.getByRole('button', { name: /E2E Terminal/ })).toBeVisible();
		await closeQuickActions(window, quickActionsDialog);

		await window.keyboard.press('Meta+Shift+F');

		await expect(window.locator('[data-tour="files-panel"]')).toBeVisible();
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('restores History from shortcut after an unmatched agent filter closes over hidden right chrome', async () => {
		await window.keyboard.press('Alt+Meta+ArrowRight');
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();

		await window.keyboard.press('Meta+Shift+A');
		await window.keyboard.press('Meta+f');
		const filterInput = window.getByPlaceholder('Filter agents...');
		await filterInput.fill('missing-history-shortcut-agent-sentinel');
		await expect(
			window.locator('[data-tour="session-list"]').getByText('E2E Terminal')
		).toBeHidden();

		await filterInput.press('Escape');
		await expect(filterInput).toBeHidden();

		await window.keyboard.press('Meta+Shift+H');

		await expect(window.locator('[data-tour="history-panel"]')).toBeVisible();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('preserves terminal draft when Files shortcut restores hidden right chrome', async () => {
		const terminalInput = await openSeededTerminalAgent(window);
		await terminalInput.fill('terminal draft before files shortcut restore sentinel');
		await window.keyboard.press('Alt+Meta+ArrowRight');
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();

		await window.keyboard.press('Meta+Shift+F');

		await expect(window.locator('[data-tour="files-panel"]')).toBeVisible();
		await expect(window.getByLabel('Terminal output')).toBeVisible();
		await expect(terminalInput).toHaveValue(
			'terminal draft before files shortcut restore sentinel'
		);
	});

	test('preserves terminal draft when History shortcut restores hidden right chrome', async () => {
		const terminalInput = await openSeededTerminalAgent(window);
		await terminalInput.fill('terminal draft before history shortcut restore sentinel');
		await window.keyboard.press('Alt+Meta+ArrowRight');
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();

		await window.keyboard.press('Meta+Shift+H');

		await expect(window.locator('[data-tour="history-panel"]')).toBeVisible();
		await expect(window.getByLabel('Terminal output')).toBeVisible();
		await expect(terminalInput).toHaveValue(
			'terminal draft before history shortcut restore sentinel'
		);
	});

	test('preserves terminal draft when Auto Run shortcut restores hidden right chrome', async () => {
		const terminalInput = await openSeededTerminalAgent(window);
		await terminalInput.fill('terminal draft before autorun hidden restore sentinel');
		await window.keyboard.press('Alt+Meta+ArrowRight');
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();

		await window.keyboard.press('Meta+Shift+1');

		await expectAutoRunPanelOpen(window);
		await expect(window.getByLabel('Terminal output')).toBeVisible();
		await expect(terminalInput).toHaveValue(
			'terminal draft before autorun hidden restore sentinel'
		);
	});

	test('keeps terminal draft while the Left Bar is restored from the agent shortcut', async () => {
		const terminalInput = await openSeededTerminalAgent(window);
		await terminalInput.fill('terminal draft before left bar agent shortcut sentinel');
		await window.keyboard.press('Alt+Meta+ArrowLeft');
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();

		await window.keyboard.press('Meta+Shift+A');

		await expect(window.locator('[data-tour="session-list"]')).toBeVisible();
		await expect(window.getByLabel('Terminal output')).toBeVisible();
		await expect(terminalInput).toHaveValue(
			'terminal draft before left bar agent shortcut sentinel'
		);
	});

	test('keeps file preview active while cycling agents after hiding the Left Bar', async () => {
		await expect(window.getByText('File Preview Surface')).toBeVisible();
		await window.keyboard.press('Alt+Meta+ArrowLeft');
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();

		await window.keyboard.press('Meta+]');
		await expect(window.getByLabel('Terminal output')).toBeVisible();

		await window.keyboard.press('Meta+[');

		await expect(window.getByText('File Preview Surface')).toBeVisible();
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();
	});

	test('keeps History recoverable after cycling agents with right chrome hidden', async () => {
		await helpers.openRightPanelTab(window, 'History');
		await expect(window.locator('[data-tour="history-panel"]')).toBeVisible();
		await window.keyboard.press('Alt+Meta+ArrowRight');
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();

		await window.keyboard.press('Meta+]');
		await expect(window.getByLabel('Terminal output')).toBeVisible();
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();

		await window.keyboard.press('Meta+[');
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		await window.keyboard.press('Meta+Shift+H');

		await expect(window.locator('[data-tour="history-panel"]')).toBeVisible();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('opens agent search over History and returns to the selected panel on Escape', async () => {
		await helpers.openRightPanelTab(window, 'History');
		await expect(window.locator('[data-tour="history-panel"]')).toBeVisible();

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Search: Agents');
		await quickActionsDialog.getByRole('button', { name: /Search: Agents/ }).click();

		const filterInput = window.getByPlaceholder('Filter agents...');
		await expect(filterInput).toBeFocused();
		await filterInput.fill('missing-history-agent-search-sentinel');
		await expect(
			window.locator('[data-tour="session-list"]').getByText('E2E Workbench')
		).toBeHidden();

		await filterInput.press('Escape');

		await expect(filterInput).toBeHidden();
		await expect(window.locator('[data-tour="history-panel"]')).toBeVisible();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('opens agent search over Auto Run and returns to the selected panel on Escape', async () => {
		await helpers.openRightPanelTab(window, 'Auto Run');
		await expect(window.getByText('Auto Run Surface')).toBeVisible();

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Search: Agents');
		await quickActionsDialog.getByRole('button', { name: /Search: Agents/ }).click();

		const filterInput = window.getByPlaceholder('Filter agents...');
		await expect(filterInput).toBeFocused();
		await filterInput.fill('Terminal');
		await expect(
			window.locator('[data-tour="session-list"]').getByText('E2E Terminal')
		).toBeVisible();

		await filterInput.press('Escape');

		await expect(filterInput).toBeHidden();
		await expect(window.getByText('Auto Run Surface')).toBeVisible();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('jumps to the terminal agent from Auto Run without changing the selected right-panel tab', async () => {
		await helpers.openRightPanelTab(window, 'Auto Run');
		await expect(window.getByText('Auto Run Surface')).toBeVisible();

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('E2E Terminal');
		await quickActionsDialog.getByRole('button', { name: /E2E Terminal/ }).click();

		await expect(quickActionsDialog).toBeHidden();
		await expect(window.getByLabel('Terminal output')).toBeVisible();
		await expectAutoRunPanelOpen(window);
	});

	test('returns to the workbench from terminal cycling while History stays selected', async () => {
		await helpers.openRightPanelTab(window, 'History');
		await expect(window.locator('[data-tour="history-panel"]')).toBeVisible();

		const terminalInput = await openSeededTerminalAgent(window);
		await terminalInput.fill('terminal draft before return cycle sentinel');
		await expect(window.locator('[data-tour="history-panel"]')).toBeVisible();

		await window.keyboard.press('Meta+[');

		await expect(window.getByText('File Preview Surface')).toBeVisible();
		await expect(window.locator('[data-tour="history-panel"]')).toBeVisible();
	});

	test('restores the workbench from terminal cycling while the Left Bar remains hidden', async () => {
		await openSeededTerminalAgent(window);
		await window.keyboard.press('Alt+Meta+ArrowLeft');
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();
		await expect(window.getByLabel('Terminal output')).toBeVisible();

		await window.keyboard.press('Meta+[');

		await expect(window.getByText('File Preview Surface')).toBeVisible();
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();
		await expect(window.locator('[data-tour="files-panel"]')).toBeVisible();
	});

	test('keeps Shortcuts Help scoped over a Left Bar-hidden shell after Escape', async () => {
		await window.keyboard.press('Alt+Meta+ArrowLeft');
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('View Shortcuts');
		await quickActionsDialog.getByRole('button', { name: /View Shortcuts/ }).click();

		const shortcutsDialog = window.getByRole('dialog', { name: 'Keyboard Shortcuts' });
		await expect(shortcutsDialog).toBeVisible();
		await window.keyboard.press('Escape');

		await expect(shortcutsDialog).toBeHidden();
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();
		await expect(window.locator('[data-tour="files-panel"]')).toBeVisible();
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

	test('shows the History no-match state for an unmatched search', async () => {
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');
		await expect(historyPanel.getByText('Manual note captured for project review')).toBeVisible();

		await historyPanel.locator('[tabindex="0"]').focus();
		await window.keyboard.press('Control+f');
		const historyFilter = historyPanel.getByPlaceholder('Filter history...');
		await historyFilter.fill('missing-history-sentinel');

		await expect(historyPanel.getByText('0 results')).toBeVisible();
		await expect(
			historyPanel.getByText('No entries match "missing-history-sentinel"')
		).toBeVisible();

		await historyFilter.press('Escape');
		await expect(historyPanel.getByText('Manual note captured for project review')).toBeVisible();
	});

	test('shows the empty History state when no entries exist', async () => {
		await clearHistoryEntries(window, seededWorkbench.sessions[0].id);
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');

		await expect(
			historyPanel.getByText('No history yet. Run batch tasks or use /history to add entries.')
		).toBeVisible();
		await expect(historyPanel.getByTitle('History panel help')).toBeVisible();
	});

	test('recovers from an empty History lookback filter by showing all time', async () => {
		const oldBaseTime = Date.now() - 4 * 24 * 60 * 60 * 1000;
		await seedHistoryEntries(
			window,
			seededWorkbench.sessions[0].cwd,
			seededWorkbench.sessions[0].id,
			oldBaseTime
		);
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');
		const activityGraph = historyPanel.locator('[title*="All time"]').first();

		await activityGraph.click({ button: 'right' });
		await window.getByRole('button', { name: '24 hours' }).click();

		await expect(historyPanel.getByText('No entries in the last')).toBeVisible();
		await expect(
			historyPanel.getByRole('button', { name: 'Show all time (3 entries)' })
		).toBeVisible();

		await historyPanel.getByRole('button', { name: 'Show all time (3 entries)' }).click();
		await expect(historyPanel.getByText('Manual note captured for project review')).toBeVisible();
		await expect(historyPanel.getByText('Completed Auto Run setup checklist')).toBeVisible();
	});

	test('opens a filtered History result from keyboard search navigation', async () => {
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');

		await historyPanel.locator('[tabindex="0"]').focus();
		await window.keyboard.press('Control+f');
		const historyFilter = historyPanel.getByPlaceholder('Filter history...');
		await historyFilter.fill('Auto Run');

		await historyFilter.press('ArrowDown');
		await window.keyboard.press('Enter');

		await expect(window.getByText(/Detailed Auto Run transcript/)).toBeVisible();
		await expect(window.getByRole('button', { name: 'Prev' })).toBeVisible();
		await expect(window.getByRole('button', { name: 'Next' })).toBeVisible();
	});

	test('navigates History detail entries with keyboard arrows', async () => {
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');
		await historyPanel.getByText('Completed Auto Run setup checklist').first().click();

		await expect(window.getByText(/Detailed Auto Run transcript/)).toBeVisible();
		await window.keyboard.press('ArrowLeft');
		await expect(window.getByText(/Manual detail includes NOTES.md/)).toBeVisible();

		await window.keyboard.press('ArrowRight');
		await expect(window.getByText(/Detailed Auto Run transcript/)).toBeVisible();
	});

	test('shows History detail session controls for resumable entries', async () => {
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');
		await historyPanel.getByText('Manual note captured for project review').first().click();

		await expect(window.getByTitle('Copy session ID: codex-history-user')).toBeVisible();
		await expect(window.getByTitle('Resume session codex-history-user')).toBeVisible();
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

	test('closes History detail from Escape and returns to the list', async () => {
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');
		await historyPanel.getByText('Completed Auto Run setup checklist').first().click();

		await expect(window.getByText(/Detailed Auto Run transcript/)).toBeVisible();
		await window.keyboard.press('Escape');

		await expect(window.getByText(/Detailed Auto Run transcript/)).toBeHidden();
		await expect(historyPanel.getByText('Completed Auto Run setup checklist')).toBeVisible();
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

	test('cancels History deletion with Escape without removing the entry', async () => {
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');
		await historyPanel.getByText('Failed generated docs sync').first().click();

		await expect(window.getByText(/Detailed failure transcript/)).toBeVisible();
		await window.getByTitle('Delete this history entry').click();
		const deleteConfirm = window
			.locator('.fixed')
			.filter({ hasText: 'Delete History Entry' })
			.last();
		await expect(deleteConfirm.getByText('Delete History Entry')).toBeVisible();

		await window.keyboard.press('Escape');
		await expect(deleteConfirm).toBeHidden();
		await expect(historyPanel.getByText('Failed generated docs sync')).toBeVisible();
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

	test('closes the History panel guide with Escape', async () => {
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');

		await historyPanel.getByTitle('History panel help').click();
		const guideDialog = window.getByRole('dialog', { name: 'History Panel Guide' });
		await expect(guideDialog).toBeVisible();

		await window.keyboard.press('Escape');
		await expect(guideDialog).toBeHidden();
		await expect(historyPanel.getByText('Completed Auto Run setup checklist')).toBeVisible();
	});

	test('shows History loading state until delayed entries resolve', async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('history:getAll');
			ipcMain.handle('history:getAll', async (_event, projectPath: string, sessionId: string) => {
				await new Promise((resolve) => setTimeout(resolve, 750));
				return [
					{
						id: 'history-delayed-load',
						type: 'USER',
						timestamp: Date.now(),
						summary: 'Delayed history loaded from IPC',
						fullResponse: 'Delayed history load detail.',
						projectPath,
						sessionId,
						sessionName: 'E2E Workbench',
						agentSessionId: 'codex-history-delayed',
					},
				];
			});
		});

		await helpers.openRightPanelTab(window, 'Files');
		await helpers.openRightPanelTab(window, 'History');
		const historyPanel = window.locator('[data-tour="history-panel"]');
		await expect(historyPanel.getByText('Loading history...')).toBeVisible();
		await expect(historyPanel.getByText('Delayed history loaded from IPC')).toBeVisible();
		await expect(historyPanel.getByText('Loading history...')).toBeHidden();
	});

	test('reloads History entries after switching away and back', async () => {
		await helpers.openRightPanelTab(window, 'History');
		await expect(window.getByText('Manual note captured for project review')).toBeVisible();

		await helpers.openRightPanelTab(window, 'Files');
		await window.evaluate(
			async ({ projectPath, sessionId }) => {
				await window.maestro.history.add({
					id: 'history-remount-refresh',
					type: 'USER',
					timestamp: Date.now(),
					summary: 'History remount refresh note',
					fullResponse: 'History remount detail is loaded after switching tabs.',
					projectPath,
					sessionId,
					sessionName: 'E2E Workbench',
					agentSessionId: 'codex-history-remount',
				});
			},
			{
				projectPath: seededWorkbench.sessions[0].cwd,
				sessionId: seededWorkbench.sessions[0].id,
			}
		);

		await helpers.openRightPanelTab(window, 'History');
		await expect(window.getByText('History remount refresh note')).toBeVisible();
	});

	test('refreshes visible History panel after pull request creation', async () => {
		const branchName = 'feat-e2e-pr-history';
		await stubPullRequestCreation(
			electronApp,
			{ installed: true, authenticated: true },
			{ success: true, prUrl: 'https://github.com/RunMaestro/Maestro/pull/73' }
		);
		await createLocalWorktreeSession(window, seededWorkbench, branchName);
		await window
			.locator('[data-tour="session-list"]')
			.getByText(branchName, { exact: true })
			.click();
		await helpers.openRightPanelTab(window, 'History');

		const historyPanel = window.locator('[data-tour="history-panel"]');
		await expect(historyPanel.getByText('No history yet')).toBeVisible();

		const contextMenu = await openSessionContextMenu(window, branchName, 'Create Pull Request');
		await contextMenu.getByRole('button', { name: 'Create Pull Request', exact: true }).click();

		const prModal = modalRootByHeading(window, 'Create Pull Request');
		await expect(prModal.getByRole('button', { name: 'Create PR' })).toBeEnabled({
			timeout: 5000,
		});
		await prModal.getByPlaceholder('PR title...').fill('E2E History Refresh PR');
		await prModal.getByRole('button', { name: 'Create PR' }).click();
		await expect(prModal).toBeHidden({ timeout: 5000 });

		await expect(historyPanel.getByText('Created PR: E2E History Refresh PR')).toBeVisible();
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

	test('filters Playbook Exchange to release playbooks and previews release docs', async () => {
		await stubMarketplaceForPlaybookExchange(electronApp);

		await helpers.openRightPanelTab(window, 'Auto Run');
		await window.getByTitle('Browse PlayBooks - discover and share community playbooks').click();
		const marketplaceDialog = window.getByRole('dialog').first();
		await expect(marketplaceDialog.getByText('Playbook Exchange')).toBeVisible();

		await marketplaceDialog.getByRole('button', { name: 'Release(1)' }).click();
		await expect(
			marketplaceDialog.getByRole('button', { name: /Release Checklist/ })
		).toBeVisible();
		await expect(marketplaceDialog.getByText('Issue Triage')).toBeHidden();

		await marketplaceDialog.getByRole('button', { name: /Release Checklist/ }).click();
		await expect(
			marketplaceDialog.getByRole('heading', { name: 'Release Checklist', exact: true })
		).toBeVisible();
		await expect(
			marketplaceDialog.getByRole('heading', { name: 'Release checklist', exact: true })
		).toBeVisible();
		await expect(marketplaceDialog.getByText('Loop: No')).toBeVisible();

		await marketplaceDialog.getByRole('button', { name: /release-plan\.md/ }).click();
		await expect(marketplaceDialog.getByText('Release plan body.')).toBeVisible();
		await marketplaceDialog.getByTitle('Back to list (Esc)').click();
		await expect(marketplaceDialog.getByPlaceholder('Search playbooks...')).toBeVisible();
	});

	test('shows Playbook Exchange help, refreshes cached data, and handles empty search', async () => {
		await stubMarketplaceForPlaybookExchange(electronApp);

		await helpers.openRightPanelTab(window, 'Auto Run');
		await window.getByTitle('Browse PlayBooks - discover and share community playbooks').click();
		const marketplaceDialog = window.getByRole('dialog').first();
		await expect(marketplaceDialog.getByText(/Cached 2m ago|Cached/)).toBeVisible();

		await marketplaceDialog.getByLabel('Help').click();
		await expect(marketplaceDialog.getByText('About the Playbook Exchange')).toBeVisible();
		await expect(marketplaceDialog.getByText('Submit Your Playbook')).toBeVisible();
		await marketplaceDialog.getByRole('button', { name: 'Close', exact: true }).click();
		await expect(marketplaceDialog.getByText('Submit Your Playbook')).toBeHidden();

		await marketplaceDialog.getByLabel('Refresh marketplace').click();
		await expect(marketplaceDialog.getByText('Live')).toBeVisible();

		await marketplaceDialog.getByPlaceholder('Search playbooks...').fill('not-a-playbook');
		await expect(marketplaceDialog.getByText('No results found')).toBeVisible();
		await expect(
			marketplaceDialog.getByText('Try adjusting your search or browse a different category')
		).toBeVisible();
	});

	test('imports a release marketplace playbook with the generated target folder', async () => {
		await stubMarketplaceForPlaybookExchange(electronApp);

		await helpers.openRightPanelTab(window, 'Auto Run');
		await window.getByTitle('Browse PlayBooks - discover and share community playbooks').click();
		const marketplaceDialog = window.getByRole('dialog').first();
		await expect(marketplaceDialog.getByText('Playbook Exchange')).toBeVisible();
		await marketplaceDialog.getByRole('button', { name: /Release Checklist/ }).click();
		await expect(
			marketplaceDialog.getByRole('heading', { name: 'Release checklist', exact: true })
		).toBeVisible();

		await marketplaceDialog.getByRole('button', { name: 'Import Playbook' }).click();
		await expect(marketplaceDialog).toBeHidden();
		await expect(window.getByText('Playbook Imported')).toBeVisible();

		await expect
			.poll(async () => getStubbedMarketplaceImportRequest(electronApp))
			.toMatchObject({
				playbookId: 'release-checklist',
				targetFolderName: 'release/release-checklist',
				autoRunFolderPath: seededWorkbench.sessions[0].autoRunFolderPath,
				sessionId: seededWorkbench.sessions[0].id,
			});
	});

	test('switches Playbook Exchange preview documents from the dropdown', async () => {
		await stubMarketplaceForPlaybookExchange(electronApp);

		await helpers.openRightPanelTab(window, 'Auto Run');
		await window.getByTitle('Browse PlayBooks - discover and share community playbooks').click();
		const marketplaceDialog = window.getByRole('dialog').first();
		await marketplaceDialog.getByRole('button', { name: /Issue Triage/ }).click();
		await expect(marketplaceDialog.getByText('README for issue triage')).toBeVisible();

		await marketplaceDialog.getByRole('button', { name: 'README.md' }).click();
		await marketplaceDialog
			.getByRole('button', { name: 'response-checklist.md', exact: true })
			.click();
		await expect(marketplaceDialog.getByText('Response checklist body.')).toBeVisible();

		await marketplaceDialog
			.getByRole('button', { name: 'response-checklist.md', exact: true })
			.click();
		await marketplaceDialog.getByRole('button', { name: 'README.md' }).click();
		await expect(marketplaceDialog.getByText('README for issue triage')).toBeVisible();
	});

	test('navigates Playbook Exchange preview documents from the keyboard', async () => {
		await stubMarketplaceForPlaybookExchange(electronApp);

		await helpers.openRightPanelTab(window, 'Auto Run');
		await window.getByTitle('Browse PlayBooks - discover and share community playbooks').click();
		const marketplaceDialog = window.getByRole('dialog').first();
		await marketplaceDialog.getByRole('button', { name: /Issue Triage/ }).click();
		await expect(marketplaceDialog.getByText('README for issue triage')).toBeVisible();

		await window.keyboard.press('Meta+Shift+]');
		await expect(marketplaceDialog.getByText('Triage plan body for E2E.')).toBeVisible();
		await window.keyboard.press('Meta+Shift+]');
		await expect(marketplaceDialog.getByText('Response checklist body.')).toBeVisible();
		await window.keyboard.press('Meta+Shift+]');
		await expect(marketplaceDialog.getByText('README for issue triage')).toBeVisible();
	});

	test('validates and imports a marketplace playbook with a custom target folder', async () => {
		await stubMarketplaceForPlaybookExchange(electronApp);

		await helpers.openRightPanelTab(window, 'Auto Run');
		await window.getByTitle('Browse PlayBooks - discover and share community playbooks').click();
		const marketplaceDialog = window.getByRole('dialog').first();
		await marketplaceDialog.getByRole('button', { name: /Issue Triage/ }).click();
		const targetFolderInput = marketplaceDialog.getByLabel(
			'Import to folder (relative to Auto Run folder or absolute path)'
		);
		await expect(targetFolderInput).toHaveValue('security/issue-triage');

		await targetFolderInput.fill('');
		await expect(marketplaceDialog.getByRole('button', { name: 'Import Playbook' })).toBeDisabled();
		await targetFolderInput.fill('custom/security-review');
		await marketplaceDialog.getByRole('button', { name: 'Import Playbook' }).click();

		await expect
			.poll(async () => getStubbedMarketplaceImportRequest(electronApp))
			.toMatchObject({
				playbookId: 'issue-triage',
				targetFolderName: 'custom/security-review',
				autoRunFolderPath: seededWorkbench.sessions[0].autoRunFolderPath,
				sessionId: seededWorkbench.sessions[0].id,
			});
	});

	test('routes the Playbook Exchange submit link through shell IPC', async () => {
		await stubMarketplaceForPlaybookExchange(electronApp);
		await stubOpenExternal(electronApp);

		await helpers.openRightPanelTab(window, 'Auto Run');
		await window.getByTitle('Browse PlayBooks - discover and share community playbooks').click();
		const marketplaceDialog = window.getByRole('dialog').first();
		await marketplaceDialog.getByRole('button', { name: 'Submit Playbook via GitHub' }).click();

		await expect
			.poll(() => getStubbedOpenExternalUrl(electronApp))
			.toBe('https://github.com/RunMaestro/Maestro-Playbooks');
	});

	test('sets a marketplace import target from the browse folder control', async () => {
		await stubMarketplaceForPlaybookExchange(electronApp);
		const selectedImportFolder = '/tmp/maestro-e2e-marketplace-import';
		await electronApp.evaluate(({ ipcMain }, folderPath: string) => {
			ipcMain.removeHandler('dialog:selectFolder');
			ipcMain.handle('dialog:selectFolder', async () => folderPath);
		}, selectedImportFolder);

		await helpers.openRightPanelTab(window, 'Auto Run');
		await window.getByTitle('Browse PlayBooks - discover and share community playbooks').click();
		const marketplaceDialog = window.getByRole('dialog').first();
		await marketplaceDialog.getByRole('button', { name: /Issue Triage/ }).click();
		await marketplaceDialog.getByTitle('Browse for folder').click();
		await expect(
			marketplaceDialog.getByLabel(
				'Import to folder (relative to Auto Run folder or absolute path)'
			)
		).toHaveValue(selectedImportFolder);
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

	test('toggles command terminal input and output focus from the global shortcut', async () => {
		const terminalInput = await openSeededTerminalAgent(window);
		const terminalOutput = window.getByLabel('Terminal output');

		await terminalInput.focus();
		await terminalInput.press('Meta+.');
		await expect(terminalOutput).toBeFocused();

		await terminalOutput.press('Meta+.');
		await expect(terminalInput).toBeFocused();
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

	test('recovers command terminal output search from an unmatched query', async () => {
		await openSeededTerminalAgent(window);
		await window.getByLabel('Terminal output').press('Control+f');

		const searchInput = window.getByPlaceholder('Search output... (Esc to close)');
		await searchInput.fill('no terminal output match sentinel');
		await expect(window.getByText('terminal search sentinel')).toBeHidden();
		await expect(window.getByText('terminal stderr sentinel')).toBeHidden();

		await searchInput.fill('terminal search');
		await expect(window.getByText('terminal search sentinel')).toBeVisible();
		await expect(window.getByText('terminal stderr sentinel')).toBeHidden();

		await searchInput.fill('');
		await expect(window.getByText('terminal search sentinel')).toBeVisible();
		await expect(window.getByText('terminal stderr sentinel')).toBeVisible();

		await searchInput.press('Escape');
		await expect(searchInput).toBeHidden();
	});

	test('opens command terminal output search from the focused input shortcut', async () => {
		const terminalInput = await openSeededTerminalAgent(window);

		await terminalInput.focus();
		await terminalInput.press('Control+f');

		const searchInput = window.getByPlaceholder('Search output... (Esc to close)');
		await expect(searchInput).toBeVisible();
		await expect(searchInput).toBeFocused();
		await searchInput.fill('terminal stderr');
		await expect(window.getByText('terminal stderr sentinel')).toBeVisible();
		await expect(window.getByText('terminal seeded output is visible')).toBeHidden();
	});

	test('preserves command terminal drafts after opening and closing output search', async () => {
		const terminalInput = await openSeededTerminalAgent(window);

		await terminalInput.fill('draft survives output search sentinel');
		await terminalInput.press('Control+f');

		const searchInput = window.getByPlaceholder('Search output... (Esc to close)');
		await expect(searchInput).toBeFocused();
		await searchInput.fill('stderr sentinel');
		await expect(window.getByText('terminal stderr sentinel')).toBeVisible();

		await searchInput.press('Escape');
		await expect(searchInput).toBeHidden();
		await expect(terminalInput).toHaveValue('draft survives output search sentinel');
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

	test('shows terminal stderr badge and copies stderr output', async () => {
		await openSeededTerminalAgent(window);

		const stderrBlock = window.locator('[data-log-index="3"]');
		await expect(stderrBlock.getByText('STDERR', { exact: true })).toBeVisible();
		await expect(stderrBlock.getByText('terminal stderr sentinel')).toBeVisible();

		await stderrBlock.hover();
		await stderrBlock.getByTitle('Copy to clipboard').click();
		await expect(window.getByText('Copied to Clipboard')).toBeVisible();
	});

	test('copies command terminal stdout output from transcript actions', async () => {
		await openSeededTerminalAgent(window);

		const outputBlock = window.locator('[data-log-index="2"]');
		await outputBlock.hover();
		await outputBlock.getByTitle('Copy to clipboard').click();

		await expect(window.getByText('Copied to Clipboard')).toBeVisible();
		await expect(outputBlock.getByText('terminal search sentinel')).toBeVisible();
	});

	test('switches a command terminal output block to exclude filtering', async () => {
		await openSeededTerminalAgent(window);

		const outputBlock = window.locator('[data-log-index="2"]');
		await outputBlock.hover();
		await outputBlock.getByTitle('Filter this output').click();
		await outputBlock.getByPlaceholder('Include by keyword').fill('needle');
		await expect(outputBlock.getByText('terminal filter needle')).toBeVisible();
		await expect(outputBlock.getByText('terminal filter haystack')).toBeHidden();

		await outputBlock.getByTitle('Include matching lines').click();
		await expect(outputBlock.getByPlaceholder('Exclude by keyword')).toBeVisible();
		await expect(outputBlock.getByText('terminal filter needle')).toBeHidden();
		await expect(outputBlock.getByText('terminal filter haystack')).toBeVisible();

		await outputBlock.getByPlaceholder('Exclude by keyword').press('Escape');
		await expect(outputBlock.getByText('terminal filter needle')).toBeVisible();
		await expect(outputBlock.getByText('terminal filter haystack')).toBeVisible();
	});

	test('uses regex filtering on command terminal output blocks', async () => {
		await openSeededTerminalAgent(window);

		const outputBlock = window.locator('[data-log-index="2"]');

		await outputBlock.getByTitle('Filter this output').click();
		await outputBlock.getByTitle('Using plain text').click();
		await outputBlock.getByPlaceholder('Include by RegEx').fill('needle|haystack');
		await expect(outputBlock.getByText('terminal filter needle')).toBeVisible();
		await expect(outputBlock.getByText('terminal filter haystack')).toBeVisible();

		await outputBlock.getByPlaceholder('Include by RegEx').fill('needle$');
		await expect(outputBlock.getByText('terminal filter needle')).toBeVisible();
		await expect(outputBlock.getByText('terminal filter haystack')).toBeHidden();
	});

	test('shows command terminal local filter empty state and clears it with Escape', async () => {
		await openSeededTerminalAgent(window);

		const outputBlock = window.locator('[data-log-index="2"]');

		await outputBlock.getByTitle('Filter this output').click();
		const filterInput = outputBlock.getByPlaceholder('Include by keyword');
		await filterInput.fill('missing local filter sentinel');

		await expect(outputBlock.getByText('No matches found for filter')).toBeVisible();
		await expect(outputBlock.getByText('terminal filter needle')).toBeHidden();

		await filterInput.press('Escape');
		await expect(outputBlock.getByText('No matches found for filter')).toBeHidden();
		await expect(outputBlock.getByText('terminal filter needle')).toBeVisible();
		await expect(filterInput).toBeHidden();
	});

	test('cancels command terminal user-command paired deletion', async () => {
		await openSeededTerminalAgent(window);

		const commandBlock = window.locator('[data-log-index="1"]');
		const outputBlock = window.locator('[data-log-index="2"]');
		const stderrBlock = window.locator('[data-log-index="3"]');
		await commandBlock.hover();
		await commandBlock.getByTitle('Delete command and output').click();
		await expect(commandBlock.getByText('Delete?')).toBeVisible();

		await commandBlock.getByRole('button', { name: 'No' }).click();
		await expect(commandBlock.getByText('Delete?')).toBeHidden();
		await expect(outputBlock.getByText('terminal filter needle')).toBeVisible();
		await expect(stderrBlock.getByText('terminal stderr sentinel')).toBeVisible();
		await expect(window.locator('[data-log-index]')).toHaveCount(4);
	});

	test('deletes command terminal user command and paired output', async () => {
		await openSeededTerminalAgent(window);

		const commandBlock = window.locator('[data-log-index="1"]');
		await commandBlock.hover();
		await commandBlock.getByTitle('Delete command and output').click();
		await commandBlock.getByRole('button', { name: 'Yes' }).click();

		await expect(window.getByText('printf "terminal filter needle')).toHaveCount(0);
		await expect(window.getByText('terminal search sentinel')).toHaveCount(0);
		await expect(window.getByText('terminal stderr sentinel')).toHaveCount(0);
		await expect(window.getByText('terminal seeded output is visible')).toBeVisible();
		await expect(window.locator('[data-log-index]')).toHaveCount(1);
	});

	test('copies command terminal user commands from transcript actions', async () => {
		await openSeededTerminalAgent(window);

		const commandBlock = window.locator('[data-log-index="1"]');

		await commandBlock.getByTitle('Copy to clipboard').click();
		await expect(window.getByText('Copied to Clipboard')).toBeVisible();
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

	test('selects a command history entry by mouse and restores terminal input focus', async () => {
		const terminalInput = await openSeededTerminalAgent(window);

		await terminalInput.fill('manual history click draft sentinel');
		await terminalInput.press('ArrowUp');
		const historyFilter = window.getByPlaceholder('Filter commands...');
		await historyFilter.fill('status');
		await window.getByRole('button', { name: 'git status --short' }).click();

		await expect(historyFilter).toBeHidden();
		await expect(terminalInput).toHaveValue('git status --short');
		await expect(terminalInput).toBeFocused();
	});

	test('closes command terminal history search with Escape without replacing the draft', async () => {
		const terminalInput = await openSeededTerminalAgent(window);

		await terminalInput.fill('manual terminal draft sentinel');
		await terminalInput.press('ArrowUp');
		const historyFilter = window.getByPlaceholder('Filter commands...');
		await expect(historyFilter).toBeVisible();
		await historyFilter.fill('status');
		await expect(window.getByText('git status --short')).toBeVisible();

		await historyFilter.press('Escape');
		await expect(historyFilter).toBeHidden();
		await expect(terminalInput).toHaveValue('manual terminal draft sentinel');
	});

	test('keeps command history available after clearing the terminal transcript', async () => {
		const terminalInput = await openSeededTerminalAgent(window);
		await expect(window.locator('[data-log-index]')).toHaveCount(4);

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Clear Terminal History');
		await quickActionsDialog.getByRole('button', { name: /Clear Terminal History/ }).click();

		await expect(quickActionsDialog).toBeHidden();
		await expect(window.locator('[data-log-index]')).toHaveCount(0);

		await terminalInput.focus();
		await terminalInput.press('ArrowUp');
		const historyFilter = window.getByPlaceholder('Filter commands...');
		await expect(historyFilter).toBeVisible();
		await expect(window.getByText('git status --short')).toBeVisible();
	});

	test('shows command history empty state and recovers to a filtered command', async () => {
		const terminalInput = await openSeededTerminalAgent(window);

		await terminalInput.focus();
		await terminalInput.press('ArrowUp');
		const historyFilter = window.getByPlaceholder('Filter commands...');
		await historyFilter.fill('missing history sentinel');

		await expect(window.getByText('No matching commands')).toBeVisible();

		await historyFilter.fill('npm');
		await expect(window.getByText('npm test -- --runInBand')).toBeVisible();
		await historyFilter.press('Enter');
		await expect(terminalInput).toHaveValue('npm test -- --runInBand');
	});

	test('navigates command history with arrow keys before selecting', async () => {
		const terminalInput = await openSeededTerminalAgent(window);

		await terminalInput.focus();
		await terminalInput.press('ArrowUp');
		const historyFilter = window.getByPlaceholder('Filter commands...');
		await expect(
			window.getByRole('button', { name: 'echo terminal history sentinel' })
		).toBeVisible();

		await historyFilter.press('ArrowDown');
		await historyFilter.press('Enter');
		await expect(terminalInput).toHaveValue('npm test -- --runInBand');
	});

	test('selects the previous command history entry after reverse arrow navigation', async () => {
		const terminalInput = await openSeededTerminalAgent(window);

		await terminalInput.focus();
		await terminalInput.press('ArrowUp');
		const historyFilter = window.getByPlaceholder('Filter commands...');
		await historyFilter.press('ArrowDown');
		await historyFilter.press('ArrowUp');
		await historyFilter.press('Enter');

		await expect(terminalInput).toHaveValue('echo terminal history sentinel');
	});

	test('runs a command selected from terminal history through the stubbed runner', async () => {
		await stubTerminalRunCommand(electronApp);
		const terminalInput = await openSeededTerminalAgent(window);

		await terminalInput.focus();
		await terminalInput.press('ArrowUp');
		const historyFilter = window.getByPlaceholder('Filter commands...');
		await historyFilter.fill('history sentinel');
		await historyFilter.press('Enter');
		await expect(historyFilter).toBeHidden();
		await expect(terminalInput).toHaveValue('echo terminal history sentinel');

		await terminalInput.press('Enter');

		await expect(terminalInput).toHaveValue('');
		await expect(
			(await getStubbedTerminalRunCommandCalls(electronApp)).map((call) => call.command)
		).toEqual(['echo terminal history sentinel']);
	});

	test('runs a command terminal input through the process runner and clears busy state', async () => {
		await stubTerminalRunCommand(electronApp);
		const terminalInput = await openSeededTerminalAgent(window);
		const inputArea = window.locator('[data-tour="input-area"]');

		await terminalInput.fill('echo terminal live stdout sentinel');
		await inputArea.getByTitle('Run command (Enter)').click();

		await expect(window.getByText('Executing command...')).toBeVisible();
		await expect(window.getByText('echo terminal live stdout sentinel')).toBeVisible();
		await expect(window.getByText('terminal live stdout sentinel')).toBeVisible();
		await expect(window.getByText('Executing command...')).toBeHidden();
		await expect(terminalInput).toHaveValue('');
	});

	test('runs a command terminal input with Enter when idle', async () => {
		await stubTerminalRunCommand(electronApp);
		const terminalInput = await openSeededTerminalAgent(window);

		await terminalInput.fill('echo terminal live stdout sentinel');
		await terminalInput.press('Enter');

		await expect(window.getByText('terminal live stdout sentinel')).toBeVisible();
		await expect(terminalInput).toHaveValue('');
		await expect(
			(await getStubbedTerminalRunCommandCalls(electronApp)).map((call) => call.command)
		).toEqual(['echo terminal live stdout sentinel']);
	});

	test('ignores blank command terminal submissions without changing the draft', async () => {
		await stubTerminalRunCommand(electronApp);
		const terminalInput = await openSeededTerminalAgent(window);
		const inputArea = window.locator('[data-tour="input-area"]');

		await terminalInput.fill('   ');
		await inputArea.getByTitle('Run command (Enter)').click();
		await terminalInput.press('Enter');
		await window.waitForTimeout(300);

		await expect(terminalInput).toHaveValue('   ');
		await expect(await getStubbedTerminalRunCommandCalls(electronApp)).toEqual([]);
	});

	test('submits multiline command terminal input through the shell runner', async () => {
		await stubTerminalRunCommand(electronApp);
		const terminalInput = await openSeededTerminalAgent(window);
		const inputArea = window.locator('[data-tour="input-area"]');
		const multilineCommand = 'printf "terminal multiline one"\nprintf "terminal multiline two"';

		await terminalInput.fill(multilineCommand);
		await inputArea.getByTitle('Run command (Enter)').click();

		await expect(terminalInput).toHaveValue('');
		expect(
			(await getStubbedTerminalRunCommandCalls(electronApp)).map((call) => call.command)
		).toEqual([multilineCommand]);
	});

	test('passes terminal slash commands through to the shell runner', async () => {
		await stubTerminalRunCommand(electronApp);
		const terminalInput = await openSeededTerminalAgent(window);

		await terminalInput.fill('/clear');
		await terminalInput.press('Enter');

		await expect(window.getByText('/clear')).toBeVisible();
		await expect(
			(await getStubbedTerminalRunCommandCalls(electronApp)).map((call) => call.command)
		).toEqual(['/clear']);
	});

	test('interrupts a running command terminal process from the Stop control', async () => {
		await stubTerminalRunCommand(electronApp);
		await stubProcessInterrupt(electronApp);
		const terminalInput = await openSeededTerminalAgent(window);
		const inputArea = window.locator('[data-tour="input-area"]');

		await terminalInput.fill('run terminal interrupt hold sentinel');
		await inputArea.getByTitle('Run command (Enter)').click();
		await expect(window.getByText('terminal interrupt hold sentinel started')).toBeVisible();
		await expect(window.getByText('Executing command...')).toBeVisible();

		await window.getByRole('button', { name: 'Stop' }).click();

		const session = seededWorkbench.sessions[1]!;
		await expect
			.poll(async () => getStubbedProcessInterruptCalls(electronApp))
			.toEqual([`${session.id}-terminal`]);
		await expect(window.getByText('terminal interrupt hold sentinel stopped 130')).toBeVisible();
		await expect(window.getByText('Command exited with code 130')).toBeVisible();
		await expect(window.getByText('Executing command...')).toBeHidden();
		await expect(terminalInput).toBeEnabled();
	});

	test('force kills a running command terminal process when interrupt fails', async () => {
		await stubProcessMonitorProcesses(electronApp, seededWorkbench);
		await stubTerminalRunCommand(electronApp);
		await stubProcessInterrupt(electronApp, { fail: true });
		const dialogMessages: string[] = [];
		window.once('dialog', async (dialog) => {
			dialogMessages.push(dialog.message());
			await dialog.accept();
		});
		const terminalInput = await openSeededTerminalAgent(window);
		const inputArea = window.locator('[data-tour="input-area"]');

		await terminalInput.fill('run terminal interrupt hold sentinel');
		await inputArea.getByTitle('Run command (Enter)').click();
		await expect(window.getByText('terminal interrupt hold sentinel started')).toBeVisible();
		await window.getByRole('button', { name: 'Stop' }).click();

		const session = seededWorkbench.sessions[1]!;
		await expect
			.poll(async () => getStubbedProcessInterruptCalls(electronApp))
			.toEqual([`${session.id}-terminal`]);
		await expect
			.poll(async () => getStubbedKilledProcessIds(electronApp))
			.toEqual([`${session.id}-terminal`]);
		expect(dialogMessages[0]).toContain('Failed to interrupt the process gracefully');
		await expect(window.getByText('Process forcefully terminated')).toBeVisible();
		await expect(window.getByText('Command exited with code 137')).toBeVisible();
		await expect(window.getByText('Executing command...')).toBeHidden();
	});

	test('preserves terminal drafts while blocking duplicate runs during an active command', async () => {
		await stubTerminalRunCommand(electronApp);
		await stubProcessInterrupt(electronApp);
		const terminalInput = await openSeededTerminalAgent(window);
		const inputArea = window.locator('[data-tour="input-area"]');

		await terminalInput.fill('run terminal interrupt hold sentinel');
		await inputArea.getByTitle('Run command (Enter)').click();
		await expect(window.getByText('terminal interrupt hold sentinel started')).toBeVisible();
		await expect(inputArea.getByTitle('Command already running')).toBeDisabled();

		await terminalInput.fill('echo terminal live stdout sentinel');
		await terminalInput.press('Enter');
		await window.waitForTimeout(300);
		await expect(terminalInput).toHaveValue('echo terminal live stdout sentinel');
		await expect(
			(await getStubbedTerminalRunCommandCalls(electronApp)).map((call) => call.command)
		).toEqual(['run terminal interrupt hold sentinel']);

		await window.getByRole('button', { name: 'Stop' }).click();
		await expect(window.getByText('terminal interrupt hold sentinel stopped 130')).toBeVisible();
		await expect(inputArea.getByTitle('Run command (Enter)')).toBeEnabled();

		await inputArea.getByTitle('Run command (Enter)').click();
		await expect(window.getByText('terminal live stdout sentinel')).toBeVisible();
		await expect(
			(await getStubbedTerminalRunCommandCalls(electronApp)).map((call) => call.command)
		).toEqual(['run terminal interrupt hold sentinel', 'echo terminal live stdout sentinel']);
	});

	test('routes command terminal PTY resize through the preload IPC bridge', async () => {
		await stubProcessResize(electronApp);
		await openSeededTerminalAgent(window);

		const session = seededWorkbench.sessions[1]!;
		const resized = await window.evaluate(
			async ({ sessionId }) => {
				const maestroWindow = window as Window & {
					maestro: {
						process: {
							resize: (sessionId: string, cols: number, rows: number) => Promise<boolean>;
						};
					};
				};
				return maestroWindow.maestro.process.resize(`${sessionId}-terminal`, 132, 43);
			},
			{ sessionId: session.id }
		);

		expect(resized).toBe(true);
		await expect
			.poll(async () => getStubbedProcessResizeCalls(electronApp))
			.toEqual([
				{
					sessionId: `${session.id}-terminal`,
					cols: 132,
					rows: 43,
				},
			]);
	});

	test('surfaces an executing terminal command in Process Monitor details', async () => {
		await stubProcessMonitorProcesses(electronApp, seededWorkbench);
		await stubTerminalRunCommand(electronApp);
		const terminalInput = await openSeededTerminalAgent(window);
		const inputArea = window.locator('[data-tour="input-area"]');

		await terminalInput.fill('echo terminal monitored process sentinel');
		await inputArea.getByTitle('Run command (Enter)').click();
		await expect(window.getByText('terminal monitored process started')).toBeVisible();

		const processMonitor = await openProcessMonitor(window);
		await expect(processMonitor.getByText('2 active')).toBeVisible();
		await processMonitor.getByText('E2E Terminal - Terminal Shell').dblclick();

		const details = window.getByRole('dialog', { name: 'Process Details' });
		await expect(details).toBeVisible();
		await expect(details.getByText('41005')).toBeVisible();
		await expect(details.getByText(seededWorkbench.sessions[1].cwd)).toBeVisible();
		await expect(
			details.getByText('zsh -lc echo terminal monitored process sentinel')
		).toBeVisible();

		await details.getByTitle('Close').click();
		await expect(window.getByText('terminal monitored process done')).toBeVisible({
			timeout: 10_000,
		});
		await expect(window.getByText('Executing command...')).toBeHidden();
	});

	test('shows command terminal stderr and nonzero exit code', async () => {
		await stubTerminalRunCommand(electronApp);
		const terminalInput = await openSeededTerminalAgent(window);
		const inputArea = window.locator('[data-tour="input-area"]');

		await terminalInput.fill('run terminal live failure sentinel');
		await inputArea.getByTitle('Run command (Enter)').click();

		await expect(window.getByText('terminal live stderr sentinel')).toBeVisible();
		await expect(window.getByText('Command exited with code 7')).toBeVisible();
		await expect(window.getByText('Executing command...')).toBeHidden();
	});

	test('shows command terminal setup failures and clears busy state', async () => {
		await stubTerminalRunCommand(electronApp);
		const terminalInput = await openSeededTerminalAgent(window);
		const inputArea = window.locator('[data-tour="input-area"]');

		await terminalInput.fill('trigger terminal setup failure sentinel');
		await inputArea.getByTitle('Run command (Enter)').click();

		await expect(window.getByText(/Failed to run command.*shell setup sentinel/)).toBeVisible();
		await expect(window.getByText('Executing command...')).toBeHidden();
		await expect(terminalInput).toHaveValue('');
		const calls = await getStubbedTerminalRunCommandCalls(electronApp);
		await expect(calls.map((call) => call.command)).toContain(
			'trigger terminal setup failure sentinel'
		);
	});

	test('clears command terminal transcript without invoking the process runner', async () => {
		await stubTerminalRunCommand(electronApp);
		const terminalInput = await openSeededTerminalAgent(window);
		const inputArea = window.locator('[data-tour="input-area"]');

		await terminalInput.fill('clear');
		await inputArea.getByTitle('Run command (Enter)').click();

		await expect(window.locator('[data-log-index]')).toHaveCount(0);
		await expect(await getStubbedTerminalRunCommandCalls(electronApp)).toEqual([]);
	});

	test('updates command terminal cwd after cd and runs follow-up commands there', async () => {
		await stubTerminalRunCommand(electronApp);
		const terminalInput = await openSeededTerminalAgent(window);
		const inputArea = window.locator('[data-tour="input-area"]');
		const expectedCwd = path.join(seededWorkbench.sessions[1].cwd, 'Auto Run Docs');

		await terminalInput.fill('cd "Auto Run Docs"');
		await inputArea.getByTitle('Run command (Enter)').click();
		await expect(inputArea.getByText(/Auto Run Docs/)).toBeVisible();

		await terminalInput.fill('pwd');
		await inputArea.getByTitle('Run command (Enter)').click();

		const pwdOutput = window.locator('[data-log-index]').last();
		await expect(pwdOutput.getByText(expectedCwd)).toBeVisible();
		const calls = await getStubbedTerminalRunCommandCalls(electronApp);
		await expect(calls.map((call) => call.command)).toEqual(['cd "Auto Run Docs"', 'pwd']);
		await expect(calls[1].cwd).toBe(expectedCwd);
	});

	test('updates command terminal cwd after parent cd before a follow-up command', async () => {
		await stubTerminalRunCommand(electronApp);
		const terminalInput = await openSeededTerminalAgent(window);
		const inputArea = window.locator('[data-tour="input-area"]');
		const expectedCwd = path.dirname(seededWorkbench.sessions[1].cwd);

		await terminalInput.fill('cd ..');
		await inputArea.getByTitle('Run command (Enter)').click();

		await terminalInput.fill('pwd');
		await inputArea.getByTitle('Run command (Enter)').click();

		await expect(window.locator('[data-log-index]').last().getByText(expectedCwd)).toBeVisible();
		const calls = await getStubbedTerminalRunCommandCalls(electronApp);
		await expect(calls.map((call) => call.command)).toEqual(['cd ..', 'pwd']);
		await expect(calls[0].cwd).toBe(seededWorkbench.sessions[1].cwd);
		await expect(calls[1].cwd).toBe(expectedCwd);
	});

	test('resets local command terminal cwd to the project root with bare cd', async () => {
		await stubTerminalRunCommand(electronApp);
		const terminalInput = await openSeededTerminalAgent(window);
		const inputArea = window.locator('[data-tour="input-area"]');
		const originalCwd = seededWorkbench.sessions[1].cwd;

		await terminalInput.fill('cd "Auto Run Docs"');
		await inputArea.getByTitle('Run command (Enter)').click();
		await expect(inputArea.getByText(/Auto Run Docs/)).toBeVisible();

		await terminalInput.fill('cd');
		await inputArea.getByTitle('Run command (Enter)').click();
		await expect(inputArea.getByText(originalCwd)).toBeVisible();

		await terminalInput.fill('pwd');
		await inputArea.getByTitle('Run command (Enter)').click();

		await expect(window.locator('[data-log-index]').last().getByText(originalCwd)).toBeVisible();
		const calls = await getStubbedTerminalRunCommandCalls(electronApp);
		await expect(calls.map((call) => call.command)).toEqual(['cd "Auto Run Docs"', 'cd', 'pwd']);
		await expect(calls[0].cwd).toBe(originalCwd);
		await expect(calls[2].cwd).toBe(originalCwd);
	});

	test('updates command terminal cwd after tilde cd before a follow-up command', async () => {
		await stubTerminalRunCommand(electronApp);
		const terminalInput = await openSeededTerminalAgent(window);
		const inputArea = window.locator('[data-tour="input-area"]');
		const expectedCwd = path.join(seededWorkbench.sessions[1].cwd, 'Auto Run Docs');

		await terminalInput.fill('cd ~/Auto Run Docs');
		await inputArea.getByTitle('Run command (Enter)').click();
		await expect(inputArea.getByText(/Auto Run Docs/)).toBeVisible();

		await terminalInput.fill('pwd');
		await inputArea.getByTitle('Run command (Enter)').click();

		await expect(window.locator('[data-log-index]').last().getByText(expectedCwd)).toBeVisible();
		const calls = await getStubbedTerminalRunCommandCalls(electronApp);
		await expect(calls.map((call) => call.command)).toEqual(['cd ~/Auto Run Docs', 'pwd']);
		await expect(calls[0].cwd).toBe(seededWorkbench.sessions[1].cwd);
		await expect(calls[1].cwd).toBe(expectedCwd);
	});

	test('updates command terminal cwd after absolute cd before a follow-up command', async () => {
		await stubTerminalRunCommand(electronApp);
		const terminalInput = await openSeededTerminalAgent(window);
		const inputArea = window.locator('[data-tour="input-area"]');
		const originalCwd = seededWorkbench.sessions[1].cwd;
		const expectedCwd = path.join(originalCwd, 'Auto Run Docs');
		const absoluteCdCommand = `cd "${expectedCwd}"`;

		await terminalInput.fill(absoluteCdCommand);
		await inputArea.getByTitle('Run command (Enter)').click();
		await expect(inputArea.getByText(/Auto Run Docs/)).toBeVisible();

		await terminalInput.fill('pwd');
		await inputArea.getByTitle('Run command (Enter)').click();

		await expect(window.locator('[data-log-index]').last().getByText(expectedCwd)).toBeVisible();
		const calls = await getStubbedTerminalRunCommandCalls(electronApp);
		await expect(calls.map((call) => call.command)).toEqual([absoluteCdCommand, 'pwd']);
		await expect(calls[0].cwd).toBe(originalCwd);
		await expect(calls[1].cwd).toBe(expectedCwd);
	});

	test('updates command terminal cwd after relative parent-subpath cd', async () => {
		await stubTerminalRunCommand(electronApp);
		const terminalInput = await openSeededTerminalAgent(window);
		const inputArea = window.locator('[data-tour="input-area"]');
		const originalCwd = seededWorkbench.sessions[1].cwd;
		const expectedCwd = path.join(path.dirname(originalCwd), 'project', 'Auto Run Docs');

		await terminalInput.fill('cd "../project/Auto Run Docs"');
		await inputArea.getByTitle('Run command (Enter)').click();
		await expect(inputArea.getByText(/Auto Run Docs/)).toBeVisible();

		await terminalInput.fill('pwd');
		await inputArea.getByTitle('Run command (Enter)').click();

		await expect(window.locator('[data-log-index]').last().getByText(expectedCwd)).toBeVisible();
		const calls = await getStubbedTerminalRunCommandCalls(electronApp);
		await expect(calls.map((call) => call.command)).toEqual([
			'cd "../project/Auto Run Docs"',
			'pwd',
		]);
		await expect(calls[0].cwd).toBe(originalCwd);
		await expect(calls[1].cwd).toBe(expectedCwd);
	});

	test('keeps changed command terminal cwd when a later cd target is missing', async () => {
		await stubTerminalRunCommand(electronApp);
		const terminalInput = await openSeededTerminalAgent(window);
		const inputArea = window.locator('[data-tour="input-area"]');
		const originalCwd = seededWorkbench.sessions[1].cwd;
		const expectedCwd = path.join(originalCwd, 'Auto Run Docs');

		await terminalInput.fill('cd "Auto Run Docs"');
		await inputArea.getByTitle('Run command (Enter)').click();
		await expect(inputArea.getByText(/Auto Run Docs/)).toBeVisible();

		await terminalInput.fill('cd missing-after-cwd-change');
		await inputArea.getByTitle('Run command (Enter)').click();

		await terminalInput.fill('pwd');
		await inputArea.getByTitle('Run command (Enter)').click();

		await expect(window.locator('[data-log-index]').last().getByText(expectedCwd)).toBeVisible();
		const calls = await getStubbedTerminalRunCommandCalls(electronApp);
		await expect(calls.map((call) => call.command)).toEqual([
			'cd "Auto Run Docs"',
			'cd missing-after-cwd-change',
			'pwd',
		]);
		await expect(calls[0].cwd).toBe(originalCwd);
		await expect(calls[1].cwd).toBe(expectedCwd);
		await expect(calls[2].cwd).toBe(expectedCwd);
	});

	test('resets local command terminal cwd to the project root with cd tilde', async () => {
		await stubTerminalRunCommand(electronApp);
		const terminalInput = await openSeededTerminalAgent(window);
		const inputArea = window.locator('[data-tour="input-area"]');
		const originalCwd = seededWorkbench.sessions[1].cwd;
		const changedCwd = path.join(originalCwd, 'Auto Run Docs');

		await terminalInput.fill('cd "Auto Run Docs"');
		await inputArea.getByTitle('Run command (Enter)').click();
		await expect(inputArea.getByText(/Auto Run Docs/)).toBeVisible();

		await terminalInput.fill('cd ~');
		await inputArea.getByTitle('Run command (Enter)').click();
		await expect(inputArea.getByText(originalCwd)).toBeVisible();

		await terminalInput.fill('pwd');
		await inputArea.getByTitle('Run command (Enter)').click();

		await expect(window.locator('[data-log-index]').last().getByText(originalCwd)).toBeVisible();
		const calls = await getStubbedTerminalRunCommandCalls(electronApp);
		await expect(calls.map((call) => call.command)).toEqual(['cd "Auto Run Docs"', 'cd ~', 'pwd']);
		await expect(calls[0].cwd).toBe(originalCwd);
		await expect(calls[1].cwd).toBe(changedCwd);
		await expect(calls[2].cwd).toBe(originalCwd);
	});

	test('preserves command terminal cwd after switching away and back to the terminal agent', async () => {
		await stubTerminalRunCommand(electronApp);
		let terminalInput = await openSeededTerminalAgent(window);
		const inputArea = window.locator('[data-tour="input-area"]');
		const originalCwd = seededWorkbench.sessions[1].cwd;
		const expectedCwd = path.join(originalCwd, 'Auto Run Docs');

		await terminalInput.fill('cd "Auto Run Docs"');
		await inputArea.getByTitle('Run command (Enter)').click();
		await expect(inputArea.getByText(/Auto Run Docs/)).toBeVisible();

		await window.getByText('E2E Workbench').click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		terminalInput = await openSeededTerminalAgent(window);
		await expect(inputArea.getByText(/Auto Run Docs/)).toBeVisible();

		await terminalInput.fill('pwd');
		await inputArea.getByTitle('Run command (Enter)').click();

		await expect(window.locator('[data-log-index]').last().getByText(expectedCwd)).toBeVisible();
		const calls = await getStubbedTerminalRunCommandCalls(electronApp);
		await expect(calls.map((call) => call.command)).toEqual(['cd "Auto Run Docs"', 'pwd']);
		await expect(calls[0].cwd).toBe(originalCwd);
		await expect(calls[1].cwd).toBe(expectedCwd);
	});

	test('keeps command terminal cwd unchanged when cd target is missing', async () => {
		await stubTerminalRunCommand(electronApp);
		const terminalInput = await openSeededTerminalAgent(window);
		const inputArea = window.locator('[data-tour="input-area"]');
		const originalCwd = seededWorkbench.sessions[1].cwd;

		await terminalInput.fill('cd missing-e2e-folder');
		await inputArea.getByTitle('Run command (Enter)').click();

		await terminalInput.fill('pwd');
		await inputArea.getByTitle('Run command (Enter)').click();

		await expect(window.locator('[data-log-index]').last().getByText(originalCwd)).toBeVisible();
		const calls = await getStubbedTerminalRunCommandCalls(electronApp);
		await expect(calls.map((call) => call.command)).toEqual(['cd missing-e2e-folder', 'pwd']);
		await expect(calls[0].cwd).toBe(originalCwd);
		await expect(calls[1].cwd).toBe(originalCwd);
	});

	test('deduplicates repeated command terminal history entries', async () => {
		await stubTerminalRunCommand(electronApp);
		const terminalInput = await openSeededTerminalAgent(window);
		const inputArea = window.locator('[data-tour="input-area"]');
		const repeatedCommand = 'echo repeated terminal history sentinel';

		await terminalInput.fill(repeatedCommand);
		await inputArea.getByTitle('Run command (Enter)').click();
		await expect(terminalInput).toHaveValue('');
		await expect
			.poll(async () => (await getStubbedTerminalRunCommandCalls(electronApp)).length)
			.toBe(1);
		await expect(window.getByText('Executing command...')).toBeHidden();

		await terminalInput.fill(repeatedCommand);
		await inputArea.getByTitle('Run command (Enter)').click();
		await expect(terminalInput).toHaveValue('');
		await expect
			.poll(async () => (await getStubbedTerminalRunCommandCalls(electronApp)).length)
			.toBe(2);
		await expect(window.getByText('Executing command...')).toBeHidden();

		await terminalInput.focus();
		await terminalInput.press('ArrowUp');
		const historyFilter = window.getByPlaceholder('Filter commands...');
		await historyFilter.fill('repeated terminal history sentinel');

		await expect(window.getByRole('button', { name: repeatedCommand })).toHaveCount(1);
	});

	test('preserves command terminal cwd after clearing the transcript', async () => {
		await stubTerminalRunCommand(electronApp);
		const terminalInput = await openSeededTerminalAgent(window);
		const inputArea = window.locator('[data-tour="input-area"]');
		const expectedCwd = path.join(seededWorkbench.sessions[1].cwd, 'Auto Run Docs');

		await terminalInput.fill('cd "Auto Run Docs"');
		await inputArea.getByTitle('Run command (Enter)').click();
		await expect(inputArea.getByText(/Auto Run Docs/)).toBeVisible();

		await terminalInput.fill('clear');
		await inputArea.getByTitle('Run command (Enter)').click();
		await expect(window.locator('[data-log-index]')).toHaveCount(0);

		await terminalInput.fill('pwd');
		await inputArea.getByTitle('Run command (Enter)').click();

		await expect(window.locator('[data-log-index]').last().getByText(expectedCwd)).toBeVisible();
		const calls = await getStubbedTerminalRunCommandCalls(electronApp);
		await expect(calls.map((call) => call.command)).toEqual(['cd "Auto Run Docs"', 'pwd']);
		await expect(calls[1].cwd).toBe(expectedCwd);
	});

	test('recovers command terminal history search after a no-match filter', async () => {
		const terminalInput = await openSeededTerminalAgent(window);

		await terminalInput.focus();
		await terminalInput.press('ArrowUp');
		const historyFilter = window.getByPlaceholder('Filter commands...');
		await historyFilter.fill('missing-history-command-sentinel');
		await expect(window.getByText('No matching commands')).toBeVisible();

		await historyFilter.fill('git status');
		await expect(window.getByRole('button', { name: 'git status --short' })).toBeVisible();
		await historyFilter.press('Enter');
		await expect(terminalInput).toHaveValue('git status --short');
	});

	test('keeps command terminal draft when the command history filter is canceled from no-match', async () => {
		const terminalInput = await openSeededTerminalAgent(window);
		await terminalInput.fill('draft before no-match history sentinel');

		await terminalInput.press('ArrowUp');
		const historyFilter = window.getByPlaceholder('Filter commands...');
		await historyFilter.fill('missing-history-command-sentinel');
		await expect(window.getByText('No matching commands')).toBeVisible();

		await historyFilter.press('Escape');
		await expect(historyFilter).toBeHidden();
		await expect(terminalInput).toHaveValue('draft before no-match history sentinel');
	});

	test('keeps command terminal draft after toggling output focus shortcuts', async () => {
		const terminalInput = await openSeededTerminalAgent(window);
		const terminalOutput = window.getByLabel('Terminal output');
		await terminalInput.fill('draft across terminal focus shortcut sentinel');

		await terminalInput.press('Meta+.');
		await expect(terminalOutput).toBeFocused();

		await terminalOutput.press('Meta+.');
		await expect(terminalInput).toBeFocused();
		await expect(terminalInput).toHaveValue('draft across terminal focus shortcut sentinel');
	});

	test('persists command terminal history across an app restart', async () => {
		await stubTerminalRunCommand(electronApp);
		const terminalInput = await openSeededTerminalAgent(window);
		const inputArea = window.locator('[data-tour="input-area"]');

		await terminalInput.fill('echo terminal live stdout sentinel');
		await inputArea.getByTitle('Run command (Enter)').click();
		await expect(window.getByText('terminal live stdout sentinel')).toBeVisible();
		await window.waitForTimeout(1200);

		await electronApp.close();
		cleanupApp = async () => {
			fs.rmSync(seededWorkbench.homeDir, { recursive: true, force: true });
		};

		const relaunched = await helpers.launchAppFromExistingState({
			homeDir: seededWorkbench.homeDir,
		});
		electronApp = relaunched.electronApp;
		window = relaunched.window;
		cleanupApp = relaunched.cleanup;

		const relaunchedInput = await openSeededTerminalAgent(window);
		await relaunchedInput.focus();
		await relaunchedInput.press('ArrowUp');
		const historyFilter = window.getByPlaceholder('Filter commands...');
		await expect(historyFilter).toBeVisible();
		await expect(
			window.getByRole('button', { name: 'echo terminal live stdout sentinel' })
		).toBeVisible();
		await historyFilter.press('Enter');
		await expect(relaunchedInput).toHaveValue('echo terminal live stdout sentinel');
	});

	test('completes a terminal history command with Tab without invoking the runner', async () => {
		await stubTerminalRunCommand(electronApp);
		const terminalInput = await openSeededTerminalAgent(window);

		await terminalInput.fill('git');
		await terminalInput.press('Tab');

		await expect(terminalInput).toHaveValue('git status --short');
		await expect(await getStubbedTerminalRunCommandCalls(electronApp)).toEqual([]);
	});

	test('runs a terminal command completed from history with the run control', async () => {
		await stubTerminalRunCommand(electronApp);
		const terminalInput = await openSeededTerminalAgent(window);
		const inputArea = window.locator('[data-tour="input-area"]');

		await terminalInput.fill('echo');
		await terminalInput.press('Tab');
		await expect(terminalInput).toHaveValue('echo terminal history sentinel');

		await inputArea.getByTitle('Run command (Enter)').click();

		await expect(terminalInput).toHaveValue('');
		await expect(
			(await getStubbedTerminalRunCommandCalls(electronApp)).map((call) => call.command)
		).toEqual(['echo terminal history sentinel']);
	});

	test('moves terminal input focus to output with Escape while preserving the draft', async () => {
		const terminalInput = await openSeededTerminalAgent(window);
		const terminalOutput = window.getByLabel('Terminal output');

		await terminalInput.fill('draft before terminal escape focus sentinel');
		await terminalInput.press('Escape');

		await expect(terminalOutput).toBeFocused();
		await expect(terminalInput).toHaveValue('draft before terminal escape focus sentinel');
	});

	test('clears a command terminal local output filter from the close control', async () => {
		await openSeededTerminalAgent(window);
		const outputBlock = window.locator('[data-log-index="2"]');

		await outputBlock.hover();
		await outputBlock.getByTitle('Filter this output').click();
		const filterInput = outputBlock.getByPlaceholder('Include by keyword');
		await filterInput.fill('needle');
		await expect(outputBlock.getByText('terminal filter needle')).toBeVisible();
		await expect(outputBlock.getByText('terminal filter haystack')).toBeHidden();

		await filterInput.locator('xpath=..').locator('button').last().click();

		await expect(filterInput).toBeHidden();
		await expect(outputBlock.getByText('terminal filter needle')).toBeVisible();
		await expect(outputBlock.getByText('terminal filter haystack')).toBeVisible();

		await outputBlock.getByTitle('Filter this output').click();
		await expect(outputBlock.getByPlaceholder('Include by keyword')).toBeVisible();
	});

	test('keeps a command terminal local output filter while global output search opens and closes', async () => {
		await openSeededTerminalAgent(window);
		const outputBlock = window.locator('[data-log-index="2"]');

		await outputBlock.getByTitle('Filter this output').click();
		await outputBlock.getByPlaceholder('Include by keyword').fill('needle');
		await expect(outputBlock.getByText('terminal filter needle')).toBeVisible();
		await expect(outputBlock.getByText('terminal filter haystack')).toBeHidden();

		await window.getByLabel('Terminal output').press('Control+f');
		const searchInput = window.getByPlaceholder('Search output... (Esc to close)');
		await searchInput.fill('terminal filter');
		await expect(outputBlock.getByText('terminal filter needle')).toBeVisible();
		await expect(outputBlock.getByText('terminal filter haystack')).toBeHidden();

		await searchInput.press('Escape');
		await expect(searchInput).toBeHidden();
		await expect(outputBlock.getByText('terminal filter needle')).toBeVisible();
		await expect(outputBlock.getByText('terminal filter haystack')).toBeHidden();
	});

	test('filters command terminal stderr locally and restores it from the close control', async () => {
		await openSeededTerminalAgent(window);
		const stderrBlock = window.locator('[data-log-index="3"]');

		await stderrBlock.getByTitle('Filter this output').click();
		const filterInput = stderrBlock.getByPlaceholder('Include by keyword');
		await filterInput.fill('missing stderr local filter sentinel');

		await expect(stderrBlock.getByText('No matches found for filter')).toBeVisible();
		await expect(stderrBlock.getByText('terminal stderr sentinel')).toBeHidden();

		await filterInput.locator('xpath=..').locator('button').last().click();
		await expect(stderrBlock.getByText('No matches found for filter')).toBeHidden();
		await expect(stderrBlock.getByText('terminal stderr sentinel')).toBeVisible();
	});

	test('treats a whitespace-padded clear command as a local transcript clear', async () => {
		await stubTerminalRunCommand(electronApp);
		const terminalInput = await openSeededTerminalAgent(window);
		const inputArea = window.locator('[data-tour="input-area"]');

		await terminalInput.fill('  clear  ');
		await inputArea.getByTitle('Run command (Enter)').click();

		await expect(window.locator('[data-log-index]')).toHaveCount(0);
		await expect(await getStubbedTerminalRunCommandCalls(electronApp)).toEqual([]);
	});

	test('updates command terminal cwd after a quoted trailing-slash cd', async () => {
		await stubTerminalRunCommand(electronApp);
		const terminalInput = await openSeededTerminalAgent(window);
		const inputArea = window.locator('[data-tour="input-area"]');
		const expectedCwd = `${path.join(seededWorkbench.sessions[1].cwd, 'Auto Run Docs')}/`;

		await terminalInput.fill('cd "Auto Run Docs/"');
		await inputArea.getByTitle('Run command (Enter)').click();
		await expect(inputArea.getByText(/Auto Run Docs/)).toBeVisible();

		await terminalInput.fill('pwd');
		await inputArea.getByTitle('Run command (Enter)').click();

		await expect(window.locator('[data-log-index]').last().getByText(expectedCwd)).toBeVisible();
		const calls = await getStubbedTerminalRunCommandCalls(electronApp);
		await expect(calls.map((call) => call.command)).toEqual(['cd "Auto Run Docs/"', 'pwd']);
		await expect(calls[1].cwd).toBe(expectedCwd);
	});

	test('opens command history with the current terminal draft as its filter', async () => {
		const terminalInput = await openSeededTerminalAgent(window);

		await terminalInput.fill('npm');
		await terminalInput.press('ArrowUp');
		const historyFilter = window.getByPlaceholder('Filter commands...');

		await expect(historyFilter).toHaveValue('npm');
		await expect(window.getByRole('button', { name: 'npm test -- --runInBand' })).toBeVisible();
		await expect(window.getByRole('button', { name: 'git status --short' })).toBeHidden();

		await historyFilter.press('Escape');
		await expect(historyFilter).toBeHidden();
		await expect(terminalInput).toHaveValue('npm');
	});

	test('keeps command terminal output search active while toggling the right panel', async () => {
		await openSeededTerminalAgent(window);
		await window.getByLabel('Terminal output').press('Control+f');
		const searchInput = window.getByPlaceholder('Search output... (Esc to close)');

		await searchInput.fill('stderr sentinel');
		await expect(window.getByText('terminal stderr sentinel')).toBeVisible();
		await window.keyboard.press('Alt+Meta+ArrowRight');
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();

		await expect(searchInput).toBeVisible();
		await expect(searchInput).toHaveValue('stderr sentinel');
		await expect(window.getByText('terminal stderr sentinel')).toBeVisible();
	});

	test('searches command terminal user commands from the output search overlay', async () => {
		await openSeededTerminalAgent(window);
		await window.getByLabel('Terminal output').press('Control+f');

		const searchInput = window.getByPlaceholder('Search output... (Esc to close)');
		await searchInput.fill('printf');

		await expect(window.getByText('printf "terminal filter needle')).toBeVisible();
		await expect(window.getByText('terminal stderr sentinel')).toBeHidden();
	});

	test('restores command terminal transcript after clearing output search query', async () => {
		await openSeededTerminalAgent(window);
		await window.getByLabel('Terminal output').press('Control+f');

		const searchInput = window.getByPlaceholder('Search output... (Esc to close)');
		await searchInput.fill('stderr sentinel');
		await expect(window.locator('[data-log-index]')).toHaveCount(1);
		await expect(window.getByText('terminal stderr sentinel')).toBeVisible();

		await searchInput.fill('');

		await expect(window.locator('[data-log-index]')).toHaveCount(4);
		await expect(window.getByText('terminal seeded output is visible')).toBeVisible();
		await expect(window.getByText('terminal search sentinel')).toBeVisible();
		await expect(window.getByText('terminal stderr sentinel')).toBeVisible();
	});

	test('keeps command terminal output search visible after hiding and restoring the Right Bar', async () => {
		await openSeededTerminalAgent(window);
		await window.getByLabel('Terminal output').press('Control+f');

		const searchInput = window.getByPlaceholder('Search output... (Esc to close)');
		await searchInput.fill('terminal search sentinel');
		await expect(window.getByText('terminal search sentinel')).toBeVisible();

		await window.keyboard.press('Alt+Meta+ArrowRight');
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();
		await expect(searchInput).toBeVisible();
		await expect(searchInput).toHaveValue('terminal search sentinel');

		await window.keyboard.press('Alt+Meta+ArrowRight');
		await expect(window.locator('[data-tour="files-panel"]')).toBeVisible();
		await expect(searchInput).toBeVisible();
		await expect(searchInput).toHaveValue('terminal search sentinel');
	});

	test('preserves command terminal draft after canceling Quick Actions over output search', async () => {
		const terminalInput = await openSeededTerminalAgent(window);
		await terminalInput.fill('draft survives quick actions over search sentinel');
		await window.getByLabel('Terminal output').press('Control+f');

		const searchInput = window.getByPlaceholder('Search output... (Esc to close)');
		await searchInput.fill('terminal stderr');
		await expect(window.getByText('terminal stderr sentinel')).toBeVisible();

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('missing quick action sentinel');
		await closeQuickActions(window, quickActionsDialog);

		await expect(searchInput).toBeVisible();
		await expect(searchInput).toHaveValue('terminal stderr');
		await expect(terminalInput).toHaveValue('draft survives quick actions over search sentinel');
		await expect(window.getByText('terminal stderr sentinel')).toBeVisible();
	});

	test('keeps a command terminal local output filter while command history opens and closes', async () => {
		const terminalInput = await openSeededTerminalAgent(window);
		const outputBlock = window.locator('[data-log-index="2"]');

		await outputBlock.getByTitle('Filter this output').click();
		await outputBlock.getByPlaceholder('Include by keyword').fill('needle');
		await expect(outputBlock.getByText('terminal filter needle')).toBeVisible();
		await expect(outputBlock.getByText('terminal filter haystack')).toBeHidden();

		await terminalInput.focus();
		await terminalInput.press('ArrowUp');
		const historyFilter = window.getByPlaceholder('Filter commands...');
		await expect(historyFilter).toBeVisible();
		await historyFilter.press('Escape');

		await expect(historyFilter).toBeHidden();
		await expect(outputBlock.getByText('terminal filter needle')).toBeVisible();
		await expect(outputBlock.getByText('terminal filter haystack')).toBeHidden();
	});

	test('recovers command history results after clearing a draft-seeded filter', async () => {
		const terminalInput = await openSeededTerminalAgent(window);

		await terminalInput.fill('missing-history-command-sentinel');
		await terminalInput.press('ArrowUp');
		const historyFilter = window.getByPlaceholder('Filter commands...');
		await expect(historyFilter).toHaveValue('missing-history-command-sentinel');
		await expect(window.getByText('No matching commands')).toBeVisible();

		await historyFilter.fill('');

		await expect(
			window.getByRole('button', { name: 'echo terminal history sentinel' })
		).toBeVisible();
		await expect(window.getByRole('button', { name: 'npm test -- --runInBand' })).toBeVisible();
		await expect(window.getByRole('button', { name: 'git status --short' })).toBeVisible();
		await historyFilter.press('Enter');
		await expect(terminalInput).toHaveValue('echo terminal history sentinel');
	});

	test('runs a mouse-selected command history entry from the terminal run control', async () => {
		await stubTerminalRunCommand(electronApp);
		const terminalInput = await openSeededTerminalAgent(window);
		const inputArea = window.locator('[data-tour="input-area"]');

		await terminalInput.focus();
		await terminalInput.press('ArrowUp');
		const historyFilter = window.getByPlaceholder('Filter commands...');
		await historyFilter.fill('status');
		await window.getByRole('button', { name: 'git status --short' }).click();
		await inputArea.getByTitle('Run command (Enter)').click();

		await expect(terminalInput).toHaveValue('');
		await expect(
			(await getStubbedTerminalRunCommandCalls(electronApp)).map((call) => call.command)
		).toEqual(['git status --short']);
	});

	test('keeps shell command history available after whitespace clear command', async () => {
		await stubTerminalRunCommand(electronApp);
		const terminalInput = await openSeededTerminalAgent(window);
		const inputArea = window.locator('[data-tour="input-area"]');

		await terminalInput.fill('  clear  ');
		await inputArea.getByTitle('Run command (Enter)').click();
		await expect(window.locator('[data-log-index]')).toHaveCount(0);
		await expect(await getStubbedTerminalRunCommandCalls(electronApp)).toEqual([]);

		await terminalInput.focus();
		await terminalInput.press('ArrowUp');
		const historyFilter = window.getByPlaceholder('Filter commands...');

		await expect(historyFilter).toBeVisible();
		await expect(
			window.getByRole('button', { name: 'echo terminal history sentinel' })
		).toBeVisible();
	});

	test('preserves command terminal cwd after whitespace clear command', async () => {
		await stubTerminalRunCommand(electronApp);
		const terminalInput = await openSeededTerminalAgent(window);
		const inputArea = window.locator('[data-tour="input-area"]');
		const originalCwd = seededWorkbench.sessions[1].cwd;
		const expectedCwd = path.join(originalCwd, 'Auto Run Docs');

		await terminalInput.fill('cd "Auto Run Docs"');
		await inputArea.getByTitle('Run command (Enter)').click();
		await expect(inputArea.getByText(/Auto Run Docs/)).toBeVisible();

		await terminalInput.fill('  clear  ');
		await inputArea.getByTitle('Run command (Enter)').click();
		await expect(window.locator('[data-log-index]')).toHaveCount(0);

		await terminalInput.fill('pwd');
		await inputArea.getByTitle('Run command (Enter)').click();

		await expect(window.locator('[data-log-index]').last().getByText(expectedCwd)).toBeVisible();
		const calls = await getStubbedTerminalRunCommandCalls(electronApp);
		await expect(calls.map((call) => call.command)).toEqual(['cd "Auto Run Docs"', 'pwd']);
		await expect(calls[0].cwd).toBe(originalCwd);
		await expect(calls[1].cwd).toBe(expectedCwd);
	});

	test('runs pwd after closing command terminal output search without changing cwd', async () => {
		await stubTerminalRunCommand(electronApp);
		const terminalInput = await openSeededTerminalAgent(window);
		const originalCwd = seededWorkbench.sessions[1].cwd;

		await window.getByLabel('Terminal output').press('Control+f');
		const searchInput = window.getByPlaceholder('Search output... (Esc to close)');
		await searchInput.fill('stderr sentinel');
		await expect(window.getByText('terminal stderr sentinel')).toBeVisible();
		await searchInput.press('Escape');

		await terminalInput.fill('pwd');
		await terminalInput.press('Enter');

		await expect(window.locator('[data-log-index]').last().getByText(originalCwd)).toBeVisible();
		const calls = await getStubbedTerminalRunCommandCalls(electronApp);
		await expect(calls).toHaveLength(1);
		await expect(calls[0]).toMatchObject({ command: 'pwd', cwd: originalCwd });
	});

	test('keeps terminal focus shortcuts usable after command history cancellation', async () => {
		const terminalInput = await openSeededTerminalAgent(window);
		const terminalOutput = window.getByLabel('Terminal output');

		await terminalInput.fill('draft before history focus sentinel');
		await terminalInput.press('ArrowUp');
		const historyFilter = window.getByPlaceholder('Filter commands...');
		await historyFilter.fill('status');
		await historyFilter.press('Escape');

		await expect(historyFilter).toBeHidden();
		await expect(terminalInput).toBeFocused();
		await expect(terminalInput).toHaveValue('draft before history focus sentinel');

		await terminalInput.press('Escape');
		await expect(terminalOutput).toBeFocused();
	});

	test('opens command terminal output search from a history-selected draft', async () => {
		const terminalInput = await openSeededTerminalAgent(window);

		await terminalInput.focus();
		await terminalInput.press('ArrowUp');
		const historyFilter = window.getByPlaceholder('Filter commands...');
		await historyFilter.fill('npm');
		await historyFilter.press('Enter');
		await expect(terminalInput).toHaveValue('npm test -- --runInBand');

		await terminalInput.press('Control+f');
		const searchInput = window.getByPlaceholder('Search output... (Esc to close)');

		await expect(searchInput).toBeFocused();
		await expect(terminalInput).toHaveValue('npm test -- --runInBand');
	});

	test('closes command terminal Tab Switcher search with Escape while preserving the draft', async () => {
		const terminalInput = await openSeededTerminalAgent(window);
		await terminalInput.fill('draft before terminal tab switcher sentinel');

		await window.keyboard.press('Alt+Meta+T');
		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		const searchInput = switcher.getByPlaceholder('Search open tabs...');
		await searchInput.fill('missing terminal tab sentinel');
		await expect(switcher.getByText('No open tabs')).toBeVisible();
		await searchInput.press('Escape');

		await expect(switcher).toBeHidden();
		await expect(window.getByLabel('Terminal output')).toBeVisible();
		await expect(terminalInput).toHaveValue('draft before terminal tab switcher sentinel');
	});

	test('recovers command terminal Tab Switcher results after an unmatched search', async () => {
		await openSeededTerminalAgent(window);

		await window.keyboard.press('Alt+Meta+T');
		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		const searchInput = switcher.getByPlaceholder('Search open tabs...');
		await searchInput.fill('missing terminal tab sentinel');
		await expect(switcher.getByText('No open tabs')).toBeVisible();

		await searchInput.fill('Terminal');
		await switcher.getByRole('button', { name: /Terminal/ }).click();

		await expect(switcher).toBeHidden();
		await expect(window.getByLabel('Terminal output')).toBeVisible();
	});

	test('cycles command terminal Tab Switcher modes back to open tabs', async () => {
		await openSeededTerminalAgent(window);

		await window.keyboard.press('Alt+Meta+T');
		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		await expect(switcher.getByRole('button', { name: /Open Tabs \(1\)/ })).toBeVisible();

		await switcher.getByPlaceholder('Search open tabs...').press('Tab');
		await expect(switcher.getByPlaceholder('Search named sessions...')).toBeFocused();
		await switcher.getByPlaceholder('Search named sessions...').press('Shift+Tab');

		await expect(switcher.getByPlaceholder('Search open tabs...')).toBeFocused();
		await expect(switcher.getByRole('button', { name: /Terminal/ })).toBeVisible();
	});

	test('opens command terminal Tab Switcher from Quick Actions without clearing the draft', async () => {
		const terminalInput = await openSeededTerminalAgent(window);
		await terminalInput.fill('draft before quick tab switcher sentinel');

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Tab Switcher');
		await quickActionsDialog.getByRole('button', { name: /Tab Switcher/ }).click();

		await expect(quickActionsDialog).toBeHidden();
		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		await expect(switcher).toBeVisible();
		await switcher.getByPlaceholder('Search open tabs...').press('Escape');

		await expect(switcher).toBeHidden();
		await expect(window.getByLabel('Terminal output')).toBeVisible();
		await expect(terminalInput).toHaveValue('draft before quick tab switcher sentinel');
	});

	test('renders seeded Codex AI terminal transcript and input controls', async () => {
		const promptInput = await openSeededCodexAiTerminal(window);

		await expect(window.getByText('AI Terminal')).toBeVisible();
		await expect(promptInput).toHaveAttribute(
			'placeholder',
			'Talking to E2E Workbench powered by Codex'
		);
		await expect(window.getByTitle(/Open Prompt Composer/)).toBeVisible();
		await expect(window.getByTitle('Attach Image')).toBeVisible();
		await expect(window.getByTitle(/Save to History/)).toBeVisible();
		await expect(
			window.getByTitle("Toggle Read-Only mode (agent won't modify files)")
		).toBeVisible();
		await expect(window.getByTitle('Show Thinking - Click to stream AI reasoning')).toBeVisible();
		await expect(window.getByTitle(/Toggle Mode/)).toBeVisible();
		await expect(window.getByTitle('Send message')).toBeVisible();
	});

	test('edits a Codex prompt draft without sending a live prompt', async () => {
		const promptInput = await openSeededCodexAiTerminal(window);

		await expect(window.locator('[data-log-index]')).toHaveCount(3);
		await promptInput.fill('Draft Codex prompt line one\nDraft Codex prompt line two');
		await expect(promptInput).toHaveValue(
			'Draft Codex prompt line one\nDraft Codex prompt line two'
		);
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();
		await expect(window.locator('[data-log-index]')).toHaveCount(3);
	});

	test('does not dispatch empty Codex prompts to the process layer', async () => {
		await stubCodexProcessSpawn(electronApp);
		const promptInput = await openSeededCodexAiTerminal(window);

		await expect(promptInput).toHaveValue('');
		await window.getByTitle('Send message').click();

		await expect(promptInput).toHaveValue('');
		await expect(window.locator('[data-log-index]')).toHaveCount(3);
		await expect
			.poll(async () => (await getStubbedCodexProcessSpawnCalls(electronApp)).length)
			.toBe(0);
	});

	test('dispatches a Codex prompt through the stubbed spawn path', async () => {
		await stubCodexProcessSpawn(electronApp);
		const promptInput = await openSeededCodexAiTerminal(window);

		await promptInput.fill('Codex stubbed safe send sentinel');
		await window.getByTitle('Send message').click();

		await expect(window.getByText('Codex stubbed safe send sentinel')).toBeVisible();
		await expect(promptInput).toHaveValue('');
		await expect
			.poll(async () => (await getStubbedCodexProcessSpawnCalls(electronApp)).length)
			.toBe(1);
		const calls = await getStubbedCodexProcessSpawnCalls(electronApp);
		await expect(calls).toHaveLength(1);
		await expect(calls[0].toolType).toBe('codex');
		await expect(calls[0].prompt).toContain('Codex stubbed safe send sentinel');
	});

	test('passes Codex read-only mode through the stubbed spawn path', async () => {
		await stubCodexProcessSpawn(electronApp);
		const promptInput = await openSeededCodexAiTerminal(window);

		await window.getByTitle("Toggle Read-Only mode (agent won't modify files)").click();
		await promptInput.fill('Codex read-only spawn sentinel');
		await window.getByTitle('Send message').click();

		await expect(promptInput).toHaveValue('');
		await expect
			.poll(async () => (await getStubbedCodexProcessSpawnCalls(electronApp)).length)
			.toBe(1);
		const calls = await getStubbedCodexProcessSpawnCalls(electronApp);
		await expect(calls).toHaveLength(1);
		await expect(calls[0].toolType).toBe('codex');
		await expect(calls[0].readOnlyMode).toBe(true);
		await expect(calls[0].prompt).toContain('Codex read-only spawn sentinel');
	});

	test('interrupts an in-flight Codex prompt through the Stop control', async () => {
		await stubCodexProcessSpawn(electronApp, { exitDelayMs: 10_000 });
		await stubProcessInterrupt(electronApp);
		const promptInput = await openSeededCodexAiTerminal(window);

		await promptInput.fill('Codex interrupt in-flight sentinel');
		await window.getByTitle('Send message').click();
		await expect
			.poll(async () => (await getStubbedCodexProcessSpawnCalls(electronApp)).length)
			.toBe(1);

		await window.getByRole('button', { name: 'Stop' }).click();

		const session = seededWorkbench.sessions[0]!;
		const activeTab = session.aiTabs[0]!;
		await expect
			.poll(async () => getStubbedProcessInterruptCalls(electronApp))
			.toEqual([`${session.id}-ai-${activeTab.id}`]);
		await expect(window.getByText('Canceled by user')).toBeVisible();
	});

	test('cycles Codex thinking display toggle states without sending', async () => {
		await openSeededCodexAiTerminal(window);

		await window.getByTitle('Show Thinking - Click to stream AI reasoning').click();
		await expect(window.getByTitle('Thinking (temporary) - Click for sticky mode')).toBeVisible();

		await window.getByTitle('Thinking (temporary) - Click for sticky mode').click();
		await expect(window.getByTitle('Thinking (sticky) - Click to turn off')).toBeVisible();

		await window.getByTitle('Thinking (sticky) - Click to turn off').click();
		await expect(window.getByTitle('Show Thinking - Click to stream AI reasoning')).toBeVisible();
	});

	test('toggles Codex history and read-only controls without sending', async () => {
		const promptInput = await openSeededCodexAiTerminal(window);
		await promptInput.fill('Draft remains local while toggles change');

		const historyToggle = window.getByTitle(/Save to History/);
		await expect(historyToggle).toBeVisible();
		await historyToggle.click();
		await expect(promptInput).toHaveValue('Draft remains local while toggles change');

		const readOnlyToggle = window.getByTitle("Toggle Read-Only mode (agent won't modify files)");
		await expect(readOnlyToggle).toBeVisible();
		await readOnlyToggle.click();
		await expect(window.getByText('Read-Only')).toBeVisible();
		await expect(promptInput).toHaveValue('Draft remains local while toggles change');
	});

	test('stages deduplicates and removes a Codex image attachment without sending', async () => {
		await openSeededCodexAiTerminal(window);

		const imagePath = path.join(seededWorkbench.sessions[0].cwd, 'diagram.png');
		const imageInput = window.locator('#image-file-input');
		await imageInput.setInputFiles(imagePath);
		await expect(window.getByAltText('Staged image 1')).toBeVisible();

		await imageInput.setInputFiles(imagePath);
		await expect(window.getByAltText('Staged image 1')).toHaveCount(1);
		await expect(window.getByText('Duplicate image ignored')).toBeVisible();

		const stagedImageContainer = window
			.getByAltText('Staged image 1')
			.locator('xpath=ancestor::div[contains(@class, "relative")][1]');
		await stagedImageContainer.locator('button').last().click();
		await expect(window.getByAltText('Staged image 1')).toBeHidden();
	});

	test('filters and completes Codex slash commands without sending', async () => {
		const promptInput = await openSeededCodexAiTerminal(window);

		await promptInput.fill('/');
		await expect(
			window.getByRole('button', { name: /\/history Generate a synopsis/ })
		).toBeVisible();
		await expect(
			window.getByRole('button', { name: /\/wizard Start the planning wizard/ })
		).toBeVisible();
		await expect(window.getByRole('button', { name: /\/skills/ })).toHaveCount(0);

		await promptInput.press('ArrowDown');
		await promptInput.press('Tab');
		await expect(promptInput).toHaveValue('/wizard');
		await expect(window.getByRole('button', { name: /\/history/ })).toHaveCount(0);
		await expect(window.locator('[data-log-index]')).toHaveCount(3);
	});

	test('inserts a Codex @mention from file suggestions without sending', async () => {
		const promptInput = await openSeededCodexAiTerminal(window);

		await promptInput.fill('Please inspect @REA');
		await expect(window.getByText('Files matching "REA"')).toBeVisible();
		const fileSuggestions = window
			.getByText('Files matching "REA"')
			.locator('xpath=ancestor::div[contains(@class, "absolute")][1]');
		const readmeSuggestion = fileSuggestions.getByRole('button', { name: 'README.md file' });
		await expect(readmeSuggestion).toBeVisible();

		await readmeSuggestion.click();
		await expect(promptInput).toHaveValue('Please inspect @README.md ');
		await expect(window.getByText('Files matching "REA"')).toBeHidden();
		await expect(window.locator('[data-log-index]')).toHaveCount(3);
	});

	test('dismisses Codex @mention suggestions while preserving the draft', async () => {
		const promptInput = await openSeededCodexAiTerminal(window);

		await promptInput.fill('Keep this draft @NOT');
		await expect(window.getByText('Files matching "NOT"')).toBeVisible();
		const fileSuggestions = window
			.getByText('Files matching "NOT"')
			.locator('xpath=ancestor::div[contains(@class, "absolute")][1]');
		await expect(fileSuggestions.getByRole('button', { name: 'NOTES.md file' })).toBeVisible();

		await promptInput.press('Escape');
		await expect(window.getByText('Files matching "NOT"')).toBeHidden();
		await expect(promptInput).toHaveValue('Keep this draft @NOT');
	});

	test('toggles Codex Enter-to-send mode without dispatching a draft', async () => {
		const promptInput = await openSeededCodexAiTerminal(window);
		await promptInput.fill('Draft should remain local through Enter mode changes');

		const enterToggle = window.getByTitle('Switch to Enter to send');
		await expect(enterToggle).toBeVisible();
		await enterToggle.click();
		await expect(window.getByTitle('Switch to Cmd+Enter to send')).toBeVisible();
		await expect(promptInput).toHaveValue('Draft should remain local through Enter mode changes');
		await expect(window.locator('[data-log-index]')).toHaveCount(3);
	});

	test('switches Codex input between AI and terminal modes without sending', async () => {
		await openSeededCodexAiTerminal(window);

		await window.getByTitle(/Toggle Mode/).click();
		const terminalInput = window.getByPlaceholder('Run shell command...');
		await expect(terminalInput).toBeVisible();
		await expect(window.getByTitle('Run command (Enter)')).toBeVisible();

		await window.getByTitle(/Toggle Mode/).click();
		await expect(
			window.getByPlaceholder(/Talking to E2E Workbench powered by Codex/)
		).toBeVisible();
		await expect(window.getByTitle('Send message')).toBeVisible();
	});

	test('filters Codex AI transcript output from the input shortcut', async () => {
		const promptInput = await openSeededCodexAiTerminal(window);

		await promptInput.focus();
		await promptInput.press('Control+f');
		const outputFilter = window.getByPlaceholder('Filter output... (Esc to close)');
		await expect(outputFilter).toBeVisible();

		await outputFilter.fill('seeded response');
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();

		await outputFilter.fill('not-present-in-transcript');
		await expect(window.getByText('Codex seeded response is visible.')).toBeHidden();

		await outputFilter.press('Escape');
		await expect(outputFilter).toBeHidden();
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();
	});

	test('toggles Codex AI response between formatted and plain markdown', async () => {
		await openSeededCodexAiTerminal(window);

		const responseBlock = window.locator('[data-log-index="0"]');
		await responseBlock.hover();
		await responseBlock.getByTitle(/Show plain text/).click();
		await expect(responseBlock.getByTitle(/Show formatted/)).toBeVisible();
		await expect(responseBlock.getByText('# AI Terminal')).toBeVisible();

		await responseBlock.getByTitle(/Show formatted/).click();
		await expect(responseBlock.getByTitle(/Show plain text/)).toBeVisible();
		await expect(responseBlock.getByText('AI Terminal')).toBeVisible();
	});

	test('copies a Codex AI response from transcript actions', async () => {
		await openSeededCodexAiTerminal(window);

		const responseBlock = window.locator('[data-log-index="0"]');
		await responseBlock.hover();
		await responseBlock.getByTitle('Copy to clipboard').click();

		await expect(window.getByText('Copied to Clipboard')).toBeVisible();
	});

	test('saves a Codex AI response to markdown from transcript actions', async () => {
		await openSeededCodexAiTerminal(window);

		const responseBlock = window.locator('[data-log-index="0"]');
		await responseBlock.hover();
		await responseBlock.getByTitle('Save to file').click();

		const saveDialog = window.getByRole('dialog', { name: 'Save Markdown' });
		await expect(saveDialog).toBeVisible();
		await expect(saveDialog.getByPlaceholder('/path/to/folder')).toHaveValue(
			seededWorkbench.sessions[0].cwd
		);

		await saveDialog.getByPlaceholder('document.md').fill('codex-response-e2e');
		await saveDialog.getByRole('button', { name: 'Save' }).click();
		await expect(saveDialog).toBeHidden();

		const savedPath = path.join(seededWorkbench.sessions[0].cwd, 'codex-response-e2e.md');
		await expect.poll(() => fs.existsSync(savedPath)).toBe(true);
		expect(fs.readFileSync(savedPath, 'utf-8')).toContain('Codex seeded response is visible.');
	});

	test('shows delivered Codex user-message transcript actions without replaying', async () => {
		await openSeededCodexAiTerminal(window);

		const userBlock = window.locator('[data-log-index="1"]');
		await expect(
			userBlock.getByText('Review README for Codex user-message action coverage')
		).toBeVisible();

		await userBlock.hover();
		await expect(userBlock.getByTitle('Message delivered')).toBeVisible();
		await expect(userBlock.getByTitle('Replay message')).toBeVisible();
		await expect(userBlock.getByTitle('Delete message and response')).toBeVisible();
		await expect(window.locator('[data-log-index]')).toHaveCount(3);
	});

	test('replays a delivered Codex message through the stubbed spawn path', async () => {
		await stubCodexProcessSpawn(electronApp);
		const promptInput = await openSeededCodexAiTerminal(window);
		await promptInput.fill('Preserve draft while replaying sentinel');

		const userBlock = window.locator('[data-log-index="1"]');
		await userBlock.hover();
		await userBlock.getByTitle('Replay message').click();

		await expect
			.poll(async () => (await getStubbedCodexProcessSpawnCalls(electronApp)).length)
			.toBe(1);
		const calls = await getStubbedCodexProcessSpawnCalls(electronApp);
		await expect(calls).toHaveLength(1);
		await expect(calls[0].toolType).toBe('codex');
		await expect(calls[0].prompt).toContain('Review README for Codex user-message action coverage');
		await expect(promptInput).toHaveValue('Preserve draft while replaying sentinel');
	});

	test('cancels Codex user-message paired deletion from transcript actions', async () => {
		await openSeededCodexAiTerminal(window);

		const userBlock = window.locator('[data-log-index="1"]');
		await userBlock.hover();
		await userBlock.getByTitle('Delete message and response').click();
		await expect(userBlock.getByText('Delete?')).toBeVisible();

		await userBlock.getByRole('button', { name: 'No' }).click();
		await expect(userBlock.getByText('Delete?')).toBeHidden();
		await expect(
			window.getByText('Review README for Codex user-message action coverage')
		).toBeVisible();
		await expect(
			window.getByText('Codex paired response for user-message action coverage.')
		).toBeVisible();
		await expect(window.locator('[data-log-index]')).toHaveCount(3);
	});

	test('deletes a Codex user message and paired response from transcript actions', async () => {
		await openSeededCodexAiTerminal(window);

		const userBlock = window.locator('[data-log-index="1"]');
		await userBlock.hover();
		await userBlock.getByTitle('Delete message and response').click();
		await userBlock.getByRole('button', { name: 'Yes' }).click();

		await expect(
			window.getByText('Review README for Codex user-message action coverage')
		).toBeHidden();
		await expect(
			window.getByText('Codex paired response for user-message action coverage.')
		).toBeHidden();
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();
		await expect(window.locator('[data-log-index]')).toHaveCount(1);
	});

	test('switches between AI and file tabs in the TabBar', async () => {
		await window.getByText('Main', { exact: true }).click();
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();

		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('shows file tab hover actions from the TabBar overlay', async () => {
		const readmeTab = window.locator('[data-tab-id]').filter({ hasText: 'README' }).first();

		const overlay = await openTabHoverOverlay(window, readmeTab, 'Copy File Name');
		await expect(overlay.getByText('Copy File Name')).toBeVisible();
		await expect(overlay.getByText('Open in Default App')).toBeVisible();
		await expect(overlay.getByRole('button', { name: 'Close Tab', exact: true })).toBeVisible();

		await overlay.getByText('Copy File Name').click();
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

	test('moves file tabs from the TabBar hover overlay', async () => {
		const tabs = window.locator('[data-tab-id]');
		await expect(tabs.nth(0)).toContainText('Main');
		await expect(tabs.nth(1)).toContainText('README');

		const readmeTab = tabs.filter({ hasText: 'README' }).first();
		let overlay = await openTabHoverOverlay(window, readmeTab, 'Move to First Position');
		await overlay.getByRole('button', { name: 'Move to First Position' }).click();
		await expect(tabs.nth(0)).toContainText('README');
		await expect(tabs.nth(1)).toContainText('Main');

		overlay = await openTabHoverOverlay(window, readmeTab, 'Move to Last Position');
		await overlay.getByRole('button', { name: 'Move to Last Position' }).click();
		await expect(tabs.nth(0)).toContainText('Main');
		await expect(tabs.nth(1)).toContainText('README');
	});

	test('moves AI tabs from the TabBar hover overlay', async () => {
		const tabs = window.locator('[data-tab-id]');
		await expect(tabs.nth(0)).toContainText('Main');
		await expect(tabs.nth(1)).toContainText('README');

		const mainTab = tabs.filter({ hasText: 'Main' }).first();
		let overlay = await openTabHoverOverlay(window, mainTab, 'Move to Last Position');
		await overlay.getByRole('button', { name: 'Move to Last Position' }).click();
		await expect(tabs.nth(0)).toContainText('README');
		await expect(tabs.nth(1)).toContainText('Main');

		overlay = await openTabHoverOverlay(window, mainTab, 'Move to First Position');
		await overlay.getByRole('button', { name: 'Move to First Position' }).click();
		await expect(tabs.nth(0)).toContainText('Main');
		await expect(tabs.nth(1)).toContainText('README');
	});

	test('closes tabs to the left from the TabBar hover overlay', async () => {
		const tabs = window.locator('[data-tab-id]');
		await expect(tabs).toHaveCount(2);

		const overlay = await openTabHoverOverlay(
			window,
			tabs.filter({ hasText: 'README' }).first(),
			'Close Tabs to Left'
		);
		await overlay.getByRole('button', { name: 'Close Tabs to Left' }).click();

		await expect(tabs).toHaveCount(2);
		await expect(tabs.first()).toContainText('README');
		await expect(tabs.nth(1)).toContainText('New Session');
		await expect(window.getByText('Main', { exact: true })).toBeHidden();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('closes tabs to the right from the TabBar hover overlay', async () => {
		const tabs = window.locator('[data-tab-id]');
		await expect(tabs).toHaveCount(2);
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		const overlay = await openTabHoverOverlay(
			window,
			tabs.filter({ hasText: 'Main' }).first(),
			'Close Tabs to Right'
		);
		await overlay.getByRole('button', { name: 'Close Tabs to Right' }).click();

		await expect(tabs).toHaveCount(1);
		await expect(tabs.first()).toContainText('Main');
		await expect(window.getByText('README', { exact: true })).toBeHidden();
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();
	});

	test('closes other tabs from an inactive AI TabBar hover overlay', async () => {
		const tabs = window.locator('[data-tab-id]');
		await expect(tabs).toHaveCount(2);
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		const overlay = await openTabHoverOverlay(
			window,
			tabs.filter({ hasText: 'Main' }).first(),
			'Close Other Tabs'
		);
		await overlay.getByRole('button', { name: 'Close Other Tabs' }).click();

		await expect(tabs).toHaveCount(1);
		await expect(tabs.first()).toContainText('Main');
		await expect(window.getByText('README', { exact: true })).toBeHidden();
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();
	});

	test('closes other tabs from the file TabBar hover overlay', async () => {
		const tabs = window.locator('[data-tab-id]');
		await expect(tabs).toHaveCount(2);

		const overlay = await openTabHoverOverlay(
			window,
			tabs.filter({ hasText: 'README' }).first(),
			'Close Other Tabs'
		);
		await overlay.getByRole('button', { name: 'Close Other Tabs' }).click();

		await expect(tabs).toHaveCount(2);
		await expect(tabs.first()).toContainText('README');
		await expect(tabs.nth(1)).toContainText('New Session');
		await expect(window.getByText('Main', { exact: true })).toBeHidden();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('shows AI tab hover session actions and toggles tab status', async () => {
		const mainTab = window.locator('[data-tab-id]').filter({ hasText: 'Main' }).first();

		const overlay = await openTabHoverOverlay(window, mainTab, 'Rename Tab');
		await expect(overlay.getByText('Copy Session ID')).toBeVisible();
		await expect(overlay.getByText('Star Session')).toBeVisible();
		await expect(overlay.getByText('Rename Tab')).toBeVisible();
		await expect(overlay.getByText('Mark as Unread')).toBeVisible();

		await overlay.getByText('Copy Session ID').click();
		await expect(overlay.getByText('Copied!')).toBeVisible();

		await overlay.getByText('Star Session').click();
		await expect(overlay.getByText('Unstar Session')).toBeVisible();

		await overlay.getByText('Mark as Unread').click();
		await expect(window.getByTitle('New messages')).toBeVisible();
	});

	test('toggles an AI tab star off from the TabBar hover overlay', async () => {
		const mainTab = window.locator('[data-tab-id]').filter({ hasText: 'Main' }).first();

		const overlay = await openTabHoverOverlay(window, mainTab, 'Rename Tab');
		await overlay.getByText('Star Session').click();
		await expect(overlay.getByText('Unstar Session')).toBeVisible();

		await overlay.getByText('Unstar Session').click();

		await window.getByTitle(/Search tabs/).click();
		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		await switcher.getByPlaceholder('Search open tabs...').press('Tab');
		await switcher.getByPlaceholder('Search named sessions...').press('Tab');
		await expect(switcher.getByText('No starred sessions')).toBeVisible();
	});

	test('toggles the active AI tab star from the keyboard and shows it in the Tab Switcher', async () => {
		await window.getByText('Main', { exact: true }).click();

		await window.keyboard.press('Meta+Shift+S');
		const mainTab = window.locator('[data-tab-id]').filter({ hasText: 'Main' }).first();
		const overlay = await openTabHoverOverlay(window, mainTab, 'Rename Tab');
		await expect(overlay.getByText('Unstar Session')).toBeVisible();

		await window.keyboard.press('Alt+Meta+T');
		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		await expect(switcher).toBeVisible();

		let searchInput = switcher.getByPlaceholder('Search open tabs...');
		await searchInput.press('Tab');
		searchInput = switcher.getByPlaceholder('Search named sessions...');
		await searchInput.press('Tab');

		await expect(switcher.getByPlaceholder('Search starred sessions...')).toBeFocused();
		await expect(switcher.getByRole('button', { name: /Main/ })).toBeVisible();
		await expect(switcher.getByText('1 starred')).toBeVisible();
	});

	test('renames the active AI tab from the global keyboard shortcut', async () => {
		await window.getByText('Main', { exact: true }).click();

		await window.keyboard.press('Meta+Shift+R');
		const renameDialog = window.getByRole('dialog', { name: 'Rename Tab' });
		await expect(renameDialog).toBeVisible();
		await renameDialog.locator('input').fill('Keyboard Main');
		await renameDialog.getByRole('button', { name: 'Rename' }).click();

		await expect(renameDialog).toBeHidden();
		await expect(
			window.locator('[data-tab-id]').filter({ hasText: 'Keyboard Main' }).first()
		).toBeVisible();
	});

	test('marks the active AI tab unread and toggles the unread filter from shortcuts', async () => {
		await window.getByText('Main', { exact: true }).click();

		await window.keyboard.press('Meta+Shift+U');
		await expect(window.getByTitle('New messages')).toBeVisible();

		await window.keyboard.press('Meta+U');
		await expect(window.getByTitle(/Showing unread only/)).toBeVisible();
		await expect(window.locator('[data-tab-id]').filter({ hasText: 'Main' }).first()).toBeVisible();
	});

	test('renames an AI tab from the TabBar hover overlay', async () => {
		const mainTab = window.locator('[data-tab-id]').filter({ hasText: 'Main' }).first();

		const overlay = await openTabHoverOverlay(window, mainTab, 'Rename Tab');
		await overlay.getByText('Rename Tab').click();

		const renameDialog = window.getByRole('dialog', { name: 'Rename Tab' });
		await expect(renameDialog).toBeVisible();
		await renameDialog.locator('input').fill('Renamed Main');
		await renameDialog.getByRole('button', { name: 'Rename' }).click();

		await expect(renameDialog).toBeHidden();
		await expect(
			window.locator('[data-tab-id]').filter({ hasText: 'Renamed Main' }).first()
		).toBeVisible();
	});

	test('cancels an AI tab rename from the TabBar hover overlay without changing the label', async () => {
		const mainTab = window.locator('[data-tab-id]').filter({ hasText: 'Main' }).first();

		const overlay = await openTabHoverOverlay(window, mainTab, 'Rename Tab');
		await overlay.getByText('Rename Tab').click();

		const renameDialog = window.getByRole('dialog', { name: 'Rename Tab' });
		await expect(renameDialog).toBeVisible();
		await renameDialog.locator('input').fill('Canceled Main');
		await renameDialog.locator('input').press('Escape');

		await expect(renameDialog).toBeHidden();
		await expect(mainTab).toContainText('Main');
		await expect(window.locator('[data-tab-id]').filter({ hasText: 'Canceled Main' })).toHaveCount(
			0
		);
	});

	test('creates and closes a new AI tab from the TabBar', async () => {
		const tabRows = window.locator('[data-tab-id]');
		await expect(tabRows.first()).toBeVisible();
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

	test('opens the Tab Switcher from the global shortcut and cycles its keyboard modes', async () => {
		await window.getByText('Main', { exact: true }).click();
		await window.keyboard.press('Alt+Meta+T');

		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		await expect(switcher).toBeVisible();
		await expect(switcher.getByRole('button', { name: /Open Tabs \(2\)/ })).toBeVisible();
		await expect(switcher.getByText('Tab / ⇧Tab to switch')).toBeVisible();

		let searchInput = switcher.getByPlaceholder('Search open tabs...');
		await searchInput.press('Tab');
		await expect(switcher.getByPlaceholder('Search named sessions...')).toBeVisible();

		searchInput = switcher.getByPlaceholder('Search named sessions...');
		await searchInput.press('Tab');
		await expect(switcher.getByPlaceholder('Search starred sessions...')).toBeVisible();
		await expect(switcher.getByText('No starred sessions')).toBeVisible();

		searchInput = switcher.getByPlaceholder('Search starred sessions...');
		await searchInput.press('Shift+Tab');
		await expect(switcher.getByPlaceholder('Search named sessions...')).toBeVisible();

		await switcher.getByPlaceholder('Search named sessions...').press('Escape');
		await expect(switcher).toBeHidden();
	});

	test('shows Tab Switcher empty results and selects a filtered tab from the keyboard', async () => {
		await window.getByText('Main', { exact: true }).click();
		await window.keyboard.press('Alt+Meta+T');

		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		const searchInput = switcher.getByPlaceholder('Search open tabs...');
		await searchInput.fill('missing tab sentinel');
		await expect(switcher.getByText('No open tabs')).toBeVisible();
		await expect(switcher.getByText('0 tabs')).toBeVisible();

		await searchInput.fill('readme');
		await expect(switcher.getByRole('button', { name: /README/ })).toBeVisible();
		await searchInput.press('Meta+1');

		await expect(switcher).toBeHidden();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('recovers a named-session Tab Switcher search after an empty result', async () => {
		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		await window.getByTitle(/Search tabs/).click();
		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		await switcher.getByPlaceholder('Search open tabs...').press('Tab');

		const namedSearch = switcher.getByPlaceholder('Search named sessions...');
		await namedSearch.fill('missing named session sentinel');
		await expect(switcher.getByText('No named sessions found')).toBeVisible();

		await namedSearch.fill('Main');
		await switcher.getByRole('button', { name: /Main/ }).click();

		await expect(switcher).toBeHidden();
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();
	});

	test('closes the Tab Switcher with Escape without changing the active tab', async () => {
		await window.getByText('Main', { exact: true }).click();
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();

		await window.getByTitle(/Search tabs/).click();
		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		await switcher.getByPlaceholder('Search open tabs...').fill('README');
		await expect(switcher.getByRole('button', { name: /README/ })).toBeVisible();

		await switcher.getByPlaceholder('Search open tabs...').press('Escape');

		await expect(switcher).toBeHidden();
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();
	});

	test('selects the AI tab from the Tab Switcher with a numeric shortcut', async () => {
		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		await window.getByTitle(/Search tabs/).click();
		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		await switcher.getByPlaceholder('Search open tabs...').fill('Main');
		await switcher.getByPlaceholder('Search open tabs...').press('Meta+1');

		await expect(switcher).toBeHidden();
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();
	});

	test('copies an inactive AI tab session id without switching away from the file tab', async () => {
		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		const mainTab = window.locator('[data-tab-id]').filter({ hasText: 'Main' }).first();
		const overlay = await openTabHoverOverlay(window, mainTab, 'Rename Tab');
		await overlay.getByText('Copy Session ID').click();

		await expect(overlay.getByText('Copied!')).toBeVisible();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('marks an inactive AI tab unread without switching away from the file tab', async () => {
		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		const mainTab = window.locator('[data-tab-id]').filter({ hasText: 'Main' }).first();
		const overlay = await openTabHoverOverlay(window, mainTab);
		await overlay.getByText('Mark as Unread').click();

		await expect(window.getByTitle('New messages')).toBeVisible();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('copies the active file tab name without closing the preview tab', async () => {
		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		const readmeTab = window.locator('[data-tab-id]').filter({ hasText: 'README' }).first();
		const overlay = await openTabHoverOverlay(window, readmeTab, 'Copy File Name');
		await overlay.getByText('Copy File Name').click();

		await expect(window.getByText('Copied!')).toBeVisible();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('copies the active file tab path without closing the preview tab', async () => {
		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		const readmeTab = window.locator('[data-tab-id]').filter({ hasText: 'README' }).first();
		const overlay = await openTabHoverOverlay(window, readmeTab, 'Open in Default App');
		await overlay.getByText('Copy File Path').click();

		await expect(window.getByText('Copied!')).toBeVisible();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('closes the active file tab from the TabBar hover overlay and selects the AI tab', async () => {
		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		const tabRows = window.locator('[data-tab-id]');
		const readmeTab = tabRows.filter({ hasText: 'README' }).first();
		const overlay = await openTabHoverOverlay(window, readmeTab, 'Close Tab');
		await overlay.getByRole('button', { name: 'Close Tab', exact: true }).click();

		await expect(tabRows).toHaveCount(1);
		await expect(tabRows.first()).toContainText('Main');
		await expect(window.getByText('File Preview Surface')).toBeHidden();
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();
	});

	test('updates file TabBar edge actions after moving a file tab to the first position', async () => {
		const tabRows = window.locator('[data-tab-id]');
		const readmeTab = tabRows.filter({ hasText: 'README' }).first();

		let overlay = await openTabHoverOverlay(window, readmeTab, 'Close Tabs to Right');
		await expect(overlay.getByRole('button', { name: 'Close Tabs to Right' })).toBeDisabled();
		await expect(overlay.getByRole('button', { name: 'Close Tabs to Left' })).toBeEnabled();

		await overlay.getByRole('button', { name: 'Move to First Position' }).click();
		await expect(tabRows.nth(0)).toContainText('README');

		overlay = await openTabHoverOverlay(window, readmeTab, 'Close Tabs to Left');
		await expect(overlay.getByRole('button', { name: 'Close Tabs to Left' })).toBeDisabled();
		await expect(overlay.getByRole('button', { name: 'Close Tabs to Right' })).toBeEnabled();
	});

	test('uses global tab shortcuts to create select close and reopen AI tabs', async () => {
		const tabRows = window.locator('[data-tab-id]');
		await window.getByText('Main', { exact: true }).click();
		await expect(tabRows).toHaveCount(2);

		await window.keyboard.press('Meta+T');
		await expect(tabRows).toHaveCount(3);
		await expect(tabRows.nth(2)).toContainText('New Session');

		await window.keyboard.press('Meta+1');
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();

		await window.keyboard.press('Meta+0');
		await expect(tabRows.nth(2)).toContainText('New Session');
		await expect(
			window.getByPlaceholder(/Talking to E2E Workbench powered by Codex/)
		).toBeVisible();

		await window.keyboard.press('Meta+W');
		await expect(tabRows).toHaveCount(2);
		await expect(tabRows.filter({ hasText: 'New Session' })).toHaveCount(0);

		await window.keyboard.press('Meta+Shift+T');
		await expect(tabRows).toHaveCount(3);
		await expect(tabRows.filter({ hasText: 'New Session' })).toBeVisible();
	});

	test('closes left-side unified tabs from Quick Actions while keeping the selected AI tab', async () => {
		const tabRows = window.locator('[data-tab-id]');
		await window.getByText('Main', { exact: true }).click();
		await window.keyboard.press('Meta+T');
		await expect(tabRows).toHaveCount(3);
		await expect(tabRows.nth(2)).toContainText('New Session');

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Close Tabs to Left');
		await quickActionsDialog.getByRole('button', { name: /Close Tabs to Left/ }).click();

		await expect(quickActionsDialog).toBeHidden();
		await expect(tabRows).toHaveCount(1);
		await expect(tabRows.first()).toContainText('New Session');
		await expect(tabRows.filter({ hasText: 'Main' })).toHaveCount(0);
		await expect(tabRows.filter({ hasText: 'README' })).toHaveCount(0);
	});

	test('cancels active AI tab rename from Quick Actions without changing the label', async () => {
		await window.getByText('Main', { exact: true }).click();

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Rename Tab');
		await quickActionsDialog.getByRole('button', { name: /Rename Tab/ }).click();

		const renameDialog = window.getByRole('dialog', { name: 'Rename Tab' });
		await expect(renameDialog).toBeVisible();
		await renameDialog.locator('input').fill('Quick Action Canceled Main');
		await renameDialog.locator('input').press('Escape');

		await expect(renameDialog).toBeHidden();
		await expect(window.locator('[data-tab-id]').filter({ hasText: 'Main' }).first()).toBeVisible();
		await expect(
			window.locator('[data-tab-id]').filter({ hasText: 'Quick Action Canceled Main' })
		).toHaveCount(0);
	});

	test('recovers starred Tab Switcher search results after an unmatched filter', async () => {
		await window.getByText('Main', { exact: true }).click();
		await window.keyboard.press('Meta+Shift+S');

		await window.keyboard.press('Alt+Meta+T');
		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		let searchInput = switcher.getByPlaceholder('Search open tabs...');
		await searchInput.press('Tab');
		searchInput = switcher.getByPlaceholder('Search named sessions...');
		await searchInput.press('Tab');

		const starredSearch = switcher.getByPlaceholder('Search starred sessions...');
		await expect(starredSearch).toBeFocused();
		await expect(switcher.getByRole('button', { name: /Main/ })).toBeVisible();

		await starredSearch.fill('missing starred tab sentinel');
		await expect(switcher.getByText('No starred sessions')).toBeVisible();

		await starredSearch.fill('Main');
		await switcher.getByRole('button', { name: /Main/ }).click();

		await expect(switcher).toBeHidden();
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();
	});

	test('closes the Tab Switcher after filtering from Quick Actions without changing tabs', async () => {
		await window.getByText('Main', { exact: true }).click();
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Tab Switcher');
		await quickActionsDialog.getByRole('button', { name: /Tab Switcher/ }).click();

		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		await switcher.getByPlaceholder('Search open tabs...').fill('README');
		await expect(switcher.getByRole('button', { name: /README/ })).toBeVisible();
		await switcher.getByPlaceholder('Search open tabs...').press('Escape');

		await expect(switcher).toBeHidden();
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();
	});

	test('closes right-side unified tabs from Quick Actions while keeping the selected AI tab', async () => {
		const tabRows = window.locator('[data-tab-id]');
		await window.getByText('Main', { exact: true }).click();
		await window.keyboard.press('Meta+T');
		await expect(tabRows).toHaveCount(3);

		await window.getByText('Main', { exact: true }).click();
		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Close Tabs to Right');
		await quickActionsDialog.getByRole('button', { name: /Close Tabs to Right/ }).click();

		await expect(quickActionsDialog).toBeHidden();
		await expect(tabRows).toHaveCount(1);
		await expect(tabRows.filter({ hasText: 'Main' })).toBeVisible();
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();
		await expect(tabRows.filter({ hasText: 'README' })).toHaveCount(0);
		await expect(tabRows.filter({ hasText: 'New Session' })).toHaveCount(0);
	});

	test('disables AI TabBar close actions when only one unified tab remains', async () => {
		const tabRows = window.locator('[data-tab-id]');
		await expect(tabRows).toHaveCount(2);

		let overlay = await openTabHoverOverlay(
			window,
			tabRows.filter({ hasText: 'Main' }).first(),
			'Close Tabs to Right'
		);
		await overlay.getByRole('button', { name: 'Close Tabs to Right' }).click();

		await expect(tabRows).toHaveCount(1);
		const mainTab = tabRows.filter({ hasText: 'Main' }).first();
		overlay = await openTabHoverOverlay(window, mainTab);
		await expect(overlay.getByRole('button', { name: 'Close Tab', exact: true })).toBeDisabled();
		await expect(overlay.getByRole('button', { name: 'Close Other Tabs' })).toBeDisabled();
		await expect(overlay.getByRole('button', { name: 'Close Tabs to Left' })).toBeDisabled();
		await expect(overlay.getByRole('button', { name: 'Close Tabs to Right' })).toBeDisabled();
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();
	});

	test('closes other unified tabs from Quick Actions while preserving the active AI tab', async () => {
		const tabRows = window.locator('[data-tab-id]');
		await window.getByText('Main', { exact: true }).click();
		await window.keyboard.press('Meta+T');
		await expect(tabRows).toHaveCount(3);

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Close Other Tabs');
		await quickActionsDialog.getByRole('button', { name: /Close Other Tabs/ }).click();

		await expect(quickActionsDialog).toBeHidden();
		await expect(tabRows).toHaveCount(1);
		await expect(tabRows.filter({ hasText: 'New Session' })).toBeVisible();
		await expect(tabRows.filter({ hasText: 'Main' })).toHaveCount(0);
		await expect(tabRows.filter({ hasText: 'README' })).toHaveCount(0);
	});

	test('closes all AI tabs from Quick Actions and keeps the file preview tab available', async () => {
		const tabRows = window.locator('[data-tab-id]');
		await window.getByText('Main', { exact: true }).click();
		await expect(tabRows).toHaveCount(2);

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Close All Tabs');
		await quickActionsDialog.getByRole('button', { name: /Close All Tabs/ }).click();

		await expect(quickActionsDialog).toBeHidden();
		await expect(tabRows).toHaveCount(2);
		await expect(tabRows.filter({ hasText: 'Main' })).toHaveCount(0);
		await expect(tabRows.filter({ hasText: 'New Session' })).toBeVisible();
		await expect(tabRows.filter({ hasText: 'README' })).toBeVisible();

		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('closes all AI tabs from the global shortcut and reopens the previous session tab', async () => {
		const tabRows = window.locator('[data-tab-id]');
		await window.getByText('Main', { exact: true }).click();

		await window.keyboard.press('Meta+Shift+W');
		await expect(tabRows.filter({ hasText: 'Main' })).toHaveCount(0);
		await expect(tabRows.filter({ hasText: 'New Session' })).toBeVisible();
		await expect(tabRows.filter({ hasText: 'README' })).toBeVisible();

		await window.keyboard.press('Meta+Shift+T');

		await expect(tabRows.filter({ hasText: 'Main' })).toBeVisible();
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();
	});

	test('keeps the active file preview selected after Quick Actions closes all AI tabs', async () => {
		const tabRows = window.locator('[data-tab-id]');
		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Close All Tabs');
		await quickActionsDialog.getByRole('button', { name: /Close All Tabs/ }).click();

		await expect(quickActionsDialog).toBeHidden();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
		await expect(tabRows.filter({ hasText: 'README' })).toBeVisible();
		await expect(tabRows.filter({ hasText: 'Main' })).toHaveCount(0);
		await expect(tabRows.filter({ hasText: 'New Session' })).toBeVisible();
	});

	test('routes file TabBar overlay shell actions through the preload IPC bridge', async () => {
		await stubShellPathHandlers(electronApp);
		const readmeTab = window.locator('[data-tab-id]').filter({ hasText: 'README' }).first();
		const expectedPath = seededWorkbench.sessions[0].filePreviewTabs[0].path;

		let overlay = await openTabHoverOverlay(window, readmeTab, 'Open in Default App');
		await overlay.getByText('Open in Default App').click();
		await expect
			.poll(() => getStubbedShellPathCalls(electronApp))
			.toEqual([
				{
					type: 'openPath',
					itemPath: expectedPath,
				},
			]);

		overlay = await openTabHoverOverlay(window, readmeTab, 'Open in Default App');
		await overlay
			.getByRole('button', {
				name: /Reveal in Finder|Show in Finder|Show in Folder|Show in File Explorer|Open Containing Folder/,
			})
			.click();
		await expect
			.poll(() => getStubbedShellPathCalls(electronApp))
			.toEqual([
				{
					type: 'openPath',
					itemPath: expectedPath,
				},
				{
					type: 'showItemInFolder',
					itemPath: expectedPath,
				},
			]);
	});

	test('selects a file tab from the Tab Switcher with keyboard navigation', async () => {
		await window.getByText('Main', { exact: true }).click();
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();

		await window.getByTitle(/Search tabs/).click();
		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		await expect(switcher).toBeVisible();

		const searchInput = switcher.getByPlaceholder('Search open tabs...');
		await expect(searchInput).toBeFocused();
		await searchInput.press('ArrowDown');
		await searchInput.press('Enter');

		await expect(switcher).toBeHidden();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
		await expect(
			window.locator('[data-tab-id]').filter({ hasText: 'README' }).first()
		).toBeVisible();
	});

	test('cycles Tab Switcher modes with Tab and Shift+Tab', async () => {
		await window.getByText('Main', { exact: true }).click();
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();

		await window.getByTitle(/Search tabs/).click();
		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		await expect(switcher).toBeVisible();

		let searchInput = switcher.getByPlaceholder('Search open tabs...');
		await expect(searchInput).toBeFocused();
		await searchInput.press('Tab');

		searchInput = switcher.getByPlaceholder('Search named sessions...');
		await expect(searchInput).toBeFocused();
		await searchInput.press('Tab');

		searchInput = switcher.getByPlaceholder('Search starred sessions...');
		await expect(searchInput).toBeFocused();
		await searchInput.press('Shift+Tab');

		searchInput = switcher.getByPlaceholder('Search named sessions...');
		await expect(searchInput).toBeFocused();
		await searchInput.press('Shift+Tab');

		await expect(switcher.getByPlaceholder('Search open tabs...')).toBeFocused();
		await expect(switcher).toBeVisible();
	});

	test('toggles the active AI tab unread filter off and restores file tabs', async () => {
		await window.getByText('Main', { exact: true }).click();

		await window.keyboard.press('Meta+Shift+U');
		await expect(window.getByTitle('New messages')).toBeVisible();

		await window.keyboard.press('Meta+U');
		await expect(window.getByTitle(/Showing unread only/)).toBeVisible();
		await expect(window.locator('[data-tab-id]').filter({ hasText: 'README' })).toHaveCount(0);

		await window.keyboard.press('Meta+U');
		await expect(window.getByTitle(/Filter unread tabs/)).toBeVisible();
		await expect(
			window.locator('[data-tab-id]').filter({ hasText: 'README' }).first()
		).toBeVisible();
	});

	test('toggles the active AI tab unread state off from the global shortcut', async () => {
		await window.getByText('Main', { exact: true }).click();

		await window.keyboard.press('Meta+Shift+U');
		await expect(window.getByTitle('New messages')).toBeVisible();

		await window.keyboard.press('Meta+Shift+U');
		await expect(window.getByTitle('New messages')).toHaveCount(0);
	});

	test('toggles the active AI tab star off from the keyboard shortcut', async () => {
		await window.getByText('Main', { exact: true }).click();

		await window.keyboard.press('Meta+Shift+S');
		await window.keyboard.press('Meta+Shift+S');

		await window.keyboard.press('Alt+Meta+T');
		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		await switcher.getByPlaceholder('Search open tabs...').press('Tab');
		await switcher.getByPlaceholder('Search named sessions...').press('Tab');

		await expect(switcher.getByPlaceholder('Search starred sessions...')).toBeFocused();
		await expect(switcher.getByText('No starred sessions')).toBeVisible();
	});

	test('renames the active AI tab from the keyboard with Enter', async () => {
		await window.getByText('Main', { exact: true }).click();

		await window.keyboard.press('Meta+Shift+R');
		const renameDialog = window.getByRole('dialog', { name: 'Rename Tab' });
		await expect(renameDialog).toBeVisible();

		const renameInput = renameDialog.locator('input');
		await renameInput.fill('Enter Renamed Main');
		await renameInput.press('Enter');

		await expect(renameDialog).toBeHidden();
		await expect(
			window.locator('[data-tab-id]').filter({ hasText: 'Enter Renamed Main' }).first()
		).toBeVisible();
	});

	test('reopens a file tab closed from the hover overlay with the global shortcut', async () => {
		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		const tabRows = window.locator('[data-tab-id]');
		const readmeTab = tabRows.filter({ hasText: 'README' }).first();
		const overlay = await openTabHoverOverlay(window, readmeTab, 'Close Tab');
		await overlay.getByRole('button', { name: 'Close Tab', exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeHidden();
		await expect(tabRows.filter({ hasText: 'README' })).toHaveCount(0);

		await window.keyboard.press('Meta+Shift+T');
		await expect(window.getByText('File Preview Surface')).toBeVisible();
		await expect(tabRows.filter({ hasText: 'README' }).first()).toBeVisible();
	});

	test('recovers open Tab Switcher results after clearing an unmatched query', async () => {
		await window.getByText('Main', { exact: true }).click();
		await window.keyboard.press('Alt+Meta+T');

		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		const searchInput = switcher.getByPlaceholder('Search open tabs...');
		await searchInput.fill('missing-open-tab-sentinel');
		await expect(switcher.getByText('No open tabs')).toBeVisible();

		await searchInput.fill('');
		await expect(switcher.getByRole('button', { name: /Main/ })).toBeVisible();
		await expect(switcher.getByRole('button', { name: /README/ })).toBeVisible();
	});

	test('returns from empty starred Tab Switcher mode to open-tab results', async () => {
		await window.getByText('Main', { exact: true }).click();
		await window.keyboard.press('Alt+Meta+T');

		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		await switcher.getByPlaceholder('Search open tabs...').press('Tab');
		await switcher.getByPlaceholder('Search named sessions...').press('Tab');
		await expect(switcher.getByText('No starred sessions')).toBeVisible();

		await switcher.getByPlaceholder('Search starred sessions...').press('Shift+Tab');
		await switcher.getByPlaceholder('Search named sessions...').press('Shift+Tab');
		await expect(switcher.getByPlaceholder('Search open tabs...')).toBeFocused();
		await expect(switcher.getByRole('button', { name: /Main/ })).toBeVisible();
		await expect(switcher.getByRole('button', { name: /README/ })).toBeVisible();
	});

	test('keeps the active file tab selected when canceling AI tab rename from hover overlay', async () => {
		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		const mainTab = window.locator('[data-tab-id]').filter({ hasText: 'Main' }).first();
		const overlay = await openTabHoverOverlay(window, mainTab, 'Rename Tab');
		await overlay.getByText('Rename Tab').click();

		const renameDialog = window.getByRole('dialog', { name: 'Rename Tab' });
		await renameDialog.locator('input').fill('Inactive Rename Canceled');
		await renameDialog.locator('input').press('Escape');

		await expect(renameDialog).toBeHidden();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
		await expect(
			window.locator('[data-tab-id]').filter({ hasText: 'Inactive Rename Canceled' })
		).toHaveCount(0);
	});

	test('copies an inactive file tab path without switching away from the AI tab', async () => {
		await window.getByText('Main', { exact: true }).click();
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();

		const readmeTab = window.locator('[data-tab-id]').filter({ hasText: 'README' }).first();
		const overlay = await openTabHoverOverlay(window, readmeTab, 'Open in Default App');
		await overlay.getByText('Copy File Path').click();

		await expect(window.getByText('Copied!')).toBeVisible();
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();
		await expect(window.getByText('File Preview Surface')).toBeHidden();
	});

	test('routes inactive file tab default-app action without switching away from AI', async () => {
		await stubShellPathHandlers(electronApp);
		await window.getByText('Main', { exact: true }).click();
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();

		const readmeTab = window.locator('[data-tab-id]').filter({ hasText: 'README' }).first();
		const expectedPath = seededWorkbench.sessions[0].filePreviewTabs[0].path;
		const overlay = await openTabHoverOverlay(window, readmeTab, 'Open in Default App');
		await overlay.getByText('Open in Default App').click();

		await expect
			.poll(() => getStubbedShellPathCalls(electronApp))
			.toEqual([{ type: 'openPath', itemPath: expectedPath }]);
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();
	});

	test('keeps the AI tab selected after moving an inactive file tab first', async () => {
		await window.getByText('Main', { exact: true }).click();
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();

		const tabs = window.locator('[data-tab-id]');
		const readmeTab = tabs.filter({ hasText: 'README' }).first();
		const overlay = await openTabHoverOverlay(window, readmeTab, 'Move to First Position');
		await overlay.getByRole('button', { name: 'Move to First Position' }).click();

		await expect(tabs.nth(0)).toContainText('README');
		await expect(tabs.nth(1)).toContainText('Main');
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();
	});

	test('selects a starred inactive AI tab from Tab Switcher while file preview is active', async () => {
		await window.getByText('Main', { exact: true }).click();
		await window.keyboard.press('Meta+Shift+S');
		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		await window.keyboard.press('Alt+Meta+T');
		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		await switcher.getByPlaceholder('Search open tabs...').press('Tab');
		await switcher.getByPlaceholder('Search named sessions...').press('Tab');
		await switcher.getByRole('button', { name: /Main/ }).click();

		await expect(switcher).toBeHidden();
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();
	});

	test('closes starred Tab Switcher search with Escape while preserving file preview', async () => {
		await window.getByText('Main', { exact: true }).click();
		await window.keyboard.press('Meta+Shift+S');
		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		await window.keyboard.press('Alt+Meta+T');
		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		await switcher.getByPlaceholder('Search open tabs...').press('Tab');
		await switcher.getByPlaceholder('Search named sessions...').press('Tab');
		const starredSearch = switcher.getByPlaceholder('Search starred sessions...');
		await starredSearch.fill('Main');
		await expect(switcher.getByRole('button', { name: /Main/ })).toBeVisible();

		await starredSearch.press('Escape');

		await expect(switcher).toBeHidden();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('applies and clears unread filtering for an inactive AI tab', async () => {
		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		const mainTab = window.locator('[data-tab-id]').filter({ hasText: 'Main' }).first();
		const overlay = await openTabHoverOverlay(window, mainTab, 'Mark as Unread');
		await overlay.getByText('Mark as Unread').click();

		await window.keyboard.press('Meta+U');
		await expect(window.getByTitle(/Showing unread only/)).toBeVisible();
		await expect(mainTab).toBeVisible();
		await expect(
			window.locator('[data-tab-id]').filter({ hasText: 'README' }).first()
		).toBeVisible();

		await window.keyboard.press('Meta+U');
		await expect(window.getByTitle(/Filter unread tabs/)).toBeVisible();
		await expect(
			window.locator('[data-tab-id]').filter({ hasText: 'README' }).first()
		).toBeVisible();
	});

	test('reopens an AI tab after Quick Actions closes all AI tabs from file preview', async () => {
		const tabRows = window.locator('[data-tab-id]');
		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Close All Tabs');
		await quickActionsDialog.getByRole('button', { name: /Close All Tabs/ }).click();
		await expect(tabRows.filter({ hasText: 'Main' })).toHaveCount(0);

		await window.keyboard.press('Meta+Shift+T');

		await expect(tabRows.filter({ hasText: 'Main' }).first()).toBeVisible();
		await expect(tabRows.filter({ hasText: 'README' }).first()).toBeVisible();
		await tabRows.filter({ hasText: 'Main' }).first().click();
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();
	});

	test('finds a renamed AI tab from the open Tab Switcher search', async () => {
		const tabRows = window.locator('[data-tab-id]');
		await window.getByText('Main', { exact: true }).click();

		await window.keyboard.press('Meta+Shift+R');
		const renameDialog = window.getByRole('dialog', { name: 'Rename Tab' });
		await renameDialog.locator('input').fill('Review Thread');
		await renameDialog.locator('input').press('Enter');
		await expect(tabRows.filter({ hasText: 'Review Thread' }).first()).toBeVisible();

		await window.keyboard.press('Alt+Meta+T');
		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		await switcher.getByPlaceholder('Search open tabs...').fill('Review Thread');
		await switcher.getByRole('button', { name: /Review Thread/ }).click();

		await expect(switcher).toBeHidden();
		await expect(tabRows.filter({ hasText: 'Review Thread' }).first()).toBeVisible();
		await expect(
			window.getByPlaceholder(/Talking to E2E Workbench powered by Codex/)
		).toBeVisible();
	});

	test('cancels active AI tab rename from the global shortcut with Escape', async () => {
		await window.getByText('Main', { exact: true }).click();

		await window.keyboard.press('Meta+Shift+R');
		const renameDialog = window.getByRole('dialog', { name: 'Rename Tab' });
		await renameDialog.locator('input').fill('Escape Canceled Main');
		await renameDialog.locator('input').press('Escape');

		await expect(renameDialog).toBeHidden();
		await expect(window.locator('[data-tab-id]').filter({ hasText: 'Main' }).first()).toBeVisible();
		await expect(
			window.locator('[data-tab-id]').filter({ hasText: 'Escape Canceled Main' })
		).toHaveCount(0);
	});

	test('cancels active AI tab rename from the global shortcut with the cancel button', async () => {
		await window.getByText('Main', { exact: true }).click();

		await window.keyboard.press('Meta+Shift+R');
		const renameDialog = window.getByRole('dialog', { name: 'Rename Tab' });
		await renameDialog.locator('input').fill('Button Canceled Main');
		await renameDialog.getByRole('button', { name: 'Cancel' }).click();

		await expect(renameDialog).toBeHidden();
		await expect(window.locator('[data-tab-id]').filter({ hasText: 'Main' }).first()).toBeVisible();
		await expect(
			window.locator('[data-tab-id]').filter({ hasText: 'Button Canceled Main' })
		).toHaveCount(0);
	});

	test('creates a new AI tab from the global shortcut while file preview is active', async () => {
		const tabRows = window.locator('[data-tab-id]');
		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		await window.keyboard.press('Meta+T');

		await expect(tabRows.filter({ hasText: 'New Session' }).first()).toBeVisible();
		await expect(tabRows.filter({ hasText: 'README' }).first()).toBeVisible();
		await expect(
			window.getByPlaceholder(/Talking to E2E Workbench powered by Codex/)
		).toBeVisible();
	});

	test('closes a new AI tab from the global shortcut while keeping the file tab available', async () => {
		const tabRows = window.locator('[data-tab-id]');
		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		await window.keyboard.press('Meta+T');
		await expect(tabRows.filter({ hasText: 'New Session' }).first()).toBeVisible();
		await window.keyboard.press('Meta+W');

		await expect(tabRows.filter({ hasText: 'New Session' })).toHaveCount(0);
		await expect(tabRows.filter({ hasText: 'README' }).first()).toBeVisible();
		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('closes named-session Tab Switcher no-match search with Escape while preserving file preview', async () => {
		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		await window.keyboard.press('Alt+Meta+T');
		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		await switcher.getByPlaceholder('Search open tabs...').press('Tab');
		const namedSearch = switcher.getByPlaceholder('Search named sessions...');
		await namedSearch.fill('missing-named-session-escape-sentinel');
		await expect(switcher.getByText('No named sessions found')).toBeVisible();

		await namedSearch.press('Escape');

		await expect(switcher).toBeHidden();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('moves an inactive AI tab last without switching away from the file preview', async () => {
		const tabRows = window.locator('[data-tab-id]');
		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		const mainTab = tabRows.filter({ hasText: 'Main' }).first();
		const overlay = await openTabHoverOverlay(window, mainTab, 'Move to Last Position');
		await overlay.getByRole('button', { name: 'Move to Last Position' }).click();

		await expect(tabRows.nth(0)).toContainText('README');
		await expect(tabRows.nth(1)).toContainText('Main');
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('renames an inactive AI tab from the hover overlay without leaving file preview', async () => {
		const tabRows = window.locator('[data-tab-id]');
		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		const mainTab = tabRows.filter({ hasText: 'Main' }).first();
		const overlay = await openTabHoverOverlay(window, mainTab, 'Rename Tab');
		await overlay.getByText('Rename Tab').click();

		const renameDialog = window.getByRole('dialog', { name: 'Rename Tab' });
		await renameDialog.locator('input').fill('Inactive Reviewed Main');
		await renameDialog.getByRole('button', { name: 'Rename' }).click();

		await expect(renameDialog).toBeHidden();
		await expect(tabRows.filter({ hasText: 'Inactive Reviewed Main' }).first()).toBeVisible();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('selects a renamed inactive AI tab from the Tab Switcher', async () => {
		const tabRows = window.locator('[data-tab-id]');
		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		const mainTab = tabRows.filter({ hasText: 'Main' }).first();
		const overlay = await openTabHoverOverlay(window, mainTab, 'Rename Tab');
		await overlay.getByText('Rename Tab').click();
		const renameDialog = window.getByRole('dialog', { name: 'Rename Tab' });
		await renameDialog.locator('input').fill('Switcher Reviewed Main');
		await renameDialog.locator('input').press('Enter');
		await expect(tabRows.filter({ hasText: 'Switcher Reviewed Main' }).first()).toBeVisible();

		await window.keyboard.press('Alt+Meta+T');
		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		await switcher.getByPlaceholder('Search open tabs...').fill('Switcher Reviewed Main');
		await switcher.getByRole('button', { name: /Switcher Reviewed Main/ }).click();

		await expect(switcher).toBeHidden();
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();
	});

	test('closes an inactive AI tab from the hover overlay while preserving file preview', async () => {
		const tabRows = window.locator('[data-tab-id]');
		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		const mainTab = tabRows.filter({ hasText: 'Main' }).first();
		const overlay = await openTabHoverOverlay(window, mainTab);
		await overlay.getByRole('button', { name: 'Close Tab', exact: true }).click();

		await expect(tabRows.filter({ hasText: 'Main' })).toHaveCount(0);
		await expect(tabRows.filter({ hasText: 'README' }).first()).toBeVisible();
		await expect(tabRows.filter({ hasText: 'New Session' }).first()).toBeVisible();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('reopens an inactive AI tab closed from file preview with the global shortcut', async () => {
		const tabRows = window.locator('[data-tab-id]');
		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		const mainTab = tabRows.filter({ hasText: 'Main' }).first();
		const overlay = await openTabHoverOverlay(window, mainTab);
		await overlay.getByRole('button', { name: 'Close Tab', exact: true }).click();
		await expect(tabRows.filter({ hasText: 'Main' })).toHaveCount(0);

		await window.keyboard.press('Meta+Shift+T');

		await expect(tabRows.filter({ hasText: 'Main' }).first()).toBeVisible();
		await expect(tabRows.filter({ hasText: 'README' }).first()).toBeVisible();
		await tabRows.filter({ hasText: 'Main' }).first().click();
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();
	});

	test('stars an inactive AI tab from the hover overlay and lists it in starred switcher mode', async () => {
		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		const mainTab = window.locator('[data-tab-id]').filter({ hasText: 'Main' }).first();
		const overlay = await openTabHoverOverlay(window, mainTab);
		await overlay.getByText('Star Session').click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		await window.keyboard.press('Alt+Meta+T');
		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		await switcher.getByPlaceholder('Search open tabs...').press('Tab');
		await switcher.getByPlaceholder('Search named sessions...').press('Tab');

		await expect(switcher.getByPlaceholder('Search starred sessions...')).toBeFocused();
		await expect(switcher.getByRole('button', { name: /Main/ })).toBeVisible();
	});

	test('unstars an inactive AI tab from the hover overlay and returns starred mode empty', async () => {
		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		const mainTab = window.locator('[data-tab-id]').filter({ hasText: 'Main' }).first();
		const overlay = await openTabHoverOverlay(window, mainTab);
		await overlay.getByText('Star Session', { exact: true }).click();
		await expect(overlay.getByText('Unstar Session', { exact: true })).toBeVisible();
		await overlay.getByText('Unstar Session', { exact: true }).click();
		await expect(overlay.getByText('Star Session', { exact: true })).toBeVisible();
		await dismissTabHoverOverlay(window);
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		await window.keyboard.press('Alt+Meta+T');
		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		await switcher.getByPlaceholder('Search open tabs...').press('Tab');
		await switcher.getByPlaceholder('Search named sessions...').press('Tab');

		await expect(switcher.getByText('No starred sessions')).toBeVisible();
	});

	test('moves an inactive AI tab back to first position without leaving file preview', async () => {
		const tabRows = window.locator('[data-tab-id]');
		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		const mainTab = tabRows.filter({ hasText: 'Main' }).first();
		let overlay = await openTabHoverOverlay(window, mainTab, 'Move to Last Position');
		await overlay.getByRole('button', { name: 'Move to Last Position' }).click();
		await expect(tabRows.nth(0)).toContainText('README');
		await expect(tabRows.nth(1)).toContainText('Main');
		await dismissTabHoverOverlay(window);

		overlay = await openTabHoverOverlay(window, mainTab, 'Move to First Position');
		await overlay.getByRole('button', { name: 'Move to First Position' }).click();

		await expect(tabRows.nth(0)).toContainText('Main');
		await expect(tabRows.nth(1)).toContainText('README');
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('moves an inactive file tab back to last position without leaving the AI tab', async () => {
		const tabRows = window.locator('[data-tab-id]');
		await window.getByText('Main', { exact: true }).click();
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();

		const readmeTab = tabRows.filter({ hasText: 'README' }).first();
		let overlay = await openTabHoverOverlay(window, readmeTab, 'Move to First Position');
		await overlay.getByRole('button', { name: 'Move to First Position' }).click();
		await expect(tabRows.nth(0)).toContainText('README');
		await expect(tabRows.nth(1)).toContainText('Main');
		await dismissTabHoverOverlay(window);

		overlay = await openTabHoverOverlay(window, readmeTab, 'Move to Last Position');
		await overlay.getByRole('button', { name: 'Move to Last Position' }).click();

		await expect(tabRows.nth(0)).toContainText('Main');
		await expect(tabRows.nth(1)).toContainText('README');
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();
	});

	test('returns from named-session no-match search to open Tab Switcher results', async () => {
		await window.getByText('Main', { exact: true }).click();
		await window.keyboard.press('Alt+Meta+T');

		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		await switcher.getByPlaceholder('Search open tabs...').press('Tab');
		const namedSearch = switcher.getByPlaceholder('Search named sessions...');
		await namedSearch.fill('missing-named-return-sentinel');
		await expect(switcher.getByText('No named sessions found')).toBeVisible();

		await namedSearch.press('Shift+Tab');

		const openSearch = switcher.getByPlaceholder('Search open tabs...');
		await expect(openSearch).toBeFocused();
		await expect(switcher.getByText('No open tabs')).toBeVisible();
		await openSearch.fill('');
		await expect(switcher.getByRole('button', { name: /Main/ })).toBeVisible();
		await expect(switcher.getByRole('button', { name: /README/ })).toBeVisible();
	});

	test('returns from starred no-match search to named Tab Switcher results', async () => {
		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
		await window.keyboard.press('Alt+Meta+T');

		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		await switcher.getByPlaceholder('Search open tabs...').press('Tab');
		await switcher.getByPlaceholder('Search named sessions...').press('Tab');
		const starredSearch = switcher.getByPlaceholder('Search starred sessions...');
		await starredSearch.fill('missing-starred-return-sentinel');
		await expect(switcher.getByText('No starred sessions')).toBeVisible();

		await starredSearch.press('Shift+Tab');
		const namedSearch = switcher.getByPlaceholder('Search named sessions...');
		await expect(namedSearch).toBeFocused();
		await namedSearch.fill('Main');

		await expect(switcher.getByRole('button', { name: /Main/ })).toBeVisible();
		await namedSearch.press('Escape');
		await expect(switcher).toBeHidden();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('recovers open Tab Switcher results after no-match search with multiple new tabs', async () => {
		const tabRows = window.locator('[data-tab-id]');
		await window.getByText('Main', { exact: true }).click();
		await window.keyboard.press('Meta+T');
		await window.keyboard.press('Meta+T');
		await expect(tabRows).toHaveCount(4);

		await window.keyboard.press('Alt+Meta+T');
		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		const searchInput = switcher.getByPlaceholder('Search open tabs...');
		await searchInput.fill('missing-multi-new-tab-sentinel');
		await expect(switcher.getByText('No open tabs')).toBeVisible();

		await searchInput.fill('');

		await expect(switcher.getByRole('button', { name: /Main/ })).toBeVisible();
		await expect(switcher.getByRole('button', { name: /README/ })).toBeVisible();
		await expect(switcher.getByRole('button', { name: /New Session/ }).first()).toBeVisible();
	});

	test('selects a seeded scratch AI tab from file preview with a numeric switcher shortcut', async () => {
		await relaunchWithEstablishedAiTabs([
			{
				id: 'scratch-review-tab',
				agentSessionId: 'thread_e2e_scratch_review',
				name: 'Scratch Review Tab',
				logText: 'Scratch Review response is visible.',
			},
		]);
		const tabRows = window.locator('[data-tab-id]');
		await expect(tabRows.filter({ hasText: 'Scratch Review Tab' }).first()).toBeVisible();

		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		await window.keyboard.press('Alt+Meta+T');
		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		const searchInput = switcher.getByPlaceholder('Search open tabs...');
		await searchInput.fill('Scratch Review');
		await searchInput.press('Meta+1');

		await expect(switcher).toBeHidden();
		await expect(window.getByText('Scratch Review response is visible.')).toBeVisible();
	});

	test('keeps file preview active after Shortcuts Help closes over collapsed right chrome', async () => {
		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
		await window.keyboard.press('Alt+Meta+ArrowRight');
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('View Shortcuts');
		await quickActionsDialog.getByRole('button', { name: /View Shortcuts/ }).click();

		const shortcutsDialog = window.getByRole('dialog', { name: 'Keyboard Shortcuts' });
		await expect(shortcutsDialog).toBeVisible();
		await window.keyboard.press('Escape');

		await expect(shortcutsDialog).toBeHidden();
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('restores Files panel from shortcut after Tab Switcher closes over hidden right chrome', async () => {
		await helpers.openRightPanelTab(window, 'History');
		await expect(window.locator('[data-tour="history-panel"]')).toBeVisible();
		await window.keyboard.press('Alt+Meta+ArrowRight');
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();

		await window.keyboard.press('Alt+Meta+T');
		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		await expect(switcher).toBeVisible();
		await switcher.getByPlaceholder('Search open tabs...').press('Escape');
		await expect(switcher).toBeHidden();
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();

		await window.keyboard.press('Meta+Shift+F');
		await expect(window.locator('[data-tour="files-panel"]')).toBeVisible();
		await expect(window.locator('[data-tour="files-panel"]').getByTitle('README.md')).toBeVisible();
	});

	test('keeps terminal draft after Tab Switcher closes over hidden Left Bar', async () => {
		const terminalInput = await openSeededTerminalAgent(window);
		await terminalInput.fill('terminal draft under tab switcher sentinel');
		await window.keyboard.press('Alt+Meta+ArrowLeft');
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();

		await window.keyboard.press('Alt+Meta+T');
		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		await expect(switcher).toBeVisible();
		await switcher.getByPlaceholder('Search open tabs...').press('Escape');

		await expect(switcher).toBeHidden();
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();
		await expect(terminalInput).toHaveValue('terminal draft under tab switcher sentinel');
	});

	test('keeps Auto Run selected after creating and closing a scratch AI tab', async () => {
		await helpers.openRightPanelTab(window, 'Auto Run');
		await expect(window.getByText('Auto Run Surface')).toBeVisible();
		await window.getByText('Main', { exact: true }).click();

		await window.keyboard.press('Meta+T');
		await expect(
			window.locator('[data-tab-id]').filter({ hasText: 'New Session' }).first()
		).toBeVisible();
		await window.keyboard.press('Meta+W');

		await expect(window.getByText('Auto Run Surface')).toBeVisible();
		await expect(window.getByRole('button', { name: /^Run$/ })).toBeVisible();
		await expect(window.getByText('Codex seeded response is visible.')).toBeVisible();
	});

	test('keeps History selected after closing an inactive AI tab from file preview', async () => {
		const tabRows = window.locator('[data-tab-id]');
		await helpers.openRightPanelTab(window, 'History');
		await expect(window.locator('[data-tour="history-panel"]')).toBeVisible();
		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		const mainTab = tabRows.filter({ hasText: 'Main' }).first();
		const overlay = await openTabHoverOverlay(window, mainTab);
		await overlay.getByRole('button', { name: 'Close Tab', exact: true }).click();

		await expect(tabRows.filter({ hasText: 'Main' })).toHaveCount(0);
		await expect(window.locator('[data-tour="history-panel"]')).toBeVisible();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('keeps Left Bar search results while right-panel shortcuts change tabs', async () => {
		await window.keyboard.press('Meta+Shift+A');
		await window.keyboard.press('Meta+f');
		const filterInput = window.getByPlaceholder('Filter agents...');
		const sessionList = window.locator('[data-tour="session-list"]');
		await filterInput.fill('Terminal');
		await expect(sessionList.getByText('E2E Terminal')).toBeVisible();
		await expect(sessionList.getByText('E2E Workbench')).toBeHidden();

		await window.keyboard.press('Meta+Shift+H');

		await expect(window.locator('[data-tour="history-panel"]')).toBeVisible();
		await expect(filterInput).toHaveValue('Terminal');
		await expect(sessionList.getByText('E2E Terminal')).toBeVisible();
	});

	test('keeps terminal draft when the Files shortcut restores hidden right chrome', async () => {
		const terminalInput = await openSeededTerminalAgent(window);
		await terminalInput.fill('terminal draft before files restore sentinel');
		await window.keyboard.press('Alt+Meta+ArrowRight');
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();

		await window.keyboard.press('Meta+Shift+F');

		await expect(window.locator('[data-tour="files-panel"]')).toBeVisible();
		await expect(window.locator('[data-tour="files-panel"]').getByTitle('README.md')).toBeVisible();
		await expect(terminalInput).toHaveValue('terminal draft before files restore sentinel');
	});

	test('keeps file preview selected after agent cycling with both sidebars hidden', async () => {
		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
		await window.keyboard.press('Alt+Meta+ArrowLeft');
		await window.keyboard.press('Alt+Meta+ArrowRight');
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();

		await window.keyboard.press('Meta+]');
		await expect(window.getByLabel('Terminal output')).toBeVisible();
		await window.keyboard.press('Meta+]');

		await expect(window.getByText('File Preview Surface')).toBeVisible();
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();
	});

	test('keeps an active agent filter after canceling Quick Actions', async () => {
		await window.keyboard.press('Meta+Shift+A');
		await window.keyboard.press('Meta+f');
		const filterInput = window.getByPlaceholder('Filter agents...');
		const sessionList = window.locator('[data-tour="session-list"]');
		await filterInput.fill('Terminal');
		await expect(sessionList.getByText('E2E Terminal')).toBeVisible();
		await expect(sessionList.getByText('E2E Workbench')).toBeHidden();

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Toggle Right Panel');
		await expect(
			quickActionsDialog.getByRole('button', { name: /Toggle Right Panel/ })
		).toBeVisible();
		await closeQuickActions(window, quickActionsDialog);

		await expect(filterInput).toHaveValue('Terminal');
		await expect(sessionList.getByText('E2E Terminal')).toBeVisible();
		await expect(sessionList.getByText('E2E Workbench')).toBeHidden();
	});

	test('selects a second seeded AI tab from the Tab Switcher after filtering scratch tabs', async () => {
		await relaunchWithEstablishedAiTabs([
			{
				id: 'first-scratch-tab',
				agentSessionId: 'thread_e2e_first_scratch',
				name: 'First Scratch Tab',
				logText: 'First Scratch response is visible.',
			},
			{
				id: 'second-scratch-tab',
				agentSessionId: 'thread_e2e_second_scratch',
				name: 'Second Scratch Tab',
				logText: 'Second Scratch response is visible.',
			},
		]);
		const tabRows = window.locator('[data-tab-id]');
		await expect(tabRows.filter({ hasText: 'First Scratch Tab' }).first()).toBeVisible();
		await expect(tabRows.filter({ hasText: 'Second Scratch Tab' }).first()).toBeVisible();

		await window.getByText('README', { exact: true }).click();
		await window.keyboard.press('Alt+Meta+T');
		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		const searchInput = switcher.getByPlaceholder('Search open tabs...');
		await searchInput.fill('Second Scratch');
		await searchInput.press('Meta+1');

		await expect(switcher).toBeHidden();
		await expect(window.getByText('Second Scratch response is visible.')).toBeVisible();
	});

	test('closes a seeded inactive scratch tab from file preview while keeping another scratch tab', async () => {
		await relaunchWithEstablishedAiTabs([
			{
				id: 'keep-scratch-tab',
				agentSessionId: 'thread_e2e_keep_scratch',
				name: 'Keep Scratch Tab',
				logText: 'Keep Scratch response is visible.',
			},
			{
				id: 'close-scratch-tab',
				agentSessionId: 'thread_e2e_close_scratch',
				name: 'Close Scratch Tab',
				logText: 'Close Scratch response is visible.',
			},
		]);
		const tabRows = window.locator('[data-tab-id]');
		await expect(tabRows.filter({ hasText: 'Keep Scratch Tab' }).first()).toBeVisible();
		await expect(tabRows.filter({ hasText: 'Close Scratch Tab' }).first()).toBeVisible();

		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
		const closeScratchTab = tabRows.filter({ hasText: 'Close Scratch Tab' }).first();
		const overlay = await openTabHoverOverlay(window, closeScratchTab);
		await overlay.getByRole('button', { name: 'Close Tab', exact: true }).click();

		await expect(tabRows.filter({ hasText: 'Close Scratch Tab' })).toHaveCount(0);
		await expect(tabRows.filter({ hasText: 'Keep Scratch Tab' }).first()).toBeVisible();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('reopens a seeded scratch AI tab after closing it from file preview', async () => {
		await relaunchWithEstablishedAiTabs([
			{
				id: 'reopen-scratch-tab',
				agentSessionId: 'thread_e2e_reopen_scratch',
				name: 'Reopen Scratch Tab',
				logText: 'Reopen Scratch response is visible.',
			},
		]);
		const tabRows = window.locator('[data-tab-id]');
		await expect(tabRows.filter({ hasText: 'Reopen Scratch Tab' }).first()).toBeVisible();

		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
		const reopenScratchTab = tabRows.filter({ hasText: 'Reopen Scratch Tab' }).first();
		const overlay = await openTabHoverOverlay(window, reopenScratchTab);
		await overlay.getByRole('button', { name: 'Close Tab', exact: true }).click();
		await expect(tabRows.filter({ hasText: 'Reopen Scratch Tab' })).toHaveCount(0);

		await window.keyboard.press('Meta+Shift+T');

		await expect(tabRows.filter({ hasText: 'Reopen Scratch Tab' }).first()).toBeVisible();
		await tabRows.filter({ hasText: 'Reopen Scratch Tab' }).first().click();
		await expect(window.getByText('Reopen Scratch response is visible.')).toBeVisible();
	});

	test('keeps Files selected after Tab Switcher closes over hidden Left Bar', async () => {
		await helpers.openRightPanelTab(window, 'Files');
		await expect(window.locator('[data-tour="files-panel"]')).toBeVisible();
		await window.keyboard.press('Alt+Meta+ArrowLeft');
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();

		await window.keyboard.press('Alt+Meta+T');
		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		await expect(switcher).toBeVisible();
		await switcher.getByPlaceholder('Search open tabs...').press('Escape');

		await expect(switcher).toBeHidden();
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();
		await expect(window.locator('[data-tour="files-panel"]')).toBeVisible();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('keeps History selected after Tab Switcher closes over hidden Left Bar', async () => {
		await helpers.openRightPanelTab(window, 'History');
		await expect(window.locator('[data-tour="history-panel"]')).toBeVisible();
		await window.keyboard.press('Alt+Meta+ArrowLeft');
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();

		await window.keyboard.press('Alt+Meta+T');
		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		await expect(switcher).toBeVisible();
		await switcher.getByPlaceholder('Search open tabs...').press('Escape');

		await expect(switcher).toBeHidden();
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();
		await expect(window.locator('[data-tour="history-panel"]')).toBeVisible();
	});

	test('keeps Auto Run selected after Tab Switcher closes over hidden Left Bar', async () => {
		await helpers.openRightPanelTab(window, 'Auto Run');
		await expect(window.getByText('Auto Run Surface')).toBeVisible();
		await window.keyboard.press('Alt+Meta+ArrowLeft');
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();

		await window.keyboard.press('Alt+Meta+T');
		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		await expect(switcher).toBeVisible();
		await switcher.getByPlaceholder('Search open tabs...').press('Escape');

		await expect(switcher).toBeHidden();
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();
		await expect(window.getByText('Auto Run Surface')).toBeVisible();
		await expect(window.getByRole('button', { name: /^Run$/ })).toBeVisible();
	});

	test('restores History shortcut after Tab Switcher closes over hidden right chrome', async () => {
		await helpers.openRightPanelTab(window, 'Files');
		await expect(window.locator('[data-tour="files-panel"]')).toBeVisible();
		await window.keyboard.press('Alt+Meta+ArrowRight');
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();

		await window.keyboard.press('Alt+Meta+T');
		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		await expect(switcher).toBeVisible();
		await switcher.getByPlaceholder('Search open tabs...').press('Escape');
		await expect(switcher).toBeHidden();

		await window.keyboard.press('Meta+Shift+H');

		await expect(window.locator('[data-tour="history-panel"]')).toBeVisible();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('restores Auto Run shortcut after Tab Switcher closes over hidden right chrome', async () => {
		await helpers.openRightPanelTab(window, 'History');
		await expect(window.locator('[data-tour="history-panel"]')).toBeVisible();
		await window.keyboard.press('Alt+Meta+ArrowRight');
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();

		await window.keyboard.press('Alt+Meta+T');
		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		await expect(switcher).toBeVisible();
		await switcher.getByPlaceholder('Search open tabs...').press('Escape');
		await expect(switcher).toBeHidden();

		await window.keyboard.press('Meta+Shift+1');

		await expect(window.getByText('Auto Run Surface')).toBeVisible();
		await expect(window.getByRole('button', { name: /^Run$/ })).toBeVisible();
	});

	test('preserves terminal draft after Shortcuts Help closes over hidden right chrome', async () => {
		const terminalInput = await openSeededTerminalAgent(window);
		await terminalInput.fill('terminal draft before hidden-right shortcuts sentinel');
		await window.keyboard.press('Alt+Meta+ArrowRight');
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('View Shortcuts');
		await quickActionsDialog.getByRole('button', { name: /View Shortcuts/ }).click();
		const shortcutsDialog = window.getByRole('dialog', { name: 'Keyboard Shortcuts' });
		await expect(shortcutsDialog).toBeVisible();
		await window.keyboard.press('Escape');

		await expect(shortcutsDialog).toBeHidden();
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();
		await expect(window.getByLabel('Terminal output')).toBeVisible();
		await expect(terminalInput).toHaveValue(
			'terminal draft before hidden-right shortcuts sentinel'
		);
	});

	test('preserves terminal draft after Shortcuts Help closes over hidden Left Bar', async () => {
		const terminalInput = await openSeededTerminalAgent(window);
		await terminalInput.fill('terminal draft before hidden-left shortcuts sentinel');
		await window.keyboard.press('Alt+Meta+ArrowLeft');
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('View Shortcuts');
		await quickActionsDialog.getByRole('button', { name: /View Shortcuts/ }).click();
		const shortcutsDialog = window.getByRole('dialog', { name: 'Keyboard Shortcuts' });
		await expect(shortcutsDialog).toBeVisible();
		await window.keyboard.press('Escape');

		await expect(shortcutsDialog).toBeHidden();
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();
		await expect(window.getByLabel('Terminal output')).toBeVisible();
		await expect(terminalInput).toHaveValue('terminal draft before hidden-left shortcuts sentinel');
	});

	test('keeps agent filter active after Shortcuts Help closes', async () => {
		await window.keyboard.press('Meta+Shift+A');
		await window.keyboard.press('Meta+f');
		const filterInput = window.getByPlaceholder('Filter agents...');
		const sessionList = window.locator('[data-tour="session-list"]');
		await filterInput.fill('Terminal');
		await expect(sessionList.getByText('E2E Terminal')).toBeVisible();
		await expect(sessionList.getByText('E2E Workbench')).toBeHidden();

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('View Shortcuts');
		await quickActionsDialog.getByRole('button', { name: /View Shortcuts/ }).click();
		const shortcutsDialog = window.getByRole('dialog', { name: 'Keyboard Shortcuts' });
		await expect(shortcutsDialog).toBeVisible();
		await window.keyboard.press('Escape');

		await expect(shortcutsDialog).toBeHidden();
		await expect(filterInput).toHaveValue('Terminal');
		await expect(sessionList.getByText('E2E Terminal')).toBeVisible();
		await expect(sessionList.getByText('E2E Workbench')).toBeHidden();
	});

	test('keeps agent filter active after Tab Switcher closes', async () => {
		await window.keyboard.press('Meta+Shift+A');
		await window.keyboard.press('Meta+f');
		const filterInput = window.getByPlaceholder('Filter agents...');
		const sessionList = window.locator('[data-tour="session-list"]');
		await filterInput.fill('Workbench');
		await expect(sessionList.getByText('E2E Workbench')).toBeVisible();
		await expect(sessionList.getByText('E2E Terminal')).toBeHidden();

		await window.keyboard.press('Alt+Meta+T');
		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		await expect(switcher).toBeVisible();
		await switcher.getByPlaceholder('Search open tabs...').press('Escape');

		await expect(switcher).toBeHidden();
		await expect(filterInput).toHaveValue('Workbench');
		await expect(sessionList.getByText('E2E Workbench')).toBeVisible();
		await expect(sessionList.getByText('E2E Terminal')).toBeHidden();
	});

	test('cycles agents after Tab Switcher closes with both sidebars hidden', async () => {
		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
		await window.keyboard.press('Alt+Meta+ArrowLeft');
		await window.keyboard.press('Alt+Meta+ArrowRight');
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();

		await window.keyboard.press('Alt+Meta+T');
		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		await expect(switcher).toBeVisible();
		await switcher.getByPlaceholder('Search open tabs...').press('Escape');
		await expect(switcher).toBeHidden();

		await window.keyboard.press('Meta+]');
		await expect(window.getByLabel('Terminal output')).toBeVisible();
		await window.keyboard.press('Meta+[');

		await expect(window.getByText('File Preview Surface')).toBeVisible();
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();
	});

	test('restores Left Bar shortcut after Tab Switcher closes over hidden chrome', async () => {
		const terminalInput = await openSeededTerminalAgent(window);
		await terminalInput.fill('terminal draft before left restore sentinel');
		await window.keyboard.press('Alt+Meta+ArrowLeft');
		await window.keyboard.press('Alt+Meta+ArrowRight');
		await expect(window.locator('[data-tour="session-list"]')).toBeHidden();
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();

		await window.keyboard.press('Alt+Meta+T');
		const switcher = window.getByRole('dialog', { name: 'Tab Switcher' });
		await expect(switcher).toBeVisible();
		await switcher.getByPlaceholder('Search open tabs...').press('Escape');
		await expect(switcher).toBeHidden();

		await window.keyboard.press('Meta+Shift+A');

		await expect(window.locator('[data-tour="session-list"]')).toBeVisible();
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();
		await expect(terminalInput).toHaveValue('terminal draft before left restore sentinel');
	});

	test('restores Auto Run shortcut after Shortcuts Help closes over hidden right chrome', async () => {
		await helpers.openRightPanelTab(window, 'Files');
		await expect(window.locator('[data-tour="files-panel"]')).toBeVisible();
		await window.keyboard.press('Alt+Meta+ArrowRight');
		await expect(window.getByTitle(/Show right panel/)).toBeVisible();

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('View Shortcuts');
		await quickActionsDialog.getByRole('button', { name: /View Shortcuts/ }).click();
		const shortcutsDialog = window.getByRole('dialog', { name: 'Keyboard Shortcuts' });
		await expect(shortcutsDialog).toBeVisible();
		await window.keyboard.press('Escape');
		await expect(shortcutsDialog).toBeHidden();

		await window.keyboard.press('Meta+Shift+1');

		await expect(window.getByText('Auto Run Surface')).toBeVisible();
		await expect(window.getByRole('button', { name: /^Run$/ })).toBeVisible();
	});

	test('copies a seeded inactive scratch AI tab session id without leaving file preview', async () => {
		await relaunchWithEstablishedAiTabs([
			{
				id: 'copy-scratch-session',
				agentSessionId: 'thread_e2e_copy_scratch',
				name: 'Copy Scratch Session',
				logText: 'Copy Scratch response is visible.',
			},
		]);
		const tabRows = window.locator('[data-tab-id]');
		await expect(tabRows.filter({ hasText: 'Copy Scratch Session' }).first()).toBeVisible();

		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
		const overlay = await openTabHoverOverlay(
			window,
			tabRows.filter({ hasText: 'Copy Scratch Session' }).first(),
			'Rename Tab'
		);
		await overlay.getByRole('button', { name: 'Copy Session ID' }).click();

		await expect(window.getByText('Copied!')).toBeVisible();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
	});

	test('marks a seeded inactive scratch AI tab unread without leaving file preview', async () => {
		await relaunchWithEstablishedAiTabs([
			{
				id: 'unread-scratch-session',
				agentSessionId: 'thread_e2e_unread_scratch',
				name: 'Unread Scratch Session',
				logText: 'Unread Scratch response is visible.',
			},
		]);
		const tabRows = window.locator('[data-tab-id]');
		await expect(tabRows.filter({ hasText: 'Unread Scratch Session' }).first()).toBeVisible();

		await window.getByText('README', { exact: true }).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();
		const overlay = await openTabHoverOverlay(
			window,
			tabRows.filter({ hasText: 'Unread Scratch Session' }).first(),
			'Mark as Unread'
		);
		await overlay.getByRole('button', { name: 'Mark as Unread' }).click();

		await expect(window.getByTitle('New messages')).toBeVisible();
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

	test('cancels and confirms deleting an empty agent group', async () => {
		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Create New Group');
		await quickActionsDialog.getByRole('button', { name: /Create New Group/ }).click();

		const createGroupDialog = window.getByRole('dialog', { name: 'Create New Group' });
		await expect(createGroupDialog).toBeVisible();
		await createGroupDialog.getByLabel('Group Name').fill('empty lane');
		await createGroupDialog.getByRole('button', { name: 'Create' }).click();
		await expect(createGroupDialog).toBeHidden();

		const groupHeader = window.getByRole('button', { name: /EMPTY LANE/ });
		const groupSection = groupHeader.locator('xpath=ancestor::div[contains(@class, "mb-1")][1]');
		await expect(groupSection).toBeVisible();

		await groupHeader.hover();
		await groupSection.getByTitle('Delete empty group').click();
		let confirmDialog = window.getByRole('dialog', { name: 'Confirm' });
		await expect(confirmDialog.getByText('delete the group "EMPTY LANE"')).toBeVisible();
		await confirmDialog.getByRole('button', { name: 'Cancel' }).click();
		await expect(confirmDialog).toBeHidden();
		await expect(groupSection).toBeVisible();

		await groupHeader.hover();
		await groupSection.getByTitle('Delete empty group').click();
		confirmDialog = window.getByRole('dialog', { name: 'Confirm' });
		await expect(confirmDialog.getByText('delete the group "EMPTY LANE"')).toBeVisible();
		await confirmDialog.getByRole('button', { name: 'Confirm' }).click();

		await expect(window.getByText('EMPTY LANE', { exact: true })).toHaveCount(0);
	});

	test('moves an agent to a group from the context menu and ungroups it', async () => {
		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Create New Group');
		await quickActionsDialog.getByRole('button', { name: /Create New Group/ }).click();

		const createGroupDialog = window.getByRole('dialog', { name: 'Create New Group' });
		await createGroupDialog.getByLabel('Group Name').fill('agent lane');
		await createGroupDialog.getByRole('button', { name: 'Create' }).click();
		await expect(createGroupDialog).toBeHidden();

		const groupSection = window
			.getByText('AGENT LANE', { exact: true })
			.locator('xpath=ancestor::div[contains(@class, "mb-1")][1]');
		await expect(groupSection).toBeVisible();
		await expect(groupSection.getByText('E2E Terminal', { exact: true })).toHaveCount(0);

		let contextMenu = await openSessionContextMenu(window, 'E2E Terminal', 'Move to Group');
		await contextMenu.getByText('Move to Group', { exact: true }).hover();
		await contextMenu.getByRole('button', { name: /AGENT LANE/ }).click();

		await expect(groupSection.getByText('E2E Terminal', { exact: true })).toBeVisible();

		contextMenu = await openSessionContextMenu(window, 'E2E Terminal', 'Move to Group');
		await contextMenu.getByText('Move to Group', { exact: true }).hover();
		await contextMenu.getByRole('button', { name: /Ungrouped/ }).click();

		await expect(groupSection.getByText('E2E Terminal', { exact: true })).toHaveCount(0);
		const ungroupedSection = window
			.getByText('Ungrouped Agents', { exact: true })
			.locator('xpath=ancestor::div[contains(@class, "mb-1")][1]');
		await expect(ungroupedSection.getByText('E2E Terminal', { exact: true })).toBeVisible();
	});

	test('creates a new group from the agent context menu and moves the agent into it', async () => {
		const contextMenu = await openSessionContextMenu(window, 'E2E Terminal', 'Move to Group');
		await contextMenu.getByText('Move to Group', { exact: true }).hover();
		await contextMenu.getByRole('button', { name: /Create New Group/ }).click();

		const createGroupDialog = window.getByRole('dialog', { name: 'Create New Group' });
		await expect(createGroupDialog).toBeVisible();
		await createGroupDialog.getByLabel('Group Name').fill('terminal lane');
		await createGroupDialog.getByRole('button', { name: 'Create' }).click();
		await expect(createGroupDialog).toBeHidden();

		const groupSection = window
			.getByText('TERMINAL LANE', { exact: true })
			.locator('xpath=ancestor::div[contains(@class, "mb-1")][1]');
		await expect(groupSection.getByText('E2E Terminal', { exact: true })).toBeVisible();

		const ungroupedSection = window
			.getByText('Ungrouped Agents', { exact: true })
			.locator('xpath=ancestor::div[contains(@class, "mb-1")][1]');
		await expect(ungroupedSection.getByText('E2E Workbench', { exact: true })).toBeVisible();
		await expect(ungroupedSection.getByText('E2E Terminal', { exact: true })).toHaveCount(0);
	});

	test('collapses and expands a grouped agent section', async () => {
		const contextMenu = await openSessionContextMenu(window, 'E2E Terminal', 'Move to Group');
		await contextMenu.getByText('Move to Group', { exact: true }).hover();
		await contextMenu.getByRole('button', { name: /Create New Group/ }).click();

		const createGroupDialog = window.getByRole('dialog', { name: 'Create New Group' });
		await expect(createGroupDialog).toBeVisible();
		await createGroupDialog.getByLabel('Group Name').fill('focus lane');
		await createGroupDialog.getByRole('button', { name: 'Create' }).click();
		await expect(createGroupDialog).toBeHidden();

		const groupHeader = window.getByRole('button', { name: /FOCUS LANE/ });
		const groupSection = window
			.getByText('FOCUS LANE', { exact: true })
			.locator('xpath=ancestor::div[contains(@class, "mb-1")][1]');
		await expect(groupHeader).toHaveAttribute('aria-expanded', 'true');
		await expect(groupSection.getByText('E2E Terminal', { exact: true })).toBeVisible();

		await groupHeader.click();
		await expect(groupHeader).toHaveAttribute('aria-expanded', 'false');
		await expect(
			groupSection.getByRole('button', { name: 'Switch to E2E Terminal' })
		).toBeVisible();

		await groupHeader.click();
		await expect(groupHeader).toHaveAttribute('aria-expanded', 'true');
		await expect(groupSection.getByText('E2E Terminal', { exact: true })).toBeVisible();
	});

	test('renames a populated agent group inline from the sidebar', async () => {
		const contextMenu = await openSessionContextMenu(window, 'E2E Terminal', 'Move to Group');
		await contextMenu.getByText('Move to Group', { exact: true }).hover();
		await contextMenu.getByRole('button', { name: /Create New Group/ }).click();

		const createGroupDialog = window.getByRole('dialog', { name: 'Create New Group' });
		await expect(createGroupDialog).toBeVisible();
		await createGroupDialog.getByLabel('Group Name').fill('rename lane');
		await createGroupDialog.getByRole('button', { name: 'Create' }).click();
		await expect(createGroupDialog).toBeHidden();

		const groupHeader = window.getByRole('button', { name: /RENAME LANE/ });
		const groupSection = groupHeader.locator('xpath=ancestor::div[contains(@class, "mb-1")][1]');
		await expect(groupSection.getByText('E2E Terminal', { exact: true })).toBeVisible();

		await groupSection.getByText('RENAME LANE', { exact: true }).dblclick();
		const renameInput = window.locator('input:focus');
		await expect(renameInput).toHaveValue('RENAME LANE');
		await renameInput.fill('priority lane');
		await renameInput.press('Enter');

		const renamedSection = window
			.getByText('PRIORITY LANE', { exact: true })
			.locator('xpath=ancestor::div[contains(@class, "mb-1")][1]');
		await expect(renamedSection).toBeVisible();
		await expect(window.getByText('RENAME LANE', { exact: true })).toHaveCount(0);
		await expect(renamedSection.getByText('E2E Terminal', { exact: true })).toBeVisible();
	});

	test('renames the active agent group from Quick Actions', async () => {
		const contextMenu = await openSessionContextMenu(window, 'E2E Terminal', 'Move to Group');
		await contextMenu.getByText('Move to Group', { exact: true }).hover();
		await contextMenu.getByRole('button', { name: /Create New Group/ }).click();

		const createGroupDialog = window.getByRole('dialog', { name: 'Create New Group' });
		await expect(createGroupDialog).toBeVisible();
		await createGroupDialog.getByLabel('Group Name').fill('quick lane');
		await createGroupDialog.getByRole('button', { name: 'Create' }).click();
		await expect(createGroupDialog).toBeHidden();

		const groupSection = window
			.getByText('QUICK LANE', { exact: true })
			.locator('xpath=ancestor::div[contains(@class, "mb-1")][1]');
		await expect(groupSection.getByText('E2E Terminal', { exact: true })).toBeVisible();
		await groupSection.getByText('E2E Terminal', { exact: true }).click();
		await expect(window.getByLabel('Terminal output')).toBeVisible();

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Rename Group');
		await quickActionsDialog.getByRole('button', { name: /Rename Group/ }).click();

		await expect(quickActionsDialog).toBeHidden();
		const renameGroupDialog = window.getByRole('dialog', { name: 'Rename Group' });
		await expect(renameGroupDialog).toBeVisible();
		await expect(renameGroupDialog.getByLabel('Group Name')).toHaveValue('QUICK LANE');
		await renameGroupDialog.getByLabel('Group Name').fill('modal lane');
		await renameGroupDialog.getByRole('button', { name: 'Rename' }).click();
		await expect(renameGroupDialog).toBeHidden();

		const renamedSection = window
			.getByText('MODAL LANE', { exact: true })
			.locator('xpath=ancestor::div[contains(@class, "mb-1")][1]');
		await expect(renamedSection).toBeVisible();
		await expect(window.getByText('QUICK LANE', { exact: true })).toHaveCount(0);
		await expect(renamedSection.getByText('E2E Terminal', { exact: true })).toBeVisible();
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

	test('uses Create New Agent keyboard shortcuts for folder picker and create submit', async () => {
		const keyboardDir = path.join(seededWorkbench.homeDir, 'keyboard-created-agent-project');
		fs.mkdirSync(keyboardDir, { recursive: true });
		await stubAgentDetectionForNewAgent(electronApp);
		await stubSelectFolderDialog(electronApp, keyboardDir);

		const createAgentDialog = await openCreateNewAgentFromQuickActions(window);
		await createAgentDialog.getByRole('option', { name: /Codex/ }).click();
		await createAgentDialog.getByLabel('Agent Name').fill('Keyboard Shortcut Agent');
		await expect(createAgentDialog.getByRole('button', { name: 'Create Agent' })).toBeDisabled();

		await createAgentDialog.getByLabel('Agent Name').press('Control+O');
		await expect(createAgentDialog.getByLabel('Working Directory')).toHaveValue(keyboardDir);
		await expect(createAgentDialog.getByRole('button', { name: 'Create Agent' })).toBeEnabled();

		await createAgentDialog.getByLabel('Agent Name').press('Control+Enter');

		await expect(createAgentDialog).toBeHidden();
		await expect(
			window.locator('[data-tour="session-list"]').getByText('Keyboard Shortcut Agent', {
				exact: true,
			})
		).toBeVisible();
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

	test('shows debug info when refreshing unavailable provider detection', async () => {
		await stubAgentDetectionForNewAgent(electronApp);

		const createAgentDialog = await openCreateNewAgentFromQuickActions(window);
		const codexOption = createAgentDialog.getByRole('option', { name: /Codex/ });
		const claudeOption = createAgentDialog.getByRole('option', { name: /Claude Code/ });

		await expect(codexOption).toHaveAttribute('aria-selected', 'true');
		await expect(claudeOption).toContainText('Not Found');
		await claudeOption.getByTitle('Refresh detection').click();

		await expect(codexOption).toHaveAttribute('aria-selected', 'true');
		await expect(claudeOption).toHaveAttribute('aria-selected', 'false');
		await expect(createAgentDialog.getByText('Debug Info: claude not found')).toBeVisible();
		await expect(
			createAgentDialog.getByText('which claude failed (exit code 1): e2e binary missing')
		).toBeVisible();
		await expect(createAgentDialog.getByText('/opt/e2e/bin')).toBeVisible();
		await expect(createAgentDialog.getByText('/Users/e2e')).toBeVisible();
	});

	test('updates unavailable provider status when refresh detects a binary', async () => {
		await stubAgentDetectionForNewAgent(electronApp, {
			refreshedAgentId: 'claude-code',
			refreshedPath: '/opt/e2e/bin/claude',
		});

		const createAgentDialog = await openCreateNewAgentFromQuickActions(window);
		const codexOption = createAgentDialog.getByRole('option', { name: /Codex/ });
		const claudeOption = createAgentDialog.getByRole('option', { name: /Claude Code/ });

		await expect(codexOption).toHaveAttribute('aria-selected', 'true');
		await expect(claudeOption).toContainText('Not Found');
		await claudeOption.getByTitle('Refresh detection').click();

		await expect(codexOption).toHaveAttribute('aria-selected', 'true');
		await expect(claudeOption).toContainText('Available');
		await expect(createAgentDialog.getByText('Debug Info: claude not found')).toBeHidden();

		await claudeOption.click();
		await expect(claudeOption).toHaveAttribute('aria-selected', 'true');
		await expect(createAgentDialog.getByPlaceholder('/path/to/claude')).toHaveValue(
			'/opt/e2e/bin/claude'
		);
	});

	test('requires a manual path before creating an unavailable provider agent', async () => {
		const staticProjectDir = path.join(seededWorkbench.homeDir, 'unavailable-provider-validation');
		fs.mkdirSync(staticProjectDir, { recursive: true });
		await stubAgentDetectionForNewAgent(electronApp);

		const createAgentDialog = await openCreateNewAgentFromQuickActions(window);
		const claudeOption = createAgentDialog.getByRole('option', { name: /Claude Code/ });
		const createButton = createAgentDialog.getByRole('button', { name: 'Create Agent' });

		await claudeOption.click();
		await expect(claudeOption).toHaveAttribute('aria-selected', 'true');
		await createAgentDialog.getByLabel('Agent Name').fill('Unavailable Provider Validation');
		await createAgentDialog.getByLabel('Working Directory').fill(staticProjectDir);

		await expect(createButton).toBeDisabled();
		await createAgentDialog.getByPlaceholder('/path/to/claude').fill('/opt/e2e/manual/claude');
		await expect(createButton).toBeEnabled();
		await createAgentDialog.getByPlaceholder('/path/to/claude').fill('');
		await expect(createButton).toBeDisabled();
	});

	test('requires a real custom path before creating a beta OpenCode agent', async () => {
		const staticProjectDir = path.join(seededWorkbench.homeDir, 'opencode-provider-validation');
		fs.mkdirSync(staticProjectDir, { recursive: true });
		await stubAgentDetectionForNewAgent(electronApp);

		const createAgentDialog = await openCreateNewAgentFromQuickActions(window);
		const opencodeOption = createAgentDialog.getByRole('option', { name: /OpenCode/ });
		const createButton = createAgentDialog.getByRole('button', { name: 'Create Agent' });

		await opencodeOption.click();
		await expect(opencodeOption).toHaveAttribute('aria-selected', 'true');
		await createAgentDialog.getByLabel('Agent Name').fill('OpenCode Provider Validation');
		await createAgentDialog.getByLabel('Working Directory').fill(staticProjectDir);
		await createAgentDialog
			.getByPlaceholder('--flag value --another-flag')
			.fill('--model opencode-validation-e2e');
		await createAgentDialog.getByRole('button', { name: 'Add Variable' }).click();
		await createAgentDialog.getByPlaceholder('VARIABLE_NAME').fill('OPENCODE_VALIDATION_E2E');
		await createAgentDialog.getByPlaceholder('value', { exact: true }).fill('enabled');

		await expect(createButton).toBeDisabled();
		await createAgentDialog.getByPlaceholder('/path/to/opencode').fill('   ');
		await expect(createButton).toBeDisabled();
		await createAgentDialog.getByPlaceholder('/path/to/opencode').fill('/opt/e2e/manual/opencode');
		await expect(createButton).toBeEnabled();
		await createAgentDialog.getByPlaceholder('/path/to/opencode').fill('');
		await expect(createButton).toBeDisabled();
	});

	test('keeps Create New Agent static provider drafts isolated while switching providers', async () => {
		const staticProjectDir = path.join(seededWorkbench.homeDir, 'provider-draft-isolation');
		fs.mkdirSync(staticProjectDir, { recursive: true });
		await stubAgentDetectionForNewAgent(electronApp);

		const createAgentDialog = await openCreateNewAgentFromQuickActions(window);
		const createButton = createAgentDialog.getByRole('button', { name: 'Create Agent' });
		const claudeOption = createAgentDialog.getByRole('option', { name: /Claude Code/ });
		const factoryOption = createAgentDialog.getByRole('option', { name: /Factory Droid/ });

		await createAgentDialog.getByLabel('Agent Name').fill('Provider Draft Isolation');
		await createAgentDialog.getByLabel('Working Directory').fill(staticProjectDir);

		await claudeOption.click();
		await createAgentDialog
			.getByPlaceholder('/path/to/claude')
			.fill('/opt/e2e/manual/claude-draft');
		await createAgentDialog
			.getByPlaceholder('--flag value --another-flag')
			.fill('--model claude-draft');
		await createAgentDialog.getByRole('button', { name: 'Add Variable' }).click();
		await createAgentDialog.getByPlaceholder('VARIABLE_NAME').fill('CLAUDE_DRAFT_E2E');
		await createAgentDialog.getByPlaceholder('value', { exact: true }).fill('claude');
		await expect(createButton).toBeEnabled();

		await factoryOption.click();
		await expect(factoryOption).toHaveAttribute('aria-selected', 'true');
		await expect(createAgentDialog.getByPlaceholder('/path/to/factory')).toHaveValue('');
		await expect(createAgentDialog.getByPlaceholder('--flag value --another-flag')).toHaveValue('');
		await expect(createAgentDialog.getByPlaceholder('VARIABLE_NAME')).toHaveCount(0);
		await expect(createButton).toBeDisabled();

		await createAgentDialog
			.getByPlaceholder('/path/to/factory')
			.fill('/opt/e2e/manual/factory-draft');
		await createAgentDialog
			.getByPlaceholder('--flag value --another-flag')
			.fill('--model factory-draft');
		await createAgentDialog.getByRole('button', { name: 'Add Variable' }).click();
		await createAgentDialog.getByPlaceholder('VARIABLE_NAME').fill('FACTORY_DRAFT_E2E');
		await createAgentDialog.getByPlaceholder('value', { exact: true }).fill('factory');
		await expect(createButton).toBeEnabled();

		await claudeOption.click();
		await expect(claudeOption).toHaveAttribute('aria-selected', 'true');
		await expect(createAgentDialog.getByPlaceholder('/path/to/claude')).toHaveValue(
			'/opt/e2e/manual/claude-draft'
		);
		await expect(createAgentDialog.getByPlaceholder('--flag value --another-flag')).toHaveValue(
			'--model claude-draft'
		);
		await expect(createAgentDialog.getByPlaceholder('VARIABLE_NAME')).toHaveValue(
			'CLAUDE_DRAFT_E2E'
		);
		await expect(createAgentDialog.getByPlaceholder('value', { exact: true })).toHaveValue(
			'claude'
		);

		await factoryOption.click();
		await expect(factoryOption).toHaveAttribute('aria-selected', 'true');
		await expect(createAgentDialog.getByPlaceholder('/path/to/factory')).toHaveValue(
			'/opt/e2e/manual/factory-draft'
		);
		await expect(createAgentDialog.getByPlaceholder('--flag value --another-flag')).toHaveValue(
			'--model factory-draft'
		);
		await expect(createAgentDialog.getByPlaceholder('VARIABLE_NAME')).toHaveValue(
			'FACTORY_DRAFT_E2E'
		);
		await expect(createAgentDialog.getByPlaceholder('value', { exact: true })).toHaveValue(
			'factory'
		);
	});

	test('creates an unavailable Claude Code agent with manual static configuration', async () => {
		const staticProjectDir = path.join(seededWorkbench.homeDir, 'claude-static-project');
		fs.mkdirSync(staticProjectDir, { recursive: true });
		await stubAgentDetectionForNewAgent(electronApp);

		const createAgentDialog = await openCreateNewAgentFromQuickActions(window);
		const claudeOption = createAgentDialog.getByRole('option', { name: /Claude Code/ });
		await expect(claudeOption).toContainText('Not Found');
		await claudeOption.click();
		await expect(claudeOption).toHaveAttribute('aria-selected', 'true');

		await createAgentDialog.getByLabel('Agent Name').fill('Claude Static Agent');
		await createAgentDialog.getByLabel('Working Directory').fill(staticProjectDir);
		await createAgentDialog.getByPlaceholder('/path/to/claude').fill('/opt/e2e/manual/claude');
		await createAgentDialog
			.getByPlaceholder('--flag value --another-flag')
			.fill('--model claude-static-e2e');
		await createAgentDialog.getByRole('button', { name: 'Add Variable' }).click();
		await createAgentDialog.getByPlaceholder('VARIABLE_NAME').fill('CLAUDE_STATIC_E2E');
		await createAgentDialog.getByPlaceholder('value', { exact: true }).fill('enabled');

		await expect(createAgentDialog.getByRole('button', { name: 'Create Agent' })).toBeEnabled();
		await createAgentDialog.getByRole('button', { name: 'Create Agent' }).click();
		await expect(createAgentDialog).toBeHidden();

		const sessionList = window.locator('[data-tour="session-list"]');
		const createdAgent = sessionList.getByText('Claude Static Agent', { exact: true });
		await expect(createdAgent).toBeVisible();
		await createdAgent.click();

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Edit Agent');
		await quickActionsDialog
			.getByRole('button', { name: /Edit Agent: Claude Static Agent/ })
			.click();

		const editAgentDialog = window.getByRole('dialog', {
			name: 'Edit Agent: Claude Static Agent',
		});
		await expect(editAgentDialog).toBeVisible();
		await expect(editAgentDialog.getByRole('combobox')).toHaveValue('claude-code');
		await expect(editAgentDialog.getByPlaceholder('/path/to/claude')).toHaveValue(
			'/opt/e2e/manual/claude'
		);
		await expect(editAgentDialog.getByPlaceholder('--flag value --another-flag')).toHaveValue(
			'--model claude-static-e2e'
		);
		await expect(editAgentDialog.getByPlaceholder('VARIABLE_NAME')).toHaveValue(
			'CLAUDE_STATIC_E2E'
		);
		await expect(editAgentDialog.getByPlaceholder('value', { exact: true })).toHaveValue('enabled');
		await editAgentDialog.getByRole('button', { name: 'Cancel' }).click();
		await expect(editAgentDialog).toBeHidden();
	});

	test('creates an unavailable Factory Droid agent with manual static configuration', async () => {
		const staticProjectDir = path.join(seededWorkbench.homeDir, 'factory-static-project');
		fs.mkdirSync(staticProjectDir, { recursive: true });
		await stubAgentDetectionForNewAgent(electronApp);

		const createAgentDialog = await openCreateNewAgentFromQuickActions(window);
		const factoryOption = createAgentDialog.getByRole('option', { name: /Factory Droid/ });
		await expect(factoryOption).toContainText('Beta');
		await factoryOption.click();
		await expect(factoryOption).toHaveAttribute('aria-selected', 'true');

		await createAgentDialog.getByLabel('Agent Name').fill('Factory Static Agent');
		await createAgentDialog.getByLabel('Working Directory').fill(staticProjectDir);
		await createAgentDialog.getByPlaceholder('/path/to/factory').fill('/opt/e2e/manual/factory');
		await createAgentDialog
			.getByPlaceholder('--flag value --another-flag')
			.fill('--model factory-static-e2e');
		await createAgentDialog.getByRole('button', { name: 'Add Variable' }).click();
		await createAgentDialog.getByPlaceholder('VARIABLE_NAME').fill('FACTORY_STATIC_E2E');
		await createAgentDialog.getByPlaceholder('value', { exact: true }).fill('enabled');

		await expect(createAgentDialog.getByRole('button', { name: 'Create Agent' })).toBeEnabled();
		await createAgentDialog.getByRole('button', { name: 'Create Agent' }).click();
		await expect(createAgentDialog).toBeHidden();

		const sessionList = window.locator('[data-tour="session-list"]');
		const createdAgent = sessionList.getByText('Factory Static Agent', { exact: true });
		await expect(createdAgent).toBeVisible();
		await createdAgent.click();

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Edit Agent');
		await quickActionsDialog
			.getByRole('button', { name: /Edit Agent: Factory Static Agent/ })
			.click();

		const editAgentDialog = window.getByRole('dialog', {
			name: 'Edit Agent: Factory Static Agent',
		});
		await expect(editAgentDialog).toBeVisible();
		await expect(editAgentDialog.getByRole('combobox')).toHaveValue('factory-droid');
		await expect(editAgentDialog.getByPlaceholder('/path/to/factory')).toHaveValue(
			'/opt/e2e/manual/factory'
		);
		await expect(editAgentDialog.getByPlaceholder('--flag value --another-flag')).toHaveValue(
			'--model factory-static-e2e'
		);
		await expect(editAgentDialog.getByPlaceholder('VARIABLE_NAME')).toHaveValue(
			'FACTORY_STATIC_E2E'
		);
		await expect(editAgentDialog.getByPlaceholder('value', { exact: true })).toHaveValue('enabled');
		await editAgentDialog.getByRole('button', { name: 'Cancel' }).click();
		await expect(editAgentDialog).toBeHidden();
	});

	test('does not switch Create New Agent setup to coming-soon providers', async () => {
		const comingSoonDir = path.join(seededWorkbench.homeDir, 'coming-soon-provider-project');
		fs.mkdirSync(comingSoonDir, { recursive: true });
		await stubAgentDetectionForNewAgent(electronApp);

		const createAgentDialog = await openCreateNewAgentFromQuickActions(window);
		await createAgentDialog.getByLabel('Agent Name').fill('Gemini Static Agent');
		await createAgentDialog.getByLabel('Working Directory').fill(comingSoonDir);

		const codexOption = createAgentDialog.getByRole('option', { name: /Codex/ });
		const geminiOption = createAgentDialog.getByRole('option', { name: /Gemini CLI/ });
		await expect(codexOption).toHaveAttribute('aria-selected', 'true');
		await expect(geminiOption).toContainText('Coming Soon');
		await geminiOption.click();

		await expect(codexOption).toHaveAttribute('aria-selected', 'true');
		await expect(geminiOption).toHaveAttribute('aria-selected', 'false');
		await expect(createAgentDialog.getByPlaceholder('/path/to/gemini')).toBeHidden();
	});

	test('blocks duplicate agent names and requires directory reuse acknowledgment', async () => {
		await stubAgentDetectionForNewAgent(electronApp);
		const createAgentDialog = await openCreateNewAgentFromQuickActions(window);
		const createButton = createAgentDialog.getByRole('button', { name: 'Create Agent' });

		await createAgentDialog.getByRole('option', { name: /Codex/ }).click();
		await createAgentDialog.getByLabel('Agent Name').fill('E2E Workbench');
		await createAgentDialog
			.getByLabel('Working Directory')
			.fill(path.join(seededWorkbench.homeDir, 'duplicate-name-project'));

		await expect(
			createAgentDialog.getByText('An agent named "E2E Workbench" already exists')
		).toBeVisible();
		await expect(createButton).toBeDisabled();

		await createAgentDialog.getByLabel('Agent Name').fill('Directory Reuse Agent');
		await createAgentDialog.getByLabel('Working Directory').fill(seededWorkbench.sessions[0].cwd);

		await expect(createAgentDialog.getByText(/This directory is already used by/)).toBeVisible();
		await expect(
			createAgentDialog.getByLabel('I understand the risk and want to proceed')
		).toBeVisible();
		await expect(createButton).toBeDisabled();

		await createAgentDialog.getByLabel('I understand the risk and want to proceed').check();
		await expect(createButton).toBeEnabled();
		await createButton.click();

		await expect(createAgentDialog).toBeHidden();
		await expect(
			window.locator('[data-tour="session-list"]').getByText('Directory Reuse Agent', {
				exact: true,
			})
		).toBeVisible();
	});

	test('duplicates an agent from the context menu with folder picker creation', async () => {
		const duplicateDir = path.join(seededWorkbench.homeDir, 'duplicate-agent-copy-project');
		fs.mkdirSync(duplicateDir, { recursive: true });
		await stubAgentDetectionForNewAgent(electronApp);
		await stubSelectFolderDialog(electronApp, duplicateDir);

		const contextMenu = await openSessionContextMenu(window, 'E2E Workbench', 'Duplicate...');
		await contextMenu.getByRole('button', { name: 'Duplicate...', exact: true }).click();

		const createAgentDialog = window.getByRole('dialog', { name: 'Create New Agent' });
		await expect(createAgentDialog).toBeVisible();
		await expect(createAgentDialog.getByRole('option', { name: /Codex/ })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await expect(createAgentDialog.getByLabel('Agent Name')).toHaveValue('E2E Workbench (Copy)');
		await expect(createAgentDialog.getByLabel('Working Directory')).toHaveValue(
			seededWorkbench.sessions[0].cwd
		);
		await expect(createAgentDialog.getByText(/This directory is already used by/)).toBeVisible();

		await createAgentDialog.getByLabel('Agent Name').fill('Duplicated Workbench');
		await createAgentDialog.getByRole('button', { name: /Browse folders/ }).click();
		await expect(createAgentDialog.getByLabel('Working Directory')).toHaveValue(duplicateDir);
		await expect(createAgentDialog.getByText(/This directory is already used by/)).toBeHidden();

		await expect(createAgentDialog.getByRole('button', { name: 'Create Agent' })).toBeEnabled();
		await createAgentDialog.getByRole('button', { name: 'Create Agent' }).click();

		await expect(createAgentDialog).toBeHidden();
		await expect(
			window.locator('[data-tour="session-list"]').getByText('Duplicated Workbench', {
				exact: true,
			})
		).toBeVisible();
	});

	test('cancels and confirms Remove Agent from the context menu without erasing the directory', async () => {
		const sessionList = window.locator('[data-tour="session-list"]');
		const terminalSession = seededWorkbench.sessions[1];
		await expect(sessionList.getByText('E2E Terminal', { exact: true })).toBeVisible();

		let contextMenu = await openSessionContextMenu(window, 'E2E Terminal', 'Remove Agent');
		await contextMenu.getByRole('button', { name: 'Remove Agent', exact: true }).click();

		let confirmDialog = window.getByRole('dialog', { name: 'Confirm Delete' });
		await expect(confirmDialog.getByText('the agent "E2E Terminal"')).toBeVisible();
		await expect(confirmDialog.getByText(terminalSession.cwd)).toBeVisible();
		const eraseButton = confirmDialog.getByRole('button', {
			name: 'Agent + Working Directory',
		});
		await expect(eraseButton).toBeDisabled();
		await confirmDialog.getByLabel('Confirm agent name').fill('E2E Terminal');
		await expect(eraseButton).toBeEnabled();
		await confirmDialog.getByRole('button', { name: 'Cancel' }).click();

		await expect(confirmDialog).toBeHidden();
		await expect(sessionList.getByText('E2E Terminal', { exact: true })).toBeVisible();

		contextMenu = await openSessionContextMenu(window, 'E2E Terminal', 'Remove Agent');
		await contextMenu.getByRole('button', { name: 'Remove Agent', exact: true }).click();

		confirmDialog = window.getByRole('dialog', { name: 'Confirm Delete' });
		await expect(
			confirmDialog.getByRole('button', { name: 'Agent + Working Directory' })
		).toBeDisabled();
		await confirmDialog.getByRole('button', { name: 'Agent Only' }).click();

		await expect(confirmDialog).toBeHidden();
		await expect(sessionList.getByText('E2E Terminal', { exact: true })).toHaveCount(0);
		await expect(sessionList.getByText('E2E Workbench', { exact: true })).toBeVisible();
		expect(fs.existsSync(terminalSession.cwd)).toBe(true);
	});

	test('removes an agent and deletes its working directory after exact-name confirmation', async () => {
		const disposableDir = path.join(seededWorkbench.homeDir, 'delete-working-dir-agent-project');
		fs.mkdirSync(path.join(disposableDir, 'nested'), { recursive: true });
		fs.writeFileSync(path.join(disposableDir, 'nested', 'sentinel.txt'), 'delete me', 'utf-8');
		await stubAgentDetectionForNewAgent(electronApp);

		const createAgentDialog = await openCreateNewAgentFromQuickActions(window);
		await createAgentDialog.getByRole('option', { name: /Codex/ }).click();
		await createAgentDialog.getByLabel('Agent Name').fill('Disposable Delete Agent');
		await createAgentDialog.getByLabel('Working Directory').fill(disposableDir);
		await expect(createAgentDialog.getByRole('button', { name: 'Create Agent' })).toBeEnabled();
		await createAgentDialog.getByRole('button', { name: 'Create Agent' }).click();

		const sessionList = window.locator('[data-tour="session-list"]');
		await expect(sessionList.getByText('Disposable Delete Agent', { exact: true })).toBeVisible();

		const contextMenu = await openSessionContextMenu(
			window,
			'Disposable Delete Agent',
			'Remove Agent'
		);
		await contextMenu.getByRole('button', { name: 'Remove Agent', exact: true }).click();

		const confirmDialog = window.getByRole('dialog', { name: 'Confirm Delete' });
		await expect(confirmDialog.getByText('the agent "Disposable Delete Agent"')).toBeVisible();
		await expect(confirmDialog.getByText(disposableDir)).toBeVisible();
		await confirmDialog.getByLabel('Confirm agent name').fill('Disposable Delete Agent');
		await confirmDialog.getByRole('button', { name: 'Agent + Working Directory' }).click();

		await expect(confirmDialog).toBeHidden();
		await expect(sessionList.getByText('Disposable Delete Agent', { exact: true })).toHaveCount(0);
		expect(fs.existsSync(disposableDir)).toBe(false);
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

	test('saves Edit Agent changes with the keyboard shortcut', async () => {
		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Edit Agent');
		await quickActionsDialog.getByRole('button', { name: /Edit Agent: E2E Workbench/ }).click();

		const editAgentDialog = window.getByRole('dialog', { name: 'Edit Agent: E2E Workbench' });
		await expect(editAgentDialog).toBeVisible();
		await editAgentDialog.getByLabel('Agent Name').fill('Shortcut Edited Workbench');
		await editAgentDialog.getByLabel('Agent Name').press('Control+Enter');

		await expect(editAgentDialog).toBeHidden();
		await expect(
			window
				.locator('[data-tour="session-list"]')
				.getByText('Shortcut Edited Workbench', { exact: true })
		).toBeVisible();
	});

	test('cancels Edit Agent changes without renaming the agent', async () => {
		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Edit Agent');
		await quickActionsDialog.getByRole('button', { name: /Edit Agent: E2E Workbench/ }).click();

		const editAgentDialog = window.getByRole('dialog', { name: 'Edit Agent: E2E Workbench' });
		await expect(editAgentDialog).toBeVisible();
		await editAgentDialog.getByLabel('Agent Name').fill('Unsaved Edit Workbench');
		await editAgentDialog.getByRole('button', { name: 'Cancel' }).click();

		await expect(editAgentDialog).toBeHidden();
		const sessionList = window.locator('[data-tour="session-list"]');
		await expect(sessionList.getByText('E2E Workbench', { exact: true })).toBeVisible();
		await expect(sessionList.getByText('Unsaved Edit Workbench', { exact: true })).toBeHidden();
	});

	test('blocks duplicate names while editing an agent', async () => {
		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Edit Agent');
		await quickActionsDialog.getByRole('button', { name: /Edit Agent: E2E Workbench/ }).click();

		const editAgentDialog = window.getByRole('dialog', { name: 'Edit Agent: E2E Workbench' });
		await expect(editAgentDialog).toBeVisible();

		await editAgentDialog.getByLabel('Agent Name').fill('E2E Terminal');
		await expect(
			editAgentDialog.getByText('An agent named "E2E Terminal" already exists')
		).toBeVisible();
		await expect(editAgentDialog.getByRole('button', { name: 'Save Changes' })).toBeDisabled();

		await editAgentDialog.getByLabel('Agent Name').fill('E2E Workbench');
		await expect(
			editAgentDialog.getByText('An agent named "E2E Terminal" already exists')
		).toBeHidden();
		await expect(editAgentDialog.getByRole('button', { name: 'Save Changes' })).toBeEnabled();
		await editAgentDialog.getByRole('button', { name: 'Cancel' }).click();
		await expect(editAgentDialog).toBeHidden();
	});

	test('persists Edit Agent Codex configuration changes', async () => {
		const openEditAgentDialog = async (): Promise<Locator> => {
			const quickActionsDialog = await openQuickActions(window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Edit Agent');
			await quickActionsDialog.getByRole('button', { name: /Edit Agent: E2E Workbench/ }).click();
			const dialog = window.getByRole('dialog', { name: 'Edit Agent: E2E Workbench' });
			await expect(dialog).toBeVisible();
			return dialog;
		};
		const fieldPanel = (dialog: Locator, label: string): Locator =>
			dialog
				.getByText(label, { exact: true })
				.locator('xpath=ancestor::div[contains(@class, "rounded border")][1]');

		let editAgentDialog = await openEditAgentDialog();
		await editAgentDialog
			.getByPlaceholder('Instructions appended to every message you send...')
			.fill('Keep answers short for E2E.');
		await editAgentDialog
			.getByPlaceholder('--flag value --another-flag')
			.fill('--sandbox read-only --model e2e-edit');

		await editAgentDialog.getByRole('button', { name: 'Add Variable' }).click();
		await editAgentDialog.getByPlaceholder('VARIABLE_NAME').fill('EDIT_AGENT_E2E');
		await editAgentDialog.getByPlaceholder('VARIABLE_NAME').blur();
		await editAgentDialog.getByPlaceholder('value', { exact: true }).fill('enabled');
		await editAgentDialog.getByPlaceholder('value', { exact: true }).blur();

		const modelInput = fieldPanel(editAgentDialog, 'Model').locator('input[type="text"]').first();
		const contextWindowInput = fieldPanel(editAgentDialog, 'Context Window Size')
			.locator('input[type="number"]')
			.first();
		await modelInput.fill('gpt-5.3-codex');
		await modelInput.blur();
		await contextWindowInput.fill('128000');
		await contextWindowInput.blur();

		await editAgentDialog.getByRole('button', { name: 'Save Changes' }).click();
		await expect(editAgentDialog).toBeHidden();

		editAgentDialog = await openEditAgentDialog();
		await expect(
			editAgentDialog.getByPlaceholder('Instructions appended to every message you send...')
		).toHaveValue('Keep answers short for E2E.');
		await expect(editAgentDialog.getByPlaceholder('--flag value --another-flag')).toHaveValue(
			'--sandbox read-only --model e2e-edit'
		);
		await expect(editAgentDialog.getByPlaceholder('VARIABLE_NAME')).toHaveValue('EDIT_AGENT_E2E');
		await expect(editAgentDialog.getByPlaceholder('value', { exact: true })).toHaveValue('enabled');
		await expect(
			fieldPanel(editAgentDialog, 'Model').locator('input[type="text"]').first()
		).toHaveValue('gpt-5.3-codex');
		await expect(
			fieldPanel(editAgentDialog, 'Context Window Size').locator('input[type="number"]').first()
		).toHaveValue('128000');
		await editAgentDialog.getByRole('button', { name: 'Cancel' }).click();
		await expect(editAgentDialog).toBeHidden();
	});

	test('clears Edit Agent custom path arguments and environment overrides', async () => {
		await stubAgentDetectionForNewAgent(electronApp);
		const openEditAgentDialog = async (): Promise<Locator> => {
			const quickActionsDialog = await openQuickActions(window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Edit Agent');
			await quickActionsDialog.getByRole('button', { name: /Edit Agent: E2E Workbench/ }).click();
			const dialog = window.getByRole('dialog', { name: 'Edit Agent: E2E Workbench' });
			await expect(dialog).toBeVisible();
			return dialog;
		};
		const fieldPanel = (dialog: Locator, label: string): Locator =>
			dialog
				.getByText(label, { exact: true })
				.locator('xpath=ancestor::div[contains(@class, "rounded border")][1]');

		let editAgentDialog = await openEditAgentDialog();
		await editAgentDialog.getByPlaceholder('/path/to/codex').fill('/opt/e2e/custom-codex');
		await editAgentDialog
			.getByPlaceholder('--flag value --another-flag')
			.fill('--approval-mode never --sandbox danger-full-access');
		await editAgentDialog.getByRole('button', { name: 'Add Variable' }).click();
		await editAgentDialog.getByPlaceholder('VARIABLE_NAME').fill('EDIT_AGENT_CLEAR_ME');
		await editAgentDialog.getByPlaceholder('VARIABLE_NAME').blur();
		await editAgentDialog.getByPlaceholder('value', { exact: true }).fill('before-clear');
		await editAgentDialog.getByPlaceholder('value', { exact: true }).blur();
		await editAgentDialog.getByRole('button', { name: 'Save Changes' }).click();
		await expect(editAgentDialog).toBeHidden();

		editAgentDialog = await openEditAgentDialog();
		await expect(editAgentDialog.getByPlaceholder('/path/to/codex')).toHaveValue(
			'/opt/e2e/custom-codex'
		);
		await expect(editAgentDialog.getByPlaceholder('--flag value --another-flag')).toHaveValue(
			'--approval-mode never --sandbox danger-full-access'
		);
		await expect(editAgentDialog.getByPlaceholder('VARIABLE_NAME')).toHaveValue(
			'EDIT_AGENT_CLEAR_ME'
		);
		await expect(editAgentDialog.getByPlaceholder('value', { exact: true })).toHaveValue(
			'before-clear'
		);

		await fieldPanel(editAgentDialog, 'Path').getByRole('button', { name: 'Reset' }).click();
		await fieldPanel(editAgentDialog, 'Custom Arguments (optional)')
			.getByRole('button', { name: 'Clear' })
			.click();
		await fieldPanel(editAgentDialog, 'Environment Variables (optional)')
			.getByTitle('Remove variable')
			.click();
		await editAgentDialog.getByRole('button', { name: 'Save Changes' }).click();
		await expect(editAgentDialog).toBeHidden();

		editAgentDialog = await openEditAgentDialog();
		await expect(editAgentDialog.getByPlaceholder('/path/to/codex')).toHaveValue(
			'/usr/local/bin/codex'
		);
		await expect(
			fieldPanel(editAgentDialog, 'Path').getByRole('button', { name: 'Reset' })
		).toBeHidden();
		await expect(editAgentDialog.getByPlaceholder('--flag value --another-flag')).toHaveValue('');
		await expect(editAgentDialog.getByPlaceholder('VARIABLE_NAME')).toBeHidden();
		await expect(editAgentDialog.getByText('EDIT_AGENT_CLEAR_ME')).toBeHidden();
		await editAgentDialog.getByRole('button', { name: 'Cancel' }).click();
		await expect(editAgentDialog).toBeHidden();
	});

	test('requires a custom path before saving an Edit Agent provider switch', async () => {
		await stubAgentDetectionForNewAgent(electronApp);

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Edit Agent');
		await quickActionsDialog.getByRole('button', { name: /Edit Agent: E2E Workbench/ }).click();

		const editAgentDialog = window.getByRole('dialog', { name: 'Edit Agent: E2E Workbench' });
		await expect(editAgentDialog).toBeVisible();
		const saveButton = editAgentDialog.getByRole('button', { name: 'Save Changes' });

		await editAgentDialog.getByRole('combobox').selectOption('opencode');
		await expect(
			editAgentDialog.getByText(/Changing the provider will clear your session list/)
		).toBeVisible();
		await expect(editAgentDialog.getByText('OpenCode Settings')).toBeVisible();

		const providerPath = editAgentDialog.getByPlaceholder('/path/to/opencode');
		await expect(saveButton).toBeDisabled();
		await providerPath.fill('   ');
		await expect(saveButton).toBeDisabled();
		await editAgentDialog
			.getByPlaceholder('--flag value --another-flag')
			.fill('--model opencode-edit-validation-e2e');
		await editAgentDialog.getByRole('button', { name: 'Add Variable' }).click();
		await editAgentDialog.getByPlaceholder('VARIABLE_NAME').fill('OPENCODE_EDIT_VALIDATION_E2E');
		await editAgentDialog.getByPlaceholder('value', { exact: true }).fill('enabled');
		await expect(saveButton).toBeDisabled();

		await providerPath.fill('/usr/local/bin/opencode-edit-validation');
		await expect(saveButton).toBeEnabled();
		await providerPath.fill('');
		await expect(saveButton).toBeDisabled();

		await editAgentDialog.getByRole('button', { name: 'Cancel' }).click();
		await expect(editAgentDialog).toBeHidden();
	});

	test('enables an Edit Agent provider switch after refresh detects the provider', async () => {
		await stubAgentDetectionForNewAgent(electronApp, {
			refreshedAgentId: 'opencode',
			refreshedPath: '/opt/e2e/bin/opencode',
		});

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Edit Agent');
		await quickActionsDialog.getByRole('button', { name: /Edit Agent: E2E Workbench/ }).click();

		const editAgentDialog = window.getByRole('dialog', { name: 'Edit Agent: E2E Workbench' });
		await expect(editAgentDialog).toBeVisible();
		const saveButton = editAgentDialog.getByRole('button', { name: 'Save Changes' });

		await editAgentDialog.getByRole('combobox').selectOption('opencode');
		await expect(editAgentDialog.getByText('OpenCode Settings')).toBeVisible();
		const providerPath = editAgentDialog.getByPlaceholder('/path/to/opencode');
		await expect(providerPath).toHaveValue('');
		await expect(saveButton).toBeDisabled();

		await editAgentDialog.getByTitle('Re-detect agent path').click();

		await expect(providerPath).toHaveValue('/opt/e2e/bin/opencode');
		await expect(saveButton).toBeEnabled();

		await editAgentDialog.getByRole('button', { name: 'Cancel' }).click();
		await expect(editAgentDialog).toBeHidden();
	});

	test('warns and persists Edit Agent provider switch configuration', async () => {
		await stubAgentDetectionForNewAgent(electronApp);

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Edit Agent');
		await quickActionsDialog.getByRole('button', { name: /Edit Agent: E2E Workbench/ }).click();

		let editAgentDialog = window.getByRole('dialog', { name: 'Edit Agent: E2E Workbench' });
		await expect(editAgentDialog).toBeVisible();
		await editAgentDialog.getByRole('combobox').selectOption('opencode');
		await expect(
			editAgentDialog.getByText(/Changing the provider will clear your session list/)
		).toBeVisible();
		await expect(editAgentDialog.getByText('OpenCode Settings')).toBeVisible();
		await editAgentDialog.getByLabel('Agent Name').fill('OpenCode Edited Workbench');
		await editAgentDialog.getByPlaceholder('/path/to/opencode').fill('/usr/local/bin/opencode-e2e');
		await editAgentDialog
			.getByPlaceholder('--flag value --another-flag')
			.fill('--model opencode-e2e');
		await editAgentDialog.getByRole('button', { name: 'Add Variable' }).click();
		await editAgentDialog.getByPlaceholder('VARIABLE_NAME').fill('OPENCODE_EDIT_E2E');
		await editAgentDialog.getByPlaceholder('value', { exact: true }).fill('static');
		await editAgentDialog.getByRole('button', { name: 'Save Changes' }).click();
		await expect(editAgentDialog).toBeHidden();
		await expect(
			window
				.locator('[data-tour="session-list"]')
				.getByText('OpenCode Edited Workbench', { exact: true })
		).toBeVisible();

		const reopenedQuickActionsDialog = await openQuickActions(window);
		await reopenedQuickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Edit Agent');
		await reopenedQuickActionsDialog
			.getByRole('button', { name: /Edit Agent: OpenCode Edited Workbench/ })
			.click();

		editAgentDialog = window.getByRole('dialog', {
			name: 'Edit Agent: OpenCode Edited Workbench',
		});
		await expect(editAgentDialog).toBeVisible();
		await expect(editAgentDialog.getByRole('combobox')).toHaveValue('opencode');
		await expect(
			editAgentDialog.getByText(/Changing the provider will clear your session list/)
		).toBeHidden();
		await expect(editAgentDialog.getByText('OpenCode Settings')).toBeVisible();
		await expect(editAgentDialog.getByPlaceholder('/path/to/opencode')).toHaveValue(
			'/usr/local/bin/opencode-e2e'
		);
		await expect(editAgentDialog.getByPlaceholder('--flag value --another-flag')).toHaveValue(
			'--model opencode-e2e'
		);
		await expect(editAgentDialog.getByPlaceholder('VARIABLE_NAME')).toHaveValue(
			'OPENCODE_EDIT_E2E'
		);
		await expect(editAgentDialog.getByPlaceholder('value', { exact: true })).toHaveValue('static');
		await editAgentDialog.getByRole('button', { name: 'Cancel' }).click();
		await expect(editAgentDialog).toBeHidden();
	});

	test('clears static provider overrides when switching an Edit Agent back to Codex', async () => {
		const staticProjectDir = path.join(seededWorkbench.homeDir, 'opencode-to-codex-project');
		fs.mkdirSync(staticProjectDir, { recursive: true });
		await stubAgentDetectionForNewAgent(electronApp);

		const createAgentDialog = await openCreateNewAgentFromQuickActions(window);
		await createAgentDialog.getByRole('option', { name: /OpenCode/ }).click();
		await createAgentDialog.getByLabel('Agent Name').fill('OpenCode Cleanup Agent');
		await createAgentDialog.getByLabel('Working Directory').fill(staticProjectDir);
		await createAgentDialog
			.getByPlaceholder('/path/to/opencode')
			.fill('/usr/local/bin/opencode-cleanup-e2e');
		await createAgentDialog
			.getByPlaceholder('--flag value --another-flag')
			.fill('--model cleanup-e2e');
		await createAgentDialog.getByRole('button', { name: 'Add Variable' }).click();
		await createAgentDialog.getByPlaceholder('VARIABLE_NAME').fill('OPENCODE_CLEANUP_E2E');
		await createAgentDialog.getByPlaceholder('value', { exact: true }).fill('remove-me');
		await createAgentDialog.getByRole('button', { name: 'Create Agent' }).click();

		let quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Edit Agent');
		await quickActionsDialog
			.getByRole('button', { name: /Edit Agent: OpenCode Cleanup Agent/ })
			.click();

		let editAgentDialog = window.getByRole('dialog', {
			name: 'Edit Agent: OpenCode Cleanup Agent',
		});
		await expect(editAgentDialog).toBeVisible();
		await expect(editAgentDialog.getByRole('combobox')).toHaveValue('opencode');
		await expect(editAgentDialog.getByPlaceholder('/path/to/opencode')).toHaveValue(
			'/usr/local/bin/opencode-cleanup-e2e'
		);
		await editAgentDialog.getByRole('combobox').selectOption('codex');
		await expect(
			editAgentDialog.getByText(/Changing the provider will clear your session list/)
		).toBeVisible();
		await expect(editAgentDialog.getByText('Codex Settings')).toBeVisible();
		await expect(editAgentDialog.getByPlaceholder('/path/to/codex')).toHaveValue(
			'/usr/local/bin/codex'
		);
		await expect(editAgentDialog.getByPlaceholder('--flag value --another-flag')).toHaveValue('');
		await expect(editAgentDialog.getByText('OPENCODE_CLEANUP_E2E')).toBeHidden();
		await expect(editAgentDialog.getByRole('button', { name: 'Save Changes' })).toBeEnabled();
		await editAgentDialog.getByRole('button', { name: 'Save Changes' }).click();
		await expect(editAgentDialog).toBeHidden();

		quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Edit Agent');
		await quickActionsDialog
			.getByRole('button', { name: /Edit Agent: OpenCode Cleanup Agent/ })
			.click();

		editAgentDialog = window.getByRole('dialog', { name: 'Edit Agent: OpenCode Cleanup Agent' });
		await expect(editAgentDialog).toBeVisible();
		await expect(editAgentDialog.getByRole('combobox')).toHaveValue('codex');
		await expect(
			editAgentDialog.getByText(/Changing the provider will clear your session list/)
		).toBeHidden();
		await expect(editAgentDialog.getByText('Codex Settings')).toBeVisible();
		await expect(editAgentDialog.getByPlaceholder('/path/to/codex')).toHaveValue(
			'/usr/local/bin/codex'
		);
		await expect(editAgentDialog.getByPlaceholder('--flag value --another-flag')).toHaveValue('');
		await expect(editAgentDialog.getByText('OPENCODE_CLEANUP_E2E')).toBeHidden();
		await expect(editAgentDialog.getByPlaceholder('/path/to/opencode')).toBeHidden();
		await editAgentDialog.getByRole('button', { name: 'Cancel' }).click();
		await expect(editAgentDialog).toBeHidden();
	});

	test('cancels Edit Agent provider switch without changing the agent', async () => {
		await stubAgentDetectionForNewAgent(electronApp);

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Edit Agent');
		await quickActionsDialog.getByRole('button', { name: /Edit Agent: E2E Workbench/ }).click();

		let editAgentDialog = window.getByRole('dialog', { name: 'Edit Agent: E2E Workbench' });
		await expect(editAgentDialog).toBeVisible();
		await editAgentDialog.getByRole('combobox').selectOption('opencode');
		await expect(
			editAgentDialog.getByText(/Changing the provider will clear your session list/)
		).toBeVisible();
		await editAgentDialog.getByLabel('Agent Name').fill('Canceled Provider Switch');
		await editAgentDialog
			.getByPlaceholder('/path/to/opencode')
			.fill('/usr/local/bin/opencode-cancelled');
		await editAgentDialog.getByRole('button', { name: 'Cancel' }).click();

		await expect(editAgentDialog).toBeHidden();
		const sessionList = window.locator('[data-tour="session-list"]');
		await expect(sessionList.getByText('E2E Workbench', { exact: true })).toBeVisible();
		await expect(sessionList.getByText('Canceled Provider Switch', { exact: true })).toBeHidden();

		const reopenedQuickActionsDialog = await openQuickActions(window);
		await reopenedQuickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Edit Agent');
		await reopenedQuickActionsDialog
			.getByRole('button', { name: /Edit Agent: E2E Workbench/ })
			.click();

		editAgentDialog = window.getByRole('dialog', { name: 'Edit Agent: E2E Workbench' });
		await expect(editAgentDialog).toBeVisible();
		await expect(editAgentDialog.getByRole('combobox')).toHaveValue('codex');
		await expect(
			editAgentDialog.getByText(/Changing the provider will clear your session list/)
		).toBeHidden();
		await expect(editAgentDialog.getByPlaceholder('/path/to/opencode')).toBeHidden();
		await editAgentDialog.getByRole('button', { name: 'Cancel' }).click();
		await expect(editAgentDialog).toBeHidden();
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

	test('cancels System Log Viewer clear confirmation without removing logs', async () => {
		await seedSystemLogs(window);
		const logViewer = await openSystemLogViewer(window);

		await expect(logViewer.getByText('E2E info sentinel')).toBeVisible();
		await logViewer.getByTitle('Clear logs').click();
		const confirmDialog = window.getByRole('dialog', { name: 'Confirm' });
		await expect(confirmDialog).toBeVisible();

		await confirmDialog.getByRole('button', { name: 'Cancel' }).click();
		await expect(confirmDialog).toBeHidden();
		await expect(logViewer.getByText('E2E info sentinel')).toBeVisible();
		await expect(logViewer.getByText('E2E error sentinel')).toBeVisible();
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

	test('opens terminal Process Monitor details with cwd and command line', async () => {
		await stubProcessMonitorProcesses(electronApp, seededWorkbench);
		const processMonitor = await openProcessMonitor(window);

		await expect(processMonitor.getByText('E2E Terminal - Terminal Shell')).toBeVisible();
		await processMonitor.getByText('E2E Terminal - Terminal Shell').dblclick();

		const details = window.getByRole('dialog', { name: 'Process Details' });
		await expect(details).toBeVisible();
		await expect(details.getByText('41002')).toBeVisible();
		await expect(details.getByText('Tool Type')).toBeVisible();
		await expect(
			details
				.locator('span')
				.filter({ hasText: /^terminal$/ })
				.first()
		).toBeVisible();
		await expect(details.getByText('Working Directory')).toBeVisible();
		await expect(details.getByText(seededWorkbench.sessions[1].cwd)).toBeVisible();
		await expect(details.getByText('zsh -l')).toBeVisible();
	});

	test('supports Process Monitor keyboard refresh and detail navigation', async () => {
		await stubProcessMonitorProcesses(electronApp, seededWorkbench);
		const processMonitor = await openProcessMonitor(window);

		await expect(processMonitor.getByText('E2E Workbench - AI Agent (codex)')).toBeVisible();
		const fetchCountBeforeRefresh = await getStubbedActiveProcessFetchCount(electronApp);
		await window.keyboard.press('R');
		await expect
			.poll(() => getStubbedActiveProcessFetchCount(electronApp))
			.toBeGreaterThan(fetchCountBeforeRefresh);
		await expect(processMonitor.getByText('2 active')).toBeVisible();

		await window.keyboard.press('ArrowDown');
		await window.keyboard.press('ArrowRight');
		await window.keyboard.press('ArrowRight');
		await window.keyboard.press('Enter');

		const details = window.getByRole('dialog', { name: 'Process Details' });
		await expect(details).toBeVisible();
		await expect(details.getByText('Command Line')).toBeVisible();
		await expect(details.getByText('codex --model gpt-5-codex')).toBeVisible();

		await window.keyboard.press('Escape');
		await expect(window.getByRole('dialog', { name: 'System Processes' })).toBeVisible();
	});

	test('renders wizard processes in the Process Monitor tree and details', async () => {
		await stubProcessMonitorWizardProcesses(electronApp, seededWorkbench);
		const processMonitor = await openProcessMonitor(window);

		await expect(processMonitor.getByText('4 active')).toBeVisible();
		await expect(processMonitor.getByText('WIZARD PROCESSES')).toBeVisible();
		await expect(processMonitor.getByText('Wizard Conversation')).toBeVisible();
		await expect(processMonitor.getByText('Playbook Generation')).toBeVisible();
		await expect(processMonitor.getByText('WIZARD', { exact: true })).toBeVisible();
		await expect(processMonitor.getByText('GENERATING', { exact: true })).toBeVisible();

		await processMonitor.getByText('Playbook Generation').dblclick();
		const details = window.getByRole('dialog', { name: 'Process Details' });
		await expect(details).toBeVisible();
		await expect(details.getByText('inline-wizard-gen-1780097000000-e2e')).toBeVisible();
		await expect(details.getByText('Process Type')).toBeVisible();
		await expect(
			details
				.locator('span')
				.filter({ hasText: /^wizard-gen$/ })
				.first()
		).toBeVisible();
		await expect(details.getByText('codex --generate-playbook')).toBeVisible();
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

	test('confirms Process Monitor kill with keyboard Enter', async () => {
		await stubProcessMonitorProcesses(electronApp, seededWorkbench);
		const processMonitor = await openProcessMonitor(window);

		await expect(processMonitor.getByText('2 active')).toBeVisible();
		await processMonitor.getByTitle('Kill process').last().click({ force: true });
		await expect(window.getByText('Kill Process?')).toBeVisible();

		await window.keyboard.press('Enter');
		await expect(window.getByText('Kill Process?')).toBeHidden();
		await expect(processMonitor.getByText('1 active')).toBeVisible();
		await expect(await getStubbedKilledProcessIds(electronApp)).toEqual([
			`${seededWorkbench.sessions[1].id}-terminal`,
		]);
	});

	test('kills a stubbed terminal process and refreshes the Process Monitor list', async () => {
		await stubProcessMonitorProcesses(electronApp, seededWorkbench);
		const processMonitor = await openProcessMonitor(window);

		await expect(processMonitor.getByText('2 active')).toBeVisible();
		await processMonitor.getByTitle('Kill process').last().click({ force: true });
		await expect(window.getByText('Kill Process?')).toBeVisible();
		await window.getByRole('button', { name: 'Kill Process', exact: true }).click();

		await expect(window.getByText('Kill Process?')).toBeHidden();
		await expect(processMonitor.getByText('1 active')).toBeVisible();
		await expect(processMonitor.getByText('E2E Terminal - Terminal Shell')).toBeHidden();
		await expect(processMonitor.getByText('E2E Workbench - AI Agent (codex)')).toBeVisible();
		await expect(await getStubbedKilledProcessIds(electronApp)).toEqual([
			`${seededWorkbench.sessions[1].id}-terminal`,
		]);
	});

	test('cancels Process Monitor kill with Escape without removing the process', async () => {
		await stubProcessMonitorProcesses(electronApp, seededWorkbench);
		const processMonitor = await openProcessMonitor(window);

		await expect(processMonitor.getByText('E2E Terminal - Terminal Shell')).toBeVisible();
		await processMonitor.getByTitle('Kill process').first().click({ force: true });
		await expect(window.getByText('Kill Process?')).toBeVisible();

		await window.keyboard.press('Escape');
		await expect(window.getByText('Kill Process?')).toBeHidden();
		await expect(processMonitor).toBeVisible();
		await expect(processMonitor.getByText('E2E Terminal - Terminal Shell')).toBeVisible();
		await expect(await getStubbedKilledProcessIds(electronApp)).toEqual([]);
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

	test('shows the Usage Dashboard empty state before usage is recorded', async () => {
		const usageDashboard = await openUsageDashboard(window);

		await expect(usageDashboard.getByTestId('usage-dashboard-empty')).toBeVisible();
		await expect(usageDashboard.getByText('No usage data yet')).toBeVisible();
		await expect(usageDashboard.getByText('Start using Maestro to see your stats!')).toBeVisible();
		await expect(usageDashboard.getByText('No data for selected time range')).toBeVisible();
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

	test('updates Usage Dashboard time range footer for seeded stats', async () => {
		await seedUsageDashboardStats(window);
		const usageDashboard = await openUsageDashboard(window);
		const timeRange = usageDashboard.locator('select').first();

		await timeRange.selectOption('all');
		await expect(usageDashboard.getByText('Showing all time data')).toBeVisible();

		await timeRange.selectOption('day');
		await expect(usageDashboard.getByText('Showing today data')).toBeVisible();
	});

	test('shows remaining Usage Dashboard overview chart sections for seeded stats', async () => {
		await seedUsageDashboardStats(window);
		const usageDashboard = await openUsageDashboard(window);

		await expect(usageDashboard.getByTestId('section-peak-hours')).toBeVisible();
		await expect(usageDashboard.getByTestId('section-activity-heatmap')).toBeVisible();
		await expect(usageDashboard.getByTestId('section-duration-trends')).toBeVisible();
	});

	test('exports seeded Usage Dashboard query data to CSV', async () => {
		await seedUsageDashboardStats(window);
		const exportPath = path.join(seededWorkbench.homeDir, 'usage-dashboard-export.csv');
		await stubUsageDashboardCsvSave(electronApp, exportPath);
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.locator('select').first().selectOption('all');
		await usageDashboard.getByRole('button', { name: /Export CSV/ }).click();

		await expect.poll(() => fs.existsSync(exportPath)).toBe(true);
		const csv = fs.readFileSync(exportPath, 'utf-8');
		expect(csv).toContain('sessionId,agentType,source,startTime,duration');
		expect(csv).toContain('session-shell-codex-usage-dashboard');
		expect(csv).toContain('codex');
		expect(csv).toContain('/tmp/maestro-e2e-usage-dashboard');
	});

	test('cycles Usage Dashboard views with global tab shortcuts', async () => {
		await seedUsageDashboardStats(window);
		const usageDashboard = await openUsageDashboard(window);

		await window.keyboard.press('Meta+Shift+]');
		await expect(usageDashboard.getByRole('tab', { name: 'Agents' })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await window.keyboard.press('Meta+Shift+]');
		await expect(usageDashboard.getByRole('tab', { name: 'Activity' })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await window.keyboard.press('Meta+Shift+[');
		await expect(usageDashboard.getByRole('tab', { name: 'Agents' })).toHaveAttribute(
			'aria-selected',
			'true'
		);
	});

	test('shows the Usage Dashboard real-time update indicator after new stats arrive', async () => {
		await seedUsageDashboardStats(window);
		const usageDashboard = await openUsageDashboard(window);

		await window.evaluate(async () => {
			await window.maestro.stats.recordQuery({
				sessionId: 'session-shell-codex-usage-dashboard',
				agentType: 'codex',
				source: 'user',
				startTime: Date.now(),
				duration: 30_000,
				projectPath: '/tmp/maestro-e2e-usage-dashboard',
				tabId: 'usage-live-update',
				isRemote: false,
			});
		});

		await expect(usageDashboard.getByTestId('new-data-indicator')).toBeVisible({ timeout: 5000 });
		await expect(usageDashboard.getByText('Updated')).toBeVisible();
	});

	test('renders Usage Dashboard agent statistics and toggles agent usage metrics', async () => {
		await seedUsageDashboardStats(window);
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Agents' }).click();
		await expect(usageDashboard.getByRole('tab', { name: 'Agents' })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await expect(usageDashboard.getByTestId('section-session-stats')).toBeVisible();
		await expect(usageDashboard.getByText('Agent Statistics')).toBeVisible();
		await expect(usageDashboard.getByText('Total Agents')).toBeVisible();
		await expect(usageDashboard.getByText('Git Repositories')).toBeVisible();
		const agentEfficiencyChart = usageDashboard.getByTestId('agent-efficiency-chart');
		await expect(agentEfficiencyChart).toBeVisible();
		await expect(agentEfficiencyChart.getByText('Agent Efficiency')).toBeVisible();
		await expect(agentEfficiencyChart.getByText('2 queries')).toBeVisible();

		const agentUsageSection = usageDashboard.getByTestId('section-agent-usage');
		await expect(
			agentUsageSection.getByRole('figure', { name: /query counts over time/i })
		).toBeVisible();
		await agentUsageSection.getByRole('button', { name: 'Time' }).click();
		await expect(
			agentUsageSection.getByRole('figure', { name: /duration over time/i })
		).toBeVisible();
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

	test('renders Usage Dashboard Auto Run task timing chart and longest-run table details', async () => {
		await seedUsageDashboardStats(window);
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Auto Run' }).click();
		await expect(usageDashboard.getByTestId('autorun-metrics')).toBeVisible();
		await expect(usageDashboard.getByText('Success Rate')).toBeVisible();
		await expect(usageDashboard.getByText('80%')).toBeVisible();
		await expect(usageDashboard.getByTestId('autorun-tasks-chart')).toBeVisible();
		await expect(usageDashboard.getByTestId('tasks-by-hour-chart')).toBeVisible();
		await expect(usageDashboard.getByText(/Peak hours:/)).toBeVisible();

		const longestRuns = usageDashboard.getByTestId('longest-autoruns-table');
		await expect(longestRuns).toBeVisible();
		await expect(longestRuns.getByText('Phase 1.md')).toBeVisible();
		await expect(longestRuns.getByText('4 / 5')).toBeVisible();
		await expect(longestRuns.getByText('usage-dashboard')).toBeVisible();
	});

	test('recovers the Usage Dashboard after a stats aggregation retry', async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			let attempts = 0;
			ipcMain.removeHandler('stats:get-aggregation');
			ipcMain.handle('stats:get-aggregation', async () => {
				attempts += 1;
				if (attempts === 1) {
					throw new Error('E2E stats aggregation unavailable');
				}
				const date = new Date().toISOString().slice(0, 10);
				return {
					totalQueries: 1,
					totalDuration: 60_000,
					avgDuration: 60_000,
					byAgent: { codex: { count: 1, duration: 60_000 } },
					bySource: { user: 1, auto: 0 },
					byLocation: { local: 1, remote: 0 },
					byDay: [{ date, count: 1, duration: 60_000 }],
					byHour: [{ hour: 10, count: 1, duration: 60_000 }],
					totalSessions: 0,
					sessionsByAgent: {},
					sessionsByDay: [],
					avgSessionDuration: 0,
					byAgentByDay: {
						codex: [{ date, count: 1, duration: 60_000 }],
					},
					bySessionByDay: {
						'session-shell-codex-usage-dashboard': [{ date, count: 1, duration: 60_000 }],
					},
				};
			});
		});

		const usageDashboard = await openUsageDashboard(window);
		await expect(usageDashboard.getByText('Failed to load usage data')).toBeVisible();

		await usageDashboard.getByRole('button', { name: 'Retry' }).click();
		await expect(usageDashboard.getByTestId('usage-dashboard-content')).toBeVisible();
		await expect(usageDashboard.getByTestId('summary-cards')).toBeVisible();
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
		const agentSessions = await openAgentSessions(window);

		await expect(agentSessions.getByText('Agent Sessions for E2E Workbench')).toBeVisible();
		await expect(agentSessions.getByRole('button', { name: 'New Session' })).toBeVisible();
		await expect(agentSessions.getByPlaceholder('Search all content...')).toBeVisible();
		await expect(agentSessions.getByRole('checkbox', { name: 'Named' })).toBeVisible();
		await expect(agentSessions.getByRole('checkbox', { name: 'Show All' })).toBeVisible();
		await expect(agentSessions.getByText('No agent sessions found for this project')).toBeVisible();
	});

	test('creates a fresh AI tab from the Agent Sessions New Session action', async () => {
		const tabRows = window.locator('[data-tab-id]');
		await expect(tabRows.first()).toBeVisible();
		const initialTabCount = await tabRows.count();
		const agentSessions = await openAgentSessions(window);

		await agentSessions.getByRole('button', { name: 'New Session' }).click();

		await expect(agentSessions.getByText('Agent Sessions for E2E Workbench')).toBeHidden();
		await expect(tabRows).toHaveCount(initialTabCount + 1);
		await expect(
			window.locator('[data-tab-id]').filter({ hasText: 'New Session' }).first()
		).toBeVisible();
		await expect(window.getByTitle('Send message')).toBeVisible();
	});

	test('quick-resumes an Agent Sessions list row without opening detail', async () => {
		await stubCodexAgentSessions(electronApp, seededWorkbench);
		const tabRows = window.locator('[data-tab-id]');
		await expect(tabRows.first()).toBeVisible();
		const initialTabCount = await tabRows.count();
		const agentSessions = await openAgentSessions(window);

		await expect(agentSessions.getByText('Review Checkpoint')).toBeVisible();
		await expect(
			agentSessions.getByText('Please review deterministic risk coverage.')
		).toBeHidden();
		const reviewRow = agentSessions
			.getByText('Review Checkpoint')
			.locator('xpath=ancestor::div[contains(@class, "cursor-pointer")][1]');
		await reviewRow.hover();
		await reviewRow.getByTitle('Resume session in new tab').click();

		await expect(agentSessions.getByText('Agent Sessions for E2E Workbench')).toBeHidden();
		await expect(tabRows).toHaveCount(initialTabCount + 1);
		await expect(
			window.locator('[data-tab-id]').filter({ hasText: 'Review Checkpoint' }).first()
		).toBeVisible();
		await expect(window.getByTitle('Send message')).toBeVisible();
	});

	test('preserves Agent Sessions list-row metadata when quick-resuming', async () => {
		await stubCodexAgentSessions(electronApp, seededWorkbench);
		const tabRows = window.locator('[data-tab-id]');
		await expect(tabRows.first()).toBeVisible();
		const initialTabCount = await tabRows.count();
		const agentSessions = await openAgentSessions(window);
		const reviewRow = agentSessions
			.getByText('Review Checkpoint')
			.locator('xpath=ancestor::div[contains(@class, "cursor-pointer")][1]');

		await reviewRow.hover();
		await reviewRow.getByTitle('Resume session in new tab').click();

		await expect(agentSessions.getByText('Agent Sessions for E2E Workbench')).toBeHidden();
		await expect(tabRows).toHaveCount(initialTabCount + 1);
		await expect(await getStubbedAgentSessionReadCalls(electronApp)).toEqual([
			{ sessionId: 'codex-review-session', offset: 0, limit: 100 },
		]);

		const resumedTab = window
			.locator('[data-tab-id]')
			.filter({ hasText: 'Review Checkpoint' })
			.first();
		await expect(resumedTab).toBeVisible();
		await resumedTab.hover();
		await expect(window.getByText('codex-review-session')).toBeVisible();
		await expect(window.getByRole('button', { name: 'Unstar Session' })).toBeVisible();
	});

	test('syncs Agent Sessions restored tab favorite changes from the tab overlay', async () => {
		await stubCodexAgentSessions(electronApp, seededWorkbench);
		const agentSessions = await openAgentSessions(window);
		const reviewRow = agentSessions
			.getByText('Review Checkpoint')
			.locator('xpath=ancestor::div[contains(@class, "cursor-pointer")][1]');

		await reviewRow.hover();
		await reviewRow.getByTitle('Resume session in new tab').click();
		await expect(agentSessions.getByText('Agent Sessions for E2E Workbench')).toBeHidden();

		const resumedTab = window
			.locator('[data-tab-id]')
			.filter({ hasText: 'Review Checkpoint' })
			.first();
		await expect(resumedTab).toBeVisible();
		await resumedTab.hover();
		await window.getByRole('button', { name: 'Unstar Session' }).click();

		await expect(window.getByRole('button', { name: 'Star Session' })).toBeVisible();
		await expect(await getStubbedAgentSessionUpdates(electronApp)).toContainEqual({
			type: 'starred',
			sessionId: 'codex-review-session',
			starred: false,
		});
	});

	test('lists filters and opens stubbed Codex agent sessions', async () => {
		await stubCodexAgentSessions(electronApp, seededWorkbench);
		const agentSessions = await openAgentSessions(window);

		await expect(agentSessions.getByText('3 sessions')).toBeVisible();
		await expect(agentSessions.getByText('Review Checkpoint')).toBeVisible();
		await expect(agentSessions.getByText('Implementation Draft')).toBeVisible();
		await expect(agentSessions.getByText('Unnamed CLI sentinel session')).toBeVisible();
		await expect(agentSessions.getByTitle('User-initiated through Maestro')).toBeVisible();
		await expect(agentSessions.getByTitle('Auto-run session')).toBeVisible();
		await expect(agentSessions.getByTitle('Claude Code CLI session')).toBeVisible();

		await agentSessions.getByRole('checkbox', { name: 'Named' }).check();
		await expect(agentSessions.getByText('Unnamed CLI sentinel session')).toBeHidden();
		await agentSessions.getByRole('checkbox', { name: 'Named' }).uncheck();

		await agentSessions.getByPlaceholder('Search all content...').fill('Implementation');
		await expect(agentSessions.getByText('Implementation Draft')).toBeVisible();
		await expect(agentSessions.getByText('Review Checkpoint')).toBeHidden();

		await agentSessions.getByText('Implementation Draft').click();
		await expect(agentSessions.getByText('Need final implementation details.')).toBeVisible();
		await expect(agentSessions.getByText('Implementation response sentinel')).toBeVisible();
		await expect(agentSessions.getByText('$0.04')).toBeVisible();

		await window.keyboard.press('Escape');
		await expect(agentSessions.getByPlaceholder('Search all content...')).toBeVisible();
	});

	test('opens Agent Sessions list rows with keyboard navigation', async () => {
		await stubCodexAgentSessions(electronApp, seededWorkbench);
		const agentSessions = await openAgentSessions(window);
		const searchInput = agentSessions.getByPlaceholder('Search all content...');

		await expect(agentSessions.getByText('Review Checkpoint')).toBeVisible();
		await expect(agentSessions.getByText('Implementation Draft')).toBeVisible();
		await searchInput.focus();
		await searchInput.press('ArrowDown');
		await searchInput.press('Enter');

		await expect(agentSessions.getByText('Need final implementation details.')).toBeVisible();
		await expect(agentSessions.getByText('Implementation response sentinel')).toBeVisible();

		await window.keyboard.press('Escape');
		await expect(searchInput).toBeVisible();
		await expect(agentSessions.getByText('Review Checkpoint')).toBeVisible();
		await expect(agentSessions.getByText('Implementation Draft')).toBeVisible();
	});

	test('reveals hidden agent-prefixed sessions with the Agent Sessions Show All filter', async () => {
		await stubCodexAgentSessions(electronApp, seededWorkbench, {
			includeHiddenAgentSession: true,
		});
		const agentSessions = await openAgentSessions(window);

		const hiddenSession = agentSessions.getByText('Hidden Agent Run');
		await expect(hiddenSession).toBeHidden();
		await expect(agentSessions.getByText('Review Checkpoint')).toBeVisible();

		await agentSessions.getByRole('checkbox', { name: 'Show All' }).check();
		await expect(hiddenSession).toBeVisible();
		await expect(agentSessions.getByText('Hidden automation sentinel session')).toBeVisible();

		await agentSessions.getByRole('checkbox', { name: 'Show All' }).uncheck();
		await expect(hiddenSession).toBeHidden();
		await expect(agentSessions.getByText('Review Checkpoint')).toBeVisible();
	});

	test('filters Agent Sessions list to named sessions and restores unnamed rows', async () => {
		await stubCodexAgentSessions(electronApp, seededWorkbench);
		const agentSessions = await openAgentSessions(window);

		const namedFilter = agentSessions.getByRole('checkbox', { name: 'Named' });
		const unnamedSession = agentSessions.getByText('Unnamed CLI sentinel session');

		await expect(namedFilter).not.toBeChecked();
		await expect(agentSessions.getByText('Review Checkpoint')).toBeVisible();
		await expect(agentSessions.getByText('Implementation Draft')).toBeVisible();
		await expect(unnamedSession).toBeVisible();

		await namedFilter.check();
		await expect(namedFilter).toBeChecked();
		await expect(agentSessions.getByText('Review Checkpoint')).toBeVisible();
		await expect(agentSessions.getByText('Implementation Draft')).toBeVisible();
		await expect(unnamedSession).toBeHidden();

		await namedFilter.uncheck();
		await expect(namedFilter).not.toBeChecked();
		await expect(unnamedSession).toBeVisible();
	});

	test('loads earlier messages in a stubbed Codex agent session detail view', async () => {
		await stubCodexAgentSessions(electronApp, seededWorkbench, {
			paginatedReviewMessages: true,
		});
		const agentSessions = await openAgentSessions(window);

		await agentSessions.getByText('Review Checkpoint').click();
		const messagesRegion = agentSessions.getByRole('region', { name: 'Session messages' });
		await expect(
			messagesRegion.getByText('Please review deterministic risk coverage.')
		).toBeVisible();
		await expect(
			messagesRegion.getByText('Earlier planning sentinel before the visible page.')
		).toBeHidden();
		await expect(agentSessions.getByText('4 messages')).toBeVisible();

		await agentSessions.getByRole('button', { name: 'Load earlier messages...' }).click();

		await expect(
			messagesRegion.getByText('Earlier planning sentinel before the visible page.')
		).toBeVisible();
		await expect(
			messagesRegion.getByText('Earlier assistant sentinel before the visible page.')
		).toBeVisible();
		await expect(
			agentSessions.getByRole('button', { name: 'Load earlier messages...' })
		).toBeHidden();
		await expect(await getStubbedAgentSessionReadCalls(electronApp)).toEqual([
			{ sessionId: 'codex-review-session', offset: 0, limit: 20 },
			{ sessionId: 'codex-review-session', offset: 2, limit: 20 },
		]);
	});

	test('uses Agent Sessions detail controls to favorite rename and resume history', async () => {
		await stubCodexAgentSessions(electronApp, seededWorkbench);
		const agentSessions = await openAgentSessions(window);

		await agentSessions.getByText('Review Checkpoint').click();
		await expect(
			agentSessions.getByText('Please review deterministic risk coverage.')
		).toBeVisible();

		await agentSessions.getByTitle('Remove from favorites').click();
		await expect(agentSessions.getByTitle('Add to favorites')).toBeVisible();
		await agentSessions.getByTitle('Rename session').click();
		const renameInput = agentSessions.getByPlaceholder('Enter session name...');
		await renameInput.fill('Detail Review Session');
		await renameInput.press('Enter');

		await expect(agentSessions.getByText('Detail Review Session')).toBeVisible();
		await agentSessions.getByRole('button', { name: 'Resume' }).click();

		await expect(agentSessions.getByText('Agent Sessions for E2E Workbench')).toBeHidden();
		await expect(
			window.locator('[data-tab-id]').filter({ hasText: 'Detail Review Session' }).first()
		).toBeVisible();
		await expect(window.getByText('Please review deterministic risk coverage.')).toBeVisible();
		await expect(
			window.getByText('Refactor response sentinel: keep fixtures local and deterministic.')
		).toBeVisible();
		const updates = await getStubbedAgentSessionUpdates(electronApp);
		await expect(updates).toContainEqual({
			type: 'starred',
			sessionId: 'codex-review-session',
			starred: false,
		});
		await expect(updates).toContainEqual({
			type: 'name',
			sessionId: 'codex-review-session',
			name: 'Detail Review Session',
		});
	});

	test('cancels an Agent Sessions detail rename with Escape', async () => {
		await stubCodexAgentSessions(electronApp, seededWorkbench);
		const agentSessions = await openAgentSessions(window);

		await agentSessions.getByText('Review Checkpoint').click();
		await expect(
			agentSessions.getByText('Please review deterministic risk coverage.')
		).toBeVisible();

		await agentSessions.getByTitle('Rename session').click();
		const renameInput = agentSessions.getByPlaceholder('Enter session name...');
		await expect(renameInput).toHaveValue('Review Checkpoint');
		await renameInput.fill('Discarded Detail Rename');
		await renameInput.press('Escape');

		await expect(renameInput).toBeHidden();
		await expect(agentSessions.getByText('Review Checkpoint')).toBeVisible();
		await expect(agentSessions.getByText('Discarded Detail Rename')).toBeHidden();
		expect(
			(await getStubbedAgentSessionUpdates(electronApp)).filter((update) => update.type === 'name')
		).toEqual([]);
	});

	test('clears an Agent Sessions detail name back to the session id', async () => {
		await stubCodexAgentSessions(electronApp, seededWorkbench);
		const agentSessions = await openAgentSessions(window);

		await agentSessions.getByText('Review Checkpoint').click();
		await expect(
			agentSessions.getByText('Please review deterministic risk coverage.')
		).toBeVisible();

		await agentSessions.getByTitle('Rename session').click();
		const renameInput = agentSessions.getByPlaceholder('Enter session name...');
		await expect(renameInput).toHaveValue('Review Checkpoint');
		await renameInput.fill('');
		await renameInput.press('Enter');

		await expect(agentSessions.getByText('CODEX-REVIEW-SESSION')).toBeVisible();
		await expect(agentSessions.getByTitle('Add session name')).toBeVisible();

		const updates = await getStubbedAgentSessionUpdates(electronApp);
		await expect(updates).toContainEqual({
			type: 'name',
			sessionId: 'codex-review-session',
			name: null,
		});
	});

	test('adds an Agent Sessions detail name and resumes with the keyboard', async () => {
		await stubCodexAgentSessions(electronApp, seededWorkbench);
		const agentSessions = await openAgentSessions(window);

		await agentSessions.getByText('Unnamed CLI sentinel session').click();
		await expect(agentSessions.getByText('Unnamed CLI message sentinel.')).toBeVisible();
		await agentSessions.getByTitle('Add session name').click();
		const renameInput = agentSessions.getByPlaceholder('Enter session name...');
		await renameInput.fill('Named CLI Session');
		await renameInput.press('Enter');

		await expect(agentSessions.getByText('Named CLI Session')).toBeVisible();
		const messagesRegion = agentSessions.getByRole('region', { name: 'Session messages' });
		await messagesRegion.focus();
		await expect(messagesRegion).toBeFocused();
		await messagesRegion.press('Enter');

		await expect(agentSessions.getByText('Agent Sessions for E2E Workbench')).toBeHidden();
		await expect(
			window.locator('[data-tab-id]').filter({ hasText: 'Named CLI Session' }).first()
		).toBeVisible();
		await expect(window.getByText('Unnamed CLI message sentinel.')).toBeVisible();
		await expect(await getStubbedAgentSessionUpdates(electronApp)).toContainEqual({
			type: 'name',
			sessionId: 'codex-cli-session',
			name: 'Named CLI Session',
		});
	});

	test('searches stars and renames stubbed Codex agent sessions', async () => {
		await stubCodexAgentSessions(electronApp, seededWorkbench);
		const agentSessions = await openAgentSessions(window);

		await agentSessions.getByPlaceholder('Search all content...').fill('refactor sentinel');
		await expect(agentSessions.getByText('Refactor response sentinel')).toBeVisible();
		await expect(agentSessions.getByText('Review Checkpoint')).toBeVisible();
		await expect(agentSessions.getByText('Implementation Draft')).toBeHidden();
		await expect(await getStubbedAgentSessionSearchCalls(electronApp)).toContainEqual({
			agentId: 'codex',
			projectPath: seededWorkbench.sessions[0].projectRoot,
			query: 'refactor sentinel',
			mode: 'all',
		});

		await agentSessions.getByTitle('Remove from favorites').click();
		await agentSessions.getByTitle('Rename session').click({ force: true });
		const renameInput = agentSessions.getByPlaceholder('Enter session name...');
		await renameInput.fill('Renamed Review Session');
		await renameInput.press('Enter');

		await expect(agentSessions.getByText('Renamed Review Session')).toBeVisible();
		const updates = await getStubbedAgentSessionUpdates(electronApp);
		await expect(updates).toContainEqual({
			type: 'starred',
			sessionId: 'codex-review-session',
			starred: false,
		});
		await expect(updates).toContainEqual({
			type: 'name',
			sessionId: 'codex-review-session',
			name: 'Renamed Review Session',
		});
	});

	test('switches Agent Sessions search modes and scopes content searches', async () => {
		await stubCodexAgentSessions(electronApp, seededWorkbench);
		const agentSessions = await openAgentSessions(window);

		await agentSessions.getByRole('button', { name: /^All$/ }).click();
		await agentSessions.getByRole('button', { name: 'My Messages' }).click();
		await expect(agentSessions.getByPlaceholder('Search your messages...')).toBeVisible();
		await agentSessions.getByPlaceholder('Search your messages...').fill('review coverage');
		await expect(
			agentSessions.getByText('Please review deterministic risk coverage')
		).toBeVisible();

		await agentSessions.getByRole('button', { name: /^user$/i }).click();
		await agentSessions.getByRole('button', { name: 'AI Responses' }).click();
		await expect(agentSessions.getByPlaceholder('Search AI responses...')).toBeVisible();
		await agentSessions.getByPlaceholder('Search AI responses...').fill('implementation sentinel');
		await expect(agentSessions.getByText('Implementation response sentinel')).toBeVisible();

		await agentSessions.getByRole('button', { name: /^assistant$/i }).click();
		await agentSessions.getByRole('button', { name: 'Title Only' }).click();
		await expect(agentSessions.getByPlaceholder('Search titles...')).toBeVisible();
		await agentSessions.getByPlaceholder('Search titles...').fill('Implementation');
		await expect(agentSessions.getByText('Implementation Draft')).toBeVisible();
		await expect(agentSessions.getByText('Review Checkpoint')).toBeHidden();

		const searchCalls = await getStubbedAgentSessionSearchCalls(electronApp);
		await expect(searchCalls).toContainEqual({
			agentId: 'codex',
			projectPath: seededWorkbench.sessions[0].projectRoot,
			query: 'review coverage',
			mode: 'user',
		});
		await expect(searchCalls).toContainEqual({
			agentId: 'codex',
			projectPath: seededWorkbench.sessions[0].projectRoot,
			query: 'implementation sentinel',
			mode: 'assistant',
		});
		await expect(searchCalls).not.toContainEqual(
			expect.objectContaining({
				mode: 'title',
			})
		);
	});

	test('toggles Agent Sessions activity graph lookback and returns to search', async () => {
		await stubCodexAgentSessions(electronApp, seededWorkbench);
		const agentSessions = await openAgentSessions(window);

		await agentSessions.getByTitle('Show activity graph').click();
		await expect(agentSessions.getByPlaceholder('Search all content...')).toBeHidden();
		const allTimeGraph = agentSessions.getByTitle(/All time: 3 sessions/);
		await expect(allTimeGraph).toBeVisible();

		await allTimeGraph.click({ button: 'right' });
		await expect(agentSessions.getByText('Lookback Period')).toBeVisible();
		await agentSessions.getByRole('button', { name: '24 hours' }).click();
		await expect(agentSessions.getByTitle(/24 hours: 3 sessions/)).toBeVisible();

		await agentSessions.getByTitle(/Search sessions/).click();
		await expect(agentSessions.getByPlaceholder('Search all content...')).toBeVisible();
	});

	test('opens Agent Sessions search from the activity graph shortcut and clears empty results', async () => {
		await stubCodexAgentSessions(electronApp, seededWorkbench);
		const agentSessions = await openAgentSessions(window);

		await agentSessions.getByTitle('Show activity graph').click();
		await expect(agentSessions.getByTitle(/All time: 3 sessions/)).toBeVisible();
		await expect(agentSessions.getByPlaceholder('Search all content...')).toBeHidden();

		await window.keyboard.press('Control+f');
		const searchInput = agentSessions.getByPlaceholder('Search all content...');
		await expect(searchInput).toBeVisible();
		await expect(searchInput).toBeFocused();

		await searchInput.fill('missing agent session sentinel');
		await expect(agentSessions.getByText('No sessions match your search')).toBeVisible();
		await expect(agentSessions.getByText('Review Checkpoint')).toBeHidden();

		await agentSessions.locator('input[placeholder="Search all content..."] + button').click();
		await expect(searchInput).toHaveValue('');
		await expect(agentSessions.getByText('Review Checkpoint')).toBeVisible();
		await expect(agentSessions.getByText('Implementation Draft')).toBeVisible();
	});

	test('quick resumes a stubbed Codex agent session into an AI tab', async () => {
		await stubCodexAgentSessions(electronApp, seededWorkbench);
		const agentSessions = await openAgentSessions(window);
		const reviewRow = agentSessions
			.locator('div.cursor-pointer')
			.filter({ hasText: 'Review Checkpoint' })
			.first();

		await expect(reviewRow).toBeVisible();
		await reviewRow.hover();
		await reviewRow.getByTitle('Resume session in new tab').click();

		await expect(agentSessions.getByText('Agent Sessions for E2E Workbench')).toBeHidden();
		await expect(
			window.locator('[data-tab-id]').filter({ hasText: 'Review Checkpoint' }).first()
		).toBeVisible();
		await expect(window.getByText('Please review deterministic risk coverage.')).toBeVisible();
		await expect(
			window.getByText('Refactor response sentinel: keep fixtures local and deterministic.')
		).toBeVisible();
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

	test('changes File Explorer auto-refresh from the refresh toolbar menu', async () => {
		await helpers.openRightPanelTab(window, 'Files');

		await window.getByTitle('Auto-refresh every 180s').hover();
		await expect(window.getByText('Auto-refresh', { exact: true })).toBeVisible();
		await window.getByRole('button', { name: 'Every 20 seconds' }).click();
		await expect(window.getByTitle('Auto-refresh every 20s')).toBeVisible();

		await window.getByTitle('Auto-refresh every 20s').hover();
		await expect(window.getByRole('button', { name: 'Disable auto-refresh' })).toBeVisible();
		await window.getByRole('button', { name: 'Disable auto-refresh' }).click();
		await expect(window.getByTitle('Refresh file tree')).toBeVisible();
	});

	test('refreshes the File Explorer after filesystem changes', async () => {
		await helpers.openRightPanelTab(window, 'Files');
		await getFileTreeRow(window, 'NOTES.md');
		const refreshedPath = path.join(seededWorkbench.sessions[0].fullPath, 'REFRESHED.md');

		fs.writeFileSync(refreshedPath, '# Refreshed File\n\nRefresh sentinel body.\n', 'utf-8');
		await window.getByTitle(/Auto-refresh every|Refresh file tree/).click();

		await getFileTreeRow(window, 'REFRESHED.md');
	});

	test('routes File Explorer context menu external actions through shell IPC', async () => {
		await stubShellPathHandlers(electronApp);
		const expectedNotesPath = path.join(seededWorkbench.sessions[0].fullPath, 'NOTES.md');

		let contextMenu = await openFileContextMenu(window, 'NOTES.md');
		await contextMenu.getByRole('button', { name: 'Open in Default App' }).click();

		contextMenu = await openFileContextMenu(window, 'NOTES.md');
		await contextMenu
			.getByRole('button', { name: /Reveal in Finder|Show in Folder|Show in Explorer/ })
			.click();

		const shellPathCalls = await getStubbedShellPathCalls(electronApp);
		await expect(shellPathCalls).toContainEqual({
			type: 'openPath',
			itemPath: expectedNotesPath,
		});
		await expect(shellPathCalls).toContainEqual({
			type: 'showItemInFolder',
			itemPath: expectedNotesPath,
		});
	});

	test('copies a File Explorer context menu path to the clipboard', async () => {
		const expectedNotesPath = path.join(seededWorkbench.sessions[0].fullPath, 'NOTES.md');
		await electronApp.evaluate(({ clipboard }) =>
			clipboard.writeText('before file explorer copy path')
		);

		const contextMenu = await openFileContextMenu(window, 'NOTES.md');
		await contextMenu.getByRole('button', { name: 'Copy Path' }).click();

		await expect(contextMenu).toBeHidden();
		await expect
			.poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
			.toBe(expectedNotesPath);
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

	test('cancels File Explorer delete confirmation without removing the file', async () => {
		const contextMenu = await openFileContextMenu(window, 'metrics.csv');
		await contextMenu.getByRole('button', { name: 'Delete' }).click();

		const deleteDialog = window.getByRole('dialog', { name: 'Delete File' });
		await expect(deleteDialog).toBeVisible();
		await deleteDialog.getByRole('button', { name: 'Cancel' }).click();

		await expect(deleteDialog).toBeHidden();
		await getFileTreeRow(window, 'metrics.csv');
	});

	test('renames a folder from the File Explorer context menu', async () => {
		const contextMenu = await openFileContextMenu(window, 'Auto Run Docs');
		await contextMenu.getByRole('button', { name: 'Rename' }).click();

		const renameDialog = window.getByRole('dialog', { name: 'Rename Folder' });
		await expect(renameDialog).toBeVisible();
		await renameDialog.getByPlaceholder('Enter folder name...').fill('Plans');
		await renameDialog.getByRole('button', { name: 'Rename' }).click();

		await expect(renameDialog).toBeHidden();
		const renamedFolder = await getFileTreeRow(window, 'Plans');
		await expect(
			window.locator('[data-file-index]').filter({ hasText: 'Auto Run Docs' })
		).toBeHidden();

		await renamedFolder.click();
		await getFileTreeRow(window, 'Phase 1.md');
	});

	test('deletes a folder from the File Explorer context menu after confirmation', async () => {
		const folderPath = path.join(seededWorkbench.sessions[0].fullPath, 'Auto Run Docs');
		const contextMenu = await openFileContextMenu(window, 'Auto Run Docs');
		await contextMenu.getByRole('button', { name: 'Delete' }).click();

		const deleteDialog = window.getByRole('dialog', { name: 'Delete Folder' });
		await expect(deleteDialog).toBeVisible();
		await expect(
			deleteDialog.getByText('Are you sure you want to delete the folder "Auto Run Docs"?')
		).toBeVisible();
		await expect(deleteDialog.getByText('This folder contains 1 file.')).toBeVisible();
		await deleteDialog.getByRole('button', { name: 'Delete' }).click();

		await expect(deleteDialog).toBeHidden();
		await expect(
			window.locator('[data-file-index]').filter({ hasText: 'Auto Run Docs' })
		).toBeHidden();
		await expect(
			window.locator('[data-file-index]').filter({ hasText: 'Phase 1.md' })
		).toBeHidden();
		await expect(fs.existsSync(folderPath)).toBe(false);
	});

	test('opens a file from the File Explorer using arrow-key selection and Enter', async () => {
		await helpers.openRightPanelTab(window, 'Files');
		const readmeRow = await getFileTreeRow(window, 'README.md');
		const notesRow = await getFileTreeRow(window, 'NOTES.md');
		const readmeIndex = Number(await readmeRow.getAttribute('data-file-index'));
		const notesIndex = Number(await notesRow.getAttribute('data-file-index'));
		const key = notesIndex > readmeIndex ? 'ArrowDown' : 'ArrowUp';

		await readmeRow.click();
		for (let step = 0; step < Math.abs(notesIndex - readmeIndex); step++) {
			await window.keyboard.press(key);
		}
		await window.keyboard.press('Enter');

		await expect(window.getByText('Notes Preview Surface')).toBeVisible();
		await expect(
			window.getByText('Searchable note body for file explorer coverage.')
		).toBeVisible();
	});

	test('expands and collapses File Explorer folders from keyboard selection', async () => {
		await helpers.openRightPanelTab(window, 'Files');
		const notesRow = await getFileTreeRow(window, 'NOTES.md');
		const folderRow = await getFileTreeRow(window, 'Auto Run Docs');

		await notesRow.click();
		await folderRow.click({ button: 'right' });
		await expect(window.getByRole('button', { name: 'Copy Path' })).toBeVisible();
		await window.keyboard.press('Escape');

		await window.keyboard.press('ArrowRight');
		await getFileTreeRow(window, 'Phase 1.md');

		await window.keyboard.press('ArrowLeft');
		await expect(
			window.locator('[data-file-index]').filter({ hasText: 'Phase 1.md' })
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

	test('navigates file preview search matches with Enter and Shift+Enter', async () => {
		await window.getByTestId('file-preview-root').press('Control+f');
		const searchInput = window.getByPlaceholder(/Search in file/);

		await searchInput.fill('Graph');
		await expect(window.getByText('1/3')).toBeVisible();

		await searchInput.press('Enter');
		await expect(window.getByText('2/3')).toBeVisible();

		await searchInput.press('Shift+Enter');
		await expect(window.getByText('1/3')).toBeVisible();
	});

	test('shows no-match state and disables file preview search navigation', async () => {
		await window.getByTestId('file-preview-root').press('Control+f');
		const searchInput = window.getByPlaceholder(/Search in file/);

		await searchInput.fill('missing-preview-search-term');
		await expect(window.getByText('No matches')).toBeVisible();
		await expect(window.getByTitle('Previous match (Shift+Enter)')).toBeDisabled();
		await expect(window.getByTitle('Next match (Enter)')).toBeDisabled();
	});

	test('recovers file preview search results after replacing a no-match query', async () => {
		await window.getByTestId('file-preview-root').press('Control+f');
		const searchInput = window.getByPlaceholder(/Search in file/);

		await searchInput.fill('missing-preview-search-term');
		await expect(window.getByText('No matches')).toBeVisible();

		await searchInput.fill('Preview prose');
		await expect(window.getByText('No matches')).toBeHidden();
		await expect(window.getByText('1/1')).toBeVisible();
		await expect(window.getByTitle('Next match (Enter)')).toBeVisible();
	});

	test('opens wiki-style internal markdown links from the active file preview', async () => {
		await window.getByRole('link', { name: 'NOTES' }).click();
		await expect(window.getByText('Notes Preview Surface')).toBeVisible();
		await expect(
			window.getByText('Searchable note body for file explorer coverage.')
		).toBeVisible();
	});

	test('navigates file preview history with toolbar back and forward controls', async () => {
		await window.getByRole('link', { name: 'NOTES' }).click();
		await expect(window.getByText('Notes Preview Surface')).toBeVisible();

		await window.getByTitle(/Go back/).click();
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		await window.getByTitle(/Go forward/).click();
		await expect(window.getByText('Notes Preview Surface')).toBeVisible();
	});

	test('navigates file preview history with keyboard shortcuts', async () => {
		await window.getByRole('link', { name: 'NOTES' }).click();
		await expect(window.getByText('Notes Preview Surface')).toBeVisible();

		await window.getByTestId('file-preview-root').focus();
		await window.keyboard.press('Meta+ArrowLeft');
		await expect(window.getByText('File Preview Surface')).toBeVisible();

		await window.getByTestId('file-preview-root').focus();
		await window.keyboard.press('Meta+ArrowRight');
		await expect(window.getByText('Notes Preview Surface')).toBeVisible();
	});

	test('routes external markdown links from the file preview through shell IPC', async () => {
		await stubOpenExternal(electronApp);

		await window.getByRole('link', { name: 'https://example.com/maestro-graph' }).click();

		await expect
			.poll(() => getStubbedOpenExternalUrl(electronApp))
			.toBe('https://example.com/maestro-graph');
	});

	test('routes the file preview toolbar default-app action through shell IPC', async () => {
		await stubShellPathHandlers(electronApp);
		const expectedReadmePath = path.join(seededWorkbench.sessions[0].fullPath, 'README.md');

		await window.getByTitle('Open in Default App').click();

		await expect
			.poll(async () => getStubbedShellPathCalls(electronApp))
			.toContainEqual({
				type: 'openPath',
				itemPath: expectedReadmePath,
			});
	});

	test('saves markdown file preview edits to disk and renders the saved content', async () => {
		const readmePath = path.join(seededWorkbench.sessions[0].fullPath, 'README.md');
		const savedSentinel = 'Saved preview edit sentinel.';
		const editedContent = `${fs.readFileSync(readmePath, 'utf-8')}\n${savedSentinel}\n`;

		await window.getByTitle(/Edit file/).click();
		const editor = window.locator('textarea').first();
		await expect(editor).toBeVisible();
		await editor.fill(editedContent);
		await window.getByRole('button', { name: 'Save' }).click();

		await expect(window.getByText('File Saved')).toBeVisible();
		await expect(fs.readFileSync(readmePath, 'utf-8')).toContain(savedSentinel);

		await window.getByTitle(/Show preview/).click();
		await expect(window.getByText(savedSentinel)).toBeVisible();
	});

	test('saves markdown file preview edits with the keyboard shortcut', async () => {
		const readmePath = path.join(seededWorkbench.sessions[0].fullPath, 'README.md');
		const savedSentinel = 'Keyboard saved preview edit sentinel.';
		const editedContent = `${fs.readFileSync(readmePath, 'utf-8')}\n${savedSentinel}\n`;

		await window.getByTitle(/Edit file/).click();
		const editor = window.locator('textarea').first();
		await expect(editor).toBeVisible();
		await editor.fill(editedContent);
		await editor.press('Meta+s');

		await expect(window.getByText('File Saved')).toBeVisible();
		await expect(fs.readFileSync(readmePath, 'utf-8')).toContain(savedSentinel);
	});

	test('toggles markdown file preview edit mode with the keyboard shortcut', async () => {
		await window.getByTestId('file-preview-root').focus();
		await window.keyboard.press('Meta+e');

		const editor = window.locator('textarea').first();
		await expect(editor).toHaveValue(/Preview prose for app shell E2E/);

		await editor.press('Escape');
		await expect(editor).toBeHidden();
		await expect(window.getByText('Preview prose for app shell E2E coverage.')).toBeVisible();
	});

	test('exits markdown file preview edit mode without saving from Escape', async () => {
		const readmePath = path.join(seededWorkbench.sessions[0].fullPath, 'README.md');
		const discardSentinel = 'Discarded preview edit sentinel.';
		const originalContent = fs.readFileSync(readmePath, 'utf-8');

		await window.getByTitle(/Edit file/).click();
		const editor = window.locator('textarea').first();
		await editor.fill(`${originalContent}\n${discardSentinel}\n`);
		await editor.press('Escape');

		await expect(editor).toBeHidden();
		await expect(window.getByText(discardSentinel)).toBeHidden();
		await expect(fs.readFileSync(readmePath, 'utf-8')).not.toContain(discardSentinel);
	});

	test('searches markdown file preview edit content from the keyboard shortcut', async () => {
		await window.getByTitle(/Edit file/).click();
		const editor = window.locator('textarea').first();
		await editor.press('Meta+f');

		const searchInput = window.getByPlaceholder(/Search in file/);
		await searchInput.fill('Graph');
		await expect(window.getByText('1/3')).toBeVisible();

		await searchInput.press('Enter');
		await expect(window.getByText('2/3')).toBeVisible();
	});

	test('keeps fuzzy file search disabled while the file preview editor is active', async () => {
		await window.getByTitle(/Edit file/).click();
		const editor = window.getByTestId('file-preview-root').locator('textarea');
		await expect(editor).toBeVisible();
		await editor.focus();
		await expect(editor).toBeFocused();
		await window.keyboard.press('Meta+g');

		await expect(window.getByRole('dialog', { name: 'Fuzzy File Search' })).toBeHidden();
		await expect(editor).toBeVisible();
	});

	test('reloads externally changed file content from the file preview banner', async () => {
		const readmePath = path.join(seededWorkbench.sessions[0].fullPath, 'README.md');
		const externalSentinel = 'External reload sentinel.';
		fs.appendFileSync(readmePath, `\n${externalSentinel}\n`, 'utf-8');
		setFutureMtime(readmePath);

		await expect(window.getByText('File changed on disk.')).toBeVisible({ timeout: 6000 });
		await window.getByRole('button', { name: 'Reload' }).click();

		await expect(window.getByText('File changed on disk.')).toBeHidden();
		await expect(window.getByText(externalSentinel)).toBeVisible();
	});

	test('dismisses externally changed file banner while preserving unsaved preview edits', async () => {
		const readmePath = path.join(seededWorkbench.sessions[0].fullPath, 'README.md');
		const unsavedSentinel = 'Unsaved preview edit sentinel.';
		const externalSentinel = 'External conflict sentinel.';

		await window.getByTitle(/Edit file/).click();
		const editor = window.locator('textarea').first();
		await editor.fill(`${fs.readFileSync(readmePath, 'utf-8')}\n${unsavedSentinel}\n`);

		fs.appendFileSync(readmePath, `\n${externalSentinel}\n`, 'utf-8');
		setFutureMtime(readmePath);

		await expect(window.getByText(/File changed on disk\. You have unsaved edits/)).toBeVisible({
			timeout: 6000,
		});
		await window.getByTitle('Dismiss').click();

		await expect(window.getByText(/File changed on disk/)).toBeHidden();
		await expect(editor).toHaveValue(new RegExp(unsavedSentinel));
		await expect(editor).not.toHaveValue(new RegExp(externalSentinel));
	});

	test('opens navigates and dismisses the file preview table of contents', async () => {
		await window.getByTitle('Table of Contents').click();

		await expect(window.getByText('Contents')).toBeVisible();
		await expect(window.getByText('1 headings')).toBeVisible();
		await expect(window.getByTestId('toc-top-button')).toBeVisible();
		await expect(window.getByTitle('File Preview Surface')).toBeVisible();
		await expect(window.getByTestId('toc-bottom-button')).toBeVisible();

		await window.getByTestId('toc-bottom-button').click();
		await window.keyboard.press('Escape');
		await expect(window.getByText('Contents')).toBeHidden();
	});

	test('copies file preview content and path from toolbar controls', async () => {
		await window.getByTitle('Copy content to clipboard').click();
		await expect(window.getByText('Content Copied to Clipboard')).toBeVisible();

		await window.getByTitle('Copy full path to clipboard').click();
		await expect(window.getByText('File Path Copied to Clipboard')).toBeVisible();
	});

	test('copies file preview path from the keyboard shortcut', async () => {
		await window.getByTestId('file-preview-root').focus();
		await window.keyboard.press('Meta+p');

		await expect(window.getByText('File Path Copied to Clipboard')).toBeVisible();
	});

	test('opens fuzzy file search from the file preview keyboard shortcut', async () => {
		await window.getByTestId('file-preview-root').focus();
		await window.keyboard.press('Meta+g');

		const fileSearchDialog = window.getByRole('dialog', { name: 'Fuzzy File Search' });
		await expect(fileSearchDialog).toBeVisible();
		await fileSearchDialog.getByPlaceholder('Search files...').fill('notes');
		await fileSearchDialog.getByText('NOTES.md').click();

		await expect(fileSearchDialog).toBeHidden();
		await expect(window.getByText('Notes Preview Surface')).toBeVisible();
	});

	test('opens Document Graph from the file preview keyboard shortcut', async () => {
		await window.getByTestId('file-preview-root').focus();
		await window.keyboard.press('Meta+Shift+g');

		const graphDialog = window.getByRole('dialog', { name: 'Document Graph' });
		await expect(graphDialog).toBeVisible({ timeout: 15000 });
		await expect(graphDialog.getByText(/2 documents/)).toBeVisible({ timeout: 15000 });

		await closeDocumentGraph(window);
	});

	test('toggles file preview remote-image and Bionify toolbar controls', async () => {
		await window.getByTitle('Show remote images').click();
		await expect(window.getByTitle('Hide remote images')).toBeVisible();

		await window.getByTitle('Enable Bionify for this preview').click();
		await expect(window.getByTitle('Disable Bionify for this preview')).toBeVisible();
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

	test('confirms binary file external open through shell IPC', async () => {
		await stubShellPathHandlers(electronApp);
		const expectedBinaryPath = path.join(seededWorkbench.sessions[0].fullPath, 'artifact.bin');

		await helpers.openRightPanelTab(window, 'Files');
		await window.getByText('artifact.bin').dblclick();

		const confirmDialog = window.getByRole('dialog', { name: 'Confirm' });
		await expect(confirmDialog).toBeVisible();
		await confirmDialog.getByRole('button', { name: 'Confirm' }).click();
		await expect(confirmDialog).toBeHidden();

		await expect
			.poll(async () => getStubbedShellPathCalls(electronApp))
			.toContainEqual({
				type: 'openPath',
				itemPath: expectedBinaryPath,
			});
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

	test('searches large text preview tail content after loading the full file', async () => {
		await helpers.openRightPanelTab(window, 'Files');
		await window.getByText('large-log.txt').dblclick();

		await expect(window.getByText('Large file preview truncated.')).toBeVisible();
		await window.getByRole('button', { name: 'Load full file' }).click();
		await expect(window.getByText('large file tail marker')).toBeVisible();

		await window.getByTestId('file-preview-root').press('Control+f');
		const searchInput = window.getByPlaceholder(/Search in file/);
		await searchInput.fill('large file tail marker');

		await expect(window.getByText('1/1')).toBeVisible();
		await expect(window.getByText('No matches')).toBeHidden();
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

	test('opens Document Graph node preview and navigates preview history', async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await focusDocumentGraphMindMap(graphDialog);
		await window.keyboard.press('Enter');
		await expect(graphDialog.getByText('README.md').last()).toBeVisible();
		await expect(graphDialog.getByText('File Preview Surface')).toBeVisible();
		await expect(graphDialog.getByText('Graph task still open')).toBeVisible();

		await graphDialog.getByRole('link', { name: 'NOTES' }).click();
		await expect(graphDialog.getByText('Notes Preview Surface')).toBeVisible();
		await expect(
			graphDialog.getByText('Searchable note body for file explorer coverage.')
		).toBeVisible();

		await graphDialog.getByLabel('Go back').click();
		await expect(graphDialog.getByText('File Preview Surface')).toBeVisible();
		await graphDialog.getByLabel('Go forward').click();
		await expect(graphDialog.getByText('Notes Preview Surface')).toBeVisible();

		await closeDocumentGraph(window);
	});

	test('opens a Document Graph preview from the P keyboard shortcut', async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await focusDocumentGraphMindMap(graphDialog);
		await window.keyboard.press('p');
		await expect(graphDialog.getByText('File Preview Surface')).toBeVisible();
		await expect(graphDialog.getByText('Graph task still open')).toBeVisible();

		await closeDocumentGraph(window);
	});

	test('shows disabled Document Graph preview history controls before navigation', async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await focusDocumentGraphMindMap(graphDialog);
		await window.keyboard.press('Enter');
		await expect(graphDialog.getByTitle('No previous document')).toBeVisible();
		await expect(graphDialog.getByTitle('No next document')).toBeVisible();

		await closeDocumentGraph(window);
	});

	test('closes a Document Graph preview with toolbar and Escape controls', async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await focusDocumentGraphMindMap(graphDialog);
		await window.keyboard.press('Enter');
		await expect(graphDialog.getByText('Graph task still open')).toBeVisible();

		await graphDialog.getByTitle('Close preview (Esc)').click();
		await expect(graphDialog.getByTitle('Close preview (Esc)')).toBeHidden();
		await expect(graphDialog.getByText('Graph task still open')).toBeHidden();

		await focusDocumentGraphMindMap(graphDialog);
		await window.keyboard.press('Enter');
		const previewContent = graphDialog.locator('.graph-preview');
		await expect(previewContent).toBeVisible();
		await previewContent.focus();
		await window.keyboard.press('Escape');
		await expect(graphDialog.getByTitle('Close preview (Esc)')).toBeHidden();
		await expect(graphDialog).toBeVisible();

		await closeDocumentGraph(window);
	});

	test('shows Document Graph selected document metadata and task counts', async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await expect(graphDialog.getByText('README.md').first()).toBeVisible();
		await expect(graphDialog.getByTitle('Markdown tasks')).toBeVisible({ timeout: 5000 });
		await expect(graphDialog.getByText('1 of 2 tasks')).toBeVisible();
		await expect(graphDialog.getByTitle('Created date')).toBeVisible();
		await expect(graphDialog.getByTitle('Modified date')).toBeVisible();

		await closeDocumentGraph(window);
	});

	test('shows Document Graph unmatched search state and clears it', async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);
		const searchInput = graphDialog.getByLabel('Search documents in graph');

		await searchInput.fill('missing-graph-search');
		await expect(graphDialog.getByText('0 of 2 matching')).toBeVisible();
		await graphDialog.getByLabel('Clear search').click();
		await expect(graphDialog.getByText(/2 documents/)).toBeVisible();

		await closeDocumentGraph(window);
	});

	test('searches Document Graph external link nodes when they are visible', async () => {
		const readmePath = path.join(seededWorkbench.sessions[0].fullPath, 'README.md');

		fs.appendFileSync(
			readmePath,
			'\n[Example Graph Link](https://example.com/graph-target)\n',
			'utf-8'
		);
		setFutureMtime(readmePath);

		const graphDialog = await openDocumentGraphFromPreview(window);
		const searchInput = graphDialog.getByLabel('Search documents in graph');

		await graphDialog.getByTitle('Show external links').click();
		await expect(graphDialog.getByText(/2 documents, 1 external domain/)).toBeVisible();

		await searchInput.fill('example.com');
		await expect(graphDialog.getByText('1 of 3 matching')).toBeVisible();
		await graphDialog.getByLabel('Clear search').click();
		await expect(graphDialog.getByText(/2 documents, 1 external domain/)).toBeVisible();

		await closeDocumentGraph(window);
	});

	test('hides Document Graph external link nodes after showing them', async () => {
		const readmePath = path.join(seededWorkbench.sessions[0].fullPath, 'README.md');

		fs.appendFileSync(
			readmePath,
			'\n[Toggle Graph Link](https://example.org/toggle-target)\n',
			'utf-8'
		);
		setFutureMtime(readmePath);

		const graphDialog = await openDocumentGraphFromPreview(window);

		await graphDialog.getByTitle('Show external links').click();
		await expect(graphDialog.getByText(/2 documents, 1 external domain/)).toBeVisible();

		await graphDialog.getByTitle('Hide external links').click();
		await expect(graphDialog.getByTitle('Show external links')).toBeVisible();
		await expect(graphDialog.getByText(/1 external domain/)).toBeHidden();
		await expect(graphDialog.getByText(/2 documents/)).toBeVisible();

		await closeDocumentGraph(window);
	});

	test('selects the Force Document Graph layout and dismisses the layout menu with Escape', async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await graphDialog.getByTitle('Layout: Mind Map').click();
		await expect(graphDialog.getByRole('button', { name: /Force/ })).toBeVisible();
		await window.keyboard.press('Escape');
		await expect(graphDialog.getByRole('button', { name: /Force/ })).toBeHidden();

		await graphDialog.getByTitle('Layout: Mind Map').click();
		await graphDialog.getByRole('button', { name: /Force/ }).click();
		await expect(graphDialog.getByTitle('Layout: Force')).toBeVisible();

		await closeDocumentGraph(window);
	});

	test('sets Document Graph neighbor depth to all and maximum values', async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await graphDialog.getByTitle('Showing 2 levels of neighbors').click();
		const depthSlider = graphDialog.locator('input[type="range"][min="0"][max="5"]');
		await depthSlider.fill('0');
		await expect(graphDialog.getByTitle('Show all nodes')).toBeVisible();
		await expect(graphDialog.getByText('Showing all documents')).toBeVisible();

		await depthSlider.fill('5');
		await expect(graphDialog.getByTitle('Showing 5 levels of neighbors')).toBeVisible();
		await expect(graphDialog.getByText('Showing documents within 5 links of focus')).toBeVisible();
		await window.keyboard.press('Escape');
		await expect(graphDialog.getByText('Neighbor Depth')).toBeHidden();

		await closeDocumentGraph(window);
	});

	test('adjusts Document Graph preview character limit from the toolbar', async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await graphDialog.getByTitle('Preview text limit: 100 characters').click();
		await expect(graphDialog.getByText('Preview Characters')).toBeVisible();
		await graphDialog.locator('input[type="range"][min="50"][max="500"]').fill('250');
		await expect(graphDialog.getByTitle('Preview text limit: 250 characters')).toBeVisible();
		await window
			.locator('div.fixed.inset-0.z-40')
			.last()
			.click({ position: { x: 10, y: 10 } });
		await expect(graphDialog.getByText('Preview Characters')).toBeHidden();

		await closeDocumentGraph(window);
	});

	test('closes the Document Graph preview character slider with Escape', async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await graphDialog.getByTitle('Preview text limit: 100 characters').click();
		await expect(graphDialog.getByText('Preview Characters')).toBeVisible();
		const previewSlider = graphDialog.locator('input[type="range"][min="50"][max="500"]');
		await previewSlider.focus();
		await window.keyboard.press('Escape');
		await expect(graphDialog.getByText('Preview Characters')).toBeHidden();
		await expect(graphDialog).toBeVisible();

		await closeDocumentGraph(window);
	});

	test('refreshes Document Graph after a markdown document is added', async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);
		const refreshPath = path.join(seededWorkbench.sessions[0].fullPath, 'GRAPH-REFRESH.md');

		fs.writeFileSync(
			refreshPath,
			`# Graph Refresh Surface

Refresh-added document with a link back to [[README]].
`,
			'utf-8'
		);
		setFutureMtime(refreshPath);

		await graphDialog.getByTitle('Refresh graph').click();
		await expect(graphDialog.getByText(/3 documents/)).toBeVisible({ timeout: 15000 });

		await closeDocumentGraph(window);
	});

	test('resets Document Graph node positions after a drag', async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);
		const canvas = graphDialog.locator('canvas');
		const box = await canvas.boundingBox();

		if (!box) {
			throw new Error('Document Graph canvas is not visible');
		}

		await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await window.mouse.down();
		await window.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 40);
		await window.mouse.up();

		const resetLayoutButton = graphDialog.getByTitle(
			'Reset all node positions to algorithmic layout'
		);
		await expect(resetLayoutButton).toBeVisible();
		await resetLayoutButton.click();
		await expect(resetLayoutButton).toBeHidden();

		await closeDocumentGraph(window);
	});

	test('copies a Document Graph node path from the context menu', async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);
		const contextMenu = await openDocumentGraphCenterNodeContextMenu(window, graphDialog);
		const expectedCopiedPath = path.relative(
			seededWorkbench.sessions[0].cwd,
			seededWorkbench.sessions[0].filePreviewTabs[0].path
		);
		await electronApp.evaluate(({ clipboard }) =>
			clipboard.writeText('before document graph copy')
		);

		await contextMenu.getByRole('button', { name: 'Copy Path' }).click();
		await expect(contextMenu).toBeHidden();
		await expect(graphDialog).toBeVisible();
		await expect
			.poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
			.toBe(expectedCopiedPath);

		await closeDocumentGraph(window);
	});

	test('opens a Document Graph node from the context menu in the main file preview', async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);
		const contextMenu = await openDocumentGraphCenterNodeContextMenu(window, graphDialog);

		await contextMenu.getByRole('button', { name: 'Open' }).click();
		await expect(graphDialog).toBeHidden();
		await expect(window.getByRole('heading', { name: 'File Preview Surface' })).toBeVisible();
	});

	test('opens the focused Document Graph node in the main file preview from the keyboard', async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await focusDocumentGraphMindMap(graphDialog);
		await window.keyboard.press('o');
		await expect(graphDialog).toBeHidden();
		await expect(window.getByRole('heading', { name: 'File Preview Surface' })).toBeVisible();
	});

	test('closes the Document Graph help panel from its header control', async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await graphDialog.getByTitle('Open help panel').click();
		const helpPanel = graphDialog.getByRole('region', { name: 'Help panel' });
		await expect(helpPanel).toBeVisible();
		await expect(helpPanel.getByText('Keyboard Shortcuts')).toBeVisible();

		await helpPanel.getByTitle('Close (Esc)').click();
		await expect(helpPanel).toBeHidden();

		await closeDocumentGraph(window);
	});

	test('shows Document Graph legend keyboard and mouse guidance and closes it with Escape', async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await graphDialog.getByTitle('Open help panel').click();
		const helpPanel = graphDialog.getByRole('region', { name: 'Help panel' });
		await expect(helpPanel).toBeVisible();
		await expect(helpPanel.getByText('Keyboard Shortcuts')).toBeVisible();
		await expect(helpPanel.getByText('Navigate between nodes')).toBeVisible();
		await expect(helpPanel.getByText('Preview document in-graph')).toBeVisible();
		await expect(helpPanel.getByText('Open in main preview')).toBeVisible();
		await expect(helpPanel.getByText('Right-click')).toBeVisible();
		await expect(helpPanel.getByText('Context menu')).toBeVisible();
		await expect(helpPanel.getByText('Zoom in/out')).toBeVisible();

		await window.keyboard.press('Escape');
		await expect(helpPanel).toBeHidden();
		await expect(graphDialog).toBeVisible();

		await closeDocumentGraph(window);
	});

	test('opens a Document Graph preview document in the main file preview', async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await focusDocumentGraphMindMap(graphDialog);
		await window.keyboard.press('Enter');
		await expect(graphDialog.getByText('File Preview Surface')).toBeVisible();
		await graphDialog.getByRole('link', { name: 'NOTES' }).click();
		await expect(graphDialog.getByText('Notes Preview Surface')).toBeVisible();

		await graphDialog.getByTitle('Open in file preview').click();
		await expect(graphDialog).toBeHidden();
		await expect(window.getByRole('heading', { name: 'Notes Preview Surface' })).toBeVisible();
	});

	test('cancels Document Graph Escape close confirmation', async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await window.keyboard.press('Escape');
		const closeDialog = window.getByRole('dialog', { name: 'Close Document Graph?' });
		await expect(closeDialog).toBeVisible();
		await closeDialog.getByRole('button', { name: 'Cancel' }).click();
		await expect(closeDialog).toBeHidden();
		await expect(graphDialog).toBeVisible();

		await closeDocumentGraph(window);
	});

	test('cancels Document Graph toolbar close confirmation from the Cancel button', async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await graphDialog.getByTitle('Close (Esc)').click();
		const closeDialog = window.getByRole('dialog', { name: 'Close Document Graph?' });
		await expect(closeDialog).toBeVisible();
		await closeDialog.getByRole('button', { name: 'Cancel' }).click();
		await expect(closeDialog).toBeHidden();
		await expect(graphDialog).toBeVisible();

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

	test("persists Director's Notes default lookback period changes", async () => {
		const settingsDialog = await openSettings(window);
		await settingsDialog.locator('button[title="Encore Features"]').click();

		const lookbackSlider = settingsDialog.locator('input[type="range"]').first();
		await lookbackSlider.evaluate((node) => {
			const input = node as HTMLInputElement;
			const valueSetter = Object.getOwnPropertyDescriptor(
				window.HTMLInputElement.prototype,
				'value'
			)?.set;
			valueSetter?.call(input, '30');
			input.dispatchEvent(new Event('input', { bubbles: true }));
			input.dispatchEvent(new Event('change', { bubbles: true }));
		});

		await expect(settingsDialog.getByText('Default Lookback Period: 30 days')).toBeVisible();
		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					const settings = await window.maestro.settings.get('directorNotesSettings');
					return settings.defaultLookbackDays;
				});
			})
			.toBe(30);
	});

	test('lists detected Codex as the Director Notes synopsis provider', async () => {
		await stubEncoreCodexAgent(electronApp);

		const settingsDialog = await openSettings(window);
		await settingsDialog.locator('button[title="Encore Features"]').click();

		const providerSelect = settingsDialog.getByLabel('Select synopsis provider agent');
		await expect(providerSelect).toBeVisible();
		await expect(providerSelect).toHaveValue('codex');
		await expect(providerSelect.locator('option')).toHaveCount(1);
		await expect(settingsDialog.getByTitle('Customize provider settings')).toBeVisible();
	});

	test('shows install guidance when no Director Notes provider is detected', async () => {
		await stubNoEncoreAgents(electronApp);

		const settingsDialog = await openSettings(window);
		await settingsDialog.locator('button[title="Encore Features"]').click();

		await expect(
			settingsDialog.getByText(
				'No agents available. Please install Claude Code, OpenCode, Codex, or Factory Droid.'
			)
		).toBeVisible();
		await expect(settingsDialog.getByLabel('Select synopsis provider agent')).toBeHidden();
	});

	test("persists Director's Notes provider path args and environment overrides", async () => {
		await stubEncoreCodexAgent(electronApp);

		const settingsDialog = await openSettings(window);
		await settingsDialog.locator('button[title="Encore Features"]').click();
		await settingsDialog.getByTitle('Customize provider settings').click();
		await expect(settingsDialog.getByText('Codex Configuration')).toBeVisible();

		await settingsDialog.getByPlaceholder('/path/to/codex').fill('/tmp/e2e-codex');
		await settingsDialog.getByPlaceholder('/path/to/codex').blur();
		await settingsDialog
			.getByPlaceholder('--flag value --another-flag')
			.fill('--sandbox read-only --model e2e');
		await settingsDialog.getByPlaceholder('--flag value --another-flag').blur();

		await settingsDialog.getByRole('button', { name: 'Add Variable' }).click();
		await settingsDialog.getByPlaceholder('VARIABLE_NAME').fill('E2E_DIRECTOR_NOTES');
		await settingsDialog.getByPlaceholder('VARIABLE_NAME').blur();
		await settingsDialog.getByPlaceholder('value', { exact: true }).fill('enabled');
		await settingsDialog.getByPlaceholder('value', { exact: true }).blur();

		await expect(settingsDialog.getByText('Customized')).toBeVisible();
		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					const settings = await window.maestro.settings.get('directorNotesSettings');
					return {
						customArgs: settings.customArgs,
						customEnvVars: settings.customEnvVars,
						customPath: settings.customPath,
					};
				});
			})
			.toEqual({
				customArgs: '--sandbox read-only --model e2e',
				customEnvVars: { E2E_DIRECTOR_NOTES: 'enabled' },
				customPath: '/tmp/e2e-codex',
			});
	});

	test("saves Director's Notes Codex model and context window settings", async () => {
		await stubEncoreCodexAgent(electronApp, {
			contextWindow: 400000,
			model: 'gpt-5.2-codex',
		});

		const settingsDialog = await openSettings(window);
		await settingsDialog.locator('button[title="Encore Features"]').click();
		await settingsDialog.getByTitle('Customize provider settings').click();
		await expect(settingsDialog.getByText('2 models available')).toBeVisible();

		const fieldPanel = (label: string): Locator =>
			settingsDialog
				.getByText(label, { exact: true })
				.locator('xpath=ancestor::div[contains(@class, "rounded border")][1]');
		const modelInput = fieldPanel('Model').locator('input[type="text"]').first();
		const contextWindowInput = fieldPanel('Context Window Size')
			.locator('input[type="number"]')
			.first();

		await expect(modelInput).toHaveValue('gpt-5.2-codex');
		await modelInput.fill('gpt-5.3-codex');
		await modelInput.blur();
		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					const config = await window.maestro.agents.getConfig('codex');
					return config.model;
				});
			})
			.toBe('gpt-5.3-codex');
		await contextWindowInput.fill('128000');
		await expect(contextWindowInput).toHaveValue('128000');
		await contextWindowInput.blur();

		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					return await window.maestro.agents.getConfig('codex');
				});
			})
			.toEqual({
				contextWindow: 128000,
				model: 'gpt-5.3-codex',
			});
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
		const composerDialog = promptComposerDialog(window);

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

	test('trims whitespace when pasting text into Prompt Composer', async () => {
		const composerInput = await openPromptComposer(window);

		await composerInput.fill('Prefix: ');
		await composerInput.evaluate((textarea) => {
			const input = textarea as HTMLTextAreaElement;
			input.setSelectionRange(input.value.length, input.value.length);
			const dataTransfer = new DataTransfer();
			dataTransfer.setData('text/plain', '  pasted composer text  \n\n');
			input.dispatchEvent(
				new ClipboardEvent('paste', {
					clipboardData: dataTransfer,
					bubbles: true,
					cancelable: true,
				})
			);
		});

		await expect(composerInput).toHaveValue('Prefix: pasted composer text');
		await window.keyboard.press('Escape');
		await expect(window.getByText('Prompt Composer')).toBeHidden();
	});

	test('keeps Prompt Composer @ text literal outside group-chat mention context', async () => {
		const composerInput = await openPromptComposer(window);
		const composerDialog = promptComposerDialog(window);

		await composerInput.fill('@E2E');
		await expect(composerDialog.getByRole('button', { name: /@E2E-Workbench/ })).toHaveCount(0);
		await expect(composerInput).toHaveValue('@E2E');

		await window.keyboard.press('Escape');
		await expect(window.getByText('Prompt Composer')).toBeHidden();
	});

	test('uploads a Prompt Composer image and opens it in the lightbox', async () => {
		await openPromptComposer(window);
		const composerDialog = promptComposerDialog(window);
		const imagePath = path.join(seededWorkbench.sessions[0].cwd, 'diagram.png');

		await composerDialog.locator('input[type="file"]').setInputFiles(imagePath);
		const stagedImage = composerDialog.getByRole('button', {
			name: 'Prompt composer staged image 1',
		});
		await expect(stagedImage).toBeVisible();

		await stagedImage.click();
		const lightbox = window.getByRole('dialog', { name: 'Image Lightbox' });
		await expect(lightbox).toBeVisible();
		await expect(lightbox.getByRole('img', { name: 'Expanded image preview' })).toBeVisible();

		await lightbox.click({ position: { x: 10, y: 10 } });
		await expect(lightbox).toBeHidden();
		await window.keyboard.press('Escape');
		await expect(window.getByText('Prompt Composer')).toBeHidden();
	});

	test('removes a staged image from Prompt Composer without sending', async () => {
		await openPromptComposer(window);
		const composerDialog = promptComposerDialog(window);
		const imagePath = path.join(seededWorkbench.sessions[0].cwd, 'diagram.png');

		await composerDialog.locator('input[type="file"]').setInputFiles(imagePath);
		const stagedImage = composerDialog.getByRole('button', {
			name: 'Prompt composer staged image 1',
		});
		await expect(stagedImage).toBeVisible();

		await stagedImage
			.locator('xpath=ancestor::div[contains(@class, "relative")][1]')
			.locator('button')
			.click();
		await expect(stagedImage).toBeHidden();

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

	test('shows and recovers from an unmatched shortcut filter', async () => {
		const settingsDialog = await openSettingsTab(
			window,
			'Shortcuts',
			'Not all shortcuts can be modified'
		);
		const shortcutFilter = settingsDialog.getByPlaceholder('Filter shortcuts...');

		await shortcutFilter.fill('definitely-no-shortcut-match');
		await expect(settingsDialog.getByText(/^0 \/ \d+$/)).toBeVisible();
		await expect(settingsDialog.locator('h3').filter({ hasText: /^General$/ })).toBeHidden();
		await expect(settingsDialog.locator('h3').filter({ hasText: /^AI Tab$/ })).toBeHidden();

		await shortcutFilter.fill('Quick Actions');
		await expect(settingsDialog.locator('h3').filter({ hasText: /^General$/ })).toBeVisible();
		await expect(settingsShortcutButton(settingsDialog, 'Quick Actions')).toBeVisible();
	});

	test('records a custom global shortcut and applies it in the app shell', async () => {
		const settingsDialog = await openSettingsTab(
			window,
			'Shortcuts',
			'Not all shortcuts can be modified'
		);
		const shortcutFilter = settingsDialog.getByPlaceholder('Filter shortcuts...');
		await shortcutFilter.fill('Quick Actions');

		const quickActionShortcut = settingsShortcutButton(settingsDialog, 'Quick Actions');
		await quickActionShortcut.click();
		await expect(quickActionShortcut).toHaveText('Press keys...');
		await quickActionShortcut.press('Control+Shift+F8');

		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					const shortcuts = await window.maestro.settings.get('shortcuts');
					return shortcuts.quickAction.keys.map((key: string) => key.toLowerCase());
				});
			})
			.toEqual(['ctrl', 'shift', 'f8']);

		await window.keyboard.press('Escape');
		await expect(settingsDialog).toBeHidden();

		await window.keyboard.press('Control+Shift+F8');
		await expect(window.getByRole('dialog', { name: 'Quick Actions' })).toBeVisible();
	});

	test('records Alt-key shortcuts using the physical key code', async () => {
		const settingsDialog = await openSettingsTab(
			window,
			'Shortcuts',
			'Not all shortcuts can be modified'
		);
		const shortcutFilter = settingsDialog.getByPlaceholder('Filter shortcuts...');
		await shortcutFilter.fill('Open Settings');

		const openSettingsShortcut = settingsShortcutButton(settingsDialog, 'Open Settings');
		await openSettingsShortcut.click();
		await expect(openSettingsShortcut).toHaveText('Press keys...');
		await openSettingsShortcut.press('Alt+P');

		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					const shortcuts = await window.maestro.settings.get('shortcuts');
					return shortcuts.settings?.keys?.map((key: string) => key.toLowerCase()) ?? null;
				});
			})
			.toEqual(['alt', 'p']);
	});

	test('records a custom AI tab shortcut inside Settings', async () => {
		const settingsDialog = await openSettingsTab(
			window,
			'Shortcuts',
			'Not all shortcuts can be modified'
		);
		const shortcutFilter = settingsDialog.getByPlaceholder('Filter shortcuts...');
		await shortcutFilter.fill('Close Tab');

		const closeTabShortcut = settingsShortcutButton(settingsDialog, 'Close Tab');
		await closeTabShortcut.click();
		await expect(closeTabShortcut).toHaveText('Press keys...');
		await closeTabShortcut.press('Control+Shift+F7');

		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					const tabShortcuts = await window.maestro.settings.get('tabShortcuts');
					return tabShortcuts.closeTab.keys.map((key: string) => key.toLowerCase());
				});
			})
			.toEqual(['ctrl', 'shift', 'f7']);
	});

	test('cancels shortcut recording with Escape without closing Settings', async () => {
		const settingsDialog = await openSettingsTab(
			window,
			'Shortcuts',
			'Not all shortcuts can be modified'
		);
		const originalOpenSettingsKeys = await window.evaluate(async () => {
			const shortcuts = await window.maestro.settings.get('shortcuts');
			return shortcuts.settings?.keys?.map((key: string) => key.toLowerCase()) ?? null;
		});
		const shortcutFilter = settingsDialog.getByPlaceholder('Filter shortcuts...');
		await shortcutFilter.fill('Open Settings');

		const openSettingsShortcut = settingsShortcutButton(settingsDialog, 'Open Settings');
		await openSettingsShortcut.click();
		await expect(openSettingsShortcut).toHaveText('Press keys...');
		await window.keyboard.press('Escape');

		await expect(settingsDialog).toBeVisible();
		await expect(openSettingsShortcut).not.toHaveText('Press keys...');
		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					const shortcuts = await window.maestro.settings.get('shortcuts');
					return shortcuts.settings?.keys?.map((key: string) => key.toLowerCase()) ?? null;
				});
			})
			.toEqual(originalOpenSettingsKeys);
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

	test('persists General Settings profile shell and command paths', async () => {
		const settingsDialog = await openSettingsTab(window, 'General', 'Conductor Profile');

		await settingsDialog
			.getByPlaceholder(/senior developer working on a React\/TypeScript project/)
			.fill('E2E conductor profile prefers terse deterministic test coverage.');
		await settingsDialog.getByRole('button', { name: 'Shell Configuration' }).click();
		await settingsDialog.getByPlaceholder('/path/to/shell').fill('/usr/local/bin/fish-e2e');
		await settingsDialog.getByPlaceholder('--flag value').fill('--login --e2e');

		await scrollSettingsToText(settingsDialog, 'GitHub CLI (gh) Path');
		await settingsDialog.getByPlaceholder('/opt/homebrew/bin/gh').fill('/usr/local/bin/gh-e2e');

		await expect
			.poll(async () => {
				return await window.evaluate(async () => ({
					conductorProfile: await window.maestro.settings.get('conductorProfile'),
					customShellPath: await window.maestro.settings.get('customShellPath'),
					shellArgs: await window.maestro.settings.get('shellArgs'),
					ghPath: await window.maestro.settings.get('ghPath'),
				}));
			})
			.toEqual({
				conductorProfile: 'E2E conductor profile prefers terse deterministic test coverage.',
				customShellPath: '/usr/local/bin/fish-e2e',
				shellArgs: '--login --e2e',
				ghPath: '/usr/local/bin/gh-e2e',
			});
	});

	test('persists General Settings input behavior and local editing switches', async () => {
		const settingsDialog = await openSettingsTab(window, 'General', 'Conductor Profile');

		await scrollSettingsToText(settingsDialog, 'Input Send Behavior');
		await settingsDialog
			.getByText('AI Interaction Mode')
			.locator('xpath=ancestor::div[contains(@class, "border")][1]')
			.getByRole('button')
			.click();
		await settingsDialog
			.getByText('Terminal Mode')
			.locator('xpath=ancestor::div[contains(@class, "border")][1]')
			.getByRole('button')
			.click();

		await scrollSettingsToText(settingsDialog, 'Automatic Tab Naming');
		await settingsDialog.getByText('Automatically name tabs based on first message').click();
		await scrollSettingsToText(settingsDialog, 'Spell Check');
		await settingsDialog.getByText('Enable spell checking').click();

		await expect
			.poll(async () => {
				return await window.evaluate(async () => ({
					enterToSendAI: await window.maestro.settings.get('enterToSendAI'),
					enterToSendTerminal: await window.maestro.settings.get('enterToSendTerminal'),
					automaticTabNamingEnabled: await window.maestro.settings.get('automaticTabNamingEnabled'),
					spellCheck: await window.maestro.settings.get('spellCheck'),
				}));
			})
			.toEqual({
				enterToSendAI: true,
				enterToSendTerminal: false,
				automaticTabNamingEnabled: false,
				spellCheck: true,
			});
	});

	test('persists General Settings system update privacy and stats controls', async () => {
		const settingsDialog = await openSettingsTab(window, 'General', 'Conductor Profile');

		await scrollSettingsToText(settingsDialog, 'System Log Level');
		await settingsDialog.getByRole('button', { name: 'Warn' }).click();
		await scrollSettingsToText(settingsDialog, 'Power');
		await settingsDialog.getByRole('switch', { name: 'Prevent sleep while working' }).click();
		await scrollSettingsToText(settingsDialog, 'Rendering Options');
		await settingsDialog.getByRole('switch', { name: 'Disable GPU acceleration' }).click();
		await settingsDialog.getByRole('switch', { name: 'Disable confetti animations' }).click();

		await scrollSettingsToText(settingsDialog, 'Updates');
		await settingsDialog.getByText('Check for updates on startup').click();
		await settingsDialog.getByText('Include beta and release candidate updates').click();
		await settingsDialog.getByText('Send anonymous crash reports').click();

		await scrollSettingsToText(settingsDialog, 'Usage & Stats');
		await settingsDialog.getByRole('switch', { name: 'Enable stats collection' }).click();
		await settingsDialog
			.getByText('Default dashboard time range')
			.locator('xpath=following::select[1]')
			.selectOption('all');

		await expect
			.poll(async () => {
				return await window.evaluate(async () => ({
					logLevel: await window.maestro.settings.get('logLevel'),
					preventSleepEnabled: await window.maestro.settings.get('preventSleepEnabled'),
					disableGpuAcceleration: await window.maestro.settings.get('disableGpuAcceleration'),
					disableConfetti: await window.maestro.settings.get('disableConfetti'),
					checkForUpdatesOnStartup: await window.maestro.settings.get('checkForUpdatesOnStartup'),
					enableBetaUpdates: await window.maestro.settings.get('enableBetaUpdates'),
					crashReportingEnabled: await window.maestro.settings.get('crashReportingEnabled'),
					statsCollectionEnabled: await window.maestro.settings.get('statsCollectionEnabled'),
					defaultStatsTimeRange: await window.maestro.settings.get('defaultStatsTimeRange'),
				}));
			})
			.toEqual({
				logLevel: 'warn',
				preventSleepEnabled: true,
				disableGpuAcceleration: true,
				disableConfetti: true,
				checkForUpdatesOnStartup: false,
				enableBetaUpdates: true,
				crashReportingEnabled: false,
				statsCollectionEnabled: false,
				defaultStatsTimeRange: 'all',
			});
	});

	test('renders General Settings storage location controls', async () => {
		const settingsDialog = await openSettingsTab(window, 'General', 'Conductor Profile');

		await scrollSettingsToText(settingsDialog, 'Storage Location');
		await expect(settingsDialog.getByText('Settings folder')).toBeVisible();
		await expect(settingsDialog.getByText('Default Location')).toBeVisible();
		await expect(settingsDialog.getByText(/maestro-e2e-shell.*user-data/)).toBeVisible();
		await expect(settingsDialog.getByRole('button', { name: 'Choose Folder...' })).toBeVisible();
		await expect(
			settingsDialog.getByRole('button', {
				name: /Open in Finder|Open in Explorer|Open in File Manager/,
			})
		).toBeEnabled();
	});

	test('detects available terminal shells and persists the selected default shell', async () => {
		await stubShellDetection(electronApp);
		const settingsDialog = await openSettingsTab(window, 'General', 'Default Terminal Shell');

		await settingsDialog.getByRole('button', { name: /Detect other available shells/ }).click();
		const fishButton = settingsDialog.getByRole('button', { name: /Fish/ });
		await expect(fishButton).toBeVisible();
		await expect(settingsDialog.getByText('/opt/e2e/fish')).toBeVisible();
		await expect(settingsDialog.getByText('Available')).toBeVisible();

		await fishButton.click();
		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					return await window.maestro.settings.get('defaultShell');
				});
			})
			.toBe('fish');
	});

	test('expands missing shell configuration and clears shell overrides', async () => {
		await stubShellDetection(electronApp);
		const settingsDialog = await openSettingsTab(window, 'General', 'Default Terminal Shell');

		await settingsDialog.getByRole('button', { name: /Detect other available shells/ }).click();
		await settingsDialog.getByRole('button', { name: /Nushell/ }).click();
		await expect(settingsDialog.getByText('Custom Path Required')).toBeVisible();

		const customPathInput = settingsDialog.getByPlaceholder('/path/to/shell');
		const shellArgsInput = settingsDialog.getByPlaceholder('--flag value');
		await expect(customPathInput).toBeVisible();
		await customPathInput.fill('/opt/e2e/nu');
		await shellArgsInput.fill('--login --interactive');
		await settingsDialog.getByRole('button', { name: 'Clear' }).first().click();
		await settingsDialog.getByRole('button', { name: 'Clear' }).first().click();

		await expect(customPathInput).toHaveValue('');
		await expect(shellArgsInput).toHaveValue('');
		await expect
			.poll(async () => {
				return await window.evaluate(async () => ({
					defaultShell: await window.maestro.settings.get('defaultShell'),
					customShellPath: await window.maestro.settings.get('customShellPath'),
					shellArgs: await window.maestro.settings.get('shellArgs'),
				}));
			})
			.toEqual({
				defaultShell: 'nu',
				customShellPath: '',
				shellArgs: '',
			});
	});

	test('clears old stats data from General Settings with deterministic counts', async () => {
		await stubStatsDataManagement(electronApp);
		const settingsDialog = await openSettingsTab(window, 'General', 'Conductor Profile');

		await scrollSettingsToText(settingsDialog, 'Usage & Stats');
		await expect(settingsDialog.getByText(/2\.00 MB.*2026-01-02/)).toBeVisible();
		await settingsDialog.locator('#clear-stats-period').selectOption('30');
		const statsSection = settingsDialog
			.getByText('Clear stats older than...')
			.locator('xpath=ancestor::div[contains(@class, "p-3")][1]');
		await statsSection.getByRole('button', { name: 'Clear' }).click();

		await expect(settingsDialog.getByText(/Cleared\s+6\s+records/)).toBeVisible();
		await expect(settingsDialog.getByText(/2 queries,\s+1 sessions,\s+3 tasks/)).toBeVisible();
		await expect(settingsDialog.getByText(/1\.00 MB.*2026-01-02/)).toBeVisible();
		await expect.poll(() => getStubbedStatsClearDays(electronApp)).toEqual([30]);
	});

	test('persists WakaTime tracking settings and validates then clears the API key', async () => {
		await stubWakaTimeHandlers(electronApp);
		const settingsDialog = await openSettingsTab(window, 'General', 'Conductor Profile');

		await scrollSettingsToText(settingsDialog, 'Usage & Stats');
		await settingsDialog.getByRole('switch', { name: 'Enable WakaTime tracking' }).click();
		await expect(
			settingsDialog.getByRole('switch', { name: 'Detailed file tracking' })
		).toBeVisible();
		await settingsDialog.getByRole('switch', { name: 'Detailed file tracking' }).click();
		const apiKeyInput = settingsDialog.getByPlaceholder('waka_...');
		await apiKeyInput.fill('waka_e2e_valid_key');
		await apiKeyInput.blur();
		await expect(settingsDialog.getByTitle('Clear API key')).toBeVisible();
		await expect
			.poll(async () => {
				return await window.evaluate(async () => ({
					wakatimeEnabled: await window.maestro.settings.get('wakatimeEnabled'),
					wakatimeDetailedTracking: await window.maestro.settings.get('wakatimeDetailedTracking'),
					wakatimeApiKey: await window.maestro.settings.get('wakatimeApiKey'),
				}));
			})
			.toEqual({
				wakatimeEnabled: true,
				wakatimeDetailedTracking: true,
				wakatimeApiKey: 'waka_e2e_valid_key',
			});

		await settingsDialog.getByTitle('Clear API key').click();
		await expect(apiKeyInput).toHaveValue('');
		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					return await window.maestro.settings.get('wakatimeApiKey');
				});
			})
			.toBe('');
	});

	test('changes Settings storage location and routes the open-folder action', async () => {
		const selectedFolder = path.join(seededWorkbench.homeDir, 'synced-settings');
		await stubStorageSyncHandlers(electronApp, selectedFolder);
		await stubShellPathHandlers(electronApp);
		const settingsDialog = await openSettingsTab(window, 'General', 'Conductor Profile');

		await scrollSettingsToText(settingsDialog, 'Storage Location');
		await settingsDialog.getByRole('button', { name: 'Choose Folder...' }).click();
		await expect(settingsDialog.getByText('Current Location (Custom)')).toBeVisible();
		await expect(settingsDialog.getByText(selectedFolder)).toBeVisible();
		await expect(settingsDialog.getByText('Migrated 3 settings files')).toBeVisible();
		await expect(
			settingsDialog.getByText('Restart Maestro for changes to take effect')
		).toBeVisible();

		await settingsDialog
			.getByRole('button', {
				name: /Open in Finder|Open in Explorer|Open in File Manager/,
			})
			.click();
		await expect
			.poll(() => getStubbedShellPathCalls(electronApp))
			.toContainEqual({
				type: 'openPath',
				itemPath: selectedFolder,
			});

		await settingsDialog.getByRole('button', { name: 'Use Default' }).click();
		await expect(settingsDialog.getByText('Migrated 2 settings files')).toBeVisible();
		await expect(settingsDialog.getByText('Current Location (Custom)')).toBeHidden();
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

	test('adds selects and removes a custom interface font in Display settings', async () => {
		await stubFontDetection(electronApp);
		const settingsDialog = await openSettingsTab(window, 'Display', 'Interface Font');
		const fontSelect = settingsDialog.locator('select').first();

		await fontSelect.focus();
		await fontSelect.selectOption('JetBrains Mono');
		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					return await window.maestro.settings.get('fontFamily');
				});
			})
			.toBe('JetBrains Mono');

		const customFontInput = settingsDialog.getByPlaceholder('Add custom font name...');
		await customFontInput.fill('E2E Mono Font');
		await customFontInput.press('Enter');
		const customFontChip = settingsDialog
			.locator('span')
			.filter({ hasText: /^E2E Mono Font$/ })
			.locator('xpath=ancestor::div[contains(@class, "flex items-center")][1]');
		await expect(customFontChip).toBeVisible();
		await fontSelect.selectOption('E2E Mono Font');
		await expect
			.poll(async () => {
				return await window.evaluate(async () => ({
					fontFamily: await window.maestro.settings.get('fontFamily'),
					customFonts: await window.maestro.settings.get('customFonts'),
				}));
			})
			.toEqual({
				fontFamily: 'E2E Mono Font',
				customFonts: ['E2E Mono Font'],
			});

		await customFontChip.getByRole('button').click();
		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					return await window.maestro.settings.get('customFonts');
				});
			})
			.toEqual([]);
	});

	test('opens and closes the Bionify algorithm reference from Display settings', async () => {
		const settingsDialog = await openSettingsTab(window, 'Display', 'Font Size');

		await scrollSettingsToText(settingsDialog, 'Bionify Algorithm');
		await settingsDialog.getByTitle('Bionify algorithm info').click();
		const infoDialog = window.getByRole('dialog', { name: 'Bionify Algorithm Reference' });
		await expect(infoDialog).toBeVisible();
		await expect(infoDialog.getByText('Current default: `- 0 1 1 2 0.4`')).toBeVisible();

		await window.keyboard.press('Escape');
		await expect(infoDialog).toBeHidden();
	});

	test('persists Theme Settings selection and keyboard cycling', async () => {
		const settingsDialog = await openThemeSettings(window);
		const themePicker = settingsDialog.getByRole('group', { name: 'Theme picker' });

		await themePicker.locator('[data-theme-id="monokai"]').click();
		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					return await window.maestro.settings.get('activeThemeId');
				});
			})
			.toBe('monokai');

		await themePicker.press('Tab');
		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					return await window.maestro.settings.get('activeThemeId');
				});
			})
			.toBe('nord');
	});

	test('persists custom Theme initialization from a base theme', async () => {
		const settingsDialog = await openThemeSettings(window);
		const customBuilder = customThemeBuilder(settingsDialog);
		await customBuilder
			.getByRole('button', { name: /Custom/ })
			.first()
			.click();
		await customBuilder.getByRole('button', { name: /Initialize/ }).click();
		await customBuilder.getByRole('button', { name: /Nord/ }).click();

		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					const colors = await window.maestro.settings.get('customThemeColors');
					return {
						activeThemeId: await window.maestro.settings.get('activeThemeId'),
						baseId: await window.maestro.settings.get('customThemeBaseId'),
						bgMain: colors.bgMain,
						accent: colors.accent,
					};
				});
			})
			.toEqual({
				activeThemeId: 'custom',
				baseId: 'nord',
				bgMain: '#2e3440',
				accent: '#88c0d0',
			});
	});

	test('persists custom Theme color edits and reset controls', async () => {
		const settingsDialog = await openThemeSettings(window);
		const customBuilder = customThemeBuilder(settingsDialog);
		await customBuilder
			.getByRole('button', { name: /Custom/ })
			.first()
			.click();

		const accentRow = customBuilder
			.getByText('Accent', { exact: true })
			.locator('xpath=ancestor::div[contains(@class, "flex items-center gap-2")][1]');
		await accentRow.locator('button').last().click();
		const accentInput = accentRow.locator('input[type="text"]');
		await accentInput.fill('#123456');
		await accentInput.press('Enter');

		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					const colors = await window.maestro.settings.get('customThemeColors');
					return colors.accent;
				});
			})
			.toBe('#123456');

		await customBuilder.getByTitle('Reset to default').click();
		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					const colors = await window.maestro.settings.get('customThemeColors');
					return {
						baseId: await window.maestro.settings.get('customThemeBaseId'),
						accent: colors.accent,
					};
				});
			})
			.toEqual({ baseId: 'dracula', accent: '#bd93f9' });
	});

	test('imports valid custom Theme JSON and ignores invalid imports', async () => {
		const settingsDialog = await openThemeSettings(window);
		const customBuilder = customThemeBuilder(settingsDialog);
		const validColors = {
			bgMain: '#101820',
			bgSidebar: '#17212b',
			bgActivity: '#22303c',
			border: '#334455',
			textMain: '#f5f7fa',
			textDim: '#9aa6b2',
			accent: '#33aaff',
			accentDim: 'rgba(51, 170, 255, 0.24)',
			accentText: '#77ddff',
			accentForeground: '#07131f',
			success: '#44cc88',
			warning: '#ffcc66',
			error: '#ff6677',
		};
		const validThemePath = path.join(seededWorkbench.homeDir, 'valid-custom-theme.json');
		const invalidThemePath = path.join(seededWorkbench.homeDir, 'invalid-custom-theme.json');
		fs.writeFileSync(
			validThemePath,
			JSON.stringify({
				name: 'E2E Custom Theme',
				baseTheme: 'nord',
				colors: validColors,
			})
		);
		fs.writeFileSync(invalidThemePath, JSON.stringify({ colors: { accent: 'not-a-color' } }));

		await customBuilder.locator('input[type="file"]').setInputFiles(validThemePath);
		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					const colors = await window.maestro.settings.get('customThemeColors');
					return {
						baseId: await window.maestro.settings.get('customThemeBaseId'),
						bgMain: colors.bgMain,
						accent: colors.accent,
						accentDim: colors.accentDim,
					};
				});
			})
			.toEqual({
				baseId: 'nord',
				bgMain: validColors.bgMain,
				accent: validColors.accent,
				accentDim: validColors.accentDim,
			});

		await customBuilder.locator('input[type="file"]').setInputFiles(invalidThemePath);
		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					const colors = await window.maestro.settings.get('customThemeColors');
					return colors.accent;
				});
			})
			.toBe(validColors.accent);
	});

	test('persists Display Settings sizing and message alignment controls', async () => {
		const settingsDialog = await openSettingsTab(window, 'Display', 'Font Size');

		await settingsDialog
			.getByText('Font Size')
			.locator('xpath=ancestor::div[1]')
			.getByRole('button', { name: 'Large', exact: true })
			.click();
		await settingsDialog
			.getByText('Terminal Width (Columns)')
			.locator('xpath=ancestor::div[1]')
			.getByRole('button', { name: '120' })
			.click();
		await settingsDialog
			.getByText('Max Output Lines per Response')
			.locator('xpath=ancestor::div[1]')
			.getByRole('button', { name: '100' })
			.click();
		await settingsDialog
			.getByText('User Message Alignment')
			.locator('xpath=ancestor::div[1]')
			.getByRole('button', { name: 'Left' })
			.click();

		await expect
			.poll(async () => {
				return await window.evaluate(async () => ({
					fontSize: await window.maestro.settings.get('fontSize'),
					terminalWidth: await window.maestro.settings.get('terminalWidth'),
					maxOutputLines: await window.maestro.settings.get('maxOutputLines'),
					userMessageAlignment: await window.maestro.settings.get('userMessageAlignment'),
				}));
			})
			.toEqual({
				fontSize: 16,
				terminalWidth: 120,
				maxOutputLines: 100,
				userMessageAlignment: 'left',
			});
	});

	test('persists Display Settings window chrome and graph defaults', async () => {
		const settingsDialog = await openSettingsTab(window, 'Display', 'Font Size');

		await scrollSettingsToText(settingsDialog, 'Window Chrome');
		await settingsDialog
			.getByText('Use native title bar')
			.locator('xpath=ancestor::div[contains(@class, "flex")][1]')
			.getByRole('switch')
			.click();
		await settingsDialog
			.getByText('Auto-hide menu bar')
			.locator('xpath=ancestor::div[contains(@class, "flex")][1]')
			.getByRole('switch')
			.click();

		await scrollSettingsToText(settingsDialog, 'Document Graph');
		await settingsDialog
			.getByText('Show external links by default')
			.locator('xpath=ancestor::div[contains(@class, "flex")][1]')
			.getByRole('switch')
			.click();
		await settingsDialog
			.getByText('Maximum nodes to display')
			.locator('xpath=following::input[@type="range"][1]')
			.focus();
		await window.keyboard.press('ArrowRight');
		await window.keyboard.press('ArrowRight');

		await expect
			.poll(async () => {
				return await window.evaluate(async () => ({
					useNativeTitleBar: await window.maestro.settings.get('useNativeTitleBar'),
					autoHideMenuBar: await window.maestro.settings.get('autoHideMenuBar'),
					documentGraphShowExternalLinks: await window.maestro.settings.get(
						'documentGraphShowExternalLinks'
					),
					documentGraphMaxNodes: await window.maestro.settings.get('documentGraphMaxNodes'),
				}));
			})
			.toEqual({
				useNativeTitleBar: true,
				autoHideMenuBar: true,
				documentGraphShowExternalLinks: true,
				documentGraphMaxNodes: 150,
			});
	});

	test('validates and persists Display Settings Bionify algorithm input', async () => {
		const settingsDialog = await openSettingsTab(window, 'Display', 'Font Size');
		await scrollSettingsToText(settingsDialog, 'Bionify Algorithm');
		const algorithmInput = settingsDialog.getByLabel('Bionify algorithm');

		await algorithmInput.fill('invalid bionify algorithm');
		await algorithmInput.press('Enter');
		await expect(
			settingsDialog.locator('p').filter({ hasText: 'Enter `+|- len1 len2 len3 len4 fraction`' })
		).toBeVisible();
		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					return await window.maestro.settings.get('bionifyAlgorithm');
				});
			})
			.not.toBe('invalid bionify algorithm');

		await algorithmInput.fill('+ 1 1 2 2 0.5');
		await algorithmInput.press('Enter');
		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					return await window.maestro.settings.get('bionifyAlgorithm');
				});
			})
			.toBe('+ 1 1 2 2 0.5');
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

	test('persists local file indexing ignore patterns and reset behavior', async () => {
		await window.evaluate(async () => {
			await window.maestro.settings.set('localIgnorePatterns', []);
			await window.maestro.settings.set('localHonorGitignore', false);
		});
		const settingsDialog = await openSettingsTab(window, 'Display', 'Font Size');
		await scrollSettingsToText(settingsDialog, 'Local Ignore Patterns');
		const ignoreSection = settingsDialog
			.getByText('Local Ignore Patterns', { exact: true })
			.locator('xpath=ancestor::div[contains(@class, "flex items-start")][1]');
		const honorGitignore = ignoreSection.getByRole('checkbox', { name: 'Honor .gitignore' });
		const patternInput = ignoreSection.getByPlaceholder(
			'Enter glob pattern (e.g., node_modules, *.log)'
		);

		await expect(honorGitignore).toHaveAttribute('aria-checked', 'false');
		await honorGitignore.click();
		await expect(honorGitignore).toHaveAttribute('aria-checked', 'true');
		await patternInput.fill('dist-e2e');
		await patternInput.press('Enter');
		await expect(ignoreSection.getByText('dist-e2e')).toBeVisible();
		await patternInput.fill('dist-e2e');
		await ignoreSection.getByRole('button', { name: 'Add' }).click();
		await expect(ignoreSection.getByText('Pattern already exists')).toBeVisible();
		await expect
			.poll(async () => {
				return await window.evaluate(async () => ({
					honorGitignore: await window.maestro.settings.get('localHonorGitignore'),
					patterns: await window.maestro.settings.get('localIgnorePatterns'),
				}));
			})
			.toEqual({
				honorGitignore: true,
				patterns: ['dist-e2e'],
			});

		await ignoreSection.getByRole('button', { name: /Reset to defaults/ }).click();
		await expect
			.poll(async () => {
				return await window.evaluate(async () => ({
					honorGitignore: await window.maestro.settings.get('localHonorGitignore'),
					patterns: await window.maestro.settings.get('localIgnorePatterns'),
				}));
			})
			.toEqual({
				honorGitignore: true,
				patterns: ['.git', 'node_modules', '__pycache__'],
			});
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

	test('persists SSH remote ignore patterns and duplicate validation', async () => {
		const settingsDialog = await openSshSettings(window);
		await scrollSettingsToText(settingsDialog, 'Remote Ignore Patterns');
		const ignoreSection = settingsDialog
			.getByText('Remote Ignore Patterns', { exact: true })
			.locator('xpath=ancestor::div[contains(@class, "flex items-start")][1]');
		const patternInput = ignoreSection.getByPlaceholder(
			'Enter glob pattern (e.g., node_modules, *.log)'
		);
		const initialPatterns = await window.evaluate(async () => {
			return await window.maestro.settings.get('sshRemoteIgnorePatterns');
		});

		await patternInput.fill('e2e-cache');
		await patternInput.press('Enter');
		await expect(ignoreSection.getByText('e2e-cache')).toBeVisible();
		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					return await window.maestro.settings.get('sshRemoteIgnorePatterns');
				});
			})
			.toEqual([...initialPatterns, 'e2e-cache']);

		await patternInput.fill('e2e-cache');
		await ignoreSection.getByRole('button', { name: 'Add' }).click();
		await expect(ignoreSection.getByText('Pattern already exists')).toBeVisible();

		await ignoreSection
			.getByText('e2e-cache', { exact: true })
			.locator('xpath=ancestor::div[contains(@class, "flex items-center gap-1")][1]')
			.getByTitle('Remove pattern')
			.click();
		await expect(ignoreSection.getByText('e2e-cache')).toBeHidden();
		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					return await window.maestro.settings.get('sshRemoteIgnorePatterns');
				});
			})
			.toEqual(initialPatterns);
	});

	test('resets SSH remote ignore patterns and restores gitignore honoring', async () => {
		const settingsDialog = await openSshSettings(window);
		await scrollSettingsToText(settingsDialog, 'Remote Ignore Patterns');
		const ignoreSection = settingsDialog
			.getByText('Remote Ignore Patterns', { exact: true })
			.locator('xpath=ancestor::div[contains(@class, "flex items-start")][1]');
		const honorGitignore = ignoreSection.getByRole('checkbox', { name: 'Honor .gitignore' });
		const initialPatterns = await window.evaluate(async () => {
			return await window.maestro.settings.get('sshRemoteIgnorePatterns');
		});

		if ((await honorGitignore.getAttribute('aria-checked')) === 'true') {
			await honorGitignore.click();
		}
		await ignoreSection
			.getByPlaceholder('Enter glob pattern (e.g., node_modules, *.log)')
			.fill('tmp-build');
		await ignoreSection.getByRole('button', { name: 'Add' }).click();
		await expect
			.poll(async () => {
				return await window.evaluate(async () => ({
					honorGitignore: await window.maestro.settings.get('sshRemoteHonorGitignore'),
					patterns: await window.maestro.settings.get('sshRemoteIgnorePatterns'),
				}));
			})
			.toEqual({
				honorGitignore: false,
				patterns: [...initialPatterns, 'tmp-build'],
			});

		await ignoreSection.getByRole('button', { name: /Reset to defaults/ }).click();
		await expect
			.poll(async () => {
				return await window.evaluate(async () => ({
					honorGitignore: await window.maestro.settings.get('sshRemoteHonorGitignore'),
					patterns: await window.maestro.settings.get('sshRemoteIgnorePatterns'),
				}));
			})
			.toEqual({
				honorGitignore: true,
				patterns: ['.git', '*cache*'],
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

	test('routes the Notifications settings OS test notification through IPC', async () => {
		await stubNotificationHandlers(electronApp);
		const settingsDialog = await openSettingsTab(
			window,
			'Notifications',
			'Operating System Notifications'
		);

		await settingsDialog.getByRole('button', { name: 'Test Notification' }).click();
		await expect
			.poll(() => getStubbedNotificationCalls(electronApp))
			.toMatchObject({
				shows: [
					{
						title: 'Maestro',
						body: 'Test notification - notifications are working!',
					},
				],
			});
	});

	test('runs custom notification test command and handles completion', async () => {
		await stubNotificationHandlers(electronApp);
		const settingsDialog = await openSettingsTab(window, 'Notifications', 'Command Chain');

		await settingsDialog.getByPlaceholder('say').fill('printf notify-e2e');
		await settingsDialog.getByRole('button', { name: 'Test', exact: true }).click();
		await expect(settingsDialog.getByRole('button', { name: /Stop/ })).toBeVisible();
		await expect
			.poll(() => getStubbedNotificationCalls(electronApp))
			.toMatchObject({
				speaks: [
					{
						command: 'printf notify-e2e',
					},
				],
			});

		await emitNotificationCommandCompleted(electronApp, 7001);
		await expect(settingsDialog.getByRole('button', { name: /Success/ })).toBeVisible();
	});

	test('stops a running custom notification test command', async () => {
		await stubNotificationHandlers(electronApp);
		const settingsDialog = await openSettingsTab(window, 'Notifications', 'Command Chain');

		await settingsDialog.getByPlaceholder('say').fill('printf stop-e2e');
		await settingsDialog.getByRole('button', { name: 'Test', exact: true }).click();
		await settingsDialog.getByRole('button', { name: /Stop/ }).click();
		await expect
			.poll(() => getStubbedNotificationCalls(electronApp))
			.toMatchObject({ stops: [7001] });
		await expect(settingsDialog.getByRole('button', { name: 'Test', exact: true })).toBeVisible();
	});

	test('shows custom notification command errors from Settings test action', async () => {
		await stubNotificationHandlers(electronApp, 'error');
		const settingsDialog = await openSettingsTab(window, 'Notifications', 'Command Chain');

		await settingsDialog.getByPlaceholder('say').fill('bad-notify-e2e');
		await settingsDialog.getByRole('button', { name: 'Test', exact: true }).click();
		await expect(settingsDialog.getByRole('button', { name: /Failed/ })).toBeVisible();
		await expect(settingsDialog.getByText('E2E notification command failed')).toBeVisible();
		await expect
			.poll(() => getStubbedNotificationCalls(electronApp))
			.toMatchObject({
				speaks: [
					{
						command: 'bad-notify-e2e',
					},
				],
			});
	});

	test('persists Group Chat moderator standing instructions', async () => {
		const settingsDialog = await openSettingsTab(
			window,
			'Group Chat',
			'Moderator Standing Instructions'
		);
		const instructions =
			'Always keep delegated agents on feature branches.\nAsk for deterministic tests before synthesis.';

		await settingsDialog.getByPlaceholder(/Always instruct agents/).fill(instructions);
		await expect(settingsDialog.getByText(`${instructions.length} / 2000`)).toBeVisible();
		await expect
			.poll(async () => {
				return await window.evaluate(async () => {
					return await window.maestro.settings.get('moderatorStandingInstructions');
				});
			})
			.toBe(instructions);
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

	test('cancels new custom AI command creation without persisting the draft', async () => {
		const settingsDialog = await openSettingsTab(window, 'AI Commands', 'Custom AI Commands');

		await settingsDialog.getByRole('button', { name: 'Add Command' }).click();
		await settingsDialog.getByPlaceholder('/mycommand').fill('/e2e-cancel-command');
		await settingsDialog
			.getByPlaceholder('Short description for autocomplete')
			.fill('Draft command description');
		await settingsDialog
			.getByPlaceholder(/The actual prompt sent to the AI agent/)
			.fill('Draft prompt that should not persist.');
		await settingsDialog.getByRole('button', { name: 'Cancel' }).first().click();

		await expect(settingsDialog.getByText('/e2e-cancel-command')).toBeHidden();
		await expect(settingsDialog.getByRole('button', { name: 'Add Command' })).toBeVisible();
		await expect.poll(() => getCustomAICommand(window, '/e2e-cancel-command')).toBeNull();
	});

	test('auto-prefixes new custom AI commands and inserts template variables from autocomplete', async () => {
		const settingsDialog = await openSettingsTab(window, 'AI Commands', 'Custom AI Commands');

		await settingsDialog.getByRole('button', { name: 'Add Command' }).click();
		await settingsDialog.getByPlaceholder('/mycommand').fill('e2e-noslash');
		await settingsDialog
			.getByPlaceholder('Short description for autocomplete')
			.fill('No slash command description');
		const promptTextarea = settingsDialog.getByPlaceholder(
			/The actual prompt sent to the AI agent/
		);
		await promptTextarea.focus();
		await promptTextarea.type('Summarize {{CW');
		await expect(
			settingsDialog.locator('code').filter({ hasText: '{{CWD}}' }).first()
		).toBeVisible();
		await promptTextarea.press('Enter');
		await expect(promptTextarea).toHaveValue('Summarize {{CWD}}');

		await settingsDialog.getByRole('button', { name: 'Create' }).first().click();
		await expect(settingsDialog.getByRole('button', { name: /\/e2e-noslash/ })).toBeVisible();
		await expect
			.poll(() => getCustomAICommand(window, '/e2e-noslash'))
			.toMatchObject({
				command: '/e2e-noslash',
				description: 'No slash command description',
				prompt: 'Summarize {{CWD}}',
				isBuiltIn: false,
			});
	});

	test('blocks duplicate custom AI command names without adding a second command', async () => {
		const settingsDialog = await openSettingsTab(window, 'AI Commands', 'Custom AI Commands');

		for (const description of ['First duplicate command', 'Second duplicate command']) {
			await settingsDialog.getByRole('button', { name: 'Add Command' }).click();
			await settingsDialog.getByPlaceholder('/mycommand').fill('/e2e-dupe');
			await settingsDialog.getByPlaceholder('Short description for autocomplete').fill(description);
			await settingsDialog
				.getByPlaceholder(/The actual prompt sent to the AI agent/)
				.fill(`${description} prompt.`);
			await settingsDialog.getByRole('button', { name: 'Create' }).first().click();
		}

		await expect.poll(() => getCustomAICommandCount(window, '/e2e-dupe')).toBe(1);
		await expect(settingsDialog.getByText('Second duplicate command prompt.')).toBeVisible();
	});

	test('cancels built-in custom AI command edits and keeps delete unavailable', async () => {
		const settingsDialog = await openSettingsTab(window, 'AI Commands', 'Custom AI Commands');

		await settingsDialog.getByRole('button', { name: /\/commit/ }).click();
		const commitPanel = settingsDialog
			.getByText('/commit')
			.first()
			.locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]');
		await expect(commitPanel.getByText('Built-in')).toBeVisible();
		await expect(commitPanel.getByTitle('Delete command')).toHaveCount(0);

		await commitPanel.getByTitle('Edit command').click();
		await commitPanel.locator('textarea').fill('Unsaved built-in command prompt.');
		await commitPanel.getByRole('button', { name: 'Cancel' }).click();

		await expect(commitPanel.getByText('Built-in')).toBeVisible();
		await expect(commitPanel.getByText('Unsaved built-in command prompt.')).toBeHidden();
		await expect
			.poll(async () => {
				const command = await getCustomAICommand(window, '/commit');
				return command?.prompt ?? '';
			})
			.not.toBe('Unsaved built-in command prompt.');
	});

	test('edits built-in custom AI commands while preserving built-in status', async () => {
		const settingsDialog = await openSettingsTab(window, 'AI Commands', 'Custom AI Commands');

		await settingsDialog.getByRole('button', { name: /\/commit/ }).click();
		const commitPanel = settingsDialog
			.getByText('/commit')
			.first()
			.locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]');
		await commitPanel.getByTitle('Edit command').click();
		await commitPanel.locator('input').first().fill('commit-e2e');
		await commitPanel.locator('input').nth(1).fill('Commit command updated by E2E');
		await commitPanel
			.locator('textarea')
			.fill('Run the deterministic E2E commit flow for {{CWD}}.');
		await commitPanel.getByRole('button', { name: 'Save' }).click();

		await expect(settingsDialog.getByRole('button', { name: /\/commit-e2e/ })).toBeVisible();
		const updatedCommitPanel = settingsDialog
			.getByText('/commit-e2e')
			.first()
			.locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]');
		await expect(updatedCommitPanel.getByText('Built-in')).toBeVisible();
		await expect
			.poll(() => getCustomAICommand(window, '/commit-e2e'))
			.toMatchObject({
				command: '/commit-e2e',
				description: 'Commit command updated by E2E',
				prompt: 'Run the deterministic E2E commit flow for {{CWD}}.',
				isBuiltIn: true,
			});
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

	test('refreshes bundled Spec Kit and OpenSpec command metadata in Settings', async () => {
		await stubSpecKitAndOpenSpecCommands(electronApp);
		const settingsDialog = await openSettingsTab(window, 'AI Commands', 'Custom AI Commands');

		await expect(settingsDialog.getByText('v1.2.3')).toBeVisible();
		await expect(settingsDialog.getByText('v2.0.1')).toBeVisible();

		await settingsDialog.getByRole('button', { name: 'Check for Updates' }).nth(0).click();
		await expect(settingsDialog.getByText('v1.2.4')).toBeVisible();
		await expect(settingsDialog.getByText('v2.0.1')).toBeVisible();

		await settingsDialog.getByRole('button', { name: 'Check for Updates' }).nth(1).click();
		await expect(settingsDialog.getByText('v2.0.2')).toBeVisible();
	});

	test('cancels bundled command prompt edits without saving them', async () => {
		await stubSpecKitAndOpenSpecCommands(electronApp);
		const settingsDialog = await openSettingsTab(window, 'AI Commands', 'Custom AI Commands');

		await settingsDialog.getByRole('button', { name: /\/speckit\.specify/ }).click();
		const specKitPanel = settingsDialog
			.getByText('/speckit.specify')
			.first()
			.locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]');
		await expect(specKitPanel.getByText('Bundled specify prompt for {{CWD}}.')).toBeVisible();

		await specKitPanel.getByTitle('Edit prompt').click();
		await specKitPanel.locator('textarea').fill('Unsaved Spec Kit prompt.');
		await specKitPanel.getByRole('button', { name: 'Cancel' }).click();
		await expect(specKitPanel.getByText('Bundled specify prompt for {{CWD}}.')).toBeVisible();
		await expect(specKitPanel.getByText('Unsaved Spec Kit prompt.')).toBeHidden();
	});

	test('opens bundled Spec Kit and OpenSpec source links through shell IPC', async () => {
		await stubSpecKitAndOpenSpecCommands(electronApp);
		await stubOpenExternal(electronApp);
		const settingsDialog = await openSettingsTab(window, 'AI Commands', 'Custom AI Commands');

		await settingsDialog.getByRole('button', { name: /github\/spec-kit/ }).click();
		await expect
			.poll(() => getStubbedOpenExternalUrl(electronApp))
			.toBe('https://github.com/github/spec-kit');

		await stubOpenExternal(electronApp);
		await settingsDialog.getByRole('button', { name: /Fission-AI\/OpenSpec/ }).click();
		await expect
			.poll(() => getStubbedOpenExternalUrl(electronApp))
			.toBe('https://github.com/Fission-AI/OpenSpec');
	});

	test('shows empty bundled Spec Kit and OpenSpec command states in Settings', async () => {
		await stubEmptySpecKitAndOpenSpecCommands(electronApp);
		const settingsDialog = await openSettingsTab(window, 'AI Commands', 'Custom AI Commands');

		await expect(settingsDialog.getByText('empty-spec-kit')).toBeVisible();
		await expect(settingsDialog.getByText('empty-openspec')).toBeVisible();
		await expect(settingsDialog.getByText('No spec-kit commands loaded')).toBeVisible();
		await expect(settingsDialog.getByText('No OpenSpec commands loaded')).toBeVisible();
	});
});

test.describe('Codex AI terminal active error recovery', () => {
	let window: Page;
	let cleanupApp: (() => Promise<void>) | undefined;

	test.afterEach(async () => {
		await cleanupApp?.();
		cleanupApp = undefined;
	});

	async function launchActiveErrorWorkbench() {
		const seeded = createActiveCodexErrorWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});
		window = launched.window;
		cleanupApp = launched.cleanup;
		return seeded;
	}

	test('shows recoverable active Codex error banner controls', async () => {
		await launchActiveErrorWorkbench();
		await openSeededCodexAiTerminal(window);

		await expect(window.getByText('Codex active recoverable network error sentinel')).toBeVisible();
		await expect(window.getByRole('button', { name: 'View Details' })).toBeVisible();
		await expect(window.getByTitle('Dismiss error')).toBeVisible();
	});

	test('dismisses an active Codex error banner from the main panel', async () => {
		await launchActiveErrorWorkbench();
		await openSeededCodexAiTerminal(window);

		await expect(window.getByText('Codex active recoverable network error sentinel')).toBeVisible();
		await window.getByTitle('Dismiss error').click();

		await expect(window.getByText('Codex active recoverable network error sentinel')).toBeHidden();
		await expect(window.getByTitle('Dismiss error')).toHaveCount(0);
	});

	test('shows non-recoverable active Codex error without dismiss control', async () => {
		const seeded = createActiveCodexErrorWorkbench({
			message: 'Codex non-recoverable permission error sentinel',
			recoverable: false,
		});
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});
		window = launched.window;
		cleanupApp = launched.cleanup;

		await openSeededCodexAiTerminal(window);
		await expect(window.getByText('Codex non-recoverable permission error sentinel')).toBeVisible();
		await expect(window.getByRole('button', { name: 'View Details' })).toBeVisible();
		await expect(window.getByTitle('Dismiss error')).toHaveCount(0);
	});
});

test.describe('Codex AI terminal queue controls', () => {
	let window: Page;
	let cleanupApp: (() => Promise<void>) | undefined;

	test.afterEach(async () => {
		await cleanupApp?.();
		cleanupApp = undefined;
	});

	test('opens the Codex execution queue browser from the input indicator', async () => {
		const seeded = createQueuedCodexWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});
		window = launched.window;
		cleanupApp = launched.cleanup;

		await openSeededCodexAiTerminal(window);
		const queueIndicator = window.getByRole('button', { name: /2 items queued/ });
		await expect(queueIndicator).toBeVisible();
		await expect(queueIndicator.getByText('Main (2)')).toBeVisible();

		await queueIndicator.click();
		await expect(window.getByText('Execution Queue')).toBeVisible();
		await expect(window.getByText('2 total')).toBeVisible();
		await expect(window.getByText('Current Agent')).toBeVisible();
		await expect(window.getByText('Queued Codex prompt sentinel').first()).toBeVisible();
		await expect(window.getByText('/commit queued command sentinel').first()).toBeVisible();
	});
});

test.describe('File Explorer state variants', () => {
	let window: Page;
	let cleanupApp: (() => Promise<void>) | undefined;

	test.afterEach(async () => {
		await cleanupApp?.();
		cleanupApp = undefined;
	});

	test('shows an empty File Explorer state for an empty project root', async () => {
		const seeded = createFileExplorerStateWorkbench('empty');
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});
		window = launched.window;
		cleanupApp = launched.cleanup;

		await helpers.openRightPanelTab(window, 'Files');
		await expect(window.getByText('No files found')).toBeVisible();
		await expect(window.getByTitle(/Refresh file tree|Auto-refresh every/)).toBeVisible();
	});

	test('shows a File Explorer error state with retry affordance', async () => {
		const seeded = createFileExplorerStateWorkbench('error');
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});
		window = launched.window;
		cleanupApp = launched.cleanup;

		await helpers.openRightPanelTab(window, 'Files');
		await expect(window.getByText('E2E file tree error sentinel')).toBeVisible();
		await expect(window.getByRole('button', { name: 'Retry Connection' })).toBeVisible();
	});

	test('shows File Explorer retry countdown and manual retry handoff', async () => {
		const seeded = createFileExplorerStateWorkbench('retry');
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});
		window = launched.window;
		cleanupApp = launched.cleanup;

		await helpers.openRightPanelTab(window, 'Files');
		await expect(window.getByText('E2E file tree error sentinel')).toBeVisible();
		await expect(window.getByText(/Retrying in \d+s/)).toBeVisible();
		await window.getByRole('button', { name: 'Retry Now' }).click();
		await expect(window.getByRole('button', { name: 'Retry Connection' })).toBeVisible();
	});
});

test.describe('Codex AI terminal static transcript surfaces', () => {
	let window: Page;
	let cleanupApp: (() => Promise<void>) | undefined;
	let seededWorkbench: ReturnType<typeof createSeededWorkbench>;

	test.beforeEach(async () => {
		seededWorkbench = createSeededWorkbench();
		appendCodexStaticSurfaceLogs(seededWorkbench);
		const launched = await helpers.launchAppWithState({
			homeDir: seededWorkbench.homeDir,
			sessions: seededWorkbench.sessions,
		});
		window = launched.window;
		cleanupApp = launched.cleanup;
	});

	test.afterEach(async () => {
		await cleanupApp?.();
		cleanupApp = undefined;
	});

	test('renders Codex thinking and tool transcript entries with status details', async () => {
		await openSeededCodexAiTerminal(window);

		const thinkingBlock = window.locator('[data-log-index="3"]');
		await expect(
			thinkingBlock.getByText('Codex static thinking sentinel about safe terminal coverage.')
		).toBeVisible();
		await expect(thinkingBlock.getByText('thinking', { exact: true })).toBeVisible();

		const runningTool = window.locator('[data-log-index="4"]');
		await expect(runningTool.getByText('shell', { exact: true })).toBeVisible();
		await expect(runningTool.getByText('npm run lint -- --watch=false')).toBeVisible();
		await expect(runningTool.getByText('●')).toBeVisible();

		const completedTool = window.locator('[data-log-index="5"]');
		await expect(completedTool.getByText('read', { exact: true })).toBeVisible();
		await expect(completedTool.getByText('src/renderer/App.tsx')).toBeVisible();
		await expect(completedTool.getByText('✓')).toBeVisible();

		const failedTool = window.locator('[data-log-index="6"]');
		await expect(failedTool.getByText('apply_patch', { exact: true })).toBeVisible();
		await expect(failedTool.getByText('failed patch sentinel')).toBeVisible();
	});

	test('opens Codex historical error details from the transcript', async () => {
		await openSeededCodexAiTerminal(window);

		const errorBlock = window.locator('[data-log-index="7"]');
		await expect(
			errorBlock.getByText('Codex static error sentinel: command failed before retry.')
		).toBeVisible();
		await errorBlock.getByRole('button', { name: 'View Details' }).click();

		const errorModal = modalRootByHeading(window, 'Agent Error');
		await expect(errorModal).toBeVisible();
		await expect(errorModal.getByText('Codex historical error detail sentinel')).toBeVisible();
		await errorModal.getByRole('button', { name: 'Error Details (JSON)' }).click();
		await expect(errorModal.getByText('synthetic_e2e_static_error')).toBeVisible();
	});
});

test.describe('Command terminal output controls', () => {
	let window: Page;
	let cleanupApp: (() => Promise<void>) | undefined;

	test.beforeEach(async () => {
		const seeded = createScrollableTerminalWorkbench();
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

	test('scrolls terminal output with keyboard navigation shortcuts', async () => {
		await openSeededTerminalAgent(window);
		const terminalOutput = window.getByLabel('Terminal output');
		const scrollState = await getTerminalOutputScrollState(window);
		expect(scrollState.maxScrollTop).toBeGreaterThan(100);

		await terminalOutput.focus();
		await terminalOutput.press('Meta+ArrowUp');
		await expect.poll(async () => (await getTerminalOutputScrollState(window)).scrollTop).toBe(0);

		await terminalOutput.press('ArrowDown');
		await expect
			.poll(async () => (await getTerminalOutputScrollState(window)).scrollTop)
			.toBeGreaterThan(0);
		const lineScrollTop = (await getTerminalOutputScrollState(window)).scrollTop;

		await terminalOutput.press('Alt+ArrowDown');
		await expect
			.poll(async () => (await getTerminalOutputScrollState(window)).scrollTop)
			.toBeGreaterThan(lineScrollTop);

		await terminalOutput.press('Meta+ArrowDown');
		await expect
			.poll(async () => {
				const current = await getTerminalOutputScrollState(window);
				return current.maxScrollTop - current.scrollTop <= 2;
			})
			.toBe(true);
		const bottomScrollTop = (await getTerminalOutputScrollState(window)).scrollTop;

		await terminalOutput.press('Alt+ArrowUp');
		await expect
			.poll(async () => (await getTerminalOutputScrollState(window)).scrollTop)
			.toBeLessThan(bottomScrollTop);
	});

	test('jumps command terminal output to the bottom from the global shortcut', async () => {
		await openSeededTerminalAgent(window);
		const terminalOutput = window.getByLabel('Terminal output');
		const scrollState = await getTerminalOutputScrollState(window);
		expect(scrollState.maxScrollTop).toBeGreaterThan(100);

		await terminalOutput.focus();
		await terminalOutput.press('Meta+ArrowUp');
		await expect.poll(async () => (await getTerminalOutputScrollState(window)).scrollTop).toBe(0);

		await terminalOutput.press('Meta+Shift+J');
		await expect
			.poll(async () => {
				const current = await getTerminalOutputScrollState(window);
				return current.maxScrollTop - current.scrollTop <= 2;
			})
			.toBe(true);
	});

	test('expands collapsed command terminal output from the transcript control', async () => {
		await openSeededTerminalAgent(window);

		await expect(
			window.getByText('terminal scroll line 001 e2e output navigation sentinel')
		).toBeVisible();
		await expect(
			window.getByText('terminal scroll line 140 e2e output navigation sentinel')
		).toHaveCount(0);

		await window.getByRole('button', { name: 'Show all 140 lines' }).click();

		await expect(window.getByRole('button', { name: 'Show less' })).toBeVisible();
		await expect(
			window.getByText('terminal scroll line 140 e2e output navigation sentinel')
		).toBeVisible();
	});

	test('recollapses expanded command terminal output from the transcript control', async () => {
		await openSeededTerminalAgent(window);

		await window.getByRole('button', { name: 'Show all 140 lines' }).click();
		await expect(
			window.getByText('terminal scroll line 140 e2e output navigation sentinel')
		).toBeVisible();

		await window.getByRole('button', { name: 'Show less' }).click();

		await expect(window.getByRole('button', { name: 'Show all 140 lines' })).toBeVisible();
		await expect(
			window.getByText('terminal scroll line 140 e2e output navigation sentinel')
		).toHaveCount(0);
	});

	test('keeps matching collapsed command terminal output expandable from search', async () => {
		await openSeededTerminalAgent(window);
		await window.getByLabel('Terminal output').press('Control+f');

		const searchInput = window.getByPlaceholder('Search output... (Esc to close)');
		await searchInput.fill('line 140 e2e output navigation');

		await expect(
			window.getByText('terminal scroll line 001 e2e output navigation sentinel')
		).toBeVisible();
		await expect(
			window.getByText('terminal scroll line 140 e2e output navigation sentinel')
		).toHaveCount(0);
		await expect(window.getByRole('button', { name: 'Show all 140 lines' })).toBeVisible();

		await window.getByRole('button', { name: 'Show all 140 lines' }).click();
		await expect(
			window.getByText('terminal scroll line 140 e2e output navigation sentinel')
		).toBeVisible();

		await searchInput.press('Escape');
		await expect(searchInput).toBeHidden();
		await expect(window.getByRole('button', { name: 'Show less' })).toBeVisible();
	});

	test('closes command terminal output search without clearing transcript content', async () => {
		await openSeededTerminalAgent(window);
		const terminalOutput = window.getByLabel('Terminal output');
		await terminalOutput.press('Control+f');

		const searchInput = window.getByPlaceholder('Search output... (Esc to close)');
		await searchInput.fill('terminal seeded output');
		await expect(window.getByText('terminal seeded output is visible')).toBeVisible();

		await searchInput.press('Escape');

		await expect(searchInput).toBeHidden();
		await expect(window.getByText('terminal seeded output is visible')).toBeVisible();
		await expect(window.getByRole('button', { name: 'Show all 140 lines' })).toBeVisible();
	});

	test('keeps long command terminal output collapsed while searching visible text', async () => {
		await openSeededTerminalAgent(window);
		await window.getByLabel('Terminal output').press('Control+f');

		const searchInput = window.getByPlaceholder('Search output... (Esc to close)');
		await searchInput.fill('line 001 e2e output navigation');

		await expect(
			window.getByText('terminal scroll line 001 e2e output navigation sentinel')
		).toBeVisible();
		await expect(
			window.getByText('terminal scroll line 140 e2e output navigation sentinel')
		).toHaveCount(0);
		await expect(window.getByRole('button', { name: 'Show all 140 lines' })).toBeVisible();
	});

	test('returns focus to the terminal input when Escape is pressed from output', async () => {
		const terminalInput = await openSeededTerminalAgent(window);
		const terminalOutput = window.getByLabel('Terminal output');

		await terminalOutput.focus();
		await expect(terminalOutput).toBeFocused();
		await terminalOutput.press('Escape');

		await expect(terminalInput).toBeFocused();
	});

	test('clears command terminal history from Quick Actions', async () => {
		await openSeededTerminalAgent(window);
		await expect(window.getByText('terminal seeded output is visible')).toBeVisible();
		await expect(window.getByRole('button', { name: 'Show all 140 lines' })).toBeVisible();

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Clear Terminal History');
		await quickActionsDialog.getByRole('button', { name: /Clear Terminal History/ }).click();

		await expect(quickActionsDialog).toBeHidden();
		await expect(window.getByText('terminal seeded output is visible')).toHaveCount(0);
		await expect(window.getByRole('button', { name: 'Show all 140 lines' })).toHaveCount(0);
		await expect(window.getByLabel('Terminal output')).toBeVisible();
	});

	test('preserves command terminal drafts when clearing history from Quick Actions', async () => {
		const terminalInput = await openSeededTerminalAgent(window);
		await terminalInput.fill('manual draft before clear history sentinel');

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Clear Terminal History');
		await quickActionsDialog.getByRole('button', { name: /Clear Terminal History/ }).click();

		await expect(quickActionsDialog).toBeHidden();
		await expect(window.locator('[data-log-index]')).toHaveCount(0);
		await expect(terminalInput).toHaveValue('manual draft before clear history sentinel');
	});

	test('clears command terminal history while output search is open', async () => {
		await openSeededTerminalAgent(window);
		await window.getByLabel('Terminal output').press('Control+f');
		await window.getByPlaceholder('Search output... (Esc to close)').fill('terminal seeded output');
		await expect(window.getByText('terminal seeded output is visible')).toBeVisible();

		const quickActionsDialog = await openQuickActions(window);
		await quickActionsDialog
			.getByPlaceholder('Type a command or jump to agent...')
			.fill('Clear Terminal History');
		await quickActionsDialog.getByRole('button', { name: /Clear Terminal History/ }).click();

		await expect(quickActionsDialog).toBeHidden();
		await expect(window.getByText('terminal seeded output is visible')).toHaveCount(0);
		await expect(window.getByLabel('Terminal output')).toBeVisible();
	});
});

test.describe('Command terminal SSH remote surfaces', () => {
	let window: Page;
	let electronApp: ElectronApplication;
	let cleanupApp: (() => Promise<void>) | undefined;
	let seededWorkbench: ReturnType<typeof createSeededWorkbench>;

	test.beforeEach(async () => {
		seededWorkbench = createSeededWorkbench();
		enableTerminalSshRemote(seededWorkbench);
		const launched = await helpers.launchAppWithState({
			homeDir: seededWorkbench.homeDir,
			sessions: seededWorkbench.sessions,
		});
		window = launched.window;
		electronApp = launched.electronApp;
		cleanupApp = launched.cleanup;
		await seedSshRemoteConfig(window);
	});

	test.afterEach(async () => {
		await cleanupApp?.();
		cleanupApp = undefined;
	});

	test('routes SSH terminal commands through the remote cwd and config', async () => {
		await stubTerminalRunCommand(electronApp);
		const terminalInput = await openSeededTerminalAgent(window);
		const inputArea = window.locator('[data-tour="input-area"]');

		await expect(window.getByTitle('SSH Remote: E2E SSH Remote')).toBeVisible();
		await terminalInput.fill('pwd');
		await inputArea.getByTitle('Run command (Enter)').click();

		await expect(
			window.locator('[data-log-index]').last().getByText(E2E_SSH_REMOTE_CURRENT_CWD)
		).toBeVisible();
		const calls = await getStubbedTerminalRunCommandCalls(electronApp);
		await expect(calls[0]).toMatchObject({
			command: 'pwd',
			cwd: E2E_SSH_REMOTE_CURRENT_CWD,
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: E2E_SSH_REMOTE_ID,
				workingDirOverride: E2E_SSH_REMOTE_BASE_CWD,
			},
		});
	});

	test('resets SSH terminal cwd to the configured remote working directory with bare cd', async () => {
		await stubTerminalRunCommand(electronApp);
		const terminalInput = await openSeededTerminalAgent(window);
		const inputArea = window.locator('[data-tour="input-area"]');

		await terminalInput.fill('cd');
		await inputArea.getByTitle('Run command (Enter)').click();
		await expect(inputArea.getByText(E2E_SSH_REMOTE_BASE_CWD)).toBeVisible();

		await terminalInput.fill('pwd');
		await inputArea.getByTitle('Run command (Enter)').click();

		await expect(
			window.locator('[data-log-index]').last().getByText(E2E_SSH_REMOTE_BASE_CWD)
		).toBeVisible();
		const calls = await getStubbedTerminalRunCommandCalls(electronApp);
		await expect(calls.map((call) => call.command)).toEqual(['cd', 'pwd']);
		await expect(calls[0].cwd).toBe(E2E_SSH_REMOTE_CURRENT_CWD);
		await expect(calls[1].cwd).toBe(E2E_SSH_REMOTE_BASE_CWD);
	});

	test('routes SSH terminal history selections through the remote cwd and config', async () => {
		await stubTerminalRunCommand(electronApp);
		const terminalInput = await openSeededTerminalAgent(window);

		await terminalInput.focus();
		await terminalInput.press('ArrowUp');
		const historyFilter = window.getByPlaceholder('Filter commands...');
		await historyFilter.fill('status');
		await historyFilter.press('Enter');
		await terminalInput.press('Enter');

		const calls = await getStubbedTerminalRunCommandCalls(electronApp);
		await expect(calls[0]).toMatchObject({
			command: 'git status --short',
			cwd: E2E_SSH_REMOTE_CURRENT_CWD,
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: E2E_SSH_REMOTE_ID,
				workingDirOverride: E2E_SSH_REMOTE_BASE_CWD,
			},
		});
	});

	test('routes SSH slash-prefixed terminal commands through the remote config', async () => {
		await stubTerminalRunCommand(electronApp);
		const terminalInput = await openSeededTerminalAgent(window);

		await terminalInput.fill('/clear');
		await terminalInput.press('Enter');

		const calls = await getStubbedTerminalRunCommandCalls(electronApp);
		await expect(calls[0]).toMatchObject({
			command: '/clear',
			cwd: E2E_SSH_REMOTE_CURRENT_CWD,
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: E2E_SSH_REMOTE_ID,
				workingDirOverride: E2E_SSH_REMOTE_BASE_CWD,
			},
		});
	});
});
