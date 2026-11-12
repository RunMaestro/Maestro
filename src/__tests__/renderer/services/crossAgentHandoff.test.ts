/**
 * Tests for src/renderer/services/crossAgentHandoff.ts
 *
 * "Feed whatever we learn over to @Kensho" names an order: this agent works,
 * then its answer goes to the mentioned agent. The hand-off is armed on the
 * source tab at dispatch and released when the turn ends.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendCrossAgentRequest = vi.fn();
vi.mock('../../../renderer/hooks/agent/useCrossAgentDispatch', () => ({
	sendCrossAgentRequest: (...args: unknown[]) => sendCrossAgentRequest(...args),
}));

import {
	armMentionHandoff,
	collectHandoffTurn,
	dropMentionHandoffs,
	releaseMentionHandoff,
} from '../../../renderer/services/crossAgentHandoff';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import type { ConsultHoldTarget, LogEntry, MentionHandoff } from '../../../renderer/types';

const SOURCE_ID = 'session-source';
const SOURCE_TAB = 'tab-source';
const KENSHO: ConsultHoldTarget = { targetSessionId: 'session-kensho', targetAgentName: 'Kensho' };
const MESSAGE = 'research MNQ and feed whatever we learn over to @Kensho';

function entry(source: LogEntry['source'], text: string, extra: Partial<LogEntry> = {}): LogEntry {
	return { id: `${source}-${text}`, timestamp: 1, source, text, ...extra };
}

function seed(logs: LogEntry[], handoff?: MentionHandoff): void {
	useSessionStore.setState({
		sessions: [
			createMockSession({
				id: SOURCE_ID,
				name: 'Last 30 Days',
				cwd: '/work/l30d',
				aiTabs: [
					createMockAITab({ id: SOURCE_TAB, logs, pendingMentionHandoff: handoff }),
					createMockAITab({ id: 'tab-2', pendingMentionHandoff: handoff }),
				],
				activeTabId: SOURCE_TAB,
			}),
		],
		groups: [],
		activeSessionId: SOURCE_ID,
	});
}

function tab(id = SOURCE_TAB) {
	return useSessionStore.getState().sessions[0].aiTabs.find((t) => t.id === id)!;
}

const EARLIER = [entry('user', 'earlier question'), entry('ai', 'earlier answer')];
const TURN = [
	entry('user', MESSAGE),
	entry('ai', 'Let me look that up.'),
	entry('stdout', 'tool output', { shellCommand: { command: 'ls' } as LogEntry['shellCommand'] }),
	entry('ai', 'MNQ findings: liquidity peaks at the open.'),
];

beforeEach(() => {
	vi.clearAllMocks();
	useSessionStore.setState({ sessions: [], groups: [], activeSessionId: '' });
});

describe('collectHandoffTurn', () => {
	it("takes the turn's LAST answer and the transcript before the turn", () => {
		// Earlier entries in the turn are narration between tool calls; the final
		// answer is what the pending note told the agent to make stand alone.
		const turn = collectHandoffTurn([...EARLIER, ...TURN]);

		expect(turn).toEqual({
			answer: 'MNQ findings: liquidity peaks at the open.',
			priorLogs: EARLIER,
		});
	});

	it('skips self-contained cards and blank entries', () => {
		const turn = collectHandoffTurn([
			entry('user', 'q'),
			entry('ai', 'the answer'),
			entry('stdout', 'card body', { shellCommand: { command: 'ls' } as LogEntry['shellCommand'] }),
			entry('ai', '   '),
		]);

		expect(turn?.answer).toBe('the answer');
	});

	it('is null when the turn produced no answer', () => {
		expect(collectHandoffTurn([...EARLIER, entry('user', 'q'), entry('error', 'boom')])).toBeNull();
	});
});

describe('releaseMentionHandoff', () => {
	const handoff: MentionHandoff = { targets: [KENSHO], message: MESSAGE };

	it("forwards the user's message and the turn's answer, then disarms", () => {
		seed([...EARLIER, ...TURN], handoff);

		releaseMentionHandoff(SOURCE_ID, SOURCE_TAB, { failed: false });

		expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
		expect(sendCrossAgentRequest).toHaveBeenCalledWith({
			sourceSessionId: SOURCE_ID,
			sourceAgentName: 'Last 30 Days',
			sourceTabId: SOURCE_TAB,
			targetSessionId: KENSHO.targetSessionId,
			userPrompt: MESSAGE,
			// The answer rides separately, so the transcript stops before the turn.
			sourceLogs: EARLIER,
			sourceCwd: '/work/l30d',
			handoffAnswer: 'MNQ findings: liquidity peaks at the open.',
		});
		expect(tab().pendingMentionHandoff).toBeUndefined();
		// Only the tab whose turn ended is released.
		expect(tab('tab-2').pendingMentionHandoff).toEqual(handoff);
	});

	it('sends nothing for a failed turn, and says so', () => {
		seed([...EARLIER, ...TURN], handoff);

		releaseMentionHandoff(SOURCE_ID, SOURCE_TAB, { failed: true });

		expect(sendCrossAgentRequest).not.toHaveBeenCalled();
		expect(tab().pendingMentionHandoff).toBeUndefined();
		const note = tab().logs[tab().logs.length - 1];
		expect(note.source).toBe('system');
		expect(note.text).toBe('Nothing was handed off to Kensho: the turn did not finish.');
	});

	it('sends nothing when the turn produced no answer, and says so', () => {
		seed([...EARLIER, entry('user', MESSAGE)], handoff);

		releaseMentionHandoff(SOURCE_ID, SOURCE_TAB, { failed: false });

		expect(sendCrossAgentRequest).not.toHaveBeenCalled();
		expect(tab().logs[tab().logs.length - 1].text).toBe(
			'Nothing was handed off to Kensho: the turn produced no answer.'
		);
	});

	it('is a no-op when nothing is armed (a second exit for the same turn)', () => {
		seed([...EARLIER, ...TURN]);
		const before = useSessionStore.getState().sessions;

		releaseMentionHandoff(SOURCE_ID, SOURCE_TAB, { failed: false });

		expect(sendCrossAgentRequest).not.toHaveBeenCalled();
		expect(useSessionStore.getState().sessions).toBe(before);
	});
});

describe('arm / drop', () => {
	it('arms a hand-off on one tab and ignores an empty target list', () => {
		seed([]);

		armMentionHandoff(SOURCE_ID, SOURCE_TAB, { targets: [], message: 'm' });
		expect(tab().pendingMentionHandoff).toBeUndefined();

		armMentionHandoff(SOURCE_ID, SOURCE_TAB, { targets: [KENSHO], message: 'm' });
		expect(tab().pendingMentionHandoff).toEqual({ targets: [KENSHO], message: 'm' });
	});

	it('Stop drops every armed hand-off on the agent', () => {
		seed([], { targets: [KENSHO], message: 'm' });

		dropMentionHandoffs(SOURCE_ID);

		expect(tab().pendingMentionHandoff).toBeUndefined();
		expect(tab('tab-2').pendingMentionHandoff).toBeUndefined();
	});
});
