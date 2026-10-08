/**
 * Tests for src/renderer/services/crossAgentConsultHold.ts
 *
 * A turn that @mentions another agent mid-message must not finish before the
 * consult replies. The local turn runs in parallel carrying a pending note, and
 * a hold item at the head of the queue waits for every reply, then turns into
 * the continuation that hands the replies to the agent verbatim.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
	CONSULT_INTERRUPTED_BY_RESTART,
	buildConsultPendingNote,
	buildConsultReplyContext,
	consultHoldReleasedText,
	formatConsultedAgentNames,
	formatConsultReplies,
	holdTurnForConsults,
	interruptConsultHolds,
	loadCrossAgentConsultPrompts,
	resolveConsultTargets,
	settleConsultHold,
	settleConsultInQueue,
	withConsultPendingNote,
} from '../../../renderer/services/crossAgentConsultHold';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import type { ConsultHoldTarget, QueuedItem, Session } from '../../../renderer/types';

const SOURCE_ID = 'session-source';
const SOURCE_TAB = 'tab-source';
const BACKEND: ConsultHoldTarget = {
	targetSessionId: 'session-backend',
	targetAgentName: 'Backend',
};
const API: ConsultHoldTarget = { targetSessionId: 'session-api', targetAgentName: 'API' };

const REPLY_TEMPLATE = 'REPLIES:\n\n{{CONSULT_REPLIES}}\n\nFinish.';

function hold(targets: ConsultHoldTarget[], overrides: Partial<QueuedItem> = {}): QueuedItem {
	return {
		id: 'hold-1',
		timestamp: 5,
		tabId: SOURCE_TAB,
		type: 'message',
		text: 'Waiting',
		awaitingConsult: { pending: [...targets], replies: [] },
		...overrides,
	};
}

function sourceSession(overrides: Partial<Session> = {}): Session {
	return createMockSession({
		id: SOURCE_ID,
		name: 'Frontend',
		aiTabs: [createMockAITab({ id: SOURCE_TAB })],
		activeTabId: SOURCE_TAB,
		executionQueue: [],
		...overrides,
	});
}

function queueOf(sessionId = SOURCE_ID): QueuedItem[] {
	return useSessionStore.getState().sessions.find((s) => s.id === sessionId)?.executionQueue ?? [];
}

function stubPrompts(content: Record<string, string>): void {
	const w = window as unknown as { maestro: Record<string, unknown> };
	w.maestro = {
		...w.maestro,
		prompts: {
			get: async (id: string) => ({ success: true, content: content[id] }),
		},
	};
}

beforeEach(() => {
	useSessionStore.setState({ sessions: [], groups: [], activeSessionId: '' });
});

describe('formatConsultedAgentNames', () => {
	it('joins names the way a sentence would', () => {
		expect(formatConsultedAgentNames(['Backend'])).toBe('Backend');
		expect(formatConsultedAgentNames(['Backend', 'API'])).toBe('Backend and API');
		expect(formatConsultedAgentNames(['A', 'B', 'C'])).toBe('A, B and C');
		expect(formatConsultedAgentNames([])).toBe('another agent');
	});
});

describe('pending note', () => {
	it('fills every consulted-agent placeholder', () => {
		expect(buildConsultPendingNote('{{CONSULTED_AGENTS}} / {{CONSULTED_AGENTS}}', ['A', 'B'])).toBe(
			'A and B / A and B'
		);
	});

	it('is appended to the prompt once the template has loaded', async () => {
		stubPrompts({
			'cross-agent-consult-pending': 'Consulting {{CONSULTED_AGENTS}}.',
			'cross-agent-consult-reply': REPLY_TEMPLATE,
		});
		await loadCrossAgentConsultPrompts(true);

		expect(withConsultPendingNote('do the thing', [BACKEND])).toBe(
			'do the thing\n\n---\n\nConsulting Backend.'
		);
	});

	it('leaves the prompt alone when nothing is being consulted', async () => {
		stubPrompts({
			'cross-agent-consult-pending': 'Consulting {{CONSULTED_AGENTS}}.',
			'cross-agent-consult-reply': REPLY_TEMPLATE,
		});
		await loadCrossAgentConsultPrompts(true);

		expect(withConsultPendingNote('do the thing', [])).toBe('do the thing');
	});
});

describe('reply formatting', () => {
	it('labels each reply with who said it, verbatim', () => {
		const body = formatConsultReplies([
			{ ...BACKEND, text: 'Use a queue.' },
			{ ...API, text: 'partial', error: 'timed out' },
		]);
		expect(body).toContain('### Reply from Backend\n\nUse a queue.');
		// A failed consult says why, and keeps whatever it managed to say.
		expect(body).toContain('### API could not respond\n\ntimed out');
		expect(body).toContain('partial');
	});

	it('wraps the replies in the reply template', () => {
		expect(buildConsultReplyContext(REPLY_TEMPLATE, [{ ...BACKEND, text: 'ok' }])).toBe(
			'REPLIES:\n\n### Reply from Backend\n\nok\n\nFinish.'
		);
	});

	it('names who answered and who could not in the visible continuation', () => {
		expect(consultHoldReleasedText([{ ...BACKEND, text: 'ok' }])).toBe(
			'Backend replied. Finish your answer with what came back.'
		);
		expect(
			consultHoldReleasedText([
				{ ...BACKEND, text: 'ok' },
				{ ...API, text: '', error: 'gone' },
			])
		).toBe('Backend replied. API could not respond. Finish your answer with what came back.');
	});
});

describe('settleConsultInQueue', () => {
	const settle = (queue: QueuedItem[], targetSessionId: string, extra = {}) =>
		settleConsultInQueue(
			queue,
			{
				sourceSessionId: SOURCE_ID,
				sourceTabId: SOURCE_TAB,
				targetSessionId,
				text: 'answer',
				...extra,
			},
			REPLY_TEMPLATE
		);

	it('keeps holding while another consult is still pending', () => {
		const next = settle([hold([BACKEND, API])], BACKEND.targetSessionId);

		expect(next[0].awaitingConsult?.pending).toEqual([API]);
		expect(next[0].awaitingConsult?.replies).toEqual([{ ...BACKEND, text: 'answer' }]);
		expect(next[0].agentContext).toBeUndefined();
	});

	it('releases into a runnable continuation once the last reply lands', () => {
		const next = settle(
			settle([hold([BACKEND, API])], BACKEND.targetSessionId),
			API.targetSessionId
		);

		expect(next[0].awaitingConsult).toBeUndefined();
		expect(next[0].text).toBe('Backend and API replied. Finish your answer with what came back.');
		expect(next[0].agentContext).toContain('### Reply from Backend\n\nanswer');
		expect(next[0].agentContext).toContain('### Reply from API\n\nanswer');
		// Keeps its place: the release does not re-stamp the item.
		expect(next[0].timestamp).toBe(5);
	});

	it('records a failed consult as a reply, so the agent can still finish', () => {
		const next = settle([hold([BACKEND])], BACKEND.targetSessionId, {
			text: '',
			error: 'not found',
		});

		expect(next[0].awaitingConsult).toBeUndefined();
		expect(next[0].agentContext).toContain('Backend could not respond');
	});

	it('removes the hold when the user stopped the consult', () => {
		const other: QueuedItem = { id: 'q2', timestamp: 6, tabId: SOURCE_TAB, type: 'message' };
		const next = settle([hold([BACKEND]), other], BACKEND.targetSessionId, { canceled: true });

		expect(next).toEqual([other]);
	});

	it('is a no-op for a consult nothing is holding for', () => {
		const queue = [hold([BACKEND])];
		// Different tab (a `maestro-cli ask`, a different conversation).
		expect(
			settleConsultInQueue(
				queue,
				{
					sourceSessionId: SOURCE_ID,
					sourceTabId: 'other-tab',
					targetSessionId: BACKEND.targetSessionId,
					text: '',
				},
				REPLY_TEMPLATE
			)
		).toBe(queue);
		// Same target settling twice.
		const released = settle(queue, BACKEND.targetSessionId);
		expect(settle(released, BACKEND.targetSessionId)).toBe(released);
	});
});

describe('interruptConsultHolds', () => {
	it('releases every pending consult as interrupted', () => {
		const queue = [hold([BACKEND, API])];
		const next = interruptConsultHolds(queue, REPLY_TEMPLATE);

		expect(next[0].awaitingConsult).toBeUndefined();
		expect(next[0].agentContext).toContain(CONSULT_INTERRUPTED_BY_RESTART);
	});

	it('returns the same queue when nothing is held', () => {
		const queue: QueuedItem[] = [{ id: 'q', timestamp: 0, tabId: SOURCE_TAB, type: 'message' }];
		expect(interruptConsultHolds(queue, REPLY_TEMPLATE)).toBe(queue);
	});
});

describe('store-bound hold', () => {
	it('resolves target names from the store, keeping unknown agents', () => {
		useSessionStore.setState({
			sessions: [sourceSession(), createMockSession({ id: 'session-backend', name: 'Backend' })],
		});

		expect(resolveConsultTargets(['session-backend', 'session-gone'])).toEqual([
			BACKEND,
			{ targetSessionId: 'session-gone', targetAgentName: 'another agent' },
		]);
	});

	it('puts the hold at the head of the queue, ahead of anything queued later', () => {
		const later: QueuedItem = { id: 'later', timestamp: 9, tabId: SOURCE_TAB, type: 'message' };
		useSessionStore.setState({ sessions: [sourceSession({ executionQueue: [later] })] });

		holdTurnForConsults(SOURCE_ID, SOURCE_TAB, [BACKEND]);

		const queue = queueOf();
		expect(queue).toHaveLength(2);
		expect(queue[0].awaitingConsult?.pending).toEqual([BACKEND]);
		expect(queue[0].tabId).toBe(SOURCE_TAB);
		expect(queue[1]).toBe(later);
	});

	it('does nothing without targets', () => {
		useSessionStore.setState({ sessions: [sourceSession()] });
		holdTurnForConsults(SOURCE_ID, SOURCE_TAB, []);
		expect(queueOf()).toEqual([]);
	});

	it('settles the hold from a terminal chunk', () => {
		useSessionStore.setState({ sessions: [sourceSession()] });
		holdTurnForConsults(SOURCE_ID, SOURCE_TAB, [BACKEND]);

		settleConsultHold({
			sourceSessionId: SOURCE_ID,
			sourceTabId: SOURCE_TAB,
			targetSessionId: BACKEND.targetSessionId,
			text: 'here you go',
		});

		const [released] = queueOf();
		expect(released.awaitingConsult).toBeUndefined();
		expect(released.agentContext).toContain('here you go');
	});
});
