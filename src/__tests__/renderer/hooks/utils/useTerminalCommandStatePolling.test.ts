/**
 * Tests for useTerminalCommandStatePolling hook + applyTerminalCommandSnapshot.
 *
 * Covers:
 *   - polling interval (timer-driven discovery + per-session query)
 *   - sessionId parsing (`-terminal` vs `-terminal-${tabId}` vs non-terminal)
 *   - shellCwd dispatch (update + reference-equality on no-op)
 *   - terminalTabs[] dispatch via updateTerminalTabCommand (reference-equality preserved)
 *   - non-terminal sessions filtered out
 *   - in-flight guard (overlapping ticks coalesced)
 *   - cleanup on unmount stops the timer
 *   - error swallowing for getActiveProcesses + getTerminalCommandState
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
	useTerminalCommandStatePolling,
	applyTerminalCommandSnapshot,
	DEFAULT_TERMINAL_POLL_INTERVAL_MS,
} from '../../../../renderer/hooks/utils/useTerminalCommandStatePolling';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import type { Session, AITab, TerminalTab } from '../../../../renderer/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeAITab = (overrides: Partial<AITab> = {}): AITab => ({
	id: overrides.id ?? 'ai-tab-1',
	agentSessionId: null,
	name: null,
	starred: false,
	logs: [],
	inputValue: '',
	stagedImages: [],
	createdAt: 1700000000000,
	state: 'idle' as const,
	...overrides,
});

const makeTerminalTab = (overrides: Partial<TerminalTab> = {}): TerminalTab => ({
	id: overrides.id ?? 'term-tab-1',
	currentCommand: overrides.currentCommand,
	commandRunning: overrides.commandRunning,
	persistCommand: overrides.persistCommand,
});

const makeSession = (overrides: Partial<Session> = {}): Session => {
	const base = makeAITab({ id: 'default-ai-tab' });
	return {
		id: overrides.id ?? 'sess-1',
		name: 'Test Session',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/test',
		fullPath: '/test',
		projectRoot: '/test',
		aiLogs: [],
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
		aiTabs: [base],
		activeTabId: base.id,
		closedTabHistory: [],
		...overrides,
	} as Session;
};

// ---------------------------------------------------------------------------
// window.maestro mock
// ---------------------------------------------------------------------------

const mockGetActiveProcesses = vi.fn();
const mockGetTerminalCommandState = vi.fn();
const mockLog = vi.fn();

beforeEach(() => {
	vi.useFakeTimers();
	mockGetActiveProcesses.mockReset().mockResolvedValue([]);
	mockGetTerminalCommandState.mockReset().mockResolvedValue(null);
	mockLog.mockReset();

	(window as any).maestro = {
		...((window as any).maestro || {}),
		process: {
			getActiveProcesses: mockGetActiveProcesses,
			getTerminalCommandState: mockGetTerminalCommandState,
		},
		logger: {
			log: mockLog,
		},
	};

	// Reset session store
	useSessionStore.setState({
		sessions: [],
		groups: [],
		activeSessionId: '',
		initialLoadComplete: false,
		removedWorktreePaths: new Set(),
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/**
 * Advance fake timers by `ms`, then flush pending microtasks so any
 * promise chains kicked off in `setInterval` callbacks settle before the
 * next assertion.
 */
async function tickPoll(ms: number = DEFAULT_TERMINAL_POLL_INTERVAL_MS): Promise<void> {
	await act(async () => {
		vi.advanceTimersByTime(ms);
		// Flush both pending micro-tasks (Promise.resolve queued by setInterval cb)
		// and any outstanding awaits inside the tick.
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	});
}

// ---------------------------------------------------------------------------
// applyTerminalCommandSnapshot — pure dispatch logic
// ---------------------------------------------------------------------------

describe('applyTerminalCommandSnapshot', () => {
	it('updates Session.shellCwd when currentCwd differs', () => {
		const session = makeSession({ id: 'sess-1', shellCwd: '/old' });
		useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

		applyTerminalCommandSnapshot('sess-1-terminal', {
			currentCommand: undefined,
			commandRunning: false,
			currentCwd: '/new',
		});

		const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
		expect(updated?.shellCwd).toBe('/new');
	});

	it('preserves reference equality when shellCwd already matches', () => {
		const session = makeSession({ id: 'sess-1', shellCwd: '/same' });
		useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

		const before = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
		applyTerminalCommandSnapshot('sess-1-terminal', {
			currentCommand: undefined,
			commandRunning: false,
			currentCwd: '/same',
		});
		const after = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');

		expect(after).toBe(before);
	});

	it('does not touch shellCwd when currentCwd is undefined', () => {
		const session = makeSession({ id: 'sess-1', shellCwd: '/keep' });
		useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

		applyTerminalCommandSnapshot('sess-1-terminal', {
			currentCommand: 'btop',
			commandRunning: true,
			currentCwd: undefined,
		});

		const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
		expect(updated?.shellCwd).toBe('/keep');
	});

	it('updates per-tab command state for `-terminal-${tabId}` session IDs', () => {
		const tab = makeTerminalTab({ id: 'tab-7', currentCommand: undefined, commandRunning: false });
		const session = makeSession({ id: 'sess-1', terminalTabs: [tab] });
		useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

		applyTerminalCommandSnapshot('sess-1-terminal-tab-7', {
			currentCommand: 'npm run dev',
			commandRunning: true,
			currentCwd: undefined,
		});

		const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
		const updatedTab = updated?.terminalTabs?.find((t) => t.id === 'tab-7');
		expect(updatedTab?.currentCommand).toBe('npm run dev');
		expect(updatedTab?.commandRunning).toBe(true);
	});

	it('preserves reference equality on per-tab no-op (same command + state)', () => {
		const tab = makeTerminalTab({ id: 'tab-7', currentCommand: 'btop', commandRunning: true });
		const session = makeSession({ id: 'sess-1', terminalTabs: [tab] });
		useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

		const before = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
		applyTerminalCommandSnapshot('sess-1-terminal-tab-7', {
			currentCommand: 'btop',
			commandRunning: true,
			currentCwd: undefined,
		});
		const after = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');

		expect(after).toBe(before);
	});

	it('skips per-tab dispatch when sessionId has no `-${tabId}` suffix', () => {
		const tab = makeTerminalTab({ id: 'tab-7', currentCommand: undefined, commandRunning: false });
		const session = makeSession({ id: 'sess-1', terminalTabs: [tab] });
		useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

		// Single-PTY session ID format — applies to "the terminal" but no tab is
		// targeted. terminalTabs[*] should be untouched.
		applyTerminalCommandSnapshot('sess-1-terminal', {
			currentCommand: 'btop',
			commandRunning: true,
			currentCwd: '/tmp',
		});

		const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
		expect(updated?.shellCwd).toBe('/tmp');
		// terminalTabs[*] are untouched — shellCwd is the only update for the
		// non-tabbed session ID format.
		expect(updated?.terminalTabs?.[0].currentCommand).toBeUndefined();
		expect(updated?.terminalTabs?.[0].commandRunning).toBe(false);
	});

	it('ignores non-terminal session IDs', () => {
		const session = makeSession({ id: 'sess-1', shellCwd: '/keep' });
		useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

		const before = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
		applyTerminalCommandSnapshot('sess-1-ai-tab-1', {
			currentCommand: 'foo',
			commandRunning: true,
			currentCwd: '/changed',
		});
		const after = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');

		// Non-terminal IDs return early before any setSessions call — same
		// reference + shellCwd unchanged.
		expect(after).toBe(before);
		expect(after?.shellCwd).toBe('/keep');
	});

	it('ignores session IDs that match no session', () => {
		const session = makeSession({ id: 'sess-1' });
		useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

		expect(() =>
			applyTerminalCommandSnapshot('unknown-session-terminal', {
				currentCommand: 'foo',
				commandRunning: true,
				currentCwd: '/x',
			})
		).not.toThrow();

		const sessions = useSessionStore.getState().sessions;
		expect(sessions).toHaveLength(1);
		expect(sessions[0].id).toBe('sess-1');
	});
});

// ---------------------------------------------------------------------------
// useTerminalCommandStatePolling — interval + IPC orchestration
// ---------------------------------------------------------------------------

describe('useTerminalCommandStatePolling', () => {
	it('does not call IPC immediately on mount (only on the first interval tick)', () => {
		renderHook(() => useTerminalCommandStatePolling());
		expect(mockGetActiveProcesses).not.toHaveBeenCalled();
	});

	it('calls getActiveProcesses on each tick', async () => {
		renderHook(() => useTerminalCommandStatePolling());

		await tickPoll();
		expect(mockGetActiveProcesses).toHaveBeenCalledTimes(1);

		await tickPoll();
		expect(mockGetActiveProcesses).toHaveBeenCalledTimes(2);
	});

	it('queries getTerminalCommandState only for terminal sessions', async () => {
		mockGetActiveProcesses.mockResolvedValue([
			{ sessionId: 'sess-1-terminal', isTerminal: true },
			{ sessionId: 'sess-2-ai-tab-1', isTerminal: false },
			{ sessionId: 'sess-3-terminal', isTerminal: true },
		]);

		renderHook(() => useTerminalCommandStatePolling());
		await tickPoll();

		expect(mockGetTerminalCommandState).toHaveBeenCalledTimes(2);
		expect(mockGetTerminalCommandState).toHaveBeenCalledWith('sess-1-terminal');
		expect(mockGetTerminalCommandState).toHaveBeenCalledWith('sess-3-terminal');
		expect(mockGetTerminalCommandState).not.toHaveBeenCalledWith('sess-2-ai-tab-1');
	});

	it('dispatches snapshot updates to the matching session', async () => {
		const session = makeSession({ id: 'sess-1', shellCwd: '/old' });
		useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

		mockGetActiveProcesses.mockResolvedValue([{ sessionId: 'sess-1-terminal', isTerminal: true }]);
		mockGetTerminalCommandState.mockResolvedValue({
			currentCommand: 'btop',
			commandRunning: true,
			currentCwd: '/new',
		});

		renderHook(() => useTerminalCommandStatePolling());
		await tickPoll();

		const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
		expect(updated?.shellCwd).toBe('/new');
	});

	it('skips dispatch when getTerminalCommandState returns null', async () => {
		const session = makeSession({ id: 'sess-1', shellCwd: '/old' });
		useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

		mockGetActiveProcesses.mockResolvedValue([{ sessionId: 'sess-1-terminal', isTerminal: true }]);
		mockGetTerminalCommandState.mockResolvedValue(null);

		renderHook(() => useTerminalCommandStatePolling());
		await tickPoll();

		const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
		expect(updated?.shellCwd).toBe('/old');
	});

	it('coalesces overlapping ticks via in-flight guard', async () => {
		// First call hangs; second tick fires before resolution → must skip.
		let resolveFirst: ((v: unknown) => void) | undefined;
		const firstHang = new Promise((resolve) => {
			resolveFirst = resolve;
		});
		mockGetActiveProcesses.mockReturnValueOnce(firstHang).mockResolvedValue([]);

		renderHook(() => useTerminalCommandStatePolling());

		// Tick 1 — fires getActiveProcesses but doesn't resolve.
		vi.advanceTimersByTime(DEFAULT_TERMINAL_POLL_INTERVAL_MS);
		await Promise.resolve();
		expect(mockGetActiveProcesses).toHaveBeenCalledTimes(1);

		// Tick 2 — should skip because tick 1 is still in flight.
		vi.advanceTimersByTime(DEFAULT_TERMINAL_POLL_INTERVAL_MS);
		await Promise.resolve();
		expect(mockGetActiveProcesses).toHaveBeenCalledTimes(1);

		// Resolve tick 1, then advance — tick 3 should run.
		await act(async () => {
			resolveFirst?.([]);
			await Promise.resolve();
			await Promise.resolve();
		});
		await tickPoll();
		expect(mockGetActiveProcesses).toHaveBeenCalledTimes(2);
	});

	it('clears the interval on unmount', async () => {
		const { unmount } = renderHook(() => useTerminalCommandStatePolling());

		await tickPoll();
		expect(mockGetActiveProcesses).toHaveBeenCalledTimes(1);

		unmount();

		await tickPoll();
		// No further calls after unmount.
		expect(mockGetActiveProcesses).toHaveBeenCalledTimes(1);
	});

	it('swallows getActiveProcesses errors and logs them', async () => {
		mockGetActiveProcesses.mockRejectedValue(new Error('boom'));

		renderHook(() => useTerminalCommandStatePolling());
		await tickPoll();

		expect(mockLog).toHaveBeenCalledWith(
			'debug',
			expect.stringContaining('terminal command-state poll failed'),
			'useTerminalCommandStatePolling'
		);

		// Subsequent ticks still run.
		mockGetActiveProcesses.mockResolvedValue([]);
		await tickPoll();
		expect(mockGetActiveProcesses).toHaveBeenCalledTimes(2);
	});

	it('swallows per-session getTerminalCommandState errors without affecting siblings', async () => {
		const session = makeSession({ id: 'sess-2', shellCwd: '/old' });
		useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-2' });

		mockGetActiveProcesses.mockResolvedValue([
			{ sessionId: 'sess-1-terminal', isTerminal: true },
			{ sessionId: 'sess-2-terminal', isTerminal: true },
		]);
		mockGetTerminalCommandState.mockImplementation((sid: string) => {
			if (sid === 'sess-1-terminal') return Promise.reject(new Error('ps failed'));
			return Promise.resolve({
				currentCommand: 'top',
				commandRunning: true,
				currentCwd: '/new',
			});
		});

		renderHook(() => useTerminalCommandStatePolling());
		await tickPoll();

		// sess-1 errored → no dispatch but logged. sess-2 still updated.
		expect(mockLog).toHaveBeenCalledWith(
			'debug',
			expect.stringContaining('getTerminalCommandState failed for sess-1-terminal'),
			'useTerminalCommandStatePolling'
		);
		const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-2');
		expect(updated?.shellCwd).toBe('/new');
	});

	it('respects a custom intervalMs', async () => {
		renderHook(() => useTerminalCommandStatePolling(1000));

		await tickPoll(1000);
		expect(mockGetActiveProcesses).toHaveBeenCalledTimes(1);

		// Advancing by less than the custom interval should not fire.
		await tickPoll(500);
		expect(mockGetActiveProcesses).toHaveBeenCalledTimes(1);

		await tickPoll(500);
		expect(mockGetActiveProcesses).toHaveBeenCalledTimes(2);
	});

	it('handles getActiveProcesses returning undefined gracefully', async () => {
		mockGetActiveProcesses.mockResolvedValue(undefined as any);

		renderHook(() => useTerminalCommandStatePolling());

		await tickPoll();
		// Should not throw, should not query getTerminalCommandState.
		expect(mockGetTerminalCommandState).not.toHaveBeenCalled();
	});
});
