/**
 * E2E Tests: Agent CRUD, provider setup, and Agent Sessions.
 *
 * This tranche authors deterministic coverage only. Provider detection and
 * provider session storage are stubbed so later execution does not require real
 * CLI installs, auth state, or provider history.
 */
import { test, expect, helpers } from './fixtures/electron-app';
import type { ElectronApplication, Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';

type ProviderMatrixRow = {
	id: 'claude-code' | 'codex' | 'opencode' | 'factory-droid';
	displayName: string;
	binaryName: string;
	command: string;
	createName: string;
	customPath: string;
};

type AgentSessionSearchCall = {
	agentId: string;
	projectPath: string;
	query: string;
	mode: string;
};

const PROVIDER_MATRIX: ProviderMatrixRow[] = [
	{
		id: 'codex',
		displayName: 'Codex',
		binaryName: 'codex',
		command: 'codex',
		createName: 'Provider Matrix Codex',
		customPath: '/usr/local/bin/codex-e2e',
	},
	{
		id: 'claude-code',
		displayName: 'Claude Code',
		binaryName: 'claude',
		command: 'claude',
		createName: 'Provider Matrix Claude',
		customPath: '/usr/local/bin/claude-e2e',
	},
	{
		id: 'opencode',
		displayName: 'OpenCode',
		binaryName: 'opencode',
		command: 'opencode',
		createName: 'Provider Matrix OpenCode',
		customPath: '/usr/local/bin/opencode-e2e',
	},
	{
		id: 'factory-droid',
		displayName: 'Factory Droid',
		binaryName: 'droid',
		command: 'droid',
		createName: 'Provider Matrix Droid',
		customPath: '/usr/local/bin/droid-e2e',
	},
];

function createAgentCrudWorkbench() {
	const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-e2e-agent-crud-'));
	const projectDir = path.join(homeDir, 'agent-crud-project');
	const now = Date.parse('2026-02-03T04:05:06Z');

	fs.mkdirSync(projectDir, { recursive: true });
	fs.writeFileSync(
		path.join(projectDir, 'README.md'),
		'# Agent CRUD Provider Matrix\n\nDeterministic fixture for provider CRUD coverage.\n',
		'utf-8'
	);

	return {
		homeDir,
		projectDir,
		sessions: PROVIDER_MATRIX.map((provider, index) =>
			createSeedSession({
				id: `agent-crud-${provider.id}`,
				name: `Matrix ${provider.displayName} Agent`,
				toolType: provider.id,
				projectDir,
				now: now + index,
				agentSessionId: `thread_agent_crud_${provider.id}`,
			})
		),
	};
}

function createSeedSession({
	id,
	name,
	toolType,
	projectDir,
	now,
	agentSessionId,
}: {
	id: string;
	name: string;
	toolType: ProviderMatrixRow['id'];
	projectDir: string;
	now: number;
	agentSessionId: string;
}) {
	const tabId = `${id}-tab`;
	const aiLogs = [
		{
			id: `${id}-system-log`,
			timestamp: now,
			source: 'system',
			text: `${name} seeded for Agent CRUD provider coverage.`,
		},
	];

	return {
		id,
		name,
		toolType,
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
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		executionQueue: [],
		activeTimeMs: 0,
		fileTreeAutoRefreshInterval: 180,
		aiTabs: [
			{
				id: tabId,
				agentSessionId,
				name: 'Main',
				starred: false,
				logs: aiLogs,
				inputValue: '',
				stagedImages: [],
				createdAt: now,
				state: 'idle',
			},
		],
		activeTabId: tabId,
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [{ type: 'ai', id: tabId }],
		unifiedClosedTabHistory: [],
	};
}

async function stubProviderDetection(
	electronApp: ElectronApplication,
	providers: ProviderMatrixRow[] = PROVIDER_MATRIX
) {
	await electronApp.evaluate(({ ipcMain }, rows) => {
		const capabilities = { supportsBatchMode: true, supportsModelSelection: false };
		const agents = rows.map((row) => ({
			id: row.id,
			name: row.displayName,
			binaryName: row.binaryName,
			command: row.command,
			args: [],
			available: true,
			path: row.customPath,
			capabilities,
		}));

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
	}, providers);
}

async function stubCodexAgentSessionStorage(electronApp: ElectronApplication, projectPath: string) {
	await electronApp.evaluate(
		({ ipcMain }, payload) => {
			const state = globalThis as typeof globalThis & {
				__maestroE2eAgentCrudSearchCalls?: AgentSessionSearchCall[];
			};
			const now = Date.parse('2026-02-03T05:00:00Z');
			const sessions = [
				{
					sessionId: 'codex-provider-review',
					projectPath: payload.projectPath,
					timestamp: new Date(now - 120_000).toISOString(),
					modifiedAt: new Date(now - 30_000).toISOString(),
					firstMessage: 'Review provider setup sentinel coverage',
					messageCount: 2,
					sizeBytes: 2048,
					costUsd: 0.05,
					inputTokens: 400,
					outputTokens: 180,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
					durationSeconds: 31,
					origin: 'user' as const,
					sessionName: 'Provider Setup Review',
					starred: true,
				},
				{
					sessionId: 'codex-provider-unnamed',
					projectPath: payload.projectPath,
					timestamp: new Date(now - 90_000).toISOString(),
					modifiedAt: new Date(now - 60_000).toISOString(),
					firstMessage: 'Unnamed provider setup sentinel',
					messageCount: 1,
					sizeBytes: 1024,
					costUsd: 0,
					inputTokens: 160,
					outputTokens: 80,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
					durationSeconds: 12,
					origin: undefined,
					sessionName: undefined,
					starred: false,
				},
			];
			const messagesBySession = {
				'codex-provider-review': [
					{
						type: 'user',
						content: 'Review provider setup sentinel coverage.',
						timestamp: new Date(now - 120_000).toISOString(),
						uuid: 'provider-review-user',
					},
					{
						type: 'assistant',
						content: 'Provider setup response sentinel for Agent Sessions search.',
						timestamp: new Date(now - 110_000).toISOString(),
						uuid: 'provider-review-assistant',
					},
				],
				'codex-provider-unnamed': [
					{
						type: 'user',
						content: 'Unnamed provider setup sentinel.',
						timestamp: new Date(now - 90_000).toISOString(),
						uuid: 'provider-unnamed-user',
					},
				],
			};

			state.__maestroE2eAgentCrudSearchCalls = [];

			ipcMain.removeHandler('agentSessions:getOrigins');
			ipcMain.handle(
				'agentSessions:getOrigins',
				async (_event, _agentId: string, requestedPath: string) =>
					requestedPath === payload.projectPath
						? {
								'codex-provider-review': {
									origin: 'user',
									sessionName: 'Provider Setup Review',
									starred: true,
								},
								'codex-provider-unnamed': {},
							}
						: {}
			);
			ipcMain.removeHandler('agentSessions:listPaginated');
			ipcMain.handle(
				'agentSessions:listPaginated',
				async (_event, _agentId: string, requestedPath: string) => {
					const matchingSessions = requestedPath === payload.projectPath ? sessions : [];
					return {
						sessions: matchingSessions,
						hasMore: false,
						totalCount: matchingSessions.length,
						nextCursor: null,
					};
				}
			);
			ipcMain.removeHandler('agentSessions:read');
			ipcMain.handle(
				'agentSessions:read',
				async (_event, _agentId: string, _projectPath: string, sessionId: string) => {
					const messages = messagesBySession[sessionId as keyof typeof messagesBySession] || [];
					return { messages, total: messages.length, hasMore: false };
				}
			);
			ipcMain.removeHandler('agentSessions:search');
			ipcMain.handle(
				'agentSessions:search',
				async (_event, agentId: string, requestedPath: string, query: string, mode: string) => {
					state.__maestroE2eAgentCrudSearchCalls?.push({
						agentId,
						projectPath: requestedPath,
						query,
						mode,
					});

					if (requestedPath !== payload.projectPath || !query.trim()) return [];

					return [
						{
							sessionId: 'codex-provider-review',
							matchType: 'assistant',
							matchPreview: 'Provider setup response sentinel for Agent Sessions search.',
							matchCount: 1,
						},
					];
				}
			);
		},
		{ projectPath }
	);
}

async function getAgentSessionSearchCalls(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eAgentCrudSearchCalls?: AgentSessionSearchCall[];
		};
		return state.__maestroE2eAgentCrudSearchCalls || [];
	});
}

async function openCreateAgentDialog(window: Page) {
	await window.getByRole('button', { name: /New Agent/ }).click();
	const dialog = window.getByRole('dialog', { name: 'Create New Agent' });
	await expect(dialog).toBeVisible();
	return dialog;
}

async function openAgentSessions(window: Page, agentName: string) {
	const quickActionsDialog = window.getByRole('dialog', { name: 'Quick Actions' });
	for (let attempt = 0; attempt < 3; attempt++) {
		if (await quickActionsDialog.isVisible().catch(() => false)) break;
		await window.bringToFront();
		await window.keyboard.press('Meta+K');
		await quickActionsDialog.waitFor({ state: 'visible', timeout: 1000 }).catch(() => undefined);
	}
	await expect(quickActionsDialog).toBeVisible();
	await quickActionsDialog
		.getByPlaceholder('Type a command or jump to agent...')
		.fill('View Agent Sessions');
	await quickActionsDialog.getByRole('button', { name: /View Agent Sessions/ }).click();

	await expect(quickActionsDialog).toBeHidden();
	await expect(window.getByText(`Agent Sessions for ${agentName}`)).toBeVisible();
	return window;
}

test.describe('Agent CRUD provider setup matrix', () => {
	for (const provider of PROVIDER_MATRIX) {
		test(`creates a ${provider.displayName} agent from the provider setup matrix`, async () => {
			const seeded = createAgentCrudWorkbench();
			const launched = await helpers.launchAppWithState({
				homeDir: seeded.homeDir,
				sessions: [seeded.sessions[0]],
			});
			const newProjectDir = path.join(seeded.homeDir, `${provider.id}-created-project`);
			fs.mkdirSync(newProjectDir, { recursive: true });

			try {
				await stubProviderDetection(launched.electronApp);

				const createAgentDialog = await openCreateAgentDialog(launched.window);
				await createAgentDialog
					.getByRole('option', { name: new RegExp(provider.displayName) })
					.click();
				await createAgentDialog
					.getByPlaceholder(`/path/to/${provider.binaryName}`)
					.fill(provider.customPath);
				await createAgentDialog.getByLabel('Agent Name').fill(provider.createName);
				await createAgentDialog.getByLabel('Working Directory').fill(newProjectDir);

				await expect(createAgentDialog.getByRole('button', { name: 'Create Agent' })).toBeEnabled();
				await createAgentDialog.getByRole('button', { name: 'Create Agent' }).click();
				await expect(createAgentDialog).toBeHidden();

				const sessionList = launched.window.locator('[data-tour="session-list"]');
				await expect(sessionList.getByText(provider.createName, { exact: true })).toBeVisible();
			} finally {
				await launched.cleanup();
			}
		});
	}
});

test.describe('Agent CRUD lifecycle', () => {
	test('renames an existing agent from the left bar context menu', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const sessionList = launched.window.locator('[data-tour="session-list"]');
			await sessionList.getByText('Matrix Codex Agent', { exact: true }).click({ button: 'right' });
			await launched.window.getByRole('button', { name: 'Rename' }).click();

			const renameDialog = launched.window.getByRole('dialog', { name: 'Rename Agent' });
			await expect(renameDialog).toBeVisible();
			await renameDialog.getByRole('textbox').fill('Matrix Codex Agent Renamed');
			await renameDialog.getByRole('button', { name: 'Rename' }).click();

			await expect(renameDialog).toBeHidden();
			await expect(
				sessionList.getByText('Matrix Codex Agent Renamed', { exact: true })
			).toBeVisible();
			await expect(sessionList.getByText('Matrix Codex Agent', { exact: true })).toHaveCount(0);
		} finally {
			await launched.cleanup();
		}
	});

	test('cancels agent deletion without removing the selected provider row', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const sessionList = launched.window.locator('[data-tour="session-list"]');
			await sessionList.getByText('Matrix Claude Code Agent', { exact: true }).click({
				button: 'right',
			});
			await launched.window.getByRole('button', { name: 'Remove Agent' }).click();

			const confirmDialog = launched.window.getByRole('dialog', { name: 'Confirm Delete' });
			await expect(confirmDialog.getByText('Matrix Claude Code Agent')).toBeVisible();
			await expect(
				confirmDialog.getByRole('button', { name: 'Agent + Working Directory' })
			).toBeDisabled();
			await confirmDialog.getByRole('button', { name: 'Cancel' }).click();

			await expect(confirmDialog).toBeHidden();
			await expect(
				sessionList.getByText('Matrix Claude Code Agent', { exact: true })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('removes an agent only and keeps remaining provider rows available', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const sessionList = launched.window.locator('[data-tour="session-list"]');
			await sessionList.getByText('Matrix OpenCode Agent', { exact: true }).click({
				button: 'right',
			});
			await launched.window.getByRole('button', { name: 'Remove Agent' }).click();

			const confirmDialog = launched.window.getByRole('dialog', { name: 'Confirm Delete' });
			await expect(confirmDialog.getByText('Matrix OpenCode Agent')).toBeVisible();
			await confirmDialog.getByRole('button', { name: 'Agent Only' }).click();

			await expect(confirmDialog).toBeHidden();
			await expect(sessionList.getByText('Matrix OpenCode Agent', { exact: true })).toHaveCount(0);
			await expect(sessionList.getByText('Matrix Codex Agent', { exact: true })).toBeVisible();
			await expect(
				sessionList.getByText('Matrix Factory Droid Agent', { exact: true })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});
});

test.describe('Agent Sessions provider storage', () => {
	test('lists stubbed provider sessions and applies the named-only filter', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});

		try {
			await stubCodexAgentSessionStorage(launched.electronApp, seeded.projectDir);

			const agentSessions = await openAgentSessions(launched.window, 'Matrix Codex Agent');
			await expect(agentSessions.getByText('Provider Setup Review')).toBeVisible();
			await expect(agentSessions.getByText('Unnamed provider setup sentinel')).toBeVisible();

			const namedFilter = agentSessions.getByRole('checkbox', { name: 'Named' });
			await namedFilter.check();
			await expect(agentSessions.getByText('Provider Setup Review')).toBeVisible();
			await expect(agentSessions.getByText('Unnamed provider setup sentinel')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test('routes Agent Sessions content search through generic provider storage', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});

		try {
			await stubCodexAgentSessionStorage(launched.electronApp, seeded.projectDir);

			const agentSessions = await openAgentSessions(launched.window, 'Matrix Codex Agent');
			const searchInput = agentSessions.getByPlaceholder('Search all content...');
			await searchInput.fill('provider setup response sentinel');

			await expect(agentSessions.getByText('Provider setup response sentinel')).toBeVisible();
			await expect(await getAgentSessionSearchCalls(launched.electronApp)).toContainEqual({
				agentId: 'codex',
				projectPath: seeded.projectDir,
				query: 'provider setup response sentinel',
				mode: 'all',
			});
		} finally {
			await launched.cleanup();
		}
	});
});

test.describe.skip('Real provider state coverage gated by MAESTRO_E2E_REAL_PROVIDER_STATE', () => {
	test('loads real Codex provider sessions without IPC stubs', async () => {});
	test('loads real Factory Droid provider sessions without IPC stubs', async () => {});
});
