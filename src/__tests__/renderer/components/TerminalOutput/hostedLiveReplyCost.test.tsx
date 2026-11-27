/**
 * Parity R34 and L30 (the rest of R8): a hosted agent's long reply is drawn the way a local agent's
 * is, at the same cost: one row that grows, then stays. The seventh live pass found why the hosted
 * tab cost 2.8 times the DOM nodes while a 4000-line reply landed (the transcript mounted 12258
 * element nodes and removed 8141, against 4118 and 2 on a local or SSH tab):
 *
 * 1. Claude's reply streams as thinking chunks too (`partialTextRoute()`). A local tab with
 *    Thinking off drops them (`useAgentThinkingListener`); the hosted live tail drew them as a
 *    second, thinking, copy of the reply.
 * 2. At the turn's end the host's saved answer, under the host's own id, replaced the live row:
 *    a new row key, so the whole reply was mounted a third time.
 *
 * Each mode takes its own path from the host's events to the tab's logs (a local or SSH tab appends
 * to one entry and keeps it; a hosted tab folds the events with `foldLiveTurn()` and projects them
 * with `projectHostedSession()`, then reads the host's transcript at the end), rendered by the one
 * `TerminalOutput`. The nodes mounted over the whole turn, the nodes drawn after each step, and the
 * commits per chunk must match, and the reply's row must be the same element from its first chunk
 * to after the end.
 */

import { createRef, Profiler } from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { TerminalOutput } from '../../../../renderer/components/TerminalOutput/TerminalOutput';
import type { TerminalOutputProps } from '../../../../renderer/components/TerminalOutput/types';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import type { LogEntry, Session } from '../../../../renderer/types';
import {
	projectHostedSession,
	type HostedTranscript,
} from '../../../../renderer/utils/hostedSession';
import {
	foldLiveTurn,
	liveTurnKey,
	type LiveTurn,
} from '../../../../shared/maestro-lib/client/live-turn';
import type { TurnEvent } from '../../../../shared/maestro-lib/client/types';
import type { AgentRecord } from '../../../../shared/maestro-lib/store/records';
import type { LogEntryRecord } from '../../../../shared/maestro-lib/store/transcript';
import { AGENT_MODES, createModeSession, type AgentMode } from '../../../helpers';
import { createMockAITab } from '../../../helpers/mockTab';
import { mockTheme } from '../../../helpers/mockTheme';

const CHUNKS = 20;
const LINES_PER_CHUNK = 10;
const ASKED_AT = 1_000;
const KEY = liveTurnKey('h1', 't1');

/** Chunk `n` of the reply (1-based): markdown lines, as a long answer streams them. */
const chunk = (n: number) =>
	Array.from(
		{ length: LINES_PER_CHUNK },
		(_, i) => `- line ${(n - 1) * LINES_PER_CHUNK + i} of the reply, with \`code\`\n`
	).join('');
const replyAt = (n: number) => Array.from({ length: n }, (_, i) => chunk(i + 1)).join('');

const USER: LogEntryRecord = {
	id: 'u1',
	timestamp: ASKED_AT,
	source: 'user',
	text: 'write it out',
};

function props(session: Session): TerminalOutputProps {
	const noop = () => {};
	return {
		session,
		theme: mockTheme,
		fontFamily: 'monospace',
		activeFocus: 'main',
		outputSearchOpen: false,
		outputSearchQuery: '',
		outputSearchRegex: false,
		setOutputSearchOpen: noop,
		setOutputSearchQuery: noop,
		setOutputSearchRegex: noop,
		setActiveFocus: noop,
		setLightboxImage: noop,
		inputRef: createRef<HTMLTextAreaElement>(),
		logsEndRef: createRef<HTMLDivElement>(),
		maxOutputLines: 1000,
		markdownEditMode: false,
		setMarkdownEditMode: noop,
	};
}

const hostAgent = (busy: boolean): AgentRecord => ({
	id: 'h1',
	name: 'Docs',
	toolType: 'claude-code',
	activeTabId: 't1',
	aiTabs: [{ id: 't1', agentSessionId: 's1', state: busy ? 'busy' : 'idle' }],
});

/**
 * How the turn's reply reaches the tab. `streamed`: the answer streams as text (a provider whose
 * answer chunks are answer text, a Codex turn), so the reply row grows chunk by chunk. `claude`:
 * every partial is a thinking chunk only, and the answer is the provider's result, once, at the end
 * (`createTurnEventMapper()`); with Thinking off a local tab draws nothing for the partials.
 */
type Shape = 'streamed' | 'claude';

/**
 * One mode's turn, step by step: the tab's session after each chunk and at the turn's end. A hosted
 * tab has one step more between the last chunk and the end: the turn ended and the host's
 * transcript is being read again (its live rows are kept meanwhile).
 */
function turnSteps(mode: AgentMode, shape: Shape): Session[] {
	const base = (logs: LogEntry[], busy: boolean) =>
		createModeSession(mode, {
			id: 'row',
			state: busy ? 'busy' : 'idle',
			activeTabId: 't1',
			aiTabs: [createMockAITab({ id: 't1', state: busy ? 'busy' : 'idle', logs })],
		});
	const steps: Session[] = [];
	if (mode !== 'hosted') {
		// A local or SSH tab with Thinking off drops the thinking chunks and appends each flush to its
		// one reply entry, which is the saved answer once the turn ends. The provider's result marks
		// the message delivered (`markDelivered()`); when that tick lands against the hosted one is
		// `deliveredTickModeParity`'s to judge, so here it is drawn at the end in both.
		const asked: LogEntry = { ...USER, source: 'user' };
		const reply = (n: number): LogEntry => ({
			id: 'r1',
			timestamp: ASKED_AT + 1,
			source: 'stdout',
			text: replyAt(n),
		});
		for (let n = 1; n <= CHUNKS; n += 1) {
			// Claude's answer is its result, which lands with the last partial.
			const answered = shape === 'streamed' || n === CHUNKS;
			steps.push(base(answered ? [asked, reply(n)] : [asked], true));
		}
		steps.push(base([{ ...asked, delivered: true }, reply(CHUNKS)], false));
		return steps;
	}
	// A hosted tab folds what the host sends (`foldLiveTurn()`) and projects it.
	let ids = 0;
	const ctx = { newId: () => `live-${++ids}` };
	let live: LiveTurn | undefined;
	const fold = (event: TurnEvent) => (live = foldLiveTurn(live, event, ctx));
	fold({ kind: 'user', at: ASKED_AT, entry: USER });
	fold({ kind: 'started', at: ASKED_AT });
	let session = base([], true);
	const project = (busy: boolean, transcript: HostedTranscript) => {
		session = projectHostedSession(session, {
			agent: hostAgent(busy),
			transcripts: { [KEY]: transcript },
			liveTurns: live ? { [KEY]: live } : {},
		});
		steps.push(session);
	};
	for (let n = 1; n <= CHUNKS; n += 1) {
		fold({ kind: shape === 'streamed' ? 'text' : 'thinking', at: ASKED_AT + n, text: chunk(n) });
		// Claude's answer is its result, said once after the last partial (one push, as in the app).
		if (shape === 'claude' && n === CHUNKS) {
			fold({ kind: 'text', at: ASKED_AT + n, text: replyAt(CHUNKS) });
		}
		project(true, { entries: [], loaded: true });
	}
	// The turn ends: what it showed is kept until the read of the host's transcript lands.
	const shown = live?.entries ?? [];
	fold({ kind: 'outcome', at: ASKED_AT + CHUNKS + 1, outcome: 'completed', exitCode: 0 });
	project(false, { entries: [], loaded: true, carryover: shown });
	// The host saved the answer under its own id.
	project(false, {
		entries: [
			USER,
			{
				id: 'saved-answer',
				timestamp: ASKED_AT + CHUNKS + 1,
				source: 'stdout',
				text: replyAt(CHUNKS),
			},
		],
		loaded: true,
	});
	return steps;
}

function run(mode: AgentMode, shape: Shape) {
	let commits = 0;
	const onRender = () => {
		commits += 1;
	};
	const steps = turnSteps(mode, shape);
	const view = (session: Session) => (
		<LayerStackProvider>
			<Profiler id="transcript" onRender={onRender}>
				<TerminalOutput {...props(session)} />
			</Profiler>
		</LayerStackProvider>
	);
	const { container, rerender, unmount } = render(view(steps[0]));
	let mounted = 0;
	// Read after each step: an observer's callback runs only once this test yields.
	const observer = new MutationObserver(() => undefined);
	observer.observe(container, { childList: true, subtree: true });
	const countMounted = () => {
		for (const record of observer.takeRecords()) {
			for (const node of record.addedNodes) {
				if (node instanceof Element) mounted += 1 + node.querySelectorAll('*').length;
			}
		}
	};
	const replyRow = () => container.querySelector('[data-log-index="1"]');
	let firstRow = replyRow();
	let rowRemounted = false;
	const nodes: number[] = [container.querySelectorAll('*').length];
	const perChunk: number[] = [];
	for (const [i, session] of steps.slice(1).entries()) {
		const before = commits;
		rerender(view(session));
		countMounted();
		if (i < CHUNKS - 1) perChunk.push(commits - before);
		nodes.push(container.querySelectorAll('*').length);
		const row = replyRow();
		if (firstRow && row !== firstRow) rowRemounted = true;
		firstRow ??= row;
	}
	observer.disconnect();
	const rows = container.querySelectorAll('[data-log-index]').length;
	unmount();
	return { nodes, commits: perChunk, mounted, rowRemounted, rows };
}

describe('a hosted long reply costs what a local one does (R34, L30)', () => {
	it.each<Shape>(['streamed', 'claude'])(
		'draws one reply row, mounted once, with the same nodes, mounts, and commits as a local and an SSH tab (%s)',
		(shape) => {
			const [local, ssh, hosted] = AGENT_MODES.map((mode) => run(mode, shape));
			// The hosted step a local tab has no counterpart of: the turn ended, the read is out. It
			// draws what the last chunk drew (the tick waits for the saved answer, as it does locally).
			const reading = hosted.nodes.splice(CHUNKS, 1)[0];
			expect(reading).toBe(hosted.nodes[CHUNKS - 1]);
			for (const other of [ssh, hosted]) {
				expect(other.nodes).toEqual(local.nodes);
				expect(other.mounted).toBe(local.mounted);
				expect(other.commits).toEqual(local.commits);
			}
			// One row for the question, one for the reply, in every mode.
			expect(hosted.rows).toBe(2);
			// The reply's row is never mounted again: not by a thinking copy, not by the saved answer.
			expect(local.rowRemounted).toBe(false);
			expect(hosted.rowRemounted).toBe(false);
		}
	);
});
