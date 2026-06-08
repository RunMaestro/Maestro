/**
 * E2E Tests: Git, Group Chat, Playbooks, Spec Kit, and OpenSpec tranches.
 *
 * These scenarios use local git fixtures and IPC stubs only. They do not call
 * live GitHub, marketplace, provider, or network-backed services.
 */
import { test, expect, helpers } from './fixtures/electron-app';
import type { ElectronApplication, Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const secondTrancheActiveScenarioMatrix = [
	{ id: 'GGP-A06', title: 'shows Git Log IPC errors without closing the viewer' },
	{ id: 'GGP-A07', title: 'shows the empty Git Log state for repositories without commits' },
	{ id: 'GGP-A08', title: 'recovers Playbook Exchange after a manifest load failure' },
	{ id: 'GGP-A09', title: 'shows Playbook Exchange empty-manifest state' },
	{ id: 'GGP-A10', title: 'shows marketplace README and document fallback previews' },
	{ id: 'GGP-A11', title: 'shows bundled command empty states after failed IPC loads' },
] as const;

const secondTrancheSkippedScenarioMatrix = [
	{
		id: 'GGP-S01',
		title: 'creates a real GitHub pull request from an authenticated worktree',
		reason:
			'Env-gated: requires MAESTRO_E2E_REAL_GITHUB plus authenticated gh state and must not run in deterministic authoring.',
	},
	{
		id: 'GGP-S02',
		title: 'publishes a real GitHub Gist and verifies the external URL',
		reason:
			'Env-gated: requires MAESTRO_E2E_REAL_GITHUB_GIST plus authenticated gh state and live network.',
	},
	{
		id: 'GGP-S03',
		title: 'refreshes the live marketplace manifest from GitHub',
		reason:
			'Env-gated: requires MAESTRO_E2E_REAL_MARKETPLACE_NETWORK and should not run during no-network deterministic authoring.',
	},
] as const;

const thirdTrancheActiveScenarioMatrix = [
	{ id: 'GGP-A12', title: 'shows worktree Create Pull Request in Quick Actions' },
	{ id: 'GGP-A13', title: 'shows GitHub CLI auth guidance in Create Pull Request' },
	{ id: 'GGP-A14', title: 'creates a stubbed pull request from a worktree child' },
	{ id: 'GGP-A15', title: 'validates quick worktree branch names before creation' },
	{ id: 'GGP-A16', title: 'imports a marketplace playbook into Auto Run with IPC stubs' },
	{ id: 'GGP-A17', title: 'edits and resets a Spec Kit command prompt' },
	{ id: 'GGP-A18', title: 'edits and resets an OpenSpec command prompt' },
] as const;

const thirdTrancheSkippedScenarioMatrix = [
	{
		id: 'GGP-S04',
		title: 'opens an existing published Gist URL from a real file preview',
		reason:
			'Env-gated: requires authenticated gh state because the file-preview Gist affordance is hidden without gh availability.',
	},
	{
		id: 'GGP-S05',
		title: 'imports a remote marketplace playbook into an SSH Auto Run folder',
		reason: 'Env-gated: requires configured SSH remote state and remote filesystem access.',
	},
] as const;

const fourthTrancheActiveScenarioMatrix = [
	{ id: 'GGP-A19', title: 'renders Git Log commit refs, body, stats, and diff details' },
	{ id: 'GGP-A20', title: 'shows GitHub CLI installation guidance in Create Pull Request' },
	{ id: 'GGP-A21', title: 'keeps Create Pull Request open after a stubbed gh failure' },
	{ id: 'GGP-A22', title: 'filters Playbook Exchange results by category and search text' },
	{ id: 'GGP-A23', title: 'requires a target folder before importing a marketplace playbook' },
	{ id: 'GGP-A24', title: 'refreshes Spec Kit metadata and command prompts from IPC stubs' },
	{ id: 'GGP-A25', title: 'refreshes OpenSpec metadata and command prompts from IPC stubs' },
] as const;

const fourthTrancheSkippedScenarioMatrix = [
	{
		id: 'GGP-S06',
		title: 'verifies live multi-agent group chat fan-in across provider accounts',
		reason:
			'Env-gated: requires real provider accounts, live agent launches, and authenticated account state.',
	},
	{
		id: 'GGP-S07',
		title: 'refreshes Spec Kit and OpenSpec prompts from live GitHub archives',
		reason:
			'Env-gated: requires live GitHub network access and should not run during deterministic authoring.',
	},
] as const;

const fifthTrancheActiveScenarioMatrix = [
	{ id: 'GGP-A26', title: 'changes Create Pull Request target branch before submission' },
	{ id: 'GGP-A27', title: 'cancels Create Pull Request without submitting IPC payload' },
	{ id: 'GGP-A28', title: 'previews marketplace playbook document content' },
	{ id: 'GGP-A29', title: 'records full marketplace import payload details' },
	{ id: 'GGP-A30', title: 'filters Quick Actions to seeded group chat results' },
] as const;

const sixthTrancheActiveScenarioMatrix = [
	{ id: 'GGP-A31', title: 'renders multi-file Git Diff tabs from a stubbed IPC diff' },
	{ id: 'GGP-A32', title: 'shows Group Chat header metadata after Quick Actions navigation' },
	{ id: 'GGP-A33', title: 'lists active Group Chat management commands in Quick Actions' },
	{ id: 'GGP-A34', title: 'shows marketplace loop settings for a category-filtered playbook' },
	{ id: 'GGP-A35', title: 'cancels Spec Kit prompt edits without marking the command modified' },
] as const;

const seventhTrancheActiveScenarioMatrix = [
	{ id: 'GGP-A36', title: 'shows Git Diff empty state from a stubbed IPC diff' },
	{ id: 'GGP-A37', title: 'opens and closes Playbook Exchange help content' },
	{ id: 'GGP-A38', title: 'refreshes Playbook Exchange cache status to live data' },
	{ id: 'GGP-A39', title: 'cancels OpenSpec prompt edits without marking the command modified' },
	{ id: 'GGP-A40', title: 'disables Create Pull Request when the title is cleared' },
] as const;

const eighthTrancheActiveScenarioMatrix = [
	{
		id: 'GGP-A41',
		title: 'shows Create Pull Request branch defaults, generated title, and dirty work warning',
	},
	{ id: 'GGP-A42', title: 'keeps Create Pull Request open after a non-URL gh failure' },
	{ id: 'GGP-A43', title: 'returns Playbook Exchange detail view to the filtered list' },
	{ id: 'GGP-A44', title: 'focuses Playbook Exchange search with the keyboard shortcut' },
	{
		id: 'GGP-A45',
		title: 'switches Playbook Exchange documents with detail-view keyboard shortcuts',
	},
] as const;

function runGit(cwd: string, args: string[]) {
	execFileSync('git', args, {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 'E2E Bot',
			GIT_AUTHOR_EMAIL: 'e2e@example.com',
			GIT_COMMITTER_NAME: 'E2E Bot',
			GIT_COMMITTER_EMAIL: 'e2e@example.com',
		},
		stdio: 'pipe',
	});
}

function createGitGroupChatPlaybooksWorkbench(options: { withWorktreeChild?: boolean } = {}) {
	const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-e2e-git-groupchat-'));
	const projectDir = path.join(homeDir, 'project');
	const worktreesDir = path.join(homeDir, 'worktrees');
	const worktreeBranch = 'feat/git-pr-tranche';
	const worktreeDir = path.join(worktreesDir, 'feat-git-pr-tranche');
	const autoRunFolder = path.join(projectDir, 'Playbooks');
	const now = Date.parse('2026-05-29T12:00:00.000Z');
	const idSuffix = `${now}-${Math.random().toString(36).slice(2)}`;
	const sessionId = `git-groupchat-playbooks-${idSuffix}`;
	const aiTabId = `git-groupchat-playbooks-ai-${idSuffix}`;
	const worktreeAiTabId = `git-groupchat-playbooks-worktree-ai-${idSuffix}`;
	const readmePath = path.join(projectDir, 'README.md');
	const flowPath = path.join(projectDir, 'FLOW.md');
	const phaseOnePath = path.join(autoRunFolder, 'Phase 1.md');
	const aiLogs = [
		{
			id: `git-groupchat-playbooks-log-${idSuffix}`,
			timestamp: now,
			source: 'stdout',
			text: 'Git group chat playbooks seeded transcript sentinel.',
		},
	];

	fs.mkdirSync(autoRunFolder, { recursive: true });
	fs.writeFileSync(readmePath, '# Git Group Chat Playbooks Fixture\n', 'utf-8');
	fs.writeFileSync(flowPath, '# Flow\n\nInitial committed flow.\n', 'utf-8');
	fs.writeFileSync(
		phaseOnePath,
		'# Phase 1\n\n- [ ] Review Git surfaces\n- [x] Seed playbook fixture\n',
		'utf-8'
	);
	runGit(projectDir, ['init']);
	runGit(projectDir, ['add', '.']);
	runGit(projectDir, ['commit', '-m', 'chore: seed git group chat playbook fixture']);
	if (options.withWorktreeChild) {
		fs.mkdirSync(worktreesDir, { recursive: true });
		runGit(projectDir, ['worktree', 'add', '-b', worktreeBranch, worktreeDir]);
	}
	fs.appendFileSync(readmePath, '\nWorking tree diff sentinel for git lane.\n', 'utf-8');
	fs.writeFileSync(
		path.join(projectDir, 'NOTES.md'),
		'# Notes\n\nUntracked git lane note sentinel.\n',
		'utf-8'
	);

	const parentSession = {
		id: sessionId,
		name: 'Git Group Chat Playbooks Agent',
		toolType: 'codex',
		state: 'idle',
		cwd: projectDir,
		fullPath: projectDir,
		projectRoot: projectDir,
		createdAt: now,
		aiLogs,
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
		gitBranches: ['main', worktreeBranch],
		worktreeConfig: { basePath: worktreesDir, watchEnabled: false },
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		executionQueue: [],
		activeTimeMs: 0,
		fileTreeAutoRefreshInterval: 180,
		aiTabs: [
			{
				id: aiTabId,
				agentSessionId: 'codex-git-groupchat-playbooks-tab',
				name: 'Main',
				starred: false,
				logs: aiLogs,
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
		autoRunContent: fs.readFileSync(phaseOnePath, 'utf-8'),
		autoRunContentVersion: 1,
		autoRunMode: 'preview',
		autoRunEditScrollPos: 0,
		autoRunPreviewScrollPos: 0,
		autoRunCursorPosition: 0,
	};
	const sessions = options.withWorktreeChild
		? [
				{
					...parentSession,
					id: `git-groupchat-playbooks-worktree-${idSuffix}`,
					name: worktreeBranch,
					cwd: worktreeDir,
					fullPath: worktreeDir,
					projectRoot: worktreeDir,
					parentSessionId: sessionId,
					worktreeBranch,
					worktreeConfig: undefined,
					aiTabs: [
						{
							id: worktreeAiTabId,
							agentSessionId: 'codex-git-groupchat-playbooks-worktree-tab',
							name: 'Main',
							starred: false,
							logs: aiLogs,
							inputValue: '',
							stagedImages: [],
							createdAt: now,
							state: 'idle',
						},
					],
					activeTabId: worktreeAiTabId,
					unifiedTabOrder: [{ type: 'ai', id: worktreeAiTabId }],
					autoRunFolderPath: path.join(worktreeDir, 'Playbooks'),
					autoRunContent: fs.readFileSync(
						path.join(worktreeDir, 'Playbooks', 'Phase 1.md'),
						'utf-8'
					),
				},
				parentSession,
			]
		: [parentSession];

	return {
		homeDir,
		projectDir,
		worktreeBranch,
		sessions,
		groupChats: [
			{
				id: `git-groupchat-room-${idSuffix}`,
				name: 'Git Lane Room',
				createdAt: now,
				updatedAt: now,
				moderatorAgentId: sessionId,
				moderatorSessionId: sessionId,
				participants: [{ id: sessionId, name: 'Git Group Chat Playbooks Agent' }],
				messages: [
					{
						timestamp: new Date(now).toISOString(),
						from: 'moderator',
						content: 'Seeded group chat message for git lane.',
					},
				],
			},
		],
	};
}

async function launchGitGroupChatPlaybooksWorkbench(options: { withWorktreeChild?: boolean } = {}) {
	const seeded = createGitGroupChatPlaybooksWorkbench(options);
	const launched = await helpers.launchAppWithState({
		homeDir: seeded.homeDir,
		sessions: seeded.sessions,
		groupChats: seeded.groupChats,
	});

	return { ...seeded, ...launched };
}

function modalRootByHeading(page: Page, heading: string) {
	return page
		.getByText(heading, { exact: true })
		.locator('xpath=ancestor::div[contains(@class, "fixed")][1]');
}

async function openSessionContextMenu(page: Page, sessionName: string, expectedAction: string) {
	const sessionList = page.locator('[data-tour="session-list"]');
	await sessionList.getByText(sessionName, { exact: true }).first().click({ button: 'right' });
	const contextMenu = page
		.locator('.fixed')
		.filter({
			has: page.getByRole('button', { name: expectedAction, exact: true }),
		})
		.last();
	await expect(
		contextMenu.getByRole('button', { name: expectedAction, exact: true })
	).toBeVisible();
	return contextMenu;
}

async function activateSession(page: Page, sessionName: string) {
	await page.locator('[data-tour="session-list"]').getByText(sessionName, { exact: true }).click();
}

async function openQuickActions(page: Page) {
	const quickActionsDialog = page.getByRole('dialog', { name: 'Quick Actions' });
	for (let attempt = 0; attempt < 3; attempt++) {
		if (await quickActionsDialog.isVisible().catch(() => false)) break;
		await page.bringToFront();
		await page.keyboard.press('Meta+K');
		await quickActionsDialog.waitFor({ state: 'visible', timeout: 1000 }).catch(() => undefined);
	}
	await expect(quickActionsDialog).toBeVisible();
	await expect(
		quickActionsDialog.getByPlaceholder('Type a command or jump to agent...')
	).toBeVisible();
	return quickActionsDialog;
}

async function openGitDiffFromQuickActions(page: Page) {
	const quickActionsDialog = await openQuickActions(page);
	await quickActionsDialog.getByPlaceholder('Type a command or jump to agent...').fill('Git Diff');
	await quickActionsDialog.getByRole('button', { name: /View Git Diff/ }).click();

	await expect(quickActionsDialog).toBeHidden();
	const gitDiffDialog = page.getByRole('dialog', { name: 'Git Diff Preview' });
	await expect(gitDiffDialog).toBeVisible();
	return gitDiffDialog;
}

async function openGitLogFromQuickActions(page: Page) {
	const quickActionsDialog = await openQuickActions(page);
	await quickActionsDialog.getByPlaceholder('Type a command or jump to agent...').fill('Git Log');
	await quickActionsDialog.getByRole('button', { name: /View Git Log/ }).click();

	await expect(quickActionsDialog).toBeHidden();
	const gitLogDialog = page.getByRole('dialog', { name: 'Git Log Viewer' });
	await expect(gitLogDialog).toBeVisible();
	return gitLogDialog;
}

async function openPlaybookExchangeFromQuickActions(page: Page) {
	const quickActionsDialog = await openQuickActions(page);
	await quickActionsDialog
		.getByPlaceholder('Type a command or jump to agent...')
		.fill('Playbook Exchange');
	await quickActionsDialog.getByRole('button', { name: /Playbook Exchange/ }).click();

	await expect(quickActionsDialog).toBeHidden();
	const marketplaceDialog = page.getByRole('dialog', { name: 'Playbook Exchange' });
	await expect(marketplaceDialog).toBeVisible();
	return marketplaceDialog;
}

async function openSettings(page: Page) {
	const quickActionsDialog = await openQuickActions(page);
	await quickActionsDialog.getByPlaceholder('Type a command or jump to agent...').fill('Settings');
	await quickActionsDialog.getByRole('button', { name: /^Settings$/ }).click();

	await expect(quickActionsDialog).toBeHidden();
	const settingsDialog = page.getByRole('dialog', { name: 'Settings' });
	await expect(settingsDialog).toBeVisible();
	return settingsDialog;
}

function commandPanelByHeading(page: Page, heading: string) {
	return page
		.getByText(heading, { exact: true })
		.locator('xpath=ancestor::div[contains(@class, "space-y-4")][1]');
}

async function stubMultiFileGitDiffState(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		ipcMain.removeHandler('git:diff');
		ipcMain.handle('git:diff', async () => ({
			stdout: [
				'diff --git a/README.md b/README.md',
				'index 1111111..2222222 100644',
				'--- a/README.md',
				'+++ b/README.md',
				'@@ -1 +1,2 @@',
				' # Git Group Chat Playbooks Fixture',
				'+Readme diff tab sentinel.',
				'',
				'diff --git a/FLOW.md b/FLOW.md',
				'index 3333333..4444444 100644',
				'--- a/FLOW.md',
				'+++ b/FLOW.md',
				'@@ -1,3 +1,4 @@',
				' # Flow',
				'',
				' Initial committed flow.',
				'+Flow diff tab sentinel.',
			].join('\n'),
			stderr: '',
		}));
	});
}

async function stubEmptyGitDiffState(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		ipcMain.removeHandler('git:diff');
		ipcMain.handle('git:diff', async () => ({
			stdout: '',
			stderr: '',
		}));
	});
}

async function stubDetailedGitLogState(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		ipcMain.removeHandler('git:log');
		ipcMain.handle('git:log', async () => ({
			entries: [
				{
					hash: 'abcdef1234567890abcdef1234567890abcdef12',
					shortHash: 'abcdef1',
					author: 'E2E Bot',
					date: '2026-05-29T12:00:00.000Z',
					refs: ['HEAD -> main', 'tag: v-e2e'],
					subject: 'feat: seed detailed git log',
					additions: 1,
					deletions: 1,
				},
			],
			error: null,
		}));
		ipcMain.removeHandler('git:commitCount');
		ipcMain.handle('git:commitCount', async () => ({ count: 3, error: null }));
		ipcMain.removeHandler('git:show');
		ipcMain.handle('git:show', async () => ({
			stdout: [
				'commit abcdef1234567890abcdef1234567890abcdef12',
				'Author: E2E Bot <e2e@example.com>',
				'Date:   Fri May 29 12:00:00 2026 +0000',
				'',
				'    feat: seed detailed git log',
				'',
				'    Body sentinel for detailed git log coverage.',
				'',
				'---',
				' README.md | 2 +-',
				' 1 file changed, 1 insertion(+), 1 deletion(-)',
				'',
				'diff --git a/README.md b/README.md',
				'index 1111111..2222222 100644',
				'--- a/README.md',
				'+++ b/README.md',
				'@@ -1 +1 @@',
				'-Old git log line',
				'+New git log sentinel',
			].join('\n'),
			stderr: '',
		}));
	});
}

async function stubGitLogState(
	electronApp: ElectronApplication,
	state: { mode: 'error' | 'empty' }
) {
	await electronApp.evaluate(({ ipcMain }, options: { mode: 'error' | 'empty' }) => {
		ipcMain.removeHandler('git:log');
		ipcMain.handle('git:log', async () =>
			options.mode === 'error'
				? {
						entries: [],
						error: 'E2E git log unavailable for fallback coverage',
					}
				: { entries: [] }
		);
		ipcMain.removeHandler('git:commitCount');
		ipcMain.handle('git:commitCount', async () => ({ count: 0 }));
		ipcMain.removeHandler('git:show');
		ipcMain.handle('git:show', async () => ({ stdout: '' }));
	}, state);
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
			ipcMain.removeHandler('git:status');
			ipcMain.handle('git:status', async () => ({ stdout: ' M README.md\n' }));
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

async function stubMarketplaceForPlaybookExchange(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eMarketplaceImport?: {
				playbookId: string;
				targetFolderName: string;
				autoRunFolderPath: string;
				sessionId: string;
				sshRemoteId?: string;
			} | null;
		};
		state.__maestroE2eMarketplaceImport = null;
		const manifest = {
			lastUpdated: '2026-05-29',
			playbooks: [
				{
					id: 'git-lane-review',
					title: 'Git Lane Review',
					description: 'Review Git, Group Chat, and Playbook lane output.',
					category: 'Engineering',
					author: 'RunMaestro',
					tags: ['git', 'review'],
					lastUpdated: '2026-05-29',
					path: 'engineering/git-lane-review',
					documents: [{ filename: 'review-plan', resetOnCompletion: true }],
					loopEnabled: false,
					maxLoops: null,
					prompt: null,
					source: 'local',
				},
			],
		};

		ipcMain.removeHandler('marketplace:getManifest');
		ipcMain.handle('marketplace:getManifest', async () => ({
			success: true,
			manifest,
			fromCache: true,
			cacheAge: 60_000,
		}));
		ipcMain.removeHandler('marketplace:getReadme');
		ipcMain.handle('marketplace:getReadme', async () => ({
			success: true,
			content: '# Git Lane Review\n\nUse this playbook to review lane output.',
		}));
		ipcMain.removeHandler('marketplace:getDocument');
		ipcMain.handle('marketplace:getDocument', async () => ({
			success: true,
			content: '# Review Plan\n\nReview plan body for the git lane.',
		}));
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
				state.__maestroE2eMarketplaceImport = {
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

async function getStubbedMarketplaceImport(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eMarketplaceImport?: {
				playbookId: string;
				targetFolderName: string;
				autoRunFolderPath: string;
				sessionId: string;
				sshRemoteId?: string;
			} | null;
		};
		return state.__maestroE2eMarketplaceImport ?? null;
	});
}

async function stubMarketplaceManifestFailureThenRecovery(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		const manifest = {
			lastUpdated: '2026-05-29',
			playbooks: [
				{
					id: 'recovered-git-lane-review',
					title: 'Recovered Git Lane Review',
					description: 'Recovered marketplace data after deterministic manifest failure.',
					category: 'Engineering',
					author: 'RunMaestro',
					tags: ['git', 'recovery'],
					lastUpdated: '2026-05-29',
					path: 'engineering/recovered-git-lane-review',
					documents: [],
					loopEnabled: false,
					maxLoops: null,
					prompt: null,
					source: 'local',
				},
			],
		};

		ipcMain.removeHandler('marketplace:getManifest');
		ipcMain.handle('marketplace:getManifest', async () => ({
			success: false,
			error: 'E2E marketplace manifest unavailable',
		}));
		ipcMain.removeHandler('marketplace:refreshManifest');
		ipcMain.handle('marketplace:refreshManifest', async () => ({
			success: true,
			manifest,
			fromCache: false,
			cacheAge: 0,
		}));
		ipcMain.removeHandler('marketplace:getReadme');
		ipcMain.handle('marketplace:getReadme', async () => ({
			success: true,
			content: '# Recovered Git Lane Review\n',
		}));
		ipcMain.removeHandler('marketplace:getDocument');
		ipcMain.handle('marketplace:getDocument', async () => ({
			success: true,
			content: null,
		}));
	});
}

async function stubEmptyMarketplaceManifest(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		const manifest = {
			lastUpdated: '2026-05-29',
			playbooks: [],
		};

		ipcMain.removeHandler('marketplace:getManifest');
		ipcMain.handle('marketplace:getManifest', async () => ({
			success: true,
			manifest,
			fromCache: true,
			cacheAge: 30_000,
		}));
		ipcMain.removeHandler('marketplace:refreshManifest');
		ipcMain.handle('marketplace:refreshManifest', async () => ({
			success: true,
			manifest,
			fromCache: false,
			cacheAge: 0,
		}));
	});
}

async function stubMarketplaceFilteringState(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		const manifest = {
			lastUpdated: '2026-05-29',
			playbooks: [
				{
					id: 'git-release-review',
					title: 'Git Release Review',
					description: 'Review branch diffs before release.',
					category: 'Engineering',
					author: 'RunMaestro',
					tags: ['git', 'release'],
					lastUpdated: '2026-05-29',
					path: 'engineering/git-release-review',
					documents: [],
					loopEnabled: false,
					maxLoops: null,
					prompt: null,
					source: 'local',
				},
				{
					id: 'openspec-proposal-review',
					title: 'OpenSpec Proposal Review',
					description: 'Validate openspec proposal coverage.',
					category: 'QA',
					author: 'RunMaestro',
					tags: ['openspec', 'proposal'],
					lastUpdated: '2026-05-29',
					path: 'qa/openspec-proposal-review',
					documents: [],
					loopEnabled: false,
					maxLoops: null,
					prompt: null,
					source: 'local',
				},
				{
					id: 'group-chat-briefing',
					title: 'Group Chat Briefing',
					description: 'Coordinate seeded group chat review handoff.',
					category: 'Collaboration',
					author: 'RunMaestro',
					tags: ['group-chat', 'handoff'],
					lastUpdated: '2026-05-29',
					path: 'collaboration/group-chat-briefing',
					documents: [],
					loopEnabled: true,
					maxLoops: 2,
					prompt: null,
					source: 'local',
				},
			],
		};

		ipcMain.removeHandler('marketplace:getManifest');
		ipcMain.handle('marketplace:getManifest', async () => ({
			success: true,
			manifest,
			fromCache: true,
			cacheAge: 90_000,
		}));
		ipcMain.removeHandler('marketplace:refreshManifest');
		ipcMain.handle('marketplace:refreshManifest', async () => ({
			success: true,
			manifest,
			fromCache: false,
			cacheAge: 0,
		}));
		ipcMain.removeHandler('marketplace:getReadme');
		ipcMain.handle('marketplace:getReadme', async () => ({
			success: true,
			content: '# Filtered Playbook\n',
		}));
		ipcMain.removeHandler('marketplace:getDocument');
		ipcMain.handle('marketplace:getDocument', async () => ({
			success: true,
			content: null,
		}));
	});
}

async function stubMarketplaceMissingDocuments(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		const manifest = {
			lastUpdated: '2026-05-29',
			playbooks: [
				{
					id: 'missing-docs-git-review',
					title: 'Missing Docs Git Review',
					description: 'Exercises marketplace preview fallbacks.',
					category: 'Engineering',
					author: 'RunMaestro',
					tags: ['git', 'fallback'],
					lastUpdated: '2026-05-29',
					path: 'engineering/missing-docs-git-review',
					documents: [{ filename: 'missing-doc', resetOnCompletion: false }],
					loopEnabled: false,
					maxLoops: null,
					prompt: null,
					source: 'local',
				},
			],
		};

		ipcMain.removeHandler('marketplace:getManifest');
		ipcMain.handle('marketplace:getManifest', async () => ({
			success: true,
			manifest,
			fromCache: true,
			cacheAge: 45_000,
		}));
		ipcMain.removeHandler('marketplace:getReadme');
		ipcMain.handle('marketplace:getReadme', async () => ({
			success: true,
			content: null,
		}));
		ipcMain.removeHandler('marketplace:getDocument');
		ipcMain.handle('marketplace:getDocument', async () => ({
			success: false,
			error: 'E2E marketplace document missing',
		}));
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
		const specKitDefaultPrompt = 'Bundled specify prompt for {{CWD}}.';
		const openSpecDefaultPrompt = 'Bundled proposal prompt for {{AGENT_NAME}}.';
		let specKitPrompt = specKitDefaultPrompt;
		let specKitModified = false;
		let openSpecPrompt = openSpecDefaultPrompt;
		let openSpecModified = false;
		ipcMain.removeHandler('speckit:getMetadata');
		ipcMain.handle('speckit:getMetadata', async () => ({
			success: true,
			metadata: makeMetadata('v1.2.3', 'https://github.com/github/spec-kit'),
		}));
		ipcMain.removeHandler('speckit:getPrompts');
		ipcMain.handle('speckit:getPrompts', async () => ({
			success: true,
			commands: [
				{
					id: 'specify',
					command: '/speckit.specify',
					description: 'Create a new product specification.',
					prompt: specKitPrompt,
					isCustom: false,
					isModified: specKitModified,
				},
			],
		}));
		ipcMain.removeHandler('speckit:savePrompt');
		ipcMain.handle('speckit:savePrompt', async (_event, _id: string, content: string) => {
			specKitPrompt = content;
			specKitModified = true;
			return { success: true };
		});
		ipcMain.removeHandler('speckit:resetPrompt');
		ipcMain.handle('speckit:resetPrompt', async () => {
			specKitPrompt = specKitDefaultPrompt;
			specKitModified = false;
			return { success: true, prompt: specKitDefaultPrompt };
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
		ipcMain.handle('openspec:getPrompts', async () => ({
			success: true,
			commands: [
				{
					id: 'proposal',
					command: '/openspec.proposal',
					description: 'Draft a structured change proposal.',
					prompt: openSpecPrompt,
					isCustom: false,
					isModified: openSpecModified,
				},
			],
		}));
		ipcMain.removeHandler('openspec:savePrompt');
		ipcMain.handle('openspec:savePrompt', async (_event, _id: string, content: string) => {
			openSpecPrompt = content;
			openSpecModified = true;
			return { success: true };
		});
		ipcMain.removeHandler('openspec:resetPrompt');
		ipcMain.handle('openspec:resetPrompt', async () => {
			openSpecPrompt = openSpecDefaultPrompt;
			openSpecModified = false;
			return { success: true, prompt: openSpecDefaultPrompt };
		});
		ipcMain.removeHandler('openspec:refresh');
		ipcMain.handle('openspec:refresh', async () => ({
			success: true,
			metadata: makeMetadata('v2.0.2', 'https://github.com/Fission-AI/OpenSpec'),
		}));
	});
}

async function stubBundledCommandLoadFailures(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		ipcMain.removeHandler('speckit:getMetadata');
		ipcMain.handle('speckit:getMetadata', async () => ({
			success: false,
			error: 'E2E Spec Kit metadata unavailable',
		}));
		ipcMain.removeHandler('speckit:getPrompts');
		ipcMain.handle('speckit:getPrompts', async () => ({
			success: false,
			error: 'E2E Spec Kit prompts unavailable',
		}));
		ipcMain.removeHandler('openspec:getMetadata');
		ipcMain.handle('openspec:getMetadata', async () => ({
			success: false,
			error: 'E2E OpenSpec metadata unavailable',
		}));
		ipcMain.removeHandler('openspec:getPrompts');
		ipcMain.handle('openspec:getPrompts', async () => ({
			success: false,
			error: 'E2E OpenSpec prompts unavailable',
		}));
	});
}

test.describe('Git, Group Chat, and Playbooks deterministic tranches', () => {
	test('surfaces Git commands for the active local repository', async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog.getByPlaceholder('Type a command or jump to agent...').fill('Git');

			await expect(quickActionsDialog.getByRole('button', { name: /View Git Diff/ })).toBeVisible();
			await expect(quickActionsDialog.getByRole('button', { name: /View Git Log/ })).toBeVisible();
			await expect(
				quickActionsDialog.getByRole('button', { name: /Refresh Files, Git, History/ })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('opens Git Diff for deterministic local working tree changes', async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			const gitDiffDialog = await openGitDiffFromQuickActions(launched.window);

			await expect(gitDiffDialog.getByText(/files? changed/)).toBeVisible();
			await expect(gitDiffDialog.getByRole('button', { name: /README\.md/ })).toBeVisible();
			await expect(
				gitDiffDialog.getByText('Working tree diff sentinel for git lane.')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('opens a seeded Group Chat room from Quick Actions', async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Git Lane Room');
			await quickActionsDialog.getByRole('button', { name: /Group Chat: Git Lane Room/ }).click();

			await expect(quickActionsDialog).toBeHidden();
			await expect(
				launched.window.getByRole('button', { name: 'Group Chat: Git Lane Room' })
			).toBeVisible();
			await expect(
				launched.window.getByText('Seeded group chat message for git lane.')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('opens Playbook Exchange with stubbed marketplace data', async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceForPlaybookExchange(launched.electronApp);
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Playbook Exchange');
			await quickActionsDialog.getByRole('button', { name: /Playbook Exchange/ }).click();

			const marketplaceDialog = launched.window.getByRole('dialog', { name: 'Playbook Exchange' });
			await expect(marketplaceDialog).toBeVisible();
			await expect(marketplaceDialog.getByText('Git Lane Review')).toBeVisible();
			await expect(
				marketplaceDialog.getByText('Review Git, Group Chat, and Playbook lane output.')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('renders Spec Kit and OpenSpec command panels from Settings with stubs', async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubSpecKitAndOpenSpecCommands(launched.electronApp);
			const settingsDialog = await openSettings(launched.window);

			await expect(settingsDialog.getByText('Spec Kit Commands')).toBeVisible();
			await expect(settingsDialog.getByText('/speckit.specify')).toBeVisible();
			await expect(settingsDialog.getByText('OpenSpec Commands')).toBeVisible();
			await expect(settingsDialog.getByText('/openspec.proposal')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${secondTrancheActiveScenarioMatrix[0].id}: ${secondTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubGitLogState(launched.electronApp, { mode: 'error' });
			const gitLogDialog = await openGitLogFromQuickActions(launched.window);

			await expect(
				gitLogDialog.getByText('E2E git log unavailable for fallback coverage')
			).toBeVisible();
			await gitLogDialog.getByRole('button', { name: 'Close (Esc)' }).click();
			await expect(gitLogDialog).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${secondTrancheActiveScenarioMatrix[1].id}: ${secondTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubGitLogState(launched.electronApp, { mode: 'empty' });
			const gitLogDialog = await openGitLogFromQuickActions(launched.window);

			await expect(gitLogDialog.getByText('0 commits')).toBeVisible();
			await expect(gitLogDialog.getByText('No commits found')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${secondTrancheActiveScenarioMatrix[2].id}: ${secondTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceManifestFailureThenRecovery(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await expect(marketplaceDialog.getByText('Failed to load marketplace')).toBeVisible();
			await expect(
				marketplaceDialog.getByText('E2E marketplace manifest unavailable')
			).toBeVisible();
			await marketplaceDialog.getByRole('button', { name: 'Try Again' }).click();
			await expect(marketplaceDialog.getByText('Recovered Git Lane Review')).toBeVisible();
			await expect(marketplaceDialog.getByText('Failed to load marketplace')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${secondTrancheActiveScenarioMatrix[3].id}: ${secondTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubEmptyMarketplaceManifest(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await expect(marketplaceDialog.getByText('No playbooks available')).toBeVisible();
			await expect(marketplaceDialog.getByText('Check back later for new playbooks')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${secondTrancheActiveScenarioMatrix[4].id}: ${secondTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceMissingDocuments(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await marketplaceDialog.getByRole('button', { name: /Missing Docs Git Review/ }).click();
			await expect(marketplaceDialog.getByText('No README available')).toBeVisible();
			await marketplaceDialog.getByRole('button', { name: 'README.md' }).click();
			await marketplaceDialog.getByRole('button', { name: 'missing-doc.md' }).click();
			await expect(marketplaceDialog.getByText('Document not found')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${secondTrancheActiveScenarioMatrix[5].id}: ${secondTrancheActiveScenarioMatrix[5].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubBundledCommandLoadFailures(launched.electronApp);
			const settingsDialog = await openSettings(launched.window);

			await expect(settingsDialog.getByText('Spec Kit Commands')).toBeVisible();
			await expect(settingsDialog.getByText('No spec-kit commands loaded')).toBeVisible();
			await expect(settingsDialog.getByText('OpenSpec Commands')).toBeVisible();
			await expect(settingsDialog.getByText('No OpenSpec commands loaded')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirdTrancheActiveScenarioMatrix[0].id}: ${thirdTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withWorktreeChild: true });
		try {
			await activateSession(launched.window, launched.worktreeBranch);
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Create Pull Request');

			await expect(
				quickActionsDialog.getByRole('button', {
					name: new RegExp(`Create Pull Request: ${launched.worktreeBranch}`),
				})
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirdTrancheActiveScenarioMatrix[1].id}: ${thirdTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withWorktreeChild: true });
		try {
			await stubPullRequestCreation(
				launched.electronApp,
				{ installed: true, authenticated: false },
				{ success: false, error: 'not authenticated' }
			);
			await activateSession(launched.window, launched.worktreeBranch);
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Create Pull Request');
			await quickActionsDialog.getByRole('button', { name: /Create Pull Request/ }).click();

			const prModal = modalRootByHeading(launched.window, 'Create Pull Request');
			await expect(prModal.getByText('GitHub CLI not authenticated')).toBeVisible();
			await expect(prModal.getByText('gh auth login')).toBeVisible();
			await expect(prModal.getByRole('button', { name: 'Create PR' })).toBeDisabled();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirdTrancheActiveScenarioMatrix[2].id}: ${thirdTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withWorktreeChild: true });
		try {
			await stubPullRequestCreation(
				launched.electronApp,
				{ installed: true, authenticated: true },
				{ success: true, prUrl: 'https://github.com/RunMaestro/Maestro/pull/118' }
			);
			await activateSession(launched.window, launched.worktreeBranch);
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Create Pull Request');
			await quickActionsDialog.getByRole('button', { name: /Create Pull Request/ }).click();

			const prModal = modalRootByHeading(launched.window, 'Create Pull Request');
			await expect(prModal.getByText(launched.worktreeBranch).first()).toBeVisible();
			await expect(prModal.getByText('1 uncommitted change')).toBeVisible();
			await expect(prModal.getByRole('button', { name: 'Create PR' })).toBeEnabled({
				timeout: 5000,
			});
			await prModal.getByPlaceholder('PR title...').fill('E2E git lane PR title');
			await prModal.getByPlaceholder('Add a description...').fill('E2E git lane PR body');
			await prModal.getByRole('button', { name: 'Create PR' }).click();

			await expect
				.poll(async () => (await getStubbedCreatePRRequest(launched.electronApp))?.title ?? null)
				.toBe('E2E git lane PR title');
			const request = await getStubbedCreatePRRequest(launched.electronApp);
			expect(request).toMatchObject({
				targetBranch: 'main',
				title: 'E2E git lane PR title',
				description: 'E2E git lane PR body',
			});
			expect(request?.worktreePath).toContain('feat-git-pr-tranche');
			await expect(prModal).toBeHidden({ timeout: 5000 });
			await expect(launched.window.getByText('Pull Request Created')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirdTrancheActiveScenarioMatrix[3].id}: ${thirdTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			const contextMenu = await openSessionContextMenu(
				launched.window,
				'Git Group Chat Playbooks Agent',
				'Create Worktree'
			);
			await contextMenu.getByRole('button', { name: 'Create Worktree', exact: true }).click();

			const createModal = modalRootByHeading(launched.window, 'Create New Worktree');
			await createModal.getByPlaceholder('feature-xyz').fill('bad branch name!');
			await createModal.getByRole('button', { name: 'Create', exact: true }).click();

			await expect(createModal.getByText('Invalid branch name')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirdTrancheActiveScenarioMatrix[4].id}: ${thirdTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceForPlaybookExchange(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await marketplaceDialog.getByRole('button', { name: /Git Lane Review/ }).click();
			await expect(
				marketplaceDialog.getByText('Use this playbook to review lane output.')
			).toBeVisible();
			await marketplaceDialog
				.locator('#marketplace-target-folder')
				.fill('engineering/git-lane-imported');
			await marketplaceDialog.getByRole('button', { name: 'Import Playbook' }).click();

			await expect
				.poll(async () => {
					const request = await getStubbedMarketplaceImport(launched.electronApp);
					return request ? `${request.playbookId}:${request.targetFolderName}` : '';
				})
				.toBe('git-lane-review:engineering/git-lane-imported');
			await expect(marketplaceDialog).toBeHidden();
			await expect(launched.window.getByText('Playbook Imported')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirdTrancheActiveScenarioMatrix[5].id}: ${thirdTrancheActiveScenarioMatrix[5].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubSpecKitAndOpenSpecCommands(launched.electronApp);
			const settingsDialog = await openSettings(launched.window);

			await settingsDialog.getByText('/speckit.specify').click();
			const commandCard = settingsDialog
				.getByText('/speckit.specify')
				.locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]');
			await commandCard.getByRole('button', { name: 'Edit' }).click();
			await commandCard.locator('textarea').fill('Edited Spec Kit prompt for {{CWD}}.');
			await commandCard.getByRole('button', { name: 'Save' }).click();

			await expect(commandCard.getByText('Modified')).toBeVisible();
			await commandCard.getByRole('button', { name: 'Reset' }).click();
			await expect(commandCard.getByText('Modified')).toBeHidden();
			await expect(commandCard.getByText(/Bundled specify prompt/)).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${thirdTrancheActiveScenarioMatrix[6].id}: ${thirdTrancheActiveScenarioMatrix[6].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubSpecKitAndOpenSpecCommands(launched.electronApp);
			const settingsDialog = await openSettings(launched.window);

			await settingsDialog.getByText('/openspec.proposal').click();
			const commandCard = settingsDialog
				.getByText('/openspec.proposal')
				.locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]');
			await commandCard.getByRole('button', { name: 'Edit' }).click();
			await commandCard.locator('textarea').fill('Edited OpenSpec prompt for {{AGENT_NAME}}.');
			await commandCard.getByRole('button', { name: 'Save' }).click();

			await expect(commandCard.getByText('Modified')).toBeVisible();
			await commandCard.getByRole('button', { name: 'Reset' }).click();
			await expect(commandCard.getByText('Modified')).toBeHidden();
			await expect(commandCard.getByText(/Bundled proposal prompt/)).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fourthTrancheActiveScenarioMatrix[0].id}: ${fourthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubDetailedGitLogState(launched.electronApp);
			const gitLogDialog = await openGitLogFromQuickActions(launched.window);

			await expect(gitLogDialog.getByText('1 of 3 commits')).toBeVisible();
			await expect(gitLogDialog.getByText('feat: seed detailed git log').first()).toBeVisible();
			await expect(gitLogDialog.getByText('main')).toBeVisible();
			await expect(gitLogDialog.getByText('v-e2e')).toBeVisible();
			await expect(
				gitLogDialog.getByText('Body sentinel for detailed git log coverage.')
			).toBeVisible();
			await expect(
				gitLogDialog.getByText('1 file changed, 1 insertion(+), 1 deletion(-)')
			).toBeVisible();
			await expect(gitLogDialog.getByText('README.md')).toBeVisible();
			await expect(gitLogDialog.getByText('New git log sentinel')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fourthTrancheActiveScenarioMatrix[1].id}: ${fourthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withWorktreeChild: true });
		try {
			await stubPullRequestCreation(
				launched.electronApp,
				{ installed: false, authenticated: false },
				{ success: false, error: 'gh missing' }
			);
			await activateSession(launched.window, launched.worktreeBranch);
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Create Pull Request');
			await quickActionsDialog.getByRole('button', { name: /Create Pull Request/ }).click();

			const prModal = modalRootByHeading(launched.window, 'Create Pull Request');
			await expect(prModal.getByText('GitHub CLI not installed')).toBeVisible();
			await expect(prModal.getByText('to create pull requests.')).toBeVisible();
			await expect(prModal.getByRole('button', { name: 'Create PR' })).toBeDisabled();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fourthTrancheActiveScenarioMatrix[2].id}: ${fourthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withWorktreeChild: true });
		try {
			await stubPullRequestCreation(
				launched.electronApp,
				{ installed: true, authenticated: true },
				{
					success: false,
					error: 'E2E gh rejected duplicate branch https://github.com/RunMaestro/Maestro/pull/119',
				}
			);
			await activateSession(launched.window, launched.worktreeBranch);
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Create Pull Request');
			await quickActionsDialog.getByRole('button', { name: /Create Pull Request/ }).click();

			const prModal = modalRootByHeading(launched.window, 'Create Pull Request');
			await prModal.getByPlaceholder('PR title...').fill('E2E rejected PR title');
			await prModal.getByRole('button', { name: 'Create PR' }).click();

			await expect(prModal.getByText('E2E gh rejected duplicate branch')).toBeVisible();
			await expect(prModal.getByRole('button', { name: 'PR #119' })).toBeVisible();
			await expect(prModal.getByRole('button', { name: 'Create PR' })).toBeEnabled();
			await expect
				.poll(async () => (await getStubbedCreatePRRequest(launched.electronApp))?.title ?? null)
				.toBe('E2E rejected PR title');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fourthTrancheActiveScenarioMatrix[3].id}: ${fourthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceFilteringState(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await expect(marketplaceDialog.getByText('Git Release Review')).toBeVisible();
			await marketplaceDialog.getByRole('button', { name: /^QA\s+\(1\)$/ }).click();
			await expect(marketplaceDialog.getByText('OpenSpec Proposal Review')).toBeVisible();
			await expect(marketplaceDialog.getByText('Git Release Review')).toBeHidden();

			await marketplaceDialog.getByPlaceholder('Search playbooks...').fill('handoff');
			await expect(marketplaceDialog.getByText('No results found')).toBeVisible();
			await marketplaceDialog.getByRole('button', { name: /^All\s+\(3\)$/ }).click();
			await expect(marketplaceDialog.getByText('Group Chat Briefing')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fourthTrancheActiveScenarioMatrix[4].id}: ${fourthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceForPlaybookExchange(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await marketplaceDialog.getByRole('button', { name: /Git Lane Review/ }).click();
			await marketplaceDialog.locator('#marketplace-target-folder').fill('');
			await expect(
				marketplaceDialog.getByRole('button', { name: 'Import Playbook' })
			).toBeDisabled();
			await marketplaceDialog
				.locator('#marketplace-target-folder')
				.fill('engineering/git-lane-review');
			await expect(
				marketplaceDialog.getByRole('button', { name: 'Import Playbook' })
			).toBeEnabled();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fourthTrancheActiveScenarioMatrix[5].id}: ${fourthTrancheActiveScenarioMatrix[5].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubSpecKitAndOpenSpecCommands(launched.electronApp);
			const settingsDialog = await openSettings(launched.window);
			const specKitPanel = commandPanelByHeading(launched.window, 'Spec Kit Commands');

			await expect(specKitPanel.getByText('v1.2.3')).toBeVisible();
			await specKitPanel.getByRole('button', { name: 'Check for Updates' }).click();
			await expect(specKitPanel.getByText('v1.2.4')).toBeVisible();
			await expect(settingsDialog.getByText('/speckit.specify')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fourthTrancheActiveScenarioMatrix[6].id}: ${fourthTrancheActiveScenarioMatrix[6].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubSpecKitAndOpenSpecCommands(launched.electronApp);
			const settingsDialog = await openSettings(launched.window);
			const openSpecPanel = commandPanelByHeading(launched.window, 'OpenSpec Commands');

			await expect(openSpecPanel.getByText('v2.0.1')).toBeVisible();
			await openSpecPanel.getByRole('button', { name: 'Check for Updates' }).click();
			await expect(openSpecPanel.getByText('v2.0.2')).toBeVisible();
			await expect(settingsDialog.getByText('/openspec.proposal')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fifthTrancheActiveScenarioMatrix[0].id}: ${fifthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withWorktreeChild: true });
		try {
			await stubPullRequestCreation(
				launched.electronApp,
				{ installed: true, authenticated: true },
				{ success: true, prUrl: 'https://github.com/RunMaestro/Maestro/pull/126' }
			);
			await activateSession(launched.window, launched.worktreeBranch);
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Create Pull Request');
			await quickActionsDialog.getByRole('button', { name: /Create Pull Request/ }).click();

			const prModal = modalRootByHeading(launched.window, 'Create Pull Request');
			await prModal.locator('select').selectOption(launched.worktreeBranch);
			await prModal.getByPlaceholder('PR title...').fill('E2E alternate target branch');
			await prModal.getByRole('button', { name: 'Create PR' }).click();

			await expect
				.poll(
					async () => (await getStubbedCreatePRRequest(launched.electronApp))?.targetBranch ?? null
				)
				.toBe(launched.worktreeBranch);
			await expect(prModal).toBeHidden({ timeout: 5000 });
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fifthTrancheActiveScenarioMatrix[1].id}: ${fifthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withWorktreeChild: true });
		try {
			await stubPullRequestCreation(
				launched.electronApp,
				{ installed: true, authenticated: true },
				{ success: true, prUrl: 'https://github.com/RunMaestro/Maestro/pull/127' }
			);
			await activateSession(launched.window, launched.worktreeBranch);
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Create Pull Request');
			await quickActionsDialog.getByRole('button', { name: /Create Pull Request/ }).click();

			const prModal = modalRootByHeading(launched.window, 'Create Pull Request');
			await prModal.getByPlaceholder('PR title...').fill('E2E canceled PR title');
			await prModal.getByRole('button', { name: 'Cancel' }).click();

			await expect(prModal).toBeHidden();
			expect(await getStubbedCreatePRRequest(launched.electronApp)).toBeNull();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fifthTrancheActiveScenarioMatrix[2].id}: ${fifthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceForPlaybookExchange(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await marketplaceDialog.getByRole('button', { name: /Git Lane Review/ }).click();
			await marketplaceDialog.getByRole('button', { name: 'review-plan.md' }).click();
			await expect(marketplaceDialog.getByText('Review Plan')).toBeVisible();
			await expect(marketplaceDialog.getByText('Review plan body for the git lane.')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fifthTrancheActiveScenarioMatrix[3].id}: ${fifthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceForPlaybookExchange(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await marketplaceDialog.getByRole('button', { name: /Git Lane Review/ }).click();
			await marketplaceDialog
				.locator('#marketplace-target-folder')
				.fill('collaboration/group-chat-import');
			await marketplaceDialog.getByRole('button', { name: 'Import Playbook' }).click();

			await expect
				.poll(async () => {
					const request = await getStubbedMarketplaceImport(launched.electronApp);
					return request
						? {
								playbookId: request.playbookId,
								targetFolderName: request.targetFolderName,
								sessionId: request.sessionId,
								autoRunFolderPath: request.autoRunFolderPath,
							}
						: null;
				})
				.toMatchObject({
					playbookId: 'git-lane-review',
					targetFolderName: 'collaboration/group-chat-import',
					sessionId: expect.stringContaining('git-groupchat-playbooks-'),
					autoRunFolderPath: expect.stringContaining('Playbooks'),
				});
		} finally {
			await launched.cleanup();
		}
	});

	test(`${fifthTrancheActiveScenarioMatrix[4].id}: ${fifthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Git Lane Room');

			await expect(
				quickActionsDialog.getByRole('button', { name: /Group Chat: Git Lane Room/ })
			).toBeVisible();
			await expect(quickActionsDialog.getByRole('button', { name: /View Git Diff/ })).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${sixthTrancheActiveScenarioMatrix[0].id}: ${sixthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMultiFileGitDiffState(launched.electronApp);
			const gitDiffDialog = await openGitDiffFromQuickActions(launched.window);

			await expect(gitDiffDialog.getByText('2 files changed')).toBeVisible();
			await expect(gitDiffDialog.getByRole('button', { name: /README\.md/ })).toBeVisible();
			await gitDiffDialog.getByRole('button', { name: /FLOW\.md/ }).click();
			await expect(gitDiffDialog.getByText('Flow diff tab sentinel.')).toBeVisible();
			await expect(gitDiffDialog.getByText('Current file:')).toBeVisible();
			await expect(gitDiffDialog.getByText('File 2 of 2')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${sixthTrancheActiveScenarioMatrix[1].id}: ${sixthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Git Lane Room');
			await quickActionsDialog.getByRole('button', { name: /Group Chat: Git Lane Room/ }).click();

			await expect(
				launched.window.getByRole('button', { name: 'Group Chat: Git Lane Room' })
			).toBeVisible();
			await expect(launched.window.getByText('1 participant')).toBeVisible();
			await expect(
				launched.window.getByText('Seeded group chat message for git lane.')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${sixthTrancheActiveScenarioMatrix[2].id}: ${sixthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			const roomPickerDialog = await openQuickActions(launched.window);
			await roomPickerDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Git Lane Room');
			await roomPickerDialog.getByRole('button', { name: /Group Chat: Git Lane Room/ }).click();

			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Group Chat');
			await expect(
				quickActionsDialog.getByRole('button', { name: 'Close Group Chat' })
			).toBeVisible();
			await expect(
				quickActionsDialog.getByRole('button', { name: 'Remove Group Chat: Git Lane Room' })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${sixthTrancheActiveScenarioMatrix[3].id}: ${sixthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceFilteringState(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await marketplaceDialog.getByRole('button', { name: /^Collaboration\s+\(1\)$/ }).click();
			await marketplaceDialog.getByRole('button', { name: /Group Chat Briefing/ }).click();
			await expect(marketplaceDialog.getByText('Documents (0)')).toBeVisible();
			await expect(marketplaceDialog.getByText(/Loop:\s+Yes \(max 2\)/)).toBeVisible();
			await expect(marketplaceDialog.getByText('group-chat')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${sixthTrancheActiveScenarioMatrix[4].id}: ${sixthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubSpecKitAndOpenSpecCommands(launched.electronApp);
			const settingsDialog = await openSettings(launched.window);

			await settingsDialog.getByText('/speckit.specify').click();
			const commandCard = settingsDialog
				.getByText('/speckit.specify')
				.locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]');
			await commandCard.getByRole('button', { name: 'Edit' }).click();
			await commandCard.locator('textarea').fill('Canceled Spec Kit prompt edit.');
			await commandCard.getByRole('button', { name: 'Cancel' }).click();

			await expect(commandCard.getByText('Modified')).toBeHidden();
			await expect(commandCard.getByText(/Bundled specify prompt/)).toBeVisible();
			await expect(commandCard.getByText('Canceled Spec Kit prompt edit.')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${seventhTrancheActiveScenarioMatrix[0].id}: ${seventhTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubEmptyGitDiffState(launched.electronApp);
			const gitDiffDialog = await openGitDiffFromQuickActions(launched.window);

			await expect(gitDiffDialog.getByText('No changes to display')).toBeVisible();
			await expect(gitDiffDialog.getByRole('button', { name: 'Close (Esc)' })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${seventhTrancheActiveScenarioMatrix[1].id}: ${seventhTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceForPlaybookExchange(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await marketplaceDialog.getByRole('button', { name: 'Help' }).click();
			await expect(marketplaceDialog.getByText('About the Playbook Exchange')).toBeVisible();
			await expect(marketplaceDialog.getByText('Submit Your Playbook')).toBeVisible();
			await expect(
				marketplaceDialog.getByText('github.com/RunMaestro/Maestro-Playbooks')
			).toBeVisible();
			await marketplaceDialog.getByRole('button', { name: 'Close', exact: true }).click();
			await expect(marketplaceDialog.getByText('About the Playbook Exchange')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${seventhTrancheActiveScenarioMatrix[2].id}: ${seventhTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceFilteringState(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await expect(marketplaceDialog.getByText(/Cached/)).toBeVisible();
			await marketplaceDialog.getByRole('button', { name: 'Refresh marketplace' }).click();
			await expect(marketplaceDialog.getByText('Live')).toBeVisible({ timeout: 5000 });
			await expect(
				marketplaceDialog.getByRole('button', { name: /Git Release Review/ })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${seventhTrancheActiveScenarioMatrix[3].id}: ${seventhTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubSpecKitAndOpenSpecCommands(launched.electronApp);
			const settingsDialog = await openSettings(launched.window);

			await settingsDialog.getByText('/openspec.proposal').click();
			const commandCard = settingsDialog
				.getByText('/openspec.proposal')
				.locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]');
			await commandCard.getByRole('button', { name: 'Edit' }).click();
			await commandCard.locator('textarea').fill('Canceled OpenSpec prompt edit.');
			await commandCard.getByRole('button', { name: 'Cancel' }).click();

			await expect(commandCard.getByText('Modified')).toBeHidden();
			await expect(commandCard.getByText(/Bundled proposal prompt/)).toBeVisible();
			await expect(commandCard.getByText('Canceled OpenSpec prompt edit.')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${seventhTrancheActiveScenarioMatrix[4].id}: ${seventhTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withWorktreeChild: true });
		try {
			await stubPullRequestCreation(
				launched.electronApp,
				{ installed: true, authenticated: true },
				{ success: true, prUrl: 'https://github.com/RunMaestro/Maestro/pull/140' }
			);
			await activateSession(launched.window, launched.worktreeBranch);
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Create Pull Request');
			await quickActionsDialog.getByRole('button', { name: /Create Pull Request/ }).click();

			const prModal = modalRootByHeading(launched.window, 'Create Pull Request');
			const createButton = prModal.getByRole('button', { name: 'Create PR' });
			await expect(createButton).toBeEnabled({ timeout: 5000 });
			await prModal.getByPlaceholder('PR title...').fill('');

			await expect(createButton).toBeDisabled();
			expect(await getStubbedCreatePRRequest(launched.electronApp)).toBeNull();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${eighthTrancheActiveScenarioMatrix[0].id}: ${eighthTrancheActiveScenarioMatrix[0].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withWorktreeChild: true });
		try {
			await stubPullRequestCreation(
				launched.electronApp,
				{ installed: true, authenticated: true },
				{ success: true, prUrl: 'https://github.com/RunMaestro/Maestro/pull/141' }
			);
			await activateSession(launched.window, launched.worktreeBranch);
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Create Pull Request');
			await quickActionsDialog.getByRole('button', { name: /Create Pull Request/ }).click();

			const prModal = modalRootByHeading(launched.window, 'Create Pull Request');
			await expect(prModal.getByText('From Branch')).toBeVisible();
			await expect(prModal.getByText(launched.worktreeBranch).first()).toBeVisible();
			await expect(prModal.locator('select')).toHaveValue('main');
			await expect(prModal.getByPlaceholder('PR title...')).toHaveValue('feat/git pr tranche');
			await expect(prModal.getByText('1 uncommitted change')).toBeVisible();
			await expect(
				prModal.getByText(/Only committed changes will be included in the PR/)
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${eighthTrancheActiveScenarioMatrix[1].id}: ${eighthTrancheActiveScenarioMatrix[1].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench({ withWorktreeChild: true });
		try {
			await stubPullRequestCreation(
				launched.electronApp,
				{ installed: true, authenticated: true },
				{ success: false, error: 'E2E gh network refused without URL' }
			);
			await activateSession(launched.window, launched.worktreeBranch);
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Create Pull Request');
			await quickActionsDialog.getByRole('button', { name: /Create Pull Request/ }).click();

			const prModal = modalRootByHeading(launched.window, 'Create Pull Request');
			await prModal.getByPlaceholder('PR title...').fill('E2E non URL PR failure');
			await prModal
				.getByPlaceholder('Add a description...')
				.fill('Non URL failure body should remain editable.');
			await prModal.getByRole('button', { name: 'Create PR' }).click();

			await expect(prModal.getByText('E2E gh network refused without URL')).toBeVisible();
			await expect(prModal.getByRole('button', { name: 'Create PR' })).toBeEnabled();
			await expect(launched.window.getByText('Pull Request Created')).toBeHidden();
			await expect
				.poll(async () => {
					const request = await getStubbedCreatePRRequest(launched.electronApp);
					return request
						? {
								title: request.title,
								description: request.description,
							}
						: null;
				})
				.toMatchObject({
					title: 'E2E non URL PR failure',
					description: 'Non URL failure body should remain editable.',
				});
		} finally {
			await launched.cleanup();
		}
	});

	test(`${eighthTrancheActiveScenarioMatrix[2].id}: ${eighthTrancheActiveScenarioMatrix[2].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceFilteringState(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await marketplaceDialog.getByRole('button', { name: /^QA\s+\(1\)$/ }).click();
			await marketplaceDialog.getByRole('button', { name: /OpenSpec Proposal Review/ }).click();
			await expect(
				marketplaceDialog.getByText('Validate openspec proposal coverage.')
			).toBeVisible();
			await marketplaceDialog.getByTitle('Back to list (Esc)').click();

			await expect(marketplaceDialog.getByPlaceholder('Search playbooks...')).toBeVisible();
			await expect(
				marketplaceDialog.getByRole('button', { name: /OpenSpec Proposal Review/ })
			).toBeVisible();
			await expect(marketplaceDialog.getByText('Git Release Review')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test(`${eighthTrancheActiveScenarioMatrix[3].id}: ${eighthTrancheActiveScenarioMatrix[3].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceFilteringState(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);
			const searchInput = marketplaceDialog.getByPlaceholder('Search playbooks...');

			await launched.window.keyboard.press('Meta+F');
			await expect(searchInput).toBeFocused();
			await searchInput.fill('release');
			await expect(
				marketplaceDialog.getByRole('button', { name: /Git Release Review/ })
			).toBeVisible();
			await launched.window.keyboard.press('Escape');
			await expect(marketplaceDialog).toBeVisible();
			await expect(searchInput).toHaveValue('release');
		} finally {
			await launched.cleanup();
		}
	});

	test(`${eighthTrancheActiveScenarioMatrix[4].id}: ${eighthTrancheActiveScenarioMatrix[4].title}`, async () => {
		const launched = await launchGitGroupChatPlaybooksWorkbench();
		try {
			await stubMarketplaceForPlaybookExchange(launched.electronApp);
			const marketplaceDialog = await openPlaybookExchangeFromQuickActions(launched.window);

			await marketplaceDialog.getByRole('button', { name: /Git Lane Review/ }).click();
			await expect(
				marketplaceDialog.getByText('Use this playbook to review lane output.')
			).toBeVisible();
			await launched.window.keyboard.press('Meta+Shift+]');
			await expect(marketplaceDialog.getByText('Review Plan')).toBeVisible();
			await expect(marketplaceDialog.getByText('Review plan body for the git lane.')).toBeVisible();
			await launched.window.keyboard.press('Meta+Shift+]');
			await expect(
				marketplaceDialog.getByText('Use this playbook to review lane output.')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});
});

test.describe('Git, Group Chat, and Playbooks skipped/env-gated rows', () => {
	for (const scenario of [
		...secondTrancheSkippedScenarioMatrix,
		...thirdTrancheSkippedScenarioMatrix,
		...fourthTrancheSkippedScenarioMatrix,
	]) {
		test(`${scenario.id}: ${scenario.title}`, async () => {
			test.skip(true, scenario.reason);
		});
	}
});
