/**
 * Tests for CallbackRegistry
 *
 * The CallbackRegistry centralizes all callback storage for the WebServer.
 * It provides typed getter/setter methods and safe fallback defaults when
 * callbacks are not registered.
 *
 * Tested behavior:
 * - Initial state returns safe defaults ([], null, false)
 * - Each setter/getter pair works correctly
 * - hasCallback() reflects registration state
 * - Arguments are passed through to registered callbacks
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CallbackRegistry } from '../../../../main/web-server/managers/CallbackRegistry';
import type {
	SessionData,
	SessionDetail,
	CustomAICommand,
	Theme,
} from '../../../../main/web-server/types';
import type { HistoryEntry } from '../../../../shared/types';

// Mock the logger
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

describe('CallbackRegistry', () => {
	let registry: CallbackRegistry;

	beforeEach(() => {
		registry = new CallbackRegistry();
	});

	// =========================================================================
	// Initial state
	// =========================================================================

	describe('initial state', () => {
		it('getSessions() returns empty array when no callback set', () => {
			expect(registry.getSessions()).toEqual([]);
		});

		it('getSessionDetail() returns null when no callback set', () => {
			expect(registry.getSessionDetail('session-1')).toBeNull();
		});

		it('getSessionDetail() returns null with tabId when no callback set', () => {
			expect(registry.getSessionDetail('session-1', 'tab-1')).toBeNull();
		});

		it('getTheme() returns null when no callback set', () => {
			expect(registry.getTheme()).toBeNull();
		});

		it('getCustomCommands() returns empty array when no callback set', () => {
			expect(registry.getCustomCommands()).toEqual([]);
		});

		it('writeToSession() returns false when no callback set', () => {
			expect(registry.writeToSession('session-1', 'data')).toBe(false);
		});

		it('executeCommand() returns false when no callback set', async () => {
			expect(await registry.executeCommand('session-1', 'ls')).toBe(false);
		});

		it('interruptSession() returns false when no callback set', async () => {
			expect(await registry.interruptSession('session-1')).toBe(false);
		});

		it('switchMode() returns false when no callback set', async () => {
			expect(await registry.switchMode('session-1', 'terminal')).toBe(false);
		});

		it('selectSession() returns false when no callback set', async () => {
			expect(await registry.selectSession('session-1')).toBe(false);
		});

		it('selectSession() returns false with tabId when no callback set', async () => {
			expect(await registry.selectSession('session-1', 'tab-1')).toBe(false);
		});

		it('selectTab() returns false when no callback set', async () => {
			expect(await registry.selectTab('session-1', 'tab-1')).toBe(false);
		});

		it('newTab() returns null when no callback set', async () => {
			expect(await registry.newTab('session-1')).toBeNull();
		});

		it('closeTab() returns false when no callback set', async () => {
			expect(await registry.closeTab('session-1', 'tab-1')).toBe(false);
		});

		it('renameTab() returns false when no callback set', async () => {
			expect(await registry.renameTab('session-1', 'tab-1', 'New Name')).toBe(false);
		});

		it('getHistory() returns empty array when no callback set', () => {
			expect(registry.getHistory()).toEqual([]);
		});

		it('getHistory() returns empty array with args when no callback set', () => {
			expect(registry.getHistory('/project', 'session-1')).toEqual([]);
		});
	});

	// =========================================================================
	// hasCallback
	// =========================================================================

	describe('hasCallback()', () => {
		it('returns false for all callback names before any are set', () => {
			const callbackNames = [
				'getSessions',
				'getSessionDetail',
				'getTheme',
				'getCustomCommands',
				'writeToSession',
				'executeCommand',
				'interruptSession',
				'switchMode',
				'selectSession',
				'selectTab',
				'newTab',
				'closeTab',
				'renameTab',
				'getHistory',
			] as const;

			for (const name of callbackNames) {
				expect(registry.hasCallback(name)).toBe(false);
			}
		});

		it('returns true for getSessions after setting it', () => {
			registry.setGetSessionsCallback(() => []);
			expect(registry.hasCallback('getSessions')).toBe(true);
		});

		it('returns true for getSessionDetail after setting it', () => {
			registry.setGetSessionDetailCallback(() => null);
			expect(registry.hasCallback('getSessionDetail')).toBe(true);
		});

		it('returns true for getTheme after setting it', () => {
			registry.setGetThemeCallback(() => null);
			expect(registry.hasCallback('getTheme')).toBe(true);
		});

		it('returns true for getCustomCommands after setting it', () => {
			registry.setGetCustomCommandsCallback(() => []);
			expect(registry.hasCallback('getCustomCommands')).toBe(true);
		});

		it('returns true for writeToSession after setting it', () => {
			registry.setWriteToSessionCallback(() => false);
			expect(registry.hasCallback('writeToSession')).toBe(true);
		});

		it('returns true for executeCommand after setting it', () => {
			registry.setExecuteCommandCallback(async () => false);
			expect(registry.hasCallback('executeCommand')).toBe(true);
		});

		it('returns true for interruptSession after setting it', () => {
			registry.setInterruptSessionCallback(async () => false);
			expect(registry.hasCallback('interruptSession')).toBe(true);
		});

		it('returns true for switchMode after setting it', () => {
			registry.setSwitchModeCallback(async () => false);
			expect(registry.hasCallback('switchMode')).toBe(true);
		});

		it('returns true for selectSession after setting it', () => {
			registry.setSelectSessionCallback(async () => false);
			expect(registry.hasCallback('selectSession')).toBe(true);
		});

		it('returns true for selectTab after setting it', () => {
			registry.setSelectTabCallback(async () => false);
			expect(registry.hasCallback('selectTab')).toBe(true);
		});

		it('returns true for newTab after setting it', () => {
			registry.setNewTabCallback(async () => null);
			expect(registry.hasCallback('newTab')).toBe(true);
		});

		it('returns true for closeTab after setting it', () => {
			registry.setCloseTabCallback(async () => false);
			expect(registry.hasCallback('closeTab')).toBe(true);
		});

		it('returns true for renameTab after setting it', () => {
			registry.setRenameTabCallback(async () => false);
			expect(registry.hasCallback('renameTab')).toBe(true);
		});

		it('returns true for getHistory after setting it', () => {
			registry.setGetHistoryCallback(() => []);
			expect(registry.hasCallback('getHistory')).toBe(true);
		});

		it('does not affect other callbacks when one is set', () => {
			registry.setGetSessionsCallback(() => []);

			expect(registry.hasCallback('getSessions')).toBe(true);
			expect(registry.hasCallback('getSessionDetail')).toBe(false);
			expect(registry.hasCallback('executeCommand')).toBe(false);
			expect(registry.hasCallback('getHistory')).toBe(false);
		});
	});

	// =========================================================================
	// Setter/Getter pairs
	// =========================================================================

	describe('setGetSessionsCallback / getSessions()', () => {
		it('returns the callback result', () => {
			const sessions: SessionData[] = [
				{
					id: 'session-1',
					name: 'Test Session',
					toolType: 'claude-code',
					state: 'idle',
					inputMode: 'ai',
					cwd: '/home/user/project',
					groupId: null,
					groupName: null,
					groupEmoji: null,
				},
			];
			registry.setGetSessionsCallback(() => sessions);
			expect(registry.getSessions()).toEqual(sessions);
		});

		it('calls the callback each time', () => {
			const callback = vi.fn().mockReturnValue([]);
			registry.setGetSessionsCallback(callback);

			registry.getSessions();
			registry.getSessions();
			registry.getSessions();

			expect(callback).toHaveBeenCalledTimes(3);
		});
	});

	describe('setGetSessionDetailCallback / getSessionDetail()', () => {
		it('returns the callback result for a valid session', () => {
			const detail: SessionDetail = {
				id: 'session-1',
				name: 'Test Session',
				toolType: 'claude-code',
				state: 'idle',
				inputMode: 'ai',
				cwd: '/home/user/project',
				aiLogs: [{ timestamp: Date.now(), content: 'Hello', type: 'ai' }],
				shellLogs: [],
			};
			registry.setGetSessionDetailCallback(() => detail);
			expect(registry.getSessionDetail('session-1')).toEqual(detail);
		});

		it('returns null when callback returns null', () => {
			registry.setGetSessionDetailCallback(() => null);
			expect(registry.getSessionDetail('nonexistent')).toBeNull();
		});

		it('passes sessionId argument to the callback', () => {
			const callback = vi.fn().mockReturnValue(null);
			registry.setGetSessionDetailCallback(callback);

			registry.getSessionDetail('session-42');

			expect(callback).toHaveBeenCalledWith('session-42', undefined);
		});

		it('passes sessionId and tabId arguments to the callback', () => {
			const callback = vi.fn().mockReturnValue(null);
			registry.setGetSessionDetailCallback(callback);

			registry.getSessionDetail('session-42', 'tab-7');

			expect(callback).toHaveBeenCalledWith('session-42', 'tab-7');
		});
	});

	describe('setGetThemeCallback / getTheme()', () => {
		it('returns the callback result', () => {
			const theme = { name: 'dark', background: '#000' } as unknown as Theme;
			registry.setGetThemeCallback(() => theme);
			expect(registry.getTheme()).toEqual(theme);
		});

		it('returns null when callback returns null', () => {
			registry.setGetThemeCallback(() => null);
			expect(registry.getTheme()).toBeNull();
		});
	});

	describe('setGetCustomCommandsCallback / getCustomCommands()', () => {
		it('returns the callback result', () => {
			const commands: CustomAICommand[] = [
				{
					id: 'cmd-1',
					command: '/test',
					description: 'Run tests',
					prompt: 'Run the test suite',
				},
			];
			registry.setGetCustomCommandsCallback(() => commands);
			expect(registry.getCustomCommands()).toEqual(commands);
		});

		it('returns empty array when callback returns empty array', () => {
			registry.setGetCustomCommandsCallback(() => []);
			expect(registry.getCustomCommands()).toEqual([]);
		});
	});

	describe('setWriteToSessionCallback / writeToSession()', () => {
		it('returns true when callback succeeds', () => {
			registry.setWriteToSessionCallback(() => true);
			expect(registry.writeToSession('session-1', 'hello')).toBe(true);
		});

		it('returns false when callback returns false', () => {
			registry.setWriteToSessionCallback(() => false);
			expect(registry.writeToSession('session-1', 'hello')).toBe(false);
		});

		it('passes sessionId and data arguments to the callback', () => {
			const callback = vi.fn().mockReturnValue(true);
			registry.setWriteToSessionCallback(callback);

			registry.writeToSession('session-99', 'test-data');

			expect(callback).toHaveBeenCalledWith('session-99', 'test-data');
		});
	});

	describe('setExecuteCommandCallback / executeCommand()', () => {
		it('returns true when callback resolves to true', async () => {
			registry.setExecuteCommandCallback(async () => true);
			expect(await registry.executeCommand('session-1', 'ls')).toBe(true);
		});

		it('returns false when callback resolves to false', async () => {
			registry.setExecuteCommandCallback(async () => false);
			expect(await registry.executeCommand('session-1', 'ls')).toBe(false);
		});

		it('passes sessionId and command arguments to the callback', async () => {
			const callback = vi.fn().mockResolvedValue(true);
			registry.setExecuteCommandCallback(callback);

			await registry.executeCommand('session-5', 'npm test');

			expect(callback).toHaveBeenCalledWith(
				'session-5',
				'npm test',
				undefined,
				undefined,
				undefined,
				undefined
			);
		});

		it('passes inputMode argument to the callback', async () => {
			const callback = vi.fn().mockResolvedValue(true);
			registry.setExecuteCommandCallback(callback);

			await registry.executeCommand('session-5', 'npm test', 'terminal');

			expect(callback).toHaveBeenCalledWith(
				'session-5',
				'npm test',
				'terminal',
				undefined,
				undefined,
				undefined
			);
		});

		it('passes ai inputMode argument to the callback', async () => {
			const callback = vi.fn().mockResolvedValue(true);
			registry.setExecuteCommandCallback(callback);

			await registry.executeCommand('session-5', 'explain this code', 'ai');

			expect(callback).toHaveBeenCalledWith(
				'session-5',
				'explain this code',
				'ai',
				undefined,
				undefined,
				undefined
			);
		});

		it('passes tabId argument to the callback so callers (`dispatch --session`) can target a specific tab', async () => {
			const callback = vi.fn().mockResolvedValue(true);
			registry.setExecuteCommandCallback(callback);

			await registry.executeCommand('session-5', 'follow up', 'ai', 'tab-xyz');

			expect(callback).toHaveBeenCalledWith(
				'session-5',
				'follow up',
				'ai',
				'tab-xyz',
				undefined,
				undefined
			);
		});

		it('passes force argument to the callback so `dispatch --force` survives the WebSocket boundary', async () => {
			const callback = vi.fn().mockResolvedValue(true);
			registry.setExecuteCommandCallback(callback);

			await registry.executeCommand('session-5', 'concurrent write', 'ai', undefined, true);

			expect(callback).toHaveBeenCalledWith(
				'session-5',
				'concurrent write',
				'ai',
				undefined,
				true,
				undefined
			);
		});

		it('passes images argument so pasted attachments survive the boundary', async () => {
			const callback = vi.fn().mockResolvedValue(true);
			registry.setExecuteCommandCallback(callback);

			const images = ['data:image/png;base64,abc'];
			await registry.executeCommand(
				'session-5',
				'look at this',
				'ai',
				undefined,
				undefined,
				images
			);

			expect(callback).toHaveBeenCalledWith(
				'session-5',
				'look at this',
				'ai',
				undefined,
				undefined,
				images
			);
		});
	});

	describe('setInterruptSessionCallback / interruptSession()', () => {
		it('returns true when callback resolves to true', async () => {
			registry.setInterruptSessionCallback(async () => true);
			expect(await registry.interruptSession('session-1')).toBe(true);
		});

		it('returns false when callback resolves to false', async () => {
			registry.setInterruptSessionCallback(async () => false);
			expect(await registry.interruptSession('session-1')).toBe(false);
		});

		it('passes sessionId argument to the callback', async () => {
			const callback = vi.fn().mockResolvedValue(true);
			registry.setInterruptSessionCallback(callback);

			await registry.interruptSession('session-77');

			expect(callback).toHaveBeenCalledWith('session-77');
		});
	});

	describe('setSwitchModeCallback / switchMode()', () => {
		it('returns true when callback resolves to true', async () => {
			registry.setSwitchModeCallback(async () => true);
			expect(await registry.switchMode('session-1', 'terminal')).toBe(true);
		});

		it('returns false when callback resolves to false', async () => {
			registry.setSwitchModeCallback(async () => false);
			expect(await registry.switchMode('session-1', 'ai')).toBe(false);
		});

		it('passes sessionId and mode arguments to the callback', async () => {
			const callback = vi.fn().mockResolvedValue(true);
			registry.setSwitchModeCallback(callback);

			await registry.switchMode('session-3', 'terminal');

			expect(callback).toHaveBeenCalledWith('session-3', 'terminal');
		});

		it('passes ai mode correctly', async () => {
			const callback = vi.fn().mockResolvedValue(true);
			registry.setSwitchModeCallback(callback);

			await registry.switchMode('session-3', 'ai');

			expect(callback).toHaveBeenCalledWith('session-3', 'ai');
		});
	});

	describe('setSelectSessionCallback / selectSession()', () => {
		it('returns true when callback resolves to true', async () => {
			registry.setSelectSessionCallback(async () => true);
			expect(await registry.selectSession('session-1')).toBe(true);
		});

		it('returns false when callback resolves to false', async () => {
			registry.setSelectSessionCallback(async () => false);
			expect(await registry.selectSession('session-1')).toBe(false);
		});

		it('passes sessionId argument to the callback', async () => {
			const callback = vi.fn().mockResolvedValue(true);
			registry.setSelectSessionCallback(callback);

			await registry.selectSession('session-10');

			expect(callback).toHaveBeenCalledWith('session-10', undefined, undefined);
		});

		it('passes sessionId and tabId arguments to the callback', async () => {
			const callback = vi.fn().mockResolvedValue(true);
			registry.setSelectSessionCallback(callback);

			await registry.selectSession('session-10', 'tab-2');

			expect(callback).toHaveBeenCalledWith('session-10', 'tab-2', undefined);
		});
	});

	describe('setSelectTabCallback / selectTab()', () => {
		it('returns true when callback resolves to true', async () => {
			registry.setSelectTabCallback(async () => true);
			expect(await registry.selectTab('session-1', 'tab-1')).toBe(true);
		});

		it('returns false when callback resolves to false', async () => {
			registry.setSelectTabCallback(async () => false);
			expect(await registry.selectTab('session-1', 'tab-1')).toBe(false);
		});

		it('passes sessionId and tabId arguments to the callback', async () => {
			const callback = vi.fn().mockResolvedValue(true);
			registry.setSelectTabCallback(callback);

			await registry.selectTab('session-8', 'tab-4');

			expect(callback).toHaveBeenCalledWith('session-8', 'tab-4');
		});
	});

	describe('setNewTabCallback / newTab()', () => {
		it('returns tab info when callback resolves with data', async () => {
			registry.setNewTabCallback(async () => ({ tabId: 'new-tab-1' }));
			expect(await registry.newTab('session-1')).toEqual({ tabId: 'new-tab-1' });
		});

		it('returns null when callback resolves to null', async () => {
			registry.setNewTabCallback(async () => null);
			expect(await registry.newTab('session-1')).toBeNull();
		});

		it('passes sessionId argument to the callback', async () => {
			const callback = vi.fn().mockResolvedValue({ tabId: 'tab-new' });
			registry.setNewTabCallback(callback);

			await registry.newTab('session-15');

			expect(callback).toHaveBeenCalledWith('session-15');
		});
	});

	describe('setCloseTabCallback / closeTab()', () => {
		it('returns true when callback resolves to true', async () => {
			registry.setCloseTabCallback(async () => true);
			expect(await registry.closeTab('session-1', 'tab-1')).toBe(true);
		});

		it('returns false when callback resolves to false', async () => {
			registry.setCloseTabCallback(async () => false);
			expect(await registry.closeTab('session-1', 'tab-1')).toBe(false);
		});

		it('passes sessionId and tabId arguments to the callback', async () => {
			const callback = vi.fn().mockResolvedValue(true);
			registry.setCloseTabCallback(callback);

			await registry.closeTab('session-6', 'tab-3');

			expect(callback).toHaveBeenCalledWith('session-6', 'tab-3');
		});
	});

	describe('setRenameTabCallback / renameTab()', () => {
		it('returns true when callback resolves to true', async () => {
			registry.setRenameTabCallback(async () => true);
			expect(await registry.renameTab('session-1', 'tab-1', 'New Name')).toBe(true);
		});

		it('returns false when callback resolves to false', async () => {
			registry.setRenameTabCallback(async () => false);
			expect(await registry.renameTab('session-1', 'tab-1', 'New Name')).toBe(false);
		});

		it('passes sessionId, tabId, and newName arguments to the callback', async () => {
			const callback = vi.fn().mockResolvedValue(true);
			registry.setRenameTabCallback(callback);

			await registry.renameTab('session-2', 'tab-5', 'My Renamed Tab');

			expect(callback).toHaveBeenCalledWith('session-2', 'tab-5', 'My Renamed Tab');
		});
	});

	describe('setGetHistoryCallback / getHistory()', () => {
		it('returns the callback result', () => {
			const history = [
				{
					id: 'h1',
					title: 'Session 1',
					timestamp: Date.now(),
					projectPath: '/project',
				},
			] as unknown as HistoryEntry[];
			registry.setGetHistoryCallback(() => history);
			expect(registry.getHistory()).toEqual(history);
		});

		it('returns empty array when callback returns empty array', () => {
			registry.setGetHistoryCallback(() => []);
			expect(registry.getHistory()).toEqual([]);
		});

		it('passes no arguments when called without args', () => {
			const callback = vi.fn().mockReturnValue([]);
			registry.setGetHistoryCallback(callback);

			registry.getHistory();

			expect(callback).toHaveBeenCalledWith(undefined, undefined);
		});

		it('passes projectPath argument to the callback', () => {
			const callback = vi.fn().mockReturnValue([]);
			registry.setGetHistoryCallback(callback);

			registry.getHistory('/home/user/project');

			expect(callback).toHaveBeenCalledWith('/home/user/project', undefined);
		});

		it('passes projectPath and sessionId arguments to the callback', () => {
			const callback = vi.fn().mockReturnValue([]);
			registry.setGetHistoryCallback(callback);

			registry.getHistory('/home/user/project', 'session-20');

			expect(callback).toHaveBeenCalledWith('/home/user/project', 'session-20');
		});
	});

	// =========================================================================
	// Callback replacement
	// =========================================================================

	describe('callback replacement', () => {
		it('replaces a previously set callback with a new one', () => {
			const firstCallback = vi.fn().mockReturnValue([{ id: 'first' }]);
			const secondCallback = vi.fn().mockReturnValue([{ id: 'second' }]);

			registry.setGetSessionsCallback(firstCallback as any);
			expect(registry.getSessions()).toEqual([{ id: 'first' }]);

			registry.setGetSessionsCallback(secondCallback as any);
			expect(registry.getSessions()).toEqual([{ id: 'second' }]);

			// First callback should only have been called once
			expect(firstCallback).toHaveBeenCalledTimes(1);
		});

		it('replaces an async callback with a new one', async () => {
			const firstCallback = vi.fn().mockResolvedValue(true);
			const secondCallback = vi.fn().mockResolvedValue(false);

			registry.setExecuteCommandCallback(firstCallback);
			expect(await registry.executeCommand('s1', 'cmd1')).toBe(true);

			registry.setExecuteCommandCallback(secondCallback);
			expect(await registry.executeCommand('s1', 'cmd2')).toBe(false);

			expect(firstCallback).toHaveBeenCalledTimes(1);
			expect(secondCallback).toHaveBeenCalledTimes(1);
		});
	});

	// =========================================================================
	// Multiple callbacks coexist independently
	// =========================================================================

	describe('independent callback registration', () => {
		it('setting one callback does not affect others', () => {
			const sessionsCallback = vi.fn().mockReturnValue([]);
			registry.setGetSessionsCallback(sessionsCallback);

			// Other getters should still return defaults
			expect(registry.getSessionDetail('s1')).toBeNull();
			expect(registry.getTheme()).toBeNull();
			expect(registry.getCustomCommands()).toEqual([]);
			expect(registry.writeToSession('s1', 'data')).toBe(false);
			expect(registry.getHistory()).toEqual([]);

			// The set callback should work
			expect(registry.getSessions()).toEqual([]);
			expect(sessionsCallback).toHaveBeenCalledTimes(1);
		});

		it('triggerCueSubscription() returns false when no callback set', async () => {
			expect(await registry.triggerCueSubscription('my-sub')).toBe(false);
		});

		it('triggerCueSubscription() passes sourceAgentId through to callback', async () => {
			const callback = vi.fn().mockResolvedValue(true);
			registry.setTriggerCueSubscriptionCallback(callback);
			const result = await registry.triggerCueSubscription('my-sub', 'prompt', 'agent-xyz-123');
			expect(result).toBe(true);
			expect(callback).toHaveBeenCalledWith('my-sub', 'prompt', 'agent-xyz-123');
		});

		it('triggerCueSubscription() passes undefined sourceAgentId when not provided', async () => {
			const callback = vi.fn().mockResolvedValue(true);
			registry.setTriggerCueSubscriptionCallback(callback);
			await registry.triggerCueSubscription('my-sub');
			expect(callback).toHaveBeenCalledWith('my-sub', undefined, undefined);
		});

		it('multiple callbacks can be set and work independently', async () => {
			const sessionsCallback = vi.fn().mockReturnValue([{ id: 's1' }]);
			const themeCallback = vi.fn().mockReturnValue({ name: 'dark' });
			const executeCallback = vi.fn().mockResolvedValue(true);

			registry.setGetSessionsCallback(sessionsCallback as any);
			registry.setGetThemeCallback(themeCallback as any);
			registry.setExecuteCommandCallback(executeCallback);

			expect(registry.getSessions()).toEqual([{ id: 's1' }]);
			expect(registry.getTheme()).toEqual({ name: 'dark' });
			expect(await registry.executeCommand('s1', 'test')).toBe(true);

			expect(sessionsCallback).toHaveBeenCalledTimes(1);
			expect(themeCallback).toHaveBeenCalledTimes(1);
			expect(executeCallback).toHaveBeenCalledTimes(1);
		});
	});

	describe('comprehensive callback surface', () => {
		type CallbackSurfaceCase = {
			callbackName: string;
			setter: string;
			method: string;
			args: unknown[];
			defaultValue: unknown;
			result: unknown;
		};

		const callbackSurfaceCases: CallbackSurfaceCase[] = [
			{
				callbackName: 'getBionifyReadingMode',
				setter: 'setGetBionifyReadingModeCallback',
				method: 'getBionifyReadingMode',
				args: [],
				defaultValue: false,
				result: true,
			},
			{
				callbackName: 'starTab',
				setter: 'setStarTabCallback',
				method: 'starTab',
				args: ['session-1', 'tab-1', true],
				defaultValue: false,
				result: true,
			},
			{
				callbackName: 'reorderTab',
				setter: 'setReorderTabCallback',
				method: 'reorderTab',
				args: ['session-1', 0, 2],
				defaultValue: false,
				result: true,
			},
			{
				callbackName: 'toggleBookmark',
				setter: 'setToggleBookmarkCallback',
				method: 'toggleBookmark',
				args: ['session-1'],
				defaultValue: false,
				result: true,
			},
			{
				callbackName: 'openFileTab',
				setter: 'setOpenFileTabCallback',
				method: 'openFileTab',
				args: ['session-1', '/tmp/file.md', false],
				defaultValue: false,
				result: true,
			},
			{
				callbackName: 'refreshFileTree',
				setter: 'setRefreshFileTreeCallback',
				method: 'refreshFileTree',
				args: ['session-1'],
				defaultValue: false,
				result: true,
			},
			{
				callbackName: 'openBrowserTab',
				setter: 'setOpenBrowserTabCallback',
				method: 'openBrowserTab',
				args: ['session-1', 'https://example.com'],
				defaultValue: false,
				result: true,
			},
			{
				callbackName: 'openTerminalTab',
				setter: 'setOpenTerminalTabCallback',
				method: 'openTerminalTab',
				args: ['session-1', { cwd: '/tmp', shell: '/bin/zsh' }],
				defaultValue: false,
				result: true,
			},
			{
				callbackName: 'newAITabWithPrompt',
				setter: 'setNewAITabWithPromptCallback',
				method: 'newAITabWithPrompt',
				args: ['session-1', 'Summarize this'],
				defaultValue: { success: false },
				result: { success: true, tabId: 'tab-2' },
			},
			{
				callbackName: 'refreshAutoRunDocs',
				setter: 'setRefreshAutoRunDocsCallback',
				method: 'refreshAutoRunDocs',
				args: ['session-1'],
				defaultValue: false,
				result: true,
			},
			{
				callbackName: 'configureAutoRun',
				setter: 'setConfigureAutoRunCallback',
				method: 'configureAutoRun',
				args: ['session-1', { documents: [{ filename: 'plan.md' }] }],
				defaultValue: { success: false, error: 'Not configured' },
				result: { success: true, playbookId: 'playbook-1' },
			},
			{
				callbackName: 'setSessionAutoRunFolder',
				setter: 'setSessionAutoRunFolderCallback',
				method: 'setSessionAutoRunFolder',
				args: ['session-1', '/tmp/.maestro'],
				defaultValue: { success: false, error: 'Not configured' },
				result: { success: true },
			},
			{
				callbackName: 'getAutoRunDocs',
				setter: 'setGetAutoRunDocsCallback',
				method: 'getAutoRunDocs',
				args: ['session-1'],
				defaultValue: [],
				result: [{ filename: 'plan.md', content: '# Plan' }],
			},
			{
				callbackName: 'getAutoRunDocContent',
				setter: 'setGetAutoRunDocContentCallback',
				method: 'getAutoRunDocContent',
				args: ['session-1', 'plan.md'],
				defaultValue: '',
				result: '# Plan',
			},
			{
				callbackName: 'saveAutoRunDoc',
				setter: 'setSaveAutoRunDocCallback',
				method: 'saveAutoRunDoc',
				args: ['session-1', 'plan.md', '# Plan'],
				defaultValue: false,
				result: true,
			},
			{
				callbackName: 'stopAutoRun',
				setter: 'setStopAutoRunCallback',
				method: 'stopAutoRun',
				args: ['session-1'],
				defaultValue: false,
				result: true,
			},
			{
				callbackName: 'resetAutoRunDocTasks',
				setter: 'setResetAutoRunDocTasksCallback',
				method: 'resetAutoRunDocTasks',
				args: ['session-1', 'plan.md'],
				defaultValue: false,
				result: true,
			},
			{
				callbackName: 'resumeAutoRunError',
				setter: 'setResumeAutoRunErrorCallback',
				method: 'resumeAutoRunError',
				args: ['session-1'],
				defaultValue: false,
				result: true,
			},
			{
				callbackName: 'skipAutoRunDocument',
				setter: 'setSkipAutoRunDocumentCallback',
				method: 'skipAutoRunDocument',
				args: ['session-1'],
				defaultValue: false,
				result: true,
			},
			{
				callbackName: 'abortAutoRunError',
				setter: 'setAbortAutoRunErrorCallback',
				method: 'abortAutoRunError',
				args: ['session-1'],
				defaultValue: false,
				result: true,
			},
			{
				callbackName: 'listPlaybooks',
				setter: 'setListPlaybooksCallback',
				method: 'listPlaybooks',
				args: ['session-1'],
				defaultValue: [],
				result: [{ id: 'playbook-1', name: 'Playbook' }],
			},
			{
				callbackName: 'createPlaybook',
				setter: 'setCreatePlaybookCallback',
				method: 'createPlaybook',
				args: ['session-1', { name: 'Playbook', documents: [], loopEnabled: false, prompt: '' }],
				defaultValue: null,
				result: { id: 'playbook-1', name: 'Playbook' },
			},
			{
				callbackName: 'updatePlaybook',
				setter: 'setUpdatePlaybookCallback',
				method: 'updatePlaybook',
				args: ['session-1', 'playbook-1', { name: 'Updated' }],
				defaultValue: null,
				result: { id: 'playbook-1', name: 'Updated' },
			},
			{
				callbackName: 'deletePlaybook',
				setter: 'setDeletePlaybookCallback',
				method: 'deletePlaybook',
				args: ['session-1', 'playbook-1'],
				defaultValue: false,
				result: true,
			},
			{
				callbackName: 'getSettings',
				setter: 'setGetSettingsCallback',
				method: 'getSettings',
				args: [],
				defaultValue: {
					theme: 'dracula',
					fontSize: 14,
					enterToSendAI: false,
					defaultSaveToHistory: true,
					defaultShowThinking: 'off',
					autoScroll: true,
					notificationsEnabled: true,
					audioFeedbackEnabled: false,
					colorBlindMode: 'none',
					conductorProfile: '',
					maxOutputLines: null,
					shortcuts: {},
				},
				result: { theme: 'light', fontSize: 16 },
			},
			{
				callbackName: 'setSetting',
				setter: 'setSetSettingCallback',
				method: 'setSetting',
				args: ['theme', 'light'],
				defaultValue: false,
				result: true,
			},
			{
				callbackName: 'getGroups',
				setter: 'setGetGroupsCallback',
				method: 'getGroups',
				args: [],
				defaultValue: [],
				result: [{ id: 'group-1', name: 'Group' }],
			},
			{
				callbackName: 'createGroup',
				setter: 'setCreateGroupCallback',
				method: 'createGroup',
				args: ['Group', 'G'],
				defaultValue: null,
				result: { id: 'group-1' },
			},
			{
				callbackName: 'renameGroup',
				setter: 'setRenameGroupCallback',
				method: 'renameGroup',
				args: ['group-1', 'Renamed'],
				defaultValue: false,
				result: true,
			},
			{
				callbackName: 'deleteGroup',
				setter: 'setDeleteGroupCallback',
				method: 'deleteGroup',
				args: ['group-1'],
				defaultValue: false,
				result: true,
			},
			{
				callbackName: 'moveSessionToGroup',
				setter: 'setMoveSessionToGroupCallback',
				method: 'moveSessionToGroup',
				args: ['session-1', null],
				defaultValue: false,
				result: true,
			},
			{
				callbackName: 'createSession',
				setter: 'setCreateSessionCallback',
				method: 'createSession',
				args: ['Agent', 'codex', '/tmp/project', 'group-1', { modelId: 'gpt-5' }],
				defaultValue: null,
				result: { sessionId: 'session-2' },
			},
			{
				callbackName: 'createWorktreeSession',
				setter: 'setCreateWorktreeSessionCallback',
				method: 'createWorktreeSession',
				args: ['session-1', { branchName: 'feature' }],
				defaultValue: { success: false, error: 'Not configured' },
				result: { success: true, sessionId: 'session-2' },
			},
			{
				callbackName: 'deleteSession',
				setter: 'setDeleteSessionCallback',
				method: 'deleteSession',
				args: ['session-1'],
				defaultValue: false,
				result: true,
			},
			{
				callbackName: 'renameSession',
				setter: 'setRenameSessionCallback',
				method: 'renameSession',
				args: ['session-1', 'Renamed'],
				defaultValue: false,
				result: true,
			},
			{
				callbackName: 'updateSessionCwd',
				setter: 'setUpdateSessionCwdCallback',
				method: 'updateSessionCwd',
				args: ['session-1', '/tmp/next'],
				defaultValue: { success: false, error: 'Session cwd updates not configured' },
				result: { success: true },
			},
			{
				callbackName: 'updateSessionSsh',
				setter: 'setUpdateSessionSshCallback',
				method: 'updateSessionSsh',
				args: ['session-1', { enabled: true }],
				defaultValue: { success: false, error: 'Session SSH updates not configured' },
				result: { success: true },
			},
			{
				callbackName: 'getGitStatus',
				setter: 'setGetGitStatusCallback',
				method: 'getGitStatus',
				args: ['session-1'],
				defaultValue: { branch: '', files: [], ahead: 0, behind: 0 },
				result: { branch: 'main', files: [], ahead: 1, behind: 0 },
			},
			{
				callbackName: 'getGitDiff',
				setter: 'setGetGitDiffCallback',
				method: 'getGitDiff',
				args: ['session-1', 'src/App.tsx'],
				defaultValue: { diff: '', files: [] },
				result: { diff: 'diff --git', files: ['src/App.tsx'] },
			},
			{
				callbackName: 'getGitBranchesForSession',
				setter: 'setGetGitBranchesForSessionCallback',
				method: 'getGitBranchesForSession',
				args: ['session-1'],
				defaultValue: { branches: [] },
				result: { branches: [{ name: 'main', current: true }] },
			},
			{
				callbackName: 'listWorktreesForSession',
				setter: 'setListWorktreesForSessionCallback',
				method: 'listWorktreesForSession',
				args: ['session-1'],
				defaultValue: { worktrees: [] },
				result: { worktrees: [{ path: '/tmp/project', branch: 'main' }] },
			},
			{
				callbackName: 'getGroupChats',
				setter: 'setGetGroupChatsCallback',
				method: 'getGroupChats',
				args: [],
				defaultValue: [],
				result: [{ id: 'chat-1', status: 'running' }],
			},
			{
				callbackName: 'startGroupChat',
				setter: 'setStartGroupChatCallback',
				method: 'startGroupChat',
				args: ['Topic', ['session-1', 'session-2']],
				defaultValue: null,
				result: { chatId: 'chat-1' },
			},
			{
				callbackName: 'getGroupChatState',
				setter: 'setGetGroupChatStateCallback',
				method: 'getGroupChatState',
				args: ['chat-1'],
				defaultValue: null,
				result: { id: 'chat-1', status: 'running' },
			},
			{
				callbackName: 'stopGroupChat',
				setter: 'setStopGroupChatCallback',
				method: 'stopGroupChat',
				args: ['chat-1'],
				defaultValue: false,
				result: true,
			},
			{
				callbackName: 'sendGroupChatMessage',
				setter: 'setSendGroupChatMessageCallback',
				method: 'sendGroupChatMessage',
				args: ['chat-1', 'hello'],
				defaultValue: false,
				result: true,
			},
			{
				callbackName: 'mergeContext',
				setter: 'setMergeContextCallback',
				method: 'mergeContext',
				args: ['source-session', 'target-session'],
				defaultValue: false,
				result: true,
			},
			{
				callbackName: 'transferContext',
				setter: 'setTransferContextCallback',
				method: 'transferContext',
				args: ['source-session', 'target-session'],
				defaultValue: false,
				result: true,
			},
			{
				callbackName: 'summarizeContext',
				setter: 'setSummarizeContextCallback',
				method: 'summarizeContext',
				args: ['session-1'],
				defaultValue: false,
				result: true,
			},
			{
				callbackName: 'createGist',
				setter: 'setCreateGistCallback',
				method: 'createGist',
				args: ['session-1', 'Debug bundle', false],
				defaultValue: { success: false, error: 'Gist creation not configured' },
				result: { success: true, gistUrl: 'https://gist.github.com/1' },
			},
			{
				callbackName: 'getCueSubscriptions',
				setter: 'setGetCueSubscriptionsCallback',
				method: 'getCueSubscriptions',
				args: ['session-1'],
				defaultValue: [],
				result: [{ id: 'cue-1', name: 'Daily' }],
			},
			{
				callbackName: 'toggleCueSubscription',
				setter: 'setToggleCueSubscriptionCallback',
				method: 'toggleCueSubscription',
				args: ['cue-1', true],
				defaultValue: false,
				result: true,
			},
			{
				callbackName: 'getCueActivity',
				setter: 'setGetCueActivityCallback',
				method: 'getCueActivity',
				args: ['session-1', 5],
				defaultValue: [],
				result: [{ id: 'activity-1', status: 'success' }],
			},
			{
				callbackName: 'getUsageDashboard',
				setter: 'setGetUsageDashboardCallback',
				method: 'getUsageDashboard',
				args: ['week'],
				defaultValue: {
					totalTokensIn: 0,
					totalTokensOut: 0,
					totalCost: 0,
					sessionBreakdown: [],
					dailyUsage: [],
				},
				result: { totalTokensIn: 1, totalTokensOut: 2, totalCost: 0.01 },
			},
			{
				callbackName: 'getAchievements',
				setter: 'setGetAchievementsCallback',
				method: 'getAchievements',
				args: [],
				defaultValue: [],
				result: [{ id: 'achievement-1', title: 'First run' }],
			},
			{
				callbackName: 'generateDirectorNotesSynopsis',
				setter: 'setGenerateDirectorNotesSynopsisCallback',
				method: 'generateDirectorNotesSynopsis',
				args: [7, 'codex'],
				defaultValue: {
					success: false,
					synopsis: '',
					error: "Director's Notes synopsis not available",
				},
				result: { success: true, synopsis: 'Summary' },
			},
			{
				callbackName: 'notifyToast',
				setter: 'setNotifyToastCallback',
				method: 'notifyToast',
				args: [{ title: 'Title', message: 'Body', color: 'green' }],
				defaultValue: false,
				result: true,
			},
			{
				callbackName: 'notifyCenterFlash',
				setter: 'setNotifyCenterFlashCallback',
				method: 'notifyCenterFlash',
				args: [{ message: 'Saved', color: 'theme' }],
				defaultValue: false,
				result: true,
			},
			{
				callbackName: 'getMarketplaceManifest',
				setter: 'setGetMarketplaceManifestCallback',
				method: 'getMarketplaceManifest',
				args: [{ refresh: true }],
				defaultValue: null,
				result: { playbooks: [] },
			},
			{
				callbackName: 'getMarketplaceDocument',
				setter: 'setGetMarketplaceDocumentCallback',
				method: 'getMarketplaceDocument',
				args: ['playbook/path', 'README.md'],
				defaultValue: null,
				result: { content: '# Readme' },
			},
			{
				callbackName: 'getMarketplaceReadme',
				setter: 'setGetMarketplaceReadmeCallback',
				method: 'getMarketplaceReadme',
				args: ['playbook/path'],
				defaultValue: null,
				result: { content: '# Readme' },
			},
			{
				callbackName: 'importMarketplacePlaybook',
				setter: 'setImportMarketplacePlaybookCallback',
				method: 'importMarketplacePlaybook',
				args: ['session-1', 'playbook-1', 'Imported'],
				defaultValue: { success: false, error: 'Marketplace import not configured' },
				result: { success: true, playbookId: 'playbook-1' },
			},
			{
				callbackName: 'listDesktopSessions',
				setter: 'setListDesktopSessionsCallback',
				method: 'listDesktopSessions',
				args: [],
				defaultValue: [],
				result: [{ id: 'desktop-session-1', name: 'Desktop session' }],
			},
			{
				callbackName: 'getSessionHistory',
				setter: 'setGetSessionHistoryCallback',
				method: 'getSessionHistory',
				args: ['tab-1', { limit: 10 }],
				defaultValue: null,
				result: { entries: [] },
			},
		];

		it.each(callbackSurfaceCases)(
			'$method returns a default, registers, and forwards callback arguments',
			async ({ callbackName, setter, method, args, defaultValue, result }) => {
				expect(registry.hasCallback(callbackName as any)).toBe(false);
				await expect(Promise.resolve((registry as any)[method](...args))).resolves.toEqual(
					defaultValue
				);

				const callback = vi.fn(() => result);
				(registry as any)[setter](callback);

				expect(registry.hasCallback(callbackName as any)).toBe(true);
				await expect(Promise.resolve((registry as any)[method](...args))).resolves.toEqual(result);
				expect(callback).toHaveBeenCalledWith(...args);
			}
		);
	});
});
