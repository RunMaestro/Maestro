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
	providers: ProviderMatrixRow[] = PROVIDER_MATRIX,
	unavailableProviderIds: ProviderMatrixRow['id'][] = []
) {
	await electronApp.evaluate(
		({ ipcMain }, payload) => {
			const capabilities = { supportsBatchMode: true, supportsModelSelection: false };
			const agents = payload.providers.map((row) => {
				const available = !payload.unavailableProviderIds.includes(row.id);
				return {
					id: row.id,
					name: row.displayName,
					binaryName: row.binaryName,
					command: row.command,
					args: [],
					available,
					path: available ? row.customPath : null,
					capabilities,
				};
			});

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
		},
		{ providers, unavailableProviderIds }
	);
}

async function stubCodexAgentSessionStorage(electronApp: ElectronApplication, projectPath: string) {
	await electronApp.evaluate(
		({ ipcMain }, payload) => {
			const state = globalThis as typeof globalThis & {
				__maestroE2eAgentCrudSearchCalls?: AgentSessionSearchCall[];
				__maestroE2eAgentCrudSessionUpdates?: AgentSessionUpdate[];
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
			state.__maestroE2eAgentCrudSessionUpdates = [];

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

async function getAgentSessionUpdates(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & {
			__maestroE2eAgentCrudSessionUpdates?: AgentSessionUpdate[];
		};
		return state.__maestroE2eAgentCrudSessionUpdates || [];
	});
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

async function openEditAgentDialog(window: Page, agentName: string) {
	const sessionList = window.locator('[data-tour="session-list"]');
	await sessionList.getByText(agentName, { exact: true }).click();

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
		.fill('Edit Agent');
	await quickActionsDialog
		.getByRole('button', { name: new RegExp(`Edit Agent: ${escapeRegExp(agentName)}`) })
		.click();

	await expect(quickActionsDialog).toBeHidden();
	const dialog = window.getByRole('dialog', { name: `Edit Agent: ${agentName}` });
	await expect(dialog).toBeVisible();
	return dialog;
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
			await expect(editAgentDialog.getByText('OpenCode Settings')).toBeVisible();

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
			await agentSessions.getByRole('button', { name: /All/ }).click();
			await agentSessions.getByRole('button', { name: /My Messages/ }).click();
			const userSearch = agentSessions.getByPlaceholder('Search your messages...');
			await userSearch.fill('review provider setup');
			await expect(
				agentSessions.getByText('Review provider setup sentinel coverage.')
			).toBeVisible();

			await userSearch.fill('');
			await agentSessions.getByRole('button', { name: /User/ }).click();
			await agentSessions.getByRole('button', { name: /AI Responses/ }).click();
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
});

test.describe.skip('Real provider state coverage gated by MAESTRO_E2E_REAL_PROVIDER_STATE', () => {
	test('loads real Codex provider sessions without IPC stubs', async () => {});
	test('loads real Factory Droid provider sessions without IPC stubs', async () => {});
});
