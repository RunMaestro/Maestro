import { test, expect, helpers } from './fixtures/electron-app';
import type { ElectronApplication, Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';

type CodexProcessSpawnCall = {
	sessionId: string;
	toolType?: string;
	cwd?: string;
	prompt?: string;
	readOnlyMode?: boolean;
};

type WorktreeSetupCall = {
	mainRepoCwd: string;
	worktreePath: string;
	branchName: string;
	sshRemoteId?: string;
};

type LaneAgentError = {
	type:
		| 'auth_expired'
		| 'token_exhaustion'
		| 'rate_limited'
		| 'network_error'
		| 'agent_crashed'
		| 'permission_denied';
	message: string;
	recoverable: boolean;
	agentId: 'codex';
	sessionId: string;
	timestamp: number;
	raw?: Record<string, unknown>;
	parsedJson?: Record<string, unknown>;
};

type WorktreeGitStubOptions = {
	branches?: string[];
	currentBranch?: string;
	gitSubdirs?: Array<{ path: string; name: string; branch: string | null }>;
	branchesError?: boolean;
	worktreeSetup?: { success?: boolean; error?: string; delayMs?: number };
};

function createLaneWorkbench() {
	const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-e2e-autorun-ai-'));
	const projectDir = path.join(homeDir, 'project');
	const autoRunFolder = path.join(projectDir, 'Auto Run Docs');
	const phaseOnePath = path.join(autoRunFolder, 'Phase 1.md');
	const phaseTwoPath = path.join(autoRunFolder, 'Phase 2.md');
	const now = Date.now();
	const idSuffix = `${now}-${Math.random().toString(36).slice(2)}`;
	const sessionId = `session-autorun-ai-${idSuffix}`;
	const aiTabId = `ai-tab-autorun-ai-${idSuffix}`;
	const codexLogs = [
		{
			id: `ai-log-autorun-ai-system-${idSuffix}`,
			timestamp: now,
			source: 'stdout',
			text: '# Codex Lane Transcript\n\nCodex lane seeded response is visible.',
		},
		{
			id: `ai-log-autorun-ai-user-${idSuffix}`,
			timestamp: now + 1,
			source: 'user',
			text: 'Review Auto Run lane coverage without a live provider',
			delivered: true,
		},
		{
			id: `ai-log-autorun-ai-paired-${idSuffix}`,
			timestamp: now + 2,
			source: 'stdout',
			text: '# Codex Lane Paired Response\n\nCodex paired response for delivered user action coverage.',
		},
	];
	const phaseOneContent = `# Phase 1: Lane Setup

## Tasks

- [ ] Wire deterministic Auto Run coverage
- [x] Keep Codex provider execution stubbed
- [ ] Record lane progress

Codex auto-run lane sentinel.
`;

	fs.mkdirSync(autoRunFolder, { recursive: true });
	fs.writeFileSync(phaseOnePath, phaseOneContent, 'utf-8');
	fs.writeFileSync(
		phaseTwoPath,
		`# Phase 2: Lane Follow-up

## Tasks

- [ ] Expand remaining Auto Run matrix
- [ ] Expand remaining Codex terminal matrix

Codex second document sentinel.
`,
		'utf-8'
	);
	fs.writeFileSync(path.join(projectDir, 'README.md'), '# Auto Run Codex Project\n', 'utf-8');
	fs.writeFileSync(path.join(projectDir, 'NOTES.md'), '# Auto Run Codex Notes\n', 'utf-8');

	return {
		homeDir,
		projectDir,
		autoRunFolder,
		phaseOnePath,
		phaseTwoPath,
		phaseOneContent,
		sessions: [
			{
				id: sessionId,
				name: 'Auto Run Codex E2E',
				toolType: 'codex',
				state: 'idle',
				cwd: projectDir,
				fullPath: projectDir,
				projectRoot: projectDir,
				createdAt: now,
				aiLogs: codexLogs,
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
						agentSessionId: 'thread_autorun_ai_terminal_seed',
						name: 'Main',
						starred: false,
						logs: codexLogs,
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
				autoRunContent: phaseOneContent,
				autoRunContentVersion: 1,
				autoRunMode: 'preview',
				autoRunEditScrollPos: 0,
				autoRunPreviewScrollPos: 0,
				autoRunCursorPosition: 0,
			},
		],
	};
}

async function launchLaneWorkbench() {
	const seeded = createLaneWorkbench();
	const launched = await helpers.launchAppWithState({
		homeDir: seeded.homeDir,
		sessions: seeded.sessions,
	});

	return { ...seeded, ...launched };
}

function createQueuedLaneWorkbench() {
	const seeded = createLaneWorkbench();
	const session = seeded.sessions[0]!;
	const activeTab = session.aiTabs[0]!;
	const longQueuedPrompt = Array.from(
		{ length: 18 },
		(_, index) =>
			`Codex queued long prompt line ${String(index + 1).padStart(2, '0')} for Auto Run lane coverage`
	).join('\n');

	session.executionQueue = [
		{
			id: 'queued-autorun-ai-long-message',
			timestamp: Date.now() - 1_000,
			tabId: activeTab.id,
			type: 'message',
			text: longQueuedPrompt,
			images: ['data:image/png;base64,iVBORw0KGgo='],
			tabName: activeTab.name || 'Main',
			readOnlyMode: true,
		},
		{
			id: 'queued-autorun-ai-command',
			timestamp: Date.now() - 500,
			tabId: activeTab.id,
			type: 'command',
			command: '/history',
			commandDescription: 'Generate a synopsis of this agent history',
			tabName: activeTab.name || 'Main',
		},
	];

	return { ...seeded, longQueuedPrompt };
}

function createMultiTabQueuedLaneWorkbench() {
	const seeded = createLaneWorkbench();
	const session = seeded.sessions[0]!;
	const activeTab = session.aiTabs[0]!;
	const now = Date.now();
	const reviewTabId = `ai-tab-autorun-ai-review-${now}`;
	const reviewLog = {
		id: `ai-log-autorun-ai-review-${now}`,
		timestamp: now + 3,
		source: 'stdout',
		text: 'Codex queued Review tab transcript sentinel.',
	};

	session.aiTabs.push({
		id: reviewTabId,
		agentSessionId: 'thread_autorun_ai_terminal_review',
		name: 'Review',
		starred: false,
		logs: [reviewLog],
		inputValue: '',
		stagedImages: [],
		createdAt: now,
		state: 'idle',
	});
	session.unifiedTabOrder.push({ type: 'ai', id: reviewTabId });
	session.executionQueue = [
		{
			id: 'queued-autorun-ai-main-message',
			timestamp: now - 1_000,
			tabId: activeTab.id,
			type: 'message',
			text: 'Codex queued Main tab prompt sentinel',
			tabName: activeTab.name || 'Main',
		},
		{
			id: 'queued-autorun-ai-main-command',
			timestamp: now - 900,
			tabId: activeTab.id,
			type: 'command',
			command: '/compact',
			commandDescription: 'Summarize the Main tab before continuing',
			tabName: activeTab.name || 'Main',
		},
		{
			id: 'queued-autorun-ai-review-message',
			timestamp: now - 800,
			tabId: reviewTabId,
			type: 'message',
			text: 'Codex queued Review tab prompt sentinel',
			tabName: 'Review',
		},
	];

	return { ...seeded, reviewTabId };
}

function createCrossSessionQueuedLaneWorkbench() {
	const seeded = createQueuedLaneWorkbench();
	const baseSession = seeded.sessions[0]!;
	const now = Date.now();
	const companionSession = JSON.parse(JSON.stringify(baseSession)) as typeof baseSession;
	const companionSessionId = `session-autorun-ai-companion-${now}`;
	const companionTabId = `ai-tab-autorun-ai-companion-${now}`;
	const companionLog = {
		id: `ai-log-autorun-ai-companion-${now}`,
		timestamp: now + 4,
		source: 'stdout',
		text: 'Companion Codex transcript sentinel.',
	};

	companionSession.id = companionSessionId;
	companionSession.name = 'Queued Companion Codex';
	companionSession.aiTabs = [
		{
			...companionSession.aiTabs[0]!,
			id: companionTabId,
			agentSessionId: 'thread_autorun_ai_terminal_companion',
			name: 'Main',
			logs: [companionLog],
			createdAt: now,
		},
	];
	companionSession.aiLogs = [companionLog];
	companionSession.activeTabId = companionTabId;
	companionSession.unifiedTabOrder = [{ type: 'ai', id: companionTabId }];
	companionSession.executionQueue = [
		{
			id: 'queued-autorun-ai-companion-message',
			timestamp: now - 250,
			tabId: companionTabId,
			type: 'message',
			text: 'Companion Codex queued prompt sentinel',
			tabName: 'Main',
		},
	];
	seeded.sessions.push(companionSession);

	return { ...seeded, companionSessionId, companionTabId };
}

function createPreviewLinkLaneWorkbench() {
	const seeded = createLaneWorkbench();
	const session = seeded.sessions[0]!;
	const imagesDir = path.join(seeded.autoRunFolder, 'images');
	const imageFilename = 'Phase 1-Codex Lane.png';
	const richContent = `# Phase 1: Lane Setup

See [[Phase 2|Phase Two Follow-up]] and [Phase 2 markdown](Phase 2.md).

[RunMaestro external](https://runmaestro.ai/autorun-lane)

![Codex preview image](images/Phase%201-Codex%20Lane.png)

![Missing Codex preview](images/missing-codex-preview.png)

## Tasks

- [ ] Wire deterministic Auto Run coverage
- [x] Keep Codex provider execution stubbed
- [ ] Record lane progress

Codex auto-run lane sentinel.
`;

	fs.mkdirSync(imagesDir, { recursive: true });
	fs.writeFileSync(
		path.join(imagesDir, imageFilename),
		Buffer.from(
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
			'base64'
		)
	);
	fs.writeFileSync(seeded.phaseOnePath, richContent, 'utf-8');
	session.autoRunContent = richContent;
	session.autoRunContentVersion = 2;

	return { ...seeded, phaseOneContent: richContent, imageFilename };
}

function createBatchConfigLaneWorkbench() {
	const seeded = createLaneWorkbench();
	const referencePath = path.join(seeded.autoRunFolder, 'Reference.md');

	fs.writeFileSync(
		referencePath,
		`# Reference

This Codex lane document intentionally has no runnable checkbox tasks.
`,
		'utf-8'
	);

	return { ...seeded, referencePath };
}

function createWorktreeBatchLaneWorkbench(
	options: {
		configured?: boolean;
		withChild?: boolean;
		childState?: 'idle' | 'busy' | 'connecting' | 'error';
	} = {}
) {
	const seeded = createBatchConfigLaneWorkbench();
	const session = seeded.sessions[0]! as (typeof seeded.sessions)[number] & {
		gitBranches?: string[];
		worktreeConfig?: { basePath: string; watchEnabled: boolean };
	};
	const now = Date.now();
	const worktreesDir = path.join(seeded.homeDir, 'worktrees');
	const childBranch = 'feat/autorun-review';
	const childSessionId = `session-autorun-ai-worktree-${now}`;
	const childWorktreeDir = path.join(worktreesDir, 'feat-autorun-review');
	const childAutoRunFolder = path.join(childWorktreeDir, 'Auto Run Docs');
	const childAiTabId = `ai-tab-autorun-ai-worktree-${now}`;
	const childLog = {
		id: `ai-log-autorun-ai-worktree-${now}`,
		timestamp: now + 5,
		source: 'stdout',
		text: 'Codex Auto Run worktree transcript sentinel.',
	};

	fs.mkdirSync(worktreesDir, { recursive: true });
	session.isGitRepo = true;
	session.gitBranches = ['main', childBranch];
	if (options.configured !== false) {
		session.worktreeConfig = { basePath: worktreesDir, watchEnabled: false };
	}

	if (options.withChild) {
		fs.mkdirSync(childAutoRunFolder, { recursive: true });
		fs.writeFileSync(
			path.join(childAutoRunFolder, 'Phase 1.md'),
			'# Phase 1\n\n- [ ] Review worktree Auto Run target\n',
			'utf-8'
		);
		seeded.sessions.push({
			...session,
			id: childSessionId,
			name: childBranch,
			state: options.childState ?? 'idle',
			cwd: childWorktreeDir,
			fullPath: childWorktreeDir,
			projectRoot: childWorktreeDir,
			parentSessionId: session.id,
			worktreeBranch: childBranch,
			worktreeConfig: undefined,
			aiLogs: [childLog],
			aiTabs: [
				{
					...session.aiTabs[0]!,
					id: childAiTabId,
					agentSessionId: 'thread_autorun_ai_terminal_worktree',
					name: 'Main',
					logs: [childLog],
					createdAt: now,
					state: options.childState ?? 'idle',
				},
			],
			activeTabId: childAiTabId,
			unifiedTabOrder: [{ type: 'ai', id: childAiTabId }],
			autoRunFolderPath: childAutoRunFolder,
			autoRunSelectedFile: 'Phase 1',
			autoRunContent: fs.readFileSync(path.join(childAutoRunFolder, 'Phase 1.md'), 'utf-8'),
		} as (typeof seeded.sessions)[number]);
	}

	return { ...seeded, worktreesDir, childBranch, childSessionId, childWorktreeDir };
}

function createUnconfiguredAutoRunLaneWorkbench() {
	const seeded = createLaneWorkbench();
	const session = seeded.sessions[0]! as Record<string, unknown>;

	delete session.autoRunFolderPath;
	delete session.autoRunSelectedFile;
	delete session.autoRunContent;
	session.autoRunContentVersion = 0;

	return seeded;
}

function createEmptyAutoRunFolderLaneWorkbench() {
	const seeded = createLaneWorkbench();
	const emptyAutoRunFolder = path.join(seeded.projectDir, 'Empty Auto Run Docs');
	const session = seeded.sessions[0]! as Record<string, unknown>;

	fs.rmSync(seeded.autoRunFolder, { recursive: true, force: true });
	fs.mkdirSync(emptyAutoRunFolder, { recursive: true });
	session.autoRunFolderPath = emptyAutoRunFolder;
	delete session.autoRunSelectedFile;
	session.autoRunContent = '';
	session.autoRunContentVersion = 1;

	return { ...seeded, emptyAutoRunFolder };
}

function createPersistedEditModeLaneWorkbench() {
	const seeded = createLaneWorkbench();
	const session = seeded.sessions[0]!;

	session.autoRunMode = 'edit';
	session.autoRunCursorPosition = seeded.phaseOneContent.indexOf('Codex auto-run lane sentinel.');
	session.autoRunEditScrollPos = 24;

	return seeded;
}

function createPersistedPhaseTwoLaneWorkbench() {
	const seeded = createLaneWorkbench();
	const session = seeded.sessions[0]!;

	session.autoRunSelectedFile = 'Phase 2';
	session.autoRunContent = fs.readFileSync(seeded.phaseTwoPath, 'utf-8');
	session.autoRunContentVersion = 2;

	return seeded;
}

function createNestedDocumentLaneWorkbench() {
	const seeded = createLaneWorkbench();
	const nestedFolder = path.join(seeded.autoRunFolder, 'Research', 'Deep');
	const nestedDocPath = path.join(nestedFolder, 'Nested.md');

	fs.mkdirSync(nestedFolder, { recursive: true });
	fs.writeFileSync(
		nestedDocPath,
		`# Nested Research

## Tasks

- [ ] Verify nested Auto Run selector coverage

Nested Codex Auto Run sentinel.
`,
		'utf-8'
	);

	return { ...seeded, nestedFolder, nestedDocPath };
}

function createTranscriptSurfaceLaneWorkbench() {
	const seeded = createLaneWorkbench();
	const session = seeded.sessions[0]!;
	const logs = session.aiLogs;
	const baseTimestamp = session.createdAt + 10;
	const errorTimestamp = baseTimestamp + 4;
	const extraLogs = [
		{
			id: `ai-log-autorun-ai-thinking-${baseTimestamp}`,
			timestamp: baseTimestamp,
			source: 'thinking' as const,
			text: 'Codex lane thinking transcript sentinel.',
		},
		{
			id: `ai-log-autorun-ai-tool-running-${baseTimestamp}`,
			timestamp: baseTimestamp + 1,
			source: 'tool' as const,
			text: 'shell',
			metadata: {
				toolState: {
					status: 'running' as const,
					input: {
						cmd: 'pnpm lint --filter autorun-ai-terminal',
					},
				},
			},
		},
		{
			id: `ai-log-autorun-ai-tool-completed-${baseTimestamp}`,
			timestamp: baseTimestamp + 2,
			source: 'tool' as const,
			text: 'read',
			metadata: {
				toolState: {
					status: 'completed' as const,
					input: {
						path: 'e2e/autorun-ai-terminal.spec.ts',
					},
				},
			},
		},
		{
			id: `ai-log-autorun-ai-tool-error-${baseTimestamp}`,
			timestamp: baseTimestamp + 3,
			source: 'tool' as const,
			text: 'apply_patch',
			metadata: {
				toolState: {
					status: 'error' as const,
					input: {
						description: 'Codex lane failed patch sentinel',
					},
				},
			},
		},
		{
			id: `ai-log-autorun-ai-error-${baseTimestamp}`,
			timestamp: errorTimestamp,
			source: 'error' as const,
			text: 'Codex lane historical error transcript sentinel.',
			agentError: {
				type: 'agent_crashed' as const,
				message: 'Codex lane historical error detail sentinel',
				recoverable: true,
				agentId: 'codex',
				sessionId: session.id,
				timestamp: errorTimestamp,
				raw: {
					exitCode: 1,
					stderr: 'synthetic Codex lane transcript stderr',
				},
				parsedJson: {
					code: 'codex_lane_historical_error',
					phase: 'transcript-surfaces',
				},
			},
		},
	];

	logs.push(...extraLogs);
	const activeTabLogs = session.aiTabs[0]?.logs;
	if (activeTabLogs && activeTabLogs !== logs) {
		activeTabLogs.push(...extraLogs);
	}

	return seeded;
}

function createActiveErrorLaneWorkbench(
	options: { message?: string; recoverable?: boolean; type?: LaneAgentError['type'] } = {}
) {
	const seeded = createLaneWorkbench();
	const session = seeded.sessions[0]! as (typeof seeded.sessions)[number] & {
		agentError?: LaneAgentError;
		agentErrorTabId?: string;
		agentErrorPaused?: boolean;
	};
	const activeTab = session.aiTabs[0]! as (typeof session.aiTabs)[number] & {
		agentError?: LaneAgentError;
	};
	const errorType =
		options.type ?? (options.recoverable === false ? 'permission_denied' : 'network_error');
	const agentError: LaneAgentError = {
		type: errorType,
		message: options.message || 'Codex lane recoverable network error sentinel',
		recoverable: options.recoverable ?? true,
		agentId: 'codex',
		sessionId: session.id,
		timestamp: Date.now(),
		raw: {
			exitCode: 7,
			stderr: 'synthetic Codex lane network stderr',
		},
		parsedJson: {
			code: 'codex_lane_active_error',
			retryable: options.recoverable ?? true,
		},
	};

	session.state = 'error';
	session.agentError = agentError;
	session.agentErrorTabId = activeTab.id;
	session.agentErrorPaused = true;
	activeTab.agentError = agentError;

	return seeded;
}

async function launchQueuedLaneWorkbench() {
	const seeded = createQueuedLaneWorkbench();
	const launched = await helpers.launchAppWithState({
		homeDir: seeded.homeDir,
		sessions: seeded.sessions,
	});

	return { ...seeded, ...launched };
}

async function launchMultiTabQueuedLaneWorkbench() {
	const seeded = createMultiTabQueuedLaneWorkbench();
	const launched = await helpers.launchAppWithState({
		homeDir: seeded.homeDir,
		sessions: seeded.sessions,
	});

	return { ...seeded, ...launched };
}

async function launchCrossSessionQueuedLaneWorkbench() {
	const seeded = createCrossSessionQueuedLaneWorkbench();
	const launched = await helpers.launchAppWithState({
		homeDir: seeded.homeDir,
		sessions: seeded.sessions,
	});

	return { ...seeded, ...launched };
}

async function launchPreviewLinkLaneWorkbench() {
	const seeded = createPreviewLinkLaneWorkbench();
	const launched = await helpers.launchAppWithState({
		homeDir: seeded.homeDir,
		sessions: seeded.sessions,
	});

	return { ...seeded, ...launched };
}

async function launchBatchConfigLaneWorkbench() {
	const seeded = createBatchConfigLaneWorkbench();
	const launched = await helpers.launchAppWithState({
		homeDir: seeded.homeDir,
		sessions: seeded.sessions,
	});

	return { ...seeded, ...launched };
}

async function launchWorktreeBatchLaneWorkbench(
	options: Parameters<typeof createWorktreeBatchLaneWorkbench>[0] = {}
) {
	const seeded = createWorktreeBatchLaneWorkbench(options);
	const launched = await helpers.launchAppWithState({
		homeDir: seeded.homeDir,
		sessions: seeded.sessions,
	});

	return { ...seeded, ...launched };
}

async function launchUnconfiguredAutoRunLaneWorkbench() {
	const seeded = createUnconfiguredAutoRunLaneWorkbench();
	const launched = await helpers.launchAppWithState({
		homeDir: seeded.homeDir,
		sessions: seeded.sessions,
	});

	return { ...seeded, ...launched };
}

async function launchEmptyAutoRunFolderLaneWorkbench() {
	const seeded = createEmptyAutoRunFolderLaneWorkbench();
	const launched = await helpers.launchAppWithState({
		homeDir: seeded.homeDir,
		sessions: seeded.sessions,
	});

	return { ...seeded, ...launched };
}

async function launchPersistedEditModeLaneWorkbench() {
	const seeded = createPersistedEditModeLaneWorkbench();
	const launched = await helpers.launchAppWithState({
		homeDir: seeded.homeDir,
		sessions: seeded.sessions,
	});

	return { ...seeded, ...launched };
}

async function launchPersistedPhaseTwoLaneWorkbench() {
	const seeded = createPersistedPhaseTwoLaneWorkbench();
	const launched = await helpers.launchAppWithState({
		homeDir: seeded.homeDir,
		sessions: seeded.sessions,
	});

	return { ...seeded, ...launched };
}

async function launchNestedDocumentLaneWorkbench() {
	const seeded = createNestedDocumentLaneWorkbench();
	const launched = await helpers.launchAppWithState({
		homeDir: seeded.homeDir,
		sessions: seeded.sessions,
	});

	return { ...seeded, ...launched };
}

async function launchTranscriptSurfaceLaneWorkbench() {
	const seeded = createTranscriptSurfaceLaneWorkbench();
	const launched = await helpers.launchAppWithState({
		homeDir: seeded.homeDir,
		sessions: seeded.sessions,
	});

	return { ...seeded, ...launched };
}

async function launchActiveErrorLaneWorkbench(
	options: Parameters<typeof createActiveErrorLaneWorkbench>[0] = {}
) {
	const seeded = createActiveErrorLaneWorkbench(options);
	const launched = await helpers.launchAppWithState({
		homeDir: seeded.homeDir,
		sessions: seeded.sessions,
	});

	return { ...seeded, ...launched };
}

async function openAutoRunPanel(page: Page) {
	await helpers.openRightPanelTab(page, 'Auto Run');
	await expect(page.locator('[data-tour="autorun-panel"]')).toBeVisible();
}

async function openAutoRunBatchConfig(page: Page) {
	await openAutoRunPanel(page);
	await helpers.getRunButton(page).first().click();

	const dialog = page.getByRole('dialog', { name: 'Auto Run Configuration' });
	await expect(dialog).toBeVisible();
	return dialog;
}

async function waitForSeededAutoRunDocumentList(page: Page) {
	const selector = page.locator('[data-tour="autorun-document-selector"]');
	await selector
		.getByRole('button', { name: /Phase 1\.md/ })
		.first()
		.click();
	await expect(page.getByRole('button', { name: /Phase 2\.md/ })).toBeVisible();
	await page.keyboard.press('Escape');
	return selector;
}

async function openCodexAiTerminal(page: Page) {
	await page
		.locator('[data-tour="session-list"]')
		.getByText('Auto Run Codex E2E', { exact: true })
		.first()
		.click();
	await page.getByText('Main', { exact: true }).click();
	await expect(page.getByText('Codex lane seeded response is visible.')).toBeVisible();
	const promptInput = page.getByPlaceholder(/Talking to Auto Run Codex E2E powered by Codex/);
	await expect(promptInput).toBeVisible();
	return promptInput;
}

async function openExecutionQueueBrowser(page: Page, queuedItemCount = 2) {
	await page.getByRole('button', { name: new RegExp(`${queuedItemCount} items queued`) }).click();
	const browser = page.locator('div.fixed.inset-0.z-50').filter({ hasText: 'Execution Queue' });
	await expect(browser.getByRole('heading', { name: 'Execution Queue' })).toBeVisible();
	return browser;
}

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
				'Codex lane stubbed spawn response sentinel\n'
			);
			setTimeout(() => {
				if (!event.sender.isDestroyed()) {
					event.sender.send('process:exit', config.sessionId, 0);
				}
			}, exitDelayMs ?? 0);
			return { pid: 41042, success: true };
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

async function stubWorktreeGit(
	electronApp: ElectronApplication,
	options: WorktreeGitStubOptions = {}
) {
	await electronApp.evaluate(({ ipcMain }, stubOptions: WorktreeGitStubOptions) => {
		const branches = stubOptions.branches ?? ['main', 'feat/autorun-review'];
		const currentBranch = stubOptions.currentBranch ?? branches[0] ?? 'main';
		const gitSubdirs = stubOptions.gitSubdirs ?? [];
		const state = globalThis as typeof globalThis & {
			__maestroE2eWorktreeSetupCalls?: WorktreeSetupCall[];
		};
		state.__maestroE2eWorktreeSetupCalls = [];

		ipcMain.removeHandler('git:branches');
		ipcMain.handle('git:branches', async () => {
			if (stubOptions.branchesError) {
				throw new Error('Synthetic branch load failure');
			}

			return { branches, stdout: '', stderr: '' };
		});
		ipcMain.removeHandler('git:branch');
		ipcMain.handle('git:branch', async () => ({ stdout: currentBranch, stderr: '' }));
		ipcMain.removeHandler('git:status');
		ipcMain.handle('git:status', async () => ({ stdout: '', stderr: '' }));
		ipcMain.removeHandler('git:scanWorktreeDirectory');
		ipcMain.handle('git:scanWorktreeDirectory', async () => ({ gitSubdirs }));
		ipcMain.removeHandler('git:worktreeSetup');
		ipcMain.handle(
			'git:worktreeSetup',
			async (
				_event,
				mainRepoCwd: string,
				worktreePath: string,
				branchName: string,
				sshRemoteId?: string
			) => {
				state.__maestroE2eWorktreeSetupCalls?.push({
					mainRepoCwd,
					worktreePath,
					branchName,
					sshRemoteId,
				});
				if (stubOptions.worktreeSetup?.delayMs) {
					await new Promise((resolve) => setTimeout(resolve, stubOptions.worktreeSetup?.delayMs));
				}
				if (stubOptions.worktreeSetup?.success === false) {
					return {
						success: false,
						error: stubOptions.worktreeSetup.error ?? 'Synthetic worktree setup failure',
					};
				}

				return {
					success: true,
					created: true,
					currentBranch: branchName,
					requestedBranch: branchName,
					branchMismatch: false,
				};
			}
		);
	}, options);
}

async function getStubbedWorktreeSetupCalls(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eWorktreeSetupCalls?: WorktreeSetupCall[];
		};
		return state.__maestroE2eWorktreeSetupCalls || [];
	});
}

async function stubProcessInterrupt(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eProcessInterruptCalls?: string[];
		};
		state.__maestroE2eProcessInterruptCalls = [];

		ipcMain.removeHandler('process:interrupt');
		ipcMain.handle('process:interrupt', async (_event, sessionId: string) => {
			state.__maestroE2eProcessInterruptCalls?.push(sessionId);
			return true;
		});
	});
}

async function getStubbedProcessInterruptCalls(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eProcessInterruptCalls?: string[];
		};
		return state.__maestroE2eProcessInterruptCalls || [];
	});
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

test.describe('Auto Run and Codex AI Terminal', () => {
	test('renders a seeded Codex Auto Run document with task progress', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);

			await expect(
				launched.window.getByRole('heading', { name: 'Phase 1: Lane Setup' })
			).toBeVisible();
			await expect(launched.window.getByText('Codex auto-run lane sentinel.')).toBeVisible();
			await expect(launched.window.getByText('1 of 3 tasks completed').first()).toBeVisible();
			await expect(helpers.getRunButton(launched.window).first()).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('saves Auto Run edits for the selected Codex document', async () => {
		const launched = await launchLaneWorkbench();
		const editedContent = `${launched.phaseOneContent}
## Saved Edit

- [ ] Saved from deterministic lane test
`;

		try {
			await openAutoRunPanel(launched.window);
			await launched.window.getByTitle('Edit document').click();
			const editor = launched.window.getByPlaceholder(/Capture notes/);
			await expect(editor).toBeEditable();

			await editor.fill(editedContent);
			await launched.window.getByTitle(/Save changes/).click();

			await expect
				.poll(() => fs.readFileSync(launched.phaseOnePath, 'utf-8'))
				.toContain('Saved from deterministic lane test');
			await launched.window.getByTitle('Preview document').click();
			await expect(launched.window.getByText('Saved from deterministic lane test')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('opens the Auto Run batch configuration without starting a live provider', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);
			await helpers.getRunButton(launched.window).first().click();

			const dialog = launched.window.getByRole('dialog', { name: 'Auto Run Configuration' });
			await expect(dialog).toBeVisible();
			await expect(dialog.getByText('Phase 1.md')).toBeVisible();
			await expect(dialog.getByText('Agent Prompt')).toBeVisible();
			await expect(dialog.getByRole('button', { name: 'Go' })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('shows Auto Run setup guidance when the Codex lane has no folder configured', async () => {
		const launched = await launchUnconfiguredAutoRunLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);

			await expect(launched.window.getByText('Markdown Documents')).toBeVisible();
			await expect(launched.window.getByText('Checkbox Tasks')).toBeVisible();
			await expect(launched.window.getByText('Batch Execution')).toBeVisible();
			await expect(
				launched.window.getByRole('button', { name: 'Select Auto Run Folder' })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('shows the empty Auto Run folder state for the Codex lane agent', async () => {
		const launched = await launchEmptyAutoRunFolderLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);

			await expect(launched.window.getByText('No Documents Found')).toBeVisible();
			await expect(
				launched.window.getByText("The selected folder doesn't contain any markdown (.md) files.")
			).toBeVisible();
			await expect(launched.window.getByRole('button', { name: 'Refresh' })).toBeVisible();
			await expect(launched.window.getByRole('button', { name: 'Change Folder' })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('refreshes an empty Auto Run folder after a Codex lane document appears', async () => {
		const launched = await launchEmptyAutoRunFolderLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);
			await expect(launched.window.getByText('No Documents Found')).toBeVisible();

			fs.writeFileSync(
				path.join(launched.emptyAutoRunFolder, 'Recovered.md'),
				`# Recovered

## Tasks

- [ ] Refresh the empty Auto Run document list

Recovered refresh sentinel.
`,
				'utf-8'
			);

			await launched.window.getByRole('button', { name: 'Refresh' }).click();

			const selector = launched.window.locator('[data-tour="autorun-document-selector"]');
			await selector.getByRole('button', { name: /Select a document/ }).click();
			await expect(selector.getByRole('button', { name: /Recovered\.md/ }).first()).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('restores persisted Auto Run edit mode for the Codex lane document', async () => {
		const launched = await launchPersistedEditModeLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);

			const editor = launched.window.getByPlaceholder(/Capture notes/);
			await expect(editor).toBeVisible();
			await expect(editor).toHaveValue(/Codex auto-run lane sentinel/);
			await expect(launched.window.getByTitle('Edit document')).toHaveAttribute(
				'aria-pressed',
				'true'
			);

			await launched.window.getByTitle('Preview document').click();
			await expect(launched.window.getByText('Codex auto-run lane sentinel.')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('restores the persisted Phase 2 Auto Run selection for the Codex lane agent', async () => {
		const launched = await launchPersistedPhaseTwoLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);

			await expect(launched.window.getByText('Codex second document sentinel.')).toBeVisible();
			await expect(
				launched.window
					.locator('[data-tour="autorun-document-selector"]')
					.getByRole('button', { name: /Phase 2\.md/ })
					.first()
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('disables Go when Codex lane batch document selection is empty', async () => {
		const launched = await launchBatchConfigLaneWorkbench();
		try {
			const dialog = await openAutoRunBatchConfig(launched.window);

			await dialog.getByRole('button', { name: 'Add Docs' }).click();
			const selector = launched.window
				.getByText('Select Documents')
				.locator('xpath=ancestor::div[contains(@class, "shadow-2xl")][1]');
			await expect(selector.getByText('Reference.md')).toBeVisible();
			await selector.getByRole('button', { name: 'Select All' }).click();
			await selector.getByRole('button', { name: 'Deselect All' }).click();
			await selector.getByRole('button', { name: /Add 0 files/ }).click();

			await expect(dialog.getByText('No documents selected')).toBeVisible();
			await expect(dialog.getByRole('button', { name: 'Go' })).toBeDisabled();
			await expect(dialog.getByRole('button', { name: 'Go' })).toHaveAttribute(
				'title',
				'No documents selected'
			);
		} finally {
			await launched.cleanup();
		}
	});

	test('disables Go for a Codex lane batch document with no unchecked tasks', async () => {
		const launched = await launchBatchConfigLaneWorkbench();
		try {
			const dialog = await openAutoRunBatchConfig(launched.window);

			await dialog.getByRole('button', { name: 'Add Docs' }).click();
			const selector = launched.window
				.getByText('Select Documents')
				.locator('xpath=ancestor::div[contains(@class, "shadow-2xl")][1]');
			await expect(selector.getByText('Reference.md')).toBeVisible();
			await selector.getByRole('button', { name: 'Select All' }).click();
			await selector.getByRole('button', { name: /Phase 1\.md/ }).click();
			await selector.getByRole('button', { name: /Phase 2\.md/ }).click();
			await selector.getByRole('button', { name: /Add 1 file/ }).click();

			await expect(dialog.getByText('Reference.md')).toBeVisible();
			await expect(dialog.getByText('0 tasks').first()).toBeVisible();
			await expect(dialog.getByRole('button', { name: 'Go' })).toBeDisabled();
			await expect(dialog.getByRole('button', { name: 'Go' })).toHaveAttribute(
				'title',
				'No unchecked tasks in documents'
			);
		} finally {
			await launched.cleanup();
		}
	});

	test('enables Codex lane batch loop max controls for multiple documents', async () => {
		const launched = await launchBatchConfigLaneWorkbench();
		try {
			const dialog = await openAutoRunBatchConfig(launched.window);

			await dialog.getByRole('button', { name: 'Add Docs' }).click();
			const selector = launched.window
				.getByText('Select Documents')
				.locator('xpath=ancestor::div[contains(@class, "shadow-2xl")][1]');
			await expect(selector.getByText('Reference.md')).toBeVisible();
			await selector.getByRole('button', { name: 'Select All' }).click();
			await selector.getByRole('button', { name: /Add 3 files/ }).click();

			await expect(dialog.getByText('Phase 2.md')).toBeVisible();
			await expect(dialog.getByText('Reference.md')).toBeVisible();
			await dialog.getByTitle('Loop back to first document when finished').click();
			await expect(dialog.getByTitle('Loop forever until all tasks complete')).toBeVisible();

			await dialog.getByTitle('Set maximum loop iterations').click();
			await expect(dialog.locator('input[type="range"]')).toHaveValue('5');
		} finally {
			await launched.cleanup();
		}
	});

	test('duplicates a reset-enabled Codex lane batch document without starting Auto Run', async () => {
		const launched = await launchBatchConfigLaneWorkbench();
		try {
			const dialog = await openAutoRunBatchConfig(launched.window);

			await dialog.getByTitle(/Enable reset/).click();
			await expect(dialog.getByTitle('Duplicate document')).toBeVisible();
			await dialog.getByTitle('Duplicate document').click();

			await expect(dialog.locator('[title="Phase 1.md"]')).toHaveCount(2);
			await expect(dialog.getByTitle(/Remove duplicates to disable/).first()).toBeVisible();
			await expect(dialog.getByRole('button', { name: 'Go' })).toBeEnabled();
		} finally {
			await launched.cleanup();
		}
	});

	test('validates and recovers Codex lane batch prompt edits before Go', async () => {
		const launched = await launchBatchConfigLaneWorkbench();
		try {
			const dialog = await openAutoRunBatchConfig(launched.window);
			const promptInput = dialog.getByPlaceholder('Enter the system prompt for auto-run...');
			const goButton = dialog.getByRole('button', { name: 'Go' });

			await promptInput.fill('');
			await expect(dialog.getByText('Agent prompt cannot be empty.')).toBeVisible();
			await expect(goButton).toBeDisabled();

			await promptInput.fill('Run the Codex lane batch quickly.');
			await expect(dialog.getByText(/Agent prompt must reference Markdown tasks/)).toBeVisible();
			await expect(goButton).toBeDisabled();

			await promptInput.fill(
				'Process each Markdown task with unchecked checkbox syntax - [ ] for this Codex lane.'
			);
			await expect(dialog.getByText(/Agent prompt must reference Markdown tasks/)).toBeHidden();
			await expect(goButton).toBeEnabled();
		} finally {
			await launched.cleanup();
		}
	});

	test('shows Save as Playbook after adding Codex lane batch documents', async () => {
		const launched = await launchBatchConfigLaneWorkbench();
		try {
			const dialog = await openAutoRunBatchConfig(launched.window);

			await dialog.getByRole('button', { name: 'Add Docs' }).click();
			const selector = launched.window
				.getByText('Select Documents')
				.locator('xpath=ancestor::div[contains(@class, "shadow-2xl")][1]');
			await expect(selector.getByText('Reference.md')).toBeVisible();
			await selector.getByRole('button', { name: 'Select All' }).click();
			await selector.getByRole('button', { name: /Add 3 files/ }).click();

			await expect(dialog.getByRole('button', { name: 'Save as Playbook' })).toBeVisible();
			await expect(dialog.getByText('Phase 2.md')).toBeVisible();
			await expect(dialog.getByText('Reference.md')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('confirms before closing dirty Codex lane batch configuration', async () => {
		const launched = await launchBatchConfigLaneWorkbench();
		try {
			const dialog = await openAutoRunBatchConfig(launched.window);
			const promptInput = dialog.getByPlaceholder('Enter the system prompt for auto-run...');

			await promptInput.fill(
				'Process each Markdown task with unchecked checkbox syntax - [ ] for Codex dirty close sentinel.'
			);
			await dialog.getByRole('button', { name: 'Cancel' }).click();

			const confirmDialog = launched.window.getByRole('dialog', { name: 'Confirm' });
			await expect(
				confirmDialog.getByText(
					'You have unsaved changes to your Auto Run configuration. Close without saving?'
				)
			).toBeVisible();
			await confirmDialog.getByRole('button', { name: 'Cancel' }).click();

			await expect(dialog).toBeVisible();
			await expect(promptInput).toHaveValue(/Codex dirty close sentinel/);
		} finally {
			await launched.cleanup();
		}
	});

	test('adds a nested Codex Auto Run folder to the batch queue', async () => {
		const launched = await launchNestedDocumentLaneWorkbench();
		try {
			const dialog = await openAutoRunBatchConfig(launched.window);

			await dialog.getByRole('button', { name: 'Add Docs' }).click();
			const selector = launched.window
				.getByText('Select Documents')
				.locator('xpath=ancestor::div[contains(@class, "shadow-2xl")][1]');
			await expect(selector.getByText('Research')).toBeVisible();
			await selector.getByRole('button', { name: /Research/ }).click();
			await selector.getByRole('button', { name: /Add 2 files/ }).click();

			await expect(dialog.locator('[title="Research/Deep/Nested.md"]')).toBeVisible();
			await expect(dialog.getByRole('button', { name: 'Go' })).toBeEnabled();
		} finally {
			await launched.cleanup();
		}
	});

	test('blocks duplicate nested Codex Auto Run document creation in the selected folder', async () => {
		const launched = await launchNestedDocumentLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);
			await waitForSeededAutoRunDocumentList(launched.window);
			await launched.window.getByTitle('Create new document').click();

			const dialog = launched.window.getByRole('dialog', { name: 'Create New Document' });
			await dialog.locator('select').selectOption('Research/Deep');
			await dialog.getByPlaceholder('my-tasks').fill('Nested.md');

			await expect(
				dialog.getByText('A document with this name already exists in Research/Deep')
			).toBeVisible();
			await expect(dialog.getByRole('button', { name: 'Create' })).toBeDisabled();
		} finally {
			await launched.cleanup();
		}
	});

	test('allows a root Codex Auto Run document name that only duplicates a nested file', async () => {
		const launched = await launchNestedDocumentLaneWorkbench();
		const rootNestedPath = path.join(launched.autoRunFolder, 'Nested.md');
		try {
			await openAutoRunPanel(launched.window);
			await waitForSeededAutoRunDocumentList(launched.window);
			await launched.window.getByTitle('Create new document').click();

			const dialog = launched.window.getByRole('dialog', { name: 'Create New Document' });
			await dialog.locator('select').selectOption('');
			await dialog.getByPlaceholder('my-tasks').fill('Nested');
			await expect(
				dialog.getByText('The .md extension will be added automatically if not provided.')
			).toBeVisible();
			await dialog.getByRole('button', { name: 'Create' }).click();

			await expect(dialog).toBeHidden();
			await expect.poll(() => fs.existsSync(rootNestedPath)).toBe(true);
			await expect(
				launched.window
					.locator('[data-tour="autorun-document-selector"]')
					.getByRole('button', { name: /Nested\.md/ })
					.first()
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('shows disabled Codex batch worktree controls before configuration', async () => {
		const launched = await launchWorktreeBatchLaneWorkbench({ configured: false });
		try {
			const dialog = await openAutoRunBatchConfig(launched.window);

			await expect(dialog.getByText('Run in Worktree')).toBeVisible();
			await expect(dialog.getByRole('button', { name: /Configure/ })).toBeVisible();
			await expect(
				dialog.getByRole('button', { name: /Dispatch to a separate worktree/ })
			).toBeDisabled();
		} finally {
			await launched.cleanup();
		}
	});

	test('enables create-new Codex batch worktree targeting from configuration', async () => {
		const launched = await launchWorktreeBatchLaneWorkbench();
		try {
			await stubWorktreeGit(launched.electronApp, {
				branches: ['main', 'release/autorun'],
				currentBranch: 'main',
				gitSubdirs: [],
			});
			const dialog = await openAutoRunBatchConfig(launched.window);

			await dialog.getByRole('button', { name: /Dispatch to a separate worktree/ }).click();
			const targetSelect = dialog.locator('select').first();

			await expect(dialog.getByText('Enabled')).toBeVisible();
			await expect(targetSelect).toHaveValue('__create_new__');
			await expect(dialog.getByText('No worktrees found')).toBeVisible();
			await expect(dialog.getByLabel('Base Branch')).toHaveValue('main');
			await expect(dialog.getByLabel('Worktree Branch Name')).toHaveValue(/auto-run-main-\d{4}/);
		} finally {
			await launched.cleanup();
		}
	});

	test('switches Codex batch worktree targeting to an open ready worktree agent', async () => {
		const launched = await launchWorktreeBatchLaneWorkbench({ withChild: true });
		try {
			await stubWorktreeGit(launched.electronApp);
			const dialog = await openAutoRunBatchConfig(launched.window);

			await dialog.getByRole('button', { name: /Dispatch to a separate worktree/ }).click();
			const targetSelect = dialog.locator('select').first();
			await targetSelect.selectOption(launched.childSessionId);

			await expect(dialog.getByTestId('agent-state-indicator')).toContainText(launched.childBranch);
			await expect(dialog.getByTestId('agent-state-indicator')).toContainText('ready');
			await expect(targetSelect).toHaveValue(launched.childSessionId);
		} finally {
			await launched.cleanup();
		}
	});

	test('marks busy Codex worktree agents as disabled batch targets', async () => {
		const launched = await launchWorktreeBatchLaneWorkbench({
			withChild: true,
			childState: 'busy',
		});
		try {
			await stubWorktreeGit(launched.electronApp);
			const dialog = await openAutoRunBatchConfig(launched.window);

			await dialog.getByRole('button', { name: /Dispatch to a separate worktree/ }).click();
			const busyOption = dialog.locator('select').first().locator('option', { hasText: /busy/ });

			await expect(busyOption).toContainText('busy');
			await expect(busyOption).toBeDisabled();
		} finally {
			await launched.cleanup();
		}
	});

	test('selects a scanned closed Codex worktree target from batch configuration', async () => {
		const launched = await launchWorktreeBatchLaneWorkbench();
		const closedWorktreePath = path.join(launched.worktreesDir, 'feat-closed-autorun');
		try {
			await stubWorktreeGit(launched.electronApp, {
				gitSubdirs: [
					{
						path: closedWorktreePath,
						name: 'feat-closed-autorun',
						branch: 'feat/closed-autorun',
					},
				],
			});
			const dialog = await openAutoRunBatchConfig(launched.window);

			await dialog.getByRole('button', { name: /Dispatch to a separate worktree/ }).click();
			const targetSelect = dialog.locator('select').first();
			await expect(
				targetSelect.locator('option', { hasText: 'feat/closed-autorun' })
			).toBeVisible();
			await targetSelect.selectOption(`__closed__:${closedWorktreePath}`);

			await expect(targetSelect).toHaveValue(`__closed__:${closedWorktreePath}`);
			const prCheckbox = dialog.getByRole('checkbox');
			await expect(prCheckbox).toHaveAttribute('aria-checked', 'false');
			await prCheckbox.press('Space');
			await expect(prCheckbox).toHaveAttribute('aria-checked', 'true');
		} finally {
			await launched.cleanup();
		}
	});

	test('updates Codex batch worktree branch defaults from base branch changes', async () => {
		const launched = await launchWorktreeBatchLaneWorkbench();
		try {
			await stubWorktreeGit(launched.electronApp, {
				branches: ['main', 'release'],
				currentBranch: 'main',
				gitSubdirs: [],
			});
			const dialog = await openAutoRunBatchConfig(launched.window);

			await dialog.getByRole('button', { name: /Dispatch to a separate worktree/ }).click();
			await dialog.getByLabel('Base Branch').selectOption('release');

			await expect(dialog.getByLabel('Worktree Branch Name')).toHaveValue(/auto-run-release-\d{4}/);
			await expect(
				dialog.locator('span[title]').filter({ hasText: /auto-run-release-\d{4}/ })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('warns when Codex batch create-new worktree branch name is empty', async () => {
		const launched = await launchWorktreeBatchLaneWorkbench();
		try {
			await stubWorktreeGit(launched.electronApp);
			const dialog = await openAutoRunBatchConfig(launched.window);

			await dialog.getByRole('button', { name: /Dispatch to a separate worktree/ }).click();
			await dialog.getByLabel('Worktree Branch Name').fill('');

			await expect(dialog.getByText('Branch name is required')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('clears Codex batch worktree targeting when the toggle is turned off', async () => {
		const launched = await launchWorktreeBatchLaneWorkbench();
		try {
			await stubWorktreeGit(launched.electronApp);
			const dialog = await openAutoRunBatchConfig(launched.window);
			const toggle = dialog.getByRole('button', { name: /Dispatch to a separate worktree/ });

			await toggle.click();
			await expect(dialog.getByText('Enabled')).toBeVisible();

			await toggle.click();
			await expect(dialog.getByText('Off')).toBeVisible();
			await expect(dialog.getByLabel('Base Branch')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test('filters already-open Codex worktrees from scanned closed batch targets', async () => {
		const launched = await launchWorktreeBatchLaneWorkbench({ withChild: true });
		const otherClosedPath = path.join(launched.worktreesDir, 'feat-other-autorun');
		try {
			await stubWorktreeGit(launched.electronApp, {
				gitSubdirs: [
					{
						path: launched.childWorktreeDir,
						name: 'feat-autorun-review',
						branch: launched.childBranch,
					},
					{
						path: otherClosedPath,
						name: 'feat-other-autorun',
						branch: 'feat/other-autorun',
					},
				],
			});
			const dialog = await openAutoRunBatchConfig(launched.window);

			await dialog.getByRole('button', { name: /Dispatch to a separate worktree/ }).click();
			const targetSelect = dialog.locator('select').first();

			await expect(targetSelect.locator('option', { hasText: launched.childBranch })).toHaveCount(
				1
			);
			await expect(targetSelect.locator('option', { hasText: 'feat/other-autorun' })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('shows Codex batch worktree branch load errors in create-new targeting', async () => {
		const launched = await launchWorktreeBatchLaneWorkbench();
		try {
			await stubWorktreeGit(launched.electronApp, { branchesError: true });
			const dialog = await openAutoRunBatchConfig(launched.window);

			await dialog.getByRole('button', { name: /Dispatch to a separate worktree/ }).click();

			await expect(dialog.getByText('Could not load branches')).toBeVisible();
			await expect(dialog.getByLabel('Base Branch')).toBeDisabled();
		} finally {
			await launched.cleanup();
		}
	});

	test('shows preparing state while Codex create-new batch worktree setup is pending', async () => {
		const launched = await launchWorktreeBatchLaneWorkbench();
		try {
			await stubWorktreeGit(launched.electronApp, {
				branches: ['main'],
				currentBranch: 'main',
				gitSubdirs: [],
				worktreeSetup: { delayMs: 5_000 },
			});
			await stubCodexProcessSpawn(launched.electronApp, { exitDelayMs: 10_000 });
			const dialog = await openAutoRunBatchConfig(launched.window);

			await dialog.getByRole('button', { name: /Dispatch to a separate worktree/ }).click();
			await dialog.getByLabel('Worktree Branch Name').fill('auto-run-preparing');
			await dialog.getByRole('button', { name: 'Go' }).click();

			await expect(dialog.getByRole('button', { name: 'Preparing Worktree...' })).toBeDisabled();
		} finally {
			await launched.cleanup();
		}
	});

	test('dispatches create-new Codex batch worktree setup before spawning Auto Run', async () => {
		const launched = await launchWorktreeBatchLaneWorkbench();
		try {
			await stubWorktreeGit(launched.electronApp, {
				branches: ['main'],
				currentBranch: 'main',
				gitSubdirs: [],
			});
			await stubCodexProcessSpawn(launched.electronApp, { exitDelayMs: 10_000 });
			const dialog = await openAutoRunBatchConfig(launched.window);

			await dialog.getByRole('button', { name: /Dispatch to a separate worktree/ }).click();
			await dialog.getByLabel('Worktree Branch Name').fill('auto-run-payload');
			await dialog.getByRole('button', { name: 'Go' }).click();

			await expect
				.poll(async () => (await getStubbedWorktreeSetupCalls(launched.electronApp)).length)
				.toBe(1);
			const setupCalls = await getStubbedWorktreeSetupCalls(launched.electronApp);
			expect(setupCalls[0]).toMatchObject({
				mainRepoCwd: launched.projectDir,
				worktreePath: path.join(launched.worktreesDir, 'auto-run-payload'),
				branchName: 'auto-run-payload',
			});
			await expect
				.poll(async () => (await getStubbedCodexProcessSpawnCalls(launched.electronApp)).length)
				.toBe(1);
		} finally {
			await launched.cleanup();
		}
	});

	test('dispatches existing-open Codex batch worktree runs to the child agent cwd', async () => {
		const launched = await launchWorktreeBatchLaneWorkbench({ withChild: true });
		try {
			await stubWorktreeGit(launched.electronApp);
			await stubCodexProcessSpawn(launched.electronApp, { exitDelayMs: 10_000 });
			const dialog = await openAutoRunBatchConfig(launched.window);

			await dialog.getByRole('button', { name: /Dispatch to a separate worktree/ }).click();
			await dialog.locator('select').first().selectOption(launched.childSessionId);
			await dialog.getByRole('button', { name: 'Go' }).click();

			await expect
				.poll(async () => (await getStubbedCodexProcessSpawnCalls(launched.electronApp)).length)
				.toBe(1);
			const calls = await getStubbedCodexProcessSpawnCalls(launched.electronApp);
			expect(calls[0]!.sessionId.startsWith(`${launched.childSessionId}-batch-`)).toBe(true);
			expect(calls[0]!.cwd).toBe(launched.childWorktreeDir);
			expect(await getStubbedWorktreeSetupCalls(launched.electronApp)).toHaveLength(0);
		} finally {
			await launched.cleanup();
		}
	});

	test('dispatches existing-closed Codex batch worktree runs from the scanned cwd', async () => {
		const launched = await launchWorktreeBatchLaneWorkbench();
		const closedWorktreePath = path.join(launched.worktreesDir, 'feat-closed-run');
		try {
			await stubWorktreeGit(launched.electronApp, {
				gitSubdirs: [
					{
						path: closedWorktreePath,
						name: 'feat-closed-run',
						branch: 'feat/closed-run',
					},
				],
			});
			await stubCodexProcessSpawn(launched.electronApp, { exitDelayMs: 10_000 });
			const dialog = await openAutoRunBatchConfig(launched.window);

			await dialog.getByRole('button', { name: /Dispatch to a separate worktree/ }).click();
			await dialog.locator('select').first().selectOption(`__closed__:${closedWorktreePath}`);
			await dialog.getByRole('button', { name: 'Go' }).click();

			await expect
				.poll(async () => (await getStubbedCodexProcessSpawnCalls(launched.electronApp)).length)
				.toBe(1);
			const calls = await getStubbedCodexProcessSpawnCalls(launched.electronApp);
			expect(calls[0]!.cwd).toBe(closedWorktreePath);
			expect(await getStubbedWorktreeSetupCalls(launched.electronApp)).toHaveLength(0);
		} finally {
			await launched.cleanup();
		}
	});

	test('blocks Codex create-new batch worktree setup failures before provider spawn', async () => {
		const launched = await launchWorktreeBatchLaneWorkbench();
		try {
			await stubWorktreeGit(launched.electronApp, {
				worktreeSetup: {
					success: false,
					error: 'Synthetic worktree setup rejected',
				},
			});
			await stubCodexProcessSpawn(launched.electronApp);
			const dialog = await openAutoRunBatchConfig(launched.window);

			await dialog.getByRole('button', { name: /Dispatch to a separate worktree/ }).click();
			await dialog.getByLabel('Worktree Branch Name').fill('auto-run-rejected');
			await dialog.getByRole('button', { name: 'Go' }).click();

			await expect
				.poll(async () => (await getStubbedWorktreeSetupCalls(launched.electronApp)).length)
				.toBe(1);
			expect(await getStubbedCodexProcessSpawnCalls(launched.electronApp)).toHaveLength(0);
			await expect(launched.window.getByText('Failed to Create Worktree')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('renders seeded Codex AI terminal transcript controls', async () => {
		const launched = await launchLaneWorkbench();
		try {
			const promptInput = await openCodexAiTerminal(launched.window);

			await expect(launched.window.getByText('AI Terminal')).toBeVisible();
			await expect(promptInput).toHaveAttribute(
				'placeholder',
				'Talking to Auto Run Codex E2E powered by Codex'
			);
			await expect(launched.window.getByTitle(/Open Prompt Composer/)).toBeVisible();
			await expect(launched.window.getByTitle('Attach Image')).toBeVisible();
			await expect(
				launched.window.getByTitle("Toggle Read-Only mode (agent won't modify files)")
			).toBeVisible();
			await expect(launched.window.getByTitle('Send message')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('dispatches a Codex AI terminal prompt through the stubbed process path', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await stubCodexProcessSpawn(launched.electronApp);
			const promptInput = await openCodexAiTerminal(launched.window);

			await promptInput.fill('Codex Auto Run terminal prompt sentinel');
			await launched.window.getByTitle('Send message').click();

			await expect(
				launched.window.getByText('Codex Auto Run terminal prompt sentinel')
			).toBeVisible();
			await expect
				.poll(async () => (await getStubbedCodexProcessSpawnCalls(launched.electronApp)).length)
				.toBe(1);
			const calls = await getStubbedCodexProcessSpawnCalls(launched.electronApp);
			expect(calls).toHaveLength(1);
			expect(calls[0].toolType).toBe('codex');
			expect(calls[0].prompt).toContain('Codex Auto Run terminal prompt sentinel');
			await expect(
				launched.window.getByText('Codex lane stubbed spawn response sentinel')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('prevents duplicate Auto Run document creation in a Codex lane agent', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);
			await waitForSeededAutoRunDocumentList(launched.window);
			await launched.window.getByTitle('Create new document').click();

			const dialog = launched.window.getByRole('dialog', { name: 'Create New Document' });
			await expect(dialog).toBeVisible();
			await dialog.getByLabel('Document Name').fill('Phase 1');

			await expect(dialog.getByText('A document with this name already exists')).toBeVisible();
			await expect(dialog.getByRole('button', { name: 'Create' })).toBeDisabled();
		} finally {
			await launched.cleanup();
		}
	});

	test('creates a file-backed Auto Run document for the Codex lane agent', async () => {
		const launched = await launchLaneWorkbench();
		const phaseThreePath = path.join(launched.autoRunFolder, 'Phase 3.md');
		try {
			await openAutoRunPanel(launched.window);
			await waitForSeededAutoRunDocumentList(launched.window);
			await launched.window.getByTitle('Create new document').click();

			const dialog = launched.window.getByRole('dialog', { name: 'Create New Document' });
			await dialog.getByLabel('Document Name').fill('Phase 3');
			await dialog.getByRole('button', { name: 'Create' }).click();

			await expect(dialog).toBeHidden();
			await expect.poll(() => fs.existsSync(phaseThreePath)).toBe(true);
			await expect(launched.window.getByText('Phase 3.md')).toBeVisible();
			await expect(launched.window.getByPlaceholder(/Capture notes/)).toBeEditable();
		} finally {
			await launched.cleanup();
		}
	});

	test('refreshes externally added Auto Run documents for the Codex lane agent', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);
			const selector = await waitForSeededAutoRunDocumentList(launched.window);

			fs.writeFileSync(
				path.join(launched.autoRunFolder, 'Phase 3.md'),
				`# Phase 3: External Refresh

## Tasks

- [ ] Verify refreshed Codex lane document

Externally refreshed Codex Auto Run sentinel.
`,
				'utf-8'
			);
			await launched.window.getByTitle('Refresh document list').click();

			await expect(launched.window.getByText('Found 1 new document')).toBeVisible();
			await selector
				.getByRole('button', { name: /Phase 1\.md/ })
				.first()
				.click();
			await launched.window.getByRole('button', { name: /Phase 3\.md/ }).click();
			await expect(
				launched.window.getByRole('heading', { name: 'Phase 3: External Refresh' })
			).toBeVisible();
			await expect(
				launched.window.getByText('Externally refreshed Codex Auto Run sentinel.')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('shows task completion percentages in the Codex lane document selector', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);
			const selector = await waitForSeededAutoRunDocumentList(launched.window);

			await selector
				.getByRole('button', { name: /Phase 1\.md/ })
				.first()
				.click();

			await expect(selector.getByText('33%').first()).toBeVisible();
			await expect(selector.getByRole('button', { name: /Phase 2\.md/ })).toBeVisible();
			await expect(selector.getByText('0%').first()).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('opens configured Auto Run folder setup from the Codex lane selector dropdown', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);
			const selector = await waitForSeededAutoRunDocumentList(launched.window);
			await selector
				.getByRole('button', { name: /Phase 1\.md/ })
				.first()
				.click();

			await launched.window.getByRole('button', { name: 'Change Folder...' }).click();

			const dialog = launched.window.getByRole('dialog', { name: 'Change Auto Run Folder' });
			await expect(dialog).toBeVisible();
			await expect(dialog.getByLabel('Auto Run Folder')).toHaveValue(launched.autoRunFolder);
		} finally {
			await launched.cleanup();
		}
	});

	test('creates a Codex lane Auto Run document without duplicating the md extension', async () => {
		const launched = await launchLaneWorkbench();
		const phaseFourPath = path.join(launched.autoRunFolder, 'Phase 4.md');
		try {
			await openAutoRunPanel(launched.window);
			await waitForSeededAutoRunDocumentList(launched.window);
			await launched.window.getByTitle('Create new document').click();

			const dialog = launched.window.getByRole('dialog', { name: 'Create New Document' });
			await dialog.getByLabel('Document Name').fill('Phase 4.md');
			await dialog.getByRole('button', { name: 'Create' }).click();

			await expect(dialog).toBeHidden();
			await expect.poll(() => fs.existsSync(phaseFourPath)).toBe(true);
			expect(fs.existsSync(path.join(launched.autoRunFolder, 'Phase 4.md.md'))).toBe(false);
			await expect(launched.window.getByText('Phase 4.md')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('creates a Codex lane Auto Run document inside a nested folder', async () => {
		const launched = await launchNestedDocumentLaneWorkbench();
		const nestedDraftPath = path.join(launched.nestedFolder, 'Deep Draft.md');
		try {
			await openAutoRunPanel(launched.window);
			await waitForSeededAutoRunDocumentList(launched.window);
			await launched.window.getByTitle('Create new document').click();

			const dialog = launched.window.getByRole('dialog', { name: 'Create New Document' });
			await dialog.locator('select').selectOption('Research/Deep');
			await dialog.getByLabel('Document Name').fill('Deep Draft');
			await expect(dialog.getByText('Will create: Research/Deep/Deep Draft.md')).toBeVisible();
			await dialog.getByRole('button', { name: 'Create' }).click();

			await expect(dialog).toBeHidden();
			await expect.poll(() => fs.existsSync(nestedDraftPath)).toBe(true);
		} finally {
			await launched.cleanup();
		}
	});

	test('selects a nested Auto Run document from the Codex lane selector tree', async () => {
		const launched = await launchNestedDocumentLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);
			const selector = launched.window.locator('[data-tour="autorun-document-selector"]');
			await selector
				.getByRole('button', { name: /Phase 1\.md/ })
				.first()
				.click();
			await selector.getByRole('button', { name: /Research/ }).click();
			await selector.getByRole('button', { name: /Deep/ }).click();
			await selector.getByRole('button', { name: /Nested\.md/ }).click();

			await expect(launched.window.getByRole('heading', { name: 'Nested Research' })).toBeVisible();
			await expect(launched.window.getByText('Nested Codex Auto Run sentinel.')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('expands a long queued Codex prompt with attachment count in the lane terminal', async () => {
		const launched = await launchQueuedLaneWorkbench();
		try {
			await openCodexAiTerminal(launched.window);

			await expect(launched.window.getByText('QUEUED (2)')).toBeVisible();
			await expect(launched.window.getByText('1 image attached')).toBeVisible();
			await expect(
				launched.window.getByText('Codex queued long prompt line 18 for Auto Run lane coverage')
			).toBeHidden();

			await launched.window.getByRole('button', { name: /Show all/ }).click();
			await expect(
				launched.window.getByText('Codex queued long prompt line 18 for Auto Run lane coverage')
			).toBeVisible();

			await launched.window.getByRole('button', { name: 'Show less' }).click();
			await expect(
				launched.window.getByText('Codex queued long prompt line 18 for Auto Run lane coverage')
			).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test('removes a queued Codex prompt only after confirmation in the lane terminal', async () => {
		const launched = await launchQueuedLaneWorkbench();
		try {
			await openCodexAiTerminal(launched.window);

			await expect(launched.window.getByText('QUEUED (2)')).toBeVisible();
			await launched.window.getByTitle('Remove from queue').first().click();
			const confirmDialog = launched.window.getByText('Remove Queued Message?').locator('..');
			await expect(confirmDialog).toBeVisible();
			await confirmDialog.getByRole('button', { name: 'Cancel' }).click();
			await expect(launched.window.getByText('QUEUED (2)')).toBeVisible();

			await launched.window.getByTitle('Remove from queue').first().click();
			await confirmDialog.getByRole('button', { name: 'Remove' }).click();

			await expect(launched.window.getByText('QUEUED (1)')).toBeVisible();
			await expect(
				launched.window.getByText('Codex queued long prompt line 01 for Auto Run lane coverage')
			).toBeHidden();
			await expect(launched.window.getByText('/history')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('opens the Codex execution queue browser from the lane terminal indicator', async () => {
		const launched = await launchQueuedLaneWorkbench();
		try {
			await openCodexAiTerminal(launched.window);

			const browser = await openExecutionQueueBrowser(launched.window);
			await expect(browser.getByText('2 total')).toBeVisible();
			await expect(browser.getByRole('button', { name: /Current Agent/ })).toBeVisible();
			await expect(browser.getByText('/history')).toBeVisible();
			await expect(browser.getByText('Generate a synopsis of this agent history')).toBeVisible();
			await expect(
				browser.getByText('Codex queued long prompt line 01 for Auto Run lane coverage')
			).toBeVisible();
			await expect(browser.getByText(/\+\s*1 image/)).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('switches the Codex queue browser between current and all-agent views', async () => {
		const launched = await launchQueuedLaneWorkbench();
		try {
			await openCodexAiTerminal(launched.window);

			const browser = await openExecutionQueueBrowser(launched.window);
			await browser.getByRole('button', { name: /All Agents/ }).click();

			await expect(browser.getByRole('button', { name: /Auto Run Codex E2E/ })).toBeVisible();
			await expect(browser.getByText('/history')).toBeVisible();

			await browser.getByRole('button', { name: /Current Agent/ }).click();
			await expect(browser.getByText('Generate a synopsis of this agent history')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('removes a queued Codex slash command from the execution queue browser', async () => {
		const launched = await launchQueuedLaneWorkbench();
		try {
			await openCodexAiTerminal(launched.window);

			const browser = await openExecutionQueueBrowser(launched.window);
			await expect(browser.getByText('/history')).toBeVisible();

			await browser.getByTitle('Remove from queue').last().click();

			await expect(browser.getByText('/history')).toBeHidden();
			await expect(browser.getByText('1 total')).toBeVisible();
			await expect(launched.window.getByText('QUEUED (1)')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('removes a queued Codex slash command from the terminal list after confirmation', async () => {
		const launched = await launchQueuedLaneWorkbench();
		try {
			await openCodexAiTerminal(launched.window);

			await expect(launched.window.getByText('QUEUED (2)')).toBeVisible();
			await launched.window.getByTitle('Remove from queue').last().click();
			const confirmDialog = launched.window.getByText('Remove Queued Message?').locator('..');
			await expect(confirmDialog).toBeVisible();
			await confirmDialog.getByRole('button', { name: 'Remove' }).click();

			await expect(launched.window.getByText('QUEUED (1)')).toBeVisible();
			await expect(launched.window.getByText('/history')).toBeHidden();
			await expect(
				launched.window.getByText('Codex queued long prompt line 01 for Auto Run lane coverage')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('closes the Codex execution queue browser with Escape without clearing queued work', async () => {
		const launched = await launchQueuedLaneWorkbench();
		try {
			await openCodexAiTerminal(launched.window);

			const browser = await openExecutionQueueBrowser(launched.window);
			await launched.window.keyboard.press('Escape');

			await expect(browser.getByRole('heading', { name: 'Execution Queue' })).toBeHidden();
			await expect(launched.window.getByRole('button', { name: /2 items queued/ })).toBeVisible();
			await expect(launched.window.getByText('QUEUED (2)')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('shows the empty current-agent state after removing all Codex queue browser items', async () => {
		const launched = await launchQueuedLaneWorkbench();
		try {
			await openCodexAiTerminal(launched.window);

			const browser = await openExecutionQueueBrowser(launched.window);
			await browser.getByTitle('Remove from queue').last().click();
			await browser.getByTitle('Remove from queue').last().click();

			await expect(browser.getByText('No items queued for this agent')).toBeVisible();
			await expect(browser.getByText('0 total')).toBeVisible();
			await expect(launched.window.getByRole('button', { name: /items queued/ })).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test('shows cross-agent Codex queued work in the All Agents browser view', async () => {
		const launched = await launchCrossSessionQueuedLaneWorkbench();
		try {
			await openCodexAiTerminal(launched.window);

			const browser = await openExecutionQueueBrowser(launched.window);
			await browser.getByRole('button', { name: /All Agents/ }).click();

			await expect(browser.getByText('3 total')).toBeVisible();
			await expect(browser.getByRole('button', { name: /Queued Companion Codex/ })).toBeVisible();
			await expect(browser.getByText('Companion Codex queued prompt sentinel')).toBeVisible();
			await expect(
				browser.getByText('Codex queued long prompt line 01 for Auto Run lane coverage')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('removes companion Codex queued work from All Agents without clearing the active queue', async () => {
		const launched = await launchCrossSessionQueuedLaneWorkbench();
		try {
			await openCodexAiTerminal(launched.window);

			const browser = await openExecutionQueueBrowser(launched.window);
			await browser.getByRole('button', { name: /All Agents/ }).click();
			const companionRow = browser
				.locator('div.relative.my-1')
				.filter({ hasText: 'Companion Codex queued prompt sentinel' });
			await companionRow.getByTitle('Remove from queue').click();

			await expect(browser.getByText('Companion Codex queued prompt sentinel')).toBeHidden();
			await expect(browser.getByText('2 total')).toBeVisible();
			await expect(
				browser.getByText('Codex queued long prompt line 01 for Auto Run lane coverage')
			).toBeVisible();
			await expect(launched.window.getByText('QUEUED (2)')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('summarizes queued Codex work across lane AI tabs in the indicator', async () => {
		const launched = await launchMultiTabQueuedLaneWorkbench();
		try {
			await openCodexAiTerminal(launched.window);

			const indicator = launched.window.getByRole('button', { name: /3 items queued/ });
			await expect(indicator).toBeVisible();
			await expect(indicator.getByText('Main (2)')).toBeVisible();
			await expect(indicator.getByText('Review')).toBeVisible();
			await expect(indicator.getByText('Click to view')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('filters queued Codex work to the active Main AI tab in the terminal list', async () => {
		const launched = await launchMultiTabQueuedLaneWorkbench();
		try {
			await openCodexAiTerminal(launched.window);

			await expect(launched.window.getByText('QUEUED (2)')).toBeVisible();
			await expect(
				launched.window.getByText('Codex queued Main tab prompt sentinel')
			).toBeVisible();
			await expect(launched.window.getByText('/compact')).toBeVisible();
			await expect(
				launched.window.getByText('Codex queued Review tab prompt sentinel')
			).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test('switches queued Codex terminal work to the Review AI tab', async () => {
		const launched = await launchMultiTabQueuedLaneWorkbench();
		try {
			await openCodexAiTerminal(launched.window);

			await launched.window.locator(`[data-tab-id="${launched.reviewTabId}"]`).click();

			await expect(
				launched.window.getByText('Codex queued Review tab transcript sentinel.')
			).toBeVisible();
			await expect(launched.window.getByText('QUEUED (1)')).toBeVisible();
			await expect(
				launched.window.getByText('Codex queued Review tab prompt sentinel')
			).toBeVisible();
			await expect(launched.window.getByText('Codex queued Main tab prompt sentinel')).toBeHidden();
			await expect(launched.window.getByText('/compact')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test('shows queued Codex work from all lane AI tabs in the queue browser', async () => {
		const launched = await launchMultiTabQueuedLaneWorkbench();
		try {
			await openCodexAiTerminal(launched.window);

			const browser = await openExecutionQueueBrowser(launched.window, 3);

			await expect(browser.getByText('3 total')).toBeVisible();
			await expect(browser.getByText('Codex queued Main tab prompt sentinel')).toBeVisible();
			await expect(browser.getByText('/compact')).toBeVisible();
			await expect(browser.getByText('Summarize the Main tab before continuing')).toBeVisible();
			await expect(browser.getByText('Codex queued Review tab prompt sentinel')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('removes inactive-tab Codex work from the queue browser without changing Main queued work', async () => {
		const launched = await launchMultiTabQueuedLaneWorkbench();
		try {
			await openCodexAiTerminal(launched.window);

			const browser = await openExecutionQueueBrowser(launched.window, 3);
			const reviewRow = browser
				.locator('div.relative.my-1')
				.filter({ hasText: 'Codex queued Review tab prompt sentinel' });
			await reviewRow.getByTitle('Remove from queue').click();

			await expect(browser.getByText('Codex queued Review tab prompt sentinel')).toBeHidden();
			await expect(browser.getByText('2 total')).toBeVisible();
			await expect(launched.window.getByRole('button', { name: /2 items queued/ })).toBeVisible();
			await expect(launched.window.getByText('QUEUED (2)')).toBeVisible();
			await expect(
				launched.window.getByText('Codex queued Main tab prompt sentinel')
			).toBeVisible();
			await expect(launched.window.getByText('/compact')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('dispatches a Codex AI terminal prompt with read-only metadata enabled', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await stubCodexProcessSpawn(launched.electronApp);
			const promptInput = await openCodexAiTerminal(launched.window);

			await launched.window.getByTitle("Toggle Read-Only mode (agent won't modify files)").click();
			await promptInput.fill('Codex read-only metadata prompt sentinel');
			await launched.window.getByTitle('Send message').click();

			await expect
				.poll(async () => (await getStubbedCodexProcessSpawnCalls(launched.electronApp)).length)
				.toBe(1);
			const calls = await getStubbedCodexProcessSpawnCalls(launched.electronApp);
			expect(calls[0].prompt).toContain('Codex read-only metadata prompt sentinel');
			expect(calls[0].readOnlyMode).toBe(true);
		} finally {
			await launched.cleanup();
		}
	});

	test('stages and removes a Codex AI terminal image attachment without dispatching', async () => {
		const launched = await launchLaneWorkbench();
		const imagePath = path.join(launched.homeDir, 'codex-lane-attachment.png');
		try {
			fs.writeFileSync(
				imagePath,
				Buffer.from(
					'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
					'base64'
				)
			);
			await openCodexAiTerminal(launched.window);

			await launched.window.locator('#image-file-input').setInputFiles(imagePath);

			const stagedImage = launched.window.getByAltText('Staged image 1');
			await expect(stagedImage).toBeVisible();
			const attachment = stagedImage.locator(
				'xpath=ancestor::div[contains(@class, "relative")][1]'
			);
			await attachment.locator('button').last().click();

			await expect(stagedImage).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test('interrupts an in-flight Codex prompt through the lane Stop control', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await stubCodexProcessSpawn(launched.electronApp, { exitDelayMs: 10_000 });
			await stubProcessInterrupt(launched.electronApp);
			const promptInput = await openCodexAiTerminal(launched.window);

			await promptInput.fill('Codex lane interrupt prompt sentinel');
			await launched.window.getByTitle('Send message').click();
			await expect
				.poll(async () => (await getStubbedCodexProcessSpawnCalls(launched.electronApp)).length)
				.toBe(1);

			await launched.window.getByRole('button', { name: 'Stop' }).click();

			const session = launched.sessions[0]!;
			const activeTab = session.aiTabs[0]!;
			await expect
				.poll(async () => getStubbedProcessInterruptCalls(launched.electronApp))
				.toEqual([`${session.id}-ai-${activeTab.id}`]);
			await expect(launched.window.getByText('Canceled by user')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('cycles Codex thinking display states without sending a lane draft', async () => {
		const launched = await launchLaneWorkbench();
		try {
			const promptInput = await openCodexAiTerminal(launched.window);
			await promptInput.fill('Codex thinking toggle draft sentinel');

			await launched.window.getByTitle('Show Thinking - Click to stream AI reasoning').click();
			await expect(
				launched.window.getByTitle('Thinking (temporary) - Click for sticky mode')
			).toBeVisible();

			await launched.window.getByTitle('Thinking (temporary) - Click for sticky mode').click();
			await expect(
				launched.window.getByTitle('Thinking (sticky) - Click to turn off')
			).toBeVisible();

			await launched.window.getByTitle('Thinking (sticky) - Click to turn off').click();
			await expect(
				launched.window.getByTitle('Show Thinking - Click to stream AI reasoning')
			).toBeVisible();
			await expect(promptInput).toHaveValue('Codex thinking toggle draft sentinel');
		} finally {
			await launched.cleanup();
		}
	});

	test('preserves a Codex lane draft while history and read-only controls change', async () => {
		const launched = await launchLaneWorkbench();
		try {
			const promptInput = await openCodexAiTerminal(launched.window);
			await promptInput.fill('Codex lane local toggle draft sentinel');

			await launched.window.getByTitle(/Save to History/).click();
			await expect(promptInput).toHaveValue('Codex lane local toggle draft sentinel');

			await launched.window.getByTitle("Toggle Read-Only mode (agent won't modify files)").click();
			await expect(launched.window.getByText('Read-Only')).toBeVisible();
			await expect(promptInput).toHaveValue('Codex lane local toggle draft sentinel');
		} finally {
			await launched.cleanup();
		}
	});

	test('shows recoverable active Codex lane error banner controls', async () => {
		const launched = await launchActiveErrorLaneWorkbench();
		try {
			await openCodexAiTerminal(launched.window);

			await expect(
				launched.window.getByText('Codex lane recoverable network error sentinel')
			).toBeVisible();
			await expect(launched.window.getByRole('button', { name: 'View Details' })).toBeVisible();
			await expect(launched.window.getByTitle('Dismiss error')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('dismisses a recoverable Codex lane error from the inline banner', async () => {
		const launched = await launchActiveErrorLaneWorkbench({
			message: 'Codex lane inline dismiss sentinel',
		});
		try {
			await openCodexAiTerminal(launched.window);

			await launched.window.getByTitle('Dismiss error').click();

			await expect(launched.window.getByText('Codex lane inline dismiss sentinel')).toBeHidden();
			await expect(launched.window.getByRole('button', { name: 'View Details' })).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test('shows Codex authentication recovery actions in the active error modal', async () => {
		const launched = await launchActiveErrorLaneWorkbench({
			type: 'auth_expired',
			message: 'Codex lane authentication expired sentinel',
		});
		try {
			await openCodexAiTerminal(launched.window);

			await launched.window.getByRole('button', { name: 'View Details' }).click();
			const dialog = launched.window.getByRole('dialog', { name: 'Authentication Required' });

			await expect(dialog.getByText('Codex lane authentication expired sentinel')).toBeVisible();
			await expect(dialog.getByRole('button', { name: 'Re-authenticate' })).toBeVisible();
			await expect(dialog.getByText('Log in again to restore access')).toBeVisible();
			await expect(dialog.getByRole('button', { name: 'Start New Session' })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('shows Codex context-limit recovery without dismiss controls', async () => {
		const launched = await launchActiveErrorLaneWorkbench({
			type: 'token_exhaustion',
			message: 'Codex lane context limit sentinel',
			recoverable: false,
		});
		try {
			await openCodexAiTerminal(launched.window);

			await launched.window.getByRole('button', { name: 'View Details' }).click();
			const dialog = launched.window.getByRole('dialog', { name: 'Context Limit Reached' });

			await expect(dialog.getByText('Codex lane context limit sentinel')).toBeVisible();
			await expect(dialog.getByRole('button', { name: 'Start New Session' })).toBeVisible();
			await expect(dialog.getByText('Begin a fresh conversation with full context')).toBeVisible();
			await expect(dialog.getByRole('button', { name: 'Dismiss' })).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test('shows Codex rate-limit retry recovery in the active error modal', async () => {
		const launched = await launchActiveErrorLaneWorkbench({
			type: 'rate_limited',
			message: 'Codex lane rate limit sentinel',
		});
		try {
			await openCodexAiTerminal(launched.window);

			await launched.window.getByRole('button', { name: 'View Details' }).click();
			const dialog = launched.window.getByRole('dialog', { name: 'Rate Limit Exceeded' });

			await expect(dialog.getByText('Codex lane rate limit sentinel')).toBeVisible();
			await expect(dialog.getByRole('button', { name: 'Try Again' })).toBeVisible();
			await expect(dialog.getByText('Wait a moment and retry')).toBeVisible();
			await expect(dialog.getByRole('button', { name: 'Dismiss' })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('shows Codex crashed-agent recovery actions without dispatching a restart', async () => {
		const launched = await launchActiveErrorLaneWorkbench({
			type: 'agent_crashed',
			message: 'Codex lane crashed agent sentinel',
			recoverable: false,
		});
		try {
			await openCodexAiTerminal(launched.window);

			await launched.window.getByRole('button', { name: 'View Details' }).click();
			const dialog = launched.window.getByRole('dialog', { name: 'Agent Error' });

			await expect(dialog.getByText('Codex lane crashed agent sentinel')).toBeVisible();
			await expect(dialog.getByRole('button', { name: 'Restart Agent' })).toBeVisible();
			await expect(dialog.getByText('Respawn the agent process')).toBeVisible();
			await expect(dialog.getByRole('button', { name: 'Start New Session' })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('opens Codex lane error details without clearing the active banner', async () => {
		const launched = await launchActiveErrorLaneWorkbench();
		try {
			await openCodexAiTerminal(launched.window);

			await launched.window.getByRole('button', { name: 'View Details' }).click();
			const dialog = launched.window.getByRole('dialog', { name: 'Connection Error' });
			await expect(dialog).toBeVisible();
			await expect(dialog.getByText('Codex lane recoverable network error sentinel')).toBeVisible();

			await dialog.getByRole('button', { name: /Error Details/ }).click();
			await expect(dialog.getByText('codex_lane_active_error')).toBeVisible();
			await dialog.getByRole('button', { name: 'Dismiss' }).click();

			await expect(dialog).toBeHidden();
			await expect(
				launched.window.getByText('Codex lane recoverable network error sentinel')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('hides inline dismiss for non-recoverable Codex active errors', async () => {
		const launched = await launchActiveErrorLaneWorkbench({
			message: 'Codex lane permission denied sentinel',
			recoverable: false,
		});
		try {
			await openCodexAiTerminal(launched.window);

			await expect(
				launched.window.getByText('Codex lane permission denied sentinel')
			).toBeVisible();
			await expect(launched.window.getByRole('button', { name: 'View Details' })).toBeVisible();
			await expect(launched.window.getByTitle('Dismiss error')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test('opens non-recoverable Codex permission details without dismiss controls', async () => {
		const launched = await launchActiveErrorLaneWorkbench({
			message: 'Codex lane hard permission sentinel',
			recoverable: false,
		});
		try {
			await openCodexAiTerminal(launched.window);

			await launched.window.getByRole('button', { name: 'View Details' }).click();
			const dialog = launched.window.getByRole('dialog', { name: 'Permission Denied' });
			await expect(dialog).toBeVisible();
			await expect(dialog.getByText('Codex lane hard permission sentinel')).toBeVisible();
			await expect(dialog.getByRole('button', { name: 'Dismiss' })).toBeHidden();
			await expect(dialog.getByLabel('Close modal')).toBeHidden();
			await expect(dialog.getByRole('button', { name: 'Try Again' })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('expands non-recoverable Codex error JSON details', async () => {
		const launched = await launchActiveErrorLaneWorkbench({
			message: 'Codex lane non-recoverable JSON sentinel',
			recoverable: false,
		});
		try {
			await openCodexAiTerminal(launched.window);

			await launched.window.getByRole('button', { name: 'View Details' }).click();
			const dialog = launched.window.getByRole('dialog', { name: 'Permission Denied' });
			await dialog.getByRole('button', { name: /Error Details/ }).click();

			await expect(dialog.getByText('codex_lane_active_error')).toBeVisible();
			await expect(dialog.getByText('retryable')).toBeVisible();
			await expect(dialog.getByText('false')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('closes non-recoverable Codex error details while preserving the banner', async () => {
		const launched = await launchActiveErrorLaneWorkbench({
			message: 'Codex lane modal close sentinel',
			recoverable: false,
		});
		try {
			await openCodexAiTerminal(launched.window);

			await launched.window.getByRole('button', { name: 'View Details' }).click();
			const dialog = launched.window.getByRole('dialog', { name: 'Permission Denied' });
			await expect(dialog).toBeVisible();

			await launched.window.keyboard.press('Escape');

			await expect(dialog).toBeHidden();
			await expect(launched.window.getByText('Codex lane modal close sentinel')).toBeVisible();
			await expect(launched.window.getByTitle('Dismiss error')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test('retries a non-recoverable Codex active error and restores terminal focus', async () => {
		const launched = await launchActiveErrorLaneWorkbench({
			message: 'Codex lane retry recovery sentinel',
			recoverable: false,
		});
		try {
			const promptInput = await openCodexAiTerminal(launched.window);

			await launched.window.getByRole('button', { name: 'View Details' }).click();
			const dialog = launched.window.getByRole('dialog', { name: 'Permission Denied' });
			await dialog.getByRole('button', { name: 'Try Again' }).click();

			await expect(dialog).toBeHidden();
			await expect(launched.window.getByText('Codex lane retry recovery sentinel')).toBeHidden();
			await expect(promptInput).toBeFocused();
		} finally {
			await launched.cleanup();
		}
	});

	test('filters Codex lane transcript output from the input shortcut', async () => {
		const launched = await launchLaneWorkbench();
		try {
			const promptInput = await openCodexAiTerminal(launched.window);

			await promptInput.focus();
			await promptInput.press('Control+f');
			const outputFilter = launched.window.getByPlaceholder('Filter output... (Esc to close)');
			await expect(outputFilter).toBeVisible();

			await outputFilter.fill('paired response');
			await expect(
				launched.window.getByText('Codex paired response for delivered user action coverage.')
			).toBeVisible();

			await outputFilter.fill('not-present-in-lane-transcript');
			await expect(
				launched.window.getByText('Codex paired response for delivered user action coverage.')
			).toBeHidden();

			await outputFilter.press('Escape');
			await expect(outputFilter).toBeHidden();
			await expect(
				launched.window.getByText('Codex paired response for delivered user action coverage.')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('renders a Codex lane thinking transcript entry with its source label', async () => {
		const launched = await launchTranscriptSurfaceLaneWorkbench();
		try {
			await openCodexAiTerminal(launched.window);

			const thinkingBlock = launched.window.locator('[data-log-index="3"]');
			await expect(thinkingBlock.getByText('thinking')).toBeVisible();
			await expect(
				thinkingBlock.getByText('Codex lane thinking transcript sentinel.')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('renders Codex lane running, completed, and failed tool transcript rows', async () => {
		const launched = await launchTranscriptSurfaceLaneWorkbench();
		try {
			await openCodexAiTerminal(launched.window);

			const runningToolBlock = launched.window.locator('[data-log-index="4"]');
			await expect(runningToolBlock.getByText('shell')).toBeVisible();
			await expect(
				runningToolBlock.getByText('pnpm lint --filter autorun-ai-terminal')
			).toBeVisible();

			const completedToolBlock = launched.window.locator('[data-log-index="5"]');
			await expect(completedToolBlock.getByText('read')).toBeVisible();
			await expect(completedToolBlock.getByText('e2e/autorun-ai-terminal.spec.ts')).toBeVisible();

			const failedToolBlock = launched.window.locator('[data-log-index="6"]');
			await expect(failedToolBlock.getByText('apply_patch')).toBeVisible();
			await expect(failedToolBlock.getByText('Codex lane failed patch sentinel')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('opens Codex lane historical error details from the transcript', async () => {
		const launched = await launchTranscriptSurfaceLaneWorkbench();
		try {
			await openCodexAiTerminal(launched.window);

			const errorBlock = launched.window.locator('[data-log-index="7"]');
			await expect(
				errorBlock.getByText('Codex lane historical error transcript sentinel.')
			).toBeVisible();
			await errorBlock.getByRole('button', { name: 'View Details' }).click();

			const dialog = launched.window.getByRole('dialog', { name: 'Agent Error' });
			await expect(dialog.getByText('Codex lane historical error detail sentinel')).toBeVisible();
			await dialog.getByRole('button', { name: /Error Details/ }).click();
			await expect(dialog.getByText('codex_lane_historical_error')).toBeVisible();
			await expect(dialog.getByText('transcript-surfaces')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('copies a Codex lane thinking transcript block from inline actions', async () => {
		const launched = await launchTranscriptSurfaceLaneWorkbench();
		try {
			await openCodexAiTerminal(launched.window);

			const thinkingBlock = launched.window.locator('[data-log-index="3"]');
			await thinkingBlock.hover();
			await thinkingBlock.getByTitle('Copy to clipboard').click();

			await expect(launched.window.getByText('Copied to Clipboard')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('filters Codex lane transcript tool and thinking sentinel rows', async () => {
		const launched = await launchTranscriptSurfaceLaneWorkbench();
		try {
			const promptInput = await openCodexAiTerminal(launched.window);

			await promptInput.focus();
			await promptInput.press('Control+f');
			const outputFilter = launched.window.getByPlaceholder('Filter output... (Esc to close)');
			await expect(outputFilter).toBeVisible();

			await outputFilter.fill('apply_patch');
			await expect(launched.window.getByText('apply_patch')).toBeVisible();
			await expect(
				launched.window.getByText('Codex lane thinking transcript sentinel.')
			).toBeHidden();

			await outputFilter.fill('thinking');
			await expect(
				launched.window.getByText('Codex lane thinking transcript sentinel.')
			).toBeVisible();
			await expect(launched.window.getByText('apply_patch')).toBeHidden();

			await outputFilter.press('Escape');
			await expect(outputFilter).toBeHidden();
			await expect(launched.window.getByText('apply_patch')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('saves a Codex lane thinking transcript block to markdown', async () => {
		const launched = await launchTranscriptSurfaceLaneWorkbench();
		const savedPath = path.join(launched.projectDir, 'codex-lane-thinking.md');
		try {
			await openCodexAiTerminal(launched.window);

			const thinkingBlock = launched.window.locator('[data-log-index="3"]');
			await thinkingBlock.hover();
			await thinkingBlock.getByTitle('Save to file').click();

			const saveDialog = launched.window.getByRole('dialog', { name: 'Save Markdown' });
			await saveDialog.getByPlaceholder('document.md').fill('codex-lane-thinking');
			await saveDialog.getByRole('button', { name: 'Save' }).click();

			await expect
				.poll(() => fs.readFileSync(savedPath, 'utf-8'))
				.toContain('Codex lane thinking transcript sentinel.');
		} finally {
			await launched.cleanup();
		}
	});

	test('toggles a Codex lane thinking transcript block between formatted and plain text', async () => {
		const launched = await launchTranscriptSurfaceLaneWorkbench();
		try {
			await openCodexAiTerminal(launched.window);

			const thinkingBlock = launched.window.locator('[data-log-index="3"]');
			await thinkingBlock.hover();
			await thinkingBlock.getByTitle(/Show plain text/).click();
			await expect(thinkingBlock.getByTitle(/Show formatted/)).toBeVisible();

			await thinkingBlock.getByTitle(/Show formatted/).click();
			await expect(thinkingBlock.getByTitle(/Show plain text/)).toBeVisible();
			await expect(
				thinkingBlock.getByText('Codex lane thinking transcript sentinel.')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('copies a Codex lane failed tool transcript block from inline actions', async () => {
		const launched = await launchTranscriptSurfaceLaneWorkbench();
		try {
			await openCodexAiTerminal(launched.window);

			const failedToolBlock = launched.window.locator('[data-log-index="6"]');
			await expect(failedToolBlock.getByText('apply_patch')).toBeVisible();
			await failedToolBlock.hover();
			await failedToolBlock.getByTitle('Copy to clipboard').click();

			await expect(launched.window.getByText('Copied to Clipboard')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('shows no-match feedback for the Codex lane transcript output filter', async () => {
		const launched = await launchTranscriptSurfaceLaneWorkbench();
		try {
			const promptInput = await openCodexAiTerminal(launched.window);

			await promptInput.focus();
			await promptInput.press('Control+f');
			const outputFilter = launched.window.getByPlaceholder('Filter output... (Esc to close)');
			await outputFilter.fill('not-present-in-codex-lane-transcript');

			await expect(launched.window.getByText('No matches found for filter').first()).toBeVisible();
			await expect(launched.window.getByText('apply_patch')).toBeHidden();

			await outputFilter.press('Escape');
			await expect(outputFilter).toBeHidden();
			await expect(launched.window.getByText('apply_patch')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('keeps historical Codex lane error details read-only in the transcript', async () => {
		const launched = await launchTranscriptSurfaceLaneWorkbench();
		try {
			await openCodexAiTerminal(launched.window);

			const errorBlock = launched.window.locator('[data-log-index="7"]');
			await errorBlock.getByRole('button', { name: 'View Details' }).click();
			const dialog = launched.window.getByRole('dialog', { name: 'Agent Error' });

			await expect(dialog.getByText('Codex lane historical error detail sentinel')).toBeVisible();
			await expect(dialog.getByRole('button', { name: 'Try Again' })).toBeHidden();
			await expect(dialog.getByRole('button', { name: 'Restart Agent' })).toBeHidden();
			await expect(dialog.getByRole('button', { name: 'Start New Session' })).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test('toggles a Codex lane response between formatted and plain markdown', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openCodexAiTerminal(launched.window);

			const responseBlock = launched.window.locator('[data-log-index="2"]');
			await responseBlock.hover();
			await responseBlock.getByTitle(/Show plain text/).click();
			await expect(responseBlock.getByTitle(/Show formatted/)).toBeVisible();
			await expect(responseBlock.getByText('# Codex Lane Paired Response')).toBeVisible();

			await responseBlock.getByTitle(/Show formatted/).click();
			await expect(responseBlock.getByTitle(/Show plain text/)).toBeVisible();
			await expect(responseBlock.getByText('Codex Lane Paired Response')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('saves a Codex lane response to markdown from transcript actions', async () => {
		const launched = await launchLaneWorkbench();
		const savedPath = path.join(launched.projectDir, 'codex-lane-response.md');
		try {
			await openCodexAiTerminal(launched.window);

			const responseBlock = launched.window.locator('[data-log-index="2"]');
			await responseBlock.hover();
			await responseBlock.getByTitle('Save to file').click();

			const saveDialog = launched.window.getByRole('dialog', { name: 'Save Markdown' });
			await expect(saveDialog).toBeVisible();
			await expect(saveDialog.getByPlaceholder('/path/to/folder')).toHaveValue(launched.projectDir);

			await saveDialog.getByPlaceholder('document.md').fill('codex-lane-response');
			await saveDialog.getByRole('button', { name: 'Save' }).click();
			await expect(saveDialog).toBeHidden();

			await expect.poll(() => fs.existsSync(savedPath)).toBe(true);
			expect(fs.readFileSync(savedPath, 'utf-8')).toContain(
				'Codex paired response for delivered user action coverage.'
			);
		} finally {
			await launched.cleanup();
		}
	});

	test('shows delivered Codex lane user-message transcript actions without replaying', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openCodexAiTerminal(launched.window);

			const userBlock = launched.window.locator('[data-log-index="1"]');
			await expect(
				userBlock.getByText('Review Auto Run lane coverage without a live provider')
			).toBeVisible();

			await userBlock.hover();
			await expect(userBlock.getByTitle('Message delivered')).toBeVisible();
			await expect(userBlock.getByTitle('Replay message')).toBeVisible();
			await expect(userBlock.getByTitle('Delete message and response')).toBeVisible();
			await expect(
				launched.window.getByText('Codex paired response for delivered user action coverage.')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('cancels Codex lane user-message paired deletion from transcript actions', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openCodexAiTerminal(launched.window);

			const userBlock = launched.window.locator('[data-log-index="1"]');
			await userBlock.hover();
			await userBlock.getByTitle('Delete message and response').click();
			await expect(userBlock.getByText('Delete?')).toBeVisible();

			await userBlock.getByRole('button', { name: 'No' }).click();

			await expect(userBlock.getByText('Delete?')).toBeHidden();
			await expect(
				launched.window.getByText('Review Auto Run lane coverage without a live provider')
			).toBeVisible();
			await expect(
				launched.window.getByText('Codex paired response for delivered user action coverage.')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('replays a delivered Codex lane user message through the stubbed spawn path', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await stubCodexProcessSpawn(launched.electronApp);
			const promptInput = await openCodexAiTerminal(launched.window);
			await promptInput.fill('Preserve this lane draft during replay');

			const userBlock = launched.window.locator('[data-log-index="1"]');
			await userBlock.hover();
			await userBlock.getByTitle('Replay message').click();

			await expect
				.poll(async () => (await getStubbedCodexProcessSpawnCalls(launched.electronApp)).length)
				.toBe(1);
			const calls = await getStubbedCodexProcessSpawnCalls(launched.electronApp);
			expect(calls[0].prompt).toContain('Review Auto Run lane coverage without a live provider');
			await expect(promptInput).toHaveValue('Preserve this lane draft during replay');
		} finally {
			await launched.cleanup();
		}
	});

	test('deletes a Codex lane user message and paired response from transcript actions', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openCodexAiTerminal(launched.window);

			const userBlock = launched.window.locator('[data-log-index="1"]');
			await userBlock.hover();
			await userBlock.getByTitle('Delete message and response').click();
			await userBlock.getByRole('button', { name: 'Yes' }).click();

			await expect(
				launched.window.getByText('Review Auto Run lane coverage without a live provider')
			).toBeHidden();
			await expect(
				launched.window.getByText('Codex paired response for delivered user action coverage.')
			).toBeHidden();
			await expect(
				launched.window.getByText('Codex lane seeded response is visible.')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('filters and completes Codex lane slash commands without sending', async () => {
		const launched = await launchLaneWorkbench();
		try {
			const promptInput = await openCodexAiTerminal(launched.window);

			await promptInput.fill('/');
			await expect(
				launched.window.getByRole('button', { name: /\/history Generate a synopsis/ })
			).toBeVisible();
			await expect(
				launched.window.getByRole('button', { name: /\/wizard Start the planning wizard/ })
			).toBeVisible();

			await promptInput.press('ArrowDown');
			await promptInput.press('Tab');

			await expect(promptInput).toHaveValue('/wizard');
			await expect(launched.window.getByRole('button', { name: /\/history/ })).toHaveCount(0);
		} finally {
			await launched.cleanup();
		}
	});

	test('inserts a Codex lane file mention from README suggestions without sending', async () => {
		const launched = await launchLaneWorkbench();
		try {
			const promptInput = await openCodexAiTerminal(launched.window);

			await promptInput.fill('Please inspect @REA');
			await expect(launched.window.getByText('Files matching "REA"')).toBeVisible();
			const fileSuggestions = launched.window
				.getByText('Files matching "REA"')
				.locator('xpath=ancestor::div[contains(@class, "absolute")][1]');
			const readmeSuggestion = fileSuggestions.getByRole('button', { name: 'README.md file' });
			await expect(readmeSuggestion).toBeVisible();

			await readmeSuggestion.click();

			await expect(promptInput).toHaveValue('Please inspect @README.md ');
			await expect(launched.window.getByText('Files matching "REA"')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test('dismisses Codex lane file mention suggestions while preserving the draft', async () => {
		const launched = await launchLaneWorkbench();
		try {
			const promptInput = await openCodexAiTerminal(launched.window);

			await promptInput.fill('Keep this lane draft @NOT');
			await expect(launched.window.getByText('Files matching "NOT"')).toBeVisible();
			const fileSuggestions = launched.window
				.getByText('Files matching "NOT"')
				.locator('xpath=ancestor::div[contains(@class, "absolute")][1]');
			await expect(fileSuggestions.getByRole('button', { name: 'NOTES.md file' })).toBeVisible();

			await promptInput.press('Escape');

			await expect(launched.window.getByText('Files matching "NOT"')).toBeHidden();
			await expect(promptInput).toHaveValue('Keep this lane draft @NOT');
		} finally {
			await launched.cleanup();
		}
	});

	test('accepts a Codex lane file mention suggestion with Tab', async () => {
		const launched = await launchLaneWorkbench();
		try {
			const promptInput = await openCodexAiTerminal(launched.window);

			await promptInput.fill('Attach @NOT');
			await expect(launched.window.getByText('Files matching "NOT"')).toBeVisible();
			await expect(launched.window.getByRole('button', { name: 'NOTES.md file' })).toBeVisible();
			await promptInput.press('Tab');

			await expect(promptInput).toHaveValue('Attach @NOTES.md ');
			await expect(launched.window.getByText('Files matching "NOT"')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test('navigates Codex lane Auto Run file mention suggestions with ArrowDown and Enter', async () => {
		const launched = await launchLaneWorkbench();
		try {
			const promptInput = await openCodexAiTerminal(launched.window);

			await promptInput.fill('@Phase');
			await expect(
				launched.window.getByRole('button', { name: 'Auto Run Docs/Phase 1.md file' })
			).toBeVisible();
			await expect(
				launched.window.getByRole('button', { name: 'Auto Run Docs/Phase 2.md file' })
			).toBeVisible();
			await promptInput.press('ArrowDown');
			await promptInput.press('Enter');

			await expect(promptInput).toHaveValue('@Auto Run Docs/Phase 2.md ');
			await expect(
				launched.window.getByRole('button', { name: 'Auto Run Docs/Phase 2.md file' })
			).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test('inserts a Codex lane folder mention from project suggestions', async () => {
		const launched = await launchLaneWorkbench();
		try {
			const promptInput = await openCodexAiTerminal(launched.window);

			await promptInput.fill('Open @Auto');
			await expect(launched.window.getByText('Files matching "Auto"')).toBeVisible();
			const folderSuggestion = launched.window.getByRole('button', {
				name: 'Auto Run Docs folder',
			});
			await expect(folderSuggestion).toBeVisible();
			await folderSuggestion.click();

			await expect(promptInput).toHaveValue('Open @Auto Run Docs ');
		} finally {
			await launched.cleanup();
		}
	});

	test('does not open Codex lane file mentions for inline at signs', async () => {
		const launched = await launchLaneWorkbench();
		try {
			const promptInput = await openCodexAiTerminal(launched.window);

			await promptInput.fill('owner@REA');

			await expect(launched.window.getByText('Files matching "REA"')).toBeHidden();
			await expect(promptInput).toHaveValue('owner@REA');
		} finally {
			await launched.cleanup();
		}
	});

	test('closes Codex lane file mention suggestions once the filter contains a space', async () => {
		const launched = await launchLaneWorkbench();
		try {
			const promptInput = await openCodexAiTerminal(launched.window);

			await promptInput.fill('Mention @REA');
			await expect(launched.window.getByText('Files matching "REA"')).toBeVisible();
			await promptInput.fill('Mention @REA now');

			await expect(launched.window.getByText('Files matching "REA"')).toBeHidden();
			await expect(promptInput).toHaveValue('Mention @REA now');
		} finally {
			await launched.cleanup();
		}
	});

	test('switches between seeded Auto Run documents for the Codex lane agent', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);
			const selector = await waitForSeededAutoRunDocumentList(launched.window);

			await selector
				.getByRole('button', { name: /Phase 1\.md/ })
				.first()
				.click();
			await launched.window.getByRole('button', { name: /Phase 2\.md/ }).click();

			await expect(
				launched.window.getByRole('heading', { name: 'Phase 2: Lane Follow-up' })
			).toBeVisible();
			await expect(launched.window.getByText('Codex second document sentinel.')).toBeVisible();

			await selector
				.getByRole('button', { name: /Phase 2\.md/ })
				.first()
				.click();
			await launched.window.getByRole('button', { name: /Phase 1\.md/ }).click();
			await expect(
				launched.window.getByRole('heading', { name: 'Phase 1: Lane Setup' })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('closes the Auto Run document selector with Escape while preserving selection', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);
			const selector = await waitForSeededAutoRunDocumentList(launched.window);

			await selector
				.getByRole('button', { name: /Phase 1\.md/ })
				.first()
				.click();
			await expect(launched.window.getByRole('button', { name: /Phase 2\.md/ })).toBeVisible();
			await launched.window.keyboard.press('Escape');

			await expect(launched.window.getByRole('button', { name: /Phase 2\.md/ })).toBeHidden();
			await expect(
				launched.window.getByRole('heading', { name: 'Phase 1: Lane Setup' })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('cancels Auto Run document creation without creating a Codex lane file', async () => {
		const launched = await launchLaneWorkbench();
		const canceledPath = path.join(launched.autoRunFolder, 'Canceled.md');
		try {
			await openAutoRunPanel(launched.window);
			await launched.window.getByTitle('Create new document').click();

			const dialog = launched.window.getByRole('dialog', { name: 'Create New Document' });
			await expect(dialog).toBeVisible();
			await dialog.getByLabel('Document Name').fill('Canceled');
			await dialog.getByRole('button', { name: 'Cancel' }).click();

			await expect(dialog).toBeHidden();
			expect(fs.existsSync(canceledPath)).toBe(false);
		} finally {
			await launched.cleanup();
		}
	});

	test('closes Auto Run document creation with Escape and resets the draft', async () => {
		const launched = await launchLaneWorkbench();
		const escapedPath = path.join(launched.autoRunFolder, 'Escaped.md');
		try {
			await openAutoRunPanel(launched.window);
			await launched.window.getByTitle('Create new document').click();

			const dialog = launched.window.getByRole('dialog', { name: 'Create New Document' });
			await dialog.getByLabel('Document Name').fill('Escaped');
			await launched.window.keyboard.press('Escape');

			await expect(dialog).toBeHidden();
			expect(fs.existsSync(escapedPath)).toBe(false);

			await launched.window.getByTitle('Create new document').click();
			const reopenedDialog = launched.window.getByRole('dialog', { name: 'Create New Document' });
			await expect(reopenedDialog.getByLabel('Document Name')).toHaveValue('');
		} finally {
			await launched.cleanup();
		}
	});

	test('saves edits to Phase 2 without changing the selected Codex Phase 1 document', async () => {
		const launched = await launchLaneWorkbench();
		const phaseTwoEdit = `# Phase 2: Lane Follow-up

## Tasks

- [x] Expand remaining Auto Run matrix
- [ ] Expand remaining Codex terminal matrix

Codex phase two saved edit sentinel.
`;
		try {
			await openAutoRunPanel(launched.window);
			const selector = await waitForSeededAutoRunDocumentList(launched.window);
			await selector
				.getByRole('button', { name: /Phase 1\.md/ })
				.first()
				.click();
			await launched.window.getByRole('button', { name: /Phase 2\.md/ }).click();

			await launched.window.getByTitle('Edit document').click();
			const editor = launched.window.getByPlaceholder(/Capture notes/);
			await editor.fill(phaseTwoEdit);
			await launched.window.getByTitle(/Save changes/).click();

			await expect
				.poll(() => fs.readFileSync(launched.phaseTwoPath, 'utf-8'))
				.toContain('Codex phase two saved edit sentinel.');
			expect(fs.readFileSync(launched.phaseOnePath, 'utf-8')).toContain(
				'Codex auto-run lane sentinel.'
			);
		} finally {
			await launched.cleanup();
		}
	});

	test('follows an Auto Run wiki link to the Codex Phase 2 document', async () => {
		const launched = await launchPreviewLinkLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);

			await launched.window.getByRole('link', { name: 'Phase Two Follow-up' }).click();

			await expect(
				launched.window.getByRole('heading', { name: 'Phase 2: Lane Follow-up' })
			).toBeVisible();
			await expect(launched.window.getByText('Codex second document sentinel.')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('follows an Auto Run markdown file link to the Codex Phase 2 document', async () => {
		const launched = await launchPreviewLinkLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);

			await launched.window.getByRole('link', { name: 'Phase 2 markdown' }).click();

			await expect(
				launched.window.getByRole('heading', { name: 'Phase 2: Lane Follow-up' })
			).toBeVisible();
			await expect(
				launched.window.getByText('Expand remaining Codex terminal matrix')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('routes an Auto Run external preview link through shell IPC', async () => {
		const launched = await launchPreviewLinkLaneWorkbench();
		try {
			await stubOpenExternal(launched.electronApp);
			await openAutoRunPanel(launched.window);

			await launched.window.getByRole('link', { name: 'RunMaestro external' }).click();

			await expect
				.poll(async () => getStubbedOpenExternalUrl(launched.electronApp))
				.toBe('https://runmaestro.ai/autorun-lane');
		} finally {
			await launched.cleanup();
		}
	});

	test('opens a URL-encoded Auto Run preview image in the Codex lane lightbox', async () => {
		const launched = await launchPreviewLinkLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);

			await expect(launched.window.getByRole('img', { name: 'Codex preview image' })).toBeVisible();
			await launched.window.getByTitle(`Click to enlarge: ${launched.imageFilename}`).click();

			await expect(
				launched.window.getByRole('img', { name: `images/${launched.imageFilename}` })
			).toBeVisible();
			await expect(
				launched.window.getByTitle('Copy markdown reference (e.g., ![alt](path))')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('reports missing Auto Run preview image loads in the Codex lane document', async () => {
		const launched = await launchPreviewLinkLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);

			await expect(launched.window.getByText(/Failed to load image:/)).toBeVisible();
			await expect(launched.window.getByText(/missing-codex-preview\.png/)).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('opens and closes Auto Run preview search for the Codex lane document', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);

			await launched.window.locator('.autorun-panel').press('Control+f');
			const searchInput = launched.window.getByPlaceholder('Search...');
			await expect(searchInput).toBeVisible();

			await searchInput.fill('sentinel');
			await expect(launched.window.getByText('1/1')).toBeVisible();

			await searchInput.fill('not-present-in-autorun-lane');
			await expect(launched.window.getByText('No matches')).toBeVisible();

			await launched.window.getByTitle('Close search (Esc)').click();
			await expect(searchInput).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test('toggles Bionify preview mode for the selected Auto Run document', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);

			await launched.window.getByTitle('Enable Bionify for this document preview').click();
			await expect(
				launched.window.getByTitle('Disable Bionify for this document preview')
			).toBeVisible();

			await launched.window.getByTitle('Disable Bionify for this document preview').click();
			await expect(
				launched.window.getByTitle('Enable Bionify for this document preview')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('opens the Auto Run guide and closes it with the primary action', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);

			await launched.window.getByTitle('Learn about Auto Runner').click();
			const guide = launched.window.getByRole('dialog', { name: 'Auto Run Guide' });
			await expect(guide).toBeVisible();
			await expect(guide.getByText('Setting Up a Runner Docs Folder')).toBeVisible();
			await expect(guide.getByText('Document Format')).toBeVisible();

			await guide.getByRole('button', { name: 'Got it' }).click();
			await expect(guide).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test('cancels Auto Run completed-task reset without changing the Codex lane document', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);
			await launched.window.getByTitle('Reset 1 completed task').click();

			const dialog = launched.window.getByRole('dialog', { name: 'Reset Completed Tasks' });
			await expect(dialog).toBeVisible();
			await expect(dialog.getByText(/Phase 1/)).toBeVisible();

			await dialog.getByRole('button', { name: 'Cancel' }).click();

			await expect(dialog).toBeHidden();
			expect(fs.readFileSync(launched.phaseOnePath, 'utf-8')).toContain(
				'- [x] Keep Codex provider execution stubbed'
			);
		} finally {
			await launched.cleanup();
		}
	});

	test('confirms Auto Run completed-task reset for the Codex lane document', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);
			await launched.window.getByTitle('Reset 1 completed task').click();

			const dialog = launched.window.getByRole('dialog', { name: 'Reset Completed Tasks' });
			await dialog.getByRole('button', { name: 'Reset Tasks' }).click();

			await expect(dialog).toBeHidden();
			await expect
				.poll(() => fs.readFileSync(launched.phaseOnePath, 'utf-8'))
				.toContain('- [ ] Keep Codex provider execution stubbed');
			await expect(launched.window.getByText('0 of 3 tasks completed').first()).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('clears a Codex lane network error through Retry Connection', async () => {
		const launched = await launchActiveErrorLaneWorkbench({
			message: 'Codex lane retry connection sentinel',
		});
		try {
			const promptInput = await openCodexAiTerminal(launched.window);

			await launched.window.getByRole('button', { name: 'View Details' }).click();
			const dialog = launched.window.getByRole('dialog', { name: 'Connection Error' });
			await expect(dialog.getByText('Codex lane retry connection sentinel')).toBeVisible();

			await dialog.getByRole('button', { name: 'Retry Connection' }).click();

			await expect(dialog).toBeHidden();
			await expect(launched.window.getByText('Codex lane retry connection sentinel')).toBeHidden();
			await expect(launched.window.getByRole('button', { name: 'View Details' })).toBeHidden();
			await expect(promptInput).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('clears a Codex lane rate-limit error through Try Again', async () => {
		const launched = await launchActiveErrorLaneWorkbench({
			type: 'rate_limited',
			message: 'Codex lane retry rate-limit sentinel',
		});
		try {
			await openCodexAiTerminal(launched.window);

			await launched.window.getByRole('button', { name: 'View Details' }).click();
			const dialog = launched.window.getByRole('dialog', { name: 'Rate Limit Exceeded' });
			await expect(dialog.getByText('Codex lane retry rate-limit sentinel')).toBeVisible();

			await dialog.getByRole('button', { name: 'Try Again' }).click();

			await expect(dialog).toBeHidden();
			await expect(launched.window.getByText('Codex lane retry rate-limit sentinel')).toBeHidden();
			await expect(launched.window.getByRole('button', { name: 'View Details' })).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test('creates and saves a new Codex lane Auto Run document body', async () => {
		const launched = await launchLaneWorkbench();
		const phaseFourPath = path.join(launched.autoRunFolder, 'Phase 4.md');
		const phaseFourContent = `# Phase 4: Saved Body

## Tasks

- [ ] Verify saved Codex lane document content

Codex saved Auto Run body sentinel.
`;
		try {
			await openAutoRunPanel(launched.window);
			await waitForSeededAutoRunDocumentList(launched.window);
			await launched.window.getByTitle('Create new document').click();

			const dialog = launched.window.getByRole('dialog', { name: 'Create New Document' });
			await dialog.getByLabel('Document Name').fill('Phase 4');
			await dialog.getByRole('button', { name: 'Create' }).click();

			const editor = launched.window.getByPlaceholder(/Capture notes/);
			await editor.fill(phaseFourContent);
			await launched.window.getByTitle(/Save changes/).click();

			await expect
				.poll(() => fs.readFileSync(phaseFourPath, 'utf-8'))
				.toContain('Codex saved Auto Run body sentinel.');
			await launched.window.getByTitle('Preview document').click();
			await expect(
				launched.window.getByRole('heading', { name: 'Phase 4: Saved Body' })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('removes an externally deleted Codex lane Auto Run document after refresh', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);
			const selector = await waitForSeededAutoRunDocumentList(launched.window);
			fs.rmSync(launched.phaseTwoPath);

			await launched.window.getByTitle('Refresh document list').click();
			await selector
				.getByRole('button', { name: /Phase 1\.md/ })
				.first()
				.click();

			await expect(launched.window.getByRole('button', { name: /Phase 2\.md/ })).toHaveCount(0);
			await expect(
				launched.window.getByRole('heading', { name: 'Phase 1: Lane Setup' })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('reopens Auto Run preview search with the Codex lane query cleared', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);

			await launched.window.locator('.autorun-panel').press('Control+f');
			const searchInput = launched.window.getByPlaceholder('Search...');
			await searchInput.fill('sentinel');
			await expect(launched.window.getByText('1/1')).toBeVisible();

			await launched.window.getByTitle('Close search (Esc)').click();
			await expect(searchInput).toBeHidden();

			await launched.window.locator('.autorun-panel').press('Control+f');
			await expect(launched.window.getByPlaceholder('Search...')).toHaveValue('');
		} finally {
			await launched.cleanup();
		}
	});

	test('discards unsaved Codex lane Auto Run edits from the bottom panel', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);
			await launched.window.getByTitle('Edit document').click();
			const editor = launched.window.getByPlaceholder(/Capture notes/);

			await editor.fill(`${launched.phaseOneContent}\nCodex unsaved discard sentinel.\n`);
			await expect(launched.window.getByText('Unsaved changes')).toBeVisible();
			await launched.window.getByTitle('Discard changes').click();

			await expect(editor).toHaveValue(launched.phaseOneContent);
			expect(fs.readFileSync(launched.phaseOnePath, 'utf-8')).toBe(launched.phaseOneContent);
		} finally {
			await launched.cleanup();
		}
	});

	test('saves Codex lane Auto Run edits with the keyboard shortcut', async () => {
		const launched = await launchLaneWorkbench();
		const shortcutContent = `${launched.phaseOneContent}\nCodex keyboard save sentinel.\n`;
		try {
			await openAutoRunPanel(launched.window);
			await launched.window.getByTitle('Edit document').click();
			const editor = launched.window.getByPlaceholder(/Capture notes/);

			await editor.fill(shortcutContent);
			await editor.press('Meta+S');

			await expect
				.poll(() => fs.readFileSync(launched.phaseOnePath, 'utf-8'))
				.toBe(shortcutContent);
			await expect(launched.window.getByText('Unsaved changes')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test('inserts a tab character in the Codex lane Auto Run editor', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);
			await launched.window.getByTitle('Edit document').click();
			const editor = launched.window.getByPlaceholder(/Capture notes/);

			await editor.fill('Codex tab sentinel');
			await editor.press('Tab');

			await expect(editor).toHaveValue('Codex tab sentinel\t');
			await expect(launched.window.getByText('Unsaved changes')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('inserts a Codex lane checkbox with the Auto Run editor shortcut', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);
			await launched.window.getByTitle('Edit document').click();
			const editor = launched.window.getByPlaceholder(/Capture notes/);

			await editor.fill('Prepare Codex lane task');
			await editor.press('Meta+L');

			await expect(editor).toHaveValue('Prepare Codex lane task\n- [ ] ');
			await expect(launched.window.getByText('Unsaved changes')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('continues a Codex lane task list from the Auto Run editor keyboard', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);
			await launched.window.getByTitle('Edit document').click();
			const editor = launched.window.getByPlaceholder(/Capture notes/);

			await editor.fill('- [ ] First Codex lane task');
			await editor.press('Enter');

			await expect(editor).toHaveValue('- [ ] First Codex lane task\n- [ ] ');
			await expect(launched.window.getByText('Unsaved changes')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('filters Codex lane Auto Run template variable suggestions from editor input', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);
			await launched.window.getByTitle('Edit document').click();
			const editor = launched.window.getByPlaceholder(/Capture notes/);

			await editor.fill('Codex template filter ');
			await editor.type('{{doc');

			await expect(launched.window.getByText('{{DOCUMENT_NAME}}', { exact: true })).toBeVisible();
			await expect(launched.window.getByText('{{DOCUMENT_PATH}}', { exact: true })).toBeVisible();
			await expect(launched.window.getByText('{{AGENT_NAME}}', { exact: true })).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test('inserts the first Codex lane Auto Run template variable with Enter', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);
			await launched.window.getByTitle('Edit document').click();
			const editor = launched.window.getByPlaceholder(/Capture notes/);

			await editor.fill('Codex template enter ');
			await editor.type('{{');
			await expect(launched.window.getByText('{{AGENT_GROUP}}', { exact: true })).toBeVisible();
			await editor.press('Enter');

			await expect(editor).toHaveValue('Codex template enter {{AGENT_GROUP}}');
			await expect(launched.window.getByText('{{AGENT_GROUP}}', { exact: true })).toBeHidden();
			await expect(launched.window.getByText('Unsaved changes')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('keeps Codex lane Auto Run template trigger text when autocomplete is dismissed', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);
			await launched.window.getByTitle('Edit document').click();
			const editor = launched.window.getByPlaceholder(/Capture notes/);

			await editor.fill('Codex template escape ');
			await editor.type('{{date');
			await expect(launched.window.getByText('{{DATE}}', { exact: true })).toBeVisible();
			await editor.press('Escape');

			await expect(editor).toHaveValue('Codex template escape {{date');
			await expect(launched.window.getByText('{{DATE}}', { exact: true })).toBeHidden();
			await expect(launched.window.getByText('Unsaved changes')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('selects a Codex lane Auto Run template variable with the pointer', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);
			await launched.window.getByTitle('Edit document').click();
			const editor = launched.window.getByPlaceholder(/Capture notes/);

			await editor.fill('Codex template click ');
			await editor.type('{{agent_na');
			await launched.window.getByText('{{AGENT_NAME}}', { exact: true }).click();

			await expect(editor).toHaveValue('Codex template click {{AGENT_NAME}}');
			await expect(launched.window.getByText('{{AGENT_NAME}}', { exact: true })).toBeHidden();
			await expect(launched.window.getByText('Unsaved changes')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('uses Tab to accept a filtered Codex lane Auto Run template variable', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);
			await launched.window.getByTitle('Edit document').click();
			const editor = launched.window.getByPlaceholder(/Capture notes/);

			await editor.fill('Codex template tab ');
			await editor.type('{{maestro');
			await expect(
				launched.window.getByText('{{MAESTRO_CLI_PATH}}', { exact: true })
			).toBeVisible();
			await editor.press('Tab');

			await expect(editor).toHaveValue('Codex template tab {{MAESTRO_CLI_PATH}}');
			await expect(launched.window.getByText('{{MAESTRO_CLI_PATH}}', { exact: true })).toBeHidden();
			await expect(launched.window.getByText('Unsaved changes')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('undoes a typed Codex lane Auto Run editor draft with the keyboard shortcut', async () => {
		const launched = await launchLaneWorkbench();
		const draftContent = `${launched.phaseOneContent}\nCodex undo draft sentinel.\n`;
		try {
			await openAutoRunPanel(launched.window);
			await launched.window.getByTitle('Edit document').click();
			const editor = launched.window.getByPlaceholder(/Capture notes/);

			await editor.fill(draftContent);
			await expect(launched.window.getByText('Unsaved changes')).toBeVisible();
			await editor.press('Meta+Z');

			await expect(editor).toHaveValue(launched.phaseOneContent);
			await expect(launched.window.getByText('Unsaved changes')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test('redoes a Codex lane Auto Run editor draft after keyboard undo', async () => {
		const launched = await launchLaneWorkbench();
		const draftContent = `${launched.phaseOneContent}\nCodex redo draft sentinel.\n`;
		try {
			await openAutoRunPanel(launched.window);
			await launched.window.getByTitle('Edit document').click();
			const editor = launched.window.getByPlaceholder(/Capture notes/);

			await editor.fill(draftContent);
			await expect(launched.window.getByText('Unsaved changes')).toBeVisible();
			await editor.press('Meta+Z');
			await expect(editor).toHaveValue(launched.phaseOneContent);
			await editor.press('Meta+Shift+Z');

			await expect(editor).toHaveValue(draftContent);
			await expect(launched.window.getByText('Unsaved changes')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('clears Codex lane Auto Run redo history after a new editor draft', async () => {
		const launched = await launchLaneWorkbench();
		const firstDraft = `${launched.phaseOneContent}\nCodex first redo sentinel.\n`;
		const secondDraft = `${launched.phaseOneContent}\nCodex second redo sentinel.\n`;
		try {
			await openAutoRunPanel(launched.window);
			await launched.window.getByTitle('Edit document').click();
			const editor = launched.window.getByPlaceholder(/Capture notes/);

			await editor.fill(firstDraft);
			await expect(launched.window.getByText('Unsaved changes')).toBeVisible();
			await editor.press('Meta+Z');
			await expect(editor).toHaveValue(launched.phaseOneContent);

			await editor.fill(secondDraft);
			await expect(launched.window.getByText('Unsaved changes')).toBeVisible();
			await editor.press('Meta+Shift+Z');

			await expect(editor).toHaveValue(secondDraft);
			await expect(editor).not.toHaveValue(firstDraft);
		} finally {
			await launched.cleanup();
		}
	});

	test('undoes Codex lane Auto Run checkbox shortcut insertion', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);
			await launched.window.getByTitle('Edit document').click();
			const editor = launched.window.getByPlaceholder(/Capture notes/);

			await editor.fill('Prepare Codex undo checkbox');
			await expect(editor).toHaveValue('Prepare Codex undo checkbox');
			await editor.press('Meta+L');
			await expect(editor).toHaveValue('Prepare Codex undo checkbox\n- [ ] ');
			await editor.press('Meta+Z');

			await expect(editor).toHaveValue('Prepare Codex undo checkbox');
		} finally {
			await launched.cleanup();
		}
	});

	test('undoes Codex lane Auto Run ordered-list continuation', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);
			await launched.window.getByTitle('Edit document').click();
			const editor = launched.window.getByPlaceholder(/Capture notes/);

			await editor.fill('1. First Codex ordered item');
			await expect(editor).toHaveValue('1. First Codex ordered item');
			await editor.press('Enter');
			await expect(editor).toHaveValue('1. First Codex ordered item\n2. ');
			await editor.press('Meta+Z');

			await expect(editor).toHaveValue('1. First Codex ordered item');
		} finally {
			await launched.cleanup();
		}
	});

	test('navigates Codex lane Auto Run search matches with toolbar buttons', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);
			await launched.window.getByTitle('Edit document').click();
			const editor = launched.window.getByPlaceholder(/Capture notes/);

			await editor.fill('needle one\nneedle two\nneedle three');
			await editor.press('Control+f');
			const searchInput = launched.window.getByPlaceholder('Search...');
			await searchInput.fill('needle');
			await expect(launched.window.getByText('1/3')).toBeVisible();

			await launched.window.getByTitle('Next match (Enter)').click();
			await expect(launched.window.getByText('2/3')).toBeVisible();
			await launched.window.getByTitle('Previous match (Shift+Enter)').click();
			await expect(launched.window.getByText('1/3')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('wraps Codex lane Auto Run search forward with Enter', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);
			await launched.window.getByTitle('Edit document').click();
			const editor = launched.window.getByPlaceholder(/Capture notes/);

			await editor.fill('forward wrap sentinel\nforward wrap sentinel');
			await editor.press('Control+f');
			const searchInput = launched.window.getByPlaceholder('Search...');
			await searchInput.fill('forward');
			await expect(launched.window.getByText('1/2')).toBeVisible();

			await searchInput.press('Enter');
			await expect(launched.window.getByText('2/2')).toBeVisible();
			await searchInput.press('Enter');
			await expect(launched.window.getByText('1/2')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('wraps Codex lane Auto Run search backward with Shift Enter', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);
			await launched.window.getByTitle('Edit document').click();
			const editor = launched.window.getByPlaceholder(/Capture notes/);

			await editor.fill('backward wrap sentinel\nbackward wrap sentinel');
			await editor.press('Control+f');
			const searchInput = launched.window.getByPlaceholder('Search...');
			await searchInput.fill('backward');
			await expect(launched.window.getByText('1/2')).toBeVisible();

			await searchInput.press('Shift+Enter');
			await expect(launched.window.getByText('2/2')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('closes Codex lane Auto Run search with Escape and refocuses the editor', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);
			await launched.window.getByTitle('Edit document').click();
			const editor = launched.window.getByPlaceholder(/Capture notes/);

			await editor.fill('Codex search escape focus sentinel');
			await editor.press('Control+f');
			const searchInput = launched.window.getByPlaceholder('Search...');
			await searchInput.fill('sentinel');
			await expect(launched.window.getByText('1/1')).toBeVisible();
			await searchInput.press('Escape');

			await expect(searchInput).toBeHidden();
			await expect(editor).toBeFocused();
		} finally {
			await launched.cleanup();
		}
	});

	test('updates Codex lane Auto Run search results when editor content changes', async () => {
		const launched = await launchLaneWorkbench();
		try {
			await openAutoRunPanel(launched.window);
			await launched.window.getByTitle('Edit document').click();
			const editor = launched.window.getByPlaceholder(/Capture notes/);

			await editor.fill('No live match yet');
			await editor.press('Control+f');
			const searchInput = launched.window.getByPlaceholder('Search...');
			await searchInput.fill('live-match-sentinel');
			await expect(launched.window.getByText('No matches')).toBeVisible();

			await editor.fill('Now live-match-sentinel exists in the Codex lane editor');
			await expect(launched.window.getByText('1/1')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});
});
