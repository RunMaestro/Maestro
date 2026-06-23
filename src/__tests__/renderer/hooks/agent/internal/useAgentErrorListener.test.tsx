import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useAgentErrorListener } from '../../../../../renderer/hooks/agent/internal/useAgentErrorListener';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { useModalStore } from '../../../../../renderer/stores/modalStore';
import { createMockSession } from '../../../../helpers/mockSession';
import { createMockAITab } from '../../../../helpers/mockTab';

let handler: ((sessionId: string, error: any) => void) | undefined;
const mockUnsubscribe = vi.fn();

const mockProcess = {
	onAgentError: vi.fn((h: any) => {
		handler = h;
		return mockUnsubscribe;
	}),
};

function makeRef(): {
	current: Map<string, { toolName: string; toolState?: any }>;
} {
	return { current: new Map() };
}

const baseError = {
	type: 'auth_expired',
	message: 'expired',
	timestamp: 1700000000000,
	agentId: 'claude-code',
	recoverable: true,
};

beforeEach(() => {
	vi.clearAllMocks();
	handler = undefined;
	useSessionStore.setState({
		sessions: [],
		groups: [],
		activeSessionId: '',
		initialLoadComplete: false,
		removedWorktreePaths: new Set(),
	});
	useModalStore.getState().closeAll();
	(window as any).maestro = { ...((window as any).maestro || {}), process: mockProcess };
});

function makeDeps() {
	return {
		getBatchStateRef: { current: null },
		pauseBatchOnErrorRef: { current: null },
		addHistoryEntryRef: { current: null },
		activeHiddenToolRef: makeRef(),
	};
}

describe('useAgentErrorListener', () => {
	it('opens the agentError modal and stamps session error state', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		handler!('sess-1-ai-tab-1', baseError);

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.state).toBe('error');
		expect(updated.agentError?.type).toBe('auth_expired');
		expect(updated.aiTabs[0].agentError?.type).toBe('auth_expired');

		const modal = useModalStore.getState();
		const agentErrorEntry = modal.modals.get('agentError');
		expect(agentErrorEntry).toBeDefined();
		expect(agentErrorEntry?.data).toEqual({ sessionId: 'sess-1' });
	});

	it('clears stale agentSessionId on session_not_found', () => {
		const tab = createMockAITab({ id: 'tab-1', agentSessionId: 'old-id' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		handler!('sess-1-ai-tab-1', { ...baseError, type: 'session_not_found' });

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.aiTabs[0].agentSessionId).toBeNull();
		// Modal should NOT open for session_not_found
		const entry = useModalStore.getState().modals.get('agentError');
		expect(entry?.open ?? false).toBe(false);
	});

	it('stamps recoveryAction with the last user prompt on session_not_found', () => {
		const userLog = {
			id: 'log-user',
			timestamp: 100,
			source: 'user' as const,
			text: 'do the thing that died',
		};
		const tab = createMockAITab({
			id: 'tab-1',
			agentSessionId: 'old-id',
			logs: [userLog],
		});
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		handler!('sess-1-ai-tab-1', { ...baseError, type: 'session_not_found' });

		const tabAfter = useSessionStore.getState().sessions[0].aiTabs[0];
		const systemEntry = tabAfter.logs.find((l) => l.source === 'system');
		expect(systemEntry?.recoveryAction).toEqual({
			lastUserPrompt: 'do the thing that died',
			tabId: 'tab-1',
		});
	});

	it('omits recoveryAction when no user message exists yet', () => {
		const tab = createMockAITab({ id: 'tab-1', agentSessionId: 'old-id', logs: [] });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		handler!('sess-1-ai-tab-1', { ...baseError, type: 'session_not_found' });

		const tabAfter = useSessionStore.getState().sessions[0].aiTabs[0];
		const systemEntry = tabAfter.logs.find((l) => l.source === 'system');
		expect(systemEntry?.recoveryAction).toBeUndefined();
	});

	it('appends an error log entry to the targeted tab', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		handler!('sess-1-ai-tab-1', baseError);

		const tabAfter = useSessionStore.getState().sessions[0].aiTabs[0];
		const errorLog = tabAfter.logs.find((l) => l.source === 'error');
		expect(errorLog).toBeDefined();
		expect(errorLog?.text).toBe('expired');
	});

	it('tags the error log with renderStyle=text-stream when the session is interactive', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [tab],
			activeTabId: 'tab-1',
			claudeInteractive: { mode: 'interactive', modeReason: 'auto' },
		} as any);
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		handler!('sess-1-ai-tab-1', baseError);

		const tabAfter = useSessionStore.getState().sessions[0].aiTabs[0];
		const errorLog = tabAfter.logs.find((l) => l.source === 'error');
		expect(errorLog?.renderStyle).toBe('text-stream');
	});

	it('leaves renderStyle unset on API-mode (non-interactive) errors', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [tab],
			activeTabId: 'tab-1',
			claudeInteractive: { mode: 'api', modeReason: 'auto' },
		} as any);
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		handler!('sess-1-ai-tab-1', baseError);

		const tabAfter = useSessionStore.getState().sessions[0].aiTabs[0];
		const errorLog = tabAfter.logs.find((l) => l.source === 'error');
		expect(errorLog?.renderStyle).toBeUndefined();
	});

	it('deletes the activeHiddenToolRef entry on error', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		const deps = makeDeps();
		deps.activeHiddenToolRef.current.set('sess-1:tab-1', { toolName: 'Read' });

		renderHook(() => useAgentErrorListener(deps));
		handler!('sess-1-ai-tab-1', baseError);

		expect(deps.activeHiddenToolRef.current.has('sess-1:tab-1')).toBe(false);
	});

	it('seeds auto-resume metadata and stashes the last prompt on a limit error', async () => {
		const getLimitResetAt = vi.fn().mockResolvedValue(1700000123456);
		(window as any).maestro.agents = { getLimitResetAt };

		const userLog = {
			id: 'log-user',
			timestamp: 100,
			source: 'user' as const,
			text: 'do the rate-limited thing',
		};
		const tab = createMockAITab({ id: 'tab-1', logs: [userLog] });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		handler!('sess-1-ai-tab-1', { ...baseError, type: 'rate_limited', message: 'usage limit' });

		// Synchronous pause: error stamped, paused, retry counter seeded to 0.
		const paused = useSessionStore.getState().sessions[0];
		expect(paused.state).toBe('error');
		expect(paused.agentErrorPaused).toBe(true);
		expect(paused.agentError?.type).toBe('rate_limited');
		expect(paused.agentError?.resumeAttemptCount).toBe(0);

		// The captured prompt rides along on the error log so Phase 3 can re-fire it.
		const errorLog = paused.aiTabs[0].logs.find((l) => l.source === 'error');
		expect(errorLog?.recoveryAction).toEqual({
			lastUserPrompt: 'do the rate-limited thing',
			tabId: 'tab-1',
		});

		// Best-effort reset estimate is patched in asynchronously.
		expect(getLimitResetAt).toHaveBeenCalledWith('claude-code');
		await waitFor(() => {
			expect(useSessionStore.getState().sessions[0].agentError?.limitResetAt).toBe(1700000123456);
		});
	});

	it('does not stamp a local reset estimate on an SSH-backed session', async () => {
		const getLimitResetAt = vi.fn().mockResolvedValue(1700000123456);
		(window as any).maestro.agents = { getLimitResetAt };

		const tab = createMockAITab({ id: 'tab-1' });
		// SSH-backed: the local usage snapshot reflects the wrong account, so the
		// estimate must be skipped and the session left to the interval fallback.
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [tab],
			activeTabId: 'tab-1',
			sshRemoteId: 'remote-1',
		});
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		handler!('sess-1-ai-tab-1', { ...baseError, type: 'rate_limited', message: 'usage limit' });

		// Still pauses synchronously; only the local reset probe is skipped.
		const paused = useSessionStore.getState().sessions[0];
		expect(paused.agentErrorPaused).toBe(true);
		expect(getLimitResetAt).not.toHaveBeenCalled();
		expect(paused.agentError?.limitResetAt).toBeUndefined();
	});

	it('skips synopsis-process errors', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		handler!('sess-1-synopsis', baseError);

		expect(useSessionStore.getState().sessions[0].state).not.toBe('error');
	});
});
