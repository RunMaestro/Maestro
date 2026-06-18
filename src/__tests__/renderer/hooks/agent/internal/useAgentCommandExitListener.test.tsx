import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAgentCommandExitListener } from '../../../../../renderer/hooks/agent/internal/useAgentCommandExitListener';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { createMockSession } from '../../../../helpers/mockSession';
import { createMockAITab } from '../../../../helpers/mockTab';

let handler: ((sessionId: string, code: number) => void) | undefined;
const mockUnsubscribe = vi.fn();

const mockProcess = {
	onCommandExit: vi.fn((h: any) => {
		handler = h;
		return mockUnsubscribe;
	}),
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
