import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAgentCommandExitListener } from '../../../../../renderer/hooks/agent/internal/useAgentCommandExitListener';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { createMockSession } from '../../../../helpers/mockSession';
import { createMockAITab } from '../../../../helpers/mockTab';
import { OMP_NATIVE_TURN_COMPLETION } from '../../../../../shared/omp-native-session';
import type { OmpNativeTurnCompletion } from '../../../../../shared/omp-native-session';

let handler:
	| ((sessionId: string, code: number, completion?: OmpNativeTurnCompletion) => void)
	| undefined;
const mockUnsubscribe = vi.fn();

const mockProcess = {
	onCommandExit: vi.fn(
		(
			handlerCallback: (
				sessionId: string,
				code: number,
				completion?: OmpNativeTurnCompletion
			) => void
		) => {
			handler = handlerCallback;
			return mockUnsubscribe;
		}
	),
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
	(window as any).maestro = { ...((window as any).maestro || {}), process: mockProcess };
});

describe('useAgentCommandExitListener', () => {
	it('appends a system log on non-zero exit code', () => {
		const session = createMockSession({ id: 'sess-1', shellLogs: [] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentCommandExitListener());
		handler!('sess-1', 2);

		const updated = useSessionStore.getState().sessions[0];
		const sysLog = updated.shellLogs[updated.shellLogs.length - 1];
		expect(sysLog?.text).toContain('exited with code 2');
		expect(sysLog?.source).toBe('system');
	});

	it('does not append a log on zero exit code', () => {
		const session = createMockSession({ id: 'sess-1', shellLogs: [] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentCommandExitListener());
		handler!('sess-1', 0);

		expect(useSessionStore.getState().sessions[0].shellLogs).toEqual([]);
	});

	it('keeps session busy when an AI tab is still busy', () => {
		const tab = createMockAITab({ id: 'tab-1', state: 'busy' });
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [tab],
			activeTabId: 'tab-1',
			state: 'busy',
		});
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentCommandExitListener());
		handler!('sess-1', 0);

		expect(useSessionStore.getState().sessions[0].state).toBe('busy');
	});

	it('settles two native OMP turns without terminating their routed AI tab', () => {
		const tab = createMockAITab({ id: 'tab-1', state: 'busy', thinkingStartTime: Date.now() });
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [tab],
			activeTabId: 'tab-1',
			state: 'busy',
			busySource: 'ai',
			thinkingStartTime: Date.now(),
		});
		useSessionStore.getState().setSessions(() => [session]);

		renderHook(() => useAgentCommandExitListener());
		handler!('sess-1-ai-tab-1', 0, OMP_NATIVE_TURN_COMPLETION);

		let updated = useSessionStore.getState().sessions[0];
		expect(updated.state).toBe('idle');
		expect(updated.aiTabs[0]).toMatchObject({ state: 'idle', thinkingStartTime: undefined });

		useSessionStore.getState().setSessions((sessions) =>
			sessions.map((current) => ({
				...current,
				state: 'busy',
				busySource: 'ai',
				thinkingStartTime: Date.now(),
				aiTabs: current.aiTabs.map((currentTab) => ({
					...currentTab,
					state: 'busy' as const,
					thinkingStartTime: Date.now(),
				})),
			}))
		);
		handler!('sess-1-ai-tab-1', 0, OMP_NATIVE_TURN_COMPLETION);

		updated = useSessionStore.getState().sessions[0];
		expect(updated.state).toBe('idle');
		expect(updated.aiTabs[0]).toMatchObject({ state: 'idle', thinkingStartTime: undefined });
	});

	it('transitions session to idle when no AI tabs busy', () => {
		const tab = createMockAITab({ id: 'tab-1', state: 'idle' });
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [tab],
			activeTabId: 'tab-1',
			state: 'busy',
		});
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentCommandExitListener());
		handler!('sess-1', 0);

		expect(useSessionStore.getState().sessions[0].state).toBe('idle');
	});

	it('skips no-op render when session is missing (orphan event)', () => {
		const setSessionsSpy = vi.spyOn(useSessionStore.getState(), 'setSessions');
		renderHook(() => useAgentCommandExitListener());
		handler!('missing', 0);
		expect(setSessionsSpy).not.toHaveBeenCalled();
	});
});
