/**
 * E2E Tests: stats, graph, Symphony, and leaderboard first tranche.
 *
 * This file authors deterministic coverage only. The scenarios seed local
 * app state and stub network-backed Symphony/leaderboard surfaces.
 */
import { test, expect, helpers } from './fixtures/electron-app';
import type { ElectronApplication, Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';

const activeScenarioMatrix = [
	{ id: 'SGS-A01', title: 'renders Usage Dashboard summary and analytics sections' },
	{ id: 'SGS-A02', title: 'shows the Usage Dashboard live stats update indicator' },
	{ id: 'SGS-A03', title: 'opens Document Graph search and help controls from file preview' },
	{ id: 'SGS-A04', title: 'browses Symphony projects, status tabs, and achievements' },
	{ id: 'SGS-A05', title: 'opens About achievements and the leaderboard registration entry point' },
] as const;

const skippedScenarioMatrix = [
	{
		id: 'SGS-S01',
		title: 'completes a full Symphony contribution from GitHub issue to draft PR',
		reason:
			'Product gap for this tranche: requires live GitHub CLI, repo checkout, and Auto Run execution.',
	},
	{
		id: 'SGS-S02',
		title: 'verifies downloadable achievement badge images',
		reason: 'Product gap for this tranche: requires canvas/screenshot artifact verification.',
	},
] as const;

const envGatedScenarioMatrix = [
	{
		id: 'SGS-E01',
		title: 'submits leaderboard registration to runmaestro.ai',
		reason: 'Env-gated: requires live network and leaderboard backend.',
	},
	{
		id: 'SGS-E02',
		title: 'refreshes real Symphony issue status from GitHub',
		reason: 'Env-gated: requires authenticated GitHub CLI or API access.',
	},
] as const;

function createStatsGraphSymphonyWorkbench() {
	const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-e2e-stats-graph-symphony-'));
	const projectDir = path.join(homeDir, 'project');
	const docsDir = path.join(projectDir, 'docs');
	const now = Date.parse('2026-05-29T12:00:00.000Z');
	const idSuffix = `${now}-${Math.random().toString(36).slice(2)}`;
	const sessionId = `stats-graph-symphony-${idSuffix}`;
	const aiTabId = `stats-graph-symphony-ai-${idSuffix}`;
	const fileTabId = `stats-graph-symphony-file-${idSuffix}`;
	const readmePath = path.join(projectDir, 'README.md');
	const runbookPath = path.join(docsDir, 'RUNBOOK.md');

	fs.mkdirSync(docsDir, { recursive: true });
	fs.writeFileSync(
		readmePath,
		`# Stats Graph Symphony Fixture

Usage dashboard, document graph, Symphony, and achievements fixture.

[Runbook](docs/RUNBOOK.md)

- [ ] Graph tranche still active
- [x] Stats tranche seeded
`,
		'utf-8'
	);
	fs.writeFileSync(
		runbookPath,
		`# Symphony Runbook

Deterministic runbook body for document graph search coverage.

[Root README](../README.md)
`,
		'utf-8'
	);

	const aiLogs = [
		{
			id: `stats-graph-symphony-log-${idSuffix}`,
			timestamp: now,
			source: 'stdout',
			text: 'Stats graph Symphony seeded agent output.',
		},
	];

	return {
		homeDir,
		projectDir,
		sessionId,
		sessions: [
			{
				id: sessionId,
				name: 'Stats Graph Symphony Agent',
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
				usageStats: {
					inputTokens: 2200,
					outputTokens: 560,
					cacheReadInputTokens: 120,
					cacheCreationInputTokens: 80,
					totalCostUsd: 0.08,
					contextWindow: 128000,
				},
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
						agentSessionId: 'codex-stats-graph-symphony-tab',
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
				filePreviewTabs: [
					{
						id: fileTabId,
						path: readmePath,
						name: 'README.md',
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

async function seedStats(
	page: Page,
	workbench: ReturnType<typeof createStatsGraphSymphonyWorkbench>
) {
	await page.evaluate(
		async ({ projectDir, sessionId }) => {
			const baseTime = Date.parse('2026-05-29T12:00:00.000Z');
			await window.maestro.stats.recordSessionCreated({
				sessionId,
				agentType: 'codex',
				projectPath: projectDir,
				createdAt: baseTime - 3_600_000,
				isRemote: false,
			});
			await window.maestro.stats.recordSessionClosed(sessionId, baseTime);
			await window.maestro.stats.recordQuery({
				sessionId,
				agentType: 'codex',
				source: 'user',
				startTime: baseTime - 600_000,
				duration: 120_000,
				projectPath: projectDir,
				tabId: 'sgs-user-query',
				isRemote: false,
			});
			await window.maestro.stats.recordQuery({
				sessionId,
				agentType: 'codex',
				source: 'auto',
				startTime: baseTime - 300_000,
				duration: 90_000,
				projectPath: projectDir,
				tabId: 'sgs-auto-query',
				isRemote: false,
			});
			const autoRunId = await window.maestro.stats.startAutoRun({
				sessionId,
				agentType: 'codex',
				documentPath: `${projectDir}/docs/RUNBOOK.md`,
				startTime: baseTime - 240_000,
				duration: 180_000,
				tasksTotal: 3,
				tasksCompleted: 2,
				projectPath: projectDir,
			});
			await window.maestro.stats.recordAutoTask({
				autoRunSessionId: autoRunId,
				sessionId,
				agentType: 'codex',
				taskIndex: 0,
				taskContent: 'Seed stats graph tranche',
				startTime: baseTime - 220_000,
				duration: 60_000,
				success: true,
			});
			await window.maestro.stats.endAutoRun(autoRunId, 180_000, 2);
		},
		{ projectDir: workbench.projectDir, sessionId: workbench.sessionId }
	);
}

async function stubSymphonyHandlers(
	electronApp: ElectronApplication,
	workbench: ReturnType<typeof createStatsGraphSymphonyWorkbench>
) {
	await electronApp.evaluate(
		({ ipcMain }, payload: { sessionId: string }) => {
			const now = '2026-05-29T12:00:00.000Z';
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
						maintainer: { name: 'RunMaestro', url: 'https://github.com/RunMaestro' },
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
				id: 'symphony-active-sgs',
				repoSlug: 'RunMaestro/Maestro',
				repoName: 'Maestro Core',
				issueNumber: 42,
				issueTitle: 'Add deterministic E2E coverage',
				localPath: '/tmp/maestro-symphony-sgs',
				branchName: 'symphony/issue-42-sgs',
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
				id: 'symphony-completed-sgs',
				repoSlug: 'RunMaestro/docs',
				repoName: 'Documentation Hub',
				issueNumber: 12,
				issueTitle: 'Document mobile bridge setup',
				startedAt: '2026-05-28T10:00:00.000Z',
				completedAt: '2026-05-28T12:00:00.000Z',
				prUrl: 'https://github.com/RunMaestro/docs/pull/12',
				prNumber: 12,
				tokenUsage: { inputTokens: 300_000, outputTokens: 80_000, totalCost: 4.56 },
				timeSpent: 7_200_000,
				documentsProcessed: 3,
				tasksCompleted: 18,
				wasMerged: true,
				mergedAt: '2026-05-28T14:00:00.000Z',
			};
			const state = { active: [activeContribution], history: [completedContribution], stats };

			ipcMain.removeHandler('symphony:getRegistry');
			ipcMain.handle('symphony:getRegistry', async () => ({
				success: true,
				registry,
				fromCache: true,
				cacheAge: 300_000,
			}));
			ipcMain.removeHandler('symphony:getIssueCounts');
			ipcMain.handle('symphony:getIssueCounts', async () => ({
				success: true,
				counts: { 'RunMaestro/Maestro': 3, 'RunMaestro/docs': 0 },
				fromCache: true,
				cacheAge: 60_000,
			}));
			ipcMain.removeHandler('symphony:getIssues');
			ipcMain.handle('symphony:getIssues', async (_event, repoSlug: string) => ({
				success: true,
				issues: issues[repoSlug as keyof typeof issues] ?? [],
				fromCache: true,
				cacheAge: 60_000,
			}));
			ipcMain.removeHandler('symphony:getState');
			ipcMain.handle('symphony:getState', async () => ({ success: true, state }));
			ipcMain.removeHandler('symphony:getActive');
			ipcMain.handle('symphony:getActive', async () => ({
				success: true,
				contributions: state.active,
			}));
			ipcMain.removeHandler('symphony:getCompleted');
			ipcMain.handle('symphony:getCompleted', async (_event, limit?: number) => ({
				success: true,
				contributions: state.history.slice(0, limit ?? state.history.length),
			}));
			ipcMain.removeHandler('symphony:getStats');
			ipcMain.handle('symphony:getStats', async () => ({ success: true, stats }));
			ipcMain.removeHandler('symphony:checkPRStatuses');
			ipcMain.handle('symphony:checkPRStatuses', async () => ({
				success: true,
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
				content: '# External Symphony Doc\n\nDocument preview body for SGS.',
			}));
			ipcMain.removeHandler('git:checkGhCli');
			ipcMain.handle('git:checkGhCli', async () => ({ installed: false, authenticated: false }));
		},
		{ sessionId: workbench.sessionId }
	);
}

async function stubAboutAndLeaderboardHandlers(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		ipcMain.removeHandler('agentSessions:getGlobalStats');
		ipcMain.handle('agentSessions:getGlobalStats', async () => ({
			totalSessions: 2,
			totalMessages: 5,
			totalInputTokens: 120_000,
			totalOutputTokens: 42_000,
			totalCacheReadTokens: 10_000,
			totalCacheCreationTokens: 2_000,
			totalCostUsd: 3.21,
			hasCostData: true,
			totalSizeBytes: 4096,
			isComplete: true,
			byProvider: {},
		}));
		ipcMain.removeHandler('leaderboard:getInstallationId');
		ipcMain.handle('leaderboard:getInstallationId', async () => 'sgs-installation-id');
		ipcMain.removeHandler('leaderboard:submit');
		ipcMain.handle('leaderboard:submit', async () => ({
			success: true,
			emailSent: true,
			clientToken: 'sgs-client-token',
			message: 'Confirmation email queued.',
		}));
	});
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

async function openAboutFromQuickActions(window: Page) {
	const quickActionsDialog = await openQuickActions(window);
	await quickActionsDialog
		.getByPlaceholder('Type a command or jump to agent...')
		.fill('About Maestro');
	await quickActionsDialog.getByRole('button', { name: /About Maestro/ }).click();

	await expect(quickActionsDialog).toBeHidden();
	const aboutDialog = window.getByRole('dialog', { name: 'About Maestro' });
	await expect(aboutDialog).toBeVisible();
	return aboutDialog;
}

async function openDocumentGraphFromPreview(window: Page) {
	await window.getByTitle('View in Document Graph (⌘ ⇧ G)').click();
	const graphDialog = window.getByRole('dialog', { name: 'Document Graph' });
	await expect(graphDialog).toBeVisible({ timeout: 15000 });
	await expect(graphDialog.getByText(/\d+ documents/)).toBeVisible({ timeout: 15000 });
	return graphDialog;
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

test.describe(`Stats graph Symphony first tranche (${activeScenarioMatrix.length} active, ${skippedScenarioMatrix.length} skipped, ${envGatedScenarioMatrix.length} env-gated)`, () => {
	let window: Page;
	let electronApp: ElectronApplication;
	let cleanupApp: (() => Promise<void>) | undefined;
	let workbench: ReturnType<typeof createStatsGraphSymphonyWorkbench>;

	test.beforeEach(async () => {
		workbench = createStatsGraphSymphonyWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: workbench.homeDir,
			sessions: workbench.sessions,
			settings: {
				leaderboardRegistration: null,
			},
		});
		window = launched.window;
		electronApp = launched.electronApp;
		cleanupApp = launched.cleanup;
		await seedStats(window, workbench);
		await stubSymphonyHandlers(electronApp, workbench);
		await stubAboutAndLeaderboardHandlers(electronApp);
		await expect(window.getByText('Stats Graph Symphony Fixture')).toBeVisible();
	});

	test.afterEach(async () => {
		await cleanupApp?.();
		cleanupApp = undefined;
	});

	test(`${activeScenarioMatrix[0].id} ${activeScenarioMatrix[0].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.locator('select').first().selectOption('all');
		await expect(usageDashboard.getByText('Showing all time data')).toBeVisible();
		await expect(usageDashboard.getByTestId('summary-cards')).toBeVisible();
		await expect(usageDashboard.getByText('Total Queries')).toBeVisible();

		await usageDashboard.getByRole('tab', { name: 'Agents' }).click();
		await expect(usageDashboard.getByTestId('section-session-stats')).toBeVisible();
		await expect(usageDashboard.getByTestId('agent-efficiency-chart')).toBeVisible();

		await usageDashboard.getByRole('tab', { name: 'Activity' }).click();
		await expect(usageDashboard.getByTestId('section-activity-heatmap')).toBeVisible();
		await expect(usageDashboard.getByTestId('section-weekday-comparison')).toBeVisible();
	});

	test(`${activeScenarioMatrix[1].id} ${activeScenarioMatrix[1].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await window.evaluate(
			async ({ projectDir, sessionId }) => {
				await window.maestro.stats.recordQuery({
					sessionId,
					agentType: 'codex',
					source: 'user',
					startTime: Date.now(),
					duration: 30_000,
					projectPath: projectDir,
					tabId: 'sgs-live-update',
					isRemote: false,
				});
			},
			{ projectDir: workbench.projectDir, sessionId: workbench.sessionId }
		);

		await expect(usageDashboard.getByTestId('new-data-indicator')).toBeVisible({ timeout: 5000 });
	});

	test(`${activeScenarioMatrix[2].id} ${activeScenarioMatrix[2].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await graphDialog.getByLabel('Search documents in graph').fill('runbook');
		await expect(graphDialog.getByText('RUNBOOK.md')).toBeVisible();
		await graphDialog.getByTitle('Open help panel').click();
		await expect(graphDialog.getByRole('region', { name: 'Help panel' })).toBeVisible();
		await expect(graphDialog.getByText('Node Types')).toBeVisible();

		await closeDocumentGraph(window);
	});

	test(`${activeScenarioMatrix[3].id} ${activeScenarioMatrix[3].title}`, async () => {
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByPlaceholder('Search repositories...').fill('core');
		await expect(symphonyDialog.getByRole('button', { name: /Maestro Core/ })).toBeVisible();
		await expect(symphonyDialog.getByText('Documentation Hub')).toBeHidden();

		await symphonyDialog.getByRole('button', { name: /Maestro Core/ }).click();
		await expect(symphonyDialog.getByText('Available Issues (1)')).toBeVisible();
		await expect(symphonyDialog.getByText('In Progress (1)')).toBeVisible();
		await expect(symphonyDialog.getByText('Blocked (1)')).toBeVisible();

		await symphonyDialog.getByRole('button', { name: /Active \(1\)/ }).click();
		await expect(symphonyDialog.getByText('Ready for Review')).toBeVisible();
		await expect(symphonyDialog.getByText('Draft PR #77')).toBeVisible();

		await symphonyDialog.getByRole('button', { name: 'History' }).click();
		await expect(symphonyDialog.getByText('Document mobile bridge setup')).toBeVisible();

		await symphonyDialog.getByRole('button', { name: 'Stats' }).click();
		await expect(symphonyDialog.getByText('Time Contributed')).toBeVisible();
		await expect(symphonyDialog.getByText('Streak')).toBeVisible();
		await expect(symphonyDialog.getByText('Achievements')).toBeVisible();
	});

	test(`${activeScenarioMatrix[4].id} ${activeScenarioMatrix[4].title}`, async () => {
		const aboutDialog = await openAboutFromQuickActions(window);

		await expect(aboutDialog.getByText('Global Statistics')).toBeVisible();
		await expect(aboutDialog.getByText('Achievements')).toBeVisible();
		await aboutDialog.getByRole('button', { name: /Join Leaderboard/ }).click();

		const leaderboardDialog = window.getByRole('dialog', { name: 'Register for Leaderboard' });
		await expect(leaderboardDialog).toBeVisible();
		await expect(leaderboardDialog.getByText('Join the global Maestro leaderboard')).toBeVisible();
		await expect(leaderboardDialog.getByText('Your Current Stats')).toBeVisible();
		await expect(leaderboardDialog.getByText('Total Runs:')).toBeVisible();
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
