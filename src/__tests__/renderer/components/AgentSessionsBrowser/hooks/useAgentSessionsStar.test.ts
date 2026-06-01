import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAgentSessionsStar } from '../../../../../renderer/components/AgentSessionsBrowser/hooks/useAgentSessionsStar';
import type { Session } from '../../../../../renderer/types';
import { createMockSession } from '../../../../helpers/mockSession';

const mockUpdateSessionStarred = vi.fn();
const mockSetSessionStarred = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	mockUpdateSessionStarred.mockResolvedValue(undefined);
	mockSetSessionStarred.mockResolvedValue(undefined);
	(window as any).maestro = {
		claude: { updateSessionStarred: mockUpdateSessionStarred },
		agentSessions: { setSessionStarred: mockSetSessionStarred },
	};
});

function activeSession(overrides: Partial<Session> = {}): Session {
	return createMockSession({ projectRoot: '/project', ...overrides });
}

function mockEvent(): React.MouseEvent {
	return { stopPropagation: vi.fn() } as any;
}

describe('useAgentSessionsStar', () => {
	it('starts with empty starred set', () => {
		const { result } = renderHook(() =>
			useAgentSessionsStar({
				activeSession: activeSession(),
				agentId: 'claude-code',
				onUpdateTab: undefined,
			})
		);
		expect(result.current.starredSessions.size).toBe(0);
	});

	it('setStarredSessions is returned for external initialization', async () => {
		const { result } = renderHook(() =>
			useAgentSessionsStar({
				activeSession: activeSession(),
				agentId: 'claude-code',
				onUpdateTab: undefined,
			})
		);

		act(() => {
			result.current.setStarredSessions(new Set(['loaded-session']));
		});

		expect(result.current.starredSessions.has('loaded-session')).toBe(true);
	});

	it('toggleStar calls e.stopPropagation', async () => {
		const { result } = renderHook(() =>
			useAgentSessionsStar({
				activeSession: activeSession(),
				agentId: 'claude-code',
				onUpdateTab: undefined,
			})
		);
		const e = mockEvent();
		await act(async () => {
			await result.current.toggleStar('s1', e);
		});
		expect(e.stopPropagation).toHaveBeenCalled();
	});

	it('toggleStar adds session to set when not present', async () => {
		const { result } = renderHook(() =>
			useAgentSessionsStar({
				activeSession: activeSession(),
				agentId: 'claude-code',
				onUpdateTab: undefined,
			})
		);
		await act(async () => {
			await result.current.toggleStar('s1', mockEvent());
		});
		expect(result.current.starredSessions.has('s1')).toBe(true);
	});

	it('toggleStar removes session from set when present', async () => {
		const { result } = renderHook(() =>
			useAgentSessionsStar({
				activeSession: activeSession(),
				agentId: 'claude-code',
				onUpdateTab: undefined,
			})
		);
		act(() => {
			result.current.setStarredSessions(new Set(['s1']));
		});

		await act(async () => {
			await result.current.toggleStar('s1', mockEvent());
		});

		expect(result.current.starredSessions.has('s1')).toBe(false);
	});

	it('claude-code routes through claude.updateSessionStarred', async () => {
		const { result } = renderHook(() =>
			useAgentSessionsStar({
				activeSession: activeSession(),
				agentId: 'claude-code',
				onUpdateTab: undefined,
			})
		);
		await act(async () => {
			await result.current.toggleStar('s1', mockEvent());
		});
		expect(mockUpdateSessionStarred).toHaveBeenCalledWith('/project', 's1', true);
		expect(mockSetSessionStarred).not.toHaveBeenCalled();
	});

	it('non-claude routes through agentSessions.setSessionStarred', async () => {
		const { result } = renderHook(() =>
			useAgentSessionsStar({
				activeSession: activeSession(),
				agentId: 'codex',
				onUpdateTab: undefined,
			})
		);
		await act(async () => {
			await result.current.toggleStar('s1', mockEvent());
		});
		expect(mockSetSessionStarred).toHaveBeenCalledWith('codex', '/project', 's1', true);
		expect(mockUpdateSessionStarred).not.toHaveBeenCalled();
	});

	it('calls onUpdateTab with starred state', async () => {
		const onUpdateTab = vi.fn();
		const { result } = renderHook(() =>
			useAgentSessionsStar({ activeSession: activeSession(), agentId: 'claude-code', onUpdateTab })
		);
		await act(async () => {
			await result.current.toggleStar('s1', mockEvent());
		});
		expect(onUpdateTab).toHaveBeenCalledWith('s1', { starred: true });
	});

	it('does not call IPC when projectRoot is undefined', async () => {
		const session = createMockSession({ projectRoot: undefined });
		const { result } = renderHook(() =>
			useAgentSessionsStar({
				activeSession: session as any,
				agentId: 'claude-code',
				onUpdateTab: undefined,
			})
		);
		await act(async () => {
			await result.current.toggleStar('s1', mockEvent());
		});
		expect(mockUpdateSessionStarred).not.toHaveBeenCalled();
	});

	it('toggling unrelated session does not affect others', async () => {
		const { result } = renderHook(() =>
			useAgentSessionsStar({
				activeSession: activeSession(),
				agentId: 'claude-code',
				onUpdateTab: undefined,
			})
		);
		act(() => {
			result.current.setStarredSessions(new Set(['s1']));
		});

		await act(async () => {
			await result.current.toggleStar('s2', mockEvent());
		});

		expect(result.current.starredSessions.has('s1')).toBe(true);
		expect(result.current.starredSessions.has('s2')).toBe(true);
	});
});
