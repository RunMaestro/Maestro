/**
 * Parity R34 (the rest of R8): a hosted agent's streaming reply draws the same transcript as a local
 * agent's, at the same cost. The fifth live pass measured a 4000-line reply mid-stream at 2.8 times
 * the DOM nodes and 48% more React commits on a hosted tab. This is the unit-level measure: the
 * same reply, streamed in the same chunks, through each mode's own path to the tab's logs (a local
 * tab appends to one entry; a hosted tab folds the host's live tail into its logs with
 * `mergeHostedLogs()`), rendered by the one `TerminalOutput`. The DOM node count after each chunk
 * and the commits per chunk must match (measured: 441 nodes after 20 chunks, 19 commits, in every
 * mode). How OFTEN a hosted reply is drawn is the other half: the peer mirror pushes it at the
 * cadence a local tab flushes its output (`peer-mirror-service.test.ts`, R34).
 */

import { createRef, Profiler } from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { TerminalOutput } from '../../../../renderer/components/TerminalOutput/TerminalOutput';
import type { TerminalOutputProps } from '../../../../renderer/components/TerminalOutput/types';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import type { LogEntry, Session } from '../../../../renderer/types';
import { mergeHostedLogs } from '../../../../renderer/utils/hostedSession';
import type { LogEntryRecord } from '../../../../shared/maestro-lib/store/transcript';
import { createModeSession, type AgentMode } from '../../../helpers';
import { createMockAITab } from '../../../helpers/mockTab';
import { mockTheme } from '../../../helpers/mockTheme';

const CHUNKS = 20;
const LINES_PER_CHUNK = 10;
const ASKED_AT = 1_000;

/** The reply after `n` chunks: markdown lines, as a long answer streams them. */
const replyAt = (n: number) =>
	Array.from(
		{ length: n * LINES_PER_CHUNK },
		(_, i) => `- line ${i} of the reply, with \`code\``
	).join('\n');

function sessionWith(mode: AgentMode, logs: LogEntry[]): Session {
	return createModeSession(mode, {
		id: 'row',
		state: 'busy',
		activeTabId: 't1',
		aiTabs: [createMockAITab({ id: 't1', state: 'busy', logs })],
	});
}

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

/** Each mode's own path from a chunk to the tab's logs. */
function logsAfter(mode: AgentMode, prior: LogEntry[], n: number): LogEntry[] {
	const user: LogEntry = { id: 'u1', timestamp: ASKED_AT, source: 'user', text: 'write it out' };
	if (mode !== 'hosted') {
		// A local or SSH turn appends each flush to its one reply entry.
		const reply: LogEntry = { id: 'r1', timestamp: ASKED_AT + 1, source: 'stdout', text: '' };
		const [asked, answer] = prior.length ? prior : [user, reply];
		return [asked, { ...answer, text: replyAt(n) }];
	}
	// A hosted turn's host folds the same chunks into its live tail (`foldLiveTurn()`).
	const tail: LogEntryRecord[] = [
		{ id: 'u1', timestamp: ASKED_AT, source: 'user', text: 'write it out' },
		{ id: 'r1', timestamp: ASKED_AT + 1, source: 'stdout', text: replyAt(n) },
	];
	return mergeHostedLogs(prior, [], tail);
}

function stream(mode: AgentMode): { nodes: number[]; commits: number[] } {
	let commits = 0;
	const onRender = () => {
		commits += 1;
	};
	let logs = logsAfter(mode, [], 1);
	const view = (session: Session) => (
		<LayerStackProvider>
			<Profiler id="transcript" onRender={onRender}>
				<TerminalOutput {...props(session)} />
			</Profiler>
		</LayerStackProvider>
	);
	const { container, rerender, unmount } = render(view(sessionWith(mode, logs)));
	const nodes: number[] = [container.querySelectorAll('*').length];
	const perChunk: number[] = [];
	for (let n = 2; n <= CHUNKS; n += 1) {
		logs = logsAfter(mode, logs, n);
		const before = commits;
		rerender(view(sessionWith(mode, logs)));
		perChunk.push(commits - before);
		nodes.push(container.querySelectorAll('*').length);
	}
	unmount();
	return { nodes, commits: perChunk };
}

describe('a hosted live reply costs what a local one does (R34)', () => {
	it('draws the same DOM nodes and commits per chunk as a local and an SSH tab', () => {
		const local = stream('local');
		const ssh = stream('ssh');
		const hosted = stream('hosted');
		expect(hosted.nodes).toEqual(local.nodes);
		expect(ssh.nodes).toEqual(local.nodes);
		expect(hosted.commits).toEqual(local.commits);
	});
});
