/**
 * Tests for useInterruptHandler hook
 *
 * Tests:
 *   - No-op when no active session
 *   - AI mode interrupt: sends SIGINT, adds "Canceled by user" log, clears thinking/tool logs
 *   - Terminal mode interrupt: sends SIGINT without canceled log
 *   - Execution queue processing after interrupt
 *   - Force kill fallback when interrupt fails
 *   - Kill error handling (error log in AI/terminal mode)
 *   - Synopsis cancellation before interrupt
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// ============================================================================
// Mocks
// ============================================================================

let idCounter = 0;
vi.mock('../../../renderer/utils/ids', () => ({
	generateId: vi.fn(() => `mock-id-${++idCounter}`),
}));

vi.mock('../../../renderer/utils/tabHelpers', async () => {
	const actual = await vi.importActual('../../../renderer/utils/tabHelpers');
	return { ...actual };
});

// ============================================================================
// Imports (after mocks)
// ============================================================================

import { useInterruptHandler } from '../../../renderer/hooks/agent/useInterruptHandler';
import type { UseInterruptHandlerDeps } from '../../../renderer/hooks/agent/useInterruptHandler';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { Session, AITab } from '../../../renderer/types';

// ============================================================================
// Window mock
// ============================================================================

const mockMaestro = {
	process: {
		interrupt: vi.fn().mockResolvedValue(undefined),
		kill: vi.fn().mockResolvedValue(undefined),
	},
};

(window as any).maestro = mockMaestro;

// Mock confirm for force-kill dialog
const originalConfirm = window.confirm;

// ============================================================================
// Helpers
// ============================================================================

function createTab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'tab-1',
		agentSessionId: null,
		name: null,
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: Date.now(),
		state: 'idle',
		saveToHistory: false,
		showThinking: false,
		...overrides,
	} as AITab;
}

function createSession(overrides: Partial<Session> = {}): Session {
	const tab = createTab(overrides.aiTabs?.[0] ? overrides.aiTabs[0] : {});
	return {
		id: 'sess-1',
		name: 'Test Session',
		toolType: 'claude-code' as any,
		state: 'idle',
		cwd: '/test/project',
		fullPath: '/test/project',
		projectRoot: '/test/project',
		isGitRepo: false,
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 1234,
		terminalPid: 0,
		port: 3001,
		isLive: false,
		changedFiles: [],
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		fileTreeAutoRefreshInterval: 180,
		shellCwd: '/test/project',
		aiCommandHistory: [],
		shellCommandHistory: [],
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [tab],
		activeTabId: tab.id,
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [{ type: 'ai' as const, id: tab.id }],
		unifiedClosedTabHistory: [],
		autoRunFolderPath: '/test/project/Auto Run Docs',
		terminalTabs: [],
		activeTerminalTabId: null,
		...overrides,
		// Ensure aiTabs uses proper tab objects
		...(overrides.aiTabs ? { aiTabs: overrides.aiTabs } : {}),
	} as Session;
}

function createDeps(overrides: Partial<UseInterruptHandlerDeps> = {}): UseInterruptHandlerDeps {
	return {
		sessionsRef: { current: [] },
		cancelPendingSynopsis: vi.fn().mockResolvedValue(undefined),
		processQueuedItem: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(() => {
	idCounter = 0;
	vi.clearAllMocks();
	window.confirm = originalConfirm;

	useSessionStore.setState({
		sessions: [],
		groups: [],
		activeSessionId: '',
	});
});

afterEach(() => {
	cleanup();
	window.confirm = originalConfirm;
});

// ============================================================================
// Tests
// ============================================================================

describe('useInterruptHandler', () => {
	// ========================================================================
	// No-op when no active session
	// ========================================================================
	describe('no active session', () => {
		it('does nothing when no active session exists', async () => {
			const deps = createDeps();
			const { result } = renderHook(() => useInterruptHandler(deps));

			await act(async () => {
				await result.current.handleInterrupt();
			});

			expect(mockMaestro.process.interrupt).not.toHaveBeenCalled();
			expect(deps.cancelPendingSynopsis).not.toHaveBeenCalled();
		});
	});

	// ========================================================================
	// AI mode interrupt
	// ========================================================================
	describe('AI mode interrupt', () => {
		it('sends SIGINT to the correct AI process target', async () => {
			const tab = createTab({ id: 'tab-ai-1', state: 'busy' });
			const session = createSession({
				id: 'sess-ai',
				inputMode: 'ai',
				state: 'busy',
				aiTabs: [tab],
				activeTabId: 'tab-ai-1',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-ai',
			});

			const deps = createDeps({ sessionsRef: { current: [session] } });
			const { result } = renderHook(() => useInterruptHandler(deps));

			await act(async () => {
				await result.current.handleInterrupt();
			});

			expect(mockMaestro.process.interrupt).toHaveBeenCalledWith('sess-ai-ai-tab-ai-1');
		});

		it('cancels pending synopsis before interrupting', async () => {
			const session = createSession({
				id: 'sess-syn',
				inputMode: 'ai',
				state: 'busy',
				aiTabs: [createTab({ state: 'busy' })],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-syn',
			});

			const deps = createDeps({ sessionsRef: { current: [session] } });
			const { result } = renderHook(() => useInterruptHandler(deps));

			await act(async () => {
				await result.current.handleInterrupt();
			});

			expect(deps.cancelPendingSynopsis).toHaveBeenCalledWith('sess-syn');
			// cancelPendingSynopsis should be called before interrupt
			const synopsisCallOrder = (deps.cancelPendingSynopsis as any).mock.invocationCallOrder[0];
			const interruptCallOrder = mockMaestro.process.interrupt.mock.invocationCallOrder[0];
			expect(synopsisCallOrder).toBeLessThan(interruptCallOrder);
		});

		it('adds "Canceled by user" system log to active tab', async () => {
			const tab = createTab({
				id: 'tab-cancel',
				state: 'busy',
				logs: [{ id: 'log-1', timestamp: 1, source: 'user', text: 'Hello' }],
			});
			const session = createSession({
				id: 'sess-cancel',
				inputMode: 'ai',
				state: 'busy',
				aiTabs: [tab],
				activeTabId: 'tab-cancel',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-cancel',
			});

			const deps = createDeps({ sessionsRef: { current: [session] } });
			const { result } = renderHook(() => useInterruptHandler(deps));

			await act(async () => {
				await result.current.handleInterrupt();
			});

			const updatedSession = useSessionStore.getState().sessions[0];
			const updatedTab = updatedSession.aiTabs[0];
			const lastLog = updatedTab.logs[updatedTab.logs.length - 1];
			expect(lastLog.source).toBe('system');
			expect(lastLog.text).toBe('Canceled by user');
		});

		it('clears thinking and tool logs from interrupted tab', async () => {
			const tab = createTab({
				id: 'tab-thinking',
				state: 'busy',
				logs: [
					{ id: 'log-1', timestamp: 1, source: 'user', text: 'Hello' },
					{ id: 'log-2', timestamp: 2, source: 'thinking', text: 'Thinking...' },
					{ id: 'log-3', timestamp: 3, source: 'tool', text: 'Running tool' },
					{ id: 'log-4', timestamp: 4, source: 'ai', text: 'Response' },
				],
			});
			const session = createSession({
				id: 'sess-think',
				inputMode: 'ai',
				state: 'busy',
				aiTabs: [tab],
				activeTabId: 'tab-thinking',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-think',
			});

			const deps = createDeps({ sessionsRef: { current: [session] } });
			const { result } = renderHook(() => useInterruptHandler(deps));

			await act(async () => {
				await result.current.handleInterrupt();
			});

			const updatedTab = useSessionStore.getState().sessions[0].aiTabs[0];
			const sources = updatedTab.logs.map((l: any) => l.source);
			expect(sources).not.toContain('thinking');
			expect(sources).not.toContain('tool');
			expect(sources).toContain('user');
			expect(sources).toContain('ai');
			expect(sources).toContain('system'); // "Canceled by user"
		});

		it('sets session and tab state to idle', async () => {
			const tab = createTab({ id: 'tab-idle', state: 'busy' });
			const session = createSession({
				id: 'sess-idle',
				inputMode: 'ai',
				state: 'busy',
				busySource: 'ai',
				thinkingStartTime: Date.now(),
				aiTabs: [tab],
				activeTabId: 'tab-idle',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-idle',
			});

			const deps = createDeps({ sessionsRef: { current: [session] } });
			const { result } = renderHook(() => useInterruptHandler(deps));

			await act(async () => {
				await result.current.handleInterrupt();
			});

			const updated = useSessionStore.getState().sessions[0];
			expect(updated.state).toBe('idle');
			expect(updated.busySource).toBeUndefined();
			expect(updated.thinkingStartTime).toBeUndefined();
			expect(updated.aiTabs[0].state).toBe('idle');
		});

		it('does not affect other sessions', async () => {
			const tab = createTab({ id: 'tab-a', state: 'busy' });
			const activeSession = createSession({
				id: 'active',
				inputMode: 'ai',
				state: 'busy',
				aiTabs: [tab],
				activeTabId: 'tab-a',
			});
			const otherSession = createSession({
				id: 'other',
				state: 'busy',
				aiTabs: [createTab({ id: 'tab-b', state: 'busy' })],
				activeTabId: 'tab-b',
			});
			useSessionStore.setState({
				sessions: [activeSession, otherSession],
				activeSessionId: 'active',
			});

			const deps = createDeps({
				sessionsRef: { current: [activeSession, otherSession] },
			});
			const { result } = renderHook(() => useInterruptHandler(deps));

			await act(async () => {
				await result.current.handleInterrupt();
			});

			const sessions = useSessionStore.getState().sessions;
			expect(sessions[0].state).toBe('idle'); // active — interrupted
			expect(sessions[1].state).toBe('busy'); // other — unchanged
		});
	});

	// ========================================================================
	// Terminal mode interrupt
	// ========================================================================
	describe('terminal mode interrupt', () => {
		it('sends SIGINT to terminal process target', async () => {
			const session = createSession({
				id: 'sess-term',
				inputMode: 'terminal',
				state: 'busy',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-term',
			});

			const deps = createDeps({ sessionsRef: { current: [session] } });
			const { result } = renderHook(() => useInterruptHandler(deps));

			await act(async () => {
				await result.current.handleInterrupt();
			});

			expect(mockMaestro.process.interrupt).toHaveBeenCalledWith('sess-term-terminal');
		});

		it('does not add "Canceled by user" log for terminal mode', async () => {
			const tab = createTab({ id: 'tab-t', state: 'idle' });
			const session = createSession({
				id: 'sess-term-2',
				inputMode: 'terminal',
				state: 'busy',
				aiTabs: [tab],
				activeTabId: 'tab-t',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-term-2',
			});

			const deps = createDeps({ sessionsRef: { current: [session] } });
			const { result } = renderHook(() => useInterruptHandler(deps));

			await act(async () => {
				await result.current.handleInterrupt();
			});

			const updatedTab = useSessionStore.getState().sessions[0].aiTabs[0];
			const cancelLogs = updatedTab.logs.filter(
				(l: any) => l.source === 'system' && l.text === 'Canceled by user'
			);
			expect(cancelLogs).toHaveLength(0);
		});
	});

	// ========================================================================
	// Execution queue processing
	// ========================================================================
	describe('execution queue processing', () => {
		it('processes next queued item after interrupt', async () => {
			vi.useFakeTimers();
			const queuedItem = {
				id: 'q-1',
				type: 'message' as const,
				text: 'Queued message',
				tabId: 'tab-q',
			};
			const tab = createTab({ id: 'tab-q', state: 'busy' });
			const session = createSession({
				id: 'sess-queue',
				inputMode: 'ai',
				state: 'busy',
				aiTabs: [tab],
				activeTabId: 'tab-q',
				executionQueue: [queuedItem],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-queue',
			});

			const deps = createDeps({ sessionsRef: { current: [session] } });
			const { result } = renderHook(() => useInterruptHandler(deps));

			await act(async () => {
				await result.current.handleInterrupt();
			});

			act(() => {
				vi.advanceTimersByTime(10);
			});

			expect(deps.processQueuedItem).toHaveBeenCalledWith('sess-queue', queuedItem);
			vi.useRealTimers();
		});

		it('sets target tab to busy when processing queue', async () => {
			const queuedItem = {
				id: 'q-2',
				type: 'message' as const,
				text: 'Next task',
				tabId: 'tab-target',
			};
			const busyTab = createTab({ id: 'tab-busy', state: 'busy' });
			const targetTab = createTab({ id: 'tab-target', state: 'idle' });
			const session = createSession({
				id: 'sess-q2',
				inputMode: 'ai',
				state: 'busy',
				aiTabs: [busyTab, targetTab],
				activeTabId: 'tab-busy',
				executionQueue: [queuedItem],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-q2',
			});

			const deps = createDeps({ sessionsRef: { current: [session] } });
			const { result } = renderHook(() => useInterruptHandler(deps));

			await act(async () => {
				await result.current.handleInterrupt();
			});

			const updated = useSessionStore.getState().sessions[0];
			const updatedTargetTab = updated.aiTabs.find((t: any) => t.id === 'tab-target');
			const updatedBusyTab = updated.aiTabs.find((t: any) => t.id === 'tab-busy');
			expect(updatedTargetTab?.state).toBe('busy');
			expect(updatedBusyTab?.state).toBe('idle');
		});

		it('removes processed item from execution queue', async () => {
			const item1 = {
				id: 'q-a',
				type: 'message' as const,
				text: 'First',
				tabId: 'tab-q',
			};
			const item2 = {
				id: 'q-b',
				type: 'message' as const,
				text: 'Second',
				tabId: 'tab-q',
			};
			const tab = createTab({ id: 'tab-q', state: 'busy' });
			const session = createSession({
				id: 'sess-q3',
				inputMode: 'ai',
				state: 'busy',
				aiTabs: [tab],
				activeTabId: 'tab-q',
				executionQueue: [item1, item2],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-q3',
			});

			const deps = createDeps({ sessionsRef: { current: [session] } });
			const { result } = renderHook(() => useInterruptHandler(deps));

			await act(async () => {
				await result.current.handleInterrupt();
			});

			const updated = useSessionStore.getState().sessions[0];
			expect(updated.executionQueue).toHaveLength(1);
			expect(updated.executionQueue[0].id).toBe('q-b');
		});

		it('adds user log entry for message queue items', async () => {
			const queuedItem = {
				id: 'q-msg',
				type: 'message' as const,
				text: 'Queued user message',
				tabId: 'tab-msg',
			};
			const tab = createTab({ id: 'tab-msg', state: 'busy' });
			const session = createSession({
				id: 'sess-msg',
				inputMode: 'ai',
				state: 'busy',
				aiTabs: [tab],
				activeTabId: 'tab-msg',
				executionQueue: [queuedItem],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-msg',
			});

			const deps = createDeps({ sessionsRef: { current: [session] } });
			const { result } = renderHook(() => useInterruptHandler(deps));

			await act(async () => {
				await result.current.handleInterrupt();
			});

			const updatedTab = useSessionStore
				.getState()
				.sessions[0].aiTabs.find((t: any) => t.id === 'tab-msg');
			const userLogs = updatedTab?.logs.filter((l: any) => l.source === 'user');
			expect(userLogs).toHaveLength(1);
			expect(userLogs![0].text).toBe('Queued user message');
		});
	});

	// ========================================================================
	// Force kill fallback
	// ========================================================================
	describe('force kill fallback', () => {
		it('offers force kill when interrupt fails and user confirms', async () => {
			mockMaestro.process.interrupt.mockRejectedValueOnce(new Error('SIGINT failed'));
			window.confirm = vi.fn().mockReturnValue(true);

			const tab = createTab({ id: 'tab-kill', state: 'busy' });
			const session = createSession({
				id: 'sess-kill',
				inputMode: 'ai',
				state: 'busy',
				aiTabs: [tab],
				activeTabId: 'tab-kill',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-kill',
			});

			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			const deps = createDeps({ sessionsRef: { current: [session] } });
			const { result } = renderHook(() => useInterruptHandler(deps));

			await act(async () => {
				await result.current.handleInterrupt();
			});

			expect(window.confirm).toHaveBeenCalled();
			expect(mockMaestro.process.kill).toHaveBeenCalledWith('sess-kill-ai-tab-kill');
			consoleError.mockRestore();
		});

		it('does not kill when user declines force kill', async () => {
			mockMaestro.process.interrupt.mockRejectedValueOnce(new Error('SIGINT failed'));
			window.confirm = vi.fn().mockReturnValue(false);

			const tab = createTab({ id: 'tab-no-kill', state: 'busy' });
			const session = createSession({
				id: 'sess-no-kill',
				inputMode: 'ai',
				state: 'busy',
				aiTabs: [tab],
				activeTabId: 'tab-no-kill',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-no-kill',
			});

			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			const deps = createDeps({ sessionsRef: { current: [session] } });
			const { result } = renderHook(() => useInterruptHandler(deps));

			await act(async () => {
				await result.current.handleInterrupt();
			});

			expect(mockMaestro.process.kill).not.toHaveBeenCalled();
			consoleError.mockRestore();
		});

		it('adds "Process forcefully terminated" log after force kill', async () => {
			mockMaestro.process.interrupt.mockRejectedValueOnce(new Error('SIGINT failed'));
			window.confirm = vi.fn().mockReturnValue(true);

			const tab = createTab({ id: 'tab-fk', state: 'busy' });
			const session = createSession({
				id: 'sess-fk',
				inputMode: 'ai',
				state: 'busy',
				aiTabs: [tab],
				activeTabId: 'tab-fk',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-fk',
			});

			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			const deps = createDeps({ sessionsRef: { current: [session] } });
			const { result } = renderHook(() => useInterruptHandler(deps));

			await act(async () => {
				await result.current.handleInterrupt();
			});

			const updatedTab = useSessionStore.getState().sessions[0].aiTabs[0];
			const killLogs = updatedTab.logs.filter(
				(l: any) => l.text === 'Process forcefully terminated'
			);
			expect(killLogs).toHaveLength(1);
			consoleError.mockRestore();
		});

		it('adds kill log to shell logs in terminal mode', async () => {
			mockMaestro.process.interrupt.mockRejectedValueOnce(new Error('SIGINT failed'));
			window.confirm = vi.fn().mockReturnValue(true);

			const session = createSession({
				id: 'sess-fk-term',
				inputMode: 'terminal',
				state: 'busy',
				shellLogs: [{ id: 'sl-1', timestamp: 1, source: 'system', text: 'Ready.' }],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-fk-term',
			});

			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			const deps = createDeps({ sessionsRef: { current: [session] } });
			const { result } = renderHook(() => useInterruptHandler(deps));

			await act(async () => {
				await result.current.handleInterrupt();
			});

			const updated = useSessionStore.getState().sessions[0];
			const killLogs = updated.shellLogs.filter(
				(l: any) => l.text === 'Process forcefully terminated'
			);
			expect(killLogs).toHaveLength(1);
			consoleError.mockRestore();
		});
	});

	// ========================================================================
	// Kill error handling
	// ========================================================================
	describe('kill error handling', () => {
		it('adds error log when kill also fails in AI mode', async () => {
			mockMaestro.process.interrupt.mockRejectedValueOnce(new Error('SIGINT failed'));
			mockMaestro.process.kill.mockRejectedValueOnce(new Error('Kill also failed'));
			window.confirm = vi.fn().mockReturnValue(true);

			const tab = createTab({ id: 'tab-err', state: 'busy' });
			const session = createSession({
				id: 'sess-err',
				inputMode: 'ai',
				state: 'busy',
				aiTabs: [tab],
				activeTabId: 'tab-err',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-err',
			});

			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			const deps = createDeps({ sessionsRef: { current: [session] } });
			const { result } = renderHook(() => useInterruptHandler(deps));

			await act(async () => {
				await result.current.handleInterrupt();
			});

			const updatedTab = useSessionStore.getState().sessions[0].aiTabs[0];
			const errorLogs = updatedTab.logs.filter(
				(l: any) => l.source === 'system' && l.text.includes('Failed to terminate')
			);
			expect(errorLogs).toHaveLength(1);
			expect(errorLogs[0].text).toContain('Kill also failed');

			// Session should still be set to idle
			expect(useSessionStore.getState().sessions[0].state).toBe('idle');
			consoleError.mockRestore();
		});

		it('adds error log to shell logs when kill fails in terminal mode', async () => {
			mockMaestro.process.interrupt.mockRejectedValueOnce(new Error('SIGINT failed'));
			mockMaestro.process.kill.mockRejectedValueOnce(new Error('Kill failed too'));
			window.confirm = vi.fn().mockReturnValue(true);

			const session = createSession({
				id: 'sess-err-term',
				inputMode: 'terminal',
				state: 'busy',
				shellLogs: [],
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-err-term',
			});

			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			const deps = createDeps({ sessionsRef: { current: [session] } });
			const { result } = renderHook(() => useInterruptHandler(deps));

			await act(async () => {
				await result.current.handleInterrupt();
			});

			const updated = useSessionStore.getState().sessions[0];
			const errorLogs = updated.shellLogs.filter((l: any) =>
				l.text.includes('Failed to terminate')
			);
			expect(errorLogs).toHaveLength(1);
			expect(updated.state).toBe('idle');
			consoleError.mockRestore();
		});

		it('clears thinking/tool logs even when kill fails', async () => {
			mockMaestro.process.interrupt.mockRejectedValueOnce(new Error('fail'));
			mockMaestro.process.kill.mockRejectedValueOnce(new Error('fail'));
			window.confirm = vi.fn().mockReturnValue(true);

			const tab = createTab({
				id: 'tab-clean',
				state: 'busy',
				logs: [
					{ id: 'l1', timestamp: 1, source: 'user', text: 'msg' },
					{ id: 'l2', timestamp: 2, source: 'thinking', text: 'hmm' },
					{ id: 'l3', timestamp: 3, source: 'tool', text: 'running' },
				],
			});
			const session = createSession({
				id: 'sess-clean',
				inputMode: 'ai',
				state: 'busy',
				aiTabs: [tab],
				activeTabId: 'tab-clean',
			});
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'sess-clean',
			});

			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			const deps = createDeps({ sessionsRef: { current: [session] } });
			const { result } = renderHook(() => useInterruptHandler(deps));

			await act(async () => {
				await result.current.handleInterrupt();
			});

			const updatedTab = useSessionStore.getState().sessions[0].aiTabs[0];
			const sources = updatedTab.logs.map((l: any) => l.source);
			expect(sources).not.toContain('thinking');
			expect(sources).not.toContain('tool');
			consoleError.mockRestore();
		});
	});

	// ========================================================================
	// Return type
	// ========================================================================
	describe('return type', () => {
		it('returns handleInterrupt function', () => {
			const deps = createDeps();
			const { result } = renderHook(() => useInterruptHandler(deps));

			expect(typeof result.current.handleInterrupt).toBe('function');
		});
	});
});
