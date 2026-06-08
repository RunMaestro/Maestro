/**
 * E2E Tests: Git, Group Chat, Playbooks, Spec Kit, and OpenSpec first tranche.
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

function createGitGroupChatPlaybooksWorkbench() {
	const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-e2e-git-groupchat-'));
	const projectDir = path.join(homeDir, 'project');
	const autoRunFolder = path.join(projectDir, 'Playbooks');
	const now = Date.parse('2026-05-29T12:00:00.000Z');
	const idSuffix = `${now}-${Math.random().toString(36).slice(2)}`;
	const sessionId = `git-groupchat-playbooks-${idSuffix}`;
	const aiTabId = `git-groupchat-playbooks-ai-${idSuffix}`;
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
	fs.appendFileSync(readmePath, '\nWorking tree diff sentinel for git lane.\n', 'utf-8');
	fs.writeFileSync(
		path.join(projectDir, 'NOTES.md'),
		'# Notes\n\nUntracked git lane note sentinel.\n',
		'utf-8'
	);

	return {
		homeDir,
		projectDir,
		sessions: [
			{
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
			},
		],
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

async function launchGitGroupChatPlaybooksWorkbench() {
	const seeded = createGitGroupChatPlaybooksWorkbench();
	const launched = await helpers.launchAppWithState({
		homeDir: seeded.homeDir,
		sessions: seeded.sessions,
		groupChats: seeded.groupChats,
	});

	return { ...seeded, ...launched };
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

async function openSettings(page: Page) {
	const quickActionsDialog = await openQuickActions(page);
	await quickActionsDialog.getByPlaceholder('Type a command or jump to agent...').fill('Settings');
	await quickActionsDialog.getByRole('button', { name: /^Settings$/ }).click();

	await expect(quickActionsDialog).toBeHidden();
	const settingsDialog = page.getByRole('dialog', { name: 'Settings' });
	await expect(settingsDialog).toBeVisible();
	return settingsDialog;
}

async function stubMarketplaceForPlaybookExchange(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
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
					prompt: 'Bundled specify prompt for {{CWD}}.',
					isCustom: false,
					isModified: false,
				},
			],
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
					prompt: 'Bundled proposal prompt for {{AGENT_NAME}}.',
					isCustom: false,
					isModified: false,
				},
			],
		}));
	});
}

test.describe('Git, Group Chat, and Playbooks first tranche', () => {
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
});
