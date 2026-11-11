import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAgentSessionsRename } from '../../../../../renderer/components/AgentSessionsBrowser/hooks/useAgentSessionsRename';
import type { AgentSession } from '../../../../../renderer/hooks/agent/useSessionViewer';
import { createMockSession } from '../../../../helpers/mockSession';
import { createMockAITab } from '../../../../helpers/mockTab';
import { resetStore } from '../../../../helpers/resetStores';
import { useNotificationStore } from '../../../../../renderer/stores/notificationStore';
import { captureException } from '../../../../../renderer/utils/sentry';

vi.mock('../../../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

const mockUpdateSessionName = vi.fn();
const mockSetSessionName = vi.fn();
const mockHistoryUpdateSessionName = vi.fn();
const mockLog = vi.fn();
const updateSession = vi.fn();
const setViewingSession = vi.fn();
const onUpdateTab = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	resetStore(useNotificationStore);
	useNotificationStore.getState().setOsNotifications(false);
	mockUpdateSessionName.mockResolvedValue(undefined);
	mockSetSessionName.mockResolvedValue(undefined);
	(window as any).maestro = {
		claude: { updateSessionName: mockUpdateSessionName },
		agentSessions: { setSessionName: mockSetSessionName },
		history: { updateSessionName: mockHistoryUpdateSessionName },
		logger: { log: mockLog },
	};
});

afterEach(() => {
	useNotificationStore.getState().clearToasts();
	resetStore(useNotificationStore);
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

	// Focusing the rename input is the host component's job (useFocusAfterRender),
	// because only it renders the input and knows when the mount commits. The hook
	// must not race that with a timer of its own.
	it('startRename does not focus renameInputRef itself', () => {
		const renameInputRef = { current: { focus: vi.fn() } } as any;
		const { result } = renderHook(() => useAgentSessionsRename(defaultArgs({ renameInputRef })));
		act(() => {
			result.current.startRename(makeAgentSession(), { stopPropagation: vi.fn() } as any);
		});
		act(() => {
			vi.runAllTimers();
		});
		expect(renameInputRef.current.focus).not.toHaveBeenCalled();
	});

	it('cancelRename flags a focus restore when the rename input still has focus', () => {
		const input = document.createElement('input');
		document.body.appendChild(input);
		input.focus();

		const { result } = renderHook(() =>
			useAgentSessionsRename(defaultArgs({ renameInputRef: { current: input } as any }))
		);
		act(() => {
			result.current.cancelRename();
		});

		expect(result.current.consumeFocusRestore()).toBe(true);
		// The flag is one-shot: a second exit must not re-steal focus.
		expect(result.current.consumeFocusRestore()).toBe(false);
		input.remove();
	});

	it('cancelRename leaves focus alone when the user clicked elsewhere', () => {
		const input = document.createElement('input');
		const other = document.createElement('input');
		document.body.append(input, other);
		other.focus();

		const { result } = renderHook(() =>
			useAgentSessionsRename(defaultArgs({ renameInputRef: { current: input } as any }))
		);
		act(() => {
			result.current.cancelRename();
		});

		expect(result.current.consumeFocusRestore()).toBe(false);
		input.remove();
		other.remove();
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

	it.each(['grok', 'codex'] as const)(
		'refuses Grok History rename visibly without changing rows or tabs when current provider is %s',
		async (toolType) => {
			const viewing = makeAgentSession();
			const tab = createMockAITab({
				agentSessionId: viewing.sessionId,
				name: 'Maestro label',
				nativeSessionBinding: {
					version: 1,
					state: 'bound',
					provider: 'grok',
					nativeSessionId: viewing.sessionId,
					accountRef: 'grok-account-a',
					host: { kind: 'ssh', identity: 'endpoint-a' },
					cwd: '/project',
				},
			});
			if (toolType === 'codex') {
				tab.providerSessions = {
					grok: {
						agentSessionId: tab.agentSessionId,
						nativeSessionBinding: tab.nativeSessionBinding,
					},
				};
				tab.agentSessionId = 'codex-native';
				tab.nativeSessionBinding = undefined;
			}
			const activeSession = createMockSession({ toolType, aiTabs: [tab] });
			const before = structuredClone({ viewing, activeSession });
			const { result } = renderHook(() =>
				useAgentSessionsRename(
					defaultArgs({
						agentId: 'grok',
						activeSession,
						viewingSession: viewing,
					})
				)
			);
			act(() => {
				result.current.beginRename(viewing);
			});
			act(() => {
				result.current.setRenameValue('Requested native title');
			});
			await act(async () => {
				const pending = result.current.submitRename(viewing.sessionId);
				expect(useNotificationStore.getState().toasts).toHaveLength(1);
				expect(updateSession).not.toHaveBeenCalled();
				expect(setViewingSession).not.toHaveBeenCalled();
				expect(onUpdateTab).not.toHaveBeenCalled();
				await pending;
			});
			expect(useNotificationStore.getState().toasts[0]).toMatchObject({
				color: 'yellow',
				title: 'Grok native rename unavailable',
				message: expect.stringContaining('same account and host'),
			});
			expect(useNotificationStore.getState().toasts[0].message).toContain('refresh History');
			expect(useNotificationStore.getState().toasts[0].message).toContain(
				'rename the open conversation tab'
			);
			expect(mockSetSessionName).not.toHaveBeenCalled();
			expect(mockUpdateSessionName).not.toHaveBeenCalled();
			expect(mockHistoryUpdateSessionName).not.toHaveBeenCalled();
			expect(updateSession).not.toHaveBeenCalled();
			expect(setViewingSession).not.toHaveBeenCalled();
			expect(onUpdateTab).not.toHaveBeenCalled();
			expect({ viewing, activeSession }).toEqual(before);
			expect(result.current.renamingSessionId).toBe(viewing.sessionId);
			expect(result.current.renameValue).toBe('Requested native title');
			expect(captureException).not.toHaveBeenCalled();
			expect(mockLog).not.toHaveBeenCalled();
		}
	);

	it.each(['claude-code', 'codex'])(
		'reports unexpected %s rename failures without optimistic success',
		async (agentId) => {
			const failure = new Error('rename transport unavailable');
			const writer = agentId === 'claude-code' ? mockUpdateSessionName : mockSetSessionName;
			writer.mockRejectedValueOnce(failure);
			const viewing = makeAgentSession();
			const { result } = renderHook(() =>
				useAgentSessionsRename(defaultArgs({ agentId, viewingSession: viewing }))
			);
			act(() => {
				result.current.beginRename(viewing);
			});
			act(() => {
				result.current.setRenameValue('New name');
			});
			await act(async () => {
				await result.current.submitRename(viewing.sessionId);
			});
			expect(writer).toHaveBeenCalledOnce();
			expect(captureException).toHaveBeenCalledWith(failure, {
				extra: { agentId, sessionId: viewing.sessionId, projectPath: '/project' },
			});
			expect(mockLog).toHaveBeenCalledWith(
				'error',
				'Failed to rename session:',
				undefined,
				failure
			);
			expect(updateSession).not.toHaveBeenCalled();
			expect(setViewingSession).not.toHaveBeenCalled();
			expect(onUpdateTab).not.toHaveBeenCalled();
			expect(useNotificationStore.getState().toasts).toEqual([]);
			expect(result.current.renamingSessionId).toBeNull();
			expect(viewing.sessionName).toBe('Original Name');
		}
	);

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
