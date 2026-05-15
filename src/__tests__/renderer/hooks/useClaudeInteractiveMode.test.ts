/**
 * Tests for useClaudeInteractiveMode hook
 *
 * Verifies:
 *  - cycleFromInteractive maps every persisted shape to the right UI position,
 *    including the `'limit'` → `'auto'` collapse.
 *  - nextClaudeModeCycle wraps in canonical order.
 *  - The hook is tolerant of undefined sessionIds and non-Claude tabs.
 *  - setMode persists via window.maestro.agents.setClaudeInteractiveMode,
 *    kills every AI tab's process, and preserves the prior mode when cycling
 *    back to `auto`.
 *  - No-op when current and target positions match.
 *  - IPC failure doesn't break subsequent calls.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
	useClaudeInteractiveMode,
	cycleFromInteractive,
	nextClaudeModeCycle,
	CLAUDE_MODE_CYCLE_ORDER,
} from '../../../renderer/hooks/agent/useClaudeInteractiveMode';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { Session } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';

// IPC + process API surface used by the hook.
const setClaudeInteractiveModeMock = vi.fn();
const killMock = vi.fn();

beforeEach(() => {
	setClaudeInteractiveModeMock.mockReset().mockResolvedValue(true);
	killMock.mockReset().mockResolvedValue(true);

	(global as any).window = (global as any).window ?? {};
	(window as any).maestro = {
		agents: { setClaudeInteractiveMode: setClaudeInteractiveModeMock },
		process: { kill: killMock },
		logger: { log: vi.fn() },
	};

	useSessionStore.setState({
		sessions: [],
		activeSessionId: '',
	} as any);
});

const buildSession = (overrides: Partial<Session> = {}): Session =>
	createMockSession({
		id: 'sess-1',
		toolType: 'claude-code',
		aiTabs: [
			{
				id: 'tab-1',
				agentSessionId: null,
				name: null,
				starred: false,
				logs: [],
				inputValue: '',
				stagedImages: [],
				createdAt: 1700000000000,
				state: 'idle',
				saveToHistory: true,
			},
		] as any,
		activeTabId: 'tab-1',
		...overrides,
	});

describe('cycleFromInteractive', () => {
	it('returns "auto" when the block is absent', () => {
		expect(cycleFromInteractive(undefined)).toBe('auto');
	});

	it('returns "auto" when modeReason is "auto"', () => {
		expect(cycleFromInteractive({ mode: 'interactive', modeReason: 'auto' })).toBe('auto');
		expect(cycleFromInteractive({ mode: 'api', modeReason: 'auto' })).toBe('auto');
	});

	it('collapses "limit" to "auto" (selector-driven, not a manual pin)', () => {
		expect(cycleFromInteractive({ mode: 'api', modeReason: 'limit' })).toBe('auto');
	});

	it('returns "force-interactive" when user-pinned to interactive', () => {
		expect(cycleFromInteractive({ mode: 'interactive', modeReason: 'user' })).toBe(
			'force-interactive'
		);
	});

	it('returns "force-api" when user-pinned to api', () => {
		expect(cycleFromInteractive({ mode: 'api', modeReason: 'user' })).toBe('force-api');
	});
});

describe('nextClaudeModeCycle', () => {
	it('advances in canonical order and wraps', () => {
		expect(nextClaudeModeCycle('auto')).toBe('force-interactive');
		expect(nextClaudeModeCycle('force-interactive')).toBe('force-api');
		expect(nextClaudeModeCycle('force-api')).toBe('auto');
	});

	it('exposes the canonical order constant', () => {
		expect(CLAUDE_MODE_CYCLE_ORDER).toEqual(['auto', 'force-interactive', 'force-api']);
	});
});

describe('useClaudeInteractiveMode', () => {
	it('returns auto and isClaudeCode=false when sessionId is undefined', () => {
		const { result } = renderHook(() => useClaudeInteractiveMode(undefined));
		expect(result.current.mode).toBe('auto');
		expect(result.current.isClaudeCode).toBe(false);
	});

	it('returns auto and isClaudeCode=false for non-Claude tabs', () => {
		useSessionStore.setState({
			sessions: [buildSession({ id: 'sess-1', toolType: 'codex' })],
			activeSessionId: 'sess-1',
		} as any);

		const { result } = renderHook(() => useClaudeInteractiveMode('sess-1'));
		expect(result.current.mode).toBe('auto');
		expect(result.current.isClaudeCode).toBe(false);
	});

	it('setMode is a no-op on non-Claude tabs (does not fire IPC)', async () => {
		useSessionStore.setState({
			sessions: [buildSession({ id: 'sess-1', toolType: 'codex' })],
			activeSessionId: 'sess-1',
		} as any);

		const { result } = renderHook(() => useClaudeInteractiveMode('sess-1'));
		await act(async () => {
			await result.current.setMode('force-interactive');
		});

		expect(setClaudeInteractiveModeMock).not.toHaveBeenCalled();
		expect(killMock).not.toHaveBeenCalled();
	});

	it('reads the persisted cycle position for Claude tabs', () => {
		useSessionStore.setState({
			sessions: [
				buildSession({
					claudeInteractive: { mode: 'interactive', modeReason: 'user' },
				}),
			],
			activeSessionId: 'sess-1',
		} as any);

		const { result } = renderHook(() => useClaudeInteractiveMode('sess-1'));
		expect(result.current.mode).toBe('force-interactive');
		expect(result.current.isClaudeCode).toBe(true);
	});

	it('setMode persists the new state via IPC', async () => {
		useSessionStore.setState({
			sessions: [buildSession({ claudeInteractive: { mode: 'api', modeReason: 'auto' } })],
			activeSessionId: 'sess-1',
		} as any);

		const { result } = renderHook(() => useClaudeInteractiveMode('sess-1'));
		await act(async () => {
			await result.current.setMode('force-interactive');
		});

		expect(setClaudeInteractiveModeMock).toHaveBeenCalledWith('sess-1', 'interactive', 'user');
	});

	it('setMode kills every AI tab process on the session', async () => {
		useSessionStore.setState({
			sessions: [
				buildSession({
					aiTabs: [
						{
							id: 'tab-1',
							agentSessionId: null,
							name: null,
							starred: false,
							logs: [],
							inputValue: '',
							stagedImages: [],
							createdAt: 1700000000000,
							state: 'idle',
							saveToHistory: true,
						},
						{
							id: 'tab-2',
							agentSessionId: null,
							name: null,
							starred: false,
							logs: [],
							inputValue: '',
							stagedImages: [],
							createdAt: 1700000000000,
							state: 'idle',
							saveToHistory: true,
						},
					] as any,
				}),
			],
			activeSessionId: 'sess-1',
		} as any);

		const { result } = renderHook(() => useClaudeInteractiveMode('sess-1'));
		await act(async () => {
			await result.current.setMode('force-interactive');
		});

		expect(killMock).toHaveBeenCalledWith('sess-1-ai-tab-1');
		expect(killMock).toHaveBeenCalledWith('sess-1-ai-tab-2');
	});

	it('setMode falls back to the legacy `<sessionId>-ai` kill shape when no tabs exist', async () => {
		useSessionStore.setState({
			sessions: [
				buildSession({
					aiTabs: [],
					claudeInteractive: { mode: 'api', modeReason: 'auto' },
				}),
			],
			activeSessionId: 'sess-1',
		} as any);

		const { result } = renderHook(() => useClaudeInteractiveMode('sess-1'));
		await act(async () => {
			await result.current.setMode('force-interactive');
		});

		expect(killMock).toHaveBeenCalledWith('sess-1-ai');
	});

	it('cycling back to auto preserves the prior mode value to avoid churn', async () => {
		// Persisted state: user-pinned to force-api. Cycling to auto should
		// preserve `mode: 'api'` so the selector doesn't see a gratuitous change
		// (it ignores `mode` when `modeReason !== 'user'`).
		useSessionStore.setState({
			sessions: [
				buildSession({
					claudeInteractive: { mode: 'api', modeReason: 'user' },
				}),
			],
			activeSessionId: 'sess-1',
		} as any);

		const { result } = renderHook(() => useClaudeInteractiveMode('sess-1'));
		expect(result.current.mode).toBe('force-api');

		await act(async () => {
			await result.current.setMode('auto');
		});

		expect(setClaudeInteractiveModeMock).toHaveBeenCalledWith('sess-1', 'api', 'auto');
	});

	it('cycling auto → force-interactive sets modeReason to "user"', async () => {
		useSessionStore.setState({
			sessions: [
				buildSession({
					claudeInteractive: { mode: 'interactive', modeReason: 'auto' },
				}),
			],
			activeSessionId: 'sess-1',
		} as any);

		const { result } = renderHook(() => useClaudeInteractiveMode('sess-1'));
		expect(result.current.mode).toBe('auto');

		await act(async () => {
			await result.current.setMode('force-api');
		});

		expect(setClaudeInteractiveModeMock).toHaveBeenCalledWith('sess-1', 'api', 'user');
	});

	it('no-ops when setMode is called with the current position', async () => {
		useSessionStore.setState({
			sessions: [
				buildSession({
					claudeInteractive: { mode: 'interactive', modeReason: 'user' },
				}),
			],
			activeSessionId: 'sess-1',
		} as any);

		const { result } = renderHook(() => useClaudeInteractiveMode('sess-1'));
		await act(async () => {
			await result.current.setMode('force-interactive');
		});

		expect(setClaudeInteractiveModeMock).not.toHaveBeenCalled();
		expect(killMock).not.toHaveBeenCalled();
	});

	it('cycle() traverses all three positions in order', async () => {
		useSessionStore.setState({
			sessions: [buildSession({ claudeInteractive: { mode: 'api', modeReason: 'auto' } })],
			activeSessionId: 'sess-1',
		} as any);

		const { result } = renderHook(() => useClaudeInteractiveMode('sess-1'));

		// auto → force-interactive
		await act(async () => {
			await result.current.cycle();
		});
		expect(setClaudeInteractiveModeMock).toHaveBeenLastCalledWith('sess-1', 'interactive', 'user');
	});

	it('survives an IPC failure without crashing', async () => {
		setClaudeInteractiveModeMock.mockRejectedValueOnce(new Error('IPC down'));
		useSessionStore.setState({
			sessions: [buildSession({ claudeInteractive: { mode: 'api', modeReason: 'auto' } })],
			activeSessionId: 'sess-1',
		} as any);

		const { result } = renderHook(() => useClaudeInteractiveMode('sess-1'));
		await act(async () => {
			await result.current.setMode('force-interactive');
		});

		// IPC fired, kill did not (early-return on persist failure).
		expect(setClaudeInteractiveModeMock).toHaveBeenCalled();
		expect(killMock).not.toHaveBeenCalled();
	});
});
