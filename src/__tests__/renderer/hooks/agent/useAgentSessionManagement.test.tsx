import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
	useAgentSessionManagement,
	isSynopsisRequest,
} from '../../../../renderer/hooks/agent/useAgentSessionManagement';
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

function seedActiveSession(session: Session | null) {
	if (session) {
		useSessionStore.setState({ sessions: [session], activeSessionId: session.id } as never);
	} else {
		useSessionStore.setState({ sessions: [], activeSessionId: null } as never);
	}
}

function makeDeps(_activeSession?: Session | null): UseAgentSessionManagementDeps {
	return {
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

		seedActiveSession(activeSession);
		const { result } = renderHook(() => useAgentSessionManagement(makeDeps(activeSession)));
		await act(async () => {
			await result.current.addHistoryEntry({ type: 'USER', summary: 'a turn' });
		});

		expect(historyAdd).toHaveBeenCalledTimes(1);
		const entry = lastAddedEntry();
		expect(entry.tokenSource).toBe('interactive');
		expect(entry.tokenSourceReason).toBe('auto');
	});

	it('defaults a Claude session with no claudeInteractive to API (the default `claude --print` path)', async () => {
		const activeSession = createMockSession({
			id: 'sess-no-mode',
			toolType: 'claude-code',
			claudeInteractive: undefined,
		} as Partial<Session>);

		seedActiveSession(activeSession);
		const { result } = renderHook(() => useAgentSessionManagement(makeDeps(activeSession)));
		await act(async () => {
			await result.current.addHistoryEntry({ type: 'USER', summary: 'a turn' });
		});

		const entry = lastAddedEntry();
		// Absent claudeInteractive means the adaptive/maestro-p machinery never
		// engaged, so the turn ran plain `claude --print` (API). Every Claude turn
		// gets a token-source pill; only the reason is omitted when unknown.
		expect(entry.tokenSource).toBe('api');
		expect(entry).not.toHaveProperty('tokenSourceReason');
	});

	it('omits tokenSource for non-Claude sessions even if claudeInteractive is set', async () => {
		const activeSession = createMockSession({
			id: 'sess-codex',
			toolType: 'codex',
			claudeInteractive: { mode: 'interactive', modeReason: 'auto' },
		} as Partial<Session>);

		seedActiveSession(activeSession);
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

		seedActiveSession(activeSession);
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

describe('isSynopsisRequest', () => {
	it('matches the current "Provide a brief synopsis" wording', () => {
		expect(
			isSynopsisRequest({
				type: 'user',
				content:
					'Provide a brief synopsis of what you just accomplished in this task using this exact format:',
			})
		).toBe(true);
	});

	it('matches the older "Give a brief synopsis" wording', () => {
		expect(
			isSynopsisRequest({
				type: 'user',
				content: 'Give a brief synopsis of what you just accomplished, in exactly this format:',
			})
		).toBe(true);
	});

	it('matches on role when type is absent', () => {
		expect(
			isSynopsisRequest({
				role: 'user',
				content: 'Provide a brief synopsis of what you just accomplished here',
			})
		).toBe(true);
	});

	it('does not match an assistant message that quotes the phrase', () => {
		expect(
			isSynopsisRequest({
				type: 'assistant',
				content: 'You asked me to provide a brief synopsis of what you just accomplished.',
			})
		).toBe(false);
	});

	it('does not match a user message that only mentions the phrase mid-sentence', () => {
		expect(
			isSynopsisRequest({
				type: 'user',
				content:
					'Earlier you gave a brief synopsis of what you just accomplished - can you expand?',
			})
		).toBe(false);
	});

	it('does not match unrelated user messages', () => {
		expect(isSynopsisRequest({ type: 'user', content: 'fix the layout bug' })).toBe(false);
	});
});
