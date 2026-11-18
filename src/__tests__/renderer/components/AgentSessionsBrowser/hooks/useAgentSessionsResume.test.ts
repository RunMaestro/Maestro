import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAgentSessionsResume } from '../../../../../renderer/components/AgentSessionsBrowser/hooks/useAgentSessionsResume';
import { FALLBACK_CONTEXT_WINDOW } from '../../../../../shared/agentConstants';
import type { NativeSessionBinding } from '../../../../../shared/maestro-lib/agents/providerSwap';
import type {
	AgentSession,
	SessionMessage,
} from '../../../../../renderer/hooks/agent/useSessionViewer';

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		sessionId: 'sess-1',
		projectPath: '/p',
		timestamp: '2024-01-01T00:00:00Z',
		modifiedAt: '2024-01-01T00:00:00Z',
		firstMessage: '',
		messageCount: 2,
		sizeBytes: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		durationSeconds: 0,
		sessionName: 'My Session',
		...overrides,
	};
}

function makeMsg(overrides: Partial<SessionMessage> = {}): SessionMessage {
	return {
		type: 'user',
		content: 'hello',
		timestamp: '2024-01-01T10:00:00Z',
		uuid: 'u1',
		...overrides,
	};
}

describe('useAgentSessionsResume', () => {
	const onResumeSession = vi.fn();
	const onClose = vi.fn();

	beforeEach(() => {
		onResumeSession.mockReset().mockResolvedValue(true);
		onClose.mockClear();
	});

	it('handleResume no-op when viewingSession is null', () => {
		const { result } = renderHook(() =>
			useAgentSessionsResume({
				viewingSession: null,
				messages: [],
				starredSessions: new Set(),
				onResumeSession,
				onClose,
			})
		);
		result.current.handleResume();
		expect(onResumeSession).not.toHaveBeenCalled();
	});

	it('handleResume converts messages via messagesToLogEntries', () => {
		const messages = [makeMsg({ uuid: 'u1', type: 'user', content: 'ask' })];
		const { result } = renderHook(() =>
			useAgentSessionsResume({
				viewingSession: makeSession(),
				messages,
				starredSessions: new Set(),
				onResumeSession,
				onClose,
			})
		);
		result.current.handleResume();
		const logEntries = onResumeSession.mock.calls[0][1];
		expect(logEntries).toHaveLength(1);
		expect(logEntries[0].source).toBe('user');
		expect(logEntries[0].text).toBe('ask');
	});

	it('handleResume filters out tool-call messages', () => {
		const messages = [
			makeMsg({ uuid: 'u1', type: 'user', content: 'ask' }),
			makeMsg({ uuid: 'u2', type: 'assistant', toolUse: [{ name: 'bash' }] }),
			makeMsg({ uuid: 'u3', type: 'assistant', content: 'response' }),
		];
		const { result } = renderHook(() =>
			useAgentSessionsResume({
				viewingSession: makeSession(),
				messages,
				starredSessions: new Set(),
				onResumeSession,
				onClose,
			})
		);
		result.current.handleResume();
		const logEntries = onResumeSession.mock.calls[0][1];
		expect(logEntries).toHaveLength(2);
	});

	it('handleResume preserves sessionName from viewingSession', () => {
		const { result } = renderHook(() =>
			useAgentSessionsResume({
				viewingSession: makeSession({ sessionName: 'My Work' }),
				messages: [],
				starredSessions: new Set(),
				onResumeSession,
				onClose,
			})
		);
		result.current.handleResume();
		expect(onResumeSession).toHaveBeenCalledWith(
			'sess-1',
			[],
			'My Work',
			false,
			undefined,
			undefined,
			{
				targetSessionId: undefined,
				nativeSessionBinding: undefined,
			}
		);
	});

	it('handleResume preserves starred from starredSessions Set', () => {
		const { result } = renderHook(() =>
			useAgentSessionsResume({
				viewingSession: makeSession(),
				messages: [],
				starredSessions: new Set(['sess-1']),
				onResumeSession,
				onClose,
			})
		);
		result.current.handleResume();
		expect(onResumeSession.mock.calls[0][3]).toBe(true);
	});

	it('handleResume builds usageStats from session costUsd', () => {
		const { result } = renderHook(() =>
			useAgentSessionsResume({
				viewingSession: makeSession({ costUsd: 2.5 }),
				messages: [],
				starredSessions: new Set(),
				onResumeSession,
				onClose,
			})
		);
		result.current.handleResume();
		const usageStats = onResumeSession.mock.calls[0][4];
		expect(usageStats?.totalCostUsd).toBe(2.5);
		expect(usageStats?.contextWindow).toBe(FALLBACK_CONTEXT_WINDOW);
		expect(usageStats?.inputTokens).toBe(0);
	});

	it('handleResume calls onClose after onResumeSession', async () => {
		const { result } = renderHook(() =>
			useAgentSessionsResume({
				viewingSession: makeSession(),
				messages: [],
				starredSessions: new Set(),
				onResumeSession,
				onClose,
			})
		);
		await result.current.handleResume();
		expect(onClose).toHaveBeenCalled();
	});

	it('handleResume passes undefined usageStats when no cost', () => {
		const { result } = renderHook(() =>
			useAgentSessionsResume({
				viewingSession: makeSession({ costUsd: undefined }),
				messages: [],
				starredSessions: new Set(),
				onResumeSession,
				onClose,
			})
		);
		result.current.handleResume();
		expect(onResumeSession.mock.calls[0][4]).toBeUndefined();
	});

	it('handleQuickResume passes empty messages array', () => {
		const session = makeSession();
		const { result } = renderHook(() =>
			useAgentSessionsResume({
				viewingSession: null,
				messages: [makeMsg()],
				starredSessions: new Set(),
				onResumeSession,
				onClose,
			})
		);
		const e = { stopPropagation: vi.fn() } as any;
		result.current.handleQuickResume(session, e);
		expect(onResumeSession.mock.calls[0][1]).toEqual([]);
	});

	it('handleQuickResume stops propagation', () => {
		const session = makeSession();
		const { result } = renderHook(() =>
			useAgentSessionsResume({
				viewingSession: null,
				messages: [],
				starredSessions: new Set(),
				onResumeSession,
				onClose,
			})
		);
		const e = { stopPropagation: vi.fn() } as any;
		result.current.handleQuickResume(session, e);
		expect(e.stopPropagation).toHaveBeenCalled();
	});

	it('handleQuickResume preserves starred from set', () => {
		const session = makeSession({ sessionId: 'my-sess' });
		const { result } = renderHook(() =>
			useAgentSessionsResume({
				viewingSession: null,
				messages: [],
				starredSessions: new Set(['my-sess']),
				onResumeSession,
				onClose,
			})
		);
		const e = { stopPropagation: vi.fn() } as any;
		result.current.handleQuickResume(session, e);
		expect(onResumeSession.mock.calls[0][3]).toBe(true);
	});

	it('handleQuickResume calls onResumeSession + onClose', async () => {
		const session = makeSession();
		const { result } = renderHook(() =>
			useAgentSessionsResume({
				viewingSession: null,
				messages: [],
				starredSessions: new Set(),
				onResumeSession,
				onClose,
			})
		);
		const e = { stopPropagation: vi.fn() } as any;
		await result.current.handleQuickResume(session, e);
		expect(onResumeSession).toHaveBeenCalled();
		expect(onClose).toHaveBeenCalled();
	});
	describe.each(['detailed', 'quick'] as const)('%s scoped resume', (mode) => {
		const binding = {
			version: 1,
			state: 'bound',
			provider: 'grok',
			nativeSessionId: 'sess-1',
			accountRef: 'account-a',
			host: { kind: 'ssh', identity: 'endpoint-a' },
			cwd: '/p',
		} as const satisfies NativeSessionBinding;

		it('forwards the selected owner and clones its receipt across colliding IDs', async () => {
			const first = makeSession({ ownerAgentId: 'owner-a', nativeSessionBinding: binding });
			const second = makeSession({
				ownerAgentId: 'owner-b',
				nativeSessionBinding: {
					...binding,
					accountRef: 'account-b',
					host: { kind: 'local', identity: 'machine-b' },
				},
			});
			onResumeSession.mockResolvedValue(false);
			const { result, rerender } = renderHook(
				({ viewingSession }) =>
					useAgentSessionsResume({
						viewingSession,
						messages: [makeMsg()],
						starredSessions: new Set(),
						onResumeSession,
						onClose,
					}),
				{ initialProps: { viewingSession: first } }
			);
			for (const selected of [first, second]) {
				rerender({ viewingSession: selected });
				const event = { stopPropagation: vi.fn() } as unknown as React.MouseEvent;
				if (mode === 'detailed') await result.current.handleResume();
				else await result.current.handleQuickResume(selected, event);
				const args = onResumeSession.mock.lastCall!;
				expect(args[0]).toBe('sess-1');
				expect(args[1]).toHaveLength(mode === 'detailed' ? 1 : 0);
				expect(args[5]).toBeUndefined(); // Parent resolves project-root aliases.
				expect(args[6]).toEqual({
					targetSessionId: selected.ownerAgentId,
					nativeSessionBinding: selected.nativeSessionBinding,
				});
				expect(args[6].nativeSessionBinding).not.toBe(selected.nativeSessionBinding);
				expect(args[6].nativeSessionBinding.host).not.toBe(binding.host);
				args[6].nativeSessionBinding.host.identity = 'callback-mutation';
				expect(selected.nativeSessionBinding).toEqual(
					selected === first
						? binding
						: {
								...binding,
								accountRef: 'account-b',
								host: { kind: 'local', identity: 'machine-b' },
							}
				);
				if (mode === 'quick') expect(event.stopPropagation).toHaveBeenCalledOnce();
			}
			expect(onClose).not.toHaveBeenCalled();
		});

		it.each([undefined, { version: 1, state: 'unknown', reason: 'legacy' } as const])(
			'preserves missing owner and unknown legacy receipt %j',
			async (nativeSessionBinding) => {
				const session = makeSession({ nativeSessionBinding });
				onResumeSession.mockResolvedValue(false);
				const { result } = renderHook(() =>
					useAgentSessionsResume({
						viewingSession: session,
						messages: [],
						starredSessions: new Set(),
						onResumeSession,
						onClose,
					})
				);
				if (mode === 'detailed') await result.current.handleResume();
				else
					await result.current.handleQuickResume(session, {
						stopPropagation: vi.fn(),
					} as unknown as React.MouseEvent);
				expect(onResumeSession.mock.lastCall![6]).toEqual({
					targetSessionId: undefined,
					nativeSessionBinding,
				});
				expect(onClose).not.toHaveBeenCalled();
			}
		);

		it.each([true, false, undefined])(
			'closes only after confirmed deferred result %s',
			async (outcome) => {
				let complete!: (value: boolean | undefined) => void;
				onResumeSession.mockReturnValue(
					new Promise<boolean | undefined>((resolve) => {
						complete = resolve;
					})
				);
				const session = makeSession({ ownerAgentId: 'owner-a', nativeSessionBinding: binding });
				const { result } = renderHook(() =>
					useAgentSessionsResume({
						viewingSession: session,
						messages: [],
						starredSessions: new Set(),
						onResumeSession,
						onClose,
					})
				);
				const pending =
					mode === 'detailed'
						? result.current.handleResume()
						: result.current.handleQuickResume(session, {
								stopPropagation: vi.fn(),
							} as unknown as React.MouseEvent);
				expect(onResumeSession).toHaveBeenCalledOnce();
				expect(onClose).not.toHaveBeenCalled();
				complete(outcome);
				await pending;
				expect(onClose).toHaveBeenCalledTimes(outcome === true ? 1 : 0);
			}
		);

		it('propagates rejected opens without closing the selected history', async () => {
			const error = new Error('native session refused');
			onResumeSession.mockRejectedValue(error);
			const session = makeSession({ ownerAgentId: 'owner-a', nativeSessionBinding: binding });
			const { result } = renderHook(() =>
				useAgentSessionsResume({
					viewingSession: session,
					messages: [],
					starredSessions: new Set(),
					onResumeSession,
					onClose,
				})
			);
			const pending =
				mode === 'detailed'
					? result.current.handleResume()
					: result.current.handleQuickResume(session, {
							stopPropagation: vi.fn(),
						} as unknown as React.MouseEvent);
			await expect(pending).rejects.toBe(error);
			expect(onClose).not.toHaveBeenCalled();
		});

		it.each(['navigation', 'unmount', 'newer resume'] as const)(
			'keeps an old success from closing after %s',
			async (change) => {
				let complete!: (value: boolean) => void;
				onResumeSession
					.mockReturnValueOnce(
						new Promise<boolean>((resolve) => {
							complete = resolve;
						})
					)
					.mockResolvedValue(false);
				const session = makeSession({ ownerAgentId: 'owner-a', nativeSessionBinding: binding });
				const { result, rerender, unmount } = renderHook(
					({ viewingSession }) =>
						useAgentSessionsResume({
							viewingSession,
							messages: [],
							starredSessions: new Set(),
							onResumeSession,
							onClose,
						}),
					{ initialProps: { viewingSession: session } }
				);
				const event = { stopPropagation: vi.fn() } as unknown as React.MouseEvent;
				const pending =
					mode === 'detailed'
						? result.current.handleResume()
						: result.current.handleQuickResume(session, event);
				if (change === 'navigation')
					rerender({ viewingSession: makeSession({ ownerAgentId: 'owner-b' }) });
				else if (change === 'unmount') unmount();
				else if (mode === 'detailed') await result.current.handleResume();
				else await result.current.handleQuickResume(session, event);
				complete(true);
				await pending;
				expect(onClose).not.toHaveBeenCalled();
			}
		);
	});
});
