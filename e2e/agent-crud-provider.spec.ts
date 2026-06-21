/**
 * E2E Tests: Agent CRUD, provider setup, and Agent Sessions.
 *
 * This tranche authors deterministic coverage only. Provider detection and
 * provider session storage are stubbed so later execution does not require real
 * CLI installs, auth state, or provider history.
 */
import { test, expect, helpers } from './fixtures/electron-app';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
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

type AgentSessionUpdate =
	| {
			type: 'starred';
			agentId: string;
			projectPath: string;
			sessionId: string;
			starred: boolean;
	  }
	| {
			type: 'name';
			agentId: string;
			projectPath: string;
			sessionId: string;
			name: string | null;
	  };

type AgentSessionReadCall = {
	agentId: string;
	projectPath: string;
	sessionId: string;
};

type ProviderDetectionOptions = {
	refreshAvailableProviderIds?: ProviderMatrixRow['id'][];
};

type ProviderSshRemote = {
	id: string;
	name: string;
	host: string;
	port: number;
	username: string;
	privateKeyPath: string;
	enabled: boolean;
};

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

function createProviderSshRemote(): ProviderSshRemote {
	return {
		id: 'provider-ssh-e2e',
		name: 'Provider Build Host',
		host: 'provider.example.local',
		port: 22,
		username: 'maestro',
		privateKeyPath: '~/.ssh/id_ed25519',
		enabled: true,
	};
}

async function stubProviderDetection(
	electronApp: ElectronApplication,
	providers: ProviderMatrixRow[] = PROVIDER_MATRIX,
	unavailableProviderIds: ProviderMatrixRow['id'][] = [],
	options: ProviderDetectionOptions = {}
) {
	await electronApp.evaluate(
		({ ipcMain }, payload) => {
			const buildAgents = (unavailableIds: string[]) =>
				payload.providers.map((row) => {
					const available = !unavailableIds.includes(row.id);
					return {
						id: row.id,
						name: row.displayName,
						binaryName: row.binaryName,
						command: row.command,
						args: [],
						available,
						path: available ? row.customPath : null,
						capabilities: {
							supportsBatchMode: true,
							supportsModelSelection: row.id === 'codex' || row.id === 'opencode',
						},
						configOptions: [
							{
								key: 'model',
								type: 'text',
								label: 'Model',
								description: 'Model override for deterministic provider configuration coverage.',
								default: '',
							},
							{
								key: 'contextWindow',
								type: 'number',
								label: 'Context Window Size',
								description: 'Context window size used by the session context widget.',
								default: row.id === 'codex' ? 400000 : 128000,
							},
						],
					};
				});
			const buildDebugInfo = (agentId: string, agentsForDebug: ReturnType<typeof buildAgents>) => {
				const agent = agentsForDebug.find((candidate) => candidate.id === agentId);
				const binaryName = agent?.binaryName ?? agentId;
				return {
					agentId,
					available: agent?.available ?? false,
					path: agent?.path ?? null,
					binaryName,
					envPath: '/usr/local/bin:/usr/bin:/bin',
					homeDir: '/tmp/maestro-e2e-provider-refresh',
					platform: 'darwin',
					whichCommand: 'which',
					error: agent?.available
						? null
						: `which ${binaryName} failed (exit code 1): Binary not found in PATH`,
				};
			};
			let agents = buildAgents(payload.unavailableProviderIds);

			ipcMain.removeHandler('agents:detect');
			ipcMain.handle('agents:detect', async () => agents);
			ipcMain.removeHandler('agents:refresh');
			ipcMain.handle('agents:refresh', async (_event, agentId: string) => {
				const refreshAvailableProviderIds = payload.options.refreshAvailableProviderIds ?? [];
				const refreshedUnavailableProviderIds = payload.unavailableProviderIds.filter(
					(id) => !refreshAvailableProviderIds.includes(id)
				);
				agents = buildAgents(refreshedUnavailableProviderIds);
				return {
					agents,
					debugInfo: agentId ? buildDebugInfo(agentId, agents) : null,
				};
			});
			ipcMain.removeHandler('agents:getConfig');
			ipcMain.handle('agents:getConfig', async () => ({}));
			ipcMain.removeHandler('agents:setConfig');
			ipcMain.handle('agents:setConfig', async () => true);
			ipcMain.removeHandler('agents:getModels');
			ipcMain.handle('agents:getModels', async () => []);
		},
		{ providers, unavailableProviderIds, options }
	);
}

async function stubSshRemoteConfigs(
	electronApp: ElectronApplication,
	remotes: ProviderSshRemote[]
) {
	await electronApp.evaluate(({ ipcMain }, remoteConfigs) => {
		ipcMain.removeHandler('ssh-remote:getConfigs');
		ipcMain.handle('ssh-remote:getConfigs', async () => ({
			success: true,
			configs: remoteConfigs,
		}));

		ipcMain.removeHandler('fs:stat');
		ipcMain.handle('fs:stat', async (_event, filePath: string, sshRemoteId?: string) => {
			if (sshRemoteId && !remoteConfigs.some((remote) => remote.id === sshRemoteId)) {
				throw new Error(`SSH remote not found: ${sshRemoteId}`);
			}

			const timestamp = '2026-02-03T04:05:06.000Z';
			return {
				size: 4096,
				createdAt: timestamp,
				modifiedAt: timestamp,
				isDirectory: true,
				isFile: false,
				path: filePath,
			};
		});
	}, remotes);
}

async function stubCodexAgentSessionStorage(
	electronApp: ElectronApplication,
	projectPath: string,
	options: { includeHiddenAgentSession?: boolean } = {}
) {
	await electronApp.evaluate(
		({ ipcMain }, payload) => {
			const state = globalThis as typeof globalThis & {
				__maestroE2eAgentCrudSearchCalls?: AgentSessionSearchCall[];
				__maestroE2eAgentCrudSessionUpdates?: AgentSessionUpdate[];
				__maestroE2eAgentCrudSessionReads?: AgentSessionReadCall[];
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
				...(payload.options.includeHiddenAgentSession
					? [
							{
								sessionId: 'agent-provider-hidden',
								projectPath: payload.projectPath,
								timestamp: new Date(now - 75_000).toISOString(),
								modifiedAt: new Date(now - 45_000).toISOString(),
								firstMessage: 'Hidden provider automation sentinel',
								messageCount: 1,
								sizeBytes: 512,
								costUsd: 0.01,
								inputTokens: 90,
								outputTokens: 45,
								cacheReadTokens: 0,
								cacheCreationTokens: 0,
								durationSeconds: 8,
								origin: 'auto' as const,
								sessionName: 'Hidden Provider Run',
								starred: false,
							},
						]
					: []),
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
				'agent-provider-hidden': [
					{
						type: 'assistant',
						content: 'Hidden provider detail sentinel.',
						timestamp: new Date(now - 75_000).toISOString(),
						uuid: 'provider-hidden-assistant',
					},
				],
			};

			state.__maestroE2eAgentCrudSearchCalls = [];
			state.__maestroE2eAgentCrudSessionUpdates = [];
			state.__maestroE2eAgentCrudSessionReads = [];

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
								...(payload.options.includeHiddenAgentSession
									? {
											'agent-provider-hidden': {
												origin: 'auto',
												sessionName: 'Hidden Provider Run',
												starred: false,
											},
										}
									: {}),
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
				async (_event, agentId: string, requestedPath: string, sessionId: string) => {
					state.__maestroE2eAgentCrudSessionReads?.push({
						agentId,
						projectPath: requestedPath,
						sessionId,
					});
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

					if (
						requestedPath !== payload.projectPath ||
						!query.trim() ||
						query.toLowerCase().includes('missing')
					) {
						return [];
					}
					const preview =
						mode === 'user'
							? 'Review provider setup sentinel coverage.'
							: 'Provider setup response sentinel for Agent Sessions search.';

					return [
						{
							sessionId: 'codex-provider-review',
							matchType: mode === 'user' ? 'user' : 'assistant',
							matchPreview: preview,
							matchCount: 1,
						},
					];
				}
			);
			ipcMain.removeHandler('agentSessions:setSessionStarred');
			ipcMain.handle(
				'agentSessions:setSessionStarred',
				async (
					_event,
					agentId: string,
					requestedPath: string,
					sessionId: string,
					starred: boolean
				) => {
					state.__maestroE2eAgentCrudSessionUpdates?.push({
						type: 'starred',
						agentId,
						projectPath: requestedPath,
						sessionId,
						starred,
					});
					return true;
				}
			);
			ipcMain.removeHandler('agentSessions:setSessionName');
			ipcMain.handle(
				'agentSessions:setSessionName',
				async (
					_event,
					agentId: string,
					requestedPath: string,
					sessionId: string,
					name: string | null
				) => {
					state.__maestroE2eAgentCrudSessionUpdates?.push({
						type: 'name',
						agentId,
						projectPath: requestedPath,
						sessionId,
						name,
					});
					return true;
				}
			);
		},
		{ projectPath, options }
	);
}

async function stubSelectFolderDialog(electronApp: ElectronApplication, folderPath: string) {
	await electronApp.evaluate(({ ipcMain }, selectedFolder: string) => {
		ipcMain.removeHandler('dialog:selectFolder');
		ipcMain.handle('dialog:selectFolder', async () => selectedFolder);
	}, folderPath);
}

async function getAgentSessionSearchCalls(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eAgentCrudSearchCalls?: AgentSessionSearchCall[];
		};
		return state.__maestroE2eAgentCrudSearchCalls || [];
	});
}

async function getAgentSessionUpdates(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eAgentCrudSessionUpdates?: AgentSessionUpdate[];
		};
		return state.__maestroE2eAgentCrudSessionUpdates || [];
	});
}

async function getAgentSessionReadCalls(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eAgentCrudSessionReads?: AgentSessionReadCall[];
		};
		return state.__maestroE2eAgentCrudSessionReads || [];
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
	return quickActionsDialog;
}

async function openCreateNewAgentFromQuickActions(window: Page) {
	const quickActionsDialog = await openQuickActions(window);
	await quickActionsDialog
		.getByPlaceholder('Type a command or jump to agent...')
		.fill('Create New Agent');
	await quickActionsDialog.getByRole('button', { name: /Create New Agent/ }).click();

	await expect(quickActionsDialog).toBeHidden();
	const dialog = window.getByRole('dialog', { name: 'Create New Agent' });
	await expect(dialog).toBeVisible();
	return dialog;
}

async function openCreateAgentDialog(window: Page) {
	await window.getByRole('button', { name: /New Agent/ }).click();
	const dialog = window.getByRole('dialog', { name: 'Create New Agent' });
	await expect(dialog).toBeVisible();
	return dialog;
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function openAgentSessions(window: Page, agentName: string) {
	const quickActionsDialog = await openQuickActions(window);
	await quickActionsDialog
		.getByPlaceholder('Type a command or jump to agent...')
		.fill('View Agent Sessions');
	await quickActionsDialog.getByRole('button', { name: /View Agent Sessions/ }).click();

	await expect(quickActionsDialog).toBeHidden();
	await expect(window.getByText(`Agent Sessions for ${agentName}`)).toBeVisible();
	return window;
}

async function selectAgentSessionsSearchMode(agentSessions: Page, label: string) {
	await agentSessions.getByRole('button', { name: /^(All|title|user|assistant)$/i }).click();
	await agentSessions.getByRole('button', { name: new RegExp(escapeRegExp(label)) }).click();
}

async function openEditAgentDialog(window: Page, agentName: string) {
	const sessionList = window.locator('[data-tour="session-list"]');
	await sessionList.getByText(agentName, { exact: true }).click();

	const quickActionsDialog = await openQuickActions(window);
	await quickActionsDialog
		.getByPlaceholder('Type a command or jump to agent...')
		.fill('Edit Agent');
	await quickActionsDialog
		.getByRole('button', { name: new RegExp(`Edit Agent: ${escapeRegExp(agentName)}`) })
		.click();

	await expect(quickActionsDialog).toBeHidden();
	const dialog = window.getByRole('dialog', { name: `Edit Agent: ${agentName}` });
	await expect(dialog).toBeVisible();
	return dialog;
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

function getModelInput(dialog: Locator) {
	return dialog.getByText('Model', { exact: true }).locator('..').getByRole('textbox');
}

function getContextWindowInput(dialog: Locator) {
	return dialog
		.getByText('Context Window Size', { exact: true })
		.locator('..')
		.getByRole('spinbutton');
}

async function expectCodexProviderSettings(dialog: Locator) {
	await expect(dialog.getByPlaceholder('/path/to/codex')).toBeVisible();
}

async function expectOpenCodeProviderSettings(dialog: Locator) {
	await expect(dialog.getByPlaceholder('/path/to/opencode')).toBeVisible();
}

function getSshRemoteSelect(dialog: Locator, remoteId: string) {
	return dialog
		.getByText('SSH Remote Execution', { exact: true })
		.locator('..')
		.locator(`select:has(option[value="${remoteId}"])`);
}

async function addCustomEnvVar(dialog: Locator, key: string, value: string) {
	await dialog.getByRole('button', { name: 'Add Variable' }).click();
	const keyInput = dialog.getByPlaceholder('VARIABLE_NAME').last();
	await keyInput.fill(key);
	await keyInput.blur();
	await dialog.getByPlaceholder('value', { exact: true }).last().fill(value);
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

	test('blocks Create New Agent when the requested name already exists', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});
		const newProjectDir = path.join(seeded.homeDir, 'duplicate-name-project');
		fs.mkdirSync(newProjectDir, { recursive: true });

		try {
			await stubProviderDetection(launched.electronApp);

			const createAgentDialog = await openCreateAgentDialog(launched.window);
			await createAgentDialog.getByRole('option', { name: /Codex/ }).click();
			await createAgentDialog.getByLabel('Agent Name').fill('Matrix Codex Agent');
			await createAgentDialog.getByLabel('Working Directory').fill(newProjectDir);

			await expect(
				createAgentDialog.getByText('An agent named "Matrix Codex Agent" already exists')
			).toBeVisible();
			await expect(createAgentDialog.getByRole('button', { name: 'Create Agent' })).toBeDisabled();

			await createAgentDialog.getByLabel('Agent Name').fill('Matrix Codex Agent Copy');
			await expect(
				createAgentDialog.getByText('An agent named "Matrix Codex Agent" already exists')
			).toBeHidden();
			await expect(createAgentDialog.getByRole('button', { name: 'Create Agent' })).toBeEnabled();
		} finally {
			await launched.cleanup();
		}
	});

	test('requires directory-conflict acknowledgment before creating a colocated agent', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubProviderDetection(launched.electronApp);

			const createAgentDialog = await openCreateAgentDialog(launched.window);
			await createAgentDialog.getByRole('option', { name: /Codex/ }).click();
			await createAgentDialog.getByLabel('Agent Name').fill('Matrix Codex Colocated');
			await createAgentDialog.getByLabel('Working Directory').fill(seeded.projectDir);

			await expect(
				createAgentDialog.getByText(
					/This directory is already used by "Matrix Codex Agent", "Matrix Claude Code Agent"/
				)
			).toBeVisible();
			await expect(createAgentDialog.getByRole('button', { name: 'Create Agent' })).toBeDisabled();

			await createAgentDialog.getByLabel('I understand the risk and want to proceed').check();
			await expect(createAgentDialog.getByRole('button', { name: 'Create Agent' })).toBeEnabled();
		} finally {
			await launched.cleanup();
		}
	});

	test('requires a custom path before creating an unavailable beta provider agent', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});
		const newProjectDir = path.join(seeded.homeDir, 'opencode-unavailable-project');
		fs.mkdirSync(newProjectDir, { recursive: true });

		try {
			await stubProviderDetection(launched.electronApp, PROVIDER_MATRIX, ['opencode']);

			const createAgentDialog = await openCreateAgentDialog(launched.window);
			await createAgentDialog.getByRole('option', { name: /OpenCode/ }).click();
			await createAgentDialog.getByLabel('Agent Name').fill('Unavailable OpenCode Agent');
			await createAgentDialog.getByLabel('Working Directory').fill(newProjectDir);

			const createButton = createAgentDialog.getByRole('button', { name: 'Create Agent' });
			const providerPath = createAgentDialog.getByPlaceholder('/path/to/opencode');
			await expect(createButton).toBeDisabled();
			await providerPath.fill('   ');
			await expect(createButton).toBeDisabled();

			await createAgentDialog
				.getByPlaceholder('--flag value --another-flag')
				.fill('--model provider-fallback-e2e');
			await createAgentDialog.getByRole('button', { name: 'Add Variable' }).click();
			await createAgentDialog.getByPlaceholder('VARIABLE_NAME').fill('OPENCODE_CREATE_E2E');
			await createAgentDialog.getByPlaceholder('VARIABLE_NAME').blur();
			await createAgentDialog.getByPlaceholder('value', { exact: true }).fill('enabled');
			await expect(createButton).toBeDisabled();

			await providerPath.fill('/usr/local/bin/opencode-create-e2e');
			await expect(createButton).toBeEnabled();
			await expect(createAgentDialog.getByPlaceholder('--flag value --another-flag')).toHaveValue(
				'--model provider-fallback-e2e'
			);
			await expect(createAgentDialog.getByPlaceholder('VARIABLE_NAME')).toHaveValue(
				'OPENCODE_CREATE_E2E'
			);
			await expect(createAgentDialog.getByPlaceholder('value', { exact: true })).toHaveValue(
				'enabled'
			);
		} finally {
			await launched.cleanup();
		}
	});
});

test.describe('Agent duplicate and destructive delete flows', () => {
	test('opens Create New Agent from Quick Actions with provider setup controls', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubProviderDetection(launched.electronApp);

			const createAgentDialog = await openCreateNewAgentFromQuickActions(launched.window);
			await expect(createAgentDialog.getByRole('option', { name: /Codex/ })).toBeVisible();
			await expect(createAgentDialog.getByRole('option', { name: /Claude Code/ })).toBeVisible();
			await expect(createAgentDialog.getByRole('option', { name: /OpenCode/ })).toBeVisible();
			await expect(createAgentDialog.getByRole('option', { name: /Factory Droid/ })).toBeVisible();
			await expect(createAgentDialog.getByLabel('Agent Name')).toBeVisible();
			await expect(createAgentDialog.getByLabel('Working Directory')).toBeVisible();
			await expect(createAgentDialog.getByRole('button', { name: 'Create Agent' })).toBeDisabled();
		} finally {
			await launched.cleanup();
		}
	});

	test('cancels provider agent duplication without adding a copy', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubProviderDetection(launched.electronApp);

			const contextMenu = await openSessionContextMenu(
				launched.window,
				'Matrix Codex Agent',
				'Duplicate...'
			);
			await contextMenu.getByRole('button', { name: 'Duplicate...', exact: true }).click();

			const createAgentDialog = launched.window.getByRole('dialog', { name: 'Create New Agent' });
			await expect(createAgentDialog).toBeVisible();
			await expect(createAgentDialog.getByLabel('Agent Name')).toHaveValue(
				'Matrix Codex Agent (Copy)'
			);
			await expect(createAgentDialog.getByLabel('Working Directory')).toHaveValue(
				seeded.projectDir
			);
			await createAgentDialog.getByRole('button', { name: 'Cancel' }).click();

			await expect(createAgentDialog).toBeHidden();
			await expect(
				launched.window
					.locator('[data-tour="session-list"]')
					.getByText('Matrix Codex Agent (Copy)', { exact: true })
			).toHaveCount(0);
		} finally {
			await launched.cleanup();
		}
	});

	test('duplicates a provider agent from the context menu with folder picker creation', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});
		const duplicateDir = path.join(seeded.homeDir, 'matrix-codex-copy-project');
		fs.mkdirSync(duplicateDir, { recursive: true });

		try {
			await stubProviderDetection(launched.electronApp);
			await stubSelectFolderDialog(launched.electronApp, duplicateDir);

			const contextMenu = await openSessionContextMenu(
				launched.window,
				'Matrix Codex Agent',
				'Duplicate...'
			);
			await contextMenu.getByRole('button', { name: 'Duplicate...', exact: true }).click();

			const createAgentDialog = launched.window.getByRole('dialog', { name: 'Create New Agent' });
			await expect(createAgentDialog).toBeVisible();
			await expect(createAgentDialog.getByRole('option', { name: /Codex/ })).toHaveAttribute(
				'aria-selected',
				'true'
			);
			await expect(createAgentDialog.getByText(/This directory is already used by/)).toBeVisible();
			await createAgentDialog.getByLabel('Agent Name').fill('Matrix Codex Agent Copy');
			await createAgentDialog.getByRole('button', { name: /Browse folders/ }).click();
			await expect(createAgentDialog.getByLabel('Working Directory')).toHaveValue(duplicateDir);
			await expect(createAgentDialog.getByText(/This directory is already used by/)).toBeHidden();

			await expect(createAgentDialog.getByRole('button', { name: 'Create Agent' })).toBeEnabled();
			await createAgentDialog.getByRole('button', { name: 'Create Agent' }).click();
			await expect(createAgentDialog).toBeHidden();
			await expect(
				launched.window
					.locator('[data-tour="session-list"]')
					.getByText('Matrix Codex Agent Copy', { exact: true })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('removes a disposable provider agent only while preserving its working directory', async () => {
		const seeded = createAgentCrudWorkbench();
		const disposableDir = path.join(seeded.homeDir, 'agent-only-delete-project');
		fs.mkdirSync(path.join(disposableDir, 'nested'), { recursive: true });
		fs.writeFileSync(path.join(disposableDir, 'nested', 'sentinel.txt'), 'keep me', 'utf-8');
		const disposableSession = createSeedSession({
			id: 'agent-crud-disposable-agent-only',
			name: 'Disposable Agent Only',
			toolType: 'codex',
			projectDir: disposableDir,
			now: Date.parse('2026-02-03T06:00:00Z'),
			agentSessionId: 'thread_agent_crud_disposable_agent_only',
		});
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [...seeded.sessions, disposableSession],
		});

		try {
			const contextMenu = await openSessionContextMenu(
				launched.window,
				'Disposable Agent Only',
				'Remove Agent'
			);
			await contextMenu.getByRole('button', { name: 'Remove Agent', exact: true }).click();

			const confirmDialog = launched.window.getByRole('dialog', { name: 'Confirm Delete' });
			await expect(confirmDialog.getByText('the agent "Disposable Agent Only"')).toBeVisible();
			await expect(confirmDialog.getByText(disposableDir)).toBeVisible();
			await confirmDialog.getByRole('button', { name: 'Agent Only' }).click();

			await expect(confirmDialog).toBeHidden();
			await expect(
				launched.window
					.locator('[data-tour="session-list"]')
					.getByText('Disposable Agent Only', { exact: true })
			).toHaveCount(0);
			expect(fs.existsSync(disposableDir)).toBe(true);
		} finally {
			await launched.cleanup();
		}
	});

	test('deletes a provider working directory after exact-name confirmation', async () => {
		const seeded = createAgentCrudWorkbench();
		const disposableDir = path.join(seeded.homeDir, 'agent-working-dir-delete-project');
		fs.mkdirSync(path.join(disposableDir, 'nested'), { recursive: true });
		fs.writeFileSync(path.join(disposableDir, 'nested', 'sentinel.txt'), 'delete me', 'utf-8');
		const disposableSession = createSeedSession({
			id: 'agent-crud-disposable-delete-dir',
			name: 'Disposable Delete Directory',
			toolType: 'codex',
			projectDir: disposableDir,
			now: Date.parse('2026-02-03T06:05:00Z'),
			agentSessionId: 'thread_agent_crud_disposable_delete_dir',
		});
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [...seeded.sessions, disposableSession],
		});

		try {
			const contextMenu = await openSessionContextMenu(
				launched.window,
				'Disposable Delete Directory',
				'Remove Agent'
			);
			await contextMenu.getByRole('button', { name: 'Remove Agent', exact: true }).click();

			const confirmDialog = launched.window.getByRole('dialog', { name: 'Confirm Delete' });
			const eraseButton = confirmDialog.getByRole('button', {
				name: 'Agent + Working Directory',
			});
			await expect(
				confirmDialog.getByText('the agent "Disposable Delete Directory"')
			).toBeVisible();
			await expect(confirmDialog.getByText(disposableDir)).toBeVisible();
			await expect(eraseButton).toBeDisabled();
			await confirmDialog.getByLabel('Confirm agent name').fill('Disposable Delete');
			await expect(eraseButton).toBeDisabled();
			await confirmDialog.getByLabel('Confirm agent name').fill('Disposable Delete Directory');
			await expect(eraseButton).toBeEnabled();
			await eraseButton.click();

			await expect(confirmDialog).toBeHidden();
			await expect(
				launched.window
					.locator('[data-tour="session-list"]')
					.getByText('Disposable Delete Directory', { exact: true })
			).toHaveCount(0);
			expect(fs.existsSync(disposableDir)).toBe(false);
		} finally {
			await launched.cleanup();
		}
	});
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

	test('blocks Edit Agent save when the renamed agent duplicates another provider row', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubProviderDetection(launched.electronApp);

			const editAgentDialog = await openEditAgentDialog(launched.window, 'Matrix Codex Agent');
			await editAgentDialog.getByLabel('Agent Name').fill('Matrix OpenCode Agent');

			await expect(
				editAgentDialog.getByText('An agent named "Matrix OpenCode Agent" already exists')
			).toBeVisible();
			await expect(editAgentDialog.getByRole('button', { name: 'Save Changes' })).toBeDisabled();

			await editAgentDialog.getByLabel('Agent Name').fill('Matrix Codex Agent');
			await expect(
				editAgentDialog.getByText('An agent named "Matrix OpenCode Agent" already exists')
			).toBeHidden();
			await expect(editAgentDialog.getByRole('button', { name: 'Save Changes' })).toBeEnabled();
			await editAgentDialog.getByRole('button', { name: 'Cancel' }).click();
			await expect(editAgentDialog).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test('keeps Edit Agent provider-switch drafts disabled until fallback path is provided', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubProviderDetection(launched.electronApp, PROVIDER_MATRIX, ['opencode']);

			const editAgentDialog = await openEditAgentDialog(launched.window, 'Matrix Codex Agent');
			const saveButton = editAgentDialog.getByRole('button', { name: 'Save Changes' });

			await editAgentDialog.getByRole('combobox').selectOption('opencode');
			await expect(
				editAgentDialog.getByText(/Changing the provider will clear your session list/)
			).toBeVisible();
			await expectOpenCodeProviderSettings(editAgentDialog);

			const providerPath = editAgentDialog.getByPlaceholder('/path/to/opencode');
			await expect(saveButton).toBeDisabled();
			await providerPath.fill('   ');
			await expect(saveButton).toBeDisabled();

			await editAgentDialog
				.getByPlaceholder('--flag value --another-flag')
				.fill('--model edit-provider-fallback-e2e');
			await editAgentDialog.getByRole('button', { name: 'Add Variable' }).click();
			await editAgentDialog.getByPlaceholder('VARIABLE_NAME').fill('OPENCODE_EDIT_E2E');
			await editAgentDialog.getByPlaceholder('VARIABLE_NAME').blur();
			await editAgentDialog.getByPlaceholder('value', { exact: true }).fill('draft');
			await expect(saveButton).toBeDisabled();

			await providerPath.fill('/usr/local/bin/opencode-edit-e2e');
			await expect(saveButton).toBeEnabled();
			await expect(editAgentDialog.getByPlaceholder('--flag value --another-flag')).toHaveValue(
				'--model edit-provider-fallback-e2e'
			);
			await expect(editAgentDialog.getByPlaceholder('VARIABLE_NAME')).toHaveValue(
				'OPENCODE_EDIT_E2E'
			);
			await expect(editAgentDialog.getByPlaceholder('value', { exact: true })).toHaveValue('draft');
			await editAgentDialog.getByRole('button', { name: 'Cancel' }).click();
			await expect(editAgentDialog).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test('shows provider refresh debug info for an unavailable Create New Agent provider', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});

		try {
			await stubProviderDetection(launched.electronApp, PROVIDER_MATRIX, ['opencode']);

			const createAgentDialog = await openCreateAgentDialog(launched.window);
			const opencodeOption = createAgentDialog.getByRole('option', { name: /OpenCode/ });
			await opencodeOption.click();
			await expect(opencodeOption.getByText('Not Found')).toBeVisible();

			await opencodeOption.getByTitle('Refresh detection').click();

			await expect(createAgentDialog.getByText('Debug Info: opencode not found')).toBeVisible();
			await expect(createAgentDialog.getByText(/which opencode failed/)).toBeVisible();
			await expect(createAgentDialog.getByText('/usr/local/bin')).toBeVisible();
			await createAgentDialog.getByRole('button', { name: 'Dismiss' }).click();
			await expect(createAgentDialog.getByText('Debug Info: opencode not found')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test('refreshes an unavailable provider and creates once detection succeeds', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});
		const projectDir = path.join(seeded.homeDir, 'refreshed-opencode-project');
		fs.mkdirSync(projectDir, { recursive: true });

		try {
			await stubProviderDetection(launched.electronApp, PROVIDER_MATRIX, ['opencode'], {
				refreshAvailableProviderIds: ['opencode'],
			});

			const createAgentDialog = await openCreateAgentDialog(launched.window);
			const opencodeOption = createAgentDialog.getByRole('option', { name: /OpenCode/ });
			await opencodeOption.click();
			await createAgentDialog.getByLabel('Agent Name').fill('Refreshed OpenCode Agent');
			await createAgentDialog.getByLabel('Working Directory').fill(projectDir);

			const createButton = createAgentDialog.getByRole('button', { name: 'Create Agent' });
			await expect(createButton).toBeDisabled();
			await expect(opencodeOption.getByText('Not Found')).toBeVisible();

			await opencodeOption.getByTitle('Refresh detection').click();

			await expect(opencodeOption.getByText('Available')).toBeVisible();
			await expect(createButton).toBeEnabled();
			await createButton.click();
			await expect(createAgentDialog).toBeHidden();
			await expect(
				launched.window
					.locator('[data-tour="session-list"]')
					.getByText('Refreshed OpenCode Agent', { exact: true })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('creates a provider agent using folder picker and keyboard submit', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});
		const selectedDir = path.join(seeded.homeDir, 'keyboard-folder-picker-project');
		fs.mkdirSync(selectedDir, { recursive: true });

		try {
			await stubProviderDetection(launched.electronApp);
			await stubSelectFolderDialog(launched.electronApp, selectedDir);

			const createAgentDialog = await openCreateAgentDialog(launched.window);
			await createAgentDialog.getByRole('option', { name: /Codex/ }).click();
			await createAgentDialog.getByLabel('Agent Name').fill('Keyboard Folder Agent');
			await createAgentDialog.getByRole('button', { name: /Browse folders/ }).click();
			await expect(createAgentDialog.getByLabel('Working Directory')).toHaveValue(selectedDir);

			await launched.window.keyboard.press('Control+Enter');

			await expect(createAgentDialog).toBeHidden();
			await expect(
				launched.window
					.locator('[data-tour="session-list"]')
					.getByText('Keyboard Folder Agent', { exact: true })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('cancels a filled Create New Agent provider draft without adding an agent', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});
		const projectDir = path.join(seeded.homeDir, 'cancelled-create-draft-project');
		fs.mkdirSync(projectDir, { recursive: true });

		try {
			await stubProviderDetection(launched.electronApp);

			const createAgentDialog = await openCreateAgentDialog(launched.window);
			await createAgentDialog.getByRole('option', { name: /Codex/ }).click();
			await expectCodexProviderSettings(createAgentDialog);
			await createAgentDialog.getByLabel('Agent Name').fill('Cancelled Provider Draft');
			await createAgentDialog.getByLabel('Working Directory').fill(projectDir);
			await createAgentDialog
				.getByPlaceholder('Instructions appended to every message you send...')
				.fill('This draft should be discarded on cancel.');
			await createAgentDialog.getByPlaceholder('/path/to/codex').fill('/opt/maestro/codex-cancel');
			await createAgentDialog
				.getByPlaceholder('--flag value --another-flag')
				.fill('--cancelled-create-draft');
			await addCustomEnvVar(createAgentDialog, 'CODEX_CANCEL_CREATE_E2E', 'discarded');
			await getModelInput(createAgentDialog).fill('gpt-5-codex-cancel-create');
			await getContextWindowInput(createAgentDialog).fill('255000');
			await createAgentDialog.getByRole('button', { name: 'Cancel' }).click();
			await expect(createAgentDialog).toBeHidden();

			await expect(
				launched.window
					.locator('[data-tour="session-list"]')
					.getByText('Cancelled Provider Draft', { exact: true })
			).toHaveCount(0);
		} finally {
			await launched.cleanup();
		}
	});

	test('closes a filled Create New Agent provider draft with Escape', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});
		const projectDir = path.join(seeded.homeDir, 'escape-create-draft-project');
		fs.mkdirSync(projectDir, { recursive: true });

		try {
			await stubProviderDetection(launched.electronApp);

			const createAgentDialog = await openCreateAgentDialog(launched.window);
			await createAgentDialog.getByRole('option', { name: /Codex/ }).click();
			await createAgentDialog.getByLabel('Agent Name').fill('Escaped Provider Draft');
			await createAgentDialog.getByLabel('Working Directory').fill(projectDir);
			await createAgentDialog
				.getByPlaceholder('Instructions appended to every message you send...')
				.fill('Escape should discard this create draft.');

			await launched.window.keyboard.press('Escape');

			await expect(createAgentDialog).toBeHidden();
			await expect(
				launched.window
					.locator('[data-tour="session-list"]')
					.getByText('Escaped Provider Draft', { exact: true })
			).toHaveCount(0);
		} finally {
			await launched.cleanup();
		}
	});

	test('resets Create New Agent form state after a successful provider create', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});
		const projectDir = path.join(seeded.homeDir, 'reset-after-create-project');
		fs.mkdirSync(projectDir, { recursive: true });

		try {
			await stubProviderDetection(launched.electronApp);

			const createAgentDialog = await openCreateAgentDialog(launched.window);
			await createAgentDialog.getByRole('option', { name: /Codex/ }).click();
			await createAgentDialog.getByLabel('Agent Name').fill('Reset After Create Agent');
			await createAgentDialog.getByLabel('Working Directory').fill(projectDir);
			await createAgentDialog
				.getByPlaceholder('Instructions appended to every message you send...')
				.fill('This create modal state should not leak.');
			await createAgentDialog.getByPlaceholder('/path/to/codex').fill('/opt/maestro/codex-reset');
			await createAgentDialog.getByRole('button', { name: 'Create Agent' }).click();
			await expect(createAgentDialog).toBeHidden();

			const reopenedDialog = await openCreateAgentDialog(launched.window);
			await expect(reopenedDialog.getByLabel('Agent Name')).toHaveValue('');
			await expect(reopenedDialog.getByLabel('Working Directory')).toHaveValue('');
			await reopenedDialog.getByRole('option', { name: /Codex/ }).click();
			await expect(
				reopenedDialog.getByPlaceholder('Instructions appended to every message you send...')
			).toHaveValue('');
			await expect(reopenedDialog.getByPlaceholder('/path/to/codex')).toHaveValue(
				'/usr/local/bin/codex-e2e'
			);
			await reopenedDialog.getByRole('button', { name: 'Cancel' }).click();
		} finally {
			await launched.cleanup();
		}
	});

	test('opens the Create New Agent folder picker with the keyboard shortcut', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});
		const selectedDir = path.join(seeded.homeDir, 'keyboard-folder-shortcut-project');
		fs.mkdirSync(selectedDir, { recursive: true });

		try {
			await stubProviderDetection(launched.electronApp);
			await stubSelectFolderDialog(launched.electronApp, selectedDir);

			const createAgentDialog = await openCreateAgentDialog(launched.window);
			await createAgentDialog.getByRole('option', { name: /Codex/ }).click();

			await launched.window.keyboard.press('ControlOrMeta+O');

			await expect(createAgentDialog.getByLabel('Working Directory')).toHaveValue(selectedDir);
			await createAgentDialog.getByRole('button', { name: 'Cancel' }).click();
		} finally {
			await launched.cleanup();
		}
	});

	test('keeps Create New Agent disabled until required fields are complete', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});
		const projectDir = path.join(seeded.homeDir, 'required-create-fields-project');
		fs.mkdirSync(projectDir, { recursive: true });

		try {
			await stubProviderDetection(launched.electronApp);

			const createAgentDialog = await openCreateAgentDialog(launched.window);
			await createAgentDialog.getByRole('option', { name: /Codex/ }).click();
			const createButton = createAgentDialog.getByRole('button', { name: 'Create Agent' });

			await expect(createButton).toBeDisabled();
			await createAgentDialog.getByLabel('Agent Name').fill('Required Fields Agent');
			await expect(createButton).toBeDisabled();
			await createAgentDialog.getByLabel('Working Directory').fill(projectDir);
			await expect(createButton).toBeEnabled();
			await createAgentDialog.getByLabel('Agent Name').fill('   ');
			await expect(createButton).toBeDisabled();
			await createAgentDialog.getByLabel('Agent Name').fill('Required Fields Agent');
			await expect(createButton).toBeEnabled();
		} finally {
			await launched.cleanup();
		}
	});

	test('clears Create New Agent directory warnings after choosing an unused folder', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});
		const replacementDir = path.join(seeded.homeDir, 'resolved-directory-warning-project');
		fs.mkdirSync(replacementDir, { recursive: true });

		try {
			await stubProviderDetection(launched.electronApp);

			const createAgentDialog = await openCreateAgentDialog(launched.window);
			await createAgentDialog.getByRole('option', { name: /Codex/ }).click();
			await createAgentDialog.getByLabel('Agent Name').fill('Resolved Directory Warning Agent');
			await createAgentDialog.getByLabel('Working Directory').fill(seeded.projectDir);

			const warning = createAgentDialog.getByText(
				/This directory is already used by "Matrix Codex Agent", "Matrix Claude Code Agent"/
			);
			await expect(warning).toBeVisible();
			await expect(createAgentDialog.getByRole('button', { name: 'Create Agent' })).toBeDisabled();

			await createAgentDialog.getByLabel('Working Directory').fill(replacementDir);
			await expect(warning).toBeHidden();
			await expect(createAgentDialog.getByRole('button', { name: 'Create Agent' })).toBeEnabled();
		} finally {
			await launched.cleanup();
		}
	});

	test('creates after clearing Create New Agent optional provider overrides', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});
		const projectDir = path.join(seeded.homeDir, 'cleared-create-overrides-project');
		fs.mkdirSync(projectDir, { recursive: true });

		try {
			await stubProviderDetection(launched.electronApp);

			const createAgentDialog = await openCreateAgentDialog(launched.window);
			await createAgentDialog.getByRole('option', { name: /Codex/ }).click();
			await expectCodexProviderSettings(createAgentDialog);
			await createAgentDialog.getByLabel('Agent Name').fill('Cleared Create Overrides');
			await createAgentDialog.getByLabel('Working Directory').fill(projectDir);
			await createAgentDialog.getByPlaceholder('/path/to/codex').fill('/opt/maestro/codex-clear');
			await createAgentDialog
				.getByPlaceholder('--flag value --another-flag')
				.fill('--clear-before-create');
			await addCustomEnvVar(createAgentDialog, 'CODEX_CLEAR_CREATE_E2E', 'remove-me');

			await createAgentDialog.getByRole('button', { name: 'Reset' }).click();
			await createAgentDialog.getByRole('button', { name: 'Clear' }).click();
			await createAgentDialog.getByTitle('Remove variable').click();
			await createAgentDialog.getByRole('button', { name: 'Create Agent' }).click();
			await expect(createAgentDialog).toBeHidden();

			const editAgentDialog = await openEditAgentDialog(
				launched.window,
				'Cleared Create Overrides'
			);
			await expect(editAgentDialog.getByPlaceholder('/path/to/codex')).toHaveValue(
				'/usr/local/bin/codex-e2e'
			);
			await expect(editAgentDialog.getByPlaceholder('--flag value --another-flag')).toHaveValue('');
			await expect(editAgentDialog.getByPlaceholder('VARIABLE_NAME')).toHaveCount(0);
			await editAgentDialog.getByRole('button', { name: 'Cancel' }).click();
		} finally {
			await launched.cleanup();
		}
	});

	test('saves Edit Agent changes with the keyboard shortcut', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubProviderDetection(launched.electronApp);

			const editAgentDialog = await openEditAgentDialog(launched.window, 'Matrix Codex Agent');
			await editAgentDialog.getByLabel('Agent Name').fill('Matrix Codex Keyboard Saved');
			await editAgentDialog
				.getByPlaceholder('Instructions appended to every message you send...')
				.fill('Saved through the edit modal keyboard shortcut.');

			await launched.window.keyboard.press('Control+Enter');

			await expect(editAgentDialog).toBeHidden();
			const sessionList = launched.window.locator('[data-tour="session-list"]');
			await expect(
				sessionList.getByText('Matrix Codex Keyboard Saved', { exact: true })
			).toBeVisible();
			await expect(sessionList.getByText('Matrix Codex Agent', { exact: true })).toHaveCount(0);

			const reopenedDialog = await openEditAgentDialog(
				launched.window,
				'Matrix Codex Keyboard Saved'
			);
			await expect(
				reopenedDialog.getByPlaceholder('Instructions appended to every message you send...')
			).toHaveValue('Saved through the edit modal keyboard shortcut.');
			await reopenedDialog.getByRole('button', { name: 'Cancel' }).click();
		} finally {
			await launched.cleanup();
		}
	});

	test('keeps Edit Agent save disabled while the agent name is blank', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubProviderDetection(launched.electronApp);

			const editAgentDialog = await openEditAgentDialog(launched.window, 'Matrix Codex Agent');
			const saveButton = editAgentDialog.getByRole('button', { name: 'Save Changes' });
			await expect(saveButton).toBeEnabled();

			await editAgentDialog.getByLabel('Agent Name').fill('   ');
			await expect(saveButton).toBeDisabled();
			await editAgentDialog.getByLabel('Agent Name').fill('Matrix Codex Agent');
			await expect(saveButton).toBeEnabled();
			await editAgentDialog.getByRole('button', { name: 'Cancel' }).click();
		} finally {
			await launched.cleanup();
		}
	});

	test('closes Edit Agent with Escape without saving draft changes', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubProviderDetection(launched.electronApp);

			const editAgentDialog = await openEditAgentDialog(launched.window, 'Matrix Codex Agent');
			await editAgentDialog.getByLabel('Agent Name').fill('Escaped Edit Draft');
			await editAgentDialog
				.getByPlaceholder('Instructions appended to every message you send...')
				.fill('Escape should discard this edit draft.');

			await launched.window.keyboard.press('Escape');

			await expect(editAgentDialog).toBeHidden();
			const sessionList = launched.window.locator('[data-tour="session-list"]');
			await expect(sessionList.getByText('Matrix Codex Agent', { exact: true })).toBeVisible();
			await expect(sessionList.getByText('Escaped Edit Draft', { exact: true })).toHaveCount(0);
		} finally {
			await launched.cleanup();
		}
	});

	test('keeps Create New Agent provider drafts isolated while switching providers', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});
		const projectDir = path.join(seeded.homeDir, 'switched-provider-create-project');
		fs.mkdirSync(projectDir, { recursive: true });

		try {
			await stubProviderDetection(launched.electronApp);

			const createAgentDialog = await openCreateAgentDialog(launched.window);
			const codexOption = createAgentDialog.getByRole('option', { name: /Codex/ });
			const opencodeOption = createAgentDialog.getByRole('option', { name: /OpenCode/ });

			await codexOption.click();
			await expectCodexProviderSettings(createAgentDialog);
			await createAgentDialog.getByPlaceholder('/path/to/codex').fill('/opt/maestro/codex-draft');
			await createAgentDialog
				.getByPlaceholder('--flag value --another-flag')
				.fill('--codex-draft-only');
			await addCustomEnvVar(createAgentDialog, 'CODEX_DRAFT_ONLY_E2E', 'codex');

			await opencodeOption.click();
			await expectOpenCodeProviderSettings(createAgentDialog);
			await createAgentDialog.getByLabel('Agent Name').fill('Switched OpenCode Create');
			await createAgentDialog.getByLabel('Working Directory').fill(projectDir);
			await createAgentDialog
				.getByPlaceholder('/path/to/opencode')
				.fill('/opt/maestro/opencode-create-draft');
			await createAgentDialog
				.getByPlaceholder('--flag value --another-flag')
				.fill('--opencode-create-draft');
			await addCustomEnvVar(createAgentDialog, 'OPENCODE_CREATE_DRAFT_E2E', 'opencode');

			await codexOption.click();
			await expectCodexProviderSettings(createAgentDialog);
			await expect(createAgentDialog.getByPlaceholder('/path/to/codex')).toHaveValue(
				'/opt/maestro/codex-draft'
			);
			await expect(createAgentDialog.getByPlaceholder('--flag value --another-flag')).toHaveValue(
				'--codex-draft-only'
			);
			await expect(createAgentDialog.getByPlaceholder('VARIABLE_NAME')).toHaveValue(
				'CODEX_DRAFT_ONLY_E2E'
			);

			await opencodeOption.click();
			await expectOpenCodeProviderSettings(createAgentDialog);
			await expect(createAgentDialog.getByPlaceholder('/path/to/opencode')).toHaveValue(
				'/opt/maestro/opencode-create-draft'
			);
			await expect(createAgentDialog.getByPlaceholder('--flag value --another-flag')).toHaveValue(
				'--opencode-create-draft'
			);
			await expect(createAgentDialog.getByPlaceholder('VARIABLE_NAME')).toHaveValue(
				'OPENCODE_CREATE_DRAFT_E2E'
			);

			await createAgentDialog.getByRole('button', { name: 'Create Agent' }).click();
			await expect(createAgentDialog).toBeHidden();

			const editAgentDialog = await openEditAgentDialog(
				launched.window,
				'Switched OpenCode Create'
			);
			await expect(editAgentDialog.getByRole('combobox')).toHaveValue('opencode');
			await expect(editAgentDialog.getByPlaceholder('/path/to/opencode')).toHaveValue(
				'/opt/maestro/opencode-create-draft'
			);
			await expect(editAgentDialog.getByPlaceholder('--flag value --another-flag')).toHaveValue(
				'--opencode-create-draft'
			);
			await expect(editAgentDialog.getByPlaceholder('VARIABLE_NAME')).toHaveValue(
				'OPENCODE_CREATE_DRAFT_E2E'
			);
			await expect(editAgentDialog.getByPlaceholder('value', { exact: true })).toHaveValue(
				'opencode'
			);
			await editAgentDialog.getByRole('button', { name: 'Cancel' }).click();
		} finally {
			await launched.cleanup();
		}
	});

	test('closes duplicate provider agent modal with Escape without adding a copy', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubProviderDetection(launched.electronApp);

			const contextMenu = await openSessionContextMenu(
				launched.window,
				'Matrix Codex Agent',
				'Duplicate...'
			);
			await contextMenu.getByRole('button', { name: 'Duplicate...', exact: true }).click();

			const createAgentDialog = launched.window.getByRole('dialog', { name: 'Create New Agent' });
			await expect(createAgentDialog).toBeVisible();
			await expect(createAgentDialog.getByLabel('Agent Name')).toHaveValue(
				'Matrix Codex Agent (Copy)'
			);

			await launched.window.keyboard.press('Escape');

			await expect(createAgentDialog).toBeHidden();
			await expect(
				launched.window
					.locator('[data-tour="session-list"]')
					.getByText('Matrix Codex Agent (Copy)', { exact: true })
			).toHaveCount(0);
		} finally {
			await launched.cleanup();
		}
	});

	test('cancels Edit Agent provider switch drafts without changing the agent', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubProviderDetection(launched.electronApp);

			const editAgentDialog = await openEditAgentDialog(launched.window, 'Matrix Codex Agent');
			await editAgentDialog.getByLabel('Agent Name').fill('Draft OpenCode Switch');
			await editAgentDialog.getByRole('combobox').selectOption('opencode');
			await expect(
				editAgentDialog.getByText(/Changing the provider will clear your session list/)
			).toBeVisible();
			await editAgentDialog
				.getByPlaceholder('/path/to/opencode')
				.fill('/opt/maestro/opencode-cancelled');
			await editAgentDialog
				.getByPlaceholder('--flag value --another-flag')
				.fill('--draft-provider-switch');
			await editAgentDialog.getByRole('button', { name: 'Cancel' }).click();
			await expect(editAgentDialog).toBeHidden();

			const sessionList = launched.window.locator('[data-tour="session-list"]');
			await expect(sessionList.getByText('Matrix Codex Agent', { exact: true })).toBeVisible();
			await expect(sessionList.getByText('Draft OpenCode Switch', { exact: true })).toHaveCount(0);

			const reopenedDialog = await openEditAgentDialog(launched.window, 'Matrix Codex Agent');
			await expect(reopenedDialog.getByRole('combobox')).toHaveValue('codex');
			await expect(reopenedDialog.getByPlaceholder('/path/to/codex')).toHaveValue(
				'/usr/local/bin/codex-e2e'
			);
			await expect(reopenedDialog.getByPlaceholder('--flag value --another-flag')).toHaveValue('');
			await reopenedDialog.getByRole('button', { name: 'Cancel' }).click();
		} finally {
			await launched.cleanup();
		}
	});

	test('cleans up Edit Agent provider-switch draft when switching back to the original provider', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubProviderDetection(launched.electronApp);

			const editAgentDialog = await openEditAgentDialog(launched.window, 'Matrix Codex Agent');
			await editAgentDialog.getByRole('combobox').selectOption('opencode');
			await expect(
				editAgentDialog.getByText(/Changing the provider will clear your session list/)
			).toBeVisible();
			await editAgentDialog
				.getByPlaceholder('/path/to/opencode')
				.fill('/opt/maestro/opencode-return-draft');
			await editAgentDialog.getByPlaceholder('--flag value --another-flag').fill('--return-draft');
			await addCustomEnvVar(editAgentDialog, 'OPENCODE_RETURN_DRAFT_E2E', 'discarded');

			await editAgentDialog.getByRole('combobox').selectOption('codex');
			await expect(
				editAgentDialog.getByText(/Changing the provider will clear your session list/)
			).toHaveCount(0);
			await expectCodexProviderSettings(editAgentDialog);
			await expect(editAgentDialog.getByPlaceholder('/path/to/codex')).toHaveValue(
				'/usr/local/bin/codex-e2e'
			);
			await expect(editAgentDialog.getByPlaceholder('--flag value --another-flag')).toHaveValue('');
			await expect(editAgentDialog.getByPlaceholder('VARIABLE_NAME')).toHaveCount(0);
			await editAgentDialog.getByRole('button', { name: 'Save Changes' }).click();
			await expect(editAgentDialog).toBeHidden();

			const reopenedDialog = await openEditAgentDialog(launched.window, 'Matrix Codex Agent');
			await expect(reopenedDialog.getByRole('combobox')).toHaveValue('codex');
			await expect(reopenedDialog.getByPlaceholder('/path/to/codex')).toHaveValue(
				'/usr/local/bin/codex-e2e'
			);
			await expect(reopenedDialog.getByPlaceholder('--flag value --another-flag')).toHaveValue('');
			await expect(reopenedDialog.getByPlaceholder('VARIABLE_NAME')).toHaveCount(0);
			await reopenedDialog.getByRole('button', { name: 'Cancel' }).click();
		} finally {
			await launched.cleanup();
		}
	});

	test('creates a provider agent with SSH remote execution selected', async () => {
		const seeded = createAgentCrudWorkbench();
		const remote = createProviderSshRemote();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});

		try {
			await stubProviderDetection(launched.electronApp);
			await stubSshRemoteConfigs(launched.electronApp, [remote]);

			const createAgentDialog = await openCreateAgentDialog(launched.window);
			await createAgentDialog.getByRole('option', { name: /Codex/ }).click();
			await expect(createAgentDialog.getByText('SSH Remote Execution')).toBeVisible();
			await getSshRemoteSelect(createAgentDialog, remote.id).selectOption(remote.id);
			await expect(
				createAgentDialog.getByText(/Agent will run on Provider Build Host/)
			).toBeVisible();
			await createAgentDialog.getByLabel('Agent Name').fill('Remote Provider Agent');
			await createAgentDialog.getByLabel('Working Directory').fill('/srv/maestro/remote-provider');
			await expect(createAgentDialog.getByText('Remote directory found')).toBeVisible();
			await expect(
				createAgentDialog.getByTitle(/Folder picker unavailable for SSH remote/)
			).toBeDisabled();

			await createAgentDialog.getByRole('button', { name: 'Create Agent' }).click();
			await expect(createAgentDialog).toBeHidden();

			const editAgentDialog = await openEditAgentDialog(launched.window, 'Remote Provider Agent');
			await expect(getSshRemoteSelect(editAgentDialog, remote.id)).toHaveValue(remote.id);
			await expect(
				editAgentDialog.getByText(/Agent will run on Provider Build Host/)
			).toBeVisible();
			await expect(editAgentDialog.getByText('/srv/maestro/remote-provider')).toBeVisible();
			await editAgentDialog.getByRole('button', { name: 'Cancel' }).click();
		} finally {
			await launched.cleanup();
		}
	});

	test('scopes Create New Agent directory warnings to the selected SSH host', async () => {
		const seeded = createAgentCrudWorkbench();
		const remote = createProviderSshRemote();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubProviderDetection(launched.electronApp);
			await stubSshRemoteConfigs(launched.electronApp, [remote]);

			const createAgentDialog = await openCreateAgentDialog(launched.window);
			await createAgentDialog.getByRole('option', { name: /Codex/ }).click();
			await createAgentDialog.getByLabel('Agent Name').fill('Remote Same Directory Agent');
			await createAgentDialog.getByLabel('Working Directory').fill(seeded.projectDir);

			const localWarning = createAgentDialog.getByText(
				/This directory is already used by "Matrix Codex Agent", "Matrix Claude Code Agent"/
			);
			await expect(localWarning).toBeVisible();
			await expect(createAgentDialog.getByRole('button', { name: 'Create Agent' })).toBeDisabled();

			await getSshRemoteSelect(createAgentDialog, remote.id).selectOption(remote.id);
			await expect(localWarning).toHaveCount(0);
			await expect(createAgentDialog.getByText('Remote directory found')).toBeVisible();
			await expect(createAgentDialog.getByRole('button', { name: 'Create Agent' })).toBeEnabled();
		} finally {
			await launched.cleanup();
		}
	});

	test('prefills duplicate provider agent modal with source SSH remote execution', async () => {
		const seeded = createAgentCrudWorkbench();
		const remote = createProviderSshRemote();
		const configuredSession = {
			...seeded.sessions[0],
			sessionSshRemoteConfig: { enabled: true, remoteId: remote.id },
		};
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [configuredSession, ...seeded.sessions.slice(1)],
		});

		try {
			await stubProviderDetection(launched.electronApp);
			await stubSshRemoteConfigs(launched.electronApp, [remote]);

			const contextMenu = await openSessionContextMenu(
				launched.window,
				'Matrix Codex Agent',
				'Duplicate...'
			);
			await contextMenu.getByRole('button', { name: 'Duplicate...', exact: true }).click();

			const createAgentDialog = launched.window.getByRole('dialog', { name: 'Create New Agent' });
			await expect(createAgentDialog).toBeVisible();
			await expect(createAgentDialog.getByLabel('Agent Name')).toHaveValue(
				'Matrix Codex Agent (Copy)'
			);
			await expect(createAgentDialog.getByText('SSH Remote Execution')).toBeVisible();
			await expect(getSshRemoteSelect(createAgentDialog, remote.id)).toHaveValue(remote.id);
			await expect(
				createAgentDialog.getByText(/Agent will run on Provider Build Host/)
			).toBeVisible();
			await createAgentDialog.getByRole('button', { name: 'Cancel' }).click();
		} finally {
			await launched.cleanup();
		}
	});

	test('persists Edit Agent SSH remote execution selection', async () => {
		const seeded = createAgentCrudWorkbench();
		const remote = createProviderSshRemote();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubProviderDetection(launched.electronApp);
			await stubSshRemoteConfigs(launched.electronApp, [remote]);

			const editAgentDialog = await openEditAgentDialog(launched.window, 'Matrix Codex Agent');
			await expect(editAgentDialog.getByText('SSH Remote Execution')).toBeVisible();
			await getSshRemoteSelect(editAgentDialog, remote.id).selectOption(remote.id);
			await expect(
				editAgentDialog.getByText(/Agent will run on Provider Build Host/)
			).toBeVisible();
			await expect(
				editAgentDialog.getByText(/Directory found on provider.example.local/)
			).toBeVisible();
			await editAgentDialog.getByRole('button', { name: 'Save Changes' }).click();
			await expect(editAgentDialog).toBeHidden();

			const reopenedDialog = await openEditAgentDialog(launched.window, 'Matrix Codex Agent');
			await expect(getSshRemoteSelect(reopenedDialog, remote.id)).toHaveValue(remote.id);
			await expect(reopenedDialog.getByText(/Agent will run on Provider Build Host/)).toBeVisible();
			await reopenedDialog.getByRole('button', { name: 'Cancel' }).click();
		} finally {
			await launched.cleanup();
		}
	});

	test('returns an Edit Agent SSH remote selection to local execution', async () => {
		const seeded = createAgentCrudWorkbench();
		const remote = createProviderSshRemote();
		const configuredSession = {
			...seeded.sessions[0],
			sessionSshRemoteConfig: { enabled: true, remoteId: remote.id },
		};
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [configuredSession, ...seeded.sessions.slice(1)],
		});

		try {
			await stubProviderDetection(launched.electronApp);
			await stubSshRemoteConfigs(launched.electronApp, [remote]);

			const editAgentDialog = await openEditAgentDialog(launched.window, 'Matrix Codex Agent');
			await expect(getSshRemoteSelect(editAgentDialog, remote.id)).toHaveValue(remote.id);
			await getSshRemoteSelect(editAgentDialog, remote.id).selectOption('local');
			await expect(editAgentDialog.getByText('Agent will run locally')).toBeVisible();
			await editAgentDialog.getByRole('button', { name: 'Save Changes' }).click();
			await expect(editAgentDialog).toBeHidden();

			const reopenedDialog = await openEditAgentDialog(launched.window, 'Matrix Codex Agent');
			await expect(getSshRemoteSelect(reopenedDialog, remote.id)).toHaveValue('local');
			await expect(reopenedDialog.getByText('Agent will run locally')).toBeVisible();
			await reopenedDialog.getByRole('button', { name: 'Cancel' }).click();
		} finally {
			await launched.cleanup();
		}
	});

	test('cancels ordinary Edit Agent config drafts without saving changes', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubProviderDetection(launched.electronApp);

			const editAgentDialog = await openEditAgentDialog(launched.window, 'Matrix Codex Agent');
			await expectCodexProviderSettings(editAgentDialog);
			await editAgentDialog.getByLabel('Agent Name').fill('Cancelled Edit Draft');
			await editAgentDialog
				.getByPlaceholder('Instructions appended to every message you send...')
				.fill('This edit draft should be discarded on cancel.');
			await editAgentDialog
				.getByPlaceholder('/path/to/codex')
				.fill('/opt/maestro/codex-edit-cancel');
			await editAgentDialog
				.getByPlaceholder('--flag value --another-flag')
				.fill('--cancelled-edit-draft');
			await addCustomEnvVar(editAgentDialog, 'CODEX_EDIT_CANCEL_E2E', 'discarded');
			await getModelInput(editAgentDialog).fill('gpt-5-codex-edit-cancel');
			await getContextWindowInput(editAgentDialog).fill('245000');
			await editAgentDialog.getByRole('button', { name: 'Cancel' }).click();
			await expect(editAgentDialog).toBeHidden();

			const sessionList = launched.window.locator('[data-tour="session-list"]');
			await expect(sessionList.getByText('Matrix Codex Agent', { exact: true })).toBeVisible();
			await expect(sessionList.getByText('Cancelled Edit Draft', { exact: true })).toHaveCount(0);

			const reopenedDialog = await openEditAgentDialog(launched.window, 'Matrix Codex Agent');
			await expect(
				reopenedDialog.getByPlaceholder('Instructions appended to every message you send...')
			).toHaveValue('');
			await expect(reopenedDialog.getByPlaceholder('/path/to/codex')).toHaveValue(
				'/usr/local/bin/codex-e2e'
			);
			await expect(reopenedDialog.getByPlaceholder('--flag value --another-flag')).toHaveValue('');
			await expect(reopenedDialog.getByPlaceholder('VARIABLE_NAME')).toHaveCount(0);
			await expect(getModelInput(reopenedDialog)).toHaveValue('');
			await expect(getContextWindowInput(reopenedDialog)).toHaveValue('400000');
			await reopenedDialog.getByRole('button', { name: 'Cancel' }).click();
		} finally {
			await launched.cleanup();
		}
	});

	test('persists Create New Agent provider config when reopened from Edit Agent', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});
		const projectDir = path.join(seeded.homeDir, 'configured-create-project');
		fs.mkdirSync(projectDir, { recursive: true });

		try {
			await stubProviderDetection(launched.electronApp);

			const createAgentDialog = await openCreateAgentDialog(launched.window);
			await createAgentDialog.getByRole('option', { name: /Codex/ }).click();
			await expectCodexProviderSettings(createAgentDialog);
			await createAgentDialog.getByLabel('Agent Name').fill('Configured Codex Create');
			await createAgentDialog.getByLabel('Working Directory').fill(projectDir);
			await createAgentDialog
				.getByPlaceholder('Instructions appended to every message you send...')
				.fill('Prefer deterministic provider config during E2E authoring.');
			await createAgentDialog.getByPlaceholder('/path/to/codex').fill('/opt/maestro/codex-create');
			await createAgentDialog
				.getByPlaceholder('--flag value --another-flag')
				.fill('--approval-mode create-e2e');
			await addCustomEnvVar(createAgentDialog, 'CODEX_CREATE_E2E', 'enabled');
			await getModelInput(createAgentDialog).fill('gpt-5-codex-create-e2e');
			await getContextWindowInput(createAgentDialog).fill('260000');
			await createAgentDialog.getByRole('button', { name: 'Create Agent' }).click();
			await expect(createAgentDialog).toBeHidden();

			const editAgentDialog = await openEditAgentDialog(launched.window, 'Configured Codex Create');
			await expect(editAgentDialog.getByRole('combobox')).toHaveValue('codex');
			await expect(
				editAgentDialog.getByPlaceholder('Instructions appended to every message you send...')
			).toHaveValue('Prefer deterministic provider config during E2E authoring.');
			await expect(editAgentDialog.getByPlaceholder('/path/to/codex')).toHaveValue(
				'/opt/maestro/codex-create'
			);
			await expect(editAgentDialog.getByPlaceholder('--flag value --another-flag')).toHaveValue(
				'--approval-mode create-e2e'
			);
			await expect(editAgentDialog.getByPlaceholder('VARIABLE_NAME')).toHaveValue(
				'CODEX_CREATE_E2E'
			);
			await expect(editAgentDialog.getByPlaceholder('value', { exact: true })).toHaveValue(
				'enabled'
			);
			await expect(getModelInput(editAgentDialog)).toHaveValue('gpt-5-codex-create-e2e');
			await expect(getContextWindowInput(editAgentDialog)).toHaveValue('260000');
			await editAgentDialog.getByRole('button', { name: 'Cancel' }).click();
		} finally {
			await launched.cleanup();
		}
	});

	test('persists Edit Agent nudge, path, args, env, model, and context window', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubProviderDetection(launched.electronApp);

			const editAgentDialog = await openEditAgentDialog(launched.window, 'Matrix Codex Agent');
			await expectCodexProviderSettings(editAgentDialog);
			await editAgentDialog
				.getByPlaceholder('Instructions appended to every message you send...')
				.fill('Persist this nudge for resumed Codex authoring.');
			await editAgentDialog.getByPlaceholder('/path/to/codex').fill('/opt/maestro/codex-edit');
			await editAgentDialog
				.getByPlaceholder('--flag value --another-flag')
				.fill('--sandbox read-only --e2e-edit');
			await addCustomEnvVar(editAgentDialog, 'CODEX_EDIT_E2E', 'persisted');
			await getModelInput(editAgentDialog).fill('gpt-5-codex-edit-e2e');
			await getContextWindowInput(editAgentDialog).fill('275000');
			await editAgentDialog.getByRole('button', { name: 'Save Changes' }).click();
			await expect(editAgentDialog).toBeHidden();

			const reopenedDialog = await openEditAgentDialog(launched.window, 'Matrix Codex Agent');
			await expect(
				reopenedDialog.getByPlaceholder('Instructions appended to every message you send...')
			).toHaveValue('Persist this nudge for resumed Codex authoring.');
			await expect(reopenedDialog.getByPlaceholder('/path/to/codex')).toHaveValue(
				'/opt/maestro/codex-edit'
			);
			await expect(reopenedDialog.getByPlaceholder('--flag value --another-flag')).toHaveValue(
				'--sandbox read-only --e2e-edit'
			);
			await expect(reopenedDialog.getByPlaceholder('VARIABLE_NAME')).toHaveValue('CODEX_EDIT_E2E');
			await expect(reopenedDialog.getByPlaceholder('value', { exact: true })).toHaveValue(
				'persisted'
			);
			await expect(getModelInput(reopenedDialog)).toHaveValue('gpt-5-codex-edit-e2e');
			await expect(getContextWindowInput(reopenedDialog)).toHaveValue('275000');
			await reopenedDialog.getByRole('button', { name: 'Cancel' }).click();
		} finally {
			await launched.cleanup();
		}
	});

	test('clears optional Edit Agent provider config with reset and remove controls', async () => {
		const seeded = createAgentCrudWorkbench();
		const configuredSession = {
			...seeded.sessions[0],
			nudgeMessage: 'Remove this nudge.',
			customPath: '/opt/maestro/codex-existing',
			customArgs: '--existing-config',
			customEnvVars: { CODEX_EXISTING_E2E: 'before' },
			customModel: 'gpt-5-codex-existing-e2e',
			customContextWindow: 300000,
		};
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [configuredSession, ...seeded.sessions.slice(1)],
		});

		try {
			await stubProviderDetection(launched.electronApp);

			const editAgentDialog = await openEditAgentDialog(launched.window, 'Matrix Codex Agent');
			await expectCodexProviderSettings(editAgentDialog);
			await editAgentDialog
				.getByPlaceholder('Instructions appended to every message you send...')
				.fill('   ');
			await editAgentDialog.getByRole('button', { name: 'Reset' }).click();
			await editAgentDialog.getByRole('button', { name: 'Clear' }).click();
			await editAgentDialog.getByTitle('Remove variable').click();
			await getModelInput(editAgentDialog).fill('   ');
			await getContextWindowInput(editAgentDialog).fill('0');
			await editAgentDialog.getByRole('button', { name: 'Save Changes' }).click();
			await expect(editAgentDialog).toBeHidden();

			const reopenedDialog = await openEditAgentDialog(launched.window, 'Matrix Codex Agent');
			await expect(
				reopenedDialog.getByPlaceholder('Instructions appended to every message you send...')
			).toHaveValue('');
			await expect(reopenedDialog.getByPlaceholder('/path/to/codex')).toHaveValue(
				'/usr/local/bin/codex-e2e'
			);
			await expect(reopenedDialog.getByRole('button', { name: 'Reset' })).toHaveCount(0);
			await expect(reopenedDialog.getByPlaceholder('--flag value --another-flag')).toHaveValue('');
			await expect(reopenedDialog.getByPlaceholder('VARIABLE_NAME')).toHaveCount(0);
			await expect(getModelInput(reopenedDialog)).toHaveValue('');
			await expect(getContextWindowInput(reopenedDialog)).toHaveValue('400000');
			await reopenedDialog.getByRole('button', { name: 'Cancel' }).click();
		} finally {
			await launched.cleanup();
		}
	});

	test('prefills duplicate agent modal with source provider configuration', async () => {
		const seeded = createAgentCrudWorkbench();
		const configuredSession = {
			...seeded.sessions[0],
			nudgeMessage: 'Duplicate this provider nudge.',
			customPath: '/opt/maestro/codex-source',
			customArgs: '--source-config',
			customEnvVars: { CODEX_DUPLICATE_E2E: 'source' },
			customModel: 'gpt-5-codex-duplicate-e2e',
			customContextWindow: 234567,
		};
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [configuredSession, ...seeded.sessions.slice(1)],
		});

		try {
			await stubProviderDetection(launched.electronApp);

			const contextMenu = await openSessionContextMenu(
				launched.window,
				'Matrix Codex Agent',
				'Duplicate...'
			);
			await contextMenu.getByRole('button', { name: 'Duplicate...', exact: true }).click();

			const createAgentDialog = launched.window.getByRole('dialog', { name: 'Create New Agent' });
			await expect(createAgentDialog).toBeVisible();
			await expect(createAgentDialog.getByLabel('Agent Name')).toHaveValue(
				'Matrix Codex Agent (Copy)'
			);
			await expectCodexProviderSettings(createAgentDialog);
			await expect(
				createAgentDialog.getByPlaceholder('Instructions appended to every message you send...')
			).toHaveValue('Duplicate this provider nudge.');
			await expect(createAgentDialog.getByPlaceholder('/path/to/codex')).toHaveValue(
				'/opt/maestro/codex-source'
			);
			await expect(createAgentDialog.getByPlaceholder('--flag value --another-flag')).toHaveValue(
				'--source-config'
			);
			await expect(createAgentDialog.getByPlaceholder('VARIABLE_NAME')).toHaveValue(
				'CODEX_DUPLICATE_E2E'
			);
			await expect(createAgentDialog.getByPlaceholder('value', { exact: true })).toHaveValue(
				'source'
			);
			await expect(getModelInput(createAgentDialog)).toHaveValue('gpt-5-codex-duplicate-e2e');
			await expect(getContextWindowInput(createAgentDialog)).toHaveValue('234567');
			await createAgentDialog.getByRole('button', { name: 'Cancel' }).click();
		} finally {
			await launched.cleanup();
		}
	});

	test('persists provider switch config and reopens on the new provider', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubProviderDetection(launched.electronApp);

			const editAgentDialog = await openEditAgentDialog(launched.window, 'Matrix Codex Agent');
			await editAgentDialog.getByRole('combobox').selectOption('opencode');
			await expectOpenCodeProviderSettings(editAgentDialog);
			await editAgentDialog
				.getByPlaceholder('/path/to/opencode')
				.fill('/opt/maestro/opencode-switch');
			await editAgentDialog
				.getByPlaceholder('--flag value --another-flag')
				.fill('--model opencode-switch-e2e');
			await addCustomEnvVar(editAgentDialog, 'OPENCODE_SWITCH_E2E', 'persisted');
			await getModelInput(editAgentDialog).fill('anthropic/claude-switch-e2e');
			await getContextWindowInput(editAgentDialog).fill('155000');
			await editAgentDialog.getByRole('button', { name: 'Save Changes' }).click();
			await expect(editAgentDialog).toBeHidden();

			const reopenedDialog = await openEditAgentDialog(launched.window, 'Matrix Codex Agent');
			await expect(reopenedDialog.getByRole('combobox')).toHaveValue('opencode');
			await expectOpenCodeProviderSettings(reopenedDialog);
			await expect(reopenedDialog.getByPlaceholder('/path/to/opencode')).toHaveValue(
				'/opt/maestro/opencode-switch'
			);
			await expect(reopenedDialog.getByPlaceholder('--flag value --another-flag')).toHaveValue(
				'--model opencode-switch-e2e'
			);
			await expect(reopenedDialog.getByPlaceholder('VARIABLE_NAME')).toHaveValue(
				'OPENCODE_SWITCH_E2E'
			);
			await expect(reopenedDialog.getByPlaceholder('value', { exact: true })).toHaveValue(
				'persisted'
			);
			await expect(getModelInput(reopenedDialog)).toHaveValue('anthropic/claude-switch-e2e');
			await expect(getContextWindowInput(reopenedDialog)).toHaveValue('155000');
			await reopenedDialog.getByRole('button', { name: 'Cancel' }).click();
		} finally {
			await launched.cleanup();
		}
	});

	test('resets Create New Agent directory warning acknowledgment after path edits', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});
		const replacementDir = path.join(seeded.homeDir, 'ack-reset-replacement-project');
		fs.mkdirSync(replacementDir, { recursive: true });

		try {
			await stubProviderDetection(launched.electronApp);

			const createAgentDialog = await openCreateAgentDialog(launched.window);
			await createAgentDialog.getByRole('option', { name: /Codex/ }).click();
			await createAgentDialog.getByLabel('Agent Name').fill('Acknowledgment Reset Agent');
			await createAgentDialog.getByLabel('Working Directory').fill(seeded.projectDir);

			const createButton = createAgentDialog.getByRole('button', { name: 'Create Agent' });
			const warning = createAgentDialog.getByText(
				/This directory is already used by "Matrix Codex Agent", "Matrix Claude Code Agent"/
			);
			const acknowledgment = createAgentDialog.getByLabel(
				'I understand the risk and want to proceed'
			);
			await expect(warning).toBeVisible();
			await expect(createButton).toBeDisabled();
			await acknowledgment.check();
			await expect(createButton).toBeEnabled();

			await createAgentDialog.getByLabel('Working Directory').fill(replacementDir);
			await expect(warning).toHaveCount(0);
			await expect(createButton).toBeEnabled();

			await createAgentDialog.getByLabel('Working Directory').fill(seeded.projectDir);
			await expect(warning).toBeVisible();
			await expect(acknowledgment).not.toBeChecked();
			await expect(createButton).toBeDisabled();
		} finally {
			await launched.cleanup();
		}
	});

	test('ignores Create New Agent folder picker shortcut while SSH remote is selected', async () => {
		const seeded = createAgentCrudWorkbench();
		const remote = createProviderSshRemote();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});
		const selectedDir = path.join(seeded.homeDir, 'shortcut-ignored-local-project');
		fs.mkdirSync(selectedDir, { recursive: true });

		try {
			await stubProviderDetection(launched.electronApp);
			await stubSshRemoteConfigs(launched.electronApp, [remote]);
			await stubSelectFolderDialog(launched.electronApp, selectedDir);

			const createAgentDialog = await openCreateAgentDialog(launched.window);
			await createAgentDialog.getByRole('option', { name: /Codex/ }).click();
			const workingDirectoryInput = createAgentDialog.getByLabel('Working Directory');
			await workingDirectoryInput.fill('/srv/maestro/shortcut-ignored');
			await getSshRemoteSelect(createAgentDialog, remote.id).selectOption(remote.id);
			await expect(
				createAgentDialog.getByTitle(/Folder picker unavailable for SSH remote/)
			).toBeDisabled();

			await launched.window.keyboard.press('Control+O');

			await expect(workingDirectoryInput).toHaveValue('/srv/maestro/shortcut-ignored');
		} finally {
			await launched.cleanup();
		}
	});

	test('restores Create New Agent folder picker shortcut after returning to local execution', async () => {
		const seeded = createAgentCrudWorkbench();
		const remote = createProviderSshRemote();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});
		const selectedDir = path.join(seeded.homeDir, 'shortcut-restored-local-project');
		fs.mkdirSync(selectedDir, { recursive: true });

		try {
			await stubProviderDetection(launched.electronApp);
			await stubSshRemoteConfigs(launched.electronApp, [remote]);
			await stubSelectFolderDialog(launched.electronApp, selectedDir);

			const createAgentDialog = await openCreateAgentDialog(launched.window);
			await createAgentDialog.getByRole('option', { name: /Codex/ }).click();
			await getSshRemoteSelect(createAgentDialog, remote.id).selectOption(remote.id);
			await expect(
				createAgentDialog.getByText(/Agent will run on Provider Build Host/)
			).toBeVisible();
			await getSshRemoteSelect(createAgentDialog, remote.id).selectOption('local');
			await expect(createAgentDialog.getByText('Agent will run locally')).toBeVisible();

			const workingDirectoryInput = createAgentDialog.getByLabel('Working Directory');
			await workingDirectoryInput.scrollIntoViewIfNeeded();
			await workingDirectoryInput.focus();
			await launched.window.keyboard.press('ControlOrMeta+O');

			await expect(workingDirectoryInput).toHaveValue(selectedDir);
		} finally {
			await launched.cleanup();
		}
	});

	test('creates a duplicated provider agent with edited provider configuration', async () => {
		const seeded = createAgentCrudWorkbench();
		const duplicateDir = path.join(seeded.homeDir, 'edited-duplicate-provider-project');
		fs.mkdirSync(duplicateDir, { recursive: true });
		const configuredSession = {
			...seeded.sessions[0],
			nudgeMessage: 'Duplicate source nudge before edits.',
			customPath: '/opt/maestro/codex-duplicate-source',
			customArgs: '--duplicate-source',
			customEnvVars: { CODEX_DUPLICATE_SOURCE_E2E: 'source' },
			customModel: 'gpt-5-codex-duplicate-source',
			customContextWindow: 210000,
		};
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [configuredSession, ...seeded.sessions.slice(1)],
		});

		try {
			await stubProviderDetection(launched.electronApp);

			const contextMenu = await openSessionContextMenu(
				launched.window,
				'Matrix Codex Agent',
				'Duplicate...'
			);
			await contextMenu.getByRole('button', { name: 'Duplicate...', exact: true }).click();

			const createAgentDialog = launched.window.getByRole('dialog', { name: 'Create New Agent' });
			await expect(createAgentDialog).toBeVisible();
			await createAgentDialog.getByLabel('Agent Name').fill('Edited Duplicate Provider Agent');
			await createAgentDialog.getByLabel('Working Directory').fill(duplicateDir);
			await createAgentDialog
				.getByPlaceholder('Instructions appended to every message you send...')
				.fill('Edited duplicate provider config should persist.');
			await createAgentDialog
				.getByPlaceholder('/path/to/codex')
				.fill('/opt/maestro/codex-duplicate-edited');
			await createAgentDialog
				.getByPlaceholder('--flag value --another-flag')
				.fill('--duplicate-edited');
			await createAgentDialog.getByPlaceholder('VARIABLE_NAME').fill('CODEX_DUPLICATE_EDITED_E2E');
			await createAgentDialog.getByPlaceholder('VARIABLE_NAME').blur();
			await createAgentDialog.getByPlaceholder('value', { exact: true }).fill('edited');
			await getModelInput(createAgentDialog).fill('gpt-5-codex-duplicate-edited');
			await getContextWindowInput(createAgentDialog).fill('222222');
			await createAgentDialog.getByRole('button', { name: 'Create Agent' }).click();
			await expect(createAgentDialog).toBeHidden();

			const editAgentDialog = await openEditAgentDialog(
				launched.window,
				'Edited Duplicate Provider Agent'
			);
			await expect(
				editAgentDialog.getByPlaceholder('Instructions appended to every message you send...')
			).toHaveValue('Edited duplicate provider config should persist.');
			await expect(editAgentDialog.getByPlaceholder('/path/to/codex')).toHaveValue(
				'/opt/maestro/codex-duplicate-edited'
			);
			await expect(editAgentDialog.getByPlaceholder('--flag value --another-flag')).toHaveValue(
				'--duplicate-edited'
			);
			await expect(editAgentDialog.getByPlaceholder('VARIABLE_NAME')).toHaveValue(
				'CODEX_DUPLICATE_EDITED_E2E'
			);
			await expect(editAgentDialog.getByPlaceholder('value', { exact: true })).toHaveValue(
				'edited'
			);
			await expect(getModelInput(editAgentDialog)).toHaveValue('gpt-5-codex-duplicate-edited');
			await expect(getContextWindowInput(editAgentDialog)).toHaveValue('222222');
			await editAgentDialog.getByRole('button', { name: 'Cancel' }).click();
		} finally {
			await launched.cleanup();
		}
	});

	test('clears duplicated provider overrides before creating a copy', async () => {
		const seeded = createAgentCrudWorkbench();
		const duplicateDir = path.join(seeded.homeDir, 'cleared-duplicate-provider-project');
		fs.mkdirSync(duplicateDir, { recursive: true });
		const configuredSession = {
			...seeded.sessions[0],
			nudgeMessage: 'Clear duplicate source nudge.',
			customPath: '/opt/maestro/codex-duplicate-clear-source',
			customArgs: '--duplicate-clear-source',
			customEnvVars: { CODEX_DUPLICATE_CLEAR_E2E: 'remove-me' },
			customModel: 'gpt-5-codex-duplicate-clear',
			customContextWindow: 230000,
		};
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [configuredSession, ...seeded.sessions.slice(1)],
		});

		try {
			await stubProviderDetection(launched.electronApp);

			const contextMenu = await openSessionContextMenu(
				launched.window,
				'Matrix Codex Agent',
				'Duplicate...'
			);
			await contextMenu.getByRole('button', { name: 'Duplicate...', exact: true }).click();

			const createAgentDialog = launched.window.getByRole('dialog', { name: 'Create New Agent' });
			await expect(createAgentDialog).toBeVisible();
			await createAgentDialog.getByLabel('Agent Name').fill('Cleared Duplicate Provider Agent');
			await createAgentDialog.getByLabel('Working Directory').fill(duplicateDir);
			await createAgentDialog
				.getByPlaceholder('Instructions appended to every message you send...')
				.fill('   ');
			await createAgentDialog.getByTitle('Reset to detected path').click();
			await createAgentDialog.getByRole('button', { name: 'Clear' }).click();
			await createAgentDialog.getByTitle('Remove variable').click();
			await getModelInput(createAgentDialog).fill('   ');
			await getContextWindowInput(createAgentDialog).fill('0');
			await createAgentDialog.getByRole('button', { name: 'Create Agent' }).click();
			await expect(createAgentDialog).toBeHidden();

			const editAgentDialog = await openEditAgentDialog(
				launched.window,
				'Cleared Duplicate Provider Agent'
			);
			await expect(
				editAgentDialog.getByPlaceholder('Instructions appended to every message you send...')
			).toHaveValue('');
			await expect(editAgentDialog.getByPlaceholder('/path/to/codex')).toHaveValue(
				'/usr/local/bin/codex-e2e'
			);
			await expect(editAgentDialog.getByPlaceholder('--flag value --another-flag')).toHaveValue('');
			await expect(editAgentDialog.getByPlaceholder('VARIABLE_NAME')).toHaveCount(0);
			await expect(getModelInput(editAgentDialog)).toHaveValue('');
			await expect(getContextWindowInput(editAgentDialog)).toHaveValue('400000');
			await editAgentDialog.getByRole('button', { name: 'Cancel' }).click();
		} finally {
			await launched.cleanup();
		}
	});

	test('resets Create New Agent remote command override to the SSH binary default', async () => {
		const seeded = createAgentCrudWorkbench();
		const remote = createProviderSshRemote();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});

		try {
			await stubProviderDetection(launched.electronApp);
			await stubSshRemoteConfigs(launched.electronApp, [remote]);

			const createAgentDialog = await openCreateAgentDialog(launched.window);
			await createAgentDialog.getByRole('option', { name: /Codex/ }).click();
			const commandInput = createAgentDialog.getByPlaceholder('/path/to/codex');
			await getSshRemoteSelect(createAgentDialog, remote.id).selectOption(remote.id);
			await expect(
				createAgentDialog.getByText(/Agent will run on Provider Build Host/)
			).toBeVisible();
			await expect(createAgentDialog.getByText('Remote Command', { exact: true })).toBeVisible();
			await commandInput.fill('/opt/maestro/codex-remote-override');
			await expect(commandInput).toHaveValue('/opt/maestro/codex-remote-override');

			await createAgentDialog.getByTitle('Reset to remote binary name').click();

			await expect(commandInput).toHaveValue('codex');
			await expect(createAgentDialog.getByTitle('Reset to remote binary name')).toHaveCount(0);
		} finally {
			await launched.cleanup();
		}
	});

	test('resets Edit Agent remote command override to the SSH binary default', async () => {
		const seeded = createAgentCrudWorkbench();
		const remote = createProviderSshRemote();
		const configuredSession = {
			...seeded.sessions[0],
			customPath: '/opt/maestro/codex-edit-remote-override',
			sessionSshRemoteConfig: { enabled: true, remoteId: remote.id },
		};
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [configuredSession, ...seeded.sessions.slice(1)],
		});

		try {
			await stubProviderDetection(launched.electronApp);
			await stubSshRemoteConfigs(launched.electronApp, [remote]);

			const editAgentDialog = await openEditAgentDialog(launched.window, 'Matrix Codex Agent');
			const commandInput = editAgentDialog.getByPlaceholder('/path/to/codex');
			await expect(getSshRemoteSelect(editAgentDialog, remote.id)).toHaveValue(remote.id);
			await expect(editAgentDialog.getByText('Remote Command', { exact: true })).toBeVisible();
			await expect(commandInput).toHaveValue('/opt/maestro/codex-edit-remote-override');

			await editAgentDialog.getByTitle('Reset to remote binary name').click();
			await expect(commandInput).toHaveValue('codex');
			await editAgentDialog.getByRole('button', { name: 'Save Changes' }).click();
			await expect(editAgentDialog).toBeHidden();

			const reopenedDialog = await openEditAgentDialog(launched.window, 'Matrix Codex Agent');
			await expect(getSshRemoteSelect(reopenedDialog, remote.id)).toHaveValue(remote.id);
			await expect(reopenedDialog.getByPlaceholder('/path/to/codex')).toHaveValue('codex');
			await expect(reopenedDialog.getByTitle('Reset to remote binary name')).toHaveCount(0);
			await reopenedDialog.getByRole('button', { name: 'Cancel' }).click();
		} finally {
			await launched.cleanup();
		}
	});

	test('clears Create New Agent SSH selection after a successful provider create', async () => {
		const seeded = createAgentCrudWorkbench();
		const remote = createProviderSshRemote();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});

		try {
			await stubProviderDetection(launched.electronApp);
			await stubSshRemoteConfigs(launched.electronApp, [remote]);

			const createAgentDialog = await openCreateAgentDialog(launched.window);
			await createAgentDialog.getByRole('option', { name: /Codex/ }).click();
			await getSshRemoteSelect(createAgentDialog, remote.id).selectOption(remote.id);
			await createAgentDialog.getByLabel('Agent Name').fill('Remote Reset After Create Agent');
			await createAgentDialog
				.getByLabel('Working Directory')
				.fill('/srv/maestro/reset-after-remote-create');
			await expect(
				createAgentDialog.getByText(/Agent will run on Provider Build Host/)
			).toBeVisible();
			await createAgentDialog.getByRole('button', { name: 'Create Agent' }).click();
			await expect(createAgentDialog).toBeHidden();

			const reopenedDialog = await openCreateAgentDialog(launched.window);
			await reopenedDialog.getByRole('option', { name: /Codex/ }).click();
			await expect(getSshRemoteSelect(reopenedDialog, remote.id)).toHaveValue('local');
			await expect(reopenedDialog.getByText('Agent will run locally')).toBeVisible();
			await reopenedDialog.getByRole('button', { name: 'Cancel' }).click();
		} finally {
			await launched.cleanup();
		}
	});

	test('keeps Create New Agent SSH selection while switching provider drafts', async () => {
		const seeded = createAgentCrudWorkbench();
		const remote = createProviderSshRemote();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});

		try {
			await stubProviderDetection(launched.electronApp);
			await stubSshRemoteConfigs(launched.electronApp, [remote]);

			const createAgentDialog = await openCreateAgentDialog(launched.window);
			await createAgentDialog.getByRole('option', { name: /Codex/ }).click();
			await getSshRemoteSelect(createAgentDialog, remote.id).selectOption(remote.id);
			await expect(
				createAgentDialog.getByText(/Agent will run on Provider Build Host/)
			).toBeVisible();

			await createAgentDialog.getByRole('option', { name: /OpenCode/ }).click();

			await expectOpenCodeProviderSettings(createAgentDialog);
			await expect(getSshRemoteSelect(createAgentDialog, remote.id)).toHaveValue(remote.id);
			await expect(
				createAgentDialog.getByText(/Agent will run on Provider Build Host/)
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('cancels Edit Agent SSH remote draft without persisting remote execution', async () => {
		const seeded = createAgentCrudWorkbench();
		const remote = createProviderSshRemote();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			await stubProviderDetection(launched.electronApp);
			await stubSshRemoteConfigs(launched.electronApp, [remote]);

			const editAgentDialog = await openEditAgentDialog(launched.window, 'Matrix Codex Agent');
			await getSshRemoteSelect(editAgentDialog, remote.id).selectOption(remote.id);
			await expect(
				editAgentDialog.getByText(/Agent will run on Provider Build Host/)
			).toBeVisible();
			await editAgentDialog.getByRole('button', { name: 'Cancel' }).click();
			await expect(editAgentDialog).toBeHidden();

			const reopenedDialog = await openEditAgentDialog(launched.window, 'Matrix Codex Agent');
			await expect(getSshRemoteSelect(reopenedDialog, remote.id)).toHaveValue('local');
			await expect(reopenedDialog.getByText('Agent will run locally')).toBeVisible();
			await reopenedDialog.getByRole('button', { name: 'Cancel' }).click();
		} finally {
			await launched.cleanup();
		}
	});

	test('creates a duplicated provider agent with inherited SSH remote execution', async () => {
		const seeded = createAgentCrudWorkbench();
		const remote = createProviderSshRemote();
		const configuredSession = {
			...seeded.sessions[0],
			sessionSshRemoteConfig: { enabled: true, remoteId: remote.id },
		};
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [configuredSession, ...seeded.sessions.slice(1)],
		});

		try {
			await stubProviderDetection(launched.electronApp);
			await stubSshRemoteConfigs(launched.electronApp, [remote]);

			const contextMenu = await openSessionContextMenu(
				launched.window,
				'Matrix Codex Agent',
				'Duplicate...'
			);
			await contextMenu.getByRole('button', { name: 'Duplicate...', exact: true }).click();

			const createAgentDialog = launched.window.getByRole('dialog', { name: 'Create New Agent' });
			await expect(getSshRemoteSelect(createAgentDialog, remote.id)).toHaveValue(remote.id);
			await createAgentDialog.getByLabel('Agent Name').fill('Inherited Remote Duplicate Agent');
			await createAgentDialog
				.getByLabel('Working Directory')
				.fill('/srv/maestro/inherited-remote-duplicate');
			await createAgentDialog.getByRole('button', { name: 'Create Agent' }).click();
			await expect(createAgentDialog).toBeHidden();

			const editAgentDialog = await openEditAgentDialog(
				launched.window,
				'Inherited Remote Duplicate Agent'
			);
			await expect(getSshRemoteSelect(editAgentDialog, remote.id)).toHaveValue(remote.id);
			await expect(
				editAgentDialog.getByText(/Agent will run on Provider Build Host/)
			).toBeVisible();
			await editAgentDialog.getByRole('button', { name: 'Cancel' }).click();
		} finally {
			await launched.cleanup();
		}
	});

	test('creates a duplicated provider agent after clearing inherited SSH remote execution', async () => {
		const seeded = createAgentCrudWorkbench();
		const remote = createProviderSshRemote();
		const duplicateDir = path.join(seeded.homeDir, 'local-cleared-remote-duplicate-project');
		fs.mkdirSync(duplicateDir, { recursive: true });
		const configuredSession = {
			...seeded.sessions[0],
			sessionSshRemoteConfig: { enabled: true, remoteId: remote.id },
		};
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [configuredSession, ...seeded.sessions.slice(1)],
		});

		try {
			await stubProviderDetection(launched.electronApp);
			await stubSshRemoteConfigs(launched.electronApp, [remote]);

			const contextMenu = await openSessionContextMenu(
				launched.window,
				'Matrix Codex Agent',
				'Duplicate...'
			);
			await contextMenu.getByRole('button', { name: 'Duplicate...', exact: true }).click();

			const createAgentDialog = launched.window.getByRole('dialog', { name: 'Create New Agent' });
			await expect(getSshRemoteSelect(createAgentDialog, remote.id)).toHaveValue(remote.id);
			await getSshRemoteSelect(createAgentDialog, remote.id).selectOption('local');
			await expect(createAgentDialog.getByText('Agent will run locally')).toBeVisible();
			await createAgentDialog.getByLabel('Agent Name').fill('Local Cleared Remote Duplicate');
			await createAgentDialog.getByLabel('Working Directory').fill(duplicateDir);
			await createAgentDialog.getByRole('button', { name: 'Create Agent' }).click();
			await expect(createAgentDialog).toBeHidden();

			const editAgentDialog = await openEditAgentDialog(
				launched.window,
				'Local Cleared Remote Duplicate'
			);
			await expect(getSshRemoteSelect(editAgentDialog, remote.id)).toHaveValue('local');
			await expect(editAgentDialog.getByText('Agent will run locally')).toBeVisible();
			await editAgentDialog.getByRole('button', { name: 'Cancel' }).click();
		} finally {
			await launched.cleanup();
		}
	});
});

test.describe('Agent group organization', () => {
	test('creates an agent group from Quick Actions', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Create New Group');
			await quickActionsDialog.getByRole('button', { name: /Create New Group/ }).click();

			await expect(quickActionsDialog).toBeHidden();
			const createGroupDialog = launched.window.getByRole('dialog', { name: 'Create New Group' });
			await expect(createGroupDialog).toBeVisible();
			await createGroupDialog.getByLabel('Group Name').fill('provider lane');
			await createGroupDialog.getByRole('button', { name: 'Create' }).click();

			await expect(createGroupDialog).toBeHidden();
			await expect(launched.window.getByText('PROVIDER LANE', { exact: true })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('moves a provider agent to a group and returns it to Ungrouped Agents', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			let contextMenu = await openSessionContextMenu(
				launched.window,
				'Matrix OpenCode Agent',
				'Move to Group'
			);
			await contextMenu.getByText('Move to Group', { exact: true }).hover();
			await contextMenu.getByRole('button', { name: /Create New Group/ }).click();

			const createGroupDialog = launched.window.getByRole('dialog', { name: 'Create New Group' });
			await createGroupDialog.getByLabel('Group Name').fill('opencode lane');
			await createGroupDialog.getByRole('button', { name: 'Create' }).click();
			await expect(createGroupDialog).toBeHidden();

			const groupSection = launched.window
				.getByText('OPENCODE LANE', { exact: true })
				.locator('xpath=ancestor::div[contains(@class, "mb-1")][1]');
			await expect(groupSection.getByText('Matrix OpenCode Agent', { exact: true })).toBeVisible();

			contextMenu = await openSessionContextMenu(
				launched.window,
				'Matrix OpenCode Agent',
				'Move to Group'
			);
			await contextMenu.getByText('Move to Group', { exact: true }).hover();
			await contextMenu.getByRole('button', { name: /Ungrouped/ }).click();

			await expect(groupSection.getByText('Matrix OpenCode Agent', { exact: true })).toHaveCount(0);
			const ungroupedSection = launched.window
				.getByText('Ungrouped Agents', { exact: true })
				.locator('xpath=ancestor::div[contains(@class, "mb-1")][1]');
			await expect(
				ungroupedSection.getByText('Matrix OpenCode Agent', { exact: true })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('creates a group from a provider context menu and moves the agent into it', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const contextMenu = await openSessionContextMenu(
				launched.window,
				'Matrix Factory Droid Agent',
				'Move to Group'
			);
			await contextMenu.getByText('Move to Group', { exact: true }).hover();
			await contextMenu.getByRole('button', { name: /Create New Group/ }).click();

			const createGroupDialog = launched.window.getByRole('dialog', { name: 'Create New Group' });
			await createGroupDialog.getByLabel('Group Name').fill('droid lane');
			await createGroupDialog.getByRole('button', { name: 'Create' }).click();
			await expect(createGroupDialog).toBeHidden();

			const groupSection = launched.window
				.getByText('DROID LANE', { exact: true })
				.locator('xpath=ancestor::div[contains(@class, "mb-1")][1]');
			await expect(
				groupSection.getByText('Matrix Factory Droid Agent', { exact: true })
			).toBeVisible();

			const ungroupedSection = launched.window
				.getByText('Ungrouped Agents', { exact: true })
				.locator('xpath=ancestor::div[contains(@class, "mb-1")][1]');
			await expect(
				ungroupedSection.getByText('Matrix Factory Droid Agent', { exact: true })
			).toHaveCount(0);
		} finally {
			await launched.cleanup();
		}
	});

	test('collapses and expands a provider agent group section', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const contextMenu = await openSessionContextMenu(
				launched.window,
				'Matrix Claude Code Agent',
				'Move to Group'
			);
			await contextMenu.getByText('Move to Group', { exact: true }).hover();
			await contextMenu.getByRole('button', { name: /Create New Group/ }).click();

			const createGroupDialog = launched.window.getByRole('dialog', { name: 'Create New Group' });
			await createGroupDialog.getByLabel('Group Name').fill('claude lane');
			await createGroupDialog.getByRole('button', { name: 'Create' }).click();
			await expect(createGroupDialog).toBeHidden();

			const groupHeader = launched.window.getByRole('button', { name: /CLAUDE LANE/ });
			const groupSection = launched.window
				.getByText('CLAUDE LANE', { exact: true })
				.locator('xpath=ancestor::div[contains(@class, "mb-1")][1]');
			await expect(groupHeader).toHaveAttribute('aria-expanded', 'true');
			await expect(
				groupSection.getByText('Matrix Claude Code Agent', { exact: true })
			).toBeVisible();

			await groupHeader.click();
			await expect(groupHeader).toHaveAttribute('aria-expanded', 'false');
			await expect(
				groupSection.getByRole('button', { name: 'Switch to Matrix Claude Code Agent' })
			).toBeVisible();

			await groupHeader.click();
			await expect(groupHeader).toHaveAttribute('aria-expanded', 'true');
			await expect(
				groupSection.getByText('Matrix Claude Code Agent', { exact: true })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('renames a populated provider agent group inline', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const contextMenu = await openSessionContextMenu(
				launched.window,
				'Matrix Codex Agent',
				'Move to Group'
			);
			await contextMenu.getByText('Move to Group', { exact: true }).hover();
			await contextMenu.getByRole('button', { name: /Create New Group/ }).click();

			const createGroupDialog = launched.window.getByRole('dialog', { name: 'Create New Group' });
			await createGroupDialog.getByLabel('Group Name').fill('rename provider lane');
			await createGroupDialog.getByRole('button', { name: 'Create' }).click();
			await expect(createGroupDialog).toBeHidden();

			const groupSection = launched.window
				.getByText('RENAME PROVIDER LANE', { exact: true })
				.locator('xpath=ancestor::div[contains(@class, "mb-1")][1]');
			await expect(groupSection.getByText('Matrix Codex Agent', { exact: true })).toBeVisible();

			await groupSection.getByText('RENAME PROVIDER LANE', { exact: true }).dblclick();
			const renameInput = launched.window.locator('input:focus');
			await expect(renameInput).toHaveValue('RENAME PROVIDER LANE');
			await renameInput.fill('primary provider lane');
			await renameInput.press('Enter');

			const renamedSection = launched.window
				.getByText('PRIMARY PROVIDER LANE', { exact: true })
				.locator('xpath=ancestor::div[contains(@class, "mb-1")][1]');
			await expect(renamedSection).toBeVisible();
			await expect(launched.window.getByText('RENAME PROVIDER LANE', { exact: true })).toHaveCount(
				0
			);
			await expect(renamedSection.getByText('Matrix Codex Agent', { exact: true })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('bookmarks a provider agent from the left bar context menu', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const contextMenu = await openSessionContextMenu(
				launched.window,
				'Matrix Codex Agent',
				'Add Bookmark'
			);
			await contextMenu.getByRole('button', { name: 'Add Bookmark' }).click();

			const bookmarksSection = launched.window
				.getByText('Bookmarks', { exact: true })
				.locator('xpath=ancestor::div[contains(@class, "mb-1")][1]');
			await expect(bookmarksSection).toBeVisible();
			await expect(bookmarksSection.getByText('Matrix Codex Agent', { exact: true })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('collapses and expands the provider bookmarks section', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const contextMenu = await openSessionContextMenu(
				launched.window,
				'Matrix Claude Code Agent',
				'Add Bookmark'
			);
			await contextMenu.getByRole('button', { name: 'Add Bookmark' }).click();

			const bookmarksHeader = launched.window.getByRole('button', { name: /Bookmarks/ });
			const bookmarksSection = launched.window
				.getByText('Bookmarks', { exact: true })
				.locator('xpath=ancestor::div[contains(@class, "mb-1")][1]');
			const expandedBookmarksList = bookmarksSection.locator('.border-l').filter({
				hasText: 'Matrix Claude Code Agent',
			});
			await expect(bookmarksHeader).toHaveAttribute('aria-expanded', 'true');
			await expect(expandedBookmarksList).toBeVisible();

			await bookmarksHeader.click();
			await expect(bookmarksHeader).toHaveAttribute('aria-expanded', 'false');
			await expect(expandedBookmarksList).toHaveCount(0);
			await expect(
				bookmarksSection.getByRole('button', { name: 'Switch to Matrix Claude Code Agent' })
			).toBeVisible();

			await bookmarksHeader.click();
			await expect(bookmarksHeader).toHaveAttribute('aria-expanded', 'true');
			await expect(
				bookmarksSection.getByText('Matrix Claude Code Agent', { exact: true })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('toggles the active provider bookmark from Quick Actions', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			let quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Bookmark');
			await quickActionsDialog
				.getByRole('button', { name: /Bookmark: Matrix Codex Agent/ })
				.click();
			await expect(quickActionsDialog).toBeHidden();
			await expect(launched.window.getByText('Bookmarks', { exact: true })).toBeVisible();

			quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Unbookmark');
			await quickActionsDialog
				.getByRole('button', { name: /Unbookmark: Matrix Codex Agent/ })
				.click();
			await expect(quickActionsDialog).toBeHidden();
			await expect(launched.window.getByText('Bookmarks', { exact: true })).toHaveCount(0);
		} finally {
			await launched.cleanup();
		}
	});

	test('filters provider agents from Quick Actions and clears with Escape', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Search: Agents');
			await quickActionsDialog.getByRole('button', { name: /Search: Agents/ }).click();
			await expect(quickActionsDialog).toBeHidden();

			const filterInput = launched.window.getByPlaceholder('Filter agents...');
			await expect(filterInput).toBeVisible();
			await filterInput.fill('Droid');

			const sessionList = launched.window.locator('[data-tour="session-list"]');
			await expect(
				sessionList.getByText('Matrix Factory Droid Agent', { exact: true })
			).toBeVisible();
			await expect(sessionList.getByText('Matrix Codex Agent', { exact: true })).toBeHidden();

			await filterInput.press('Escape');
			await expect(filterInput).toBeHidden();
			await expect(sessionList.getByText('Matrix Codex Agent', { exact: true })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('cancels and confirms deleting an empty provider group', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Create New Group');
			await quickActionsDialog.getByRole('button', { name: /Create New Group/ }).click();

			const createGroupDialog = launched.window.getByRole('dialog', { name: 'Create New Group' });
			await createGroupDialog.getByLabel('Group Name').fill('empty provider lane');
			await createGroupDialog.getByRole('button', { name: 'Create' }).click();
			await expect(createGroupDialog).toBeHidden();

			const groupHeader = launched.window.getByRole('button', { name: /EMPTY PROVIDER LANE/ });
			const groupSection = groupHeader.locator('xpath=ancestor::div[contains(@class, "mb-1")][1]');
			await expect(groupSection).toBeVisible();

			await groupHeader.hover();
			await groupSection.getByTitle('Delete empty group').click();
			let confirmDialog = launched.window.getByRole('dialog', { name: 'Confirm' });
			await expect(confirmDialog.getByText('delete the group "EMPTY PROVIDER LANE"')).toBeVisible();
			await confirmDialog.getByRole('button', { name: 'Cancel' }).click();
			await expect(confirmDialog).toBeHidden();
			await expect(groupSection).toBeVisible();

			await groupHeader.hover();
			await groupSection.getByTitle('Delete empty group').click();
			confirmDialog = launched.window.getByRole('dialog', { name: 'Confirm' });
			await expect(confirmDialog.getByText('delete the group "EMPTY PROVIDER LANE"')).toBeVisible();
			await confirmDialog.getByRole('button', { name: 'Confirm' }).click();
			await expect(launched.window.getByText('EMPTY PROVIDER LANE', { exact: true })).toHaveCount(
				0
			);
		} finally {
			await launched.cleanup();
		}
	});

	test('keeps Create New Group disabled for blank provider group names', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Create New Group');
			await quickActionsDialog.getByRole('button', { name: /Create New Group/ }).click();

			const createGroupDialog = launched.window.getByRole('dialog', { name: 'Create New Group' });
			const createButton = createGroupDialog.getByRole('button', { name: 'Create' });
			await expect(createButton).toBeDisabled();
			await createGroupDialog.getByLabel('Group Name').fill('   ');
			await expect(createButton).toBeDisabled();
			await expect(launched.window.getByText('PROVIDER LANE', { exact: true })).toHaveCount(0);
		} finally {
			await launched.cleanup();
		}
	});

	test('cancels a Create New Group provider draft without adding a group', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Create New Group');
			await quickActionsDialog.getByRole('button', { name: /Create New Group/ }).click();

			const createGroupDialog = launched.window.getByRole('dialog', { name: 'Create New Group' });
			await createGroupDialog.getByLabel('Group Name').fill('cancel provider lane');
			await createGroupDialog.getByRole('button', { name: 'Cancel' }).click();

			await expect(createGroupDialog).toBeHidden();
			await expect(launched.window.getByText('CANCEL PROVIDER LANE', { exact: true })).toHaveCount(
				0
			);
		} finally {
			await launched.cleanup();
		}
	});

	test('moves a provider agent into an existing group from the context menu', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const quickActionsDialog = await openQuickActions(launched.window);
			await quickActionsDialog
				.getByPlaceholder('Type a command or jump to agent...')
				.fill('Create New Group');
			await quickActionsDialog.getByRole('button', { name: /Create New Group/ }).click();

			const createGroupDialog = launched.window.getByRole('dialog', { name: 'Create New Group' });
			await createGroupDialog.getByLabel('Group Name').fill('existing provider lane');
			await createGroupDialog.getByRole('button', { name: 'Create' }).click();
			await expect(createGroupDialog).toBeHidden();

			const contextMenu = await openSessionContextMenu(
				launched.window,
				'Matrix Claude Code Agent',
				'Move to Group'
			);
			await contextMenu.getByText('Move to Group', { exact: true }).hover();
			await contextMenu.getByRole('button', { name: /EXISTING PROVIDER LANE/ }).click();

			const groupSection = launched.window
				.getByText('EXISTING PROVIDER LANE', { exact: true })
				.locator('xpath=ancestor::div[contains(@class, "mb-1")][1]');
			await expect(
				groupSection.getByText('Matrix Claude Code Agent', { exact: true })
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('removes a provider bookmark from the left bar context menu', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			let contextMenu = await openSessionContextMenu(
				launched.window,
				'Matrix Codex Agent',
				'Add Bookmark'
			);
			await contextMenu.getByRole('button', { name: 'Add Bookmark' }).click();
			await expect(launched.window.getByText('Bookmarks', { exact: true })).toBeVisible();

			contextMenu = await openSessionContextMenu(
				launched.window,
				'Matrix Codex Agent',
				'Remove Bookmark'
			);
			await contextMenu.getByRole('button', { name: 'Remove Bookmark' }).click();

			await expect(launched.window.getByText('Bookmarks', { exact: true })).toHaveCount(0);
		} finally {
			await launched.cleanup();
		}
	});

	test('hides the empty-group delete control for populated provider groups', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const contextMenu = await openSessionContextMenu(
				launched.window,
				'Matrix Factory Droid Agent',
				'Move to Group'
			);
			await contextMenu.getByText('Move to Group', { exact: true }).hover();
			await contextMenu.getByRole('button', { name: /Create New Group/ }).click();

			const createGroupDialog = launched.window.getByRole('dialog', { name: 'Create New Group' });
			await createGroupDialog.getByLabel('Group Name').fill('populated provider lane');
			await createGroupDialog.getByRole('button', { name: 'Create' }).click();
			await expect(createGroupDialog).toBeHidden();

			const groupHeader = launched.window.getByRole('button', { name: /POPULATED PROVIDER LANE/ });
			const groupSection = groupHeader.locator('xpath=ancestor::div[contains(@class, "mb-1")][1]');
			await groupHeader.hover();

			await expect(
				groupSection.getByText('Matrix Factory Droid Agent', { exact: true })
			).toBeVisible();
			await expect(groupSection.getByTitle('Delete empty group')).toHaveCount(0);
		} finally {
			await launched.cleanup();
		}
	});

	test('renames a provider group when inline edit loses focus', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const contextMenu = await openSessionContextMenu(
				launched.window,
				'Matrix Codex Agent',
				'Move to Group'
			);
			await contextMenu.getByText('Move to Group', { exact: true }).hover();
			await contextMenu.getByRole('button', { name: /Create New Group/ }).click();

			const createGroupDialog = launched.window.getByRole('dialog', { name: 'Create New Group' });
			await createGroupDialog.getByLabel('Group Name').fill('blur provider lane');
			await createGroupDialog.getByRole('button', { name: 'Create' }).click();
			await expect(createGroupDialog).toBeHidden();

			await launched.window.getByText('BLUR PROVIDER LANE', { exact: true }).dblclick();
			const renameInput = launched.window.locator('input:focus');
			await expect(renameInput).toHaveValue('BLUR PROVIDER LANE');
			await renameInput.fill('blurred provider lane');
			await launched.window.getByText('Ungrouped Agents', { exact: true }).click();

			await expect(
				launched.window.getByText('BLURRED PROVIDER LANE', { exact: true })
			).toBeVisible();
			await expect(launched.window.getByText('BLUR PROVIDER LANE', { exact: true })).toHaveCount(0);
		} finally {
			await launched.cleanup();
		}
	});

	test('keeps provider group name when inline rename is blank', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			const contextMenu = await openSessionContextMenu(
				launched.window,
				'Matrix Claude Code Agent',
				'Move to Group'
			);
			await contextMenu.getByText('Move to Group', { exact: true }).hover();
			await contextMenu.getByRole('button', { name: /Create New Group/ }).click();

			const createGroupDialog = launched.window.getByRole('dialog', { name: 'Create New Group' });
			await createGroupDialog.getByLabel('Group Name').fill('blank rename lane');
			await createGroupDialog.getByRole('button', { name: 'Create' }).click();
			await expect(createGroupDialog).toBeHidden();

			await launched.window.getByText('BLANK RENAME LANE', { exact: true }).dblclick();
			const renameInput = launched.window.locator('input:focus');
			await renameInput.fill('   ');
			await renameInput.press('Enter');

			await expect(launched.window.getByText('BLANK RENAME LANE', { exact: true })).toBeVisible();
			await expect(renameInput).toHaveCount(0);
		} finally {
			await launched.cleanup();
		}
	});

	test('marks the provider current group submenu item disabled', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			let contextMenu = await openSessionContextMenu(
				launched.window,
				'Matrix OpenCode Agent',
				'Move to Group'
			);
			await contextMenu.getByText('Move to Group', { exact: true }).hover();
			await contextMenu.getByRole('button', { name: /Create New Group/ }).click();

			const createGroupDialog = launched.window.getByRole('dialog', { name: 'Create New Group' });
			await createGroupDialog.getByLabel('Group Name').fill('current provider lane');
			await createGroupDialog.getByRole('button', { name: 'Create' }).click();
			await expect(createGroupDialog).toBeHidden();

			contextMenu = await openSessionContextMenu(
				launched.window,
				'Matrix OpenCode Agent',
				'Move to Group'
			);
			await contextMenu.getByText('Move to Group', { exact: true }).hover();

			await expect(
				contextMenu.getByRole('button', { name: /CURRENT PROVIDER LANE/ })
			).toBeDisabled();
			await expect(contextMenu.getByText('(current)', { exact: true })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('shows empty provider group delete control after moving last agent to ungrouped', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			let contextMenu = await openSessionContextMenu(
				launched.window,
				'Matrix Factory Droid Agent',
				'Move to Group'
			);
			await contextMenu.getByText('Move to Group', { exact: true }).hover();
			await contextMenu.getByRole('button', { name: /Create New Group/ }).click();

			const createGroupDialog = launched.window.getByRole('dialog', { name: 'Create New Group' });
			await createGroupDialog.getByLabel('Group Name').fill('emptied provider lane');
			await createGroupDialog.getByRole('button', { name: 'Create' }).click();
			await expect(createGroupDialog).toBeHidden();

			contextMenu = await openSessionContextMenu(
				launched.window,
				'Matrix Factory Droid Agent',
				'Move to Group'
			);
			await contextMenu.getByText('Move to Group', { exact: true }).hover();
			await contextMenu.getByRole('button', { name: /Ungrouped/ }).click();

			const groupHeader = launched.window.getByRole('button', { name: /EMPTIED PROVIDER LANE/ });
			const groupSection = groupHeader.locator('xpath=ancestor::div[contains(@class, "mb-1")][1]');
			await groupHeader.hover();

			await expect(
				groupSection.getByText('Matrix Factory Droid Agent', { exact: true })
			).toHaveCount(0);
			await expect(groupSection.getByTitle('Delete empty group')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('keeps a bookmarked provider agent visible after moving it into a group', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: seeded.sessions,
		});

		try {
			let contextMenu = await openSessionContextMenu(
				launched.window,
				'Matrix Codex Agent',
				'Add Bookmark'
			);
			await contextMenu.getByRole('button', { name: 'Add Bookmark' }).click();

			contextMenu = await openSessionContextMenu(
				launched.window,
				'Matrix Codex Agent',
				'Move to Group'
			);
			await contextMenu.getByText('Move to Group', { exact: true }).hover();
			await contextMenu.getByRole('button', { name: /Create New Group/ }).click();

			const createGroupDialog = launched.window.getByRole('dialog', { name: 'Create New Group' });
			await createGroupDialog.getByLabel('Group Name').fill('bookmarked provider lane');
			await createGroupDialog.getByRole('button', { name: 'Create' }).click();
			await expect(createGroupDialog).toBeHidden();

			const bookmarksSection = launched.window
				.getByText('Bookmarks', { exact: true })
				.locator('xpath=ancestor::div[contains(@class, "mb-1")][1]');
			const groupSection = launched.window
				.getByText('BOOKMARKED PROVIDER LANE', { exact: true })
				.locator('xpath=ancestor::div[contains(@class, "mb-1")][1]');

			await expect(
				bookmarksSection.getByText('Matrix Codex Agent', { exact: true }).first()
			).toBeVisible();
			await expect(
				groupSection.getByText('Matrix Codex Agent', { exact: true }).first()
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

	test('opens a generic provider session detail view with stored messages and cost', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});

		try {
			await stubCodexAgentSessionStorage(launched.electronApp, seeded.projectDir);

			const agentSessions = await openAgentSessions(launched.window, 'Matrix Codex Agent');
			await agentSessions.getByText('Provider Setup Review').click();

			await expect(
				agentSessions.getByText('Review provider setup sentinel coverage.')
			).toBeVisible();
			await expect(
				agentSessions.getByText('Provider setup response sentinel for Agent Sessions search.')
			).toBeVisible();
			await expect(agentSessions.getByText('$0.05')).toBeVisible();

			await launched.window.keyboard.press('Escape');
			await expect(agentSessions.getByPlaceholder('Search all content...')).toBeVisible();
			await expect(agentSessions.getByText('Provider Setup Review')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('favorites a generic provider session through shared agent session storage', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});

		try {
			await stubCodexAgentSessionStorage(launched.electronApp, seeded.projectDir);

			const agentSessions = await openAgentSessions(launched.window, 'Matrix Codex Agent');
			await agentSessions.getByText('Provider Setup Review').click();
			await agentSessions.getByTitle('Remove from favorites').click();

			await expect(agentSessions.getByTitle('Add to favorites')).toBeVisible();
			await expect(await getAgentSessionUpdates(launched.electronApp)).toContainEqual({
				type: 'starred',
				agentId: 'codex',
				projectPath: seeded.projectDir,
				sessionId: 'codex-provider-review',
				starred: false,
			});
		} finally {
			await launched.cleanup();
		}
	});

	test('renames a generic provider session detail through shared storage', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});

		try {
			await stubCodexAgentSessionStorage(launched.electronApp, seeded.projectDir);

			const agentSessions = await openAgentSessions(launched.window, 'Matrix Codex Agent');
			await agentSessions.getByText('Provider Setup Review').click();
			await agentSessions.getByTitle('Rename session').click();
			const renameInput = agentSessions.getByPlaceholder('Enter session name...');
			await renameInput.fill('Provider Detail Review');
			await renameInput.press('Enter');

			await expect(agentSessions.getByText('Provider Detail Review')).toBeVisible();
			await expect(await getAgentSessionUpdates(launched.electronApp)).toContainEqual({
				type: 'name',
				agentId: 'codex',
				projectPath: seeded.projectDir,
				sessionId: 'codex-provider-review',
				name: 'Provider Detail Review',
			});
		} finally {
			await launched.cleanup();
		}
	});

	test('routes Agent Sessions user and assistant search modes through generic storage', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});

		try {
			await stubCodexAgentSessionStorage(launched.electronApp, seeded.projectDir);

			const agentSessions = await openAgentSessions(launched.window, 'Matrix Codex Agent');
			await selectAgentSessionsSearchMode(agentSessions, 'My Messages');
			const userSearch = agentSessions.getByPlaceholder('Search your messages...');
			await userSearch.fill('review provider setup');
			await expect(
				agentSessions.getByText('Review provider setup sentinel coverage.')
			).toBeVisible();

			await userSearch.fill('');
			await selectAgentSessionsSearchMode(agentSessions, 'AI Responses');
			const assistantSearch = agentSessions.getByPlaceholder('Search AI responses...');
			await assistantSearch.fill('provider setup response');
			await expect(
				agentSessions.getByText('Provider setup response sentinel for Agent Sessions search.')
			).toBeVisible();

			const calls = await getAgentSessionSearchCalls(launched.electronApp);
			await expect(calls).toContainEqual({
				agentId: 'codex',
				projectPath: seeded.projectDir,
				query: 'review provider setup',
				mode: 'user',
			});
			await expect(calls).toContainEqual({
				agentId: 'codex',
				projectPath: seeded.projectDir,
				query: 'provider setup response',
				mode: 'assistant',
			});
		} finally {
			await launched.cleanup();
		}
	});

	test('adds a name to an unnamed generic provider session and resumes it by keyboard', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});

		try {
			await stubCodexAgentSessionStorage(launched.electronApp, seeded.projectDir);

			const agentSessions = await openAgentSessions(launched.window, 'Matrix Codex Agent');
			await agentSessions.getByText('Unnamed provider setup sentinel').click();
			await expect(agentSessions.getByText('Unnamed provider setup sentinel.')).toBeVisible();
			await agentSessions.getByTitle('Add session name').click();
			const renameInput = agentSessions.getByPlaceholder('Enter session name...');
			await renameInput.fill('Named Provider Session');
			await renameInput.press('Enter');

			await expect(agentSessions.getByText('Named Provider Session')).toBeVisible();
			const messagesRegion = agentSessions.getByRole('region', { name: 'Session messages' });
			await messagesRegion.focus();
			await messagesRegion.press('Enter');

			await expect(agentSessions.getByText('Agent Sessions for Matrix Codex Agent')).toBeHidden();
			await expect(
				launched.window
					.locator('[data-tab-id]')
					.filter({ hasText: 'Named Provider Session' })
					.first()
			).toBeVisible();
			await expect(launched.window.getByText('Unnamed provider setup sentinel.')).toBeVisible();
			await expect(await getAgentSessionUpdates(launched.electronApp)).toContainEqual({
				type: 'name',
				agentId: 'codex',
				projectPath: seeded.projectDir,
				sessionId: 'codex-provider-unnamed',
				name: 'Named Provider Session',
			});
		} finally {
			await launched.cleanup();
		}
	});

	test('creates a fresh provider AI tab from the Agent Sessions New Session action', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});

		try {
			await stubCodexAgentSessionStorage(launched.electronApp, seeded.projectDir);
			const tabRows = launched.window.locator('[data-tab-id]');
			await expect(tabRows.first()).toBeVisible();
			const initialTabCount = await tabRows.count();

			const agentSessions = await openAgentSessions(launched.window, 'Matrix Codex Agent');
			await agentSessions.getByRole('button', { name: 'New Session' }).click();

			await expect(agentSessions.getByText('Agent Sessions for Matrix Codex Agent')).toBeHidden();
			await expect(tabRows).toHaveCount(initialTabCount + 1);
			await expect(
				launched.window.locator('[data-tab-id]').filter({ hasText: 'New Session' }).first()
			).toBeVisible();
			await expect(launched.window.getByTitle('Send message')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('quick-resumes a generic provider session list row without opening detail', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});

		try {
			await stubCodexAgentSessionStorage(launched.electronApp, seeded.projectDir);
			const tabRows = launched.window.locator('[data-tab-id]');
			await expect(tabRows.first()).toBeVisible();
			const initialTabCount = await tabRows.count();

			const agentSessions = await openAgentSessions(launched.window, 'Matrix Codex Agent');
			await expect(agentSessions.getByText('Provider Setup Review')).toBeVisible();
			await expect(
				agentSessions.getByText('Review provider setup sentinel coverage.')
			).toBeHidden();
			const reviewRow = agentSessions
				.getByText('Provider Setup Review')
				.locator('xpath=ancestor::div[contains(@class, "cursor-pointer")][1]');

			await reviewRow.hover();
			await reviewRow.getByTitle('Resume session in new tab').click();

			await expect(agentSessions.getByText('Agent Sessions for Matrix Codex Agent')).toBeHidden();
			await expect(tabRows).toHaveCount(initialTabCount + 1);
			await expect(await getAgentSessionReadCalls(launched.electronApp)).toContainEqual({
				agentId: 'codex',
				projectPath: seeded.projectDir,
				sessionId: 'codex-provider-review',
			});
			await expect(
				launched.window
					.locator('[data-tab-id]')
					.filter({ hasText: 'Provider Setup Review' })
					.first()
			).toBeVisible();
			await expect(launched.window.getByTitle('Send message')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('preserves generic provider session metadata when quick-resuming', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});

		try {
			await stubCodexAgentSessionStorage(launched.electronApp, seeded.projectDir);
			const agentSessions = await openAgentSessions(launched.window, 'Matrix Codex Agent');
			const reviewRow = agentSessions
				.getByText('Provider Setup Review')
				.locator('xpath=ancestor::div[contains(@class, "cursor-pointer")][1]');

			await reviewRow.hover();
			await reviewRow.getByTitle('Resume session in new tab').click();
			await expect(agentSessions.getByText('Agent Sessions for Matrix Codex Agent')).toBeHidden();

			const resumedTab = launched.window
				.locator('[data-tab-id]')
				.filter({ hasText: 'Provider Setup Review' })
				.first();
			await expect(resumedTab).toBeVisible();
			const overlay = await openTabHoverOverlay(launched.window, resumedTab);
			await expect(overlay.getByText('codex-provider-review')).toBeVisible();
			await expect(overlay.getByRole('button', { name: 'Unstar Session' })).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('reveals hidden agent-prefixed generic provider sessions with Show All', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});

		try {
			await stubCodexAgentSessionStorage(launched.electronApp, seeded.projectDir, {
				includeHiddenAgentSession: true,
			});

			const agentSessions = await openAgentSessions(launched.window, 'Matrix Codex Agent');
			const hiddenSession = agentSessions.getByText('Hidden Provider Run');
			await expect(hiddenSession).toBeHidden();
			await expect(agentSessions.getByText('Provider Setup Review')).toBeVisible();

			await agentSessions.getByRole('checkbox', { name: 'Show All' }).check();
			await expect(hiddenSession).toBeVisible();
			await expect(agentSessions.getByText('Hidden provider automation sentinel')).toBeVisible();

			await agentSessions.getByRole('checkbox', { name: 'Show All' }).uncheck();
			await expect(hiddenSession).toBeHidden();
			await expect(agentSessions.getByText('Provider Setup Review')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('scopes and clears generic provider Agent Sessions search controls', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});

		try {
			await stubCodexAgentSessionStorage(launched.electronApp, seeded.projectDir);

			const agentSessions = await openAgentSessions(launched.window, 'Matrix Codex Agent');
			await selectAgentSessionsSearchMode(agentSessions, 'Title Only');
			const titleSearch = agentSessions.getByPlaceholder('Search titles...');
			await titleSearch.fill('Unnamed provider');

			await expect(agentSessions.getByText('Unnamed provider setup sentinel')).toBeVisible();
			await expect(agentSessions.getByText('Provider Setup Review')).toBeHidden();
			expect(
				(await getAgentSessionSearchCalls(launched.electronApp)).some(
					(call) => call.mode === 'title'
				)
			).toBe(false);

			await agentSessions.locator('input[placeholder="Search titles..."] + button').click();
			await expect(titleSearch).toHaveValue('');
			await expect(agentSessions.getByText('Provider Setup Review')).toBeVisible();

			await selectAgentSessionsSearchMode(agentSessions, 'All Content');
			const contentSearch = agentSessions.getByPlaceholder('Search all content...');
			await contentSearch.fill('missing provider session sentinel');
			await expect(agentSessions.getByText('No sessions match your search')).toBeVisible();

			await agentSessions.locator('input[placeholder="Search all content..."] + button').click();
			await expect(contentSearch).toHaveValue('');
			await expect(agentSessions.getByText('Provider Setup Review')).toBeVisible();
			await expect(agentSessions.getByText('Unnamed provider setup sentinel')).toBeVisible();
			await expect(await getAgentSessionSearchCalls(launched.electronApp)).toContainEqual({
				agentId: 'codex',
				projectPath: seeded.projectDir,
				query: 'missing provider session sentinel',
				mode: 'all',
			});
		} finally {
			await launched.cleanup();
		}
	});

	test('toggles a generic provider session favorite from the list row', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});

		try {
			await stubCodexAgentSessionStorage(launched.electronApp, seeded.projectDir);

			const agentSessions = await openAgentSessions(launched.window, 'Matrix Codex Agent');
			const reviewRow = agentSessions
				.getByText('Provider Setup Review')
				.locator('xpath=ancestor::div[contains(@class, "cursor-pointer")][1]');
			await reviewRow.getByTitle('Remove from favorites').click();
			await expect(reviewRow.getByTitle('Add to favorites')).toBeVisible();
			await reviewRow.getByTitle('Add to favorites').click();
			await expect(reviewRow.getByTitle('Remove from favorites')).toBeVisible();

			const updates = await getAgentSessionUpdates(launched.electronApp);
			await expect(updates).toContainEqual({
				type: 'starred',
				agentId: 'codex',
				projectPath: seeded.projectDir,
				sessionId: 'codex-provider-review',
				starred: false,
			});
			await expect(updates).toContainEqual({
				type: 'starred',
				agentId: 'codex',
				projectPath: seeded.projectDir,
				sessionId: 'codex-provider-review',
				starred: true,
			});
		} finally {
			await launched.cleanup();
		}
	});

	test('cancels generic provider session list rename with Escape', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});

		try {
			await stubCodexAgentSessionStorage(launched.electronApp, seeded.projectDir);

			const agentSessions = await openAgentSessions(launched.window, 'Matrix Codex Agent');
			const reviewRow = agentSessions
				.getByText('Provider Setup Review')
				.locator('xpath=ancestor::div[contains(@class, "cursor-pointer")][1]');
			await reviewRow.hover();
			await reviewRow.getByTitle('Rename session').click();
			const renameInput = agentSessions.getByPlaceholder('Enter session name...');
			await renameInput.fill('Cancelled Provider List Rename');
			await renameInput.press('Escape');

			await expect(agentSessions.getByText('Provider Setup Review')).toBeVisible();
			await expect(agentSessions.getByText('Cancelled Provider List Rename')).toHaveCount(0);
			await expect(await getAgentSessionUpdates(launched.electronApp)).toEqual([]);
		} finally {
			await launched.cleanup();
		}
	});

	test('opens a generic provider session with keyboard list navigation', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});

		try {
			await stubCodexAgentSessionStorage(launched.electronApp, seeded.projectDir);

			const agentSessions = await openAgentSessions(launched.window, 'Matrix Codex Agent');
			const searchInput = agentSessions.getByPlaceholder('Search all content...');
			await searchInput.focus();
			await searchInput.press('ArrowDown');
			await searchInput.press('Enter');

			await expect(agentSessions.getByText('Unnamed provider setup sentinel.')).toBeVisible();
			await expect(agentSessions.getByText('Provider Setup Review')).toBeHidden();
			await expect(await getAgentSessionReadCalls(launched.electronApp)).toContainEqual({
				agentId: 'codex',
				projectPath: seeded.projectDir,
				sessionId: 'codex-provider-unnamed',
			});
		} finally {
			await launched.cleanup();
		}
	});

	test('resumes a generic provider session from detail with loaded messages', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});

		try {
			await stubCodexAgentSessionStorage(launched.electronApp, seeded.projectDir);

			const agentSessions = await openAgentSessions(launched.window, 'Matrix Codex Agent');
			await agentSessions.getByText('Provider Setup Review').click();
			await expect(
				agentSessions.getByText('Provider setup response sentinel for Agent Sessions search.')
			).toBeVisible();
			await agentSessions.getByRole('button', { name: 'Resume' }).click();

			await expect(agentSessions.getByText('Agent Sessions for Matrix Codex Agent')).toBeHidden();
			await expect(
				launched.window
					.locator('[data-tab-id]')
					.filter({ hasText: 'Provider Setup Review' })
					.first()
			).toBeVisible();
			await expect(
				launched.window.getByText('Provider setup response sentinel for Agent Sessions search.')
			).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('switches Agent Sessions activity graph back to search with keyboard shortcut', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});

		try {
			await stubCodexAgentSessionStorage(launched.electronApp, seeded.projectDir);

			const agentSessions = await openAgentSessions(launched.window, 'Matrix Codex Agent');
			const searchInput = agentSessions.getByPlaceholder('Search all content...');
			await searchInput.fill('Provider Setup Review');
			await expect(searchInput).toHaveValue('Provider Setup Review');

			await agentSessions.getByTitle('Show activity graph').click();
			await expect(searchInput).toBeHidden();
			await expect(agentSessions.getByTitle(/Search sessions/)).toBeVisible();

			await launched.window.keyboard.press('ControlOrMeta+F');
			await expect(agentSessions.getByPlaceholder('Search all content...')).toBeVisible();
			await expect(agentSessions.getByPlaceholder('Search all content...')).toHaveValue('');
			await expect(agentSessions.getByText('Provider Setup Review')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('saves a generic provider session list rename with Enter', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});

		try {
			await stubCodexAgentSessionStorage(launched.electronApp, seeded.projectDir);

			const agentSessions = await openAgentSessions(launched.window, 'Matrix Codex Agent');
			const reviewRow = agentSessions
				.getByText('Provider Setup Review')
				.locator('xpath=ancestor::div[contains(@class, "cursor-pointer")][1]');
			await reviewRow.hover();
			await reviewRow.getByTitle('Rename session').click();
			const renameInput = agentSessions.getByPlaceholder('Enter session name...');
			await renameInput.fill('Provider List Review');
			await renameInput.press('Enter');

			await expect(agentSessions.getByText('Provider List Review')).toBeVisible();
			await expect(await getAgentSessionUpdates(launched.electronApp)).toContainEqual({
				type: 'name',
				agentId: 'codex',
				projectPath: seeded.projectDir,
				sessionId: 'codex-provider-review',
				name: 'Provider List Review',
			});
		} finally {
			await launched.cleanup();
		}
	});

	test('clears a generic provider session detail name with a blank rename', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});

		try {
			await stubCodexAgentSessionStorage(launched.electronApp, seeded.projectDir);

			const agentSessions = await openAgentSessions(launched.window, 'Matrix Codex Agent');
			await agentSessions.getByText('Provider Setup Review').click();
			await agentSessions.getByTitle('Rename session').click();
			const renameInput = agentSessions.getByPlaceholder('Enter session name...');
			await renameInput.fill('   ');
			await renameInput.press('Enter');

			await expect(agentSessions.getByText('CODEX-PROVIDER-REVIEW')).toBeVisible();
			await expect(agentSessions.getByTitle('Add session name')).toBeVisible();
			await expect(await getAgentSessionUpdates(launched.electronApp)).toContainEqual({
				type: 'name',
				agentId: 'codex',
				projectPath: seeded.projectDir,
				sessionId: 'codex-provider-review',
				name: null,
			});
		} finally {
			await launched.cleanup();
		}
	});

	test('syncs generic provider detail favorite changes back to the session list', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});

		try {
			await stubCodexAgentSessionStorage(launched.electronApp, seeded.projectDir);

			const agentSessions = await openAgentSessions(launched.window, 'Matrix Codex Agent');
			await agentSessions.getByText('Provider Setup Review').click();
			await agentSessions.getByTitle('Remove from favorites').click();
			await launched.window.keyboard.press('Escape');

			const reviewRow = agentSessions
				.getByText('Provider Setup Review')
				.locator('xpath=ancestor::div[contains(@class, "cursor-pointer")][1]');
			await expect(reviewRow.getByTitle('Add to favorites')).toBeVisible();
			await expect(await getAgentSessionUpdates(launched.electronApp)).toContainEqual({
				type: 'starred',
				agentId: 'codex',
				projectPath: seeded.projectDir,
				sessionId: 'codex-provider-review',
				starred: false,
			});
		} finally {
			await launched.cleanup();
		}
	});

	test('opens hidden generic provider session detail after Show All', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});

		try {
			await stubCodexAgentSessionStorage(launched.electronApp, seeded.projectDir, {
				includeHiddenAgentSession: true,
			});

			const agentSessions = await openAgentSessions(launched.window, 'Matrix Codex Agent');
			await agentSessions.getByRole('checkbox', { name: 'Show All' }).check();
			await agentSessions.getByText('Hidden Provider Run').click();

			await expect(agentSessions.getByText('Hidden provider detail sentinel.')).toBeVisible();
			await expect(await getAgentSessionReadCalls(launched.electronApp)).toContainEqual({
				agentId: 'codex',
				projectPath: seeded.projectDir,
				sessionId: 'agent-provider-hidden',
			});
		} finally {
			await launched.cleanup();
		}
	});

	test('combines Named and Show All filters for hidden generic provider sessions', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});

		try {
			await stubCodexAgentSessionStorage(launched.electronApp, seeded.projectDir, {
				includeHiddenAgentSession: true,
			});

			const agentSessions = await openAgentSessions(launched.window, 'Matrix Codex Agent');
			await agentSessions.getByRole('checkbox', { name: 'Named' }).check();
			await expect(agentSessions.getByText('Provider Setup Review')).toBeVisible();
			await expect(agentSessions.getByText('Hidden Provider Run')).toBeHidden();
			await expect(agentSessions.getByText('Unnamed provider setup sentinel')).toBeHidden();

			await agentSessions.getByRole('checkbox', { name: 'Show All' }).check();
			await expect(agentSessions.getByText('Hidden Provider Run')).toBeVisible();
			await expect(agentSessions.getByText('Unnamed provider setup sentinel')).toBeHidden();
		} finally {
			await launched.cleanup();
		}
	});

	test('adds a name to an unnamed generic provider session from the list row', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});

		try {
			await stubCodexAgentSessionStorage(launched.electronApp, seeded.projectDir);

			const agentSessions = await openAgentSessions(launched.window, 'Matrix Codex Agent');
			const unnamedRow = agentSessions
				.getByText('Unnamed provider setup sentinel')
				.locator('xpath=ancestor::div[contains(@class, "cursor-pointer")][1]');
			await unnamedRow.hover();
			await unnamedRow.getByTitle('Add session name').click();
			const renameInput = agentSessions.getByPlaceholder('Enter session name...');
			await renameInput.fill('Provider List Named Session');
			await renameInput.press('Enter');

			await expect(agentSessions.getByText('Provider List Named Session')).toBeVisible();
			await expect(await getAgentSessionUpdates(launched.electronApp)).toContainEqual({
				type: 'name',
				agentId: 'codex',
				projectPath: seeded.projectDir,
				sessionId: 'codex-provider-unnamed',
				name: 'Provider List Named Session',
			});
		} finally {
			await launched.cleanup();
		}
	});

	test('clears a generic provider session name from the list row with a blank rename', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});

		try {
			await stubCodexAgentSessionStorage(launched.electronApp, seeded.projectDir);

			const agentSessions = await openAgentSessions(launched.window, 'Matrix Codex Agent');
			const reviewRow = agentSessions
				.getByText('Provider Setup Review')
				.locator('xpath=ancestor::div[contains(@class, "cursor-pointer")][1]');
			await reviewRow.hover();
			await reviewRow.getByTitle('Rename session').click();
			const renameInput = agentSessions.getByPlaceholder('Enter session name...');
			await renameInput.fill('   ');
			await renameInput.press('Enter');

			await expect(agentSessions.getByText('Provider Setup Review')).toHaveCount(0);
			await expect(
				agentSessions.getByText('Review provider setup sentinel coverage')
			).toBeVisible();
			await expect(await getAgentSessionUpdates(launched.electronApp)).toContainEqual({
				type: 'name',
				agentId: 'codex',
				projectPath: seeded.projectDir,
				sessionId: 'codex-provider-review',
				name: null,
			});
		} finally {
			await launched.cleanup();
		}
	});

	test('shows origin metadata pills for generic provider sessions', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});

		try {
			await stubCodexAgentSessionStorage(launched.electronApp, seeded.projectDir, {
				includeHiddenAgentSession: true,
			});

			const agentSessions = await openAgentSessions(launched.window, 'Matrix Codex Agent');
			await expect(agentSessions.getByTitle('User-initiated through Maestro')).toBeVisible();
			await expect(agentSessions.getByTitle('Claude Code CLI session')).toBeVisible();

			await agentSessions.getByRole('checkbox', { name: 'Show All' }).check();
			await expect(agentSessions.getByTitle('Auto-run session')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});

	test('searches hidden generic provider session titles after Show All', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});

		try {
			await stubCodexAgentSessionStorage(launched.electronApp, seeded.projectDir, {
				includeHiddenAgentSession: true,
			});

			const agentSessions = await openAgentSessions(launched.window, 'Matrix Codex Agent');
			await agentSessions.getByRole('checkbox', { name: 'Show All' }).check();
			await selectAgentSessionsSearchMode(agentSessions, 'Title Only');
			const titleSearch = agentSessions.getByPlaceholder('Search titles...');
			await titleSearch.fill('Hidden Provider');

			await expect(agentSessions.getByText('Hidden Provider Run')).toBeVisible();
			await expect(agentSessions.getByText('Provider Setup Review')).toBeHidden();
			await expect(await getAgentSessionSearchCalls(launched.electronApp)).toEqual([]);
		} finally {
			await launched.cleanup();
		}
	});

	test('clears an unmatched generic provider search when switching to activity graph', async () => {
		const seeded = createAgentCrudWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: seeded.homeDir,
			sessions: [seeded.sessions[0]],
		});

		try {
			await stubCodexAgentSessionStorage(launched.electronApp, seeded.projectDir);

			const agentSessions = await openAgentSessions(launched.window, 'Matrix Codex Agent');
			const searchInput = agentSessions.getByPlaceholder('Search all content...');
			await searchInput.fill('missing provider graph sentinel');
			await expect(agentSessions.getByText('No sessions match your search')).toBeVisible();

			await agentSessions.getByTitle('Show activity graph').click();
			await expect(searchInput).toBeHidden();
			await expect(agentSessions.getByText('No sessions match your search')).toBeHidden();

			await agentSessions.getByTitle(/Search sessions/).click();
			await expect(agentSessions.getByPlaceholder('Search all content...')).toHaveValue('');
			await expect(agentSessions.getByText('Provider Setup Review')).toBeVisible();
		} finally {
			await launched.cleanup();
		}
	});
});
