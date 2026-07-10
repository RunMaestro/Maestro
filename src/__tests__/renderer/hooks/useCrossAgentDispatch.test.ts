import { describe, it, expect, beforeEach } from 'vitest';
import {
	accumulateCrossAgentChunk,
	buildCrossAgentLogEntry,
	buildConsultTabName,
	ensureConsultTab,
} from '../../../renderer/hooks/agent/useCrossAgentDispatch';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import {
	buildUnifiedTabs,
	getNavigableTabs,
	revealAiTab,
} from '../../../renderer/utils/tabHelpers';
import { createMockSession } from '../../helpers/mockSession';
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
