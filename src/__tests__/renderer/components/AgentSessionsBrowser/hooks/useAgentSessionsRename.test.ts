import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAgentSessionsRename } from '../../../../../renderer/components/AgentSessionsBrowser/hooks/useAgentSessionsRename';
import type { AgentSession } from '../../../../../renderer/hooks/agent/useSessionViewer';
import { createMockSession } from '../../../../helpers/mockSession';

const mockUpdateSessionName = vi.fn();
const mockSetSessionName = vi.fn();
const updateSession = vi.fn();
const setViewingSession = vi.fn();
const onUpdateTab = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	mockUpdateSessionName.mockResolvedValue(undefined);
	mockSetSessionName.mockResolvedValue(undefined);
	(window as any).maestro = {
		claude: { updateSessionName: mockUpdateSessionName },
		agentSessions: { setSessionName: mockSetSessionName },
	};
});

afterEach(() => {
	vi.useRealTimers();
});

function makeAgentSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		sessionId: 'sess-1',
		projectPath: '/p',
		timestamp: '2024-01-01T00:00:00Z',
		modifiedAt: '2024-01-01T00:00:00Z',
		firstMessage: '',
		messageCount: 0,
		sizeBytes: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		durationSeconds: 0,
		sessionName: 'Original Name',
		...overrides,
	};
}

function defaultArgs(overrides: any = {}) {
	const renameInputRef = { current: { focus: vi.fn() } } as any;
	return {
		activeSession: createMockSession({ projectRoot: '/project' }),
		agentId: 'claude-code',
		viewingSession: null as AgentSession | null,
		setViewingSession,
		updateSession,
		onUpdateTab,
		renameInputRef,
		...overrides,
	};
}

describe('useAgentSessionsRename', () => {
	it('starts with null renamingSessionId and empty renameValue', () => {
		const { result } = renderHook(() => useAgentSessionsRename(defaultArgs()));
		expect(result.current.renamingSessionId).toBeNull();
		expect(result.current.renameValue).toBe('');
	});

	it('startRename sets renamingSessionId', () => {
		const { result } = renderHook(() => useAgentSessionsRename(defaultArgs()));
		const session = makeAgentSession();
		act(() => {
			result.current.startRename(session, { stopPropagation: vi.fn() } as any);
		});
		expect(result.current.renamingSessionId).toBe('sess-1');
	});

	it('startRename sets renameValue to current sessionName', () => {
		const { result } = renderHook(() => useAgentSessionsRename(defaultArgs()));
		const session = makeAgentSession({ sessionName: 'Existing Name' });
		act(() => {
			result.current.startRename(session, { stopPropagation: vi.fn() } as any);
		});
		expect(result.current.renameValue).toBe('Existing Name');
	});

	it('startRename sets empty renameValue when no sessionName', () => {
		const { result } = renderHook(() => useAgentSessionsRename(defaultArgs()));
		const session = makeAgentSession({ sessionName: undefined });
		act(() => {
			result.current.startRename(session, { stopPropagation: vi.fn() } as any);
		});
		expect(result.current.renameValue).toBe('');
	});

	it('startRename calls e.stopPropagation', () => {
		const { result } = renderHook(() => useAgentSessionsRename(defaultArgs()));
		const e = { stopPropagation: vi.fn() } as any;
		act(() => {
			result.current.startRename(makeAgentSession(), e);
		});
		expect(e.stopPropagation).toHaveBeenCalled();
	});

	it('startRename focuses renameInputRef after timer', () => {
		const renameInputRef = { current: { focus: vi.fn() } } as any;
		const { result } = renderHook(() => useAgentSessionsRename(defaultArgs({ renameInputRef })));
		act(() => {
			result.current.startRename(makeAgentSession(), { stopPropagation: vi.fn() } as any);
		});
		act(() => {
			vi.runAllTimers();
		});
		expect(renameInputRef.current.focus).toHaveBeenCalled();
	});

	it('cancelRename clears renamingSessionId and renameValue', () => {
		const { result } = renderHook(() => useAgentSessionsRename(defaultArgs()));
		act(() => {
			result.current.startRename(makeAgentSession(), { stopPropagation: vi.fn() } as any);
		});
		act(() => {
			result.current.cancelRename();
		});
		expect(result.current.renamingSessionId).toBeNull();
		expect(result.current.renameValue).toBe('');
	});

	it('submitRename claude-code routes through claude.updateSessionName', async () => {
		const { result } = renderHook(() => useAgentSessionsRename(defaultArgs()));
		act(() => {
			result.current.setRenameValue('New Name');
		});
		await act(async () => {
			await result.current.submitRename('sess-1');
		});
		expect(mockUpdateSessionName).toHaveBeenCalledWith('/project', 'sess-1', 'New Name');
		expect(mockSetSessionName).not.toHaveBeenCalled();
	});

	it('submitRename non-claude routes through agentSessions.setSessionName', async () => {
		const { result } = renderHook(() => useAgentSessionsRename(defaultArgs({ agentId: 'codex' })));
		act(() => {
			result.current.setRenameValue('New Name');
		});
		await act(async () => {
			await result.current.submitRename('sess-1');
		});
		expect(mockSetSessionName).toHaveBeenCalledWith('codex', '/project', 'sess-1', 'New Name');
	});

	it('submitRename trims whitespace', async () => {
		const { result } = renderHook(() => useAgentSessionsRename(defaultArgs()));
		act(() => {
			result.current.setRenameValue('  Trimmed  ');
		});
		await act(async () => {
			await result.current.submitRename('sess-1');
		});
		expect(mockUpdateSessionName).toHaveBeenCalledWith('/project', 'sess-1', 'Trimmed');
	});

	it('submitRename calls updateSession', async () => {
		const { result } = renderHook(() => useAgentSessionsRename(defaultArgs()));
		act(() => {
			result.current.setRenameValue('New');
		});
		await act(async () => {
			await result.current.submitRename('sess-1');
		});
		expect(updateSession).toHaveBeenCalledWith('sess-1', { sessionName: 'New' });
	});

	it('submitRename updates viewingSession when ids match', async () => {
		const viewing = makeAgentSession({ sessionId: 'sess-1' });
		const { result } = renderHook(() =>
			useAgentSessionsRename(defaultArgs({ viewingSession: viewing }))
		);
		act(() => {
			result.current.setRenameValue('Updated');
		});
		await act(async () => {
			await result.current.submitRename('sess-1');
		});
		expect(setViewingSession).toHaveBeenCalled();
	});

	it('submitRename does NOT update viewingSession when ids differ', async () => {
		const viewing = makeAgentSession({ sessionId: 'different-sess' });
		const { result } = renderHook(() =>
			useAgentSessionsRename(defaultArgs({ viewingSession: viewing }))
		);
		act(() => {
			result.current.setRenameValue('Updated');
		});
		await act(async () => {
			await result.current.submitRename('sess-1');
		});
		expect(setViewingSession).not.toHaveBeenCalled();
	});

	it('submitRename calls onUpdateTab', async () => {
		const { result } = renderHook(() => useAgentSessionsRename(defaultArgs()));
		act(() => {
			result.current.setRenameValue('NewName');
		});
		await act(async () => {
			await result.current.submitRename('sess-1');
		});
		expect(onUpdateTab).toHaveBeenCalledWith('sess-1', { name: 'NewName' });
	});

	it('submitRename no-op when projectRoot is undefined', async () => {
		const session = createMockSession({ projectRoot: undefined });
		const { result } = renderHook(() =>
			useAgentSessionsRename(defaultArgs({ activeSession: session as any }))
		);
		await act(async () => {
			await result.current.submitRename('sess-1');
		});
		expect(mockUpdateSessionName).not.toHaveBeenCalled();
	});
});
