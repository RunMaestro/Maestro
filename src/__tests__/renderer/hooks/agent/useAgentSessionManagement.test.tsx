import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAgentSessionManagement } from '../../../../renderer/hooks/agent/useAgentSessionManagement';
import type { UseAgentSessionManagementDeps } from '../../../../renderer/hooks/agent/useAgentSessionManagement';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { createMockSession } from '../../../helpers/mockSession';
import type { Session } from '../../../../renderer/types';

const historyAdd = vi.fn().mockResolvedValue(true);

beforeEach(() => {
	vi.clearAllMocks();
	useSessionStore.setState({
		sessions: [],
		groups: [],
		activeSessionId: '',
		initialLoadComplete: false,
		removedWorktreePaths: new Set(),
	} as never);
	(window as any).maestro = {
		...((window as any).maestro || {}),
		history: { add: historyAdd },
	};
});

function makeDeps(activeSession: Session | null): UseAgentSessionManagementDeps {
	return {
		activeSession,
		setSessions: vi.fn(),
		setActiveAgentSessionId: vi.fn(),
		setAgentSessionsOpen: vi.fn(),
		rightPanelRef: { current: null },
		defaultSaveToHistory: false,
		defaultShowThinking: 'off',
		showFlash: vi.fn(),
	};
}

/** Pull the entry object passed to the most recent `history.add` call. */
function lastAddedEntry(): Record<string, unknown> {
	const call = historyAdd.mock.calls.at(-1);
	return (call?.[0] ?? {}) as Record<string, unknown>;
}

describe('useAgentSessionManagement - history token source capture', () => {
	it('stamps tokenSource/tokenSourceReason from a Claude Code session in TUI mode', async () => {
		const activeSession = createMockSession({
			id: 'sess-tui',
			toolType: 'claude-code',
			claudeInteractive: { mode: 'interactive', modeReason: 'auto' },
		} as Partial<Session>);

		const { result } = renderHook(() => useAgentSessionManagement(makeDeps(activeSession)));
		await act(async () => {
			await result.current.addHistoryEntry({ type: 'USER', summary: 'a turn' });
		});

		expect(historyAdd).toHaveBeenCalledTimes(1);
		const entry = lastAddedEntry();
		expect(entry.tokenSource).toBe('interactive');
		expect(entry.tokenSourceReason).toBe('auto');
	});

	it('omits tokenSource when the Claude session has no claudeInteractive', async () => {
		const activeSession = createMockSession({
			id: 'sess-no-mode',
			toolType: 'claude-code',
			claudeInteractive: undefined,
		} as Partial<Session>);

		const { result } = renderHook(() => useAgentSessionManagement(makeDeps(activeSession)));
		await act(async () => {
			await result.current.addHistoryEntry({ type: 'USER', summary: 'a turn' });
		});

		const entry = lastAddedEntry();
		expect(entry).not.toHaveProperty('tokenSource');
		expect(entry).not.toHaveProperty('tokenSourceReason');
	});

	it('omits tokenSource for non-Claude sessions even if claudeInteractive is set', async () => {
		const activeSession = createMockSession({
			id: 'sess-codex',
			toolType: 'codex',
			claudeInteractive: { mode: 'interactive', modeReason: 'auto' },
		} as Partial<Session>);

		const { result } = renderHook(() => useAgentSessionManagement(makeDeps(activeSession)));
		await act(async () => {
			await result.current.addHistoryEntry({ type: 'USER', summary: 'a turn' });
		});

		const entry = lastAddedEntry();
		expect(entry).not.toHaveProperty('tokenSource');
	});

	it('passes through an explicit tokenSource override from the caller', async () => {
		const activeSession = createMockSession({
			id: 'sess-override',
			toolType: 'claude-code',
			claudeInteractive: { mode: 'interactive', modeReason: 'auto' },
		} as Partial<Session>);

		const { result } = renderHook(() => useAgentSessionManagement(makeDeps(activeSession)));
		await act(async () => {
			await result.current.addHistoryEntry({
				type: 'AUTO',
				summary: 'a background turn',
				tokenSource: 'api',
				tokenSourceReason: 'limit',
			});
		});

		const entry = lastAddedEntry();
		expect(entry.tokenSource).toBe('api');
		expect(entry.tokenSourceReason).toBe('limit');
	});
});
