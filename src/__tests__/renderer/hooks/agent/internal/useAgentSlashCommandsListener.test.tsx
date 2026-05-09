import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAgentSlashCommandsListener } from '../../../../../renderer/hooks/agent/internal/useAgentSlashCommandsListener';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { createMockSession } from '../../../../helpers/mockSession';

let onSlashCommandsHandler: ((sessionId: string, slashCommands: string[]) => void) | undefined;
const mockUnsubscribe = vi.fn();

const mockProcess = {
	onSlashCommands: vi.fn((handler: any) => {
		onSlashCommandsHandler = handler;
		return mockUnsubscribe;
	}),
};

beforeEach(() => {
	vi.clearAllMocks();
	onSlashCommandsHandler = undefined;
	useSessionStore.setState({
		sessions: [],
		groups: [],
		activeSessionId: '',
		initialLoadComplete: false,
		removedWorktreePaths: new Set(),
	});
	(window as any).maestro = { ...((window as any).maestro || {}), process: mockProcess };
});

describe('useAgentSlashCommandsListener', () => {
	it('registers exactly one listener on mount and unsubscribes on unmount', () => {
		const { unmount } = renderHook(() => useAgentSlashCommandsListener());
		expect(mockProcess.onSlashCommands).toHaveBeenCalledTimes(1);
		unmount();
		expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
	});

	it('writes normalised commands to the matching session', () => {
		const session = createMockSession({ id: 'sess-1', toolType: 'claude-code' });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentSlashCommandsListener());
		onSlashCommandsHandler!('sess-1', ['help', '/clear', 'config']);

		const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
		expect(updated?.agentCommands?.map((c) => c.command)).toEqual(['/help', '/clear', '/config']);
		updated?.agentCommands?.forEach((c) => {
			expect(c.description).toBeDefined();
		});
	});

	it('skips no-op renders when the session does not exist (orphan event)', () => {
		const setSessionsSpy = vi.spyOn(useSessionStore.getState(), 'setSessions');
		renderHook(() => useAgentSlashCommandsListener());
		onSlashCommandsHandler!('missing-session', ['/help']);
		expect(setSessionsSpy).not.toHaveBeenCalled();
	});

	it('handles empty command arrays', () => {
		const session = createMockSession({ id: 'sess-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentSlashCommandsListener());
		onSlashCommandsHandler!('sess-1', []);

		const updated = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
		expect(updated?.agentCommands).toEqual([]);
	});
});
