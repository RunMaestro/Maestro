/**
 * P7: once a turn ends, a tab keeps the same thinking and tool cards in every mode. A local and an
 * SSH tab's own logs go through the desktop's exit cleanup (`cleanupExitedTabLogs()`); a hosted
 * tab's transcript is what its headless host wrote (`buildTurnTranscript()`, from the events it
 * streamed). Both apply `logsKeptAtTurnEnd()`, so the three modes read the same.
 */
import { describe, expect, it } from 'vitest';
import { cleanupExitedTabLogs } from '../../../../renderer/hooks/agent/internal/helpers/exitTabCleanup';
import { foldLiveTurn, type LiveTurn } from '../../../../shared/maestro-lib/client/live-turn';
import type { TurnEvent } from '../../../../shared/maestro-lib/client/types';
import { buildTurnTranscript } from '../../../../shared/maestro-lib/turns/record-turn';
import type { LogEntry } from '../../../../renderer/types';
import { logsShownMidTurn, THINKING_MODES, type ThinkingMode } from '../../../../shared/types';
import { AGENT_MODES, type AgentMode } from '../../../helpers/mockSession';

const ANSWER = 'Done.';

/** The stream of one turn: reasoning, a tool call that finishes, more reasoning, the answer. */
const EVENTS: TurnEvent[] = [
	{ kind: 'thinking', text: 'Plan ', at: 2 },
	{ kind: 'thinking', text: 'it.', at: 3 },
	{ kind: 'tool', tool: { id: 't1', name: 'Read', status: 'running' }, at: 4 },
	{ kind: 'tool', tool: { id: 't1', name: 'Read', status: 'completed' }, at: 5 },
	{ kind: 'thinking', text: 'Now answer.', at: 6 },
	{ kind: 'text', text: ANSWER, at: 7 },
] as TurnEvent[];

function streamed(): LiveTurn['entries'] {
	let id = 0;
	let live: LiveTurn | undefined;
	for (const event of EVENTS) {
		live = foldLiveTurn(live, event, { newId: () => `e${++id}` }) ?? live;
	}
	return live!.entries;
}

/** What the tab shows after the turn, as `[source, text]`, in one agent mode. */
function keptAfterTurn(mode: AgentMode, showThinking: ThinkingMode): Array<[string, string]> {
	const user = { id: 'u', timestamp: 1, source: 'user' as const, text: 'read it' };
	if (mode === 'hosted') {
		const entries = buildTurnTranscript(
			{
				agentId: 'a1',
				tabId: 'tab-1',
				assembled: { entry: { text: user.text }, settings: { provider: 'claude-code' } },
				completed: {
					outcome: 'completed',
					answerText: ANSWER,
					sessionId: undefined,
					usage: undefined,
					error: undefined,
					exit: {
						exitCode: 0,
						signal: null,
						interrupted: false,
						stderrText: '',
						stdoutText: '',
						droppedOutputBytes: 0,
					},
				},
				startedAt: 1,
				endedAt: 8,
				streamed: streamed(),
			},
			{ newId: () => 'id', now: () => 8, random: () => 0 },
			showThinking
		);
		return entries.map((entry) => [entry.source, entry.text]);
	}
	// A local or SSH tab's logs hold the same entries, its own listeners having streamed them.
	const logs = [user, ...streamed()] as unknown as LogEntry[];
	return cleanupExitedTabLogs(logs, 'tab-1', { showThinking }).map((log) => [log.source, log.text]);
}

describe('sticky Thinking after the turn (P7)', () => {
	it.each(THINKING_MODES)('a %s tab keeps the same cards in all three modes', (showThinking) => {
		const views = AGENT_MODES.map((mode) => keptAfterTurn(mode, showThinking));
		expect(views[1]).toEqual(views[0]);
		expect(views[2]).toEqual(views[0]);
		expect(views[0]).toEqual(
			showThinking === 'sticky'
				? [
						['user', 'read it'],
						['thinking', 'Plan it.'],
						['tool', 'Read'],
						['thinking', 'Now answer.'],
						['stdout', ANSWER],
					]
				: [
						['user', 'read it'],
						['stdout', ANSWER],
					]
		);
	});
});

// L30: while the turn runs, a hosted tab's live tail shows what a local tab's listeners keep under
// the tab's Thinking mode (`useAgentThinkingListener` drops a chunk when it is off; the inline clear
// point of `useBatchedSessionUpdates` drops the reasoning once answer text arrives, unless sticky).
describe('Thinking while the turn runs (L30)', () => {
	const shownAfter = (count: number, mode: ThinkingMode): Array<[string, string]> => {
		let id = 0;
		let live: LiveTurn | undefined;
		for (const event of EVENTS.slice(0, count)) {
			live = foldLiveTurn(live, event, { newId: () => `e${++id}` }) ?? live;
		}
		return logsShownMidTurn(live!.entries, mode).map((entry) => [entry.source, entry.text]);
	};

	it("'off' shows no thinking entry, and the tool card only until the answer arrives", () => {
		expect(shownAfter(5, 'off')).toEqual([['tool', 'Read']]);
		expect(shownAfter(6, 'off')).toEqual([['stdout', ANSWER]]);
	});

	it("'on' shows the reasoning until the answer arrives, then the answer alone", () => {
		expect(shownAfter(5, 'on')).toEqual([
			['thinking', 'Plan it.'],
			['tool', 'Read'],
			['thinking', 'Now answer.'],
		]);
		expect(shownAfter(6, 'on')).toEqual([['stdout', ANSWER]]);
	});

	it("'sticky' shows everything, and nothing dropped is the same array", () => {
		let id = 0;
		let live: LiveTurn | undefined;
		for (const event of EVENTS)
			live = foldLiveTurn(live, event, { newId: () => `e${++id}` }) ?? live;
		expect(logsShownMidTurn(live!.entries, 'sticky')).toBe(live!.entries);
		const answerOnly = live!.entries.filter((entry) => entry.source === 'stdout');
		expect(logsShownMidTurn(answerOnly, 'off')).toBe(answerOnly);
	});
});
