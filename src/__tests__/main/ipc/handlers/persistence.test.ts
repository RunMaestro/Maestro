/**
 * Tests for the persistence IPC handlers
 *
 * These tests verify the settings, sessions, groups, and CLI activity
 * IPC handlers for application data persistence.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain, app } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
	registerPersistenceHandlers,
	PersistenceHandlerDependencies,
	MaestroSettings,
	SessionsData,
	GroupsData,
} from '../../../../main/ipc/handlers/persistence';
import type Store from 'electron-store';
import type { WebServer } from '../../../../main/web-server';

// Mock electron's ipcMain and app
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
	app: {
		getPath: vi.fn().mockReturnValue('/mock/user/data'),
	},
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
	mkdir: vi.fn(),
	access: vi.fn(),
}));

// Mock the logger
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock the themes module
vi.mock('../../../../main/themes', () => ({
	getThemeById: vi.fn().mockReturnValue({
		id: 'dark',
		name: 'Dark',
		colors: {},
	}),
}));

describe('persistence IPC handlers', () => {
	let handlers: Map<string, Function>;
	let mockSettingsStore: {
		get: ReturnType<typeof vi.fn>;
		set: ReturnType<typeof vi.fn>;
		store: Record<string, any>;
	};
	let mockSessionsStore: {
		get: ReturnType<typeof vi.fn>;
		set: ReturnType<typeof vi.fn>;
	};
	let mockGroupsStore: {
		get: ReturnType<typeof vi.fn>;
		set: ReturnType<typeof vi.fn>;
	};
	let mockWebServer: {
		getWebClientCount: ReturnType<typeof vi.fn>;
		broadcastThemeChange: ReturnType<typeof vi.fn>;
		broadcastCustomCommands: ReturnType<typeof vi.fn>;
		broadcastSessionStateChange: ReturnType<typeof vi.fn>;
		broadcastSessionAdded: ReturnType<typeof vi.fn>;
		broadcastSessionRemoved: ReturnType<typeof vi.fn>;
	};
	let getWebServerFn: () => WebServer | null;

	beforeEach(() => {
		// Clear mocks
		vi.clearAllMocks();

		// Create mock stores
		mockSettingsStore = {
			get: vi.fn(),
			set: vi.fn(),
			store: { activeThemeId: 'dark', fontSize: 14 },
		};

		mockSessionsStore = {
			get: vi.fn().mockReturnValue([]),
			set: vi.fn(),
		};

		mockGroupsStore = {
			get: vi.fn().mockReturnValue([]),
			set: vi.fn(),
		};

		mockWebServer = {
			getWebClientCount: vi.fn().mockReturnValue(0),
			broadcastThemeChange: vi.fn(),
			broadcastCustomCommands: vi.fn(),
			broadcastSessionStateChange: vi.fn(),
			broadcastSessionAdded: vi.fn(),
			broadcastSessionRemoved: vi.fn(),
		};

		getWebServerFn = () => mockWebServer as unknown as WebServer;

		// Capture all registered handlers
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});

		// Register handlers
		const deps: PersistenceHandlerDependencies = {
			settingsStore: mockSettingsStore as unknown as Store<MaestroSettings>,
			sessionsStore: mockSessionsStore as unknown as Store<SessionsData>,
			groupsStore: mockGroupsStore as unknown as Store<GroupsData>,
			getWebServer: getWebServerFn,
		};
		registerPersistenceHandlers(deps);
	});

	afterEach(() => {
		handlers.clear();
	});

	describe('registration', () => {
		it('should register all persistence handlers', () => {
			const expectedChannels = [
				'settings:get',
				'settings:set',
				'settings:getAll',
				'sessions:getAll',
				'sessions:setAll',
				'groups:getAll',
				'groups:setAll',
				'cli:getActivity',
			];

			for (const channel of expectedChannels) {
				expect(handlers.has(channel)).toBe(true);
			}
			expect(handlers.size).toBe(expectedChannels.length);
		});
	});

	describe('settings:get', () => {
		it('should retrieve setting by key', async () => {
			mockSettingsStore.get.mockReturnValue('dark');

			const handler = handlers.get('settings:get');
			const result = await handler!({} as any, 'activeThemeId');

			expect(mockSettingsStore.get).toHaveBeenCalledWith('activeThemeId');
			expect(result).toBe('dark');
		});

		it('should return undefined for missing key', async () => {
			mockSettingsStore.get.mockReturnValue(undefined);

			const handler = handlers.get('settings:get');
			const result = await handler!({} as any, 'nonExistentKey');

			expect(mockSettingsStore.get).toHaveBeenCalledWith('nonExistentKey');
			expect(result).toBeUndefined();
		});

		it('should retrieve nested key values', async () => {
			mockSettingsStore.get.mockReturnValue({ ctrl: true, key: 'k' });

			const handler = handlers.get('settings:get');
			const result = await handler!({} as any, 'shortcuts.openCommandPalette');

			expect(mockSettingsStore.get).toHaveBeenCalledWith('shortcuts.openCommandPalette');
			expect(result).toEqual({ ctrl: true, key: 'k' });
		});
	});

	describe('settings:set', () => {
		it('should store setting value', async () => {
			const handler = handlers.get('settings:set');
			const result = await handler!({} as any, 'fontSize', 16);

			expect(mockSettingsStore.set).toHaveBeenCalledWith('fontSize', 16);
			expect(result).toBe(true);
		});

		it('should persist string value', async () => {
			const handler = handlers.get('settings:set');
			const result = await handler!({} as any, 'fontFamily', 'Monaco');

			expect(mockSettingsStore.set).toHaveBeenCalledWith('fontFamily', 'Monaco');
			expect(result).toBe(true);
		});

		it('should handle nested keys', async () => {
			const handler = handlers.get('settings:set');
			const result = await handler!({} as any, 'shortcuts.newTab', { ctrl: true, key: 't' });

			expect(mockSettingsStore.set).toHaveBeenCalledWith('shortcuts.newTab', {
				ctrl: true,
				key: 't',
			});
			expect(result).toBe(true);
		});

		it('should broadcast theme changes to connected web clients', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(3);
			const { getThemeById } = await import('../../../../main/themes');

			const handler = handlers.get('settings:set');
			await handler!({} as any, 'activeThemeId', 'light');

			expect(mockSettingsStore.set).toHaveBeenCalledWith('activeThemeId', 'light');
			expect(getThemeById).toHaveBeenCalledWith('light');
			expect(mockWebServer.broadcastThemeChange).toHaveBeenCalled();
		});

		it('should not broadcast theme changes when no web clients connected', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(0);

			const handler = handlers.get('settings:set');
			await handler!({} as any, 'activeThemeId', 'light');

			expect(mockWebServer.broadcastThemeChange).not.toHaveBeenCalled();
		});

		it('should broadcast custom commands changes to connected web clients', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(2);
			const customCommands = [{ name: 'test', prompt: 'test prompt' }];

			const handler = handlers.get('settings:set');
			await handler!({} as any, 'customAICommands', customCommands);

			expect(mockWebServer.broadcastCustomCommands).toHaveBeenCalledWith(customCommands);
		});

		it('should not broadcast custom commands when no web clients connected', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(0);

			const handler = handlers.get('settings:set');
			await handler!({} as any, 'customAICommands', []);

			expect(mockWebServer.broadcastCustomCommands).not.toHaveBeenCalled();
		});

		it('should handle null webServer gracefully', async () => {
			// Re-register handlers with null webServer
			handlers.clear();
			const deps: PersistenceHandlerDependencies = {
				settingsStore: mockSettingsStore as unknown as Store<MaestroSettings>,
				sessionsStore: mockSessionsStore as unknown as Store<SessionsData>,
				groupsStore: mockGroupsStore as unknown as Store<GroupsData>,
				getWebServer: () => null,
			};
			registerPersistenceHandlers(deps);

			const handler = handlers.get('settings:set');
			const result = await handler!({} as any, 'activeThemeId', 'dark');

			expect(result).toBe(true);
			expect(mockSettingsStore.set).toHaveBeenCalledWith('activeThemeId', 'dark');
		});
	});

	describe('settings:getAll', () => {
		it('should return all settings', async () => {
			const handler = handlers.get('settings:getAll');
			const result = await handler!({} as any);

			expect(result).toEqual({ activeThemeId: 'dark', fontSize: 14 });
		});

		it('should return empty object when no settings exist', async () => {
			mockSettingsStore.store = {};

			const handler = handlers.get('settings:getAll');
			const result = await handler!({} as any);

			expect(result).toEqual({});
		});
	});

	describe('sessions:getAll', () => {
		it('should load sessions from store', async () => {
			const mockSessions = [
				{ id: 'session-1', name: 'Session 1', cwd: '/test' },
				{ id: 'session-2', name: 'Session 2', cwd: '/test2' },
			];
			mockSessionsStore.get.mockReturnValue(mockSessions);

			const handler = handlers.get('sessions:getAll');
			const result = await handler!({} as any);

			expect(mockSessionsStore.get).toHaveBeenCalledWith('sessions', []);
			expect(result).toEqual(mockSessions);
		});

		it('should return empty array for missing sessions', async () => {
			mockSessionsStore.get.mockReturnValue([]);

			const handler = handlers.get('sessions:getAll');
			const result = await handler!({} as any);

			expect(result).toEqual([]);
		});
	});

	describe('sessions:setAll', () => {
		it('should write sessions to store', async () => {
			const sessions = [
				{
					id: 'session-1',
					name: 'Session 1',
					cwd: '/test',
					state: 'idle',
					inputMode: 'ai',
					toolType: 'claude-code',
				},
			];
			mockSessionsStore.get.mockReturnValue([]);

			const handler = handlers.get('sessions:setAll');
			const result = await handler!({} as any, sessions);

			expect(mockSessionsStore.set).toHaveBeenCalledWith('sessions', sessions);
			expect(result).toBe(true);
		});

		it('should detect new sessions and broadcast to web clients', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(2);
			const previousSessions: any[] = [];
			mockSessionsStore.get.mockReturnValue(previousSessions);

			const newSessions = [
				{
					id: 'session-1',
					name: 'Session 1',
					cwd: '/test',
					state: 'idle',
					inputMode: 'ai',
					toolType: 'claude-code',
				},
			];

			const handler = handlers.get('sessions:setAll');
			await handler!({} as any, newSessions);

			expect(mockWebServer.broadcastSessionAdded).toHaveBeenCalledWith({
				id: 'session-1',
				name: 'Session 1',
				toolType: 'claude-code',
				state: 'idle',
				inputMode: 'ai',
				cwd: '/test',
				groupId: null,
				groupName: null,
				groupEmoji: null,
				parentSessionId: null,
				worktreeBranch: null,
			});
		});

		it('should detect removed sessions and broadcast to web clients', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(2);
			const previousSessions = [
				{
					id: 'session-1',
					name: 'Session 1',
					cwd: '/test',
					state: 'idle',
					inputMode: 'ai',
					toolType: 'claude-code',
				},
			];
			mockSessionsStore.get.mockReturnValue(previousSessions);

			const handler = handlers.get('sessions:setAll');
			await handler!({} as any, []);

			expect(mockWebServer.broadcastSessionRemoved).toHaveBeenCalledWith('session-1');
		});

		it('should detect state changes and broadcast to web clients', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(2);
			const previousSessions = [
				{
					id: 'session-1',
					name: 'Session 1',
					cwd: '/test',
					state: 'idle',
					inputMode: 'ai',
					toolType: 'claude-code',
				},
			];
			mockSessionsStore.get.mockReturnValue(previousSessions);

			const updatedSessions = [
				{
					id: 'session-1',
					name: 'Session 1',
					cwd: '/test',
					state: 'busy',
					inputMode: 'ai',
					toolType: 'claude-code',
				},
			];

			const handler = handlers.get('sessions:setAll');
			await handler!({} as any, updatedSessions);

			expect(mockWebServer.broadcastSessionStateChange).toHaveBeenCalledWith('session-1', 'busy', {
				name: 'Session 1',
				toolType: 'claude-code',
				inputMode: 'ai',
				cwd: '/test',
				cliActivity: undefined,
			});
		});

		it('should detect name changes and broadcast to web clients', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(2);
			const previousSessions = [
				{
					id: 'session-1',
					name: 'Session 1',
					cwd: '/test',
					state: 'idle',
					inputMode: 'ai',
					toolType: 'claude-code',
				},
			];
			mockSessionsStore.get.mockReturnValue(previousSessions);

			const updatedSessions = [
				{
					id: 'session-1',
					name: 'Renamed Session',
					cwd: '/test',
					state: 'idle',
					inputMode: 'ai',
					toolType: 'claude-code',
				},
			];

			const handler = handlers.get('sessions:setAll');
			await handler!({} as any, updatedSessions);

			expect(mockWebServer.broadcastSessionStateChange).toHaveBeenCalled();
		});

		it('should detect inputMode changes and broadcast to web clients', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(2);
			const previousSessions = [
				{
					id: 'session-1',
					name: 'Session 1',
					cwd: '/test',
					state: 'idle',
					inputMode: 'ai',
					toolType: 'claude-code',
				},
			];
			mockSessionsStore.get.mockReturnValue(previousSessions);

			const updatedSessions = [
				{
					id: 'session-1',
					name: 'Session 1',
					cwd: '/test',
					state: 'idle',
					inputMode: 'terminal',
					toolType: 'claude-code',
				},
			];

			const handler = handlers.get('sessions:setAll');
			await handler!({} as any, updatedSessions);

			expect(mockWebServer.broadcastSessionStateChange).toHaveBeenCalled();
		});

		it('should detect cliActivity changes and broadcast to web clients', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(2);
			const previousSessions = [
				{
					id: 'session-1',
					name: 'Session 1',
					cwd: '/test',
					state: 'idle',
					inputMode: 'ai',
					toolType: 'claude-code',
					cliActivity: null,
				},
			];
			mockSessionsStore.get.mockReturnValue(previousSessions);

			const updatedSessions = [
				{
					id: 'session-1',
					name: 'Session 1',
					cwd: '/test',
					state: 'idle',
					inputMode: 'ai',
					toolType: 'claude-code',
					cliActivity: { active: true },
				},
			];

			const handler = handlers.get('sessions:setAll');
			await handler!({} as any, updatedSessions);

			expect(mockWebServer.broadcastSessionStateChange).toHaveBeenCalled();
		});

		it('should not broadcast when no web clients connected', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(0);
			const sessions = [
				{
					id: 'session-1',
					name: 'Session 1',
					cwd: '/test',
					state: 'idle',
					inputMode: 'ai',
					toolType: 'claude-code',
				},
			];
			mockSessionsStore.get.mockReturnValue([]);

			const handler = handlers.get('sessions:setAll');
			await handler!({} as any, sessions);

			expect(mockWebServer.broadcastSessionAdded).not.toHaveBeenCalled();
		});

		it('should not broadcast when session unchanged', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(2);
			const sessions = [
				{
					id: 'session-1',
					name: 'Session 1',
					cwd: '/test',
					state: 'idle',
					inputMode: 'ai',
					toolType: 'claude-code',
				},
			];
			mockSessionsStore.get.mockReturnValue(sessions);

			const handler = handlers.get('sessions:setAll');
			await handler!({} as any, sessions);

			expect(mockWebServer.broadcastSessionStateChange).not.toHaveBeenCalled();
			expect(mockWebServer.broadcastSessionAdded).not.toHaveBeenCalled();
			expect(mockWebServer.broadcastSessionRemoved).not.toHaveBeenCalled();
		});

		it('should handle multiple sessions with mixed changes', async () => {
			mockWebServer.getWebClientCount.mockReturnValue(2);
			const previousSessions = [
				{
					id: 'session-1',
					name: 'Session 1',
					cwd: '/test',
					state: 'idle',
					inputMode: 'ai',
					toolType: 'claude-code',
				},
				{
					id: 'session-2',
					name: 'Session 2',
					cwd: '/test2',
					state: 'idle',
					inputMode: 'ai',
					toolType: 'claude-code',
				},
			];
			mockSessionsStore.get.mockReturnValue(previousSessions);

			const newSessions = [
				{
					id: 'session-1',
					name: 'Session 1',
					cwd: '/test',
					state: 'busy',
					inputMode: 'ai',
					toolType: 'claude-code',
				}, // state changed
				// session-2 removed
				{
					id: 'session-3',
					name: 'Session 3',
					cwd: '/test3',
					state: 'idle',
					inputMode: 'ai',
					toolType: 'claude-code',
				}, // new
			];

			const handler = handlers.get('sessions:setAll');
			await handler!({} as any, newSessions);

			expect(mockWebServer.broadcastSessionStateChange).toHaveBeenCalledWith(
				'session-1',
				'busy',
				expect.any(Object)
			);
			expect(mockWebServer.broadcastSessionRemoved).toHaveBeenCalledWith('session-2');
			expect(mockWebServer.broadcastSessionAdded).toHaveBeenCalledWith(
				expect.objectContaining({ id: 'session-3' })
			);
		});
	});

	describe('groups:getAll', () => {
		it('should load groups from store', async () => {
			const mockGroups = [
				{ id: 'group-1', name: 'Group 1' },
				{ id: 'group-2', name: 'Group 2' },
			];
			mockGroupsStore.get.mockReturnValue(mockGroups);

			const handler = handlers.get('groups:getAll');
			const result = await handler!({} as any);

			expect(mockGroupsStore.get).toHaveBeenCalledWith('groups', []);
			expect(result).toEqual(mockGroups);
		});

		it('should return empty array for missing groups', async () => {
			mockGroupsStore.get.mockReturnValue([]);

			const handler = handlers.get('groups:getAll');
			const result = await handler!({} as any);

			expect(result).toEqual([]);
		});
	});

	describe('groups:setAll', () => {
		it('should write groups to store', async () => {
			const groups = [
				{ id: 'group-1', name: 'Group 1' },
				{ id: 'group-2', name: 'Group 2' },
			];

			const handler = handlers.get('groups:setAll');
			const result = await handler!({} as any, groups);

			expect(mockGroupsStore.set).toHaveBeenCalledWith('groups', groups);
			expect(result).toBe(true);
		});

		it('should handle empty groups array', async () => {
			const handler = handlers.get('groups:setAll');
			const result = await handler!({} as any, []);

			expect(mockGroupsStore.set).toHaveBeenCalledWith('groups', []);
			expect(result).toBe(true);
		});
	});

	describe('cli:getActivity', () => {
		it('should return activities from CLI activity file', async () => {
			const mockActivities = [
				{ sessionId: 'session-1', action: 'started', timestamp: Date.now() },
				{ sessionId: 'session-2', action: 'completed', timestamp: Date.now() },
			];

			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ activities: mockActivities }));

			const handler = handlers.get('cli:getActivity');
			const result = await handler!({} as any);

			expect(app.getPath).toHaveBeenCalledWith('userData');
			expect(fs.readFile).toHaveBeenCalledWith(
				path.join('/mock/user/data', 'cli-activity.json'),
				'utf-8'
			);
			expect(result).toEqual(mockActivities);
		});

		it('should return empty array when file does not exist', async () => {
			const error = new Error('ENOENT: no such file or directory');
			(error as any).code = 'ENOENT';
			vi.mocked(fs.readFile).mockRejectedValue(error);

			const handler = handlers.get('cli:getActivity');
			const result = await handler!({} as any);

			expect(result).toEqual([]);
		});

		it('should return empty array for corrupted JSON', async () => {
			vi.mocked(fs.readFile).mockResolvedValue('not valid json');

			const handler = handlers.get('cli:getActivity');
			const result = await handler!({} as any);

			expect(result).toEqual([]);
		});

		it('should return empty array when activities property is missing', async () => {
			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({}));

			const handler = handlers.get('cli:getActivity');
			const result = await handler!({} as any);

			expect(result).toEqual([]);
		});

		it('should return empty array for empty activities', async () => {
			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ activities: [] }));

			const handler = handlers.get('cli:getActivity');
			const result = await handler!({} as any);

			expect(result).toEqual([]);
		});
	});
});
