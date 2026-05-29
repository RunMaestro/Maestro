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
	ipcMain: {
		once: vi.fn(),
		removeListener: vi.fn(),
	},
}));

vi.mock('../../main/web-server/WebServer', () => ({
	WebServer: class MockWebServer {
		port: number;
		securityToken: string | undefined;
		setGetSessionsCallback = vi.fn();
		setGetSessionDetailCallback = vi.fn();
		setGetThemeCallback = vi.fn();
		setGetBionifyReadingModeCallback = vi.fn();
		setGetCustomCommandsCallback = vi.fn();
		setGetHistoryCallback = vi.fn();
		setWriteToSessionCallback = vi.fn();
		setExecuteCommandCallback = vi.fn();
		setInterruptSessionCallback = vi.fn();
		setSwitchModeCallback = vi.fn();
		setSelectSessionCallback = vi.fn();
		setSelectTabCallback = vi.fn();
		setNewTabCallback = vi.fn();
		setCloseTabCallback = vi.fn();
		setRenameTabCallback = vi.fn();
		setStarTabCallback = vi.fn();
		setReorderTabCallback = vi.fn();
		setToggleBookmarkCallback = vi.fn();

		constructor(port: number, securityToken?: string) {
			this.port = port;
			this.securityToken = securityToken;
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

vi.mock('../../main/history-manager', () => ({
	getHistoryManager: vi.fn(() => historyManager),
}));

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

	it('maps session list, session detail, theme, command, and history callbacks', () => {
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
		});

		const detail = callback<(id: string, tabId?: string) => any>(
			server,
			'setGetSessionDetailCallback'
		)('session-1', 'tab-1');
		expect(detail.aiLogs.map((log: any) => log.source)).toEqual(['stdout', 'stderr']);
		expect(
			callback<(id: string) => any>(server, 'setGetSessionDetailCallback')('missing')
		).toBeNull();

		expect(callback<() => any>(server, 'setGetThemeCallback')()).toEqual({
			id: 'dracula',
			name: 'Theme dracula',
		});
		expect(callback<() => boolean>(server, 'setGetBionifyReadingModeCallback')()).toBe(true);
		expect(callback<() => any[]>(server, 'setGetCustomCommandsCallback')()).toHaveLength(1);

		const history = callback<(projectPath?: string, sessionId?: string) => any[]>(
			server,
			'setGetHistoryCallback'
		);
		expect(history(undefined, 'session-1')[0].id).toBe('entry-session');
		expect(history('/workspace')[0].id).toBe('entry-project');
		expect(history()[0].id).toBe('entry-all');
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
			'ai'
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
});
