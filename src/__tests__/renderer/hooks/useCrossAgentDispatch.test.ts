import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
	accumulateCrossAgentChunk,
	buildCrossAgentLogEntry,
	buildConsultTabName,
	ensureConsultTab,
	sendCrossAgentRequest,
	useCrossAgentDispatch,
} from '../../../renderer/hooks/agent/useCrossAgentDispatch';
import { useCrossAgentInFlightStore } from '../../../renderer/stores/crossAgentInFlightStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import {
	buildUnifiedTabs,
	getNavigableTabs,
	revealAiTab,
} from '../../../renderer/utils/tabHelpers';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import type { CrossAgentResponseChunk } from '../../../shared/crossAgentTypes';

/**
 * Isolated tests for the pure chunk-accumulation logic behind
 * useCrossAgentDispatch - no IPC or React needed. The hook itself just wires
 * these into an updateSessionWith call.
 */

function chunk(overrides: Partial<CrossAgentResponseChunk> = {}): CrossAgentResponseChunk {
	return {
		requestId: 'r1',
		sourceSessionId: 'src',
		sourceTabId: 'tab',
		targetSessionId: 'tgt',
		targetAgentName: 'Codex',
		targetToolType: 'codex',
		chunk: '',
		done: false,
		...overrides,
	};
}

describe('accumulateCrossAgentChunk', () => {
	it('appends chunk text to the prior accumulation', () => {
		const result = accumulateCrossAgentChunk('Hello', chunk({ chunk: ' world' }));
		expect(result.accumulated).toBe('Hello world');
		expect(result.displayText).toBe('Hello world');
	});

	it('accumulates across multiple streamed chunks', () => {
		let acc = '';
		for (const piece of ['a', 'b', 'c']) {
			acc = accumulateCrossAgentChunk(acc, chunk({ chunk: piece })).accumulated;
		}
		expect(acc).toBe('abc');
	});

	it('treats a missing chunk field as empty (no NaN / "undefined")', () => {
		const result = accumulateCrossAgentChunk('x', chunk({ chunk: undefined as unknown as string }));
		expect(result.accumulated).toBe('x');
		expect(result.displayText).toBe('x');
	});

	it('surfaces a failure note when an error chunk carries no accumulated text', () => {
		const result = accumulateCrossAgentChunk('', chunk({ done: true, error: 'boom' }));
		expect(result.displayText).toContain('Codex');
		expect(result.displayText).toContain('boom');
	});

	it('keeps BOTH the partial answer and the failure reason when a consult dies mid-answer', () => {
		const result = accumulateCrossAgentChunk(
			'partial answer',
			chunk({ done: true, error: 'went silent for 10 minutes' })
		);
		// The reason must reach the bubble body: the attribution header only exposes
		// `error` to screen readers, so text-only would hide WHY the consult failed.
		expect(result.displayText).toContain('partial answer');
		expect(result.displayText).toContain('went silent for 10 minutes');
		// The raw accumulation stays clean - the note is presentation, not content.
		expect(result.accumulated).toBe('partial answer');
	});

	it('reports a stopped consult as stopped, never as the target failing', () => {
		const result = accumulateCrossAgentChunk(
			'partial answer',
			chunk({ done: true, canceled: true })
		);
		expect(result.displayText).toContain('partial answer');
		expect(result.displayText).toContain('was stopped');
		// "could not respond" blames the target for a decision the user made.
		expect(result.displayText).not.toContain('could not respond');
		expect(result.accumulated).toBe('partial answer');
	});

	it('shows a standalone stop note when the consult said nothing before Stop', () => {
		const result = accumulateCrossAgentChunk('', chunk({ done: true, canceled: true }));
		expect(result.displayText).toContain('Codex');
		expect(result.displayText).toContain('was stopped');
	});
});

describe('buildCrossAgentLogEntry', () => {
	it('builds an ai-source entry stamped with crossAgent provenance', () => {
		const entry = buildCrossAgentLogEntry(
			'e1',
			123,
			'the answer',
			chunk({ chunk: 'the answer', done: true })
		);
		expect(entry.id).toBe('e1');
		expect(entry.timestamp).toBe(123);
		expect(entry.source).toBe('ai');
		expect(entry.text).toBe('the answer');
		expect(entry.metadata?.crossAgent).toEqual({
			requestId: 'r1',
			fromSessionId: 'tgt',
			fromAgentName: 'Codex',
			fromToolType: 'codex',
			streaming: false,
		});
	});

	it('marks the entry as streaming until the terminal chunk lands', () => {
		const midStream = buildCrossAgentLogEntry('e1', 123, 'partial', chunk({ done: false }));
		expect(midStream.metadata?.crossAgent?.streaming).toBe(true);

		const finalChunk = buildCrossAgentLogEntry('e1', 123, 'complete', chunk({ done: true }));
		expect(finalChunk.metadata?.crossAgent?.streaming).toBe(false);
	});

	it('stamps the error on the metadata for a failed consult (Phase 05)', () => {
		const errored = buildCrossAgentLogEntry(
			'e1',
			123,
			'⚠️ could not respond',
			chunk({ done: true, error: 'boom' })
		);
		expect(errored.metadata?.crossAgent?.error).toBe('boom');
	});

	it('omits the error field on a normal (non-error) entry', () => {
		const ok = buildCrossAgentLogEntry('e1', 123, 'done', chunk({ done: true }));
		expect(ok.metadata?.crossAgent?.error).toBeUndefined();
	});

	it('carries the consult tab id (fromTabId) so the jump arrow can deep-link to it', () => {
		const entry = buildCrossAgentLogEntry(
			'e1',
			123,
			'answer',
			chunk({ done: true, targetTabId: 'consult-tab-1' })
		);
		expect(entry.metadata?.crossAgent?.fromTabId).toBe('consult-tab-1');
	});
});

describe('buildConsultTabName', () => {
	it('labels the consult tab with an inbound marker and the caller name', () => {
		expect(buildConsultTabName('Scratch')).toBe('↩ Scratch');
	});
});

describe('ensureConsultTab', () => {
	it('resolves an existing consult pin independently of the target active tab and default', () => {
		useSessionStore.setState({
			sessions: [
				createMockSession({
					id: 'target',
					toolType: 'claude-code',
					activeTabId: 'active',
					aiTabs: [
						createMockAITab({ id: 'active', agentSessionId: 'active-id' }),
						createMockAITab({
							id: 'consult',
							tabProvider: 'codex',
							agentSessionId: 'codex-id',
							consultOrigin: { sourceSessionId: 'src', sourceTabId: 'src-tab' },
						}),
					],
				}),
			],
		});
		expect(
			ensureConsultTab({
				targetSessionId: 'target',
				sourceSessionId: 'src',
				sourceTabId: 'src-tab',
				sourceAgentName: 'Source',
				question: 'q',
			})
		).toMatchObject({
			targetTabId: 'consult',
			targetProvider: 'codex',
			resumeAgentSessionId: 'codex-id',
		});
	});

	it('creates hidden consults with the target default even when its active tab is pinned', () => {
		useSessionStore.setState({
			sessions: [
				createMockSession({
					id: 'target',
					toolType: 'claude-code',
					aiTabs: [createMockAITab({ id: 'active', tabProvider: 'codex' })],
					activeTabId: 'active',
				}),
			],
		});
		const result = ensureConsultTab({
			targetSessionId: 'target',
			sourceSessionId: 'src',
			sourceTabId: 'src-tab',
			sourceAgentName: 'Source',
			question: 'q',
		})!;
		expect(result.targetProvider).toBe('claude-code');
		const target = useSessionStore.getState().sessions[0];
		expect(target.aiTabs.find((tab) => tab.id === result.targetTabId)?.tabProvider).toBeUndefined();
		expect(target.activeTabId).toBe('active');
	});
	beforeEach(() => {
		useSessionStore.setState({ sessions: [] } as never);
	});

	const seedTarget = (): void => {
		useSessionStore.setState({
			sessions: [
				createMockSession({
					id: 'target',
					name: 'Maestro Marketing',
					activeTabId: 'main-tab',
					aiTabs: [
						{
							id: 'main-tab',
							agentSessionId: null,
							name: 'Main',
							starred: false,
							logs: [],
							inputValue: '',
							stagedImages: [],
							createdAt: 0,
							state: 'idle',
						},
					],
				}),
			],
		} as never);
	};

	it('creates a consult tab tagged with its origin and appends the question, without stealing focus', () => {
		seedTarget();
		const result = ensureConsultTab({
			targetSessionId: 'target',
			sourceSessionId: 'scratch',
			sourceTabId: 'scratch-tab-1',
			sourceAgentName: 'Scratch',
			question: 'what is the status?',
		});
		expect(result).not.toBeNull();

		const target = useSessionStore.getState().sessions.find((s) => s.id === 'target')!;
		// Focus must NOT move to the new consult tab.
		expect(target.activeTabId).toBe('main-tab');
		const consult = target.aiTabs.find((t) => t.id === result!.targetTabId)!;
		expect(consult.consultOrigin).toEqual({
			sourceSessionId: 'scratch',
			sourceTabId: 'scratch-tab-1',
		});
		expect(consult.name).toBe('↩ Scratch');
		expect(consult.logs.map((l) => l.text)).toEqual(['what is the status?']);
		// First mention has no session to resume yet.
		expect(result!.resumeAgentSessionId).toBeUndefined();
	});

	it('creates the consult tab hidden, so a mention never opens a tab on the target', () => {
		seedTarget();
		const result = ensureConsultTab({
			targetSessionId: 'target',
			sourceSessionId: 'scratch',
			sourceTabId: 'scratch-tab-1',
			sourceAgentName: 'Scratch',
			question: 'q',
		})!;

		const target = useSessionStore.getState().sessions.find((s) => s.id === 'target')!;
		const consult = target.aiTabs.find((t) => t.id === result.targetTabId)!;
		expect(consult.hidden).toBe(true);
		// It exists as data, but the target's tab strip is untouched.
		expect(buildUnifiedTabs(target).map((t) => t.id)).toEqual(['main-tab']);
		// ...and no tab-cycling shortcut can land on it.
		expect(getNavigableTabs(target).map((t) => t.id)).toEqual(['main-tab']);
	});

	it('leaves an already-revealed consult tab visible on a repeat mention', () => {
		seedTarget();
		const first = ensureConsultTab({
			targetSessionId: 'target',
			sourceSessionId: 'scratch',
			sourceTabId: 'scratch-tab-1',
			sourceAgentName: 'Scratch',
			question: 'q1',
		})!;
		// The user opened it; it must not re-hide when the same source mentions again.
		useSessionStore.setState({
			sessions: useSessionStore
				.getState()
				.sessions.map((s) => (s.id === 'target' ? revealAiTab(s, first.targetTabId) : s)),
		} as never);

		ensureConsultTab({
			targetSessionId: 'target',
			sourceSessionId: 'scratch',
			sourceTabId: 'scratch-tab-1',
			sourceAgentName: 'Scratch',
			question: 'q2',
		});

		const target = useSessionStore.getState().sessions.find((s) => s.id === 'target')!;
		const consult = target.aiTabs.find((t) => t.id === first.targetTabId)!;
		expect(consult.hidden).toBe(false);
		expect(buildUnifiedTabs(target).map((t) => t.id)).toContain(first.targetTabId);
	});

	it('does not disturb the target view when it is displaying a tiled group', () => {
		seedTarget();
		useSessionStore.setState({
			sessions: useSessionStore
				.getState()
				.sessions.map((s) => (s.id === 'target' ? { ...s, activeGroupId: 'group-1' } : s)),
		} as never);

		ensureConsultTab({
			targetSessionId: 'target',
			sourceSessionId: 'scratch',
			sourceTabId: 'scratch-tab-1',
			sourceAgentName: 'Scratch',
			question: 'q',
		});

		// createTab clears activeGroupId to focus its new tab; a consult must restore
		// it, or the target silently pops out of the group it was showing.
		const target = useSessionStore.getState().sessions.find((s) => s.id === 'target')!;
		expect(target.activeGroupId).toBe('group-1');
	});

	it('reuses the same consult tab (and resumes its session) on a repeat mention from the same source tab', () => {
		seedTarget();
		const first = ensureConsultTab({
			targetSessionId: 'target',
			sourceSessionId: 'scratch',
			sourceTabId: 'scratch-tab-1',
			sourceAgentName: 'Scratch',
			question: 'q1',
		})!;
		// Simulate the captured provider session id being stored after the first consult.
		useSessionStore.setState({
			sessions: useSessionStore.getState().sessions.map((s) =>
				s.id !== 'target'
					? s
					: {
							...s,
							aiTabs: s.aiTabs.map((t) =>
								t.id === first.targetTabId ? { ...t, agentSessionId: 'provider-abc' } : t
							),
						}
			),
		} as never);

		const second = ensureConsultTab({
			targetSessionId: 'target',
			sourceSessionId: 'scratch',
			sourceTabId: 'scratch-tab-1',
			sourceAgentName: 'Scratch',
			question: 'q2',
		})!;

		expect(second.targetTabId).toBe(first.targetTabId);
		expect(second.resumeAgentSessionId).toBe('provider-abc');
		const target = useSessionStore.getState().sessions.find((s) => s.id === 'target')!;
		expect(target.aiTabs.filter((t) => t.consultOrigin)).toHaveLength(1);
		const consult = target.aiTabs.find((t) => t.id === first.targetTabId)!;
		expect(consult.logs.map((l) => l.text)).toEqual(['q1', 'q2']);
	});

	it('creates a separate consult tab for a mention from a DIFFERENT source tab (fresh context)', () => {
		seedTarget();
		const a = ensureConsultTab({
			targetSessionId: 'target',
			sourceSessionId: 'scratch',
			sourceTabId: 'scratch-tab-1',
			sourceAgentName: 'Scratch',
			question: 'q-from-tab-1',
		})!;
		const b = ensureConsultTab({
			targetSessionId: 'target',
			sourceSessionId: 'scratch',
			sourceTabId: 'scratch-tab-2',
			sourceAgentName: 'Scratch',
			question: 'q-from-tab-2',
		})!;

		expect(b.targetTabId).not.toBe(a.targetTabId);
		const target = useSessionStore.getState().sessions.find((s) => s.id === 'target')!;
		expect(target.aiTabs.filter((t) => t.consultOrigin)).toHaveLength(2);
	});

	it('returns null when the target session no longer exists', () => {
		const result = ensureConsultTab({
			targetSessionId: 'ghost',
			sourceSessionId: 'scratch',
			sourceTabId: 'scratch-tab-1',
			sourceAgentName: 'Scratch',
			question: 'anyone home?',
		});
		expect(result).toBeNull();
	});
});

describe('sendCrossAgentRequest in-flight registration', () => {
	beforeEach(() => {
		useSessionStore.setState({ sessions: [] } as never);
		useCrossAgentInFlightStore.setState({ requests: {} });
	});

	it('keeps the pinned consult owner when translation holds the send', async () => {
		useSessionStore.setState({
			sessions: [
				createMockSession({
					id: 'target',
					toolType: 'claude-code',
					aiTabs: [
						createMockAITab({
							id: 'consult',
							tabProvider: 'codex',
							pendingTranslation: 'claude-code',
							consultOrigin: { sourceSessionId: 'src', sourceTabId: 'src-tab' },
						}),
					],
				}),
			],
		});
		const send = vi.fn();
		window.maestro = { crossAgent: { send } } as never;
		const onComplete = vi.fn();
		sendCrossAgentRequest({
			sourceSessionId: 'src',
			sourceTabId: 'src-tab',
			sourceAgentName: 'Source',
			sourceLogs: [],
			targetSessionId: 'target',
			userPrompt: 'q',
			onComplete,
		});
		await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
		expect(send).not.toHaveBeenCalled();
		expect(onComplete.mock.calls[0][0]).toMatchObject({
			targetTabId: 'consult',
			targetToolType: 'codex',
			error: expect.any(String),
		});
	});

	it('registers the consult tab so the responding-agent chip can deep-link to it', async () => {
		useSessionStore.setState({
			sessions: [
				createMockSession({ id: 'target', name: 'Pedsidian', toolType: 'claude-code' }),
				createMockSession({ id: 'src', name: 'Scratch' }),
			],
		} as never);

		const send = vi.fn().mockResolvedValue({ requestId: 'req-1' });
		(globalThis as unknown as { window: Record<string, unknown> }).window.maestro = {
			crossAgent: { send },
		} as never;

		sendCrossAgentRequest({
			sourceSessionId: 'src',
			sourceAgentName: 'Scratch',
			sourceTabId: 'src-tab',
			sourceLogs: [],
			targetSessionId: 'target',
			userPrompt: '@Pedsidian what is the status?',
			sourceCwd: '/tmp',
		});

		// Let the fire-and-forget .then() settle.
		await vi.waitFor(() => {
			expect(Object.keys(useCrossAgentInFlightStore.getState().requests)).toHaveLength(1);
		});

		const registered = useCrossAgentInFlightStore.getState().requests['req-1'];
		expect(registered.targetSessionId).toBe('target');
		expect(registered.targetAgentName).toBe('Pedsidian');
		// The tab the consult actually runs in - same id handed to the main process.
		expect(registered.targetTabId).toBe(send.mock.calls[0][0].targetTabId);
		expect(registered.targetTabId).toBeTruthy();
	});

	it('forwards an admitted consult chain to the main process, and only then', async () => {
		useSessionStore.setState({
			sessions: [
				createMockSession({ id: 'target', name: 'Pedsidian', toolType: 'claude-code' }),
				createMockSession({ id: 'src', name: 'Scratch' }),
			],
		} as never);

		const send = vi.fn().mockResolvedValue({ requestId: 'req-1' });
		(globalThis as unknown as { window: Record<string, unknown> }).window.maestro = {
			crossAgent: { send },
		} as never;

		const base = {
			sourceSessionId: 'src',
			sourceAgentName: 'Scratch',
			sourceTabId: 'src-tab',
			sourceLogs: [],
			targetSessionId: 'target',
			userPrompt: 'what is the status?',
		};
		// `maestro-cli ask` spent for this consult and names the target's place.
		sendCrossAgentRequest({ ...base, consultChain: { chainId: 'chain-a', depth: 2 } });
		// A typed mention carries none.
		sendCrossAgentRequest(base);
		// A mention inside a dispatched prompt names the MENTIONING turn's place,
		// for main to spend from. Never as an admitted chain.
		sendCrossAgentRequest({ ...base, sourceConsultChain: { chainId: 'chain-a', depth: 1 } });
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));

		expect(send.mock.calls[0][0].consultChain).toEqual({ chainId: 'chain-a', depth: 2 });
		expect(send.mock.calls[0][0]).not.toHaveProperty('sourceConsultChain');
		expect(send.mock.calls[1][0]).not.toHaveProperty('consultChain');
		expect(send.mock.calls[1][0]).not.toHaveProperty('sourceConsultChain');
		expect(send.mock.calls[2][0].sourceConsultChain).toEqual({ chainId: 'chain-a', depth: 1 });
		expect(send.mock.calls[2][0]).not.toHaveProperty('consultChain');
		await vi.waitFor(() => {
			expect(Object.keys(useCrossAgentInFlightStore.getState().requests)).toHaveLength(1);
		});
	});

	it('delivers onComplete when the send itself rejects', async () => {
		useSessionStore.setState({
			sessions: [
				createMockSession({ id: 'target', name: 'Pedsidian', toolType: 'claude-code' }),
				createMockSession({ id: 'src', name: 'Scratch' }),
			],
		} as never);

		const send = vi.fn().mockRejectedValue(new Error('bridge down'));
		(globalThis as unknown as { window: Record<string, unknown> }).window.maestro = {
			crossAgent: { send },
		} as never;

		const onComplete = vi.fn();
		sendCrossAgentRequest({
			sourceSessionId: 'src',
			sourceAgentName: 'Scratch',
			sourceTabId: 'src-tab',
			sourceLogs: [],
			targetSessionId: 'target',
			userPrompt: 'How does the gate work?',
			onComplete,
		});

		// A rejected send produces no chunk, so nothing else would ever settle a
		// caller blocked on the answer (`maestro-cli ask`).
		await vi.waitFor(() => {
			expect(onComplete).toHaveBeenCalledTimes(1);
		});
		expect(onComplete.mock.calls[0][0]).toMatchObject({ text: '', error: 'bridge down' });
	});
});

describe('consult answer ownership', () => {
	it.each(['open', 'closed'] as const)(
		'parks late native IDs under their captured provider on an %s consult',
		(location) => {
			const consult = createMockAITab({
				id: 'consult',
				tabProvider: 'codex',
				agentSessionId: 'codex-id',
			});
			useSessionStore.setState({
				sessions: [
					createMockSession({
						id: 'tgt',
						toolType: 'codex',
						customPath: '/codex',
						providerOverrides: { 'claude-code': { customPath: '/claude' } },
						aiTabs: location === 'open' ? [consult] : [],
						closedTabHistory:
							location === 'closed' ? [{ tab: consult, index: 0, closedAt: 1 }] : [],
					}),
				],
			});
			let receive!: (piece: CrossAgentResponseChunk) => void;
			window.maestro = {
				crossAgent: {
					onChunk: (callback: typeof receive) => {
						receive = callback;
						return () => {};
					},
				},
				history: { add: vi.fn().mockResolvedValue(true) },
			} as never;
			const synopsis = vi.fn(async () => ({ success: false }));
			const { unmount } = renderHook(() => useCrossAgentDispatch(synopsis));
			act(() =>
				receive(
					chunk({
						requestId: `late-${location}`,
						targetTabId: 'consult',
						targetToolType: 'claude-code',
						targetAgentSessionId: 'late-claude',
						chunk: 'answer',
						done: true,
					})
				)
			);
			const target = useSessionStore.getState().sessions[0];
			const saved = location === 'open' ? target.aiTabs[0] : target.closedTabHistory![0].tab;
			expect(saved.agentSessionId).toBe('codex-id');
			expect(saved.providerSessions?.['claude-code']?.agentSessionId).toBe('late-claude');
			expect(saved.pendingTranslation).toBe('claude-code');
			expect(saved.logs[0]).toMatchObject({ text: 'answer', turnProvider: 'claude-code' });
			expect(synopsis).toHaveBeenCalledWith(
				'tgt',
				expect.any(String),
				'late-claude',
				expect.any(String),
				'claude-code',
				expect.objectContaining({ customPath: '/claude' })
			);
			unmount();
		}
	);
});
