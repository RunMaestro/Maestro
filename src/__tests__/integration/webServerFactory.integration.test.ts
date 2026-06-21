import { ipcMain } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, WebContents } from 'electron';

import {
	createWebServerFactory,
	type WebServerFactoryDependencies,
} from '../../main/web-server/web-server-factory';
import { WebServer } from '../../main/web-server/WebServer';
import { getHistoryManager } from '../../main/history-manager';
import { logger } from '../../main/utils/logger';

vi.mock('electron', () => ({
	app: {},
	ipcMain: {
		once: vi.fn(),
		removeListener: vi.fn(),
	},
}));

vi.mock('../../main/web-server/WebServer', () => ({
	WebServer: class MockWebServer {
		port: number;
		securityToken: string | undefined;
		broadcastSettingsChanged = vi.fn();

		constructor(port: number, securityToken?: string) {
			this.port = port;
			this.securityToken = securityToken;
			return new Proxy(this, {
				get(target, prop, receiver) {
					if (typeof prop === 'string' && prop.startsWith('set')) {
						const targetWithSetters = target as MockWebServer &
							Record<string, ReturnType<typeof vi.fn>>;
						targetWithSetters[prop] ??= vi.fn();
						return targetWithSetters[prop];
					}
					return Reflect.get(target, prop, receiver);
				},
			});
		}
	},
}));

vi.mock('../../main/themes', () => ({
	getThemeById: vi.fn((id: string) => ({ id, name: `Theme ${id}` })),
}));

const historyManager = vi.hoisted(() => ({
	getEntries: vi.fn(() => [{ id: 'entry-session', timestamp: 3 }]),
	getEntriesByProjectPath: vi.fn(() => [{ id: 'entry-project', timestamp: 2 }]),
	getAllEntries: vi.fn(() => [{ id: 'entry-all', timestamp: 1 }]),
}));

const marketplaceService = vi.hoisted(() => ({
	getMarketplaceManifest: vi.fn(async () => ({ playbooks: [{ id: 'cached' }] })),
	refreshMarketplaceManifest: vi.fn(async () => ({ playbooks: [{ id: 'fresh' }] })),
	getMarketplaceDocument: vi.fn(async () => ({ content: '# Doc' })),
	getMarketplaceReadme: vi.fn(async () => ({ content: '# Readme' })),
	importMarketplacePlaybook: vi.fn(async () => ({
		playbook: { id: 'playbook-1' },
		importedDocs: ['plan.md'],
		importedAssets: ['asset.png'],
	})),
}));

vi.mock('../../main/history-manager', () => ({
	getHistoryManager: vi.fn(() => historyManager),
}));

vi.mock('../../main/services/marketplace-service', () => marketplaceService);

vi.mock('../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

function callback<T extends (...args: any[]) => any>(server: any, setterName: string): T {
	return server[setterName].mock.calls[0][0] as T;
}

describe('web server factory integration', () => {
	let settings: WebServerFactoryDependencies['settingsStore'];
	let sessionsStore: WebServerFactoryDependencies['sessionsStore'];
	let groupsStore: WebServerFactoryDependencies['groupsStore'];
	let webContents: Partial<WebContents>;
	let mainWindow: Partial<BrowserWindow>;
	let processManager: { write: ReturnType<typeof vi.fn> };
	let deps: WebServerFactoryDependencies;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
		settings = {
			get: vi.fn((key: string, fallback?: any) => {
				const values: Record<string, any> = {
					webInterfaceUseCustomPort: false,
					webInterfaceCustomPort: 8080,
					persistentWebLink: false,
					webAuthToken: null,
					activeThemeId: 'dracula',
					bionifyReadingMode: true,
					customAICommands: [
						{ id: 'cmd-1', command: '/fix', description: 'Fix issue', prompt: 'Fix it' },
					],
				};
				return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback;
			}),
			set: vi.fn(),
		} as never;
		sessionsStore = {
			get: vi.fn((key: string, fallback?: any) => {
				if (key !== 'sessions') return fallback;
				return [
					{
						id: 'session-1',
						name: 'Primary',
						toolType: 'claude-code',
						state: 'busy',
						inputMode: 'ai',
						cwd: '/workspace',
						groupId: 'group-1',
						usageStats: { totalCostUsd: 0.25 },
						agentSessionId: 'agent-session-1',
						thinkingStartTime: 10,
						bookmarked: true,
						parentSessionId: 'parent-1',
						worktreeBranch: 'feature/web',
						autoRunFolderPath: '/workspace/.maestro',
						shellLogs: [{ source: 'shell', text: 'ls' }],
						aiTabs: [
							{
								id: 'tab-1',
								agentSessionId: 'agent-tab-1',
								name: 'Active tab',
								starred: true,
								inputValue: 'draft',
								usageStats: { totalCostUsd: 0.1 },
								createdAt: 1,
								state: 'busy',
								thinkingStartTime: 20,
								logs: [
									{ source: 'stdout', text: `line1\nline2\nline3\nline4`, timestamp: 100 },
									{ source: 'thinking', text: 'hidden thinking', timestamp: 101 },
									{ source: 'tool', text: 'hidden tool', timestamp: 102 },
									{ source: 'stderr', text: 'latest error response', timestamp: 103 },
								],
							},
						],
						activeTabId: 'tab-1',
					},
					{
						id: 'session-2',
						name: 'Terminal',
						toolType: 'terminal',
						state: 'idle',
						inputMode: 'terminal',
						cwd: '/workspace',
						aiTabs: [],
						activeTabId: undefined,
					},
				];
			}),
		};
		groupsStore = {
			get: vi.fn((key: string, fallback?: any) =>
				key === 'groups' ? [{ id: 'group-1', name: 'Team', emoji: '*' }] : fallback
			),
		};
		webContents = {
			send: vi.fn(),
			isDestroyed: vi.fn(() => false),
		};
		mainWindow = {
			isDestroyed: vi.fn(() => false),
			webContents: webContents as WebContents,
		};
		processManager = { write: vi.fn(() => true) };
		deps = {
			settingsStore: settings,
			sessionsStore,
			groupsStore,
			getMainWindow: vi.fn(() => mainWindow as BrowserWindow),
			getProcessManager: vi.fn(() => processManager as any),
			triggerCueSubscription: vi.fn(() => true),
			getCueGraphData: vi.fn(
				() =>
					[
						{
							sessionId: 'session-1',
							sessionName: 'Primary',
							subscriptions: [
								{
									name: 'Daily check',
									event: 'schedule',
									pipeline_name: 'ops',
									enabled: true,
									schedule_times: ['07:00'],
									schedule_days: ['mon', 'wed'],
								},
								{
									name: 'Interval check',
									event: 'interval',
									enabled: false,
									interval_minutes: 5,
								},
							],
						},
					] as any
			),
			setCueSubscriptionEnabled: vi.fn(async () => true),
			getCueActivityLog: vi.fn(
				() =>
					[
						{
							runId: 'run-1',
							sessionId: 'session-1',
							subscriptionName: 'Daily check',
							pipelineName: 'ops',
							event: { type: 'schedule' },
							startedAt: '2026-06-18T12:00:00.000Z',
							status: 'completed',
							stdout: 'done',
							durationMs: 25,
						},
						{
							runId: 'run-2',
							sessionId: 'session-2',
							subscriptionName: 'Other check',
							event: { type: 'manual' },
							startedAt: 'bad-date',
							status: 'timeout',
							stderr: 'timed out',
						},
					] as any
			),
		};
	});

	it('creates servers with custom ports and validates persistent web auth tokens', () => {
		vi.mocked(settings.get).mockImplementation((key: string, fallback?: any) => {
			if (key === 'webInterfaceUseCustomPort') return true;
			if (key === 'webInterfaceCustomPort') return 9999;
			if (key === 'persistentWebLink') return true;
			if (key === 'webAuthToken') return 'not-a-uuid';
			return fallback;
		});

		const server = createWebServerFactory(deps)() as any;

		expect(server).toBeInstanceOf(WebServer);
		expect(server.port).toBe(9999);
		expect(server.securityToken).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
		);
		expect(settings.set).toHaveBeenCalledWith('webAuthToken', server.securityToken);
		expect(logger.warn).toHaveBeenCalledWith(
			'Stored webAuthToken is not a valid UUID, generating new token',
			'WebServerFactory'
		);

		vi.mocked(settings.get).mockImplementation((key: string, fallback?: any) => {
			if (key === 'persistentWebLink') return true;
			if (key === 'webAuthToken') return '123e4567-e89b-42d3-a456-426614174000';
			return fallback;
		});
		const validTokenServer = createWebServerFactory(deps)() as any;
		expect(validTokenServer.securityToken).toBe('123e4567-e89b-42d3-a456-426614174000');
	});

	it('maps session list, session detail, theme, command, and history callbacks', async () => {
		const server = createWebServerFactory(deps)() as any;

		const sessions = callback<() => any[]>(server, 'setGetSessionsCallback')();
		expect(sessions[0]).toMatchObject({
			id: 'session-1',
			groupName: 'Team',
			groupEmoji: '*',
			lastResponse: {
				text: 'latest error response',
				timestamp: 103,
				source: 'stderr',
				fullLength: 21,
			},
			activeTabId: 'tab-1',
			bookmarked: true,
			parentSessionId: 'parent-1',
			worktreeBranch: 'feature/web',
		});
		expect(sessions[0].aiTabs[0]).toEqual({
			id: 'tab-1',
			agentSessionId: 'agent-tab-1',
			name: 'Active tab',
			starred: true,
			inputValue: 'draft',
			usageStats: { totalCostUsd: 0.1 },
			createdAt: 1,
			state: 'busy',
			thinkingStartTime: 20,
			hasUnread: false,
		});

		const detail = callback<(id: string, tabId?: string) => any>(
			server,
			'setGetSessionDetailCallback'
		)('session-1', 'tab-1');
		expect(detail.aiLogs.map((log: any) => log.source)).toEqual([
			'stdout',
			'thinking',
			'tool',
			'stderr',
		]);
		expect(
			callback<(id: string) => any>(server, 'setGetSessionDetailCallback')('missing')
		).toBeNull();

		expect(callback<() => any>(server, 'setGetThemeCallback')()).toEqual({
			id: 'dracula',
			name: 'Theme dracula',
		});
		expect(callback<() => boolean>(server, 'setGetBionifyReadingModeCallback')()).toBe(true);
		expect(callback<() => any[]>(server, 'setGetCustomCommandsCallback')()).toHaveLength(1);

		const history = callback<(projectPath?: string, sessionId?: string) => Promise<any[]>>(
			server,
			'setGetHistoryCallback'
		);
		expect((await history(undefined, 'session-1'))[0].id).toBe('entry-session');
		expect((await history('/workspace'))[0].id).toBe('entry-project');
		expect((await history())[0].id).toBe('entry-all');
		expect(getHistoryManager).toHaveBeenCalled();
	});

	it('writes to the correct process and forwards desktop IPC callbacks through the main window', async () => {
		const server = createWebServerFactory(deps)() as any;

		const write = callback<(id: string, data: string) => boolean>(
			server,
			'setWriteToSessionCallback'
		);
		expect(write('session-1', 'hello')).toBe(true);
		expect(processManager.write).toHaveBeenCalledWith('session-1-ai', 'hello');
		expect(write('session-2', 'ls')).toBe(true);
		expect(processManager.write).toHaveBeenCalledWith('session-2-terminal', 'ls');
		expect(write('missing', 'nope')).toBe(false);

		expect(
			await callback<(id: string, command: string, mode?: 'ai' | 'terminal') => Promise<boolean>>(
				server,
				'setExecuteCommandCallback'
			)('session-1', 'run command', 'ai')
		).toBe(true);
		expect(webContents.send).toHaveBeenCalledWith(
			'remote:executeCommand',
			'session-1',
			'run command',
			'ai',
			undefined,
			undefined,
			undefined
		);

		await callback<(id: string) => Promise<boolean>>(
			server,
			'setInterruptSessionCallback'
		)('session-1');
		await callback<(id: string, mode: 'ai' | 'terminal') => Promise<boolean>>(
			server,
			'setSwitchModeCallback'
		)('session-1', 'terminal');
		await callback<(id: string, tabId?: string) => Promise<boolean>>(
			server,
			'setSelectSessionCallback'
		)('session-1', 'tab-1');
		await callback<(id: string, tabId: string) => Promise<boolean>>(server, 'setSelectTabCallback')(
			'session-1',
			'tab-1'
		);
		await callback<(id: string, tabId: string) => Promise<boolean>>(server, 'setCloseTabCallback')(
			'session-1',
			'tab-1'
		);
		await callback<(id: string, tabId: string, name: string) => Promise<boolean>>(
			server,
			'setRenameTabCallback'
		)('session-1', 'tab-1', 'Renamed');
		await callback<(id: string, tabId: string, starred: boolean) => Promise<boolean>>(
			server,
			'setStarTabCallback'
		)('session-1', 'tab-1', true);
		await callback<(id: string, from: number, to: number) => Promise<boolean>>(
			server,
			'setReorderTabCallback'
		)('session-1', 0, 1);
		await callback<(id: string) => Promise<boolean>>(
			server,
			'setToggleBookmarkCallback'
		)('session-1');

		expect(webContents.send).toHaveBeenCalledWith('remote:interrupt', 'session-1');
		expect(webContents.send).toHaveBeenCalledWith('remote:switchMode', 'session-1', 'terminal');
		expect(webContents.send).toHaveBeenCalledWith('remote:selectSession', 'session-1', 'tab-1');
		expect(webContents.send).toHaveBeenCalledWith('remote:selectTab', 'session-1', 'tab-1');
		expect(webContents.send).toHaveBeenCalledWith('remote:closeTab', 'session-1', 'tab-1');
		expect(webContents.send).toHaveBeenCalledWith(
			'remote:renameTab',
			'session-1',
			'tab-1',
			'Renamed'
		);
		expect(webContents.send).toHaveBeenCalledWith('remote:starTab', 'session-1', 'tab-1', true);
		expect(webContents.send).toHaveBeenCalledWith('remote:reorderTab', 'session-1', 0, 1);
		expect(webContents.send).toHaveBeenCalledWith('remote:toggleBookmark', 'session-1');
	});

	it('handles unavailable process manager, window, webContents, and new-tab timeout paths', async () => {
		const server = createWebServerFactory({
			...deps,
			getProcessManager: vi.fn(() => null),
		})() as any;
		expect(
			callback<(id: string, data: string) => boolean>(server, 'setWriteToSessionCallback')(
				'session-1',
				'hello'
			)
		).toBe(false);

		const nullWindowServer = createWebServerFactory({
			...deps,
			getMainWindow: vi.fn(() => null),
		})() as any;
		expect(
			await callback<(id: string, command: string) => Promise<boolean>>(
				nullWindowServer,
				'setExecuteCommandCallback'
			)('session-1', 'hello')
		).toBe(false);

		vi.mocked(webContents.isDestroyed!).mockReturnValue(true);
		const unavailableServer = createWebServerFactory(deps)() as any;
		expect(
			await callback<(id: string) => Promise<boolean>>(
				unavailableServer,
				'setInterruptSessionCallback'
			)('session-1')
		).toBe(false);

		vi.useFakeTimers();
		vi.mocked(webContents.isDestroyed!).mockReturnValue(false);
		const timeoutServer = createWebServerFactory(deps)() as any;
		const newTabPromise = callback<(id: string) => Promise<any>>(
			timeoutServer,
			'setNewTabCallback'
		)('session-1');
		expect(ipcMain.once).toHaveBeenCalled();
		expect(webContents.send).toHaveBeenCalledWith(
			'remote:newTab',
			'session-1',
			expect.stringMatching(/^remote:newTab:response:/)
		);
		await vi.advanceTimersByTimeAsync(5000);
		await expect(newTabPromise).resolves.toBeNull();
		expect(ipcMain.removeListener).toHaveBeenCalled();
	});

	it('bridges broad remote callbacks and direct Cue callbacks', async () => {
		vi.mocked(ipcMain.once).mockImplementation((channel, listener) => {
			const responseChannel = String(channel);
			const result = responseChannel.includes('newAITabWithPrompt')
				? { success: true, tabId: 'ai-tab-1' }
				: responseChannel.includes('configureAutoRun') ||
					  responseChannel.includes('setAutoRunFolder') ||
					  responseChannel.includes('updateSessionCwd') ||
					  responseChannel.includes('updateSessionSsh')
					? { success: true }
					: responseChannel.includes('getAutoRunDocs')
						? [{ filename: 'plan.md' }]
						: responseChannel.includes('getAutoRunDocContent')
							? '# Plan'
							: responseChannel.includes('createSession')
								? 'session-new'
								: responseChannel.includes('createWorktreeSession')
									? { success: true, sessionId: 'worktree-1' }
									: responseChannel.includes('createGroup')
										? { id: 'group-new', name: 'Group' }
										: responseChannel.includes('getGitStatus')
											? { branch: 'main', files: [], ahead: 1, behind: 0 }
											: responseChannel.includes('getGitDiff')
												? { diff: 'diff --git', files: ['src/a.ts'] }
												: responseChannel.includes('listPlaybooks')
													? [{ id: 'playbook-1' }]
													: responseChannel.includes('createPlaybook') ||
														  responseChannel.includes('updatePlaybook')
														? { id: 'playbook-1' }
														: responseChannel.includes('getGroupChats')
															? [{ id: 'chat-1' }]
															: responseChannel.includes('startGroupChat')
																? { id: 'chat-2' }
																: responseChannel.includes('getGroupChatState')
																	? { id: 'chat-1', status: 'running' }
																	: responseChannel.includes('createGist')
																		? { success: true, gistUrl: 'https://gist.example/1' }
																		: responseChannel.includes('getUsageDashboard')
																			? {
																					totalTokensIn: 1,
																					totalTokensOut: 2,
																					totalCost: 0.1,
																					sessionBreakdown: [],
																					dailyUsage: [],
																				}
																			: responseChannel.includes('getAchievements')
																				? [{ id: 'achievement-1' }]
																				: true;
			queueMicrotask(() => listener({} as any, result));
			return ipcMain;
		});

		const server = createWebServerFactory(deps)() as any;

		await expect(
			callback<(id: string, filePath: string, switchToAgent: boolean) => Promise<boolean>>(
				server,
				'setOpenFileTabCallback'
			)('session-1', '/workspace/src/App.tsx', true)
		).resolves.toBe(true);
		await expect(
			callback<(id: string) => Promise<boolean>>(server, 'setRefreshFileTreeCallback')('session-1')
		).resolves.toBe(true);
		await expect(
			callback<(params: any) => Promise<boolean>>(
				server,
				'setNotifyToastCallback'
			)({
				message: 'Saved',
			})
		).resolves.toBe(true);
		await expect(
			callback<(params: any) => Promise<boolean>>(
				server,
				'setNotifyCenterFlashCallback'
			)({
				message: 'Updated',
			})
		).resolves.toBe(true);
		await expect(
			callback<(id: string, url: string) => Promise<boolean>>(server, 'setOpenBrowserTabCallback')(
				'session-1',
				'https://example.com'
			)
		).resolves.toBe(true);
		await expect(
			callback<(id: string, config: any) => Promise<boolean>>(server, 'setOpenTerminalTabCallback')(
				'session-1',
				{ cwd: '/workspace', shell: '/bin/zsh', name: 'Shell' }
			)
		).resolves.toBe(true);
		await expect(
			callback<(id: string, prompt: string) => Promise<any>>(
				server,
				'setNewAITabWithPromptCallback'
			)('session-1', 'Summarize')
		).resolves.toEqual({ success: true, tabId: 'ai-tab-1' });
		await expect(
			callback<(id: string) => Promise<boolean>>(
				server,
				'setRefreshAutoRunDocsCallback'
			)('session-1')
		).resolves.toBe(true);
		await expect(
			callback<(id: string, config: any) => Promise<any>>(server, 'setConfigureAutoRunCallback')(
				'session-1',
				{ enabled: true }
			)
		).resolves.toEqual({ success: true });
		await expect(
			callback<(id: string, folder: string) => Promise<any>>(
				server,
				'setSessionAutoRunFolderCallback'
			)('session-1', '/workspace/docs')
		).resolves.toEqual({ success: true });
		await expect(
			callback<(id: string) => Promise<any[]>>(server, 'setGetAutoRunDocsCallback')('session-1')
		).resolves.toEqual([{ filename: 'plan.md' }]);
		await expect(
			callback<(id: string, filename: string) => Promise<string>>(
				server,
				'setGetAutoRunDocContentCallback'
			)('session-1', 'plan.md')
		).resolves.toBe('# Plan');
		await expect(
			callback<(id: string, filename: string, content: string) => Promise<boolean>>(
				server,
				'setSaveAutoRunDocCallback'
			)('session-1', 'plan.md', '# Updated')
		).resolves.toBe(true);

		expect(callback<() => any>(server, 'setGetSettingsCallback')()).toMatchObject({
			theme: 'dracula',
			autoScroll: true,
		});
		await expect(
			callback<(key: string, value: unknown) => Promise<boolean>>(server, 'setSetSettingCallback')(
				'fontSize',
				16
			)
		).resolves.toBe(true);
		expect(server.broadcastSettingsChanged).toHaveBeenCalled();
		expect(callback<() => any[]>(server, 'setGetGroupsCallback')()).toEqual([
			{ id: 'group-1', name: 'Team', emoji: '*', sessionIds: ['session-1'] },
		]);

		await expect(
			callback<(...args: any[]) => Promise<any>>(server, 'setCreateSessionCallback')(
				'New Agent',
				'claude-code',
				'/workspace',
				'group-1',
				{ model: 'sonnet' }
			)
		).resolves.toBe('session-new');
		await expect(
			callback<(...args: any[]) => Promise<any>>(server, 'setCreateWorktreeSessionCallback')(
				'session-1',
				{ branch: 'feature/test' }
			)
		).resolves.toEqual({ success: true, sessionId: 'worktree-1' });
		await expect(
			callback<(id: string) => Promise<boolean>>(server, 'setDeleteSessionCallback')('session-1')
		).resolves.toBe(true);
		await expect(
			callback<(id: string, name: string) => Promise<boolean>>(server, 'setRenameSessionCallback')(
				'session-1',
				'Renamed'
			)
		).resolves.toBe(true);
		await expect(
			callback<(id: string, cwd: string) => Promise<any>>(server, 'setUpdateSessionCwdCallback')(
				'session-1',
				'/tmp'
			)
		).resolves.toEqual({ success: true, error: undefined });
		await expect(
			callback<(id: string, patch: Record<string, unknown>) => Promise<any>>(
				server,
				'setUpdateSessionSshCallback'
			)('session-1', { enabled: true })
		).resolves.toEqual({ success: true, error: undefined });

		await expect(
			callback<(name: string, emoji?: string) => Promise<any>>(server, 'setCreateGroupCallback')(
				'Group',
				'*'
			)
		).resolves.toEqual({ id: 'group-new', name: 'Group' });
		await expect(
			callback<(id: string, name: string) => Promise<boolean>>(server, 'setRenameGroupCallback')(
				'group-1',
				'New Group'
			)
		).resolves.toBe(true);
		await expect(
			callback<(id: string) => Promise<boolean>>(server, 'setDeleteGroupCallback')('group-1')
		).resolves.toBe(true);
		await expect(
			callback<(sessionId: string, groupId: string | null) => Promise<boolean>>(
				server,
				'setMoveSessionToGroupCallback'
			)('session-1', null)
		).resolves.toBe(true);
		await expect(
			callback<(id: string) => Promise<any>>(server, 'setGetGitStatusCallback')('session-1')
		).resolves.toMatchObject({ branch: 'main' });
		await expect(
			callback<(id: string, file?: string) => Promise<any>>(server, 'setGetGitDiffCallback')(
				'session-1',
				'src/a.ts'
			)
		).resolves.toMatchObject({ diff: 'diff --git' });

		for (const [setter, args] of [
			['setStopAutoRunCallback', ['session-1']],
			['setResetAutoRunDocTasksCallback', ['session-1', 'plan.md']],
			['setResumeAutoRunErrorCallback', ['session-1']],
			['setSkipAutoRunDocumentCallback', ['session-1']],
			['setAbortAutoRunErrorCallback', ['session-1']],
			['setDeletePlaybookCallback', ['session-1', 'playbook-1']],
			['setStopGroupChatCallback', ['chat-1']],
			['setSendGroupChatMessageCallback', ['chat-1', 'hello']],
			['setMergeContextCallback', ['session-1', 'session-2']],
			['setTransferContextCallback', ['session-1', 'session-2']],
			['setSummarizeContextCallback', ['session-1']],
		] as const) {
			await expect(
				callback<(...args: any[]) => Promise<boolean>>(server, setter)(...args)
			).resolves.toBe(true);
		}
		await expect(
			callback<(sessionId: string) => Promise<any[]>>(
				server,
				'setListPlaybooksCallback'
			)('session-1')
		).resolves.toEqual([{ id: 'playbook-1' }]);
		await expect(
			callback<(sessionId: string, playbook: any) => Promise<any>>(
				server,
				'setCreatePlaybookCallback'
			)('session-1', { name: 'Playbook' })
		).resolves.toEqual({ id: 'playbook-1' });
		await expect(
			callback<(sessionId: string, playbookId: string, updates: any) => Promise<any>>(
				server,
				'setUpdatePlaybookCallback'
			)('session-1', 'playbook-1', { name: 'Updated' })
		).resolves.toEqual({ id: 'playbook-1' });
		await expect(
			callback<() => Promise<any[]>>(server, 'setGetGroupChatsCallback')()
		).resolves.toEqual([{ id: 'chat-1' }]);
		await expect(
			callback<(topic: string, participantIds: string[]) => Promise<any>>(
				server,
				'setStartGroupChatCallback'
			)('Topic', ['session-1'])
		).resolves.toEqual({ id: 'chat-2' });
		await expect(
			callback<(chatId: string) => Promise<any>>(server, 'setGetGroupChatStateCallback')('chat-1')
		).resolves.toEqual({ id: 'chat-1', status: 'running' });
		await expect(
			callback<(id: string, description: string, isPublic: boolean) => Promise<any>>(
				server,
				'setCreateGistCallback'
			)('session-1', 'Summary', false)
		).resolves.toEqual({ success: true, gistUrl: 'https://gist.example/1' });

		await expect(
			callback<(sessionId?: string) => Promise<any[]>>(
				server,
				'setGetCueSubscriptionsCallback'
			)('session-1')
		).resolves.toEqual([
			expect.objectContaining({
				id: 'session-1::ops::Daily check',
				schedule: '07:00 (Mon, Wed)',
			}),
			expect.objectContaining({
				id: 'session-1::Interval check::Interval check',
				enabled: false,
				schedule: 'every 5m',
			}),
		]);
		await expect(
			callback<(subscriptionId: string, enabled: boolean) => Promise<boolean>>(
				server,
				'setToggleCueSubscriptionCallback'
			)('session-1::ops::Daily check', false)
		).resolves.toBe(true);
		await expect(
			callback<(sessionId?: string, limit?: number) => Promise<any[]>>(
				server,
				'setGetCueActivityCallback'
			)('session-1', 1)
		).resolves.toEqual([
			expect.objectContaining({
				id: 'run-1',
				status: 'completed',
				result: 'done',
				duration: 25,
			}),
		]);
		await expect(
			callback<(...args: any[]) => Promise<boolean>>(server, 'setTriggerCueSubscriptionCallback')(
				'Daily check',
				'Prompt',
				'session-1'
			)
		).resolves.toBe(true);
		await expect(
			callback<(range: 'day' | 'week' | 'month' | 'all') => Promise<any>>(
				server,
				'setGetUsageDashboardCallback'
			)('week')
		).resolves.toMatchObject({ totalTokensIn: 1 });
		await expect(
			callback<() => Promise<any[]>>(server, 'setGetAchievementsCallback')()
		).resolves.toEqual([{ id: 'achievement-1' }]);

		expect(webContents.send).toHaveBeenCalledWith(
			'remote:openFileTab',
			'session-1',
			'/workspace/src/App.tsx',
			true
		);
		expect(webContents.send).toHaveBeenCalledWith('remote:stopAutoRun', 'session-1');
		expect(deps.triggerCueSubscription).toHaveBeenCalledWith('Daily check', 'Prompt', 'session-1');
	});

	it('bridges marketplace callbacks and returns typed import failures', async () => {
		const server = createWebServerFactory(deps)() as any;

		await expect(
			callback<(options?: { refresh?: boolean }) => Promise<any>>(
				server,
				'setGetMarketplaceManifestCallback'
			)({ refresh: true })
		).resolves.toEqual({ playbooks: [{ id: 'fresh' }] });
		expect(marketplaceService.refreshMarketplaceManifest).toHaveBeenCalled();

		await expect(
			callback<(options?: { refresh?: boolean }) => Promise<any>>(
				server,
				'setGetMarketplaceManifestCallback'
			)({})
		).resolves.toEqual({ playbooks: [{ id: 'cached' }] });
		expect(marketplaceService.getMarketplaceManifest).toHaveBeenCalled();

		await expect(
			callback<(playbookPath: string, filename: string) => Promise<any>>(
				server,
				'setGetMarketplaceDocumentCallback'
			)('pack/playbook', 'README.md')
		).resolves.toEqual({ content: '# Doc' });
		expect(marketplaceService.getMarketplaceDocument).toHaveBeenCalledWith(
			'pack/playbook',
			'README.md'
		);

		await expect(
			callback<(playbookPath: string) => Promise<any>>(
				server,
				'setGetMarketplaceReadmeCallback'
			)('pack/playbook')
		).resolves.toEqual({ content: '# Readme' });
		expect(marketplaceService.getMarketplaceReadme).toHaveBeenCalledWith('pack/playbook');

		const importMarketplace = callback<
			(sessionId: string, playbookId: string, targetFolderName: string) => Promise<any>
		>(server, 'setImportMarketplacePlaybookCallback');

		await expect(importMarketplace('session-1', 'playbook-1', 'imported')).resolves.toEqual({
			success: true,
			playbook: { id: 'playbook-1' },
			importedDocs: ['plan.md'],
			importedAssets: ['asset.png'],
		});
		expect(marketplaceService.importMarketplacePlaybook).toHaveBeenCalledWith(
			expect.objectContaining({
				playbookId: 'playbook-1',
				targetFolderName: 'imported',
				autoRunFolderPath: '/workspace/.maestro',
				sessionId: 'session-1',
				sshConfig: undefined,
			})
		);

		await expect(importMarketplace('missing', 'playbook-1', 'imported')).resolves.toEqual({
			success: false,
			error: 'Session not found: missing',
		});
		await expect(importMarketplace('session-2', 'playbook-1', 'imported')).resolves.toEqual({
			success: false,
			error: 'Session has no Auto Run folder configured',
		});

		vi.mocked(sessionsStore.get).mockReturnValueOnce([
			{
				id: 'ssh-session',
				name: 'SSH',
				toolType: 'claude-code',
				cwd: '/remote',
				autoRunFolderPath: '/remote/.maestro',
				sessionSshRemoteConfig: { enabled: true },
			},
		] as any);
		await expect(importMarketplace('ssh-session', 'playbook-1', 'imported')).resolves.toEqual({
			success: false,
			error: 'SSH remote not found or disabled',
		});

		vi.mocked(marketplaceService.importMarketplacePlaybook).mockRejectedValueOnce(
			new Error('import failed')
		);
		await expect(importMarketplace('session-1', 'playbook-1', 'imported')).resolves.toEqual({
			success: false,
			error: 'import failed',
		});
		expect(logger.error).toHaveBeenCalledWith(
			'Marketplace import failed for playbook-1: import failed',
			'WebServer'
		);
	});
});
